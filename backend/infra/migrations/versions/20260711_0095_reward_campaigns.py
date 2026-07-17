"""Referral staking reward campaigns.

Admin-run, time-bound offers: bring NEW referred users who lock AI Powered
Staking during the window; the referrer earns a tiered % of the volume those
users lock, claimable to the main wallet after the offer ends.

Revision ID: 0095
Revises: 0094
"""
from alembic import op


revision = "0095"
down_revision = "0094"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS reward_campaigns (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            title       VARCHAR(120) NOT NULL,
            description TEXT,
            starts_at   TIMESTAMPTZ NOT NULL,
            ends_at     TIMESTAMPTZ NOT NULL,
            is_active   BOOLEAN NOT NULL DEFAULT true,
            created_by  UUID REFERENCES users(id),
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """)
    op.execute("""
        CREATE TABLE IF NOT EXISTS reward_campaign_tiers (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            campaign_id UUID NOT NULL REFERENCES reward_campaigns(id) ON DELETE CASCADE,
            min_amount  NUMERIC(18,2) NOT NULL,
            max_amount  NUMERIC(18,2),
            reward_pct  NUMERIC(6,3) NOT NULL
        )
    """)
    op.execute("""
        CREATE TABLE IF NOT EXISTS reward_campaign_claims (
            id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            campaign_id   UUID NOT NULL REFERENCES reward_campaigns(id) ON DELETE CASCADE,
            user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            staked_total  NUMERIC(18,2) NOT NULL,
            reward_pct    NUMERIC(6,3) NOT NULL,
            reward_amount NUMERIC(18,2) NOT NULL,
            claimed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (campaign_id, user_id)
        )
    """)
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_reward_campaign_tiers_campaign ON reward_campaign_tiers(campaign_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_reward_campaign_claims_user ON reward_campaign_claims(user_id)"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS reward_campaign_claims")
    op.execute("DROP TABLE IF EXISTS reward_campaign_tiers")
    op.execute("DROP TABLE IF EXISTS reward_campaigns")
