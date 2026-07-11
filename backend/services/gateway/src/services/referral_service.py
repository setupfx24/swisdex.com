"""Personal referral commission — distinct from IB MLM.

Every user has a unique ``referral_code`` (User.referral_code). When a
new signup uses that code via ``?ref=``, we set the new user's
``referred_by_user_id``. On the user's FIRST approved deposit, the
referrer is paid a flat admin-controlled percentage of the deposit,
credited to their main wallet.

This runs independently of the IB MLM commission tree — an IB still
earns trade-based commissions through the existing ib_engine; this
gives every user a smaller, simpler deposit-based incentive.
"""
from __future__ import annotations

import logging
import secrets
from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.models import (
    User, Deposit, Transaction, IBProfile, Referral, TradeHistory, TradingAccount,
)
from packages.common.src.settings_store import (
    get_float_setting, get_int_setting, get_system_setting, get_bool_setting,
)

logger = logging.getLogger("referral_service")


REFERRAL_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
REFERRAL_CODE_LEN = 8


def generate_referral_code() -> str:
    """Generate a fresh referral code. The alphabet excludes 0/O/1/I so
    users typing or messaging the code don't trip on look-alikes."""
    return "".join(secrets.choice(REFERRAL_CODE_ALPHABET) for _ in range(REFERRAL_CODE_LEN))


async def ensure_referral_code(db: AsyncSession, user: User) -> str:
    """Idempotently fill `user.referral_code` if missing. Retries a few
    times on the rare collision (8 chars of 32-symbol alphabet = ~10^12
    space; collisions are astronomically unlikely but we still loop)."""
    if user.referral_code:
        return user.referral_code
    for _ in range(8):
        code = generate_referral_code()
        existing = (await db.execute(
            select(User.id).where(User.referral_code == code)
        )).scalar_one_or_none()
        if existing is None:
            user.referral_code = code
            return code
    # Astronomically rare: extend the code and try once more.
    user.referral_code = generate_referral_code() + generate_referral_code()[:4]
    return user.referral_code


async def attach_referrer_by_code(
    db: AsyncSession, new_user_id: UUID, code: str
) -> Optional[UUID]:
    """Look up a referrer by user-level code and store the link on the
    new user. Returns the referrer's user_id if linked, else None.

    A no-op if:
      - code is empty or unrecognised
      - the referrer would be the user themselves
      - the user already has a referrer set
    """
    code = (code or "").strip()
    if not code:
        return None

    referrer = (await db.execute(
        select(User).where(User.referral_code == code).limit(1)
    )).scalar_one_or_none()
    if referrer is None or referrer.id == new_user_id:
        return None

    new_user = (await db.execute(
        select(User).where(User.id == new_user_id).with_for_update()
    )).scalar_one_or_none()
    if new_user is None:
        return None
    if new_user.referred_by_user_id is not None:
        return new_user.referred_by_user_id

    new_user.referred_by_user_id = referrer.id
    return referrer.id


async def maybe_pay_referral_on_first_deposit(
    db: AsyncSession, user_id: UUID, deposit: Deposit
) -> Optional[dict]:
    """Legacy hook kept as a no-op for callers that still import it.

    Referral commission used to fire on the referred user's first
    approved deposit; the client changed the model to a fixed amount
    paid AFTER the referred user completes >= 3 trades. New entry
    point is ``maybe_pay_referral_after_trades`` below, called from
    trading_service.close_position when a trade is booked.
    """
    return None


async def _is_funded(db: AsyncSession, user_id: UUID) -> bool:
    """A referred user counts as funded if they have >= 1 approved deposit OR an
    admin manual credit (Transaction type 'adjustment', positive). Client
    2026-06-30: admin credits count alongside real deposits for referral
    qualification (same rule as the IB pool)."""
    dep = (await db.execute(
        select(func.count()).select_from(Deposit).where(
            Deposit.user_id == user_id,
            Deposit.status.in_(["approved", "auto_approved"]),
        )
    )).scalar() or 0
    if dep > 0:
        return True
    cred = (await db.execute(
        select(func.count()).select_from(Transaction).where(
            Transaction.user_id == user_id,
            Transaction.type == "adjustment",
            Transaction.amount > 0,
        )
    )).scalar() or 0
    return cred > 0


