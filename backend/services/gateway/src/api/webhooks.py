"""Public webhook endpoints — no JWT auth, secured by provider-specific HMAC."""
import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.database import get_db
from packages.common.src.idempotency import claim_webhook
from ..services import oxapay_service, nowpayments_service, wallet_service

router = APIRouter()
logger = logging.getLogger("webhooks")


@router.post("/oxapay")
async def oxapay_webhook(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """OxaPay payment status callback. Public endpoint secured by HMAC-SHA512."""
    raw_body = await request.body()
    hmac_header = request.headers.get("HMAC", "") or request.headers.get("hmac", "")

    if not oxapay_service.verify_webhook_signature(raw_body, hmac_header):
        logger.warning("OxaPay webhook: invalid HMAC signature")
        raise HTTPException(status_code=403, detail="Invalid signature")

    try:
        payload = json.loads(raw_body)
    except (json.JSONDecodeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid JSON")

    order_id = payload.get("orderId")
    status = payload.get("status")
    track_id = payload.get("trackId")

    if not order_id or not status:
        logger.info("OxaPay webhook: missing orderId/status, ignoring")
        return {"status": "ignored"}

    # Idempotency: trackId is OxaPay's stable per-payment identifier.
    # Falling back to (orderId, status) when track is missing keeps lifecycle
    # transitions (waiting → paid → expired) distinct.
    dedup_id = str(track_id or f"{order_id}:{status}")
    if not await claim_webhook(
        db, provider="oxapay", external_id=dedup_id,
        event_type=str(status), raw_body=raw_body,
    ):
        return {"status": "duplicate"}

    logger.info("OxaPay webhook: order=%s status=%s track=%s", order_id, status, track_id)

    await wallet_service.handle_oxapay_webhook(
        order_id=order_id,
        oxapay_status=status,
        track_id=track_id,
        payload=payload,
        db=db,
    )

    return {"status": "ok"}


@router.post("/nowpayments")
async def nowpayments_webhook(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """NOWPayments IPN callback. Public endpoint secured by HMAC-SHA512.

    Signature header is `x-nowpayments-sig`; the body must be canonicalised
    (JSON keys sorted alphabetically) before HMAC verification — that's
    handled inside nowpayments_service.verify_webhook_signature."""
    raw_body = await request.body()
    sig = (
        request.headers.get("x-nowpayments-sig")
        or request.headers.get("X-Nowpayments-Sig")
        or ""
    )

    if not nowpayments_service.verify_webhook_signature(raw_body, sig):
        logger.warning("NOWPayments webhook: invalid HMAC signature")
        raise HTTPException(status_code=403, detail="Invalid signature")

    try:
        payload = json.loads(raw_body)
    except (json.JSONDecodeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid JSON")

    # NOWPayments sends both invoice-level + payment-level fields. We use
    # `order_id` (echoed back from the invoice we created) to look up the
    # deposit row, `payment_status` for the lifecycle stage, and
    # `payment_id` to stamp transaction_id.
    order_id = payload.get("order_id")
    status = payload.get("payment_status") or payload.get("status")
    payment_id = payload.get("payment_id")

    if not order_id or not status:
        logger.info("NOWPayments webhook: missing order_id/status, ignoring")
        return {"status": "ignored"}

    # NOWPayments retries IPNs; payment_id+status is the natural dedup key.
    dedup_id = f"{payment_id or order_id}:{status}"
    if not await claim_webhook(
        db, provider="nowpayments", external_id=dedup_id,
        event_type=str(status), raw_body=raw_body,
    ):
        return {"status": "duplicate"}

    logger.info(
        "NOWPayments webhook: order=%s status=%s payment_id=%s",
        order_id, status, payment_id,
    )

    await wallet_service.handle_nowpayments_webhook(
        order_id=str(order_id),
        np_status=str(status),
        payment_id=str(payment_id) if payment_id else None,
        payload=payload,
        db=db,
    )

    return {"status": "ok"}


@router.post("/nowpayments-payout")
async def nowpayments_payout_webhook(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """NOWPayments PAYOUT IPN — updates an automatic crypto withdrawal's status.

    Same HMAC-SHA512 / sorted-JSON verification as the deposit IPN. Correlates
    on the payout batch id we stored on the withdrawal. finished → completed;
    failed/rejected/expired → failed + wallet refund (handled in wallet_service).
    """
    raw_body = await request.body()
    sig = (
        request.headers.get("x-nowpayments-sig")
        or request.headers.get("X-Nowpayments-Sig")
        or ""
    )
    if not nowpayments_service.verify_webhook_signature(raw_body, sig):
        logger.warning("NOWPayments payout webhook: invalid HMAC signature")
        raise HTTPException(status_code=403, detail="Invalid signature")
    try:
        payload = json.loads(raw_body)
    except (json.JSONDecodeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid JSON")

    batch_id = str(payload.get("batch_withdrawal_id") or payload.get("id") or "")
    status = payload.get("status") or payload.get("payment_status")
    if not batch_id or not status:
        return {"status": "ignored"}

    dedup_id = f"payout:{batch_id}:{payload.get('id')}:{status}"
    if not await claim_webhook(
        db, provider="nowpayments-payout", external_id=dedup_id,
        event_type=str(status), raw_body=raw_body,
    ):
        return {"status": "duplicate"}

    logger.info("NOWPayments payout webhook: batch=%s status=%s", batch_id, status)
    await wallet_service.handle_nowpayments_payout_webhook(
        batch_id=batch_id, status=str(status), payload=payload, db=db,
    )
    return {"status": "ok"}
