"""One-shot seeder: build a second promotional demo account that showcases a
LARGE ($100k) client — client request 2026-07-11.

Target user: prospertech.pro@gmail.com  (Us Bhardwaj)
  - is_promotional=True → excluded from real financials AND hidden from the
    admin panel (see the admin is_promotional filters), shows only on the
    trader side.
  - $100,000 live trading account, with a rich ~2-month history of trades
    sized to a $100k account (big lots), net a modest profit.
  - AI-POWERED STAKING PROGRAM: $30,000 locked (tenure "Year"), backdated.
  - Main wallet: $5,000. Believable deposit/withdrawal history.
  - Trade insurance on several trades — a few claimed, the rest expired.
  - 10 referred downline (real name-based emails), each with their own
    trading account + >=3 closed trades so the referral page shows "N / 3".
  - IB: approved IBProfile with $450 accrued IB commission from the downline.

SAFETY
  - DRY-RUN by default. Add --execute to write.
        python -m services.gateway.src.seed_prospertech_account            # dry-run
        python -m services.gateway.src.seed_prospertech_account --execute   # write
  - IDEMPOTENT: if the live trading account already exists the whole build is
    skipped, so a re-run never double-funds or duplicates.
  - Password comes from the SEED_USER_PASSWORD env var (never hardcoded):
        SEED_USER_PASSWORD='An@123412' python -m services.gateway.src.seed_prospertech_account --execute
  - Reproducible: a fixed RNG seed makes every run generate the same history.
"""
import argparse
import asyncio
import json
import logging
import os
import random
import secrets
import string
from decimal import Decimal, ROUND_HALF_UP
from datetime import datetime, timezone, timedelta

from sqlalchemy import select, func

from packages.common.src.database import AsyncSessionLocal
from packages.common.src.auth import hash_password
from packages.common.src.models import (
    User, AccountGroup, TradingAccount, Position, TradeHistory, Instrument,
    Transaction, Deposit, Withdrawal, InsurancePolicy, InsuranceClaim,
    IBProfile, IBApplication, IBCommission, Referral,
    PositionStatus, OrderSide, FixedReturnLock,
)
from packages.common.src.redis_client import redis_client, PriceChannel
from services.gateway.src.services.fixed_return_service import create_lock

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-5s %(message)s")
logger = logging.getLogger("seed-prospertech")

# ── Config ────────────────────────────────────────────────────────────────
TARGET_EMAIL = "prospertech.pro@gmail.com"
FIRST, LAST = "Us", "Bhardwaj"

TRADE_CAPITAL = Decimal("100000")   # live trading account balance (headline)
WALLET_FINAL = Decimal("5000")      # main wallet after everything
FR_PRINCIPAL = Decimal("30000")     # AI staking locked
FR_TENURE = "Year"
FR_DAYS_AGO = 40

HISTORY_DAYS = 62
NUM_TRADES = 52
TARGET_NET = Decimal("12000")       # net realized P&L of the seeded history
SEED_MARKER = "seed-prospertech"
RNG = random.Random(20260711)

IB_COMM_TARGET = Decimal("450")
REF_COMM_TARGET = Decimal("250")

# Money-movement history (days_ago, kind, amount, method). Processed oldest
# first; running wallet lands exactly on WALLET_FINAL.
MONEY_EVENTS = [
    (62, "deposit", Decimal("135000"), "bank"),          # initial capital
    (FR_DAYS_AGO, "staking", FR_PRINCIPAL, None),        # -> AI staking
    (39, "transfer", TRADE_CAPITAL, None),               # -> trading account
    (30, "deposit", Decimal("15000"), "crypto_usdt"),
    (20, "withdrawal", Decimal("15000"), "bank"),
]

# symbol -> (base_price, price_decimals, (lot_min, lot_max)) — sized for $100k.
SYMBOLS = {
    "EURUSD": (Decimal("1.08500"), 5, (Decimal("1.0"), Decimal("5.0"))),
    "GBPUSD": (Decimal("1.27000"), 5, (Decimal("1.0"), Decimal("4.0"))),
    "XAUUSD": (Decimal("2600.00"), 2, (Decimal("0.3"), Decimal("2.0"))),
    "BTCUSD": (Decimal("62000.00"), 2, (Decimal("0.05"), Decimal("0.30"))),
    "ETHUSD": (Decimal("3000.00"), 2, (Decimal("0.5"), Decimal("3.0"))),
}
PNL_SD = 650.0
PNL_MIN, PNL_MAX = Decimal("-3000"), Decimal("4000")

