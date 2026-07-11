"""Admin Risk Management (client 2026-07-10).

Live exposure board for the dealing desk:
  * /risk/exposure — per-instrument net lots (buy − sell) across all OPEN
    positions + the running (floating) P&L of those positions.
  * /risk/trades   — every running trade, filterable by instrument and
    sortable by biggest profit / biggest loss / latest.

Floating P&L is valued at the live tick MID from Redis (same broadcast the
trader UI streams), converted to USD via quote_to_account_pnl — matching how
the trader's own floating P&L is computed. Positions whose symbol has no
live tick fall back to the position's last persisted `profit`.

NOTE: admin's own REDIS_URL is pinned to db 1 (rate-limit space); live ticks
live in db 0, so this module opens its own db-0 connection (same pattern as
settings_service's cache invalidation).
"""
from __future__ import annotations

import json
import os
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from packages.common.src.database import get_db
from packages.common.src.models import Instrument, Position, TradingAccount, User
from packages.common.src.trading_service import quote_to_account_pnl
from dependencies import require_permission

router = APIRouter(prefix="/risk", tags=["Risk Management"])

_redis0 = None


def _get_redis0():
    """Lazy db-0 Redis client (ticks) — admin's default client is db 1."""
    global _redis0
    if _redis0 is None:
        import redis.asyncio as aioredis
        url = os.getenv("REDIS_URL", "redis://redis:6379/0")
        base = url.rsplit("/", 1)[0]
        _redis0 = aioredis.from_url(f"{base}/0", decode_responses=True)
    return _redis0


def _side_val(side) -> str:
    v = getattr(side, "value", side)
    return str(v or "").lower()


async def _tick_mids(symbols: list[str]) -> dict[str, Decimal]:
    """symbol -> live MID from tick:<SYM>; missing/broken ticks are skipped."""
    if not symbols:
        return {}
    out: dict[str, Decimal] = {}
    try:
        r = _get_redis0()
        vals = await r.mget([f"tick:{s}" for s in symbols])
        for sym, raw in zip(symbols, vals):
            if not raw:
                continue
            try:
                t = json.loads(raw)
                bid = Decimal(str(t.get("bid") or 0))
                ask = Decimal(str(t.get("ask") or 0))
                mid = (bid + ask) / 2 if (bid > 0 and ask > 0) else (bid or ask)
                if mid > 0:
                    out[sym] = mid
            except Exception:
                continue
    except Exception:
        return {}
    return out


async def _open_trades(
    db: AsyncSession,
    book: str = "all",
    symbol: Optional[str] = None,
) -> list[dict]:
    """All OPEN positions enriched with live P&L + owner info."""
    q = (
        select(Position, TradingAccount, User, Instrument)
        .join(TradingAccount, TradingAccount.id == Position.account_id)
        .join(User, User.id == TradingAccount.user_id)
        .join(Instrument, Instrument.id == Position.instrument_id)
        .where(Position.status == "open")
        .options(selectinload(Position.instrument))
    )
    if book == "real":
        q = q.where(TradingAccount.is_demo == False, TradingAccount.is_promotional == False)  # noqa: E712
    elif book == "demo":
        q = q.where(TradingAccount.is_demo == True)  # noqa: E712
    if symbol:
        q = q.where(Instrument.symbol == symbol.strip().upper())

    rows = (await db.execute(q)).all()
    symbols = sorted({(inst.symbol or "").upper() for _, _, _, inst in rows if inst.symbol})
    mids = await _tick_mids(symbols)

    items: list[dict] = []
    for pos, acct, user, inst in rows:
        sym = (inst.symbol or "").upper()
        lots = Decimal(str(pos.lots or 0))
        contract = Decimal(str(inst.contract_size or 100000))
        open_price = Decimal(str(pos.open_price or 0))
        mid = mids.get(sym)
        if mid and open_price > 0 and lots > 0:
            raw = (mid - open_price) * lots * contract
            if _side_val(pos.side) != "buy":
                raw = -raw
            pnl = quote_to_account_pnl(
                raw, inst.base_currency, inst.quote_currency, mid, "USD", symbol=sym,
            )
            current = float(mid)
        else:
            # No live tick (closed market / unknown symbol) — last persisted value.
            pnl = Decimal(str(pos.profit or 0))
            current = None
        items.append({
            "position_id": str(pos.id),
            "symbol": sym,
            "side": _side_val(pos.side),
            "lots": float(lots),
            "open_price": float(open_price),
            "current_price": current,
            "pnl": round(float(pnl), 2),
            "opened_at": pos.created_at.isoformat() if pos.created_at else None,
            "account_number": acct.account_number,
            "is_demo": bool(acct.is_demo),
            "is_promotional": bool(getattr(acct, "is_promotional", False)),
            "user_name": " ".join(filter(None, [user.first_name, user.last_name])).strip() or user.email,
            "user_email": user.email,
        })
    return items


@router.get("/exposure")
async def exposure(
    book: str = Query("all", pattern="^(all|real|demo)$"),
    admin: User = Depends(require_permission("trades.view")),
    db: AsyncSession = Depends(get_db),
):
    """Per-instrument net lots + running P&L across all open positions."""
    trades = await _open_trades(db, book=book)
    agg: dict[str, dict] = {}
    for t in trades:
        a = agg.setdefault(t["symbol"], {
            "symbol": t["symbol"], "buy_lots": 0.0, "sell_lots": 0.0,
            "net_lots": 0.0, "trades": 0, "pnl": 0.0,
        })
        if t["side"] == "buy":
            a["buy_lots"] += t["lots"]
        else:
            a["sell_lots"] += t["lots"]
        a["trades"] += 1
        a["pnl"] += t["pnl"]
    for a in agg.values():
        a["net_lots"] = round(a["buy_lots"] - a["sell_lots"], 4)
        a["buy_lots"] = round(a["buy_lots"], 4)
        a["sell_lots"] = round(a["sell_lots"], 4)
        a["pnl"] = round(a["pnl"], 2)
    items = sorted(agg.values(), key=lambda x: abs(x["net_lots"]), reverse=True)
    return {
        "items": items,
        "totals": {
            "instruments": len(items),
            "trades": len(trades),
            "pnl": round(sum(t["pnl"] for t in trades), 2),
        },
    }


@router.get("/trades")
async def running_trades(
    symbol: Optional[str] = Query(None),
    sort: str = Query("latest", pattern="^(latest|profit|loss)$"),
    book: str = Query("all", pattern="^(all|real|demo)$"),
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    admin: User = Depends(require_permission("trades.view")),
    db: AsyncSession = Depends(get_db),
):
    """Every running trade — filter by instrument, sort by big profit/loss."""
    trades = await _open_trades(db, book=book, symbol=symbol)
    if sort == "profit":
        trades.sort(key=lambda t: t["pnl"], reverse=True)
    elif sort == "loss":
        trades.sort(key=lambda t: t["pnl"])
    else:
        trades.sort(key=lambda t: t["opened_at"] or "", reverse=True)
    total = len(trades)
    start = (page - 1) * per_page
    return {"items": trades[start:start + per_page], "total": total, "page": page, "per_page": per_page}
