"""Reward campaign tiers: allow a FIXED USD amount instead of a percent.

Client 2026-07-13: "percentage ki jagah fixed amount daal paye" — a tier's
reward is now EITHER reward_pct (% of the whole qualifying volume) OR
reward_amount (flat USD). Claims snapshot reward_pct only when the tier was
percent-based, so it becomes nullable there too.

Revision ID: 0097
Revises: 0096
"""
from alembic import op


revision = "0097"
down_revision = "0096"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE reward_campaign_tiers "
        "ADD COLUMN IF NOT EXISTS reward_amount NUMERIC(18,2)"
    )
    op.execute(
        "ALTER TABLE reward_campaign_tiers ALTER COLUMN reward_pct DROP NOT NULL"
    )
    op.execute(
        "ALTER TABLE reward_campaign_claims ALTER COLUMN reward_pct DROP NOT NULL"
    )


def downgrade() -> None:
    op.execute("UPDATE reward_campaign_tiers SET reward_pct = 0 WHERE reward_pct IS NULL")
    op.execute("ALTER TABLE reward_campaign_tiers ALTER COLUMN reward_pct SET NOT NULL")
    op.execute("ALTER TABLE reward_campaign_tiers DROP COLUMN IF EXISTS reward_amount")
    op.execute("UPDATE reward_campaign_claims SET reward_pct = 0 WHERE reward_pct IS NULL")
    op.execute("ALTER TABLE reward_campaign_claims ALTER COLUMN reward_pct SET NOT NULL")
