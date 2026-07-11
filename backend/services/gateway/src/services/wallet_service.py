"""Wallet Service — Deposits, withdrawals, transfers, wallet summary."""
import logging
import uuid as uuid_lib
from pathlib import Path
from decimal import Decimal
from uuid import UUID
from datetime import datetime, timezone

from fastapi import HTTPException, UploadFile
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.models import (
    BankAccount, BonusOffer, Deposit, Transaction, TradingAccount, User, UserBonus, Withdrawal,
    AccountGroup,
)
from packages.common.src.notify import create_notification
from packages.common.src.config import get_settings
from packages.common.src.path_safety import PathTraversalError, safe_join_under_base
from . import oxapay_service, nowpayments_service

logger = logging.getLogger("wallet_service")

DEPOSIT_PROOF_EXT = {".jpg", ".jpeg", ".png", ".pdf", ".webp"}
MAX_PROOF_BYTES = 10 * 1024 * 1024

METHOD_MAP = {
    "bank": "bank_transfer",
    "bank_transfer": "bank_transfer",
    "upi": "upi",
    "qr": "qr",
    "crypto": "crypto_btc",
    "crypto_btc": "crypto_btc",
    "crypto_eth": "crypto_eth",
    "crypto_usdt": "crypto_usdt",
    "metamask": "metamask",
    "card": "bank_transfer",
    "oxapay": "oxapay",
    "nowpayments": "nowpayments",
    "manual": "manual",
}


# ─── First-deposit bonus eligibility ───────────────────────────────────────


async def compute_welcome_bonus(
    deposit_amount: Decimal,
) -> tuple[Decimal, str]:
    """Compute the admin-configured welcome bonus for ONE deposit.

    Reads two settings from system_settings:
      welcome_bonus_enabled    bool   — master switch
      welcome_bonus_brackets   list[dict] — admin's range table:
          [
            {"min_deposit":100,  "max_deposit":499,   "type":"percentage", "value":100, "cap_usd":100},
            {"min_deposit":500,  "max_deposit":999,   "type":"percentage", "value":60,  "cap_usd":300},
            {"min_deposit":1000, "max_deposit":null,  "type":"percentage", "value":100, "cap_usd":1000},
            ...
          ]

    Matching: the first bracket where min_deposit ≤ deposit_amount AND
    (max_deposit is null OR deposit_amount ≤ max_deposit) wins. cap_usd
    null/0 means no cap.

    Returns (bonus_amount, description). bonus_amount = 0 means the
    caller should skip applying any bonus. This is the single source of
    truth used by every auto-apply call site (oxapay / nowpayments /
    admin manual approve) so behaviour stays consistent.

    Backwards-compat shim: if `welcome_bonus_brackets` isn't set but the
    legacy single-value keys (welcome_bonus_type / welcome_bonus_value /
    welcome_bonus_cap_usd) are set, we synthesise a one-bracket list
    covering the full range so old configs keep working.
    """
    from packages.common.src.settings_store import (
        get_bool_setting, get_float_setting, get_system_setting,
    )

    enabled = await get_bool_setting("welcome_bonus_enabled", False)
    if not enabled:
        return Decimal("0"), ""

    raw_brackets = await get_system_setting("welcome_bonus_brackets", None)
    brackets: list[dict] = []
    if isinstance(raw_brackets, list):
        brackets = raw_brackets
    else:
        # Legacy single-rule fallback — wraps the old keys into one bracket
        # spanning $0..∞ so previously-configured tenants don't break on
        # upgrade. Removed automatically once admin saves the new UI form.
        legacy_value = float(await get_float_setting("welcome_bonus_value", 0.0))
        if legacy_value > 0:
            legacy_type = (str(await get_system_setting(
                "welcome_bonus_type", "percentage"
            ) or "percentage")).strip().lower()
            legacy_cap = float(await get_float_setting("welcome_bonus_cap_usd", 0.0))
            brackets = [{
                "min_deposit": 0,
                "max_deposit": None,
                "type": legacy_type,
                "value": legacy_value,
                "cap_usd": legacy_cap,
            }]

    if not brackets:
        return Decimal("0"), ""

    # Find the first matching bracket. We don't pre-sort — admin defines
    # the order they want; the first match wins. Empty / malformed rows
    # are skipped silently.
    for row in brackets:
        try:
            min_d = Decimal(str(row.get("min_deposit") or 0))
        except (TypeError, ValueError):
            continue
        max_raw = row.get("max_deposit")
        try:
            max_d = (
                None if max_raw is None or max_raw == ""
                else Decimal(str(max_raw))
            )
        except (TypeError, ValueError):
            max_d = None
        if deposit_amount < min_d:
            continue
        if max_d is not None and deposit_amount > max_d:
            continue

        try:
            value = Decimal(str(row.get("value") or 0))
        except (TypeError, ValueError):
            continue
        if value <= 0:
            continue
        btype = (str(row.get("type") or "percentage")).strip().lower()
        try:
            cap = Decimal(str(row.get("cap_usd") or 0))
        except (TypeError, ValueError):
            cap = Decimal("0")

        if btype == "percentage":
            amount = (deposit_amount * value / Decimal("100")).quantize(Decimal("0.01"))
            range_label = (
                f"${min_d}+" if max_d is None else f"${min_d} – ${max_d}"
            )
            label = f"Welcome bonus {range_label} ({value}% of deposit)"
        else:
            amount = value.quantize(Decimal("0.01"))
            range_label = (
                f"${min_d}+" if max_d is None else f"${min_d} – ${max_d}"
            )
            label = f"Welcome bonus {range_label} (flat ${value})"

        if cap > 0 and amount > cap:
            amount = cap
            label += f" — capped at ${cap}"

        return amount, label

    # No bracket matched — deposit fell outside every configured range.
    return Decimal("0"), ""


async def is_first_deposit_bonus_eligible(
    db: AsyncSession, user_id: UUID, this_deposit_id: UUID | None,
) -> bool:
    """True when the user qualifies for the welcome bonus on `this_deposit`.

    Rules (migration 0056 contract):
      1. User has NO prior approved/auto_approved deposit other than the
         one we are currently approving. This makes the bonus strictly a
         FIRST-deposit perk — second / third / Nth deposits get nothing.
      2. The user has never had a withdrawal approved before. Once admin
         approves any withdrawal we stamp `bonus_forfeited_at` and zero
         the existing bonus — that flag also blocks future grants so the
         user can't farm the welcome bonus by withdrawing then redepositing.
    """
    from packages.common.src.models import User as _User  # local — avoid cycles
    user = (await db.execute(select(_User).where(_User.id == user_id))).scalar_one_or_none()
    if user is None:
        return False
    if user.bonus_forfeited_at is not None:
        return False
    q = select(func.count()).select_from(Deposit).where(
        Deposit.user_id == user_id,
        Deposit.status.in_(["approved", "auto_approved"]),
    )
    if this_deposit_id is not None:
        q = q.where(Deposit.id != this_deposit_id)
    prior_count = (await db.execute(q)).scalar() or 0
    return prior_count == 0


# ─── Email helpers (best-effort, fire-and-forget) ─────────────────────────


def _send_bonus_emails_for_user(
    user_row: User,
    applied_bonuses: list[tuple[str, Decimal]],
) -> None:
    """Send one bonus-credited email per applied bonus offer. Caller has
    already fired the deposit-confirmation email; this tells the user
    explicitly which promo credited them. Silent no-op if SMTP isn't
    configured or no bonus was applied."""
    if not applied_bonuses:
        return
    try:
        from packages.common.src.smtp_mail import (
            send_email, smtp_configured, fire_and_forget,
        )
        if not smtp_configured() or not user_row.email:
            return
        from packages.common.src.email_templates import render_bonus_credited
        st = get_settings()
        app_url = (getattr(st, "TRADER_APP_URL", None) or "https://trade.swisdex.com")
        for offer_name, bonus_amount in applied_bonuses:
            subject, html, text = render_bonus_credited(
                first_name=user_row.first_name,
                bonus_amount=bonus_amount,
                bonus_label=offer_name,
                currency="USD",
                new_bonus_balance=user_row.main_wallet_balance,
                trader_app_url=app_url,
            )
            fire_and_forget(send_email(user_row.email, subject, html, text=text, category="account"))
    except Exception as _e:
        logger.warning("bonus credited email failed: %s", _e)


def _send_deposit_failed_email(
    user_row: User,
    deposit: Deposit,
    reason_code: str,
    *,
    method_label: str,
) -> None:
    """Fire-and-forget 'deposit not completed' email when a crypto provider
    reports expired / failed / refunded / partially_paid."""
    try:
        from packages.common.src.smtp_mail import (
            send_email, smtp_configured, fire_and_forget,
        )
        if not smtp_configured() or not user_row.email:
            return
        from packages.common.src.email_templates import render_deposit_failed
        st = get_settings()
        app_url = (getattr(st, "TRADER_APP_URL", None) or "https://trade.swisdex.com")
        subject, html, text = render_deposit_failed(
            first_name=user_row.first_name,
            amount=deposit.amount,
            currency="USD",
            method=method_label,
            reason_code=reason_code,
            reference=str(deposit.id),
            trader_app_url=app_url,
        )
        fire_and_forget(send_email(user_row.email, subject, html, text=text, category="account"))
    except Exception as _e:
        logger.warning("deposit failed email send failed: %s", _e)


def _wallet_upload_root() -> Path:
    raw = get_settings().WALLET_UPLOAD_ROOT.strip() or "uploads/wallet"
    p = Path(raw)
    if not p.is_absolute():
        p = Path.cwd() / p
    try:
        p.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        logger.error("Wallet upload dir not writable: %s — %s", p, e)
        raise HTTPException(
            status_code=503,
            detail="File upload is temporarily unavailable. Please contact support.",
        ) from e
    return p


async def _get_user_account_ids(user_id, db: AsyncSession) -> list[UUID]:
    result = await db.execute(
        select(TradingAccount.id).where(TradingAccount.user_id == user_id)
    )
    return [row[0] for row in result.all()]


async def _get_live_account_ids(user_id, db: AsyncSession) -> list[UUID]:
    result = await db.execute(
        select(TradingAccount.id).where(
            TradingAccount.user_id == user_id,
            TradingAccount.is_demo == False,
        )
    )
    return [row[0] for row in result.all()]


async def _get_bank_for_tier(amount: Decimal, db: AsyncSession) -> BankAccount | None:
    result = await db.execute(
        select(BankAccount).where(
            BankAccount.is_active == True,
            BankAccount.min_amount <= amount,
            BankAccount.max_amount >= amount,
        ).order_by(BankAccount.last_used_at.asc().nullsfirst(), BankAccount.rotation_order)
    )
    bank = result.scalars().first()
    if bank:
        bank.last_used_at = datetime.utcnow()
    return bank


