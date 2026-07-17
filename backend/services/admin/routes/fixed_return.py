"""Admin endpoints for the AI-POWERED STAKING PROGRAM product.

Two surfaces:
  - Early-withdrawal approval queue — client request 2026-06-01.
    Trader files a request → lock parks in ``early_pending`` → admin
    either approves (credits payout, lock → withdrawn_early) or rejects
    (lock reverts to active).
  - Per-user rate override — admin stamps a custom rate matrix on one
    trader's User row so they see a different ladder than everyone
    else. Same shape as the global ``fixed_return_rates``.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies import get_current_admin, require_permission
from packages.common.src.database import get_db
from packages.common.src.models import User

from services import fixed_return_service


router = APIRouter(prefix="/fixed-return", tags=["Admin · AI-POWERED STAKING PROGRAM"])


# ─── Early-withdrawal approval queue ─────────────────────────────────

class RejectRequest(BaseModel):
    reason: str | None = Field(default=None, max_length=240)


@router.get("/pending")
async def list_pending(
    kind: str = "early",
    _admin: dict = Depends(require_permission("fixed_return.view")),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Approval queue. kind='early' → early-withdrawal requests;
    kind='principal' → matured principal-withdrawal claims."""
    return await fixed_return_service.list_pending(db, kind=kind)


@router.post("/{lock_id}/approve")
async def approve_early(
    lock_id: UUID,
    # Credits a payout — gate behind fixed_return.manage (no employee
    # role holds it → super_admin only) (audit M2).
    _admin: dict = Depends(require_permission("fixed_return.manage")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    return await fixed_return_service.approve(lock_id, db)


@router.post("/{lock_id}/reject")
async def reject_early(
    lock_id: UUID,
    req: RejectRequest,
    _admin: dict = Depends(require_permission("fixed_return.manage")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    return await fixed_return_service.reject(lock_id, db, reason=req.reason)


# ─── Per-user rate override ──────────────────────────────────────────

class RateOverrideRequest(BaseModel):
    # Same shape as fixed_return_rates.rate_matrix_pct — 2-D array of
    # percentages. None / empty list clears the override (back to global).
    rate_matrix_pct: list[list[float]] | None = None


@router.get("/users/{user_id}/rate-override")
async def get_rate_override(
    user_id: UUID,
    _admin: dict = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    row = (await db.execute(
        select(User.fixed_return_rate_override).where(User.id == user_id)
    )).first()
    if row is None:
        raise HTTPException(status_code=404, detail="User not found")
    return {"rate_override": row[0]}


class GrantLockRequest(BaseModel):
    # Principal to lock (USD). Required.
    principal: float = Field(..., gt=0)
    # Tenure cadence label — must match one of the global tenures
    # (Month / Quarter / Half-Year / Year / 2 Year).
    tenure_label: str = Field(..., min_length=1, max_length=40)
    # One-off rate% pin — overrides the matrix cell for this lock only.
    # Leave null to use the resolved matrix rate (which already honours
    # the per-user override if set).
    rate_pct_override: float | None = Field(default=None, ge=0)
    # One-off lock duration in calendar months — overrides the global
    # `fixed_return_lock_months`. Leave null to use the global default.
    lock_months_override: int | None = Field(default=None, ge=1, le=240)
    # 'user_wallet' (default): debit the user's main_wallet_balance.
    # 'admin_grant': broker-funded promo — no debit.
    source: str = Field(default="user_wallet")
    # Free-text note recorded on the Transaction so the ledger explains
    # why the admin granted this position.
    note: str | None = Field(default=None, max_length=240)


@router.post("/users/{user_id}/grant")
async def grant_lock(
    user_id: UUID,
    body: GrantLockRequest,
    # Debits a user wallet / creates a paying financial product — gate
    # behind fixed_return.manage → super_admin only (audit M2).
    _admin: dict = Depends(require_permission("fixed_return.manage")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Admin creates a AI-POWERED STAKING PROGRAM lock for one user with custom terms.

    Use cases the client called out:
      • Set up a specific user with a promotional rate that isn't on
        the global ladder.
      • Push a short-tenure welcome lock (lock_months_override=3) for
        a new VIP without changing global policy.
      • Broker-funded grants where the principal comes from a promo
        budget (source='admin_grant').
    """
    return await fixed_return_service.admin_grant_lock(
        user_id=user_id,
        principal=Decimal(str(body.principal)),
        tenure_label=body.tenure_label,
        db=db,
        rate_pct_override=(
            Decimal(str(body.rate_pct_override))
            if body.rate_pct_override is not None
            else None
        ),
        lock_months_override=body.lock_months_override,
        source=body.source,
        note=body.note,
    )


class FRBonusRequest(BaseModel):
    # "percent" = value% of the user's active locked principal; "fixed" = flat USD.
    mode: str = Field("fixed", pattern="^(percent|fixed)$")
    value: float = Field(..., gt=0)


@router.post("/users/{user_id}/bonus")
async def grant_fixed_return_bonus(
    user_id: UUID,
    body: FRBonusRequest,
    admin: User = Depends(require_permission("fixed_return.manage")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Special bonus for a Fixed-Return holder — a % of their active locked
    principal or a flat amount — credited to their main wallet."""
    return await fixed_return_service.grant_bonus(
        user_id=user_id, mode=body.mode, value=body.value, admin_id=admin.id, db=db,
    )


@router.put("/users/{user_id}/rate-override")
async def set_rate_override(
    user_id: UUID,
    body: RateOverrideRequest,
    # Changes the payout rate ladder for a user — gate behind
    # fixed_return.manage → super_admin only (audit M2).
    _admin: dict = Depends(require_permission("fixed_return.manage")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    user = (await db.execute(
        select(User).where(User.id == user_id).with_for_update()
    )).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    matrix = body.rate_matrix_pct
    if matrix is None or len(matrix) == 0:
        user.fixed_return_rate_override = None
    else:
        # Validate it's a 2-D numeric grid; the matching against the
        # global tiers/tenures happens at read time so admin can stamp
        # the override BEFORE re-shaping global.
        for row in matrix:
            if not isinstance(row, list):
                raise HTTPException(status_code=400, detail="rate_matrix_pct must be a 2-D array")
            for cell in row:
                if not isinstance(cell, (int, float)):
                    raise HTTPException(
                        status_code=400, detail="rate_matrix_pct cells must be numbers",
                    )
        user.fixed_return_rate_override = {"rate_matrix_pct": matrix}

    await db.commit()
    return {"rate_override": user.fixed_return_rate_override}
