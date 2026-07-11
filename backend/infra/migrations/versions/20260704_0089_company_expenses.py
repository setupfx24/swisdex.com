"""SwisDex company expense ledger — a Tally/Excel-style running expense book.

Admin records general business expenses (Date, Name, Amount, Reason, Result)
and the rows persist as a ledger. Separate from `promotional_expenses`
(user give-aways) — this is the broker's own operating spend.

Revision ID: 0089
Revises: 0088
"""
from alembic import op


revision = "0089"
down_revision = "0088"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS company_expenses (
            id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            expense_date  DATE NOT NULL,
            name          VARCHAR(200) NOT NULL,
            amount        NUMERIC(18, 2) NOT NULL,
            reason        TEXT,
            result        TEXT,
            created_by    UUID REFERENCES users(id),
            created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_company_expense_date
            ON company_expenses (expense_date);
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS company_expenses;")
