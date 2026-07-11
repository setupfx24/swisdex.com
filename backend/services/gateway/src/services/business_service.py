"""Business Service — IB/Sub-Broker, referrals, commissions, MLM tree."""
from decimal import Decimal
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select, func, text
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.models import (
    IBProfile, IBApplication, IBCommission, IBCommissionPlan,
    Referral, User, TradingAccount, Deposit, Transaction,
)
from packages.common.src.settings_store import get_float_setting

# Admin-tunable threshold: a user must have accumulated at least this much
# in approved deposits (USD, lifetime) before being eligible to apply as an
# IB / sub-broker. Default is $100 so test accounts never accidentally
# qualify; admin overrides via /admin/settings → ib_min_deposit_usd.
IB_MIN_DEPOSIT_DEFAULT_USD = 100.0


async def _get_ib_min_deposit_usd() -> float:
    return await get_float_setting("ib_min_deposit_usd", IB_MIN_DEPOSIT_DEFAULT_USD)


async def _get_user_total_deposits(user_id: UUID, db: AsyncSession) -> float:
    """Sum lifetime approved/auto-approved deposits for a user, in USD.
    Used as the gate for IB eligibility — a user must have demonstrably
    funded their account before they can earn from referrals.
    """
    result = await db.execute(
        select(func.coalesce(func.sum(Deposit.amount), 0))
        .where(
            Deposit.user_id == user_id,
            Deposit.status.in_(["approved", "auto_approved"]),
        )
    )
    return float(result.scalar() or 0)


def _get_frontend_url() -> str:
    from packages.common.src.config import get_settings
    s = get_settings()
    origins = [o.strip() for o in s.CORS_ORIGINS.split(",") if o.strip()]
    for o in origins:
        if "swisdex.com" in o:
            return o
    for o in origins:
        if ":3000" in o:
            return o
    return origins[0] if origins else "http://localhost:3000"


async def _get_super_ib_profile_id(db: AsyncSession) -> UUID | None:
    """The Super IB is the root every real IB hangs under. It's the IBProfile
    whose referral_code matches the `super_ib_code` setting (default 'SDA05';
    admin-editable). Returns None if no such IB exists yet."""
    from packages.common.src.settings_store import get_system_setting
    code = str(await get_system_setting("super_ib_code", None) or "SDA05").strip()
    if not code:
        return None
    row = (await db.execute(
        select(IBProfile.id).where(IBProfile.referral_code == code)
    )).first()
    return row[0] if row else None


async def _resolve_ib_type(db: AsyncSession, profile: IBProfile) -> str:
    """Classify an IB profile per client spec 2026-06-16:
      - 'super_ib' : the Super IB itself (SDA05 root).
      - 'ib'       : introduced DIRECTLY by the Super IB → full IB dashboard.
      - 'sub_ib'   : introduced by anyone else (deeper) → Sub-IB dashboard.
    Fallback when no Super IB is configured: a profile with no parent is an IB.
    """
    super_id = await _get_super_ib_profile_id(db)
    if super_id is not None:
        if profile.id == super_id:
            return "super_ib"
        # A NULL parent means there's no introducing IB above this profile —
        # i.e. a full IB that sits directly under the Super IB (e.g. a
        # no-referral user who self-applied). Only a profile whose parent is
        # ANOTHER (non-super) IB is a Sub-IB. Treating NULL as sub_ib wrongly
        # hid the IB dashboard from real IBs (client 2026-06-24).
        if profile.parent_ib_id is None or profile.parent_ib_id == super_id:
            return "ib"
        return "sub_ib"
    return "ib" if profile.parent_ib_id is None else "sub_ib"


