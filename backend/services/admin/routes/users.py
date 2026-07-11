import uuid

from fastapi import APIRouter, Depends, Query, Request, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.exc import IntegrityError, DBAPIError

from packages.common.src.database import get_db
from dependencies import require_permission
from packages.common.src.models import User
from packages.common.src.admin_schemas import FundRequest, CreditRequest
from services import user_service

router = APIRouter(prefix="/users", tags=["Users"])


@router.get("")
async def list_users(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    search: str = Query(None),
    status_filter: str = Query(None, alias="status"),
    kyc_filter: str = Query(None, alias="kyc_status"),
    group_id: str = Query(None),
    date_from: str | None = Query(None, description="YYYY-MM-DD; inclusive lower bound on User.created_at"),
    date_to:   str | None = Query(None, description="YYYY-MM-DD; inclusive upper bound on User.created_at"),
    admin: User = Depends(require_permission("users.view")),
    db: AsyncSession = Depends(get_db),
):
    return await user_service.list_users(
        page=page, per_page=per_page, search=search,
        status_filter=status_filter, kyc_filter=kyc_filter, group_id=group_id,
        date_from=date_from, date_to=date_to,
        db=db,
    )


@router.get("/{user_id}")
async def get_user_detail(
    user_id: uuid.UUID,
    admin: User = Depends(require_permission("users.view")),
    db: AsyncSession = Depends(get_db),
):
    return await user_service.get_user_detail(user_id=user_id, db=db)


class PromotionalRequest(BaseModel):
    is_promotional: bool


@router.post("/{user_id}/promotional")
async def set_user_promotional(
    user_id: uuid.UUID,
    body: PromotionalRequest,
    admin: User = Depends(require_permission("users.add_fund")),
    db: AsyncSession = Depends(get_db),
):
    """Mark/unmark the WHOLE user as promotional (pilot). A promotional user is
    funded for showcase and stays fully live on their own dashboard, but ALL
    their activity (every account + FR/referral/IB/bonus) is excluded from the
    admin's real company financials."""
    return await user_service.set_user_promotional(
        user_id=user_id, is_promotional=body.is_promotional, db=db,
    )


class FrReferralOverrideBody(BaseModel):
    # null on a leg = clear it (fall back to the global %).
    principal_pct: float | None = None
    interest_pct: float | None = None


@router.get("/{user_id}/fr-referral-override")
async def get_fr_referral_override(
    user_id: uuid.UUID,
    admin: User = Depends(require_permission("users.view")),
    db: AsyncSession = Depends(get_db),
):
    """This referrer's custom FR referral-commission % (and the global defaults)."""
    return await user_service.get_fr_referral_override(user_id=user_id, db=db)


@router.post("/{user_id}/fr-referral-override")
async def set_fr_referral_override(
    user_id: uuid.UUID,
    body: FrReferralOverrideBody,
    admin: User = Depends(require_permission("users.add_fund")),
    db: AsyncSession = Depends(get_db),
):
    """Set/clear a custom FR referral-commission % for this referrer. Send null
    on a leg to clear it (that leg falls back to the global setting)."""
    return await user_service.set_fr_referral_override(
        user_id=user_id, principal_pct=body.principal_pct,
        interest_pct=body.interest_pct, db=db,
    )


@router.get("/{user_id}/deposits")
async def get_user_deposits(
    user_id: uuid.UUID,
    admin: User = Depends(require_permission("users.view")),
    db: AsyncSession = Depends(get_db),
):
    """Per-deposit history (method + which admin approved it)."""
    return {"deposits": await user_service.get_user_deposits(user_id=user_id, db=db)}


@router.post("/{user_id}/add-fund")
async def add_fund(
    user_id: uuid.UUID,
    body: FundRequest,
    request: Request,
    approval_request_id: uuid.UUID | None = None,
    admin: User = Depends(require_permission("users.add_fund")),
    db: AsyncSession = Depends(get_db),
):
    """Add funds to user main wallet.

    For amounts < ADMIN_DUAL_APPROVAL_THRESHOLD: executes immediately.
    For amounts ≥ threshold: returns 202 with `request_id`. A second admin
    must POST /admin/approvals/{request_id}/approve, then this endpoint is
    called again with `?approval_request_id=...`."""
    return await user_service.add_fund(
        user_id=user_id, body=body, admin_id=admin.id,
        ip_address=request.client.host if request.client else None, db=db,
        approval_request_id=approval_request_id,
    )


@router.post("/{user_id}/deduct-fund")
async def deduct_fund(
    user_id: uuid.UUID,
    body: FundRequest,
    request: Request,
    approval_request_id: uuid.UUID | None = None,
    admin: User = Depends(require_permission("users.deduct_fund")),
    db: AsyncSession = Depends(get_db),
):
    """Deduct funds. Same dual-approval gate as add-fund."""
    return await user_service.deduct_fund(
        user_id=user_id, body=body, admin_id=admin.id,
        ip_address=request.client.host if request.client else None, db=db,
        approval_request_id=approval_request_id,
    )


