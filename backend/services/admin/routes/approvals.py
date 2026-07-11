"""Admin approval queue — second-admin sign-off for high-value financial actions."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.database import get_db
from packages.common.src.models import User

# Absolute imports — admin app puts /app on PYTHONPATH; relative imports
# from a sibling package raise "attempted relative import beyond top-level
# package" because the routes/ folder isn't a child of a package.
from dependencies import require_permission, write_audit_log
from services import approval_service

router = APIRouter()


class RejectBody(BaseModel):
    reason: str = Field(..., min_length=1, max_length=500)


@router.get("")
async def list_pending(
    # Tied to funds.approve so the whole Approvals section unlocks with a
    # single permission — granting Finance (which now holds funds.approve)
    # gives the admin the queue + approve/reject in one go.
    admin: User = Depends(require_permission("funds.approve")),
    db: AsyncSession = Depends(get_db),
):
    """List all pending approval requests (filterable client-side)."""
    rows = await db.execute(
        text(
            """
            SELECT id, action, target_type, target_id, payload,
                   requested_by, requested_at, status, expires_at
            FROM admin_approval_requests
            WHERE status = 'pending' AND expires_at > NOW()
            ORDER BY requested_at DESC
            LIMIT 200
            """
        )
    )
    return {"items": [dict(r) for r in rows.mappings().all()]}


@router.post("/{request_id}/approve")
async def approve(
    request_id: uuid.UUID,
    request: Request,
    # Second-admin sign-off on a financial action. Gated on funds.approve,
    # a permission no employee role holds → super_admin only (client
    # 2026-06-12: every admin funding needs super-admin approval).
    admin: User = Depends(require_permission("funds.approve")),
    db: AsyncSession = Depends(get_db),
):
    """Second-admin approval. Cannot be the same admin who requested it.
    On success the row is flipped to 'approved'; the requesting admin must
    then re-invoke the original endpoint with `?approval_request_id=...`
    to actually execute the change."""
    rec = await approval_service.approve(db, request_id=request_id, approver_id=admin.id)
    ip = request.client.host if request.client else None
    action = rec["action"]

    # Deposit/withdrawal approvals EXECUTE on the super-admin's sign-off
    # (client 2026-06-16): the authority admin requested it, this second
    # super-admin approval actually credits/debits the user. add_fund /
    # deduct_fund keep the re-invoke pattern (the requesting admin re-calls
    # the original endpoint with ?approval_request_id=).
    if action in ("deposit_approve", "withdrawal_approve"):
        from decimal import Decimal as _D
        from services import deposit_service
        tid = uuid.UUID(str(rec["target_id"]))
        payload = rec["payload"] or {}
        if action == "deposit_approve":
            va = payload.get("verified_amount")
            result = await deposit_service.approve_deposit(
                tid, admin.id, ip, db,
                verified_amount=_D(str(va)) if va not in (None, "") else None,
                approval_request_id=request_id,
            )
        else:
            result = await deposit_service.approve_withdrawal(
                tid, admin.id, ip, db, approval_request_id=request_id,
            )
        # approve_deposit/withdrawal commit internally (incl. the approval
        # status flip + mark_executed).
        return {"message": "Approved and executed", "request_id": str(request_id), "result": result}

    # Fund add/deduct ALSO execute on the second sign-off (client 2026-06-23):
    # previously the requesting admin had to re-invoke the original endpoint
    # with ?approval_request_id=, which the UI never did — so the money never
    # moved even after both approvals. Execute it here, like deposit/withdrawal.
    if action in ("add_fund", "deduct_fund"):
        from services import user_service
        from packages.common.src.admin_schemas import FundRequest
        tid = uuid.UUID(str(rec["target_id"]))
        payload = rec["payload"] or {}
        body = FundRequest(
            account_id=payload.get("account_id"),
            amount=float(payload.get("amount") or 0),
            description=payload.get("description"),
            source=payload.get("source"),
        )
        if action == "add_fund":
            result = await user_service.add_fund(
                tid, body, admin.id, ip, db, approval_request_id=request_id,
            )
        else:
            result = await user_service.deduct_fund(
                tid, body, admin.id, ip, db, approval_request_id=request_id,
            )
        return {"message": "Approved and executed", "request_id": str(request_id), "result": result}

    await write_audit_log(
        db, admin.id, "approval_grant", "admin_approval_request", request_id,
        new_values={"action": rec["action"], "target_id": str(rec["target_id"])},
        ip_address=ip,
    )
    await db.commit()
    return {"message": "Approved", "request_id": str(request_id)}


@router.post("/{request_id}/reject")
async def reject(
    request_id: uuid.UUID,
    body: RejectBody,
    request: Request,
    admin: User = Depends(require_permission("funds.approve")),
    db: AsyncSession = Depends(get_db),
):
    rec = await approval_service.reject(
        db, request_id=request_id, rejector_id=admin.id, reason=body.reason,
    )
    await write_audit_log(
        db, admin.id, "approval_reject", "admin_approval_request", request_id,
        new_values={"action": rec["action"], "reason": body.reason},
        ip_address=request.client.host if request.client else None,
    )
    await db.commit()
    return {"message": "Rejected", "request_id": str(request_id)}
