"""One-off (client 2026-07-14): scrub the "(seed)" / "Promotional account
funding" wording from the promo showcase accounts' transaction history so the
ledger reads like a real account ("Promotion seed fund hata do, kewal deposit
rahne do").

  - 'Promotional account funding (seed)'  -> 'Deposit via Bank transfer'
    (same wording the prospertech seeder already uses for real-looking rows)
  - any other description ending in ' (seed)' -> suffix stripped.

DRY-RUN by default; --execute to write.
    python -m services.gateway.src.promo_clean_seed_descriptions
    python -m services.gateway.src.promo_clean_seed_descriptions --execute
"""
import argparse
import asyncio
import logging

from sqlalchemy import select

from packages.common.src.database import AsyncSessionLocal
from packages.common.src.models import Transaction, User

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-5s %(message)s")
logger = logging.getLogger("promo-clean-descriptions")

TARGET_EMAILS = [
    "amardeepsonar2001@gmail.com",
    "prospertech.pro@gmail.com",
]
DEPOSIT_SEED_DESC = "Promotional account funding (seed)"
DEPOSIT_CLEAN_DESC = "Deposit via Bank transfer"
SEED_SUFFIX = " (seed)"


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true", help="Write changes (default: dry-run)")
    args = parser.parse_args()

    async with AsyncSessionLocal() as db:
        changed = 0
        for email in TARGET_EMAILS:
            user = (await db.execute(
                select(User).where(User.email == email)
            )).scalar_one_or_none()
            if user is None:
                logger.warning("%s: user not found — skipped", email)
                continue
            txs = (await db.execute(
                select(Transaction).where(
                    Transaction.user_id == user.id,
                    Transaction.description.ilike("%(seed)%"),
                )
            )).scalars().all()
            for tx in txs:
                old = tx.description or ""
                if old == DEPOSIT_SEED_DESC:
                    new = DEPOSIT_CLEAN_DESC
                elif old.endswith(SEED_SUFFIX):
                    new = old[: -len(SEED_SUFFIX)]
                else:
                    new = old.replace("(seed)", "").replace("  ", " ").strip()
                logger.info("%s: [%s] '%s' -> '%s'", email, tx.type, old, new)
                if args.execute:
                    tx.description = new
                changed += 1
        if args.execute:
            await db.commit()
            logger.info("COMMITTED — %d transaction descriptions cleaned.", changed)
        else:
            logger.info("Dry-run only (%d rows would change) — re-run with --execute.", changed)


if __name__ == "__main__":
    asyncio.run(main())