@router.post("/{user_id}/give-credit")
async def give_credit(
    user_id: uuid.UUID,
    body: CreditRequest,
    request: Request,
    admin: User = Depends(require_permission("users.add_fund")),
    db: AsyncSession = Depends(get_db),
):
    return await user_service.give_credit(
        user_id=user_id, body=body, admin_id=admin.id,
        ip_address=request.client.host if request.client else None, db=db,
    )


@router.post("/{user_id}/take-credit")
async def take_credit(
    user_id: uuid.UUID,
    body: CreditRequest,
    request: Request,
    admin: User = Depends(require_permission("users.add_fund")),
    db: AsyncSession = Depends(get_db),
):
    return await user_service.take_credit(
        user_id=user_id, body=body, admin_id=admin.id,
        ip_address=request.client.host if request.client else None, db=db,
    )


@router.post("/{user_id}/ban")
async def ban_user(
    user_id: uuid.UUID,
    request: Request,
    admin: User = Depends(require_permission("users.ban")),
    db: AsyncSession = Depends(get_db),
):
    return await user_service.ban_user(
        user_id=user_id, admin_id=admin.id,
        ip_address=request.client.host if request.client else None, db=db,
    )


@router.post("/{user_id}/unban")
async def unban_user(
    user_id: uuid.UUID,
    request: Request,
    admin: User = Depends(require_permission("users.ban")),
    db: AsyncSession = Depends(get_db),
):
    return await user_service.unban_user(
        user_id=user_id, admin_id=admin.id,
        ip_address=request.client.host if request.client else None, db=db,
    )


@router.post("/{user_id}/suspend")
async def suspend_user(
    user_id: uuid.UUID,
    request: Request,
    admin: User = Depends(require_permission("users.ban")),
    db: AsyncSession = Depends(get_db),
):
    """Temporary hold — blocks login + kicks live sessions. Data retained."""
    return await user_service.suspend_user(
        user_id, admin.id, request.client.host if request.client else None, db)


@router.post("/{user_id}/terminate")
async def terminate_user(
    user_id: uuid.UUID,
    request: Request,
    admin: User = Depends(require_permission("users.ban")),
    db: AsyncSession = Depends(get_db),
):
    """Close the account (end of relationship) but keep full history."""
    return await user_service.terminate_user(
        user_id, admin.id, request.client.host if request.client else None, db)


@router.post("/{user_id}/soft-delete")
async def soft_delete_user(
    user_id: uuid.UUID,
    request: Request,
    admin: User = Depends(require_permission("users.ban")),
    db: AsyncSession = Depends(get_db),
):
    """Soft delete — user can never log in again, but every record stays with
    the broker (ledger / deposits / trades). Reversible via reactivate."""
    return await user_service.soft_delete_user(
        user_id, admin.id, request.client.host if request.client else None, db)


@router.post("/{user_id}/reactivate")
async def reactivate_user(
    user_id: uuid.UUID,
    request: Request,
    admin: User = Depends(require_permission("users.ban")),
    db: AsyncSession = Depends(get_db),
):
    """Bring a suspended / terminated / soft-deleted user back to active."""
    return await user_service.reactivate_user(
        user_id, admin.id, request.client.host if request.client else None, db)


@router.post("/{user_id}/block-trading")
async def block_trading(
    user_id: uuid.UUID,
    request: Request,
    admin: User = Depends(require_permission("users.block_trading")),
    db: AsyncSession = Depends(get_db),
):
    return await user_service.block_trading(
        user_id=user_id, admin_id=admin.id,
        ip_address=request.client.host if request.client else None, db=db,
    )


class BankDepositBody(BaseModel):
    enabled: bool


@router.post("/{user_id}/bank-deposit")
async def set_bank_deposit(
    user_id: uuid.UUID,
    body: BankDepositBody,
    admin: User = Depends(require_permission("users.add_fund")),
    db: AsyncSession = Depends(get_db),
):
    """Show/hide the bank (manual) deposit option for THIS user specifically
    (client 2026-06-23). Overrides the global wallet.manual_enabled toggle."""
    from packages.common.src.models import User as _U
    u = (await db.execute(select(_U).where(_U.id == user_id))).scalar_one_or_none()
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    u.bank_deposit_enabled = bool(body.enabled)
    await db.commit()
    return {"message": "Bank deposit visibility updated", "bank_deposit_enabled": bool(body.enabled)}


@router.post("/{user_id}/kill-switch")
async def kill_switch(
    user_id: uuid.UUID,
    request: Request,
    admin: User = Depends(require_permission("users.kill_switch")),
    db: AsyncSession = Depends(get_db),
):
    return await user_service.kill_switch(
        user_id=user_id, admin_id=admin.id,
        ip_address=request.client.host if request.client else None, db=db,
    )


