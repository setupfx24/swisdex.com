"""One-off correction: re-price the promotional account's seeded CLOSED trades
so their open/close prices hug the LIVE market instead of stale hardcoded
values (the XAUUSD closed trade seeded at 2600 while gold trades ~4175).

Only the seeded closed trades (Position.comment == 'seed', status=closed) are
touched. For each, the CLOSE price is anchored to the current live mid and the
OPEN price is back-solved so the stored PROFIT is UNCHANGED — so account
balances/equity do not move, only the displayed prices become realistic.

  BUY : profit = (close-open)*lots*cs  ->  open = close - profit/(lots*cs)
  SELL: profit = (open-close)*lots*cs  ->  open = close + profit/(lots*cs)

DRY-RUN by default; --execute to write.
    python -m services.gateway.src.reprice_promo_trades
    python -m services.gateway.src.reprice_promo_trades --execute
"""
import argparse
import asyncio
import json
import logging
from decimal import Decimal, ROUND_HALF_UP

from sqlalchemy import select, func

from packages.common.src.database import AsyncSessionLocal
from packages.common.src.models import (
    User, TradingAccount, Position, TradeHistory, Instrument, PositionStatus, OrderSide,
)
from packages.common.src.redis_client import redis_client, PriceChannel

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-5s %(message)s")
logger = logging.getLogger("reprice-promo")

TARGET_EMAIL = "amardeepsonar2001@gmail.com"


async def live_mid(symbol: str) -> Decimal | None:
    try:
        raw = await redis_client.get(PriceChannel.tick_key(symbol))
        if raw:
            d = json.loads(raw)
            return (Decimal(str(d["bid"])) + Decimal(str(d["ask"]))) / Decimal("2")
    except Exception as exc:  # noqa: BLE001
        logger.warning("live_mid(%s) failed: %s", symbol, exc)
    return None


async def run(execute: bool):
    tag = "" if execute else "[dry-run] "
    async with AsyncSessionLocal() as db:
        main = (await db.execute(
            select(User).where(func.lower(User.email) == TARGET_EMAIL.lower())
        )).scalar_one_or_none()
        if main is None:
            logger.error("target user %s not found", TARGET_EMAIL)
            return

        acct_ids = (await db.execute(
            select(TradingAccount.id).where(TradingAccount.user_id == main.id)
        )).scalars().all()
        if not acct_ids:
            logger.error("no trading accounts for %s", TARGET_EMAIL)
            return

        positions = (await db.execute(
            select(Position).where(
                Position.account_id.in_(acct_ids),
                Position.status == PositionStatus.CLOSED,
                Position.comment == "seed",
            )
        )).scalars().all()
        logger.info("%s%d seeded closed positions to inspect", tag, len(positions))

        changed = 0
        for pos in positions:
            inst = (await db.execute(
                select(Instrument).where(Instrument.id == pos.instrument_id)
            )).scalar_one_or_none()
            if inst is None:
                logger.warning("%s  position %s: instrument missing — skip", tag, pos.id)
                continue
            mid = await live_mid(inst.symbol)
            if mid is None:
                logger.warning("%s  %s: no live price — skip", tag, inst.symbol)
                continue

            cs = Decimal(str(inst.contract_size or 100000))
            lots = Decimal(str(pos.lots))
            profit = Decimal(str(pos.profit or 0))
            denom = lots * cs
            if denom == 0:
                logger.warning("%s  %s: lots*contract=0 — skip", tag, inst.symbol)
                continue

            digits = int(inst.digits or 5)
            q = Decimal(1).scaleb(-digits)  # e.g. 0.01 for 2 digits
            close = mid.quantize(q, rounding=ROUND_HALF_UP)
            if pos.side == OrderSide.BUY:
                open_px = (close - profit / denom)
            else:
                open_px = (close + profit / denom)
            open_px = open_px.quantize(q, rounding=ROUND_HALF_UP)

            # Skip if already realistic (within 5% of live) to avoid churn.
            if pos.open_price and abs(Decimal(str(pos.open_price)) - mid) <= mid * Decimal("0.05"):
                logger.info("%s  %s already near live (open=%s, mid=%s) — leave", tag,
                            inst.symbol, pos.open_price, mid.quantize(q))
                continue

            logger.info("%s  %s %s: open %s->%s  close %s->%s  (profit %s unchanged)", tag,
                        inst.symbol, pos.side.value, pos.open_price, open_px,
                        pos.close_price, close, profit)
            if execute:
                pos.open_price = open_px
                pos.close_price = close
                th = (await db.execute(
                    select(TradeHistory).where(TradeHistory.position_id == pos.id)
                )).scalars().all()
                for h in th:
                    h.open_price = open_px
                    h.close_price = close
            changed += 1

        if execute:
            await db.commit()
            logger.info("DONE — repriced %d closed trades.", changed)
        else:
            await db.rollback()
            logger.info("[dry-run] would reprice %d closed trades. Re-run with --execute.", changed)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Reprice seeded closed trades to live market.")
    p.add_argument("--execute", action="store_true", help="actually write (default: dry-run)")
    args = p.parse_args()
    asyncio.run(run(execute=args.execute))
