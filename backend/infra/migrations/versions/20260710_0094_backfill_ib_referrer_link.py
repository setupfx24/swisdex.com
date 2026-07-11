"""Backfill referred_by_user_id for IB-referred users.

Users who signed up with an IB's referral code BEFORE 2026-06-23 were linked
only into the IB tree (referrals table) — users.referred_by_user_id stayed
NULL. Every payout that keys off the personal referral link (AI Powered
Staking principal/interest commission, first-deposit referral reward) silently
skipped them, so the IB earned nothing when their referee staked.

This fills the column from the earliest referrals row per user. Only NULLs
are touched — existing links are never overwritten. Self-referrals excluded.

Revision ID: 0094
Revises: 0093
"""
from alembic import op


revision = "0094"
down_revision = "0093"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        UPDATE users u
        SET referred_by_user_id = fr.referrer_id
        FROM (
            SELECT DISTINCT ON (referred_id) referred_id, referrer_id
            FROM referrals
            WHERE referrer_id IS NOT NULL
            ORDER BY referred_id, created_at ASC
        ) fr
        WHERE fr.referred_id = u.id
          AND u.referred_by_user_id IS NULL
          AND fr.referrer_id <> u.id
    """)


def downgrade() -> None:
    # Data backfill — no safe automatic reversal (we can't distinguish
    # backfilled links from organically-set ones afterwards). No-op.
    pass
