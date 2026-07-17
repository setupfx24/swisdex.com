"""Deep-history backfill — page InfoWay REST klines back in time for every
symbol × timeframe and persist them DURABLY, so charts have complete history
on all TFs instead of the ~500-bar seed depth (client 2026-07-13: "sab
timeframes me gap aa rahe hain, historical data upload kar do").

What it does per (symbol, timeframe):
  1. Pages `batch_kline` backward (500 bars/call via the `timestamp` cursor)
     until the per-TF target depth is reached or the provider runs dry.
  2. Writes the whole span to the durable OHLC store (marketdata DB,
     `ohlcv_<tf>`), by default REPLACING the covered window first so stale
     junk rows (old simulated/flat bars) inside it are purged.
  3. Merges the newest bars into the Redis `bars:{sym}:{tf}` list (official
     bars win on collision; live bars newer than the fetch survive).
  4. Detects gaps, excuses closed-market spans (Fri 21:00 → Sun 22:00 UTC;
     crypto is 24/7 so nothing is excused), re-fetches across unexpected
     ones, and prints a residual-gap report. Residual gaps mean InfoWay has
     no data there (e.g. an index's daily session break) — they are honest.

Idempotent and resumable: upserts by (symbol, time); re-running is safe.

Usage (inside the market-data container on the server):
    docker compose exec market-data python -m services.market_data.src.backfill_history
    # scope / tune:
    #   --symbols XAUUSD,EURUSD    only these symbols
    #   --timeframes 1h,4h,1d      only these TFs
    #   --spacing 0.6              seconds between REST calls (paid plan 600/min)
    #   --depth 1m=10,1h=730       override per-TF depth (days)
    #   --dry-run                  fetch + report only, write nothing
    #   --no-replace               upsert without purging the covered window
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import time
from datetime import datetime, timezone

from sqlalchemy import text

from packages.common.src.config import get_settings
from packages.common.src.database import TimescaleSessionLocal
from packages.common.src.infoway_rest import fetch_klines
from packages.common.src.redis_client import redis_client

from .feed_handler import INSTRUMENTS
from .store import OHLCStore

logger = logging.getLogger("backfill-history")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-5s %(message)s")

TF_SECONDS = {
    "1m": 60, "5m": 300, "15m": 900, "30m": 1800,
    "1h": 3600, "4h": 14400, "1d": 86400,
}

# Target depth per timeframe, in DAYS. Verified against InfoWay 2026-07-13:
# klineType pagination works and 1d reaches back past 2022. Budget at these
# defaults ≈ 200 REST calls/symbol → ~28 symbols × 0.6s spacing ≈ 1h run.
DEFAULT_DEPTH_DAYS = {
    "1m": 10, "5m": 60, "15m": 180, "30m": 365,
    "1h": 730, "4h": 1825, "1d": 3650,
}

_CRYPTO = {"BTCUSD", "ETHUSD", "LTCUSD", "XRPUSD", "SOLUSD", "ADAUSD", "BNBUSD", "DOGEUSD"}

MAX_PAGES_PER_TF = 200        # hard safety cap on pagination
MAX_REPAIR_PAGES_PER_GAP = 5  # extra fetches to fill one unexpected gap


def _fmt(t: int) -> str:
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d %H:%M")


def _closed_market(t: int, crypto: bool) -> bool:
    """True when the weekly FX/metals/indices close covers this bar-start
    (Fri 21:00 → Sun 22:00 UTC). Crypto never closes."""
    if crypto:
        return False
    dt = datetime.fromtimestamp(t, timezone.utc)
    wd = dt.weekday()  # Mon=0 … Sun=6
    return (wd == 4 and dt.hour >= 21) or wd == 5 or (wd == 6 and dt.hour < 22)


def _find_gaps(times: list[int], tf_sec: int, crypto: bool) -> list[tuple[int, int]]:
    """Consecutive-bar gaps whose missing span is NOT fully closed-market.
    Returns [(last_bar_before, first_bar_after), ...]."""
    gaps: list[tuple[int, int]] = []
    for a, b in zip(times, times[1:]):
        if b - a <= tf_sec:
            continue
        missing = range(a + tf_sec, b, tf_sec)
        if all(_closed_market(t, crypto) for t in missing):
            continue
        gaps.append((a, b))
    return gaps


async def _page_history(
    sym: str, tf: str, target_from: int, token: str, spacing: float,
) -> dict[int, dict]:
    """Page backward from 'latest' until target_from is covered or the
    provider runs dry. Returns {bar_time: bar}."""
    out: dict[int, dict] = {}
    end_ts = 0
    for _page in range(MAX_PAGES_PER_TF):
        batch = await fetch_klines(sym, tf, count=500, end_ts=end_ts, token=token)
        await asyncio.sleep(spacing)
        if not batch:
            break
        fresh = 0
        for b in batch:
            t = int(b["time"])
            if t not in out:
                out[t] = b
                fresh += 1
        oldest = min(int(b["time"]) for b in batch)
        if fresh == 0 or oldest <= target_from:
            break
        end_ts = oldest - 1
    return out


async def _repair_gaps(
    sym: str, tf: str, bars: dict[int, dict], token: str, spacing: float, crypto: bool,
) -> None:
    """Targeted re-fetches across unexpected gaps; mutates `bars` in place.

    A batch that yields ZERO fresh bars proves the provider has nothing new in
    its whole [oldest, newest] span — remember those spans and skip gaps that
    sit inside one, so recurring session breaks (e.g. gold 21:00–22:00 daily)
    don't each burn a REST call."""
    tf_sec = TF_SECONDS[tf]
    gaps = _find_gaps(sorted(bars), tf_sec, crypto)
    barren: list[tuple[int, int]] = []  # spans proven to hold nothing new
    for a, b in gaps:
        if any(lo <= a and b <= hi for lo, hi in barren):
            continue
        end_ts = b - 1
        for _ in range(MAX_REPAIR_PAGES_PER_GAP):
            batch = await fetch_klines(sym, tf, count=500, end_ts=end_ts, token=token)
            await asyncio.sleep(spacing)
            if not batch:
                break
            fresh = 0
            for nb in batch:
                t = int(nb["time"])
                if t not in bars:
                    bars[t] = nb
                    fresh += 1
            oldest = min(int(nb["time"]) for nb in batch)
            newest = max(int(nb["time"]) for nb in batch)
            if fresh == 0:
                barren.append((oldest, newest))
                break
            if oldest <= a:
                break
            end_ts = oldest - 1


