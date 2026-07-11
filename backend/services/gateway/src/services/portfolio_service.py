"""Portfolio Service — Summary, performance analytics, trade history, CSV export."""
import csv
import io
import json
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from uuid import UUID

from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from packages.common.src.models import (
    TradingAccount, Position, PositionStatus, OrderSide,
    TradeHistory, Instrument, CopyTrade, Transaction, AccountGroup,
)
from packages.common.src.redis_client import redis_client, PriceChannel


async def _get_user_accounts(user_id: UUID, db: AsyncSession) -> list[TradingAccount]:
    # Portfolio reflects REAL money only — demo accounts carry virtual
    # balances that must never roll into the user's net-worth / equity
    # totals (client report 2026-05-28: demo funds were inflating the
    # portfolio). Also skip soft-deleted accounts.
    result = await db.execute(
        select(TradingAccount).where(
            TradingAccount.user_id == user_id,
            TradingAccount.is_demo == False,
            TradingAccount.is_active == True,
        )
    )
    return result.scalars().all()


async def _get_current_price(symbol: str) -> tuple[Decimal, Decimal] | None:
    tick_data = await redis_client.get(PriceChannel.tick_key(symbol))
    if not tick_data:
        return None
    tick = json.loads(tick_data)
    return Decimal(str(tick["bid"])), Decimal(str(tick["ask"]))


def _compute_pnl(pos: Position, current_price: Decimal) -> Decimal:
    if pos.side == OrderSide.BUY or pos.side.value == "buy":
        raw = (current_price - pos.open_price) * pos.lots * pos.instrument.contract_size
    else:
        raw = (pos.open_price - current_price) * pos.lots * pos.instrument.contract_size
    from .trading_service import quote_to_account_pnl
    return quote_to_account_pnl(
        raw,
        getattr(pos.instrument, "base_currency", None),
        getattr(pos.instrument, "quote_currency", None),
        current_price,
        symbol=getattr(pos.instrument, "symbol", None),
    )


