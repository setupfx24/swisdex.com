"""Reconcile NOWPayments crypto deposits whose IPN webhook never arrived.

The deposit flow normally credits a user when NOWPayments POSTs the IPN webhook
to `/api/v1/webhooks/nowpayments`. If that webhook is blocked or undelivered
(Cloudflare bot protection, dashboard misconfig, transient outage), the deposit
sits in `initiated`/`pending` forever even though the user already paid and the
funds are in NOWPayments custody.

This engine polls NOWPayments directly for every recent pending NOWPayments
deposit and settles it through the SAME `handle_nowpayments_webhook` code path
once NOWPayments reports the payment finished/confirmed (or failed). It makes
deposits reliable without depending on the webhook at all.

Idempotent + fail-safe:
  - `handle_nowpayments_webhook` skips rows that are already terminal, so a
    deposit is never double-credited (webhook + poller racing is fine).
  - If the NOWPayments lookup returns nothing, the deposit is left untouched —
    the poller can never mis-credit.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.database import AsyncSessionLocal
from packages.common.src.models import Deposit

logger = logging.getLogger("nowpayments-reconcile")

TICK_INTERVAL = 120          # poll every 2 minutes
LOOKBACK_HOURS = 72          # only chase deposits from the last 3 days

# NOWPayments payment_status values, most-progressed first.
_SUCCESS = ("finished", "confirmed")
_FAILURE = ("failed", "expired", "refunded")
_INFLIGHT = ("sending", "confirming", "partially_paid", "waiting")


def _pick_payment(payments: list[dict]) -> dict | None:
    """Pick the most-progressed payment for an invoice: a settled one wins over
    an in-flight one; an in-flight one wins over nothing."""
    if not payments:
        return None
    def rank(p: dict) -> int:
        s = (p.get("payment_status") or "").lower()
        if s in _SUCCESS:
            return 3
        if s in _FAILURE:
            return 2
        if s in _INFLIGHT:
            return 1
        return 0
    return sorted(payments, key=rank, reverse=True)[0]


class NowPaymentsReconcileEngine:
    def __init__(self) -> None:
        self._running = False

    async def start(self):
        self._running = True
        logger.info("NOWPayments reconcile engine started (tick=%ds)", TICK_INTERVAL)
        asyncio.create_task(self._run())

    async def stop(self):
        self._running = False

    async def _run(self):
        while self._running:
            try:
                async with AsyncSessionLocal() as db:
                    await reconcile_pending(db)
            except Exception as e:
                logger.error("NOWPayments reconcile error: %s", e, exc_info=True)
            await asyncio.sleep(TICK_INTERVAL)


async def reconcile_pending(db: AsyncSession) -> int:
    """Check every recent pending NOWPayments deposit against NOWPayments and
    settle the ones it reports as paid/failed. Returns the count settled."""
    from ..services import nowpayments_service, wallet_service

    cutoff = datetime.now(timezone.utc) - timedelta(hours=LOOKBACK_HOURS)
    # Select plain columns (not ORM rows): handle_nowpayments_webhook commits
    # per deposit, which would expire ORM objects and break later iterations in
    # async. It re-loads the deposit by id anyway, so we only need (id, txid).
    rows = (await db.execute(
        select(Deposit.id, Deposit.transaction_id).where(
            Deposit.method == "nowpayments",
            Deposit.status.in_(("initiated", "pending")),
            Deposit.created_at >= cutoff,
        )
    )).all()

    settled = 0
    for dep_id, txid in rows:
        ref = (txid or "").strip()
        if not ref:
            continue

        # transaction_id holds the NOWPayments invoice_id at creation. (A live
        # IPN would have overwritten it with a payment_id — but the IPN is
        # exactly what failed here, so for these rows it's still the invoice.)
        status = None
        payment_id = None
        payments = await nowpayments_service.list_invoice_payments(ref)
        best = _pick_payment(payments)
        if best is not None:
            status = (best.get("payment_status") or "").lower()
            payment_id = str(best.get("payment_id") or "") or None
        else:
            # Fallback: `ref` might already be a payment_id (an in-flight IPN
            # had fired once). Try a direct status lookup; ignore failures.
            try:
                data = await nowpayments_service.get_payment_status(ref)
                status = (data.get("payment_status") or "").lower() or None
                payment_id = str(data.get("payment_id") or ref) or None
            except Exception:
                status = None

        if not status:
            continue

        try:
            await wallet_service.handle_nowpayments_webhook(
                order_id=str(dep_id),
                np_status=status,
                payment_id=payment_id,
                payload={"source": "reconcile_poller"},
                db=db,
            )
            if status in _SUCCESS or status in _FAILURE:
                settled += 1
                logger.info("Reconciled NOWPayments deposit %s → %s", dep_id, status)
        except Exception as e:
            logger.error("Reconcile credit failed for deposit %s: %s", dep_id, e)

    return settled


# Singleton, started/stopped from the gateway lifespan (mirrors the other engines).
nowpayments_reconcile_engine = NowPaymentsReconcileEngine()
