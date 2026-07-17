"""One-time 'claim your first-deposit bonus' email engine.

Fires for every verified user who:
  - signed up >= 24 hours ago,
  - has no approved/auto-approved deposit on file, and
  - has never received the bonus nudge before (deposit_nudge_sent_at IS NULL).

After sending, the engine sets ``users.deposit_nudge_sent_at`` so the
user only gets the email once even if they never deposit.

Runs hourly off the same lifespan task pattern as the other engines so
a mid-day deploy doesn't miss a cohort.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.database import AsyncSessionLocal
from packages.common.src.models import User, Deposit

logger = logging.getLogger("deposit-reminder")

TICK_INTERVAL = 3600
SIGNUP_AGE_HOURS = 24
# The bonus % shown in the email copy. The actual amount credited at
# deposit time comes from BonusOffer rows the admin manages — this is
# just marketing text.
ADVERTISED_BONUS_PCT = 100


class DepositReminderEngine:
    def __init__(self) -> None:
        self._running = False

    async def start(self):
        self._running = True
        logger.info("Deposit reminder engine started (tick=%ds)", TICK_INTERVAL)
        asyncio.create_task(self._run())

    async def stop(self):
        self._running = False

    async def _run(self):
        while self._running:
            try:
                async with AsyncSessionLocal() as db:
                    sent = await send_due_reminders(db)
                    await db.commit()
                if sent:
                    logger.info("Deposit nudge: emailed %d users", sent)
            except Exception as e:
                logger.error("Deposit reminder engine error: %s", e, exc_info=True)
            await asyncio.sleep(TICK_INTERVAL)


async def send_due_reminders(db: AsyncSession) -> int:
    try:
        from packages.common.src.smtp_mail import (
            send_email, smtp_configured, fire_and_forget,
        )
        from packages.common.src.email_templates import render_first_deposit_bonus_offer
        from packages.common.src.config import get_settings
    except Exception as e:
        logger.warning("deposit reminder setup failed: %s", e)
        return 0

    if not smtp_configured():
        return 0

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=SIGNUP_AGE_HOURS)
    app_url = (get_settings().TRADER_APP_URL or "https://trade.swisdex.com")

    # Subquery: distinct user_ids with at least one approved deposit.
    funded_q = (
        select(Deposit.user_id)
        .where(Deposit.status.in_(["approved", "auto_approved"]))
    )

    candidates = (await db.execute(
        select(User).where(
            User.deposit_nudge_sent_at.is_(None),
            User.created_at <= cutoff,
            User.is_demo.is_(False),
            User.is_promotional.isnot(True),  # never email promo/demo accounts
            User.email_verified.is_(True),
            User.id.not_in(funded_q),
        )
    )).scalars().all()

    sent = 0
    for u in candidates:
        if not u.email:
            continue
        try:
            subject, html, text = render_first_deposit_bonus_offer(
                first_name=u.first_name,
                trader_app_url=app_url,
                bonus_pct=ADVERTISED_BONUS_PCT,
            )
            fire_and_forget(send_email(u.email, subject, html, text=text, category="account"))
        except Exception as exc:
            logger.warning("deposit nudge render failed for %s: %s", u.email, exc)
            continue
        u.deposit_nudge_sent_at = now
        sent += 1
    return sent


deposit_reminder_engine = DepositReminderEngine()
