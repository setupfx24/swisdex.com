"""Overnight leverage fee engine.

Per Trading_Mechanism.docx:
  Fully funded (leverage = 1)  → no overnight fee.
  Leveraged trades             → 0.01% per day on the borrowed portion only.
  Borrowed portion             = notional × (L − 1) / L
  Daily charge                 = borrowed_portion × 0.0001

Skipped:
  - swap_free instruments (InstrumentConfig.swap_free = TRUE)
  - swap_free account groups (Islamic; AccountGroup.swap_free = TRUE)
  - leverage <= 1 (no borrowed portion)

Idempotency: each position has positions.last_swap_at; the engine charges
when (now - last_swap_at) >= 24h, and only one charge fires per 24h window
even if the engine ticks more often.
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Optional

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from packages.common.src.database import AsyncSessionLocal
from packages.common.src.models import (
    AccountGroup, InstrumentConfig, Position, PositionStatus,
    TradingAccount, Transaction, User,
)

logger = logging.getLogger("overnight-fee-engine")

# 0.01% per day from Trading_Mechanism.docx.
DAILY_RATE = Decimal("0.0001")
TICK_INTERVAL = 3600  # check hourly so a deploy mid-day catches up cleanly


class OvernightFeeEngine:
    def __init__(self):
        self._running = False

    async def start(self):
        self._running = True
        logger.info("Overnight fee engine started (rate=%s/day, tick=%ds)", DAILY_RATE, TICK_INTERVAL)
        asyncio.create_task(self._run())

    async def stop(self):
        self._running = False

    async def _run(self):
        from packages.common.src.redis_client import acquire_leader_lock
        while self._running:
            try:
                # Leader lock — under --workers N only one worker charges,
                # else the same position gets double overnight fees
                # (audit C1/C3). TTL covers the charge loop duration.
                if not await acquire_leader_lock("engine:overnight_fee:lock", 60):
                    await asyncio.sleep(TICK_INTERVAL)
                    continue
                async with AsyncSessionLocal() as db:
                    n = await charge_due_positions(db)
                    if n:
                        await db.commit()
                        logger.info("Overnight fee: charged %d positions", n)
            except Exception as e:
                logger.error("Overnight fee engine error: %s", e, exc_info=True)
            await asyncio.sleep(TICK_INTERVAL)


async def charge_due_positions(db: AsyncSession, now: Optional[datetime] = None) -> int:
    """Charge the overnight fee on every open leveraged position whose last
    charge (or open time, if never charged) was ≥24h ago. Returns the
    number of positions charged."""
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=24)

    # Load candidates eagerly with their instrument + account so we can
    # check swap_free without N+1 queries.
    rows = (await db.execute(
        select(Position)
        .options(
            selectinload(Position.instrument),
            selectinload(Position.account).selectinload(TradingAccount.account_group),
        )
        .where(
            Position.status == PositionStatus.OPEN,
            or_(
                Position.last_swap_at.is_(None),
                Position.last_swap_at <= cutoff,
            ),
        )
    )).scalars().all()

    charged = 0
    for pos in rows:
        # Check open time when last_swap_at is NULL — don't charge a position
        # that's been open less than 24h.
        opened = pos.created_at
        if opened is not None and opened.tzinfo is None:
            opened = opened.replace(tzinfo=timezone.utc)
        if pos.last_swap_at is None and opened is not None and opened > cutoff:
            continue

        account = pos.account
        if account is None:
            continue

        # Skip swap-free account groups (Islamic group).
        ag: AccountGroup | None = account.account_group if account else None
        if ag is not None and bool(ag.swap_free):
            pos.last_swap_at = now  # mark seen so we don't re-walk it every tick
            continue

        # Skip users who self-identify as Islamic (User.is_islamic) — they're
        # exempt from overnight charges even if they wound up on a non-Islamic
        # group. Cheap because we already loaded account → User isn't loaded
        # eagerly here, so issue a small lookup once.
        if account.user_id is not None:
            is_islamic = (await db.execute(
                select(User.is_islamic).where(User.id == account.user_id)
            )).scalar_one_or_none()
            if bool(is_islamic):
                pos.last_swap_at = now
                continue

        # Skip swap-free instruments.
        ic = (await db.execute(
            select(InstrumentConfig).where(InstrumentConfig.instrument_id == pos.instrument_id)
        )).scalar_one_or_none()
        if ic is not None and bool(ic.swap_free):
            pos.last_swap_at = now
            continue

        leverage = int(account.leverage or 1)
        if leverage <= 1:
            # Fully funded — never charged. Stamp last_swap_at so the engine
            # doesn't re-evaluate this position every hour for nothing.
            pos.last_swap_at = now
            continue

        instrument = pos.instrument
        if instrument is None:
            continue
        contract_size = Decimal(str(instrument.contract_size or "100000"))
        notional_raw = Decimal(str(pos.lots or 0)) * Decimal(str(pos.open_price or 0)) * contract_size
        if notional_raw <= 0:
            pos.last_swap_at = now
            continue

        # The notional is in the instrument's QUOTE currency (JPY for
        # NZDJPY etc.). Convert to USD before applying the daily rate
        # so cross-pair positions aren't over-charged ~155× (which
        # silently nuked balances to deep negative on positions held
        # for weeks). Same fix pattern as commits c66e1e2 / 3284c59 /
        # a058754 for trader / risk / copy engines.
        from packages.common.src.trading_service import convert_to_account_currency
        notional = await convert_to_account_currency(
            notional_raw,
            getattr(instrument, "quote_currency", None),
        )
        if notional <= 0:
            pos.last_swap_at = now
            continue

        borrowed_fraction = (Decimal(leverage - 1) / Decimal(leverage))
        fee = (notional * borrowed_fraction * DAILY_RATE).quantize(Decimal("0.00000001"))
        if fee <= 0:
            pos.last_swap_at = now
            continue

        # Negative Balance Protection (client 2026-06-20): a swap/overnight fee
        # must never push the balance below zero — charge only what the account
        # actually holds. This is what was slowly driving some accounts negative.
        _bal = Decimal(str(account.balance or 0))
        if _bal <= 0:
            pos.last_swap_at = now
            continue
        if fee > _bal:
            fee = _bal

        # Apply fee — deduct from balance, mark on the position, and write
        # a Transaction row for audit.
        new_balance = _bal - fee
        account.balance = new_balance
        account.equity = new_balance + Decimal(str(account.credit or 0))
        account.free_margin = account.equity - Decimal(str(account.margin_used or 0))
        pos.swap = (Decimal(str(pos.swap or 0))) - fee  # swap is conventionally negative for charges
        pos.last_swap_at = now

        db.add(Transaction(
            user_id=account.user_id,
            account_id=account.id,
            type="swap",
            amount=-fee,
            balance_after=new_balance,
            reference_id=pos.id,
            description=f"Overnight fee {DAILY_RATE * 100}% × borrowed {borrowed_fraction:.4f} × notional {notional:.2f}",
        ))
        charged += 1

    return charged


overnight_fee_engine = OvernightFeeEngine()
