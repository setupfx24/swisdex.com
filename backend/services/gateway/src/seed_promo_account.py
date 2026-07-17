"""One-off seeder: fully populate ONE promotional demo account so it showcases
every feature (trades, AI-POWERED STAKING PROGRAM, insurance, referral, IB).

Target user (client 2026-07-04): amardeepsonar2001@gmail.com
  - Flagged promotional (is_promotional=True) so ALL its activity is excluded
    from the broker's real company financials, but shows live on the user's
    own dashboard.
  - $1000 locked in AI-POWERED STAKING PROGRAM ("AI-POWERED STAKING PROGRAM"), tenure "Year".
  - A standard USD trading account funded with $1800 capital, carrying a mix
    of OPEN positions (live floating P&L) and CLOSED trades (realized history).
  - One insured trade (active InsurancePolicy).
  - Referral: 2-3 demo downline users referred by this account (also flagged
    promotional), with claimed referral commission credited.
  - IB: this account approved as an IB (IBProfile + approved IBApplication),
    with IB commission accrued from the downline.

SAFETY
  - DRY-RUN by default. Prints the full plan and writes NOTHING. Add --execute
    to actually write.
        python -m services.gateway.src.seed_promo_account            # dry-run
        python -m services.gateway.src.seed_promo_account --execute   # write
  - IDEMPOTENT: skips any piece already present (FR lock, trading account,
    downline users, IB profile) so a re-run never double-funds or duplicates.
  - Money is kept consistent: main wallet is topped up by exactly what the FR
    lock + trading-account transfer consume, every move writes a Transaction
    ledger row, and account equity/free_margin are seeded (the risk engine
    then recomputes them + floating P&L live every second from open positions).

NOTE on atomicity: create_lock() (the real production FR path, reused here for
correct rate-matrix + payout scheduling) commits internally. Everything after
it commits at the end. If the script dies in between, the idempotent guards let
a re-run finish cleanly.
"""
import argparse
import asyncio
import json
import logging
import os
import secrets
import string
from decimal import Decimal
from datetime import datetime, timezone, timedelta

from sqlalchemy import select, func

from packages.common.src.database import AsyncSessionLocal
from packages.common.src.auth import hash_password
from packages.common.src.models import (
    User, AccountGroup, TradingAccount, Position, TradeHistory, Instrument,
    Transaction, InsurancePolicy, IBProfile, IBApplication, IBCommission,
    Referral, PositionStatus, OrderSide, FixedReturnLock,
)
from packages.common.src.redis_client import redis_client, PriceChannel
from services.gateway.src.services.fixed_return_service import create_lock

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-5s %(message)s")
logger = logging.getLogger("seed-promo")

# ── Config ────────────────────────────────────────────────────────────────
TARGET_EMAIL = "amardeepsonar2001@gmail.com"
TARGET_FIRST, TARGET_LAST = "Amardeep", "Sonar"
# The account is expected to already exist (created in admin). A password is
# ONLY needed for the create-if-missing fallback and is read from the
# PROMO_USER_PASSWORD env var — never hardcoded, so it can't leak into git.

FR_PRINCIPAL = Decimal("1000")
FR_TENURE = "Year"                 # one of: Month / Quarter / Half-Year / Year / 2 Year
TRADE_CAPITAL = Decimal("1800")

# Demo downline (referred by the target). Also flagged promotional.
DOWNLINE = [
    ("amardeep.ref1@swisdex-promo.local", "Rahul", "Verma"),
    ("amardeep.ref2@swisdex-promo.local", "Priya", "Sharma"),
    ("amardeep.ref3@swisdex-promo.local", "Arjun", "Mehta"),
]
REFERRAL_BOUNTY_EACH = Decimal("10")   # credited to target.referral_commission_balance
IB_COMMISSION_EACH = Decimal("25")     # credited to target.ib_commission_balance