async def portfolio_summary(user_id: UUID, account_id: UUID | None, db: AsyncSession) -> dict:
    accounts = await _get_user_accounts(user_id, db)
    if not accounts:
        return {
            "total_balance": 0.0, "total_credit": 0.0, "total_equity": 0.0,
            "total_unrealized_pnl": 0.0,
            "pnl_breakdown": {"today": 0.0, "this_week": 0.0, "this_month": 0.0, "all_time": 0.0},
            "holdings": [], "open_positions": [], "open_positions_count": 0,
        }

    account_ids = [a.id for a in accounts]
    if account_id:
        if account_id not in account_ids:
            raise HTTPException(status_code=404, detail="Account not found")
        account_ids = [account_id]

    total_balance = sum(float(a.balance) for a in accounts if a.id in account_ids)
    total_credit = sum(float(a.credit) for a in accounts if a.id in account_ids)

    pos_result = await db.execute(
        select(Position)
        .where(Position.account_id.in_(account_ids), Position.status == PositionStatus.OPEN)
        .options(selectinload(Position.instrument))
    )
    open_positions = pos_result.scalars().all()

    total_unrealized = Decimal("0")
    holdings = {}
    open_positions_detail: list[dict] = []

    # Map account_id -> account so each position can be valued with its own
    # account-group spread (same as the trade screen / close path).
    acct_by_id = {a.id: a for a in accounts}
    from .trading_service import user_close_quote

    for pos in open_positions:
        symbol = pos.instrument.symbol if pos.instrument else "?"
        # Value at the user's CLOSE quote (mid re-spread with the user's own
        # spread), NOT the raw broadcast bid/ask — keeps floating P&L in step
        # with what close actually realises (client 2026-06-29).
        tick_raw = await redis_client.get(PriceChannel.tick_key(symbol))
        if tick_raw and pos.instrument:
            tick = json.loads(tick_raw)
            _acct = acct_by_id.get(pos.account_id)
            c_bid, c_ask = await user_close_quote(
                db, pos.instrument, user_id, pos.account_id,
                getattr(_acct, "account_group_id", None), tick,
            )
            cp = c_bid if (pos.side == OrderSide.BUY or pos.side.value == "buy") else c_ask
            pnl = _compute_pnl(pos, cp)
        else:
            pnl = pos.profit or Decimal("0")
            cp = pos.open_price

        total_unrealized += pnl
        side_val = pos.side.value if hasattr(pos.side, "value") else str(pos.side)
        open_positions_detail.append({
            "id": str(pos.id), "symbol": symbol, "side": side_val,
            "lots": float(pos.lots), "entry_price": float(pos.open_price),
            "current_price": float(cp), "pnl": float(pnl),
        })

        if symbol not in holdings:
            holdings[symbol] = {
                "symbol": symbol, "total_lots": Decimal("0"), "avg_open_price": Decimal("0"),
                "current_price": float(cp), "unrealized_pnl": Decimal("0"),
                "positions_count": 0, "net_side": None, "_price_sum": Decimal("0"),
                "_notional": Decimal("0"),
            }
        h = holdings[symbol]
        h["total_lots"] += pos.lots
        h["_price_sum"] += pos.open_price * pos.lots
        h["unrealized_pnl"] += pnl
        h["positions_count"] += 1
        h["current_price"] = float(cp)
        # Net side for the symbol: the single position's side, or "mixed" when a
        # user holds both a buy and a sell on the same symbol.
        if h["net_side"] is None:
            h["net_side"] = side_val
        elif h["net_side"] != side_val:
            h["net_side"] = "mixed"
        cs = pos.instrument.contract_size if pos.instrument else None
        if cs:
            h["_notional"] += pos.open_price * pos.lots * Decimal(str(cs))

    for h in holdings.values():
        if h["total_lots"] > 0:
            h["avg_open_price"] = float(h["_price_sum"] / h["total_lots"])
        h["total_lots"] = float(h["total_lots"])
        h["unrealized_pnl"] = float(h["unrealized_pnl"])
        notional = h.pop("_notional", Decimal("0"))
        del h["_price_sum"]
        # Aliases the trader Portfolio page reads directly (side/lots/entry_price
        # /pnl/pnl_pct). Without these the open-positions table showed blank
        # Side/Lots/Entry and a $NaN P&L (field-name mismatch, client 2026-07-07).
        h["side"] = h.get("net_side")
        h["lots"] = h["total_lots"]
        h["entry_price"] = h["avg_open_price"]
        h["pnl"] = h["unrealized_pnl"]
        h["pnl_pct"] = (h["unrealized_pnl"] / float(notional) * 100.0) if notional > 0 else 0.0

    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = now - timedelta(days=now.weekday())
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    async def _closed_pnl(since: datetime | None) -> float:
        # NET realized P&L = price P&L minus the costs charged on the trade
        # (commission + swap). The closed-position card in the terminal shows
        # this net figure, so the dashboard must too — otherwise a trade that
        # was +$0.17 gross but -$0.02 after costs showed here as a profit/win
        # while the terminal showed a loss (client 2026-06-19).
        query = select(func.coalesce(func.sum(
            TradeHistory.profit
            - func.coalesce(TradeHistory.commission, 0)
            - func.coalesce(TradeHistory.swap, 0)
        ), 0)).where(
            TradeHistory.account_id.in_(account_ids),
        )
        if since:
            query = query.where(TradeHistory.closed_at >= since)
        res = await db.execute(query)
        return float(res.scalar())

    pnl_today = await _closed_pnl(today_start)
    pnl_week = await _closed_pnl(week_start)
    pnl_month = await _closed_pnl(month_start)
    pnl_all_time = await _closed_pnl(None)

    return {
        "total_balance": total_balance, "total_credit": total_credit,
        "total_equity": total_balance + total_credit + float(total_unrealized),
        "total_unrealized_pnl": float(total_unrealized),
        "pnl_breakdown": {
            "today": pnl_today, "this_week": pnl_week,
            "this_month": pnl_month, "all_time": pnl_all_time,
        },
        "holdings": list(holdings.values()),
        "open_positions": open_positions_detail,
        "open_positions_count": len(open_positions),
    }


