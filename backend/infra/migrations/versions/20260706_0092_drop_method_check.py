"""Drop deposits/withdrawals method CHECK constraints — methods are admin-defined.

Payment methods (PaymentMethod) are admin-created with an arbitrary method_key
(bank, upi, …). A deposit/withdrawal stores that key in `method`, but the old
deposits_method_check / withdrawals_method_check only allowed a fixed enum
('bank_transfer','upi','qr','crypto_*','manual',…). So a deposit through any
admin-defined method whose key isn't in that list (e.g. 'bank') failed to
insert with a CheckViolationError → HTTP 500 ("Request failed") at Confirm
Payment. Drop both constraints; `method` stays VARCHAR(30) so it's still bounded.

Revision ID: 0092
Revises: 0091
"""
from alembic import op


revision = "0092"
down_revision = "0091"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE deposits DROP CONSTRAINT IF EXISTS deposits_method_check;")
    op.execute("ALTER TABLE withdrawals DROP CONSTRAINT IF EXISTS withdrawals_method_check;")


def downgrade() -> None:
    # Intentionally NOT restored — method values are admin-dynamic now, so a
    # fixed enum can't be reimposed without breaking custom payment methods.
    pass
