"""Market Data Service — Connects to price feeds, normalizes, distributes via Redis pub/sub and stores in TimescaleDB."""
import asyncio
import json
import logging
import signal
import time
from collections import deque
from datetime import datetime, timezone

from packages.common.src.config import get_settings
from packages.common.src.redis_client import (
    CONFIG_INSTRUMENTS_RELOAD_CHANNEL,
    PriceChannel,
    redis_client,
    publish_price,
    publish_bar_update,
)

from .feed_handler import FeedSimulator, INSTRUMENTS
from .alltick_config import usable_alltick_token
from .alltick_feed import AllTickFeed
from .infoway_config import usable_infoway_token
from .infoway_feed import InfoWayFeed
from .corecen_lp_feed import CorecenLPFeed
from .bar_aggregator import BarAggregator
from .seed_bars import seed as seed_bars, flush_non_crypto_keys
from .spread_cache import StreamSpreadCache, RELOAD_INTERVAL_SEC
from .store import TickStore, OHLCStore

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-5s [%(name)s] %(message)s")
logger = logging.getLogger("market-data")

try:
    from packages.common.src.instrumentation import init_sentry
    init_sentry("market-data")
except Exception:
    pass

settings = get_settings()

# If the upstream feed stops sending a symbol, Redis keeps a frozen tick; refresh
# with last mid + current admin spread so Spr matches config until live ticks resume.
STALE_TICK_AFTER_SEC = 90.0
STALE_REFRESH_INTERVAL_SEC = 30.0

# Bad-tick guard: a single tick that moves the mid more than this fraction off
# the last good price is treated as a garbage quote and dropped. Real single
# ticks almost never move >10% even in volatile crypto; bad quotes are usually
# 0, crossed, or off by 50%+. After this many consecutive drops we accept the
# next tick anyway, so a genuine market gap is never frozen out permanently.
MAX_TICK_JUMP_PCT = 0.10
MAX_CONSECUTIVE_BAD_TICKS = 5

# De-spike filter: publish the MEDIAN of the last N raw mids instead of the raw
# value. This removes feed noise — single-tick spikes AND tick-to-tick
# oscillation (e.g. silver bouncing 58.9 <-> 59.3) that whipped the running P&L
# around — while still tracking a genuine trend. Odd window so the median is a
# real sample. 3 = minimal (~1 tick) latency (client 2026-06-25).
MID_MEDIAN_WINDOW = 3


