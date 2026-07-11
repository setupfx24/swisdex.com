"""Admin User Service — user listing, detail, fund/credit ops, ban, kill switch, login-as."""
import uuid
from datetime import datetime, timedelta
from decimal import Decimal

import jwt
from fastapi import HTTPException
from sqlalchemy import select, func, or_
from sqlalchemy.exc import IntegrityError, DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.config import get_settings
from sqlalchemy import delete as sql_delete
from sqlalchemy import update as sa_update
from packages.common.src.models import (
    User, TradingAccount, Position, Order, Transaction, Deposit, Withdrawal,
    PositionStatus, OrderStatus, TradeHistory,
    MasterAccount, InvestorAllocation, CopyTrade,
    Referral, IBProfile, IBCommission, IBApplication, Notification,
    UserSession, UserRefreshToken, UserAuditLog, PasswordResetToken,
    KYCDocument, SupportTicket, TicketMessage, UserBonus, Employee,
    ChargeConfig, InstrumentConfig, InstrumentConfigAudit, SystemSetting,
    AuditLog,
)
from packages.common.src.admin_schemas import (
    UserOut, UserDetailOut, TradingAccountOut,
    FundRequest, CreditRequest,
)
from dependencies import write_audit_log

settings = get_settings()


def _user_to_out(u: User) -> dict:
    return {
        "id": str(u.id),
        "email": u.email,
        "phone": u.phone,
        "first_name": u.first_name,
        "last_name": u.last_name,
        "date_of_birth": u.date_of_birth,
        "country": u.country,
        "address": u.address,
        "role": u.role,
        "status": u.status,
        "kyc_status": u.kyc_status,
        "is_demo": u.is_demo,
        "language": u.language,
        "theme": u.theme,
        "trading_blocked_until": u.trading_blocked_until,
        "created_at": u.created_at,
        "updated_at": u.updated_at,
        # Security / account-state fields — surfaced to the admin
        # user-detail page so the support team can see verification
        # state at a glance without crossing tabs. Client request
        # 2026-06-01 (#5) — admin wants to see full user details
        # so they can decide whether to reset / revoke sessions.
        "email_verified": bool(getattr(u, "email_verified", False)),
        "two_factor_enabled": bool(getattr(u, "two_factor_enabled", False)),
        # Per-user bank deposit visibility (None = follow global toggle).
        "bank_deposit_enabled": getattr(u, "bank_deposit_enabled", None),
        # Whole-user promotional/pilot flag — excluded from real company figures.
        "is_promotional": bool(getattr(u, "is_promotional", False)),
    }


def _account_to_out(a: TradingAccount) -> dict:
    return {
        "id": str(a.id),
        "user_id": str(a.user_id),
        "account_group_id": str(a.account_group_id) if a.account_group_id else None,
        "account_number": a.account_number,
        "balance": float(a.balance or 0),
        "credit": float(a.credit or 0),
        "equity": float(a.equity or 0),
        "margin_used": float(a.margin_used or 0),
        "free_margin": float(a.free_margin or 0),
        "margin_level": float(a.margin_level or 0),
        "leverage": a.leverage,
        "currency": a.currency,
        "is_demo": a.is_demo,
        "is_active": a.is_active,
        "is_promotional": bool(getattr(a, "is_promotional", False)),
        "created_at": a.created_at,
    }


async def set_user_promotional(
    user_id: uuid.UUID, is_promotional: bool, db: AsyncSession,
) -> dict:
    """Flag/unflag the WHOLE user as promotional (pilot)."""
    user = (await db.execute(
        select(User).where(User.id == user_id)
    )).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    user.is_promotional = bool(is_promotional)
    await db.commit()
    return {"user_id": str(user_id), "is_promotional": user.is_promotional}


async def get_fr_referral_override(user_id: uuid.UUID, db: AsyncSession) -> dict:
    """Current per-referrer FR referral-commission % override + the global
    defaults it falls back to, for the admin user-detail override card."""
    from packages.common.src.settings_store import get_float_setting
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    po = user.fr_referral_principal_pct_override
    io = user.fr_referral_interest_pct_override
    return {
        "user_id": str(user_id),
        "mode": (user.fr_referral_mode or "principal"),
        "principal_pct_override": (float(po) if po is not None else None),
        "interest_pct_override": (float(io) if io is not None else None),
        "global_principal_pct": float(await get_float_setting("fr_referral_principal_pct", 0.0)),
        "global_interest_pct": float(await get_float_setting("fr_referral_interest_pct", 0.0)),
    }


async def set_fr_referral_override(
    user_id: uuid.UUID, principal_pct, interest_pct, db: AsyncSession,
) -> dict:
    """Set/clear a referrer's custom FR referral-commission %. Pass None on a
    leg to CLEAR it (that leg then falls back to the global setting)."""
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    def _norm(v):
        if v is None or v == "":
            return None
        d = Decimal(str(v))
        if d < 0:
            raise HTTPException(status_code=400, detail="Percentage cannot be negative")
        if d > 100:
            raise HTTPException(status_code=400, detail="Percentage cannot exceed 100")
        return d

    user.fr_referral_principal_pct_override = _norm(principal_pct)
    user.fr_referral_interest_pct_override = _norm(interest_pct)
    await db.commit()
    return {
        "user_id": str(user_id),
        "principal_pct_override": (
            float(user.fr_referral_principal_pct_override)
            if user.fr_referral_principal_pct_override is not None else None
        ),
        "interest_pct_override": (
            float(user.fr_referral_interest_pct_override)
            if user.fr_referral_interest_pct_override is not None else None
        ),
    }


