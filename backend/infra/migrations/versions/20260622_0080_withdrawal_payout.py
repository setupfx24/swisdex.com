"""Automatic crypto withdrawals (NOWPayments payout): tracking column + open status.

Adds withdrawals.payout_batch_id (the NOWPayments payout/batch id) so we can
correlate the payout IPN back to the withdrawal, and drops the narrow
withdrawals.status CHECK so the auto-payout lifecycle ('processing' → 'completed'
/ 'failed') is allowed. Same class of fix as the user/notification/employee
CHECK drops (0073/0075/0076/0079) — the app owns the status vocabulary.

Revision ID: 0080
Revises: 0079
"""
from alembic import op


revision = "0080"
down_revision = "0079"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS payout_batch_id VARCHAR(100)"
    )
    op.execute(
        "ALTER TABLE withdrawals DROP CONSTRAINT IF EXISTS withdrawals_status_check"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE withdrawals DROP COLUMN IF EXISTS payout_batch_id")
    op.execute(
        "ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_status_check "
        "CHECK (status IN ('pending', 'approved', 'rejected', 'processing', 'completed'))"
    )
