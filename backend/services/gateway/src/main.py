"""SwisDex Gateway — REST + WebSocket API Server."""
import asyncio
import json
import logging
from contextlib import asynccontextmanager
from uuid import UUID

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends, HTTPException, status, Request, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.config import get_settings
from packages.common.src.database import get_db, AsyncSessionLocal
from packages.common.src.redis_client import redis_client, PriceChannel, BAR_UPDATES_CHANNEL
from packages.common.src.auth import decode_token
from packages.common.src.models import TradingAccount
from packages.common.src.instrumentation import init_sentry, add_middleware_stack

from .api import (
    auth, orders, positions, accounts, instruments, deposits, webhooks,
    websocket_manager, social, business, portfolio, profile, support,
    notifications, banners, trading_catalog, followers, lp_receiver,
    share, insurance, rewards, play_zone, staking, fixed_return,
    bonus_tiers, referral_tiers,
)
from .engines.sltp_engine import sltp_engine
from .engines.copy_engine import copy_engine
from .engines.stats_engine import stats_engine
from .engines.staking_engine import staking_engine
from .engines.play_zone_engine import play_zone_engine
from .engines.overnight_fee_engine import overnight_fee_engine
from .engines.verification_reminder_engine import verification_reminder_engine
from .engines.deposit_reminder_engine import deposit_reminder_engine
from .engines.fixed_return_engine import fixed_return_engine
from .engines.eligibility_nudge_engine import eligibility_nudge_engine
from .engines.statement_engine import statement_engine
from .engines.payout_engine import payout_engine
from .engines.nowpayments_reconcile_engine import nowpayments_reconcile_engine

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-5s [%(name)s] %(message)s")
logger = logging.getLogger("gateway")

settings = get_settings()
init_sentry("gateway")

_cors_origins = [o.strip() for o in settings.CORS_ORIGINS.split(",") if o.strip()]
if not _cors_origins:
    _cors_origins = ["http://localhost:3000", "http://localhost:3001"]
_cors_methods = [m.strip() for m in settings.CORS_ALLOW_METHODS.split(",") if m.strip()]
_cors_headers = [h.strip() for h in settings.CORS_ALLOW_HEADERS.split(",") if h.strip()]


