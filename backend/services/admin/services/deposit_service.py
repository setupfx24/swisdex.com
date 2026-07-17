"""Admin Finance Service — deposit/withdrawal listing, approval, rejection, screenshots."""
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import FileResponse
from sqlalchemy import select, func, or_, text
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.models import User, TradingAccount, Deposit, Withdrawal, Transaction, BonusOffer
from packages.common.src.notify import create_notification
from packages.common.src.admin_schemas import DepositOut, WithdrawalOut, PaginatedResponse
from dependencies import write_audit_log


def _not_promo(user_id_col):
    """Filter expression: exclude rows owned by a promotional demo account so
    they never surface in admin listings."""
    return user_id_col.notin_(select(User.id).where(User.is_promotional == True))  # noqa: E712


def _deposit_to_out(d: Deposit, user: User = None) -> DepositOut:
    return DepositOut(
        id=str(d.id),
        user_id=str(d.user_id),
        account_id=str(d.account_id) if d.account_id else None,
        amount=float(d.amount or 0),
        currency=d.currency or "INR",
        method=d.method,
        status=d.status,
        transaction_id=d.transaction_id,
        screenshot_url=d.screenshot_url,
        rejection_reason=d.rejection_reason,
        created_at=d.created_at,
        user_email=user.email if user else None,
        user_name=f"{user.first_name or ''} {user.last_name or ''}".strip() if user else None,
        bonus_code=d.bonus_code,
        bonus_status=d.bonus_status,
        bonus_amount=float(d.bonus_amount) if d.bonus_amount is not None else None,
    )


def _withdrawal_to_out(w: Withdrawal, user: User = None) -> WithdrawalOut:
    return WithdrawalOut(
        id=str(w.id),
        user_id=str(w.user_id),
        account_id=str(w.account_id) if w.account_id else None,
        amount=float(w.amount or 0),
        currency=w.currency or "INR",
        method=w.method,
        status=w.status,
        bank_details=w.bank_details,
        crypto_address=w.crypto_address,
        rejection_reason=w.rejection_reason,
        created_at=w.created_at,
        user_email=user.email if user else None,
        user_name=f"{user.first_name or ''} {user.last_name or ''}".strip() if user else None,
    )


async def list_pending_deposits(page: int, per_page: int, db: AsyncSession):
    query = select(Deposit).where(Deposit.status == "pending", _not_promo(Deposit.user_id))
    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0

    query = query.order_by(Deposit.created_at.asc()).offset((page - 1) * per_page).limit(per_page)
    result = await db.execute(query)
    deposits = result.scalars().all()

    items = []
    for d in deposits:
        user_q = await db.execute(select(User).where(User.id == d.user_id))
        user = user_q.scalar_one_or_none()
        items.append(_deposit_to_out(d, user))

    return PaginatedResponse(items=items, total=total, page=page, per_page=per_page)


async def list_pending_withdrawals(page: int, per_page: int, db: AsyncSession):
    query = select(Withdrawal).where(Withdrawal.status == "pending", _not_promo(Withdrawal.user_id))
    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0

    query = query.order_by(Withdrawal.created_at.asc()).offset((page - 1) * per_page).limit(per_page)
    result = await db.execute(query)
    withdrawals = result.scalars().all()

    items = []
    for w in withdrawals:
        user_q = await db.execute(select(User).where(User.id == w.user_id))
        user = user_q.scalar_one_or_none()
        items.append(_withdrawal_to_out(w, user))

    return PaginatedResponse(items=items, total=total, page=page, per_page=per_page)


async def list_all_deposits(page: int, per_page: int, status: str | None, db: AsyncSession,
                            start_date=None, end_date=None):
    query = select(Deposit).where(_not_promo(Deposit.user_id))
    if status and status != "all":
        if status == "approved":
            query = query.where(Deposit.status.in_(["approved", "auto_approved"]))
        else:
            query = query.where(Deposit.status == status)
    if start_date is not None:
        query = query.where(Deposit.created_at >= start_date)
    if end_date is not None:
        query = query.where(Deposit.created_at <= end_date)
    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0

    query = query.order_by(Deposit.created_at.desc()).offset((page - 1) * per_page).limit(per_page)
    result = await db.execute(query)
    deposits = result.scalars().all()

    items = []
    for d in deposits:
        user_q = await db.execute(select(User).where(User.id == d.user_id))
        user = user_q.scalar_one_or_none()
        items.append(_deposit_to_out(d, user))

    return PaginatedResponse(items=items, total=total, page=page, per_page=per_page)


async def list_all_withdrawals(page: int, per_page: int, status: str | None, db: AsyncSession,
                               start_date=None, end_date=None):
    query = select(Withdrawal).where(_not_promo(Withdrawal.user_id))
    if status and status != "all":
        query = query.where(Withdrawal.status == status)
    if start_date is not None:
        query = query.where(Withdrawal.created_at >= start_date)
    if end_date is not None:
        query = query.where(Withdrawal.created_at <= end_date)
    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0

    query = query.order_by(Withdrawal.created_at.desc()).offset((page - 1) * per_page).limit(per_page)
    result = await db.execute(query)
    withdrawals = result.scalars().all()

    items = []
    for w in withdrawals:
        user_q = await db.execute(select(User).where(User.id == w.user_id))
        user = user_q.scalar_one_or_none()
        items.append(_withdrawal_to_out(w, user))

    return PaginatedResponse(items=items, total=total, page=page, per_page=per_page)