async def _get_introducer_user_id(db: AsyncSession, user_id: UUID) -> UUID | None:
    """Who introduced this user, across ALL signup paths (client 2026-06-19).

    There are two code namespaces and three ways a signup gets attributed:
      1. a personal `User.referral_code` → sets `User.referred_by_user_id`;
      2. an `IBProfile.referral_code` (e.g. the Super IB 'SDA05') → writes a
         `Referral` row but leaves `referred_by_user_id` NULL;
      3. a no-code signup → auto-attached under the Super IB via a `Referral` row.

    The old gating only looked at `referred_by_user_id`, so anyone who joined
    through an IB *code* (cases 2 & 3) looked un-introduced and could wrongly
    self-apply. Derive the introducer from `referred_by_user_id` first, then
    fall back to the `Referral` row written at signup."""
    ref = (await db.execute(
        select(User.referred_by_user_id).where(User.id == user_id)
    )).first()
    if ref and ref[0] is not None:
        return ref[0]
    row = (await db.execute(
        select(Referral.referrer_id)
        .where(Referral.referred_id == user_id)
        .order_by(Referral.created_at.asc())
        .limit(1)
    )).first()
    return row[0] if row else None


async def _can_self_apply_ib(db: AsyncSession, user_id: UUID) -> bool:
    """Per client 2026-06-19: only a user introduced by the Super IB (SDA05)
    — or one who signed up with NO referral at all (they attach under the
    Super IB) — may self-apply to become a full IB. A user introduced by any
    other IB/affiliate is shown only a "Contact SwisDex to become an IB"
    prompt instead of the self-apply flow."""
    introducer_id = await _get_introducer_user_id(db, user_id)
    if introducer_id is None:
        return True  # no introducer → sits under the Super IB → can apply
    super_id = await _get_super_ib_profile_id(db)
    if super_id is None:
        return True  # no Super IB configured yet → don't block applications
    super_prof = (await db.execute(
        select(IBProfile).where(IBProfile.id == super_id)
    )).scalar_one_or_none()
    return super_prof is not None and super_prof.user_id == introducer_id


async def _kyc_approved(db: AsyncSession, user_id: UUID) -> bool:
    """KYC must be cleared before a user can become an IB or Sub-IB (client
    2026-06-29). Treat both 'approved' and 'verified' as cleared, matching the
    rest of the gateway (profile_service)."""
    kyc = (await db.execute(
        select(User.kyc_status).where(User.id == user_id)
    )).scalar_one_or_none()
    return (kyc or "pending").lower() in ("approved", "verified")


async def _ib_pool_and_active(db: AsyncSession, ib_user_id: UUID) -> tuple[float, int, int]:
    """Returns (deposit_pool_usd, active_users, total_referred) for an IB's
    direct downline. The pool counts approved deposits PLUS admin manual
    credits (Transaction type 'adjustment', positive) — client 2026-06-30:
    "deposit aur admin credit dono" should fund the IB pool / drive the tier.
    'Active' = a referred user funded by a deposit OR an admin credit."""
    referred = (await db.execute(
        select(Referral.referred_id).where(Referral.referrer_id == ib_user_id)
    )).scalars().all()
    total_referred = len(referred)
    if not referred:
        return 0.0, 0, 0
    deposits_sum = (await db.execute(
        select(func.coalesce(func.sum(Deposit.amount), 0)).where(
            Deposit.user_id.in_(referred),
            Deposit.status.in_(["approved", "auto_approved"]),
        )
    )).scalar() or 0
    credits_sum = (await db.execute(
        select(func.coalesce(func.sum(Transaction.amount), 0)).where(
            Transaction.user_id.in_(referred),
            Transaction.type == "adjustment",
            Transaction.amount > 0,
        )
    )).scalar() or 0
    pool = float(deposits_sum) + float(credits_sum)
    dep_users = set((await db.execute(
        select(func.distinct(Deposit.user_id)).where(
            Deposit.user_id.in_(referred),
            Deposit.status.in_(["approved", "auto_approved"]),
        )
    )).scalars().all())
    cred_users = set((await db.execute(
        select(func.distinct(Transaction.user_id)).where(
            Transaction.user_id.in_(referred),
            Transaction.type == "adjustment",
            Transaction.amount > 0,
        )
    )).scalars().all())
    active = len(dep_users | cred_users)
    return pool, active, total_referred