async def _backfill_close_reasons():
    """Relabel historical trade_history rows where close_price matches the
    position's SL/TP level — those were previously written as 'manual' but
    should now show as 'sl'/'tp' in the UI. Idempotent."""
    from sqlalchemy import text
    sql = text(
        """
        UPDATE trade_history th
        SET close_reason = CASE
            WHEN p.stop_loss IS NOT NULL AND (
                (p.side = 'buy'  AND th.close_price <= p.stop_loss)
             OR (p.side = 'sell' AND th.close_price >= p.stop_loss)
            ) THEN 'sl'
            WHEN p.take_profit IS NOT NULL AND (
                (p.side = 'buy'  AND th.close_price >= p.take_profit)
             OR (p.side = 'sell' AND th.close_price <= p.take_profit)
            ) THEN 'tp'
            ELSE th.close_reason
        END
        FROM positions p
        WHERE th.position_id = p.id
          AND COALESCE(th.close_reason, 'manual') IN ('manual', 'copy_close', 'copy')
          AND (p.stop_loss IS NOT NULL OR p.take_profit IS NOT NULL)
        """
    )
    try:
        async with AsyncSessionLocal() as session:
            await session.execute(sql)
            await session.commit()
    except Exception as e:
        logger.warning("close_reason backfill skipped: %s", e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await _backfill_close_reasons()
    await sltp_engine.start()
    await copy_engine.start()
    await stats_engine.start()
    await staking_engine.start()
    await play_zone_engine.start()
    await overnight_fee_engine.start()
    await verification_reminder_engine.start()
    await deposit_reminder_engine.start()
    await fixed_return_engine.start()
    await eligibility_nudge_engine.start()
    await statement_engine.start()
    await payout_engine.start()
    await nowpayments_reconcile_engine.start()
    yield
    await nowpayments_reconcile_engine.stop()
    await payout_engine.stop()
    await statement_engine.stop()
    await eligibility_nudge_engine.stop()
    await fixed_return_engine.stop()
    await deposit_reminder_engine.stop()
    await verification_reminder_engine.stop()
    await overnight_fee_engine.stop()
    await play_zone_engine.stop()
    await staking_engine.stop()
    await stats_engine.stop()
    await copy_engine.stop()
    await sltp_engine.stop()
    await redis_client.close()


app = FastAPI(
    title="SwisDex Gateway",
    version="1.0.0",
    description="Forex CFD B-Book Trading Platform API",
    lifespan=lifespan,
    docs_url="/docs" if settings.ENVIRONMENT == "development" else None,
    redoc_url="/redoc" if settings.ENVIRONMENT == "development" else None,
    openapi_url="/openapi.json" if settings.ENVIRONMENT == "development" else None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=_cors_methods,
    allow_headers=_cors_headers,
    max_age=86400,  # Cache preflight for 24h — avoids OPTIONS request before every POST
)

add_middleware_stack(app)

# REST API Routes
app.include_router(auth.router, prefix="/api/v1/auth", tags=["Authentication"])
app.include_router(accounts.router, prefix="/api/v1/accounts", tags=["Accounts"])
app.include_router(instruments.router, prefix="/api/v1/instruments", tags=["Instruments"])
app.include_router(trading_catalog.router, prefix="/api/v1")
app.include_router(orders.router, prefix="/api/v1/orders", tags=["Orders"])
app.include_router(positions.router, prefix="/api/v1/positions", tags=["Positions"])
app.include_router(deposits.router, prefix="/api/v1/wallet", tags=["Wallet"])
app.include_router(social.router, prefix="/api/v1/social", tags=["Social Trading"])
app.include_router(business.router, prefix="/api/v1/business", tags=["Business/IB"])
app.include_router(portfolio.router, prefix="/api/v1/portfolio", tags=["Portfolio"])
app.include_router(profile.router, prefix="/api/v1/profile", tags=["Profile"])
app.include_router(support.router, prefix="/api/v1/support", tags=["Support"])
app.include_router(notifications.router, prefix="/api/v1/notifications", tags=["Notifications"])
app.include_router(banners.media_router, prefix="/api/v1/banners", tags=["Banners"])
app.include_router(banners.router, prefix="/api/v1/banners", tags=["Banners"])
app.include_router(followers.router, prefix="/api/v1/followers", tags=["Followers"])
app.include_router(webhooks.router, prefix="/api/v1/webhooks", tags=["Webhooks"])
# Corecen LP price push receiver — HMAC-secured, public (no JWT). Path mirrors
# Corecen's sender (axios POST baseURL + '/api/lp/prices/batch').
app.include_router(lp_receiver.router, prefix="/api/lp", tags=["LP Receiver"])
app.include_router(share.router, prefix="/api/v1", tags=["Share Trade"])
app.include_router(share.public_router, prefix="/api/v1/public", tags=["Public Share"])
app.include_router(insurance.router, prefix="/api/v1/insurance", tags=["Trade Insurance"])
app.include_router(rewards.router, prefix="/api/v1/rewards", tags=["Rewards"])
app.include_router(play_zone.router, prefix="/api/v1/play", tags=["Play Zone"])
app.include_router(staking.router, prefix="/api/v1/staking", tags=["Staking"])
app.include_router(fixed_return.router, prefix="/api/v1/fixed-return", tags=["Fixed Return"])
# Public — no JWT. Drives the trader /bonus page's deposit-match tier cards.
app.include_router(bonus_tiers.router, prefix="/api/v1/bonus", tags=["Bonus Tiers"])
# Public — no JWT. Drives the trader /products/referral payout-ladder table.
# Reads from system_settings.ib_commission_tiers (managed in admin /config/ib-tiers).
app.include_router(referral_tiers.router, prefix="/api/v1/referral", tags=["Referral Tiers"])


@app.get("/health")
async def health():
    return {"status": "ok", "service": "gateway"}


# ============================================
# WEBSOCKET — Price Streaming & Trade Updates
# ============================================

def _verify_ws_token(token: str | None) -> dict | None:
    """Decode a JWT for WebSocket auth. Returns payload or None."""
    if not token:
        return None
    try:
        payload = decode_token(token)
        return {"user_id": UUID(payload["sub"]), "role": payload["role"]}
    except Exception:
        return None


def _ws_token(websocket: WebSocket, token_q: str | None) -> str | None:
    """Resolve the JWT to use for a WebSocket auth: prefer the httpOnly
    auth cookie (browsers send it on the WS upgrade request), fall back
    to the legacy ``?token=`` query parameter for clients that haven't
    been migrated. Cookie path keeps the JWT out of nginx access logs
    and browser history."""
    if token_q:
        return token_q
    cookie = websocket.cookies.get(settings.ACCESS_TOKEN_COOKIE_NAME)
    return cookie or None


@app.websocket("/ws/prices")
async def price_stream(websocket: WebSocket, token: str | None = Query(default=None)):
    token = _ws_token(websocket, token)
    if token:
        user = _verify_ws_token(token)
        if not user:
            await websocket.close(code=4001, reason="Invalid token")
            return

    await websocket.accept()
    pubsub = redis_client.pubsub()
    await pubsub.subscribe(PriceChannel.PRICE_CHANNEL)

    try:
        ping_interval = 30
        last_ping = asyncio.get_event_loop().time()
        while True:
            message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=0.1)
            if message and message["type"] == "message":
                await websocket.send_text(message["data"])

            now = asyncio.get_event_loop().time()
            if now - last_ping >= ping_interval:
                await websocket.send_json({"type": "ping"})
                last_ping = now

            await asyncio.sleep(0.01)
    except WebSocketDisconnect:
        pass
    finally:
        await pubsub.unsubscribe(PriceChannel.PRICE_CHANNEL)
        await pubsub.close()


