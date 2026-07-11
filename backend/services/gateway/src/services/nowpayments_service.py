"""NOWPayments crypto payment gateway integration.

Mirrors `oxapay_service` shape so wallet_service can swap providers with a
one-line dispatch change. Uses the hosted-invoice flow:
  POST /v1/invoice → user redirected to invoice_url → user pays →
  NOWPayments POSTs IPN (signed via HMAC-SHA512) to our webhook.
"""
import hashlib
import hmac
import json
import logging
import time
from decimal import Decimal
from typing import Optional

import httpx

from packages.common.src.config import get_settings

logger = logging.getLogger("nowpayments_service")

NOWPAYMENTS_PROD_URL = "https://api.nowpayments.io/v1"
NOWPAYMENTS_SANDBOX_URL = "https://api-sandbox.nowpayments.io/v1"


# Map frontend crypto asset IDs → NOWPayments pay_currency codes.
# NOWPayments uses lowercase chain-suffixed codes for stablecoins
# (e.g. "usdttrc20", "usdcerc20"). See https://nowpayments.io/supported-coins.
CURRENCY_MAP: dict[str, str] = {
    "BTC": "btc",
    "ETH": "eth",
    "USDT_ERC": "usdterc20",
    "USDC_ERC": "usdcerc20",
    "TRX": "trx",
    "USDT_TRC": "usdttrc20",
    "USDC_TRC": "usdctrc20",
    "USDT_SOL": "usdtsol",
    "USDC_SOL": "usdcsol",
    "SOL": "sol",
    "XRP": "xrp",
    # BNB Smart Chain — MetaMask's native BNB network. `bnbbsc` is BNB
    # itself; `usdtbsc` / `usdcbsc` are the BEP-20 stablecoins on BSC.
    "BNB_BSC": "bnbbsc",
    "USDT_BSC": "usdtbsc",
    "USDC_BSC": "usdcbsc",
}


def resolve_currency(frontend_id: str) -> str:
    """Return NOWPayments pay_currency code for a frontend asset ID, or
    the raw input lowercased as a best-effort fallback."""
    return CURRENCY_MAP.get(frontend_id, (frontend_id or "").lower())


def _api_base() -> str:
    return NOWPAYMENTS_SANDBOX_URL if get_settings().NOWPAYMENTS_SANDBOX else NOWPAYMENTS_PROD_URL


