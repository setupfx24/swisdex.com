"""Per-referrer Fixed Return referral-commission % override.

The FR referral commission % (on principal and on interest) is a GLOBAL setting
(fr_referral_principal_pct / fr_referral_interest_pct). This adds an optional
PER-USER override so a specific referrer can be given a custom rate. NULL on a
column = fall back to the global setting for that leg (unchanged behaviour).

Revision ID: 0090
Revises: 0089
"""
from alembic import op


revision = "0090"
down_revision = "0089"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE users
            ADD COLUMN IF NOT EXISTS fr_referral_principal_pct_override NUMERIC(8, 4),
            ADD COLUMN IF NOT EXISTS fr_referral_interest_pct_override  NUMERIC(8, 4);
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE users
            DROP COLUMN IF EXISTS fr_referral_principal_pct_override,
            DROP COLUMN IF EXISTS fr_referral_interest_pct_override;
    """)
