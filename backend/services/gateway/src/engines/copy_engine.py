"""Copy Trade Engine — Replicates master trades to investor sub-accounts.

Architecture:
- Manager trades one master TradingAccount; positions live as Position rows.
- This engine polls ~every 2s, diffs master open positions vs in-memory snapshot,
  opens/closes child positions on each linked investor account.
- Lot scaling is driven by InvestorAllocation.copy_type (signal | pamm | mam), not mixed.
- Master positions are never modified by this engine.

Performance fee runs on close only (see _close_copy).
"""
import asyncio
import json
import logging
import unittest
from decimal import Decimal
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import UUID
from collections import defaultdict
from typing import Optional, Tuple

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.database import AsyncSessionLocal
from packages.common.src.models import (
    MasterAccount, InvestorAllocation, CopyTrade, Position, PositionStatus,
    TradingAccount, TradeHistory, Transaction, Order,
)
from packages.common.src.redis_client import redis_client, PriceChannel
from packages.common.src.admin_fees import credit_admin_fee

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("copy-engine")

MIN_COPY_LOT = 0.01
COPY_COMMENT_PREFIX = "Copy of master position "
# Cluster-wide lock key so only one gateway worker processes copy trades at a
# time — with --workers=N each worker would otherwise duplicate every mirror.
COPY_ENGINE_LOCK_KEY = "copy_engine:cycle_lock"
COPY_ENGINE_LOCK_TTL = 10


def resolve_copy_type(allocation: InvestorAllocation, master: MasterAccount) -> str:
    """Effective copy mode: stored copy_type, else legacy inference from master.master_type."""
    raw = allocation.copy_type
    if raw:
        s = str(raw).strip().lower()
        if s in ("signal", "pamm", "mam"):
            return s
    mt = (master.master_type or "signal_provider").lower()
    if mt == "pamm":
        return "pamm"
    if mt == "mamm":
        return "mam"
    return "signal"