async def ib_status(user_id: UUID, db: AsyncSession) -> dict:
    profile_result = await db.execute(
        select(IBProfile).where(IBProfile.user_id == user_id)
    )
    profile = profile_result.scalar_one_or_none()

    app_result = await db.execute(
        select(IBApplication).where(IBApplication.user_id == user_id)
        .order_by(IBApplication.created_at.desc())
    )
    application = app_result.scalars().first()

    if profile:
        ib_type = await _resolve_ib_type(db, profile)
        deposit_pool, active_users, total_referred = await _ib_pool_and_active(db, user_id)
        return {
            "is_ib": True,
            "ib_type": ib_type,             # 'super_ib' | 'ib' | 'sub_ib'
            "is_sub_ib": ib_type == "sub_ib",
            "referral_code": profile.referral_code,
            "level": profile.level,
            "total_earned": float(profile.total_earned),
            "pending_payout": float(profile.pending_payout),
            "is_active": profile.is_active,
            # Downline economics (client 2026-06-19): collective deposit pool +
            # active/total user counts so the IB sees what tier its per-lot
            # commission ($5/$7/$10/$12) is driven by.
            "deposit_pool_usd": deposit_pool,
            "active_users": active_users,
            "total_referred": total_referred,
            "created_at": profile.created_at.isoformat() if profile.created_at else None,
        }

    # Not an IB yet — surface the eligibility status so the trader UI can
    # show a progress bar ("$30 / $100 deposited to apply") instead of just
    # an unexplained disabled button.
    min_deposit = await _get_ib_min_deposit_usd()
    total_deposits = await _get_user_total_deposits(user_id, db)
    # KYC must be cleared before applying (client 2026-06-29). is_eligible now
    # requires BOTH the min deposit AND KYC, so the apply button stays disabled
    # until both are done; kyc_approved is surfaced so the UI can say which gate
    # is still open.
    kyc_ok = await _kyc_approved(db, user_id)
    eligibility = {
        "min_deposit_required_usd": min_deposit,
        "total_deposits_usd": total_deposits,
        "kyc_approved": kyc_ok,
        "is_eligible": total_deposits >= min_deposit and kyc_ok,
    }
    # Whether this user may use the self-apply flow at all, or only see the
    # "Contact SwisDex to become an IB" prompt (client 2026-06-19).
    can_become_ib = await _can_self_apply_ib(db, user_id)

    if application:
        return {
            "is_ib": False,
            "application_status": application.status,
            "applied_at": application.created_at.isoformat() if application.created_at else None,
            "eligibility": eligibility,
            "can_become_ib": can_become_ib,
        }

    return {
        "is_ib": False,
        "application_status": None,
        "eligibility": eligibility,
        "can_become_ib": can_become_ib,
    }


async def apply_ib(user_id: UUID, application_data: dict | None, db: AsyncSession) -> dict:
    existing_profile = await db.execute(
        select(IBProfile).where(IBProfile.user_id == user_id)
    )
    if existing_profile.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="You are already an IB")

    existing_app = await db.execute(
        select(IBApplication).where(
            IBApplication.user_id == user_id,
            IBApplication.status == "pending",
        )
    )
    if existing_app.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="You already have a pending application")

    # Only Super-IB-introduced (or no-referral) users may self-apply
    # (client 2026-06-19). Everyone else must contact SwisDex.
    if not await _can_self_apply_ib(db, user_id):
        raise HTTPException(
            status_code=403,
            detail="Direct IB applications are open only to users introduced by SwisDex. "
                   "Please contact SwisDex to become an IB.",
        )

    # KYC gate (client 2026-06-29): must be KYC-approved before becoming an IB.
    if not await _kyc_approved(db, user_id):
        raise HTTPException(
            status_code=403,
            detail="Please complete KYC verification before applying to become an IB.",
        )

    # Minimum-deposit gate. Admin sets the threshold via system_settings →
    # ib_min_deposit_usd. We compare against lifetime approved deposits so
    # a user can't deposit → apply → withdraw → apply-again with a hollow
    # account.
    min_deposit = await _get_ib_min_deposit_usd()
    total_deposits = await _get_user_total_deposits(user_id, db)
    if total_deposits < min_deposit:
        raise HTTPException(
            status_code=400,
            detail=(
                f"IB application requires at least ${min_deposit:,.2f} in approved deposits. "
                f"You currently have ${total_deposits:,.2f}. Deposit the remaining "
                f"${max(0.0, min_deposit - total_deposits):,.2f} to qualify."
            ),
        )

    application = IBApplication(
        user_id=user_id,
        status="pending",
        application_data=application_data or {},
    )
    db.add(application)
    await db.commit()
    await db.refresh(application)

    return {
        "id": str(application.id),
        "status": application.status,
        "message": "IB application submitted for review",
    }


