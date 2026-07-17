"""Referral staking reward campaigns (client 2026-07-11).

Admin-run, time-bound offers, separate from the XP/AC/PS engine:
  * A campaign has a date window + tiered %-of-volume payouts.
  * Qualifying volume for a referrer = SUM(principal) of AI Powered Staking
    locks made DURING the window by users who (a) were referred by them
    (users.referred_by_user_id) and (b) SIGNED UP during the window —
    "sirf naye referred users" per client. Locks count when created; a later
    early-withdrawal does not un-count them (kept simple by design).
  * The total picks ONE tier (min <= total < max, max NULL = open-ended) and
    that tier's percent applies to the WHOLE total.
  * Claim opens only AFTER the campaign ends (so nobody claims early at a
    lower tier), pays once per (campaign, user), credits the main wallet,
    and logs a Transaction + PromotionalExpense for admin finance.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from decimal import Decimal
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.models import (
    FixedReturnLock, PromotionalExpense, RewardCampaign, RewardCampaignClaim,
    RewardCampaignTier, Transaction, User,
)

logger = logging.getLogger("reward_campaign_service")


def _tiers_out(tiers: list[RewardCampaignTier]) -> list[dict]:
    return [
        {
            "min_amount": float(t.min_amount),
            "max_amount": float(t.max_amount) if t.max_amount is not None else None,
            "reward_pct": float(t.reward_pct) if t.reward_pct is not None else None,
            "reward_amount": float(t.reward_amount) if getattr(t, "reward_amount", None) is not None else None,
        }
        for t in sorted(tiers, key=lambda x: Decimal(str(x.min_amount)))
    ]


def _tier_reward(tier: RewardCampaignTier, total: Decimal) -> Decimal:
    """A tier pays EITHER a fixed USD amount OR a percent of the whole
    qualifying total (client 2026-07-13)."""
    fixed = getattr(tier, "reward_amount", None)
    if fixed is not None:
        return Decimal(str(fixed)).quantize(Decimal("0.01"))
    return (total * Decimal(str(tier.reward_pct or 0)) / Decimal("100")).quantize(Decimal("0.01"))


def _tier_for(tiers: list[RewardCampaignTier], total: Decimal) -> RewardCampaignTier | None:
    """Pick the bracket the total lands in. Brackets sorted by min; the last
    matching (highest) bracket wins so overlapping ranges behave sanely."""
    chosen = None
    for t in sorted(tiers, key=lambda x: Decimal(str(x.min_amount))):
        lo = Decimal(str(t.min_amount))
        hi = Decimal(str(t.max_amount)) if t.max_amount is not None else None
        if total >= lo and (hi is None or total < hi):
            chosen = t
    return chosen


async def _qualifying_total(db: AsyncSession, campaign: RewardCampaign, referrer_id) -> Decimal:
    """SUM of staking principal locked in-window by in-window signups referred
    by `referrer_id`."""
    total = (await db.execute(
        select(func.coalesce(func.sum(FixedReturnLock.principal), 0))
        .select_from(FixedReturnLock)
        .join(User, User.id == FixedReturnLock.user_id)
        .where(
            User.referred_by_user_id == referrer_id,
            User.id != referrer_id,
            User.created_at >= campaign.starts_at,
            User.created_at <= campaign.ends_at,
            FixedReturnLock.locked_at >= campaign.starts_at,
            FixedReturnLock.locked_at <= campaign.ends_at,
        )
    )).scalar() or 0
    return Decimal(str(total))


async def _campaign_tiers(db: AsyncSession, campaign_ids: list) -> dict:
    if not campaign_ids:
        return {}
    rows = (await db.execute(
        select(RewardCampaignTier).where(RewardCampaignTier.campaign_id.in_(campaign_ids))
    )).scalars().all()
    out: dict = {}
    for t in rows:
        out.setdefault(t.campaign_id, []).append(t)
    return out


async def my_campaigns(db: AsyncSession, user_id) -> list[dict]:
    """Active + recently-ended campaigns with THIS user's progress."""
    now = datetime.now(timezone.utc)
    campaigns = (await db.execute(
        select(RewardCampaign)
        .where(RewardCampaign.is_active.is_(True))
        .order_by(RewardCampaign.ends_at.desc())
        .limit(20)
    )).scalars().all()
    if not campaigns:
        return []
    tiers_by_c = await _campaign_tiers(db, [c.id for c in campaigns])
    claims = (await db.execute(
        select(RewardCampaignClaim).where(
            RewardCampaignClaim.user_id == user_id,
            RewardCampaignClaim.campaign_id.in_([c.id for c in campaigns]),
        )
    )).scalars().all()
    claim_by_c = {cl.campaign_id: cl for cl in claims}

    out = []
    for c in campaigns:
        tiers = tiers_by_c.get(c.id, [])
        total = await _qualifying_total(db, c, user_id)
        tier = _tier_for(tiers, total)
        projected = _tier_reward(tier, total) if tier else Decimal("0")
        claim = claim_by_c.get(c.id)
        ended = now >= (c.ends_at if c.ends_at.tzinfo else c.ends_at.replace(tzinfo=timezone.utc))
        started = now >= (c.starts_at if c.starts_at.tzinfo else c.starts_at.replace(tzinfo=timezone.utc))
        # Hide long-finished campaigns the user already claimed / never joined
        # (keep 30 days of history so claims stay visible).
        out.append({
            "id": str(c.id),
            "title": c.title,
            "description": c.description,
            "starts_at": c.starts_at.isoformat(),
            "ends_at": c.ends_at.isoformat(),
            "status": "upcoming" if not started else ("ended" if ended else "running"),
            "tiers": _tiers_out(tiers),
            "my_staked_total": float(total),
            "current_pct": float(tier.reward_pct) if tier and tier.reward_pct is not None else 0.0,
            "current_reward_amount": (
                float(tier.reward_amount)
                if tier and getattr(tier, "reward_amount", None) is not None else None
            ),
            "projected_reward": float(projected),
            "claimable": bool(ended and tier and projected > 0 and claim is None),
            "claimed": claim is not None,
            "claimed_amount": float(claim.reward_amount) if claim else None,
        })
    return out


