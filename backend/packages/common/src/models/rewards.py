"""Rewards engine — XP / Artha Coins / Power Score, missions, store, audit."""
import uuid
from datetime import datetime, date
from decimal import Decimal

from sqlalchemy import (
    Column, String, Boolean, Integer, DateTime, Date, ForeignKey, Text, Numeric,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB

from ..database import Base


class RewardsUserState(Base):
    """Per-user XP, AC balance, Power Score, and daily login streak."""
    __tablename__ = "rewards_user_state"

    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    xp = Column(Integer, nullable=False, default=0, server_default="0")
    ac_balance = Column(Numeric(18, 2), nullable=False, default=Decimal("0"), server_default="0")
    ps = Column(Integer, nullable=False, default=0, server_default="0")
    # Daily login streak (resets if the user skips a day). last_streak_date is
    # NULL until the first check-in, then set to the date of the most recent
    # increment so we can decide today vs. yesterday vs. older on next check-in.
    streak_count = Column(Integer, nullable=False, default=0, server_default="0")
    last_streak_date = Column(Date, nullable=True)
    last_updated = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class RewardsMission(Base):
    """Mission template (catalogue), shared by all users for a given period."""
    __tablename__ = "rewards_missions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    slug = Column(String(60), unique=True, nullable=False)
    # daily | weekly | bonus | flash | achievement
    period = Column(String(20), nullable=False)
    title = Column(String(120), nullable=False)
    description = Column(Text, nullable=False)
    action_kind = Column(String(40), nullable=False)
    target_count = Column(Integer, nullable=False, default=1)
    xp_reward = Column(Integer, nullable=False, default=0)
    ac_reward = Column(Numeric(18, 2), nullable=False, default=Decimal("0"))
    is_active = Column(Boolean, nullable=False, default=True, server_default="true")
    display_order = Column(Integer, nullable=False, default=0)
    # When set, the mission only opens after this timestamp (used by event +
    # flash missions). NULL means "always open as of seed time".
    starts_at = Column(DateTime(timezone=True), nullable=True)
    # When set, the mission stops being offered after this timestamp (used by
    # flash + event missions). NULL means the mission is evergreen.
    expires_at = Column(DateTime(timezone=True), nullable=True)
    # Day-of-streak gate (1..7) for daily missions. NULL = show every day.
    # Repeatable_task.docx defines a 7-day cycle where each day has its own
    # headline mission; this column lets the listing filter pick today's.
    streak_day = Column(Integer, nullable=True)


class RewardsUserMissionProgress(Base):
    """Per-user, per-period progress against a mission. Composite PK on
    (user_id, mission_id, period_key) so daily/weekly resets fall out
    naturally — period_key is a date or ISO-week string."""
    __tablename__ = "rewards_user_mission_progress"

    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    mission_id = Column(UUID(as_uuid=True), ForeignKey("rewards_missions.id", ondelete="CASCADE"), primary_key=True)
    period_key = Column(String(20), primary_key=True)
    progress = Column(Integer, nullable=False, default=0)
    completed_at = Column(DateTime(timezone=True))
    claimed_at = Column(DateTime(timezone=True))
    updated_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class RewardStoreItem(Base):
    """Items in the AC reward store."""
    __tablename__ = "reward_store_items"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    slug = Column(String(60), unique=True, nullable=False)
    category = Column(String(20), nullable=False)  # cashback | bonus | perk | tool
    label = Column(String(120), nullable=False)
    description = Column(Text)
    ac_price = Column(Numeric(18, 2), nullable=False)
    payload = Column(JSONB, nullable=False, default=dict)
    is_active = Column(Boolean, nullable=False, default=True, server_default="true")
    display_order = Column(Integer, nullable=False, default=0)


class RewardsTransaction(Base):
    """Audit log of XP/AC events."""
    __tablename__ = "rewards_transactions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    type = Column(String(30), nullable=False)  # mission_claim | redeem | adjust
    xp_delta = Column(Integer, nullable=False, default=0)
    ac_delta = Column(Numeric(18, 2), nullable=False, default=Decimal("0"))
    source = Column(String(60))
    reference_id = Column(UUID(as_uuid=True))
    created_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class LifestyleFulfillment(Base):
    """Manual fulfillment queue for PS-gated lifestyle redemptions
    (smartphones, Dubai trips, branded merch, etc.). Created when a user
    redeems a reward_store_items row with category='lifestyle'."""
    __tablename__ = "lifestyle_fulfillments"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    item_id = Column(UUID(as_uuid=True), ForeignKey("reward_store_items.id"), nullable=False)
    ac_paid = Column(Numeric(18, 2), nullable=False)
    user_ps_at_redeem = Column(Integer, nullable=False, default=0)
    shipping_address = Column(Text, nullable=True)
    tracking_number = Column(String(120), nullable=True)
    # queued | processing | shipped | delivered | cancelled
    status = Column(String(20), nullable=False, default="queued")
    note = Column(Text, nullable=True)
    requested_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    processed_at = Column(DateTime(timezone=True), nullable=True)
    shipped_at = Column(DateTime(timezone=True), nullable=True)
    delivered_at = Column(DateTime(timezone=True), nullable=True)
    cancelled_at = Column(DateTime(timezone=True), nullable=True)
    handled_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)


# ─── Referral staking reward campaigns (client 2026-07-11) ───────────────
# Admin-run, time-bound offers: "bring NEW referred users who lock AI Powered
# Staking during the window; earn a tiered % of the volume they lock."
# Separate from the XP/AC/PS engine above — pays real USD to the main wallet.

class RewardCampaign(Base):
    """One admin offer: a date window + tiered %-of-volume payouts."""
    __tablename__ = "reward_campaigns"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    title = Column(String(120), nullable=False)
    description = Column(Text, nullable=True)
    starts_at = Column(DateTime(timezone=True), nullable=False)
    ends_at = Column(DateTime(timezone=True), nullable=False)
    is_active = Column(Boolean, nullable=False, default=True, server_default="true")
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class RewardCampaignTier(Base):
    """Volume bracket → reward. The referrer's TOTAL qualifying volume picks
    ONE bracket (min <= total < max; max NULL = open-ended). The reward is
    EITHER a percent of the whole total (reward_pct) OR a fixed USD amount
    (reward_amount) — exactly one is set (client 2026-07-13)."""
    __tablename__ = "reward_campaign_tiers"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    campaign_id = Column(UUID(as_uuid=True), ForeignKey("reward_campaigns.id", ondelete="CASCADE"), nullable=False)
    min_amount = Column(Numeric(18, 2), nullable=False)
    max_amount = Column(Numeric(18, 2), nullable=True)   # NULL = no upper bound
    reward_pct = Column(Numeric(6, 3), nullable=True)    # % of the whole volume
    reward_amount = Column(Numeric(18, 2), nullable=True)  # fixed USD payout


class RewardCampaignClaim(Base):
    """One claim per (campaign, referrer). Snapshot of the qualifying volume
    and the USD paid to the main wallet at claim time."""
    __tablename__ = "reward_campaign_claims"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    campaign_id = Column(UUID(as_uuid=True), ForeignKey("reward_campaigns.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    staked_total = Column(Numeric(18, 2), nullable=False)
    reward_pct = Column(Numeric(6, 3), nullable=True)   # NULL when the tier paid a fixed amount
    reward_amount = Column(Numeric(18, 2), nullable=False)
    claimed_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
