"""AI-POWERED STAKING PROGRAM — user principal locks against an admin-tunable rate matrix.

Rates and the early-withdrawal fee live in ``system_settings`` (JSON +
percent), not in dedicated tables, so admins can change the matrix in
one form without schema churn.

Money flow:
  Lock     : user.main_wallet_balance -= principal; row state='active'.
  Mature   : automatic at matures_at — principal + (principal * rate%)
             credited back to main_wallet_balance, state='matured'.
  Early    : principal * (1 - fee%) credited back; no return earned;
             state='withdrawn_early'.
"""
import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    Column, String, DateTime, ForeignKey, Numeric, Integer,
)
from sqlalchemy.dialects.postgresql import UUID

from ..database import Base


class FixedReturnLock(Base):
    """A user-locked principal with periodic interest payouts.

    Tenure now controls the PAYOUT CADENCE (Month / Quarter / Half-Year
    / Year / 2-Year), not the lock duration. Lock duration is a single
    admin-set policy (default 24 months) captured at creation in
    ``lock_months_at_creation`` so changing the policy later doesn't
    silently re-price open positions.

    Lifecycle:
      - On create     : matures_at = locked_at + lock_months_at_creation,
                        next_payout_at = locked_at + tenure_days.
      - Every cycle   : engine credits principal * rate_pct%, bumps
                        total_interest_paid + payouts_count, advances
                        next_payout_at by tenure_days (clamped to
                        matures_at — the final cycle is settled at
                        matures_at exactly).
      - At maturity   : user withdraws → receives principal only.
                        Interest was already paid in cycles.
      - Early exit    : user receives
                        principal * (1 - fee_pct/100) - total_interest_paid.
                        Interest claws back into the principal return.
    """
    __tablename__ = "fixed_return_locks"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)

    principal = Column(Numeric(18, 2), nullable=False)
    tier_label = Column(String(40), nullable=False)
    tenure_label = Column(String(40), nullable=False)
    # Days between interest payouts (e.g. 30 = monthly, 90 = quarterly).
    tenure_days = Column(Integer, nullable=False)
    # Percentage paid PER CYCLE of length tenure_days.
    rate_pct = Column(Numeric(8, 4), nullable=False)

    locked_at = Column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    # locked_at + lock_months_at_creation months.
    matures_at = Column(DateTime(timezone=True), nullable=False)
    # When the engine will pay the next interest cycle. NULL once the
    # lock has finished its last cycle (settled).
    next_payout_at = Column(DateTime(timezone=True), nullable=True)
    settled_at = Column(DateTime(timezone=True), nullable=True)

    # Snapshot of the lock_months policy at the time this lock was opened.
    # Keeps historical accuracy if the admin edits the policy later.
    lock_months_at_creation = Column(Integer, nullable=False, default=24, server_default="24")

    # Running totals updated by the interest-payout engine.
    total_interest_paid = Column(Numeric(18, 2), nullable=False, default=0, server_default="0")
    payouts_count = Column(Integer, nullable=False, default=0, server_default="0")
    # Floor for interest accrual: set to now whenever interest is credited
    # (scheduled cycle OR on-demand "withdraw interest"). The accrued-since
    # figure and the next scheduled payout both anchor at max(schedule, this)
    # so an on-demand interest pull isn't double-counted (client 2026-07-11).
    last_interest_at = Column(DateTime(timezone=True), nullable=True)

    # 'active' | 'early_pending' | 'principal_pending' | 'matured' |
    # 'withdrawn_early'. early_pending = trader pressed Withdraw early
    # (before maturity); principal_pending = trader claimed the matured
    # principal — both await admin approval on the AI-Powered Staking page.
    state = Column(String(20), nullable=False, default="active")
    # Set when the trader files an early-withdrawal request; cleared
    # when admin approves or rejects.
    early_requested_at = Column(DateTime(timezone=True), nullable=True)
    payout = Column(Numeric(18, 2), nullable=True)
    fee_paid = Column(Numeric(18, 2), nullable=True)