async def maybe_pay_referral_after_trades(
    db: AsyncSession, user_id: UUID
) -> Optional[dict]:
    """Mark a referred user as claimable when they cross the gates
    (KYC + funded + qualifying trade count). After 2026-05-26 this no
    longer credits the referrer's wallet directly — the referrer must
    press Claim on the /referral page (see `claim_referral_bounty`
    below). This function only stamps `referral_qualified_at` so the
    dashboard can render the row as a "Claim" entry.

    Two gates make sure we never double-mark:
      1. ``users.referral_qualified_at`` must still be NULL.
      2. The user must have a referrer set (`referred_by_user_id`).

    Caller writes a TradeHistory row first (this helper counts
    history rows to decide), then invokes this. Best-effort: any
    error inside is swallowed so a referral hiccup never blocks
    the trade close itself.
    """
    user = (await db.execute(
        select(User).where(User.id == user_id).with_for_update()
    )).scalar_one_or_none()
    if user is None or user.referred_by_user_id is None:
        return None
    if user.referral_qualified_at is not None:
        return None  # already paid

    # ── Activation gate #1: KYC verification ──────────────────────────
    # Marketing copy on /products/referral promises "Your friend ...
    # completes KYC verification, and funds their account" before any
    # bounty is paid. Enforce both here so payouts match the public
    # contract.
    kyc_required = await get_bool_setting("referral_requires_kyc", True)
    if kyc_required and (user.kyc_status or "pending").lower() != "approved":
        return None

    # ── Activation gate #2: at least one approved deposit ─────────────
    # "Funds their account" = at least one approved / auto_approved
    # deposit. Demo top-ups don't count — they have no Deposit row.
    funded_required = await get_bool_setting("referral_requires_funded", True)
    if funded_required and not await _is_funded(db, user_id):
        return None

    # ── Qualification gate: minimum N closed trades ───────────────────
    # Defaults to 3 to match the trader-page promise. Admin can adjust
    # via system_settings.referral_qualifying_trades without a deploy.
    required = await get_int_setting("referral_qualifying_trades", 3)
    if required <= 0:
        required = 3

    # Count of CLOSED trades. TradeHistory ties to TradingAccount, so
    # we join to user_id. Open positions don't count — spec is
    # 'three trades completed'.
    trade_count = (await db.execute(
        select(func.count())
        .select_from(TradeHistory)
        .join(TradingAccount, TradingAccount.id == TradeHistory.account_id)
        .where(TradingAccount.user_id == user_id)
    )).scalar() or 0
    if trade_count < required:
        return None

    # Manual-claim flow: just mark the row claimable. No wallet credit
    # here — the referrer presses Claim on /referral to sweep the
    # bounty into their referral_commission_balance.
    user.referral_qualified_at = datetime.now(timezone.utc)

    return {
        "referrer_id": str(user.referred_by_user_id),
        "user_id": str(user_id),
        "trades": int(trade_count),
        "status": "claimable",
    }


def _resolve_tier_bounty(tiers_raw, position: int) -> Optional[float]:
    """Pick the bounty for a referrer's Nth qualified referral.
    `position` is 1-indexed (the 1st qualified referral). Returns None
    if no tier matches OR the matched tier's bounty isn't positive."""
    if not isinstance(tiers_raw, list) or not tiers_raw:
        return None
    for row in tiers_raw:
        if not isinstance(row, dict):
            continue
        try:
            lo = int(float(row.get("min_referrals") or 0))
        except (TypeError, ValueError):
            lo = 0
        hi_raw = row.get("max_referrals")
        if hi_raw in (None, "", "null"):
            hi = None
        else:
            try:
                hi = int(float(hi_raw))
            except (TypeError, ValueError):
                hi = None
        try:
            bounty = float(row.get("per_referral_bounty") or 0)
        except (TypeError, ValueError):
            bounty = 0.0
        if position >= lo and (hi is None or position <= hi) and bounty > 0:
            return bounty
    return None


