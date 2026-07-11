"""Promotional Expenses ledger — admin-logged ad-hoc give-aways.

The admin Finance Overview gets a "Promotional Expenses" card that totals every
extra amount the broker pays out as promotion/incentive. Most categories (FR
referral commission, deposit bonuses, referral/IB bounties, IB commission) are
aggregated at read-time from existing `transactions` / `ib_commissions` rows —
no schema needed. This table holds ONLY the MANUAL entries an admin logs for
give-aways that have no existing record (e.g. extra Fixed Return interest granted
off-matrix, or a custom promotional benefit). It is admin-only and never shown in
a user's wallet history, so it can't be confused with real money movement.

Revision ID: 0088
Revises: 0087
"""
from alembic import op


revision = "0088"
down_revision = "0087"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS promotional_expenses (
            id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
            amount       NUMERIC(18, 2) NOT NULL,
            category     VARCHAR(40) NOT NULL DEFAULT 'manual',
            note         TEXT,
            created_by   UUID REFERENCES users(id),
            created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_promo_expense_created_at
            ON promotional_expenses (created_at);
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS promotional_expenses;")
