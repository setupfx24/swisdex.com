"""Admin Business Service — IB applications, agents, commission plans, MLM config, sub-brokers."""
import uuid
import secrets
import string
from decimal import Decimal
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.models import (
    User, IBApplication, IBProfile, IBCommission, Referral,
    IBCommissionPlan, SystemSetting,
    MasterAccount, InvestorAllocation, CopyTrade,
    TradingAccount, Position, PositionStatus, TradeHistory, Transaction,
)
from packages.common.src.admin_schemas import (
    IBApplicationOut, IBProfileOut, PaginatedResponse,
    MLMConfigOut, MLMConfigIn, UpdateIBCommissionIn, RejectIBIn,
    IBCommissionPlanOut, IBCommissionPlanIn,
)
from dependencies import write_audit_log


async def get_company_ib(db: AsyncSession) -> dict:
    """Return the currently designated company / house IB along with its
    referral link and a referral-count stat. Used by the admin
    /business/ib panel.

    Empty payload (user fields = null) means no designation yet — the
    admin picks one from the IB dropdown.
    """
    from packages.common.src.settings_store import (
        get_bool_setting, get_system_setting,
    )

    raw_uid = await get_system_setting("company_ib_user_id", None)
    attach = await get_bool_setting("company_ib_attach_unreferred", False)

    out: dict = {
        "user_id": None,
        "user_email": None,
        "ib_profile_id": None,
        "referral_code": None,
        "referral_link": None,
        "referrals_count": 0,
        "attach_unreferred": bool(attach),
    }

    if not raw_uid or not isinstance(raw_uid, str) or not raw_uid.strip():
        return out

    try:
        import uuid as _uuid
        uid = _uuid.UUID(raw_uid.strip())
    except (ValueError, AttributeError):
        return out

    user_row = (await db.execute(select(User).where(User.id == uid))).scalar_one_or_none()
    if user_row is None:
        return out
    ib_row = (await db.execute(
        select(IBProfile).where(IBProfile.user_id == uid)
    )).scalar_one_or_none()
    if ib_row is None:
        # User exists but has no IB profile — show it so admin sees the
        # broken state and can fix it from the panel.
        return {**out, "user_id": str(user_row.id), "user_email": user_row.email}

    # Build a marketing-friendly link from the broker's public frontend
    # URL (falls back to the canonical swisdex.com when env isn't set).
    from packages.common.src.config import get_settings as _gs
    base_url = (_gs().TRADER_APP_URL or "https://swisdex.com").rstrip("/")
    link = f"{base_url}/auth/register?ref={ib_row.referral_code}"

    n = (await db.execute(
        select(func.count()).select_from(Referral).where(
            Referral.ib_profile_id == ib_row.id,
        )
    )).scalar() or 0

    return {
        "user_id": str(user_row.id),
        "user_email": user_row.email,
        "ib_profile_id": str(ib_row.id),
        "referral_code": ib_row.referral_code,
        "referral_link": link,
        "referrals_count": int(n),
        "attach_unreferred": bool(attach),
    }


async def set_company_ib(
    user_id_str: str,
    attach_unreferred: bool,
    admin_id,
    ip_address: str | None,
    db: AsyncSession,
) -> dict:
    """Designate (or clear) the company / house IB.

    Pass an empty string to clear. Otherwise the user_id MUST be an
    existing user with an active IBProfile — we validate before saving
    so the admin doesn't accidentally point at a non-IB user.
    """
    from packages.common.src.settings_store import invalidate_cache

    cleaned = (user_id_str or "").strip()
    if cleaned:
        try:
            import uuid as _uuid
            uid = _uuid.UUID(cleaned)
        except (ValueError, AttributeError):
            raise HTTPException(status_code=400, detail="Invalid user_id format")
        ib_row = (await db.execute(
            select(IBProfile).where(
                IBProfile.user_id == uid,
                IBProfile.is_active == True,
            )
        )).scalar_one_or_none()
        if ib_row is None:
            raise HTTPException(
                status_code=400,
                detail="Selected user does not have an active IB profile",
            )

    # Upsert both settings rows in one shot.
    now = datetime.utcnow()
    for key, value in [
        ("company_ib_user_id", cleaned),
        ("company_ib_attach_unreferred", bool(attach_unreferred)),
    ]:
        existing = (await db.execute(
            select(SystemSetting).where(SystemSetting.key == key)
        )).scalar_one_or_none()
        if existing is None:
            db.add(SystemSetting(key=key, value=value, updated_by=admin_id))
        else:
            existing.value = value
            existing.updated_by = admin_id
            existing.updated_at = now

    await write_audit_log(
        db, admin_id, "set_company_ib", "system_setting", None,
        new_values={
            "company_ib_user_id": cleaned,
            "company_ib_attach_unreferred": bool(attach_unreferred),
        },
        ip_address=ip_address,
    )
    await db.commit()
    await invalidate_cache()
    return await get_company_ib(db)


async def referral_program_overview(
    page: int, per_page: int, db: AsyncSession,
) -> dict:
    """Admin-side stats + recent payouts for the user-level referral
    program (NOT the IB MLM tree — that's covered by ib_tree).

    Money was credited via wallet_service / deposit_service writing a
    Transaction row with type='referral_commission' on every first-deposit
    payout. We pull aggregates from those rows here so no new ledger is
    needed.
    """
    # Engine actually reads these — the legacy `referral_commission_pct`
    # row is kept around for old-client compatibility but no code path
    # honours it any more. Surface the real gate config so the admin
    # /business/referral page can edit what's enforced.
    async def _read(key: str, default):
        row = (await db.execute(
            select(SystemSetting).where(SystemSetting.key == key)
        )).scalar_one_or_none()
        return row.value if row and row.value is not None else default

    legacy_pct_raw = await _read("referral_commission_pct", "5")
    try:
        cur_pct = float(legacy_pct_raw)
    except (TypeError, ValueError):
        cur_pct = 5.0

    try:
        bounty_usd = float(await _read("referral_commission_amount_usd", "5"))
    except (TypeError, ValueError):
        bounty_usd = 5.0

    try:
        qualifying_trades = int(float(await _read("referral_qualifying_trades", "3")))
    except (TypeError, ValueError):
        qualifying_trades = 3

    def _flag(raw, default: bool) -> bool:
        if isinstance(raw, bool):
            return raw
        if isinstance(raw, (int, float)):
            return bool(raw)
        if isinstance(raw, str):
            return raw.strip().lower() in {"1", "true", "yes", "on"}
        return default

    requires_kyc = _flag(await _read("referral_requires_kyc", "true"), True)
    requires_funded = _flag(await _read("referral_requires_funded", "true"), True)

    total_paid = (await db.execute(
        select(func.coalesce(func.sum(Transaction.amount), 0))
        .where(Transaction.type == "referral_commission")
    )).scalar() or 0

    total_payouts = (await db.execute(
        select(func.count()).select_from(Transaction)
        .where(Transaction.type == "referral_commission")
    )).scalar() or 0

    total_referred_users = (await db.execute(
        select(func.count()).select_from(User)
        .where(User.referred_by_user_id.is_not(None))
    )).scalar() or 0

    # Top 5 referrers by total commission earned.
    top_rows = (await db.execute(
        select(
            Transaction.user_id.label("user_id"),
            func.sum(Transaction.amount).label("earned"),
            func.count().label("payouts"),
        )
        .where(Transaction.type == "referral_commission")
        .group_by(Transaction.user_id)
        .order_by(func.sum(Transaction.amount).desc())
        .limit(5)
    )).all()
    top_referrers: list[dict] = []
    for r in top_rows:
        u = (await db.execute(select(User).where(User.id == r.user_id))).scalar_one_or_none()
        top_referrers.append({
            "user_id": str(r.user_id),
            "name": (u.first_name or "") + (f" {u.last_name}" if u and u.last_name else "") if u else "",
            "email": u.email if u else "",
            "earned": float(r.earned or 0),
            "payouts": int(r.payouts or 0),
        })

    # Paginated recent payouts.
    offset = (page - 1) * per_page
    payout_rows = (await db.execute(
        select(Transaction)
        .where(Transaction.type == "referral_commission")
        .order_by(Transaction.created_at.desc())
        .offset(offset).limit(per_page)
    )).scalars().all()
    items: list[dict] = []
    for tx in payout_rows:
        receiver = (await db.execute(select(User).where(User.id == tx.user_id))).scalar_one_or_none()
        items.append({
            "id": str(tx.id),
            "referrer_user_id": str(tx.user_id),
            "referrer_email": receiver.email if receiver else "",
            "amount": float(tx.amount or 0),
            "description": tx.description or "",
            "deposit_id": str(tx.reference_id) if tx.reference_id else None,
            "created_at": tx.created_at.isoformat() if tx.created_at else None,
        })

    return {
        # Kept for backwards-compat with older admin clients; new clients
        # should use bounty_usd + the gate flags below.
        "commission_pct": cur_pct,
        "bounty_usd": bounty_usd,
        "qualifying_trades": qualifying_trades,
        "requires_kyc": requires_kyc,
        "requires_funded": requires_funded,
        "total_paid": float(total_paid),
        "total_payouts": int(total_payouts),
        "total_referred_users": int(total_referred_users),
        "top_referrers": top_referrers,
        "recent_payouts": {
            "items": items,
            "page": page,
            "per_page": per_page,
            "total": int(total_payouts),
        },
    }


