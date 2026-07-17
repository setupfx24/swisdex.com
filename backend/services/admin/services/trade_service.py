"""Admin Trades Service — positions, orders, history, modify, close, create stealth trade."""
import json
import os
import uuid
from datetime import datetime
from decimal import Decimal

import redis.asyncio as aioredis
from fastapi import HTTPException
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.models import (
    User, TradingAccount, Position, Order, Instrument, TradeHistory,
    PositionStatus, OrderStatus, OrderType, OrderSide, Transaction, CopyTrade,
)
from packages.common.src.admin_schemas import (
    PositionOut, OrderOut, TradeHistoryOut, PaginatedResponse,
    ModifyPositionRequest, ClosePositionRequest, CreateTradeRequest,
)
from dependencies import write_audit_log

# Admin uses Redis db 1, but market ticks are on db 0 (gateway).
# Use db 0 explicitly for price reads.
_redis_url = os.getenv("REDIS_URL", "redis://redis:6379/0")
_redis = aioredis.from_url(_redis_url, decode_responses=True)
_redis_prices = aioredis.from_url(_redis_url.rsplit("/", 1)[0] + "/0", decode_responses=True)


async def _get_live_price(symbol: str) -> dict | None:
    try:
        data = await _redis_prices.get(f"tick:{symbol}")
        if data:
            return json.loads(data)
    except Exception:
        pass
    return None


async def list_positions(
    page: int, per_page: int, status_filter: str, db: AsyncSession,
    start_date=None, end_date=None, sort: str = "recent",
):
    # Exclude demo-account activity from admin views (demo trades are practice-only).
    # Promotional demo accounts are also hidden from the admin panel.
    query = (
        select(Position)
        .join(TradingAccount, Position.account_id == TradingAccount.id)
        .where(TradingAccount.is_demo == False, TradingAccount.is_promotional.isnot(True))
    )
    if status_filter == "open":
        query = query.where(Position.status == PositionStatus.OPEN.value)
    elif status_filter == "closed":
        query = query.where(Position.status == PositionStatus.CLOSED.value)
    if start_date is not None:
        query = query.where(Position.created_at >= start_date)
    if end_date is not None:
        query = query.where(Position.created_at <= end_date)

    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0

    # 'gainers' / 'losers' sort on the stored profit (live P&L for open
    # trades is recomputed below; this orders by last-known profit).
    if sort == "gainers":
        order_by = Position.profit.desc()
    elif sort == "losers":
        order_by = Position.profit.asc()
    else:
        order_by = Position.created_at.desc()
    query = query.order_by(order_by).offset((page - 1) * per_page).limit(per_page)
    result = await db.execute(query)
    positions = result.scalars().all()

    items = []
    for pos in positions:
        acc_q = await db.execute(select(TradingAccount).where(TradingAccount.id == pos.account_id))
        acc = acc_q.scalar_one_or_none()

        user_email = None
        account_number = None
        book_type = None
        is_demo = False
        if acc:
            account_number = acc.account_number
            is_demo = bool(acc.is_demo)
            user_q = await db.execute(select(User).where(User.id == acc.user_id))
            usr = user_q.scalar_one_or_none()
            if usr:
                user_email = usr.email
                book_type = (usr.book_type or "B").upper()
        # LP-forwarded when a LIVE account belongs to an A-book user —
        # demo trades always stay internal (b-book engine), never hit LP.
        is_lp_forwarded = (book_type == "A") and not is_demo

        inst_q = await db.execute(select(Instrument).where(Instrument.id == pos.instrument_id))
        inst = inst_q.scalar_one_or_none()

        side_val = pos.side.value if hasattr(pos.side, "value") else str(pos.side)
        status_val = pos.status.value if hasattr(pos.status, "value") else str(pos.status)
        current_price = None
        profit = float(pos.profit or 0)

        if status_val == "open" and inst:
            tick = await _get_live_price(inst.symbol)
            if tick:
                current_price = float(tick["bid"]) if side_val == "buy" else float(tick["ask"])
                contract_size = float(inst.contract_size or 100000)
                lots = float(pos.lots or 0)
                open_p = float(pos.open_price or 0)
                if side_val == "buy":
                    profit = (current_price - open_p) * lots * contract_size
                else:
                    profit = (open_p - current_price) * lots * contract_size

        items.append(PositionOut(
            id=str(pos.id),
            account_id=str(pos.account_id),
            instrument_symbol=inst.symbol if inst else None,
            side=side_val,
            status=status_val,
            lots=float(pos.lots or 0),
            open_price=float(pos.open_price or 0),
            close_price=current_price if status_val == "open" else (float(pos.close_price) if pos.close_price else None),
            stop_loss=float(pos.stop_loss) if pos.stop_loss else None,
            take_profit=float(pos.take_profit) if pos.take_profit else None,
            swap=float(pos.swap or 0),
            commission=float(pos.commission or 0),
            profit=round(profit, 2),
            comment=pos.comment,
            is_admin_modified=pos.is_admin_modified or False,
            created_at=pos.created_at,
            user_email=user_email,
            account_number=account_number,
            book_type=book_type,
            is_demo=is_demo,
            is_lp_forwarded=is_lp_forwarded,
        ))

    return PaginatedResponse(items=items, total=total, page=page, per_page=per_page)