async def portfolio_performance(
    user_id: UUID, account_id: UUID | None, period: str, db: AsyncSession,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
) -> dict:
    accounts = await _get_user_accounts(user_id, db)
    if not accounts:
        return {
            "equity_curve": [],
            "stats": {
                "total_return": 0.0, "total_return_pct": 0.0, "max_drawdown": 0.0,
                "max_drawdown_pct": 0.0, "sharpe_ratio": 0.0, "win_rate": 0.0,
                "total_trades": 0, "total_wins": 0, "total_losses": 0,
            },
            "monthly_breakdown": [], "symbol_breakdown": [],
        }

    account_ids = [a.id for a in accounts]
    if account_id:
        if account_id not in account_ids:
            raise HTTPException(status_code=404, detail="Account not found")
        account_ids = [account_id]

    now = datetime.now(timezone.utc)
    period_map = {"1d": timedelta(days=1), "1w": timedelta(days=7), "1m": timedelta(days=30), "3m": timedelta(days=90), "6m": timedelta(days=180), "1y": timedelta(days=365), "all": None}

    # Custom-range mode: caller passed period='custom' with explicit dates.
    # Falls back to preset behaviour when period is one of the preset codes
    # (or anything unrecognised → 'all').
    if period == "custom":
        since = date_from
        until = date_to
    else:
        delta = period_map.get(period)
        since = (now - delta) if delta else None
        until = None

    query = (
        select(TradeHistory)
        .options(selectinload(TradeHistory.instrument))
        .where(TradeHistory.account_id.in_(account_ids))
    )
    if since:
        query = query.where(TradeHistory.closed_at >= since)
    if until:
        query = query.where(TradeHistory.closed_at <= until)
    query = query.order_by(TradeHistory.closed_at.asc())

    result = await db.execute(query)
    trades = result.scalars().all()

    total_profit = Decimal("0")
    total_wins = total_losses = 0
    max_equity = max_drawdown = Decimal("0")
    equity_curve = []
    running_equity = Decimal("0")
    daily_returns = []
    monthly_profits = {}
    symbol_profits = {}

    for trade in trades:
        # NET P&L per trade = price P&L minus commission + swap, matching the
        # terminal's closed-position figure. Win/loss is decided on NET too, so
        # a trade that was positive gross but negative after costs counts as a
        # loss here (client 2026-06-19 — it was being counted as a win).
        net = (trade.profit or Decimal("0")) - (trade.commission or Decimal("0")) - (trade.swap or Decimal("0"))
        running_equity += net
        total_profit += net
        if running_equity > max_equity:
            max_equity = running_equity
        dd = max_equity - running_equity
        if dd > max_drawdown:
            max_drawdown = dd
        if net > 0:
            total_wins += 1
        elif net < 0:
            total_losses += 1
        # Frontend (portfolio Equity Growth chart) reads `date`. The
        # previous payload used `time` and the chart's filter silently
        # dropped every row, which produced the "empty equity graph"
        # report. Emit both keys so historical clients still resolve.
        net_f = float(net)
        ts_iso = trade.closed_at.isoformat() if trade.closed_at else None
        equity_curve.append({
            "date": ts_iso,
            "time": ts_iso,
            "equity": float(running_equity),
            "profit": net_f,
        })
        if trade.closed_at:
            daily_returns.append(net_f)
            month_key = trade.closed_at.strftime("%Y-%m")
            monthly_profits[month_key] = monthly_profits.get(month_key, 0) + net_f
        symbol = trade.instrument.symbol if trade.instrument else "unknown"
        if symbol not in symbol_profits:
            symbol_profits[symbol] = {"symbol": symbol, "profit": 0.0, "trades": 0, "wins": 0}
        symbol_profits[symbol]["profit"] += net_f
        symbol_profits[symbol]["trades"] += 1
        if net > 0:
            symbol_profits[symbol]["wins"] += 1

    total_trades = total_wins + total_losses
    win_rate = (total_wins / total_trades * 100) if total_trades > 0 else 0
    avg_return = sum(daily_returns) / len(daily_returns) if daily_returns else 0
    std_dev = (sum((r - avg_return) ** 2 for r in daily_returns) / len(daily_returns)) ** 0.5 if len(daily_returns) > 1 else 0
    sharpe = (avg_return / std_dev) if std_dev > 0 else 0
    initial_balance = float(sum(a.balance for a in accounts if a.id in account_ids))
    total_return_pct = (float(total_profit) / initial_balance * 100) if initial_balance > 0 else 0
    max_dd_pct = (float(max_drawdown) / float(max_equity) * 100) if max_equity > 0 else 0
    monthly_breakdown = [{"month": k, "profit": v} for k, v in sorted(monthly_profits.items())]
    symbol_breakdown = sorted(symbol_profits.values(), key=lambda x: x["profit"], reverse=True)
    for sb in symbol_breakdown:
        sb["win_rate"] = round(sb["wins"] / sb["trades"] * 100, 2) if sb["trades"] > 0 else 0

    return {
        "equity_curve": equity_curve,
        "stats": {
            "total_return": float(total_profit), "total_return_pct": round(total_return_pct, 2),
            "max_drawdown": float(max_drawdown), "max_drawdown_pct": round(max_dd_pct, 2),
            "sharpe_ratio": round(sharpe, 4), "win_rate": round(win_rate, 2),
            "total_trades": total_trades, "total_wins": total_wins, "total_losses": total_losses,
        },
        "monthly_breakdown": monthly_breakdown, "symbol_breakdown": symbol_breakdown,
    }


