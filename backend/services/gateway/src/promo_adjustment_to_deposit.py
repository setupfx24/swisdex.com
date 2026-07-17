"""One-off (client 2026-07-14): on the promo showcase account, re-label the
'Trading capital top-up' ADMIN ADJUSTMENT as a DEPOSIT so the ledger row reads
"Deposit" instead of "Admin adjustment" (display-only; amount/date untouched).

DRY-RUN by default; --execute to write.
    python -m services.gateway.src.promo_adjustment_to_deposit
    python -m services.gateway.src.promo_adjustment_to_deposit --execute
"""
import argparse
import asyncio
import logging

from sqlalchemy import select

from packages.common.src.database import AsyncSessionLocal
from packages.common.src.models import Transaction, User

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-5s %(message)s")
logger = logging.getLogger("promo-adj-to-deposit")

TARGET_EMAIL = "amardeepsonar2001@gmail.com"
MATCH_DESCRIPTION_PREFIX = "Trading capital top-up"


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true", help="Write changes (default: dry-run)")
    args = parser.parse_args()

    async with AsyncSessionLocal() as db:
        user = (await db.execute(
            select(User).where(User.email == TARGET_EMAIL)
        )).scalar_one_or_none()
        if user is None:
            logger.error("%s: user not found", TARGET_EMAIL)
            return
        txs = (await db.execute(
            select(Transaction).where(
                Transaction.user_id == user.id,
                Transaction.type == "adjustment",
                Transaction.description.ilike(f"{MATCH_DESCRIPTION_PREFIX}%"),
            )
        )).scalars().all()
        if not txs:
            logger.warning("No matching adjustment rows found — nothing to do.")
            return
        for tx in txs:
            logger.info(
                "%s: adjustment -> deposit  $%s  '%s'  (%s)",
                TARGET_EMAIL, tx.amount, tx.description, tx.created_at,
            )
            if args.execute:
                tx.type = "deposit"
        if args.execute:
            await db.commit()
            logger.info("COMMITTED — %d row(s) re-typed.", len(txs))
        else:
            logger.info("Dry-run only — re-run with --execute to write.")


if __name__ == "__main__":
    asyncio.run(main())