# ─── KYC gate ─────────────────────────────────────────────────────────────

async def _require_kyc_approved(user_id: UUID, db: AsyncSession) -> None:
    """Block deposits AND withdrawals until the user's KYC is approved
    (client 2026-06-24: "no deposit and withdrawal without KYC verification").
    Raises 403 otherwise. Demo flows never call money endpoints, so this only
    affects real funding."""
    from packages.common.src.models import User as _KycUser
    row = (await db.execute(
        select(_KycUser.kyc_status).where(_KycUser.id == user_id)
    )).first()
    status = ((row[0] if row else "") or "").lower()
    if status not in ("approved", "verified"):
        raise HTTPException(
            status_code=403,
            detail="Complete your KYC verification before you can deposit or withdraw.",
        )


# ─── Deposits ─────────────────────────────────────────────────────────────

async def create_deposit(req, user_id: UUID, db: AsyncSession) -> dict:
    await _require_kyc_approved(user_id, db)
    from packages.common.src.settings_store import get_bool_setting, get_float_setting
    if await get_bool_setting("maintenance_mode", False):
        raise HTTPException(status_code=503, detail="Platform is under maintenance. Deposits are temporarily disabled.")
    if not await get_bool_setting("allow_deposits", True):
        raise HTTPException(status_code=403, detail="Deposits are currently disabled")

    # Platform-wide minimum deposit gate. Admin-tunable via
    # system_settings.min_deposit_amount_usd (default $50). 0 = no minimum.
    min_dep_usd = float(await get_float_setting("min_deposit_amount_usd", 50.0))
    if min_dep_usd > 0 and float(req.amount) < min_dep_usd:
        raise HTTPException(
            status_code=400,
            detail=f"Minimum deposit is ${min_dep_usd:,.2f}.",
        )

    if req.account_id is not None:
        acct = await db.execute(
            select(TradingAccount).where(
                TradingAccount.id == req.account_id,
                TradingAccount.user_id == user_id,
            )
        )
        account = acct.scalar_one_or_none()
        if not account:
            raise HTTPException(status_code=404, detail="Account not found")

    bank = await _get_bank_for_tier(req.amount, db)
    db_method = METHOD_MAP.get(req.method, "bank_transfer")

    # For automated crypto methods, use 'initiated' status until payment is
    # actually started. This prevents showing incomplete payment attempts in
    # history. NOWPayments is the current default; OxaPay is kept mounted for
    # in-flight + historical deposits.
    settings = get_settings()
    crypto_currency = getattr(req, "crypto_currency", None)
    is_oxapay = db_method == "oxapay" and bool(settings.OXAPAY_MERCHANT_KEY)
    is_nowpayments = db_method == "nowpayments" and bool(settings.NOWPAYMENTS_API_KEY)
    is_automated_crypto = is_oxapay or is_nowpayments

    # Optional bonus request — trader typed a promo code at deposit time.
    # Empty/whitespace clears it. Persist as 'pending' so admin sees it
    # on the deposits page and grants/denies manually.
    _bonus_code_raw = getattr(req, "bonus_code", None) or ""
    bonus_code = _bonus_code_raw.strip().upper() or None
    bonus_status = "pending" if bonus_code else None

    deposit = Deposit(
        user_id=user_id,
        account_id=req.account_id if req.account_id else None,
        amount=req.amount,
        method=db_method,
        transaction_id=req.transaction_id,
        screenshot_url=req.screenshot_url,
        crypto_tx_hash=getattr(req, "crypto_tx_hash", None),
        crypto_address=getattr(req, "crypto_address", None),
        bank_account_id=bank.id if bank else None,
        status="initiated" if is_automated_crypto else "pending",
        bonus_code=bonus_code,
        bonus_status=bonus_status,
    )
    db.add(deposit)
    await db.commit()
    await db.refresh(deposit)

    # ── Automated crypto payment ──────────────────────────────────────
    payment_url: str | None = None
    if is_oxapay:
        try:
            ox = await oxapay_service.create_payment(
                amount=req.amount,
                crypto_currency=crypto_currency,
                order_id=str(deposit.id),
                description=f"SwisDex deposit ${float(req.amount):,.2f}",
            )
            deposit.transaction_id = ox["track_id"]
            payment_url = ox["payment_url"]
            await db.commit()
        except Exception as oxapay_err:
            logger.exception(
                "OxaPay create_payment failed for deposit %s",
                deposit.id,
            )
            # Delete the initiated deposit since payment creation failed
            await db.delete(deposit)
            await db.commit()
            raise HTTPException(
                status_code=502,
                detail=f"OxaPay payment creation failed: {str(oxapay_err)}",
            )
    elif is_nowpayments:
        try:
            np = await nowpayments_service.create_payment(
                amount=req.amount,
                crypto_currency=crypto_currency,
                order_id=str(deposit.id),
                description=f"SwisDex deposit ${float(req.amount):,.2f}",
            )
            deposit.transaction_id = np["invoice_id"]
            payment_url = np["payment_url"]
            await db.commit()
        except Exception as np_err:
            logger.exception(
                "NOWPayments create_payment failed for deposit %s",
                deposit.id,
            )
            # Delete the initiated deposit since payment creation failed
            await db.delete(deposit)
            await db.commit()
            raise HTTPException(
                status_code=502,
                detail=f"NOWPayments payment creation failed: {str(np_err)}",
            )

    try:
        await create_notification(
            db, user_id,
            title="Deposit Submitted",
            message=f"${float(req.amount):,.2f} deposit via {req.method} is pending approval",
            notif_type="deposit", action_url="/wallet",
        )
        await db.commit()
    except Exception:
        logger.exception("create_notification failed after deposit (deposit already saved) user_id=%s", user_id)
        try:
            await db.rollback()
        except Exception:
            pass

    result: dict = {"id": str(deposit.id), "status": "pending", "amount": float(deposit.amount)}
    if payment_url:
        result["payment_url"] = payment_url
    return result


async def create_manual_deposit(
    user_id: UUID,
    account_id: UUID | None,
    amount: Decimal,
    transaction_id: str,
    file: UploadFile | None,
    db: AsyncSession,
    bonus_code: str | None = None,
) -> dict:
    await _require_kyc_approved(user_id, db)
    from packages.common.src.settings_store import get_bool_setting, get_float_setting
    if not await get_bool_setting("allow_deposits", True):
        raise HTTPException(status_code=403, detail="Deposits are currently disabled")

    if amount <= 0:
        raise HTTPException(status_code=400, detail="Invalid amount")

    # Platform-wide minimum deposit gate — same as the crypto path in
    # create_deposit. Manual (bank/UPI) deposits were bypassing it.
    min_dep_usd = float(await get_float_setting("min_deposit_amount_usd", 50.0))
    if min_dep_usd > 0 and float(amount) < min_dep_usd:
        raise HTTPException(
            status_code=400,
            detail=f"Minimum deposit is ${min_dep_usd:,.2f}.",
        )

    tid = (transaction_id or "").strip()
    if not tid:
        raise HTTPException(status_code=400, detail="Transaction / reference ID is required for manual deposits")

    if account_id is not None:
        acct = await db.execute(
            select(TradingAccount).where(
                TradingAccount.id == account_id,
                TradingAccount.user_id == user_id,
            )
        )
        account = acct.scalar_one_or_none()
        if not account:
            raise HTTPException(status_code=404, detail="Account not found")

    # Proof upload is OPTIONAL (XM-style): finance matches the unique
    # reference (transaction_id) against the bank statement. When a file IS
    # provided we still fully validate it (type + size + magic-bytes).
    screenshot_url = None
    if file is not None and getattr(file, "filename", None):
        suffix = Path(file.filename).suffix.lower()
        if suffix not in DEPOSIT_PROOF_EXT:
            raise HTTPException(status_code=400, detail="Allowed file types: JPG, PNG, PDF, WEBP")
        content = await file.read()
        if len(content) > MAX_PROOF_BYTES:
            raise HTTPException(status_code=400, detail="File too large (max 10 MB)")

        # Magic-byte sniffing — extension + Content-Type are attacker-controlled.
        # Rejects polyglots and bypass-via-spoofed-MIME (e.g. .png with .exe bytes).
        from packages.common.src.upload_safety import assert_matches, UnsafeUploadError
        try:
            kind = assert_matches(content, declared_suffix=suffix, allowed_suffixes=DEPOSIT_PROOF_EXT)
        except UnsafeUploadError as e:
            raise HTTPException(status_code=400, detail=str(e))
        suffix = kind.suffix  # use the canonical extension going forward

        try:
            user_dir = safe_join_under_base(_wallet_upload_root(), "deposits", str(user_id))
        except PathTraversalError:
            raise HTTPException(status_code=400, detail="Invalid upload path")
        user_dir.mkdir(parents=True, exist_ok=True)
        safe = f"deposit_{uuid_lib.uuid4().hex}{suffix}"
        try:
            out_path = safe_join_under_base(user_dir, safe)
        except PathTraversalError:
            raise HTTPException(status_code=400, detail="Invalid file path")
        try:
            out_path.write_bytes(content)
        except OSError as e:
            logger.exception("manual deposit write failed: %s", out_path)
            raise HTTPException(status_code=503, detail="Could not save file") from e
        screenshot_url = str(out_path.resolve())

    bank = await _get_bank_for_tier(amount, db)

    _bonus_code_clean = (bonus_code or "").strip().upper() or None
    deposit = Deposit(
        user_id=user_id,
        account_id=account_id if account_id else None,
        amount=amount,
        method="manual",
        transaction_id=tid[:100],
        screenshot_url=screenshot_url,
        bank_account_id=bank.id if bank else None,
        status="pending",
        bonus_code=_bonus_code_clean,
        bonus_status=("pending" if _bonus_code_clean else None),
    )
    db.add(deposit)
    await db.commit()
    await db.refresh(deposit)

    try:
        await create_notification(
            db, user_id,
            title="Deposit Submitted",
            message=f"${float(amount):,.2f} manual deposit pending approval",
            notif_type="deposit", action_url="/wallet",
        )
        await db.commit()
    except Exception:
        logger.exception("create_notification failed after manual deposit (deposit already saved) user_id=%s", user_id)
        try:
            await db.rollback()
        except Exception:
            pass

    return {"id": str(deposit.id), "status": "pending", "amount": float(deposit.amount)}


# ─── OxaPay Webhook ──────────────────────────────────────────────────────