async def _bounty_for_next_claim(
    db: AsyncSession, referrer_id: UUID,
) -> Decimal:
    """Compute the bounty this referrer would earn for claiming ONE
    more referral right now. Walks the tier ladder by counting how
    many referrals they've already CLAIMED (+1 for the new one).
    Falls back to the legacy flat amount if tiers aren't configured."""
    # Personal-referral ladder is SEPARATE from the IB MLM ladder. It uses
    # its own setting key + row shape ({min_referrals, max_referrals,
    # per_referral_bounty}); the IB ladder ({per_lot, min_activations…})
    # never matched this resolver anyway, so referral always fell back to
    # the flat bounty. Reading the dedicated key makes the referral tiers
    # actually work AND keeps the two programs independent.
    tiers_raw = await get_system_setting("referral_tiers", None)
    if isinstance(tiers_raw, list) and tiers_raw:
        claimed_count = (await db.execute(
            select(func.count()).select_from(User).where(
                User.referred_by_user_id == referrer_id,
                User.referral_claimed_at.is_not(None),
            )
        )).scalar() or 0
        position = int(claimed_count) + 1
        b = _resolve_tier_bounty(tiers_raw, position)
        if b is not None:
            return Decimal(str(b)).quantize(Decimal("0.01"))
    flat = await get_float_setting("referral_commission_amount_usd", 5.0)
    return Decimal(str(max(flat, 0))).quantize(Decimal("0.01"))


async def claim_referral_bounty(
    db: AsyncSession, *, referrer_id: UUID, referred_user_id: UUID,
) -> tuple[Optional[Decimal], Optional[str]]:
    """Referrer presses Claim against a specific referred user. Checks
    ownership + state, computes the tier-aware bounty, adds it to the
    referrer's referral_commission_balance, and stamps
    referral_claimed_at on the referred row. Returns (amount, error)."""
    referred = (await db.execute(
        select(User).where(User.id == referred_user_id).with_for_update()
    )).scalar_one_or_none()
    if referred is None:
        return None, "not_found"
    if referred.referred_by_user_id != referrer_id:
        return None, "not_found"
    if referred.referral_qualified_at is None:
        # Self-heal: a qualifying trade may have run maybe_pay_referral_after_
        # trades BEFORE the user crossed the (now satisfied) gates — e.g. they
        # were funded via an admin credit that the old rule ignored, so
        # referral_qualified_at was never stamped. Re-check the live gates and
        # stamp now so the claim isn't permanently stuck (client 2026-06-30).
        kyc_required = await get_bool_setting("referral_requires_kyc", True)
        funded_required = await get_bool_setting("referral_requires_funded", True)
        required_trades = await get_int_setting("referral_qualifying_trades", 3)
        kyc_ok = (not kyc_required) or (referred.kyc_status or "pending").lower() == "approved"
        funded_ok = (not funded_required) or await _is_funded(db, referred_user_id)
        trades_n = (await db.execute(
            select(func.count()).select_from(TradeHistory)
            .join(TradingAccount, TradingAccount.id == TradeHistory.account_id)
            .where(TradingAccount.user_id == referred_user_id)
        )).scalar() or 0
        trades_ok = int(trades_n) >= int(required_trades)
        if kyc_ok and funded_ok and trades_ok:
            referred.referral_qualified_at = datetime.now(timezone.utc)
        else:
            return None, "not_eligible"
    if referred.referral_claimed_at is not None:
        return None, "already_claimed"

    amount = await _bounty_for_next_claim(db, referrer_id)
    if amount <= 0:
        return None, "zero_bounty"

    referrer = (await db.execute(
        select(User).where(User.id == referrer_id).with_for_update()
    )).scalar_one_or_none()
    if referrer is None:
        return None, "referrer_missing"

    referrer.referral_commission_balance = (
        Decimal(str(referrer.referral_commission_balance or 0)) + amount
    )
    referred.referral_claimed_at = datetime.now(timezone.utc)
    # Record a ledger row so the bounty (a) counts toward total_earned and
    # (b) shows up in the /referral commission breakdown, attributed to the
    # referred user by name (client 2026-06-30).
    referred_display = " ".join(
        filter(None, [referred.first_name, referred.last_name])
    ).strip() or (referred.email or "a referral")
    db.add(Transaction(
        user_id=referrer_id,
        type="referral_commission",
        amount=amount,
        balance_after=None,
        description=f"Referral bounty from {referred_display}",
    ))
    return amount, None


