"""Personal bank-deposit requests (admin side).

Admin reviews a user's request and approves it with a personal QR / bank text /
UPI id (any combination), or rejects it. The user then sees the reply on their
bank-deposit page. See migration 0082.
"""
import uuid
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.models import DepositRequest, User
from dependencies import write_audit_log


def _serialize(r: DepositRequest, user: User | None) -> dict:
    name = ""
    email = ""
    if user is not None:
        name = (f"{user.first_name or ''} {user.last_name or ''}").strip()
        email = user.email or ""
    return {
        "id": str(r.id),
        "user_id": str(r.user_id),
        "user_name": name or email,
        "user_email": email,
        "amount": float(r.amount) if r.amount is not None else None,
        "status": r.status,
        "admin_qr": r.admin_qr,
        "admin_bank_text": r.admin_bank_text,
        "admin_upi": r.admin_upi,
        "admin_note": r.admin_note,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "responded_at": r.responded_at.isoformat() if r.responded_at else None,
    }


async def list_requests(
    status_filter: str | None, page: int, per_page: int, db: AsyncSession,
) -> dict:
    # Hide promotional demo accounts from the admin panel.
    q = select(DepositRequest).where(
        DepositRequest.user_id.notin_(select(User.id).where(User.is_promotional == True))  # noqa: E712
    )
    if status_filter and status_filter != "all":
        q = q.where(DepositRequest.status == status_filter)

    total = (await db.execute(
        select(func.count()).select_from(q.subquery())
    )).scalar() or 0

    q = q.order_by(DepositRequest.created_at.desc()).offset((page - 1) * per_page).limit(per_page)
    rows = (await db.execute(q)).scalars().all()

    user_ids = {r.user_id for r in rows}
    users: dict = {}
    if user_ids:
        for u in (await db.execute(select(User).where(User.id.in_(user_ids)))).scalars().all():
            users[u.id] = u

    return {
        "items": [_serialize(r, users.get(r.user_id)) for r in rows],
        "total": total,
        "page": page,
        "per_page": per_page,
    }


async def approve_request(
    req_id: uuid.UUID, admin_id: uuid.UUID, *,
    admin_qr: str | None, admin_bank_text: str | None,
    admin_upi: str | None, admin_note: str | None,
    ip_address: str | None, db: AsyncSession,
) -> dict:
    r = (await db.execute(
        select(DepositRequest).where(DepositRequest.id == req_id).with_for_update()
    )).scalar_one_or_none()
    if r is None:
        raise HTTPException(status_code=404, detail="Request not found")
    if r.status != "pending":
        raise HTTPException(status_code=400, detail="Request is not pending")

    qr = (admin_qr or "").strip() or None
    bank = (admin_bank_text or "").strip() or None
    upi = (admin_upi or "").strip() or None
    if not (qr or bank or upi):
        raise HTTPException(
            status_code=400,
            detail="Provide at least one of: QR image, bank details, or UPI id.",
        )

    r.status = "approved"
    r.admin_qr = qr
    r.admin_bank_text = bank
    r.admin_upi = upi
    r.admin_note = (admin_note or "").strip() or None
    r.approved_by = admin_id
    r.responded_at = datetime.now(timezone.utc)

    await write_audit_log(
        db, admin_id, "approve_deposit_request", "deposit_request", req_id,
        new_values={"has_qr": bool(qr), "has_bank": bool(bank), "has_upi": bool(upi)},
        ip_address=ip_address,
    )

    # Notify the user their details are ready.
    try:
        from packages.common.src.notify import create_notification
        await create_notification(
            db, r.user_id,
            title="Your deposit details are ready",
            message="The admin has shared your personal payment details. Open the bank-deposit page to pay.",
            notif_type="success",
            action_url="/wallet/deposit/bank",
        )
    except Exception:
        pass

    await db.commit()
    return {"message": "Request approved", "id": str(r.id)}


async def reject_request(
    req_id: uuid.UUID, admin_id: uuid.UUID, *,
    admin_note: str | None, ip_address: str | None, db: AsyncSession,
) -> dict:
    r = (await db.execute(
        select(DepositRequest).where(DepositRequest.id == req_id).with_for_update()
    )).scalar_one_or_none()
    if r is None:
        raise HTTPException(status_code=404, detail="Request not found")
    if r.status != "pending":
        raise HTTPException(status_code=400, detail="Request is not pending")

    r.status = "rejected"
    r.admin_note = (admin_note or "").strip() or None
    r.approved_by = admin_id
    r.responded_at = datetime.now(timezone.utc)

    await write_audit_log(
        db, admin_id, "reject_deposit_request", "deposit_request", req_id,
        new_values={"note": r.admin_note}, ip_address=ip_address,
    )

    try:
        from packages.common.src.notify import create_notification
        await create_notification(
            db, r.user_id,
            title="Deposit request declined",
            message=(r.admin_note or "Your deposit-details request was declined. Please contact support."),
            notif_type="warning",
            action_url="/wallet",
        )
    except Exception:
        pass

    await db.commit()
    return {"message": "Request rejected", "id": str(r.id)}
