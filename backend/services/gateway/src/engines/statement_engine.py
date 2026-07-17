"""Statement digest engine — weekly + monthly per-user summaries.

Runs hourly. Picks users whose timezone-naive UTC clock has crossed
into a new statement window since the last send:

  * weekly  — fires Monday 06:00 UTC. Reports activity from the prior
              Mon 00:00 UTC up to last Sun 23:59 UTC. Resend gated by
              users.weekly_statement_sent_at >= 6 days ago.

  * monthly — fires on the 1st 06:00 UTC of each month. Reports the
              full prior calendar month. Resend gated by
              users.monthly_statement_sent_at >= 27 days ago.

Both digests include realized P/L, volume, deposits, withdrawals,
commissions, swap, bonuses, FR interest, insurance refunds, closing
balance — all derived from TradeHistory + Transaction aggregates over
the window. Quiet for users with zero activity in the period (no
statement sent if there's nothing to report).
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.database import AsyncSessionLocal
from packages.common.src.models import (
    User, TradingAccount, TradeHistory, Transaction,
)

logger = logging.getLogger("statement-engine")

TICK_INTERVAL = 3600
WEEKLY_RESEND_DAYS = 6
MONTHLY_RESEND_DAYS = 27
SEND_HOUR_UTC = 6  # 06:00 UTC = quiet window across all major timezones


class StatementEngine:
    def __init__(self):
        self._running = False

    async def start(self):
        self._running = True
        logger.info("Statement engine started (tick=%ds)", TICK_INTERVAL)
        asyncio.create_task(self._run())

    async def stop(self):
        self._running = False

    async def _run(self):
        while self._running:
            try:
                async with AsyncSessionLocal() as db:
                    sent_w, sent_m = await send_due_statements(db)
                    await db.commit()
                if sent_w or sent_m:
                    logger.info(
                        "Statement digest: weekly=%d monthly=%d", sent_w, sent_m,
                    )
            except Exception as e:
                logger.error("Statement engine error: %s", e, exc_info=True)
            await asyncio.sleep(TICK_INTERVAL)


def _week_window(now: datetime) -> tuple[datetime, datetime, str]:
    """Return (start, end, label) for the most recent Mon..Sun window
    that has already closed when called at `now`. `now` is expected to
    be after Monday 06:00 UTC of the report week."""
    # Monday of the current week at 00:00 UTC.
    this_mon = (now - timedelta(days=now.weekday())).replace(
        hour=0, minute=0, second=0, microsecond=0,
    )
    last_mon = this_mon - timedelta(days=7)
    last_sun_end = this_mon  # exclusive upper bound
    label = f"Week of {last_mon.strftime('%d')}–{(this_mon - timedelta(days=1)).strftime('%d %b %Y')}"
    return last_mon, last_sun_end, label


def _month_window(now: datetime) -> tuple[datetime, datetime, str]:
    """Return (start, end, label) for the calendar month BEFORE the
    month containing `now`."""
    this_month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    # Step back one day from this_month_start to land in prev month.
    last_day_prev = this_month_start - timedelta(days=1)
    prev_month_start = last_day_prev.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    label = prev_month_start.strftime("%B %Y")
    return prev_month_start, this_month_start, label


async def _aggregate_window(
    db: AsyncSession, user_id, account_ids: list, start: datetime, end: datetime,
) -> dict:
    """Pull all aggregates for a user over [start, end). Returns a dict
    shaped for the statement template; returns zeros if no activity."""
    if not account_ids:
        return _empty_aggregates()

    # Trade history: realized P/L + commissions + swaps + volume + trade count
    th_row = (await db.execute(
        select(
            func.coalesce(func.sum(TradeHistory.profit), 0),
            func.coalesce(func.sum(TradeHistory.commission), 0),
            func.coalesce(func.sum(TradeHistory.swap), 0),
            func.coalesce(func.sum(TradeHistory.lots), 0),
            func.count(),
        ).where(
            TradeHistory.account_id.in_(account_ids),
            TradeHistory.closed_at >= start,
            TradeHistory.closed_at < end,
        )
    )).one()
    realized_pnl = Decimal(str(th_row[0] or 0))
    commissions_paid = Decimal(str(th_row[1] or 0))
    swap_paid = Decimal(str(th_row[2] or 0))
    volume_lots = Decimal(str(th_row[3] or 0))
    trades_closed = int(th_row[4] or 0)

    # Transactions: deposits, withdrawals, bonus, FR interest, insurance refunds
    tx_rows = (await db.execute(
        select(Transaction.type, func.coalesce(func.sum(Transaction.amount), 0))
        .where(
            Transaction.user_id == user_id,
            Transaction.created_at >= start,
            Transaction.created_at < end,
        )
        .group_by(Transaction.type)
    )).all()
    by_type: dict[str, Decimal] = {t: Decimal(str(amt or 0)) for t, amt in tx_rows}
    deposits = by_type.get("deposit", Decimal("0"))
    withdrawals = abs(by_type.get("withdrawal", Decimal("0")))
    bonus_credited = by_type.get("bonus", Decimal("0")) + by_type.get("bonus_credit", Decimal("0"))
    fr_interest = by_type.get("fr_interest", Decimal("0")) + by_type.get("fixed_return_interest", Decimal("0"))
    insurance_refunds = by_type.get("insurance_refund", Decimal("0"))

    return {
        "realized_pnl": realized_pnl,
        "commissions_paid": commissions_paid,
        "swap_paid": swap_paid,
        "total_volume_lots": volume_lots,
        "trades_closed": trades_closed,
        "deposits_total": deposits,
        "withdrawals_total": withdrawals,
        "bonus_credited": bonus_credited,
        "fr_interest_credited": fr_interest,
        "insurance_refunds": insurance_refunds,
    }


def _empty_aggregates() -> dict:
    z = Decimal("0")
    return {
        "realized_pnl": z, "commissions_paid": z, "swap_paid": z,
        "total_volume_lots": z, "trades_closed": 0,
        "deposits_total": z, "withdrawals_total": z,
        "bonus_credited": z, "fr_interest_credited": z, "insurance_refunds": z,
    }


def _has_activity(agg: dict) -> bool:
    """Skip silent-period emails. A user with no trades, deposits, or
    withdrawals doesn't get a 'you did nothing' email."""
    return (
        agg["trades_closed"] > 0
        or agg["deposits_total"] != 0
        or agg["withdrawals_total"] != 0
        or agg["bonus_credited"] != 0
        or agg["fr_interest_credited"] != 0
        or agg["insurance_refunds"] != 0
    )


