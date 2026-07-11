"""Resolve spread / commission / price impact for order execution (gateway, engines)."""

from decimal import Decimal
from typing import Optional, Tuple
from uuid import UUID

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.models import (
    ChargeConfig, SpreadConfig, Instrument, InstrumentConfig,
    AccountGroup, RewardsUserState,
)


def _acct_grp_clause(model, account_group_id: Optional[UUID]):
    """WHERE-clause helper that matches rows for the given account group
    AND wildcard (NULL) rows. When ``account_group_id`` is None we ONLY
    match wildcards — exactly the behaviour the resolver had before this
    column existed, so legacy rows keep working.
    """
    if account_group_id is None:
        return model.account_group_id.is_(None)
    return or_(
        model.account_group_id == account_group_id,
        model.account_group_id.is_(None),
    )


def _acct_grp_order(model):
    """Sort matching rows (non-NULL account_group_id) BEFORE wildcards so
    ``.limit(1)`` picks the more-specific rule when both exist."""
    return model.account_group_id.is_(None).asc()


# ─── Global spread boost (admin Spread Config page) ─────────────────
# When system setting spread_boost_enabled is true, EVERY resolved spread
# (default / segment / instrument / per-user, fills + display + stream)
# scales by (1 + spread_boost_percent/100). Turning it off restores the
# stored rule values untouched — rules are never mutated.
async def spread_boost_multiplier() -> Decimal:
    try:
        from .settings_store import get_bool_setting, get_float_setting
        if await get_bool_setting("spread_boost_enabled", False):
            pct = await get_float_setting("spread_boost_percent", 0.0)
            if pct:
                return Decimal("1") + Decimal(str(pct)) / Decimal("100")
    except Exception:
        pass
    return Decimal("1")


# ─── XP-tier brokerage discount ─────────────────────────────────────
# Per XP_Reward_mechanism slide 7: higher XP levels reduce brokerage. We
# apply a 1% discount per level above L1, capped at 9% at L10. Modest by
# design — the smart-fee engine and account tier do most of the work.
XP_DISCOUNT_PER_LEVEL = Decimal("0.01")
XP_DISCOUNT_MAX_LEVELS = 9  # so max discount = 9% at level 10


async def _xp_discount_for_user(db: AsyncSession, user_id: UUID) -> Decimal:
    """Returns a multiplier in [0.91, 1.00]. 1.00 means no discount."""
    state = (await db.execute(
        select(RewardsUserState.xp).where(RewardsUserState.user_id == user_id)
    )).scalar_one_or_none()
    if state is None:
        return Decimal("1")
    # Inline level lookup (mirrors LEVEL_THRESHOLDS in rewards_service.py
    # but kept here so this module has no service-layer dependency).
    thresholds = [0, 500, 1500, 3000, 5000, 8000, 12000, 18000, 26000, 36000]
    level = 1
    for i, t in enumerate(thresholds):
        if (state or 0) >= t:
            level = i + 1
    levels_above_one = max(0, min(XP_DISCOUNT_MAX_LEVELS, level - 1))
    return Decimal("1") - (XP_DISCOUNT_PER_LEVEL * Decimal(levels_above_one))

async def _get_instrument_config_row(
    db: AsyncSession, instrument_id: UUID
) -> Optional[InstrumentConfig]:
    r = await db.execute(
        select(InstrumentConfig).where(InstrumentConfig.instrument_id == instrument_id)
    )
    return r.scalar_one_or_none()


async def _instrument_config_price_impact(
    db: AsyncSession, instrument_id: UUID
) -> Decimal:
    ic = await _get_instrument_config_row(db, instrument_id)
    if ic and ic.is_enabled and ic.price_impact:
        return Decimal(str(ic.price_impact))
    return Decimal("0")


