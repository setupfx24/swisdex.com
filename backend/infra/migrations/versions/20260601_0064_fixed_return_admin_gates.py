"""AI-POWERED STAKING PROGRAM admin gates — early-withdrawal approval + per-user rate override.

Client request 2026-06-01:
1. Early withdrawals must wait for admin approval instead of crediting
   the user's wallet on the spot. We add a new state value
   ``early_pending`` (the ``state`` column is already a free-form
   VARCHAR(20), no CHECK constraint to amend) and a sister column
   ``early_requested_at`` that times the request so admin queues can
   age-sort.
2. Admins want to grant a specific user a non-standard rate matrix
   (e.g. a VIP friend gets 3% per month on every tenure regardless of
   tier). We add a ``fixed_return_rate_override`` JSONB column on
   ``users``; when populated, ``create_lock`` reads its
   ``rate_matrix_pct`` instead of the global ``fixed_return_rates``
   setting.

Both columns are nullable so existing rows stay valid; no backfill.

Revision ID: 0064
Revises: 0063
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision = "0064"
down_revision = "0063"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "fixed_return_locks",
        sa.Column("early_requested_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("fixed_return_rate_override", JSONB, nullable=True),
    )


def downgrade() -> None:
    op.drop_column("users", "fixed_return_rate_override")
    op.drop_column("fixed_return_locks", "early_requested_at")