async def handle_oxapay_webhook(
    order_id: str,
    oxapay_status: str,
    track_id: str | None,
    payload: dict,
    db: AsyncSession,
) -> None:
    """Process OxaPay webhook callback. Auto-approve on 'paid', reject on 'expired'/'failed'."""
    from uuid import UUID as UUIDType

    try:
        deposit_uuid = UUIDType(order_id)
    except ValueError:
        logger.warning("OxaPay webhook: invalid order_id=%s", order_id)
        return

    result = await db.execute(select(Deposit).where(Deposit.id == deposit_uuid))
    deposit = result.scalar_one_or_none()
    if not deposit:
        logger.warning("OxaPay webhook: deposit not found order_id=%s", order_id)
        return

    # Idempotent — skip if already processed (but allow 'initiated' to transition)
    if deposit.status not in ("initiated", "pending"):
        logger.info("OxaPay webhook: deposit %s already %s, skipping", order_id, deposit.status)
        return

    if track_id:
        deposit.transaction_id = track_id

    # If payment is waiting/confirming, move from 'initiated' to 'pending'
    if oxapay_status in ("waiting", "confirming") and deposit.status == "initiated":
        deposit.status = "pending"
        await db.commit()
        logger.info("OxaPay webhook: deposit %s → pending (payment started)", order_id)
        return

    if oxapay_status == "paid":
        deposit.status = "auto_approved"
        deposit.approved_at = datetime.utcnow()

        # Lock the user row so two deposits settling concurrently for the same
        # user can't both read a stale main_wallet_balance and lose an update
        # (the admin approve path already locks; the webhook path did not).
        user_q = await db.execute(
            select(User).where(User.id == deposit.user_id).with_for_update()
        )
        user_row = user_q.scalar_one_or_none()
        if not user_row:
            logger.error("OxaPay webhook: user not found for deposit %s", order_id)
            return

        user_row.main_wallet_balance = (user_row.main_wallet_balance or Decimal("0")) + deposit.amount

        db.add(Transaction(
            user_id=deposit.user_id,
            account_id=None,
            type="deposit",
            amount=deposit.amount,
            balance_after=user_row.main_wallet_balance,
            reference_id=deposit.id,
            description=f"Deposit to main wallet - oxapay (auto)",
        ))

        # ── Bonus auto-apply ───────────────────────────────────────────
        # Same three gates stack here (migration 0056 contract):
        #   - bonus_code present? → skip auto (admin's manual grant wins)
        #   - already had a prior approved deposit? → skip (first-deposit only)
        #   - already had a withdrawal approved? → skip (bonus_forfeited_at)
        #
        # When the gates pass, we consult the SIMPLE admin setting
        # (welcome_bonus_*) FIRST. If admin has enabled it, that single
        # rule wins — no tier-matrix loop. If it's disabled, we fall
        # through to the legacy multi-tier bonus_offers flow so existing
        # tier configurations keep working.
        bonus_msg = ""
        applied_bonuses: list[tuple[str, Decimal]] = []
        now = datetime.now(timezone.utc)  # tz-aware: offer dates are TIMESTAMPTZ
        skip_auto_bonus = (
            bool(deposit.bonus_code)
            or not await is_first_deposit_bonus_eligible(db, deposit.user_id, deposit.id)
        )

        if not skip_auto_bonus:
            simple_amount, simple_label = await compute_welcome_bonus(deposit.amount)
            if simple_amount > 0:
                user_row.main_wallet_bonus = (
                    user_row.main_wallet_bonus or Decimal("0")
                ) + simple_amount
                db.add(Transaction(
                    user_id=deposit.user_id,
                    account_id=None,
                    type="bonus",
                    amount=simple_amount,
                    balance_after=user_row.main_wallet_bonus,
                    description=simple_label,
                ))
                bonus_msg = f" + ${float(simple_amount):.2f} bonus"
                applied_bonuses.append(("Welcome bonus", simple_amount))
                skip_auto_bonus = True  # block the tier fallback below

        offers_q = await db.execute(
            select(BonusOffer).where(
                BonusOffer.is_active == True,
                # bonus_type is a free-form label after migration 0057;
                # we trigger auto-apply for any deposit-style category so
                # admin can pick `welcome`, `deposit`, `percentage`, or
                # `fixed` from the UI and the engine fires for all of
                # them. `no_deposit` deliberately excluded — by definition
                # that flow doesn't gate on deposit.
                BonusOffer.bonus_type.in_(
                    ["deposit", "welcome", "percentage", "fixed"]
                ),
                BonusOffer.min_deposit <= deposit.amount,
                # Auto-apply ONLY no-code offers. An offer carrying a
                # promo_code is a code-gated EVENT bonus and must be granted
                # solely via the bonus_code path (only when the user actually
                # entered the matching code), never auto-applied to every
                # qualifying deposit.
                or_(BonusOffer.promo_code.is_(None), BonusOffer.promo_code == ""),
            )
        ) if not skip_auto_bonus else None
        for offer in (offers_q.scalars().all() if offers_q is not None else []):
            if offer.starts_at and offer.starts_at > now:
                continue
            if offer.expires_at and offer.expires_at < now:
                continue
            if offer.percentage and offer.percentage > 0:
                bonus_amount = deposit.amount * offer.percentage / Decimal("100")
            elif offer.fixed_amount and offer.fixed_amount > 0:
                bonus_amount = offer.fixed_amount
            else:
                continue
            if offer.max_bonus and bonus_amount > offer.max_bonus:
                bonus_amount = offer.max_bonus

            # Bonus goes to main_wallet_BONUS (not main_wallet_balance) so
            # the withdrawal validator never sees it. The transfer-to-
            # trading path sweeps this column to account.credit for the
            # user to actually trade with.
            user_row.main_wallet_bonus = (user_row.main_wallet_bonus or Decimal("0")) + bonus_amount
            db.add(Transaction(
                user_id=deposit.user_id,
                account_id=None,
                type="bonus",
                amount=bonus_amount,
                balance_after=user_row.main_wallet_bonus,
                description=f"Bonus: {offer.name} ({offer.percentage or 0}%)",
            ))
            bonus_msg = f" + ${float(bonus_amount):.2f} bonus ({offer.name})"
            applied_bonuses.append((offer.name, bonus_amount))

        # Personal-referral commission (separate from IB MLM). Pays on the
        # FIRST approved/auto-approved deposit only; later deposits are
        # no-ops. SAVEPOINT so a payout-side error rolls back only the
        # referral writes — the parent deposit-credit transaction stays
        # clean and downstream notifications still fire.
        try:
            async with db.begin_nested():
                from .referral_service import (
                    maybe_pay_referral_on_first_deposit,
                    maybe_pay_ib_referral_bounty,
                )
                await maybe_pay_referral_on_first_deposit(db, deposit.user_id, deposit)
                await maybe_pay_ib_referral_bounty(db, deposit.user_id, deposit)
        except Exception as _re:
            logger.warning("auto-deposit referral commission failed: %s", _re)

        await create_notification(
            db, deposit.user_id,
            title="Deposit approved",
            message=f"Your deposit of ${float(deposit.amount):,.2f} was approved automatically.{bonus_msg}",
            notif_type="deposit", action_url="/wallet",
        )

        # Email the user — best-effort.
        try:
            from packages.common.src.smtp_mail import (
                send_email, smtp_configured, fire_and_forget,
            )
            from packages.common.src.email_templates import render_deposit_confirmed
            from packages.common.src.config import get_settings as _gs
            if smtp_configured() and user_row.email:
                subject, html, text = render_deposit_confirmed(
                    first_name=user_row.first_name,
                    amount=deposit.amount,
                    currency="USD",
                    method="Crypto (OxaPay)",
                    reference=str(deposit.id),
                    new_balance=user_row.main_wallet_balance,
                    trader_app_url=(_gs().TRADER_APP_URL or "https://trade.swisdex.com"),
                )
                fire_and_forget(send_email(user_row.email, subject, html, text=text, category="account"))
                _send_bonus_emails_for_user(user_row, applied_bonuses)
        except Exception as _e:
            logger.warning("oxapay deposit email failed: %s", _e)

    elif oxapay_status in ("expired", "failed"):
        deposit.status = "rejected"
        deposit.rejection_reason = f"OxaPay payment {oxapay_status}"
        await create_notification(
            db, deposit.user_id,
            title="Deposit not completed",
            message=f"Your ${float(deposit.amount):,.2f} crypto deposit {oxapay_status}. Please try again.",
            notif_type="deposit", action_url="/wallet",
        )
        _send_deposit_failed_email(
            user_row, deposit, oxapay_status, method_label="Crypto (OxaPay)",
        )

    else:
        # "waiting", "confirming" — informational only
        logger.info("OxaPay webhook: deposit %s status=%s (no action)", order_id, oxapay_status)
        return

    await db.commit()
    logger.info("OxaPay webhook: deposit %s → %s", order_id, deposit.status)


# ─── On-site wallet-connect deposit (NOWPayments /v1/payment) ───────────


async def create_wallet_deposit(
    *,
    amount: Decimal,
    crypto_currency: str,
    user_id: UUID,
    db: AsyncSession,
    bonus_code: str | None = None,
) -> dict:
    """Create a Deposit row + a NOWPayments direct payment for the
    wallet-connect flow. Returns the address + exact crypto amount the
    frontend renders. No payment_url — user pays from their connected
    wallet directly. Settlement still gates on the IPN webhook."""
    await _require_kyc_approved(user_id, db)
    from packages.common.src.settings_store import get_bool_setting
    if await get_bool_setting("maintenance_mode", False):
        raise HTTPException(status_code=503, detail="Platform is under maintenance.")
    if not await get_bool_setting("allow_deposits", True):
        raise HTTPException(status_code=403, detail="Deposits are currently disabled")

    settings = get_settings()
    if not settings.NOWPAYMENTS_API_KEY:
        raise HTTPException(status_code=503, detail="Crypto deposits are not configured")

    if amount <= 0:
        raise HTTPException(status_code=400, detail="Invalid amount")

    _bonus_code_clean = (bonus_code or "").strip().upper() or None
    deposit = Deposit(
        user_id=user_id,
        account_id=None,
        amount=amount,
        method="nowpayments",
        status="initiated",
        bonus_code=_bonus_code_clean,
        bonus_status=("pending" if _bonus_code_clean else None),
    )
    db.add(deposit)
    await db.commit()
    await db.refresh(deposit)

    try:
        np = await nowpayments_service.create_direct_payment(
            amount_usd=amount,
            crypto_currency=crypto_currency,
            order_id=str(deposit.id),
            description=f"SwisDex deposit ${float(amount):,.2f}",
        )
    except Exception as e:
        logger.exception("NOWPayments create_direct_payment failed for deposit %s", deposit.id)
        await db.delete(deposit)
        await db.commit()
        raise HTTPException(status_code=502, detail=f"Crypto payment creation failed: {e}")

    deposit.transaction_id = np["payment_id"]
    deposit.crypto_address = np["pay_address"]
    deposit.pay_amount = Decimal(np["pay_amount"])
    deposit.pay_currency = np["pay_currency"]
    deposit.network = np["network"] or None
    if np.get("expires_at"):
        try:
            from datetime import datetime as _dt
            deposit.expires_at = _dt.fromisoformat(np["expires_at"].replace("Z", "+00:00"))
        except Exception:
            deposit.expires_at = None
    await db.commit()
    await db.refresh(deposit)

    return {
        "id": str(deposit.id),
        "status": deposit.status,
        "amount_usd": float(deposit.amount),
        "pay_address": deposit.crypto_address,
        "pay_amount": str(deposit.pay_amount),
        "pay_currency": deposit.pay_currency,
        "network": deposit.network,
        "expires_at": deposit.expires_at.isoformat() if deposit.expires_at else None,
        "payment_id": deposit.transaction_id,
    }


