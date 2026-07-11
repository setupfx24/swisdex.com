"""Trading-account + order + position Pydantic schemas."""
from datetime import datetime
from decimal import Decimal
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field


class TradingAccountResponse(BaseModel):
    id: UUID
    account_number: str
    balance: Decimal
    credit: Decimal
    equity: Decimal
    margin_used: Decimal
    free_margin: Decimal
    margin_level: Decimal
    leverage: int
    currency: str
    is_demo: bool
    is_active: bool

    class Config:
        from_attributes = True


class AccountSummary(BaseModel):
    balance: Decimal
    credit: Decimal
    equity: Decimal
    margin_used: Decimal
    free_margin: Decimal
    margin_level: Decimal
    unrealized_pnl: Decimal
    open_positions_count: int


class PlaceOrderRequest(BaseModel):
    account_id: UUID
    symbol: str
    order_type: str = Field(..., pattern="^(market|limit|stop|stop_limit)$")
    side: str = Field(..., pattern="^(buy|sell)$")
    lots: Decimal = Field(gt=0, le=100)
    price: Optional[Decimal] = None
    stop_loss: Optional[Decimal] = None
    take_profit: Optional[Decimal] = None
    stop_limit_price: Optional[Decimal] = None
    comment: Optional[str] = None
    magic_number: Optional[int] = None


class ModifyOrderRequest(BaseModel):
    stop_loss: Optional[Decimal] = None
    take_profit: Optional[Decimal] = None
    price: Optional[Decimal] = None
    lots: Optional[Decimal] = None


class OrderResponse(BaseModel):
    id: UUID
    account_id: UUID
    symbol: str
    order_type: str
    side: str
    status: str
    lots: Decimal
    price: Optional[Decimal]
    stop_loss: Optional[Decimal]
    take_profit: Optional[Decimal]
    filled_price: Optional[Decimal]
    commission: Decimal
    swap: Decimal
    comment: Optional[str]
    created_at: datetime

    class Config:
        from_attributes = True


class PositionResponse(BaseModel):
    id: UUID
    account_id: UUID
    symbol: str
    side: str
    lots: Decimal
    open_price: Decimal
    current_price: Optional[Decimal] = None
    stop_loss: Optional[Decimal]
    take_profit: Optional[Decimal]
    swap: Decimal
    commission: Decimal
    profit: Decimal
    created_at: datetime

    class Config:
        from_attributes = True


class ClosePositionRequest(BaseModel):
    # gt=0: a partial-close volume must be positive. Without this a trader
    # could POST a NEGATIVE lots value, which flips the close ratio and books
    # a losing trade as realized PROFIT while GROWING the position for free
    # (balance-minting exploit). None still means "close the whole position".
    lots: Optional[Decimal] = Field(default=None, gt=0)


class ModifyPositionRequest(BaseModel):
    stop_loss: Optional[Decimal] = None
    take_profit: Optional[Decimal] = None
