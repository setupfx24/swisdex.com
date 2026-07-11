"""Admin Account Type Service — CRUD for account groups."""
import uuid

from fastapi import HTTPException
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.models import AccountGroup, TradingAccount
from packages.common.src.admin_schemas import AccountTypeIn, AccountTypeOut
from dependencies import write_audit_log


async def list_account_types(db: AsyncSession) -> dict:
    result = await db.execute(select(AccountGroup).order_by(AccountGroup.name))
    rows = result.scalars().all()
    return {
        "items": [
            AccountTypeOut(
                id=str(g.id),
                name=g.name,
                description=g.description,
                leverage_default=g.leverage_default or 100,
                max_leverage=g.max_leverage,
                spread_markup_default=g.spread_markup_default or 0,
                commission_default=g.commission_default or 0,
                minimum_deposit=g.minimum_deposit or 0,
                swap_free=bool(g.swap_free),
                is_demo=bool(g.is_demo),
                is_active=bool(g.is_active),
                insurance_enabled=bool(getattr(g, "insurance_enabled", True)),
                is_cent_account=bool(getattr(g, "is_cent_account", False)),
                lot_size_multiplier=float(getattr(g, "lot_size_multiplier", None) or 1.0),
                created_at=g.created_at,
            )
            for g in rows
        ]
    }


async def create_account_type(
    body: AccountTypeIn,
    admin_id: uuid.UUID,
    ip_address: str | None,
    db: AsyncSession,
) -> dict:
    # max_leverage validation: must be >= leverage_default when both set
    # (admin shouldn't be able to set a ceiling below the default — that
    # would be paradoxical and break new-account creation).
    if body.max_leverage is not None and body.leverage_default and body.max_leverage < body.leverage_default:
        raise HTTPException(
            status_code=400,
            detail="max_leverage must be >= leverage_default",
        )

    g = AccountGroup(
        name=body.name.strip(),
        description=body.description,
        leverage_default=body.leverage_default,
        max_leverage=body.max_leverage,
        spread_markup_default=body.spread_markup_default,
        commission_default=body.commission_default,
        minimum_deposit=body.minimum_deposit,
        swap_free=body.swap_free,
        is_demo=body.is_demo,
        is_active=body.is_active,
        insurance_enabled=body.insurance_enabled,
        is_cent_account=body.is_cent_account,
        lot_size_multiplier=body.lot_size_multiplier,
    )
    db.add(g)
    await db.flush()
    await write_audit_log(
        db, admin_id, "create_account_type", "account_group", g.id,
        new_values={"name": body.name},
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": "Account type created", "id": str(g.id)}


async def update_account_type(
    group_id: uuid.UUID,
    body: AccountTypeIn,
    admin_id: uuid.UUID,
    ip_address: str | None,
    db: AsyncSession,
) -> dict:
    result = await db.execute(select(AccountGroup).where(AccountGroup.id == group_id))
    g = result.scalar_one_or_none()
    if not g:
        raise HTTPException(status_code=404, detail="Account type not found")

    if body.max_leverage is not None and body.leverage_default and body.max_leverage < body.leverage_default:
        raise HTTPException(
            status_code=400,
            detail="max_leverage must be >= leverage_default",
        )

    g.name = body.name.strip()
    g.description = body.description
    g.leverage_default = body.leverage_default
    g.max_leverage = body.max_leverage
    g.spread_markup_default = body.spread_markup_default
    g.commission_default = body.commission_default
    g.minimum_deposit = body.minimum_deposit
    g.swap_free = body.swap_free
    g.is_demo = body.is_demo
    g.is_active = body.is_active
    g.insurance_enabled = body.insurance_enabled
    g.is_cent_account = body.is_cent_account
    g.lot_size_multiplier = body.lot_size_multiplier

    await write_audit_log(
        db, admin_id, "update_account_type", "account_group", group_id,
        new_values={"name": body.name},
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": "Account type updated"}


async def deactivate_account_type(
    group_id: uuid.UUID,
    admin_id: uuid.UUID,
    ip_address: str | None,
    db: AsyncSession,
) -> dict:
    result = await db.execute(select(AccountGroup).where(AccountGroup.id == group_id))
    g = result.scalar_one_or_none()
    if not g:
        raise HTTPException(status_code=404, detail="Account type not found")

    cnt_q = await db.execute(
        select(func.count()).select_from(TradingAccount).where(TradingAccount.account_group_id == group_id)
    )
    if int(cnt_q.scalar_one() or 0) > 0:
        raise HTTPException(
            status_code=400,
            detail="Cannot delete: trading accounts still use this type. Deactivate instead or reassign accounts.",
        )

    await db.delete(g)
    await write_audit_log(
        db, admin_id, "delete_account_type", "account_group", group_id,
        new_values={"deleted": True},
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": "Account type deleted"}
