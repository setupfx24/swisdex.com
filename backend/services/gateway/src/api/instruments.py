"""Instruments API — List instruments, get current prices."""
import asyncio
import json as _json
import logging
import time as _time
from decimal import Decimal
from uuid import UUID
from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.alltick_rest import fetch_klines as alltick_fetch_klines
from packages.common.src.infoway_rest import fetch_klines as infoway_fetch_klines
from packages.common.src.auth import get_current_user
from packages.common.src.config import get_settings
from packages.common.src.database import get_db
from packages.common.src.instrument_pricing import resolve_spread_config
from packages.common.src.models import Instrument, TradingAccount
from packages.common.src.redis_client import redis_client, PriceChannel
from packages.common.src.schemas import InstrumentResponse, TickData
from packages.common.src.instrumentation import get_rate_limiter
from ..services import instrument_service

router = APIRouter()
_limiter = get_rate_limiter()
_logger = logging.getLogger("gateway.instruments")

# TradingView resolution string → bar aggregator timeframe key
_TV_RESOLUTION_TO_TF: dict[str, str] = {
    "1": "1m", "5": "5m", "15": "15m", "30": "30m",
    "60": "1h", "240": "4h", "D": "1d", "1D": "1d",
}

# Resolution → Binance kline interval string
_TV_RESOLUTION_TO_BINANCE: dict[str, str] = {
    "1": "1m", "5": "5m", "15": "15m", "30": "30m",
    "60": "1h", "240": "4h", "D": "1d", "1D": "1d",
}

# Platform symbol → Binance REST pair (crypto only)
_BINANCE_PAIRS: dict[str, str] = {
    "BTCUSD": "BTCUSDT", "ETHUSD": "ETHUSDT", "LTCUSD": "LTCUSDT",
    "XRPUSD": "XRPUSDT", "SOLUSD": "SOLUSDT", "BNBUSD": "BNBUSDT",
    "DOGEUSD": "DOGEUSDT", "ADAUSD": "ADAUSDT",
}


async def _fetch_binance_klines(
    symbol: str, resolution: str, from_time: int, to_time: int,
) -> list[dict]:
    """Fetch historical klines from Binance public REST API (no key needed).

    Results are cached in Redis for 60s to avoid repeated API calls on chart
    pan/zoom, which makes subsequent loads instant.
    """
    import httpx

    pair = _BINANCE_PAIRS.get(symbol.upper())
    if not pair:
        return []

    tf = _TV_RESOLUTION_TO_BINANCE.get(resolution, "5m")

    # --- Check Redis cache first ---
    cache_key = f"binance_cache:{symbol}:{tf}"
    try:
        cached = await redis_client.get(cache_key)
        if cached:
            all_bars: list[dict] = _json.loads(cached)
            # Filter by requested time range
            return [
                b for b in all_bars
                if (not from_time or b["time"] >= from_time)
                and (not to_time or b["time"] <= to_time)
            ]
    except Exception:
        pass

    # --- Fetch from Binance ---
    start_ms = from_time * 1000 if from_time else None
    end_ms = to_time * 1000 if to_time else None

    params: dict = {"symbol": pair, "interval": tf, "limit": 1000}
    if start_ms:
        params["startTime"] = start_ms
    if end_ms:
        params["endTime"] = end_ms

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get("https://api.binance.com/api/v3/klines", params=params)
            if resp.status_code != 200:
                _logger.warning("Binance klines HTTP %s for %s", resp.status_code, symbol)
                return []
            data = resp.json()
    except Exception as exc:
        _logger.warning("Binance klines fetch failed for %s: %s", symbol, exc)
        return []

    bars = []
    for k in data:
        bars.append({
            "time": int(k[0]) // 1000,
            "open": float(k[1]),
            "high": float(k[2]),
            "low": float(k[3]),
            "close": float(k[4]),
            "volume": float(k[5]),
        })

    # --- Cache in Redis (60s TTL) ---
    if bars:
        try:
            await redis_client.set(cache_key, _json.dumps(bars), ex=60)
        except Exception:
            pass

    return bars


@router.get("/", response_model=list[InstrumentResponse])
async def list_instruments(
    segment: str | None = None,
    active_only: bool = True,
    db: AsyncSession = Depends(get_db),
):
    return await instrument_service.list_instruments(
        segment=segment, active_only=active_only, db=db,
    )


