"""One-off: backdate the promotional account's seeded records so the history
reads like a real account aged over the last ~60 days, instead of everything
timestamped on seed day.

Spreads, for amardeepsonar2001@gmail.com:
  - Transactions (deposit / FR lock / transfers / insurance fee) across the window
  - the AI-POWERED STAKING PROGRAM lock's locked_at + matures_at (payout stays in the future,
    so the interest engine does NOT do a catch-up run)
  - CLOSED positions + their TradeHistory rows, spaced through the window
  - the insurance policy's activated_at
  - OPEN positions to a few days ago (kept recent so live floating P&L reads sensibly)
  - demo downline users + their Referral / IBCommission rows, spaced through the window

DRY-RUN by default; --execute to write. Idempotent-ish: re-running just re-stamps
the same rows to the same computed dates.
    python -m services.gateway.src.backdate_promo_history
    python -m services.gateway.src.backdate_promo_history --execute
"""
import argparse
import asyncio
import logging
from datetime import datetime, timezone, timedelta

from sqlalchemy import select, func

from packages.common.src.database import AsyncSessionLocal
from packages.common.src.models import (
    User, TradingAccount, Transaction, FixedReturnLock, Position, TradeHistory,
    InsurancePolicy, IBCommission, Referral, PositionStatus,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-5s %(message)s")
logger = logging.getLogger("backdate-promo")

TARGET_EMAIL = "amardeepsonar2001@gmail.com"
WINDOW_DAYS = 60


def _at(start: datetime, day: int, hour: int = 10) -> datetime:
    return (start + timedelta(days=day)).replace(hour=hour, minute=0, second=0, microsecond=0)


# Fixed date offsets (days from window start) per transaction type/description.
def _txn_day(txn: Transaction) -> int:
    t = (txn.type or "").lower()
    d = (txn.description or "").lower()
    if t == "deposit":
        return 0
    if t in ("fixed_return_lock", "fixed_return_lock_admin", "bonus_forfeit", "bonus"):
        return 1
    if t == "transfer":
        return 1
    if t == "insurance_fee":
        return 45
    if t == "referral_commission":
        return 20
    if t in ("ib_referral_bounty",):
        return 25
    return 30


# (open_day, close_day) per closed trade, oldest first.
CLOSED_SLOTS = [(8, 10), (24, 26), (42, 44)]


async def run(execute: bool):
    tag = "" if execute else "[dry-run] "
    now = datetime.now(timezone.utc)
    start = (now - timedelta(days=WINDOW_DAYS)).replace(hour=10, minute=0, second=0, microsecond=0)

    async with AsyncSessionLocal() as db:
        user = (await db.execute(
            select(User).where(func.lower(User.email) == TARGET_EMAIL.lower())
        )).scalar_one_or_none()
        if not user:
            logger.error("target user %s not found", TARGET_EMAIL)
            return
        acct_ids = (await db.execute(
            select(TradingAccount.id).where(TradingAccount.user_id == user.id)
        )).scalars().all()

        # 1. Transactions
        txns = (await db.execute(
            select(Transaction).where(Transaction.user_id == user.id)
        )).scalars().all()
        for tx in txns:
            when = _at(start, _txn_day(tx))
            logger.info("%s  txn %-18s $%-10s %s -> %s", tag, tx.type, tx.amount,
                        (tx.description or "")[:40], when.date())
            tx.created_at = when

        # 2. AI-POWERED STAKING PROGRAM locks — shift locked_at + matures_at back; leave
        #    next_payout_at (future) so the engine does no catch-up.
        locks = (await db.execute(
            select(FixedReturnLock).where(FixedReturnLock.user_id == user.id)
        )).scalars().all()
        for lk in locks:
            new_lock = _at(start, 1)
            shift = (lk.locked_at - new_lock) if lk.locked_at else timedelta(0)
            lk.locked_at = new_lock
            if lk.matures_at:
                lk.matures_at = lk.matures_at - shift
            logger.info("%s  FR lock $%s locked_at -> %s (matures %s)", tag, lk.principal,
                        new_lock.date(), lk.matures_at.date() if lk.matures_at else "—")

        # 3. Closed positions + their TradeHistory, spaced through the window.
        closed = (await db.execute(
            select(Position).where(
                Position.account_id.in_(acct_ids),
                Position.status == PositionStatus.CLOSED,
            ).order_by(Position.created_at)
        )).scalars().all()
        for i, pos in enumerate(closed):
            o_day, c_day = CLOSED_SLOTS[i % len(CLOSED_SLOTS)]
            opened, closed_at = _at(start, o_day), _at(start, c_day)
            pos.created_at = opened
            pos.closed_at = closed_at
            for th in (await db.execute(
                select(TradeHistory).where(TradeHistory.position_id == pos.id)
            )).scalars().all():
                th.opened_at = opened
                th.closed_at = closed_at
            logger.info("%s  closed pos %s: %s -> %s", tag, str(pos.id)[:8], opened.date(), closed_at.date())

        # 4. Insurance policies
        for pol in (await db.execute(
            select(InsurancePolicy).where(InsurancePolicy.account_id.in_(acct_ids))
        )).scalars().all():
            pol.activated_at = _at(start, 45)
            logger.info("%s  insurance policy %s activated_at -> %s", tag, str(pol.id)[:8], pol.activated_at.date())

        # 5. Open positions — recent (a few days ago) so live P&L still reads well.
        for pos in (await db.execute(
            select(Position).where(
                Position.account_id.in_(acct_ids),
                Position.status == PositionStatus.OPEN,
            )
        )).scalars().all():
            pos.created_at = _at(start, WINDOW_DAYS - 4)
            logger.info("%s  open pos %s created_at -> %s", tag, str(pos.id)[:8], pos.created_at.date())

        # 6. Downline users + their Referral / IBCommission rows, spaced.
        downline = (await db.execute(
            select(User).where(User.referred_by_user_id == user.id).order_by(User.created_at)
        )).scalars().all()
        for i, child in enumerate(downline):
            cday = 6 + i * 16
            when = _at(start, cday)
            child.created_at = when
            if child.referral_qualified_at:
                child.referral_qualified_at = _at(start, cday + 3)
            if child.referral_claimed_at:
                child.referral_claimed_at = _at(start, cday + 4)
            for rf in (await db.execute(
                select(Referral).where(Referral.referred_id == child.id)
            )).scalars().all():
                rf.created_at = when
            for ic in (await db.execute(
                select(IBCommission).where(IBCommission.source_user_id == child.id)
            )).scalars().all():
                ic.created_at = _at(start, cday + 5)
            logger.info("%s  downline %s created_at -> %s", tag, child.email, when.date())

        if execute:
            await db.commit()
            logger.info("DONE — backdated promo history across ~%d days.", WINDOW_DAYS)
        else:
            await db.rollback()
            logger.info("[dry-run] rolled back — no changes written. Re-run with --execute.")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Backdate the promo account's seeded history.")
    p.add_argument("--execute", action="store_true", help="actually write (default: dry-run)")
    args = p.parse_args()
    asyncio.run(run(execute=args.execute))
