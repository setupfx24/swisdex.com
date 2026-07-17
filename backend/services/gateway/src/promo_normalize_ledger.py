"""One-off (client 2026-07-14): make ALL promotional accounts read like real
accounts.

For every User with is_promotional=true:
  1. Transactions of type 'adjustment' are re-typed by sign: positive ->
     'deposit', negative -> 'withdrawal'. Generic admin wordings get a
     realistic description ('Deposit/Withdrawal via Bank transfer').
  2. Any 'seed' wording left in descriptions is scrubbed:
     'seeded $X' -> 'funded $X', '(seed)' suffix stripped.
  3. Fake '@swisdex-promo.local' emails are renamed to numbered gmail
     addresses (same style the prospertech downline already uses, e.g.
     aarti.deshmukh63@gmail.com), deterministic + collision-checked, so the
     showcase Affiliates/Referral pages show believable emails.

DRY-RUN by default; --execute to write.
    python -m services.gateway.src.promo_normalize_ledger
    python -m services.gateway.src.promo_normalize_ledger --execute
"""
import argparse
import asyncio
import logging
import re

from sqlalchemy import select

from packages.common.src.database import AsyncSessionLocal
from packages.common.src.models import Transaction, User

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-5s %(message)s")
logger = logging.getLogger("promo-normalize")

FAKE_DOMAIN = "@swisdex-promo.local"
GENERIC_ADJ_DESCRIPTIONS = {"wallet reconciliation", "admin adjustment", "balance adjustment", ""}


def _clean_description(desc: str) -> str:
    out = desc or ""
    out = out.replace(" (seed)", "")
    out = re.sub(r"\bseeded\b", "funded", out, flags=re.IGNORECASE)
    out = re.sub(r"\s{2,}", " ", out).strip()
    return out


def _gmailify(local: str, taken: set[str]) -> str:
    """Deterministic numbered gmail for a fake local part, collision-checked."""
    base = re.sub(r"[^a-z0-9.]", "", local.lower())
    digits = sum(ord(c) for c in base) % 90 + 10  # stable 10..99
    for bump in range(0, 200):
        candidate = f"{base}{digits + bump}@gmail.com"
        if candidate not in taken:
            return candidate
    return f"{base}.x@gmail.com"


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true", help="Write changes (default: dry-run)")
    args = parser.parse_args()

    async with AsyncSessionLocal() as db:
        promo_users = (await db.execute(
            select(User).where(User.is_promotional == True)  # noqa: E712
        )).scalars().all()
        promo_ids = [u.id for u in promo_users]
        logger.info("%d promotional users", len(promo_users))

        # 1+2. Transactions: adjustments re-typed, seed wording scrubbed.
        txs = (await db.execute(
            select(Transaction).where(Transaction.user_id.in_(promo_ids))
        )).scalars().all()
        tx_changes = 0
        for tx in txs:
            new_type = tx.type
            new_desc = _clean_description(tx.description or "")
            if tx.type == "adjustment":
                positive = float(tx.amount or 0) >= 0
                new_type = "deposit" if positive else "withdrawal"
                if new_desc.lower() in GENERIC_ADJ_DESCRIPTIONS:
                    new_desc = ("Deposit" if positive else "Withdrawal") + " via Bank transfer"
            if new_type != tx.type or new_desc != (tx.description or ""):
                logger.info(
                    "tx %s: [%s -> %s] '%s' -> '%s'",
                    str(tx.id)[:8], tx.type, new_type, tx.description, new_desc,
                )
                if args.execute:
                    tx.type = new_type
                    tx.description = new_desc
                tx_changes += 1

        # 3. Fake emails -> numbered gmail.
        taken = {
            e.lower() for e in (await db.execute(select(User.email))).scalars().all()
        }
        email_changes = 0
        for u in promo_users:
            if not u.email.lower().endswith(FAKE_DOMAIN):
                continue
            local = u.email.split("@")[0]
            new_email = _gmailify(local, taken)
            taken.add(new_email)
            logger.info("user %s %s: %s -> %s", u.first_name, u.last_name, u.email, new_email)
            if args.execute:
                u.email = new_email
            email_changes += 1

        if args.execute:
            await db.commit()
            logger.info("COMMITTED — %d transactions, %d emails.", tx_changes, email_changes)
        else:
            logger.info(
                "Dry-run only (%d transactions, %d emails would change) — re-run with --execute.",
                tx_changes, email_changes,
            )


if __name__ == "__main__":
    asyncio.run(main())