async def trade_history(
    user_id: UUID, account_id: UUID | None, symbol: str | None, side: str | None,
    date_from: datetime | None, date_to: datetime | None, page: int, per_page: int,
    db: AsyncSession,
) -> dict:
    accounts = await _get_user_accounts(user_id, db)
    account_ids = [a.id for a in accounts]
    if account_id:
        if account_id not in account_ids:
            raise HTTPException(status_code=404, detail="Account not found")
        account_ids = [account_id]

    # Lazy backfill: relabel every still-'manual' history row where the
    # close_price crossed the position's SL/TP. Idempotent + cheap because it
    # only touches rows that are still 'manual' AND have an SL/TP set — once
    # a row is flipped to 'sl'/'tp' it's no longer matched. Runs without
    # requiring a backend restart so the UI corrects instantly.
    from sqlalchemy import text
    try:
        await db.execute(
            text(
                """
                UPDATE trade_history th
                SET close_reason = CASE
                    WHEN p.stop_loss IS NOT NULL AND (
                        (LOWER(CAST(p.side AS TEXT)) = 'buy'  AND th.close_price <= p.stop_loss)
                     OR (LOWER(CAST(p.side AS TEXT)) = 'sell' AND th.close_price >= p.stop_loss)
                    ) THEN 'sl'
                    WHEN p.take_profit IS NOT NULL AND (
                        (LOWER(CAST(p.side AS TEXT)) = 'buy'  AND th.close_price >= p.take_profit)
                     OR (LOWER(CAST(p.side AS TEXT)) = 'sell' AND th.close_price <= p.take_profit)
                    ) THEN 'tp'
                    ELSE th.close_reason
                END
                FROM positions p
                WHERE th.position_id = p.id
                  AND COALESCE(th.close_reason, 'manual') IN ('manual', 'copy_close', 'copy')
                  AND (p.stop_loss IS NOT NULL OR p.take_profit IS NOT NULL)
                """
            )
        )
        await db.commit()
    except Exception:
        # Never break trade_history if the backfill fails — just serve what's there.
        await db.rollback()

    base_filter = [TradeHistory.account_id.in_(account_ids)]
    if symbol:
        inst_result = await db.execute(select(Instrument.id).where(Instrument.symbol == symbol.upper()))
        inst_id = inst_result.scalar_one_or_none()
        if inst_id:
            base_filter.append(TradeHistory.instrument_id == inst_id)
        else:
            return {"items": [], "total": 0, "page": page, "per_page": per_page, "pages": 0}
    if side:
        base_filter.append(TradeHistory.side == OrderSide(side))
    if date_from:
        base_filter.append(TradeHistory.closed_at >= date_from)
    if date_to:
        base_filter.append(TradeHistory.closed_at <= date_to)

    count_result = await db.execute(select(func.count()).select_from(TradeHistory).where(*base_filter))
    total = count_result.scalar()

    result = await db.execute(
        select(TradeHistory).where(*base_filter)
        .order_by(TradeHistory.closed_at.desc())
        .offset((page - 1) * per_page).limit(per_page)
    )
    trades = result.scalars().all()

    # Cent accounts store ENGINE (scaled) lots in TradeHistory — e.g. a 0.05
    # cent-lot trade is held as 0.005. The open-positions list multiplies back
    # by 1/lot_size_multiplier for display; the history list did NOT, so it
    # showed the scaled-down 0.005 while the running trade showed 0.05 (client
    # 2026-06-23). Build a per-account unscale factor and apply it below.
    unscale_by_account: dict[str, Decimal] = {}
    if account_ids:
        mult_rows = (await db.execute(
            select(TradingAccount.id, AccountGroup.lot_size_multiplier)
            .join(AccountGroup, AccountGroup.id == TradingAccount.account_group_id, isouter=True)
            .where(TradingAccount.id.in_(account_ids))
        )).all()
        for aid, mult in mult_rows:
            m = Decimal(str(mult)) if mult is not None else Decimal("1")
            unscale_by_account[str(aid)] = (Decimal("1") / m) if m > 0 else Decimal("1")

    items = []
    for t in trades:
        _uns = unscale_by_account.get(str(t.account_id), Decimal("1"))
        _disp_lots = float(Decimal(str(t.lots)) * _uns)
        side_val = t.side.value if hasattr(t.side, 'value') else str(t.side)
        copy_trade_q = await db.execute(
            select(CopyTrade).where(CopyTrade.investor_position_id == t.position_id)
        )
        copy_trade = copy_trade_q.scalar_one_or_none()
        trade_type = "copy_trade" if copy_trade else "self_trade"
        items.append({
            "id": str(t.id), "symbol": t.instrument.symbol if t.instrument else None,
            "side": side_val, "lots": _disp_lots,
            "open_price": float(t.open_price), "close_price": float(t.close_price),
            "swap": float(t.swap), "commission": float(t.commission),
            # NET P&L (price P&L minus commission + swap) so the Trade History
            # row matches the terminal's closed-position card and the dashboard
            # (client 2026-06-19 — it showed gross here, a different number).
            # gross_pnl kept for anyone who needs the pre-cost figure.
            "gross_pnl": float(t.profit),
            "pnl": float((t.profit or Decimal("0")) - (t.commission or Decimal("0")) - (t.swap or Decimal("0"))),
            "close_reason": t.close_reason or "manual",
            "trade_type": trade_type,
            "opened_at": t.opened_at.isoformat() if t.opened_at else None,
            "close_time": t.closed_at.isoformat() if t.closed_at else None,
        })

    return {
        "items": items, "total": total, "page": page, "per_page": per_page,
        "pages": (total + per_page - 1) // per_page if total else 0,
    }