@router.get("/market-status")
async def get_market_status(db: AsyncSession = Depends(get_db)):
    """Return market open/closed status for every active instrument.

    Clients should poll this every 60 s (or on page focus) to refresh
    the market-open state without spamming the server.
    """
    return await instrument_service.get_market_status(db=db)


@router.get("/market-status/{symbol}")
async def get_symbol_market_status(symbol: str, db: AsyncSession = Depends(get_db)):
    """Return market status for a single symbol."""
    return await instrument_service.get_symbol_market_status(symbol=symbol, db=db)


@router.get("/prices/all")
async def get_all_prices():
    """Static path before /{symbol}/price so it is never captured as a symbol."""
    return await instrument_service.get_all_prices()


@router.get("/{symbol}/price", response_model=TickData)
async def get_price(symbol: str):
    return await instrument_service.get_price(symbol=symbol)


async def _backfill_alltick_bars(
    sym: str, tf: str, *, end_ts: int = 0,
) -> list[dict]:
    """On-demand AllTick REST backfill for non-crypto symbols.

    Called when Redis returns fewer bars than the chart needs (cold cache
    on first deploy, or the user pans/scrolls to history older than the
    1000-bar Redis ring). Writes the result back into Redis so the next
    request is warm. Returns the bars (oldest → newest).
    """
    settings = get_settings()
    token = (settings.ALLTICK_TOKEN or "").strip()
    if not token:
        return []

    try:
        bars = await alltick_fetch_klines(sym, tf, count=1000, end_ts=end_ts, token=token)
    except Exception as exc:
        _logger.warning("alltick on-demand fetch failed for %s %s: %s", sym, tf, exc)
        return []

    if not bars:
        return []

    # Merge with whatever's in Redis (dedup by timestamp), then re-write the
    # full list so the next request is warm. We use lpush + ltrim 1000 to
    # match BarAggregator's convention (newest at index 0). Bars are emitted
    # by alltick_rest as oldest→newest, so iterating in that order with lpush
    # leaves the newest bar at index 0 of the Redis list — what get_bars
    # below expects on the read path.
    list_key = f"bars:{sym}:{tf}"
    existing_raw = await redis_client.lrange(list_key, 0, 999)
    seen_ts = set()
    merged: list[dict] = []
    for raw in existing_raw:
        try:
            b = _json.loads(raw)
            t = int(b.get("time", 0))
            if t in seen_ts:
                continue
            seen_ts.add(t)
            merged.append({
                "time": t,
                "open": float(b["open"]),
                "high": float(b["high"]),
                "low": float(b["low"]),
                "close": float(b["close"]),
                "volume": float(b.get("volume", 0.0)),
                "tick_count": int(b.get("tick_count") or 0),
            })
        except Exception:
            continue
    for b in bars:
        if b["time"] in seen_ts:
            continue
        seen_ts.add(b["time"])
        merged.append(b)
    merged.sort(key=lambda x: x["time"])

    # Write back. lpush in reverse order so newest ends at head.
    try:
        pipe = redis_client.pipeline()
        pipe.delete(list_key)
        for b in merged:
            entry = {**b, "symbol": sym, "timeframe": tf}
            pipe.lpush(list_key, _json.dumps(entry))
        pipe.ltrim(list_key, 0, 999)
        await pipe.execute()
    except Exception as exc:
        _logger.warning("alltick cache writeback failed for %s %s: %s", sym, tf, exc)

    return merged


