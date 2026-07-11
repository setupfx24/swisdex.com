import uuid
from datetime import datetime, time, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.database import get_db
from dependencies import require_permission
from packages.common.src.models import User
from packages.common.src.admin_schemas import RejectRequest
from services import deposit_service
from services import deposit_request_service
from services import payment_method_service

router = APIRouter(prefix="/finance", tags=["Finance"])


@router.get("/payment-methods")
async def list_payment_methods(
    admin: User = Depends(require_permission("deposits.view")),
    db: AsyncSession = Depends(get_db),
):
    return await payment_method_service.list_all(db)


@router.post("/payment-methods")
async def create_payment_method(
    body: dict,
    request: Request,
    admin: User = Depends(require_permission("config.update")),
    db: AsyncSession = Depends(get_db),
):
    return await payment_method_service.create(
        body, admin.id, request.client.host if request.client else None, db)


@router.put("/payment-methods/{method_id}")
async def update_payment_method(
    method_id: uuid.UUID,
    body: dict,
    request: Request,
    admin: User = Depends(require_permission("config.update")),
    db: AsyncSession = Depends(get_db),
):
    return await payment_method_service.update(
        method_id, body, admin.id, request.client.host if request.client else None, db)


@router.delete("/payment-methods/{method_id}")
async def delete_payment_method(
    method_id: uuid.UUID,
    request: Request,
    admin: User = Depends(require_permission("config.update")),
    db: AsyncSession = Depends(get_db),
):
    return await payment_method_service.delete(
        method_id, admin.id, request.client.host if request.client else None, db)


class ApproveDepositReqBody(BaseModel):
    admin_qr: str | None = None        # base64 data-URL of the QR image
    admin_bank_text: str | None = None
    admin_upi: str | None = None
    admin_note: str | None = None


class RejectDepositReqBody(BaseModel):
    admin_note: str | None = None


@router.get("/deposit-requests")
async def list_deposit_requests(
    status: str = Query(None),
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    admin: User = Depends(require_permission("deposits.view")),
    db: AsyncSession = Depends(get_db),
):
    return await deposit_request_service.list_requests(status, page, per_page, db)


@router.post("/deposit-requests/{req_id}/approve")
async def approve_deposit_request(
    req_id: uuid.UUID,
    body: ApproveDepositReqBody,
    request: Request,
    admin: User = Depends(require_permission("deposits.approve")),
    db: AsyncSession = Depends(get_db),
):
    return await deposit_request_service.approve_request(
        req_id, admin.id,
        admin_qr=body.admin_qr, admin_bank_text=body.admin_bank_text,
        admin_upi=body.admin_upi, admin_note=body.admin_note,
        ip_address=request.client.host if request.client else None, db=db,
    )


@router.post("/deposit-requests/{req_id}/reject")
async def reject_deposit_request(
    req_id: uuid.UUID,
    body: RejectDepositReqBody,
    request: Request,
    admin: User = Depends(require_permission("deposits.reject")),
    db: AsyncSession = Depends(get_db),
):
    return await deposit_request_service.reject_request(
        req_id, admin.id, admin_note=body.admin_note,
        ip_address=request.client.host if request.client else None, db=db,
    )


def _date_bound(value: str | None, *, end_of_day: bool):
    """Parse YYYY-MM-DD → UTC datetime (start or end of day). None passes through."""
    if not value:
        return None
    try:
        d = datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        return None
    return datetime.combine(d, time.max if end_of_day else time.min, tzinfo=timezone.utc)


@router.get("/deposits/pending")
async def list_pending_deposits(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    admin: User = Depends(require_permission("deposits.view")),
    db: AsyncSession = Depends(get_db),
):
    return await deposit_service.list_pending_deposits(page=page, per_page=per_page, db=db)


@router.get("/withdrawals/pending")
async def list_pending_withdrawals(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    admin: User = Depends(require_permission("withdrawals.view")),
    db: AsyncSession = Depends(get_db),
):
    return await deposit_service.list_pending_withdrawals(page=page, per_page=per_page, db=db)


@router.get("/deposits")
async def list_all_deposits(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    status: str = Query(None),
    start_date: str | None = Query(None),
    end_date: str | None = Query(None),
    admin: User = Depends(require_permission("deposits.view")),
    db: AsyncSession = Depends(get_db),
):
    return await deposit_service.list_all_deposits(
        page=page, per_page=per_page, status=status, db=db,
        start_date=_date_bound(start_date, end_of_day=False),
        end_date=_date_bound(end_date, end_of_day=True),
    )