async def approve_deposit(
    deposit_id: uuid.UUID, admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
    verified_amount: Decimal | None = None,
    approval_request_id: uuid.UUID | None = None,
) -> dict:
    # Lock the deposit row so a double-click / two admins can't both
    # approve and credit twice.
    result = await db.execute(
        select(Deposit).where(Deposit.id == deposit_id).with_for_update()
    )
    deposit = result.scalar_one_or_none()
    if not deposit:
        raise HTTPException(status_code=404, detail="Deposit not found")
    if deposit.status != "pending":
        raise HTTPException(status_code=400, detail="Deposit is not pending")

    # ── Two-admin gate (client 2026-06-16): EVERY deposit approval, any
    # amount, needs a second SUPER-ADMIN sign-off. The first call (by the
    # deposit-authority admin) creates a pending request and raises 202; a
    # super admin approves it in /approvals, which re-invokes this with
    # approval_request_id set to actually credit the user. ──
    from .approval_service import request_or_execute, mark_executed
    from packages.common.src.settings_store import get_bool_setting, get_float_setting
    _gate_amt = Decimal(str(verified_amount if verified_amount is not None else (deposit.amount or 0)))
    # Dual-approval for deposits is OPT-IN (client 2026-06-20). Forcing EVERY
    # deposit through a second super-admin sign-off deadlocked single-admin
    # setups — the requesting admin can't approve their own request
    # (chk_distinct_approver), and if there's no second approver the deposit is
    # stuck "pending approval" forever, which surfaced to the client as
    # "deposit approve nahi ho raha / internal server error". Default now: the
    # deposit-authority admin approves directly. Brokers who want the strict
    # two-admin flow flip on `deposit_dual_approval_required`.
    # Dual approval fires when EITHER the strict "all deposits" flag is on, OR
    # the amount is at/above the admin-set limit (deposit_dual_approval_min_usd;
    # 0 = no limit). Lets a broker require a second super-admin sign-off only on
    # large deposits (client 2026-07-08).
    _dual_required = await get_bool_setting("deposit_dual_approval_required", False)
    _dual_min = Decimal(str(await get_float_setting("deposit_dual_approval_min_usd", 0.0)))
    _needs_dual = _dual_required or (_dual_min > 0 and _gate_amt >= _dual_min)
    if approval_request_id is not None:
        # Second leg: a different super admin completed the request in /approvals
        # and it re-invokes here with the request id — validate then credit.
        _ar = (await db.execute(
            text("SELECT status, action, target_id FROM admin_approval_requests WHERE id = :rid FOR UPDATE"),
            {"rid": str(approval_request_id)},
        )).mappings().first()
        if not _ar or _ar["status"] != "approved":
            raise HTTPException(status_code=409, detail="Approval not in 'approved' state")
        if _ar["action"] != "deposit_approve" or str(_ar["target_id"]) != str(deposit_id):
            raise HTTPException(status_code=409, detail="Approval does not match this deposit")
    elif _needs_dual:
        # Strict two-admin flow ON → create a pending request and stop (202).
        await request_or_execute(
            db, action="deposit_approve", target_type="deposit",
            target_id=deposit_id, amount=_gate_amt,
            payload={"verified_amount": str(_gate_amt)},
            requested_by=admin_id, always=True,
        )
        # request_or_execute raises ApprovalRequired (202) — unreachable below.
    # else: single-admin direct approval → fall through and credit now.

    # Manual deposits carry the amount the USER typed in the form, which
    # may not match their uploaded proof (audit finding H1 — user claims
    # $10k on a $100 transfer). When the admin passes a verified_amount
    # on approval, credit THAT (the amount finance actually confirmed),
    # not the user-claimed value. Overwrite deposit.amount so every
    # downstream (bonus brackets, ledger) uses the verified figure.
    if verified_amount is not None:
        vamt = Decimal(str(verified_amount))
        if vamt <= 0:
            raise HTTPException(status_code=400, detail="Verified amount must be positive")
        deposit.amount = vamt

    deposit.status = "approved"
    deposit.approved_by = admin_id
    deposit.approved_at = datetime.utcnow()

    user_q = await db.execute(
        select(User).where(User.id == deposit.user_id).with_for_update()
    )
    user_row = user_q.scalar_one_or_none()
    if not user_row:
        raise HTTPException(status_code=400, detail="User not found for deposit")

    user_row.main_wallet_balance = (user_row.main_wallet_balance or Decimal("0")) + deposit.amount

    db.add(
        Transaction(
            user_id=deposit.user_id,
            account_id=None,
            type="deposit",
            amount=deposit.amount,
            balance_after=user_row.main_wallet_balance,
            reference_id=deposit.id,
            description=f"Deposit to main wallet - {deposit.method or 'manual'}",
            created_by=admin_id,
        )
    )

    bonus_msg = ""
    applied_bonuses: list[tuple[str, Decimal]] = []
    # tz-AWARE: bonus-offer starts_at/expires_at are TIMESTAMPTZ (tz-aware),
    # so `now` must be tz-aware too — comparing a naive utcnow() against them
    # raised "can't compare offset-naive and offset-aware datetimes", which
    # silently killed the bonus grant for any offer that had a date window set.
    now = datetime.now(timezone.utc)
    # Two gates only (2026-05-27 client fix):
    #   - user already had a prior approved deposit? → skip (first deposit only)
    #   - user already had a withdrawal approved? → skip (bonus_forfeited_at
    #     prevents farming via withdraw+redeposit cycles)
    #
    # Earlier code ALSO skipped the welcome-bonus brackets when the
    # user typed a bonus_code at deposit time. That meant if the code
    # was unknown / expired, the user got nothing — not even the
    # automatic bracket-based welcome bonus they were entitled to as
    # a first-deposit user. The code-specific path runs separately
    # below and is now purely additive (stacks with the welcome bonus
    # when valid, no-ops when not).
    from packages.common.src.models import Deposit as _Deposit
    prior_approved = (await db.execute(
        select(func.count()).select_from(_Deposit).where(
            _Deposit.user_id == deposit.user_id,
            _Deposit.status.in_(["approved", "auto_approved"]),
            _Deposit.id != deposit.id,
        )
    )).scalar() or 0
    skip_auto_bonus = (
        prior_approved > 0
        or user_row.bonus_forfeited_at is not None
    )

    # Welcome bonus brackets — admin's range table. Bracket-walk logic is
    # inlined here (not imported from gateway) so the admin service stays
    # decoupled from gateway internals. Kept in lockstep with
    # wallet_service.compute_welcome_bonus by convention.
    if not skip_auto_bonus:
        from packages.common.src.settings_store import (
            get_bool_setting, get_float_setting, get_system_setting,
        )
        welcome_enabled = await get_bool_setting("welcome_bonus_enabled", False)
        if welcome_enabled:
            raw_brackets = await get_system_setting("welcome_bonus_brackets", None)
            brackets: list[dict] = (
                raw_brackets if isinstance(raw_brackets, list) else []
            )
            # Legacy single-rule fallback for any tenant still on the
            # pre-brackets config — synthesise a $0+ catch-all bracket
            # from the old keys so they don't suddenly stop getting
            # bonuses after deploy.
            if not brackets:
                legacy_value = float(
                    await get_float_setting("welcome_bonus_value", 0.0)
                )
                if legacy_value > 0:
                    brackets = [{
                        "min_deposit": 0,
                        "max_deposit": None,
                        "type": (str(await get_system_setting(
                            "welcome_bonus_type", "percentage"
                        ) or "percentage")).strip().lower(),
                        "value": legacy_value,
                        "cap_usd": float(
                            await get_float_setting("welcome_bonus_cap_usd", 0.0)
                        ),
                    }]

            simple_amount = Decimal("0")
            simple_label = ""
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
                if deposit.amount < min_d:
                    continue
                if max_d is not None and deposit.amount > max_d:
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
                    simple_amount = (
                        deposit.amount * value / Decimal("100")
                    ).quantize(Decimal("0.01"))
                    range_label = f"${min_d}+" if max_d is None else f"${min_d} – ${max_d}"
                    simple_label = f"Welcome bonus {range_label} ({value}% of deposit)"
                else:
                    simple_amount = value.quantize(Decimal("0.01"))
                    range_label = f"${min_d}+" if max_d is None else f"${min_d} – ${max_d}"
                    simple_label = f"Welcome bonus {range_label} (flat ${value})"
                if cap > 0 and simple_amount > cap:
                    simple_amount = cap
                    simple_label += f" — capped at ${cap}"
                break  # first matching bracket wins

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
                    created_by=admin_id,
                ))
                bonus_msg = f" + ${float(simple_amount):.2f} bonus"
                applied_bonuses.append(("Welcome bonus", simple_amount))
                skip_auto_bonus = True  # block tier fallback below

    offers_q = await db.execute(
        select(BonusOffer).where(
            BonusOffer.is_active == True,
            # Matches the broader set wallet_service uses since migration
            # 0057 dropped the legacy bonus_type CHECK constraint; admin
            # can now pick percentage/fixed in the UI and the engine
            # treats them as deposit-time bonuses too.
            BonusOffer.bonus_type.in_(
                ["deposit", "welcome", "percentage", "fixed"]
            ),
            BonusOffer.min_deposit <= deposit.amount,
            # Auto-apply ONLY no-code offers. An offer that has a promo_code
            # is a code-gated EVENT bonus: it must be granted exclusively via
            # the bonus_code path below (only when the user actually entered
            # the matching code), never auto-handed to every qualifying
            # deposit. Without this, an "event" promo offer behaved like a
            # universal welcome bonus.
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

        # Bonus → main_wallet_bonus (NOT main_wallet_balance). Withdrawals
        # only see main_wallet_balance, so bonus is tradeable (via the
        # transfer-to-trading sweep) but never withdrawable.
        user_row.main_wallet_bonus = (user_row.main_wallet_bonus or Decimal("0")) + bonus_amount
        db.add(
            Transaction(
                user_id=deposit.user_id,
                account_id=None,
                type="bonus",
                amount=bonus_amount,
                balance_after=user_row.main_wallet_bonus,
                description=f"Bonus: {offer.name} ({offer.percentage or 0}%)",
                created_by=admin_id,
            )
        )
        bonus_msg = f" + ${float(bonus_amount):.2f} bonus ({offer.name})"
        applied_bonuses.append((offer.name, bonus_amount))

    # ── bonus_code path: auto-resolve on deposit approval ─────────────
    # Earlier flow showed a separate Grant/Deny button pair on the admin
    # deposits page for any deposit whose user typed a bonus_code. That
    # was confusing alongside the deposit Approve/Reject pair (client
    # complained — 2026-05-26), so the buttons were removed and the
    # bonus is decided here instead: match the typed code (case-insensitive)
    # against the active BonusOffer rows, apply percentage/fixed_amount
    # with min/max caps, write Transaction + notification. If no offer
    # matches OR the user is past the first-deposit window, stamp the row
    # as 'denied' so the trader sees a definite outcome.
    if deposit.bonus_code and deposit.bonus_status in (None, "pending"):
        code_clean = deposit.bonus_code.strip()
        code_lower = code_clean.lower()
        # Match against the dedicated promo_code column (added by migration
        # 0072), NOT the offer's display name — admins set a separate
        # human-readable name ("Summer Event") and code ("SUMMER50"), so the
        # trader's typed code only ever matches promo_code. The isnot(None)
        # guard stops a blank code from matching offers that have no code.
        code_offer = (await db.execute(
            select(BonusOffer).where(
                func.lower(BonusOffer.promo_code) == code_lower,
                BonusOffer.promo_code.isnot(None),
                BonusOffer.is_active == True,
            ).limit(1)
        )).scalar_one_or_none()

        # Did the bracket-based welcome bonus already land on THIS deposit?
        # If so we suppress the "code not recognised" notification — the
        # user already got a bonus, no point confusing them with a decline.
        welcome_already_granted = len(applied_bonuses) > 0

        denial_reason: str | None = None
        # notify_user: whether to push a "Bonus code declined" bell. We
        # silence it for the unknown-code case when a welcome bonus was
        # already applied (client request 2026-05-28 — that notification
        # was confusing users who DID receive a bonus).
        notify_user = True
        bonus_amount = Decimal("0")

        # ── Gates ─────────────────────────────────────────────────────────
        # IMPORTANT: a code-gated EVENT bonus (a matched offer with a promo
        # code) is intentionally NOT first-deposit-only — it applies to ANY
        # deposit inside the offer's active window. That's the whole point of
        # an event/promo code vs. the automatic first-deposit welcome bonus.
        # So the prior-deposit gate is applied ONLY when the typed code did
        # NOT match a real offer (legacy "unknown code → first deposit only"
        # messaging for a repeat depositor). A matched event offer skips it.
        if code_offer is None:
            if prior_approved > 0:
                denial_reason = "This bonus is applicable for your first deposit only."
            else:
                denial_reason = f"Code '{code_clean}' is not a recognised promo."
                if welcome_already_granted:
                    notify_user = False  # user got the welcome bonus anyway
        elif user_row.bonus_forfeited_at is not None:
            denial_reason = (
                "Bonus was forfeited on a prior withdrawal — it can't be "
                "granted again."
            )
        # ── Code-specific gates ──────────────────────────────────────────
        elif code_offer.starts_at and code_offer.starts_at > now:
            denial_reason = f"Code '{code_clean}' is not active yet."
        elif code_offer.expires_at and code_offer.expires_at < now:
            denial_reason = f"Code '{code_clean}' has expired."
        elif deposit.amount < (code_offer.min_deposit or Decimal("0")):
            denial_reason = (
                f"Minimum deposit for code '{code_clean}' is "
                f"${float(code_offer.min_deposit or 0):.2f}."
            )
        elif code_offer.max_deposit is not None and deposit.amount > code_offer.max_deposit:
            denial_reason = (
                f"Maximum deposit for code '{code_clean}' is "
                f"${float(code_offer.max_deposit):.2f}."
            )
        else:
            if code_offer.percentage and code_offer.percentage > 0:
                bonus_amount = (deposit.amount * code_offer.percentage / Decimal("100"))
            elif code_offer.fixed_amount and code_offer.fixed_amount > 0:
                bonus_amount = Decimal(str(code_offer.fixed_amount))
            else:
                denial_reason = "Bonus offer has no percentage or fixed amount configured."
            if code_offer.max_bonus and bonus_amount > code_offer.max_bonus:
                bonus_amount = Decimal(str(code_offer.max_bonus))

        if denial_reason is None and bonus_amount > 0:
            user_row.main_wallet_bonus = (
                user_row.main_wallet_bonus or Decimal("0")
            ) + bonus_amount
            db.add(Transaction(
                user_id=deposit.user_id,
                account_id=None,
                type="bonus",
                amount=bonus_amount,
                balance_after=user_row.main_wallet_bonus,
                reference_id=deposit.id,
                description=(
                    f"Bonus code {code_clean} — {code_offer.name} "
                    f"(${float(bonus_amount):.2f})"
                ),
                created_by=admin_id,
            ))
            deposit.bonus_amount = bonus_amount
            deposit.bonus_status = "granted"
            deposit.bonus_decided_by = admin_id
            deposit.bonus_decided_at = now.replace(tzinfo=timezone.utc) if now.tzinfo is None else now
            bonus_msg += f" + ${float(bonus_amount):.2f} bonus ({code_clean})"
            applied_bonuses.append((code_clean, bonus_amount))
        else:
            deposit.bonus_status = "denied"
            deposit.bonus_decided_by = admin_id
            deposit.bonus_decided_at = now.replace(tzinfo=timezone.utc) if now.tzinfo is None else now
            if notify_user:
                try:
                    await create_notification(
                        db, deposit.user_id,
                        title="Bonus code declined",
                        message=denial_reason or "Bonus code could not be applied.",
                        notif_type="warning", action_url="/wallet",
                    )
                except Exception:
                    pass

    # Note: user-level referral commission used to fire here on first
    # deposit. The policy changed (per client) — it's now a FLAT amount
    # paid by trading_service.close_position once the referred user
    # completes the qualifying trade count, not at deposit time.

    # IB per-referral bounty — flat tier-scaled payout to the IB upline
    # of the referred user, fired on their first approved deposit.
    # Wrapped in a SAVEPOINT so any failure inside rolls back ONLY the
    # bounty writes; the parent deposit-approval transaction stays
    # clean. Plain try/except wasn't enough — a flushed-then-failed
    # insert leaves the session in a poisoned state and the next
    # operation 500s (root cause of the Close-All 500s and the
    # 'cannot approve subsequent deposits' bug).
    try:
        from sqlalchemy import select as _sel, func as _func
        from packages.common.src.models import (
            User as _U, Deposit as _D, Referral as _R, IBProfile as _IB,
            SystemSetting as _SS,
        )
        import json as _json
        async with db.begin_nested():
            count2 = (await db.execute(
                _sel(_func.count()).select_from(_D).where(
                    _D.user_id == deposit.user_id,
                    _D.status.in_(["approved", "auto_approved"]),
                )
            )).scalar() or 0
            if count2 == 1:
                r2 = (await db.execute(
                    _sel(_R).where(_R.referred_id == deposit.user_id).limit(1)
                )).scalar_one_or_none()
                if r2 is not None and r2.ib_profile_id is not None:
                    ib2 = (await db.execute(
                        _sel(_IB).where(_IB.id == r2.ib_profile_id)
                    )).scalar_one_or_none()
                    if ib2 is not None and ib2.is_active:
                        tiers_row = (await db.execute(
                            _sel(_SS).where(_SS.key == "ib_commission_tiers")
                        )).scalar_one_or_none()
                        tiers: list = []
                        if tiers_row and tiers_row.value:
                            raw = tiers_row.value
                            if isinstance(raw, str):
                                try:
                                    raw = _json.loads(raw)
                                except Exception:
                                    raw = []
                            if isinstance(raw, list):
                                tiers = raw
                        active_n2 = (await db.execute(
                            _sel(_func.count()).select_from(_R).where(_R.ib_profile_id == ib2.id)
                        )).scalar() or 0
                        chosen = None
                        for t in tiers:
                            lo = int(t.get("min_referrals") or 0)
                            hi = t.get("max_referrals")
                            hi_v = int(hi) if hi is not None else None
                            if active_n2 >= lo and (hi_v is None or active_n2 <= hi_v):
                                chosen = t
                                break
                        if chosen is not None:
                            try:
                                bounty = Decimal(str(chosen.get("per_referral_bounty") or 0)).quantize(Decimal("0.01"))
                            except Exception:
                                bounty = Decimal("0")
                            if bounty > 0:
                                ib_user = (await db.execute(
                                    _sel(_U).where(_U.id == ib2.user_id)
                                )).scalar_one_or_none()
                                if ib_user is not None:
                                    ib_user.main_wallet_balance = (
                                        Decimal(str(ib_user.main_wallet_balance or 0)) + bounty
                                    )
                                    db.add(Transaction(
                                        user_id=ib_user.id,
                                        type="ib_referral_bounty",
                                        amount=bounty,
                                        balance_after=ib_user.main_wallet_balance,
                                        reference_id=deposit.id,
                                        description=(
                                            f"IB referral bounty — {chosen.get('label')} tier "
                                            f"(${float(bounty):.2f}) for first deposit by {deposit.user_id}"
                                        ),
                                        created_by=admin_id,
                                    ))
    except Exception:
        pass

    await write_audit_log(
        db, admin_id, "approve_deposit", "deposit", deposit_id,
        new_values={"amount": str(deposit.amount), "status": "approved"},
        ip_address=ip_address,
    )
    await create_notification(
        db,
        deposit.user_id,
        title="Deposit approved",
        message=(
            f"Your deposit of ${float(deposit.amount):,.2f} was approved and added to your main wallet.{bonus_msg}"
        ),
        notif_type="deposit",
        action_url="/wallet",
        commit=False,
    )
    if approval_request_id is not None:
        await mark_executed(db, request_id=approval_request_id)
    await db.commit()
    # Email — fire-and-forget after commit so SMTP latency doesn't delay the
    # admin's response and a delivery failure can't roll back the approval.
    try:
        from packages.common.src.smtp_mail import (
            send_email, smtp_configured, fire_and_forget,
        )
        from packages.common.src.email_templates import (
            render_deposit_confirmed, render_bonus_credited,
        )
        from packages.common.src.config import get_settings as _get_settings
        if smtp_configured() and user_row.email:
            app_url = (_get_settings().TRADER_APP_URL or "https://trade.swisdex.com")
            subject, html, text = render_deposit_confirmed(
                first_name=user_row.first_name,
                amount=deposit.amount,
                currency="USD",
                method=deposit.method or "Manual",
                reference=str(deposit.id),
                new_balance=user_row.main_wallet_balance,
                trader_app_url=app_url,
            )
            fire_and_forget(send_email(user_row.email, subject, html, text=text, category="account"))
            for offer_name, bonus_amount in applied_bonuses:
                bsubject, bhtml, btext = render_bonus_credited(
                    first_name=user_row.first_name,
                    bonus_amount=bonus_amount,
                    bonus_label=offer_name,
                    currency="USD",
                    new_bonus_balance=user_row.main_wallet_balance,
                    trader_app_url=app_url,
                )
                # Bonus credit pings come from voucher@, the deposit
                # confirmation above came from account@ — same approval
                # but two distinct emails to the user.
                fire_and_forget(send_email(user_row.email, bsubject, bhtml, text=btext, category="voucher"))
    except Exception as _e:
        # Logger isn't always imported at module top here; deferred lookup.
        import logging as _logging
        _logging.getLogger("admin.deposit").warning("deposit email failed: %s", _e)
    return {"message": f"Deposit approved successfully{bonus_msg}"}


async def reject_deposit(
    deposit_id: uuid.UUID, reason: str | None,
    admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
) -> dict:
    result = await db.execute(select(Deposit).where(Deposit.id == deposit_id))
    deposit = result.scalar_one_or_none()
    if not deposit:
        raise HTTPException(status_code=404, detail="Deposit not found")
    if deposit.status != "pending":
        raise HTTPException(status_code=400, detail="Deposit is not pending")

    deposit.status = "rejected"
    deposit.rejection_reason = reason
    deposit.approved_by = admin_id
    deposit.approved_at = datetime.utcnow()

    # Rejected deposit → any pending bonus_code request is implicitly
    # denied, otherwise the row sits forever with a "pending" bonus pill
    # even though no money will arrive (the Grant/Deny buttons were
    # removed in the 2026-05-26 UX cleanup).
    if deposit.bonus_code and deposit.bonus_status in (None, "pending"):
        deposit.bonus_status = "denied"
        deposit.bonus_decided_by = admin_id
        deposit.bonus_decided_at = datetime.now(timezone.utc)

    await write_audit_log(
        db, admin_id, "reject_deposit", "deposit", deposit_id,
        new_values={"status": "rejected", "reason": reason},
        ip_address=ip_address,
    )
    reason_str = (reason or "").strip()
    extra = f" Reason: {reason_str}" if reason_str else ""
    await create_notification(
        db,
        deposit.user_id,
        title="Deposit not approved",
        message=f"Your deposit request of ${float(deposit.amount):,.2f} was not approved.{extra}",
        notif_type="deposit",
        action_url="/wallet",
        commit=False,
    )
    await db.commit()
    return {"message": "Deposit rejected"}


async def approve_withdrawal(
    withdrawal_id: uuid.UUID, admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
    approval_request_id: uuid.UUID | None = None,
) -> dict:
    # Lock the withdrawal row FOR UPDATE so two admins (or one
    # double-click) can't both pass the status==pending check and
    # debit the user twice (audit finding C3).
    result = await db.execute(
        select(Withdrawal).where(Withdrawal.id == withdrawal_id).with_for_update()
    )
    withdrawal = result.scalar_one_or_none()
    if not withdrawal:
        raise HTTPException(status_code=404, detail="Withdrawal not found")
    if withdrawal.status != "pending":
        raise HTTPException(status_code=400, detail="Withdrawal is not pending")

    # ── Dual-approval gate (opt-in, client 2026-06-20): same as deposits, the
    # forced two-admin sign-off deadlocked single-admin setups, so it's now
    # off by default and toggled via withdrawal_dual_approval_required. ──
    from .approval_service import request_or_execute, mark_executed
    from packages.common.src.settings_store import get_bool_setting, get_float_setting
    # Same as deposits: dual approval fires when the strict flag is on OR the
    # amount is at/above the admin-set limit (withdrawal_dual_approval_min_usd;
    # 0 = no limit). Large withdrawals get a second super-admin sign-off.
    _wd_dual_required = await get_bool_setting("withdrawal_dual_approval_required", False)
    _wd_dual_min = Decimal(str(await get_float_setting("withdrawal_dual_approval_min_usd", 0.0)))
    _wd_amt = Decimal(str(withdrawal.amount or 0))
    _wd_needs_dual = _wd_dual_required or (_wd_dual_min > 0 and _wd_amt >= _wd_dual_min)
    if approval_request_id is not None:
        _ar = (await db.execute(
            text("SELECT status, action, target_id FROM admin_approval_requests WHERE id = :rid FOR UPDATE"),
            {"rid": str(approval_request_id)},
        )).mappings().first()
        if not _ar or _ar["status"] != "approved":
            raise HTTPException(status_code=409, detail="Approval not in 'approved' state")
        if _ar["action"] != "withdrawal_approve" or str(_ar["target_id"]) != str(withdrawal_id):
            raise HTTPException(status_code=409, detail="Approval does not match this withdrawal")
    elif _wd_needs_dual:
        await request_or_execute(
            db, action="withdrawal_approve", target_type="withdrawal",
            target_id=withdrawal_id, amount=Decimal(str(withdrawal.amount or 0)),
            payload={"amount": str(withdrawal.amount or 0)},
            requested_by=admin_id, always=True,
        )
        # raises ApprovalRequired (202) — unreachable below.
    # else: single-admin direct approval → fall through and pay out now.

    if withdrawal.account_id:
        # Lock the trading account so the balance check + debit are
        # serialized against concurrent trades / other withdrawals.
        acc_q = await db.execute(
            select(TradingAccount).where(TradingAccount.id == withdrawal.account_id).with_for_update()
        )
        account = acc_q.scalar_one_or_none()
        if account:
            if (account.balance or Decimal("0")) < withdrawal.amount:
                raise HTTPException(status_code=400, detail="Insufficient account balance")
            account.balance = (account.balance or Decimal("0")) - withdrawal.amount
            account.equity = account.balance + (account.credit or Decimal("0"))
            account.free_margin = account.equity - (account.margin_used or Decimal("0"))

            txn = Transaction(
                user_id=withdrawal.user_id,
                account_id=account.id,
                type="withdrawal",
                amount=-withdrawal.amount,
                balance_after=account.balance,
                reference_id=withdrawal.id,
                description=f"Withdrawal approved - {withdrawal.method or 'manual'}",
                created_by=admin_id,
            )
            db.add(txn)
    else:
        uw = await db.execute(
            select(User).where(User.id == withdrawal.user_id).with_for_update()
        )
        user_row = uw.scalar_one_or_none()
        if not user_row:
            raise HTTPException(status_code=400, detail="User not found")
        main_bal = user_row.main_wallet_balance or Decimal("0")
        if main_bal < withdrawal.amount:
            raise HTTPException(status_code=400, detail="Insufficient main wallet balance")
        user_row.main_wallet_balance = main_bal - withdrawal.amount
        db.add(
            Transaction(
                user_id=withdrawal.user_id,
                account_id=None,
                type="withdrawal",
                amount=-withdrawal.amount,
                balance_after=user_row.main_wallet_balance,
                reference_id=withdrawal.id,
                description=f"Withdrawal approved (main wallet) - {withdrawal.method or 'manual'}",
                created_by=admin_id,
            )
        )

    withdrawal.status = "approved"
    withdrawal.approved_by = admin_id
    withdrawal.approved_at = datetime.utcnow()

    # ── Bonus forfeiture (migration 0056 contract) ─────────────────────
    # First approved withdrawal for this user wipes ALL bonus credit
    # everywhere: users.main_wallet_bonus AND every trading_accounts
    # .credit row owned by the user. Sets users.bonus_forfeited_at so
    # future deposits don't re-grant a welcome bonus (no farming via
    # withdraw-then-redeposit cycles).
    forfeit_user = await db.get(User, withdrawal.user_id)
    if forfeit_user is not None and forfeit_user.bonus_forfeited_at is None:
        forfeited_main = Decimal(str(forfeit_user.main_wallet_bonus or 0))
        # Forfeit ONLY the bonus portion of each account's credit. Insurance
        # claim payouts also land in account.credit but they're EARNED money
        # (the user paid the insurance fee) — they must survive a withdrawal
        # (client report 2026-05-28: insurance was being wiped too). We size
        # the protected amount per account as the lifetime insurance_payout
        # credited there, clamped to the current credit (in case some was
        # already traded away).
        accts_q = await db.execute(
            select(TradingAccount).where(TradingAccount.user_id == withdrawal.user_id)
        )
        forfeited_account_credit = Decimal("0")
        for acc in accts_q.scalars().all():
            credit = Decimal(str(acc.credit or 0))
            if credit <= 0:
                continue
            insurance_credit = Decimal(str((await db.execute(
                select(func.coalesce(func.sum(Transaction.amount), 0)).where(
                    Transaction.account_id == acc.id,
                    Transaction.type == "insurance_payout",
                )
            )).scalar() or 0))
            # Keep the insurance portion (up to whatever credit remains);
            # forfeit the rest (welcome bonus / admin credit).
            protected = min(credit, max(Decimal("0"), insurance_credit))
            forfeit_here = credit - protected
            if forfeit_here > 0:
                forfeited_account_credit += forfeit_here
                acc.credit = protected
                acc.equity = (acc.balance or Decimal("0")) + protected
                acc.free_margin = acc.equity - (acc.margin_used or Decimal("0"))

        total_forfeit = forfeited_main + forfeited_account_credit
        if total_forfeit > 0:
            db.add(Transaction(
                user_id=withdrawal.user_id,
                account_id=None,
                type="bonus_forfeited",
                amount=-total_forfeit,
                balance_after=forfeit_user.main_wallet_balance,
                reference_id=withdrawal.id,
                description=(
                    "Welcome bonus forfeited on first withdrawal "
                    f"(main wallet bonus ${float(forfeited_main):.2f} + "
                    f"account credit ${float(forfeited_account_credit):.2f}). "
                    "Insurance payouts retained."
                ),
                created_by=admin_id,
            ))
        forfeit_user.main_wallet_bonus = Decimal("0")
        forfeit_user.bonus_forfeited_at = datetime.utcnow()

    await write_audit_log(
        db, admin_id, "approve_withdrawal", "withdrawal", withdrawal_id,
        new_values={"amount": float(withdrawal.amount), "status": "approved"},
        ip_address=ip_address,
    )
    await create_notification(
        db,
        withdrawal.user_id,
        title="Withdrawal approved",
        message=(
            f"Your withdrawal of ${float(withdrawal.amount):,.2f} via "
            f"{withdrawal.method or 'manual'} has been approved and will be processed."
        ),
        notif_type="withdrawal",
        action_url="/wallet",
        commit=False,
    )
    if approval_request_id is not None:
        await mark_executed(db, request_id=approval_request_id)
    await db.commit()
    # Approval email — fire-and-forget.
    try:
        from packages.common.src.smtp_mail import (
            send_email, smtp_configured, fire_and_forget,
        )
        from packages.common.src.email_templates import render_withdrawal_approved
        from packages.common.src.config import get_settings as _gs
        u = (await db.execute(select(User).where(User.id == withdrawal.user_id))).scalar_one_or_none()
        if smtp_configured() and u and u.email:
            destination_str: str | None = None
            if withdrawal.crypto_address:
                ca = str(withdrawal.crypto_address)
                destination_str = f"{ca[:6]}…{ca[-4:]}" if len(ca) > 12 else ca
            elif withdrawal.bank_details and isinstance(withdrawal.bank_details, dict):
                acct = withdrawal.bank_details.get("account_number") or ""
                if acct:
                    destination_str = f"Bank ****{str(acct)[-4:]}"
            subject, html, text = render_withdrawal_approved(
                first_name=u.first_name,
                amount=withdrawal.amount,
                currency="USD",
                method=withdrawal.method or "Manual",
                destination=destination_str,
                request_id=str(withdrawal.id),
                trader_app_url=(_gs().TRADER_APP_URL or "https://trade.swisdex.com"),
            )
            fire_and_forget(send_email(u.email, subject, html, text=text, category="account"))
    except Exception as _e:
        import logging as _logging
        _logging.getLogger("admin.withdraw").warning("withdrawal approve email failed: %s", _e)
    return {"message": "Withdrawal approved successfully"}


async def reject_withdrawal(
    withdrawal_id: uuid.UUID, reason: str | None,
    admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
) -> dict:
    result = await db.execute(select(Withdrawal).where(Withdrawal.id == withdrawal_id))
    withdrawal = result.scalar_one_or_none()
    if not withdrawal:
        raise HTTPException(status_code=404, detail="Withdrawal not found")
    if withdrawal.status != "pending":
        raise HTTPException(status_code=400, detail="Withdrawal is not pending")

    withdrawal.status = "rejected"
    withdrawal.rejection_reason = reason
    withdrawal.approved_by = admin_id
    withdrawal.approved_at = datetime.utcnow()

    await write_audit_log(
        db, admin_id, "reject_withdrawal", "withdrawal", withdrawal_id,
        new_values={"status": "rejected", "reason": reason},
        ip_address=ip_address,
    )
    reason_str = (reason or "").strip()
    extra = f" Reason: {reason_str}" if reason_str else ""
    await create_notification(
        db,
        withdrawal.user_id,
        title="Withdrawal not approved",
        message=f"Your withdrawal request of ${float(withdrawal.amount):,.2f} was not approved.{extra}",
        notif_type="withdrawal",
        action_url="/wallet",
        commit=False,
    )
    await db.commit()
    # Rejection email — fire-and-forget.
    try:
        from packages.common.src.smtp_mail import (
            send_email, smtp_configured, fire_and_forget,
        )
        from packages.common.src.email_templates import render_withdrawal_rejected
        from packages.common.src.config import get_settings as _gs
        u = (await db.execute(select(User).where(User.id == withdrawal.user_id))).scalar_one_or_none()
        if smtp_configured() and u and u.email:
            subject, html, text = render_withdrawal_rejected(
                first_name=u.first_name,
                amount=withdrawal.amount,
                currency="USD",
                reason=reason_str or None,
                request_id=str(withdrawal.id),
                trader_app_url=(_gs().TRADER_APP_URL or "https://trade.swisdex.com"),
            )
            fire_and_forget(send_email(u.email, subject, html, text=text, category="account"))
    except Exception as _e:
        import logging as _logging
        _logging.getLogger("admin.withdraw").warning("withdrawal reject email failed: %s", _e)
    return {"message": "Withdrawal rejected"}


async def download_deposit_screenshot(deposit_id: uuid.UUID, db: AsyncSession):
    """Serve manual deposit proof file (same filesystem path gateway wrote)."""
    result = await db.execute(select(Deposit).where(Deposit.id == deposit_id))
    deposit = result.scalar_one_or_none()
    if not deposit or not deposit.screenshot_url:
        raise HTTPException(status_code=404, detail="Screenshot not found")
    p = Path(deposit.screenshot_url)
    if not p.is_file():
        raise HTTPException(status_code=404, detail="File missing on server")
    return FileResponse(str(p), filename=p.name, media_type="application/octet-stream")


async def download_withdrawal_payout_qr(withdrawal_id: uuid.UUID, db: AsyncSession):
    """User-uploaded QR / payout image for manual withdrawals."""
    result = await db.execute(select(Withdrawal).where(Withdrawal.id == withdrawal_id))
    w = result.scalar_one_or_none()
    if not w or not w.bank_details:
        raise HTTPException(status_code=404, detail="Attachment not found")
    raw = w.bank_details.get("user_payout_qr_path") if isinstance(w.bank_details, dict) else None
    if not raw:
        raise HTTPException(status_code=404, detail="No payout QR on file")
    p = Path(str(raw))
    if not p.is_file():
        raise HTTPException(status_code=404, detail="File missing on server")
    return FileResponse(str(p), filename=p.name, media_type="application/octet-stream")


# ─── Manual bonus grant / deny on a deposit ──────────────────────────────
# Trader optionally types a promo code at deposit time (bonus_code).
# Deposits with a code arrive as bonus_status='pending' and skip the
# existing auto-apply BonusOffer loop — admin reviews each one here and
# either credits a custom amount or rejects with a reason.

async def grant_deposit_bonus(
    deposit_id: uuid.UUID,
    amount: Decimal,
    description: str | None,
    admin_id: uuid.UUID,
    ip_address: str | None,
    db: AsyncSession,
) -> dict:
    """Credit a custom bonus to the trader's main wallet. Idempotency:
    a deposit can only be granted once — re-running returns 409 so the
    admin doesn't double-pay on a refresh / double-click."""
    if amount is None or Decimal(str(amount)) <= 0:
        raise HTTPException(status_code=400, detail="Bonus amount must be greater than zero")

    deposit = (await db.execute(
        select(Deposit).where(Deposit.id == deposit_id)
    )).scalar_one_or_none()
    if not deposit:
        raise HTTPException(status_code=404, detail="Deposit not found")
    if not deposit.bonus_code:
        raise HTTPException(
            status_code=400,
            detail="This deposit did not request a bonus — no code on file",
        )
    if deposit.bonus_status not in ("pending", None):
        raise HTTPException(
            status_code=409,
            detail=f"Bonus already {deposit.bonus_status} for this deposit",
        )

    user = (await db.execute(
        select(User).where(User.id == deposit.user_id)
    )).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    bonus_amount = Decimal(str(amount))
    user.main_wallet_balance = (user.main_wallet_balance or Decimal("0")) + bonus_amount

    desc = (description or "").strip() or (
        f"Bonus credited for deposit {deposit.id} (code {deposit.bonus_code})"
    )
    db.add(Transaction(
        user_id=deposit.user_id,
        account_id=None,
        type="bonus",
        amount=bonus_amount,
        balance_after=user.main_wallet_balance,
        reference_id=deposit.id,
        description=desc,
    ))

    deposit.bonus_status = "granted"
    deposit.bonus_amount = bonus_amount
    deposit.bonus_decided_by = admin_id
    deposit.bonus_decided_at = datetime.now(timezone.utc)

    try:
        await create_notification(
            db, deposit.user_id,
            title=f"Bonus credited — ${float(bonus_amount):,.2f}",
            message=(
                f"Your bonus request with code {deposit.bonus_code} on deposit "
                f"${float(deposit.amount):,.2f} was approved. ${float(bonus_amount):,.2f} "
                "has been credited to your main wallet."
            ),
            notif_type="bonus", action_url="/wallet",
        )
    except Exception:
        pass

    await write_audit_log(
        db, admin_id, "grant_deposit_bonus", "deposit", deposit_id,
        new_values={
            "bonus_code": deposit.bonus_code,
            "bonus_amount": float(bonus_amount),
            "description": desc,
        },
        ip_address=ip_address,
    )
    await db.commit()

    return {
        "message": "Bonus granted",
        "deposit_id": str(deposit_id),
        "bonus_amount": float(bonus_amount),
        "main_wallet_balance": float(user.main_wallet_balance),
    }


async def deny_deposit_bonus(
    deposit_id: uuid.UUID,
    reason: str | None,
    admin_id: uuid.UUID,
    ip_address: str | None,
    db: AsyncSession,
) -> dict:
    """Mark the bonus request denied — no money moves. Sends an in-app
    notification with the reason; underlying deposit status is untouched
    so the trader still sees their actual deposit settle separately."""
    deposit = (await db.execute(
        select(Deposit).where(Deposit.id == deposit_id)
    )).scalar_one_or_none()
    if not deposit:
        raise HTTPException(status_code=404, detail="Deposit not found")
    if not deposit.bonus_code:
        raise HTTPException(
            status_code=400,
            detail="This deposit did not request a bonus",
        )
    if deposit.bonus_status not in ("pending", None):
        raise HTTPException(
            status_code=409,
            detail=f"Bonus already {deposit.bonus_status} for this deposit",
        )

    reason_clean = (reason or "").strip()[:500] or "Denied by admin"
    deposit.bonus_status = "denied"
    deposit.bonus_amount = None
    deposit.bonus_decided_by = admin_id
    deposit.bonus_decided_at = datetime.now(timezone.utc)

    try:
        await create_notification(
            db, deposit.user_id,
            title="Bonus request denied",
            message=(
                f"Your bonus request with code {deposit.bonus_code} on deposit "
                f"${float(deposit.amount):,.2f} was not approved. Reason: {reason_clean}"
            ),
            notif_type="bonus", action_url="/wallet",
        )
    except Exception:
        pass

    await write_audit_log(
        db, admin_id, "deny_deposit_bonus", "deposit", deposit_id,
        new_values={"bonus_code": deposit.bonus_code, "reason": reason_clean},
        ip_address=ip_address,
    )
    await db.commit()

    return {"message": "Bonus denied", "deposit_id": str(deposit_id), "reason": reason_clean}