async def get_wallet_deposit_status(
    *, deposit_id: UUID, user_id: UUID, db: AsyncSession,
) -> dict:
    """Polled by the wallet-connect UI. Returns local row status + a fresh
    NOWPayments status (best-effort) so the UI can show confirmation
    progress before the IPN lands."""
    q = await db.execute(
        select(Deposit).where(Deposit.id == deposit_id, Deposit.user_id == user_id)
    )
    deposit = q.scalar_one_or_none()
    if not deposit:
        raise HTTPException(status_code=404, detail="Deposit not found")

    np_status: str | None = None
    confirmations = None
    if deposit.transaction_id and deposit.method == "nowpayments":
        try:
            data = await nowpayments_service.get_payment_status(deposit.transaction_id)
            np_status = data.get("payment_status")
            confirmations = data.get("confirmations")
            # Side-effect: if NOWPayments says we're past 'waiting' but our
            # local row is still 'initiated' (missed IPN), bump to 'pending'
            # so the UI moves. Settlement still requires the IPN.
            if (
                deposit.status == "initiated"
                and np_status in ("confirming", "sending", "waiting")
            ):
                deposit.status = "pending"
                await db.commit()
        except Exception as e:
            logger.warning("NOWPayments status fetch failed for deposit %s: %s", deposit.id, e)

    return {
        "id": str(deposit.id),
        "status": deposit.status,
        "amount_usd": float(deposit.amount or 0),
        "pay_address": deposit.crypto_address,
        "pay_amount": str(deposit.pay_amount) if deposit.pay_amount is not None else None,
        "pay_currency": deposit.pay_currency,
        "network": deposit.network,
        "tx_hash": deposit.crypto_tx_hash,
        "expires_at": deposit.expires_at.isoformat() if deposit.expires_at else None,
        "nowpayments_status": np_status,
        "confirmations": confirmations,
    }


async def save_wallet_deposit_tx_hash(
    *, deposit_id: UUID, tx_hash: str, user_id: UUID, db: AsyncSession,
) -> dict:
    """Persist the on-chain tx hash the user's wallet returned after broadcast.
    Strictly informational — balance credit still gates on the IPN."""
    th = (tx_hash or "").strip()
    if not th or len(th) < 10 or len(th) > 200:
        raise HTTPException(status_code=400, detail="Invalid tx hash")

    q = await db.execute(
        select(Deposit).where(Deposit.id == deposit_id, Deposit.user_id == user_id)
    )
    deposit = q.scalar_one_or_none()
    if not deposit:
        raise HTTPException(status_code=404, detail="Deposit not found")
    if deposit.status not in ("initiated", "pending"):
        return {"id": str(deposit.id), "saved": False, "status": deposit.status}

    deposit.crypto_tx_hash = th
    if deposit.status == "initiated":
        deposit.status = "pending"
    await db.commit()
    return {"id": str(deposit.id), "saved": True, "status": deposit.status}


# ─── NOWPayments Webhook ─────────────────────────────────────────────────

# NOWPayments status terminals — mapping decided by client spec:
#   waiting / confirming / sending → 'pending'   (in flight)
#   confirmed / finished           → 'auto_approved' (credit balance)
#   failed / expired / refunded /
#     partially_paid               → 'rejected'   (no credit)


async def handle_nowpayments_webhook(
    order_id: str,
    np_status: str,
    payment_id: str | None,
    payload: dict,
    db: AsyncSession,
) -> None:
    """Process a NOWPayments IPN. Auto-approve on 'finished'/'confirmed';
    reject on terminal failures; otherwise just bump 'initiated' → 'pending'.
    Idempotent — already-settled rows are left alone."""
    from uuid import UUID as UUIDType

    try:
        deposit_uuid = UUIDType(order_id)
    except ValueError:
        logger.warning("NOWPayments webhook: invalid order_id=%s", order_id)
        return

    result = await db.execute(select(Deposit).where(Deposit.id == deposit_uuid))
    deposit = result.scalar_one_or_none()
    if not deposit:
        logger.warning("NOWPayments webhook: deposit not found order_id=%s", order_id)
        return

    # Idempotent — skip if already terminal.
    if deposit.status not in ("initiated", "pending"):
        logger.info("NOWPayments webhook: deposit %s already %s, skipping", order_id, deposit.status)
        return

    if payment_id:
        deposit.transaction_id = str(payment_id)

    status = (np_status or "").lower()

    in_flight = ("waiting", "confirming", "sending")
    success = ("confirmed", "finished")
    failure = ("failed", "expired", "refunded", "partially_paid")

    # Move 'initiated' → 'pending' on first signal that the user actually paid.
    if status in in_flight and deposit.status == "initiated":
        deposit.status = "pending"
        await db.commit()
        logger.info("NOWPayments webhook: deposit %s → pending (status=%s)", order_id, status)
        return

    if status in success:
        deposit.status = "auto_approved"
        deposit.approved_at = datetime.utcnow()

        # Lock the user row so two deposits settling concurrently for the same
        # user can't both read a stale main_wallet_balance and lose an update
        # (the admin approve path already locks; the webhook path did not).
        user_q = await db.execute(
            select(User).where(User.id == deposit.user_id).with_for_update()
        )
        user_row = user_q.scalar_one_or_none()
        if not user_row:
            logger.error("NOWPayments webhook: user not found for deposit %s", order_id)
            return

        user_row.main_wallet_balance = (user_row.main_wallet_balance or Decimal("0")) + deposit.amount

        db.add(Transaction(
            user_id=deposit.user_id,
            account_id=None,
            type="deposit",
            amount=deposit.amount,
            balance_after=user_row.main_wallet_balance,
            reference_id=deposit.id,
            description="Deposit to main wallet - nowpayments (auto)",
        ))

        # Apply active bonus offers — mirrors the OxaPay path so promo
        # behaviour is identical regardless of provider. See the OxaPay
        # branch above for the three-gate explanation; same contract here.
        # Simple admin welcome_bonus_* settings win over the tier matrix.
        bonus_msg = ""
        applied_bonuses: list[tuple[str, Decimal]] = []
        now = datetime.now(timezone.utc)  # tz-aware: offer dates are TIMESTAMPTZ
        skip_auto_bonus = (
            bool(deposit.bonus_code)
            or not await is_first_deposit_bonus_eligible(db, deposit.user_id, deposit.id)
        )

        if not skip_auto_bonus:
            simple_amount, simple_label = await compute_welcome_bonus(deposit.amount)
            if simple_amount > 0:
                user_row.main_wallet_bonus = (
                    user_row.main_wallet_bonus or Decimal("0")
                ) + simple_amount
                db.add(Transaction(
                    user_id=deposit.user_id,
                    account_id=None,
                    type="bonus",
                    amount=simple_amount,
                    balance_after=user_row.main_wallet_bonus,
                    description=simple_label,
                ))
                bonus_msg = f" + ${float(simple_amount):.2f} bonus"
                applied_bonuses.append(("Welcome bonus", simple_amount))
                skip_auto_bonus = True

        offers_q = await db.execute(
            select(BonusOffer).where(
                BonusOffer.is_active == True,
                # bonus_type is a free-form label after migration 0057;
                # we trigger auto-apply for any deposit-style category so
                # admin can pick `welcome`, `deposit`, `percentage`, or
                # `fixed` from the UI and the engine fires for all of
                # them. `no_deposit` deliberately excluded — by definition
                # that flow doesn't gate on deposit.
                BonusOffer.bonus_type.in_(
                    ["deposit", "welcome", "percentage", "fixed"]
                ),
                BonusOffer.min_deposit <= deposit.amount,
                # Auto-apply ONLY no-code offers. An offer carrying a
                # promo_code is a code-gated EVENT bonus and must be granted
                # solely via the bonus_code path (only when the user actually
                # entered the matching code), never auto-applied to every
                # qualifying deposit.
                or_(BonusOffer.promo_code.is_(None), BonusOffer.promo_code == ""),
            )
        ) if not skip_auto_bonus else None
        for offer in (offers_q.scalars().all() if offers_q is not None else []):
            if offer.starts_at and offer.starts_at > now:
                continue
            if offer.expires_at and offer.expires_at < now:
                continue
            if offer.percentage and offer.percentage > 0:
                bonus_amount = deposit.amount * offer.percentage / Decimal("100")
            elif offer.fixed_amount and offer.fixed_amount > 0:
                bonus_amount = offer.fixed_amount
            else:
                continue
            if offer.max_bonus and bonus_amount > offer.max_bonus:
                bonus_amount = offer.max_bonus

            user_row.main_wallet_bonus = (user_row.main_wallet_bonus or Decimal("0")) + bonus_amount
            db.add(Transaction(
                user_id=deposit.user_id,
                account_id=None,
                type="bonus",
                amount=bonus_amount,
                balance_after=user_row.main_wallet_bonus,
                description=f"Bonus: {offer.name} ({offer.percentage or 0}%)",
            ))
            bonus_msg = f" + ${float(bonus_amount):.2f} bonus ({offer.name})"
            applied_bonuses.append((offer.name, bonus_amount))

        # Personal-referral commission (separate from IB MLM). Pays on the
        # FIRST approved/auto-approved deposit only; later deposits are
        # no-ops. SAVEPOINT so a payout-side error rolls back only the
        # referral writes — the parent deposit-credit transaction stays
        # clean and downstream notifications still fire.
        try:
            async with db.begin_nested():
                from .referral_service import (
                    maybe_pay_referral_on_first_deposit,
                    maybe_pay_ib_referral_bounty,
                )
                await maybe_pay_referral_on_first_deposit(db, deposit.user_id, deposit)
                await maybe_pay_ib_referral_bounty(db, deposit.user_id, deposit)
        except Exception as _re:
            logger.warning("auto-deposit referral commission failed: %s", _re)

        await create_notification(
            db, deposit.user_id,
            title="Deposit approved",
            message=f"Your deposit of ${float(deposit.amount):,.2f} was approved automatically.{bonus_msg}",
            notif_type="deposit", action_url="/wallet",
        )

        # Best-effort email — never blocks settlement.
        try:
            from packages.common.src.smtp_mail import (
                send_email, smtp_configured, fire_and_forget,
            )
            from packages.common.src.email_templates import render_deposit_confirmed
            from packages.common.src.config import get_settings as _gs
            if smtp_configured() and user_row.email:
                subject, html, text = render_deposit_confirmed(
                    first_name=user_row.first_name,
                    amount=deposit.amount,
                    currency="USD",
                    method="Crypto (NOWPayments)",
                    reference=str(deposit.id),
                    new_balance=user_row.main_wallet_balance,
                    trader_app_url=(_gs().TRADER_APP_URL or "https://trade.swisdex.com"),
                )
                fire_and_forget(send_email(user_row.email, subject, html, text=text, category="account"))
                _send_bonus_emails_for_user(user_row, applied_bonuses)
        except Exception as _e:
            logger.warning("nowpayments deposit email failed: %s", _e)

    elif status in failure:
        deposit.status = "rejected"
        deposit.rejection_reason = f"NOWPayments payment {status}"
        # user_row is only loaded inside the `success` branch above; the
        # failure branch needs its own fetch or the deposit-failed email
        # call below raises NameError → 500 on every expired/failed/
        # refunded/partially_paid webhook (regression 2026-05-15).
        user_q = await db.execute(select(User).where(User.id == deposit.user_id))
        user_row = user_q.scalar_one_or_none()
        if user_row:
            _send_deposit_failed_email(
                user_row, deposit, status, method_label="Crypto (NOWPayments)",
            )
        await create_notification(
            db, deposit.user_id,
            title="Deposit not completed",
            message=f"Your ${float(deposit.amount):,.2f} crypto deposit {status}. Please try again.",
            notif_type="deposit", action_url="/wallet",
        )

    else:
        # Unknown / informational — log and bail without mutating state.
        logger.info("NOWPayments webhook: deposit %s status=%s (no action)", order_id, status)
        return

    await db.commit()
    logger.info("NOWPayments webhook: deposit %s → %s", order_id, deposit.status)