async def withdraw_referral_commission(
    db: AsyncSession, *, user_id: UUID,
) -> tuple[Optional[Decimal], Optional[str]]:
    """Sweep the referrer's referral_commission_balance into their
    main_wallet_balance. Records a Transaction row + queues a
    notification. Returns (amount_moved, error)."""
    user = (await db.execute(
        select(User).where(User.id == user_id).with_for_update()
    )).scalar_one_or_none()
    if user is None:
        return None, "user_missing"
    balance = Decimal(str(user.referral_commission_balance or 0))
    if balance <= 0:
        return None, "zero_balance"

    user.referral_commission_balance = Decimal("0")
    user.main_wallet_balance = (
        Decimal(str(user.main_wallet_balance or 0)) + balance
    )
    db.add(Transaction(
        user_id=user.id,
        type="referral_commission",
        amount=balance,
        balance_after=user.main_wallet_balance,
        description=(
            f"Referral commission withdrawn to main wallet "
            f"(${float(balance):.2f})"
        ),
    ))
    return balance, None


async def list_my_referrals(db: AsyncSession, user_id: UUID) -> dict:
    """Per-friend rows for the trader /referral page. Each row carries:
        - referred user's display name + email + trades_count
        - status: pending  (gates not met yet)
                  claimable (qualified, claim button enabled)
                  claimed   (already swept into commission_balance)
        - qualified_at / claimed_at timestamps
    Plus the top-of-page summary fields the dashboard renders:
        - commission_balance: claimed-but-not-yet-withdrawn pool
        - next_bounty: what the user would earn for their NEXT claim
        - required_trades / requires_kyc / requires_funded: gate copy
    """
    me = (await db.execute(
        select(User).where(User.id == user_id)
    )).scalar_one_or_none()
    if me is None:
        return {"items": [], "commission_balance": 0.0, "next_bounty": 0.0}

    rows = (await db.execute(
        select(User).where(User.referred_by_user_id == user_id)
        .order_by(User.created_at.desc())
    )).scalars().all()

    items = []
    did_stamp = False  # set if we lazily qualify any friend below
    # Pull the active gate config ONCE — used both to decide per-row
    # pending reason AND surfaced on the response so the trader page can
    # render an explainer footer.
    required_trades = await get_int_setting("referral_qualifying_trades", 3)
    if required_trades <= 0:
        required_trades = 3
    requires_kyc = await get_bool_setting("referral_requires_kyc", True)
    requires_funded = await get_bool_setting("referral_requires_funded", True)

    for r in rows:
        trade_count = (await db.execute(
            select(func.count())
            .select_from(TradeHistory)
            .join(TradingAccount, TradingAccount.id == TradeHistory.account_id)
            .where(TradingAccount.user_id == r.id)
        )).scalar() or 0

        kyc_ok = (r.kyc_status or "pending").lower() == "approved"

        # Treat the friend as funded if they have an approved deposit OR an
        # admin credit — same gate `maybe_pay_referral_after_trades` uses.
        funded_ok = await _is_funded(db, r.id)

        trades_ok = int(trade_count) >= int(required_trades)

        # Lazy finalization: if every gate is satisfied but the qualification
        # stamp was never written (it normally lands on the friend's next
        # trade-close), stamp it NOW so simply viewing/refreshing the page
        # finalizes the referral — which is exactly what the "refresh shortly"
        # copy promises. No wallet credit happens here; the referrer still
        # presses Claim (manual-claim flow).
        if (
            r.referral_claimed_at is None
            and r.referral_qualified_at is None
            and (kyc_ok or not requires_kyc)
            and (funded_ok or not requires_funded)
            and trades_ok
        ):
            r.referral_qualified_at = datetime.now(timezone.utc)
            did_stamp = True

        if r.referral_claimed_at is not None:
            status = "claimed"
        elif r.referral_qualified_at is not None:
            status = "claimable"
        else:
            status = "pending"

        # Reason text the UI shows in the ACTION column when status is
        # still `pending`. Priority matches the order the engine checks
        # gates so the user is told the FIRST missing thing, not all
        # of them at once. Privacy-safe — generic phrases that don't
        # expose internal flags (we drop "kyc_status" from the payload
        # for the same reason).
        if status == "pending":
            if requires_kyc and not kyc_ok:
                pending_reason = "Friend hasn't completed KYC yet"
            elif requires_funded and not funded_ok:
                pending_reason = "Friend hasn't made their first deposit yet"
            elif not trades_ok:
                remaining = max(0, int(required_trades) - int(trade_count))
                pending_reason = (
                    f"{remaining} trade{'s' if remaining != 1 else ''} to go"
                )
            else:
                # All gates effectively passed — the qualification
                # stamp is just delayed (engine hasn't run yet on a
                # post-trade close). Tell the user to wait.
                pending_reason = "Finalising — refresh shortly"
        else:
            pending_reason = None

        name = " ".join(filter(None, [r.first_name, r.last_name])).strip() or None
        items.append({
            "user_id": str(r.id),
            "name": name,
            "email": r.email,
            "trades": int(trade_count),
            "status": status,
            # Per-row pending reason for the UI — no raw KYC field is
            # surfaced (client privacy: removed the KYC column earlier).
            "pending_reason": pending_reason,
            "qualified_at": r.referral_qualified_at.isoformat() if r.referral_qualified_at else None,
            "claimed_at": r.referral_claimed_at.isoformat() if r.referral_claimed_at else None,
        })

    # Persist any lazy-qualification stamps we made above.
    if did_stamp:
        await db.commit()

    # What the trader would earn for their NEXT claim, given the tier
    # ladder + how many they've already claimed. Computed once here so the
    # UI can show "Claim → $X" without a second roundtrip.
    next_bounty = await _bounty_for_next_claim(db, user_id)

    return {
        "items": items,
        "commission_balance": float(me.referral_commission_balance or 0),
        "next_bounty": float(next_bounty),
        "required_trades": int(required_trades),
        "requires_kyc": bool(requires_kyc),
        "requires_funded": bool(requires_funded),
    }


