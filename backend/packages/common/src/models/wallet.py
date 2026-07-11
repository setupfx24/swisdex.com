"""Wallet ledger — banks, deposits, withdrawals, transactions, charge/spread/swap configs."""
import uuid
from datetime import datetime

from sqlalchemy import (
    Column, String, Boolean, Integer, DateTime, Date, ForeignKey, Text, Numeric,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship

from ..database import Base


class BankAccount(Base):
    __tablename__ = "bank_accounts"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    account_name = Column(String(100))
    account_number = Column(String(50))
    bank_name = Column(String(100))
    ifsc_code = Column(String(20))
    upi_id = Column(String(100))
    qr_code_url = Column(Text)
    tier = Column(Integer, default=1)
    min_amount = Column(Numeric(18, 2), default=0)
    max_amount = Column(Numeric(18, 2), default=999999999)
    is_active = Column(Boolean, default=True)
    rotation_order = Column(Integer, default=0)
    last_used_at = Column(DateTime(timezone=True))
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)


class PaymentMethod(Base):
    """Per-method deposit config (migration 0083) — each method (UPI, Local
    Bank, ...) has its own admin-set QR / UPI / bank text, the notice +
    declaration the user accepts, min/max and pay currency. Funds settle in USD
    in the main wallet after live conversion."""
    __tablename__ = "payment_methods"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    method_key = Column(String(40), unique=True, nullable=False)
    display_name = Column(String(100), nullable=False)
    enabled = Column(Boolean, nullable=False, default=True)
    sort_order = Column(Integer, nullable=False, default=0)
    pay_currency = Column(String(10), nullable=False, default="INR")
    qr_image = Column(Text)        # base64 data-URL
    upi_id = Column(String(255))
    bank_text = Column(Text)
    notice = Column(Text)          # step-2 "Accept & Continue" note
    declaration = Column(Text)     # step-4 checkbox text
    min_amount = Column(Numeric(18, 2))
    max_amount = Column(Numeric(18, 2))
    # Admin-fixed rate = the DOLLAR PRICE: how many pay_currency units make 1
    # USD (e.g. 83 ⇒ 1 USD = 83 INR). When set, the method uses it INSTEAD of
    # the live FX API. Deposit credits amount/rate (5000 INR ÷ 83 ≈ $60);
    # withdrawal pays usd×rate. NULL = live API (migration 0091). Deposit and
    # withdrawal are priced separately so admin can set a spread between them.
    usd_rate = Column(Numeric(18, 6), nullable=True)             # deposit leg
    withdrawal_usd_rate = Column(Numeric(18, 6), nullable=True)  # withdrawal leg
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)


class Deposit(Base):
    __tablename__ = "deposits"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    account_id = Column(UUID(as_uuid=True), ForeignKey("trading_accounts.id"), nullable=True)
    amount = Column(Numeric(18, 8), nullable=False)
    currency = Column(String(10), default="USD")
    method = Column(String(30))
    status = Column(String(20), default="pending")
    transaction_id = Column(String(100))
    screenshot_url = Column(Text)
    bank_account_id = Column(UUID(as_uuid=True), ForeignKey("bank_accounts.id"), nullable=True)
    crypto_tx_hash = Column(String(200))
    crypto_address = Column(String(200))
    # NOWPayments wallet-connect flow (migration 0032). `pay_amount` is the
    # exact crypto amount the user must send to `crypto_address`; `pay_currency`
    # is the NOWPayments code (usdterc20, eth, …); `network` is the chain we
    # surface to wagmi/RainbowKit; `expires_at` is the invoice TTL.
    pay_amount = Column(Numeric(36, 18), nullable=True)
    pay_currency = Column(String(20), nullable=True)
    network = Column(String(20), nullable=True)
    expires_at = Column(DateTime(timezone=True), nullable=True)
    rejection_reason = Column(Text)
    approved_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    approved_at = Column(DateTime(timezone=True))
    # Bonus request flow (migration 0054). User types a promo code at
    # deposit time → bonus_status='pending'. Admin reviews on the deposits
    # page and either grants (sets bonus_amount + credits wallet) or denies
    # with a reason. NULL bonus_code = deposit asked for no bonus and the
    # existing auto-apply BonusOffer loop still runs as before.
    bonus_code = Column(String(40), nullable=True)
    bonus_status = Column(String(20), nullable=True)
    bonus_amount = Column(Numeric(18, 8), nullable=True)
    bonus_decided_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    bonus_decided_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    user = relationship("User", foreign_keys=[user_id], lazy="selectin")


class DepositRequest(Base):
    """A user asks an admin for personal payment details from the bank-deposit
    page (migration 0082). Admin approves and attaches a personal QR / bank
    text / UPI id; the user pays and finishes via the normal manual deposit."""
    __tablename__ = "deposit_requests"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    amount = Column(Numeric(18, 2))
    # pending | approved | rejected
    status = Column(String(20), nullable=False, default="pending", index=True)
    # Whatever the admin chooses to send back — any combination. The QR is a
    # base64 data-URL (rendered inline like ticket attachments — no file infra).
    admin_qr = Column(Text)
    admin_bank_text = Column(Text)
    admin_upi = Column(String(255))
    admin_note = Column(Text)
    approved_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    responded_at = Column(DateTime(timezone=True))

    user = relationship("User", foreign_keys=[user_id], lazy="selectin")