FALLBACK_PRICE = {
    "BTCUSD": Decimal("62000"), "ETHUSD": Decimal("3000"),
    "XAUUSD": Decimal("2600"), "EURUSD": Decimal("1.08000"), "GBPUSD": Decimal("1.27000"),
}
OPEN_TRADES = [
    ("XAUUSD", OrderSide.BUY, Decimal("1.0")),
    ("BTCUSD", OrderSide.BUY, Decimal("0.15")),
    ("EURUSD", OrderSide.BUY, Decimal("2.0")),
]
MAX_MARGIN_FRACTION = Decimal("0.20")

N_CLAIMED, N_EXPIRED = 4, 4
INS_FEE = Decimal("12.00")
INS_COVERAGE = Decimal("50.00")
INS_MAX_CAP = Decimal("1000.00")

# 10 downline: (email, first, last, ib_amount, days_ago). ib sums to 450.
DOWNLINE = [
    ("rajesh.malhotra82@gmail.com",   "Rajesh",  "Malhotra",  Decimal("55"), 60),
    ("sneha.kapoor29@yahoo.com",      "Sneha",   "Kapoor",    Decimal("40"), 54),
    ("amit.bansal47@gmail.com",       "Amit",    "Bansal",    Decimal("60"), 48),
    ("divya.menon15@outlook.com",     "Divya",   "Menon",     Decimal("35"), 43),
    ("karan.oberoi63@gmail.com",      "Karan",   "Oberoi",    Decimal("50"), 38),
    ("ritika.saxena38@gmail.com",     "Ritika",  "Saxena",    Decimal("45"), 32),
    ("naveen.pillai71@rediffmail.com","Naveen",  "Pillai",    Decimal("30"), 26),
    ("aarti.deshmukh54@gmail.com",    "Aarti",   "Deshmukh",  Decimal("55"), 20),
    ("sameer.khanna26@outlook.com",   "Sameer",  "Khanna",    Decimal("40"), 13),
    ("nikita.rao93@gmail.com",        "Nikita",  "Rao",       Decimal("40"), 7),
]
DL_MIN_TRADES, DL_MAX_TRADES = 3, 8


def _now():
    return datetime.now(timezone.utc)


def gen_code(n=8):
    return "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(n))


def _q(v: Decimal, dec: int) -> Decimal:
    return v.quantize(Decimal(1).scaleb(-dec), rounding=ROUND_HALF_UP)


def _q2(v: Decimal) -> Decimal:
    return v.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def profit_for(side, lots, op, cp, cs) -> Decimal:
    return (cp - op) * lots * cs if side == OrderSide.BUY else (op - cp) * lots * cs


async def live_mid(symbol: str):
    try:
        raw = await redis_client.get(PriceChannel.tick_key(symbol))
        if raw:
            d = json.loads(raw)
            return (Decimal(str(d["bid"])) + Decimal(str(d["ask"]))) / Decimal("2")
    except Exception as exc:  # noqa: BLE001
        logger.warning("live_mid(%s) failed: %s", symbol, exc)
    return None


async def unique_account_number(db) -> str:
    for _ in range(50):
        num = "8" + "".join(secrets.choice(string.digits) for _ in range(7))
        exists = (await db.execute(
            select(func.count(TradingAccount.id)).where(TradingAccount.account_number == num)
        )).scalar()
        if not exists:
            return num
    raise RuntimeError("could not allocate a unique account number")


async def _instruments(db):
    out = {}
    for sym in SYMBOLS:
        inst = (await db.execute(
            select(Instrument).where(func.upper(Instrument.symbol) == sym.upper())
        )).scalar_one_or_none()
        if inst is not None:
            out[sym] = inst
    return out


async def _make_trades(db, acct, instruments, n, joined, now, marker):
    """Create `n` random closed trades on `acct`. Returns net profit."""
    window_days = max(3.0, (now - joined).total_seconds() / 86400.0 - 1)
    net = Decimal("0")
    for _ in range(n):
        sym = RNG.choice(list(instruments.keys()))
        inst = instruments[sym]
        base, dec, (lmin, lmax) = SYMBOLS[sym]
        cs = Decimal(str(inst.contract_size or 100000))
        lots = _q(lmin + (lmax - lmin) * Decimal(str(RNG.random())), 2) or lmin
        op = _q(base * (Decimal("1") + Decimal(str(RNG.uniform(-0.02, 0.02)))), dec)
        pnl = Decimal(str(RNG.gauss(4.0, 18.0)))
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
            profit=profit, created_at=opened, closed_at=closed, comment=marker,
        )
        db.add(pos)
        await db.flush()
        db.add(TradeHistory(
            position_id=pos.id, account_id=acct.id, instrument_id=inst.id,
            side=side, lots=lots, open_price=op, close_price=cp,
            profit=profit, opened_at=opened, closed_at=closed, close_reason="manual",
        ))
        net += profit
    return net


