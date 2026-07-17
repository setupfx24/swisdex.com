"""Third-pass seeder: adjust the promotional demo account
(amardeepsonar2001@gmail.com) to a specific, richer set of showcase targets
requested by the client on 2026-07-11.

Targets (all on the ONE promotional account, so excluded from real financials):
  - AI-POWERED STAKING PROGRAM locked  = $4,500  (staggered purchases over ~2m)
  - Live trading-account balance        = $1,800
  - Main wallet balance                 = $452
  - Referrals (downline)                = 12  (adds new promo downline)
  - IB commission balance               = $209
  - Referral commission balance         = $120
  - Trade insurance: several policies across the 2-month trade history, a few
    CLAIMED (paid to account credit), the rest expired — so "insurance taken,
    some claimed" reads true.

Builds on top of seed_promo_account.py + seed_promo_history.py (which already
created the account, the FR lock, the 2-month trade history and the first 3
downline). This script only tops up the DELTA to reach the new targets and is
fully IDEMPOTENT — re-running never double-funds.

SAFETY
  - DRY-RUN by default. Add --execute to write.
        python -m services.gateway.src.topup_promo_targets            # dry-run
        python -m services.gateway.src.topup_promo_targets --execute   # write
"""
import argparse
import asyncio
import logging
import secrets
import string
from decimal import Decimal, ROUND_HALF_UP
from datetime import datetime, timezone, timedelta

from sqlalchemy import select, func

from packages.common.src.database import AsyncSessionLocal
from packages.common.src.auth import hash_password
from packages.common.src.models import (
    User, TradingAccount, Position, Instrument, Transaction,
    InsurancePolicy, InsuranceClaim, IBProfile, IBCommission, Referral,
    PositionStatus, FixedReturnLock,
)
from services.gateway.src.services.fixed_return_service import create_lock

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-5s %(message)s")
logger = logging.getLogger("topup-promo")

TARGET_EMAIL = "amardeepsonar2001@gmail.com"

FR_TARGET_TOTAL = Decimal("4500")
# New staggered staking purchases to reach the total (principal, tenure, days_ago).
NEW_LOCKS = [
    (Decimal("1500"), "Year", 50),
    (Decimal("2000"), "Year", 22),
]
TRADE_BALANCE_TARGET = Decimal("1800")
WALLET_TARGET = Decimal("452")

TOTAL_DOWNLINE = 12
IB_COMM_TARGET = Decimal("209")
REF_COMM_TARGET = Decimal("120")

# 9 new downline (ref4..ref12). ib amounts sum to 134 (75 existing + 134 = 209).
NEW_DOWNLINE = [
    ("amardeep.ref4@swisdex-promo.local",  "Sanjay",  "Patel",   Decimal("18"), 58),
    ("amardeep.ref5@swisdex-promo.local",  "Neha",    "Gupta",   Decimal("16"), 52),
    ("amardeep.ref6@swisdex-promo.local",  "Vikram",  "Singh",   Decimal("14"), 46),
    ("amardeep.ref7@swisdex-promo.local",  "Anjali",  "Nair",    Decimal("20"), 40),
    ("amardeep.ref8@swisdex-promo.local",  "Rohit",   "Joshi",   Decimal("12"), 34),
    ("amardeep.ref9@swisdex-promo.local",  "Kavya",   "Reddy",   Decimal("10"), 28),
    ("amardeep.ref10@swisdex-promo.local", "Manish",  "Kulkarni",Decimal("16"), 20),
    ("amardeep.ref11@swisdex-promo.local", "Pooja",   "Iyer",    Decimal("14"), 14),
    ("amardeep.ref12@swisdex-promo.local", "Deepak",  "Chauhan", Decimal("14"), 8),
]

# Insurance: number of CLAIMED (loss) + EXPIRED (profit) policies to attach to
# existing seed-history closed trades.
N_CLAIMED = 4
N_EXPIRED = 4
INS_FEE = Decimal("2.50")
INS_COVERAGE = Decimal("50.00")
INS_MAX_CAP = Decimal("100.00")


def _now():
    return datetime.now(timezone.utc)


def gen_code(n=8):
    return "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(n))


def _q2(v: Decimal) -> Decimal:
    return v.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