# ─── Withdrawals ──────────────────────────────────────────────────────────

def _parse_crypto_payout(withdrawal: Withdrawal) -> tuple[str | None, str | None]:
    """Extract (asset_id, address) from a crypto withdrawal's stored details.
    The trader form stores '[ASSET] address' in bank_details.oxapay_payout."""
    raw = ""
    bd = withdrawal.bank_details
    if isinstance(bd, dict):
        raw = str(bd.get("oxapay_payout") or bd.get("nowpayments_payout") or "").strip()
    if not raw and withdrawal.crypto_address:
        raw = str(withdrawal.crypto_address).strip()
    if not raw:
        return None, None
    if raw.startswith("[") and "]" in raw:
        asset = raw[1:raw.index("]")].strip()
        address = raw[raw.index("]") + 1:].strip()
        return (asset or None), (address or None)
    return None, raw


async def _send_nowpayments_payout(
    withdrawal: Withdrawal, user_row: User, db: AsyncSession
) -> bool:
    """Send the NOWPayments crypto payout for an ALREADY-DEBITED withdrawal.

    On success → status 'processing' (+ payout_batch_id). On ANY failure →
    re-credit the wallet (reversal Transaction) + status 'failed' + notify, so
    the user never loses money. Never raises — returns True/False; caller commits.
    """
    from . import nowpayments_service
    asset, address = _parse_crypto_payout(withdrawal)
    np_currency = nowpayments_service.resolve_currency(asset) if asset else None

    async def _refund(reason: str) -> None:
        user_row.main_wallet_balance = (user_row.main_wallet_balance or Decimal("0")) + withdrawal.amount
        db.add(Transaction(
            user_id=withdrawal.user_id, account_id=None, type="withdrawal",
            amount=withdrawal.amount, balance_after=user_row.main_wallet_balance,
            reference_id=withdrawal.id, description="Auto-withdrawal failed — refunded to wallet",
        ))
        withdrawal.status = "failed"
        withdrawal.rejection_reason = reason[:500]
        try:
            await create_notification(
                db, withdrawal.user_id, title="Withdrawal Refunded",
                message=f"Your ${float(withdrawal.amount):,.2f} crypto withdrawal could not be sent and was refunded to your wallet.",
                notif_type="withdrawal", action_url="/wallet",
            )
        except Exception:
            pass

    if not address or not np_currency:
        await _refund("Auto-payout unavailable: missing or unrecognised crypto address/asset")
        return False
    try:
        crypto_amt = await nowpayments_service.estimate_crypto_amount(withdrawal.amount, np_currency)
        result = await nowpayments_service.create_payout(
            address=address, np_currency=np_currency, crypto_amount=crypto_amt,
            order_id=str(withdrawal.id),
        )
        withdrawal.payout_batch_id = result.get("batch_id")
        withdrawal.status = "processing"
        withdrawal.approved_at = datetime.utcnow()
        return True
    except Exception as e:
        logger.error("NOWPayments auto-payout failed for withdrawal %s: %s", withdrawal.id, e)
        await _refund(f"Payout error: {e}")
        return False


async def handle_nowpayments_payout_webhook(
    *, batch_id: str, status: str, payload: dict, db: AsyncSession
) -> None:
    """Update an auto crypto withdrawal from its NOWPayments payout IPN.

    finished → 'completed' (+ tx hash). failed/rejected/expired → 'failed' and
    refund the wallet ONCE. Other states (waiting/sending) leave it 'processing'.
    Idempotent: terminal withdrawals are skipped.
    """
    w = (await db.execute(
        select(Withdrawal).where(Withdrawal.payout_batch_id == batch_id)
    )).scalars().first()
    if not w:
        logger.info("Payout IPN for unknown batch %s — ignoring", batch_id)
        return
    cur = (w.status or "").lower()
    if cur in ("completed", "failed", "rejected"):
        return  # already terminal

    s = (status or "").lower()
    if s == "finished":
        w.status = "completed"
        w.completed_at = datetime.utcnow()
        h = payload.get("hash") or payload.get("transaction_hash")
        if h:
            w.crypto_tx_hash = str(h)[:200]
        try:
            await create_notification(
                db, w.user_id, title="Withdrawal Completed",
                message=f"Your ${float(w.amount):,.2f} crypto withdrawal has been sent.",
                notif_type="withdrawal", action_url="/wallet",
            )
        except Exception:
            pass
        await db.commit()
    elif s in ("failed", "rejected", "expired"):
        # Refund the wallet once (the amount was debited when the payout was sent).
        user_row = (await db.execute(
            select(User).where(User.id == w.user_id).with_for_update()
        )).scalar_one_or_none()
        if user_row:
            user_row.main_wallet_balance = (user_row.main_wallet_balance or Decimal("0")) + w.amount
            db.add(Transaction(
                user_id=w.user_id, account_id=None, type="withdrawal",
                amount=w.amount, balance_after=user_row.main_wallet_balance,
                reference_id=w.id, description="Crypto payout failed — refunded to wallet",
            ))
        w.status = "failed"
        w.rejection_reason = f"Payout {s}"[:500]
        try:
            await create_notification(
                db, w.user_id, title="Withdrawal Failed",
                message=f"Your ${float(w.amount):,.2f} crypto withdrawal could not be sent and was refunded to your wallet.",
                notif_type="withdrawal", action_url="/wallet",
            )
        except Exception:
            pass
        await db.commit()
    # else: in-flight (waiting/processing/sending) → keep 'processing'


async def create_withdrawal(req, user_id: UUID, db: AsyncSession) -> dict:
    await _require_kyc_approved(user_id, db)
    from packages.common.src.settings_store import get_bool_setting, get_float_setting
    if await get_bool_setting("maintenance_mode", False):
        raise HTTPException(status_code=503, detail="Platform is under maintenance. Withdrawals are temporarily disabled.")
    if not await get_bool_setting("allow_withdrawals", True):
        raise HTTPException(status_code=403, detail="Withdrawals are currently disabled")

    # Platform-wide minimum withdrawal gate. Admin-tunable via
    # system_settings.min_withdrawal_amount_usd (default $70). 0 = no minimum.
    min_wd_usd = float(await get_float_setting("min_withdrawal_amount_usd", 70.0))
    if min_wd_usd > 0 and float(req.amount) < min_wd_usd:
        raise HTTPException(
            status_code=400,
            detail=f"Minimum withdrawal is ${min_wd_usd:,.2f}.",
        )

    user_q = await db.execute(select(User).where(User.id == user_id))
    user_row = user_q.scalar_one_or_none()
    if not user_row:
        raise HTTPException(status_code=404, detail="User not found")

    main_bal = user_row.main_wallet_balance or Decimal("0")
    if main_bal < req.amount:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Insufficient main wallet balance. Available: ${float(main_bal):.2f}. "
                "Transfer profit from your trading accounts to your main wallet first (Wallet page)."
            ),
        )

    method_norm = METHOD_MAP.get(req.method, "bank_transfer")
    withdrawal = Withdrawal(
        user_id=user_id,
        account_id=None,
        amount=req.amount,
        method=method_norm,
        bank_details=getattr(req, "bank_details", None),
        crypto_address=getattr(req, "crypto_address", None),
        status="pending",
    )
    db.add(withdrawal)
    await db.commit()
    await db.refresh(withdrawal)

    # ── Auto crypto withdrawal (client 2026-06-22): crypto withdrawals at or
    # below crypto_auto_withdrawal_max_usd are paid out automatically via
    # NOWPayments; larger ones stay 'pending' for admin approval. ──
    from . import nowpayments_service as _np
    is_crypto = method_norm in ("oxapay", "nowpayments", "crypto_btc", "crypto_eth", "crypto_usdt", "metamask")
    auto_max = float(await get_float_setting("crypto_auto_withdrawal_max_usd", 0.0))
    auto_eligible = (
        is_crypto
        and await get_bool_setting("crypto_auto_withdrawal_enabled", False)
        and auto_max > 0
        and float(req.amount) <= auto_max
        and _np.payouts_configured()
    )
    if auto_eligible:
        locked = (await db.execute(
            select(User).where(User.id == user_id).with_for_update()
        )).scalar_one_or_none()
        bal = (locked.main_wallet_balance or Decimal("0")) if locked else Decimal("0")
        if locked and bal >= withdrawal.amount:
            # Debit now (no admin step), then send the payout.
            locked.main_wallet_balance = bal - withdrawal.amount
            db.add(Transaction(
                user_id=user_id, account_id=None, type="withdrawal",
                amount=-withdrawal.amount, balance_after=locked.main_wallet_balance,
                reference_id=withdrawal.id, description=f"Auto crypto withdrawal - {req.method}",
            ))
            ok = await _send_nowpayments_payout(withdrawal, locked, db)
            await db.commit()
            await db.refresh(withdrawal)
            if ok:
                try:
                    await create_notification(
                        db, user_id, title="Withdrawal Processing",
                        message=f"${float(withdrawal.amount):,.2f} crypto withdrawal is being sent automatically.",
                        notif_type="withdrawal", action_url="/wallet",
                    )
                    await db.commit()
                except Exception:
                    pass
            return {"id": str(withdrawal.id), "status": withdrawal.status, "amount": float(withdrawal.amount)}
        # balance changed under us → fall through to the manual pending flow

    await create_notification(
        db, user_id,
        title="Withdrawal Submitted",
        message=f"${float(req.amount):,.2f} withdrawal via {req.method} is pending approval",
        notif_type="withdrawal", action_url="/wallet",
    )
    await db.commit()

    # Confirmation email — fire-and-forget so SMTP never blocks the response.
    try:
        from packages.common.src.smtp_mail import (
            send_email, smtp_configured, fire_and_forget,
        )
        from packages.common.src.email_templates import render_withdrawal_requested
        from packages.common.src.config import get_settings as _gs
        if smtp_configured() and user_row.email:
            destination_str: str | None = None
            if withdrawal.crypto_address:
                ca = str(withdrawal.crypto_address)
                # Mask middle of crypto address for the email log.
                destination_str = f"{ca[:6]}…{ca[-4:]}" if len(ca) > 12 else ca
            elif withdrawal.bank_details and isinstance(withdrawal.bank_details, dict):
                acct = withdrawal.bank_details.get("account_number") or ""
                if acct:
                    destination_str = f"Bank ****{str(acct)[-4:]}"
            subject, html, text = render_withdrawal_requested(
                first_name=user_row.first_name,
                amount=req.amount,
                currency="USD",
                method=req.method,
                destination=destination_str,
                request_id=str(withdrawal.id),
                trader_app_url=(_gs().TRADER_APP_URL or "https://trade.swisdex.com"),
            )
            fire_and_forget(send_email(user_row.email, subject, html, text=text, category="account"))
    except Exception as _e:
        logger.warning("withdrawal-requested email failed: %s", _e)

    return {"id": str(withdrawal.id), "status": "pending", "amount": float(withdrawal.amount)}


