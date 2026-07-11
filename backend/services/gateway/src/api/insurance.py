"""Trade Insurance API.

Quote → Activate → (passive) Settle on close. See `Trade Insurance.docx`
at the repo root and `packages/common/src/insurance/` for the engine.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import desc, select, func
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.auth import get_current_user
from packages.common.src.database import get_db
from packages.common.src.models import (
    Instrument, Position, TradingAccount, TradeHistory,
    InsurancePolicy, InsuranceClaim,
)
from packages.common.src.schemas import (
    InsuranceActivateRequest, InsuranceActivateResponse,
    InsuranceClaimOut, InsuranceClaimPayResponse, InsurancePolicyOut,
    InsuranceQuoteRequest, InsuranceTierQuote,
)
from packages.common.src.insurance import quote_all_tiers, load_config
from packages.common.src.insurance.claims import pay_claim
from packages.common.src.insurance.volatility import get_atr
from packages.common.src.insurance.pricing import fee_to_decimal

from ..services import wallet_service, trading_service

router = APIRouter()


@router.post("/quote", response_model=list[InsuranceTierQuote])
async def quote(
    req: InsuranceQuoteRequest,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    cfg = await load_config()
    if not cfg.enabled:
        raise HTTPException(status_code=409, detail="insurance_disabled")
    if cfg.news_blackout_until and datetime.now(timezone.utc) < cfg.news_blackout_until:
        raise HTTPException(status_code=409, detail="news_blackout")

    inst = (await db.execute(
        select(Instrument).where(Instrument.symbol == req.symbol.upper(), Instrument.is_active.is_(True))
    )).scalar_one_or_none()
    if inst is None:
        raise HTTPException(status_code=404, detail="instrument_not_found")

    atr = await get_atr(req.symbol)
    if atr < cfg.atr_floor:
        raise HTTPException(status_code=409, detail="vol_too_low")
    if cfg.atr_ceiling is not None and atr > cfg.atr_ceiling:
        raise HTTPException(status_code=409, detail="vol_too_high")

    # Max-insurable-lots gate — MUST mirror the same check in /activate.
    # Previously only /activate enforced it, so the picker happily showed
    # tiers for an over-cap position that then failed activation, leaving
    # the trade "Not insured" with no explanation. Now the picker hides
    # (frontend treats this 409 as "no tiers") so the user never sees a
    # tier they can't actually buy. req.lots here is the EFFECTIVE
    # (cent-scaled) lots the frontend sends, matching the pos.lots the
    # activate endpoint compares.
    if cfg.max_lots_insurable and cfg.max_lots_insurable > 0:
        if float(req.lots or 0) > float(cfg.max_lots_insurable):
            raise HTTPException(
                status_code=409,
                detail=f"max_lots_exceeded:{cfg.max_lots_insurable}",
            )

    # Trade-size in USD ≈ lots × contract_size × price.
    bid, ask = await trading_service.get_current_price(req.symbol)
    price = (bid + ask) / Decimal("2") if (bid and ask) else Decimal("1")
    contract_size = Decimal(str(inst.contract_size or 100000))
    trade_size_usd = float(Decimal(str(req.lots)) * contract_size * price)

    sl_distance = None
    if req.stop_loss is not None:
        sl_distance = abs(float(price - Decimal(str(req.stop_loss))))

    win_rate = await _user_win_rate(db, current_user["user_id"])

    # Resolve the account's group so per-account-type rate overrides
    # apply (admin sets these on /admin/insurance for Micro/Standard/Pro
    # /Elite accounts independently of the global per_lot_fee).
    acct_group_id = None
    acct_number = ""
    acct_is_demo = False
    acct_row = (await db.execute(
        select(TradingAccount.account_group_id, TradingAccount.account_number, TradingAccount.is_demo).where(TradingAccount.id == req.account_id)
    )).first()
    if acct_row is not None:
        acct_group_id = acct_row[0]
        acct_number = (acct_row[1] or "")
        acct_is_demo = bool(acct_row[2])

    # Demo accounts can't buy Trade Insurance — return no tiers so the picker
    # shows nothing (root fix for demo insurance fees, client 2026-06-25).
    if acct_is_demo:
        return []

    # PAMM / MAM insurance gate (client 2026-06-25). PAMM/MAM pool + managed
    # sub-accounts (account numbers prefixed IF/CF/PM/MM/CT) can only insure
    # trades when the admin enables `pamm_mam_insurance_enabled` (default off).
    if acct_number.upper().startswith(("IF", "CF", "PM", "MM", "CT")):
        from packages.common.src.settings_store import get_bool_setting
        if not await get_bool_setting("pamm_mam_insurance_enabled", False):
            raise HTTPException(status_code=409, detail="insurance_disabled_for_pamm_mam")

    # Per-account-type insurance gate (Mig 0070). If admin turned
    # insurance off for this account type, return empty quotes so the
    # trader UI shows nothing to buy.
    if acct_group_id is not None:
        from packages.common.src.models import AccountGroup
        grp_ins = (await db.execute(
            select(AccountGroup.insurance_enabled).where(AccountGroup.id == acct_group_id)
        )).scalar_one_or_none()
        if grp_ins is False:
            raise HTTPException(status_code=409, detail="insurance_disabled_for_account_type")

    quotes = await quote_all_tiers(
        cfg=cfg,
        leverage=float(req.leverage),
        atr=atr,
        lots=float(req.lots),
        trade_size_usd=trade_size_usd,
        has_stop_loss=req.stop_loss is not None,
        sl_distance=sl_distance,
        win_rate=win_rate,
        db=db,
        user_id=current_user["user_id"],
        account_group_id=acct_group_id,
    )
    return quotes


@router.post("/activate", response_model=InsuranceActivateResponse)
async def activate(
    req: InsuranceActivateRequest,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    cfg = await load_config()
    if not cfg.enabled:
        raise HTTPException(status_code=409, detail="insurance_disabled")
    if cfg.news_blackout_until and datetime.now(timezone.utc) < cfg.news_blackout_until:
        raise HTTPException(status_code=409, detail="news_blackout")

    user_id = current_user["user_id"]
    now_utc = datetime.now(timezone.utc)

    # ── Client gate #1: hour-of-day blackout ──────────────────────
    # E.g. admin says "no insurance between 10:00–11:00 UTC".
    # When start > end, treats it as a window that wraps midnight.
    if cfg.blackout_hour_start is not None and cfg.blackout_hour_end is not None:
        hr = now_utc.hour
        s, e = int(cfg.blackout_hour_start), int(cfg.blackout_hour_end)
        in_window = (s <= hr < e) if s <= e else (hr >= s or hr < e)
        if in_window:
            raise HTTPException(status_code=409, detail="hour_blackout")

    pos = (await db.execute(
        select(Position).where(Position.id == req.position_id)
    )).scalar_one_or_none()
    if pos is None:
        raise HTTPException(status_code=404, detail="position_not_found")
    if pos.status != "open":
        raise HTTPException(status_code=409, detail="position_not_open")

    # ── Client gate #2: max lots insurable ────────────────────────
    if cfg.max_lots_insurable and cfg.max_lots_insurable > 0:
        if float(pos.lots or 0) > float(cfg.max_lots_insurable):
            raise HTTPException(
                status_code=409,
                detail=f"max_lots_exceeded:{cfg.max_lots_insurable}",
            )

    # Position belongs to user?
    acct = (await db.execute(
        select(TradingAccount).where(TradingAccount.id == pos.account_id)
    )).scalar_one_or_none()
    if acct is None or acct.user_id != user_id:
        raise HTTPException(status_code=403, detail="not_your_position")

    # Demo accounts can't buy Trade Insurance — it's a real-money product and
    # the demo fee just cluttered the transaction history (client 2026-06-25).
    if bool(getattr(acct, "is_demo", False)):
        raise HTTPException(status_code=409, detail="insurance_not_available_on_demo")

    # PAMM / MAM insurance gate (client 2026-06-25) — mirror the /quote check
    # so a PAMM/MAM pool/managed account can't activate insurance unless admin
    # enabled pamm_mam_insurance_enabled.
    if str(acct.account_number or "").upper().startswith(("IF", "CF", "PM", "MM", "CT")):
        from packages.common.src.settings_store import get_bool_setting
        if not await get_bool_setting("pamm_mam_insurance_enabled", False):
            raise HTTPException(status_code=409, detail="insurance_disabled_for_pamm_mam")

    # Per-account-type insurance gate (Mig 0070) — hard-block activation
    # if admin disabled insurance for this account's type, even if the
    # client somehow sent the request (UI hides the picker but the
    # endpoint can't trust that).
    if acct.account_group_id is not None:
        from packages.common.src.models import AccountGroup
        grp_ins = (await db.execute(
            select(AccountGroup.insurance_enabled).where(AccountGroup.id == acct.account_group_id)
        )).scalar_one_or_none()
        if grp_ins is False:
            raise HTTPException(status_code=409, detail="insurance_disabled_for_account_type")

    # Already insured?
    existing = (await db.execute(
        select(InsurancePolicy).where(InsurancePolicy.position_id == pos.id)
    )).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(status_code=409, detail="policy_already_exists")

    # ── Client gate #3: max policies per rolling 24h window ───────
    if cfg.max_policies_per_day and cfg.max_policies_per_day > 0:
        since = now_utc - timedelta(days=1)
        cnt = (await db.execute(
            select(func.count())
            .select_from(InsurancePolicy)
            # Count only policies of the SAME account type (demo vs real) being
            # insured, so demo activations don't eat into the real daily limit
            # and vice versa (client 2026-06-16 — keep demo + real separate).
            .join(TradingAccount, TradingAccount.id == InsurancePolicy.account_id)
            .where(
                InsurancePolicy.user_id == user_id,
                InsurancePolicy.activated_at >= since,
                TradingAccount.is_demo == acct.is_demo,
            )
        )).scalar() or 0
        if int(cnt) >= int(cfg.max_policies_per_day):
            raise HTTPException(
                status_code=409,
                detail=f"daily_policy_limit:{cfg.max_policies_per_day}",
            )

    inst = (await db.execute(
        select(Instrument).where(Instrument.id == pos.instrument_id)
    )).scalar_one_or_none()
    if inst is None:
        raise HTTPException(status_code=404, detail="instrument_not_found")

    atr = await get_atr(inst.symbol)
    if atr < cfg.atr_floor:
        raise HTTPException(status_code=409, detail="vol_too_low")

    contract_size = Decimal(str(inst.contract_size or 100000))
    trade_size_usd = float(Decimal(str(pos.lots)) * contract_size * Decimal(str(pos.open_price)))

    sl_distance = None
    if pos.stop_loss is not None:
        sl_distance = abs(float(Decimal(str(pos.open_price)) - Decimal(str(pos.stop_loss))))

    win_rate = await _user_win_rate(db, user_id)

    quotes = await quote_all_tiers(
        cfg=cfg,
        leverage=float(acct.leverage or 100),
        atr=atr,
        lots=float(pos.lots),
        trade_size_usd=trade_size_usd,
        has_stop_loss=pos.stop_loss is not None,
        sl_distance=sl_distance,
        win_rate=win_rate,
        db=db,
        user_id=user_id,
        account_group_id=acct.account_group_id,
    )

    chosen = next((q for q in quotes if q["tier"] == req.tier), None)
    if chosen is None:
        raise HTTPException(status_code=400, detail="invalid_tier")

    fee_dec = fee_to_decimal(chosen["fee"])

    # Persist policy first so the FK target exists for the Transaction reference.
    import uuid as _uuid
    policy = InsurancePolicy(
        id=_uuid.uuid4(),
        user_id=user_id,
        account_id=acct.id,
        position_id=pos.id,
        instrument_id=inst.id,
        tier=req.tier,
        fee=fee_dec,
        coverage_pct=Decimal(str(chosen["coverage_pct"])),
        max_cap=Decimal(str(chosen["max_cap"])),
        risk_score=Decimal(str(chosen["risk_score"])),
        status="active",
    )
    db.add(policy)
    await db.flush()

    await wallet_service.charge_insurance_fee(
        db=db,
        user_id=user_id,
        account_id=acct.id,
        amount=fee_dec,
        policy_id=policy.id,
        description=(
            f"Trade insurance — {req.tier.title()} tier on {inst.symbol} "
            f"({float(pos.lots):.2f} lots)"
        ),
    )
    await db.commit()

    return InsuranceActivateResponse(
        policy_id=policy.id, fee_charged=fee_dec, status="active",
    )


@router.get("/active", response_model=list[InsurancePolicyOut])
async def list_active(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _list_policies(db, current_user["user_id"], statuses=("active",))


@router.get("/policies", response_model=list[InsurancePolicyOut])
async def list_policies(
    limit: int = 50,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await _list_policies(db, current_user["user_id"], statuses=None, limit=limit)


@router.get("/claims", response_model=list[InsuranceClaimOut])
async def list_claims(
    limit: int = 50,
    status: str | None = None,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """All eligible claims for the trader. `status=pending` filters to
    claimable rows (the dashboard "Claim" list); `status=paid` filters
    to history. No filter → both. Pending rows surface first because
    they sort by paid_at DESC with NULLS FIRST (Postgres default).
    """
    stmt = (
        select(InsuranceClaim, InsurancePolicy, Instrument.symbol)
        .join(InsurancePolicy, InsurancePolicy.id == InsuranceClaim.policy_id)
        .join(Instrument, Instrument.id == InsurancePolicy.instrument_id)
        # Real-account claims only — keep demo separate from real (2026-06-16).
        .join(TradingAccount, TradingAccount.id == InsurancePolicy.account_id)
        .where(InsuranceClaim.user_id == current_user["user_id"])
        .where(TradingAccount.is_demo == False)
        .order_by(desc(InsuranceClaim.paid_at), desc(InsuranceClaim.id))
        .limit(max(1, min(limit, 200)))
    )
    if status in ("pending", "paid"):
        stmt = stmt.where(InsuranceClaim.status == status)
    rows = (await db.execute(stmt)).all()
    return [
        InsuranceClaimOut(
            id=c.id,
            policy_id=c.policy_id,
            loss_amount=c.loss_amount,
            claim_amount=c.claim_amount,
            status=c.status,
            paid_at=c.paid_at,
            claimed_at=c.claimed_at,
            instrument_symbol=sym,
            tier=pol.tier,
        )
        for c, pol, sym in rows
    ]


@router.post("/claims/{claim_id}/claim", response_model=InsuranceClaimPayResponse)
async def claim_payout(
    claim_id: UUID,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Trader pressed Claim on a pending row. Credits the policy's
    account.credit (or balance if admin disabled payout_to_credit) and
    flips the claim to 'paid'.
    """
    claim, err = await pay_claim(
        db=db, claim_id=claim_id, user_id=current_user["user_id"],
    )
    if err == "not_found":
        raise HTTPException(404, "Claim not found")
    if err == "already_claimed":
        raise HTTPException(409, "This claim has already been paid")
    if err == "policy_missing" or err == "account_missing":
        raise HTTPException(500, "Linked policy/account missing — contact support")
    if claim is None:
        raise HTTPException(500, "Claim payout failed")

    await db.commit()

    cfg = await load_config()
    return InsuranceClaimPayResponse(
        claim_id=claim.id,
        amount=Decimal(str(claim.claim_amount)),
        credited_to="credit" if cfg.payout_to_credit else "balance",
        status="paid",
    )