# ─── Live OHLC bar updates for the trader chart ──────────────────────────────
# Replaces the trader frontend's old client-side bar synthesis (which built
# the in-progress candle from raw ticks and drifted from the server's
# authoritative aggregation). market-data publishes per-tick snapshots of
# every (symbol, timeframe) bar to BAR_UPDATES_CHANNEL; this hub fans them
# out to subscribed charts only — clients send a {type:"subscribe",
# symbol, resolution} message after connecting and we filter accordingly.
#
# Wire protocol:
#   client → server: {"type":"subscribe","symbol":"XAUUSD","resolution":"5"}
#                    {"type":"unsubscribe","symbol":"XAUUSD","resolution":"5"}
#                    {"type":"ping"}
#   server → client: {"type":"bar_update","symbol":"XAUUSD","resolution":"5",
#                     "bar":{"time":1731000000,"open":...,"high":...,
#                            "low":...,"close":...,"volume":...}}
#                    {"type":"pong"}
#                    {"type":"subscribed","symbol":...,"resolution":...}
#
# `bar.time` is BAR-START in epoch SECONDS to match the rest of the bar
# pipeline (Redis lists, REST get_bars). Frontend converts to ms for TV.

# Map BarAggregator timeframe key → TradingView resolution string. Server
# accepts EITHER form on the wire (frontend usually sends TV resolutions);
# we normalise to the TF key for filtering.
_TV_RESOLUTION_TO_TF: dict[str, str] = {
    "1": "1m", "5": "5m", "15": "15m", "30": "30m",
    "60": "1h", "240": "4h", "D": "1d", "1D": "1d",
}
_TF_TO_TV_RESOLUTION: dict[str, str] = {
    "1m": "1", "5m": "5", "15m": "15", "30m": "30",
    "1h": "60", "4h": "240", "1d": "1D",
}


def _normalise_resolution(value: str | None) -> str | None:
    """Accept either a TV resolution ('5') or a TF key ('5m'); return TF key."""
    if not value:
        return None
    v = str(value).strip()
    if v in _TV_RESOLUTION_TO_TF:
        return _TV_RESOLUTION_TO_TF[v]
    if v in _TF_TO_TV_RESOLUTION:
        return v
    return None


