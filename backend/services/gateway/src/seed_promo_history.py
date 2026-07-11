"""Second-pass seeder: give the promotional demo account a RICH, believable
~2-month HISTORY so nothing about it reads as freshly-seeded or fake.

The base seeder (seed_promo_account.py) creates the account + FR lock +
trading account + a few trades, but everything is dated within the last few
days. This script layers a coherent two-month story on top:

  1. Ages the account — user.created_at (and the downline) moved back ~2 months.
  2. De-clusters the base seeder's rows — funding / transfer / FR-lock ledger
     entries re-dated to the START of the period instead of "today".
  3. ~48 CLOSED trades spread across ~62 days (mixed win/loss) with the NET
     P&L pinned to a modest PROFIT (TARGET_NET) so the showcase looks healthy.
  4. Deposit + withdrawal HISTORY — approved Deposit + completed Withdrawal
     rows (crypto/bank/UPI) + matching ledger transactions, wallet moved by the
     exact net and balance_after replayed forward.
  5. Spreads the referral / IB commission timestamps across the period.
  6. Anchors the active FR lock to a fixed date shortly AFTER the account was
     created (durations preserved) so "Interest accrued" shows a real value and
     the lock never predates the account.

SAFETY
  - DRY-RUN by default. Add --execute to write.
        python -m services.gateway.src.seed_promo_history            # dry-run
        python -m services.gateway.src.seed_promo_history --execute   # write
  - --reset removes everything THIS script seeded (trades, deposits,
    withdrawals) and reverses the balances, so you can re-run cleanly:
        python -m services.gateway.src.seed_promo_history --reset --execute
        python -m services.gateway.src.seed_promo_history --execute
  - IDEMPOTENT: tags trades comment='seed-history' and returns immediately if
    any exist (unless --reset). Requires the base account to exist first.
  - Reproducible: a fixed RNG seed makes every run generate the same history.
"""
import argparse
import asyncio
import logging
import random
import secrets
from decimal import Decimal, ROUND_HALF_UP
from datetime import datetime, timezone, timedelta

from sqlalchemy import select, func, delete, or_