async def run(execute: bool):
    tag = "" if execute else "[dry-run] "
    now = _now()
    period_start = now - timedelta(days=HISTORY_DAYS)
    async with AsyncSessionLocal() as db:
        # ── 1. Target user ────────────────────────────────────────────────
        main = (await db.execute(
            select(User).where(func.lower(User.email) == TARGET_EMAIL.lower())
        )).scalar_one_or_none()
        if main is None:
            pw = os.getenv("SEED_USER_PASSWORD")
            if not pw:
                raise SystemExit(
                    "User does not exist and SEED_USER_PASSWORD is not set. Re-run e.g.:\n"
                    "  SEED_USER_PASSWORD='...' python -m services.gateway.src.seed_prospertech_account --execute"
                )
            main = User(
                email=TARGET_EMAIL, password_hash=hash_password(pw),
                first_name=FIRST, last_name=LAST, role="user", status="active",
                kyc_status="approved", email_verified=True, email_verified_at=now,
                is_promotional=True, referral_code=gen_code(),
                main_wallet_balance=Decimal("0"), created_at=period_start,
            )
            db.add(main)
            await db.flush()
            logger.info("%screated user %s (id=%s)", tag, TARGET_EMAIL, main.id)
        else:
            main.is_promotional = True
            main.kyc_status = "approved"
            main.email_verified = True
            main.first_name = main.first_name or FIRST
            main.last_name = main.last_name or LAST
            # If a password is provided, (re)set it so the client can log in
            # with the shared credentials even for a pre-existing account.
            pw = os.getenv("SEED_USER_PASSWORD")
            if pw:
                main.password_hash = hash_password(pw)
                logger.info("%s(re)set password for existing user", tag)
            if not main.referral_code:
                main.referral_code = gen_code()
            if main.created_at is None or main.created_at > period_start:
                main.created_at = period_start
            logger.info("%sfound user %s (id=%s)", tag, TARGET_EMAIL, main.id)

        # ── Idempotency: skip if a live trading account already exists ────
        existing = (await db.execute(
            select(TradingAccount).where(
                TradingAccount.user_id == main.id,
                TradingAccount.is_demo == False,  # noqa: E712
            )
        )).scalars().first()
        if existing is not None:
            logger.info("%slive trading account already exists (%s) — full build skipped.",
                        tag, existing.account_number)
            if execute:
                await db.commit()
            else:
                await db.rollback()
            return

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
        instruments = await _instruments(db)
        if not instruments:
            raise SystemExit("no seed instruments exist.")

        # ── 2. Money events (chronological) ───────────────────────────────
        acct = None
        running = Decimal("0")
        for days_ago, kind, amount, method in sorted(MONEY_EVENTS, key=lambda e: -e[0]):
            when = now - timedelta(days=days_ago, hours=RNG.uniform(0, 6))
            if kind == "deposit":
                running += amount
                main.main_wallet_balance = running
                db.add(Deposit(
                    user_id=main.id, account_id=None, amount=amount, currency="USD",
                    method=method, status="approved", approved_by=main.id, approved_at=when,
                    transaction_id=f"SEED-{secrets.token_hex(4).upper()}",
                    crypto_tx_hash=("0x" + secrets.token_hex(20)) if method and method.startswith("crypto") else None,
                    created_at=when,
                ))
                db.add(Transaction(
                    user_id=main.id, account_id=None, type="deposit", amount=amount,
                    balance_after=running, description=f"Deposit via {method}", created_at=when,
                ))
                logger.info("%s  +deposit $%s via %s -> wallet $%s", tag, amount, method, running)
            elif kind == "withdrawal":
                running -= amount
                main.main_wallet_balance = running
                db.add(Withdrawal(
                    user_id=main.id, account_id=None, amount=amount, currency="USD",
                    method=method, status="completed", approved_by=main.id,
                    approved_at=when, completed_at=when + timedelta(hours=1),
                    payout_batch_id=f"SEED-{secrets.token_hex(4).upper()}",
                    crypto_address=("0x" + secrets.token_hex(20)) if method and method.startswith("crypto") else None,
                    created_at=when,
                ))
                db.add(Transaction(
                    user_id=main.id, account_id=None, type="withdrawal", amount=-amount,
                    balance_after=running, description=f"Withdrawal via {method}", created_at=when,
                ))
                logger.info("%s  -withdrawal $%s via %s -> wallet $%s", tag, amount, method, running)
            elif kind == "staking":
                if not execute:
                    logger.info("%s  would lock $%s into AI staking (%s)", tag, amount, FR_TENURE)
                    running -= amount
                    continue
                await create_lock(main.id, amount, FR_TENURE, db, acknowledge_bonus_forfeit=True)
                running -= amount
                lock = (await db.execute(
                    select(FixedReturnLock).where(
                        FixedReturnLock.user_id == main.id, FixedReturnLock.principal == amount,
                        FixedReturnLock.state == "active",
                    ).order_by(FixedReturnLock.locked_at.desc())
                )).scalars().first()
                if lock is not None:
                    dur_mat = (lock.matures_at - lock.locked_at) if lock.matures_at else None
                    dur_np = (lock.next_payout_at - lock.locked_at) if lock.next_payout_at else None
                    lock.locked_at = when
                    if dur_mat:
                        lock.matures_at = when + dur_mat
                    if dur_np:
                        np_at = when + dur_np
                        if np_at <= now + timedelta(days=1):
                            np_at = now + timedelta(days=25)
                        lock.next_payout_at = np_at
                    txn = (await db.execute(
                        select(Transaction).where(
                            Transaction.user_id == main.id, Transaction.type == "fixed_return_lock",
                            Transaction.amount == -amount,
                        ).order_by(Transaction.created_at.desc())
                    )).scalars().first()
                    if txn is not None:
                        txn.created_at = when
                logger.info("%s  staked $%s (backdated %s) -> wallet $%s", tag, amount, when.date(), running)
            elif kind == "transfer":
                running -= amount
                main.main_wallet_balance = running
                acct_number = await unique_account_number(db)
                acct = TradingAccount(
                    user_id=main.id, account_group_id=group.id, account_number=acct_number,
                    balance=amount, credit=Decimal("0"), equity=amount,
                    margin_used=Decimal("0"), free_margin=amount, margin_level=Decimal("0"),
                    leverage=leverage, currency="USD",
                    is_demo=False, is_active=True, is_promotional=True, created_at=when,
                )
                db.add(acct)
                await db.flush()
                db.add(Transaction(
                    user_id=main.id, account_id=acct.id, type="transfer", amount=-amount,
                    balance_after=running, description=f"Transfer to trading account {acct_number}",
                    created_at=when,
                ))
                db.add(Transaction(
                    user_id=main.id, account_id=acct.id, type="transfer", amount=amount,
                    balance_after=amount, description="Trading capital", created_at=when,
                ))
                logger.info("%s  transfer $%s -> trading %s (wallet $%s)", tag, amount, acct_number, running)

        if acct is None:
            raise SystemExit("trading account was not created (transfer event missing).")

        # ── 3. Closed-trade history, net pinned to TARGET_NET ─────────────
        available = list(instruments.keys())
        slice_days = HISTORY_DAYS / NUM_TRADES
        specs = []
        for i in range(NUM_TRADES):
            sym = RNG.choice(available)
            inst = instruments[sym]
            base, dec, (lmin, lmax) = SYMBOLS[sym]
            cs = Decimal(str(inst.contract_size or 100000))
            days_ago = max(0.4, HISTORY_DAYS - (i * slice_days) - RNG.uniform(0, slice_days))
            opened = now - timedelta(days=days_ago, hours=RNG.uniform(0, 6))
            closed = min(opened + timedelta(hours=RNG.uniform(2, 54)), now - timedelta(minutes=5))
            if closed <= opened:
                closed = opened + timedelta(hours=1)
            side = OrderSide.BUY if RNG.random() < 0.5 else OrderSide.SELL
            lots = _q(lmin + (lmax - lmin) * Decimal(str(RNG.random())), 2) or lmin
            op = _q(base * (Decimal("1") + Decimal(str(RNG.uniform(-0.02, 0.02)))), dec)
            raw = Decimal(str(RNG.gauss(0.0, PNL_SD)))
            specs.append([inst, dec, cs, side, lots, op, raw, opened, closed])
        adjust = (TARGET_NET - sum(s[6] for s in specs)) / Decimal(NUM_TRADES)
        net = Decimal("0")
        wins = losses = 0
        closed_positions = []
        for inst, dec, cs, side, lots, op, raw, opened, closed in specs:
            pnl = max(PNL_MIN, min(PNL_MAX, raw + adjust))
            delta = pnl / (lots * cs)
            cp = _q(op + delta, dec) if side == OrderSide.BUY else _q(op - delta, dec)
            profit = profit_for(side, lots, op, cp, cs).quantize(Decimal("0.01"))
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
            closed_positions.append(pos)
            net += profit
            wins += 1 if profit >= 0 else 0
            losses += 1 if profit < 0 else 0
        logger.info("%s%s closed trades (wins=%s losses=%s) net $%s", tag, NUM_TRADES, wins, losses, _q2(net))

        # ── 4. Open positions (live floating P&L) ─────────────────────────
        margin_used = Decimal("0")
        for sym, side, lots in OPEN_TRADES:
            inst = instruments.get(sym)
            if inst is None:
                continue
            cs = Decimal(str(inst.contract_size or 100000))
            px = await live_mid(sym) or FALLBACK_PRICE.get(sym)
            if px is None:
                continue
            px = px.quantize(Decimal("0.00001"))
            margin = (lots * cs * px) / Decimal(str(acct.leverage))
            if margin > TRADE_CAPITAL * MAX_MARGIN_FRACTION:
                logger.warning("%s  skip open %s (margin $%s too big)", tag, sym, _q2(margin))
                continue
            pos = Position(
                account_id=acct.id, instrument_id=inst.id, side=side,
                status=PositionStatus.OPEN, lots=lots, open_price=px,
                profit=Decimal("0"), created_at=now - timedelta(days=RNG.uniform(0.5, 4)), comment=SEED_MARKER,
            )
            db.add(pos)
            await db.flush()
            margin_used += margin
            logger.info("%s  open %s %s %s lots @ %s (margin $%s)", tag, sym, side.value, lots, px, _q2(margin))

        # ── 5. Insurance on some closed trades ────────────────────────────
        losses_pos = [p for p in closed_positions if (p.profit or Decimal("0")) < 0]
        wins_pos = [p for p in closed_positions if (p.profit or Decimal("0")) >= 0]
        credit_added = Decimal("0")
        for p in losses_pos[:N_CLAIMED]:
            loss = abs(p.profit or Decimal("0"))
            claim_amt = _q2(min(loss * (INS_COVERAGE / Decimal("100")), INS_MAX_CAP))
            pol = InsurancePolicy(
                user_id=main.id, account_id=acct.id, position_id=p.id,
                instrument_id=p.instrument_id, tier="50%", fee=INS_FEE,
                coverage_pct=INS_COVERAGE, max_cap=INS_MAX_CAP, risk_score=Decimal("5.0000"),
                status="claimed", activated_at=p.created_at, settled_at=p.closed_at,
            )
            db.add(pol)
            await db.flush()
            credit_added += claim_amt
            tx = Transaction(
                user_id=main.id, account_id=acct.id, type="insurance_payout",
                amount=claim_amt, balance_after=TRADE_CAPITAL,
                description="Trade insurance claim payout", created_at=p.closed_at,
            )
            db.add(tx)
            await db.flush()
            db.add(InsuranceClaim(
                policy_id=pol.id, user_id=main.id, loss_amount=loss, claim_amount=claim_amt,
                transaction_id=tx.id, status="paid", claimed_at=p.closed_at, paid_at=p.closed_at,
            ))
        for p in wins_pos[:N_EXPIRED]:
            db.add(InsurancePolicy(
                user_id=main.id, account_id=acct.id, position_id=p.id,
                instrument_id=p.instrument_id, tier="50%", fee=INS_FEE,
                coverage_pct=INS_COVERAGE, max_cap=INS_MAX_CAP, risk_score=Decimal("5.0000"),
                status="expired", activated_at=p.created_at, settled_at=p.closed_at,
                settled_reason="not_a_loss",
            ))
        logger.info("%sinsurance: %s claimed (credit +$%s), %s expired",
                    tag, min(N_CLAIMED, len(losses_pos)), _q2(credit_added), min(N_EXPIRED, len(wins_pos)))

        # ── 6. Pin trading account to $100,000 + recompute margin ─────────
        acct.balance = TRADE_CAPITAL
        acct.credit = _q2(credit_added)
        acct.margin_used = margin_used
        acct.equity = TRADE_CAPITAL + acct.credit
        acct.free_margin = acct.equity - margin_used
        acct.margin_level = (acct.equity / margin_used * Decimal("100")) if margin_used > 0 else Decimal("9999")
        logger.info("%strading balance $%s (credit $%s, margin $%s, equity $%s)",
                    tag, TRADE_CAPITAL, acct.credit, _q2(margin_used), _q2(acct.equity))

        # ── 7. IB profile ─────────────────────────────────────────────────
        ib = (await db.execute(select(IBProfile).where(IBProfile.user_id == main.id))).scalar_one_or_none()
        if ib is None:
            ib = IBProfile(
                user_id=main.id, referral_code=main.referral_code or gen_code(),
                parent_ib_id=None, level=1, is_active=True,
                total_earned=Decimal("0"), pending_payout=Decimal("0"),
                created_at=period_start,
            )
            db.add(ib)
            await db.flush()
            db.add(IBApplication(user_id=main.id, status="approved", approved_at=period_start + timedelta(days=1)))
            logger.info("%sIB profile created + approved (code=%s)", tag, ib.referral_code)

        # ── 8. Downline (real emails) + Referral + IBCommission + trades ──
        for email, fn, ln, ib_amt, days_ago in DOWNLINE:
            exists = (await db.execute(
                select(User).where(func.lower(User.email) == email.lower())
            )).scalar_one_or_none()
            if exists is not None:
                logger.info("%s  downline %s exists — skipping", tag, email)
                continue
            when = now - timedelta(days=days_ago, hours=6)
            child = User(
                email=email, password_hash=hash_password(secrets.token_urlsafe(12)),
                first_name=fn, last_name=ln, role="user", status="active",
                kyc_status="approved", email_verified=True, email_verified_at=when,
                is_promotional=True, referral_code=gen_code(),
                referred_by_user_id=main.id,
                referral_qualified_at=when + timedelta(days=2),
                referral_claimed_at=when + timedelta(days=3),
                main_wallet_balance=Decimal("0"), created_at=when,
            )
            db.add(child)
            await db.flush()
            db.add(Referral(referrer_id=main.id, referred_id=child.id, ib_profile_id=ib.id,
                            created_at=when + timedelta(days=1)))
            db.add(IBCommission(
                ib_id=ib.id, source_user_id=child.id, amount=ib_amt,
                mlm_level=1, status="paid", commission_type="trade",
                created_at=when + timedelta(days=4),
            ))
            # Their own trading account + >=3 closed trades (referral shows N/3).
            c_acct = TradingAccount(
                user_id=child.id, account_group_id=group.id,
                account_number=await unique_account_number(db),
                balance=Decimal("0"), credit=Decimal("0"), equity=Decimal("0"),
                margin_used=Decimal("0"), free_margin=Decimal("0"), margin_level=Decimal("0"),
                leverage=leverage, currency="USD",
                is_demo=False, is_active=True, is_promotional=True, created_at=when,
            )
            db.add(c_acct)
            await db.flush()
            n = RNG.randint(DL_MIN_TRADES, DL_MAX_TRADES)
            c_net = await _make_trades(db, c_acct, instruments, n, when, now, "seed-downline")
            base_bal = Decimal(str(RNG.randint(300, 1500)))
            c_acct.balance = base_bal + c_net
            c_acct.equity = c_acct.balance
            c_acct.free_margin = c_acct.balance
            c_acct.margin_level = Decimal("9999")
            logger.info("%s  + downline %s (ib $%s, %s trades)", tag, email, ib_amt, n)

        # ── 9. Commission balances + final wallet ─────────────────────────
        main.ib_commission_balance = IB_COMM_TARGET
        main.referral_commission_balance = REF_COMM_TARGET
        ib.total_earned = IB_COMM_TARGET
        main.main_wallet_balance = WALLET_FINAL
        logger.info("%sib_commission=$%s referral_commission=$%s wallet=$%s",
                    tag, IB_COMM_TARGET, REF_COMM_TARGET, WALLET_FINAL)

        if execute:
            await db.commit()
            logger.info("DONE — committed. %s ready.", TARGET_EMAIL)
        else:
            await db.rollback()
            logger.info("[dry-run] rolled back — nothing written. Re-run with --execute.")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Seed the $100k promotional demo account (Us Bhardwaj).")
    p.add_argument("--execute", action="store_true", help="actually write (default: dry-run)")
    args = p.parse_args()
    asyncio.run(run(execute=args.execute))