async def create_manual_withdrawal(
    user_id: UUID,
    amount: Decimal,
    upi_id: str,
    payout_notes: str,
    file: UploadFile | None,
    db: AsyncSession,
) -> dict:
    await _require_kyc_approved(user_id, db)
    from packages.common.src.settings_store import get_bool_setting, get_float_setting
    if not await get_bool_setting("allow_withdrawals", True):
        raise HTTPException(status_code=403, detail="Withdrawals are currently disabled")

    if amount <= 0:
        raise HTTPException(status_code=400, detail="Invalid amount")

    # Platform-wide minimum withdrawal gate — same as the crypto path in
    # create_withdrawal. Manual (bank/UPI) withdrawals were bypassing it.
    min_wd_usd = float(await get_float_setting("min_withdrawal_amount_usd", 70.0))
    if min_wd_usd > 0 and float(amount) < min_wd_usd:
        raise HTTPException(
            status_code=400,
            detail=f"Minimum withdrawal is ${min_wd_usd:,.2f}.",
        )

    upi = (upi_id or "").strip()
    notes = (payout_notes or "").strip()
    qr_path_str: str | None = None

    if file and file.filename:
        suffix = Path(file.filename).suffix.lower()
        if suffix not in DEPOSIT_PROOF_EXT:
            raise HTTPException(status_code=400, detail="Allowed file types for QR: JPG, PNG, PDF, WEBP")
        content = await file.read()
        if not content:
            raise HTTPException(status_code=400, detail="Empty file")
        if len(content) > MAX_PROOF_BYTES:
            raise HTTPException(status_code=400, detail="File too large (max 10 MB)")
        # Magic-byte validation (security review F1) — don't trust the
        # extension; verify the bytes are a real image/PDF.
        from packages.common.src.upload_safety import assert_matches, UnsafeUploadError
        try:
            _kind = assert_matches(content, declared_suffix=suffix, allowed_suffixes=DEPOSIT_PROOF_EXT)
            suffix = _kind.suffix
        except UnsafeUploadError as e:
            raise HTTPException(status_code=400, detail="File content does not match its type. Upload a valid JPG, PNG, PDF, or WEBP.") from e
        try:
            user_dir = safe_join_under_base(_wallet_upload_root(), "withdrawals", str(user_id))
        except PathTraversalError:
            raise HTTPException(status_code=400, detail="Invalid upload path")
        user_dir.mkdir(parents=True, exist_ok=True)
        safe = f"payout_qr_{uuid_lib.uuid4().hex}{suffix}"
        try:
            out_path = safe_join_under_base(user_dir, safe)
        except PathTraversalError:
            raise HTTPException(status_code=400, detail="Invalid file path")
        try:
            out_path.write_bytes(content)
        except OSError as e:
            logger.exception("manual withdrawal qr write failed: %s", out_path)
            raise HTTPException(status_code=503, detail="Could not save file") from e
        qr_path_str = str(out_path.resolve())

    if not upi and not qr_path_str:
        raise HTTPException(
            status_code=400,
            detail="Provide a UPI ID and/or upload a QR code image for manual payout.",
        )

    user_q = await db.execute(select(User).where(User.id == user_id))
    user_row = user_q.scalar_one_or_none()
    if not user_row:
        raise HTTPException(status_code=404, detail="User not found")

    main_bal = user_row.main_wallet_balance or Decimal("0")
    if main_bal < amount:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Insufficient main wallet balance. Available: ${float(main_bal):.2f}. "
                "Transfer profit from trading accounts first."
            ),
        )

    bank_details: dict = {
        "manual": True,
        "upi_id": upi or None,
        "notes": notes or None,
        "user_payout_qr_path": qr_path_str,
    }

    withdrawal = Withdrawal(
        user_id=user_id,
        account_id=None,
        amount=amount,
        method="manual",
        bank_details=bank_details,
        status="pending",
    )
    db.add(withdrawal)
    await db.commit()
    await db.refresh(withdrawal)

    await create_notification(
        db, user_id,
        title="Withdrawal Submitted",
        message=f"${float(amount):,.2f} manual withdrawal pending approval",
        notif_type="withdrawal", action_url="/wallet",
    )
    await db.commit()

    return {"id": str(withdrawal.id), "status": "pending", "amount": float(withdrawal.amount)}


# ─── Transfers ────────────────────────────────────────────────────────────

async def internal_wallet_transfer(req, user_id: UUID, db: AsyncSession) -> dict:
    if req.from_account_id == req.to_account_id:
        raise HTTPException(status_code=400, detail="Choose two different accounts")

    # Lock BOTH account rows FOR UPDATE before the free-balance check and the
    # read-modify-write below, mirroring transfer_trading_to_main (audit
    # finding C2). Without this, two concurrent transfers out of the same
    # source each read the stale source balance and each credits its
    # destination in full — minting money. Lock in a deterministic id order
    # so two opposite-direction transfers can't deadlock.
    rows = (await db.execute(
        select(TradingAccount).where(
            TradingAccount.id.in_([req.from_account_id, req.to_account_id]),
            TradingAccount.user_id == user_id,
            TradingAccount.is_demo == False,
        ).order_by(TradingAccount.id).with_for_update()
    )).scalars().all()
    by_id = {a.id: a for a in rows}
    from_a = by_id.get(req.from_account_id)
    to_a = by_id.get(req.to_account_id)
    if not from_a or not to_a:
        raise HTTPException(status_code=404, detail="Account not found")

    amt = Decimal(str(req.amount))
    free = (from_a.balance or Decimal("0")) - (from_a.margin_used or Decimal("0"))
    if free < amt:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Insufficient available balance on the source account. "
                f"Available: ${float(free):.2f} (${float(from_a.margin_used or 0):.2f} locked in open trades)."
            ),
        )

    from_a.balance = (from_a.balance or Decimal("0")) - amt
    from_a.equity = from_a.balance + (from_a.credit or Decimal("0"))
    from_a.free_margin = from_a.equity - (from_a.margin_used or Decimal("0"))

    to_a.balance = (to_a.balance or Decimal("0")) + amt
    to_a.equity = to_a.balance + (to_a.credit or Decimal("0"))
    to_a.free_margin = to_a.equity - (to_a.margin_used or Decimal("0"))

    db.add(Transaction(
        user_id=user_id, account_id=from_a.id, type="transfer",
        amount=-amt, balance_after=from_a.balance,
        description=f"Transfer to {to_a.account_number}",
    ))
    db.add(Transaction(
        user_id=user_id, account_id=to_a.id, type="transfer",
        amount=amt, balance_after=to_a.balance,
        description=f"Transfer from {from_a.account_number}",
    ))
    await db.commit()

    return {
        "message": "Transfer completed.",
        "from_balance": float(from_a.balance),
        "to_balance": float(to_a.balance),
    }