async def apply_sub_broker(user_id: UUID, application_data: dict | None, db: AsyncSession) -> dict:
    existing_app = await db.execute(
        select(IBApplication).where(
            IBApplication.user_id == user_id,
            IBApplication.status == "pending",
        )
    )
    if existing_app.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="You already have a pending application")

    existing_profile = await db.execute(
        select(IBProfile).where(IBProfile.user_id == user_id)
    )
    if existing_profile.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="You already have a business profile")

    # KYC gate (client 2026-06-29): KYC-approved required before becoming a Sub-IB.
    if not await _kyc_approved(db, user_id):
        raise HTTPException(
            status_code=403,
            detail="Please complete KYC verification before applying to become a Sub-IB.",
        )

    # Same min-deposit gate as IB — sub-broker is just a higher tier of IB.
    min_deposit = await _get_ib_min_deposit_usd()
    total_deposits = await _get_user_total_deposits(user_id, db)
    if total_deposits < min_deposit:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Sub-broker application requires at least ${min_deposit:,.2f} in approved deposits. "
                f"You currently have ${total_deposits:,.2f}."
            ),
        )

    data = application_data or {}
    data["type"] = "sub_broker"

    application = IBApplication(
        user_id=user_id,
        status="pending",
        application_data=data,
    )
    db.add(application)
    await db.commit()
    await db.refresh(application)

    return {
        "id": str(application.id),
        "status": application.status,
        "message": "Sub-broker application submitted for review",
    }


