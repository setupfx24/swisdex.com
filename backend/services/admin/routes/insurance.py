"""Admin endpoints for the trade insurance engine — read/edit tunables + stats."""
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies import get_current_admin, require_permission
from packages.common.src.database import get_db
from packages.common.src.models import (
    InsurancePolicy, InsuranceClaim, SystemSetting, User,
)
from packages.common.src.settings_store import invalidate_cache as invalidate_settings_cache


router = APIRouter(prefix="/insurance", tags=["Admin · Trade Insurance"])

INSURANCE_KEYS = (
    "insurance_enabled",
    # ── Pricing — the only model after 2026-05-25 cleanup ─────────
    "insurance_simple_tiers",
    # ── Anti-abuse / duration ─────────────────────────────────────
    "insurance_min_trade_duration_seconds",
    "insurance_anti_abuse_daily_claims",
    "insurance_anti_abuse_daily_payout",
    "insurance_anti_abuse_cooldown_hours",
    # ── Risk-based surcharges (still multiply on tier fee) ────────
    "insurance_dynamic_high_lev_threshold",
    "insurance_dynamic_high_lev_surcharge",
    "insurance_dynamic_no_sl_surcharge",
    "insurance_dynamic_winrate_threshold",
    "insurance_dynamic_winrate_surcharge",
    "insurance_copy_trade_surcharge",
    # ── Volatility kill switches ──────────────────────────────────
    "insurance_disable_atr_floor",
    "insurance_disable_atr_ceiling",
    # ── Frequent-claim coverage reduction ─────────────────────────
    "insurance_frequent_claim_count",
    "insurance_frequent_claim_window_days",
    "insurance_frequent_claim_coverage_reduction_pct",
    # ── News blackout (manual emergency pause) ────────────────────
    "insurance_news_blackout_until",
    # ── Client-spec rules ─────────────────────────────────────────
    "insurance_policy_validity_seconds",
    "insurance_max_policies_per_day",
    "insurance_blackout_hour_start",
    "insurance_blackout_hour_end",
    "insurance_max_lots_insurable",
    "insurance_payout_to_credit",
)


@router.get("/settings")
async def get_settings_view(
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Return the current value of every insurance_* tunable."""
    rows = (await db.execute(
        select(SystemSetting).where(SystemSetting.key.in_(INSURANCE_KEYS))
    )).scalars().all()
    out: dict[str, Any] = {k: None for k in INSURANCE_KEYS}
    for r in rows:
        out[r.key] = r.value
    return out


class InsuranceSettingsUpdate(BaseModel):
    # Free-form: admin sends only the keys they want to change.
    updates: dict[str, Any]


@router.put("/settings")
async def update_settings(
    body: InsuranceSettingsUpdate,
    # Insurance tunables drive fee/payout economics — gate behind
    # insurance.manage (no employee role holds it → super_admin only)
    # (audit M3).
    admin: User = Depends(require_permission("insurance.manage")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Upsert any subset of `INSURANCE_KEYS`. Anything not in the allowlist
    is silently ignored — admin frontend can't escape into other settings."""
    applied = {}
    for key, value in body.updates.items():
        if key not in INSURANCE_KEYS:
            continue
        existing = (await db.execute(
            select(SystemSetting).where(SystemSetting.key == key)
        )).scalar_one_or_none()
        if existing is None:
            db.add(SystemSetting(key=key, value=value, updated_by=admin.id, updated_at=datetime.now(timezone.utc)))
        else:
            existing.value = value
            existing.updated_by = admin.id
            existing.updated_at = datetime.now(timezone.utc)
        applied[key] = value
    await db.commit()
    await invalidate_settings_cache()
    return {"applied": applied}


@router.get("/stats")
async def stats(
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """24h + 7d + lifetime fee revenue, payouts, and gross margin."""
    now = datetime.now(timezone.utc)
    # Promotional demo accounts are hidden from the admin panel.
    promo_ids = select(User.id).where(User.is_promotional == True)  # noqa: E712
    windows = {
        "24h": now - timedelta(days=1),
        "7d":  now - timedelta(days=7),
        "all": None,
    }
    out: dict[str, Any] = {}
    for label, since in windows.items():
        # Fees
        fee_q = select(func.coalesce(func.sum(InsurancePolicy.fee), 0)).where(
            InsurancePolicy.user_id.notin_(promo_ids))
        if since is not None:
            fee_q = fee_q.where(InsurancePolicy.activated_at >= since)
        fees = Decimal(str((await db.execute(fee_q)).scalar_one() or 0))

        # Payouts
        pay_q = select(func.coalesce(func.sum(InsuranceClaim.claim_amount), 0)).where(
            InsuranceClaim.user_id.notin_(promo_ids))
        if since is not None:
            pay_q = pay_q.where(InsuranceClaim.paid_at >= since)
        payouts = Decimal(str((await db.execute(pay_q)).scalar_one() or 0))

        # Counts
        pol_count = (await db.execute(
            select(func.count(InsurancePolicy.id))
            .where(InsurancePolicy.user_id.notin_(promo_ids),
                   *([InsurancePolicy.activated_at >= since] if since is not None else []))
        )).scalar_one()
        clm_count = (await db.execute(
            select(func.count(InsuranceClaim.id))
            .where(InsuranceClaim.user_id.notin_(promo_ids),
                   *([InsuranceClaim.paid_at >= since] if since is not None else []))
        )).scalar_one()

        out[label] = {
            "policies_activated": int(pol_count or 0),
            "claims_paid": int(clm_count or 0),
            "fee_revenue": float(fees),
            "payouts": float(payouts),
            "gross_margin": float(fees - payouts),
        }

    # Top claimants (lifetime) — fraud watch
    top_q = await db.execute(
        select(InsuranceClaim.user_id, func.sum(InsuranceClaim.claim_amount).label("total"))
        .where(InsuranceClaim.user_id.notin_(promo_ids))
        .group_by(InsuranceClaim.user_id)
        .order_by(func.sum(InsuranceClaim.claim_amount).desc())
        .limit(10)
    )
    out["top_claimants"] = [
        {"user_id": str(uid), "total_payout": float(total or 0)}
        for uid, total in top_q.all()
    ]
    return out
