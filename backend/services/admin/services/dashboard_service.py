"""Admin Dashboard Service — stats and revenue series."""
from datetime import datetime, timedelta, date

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.models import (
    User, Position, Deposit, Withdrawal, Transaction, SupportTicket, PositionStatus,
)
from packages.common.src.admin_schemas import (
    DashboardStats, DashboardRevenueSeries, DashboardRevenuePoint,
)


async def get_dashboard_stats(db: AsyncSession) -> DashboardStats:
    today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    from packages.common.src.models import TradingAccount

    # Total Users: matches User Management page — real customers only.
    # Excludes admins/super_admins AND the shared demo user(s) so the
    # dashboard count agrees with the user-list page.
    total_users_q = await db.execute(
        select(func.count(User.id)).where(
            User.role.notin_(["admin", "super_admin"]),
            User.is_demo == False,  # noqa: E712 — SQLAlchemy needs `==`, not `is`
            User.is_promotional.isnot(True),  # hide promotional demo accounts
        )
    )
    total_users = total_users_q.scalar() or 0
    promo_ids = select(User.id).where(User.is_promotional == True)  # noqa: E712

    # Active Traders: distinct users who traded in the last 30 days
    # (opened a position OR closed a trade). Broader than "has open position now".
    from packages.common.src.models import TradeHistory
    thirty_days_ago = today_start - timedelta(days=30)

    # Users with positions opened in last 30 days
    open_users_q = (
        select(TradingAccount.user_id)
        .select_from(Position)
        .join(TradingAccount, TradingAccount.id == Position.account_id)
        .where(Position.created_at >= thirty_days_ago, TradingAccount.is_promotional.isnot(True))
    )
    # Users with trades closed in last 30 days
    closed_users_q = (
        select(TradingAccount.user_id)
        .select_from(TradeHistory)
        .join(TradingAccount, TradingAccount.id == TradeHistory.account_id)
        .where(TradeHistory.closed_at >= thirty_days_ago, TradingAccount.is_promotional.isnot(True))
    )
    combined = open_users_q.union(closed_users_q).subquery()
    active_traders_q = await db.execute(
        select(func.count(func.distinct(combined.c.user_id)))
    )
    active_traders = active_traders_q.scalar() or 0

    # Deposits Today: approved deposits since midnight UTC.
    deposits_today_q = await db.execute(
        select(func.coalesce(func.sum(Deposit.amount), 0)).where(
            Deposit.status.in_(["approved", "auto_approved"]),
            Deposit.created_at >= today_start,
            Deposit.user_id.notin_(promo_ids),
        )
    )
    deposits_today = float(deposits_today_q.scalar() or 0)

    # Withdrawals Today.
    withdrawals_today_q = await db.execute(
        select(func.coalesce(func.sum(Withdrawal.amount), 0)).where(
            Withdrawal.status.in_(["approved", "completed"]),
            Withdrawal.created_at >= today_start,
            Withdrawal.user_id.notin_(promo_ids),
        )
    )
    withdrawals_today = float(withdrawals_today_q.scalar() or 0)

    # Platform P&L (all-time): broker wins when traders lose → negate total user profit.
    # Also add commissions earned (always positive for broker). Promotional demo
    # accounts are excluded so their showcase trades don't move real P&L.
    pnl_q = await db.execute(
        select(func.coalesce(func.sum(Position.profit), 0))
        .select_from(Position)
        .join(TradingAccount, TradingAccount.id == Position.account_id)
        .where(
            Position.status == PositionStatus.CLOSED.value,
            TradingAccount.is_promotional.isnot(True),
        )
    )
    user_pnl = float(pnl_q.scalar() or 0)

    commission_all_q = await db.execute(
        select(func.coalesce(func.sum(Transaction.amount), 0)).where(
            Transaction.type == "commission",
        )
    )
    total_commission = float(commission_all_q.scalar() or 0)

    platform_pnl = -user_pnl + total_commission

    # Commission paid today (separate stat, kept for schema compat).
    commission_q = await db.execute(
        select(func.coalesce(func.sum(Transaction.amount), 0)).where(
            Transaction.type == "commission",
            Transaction.created_at >= today_start,
        )
    )
    commission_paid = float(commission_q.scalar() or 0)

    # Pending Deposits count.
    pending_deposits_q = await db.execute(
        select(func.count(Deposit.id)).where(
            Deposit.status == "pending", Deposit.user_id.notin_(promo_ids),
        )
    )
    pending_deposits_count = pending_deposits_q.scalar() or 0

    # Open Support Tickets.
    open_tickets_q = await db.execute(
        select(func.count(SupportTicket.id)).where(
            SupportTicket.status.in_(["open", "in_progress"])
        )
    )
    open_tickets_count = open_tickets_q.scalar() or 0

    return DashboardStats(
        total_users=total_users,
        active_traders=active_traders,
        deposits_today=deposits_today,
        withdrawals_today=withdrawals_today,
        platform_pnl=platform_pnl,
        commission_paid=commission_paid,
        pending_deposits_count=pending_deposits_count,
        open_tickets_count=open_tickets_count,
    )


async def dashboard_revenue_series(days: int, db: AsyncSession) -> DashboardRevenueSeries:
    end_d: date = datetime.utcnow().date()
    start_d: date = end_d - timedelta(days=days - 1)
    cutoff = datetime.combine(start_d, datetime.min.time())
    promo_ids = select(User.id).where(User.is_promotional == True)  # noqa: E712

    day_bucket = func.date_trunc("day", Deposit.created_at)
    dep_rows = (
        await db.execute(
            select(day_bucket, func.coalesce(func.sum(Deposit.amount), 0))
            .where(
                Deposit.status.in_(["approved", "auto_approved"]),
                Deposit.created_at >= cutoff,
                Deposit.user_id.notin_(promo_ids),
            )
            .group_by(day_bucket)
            .order_by(day_bucket)
        )
    ).all()

    w_bucket = func.date_trunc("day", Withdrawal.created_at)
    w_rows = (
        await db.execute(
            select(w_bucket, func.coalesce(func.sum(Withdrawal.amount), 0))
            .where(
                Withdrawal.status.in_(["approved", "completed"]),
                Withdrawal.created_at >= cutoff,
                Withdrawal.user_id.notin_(promo_ids),
            )
            .group_by(w_bucket)
            .order_by(w_bucket)
        )
    ).all()

    by_day: dict[str, tuple[float, float]] = {}

    def _add_dep(row):
        bkt, total = row[0], float(row[1] or 0)
        k = bkt.date().isoformat() if hasattr(bkt, "date") else str(bkt)[:10]
        d, w = by_day.get(k, (0.0, 0.0))
        by_day[k] = (d + total, w)

    def _add_w(row):
        bkt, total = row[0], float(row[1] or 0)
        k = bkt.date().isoformat() if hasattr(bkt, "date") else str(bkt)[:10]
        d, w = by_day.get(k, (0.0, 0.0))
        by_day[k] = (d, w + total)

    for row in dep_rows:
        _add_dep(row)
    for row in w_rows:
        _add_w(row)

    points: list[DashboardRevenuePoint] = []
    cur = start_d
    while cur <= end_d:
        key = cur.isoformat()
        dep_amt, wdr_amt = by_day.get(key, (0.0, 0.0))
        points.append(
            DashboardRevenuePoint(
                date=key,
                deposits=dep_amt,
                withdrawals=wdr_amt,
                net=dep_amt - wdr_amt,
            )
        )
        cur += timedelta(days=1)

    return DashboardRevenueSeries(points=points)
