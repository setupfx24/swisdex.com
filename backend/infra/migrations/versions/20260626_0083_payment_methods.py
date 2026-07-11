"""Per-method deposit payment configuration (XM-style flow).

Each deposit method (UPI, Local Bank, Online Bank, ...) carries its OWN
admin-set payment details: QR, UPI id, bank text, the step-2 notice + step-4
declaration the user must accept, min/max, and the currency the user pays in.
The trader picks a method → accepts the notice → enters amount (shown in the
pay currency + live-converted USD) → ticks the declaration → confirms → sees the
QR page → pays + submits UTR. Funds always settle in USD in the main wallet.

Revision ID: 0083
Revises: 0082
"""
from alembic import op


revision = "0083"
down_revision = "0082"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS payment_methods (
            id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            method_key    VARCHAR(40) NOT NULL UNIQUE,
            display_name  VARCHAR(100) NOT NULL,
            enabled       BOOLEAN NOT NULL DEFAULT true,
            sort_order    INTEGER NOT NULL DEFAULT 0,
            -- Currency the USER pays in (INR for UPI/bank). Funds settle in USD
            -- after live conversion.
            pay_currency  VARCHAR(10) NOT NULL DEFAULT 'INR',
            qr_image      TEXT,          -- base64 data-URL
            upi_id        VARCHAR(255),
            bank_text     TEXT,          -- account / IFSC / holder
            notice        TEXT,          -- step-2 "Accept & Continue" note
            declaration   TEXT,          -- step-4 checkbox text
            min_amount    NUMERIC(18, 2),
            max_amount    NUMERIC(18, 2),
            created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS payment_methods")
