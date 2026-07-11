"""Promotional / pilot users — whole-user flag.

The client wants the ENTIRE user (not individual trading accounts) marked as
promotional: admin flags a user, and all of that user's activity is excluded
from the real company financials while staying fully live on the user's own
dashboard.

Revision ID: 0086
Revises: 0085
"""
from alembic import op


revision = "0086"
down_revision = "0085"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_promotional "
        "BOOLEAN NOT NULL DEFAULT false"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS is_promotional")