@router.get("/withdrawals")
async def list_all_withdrawals(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    status: str = Query(None),
    start_date: str | None = Query(None),
    end_date: str | None = Query(None),
    admin: User = Depends(require_permission("withdrawals.view")),
    db: AsyncSession = Depends(get_db),
):
    return await deposit_service.list_all_withdrawals(
        page=page, per_page=per_page, status=status, db=db,
        start_date=_date_bound(start_date, end_of_day=False),
        end_date=_date_bound(end_date, end_of_day=True),
    )


class ApproveDepositRequest(BaseModel):
    # Optional — when set, credits this admin-verified amount instead of
    # the user-claimed deposit.amount (audit H1). Leave null to approve
    # the user-submitted amount as-is (e.g. auto-reconciled crypto).
    verified_amount: float | None = None


@router.post("/deposits/{deposit_id}/approve")
async def approve_deposit(
    deposit_id: uuid.UUID,
    request: Request,
    body: ApproveDepositRequest | None = None,
    admin: User = Depends(require_permission("deposits.approve")),
    db: AsyncSession = Depends(get_db),
):
    vamt = (
        Decimal(str(body.verified_amount))
        if body is not None and body.verified_amount is not None
        else None
    )
    return await deposit_service.approve_deposit(
        deposit_id=deposit_id, admin_id=admin.id,
        ip_address=request.client.host if request.client else None, db=db,
        verified_amount=vamt,
    )


@router.post("/deposits/{deposit_id}/reject")
async def reject_deposit(
    deposit_id: uuid.UUID,
    body: RejectRequest,
    request: Request,
    admin: User = Depends(require_permission("deposits.reject")),
    db: AsyncSession = Depends(get_db),
):
    return await deposit_service.reject_deposit(
        deposit_id=deposit_id, reason=body.reason, admin_id=admin.id,
        ip_address=request.client.host if request.client else None, db=db,
    )


# ─── Bonus request grant / deny (trader typed a promo code at deposit) ──

class _BonusGrantBody(BaseModel):
    amount: Decimal
    description: str | None = None


@router.post("/deposits/{deposit_id}/grant-bonus")
async def grant_deposit_bonus(
    deposit_id: uuid.UUID,
    body: _BonusGrantBody,
    request: Request,
    admin: User = Depends(require_permission("deposits.approve")),
    db: AsyncSession = Depends(get_db),
):
    """Credit a custom bonus amount for an open bonus request. Idempotent
    against double-clicks. Re-using deposits.approve permission so the
    same admin who can approve the deposit can decide its bonus."""
    return await deposit_service.grant_deposit_bonus(
        deposit_id=deposit_id, amount=body.amount, description=body.description,
        admin_id=admin.id,
        ip_address=request.client.host if request.client else None, db=db,
    )


@router.post("/deposits/{deposit_id}/deny-bonus")
async def deny_deposit_bonus(
    deposit_id: uuid.UUID,
    body: RejectRequest,
    request: Request,
    admin: User = Depends(require_permission("deposits.reject")),
    db: AsyncSession = Depends(get_db),
):
    """Mark the bonus request denied — no money moves. Trader gets a
    notification with the reason."""
    return await deposit_service.deny_deposit_bonus(
        deposit_id=deposit_id, reason=body.reason, admin_id=admin.id,
        ip_address=request.client.host if request.client else None, db=db,
    )


@router.post("/withdrawals/{withdrawal_id}/approve")
async def approve_withdrawal(
    withdrawal_id: uuid.UUID,
    request: Request,
    admin: User = Depends(require_permission("withdrawals.approve")),
    db: AsyncSession = Depends(get_db),
):
    return await deposit_service.approve_withdrawal(
        withdrawal_id=withdrawal_id, admin_id=admin.id,
        ip_address=request.client.host if request.client else None, db=db,
    )


@router.post("/withdrawals/{withdrawal_id}/reject")
async def reject_withdrawal(
    withdrawal_id: uuid.UUID,
    body: RejectRequest,
    request: Request,
    admin: User = Depends(require_permission("withdrawals.reject")),
    db: AsyncSession = Depends(get_db),
):
    return await deposit_service.reject_withdrawal(
        withdrawal_id=withdrawal_id, reason=body.reason, admin_id=admin.id,
        ip_address=request.client.host if request.client else None, db=db,
    )


@router.get("/deposits/{deposit_id}/screenshot")
async def download_deposit_screenshot(
    deposit_id: uuid.UUID,
    admin: User = Depends(require_permission("deposits.view")),
    db: AsyncSession = Depends(get_db),
):
    return await deposit_service.download_deposit_screenshot(deposit_id=deposit_id, db=db)


@router.get("/withdrawals/{withdrawal_id}/payout-qr")
async def download_withdrawal_payout_qr(
    withdrawal_id: uuid.UUID,
    admin: User = Depends(require_permission("withdrawals.view")),
    db: AsyncSession = Depends(get_db),
):
    return await deposit_service.download_withdrawal_payout_qr(withdrawal_id=withdrawal_id, db=db)
