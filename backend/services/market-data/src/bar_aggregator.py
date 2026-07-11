"""Bar Aggregator — Aggregates ticks into OHLCV bars for multiple timeframes."""
import asyncio
import logging
from datetime import datetime, timezone
from collections import defaultdict

from packages.common.src.redis_client import redis_client

logger = logging.getLogger("market-data.aggregator")

TIMEFRAMES = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "30m": 1800,
    "1h": 3600,
    "4h": 14400,
    "1d": 86400,
}


class BarData:
    __slots__ = ("open", "high", "low", "close", "volume", "tick_count", "timestamp")

    def __init__(self, price: float, timestamp: str):
        self.open = price
        self.high = price
        self.low = price
        self.close = price
        self.volume = 0.0
        self.tick_count = 1
        self.timestamp = timestamp

    def update(self, price: float):
        self.high = max(self.high, price)
        self.low = min(self.low, price)
        self.close = price
        self.tick_count += 1


class BarAggregator:
    def __init__(self):
        self._bars: dict[str, dict[str, BarData]] = defaultdict(dict)
        self._bar_timestamps: dict[str, dict[str, int]] = defaultdict(dict)
        # Optional durable OHLC store (set by MarketDataService). When present,
        # every CLOSED bar is persisted to the marketdata DB (ohlcv_<tf>) so chart
        # history is deep + restart-proof. None → Redis-only (backward compatible).
        self.ohlc_store = None

    def update(self, symbol: str, bid: float, ask: float, timestamp: str):
        mid = (bid + ask) / 2
        now = datetime.fromisoformat(timestamp).replace(tzinfo=timezone.utc)
        epoch = int(now.timestamp())

        for tf_name, tf_seconds in TIMEFRAMES.items():
            bar_start = (epoch // tf_seconds) * tf_seconds
            key = f"{symbol}:{tf_name}"

            current_start = self._bar_timestamps.get(symbol, {}).get(tf_name)

            if current_start != bar_start:
                if current_start is not None and key in self._bars.get(symbol, {}):
                    old_bar = self._bars[symbol].pop(tf_name, None)
                    if old_bar:
                        asyncio.create_task(self._store_bar(symbol, tf_name, old_bar, current_start))

                if symbol not in self._bars:
                    self._bars[symbol] = {}
                self._bars[symbol][tf_name] = BarData(mid, timestamp)

                if symbol not in self._bar_timestamps:
                    self._bar_timestamps[symbol] = {}
                self._bar_timestamps[symbol][tf_name] = bar_start
            else:
                if symbol in self._bars and tf_name in self._bars[symbol]:
                    self._bars[symbol][tf_name].update(mid)

    async def _store_bar(self, symbol: str, timeframe: str, bar: BarData, bar_start: int):
        import json
        bar_data = {
            "symbol": symbol,
            "timeframe": timeframe,
            "time": bar_start,
            "open": bar.open,
            "high": bar.high,
            "low": bar.low,
            "close": bar.close,
            "volume": bar.tick_count,
            "tick_count": bar.tick_count,
        }

        bar_key = f"bar:{symbol}:{timeframe}"
        await redis_client.set(bar_key, json.dumps(bar_data))

        list_key = f"bars:{symbol}:{timeframe}"
        await redis_client.lpush(list_key, json.dumps(bar_data))
        await redis_client.ltrim(list_key, 0, 999)

        # Persist the CLOSED bar to the durable OHLC store (marketdata DB) so chart
        # history survives restarts and isn't capped at 1000 Redis bars. Only
        # closed bars reach _store_bar; the live/forming candle stays in Redis.
        if self.ohlc_store is not None:
            await self.ohlc_store.upsert(
                symbol, timeframe, bar_start,
                bar.open, bar.high, bar.low, bar.close,
                volume=bar.tick_count, tick_count=bar.tick_count,
            )

        # ATR(14) — used by trade insurance pricing. Computed only on 1m bars
        # because that's the timeframe insurance quotes care about.
        if timeframe == "1m":
            await self._update_atr14(symbol)

    async def _update_atr14(self, symbol: str):
        """Compute the 14-period True-Range average from the most recent 1m
        bars and cache at `atr:<SYMBOL>:14` with a 5-minute TTL."""
        import json
        try:
            raw = await redis_client.lrange(f"bars:{symbol}:1m", 0, 14)
            if len(raw) < 15:
                return  # need 14 TR values → 15 bars
            bars = [json.loads(b) for b in raw]
            # bars[0] is newest. We need TR for bars[0..13] using bars[i+1] as prev.
            tr_total = 0.0
            for i in range(14):
                cur = bars[i]
                prev_close = bars[i + 1]["close"]
                tr = max(
                    cur["high"] - cur["low"],
                    abs(cur["high"] - prev_close),
                    abs(cur["low"] - prev_close),
                )
                tr_total += tr
            atr = tr_total / 14
            await redis_client.set(f"atr:{symbol.upper()}:14", f"{atr:.8f}", ex=300)
        except Exception as exc:
            logger.debug("ATR update failed for %s: %s", symbol, exc)

    async def run_aggregation_loop(self):
        """Periodically publish current bar state + roll stale bars forward.

        Rollover used to be tick-driven only — a bar was closed when the
        next tick arrived in a later window. During a feed pause (AllTick
        hiccup, weekend, low-liquidity period) the bar would sit open
        indefinitely; when ticks finally resumed in a much later window
        the aggregator would close the stale bar and immediately open a
        new one many windows ahead, leaving a visible 'flat line then
        jump' artifact on the chart.

        This loop now also detects stale bars (now beyond bar_start +
        tf_seconds) and rolls them over with a synthetic doji at the
        gap window, OHLC = previous close. Result: every window emits
        exactly one bar, the chart timeline stays continuous, and a
        live tick that arrives later just updates the current window's
        already-open bar.
        """
        import json
        while True:
            now_epoch = int(datetime.now(timezone.utc).timestamp())
            for symbol, timeframes in list(self._bars.items()):
                for tf_name, bar in list(timeframes.items()):
                    tf_seconds = TIMEFRAMES.get(tf_name, 60)
                    bar_start = self._bar_timestamps.get(symbol, {}).get(tf_name)
                    # If wall-clock has moved past this bar's window, close
                    # it and start fresh windows up to the current one.
                    if bar_start is not None and now_epoch >= bar_start + tf_seconds:
                        # Persist the bar that just ended.
                        old_bar = self._bars[symbol].pop(tf_name, None)
                        if old_bar is not None:
                            asyncio.create_task(
                                self._store_bar(symbol, tf_name, old_bar, bar_start)
                            )
                        last_close = bar.close
                        # Fill only TINY micro-pauses (≤2 missed windows) with a
                        # doji so the time axis stays smooth, but leave genuine
                        # gaps REAL — painting many flat synthetic bars during a
                        # real outage misleads users and any indicator that reads
                        # them (client 2026-06-30, was 10). Anything beyond 2
                        # windows shows as an honest gap until the next tick.
                        cur_start = bar_start + tf_seconds
                        filled = 0
                        ts_iso = datetime.fromtimestamp(cur_start, tz=timezone.utc).isoformat()
                        while cur_start + tf_seconds <= now_epoch and filled < 2:
                            doji = BarData(last_close, ts_iso)
                            doji.tick_count = 0  # mark as filler
                            await self._store_bar(symbol, tf_name, doji, cur_start)
                            cur_start += tf_seconds
                            ts_iso = datetime.fromtimestamp(cur_start, tz=timezone.utc).isoformat()
                            filled += 1
                        # Open the current window's bar so live ticks
                        # update it normally.
                        new_bar = BarData(last_close, ts_iso)
                        new_bar.tick_count = 0
                        self._bars[symbol][tf_name] = new_bar
                        self._bar_timestamps[symbol][tf_name] = cur_start
                        bar = new_bar  # republish snapshot below

                    bar_data = {
                        "symbol": symbol,
                        "timeframe": tf_name,
                        "open": bar.open,
                        "high": bar.high,
                        "low": bar.low,
                        "close": bar.close,
                        "volume": bar.tick_count,
                        "tick_count": bar.tick_count,
                    }
                    bar_key = f"bar:current:{symbol}:{tf_name}"
                    await redis_client.set(bar_key, json.dumps(bar_data))

            await asyncio.sleep(1)
