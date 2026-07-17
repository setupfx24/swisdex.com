"""One-off (client 2026-07-14): re-cycle the promo showcase accounts' AI
Powered Staking locks.

  - amardeepsonar2001@gmail.com : the $2,000 lock -> Month (every 30 days);
    every other active Year lock -> Quarter (every 90 days).
  - prospertech.pro@gmail.com   : active locks -> Month.

Only tenure_label / tenure_days / next_payout_at change. rate_pct (the promo
4%/month), principal, matures_at, payouts_count all stay as-is, so the cards
keep reading the same except the CYCLE column and the next-payout date.
next_payout_at is recomputed exactly like fixed_return_service schedules it:
first payout from locked_at at the new cadence (snapped to the payout
day-of-month), advanced in whole cycles until it lands in the future, clamped
to maturity.

DRY-RUN by default; --execute to write.
    python -m services.gateway.src.promo_fix_lock_tenures
    python -m services.gateway.src.promo_fix_lock_tenures --execute
"""
import argparse
import asyncio
import logging
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import select

from packages.common.src.database import AsyncSessionLocal
from packages.common.src.models import FixedReturnLock, User
from services.gateway.src.services.fixed_return_service import (
    _add_months, _first_payout_date, _tenure_to_months,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-5s %(message)s")
logger = logging.getLogger("promo-fix-tenures")

PAYOUT_DAY = 25  # matches prod fixed_return_payout_day_of_month

# (email, rule) — rule maps an active lock to its new (label, days) or None to skip.
def _amardeep_rule(lock: FixedReturnLock):
    if Decimal(str(lock.principal or 0)) == Decimal("2000"):
        return ("Month", 30)
    if int(lock.tenure_days or 0) >= 350:  # the Year locks
        return ("Quarter", 90)
    return None


def _prospertech_rule(lock: FixedReturnLock):
    if (lock.tenure_label or "").lower() != "month":
        return ("Month", 30)
    return None


TARGETS = [
    ("amardeepsonar2001@gmail.com", _amardeep_rule),
    ("prospertech.pro@gmail.com", _prospertech_rule),
]


def _next_payout(locked_at: datetime, matures_at: datetime | None, cycle_months: int, now: datetime):
    if locked_at.tzinfo is None:
        locked_at = locked_at.replace(tzinfo=timezone.utc)
    np = _first_payout_date(locked_at, cycle_months, payout_day=PAYOUT_DAY)
    guard = 0
    while np <= now and guard < 600:
        np = _add_months(np, cycle_months)
        guard += 1
    if matures_at is not None:
        ma = matures_at if matures_at.tzinfo else matures_at.replace(tzinfo=timezone.utc)
        if np > ma:
            np = ma
    return np


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true", help="Write changes (default: dry-run)")
    args = parser.parse_args()
    now = datetime.now(timezone.utc)

    async with AsyncSessionLocal() as db:
        for email, rule in TARGETS:
            user = (await db.execute(
                select(User).where(User.email == email)
            )).scalar_one_or_none()
            if user is None:
                logger.warning("%s: user not found — skipped", email)
                continue
            locks = (await db.execute(
                select(FixedReturnLock).where(
                    FixedReturnLock.user_id == user.id,
                    FixedReturnLock.state == "active",
                ).order_by(FixedReturnLock.locked_at)
            )).scalars().all()
            if not locks:
                logger.warning("%s: no active locks", email)
                continue
            for lock in locks:
                new = rule(lock)
                if new is None:
                    logger.info(
                        "%s: $%s %s — unchanged", email, lock.principal, lock.tenure_label,
                    )
                    continue
                label, days = new
                cycle_months = _tenure_to_months(days)
                np = _next_payout(lock.locked_at, lock.matures_at, cycle_months, now)
                logger.info(
                    "%s: $%s  %s(%sd) -> %s(%sd)  next_payout %s -> %s",
                    email, lock.principal, lock.tenure_label, lock.tenure_days,
                    label, days,
                    lock.next_payout_at.date() if lock.next_payout_at else None,
                    np.date(),
                )
                if args.execute:
                    lock.tenure_label = label
                    lock.tenure_days = days
                    lock.next_payout_at = np
        if args.execute:
            await db.commit()
            logger.info("COMMITTED.")
        else:
            logger.info("Dry-run only — re-run with --execute to write.")


if __name__ == "__main__":
    asyncio.run(main())
