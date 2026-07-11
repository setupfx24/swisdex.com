"""Personal bank-deposit requests.

A user asks admin for payment details from the bank-deposit page; admin
approves and attaches a personal QR / bank details / UPI id; the user then pays
and completes the existing manual deposit. One row per request.

Revision ID: 0082
Revises: 0081
"""
from alembic import op


revision = "0082"
down_revision = "0081"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS deposit_requests (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id         UUID NOT NULL REFERENCES users(id),
            amount          NUMERIC(18, 2),
            status          VARCHAR(20) NOT NULL DEFAULT 'pending',
            admin_qr        TEXT,
            admin_bank_text TEXT,
            admin_upi       VARCHAR(255),
            admin_note      TEXT,
            approved_by     UUID REFERENCES users(id),
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            responded_at    TIMESTAMPTZ
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_deposit_requests_user ON deposit_requests (user_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_deposit_requests_status ON deposit_requests (status)"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS deposit_requests")