async def list_orders(
    page: int, per_page: int, status_filter: str, db: AsyncSession,
):
    query = (
        select(Order)
        .join(TradingAccount, Order.account_id == TradingAccount.id)
        .where(TradingAccount.is_demo == False, TradingAccount.is_promotional.isnot(True))
    )
    if status_filter == "pending":
        query = query.where(Order.status == OrderStatus.PENDING)
    elif status_filter == "filled":
        query = query.where(Order.status == OrderStatus.FILLED)

    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0

    query = query.order_by(Order.created_at.desc()).offset((page - 1) * per_page).limit(per_page)
    result = await db.execute(query)
    orders = result.scalars().all()

    items = []
    for o in orders:
        acc_q = await db.execute(select(TradingAccount).where(TradingAccount.id == o.account_id))
        acc = acc_q.scalar_one_or_none()
        user_email = None
        account_number = None
        if acc:
            account_number = acc.account_number
            user_q = await db.execute(select(User).where(User.id == acc.user_id))
            usr = user_q.scalar_one_or_none()
            if usr:
                user_email = usr.email

        inst_q = await db.execute(select(Instrument).where(Instrument.id == o.instrument_id))
        inst = inst_q.scalar_one_or_none()

        items.append(OrderOut(
            id=str(o.id),
            account_id=str(o.account_id),
            instrument_symbol=inst.symbol if inst else None,
            order_type=o.order_type.value if hasattr(o.order_type, "value") else str(o.order_type),
            side=o.side.value if hasattr(o.side, "value") else str(o.side),
            status=o.status.value if hasattr(o.status, "value") else str(o.status),
            lots=float(o.lots or 0),
            price=float(o.price) if o.price else None,
            stop_loss=float(o.stop_loss) if o.stop_loss else None,
            take_profit=float(o.take_profit) if o.take_profit else None,
            filled_price=float(o.filled_price) if o.filled_price else None,
            commission=float(o.commission or 0),
            swap=float(o.swap or 0),
            comment=o.comment,
            is_admin_created=o.is_admin_created or False,
            created_at=o.created_at,
            user_email=user_email,
            account_number=account_number,
        ))

    return PaginatedResponse(items=items, total=total, page=page, per_page=per_page)


