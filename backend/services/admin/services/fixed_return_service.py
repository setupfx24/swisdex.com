"""Admin-side AI-POWERED STAKING PROGRAM helpers — kept separate from the trader-side
gateway service so the admin container doesn't need gateway code on its
PYTHONPATH. Money-flow + persistence logic is intentionally duplicated
rather than imported; the duplication is small and the boundary keeps
the two containers independently deployable.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.models import FixedReturnLock, User, Transaction
from packages.common.src.settings_store import get_float_setting, get_int_setting
from packages.common.src.notify import create_notification


DEFAULT_FEE_PCT = 5.0


def _add_months(dt: datetime, months: int) -> datetime:
    """Add calendar months, clamped at month-end. Mirrors the helper in
    the gateway service so the day-of-month stays stable across cycles."""
    year = dt.year + (dt.month - 1 + months) // 12
    month = (dt.month - 1 + months) % 12 + 1
    from calendar import monthrange
    last_day = monthrange(year, month)[1]
    day = min(dt.day, last_day)
    return dt.replace(year=year, month=month, day=day)


def _tenure_to_months(tenure_days: int) -> int:
    if tenure_days >= 700: return 24
    if tenure_days >= 350: return 12
    if tenure_days >= 170: return 6
    if tenure_days >= 80:  return 3
    return 1


def _snap_to_payout_window(dt: datetime, *, payout_day: int) -> datetime:
    # Snap to single payout day (default 25). Mirrors the gateway helper
    # so admin-grant locks share the same first-payout date as
    # trader-self locks.
    payout_day = max(25, min(28, int(payout_day or 25)))
    if dt.day > payout_day:
        dt = _add_months(dt, 1)
    return dt.replace(day=payout_day, hour=0, minute=0, second=0, microsecond=0)


def _first_payout_date(lock_dt: datetime, cycle_months: int, payout_day: int = 25) -> datetime:
    # First payout = first day 25 strictly after lock_dt for Monthly
    # tenure; for longer tenures, shift cycle_months forward first.
    payout_day = max(25, min(28, int(payout_day or 25)))
    if cycle_months <= 1:
        candidate = lock_dt.replace(
            day=payout_day, hour=0, minute=0, second=0, microsecond=0,
        )
        if candidate <= lock_dt:
            candidate = _add_months(candidate, 1)
        return candidate
    target = _add_months(lock_dt, cycle_months)
    candidate = target.replace(
        day=payout_day, hour=0, minute=0, second=0, microsecond=0,
    )
    if candidate <= target:
        candidate = _add_months(candidate, 1)
    return candidate


def _serialize(r: FixedReturnLock) -> dict:
    """Minimal serializer for admin views — we only echo the fields the
    queue/edit panels render, not the trader-side projections."""
    return {
        "id": str(r.id),
        "user_id": str(r.user_id),
        "principal": float(r.principal or 0),
        "tier_label": r.tier_label,
        "tenure_label": r.tenure_label,
        "rate_pct": float(r.rate_pct or 0),
        "lock_months": int(r.lock_months_at_creation or 24),
        "locked_at": r.locked_at.isoformat() if r.locked_at else None,
        "matures_at": r.matures_at.isoformat() if r.matures_at else None,
        "next_payout_at": r.next_payout_at.isoformat() if r.next_payout_at else None,
        "early_requested_at": (
            r.early_requested_at.isoformat() if r.early_requested_at else None
        ),
        "settled_at": r.settled_at.isoformat() if r.settled_at else None,
        "state": r.state,
        "payouts_count": int(r.payouts_count or 0),
        "total_interest_paid": float(r.total_interest_paid or 0),
        "payout": float(r.payout) if r.payout is not None else None,
        "fee_paid": float(r.fee_paid) if r.fee_paid is not None else None,
    }


async def admin_grant_lock(
    user_id: UUID,
    principal: Decimal,
    tenure_label: str,
    db: AsyncSession,
    *,
    rate_pct_override: Decimal | None = None,
    lock_months_override: int | None = None,
    source: str = "user_wallet",
    note: str | None = None,
) -> dict:
    # Admin-side create. Mirrors the gateway's create_lock money flow
    # but with three extra hooks: rate_pct_override pins the rate for
    # this lock regardless of the global / per-user matrix;
    # lock_months_override sets a one-off lock duration (default
    # honours the global `fixed_return_lock_months`); source picks
    # whether the principal debits the user's wallet ('user_wallet')
    # or comes from the broker as a promo ('admin_grant').
    if principal <= 0:
        raise HTTPException(status_code=400, detail="Principal must be positive")
    if source not in ("user_wallet", "admin_grant"):
        raise HTTPException(status_code=400, detail="source must be 'user_wallet' or 'admin_grant'")

    # Honour any per-user rate-matrix override the admin already set,
    # then optionally pin a one-off rate via rate_pct_override.
    from packages.common.src.settings_store import get_system_setting
    raw = await get_system_setting("fixed_return_rates", None)
    fallback_tiers = [
        {"label": "$1K", "min_amount": 1000},
        {"label": "$10K", "min_amount": 10000},
        {"label": "$25K", "min_amount": 25000},
        {"label": "$50K", "min_amount": 50000},
        {"label": "$100K", "min_amount": 100000},
    ]
    fallback_tenures = [
        {"label": "Month", "days": 30},
        {"label": "Quarter", "days": 90},
        {"label": "Half-Year", "days": 180},
        {"label": "Year", "days": 365},
        {"label": "2 Year", "days": 730},
    ]
    fallback_matrix = [
        [1.0, 2.0, 2.5, 3.0, 4.0],
        [2.0, 3.0, 3.0, 3.5, 4.5],
        [3.0, 4.0, 4.5, 5.0, 5.0],
        [4.0, 5.0, 5.5, 6.0, 5.5],
        [5.0, 6.0, 6.5, 7.0, 7.0],
    ]
    if isinstance(raw, dict) and raw.get("tiers"):
        tiers = raw["tiers"]
        tenures = raw.get("tenures") or fallback_tenures
        matrix = raw.get("rate_matrix_pct") or fallback_matrix
    else:
        tiers, tenures, matrix = fallback_tiers, fallback_tenures, fallback_matrix

    user = (await db.execute(
        select(User).where(User.id == user_id).with_for_update()
    )).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    # Per-user override shape: {"rate_matrix_pct": [[...], ...]}
    override = user.fixed_return_rate_override
    if isinstance(override, dict):
        ov = override.get("rate_matrix_pct")
        if (
            isinstance(ov, list)
            and len(ov) == len(tenures)
            and all(isinstance(r, list) and len(r) == len(tiers) for r in ov)
        ):
            matrix = ov

    lock_months_default = await get_int_setting("fixed_return_lock_months", 24)
    lock_months = int(lock_months_override or lock_months_default)
    if lock_months <= 0:
        raise HTTPException(status_code=400, detail="lock_months must be positive")

    # Tier resolution: pick the highest tier whose min_amount <= principal.
    # Sub-min principals are allowed for admin grants — stamp the lowest tier.
    tier_idx = -1
    for i, t in enumerate(tiers):
        if Decimal(str(t.get("min_amount") or 0)) <= principal:
            tier_idx = i
    if tier_idx < 0:
        tier_idx = 0

    tenure_idx = -1
    for i, t in enumerate(tenures):
        if (t.get("label") or "").lower() == tenure_label.lower():
            tenure_idx = i
            break
    if tenure_idx < 0:
        raise HTTPException(status_code=400, detail=f"Unknown tenure '{tenure_label}'")

    if rate_pct_override is not None:
        if rate_pct_override < 0:
            raise HTTPException(status_code=400, detail="rate_pct_override must be >= 0")
        rate_pct = Decimal(str(rate_pct_override))
    else:
        rate_pct = Decimal(str(matrix[tenure_idx][tier_idx]))
    tier = tiers[tier_idx]
    tenure = tenures[tenure_idx]
    tenure_days = int(tenure["days"])

    if source == "user_wallet":
        balance = Decimal(str(user.main_wallet_balance or 0))
        if balance < principal:
            raise HTTPException(
                status_code=400,
                detail=f"User wallet has ${balance:,.2f}, needs ${principal:,.2f}",
            )
        user.main_wallet_balance = balance - principal

    now = datetime.now(timezone.utc)
    # Mature ONE day before the calendar anniversary (client spec).
    matures_at = _add_months(now, lock_months) - timedelta(days=1)
    payout_dom = await get_int_setting("fixed_return_payout_day_of_month", 25)
    cycle_months = _tenure_to_months(tenure_days)
    next_payout_at = _first_payout_date(now, cycle_months, payout_day=payout_dom)
    if next_payout_at > matures_at:
        next_payout_at = matures_at

    lock = FixedReturnLock(
        user_id=user_id,
        principal=principal,
        tier_label=tier["label"],
        tenure_label=tenure["label"],
        tenure_days=tenure_days,
        rate_pct=rate_pct,
        locked_at=now,
        matures_at=matures_at,
        next_payout_at=next_payout_at,
        lock_months_at_creation=lock_months,
        state="active",
    )
    db.add(lock)

    desc_extra = f" · note: {note}" if note else ""
    if source == "user_wallet":
        db.add(Transaction(
            user_id=user_id,
            type="fixed_return_lock_admin",
            amount=-principal,
            balance_after=user.main_wallet_balance,
            description=(
                f"Admin-created AI-POWERED STAKING PROGRAM lock — {tenure['label']} cycle @ "
                f"{rate_pct}% / {lock_months}m{desc_extra}"
            ),
        ))
    else:
        db.add(Transaction(
            user_id=user_id,
            type="fixed_return_grant",
            amount=Decimal("0"),
            balance_after=Decimal(str(user.main_wallet_balance or 0)),
            description=(
                f"Admin-granted AI-POWERED STAKING PROGRAM — principal ${principal:,.2f}, "
                f"{tenure['label']} cycle @ {rate_pct}% / {lock_months}m "
                f"(broker-funded){desc_extra}"
            ),
        ))
    await db.commit()
    await db.refresh(lock)
    return _serialize(lock)


async def list_pending(db: AsyncSession, kind: str = "early") -> list[dict]:
    """Admin approval queue. kind='early' → early-withdrawal requests (with
    penalty). kind='principal' → matured principal-withdrawal claims (full
    principal, no penalty). (client 2026-07-11)"""
    state = "principal_pending" if kind == "principal" else "early_pending"
    rows = (await db.execute(
        select(FixedReturnLock, User)
        .join(User, User.id == FixedReturnLock.user_id)
        .where(FixedReturnLock.state == state)
        .order_by(FixedReturnLock.early_requested_at.asc())
    )).all()
    fee_pct = await get_float_setting(
        "fixed_return_early_withdrawal_fee_pct", DEFAULT_FEE_PCT,
    )
    out: list[dict] = []
    for lock, user in rows:
        principal = Decimal(str(lock.principal or 0))
        total_interest = Decimal(str(lock.total_interest_paid or 0))
        if kind == "principal":
            # Matured: user gets the FULL principal back, no penalty / clawback.
            projected = principal
            fee = Decimal("0")
        else:
            fee = (principal * Decimal(str(fee_pct)) / Decimal("100")).quantize(Decimal("0.01"))
            projected = (principal - fee - total_interest).quantize(Decimal("0.01"))
            if projected < 0:
                projected = Decimal("0")
        out.append({
            **_serialize(lock),
            "kind": kind,
            "user_id": str(user.id),
            "user_email": user.email,
            "user_name": (
                " ".join(filter(None, [user.first_name, user.last_name])).strip()
                or None
            ),
            "projected_payout": float(projected),
            "projected_fee": float(fee),
            "early_requested_at": (
                lock.early_requested_at.isoformat() if lock.early_requested_at else None
            ),
        })
    return out


async def approve(lock_id: UUID, db: AsyncSession) -> dict:
    lock = (await db.execute(
        select(FixedReturnLock)
        .where(FixedReturnLock.id == lock_id)
        .with_for_update()
    )).scalar_one_or_none()
    if lock is None:
        raise HTTPException(status_code=404, detail="Lock not found")
    if lock.state not in ("early_pending", "principal_pending"):
        raise HTTPException(
            status_code=409,
            detail=f"Lock is {lock.state}, not waiting on approval",
        )

    user = (await db.execute(
        select(User).where(User.id == lock.user_id).with_for_update()
    )).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    principal = Decimal(str(lock.principal or 0))
    total_interest = Decimal(str(lock.total_interest_paid or 0))
    now = datetime.now(timezone.utc)

    if lock.state == "principal_pending":
        # Matured principal claim — pay the FULL principal, no penalty.
        payout = principal
        user.main_wallet_balance = Decimal(str(user.main_wallet_balance or 0)) + payout
        lock.state = "matured"
        lock.payout = payout
        lock.fee_paid = Decimal("0")
        lock.settled_at = now
        lock.early_requested_at = None
        lock.next_payout_at = None
        db.add(Transaction(
            user_id=lock.user_id,
            type="fixed_return_matured",
            amount=payout,
            balance_after=user.main_wallet_balance,
            description=(
                f"AI-POWERED STAKING PROGRAM matured — principal returned (approved) "
                f"(interest paid in {lock.payouts_count} cycles: ${total_interest:,.2f})"
            ),
        ))
        await db.commit()
        await db.refresh(lock)
        return _serialize(lock)

    # Early withdrawal — penalty + interest claw-back.
    fee_pct = await get_float_setting(
        "fixed_return_early_withdrawal_fee_pct", DEFAULT_FEE_PCT,
    )
    fee = (principal * Decimal(str(fee_pct)) / Decimal("100")).quantize(Decimal("0.01"))
    payout = (principal - fee - total_interest).quantize(Decimal("0.01"))
    if payout < 0:
        payout = Decimal("0")

    user.main_wallet_balance = Decimal(str(user.main_wallet_balance or 0)) + payout
    lock.state = "withdrawn_early"
    lock.payout = payout
    lock.fee_paid = fee
    lock.settled_at = now
    lock.early_requested_at = None
    lock.next_payout_at = None

    db.add(Transaction(
        user_id=lock.user_id,
        type="fixed_return_early",
        amount=payout,
        balance_after=user.main_wallet_balance,
        description=(
            f"AI-POWERED STAKING PROGRAM early withdrawal (approved) — penalty ${fee:,.2f} + "
            f"interest claw-back ${total_interest:,.2f}"
        ),
    ))
    await db.commit()
    await db.refresh(lock)
    return _serialize(lock)


async def reject(lock_id: UUID, db: AsyncSession, *, reason: str | None = None) -> dict:
    lock = (await db.execute(
        select(FixedReturnLock)
        .where(FixedReturnLock.id == lock_id)
        .with_for_update()
    )).scalar_one_or_none()
    if lock is None:
        raise HTTPException(status_code=404, detail="Lock not found")
    if lock.state not in ("early_pending", "principal_pending"):
        raise HTTPException(
            status_code=409,
            detail=f"Lock is {lock.state}, not waiting on approval",
        )

    now = datetime.now(timezone.utc)
    is_principal = lock.state == "principal_pending"
    lock.early_requested_at = None

    if is_principal:
        # Matured principal claim rejected — lock goes back to 'active'.
        # matures_at is in the past so it renders as Matured/claimable again;
        # no interest schedule to re-arm (already at/after maturity).
        lock.state = "active"
        lock.next_payout_at = None
        db.add(Transaction(
            user_id=lock.user_id,
            type="fixed_return_principal_rejected",
            amount=Decimal("0"),
            balance_after=Decimal("0"),
            description=(
                "AI-POWERED STAKING PROGRAM principal-withdrawal request rejected by admin"
                + (f": {reason}" if reason else "")
            ),
        ))
        await db.commit()
        await db.refresh(lock)
        return _serialize(lock)

    # Early-withdrawal rejection — re-arm the interest schedule so the lock
    # keeps earning (engine skips NULL next_payout_at rows).
    matures_at = lock.matures_at
    if matures_at and matures_at.tzinfo is None:
        matures_at = matures_at.replace(tzinfo=timezone.utc)
    cycle_months = _tenure_to_months(int(lock.tenure_days or 0))
    payout_dom = await get_int_setting("fixed_return_payout_day_of_month", 25)
    next_payout = _snap_to_payout_window(
        _add_months(now, cycle_months), payout_day=payout_dom,
    )
    if matures_at and next_payout > matures_at:
        next_payout = matures_at

    lock.state = "active"
    lock.next_payout_at = next_payout

    db.add(Transaction(
        user_id=lock.user_id,
        type="fixed_return_early_rejected",
        amount=Decimal("0"),
        balance_after=Decimal("0"),
        description=(
            f"AI-POWERED STAKING PROGRAM early-withdrawal request rejected by admin"
            + (f": {reason}" if reason else "")
        ),
    ))
    await db.commit()
    await db.refresh(lock)
    return _serialize(lock)


async def grant_bonus(
    user_id: UUID, mode: str, value: float, admin_id: UUID, db: AsyncSession,
) -> dict:
    """Special bonus for a Fixed-Return holder. `mode`:
      - "percent" → bonus = value% of the user's TOTAL active locked principal
      - "fixed"   → bonus = a flat USD `value`
    Credited to the user's main wallet as a 'bonus' transaction."""
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    mode = (mode or "fixed").lower()
    v = Decimal(str(value or 0))
    if v <= 0:
        raise HTTPException(status_code=400, detail="Bonus value must be greater than 0")

    if mode == "percent":
        principal = (await db.execute(
            select(func.coalesce(func.sum(FixedReturnLock.principal), 0)).where(
                FixedReturnLock.user_id == user_id,
                FixedReturnLock.state.in_(["active", "early_pending"]),
            )
        )).scalar() or 0
        principal = Decimal(str(principal))
        if principal <= 0:
            raise HTTPException(status_code=400, detail="User has no active Fixed-Return principal to base a % bonus on")
        amount = (principal * v / Decimal("100")).quantize(Decimal("0.01"))
        desc = f"Fixed-Return special bonus ({v}% of ${float(principal):,.2f} principal)"
    else:
        amount = v.quantize(Decimal("0.01"))
        desc = f"Fixed-Return special bonus (${float(amount):,.2f})"

    user.main_wallet_balance = Decimal(str(user.main_wallet_balance or 0)) + amount
    db.add(Transaction(
        user_id=user.id,
        account_id=None,
        type="bonus",
        amount=amount,
        balance_after=user.main_wallet_balance,
        description=desc,
        created_by=admin_id,
    ))
    await create_notification(
        db, user.id,
        title="Bonus credited",
        message=f"${float(amount):,.2f} Fixed-Return bonus has been added to your main wallet.",
        notif_type="bonus",
        action_url="/wallet",
        commit=False,
    )
    await db.commit()
    return {
        "message": "Bonus granted",
        "amount": float(amount),
        "new_main_wallet_balance": float(user.main_wallet_balance),
    }