async def export_trades(
    user_id: UUID, account_id: UUID | None,
    date_from: datetime | None, date_to: datetime | None,
    db: AsyncSession,
) -> StreamingResponse:
    accounts = await _get_user_accounts(user_id, db)
    account_ids = [a.id for a in accounts]
    if account_id:
        if account_id not in account_ids:
            raise HTTPException(status_code=404, detail="Account not found")
        account_ids = [account_id]

    base_filter = [TradeHistory.account_id.in_(account_ids)]
    if date_from:
        base_filter.append(TradeHistory.closed_at >= date_from)
    if date_to:
        base_filter.append(TradeHistory.closed_at <= date_to)

    result = await db.execute(
        select(TradeHistory).where(*base_filter)
        .order_by(TradeHistory.closed_at.desc()).limit(10000)
    )
    trades = result.scalars().all()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "ID", "Symbol", "Side", "Lots", "Open Price", "Close Price",
        "Swap", "Commission", "Profit", "Opened At", "Closed At",
    ])
    for t in trades:
        writer.writerow([
            str(t.id), t.instrument.symbol if t.instrument else "",
            t.side.value, float(t.lots), float(t.open_price), float(t.close_price),
            float(t.swap), float(t.commission), float(t.profit),
            t.opened_at.isoformat() if t.opened_at else "",
            t.closed_at.isoformat() if t.closed_at else "",
        ])

    output.seek(0)
    filename = f"trade_history_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