async def resolve_spread_config(
    db: AsyncSession,
    instrument: Instrument,
    user_id: Optional[UUID] = None,
    account_group_id: Optional[UUID] = None,
) -> Tuple[Decimal, str, Decimal]:
    """Returns (spread_value, spread_type, price_impact).

    Priority chain (highest → lowest):
      1. User override + this instrument
      2. User override + any instrument
      3. Instrument scope (this instrument)
      4. Segment scope (this instrument's segment)
      5. Default (all instruments)
      6. Zero

    At every scope, the resolver also factors in account_group_id:
    a row whose ``account_group_id`` matches wins over a NULL-wildcard
    row at the same scope. Pass account_group_id=None to keep the
    pre-0049 behaviour (wildcards only).
    """
    pimp = await _instrument_config_price_impact(db, instrument.id)
    boost = await spread_boost_multiplier()

    def _to_tuple(row: SpreadConfig) -> Tuple[Decimal, str, Decimal]:
        return (
            Decimal(str(row.value or 0)) * boost,
            (row.spread_type or "pips").lower(),
            pimp,
        )

    agc = _acct_grp_clause(SpreadConfig, account_group_id)
    ago = _acct_grp_order(SpreadConfig)

    if user_id:
        urow = (await db.execute(
            select(SpreadConfig)
            .where(
                func.lower(SpreadConfig.scope) == "user",
                SpreadConfig.is_enabled == True,
                SpreadConfig.user_id == user_id,
                SpreadConfig.instrument_id == instrument.id,
                agc,
            )
            .order_by(ago)
            .limit(1)
        )).scalar_one_or_none()
        if urow:
            return _to_tuple(urow)

        urow2 = (await db.execute(
            select(SpreadConfig)
            .where(
                func.lower(SpreadConfig.scope) == "user",
                SpreadConfig.is_enabled == True,
                SpreadConfig.user_id == user_id,
                SpreadConfig.instrument_id.is_(None),
                agc,
            )
            .order_by(ago)
            .limit(1)
        )).scalar_one_or_none()
        if urow2:
            return _to_tuple(urow2)

    irow = (await db.execute(
        select(SpreadConfig)
        .where(
            func.lower(SpreadConfig.scope) == "instrument",
            SpreadConfig.is_enabled == True,
            SpreadConfig.user_id.is_(None),
            SpreadConfig.instrument_id == instrument.id,
            agc,
        )
        .order_by(ago)
        .limit(1)
    )).scalar_one_or_none()
    if irow:
        return _to_tuple(irow)

    if instrument.segment_id:
        srow = (await db.execute(
            select(SpreadConfig)
            .where(
                func.lower(SpreadConfig.scope) == "segment",
                SpreadConfig.is_enabled == True,
                SpreadConfig.user_id.is_(None),
                SpreadConfig.segment_id == instrument.segment_id,
                agc,
            )
            .order_by(ago)
            .limit(1)
        )).scalar_one_or_none()
        if srow:
            return _to_tuple(srow)

    default_cfg = (await db.execute(
        select(SpreadConfig)
        .where(
            func.lower(SpreadConfig.scope) == "default",
            SpreadConfig.is_enabled == True,
            SpreadConfig.instrument_id.is_(None),
            SpreadConfig.segment_id.is_(None),
            SpreadConfig.user_id.is_(None),
            agc,
        )
        .order_by(ago, SpreadConfig.created_at.desc())
        .limit(1)
    )).scalar_one_or_none()
    if default_cfg:
        return _to_tuple(default_cfg)

    return Decimal("0"), "pips", pimp


def symmetric_quote_from_mid(
    mid: Decimal,
    spread_value: Decimal,
    spread_type: str,
    pip_size: Decimal,
    decimals: int,
    price_impact: Decimal = Decimal("0"),
) -> Tuple[Decimal, Decimal]:
    """Build executable bid/ask symmetrically around mid (streamed quotes).

    AllTick and other feeds contribute a mid reference; platform spread from
    admin spread_configs (default / segment / instrument / user) is applied
    here so the terminal and order fill prices match.
    """
    st = (spread_type or "pips").lower()
    if st == "percentage":
        adj = mid * (spread_value / Decimal("100"))
    else:
        adj = spread_value * pip_size
    imp = price_impact or Decimal("0")
    half = (adj + imp) / Decimal("2")
    bid = mid - half
    ask = mid + half
    q = Decimal("1") / (Decimal(10) ** max(decimals, 0))
    bid = bid.quantize(q)
    ask = ask.quantize(q)
    if ask < bid:
        ask = bid + q
    elif ask == bid and half > 0:
        ask = bid + q
    return bid, ask


def apply_spread_and_impact_to_prices(
    bid: Decimal,
    ask: Decimal,
    side: str,
    spread_value: Decimal,
    spread_type: str,
    pip_size: Decimal,
    price_impact: Decimal,
) -> Tuple[Decimal, Decimal]:
    """Widen the active side by spread markup + adverse price impact."""
    bid_o, ask_o = bid, ask
    st = (spread_type or "pips").lower()
    mid = (bid + ask) / Decimal("2")

    if st == "percentage":
        adj = mid * (spread_value / Decimal("100"))
    else:
        # pips, fixed, variable → extra distance in price units
        adj = spread_value * pip_size

    imp = price_impact or Decimal("0")
    if side == "buy":
        ask_o = ask + adj + imp
    else:
        bid_o = bid - adj - imp
    return bid_o, ask_o


