"""Risk Engine — Margin monitoring, stop-out, exposure tracking.

Continuously monitors all open positions and accounts for:
- Margin level breaches (margin call at 80%, stop-out at 50%)
- Stop-out execution (close positions if margin level drops below threshold)
- Exposure monitoring (admin's B-book risk per instrument)
- Swap calculation (daily rollover charges)
"""
import asyncio
import json
import logging
from decimal import Decimal
from datetime import datetime, timezone
from collections import defaultdict

from sqlalchemy import select, func
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.database import AsyncSessionLocal
from packages.common.src.models import (
    Position, PositionStatus, TradingAccount, Instrument,
    OrderSide, SwapConfig, Notification, Transaction, User, TradeHistory,
)
from packages.common.src.redis_client import redis_client, PriceChannel
from packages.common.src.config import get_settings
from packages.common.src import corecen_trade_client

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-5s [%(name)s] %(message)s")
logger = logging.getLogger("risk-engine")

try:
    from packages.common.src.instrumentation import init_sentry
    init_sentry("risk-engine")
except Exception:
    pass

settings = get_settings()


class RiskEngine:
    def __init__(self):
        self._running = False
        self._margin_call_sent: set[str] = set()

    async def start(self):
        self._running = True
        logger.info("Risk Engine started")

        await asyncio.gather(
            self._margin_monitor(),
            self._exposure_monitor(),
            self._swap_calculator(),
        )

    async def stop(self):
        self._running = False

    async def _margin_monitor(self):
        """Monitor margin levels for all accounts with open positions."""
        logger.info("Margin monitor started")
        while self._running:
            try:
                async with AsyncSessionLocal() as db:
                    result = await db.execute(
                        select(TradingAccount).where(
                            TradingAccount.margin_used > 0,
                            TradingAccount.is_active == True,
                        )
                    )
                    accounts = result.scalars().all()

                    # Load every open position for these accounts in ONE
                    # query with the instrument eager-loaded, then group by
                    # account in Python (audit perf #10). Previously this
                    # ran one positions query per account AND lazy-loaded
                    # pos.instrument per position — an N+1 that scaled with
                    # both account and position count every single tick.
                    positions_by_account: dict = defaultdict(list)
                    if accounts:
                        acct_ids = [a.id for a in accounts]
                        all_pos_result = await db.execute(
                            select(Position)
                            .options(selectinload(Position.instrument))
                            .where(
                                Position.account_id.in_(acct_ids),
                                Position.status == PositionStatus.OPEN,
                            )
                        )
                        for p in all_pos_result.scalars().all():
                            positions_by_account[p.account_id].append(p)

                    for account in accounts:
                        positions = positions_by_account.get(account.id, [])
                        if not positions:
                            continue

                        unrealized_pnl = Decimal("0")
                        # Stale-price guard (audit infra-C1): if ANY open
                        # position has a missing or stale tick we must NOT
                        # act on a partial / frozen equity picture — a dead
                        # feed could otherwise trigger phantom mass stop-outs
                        # or hide a real one. Flag it and skip the stop-out /
                        # margin-call decision for this account this tick.
                        import time as _time
                        STALE_PRICE_SECONDS = 60.0
                        now_epoch = _time.time()
                        stale_price = False
                        for pos in positions:
                            tick_data = await redis_client.get(PriceChannel.tick_key(pos.instrument.symbol))
                            if not tick_data:
                                stale_price = True
                                continue
                            tick = json.loads(tick_data)
                            # Tick timestamp is ISO; treat anything older than
                            # STALE_PRICE_SECONDS as stale.
                            _ts = tick.get("timestamp")
                            if _ts:
                                try:
                                    from datetime import datetime as _dt
                                    _tt = _dt.fromisoformat(str(_ts).replace("Z", "+00:00"))
                                    if (now_epoch - _tt.timestamp()) > STALE_PRICE_SECONDS:
                                        stale_price = True
                                except (ValueError, TypeError):
                                    pass
                            current_price = Decimal(str(tick["bid"])) if pos.side == OrderSide.BUY else Decimal(str(tick["ask"]))

                            if pos.side == OrderSide.BUY:
                                pnl = (current_price - pos.open_price) * pos.lots * pos.instrument.contract_size
                            else:
                                pnl = (pos.open_price - current_price) * pos.lots * pos.instrument.contract_size
                            # Async converter so cross pairs (NZDJPY, EURGBP) get
                            # the proper FX leg from Redis instead of being
                            # treated as already-USD — otherwise margin-call /
                            # stop-out triggers fire on phantom losses.
                            from packages.common.src.trading_service import quote_to_account_pnl_async
                            pnl = await quote_to_account_pnl_async(
                                pnl,
                                getattr(pos.instrument, "base_currency", None),
                                getattr(pos.instrument, "quote_currency", None),
                                current_price,
                                symbol=getattr(pos.instrument, "symbol", None),
                            )
                            unrealized_pnl += pnl

                        # Negative Balance Protection (client 2026-06-20): a
                        # trading account's realized balance must never be
                        # negative. Clamp here so any account that drifted below
                        # zero (e.g. old swap charges) self-heals every tick.
                        if account.balance is not None and account.balance < 0:
                            account.balance = Decimal("0")
                        equity = account.balance + account.credit + unrealized_pnl
                        margin_level = (equity / account.margin_used * 100) if account.margin_used > 0 else Decimal("9999")

                        account.equity = equity
                        account.free_margin = equity - account.margin_used
                        account.margin_level = margin_level

                        # Never liquidate / warn on a stale-price equity
                        # figure — wait for a fresh feed. Equity fields above
                        # are still updated (best-effort display), but no
                        # irreversible action fires.
                        if stale_price:
                            logger.warning(
                                "Skipping stop-out/margin-call for account %s — stale/missing price feed",
                                account.account_number,
                            )
                            continue

                        from packages.common.src.settings_store import get_float_setting
                        stop_out = await get_float_setting("stop_out_level", settings.STOP_OUT_LEVEL)
                        margin_call = await get_float_setting("margin_call_level", settings.MARGIN_CALL_LEVEL)

                        if margin_level <= Decimal(str(stop_out)):
                            await self._execute_stop_out(account, positions, db)

                        elif margin_level <= Decimal(str(margin_call)):
                            acct_key = str(account.id)
                            if acct_key not in self._margin_call_sent:
                                self._margin_call_sent.add(acct_key)
                                notif = Notification(
                                    user_id=account.user_id,
                                    title="Margin Call Warning",
                                    message=f"Your margin level is at {margin_level:.1f}%. Please add funds or close positions.",
                                    type="margin_call",
                                )
                                db.add(notif)

                                await redis_client.publish(f"account:{account.id}", json.dumps({
                                    "type": "margin_call",
                                    "margin_level": str(margin_level),
                                }))

                                # Email the user — fire-and-forget, never blocks
                                # the risk loop on SMTP latency.
                                if not bool(account.is_demo):
                                    await self._send_margin_call_email(
                                        account=account,
                                        margin_level=margin_level,
                                        equity=equity,
                                        used_margin=account.margin_used,
                                        free_margin=account.free_margin,
                                        db=db,
                                    )
                        else:
                            self._margin_call_sent.discard(str(account.id))

                    await db.commit()

            except Exception as e:
                logger.error(f"Margin monitor error: {e}")

            await asyncio.sleep(1)

    async def _execute_stop_out(self, account: TradingAccount, positions: list[Position], db: AsyncSession):
        """Close positions until margin level is restored above stop-out."""
        logger.warning(f"Stop-out triggered for account {account.account_number}")

        closed_count = 0
        realized_pnl = Decimal("0")

        sorted_positions = sorted(positions, key=lambda p: p.profit)

        for pos in sorted_positions:
            tick_data = await redis_client.get(PriceChannel.tick_key(pos.instrument.symbol))
            if not tick_data:
                continue

            tick = json.loads(tick_data)
            close_price = Decimal(str(tick["bid"])) if pos.side == OrderSide.BUY else Decimal(str(tick["ask"]))

            if pos.side == OrderSide.BUY:
                profit = (close_price - pos.open_price) * pos.lots * pos.instrument.contract_size
            else:
                profit = (pos.open_price - close_price) * pos.lots * pos.instrument.contract_size
            from packages.common.src.trading_service import (
                quote_to_account_pnl_async,
                convert_to_account_currency,
            )
            profit = await quote_to_account_pnl_async(
                profit,
                getattr(pos.instrument, "base_currency", None),
                getattr(pos.instrument, "quote_currency", None),
                close_price,
                symbol=getattr(pos.instrument, "symbol", None),
            )

            pos.status = PositionStatus.CLOSED
            pos.close_price = close_price
            pos.profit = profit
            pos.closed_at = datetime.now(timezone.utc)

            # Record the closed trade so it shows in Closed Positions / history —
            # mirrors the manual-close path in gateway trading_service. Without
            # this, a stop-out silently vanished from the trader's history
            # (client 2026-07-02).
            db.add(TradeHistory(
                position_id=pos.id,
                account_id=pos.account_id,
                instrument_id=pos.instrument_id,
                side=pos.side,
                lots=pos.lots,
                open_price=pos.open_price,
                close_price=close_price,
                swap=pos.swap or Decimal("0"),
                commission=pos.commission or Decimal("0"),
                profit=profit,
                close_reason="stop_out",
                opened_at=pos.created_at,
                closed_at=pos.closed_at,
            ))

            account.balance += profit
            # Release margin in account currency to mirror the USD-converted
            # value used on open. Otherwise stop-outs under-release on JPY
            # crosses, leaving phantom margin_used after every liquidation.
            margin_release_raw = (pos.lots * pos.instrument.contract_size * pos.open_price) / Decimal(str(account.leverage))
            margin_release = await convert_to_account_currency(
                margin_release_raw,
                getattr(pos.instrument, "quote_currency", None),
            )
            account.margin_used = max(Decimal("0"), account.margin_used - margin_release)
            account.equity = account.balance + account.credit
            account.free_margin = account.equity - account.margin_used

            closed_count += 1
            realized_pnl += profit

            await redis_client.publish(f"account:{account.id}", json.dumps({
                "type": "stop_out",
                "position_id": str(pos.id),
                "symbol": pos.instrument.symbol,
                "profit": str(profit),
            }))

            logger.info(f"Stop-out closed {pos.instrument.symbol} {pos.side.value}, profit: {profit}")

            # ── A-Book: forward stop-out close to Corecen LP ─────────────
            # Pass Decimal through; Corecen client narrows at JSON boundary.
            _pos_id = str(pos.id)
            _cp = close_price
            _pnl = profit
            _is_demo = bool(account.is_demo)

            async def _forward_stopout(pid=_pos_id, cp=_cp, pnl=_pnl, is_demo=_is_demo):
                # Demo account stop-outs never hit LP.
                if is_demo:
                    return
                try:
                    async with AsyncSessionLocal() as bg_db:
                        u = (await bg_db.execute(
                            select(User).where(User.id == account.user_id)
                        )).scalar_one_or_none()
                        if u and (u.book_type or "B") == "A":
                            await corecen_trade_client.forward_trade_close(
                                position_id=pid, close_price=cp,
                                pnl=pnl, closed_by="STOP_OUT",
                            )
                except Exception as exc:
                    logger.error("[A-BOOK] Stop-out close forward failed: %s", exc)

            asyncio.create_task(_forward_stopout())

            margin_level = (account.equity / account.margin_used * 100) if account.margin_used > 0 else Decimal("9999")
            from packages.common.src.settings_store import get_float_setting as _gfs
            _so = await _gfs("stop_out_level", settings.STOP_OUT_LEVEL)
            if margin_level > Decimal(str(_so)):
                break

        # ── Negative Balance Protection ──────────────────────────────────
        # After liquidating, the broker absorbs any residual loss — a trader can
        # NEVER owe money / go below zero (client 2026-06-19; standard at
        # regulated brokers). A fast/gapping market can close the last position
        # below break-even, so clamp a negative balance back to 0.
        if account.balance < Decimal("0"):
            logger.warning(
                "NBP: absorbing %.2f negative balance on account %s after stop-out",
                float(-account.balance), account.account_number,
            )
            account.balance = Decimal("0")
        account.equity = account.balance + (account.credit or Decimal("0"))
        account.free_margin = account.equity - (account.margin_used or Decimal("0"))

        # After the stop-out loop ends — email the user a summary. Skipped on
        # demo accounts, and on the no-op case where nothing was actually
        # closed (defensive — shouldn't happen but cheap to guard).
        if closed_count > 0 and not bool(account.is_demo):
            await self._send_stop_out_email(
                account=account,
                closed_count=closed_count,
                realized_pnl=realized_pnl,
                new_equity=account.equity,
                db=db,
            )

    async def _send_margin_call_email(
        self,
        *,
        account: TradingAccount,
        margin_level: Decimal,
        equity: Decimal,
        used_margin: Decimal,
        free_margin: Decimal,
        db: AsyncSession,
    ) -> None:
        try:
            from packages.common.src.smtp_mail import (
                send_email, smtp_configured, fire_and_forget,
            )
            if not smtp_configured():
                return
            user_q = await db.execute(select(User).where(User.id == account.user_id))
            user = user_q.scalar_one_or_none()
            if not user or not user.email:
                return
            from packages.common.src.email_templates import render_margin_call
            st = get_settings()
            subject, html, text = render_margin_call(
                first_name=user.first_name,
                account_number=account.account_number,
                margin_level_pct=float(margin_level),
                equity=equity,
                used_margin=used_margin,
                free_margin=free_margin,
                currency=account.currency or "USD",
                trader_app_url=getattr(st, "TRADER_APP_URL", None) or "https://trade.swisdex.com",
            )
            fire_and_forget(send_email(user.email, subject, html, text=text, category="account"))
        except Exception as e:
            logger.debug("margin call email failed acct=%s: %s", account.account_number, e)

    async def _send_stop_out_email(
        self,
        *,
        account: TradingAccount,
        closed_count: int,
        realized_pnl: Decimal,
        new_equity: Decimal,
        db: AsyncSession,
    ) -> None:
        try:
            from packages.common.src.smtp_mail import (
                send_email, smtp_configured, fire_and_forget,
            )
            if not smtp_configured():
                return
            user_q = await db.execute(select(User).where(User.id == account.user_id))
            user = user_q.scalar_one_or_none()
            if not user or not user.email:
                return
            from packages.common.src.email_templates import render_stop_out
            st = get_settings()
            subject, html, text = render_stop_out(
                first_name=user.first_name,
                account_number=account.account_number,
                closed_count=closed_count,
                realized_pnl=realized_pnl,
                new_equity=new_equity,
                currency=account.currency or "USD",
                trader_app_url=getattr(st, "TRADER_APP_URL", None) or "https://trade.swisdex.com",
            )
            fire_and_forget(send_email(user.email, subject, html, text=text, category="account"))
        except Exception as e:
            logger.debug("stop-out email failed acct=%s: %s", account.account_number, e)

    async def _exposure_monitor(self):
        """Track the admin's net exposure per instrument (B-book risk)."""
        logger.info("Exposure monitor started")
        while self._running:
            try:
                async with AsyncSessionLocal() as db:
                    result = await db.execute(
                        select(Position)
                        .options(selectinload(Position.instrument))  # avoid per-position lazy load (N+1)
                        .where(Position.status == PositionStatus.OPEN)
                    )
                    positions = result.scalars().all()

                    exposure: dict[str, dict] = defaultdict(lambda: {"long_lots": Decimal("0"), "short_lots": Decimal("0"), "long_value": Decimal("0"), "short_value": Decimal("0")})

                    for pos in positions:
                        symbol = pos.instrument.symbol
                        tick_data = await redis_client.get(PriceChannel.tick_key(symbol))
                        if not tick_data:
                            continue
                        tick = json.loads(tick_data)
                        mid_price = (Decimal(str(tick["bid"])) + Decimal(str(tick["ask"]))) / 2
                        value = pos.lots * pos.instrument.contract_size * mid_price

                        if pos.side == OrderSide.BUY:
                            exposure[symbol]["long_lots"] += pos.lots
                            exposure[symbol]["long_value"] += value
                        else:
                            exposure[symbol]["short_lots"] += pos.lots
                            exposure[symbol]["short_value"] += value

                    exposure_data = {}
                    for symbol, data in exposure.items():
                        net_lots = data["long_lots"] - data["short_lots"]
                        net_value = data["long_value"] - data["short_value"]
                        exposure_data[symbol] = {
                            "long_lots": str(data["long_lots"]),
                            "short_lots": str(data["short_lots"]),
                            "long_value": str(data["long_value"]),
                            "short_value": str(data["short_value"]),
                            "net_lots": str(net_lots),
                            "net_value": str(net_value),
                            "admin_exposure": str(-net_value),
                        }

                    await redis_client.set("exposure:summary", json.dumps(exposure_data))

            except Exception as e:
                logger.error(f"Exposure monitor error: {e}")

            await asyncio.sleep(5)

    async def _swap_calculator(self):
        """Calculate and apply swap charges at rollover time (daily at 21:00 UTC)."""
        logger.info("Swap calculator started")
        while self._running:
            now = datetime.now(timezone.utc)
            if now.hour == 21 and now.minute == 0:
                try:
                    async with AsyncSessionLocal() as db:
                        result = await db.execute(
                            select(Position)
                            .options(selectinload(Position.instrument))  # avoid per-position lazy load (N+1)
                            .where(Position.status == PositionStatus.OPEN)
                        )
                        positions = result.scalars().all()

                        for pos in positions:
                            swap_query = select(SwapConfig).where(
                                SwapConfig.scope == "instrument",
                                SwapConfig.instrument_id == pos.instrument_id,
                                SwapConfig.is_enabled == True,
                            )
                            swap_result = await db.execute(swap_query)
                            swap_config = swap_result.scalar_one_or_none()

                            if not swap_config:
                                inst = pos.instrument
                                if inst and inst.segment_id:
                                    swap_query = select(SwapConfig).where(
                                        SwapConfig.scope == "segment",
                                        SwapConfig.segment_id == inst.segment_id,
                                        SwapConfig.is_enabled == True,
                                    )
                                    swap_result = await db.execute(swap_query)
                                    swap_config = swap_result.scalar_one_or_none()
                            if not swap_config:
                                swap_query = select(SwapConfig).where(
                                    SwapConfig.scope == "default",
                                    SwapConfig.is_enabled == True,
                                )
                                swap_result = await db.execute(swap_query)
                                swap_config = swap_result.scalar_one_or_none()

                            if not swap_config or swap_config.swap_free:
                                continue

                            swap_rate = swap_config.swap_long if pos.side == OrderSide.BUY else swap_config.swap_short
                            swap_amount = swap_rate * pos.lots

                            triple_day = swap_config.triple_swap_day if swap_config.triple_swap_day is not None else 2
                            if now.weekday() == triple_day:
                                swap_amount *= 3

                            pos.swap += swap_amount

                            account = await db.get(TradingAccount, pos.account_id)
                            if account:
                                account.balance += swap_amount

                        await db.commit()
                        logger.info(f"Swap calculated for {len(positions)} positions")

                except Exception as e:
                    logger.error(f"Swap calculation error: {e}")

                await asyncio.sleep(60)
            else:
                await asyncio.sleep(30)


async def main():
    engine = RiskEngine()
    try:
        await engine.start()
    except KeyboardInterrupt:
        await engine.stop()


if __name__ == "__main__":
    asyncio.run(main())
