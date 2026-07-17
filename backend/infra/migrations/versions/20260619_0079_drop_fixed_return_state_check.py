"""Drop the fixed_return_locks.state CHECK constraint.

Bug (client 2026-06-19): "Request early withdrawal" on a AI-POWERED STAKING PROGRAM lock
failed with a generic "Request failed". Root cause: the early-withdrawal path
parks the lock in state='early_pending' (awaiting admin approval), but
fixed_return_locks_state_check (migration 0040) only allowed
('active','matured','withdrawn_early'). Writing 'early_pending' violated the
CHECK → 500.

Same class of bug as the users.status / notifications.type / employees.role
CHECK constraints we already dropped (0073/0075/0076): the app owns the state
vocabulary and the narrow CHECK keeps breaking features as new states are
added. Drop it entirely. Idempotent.

Revision ID: 0079
Revises: 0078
"""
from alembic import op


revision = "0079"
down_revision = "0078"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE fixed_return_locks "
        "DROP CONSTRAINT IF EXISTS fixed_return_locks_state_check"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE fixed_return_locks ADD CONSTRAINT fixed_return_locks_state_check "
        "CHECK (state IN ('active','matured','withdrawn_early'))"
    )