@app.websocket("/ws/bars")
async def bar_stream(websocket: WebSocket, token: str | None = Query(default=None)):
    """One-stop chart bar feed. Clients subscribe to (symbol, resolution)
    pairs they care about; the server forwards only matching bar updates."""
    token = _ws_token(websocket, token)
    if token:
        user = _verify_ws_token(token)
        if not user:
            await websocket.close(code=4001, reason="Invalid token")
            return

    await websocket.accept()
    # Per-connection subscription set: {(SYMBOL_UPPER, "5m"), ...}
    subs: set[tuple[str, str]] = set()
    pubsub = redis_client.pubsub()
    await pubsub.subscribe(BAR_UPDATES_CHANNEL)

    async def reader_loop():
        """Forward Redis bar updates to this client filtered by `subs`."""
        try:
            ping_interval = 30
            last_ping = asyncio.get_event_loop().time()
            while True:
                msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=0.1)
                if msg and msg["type"] == "message":
                    try:
                        payload = json.loads(msg["data"])
                    except (TypeError, ValueError):
                        continue
                    sym = str(payload.get("symbol") or "").upper()
                    tf = str(payload.get("timeframe") or "")
                    if not sym or not tf:
                        continue
                    if (sym, tf) not in subs:
                        continue
                    bar = {
                        "time":   int(payload.get("time", 0)),
                        "open":   float(payload.get("open", 0)),
                        "high":   float(payload.get("high", 0)),
                        "low":    float(payload.get("low", 0)),
                        "close":  float(payload.get("close", 0)),
                        "volume": float(payload.get("volume", 0)),
                    }
                    await websocket.send_json({
                        "type": "bar_update",
                        "symbol": sym,
                        "resolution": _TF_TO_TV_RESOLUTION.get(tf, tf),
                        "bar": bar,
                    })

                now = asyncio.get_event_loop().time()
                if now - last_ping >= ping_interval:
                    await websocket.send_json({"type": "ping"})
                    last_ping = now

                await asyncio.sleep(0.01)
        except (WebSocketDisconnect, asyncio.CancelledError):
            return
        except Exception as exc:
            logger.debug("ws/bars reader loop ended: %s", exc)

    async def control_loop():
        """Handle client subscribe / unsubscribe / ping messages."""
        try:
            while True:
                raw = await websocket.receive_text()
                try:
                    data = json.loads(raw)
                except (TypeError, ValueError):
                    continue
                t = data.get("type")
                if t == "ping":
                    await websocket.send_json({"type": "pong"})
                    continue
                if t in ("subscribe", "unsubscribe"):
                    sym = str(data.get("symbol") or "").upper()
                    tf = _normalise_resolution(data.get("resolution"))
                    if not sym or not tf:
                        continue
                    if t == "subscribe":
                        subs.add((sym, tf))
                        await websocket.send_json({
                            "type": "subscribed",
                            "symbol": sym,
                            "resolution": _TF_TO_TV_RESOLUTION.get(tf, tf),
                        })
                    else:
                        subs.discard((sym, tf))
        except (WebSocketDisconnect, asyncio.CancelledError):
            return
        except Exception as exc:
            logger.debug("ws/bars control loop ended: %s", exc)

    reader = asyncio.create_task(reader_loop())
    control = asyncio.create_task(control_loop())
    try:
        await asyncio.wait({reader, control}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for t in (reader, control):
            if not t.done():
                t.cancel()
        try:
            await pubsub.unsubscribe(BAR_UPDATES_CHANNEL)
            await pubsub.close()
        except Exception:
            pass
        try:
            await websocket.close()
        except Exception:
            pass


@app.websocket("/ws/trades/{account_id}")
async def trade_stream(websocket: WebSocket, account_id: str, token: str | None = Query(default=None)):
    token = _ws_token(websocket, token)
    user = _verify_ws_token(token)
    if not user:
        await websocket.close(code=4001, reason="Invalid token")
        return

    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(TradingAccount).where(
                TradingAccount.id == UUID(account_id),
                TradingAccount.user_id == user["user_id"],
            )
        )
        if not result.scalar_one_or_none():
            await websocket.close(code=4003, reason="Account not found or access denied")
            return

    await websocket.accept()
    manager = websocket_manager.ConnectionManager()
    await manager.connect(account_id, websocket)

    pubsub = redis_client.pubsub()
    channel = f"account:{account_id}"
    await pubsub.subscribe(channel)

    try:
        ping_interval = 30
        last_ping = asyncio.get_event_loop().time()
        while True:
            ws_message = None
            try:
                ws_message = await asyncio.wait_for(websocket.receive_text(), timeout=0.1)
            except asyncio.TimeoutError:
                pass

            if ws_message:
                data = json.loads(ws_message)
                if data.get("type") == "pong":
                    pass
                else:
                    await manager.handle_message(account_id, data)

            message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=0.1)
            if message and message["type"] == "message":
                await websocket.send_text(message["data"])

            now = asyncio.get_event_loop().time()
            if now - last_ping >= ping_interval:
                await websocket.send_json({"type": "ping"})
                last_ping = now

            await asyncio.sleep(0.01)
    except WebSocketDisconnect:
        manager.disconnect(account_id)
    finally:
        await pubsub.unsubscribe(channel)
        await pubsub.close()


@app.websocket("/ws/admin")
async def admin_stream(websocket: WebSocket, token: str | None = Query(default=None)):
    token = _ws_token(websocket, token)
    user = _verify_ws_token(token)
    if not user or user["role"] not in ("admin", "super_admin"):
        await websocket.close(code=4003, reason="Admin access required")
        return

    await websocket.accept()
    pubsub = redis_client.pubsub()
    await pubsub.subscribe("admin:trades", "admin:deposits", "admin:alerts")

    try:
        ping_interval = 30
        last_ping = asyncio.get_event_loop().time()
        while True:
            message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=0.1)
            if message and message["type"] == "message":
                await websocket.send_text(json.dumps({
                    "channel": message["channel"],
                    "data": message["data"],
                }))

            now = asyncio.get_event_loop().time()
            if now - last_ping >= ping_interval:
                await websocket.send_json({"type": "ping"})
                last_ping = now

            await asyncio.sleep(0.01)
    except WebSocketDisconnect:
        pass
    finally:
        await pubsub.unsubscribe("admin:trades", "admin:deposits", "admin:alerts")
        await pubsub.close()