class Withdrawal(Base):
    __tablename__ = "withdrawals"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    account_id = Column(UUID(as_uuid=True), ForeignKey("trading_accounts.id"), nullable=True)
    amount = Column(Numeric(18, 8), nullable=False)
    currency = Column(String(10), default="USD")
    method = Column(String(30))
    status = Column(String(20), default="pending")
    bank_details = Column(JSONB)
    crypto_address = Column(String(200))
    crypto_tx_hash = Column(String(200))
    # NOWPayments payout/batch id for automatic crypto withdrawals — lets the
    # payout IPN correlate back to this withdrawal.
    payout_batch_id = Column(String(100))
    rejection_reason = Column(Text)
    approved_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    approved_at = Column(DateTime(timezone=True))
    completed_at = Column(DateTime(timezone=True))
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)

    user = relationship("User", foreign_keys=[user_id], lazy="selectin")


class Transaction(Base):
    __tablename__ = "transactions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    account_id = Column(UUID(as_uuid=True), ForeignKey("trading_accounts.id"), nullable=True)
    type = Column(String(30), nullable=False)
    amount = Column(Numeric(18, 8), nullable=False)
    balance_after = Column(Numeric(18, 8))
    reference_id = Column(UUID(as_uuid=True))
    description = Column(Text)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)


class PromotionalExpense(Base):
    """Admin-logged ad-hoc promotional give-away (migration 0088).

    Holds ONLY manual entries an admin records for promotional pay-outs that
    have no existing ledger row — e.g. off-matrix extra Fixed Return interest
    or a custom benefit. Admin-only; never shown in a user's wallet history.
    The Promotional Expenses card sums these on top of the read-time
    aggregates over transactions / ib_commissions.
    """
    __tablename__ = "promotional_expenses"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # The recipient of the give-away (nullable so a general promo cost can be
    # logged without pinning it to one user).
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    amount = Column(Numeric(18, 2), nullable=False)
    category = Column(String(40), nullable=False, default="manual", server_default="manual")
    note = Column(Text)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)


class CompanyExpense(Base):
    """SwisDex operating-expense ledger (migration 0089).

    A Tally/Excel-style running book of the broker's own business expenses
    (rent, salaries, marketing, tools, …). Admin-managed CRUD; unrelated to
    user money movement. Distinct from PromotionalExpense (user give-aways).
    """
    __tablename__ = "company_expenses"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    expense_date = Column(Date, nullable=False)
    name = Column(String(200), nullable=False)
    amount = Column(Numeric(18, 2), nullable=False)
    reason = Column(Text)
    result = Column(Text)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)


class ChargeConfig(Base):
    __tablename__ = "charge_configs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    scope = Column(String(20), nullable=False)
    segment_id = Column(UUID(as_uuid=True), ForeignKey("instrument_segments.id"))
    instrument_id = Column(UUID(as_uuid=True), ForeignKey("instruments.id"))
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    # When set, this rule applies ONLY to fills on accounts in this
    # group (Standard / ECN / VIP). NULL = wildcard (matches any
    # account type). resolve_commission prefers a rule with the
    # matching account_group_id over the NULL fallback at every
    # scope level, so admins can override per-type without
    # duplicating per-instrument rows.
    account_group_id = Column(UUID(as_uuid=True), ForeignKey("account_groups.id"), nullable=True)
    charge_type = Column(String(30), nullable=False)
    value = Column(Numeric(18, 8), nullable=False)
    is_enabled = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)


class SpreadConfig(Base):
    __tablename__ = "spread_configs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    scope = Column(String(20), nullable=False)
    segment_id = Column(UUID(as_uuid=True), ForeignKey("instrument_segments.id"))
    instrument_id = Column(UUID(as_uuid=True), ForeignKey("instruments.id"))
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    # See ChargeConfig.account_group_id — same semantics. NULL =
    # wildcard; resolve_spread_config prefers an account-group match
    # over NULL at every scope.
    account_group_id = Column(UUID(as_uuid=True), ForeignKey("account_groups.id"), nullable=True)
    spread_type = Column(String(20), nullable=False)
    value = Column(Numeric(18, 8), nullable=False)
    is_enabled = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)


class SwapConfig(Base):
    __tablename__ = "swap_configs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    scope = Column(String(20), nullable=False)
    segment_id = Column(UUID(as_uuid=True), ForeignKey("instrument_segments.id"))
    instrument_id = Column(UUID(as_uuid=True), ForeignKey("instruments.id"))
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    swap_long = Column(Numeric(18, 8), default=0)
    swap_short = Column(Numeric(18, 8), default=0)
    triple_swap_day = Column(Integer, default=3)
    swap_free = Column(Boolean, default=False)
    is_enabled = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at = Column(DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow)
