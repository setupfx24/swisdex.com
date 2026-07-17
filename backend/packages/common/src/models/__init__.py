"""SQLAlchemy ORM models — split into per-domain modules.

Importers continue to use `from packages.common.src.models import X` exactly
as before. Every name from the legacy single-file `models.py` is re-exported
here so call sites don't change.

Module map:
    _enums.py     enums + SAEnum bindings
    users.py      User, UserSession, KYC, Employee, audit + IP logs
    instruments.py InstrumentSegment, Instrument, InstrumentConfig + audit
    trading.py    AccountGroup, TradingAccount, Order, Position, TradeHistory
    wallet.py     BankAccount, Deposit, Withdrawal, Transaction, configs
    business.py   IB, master accounts, investor allocations, copy trades
    support.py    Tickets, notifications, banners
    system.py     SystemSetting, BonusOffer, UserBonus
    insurance.py  InsurancePolicy, InsuranceClaim
    rewards.py    XP / AC / PS state, missions, store, audit
    share.py      SharedTrade
"""

from ..database import Base

# ── Enums + SAEnum bindings ─────────────────────────────────────────
from ._enums import (
    OrderType, OrderSide, OrderStatus, PositionStatus, AllocationCopyType,
    order_type_enum, order_side_enum, order_status_enum, position_status_enum,
)

# ── Domain modules (eagerly imported so SQLAlchemy registers every class) ──
from .users import (
    User, UserSession, PasswordResetToken, UserRefreshToken, KYCDocument,
    IPLog, AuditLog, UserAuditLog, Employee, WalletAuthNonce,
    EmployeeCustomRole, EmployeeTask,
)
from .instruments import (
    InstrumentSegment, Instrument, InstrumentConfig, InstrumentConfigAudit,
)
from .trading import (
    AccountGroup, TradingAccount, Order, Position, TradeHistory,
)
from .wallet import (
    BankAccount, Deposit, DepositRequest, Withdrawal, Transaction,
    PaymentMethod, PromotionalExpense, CompanyExpense,
    ChargeConfig, SpreadConfig, SwapConfig,
)
from .business import (
    IBProfile, IBApplication, IBCommissionPlan, IBCommission, Referral,
    MasterAccount, InvestorAllocation, CopyTrade,
)
from .support import (
    SupportTicket, TicketMessage, Notification, Banner,
)
from .system import (
    SystemSetting, BonusOffer, UserBonus,
)
from .insurance import (
    InsurancePolicy, InsuranceClaim,
)
from .rewards import (
    RewardsUserState, RewardsMission, RewardsUserMissionProgress,
    RewardStoreItem, RewardsTransaction, LifestyleFulfillment,
    RewardCampaign, RewardCampaignTier, RewardCampaignClaim,
)
from .play_zone import (
    SpinWheelPrize, SpinResult,
    LotteryRound, LotteryTicket,
    BiddingRound, Bid,
)
from .staking import (
    StakingPlan, StakingPosition, StakingRewardAccrual,
)
from .fixed_return import FixedReturnLock
from .vip import VipPass
from .share import SharedTrade
from .rm import RMFundingRequest, RmManualRequest


__all__ = [
    "Base",
    # enums
    "OrderType", "OrderSide", "OrderStatus", "PositionStatus", "AllocationCopyType",
    "order_type_enum", "order_side_enum", "order_status_enum", "position_status_enum",
    # users
    "User", "UserSession", "PasswordResetToken", "UserRefreshToken", "KYCDocument",
    "IPLog", "AuditLog", "UserAuditLog", "Employee", "WalletAuthNonce",
    "EmployeeCustomRole", "EmployeeTask",
    # instruments
    "InstrumentSegment", "Instrument", "InstrumentConfig", "InstrumentConfigAudit",
    # trading
    "AccountGroup", "TradingAccount", "Order", "Position", "TradeHistory",
    # wallet
    "BankAccount", "Deposit", "DepositRequest", "Withdrawal", "Transaction",
    "PaymentMethod", "PromotionalExpense", "CompanyExpense",
    "ChargeConfig", "SpreadConfig", "SwapConfig",
    # business
    "IBProfile", "IBApplication", "IBCommissionPlan", "IBCommission", "Referral",
    "MasterAccount", "InvestorAllocation", "CopyTrade",
    # support
    "SupportTicket", "TicketMessage", "Notification", "Banner",
    # system
    "SystemSetting", "BonusOffer", "UserBonus",
    # insurance
    "InsurancePolicy", "InsuranceClaim",
    # rewards
    "RewardsUserState", "RewardsMission", "RewardsUserMissionProgress",
    "RewardStoreItem", "RewardsTransaction", "LifestyleFulfillment",
    "RewardCampaign", "RewardCampaignTier", "RewardCampaignClaim",
    # play zone
    "SpinWheelPrize", "SpinResult",
    "LotteryRound", "LotteryTicket",
    "BiddingRound", "Bid",
    # staking
    "StakingPlan", "StakingPosition", "StakingRewardAccrual",
    # AI-POWERED STAKING PROGRAM
    "FixedReturnLock",
    # vip
    "VipPass",
    # share
    "SharedTrade",
    # rm
    "RMFundingRequest", "RmManualRequest",
]
