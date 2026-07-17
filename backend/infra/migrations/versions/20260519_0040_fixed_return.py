"""AI-POWERED STAKING PROGRAM — user principal locks table + seed default rate matrix.

Revision ID: 0040
Revises: 0039
"""
import json

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision = "0040"
down_revision = "0039"
branch_labels = None
depends_on = None


_DEFAULT_RATES = {
    "tiers": [
        {"label": "$1K",   "min_amount": 1000},
        {"label": "$10K",  "min_amount": 10000},
        {"label": "$25K",  "min_amount": 25000},
        {"label": "$50K",  "min_amount": 50000},
        {"label": "$100K", "min_amount": 100000},
    ],
    "tenures": [
        {"label": "Month",     "days": 30},
        {"label": "Quarter",   "days": 90},
        {"label": "Half-Year", "days": 180},
        {"label": "Year",      "days": 365},
        {"label": "2 Year",    "days": 730},
    ],
    "rate_matrix_pct": [
        [1.0, 2.0, 2.5, 3.0, 4.0],
        [2.0, 3.0, 3.0, 3.5, 4.5],
        [3.0, 4.0, 4.5, 5.0, 5.0],
        [4.0, 5.0, 5.5, 6.0, 5.5],
        [5.0, 6.0, 6.5, 7.0, 7.0],
    ],
}


def upgrade() -> None:
    op.create_table(
        "fixed_return_locks",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("principal", sa.Numeric(18, 2), nullable=False),
        sa.Column("tier_label", sa.String(40), nullable=False),
        sa.Column("tenure_label", sa.String(40), nullable=False),
        sa.Column("tenure_days", sa.Integer, nullable=False),
        sa.Column("rate_pct", sa.Numeric(8, 4), nullable=False),
        sa.Column("locked_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("matures_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("settled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("state", sa.String(20), nullable=False, server_default="active"),
        sa.Column("payout", sa.Numeric(18, 2), nullable=True),
        sa.Column("fee_paid", sa.Numeric(18, 2), nullable=True),
        sa.CheckConstraint(
            "state IN ('active','matured','withdrawn_early')",
            name="fixed_return_locks_state_check",
        ),
    )
    op.create_index(
        "ix_fixed_return_locks_user_state",
        "fixed_return_locks",
        ["user_id", "state"],
    )
    op.create_index(
        "ix_fixed_return_locks_matures",
        "fixed_return_locks",
        ["state", "matures_at"],
    )

    # Seed defaults in system_settings so the admin page has something
    # to render on day one. Skips if the row already exists.
    rates_json = json.dumps(_DEFAULT_RATES).replace("'", "''")
    op.execute(
        f"""
        INSERT INTO system_settings (key, value)
        VALUES ('fixed_return_rates', '{rates_json}')
        ON CONFLICT (key) DO NOTHING;
        """
    )
    op.execute(
        """
        INSERT INTO system_settings (key, value)
        VALUES ('fixed_return_early_withdrawal_fee_pct', '5')
        ON CONFLICT (key) DO NOTHING;
        """
    )


def downgrade() -> None:
    op.drop_index("ix_fixed_return_locks_matures", table_name="fixed_return_locks")
    op.drop_index("ix_fixed_return_locks_user_state", table_name="fixed_return_locks")
    op.drop_table("fixed_return_locks")
    op.execute(
        "DELETE FROM system_settings "
        "WHERE key IN ('fixed_return_rates','fixed_return_early_withdrawal_fee_pct');"
    )
