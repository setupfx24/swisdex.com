"""RM manual deposit/withdraw requests — admin visibility.

The trader's "Request to RM" form emails the relationship manager. This table
also PERSISTS each request so admin can see them in the panel (name / amount /
method / phone / side / payout details / status) instead of only in the RM's
inbox.

Revision ID: 0093
Revises: 0092
"""
from alembic import op


revision = "0093"
down_revision = "0092"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS rm_manual_requests (
            id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
            side           VARCHAR(10) NOT NULL,
            amount         NUMERIC(18, 2) NOT NULL,
            method         VARCHAR(60),
            phone          VARCHAR(30),
            payout_details TEXT,
            note           TEXT,
            status         VARCHAR(20) NOT NULL DEFAULT 'new',
            created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    """)
    op.execute("CREATE INDEX IF NOT EXISTS ix_rm_manual_req_created ON rm_manual_requests (created_at);")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS rm_manual_requests;")