async def get_my_referral_dashboard(db: AsyncSession, user_id: UUID) -> dict:
    """Stats for the /referral page — every user can see this regardless
    of IB status."""
    user = (await db.execute(
        select(User).where(User.id == user_id)
    )).scalar_one_or_none()
    if user is None:
        return {"referral_code": None, "referrals": 0, "total_earned": 0.0, "commission_pct": 0.0}

    # Generate code lazily if backfill somehow missed this row.
    if not user.referral_code:
        await ensure_referral_code(db, user)
        await db.commit()
        # Re-read because commit may have flushed.
        user = (await db.execute(
            select(User).where(User.id == user_id)
        )).scalar_one_or_none()

    referrals = (await db.execute(
        select(func.count()).select_from(User).where(User.referred_by_user_id == user_id)
    )).scalar() or 0

    total_earned = (await db.execute(
        select(func.coalesce(func.sum(Transaction.amount), 0))
        .where(
            Transaction.user_id == user_id,
            Transaction.type == "referral_commission",
        )
    )).scalar() or 0

    # Per-entry commission breakdown so the trader sees WHERE each chunk came
    # from — direct referral bounty vs AI-Powered-Staking referral — and from
    # which referred user (carried in the transaction description).
    ledger_rows = (await db.execute(
        select(Transaction.amount, Transaction.description, Transaction.created_at)
        .where(
            Transaction.user_id == user_id,
            Transaction.type == "referral_commission",
        )
        .order_by(Transaction.created_at.desc())
        .limit(50)
    )).all()
    commission_ledger = [
        {
            "amount": float(r.amount or 0),
            "description": r.description or "Referral commission",
            "source": "staking" if "staking" in (r.description or "").lower() else "referral",
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in ledger_rows
    ]

    amount_usd = await get_float_setting("referral_commission_amount_usd", 5.0)
    required_trades = await get_int_setting("referral_qualifying_trades", 3)
    # Per-account-type breakdown — the trader page renders this so the
    # user sees what they'd earn for each subscription bracket.
    type_map_raw = await get_system_setting("referral_commission_amounts_usd", None)
    amount_by_type: dict[str, float] = {}
    if isinstance(type_map_raw, dict):
        for k, v in type_map_raw.items():
            try:
                amount_by_type[str(k).lower()] = float(v)
            except (TypeError, ValueError):
                pass

    # Qualified vs pending breakdown — how many of this user's
    # referrals have already triggered a payout vs. how many are
    # still trading toward the threshold.
    qualified = (await db.execute(
        select(func.count()).select_from(User).where(
            User.referred_by_user_id == user_id,
            User.referral_qualified_at.is_not(None),
        )
    )).scalar() or 0

    # Surface the activation gates so the trader page can render
    # "How a Referral Qualifies" with live admin-controlled rules
    # instead of hardcoded copy. Flipping the admin flags off (e.g.
    # disabling the KYC gate for a promo) immediately propagates to
    # the public marketing card.
    kyc_required = await get_bool_setting("referral_requires_kyc", True)
    funded_required = await get_bool_setting("referral_requires_funded", True)

    # Extra income = the promotional PREMIUM this user was paid ABOVE the
    # standard rate via a per-user custom offer (logged in promotional_expenses,
    # e.g. FR referral extra %). Shown as bonus/extra income on the /referral page.
    from packages.common.src.models import PromotionalExpense
    extra_income = float((await db.execute(
        select(func.coalesce(func.sum(PromotionalExpense.amount), 0))
        .where(PromotionalExpense.user_id == user_id)
    )).scalar() or 0)
    extra_rows = (await db.execute(
        select(PromotionalExpense.amount, PromotionalExpense.note, PromotionalExpense.created_at)
        .where(PromotionalExpense.user_id == user_id)
        .order_by(PromotionalExpense.created_at.desc()).limit(50)
    )).all()
    extra_income_ledger = [
        {
            "amount": float(r.amount or 0),
            "note": r.note or "Extra income",
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in extra_rows
    ]
    # The user's EFFECTIVE FR referral % (their custom override if set, else the
    # global) so the page can show the boosted rate they actually earn.
    _g_prin = float(await get_float_setting("fr_referral_principal_pct", 0.0))
    _g_int = float(await get_float_setting("fr_referral_interest_pct", 0.0))
    _eff_prin = (
        float(user.fr_referral_principal_pct_override)
        if user.fr_referral_principal_pct_override is not None else _g_prin
    )
    _eff_int = (
        float(user.fr_referral_interest_pct_override)
        if user.fr_referral_interest_pct_override is not None else _g_int
    )

    return {
        "referral_code": user.referral_code,
        "extra_income": round(extra_income, 2),
        "extra_income_ledger": extra_income_ledger,
        "fr_referral_principal_pct_effective": _eff_prin,
        "fr_referral_interest_pct_effective": _eff_int,
        "referrals": int(referrals),
        "qualified_referrals": int(qualified),
        "pending_referrals": int(max(0, int(referrals) - int(qualified))),
        "total_earned": float(total_earned),
        "amount_per_referral_usd": float(amount_usd),
        "amount_by_account_type": amount_by_type,
        "required_trades": int(required_trades),
        "requires_kyc": bool(kyc_required),
        "requires_funded_account": bool(funded_required),
        # Kept for backward compat with any older client build that
        # still reads `commission_pct`. New clients ignore it.
        "commission_pct": 0.0,
        # AI-Powered-Staking referral: the referrer's chosen payout mode and the
        # admin-set percentages, so the /referral page can render the toggle and
        # what each option pays (client 2026-06-30).
        "fr_referral_mode": (user.fr_referral_mode or "principal"),
        "fr_referral_principal_pct": float(await get_float_setting("fr_referral_principal_pct", 0.0)),
        "fr_referral_interest_pct": float(await get_float_setting("fr_referral_interest_pct", 0.0)),
        # Per-entry breakdown (direct bounty vs AI-Powered-Staking referral),
        # each attributed to the referred user by name.
        "commission_ledger": commission_ledger,
    }


async def set_fr_referral_mode(db: AsyncSession, user_id: UUID, mode: str) -> str:
    """Set the referrer's global AI-Staking referral payout mode (client
    2026-06-30). 'principal' = a % of each referred user's principal once they
    lock; 'interest' = a % of each interest payout they receive."""
    m = (mode or "").strip().lower()
    if m not in ("principal", "interest"):
        raise HTTPException(status_code=400, detail="mode must be 'principal' or 'interest'")
    user = (await db.execute(
        select(User).where(User.id == user_id).with_for_update()
    )).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    user.fr_referral_mode = m
    await db.commit()
    return m


# ─── IB per-referral bounty (separate from user-level commission) ────

async def maybe_pay_ib_referral_bounty(
    db: AsyncSession, user_id: UUID, deposit: Deposit
) -> Optional[dict]:
    """Pay a flat bounty to the IB upline if this is the referred user's
    first approved deposit. Idempotent — runs the same first-deposit
    check as the user-level commission, but pays a TIER-SCALED FLAT
    amount instead of a percentage and only when an IB is in the chain.

    Caller is expected to call this AFTER setting deposit.status to
    approved / auto_approved. Returns the payout breakdown or None if
    nothing was paid.
    """
    # First-deposit gate — same logic as the user-level commission so
    # both payouts move together. Both helpers are idempotent.
    count = (await db.execute(
        select(func.count()).select_from(Deposit).where(
            Deposit.user_id == user_id,
            Deposit.status.in_(["approved", "auto_approved"]),
        )
    )).scalar()
    if (count or 0) != 1:
        return None

    # Find the IB the user signed up under via the Referral table (IB
    # MLM lineage, NOT the user-level User.referred_by_user_id).
    ref_row = (await db.execute(
        select(Referral).where(Referral.referred_id == user_id).limit(1)
    )).scalar_one_or_none()
    if ref_row is None or ref_row.ib_profile_id is None:
        return None

    ib = (await db.execute(
        select(IBProfile).where(IBProfile.id == ref_row.ib_profile_id).with_for_update()
    )).scalar_one_or_none()
    if ib is None or not ib.is_active:
        return None

    # Local import to keep referral_service free of engine deps.
    from ..engines.ib_engine import (
        get_ib_tiers, resolve_tier_for_count, count_active_referrals,
    )

    tiers = await get_ib_tiers(db)
    active_n = await count_active_referrals(db, ib.id)
    tier = resolve_tier_for_count(active_n, tiers)
    if not tier:
        return None
    bounty_raw = tier.get("per_referral_bounty")
    if bounty_raw in (None, ""):
        return None
    try:
        bounty = Decimal(str(bounty_raw)).quantize(Decimal("0.01"))
    except Exception:
        return None
    if bounty <= 0:
        return None

    ib_user = (await db.execute(
        select(User).where(User.id == ib.user_id).with_for_update()
    )).scalar_one_or_none()
    if ib_user is None:
        return None

    ib_user.main_wallet_balance = Decimal(str(ib_user.main_wallet_balance or 0)) + bounty

    db.add(Transaction(
        user_id=ib_user.id,
        type="ib_referral_bounty",
        amount=bounty,
        balance_after=ib_user.main_wallet_balance,
        reference_id=deposit.id,
        description=(
            f"IB referral bounty — {tier.get('label')} tier "
            f"(${float(bounty):.2f}) for {ib_user.email or ib_user.id}'s referral first deposit"
        ),
    ))

    return {
        "ib_user_id": str(ib_user.id),
        "referred_user_id": str(user_id),
        "deposit_id": str(deposit.id),
        "tier": tier.get("label"),
        "bounty": float(bounty),
    }