class MarketDataService:
    def __init__(self):
        raw_alltick = (getattr(settings, "ALLTICK_TOKEN", "") or "").strip()
        raw_infoway = (getattr(settings, "INFOWAY_TOKEN", "") or "").strip()
        self._tick_count = 0
        self._alltick_watchdog_armed = False
        self._infoway_watchdog_armed = False
        # When true, the feed object exists but is never started → no prices are
        # published (mock disabled + no real token). Quotes freeze instead.
        self._feed_disabled = False
        # Provider priority: Corecen LP → InfoWay → AllTick → Simulator.
        # Whichever is set first wins; setting INFOWAY_TOKEN takes over
        # from AllTick without needing to clear ALLTICK_TOKEN.
        if getattr(settings, "CORECEN_LP_ENABLED", False):
            if not settings.CORECEN_LP_API_KEY or not settings.CORECEN_LP_API_SECRET:
                logger.error(
                    "CORECEN_LP_ENABLED=true but CORECEN_LP_API_KEY / CORECEN_LP_API_SECRET "
                    "are not set — gateway will reject LP pushes and no ticks will arrive."
                )
            self.feed = CorecenLPFeed()
            logger.info("Price feed: Corecen LP (receiving pushes on /api/lp/prices/batch)")
        elif usable_infoway_token(raw_infoway):
            # Free plan caps WS subscriptions at 10 (error 516 rejects the WHOLE
            # subscription if exceeded → zero ticks). Subscribe to ONLY the
            # configured priority symbols; this also shrinks the feed's reconcile
            # REST load, easing the 60-req/min cap (429s). Crypto is on Binance.
            _ws_syms = [
                s.strip().upper()
                for s in (getattr(settings, "INFOWAY_WS_SYMBOLS", "") or "").split(",")
                if s.strip()
            ]
            _ws_instruments = (
                {k: v for k, v in INSTRUMENTS.items() if k in _ws_syms}
                if _ws_syms else INSTRUMENTS
            )
            self.feed = InfoWayFeed(
                raw_infoway,
                _ws_instruments,
                ws_url=getattr(settings, "INFOWAY_WS_URL", "wss://data.infoway.io/ws"),
                business=getattr(settings, "INFOWAY_BUSINESS", "common"),
                channel=getattr(settings, "INFOWAY_CHANNEL", "depth"),
            )
            self._infoway_watchdog_armed = True
            logger.info(
                "Price feed: InfoWay WebSocket (channel=%s, %d WS symbols: %s)",
                getattr(settings, "INFOWAY_CHANNEL", "depth"),
                len(_ws_instruments), ",".join(sorted(_ws_instruments.keys())) or "ALL",
            )
        elif usable_alltick_token(raw_alltick):
            self.feed = AllTickFeed(raw_alltick, INSTRUMENTS)
            self._alltick_watchdog_armed = True
            logger.info("Price feed: AllTick WebSocket (orderbook depth)")
        elif not getattr(settings, "ALLOW_SIMULATED_FEED", False):
            # Mock disabled (client 2026-06-20) + no usable real token → publish
            # NO prices rather than invented ones. The feed exists but is never
            # started; quotes simply don't update.
            self.feed = FeedSimulator(tick_rate_multiplier=1.0)
            self._feed_disabled = True
            logger.critical(
                "No usable market-data token AND simulated feed is disabled "
                "(ALLOW_SIMULATED_FEED=false) — NO prices will be published. Set a real "
                "INFOWAY_TOKEN/ALLTICK_TOKEN, or ALLOW_SIMULATED_FEED=true for local dev."
            )
        else:
            self.feed = FeedSimulator(tick_rate_multiplier=1.0)
            if raw_alltick or raw_infoway:
                logger.warning(
                    "INFOWAY_TOKEN/ALLTICK_TOKEN unset or placeholder — using simulated feed + Binance crypto"
                )
            else:
                logger.warning(
                    "No market-data token set — using simulated forex/indices + Binance crypto"
                )
        self.aggregator = BarAggregator()
        self.store = TickStore()
        self.ohlc_store = OHLCStore()
        self.spread_cache = StreamSpreadCache()
        self.running = True
        self._last_mid: dict[str, float] = {}
        self._last_live_mono: dict[str, float] = {}
        # Bad-tick guard: count consecutive outlier ticks dropped per symbol so a
        # genuine market gap eventually gets through (see tick processor).
        self._bad_tick_streak: dict[str, int] = {}
        # Rolling window of recent raw mids per symbol for the median de-spike.
        self._mid_window: dict[str, deque] = {}

    async def start(self):
        logger.info("Starting Market Data Service...")

        signal.signal(signal.SIGINT, lambda *_: setattr(self, "running", False))
        signal.signal(signal.SIGTERM, lambda *_: setattr(self, "running", False))

        await self.store.init()
        await self.ohlc_store.init()
        # Every CLOSED bar the aggregator produces is now persisted to the
        # durable OHLC store (ohlcv_<tf>) for deep, restart-proof chart history.
        self.aggregator.ohlc_store = self.ohlc_store

        await self.spread_cache.reload_if_stale(force=True)
        await self._seed_last_mid_from_redis()

        tasks = []
        if not self._feed_disabled:
            tasks.append(asyncio.create_task(self.feed.start()))
        tasks += [
            asyncio.create_task(self._process_ticks()),
            asyncio.create_task(self._spread_reload_loop()),
            asyncio.create_task(self._spread_config_subscriber()),
            asyncio.create_task(self._stale_quote_refresher()),
            asyncio.create_task(self.aggregator.run_aggregation_loop()),
            asyncio.create_task(self._current_bar_heartbeat()),
            asyncio.create_task(self._auto_seed_bars()),
        ]
        if self._alltick_watchdog_armed:
            tasks.append(asyncio.create_task(self._alltick_fallback_watchdog()))
        if self._infoway_watchdog_armed:
            tasks.append(asyncio.create_task(self._infoway_fallback_watchdog()))
        # InfoWay/AllTick don't reliably stream crypto (placeholder symbol
        # mapping) — pull crypto from Binance directly so BTC/ETH prices and
        # P&L actually move. FeedSimulator already runs its own Binance feed.
        if isinstance(self.feed, (InfoWayFeed, AllTickFeed)):
            tasks.append(asyncio.create_task(self._binance_crypto_feed()))
        # Free-plan live-price fallback: poll REST for the latest close and
        # publish synthetic ticks when the WS delivers no live frames. Off by
        # default; a real WS tick auto-suppresses it per-symbol.
        if getattr(settings, "INFOWAY_REST_BRIDGE_ENABLED", False) and isinstance(
            self.feed, (InfoWayFeed, AllTickFeed)
        ):
            tasks.append(asyncio.create_task(self._infoway_rest_bridge()))

        await asyncio.gather(*tasks)

    async def _spread_reload_loop(self):
        while self.running:
            await asyncio.sleep(RELOAD_INTERVAL_SEC)
            if self.running:
                await self.spread_cache.reload_if_stale(force=True)

    async def _spread_config_subscriber(self):
        """Reload spread cache when admin saves spreads (same channel as instrument config)."""
        channel = CONFIG_INSTRUMENTS_RELOAD_CHANNEL
        while self.running:
            pubsub = redis_client.pubsub()
            try:
                await pubsub.subscribe(channel)
                while self.running:
                    msg = await pubsub.get_message(
                        ignore_subscribe_messages=True, timeout=1.0
                    )
                    if msg and msg.get("type") == "message":
                        logger.info("Config reload signal — refreshing spread cache")
                        await self.spread_cache.reload_if_stale(force=True)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("Spread config subscriber error (retrying): %s", exc)
                await asyncio.sleep(2.0)
            finally:
                try:
                    await pubsub.unsubscribe(channel)
                    await pubsub.aclose()
                except Exception:
                    pass

    async def _seed_last_mid_from_redis(self) -> None:
        """Prime last mid from existing tick:* keys so stale-quote refresh can fix spread after restart."""
        try:
            mono = time.monotonic()
            n = 0
            async for key in redis_client.scan_iter(f"{PriceChannel.TICK_PREFIX}*"):
                raw = await redis_client.get(key)
                if not raw:
                    continue
                try:
                    d = json.loads(raw)
                    sym = str(d.get("symbol") or "").strip().upper()
                    if not sym:
                        continue
                    b, a = float(d["bid"]), float(d["ask"])
                except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                    continue
                self._last_mid[sym] = (b + a) / 2.0
                self._last_live_mono[sym] = mono - STALE_TICK_AFTER_SEC - 1.0
                n += 1
            if n:
                logger.info("Seeded last mid from Redis for %d symbols (stale refresh eligible)", n)
        except Exception as exc:
            logger.warning("Seed last_mid from Redis failed: %s", exc)

    async def _stale_quote_refresher(self) -> None:
        while self.running:
            await asyncio.sleep(STALE_REFRESH_INTERVAL_SEC)
            if not self.running:
                break
            await self.spread_cache.reload_if_stale(force=False)
            now = time.monotonic()
            ts_dt = datetime.now(timezone.utc)
            ts = ts_dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{ts_dt.microsecond // 1000:03d}Z"
            for symbol, mid in list(self._last_mid.items()):
                if now - self._last_live_mono.get(symbol, 0) < STALE_TICK_AFTER_SEC:
                    continue
                try:
                    bid, ask = self.spread_cache.widen(symbol, mid)
                    await publish_price(symbol, bid, ask, ts, self.spread_cache.mult_for(symbol))
                except Exception as exc:
                    logger.debug("Stale quote refresh failed for %s: %s", symbol, exc)

    async def _process_ticks(self):
        logger.info("Tick processor started")
        while self.running:
            tick = await self.feed.get_tick()
            if tick is None:
                await asyncio.sleep(0.01)
                continue

            symbol = str(tick["symbol"] or "").strip().upper()
            if not symbol:
                continue
            bid = float(tick["bid"])
            ask = float(tick["ask"])
            ts = tick.get("timestamp", datetime.now(timezone.utc).isoformat())

            mid = (bid + ask) / 2.0

            # ── Bad-tick guard (client 2026-06-24) ───────────────────────────
            # The feed occasionally delivers a garbage quote (zero, crossed, or
            # a price off by a huge margin). Computing P&L on it spikes the
            # trader's running P&L for one frame, then it snaps back — so the
            # number jumps around (e.g. 1 → -55 → 200) instead of moving
            # smoothly. Drop these and freeze on the last good price, like pro
            # terminals. A genuine market gap still gets through after a few
            # consecutive rejects so we never freeze permanently.
            prev_mid = self._last_mid.get(symbol)
            if bid <= 0 or ask <= 0 or bid > ask:
                self._bad_tick_streak[symbol] = self._bad_tick_streak.get(symbol, 0) + 1
                continue
            if prev_mid is not None and prev_mid > 0:
                jump = abs(mid - prev_mid) / prev_mid
                streak = self._bad_tick_streak.get(symbol, 0)
                if jump > MAX_TICK_JUMP_PCT and streak < MAX_CONSECUTIVE_BAD_TICKS:
                    self._bad_tick_streak[symbol] = streak + 1
                    if streak == 0:
                        logger.warning(
                            "Dropped outlier tick %s: mid %.6f vs prev %.6f (%.1f%% jump)",
                            symbol, mid, prev_mid, jump * 100.0,
                        )
                    continue
            self._bad_tick_streak[symbol] = 0

            # De-spike: replace the raw mid with the median of the last few mids
            # so feed noise/oscillation can't whip the P&L around. Tracks real
            # trends; ignores single-tick spikes (client 2026-06-25).
            win = self._mid_window.get(symbol)
            if win is None:
                win = deque(maxlen=MID_MEDIAN_WINDOW)
                self._mid_window[symbol] = win
            win.append(mid)
            if len(win) >= 3:
                mid = sorted(win)[len(win) // 2]

            self._last_mid[symbol] = mid
            self._last_live_mono[symbol] = time.monotonic()
            spread_mult = self.spread_cache.note_mid(symbol, mid)
            bid, ask = self.spread_cache.widen(symbol, mid)

            await publish_price(symbol, bid, ask, ts, spread_mult)

            await self.store.insert_tick(symbol, bid, ask, ts)

            self.aggregator.update(symbol, bid, ask, ts)
            # Fan out the just-updated current bar for every timeframe so the
            # gateway's /ws/bars hub can push it to subscribed charts. This
            # replaces the trader frontend's old client-side bar synthesis,
            # which drifted from the server's authoritative aggregation. We
            # publish AFTER aggregator.update so _bars[symbol] reflects this
            # tick. bar_aggregator.py itself stays untouched — we just read
            # its in-memory snapshot.
            await self._publish_current_bars(symbol)
            self._tick_count += 1

    async def _publish_current_bars(self, symbol: str) -> None:
        """Publish current in-progress bar for every TF of `symbol` to
        BAR_UPDATES_CHANNEL. Called once per tick from _process_ticks."""
        sym_bars = self.aggregator._bars.get(symbol)
        sym_starts = self.aggregator._bar_timestamps.get(symbol)
        if not sym_bars or not sym_starts:
            return
        # Snapshot the items so the aggregator can mutate the underlying
        # dict (new bar period rollover) while we're awaiting publish.
        # Without this, `RuntimeError: dictionary keys changed during
        # iteration` crashes the tick processor on every bar boundary.
        for tf_name, bar in list(sym_bars.items()):
            bar_start = sym_starts.get(tf_name)
            if bar_start is None:
                continue
            try:
                await publish_bar_update({
                    "symbol": symbol,
                    "timeframe": tf_name,
                    "time": int(bar_start),
                    "open": float(bar.open),
                    "high": float(bar.high),
                    "low": float(bar.low),
                    "close": float(bar.close),
                    "volume": float(bar.volume),
                    "tick_count": int(bar.tick_count),
                })
            except Exception as exc:
                # Pub/sub is best-effort — don't break the tick processor
                # if Redis briefly hiccups. The gateway will catch up on
                # the next tick anyway.
                logger.debug("publish_bar_update %s %s failed: %s", symbol, tf_name, exc)

    async def _current_bar_heartbeat(self) -> None:
        """Publish every symbol's current in-progress bar once a second,
        independent of incoming ticks.

        Bar OPEN/CLOSE at a window boundary was previously streamed only from
        _process_ticks (per tick): the 1s aggregation loop rolls the finished
        bar and opens the next one in Redis, but never published that rollover
        to BAR_UPDATES_CHANNEL. So on a quiet symbol (weekend forex, low
        liquidity) the live chart's candle sat open past its window until the
        NEXT tick arrived — the new candle didn't open on time, and any missed
        rollover only showed up on a manual refresh (REST get_bars).

        This heartbeat guarantees a per-second bar_update for every
        (symbol, timeframe) — so the current window's bar is always live and
        the next window's bar opens within ~1s of the boundary even with zero
        ticks. It reuses _publish_current_bars, which reads the aggregator's
        in-memory snapshot AFTER run_aggregation_loop has rolled it forward.
        Redundant with the per-tick publish while ticks flow (same value → the
        client just refreshes the current bar, no visual change), essential
        when they don't.
        """
        while self.running:
            await asyncio.sleep(1)
            if not self.running:
                break
            try:
                for symbol in list(self.aggregator._bars.keys()):
                    await self._publish_current_bars(symbol)
            except Exception as exc:
                logger.debug("current-bar heartbeat failed: %s", exc)

    async def _binance_crypto_feed(self) -> None:
        """Live crypto ticks from Binance, run ALONGSIDE the primary feed.

        InfoWay/AllTick's crypto symbol mapping is a placeholder and does
        not actually stream BTC/ETH/etc., so crypto prices froze and P&L
        never moved (client report: "BTC not working"). Binance's public
        trade stream is free + reliable. This mirrors _process_ticks —
        applies the admin spread via spread_cache.widen and publishes
        through the same path — but deliberately does NOT touch
        self._tick_count, so the primary-feed watchdogs still detect a
        dead forex feed correctly.
        """
        import json as _json
        import websockets as _ws
        from .feed_handler import BINANCE_MAP, BINANCE_WS

        streams = [f"{pair}@trade" for pair in BINANCE_MAP]
        url = f"{BINANCE_WS}/{'/'.join(streams)}"
        # Stop if a watchdog swaps the primary feed to FeedSimulator, which
        # runs its OWN Binance feed — else we'd double-publish crypto.
        while self.running and isinstance(self.feed, (InfoWayFeed, AllTickFeed)):
            try:
                logger.info("Binance crypto feed connecting (alongside primary feed)")
                async with _ws.connect(url, ping_interval=20, ping_timeout=10) as ws:
                    logger.info("Binance crypto feed connected — live crypto prices active")
                    async for raw in ws:
                        if not self.running or not isinstance(self.feed, (InfoWayFeed, AllTickFeed)):
                            break
                        try:
                            data = _json.loads(raw)
                            pair = (data.get("s") or "").lower()
                            symbol = BINANCE_MAP.get(pair)
                            if not symbol:
                                continue
                            price = float(data["p"])
                        except (KeyError, ValueError, TypeError):
                            continue
                        ts = datetime.now(timezone.utc)
                        timestamp = ts.strftime("%Y-%m-%dT%H:%M:%S.") + f"{ts.microsecond // 1000:03d}Z"
                        mid = price
                        self._last_mid[symbol] = mid
                        self._last_live_mono[symbol] = time.monotonic()
                        spread_mult = self.spread_cache.note_mid(symbol, mid)
                        bid, ask = self.spread_cache.widen(symbol, mid)
                        await publish_price(symbol, bid, ask, timestamp, spread_mult)
                        await self.store.insert_tick(symbol, bid, ask, timestamp)
                        self.aggregator.update(symbol, bid, ask, timestamp)
                        await self._publish_current_bars(symbol)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning("Binance crypto feed error: %s — reconnecting in 5s", e)
                await asyncio.sleep(5)

    async def _infoway_rest_bridge(self) -> None:
        """FREE-plan fallback (client 2026-07-09). The InfoWay WS subscribes OK
        but pushes NO live frames on the current plan, so bid/ask + the forming
        candle freeze while REST batch_kline keeps working. This polls the
        WORKING REST for each forex/metals/indices symbol's LATEST close (~2s)
        and publishes it as a synthetic tick through the SAME path a real tick
        takes (note_mid → widen → publish_price → insert_tick → aggregator →
        current-bars) — restoring live prices AND filling candle gaps from one
        source, so chart + panel stay in sync.

        Per-symbol staleness gate: skip a symbol if a REAL tick (WS/Binance)
        landed within LIVE_WINDOW — so the moment a paid WS plan streams for
        real, this becomes a no-op automatically (no double-ticking). Like the
        Binance feed it does NOT touch self._tick_count, so the primary-feed
        watchdogs still judge the real feed's health. Gated by
        INFOWAY_REST_BRIDGE_ENABLED.
        """
        from packages.common.src.infoway_rest import fetch_latest_close_batch

        token = (getattr(settings, "INFOWAY_TOKEN", "") or "").strip()
        syms = list(INSTRUMENTS.keys())   # batch helper filters to /common/ only
        LIVE_WINDOW = 6.0                  # s — a real tick this recent wins
        POLL = 2.0
        logger.info("InfoWay REST-to-tick bridge ON (poll=%.1fs) — free-plan live-price fallback", POLL)
        while self.running and isinstance(self.feed, (InfoWayFeed, AllTickFeed)):
            try:
                latest = await fetch_latest_close_batch(syms, "1m", token)
                now_mono = time.monotonic()
                for sym, close in latest.items():
                    if close <= 0:
                        continue
                    # A genuine live tick arrived recently → let it win.
                    last = self._last_live_mono.get(sym, 0.0)
                    if last and (now_mono - last) < LIVE_WINDOW:
                        continue
                    ts = datetime.now(timezone.utc)
                    timestamp = ts.strftime("%Y-%m-%dT%H:%M:%S.") + f"{ts.microsecond // 1000:03d}Z"
                    mid = close
                    # Update _last_mid (feeds the bad-tick jump guard) but NOT
                    # _last_live_mono — that must reflect only REAL liveness.
                    self._last_mid[sym] = mid
                    spread_mult = self.spread_cache.note_mid(sym, mid)
                    bid, ask = self.spread_cache.widen(sym, mid)
                    await publish_price(sym, bid, ask, timestamp, spread_mult)
                    await self.store.insert_tick(sym, bid, ask, timestamp)
                    self.aggregator.update(sym, bid, ask, timestamp)
                    await self._publish_current_bars(sym)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning("InfoWay REST bridge error: %s", e)
            await asyncio.sleep(POLL)

    async def _alltick_fallback_watchdog(self) -> None:
        """If AllTick never delivers ticks (bad token, expired plan, network,
        symbol mismatch), fall back to the simulator so quotes appear."""
        try:
            await asyncio.sleep(55.0)
        except asyncio.CancelledError:
            raise
        if not self.running or self._tick_count > 0:
            return
        if not isinstance(self.feed, AllTickFeed):
            return
        if not getattr(settings, "ALLOW_SIMULATED_FEED", False):
            # Client 2026-06-20: do NOT switch to the GBM simulator. Leave the
            # real feed connected so quotes freeze on the last real price and
            # resume when AllTick streams again (e.g. Monday open).
            logger.warning(
                "AllTick: no ticks in 55s (closed market / token / plan / network). "
                "Simulated feed disabled (ALLOW_SIMULATED_FEED=false) — keeping the real "
                "feed connected; quotes stay frozen, NOT switching to mock prices."
            )
            return
        logger.error(
            "AllTick: no ticks in 55s — falling back to simulated feed "
            "(ALLOW_SIMULATED_FEED=true)."
        )
        try:
            await self.feed.stop()
        except Exception as exc:
            logger.warning("Stopping AllTick feed: %s", exc)
        self.feed = FeedSimulator(tick_rate_multiplier=1.0)
        asyncio.create_task(self.feed.start())

    async def _infoway_fallback_watchdog(self) -> None:
        """Same safety net as the AllTick watchdog, scoped to InfoWay.
        If the subscription comes back with an error (bad key, expired
        plan, symbol not in plan, closed-market weekend) and zero ticks
        flow for 55s, swap the feed out for the simulator."""
        try:
            await asyncio.sleep(55.0)
        except asyncio.CancelledError:
            raise
        if not self.running or self._tick_count > 0:
            return
        if not isinstance(self.feed, InfoWayFeed):
            return
        if not getattr(settings, "ALLOW_SIMULATED_FEED", False):
            # Client 2026-06-20: do NOT switch to the GBM simulator (it invented
            # e.g. XAUUSD ~2000). Leave InfoWay connected so quotes freeze on the
            # last real price and resume when InfoWay streams again.
            logger.warning(
                "InfoWay: no ticks in 55s (closed market / token / plan / network). "
                "Simulated feed disabled (ALLOW_SIMULATED_FEED=false) — keeping InfoWay "
                "connected; quotes stay frozen, NOT switching to mock prices."
            )
            return
        logger.error(
            "InfoWay: no ticks in 55s — falling back to simulated feed "
            "(ALLOW_SIMULATED_FEED=true)."
        )
        try:
            await self.feed.stop()
        except Exception as exc:
            logger.warning("Stopping InfoWay feed: %s", exc)
        self.feed = FeedSimulator(tick_rate_multiplier=1.0)
        asyncio.create_task(self.feed.start())

    async def _auto_seed_bars(self) -> None:
        """Wait for first ticks to arrive, then seed historical bars.

        On every startup we drop any non-crypto `bars:*:*` keys first.
        Those used to be filled with simulated random-walk data when
        AllTick wasn't yet integrated; the keys have no TTL so they
        survive across deploys until explicitly deleted. After the
        flush, `seed_bars()` repopulates from real AllTick history
        (and Binance for crypto). Crypto bars are left untouched —
        they were always real.

        The crypto-presence check is kept as a fast-path: if BTCUSD
        already has 50+ bars in Redis we short-circuit so a normal
        restart doesn't re-fetch all crypto bars unnecessarily.
        """
        try:
            await asyncio.sleep(30.0)  # give feed time to start delivering ticks
        except asyncio.CancelledError:
            raise
        if not self.running:
            return

        # Drop simulated non-crypto bars from any earlier deploy so the seed
        # below replaces them with real AllTick data. No-op on a fresh deploy
        # (nothing to delete) so this is safe to run unconditionally.
        try:
            flushed = await flush_non_crypto_keys()
            if flushed:
                logger.info("Auto-seed: flushed %d stale non-crypto bar keys", flushed)
        except Exception as exc:
            logger.warning("Auto-seed flush failed (continuing): %s", exc)

        sample_count = await redis_client.llen("bars:BTCUSD:5m")
        if sample_count >= 50:
            logger.info(
                "Bars already seeded for crypto (%d bars for BTCUSD:5m); "
                "running seed for non-crypto only",
                sample_count,
            )
        else:
            logger.info("Auto-seeding historical bars (first run or bars missing)...")
        try:
            await seed_bars(ohlc_store=self.ohlc_store)
        except Exception as exc:
            logger.warning("Auto-seed bars failed: %s", exc)

    async def shutdown(self):
        logger.info("Shutting down Market Data Service...")
        self.running = False
        await self.feed.stop()
        await redis_client.close()


async def main():
    service = MarketDataService()
    try:
        await service.start()
    except KeyboardInterrupt:
        await service.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
