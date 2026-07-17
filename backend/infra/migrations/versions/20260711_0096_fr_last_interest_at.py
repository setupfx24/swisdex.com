"""AI-Powered Staking: last_interest_at floor for on-demand interest withdrawal.

Adds fixed_return_locks.last_interest_at — set whenever interest is credited
(scheduled cycle or the new on-demand "withdraw interest" action) so accrual
isn't double-counted. Also introduces the 'principal_pending' lock state
(matured principal claim awaiting admin approval) — no schema change needed
since state has no CHECK constraint.

Revision ID: 0096
Revises: 0095
"""
from alembic import op


revision = "0096"
down_revision = "0095"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE fixed_return_locks "
        "ADD COLUMN IF NOT EXISTS last_interest_at TIMESTAMPTZ"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE fixed_return_locks DROP COLUMN IF EXISTS last_interest_at")