class CopyTradeEngine:
    def __init__(self):
        self._running = False
        self._master_positions: dict[str, set[str]] = defaultdict(set)

    @staticmethod
    def compute_lot_size(
        master_lots: float,
        master_account: TradingAccount,
        investor_allocation: InvestorAllocation,
        investor_account: TradingAccount,
        *,
        total_pool: float,
        copy_type: str,
    ) -> Tuple[Optional[float], Optional[str]]:
        """
        Raw scaled lots for one investor, rounded to 2 decimals.
        Returns (lots, None) or (None, skip_reason).
        """
        ml = float(master_lots or 0)
        if ml <= 0:
            return None, "zero_master_lots"

        ct = (copy_type or "signal").lower()

        if ct == "signal":
            inv_eq = float(investor_account.equity or investor_account.balance or 0)
            if inv_eq <= 0:
                return None, "signal_zero_investor_equity"
            mst_eq = float(master_account.equity or master_account.balance or 0)
            if mst_eq <= 0:
                return None, "signal_zero_master_equity"
            raw = ml * (inv_eq / mst_eq)
        elif ct == "pamm":
            if total_pool <= 0:
                return None, "pamm_zero_total_pool"
            amt = float(investor_allocation.allocation_amount or 0)
            raw = ml * (amt / total_pool)
        elif ct == "mam":
            # Direct lot multiplier — if the investor set one (e.g. 0.5
            # = always take half the master's lot every trade), it
            # wins outright over the pct-of-pool path. This is the
            # "tell me exactly what lot to copy" model.
            direct = getattr(investor_allocation, "lot_multiplier", None)
            if direct is not None:
                try:
                    mult = float(direct)
                except (TypeError, ValueError):
                    mult = 0.0
                if mult > 0:
                    raw = ml * mult
                else:
                    return None, "mam_zero_lot_multiplier"
            else:
                # Legacy pct-of-pool path (volume scaling %).
                if total_pool <= 0:
                    return None, "mam_zero_total_pool"
                pct = (
                    float(investor_allocation.allocation_pct)
                    if investor_allocation.allocation_pct is not None
                    else 100.0
                )
                if pct == 0:
                    return None, "mam_zero_allocation_pct"
                amt = float(investor_allocation.allocation_amount or 0)
                pool_share_lots = ml * (amt / total_pool)
                raw = pool_share_lots * (pct / 100.0)
        else:
            return None, f"unknown_copy_type:{ct}"

        rounded = round(raw, 2)
        if rounded < MIN_COPY_LOT:
            return None, "below_min_lot_0_01"
        return rounded, None

    async def start(self):
        self._running = True
        logger.info("Copy Trade Engine started")
        asyncio.create_task(self._run())

    async def stop(self):
        self._running = False

    async def _run(self):
        while self._running:
            lock_acquired = False
            try:
                # Cluster-wide leader lock — prevents duplicate mirroring when
                # gateway runs with --workers=N.
                lock_acquired = bool(
                    await redis_client.set(
                        COPY_ENGINE_LOCK_KEY, "1",
                        ex=COPY_ENGINE_LOCK_TTL, nx=True,
                    )
                )
                if not lock_acquired:
                    await asyncio.sleep(1)
                    continue

                async with AsyncSessionLocal() as db:
                    # Global orphan sweep — close any follower mirror whose
                    # master position is already closed, even if the master
                    # has no active followers left (e.g. last investor
                    # withdrew while master still had open positions).
                    await self._global_orphan_sweep(db)

                    masters = await db.execute(
                        select(MasterAccount).where(
                            MasterAccount.status.in_(["approved", "active"]),
                            MasterAccount.followers_count > 0,
                        )
                    )
                    for master in masters.scalars().all():
                        await self.process_master(master, db)
                    await db.commit()
            except Exception as e:
                logger.error("Copy engine error: %s", e, exc_info=True)
            finally:
                if lock_acquired:
                    try:
                        await redis_client.delete(COPY_ENGINE_LOCK_KEY)
                    except Exception:
                        pass

            await asyncio.sleep(1)

    async def _global_orphan_sweep(self, db: AsyncSession) -> None:
        """Close any open CopyTrade whose master Position is already closed,
        regardless of which master it belongs to. Guarantees stuck follower
        mirrors recover even if the master has been deactivated or has zero
        active followers now."""
        q = await db.execute(
            select(CopyTrade, MasterAccount)
            .join(Position, CopyTrade.master_position_id == Position.id)
            .join(InvestorAllocation, CopyTrade.investor_allocation_id == InvestorAllocation.id)
            .join(MasterAccount, InvestorAllocation.master_id == MasterAccount.id)
            .where(
                CopyTrade.status == "open",
                Position.status != "open",
            )
        )
        rows = list(q.all())
        if not rows:
            return
        logger.info("Global orphan sweep: closing %d stuck copy mirror(s)", len(rows))
        for copy, master in rows:
            try:
                await self._close_copy(copy, master, db)
            except Exception as e:
                logger.error("Global orphan sweep failed for copy=%s: %s", copy.id, e)

    async def _sum_active_allocation_pool(self, master_id: UUID, db: AsyncSession) -> float:
        q = await db.execute(
            select(func.coalesce(func.sum(InvestorAllocation.allocation_amount), 0)).where(
                InvestorAllocation.master_id == master_id,
                InvestorAllocation.status == "active",
            )
        )
        return float(q.scalar() or 0)

    async def process_master(self, master: MasterAccount, db: AsyncSession) -> None:
        """One full sync cycle for a single master: read, diff, open/close children."""
        master_id_str = str(master.id)

        master_positions_q = await db.execute(
            select(Position).where(
                Position.account_id == master.account_id,
                Position.status == PositionStatus.OPEN,
            )
        )
        master_open = {}
        for p in master_positions_q.scalars().all():
            if p.comment and COPY_COMMENT_PREFIX in (p.comment or ""):
                continue
            if p.comment and "Copy of master" in p.comment:
                continue
            master_open[str(p.id)] = p
        current_master_pos_ids = set(master_open.keys())
        prev_master_pos_ids = self._master_positions.get(master_id_str, set())

        investors = await db.execute(
            select(InvestorAllocation).where(
                InvestorAllocation.master_id == master.id,
                InvestorAllocation.status == "active",
            )
        )
        active_investors = investors.scalars().all()
        if not active_investors:
            logger.debug("process_master skip master=%s: no active allocations", master_id_str)
            self._master_positions[master_id_str] = current_master_pos_ids
            return

        master_account = await db.get(TradingAccount, master.account_id)
        if not master_account:
            logger.warning("process_master skip master=%s: master trading account missing", master_id_str)
            return

        total_pool = await self._sum_active_allocation_pool(master.id, db)
        if total_pool <= 0 and any(
            resolve_copy_type(inv, master) in ("pamm", "mam") for inv in active_investors
        ):
            logger.warning(
                "process_master master=%s: total_pool=0, skipping PAMM/MAM opens this cycle",
                master_id_str,
            )

        new_positions = current_master_pos_ids - prev_master_pos_ids
        closed_positions = prev_master_pos_ids - current_master_pos_ids

        for pos_id in new_positions:
            master_pos = master_open[pos_id]
            for investor in active_investors:
                # PAMM investors have no sub-account — funds are pooled on the
                # master's account directly. Profit is distributed to their main
                # wallet when the master closes the trade (see trading_service).
                if resolve_copy_type(investor, master) == "pamm":
                    continue
                investor_account = await db.get(TradingAccount, investor.investor_account_id)
                if not investor_account or not investor_account.is_active:
                    logger.info(
                        "Skip copy open: inactive or missing investor account allocation=%s",
                        investor.id,
                    )
                    continue
                await self._open_copy(
                    master,
                    master_pos,
                    investor,
                    investor_account,
                    master_account,
                    total_pool,
                    db,
                )

        for closed_id in closed_positions:
            copies = await db.execute(
                select(CopyTrade).where(
                    CopyTrade.master_position_id == UUID(closed_id),
                    CopyTrade.status == "open",
                )
            )
            for copy in copies.scalars().all():
                await self._close_copy(copy, master, db)

        # ── Orphan catch-up ────────────────────────────────────────────────
        # In-memory diff (prev vs current) misses closes that happened while
        # the engine was not running (gateway restart, crash, leader rotation
        # when --workers=N + redis lock). Self-heal by closing any CopyTrade
        # whose master position is no longer open but whose follower mirror
        # is still marked open.
        orphan_copies_q = await db.execute(
            select(CopyTrade)
            .join(Position, CopyTrade.master_position_id == Position.id)
            .where(
                Position.account_id == master.account_id,
                CopyTrade.status == "open",
                Position.status != "open",
            )
        )
        orphans = list(orphan_copies_q.scalars().all())
        if orphans:
            logger.info(
                "process_master master=%s: found %d orphaned copy(ies) to close",
                master_id_str, len(orphans),
            )
        for copy in orphans:
            logger.info(
                "Closing orphaned copy: copy_id=%s investor_allocation=%s master_pos=%s",
                copy.id, copy.investor_allocation_id, copy.master_position_id,
            )
            await self._close_copy(copy, master, db)

        self._master_positions[master_id_str] = current_master_pos_ids

    async def _open_copy(
        self,
        master: MasterAccount,
        master_pos: Position,
        investor: InvestorAllocation,
        investor_account: TradingAccount,
        master_account: TradingAccount,
        total_pool: float,
        db: AsyncSession,
    ):
        instrument = master_pos.instrument
        if not instrument:
            logger.warning("Skip copy open: no instrument on master position %s", master_pos.id)
            return

        existing_q = await db.execute(
            select(CopyTrade).where(
                CopyTrade.master_position_id == master_pos.id,
                CopyTrade.investor_allocation_id == investor.id,
                CopyTrade.status == "open",
            )
        )
        if existing_q.scalar_one_or_none():
            return

        side_val = master_pos.side.value if hasattr(master_pos.side, "value") else str(master_pos.side)
        master_lots = float(master_pos.lots or 0)

        ct = resolve_copy_type(investor, master)
        base_lots, skip_reason = self.compute_lot_size(
            master_lots,
            master_account,
            investor,
            investor_account,
            total_pool=total_pool,
            copy_type=ct,
        )
        if base_lots is None:
            logger.info(
                "Skip copy open: allocation=%s master_pos=%s copy_type=%s reason=%s",
                investor.id,
                master_pos.id,
                ct,
                skip_reason,
            )
            return

        copy_lots = float(base_lots)
        lot_step = float(instrument.lot_step or Decimal("0.01"))
        copy_lots = max(lot_step, round(copy_lots / lot_step) * lot_step)

        min_lot = float(instrument.min_lot or Decimal("0.01"))
        max_lot = float(instrument.max_lot or Decimal("100"))
        copy_lots = max(min_lot, min(copy_lots, max_lot))

        if copy_lots < MIN_COPY_LOT:
            logger.info(
                "Skip copy open: allocation=%s master_pos=%s post_step_lots=%s below min %s",
                investor.id,
                master_pos.id,
                copy_lots,
                MIN_COPY_LOT,
            )
            return

        if investor.max_lot_override and copy_lots > float(investor.max_lot_override):
            copy_lots = float(investor.max_lot_override)

        contract_size = float(instrument.contract_size or 100000)
        # Notional / leverage is in the instrument's QUOTE currency
        # (JPY for NZDJPY etc.). Convert to USD before reserving against
        # the investor's free margin, or cross-pair mirrors will
        # over-reserve ~158× on tiny lots and fail the
        # "Insufficient margin for copy" gate spuriously.
        from packages.common.src.trading_service import convert_to_account_currency
        required_margin_raw = Decimal(
            str(copy_lots * contract_size * float(master_pos.open_price) / investor_account.leverage)
        )
        required_margin = await convert_to_account_currency(
            required_margin_raw,
            getattr(instrument, "quote_currency", None),
        )

        if required_margin > (investor_account.free_margin or Decimal("0")):
            logger.warning(
                "Insufficient margin for copy: investor_account=%s allocation=%s master_pos=%s",
                investor.investor_account_id,
                investor.id,
                master_pos.id,
            )
            return

        comment = f"{COPY_COMMENT_PREFIX}{master_pos.id}"

        # Create an Order row so the copy trade is first-class in trading history
        # and so IBCommission.source_trade_id (FK → orders.id) can reference it.
        order = Order(
            account_id=investor_account.id,
            instrument_id=master_pos.instrument_id,
            order_type="market",
            side=side_val,
            status="filled",
            lots=Decimal(str(copy_lots)),
            filled_price=master_pos.open_price,
            filled_at=datetime.now(timezone.utc),
            commission=Decimal("0"),
            comment=comment,
        )
        db.add(order)
        await db.flush()

        position = Position(
            account_id=investor_account.id,
            instrument_id=master_pos.instrument_id,
            order_id=order.id,
            side=side_val,
            status=PositionStatus.OPEN.value,
            lots=Decimal(str(copy_lots)),
            open_price=master_pos.open_price,
            stop_loss=master_pos.stop_loss,
            take_profit=master_pos.take_profit,
            comment=comment,
        )
        db.add(position)
        await db.flush()

        copy_record = CopyTrade(
            master_position_id=master_pos.id,
            investor_allocation_id=investor.id,
            investor_position_id=position.id,
            ratio=Decimal(str(copy_lots / master_lots)) if master_lots > 0 else Decimal("1"),
            status="open",
        )
        db.add(copy_record)

        investor_account.margin_used = (investor_account.margin_used or Decimal("0")) + required_margin
        investor_account.free_margin = investor_account.equity - investor_account.margin_used

        # Copy trades count as real trading volume — flow IB commission up the
        # investor's referrer chain (same rate as regular trades).
        try:
            from .ib_engine import distribute_ib_commission
            await distribute_ib_commission(
                db,
                investor_account.user_id,
                order.id,
                Decimal(str(copy_lots)),
                instrument.symbol,
            )
        except Exception as e:
            logger.error(
                "IB commission distribute failed for copy trade investor=%s order=%s: %s",
                investor.id, order.id, e,
            )

        logger.info(
            "Copy opened: %s %s %s lots investor=%s master_pos=%s copy_type=%s (master %s lots)",
            instrument.symbol,
            side_val,
            copy_lots,
            investor_account.account_number,
            master_pos.id,
            ct,
            master_lots,
        )

    async def _close_copy(self, copy: CopyTrade, master: MasterAccount, db: AsyncSession):
        investor_pos = await db.get(Position, copy.investor_position_id)
        if not investor_pos:
            copy.status = "closed"
            logger.info("Close copy: investor position missing, marking copy closed")
            return

        pos_status = investor_pos.status.value if hasattr(investor_pos.status, "value") else str(investor_pos.status)
        if pos_status != "open":
            copy.status = "closed"
            return

        instrument = investor_pos.instrument
        if not instrument:
            copy.status = "closed"
            logger.warning("Close copy: no instrument on investor position %s", investor_pos.id)
            return

        side_val = investor_pos.side.value if hasattr(investor_pos.side, "value") else str(investor_pos.side)
        close_price = None

        # Prefer the live tick so in-progress closes mirror the master's
        # exit price tightly.
        tick_data = await redis_client.get(PriceChannel.tick_key(instrument.symbol))
        if tick_data:
            try:
                tick = json.loads(tick_data)
                close_price = Decimal(str(tick["bid"])) if side_val == "buy" else Decimal(str(tick["ask"]))
            except (json.JSONDecodeError, KeyError, ValueError):
                close_price = None

        # Orphan catch-up (gateway restart, market closed, tick expired): the
        # master has already closed — use the master position's own close_price
        # so the follower books out at the same level instead of getting stuck
        # forever waiting for a tick.
        if close_price is None:
            master_pos = await db.get(Position, copy.master_position_id)
            if master_pos and master_pos.close_price is not None:
                close_price = master_pos.close_price
                logger.info(
                    "Close copy: using master close_price=%s for %s (no live tick)",
                    close_price, instrument.symbol,
                )

        # Last resort: close at the investor's own open price (zero P&L) rather
        # than leave the position stuck open indefinitely.
        if close_price is None:
            close_price = investor_pos.open_price
            logger.warning(
                "Close copy: no tick and no master close_price for %s — closing at open_price (zero P&L)",
                instrument.symbol,
            )

        contract_size = instrument.contract_size or Decimal("100000")

        if side_val == "buy":
            gross_profit = (close_price - investor_pos.open_price) * investor_pos.lots * contract_size
        else:
            gross_profit = (investor_pos.open_price - close_price) * investor_pos.lots * contract_size
        # Async converter — the sync version silently returned raw JPY
        # for cross pairs (NZDJPY, EURGBP, AUDCAD), which propagated to
        # investor balances as JPY-treated-as-USD and nuked accounts
        # (PT71101447 → −$12k, abhishek negi → −$1.6k). Use the live
        # USD/quote tick from Redis instead.
        from packages.common.src.trading_service import (
            quote_to_account_pnl_async,
            convert_to_account_currency,
        )
        gross_profit = await quote_to_account_pnl_async(
            gross_profit,
            getattr(instrument, "base_currency", None),
            getattr(instrument, "quote_currency", None),
            close_price,
            symbol=getattr(instrument, "symbol", None),
        )

        # Per-investor admin overrides (migration 0052) — admin can carve
        # out bespoke perf-fee / broker-cut economics for a specific
        # investor without touching the master record. NULL = inherit.
        # We resolve the allocation row up-front so the override is read
        # from the same in-flight session that already gives us
        # `alloc.total_profit` later.
        _alloc_for_fee = await db.get(InvestorAllocation, copy.investor_allocation_id)
        eff_perf_pct = master.performance_fee_pct or Decimal("0")
        eff_admin_pct = master.admin_commission_pct or Decimal("0")
        if _alloc_for_fee is not None:
            if _alloc_for_fee.performance_fee_pct_override is not None:
                eff_perf_pct = _alloc_for_fee.performance_fee_pct_override
            if _alloc_for_fee.admin_commission_pct_override is not None:
                eff_admin_pct = _alloc_for_fee.admin_commission_pct_override

        performance_fee = Decimal("0")
        admin_fee = Decimal("0")
        if gross_profit > 0:
            performance_fee = gross_profit * eff_perf_pct / Decimal("100")
            admin_fee = performance_fee * eff_admin_pct / Decimal("100")

        net_profit = gross_profit - performance_fee

        investor_pos.status = PositionStatus.CLOSED.value
        investor_pos.close_price = close_price
        investor_pos.profit = net_profit
        investor_pos.closed_at = datetime.now(timezone.utc)

        investor_account = await db.get(TradingAccount, investor_pos.account_id)
        if investor_account:
            investor_account.balance = (investor_account.balance or Decimal("0")) + net_profit
            # Margin release in USD too — `(lots × cs × price) / leverage`
            # returns notional in quote currency, so for NZDJPY etc. that
            # value is JPY, not USD. Same fix the trader-side close path
            # got in commit c66e1e2. Without this, mirrored cross-pair
            # closes leak margin every cycle.
            margin_release_raw = (investor_pos.lots * contract_size * investor_pos.open_price) / Decimal(
                str(investor_account.leverage)
            )
            margin_release = await convert_to_account_currency(
                margin_release_raw,
                getattr(instrument, "quote_currency", None),
            )
            investor_account.margin_used = max(
                Decimal("0"), (investor_account.margin_used or Decimal("0")) - margin_release
            )
            # Negative Balance Protection for MAM/copy investors — a follower can
            # never lose more than their account holds; the broker absorbs any
            # residual (client 2026-06-19). Caps the investor's loss at their
            # own balance instead of letting a master's blow-up push them
            # negative.
            if investor_account.balance < Decimal("0"):
                logger.warning(
                    "NBP: absorbing %.2f negative balance on copy-investor account %s",
                    float(-investor_account.balance),
                    getattr(investor_account, "account_number", investor_account.id),
                )
                investor_account.balance = Decimal("0")
            investor_account.equity = investor_account.balance + (investor_account.credit or Decimal("0"))
            investor_account.free_margin = investor_account.equity - investor_account.margin_used

        # Reuse the allocation row we already fetched for the override
        # lookup above — saves a redundant DB roundtrip.
        alloc = _alloc_for_fee
        if alloc:
            alloc.total_profit = (alloc.total_profit or Decimal("0")) + net_profit

        history = TradeHistory(
            position_id=investor_pos.id,
            account_id=investor_pos.account_id,
            instrument_id=investor_pos.instrument_id,
            side=investor_pos.side,
            lots=investor_pos.lots,
            open_price=investor_pos.open_price,
            close_price=close_price,
            swap=investor_pos.swap or Decimal("0"),
            commission=investor_pos.commission or Decimal("0"),
            profit=net_profit,
            close_reason="copy_close",
            opened_at=investor_pos.created_at,
            closed_at=datetime.now(timezone.utc),
        )
        db.add(history)

        if investor_account and investor_account.user_id:
            if performance_fee > 0:
                db.add(
                    Transaction(
                        user_id=investor_account.user_id,
                        account_id=investor_account.id,
                        type="commission",
                        amount=-performance_fee,
                        balance_after=investor_account.balance,
                        reference_id=investor_pos.id,
                        description=f"Performance fee ({eff_perf_pct}%) on copy trade",
                    )
                )

        if performance_fee > 0:
            master_account = await db.get(TradingAccount, master.account_id)
            if master_account:
                master_share = performance_fee - admin_fee
                master_account.balance = (master_account.balance or Decimal("0")) + master_share
                master_account.equity = master_account.balance + (master_account.credit or Decimal("0"))
                master_account.free_margin = master_account.equity - (master_account.margin_used or Decimal("0"))

                db.add(
                    Transaction(
                        user_id=master.user_id,
                        account_id=master_account.id,
                        type="ib_commission",
                        amount=master_share,
                        balance_after=master_account.balance,
                        reference_id=investor_pos.id,
                        description="Performance fee earned from copy trade",
                    )
                )

                if admin_fee > 0:
                    await credit_admin_fee(
                        db, admin_fee,
                        description=f"Platform commission ({eff_admin_pct}%) from master {master_account.account_number} copy trade",
                        reference_id=investor_pos.id,
                    )
                    # XP_Reward_mechanism slide 6: 50% of the platform's
                    # copy-trade cut is redistributed across the follower's
                    # 10-level referral chain. Best-effort — failure here
                    # must not roll back the trade close.
                    try:
                        from ..services.social_service import distribute_copy_trade_platform_fee
                        await distribute_copy_trade_platform_fee(
                            db,
                            follower_user_id=alloc.investor_user_id,
                            platform_fee=admin_fee,
                            reference_id=investor_pos.id,
                        )
                    except Exception as _e:
                        logger.warning("copy-trade fee network distribution failed: %s", _e)

                # Update master's total fee earned
                master.total_fee_earned = (master.total_fee_earned or Decimal("0")) + master_share

        copy.status = "closed"

        logger.info(
            "Copy closed: %s %s %s lots | gross=%s perf_fee=%s net=%s master_pos=%s",
            instrument.symbol,
            side_val,
            investor_pos.lots,
            gross_profit,
            performance_fee,
            net_profit,
            copy.master_position_id,
        )