async def ib_dashboard(user_id: UUID, db: AsyncSession) -> dict:
    result = await db.execute(
        select(IBProfile).where(IBProfile.user_id == user_id)
    )
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="IB profile not found")

    ib_type = await _resolve_ib_type(db, profile)

    referral_count = await db.execute(
        select(func.count()).select_from(Referral).where(Referral.ib_profile_id == profile.id)
    )
    total_referrals = referral_count.scalar()

    total_commission = await db.execute(
        select(func.coalesce(func.sum(IBCommission.amount), 0)).where(IBCommission.ib_id == profile.id)
    )
    total_comm = total_commission.scalar()

    pending_comm = await db.execute(
        select(func.coalesce(func.sum(IBCommission.amount), 0)).where(
            IBCommission.ib_id == profile.id, IBCommission.status == "pending",
        )
    )
    pending = pending_comm.scalar()

    base_url = _get_frontend_url()

    # Tier ladder — surface where the IB sits today + how many more
    # referrals unlock the next tier so the trader-side page can render
    # a progress hint without a second roundtrip.
    from ..engines.ib_engine import (
        get_ib_tiers, resolve_tier, compute_ib_qualification,
    )

    tiers = await get_ib_tiers(db)
    # Tier is driven by EITHER activation count OR cumulative referral
    # deposits (whichever qualifies higher) — same logic the commission
    # engine pays on.
    activations, ref_amount = await compute_ib_qualification(db, profile.id)
    ref_amount_f = float(ref_amount or 0)
    current_tier = resolve_tier(activations, ref_amount, tiers)
    current_lot = float(current_tier.get("per_lot") or 0) if current_tier else -1.0
    # Next tier = the cheapest tier richer than the current one the IB
    # hasn't reached yet; surface how many more activations OR how much
    # more deposit volume unlocks it.
    next_tier = None
    needed_activations = None
    needed_amount = None
    for t in sorted(tiers, key=lambda x: float(x.get("per_lot") or 0)):
        if float(t.get("per_lot") or 0) <= current_lot:
            continue
        min_act = int(t.get("min_activations") or 0)
        min_amt = float(t.get("min_amount") or 0)
        if (min_act and activations >= min_act) or (min_amt and ref_amount_f >= min_amt):
            continue  # already qualifies (shouldn't happen — current_tier would be this)
        next_tier = t
        needed_activations = max(0, min_act - activations) if min_act else None
        needed_amount = max(0.0, min_amt - ref_amount_f) if min_amt else None
        break

    # Accumulated commission pool — populated by the IB engine on each
    # qualifying trade. The IB sees this number on /business and can
    # press "Transfer to Main Wallet" to sweep it into withdrawable
    # balance (handled by transfer_ib_commission_to_main_wallet).
    from packages.common.src.models import User as _U
    ib_user = (await db.execute(
        select(_U).where(_U.id == user_id)
    )).scalar_one_or_none()
    commission_balance = float(ib_user.ib_commission_balance or 0) if ib_user else 0.0

    # Per-source-user breakdown — "kis user se kitna earn kiya" view.
    # Aggregates IBCommission rows for this IB grouped by the trader
    # who triggered the commission. Joins to users to surface name +
    # email so the dashboard can render the table directly.
    per_user_rows = (await db.execute(
        select(
            IBCommission.source_user_id,
            _U.first_name,
            _U.last_name,
            _U.email,
            func.sum(IBCommission.amount).label("total"),
            func.count(IBCommission.id).label("count"),
        )
        .join(_U, _U.id == IBCommission.source_user_id)
        .where(IBCommission.ib_id == profile.id)
        .group_by(IBCommission.source_user_id, _U.first_name, _U.last_name, _U.email)
        .order_by(func.sum(IBCommission.amount).desc())
        .limit(100)
    )).all()
    earnings_by_user = [
        {
            "user_id": str(row[0]),
            "name": " ".join(filter(None, [row[1], row[2]])).strip() or None,
            "email": row[3],
            "total_commission": float(row[4] or 0),
            "trades_attributed": int(row[5] or 0),
        }
        for row in per_user_rows
    ]

    return {
        # Client spec 2026-06-16: only someone introduced by the Super IB
        # (SDA05) is a full IB; everyone else is a Sub-IB. The frontend shows
        # the matching dashboard and a "Contact SwisDex" upgrade for sub-IBs.
        "ib_type": ib_type,                 # 'super_ib' | 'ib' | 'sub_ib'
        "is_sub_ib": ib_type == "sub_ib",
        "can_request_ib_upgrade": ib_type == "sub_ib",
        "referral_code": profile.referral_code,
        "referral_link": f"{base_url}/auth/register?ref={profile.referral_code}",
        "level": profile.level,
        "total_referrals": total_referrals,
        "total_commission": float(total_comm),
        "pending_payout": float(profile.pending_payout),
        "total_earned": float(profile.total_earned),
        "commission_balance": commission_balance,
        "earnings_by_user": earnings_by_user,
        "is_active": profile.is_active,
        "tier": current_tier,
        "next_tier": next_tier,
        # Activation/amount progress toward the next tier (either unlocks it).
        "activations": activations,
        "referral_deposit_total": ref_amount_f,
        "needed_activations_for_next": needed_activations,
        "needed_amount_for_next": needed_amount,
        "tier_ladder": tiers,
    }