async def transfer_trading_to_main(req, user_id: UUID, db: AsyncSession) -> dict:
    amt = Decimal(str(req.amount))

    # Lock the trading account row so concurrent withdrawals-to-main
    # can't both pass the free-balance check (audit finding C2).
    acc_q = await db.execute(
        select(TradingAccount).where(
            TradingAccount.id == req.from_account_id,
            TradingAccount.user_id == user_id,
            TradingAccount.is_demo == False,
        ).with_for_update()
    )
    account = acc_q.scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=404, detail="Trading account not found")

    # Block master pool accounts (PAMM / MAM). The pool holds INVESTORS'
    # money, so the master must never be able to internal-transfer it
    # into their own main wallet — client report 2026-06-01: "pamm
    # master fund transfer kar pa raha hai, ese to pool amount jo
    # collect hoga sab withdraw le lega". The funds only legitimately
    # leave the pool through:
    #   • investor withdraw_managed_account (their share back to them)
    #   • admin delete_master (sweep with full investor refund)
    #   • engine cycles (performance fee → master's row, but that
    #     lands on a Transaction, not the pool account).
    from packages.common.src.models import MasterAccount
    is_pool = (await db.execute(
        select(MasterAccount).where(MasterAccount.account_id == account.id)
    )).scalar_one_or_none()
    if is_pool is not None:
        raise HTTPException(
            status_code=403,
            detail=(
                "This is a PAMM / MAM pool account. Funds cannot be moved "
                "to the main wallet — they're held in trust for investors. "
                "Use the admin delete-master flow to wind the pool down "
                "with proper investor refunds."
            ),
        )

    free = (account.balance or Decimal("0")) - (account.margin_used or Decimal("0"))
    # The UI's "Max" fills the 2-decimal DISPLAY value, which can round a hair
    # above the true free balance (e.g. 16694.4599 shown as 16694.46) and trip
    # a strict `free < amt`. Treat a within-1-cent overshoot as "transfer all"
    # and clamp to the exact free balance (client 2026-06-26).
    if amt > free:
        if amt - free <= Decimal("0.01"):
            amt = free
        else:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Insufficient available balance on this trading account. "
                    f"Available: ${float(free):.2f} (${float(account.margin_used or 0):.2f} locked in open trades)."
                ),
            )

    user_q = await db.execute(
        select(User).where(User.id == user_id).with_for_update()
    )
    user_row = user_q.scalar_one_or_none()
    if not user_row:
        raise HTTPException(status_code=404, detail="User not found")

    account.balance = (account.balance or Decimal("0")) - amt

    # Credit rule (client 2026-06-24): bonus / admin credit is tradable but must
    # stay "backed" by real balance — the user must keep at least `credit` worth
    # of balance in the account. If THIS transfer drops the balance below the
    # credit, they've pulled their real money out from under the bonus, so the
    # bonus credit is forfeited in full. Insurance-claim credit is EARNED money
    # (the user paid the insurance fee) and survives — same protection as the
    # first-withdrawal forfeiture.
    cur_credit = account.credit or Decimal("0")
    if cur_credit > 0 and account.balance < cur_credit:
        insurance_credit = Decimal(str((await db.execute(
            select(func.coalesce(func.sum(Transaction.amount), 0)).where(
                Transaction.account_id == account.id,
                Transaction.type == "insurance_payout",
            )
        )).scalar() or 0))
        protected = min(cur_credit, max(Decimal("0"), insurance_credit))
        forfeited = cur_credit - protected
        if forfeited > 0:
            account.credit = protected
            db.add(Transaction(
                user_id=user_id, account_id=account.id, type="bonus_forfeited",
                amount=-forfeited, balance_after=account.balance,
                description=(
                    f"Bonus credit forfeited — balance dropped below credit on "
                    f"transfer to main wallet (${float(forfeited):.2f})"
                ),
            ))

    account.equity = account.balance + (account.credit or Decimal("0"))
    account.free_margin = account.equity - (account.margin_used or Decimal("0"))

    user_row.main_wallet_balance = (user_row.main_wallet_balance or Decimal("0")) + amt

    db.add(Transaction(
        user_id=user_id, account_id=account.id, type="transfer",
        amount=-amt, balance_after=account.balance,
        description="Transfer to main wallet",
    ))
    db.add(Transaction(
        user_id=user_id, account_id=None, type="transfer",
        amount=amt, balance_after=user_row.main_wallet_balance,
        description=f"From trading account {account.account_number}",
    ))
    await db.commit()

    return {
        "message": "Funds moved to main wallet.",
        "main_wallet_balance": float(user_row.main_wallet_balance),
        "trading_balance": float(account.balance),
    }


async def transfer_main_to_trading(req, user_id: UUID, db: AsyncSession) -> dict:
    amt = Decimal(str(req.amount))

    # Lock the user row FOR UPDATE so concurrent transfers can't each
    # pass the balance check and move more than the user holds (audit
    # finding C2 — double-spend / minting tradeable balance).
    user_q = await db.execute(
        select(User).where(User.id == user_id).with_for_update()
    )
    user_row = user_q.scalar_one_or_none()
    if not user_row:
        raise HTTPException(status_code=404, detail="User not found")

    main_bal = user_row.main_wallet_balance or Decimal("0")
    if main_bal < amt:
        raise HTTPException(
            status_code=400,
            detail=f"Insufficient main wallet balance. Available: ${float(main_bal):.2f}",
        )

    acc_q = await db.execute(
        select(TradingAccount).where(
            TradingAccount.id == req.to_account_id,
            TradingAccount.user_id == user_id,
            TradingAccount.is_demo == False,
        )
    )
    account = acc_q.scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=404, detail="Trading account not found")

    user_row.main_wallet_balance = main_bal - amt
    account.balance = (account.balance or Decimal("0")) + amt

    # Sweep any pending main_wallet_bonus onto this account's credit so
    # the user can actually trade with the bonus (migration 0056). Bonus
    # contributes to equity / free margin but is NOT part of balance, so
    # it stays out of the withdrawable amount and gets wiped on the first
    # approved withdrawal. We move the FULL bonus (not proportional) on
    # the first transfer that runs while it's > 0 — simpler model, and
    # avoids stranding small bonus dust in main_wallet_bonus.
    bonus_swept = Decimal("0")
    pending_bonus = user_row.main_wallet_bonus or Decimal("0")
    if pending_bonus > 0:
        bonus_swept = pending_bonus
        account.credit = (account.credit or Decimal("0")) + bonus_swept
        user_row.main_wallet_bonus = Decimal("0")

    account.equity = account.balance + (account.credit or Decimal("0"))
    account.free_margin = account.equity - (account.margin_used or Decimal("0"))

    db.add(Transaction(
        user_id=user_id, account_id=None, type="transfer",
        amount=-amt, balance_after=user_row.main_wallet_balance,
        description=f"To trading account {account.account_number}",
    ))
    db.add(Transaction(
        user_id=user_id, account_id=account.id, type="transfer",
        amount=amt, balance_after=account.balance,
        description="Transfer from main wallet",
    ))
    if bonus_swept > 0:
        db.add(Transaction(
            user_id=user_id, account_id=account.id, type="bonus",
            amount=bonus_swept, balance_after=account.balance,
            description=(
                f"Bonus credit moved from main wallet "
                f"(tradeable; not withdrawable; cleared on first withdrawal)"
            ),
        ))
    await db.commit()

    return {
        "message": "Funds moved to trading account.",
        "main_wallet_balance": float(user_row.main_wallet_balance),
        "trading_balance": float(account.balance),
        "bonus_credit_moved": float(bonus_swept) if bonus_swept > 0 else 0,
    }


# ─── Queries ──────────────────────────────────────────────────────────────

async def list_deposits(user_id: UUID, db: AsyncSession) -> dict:
    # Exclude 'initiated' deposits (OxaPay payments that were never started)
    query = (
        select(Deposit)
        .where(
            Deposit.user_id == user_id,
            Deposit.status != "initiated"
        )
        .order_by(Deposit.created_at.desc())
    )
    result = await db.execute(query)
    deposits = result.scalars().all()
    return {
        "items": [
            {
                "id": str(d.id),
                "created_at": d.created_at.isoformat() if d.created_at else None,
                "type": "deposit",
                "method": d.method or "bank",
                "amount": float(d.amount or 0),
                "status": d.status or "pending",
                "currency": "USD",
            }
            for d in deposits
        ]
    }


async def list_withdrawals(user_id: UUID, db: AsyncSession) -> dict:
    query = (
        select(Withdrawal)
        .where(Withdrawal.user_id == user_id)
        .order_by(Withdrawal.created_at.desc())
    )
    result = await db.execute(query)
    withdrawals = result.scalars().all()
    return {
        "items": [
            {
                "id": str(w.id),
                "created_at": w.created_at.isoformat() if w.created_at else None,
                "type": "withdrawal",
                "method": w.method or "bank",
                "amount": float(w.amount or 0),
                "status": w.status or "pending",
                "currency": "USD",
            }
            for w in withdrawals
        ]
    }


def _ledger_entry_method(txn_type: str | None) -> str:
    t = (txn_type or "").lower()
    if t == "transfer":
        return "Internal transfer"
    if t in ("adjustment", "credit"):
        return "Admin adjustment"
    if t == "profit":
        return "Trading — profit"
    if t == "loss":
        return "Trading — loss"
    return t.replace("_", " ").title() if t else "Ledger"


async def list_transactions(user_id: UUID, account_id: UUID | None, db: AsyncSession) -> dict:
    if account_id:
        acct = await db.execute(
            select(TradingAccount).where(
                TradingAccount.id == account_id,
                TradingAccount.user_id == user_id,
            )
        )
        if not acct.scalar_one_or_none():
            raise HTTPException(status_code=404, detail="Account not found")
        query = select(Transaction).where(Transaction.account_id == account_id)
    else:
        # Aggregate ("all") view must NOT mix in demo-account activity — demo
        # trades (P&L / commission / swap ledger rows) were leaking into the
        # real transaction history. Keep main-wallet rows (NULL account_id) and
        # real-account rows; drop anything tied to a demo account (2026-06-25).
        demo_acct_ids = select(TradingAccount.id).where(
            TradingAccount.user_id == user_id,
            TradingAccount.is_demo == True,  # noqa: E712
        )
        query = select(Transaction).where(
            Transaction.user_id == user_id,
            or_(
                Transaction.account_id.is_(None),
                Transaction.account_id.notin_(demo_acct_ids),
            ),
        )

    query = query.order_by(Transaction.created_at.desc()).limit(500)
    result = await db.execute(query)
    txns = result.scalars().all()

    return {
        "items": [
            {
                "id": str(t.id),
                "created_at": t.created_at.isoformat() if t.created_at else None,
                "type": t.type or "adjustment",
                "method": _ledger_entry_method(t.type),
                "amount": float(t.amount or 0),
                "status": "completed",
                "currency": "USD",
                "description": (t.description or "").strip(),
                "account_id": str(t.account_id) if t.account_id else None,
            }
            for t in txns
        ]
    }


