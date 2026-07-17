"""AI-POWERED STAKING PROGRAM v2 — periodic interest payouts, fixed lock months.

Tenure controls the PAYOUT CADENCE; the full lock duration is a single
admin setting (``fixed_return_lock_months``, default 24). Interest is
credited per cycle by ``accrue_due_payouts`` (driven by the engine
tick). Principal is returned at maturity. Early exit pays a configurable
penalty AND claws back all interest paid to date.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Optional
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.database import AsyncSessionLocal
from packages.common.src.models import FixedReturnLock, User, Transaction, Notification
from packages.common.src.settings_store import (
    get_system_setting, get_float_setting, get_int_setting,
)

logger = logging.getLogger("fixed_return_service")


DEFAULT_FEE_PCT = 5.0
DEFAULT_LOCK_MONTHS = 24
# 30.4375d ≈ avg month — used only for projection text in the UI; the
# actual matures_at is computed from real calendar months at creation
# (SQL `INTERVAL 'N months'`).
DAYS_PER_MONTH_APPROX = Decimal("30.4375")


# ─── Config ──────────────────────────────────────────────────────────

async def _payout_window_days() -> tuple[int, int]:
    """Admin-set day-of-month range (inclusive, default 25–30) during which
    interest payouts happen — BOTH the scheduled engine credit and the
    on-demand "Withdraw interest" button (client 2026-07-13: outside the
    window the button is disabled and the API refuses)."""
    window_start = await get_int_setting("fixed_return_payout_day_start", 25)
    window_end = await get_int_setting("fixed_return_payout_day_end", 30)
    if window_start < 1:
        window_start = 1
    if window_end > 31:
        window_end = 31
    if window_start > window_end:
        window_start, window_end = window_end, window_start
    return window_start, window_end


async def get_config(
    *, user_id: UUID | None = None, db: AsyncSession | None = None,
) -> dict:
    raw = await get_system_setting("fixed_return_rates", None)
    rates = raw if isinstance(raw, dict) and raw.get("tiers") else _fallback_rates()
    # Standard (post-launch) ladder — kept as-is for the UI's comparison sheet
    # even when the pre-launch matrix below becomes the effective one.
    base_matrix = rates.get("rate_matrix_pct")
    fee_pct = await get_float_setting(
        "fixed_return_early_withdrawal_fee_pct", DEFAULT_FEE_PCT,
    )
    lock_months = await get_int_setting(
        "fixed_return_lock_months", DEFAULT_LOCK_MONTHS,
    )

    # Per-user rate override (Migration 0064). The admin can stamp a
    # custom matrix on a single trader without touching the global
    # ladder. Shape we honour: { "rate_matrix_pct": [[..], ..] } with
    # the same dimensions as the global matrix. If the dimensions
    # don't match (admin re-shaped global tiers / tenures after
    # setting the override), we fall back to the global matrix so the
    # trader never sees a NaN cell.
    has_override = False
    if user_id is not None and db is not None:
        override = (await db.execute(
            select(User.fixed_return_rate_override).where(User.id == user_id)
        )).scalar_one_or_none()
        if isinstance(override, dict):
            ov_matrix = override.get("rate_matrix_pct")
            if isinstance(ov_matrix, list) and len(ov_matrix) == len(rates["tenures"]):
                if all(
                    isinstance(row, list) and len(row) == len(rates["tiers"])
                    for row in ov_matrix
                ):
                    rates = {**rates, "rate_matrix_pct": ov_matrix}
                    has_override = True

    # Pre-launch offer (client 2026-07-14): admin-managed alternate rate matrix
    # shown behind the "Pre launch" button on the trader page. While ENABLED it
    # is also the EFFECTIVE matrix for new locks — the sheet users see is the
    # rate they get. A per-user override (personal deal) still wins over it.
    prelaunch_out = None
    pre_raw = await get_system_setting("fixed_return_prelaunch", None)
    if isinstance(pre_raw, dict) and pre_raw.get("enabled"):
        pm = pre_raw.get("rate_matrix_pct")
        if (
            isinstance(pm, list) and len(pm) == len(rates["tenures"])
            and all(isinstance(r, list) and len(r) == len(rates["tiers"]) for r in pm)
        ):
            prelaunch_out = {
                "enabled": True,
                "headline": str(pre_raw.get("headline") or "Pre-launch offer"),
                "rate_matrix_pct": pm,
            }
            if not has_override:
                rates = {**rates, "rate_matrix_pct": pm}

    window_start, window_end = await _payout_window_days()
    return {
        **rates,
        "early_withdrawal_fee_pct": fee_pct,
        "lock_months": lock_months,
        "has_personal_override": has_override,
        "base_rate_matrix_pct": base_matrix,
        "prelaunch": prelaunch_out,
        # Interest-payout window: scheduled payouts and the on-demand
        # "Withdraw interest" action only work on these days of the month.
        # The open/closed flag is computed server-side (UTC) so the UI and
        # the API gate can never disagree.
        "payout_day_start": window_start,
        "payout_day_end": window_end,
        "payout_window_open": window_start <= datetime.now(timezone.utc).day <= window_end,
    }


def _fallback_rates() -> dict:
    return {
        "tiers": [
            {"label": "$1K", "min_amount": 1000},
            {"label": "$10K", "min_amount": 10000},
            {"label": "$25K", "min_amount": 25000},
            {"label": "$50K", "min_amount": 50000},
            {"label": "$100K", "min_amount": 100000},
        ],
        "tenures": [
            {"label": "Month", "days": 30},
            {"label": "Quarter", "days": 90},
            {"label": "Half-Year", "days": 180},
            {"label": "Year", "days": 365},
            {"label": "2 Year", "days": 730},
        ],
        "rate_matrix_pct": [
            [1.0, 2.0, 2.5, 3.0, 4.0],
            [2.0, 3.0, 3.0, 3.5, 4.5],
            [3.0, 4.0, 4.5, 5.0, 5.0],
            [4.0, 5.0, 5.5, 6.0, 5.5],
            [5.0, 6.0, 6.5, 7.0, 7.0],
        ],
    }


def _resolve_tier_index(amount: Decimal, tiers: list[dict]) -> int:
    idx = -1
    for i, t in enumerate(tiers):
        if Decimal(str(t.get("min_amount") or 0)) <= amount:
            idx = i
    return idx


def _resolve_tenure_index(label: str, tenures: list[dict]) -> int:
    for i, t in enumerate(tenures):
        if (t.get("label") or "").lower() == label.lower():
            return i
    return -1


def _add_months(dt: datetime, months: int) -> datetime:
    """Add calendar months to a UTC datetime, clamped at month-end."""
    year = dt.year + (dt.month - 1 + months) // 12
    month = (dt.month - 1 + months) % 12 + 1
    # Day clamp — e.g. Jan 31 + 1 month → Feb 28/29.
    from calendar import monthrange
    last_day = monthrange(year, month)[1]
    day = min(dt.day, last_day)
    return dt.replace(year=year, month=month, day=day)


def _tenure_to_months(tenure_days: int) -> int:
    """Map the configured tenure_days bucket to whole calendar months so
    payouts always land on the same day-of-month (the configured payout
    day-of-month gate, 25 by default). The buckets follow the admin
    AI-POWERED STAKING PROGRAM matrix: 30 → 1, 90 → 3, 180 → 6, 365 → 12, 730 → 24."""
    if tenure_days >= 700:
        return 24
    if tenure_days >= 350:
        return 12
    if tenure_days >= 170:
        return 6
    if tenure_days >= 80:
        return 3
    return 1


def _snap_to_payout_window(
    dt: datetime,
    *,
    payout_day: int = 25,
    advance_if_before: bool = False,
    window_start: int = 25,
    window_end: int = 30,
) -> datetime:
    """Snap a datetime to the admin-configured payout day (default 25).

    Client spec 2026-06-08 (revised): every cycle credits between
    days 25 and 30. We canonicalize on day 25 (admin-tunable via
    `fixed_return_payout_day_of_month`), zero out the time so payouts
    land at 00:00 UTC.

    `advance_if_before` jumps to NEXT month if `dt.day > payout_day`
    so a date already past this month's window doesn't collapse onto
    a past date.

    `window_start` / `window_end` are accepted for API compat but only
    the legacy single payout_day is used here; the engine itself reads
    the start/end settings to gate cycle firing.
    """
    _ = (window_start, window_end)  # acknowledged, used elsewhere
    payout_day = max(25, min(28, int(payout_day or 25)))
    if advance_if_before and dt.day > payout_day:
        dt = _add_months(dt, 1)
    return dt.replace(
        day=payout_day, hour=0, minute=0, second=0, microsecond=0,
    )


def _first_payout_date(lock_dt: datetime, cycle_months: int, payout_day: int = 25) -> datetime:
    """Pick the first payout date for a brand-new lock.

    Rule (client spec 2026-06-08, "first day 25 strictly AFTER lock"):
      • Monthly tenure (cycle_months = 1): first 25 strictly after lock.
        - Lock 8 Jul → 25 Jul (same month)
        - Lock 25 Jul → 25 Aug (next month)
        - Lock 28 Jul → 25 Aug (next month)
      • Longer tenures (Quarterly / Year / etc): cycle_months later from
        lock, snapped to day 25 — same as before. The proration logic in
        accrue_due_payouts handles any partial-month edge cleanly.
    """
    payout_day = max(25, min(28, int(payout_day or 25)))
    if cycle_months <= 1:
        candidate = lock_dt.replace(
            day=payout_day, hour=0, minute=0, second=0, microsecond=0,
        )
        if candidate <= lock_dt:
            candidate = _add_months(candidate, 1)
        return candidate
    # Multi-month tenure: shift forward by the full cycle, then snap to
    # the next day 25 strictly after that date.
    target = _add_months(lock_dt, cycle_months)
    candidate = target.replace(
        day=payout_day, hour=0, minute=0, second=0, microsecond=0,
    )
    if candidate <= target:
        candidate = _add_months(candidate, 1)
    return candidate


# ─── Lock flow ───────────────────────────────────────────────────────

async def _pay_fr_referral(
    db: AsyncSession, referred_user_id: UUID, basis_amount: Decimal, kind: str,
) -> None:
    """Pay the AI-Powered-Staking referral commission to the referred user's
    referrer, into their referral_commission_balance (withdrawn from /referral).

      kind='principal' → fires ONCE when the referred user locks; pct =
                         fr_referral_principal_pct of the principal.
      kind='interest'  → fires on EACH interest payout; pct =
                         fr_referral_interest_pct of that payout.

    Only pays when the referrer's chosen mode matches `kind` and the admin %
    is > 0. Best-effort — never blocks the lock / payout. (client 2026-06-30)
    """
    try:
        referred_row = (await db.execute(
            select(
                User.referred_by_user_id, User.first_name, User.last_name, User.email,
            ).where(User.id == referred_user_id)
        )).first()
        if not referred_row:
            return
        referrer_id, _rf, _rl, _re = referred_row
        if not referrer_id:
            # Fallback: users who joined via an IB code before 2026-06-23 have
            # no personal referral link (referred_by_user_id was never set) —
            # only a Referral row in the IB tree. Resolve the referrer from
            # there so their staking still pays the IB. Migration 0094
            # backfills the column; this guard covers any row it misses.
            from packages.common.src.models import Referral
            referrer_id = (await db.execute(
                select(Referral.referrer_id)
                .where(Referral.referred_id == referred_user_id)
                .order_by(Referral.created_at.asc())
                .limit(1)
            )).scalar_one_or_none()
        if not referrer_id or referrer_id == referred_user_id:
            return
        referred_display = " ".join(filter(None, [_rf, _rl])).strip() or (_re or "a referral")
        referrer = (await db.execute(
            select(User).where(User.id == referrer_id).with_for_update()
        )).scalar_one_or_none()
        if referrer is None:
            return
        # Per-referrer OVERRIDE for THIS leg (migration 0090). A custom offer
        # pays on its leg REGARDLESS of the referrer's mode — so admin can pay a
        # user on BOTH principal AND interest by setting both overrides. Without
        # an override, the referrer earns only on their chosen mode leg
        # (unchanged behaviour for everyone else). This is the fix for
        # "custom % not working": mode=principal previously killed the interest
        # override entirely (client 2026-07-06).
        override = (
            referrer.fr_referral_principal_pct_override if kind == "principal"
            else referrer.fr_referral_interest_pct_override
        )
        mode = (referrer.fr_referral_mode or "principal").lower()
        if override is None and mode != kind:
            return
        # The GLOBAL (standard) % this leg pays; the portion ABOVE it is the
        # promotional EXPENSE (extra income) logged below.
        setting = "fr_referral_principal_pct" if kind == "principal" else "fr_referral_interest_pct"
        global_pct = Decimal(str(await get_float_setting(setting, 0.0)))
        pct = Decimal(str(override)) if override is not None else global_pct
        if pct <= 0:
            return
        basis = Decimal(str(basis_amount))
        commission = (basis * pct / Decimal("100")).quantize(Decimal("0.01"))
        if commission <= 0:
            return
        referrer.referral_commission_balance = (
            Decimal(str(referrer.referral_commission_balance or 0)) + commission
        )
        db.add(Transaction(
            user_id=referrer.id,
            type="referral_commission",
            amount=commission,
            balance_after=None,
            description=(
                f"AI-POWERED STAKING PROGRAM referral from {referred_display} — {pct}% of "
                f"{'principal' if kind == 'principal' else 'interest payout'}"
            ),
        ))
        # Promotional extra = the premium above the standard rate (only when the
        # referrer has a boosted override). Logged as a PromotionalExpense so it
        # shows in admin's Promotional Expenses AND as the user's extra income.
        extra_pct = pct - global_pct
        if extra_pct > 0:
            extra = (basis * extra_pct / Decimal("100")).quantize(Decimal("0.01"))
            if extra > 0:
                from packages.common.src.models import PromotionalExpense
                db.add(PromotionalExpense(
                    user_id=referrer.id,
                    amount=extra,
                    category="fr_referral_extra",
                    note=(
                        f"AI-POWERED STAKING PROGRAM referral — extra {extra_pct}% "
                        f"(paid {pct}% vs standard {global_pct}%) on "
                        f"{'principal' if kind == 'principal' else 'interest payout'} "
                        f"from {referred_display}"
                    ),
                ))
    except Exception as _e:  # noqa: BLE001
        logger.warning("AI-Staking referral payout (%s) failed: %s", kind, _e)


async def create_lock(
    user_id: UUID,
    principal: Decimal,
    tenure_label: str,
    db: AsyncSession,
    acknowledge_bonus_forfeit: bool = False,
) -> dict:
    if principal <= 0:
        raise HTTPException(status_code=400, detail="Principal must be positive")

    # Pass user context so any per-user override is honoured.
    cfg = await get_config(user_id=user_id, db=db)
    tiers = cfg["tiers"]
    tenures = cfg["tenures"]
    matrix = cfg["rate_matrix_pct"]
    lock_months = int(cfg.get("lock_months") or DEFAULT_LOCK_MONTHS)

    tier_idx = _resolve_tier_index(principal, tiers)
    if tier_idx < 0:
        min_tier = Decimal(str(tiers[0]["min_amount"]))
        raise HTTPException(
            status_code=400,
            detail=f"Minimum lock amount is ${min_tier:,.0f}",
        )

    tenure_idx = _resolve_tenure_index(tenure_label, tenures)
    if tenure_idx < 0:
        raise HTTPException(
            status_code=400, detail=f"Unknown tenure '{tenure_label}'",
        )

    rate_pct = Decimal(str(matrix[tenure_idx][tier_idx]))
    tier = tiers[tier_idx]
    tenure = tenures[tenure_idx]
    tenure_days = int(tenure["days"])

    user = (await db.execute(
        select(User).where(User.id == user_id).with_for_update()
    )).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    balance = Decimal(str(user.main_wallet_balance or 0))
    if balance < principal:
        raise HTTPException(
            status_code=400,
            detail=f"Insufficient wallet balance (have ${balance:,.2f}, need ${principal:,.2f})",
        )

    now = datetime.now(timezone.utc)
    remaining = balance - principal

    # Bonus rule (client 2026-06-30): the trading bonus must stay "backed" by
    # real wallet money. If locking would leave LESS than the bonus amount in
    # the wallet, the ENTIRE bonus is forfeited — and the user must accept that
    # via a confirm popup first. If they haven't (acknowledge_bonus_forfeit is
    # False), reject with 409 so the UI can prompt instead of silently burning
    # the bonus.
    bonus = Decimal(str(user.main_wallet_bonus or 0))
    forfeit_bonus = bonus > 0 and remaining < bonus
    if forfeit_bonus and not acknowledge_bonus_forfeit:
        # 409 + a plain-string detail so the trader UI (which only surfaces
        # err.message + err.status) can show the warning verbatim in an
        # "agree" confirm popup, then re-submit with acknowledge_bonus_forfeit.
        raise HTTPException(
            status_code=409,
            detail=(
                f"Locking ${principal:,.2f} leaves less than your ${bonus:,.2f} "
                f"bonus in the wallet, so your entire ${bonus:,.2f} bonus will be "
                f"forfeited (it can't be used for staking)."
            ),
        )

    user.main_wallet_balance = remaining
    if forfeit_bonus:
        user.main_wallet_bonus = Decimal("0")
        user.bonus_forfeited_at = now
        db.add(Transaction(
            user_id=user_id,
            type="bonus_forfeit",
            amount=-bonus,
            balance_after=user.main_wallet_balance,
            description=f"Bonus forfeited — locked ${principal:,.2f} into AI-POWERED STAKING PROGRAM",
        ))
    # Maturity = anniversary − 1 day (Mig 0067 / client spec 2026-06-08)
    # so users can withdraw on the eve of their lock anniversary.
    matures_at = _add_months(now, lock_months) - timedelta(days=1)
    # Client spec 2026-06-08 (revised): payouts credit on day 25 (within
    # the 25–30 window). FIRST payout date is the first day-25 strictly
    # AFTER lock for Monthly tenure; longer tenures shift cycle_months
    # forward first. The interest amount for that first cycle is
    # PRORATED by the actual days between lock and credit — handled
    # inside accrue_due_payouts.
    payout_dom = await get_int_setting("fixed_return_payout_day_of_month", 25)
    cycle_months = _tenure_to_months(tenure_days)
    next_payout_at = _first_payout_date(now, cycle_months, payout_day=payout_dom)
    # If the first cycle would land past maturity (e.g. 2-Year tenure
    # in a 24-month lock), clamp to maturity so the user receives
    # exactly one cycle at the end.
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

    db.add(Transaction(
        user_id=user_id,
        type="fixed_return_lock",
        amount=-principal,
        balance_after=user.main_wallet_balance,
        description=f"AI-POWERED STAKING PROGRAM lock — {tenure['label']} cycle @ {rate_pct}% / {lock_months}m",
    ))

    # AI-Staking referral: pay the referrer their principal-% commission now
    # (only fires if the referrer chose 'principal' mode and admin set a %).
    await _pay_fr_referral(db, user_id, principal, "principal")

    await db.commit()
    await db.refresh(lock)
    return _serialize_lock(lock)


# ─── Plan upgrade (client 2026-07-11) ────────────────────────────────
# A holder can UPGRADE an active lock to a HIGHER tenure (Month < Quarter
# < Half-Year < Year < 2-Year — never same or lower). On upgrade:
#   1. the elapsed (un-paid) interest of the current plan is prorated for
#      the days since the last payout (or lock) and CREDITED to the wallet,
#   2. the current lock is closed (state='upgraded'),
#   3. a top-up = principal × topup_pct% (admin setting, default 25) is
#      AUTO-DEBITED from the wallet,
#   4. a NEW lock opens with new_principal = old principal + top-up at the
#      chosen higher tenure, fresh lock months. Everything else (rate matrix,
#      payout cadence, referral) behaves exactly like a normal lock.

DEFAULT_UPGRADE_TOPUP_PCT = 25.0


def _accrual_anchor(lock: FixedReturnLock) -> datetime:
    """The datetime interest starts accruing FROM for the current unpaid
    stretch: the later of (a) the last scheduled payout / lock start and
    (b) last_interest_at (set by an on-demand interest withdrawal). Anchoring
    at the max prevents double-paying interest a user already pulled out."""
    if lock.payouts_count and lock.next_payout_at:
        nxt = lock.next_payout_at
        if nxt.tzinfo is None:
            nxt = nxt.replace(tzinfo=timezone.utc)
        cycle_months = _tenure_to_months(int(lock.tenure_days or 0))
        anchor = _add_months(nxt, -cycle_months)
    else:
        anchor = lock.locked_at
    if anchor and anchor.tzinfo is None:
        anchor = anchor.replace(tzinfo=timezone.utc)
    li = lock.last_interest_at
    if li is not None:
        if li.tzinfo is None:
            li = li.replace(tzinfo=timezone.utc)
        if anchor is None or li > anchor:
            anchor = li
    return anchor


async def _elapsed_unpaid_interest(lock: FixedReturnLock, now: datetime) -> Decimal:
    """Prorated interest earned since the accrual anchor that hasn't been
    credited yet: principal × rate_pct% × days_since / 30."""
    anchor = _accrual_anchor(lock)
    days = max(0, (now.date() - anchor.date()).days) if anchor else 0
    if days <= 0:
        return Decimal("0")
    return (
        Decimal(str(lock.principal or 0))
        * Decimal(str(lock.rate_pct or 0))
        * Decimal(str(days))
        / Decimal("100")
        / Decimal("30")
    ).quantize(Decimal("0.01"))


async def withdraw_interest(lock_id: UUID, user_id: UUID, db: AsyncSession) -> dict:
    """On-demand interest withdrawal (client 2026-07-11): credit the accrued
    unpaid interest straight to the main wallet — NO admin approval (it's the
    user's already-earned interest). Only the interest moves; principal stays
    locked and keeps running. Resets the accrual floor to now."""
    lock = (await db.execute(
        select(FixedReturnLock).where(FixedReturnLock.id == lock_id).with_for_update()
    )).scalar_one_or_none()
    if lock is None or lock.user_id != user_id:
        raise HTTPException(status_code=404, detail="Plan not found")
    if lock.state != "active":
        raise HTTPException(status_code=400, detail=f"Interest can only be withdrawn from an active plan (this is {lock.state}).")

    now = datetime.now(timezone.utc)
    # Same admin-set day-of-month window as the scheduled payout engine
    # (client 2026-07-13): outside it the withdrawal is refused — the UI
    # shows the button disabled, this is the server-side backstop.
    window_start, window_end = await _payout_window_days()
    if not (window_start <= now.day <= window_end):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Interest withdrawal is only available from day {window_start} "
                f"to {window_end} of each month. Your interest keeps accruing "
                f"until then."
            ),
        )
    interest = await _elapsed_unpaid_interest(lock, now)
    if interest <= 0:
        raise HTTPException(status_code=400, detail="No interest has accrued yet to withdraw.")

    user = (await db.execute(
        select(User).where(User.id == user_id).with_for_update()
    )).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    user.main_wallet_balance = Decimal(str(user.main_wallet_balance or 0)) + interest
    lock.total_interest_paid = Decimal(str(lock.total_interest_paid or 0)) + interest
    lock.payouts_count = int(lock.payouts_count or 0) + 1
    lock.last_interest_at = now
    db.add(Transaction(
        user_id=user_id,
        type="fixed_return_interest",
        amount=interest,
        balance_after=user.main_wallet_balance,
        description=f"AI Powered Staking — interest withdrawn ({lock.tenure_label} plan)",
    ))
    # Referral: interest-mode commission on this payout, if configured.
    await _pay_fr_referral(db, user_id, interest, "interest")
    await db.commit()
    await db.refresh(lock)
    return {
        "interest_withdrawn": float(interest),
        "new_wallet_balance": float(user.main_wallet_balance),
        "lock": _serialize_lock(lock),
    }


async def upgrade_lock(
    lock_id: UUID,
    user_id: UUID,
    new_tenure_label: str,
    db: AsyncSession,
) -> dict:
    lock = (await db.execute(
        select(FixedReturnLock).where(FixedReturnLock.id == lock_id).with_for_update()
    )).scalar_one_or_none()
    if lock is None or lock.user_id != user_id:
        raise HTTPException(status_code=404, detail="Plan not found")
    if lock.state != "active":
        raise HTTPException(status_code=400, detail=f"Only an active plan can be upgraded (this is {lock.state}).")

    cfg = await get_config(user_id=user_id, db=db)
    tiers = cfg["tiers"]
    tenures = cfg["tenures"]
    matrix = cfg["rate_matrix_pct"]
    lock_months = int(cfg.get("lock_months") or DEFAULT_LOCK_MONTHS)

    cur_tenure_idx = _resolve_tenure_index(lock.tenure_label, tenures)
    new_tenure_idx = _resolve_tenure_index(new_tenure_label, tenures)
    if new_tenure_idx < 0:
        raise HTTPException(status_code=400, detail=f"Unknown plan '{new_tenure_label}'")
    if new_tenure_idx <= cur_tenure_idx:
        raise HTTPException(
            status_code=400,
            detail="You can only upgrade to a higher plan than your current one.",
        )

    topup_pct = Decimal(str(await get_float_setting(
        "fixed_return_upgrade_topup_pct", DEFAULT_UPGRADE_TOPUP_PCT,
    )))
    old_principal = Decimal(str(lock.principal or 0))
    top_up = (old_principal * topup_pct / Decimal("100")).quantize(Decimal("0.01"))
    new_principal = (old_principal + top_up).quantize(Decimal("0.01"))

    user = (await db.execute(
        select(User).where(User.id == user_id).with_for_update()
    )).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    balance = Decimal(str(user.main_wallet_balance or 0))
    if balance < top_up:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Upgrade needs a ${top_up:,.2f} top-up ({topup_pct}% of your "
                f"${old_principal:,.2f} principal) but your wallet has ${balance:,.2f}."
            ),
        )

    now = datetime.now(timezone.utc)

    # 1) Credit elapsed unpaid interest of the current plan to the wallet.
    elapsed_interest = await _elapsed_unpaid_interest(lock, now)
    if elapsed_interest > 0:
        user.main_wallet_balance = Decimal(str(user.main_wallet_balance or 0)) + elapsed_interest
        lock.total_interest_paid = Decimal(str(lock.total_interest_paid or 0)) + elapsed_interest
        db.add(Transaction(
            user_id=user_id,
            type="fixed_return_interest",
            amount=elapsed_interest,
            balance_after=user.main_wallet_balance,
            description=f"AI Powered Staking upgrade — elapsed interest of {lock.tenure_label} plan",
        ))

    # 2) Close the old plan.
    lock.state = "upgraded"
    lock.settled_at = now
    lock.next_payout_at = None

    # 3) Auto-debit the top-up from the wallet.
    user.main_wallet_balance = Decimal(str(user.main_wallet_balance or 0)) - top_up
    db.add(Transaction(
        user_id=user_id,
        type="fixed_return_upgrade_topup",
        amount=-top_up,
        balance_after=user.main_wallet_balance,
        description=f"AI Powered Staking upgrade top-up ({topup_pct}% of ${old_principal:,.2f})",
    ))

    # 4) Open the new higher-tenure plan with new_principal (old + top-up).
    new_tier_idx = _resolve_tier_index(new_principal, tiers)
    if new_tier_idx < 0:
        new_tier_idx = 0
    rate_pct = Decimal(str(matrix[new_tenure_idx][new_tier_idx]))
    tenure = tenures[new_tenure_idx]
    tenure_days = int(tenure["days"])
    matures_at = _add_months(now, lock_months) - timedelta(days=1)
    payout_dom = await get_int_setting("fixed_return_payout_day_of_month", 25)
    cycle_months = _tenure_to_months(tenure_days)
    next_payout_at = _first_payout_date(now, cycle_months, payout_day=payout_dom)
    if next_payout_at > matures_at:
        next_payout_at = matures_at

    new_lock = FixedReturnLock(
        user_id=user_id,
        principal=new_principal,
        tier_label=tiers[new_tier_idx]["label"],
        tenure_label=tenure["label"],
        tenure_days=tenure_days,
        rate_pct=rate_pct,
        locked_at=now,
        matures_at=matures_at,
        next_payout_at=next_payout_at,
        lock_months_at_creation=lock_months,
        state="active",
    )
    db.add(new_lock)
    db.add(Transaction(
        user_id=user_id,
        type="fixed_return_lock",
        amount=Decimal("0"),
        balance_after=user.main_wallet_balance,
        description=(
            f"AI Powered Staking upgraded to {tenure['label']} @ {rate_pct}% / {lock_months}m "
            f"(new principal ${new_principal:,.2f})"
        ),
    ))
    # Upgrade grows the principal — pay the referrer their principal-% on the
    # top-up only (the original principal already paid at the first lock).
    await _pay_fr_referral(db, user_id, top_up, "principal")

    await db.commit()
    await db.refresh(new_lock)
    return {
        "message": "Plan upgraded",
        "elapsed_interest_credited": float(elapsed_interest),
        "topup_debited": float(top_up),
        "topup_pct": float(topup_pct),
        "new_lock": _serialize_lock(new_lock),
    }


async def upgrade_options(lock_id: UUID, user_id: UUID, db: AsyncSession) -> dict:
    """Preview: which higher tenures a lock can upgrade to + the top-up cost
    and elapsed interest, so the trader UI can render the upgrade modal."""
    lock = (await db.execute(
        select(FixedReturnLock).where(FixedReturnLock.id == lock_id)
    )).scalar_one_or_none()
    if lock is None or lock.user_id != user_id:
        raise HTTPException(status_code=404, detail="Plan not found")
    cfg = await get_config(user_id=user_id, db=db)
    tenures = cfg["tenures"]
    tiers = cfg["tiers"]
    matrix = cfg["rate_matrix_pct"]
    cur_idx = _resolve_tenure_index(lock.tenure_label, tenures)
    topup_pct = Decimal(str(await get_float_setting(
        "fixed_return_upgrade_topup_pct", DEFAULT_UPGRADE_TOPUP_PCT,
    )))
    old_principal = Decimal(str(lock.principal or 0))
    top_up = (old_principal * topup_pct / Decimal("100")).quantize(Decimal("0.01"))
    new_principal = old_principal + top_up
    now = datetime.now(timezone.utc)
    elapsed = await _elapsed_unpaid_interest(lock, now)
    new_tier_idx = max(0, _resolve_tier_index(new_principal, tiers))
    options = []
    for i, t in enumerate(tenures):
        if i <= cur_idx:
            continue
        options.append({
            "tenure_label": t["label"],
            "new_rate_pct": float(matrix[i][new_tier_idx]),
        })
    return {
        "lock_id": str(lock.id),
        "current_tenure": lock.tenure_label,
        "current_principal": float(old_principal),
        "topup_pct": float(topup_pct),
        "topup_amount": float(top_up),
        "new_principal": float(new_principal),
        "elapsed_interest": float(elapsed),
        "can_upgrade": len(options) > 0,
        "options": options,
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
    # Admin-side lock creation. Admin can:
    #   • Pick the principal explicitly (no UI form for the trader).
    #   • Override the rate% for this single lock — independent of the
    #     per-user rate_matrix_pct override, since admin may want to
    #     pin a one-off rate without altering the trader's whole matrix.
    #   • Override the lock_months policy for this lock only — useful
    #     for short promo/welcome locks.
    #   • Choose where the principal comes from:
    #       source="user_wallet" → debit user.main_wallet_balance
    #         (admin acts on the user's behalf, same money flow as
    #         the trader pressing Lock on the dashboard)
    #       source="admin_grant" → no wallet debit; the principal is
    #         tracked on the lock only. Use for promotional setups
    #         where the broker funds the position.
    if principal <= 0:
        raise HTTPException(status_code=400, detail="Principal must be positive")
    if source not in ("user_wallet", "admin_grant"):
        raise HTTPException(status_code=400, detail="source must be 'user_wallet' or 'admin_grant'")

    cfg = await get_config(user_id=user_id, db=db)
    tiers = cfg["tiers"]
    tenures = cfg["tenures"]
    matrix = cfg["rate_matrix_pct"]
    lock_months = int(lock_months_override or cfg.get("lock_months") or DEFAULT_LOCK_MONTHS)
    if lock_months <= 0:
        raise HTTPException(status_code=400, detail="lock_months must be positive")

    tier_idx = _resolve_tier_index(principal, tiers)
    if tier_idx < 0:
        # Admin grants below the min-tier are allowed; we just stamp the
        # lowest tier label so reports stay readable.
        tier_idx = 0

    tenure_idx = _resolve_tenure_index(tenure_label, tenures)
    if tenure_idx < 0:
        raise HTTPException(
            status_code=400, detail=f"Unknown tenure '{tenure_label}'",
        )

    if rate_pct_override is not None:
        if rate_pct_override < 0:
            raise HTTPException(status_code=400, detail="rate_pct_override must be >= 0")
        rate_pct = Decimal(str(rate_pct_override))
    else:
        rate_pct = Decimal(str(matrix[tenure_idx][tier_idx]))
    tier = tiers[tier_idx]
    tenure = tenures[tenure_idx]
    tenure_days = int(tenure["days"])

    user = (await db.execute(
        select(User).where(User.id == user_id).with_for_update()
    )).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    if source == "user_wallet":
        balance = Decimal(str(user.main_wallet_balance or 0))
        if balance < principal:
            raise HTTPException(
                status_code=400,
                detail=f"User wallet has ${balance:,.2f}, needs ${principal:,.2f}",
            )
        user.main_wallet_balance = balance - principal

    now = datetime.now(timezone.utc)
    # Client spec 2026-06-08: maturity falls ONE day before the same
    # calendar day N months out, so users can withdraw on the eve of
    # their anniversary instead of waiting through the day itself.
    # Lock 08-Jun-2026 → matures 07-Jun-2028.
    matures_at = _add_months(now, lock_months) - timedelta(days=1)
    payout_dom = await get_int_setting("fixed_return_payout_day_of_month", 25)
    cycle_months = _tenure_to_months(tenure_days)
    next_payout_at = _snap_to_payout_window(
        _add_months(now, cycle_months),
        payout_day=payout_dom,
        advance_if_before=True,
    )
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
        # Admin grant doesn't touch the wallet balance — log a $0
        # Transaction so finance can still see the grant in the audit
        # ledger.
        db.add(Transaction(
            user_id=user_id,
            type="fixed_return_grant",
            amount=Decimal("0"),
            balance_after=Decimal(str(user.main_wallet_balance or 0)),
            description=(
                f"Admin-granted AI-POWERED STAKING PROGRAM — principal ${principal:,.2f}, "
                f"{tenure['label']} cycle @ {rate_pct}% / {lock_months}m"
                f" (broker-funded){desc_extra}"
            ),
        ))
    await db.commit()
    await db.refresh(lock)
    return _serialize_lock(lock)


async def list_locks(user_id: UUID, db: AsyncSession) -> list[dict]:
    rows = (await db.execute(
        select(FixedReturnLock)
        .where(FixedReturnLock.user_id == user_id)
        .order_by(FixedReturnLock.locked_at.desc())
    )).scalars().all()
    return [_serialize_lock(r) for r in rows]


async def withdraw_lock(
    lock_id: UUID,
    user_id: UUID,
    db: AsyncSession,
) -> dict:
    lock = (await db.execute(
        select(FixedReturnLock)
        .where(FixedReturnLock.id == lock_id)
        .with_for_update()
    )).scalar_one_or_none()
    if lock is None or lock.user_id != user_id:
        raise HTTPException(status_code=404, detail="Lock not found")
    if lock.state != "active":
        raise HTTPException(status_code=400, detail=f"Lock is already {lock.state}")

    user = (await db.execute(
        select(User).where(User.id == user_id).with_for_update()
    )).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    now = datetime.now(timezone.utc)
    principal = Decimal(str(lock.principal))
    total_interest = Decimal(str(lock.total_interest_paid or 0))

    matures_at = lock.matures_at
    if matures_at and matures_at.tzinfo is None:
        matures_at = matures_at.replace(tzinfo=timezone.utc)

    if matures_at and matures_at <= now:
        # Matured — principal claim now routes through ADMIN APPROVAL (client
        # 2026-07-11) instead of an instant credit. Park in principal_pending
        # so it surfaces on the admin AI-Powered Staking approval queue + bell;
        # admin approve() credits the principal and flips to matured.
        if lock.state == "principal_pending":
            raise HTTPException(
                status_code=409,
                detail="A principal-withdrawal request is already pending admin approval",
            )
        lock.state = "principal_pending"
        lock.early_requested_at = now   # reuse the request-timestamp column
        lock.next_payout_at = None
        db.add(Transaction(
            user_id=user_id,
            type="fixed_return_principal_request",
            amount=Decimal("0"),
            balance_after=user.main_wallet_balance,
            description=f"AI Powered Staking — principal withdrawal requested (${principal:,.2f}), awaiting admin approval",
        ))
        await db.commit()
        await db.refresh(lock)
        return _serialize_lock(lock)

    # Early exit — client request 2026-06-01: route through admin approval
    # instead of crediting immediately. We park the lock in `early_pending`
    # so the trader can't keep racking up interest (engine skips non-active
    # states) AND so the funds stay where they are until an admin signs off.
    if lock.state == "early_pending":
        raise HTTPException(
            status_code=409,
            detail="An early-withdrawal request is already pending admin approval",
        )
    lock.state = "early_pending"
    lock.early_requested_at = now
    # We deliberately do NOT touch user.main_wallet_balance, lock.payout,
    # lock.fee_paid, or lock.settled_at here — admin approval (or rejection)
    # is what mutates those.
    db.add(Transaction(
        user_id=user_id,
        type="fixed_return_early_request",
        amount=Decimal("0"),
        balance_after=Decimal(str(user.main_wallet_balance or 0)),
        description=(
            f"AI-POWERED STAKING PROGRAM early-withdrawal request filed — awaiting admin "
            f"approval (principal ${principal:,.2f}, "
            f"interest-to-date ${total_interest:,.2f})"
        ),
    ))
    await db.commit()
    await db.refresh(lock)
    return _serialize_lock(lock)


async def admin_approve_early_withdrawal(
    lock_id: UUID, db: AsyncSession,
) -> dict:
    """Admin sign-off: credit the trader's wallet with
    principal × (1 − fee_pct) − total_interest_paid, flip the lock to
    `withdrawn_early`, and write the realised Transaction. Idempotent
    against double-clicks because the second call sees state != early_pending
    and raises 409."""
    lock = (await db.execute(
        select(FixedReturnLock)
        .where(FixedReturnLock.id == lock_id)
        .with_for_update()
    )).scalar_one_or_none()
    if lock is None:
        raise HTTPException(status_code=404, detail="Lock not found")
    if lock.state != "early_pending":
        raise HTTPException(
            status_code=409,
            detail=f"Lock is {lock.state}, not waiting on approval",
        )

    user = (await db.execute(
        select(User).where(User.id == lock.user_id).with_for_update()
    )).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    principal = Decimal(str(lock.principal))
    total_interest = Decimal(str(lock.total_interest_paid or 0))
    fee_pct = await get_float_setting(
        "fixed_return_early_withdrawal_fee_pct", DEFAULT_FEE_PCT,
    )
    fee = (principal * Decimal(str(fee_pct)) / Decimal("100")).quantize(Decimal("0.01"))
    payout = (principal - fee - total_interest).quantize(Decimal("0.01"))
    if payout < 0:
        payout = Decimal("0")

    now = datetime.now(timezone.utc)
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
    return _serialize_lock(lock)


async def admin_reject_early_withdrawal(
    lock_id: UUID, db: AsyncSession, *, reason: str | None = None,
) -> dict:
    """Admin denies the request. Lock returns to `active`; interest
    accrual resumes on the next engine tick inside the payout window.
    We do NOT restore next_payout_at here because the engine sets it
    when active locks with NULL next_payout_at are picked up — but to
    be safe, we re-snap it from now+cycle_months."""
    lock = (await db.execute(
        select(FixedReturnLock)
        .where(FixedReturnLock.id == lock_id)
        .with_for_update()
    )).scalar_one_or_none()
    if lock is None:
        raise HTTPException(status_code=404, detail="Lock not found")
    if lock.state != "early_pending":
        raise HTTPException(
            status_code=409,
            detail=f"Lock is {lock.state}, not waiting on approval",
        )

    now = datetime.now(timezone.utc)
    matures_at = lock.matures_at
    if matures_at and matures_at.tzinfo is None:
        matures_at = matures_at.replace(tzinfo=timezone.utc)

    cycle_months = _tenure_to_months(int(lock.tenure_days or 0))
    payout_dom = await get_int_setting("fixed_return_payout_day_of_month", 25)
    next_payout = _snap_to_payout_window(
        _add_months(now, cycle_months),
        payout_day=payout_dom,
        advance_if_before=True,
    )
    if matures_at and next_payout > matures_at:
        next_payout = matures_at

    lock.state = "active"
    lock.early_requested_at = None
    lock.next_payout_at = next_payout

    db.add(Transaction(
        user_id=lock.user_id,
        type="fixed_return_early_rejected",
        amount=Decimal("0"),
        balance_after=Decimal("0"),  # no balance change, informational
        description=(
            f"AI-POWERED STAKING PROGRAM early-withdrawal request rejected by admin"
            + (f": {reason}" if reason else "")
        ),
    ))
    await db.commit()
    await db.refresh(lock)
    return _serialize_lock(lock)


async def admin_list_pending(db: AsyncSession) -> list[dict]:
    """All locks currently parked in early_pending — admin queue."""
    rows = (await db.execute(
        select(FixedReturnLock, User)
        .join(User, User.id == FixedReturnLock.user_id)
        .where(FixedReturnLock.state == "early_pending")
        .order_by(FixedReturnLock.early_requested_at.asc())
    )).all()
    out: list[dict] = []
    for lock, user in rows:
        principal = Decimal(str(lock.principal))
        total_interest = Decimal(str(lock.total_interest_paid or 0))
        fee_pct = await get_float_setting(
            "fixed_return_early_withdrawal_fee_pct", DEFAULT_FEE_PCT,
        )
        fee = (principal * Decimal(str(fee_pct)) / Decimal("100")).quantize(Decimal("0.01"))
        projected = (principal - fee - total_interest).quantize(Decimal("0.01"))
        if projected < 0:
            projected = Decimal("0")
        out.append({
            **_serialize_lock(lock),
            "user_id": str(user.id),
            "user_email": user.email,
            "user_name": (
                " ".join(filter(None, [user.first_name, user.last_name])).strip()
                or None
            ),
            "projected_payout": float(projected),
            "projected_fee": float(fee),
            "early_requested_at": (
                lock.early_requested_at.isoformat()
                if lock.early_requested_at else None
            ),
        })
    return out


# ─── Interest payout engine ──────────────────────────────────────────

async def accrue_due_payouts(db: AsyncSession) -> int:
    """Find every active lock whose next_payout_at <= now and credit
    one interest cycle. Bumps total_interest_paid + payouts_count, and
    advances next_payout_at by tenure_days (or clears it once we're past
    maturity).

    Returns the number of payouts credited.

    Idempotency: we only credit cycles whose next_payout_at is already
    in the past — engine ticks repeatedly with no state change.

    Payout window: cycles whose next_payout_at has elapsed only credit
    when today's day-of-month is inside the admin-set range (default
    25–30 per client spec revision 2026-06-08; admin can still tune via
    the `fixed_return_payout_day_start` / `_end` settings).
    """
    now = datetime.now(timezone.utc)

    window_start, window_end = await _payout_window_days()
    if not (window_start <= now.day <= window_end):
        return 0

    rows = (await db.execute(
        select(FixedReturnLock).where(
            FixedReturnLock.state == "active",
            FixedReturnLock.next_payout_at.is_not(None),
            FixedReturnLock.next_payout_at <= now,
        ).with_for_update(skip_locked=True)
    )).scalars().all()

    paid = 0
    for lock in rows:
        try:
            user = (await db.execute(
                select(User).where(User.id == lock.user_id).with_for_update()
            )).scalar_one_or_none()
            if user is None:
                lock.next_payout_at = None
                continue

            # Rate matrix cell is a PER-MONTH percentage. Interest is credited
            # for the days between the accrual anchor and now — the anchor is
            # the later of the last scheduled cycle / lock start and
            # last_interest_at (an on-demand interest withdrawal). This one
            # formula prorates the first cycle AND avoids double-paying any
            # interest the user already pulled out on demand.
            months_per_cycle = _tenure_to_months(int(lock.tenure_days or 0))
            anchor = _accrual_anchor(lock)
            days_accrued = max(0, (now.date() - anchor.date()).days) if anchor else 0
            interest = (
                Decimal(str(lock.principal or 0))
                * Decimal(str(lock.rate_pct or 0))
                * Decimal(str(days_accrued))
                / Decimal("100")
                / Decimal("30")
            ).quantize(Decimal("0.01"))
            if interest <= 0:
                lock.next_payout_at = None
                continue

            user.main_wallet_balance = (
                Decimal(str(user.main_wallet_balance or 0)) + interest
            )
            lock.total_interest_paid = (
                Decimal(str(lock.total_interest_paid or 0)) + interest
            )
            lock.payouts_count = int(lock.payouts_count or 0) + 1
            # Reset the accrual floor to this credit moment so the next stretch
            # (scheduled or on-demand) starts fresh from here.
            lock.last_interest_at = now

            # Advance the schedule by exactly one calendar cycle. Per
            # client spec 2026-06-08, the cycle day-of-month locks to
            # whatever day the FIRST cycle credited on. After the first
            # cycle pays out, _add_months preserves the day exactly so
            # every subsequent cycle hits the same calendar day. No
            # re-snap to a global day-of-month — that was the old
            # 25-only behaviour we're moving away from.
            matures_at = lock.matures_at
            if matures_at and matures_at.tzinfo is None:
                matures_at = matures_at.replace(tzinfo=timezone.utc)
            nxt = (lock.next_payout_at or now)
            if nxt.tzinfo is None:
                nxt = nxt.replace(tzinfo=timezone.utc)
            cycle_months = _tenure_to_months(int(lock.tenure_days or 0))
            advanced = _add_months(nxt, cycle_months)
            if matures_at and advanced >= matures_at:
                lock.next_payout_at = None
            else:
                lock.next_payout_at = advanced

            db.add(Transaction(
                user_id=lock.user_id,
                type="fixed_return_interest",
                amount=interest,
                balance_after=user.main_wallet_balance,
                description=(
                    f"AI-POWERED STAKING PROGRAM interest — {lock.tenure_label} cycle "
                    f"#{lock.payouts_count} ({lock.rate_pct}%)"
                ),
            ))
            # AI-Staking referral: pay the referrer their interest-% cut of this
            # payout (only if they chose 'interest' mode and admin set a %).
            await _pay_fr_referral(db, lock.user_id, interest, "interest")
            # Notification: "you can withdraw" — informs the user the
            # interest just landed in their main wallet and they're free
            # to withdraw it (the wallet itself is always withdrawable).
            # Best-effort — swallow exceptions so a notification glitch
            # never blocks the credit.
            try:
                next_dt = lock.next_payout_at
                next_iso = (
                    next_dt.strftime("%d %b %Y")
                    if next_dt else "after maturity"
                )
                db.add(Notification(
                    user_id=lock.user_id,
                    title="AI-POWERED STAKING PROGRAM payout received",
                    message=(
                        f"${float(interest):,.2f} AI-POWERED STAKING PROGRAM interest credited to your "
                        f"main wallet. You can withdraw it any time. Next cycle: {next_iso}."
                    ),
                    type="fixed_return_interest",
                ))
            except Exception as _ne:
                logger.warning("FR interest notification failed: %s", _ne)
            paid += 1
        except Exception as exc:
            logger.error("AI-POWERED STAKING PROGRAM payout failed for lock %s: %s", lock.id, exc)

    if paid:
        await db.commit()
    return paid


# ─── Serialization ───────────────────────────────────────────────────

def _serialize_lock(r: FixedReturnLock) -> dict:
    principal = Decimal(str(r.principal or 0))
    rate_pct = Decimal(str(r.rate_pct or 0))
    interest_paid = Decimal(str(r.total_interest_paid or 0))
    # Projection: rate_pct is per-MONTH (client spec 2026-05-26), so
    # the user receives `principal * rate_pct% * lock_months` total
    # interest if the lock runs to maturity. Cadence (Month / Quarter /
    # etc.) only changes when the money lands, not how much.
    lock_months = int(r.lock_months_at_creation or 24)
    projected_interest = (
        principal * rate_pct * Decimal(lock_months) / Decimal("100")
    ).quantize(Decimal("0.01"))

    # Daily / since-last-cycle accrual — the trader's most-asked-for
    # number ("kitna interest ban chuka hai"). Engine credits in
    # discrete cycles, so anything earned since the last credit is a
    # projection: principal × rate_pct/100 × days_elapsed/30.
    # We anchor `days_elapsed` to the last actual payout (or locked_at
    # if no payout has fired yet), so the figure resets cleanly to 0
    # the moment a cycle credits.
    now = datetime.now(timezone.utc)
    # Accrual floor: later of the scheduled anchor and last_interest_at (set
    # by an on-demand interest withdrawal) so the accrued figure resets to 0
    # right after the user pulls interest out.
    anchor = _accrual_anchor(r)
    # Count WHOLE CALENDAR DAYS in IST (UTC+5:30), not rolling 24h periods, so
    # the displayed accrued interest ticks up at local 12:00 AM each day rather
    # than at the lock's time-of-day (client 2026-06-30: "jo interest show ho
    # raha hai woh 12am par update ho jaye"). The actual payout cadence is
    # unchanged — this only affects the live accrued projection shown to the user.
    days_elapsed = 0
    if anchor is not None:
        _ist = timezone(timedelta(hours=5, minutes=30))
        days_elapsed = max(0, (now.astimezone(_ist).date() - anchor.astimezone(_ist).date()).days)
    # rate_pct is per 30-day month per client spec, so daily ≈ rate/30.
    daily_rate = rate_pct / Decimal("100") / Decimal("30")
    accrued_since_last = (
        principal * daily_rate * Decimal(days_elapsed)
    ).quantize(Decimal("0.01"))
    if accrued_since_last < 0:
        accrued_since_last = Decimal("0")
    interest_to_date = (interest_paid + accrued_since_last).quantize(Decimal("0.01"))

    return {
        "id": str(r.id),
        "principal": float(principal),
        "tier_label": r.tier_label,
        "tenure_label": r.tenure_label,
        "tenure_days": int(r.tenure_days or 0),
        "rate_pct": float(rate_pct),
        "lock_months": lock_months,
        "locked_at": r.locked_at.isoformat() if r.locked_at else None,
        "matures_at": r.matures_at.isoformat() if r.matures_at else None,
        "next_payout_at": r.next_payout_at.isoformat() if r.next_payout_at else None,
        "settled_at": r.settled_at.isoformat() if r.settled_at else None,
        "early_requested_at": (
            r.early_requested_at.isoformat() if r.early_requested_at else None
        ),
        "state": r.state,
        "payouts_count": int(r.payouts_count or 0),
        "total_interest_paid": float(interest_paid),
        # Pro-rata projection between cycles — never persisted, recomputed
        # each request so it stays current to the day without an engine
        # tick. Resets to 0 when a real cycle credits.
        "accrued_since_last_payout": float(accrued_since_last),
        # Convenience for the trader card: "interest earned so far",
        # smoothing the saw-tooth of cycle credits.
        "interest_to_date": float(interest_to_date),
        "projected_total_interest": float(projected_interest),
        "projected_total_payout": float(principal + projected_interest),
        "payout": float(r.payout) if r.payout is not None else None,
        "fee_paid": float(r.fee_paid) if r.fee_paid is not None else None,
    }