def _normalize_grid(bars_map: dict[int, dict], tf_sec: int) -> dict[int, dict]:
    """Snap bar times to the timeframe grid. InfoWay sometimes serves the same
    history range on an OFFSET grid (verified live: AUDUSD 1h came back at :30
    for ~9.5k bars alongside the :00 series) — stored raw, that doubles every
    candle. One bar per slot: a grid-aligned original always wins; an off-grid
    bar is snapped into its slot only when nothing aligned exists there."""
    out: dict[int, dict] = {}
    aligned: set[int] = set()
    for t in sorted(bars_map):
        b = bars_map[t]
        slot = (t // tf_sec) * tf_sec
        if t == slot:
            out[slot] = b
            aligned.add(slot)
        elif slot not in aligned and slot not in out:
            out[slot] = {**b, "time": slot}
    return out


async def _write_db(
    sym: str, tf: str, bars: list[dict], replace: bool,
) -> None:
    """Replace-window delete (optional) + chunked upsert, one transaction."""
    if not bars:
        return
    lo, hi = bars[0]["time"], bars[-1]["time"]
    upsert = text(
        f"INSERT INTO ohlcv_{tf} (time, symbol, open, high, low, close, volume, tick_count) "
        "VALUES (to_timestamp(:t), :sym, :o, :h, :l, :c, :v, 0) "
        "ON CONFLICT (symbol, time) DO UPDATE SET "
        "open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low, "
        "close=EXCLUDED.close, volume=EXCLUDED.volume"
    )
    async with TimescaleSessionLocal() as session:
        if replace:
            await session.execute(
                text(
                    f"DELETE FROM ohlcv_{tf} WHERE symbol = :sym "
                    "AND time >= to_timestamp(:lo) AND time <= to_timestamp(:hi)"
                ),
                {"sym": sym, "lo": lo, "hi": hi},
            )
        for b in bars:
            await session.execute(upsert, {
                "t": int(b["time"]), "sym": sym,
                "o": float(b["open"]), "h": float(b["high"]),
                "l": float(b["low"]), "c": float(b["close"]),
                "v": float(b.get("volume", 0) or 0),
            })
        await session.commit()


async def _refresh_redis(sym: str, tf: str, official: list[dict]) -> None:
    """Overlay official bars onto the Redis list (official wins on collision;
    live bars newer than the fetch survive). Same conventions as the
    aggregator: newest at index 0, capped at 1000. Off-grid existing entries
    are dropped — the aggregator only ever writes grid-aligned bars, so any
    off-grid time is provider pollution from an earlier unnormalized run."""
    tf_sec = TF_SECONDS[tf]
    list_key = f"bars:{sym}:{tf}"
    by_time: dict[int, dict] = {}
    for raw in await redis_client.lrange(list_key, 0, 999):
        try:
            b = json.loads(raw)
            t = int(b["time"])
            if t % tf_sec != 0:
                continue
            by_time[t] = b
        except (json.JSONDecodeError, KeyError, TypeError, ValueError):
            continue
    for b in official:
        t = int(b["time"])
        by_time[t] = {
            "symbol": sym, "timeframe": tf, "time": t,
            "open": b["open"], "high": b["high"], "low": b["low"],
            "close": b["close"], "volume": b.get("volume", 0),
        }
    merged = sorted(by_time.values(), key=lambda x: int(x["time"]))[-1000:]
    pipe = redis_client.pipeline()
    pipe.delete(list_key)
    for b in merged:  # oldest→newest lpush lands newest at index 0
        pipe.lpush(list_key, json.dumps(b))
    pipe.ltrim(list_key, 0, 999)
    await pipe.execute()


async def backfill(
    symbols: list[str],
    timeframes: list[str],
    depth_days: dict[str, int],
    spacing: float,
    replace: bool,
    dry_run: bool,
) -> None:
    token = (getattr(get_settings(), "INFOWAY_TOKEN", "") or "").strip()
    if not token:
        logger.error("INFOWAY_TOKEN not configured — nothing to fetch.")
        return

    store = OHLCStore()
    if not dry_run:
        await store.init()   # idempotent DDL — makes sure ohlcv_<tf> tables exist

    now = int(time.time())
    residual_report: list[str] = []

    for sym in symbols:
        crypto = sym in _CRYPTO
        for tf in timeframes:
            tf_sec = TF_SECONDS[tf]
            target_from = now - depth_days[tf] * 86400
            bars_map = await _page_history(sym, tf, target_from, token, spacing)
            if not bars_map:
                logger.warning("%s %s: provider returned nothing — skipped", sym, tf)
                continue

            await _repair_gaps(sym, tf, bars_map, token, spacing, crypto)
            bars_map = _normalize_grid(bars_map, tf_sec)

            # Closed bars only — the forming candle belongs to the aggregator.
            cutoff = (now // tf_sec) * tf_sec
            bars = sorted(
                (b for t, b in bars_map.items() if target_from <= t < cutoff),
                key=lambda b: int(b["time"]),
            )
            if not bars:
                logger.warning("%s %s: nothing inside the target window — skipped", sym, tf)
                continue

            residual = _find_gaps([int(b["time"]) for b in bars], tf_sec, crypto)
            logger.info(
                "%s %s: %d bars %s → %s%s",
                sym, tf, len(bars), _fmt(bars[0]["time"]), _fmt(bars[-1]["time"]),
                f" — {len(residual)} residual gap(s)" if residual else "",
            )
            for a, b in residual[:5]:
                residual_report.append(
                    f"{sym} {tf}: {_fmt(a)} → {_fmt(b)} "
                    f"({(b - a) // tf_sec - 1} bars missing at provider)"
                )

            if dry_run:
                continue
            await _write_db(sym, tf, bars, replace)
            await _refresh_redis(sym, tf, bars)

    if residual_report:
        logger.info(
            "Residual gaps (InfoWay has no klines there — session breaks/outages):\n  %s",
            "\n  ".join(residual_report),
        )
    logger.info("Backfill %s.", "dry-run complete" if dry_run else "complete")


def _parse_depth(arg: str) -> dict[str, int]:
    depth = dict(DEFAULT_DEPTH_DAYS)
    if arg:
        for part in arg.split(","):
            tf, _, days = part.partition("=")
            tf = tf.strip()
            if tf in depth and days.strip().isdigit():
                depth[tf] = int(days.strip())
    return depth


async def _cli_main() -> None:
    p = argparse.ArgumentParser(description="Deep InfoWay history backfill (durable OHLC store + Redis).")
    p.add_argument("--symbols", default="", help="Comma list; default = all feed instruments.")
    p.add_argument("--timeframes", default="", help="Comma list; default = all (1m..1d).")
    p.add_argument("--spacing", type=float, default=0.6, help="Seconds between REST calls (paid plan 600/min).")
    p.add_argument("--depth", default="", help="Per-TF depth override in days, e.g. '1m=10,1h=730'.")
    p.add_argument("--dry-run", action="store_true", help="Fetch + report only, write nothing.")
    p.add_argument("--no-replace", action="store_true", help="Upsert without purging the covered window first.")
    args = p.parse_args()

    symbols = (
        [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
        if args.symbols else sorted(INSTRUMENTS.keys())
    )
    timeframes = (
        [t.strip() for t in args.timeframes.split(",") if t.strip() in TF_SECONDS]
        if args.timeframes else list(TF_SECONDS.keys())
    )
    await backfill(
        symbols, timeframes, _parse_depth(args.depth),
        spacing=max(args.spacing, 0.1),
        replace=not args.no_replace,
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    asyncio.run(_cli_main())
