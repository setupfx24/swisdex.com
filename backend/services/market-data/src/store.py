"""Tick Store — Writes tick data to TimescaleDB."""
import logging
from datetime import datetime, timezone

from sqlalchemy import text
from packages.common.src.database import TimescaleSessionLocal

logger = logging.getLogger("market-data.store")


def _parse_tick_time(ts: str) -> datetime:
    """AllTick / feed timestamps are ISO strings; asyncpg needs datetime."""
    t = (ts or "").strip()
    if not t:
        return datetime.now(timezone.utc)
    if t.endswith("Z"):
        t = t[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(t)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return datetime.now(timezone.utc)


class TickStore:
    def __init__(self):
        self._batch: list[tuple] = []
        self._batch_size = 100
        self._initialized = False

    async def init(self):
        self._initialized = True
        logger.info("Tick store initialized")

    async def insert_tick(self, symbol: str, bid: float, ask: float, timestamp: str):
        self._batch.append((_parse_tick_time(timestamp), symbol, bid, ask))

        if len(self._batch) >= self._batch_size:
            await self._flush()

    async def _flush(self):
        if not self._batch:
            return

        batch = self._batch[:]
        self._batch.clear()

        try:
            async with TimescaleSessionLocal() as session:
                for ts, symbol, bid, ask in batch:
                    await session.execute(
                        text(
                            "INSERT INTO ticks (time, symbol, bid, ask) "
                            "VALUES (:time, :symbol, :bid, :ask)"
                        ),
                        {"time": ts, "symbol": symbol, "bid": bid, "ask": ask},
                    )
                await session.commit()
        except Exception as e:
            logger.error(f"Failed to flush ticks: {e}")


# Timeframes we persist as candles (matches BarAggregator + the frontend datafeed).
OHLC_TIMEFRAMES = ("1m", "5m", "15m", "30m", "1h", "4h", "1d")


class OHLCStore:
    """Persist CLOSED OHLC bars to the marketdata DB (one ``ohlcv_<tf>`` table per
    timeframe) so chart history is durable and deep — instead of living only in
    Redis (1000-bar cap, wiped on restart).

    Self-heals the schema on ``init()`` with idempotent DDL, so it works on:
      • plain Postgres locally (creates the tables), and
      • the existing TimescaleDB hypertables in prod (tables already exist; we
        just add the UNIQUE(symbol, time) index the upsert needs — valid on a
        hypertable because it includes the ``time`` partition key).

    Only CLOSED bars are written here; the live/forming candle stays real-time in
    Redis + /ws/bars.
    """

    def __init__(self) -> None:
        self._ready = False

    async def init(self) -> None:
        try:
            async with TimescaleSessionLocal() as session:
                for tf in OHLC_TIMEFRAMES:
                    await session.execute(text(
                        f"CREATE TABLE IF NOT EXISTS ohlcv_{tf} ("
                        "  time TIMESTAMPTZ NOT NULL, symbol VARCHAR(20) NOT NULL,"
                        "  open DOUBLE PRECISION NOT NULL, high DOUBLE PRECISION NOT NULL,"
                        "  low DOUBLE PRECISION NOT NULL, close DOUBLE PRECISION NOT NULL,"
                        "  volume DOUBLE PRECISION DEFAULT 0, tick_count INTEGER DEFAULT 0)"
                    ))
                    await session.execute(text(
                        f"CREATE UNIQUE INDEX IF NOT EXISTS ux_ohlcv_{tf}_sym_time "
                        f"ON ohlcv_{tf} (symbol, time)"
                    ))
                await session.commit()
            self._ready = True
            logger.info("OHLC store initialized (%d timeframes)", len(OHLC_TIMEFRAMES))
        except Exception as e:
            # Non-fatal: if the DB is unreachable the chart still works off Redis.
            logger.error(f"OHLC store init failed (chart falls back to Redis): {e}")

    _UPSERT = (
        "INSERT INTO {table} (time, symbol, open, high, low, close, volume, tick_count) "
        "VALUES (to_timestamp(:t), :sym, :o, :h, :l, :c, :v, :tc) "
        "ON CONFLICT (symbol, time) DO UPDATE SET "
        "open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low, "
        "close=EXCLUDED.close, volume=EXCLUDED.volume, tick_count=EXCLUDED.tick_count"
    )

    async def upsert(self, symbol: str, tf: str, bar_start: int,
                     o: float, h: float, l: float, c: float,
                     volume: float = 0.0, tick_count: int = 0) -> None:
        """Persist a single CLOSED bar (idempotent — re-closing the same window updates it)."""
        if not self._ready or tf not in OHLC_TIMEFRAMES:
            return
        try:
            async with TimescaleSessionLocal() as session:
                await session.execute(
                    text(self._UPSERT.format(table=f"ohlcv_{tf}")),
                    {"t": int(bar_start), "sym": symbol, "o": float(o), "h": float(h),
                     "l": float(l), "c": float(c), "v": float(volume), "tc": int(tick_count)},
                )
                await session.commit()
        except Exception as exc:
            logger.debug("OHLC upsert %s %s failed: %s", symbol, tf, exc)

    async def upsert_many(self, symbol: str, tf: str, bars: list[dict]) -> None:
        """Bulk upsert for history backfill (seed). Each bar: {time(epoch s),
        open, high, low, close, volume, tick_count}."""
        if not self._ready or tf not in OHLC_TIMEFRAMES or not bars:
            return
        try:
            stmt = text(self._UPSERT.format(table=f"ohlcv_{tf}"))
            async with TimescaleSessionLocal() as session:
                for b in bars:
                    await session.execute(stmt, {
                        "t": int(b.get("time", 0)), "sym": symbol,
                        "o": float(b["open"]), "h": float(b["high"]),
                        "l": float(b["low"]), "c": float(b["close"]),
                        "v": float(b.get("volume", 0) or 0),
                        "tc": int(b.get("tick_count", 0) or 0),
                    })
                await session.commit()
        except Exception as exc:
            logger.debug("OHLC bulk upsert %s %s failed: %s", symbol, tf, exc)
