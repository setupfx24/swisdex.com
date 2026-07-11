"""Per-referrer payout mode for the AI Powered Staking (Fixed Return) referral.

A referrer chooses globally how they want their staking-referral commission:
  'principal' → a % of each referred user's PRINCIPAL, once when they lock.
  'interest'  → a % of each interest payout the referred user receives.
The percentages themselves are admin settings (fr_referral_principal_pct /
fr_referral_interest_pct), so this only stores the per-user choice.

Revision ID: 0084
Revises: 0083
"""
from alembic import op


revision = "0084"
down_revision = "0083"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS fr_referral_mode "
        "VARCHAR(20) NOT NULL DEFAULT 'principal'"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS fr_referral_mode")
