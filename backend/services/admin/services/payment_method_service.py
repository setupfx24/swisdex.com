"""Admin CRUD for deposit payment methods (XM-style flow config)."""
import uuid
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.models import PaymentMethod
from dependencies import write_audit_log


def _serialize(m: PaymentMethod) -> dict:
    return {
        "id": str(m.id),
        "method_key": m.method_key,
        "display_name": m.display_name,
        "enabled": bool(m.enabled),
        "sort_order": m.sort_order,
        "pay_currency": m.pay_currency,
        "qr_image": m.qr_image,
        "upi_id": m.upi_id,
        "bank_text": m.bank_text,
        "notice": m.notice,
        "declaration": m.declaration,
        "min_amount": float(m.min_amount) if m.min_amount is not None else None,
        "max_amount": float(m.max_amount) if m.max_amount is not None else None,
        "usd_rate": float(m.usd_rate) if m.usd_rate is not None else None,
        "withdrawal_usd_rate": float(m.withdrawal_usd_rate) if m.withdrawal_usd_rate is not None else None,
    }


async def list_all(db: AsyncSession) -> dict:
    rows = (await db.execute(
        select(PaymentMethod).order_by(PaymentMethod.sort_order, PaymentMethod.display_name)
    )).scalars().all()
    return {"items": [_serialize(m) for m in rows]}


def _apply(m: PaymentMethod, body: dict) -> None:
    if "display_name" in body and body["display_name"] is not None:
        m.display_name = str(body["display_name"]).strip()
    if "enabled" in body and body["enabled"] is not None:
        m.enabled = bool(body["enabled"])
    if "sort_order" in body and body["sort_order"] is not None:
        m.sort_order = int(body["sort_order"])
    if "pay_currency" in body and body["pay_currency"]:
        m.pay_currency = str(body["pay_currency"]).strip().upper()[:10]
    for fld in ("qr_image", "upi_id", "bank_text", "notice", "declaration"):
        if fld in body:
            v = body[fld]
            setattr(m, fld, (str(v).strip() or None) if v is not None else None)
    for fld in ("min_amount", "max_amount", "usd_rate", "withdrawal_usd_rate"):
        if fld in body:
            v = body[fld]
            setattr(m, fld, v if v not in (None, "") else None)
    m.updated_at = datetime.now(timezone.utc)


async def create(body: dict, admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession) -> dict:
    key = str(body.get("method_key") or "").strip().lower()
    if not key:
        raise HTTPException(status_code=400, detail="method_key is required")
    exists = (await db.execute(
        select(PaymentMethod.id).where(PaymentMethod.method_key == key)
    )).first()
    if exists is not None:
        raise HTTPException(status_code=400, detail="A method with this key already exists")

    m = PaymentMethod(method_key=key, display_name=str(body.get("display_name") or key).strip())
    _apply(m, body)
    db.add(m)
    await db.flush()
    await write_audit_log(db, admin_id, "create_payment_method", "payment_method", m.id,
                          new_values={"method_key": key}, ip_address=ip_address)
    await db.commit()
    return {"message": "Payment method created", "id": str(m.id)}


async def update(method_id: uuid.UUID, body: dict, admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession) -> dict:
    m = (await db.execute(
        select(PaymentMethod).where(PaymentMethod.id == method_id)
    )).scalar_one_or_none()
    if m is None:
        raise HTTPException(status_code=404, detail="Payment method not found")
    _apply(m, body)
    await write_audit_log(db, admin_id, "update_payment_method", "payment_method", method_id,
                          new_values={"display_name": m.display_name}, ip_address=ip_address)
    await db.commit()
    return {"message": "Payment method updated"}


async def delete(method_id: uuid.UUID, admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession) -> dict:
    m = (await db.execute(
        select(PaymentMethod).where(PaymentMethod.id == method_id)
    )).scalar_one_or_none()
    if m is None:
        raise HTTPException(status_code=404, detail="Payment method not found")
    await db.delete(m)
    await write_audit_log(db, admin_id, "delete_payment_method", "payment_method", method_id,
                          new_values={"deleted": True}, ip_address=ip_address)
    await db.commit()
    return {"message": "Payment method deleted"}