@router.post("/{user_id}/login-as")
async def login_as_user(
    user_id: uuid.UUID,
    request: Request,
    # Impersonation mints a full trader session = account takeover. Gate
    # it behind a dedicated high-trust permission that no employee role
    # holds, so effectively only super_admin can impersonate (audit H1).
    admin: User = Depends(require_permission("users.impersonate")),
    db: AsyncSession = Depends(get_db),
):
    return await user_service.login_as_user(
        user_id=user_id, admin_id=admin.id,
        ip_address=request.client.host if request.client else None, db=db,
    )


@router.post("/{user_id}/reset-password")
async def trigger_password_reset(
    user_id: uuid.UUID,
    request: Request,
    admin: User = Depends(require_permission("users.view")),
    db: AsyncSession = Depends(get_db),
):
    """Admin triggers a password reset for the user — creates a one-time
    token + sends them the reset email. Plain password is never returned
    or stored anywhere (hashed at rest). 2026-06-01 #5."""
    return await user_service.trigger_password_reset(
        user_id=user_id, admin_id=admin.id,
        ip_address=request.client.host if request.client else None, db=db,
    )


class SetPasswordBody(BaseModel):
    # Optional — leave blank to auto-generate a strong one.
    password: str | None = None


@router.post("/{user_id}/set-password")
async def set_password(
    user_id: uuid.UUID,
    body: SetPasswordBody,
    request: Request,
    admin: User = Depends(require_permission("users.set_password")),
    db: AsyncSession = Depends(get_db),
):
    """Admin SETS a password for the user and SEES it (client 2026-06-16).
    The old password can never be shown (bcrypt at rest); this sets a known
    one — provided or auto-generated — and returns it once so the admin can
    hand it to the user. Revokes the user's existing sessions."""
    return await user_service.set_password_by_admin(
        user_id=user_id, admin_id=admin.id, new_password=body.password,
        ip_address=request.client.host if request.client else None, db=db,
    )


@router.get("/{user_id}/sessions")
async def list_user_sessions(
    user_id: uuid.UUID,
    admin: User = Depends(require_permission("users.view")),
    db: AsyncSession = Depends(get_db),
):
    """Active login sessions for this user — IP / user-agent / created /
    expires. Admin uses this to spot suspicious sessions + revoke."""
    return await user_service.list_user_sessions(user_id=user_id, db=db)


@router.delete("/{user_id}/sessions/{session_id}")
async def revoke_user_session(
    user_id: uuid.UUID,
    session_id: uuid.UUID,
    request: Request,
    admin: User = Depends(require_permission("users.view")),
    db: AsyncSession = Depends(get_db),
):
    return await user_service.revoke_user_session(
        user_id=user_id, session_id=session_id, admin_id=admin.id,
        ip_address=request.client.host if request.client else None, db=db,
    )


@router.post("/{user_id}/sessions/revoke-all")
async def revoke_all_user_sessions(
    user_id: uuid.UUID,
    request: Request,
    admin: User = Depends(require_permission("users.view")),
    db: AsyncSession = Depends(get_db),
):
    return await user_service.revoke_all_user_sessions(
        user_id=user_id, admin_id=admin.id,
        ip_address=request.client.host if request.client else None, db=db,
    )


@router.delete("/{user_id}")
async def delete_user(
    user_id: uuid.UUID,
    request: Request,
    # Irreversible destruction of a user + their entire financial ledger.
    # Dedicated permission held by no employee role → super_admin only
    # (audit H2; was wrongly gated on the finance 'users.add_fund').
    admin: User = Depends(require_permission("users.delete")),
    db: AsyncSession = Depends(get_db),
):
    """Permanently delete a user. Closes all open positions/orders, deletes
    trading accounts, copy-trade allocations, copy trades, deposits, withdrawals,
    transactions, referrals, IB profile, and finally the user row. Cannot be
    undone."""
    # Safety net: a complex user (master trader / IB with many relationships)
    # can hit a FK on a child table the service doesn't yet clean up. That used
    # to surface as a raw 500 ("Internal server error"). Catch any DB error,
    # roll back, and return a clear 409 naming the blocking constraint so the
    # admin (and we) know exactly which table to handle next.
    try:
        return await user_service.delete_user(
            user_id=user_id, admin_id=admin.id,
            ip_address=request.client.host if request.client else None, db=db,
        )
    except HTTPException:
        raise  # clean 404 / 409 the service already raised — pass through
    except Exception as e:
        # Broadened from (IntegrityError, DBAPIError): once a delete in the
        # service fails, the transaction is aborted and the NEXT statement can
        # raise a SQLAlchemy PendingRollbackError / InvalidRequestError — NOT a
        # DBAPIError — which escaped as a raw 500. Catch everything, roll back,
        # and return a clear 409 (client 2026-06-20).
        try:
            await db.rollback()
        except Exception:
            pass
        orig = getattr(e, "orig", e)
        raise HTTPException(
            status_code=409,
            detail=(
                f"Cannot permanently delete this user — a record still references them ({orig}). "
                "Use Soft Delete to disable the account while keeping records."
            ),
        )
