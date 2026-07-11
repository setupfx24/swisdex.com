"""Personal bank-deposit requests (trader side).

A user asks an admin for payment details from the bank-deposit page. The admin
approves and attaches a personal QR / bank text / UPI id; the user then pays and
finishes through the normal manual-deposit flow. See migration 0082.
"""
from __future__ import annotations

import logging
from decimal import Decimal
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.models import DepositRequest

logger = logging.getLogger("deposit_request_service")


def _serialize(r: DepositRequest) -> dict:
    return {
        "id": str(r.id),
        "amount": float(r.amount) if r.amount is not None else None,
        "status": r.status,
        # Admin's reply — only populated once approved.
        "admin_qr": r.admin_qr,
        "admin_bank_text": r.admin_bank_text,
        "admin_upi": r.admin_upi,
        "admin_note": r.admin_note,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "responded_at": r.responded_at.isoformat() if r.responded_at else None,
    }


async def create_request(user_id: UUID, amount, db: AsyncSession) -> dict:
    """Open a new personal-deposit request. Blocks a second OPEN (pending)
    request so the admin queue isn't spammed — the user waits for a reply."""
    try:
        amt = Decimal(str(amount)) if amount is not None else None
    except Exception:
        amt = None
    if amt is None or amt <= 0:
        raise HTTPException(status_code=400, detail="Enter a valid amount")

    existing = (await db.execute(
        select(DepositRequest.id).where(
            DepositRequest.user_id == user_id,
            DepositRequest.status == "pending",
        ).limit(1)
    )).first()
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail="You already have a pending request. Please wait for the admin to respond.",
        )

    req = DepositRequest(user_id=user_id, amount=amt, status="pending")
    db.add(req)
    await db.flush()

    # Best-effort: notify every admin / super-admin there's a request to action.
    try:
        from packages.common.src.notify import create_notification
        from packages.common.src.models import User
        admin_ids = (await db.execute(
            select(User.id).where(User.role.in_(["admin", "super_admin"]))
        )).scalars().all()
        for aid in admin_ids:
            await create_notification(
                db, aid,
                title="New deposit-details request",
                message=f"A user requested personal bank/QR details for ${float(amt):.2f}.",
                notif_type="info",
                action_url="/deposit-requests",
            )
    except Exception as _e:
        logger.debug("admin notify (deposit request) skipped: %s", _e)

    await db.commit()
    return _serialize(req)


async def list_my_requests(user_id: UUID, db: AsyncSession) -> dict:
    rows = (await db.execute(
        select(DepositRequest)
        .where(DepositRequest.user_id == user_id)
        .order_by(DepositRequest.created_at.desc())
        .limit(20)
    )).scalars().all()
    return {"items": [_serialize(r) for r in rows]}
