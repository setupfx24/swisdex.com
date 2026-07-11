"""Live FX conversion to USD for deposits paid in a local currency (INR, ...).

Funds always settle in USD in the main wallet, so a UPI/bank deposit entered in
INR is converted at the LATEST rate. Source: open.er-api.com (free, no key),
cached ~1h per process. If the API is unreachable, fall back to an admin-set
rate `fx_rate_<cur>` (USD per 1 unit, e.g. fx_rate_inr = 0.012).
"""
from __future__ import annotations

import logging
import time
from decimal import Decimal

import httpx

logger = logging.getLogger("fx_rate")

_RATES_URL = "https://open.er-api.com/v6/latest/USD"
_TTL_SEC = 3600
_cache: dict = {"rates": {}, "ts": 0.0}


async def _fetch_rates() -> dict:
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(_RATES_URL)
        data = resp.json()
        if isinstance(data, dict) and data.get("result") == "success":
            return data.get("rates", {}) or {}
    return {}


async def _get_rates() -> dict:
    now = time.time()
    if _cache["rates"] and (now - _cache["ts"]) < _TTL_SEC:
        return _cache["rates"]
    try:
        rates = await _fetch_rates()
        if rates:
            _cache["rates"] = rates
            _cache["ts"] = now
    except Exception as e:  # network/parse — keep any stale cache
        logger.debug("fx rate fetch failed: %s", e)
    return _cache["rates"]


async def usd_per_unit(currency: str) -> Decimal | None:
    """USD value of 1 unit of `currency` (e.g. INR -> ~0.012). None if unknown."""
    cur = (currency or "USD").strip().upper()
    if cur == "USD":
        return Decimal("1")
    rates = await _get_rates()
    units_per_usd = rates.get(cur)  # the API gives units per 1 USD
    if units_per_usd and float(units_per_usd) > 0:
        return Decimal("1") / Decimal(str(units_per_usd))
    # Admin fallback: fx_rate_inr etc. (USD per 1 unit).
    try:
        from .settings_store import get_float_setting
        fb = await get_float_setting(f"fx_rate_{cur.lower()}", 0.0)
        if fb and fb > 0:
            return Decimal(str(fb))
    except Exception:
        pass
    return None


async def convert_to_usd(amount, currency: str) -> Decimal | None:
    """Convert `amount` of `currency` to USD at the latest rate (2dp). None if
    no rate is available (caller decides how to handle)."""
    rate = await usd_per_unit(currency)
    if rate is None:
        return None
    try:
        return (Decimal(str(amount)) * rate).quantize(Decimal("0.01"))
    except Exception:
        return None
