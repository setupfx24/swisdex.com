"""InfoWay historical candlestick REST — gap backfill from the SAME provider as
the live WebSocket feed (docs.infoway.io).

Used to fill the window the market-data socket was disconnected for, so the
chart has NO price-basis seam (same source for live + history). Mirrors
``alltick_rest.fetch_klines`` so call-sites read the same.

    POST https://data.infoway.io/{business}/v2/batch_kline
      header  apiKey: <token>
      body    {"klineType": <1-12>, "klineNum": <=500, "codes": "<ONE code>",
               "timestamp": <unix-sec, optional, for historical>}

CRITICAL (per InfoWay docs):
  • Single-symbol query returns up to 500 bars; a multi-symbol BATCH returns
    only the latest 2 bars per product — useless for a gap fill. So callers
    must fetch ONE code per request (loop), never a comma-joined list here.
  • ``respList`` comes newest-first (t descending) — we reverse to ASCENDING.
  • o/h/l/c/v are STRINGS — coerced to float.
  • ``t`` is Unix seconds.
"""
from __future__ import annotations

import logging
from typing import Optional

import httpx

logger = logging.getLogger("infoway_rest")

_BASE = "https://data.infoway.io"

# aggregator timeframe name -> InfoWay klineType
#   1=1m 2=5m 3=15m 4=30m 5=1h 6=2h 7=4h 8=1d 9=1w 10=1mo 11=1q 12=1y
_TF_TO_KLINETYPE = {
    "1m": 1, "5m": 2, "15m": 3, "30m": 4, "1h": 5, "4h": 7, "1d": 8,
}

# Market routing — InfoWay serves different host PATHS and symbol CODES per
# asset class (verified live 2026-06-30 against the batch_kline endpoint):
#   • forex / metals / indices / oil → /common/  + identity code
#   • crypto                          → /crypto/  + <BASE>USDT
#   • US stocks                       → /stock/   + <TICKER>.US
# A couple of platform codes also differ from InfoWay's (NATGAS→NGAS, US100→
# NAS100). Anything else falls through to /common/ + identity.
_CRYPTO = {"BTCUSD", "ETHUSD", "LTCUSD", "XRPUSD", "SOLUSD", "ADAUSD", "BNBUSD", "DOGEUSD"}
_STOCKS = {"AAPL", "AMZN", "GOOGL", "META", "MSFT", "NFLX", "NVDA", "TSLA"}
_CODE_OVERRIDE = {"NATGAS": "NGAS", "US100": "NAS100"}


def _route(symbol: str) -> tuple[str, str]:
    """Return (business, infoway_code) for a platform symbol."""
    s = (symbol or "").strip().upper()
    if s in _CRYPTO:
        base = s[:-3] if s.endswith("USD") else s
        return "crypto", base + "USDT"
    if s in _STOCKS:
        return "stock", s + ".US"
    if s in _CODE_OVERRIDE:
        return "common", _CODE_OVERRIDE[s]
    return "common", s


