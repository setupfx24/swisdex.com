"""Eligibility-nudge engine.

Watches for users who are funded enough to benefit from AI-POWERED STAKING PROGRAM /
Trade Insurance but haven't been emailed about either product. Picks
the right flavor based on activity:

  * fr        — balance >= $250 AND no trades in the last 14 days
                (idle cash, FR is the better fit)
  * insurance — balance >= $250 AND >= 5 trades in the last 14 days
                (active trader, Insurance is the better fit)
  * both      — both criteria true (funded + active), pitch both

Re-sends every 90 days while still eligible so the nudge stays relevant
without becoming spam. Idempotent — users.fr_insurance_nudge_sent_at
gates the resend cohort.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import or_, select, func
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.database import AsyncSessionLocal
from packages.common.src.models import User, TradingAccount, TradeHistory

logger = logging.getLogger("eligibility-nudge")

TICK_INTERVAL = 6 * 3600          # check every 6h — daily would still work
RESEND_DAYS = 90                  # quarterly resend while still eligible
MIN_FUNDED_BALANCE = Decimal("250")
ACTIVITY_WINDOW_DAYS = 14
ACTIVE_TRADER_THRESHOLD = 5       # >= 5 closed trades in window = "active"


class EligibilityNudgeEngine:
    def __init__(self):
        self._running = False

    async def start(self):
        self._running = True
        logger.info("Eligibility-nudge engine started (tick=%ds)", TICK_INTERVAL)
        asyncio.create_task(self._run())

    async def stop(self):
        self._running = False

    async def _run(self):
        while self._running:
            try:
                async with AsyncSessionLocal() as db:
                    sent = await send_due_eligibility_nudges(db)
                    await db.commit()
                if sent:
                    logger.info("Eligibility nudge: emailed %d users", sent)
            except Exception as e:
                logger.error("Eligibility-nudge engine error: %s", e, exc_info=True)
            await asyncio.sleep(TICK_INTERVAL)


async def send_due_eligibility_nudges(db: AsyncSession) -> int:
    try:
        from packages.common.src.smtp_mail import (
            send_email, smtp_configured, fire_and_forget,
        )
        from packages.common.src.email_templates import render_fr_insurance_eligibility
        from packages.common.src.config import get_settings
    except Exception as e:
        logger.warning("eligibility nudge setup failed: %s", e)
        return 0

    if not smtp_configured():
        return 0

    now = datetime.now(timezone.utc)
    resend_cutoff = now - timedelta(days=RESEND_DAYS)
    activity_cutoff = now - timedelta(days=ACTIVITY_WINDOW_DAYS)
    app_url = (get_settings().TRADER_APP_URL or "https://trade.swisdex.com")

    # Filter at the SQL level so we don't pull every user every tick.
    # Only verified non-demo users with KYC approved and balance over
    # threshold are candidates; the engine picks the flavor in Python.
    candidates = (await db.execute(
        select(User).where(
            # User account state lives in the `status` string column
            # ("active"/"suspended"/"closed"). There is no is_active
            # boolean — accidentally referencing one was crashing this
            # engine on every tick.
            User.status == "active",
            User.email_verified.is_(True),
            User.kyc_status == "approved",
            or_(
                User.fr_insurance_nudge_sent_at.is_(None),
                User.fr_insurance_nudge_sent_at <= resend_cutoff,
            ),
        )
    )).scalars().all()

    sent = 0
    for u in candidates:
        # Never email demo or promotional/showcase accounts.
        if not u.email or bool(getattr(u, "is_demo", False)) or bool(getattr(u, "is_promotional", False)):
            continue

        # Aggregate funded balance across real trading accounts.
        bal_row = (await db.execute(
            select(func.coalesce(func.sum(TradingAccount.balance), 0)).where(
                TradingAccount.user_id == u.id,
                TradingAccount.is_demo.is_(False),
                TradingAccount.is_active.is_(True),
            )
        )).scalar()
        funded_balance = Decimal(str(bal_row or 0))
        if funded_balance < MIN_FUNDED_BALANCE:
            continue

        # Count recent closed trades to pick the flavor.
        trade_count = (await db.execute(
            select(func.count()).select_from(TradeHistory)
            .join(TradingAccount, TradeHistory.account_id == TradingAccount.id)
            .where(
                TradingAccount.user_id == u.id,
                TradeHistory.closed_at >= activity_cutoff,
            )
        )).scalar() or 0

        if trade_count >= ACTIVE_TRADER_THRESHOLD:
            # Active + funded = pitch both products.
            flavor = "both"
        elif trade_count == 0:
            flavor = "fr"
        else:
            # Some activity but light — Insurance fits without scaring
            # the user with a lock-up commitment.
            flavor = "insurance"

        try:
            subject, html, text = render_fr_insurance_eligibility(
                first_name=u.first_name,
                flavor=flavor,
                funded_balance=funded_balance,
                trader_app_url=app_url,
            )
            # Pick the right alias by flavor — pure insurance pitch goes
            # from insure@, fixed-return pitch from stacking@, mixed/both
            # goes from info@ since it's the general "you're eligible"
            # touch.
            cat = "insure" if flavor == "insurance" else "stacking" if flavor == "fr" else "info"
            fire_and_forget(send_email(u.email, subject, html, text=text, category=cat))
        except Exception as exc:
            logger.warning("Eligibility nudge render failed for %s: %s", u.email, exc)
            continue
        u.fr_insurance_nudge_sent_at = now
        sent += 1
    return sent


eligibility_nudge_engine = EligibilityNudgeEngine()