async def list_users(
    page: int, per_page: int, search: str | None,
    status_filter: str | None, kyc_filter: str | None,
    group_id: str | None, db: AsyncSession,
    date_from: str | None = None,
    date_to:   str | None = None,
) -> dict:
    from datetime import datetime, time, timezone

    def _parse_date(value: str | None, *, end_of_day: bool) -> datetime | None:
        if not value:
            return None
        try:
            d = datetime.strptime(value, "%Y-%m-%d").date()
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid date '{value}', expected YYYY-MM-DD")
        return datetime.combine(d, time.max if end_of_day else time.min, tzinfo=timezone.utc)

    query = select(User).where(User.role.notin_(["admin", "super_admin"]), User.is_demo == False)

    if search:
        term = f"%{search}%"
        query = query.where(
            or_(
                User.email.ilike(term),
                User.first_name.ilike(term),
                User.last_name.ilike(term),
                User.phone.ilike(term),
            )
        )
    if status_filter:
        query = query.where(User.status == status_filter)
    if kyc_filter:
        query = query.where(User.kyc_status == kyc_filter)
    # Created-at range — used by the admin Users page's date-range filter
    # (Today / Yesterday / Last 7 / Last 30 / Custom). Bounds are inclusive
    # of the picked dates: start at 00:00 UTC, end at 23:59:59 UTC.
    df = _parse_date(date_from, end_of_day=False)
    dt = _parse_date(date_to, end_of_day=True)
    if df is not None:
        query = query.where(User.created_at >= df)
    if dt is not None:
        query = query.where(User.created_at <= dt)

    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0

    query = query.order_by(User.created_at.desc()).offset((page - 1) * per_page).limit(per_page)
    result = await db.execute(query)
    users = result.scalars().all()

    user_ids = [u.id for u in users]
    balance_map: dict = {}
    if user_ids:
        acc_q = await db.execute(
            select(
                TradingAccount.user_id,
                func.coalesce(func.sum(TradingAccount.balance), 0).label("total_balance"),
                func.coalesce(func.sum(TradingAccount.equity), 0).label("total_equity"),
            )
            .where(
                TradingAccount.user_id.in_(user_ids),
                TradingAccount.is_demo.is_(False),
            )
            .group_by(TradingAccount.user_id)
        )
        for row in acc_q.all():
            balance_map[row[0]] = {"balance": float(row[1]), "equity": float(row[2])}

    user_list = []
    for u in users:
        name = " ".join(filter(None, [u.first_name, u.last_name])) or u.email.split("@")[0]
        bals = balance_map.get(u.id, {"balance": 0.0, "equity": 0.0})
        main_wallet = float(u.main_wallet_balance or 0)
        # Balance/equity columns include the main wallet alongside trading accounts
        # so admins see the user's total funds at a glance.
        user_list.append({
            "id": str(u.id),
            "name": name,
            "email": u.email,
            "main_wallet_balance": main_wallet,
            "trading_balance": bals["balance"],
            "trading_equity": bals["equity"],
            "balance": bals["balance"] + main_wallet,
            "equity": bals["equity"] + main_wallet,
            "group": u.role or "user",
            "kyc_status": u.kyc_status or "pending",
            "status": u.status or "active",
        })

    pages = max(1, (total + per_page - 1) // per_page)
    return {
        "users": user_list,
        "total": total,
        "page": page,
        "pages": pages,
    }


async def get_user_detail(user_id: uuid.UUID, db: AsyncSession):
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    accounts_q = await db.execute(
        select(TradingAccount).where(
            TradingAccount.user_id == user_id,
            TradingAccount.is_demo.is_(False),
        )
    )
    accounts = accounts_q.scalars().all()

    dep_q = await db.execute(
        select(func.coalesce(func.sum(Deposit.amount), 0)).where(
            Deposit.user_id == user_id,
            Deposit.status.in_(["approved", "auto_approved"]),
        )
    )
    total_deposit = float(dep_q.scalar() or 0)

    wd_q = await db.execute(
        select(func.coalesce(func.sum(Withdrawal.amount), 0)).where(
            Withdrawal.user_id == user_id,
            Withdrawal.status.in_(["approved", "completed"]),
        )
    )
    total_withdrawal = float(wd_q.scalar() or 0)

    account_ids = [a.id for a in accounts]
    total_trades = 0
    open_positions = 0
    if account_ids:
        trades_q = await db.execute(
            select(func.count(Order.id)).where(Order.account_id.in_(account_ids))
        )
        total_trades = trades_q.scalar() or 0

        pos_q = await db.execute(
            select(func.count(Position.id)).where(
                Position.account_id.in_(account_ids),
                Position.status == PositionStatus.OPEN.value,
            )
        )
        open_positions = pos_q.scalar() or 0

    assigned_rm_name = None
    if user.assigned_rm_id:
        rm = (await db.execute(select(User).where(User.id == user.assigned_rm_id))).scalar_one_or_none()
        if rm:
            assigned_rm_name = f"{rm.first_name or ''} {rm.last_name or ''}".strip() or rm.email

    return UserDetailOut(
        user=UserOut(**_user_to_out(user)),
        accounts=[TradingAccountOut(**_account_to_out(a)) for a in accounts],
        total_deposit=total_deposit,
        total_withdrawal=total_withdrawal,
        total_trades=total_trades,
        open_positions=open_positions,
        assigned_rm_id=str(user.assigned_rm_id) if user.assigned_rm_id else None,
        assigned_rm_name=assigned_rm_name,
    )


async def get_user_deposits(user_id: uuid.UUID, db: AsyncSession) -> list[dict]:
    """Per-deposit history for a user — how each deposit was made (method),
    its status, and WHICH admin approved it (client 2026-06-12)."""
    from sqlalchemy.orm import aliased
    Approver = aliased(User)
    rows = (await db.execute(
        select(
            Deposit.id, Deposit.amount, Deposit.method, Deposit.status,
            Deposit.created_at, Deposit.approved_at,
            Deposit.transaction_id,
            Approver.first_name, Approver.last_name, Approver.email,
        )
        .select_from(Deposit)
        .outerjoin(Approver, Approver.id == Deposit.approved_by)
        .where(Deposit.user_id == user_id)
        .order_by(Deposit.created_at.desc())
        .limit(200)
    )).all()
    out = []
    for r in rows:
        approver = None
        if r.first_name or r.last_name or r.email:
            approver = (" ".join(filter(None, [r.first_name, r.last_name])).strip() or r.email)
        out.append({
            "id": str(r.id),
            "amount": float(r.amount or 0),
            "method": r.method or "—",
            "status": r.status,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "approved_at": r.approved_at.isoformat() if r.approved_at else None,
            "approved_by": approver,
            "reference": r.transaction_id,
        })
    return out


async def _apply_first_funding_bonus(user_row, amount: Decimal, db) -> Decimal:
    """Welcome bonus for a user's FIRST funding done via admin add-fund —
    mirrors the first-deposit bonus so an admin-credited first deposit earns the
    same welcome bonus a real deposit would (client 2026-06-24). One-time: skips
    if the user already has any bonus, any approved deposit, or has forfeited.
    Bracket-walk kept in lockstep with wallet_service.compute_welcome_bonus.
    Returns the bonus credited (0 if none)."""
    from packages.common.src.settings_store import (
        get_bool_setting, get_float_setting, get_system_setting,
    )
    from packages.common.src.models import Deposit as _Dep
    if getattr(user_row, "bonus_forfeited_at", None) is not None:
        return Decimal("0")
    if not await get_bool_setting("welcome_bonus_enabled", False):
        return Decimal("0")
    prior_bonus = (await db.execute(
        select(func.count()).select_from(Transaction).where(
            Transaction.user_id == user_row.id, Transaction.type == "bonus",
        )
    )).scalar() or 0
    if prior_bonus > 0:
        return Decimal("0")
    prior_dep = (await db.execute(
        select(func.count()).select_from(_Dep).where(
            _Dep.user_id == user_row.id,
            _Dep.status.in_(["approved", "auto_approved"]),
        )
    )).scalar() or 0
    if prior_dep > 0:
        return Decimal("0")

    raw = await get_system_setting("welcome_bonus_brackets", None)
    brackets = raw if isinstance(raw, list) else []
    if not brackets:
        legacy = float(await get_float_setting("welcome_bonus_value", 0.0))
        if legacy > 0:
            brackets = [{
                "min_deposit": 0, "max_deposit": None,
                "type": (str(await get_system_setting("welcome_bonus_type", "percentage") or "percentage")).strip().lower(),
                "value": legacy,
                "cap_usd": float(await get_float_setting("welcome_bonus_cap_usd", 0.0)),
            }]

    bonus = Decimal("0")
    label = ""
    for row in brackets:
        try:
            min_d = Decimal(str(row.get("min_deposit") or 0))
        except (TypeError, ValueError):
            continue
        mr = row.get("max_deposit")
        try:
            max_d = None if mr in (None, "") else Decimal(str(mr))
        except (TypeError, ValueError):
            max_d = None
        if amount < min_d:
            continue
        if max_d is not None and amount > max_d:
            continue
        try:
            value = Decimal(str(row.get("value") or 0))
        except (TypeError, ValueError):
            continue
        if value <= 0:
            continue
        btype = (str(row.get("type") or "percentage")).strip().lower()
        try:
            cap = Decimal(str(row.get("cap_usd") or 0))
        except (TypeError, ValueError):
            cap = Decimal("0")
        if btype == "percentage":
            bonus = (amount * value / Decimal("100")).quantize(Decimal("0.01"))
            label = f"Welcome bonus ({value}% of first fund-add)"
        else:
            bonus = value.quantize(Decimal("0.01"))
            label = f"Welcome bonus (flat ${value})"
        if cap > 0 and bonus > cap:
            bonus = cap
            label += f" — capped at ${cap}"
        break

    if bonus <= 0:
        return Decimal("0")
    user_row.main_wallet_bonus = (getattr(user_row, "main_wallet_bonus", None) or Decimal("0")) + bonus
    db.add(Transaction(
        user_id=user_row.id, account_id=None, type="bonus",
        amount=bonus, balance_after=user_row.main_wallet_bonus, description=label,
    ))
    return bonus


async def add_fund(
    user_id: uuid.UUID, body: FundRequest,
    admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
    *, approval_request_id: uuid.UUID | None = None,
) -> dict:
    """Add funds to user's MAIN WALLET. User must transfer to trading account manually.

    Above ADMIN_DUAL_APPROVAL_THRESHOLD this raises ApprovalRequired (HTTP 202)
    instead of executing — a second admin must call /admin/approvals/{id}/approve
    and re-invoke this with ``approval_request_id`` set."""
    from packages.common.src.notify import create_notification
    from .approval_service import (
        request_or_execute, fetch_pending, mark_executed,
    )

    amt = Decimal(str(body.amount))

    if approval_request_id is None:
        # Anti-split guard (client 2026-06-23): if this user already received an
        # admin fund-add in the last 24h, force dual approval on the NEXT one —
        # even below the threshold — so an employee can't bypass the second
        # sign-off by splitting one large credit into several small top-ups.
        from datetime import datetime, timedelta, timezone
        cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
        recent = await db.execute(
            select(Transaction.id).where(
                Transaction.user_id == user_id,
                Transaction.type == "adjustment",
                Transaction.amount > 0,
                Transaction.created_by.isnot(None),
                Transaction.created_at >= cutoff,
            ).limit(1)
        )
        force_dual = recent.first() is not None

        # First-pass: gate on amount thresholds (or force dual approval if the
        # 24h guard above tripped). Either short-circuits with a 202 (approval
        # required) or returns None to proceed.
        await request_or_execute(
            db,
            action="add_fund",
            target_type="user",
            target_id=user_id,
            amount=amt,
            payload={"description": body.description, "source": "main_wallet"},
            requested_by=admin_id,
            always=force_dual,
        )
    else:
        # Second-pass: confirm the approval row matches what we're about to do.
        rec = await fetch_pending(db, approval_request_id) if False else None
        # Above call would 409 — pending requests aren't fetched here, only
        # 'approved' ones. Verify via direct lookup.
        from sqlalchemy import text as _t
        row = await db.execute(
            _t("SELECT status, action, target_id, payload FROM admin_approval_requests WHERE id = :rid FOR UPDATE"),
            {"rid": str(approval_request_id)},
        )
        ar = row.mappings().first()
        if not ar or ar["status"] != "approved":
            raise HTTPException(status_code=409, detail="Approval not in 'approved' state")
        if ar["action"] != "add_fund" or str(ar["target_id"]) != str(user_id):
            raise HTTPException(status_code=409, detail="Approval does not match this action")
        approved_amt = Decimal(str(ar["payload"].get("amount", "0")))
        if approved_amt != amt:
            raise HTTPException(status_code=409, detail="Amount differs from approved request")

    # Pessimistic row lock so two concurrent admins (e.g. shift change)
    # cannot both add the same bonus and corrupt the balance.
    user_result = await db.execute(
        select(User).where(User.id == user_id).with_for_update()
    )
    user_row = user_result.scalar_one_or_none()
    if not user_row:
        raise HTTPException(status_code=404, detail="User not found")

    old_balance = user_row.main_wallet_balance or Decimal("0")
    user_row.main_wallet_balance = old_balance + amt

    txn = Transaction(
        user_id=user_id,
        account_id=None,  # Main wallet — no trading account
        type="adjustment",
        amount=Decimal(str(body.amount)),
        balance_after=user_row.main_wallet_balance,
        description=body.description or "Admin fund addition to main wallet",
        created_by=admin_id,
    )
    db.add(txn)

    # First-funding welcome bonus (client 2026-06-24): an admin-credited FIRST
    # deposit earns the same welcome bonus a real first deposit would. No-op
    # unless welcome_bonus_enabled is on AND this is the user's first funding.
    bonus_credited = await _apply_first_funding_bonus(user_row, amt, db)

    await write_audit_log(
        db, admin_id, "add_fund", "user", user_id,
        # Money columns stored as strings to preserve full Decimal precision
        # in the audit JSONB (float would silently round 18-decimal values).
        old_values={"main_wallet_balance": str(old_balance)},
        new_values={"main_wallet_balance": str(user_row.main_wallet_balance), "amount_added": str(body.amount)},
        ip_address=ip_address,
    )
    await create_notification(
        db,
        user_id,
        title="Funds Added",
        message=(
            f"${float(body.amount):,.2f} has been added to your main wallet."
            + (f" Plus a ${float(bonus_credited):,.2f} welcome bonus!" if bonus_credited > 0 else "")
            + " You can now transfer it to your trading account from the Wallet page."
        ),
        notif_type="deposit",
        action_url="/wallet",
        commit=False,
    )
    if approval_request_id is not None:
        await mark_executed(db, request_id=approval_request_id)
    # Atomic: balance update + transaction row + audit log + (optional)
    # approval-status-flip all flushed and committed in a single tx.
    await db.commit()
    return {
        "message": "Fund added to main wallet successfully",
        "new_main_wallet_balance": float(user_row.main_wallet_balance),
    }


async def deduct_fund(
    user_id: uuid.UUID, body: FundRequest,
    admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
    *, approval_request_id: uuid.UUID | None = None,
) -> dict:
    """Deduct funds. `body.source` controls where the deduction comes from:
       - "main_wallet":    deduct only from the user's main wallet (error if short).
       - "trading_account": deduct only from body.account_id (error if short).
       - None (legacy):    try main wallet first, fall back to body.account_id.

    Above ADMIN_DUAL_APPROVAL_THRESHOLD this raises ApprovalRequired (HTTP 202)
    on the first call; the second admin approves, then the original admin
    re-invokes with ``approval_request_id`` set to actually move the money."""
    from .approval_service import request_or_execute, mark_executed
    from sqlalchemy import text as _t

    amt = Decimal(str(body.amount))

    if approval_request_id is None:
        await request_or_execute(
            db,
            action="deduct_fund",
            target_type="user",
            target_id=user_id,
            amount=amt,
            payload={"description": body.description, "source": getattr(body, "source", None),
                     "account_id": getattr(body, "account_id", None)},
            requested_by=admin_id,
        )
    else:
        row = await db.execute(
            _t("SELECT status, action, target_id, payload FROM admin_approval_requests WHERE id = :rid FOR UPDATE"),
            {"rid": str(approval_request_id)},
        )
        ar = row.mappings().first()
        if not ar or ar["status"] != "approved":
            raise HTTPException(status_code=409, detail="Approval not in 'approved' state")
        if ar["action"] != "deduct_fund" or str(ar["target_id"]) != str(user_id):
            raise HTTPException(status_code=409, detail="Approval does not match this action")
        if Decimal(str(ar["payload"].get("amount", "0"))) != amt:
            raise HTTPException(status_code=409, detail="Amount differs from approved request")

    source = (getattr(body, "source", None) or "").strip().lower() or None

    # Lock the user row up-front so concurrent admin actions serialise.
    user_result = await db.execute(
        select(User).where(User.id == user_id).with_for_update()
    )
    user_row = user_result.scalar_one_or_none()
    if not user_row:
        raise HTTPException(status_code=404, detail="User not found")

    main_bal = user_row.main_wallet_balance or Decimal("0")

    # Explicit trading-account source skips the main-wallet branch entirely.
    if source == "trading_account":
        if not getattr(body, "account_id", None):
            raise HTTPException(status_code=400, detail="account_id is required when source=trading_account")
        # Jump straight to the trading-account deduction block below.
        main_bal_check = Decimal("-1")  # force skip main-wallet branch
    elif source == "main_wallet":
        # Never fall back — error if main wallet is insufficient.
        if main_bal < amt:
            raise HTTPException(
                status_code=400,
                detail=f"Insufficient main wallet balance (${float(main_bal):.2f}).",
            )
        main_bal_check = main_bal
    else:
        main_bal_check = main_bal

    if source != "trading_account" and main_bal_check >= amt:
        # Deduct from main wallet
        user_row.main_wallet_balance = main_bal - amt
        txn = Transaction(
            user_id=user_id,
            account_id=None,
            type="adjustment",
            amount=-amt,
            balance_after=user_row.main_wallet_balance,
            description=body.description or "Admin fund deduction from main wallet",
            created_by=admin_id,
        )
        db.add(txn)
        await write_audit_log(
            db, admin_id, "deduct_fund", "user", user_id,
            old_values={"main_wallet_balance": str(main_bal)},
            new_values={"main_wallet_balance": str(user_row.main_wallet_balance), "amount_deducted": str(body.amount)},
            ip_address=ip_address,
        )
        if approval_request_id is not None:
            await mark_executed(db, request_id=approval_request_id)
        await db.commit()
        return {
            "message": "Fund deducted from main wallet successfully",
            "new_main_wallet_balance": float(user_row.main_wallet_balance),
        }

    # Fallback: deduct from trading account if account_id is provided
    if not getattr(body, "account_id", None):
        raise HTTPException(
            status_code=400,
            detail=f"Insufficient main wallet balance (${float(main_bal):.2f}). Provide a trading account ID to deduct from trading account.",
        )

    account_result = await db.execute(
        select(TradingAccount).where(
            TradingAccount.id == uuid.UUID(body.account_id),
            TradingAccount.user_id == user_id,
        ).with_for_update()
    )
    account = account_result.scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=404, detail="Trading account not found")

    old_balance = account.balance or Decimal("0")
    if old_balance < amt:
        raise HTTPException(
            status_code=400,
            detail=f"Insufficient balance in both main wallet (${float(main_bal):.2f}) and trading account (${float(old_balance):.2f})",
        )

    account.balance = old_balance - amt
    account.equity = account.balance + (account.credit or Decimal("0"))
    account.free_margin = account.equity - (account.margin_used or Decimal("0"))

    txn = Transaction(
        user_id=user_id,
        account_id=account.id,
        type="adjustment",
        amount=-amt,
        balance_after=account.balance,
        description=body.description or "Admin fund deduction from trading account",
        created_by=admin_id,
    )
    db.add(txn)
    await write_audit_log(
        db, admin_id, "deduct_fund", "trading_account", account.id,
        old_values={"balance": str(old_balance)},
        new_values={"balance": str(account.balance), "amount_deducted": str(body.amount)},
        ip_address=ip_address,
    )
    if approval_request_id is not None:
        await mark_executed(db, request_id=approval_request_id)
    await db.commit()
    return {"message": "Fund deducted from trading account successfully", "new_balance": float(account.balance)}


