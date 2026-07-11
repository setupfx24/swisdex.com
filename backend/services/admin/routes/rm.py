"""Relationship Manager (RM) routes.

Two audiences share this router:
  • The RM themselves (role 'rm', permission rm.view / rm.request) — list
    their assigned users + their own requests, and raise a new funding
    request with a proof file.
  • Admins (rm.manage / rm.assign) — review the queue, view proofs, run the
    two-admin approve → credit flow, reject, and assign users to RMs.
"""
import uuid
from decimal import Decimal

from fastapi import APIRouter, Depends, Query, Request, UploadFile, File, Form
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.database import get_db
from dependencies import require_permission
from packages.common.src.models import User
from services import rm_service

router = APIRouter(prefix="/rm", tags=["Relationship Managers"])


# ── RM-facing ────────────────────────────────────────────────────────

@router.get("/my-users")
async def my_users(
    admin: User = Depends(require_permission("rm.view")),
    db: AsyncSession = Depends(get_db),
):
    return await rm_service.list_my_users(rm_id=admin.id, db=db)


@router.get("/my-requests")
async def my_requests(
    admin: User = Depends(require_permission("rm.view")),
    db: AsyncSession = Depends(get_db),
):
    return await rm_service.list_my_requests(rm_id=admin.id, db=db)


@router.post("/requests")
async def create_request(
    user_id: uuid.UUID = Form(...),
    amount: Decimal = Form(...),
    method: str | None = Form(default=None),
    note: str | None = Form(default=None),
    file: UploadFile = File(...),
    admin: User = Depends(require_permission("rm.request")),
    db: AsyncSession = Depends(get_db),
):
    """RM raises a funding request (with proof) for one of their users."""
    return await rm_service.create_funding_request(
        rm_id=admin.id, user_id=user_id, amount=amount,
        method=method, note=note, file=file, db=db,
    )


# ── Admin-facing ─────────────────────────────────────────────────────

class RejectBody(BaseModel):
    reason: str


@router.get("/requests")
async def list_requests(
    status: str | None = Query(None),
    admin: User = Depends(require_permission("rm.manage")),
    db: AsyncSession = Depends(get_db),
):
    return await rm_service.list_requests(status=status, db=db)


@router.get("/requests/{req_id}/proof")
async def request_proof(
    req_id: uuid.UUID,
    admin: User = Depends(require_permission("rm.manage")),
    db: AsyncSession = Depends(get_db),
):
    return await rm_service.get_proof_file(req_id=req_id, db=db)


@router.post("/requests/{req_id}/approve")
async def approve_request(
    req_id: uuid.UUID,
    request: Request,
    admin: User = Depends(require_permission("rm.manage")),
    db: AsyncSession = Depends(get_db),
):
    return await rm_service.approve_request(
        req_id=req_id, admin_id=admin.id,
        ip_address=request.client.host if request.client else None, db=db,
    )


@router.post("/requests/{req_id}/credit")
async def credit_request(
    req_id: uuid.UUID,
    request: Request,
    admin: User = Depends(require_permission("rm.manage")),
    db: AsyncSession = Depends(get_db),
):
    """Second admin releases the funds. Enforced to be a different admin than
    the one who approved the proof."""
    return await rm_service.credit_request(
        req_id=req_id, admin_id=admin.id,
        ip_address=request.client.host if request.client else None, db=db,
    )


@router.post("/requests/{req_id}/reject")
async def reject_request(
    req_id: uuid.UUID,
    body: RejectBody,
    request: Request,
    admin: User = Depends(require_permission("rm.manage")),
    db: AsyncSession = Depends(get_db),
):
    return await rm_service.reject_request(
        req_id=req_id, admin_id=admin.id, reason=body.reason,
        ip_address=request.client.host if request.client else None, db=db,
    )


@router.get("/manual-requests")
async def list_manual_requests(
    status: str | None = None,
    admin: User = Depends(require_permission("rm.manage")),
    db: AsyncSession = Depends(get_db),
):
    """Trader-submitted 'Request to RM' deposit/withdraw requests (mail-to-RM)."""
    return await rm_service.list_manual_requests(db=db, status_filter=status)


class ManualStatusBody(BaseModel):
    status: str


@router.post("/manual-requests/{req_id}/status")
async def set_manual_request_status(
    req_id: uuid.UUID,
    body: ManualStatusBody,
    request: Request,
    admin: User = Depends(require_permission("rm.manage")),
    db: AsyncSession = Depends(get_db),
):
    return await rm_service.set_manual_request_status(
        req_id=req_id, status=body.status, admin_id=admin.id,
        ip_address=request.client.host if request.client else None, db=db,
    )


@router.get("/list")
async def list_rms(
    admin: User = Depends(require_permission("rm.assign")),
    db: AsyncSession = Depends(get_db),
):
    return await rm_service.list_rms(db=db)


class AssignBody(BaseModel):
    rm_id: uuid.UUID | None = None


@router.post("/assign/{user_id}")
async def assign_user(
    user_id: uuid.UUID,
    body: AssignBody,
    request: Request,
    admin: User = Depends(require_permission("rm.assign")),
    db: AsyncSession = Depends(get_db),
):
    """Assign (or, with rm_id=null, unassign) a user to an RM."""
    return await rm_service.assign_user(
        user_id=user_id, rm_id=body.rm_id, admin_id=admin.id,
        ip_address=request.client.host if request.client else None, db=db,
    )