async def list_ib_applications(
    page: int, per_page: int, status_filter: str | None, db: AsyncSession,
):
    query = select(IBApplication)
    if status_filter:
        query = query.where(IBApplication.status == status_filter)

    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0

    query = query.order_by(IBApplication.created_at.desc()).offset((page - 1) * per_page).limit(per_page)
    result = await db.execute(query)
    apps = result.scalars().all()

    items = []
    for app in apps:
        user_q = await db.execute(select(User).where(User.id == app.user_id))
        user = user_q.scalar_one_or_none()
        items.append(IBApplicationOut(
            id=str(app.id),
            user_id=str(app.user_id),
            status=app.status,
            application_data=app.application_data,
            approved_by=str(app.approved_by) if app.approved_by else None,
            approved_at=app.approved_at,
            created_at=app.created_at,
            user_email=user.email if user else None,
            user_name=f"{user.first_name or ''} {user.last_name or ''}".strip() if user else None,
        ))

    return PaginatedResponse(items=items, total=total, page=page, per_page=per_page)


async def approve_ib_application(
    app_id: uuid.UUID, admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
) -> dict:
    result = await db.execute(select(IBApplication).where(IBApplication.id == app_id))
    app = result.scalar_one_or_none()
    if not app:
        raise HTTPException(status_code=404, detail="Application not found")
    if app.status != "pending":
        raise HTTPException(status_code=400, detail="Application is not pending")

    user_q = await db.execute(select(User).where(User.id == app.user_id))
    user = user_q.scalar_one_or_none()
    # KYC gate (client 2026-06-29): an IB cannot be approved until the applicant
    # has cleared KYC. Blocks promoting a user who applied before finishing KYC.
    if user is None or (user.kyc_status or "pending").lower() not in ("approved", "verified"):
        raise HTTPException(
            status_code=400,
            detail="User has not completed KYC verification — cannot approve as IB.",
        )

    app.status = "approved"
    app.approved_by = admin_id
    app.approved_at = datetime.utcnow()
    user.role = "ib"

    referral_code = "IB" + "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(8))

    default_plan_q = await db.execute(
        select(IBCommissionPlan).where(IBCommissionPlan.is_default == True)
    )
    default_plan = default_plan_q.scalar_one_or_none()

    # Auto-detect parent IB: if this user was referred by an IB, link as child
    parent_ib_id = None
    parent_level = 0
    referral_q = await db.execute(
        select(Referral).where(Referral.referred_id == app.user_id)
    )
    referral = referral_q.scalar_one_or_none()
    if referral and referral.ib_profile_id:
        parent_q = await db.execute(
            select(IBProfile).where(IBProfile.id == referral.ib_profile_id, IBProfile.is_active == True)
        )
        parent_ib = parent_q.scalar_one_or_none()
        if parent_ib:
            parent_ib_id = parent_ib.id
            parent_level = parent_ib.level or 1

    profile = IBProfile(
        user_id=app.user_id,
        referral_code=referral_code,
        level=parent_level + 1,
        parent_ib_id=parent_ib_id,
        commission_plan_id=default_plan.id if default_plan else None,
    )
    db.add(profile)

    await write_audit_log(
        db, admin_id, "approve_ib_application", "ib_application", app_id,
        new_values={"status": "approved", "referral_code": referral_code},
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": "IB application approved", "referral_code": referral_code}


async def reject_ib_application(
    app_id: uuid.UUID, admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
) -> dict:
    result = await db.execute(select(IBApplication).where(IBApplication.id == app_id))
    app = result.scalar_one_or_none()
    if not app:
        raise HTTPException(status_code=404, detail="Application not found")
    if app.status != "pending":
        raise HTTPException(status_code=400, detail="Application is not pending")

    app.status = "rejected"
    app.approved_by = admin_id
    app.approved_at = datetime.utcnow()

    await write_audit_log(
        db, admin_id, "reject_ib_application", "ib_application", app_id,
        new_values={"status": "rejected"},
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": "IB application rejected"}


async def list_ib_agents(page: int, per_page: int, db: AsyncSession):
    query = select(IBProfile).where(IBProfile.is_active == True)
    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0

    query = query.order_by(IBProfile.created_at.desc()).offset((page - 1) * per_page).limit(per_page)
    result = await db.execute(query)
    profiles = result.scalars().all()

    super_id = await _super_ib_profile_id(db)  # for role classification
    items = []
    for p in profiles:
        user_q = await db.execute(select(User).where(User.id == p.user_id))
        user = user_q.scalar_one_or_none()

        ref_count_q = await db.execute(
            select(func.count(Referral.id)).where(Referral.ib_profile_id == p.id)
        )
        ref_count = ref_count_q.scalar() or 0

        items.append(IBProfileOut(
            id=str(p.id),
            user_id=str(p.user_id),
            referral_code=p.referral_code,
            parent_ib_id=str(p.parent_ib_id) if p.parent_ib_id else None,
            level=p.level or 1,
            commission_plan_id=str(p.commission_plan_id) if p.commission_plan_id else None,
            custom_commission_per_lot=float(p.custom_commission_per_lot) if p.custom_commission_per_lot else None,
            custom_commission_per_trade=float(p.custom_commission_per_trade) if p.custom_commission_per_trade else None,
            tier_override=getattr(p, "tier_override", None),
            total_earned=float(p.total_earned or 0),
            pending_payout=float(p.pending_payout or 0),
            is_active=p.is_active,
            created_at=p.created_at,
            user_email=user.email if user else None,
            user_name=f"{user.first_name or ''} {user.last_name or ''}".strip() if user else None,
            referral_count=ref_count,
            ib_type=_classify_ib_type(p, super_id),
        ))

    return PaginatedResponse(items=items, total=total, page=page, per_page=per_page)


async def update_ib_commission(
    agent_id: uuid.UUID, body: UpdateIBCommissionIn,
    admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
) -> dict:
    result = await db.execute(select(IBProfile).where(IBProfile.id == agent_id))
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="IB profile not found")

    old_values = {
        "commission_plan_id": str(profile.commission_plan_id) if profile.commission_plan_id else None,
        "custom_commission_per_lot": float(profile.custom_commission_per_lot) if profile.custom_commission_per_lot else None,
        "custom_commission_per_trade": float(profile.custom_commission_per_trade) if profile.custom_commission_per_trade else None,
        "tier_override": getattr(profile, "tier_override", None),
    }

    # Manual tier override (client spec 2026-06-16). None = leave unchanged;
    # "" / "auto" / "none" clears it back to automatic tier resolution.
    if body.tier_override is not None:
        val = body.tier_override.strip()
        profile.tier_override = None if val.lower() in ("", "auto", "none") else val

    if body.commission_plan_id and body.commission_plan_id not in ('default', 'custom', 'null', ''):
        try:
            profile.commission_plan_id = uuid.UUID(body.commission_plan_id)
        except (ValueError, AttributeError):
            raise HTTPException(status_code=400, detail=f"Invalid commission plan ID: {body.commission_plan_id}")
        profile.custom_commission_per_lot = None
        profile.custom_commission_per_trade = None
    else:
        profile.commission_plan_id = None
        if body.custom_commission_per_lot is not None:
            profile.custom_commission_per_lot = body.custom_commission_per_lot
        if body.custom_commission_per_trade is not None:
            profile.custom_commission_per_trade = body.custom_commission_per_trade

    new_values = {
        "commission_plan_id": str(profile.commission_plan_id) if profile.commission_plan_id else None,
        "custom_commission_per_lot": float(profile.custom_commission_per_lot) if profile.custom_commission_per_lot else None,
        "custom_commission_per_trade": float(profile.custom_commission_per_trade) if profile.custom_commission_per_trade else None,
        "tier_override": getattr(profile, "tier_override", None),
    }

    await write_audit_log(
        db, admin_id, "update_ib_commission", "ib_profile", agent_id,
        old_values=old_values, new_values=new_values,
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": "IB commission updated successfully"}


# ─── Custom referral_code editing ────────────────────────────────────────
# The IB approval path auto-generates an `IB + 8-char random` code. Admins
# sometimes need a vanity code for a known IB (e.g. the Super IB / house
# master) — "SDASIA" reads better in marketing than "IB7H2KQ9". This
# endpoint lets a super-admin overwrite the code with strict validation.

_REF_CODE_MIN = 3
_REF_CODE_MAX = 20


def _validate_referral_code(raw: str) -> str:
    code = (raw or "").strip().upper()
    if not code:
        raise HTTPException(status_code=400, detail="Referral code is required")
    if len(code) < _REF_CODE_MIN or len(code) > _REF_CODE_MAX:
        raise HTTPException(
            status_code=400,
            detail=f"Referral code must be {_REF_CODE_MIN}-{_REF_CODE_MAX} characters",
        )
    # Allow A-Z 0-9 only — keeps copy-paste in marketing material clean
    # and survives case-insensitive URL parsers.
    import re as _re
    if not _re.fullmatch(r"[A-Z0-9]+", code):
        raise HTTPException(
            status_code=400,
            detail="Referral code may only contain A-Z and 0-9 (no spaces or punctuation)",
        )
    return code


async def update_ib_referral_code(
    agent_id: uuid.UUID,
    new_code: str,
    admin_id: uuid.UUID,
    ip_address: str | None,
    db: AsyncSession,
) -> dict:
    """Overwrite an IB's referral_code with an admin-supplied vanity value.
    Validates length + charset, enforces uniqueness across active codes,
    audit-logs the old → new transition."""
    code = _validate_referral_code(new_code)

    profile = (await db.execute(
        select(IBProfile).where(IBProfile.id == agent_id)
    )).scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="IB profile not found")

    if profile.referral_code == code:
        return {"message": "No change", "referral_code": code}

    clash = (await db.execute(
        select(IBProfile.id).where(
            IBProfile.referral_code == code,
            IBProfile.id != agent_id,
        )
    )).first()
    if clash:
        raise HTTPException(
            status_code=409,
            detail=f"Referral code '{code}' is already in use by another IB",
        )

    old_code = profile.referral_code
    profile.referral_code = code

    await write_audit_log(
        db, admin_id, "update_ib_referral_code", "ib_profile", agent_id,
        old_values={"referral_code": old_code},
        new_values={"referral_code": code},
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": "Referral code updated", "referral_code": code}


async def reject_active_ib(
    agent_id: uuid.UUID, body: RejectIBIn,
    admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
) -> dict:
    result = await db.execute(select(IBProfile).where(IBProfile.id == agent_id))
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="IB profile not found")

    profile.is_active = False
    profile.rejection_reason = body.reason
    profile.rejected_at = datetime.utcnow()
    profile.rejected_by = admin_id

    user_q = await db.execute(select(User).where(User.id == profile.user_id))
    user = user_q.scalar_one_or_none()
    if user and user.role == "ib":
        user.role = "user"

    await write_audit_log(
        db, admin_id, "reject_active_ib", "ib_profile", agent_id,
        new_values={"is_active": False, "reason": body.reason},
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": "IB rejected successfully"}


async def list_commission_plans(db: AsyncSession) -> dict:
    result = await db.execute(select(IBCommissionPlan).order_by(IBCommissionPlan.is_default.desc(), IBCommissionPlan.created_at.desc()))
    plans = result.scalars().all()
    items = [IBCommissionPlanOut(
        id=str(p.id),
        name=p.name,
        is_default=p.is_default,
        commission_per_lot=float(p.commission_per_lot or 0),
        commission_per_trade=float(p.commission_per_trade or 0),
        spread_share_pct=float(p.spread_share_pct or 0),
        cpa_per_deposit=float(p.cpa_per_deposit or 0),
        mlm_levels=p.mlm_levels or 5,
        mlm_distribution=p.mlm_distribution or [40, 25, 15, 10, 10],
        created_at=p.created_at,
    ) for p in plans]
    return {"items": items}


async def create_commission_plan(
    body: IBCommissionPlanIn, admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
) -> dict:
    if body.is_default:
        result = await db.execute(select(IBCommissionPlan).where(IBCommissionPlan.is_default == True))
        existing_default = result.scalar_one_or_none()
        if existing_default:
            existing_default.is_default = False

    plan = IBCommissionPlan(
        name=body.name,
        is_default=body.is_default,
        commission_per_lot=body.commission_per_lot,
        commission_per_trade=body.commission_per_trade,
        spread_share_pct=body.spread_share_pct,
        cpa_per_deposit=body.cpa_per_deposit,
        mlm_levels=body.mlm_levels,
        mlm_distribution=body.mlm_distribution,
    )
    db.add(plan)

    await write_audit_log(
        db, admin_id, "create_commission_plan", "ib_commission_plan", plan.id,
        new_values={"name": body.name, "is_default": body.is_default},
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": "Commission plan created successfully", "id": str(plan.id)}


async def update_commission_plan(
    plan_id: uuid.UUID, body: IBCommissionPlanIn,
    admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
) -> dict:
    result = await db.execute(select(IBCommissionPlan).where(IBCommissionPlan.id == plan_id))
    plan = result.scalar_one_or_none()
    if not plan:
        raise HTTPException(status_code=404, detail="Commission plan not found")

    if body.is_default and not plan.is_default:
        existing_q = await db.execute(select(IBCommissionPlan).where(IBCommissionPlan.is_default == True))
        existing_default = existing_q.scalar_one_or_none()
        if existing_default:
            existing_default.is_default = False

    plan.name = body.name
    plan.is_default = body.is_default
    plan.commission_per_lot = body.commission_per_lot
    plan.commission_per_trade = body.commission_per_trade
    plan.spread_share_pct = body.spread_share_pct
    plan.cpa_per_deposit = body.cpa_per_deposit
    plan.mlm_levels = body.mlm_levels
    plan.mlm_distribution = body.mlm_distribution

    await write_audit_log(
        db, admin_id, "update_commission_plan", "ib_commission_plan", plan_id,
        new_values={"name": body.name, "is_default": body.is_default},
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": "Commission plan updated successfully"}


async def delete_commission_plan(
    plan_id: uuid.UUID, admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
) -> dict:
    result = await db.execute(select(IBCommissionPlan).where(IBCommissionPlan.id == plan_id))
    plan = result.scalar_one_or_none()
    if not plan:
        raise HTTPException(status_code=404, detail="Commission plan not found")

    if plan.is_default:
        raise HTTPException(status_code=400, detail="Cannot delete default commission plan")

    await db.delete(plan)
    await write_audit_log(
        db, admin_id, "delete_commission_plan", "ib_commission_plan", plan_id,
        old_values={"name": plan.name},
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": "Commission plan deleted successfully"}


async def get_mlm_config(db: AsyncSession):
    levels_q = await db.execute(
        select(SystemSetting).where(SystemSetting.key == "mlm_levels")
    )
    levels_setting = levels_q.scalar_one_or_none()

    dist_q = await db.execute(
        select(SystemSetting).where(SystemSetting.key == "mlm_distribution")
    )
    dist_setting = dist_q.scalar_one_or_none()

    return MLMConfigOut(
        mlm_levels=int(levels_setting.value) if levels_setting else 5,
        mlm_distribution=dist_setting.value if dist_setting else [40, 25, 15, 10, 10],
    )


async def update_mlm_config(
    body: MLMConfigIn, admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
) -> dict:
    levels_q = await db.execute(
        select(SystemSetting).where(SystemSetting.key == "mlm_levels")
    )
    levels_setting = levels_q.scalar_one_or_none()
    if levels_setting:
        levels_setting.value = body.mlm_levels
        levels_setting.updated_by = admin_id
        levels_setting.updated_at = datetime.utcnow()
    else:
        db.add(SystemSetting(
            key="mlm_levels", value=body.mlm_levels,
            description="Number of MLM levels for IB",
            updated_by=admin_id,
        ))

    dist_q = await db.execute(
        select(SystemSetting).where(SystemSetting.key == "mlm_distribution")
    )
    dist_setting = dist_q.scalar_one_or_none()
    if dist_setting:
        dist_setting.value = body.mlm_distribution
        dist_setting.updated_by = admin_id
        dist_setting.updated_at = datetime.utcnow()
    else:
        db.add(SystemSetting(
            key="mlm_distribution", value=body.mlm_distribution,
            description="MLM distribution per level (%)",
            updated_by=admin_id,
        ))

    await write_audit_log(
        db, admin_id, "update_mlm_config", "system_setting", None,
        new_values={"mlm_levels": body.mlm_levels, "mlm_distribution": body.mlm_distribution},
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": "MLM config updated"}


async def list_sub_broker_applications(
    page: int, per_page: int, status_filter: str | None, db: AsyncSession,
):
    query = select(IBApplication).where(
        IBApplication.application_data["type"].as_string() == "sub_broker"
    )
    if status_filter:
        query = query.where(IBApplication.status == status_filter)

    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0

    query = query.order_by(IBApplication.created_at.desc()).offset((page - 1) * per_page).limit(per_page)
    result = await db.execute(query)
    apps = result.scalars().all()

    items = []
    for app in apps:
        user_q = await db.execute(select(User).where(User.id == app.user_id))
        user = user_q.scalar_one_or_none()
        items.append({
            "id": str(app.id),
            "user_id": str(app.user_id),
            "user_name": f"{user.first_name or ''} {user.last_name or ''}".strip() if user else None,
            "user_email": user.email if user else None,
            "status": app.status,
            "company_name": (app.application_data or {}).get("company_name"),
            "created_at": app.created_at.isoformat() if app.created_at else None,
        })

    return PaginatedResponse(items=items, total=total, page=page, per_page=per_page)


async def approve_sub_broker(
    app_id: uuid.UUID, admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
) -> dict:
    result = await db.execute(select(IBApplication).where(IBApplication.id == app_id))
    app = result.scalar_one_or_none()
    if not app:
        raise HTTPException(status_code=404, detail="Application not found")
    if app.status != "pending":
        raise HTTPException(status_code=400, detail="Application is not pending")

    user_q = await db.execute(select(User).where(User.id == app.user_id))
    user = user_q.scalar_one_or_none()
    # KYC gate (client 2026-06-29): a Sub-IB cannot be approved until the
    # applicant has cleared KYC.
    if user is None or (user.kyc_status or "pending").lower() not in ("approved", "verified"):
        raise HTTPException(
            status_code=400,
            detail="User has not completed KYC verification — cannot approve as Sub-IB.",
        )

    app.status = "approved"
    app.approved_by = admin_id
    app.approved_at = datetime.utcnow()
    user.role = "sub_broker"

    referral_code = "SB" + "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(8))

    # Link the new Sub-IB under its introducing IB. A sub-broker is always a
    # deeper node (a user who joined via another IB's code), so its IBProfile
    # MUST carry parent_ib_id — otherwise _resolve_ib_type sees a NULL parent
    # and wrongly classifies it as a full IB, AND the per-lot MLM commission
    # engine (which walks up via parent_ib_id) can't pay the uplines. Detect
    # the parent from the Referral row written at signup, mirroring
    # approve_ib_application.
    parent_ib_id = None
    parent_level = 0
    referral_q = await db.execute(
        select(Referral).where(Referral.referred_id == app.user_id)
    )
    referral = referral_q.scalar_one_or_none()
    if referral and referral.ib_profile_id:
        parent_q = await db.execute(
            select(IBProfile).where(IBProfile.id == referral.ib_profile_id, IBProfile.is_active == True)
        )
        parent_ib = parent_q.scalar_one_or_none()
        if parent_ib:
            parent_ib_id = parent_ib.id
            parent_level = parent_ib.level or 1

    profile = IBProfile(
        user_id=app.user_id,
        referral_code=referral_code,
        level=parent_level + 1,
        parent_ib_id=parent_ib_id,
    )
    db.add(profile)

    await write_audit_log(
        db, admin_id, "approve_sub_broker", "ib_application", app_id,
        new_values={"status": "approved", "referral_code": referral_code},
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": "Sub-broker approved", "referral_code": referral_code}


async def reject_sub_broker(
    app_id: uuid.UUID, admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
) -> dict:
    result = await db.execute(select(IBApplication).where(IBApplication.id == app_id))
    app = result.scalar_one_or_none()
    if not app:
        raise HTTPException(status_code=404, detail="Application not found")
    if app.status != "pending":
        raise HTTPException(status_code=400, detail="Not pending")

    app.status = "rejected"
    app.approved_by = admin_id
    app.approved_at = datetime.utcnow()

    await write_audit_log(
        db, admin_id, "reject_sub_broker", "ib_application", app_id,
        new_values={"status": "rejected"},
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": "Sub-broker rejected"}


async def list_sub_brokers(page: int, per_page: int, db: AsyncSession):
    query = select(User).where(User.role == "sub_broker", User.status == "active")
    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0

    query = query.order_by(User.created_at.desc()).offset((page - 1) * per_page).limit(per_page)
    result = await db.execute(query)
    users = result.scalars().all()

    items = []
    for u in users:
        profile_q = await db.execute(select(IBProfile).where(IBProfile.user_id == u.id))
        profile = profile_q.scalar_one_or_none()

        ref_count = 0
        total_earned = 0.0
        if profile:
            rc = await db.execute(select(func.count(Referral.id)).where(Referral.ib_profile_id == profile.id))
            ref_count = rc.scalar() or 0
            total_earned = float(profile.total_earned or 0)

        items.append({
            "id": str(u.id),
            "user_id": str(u.id),
            "user_name": f"{u.first_name or ''} {u.last_name or ''}".strip(),
            "user_email": u.email,
            "referral_code": profile.referral_code if profile else "—",
            "clients_count": ref_count,
            "total_earned": total_earned,
            "created_at": u.created_at.isoformat() if u.created_at else None,
        })

    return PaginatedResponse(items=items, total=total, page=page, per_page=per_page)


# ─── IB Hierarchy Management ──────────────────────────────────────────────

async def set_parent_ib(
    ib_id: uuid.UUID, parent_ib_id: uuid.UUID | None,
    admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
) -> dict:
    """Admin assigns/changes the parent IB of an IB profile."""
    result = await db.execute(select(IBProfile).where(IBProfile.id == ib_id))
    ib = result.scalar_one_or_none()
    if not ib:
        raise HTTPException(status_code=404, detail="IB not found")

    old_parent = str(ib.parent_ib_id) if ib.parent_ib_id else None

    if parent_ib_id:
        if parent_ib_id == ib_id:
            raise HTTPException(status_code=400, detail="IB cannot be its own parent")
        parent_q = await db.execute(select(IBProfile).where(IBProfile.id == parent_ib_id))
        parent = parent_q.scalar_one_or_none()
        if not parent:
            raise HTTPException(status_code=404, detail="Parent IB not found")
        # Circular check
        check = parent
        for _ in range(20):
            if check.parent_ib_id is None:
                break
            if check.parent_ib_id == ib_id:
                raise HTTPException(status_code=400, detail="Circular hierarchy detected")
            chk_q = await db.execute(select(IBProfile).where(IBProfile.id == check.parent_ib_id))
            check = chk_q.scalar_one_or_none()
            if not check:
                break
        ib.parent_ib_id = parent_ib_id
        ib.level = (parent.level or 1) + 1
    else:
        ib.parent_ib_id = None
        ib.level = 1

    await write_audit_log(db, admin_id, "set_parent_ib", "ib_profile", ib_id,
        old_values={"parent_ib_id": old_parent},
        new_values={"parent_ib_id": str(parent_ib_id) if parent_ib_id else None},
        ip_address=ip_address)
    await db.commit()
    return {"message": "Parent IB updated", "ib_id": str(ib_id), "level": ib.level}


async def move_user_to_ib(
    user_id: uuid.UUID, new_ib_id: uuid.UUID,
    admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
) -> dict:
    """Admin moves a trader from one IB to another."""
    ib_q = await db.execute(select(IBProfile).where(IBProfile.id == new_ib_id, IBProfile.is_active == True))
    new_ib = ib_q.scalar_one_or_none()
    if not new_ib:
        raise HTTPException(status_code=404, detail="Target IB not found")

    ref_q = await db.execute(select(Referral).where(Referral.referred_id == user_id))
    referral = ref_q.scalar_one_or_none()
    old_ib = str(referral.ib_profile_id) if referral and referral.ib_profile_id else None

    if referral:
        referral.ib_profile_id = new_ib.id
        referral.referrer_id = new_ib.user_id
    else:
        db.add(Referral(referrer_id=new_ib.user_id, referred_id=user_id, ib_profile_id=new_ib.id))

    await write_audit_log(db, admin_id, "move_user_to_ib", "referral", user_id,
        old_values={"ib_profile_id": old_ib},
        new_values={"ib_profile_id": str(new_ib.id)},
        ip_address=ip_address)
    await db.commit()
    return {"message": "User moved", "user_id": str(user_id), "new_ib_referral_code": new_ib.referral_code}


async def _super_ib_profile_id(db: AsyncSession) -> uuid.UUID | None:
    """The ONE platform Super IB: the IBProfile whose referral_code matches the
    `super_ib_code` setting (default 'SDA05'). Same source of truth the gateway
    uses (_resolve_ib_type). The admin tree must classify roles by THIS, never
    by tree depth/level — otherwise every parent-less root IB wrongly shows as
    "Super IB" (client 2026-07-09). Returns None if none configured."""
    from packages.common.src.settings_store import get_system_setting
    code = str(await get_system_setting("super_ib_code", None) or "SDA05").strip()
    if not code:
        return None
    row = (await db.execute(
        select(IBProfile.id).where(IBProfile.referral_code == code)
    )).first()
    return row[0] if row else None


def _classify_ib_type(profile, super_id: uuid.UUID | None) -> str:
    """Mirror of the gateway's _resolve_ib_type: 'super_ib' is ONLY the SDA05
    root; a profile directly under it (or parent-less) is a full 'ib'; anything
    deeper is a 'sub_ib'. Role is by lineage, NOT by tree depth."""
    if super_id is not None:
        if profile.id == super_id:
            return "super_ib"
        if profile.parent_ib_id is None or profile.parent_ib_id == super_id:
            return "ib"
        return "sub_ib"
    return "ib" if profile.parent_ib_id is None else "sub_ib"


async def get_ib_tree(ib_id: uuid.UUID | None, db: AsyncSession) -> list[dict]:
    """Full IB hierarchy tree. ib_id=None returns all root IBs."""
    super_id = await _super_ib_profile_id(db)
    if ib_id:
        root_q = await db.execute(select(IBProfile).where(IBProfile.id == ib_id))
        root = root_q.scalar_one_or_none()
        return [await _build_ib_node(root, db, super_id)] if root else []
    roots_q = await db.execute(
        select(IBProfile).where(IBProfile.parent_ib_id.is_(None), IBProfile.is_active == True)
        .order_by(IBProfile.created_at))
    return [await _build_ib_node(r, db, super_id) for r in roots_q.scalars().all()]


async def _build_ib_node(ib, db: AsyncSession, super_id: uuid.UUID | None = None, depth: int = 0) -> dict:
    if depth > 10:
        return {}
    user_q = await db.execute(select(User).where(User.id == ib.user_id))
    user = user_q.scalar_one_or_none()
    ref_count = (await db.execute(
        select(func.count(Referral.id)).where(Referral.ib_profile_id == ib.id)
    )).scalar() or 0
    children_q = await db.execute(
        select(IBProfile).where(IBProfile.parent_ib_id == ib.id, IBProfile.is_active == True))
    children = children_q.scalars().all()
    return {
        "id": str(ib.id), "user_id": str(ib.user_id),
        "email": user.email if user else "?",
        "name": f"{user.first_name or ''} {user.last_name or ''}".strip() if user else "?",
        "referral_code": ib.referral_code, "level": ib.level or 1,
        "ib_type": _classify_ib_type(ib, super_id),
        "total_earned": float(ib.total_earned or 0), "referral_count": ref_count,
        "children": [await _build_ib_node(c, db, super_id, depth + 1) for c in children],
    }


async def get_unassigned_users(page: int, per_page: int, db: AsyncSession) -> dict:
    """Users who are not referred under any active IB."""
    from sqlalchemy import not_, exists
    subq = select(Referral.referred_id).where(Referral.ib_profile_id.isnot(None)).scalar_subquery()
    query = select(User).where(
        User.role.notin_(["ib", "sub_broker", "admin", "super_admin", "employee"]),
        not_(User.id.in_(subq)),
    )
    total = (await db.execute(select(func.count()).select_from(query.subquery()))).scalar() or 0
    result = await db.execute(
        query.order_by(User.created_at.desc()).offset((page - 1) * per_page).limit(per_page)
    )
    items = []
    for u in result.scalars().all():
        items.append({
            "user_id": str(u.id),
            "email": u.email,
            "name": f"{u.first_name or ''} {u.last_name or ''}".strip(),
            "created_at": u.created_at.isoformat() if u.created_at else None,
        })
    return {"items": items, "total": total, "page": page, "per_page": per_page}


async def get_ib_referrals(ib_id: uuid.UUID, page: int, per_page: int, db: AsyncSession) -> dict:
    """Traders referred by a specific IB with commission data."""
    super_id = await _super_ib_profile_id(db)
    total = (await db.execute(
        select(func.count(Referral.id)).where(Referral.ib_profile_id == ib_id)
    )).scalar() or 0
    refs = await db.execute(
        select(Referral).where(Referral.ib_profile_id == ib_id)
        .order_by(Referral.created_at.desc()).offset((page - 1) * per_page).limit(per_page))
    items = []
    for r in refs.scalars().all():
        user_q = await db.execute(select(User).where(User.id == r.referred_id))
        user = user_q.scalar_one_or_none()
        if not user:
            continue
        from packages.common.src.models import Position, TradingAccount
        trade_count = (await db.execute(
            select(func.count(Position.id)).join(TradingAccount, Position.account_id == TradingAccount.id)
            .where(TradingAccount.user_id == user.id)
        )).scalar() or 0
        comm = (await db.execute(
            select(func.coalesce(func.sum(IBCommission.amount), 0))
            .where(IBCommission.ib_id == ib_id, IBCommission.source_user_id == user.id)
        )).scalar() or 0
        # Is this referred user themselves an active IB? If so classify their
        # ROLE by lineage (super_ib=SDA05 only / ib / sub_ib) — NOT by tree
        # depth, which wrongly badged every root IB as "Super IB" (client
        # 2026-07-09). `ib_level` is kept for the Sub-IB depth suffix only.
        sub_profile = (await db.execute(
            select(IBProfile).where(
                IBProfile.user_id == user.id, IBProfile.is_active == True  # noqa: E712
            )
        )).scalars().first()
        items.append({
            "user_id": str(user.id), "email": user.email,
            "name": f"{user.first_name or ''} {user.last_name or ''}".strip(),
            "trades": trade_count, "commission_generated": float(comm),
            "joined_at": user.created_at.isoformat() if user.created_at else None,
            "is_ib": bool(sub_profile),
            "ib_level": (sub_profile.level or 1) if sub_profile else None,
            "ib_type": _classify_ib_type(sub_profile, super_id) if sub_profile else None,
        })
    return {"referrals": items, "total": total, "page": page}


# ─── Copy-Trade Master Management ──────────────────────────────

async def list_masters(
    page: int, per_page: int, db: AsyncSession,
    *, master_type: str | None = None,
) -> dict:
    """List copy-trade masters with stats. Pass `master_type` to scope
    the query SERVER-SIDE so the admin MAM dashboard can never see a
    PAMM row even if the client-side filter regressed (client request
    2026-06-01 #6 — PAMM rows were leaking into MAM)."""
    base_filters = []
    if master_type:
        normalized = master_type.strip().lower()
        if normalized in ("signal_provider", "pamm", "mamm"):
            base_filters.append(MasterAccount.master_type == normalized)

    count_stmt = select(func.count(MasterAccount.id))
    if base_filters:
        count_stmt = count_stmt.where(*base_filters)
    count_q = await db.execute(count_stmt)
    total = count_q.scalar() or 0

    list_stmt = (
        select(MasterAccount, User.first_name, User.last_name, User.email)
        .join(User, MasterAccount.user_id == User.id)
    )
    if base_filters:
        list_stmt = list_stmt.where(*base_filters)
    list_stmt = (
        list_stmt
        .order_by(MasterAccount.created_at.desc())
        .offset((page - 1) * per_page).limit(per_page)
    )
    result = await db.execute(list_stmt)
    rows = result.all()

    items = []
    for master, first_name, last_name, email in rows:
        active_q = await db.execute(
            select(func.count()).select_from(InvestorAllocation).where(
                InvestorAllocation.master_id == master.id,
                InvestorAllocation.status == "active",
            )
        )
        active_allocations = active_q.scalar() or 0

        pool_q = await db.execute(
            select(func.coalesce(func.sum(InvestorAllocation.allocation_amount), 0)).where(
                InvestorAllocation.master_id == master.id,
                InvestorAllocation.status == "active",
            )
        )
        total_aum = float(pool_q.scalar() or 0)

        items.append({
            "id": str(master.id),
            "user_id": str(master.user_id),
            "account_id": str(master.account_id) if master.account_id else None,
            "provider_name": f"{first_name or ''} {last_name or ''}".strip() or email,
            "email": email,
            "master_type": master.master_type or "signal_provider",
            "status": master.status,
            "active_followers": active_allocations,
            "total_aum": total_aum,
            "total_return_pct": float(master.total_return_pct or 0),
            "performance_fee_pct": float(master.performance_fee_pct or 0),
            "management_fee_pct": float(master.management_fee_pct or 0),
            "admin_commission_pct": float(master.admin_commission_pct or 0),
            "min_investment": float(master.min_investment or 0),
            "max_investors": master.max_investors or 0,
            "description": master.description,
            "spread_markup_pips": float(master.spread_markup_pips) if master.spread_markup_pips is not None else None,
            "commission_per_lot_usd": float(master.commission_per_lot_usd) if master.commission_per_lot_usd is not None else None,
            # Per-master swap overrides (Mig 0067).
            "swap_long_pips": float(master.swap_long_pips) if master.swap_long_pips is not None else None,
            "swap_short_pips": float(master.swap_short_pips) if master.swap_short_pips is not None else None,
            # Mig 0066 risk + insurance fields — admin form reads
            # these on edit so the inputs hydrate with the persisted
            # values instead of defaulting to blank.
            "max_drawdown_pct": float(master.max_drawdown_pct or 0),
            "max_loss_per_trade_pct": (
                float(master.max_loss_per_trade_pct)
                if master.max_loss_per_trade_pct is not None else None
            ),
            "insurance_enabled": bool(master.insurance_enabled),
            "created_at": master.created_at.isoformat() if master.created_at else None,
        })

    return {
        "items": items, "total": total, "page": page, "per_page": per_page,
        "pages": (total + per_page - 1) // per_page if total else 0,
    }


async def admin_commission_summary(
    *, master_type: str | None, db: AsyncSession,
) -> dict:
    """Aggregate the admin's slice of copy-trade performance fees.

    Two numbers, both useful:

    - ``lifetime_total``: exact sum of Transaction(type='admin_commission')
      rows; this is what actually landed in the super-admin's wallet over
      time. Includes commission from every master type.
    - ``by_master[]``: per-master estimate derived from
      ``master.total_fee_earned`` and ``master.admin_commission_pct``.
      master.total_fee_earned is the master's NET slice (after the admin
      cut), so the admin's cumulative cut on that master is
      ``master_net × admin_pct / (100 − admin_pct)``. Approximate when
      the admin pct has been edited mid-stream, but close enough for the
      dashboard breakdown the client asked for (2026-06-01 #4).
    """
    # Lifetime total — exact.
    total_q = await db.execute(
        select(func.coalesce(func.sum(Transaction.amount), 0))
        .where(Transaction.type == "admin_commission")
    )
    lifetime_total = float(total_q.scalar() or 0)

    # Per-master breakdown.
    filters = []
    if master_type:
        normalized = master_type.strip().lower()
        if normalized in ("signal_provider", "pamm", "mamm"):
            filters.append(MasterAccount.master_type == normalized)
    list_stmt = (
        select(MasterAccount, User.first_name, User.last_name, User.email)
        .join(User, MasterAccount.user_id == User.id)
    )
    if filters:
        list_stmt = list_stmt.where(*filters)
    list_stmt = list_stmt.order_by(MasterAccount.total_fee_earned.desc().nullslast())
    rows = (await db.execute(list_stmt)).all()

    by_master: list[dict] = []
    breakdown_total = Decimal("0")
    for master, first_name, last_name, email in rows:
        master_net = Decimal(str(master.total_fee_earned or 0))
        admin_pct = Decimal(str(master.admin_commission_pct or 0))
        if admin_pct <= 0 or admin_pct >= 100:
            admin_earned = Decimal("0")
        else:
            # master_net = perf_fee × (100−p)/100  →  perf_fee = master_net × 100/(100−p)
            # admin_cut = perf_fee × p/100 = master_net × p/(100−p)
            admin_earned = master_net * admin_pct / (Decimal("100") - admin_pct)
        breakdown_total += admin_earned
        by_master.append({
            "master_id": str(master.id),
            "provider_name": f"{first_name or ''} {last_name or ''}".strip() or email,
            "email": email,
            "master_type": master.master_type or "signal_provider",
            "admin_commission_pct": float(master.admin_commission_pct or 0),
            "master_net_earned": float(master_net),
            "admin_earned_estimate": float(admin_earned),
        })

    return {
        "lifetime_total": lifetime_total,
        # Sum of the per-master estimates — useful for sanity-checking
        # against lifetime_total. They drift when admin pct changes
        # mid-flight, which is expected.
        "breakdown_total_estimate": float(breakdown_total),
        "by_master": by_master,
    }


async def delete_master(
    master_id: uuid.UUID, admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
) -> dict:
    """Safely delete a copy-trade master. Flow:
      1. Close all open positions on master trading account (at open price, 0 pnl).
      2. Sweep master's trading account balance → master user's main wallet.
      3. For each active follower allocation:
         - Close open positions on investor copy account.
         - Refund investor copy account balance → follower's main wallet.
         - Mark allocation status = 'closed'.
      4. Close all open CopyTrade rows for this master.
      5. Delete the MasterAccount row.
    """
    master_q = await db.execute(select(MasterAccount).where(MasterAccount.id == master_id))
    master = master_q.scalar_one_or_none()
    if not master:
        raise HTTPException(status_code=404, detail="Master not found")

    master_acct = await db.get(TradingAccount, master.account_id) if master.account_id else None
    master_user = await db.get(User, master.user_id)
    master_sweep = Decimal("0")

    if master_acct:
        # Close open positions on master account
        master_open_q = await db.execute(
            select(Position).where(
                Position.account_id == master_acct.id,
                Position.status == PositionStatus.OPEN.value,
            )
        )
        for pos in master_open_q.scalars().all():
            pos.status = PositionStatus.CLOSED.value
            pos.close_price = pos.open_price
            pos.profit = Decimal("0")
            pos.closed_at = datetime.utcnow()

        master_sweep = (master_acct.balance or Decimal("0")) + (master_acct.credit or Decimal("0"))
        if master_user and master_sweep > 0:
            master_user.main_wallet_balance = (
                master_user.main_wallet_balance or Decimal("0")
            ) + master_sweep
            db.add(Transaction(
                user_id=master_user.id,
                account_id=master_acct.id,
                type="transfer",
                amount=master_sweep,
                balance_after=master_user.main_wallet_balance,
                description="Master account closed by admin — funds returned to main wallet",
            ))
        master_acct.balance = Decimal("0")
        master_acct.credit = Decimal("0")
        master_acct.equity = Decimal("0")
        master_acct.free_margin = Decimal("0")
        master_acct.margin_used = Decimal("0")
        # Deactivate the deleted master's trading account so it disappears from
        # the user's accounts list. Re-applying as master creates a fresh
        # CT/PM/MM trading account automatically.
        master_acct.is_active = False

    # Refund each follower
    allocs_q = await db.execute(
        select(InvestorAllocation).where(
            InvestorAllocation.master_id == master_id,
            InvestorAllocation.status == "active",
        )
    )
    follower_count = 0
    total_refunded = Decimal("0")
    for alloc in allocs_q.scalars().all():
        follower_count += 1
        investor = await db.get(User, alloc.investor_user_id)
        investor_acct = await db.get(TradingAccount, alloc.investor_account_id) if alloc.investor_account_id else None

        if investor_acct:
            inv_open_q = await db.execute(
                select(Position).where(
                    Position.account_id == investor_acct.id,
                    Position.status == PositionStatus.OPEN.value,
                )
            )
            for pos in inv_open_q.scalars().all():
                pos.status = PositionStatus.CLOSED.value
                pos.close_price = pos.open_price
                pos.profit = Decimal("0")
                pos.closed_at = datetime.utcnow()

        refund_amount = Decimal("0")
        if investor_acct:
            refund_amount = (investor_acct.balance or Decimal("0")) + (investor_acct.credit or Decimal("0"))
            investor_acct.balance = Decimal("0")
            investor_acct.credit = Decimal("0")
            investor_acct.equity = Decimal("0")
            investor_acct.free_margin = Decimal("0")
            investor_acct.margin_used = Decimal("0")
            investor_acct.is_active = False

        if investor and refund_amount > 0:
            investor.main_wallet_balance = (
                investor.main_wallet_balance or Decimal("0")
            ) + refund_amount
            total_refunded += refund_amount
            # Use "transfer" type (already in DB CHECK constraint) to avoid
            # migration headaches on existing deployments.
            db.add(Transaction(
                user_id=investor.id,
                account_id=investor_acct.id if investor_acct else None,
                type="transfer",
                amount=refund_amount,
                balance_after=investor.main_wallet_balance,
                description="Master deleted by admin — copy trade refund to main wallet",
            ))

        alloc.status = "closed"

    # Close open CopyTrade rows for this master
    copy_trades_q = await db.execute(
        select(CopyTrade)
        .join(InvestorAllocation, CopyTrade.investor_allocation_id == InvestorAllocation.id)
        .where(
            InvestorAllocation.master_id == master_id,
            CopyTrade.status == "open",
        )
    )
    for ct in copy_trades_q.scalars().all():
        ct.status = "closed"

    # Don't hard-delete the MasterAccount row — FK constraints from
    # investor_allocations & copy_trades prevent it. Mark as 'rejected' instead.
    # This preserves history (closed allocations still viewable) and allows the
    # user to re-apply as a master from scratch (become_provider filters out
    # non-approved rows).
    master_email = master_user.email if master_user else "unknown"
    master.status = "rejected"
    master.followers_count = 0

    await write_audit_log(
        db, admin_id, "delete_master", "master_account", master_id,
        new_values={
            "master_email": master_email,
            "master_sweep": float(master_sweep),
            "followers_refunded": follower_count,
            "total_refunded_to_followers": float(total_refunded),
        },
        ip_address=ip_address,
    )
    await db.commit()

    return {
        "message": f"Master deleted — {follower_count} follower(s) refunded",
        "master_sweep": float(master_sweep),
        "followers_refunded": follower_count,
        "total_refunded_to_followers": float(total_refunded),
    }


def _gen_pool_account_number(prefix: str) -> str:
    import secrets
    return f"{prefix}{secrets.randbelow(90000000) + 10000000}"


async def create_master(
    user_id_str: str,
    master_type: str,
    performance_fee_pct: float,
    management_fee_pct: float,
    admin_commission_pct: float,
    min_investment: float,
    max_investors: int,
    description: str | None,
    spread_markup_pips: float | None,
    commission_per_lot_usd: float | None,
    admin_id: uuid.UUID,
    ip_address: str | None,
    db: AsyncSession,
    *,
    # Mig 0066 admin risk + insurance fields. Optional — falls back
    # to the model defaults when callers don't pass them.
    max_drawdown_pct: float | None = None,
    max_loss_per_trade_pct: float | None = None,
    insurance_enabled: bool = True,
) -> dict:
    """Admin-direct master creation. Bypasses the user 'become_provider' →
    'pending' → 'approved' flow. Creates the master row + dedicated pool
    trading account in one call and marks it 'approved' immediately."""
    try:
        target_uid = uuid.UUID(user_id_str.strip())
    except (ValueError, AttributeError):
        raise HTTPException(status_code=400, detail="Invalid user_id")

    user = (await db.execute(select(User).where(User.id == target_uid))).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    normalized_type = master_type if master_type in ("signal_provider", "pamm", "mamm") else "signal_provider"

    # Reject duplicate active master of same type for this user.
    dup = (await db.execute(
        select(MasterAccount).where(
            MasterAccount.user_id == target_uid,
            MasterAccount.master_type == normalized_type,
            MasterAccount.status.in_(["pending", "approved", "active"]),
        )
    )).scalar_one_or_none()
    if dup:
        raise HTTPException(status_code=400, detail=f"User already has an active {normalized_type} master")

    # Enforce the admin-configured manager performance-fee cap here too —
    # otherwise admin-direct creation could set a fee above the same
    # ceiling the master-apply flow rejects (audit: "cap not working").
    try:
        from packages.common.src.settings_store import get_float_setting
        _cap = await get_float_setting("pamm_max_manager_commission_pct", 30.0)
        if performance_fee_pct is not None and float(performance_fee_pct) > _cap:
            performance_fee_pct = _cap
    except Exception:
        pass

    prefix = "PM" if normalized_type == "pamm" else ("MM" if normalized_type == "mamm" else "CT")
    pool_account = TradingAccount(
        user_id=target_uid,
        account_number=_gen_pool_account_number(prefix),
        balance=Decimal("0"),
        equity=Decimal("0"),
        free_margin=Decimal("0"),
        margin_used=Decimal("0"),
        leverage=500,
        currency="USD",
        is_demo=False,
        is_active=True,
    )
    db.add(pool_account)
    await db.flush()

    master = MasterAccount(
        user_id=target_uid,
        account_id=pool_account.id,
        status="approved",
        master_type=normalized_type,
        performance_fee_pct=Decimal(str(performance_fee_pct)),
        management_fee_pct=Decimal(str(management_fee_pct)),
        admin_commission_pct=Decimal(str(admin_commission_pct)),
        min_investment=Decimal(str(min_investment)),
        max_investors=max_investors,
        description=description,
        spread_markup_pips=Decimal(str(spread_markup_pips)) if spread_markup_pips is not None else None,
        commission_per_lot_usd=Decimal(str(commission_per_lot_usd)) if commission_per_lot_usd is not None else None,
        max_drawdown_pct=(
            Decimal(str(max_drawdown_pct)) if max_drawdown_pct is not None else Decimal("0")
        ),
        max_loss_per_trade_pct=(
            Decimal(str(max_loss_per_trade_pct)) if max_loss_per_trade_pct is not None else None
        ),
        insurance_enabled=bool(insurance_enabled),
    )
    db.add(master)

    if user.role != "master_trader":
        user.role = "master_trader"

    await db.flush()

    await write_audit_log(
        db, admin_id, "create_master", "master_account", master.id,
        new_values={
            "user_email": user.email,
            "master_type": normalized_type,
            "pool_account_number": pool_account.account_number,
            "performance_fee_pct": performance_fee_pct,
            "admin_commission_pct": admin_commission_pct,
            "spread_markup_pips": spread_markup_pips,
            "commission_per_lot_usd": commission_per_lot_usd,
        },
        ip_address=ip_address,
    )
    await db.commit()

    return {
        "id": str(master.id),
        "pool_account_id": str(pool_account.id),
        "pool_account_number": pool_account.account_number,
        "message": "Master created and approved",
    }


async def list_master_allocations(
    master_id: uuid.UUID, db: AsyncSession,
) -> dict:
    """List every InvestorAllocation under a master with the joined investor
    user + investor account. Drives the MAM page's Investors drawer so admin
    can see who's allocated, with what effective fee, and edit per-investor
    overrides."""
    master = (await db.execute(
        select(MasterAccount).where(MasterAccount.id == master_id)
    )).scalar_one_or_none()
    if not master:
        raise HTTPException(status_code=404, detail="Master not found")

    result = await db.execute(
        select(
            InvestorAllocation,
            User.first_name, User.last_name, User.email,
            TradingAccount.account_number, TradingAccount.balance,
            TradingAccount.equity,
        )
        .join(User, InvestorAllocation.investor_user_id == User.id)
        .outerjoin(
            TradingAccount,
            InvestorAllocation.investor_account_id == TradingAccount.id,
        )
        .where(InvestorAllocation.master_id == master_id)
        .order_by(InvestorAllocation.created_at.desc())
    )
    items = []
    for alloc, fn, ln, email, acct_num, balance, equity in result.all():
        items.append({
            "id": str(alloc.id),
            "investor_user_id": str(alloc.investor_user_id),
            "investor_account_id": str(alloc.investor_account_id) if alloc.investor_account_id else None,
            "investor_name": f"{fn or ''} {ln or ''}".strip() or email,
            "investor_email": email,
            "account_number": acct_num,
            "account_balance": float(balance) if balance is not None else None,
            "account_equity": float(equity) if equity is not None else None,
            "copy_type": alloc.copy_type,
            "status": alloc.status,
            "allocation_amount": float(alloc.allocation_amount or 0),
            "allocation_pct": float(alloc.allocation_pct) if alloc.allocation_pct is not None else None,
            "max_drawdown_pct": float(alloc.max_drawdown_pct) if alloc.max_drawdown_pct is not None else None,
            "max_lot_override": float(alloc.max_lot_override) if alloc.max_lot_override is not None else None,
            "total_profit": float(alloc.total_profit or 0),
            "performance_fee_pct_override": float(alloc.performance_fee_pct_override) if alloc.performance_fee_pct_override is not None else None,
            "admin_commission_pct_override": float(alloc.admin_commission_pct_override) if alloc.admin_commission_pct_override is not None else None,
            "admin_notes": alloc.admin_notes,
            "effective_performance_fee_pct": float(
                alloc.performance_fee_pct_override
                if alloc.performance_fee_pct_override is not None
                else (master.performance_fee_pct or 0)
            ),
            "effective_admin_commission_pct": float(
                alloc.admin_commission_pct_override
                if alloc.admin_commission_pct_override is not None
                else (master.admin_commission_pct or 0)
            ),
            "created_at": alloc.created_at.isoformat() if alloc.created_at else None,
            "last_distribution_at": alloc.last_distribution_at.isoformat() if alloc.last_distribution_at else None,
        })
    return {
        "items": items,
        "master_defaults": {
            "performance_fee_pct": float(master.performance_fee_pct or 0),
            "management_fee_pct": float(master.management_fee_pct or 0),
            "admin_commission_pct": float(master.admin_commission_pct or 0),
        },
    }


async def update_master_allocation(
    master_id: uuid.UUID,
    allocation_id: uuid.UUID,
    patch: dict,
    admin_id: uuid.UUID,
    ip_address: str | None,
    db: AsyncSession,
) -> dict:
    """Admin patch on a single investor_allocations row. Only the fields
    listed below are honored. Passing JSON null for a fee override clears
    it so the investor falls back to the master default; passing 0
    explicitly stores a real 0% rate."""
    alloc = (await db.execute(
        select(InvestorAllocation).where(
            InvestorAllocation.id == allocation_id,
            InvestorAllocation.master_id == master_id,
        )
    )).scalar_one_or_none()
    if not alloc:
        raise HTTPException(status_code=404, detail="Allocation not found for this master")

    decimal_fields = (
        "allocation_amount", "allocation_pct", "max_drawdown_pct",
        "max_lot_override",
        "performance_fee_pct_override", "admin_commission_pct_override",
    )
    str_fields = ("status", "copy_type", "admin_notes")

    changed: dict = {}
    for f in decimal_fields:
        if f in patch:
            v = patch[f]
            new_val = None if v is None or v == "" else Decimal(str(v))
            setattr(alloc, f, new_val)
            changed[f] = float(new_val) if new_val is not None else None
    for f in str_fields:
        if f in patch:
            v = patch[f]
            setattr(alloc, f, v if v != "" else None)
            changed[f] = v

    if "status" in changed and changed["status"] not in (None, "active", "paused", "closed"):
        raise HTTPException(
            status_code=400,
            detail="status must be one of: active, paused, closed",
        )

    await write_audit_log(
        db, admin_id, "update_master_allocation", "investor_allocation", allocation_id,
        new_values=changed, ip_address=ip_address,
    )
    await db.commit()
    return {"message": "Allocation updated", "changed": changed}


async def update_master(
    master_id: uuid.UUID,
    patch: dict,
    admin_id: uuid.UUID,
    ip_address: str | None,
    db: AsyncSession,
) -> dict:
    """Admin patch on master_accounts. Only allowed fields are honored;
    null on spread_markup_pips / commission_per_lot_usd clears the override
    so the global SpreadConfig / ChargeConfig resolver kicks back in."""
    master = (await db.execute(
        select(MasterAccount).where(MasterAccount.id == master_id)
    )).scalar_one_or_none()
    if not master:
        raise HTTPException(status_code=404, detail="Master not found")

    decimal_fields = (
        "performance_fee_pct", "management_fee_pct", "admin_commission_pct",
        "min_investment", "spread_markup_pips", "commission_per_lot_usd",
        "max_drawdown_pct", "max_loss_per_trade_pct",
        "swap_long_pips", "swap_short_pips",
    )
    int_fields = ("max_investors",)
    str_fields = ("description", "master_type", "status")
    bool_fields = ("insurance_enabled",)

    changed: dict = {}
    for f in decimal_fields:
        if f in patch:
            v = patch[f]
            new_val = None if v is None or v == "" else Decimal(str(v))
            setattr(master, f, new_val)
            changed[f] = float(new_val) if new_val is not None else None
    for f in int_fields:
        if f in patch and patch[f] is not None:
            setattr(master, f, int(patch[f]))
            changed[f] = int(patch[f])
    for f in str_fields:
        if f in patch:
            setattr(master, f, patch[f])
            changed[f] = patch[f]
    for f in bool_fields:
        if f in patch and patch[f] is not None:
            setattr(master, f, bool(patch[f]))
            changed[f] = bool(patch[f])

    await write_audit_log(
        db, admin_id, "update_master", "master_account", master_id,
        new_values=changed, ip_address=ip_address,
    )
    await db.commit()
    return {"message": "Master updated", "changed": changed}
