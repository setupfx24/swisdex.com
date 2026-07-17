"""Trading Service — Order placement, position management, margin calculations."""
import asyncio
import json
import logging
from decimal import Decimal
from uuid import UUID
from datetime import datetime

from fastapi import HTTPException, Request
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from packages.common.src.models import (
    Order, OrderType, OrderSide, OrderStatus, Position, PositionStatus,
    TradingAccount, Instrument, InstrumentConfig,
    TradeHistory, Transaction, CopyTrade, UserAuditLog, User,
    MasterAccount,
)
from packages.common.src.instrument_pricing import (
    resolve_commission, resolve_spread_config, symmetric_quote_from_mid,
)
from packages.common.src.insurance.claims import maybe_pay as insurance_maybe_pay
from . import rewards_service
from packages.common.src.database import AsyncSessionLocal
from packages.common.src.redis_client import redis_client, PriceChannel
from packages.common.src.notify import create_notification
from packages.common.src.market_hours import is_market_open
from packages.common.src import corecen_trade_client

logger = logging.getLogger("trading_service")


# ─── Shared helpers ───────────────────────────────────────────────────────

async def get_current_price(symbol: str) -> tuple[Decimal, Decimal]:
    tick_data = await redis_client.get(PriceChannel.tick_key(symbol))
    if not tick_data:
        raise HTTPException(status_code=400, detail=f"No price available for {symbol}")
    tick = json.loads(tick_data)
    return Decimal(str(tick["bid"])), Decimal(str(tick["ask"]))


async def _live_spread_mult(symbol: str) -> Decimal:
    """The live volatility multiplier market-data published with the tick.
    Lets per-user execution apply the SAME market-driven widening that the
    broadcast quote already shows. 1.0 when variable spread is off/calm."""
    try:
        raw = await redis_client.get(PriceChannel.tick_key(symbol))
        if raw:
            m = Decimal(str(json.loads(raw).get("spread_mult", 1) or 1))
            if m > 0:
                return m
    except Exception:
        pass
    return Decimal("1")


async def validate_account(account_id: UUID, user_id: UUID, db: AsyncSession) -> TradingAccount:
    result = await db.execute(
        select(TradingAccount)
        .options(selectinload(TradingAccount.account_group))
        .where(
            TradingAccount.id == account_id,
            TradingAccount.user_id == user_id,
        )
    )
    account = result.scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    if not account.is_active:
        raise HTTPException(status_code=403, detail="Account is not active")
    return account


async def get_instrument(symbol: str, db: AsyncSession) -> Instrument:
    result = await db.execute(
        select(Instrument).where(Instrument.symbol == symbol.upper(), Instrument.is_active == True)
    )
    instrument = result.scalar_one_or_none()
    if not instrument:
        raise HTTPException(status_code=404, detail=f"Instrument {symbol} not found")
    return instrument


def calc_margin(lots: Decimal, price: Decimal, contract_size: Decimal, leverage: int) -> Decimal:
    return (lots * contract_size * price) / Decimal(str(leverage))


def side_val(side) -> str:
    return side.value if hasattr(side, 'value') else str(side)


from packages.common.src.trading_service import (
    quote_to_account_pnl,
    quote_to_account_pnl_async,
    convert_to_account_currency,
)


def calc_pnl(
    side,
    open_price: Decimal,
    close_price: Decimal,
    lots: Decimal,
    contract_size: Decimal,
    instrument=None,
    account_currency: str = "USD",
) -> Decimal:
    sv = side_val(side)
    if sv == "buy":
        raw = (close_price - open_price) * lots * contract_size
    else:
        raw = (open_price - close_price) * lots * contract_size
    if instrument is None:
        return raw
    return quote_to_account_pnl(
        raw,
        getattr(instrument, "base_currency", None),
        getattr(instrument, "quote_currency", None),
        close_price,
        account_currency,
        symbol=getattr(instrument, "symbol", None),
    )


# ─── Orders ───────────────────────────────────────────────────────────────

