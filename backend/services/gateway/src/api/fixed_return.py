"""AI-POWERED STAKING PROGRAM API — config (rates + fee), user locks, withdrawals."""
from __future__ import annotations

from decimal import Decimal
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.auth import get_current_user
from packages.common.src.database import get_db

from ..services import fixed_return_service

router = APIRouter()


class CreateLockRequest(BaseModel):
    principal: Decimal = Field(gt=0)
    tenure_label: str
    # Set true once the user has accepted the "your bonus will be forfeited"
    # confirm popup (client 2026-06-30). Without it, a lock that would leave the
    # wallet below the bonus amount is rejected with 409 so the UI can prompt.
    acknowledge_bonus_forfeit: bool = False


@router.get("/config")
async def get_config(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Rate matrix + early-withdrawal fee%. Passes the caller's user id
    so a per-user rate override (admin-set) shadows the global ladder
    transparently — same response shape, different cell values."""
    return await fixed_return_service.get_config(
        user_id=current_user["user_id"], db=db,
    )


@router.get("/public-config")
async def get_public_config(
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """PUBLIC (no auth) rate matrix — powers the marketing-site Fixed
    Return calculator so the website always shows the SAME live rates the
    admin configures (no hard-coded table that drifts). Returns only the
    GLOBAL ladder (no per-user override, no user data)."""
    return await fixed_return_service.get_config(user_id=None, db=db)


@router.get("/locks")
async def list_locks(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    return await fixed_return_service.list_locks(current_user["user_id"], db)


@router.post("/lock")
async def create_lock(
    req: CreateLockRequest,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    return await fixed_return_service.create_lock(
        current_user["user_id"], req.principal, req.tenure_label, db,
        acknowledge_bonus_forfeit=req.acknowledge_bonus_forfeit,
    )


@router.post("/locks/{lock_id}/withdraw")
async def withdraw_lock(
    lock_id: UUID,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    return await fixed_return_service.withdraw_lock(
        lock_id, current_user["user_id"], db,
    )


@router.post("/locks/{lock_id}/withdraw-interest")
async def withdraw_interest(
    lock_id: UUID,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Withdraw only the accrued interest to the main wallet — no admin
    approval (it's the user's already-earned interest). Principal stays locked."""
    return await fixed_return_service.withdraw_interest(
        lock_id, current_user["user_id"], db,
    )


class UpgradeLockRequest(BaseModel):
    new_tenure_label: str


@router.get("/locks/{lock_id}/upgrade-options")
async def upgrade_options(
    lock_id: UUID,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Higher tenures this plan can upgrade to + the top-up cost and the
    elapsed interest that will be credited (powers the upgrade modal)."""
    return await fixed_return_service.upgrade_options(
        lock_id, current_user["user_id"], db,
    )


@router.post("/locks/{lock_id}/upgrade")
async def upgrade_lock(
    lock_id: UUID,
    req: UpgradeLockRequest,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Upgrade an active plan to a higher tenure: credit elapsed interest,
    close the plan, auto-debit the top-up, open the new bigger plan."""
    return await fixed_return_service.upgrade_lock(
        lock_id, current_user["user_id"], req.new_tenure_label, db,
    )
