"""Relationship Manager (RM) subsystem models.

An RM is an employee (User.role="admin", Employee.role="rm") assigned a set
of users via User.assigned_rm_id. When the RM collects funds from a user
offline they raise an `RMFundingRequest` with a proof file. Admins clear it
with a strict two-admin flow (approve → credit, by two different admins).
See migration 0071.
"""
import uuid
from datetime import datetime

from sqlalchemy import Column, String, DateTime, ForeignKey, Text, Numeric
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from ..database import Base


class RMFundingRequest(Base):
    __tablename__ = "rm_funding_requests"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    rm_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    amount = Column(Numeric(18, 2), nullable=False)
    currency = Column(String(10), default="USD", nullable=False)
    method = Column(String(40))
    note = Column(Text)
    proof_path = Column(Text)
    # pending → approved (admin #1) → credited (admin #2) | rejected
    status = Column(String(20), default="pending", nullable=False)
    approved_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    approved_at = Column(DateTime(timezone=True))
    credited_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    credited_at = Column(DateTime(timezone=True))
    rejected_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    rejected_at = Column(DateTime(timezone=True))
    rejection_reason = Column(Text)
    deposit_id = Column(UUID(as_uuid=True), ForeignKey("deposits.id"))
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)

    rm = relationship("User", foreign_keys=[rm_id], lazy="selectin")
    user = relationship("User", foreign_keys=[user_id], lazy="selectin")


class RmManualRequest(Base):
    """A trader-submitted 'Request to RM' deposit/withdraw (mail-to-RM flow).

    The form emails the RM; this row persists the same request so admin can see
    it in the panel (migration 0093). Not the two-admin funding flow — that's
    RMFundingRequest above.
    """
    __tablename__ = "rm_manual_requests"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    side = Column(String(10), nullable=False)          # 'deposit' | 'withdraw'
    amount = Column(Numeric(18, 2), nullable=False)
    method = Column(String(60))
    phone = Column(String(30))
    payout_details = Column(Text)
    note = Column(Text)
    # new | contacted | done | cancelled
    status = Column(String(20), nullable=False, default="new")
    created_at = Column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)

    user = relationship("User", foreign_keys=[user_id], lazy="selectin")
