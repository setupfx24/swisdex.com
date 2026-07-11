"""4-eyes approval helper for high-value financial admin actions.

Rule:
  * Any add_fund / deduct_fund / withdrawal_approve at or above
    settings.ADMIN_DUAL_APPROVAL_THRESHOLD requires a second admin to
    approve before the original admin's request is executed.
  * The same admin who created the request CANNOT approve it
    (enforced both here and by a CHECK constraint on the table).
  * Above settings.ADMIN_BALANCE_MUTATION_CAP the action is rejected
    outright — no admin can move that much in a single operation,
    even with two signatures. (Defense-in-depth against compromised
    super_admin.)
"""
from __future__ import annotations

import json
import uuid
from decimal import Decimal
from typing import Any, Optional

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.config import get_settings


class ApprovalRequired(HTTPException):
    """Raised when an action exceeds the dual-approval threshold and a
    pending request has been created instead of executing immediately."""
    def __init__(self, request_id: uuid.UUID, threshold: float):
        super().__init__(
            status_code=202,
            detail={
                "code": "approval_required",
                "request_id": str(request_id),
                "threshold_usd": threshold,
                "message": (
                    "Amount at or above the dual-approval threshold; "
                    "a second admin must approve this request."
                ),
            },
        )


def _check_cap(amount: Decimal) -> None:
    """Hard cap — reject outright if amount exceeds the absolute ceiling."""
    cap = Decimal(str(get_settings().ADMIN_BALANCE_MUTATION_CAP))
    if cap > 0 and amount > cap:
        raise HTTPException(
            status_code=400,
            detail=f"Amount ${amount} exceeds the per-action cap (${cap}). "
                   "Split into smaller operations or contact compliance.",
        )


async def dual_approval_threshold() -> Decimal:
    """The dual-approval threshold in USD. Admin-editable via the settings
    store (`dual_approval_threshold_usd`), falling back to the
    ADMIN_DUAL_APPROVAL_THRESHOLD env default (client 2026-06-23: "1000 ko
    custom kaise karein" — now settable from Admin → Settings)."""
    from packages.common.src.settings_store import get_float_setting
    env_default = float(get_settings().ADMIN_DUAL_APPROVAL_THRESHOLD)
    val = await get_float_setting("dual_approval_threshold_usd", env_default)
    return Decimal(str(val))


async def needs_dual_approval(amount: Decimal) -> bool:
    return amount >= await dual_approval_threshold()


async def request_or_execute(
    db: AsyncSession,
    *,
    action: str,
    target_type: str,
    target_id: uuid.UUID,
    amount: Decimal,
    payload: dict[str, Any],
    requested_by: uuid.UUID,
    always: bool = False,
) -> Optional[uuid.UUID]:
    """Gate a financial action through the approval rules.

    Returns:
      * None      → caller may proceed and execute the action immediately.
      * UUID      → an approval request was created and the caller MUST
                    abort the action with ApprovalRequired (or by raising
                    a custom 202 themselves). The action will run when a
                    second admin calls execute_approved_request().

    `always=True` forces dual approval regardless of the amount threshold —
    used for deposit/withdrawal approval where EVERY amount needs a second
    super-admin sign-off (client 2026-06-16).

    Raises HTTPException(400) when the absolute cap is exceeded.
    """
    # The absolute per-action cap guards admin-initiated fund moves
    # (add_fund/deduct_fund). It does NOT apply to deposit/withdrawal
    # approval (always=True) — that's the user's own money and may legitimately
    # exceed the cap; the two-admin sign-off is the control there.
    if not always:
        _check_cap(amount)
        if not await needs_dual_approval(amount):
            return None

    # Snapshot the requested change so the executing admin sees exactly
    # what was approved.
    snapshot = {**payload, "amount": str(amount)}
    result = await db.execute(
        text(
            """
            INSERT INTO admin_approval_requests
                (action, target_type, target_id, payload, requested_by)
            VALUES
                (:action, :target_type, :target_id, CAST(:payload AS JSONB), :requested_by)
            RETURNING id
            """
        ),
        {
            "action": action,
            "target_type": target_type,
            "target_id": str(target_id),
            "payload": json.dumps(snapshot),
            "requested_by": str(requested_by),
        },
    )
    row = result.first()
    await db.commit()
    raise ApprovalRequired(row[0], float(await dual_approval_threshold()))


async def fetch_pending(db: AsyncSession, request_id: uuid.UUID) -> dict:
    """Load a pending request, locking the row FOR UPDATE so two approvers
    cannot both flip it to 'approved' simultaneously."""
    row = await db.execute(
        text(
            """
            SELECT id, action, target_type, target_id, payload, requested_by, status, expires_at
            FROM admin_approval_requests
            WHERE id = :rid
            FOR UPDATE
            """
        ),
        {"rid": str(request_id)},
    )
    rec = row.mappings().first()
    if not rec:
        raise HTTPException(status_code=404, detail="Approval request not found")
    if rec["status"] != "pending":
        raise HTTPException(status_code=409, detail=f"Request is {rec['status']}")
    return dict(rec)


async def approve(
    db: AsyncSession,
    *,
    request_id: uuid.UUID,
    approver_id: uuid.UUID,
) -> dict:
    rec = await fetch_pending(db, request_id)
    if rec["requested_by"] == approver_id:
        raise HTTPException(status_code=403, detail="Same admin cannot approve their own request")
    await db.execute(
        text(
            """
            UPDATE admin_approval_requests
            SET status = 'approved',
                approved_by = :approver,
                approved_at = NOW()
            WHERE id = :rid
            """
        ),
        {"approver": str(approver_id), "rid": str(request_id)},
    )
    return rec


async def reject(
    db: AsyncSession,
    *,
    request_id: uuid.UUID,
    rejector_id: uuid.UUID,
    reason: str,
) -> dict:
    rec = await fetch_pending(db, request_id)
    await db.execute(
        text(
            """
            UPDATE admin_approval_requests
            SET status = 'rejected',
                rejected_by = :who,
                rejected_at = NOW(),
                rejection_reason = :reason
            WHERE id = :rid
            """
        ),
        {"who": str(rejector_id), "rid": str(request_id), "reason": reason or None},
    )
    return rec


async def mark_executed(db: AsyncSession, *, request_id: uuid.UUID) -> None:
    await db.execute(
        text(
            """
            UPDATE admin_approval_requests
            SET status = 'executed',
                executed_at = NOW()
            WHERE id = :rid AND status = 'approved'
            """
        ),
        {"rid": str(request_id)},
    )