async def wallet_summary(user_id: UUID, account_id: UUID | None, db: AsyncSession) -> dict:
    user_q = await db.execute(select(User).where(User.id == user_id))
    user_row = user_q.scalar_one_or_none()
    main_wallet_balance = float(user_row.main_wallet_balance or 0) if user_row else 0.0

    dep_glob = await db.execute(
        select(func.coalesce(func.sum(Deposit.amount), 0)).where(
            Deposit.user_id == user_id,
            Deposit.status.in_(["approved", "auto_approved"]),
        )
    )
    total_deposited = float(dep_glob.scalar() or 0)

    wd_glob = await db.execute(
        select(func.coalesce(func.sum(Withdrawal.amount), 0)).where(
            Withdrawal.user_id == user_id,
            Withdrawal.status.in_(["approved", "completed"]),
        )
    )
    total_withdrawn = float(wd_glob.scalar() or 0)

    adj_main_in = await db.execute(
        select(func.coalesce(func.sum(Transaction.amount), 0)).where(
            Transaction.user_id == user_id,
            Transaction.account_id.is_(None),
            Transaction.type.in_(["adjustment", "credit"]),
            Transaction.amount > 0,
        )
    )
    adj_main_out = await db.execute(
        select(func.coalesce(func.sum(Transaction.amount), 0)).where(
            Transaction.user_id == user_id,
            Transaction.account_id.is_(None),
            Transaction.type.in_(["adjustment", "credit"]),
            Transaction.amount < 0,
        )
    )
    total_deposited += float(adj_main_in.scalar() or 0)
    total_withdrawn += abs(float(adj_main_out.scalar() or 0))

    acct_q = await db.execute(
        select(TradingAccount)
        .where(
            TradingAccount.user_id == user_id,
            TradingAccount.is_demo == False,
            TradingAccount.is_active == True,
        )
        .order_by(TradingAccount.created_at)
    )
    live_list = list(acct_q.scalars().all())

    # Cent-account flag per account so the wallet UI can render ¢ balances and
    # convert ¢→USD on transfer (client 2026-06-23).
    cent_rows = (await db.execute(
        select(TradingAccount.id, AccountGroup.is_cent_account)
        .join(AccountGroup, AccountGroup.id == TradingAccount.account_group_id, isouter=True)
        .where(TradingAccount.id.in_([a.id for a in live_list]))
    )).all() if live_list else []
    cent_map = {str(aid): bool(ic) for aid, ic in cent_rows}

    live_accounts_payload = [
        {
            "id": str(a.id),
            "account_number": a.account_number,
            "balance": float(a.balance or 0),
            "credit": float(a.credit or 0),
            "margin_used": float(a.margin_used or 0),
            "currency": a.currency or "USD",
            "free_margin": float((a.balance or Decimal("0")) - (a.margin_used or Decimal("0"))),
            "is_cent_account": cent_map.get(str(a.id), False),
        }
        for a in live_list
    ]
    total_live_balance = sum(float(a.balance or 0) for a in live_list)

    main_wallet_bonus = float(
        getattr(user_row, "main_wallet_bonus", None) or 0
    )
    bonus_forfeited_at = getattr(user_row, "bonus_forfeited_at", None)
    bonus_forfeited_iso = bonus_forfeited_at.isoformat() if bonus_forfeited_at else None

    if not live_list:
        return {
            "main_wallet_balance": main_wallet_balance,
            "main_wallet_bonus": main_wallet_bonus,
            "bonus_forfeited_at": bonus_forfeited_iso,
            "balance": 0, "credit": 0, "equity": 0, "margin_used": 0, "free_margin": 0,
            "total_deposited": total_deposited, "total_withdrawn": total_withdrawn,
            "total_live_balance": 0, "live_accounts": [],
        }

    if account_id is not None:
        account = next((a for a in live_list if a.id == account_id), None)
        if not account:
            raise HTTPException(status_code=404, detail="Live account not found")
        accounts_for_metrics = [account]
    else:
        accounts_for_metrics = live_list

    total_credit = Decimal("0")
    total_equity = Decimal("0")
    total_margin = Decimal("0")
    total_free = Decimal("0")

    for acc in accounts_for_metrics:
        total_credit += acc.credit or Decimal("0")
        total_equity += acc.equity or acc.balance or Decimal("0")
        total_margin += acc.margin_used or Decimal("0")
        bal = acc.balance or Decimal("0")
        mu = acc.margin_used or Decimal("0")
        total_free += bal - mu

    primary_balance = float(account.balance or 0) if account_id is not None else total_live_balance

    return {
        "main_wallet_balance": main_wallet_balance,
        "main_wallet_bonus": main_wallet_bonus,
        "bonus_forfeited_at": bonus_forfeited_iso,
        "balance": primary_balance,
        "credit": float(total_credit),
        "equity": float(total_equity),
        "margin_used": float(total_margin),
        "free_margin": float(total_free),
        "total_deposited": total_deposited,
        "total_withdrawn": total_withdrawn,
        "total_live_balance": total_live_balance,
        "live_accounts": live_accounts_payload,
    }


async def get_deposit_bank_details(amount: Decimal | None, db: AsyncSession) -> dict:
    bank = None
    if amount is not None and amount > 0:
        bank = await _get_bank_for_tier(amount, db)
        await db.commit()
    if bank is None:
        result = await db.execute(
            select(BankAccount)
            .where(BankAccount.is_active == True)
            .order_by(BankAccount.rotation_order)
            .limit(1)
        )
        bank = result.scalars().first()
    if not bank:
        return {}

    resp: dict = {}
    if bank.bank_name:
        resp["bank_name"] = bank.bank_name
    if bank.account_name:
        resp["account_holder"] = bank.account_name
    if bank.account_number:
        resp["account_number"] = bank.account_number
    if bank.ifsc_code:
        resp["ifsc_code"] = bank.ifsc_code
    if bank.upi_id:
        resp["upi_id"] = bank.upi_id
    if bank.qr_code_url:
        resp["qr_code_url"] = bank.qr_code_url
    return resp


async def list_deposit_banks(amount: Decimal | None, db: AsyncSession) -> dict:
    """All active bank accounts for the XM-style deposit picker. When `amount`
    is given, only banks whose [min,max] tier covers it are returned."""
    q = select(BankAccount).where(BankAccount.is_active == True)
    if amount is not None and amount > 0:
        q = q.where(BankAccount.min_amount <= amount, BankAccount.max_amount >= amount)
    q = q.order_by(BankAccount.rotation_order, BankAccount.tier)
    rows = (await db.execute(q)).scalars().all()
    banks = []
    for b in rows:
        banks.append({
            "id": str(b.id),
            "bank_name": b.bank_name,
            "account_holder": b.account_name,
            "account_number": b.account_number,
            "ifsc_code": b.ifsc_code,
            "upi_id": b.upi_id,
            "qr_code_url": b.qr_code_url,
            "min_amount": float(b.min_amount or 0),
            "max_amount": float(b.max_amount or 0),
        })
    return {"banks": banks}


async def get_bank_info(amount: Decimal, db: AsyncSession) -> dict:
    bank = await _get_bank_for_tier(amount, db)
    if not bank:
        raise HTTPException(status_code=404, detail="No bank account available for this amount")
    await db.commit()
    return {
        "bank_name": bank.bank_name,
        "account_name": bank.account_name,
        "account_number": bank.account_number,
        "ifsc_code": bank.ifsc_code,
        "upi_id": bank.upi_id,
        "qr_code_url": bank.qr_code_url,
    }


# ─────────────────────────────────────────────────────────────────────
# Trade insurance — fee debit
# (Payouts are credited inside packages.common.src.insurance.claims so
#  the credit + InsuranceClaim INSERT are atomic with position close.)
# ─────────────────────────────────────────────────────────────────────

async def charge_insurance_fee(
    *,
    db: AsyncSession,
    user_id: UUID,
    account_id: UUID,
    amount: Decimal,
    policy_id: UUID,
    description: str,
) -> Decimal:
    """Debit `amount` from the trading account that holds the insured position.
    Caller is responsible for `db.commit()`. Raises 402 if balance is short.

    The fee comes off `TradingAccount.balance` — the same pool that pays for
    margin, commission, and swap on the position itself. Equity is updated
    so the trader UI's free-margin / margin-level reflect the new balance
    immediately. Insurance claim payouts (see insurance/claims.py) credit
    the same field, keeping the loop closed on a single balance.

    Returns the trading account's new balance.
    """
    account = (await db.execute(
        select(TradingAccount).where(TradingAccount.id == account_id).with_for_update()
    )).scalar_one_or_none()
    if account is None:
        raise HTTPException(status_code=404, detail="trading_account_not_found")
    if account.user_id != user_id:
        raise HTTPException(status_code=403, detail="account_user_mismatch")

    bal = Decimal(str(account.balance or 0))
    if bal < amount:
        raise HTTPException(status_code=402, detail="insufficient_balance")

    new_balance = bal - amount
    account.balance = new_balance
    # Equity drops by the fee amount alongside balance (unrealized PnL is
    # carried by other code paths; keep them in sync without recomputing).
    if account.equity is not None:
        account.equity = Decimal(str(account.equity)) - amount

    db.add(Transaction(
        id=uuid_lib.uuid4(),
        user_id=user_id,
        account_id=account_id,
        type="insurance_fee",
        amount=-amount,
        balance_after=new_balance,
        reference_id=policy_id,
        description=description,
    ))
    return new_balance


# ─── Trader-facing bonus dashboard ───────────────────────────────────────
# Backs the /wallet#bonus section so the trader can see:
#   1. Active bonus offers (admin-published; the same rows the auto-apply
#      loop reads on each approved deposit).
#   2. Their own UserBonus rows (active / released / expired).
#   3. Recent deposits where they typed a promo code at deposit time, and
#      whether admin granted / denied / is still reviewing.

async def get_bonus_overview(*, user_id: UUID, db: AsyncSession) -> dict:
    now = datetime.now(timezone.utc)  # tz-aware: offer dates are TIMESTAMPTZ

    offers_q = await db.execute(
        select(BonusOffer)
        .where(BonusOffer.is_active == True)
        .order_by(BonusOffer.created_at.desc())
    )
    active_offers = []
    for o in offers_q.scalars().all():
        # Date-window guard — admin can pre-schedule offers.
        if o.starts_at and o.starts_at > now:
            continue
        if o.expires_at and o.expires_at < now:
            continue
        active_offers.append({
            "id": str(o.id),
            "name": o.name,
            "bonus_type": o.bonus_type,
            "percentage": float(o.percentage) if o.percentage is not None else None,
            "fixed_amount": float(o.fixed_amount) if o.fixed_amount is not None else None,
            "min_deposit": float(o.min_deposit or 0),
            "max_bonus": float(o.max_bonus) if o.max_bonus is not None else None,
            "lots_required": float(o.lots_required or 0),
            "target_audience": o.target_audience,
            "starts_at": o.starts_at.isoformat() if o.starts_at else None,
            "expires_at": o.expires_at.isoformat() if o.expires_at else None,
        })

    my_q = await db.execute(
        select(UserBonus, BonusOffer)
        .join(BonusOffer, UserBonus.offer_id == BonusOffer.id, isouter=True)
        .where(UserBonus.user_id == user_id)
        .order_by(UserBonus.created_at.desc())
        .limit(50)
    )
    my_bonuses = []
    for ub, offer in my_q.all():
        my_bonuses.append({
            "id": str(ub.id),
            "offer_name": offer.name if offer else None,
            "amount": float(ub.amount or 0),
            "lots_traded": float(ub.lots_traded or 0),
            "lots_required": float(ub.lots_required or 0),
            "status": ub.status,
            "released_at": ub.released_at.isoformat() if ub.released_at else None,
            "expires_at": ub.expires_at.isoformat() if ub.expires_at else None,
            "created_at": ub.created_at.isoformat() if ub.created_at else None,
        })

    req_q = await db.execute(
        select(Deposit)
        .where(Deposit.user_id == user_id, Deposit.bonus_code.isnot(None))
        .order_by(Deposit.created_at.desc())
        .limit(10)
    )
    recent_requests = []
    for d in req_q.scalars().all():
        recent_requests.append({
            "deposit_id": str(d.id),
            "deposit_amount": float(d.amount or 0),
            "deposit_status": d.status,
            "bonus_code": d.bonus_code,
            "bonus_status": d.bonus_status,
            "bonus_amount": float(d.bonus_amount) if d.bonus_amount is not None else None,
            "decided_at": d.bonus_decided_at.isoformat() if d.bonus_decided_at else None,
            "created_at": d.created_at.isoformat() if d.created_at else None,
        })

    return {
        "active_offers": active_offers,
        "my_bonuses": my_bonuses,
        "recent_requests": recent_requests,
    }