async def claim(db: AsyncSession, user_id, campaign_id: UUID) -> dict:
    campaign = (await db.execute(
        select(RewardCampaign).where(
            RewardCampaign.id == campaign_id, RewardCampaign.is_active.is_(True)
        )
    )).scalar_one_or_none()
    if campaign is None:
        raise HTTPException(status_code=404, detail="Offer not found")
    now = datetime.now(timezone.utc)
    ends = campaign.ends_at if campaign.ends_at.tzinfo else campaign.ends_at.replace(tzinfo=timezone.utc)
    if now < ends:
        raise HTTPException(status_code=409, detail="Offer is still running — claim after it ends.")

    existing = (await db.execute(
        select(RewardCampaignClaim).where(
            RewardCampaignClaim.campaign_id == campaign.id,
            RewardCampaignClaim.user_id == user_id,
        )
    )).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(status_code=409, detail="Already claimed")

    tiers = (await db.execute(
        select(RewardCampaignTier).where(RewardCampaignTier.campaign_id == campaign.id)
    )).scalars().all()
    total = await _qualifying_total(db, campaign, user_id)
    tier = _tier_for(tiers, total)
    if tier is None:
        raise HTTPException(status_code=409, detail="Target not reached for this offer")
    reward = _tier_reward(tier, total)
    if reward <= 0:
        raise HTTPException(status_code=409, detail="Nothing to claim")
    reward_label = (
        f"${reward} flat" if getattr(tier, "reward_amount", None) is not None
        else f"{tier.reward_pct}% of ${total}"
    )

    user = (await db.execute(
        select(User).where(User.id == user_id).with_for_update()
    )).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    user.main_wallet_balance = Decimal(str(user.main_wallet_balance or 0)) + reward
    db.add(RewardCampaignClaim(
        campaign_id=campaign.id, user_id=user_id,
        staked_total=total,
        reward_pct=Decimal(str(tier.reward_pct)) if tier.reward_pct is not None else None,
        reward_amount=reward,
    ))
    db.add(Transaction(
        user_id=user_id,
        type="reward_campaign",
        amount=reward,
        balance_after=user.main_wallet_balance,
        reference_id=campaign.id,
        description=f"Reward offer '{campaign.title}' — {reward_label} referred staking",
    ))
    # Finance visibility: campaign payouts are promotional spend.
    db.add(PromotionalExpense(
        user_id=user_id,
        amount=reward,
        category="reward_campaign",
        note=f"Referral staking offer '{campaign.title}': {reward_label}",
    ))
    await db.commit()
    logger.info("reward campaign %s claimed by %s: $%s", campaign.id, user_id, reward)
    return {
        "reward_amount": float(reward),
        "staked_total": float(total),
        "reward_pct": float(tier.reward_pct) if tier.reward_pct is not None else None,
        "new_wallet_balance": float(user.main_wallet_balance),
    }