async def resolve_commission(
    db: AsyncSession,
    instrument: Instrument,
    lots: Decimal,
    fill_price: Decimal,
    user_id: Optional[UUID] = None,
    account_group_id: Optional[UUID] = None,
    apply_xp_discount: bool = True,
) -> Decimal:
    """Total commission for opening/closing a position.

    Priority (highest first):
      1. Admin per-user override + per-instrument
      2. Admin per-user override + any-instrument
      3. Admin per-instrument
      4. Admin per-segment
      5. Admin default
      6. Account-group commission_pct (Phase 2 smart-fee tier)
      7. 0 — last resort, only if there are no admin rows AND no account_group

    If apply_xp_discount=True, the resolved value is multiplied by an XP-tier
    discount (1% per level above L1, capped at 9%). Discount is *opt-out*
    so callers like the trading-catalog page that just preview a rate can
    pass apply_xp_discount=False to show the rack rate.
    """
    notional = lots * (instrument.contract_size or Decimal("100000")) * fill_price

    base_commission: Optional[Decimal] = None

    agc = _acct_grp_clause(ChargeConfig, account_group_id)
    ago = _acct_grp_order(ChargeConfig)

    if user_id is not None:
        urow = (await db.execute(
            select(ChargeConfig)
            .where(
                func.lower(ChargeConfig.scope) == "user",
                ChargeConfig.is_enabled == True,
                ChargeConfig.user_id == user_id,
                ChargeConfig.instrument_id == instrument.id,
                agc,
            )
            .order_by(ago)
            .limit(1)
        )).scalar_one_or_none()
        if urow:
            base_commission = _commission_from_config(urow, lots, notional)

        if base_commission is None:
            urow2 = (await db.execute(
                select(ChargeConfig)
                .where(
                    func.lower(ChargeConfig.scope) == "user",
                    ChargeConfig.is_enabled == True,
                    ChargeConfig.user_id == user_id,
                    ChargeConfig.instrument_id.is_(None),
                    agc,
                )
                .order_by(ago)
                .limit(1)
            )).scalar_one_or_none()
            if urow2:
                base_commission = _commission_from_config(urow2, lots, notional)

    if base_commission is None:
        for scope, seg_id, inst_id in [
            ("instrument", None, instrument.id),
            ("segment", instrument.segment_id, None),
            ("default", None, None),
        ]:
            q = select(ChargeConfig).where(
                ChargeConfig.scope == scope,
                ChargeConfig.is_enabled == True,
                ChargeConfig.user_id.is_(None),
                agc,
            )
            if scope == "instrument":
                q = q.where(ChargeConfig.instrument_id == inst_id)
            elif scope == "segment":
                q = q.where(ChargeConfig.segment_id == seg_id)
            else:
                q = q.where(
                    ChargeConfig.instrument_id.is_(None),
                    ChargeConfig.segment_id.is_(None),
                )
            cfg = (await db.execute(
                q.order_by(ago).limit(1)
            )).scalar_one_or_none()
            if cfg:
                base_commission = _commission_from_config(cfg, lots, notional)
                break

    # Smart-fee fallback: when no admin ChargeConfig matches, charge the
    # account-tier's commission_pct on the trade notional.
    if base_commission is None and account_group_id is not None:
        ag = (await db.execute(
            select(AccountGroup).where(AccountGroup.id == account_group_id)
        )).scalar_one_or_none()
        if ag is not None and ag.commission_pct is not None:
            base_commission = notional * Decimal(str(ag.commission_pct))

    if base_commission is None:
        return Decimal("0")

    if apply_xp_discount and user_id is not None:
        try:
            multiplier = await _xp_discount_for_user(db, user_id)
            base_commission = base_commission * multiplier
        except Exception:
            # XP discount is best-effort; never fail the trade because of it.
            pass

    return base_commission


def _commission_from_config(cfg: ChargeConfig, lots: Decimal, notional: Decimal) -> Decimal:
    v = Decimal(str(cfg.value or 0))
    ct = (cfg.charge_type or "").lower()
    if ct in ("commission_per_lot", "per_lot"):
        return v * lots
    if ct in ("commission_per_trade", "per_trade"):
        return v
    if ct in ("commission_percentage", "percentage", "spread_percentage"):
        return notional * (v / Decimal("100"))
    return v * lots