async def transfer_ib_commission_to_main_wallet(
    user_id: UUID, db: AsyncSession,
) -> dict:
    """Sweep the IB's accumulated commission pool into their main
    wallet. Writes a Transaction + notification so the bell icon and
    /transactions update immediately. Raises 400 if the pool is empty.
    """
    from packages.common.src.models import User, Transaction
    from packages.common.src.notify import create_notification

    user = (await db.execute(
        select(User).where(User.id == user_id).with_for_update()
    )).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    balance = Decimal(str(user.ib_commission_balance or 0))
    if balance <= 0:
        raise HTTPException(
            status_code=400, detail="No IB commission to transfer",
        )

    new_main = Decimal(str(user.main_wallet_balance or 0)) + balance
    user.main_wallet_balance = new_main
    user.ib_commission_balance = Decimal("0")

    db.add(Transaction(
        user_id=user.id,
        type="ib_commission",
        amount=balance,
        balance_after=new_main,
        reference_id=user.id,
        description=f"IB commission transferred to main wallet — ${float(balance):.2f}",
    ))

    try:
        await create_notification(
            db, user.id,
            title="IB commission credited",
            message=f"${float(balance):.2f} moved to your main wallet.",
            notif_type="success",
            action_url="/transactions",
        )
    except Exception:
        pass

    await db.commit()
    return {
        "transferred": float(balance),
        "main_wallet_balance": float(new_main),
    }


async def ib_referrals(user_id: UUID, page: int, per_page: int, db: AsyncSession) -> dict:
    profile_result = await db.execute(
        select(IBProfile).where(IBProfile.user_id == user_id)
    )
    profile = profile_result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="IB profile not found")

    count_result = await db.execute(
        select(func.count()).select_from(Referral).where(Referral.ib_profile_id == profile.id)
    )
    total = count_result.scalar()

    result = await db.execute(
        select(Referral, User.email, User.first_name, User.last_name, User.created_at)
        .join(User, Referral.referred_id == User.id)
        .where(Referral.ib_profile_id == profile.id)
        .order_by(Referral.created_at.desc())
        .offset((page - 1) * per_page).limit(per_page)
    )
    rows = result.all()

    items = []
    for ref, email, first_name, last_name, user_created in rows:
        deposit_result = await db.execute(
            select(func.count(), func.coalesce(func.sum(TradingAccount.balance), 0))
            .select_from(TradingAccount)
            .where(TradingAccount.user_id == ref.referred_id)
        )
        acct_count, total_deposit = deposit_result.one()
        items.append({
            "id": str(ref.id),
            "referred_user": {
                "email": email,
                "name": f"{first_name or ''} {last_name or ''}".strip(),
                "joined_at": user_created.isoformat() if user_created else None,
            },
            "accounts_count": acct_count,
            "total_deposit": float(total_deposit),
            "utm_source": ref.utm_source,
            "utm_medium": ref.utm_medium,
            "utm_campaign": ref.utm_campaign,
            "created_at": ref.created_at.isoformat() if ref.created_at else None,
        })

    return {
        "items": items, "total": total, "page": page, "per_page": per_page,
        "pages": (total + per_page - 1) // per_page if total else 0,
    }


async def ib_commissions(
    user_id: UUID, status: str | None, page: int, per_page: int, db: AsyncSession,
) -> dict:
    profile_result = await db.execute(
        select(IBProfile).where(IBProfile.user_id == user_id)
    )
    profile = profile_result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="IB profile not found")

    base_query = select(func.count()).select_from(IBCommission).where(IBCommission.ib_id == profile.id)
    if status:
        base_query = base_query.where(IBCommission.status == status)
    count_result = await db.execute(base_query)
    total = count_result.scalar()

    query = (
        select(IBCommission, User.email, User.first_name, User.last_name)
        .join(User, IBCommission.source_user_id == User.id)
        .where(IBCommission.ib_id == profile.id)
    )
    if status:
        query = query.where(IBCommission.status == status)
    query = query.order_by(IBCommission.created_at.desc()).offset((page - 1) * per_page).limit(per_page)
    result = await db.execute(query)
    rows = result.all()

    items = []
    for comm, email, first_name, last_name in rows:
        items.append({
            "id": str(comm.id),
            "source_user": {
                "email": email,
                "name": f"{first_name or ''} {last_name or ''}".strip(),
            },
            "commission_type": comm.commission_type,
            "amount": float(comm.amount),
            "mlm_level": comm.mlm_level,
            "status": comm.status,
            "created_at": comm.created_at.isoformat() if comm.created_at else None,
        })

    return {
        "items": items, "total": total, "page": page, "per_page": per_page,
        "pages": (total + per_page - 1) // per_page if total else 0,
    }


