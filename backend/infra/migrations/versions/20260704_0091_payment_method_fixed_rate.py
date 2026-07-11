"""Per-method admin-fixed USD rate (Bank etc.).

Bank / manual deposit methods convert the local pay_currency to USD via a live
FX API. This adds an optional admin-set fixed rate per method: when set, that
method uses the fixed rate instead of the live API. NULL = keep using the live
API (unchanged behaviour).

`usd_rate` is USD per 1 unit of the method's pay_currency (e.g. 0.012 for INR,
i.e. 1 USD = ~83 INR).

Revision ID: 0091
Revises: 0090
"""
from alembic import op


revision = "0091"
down_revision = "0090"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # usd_rate            = DEPOSIT fixed rate (USD per 1 pay_currency unit)
    # withdrawal_usd_rate = WITHDRAWAL fixed rate (separate, so admin can price
    #                       the two directions differently). NULL = live API.
    op.execute("""
        ALTER TABLE payment_methods
            ADD COLUMN IF NOT EXISTS usd_rate            NUMERIC(18, 6),
            ADD COLUMN IF NOT EXISTS withdrawal_usd_rate NUMERIC(18, 6);
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE payment_methods
            DROP COLUMN IF EXISTS usd_rate,
            DROP COLUMN IF EXISTS withdrawal_usd_rate;
    """)