async def send_due_statements(db: AsyncSession) -> tuple[int, int]:
    """Returns (weekly_sent, monthly_sent). Skips off-hours / off-days
    so the queue doesn't keep firing mid-week."""
    try:
        from packages.common.src.smtp_mail import (
            send_email, smtp_configured, fire_and_forget,
        )
        from packages.common.src.email_templates import render_statement_digest
        from packages.common.src.config import get_settings
    except Exception as e:
        logger.warning("statement engine setup failed: %s", e)
        return 0, 0

    if not smtp_configured():
        return 0, 0

    now = datetime.now(timezone.utc)
    # Only fire in the send hour (06:00 UTC ± tick).
    in_send_hour = now.hour == SEND_HOUR_UTC
    is_monday = now.weekday() == 0
    is_first_of_month = now.day == 1

    do_weekly = in_send_hour and is_monday
    do_monthly = in_send_hour and is_first_of_month

    if not do_weekly and not do_monthly:
        return 0, 0

    weekly_start, weekly_end, weekly_label = _week_window(now)
    monthly_start, monthly_end, monthly_label = _month_window(now)
    app_url = (get_settings().TRADER_APP_URL or "https://trade.swisdex.com")

    weekly_cutoff = now - timedelta(days=WEEKLY_RESEND_DAYS)
    monthly_cutoff = now - timedelta(days=MONTHLY_RESEND_DAYS)

    users = (await db.execute(
        select(User).where(
            # User state lives in `status` string column. No is_active boolean.
            User.status == "active",
            User.email_verified.is_(True),
        )
    )).scalars().all()

    sent_w = 0
    sent_m = 0
    for u in users:
        # Never email demo or promotional/showcase accounts.
        if not u.email or bool(getattr(u, "is_demo", False)) or bool(getattr(u, "is_promotional", False)):
            continue

        acct_rows = (await db.execute(
            select(TradingAccount.id, TradingAccount.balance).where(
                TradingAccount.user_id == u.id,
                TradingAccount.is_demo.is_(False),
            )
        )).all()
        if not acct_rows:
            continue
        account_ids = [r[0] for r in acct_rows]
        closing_balance = sum(
            (Decimal(str(r[1] or 0)) for r in acct_rows), Decimal("0"),
        )

        # ── Weekly ─────────────────────────────────────────────────
        if do_weekly and (
            u.weekly_statement_sent_at is None
            or u.weekly_statement_sent_at <= weekly_cutoff
        ):
            agg = await _aggregate_window(
                db, u.id, account_ids, weekly_start, weekly_end,
            )
            if _has_activity(agg):
                try:
                    subject, html, text = render_statement_digest(
                        first_name=u.first_name,
                        period_label=weekly_label,
                        period_kind="weekly",
                        closing_balance=closing_balance,
                        trader_app_url=app_url,
                        **agg,
                    )
                    fire_and_forget(send_email(u.email, subject, html, text=text, category="account"))
                    sent_w += 1
                except Exception as exc:
                    logger.warning("Weekly statement render failed for %s: %s", u.email, exc)
            # Mark even when skipped to avoid hourly re-evaluation
            # of the same user with the same empty-activity result.
            u.weekly_statement_sent_at = now

        # ── Monthly ────────────────────────────────────────────────
        if do_monthly and (
            u.monthly_statement_sent_at is None
            or u.monthly_statement_sent_at <= monthly_cutoff
        ):
            agg = await _aggregate_window(
                db, u.id, account_ids, monthly_start, monthly_end,
            )
            if _has_activity(agg):
                try:
                    subject, html, text = render_statement_digest(
                        first_name=u.first_name,
                        period_label=monthly_label,
                        period_kind="monthly",
                        closing_balance=closing_balance,
                        trader_app_url=app_url,
                        **agg,
                    )
                    fire_and_forget(send_email(u.email, subject, html, text=text, category="account"))
                    sent_m += 1
                except Exception as exc:
                    logger.warning("Monthly statement render failed for %s: %s", u.email, exc)
            u.monthly_statement_sent_at = now

    return sent_w, sent_m


statement_engine = StatementEngine()
