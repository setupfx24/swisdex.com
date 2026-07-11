"""Per-user bank deposit visibility.

Adds users.bank_deposit_enabled (nullable) so an admin can show the bank/manual
deposit option to SPECIFIC clients only (client 2026-06-23). NULL = follow the
global wallet.manual_enabled toggle; True/False = explicit per-user override.

Revision ID: 0081
Revises: 0080
"""
from alembic import op


revision = "0081"
down_revision = "0080"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_deposit_enabled BOOLEAN")


def downgrade() -> None:
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS bank_deposit_enabled")