async def list_trade_history(
    page: int, per_page: int, db: AsyncSession,
    start_date=None, end_date=None, sort: str = "recent",
):
    query = (
        select(TradeHistory)
        .join(TradingAccount, TradeHistory.account_id == TradingAccount.id)
        .where(TradingAccount.is_demo == False, TradingAccount.is_promotional.isnot(True))
    )
    if start_date is not None:
        query = query.where(TradeHistory.closed_at >= start_date)
    if end_date is not None:
        query = query.where(TradeHistory.closed_at <= end_date)
    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0

    # sort: 'gainers' = most profitable first, 'losers' = biggest loss first,
    # default 'recent' = newest close first.
    if sort == "gainers":
        order_by = TradeHistory.profit.desc()
    elif sort == "losers":
        order_by = TradeHistory.profit.asc()
    else:
        order_by = TradeHistory.closed_at.desc()
    query = query.order_by(order_by).offset((page - 1) * per_page).limit(per_page)
    result = await db.execute(query)
    trades = result.scalars().all()

    items = []
    for t in trades:
        inst_q = await db.execute(select(Instrument).where(Instrument.id == t.instrument_id))
        inst = inst_q.scalar_one_or_none()

        acc_q = await db.execute(select(TradingAccount).where(TradingAccount.id == t.account_id))
        acc = acc_q.scalar_one_or_none()
        user_email = None
        account_number = None
        if acc:
            account_number = acc.account_number
            user_q = await db.execute(select(User).where(User.id == acc.user_id))
            usr = user_q.scalar_one_or_none()
            if usr:
                user_email = usr.email

        items.append(TradeHistoryOut(
            id=str(t.id),
            account_id=str(t.account_id),
            instrument_symbol=inst.symbol if inst else None,
            side=t.side.value if hasattr(t.side, "value") else str(t.side),
            lots=float(t.lots or 0),
            open_price=float(t.open_price or 0),
            close_price=float(t.close_price or 0),
            swap=float(t.swap or 0),
            commission=float(t.commission or 0),
            profit=float(t.profit or 0),
            close_reason=getattr(t, 'close_reason', None) or "manual",
            opened_at=t.opened_at,
            closed_at=t.closed_at,
            user_email=user_email,
            account_number=account_number,
        ))

    return PaginatedResponse(items=items, total=total, page=page, per_page=per_page)


