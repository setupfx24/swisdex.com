import os

import redis.asyncio as aioredis
from .config import get_settings

settings = get_settings()

# Each streaming WebSocket handler (/ws/prices, /ws/bars, /ws/trades, /ws/admin)
# holds one pooled connection for its whole lifetime, and the SAME pool also
# serves every transient REST/pubsub op. A non-blocking pool raises
# "Too many connections" on the (max+1)th checkout — it does NOT queue — so a
# 50-cap put a hard ceiling of ~50 concurrent streaming clients per worker.
# Default raised to 500 and made env-tunable so prod can size it to load
# without a code change.
_REDIS_MAX_CONNECTIONS = int(os.getenv("REDIS_MAX_CONNECTIONS", "500"))

redis_pool = aioredis.ConnectionPool.from_url(
    settings.REDIS_URL,
    max_connections=_REDIS_MAX_CONNECTIONS,
    decode_responses=True,
)

redis_client = aioredis.Redis(connection_pool=redis_pool)


class PriceChannel:
    TICK_PREFIX = "tick:"
    PRICE_CHANNEL = "prices"
    ORDERBOOK_CHANNEL = "orderbook"

    @staticmethod
    def tick_key(symbol: str) -> str:
        return f"{PriceChannel.TICK_PREFIX}{symbol}"

    @staticmethod
    def price_channel(symbol: str) -> str:
        return f"{PriceChannel.PRICE_CHANNEL}:{symbol}"


async def get_redis():
    return redis_client


async def throttle(bucket: str, identity: str, max_hits: int, window_sec: int) -> bool:
    """Fixed-window rate limiter. Returns True if the call is ALLOWED,
    False if `identity` has exceeded `max_hits` in the last
    `window_sec` for `bucket`. Used to throttle admin login brute-force
    (audit C4). Fail-OPEN on Redis error (don't lock admins out if
    Redis hiccups) — the window is short so the exposure is bounded.
    """
    try:
        key = f"throttle:{bucket}:{identity}"
        n = await redis_client.incr(key)
        if n == 1:
            await redis_client.expire(key, window_sec)
        return int(n) <= max_hits
    except Exception:
        return True


async def acquire_leader_lock(key: str, ttl_seconds: int) -> bool:
    """Best-effort cluster leader lock (Redis SET NX EX).

    Returns True if THIS process acquired the lock for the next
    `ttl_seconds`, False otherwise. Used by the background engines so
    that under `uvicorn --workers N` only one worker runs each engine's
    tick — without this every worker duplicates the work (double
    overnight fees, double SL/TP closes, etc. — audit findings C1/C3).

    The TTL auto-expires the lock so a crashed leader doesn't wedge the
    engine: the next tick from any worker re-acquires it. Pick a TTL
    comfortably larger than the engine's tick interval.

    Never raises — on a Redis hiccup it returns True (fail-open) so the
    engine keeps running on a single-worker deployment rather than
    silently halting. Duplicate-execution risk only exists with N>1
    workers, where Redis is up anyway.
    """
    try:
        return bool(await redis_client.set(key, "1", ex=ttl_seconds, nx=True))
    except Exception:
        return True


async def publish_price(
    symbol: str, bid: float, ask: float, timestamp: str, spread_mult: float = 1.0
):
    import json
    data = json.dumps({
        "symbol": symbol,
        "bid": bid,
        "ask": ask,
        "timestamp": timestamp,
        "spread": round(ask - bid, 8),
        # Live volatility multiplier already applied to the broadcast bid/ask.
        # Rides in the tick so per-user execution (which re-widens from mid with
        # the user's own base spread) can apply the SAME market widening and
        # stay consistent with the displayed quote. 1.0 = no widening.
        "spread_mult": round(spread_mult, 4),
    })
    # TTL on tick keys (audit C4/C6 + C1-infra): a dead feed must NOT
    # leave a stale price in Redis forever — consumers (risk engine,
    # SL/TP, margin) would act on a frozen price. With a 120s TTL the
    # key disappears if the feed stops, and the staleness-aware
    # consumers treat "no tick" as "don't liquidate". The market-data
    # stale-quote refresher republishes every 30s while a symbol is
    # live, so a healthy feed keeps the key alive comfortably.
    await redis_client.set(PriceChannel.tick_key(symbol), data, ex=120)
    await redis_client.publish(PriceChannel.price_channel(symbol), data)
    await redis_client.publish(PriceChannel.PRICE_CHANNEL, data)


CONFIG_INSTRUMENTS_RELOAD_CHANNEL = "config:instruments:reload"


async def publish_instrument_config_reload() -> None:
    """Notify services that instrument charge/spread config changed (optional cache bust)."""
    await redis_client.publish(CONFIG_INSTRUMENTS_RELOAD_CHANNEL, "1")


# ─── Bar-update fan-out channel ──────────────────────────────────────────────
# Market-data publishes the current in-progress OHLC bar for each (symbol,
# timeframe) tuple to this single channel after every tick the aggregator
# absorbs. The gateway's /ws/bars handler subscribes once and filters
# per-client based on which (symbol, resolution) the chart is subscribed to.
# Wire shape (JSON-encoded string):
#   { "symbol": "XAUUSD", "timeframe": "5m",
#     "time": 1731000000, "open": ..., "high": ...,
#     "low": ..., "close": ..., "volume": ... }
# `timeframe` matches the BarAggregator key set ("1m" / "5m" / "15m" /
# "30m" / "1h" / "4h" / "1d"). The gateway maps these to TradingView
# resolution strings ("1" / "5" / "15" / "30" / "60" / "240" / "1D").
BAR_UPDATES_CHANNEL = "bars:updates"


async def publish_bar_update(payload: dict) -> None:
    """Fan out a current-bar snapshot. Caller serialises floats; we just dump."""
    import json
    await redis_client.publish(BAR_UPDATES_CHANNEL, json.dumps(payload))
