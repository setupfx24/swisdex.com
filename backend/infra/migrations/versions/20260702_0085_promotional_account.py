"""Promotional / pilot trading accounts.

Admin marks specific trading accounts as promotional (marketing/showcase). Their
activity — and the owner's user-scoped promo activity (FR, referral, IB) — is
excluded from admin's real company financials, while everything still shows on
the user's own dashboard as normal.

Revision ID: 0085
Revises: 0084
"""
from alembic import op


revision = "0085"
down_revision = "0084"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE trading_accounts ADD COLUMN IF NOT EXISTS is_promotional "
        "BOOLEAN NOT NULL DEFAULT false"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE trading_accounts DROP COLUMN IF EXISTS is_promotional")