async def _backfill_infoway_bars(
    sym: str, tf: str, *, end_ts: int = 0,
) -> list[dict]:
    """On-demand InfoWay REST history backfill — the SAME provider as the live
    feed, so chart history and live bars share one price basis (no seam). Works
    for EVERY asset class: infoway_rest routes the host + code per market
    (forex/metals/indices/oil → common, crypto → crypto host + USDT, US stocks →
    stock host + .US). Merges with Redis (dedup by time) and writes back so the
    next request is warm. Returns oldest → newest. (client 2026-06-30)
    """
    settings = get_settings()
    token = (getattr(settings, "INFOWAY_TOKEN", "") or "").strip()
    if not token:
        return []

    try:
        bars = await infoway_fetch_klines(sym, tf, count=500, end_ts=end_ts, token=token)
    except Exception as exc:
        _logger.warning("infoway on-demand fetch failed for %s %s: %s", sym, tf, exc)
        return []

    if not bars:
        return []

    # Snap provider times to the timeframe grid — InfoWay sometimes serves a
    # range on an OFFSET grid (e.g. 1h bars at :30), which would double every
    # candle when merged with the aligned series (verified live 2026-07-13).
    tf_sec = {"1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400}.get(tf, 300)
    by_slot: dict[int, dict] = {}
    slot_aligned: set = set()
    for b in sorted(bars, key=lambda x: int(x["time"])):
        t = int(b["time"])
        slot = (t // tf_sec) * tf_sec
        if t == slot:
            by_slot[slot] = b
            slot_aligned.add(slot)
        elif slot not in slot_aligned and slot not in by_slot:
            by_slot[slot] = {**b, "time": slot}
    bars = [by_slot[k] for k in sorted(by_slot)]

    list_key = f"bars:{sym}:{tf}"
    existing_raw = await redis_client.lrange(list_key, 0, 999)
    seen_ts: set = set()
    merged: list[dict] = []
    for raw in existing_raw:
        try:
            b = _json.loads(raw)
            t = int(b.get("time", 0))
            if t in seen_ts:
                continue
            seen_ts.add(t)
            merged.append({
                "time": t,
                "open": float(b["open"]),
                "high": float(b["high"]),
                "low": float(b["low"]),
                "close": float(b["close"]),
                "volume": float(b.get("volume", 0.0)),
                "tick_count": int(b.get("tick_count") or 0),
            })
        except Exception:
            continue
    for b in bars:
        if b["time"] in seen_ts:
            continue
        seen_ts.add(b["time"])
        merged.append(b)
    merged.sort(key=lambda x: x["time"])

    try:
        pipe = redis_client.pipeline()
        pipe.delete(list_key)
        for b in merged:
            entry = {**b, "symbol": sym, "timeframe": tf}
            pipe.lpush(list_key, _json.dumps(entry))
        pipe.ltrim(list_key, 0, 999)
        await pipe.execute()
    except Exception as exc:
        _logger.warning("infoway cache writeback failed for %s %s: %s", sym, tf, exc)

    # Persist the fetched bars to the durable OHLC store too (fire-and-forget).
    # Redis is capped at 1000 entries, so without this every deep pan is
    # re-fetched forever and old history evaporates; with it, panning back
    # permanently deepens ohlcv_<tf> (client 2026-07-13 "gaps in all TFs").
    asyncio.create_task(_persist_ohlc_db(sym, tf, bars))

    return merged


async def _persist_ohlc_db(sym: str, tf: str, bars: list[dict]) -> None:
    """Upsert provider bars into ohlcv_<tf> (marketdata DB). Best-effort: the
    table is created by market-data's OHLCStore.init(); if it doesn't exist
    yet the upsert just logs at debug and the chart still works off Redis."""
    if tf not in _OHLC_TABLES or not bars:
        return
    from packages.common.src.database import TimescaleSessionLocal
    stmt = text(
        f"INSERT INTO ohlcv_{tf} (time, symbol, open, high, low, close, volume, tick_count) "
        "VALUES (to_timestamp(:t), :sym, :o, :h, :l, :c, :v, 0) "
        "ON CONFLICT (symbol, time) DO UPDATE SET "
        "open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low, "
        "close=EXCLUDED.close, volume=EXCLUDED.volume"
    )
    try:
        async with TimescaleSessionLocal() as session:
            for b in bars:
                await session.execute(stmt, {
                    "t": int(b["time"]), "sym": sym,
                    "o": float(b["open"]), "h": float(b["high"]),
                    "l": float(b["low"]), "c": float(b["close"]),
                    "v": float(b.get("volume", 0) or 0),
                })
            await session.commit()
    except Exception as exc:
        _logger.debug("ohlcv persist failed for %s %s: %s", sym, tf, exc)


@router.get("/{symbol}/my-spread")
async def get_my_spread(
    symbol: str,
    account_id: str | None = Query(default=None),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """The signed-in user's EFFECTIVE spread for a symbol: their per-scope base
    (resolve_spread_config: user / account-type / instrument / segment / default)
    × the live volatility multiplier. The shared price broadcast can only carry
    the default spread, so the order panel calls this to show the spread the
    user will actually trade at when admin set it per account-type or per user.
    """
    sym = (symbol or "").upper()
    fallback = {
        "symbol": sym, "value": 0.0, "spread_type": "pips",
        "pip_size": 0.0001, "digits": 5, "spread_mult": 1.0, "effective_value": 0.0,
    }
    inst = (await db.execute(
        select(Instrument).where(func.upper(Instrument.symbol) == sym)
    )).scalar_one_or_none()
    if inst is None:
        return fallback

    account_group_id = None
    if account_id:
        try:
            acct = (await db.execute(
                select(TradingAccount).where(
                    TradingAccount.id == UUID(account_id),
                    TradingAccount.user_id == UUID(str(current_user["user_id"])),
                )
            )).scalar_one_or_none()
            if acct:
                account_group_id = acct.account_group_id
        except (ValueError, KeyError, TypeError):
            account_group_id = None

    try:
        sv, st, _pimp = await resolve_spread_config(
            db, inst,
            user_id=UUID(str(current_user["user_id"])),
            account_group_id=account_group_id,
        )
    except Exception:
        sv, st = Decimal("0"), "pips"

    mult = 1.0
    try:
        raw = await redis_client.get(PriceChannel.tick_key(sym))
        if raw:
            mult = float(_json.loads(raw).get("spread_mult", 1.0) or 1.0)
    except Exception:
        mult = 1.0

    base = float(sv or 0)
    return {
        "symbol": sym,
        "value": base,
        "spread_type": st,
        "pip_size": float(inst.pip_size or 0.0001),
        "digits": int(inst.digits or 5),
        "spread_mult": round(mult, 4),
        "effective_value": round(base * mult, 6),
    }


_OHLC_TABLES = {"1m", "5m", "15m", "30m", "1h", "4h", "1d"}


async def _fetch_ohlc_db(sym: str, tf: str, from_time: int, to_time: int) -> list[dict]:
    """Read CLOSED bars from the durable OHLC store (marketdata DB, ohlcv_<tf>).

    This is the deep, restart-proof source written by market-data. Returns [] on
    any error or unknown timeframe, so the caller cleanly falls back to Redis.
    """
    if tf not in _OHLC_TABLES:
        return []
    from packages.common.src.database import TimescaleSessionLocal
    conds = ["symbol = :sym"]
    params: dict = {"sym": sym}
    if from_time:
        conds.append("time >= to_timestamp(:from_t)")
        params["from_t"] = int(from_time)
    if to_time:
        conds.append("time <= to_timestamp(:to_t)")
        params["to_t"] = int(to_time)
    # tf is whitelisted above → safe to interpolate the table name.
    q = text(
        f"SELECT extract(epoch FROM time)::bigint AS t, open, high, low, close, volume "
        f"FROM ohlcv_{tf} WHERE {' AND '.join(conds)} ORDER BY time ASC LIMIT 5000"
    )

    def _row(row) -> dict:
        return {
            "time": int(row.t), "open": float(row.open), "high": float(row.high),
            "low": float(row.low), "close": float(row.close), "volume": float(row.volume or 0),
        }

    out: list[dict] = []
    async with TimescaleSessionLocal() as session:
        res = await session.execute(q, params)
        out = [_row(r) for r in res]
        # Weekend / closed-market fallback: the chart asks for a RECENT window,
        # which is empty when the market is shut (e.g. gold on Saturday). Rather
        # than a blank chart, return the most recent bars up to `to` — the last
        # real (Friday) candles. Only triggers when the strict window is thin
        # (< 20), so normal weekday requests are untouched. (client 2026-07-11)
        if len(out) < 20:
            fb_conds = ["symbol = :sym"]
            fb_params: dict = {"sym": sym}
            if to_time:
                fb_conds.append("time <= to_timestamp(:to_t)")
                fb_params["to_t"] = int(to_time)
            fb_q = text(
                f"SELECT extract(epoch FROM time)::bigint AS t, open, high, low, close, volume "
                f"FROM ohlcv_{tf} WHERE {' AND '.join(fb_conds)} ORDER BY time DESC LIMIT 500"
            )
            fb_res = await session.execute(fb_q, fb_params)
            fb = [_row(r) for r in fb_res]
            fb.reverse()  # newest-first → chronological
            if len(fb) > len(out):
                out = fb
    return out


@router.get("/{symbol}/bars")
@_limiter.exempt
async def get_bars(
    symbol: str,
    resolution: str = Query(default="5"),
    from_time: int = Query(default=0, alias="from"),
    to_time: int = Query(default=0, alias="to"),
):
    """Return OHLCV bars for the TradingView charting library.

    Sources, in priority order:
      1. Real completed bars from Redis (populated by BarAggregator going
         forward, and by `seed_bars` / on-demand AllTick going back).
      2. Binance REST fallback for crypto when Redis is empty or stale.
      3. AllTick REST fallback for non-crypto when Redis is empty or the
         requested `from_time` walks back further than what's cached.
         The fallback writes the result back into Redis so the next request
         is warm.
      4. Current in-progress bar appended from `bar:current:{sym}:{tf}`.

    Returns `{s, bars, noData}`. `noData=true` lets the frontend's synthetic
    fallback kick in for the rare case where every source fails — the result
    is labelled in the UI so traders aren't fooled by simulated history.
    """
    tf = _TV_RESOLUTION_TO_TF.get(resolution, "5m")
    sym = symbol.upper()
    _TF_SECONDS = {"1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400}
    bar_sec = _TF_SECONDS.get(tf, 300)
    is_crypto = sym in _BINANCE_PAIRS

    def _filter_window(b: dict) -> bool:
        # Only enforce the UPPER bound (never return bars after `to`). Do NOT use
        # `from` as a hard floor: TradingView wants the most recent bars ENDING at
        # `to`, and on a closed market (weekend) the latest real bars — e.g.
        # Friday's gold — sit BEFORE the requested `from`. Dropping the floor lets
        # them through instead of a blank chart. (client 2026-07-11)
        t = int(b.get("time", 0))
        if to_time and t > to_time:
            return False
        return True

    # --- 1. Closed bars: durable OHLC store (marketdata DB) FIRST, Redis fallback ---
    # The DB (ohlcv_<tf>, written by market-data on every bar close) is the deep,
    # restart-proof source. Redis is a fast fallback for a cold DB; InfoWay REST
    # (below) still backfills gaps; the live/forming candle is appended in step 4.
    bars: list[dict] = []
    try:
        db_bars = await _fetch_ohlc_db(sym, tf, from_time, to_time)
    except Exception:
        db_bars = []
    if len(db_bars) >= 20:
        bars = db_bars
    else:
        raw_list: list[bytes] = await redis_client.lrange(f"bars:{sym}:{tf}", 0, 999)
        for raw in raw_list:
            try:
                b = _json.loads(raw)
                if not _filter_window(b):
                    continue
                bars.append({
                    "time": int(b.get("time", 0)),
                    "open": float(b["open"]),
                    "high": float(b["high"]),
                    "low": float(b["low"]),
                    "close": float(b["close"]),
                    "volume": float(b.get("volume", 0.0)),
                })
            except Exception:
                continue
        # Sort oldest → newest (TradingView requires ascending order)
        bars.sort(key=lambda x: x["time"])
        # If the DB had some (but <20) bars and more than Redis, prefer the DB.
        if len(db_bars) > len(bars):
            bars = db_bars

    now_epoch = int(_time.time())
    has_recent = bars and (now_epoch - bars[-1]["time"]) < bar_sec * 3

    # --- 2. Binance fallback for crypto: REMOVED (client 2026-06-29) ---
    # Crypto history MUST come from the same feed the platform trades on — the LP
    # feed (Corecen/InfoWay) aggregated by BarAggregator into Redis. Binance
    # returns real-world BTC (~80k) which diverged from our LP's BTC quote
    # (~60k), drawing a ~9,000-point GAP between the chart history and the live
    # bar. AllTick is no better here (its BTCUSDT is also real-world), so crypto
    # now uses Redis only; when Redis is cold the frontend's synthetic fallback
    # (anchored to the live mid) fills in WITHOUT a gap, and BarAggregator
    # backfills real, live-matching bars going forward. The frontend datafeed
    # already dropped Binance on 2026-06-26 — this aligns the backend.
    # (is_crypto is still used below to keep AllTick — also real-world — off crypto.)

    # --- 3. InfoWay REST history backfill (EVERY asset class) when Redis is
    # thin or the user pans before the cache. SAME provider as the live feed, so
    # history and live share one price basis — no boundary seam. Replaces the old
    # AllTick (non-crypto) + Binance (crypto) backfills, which were DIFFERENT
    # price sources and caused the jumps (client 2026-06-30). infoway_rest routes
    # the host + code per market (forex/metals/indices/oil, crypto, stocks).
    # Triggers when Redis returned fewer bars than the window needs, or the user
    # is panning older than what's cached.
    # "Not recent" must only trigger a backfill when the request actually wants
    # the LIVE edge. A HISTORICAL window (TradingView paging back, e.g. April
    # on the 1h chart) is never "recent" by definition — treating that as a
    # cache miss fetched the LATEST 500 bars and REPLACED the DB's perfectly
    # good old bars with them, so the old window came back empty and the chart
    # showed a fake gap/cliff (client 2026-07-14).
    wants_live_edge = not to_time or int(to_time) >= now_epoch - bar_sec * 3
    needs_backfill = (
        (wants_live_edge and not has_recent)
        or len(bars) < 50
        or (from_time and (not bars or from_time < bars[0]["time"]))
    )
    if needs_backfill:
        # Walk back from the oldest bar we already have so we extend rather than
        # refetch what's in cache. end_ts=0 means "latest" (cold-cache case);
        # for a historical window with no bars at all, anchor at the window end.
        if bars and from_time and from_time < bars[0]["time"]:
            end_ts = bars[0]["time"]
        elif wants_live_edge:
            end_ts = 0
        else:
            end_ts = int(to_time)
        merged = await _backfill_infoway_bars(sym, tf, end_ts=end_ts)
        if merged:
            # MERGE with what we already have — the provider fetch covers ~500
            # bars around end_ts and must never clobber DB bars elsewhere in
            # the requested window.
            by_t = {int(b["time"]): b for b in merged if _filter_window(b)}
            for b in bars:
                by_t.setdefault(int(b["time"]), b)
            bars = sorted(by_t.values(), key=lambda x: x["time"])

    # --- 4. Append current in-progress bar ---
    current_raw = await redis_client.get(f"bar:current:{sym}:{tf}")
    if current_raw:
        try:
            b = _json.loads(current_raw)
            bar_start = (now_epoch // bar_sec) * bar_sec
            if (not from_time or bar_start >= from_time) and (not to_time or bar_start <= to_time):
                # Remove any bar at same time to avoid duplicate
                bars = [x for x in bars if x["time"] != bar_start]
                bars.append({
                    "time": bar_start,
                    "open": float(b["open"]),
                    "high": float(b["high"]),
                    "low": float(b["low"]),
                    "close": float(b["close"]),
                    "volume": float(b.get("volume", 0.0)),
                })
        except Exception:
            pass

    # --- 5. Fill only TINY gaps with flat carry-forward bars ---
    # Bridge ONLY 1-2-slot feed micro-pauses so the time axis stays smooth; a
    # genuine gap (the feed actually dropped a stretch) is left REAL rather than
    # painted over with flat synthetic candles, which mislead users and any
    # indicator reading them (client 2026-06-30, was ~1h of fill). Anything
    # larger stays an honest gap until real bars arrive.
    if len(bars) >= 2 and bar_sec > 0:
        bars.sort(key=lambda x: x["time"])
        max_fill = 2  # only micro-pauses; bigger holes stay a real gap
        filled: list[dict] = []
        for i, cur in enumerate(bars):
            if i > 0:
                prev = bars[i - 1]
                missing = int((cur["time"] - prev["time"]) // bar_sec) - 1
                if 0 < missing <= max_fill:
                    c = prev["close"]
                    for k in range(1, missing + 1):
                        filled.append({
                            "time": prev["time"] + k * bar_sec,
                            "open": c, "high": c, "low": c, "close": c, "volume": 0.0,
                        })
            filled.append(cur)
        bars = filled

    return {"s": "ok", "bars": bars, "noData": len(bars) == 0}