async def ib_tree(user_id: UUID, max_depth: int, db: AsyncSession) -> dict:
    profile_result = await db.execute(
        select(IBProfile).where(IBProfile.user_id == user_id)
    )
    profile = profile_result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="IB profile not found")

    # Walk users.referred_by_user_id (NOT just ib_profiles.parent_ib_id).
    # Old query only counted sub-IBs, which left the network empty for
    # any IB whose downline is regular traders who never became IBs
    # themselves (client report 2026-06-01: "members nahi dikh rahe" with
    # $0.46 already earned). Now every referred user shows up, IB or
    # not. Sub-IB profile info is LEFT-joined so the existing UI
    # (referral_code, sub-IB level, total_earned per node) keeps
    # rendering when the downline node IS an IB.
    # Direct children come from EITHER referred_by_user_id (personal code) OR a
    # Referral row pointing at this IB's profile (IB code/link signups, which
    # leave referred_by_user_id NULL — they showed in the Sub-Broker clients
    # list but were missing from My Network; client 2026-06-24). For the latter
    # we coalesce their parent to this IB so they attach under the root.
    cte_query = text("""
        WITH RECURSIVE network AS (
            SELECT
                u.id AS user_id,
                COALESCE(u.referred_by_user_id, :root_user_id) AS parent_user_id,
                u.email, u.first_name, u.last_name,
                ip.id AS ib_profile_id,
                ip.referral_code, ip.level AS ib_level,
                COALESCE(ip.total_earned, 0) AS total_earned,
                COALESCE(ip.is_active, true) AS is_active,
                1 AS depth
            FROM users u
            LEFT JOIN ib_profiles ip ON ip.user_id = u.id
            WHERE u.referred_by_user_id = :root_user_id
               OR u.id IN (
                    SELECT r.referred_id FROM referrals r
                    WHERE r.ib_profile_id = :root_ib_profile_id
               )

            UNION ALL

            SELECT
                u.id, u.referred_by_user_id,
                u.email, u.first_name, u.last_name,
                ip.id,
                ip.referral_code, ip.level,
                COALESCE(ip.total_earned, 0),
                COALESCE(ip.is_active, true),
                n.depth + 1
            FROM users u
            LEFT JOIN ib_profiles ip ON ip.user_id = u.id
            JOIN network n ON u.referred_by_user_id = n.user_id
            WHERE n.depth < :max_depth
        )
        SELECT * FROM network ORDER BY depth, email
    """)

    result = await db.execute(
        cte_query,
        {
            "root_user_id": str(user_id),
            "root_ib_profile_id": str(profile.id),
            "max_depth": max_depth,
        },
    )
    rows = result.fetchall()

    nodes_by_parent: dict = {}
    for row in rows:
        parent = str(row.parent_user_id) if row.parent_user_id else None
        node = {
            # Node id = the user's id; the UI uses it as the React key.
            "id": str(row.user_id),
            "user_id": str(row.user_id),
            "email": row.email,
            "name": f"{row.first_name or ''} {row.last_name or ''}".strip(),
            # Sub-IB-only fields. NULL when the downline user never became
            # an IB themselves — the UI already handles undefined here.
            "ib_profile_id": str(row.ib_profile_id) if row.ib_profile_id else None,
            "referral_code": row.referral_code,
            "level": row.ib_level,
            "depth": row.depth,
            "total_earned": float(row.total_earned),
            "is_active": row.is_active,
            "children": [],
        }
        nodes_by_parent.setdefault(parent, []).append(node)

    def build_tree(parent_id: str) -> list:
        children = nodes_by_parent.get(parent_id, [])
        for child in children:
            child["children"] = build_tree(child["user_id"])
        return children

    tree = build_tree(str(user_id))

    return {
        "root": {
            "id": str(profile.id),
            "referral_code": profile.referral_code,
            "level": profile.level,
            "total_earned": float(profile.total_earned),
        },
        "tree": tree,
        # Total downline size — anyone whose referral chain leads back
        # to this user, sub-IB or not.
        "total_nodes": len(rows),
    }


