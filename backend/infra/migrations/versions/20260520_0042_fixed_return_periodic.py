"""AI-POWERED STAKING PROGRAM v2 — periodic interest payouts + fixed 24-month lock.

Tenure now means PAYOUT FREQUENCY, not lock duration. Every lock runs
for the same admin-set lock_months (default 24), with the user receiving
principal * rate% every `tenure_days` and the principal back at maturity.

Schema:
  + fixed_return_locks.next_payout_at        DateTime (UTC)
  + fixed_return_locks.total_interest_paid   Numeric default 0
  + fixed_return_locks.payouts_count         Integer default 0
  + fixed_return_locks.lock_months_at_creation Integer (snapshot)
  + system_settings.fixed_return_lock_months  (default 24)

Backfill for any rows already in the wild from the v1 ship: extend
matures_at out to locked_at + 24 months, set next_payout_at to the
nearest future tenure boundary, and assume zero interest paid so far.

Revision ID: 0042
Revises: 0041
"""
from alembic import op
import sqlalchemy as sa


revision = "0042"
down_revision = "0041"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "fixed_return_locks",
        sa.Column("next_payout_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "fixed_return_locks",
        sa.Column(
            "total_interest_paid", sa.Numeric(18, 2), nullable=False, server_default="0",
        ),
    )
    op.add_column(
        "fixed_return_locks",
        sa.Column(
            "payouts_count", sa.Integer, nullable=False, server_default="0",
        ),
    )
    op.add_column(
        "fixed_return_locks",
        sa.Column(
            "lock_months_at_creation", sa.Integer, nullable=False, server_default="24",
        ),
    )
    op.create_index(
        "ix_fixed_return_locks_next_payout",
        "fixed_return_locks",
        ["state", "next_payout_at"],
    )

    # Seed lock-months setting (admin override via /admin/settings).
    op.execute(
        """
        INSERT INTO system_settings (key, value)
        VALUES ('fixed_return_lock_months', '24')
        ON CONFLICT (key) DO NOTHING;
        """
    )

    # Backfill existing active locks. Extend the maturity to the new
    # 24-month policy and set next_payout_at one tenure-cycle from the
    # original locked_at (or now, whichever is later).
    op.execute(
        """
        UPDATE fixed_return_locks
        SET matures_at = locked_at + INTERVAL '24 months',
            next_payout_at = GREATEST(
                locked_at + (tenure_days || ' days')::interval,
                now()
            )
        WHERE state = 'active';
        """
    )


def downgrade() -> None:
    op.drop_index("ix_fixed_return_locks_next_payout", table_name="fixed_return_locks")
    op.drop_column("fixed_return_locks", "lock_months_at_creation")
    op.drop_column("fixed_return_locks", "payouts_count")
    op.drop_column("fixed_return_locks", "total_interest_paid")
    op.drop_column("fixed_return_locks", "next_payout_at")
    op.execute("DELETE FROM system_settings WHERE key = 'fixed_return_lock_months';")
