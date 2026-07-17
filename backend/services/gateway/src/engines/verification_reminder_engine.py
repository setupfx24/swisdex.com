"""KYC verification reminder engine.

Sends the first nudge 24 hours after signup if KYC isn't complete, then
re-nudges every 7 days for as long as the user stays in pending /
rejected. Each send updates ``users.kyc_last_reminded_at`` so a deploy
mid-day never double-mails the same user.

(The old 3-day/7-day "stage" counter was bounded — stopped emailing
after stage 2. Client wants the platform to keep nudging.)

Idempotent on the engine side: tick hourly, but the SQL filter only
returns users whose kyc_last_reminded_at is older than the threshold
for their current cohort.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.database import AsyncSessionLocal
from packages.common.src.models import User

logger = logging.getLogger("verification-reminder")

TICK_INTERVAL = 3600  # check hourly so a deploy mid-day still triggers
FIRST_NUDGE_HOURS = 24
RESEND_DAYS = 7


class VerificationReminderEngine:
    def __init__(self):
        self._running = False

    async def start(self):
        self._running = True
        logger.info("Verification reminder engine started (tick=%ds)", TICK_INTERVAL)
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
                    logger.info("KYC reminder: emailed %d users", sent)
            except Exception as e:
                logger.error("Verification reminder engine error: %s", e, exc_info=True)
            await asyncio.sleep(TICK_INTERVAL)


async def send_due_reminders(db: AsyncSession) -> int:
    """Pick every KYC-pending user who is either due for their first
    nudge (signed up >= 24h ago, never reminded) or due for their next
    weekly nudge (last reminded >= 7 days ago)."""
    try:
        from packages.common.src.smtp_mail import (
            send_email, smtp_configured, fire_and_forget,
        )
        from packages.common.src.email_templates import render_verification_reminder
        from packages.common.src.config import get_settings
    except Exception as e:
        logger.warning("verification reminder setup failed: %s", e)
        return 0

    if not smtp_configured():
        return 0

    now = datetime.now(timezone.utc)
    first_cutoff = now - timedelta(hours=FIRST_NUDGE_HOURS)
    resend_cutoff = now - timedelta(days=RESEND_DAYS)
    app_url = (get_settings().TRADER_APP_URL or "https://trade.swisdex.com")

    candidates = (await db.execute(
        select(User).where(
            User.kyc_status.in_(("pending", "rejected")),
            User.created_at <= first_cutoff,
            or_(
                User.kyc_last_reminded_at.is_(None),
                User.kyc_last_reminded_at <= resend_cutoff,
            ),
        )
    )).scalars().all()

    sent = 0
    for u in candidates:
        # Never email demo or promotional/showcase accounts.
        if not u.email or bool(getattr(u, "is_demo", False)) or bool(getattr(u, "is_promotional", False)):
            continue
        days_old = max(0, (now - u.created_at).days) if u.created_at else 0
        try:
            subject, html, text = render_verification_reminder(
                first_name=u.first_name,
                days_since_signup=days_old,
                trader_app_url=app_url,
            )
            fire_and_forget(send_email(u.email, subject, html, text=text, category="support"))
        except Exception as exc:
            logger.warning("KYC reminder render failed for %s: %s", u.email, exc)
            continue
        u.kyc_last_reminded_at = now
        sent += 1
    return sent


verification_reminder_engine = VerificationReminderEngine()