async def fetch_klines(
    symbol: str,
    tf_name: str,
    count: int = 500,
    end_ts: int = 0,
    token: str = "",
) -> list[dict]:
    """Up to ``count`` historical candles for ONE platform symbol, ASCENDING by
    time. Routes to the right InfoWay host + code per asset class internally.
    Returns ``[]`` on any failure (caller treats absence as "leave the gap"
    rather than crash). ``end_ts`` (unix sec) requests history ending at that
    time; omit for the latest."""
    kline_type = _TF_TO_KLINETYPE.get(tf_name)
    if not kline_type or not (symbol or "").strip() or not (token or "").strip():
        return []

    business, infoway_code = _route(symbol)

    body: dict = {
        "klineType": kline_type,
        "klineNum": min(max(int(count), 1), 500),
        # ONE code only — batch returns just 2 bars per product (see module doc).
        "codes": infoway_code,
    }
    if end_ts and int(end_ts) > 0:
        body["timestamp"] = int(end_ts)

    url = f"{_BASE}/{business}/v2/batch_kline"
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(url, json=body, headers={"apiKey": token.strip()})
        if resp.status_code != 200:
            logger.warning(
                "InfoWay kline %s %s HTTP %s: %s",
                infoway_code, tf_name, resp.status_code, resp.text[:200],
            )
            return []
        payload = resp.json()
    except Exception as exc:  # noqa: BLE001 — network/JSON failure → leave gap
        logger.warning("InfoWay kline fetch failed %s %s: %s", infoway_code, tf_name, exc)
        return []

    rows = payload.get("data") if isinstance(payload, dict) else None
    if not rows:
        return []
    resp_list = (rows[0] or {}).get("respList") or []

    out: list[dict] = []
    for r in resp_list:
        try:
            out.append({
                "time": int(r["t"]),
                "open": float(r["o"]),
                "high": float(r["h"]),
                "low": float(r["l"]),
                "close": float(r["c"]),
                "volume": float(r.get("v") or 0),
            })
        except (KeyError, TypeError, ValueError):
            continue
    # respList is newest-first (t descending) — TradingView needs ascending.
    out.sort(key=lambda b: b["time"])
    return out


async def fetch_latest_close_batch(
    symbols: list[str],
    tf_name: str,
    token: str = "",
) -> dict[str, float]:
    """Latest close per /common/ symbol (forex/metals/indices) in ONE batch
    request. Unlike gap-fill (which needs many bars, so must be single-code),
    the REST-to-tick BRIDGE only needs the latest price — and a multi-symbol
    batch returns the latest ~2 bars per product, which is plenty. One request
    covers all symbols, so it stays within InfoWay's rate budget.

    Returns ``{platform_symbol: close_float}``. Crypto/stocks are skipped here
    (crypto is live via Binance; batching mixes hosts). Returns ``{}`` on any
    failure — the caller just keeps the last price for that symbol."""
    kline_type = _TF_TO_KLINETYPE.get(tf_name)
    if not kline_type or not (token or "").strip():
        return {}

    ordered_syms: list[str] = []
    codes: list[str] = []
    for s in symbols:
        business, code = _route(s)
        if business != "common":       # crypto/stocks aren't batched here
            continue
        ordered_syms.append(s)
        codes.append(code)
    if not codes:
        return {}

    body = {"klineType": kline_type, "klineNum": 2, "codes": ",".join(codes)}
    url = f"{_BASE}/common/v2/batch_kline"
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(url, json=body, headers={"apiKey": token.strip()})
        if resp.status_code != 200:
            logger.warning("InfoWay batch kline HTTP %s: %s", resp.status_code, resp.text[:200])
            return {}
        payload = resp.json()
    except Exception as exc:  # noqa: BLE001 — network/JSON failure → keep last price
        logger.warning("InfoWay batch kline fetch failed: %s", exc)
        return {}

    rows = payload.get("data") if isinstance(payload, dict) else None
    if not rows:
        return {}

    code_to_sym = {c.upper(): s for c, s in zip(codes, ordered_syms)}
    out: dict[str, float] = {}
    for i, row in enumerate(rows):
        resp_list = (row or {}).get("respList") or []
        if not resp_list:
            continue
        try:
            close = float(resp_list[0]["c"])   # respList newest-first → [0] is latest
        except (KeyError, TypeError, ValueError, IndexError):
            continue
        # Map row → platform symbol: prefer an explicit code field on the row,
        # else fall back to request order (InfoWay returns rows in code order).
        code = str(
            (row or {}).get("code")
            or (row or {}).get("s")
            or (row or {}).get("productCode")
            or ""
        ).upper()
        sym = code_to_sym.get(code) or (ordered_syms[i] if i < len(ordered_syms) else None)
        if sym and close > 0:
            out[sym] = close
    return out