copy_engine = CopyTradeEngine()


class _ComputeLotSizeTests(unittest.TestCase):
    """Covers PAMM pool math, MAM scaling, Signal ratio, zero-pool, min-lot guards."""

    def _accounts(self, m_eq, i_eq):
        master = SimpleNamespace(equity=Decimal(str(m_eq)), balance=Decimal(str(m_eq)))
        inv = SimpleNamespace(equity=Decimal(str(i_eq)), balance=Decimal(str(i_eq)))
        return master, inv

    def test_signal_equity_ratio(self):
        ma, ia = self._accounts(10000, 2500)
        alloc = SimpleNamespace(allocation_amount=100, allocation_pct=None, copy_type="signal")
        lots, err = CopyTradeEngine.compute_lot_size(1.0, ma, alloc, ia, total_pool=0, copy_type="signal")
        self.assertIsNone(err)
        self.assertEqual(lots, 0.25)

    def test_signal_zero_investor_equity(self):
        ma, ia = self._accounts(10000, 0)
        alloc = SimpleNamespace(allocation_amount=100, allocation_pct=None, copy_type="signal")
        lots, err = CopyTradeEngine.compute_lot_size(1.0, ma, alloc, ia, total_pool=0, copy_type="signal")
        self.assertIsNone(lots)
        self.assertEqual(err, "signal_zero_investor_equity")

    def test_signal_zero_master_equity(self):
        ma, ia = self._accounts(0, 5000)
        alloc = SimpleNamespace(allocation_amount=100, allocation_pct=None, copy_type="signal")
        lots, err = CopyTradeEngine.compute_lot_size(1.0, ma, alloc, ia, total_pool=0, copy_type="signal")
        self.assertIsNone(lots)
        self.assertEqual(err, "signal_zero_master_equity")

    def test_pamm_pool_share(self):
        ma, ia = self._accounts(1, 1)
        alloc = SimpleNamespace(allocation_amount=3000, allocation_pct=None, copy_type="pamm")
        lots, err = CopyTradeEngine.compute_lot_size(1.0, ma, alloc, ia, total_pool=10000, copy_type="pamm")
        self.assertIsNone(err)
        self.assertEqual(lots, 0.3)

    def test_pamm_zero_pool(self):
        ma, ia = self._accounts(1, 1)
        alloc = SimpleNamespace(allocation_amount=100, allocation_pct=None, copy_type="pamm")
        lots, err = CopyTradeEngine.compute_lot_size(1.0, ma, alloc, ia, total_pool=0, copy_type="pamm")
        self.assertIsNone(lots)
        self.assertEqual(err, "pamm_zero_total_pool")

    def test_mam_volume_scaling(self):
        ma, ia = self._accounts(1, 1)
        alloc = SimpleNamespace(allocation_amount=5000, allocation_pct=Decimal("150"), copy_type="mam")
        lots, err = CopyTradeEngine.compute_lot_size(1.0, ma, alloc, ia, total_pool=10000, copy_type="mam")
        self.assertIsNone(err)
        self.assertEqual(lots, 0.75)

    def test_mam_zero_allocation_pct(self):
        ma, ia = self._accounts(1, 1)
        alloc = SimpleNamespace(allocation_amount=5000, allocation_pct=Decimal("0"), copy_type="mam")
        lots, err = CopyTradeEngine.compute_lot_size(1.0, ma, alloc, ia, total_pool=10000, copy_type="mam")
        self.assertIsNone(lots)
        self.assertEqual(err, "mam_zero_allocation_pct")

    def test_below_min_lot(self):
        ma, ia = self._accounts(10000, 10)
        alloc = SimpleNamespace(allocation_amount=100, allocation_pct=None, copy_type="signal")
        lots, err = CopyTradeEngine.compute_lot_size(1.0, ma, alloc, ia, total_pool=0, copy_type="signal")
        self.assertIsNone(lots)
        self.assertEqual(err, "below_min_lot_0_01")


if __name__ == "__main__":
    unittest.main()