async def run(execute: bool):
    tag = "" if execute else "[dry-run] "
    now = _now()
    async with AsyncSessionLocal() as db:
        main = (await db.execute(
            select(User).where(func.lower(User.email) == TARGET_EMAIL.lower())
        )).scalar_one_or_none()
        if main is None:
            raise SystemExit(f"{TARGET_EMAIL} not found — run seed_promo_account.py first.")
        acct = (await db.execute(
            select(TradingAccount).where(
                TradingAccount.user_id == main.id,
                TradingAccount.is_demo == False,  # noqa: E712
            ).order_by(TradingAccount.created_at)
        )).scalars().first()
        if acct is None:
            raise SystemExit(f"{TARGET_EMAIL} has no live account — run seed_promo_account.py first.")
        logger.info("%starget %s acct=%s", tag, TARGET_EMAIL, acct.account_number)

        # ── 1. AI staking → $4,500 (add staggered locks) ──────────────────
        fr_total = (await db.execute(
            select(func.coalesce(func.sum(FixedReturnLock.principal), 0)).where(
                FixedReturnLock.user_id == main.id
            )
        )).scalar() or Decimal("0")
        fr_total = Decimal(str(fr_total))
        logger.info("%sFR current total principal = $%s (target $%s)", tag, fr_total, FR_TARGET_TOTAL)
        if fr_total >= FR_TARGET_TOTAL:
            logger.info("%sFR already at/above target — skipping new locks", tag)
        else:
            need = sum((p for p, _, _ in NEW_LOCKS), Decimal("0"))
            # Fund the wallet so create_lock() can debit each principal.
            main.main_wallet_balance = (main.main_wallet_balance or Decimal("0")) + need
            await db.flush()
            for principal, tenure, days_ago in NEW_LOCKS:
                if not execute:
                    logger.info("%s  would create FR lock $%s %s (locked ~%sd ago)", tag, principal, tenure, days_ago)
                    continue
                logger.info("  creating FR lock $%s %s (commits internally)", principal, tenure)
                await create_lock(main.id, principal, tenure, db, acknowledge_bonus_forfeit=True)
                lock = (await db.execute(
                    select(FixedReturnLock).where(
                        FixedReturnLock.user_id == main.id,
                        FixedReturnLock.principal == principal,
                        FixedReturnLock.state == "active",
                    ).order_by(FixedReturnLock.locked_at.desc())
                )).scalars().first()
                if lock is not None:
                    target = now - timedelta(days=days_ago)
                    dur_mat = (lock.matures_at - lock.locked_at) if lock.matures_at else None
                    dur_np = (lock.next_payout_at - lock.locked_at) if lock.next_payout_at else None
                    lock.locked_at = target
                    if dur_mat:
                        lock.matures_at = target + dur_mat
                    if dur_np:
                        np_at = target + dur_np
                        if np_at <= now + timedelta(days=1):
                            np_at = now + timedelta(days=20)
                        lock.next_payout_at = np_at
                    # Re-date the lock ledger row to the same day.
                    txn = (await db.execute(
                        select(Transaction).where(
                            Transaction.user_id == main.id,
                            Transaction.type == "fixed_return_lock",
                            Transaction.amount == -principal,
                        ).order_by(Transaction.created_at.desc())
                    )).scalars().first()
                    if txn is not None:
                        txn.created_at = target
                    logger.info("  anchored lock $%s -> %s", principal, target.date())

        # ── 2. Add downline to reach 12 referrals ─────────────────────────
        ib = (await db.execute(
            select(IBProfile).where(IBProfile.user_id == main.id)
        )).scalar_one_or_none()
        if ib is None:
            raise SystemExit("target has no IBProfile — run seed_promo_account.py first.")

        existing_downline = (await db.execute(
            select(func.count(User.id)).where(User.referred_by_user_id == main.id)
        )).scalar() or 0
        logger.info("%sdownline currently %s (target %s)", tag, existing_downline, TOTAL_DOWNLINE)
        for email, fn, ln, ib_amt, days_ago in NEW_DOWNLINE:
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
            db.add(Referral(
                referrer_id=main.id, referred_id=child.id, ib_profile_id=ib.id,
                created_at=when + timedelta(days=1),
            ))
            db.add(IBCommission(
                ib_id=ib.id, source_user_id=child.id, amount=ib_amt,
                mlm_level=1, status="paid", commission_type="trade",
                created_at=when + timedelta(days=4),
            ))
            logger.info("%s  + downline %s (ib $%s, ~%sd ago)", tag, email, ib_amt, days_ago)

        # ── 3. Set commission balances to exact targets ───────────────────
        main.ib_commission_balance = IB_COMM_TARGET
        main.referral_commission_balance = REF_COMM_TARGET
        ib.total_earned = IB_COMM_TARGET
        logger.info("%sset ib_commission=$%s referral_commission=$%s", tag, IB_COMM_TARGET, REF_COMM_TARGET)

        # ── 4. Insurance policies + claims on seed-history trades ──────────
        already_claimed = (await db.execute(
            select(func.count(InsurancePolicy.id)).where(
                InsurancePolicy.user_id == main.id, InsurancePolicy.status == "claimed"
            )
        )).scalar() or 0
        if already_claimed > 0:
            logger.info("%sinsurance claims already present (%s) — skipping insurance", tag, already_claimed)
        else:
            # Positions that don't already carry a policy.
            insured_pos_ids = set((await db.execute(
                select(InsurancePolicy.position_id).where(InsurancePolicy.user_id == main.id)
            )).scalars().all())
            closed = (await db.execute(
                select(Position).where(
                    Position.account_id == acct.id,
                    Position.status == PositionStatus.CLOSED,
                    Position.comment == "seed-history",
                ).order_by(Position.closed_at)
            )).scalars().all()
            losses = [p for p in closed if (p.profit or Decimal("0")) < 0 and p.id not in insured_pos_ids]
            wins = [p for p in closed if (p.profit or Decimal("0")) >= 0 and p.id not in insured_pos_ids]
            claim_targets = losses[:N_CLAIMED]
            expire_targets = wins[:N_EXPIRED]
            credit_added = Decimal("0")

            for p in claim_targets:
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
                acct.credit = (acct.credit or Decimal("0")) + claim_amt
                tx = Transaction(
                    user_id=main.id, account_id=acct.id, type="insurance_payout",
                    amount=claim_amt, balance_after=acct.balance,
                    description="Trade insurance claim payout (seed)", created_at=p.closed_at,
                )
                db.add(tx)
                await db.flush()
                db.add(InsuranceClaim(
                    policy_id=pol.id, user_id=main.id, loss_amount=loss,
                    claim_amount=claim_amt, transaction_id=tx.id, status="paid",
                    claimed_at=p.closed_at, paid_at=p.closed_at,
                ))
                logger.info("%s  insured+claimed pos %s loss $%s -> payout $%s", tag, p.id, _q2(loss), claim_amt)

            for p in expire_targets:
                db.add(InsurancePolicy(
                    user_id=main.id, account_id=acct.id, position_id=p.id,
                    instrument_id=p.instrument_id, tier="50%", fee=INS_FEE,
                    coverage_pct=INS_COVERAGE, max_cap=INS_MAX_CAP, risk_score=Decimal("5.0000"),
                    status="expired", activated_at=p.created_at, settled_at=p.closed_at,
                    settled_reason="not_a_loss",
                ))
                logger.info("%s  insured+expired pos %s (win, no claim)", tag, p.id)
            logger.info("%sinsurance: %s claimed (credit +$%s), %s expired",
                        tag, len(claim_targets), _q2(credit_added), len(expire_targets))

        # ── 5. Pin the live trading-account balance to exactly $1,800 ──────
        old_bal = acct.balance or Decimal("0")
        acct.balance = TRADE_BALANCE_TARGET
        mu = acct.margin_used or Decimal("0")
        acct.equity = TRADE_BALANCE_TARGET + (acct.credit or Decimal("0"))
        acct.free_margin = acct.equity - mu
        acct.margin_level = (acct.equity / mu * Decimal("100")) if mu > 0 else Decimal("9999")
        if old_bal != TRADE_BALANCE_TARGET:
            db.add(Transaction(
                user_id=main.id, account_id=acct.id, type="adjustment",
                amount=_q2(TRADE_BALANCE_TARGET - old_bal), balance_after=TRADE_BALANCE_TARGET,
                description="Trading capital top-up (seed)", created_at=now - timedelta(days=40),
            ))
        logger.info("%strading balance $%s -> $%s (credit $%s, equity $%s)", tag, _q2(old_bal),
                    TRADE_BALANCE_TARGET, _q2(acct.credit or Decimal('0')), _q2(acct.equity))

        # ── 6. Pin the main wallet to exactly $452 ────────────────────────
        old_wallet = main.main_wallet_balance or Decimal("0")
        main.main_wallet_balance = WALLET_TARGET
        if old_wallet != WALLET_TARGET:
            db.add(Transaction(
                user_id=main.id, account_id=None, type="adjustment",
                amount=_q2(WALLET_TARGET - old_wallet), balance_after=WALLET_TARGET,
                description="Wallet reconciliation (seed)",
            ))
        logger.info("%smain wallet $%s -> $%s", tag, _q2(old_wallet), WALLET_TARGET)

        if execute:
            await db.commit()
            logger.info("DONE — committed. %s tuned to showcase targets.", TARGET_EMAIL)
        else:
            await db.rollback()
            logger.info("[dry-run] rolled back — nothing written. Re-run with --execute.")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Top up the promo demo account to new showcase targets.")
    p.add_argument("--execute", action="store_true", help="actually write (default: dry-run)")
    args = p.parse_args()
    asyncio.run(run(execute=args.execute))
