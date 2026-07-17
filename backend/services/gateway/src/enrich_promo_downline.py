"""Fourth-pass seeder: make the promo downline (referred by
amardeepsonar2001@gmail.com) look like real referred customers.

Client 2026-07-11:
  - Each friend on the trader /referral page shows "0 / 3" trades → give every
    downline a real trading account + a RANDOM number of CLOSED trades
    (minimum 3) so it reads e.g. "5 / 3" (qualified/green).
  - The @swisdex-promo.local emails look fake → rename each downline to a
    believable name-based personal email (gmail/outlook/yahoo/rediff).

All downline accounts stay is_promotional=True so they're excluded from the
broker's real financials (and, after the matching admin change, hidden from
the admin panel entirely).

SAFETY: DRY-RUN by default. Add --execute to write. Idempotent — re-running
never adds a second batch of trades and never renames an already-real email.
    python -m services.gateway.src.enrich_promo_downline            # dry-run
    python -m services.gateway.src.enrich_promo_downline --execute   # write
"""
import argparse
import asyncio
import logging
import random
import secrets
import string
from decimal import Decimal, ROUND_HALF_UP
from datetime import datetime, timezone, timedelta

from sqlalchemy import select, func

from packages.common.src.database import AsyncSessionLocal
from packages.common.src.models import (
    User, AccountGroup, TradingAccount, Position, TradeHistory, Instrument,
    PositionStatus, OrderSide,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-5s %(message)s")
logger = logging.getLogger("enrich-promo")

TARGET_EMAIL = "amardeepsonar2001@gmail.com"
RNG = random.Random(20260711)
SEED_MARKER = "seed-downline"

# Realistic name-based emails keyed by "First Last".
EMAIL_MAP = {
    "Rahul Verma":      "rahul.verma87@gmail.com",
    "Priya Sharma":     "priya.sharma22@yahoo.com",
    "Arjun Mehta":      "arjun.mehta91@gmail.com",
    "Sanjay Patel":     "sanjay.patel34@outlook.com",
    "Neha Gupta":       "neha.gupta19@gmail.com",
    "Vikram Singh":     "vikram.singh76@rediffmail.com",
    "Anjali Nair":      "anjali.nair48@gmail.com",
    "Rohit Joshi":      "rohit.joshi63@outlook.com",
    "Kavya Reddy":      "kavya.reddy28@gmail.com",
    "Manish Kulkarni":  "manish.kulkarni51@yahoo.com",
    "Pooja Iyer":       "pooja.iyer39@gmail.com",
    "Deepak Chauhan":   "deepak.chauhan17@gmail.com",
}

# symbol -> (base_price, price_decimals, (lot_min, lot_max))
SYMBOLS = {
    "EURUSD": (Decimal("1.08500"), 5, (Decimal("0.02"), Decimal("0.10"))),
    "GBPUSD": (Decimal("1.27000"), 5, (Decimal("0.02"), Decimal("0.10"))),
    "XAUUSD": (Decimal("2600.00"), 2, (Decimal("0.01"), Decimal("0.05"))),
    "BTCUSD": (Decimal("62000.00"), 2, (Decimal("0.005"), Decimal("0.02"))),
    "ETHUSD": (Decimal("3000.00"), 2, (Decimal("0.02"), Decimal("0.08"))),
}
MIN_TRADES, MAX_TRADES = 3, 8   # random per friend, minimum 3


def _now():
    return datetime.now(timezone.utc)


def gen_code(n=8):
    return "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(n))


def _q(v: Decimal, dec: int) -> Decimal:
    return v.quantize(Decimal(1).scaleb(-dec), rounding=ROUND_HALF_UP)


def profit_for(side, lots, op, cp, cs) -> Decimal:
    return (cp - op) * lots * cs if side == OrderSide.BUY else (op - cp) * lots * cs


async def unique_account_number(db) -> str:
    for _ in range(50):
        num = "8" + "".join(secrets.choice(string.digits) for _ in range(7))
        exists = (await db.execute(
            select(func.count(TradingAccount.id)).where(TradingAccount.account_number == num)
        )).scalar()
        if not exists:
            return num
    raise RuntimeError("could not allocate a unique account number")


async def unique_email(db, desired: str) -> str:
    """Return `desired` if free, else append a small numeric suffix."""
    base, _, dom = desired.partition("@")
    for attempt in range(30):
        cand = desired if attempt == 0 else f"{base}{RNG.randint(2, 99)}@{dom}"
        taken = (await db.execute(
            select(func.count(User.id)).where(func.lower(User.email) == cand.lower())
        )).scalar()
        if not taken:
            return cand
    return f"{base}{secrets.token_hex(2)}@{dom}"


async def run(execute: bool):
    tag = "" if execute else "[dry-run] "
    now = _now()
    async with AsyncSessionLocal() as db:
        main = (await db.execute(
            select(User).where(func.lower(User.email) == TARGET_EMAIL.lower())
        )).scalar_one_or_none()
        if main is None:
            raise SystemExit(f"{TARGET_EMAIL} not found.")

        downline = (await db.execute(
            select(User).where(User.referred_by_user_id == main.id).order_by(User.created_at)
        )).scalars().all()
        logger.info("%s%s downline found", tag, len(downline))

        # Standard (non-demo, non-cent) account group for their trading accounts.
        group = (await db.execute(
            select(AccountGroup).where(
                AccountGroup.is_demo == False,          # noqa: E712
                AccountGroup.is_active == True,          # noqa: E712
                AccountGroup.is_cent_account == False,   # noqa: E712
            ).order_by(AccountGroup.minimum_deposit)
        )).scalars().first()
        if group is None:
            raise SystemExit("no standard account group found.")
        leverage = int(group.leverage_default or 100)

        # Cache instruments.
        instruments = {}
        for sym in SYMBOLS:
            inst = (await db.execute(
                select(Instrument).where(func.upper(Instrument.symbol) == sym.upper())
            )).scalar_one_or_none()
            if inst is not None:
                instruments[sym] = inst
        if not instruments:
            raise SystemExit("no seed instruments exist.")

        for child in downline:
            name = f"{child.first_name} {child.last_name}".strip()

            # ── 1. Realistic email ────────────────────────────────────────
            if "@swisdex-promo.local" in (child.email or ""):
                desired = EMAIL_MAP.get(name)
                if desired:
                    new_email = await unique_email(db, desired)
                    logger.info("%s  %s: email %s -> %s", tag, name, child.email, new_email)
                    child.email = new_email
                else:
                    logger.info("%s  %s: no email mapping — left as-is", tag, name)
            else:
                logger.info("%s  %s: email already real (%s)", tag, name, child.email)

            # ── 2. Trading account (create if missing) ────────────────────
            acct = (await db.execute(
                select(TradingAccount).where(
                    TradingAccount.user_id == child.id,
                    TradingAccount.is_demo == False,  # noqa: E712
                ).order_by(TradingAccount.created_at)
            )).scalars().first()
            if acct is None:
                acct_number = await unique_account_number(db)
                acct = TradingAccount(
                    user_id=child.id, account_group_id=group.id, account_number=acct_number,
                    balance=Decimal("0"), credit=Decimal("0"), equity=Decimal("0"),
                    margin_used=Decimal("0"), free_margin=Decimal("0"), margin_level=Decimal("0"),
                    leverage=leverage, currency="USD",
                    is_demo=False, is_active=True, is_promotional=True,
                    created_at=child.created_at or (now - timedelta(days=40)),
                )
                db.add(acct)
                await db.flush()
                logger.info("%s  %s: created account %s", tag, name, acct_number)
            else:
                logger.info("%s  %s: account %s exists", tag, name, acct.account_number)

            # ── 3. Random (>=3) closed trades ─────────────────────────────
            have = (await db.execute(
                select(func.count(Position.id)).where(
                    Position.account_id == acct.id, Position.status == PositionStatus.CLOSED
                )
            )).scalar() or 0
            if have >= MIN_TRADES:
                logger.info("%s  %s: already has %s closed trades — skipping", tag, name, have)
                continue

            n = RNG.randint(MIN_TRADES, MAX_TRADES)
            joined = child.created_at or (now - timedelta(days=40))
            window_days = max(3.0, (now - joined).total_seconds() / 86400.0 - 1)
            net = Decimal("0")
            for i in range(n):
                sym = RNG.choice(list(instruments.keys()))
                inst = instruments[sym]
                base, dec, (lmin, lmax) = SYMBOLS[sym]
                cs = Decimal(str(inst.contract_size or 100000))
                lots = _q(lmin + (lmax - lmin) * Decimal(str(RNG.random())), 3) or lmin
                op = _q(base * (Decimal("1") + Decimal(str(RNG.uniform(-0.02, 0.02)))), dec)
                pnl = Decimal(str(RNG.gauss(6.0, 22.0)))  # slight positive bias
                delta = pnl / (lots * cs)
                side = OrderSide.BUY if RNG.random() < 0.5 else OrderSide.SELL
                cp = _q(op + delta, dec) if side == OrderSide.BUY else _q(op - delta, dec)
                profit = profit_for(side, lots, op, cp, cs).quantize(Decimal("0.01"))
                days_ago = RNG.uniform(0.5, window_days)
                opened = now - timedelta(days=days_ago, hours=RNG.uniform(0, 6))
                closed = min(opened + timedelta(hours=RNG.uniform(2, 40)), now - timedelta(minutes=5))
                if closed <= opened:
                    closed = opened + timedelta(hours=1)
                pos = Position(
                    account_id=acct.id, instrument_id=inst.id, side=side,
                    status=PositionStatus.CLOSED, lots=lots, open_price=op, close_price=cp,
                    profit=profit, created_at=opened, closed_at=closed, comment=SEED_MARKER,
                )
                db.add(pos)
                await db.flush()
                db.add(TradeHistory(
                    position_id=pos.id, account_id=acct.id, instrument_id=inst.id,
                    side=side, lots=lots, open_price=op, close_price=cp,
                    profit=profit, opened_at=opened, closed_at=closed, close_reason="manual",
                ))
                net += profit

            # Give the account a small believable balance (base + net P&L).
            base_bal = Decimal(str(RNG.randint(150, 600)))
            acct.balance = base_bal + net
            acct.equity = acct.balance
            acct.free_margin = acct.balance
            acct.margin_level = Decimal("9999")
            logger.info("%s  %s: +%s closed trades (net $%s), balance $%s", tag, name, n,
                        net.quantize(Decimal("0.01")), acct.balance.quantize(Decimal("0.01")))

        if execute:
            await db.commit()
            logger.info("DONE — committed.")
        else:
            await db.rollback()
            logger.info("[dry-run] rolled back — nothing written. Re-run with --execute.")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Enrich promo downline: real emails + >=3 trades each.")
    p.add_argument("--execute", action="store_true", help="actually write (default: dry-run)")
    args = p.parse_args()
    asyncio.run(run(execute=args.execute))