from packages.common.src.database import AsyncSessionLocal
from packages.common.src.models import (
    User, TradingAccount, Position, TradeHistory, Instrument, Transaction,
    Deposit, Withdrawal, IBCommission, Referral, PositionStatus, OrderSide,
    FixedReturnLock,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-5s %(message)s")
logger = logging.getLogger("seed-promo-history")

# ── Config ──────────────────────────────────────────────────────────────────
TARGET_EMAIL = "amardeepsonar2001@gmail.com"
HISTORY_DAYS = 62
NUM_TRADES = 48
FR_LOCK_DAY = 2                   # FR locked this many days after account creation
SEED_MARKER = "seed-history"
DEP_DESC = "Deposit via "         # ledger description prefix for seeded deposits
WD_DESC = "Withdrawal via "       # ledger description prefix for seeded withdrawals
TARGET_NET = Decimal("320")       # net realized P&L of the seeded trades (a profit)
RNG = random.Random(20260707)

# symbol -> (base_price, price_decimals, (lot_min, lot_max))
SYMBOLS = {
    "EURUSD": (Decimal("1.08500"), 5, (Decimal("0.02"), Decimal("0.10"))),
    "GBPUSD": (Decimal("1.27000"), 5, (Decimal("0.02"), Decimal("0.10"))),
    "XAUUSD": (Decimal("2600.00"), 2, (Decimal("0.01"), Decimal("0.05"))),
    "BTCUSD": (Decimal("62000.00"), 2, (Decimal("0.005"), Decimal("0.02"))),
    "ETHUSD": (Decimal("3000.00"), 2, (Decimal("0.02"), Decimal("0.08"))),
}
PNL_SD = 24.0
PNL_MIN, PNL_MAX = Decimal("-80"), Decimal("120")

DEPOSITS = [
    (58, Decimal("1200"), "crypto_usdt"),
    (44, Decimal("600"),  "bank"),
    (16, Decimal("400"),  "upi"),
]
WITHDRAWALS = [
    (30, Decimal("800"),  "bank"),
    (6,  Decimal("1200"), "crypto_usdt"),
]


def _now():
    return datetime.now(timezone.utc)


def _q(value: Decimal, decimals: int) -> Decimal:
    return value.quantize(Decimal(1).scaleb(-decimals), rounding=ROUND_HALF_UP)


def profit_for(side, lots, open_price, close_price, contract_size) -> Decimal:
    if side == OrderSide.BUY:
        return (close_price - open_price) * lots * contract_size
    return (open_price - close_price) * lots * contract_size


async def _find_account(db):
    main = (await db.execute(
        select(User).where(func.lower(User.email) == TARGET_EMAIL.lower())
    )).scalar_one_or_none()
    if main is None:
        raise SystemExit(f"User {TARGET_EMAIL} does not exist. Run seed_promo_account.py first.")
    acct = (await db.execute(
        select(TradingAccount).where(
            TradingAccount.user_id == main.id,
            TradingAccount.is_demo == False,  # noqa: E712
        ).order_by(TradingAccount.created_at)
    )).scalars().first()
    if acct is None:
        raise SystemExit(f"{TARGET_EMAIL} has no live trading account. Run seed_promo_account.py first.")
    return main, acct


async def reset(execute: bool):
    """Undo everything this script seeded so it can be re-run cleanly."""
    tag = "" if execute else "[dry-run] "
    async with AsyncSessionLocal() as db:
        main, acct = await _find_account(db)

        # Seeded trades → reverse their net P&L, then delete.
        seed_pos = (await db.execute(
            select(Position).where(
                Position.account_id == acct.id, Position.comment == SEED_MARKER
            )
        )).scalars().all()
        profit_sum = sum((p.profit or Decimal("0")) for p in seed_pos)
        pos_ids = [p.id for p in seed_pos]
        if pos_ids:
            await db.execute(delete(TradeHistory).where(TradeHistory.position_id.in_(pos_ids)))
            await db.execute(delete(Position).where(Position.id.in_(pos_ids)))
        acct.balance = (acct.balance or Decimal("0")) - profit_sum
        mu = acct.margin_used or Decimal("0")
        acct.equity = (acct.balance or Decimal("0")) + (acct.credit or Decimal("0"))
        acct.free_margin = acct.equity - mu
        acct.margin_level = (acct.equity / mu * Decimal("100")) if mu > 0 else Decimal("9999")

        # Seeded deposit/withdrawal ledger rows → reverse wallet, then delete.
        seed_txns = (await db.execute(
            select(Transaction).where(
                Transaction.user_id == main.id,
                or_(Transaction.description.like(DEP_DESC + "%"),
                    Transaction.description.like(WD_DESC + "%")),
            )
        )).scalars().all()
        wallet_delta = sum((t.amount or Decimal("0")) for t in seed_txns)
        main.main_wallet_balance = (main.main_wallet_balance or Decimal("0")) - wallet_delta
        if seed_txns:
            await db.execute(delete(Transaction).where(
                Transaction.id.in_([t.id for t in seed_txns])
            ))
        # Seeded Deposit rows (marked) + the completed Withdrawals on this account.
        await db.execute(delete(Deposit).where(
            Deposit.user_id == main.id, Deposit.transaction_id.like("SEED-%")
        ))
        await db.execute(delete(Withdrawal).where(
            Withdrawal.user_id == main.id, Withdrawal.status == "completed"
        ))

        logger.info("%sreset: removed %s trades (net $%s), %s wallet txns (net $%s)",
                    tag, len(seed_pos), profit_sum.quantize(Decimal("0.01")),
                    len(seed_txns), wallet_delta.quantize(Decimal("0.01")))
        if execute:
            await db.commit()
            logger.info("reset committed. Re-run with --execute to re-seed.")
        else:
            await db.rollback()
            logger.info("[dry-run] reset rolled back — nothing changed.")


async def run(execute: bool):
    tag = "" if execute else "[dry-run] "
    now = _now()
    period_start = now - timedelta(days=HISTORY_DAYS)
    async with AsyncSessionLocal() as db:
        main, acct = await _find_account(db)
        logger.info("%starget %s  account=%s  balance=$%s  wallet=$%s", tag, TARGET_EMAIL,
                    acct.account_number, (acct.balance or Decimal('0')).quantize(Decimal('0.01')),
                    (main.main_wallet_balance or Decimal('0')).quantize(Decimal('0.01')))

        already = (await db.execute(
            select(func.count(Position.id)).where(
                Position.account_id == acct.id, Position.comment == SEED_MARKER
            )
        )).scalar() or 0
        if already > 0:
            logger.info("%shistory already seeded (%s tagged trades). Use --reset first to redo.", tag, already)
            return

        # ── 1. Age the account ────────────────────────────────────────────
        main.created_at = period_start
        logger.info("%sage account: created_at -> %s", tag, period_start.date())
        downline = (await db.execute(
            select(User).where(User.referred_by_user_id == main.id)
        )).scalars().all()
        for i, child in enumerate(downline):
            child.created_at = now - timedelta(days=55 - i * 8, hours=RNG.uniform(0, 12))
            child.referral_qualified_at = child.created_at + timedelta(days=2)
            child.referral_claimed_at = child.created_at + timedelta(days=3)

        # ── 2. De-cluster the base seeder's ledger ────────────────────────
        base_txns = (await db.execute(
            select(Transaction).where(Transaction.user_id == main.id)
        )).scalars().all()
        for t in base_txns:
            desc = (t.description or "").lower()
            if t.type == "deposit" and "funding" in desc:
                t.created_at = period_start
            elif t.type == "fixed_return_lock":
                t.created_at = period_start + timedelta(days=FR_LOCK_DAY)
            elif t.type == "transfer":
                t.created_at = period_start + timedelta(days=1, hours=2)
            elif t.type == "insurance_fee":
                t.created_at = now - timedelta(days=2)
        logger.info("%sre-dated %s base ledger rows", tag, len(base_txns))

        # ── 3. Closed trades — net pinned to a profit (TARGET_NET) ────────
        available: dict[str, Instrument] = {}
        for sym in SYMBOLS:
            inst = (await db.execute(
                select(Instrument).where(func.upper(Instrument.symbol) == sym.upper())
            )).scalar_one_or_none()
            if inst is not None:
                available[sym] = inst
        if not available:
            raise SystemExit("none of the seed symbols exist as instruments — cannot seed trades.")

        # Pass 1: draw every random input (keeps the RNG sequence deterministic).
        slice_days = HISTORY_DAYS / NUM_TRADES
        specs = []
        for i in range(NUM_TRADES):
            sym = RNG.choice(list(available.keys()))
            inst = available[sym]
            base, dec, (lmin, lmax) = SYMBOLS[sym]
            cs = Decimal(str(inst.contract_size or 100000))
            days_ago = max(0.4, HISTORY_DAYS - (i * slice_days) - RNG.uniform(0, slice_days))
            opened_at = now - timedelta(days=days_ago, hours=RNG.uniform(0, 6))
            closed_at = min(opened_at + timedelta(hours=RNG.uniform(2, 54)), now - timedelta(minutes=5))
            if closed_at <= opened_at:
                closed_at = opened_at + timedelta(hours=1)
            side = OrderSide.BUY if RNG.random() < 0.5 else OrderSide.SELL
            lots = _q(lmin + (lmax - lmin) * Decimal(str(RNG.random())), 3) or lmin
            open_price = _q(base * (Decimal("1") + Decimal(str(RNG.uniform(-0.02, 0.02)))), dec)
            raw_pnl = Decimal(str(RNG.gauss(0.0, PNL_SD)))
            specs.append([inst, dec, cs, side, lots, open_price, raw_pnl, opened_at, closed_at])

        # Shift every trade's P&L by a constant so the NET equals TARGET_NET.
        adjust = (TARGET_NET - sum(s[6] for s in specs)) / Decimal(NUM_TRADES)

        # Pass 2: derive close_price from the adjusted P&L, write the rows.
        net = Decimal("0")
        wins = losses = 0
        for inst, dec, cs, side, lots, open_price, raw_pnl, opened_at, closed_at in specs:
            pnl = max(PNL_MIN, min(PNL_MAX, raw_pnl + adjust))
            delta = pnl / (lots * cs)
            close_price = _q(open_price + delta, dec) if side == OrderSide.BUY else _q(open_price - delta, dec)
            profit = profit_for(side, lots, open_price, close_price, cs).quantize(Decimal("0.01"))
            pos = Position(
                account_id=acct.id, instrument_id=inst.id, side=side,
                status=PositionStatus.CLOSED, lots=lots,
                open_price=open_price, close_price=close_price,
                profit=profit, created_at=opened_at, closed_at=closed_at, comment=SEED_MARKER,
            )
            db.add(pos)
            await db.flush()
            db.add(TradeHistory(
                position_id=pos.id, account_id=acct.id, instrument_id=inst.id,
                side=side, lots=lots, open_price=open_price, close_price=close_price,
                profit=profit, opened_at=opened_at, closed_at=closed_at, close_reason="manual",
            ))
            net += profit
            wins += 1 if profit >= 0 else 0
            losses += 1 if profit < 0 else 0

        acct.balance = (acct.balance or Decimal("0")) + net
        mu = acct.margin_used or Decimal("0")
        acct.equity = (acct.balance or Decimal("0")) + (acct.credit or Decimal("0"))
        acct.free_margin = acct.equity - mu
        acct.margin_level = (acct.equity / mu * Decimal("100")) if mu > 0 else Decimal("9999")
        logger.info("%screated %s trades (wins=%s losses=%s) net=$%s  acct balance -> $%s",
                    tag, NUM_TRADES, wins, losses, net.quantize(Decimal("0.01")),
                    acct.balance.quantize(Decimal("0.01")))

        # ── 4. Deposit + withdrawal history ───────────────────────────────
        events = [(d, amt, m, "deposit") for (d, amt, m) in DEPOSITS] + \
                 [(d, amt, m, "withdrawal") for (d, amt, m) in WITHDRAWALS]
        events.sort(key=lambda e: -e[0])
        running = main.main_wallet_balance or Decimal("0")
        for days_ago, amount, method, kind in events:
            when = now - timedelta(days=days_ago, hours=RNG.uniform(0, 8))
            if kind == "deposit":
                running += amount
                db.add(Deposit(
                    user_id=main.id, account_id=None, amount=amount, currency="USD",
                    method=method, status="approved", approved_by=main.id, approved_at=when,
                    transaction_id=f"SEED-{secrets.token_hex(4).upper()}",
                    crypto_tx_hash=("0x" + secrets.token_hex(20)) if method.startswith("crypto") else None,
                    created_at=when,
                ))
                db.add(Transaction(
                    user_id=main.id, account_id=None, type="deposit", amount=amount,
                    balance_after=running, description=f"{DEP_DESC}{method}", created_at=when,
                ))
            else:
                running -= amount
                db.add(Withdrawal(
                    user_id=main.id, account_id=None, amount=amount, currency="USD",
                    method=method, status="completed", approved_by=main.id,
                    approved_at=when, completed_at=when + timedelta(hours=1),
                    payout_batch_id=f"SEED-{secrets.token_hex(4).upper()}",
                    crypto_address=("0x" + secrets.token_hex(20)) if method.startswith("crypto") else None,
                    created_at=when,
                ))
                db.add(Transaction(
                    user_id=main.id, account_id=None, type="withdrawal", amount=-amount,
                    balance_after=running, description=f"{WD_DESC}{method}", created_at=when,
                ))
        main.main_wallet_balance = running
        logger.info("%sdeposits=%s withdrawals=%s  wallet -> $%s", tag, len(DEPOSITS),
                    len(WITHDRAWALS), running.quantize(Decimal("0.01")))

        # ── 5. Spread referral / IB commission timestamps ─────────────────
        ib_comms = []
        if downline:
            ib_comms = (await db.execute(
                select(IBCommission).where(
                    IBCommission.source_user_id.in_([c.id for c in downline])
                )
            )).scalars().all()
        for i, c in enumerate(ib_comms):
            c.created_at = now - timedelta(days=50 - i * 7, hours=RNG.uniform(0, 12))
        refs = (await db.execute(
            select(Referral).where(Referral.referrer_id == main.id)
        )).scalars().all()
        for i, r in enumerate(refs):
            r.created_at = now - timedelta(days=52 - i * 7, hours=RNG.uniform(0, 12))
        logger.info("%sspread %s IB commissions + %s referrals", tag, len(ib_comms), len(refs))

        # ── 6. Anchor the FR lock to a fixed date AFTER account creation ──
        lock = (await db.execute(
            select(FixedReturnLock).where(
                FixedReturnLock.user_id == main.id, FixedReturnLock.state == "active",
            ).order_by(FixedReturnLock.locked_at)
        )).scalars().first()
        if lock is None:
            logger.info("%sno active FR lock — skipping FR anchor", tag)
        else:
            target = period_start + timedelta(days=FR_LOCK_DAY)
            dur_mat = (lock.matures_at - lock.locked_at) if lock.matures_at else None
            dur_np = (lock.next_payout_at - lock.locked_at) if lock.next_payout_at else None
            lock.locked_at = target
            if dur_mat:
                lock.matures_at = target + dur_mat
            if dur_np:
                np = target + dur_np
                if np <= now + timedelta(days=1):
                    np = now + timedelta(days=30)
                lock.next_payout_at = np
            logger.info("%sFR lock $%s anchored to %s (matures %s, next payout %s)",
                        tag, lock.principal, target.date(),
                        lock.matures_at.date() if lock.matures_at else "?",
                        lock.next_payout_at.date() if lock.next_payout_at else "?")

        if execute:
            await db.commit()
            logger.info("DONE — committed. %s now has a full ~2-month history.", TARGET_EMAIL)
        else:
            await db.rollback()
            logger.info("[dry-run] rolled back — no changes written. Re-run with --execute to apply.")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Seed a full ~2-month history onto the promo demo account.")
    p.add_argument("--execute", action="store_true", help="actually write (default: dry-run)")
    p.add_argument("--reset", action="store_true", help="remove previously-seeded history (reverse balances)")
    args = p.parse_args()
    if args.reset:
        asyncio.run(reset(execute=args.execute))
    else:
        asyncio.run(run(execute=args.execute))