# ─────────────────────────────────────────────────────────────────────
# helpers
# ─────────────────────────────────────────────────────────────────────

async def _list_policies(
    db: AsyncSession, user_id: UUID, *, statuses: tuple[str, ...] | None = None, limit: int = 50,
) -> list[InsurancePolicyOut]:
    # Self-heal catch-all (client 2026-06-19: insurance showed "active" after the
    # trade closed). Any policy still 'active' whose position is already closed
    # is stale — a close path forgot to settle it. Mark it expired so the
    # dashboard never shows live insurance on a closed trade. Best-effort.
    try:
        from sqlalchemy import text as _sql_text
        await db.execute(_sql_text(
            "UPDATE insurance_policies SET status = 'expired', "
            "settled_at = COALESCE(settled_at, now()), "
            "settled_reason = COALESCE(settled_reason, 'position_closed') "
            "WHERE user_id = :uid AND status = 'active' AND position_id IN "
            "(SELECT id FROM positions WHERE status = 'closed')"
        ), {"uid": str(user_id)})
        await db.commit()
    except Exception:
        await db.rollback()

    stmt = (
        select(InsurancePolicy, Instrument.symbol)
        .join(Instrument, Instrument.id == InsurancePolicy.instrument_id)
        # Exclude DEMO-account policies so the insurance dashboard shows REAL
        # protection only — demo insurance must not merge with real
        # (client 2026-06-16).
        .join(TradingAccount, TradingAccount.id == InsurancePolicy.account_id)
        .where(InsurancePolicy.user_id == user_id)
        .where(TradingAccount.is_demo == False)
        .order_by(desc(InsurancePolicy.activated_at))
        .limit(max(1, min(limit, 200)))
    )
    if statuses:
        stmt = stmt.where(InsurancePolicy.status.in_(statuses))
    rows = (await db.execute(stmt)).all()
    return [
        InsurancePolicyOut(
            id=p.id,
            position_id=p.position_id,
            instrument_symbol=symbol,
            tier=p.tier,
            fee=p.fee,
            coverage_pct=p.coverage_pct,
            max_cap=p.max_cap,
            status=p.status,
            activated_at=p.activated_at,
            settled_at=p.settled_at,
            settled_reason=p.settled_reason,
        )
        for (p, symbol) in rows
    ]


async def _user_win_rate(db: AsyncSession, user_id: UUID) -> float:
    """Recent win-rate over the user's last 50 closed trades. 0.0 if no history."""
    rows = (await db.execute(
        select(TradeHistory.profit)
        .join(TradingAccount, TradingAccount.id == TradeHistory.account_id)
        .where(TradingAccount.user_id == user_id)
        .order_by(desc(TradeHistory.closed_at))
        .limit(50)
    )).scalars().all()
    if not rows:
        return 0.0
    wins = sum(1 for p in rows if (p or 0) > 0)
    return wins / len(rows)