async def generate_referral_link(
    user_id: UUID, utm_source: str | None, utm_medium: str | None,
    utm_campaign: str | None, db: AsyncSession,
) -> dict:
    profile_result = await db.execute(
        select(IBProfile).where(IBProfile.user_id == user_id)
    )
    profile = profile_result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="IB profile not found")

    base_url = _get_frontend_url()
    link = f"{base_url}/auth/register?ref={profile.referral_code}"
    params = []
    if utm_source:
        params.append(f"utm_source={utm_source}")
    if utm_medium:
        params.append(f"utm_medium={utm_medium}")
    if utm_campaign:
        params.append(f"utm_campaign={utm_campaign}")
    if params:
        link += "&" + "&".join(params)

    return {"referral_link": link, "referral_code": profile.referral_code}


async def sub_broker_dashboard(user_id: UUID, db: AsyncSession) -> dict:
    profile_result = await db.execute(
        select(IBProfile).where(IBProfile.user_id == user_id)
    )
    profile = profile_result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="Sub-broker profile not found")

    # The Sub-Broker view lists only this IB's SUB-IBs — downline whose own
    # IBProfile sits directly under this profile (parent_ib_id == profile.id),
    # i.e. they classify as 'sub_ib'. Two cases are deliberately excluded and
    # belong in My Network instead (client 2026-06-29):
    #   - a plain referred trader who never became an IB (no child IBProfile);
    #   - a user the SUPER IB referred who became an IB — they are a FULL IB
    #     (_resolve_ib_type: a child of the Super IB is 'ib', not 'sub_ib'),
    #     so the Super IB's sub-broker list is empty.
    super_id = await _get_super_ib_profile_id(db)
    is_super = super_id is not None and profile.id == super_id

    client_list: list[dict] = []
    direct_count = 0
    if not is_super:
        direct_count = (await db.execute(
            select(func.count()).select_from(IBProfile).where(
                IBProfile.parent_ib_id == profile.id, IBProfile.is_active == True,
            )
        )).scalar() or 0

        client_rows = (await db.execute(
            select(
                IBProfile.user_id, User.email, User.first_name, User.last_name,
                User.status, User.kyc_status, User.created_at,
            )
            .join(User, IBProfile.user_id == User.id)
            .where(IBProfile.parent_ib_id == profile.id, IBProfile.is_active == True)
            .order_by(IBProfile.created_at.desc()).limit(50)
        )).all()

        for referred_id, email, fname, lname, status, kyc, joined in client_rows:
            acct_result = await db.execute(
                select(func.count(), func.coalesce(func.sum(TradingAccount.balance), 0))
                .where(TradingAccount.user_id == referred_id)
            )
            acct_stats = acct_result.one()
            client_list.append({
                "user_id": str(referred_id), "email": email,
                "name": f"{fname or ''} {lname or ''}".strip(),
                "status": status, "kyc_status": kyc,
                "accounts_count": acct_stats[0],
                "total_balance": float(acct_stats[1]),
                "joined_at": joined.isoformat() if joined else None,
            })

    total_comm = await db.execute(
        select(func.coalesce(func.sum(IBCommission.amount), 0)).where(IBCommission.ib_id == profile.id)
    )

    return {
        "referral_code": profile.referral_code,
        "direct_clients": direct_count,
        "total_commission": float(total_comm.scalar()),
        "pending_payout": float(profile.pending_payout),
        "total_earned": float(profile.total_earned),
        "clients": client_list,
    }
