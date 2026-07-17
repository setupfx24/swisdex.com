"""Admin Notification Center.

Single endpoint that aggregates the actionable items currently sitting
in the admin's queue — pending deposits / withdrawals / KYC submissions,
open support tickets, pending dual-approval requests, and the count of
new sign-ups in the last 24h. The admin top bar polls this every ~30s
and surfaces a bell + badge so admins can see at a glance what needs
attention without paging through every section of the dashboard.

Each item carries the deep-link the bell dropdown should navigate to,
so adding a new category is a one-line server change — no frontend
update needed unless the link target itself is new.
"""
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.database import get_db
from packages.common.src.models import (
    Deposit, SupportTicket, User, Withdrawal,
)
from dependencies import get_current_admin, resolve_employee_permissions

router = APIRouter(prefix="/notifications", tags=["Admin Notifications"])


@router.get("/summary")
async def notifications_summary(
    admin=Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Counts of actionable admin queue items.

    Returns:
        total: int — sum of all counts (used for the header bell badge)
        items: list[{ kind, count, label, link, severity }]
            severity: 'critical' for items the platform shouldn't sit on
                      (withdrawals, approvals); 'normal' for routine queue.
    """
    pending_deposits_q = await db.execute(
        select(func.count(Deposit.id)).where(Deposit.status == "pending")
    )
    pending_deposits = int(pending_deposits_q.scalar() or 0)

    pending_withdrawals_q = await db.execute(
        select(func.count(Withdrawal.id)).where(Withdrawal.status == "pending")
    )
    pending_withdrawals = int(pending_withdrawals_q.scalar() or 0)

    # KYC submissions waiting for review. State machine: pending → submitted
    # (user uploaded docs) → approved / rejected. We surface 'submitted'.
    pending_kyc_q = await db.execute(
        select(func.count(User.id)).where(User.kyc_status == "submitted")
    )
    pending_kyc = int(pending_kyc_q.scalar() or 0)

    open_tickets_q = await db.execute(
        select(func.count(SupportTicket.id)).where(
            SupportTicket.status.in_(("open", "pending"))
        )
    )
    open_tickets = int(open_tickets_q.scalar() or 0)

    # Dual-approval queue. The other admin (not the requester) sees these.
    # Filtering out approvals the *current* admin requested themselves
    # because the rules already block self-approval; surfacing them in the
    # bell would just be noise.
    # Must match the Approvals page filter exactly (approvals.py list_pending):
    # status='pending' AND not expired. Without the expires_at guard the bell
    # counted stale EXPIRED approvals the page hides — "4 in bell, 0 on page".
    approval_q = await db.execute(
        text(
            """
            SELECT COUNT(*) FROM admin_approval_requests
            WHERE status = 'pending' AND expires_at > NOW()
              AND requested_by <> :me
            """
        ),
        {"me": str(admin.id)},
    )
    pending_approvals = int(approval_q.scalar() or 0)

    # New users in the last 24 hours — informational, not action-required,
    # but useful for admins to spot abnormal sign-up spikes.
    since_24h = datetime.now(timezone.utc) - timedelta(hours=24)
    new_users_q = await db.execute(
        select(func.count(User.id)).where(User.created_at >= since_24h)
    )
    new_users_24h = int(new_users_q.scalar() or 0)

    # RM funding requests awaiting an admin (pending proof, or approved but
    # not yet credited). Surfaced so admins get notified when an RM uploads.
    # Run last + in its own savepoint so a pre-migration missing table can't
    # poison the surrounding session.
    rm_pending = 0
    try:
        async with db.begin_nested():
            rm_pending_q = await db.execute(
                text("SELECT COUNT(*) FROM rm_funding_requests WHERE status IN ('pending','approved')")
            )
            rm_pending = int(rm_pending_q.scalar() or 0)
    except Exception:
        rm_pending = 0

    # Fixed-Return activity (client 2026-06-17): admins want a bell ping when a
    # user requests an early withdrawal (actionable queue) and when a new
    # deposit/lock comes in (informational). Own savepoint so a missing table
    # can't poison the session.
    fr_withdrawals = 0
    fr_principal = 0
    fr_new_locks = 0
    try:
        async with db.begin_nested():
            fr_w_q = await db.execute(
                text("SELECT COUNT(*) FROM fixed_return_locks WHERE state = 'early_pending'")
            )
            fr_withdrawals = int(fr_w_q.scalar() or 0)
            # Matured principal-withdrawal claims awaiting approval (2026-07-11).
            fr_p_q = await db.execute(
                text("SELECT COUNT(*) FROM fixed_return_locks WHERE state = 'principal_pending'")
            )
            fr_principal = int(fr_p_q.scalar() or 0)
            fr_n_q = await db.execute(
                text("SELECT COUNT(*) FROM fixed_return_locks WHERE locked_at >= :since"),
                {"since": since_24h},
            )
            fr_new_locks = int(fr_n_q.scalar() or 0)
    except Exception:
        fr_principal = 0
        fr_withdrawals = 0
        fr_new_locks = 0

    # Trader-submitted "Request to RM" forms (mail-to-RM). Persisted in
    # rm_manual_requests; admins want a bell ping for each new one so they
    # don't rely on email alone. Split deposit vs withdraw so the admin knows
    # the type at a glance. Count only status='new' (unhandled). Own savepoint
    # so a pre-migration missing table can't poison the session.
    rm_manual_deposit = 0
    rm_manual_withdraw = 0
    try:
        async with db.begin_nested():
            rm_manual_rows = await db.execute(
                text(
                    "SELECT side, COUNT(*) FROM rm_manual_requests "
                    "WHERE status = 'new' GROUP BY side"
                )
            )
            for side_val, cnt in rm_manual_rows.all():
                if (side_val or "").lower() == "withdraw":
                    rm_manual_withdraw = int(cnt or 0)
                else:
                    rm_manual_deposit = int(cnt or 0)
    except Exception:
        rm_manual_deposit = 0
        rm_manual_withdraw = 0

    # Tasks assigned to THIS admin/employee that are still pending — their
    # personal work queue (client 2026-07-10: employees weren't pinged when a
    # manager assigned them a task). perm=None → shown to every role; the
    # count is scoped to the signed-in user so nobody sees anyone else's.
    my_tasks = 0
    try:
        async with db.begin_nested():
            my_tasks_q = await db.execute(
                text(
                    "SELECT COUNT(*) FROM employee_tasks "
                    "WHERE assigned_to = :me AND status = 'pending'"
                ),
                {"me": str(admin.id)},
            )
            my_tasks = int(my_tasks_q.scalar() or 0)
    except Exception:
        my_tasks = 0

    # `link` values are admin-frontend route paths. Withdrawals share the
    # /deposits page (tab=withdrawals); approvals get their own page; the
    # rest map 1:1 to existing routes.
    items = [
        {"kind": "my_tasks", "count": my_tasks, "perm": None,
         "label": "Tasks assigned to you", "link": "/tasks", "severity": "critical"},
        {"kind": "withdrawals", "count": pending_withdrawals, "perm": "withdrawals.view",
         "label": "Pending withdrawals", "link": "/deposits?tab=withdrawals", "severity": "critical"},
        {"kind": "approvals",   "count": pending_approvals, "perm": "funds.approve",
         "label": "Approval requests", "link": "/approvals", "severity": "critical"},
        {"kind": "rm_funding",  "count": rm_pending, "perm": "rm.manage",
         "label": "RM funding requests", "link": "/rm-requests", "severity": "critical"},
        {"kind": "rm_manual_deposit",  "count": rm_manual_deposit, "perm": "rm.manage",
         "label": "New RM deposit requests", "link": "/rm-manual-requests", "severity": "critical"},
        {"kind": "rm_manual_withdraw", "count": rm_manual_withdraw, "perm": "rm.manage",
         "label": "New RM withdrawal requests", "link": "/rm-manual-requests", "severity": "critical"},
        {"kind": "fixed_return_withdrawals", "count": fr_withdrawals, "perm": "fixed_return.view",
         "label": "Fixed-Return withdrawal requests", "link": "/config/fixed-return", "severity": "critical"},
        {"kind": "fixed_return_principal", "count": fr_principal, "perm": "fixed_return.view",
         "label": "AI Staking principal-withdrawal requests", "link": "/config/fixed-return", "severity": "critical"},
        {"kind": "deposits",    "count": pending_deposits, "perm": "deposits.view",
         "label": "Pending deposits", "link": "/deposits", "severity": "normal"},
        {"kind": "fixed_return_new", "count": fr_new_locks, "perm": "fixed_return.view",
         "label": "New Fixed-Return deposits (24h)", "link": "/config/fixed-return", "severity": "normal"},
        {"kind": "kyc",         "count": pending_kyc, "perm": "kyc.view",
         "label": "KYC submissions", "link": "/kyc", "severity": "normal"},
        {"kind": "tickets",     "count": open_tickets, "perm": "tickets.view",
         "label": "Open support tickets", "link": "/support", "severity": "normal"},
        {"kind": "new_users",   "count": new_users_24h, "perm": "users.view",
         "label": "New users (24h)", "link": "/users", "severity": "info"},
    ]

    # Scope the bell to what THIS admin can actually act on. An employee
    # should only be pinged about their own area — a withdrawal_manager sees
    # withdrawals, a support agent sees tickets, etc. — not every queue in the
    # platform. super_admin ("*") keeps the full board.
    perms = await resolve_employee_permissions(admin, db)
    if "*" not in perms:
        # perm=None marks personal items (e.g. my_tasks) every role keeps.
        items = [i for i in items if i["perm"] is None or i["perm"] in perms]

    # Strip the internal `perm` key from the response (frontend doesn't need it).
    for i in items:
        i.pop("perm", None)

    # The badge counts only critical + normal; "info" items (new sign-ups)
    # don't pulse the bell — they're context, not a queue.
    total = sum(i["count"] for i in items if i["severity"] in ("critical", "normal"))
    return {"total": total, "items": items}