async def modify_position(
    position_id: uuid.UUID, body: ModifyPositionRequest,
    admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
) -> dict:
    result = await db.execute(select(Position).where(Position.id == position_id))
    pos = result.scalar_one_or_none()
    if not pos:
        raise HTTPException(status_code=404, detail="Position not found")
    if (pos.status.value if hasattr(pos.status, 'value') else pos.status) != PositionStatus.OPEN.value:
        raise HTTPException(status_code=400, detail="Position is not open")

    # A-book guard: positions on a non-demo account whose owner is book_type='A'
    # are forwarded to the LP — admin cannot edit them locally because the
    # broker no longer owns the risk. Only B-book (internal) trades are editable.
    acc_q = await db.execute(select(TradingAccount).where(TradingAccount.id == pos.account_id))
    acc = acc_q.scalar_one_or_none()
    if acc and not acc.is_demo:
        usr_q = await db.execute(select(User).where(User.id == acc.user_id))
        usr = usr_q.scalar_one_or_none()
        if usr and (usr.book_type or "B").upper() == "A":
            raise HTTPException(
                status_code=403,
                detail="A-book trade — forwarded to LP, cannot be edited from admin.",
            )

    old_values = {
        "stop_loss": float(pos.stop_loss) if pos.stop_loss else None,
        "take_profit": float(pos.take_profit) if pos.take_profit else None,
        "open_price": float(pos.open_price) if pos.open_price else None,
        "commission": float(pos.commission) if pos.commission else 0,
        "swap": float(pos.swap) if pos.swap else 0,
        "lots": float(pos.lots) if pos.lots else None,
        "created_at": pos.created_at.isoformat() if pos.created_at else None,
    }

    if body.stop_loss is not None:
        pos.stop_loss = Decimal(str(body.stop_loss))
    if body.take_profit is not None:
        pos.take_profit = Decimal(str(body.take_profit))
    if body.open_price is not None:
        pos.open_price = Decimal(str(body.open_price))
    if body.commission is not None:
        pos.commission = Decimal(str(body.commission))
    if body.swap is not None:
        pos.swap = Decimal(str(body.swap))
    if body.lots is not None:
        pos.lots = Decimal(str(body.lots))
    if body.open_time is not None:
        pos.created_at = body.open_time

    pos.is_admin_modified = True
    pos.updated_at = datetime.utcnow()

    new_values = {
        "stop_loss": float(pos.stop_loss) if pos.stop_loss else None,
        "take_profit": float(pos.take_profit) if pos.take_profit else None,
        "open_price": float(pos.open_price) if pos.open_price else None,
        "commission": float(pos.commission) if pos.commission else 0,
        "swap": float(pos.swap) if pos.swap else 0,
        "lots": float(pos.lots) if pos.lots else None,
        "created_at": pos.created_at.isoformat() if pos.created_at else None,
    }

    copy_trades_q = await db.execute(
        select(CopyTrade).where(
            CopyTrade.master_position_id == position_id,
            CopyTrade.status == "open",
        )
    )
    updated_copies = 0
    for ct in copy_trades_q.scalars().all():
        inv_pos = await db.get(Position, ct.investor_position_id)
        if not inv_pos:
            continue
        inv_status = inv_pos.status.value if hasattr(inv_pos.status, 'value') else str(inv_pos.status)
        if inv_status != "open":
            continue
        if body.open_price is not None:
            inv_pos.open_price = Decimal(str(body.open_price))
        if body.stop_loss is not None:
            inv_pos.stop_loss = Decimal(str(body.stop_loss))
        if body.take_profit is not None:
            inv_pos.take_profit = Decimal(str(body.take_profit))
        inv_pos.is_admin_modified = True
        inv_pos.updated_at = datetime.utcnow()
        updated_copies += 1

    await write_audit_log(
        db, admin_id, "modify_position", "position", position_id,
        old_values=old_values, new_values={**new_values, "copies_updated": updated_copies},
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": f"Position modified successfully. {updated_copies} copy trades updated."}


async def close_position(
    position_id: uuid.UUID, body: ClosePositionRequest,
    admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
) -> dict:
    result = await db.execute(select(Position).where(Position.id == position_id))
    pos = result.scalar_one_or_none()
    if not pos:
        raise HTTPException(status_code=404, detail="Position not found")
    if (pos.status.value if hasattr(pos.status, 'value') else pos.status) != PositionStatus.OPEN.value:
        raise HTTPException(status_code=400, detail="Position is not open")

    side_val = pos.side.value if hasattr(pos.side, "value") else str(pos.side)

    inst_q = await db.execute(select(Instrument).where(Instrument.id == pos.instrument_id))
    inst = inst_q.scalar_one_or_none()
    contract_size = Decimal(str(inst.contract_size)) if inst else Decimal("100000")

    if body.close_price:
        close_price = Decimal(str(body.close_price))
    elif inst:
        tick = await _get_live_price(inst.symbol)
        if tick:
            close_price = Decimal(str(tick["bid"])) if side_val == "buy" else Decimal(str(tick["ask"]))
        else:
            raise HTTPException(status_code=400, detail="No market price available")
    else:
        raise HTTPException(status_code=400, detail="No price available")

    open_price = pos.open_price or Decimal("0")
    lots = pos.lots or Decimal("0")

    if side_val == "buy":
        profit = (close_price - open_price) * lots * contract_size
    else:
        profit = (open_price - close_price) * lots * contract_size
    from packages.common.src.trading_service import quote_to_account_pnl
    profit = quote_to_account_pnl(
        profit,
        getattr(inst, "base_currency", None),
        getattr(inst, "quote_currency", None),
        close_price,
        symbol=getattr(inst, "symbol", None),
    )

    pos.status = PositionStatus.CLOSED.value
    pos.close_price = close_price
    pos.profit = profit
    pos.closed_at = datetime.utcnow()
    pos.is_admin_modified = True

    acc_q = await db.execute(select(TradingAccount).where(TradingAccount.id == pos.account_id))
    acc = acc_q.scalar_one_or_none()
    if acc:
        acc.balance = (acc.balance or Decimal("0")) + profit
        margin_release = (lots * contract_size * open_price) / Decimal(str(acc.leverage))
        acc.margin_used = max(Decimal("0"), (acc.margin_used or Decimal("0")) - margin_release)
        acc.equity = acc.balance + (acc.credit or Decimal("0"))
        acc.free_margin = acc.equity - acc.margin_used

    trade_rec = TradeHistory(
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
        close_reason="manual",
        opened_at=pos.created_at,
        closed_at=datetime.utcnow(),
    )
    db.add(trade_rec)

    await write_audit_log(
        db, admin_id, "close_position", "position", position_id,
        new_values={"close_price": float(close_price), "profit": float(profit)},
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": "Position closed successfully", "profit": float(profit)}


async def list_instruments(search: str | None, db: AsyncSession) -> dict:
    query = select(Instrument).where(Instrument.is_active == True)
    if search:
        query = query.where(Instrument.symbol.ilike(f"%{search}%"))
    query = query.order_by(Instrument.symbol)
    result = await db.execute(query)
    instruments = result.scalars().all()
    return {
        "items": [
            {
                "id": str(i.id),
                "symbol": i.symbol,
                "display_name": i.display_name,
                "segment": i.segment.name if i.segment else None,
            }
            for i in instruments
        ]
    }


async def create_stealth_trade(
    body: CreateTradeRequest, admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
) -> dict:
    acc_q = await db.execute(
        select(TradingAccount).where(TradingAccount.id == uuid.UUID(body.account_id))
    )
    account = acc_q.scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=404, detail="Trading account not found")

    instrument = None
    if body.symbol:
        symbol_clean = body.symbol.replace("/", "").upper()
        inst_q = await db.execute(
            select(Instrument).where(Instrument.symbol == symbol_clean)
        )
        instrument = inst_q.scalar_one_or_none()
    if not instrument and body.instrument_id:
        inst_q = await db.execute(
            select(Instrument).where(Instrument.id == uuid.UUID(body.instrument_id))
        )
        instrument = inst_q.scalar_one_or_none()
    if not instrument:
        raise HTTPException(status_code=404, detail=f"Instrument not found: {body.symbol or body.instrument_id}")

    side_val = OrderSide.BUY.value if body.side.lower() == "buy" else OrderSide.SELL.value

    fill_price = None
    if body.price:
        fill_price = Decimal(str(body.price))
    else:
        tick = await _get_live_price(instrument.symbol)
        if tick:
            fill_price = Decimal(str(tick["ask"])) if side_val == "buy" else Decimal(str(tick["bid"]))
        else:
            raise HTTPException(status_code=400, detail="No live price available. Provide a price manually.")

    order = Order(
        account_id=account.id,
        instrument_id=instrument.id,
        order_type=OrderType.MARKET.value,
        side=side_val,
        status=OrderStatus.FILLED.value,
        lots=Decimal(str(body.lots)),
        price=fill_price,
        filled_price=fill_price,
        filled_at=datetime.utcnow(),
        stop_loss=Decimal(str(body.stop_loss)) if body.stop_loss else None,
        take_profit=Decimal(str(body.take_profit)) if body.take_profit else None,
        comment=body.comment or "Admin created trade",
        is_admin_created=True,
        admin_created_by=admin_id,
    )
    db.add(order)
    await db.flush()

    position = Position(
        account_id=account.id,
        instrument_id=instrument.id,
        order_id=order.id,
        side=side_val,
        status=PositionStatus.OPEN.value,
        lots=Decimal(str(body.lots)),
        open_price=fill_price,
        stop_loss=Decimal(str(body.stop_loss)) if body.stop_loss else None,
        take_profit=Decimal(str(body.take_profit)) if body.take_profit else None,
        comment=body.comment or "Admin created trade",
        is_admin_modified=True,
    )
    db.add(position)

    margin_required = Decimal(str(body.lots)) * (instrument.contract_size or Decimal("100000")) * (instrument.margin_rate or Decimal("0.01"))
    account.margin_used = (account.margin_used or Decimal("0")) + margin_required

    await write_audit_log(
        db, admin_id, "create_stealth_trade", "position", None,
        new_values={
            "account_id": str(account.id),
            "instrument": instrument.symbol,
            "side": body.side,
            "lots": body.lots,
            "price": float(fill_price),
        },
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": "Trade created successfully", "order_id": str(order.id)}
