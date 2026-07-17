"""AI-POWERED STAKING PROGRAM interest-payout engine.

Polls hourly; on every tick it calls fixed_return_service.accrue_due_payouts
which credits one interest cycle to every active lock whose
next_payout_at has elapsed. Idempotent — the service only acts on locks
where next_payout_at is in the past, and advances the schedule in the
same transaction, so a deploy or crash mid-cycle never double-pays.
"""
import asyncio
import logging
from datetime import datetime, timezone

from packages.common.src.database import AsyncSessionLocal
from ..services import fixed_return_service

logger = logging.getLogger("fixed-return-engine")

# Hourly cadence is plenty — the user-facing schedule is in days; we
# just need to clear queued payouts a few times a day. Engines stop
# clean on shutdown via the asyncio task cancellation hook.
TICK_INTERVAL = 3600


class FixedReturnEngine:
    def __init__(self) -> None:
        self._running = False

    async def start(self):
        self._running = True
        logger.info("AI-POWERED STAKING PROGRAM engine started (tick=%ds)", TICK_INTERVAL)
        asyncio.create_task(self._run())

    async def stop(self):
        self._running = False

    async def _run(self):
        from packages.common.src.redis_client import acquire_leader_lock
        while self._running:
            try:
                # Leader lock — only one worker accrues interest, else
                # double-payout under --workers N (audit C1/C3).
                if not await acquire_leader_lock("engine:fixed_return:lock", 50):
                    await asyncio.sleep(TICK_INTERVAL)
                    continue
                async with AsyncSessionLocal() as db:
                    paid = await fixed_return_service.accrue_due_payouts(db)
                if paid:
                    logger.info(
                        "AI-POWERED STAKING PROGRAM: paid %d interest cycle(s) at %s",
                        paid, datetime.now(timezone.utc).isoformat(),
                    )
            except Exception as e:
                logger.error("AI-POWERED STAKING PROGRAM engine error: %s", e, exc_info=True)
            await asyncio.sleep(TICK_INTERVAL)


fixed_return_engine = FixedReturnEngine()