# Period → (window seconds, bucket seconds). Bucket sizes mirror what the
# accounts-page trend chart renders so the X-axis labels line up.
_BALANCE_HISTORY_PERIODS: dict[str, tuple[int, int]] = {
    "24h": (86_400, 3_600),          # 1 day, hourly
    "7d":  (604_800, 86_400),        # 1 week, daily
    "30d": (2_592_000, 86_400),      # 30 days, daily
    "90d": (7_776_000, 604_800),     # 90 days, weekly
    "1y":  (31_536_000, 2_592_000),  # 1 year, ~monthly (30d buckets)
}


async def balance_history(
    user_id: UUID, account_id: UUID, period: str, db: AsyncSession,
) -> dict:
    """Time-bucketed balance series for an account, sourced from the
    transactions ledger.

    For each bucket we emit the LAST observed `balance_after` in that
    bucket. Empty buckets carry forward the previous bucket's value, so
    the line is continuous. The first bucket seeds from the most recent
    transaction strictly before the window (or, if none, the account's
    current balance — a fresh account stays flat at zero).
    """
    if period not in _BALANCE_HISTORY_PERIODS:
        raise HTTPException(status_code=400, detail="Invalid period")

    accounts = await _get_user_accounts(user_id, db)
    if not any(a.id == account_id for a in accounts):
        raise HTTPException(status_code=404, detail="Account not found")
    account = next(a for a in accounts if a.id == account_id)

    window_s, bucket_s = _BALANCE_HISTORY_PERIODS[period]
    now = datetime.now(timezone.utc)
    start = now - timedelta(seconds=window_s)

    # All in-window transactions, oldest first.
    in_window = (await db.execute(
        select(Transaction.created_at, Transaction.balance_after)
        .where(
            Transaction.account_id == account_id,
            Transaction.created_at >= start,
            Transaction.balance_after.is_not(None),
        )
        .order_by(Transaction.created_at.asc())
    )).all()

    # Seed balance — most recent transaction strictly before the window.
    seed_row = (await db.execute(
        select(Transaction.balance_after)
        .where(
            Transaction.account_id == account_id,
            Transaction.created_at < start,
            Transaction.balance_after.is_not(None),
        )
        .order_by(Transaction.created_at.desc()).limit(1)
    )).first()
    if seed_row and seed_row[0] is not None:
        seed = float(seed_row[0])
    elif in_window:
        # No history before the window — back-fill from the first observed
        # balance so the curve doesn't artificially start at zero.
        seed = float(in_window[0].balance_after)
    else:
        seed = float(account.balance or 0)

    # Build bucket boundaries: align to the bucket grid so the X axis is stable.
    bucket_start_ms = int(start.timestamp() // bucket_s * bucket_s)
    end_ms = int(now.timestamp())
    boundaries: list[int] = []
    t = bucket_start_ms
    while t <= end_ms:
        boundaries.append(t)
        t += bucket_s
    if boundaries[-1] < end_ms:
        boundaries.append(end_ms)

    # Walk transactions once, bucket the LAST balance_after per bucket.
    tx_idx = 0
    last_balance = seed
    items: list[dict] = []
    for b in boundaries:
        b_end = b + bucket_s
        bucket_balance = last_balance
        while tx_idx < len(in_window) and int(in_window[tx_idx].created_at.timestamp()) < b_end:
            bucket_balance = float(in_window[tx_idx].balance_after)
            tx_idx += 1
        last_balance = bucket_balance
        items.append({"time": b, "balance": bucket_balance})

    return {
        "account_id": str(account_id),
        "period": period,
        "bucket_seconds": bucket_s,
        "current_balance": float(account.balance or 0),
        "items": items,
    }
