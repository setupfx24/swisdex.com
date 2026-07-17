"""Rewards API — XP / Artha Coins / Power Score, missions, store, leaderboard.

Mission progress is bumped automatically by the platform (e.g. trade close).
This router exposes read endpoints + claim/redeem write endpoints.
"""
from __future__ import annotations

from uuid import UUID
from typing import Any, Optional

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.auth import get_current_user
from packages.common.src.database import get_db

from ..services import rewards_service

router = APIRouter()


@router.get("/state")
async def state(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    s = await rewards_service.get_state(db, current_user["user_id"])
    await db.commit()  # in case _get_or_create_state inserted a new row
    return s


@router.get("/missions")
async def missions(
    period: str = "daily",
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    if period not in ("daily", "weekly", "bonus", "flash", "achievement"):
        period = "daily"
    return await rewards_service.list_missions(db, current_user["user_id"], period)


@router.post("/streak/check-in")
async def streak_check_in(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Idempotent per UTC day. Bumps the daily-login streak; awards a flat XP
    nudge each call and a bigger bonus every 7 consecutive days."""
    result = await rewards_service.daily_login_check_in(db, current_user["user_id"])
    await db.commit()
    return result


@router.post("/missions/{mission_id}/claim")
async def claim_mission(
    mission_id: UUID,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    return await rewards_service.claim_mission(db, current_user["user_id"], mission_id)


@router.get("/store")
async def store(
    category: Optional[str] = None,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    return await rewards_service.list_store(db, category)


@router.post("/store/{item_id}/redeem")
async def redeem(
    item_id: UUID,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    return await rewards_service.redeem(db, current_user["user_id"], item_id)


# ── Referral staking reward campaigns (client 2026-07-11) ──────────────────

@router.get("/campaigns")
async def my_reward_campaigns(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Admin reward offers + MY qualifying referred-staking progress."""
    from ..services import reward_campaign_service
    return await reward_campaign_service.my_campaigns(db, current_user["user_id"])


@router.post("/campaigns/{campaign_id}/claim")
async def claim_reward_campaign(
    campaign_id: UUID,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Claim an ended offer — credits the reward to the main wallet."""
    from ..services import reward_campaign_service
    return await reward_campaign_service.claim(db, current_user["user_id"], campaign_id)


@router.get("/leaderboard")
async def leaderboard(
    kind: str = "traders",
    limit: int = 10,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    if kind not in ("traders", "earners"):
        kind = "traders"
    limit = max(1, min(int(limit), 50))
    return await rewards_service.leaderboard(db, kind=kind, limit=limit)
