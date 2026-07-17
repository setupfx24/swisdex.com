"""Admin Reward Campaigns (client 2026-07-11).

CRUD + monitoring for the referral staking reward offers:
  * Create an offer: title, window, tiered %-of-volume ranges.
  * See per-offer stats: qualifying referrers, volume brought, projected
    liability, and claims already paid.
Existing XP/AC/PS rewards engine is untouched — this is a separate system.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.database import get_db
from packages.common.src.models import (
    FixedReturnLock, RewardCampaign, RewardCampaignClaim, RewardCampaignTier, User,
)
from dependencies import require_permission, write_audit_log

router = APIRouter(prefix="/reward-campaigns", tags=["Reward Campaigns"])


class TierIn(BaseModel):
    min_amount: float = Field(..., ge=0)
    max_amount: Optional[float] = Field(None, gt=0)
    # Exactly ONE of the two (client 2026-07-13): percent of the whole
    # qualifying volume, or a flat USD amount.
    reward_pct: Optional[float] = Field(None, gt=0, le=100)
    reward_amount: Optional[float] = Field(None, gt=0)


class CampaignIn(BaseModel):
    title: str = Field(..., min_length=1, max_length=120)
    description: Optional[str] = None
    starts_at: datetime
    ends_at: datetime
    tiers: list[TierIn] = Field(..., min_length=1)


def _validate_tiers(tiers: list[TierIn]) -> None:
    for t in tiers:
        if t.max_amount is not None and t.max_amount <= t.min_amount:
            raise HTTPException(status_code=400, detail="Tier max must be greater than min")
        if (t.reward_pct is None) == (t.reward_amount is None):
            raise HTTPException(
                status_code=400,
                detail="Each tier needs either a percent OR a fixed amount (not both, not neither)",
            )


async def _campaign_out(db: AsyncSession, c: RewardCampaign) -> dict:
    tiers = (await db.execute(
        select(RewardCampaignTier)
        .where(RewardCampaignTier.campaign_id == c.id)
        .order_by(RewardCampaignTier.min_amount)
    )).scalars().all()
    # Qualifying volume + distinct referrer count for the window: locks made
    # in-window by in-window signups that HAVE a referrer.
    stats_row = (await db.execute(
        select(
            func.coalesce(func.sum(FixedReturnLock.principal), 0),
            func.count(func.distinct(User.referred_by_user_id)),
        )
        .select_from(FixedReturnLock)
        .join(User, User.id == FixedReturnLock.user_id)
        .where(
            User.referred_by_user_id.isnot(None),
            User.created_at >= c.starts_at,
            User.created_at <= c.ends_at,
            FixedReturnLock.locked_at >= c.starts_at,
            FixedReturnLock.locked_at <= c.ends_at,
        )
    )).first()
    claims_row = (await db.execute(
        select(func.count(RewardCampaignClaim.id), func.coalesce(func.sum(RewardCampaignClaim.reward_amount), 0))
        .where(RewardCampaignClaim.campaign_id == c.id)
    )).first()
    now = datetime.now(timezone.utc)
    ends = c.ends_at if c.ends_at.tzinfo else c.ends_at.replace(tzinfo=timezone.utc)
    starts = c.starts_at if c.starts_at.tzinfo else c.starts_at.replace(tzinfo=timezone.utc)
    return {
        "id": str(c.id),
        "title": c.title,
        "description": c.description,
        "starts_at": c.starts_at.isoformat(),
        "ends_at": c.ends_at.isoformat(),
        "is_active": bool(c.is_active),
        "status": "upcoming" if now < starts else ("ended" if now >= ends else "running"),
        "tiers": [
            {
                "min_amount": float(t.min_amount),
                "max_amount": float(t.max_amount) if t.max_amount is not None else None,
                "reward_pct": float(t.reward_pct) if t.reward_pct is not None else None,
                "reward_amount": float(t.reward_amount) if t.reward_amount is not None else None,
            } for t in tiers
        ],
        "stats": {
            "qualifying_volume": float(stats_row[0] or 0),
            "referrers": int(stats_row[1] or 0),
            "claims_paid": int(claims_row[0] or 0),
            "claims_paid_amount": float(claims_row[1] or 0),
        },
    }


@router.get("")
async def list_campaigns(
    admin: User = Depends(require_permission("bonus.view")),
    db: AsyncSession = Depends(get_db),
):
    rows = (await db.execute(
        select(RewardCampaign).order_by(RewardCampaign.created_at.desc()).limit(50)
    )).scalars().all()
    return {"items": [await _campaign_out(db, c) for c in rows]}


@router.post("")
async def create_campaign(
    body: CampaignIn,
    request: Request,
    admin: User = Depends(require_permission("bonus.create")),
    db: AsyncSession = Depends(get_db),
):
    if body.ends_at <= body.starts_at:
        raise HTTPException(status_code=400, detail="End must be after start")
    _validate_tiers(body.tiers)
    c = RewardCampaign(
        id=uuid.uuid4(),
        title=body.title.strip(),
        description=(body.description or "").strip() or None,
        starts_at=body.starts_at,
        ends_at=body.ends_at,
        is_active=True,
        created_by=admin.id,
    )
    db.add(c)
    for t in body.tiers:
        db.add(RewardCampaignTier(
            campaign_id=c.id,
            min_amount=Decimal(str(t.min_amount)),
            max_amount=Decimal(str(t.max_amount)) if t.max_amount is not None else None,
            reward_pct=Decimal(str(t.reward_pct)) if t.reward_pct is not None else None,
            reward_amount=Decimal(str(t.reward_amount)) if t.reward_amount is not None else None,
        ))
    await write_audit_log(
        db, admin.id, "create_reward_campaign", "reward_campaign", c.id,
        new_values={"title": c.title, "starts_at": str(body.starts_at), "ends_at": str(body.ends_at)},
        ip_address=request.client.host if request.client else None,
    )
    await db.commit()
    return {"message": "Offer created", "id": str(c.id)}


@router.patch("/{campaign_id}")
async def toggle_campaign(
    campaign_id: uuid.UUID,
    body: dict,
    request: Request,
    admin: User = Depends(require_permission("bonus.update")),
    db: AsyncSession = Depends(get_db),
):
    """Currently supports {is_active: bool} — pause/unpause an offer."""
    c = (await db.execute(
        select(RewardCampaign).where(RewardCampaign.id == campaign_id)
    )).scalar_one_or_none()
    if c is None:
        raise HTTPException(status_code=404, detail="Offer not found")
    if "is_active" in body:
        c.is_active = bool(body["is_active"])
    await write_audit_log(
        db, admin.id, "update_reward_campaign", "reward_campaign", c.id,
        new_values={"is_active": bool(c.is_active)},
        ip_address=request.client.host if request.client else None,
    )
    await db.commit()
    return {"message": "Updated", "is_active": bool(c.is_active)}


@router.get("/{campaign_id}/leaderboard")
async def campaign_leaderboard(
    campaign_id: uuid.UUID,
    admin: User = Depends(require_permission("bonus.view")),
    db: AsyncSession = Depends(get_db),
):
    """Per-referrer qualifying volume for one offer, biggest first."""
    c = (await db.execute(
        select(RewardCampaign).where(RewardCampaign.id == campaign_id)
    )).scalar_one_or_none()
    if c is None:
        raise HTTPException(status_code=404, detail="Offer not found")
    referrer = User.__table__.alias("referrer")
    rows = (await db.execute(
        select(
            User.referred_by_user_id,
            referrer.c.email,
            referrer.c.first_name,
            referrer.c.last_name,
            func.coalesce(func.sum(FixedReturnLock.principal), 0).label("vol"),
            func.count(func.distinct(User.id)).label("referred_users"),
        )
        .select_from(FixedReturnLock)
        .join(User, User.id == FixedReturnLock.user_id)
        .join(referrer, referrer.c.id == User.referred_by_user_id)
        .where(
            User.referred_by_user_id.isnot(None),
            User.created_at >= c.starts_at,
            User.created_at <= c.ends_at,
            FixedReturnLock.locked_at >= c.starts_at,
            FixedReturnLock.locked_at <= c.ends_at,
        )
        .group_by(User.referred_by_user_id, referrer.c.email, referrer.c.first_name, referrer.c.last_name)
        .order_by(func.sum(FixedReturnLock.principal).desc())
        .limit(100)
    )).all()
    claims = (await db.execute(
        select(RewardCampaignClaim).where(RewardCampaignClaim.campaign_id == campaign_id)
    )).scalars().all()
    claimed_by = {cl.user_id: cl for cl in claims}
    return {
        "items": [
            {
                "user_id": str(r[0]),
                "name": " ".join(filter(None, [r[2], r[3]])).strip() or r[1],
                "email": r[1],
                "qualifying_volume": float(r[4]),
                "referred_users": int(r[5]),
                "claimed": r[0] in claimed_by,
                "claimed_amount": float(claimed_by[r[0]].reward_amount) if r[0] in claimed_by else None,
            }
            for r in rows
        ]
    }