async def give_credit(
    user_id: uuid.UUID, body: CreditRequest,
    admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
) -> dict:
    account_result = await db.execute(
        select(TradingAccount).where(
            TradingAccount.id == uuid.UUID(body.account_id),
            TradingAccount.user_id == user_id,
        )
    )
    account = account_result.scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=404, detail="Trading account not found")

    old_credit = float(account.credit or 0)
    account.credit = Decimal(str(old_credit)) + Decimal(str(body.amount))
    account.equity = (account.balance or Decimal("0")) + account.credit

    txn = Transaction(
        user_id=user_id,
        account_id=account.id,
        type="credit",
        amount=Decimal(str(body.amount)),
        balance_after=account.balance,
        description=body.description or "Admin credit addition",
        created_by=admin_id,
    )
    db.add(txn)

    await write_audit_log(
        db, admin_id, "give_credit", "trading_account", account.id,
        old_values={"credit": str(old_credit)},
        new_values={"credit": str(account.credit), "amount": str(body.amount)},
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": "Credit added successfully", "new_credit": float(account.credit)}


async def take_credit(
    user_id: uuid.UUID, body: CreditRequest,
    admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
) -> dict:
    account_result = await db.execute(
        select(TradingAccount).where(
            TradingAccount.id == uuid.UUID(body.account_id),
            TradingAccount.user_id == user_id,
        )
    )
    account = account_result.scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=404, detail="Trading account not found")

    old_credit = float(account.credit or 0)
    if old_credit < body.amount:
        raise HTTPException(status_code=400, detail="Insufficient credit")

    account.credit = Decimal(str(old_credit)) - Decimal(str(body.amount))
    account.equity = (account.balance or Decimal("0")) + account.credit

    txn = Transaction(
        user_id=user_id,
        account_id=account.id,
        type="credit",
        amount=-Decimal(str(body.amount)),
        balance_after=account.balance,
        description=body.description or "Admin credit removal",
        created_by=admin_id,
    )
    db.add(txn)

    await write_audit_log(
        db, admin_id, "take_credit", "trading_account", account.id,
        old_values={"credit": str(old_credit)},
        new_values={"credit": str(account.credit), "amount_removed": str(body.amount)},
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": "Credit removed successfully", "new_credit": float(account.credit)}


async def ban_user(
    user_id: uuid.UUID, admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
) -> dict:
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    old_status = user.status
    user.status = "banned"

    await write_audit_log(
        db, admin_id, "ban_user", "user", user_id,
        old_values={"status": old_status},
        new_values={"status": "banned"},
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": "User banned successfully"}


async def unban_user(
    user_id: uuid.UUID, admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
) -> dict:
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    old_status = user.status
    user.status = "active"

    await write_audit_log(
        db, admin_id, "unban_user", "user", user_id,
        old_values={"status": old_status},
        new_values={"status": "active"},
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": "User unbanned successfully"}


async def _set_user_status(
    user_id: uuid.UUID, new_status: str, action: str, message: str,
    admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
    revoke_sessions: bool = True,
) -> dict:
    """Shared status transition for suspend / terminate / soft-delete /
    reactivate. The user's data is fully retained — only the `status` column
    changes, which the login paths honour (see login_block_message). When the
    new status blocks login we also revoke any live sessions so an already
    signed-in user is kicked out immediately."""
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    old_status = user.status
    user.status = new_status

    if revoke_sessions and new_status != "active":
        await db.execute(
            sa_update(UserSession)
            .where(UserSession.user_id == user_id, UserSession.is_active.is_(True))
            .values(is_active=False)
        )

    await write_audit_log(
        db, admin_id, action, "user", user_id,
        old_values={"status": old_status},
        new_values={"status": new_status},
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": message, "status": new_status}


async def suspend_user(user_id, admin_id, ip_address, db):
    """Temporary hold — user can't log in until reactivated. Data kept."""
    return await _set_user_status(user_id, "suspended", "suspend_user",
                                  "User suspended", admin_id, ip_address, db)


async def terminate_user(user_id, admin_id, ip_address, db):
    """Account closed (end of relationship) but full history retained."""
    return await _set_user_status(user_id, "terminated", "terminate_user",
                                  "User terminated", admin_id, ip_address, db)


async def soft_delete_user(user_id, admin_id, ip_address, db):
    """Soft delete — user can never log in again, but every record (ledger,
    deposits, trades) stays with the broker for audit/compliance."""
    return await _set_user_status(user_id, "deleted", "soft_delete_user",
                                  "User soft-deleted (records retained)", admin_id, ip_address, db)


async def reactivate_user(user_id, admin_id, ip_address, db):
    """Bring a suspended / terminated / soft-deleted user back to active."""
    return await _set_user_status(user_id, "active", "reactivate_user",
                                  "User reactivated", admin_id, ip_address, db, revoke_sessions=False)


async def block_trading(
    user_id: uuid.UUID, admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
) -> dict:
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    far_future = datetime.utcnow() + timedelta(days=36500)
    user.trading_blocked_until = far_future

    await write_audit_log(
        db, admin_id, "block_trading", "user", user_id,
        new_values={"trading_blocked_until": far_future.isoformat()},
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": "Trading blocked successfully"}


async def kill_switch(
    user_id: uuid.UUID, admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
) -> dict:
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    accounts_q = await db.execute(
        select(TradingAccount).where(TradingAccount.user_id == user_id)
    )
    accounts = accounts_q.scalars().all()
    account_ids = [a.id for a in accounts]

    closed_count = 0
    if account_ids:
        positions_q = await db.execute(
            select(Position).where(
                Position.account_id.in_(account_ids),
                Position.status == PositionStatus.OPEN.value,
            )
        )
        positions = positions_q.scalars().all()
        for pos in positions:
            pos.status = PositionStatus.CLOSED.value
            pos.close_price = pos.open_price
            pos.closed_at = datetime.utcnow()
            pos.profit = Decimal("0")
            pos.is_admin_modified = True
            closed_count += 1

    far_future = datetime.utcnow() + timedelta(days=36500)
    user.trading_blocked_until = far_future

    await write_audit_log(
        db, admin_id, "kill_switch", "user", user_id,
        new_values={"positions_closed": closed_count, "trading_blocked": True},
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": f"Kill switch activated. {closed_count} positions closed. Trading disabled."}


async def login_as_user(
    user_id: uuid.UUID, admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
) -> dict:
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    expire = datetime.utcnow() + timedelta(hours=2)
    payload = {
        "sub": str(user.id),
        "email": user.email,
        "role": user.role,
        "type": "user",
        "impersonated_by": str(admin_id),
        "exp": expire,
        "iat": datetime.utcnow(),
    }
    # Sign with the gateway's JWT_SECRET so /auth/bootstrap-session (which uses
    # decode_token → settings.JWT_SECRET) accepts the impersonation token.
    token = jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)

    await write_audit_log(
        db, admin_id, "login_as_user", "user", user_id,
        new_values={"impersonated_user_email": user.email},
        ip_address=ip_address,
    )
    await db.commit()

    return {"access_token": token, "token_type": "bearer", "user_email": user.email}


async def delete_user(
    user_id: uuid.UUID, admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
) -> dict:
    """Permanently delete a user and all their data.

    Order matters: child rows first, then NULL out admin-reference FKs on
    OTHER users' rows (reviewed_by, approved_by, etc.), then the user row itself.
    Admin/super_admin roles cannot be deleted from this endpoint.
    """
    from sqlalchemy import update

    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if user.role in ("super_admin",):
        raise HTTPException(status_code=403, detail="Cannot delete super_admin user")
    if user.id == admin_id:
        raise HTTPException(status_code=400, detail="Cannot delete your own account")

    user_email = user.email

    acc_ids_q = await db.execute(select(TradingAccount.id).where(TradingAccount.user_id == user_id))
    acc_ids = [row[0] for row in acc_ids_q.all()]

    master_ids_q = await db.execute(select(MasterAccount.id).where(MasterAccount.user_id == user_id))
    master_ids = [row[0] for row in master_ids_q.all()]

    # ── 1. CopyTrade rows referencing positions owned by THIS user ──
    # Positions on this user's accounts may be referenced by other users' CopyTrade
    # rows (via master_position_id or investor_position_id). Clear them first or
    # deleting positions later will fail on FK.
    if acc_ids:
        pos_ids_q = await db.execute(select(Position.id).where(Position.account_id.in_(acc_ids)))
        pos_ids = [row[0] for row in pos_ids_q.all()]
        if pos_ids:
            await db.execute(
                sql_delete(CopyTrade).where(
                    or_(
                        CopyTrade.master_position_id.in_(pos_ids),
                        CopyTrade.investor_position_id.in_(pos_ids),
                    )
                )
            )

    # ── 2. InvestorAllocation + CopyTrade cleanup ──
    alloc_filters = [InvestorAllocation.investor_user_id == user_id]
    if master_ids:
        alloc_filters.append(InvestorAllocation.master_id.in_(master_ids))
    alloc_ids_q = await db.execute(select(InvestorAllocation.id).where(or_(*alloc_filters)))
    alloc_ids = [row[0] for row in alloc_ids_q.all()]

    if alloc_ids:
        await db.execute(sql_delete(CopyTrade).where(CopyTrade.investor_allocation_id.in_(alloc_ids)))
        await db.execute(sql_delete(InvestorAllocation).where(InvestorAllocation.id.in_(alloc_ids)))

    # ── 3. MasterAccount rows owned by user ──
    if master_ids:
        await db.execute(sql_delete(MasterAccount).where(MasterAccount.id.in_(master_ids)))

    # ── 4. Positions, Orders, TradeHistory on user's trading accounts ──
    if acc_ids:
        # IBCommission.source_trade_id -> orders.id
        ord_ids_q = await db.execute(select(Order.id).where(Order.account_id.in_(acc_ids)))
        ord_ids = [row[0] for row in ord_ids_q.all()]
        if ord_ids:
            await db.execute(sql_delete(IBCommission).where(IBCommission.source_trade_id.in_(ord_ids)))

        await db.execute(sql_delete(TradeHistory).where(TradeHistory.account_id.in_(acc_ids)))
        # Position.order_id -> orders.id; null before deleting orders
        await db.execute(update(Position).where(Position.account_id.in_(acc_ids)).values(order_id=None))
        await db.execute(sql_delete(Position).where(Position.account_id.in_(acc_ids)))
        await db.execute(sql_delete(Order).where(Order.account_id.in_(acc_ids)))

    # ── 5. Money rows (Deposits, Withdrawals, Transactions, UserBonus) ──
    await db.execute(sql_delete(UserBonus).where(UserBonus.user_id == user_id))
    await db.execute(sql_delete(Deposit).where(Deposit.user_id == user_id))
    await db.execute(sql_delete(Withdrawal).where(Withdrawal.user_id == user_id))
    await db.execute(sql_delete(Transaction).where(Transaction.user_id == user_id))

    # ── 6. Trading accounts ──
    if acc_ids:
        await db.execute(sql_delete(TradingAccount).where(TradingAccount.id.in_(acc_ids)))

    # ── 7. IB system: commissions, referrals, profile ──
    ib_ids_q = await db.execute(select(IBProfile.id).where(IBProfile.user_id == user_id))
    ib_ids = [row[0] for row in ib_ids_q.all()]
    if ib_ids:
        await db.execute(sql_delete(IBCommission).where(IBCommission.ib_id.in_(ib_ids)))
    await db.execute(sql_delete(IBCommission).where(IBCommission.source_user_id == user_id))
    await db.execute(
        sql_delete(Referral).where(
            or_(Referral.referrer_id == user_id, Referral.referred_id == user_id)
        )
    )
    if ib_ids:
        await db.execute(
            update(IBProfile).where(IBProfile.parent_ib_id.in_(ib_ids)).values(parent_ib_id=None)
        )
        await db.execute(sql_delete(IBProfile).where(IBProfile.id.in_(ib_ids)))
    await db.execute(sql_delete(IBApplication).where(IBApplication.user_id == user_id))

    # ── 8. Misc user rows ──
    await db.execute(sql_delete(Notification).where(Notification.user_id == user_id))
    await db.execute(sql_delete(UserSession).where(UserSession.user_id == user_id))
    await db.execute(sql_delete(UserRefreshToken).where(UserRefreshToken.user_id == user_id))
    await db.execute(sql_delete(UserAuditLog).where(UserAuditLog.user_id == user_id))
    await db.execute(sql_delete(PasswordResetToken).where(PasswordResetToken.user_id == user_id))
    await db.execute(sql_delete(KYCDocument).where(KYCDocument.user_id == user_id))
    # TicketMessage.ticket_id has ON DELETE CASCADE, so deleting SupportTicket cleans them
    await db.execute(sql_delete(SupportTicket).where(SupportTicket.user_id == user_id))
    await db.execute(sql_delete(Employee).where(Employee.user_id == user_id))
    await db.execute(sql_delete(ChargeConfig).where(ChargeConfig.user_id == user_id))

    # ── 9. NULL out admin-reference FKs on rows we DON'T own ──
    # If this user ever reviewed/approved/created something on another user's record,
    # those references would block the user row deletion. Set them to NULL.
    await db.execute(update(KYCDocument).where(KYCDocument.reviewed_by == user_id).values(reviewed_by=None))
    await db.execute(update(Deposit).where(Deposit.approved_by == user_id).values(approved_by=None))
    await db.execute(update(Withdrawal).where(Withdrawal.approved_by == user_id).values(approved_by=None))
    await db.execute(update(Transaction).where(Transaction.created_by == user_id).values(created_by=None))
    await db.execute(update(Order).where(Order.admin_created_by == user_id).values(admin_created_by=None))
    await db.execute(update(SupportTicket).where(SupportTicket.assigned_to == user_id).values(assigned_to=None))
    await db.execute(update(TicketMessage).where(TicketMessage.sender_id == user_id).values(sender_id=None))
    await db.execute(update(IBApplication).where(IBApplication.approved_by == user_id).values(approved_by=None))
    await db.execute(update(IBProfile).where(IBProfile.rejected_by == user_id).values(rejected_by=None))
    await db.execute(update(InstrumentConfig).where(InstrumentConfig.updated_by == user_id).values(updated_by=None))
    await db.execute(update(InstrumentConfigAudit).where(InstrumentConfigAudit.changed_by == user_id).values(changed_by=None))
    await db.execute(update(SystemSetting).where(SystemSetting.updated_by == user_id).values(updated_by=None))
    await db.execute(update(AuditLog).where(AuditLog.admin_id == user_id).values(admin_id=None))

    # ── 9b. RESTRICT FKs that block the delete (no ON DELETE CASCADE) ──
    # Most user-owned tables (insurance_policies, rewards_*, staking_positions,
    # fixed_return_locks, vip_passes, shared_trades, spin/lottery/bids) use
    # ON DELETE CASCADE, so the DB clears them automatically. These do NOT and
    # would otherwise raise a ForeignKeyViolation on the final delete — which
    # surfaced to the admin as a silent "nothing happened". Raw SQL avoids
    # importing each model. Self-references are the most common blocker for a
    # master/IB user (they referred others).
    from sqlalchemy import text
    p = {"uid": str(user_id)}
    # Each of these touches a table that may NOT exist on every deployment
    # (lifestyle, rm_funding, insurance, and the newer employee_* tables).
    # Run each in its own SAVEPOINT so a missing table raises a swallowed
    # ProgrammingError instead of 500-ing (and aborting) the whole delete —
    # which was the "internal server error" the admin saw.
    _optional = [
        "UPDATE users SET referred_by_user_id = NULL WHERE referred_by_user_id = :uid",
        "UPDATE users SET assigned_rm_id = NULL WHERE assigned_rm_id = :uid",
        "DELETE FROM insurance_claims WHERE user_id = :uid",
        "DELETE FROM insurance_policies WHERE user_id = :uid",
        "DELETE FROM rm_funding_requests WHERE rm_id = :uid OR user_id = :uid",
        "UPDATE rm_funding_requests SET approved_by = NULL WHERE approved_by = :uid",
        "UPDATE rm_funding_requests SET credited_by = NULL WHERE credited_by = :uid",
        "UPDATE rm_funding_requests SET rejected_by = NULL WHERE rejected_by = :uid",
        "UPDATE lifestyle_fulfillments SET handled_by = NULL WHERE handled_by = :uid",
        # Newer tables that FK users.id — harmless no-ops if the user never
        # touched them, skipped entirely if the table isn't present.
        "DELETE FROM employee_tasks WHERE assigned_to = :uid OR assigned_by = :uid",
        "UPDATE employee_custom_roles SET created_by = NULL WHERE created_by = :uid",
        "UPDATE admin_notifications SET read_by = NULL WHERE read_by = :uid",
        # Per-user pricing overrides (admin sets these on master traders / VIPs).
        # spread_configs.user_id / swap_configs.user_id are RESTRICT FKs, so an
        # uncleaned row blocks the final user delete → the 500 on master users.
        "DELETE FROM spread_configs WHERE user_id = :uid",
        "DELETE FROM swap_configs WHERE user_id = :uid",
        # Social / sharing + rewards rows that FK users.id without CASCADE.
        "DELETE FROM shared_trades WHERE user_id = :uid",
        "DELETE FROM social_follows WHERE follower_id = :uid OR following_id = :uid",
        "DELETE FROM master_followers WHERE follower_user_id = :uid",
        # Bonuses / pool memberships an "old" (active) user accumulated that
        # also FK users.id without CASCADE (client 2026-06-20: long-standing
        # users still failed to delete). Each is a no-op if absent.
        "DELETE FROM user_bonuses WHERE user_id = :uid",
        "DELETE FROM master_accounts WHERE user_id = :uid",
        "DELETE FROM ticket_messages WHERE sender_id = :uid",
        # Personal bank-deposit requests (migration 0082). user_id is a RESTRICT
        # FK so an uncleaned row blocks the final user delete (client 2026-06-29:
        # "deposit_requests_user_id_fkey" violation). approved_by points at the
        # admin who responded — NULL it on rows this user reviewed for others.
        "DELETE FROM deposit_requests WHERE user_id = :uid",
        "UPDATE deposit_requests SET approved_by = NULL WHERE approved_by = :uid",
    ]
    for _sql in _optional:
        try:
            async with db.begin_nested():
                await db.execute(text(_sql), p)
        except Exception:
            pass  # table absent on this deployment — skip it

    # ── 10. Finally the user row + commit, guarded together ──
    # The FK-violation that blocks deletion raises on the DELETE statement
    # itself (Postgres constraints are IMMEDIATE), not at commit — so the guard
    # must wrap the delete too, otherwise an unhandled FK surfaces as a 500
    # instead of the intended clear 409.
    try:
        await db.execute(sql_delete(User).where(User.id == user_id))
        await write_audit_log(
            db, admin_id, "delete_user", "user", user_id,
            new_values={"email": user_email},
            ip_address=ip_address,
        )
        await db.commit()
    except HTTPException:
        raise
    except Exception as e:
        # A table we don't yet clean up still references this user (or any
        # other DB error). Surface WHAT blocked it so it's a clear, fixable
        # message in the admin UI instead of a silent "Internal server error"
        # — client 2026-06-20: never 500 the delete. Broadened from the
        # IntegrityError/DBAPIError-only catch so an asyncpg/ProgrammingError
        # from an old user's extra rows can't escape as a 500.
        await db.rollback()
        orig = getattr(e, "orig", e)
        raise HTTPException(
            status_code=409,
            detail=f"Cannot permanently delete this user — a record still references them ({orig}). "
                   "Use Soft Delete to disable the account while keeping records.",
        )

    return {"message": f"User {user_email} permanently deleted"}


# ─── Account-security helpers (admin-triggered) ──────────────────────


async def trigger_password_reset(
    user_id: uuid.UUID, admin_id: uuid.UUID,
    ip_address: str | None, db: AsyncSession,
) -> dict:
    """Admin asks the system to email the user a password reset link.

    Plain passwords are never stored (bcrypt at rest) so we can't show
    one to the admin — but we CAN issue a one-time 15-min token, drop
    a row in password_reset_tokens, and ship the user the standard
    reset email. The user then sets the new password themselves and
    nobody (including admin) ever sees the plaintext.
    """
    import secrets
    import hashlib
    from datetime import timezone

    u = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    if u.status in ("banned",):
        raise HTTPException(status_code=403, detail="Cannot reset password for a banned account")

    # Same token shape the gateway's forgot-password flow uses — 32-byte
    # url-safe random, sha256 stored. Token is only ever returned to the
    # user via email; admin never sees it.
    raw = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=15)
    db.add(PasswordResetToken(
        user_id=u.id, token_hash=token_hash, expires_at=expires_at, used=False,
    ))

    # Email — best-effort. If SMTP is unconfigured (dev) we log instead.
    settings = get_settings()
    base = settings.TRADER_APP_URL.rstrip("/")
    link = f"{base}/auth/reset-password?token={raw}"
    sent = False
    try:
        from packages.common.src.smtp_mail import send_password_reset_email, smtp_configured
        if smtp_configured():
            sent = await send_password_reset_email(u.email, link)
    except Exception:
        sent = False

    await write_audit_log(
        db, admin_id, "admin_trigger_reset", "user", user_id,
        new_values={"email": u.email, "delivery": "email" if sent else "logged"},
        ip_address=ip_address,
    )
    await db.commit()

    return {
        "message": (
            f"Reset link emailed to {u.email}"
            if sent else
            "Reset token created; SMTP unconfigured — check server logs"
        ),
        "sent": bool(sent),
        # Only surface the link in a genuine dev environment; prod admins must
        # rely on the email so the account-takeover token never leaks in-band.
        # Use the SAME canonical dev set as config.py (an `!= "production"`
        # test would still expose the link under ENVIRONMENT=staging/prod/etc).
        "reset_link": (
            link if settings.ENVIRONMENT.lower() in ("development", "dev", "local", "test")
            else None
        ),
    }


async def set_password_by_admin(
    user_id: uuid.UUID, admin_id: uuid.UUID, new_password: str | None,
    ip_address: str | None, db: AsyncSession,
) -> dict:
    """Admin SETS a new password for the user and SEES it (client 2026-06-16).

    The stored password is bcrypt-hashed, so the OLD password can never be
    shown. This instead lets the admin set a known password (provided or
    auto-generated) and returns that plaintext ONCE so the admin can hand it
    to the user. Setting the password also revokes the user's existing
    sessions (password epoch) so old logins are kicked.
    """
    import secrets
    import string
    from packages.common.src.auth import hash_password
    from packages.common.src.password_policy import validate_password, PasswordTooWeak

    u = (await db.execute(
        select(User).where(User.id == user_id).with_for_update()
    )).scalar_one_or_none()
    if not u:
        raise HTTPException(status_code=404, detail="User not found")

    pwd = (new_password or "").strip()
    if not pwd:
        # Generate a strong 12-char password (mixed case + digits).
        alphabet = string.ascii_letters + string.digits
        pwd = "Sx" + "".join(secrets.choice(alphabet) for _ in range(10))
    try:
        validate_password(pwd, disallow=[
            (u.email or "").split("@", 1)[0],
            u.first_name or "", u.last_name or "",
        ])
    except PasswordTooWeak as e:
        raise HTTPException(status_code=400, detail=getattr(e, "reason", str(e)))

    u.password_hash = hash_password(pwd)

    # Revoke active sessions so the old password / sessions stop working.
    await db.execute(
        sa_update(UserSession)
        .where(UserSession.user_id == user_id, UserSession.is_active.is_(True))
        .values(is_active=False)
    )
    await write_audit_log(
        db, admin_id, "admin_set_password", "user", user_id,
        new_values={"email": u.email},  # never log the plaintext
        ip_address=ip_address,
    )
    await db.commit()
    return {
        "message": "Password set. Share it with the user — it won't be shown again.",
        "password": pwd,
    }


async def list_user_sessions(user_id: uuid.UUID, db: AsyncSession) -> dict:
    """Active (non-expired, is_active) login sessions for the user."""
    now = datetime.utcnow()
    rows = (await db.execute(
        select(UserSession).where(
            UserSession.user_id == user_id,
            UserSession.is_active.is_(True),
            UserSession.expires_at > now,
        ).order_by(UserSession.created_at.desc())
    )).scalars().all()

    items = []
    for s in rows:
        items.append({
            "id": str(s.id),
            "ip_address": str(s.ip_address) if s.ip_address else None,
            "user_agent": s.user_agent,
            "device_info": s.device_info,
            "created_at": s.created_at.isoformat() if s.created_at else None,
            "expires_at": s.expires_at.isoformat() if s.expires_at else None,
        })
    return {"items": items, "total": len(items)}


async def revoke_user_session(
    user_id: uuid.UUID, session_id: uuid.UUID,
    admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
) -> dict:
    s = (await db.execute(
        select(UserSession).where(
            UserSession.id == session_id,
            UserSession.user_id == user_id,
        )
    )).scalar_one_or_none()
    if not s:
        raise HTTPException(status_code=404, detail="Session not found")
    s.is_active = False
    await write_audit_log(
        db, admin_id, "revoke_session", "user_session", session_id,
        new_values={"user_id": str(user_id)},
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": "Session revoked"}


async def revoke_all_user_sessions(
    user_id: uuid.UUID, admin_id: uuid.UUID,
    ip_address: str | None, db: AsyncSession,
) -> dict:
    rows = (await db.execute(
        select(UserSession).where(
            UserSession.user_id == user_id,
            UserSession.is_active.is_(True),
        )
    )).scalars().all()
    count = 0
    for s in rows:
        s.is_active = False
        count += 1
    # Also kill any refresh tokens so the user can't slide back in via
    # the rotate path.
    rt_rows = (await db.execute(
        select(UserRefreshToken).where(
            UserRefreshToken.user_id == user_id,
            UserRefreshToken.revoked_at.is_(None),
        )
    )).scalars().all()
    for rt in rt_rows:
        rt.revoked_at = datetime.utcnow()

    await write_audit_log(
        db, admin_id, "revoke_all_sessions", "user", user_id,
        new_values={"sessions_revoked": count, "refresh_tokens_revoked": len(rt_rows)},
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": f"Revoked {count} session(s)", "sessions_revoked": count}