# Fallback prices if no live Redis tick is available for the symbol.
FALLBACK_PRICE = {
    "BTCUSD": Decimal("62000"), "ETHUSD": Decimal("3000"),
    "XAUUSD": Decimal("2600"), "EURUSD": Decimal("1.08000"),
}
# OPEN positions to seed: (symbol, side, lots). open_price = live mid (≈0 P&L at open).
OPEN_TRADES = [
    ("BTCUSD", OrderSide.BUY, Decimal("0.01")),
    ("XAUUSD", OrderSide.BUY, Decimal("0.02")),
]
# CLOSED trades: (symbol, side, lots, open_price, close_price). profit computed
# from the instrument's real contract_size so open/close/profit stay consistent.
CLOSED_TRADES = [
    ("EURUSD", OrderSide.BUY,  Decimal("0.05"), Decimal("1.08000"), Decimal("1.08600")),
    ("XAUUSD", OrderSide.SELL, Decimal("0.02"), Decimal("2620.00"), Decimal("2600.00")),
    ("BTCUSD", OrderSide.BUY,  Decimal("0.01"), Decimal("63000.00"), Decimal("62300.00")),
]
MAX_MARGIN_FRACTION = Decimal("0.20")  # skip an open trade if its margin > 20% of capital


def _now():
    return datetime.now(timezone.utc)


def gen_code(n=8):
    return "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(n))


async def live_mid(symbol: str) -> Decimal | None:
    try:
        raw = await redis_client.get(PriceChannel.tick_key(symbol))
        if raw:
            d = json.loads(raw)
            return (Decimal(str(d["bid"])) + Decimal(str(d["ask"]))) / Decimal("2")
    except Exception as exc:  # noqa: BLE001
        logger.warning("live_mid(%s) failed: %s", symbol, exc)
    return None


def profit_for(side, lots, open_price, close_price, contract_size) -> Decimal:
    if side == OrderSide.BUY:
        return (close_price - open_price) * lots * contract_size
    return (open_price - close_price) * lots * contract_size


async def unique_account_number(db) -> str:
    for _ in range(50):
        num = "8" + "".join(secrets.choice(string.digits) for _ in range(7))  # 8-digit
        exists = (await db.execute(
            select(func.count(TradingAccount.id)).where(TradingAccount.account_number == num)
        )).scalar()
        if not exists:
            return num
    raise RuntimeError("could not allocate a unique account number")