async def create_payment(
    amount: Decimal,
    crypto_currency: Optional[str],
    order_id: str,
    description: str = "",
    *,
    success_url: Optional[str] = None,
    cancel_url: Optional[str] = None,
) -> dict:
    """Create a NOWPayments hosted invoice.

    If `crypto_currency` is None, NOWPayments shows its full currency picker
    on the hosted page. When set, the page is pre-locked to that asset.

    Returns: {"invoice_id": str, "payment_url": str}.
    Raises ValueError on configuration or API errors.
    """
    settings = get_settings()
    if not settings.NOWPAYMENTS_API_KEY:
        raise ValueError("NOWPayments API key not configured")

    callback_base = (settings.NOWPAYMENTS_CALLBACK_BASE_URL or "").rstrip("/")
    if not callback_base:
        raise ValueError("NOWPAYMENTS_CALLBACK_BASE_URL not configured")
    ipn_url = f"{callback_base}/api/v1/webhooks/nowpayments"

    payload: dict = {
        "price_amount": float(amount),
        "price_currency": "usd",
        "order_id": order_id,
        "order_description": description or f"Deposit {order_id[:8]}",
        "ipn_callback_url": ipn_url,
        # NOWPayments shows these on the hosted page so the user can return
        # to our app after paying or cancelling.
        "success_url": success_url or "https://trade.swisdex.com/wallet",
        "cancel_url": cancel_url or "https://trade.swisdex.com/wallet",
        "is_fixed_rate": False,
        "is_fee_paid_by_user": True,
    }
    if crypto_currency:
        payload["pay_currency"] = resolve_currency(crypto_currency)

    headers = {
        "x-api-key": settings.NOWPAYMENTS_API_KEY,
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(f"{_api_base()}/invoice", headers=headers, json=payload)
        try:
            data = resp.json()
        except Exception:
            data = {"raw": resp.text}
        if resp.status_code >= 400:
            logger.error("NOWPayments create invoice failed status=%s body=%s", resp.status_code, data)
            raise ValueError(f"NOWPayments error {resp.status_code}: {data}")
        logger.info("NOWPayments invoice created: order=%s id=%s", order_id, data.get("id"))

    payment_url = data.get("invoice_url")
    invoice_id = data.get("id")
    if not payment_url or not invoice_id:
        raise ValueError(f"NOWPayments returned no invoice_url/id: {data}")
    return {"invoice_id": str(invoice_id), "payment_url": payment_url}


# ─── Direct payment (wallet-connect flow) ───────────────────────────
#
# /v1/payment returns a single pay_address + pay_amount + expires_at,
# rather than redirecting the user to NOWPayments' hosted page. The
# trader keeps the user on SwisDex and shows the address + a wallet-
# connect button (wagmi/RainbowKit) that signs the transfer.

# Frontend network IDs we surface back to the wallet-connect layer so
# it can pre-switch the user's wallet to the right chain. Maps from the
# user's selected asset → chain slug.
NETWORK_MAP: dict[str, str] = {
    "ETH": "eth",
    "USDT_ERC": "eth",
    "USDC_ERC": "eth",
    "USDT_TRC": "tron",
    "USDC_TRC": "tron",
    "USDT_SOL": "sol",
    "USDC_SOL": "sol",
    "SOL": "sol",
    "BTC": "btc",
    "TRX": "tron",
    "XRP": "xrp",
    "BNB": "bsc",
    "USDT_BSC": "bsc",
    "USDC_BSC": "bsc",
    "MATIC": "polygon",
    "USDT_MATIC": "polygon",
    "USDC_MATIC": "polygon",
    "ARB": "arbitrum",
    "USDT_ARB": "arbitrum",
    "USDC_ARB": "arbitrum",
}


async def create_direct_payment(
    amount_usd: Decimal,
    crypto_currency: str,
    order_id: str,
    description: str = "",
) -> dict:
    """Create a NOWPayments direct payment (no hosted page).

    Returns dict with the fields the frontend needs to render the
    deposit screen entirely on our site:
      payment_id     — NOWPayments id (stored in deposits.transaction_id)
      pay_address    — admin's deposit address
      pay_amount     — exact crypto amount (string, preserves precision)
      pay_currency   — NOWPayments code (usdterc20, eth, …)
      network        — wagmi-friendly slug (eth, bsc, …)
      expires_at     — ISO timestamp string from NOWPayments
    Raises ValueError on missing config or non-2xx response.
    """
    settings = get_settings()
    if not settings.NOWPAYMENTS_API_KEY:
        raise ValueError("NOWPayments API key not configured")

    pay_currency = resolve_currency(crypto_currency)
    callback_base = (settings.NOWPAYMENTS_CALLBACK_BASE_URL or "").rstrip("/")
    if not callback_base:
        raise ValueError("NOWPAYMENTS_CALLBACK_BASE_URL not configured")
    ipn_url = f"{callback_base}/api/v1/webhooks/nowpayments"

    payload = {
        "price_amount": float(amount_usd),
        "price_currency": "usd",
        "pay_currency": pay_currency,
        "order_id": order_id,
        "order_description": description or f"Deposit {order_id[:8]}",
        "ipn_callback_url": ipn_url,
        "is_fixed_rate": False,
        "is_fee_paid_by_user": True,
    }

    headers = {
        "x-api-key": settings.NOWPAYMENTS_API_KEY,
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(f"{_api_base()}/payment", headers=headers, json=payload)
        try:
            data = resp.json()
        except Exception:
            data = {"raw": resp.text}
        if resp.status_code >= 400:
            logger.error("NOWPayments create payment failed status=%s body=%s", resp.status_code, data)
            raise ValueError(f"NOWPayments error {resp.status_code}: {data}")
        logger.info(
            "NOWPayments payment created: order=%s id=%s currency=%s",
            order_id, data.get("payment_id"), pay_currency,
        )

    payment_id = data.get("payment_id") or data.get("id")
    pay_address = data.get("pay_address")
    pay_amount = data.get("pay_amount")
    if not (payment_id and pay_address and pay_amount):
        raise ValueError(f"NOWPayments returned incomplete payment: {data}")

    return {
        "payment_id": str(payment_id),
        "pay_address": str(pay_address),
        "pay_amount": str(pay_amount),
        "pay_currency": pay_currency,
        "network": NETWORK_MAP.get(crypto_currency, ""),
        "expires_at": data.get("valid_until") or data.get("expiration_estimate_date"),
    }


async def get_payment_status(payment_id: str) -> dict:
    """Read-only status check used for client-side polling. Returns the
    raw NOWPayments payload so the API route can surface confirmation
    progress to the UI. Never credits balance — that's webhook-only."""
    settings = get_settings()
    if not settings.NOWPAYMENTS_API_KEY:
        raise ValueError("NOWPayments API key not configured")
    headers = {"x-api-key": settings.NOWPAYMENTS_API_KEY}
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(f"{_api_base()}/payment/{payment_id}", headers=headers)
        try:
            data = resp.json()
        except Exception:
            data = {"raw": resp.text}
        if resp.status_code >= 400:
            raise ValueError(f"NOWPayments status fetch failed {resp.status_code}: {data}")
    return data


async def list_invoice_payments(invoice_id: str) -> list[dict]:
    """List the payment attempts made against a NOWPayments invoice.

    Used by the reconciliation poller to settle deposits whose IPN webhook
    never arrived (Cloudflare/dashboard issues). Returns the raw `data` list
    (each entry has `payment_id`, `payment_status`, `order_id`, …) or [] on any
    error — the caller treats an empty list as 'nothing to settle yet', so a
    wrong endpoint can never mis-credit, it just won't reconcile."""
    settings = get_settings()
    if not settings.NOWPAYMENTS_API_KEY or not invoice_id:
        return []
    headers = {"x-api-key": settings.NOWPAYMENTS_API_KEY}
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(
                f"{_api_base()}/payment/",
                params={"invoiceId": str(invoice_id), "limit": 20, "page": 0},
                headers=headers,
            )
            if resp.status_code >= 400:
                return []
            data = resp.json()
    except Exception:
        return []
    return data.get("data") or [] if isinstance(data, dict) else []


def verify_webhook_signature(raw_body: bytes, received_hmac: str) -> bool:
    """Verify the IPN HMAC-SHA512 signature.

    NOWPayments documents that the signature is computed over the JSON body
    re-serialised with **keys sorted alphabetically** (no whitespace) using
    `IPN_SECRET` as the HMAC key. Constant-time compare against the
    `x-nowpayments-sig` header.
    """
    settings = get_settings()
    secret = (settings.NOWPAYMENTS_IPN_SECRET or "").strip()
    if not secret:
        # Fail closed: if the operator hasn't configured a secret, no IPN
        # is trusted. Better than silently accepting forged callbacks.
        logger.error("NOWPayments IPN secret not configured — refusing webhook")
        return False
    if not received_hmac:
        return False
    try:
        # Re-serialise sorted to match NOWPayments' canonicalisation.
        parsed = json.loads(raw_body.decode("utf-8"))
        canonical = json.dumps(parsed, sort_keys=True, separators=(",", ":"))
    except Exception as e:
        logger.warning("NOWPayments webhook body unparseable: %s", e)
        return False
    computed = hmac.new(secret.encode(), canonical.encode(), hashlib.sha512).hexdigest()
    return hmac.compare_digest(computed, received_hmac)


# ─── Automatic withdrawals (payouts) — /v1/payout ────────────────────
#
# Unlike deposits (x-api-key only), the payout API needs a short-lived JWT
# from the account login (/v1/auth). Disable whitelisting + 2FA on the
# NOWPayments dashboard so payouts run unattended. The merchant must hold
# crypto balance in NOWPayments custody to fund payouts.

# Cache the JWT in-process; NOWPayments tokens are short-lived (~5 min).
_jwt_cache: dict = {"token": None, "exp_mono": 0.0}


def payouts_configured() -> bool:
    """True only when the payout credentials are present, so callers can fall
    back to the manual flow instead of erroring when auto-payout isn't set up."""
    s = get_settings()
    return bool(s.NOWPAYMENTS_API_KEY and s.NOWPAYMENTS_EMAIL and s.NOWPAYMENTS_PASSWORD)


async def _get_payout_jwt() -> str:
    """Log in to NOWPayments and return a bearer token, cached ~4 minutes."""
    now = time.monotonic()
    if _jwt_cache["token"] and now < _jwt_cache["exp_mono"]:
        return _jwt_cache["token"]
    settings = get_settings()
    if not (settings.NOWPAYMENTS_EMAIL and settings.NOWPAYMENTS_PASSWORD):
        raise ValueError("NOWPayments payout credentials (email/password) not configured")
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{_api_base()}/auth",
            json={"email": settings.NOWPAYMENTS_EMAIL, "password": settings.NOWPAYMENTS_PASSWORD},
        )
        try:
            data = resp.json()
        except Exception:
            data = {"raw": resp.text}
        if resp.status_code >= 400 or not data.get("token"):
            logger.error("NOWPayments auth failed status=%s body=%s", resp.status_code, data)
            raise ValueError(f"NOWPayments auth error {resp.status_code}: {data}")
    token = str(data["token"])
    _jwt_cache["token"] = token
    _jwt_cache["exp_mono"] = now + 240.0  # refresh well before the ~5-min expiry
    return token


async def estimate_crypto_amount(amount_usd: Decimal, np_currency: str) -> Decimal:
    """Convert a USD amount to the crypto payout amount via /v1/estimate.
    Near 1:1 for USDT/USDC; real market rate for BTC/ETH/etc."""
    settings = get_settings()
    headers = {"x-api-key": settings.NOWPAYMENTS_API_KEY}
    params = {"amount": float(amount_usd), "currency_from": "usd", "currency_to": np_currency}
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(f"{_api_base()}/estimate", headers=headers, params=params)
        try:
            data = resp.json()
        except Exception:
            data = {"raw": resp.text}
        if resp.status_code >= 400 or data.get("estimated_amount") is None:
            raise ValueError(f"NOWPayments estimate failed {resp.status_code}: {data}")
    return Decimal(str(data["estimated_amount"]))


async def create_payout(
    *, address: str, np_currency: str, crypto_amount: Decimal, order_id: str,
) -> dict:
    """Send a single crypto payout via /v1/payout.

    Returns {"batch_id": str, "payout_id": str|None, "raw": dict}. Raises
    ValueError on auth/API errors so the caller can refund the wallet.
    With 2FA disabled on the dashboard, no verify step is required.
    """
    settings = get_settings()
    if not settings.NOWPAYMENTS_API_KEY:
        raise ValueError("NOWPayments API key not configured")
    callback_base = (settings.NOWPAYMENTS_CALLBACK_BASE_URL or "").rstrip("/")
    ipn_url = f"{callback_base}/api/v1/webhooks/nowpayments-payout" if callback_base else None

    token = await _get_payout_jwt()
    headers = {
        "x-api-key": settings.NOWPAYMENTS_API_KEY,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    withdrawal: dict = {
        "address": address,
        "currency": np_currency,
        "amount": float(crypto_amount),
    }
    if ipn_url:
        withdrawal["ipn_callback_url"] = ipn_url
    payload: dict = {"withdrawals": [withdrawal]}
    if ipn_url:
        payload["ipn_callback_url"] = ipn_url

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(f"{_api_base()}/payout", headers=headers, json=payload)
        try:
            data = resp.json()
        except Exception:
            data = {"raw": resp.text}
        if resp.status_code >= 400:
            logger.error("NOWPayments payout failed status=%s body=%s order=%s",
                         resp.status_code, data, order_id)
            raise ValueError(f"NOWPayments payout error {resp.status_code}: {data}")
        logger.info("NOWPayments payout created: order=%s batch=%s", order_id, data.get("id"))

    batch_id = data.get("id") or data.get("batch_id")
    payouts = data.get("withdrawals") or []
    payout_id = (payouts[0].get("id") if payouts and isinstance(payouts[0], dict) else None)
    if not batch_id:
        raise ValueError(f"NOWPayments payout returned no batch id: {data}")
    return {"batch_id": str(batch_id), "payout_id": str(payout_id) if payout_id else None, "raw": data}