async def place_order(
    req,
    request: Request,
    user_id: UUID,
    ip_address: str | None,
    db: AsyncSession,
) -> dict:
    from packages.common.src.settings_store import get_bool_setting, get_int_setting, get_float_setting
    from ..engines.ib_engine import distribute_ib_commission

    # --- Parallel: settings from Redis (no DB session needed) ---
    # Global platform caps sit on top of per-instrument limits (InstrumentConfig).
    maintenance, max_trades, max_pending, global_max_lot, global_min_lot = await asyncio.gather(
        get_bool_setting("maintenance_mode", False),
        get_int_setting("max_open_trades", 200),
        get_int_setting("max_pending_orders", 100),
        get_float_setting("max_lot_size", 100.0),
        get_float_setting("min_lot_size", 0.01),
    )
    if maintenance:
        raise HTTPException(status_code=503, detail="Platform is under maintenance. Trading is temporarily disabled.")

    # --- Sequential DB queries (AsyncSession doesn't support concurrent queries) ---
    account = await validate_account(req.account_id, user_id, db)

    # NOTE: account_group.minimum_deposit is a CREATION threshold (set in
    # the account-opening flow). Once an account exists, trading is gated
    # on tradable margin, not on the original deposit minimum — the
    # margin check below + per-order margin requirement enforces that.
    # Don't re-block trading here on balance < minimum_deposit.

    instrument = await get_instrument(req.symbol, db)

    open_count_q = await db.execute(
        select(func.count(Position.id)).where(
            Position.account_id == account.id,
            Position.status == "open",
        )
    )
    if (open_count_q.scalar() or 0) >= max_trades:
        raise HTTPException(status_code=400, detail=f"Maximum open trades ({max_trades}) reached")

    # Global pending-order cap (in addition to open-trade cap above).
    if req.order_type != "market":
        pending_count_q = await db.execute(
            select(func.count(Order.id)).where(
                Order.account_id == account.id,
                Order.status == "pending",
            )
        )
        if (pending_count_q.scalar() or 0) >= max_pending:
            raise HTTPException(
                status_code=400,
                detail=f"Maximum pending orders ({max_pending}) reached",
            )

    # Global lot-size caps (platform-wide floor/ceiling on top of per-instrument limits).
    lots_f = float(req.lots)
    if lots_f > global_max_lot:
        raise HTTPException(
            status_code=400,
            detail=f"Lot size exceeds platform maximum ({global_max_lot})",
        )
    if lots_f < global_min_lot:
        raise HTTPException(
            status_code=400,
            detail=f"Lot size below platform minimum ({global_min_lot})",
        )

    if req.order_type == "market":
        segment_name = instrument.segment.name if instrument.segment else ""
        market_open, closed_reason = is_market_open(
            instrument.symbol, segment_name, instrument.trading_hours
        )
        if not market_open:
            raise HTTPException(
                status_code=400,
                detail=closed_reason or f"Market is closed for {instrument.symbol}. "
                       "You can still place pending (limit/stop) orders.",
            )

    ic_row = await db.execute(
        select(InstrumentConfig).where(InstrumentConfig.instrument_id == instrument.id)
    )
    ic = ic_row.scalar_one_or_none()
    min_lot = ic.min_lot_size if ic and ic.min_lot_size is not None else instrument.min_lot
    max_lot = ic.max_lot_size if ic and ic.max_lot_size is not None else instrument.max_lot
    if ic and ic.is_enabled is False:
        raise HTTPException(status_code=400, detail=f"Trading disabled for {instrument.symbol}")

    if req.lots < min_lot or req.lots > max_lot:
        raise HTTPException(status_code=400, detail=f"Lot size must be between {min_lot} and {max_lot}")

    bid, ask = await get_current_price(instrument.symbol)

    # Spread resolution. The broadcast bid/ask already has INSTRUMENT-
    # level admin spread baked in (market-data → spread_cache.widen).
    # We recompute from mid here using a priority chain:
    #
    #   1. Master pool override — if this account is a MAM/PAMM pool
    #      account AND admin set master.spread_markup_pips, treat that
    #      as THE TOTAL spread (REPLACE the user's account-type spread
    #      entirely). Client decision 2026-06-01: "PAMM/MAM ka spread
    #      alag se lagayega, different not as per account type".
    #
    #   2. Per-user / per-account-type / per-instrument from
    #      resolve_spread_config — for normal trading accounts.
    #
    # Anything outside both falls back to the broadcast bid/ask.
    mid = (bid + ask) / Decimal("2")
    pip = Decimal(str(instrument.pip_size or "0.0001"))
    digits = int(instrument.digits or 5)

    master_override = (await db.execute(
        select(MasterAccount).where(MasterAccount.account_id == account.id)
    )).scalar_one_or_none()

    # Trade-day window enforcement (client: "trading day not working").
    # A PAMM/MAM master may only OPEN positions on the pool account during
    # the admin-configured trading-day window of the month; the rest of
    # the month is the deposit/withdrawal window. Previously the window
    # was configurable but never enforced. Only gates pool accounts; the
    # check fails OPEN on any config error so a misconfig can't freeze
    # trading for everyone.
    if master_override and (master_override.master_type or "").lower() in ("pamm", "mamm"):
        try:
            from .pamm_config_service import get_pamm_config, in_trade_window
            _pcfg = await get_pamm_config()
            _in_window = in_trade_window(_pcfg)
        except Exception as _twe:
            logger.warning("PAMM trade-window check skipped (config error): %s", _twe)
            _in_window = True
        if not _in_window:
            raise HTTPException(
                status_code=400,
                detail=(
                    "PAMM/MAM trading is only allowed on days "
                    f"{_pcfg.get('trade_window_start_day')}–{_pcfg.get('trade_window_end_day')} "
                    "of the month. Today is outside the trading window."
                ),
            )

    # Live volatility multiplier (variable spread) — the same factor the
    # broadcast quote already shows, so the per-scope spread we apply below
    # widens with the market in lock-step with the displayed bid/ask.
    _mult = await _live_spread_mult(instrument.symbol)

    if master_override and master_override.spread_markup_pips:
        # MAM/PAMM pool — master spread is the WHOLE spread, no
        # additive layering. Whatever account_group the pool account
        # was opened under is ignored on purpose.
        try:
            sv_master = Decimal(str(master_override.spread_markup_pips)) * _mult
            new_bid, new_ask = symmetric_quote_from_mid(
                mid, sv_master, "pips", pip, digits, Decimal("0"),
            )
            bid, ask = new_bid, new_ask
        except Exception as _e:
            logger.warning(
                "Master pool spread re-widening failed for %s: %s",
                instrument.symbol, _e,
            )
    else:
        # Regular trading account — per-user / per-account-type wins.
        try:
            sv, st, _pimp = await resolve_spread_config(
                db, instrument,
                user_id=user_id,
                account_group_id=account.account_group_id,
            )
            # ALWAYS derive the quote from the mid with the admin-configured
            # spread — never fall back to the raw broadcast spread. When no
            # spread_config matches, resolve_spread_config returns 0, so
            # sv == 0 → bid == ask == mid → ZERO spread for that instrument
            # (client 2026-06-29: "admin ne set nahi kiya to spread 0 hona
            # chahiye", not the market spread).
            bid, ask = symmetric_quote_from_mid(
                mid, (sv or Decimal("0")) * _mult, st or "pips", pip, digits, Decimal("0"),
            )
        except Exception as _e:
            logger.warning(
                "Per-user spread resolution failed for %s (user=%s): %s",
                instrument.symbol, user_id, _e,
            )

    order = Order(
        account_id=account.id,
        instrument_id=instrument.id,
        order_type=req.order_type,
        side=req.side,
        lots=req.lots,
        price=req.price,
        stop_loss=req.stop_loss,
        take_profit=req.take_profit,
        stop_limit_price=getattr(req, 'stop_limit_price', None),
        comment=req.comment,
        magic_number=getattr(req, 'magic_number', None),
    )

    if req.order_type == "market":
        fill_price = ask if req.side == "buy" else bid

        # Lock the account row FOR UPDATE before the free-margin check +
        # balance/margin mutation, so two concurrent market orders can't
        # both pass `required_margin > free_margin` and over-leverage the
        # account (audit finding C1). Re-read the locked row so the
        # margin math below operates on the serialized state.
        locked_acc = (await db.execute(
            select(TradingAccount)
            .options(selectinload(TradingAccount.account_group))
            .where(TradingAccount.id == account.id)
            .with_for_update()
        )).scalar_one_or_none()
        if locked_acc is not None:
            account = locked_acc

        # Master spread is already baked into bid/ask above (REPLACE
        # mode). The additive markup pass that used to live here is
        # gone — it would have double-counted.

        if req.stop_loss:
            if req.side == "buy" and req.stop_loss >= fill_price:
                raise HTTPException(status_code=400, detail="BUY SL must be below entry price")
            if req.side == "sell" and req.stop_loss <= fill_price:
                raise HTTPException(status_code=400, detail="SELL SL must be above entry price")
        if req.take_profit:
            if req.side == "buy" and req.take_profit <= fill_price:
                raise HTTPException(status_code=400, detail="BUY TP must be above entry price")
            if req.side == "sell" and req.take_profit >= fill_price:
                raise HTTPException(status_code=400, detail="SELL TP must be below entry price")

        # Pass account_group_id so the commission_pct on the user's account
        # tier (Micro/Standard/Pro/Elite) acts as the fallback rack rate when
        # no admin ChargeConfig matches. XP discount also applies.
        commission = await resolve_commission(
            db, instrument, req.lots, fill_price,
            user_id=user_id,
            account_group_id=account.account_group_id,
        )

        # Per-master flat USD-per-lot commission REPLACES resolved commission.
        if master_override and master_override.commission_per_lot_usd:
            commission = Decimal(str(master_override.commission_per_lot_usd)) * Decimal(str(req.lots))

        contract_size = instrument.contract_size or Decimal("100000")
        # Effective leverage = min(account.leverage, instrument cap).
        # The cap layered on top is admin-configurable per instrument via
        # InstrumentConfig.leverage_max (e.g. crypto symbols at 10×, FX
        # majors at 500×). Without this clamp, a user on a 1:500 account
        # could open a 500× BTCUSD position even if admin restricted that
        # symbol to 1:10. Falls back to account.leverage when no per-
        # instrument override is set.
        ic_lev_cap = ic.leverage_max if ic and ic.leverage_max else None
        effective_leverage = (
            min(int(account.leverage), int(ic_lev_cap))
            if ic_lev_cap else int(account.leverage)
        )
        # Cent-account lot scaling (Mig 0069). Standard / ECN / VIP all
        # have multiplier=1 so this is a no-op for them; Cent group has
        # 0.01 so trader's submitted 0.01 lots become 0.0001 effective
        # lots persisted on the Position. Every downstream engine sees
        # the scaled value and does plain math on it — risk, margin,
        # P&L all naturally scale 100× down without per-engine logic.
        ag_mult = Decimal(str(
            getattr(account.account_group, "lot_size_multiplier", None) or 1
        ))
        effective_lots = Decimal(str(req.lots)) * ag_mult
        # Margin from calc_margin is in the instrument's quote currency
        # (e.g. JPY for NZDJPY). Convert to the account currency (USD)
        # before reserving against the balance, otherwise 1 JPY of margin
        # gets reserved as $1 — historically over-charged by ~150× on JPY
        # crosses and broke "Insufficient margin" gating on small lots.
        required_margin_raw = calc_margin(effective_lots, fill_price, contract_size, effective_leverage)
        required_margin = await convert_to_account_currency(
            required_margin_raw,
            getattr(instrument, "quote_currency", None) or (instrument.symbol[3:6].upper() if instrument.symbol and len(instrument.symbol) >= 6 else None),
        )

        unrealized_pnl = Decimal("0")
        open_pos_result = await db.execute(
            select(Position)
            .options(selectinload(Position.instrument))
            .where(
                Position.account_id == account.id,
                Position.status == "open",
            )
        )
        open_positions = open_pos_result.scalars().all()

        # Batch-load all prices in one Redis mget call (instead of N+1 calls)
        if open_positions:
            pos_symbols = list({
                pos.instrument.symbol for pos in open_positions
                if pos.instrument
            })
            tick_keys = [PriceChannel.tick_key(s) for s in pos_symbols]
            tick_values = await redis_client.mget(tick_keys) if tick_keys else []
            price_map: dict[str, tuple[Decimal, Decimal]] = {}
            for sym, val in zip(pos_symbols, tick_values):
                if val:
                    try:
                        d = json.loads(val)
                        price_map[sym] = (Decimal(str(d["bid"])), Decimal(str(d["ask"])))
                    except (json.JSONDecodeError, KeyError):
                        pass

            for pos in open_positions:
                sym = pos.instrument.symbol if pos.instrument else None
                if not sym or sym not in price_map:
                    continue
                p_bid, p_ask = price_map[sym]
                pos_side = pos.side.value if hasattr(pos.side, 'value') else str(pos.side)
                cp = p_bid if pos_side == "buy" else p_ask
                cs = pos.instrument.contract_size if pos.instrument else Decimal("100000")
                raw_q = (
                    (cp - pos.open_price) * pos.lots * cs
                    if pos_side == "buy"
                    else (pos.open_price - cp) * pos.lots * cs
                )
                # Convert quote-currency P&L to account currency (USD)
                # so cross pairs like NZDJPY don't get JPY values treated
                # as dollars when summing equity for the margin check.
                unrealized_pnl += await quote_to_account_pnl_async(
                    raw_q,
                    getattr(pos.instrument, "base_currency", None),
                    getattr(pos.instrument, "quote_currency", None),
                    cp,
                    "USD",
                    symbol=sym,
                )
        real_equity = (account.balance or Decimal("0")) + (account.credit or Decimal("0")) + unrealized_pnl
        real_free_margin = real_equity - (account.margin_used or Decimal("0"))

        account.equity = real_equity
        account.free_margin = real_free_margin

        if required_margin > real_free_margin:
            raise HTTPException(status_code=400, detail="Insufficient margin")

        order.status = "filled"
        order.filled_price = fill_price
        order.filled_at = datetime.utcnow()
        order.commission = commission
        # Broker's gross spread revenue on this fill, in USD — its own number,
        # separate from commission (client 2026-06-16). (ask − bid) is the
        # markup the trader crosses; × effective lots × contract size, then
        # converted from the quote currency to USD. Best-effort: never blocks
        # the fill.
        try:
            _sp = Decimal(str(ask)) - Decimal(str(bid))
            if _sp > 0:
                _sr_raw = _sp * effective_lots * contract_size
                order.spread_revenue = await convert_to_account_currency(
                    _sr_raw,
                    getattr(instrument, "quote_currency", None)
                    or (instrument.symbol[3:6].upper() if instrument.symbol and len(instrument.symbol) >= 6 else None),
                )
        except Exception:
            order.spread_revenue = Decimal("0")

        position = Position(
            account_id=account.id,
            instrument_id=instrument.id,
            order_id=order.id,
            side=req.side,
            # Persist the SCALED lots so every downstream engine
            # (margin, P&L, swap, SLTP, copy, risk) sees the cent-
            # adjusted value. The trader-side UI multiplies back by
            # (1 / multiplier) before display so the table still shows
            # the value they typed.
            lots=effective_lots,
            open_price=fill_price,
            stop_loss=req.stop_loss,
            take_profit=req.take_profit,
            status="open",
            commission=commission,
        )
        db.add(position)

        account.margin_used = (account.margin_used or Decimal("0")) + required_margin
        # NBP: opening commission must not push the balance negative.
        account.balance = max(Decimal("0"), (account.balance or Decimal("0")) - commission)
        account.equity = (account.balance or Decimal("0")) + (account.credit or Decimal("0")) + unrealized_pnl
        account.free_margin = account.equity - account.margin_used

    else:
        if not req.price:
            raise HTTPException(status_code=400, detail="Price required for pending orders")
        px = Decimal(str(req.price))
        side_s = str(req.side).lower()

        if req.order_type == "limit":
            if side_s == "buy" and px >= ask:
                raise HTTPException(
                    status_code=400,
                    detail=f"Buy limit must be below the current ask ({ask}). To buy at market, use a market order.",
                )
            if side_s == "sell" and px <= bid:
                raise HTTPException(
                    status_code=400,
                    detail=f"Sell limit must be above the current bid ({bid}). To sell at market, use a market order.",
                )
        elif req.order_type == "stop":
            if side_s == "buy" and px <= ask:
                raise HTTPException(
                    status_code=400,
                    detail=f"Buy stop must be above the current ask ({ask}).",
                )
            if side_s == "sell" and px >= bid:
                raise HTTPException(
                    status_code=400,
                    detail=f"Sell stop must be below the current bid ({bid}).",
                )
        elif req.order_type == "stop_limit":
            if not req.stop_limit_price:
                raise HTTPException(status_code=400, detail="stop_limit_price required for stop-limit orders")
            slp = Decimal(str(req.stop_limit_price))
            if side_s == "buy":
                if px <= ask:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Buy stop price must be above the current ask ({ask}).",
                    )
                if slp >= px:
                    raise HTTPException(
                        status_code=400,
                        detail="Buy stop-limit: limit price must be below the stop price.",
                    )
            else:
                if px >= bid:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Sell stop price must be below the current bid ({bid}).",
                    )
                if slp <= px:
                    raise HTTPException(
                        status_code=400,
                        detail="Sell stop-limit: limit price must be above the stop price.",
                    )

        order.status = "pending"

    db.add(order)
    ua_hdr = (request.headers.get("user-agent") or "").strip()
    db.add(
        UserAuditLog(
            user_id=user_id,
            action_type="ORDER_PLACED",
            ip_address=ip_address,
            device_info=ua_hdr[:2048] if ua_hdr else None,
        )
    )
    await db.commit()

    # Fire-and-forget: notification + IB commission run in background (don't block response)
    if req.order_type == "market":
        # ── A-Book: forward trade to Corecen LP ──────────────────────────
        _pos_id_for_lp = str(position.id)
        _user_id_str = str(user_id)
        _symbol = instrument.symbol
        _side = req.side
        _lots = float(req.lots)
        _fill_price = float(fill_price)
        _sl = float(req.stop_loss) if req.stop_loss else None
        _tp = float(req.take_profit) if req.take_profit else None
        _leverage = account.leverage
        _contract_size = float(instrument.contract_size or 100000)
        _acct_id_str = str(account.id)
        _is_demo = bool(account.is_demo)

        async def _maybe_forward_to_corecen():
            # Demo account trades are always B-book — never forward to LP,
            # regardless of the user's A/B book_type flag.
            if _is_demo:
                return
            try:
                async with AsyncSessionLocal() as bg_db:
                    u = (await bg_db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
                    if u and (u.book_type or "B") == "A":
                        user_name = " ".join(filter(None, [u.first_name, u.last_name])) or ""
                        await corecen_trade_client.forward_trade_open(
                            position_id=_pos_id_for_lp,
                            user_id=_user_id_str,
                            user_email=u.email,
                            user_name=user_name,
                            symbol=_symbol,
                            side=_side,
                            volume=_lots,
                            open_price=_fill_price,
                            sl=_sl,
                            tp=_tp,
                            leverage=_leverage,
                            contract_size=_contract_size,
                            trading_account_id=_acct_id_str,
                        )
            except Exception as e:
                logger.error("[A-BOOK] Failed to forward trade open to Corecen: %s", e)

        asyncio.create_task(_maybe_forward_to_corecen())

        async def _post_order_tasks():
            async with AsyncSessionLocal() as bg_db:
                try:
                    await create_notification(
                        bg_db, user_id,
                        title=f"Order Filled — {instrument.symbol}",
                        message=f"{req.side.upper()} {req.lots} lots @ {order.filled_price}",
                        notif_type="trade", action_url="/trading",
                    )
                except Exception as e:
                    logger.warning("Post-order notification error: %s", e)
                try:
                    await distribute_ib_commission(
                        bg_db, user_id, order.id, req.lots, instrument.symbol
                    )
                except Exception as e:
                    logger.error("IB commission error: %s", e)
                await bg_db.commit()
        asyncio.create_task(_post_order_tasks())

    try:
        await redis_client.publish(f"account:{account.id}", json.dumps({
            "type": "order_update",
            "order_id": str(order.id),
            "status": str(order.status),
        }))
    except Exception:
        pass

    sv = order.side.value if hasattr(order.side, 'value') else str(order.side)
    otype_val = order.order_type.value if hasattr(order.order_type, 'value') else str(order.order_type)
    status_val = order.status.value if hasattr(order.status, 'value') else str(order.status)

    return {
        "id": str(order.id),
        "position_id": str(position.id) if req.order_type == "market" else None,
        "account_id": str(order.account_id),
        "symbol": instrument.symbol,
        "order_type": otype_val,
        "side": sv,
        "status": status_val,
        "lots": float(order.lots),
        "price": float(order.price) if order.price else None,
        "stop_loss": float(order.stop_loss) if order.stop_loss else None,
        "take_profit": float(order.take_profit) if order.take_profit else None,
        "filled_price": float(order.filled_price) if order.filled_price else None,
        "commission": float(order.commission or 0),
        "swap": float(order.swap or 0),
        "comment": order.comment,
        "created_at": order.created_at.isoformat() if order.created_at else None,
    }


async def list_orders(account_id: UUID, user_id: UUID, status: str | None, db: AsyncSession) -> list[dict]:
    await validate_account(account_id, user_id, db)

    query = select(Order).where(Order.account_id == account_id)
    if status:
        query = query.where(Order.status == status)
    query = query.order_by(Order.created_at.desc()).limit(100)

    result = await db.execute(query)
    orders = result.scalars().all()

    items = []
    for o in orders:
        sv = o.side.value if hasattr(o.side, 'value') else str(o.side)
        otype_val = o.order_type.value if hasattr(o.order_type, 'value') else str(o.order_type)
        status_val = o.status.value if hasattr(o.status, 'value') else str(o.status)
        items.append({
            "id": str(o.id),
            "account_id": str(o.account_id),
            "symbol": o.instrument.symbol if o.instrument else "",
            "order_type": otype_val,
            "side": sv,
            "status": status_val,
            "lots": float(o.lots),
            "price": float(o.price) if o.price else None,
            "stop_loss": float(o.stop_loss) if o.stop_loss else None,
            "take_profit": float(o.take_profit) if o.take_profit else None,
            "filled_price": float(o.filled_price) if o.filled_price else None,
            "commission": float(o.commission or 0),
            "swap": float(o.swap or 0),
            "comment": o.comment,
            "created_at": o.created_at.isoformat() if o.created_at else None,
        })
    return items


async def _reject_if_maintenance():
    from packages.common.src.settings_store import get_bool_setting
    if await get_bool_setting("maintenance_mode", False):
        raise HTTPException(
            status_code=503,
            detail="Platform is under maintenance. Trading is temporarily disabled.",
        )


async def modify_order(order_id: UUID, req, user_id: UUID, db: AsyncSession) -> dict:
    await _reject_if_maintenance()
    result = await db.execute(select(Order).where(Order.id == order_id))
    order = result.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    await validate_account(order.account_id, user_id, db)

    # Normalise robustly: SQLAlchemy may hand back an OrderStatus enum member, a
    # raw "pending" string, or a "OrderStatus.PENDING"-style repr depending on
    # version/how the row was written — all must compare equal to "pending".
    status_val = str(getattr(order.status, "value", order.status)).lower().split(".")[-1]
    if status_val != "pending":
        raise HTTPException(status_code=400, detail="Can only modify pending orders")

    if req.stop_loss is not None:
        order.stop_loss = req.stop_loss
    if req.take_profit is not None:
        order.take_profit = req.take_profit
    if req.price is not None:
        order.price = req.price
    if req.lots is not None:
        order.lots = req.lots

    await db.commit()
    return {"message": "Order modified"}


async def cancel_order(order_id: UUID, user_id: UUID, db: AsyncSession) -> dict:
    await _reject_if_maintenance()
    result = await db.execute(select(Order).where(Order.id == order_id))
    order = result.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    await validate_account(order.account_id, user_id, db)

    # Normalise robustly (see modify_order) — enum member, "pending" string, or
    # "OrderStatus.PENDING" repr must all match.
    status_val = str(getattr(order.status, "value", order.status)).lower().split(".")[-1]
    if status_val != "pending":
        logger.info(
            "cancel_order rejected: order %s raw_status=%r normalised=%r",
            order_id, order.status, status_val,
        )
        raise HTTPException(status_code=400, detail="Can only cancel pending orders")

    order.status = "cancelled"
    await db.commit()

    return {"message": "Order cancelled"}


# ─── Positions ────────────────────────────────────────────────────────────

async def user_close_quote(
    db: AsyncSession,
    instrument,
    user_id: UUID,
    account_id: UUID,
    account_group_id,
    tick: dict,
) -> tuple[Decimal, Decimal]:
    """The bid/ask the user would CLOSE at: the live tick MID re-spread with the
    SAME per-user / master spread used at open and close (mirrors the close path
    in close_position). The raw broadcast spread can be WIDER than the user's
    configured spread, so valuing floating P&L off the raw tick showed a bigger
    loss than the user actually realises on close — the position looked like it
    "went straight to loss" and didn't track the displayed price (client
    2026-06-29). Returns (close_bid, close_ask)."""
    raw_bid = Decimal(str(tick["bid"]))
    raw_ask = Decimal(str(tick["ask"]))
    mid = (raw_bid + raw_ask) / Decimal("2")
    pip = Decimal(str(getattr(instrument, "pip_size", None) or "0.0001"))
    digits = int(getattr(instrument, "digits", None) or 5)
    c_bid, c_ask = raw_bid, raw_ask
    mult = await _live_spread_mult(instrument.symbol)
    try:
        master = (await db.execute(
            select(MasterAccount).where(MasterAccount.account_id == account_id)
        )).scalar_one_or_none()
        if master and master.spread_markup_pips:
            c_bid, c_ask = symmetric_quote_from_mid(
                mid, Decimal(str(master.spread_markup_pips)) * mult, "pips", pip, digits, Decimal("0"),
            )
        else:
            sv, st, _ = await resolve_spread_config(
                db, instrument, user_id=user_id, account_group_id=account_group_id,
            )
            # No config → 0 → mid (no market spread), same as open/close.
            c_bid, c_ask = symmetric_quote_from_mid(
                mid, (sv or Decimal("0")) * mult, st or "pips", pip, digits, Decimal("0"),
            )
    except Exception as _e:
        logger.warning(
            "user_close_quote spread resolution failed for %s (user=%s): %s",
            getattr(instrument, "symbol", "?"), user_id, _e,
        )
    return c_bid, c_ask


async def list_positions(account_id: UUID, user_id: UUID, status: str, db: AsyncSession) -> list[dict]:
    # Load the account WITH its group so we know the lot scaling
    # multiplier for the display swap below. Cent accounts persist
    # lots scaled DOWN (Mig 0069 — trader's 0.01 stored as 0.0001);
    # we multiply UP here so the trader sees their original value.
    result = await db.execute(
        select(TradingAccount)
        .options(selectinload(TradingAccount.account_group))
        .where(
            TradingAccount.id == account_id,
            TradingAccount.user_id == user_id,
        )
    )
    account_row = result.scalar_one_or_none()
    if not account_row:
        raise HTTPException(status_code=404, detail="Account not found")
    _lot_mult = Decimal(str(
        getattr(account_row.account_group, "lot_size_multiplier", None) or 1
    ))
    _lot_unscale = (Decimal("1") / _lot_mult) if _lot_mult > 0 else Decimal("1")

    query = select(Position).where(Position.account_id == account_id)
    if status == "open":
        query = query.where(Position.status == "open")
    elif status == "closed":
        query = query.where(Position.status == "closed")

    result = await db.execute(query.order_by(Position.created_at.desc()))
    positions = result.scalars().all()

    # Per-position insurance markers — needed so the trader-side
    # positions panel can render an "Insurance OK in 25s / Expires
    # in 2h 15m" countdown chip without a second request per row.
    # Client report 2026-06-01: "insurance countdown to be shown here".
    insurance_by_pos: dict = {}
    insurance_min_secs = 0.0
    insurance_validity_secs = 0.0
    if positions:
        try:
            from packages.common.src.models import InsurancePolicy
            from packages.common.src.insurance.config import load_config as _load_ins_cfg
            cfg = await _load_ins_cfg()
            insurance_min_secs = float(cfg.min_trade_duration_seconds or 0)
            insurance_validity_secs = float(cfg.policy_validity_seconds or 0)
            pol_rows = (await db.execute(
                select(InsurancePolicy).where(
                    InsurancePolicy.position_id.in_([p.id for p in positions]),
                    InsurancePolicy.status == "active",
                )
            )).scalars().all()
            for p in pol_rows:
                insurance_by_pos[str(p.position_id)] = p
        except Exception as _e:
            # Insurance is best-effort metadata on the position list —
            # never block the panel render if the config / table is
            # unavailable.
            logger.warning("Failed to attach insurance markers: %s", _e)

    response = []
    for pos in positions:
        current_price = None
        profit = float(pos.profit or 0)
        sv = side_val(pos.side)
        contract_size = pos.instrument.contract_size if pos.instrument else Decimal("100000")

        tick_data = await redis_client.get(PriceChannel.tick_key(pos.instrument.symbol))
        pos_status = pos.status.value if hasattr(pos.status, 'value') else str(pos.status)

        if tick_data and pos_status == "open":
            tick = json.loads(tick_data)
            # Value the position at the user's CLOSE quote (mid re-spread with
            # the user's own spread), NOT the raw broadcast bid/ask — otherwise
            # the floating loss is bigger than what close_position realises and
            # the P&L doesn't track the displayed price (client 2026-06-29).
            _cb, _ca = await user_close_quote(
                db, pos.instrument, user_id, pos.account_id,
                account_row.account_group_id, tick,
            )
            current_price = float(_cb) if sv == "buy" else float(_ca)
            # Use the async P&L converter so cross pairs (NZDJPY etc.) get
            # the JPY→USD conversion via live USDJPY tick. The sync version
            # silently returns raw JPY for cross pairs which historically
            # made losses/gains look ~125× too large in the positions panel.
            raw_q = (
                (Decimal(str(current_price)) - pos.open_price) * pos.lots * contract_size
                if sv == "buy"
                else (pos.open_price - Decimal(str(current_price))) * pos.lots * contract_size
            )
            profit = float(await quote_to_account_pnl_async(
                raw_q,
                getattr(pos.instrument, "base_currency", None),
                getattr(pos.instrument, "quote_currency", None),
                Decimal(str(current_price)),
                "USD",
                symbol=pos.instrument.symbol if pos.instrument else None,
            ))

        copy_trade_q = await db.execute(
            select(CopyTrade).where(CopyTrade.investor_position_id == pos.id)
        )
        copy_trade = copy_trade_q.scalar_one_or_none()
        trade_type = "copy_trade" if copy_trade else "self_trade"

        pos_status_val = pos.status.value if hasattr(pos.status, 'value') else str(pos.status)

        # Insurance countdown metadata. Frontend ticks each second
        # against `activated_at + min_trade_duration` (claim-eligible
        # at) and `activated_at + policy_validity` (expires at).
        ins_pol = insurance_by_pos.get(str(pos.id))
        ins_activated_iso = None
        ins_eligible_at_iso = None
        ins_expires_at_iso = None
        if ins_pol is not None:
            activated = ins_pol.activated_at
            if activated is not None:
                if activated.tzinfo is None:
                    from datetime import timezone as _tz
                    activated = activated.replace(tzinfo=_tz.utc)
                ins_activated_iso = activated.isoformat()
                if insurance_min_secs > 0:
                    from datetime import timedelta as _td
                    ins_eligible_at_iso = (
                        activated + _td(seconds=insurance_min_secs)
                    ).isoformat()
                if insurance_validity_secs > 0:
                    from datetime import timedelta as _td
                    ins_expires_at_iso = (
                        activated + _td(seconds=insurance_validity_secs)
                    ).isoformat()

        response.append({
            "id": str(pos.id),
            "account_id": str(pos.account_id),
            "symbol": pos.instrument.symbol if pos.instrument else "",
            "side": sv,
            # Multiply back by 1/multiplier so cent-account traders see
            # the 0.01 they entered, even though storage holds 0.0001.
            "lots": float(Decimal(str(pos.lots)) * _lot_unscale),
            # Raw stored lots (engine units, e.g. 0.0001 on cent). The
            # frontend MUST use this — not the display `lots` above —
            # when recomputing live P&L on each tick, or a cent position
            # shows P&L 100× too large and jumps wildly. Standard
            # accounts: effective_lots == lots (multiplier 1).
            "effective_lots": float(pos.lots),
            "open_price": float(pos.open_price),
            "current_price": current_price,
            "stop_loss": float(pos.stop_loss) if pos.stop_loss else None,
            "take_profit": float(pos.take_profit) if pos.take_profit else None,
            "swap": float(pos.swap or 0),
            "commission": float(pos.commission or 0),
            "profit": profit,
            "status": pos_status_val,
            "contract_size": float(contract_size),
            "trade_type": trade_type,
            "created_at": pos.created_at.isoformat() if pos.created_at else None,
            "closed_at": pos.closed_at.isoformat() if getattr(pos, 'closed_at', None) else None,
            # Insurance markers — null when the position has no active
            # policy. UI shows a countdown only when these are set.
            "insurance_activated_at": ins_activated_iso,
            "insurance_eligible_at": ins_eligible_at_iso,
            "insurance_expires_at": ins_expires_at_iso,
        })

    return response


async def modify_position(position_id: UUID, req, user_id: UUID, db: AsyncSession) -> dict:
    result = await db.execute(select(Position).where(Position.id == position_id))
    pos = result.scalar_one_or_none()
    if not pos:
        raise HTTPException(status_code=404, detail="Position not found")

    acct_result = await db.execute(
        select(TradingAccount).where(
            TradingAccount.id == pos.account_id,
            TradingAccount.user_id == user_id,
        )
    )
    acct_row = acct_result.scalar_one_or_none()
    if not acct_row:
        raise HTTPException(status_code=403, detail="Not your position")

    pos_status = pos.status.value if hasattr(pos.status, 'value') else str(pos.status)
    if pos_status != "open":
        raise HTTPException(status_code=400, detail="Position is not open")

    # MAM follower lock: mirrored positions inherit SL/TP from master; followers
    # cannot modify them independently.
    copy_q = await db.execute(
        select(CopyTrade).where(CopyTrade.investor_position_id == pos.id)
    )
    if copy_q.scalar_one_or_none():
        raise HTTPException(
            status_code=403,
            detail="This is a MAM mirrored trade. SL/TP is controlled by the master.",
        )

    sv = side_val(pos.side)
    updated = False

    # MT5 semantics (client 2026-07-14): SL/TP validate against the CURRENT
    # price the position would close at — NOT the open price — so break-even
    # (SL = entry) and profit-locking stops (BUY SL above entry, below bid)
    # are allowed. A BUY closes at bid: SL must sit below it, TP above it
    # (else the level would trigger instantly); SELL mirrors on the ask.
    # If no live quote exists (dead feed / closed market) we fall back to the
    # conservative open-price rule rather than blindly accepting anything.
    ref_bid = ref_ask = None
    instrument = (await db.execute(
        select(Instrument).where(Instrument.id == pos.instrument_id)
    )).scalar_one_or_none()
    if instrument is not None:
        try:
            raw_tick = await redis_client.get(PriceChannel.tick_key(instrument.symbol))
            if raw_tick:
                ref_bid, ref_ask = await user_close_quote(
                    db, instrument, user_id, pos.account_id,
                    acct_row.account_group_id, json.loads(raw_tick),
                )
        except Exception:
            ref_bid = ref_ask = None

    if req.stop_loss is not None:
        sl = Decimal(str(req.stop_loss))
        if ref_bid is not None:
            if sv == "buy" and sl >= ref_bid:
                raise HTTPException(status_code=400, detail="BUY SL must be below the current price")
            if sv == "sell" and sl <= ref_ask:
                raise HTTPException(status_code=400, detail="SELL SL must be above the current price")
        else:
            if sv == "buy" and sl >= pos.open_price:
                raise HTTPException(status_code=400, detail="BUY SL must be below open price")
            if sv == "sell" and sl <= pos.open_price:
                raise HTTPException(status_code=400, detail="SELL SL must be above open price")
        pos.stop_loss = req.stop_loss
        updated = True

    if req.take_profit is not None:
        tp = Decimal(str(req.take_profit))
        if ref_bid is not None:
            if sv == "buy" and tp <= ref_bid:
                raise HTTPException(status_code=400, detail="BUY TP must be above the current price")
            if sv == "sell" and tp >= ref_ask:
                raise HTTPException(status_code=400, detail="SELL TP must be below the current price")
        else:
            if sv == "buy" and tp <= pos.open_price:
                raise HTTPException(status_code=400, detail="BUY TP must be above open price")
            if sv == "sell" and tp >= pos.open_price:
                raise HTTPException(status_code=400, detail="SELL TP must be below open price")
        pos.take_profit = req.take_profit
        updated = True

    if updated:
        await db.commit()

        # ── A-Book: forward SL/TP update to Corecen LP ──────────────────
        _pos_id_str = str(position_id)
        _new_sl = float(pos.stop_loss) if pos.stop_loss else None
        _new_tp = float(pos.take_profit) if pos.take_profit else None
        _is_demo = bool(acct_row.is_demo)

        async def _maybe_forward_update_to_corecen():
            if _is_demo:
                return
            try:
                async with AsyncSessionLocal() as bg_db:
                    u = (await bg_db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
                    if u and (u.book_type or "B") == "A":
                        await corecen_trade_client.forward_trade_update(
                            position_id=_pos_id_str,
                            sl=_new_sl,
                            tp=_new_tp,
                        )
            except Exception as e:
                logger.error("[A-BOOK] Failed to forward SL/TP update to Corecen: %s", e)

        asyncio.create_task(_maybe_forward_update_to_corecen())

    return {
        "message": "Position modified",
        "stop_loss": float(pos.stop_loss) if pos.stop_loss else None,
        "take_profit": float(pos.take_profit) if pos.take_profit else None,
    }


async def close_position(position_id: UUID, req, user_id: UUID, db: AsyncSession) -> dict:
    # Lock the position row FOR UPDATE so two concurrent close calls
    # can't both pass the status==open check and double-credit P&L /
    # double-release margin (audit finding C1). The lock is held until
    # this function's commit/rollback.
    result = await db.execute(
        select(Position).where(Position.id == position_id).with_for_update()
    )
    pos = result.scalar_one_or_none()
    if not pos:
        raise HTTPException(status_code=404, detail="Position not found")

    acct_result = await db.execute(
        select(TradingAccount)
        .options(selectinload(TradingAccount.account_group))
        .where(
            TradingAccount.id == pos.account_id,
            TradingAccount.user_id == user_id,
        )
        .with_for_update()
    )
    account = acct_result.scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=403, detail="Not your position")

    pos_status = pos.status.value if hasattr(pos.status, 'value') else str(pos.status)
    if pos_status != "open":
        raise HTTPException(status_code=400, detail="Position is not open")

    # MAM follower lock: mirrored positions can only be closed by the master
    # (via the copy engine when the master closes their original position).
    copy_q = await db.execute(
        select(CopyTrade).where(CopyTrade.investor_position_id == pos.id)
    )
    if copy_q.scalar_one_or_none():
        raise HTTPException(
            status_code=403,
            detail="This is a MAM mirrored trade. Only the master can close it.",
        )

    tick_data = await redis_client.get(PriceChannel.tick_key(pos.instrument.symbol))
    if not tick_data:
        raise HTTPException(status_code=400, detail="No price available")

    tick = json.loads(tick_data)
    sv = side_val(pos.side)

    # Re-derive the close bid/ask from the tick MID using the SAME per-scope
    # spread the OPEN path used (master-pool override → resolve_spread_config
    # for user / account-type / instrument / segment). Previously close used
    # the raw broadcast tick, whose spread can differ from what was charged at
    # open — that asymmetry is what made the spread look like it was taken
    # twice. With open and close symmetric, the admin-configured spread is
    # crossed exactly ONCE per round-trip (and it already shows in unrealised
    # P&L the instant the trade opens), so nothing extra is taken at close.
    # Client 2026-06-19. The mid still moves with the live market, so the
    # spread sits around a fluctuating price as intended.
    _raw_bid = Decimal(str(tick["bid"]))
    _raw_ask = Decimal(str(tick["ask"]))
    _mid_c = (_raw_bid + _raw_ask) / Decimal("2")
    _pip_c = Decimal(str(pos.instrument.pip_size or "0.0001"))
    _digits_c = int(pos.instrument.digits or 5)
    c_bid, c_ask = _raw_bid, _raw_ask
    _mult_c = await _live_spread_mult(pos.instrument.symbol)
    try:
        _master_c = (await db.execute(
            select(MasterAccount).where(MasterAccount.account_id == account.id)
        )).scalar_one_or_none()
        if _master_c and _master_c.spread_markup_pips:
            c_bid, c_ask = symmetric_quote_from_mid(
                _mid_c, Decimal(str(_master_c.spread_markup_pips)) * _mult_c, "pips",
                _pip_c, _digits_c, Decimal("0"),
            )
        else:
            _sv_c, _st_c, _ = await resolve_spread_config(
                db, pos.instrument, user_id=user_id,
                account_group_id=account.account_group_id,
            )
            # Always re-spread from the mid; no config → 0 → close at mid (no
            # market spread), symmetric with the open path (client 2026-06-29).
            c_bid, c_ask = symmetric_quote_from_mid(
                _mid_c, (_sv_c or Decimal("0")) * _mult_c, _st_c or "pips", _pip_c, _digits_c, Decimal("0"),
            )
    except Exception as _se:
        logger.warning(
            "Close-side spread resolution failed for %s (user=%s): %s",
            pos.instrument.symbol, user_id, _se,
        )
    close_price = c_bid if sv == "buy" else c_ask
    contract_size = pos.instrument.contract_size if pos.instrument else Decimal("100000")

    # Use the SAME effective leverage formula as the open path so margin
    # release matches the originally locked margin. If admin changed the
    # per-instrument cap between open and close, a small drift is
    # acceptable in practice (current carry-over of trade-time leverage
    # would require a position-level column, which we don't add here).
    _ic_row = await db.execute(
        select(InstrumentConfig).where(InstrumentConfig.instrument_id == pos.instrument_id)
    )
    _ic_close = _ic_row.scalar_one_or_none()
    _ic_lev_cap = _ic_close.leverage_max if _ic_close and _ic_close.leverage_max else None
    _effective_leverage_close = (
        min(int(account.leverage), int(_ic_lev_cap))
        if _ic_lev_cap else int(account.leverage)
    )

    # Trader sends `req.lots` in user-facing units (e.g. 0.01 on a
    # cent account). pos.lots is in engine units (0.0001 after the
    # 0.01 multiplier). Scale the user value DOWN by the account
    # group's multiplier before comparing so the partial-close gate
    # works correctly on cent accounts. Standard accounts have
    # multiplier=1 so the path is unchanged.
    _close_mult = Decimal(str(
        getattr(account.account_group, "lot_size_multiplier", None) or 1
    ))
    # Defence in depth: the schema already enforces lots > 0, but never let a
    # non-positive partial-close volume through here — a negative value would
    # flip the P&L ratio (loss booked as profit) and grow the position.
    if req.lots is not None and Decimal(str(req.lots)) <= 0:
        raise HTTPException(status_code=400, detail="Close volume must be greater than zero")
    _close_req_scaled = (
        Decimal(str(req.lots)) * _close_mult if req.lots else None
    )
    close_lots = _close_req_scaled if _close_req_scaled and _close_req_scaled < pos.lots else pos.lots
    is_partial = close_lots < pos.lots

    # P&L must be in account currency before it touches the balance.
    # The sync calc_pnl silently returns raw JPY for cross pairs
    # (NZDJPY, EURGBP), so a -37 JPY loss came through as -$37 and
    # nuked balances over a few trades. Use the async converter that
    # looks up the live USD/quote rate from Redis.
    sv_for_calc = side_val(pos.side)
    raw_quote = (
        (close_price - pos.open_price) * pos.lots * contract_size
        if sv_for_calc == "buy"
        else (pos.open_price - close_price) * pos.lots * contract_size
    )
    full_profit = await quote_to_account_pnl_async(
        raw_quote,
        getattr(pos.instrument, "base_currency", None),
        getattr(pos.instrument, "quote_currency", None),
        close_price,
        "USD",
        symbol=pos.instrument.symbol if pos.instrument else None,
    )

    # If the market price has already crossed the position's SL/TP level, label
    # this close as SL/TP in trade history instead of "manual" — covers the case
    # where the SL/TP engine was racing and the user's close request landed first.
    detected_reason = "manual"
    if pos.stop_loss:
        sl = Decimal(str(pos.stop_loss))
        if sv == "buy" and close_price <= sl:
            detected_reason = "sl"
        elif sv == "sell" and close_price >= sl:
            detected_reason = "sl"
    if detected_reason == "manual" and pos.take_profit:
        tp = Decimal(str(pos.take_profit))
        if sv == "buy" and close_price >= tp:
            detected_reason = "tp"
        elif sv == "sell" and close_price <= tp:
            detected_reason = "tp"

    if is_partial:
        ratio = close_lots / pos.lots
        partial_profit = full_profit * ratio
        partial_commission = (pos.commission or Decimal("0")) * ratio
        partial_swap = (pos.swap or Decimal("0")) * ratio

        pos.lots -= close_lots

        history = TradeHistory(
            position_id=pos.id,
            account_id=pos.account_id,
            instrument_id=pos.instrument_id,
            side=pos.side,
            lots=close_lots,
            open_price=pos.open_price,
            close_price=close_price,
            swap=partial_swap,
            commission=partial_commission,
            profit=partial_profit,
            close_reason=detected_reason,
            opened_at=pos.created_at,
            closed_at=datetime.utcnow(),
        )
        db.add(history)

        account.balance += partial_profit
        # Margin is released in account currency, so the raw quote-currency
        # notional must be converted back the same way it was reserved on
        # open. Otherwise JPY/CHF-quoted pairs leak margin on every partial
        # close (released $189 when only $1.20 was originally reserved).
        partial_margin_raw = (close_lots * contract_size * pos.open_price) / Decimal(str(_effective_leverage_close))
        partial_margin = await convert_to_account_currency(
            partial_margin_raw,
            getattr(pos.instrument, "quote_currency", None),
        )
        account.margin_used = max(Decimal("0"), (account.margin_used or Decimal("0")) - partial_margin)

        result_msg = f"Partial close: {close_lots} lots"
        result_profit = partial_profit
        result_charges = partial_commission + partial_swap
    else:
        pos.status = "closed"
        pos.close_price = close_price
        pos.profit = full_profit
        pos.closed_at = datetime.utcnow()

        history = TradeHistory(
            position_id=pos.id,
            account_id=pos.account_id,
            instrument_id=pos.instrument_id,
            side=pos.side,
            lots=pos.lots,
            open_price=pos.open_price,
            close_price=close_price,
            swap=pos.swap or Decimal("0"),
            commission=pos.commission or Decimal("0"),
            profit=full_profit,
            close_reason=detected_reason,
            opened_at=pos.created_at,
            closed_at=datetime.utcnow(),
        )
        db.add(history)

        account.balance += full_profit
        # Same JPY/cross-pair correction as the partial-close path above.
        margin_release_raw = (pos.lots * contract_size * pos.open_price) / Decimal(str(_effective_leverage_close))
        margin_release = await convert_to_account_currency(
            margin_release_raw,
            getattr(pos.instrument, "quote_currency", None),
        )
        account.margin_used = max(Decimal("0"), (account.margin_used or Decimal("0")) - margin_release)

        result_msg = "Position closed"
        result_profit = full_profit
        result_charges = (pos.commission or Decimal("0")) + (pos.swap or Decimal("0"))

    # NET P&L for what the trader SEES (close toast, notification, realtime
    # push). The closed-positions list + portfolio already show
    # profit - commission - swap, so the close screen must match (client
    # 2026-06-23). The ledger Transaction below keeps the gross close amount —
    # commission was charged at open and swap overnight as separate rows.
    result_net = result_profit - result_charges

    # Negative Balance Protection — a trader can never owe money. If a close
    # (esp. a gapping/illiquid market) drops the balance below zero, the broker
    # absorbs the residual and the balance resets to 0 (client 2026-06-19).
    if account.balance < Decimal("0"):
        logger.warning(
            "NBP: absorbing %.2f negative balance on account %s after close",
            float(-account.balance), getattr(account, "account_number", account.id),
        )
        account.balance = Decimal("0")

    account.equity = account.balance + (account.credit or Decimal("0"))
    account.free_margin = account.equity - (account.margin_used or Decimal("0"))

    tx = Transaction(
        user_id=user_id,
        account_id=account.id,
        type="profit" if result_profit >= 0 else "loss",
        amount=result_profit,
        balance_after=account.balance,
        reference_id=pos.id,
        description=f"{'Partial ' if is_partial else ''}Close {pos.instrument.symbol} {sv} {close_lots} lots @ {close_price}",
    )
    db.add(tx)

    # Trade insurance — evaluate on full AND partial close. `maybe_pay`
    # swallows its own exceptions so a payout failure can never block the
    # close. For partial close, the claim is naturally proportional because
    # `history.profit` reflects only the partial lots; the policy's
    # remaining cap is enforced inside evaluate_claim.
    await insurance_maybe_pay(db=db, position=pos, history=history)

    # Rewards — bump every mission whose action_kind matches this event,
    # AND credit XP/AC/PS for trade volume (own + 10-level referral chain).
    # Errors here must never block the close, so swallow.
    try:
        await rewards_service.mark_progress(db, user_id, "place_trades", 1)
        # If the close was profitable, count it for win-streak missions.
        if result_profit > 0:
            try:
                await rewards_service.mark_progress(db, user_id, "win_streak", 1)
            except Exception:
                pass
        try:
            notional = Decimal(str(close_lots)) * Decimal(str(contract_size)) * Decimal(str(pos.open_price))
            if notional > 0:
                volume_usd = int(notional)
                await rewards_service.mark_progress(db, user_id, "trade_volume_usd", volume_usd)
                # XP_Reward_mechanism slide 3: award XP/AC/PS by traded
                # volume + distribute through the 10-level referral chain.
                await rewards_service.award_trading_volume_rewards(
                    db, user_id, notional, reference_id=pos.id,
                )
        except Exception as _vol_exc:
            logger.debug("rewards trade-volume distribution failed: %s", _vol_exc)
    except Exception as _exc:
        logger.debug("rewards mark_progress failed: %s", _exc)

    # Personal-referral payout (flat $ amount, gated on the user
    # completing the qualifying trade count — default 3). Idempotent
    # via users.referral_qualified_at.
    #
    # Wrapped in a SAVEPOINT so any failure inside the helper rolls back
    # ONLY the referral writes — the parent transaction (position close
    # + Transaction row + account balance update) stays clean and the
    # outer db.commit() below still succeeds. Earlier wrapping was just
    # try/except, which catches the exception but leaves the session
    # marked rolled-back; the next operation then 500s. Discovered when
    # Close All hit 500 on every position after the first one fired the
    # referral helper.
    try:
        async with db.begin_nested():
            from . import referral_service as _ref
            await _ref.maybe_pay_referral_after_trades(db, user_id)
    except Exception as _re:
        logger.warning("referral payout after close failed: %s", _re)

    await db.commit()

    # Fire-and-forget: notification, Redis publish — don't block response
    _pos_symbol = pos.instrument.symbol if pos.instrument else ""
    _pos_id = str(pos.id)
    _acct_id = str(account.id)
    _profit_str = str(result_net)
    pnl_str = f"+${float(result_net):.2f}" if result_net >= 0 else f"-${abs(float(result_net)):.2f}"

    async def _post_close_tasks():
        async with AsyncSessionLocal() as bg_db:
            try:
                await create_notification(
                    bg_db, user_id,
                    title=f"{'Partial Close' if is_partial else 'Position Closed'} — {_pos_symbol}",
                    message=f"{sv.upper()} {close_lots} lots @ {close_price} | P&L: {pnl_str}",
                    notif_type="trade", action_url="/trading",
                )
            except Exception:
                pass
        try:
            await redis_client.publish(f"account:{_acct_id}", json.dumps({
                "type": "position_closed",
                "position_id": _pos_id,
                "profit": _profit_str,
            }))
        except Exception:
            pass

    asyncio.create_task(_post_close_tasks())
    # ── A-Book: forward close to Corecen LP ──────────────────────────
    _close_price_f = float(close_price)
    _result_profit_f = float(result_profit)
    _close_reason = detected_reason.upper() if detected_reason != "manual" else "USER"
    _is_demo = bool(account.is_demo)

    async def _maybe_forward_close_to_corecen():
        if _is_demo:
            return
        try:
            async with AsyncSessionLocal() as bg_db:
                u = (await bg_db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
                if u and (u.book_type or "B") == "A":
                    await corecen_trade_client.forward_trade_close(
                        position_id=_pos_id,
                        close_price=_close_price_f,
                        pnl=_result_profit_f,
                        closed_by=_close_reason,
                    )
        except Exception as e:
            logger.error("[A-BOOK] Failed to forward trade close to Corecen: %s", e)

    asyncio.create_task(_maybe_forward_close_to_corecen())

    return {
        "message": result_msg,
        "close_price": float(close_price),
        # NET P&L (profit - commission - swap) so the close screen matches the
        # closed-positions list + portfolio. `gross_profit` kept for callers
        # that need the raw price P&L.
        "profit": float(result_net),
        "gross_profit": float(result_profit),
        "lots_closed": float(close_lots),
        "remaining_lots": float(pos.lots) if is_partial else 0,
        "balance": float(account.balance),
    }


# ─── Bulk close (Close All button) ───────────────────────────────────────
# Before this endpoint, the trader UI fired N parallel POST /close calls.
# Each call hit the SAME trading_account row and updated balance / margin
# concurrently — Postgres serialization conflicts (or stale session state)
# caused "Request failed" on most of them. This bulk path closes
# sequentially in a single request so there's no concurrency on the same
# account row, and reports per-position success/failure in one response.
#
# `filter_type`:
#   - "all"     close every open position on the account
#   - "profit"  close only profitable open positions
#   - "loss"    close only losing open positions
#   - "symbol"  close only positions matching one of `symbols` (uppercased)

class BulkCloseError(Exception):
    """Bubbled per-position close failure so the loop can record it."""


async def _bulk_compute_profit(pos: Position, tick: dict) -> Decimal:
    """Reuse the calc_pnl path with the same FX-quote-to-USD conversion."""
    sv = side_val(pos.side)
    close_price = Decimal(str(tick["bid"])) if sv == "buy" else Decimal(str(tick["ask"]))
    contract_size = pos.instrument.contract_size if pos.instrument else Decimal("100000")
    return calc_pnl(pos.side, pos.open_price, close_price, pos.lots, contract_size, instrument=pos.instrument)


async def bulk_close_positions(
    *,
    account_id: UUID,
    user_id: UUID,
    filter_type: str,
    symbols: list[str] | None,
    db: AsyncSession,
) -> dict:
    """Close all (or a filtered subset of) open positions on the account.
    Returns per-position outcomes and a tally."""
    # Ownership + active check on the account once, up front, so all
    # subsequent closes share the same loaded row.
    acct_result = await db.execute(
        select(TradingAccount).where(
            TradingAccount.id == account_id,
            TradingAccount.user_id == user_id,
        )
    )
    account = acct_result.scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")

    # Pull every open position. Order by oldest first so per-position
    # commits land deterministically (helpful if the user opens History
    # right after).
    pos_q = await db.execute(
        select(Position)
        .where(
            Position.account_id == account_id,
            Position.status == "open",
        )
        .order_by(Position.created_at.asc())
    )
    candidates = pos_q.scalars().all()

    # Filter (mirrors the BulkCloseModal options on the trader UI).
    ft = (filter_type or "all").lower()
    sym_set = {s.upper() for s in (symbols or []) if s}

    targets: list[Position] = []
    skipped_no_tick = 0
    skipped_copy = 0
    for pos in candidates:
        if ft == "symbol":
            if not pos.instrument or pos.instrument.symbol.upper() not in sym_set:
                continue
        # MAM follower positions can't be closed by the follower; skip
        # silently so the user doesn't see a spurious "failed" entry for
        # rows the platform contractually prevents them from closing.
        copy_row = (await db.execute(
            select(CopyTrade).where(CopyTrade.investor_position_id == pos.id)
        )).scalar_one_or_none()
        if copy_row:
            skipped_copy += 1
            continue
        targets.append(pos)

    # For profit / loss filter we need each tick — fetch up front in
    # one mget so we don't hit Redis N times inside the loop.
    sym_list = list({p.instrument.symbol for p in targets if p.instrument})
    tick_keys = [PriceChannel.tick_key(s) for s in sym_list]
    tick_values = await redis_client.mget(tick_keys) if tick_keys else []
    tick_map: dict[str, dict] = {}
    for sym, val in zip(sym_list, tick_values):
        if val:
            try:
                tick_map[sym] = json.loads(val)
            except (json.JSONDecodeError, KeyError):
                continue

    if ft in ("profit", "loss"):
        filtered: list[Position] = []
        for pos in targets:
            sym = pos.instrument.symbol if pos.instrument else None
            if not sym or sym not in tick_map:
                skipped_no_tick += 1
                continue
            pnl = await _bulk_compute_profit(pos, tick_map[sym])
            if ft == "profit" and pnl > 0:
                filtered.append(pos)
            elif ft == "loss" and pnl < 0:
                filtered.append(pos)
        targets = filtered

    # Build a fake ClosePositionRequest for full-lot closes since
    # close_position expects req.lots (None → full close).
    from packages.common.src.schemas import ClosePositionRequest
    full_req = ClosePositionRequest()

    closed: list[dict] = []
    failed: list[dict] = []
    total_profit = Decimal("0")
    for pos in targets:
        try:
            res = await close_position(
                position_id=pos.id, req=full_req, user_id=user_id, db=db,
            )
            closed.append({
                "position_id": str(pos.id),
                "symbol": pos.instrument.symbol if pos.instrument else None,
                "profit": float(res.get("profit") or 0),
                "close_price": float(res.get("close_price") or 0),
            })
            total_profit += Decimal(str(res.get("profit") or 0))
        except HTTPException as e:
            failed.append({
                "position_id": str(pos.id),
                "symbol": pos.instrument.symbol if pos.instrument else None,
                "reason": e.detail if isinstance(e.detail, str) else str(e.detail),
                "status_code": e.status_code,
            })
            # close_position commits on success and raises BEFORE commit on
            # failure, so the session is clean either way. We continue the
            # loop and try the next position.
        except Exception as e:
            logger.error("bulk close: unexpected error on pos=%s: %s", pos.id, e, exc_info=True)
            failed.append({
                "position_id": str(pos.id),
                "symbol": pos.instrument.symbol if pos.instrument else None,
                "reason": "Internal error closing this position",
                "status_code": 500,
            })

    return {
        "closed_count": len(closed),
        "failed_count": len(failed),
        "skipped_no_tick": skipped_no_tick,
        "skipped_mam_copy": skipped_copy,
        "total_profit": float(total_profit),
        "closed": closed,
        "failed": failed,
    }