async def run(execute: bool):
    tag = "" if execute else "[dry-run] "
    async with AsyncSessionLocal() as db:
        # ── 1. Target user ────────────────────────────────────────────────
        main = (await db.execute(
            select(User).where(func.lower(User.email) == TARGET_EMAIL.lower())
        )).scalar_one_or_none()
        if main is None:
            pw = os.getenv("PROMO_USER_PASSWORD")
            if not pw:
                raise SystemExit(
                    f"User {TARGET_EMAIL} does not exist and PROMO_USER_PASSWORD is not set. "
                    "Re-run with the password in the env (not hardcoded), e.g.:\n"
                    "  PROMO_USER_PASSWORD='...' python -m services.gateway.src.seed_promo_account --execute"
                )
            logger.info("%screating target user %s", tag, TARGET_EMAIL)
            main = User(
                email=TARGET_EMAIL,
                password_hash=hash_password(pw),
                first_name=TARGET_FIRST, last_name=TARGET_LAST,
                role="user", status="active",
                kyc_status="approved", email_verified=True, email_verified_at=_now(),
                is_promotional=True,
                referral_code=gen_code(),
                main_wallet_balance=Decimal("0"),
            )
            db.add(main)
            await db.flush()
        else:
            logger.info("%sfound target user %s (id=%s)", tag, TARGET_EMAIL, main.id)
            main.is_promotional = True
            main.kyc_status = "approved"
            main.email_verified = True
            if not main.referral_code:
                main.referral_code = gen_code()

        # ── 2. Work out what's already seeded (idempotency) ───────────────
        has_fr = (await db.execute(
            select(func.count(FixedReturnLock.id)).where(FixedReturnLock.user_id == main.id)
        )).scalar() > 0
        acct = (await db.execute(
            select(TradingAccount).where(
                TradingAccount.user_id == main.id,
                TradingAccount.is_demo == False,  # noqa: E712
            ).order_by(TradingAccount.created_at)
        )).scalars().first()
        has_account = acct is not None

        # ── 3. Top up main wallet by exactly what FR + trading consume ────
        need = (Decimal("0") if has_fr else FR_PRINCIPAL) + (Decimal("0") if has_account else TRADE_CAPITAL)
        if need > 0:
            logger.info("%sfund main wallet +$%s (FR:%s, trading:%s)", tag, need,
                        "skip" if has_fr else FR_PRINCIPAL, "skip" if has_account else TRADE_CAPITAL)
            main.main_wallet_balance = (main.main_wallet_balance or Decimal("0")) + need
            db.add(Transaction(
                user_id=main.id, account_id=None, type="deposit",
                amount=need, balance_after=main.main_wallet_balance,
                description="Deposit via Bank transfer",
            ))
        else:
            logger.info("%smain wallet already funded (FR + account exist)", tag)

        # ── 4. AI-POWERED STAKING PROGRAM lock $1000 ────────────────────────────────────
        if has_fr:
            logger.info("%sFR lock already exists — skipping", tag)
        elif execute:
            logger.info("creating FR lock $%s tenure=%s (commits internally)", FR_PRINCIPAL, FR_TENURE)
            await create_lock(main.id, FR_PRINCIPAL, FR_TENURE, db, acknowledge_bonus_forfeit=True)
        else:
            logger.info("%swould create FR lock $%s tenure=%s", tag, FR_PRINCIPAL, FR_TENURE)

        # ── 5. Trading account + $1800 capital ────────────────────────────
        if has_account:
            logger.info("%strading account exists (%s) — skipping create/fund/trades", tag, acct.account_number)
        else:
            group = (await db.execute(
                select(AccountGroup).where(
                    AccountGroup.is_demo == False,          # noqa: E712
                    AccountGroup.is_active == True,          # noqa: E712
                    AccountGroup.is_cent_account == False,   # noqa: E712
                ).order_by(AccountGroup.minimum_deposit)
            )).scalars().first()
            if group is None:
                raise RuntimeError("no standard (non-demo, non-cent) account group found")
            leverage = int(group.leverage_default or 100)
            acct_number = await unique_account_number(db)
            logger.info("%screate trading account %s group=%s leverage=%s", tag, acct_number, group.name, leverage)

            # Move $1800 main wallet -> trading account.
            main.main_wallet_balance = (main.main_wallet_balance or Decimal("0")) - TRADE_CAPITAL
            acct = TradingAccount(
                user_id=main.id, account_group_id=group.id, account_number=acct_number,
                balance=TRADE_CAPITAL, credit=Decimal("0"),
                equity=TRADE_CAPITAL, margin_used=Decimal("0"), free_margin=TRADE_CAPITAL,
                margin_level=Decimal("0"), leverage=leverage, currency="USD",
                is_demo=False, is_active=True, is_promotional=True,
            )
            db.add(acct)
            await db.flush()
            db.add(Transaction(
                user_id=main.id, account_id=acct.id, type="transfer",
                amount=-TRADE_CAPITAL, balance_after=main.main_wallet_balance,
                description=f"Transfer to trading account {acct_number}",
            ))
            db.add(Transaction(
                user_id=main.id, account_id=acct.id, type="transfer",
                amount=TRADE_CAPITAL, balance_after=acct.balance,
                description="Trading capital",
            ))

            # ── 6. CLOSED trades (realized history) ───────────────────────
            realized = Decimal("0")
            for sym, side, lots, op, cp in CLOSED_TRADES:
                inst = (await db.execute(
                    select(Instrument).where(func.upper(Instrument.symbol) == sym.upper())
                )).scalar_one_or_none()
                if inst is None:
                    logger.warning("%sinstrument %s not found — skipping closed trade", tag, sym)
                    continue
                cs = Decimal(str(inst.contract_size or 100000))
                pft = profit_for(side, lots, op, cp, cs).quantize(Decimal("0.01"))
                opened = _now() - timedelta(days=3)
                closed = _now() - timedelta(hours=6)
                pos = Position(
                    account_id=acct.id, instrument_id=inst.id, side=side,
                    status=PositionStatus.CLOSED, lots=lots, open_price=op, close_price=cp,
                    profit=pft, closed_at=closed, created_at=opened, comment="seed",
                )
                db.add(pos)
                await db.flush()
                db.add(TradeHistory(
                    position_id=pos.id, account_id=acct.id, instrument_id=inst.id,
                    side=side, lots=lots, open_price=op, close_price=cp,
                    profit=pft, opened_at=opened, closed_at=closed, close_reason="manual",
                ))
                realized += pft
                logger.info("%s  closed %s %s %s lots -> profit $%s", tag, sym, side.value, lots, pft)
            acct.balance = (acct.balance or Decimal("0")) + realized

            # ── 7. OPEN positions (live floating P&L) ─────────────────────
            margin_used = Decimal("0")
            first_open_pos = None
            for sym, side, lots in OPEN_TRADES:
                inst = (await db.execute(
                    select(Instrument).where(func.upper(Instrument.symbol) == sym.upper())
                )).scalar_one_or_none()
                if inst is None:
                    logger.warning("%sinstrument %s not found — skipping open trade", tag, sym)
                    continue
                cs = Decimal(str(inst.contract_size or 100000))
                px = await live_mid(sym) or FALLBACK_PRICE.get(sym)
                if px is None:
                    logger.warning("%sno price for %s — skipping open trade", tag, sym)
                    continue
                px = px.quantize(Decimal("0.00001"))
                margin = (lots * cs * px) / Decimal(str(acct.leverage))
                if margin > TRADE_CAPITAL * MAX_MARGIN_FRACTION:
                    logger.warning("%s  %s margin $%s > %s%% cap — skipping (check contract_size=%s)",
                                   tag, sym, margin.quantize(Decimal('0.01')),
                                   MAX_MARGIN_FRACTION * 100, cs)
                    continue
                pos = Position(
                    account_id=acct.id, instrument_id=inst.id, side=side,
                    status=PositionStatus.OPEN, lots=lots, open_price=px,
                    profit=Decimal("0"), created_at=_now(), comment="seed",
                )
                db.add(pos)
                await db.flush()
                first_open_pos = first_open_pos or (pos, inst)
                margin_used += margin
                logger.info("%s  open %s %s %s lots @ %s (margin $%s)", tag, sym, side.value, lots, px,
                            margin.quantize(Decimal("0.01")))

            # ── 8. Insurance on the first open position ───────────────────
            if first_open_pos is not None:
                pos, inst = first_open_pos
                fee = Decimal("2.50")
                db.add(InsurancePolicy(
                    user_id=main.id, account_id=acct.id, position_id=pos.id,
                    instrument_id=inst.id, tier="50%", fee=fee, coverage_pct=Decimal("50.00"),
                    max_cap=Decimal("100.00"), risk_score=Decimal("5.0000"),
                    status="active", activated_at=_now(),
                ))
                acct.balance = (acct.balance or Decimal("0")) - fee
                db.add(Transaction(
                    user_id=main.id, account_id=acct.id, type="insurance_fee",
                    amount=-fee, balance_after=acct.balance,
                    description=f"Trade insurance fee — {inst.symbol}",
                ))
                logger.info("%s  insured %s open position, fee $%s", tag, inst.symbol, fee)

            # ── 9. Recompute account equity/margin (engine refreshes live) ─
            acct.margin_used = margin_used
            acct.equity = (acct.balance or Decimal("0")) + (acct.credit or Decimal("0"))
            acct.free_margin = acct.equity - margin_used
            acct.margin_level = (
                (acct.equity / margin_used * Decimal("100")) if margin_used > 0 else Decimal("9999")
            )
            logger.info("%s  account balance=$%s margin_used=$%s equity=$%s", tag,
                        acct.balance.quantize(Decimal("0.01")),
                        acct.margin_used.quantize(Decimal("0.01")),
                        acct.equity.quantize(Decimal("0.01")))

        # ── 10. IB profile for the target ─────────────────────────────────
        ib = (await db.execute(
            select(IBProfile).where(IBProfile.user_id == main.id)
        )).scalar_one_or_none()
        if ib is None:
            ib = IBProfile(
                user_id=main.id, referral_code=main.referral_code or gen_code(),
                parent_ib_id=None, level=1, is_active=True,
                total_earned=Decimal("0"), pending_payout=Decimal("0"),
            )
            db.add(ib)
            await db.flush()
            db.add(IBApplication(user_id=main.id, status="approved", approved_at=_now()))
            logger.info("%sIB profile created + application approved (code=%s)", tag, ib.referral_code)
        else:
            logger.info("%sIB profile already exists (code=%s) — skipping", tag, ib.referral_code)

        # ── 11. Downline users + referral + IB commission ─────────────────
        ref_credited = Decimal("0")
        ib_credited = Decimal("0")
        for email, fn, ln in DOWNLINE:
            existing = (await db.execute(
                select(User).where(func.lower(User.email) == email.lower())
            )).scalar_one_or_none()
            if existing is not None:
                logger.info("%s  downline %s already exists — skipping", tag, email)
                continue
            child = User(
                email=email, password_hash=hash_password(secrets.token_urlsafe(12)),
                first_name=fn, last_name=ln, role="user", status="active",
                kyc_status="approved", email_verified=True, email_verified_at=_now(),
                is_promotional=True, referral_code=gen_code(),
                referred_by_user_id=main.id,
                referral_qualified_at=_now(), referral_claimed_at=_now(),
                main_wallet_balance=Decimal("0"),
            )
            db.add(child)
            await db.flush()
            db.add(Referral(referrer_id=main.id, referred_id=child.id, ib_profile_id=ib.id))
            db.add(IBCommission(
                ib_id=ib.id, source_user_id=child.id, amount=IB_COMMISSION_EACH,
                mlm_level=1, status="paid", commission_type="trade",
            ))
            ref_credited += REFERRAL_BOUNTY_EACH
            ib_credited += IB_COMMISSION_EACH
            logger.info("%s  downline %s created (referral $%s, ib $%s)", tag, email,
                        REFERRAL_BOUNTY_EACH, IB_COMMISSION_EACH)

        if ref_credited > 0:
            main.referral_commission_balance = (main.referral_commission_balance or Decimal("0")) + ref_credited
            main.ib_commission_balance = (main.ib_commission_balance or Decimal("0")) + ib_credited
            ib.total_earned = (ib.total_earned or Decimal("0")) + ib_credited
            logger.info("%scredited target: referral +$%s, ib +$%s", tag, ref_credited, ib_credited)

        # ── Commit / rollback ─────────────────────────────────────────────
        if execute:
            await db.commit()
            logger.info("DONE — committed. Target: %s / password as provided.", TARGET_EMAIL)
        else:
            await db.rollback()
            logger.info("[dry-run] rolled back — no changes written. Re-run with --execute to apply.")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Seed the promotional demo account.")
    p.add_argument("--execute", action="store_true", help="actually write (default: dry-run)")
    args = p.parse_args()
    asyncio.run(run(execute=args.execute))
