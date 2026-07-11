"""Load admin spread settings and widen mid prices for Redis/WebSocket quotes."""

from __future__ import annotations

import asyncio
import logging
import time
from decimal import Decimal
from typing import Dict, Optional, Tuple

from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from packages.common.src.database import AsyncSessionLocal
from packages.common.src.instrument_pricing import (
    resolve_spread_config, spread_boost_multiplier, symmetric_quote_from_mid,
)
from packages.common.src.models import Instrument, SpreadConfig

logger = logging.getLogger("market-data.spread-cache")

# How often to reload spread params from Postgres (admin edits).
RELOAD_INTERVAL_SEC = 30.0


class StreamSpreadCache:
    """symbol -> (spread_value, spread_type, pip_size, digits).

    Streamed bid/ask use spread_configs only; instrument_configs.price_impact is not
    mixed into quotes (fills and display both use these Redis ticks).
    """

    def __init__(self) -> None:
        self._params: Dict[str, Tuple[Decimal, str, Decimal, int]] = {}
        self._default_spread: Tuple[Decimal, str] = (Decimal("0"), "pips")
        self._lock = asyncio.Lock()
        self._last_reload = 0.0
        # --- Variable (volatility-aware) spread state ---
        # Admin can make the spread fluctuate with the market: when recent
        # moves are larger than the symbol's own normal, the spread widens up
        # to `max_mult`×; in calm markets it stays at 1.0× (= the admin base).
        # Self-calibrating per symbol via fast/slow EWMA of |returns| — no
        # per-symbol tuning needed.
        self._var_enabled: bool = True
        self._var_max_mult: float = 2.0
        self._vol_fast: Dict[str, float] = {}
        self._vol_slow: Dict[str, float] = {}
        self._vol_n: Dict[str, int] = {}
        self._vol_mult: Dict[str, float] = {}
        self._vol_last_mid: Dict[str, float] = {}

    async def reload_if_stale(self, force: bool = False) -> None:
        now = time.monotonic()
        if not force and (now - self._last_reload) < RELOAD_INTERVAL_SEC and self._params:
            return
        async with self._lock:
            now = time.monotonic()
            if not force and (now - self._last_reload) < RELOAD_INTERVAL_SEC and self._params:
                return
            try:
                async with AsyncSessionLocal() as db:
                    r = await db.execute(
                        select(Instrument)
                        .where(Instrument.is_active == True)
                        .options(selectinload(Instrument.segment))
                    )
                    rows = r.scalars().unique().all()
                    new: Dict[str, Tuple[Decimal, str, Decimal, int]] = {}
                    for inst in rows:
                        sv, st, _pimp = await resolve_spread_config(db, inst)
                        pip = Decimal(str(inst.pip_size or 0.0001))
                        digits = int(inst.digits or 5)
                        sym = (inst.symbol or "").strip().upper()
                        if sym:
                            new[sym] = (sv, st, pip, digits)
                    dr = await db.execute(
                        select(SpreadConfig.value, SpreadConfig.spread_type)
                        .where(
                            func.lower(SpreadConfig.scope) == "default",
                            SpreadConfig.is_enabled == True,
                            SpreadConfig.instrument_id.is_(None),
                            SpreadConfig.segment_id.is_(None),
                            SpreadConfig.user_id.is_(None),
                        )
                        .order_by(SpreadConfig.created_at.desc())
                        .limit(1)
                    )
                    drow = dr.first()
                    # Same global boost resolve_spread_config applies — this
                    # fallback row is read directly, so boost it here too.
                    _boost = await spread_boost_multiplier()
                    if drow:
                        self._default_spread = (
                            Decimal(str(drow[0] or 0)) * _boost,
                            (drow[1] or "pips").lower(),
                        )
                    else:
                        self._default_spread = (Decimal("0"), "pips")
                    # Variable-spread admin controls (system_settings).
                    try:
                        from packages.common.src.settings_store import (
                            get_bool_setting, get_float_setting,
                        )
                        # Default OFF (client 2026-06-26): the volatility-based
                        # spread widening moved bid/ask away from mid on every
                        # vol burst, so a BUY's P&L (priced off bid) showed a
                        # loss / jumped around even while the market rose. A
                        # fixed admin spread makes the running P&L track the mid
                        # smoothly. Set variable_spread_enabled=true to re-enable.
                        self._var_enabled = await get_bool_setting(
                            "variable_spread_enabled", False
                        )
                        mm = await get_float_setting("variable_spread_max_mult", 2.0)
                        self._var_max_mult = max(1.0, min(float(mm or 2.0), 5.0))
                    except Exception as _ve:
                        logger.debug("variable-spread settings load failed: %s", _ve)
                    self._params = new
                    self._last_reload = time.monotonic()
                    logger.info(
                        "Reloaded stream spread params for %d instruments (default=%s %s)",
                        len(new),
                        self._default_spread[0],
                        self._default_spread[1],
                    )
            except Exception as exc:
                logger.warning("Spread cache reload failed: %s", exc)

    def note_mid(self, symbol: str, mid: float) -> float:
        """Feed a fresh mid; update the volatility EWMAs and recompute this
        symbol's spread multiplier. Returns the current multiplier (1.0 when
        variable spread is off, during warmup, or in calm markets)."""
        key = (symbol or "").strip().upper()
        if not key or mid <= 0:
            return self._vol_mult.get(key, 1.0)
        last = self._vol_last_mid.get(key)
        self._vol_last_mid[key] = mid
        if not self._var_enabled or last is None or last <= 0:
            if not self._var_enabled:
                self._vol_mult[key] = 1.0
            return self._vol_mult.get(key, 1.0)
        ret = abs(mid - last) / last
        # Fast reacts to bursts; slow is the symbol's "normal" move size.
        a_fast, a_slow = 0.05, 0.002
        self._vol_fast[key] = (1 - a_fast) * self._vol_fast.get(key, ret) + a_fast * ret
        self._vol_slow[key] = (1 - a_slow) * self._vol_slow.get(key, ret) + a_slow * ret
        self._vol_n[key] = self._vol_n.get(key, 0) + 1
        if self._vol_n[key] < 60 or self._vol_slow[key] <= 0:
            self._vol_mult[key] = 1.0
            return 1.0
        ratio = self._vol_fast[key] / self._vol_slow[key]
        raw = 1.0 + 0.5 * (ratio - 1.0)  # gentle gain
        target = max(1.0, min(raw, self._var_max_mult))
        # Smooth the multiplier itself so quotes don't jitter tick-to-tick.
        prev = self._vol_mult.get(key, 1.0)
        self._vol_mult[key] = round(0.8 * prev + 0.2 * target, 4)
        return self._vol_mult[key]

    def mult_for(self, symbol: str) -> float:
        """Current volatility multiplier for a symbol (1.0 if none/off)."""
        if not self._var_enabled:
            return 1.0
        return self._vol_mult.get((symbol or "").strip().upper(), 1.0)

    def widen(self, symbol: str, mid: float) -> Tuple[float, float]:
        """Return bid/ask around mid using admin spread; pass-through if unknown symbol."""
        from .feed_handler import INSTRUMENTS

        key = (symbol or "").strip().upper()
        p: Optional[Tuple[Decimal, str, Decimal, int]] = self._params.get(key)
        if p:
            sv, st, pip, digits = p
        elif key in INSTRUMENTS:
            # Feed streams symbols that may be missing or inactive in Postgres — still apply
            # global default so bid/ask are not frozen at mid (Spr 0).
            info = INSTRUMENTS[key]
            sv, st = self._default_spread
            pip = Decimal(str(info["pip"]))
            digits = int(info["decimals"])
        else:
            return mid, mid
        # Volatility-aware widening: scale the base spread by the live multiplier.
        mult = self.mult_for(key)
        if mult != 1.0:
            sv = sv * Decimal(str(mult))
        b, a = symmetric_quote_from_mid(
            Decimal(str(mid)), sv, st, pip, digits, Decimal("0"),
        )
        return float(b), float(a)
