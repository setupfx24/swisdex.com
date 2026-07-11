"""IB Commission Engine — Distributes trade commissions through MLM levels.

When a referred user places a trade, this engine:
1. Finds the referrer IB via the Referral table
2. Looks up the IB commission plan (commission_per_lot)
3. Distributes commission up the MLM chain using mlm_distribution percentages
4. Creates IBCommission records and credits IB trading accounts
"""
import json
import logging
from decimal import Decimal
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.models import (
    Referral, IBProfile, IBCommission, IBCommissionPlan,
    TradingAccount, Transaction, SystemSetting, User,
)

logger = logging.getLogger("ib-engine")

DEFAULT_MLM_DISTRIBUTION = [40, 25, 15, 10, 10]

# Fallback used if the system_settings row is absent. Matches the
# client's 2026-06-11 spec: four named tiers with admin-tunable per-lot
# commission, resolved by EITHER the IB's activation count OR the
# cumulative deposit amount their referrals have brought — whichever
# qualifies for the higher tier. A separate per-IB custom override
# (IBProfile.custom_commission_per_lot, e.g. $15) outranks the ladder.
#   - "activation" = a referred user who is KYC-approved AND has placed
#     at least `ib_commission_min_trades` (default 3) closed trades.
#   - "amount"     = sum of all approved deposits across the IB's referrals.
# Admin retunes thresholds + per-lot from /admin/config/ib-tiers.
DEFAULT_IB_TIERS = [
    {"label": "Bronze",   "per_lot": 5,  "min_activations": 5,   "min_amount": 500},
    {"label": "Silver",   "per_lot": 7,  "min_activations": 20,  "min_amount": 5000},
    {"label": "Gold",     "per_lot": 10, "min_activations": 50,  "min_amount": 20000},
    {"label": "Platinum", "per_lot": 12, "min_activations": 100, "min_amount": 50000},
]


async def get_mlm_distribution(db: AsyncSession) -> list[int]:
    result = await db.execute(
        select(SystemSetting).where(SystemSetting.key == "mlm_distribution")
    )
    setting = result.scalar_one_or_none()
    if setting and setting.value:
        val = setting.value
        if isinstance(val, str):
            try:
                val = json.loads(val)
            except Exception:
                return DEFAULT_MLM_DISTRIBUTION
        if isinstance(val, list):
            return [int(x) for x in val]
    return DEFAULT_MLM_DISTRIBUTION


async def get_ib_tiers(db: AsyncSession) -> list[dict]:
    """Read the admin-tunable commission tier ladder."""
    result = await db.execute(
        select(SystemSetting).where(SystemSetting.key == "ib_commission_tiers")
    )
    setting = result.scalar_one_or_none()
    if setting and setting.value:
        val = setting.value
        if isinstance(val, str):
            try:
                val = json.loads(val)
            except Exception:
                return DEFAULT_IB_TIERS
        if isinstance(val, list) and val:
            return val
    return DEFAULT_IB_TIERS


def resolve_tier(activations: int, amount, tiers: list[dict]) -> dict | None:
    """Highest tier the IB qualifies for. A tier is reached when EITHER
    the activation count OR the cumulative referral-deposit amount meets
    that tier's threshold (whichever is satisfied). Among all qualifying
    tiers we return the richest (highest per_lot). None means the IB is
    below the lowest tier and earns nothing from the ladder (a per-IB
    custom override or plan default may still apply)."""
    try:
        amt = float(amount or 0)
    except (TypeError, ValueError):
        amt = 0.0
    chosen = None
    chosen_lot = -1.0
    for t in tiers:
        min_act = int(t.get("min_activations") or 0)
        min_amt = float(t.get("min_amount") or 0)
        qualifies = (
            (min_act > 0 and activations >= min_act)
            or (min_amt > 0 and amt >= min_amt)
        )
        if qualifies:
            lot = float(t.get("per_lot") or 0)
            if lot >= chosen_lot:
                chosen = t
                chosen_lot = lot
    return chosen


# Backward-compat shim: a couple of older call sites still import
# resolve_tier_for_count. The new ladder has no referral-count windows,
# so treat the count as the activation count with amount=0.
def resolve_tier_for_count(count: int, tiers: list[dict]) -> dict | None:
    return resolve_tier(int(count or 0), 0, tiers)


async def compute_ib_qualification(db: AsyncSession, ib_profile_id: UUID) -> tuple[int, Decimal]:
    """Return ``(activation_count, cumulative_deposit_amount)`` for an IB.

    activation = a referred user who is KYC-approved AND has at least
    ``ib_commission_min_trades`` (default 3) closed trades.
    amount      = sum of approved / auto-approved deposits across all of
    the IB's referred users.
    """
    from packages.common.src.models import (
        User, TradeHistory, TradingAccount, Deposit, Transaction,
    )
    from packages.common.src.settings_store import get_int_setting, get_bool_setting

    referred_ids = [
        r[0] for r in (await db.execute(
            select(Referral.referred_id).where(Referral.ib_profile_id == ib_profile_id)
        )).all() if r[0] is not None
    ]
    if not referred_ids:
        return 0, Decimal("0")

    # Cumulative funded amount brought by all referrals — approved deposits PLUS
    # admin manual credits (Transaction type 'adjustment', positive). Must match
    # business_service._ib_pool_and_active so the tier the engine pays on equals
    # what the IB sees on /business (client 2026-06-30: deposits + admin credits
    # both drive the tier).
    deposits_amt = (await db.execute(
        select(func.coalesce(func.sum(Deposit.amount), 0)).where(
            Deposit.user_id.in_(referred_ids),
            Deposit.status.in_(["approved", "auto_approved"]),
        )
    )).scalar() or 0
    credits_amt = (await db.execute(
        select(func.coalesce(func.sum(Transaction.amount), 0)).where(
            Transaction.user_id.in_(referred_ids),
            Transaction.type == "adjustment",
            Transaction.amount > 0,
        )
    )).scalar() or 0
    amount = Decimal(str(deposits_amt)) + Decimal(str(credits_amt))

    # Activations: referrals with >= min_trades closed trades, and (when
    # the admin toggle is on) KYC-approved. Both the trade count and the
    # KYC requirement are admin-editable from /config/ib-tiers.
    min_trades = await get_int_setting("ib_commission_min_trades", 3)
    requires_kyc = await get_bool_setting("ib_commission_requires_kyc", True)
    if requires_kyc:
        eligible_ids = [
            r[0] for r in (await db.execute(
                select(User.id).where(
                    User.id.in_(referred_ids),
                    func.lower(User.kyc_status).in_(["approved", "verified"]),
                )
            )).all()
        ]
    else:
        eligible_ids = referred_ids
    activations = 0
    if eligible_ids:
        rows = (await db.execute(
            select(TradingAccount.user_id, func.count(TradeHistory.id))
            .select_from(TradeHistory)
            .join(TradingAccount, TradingAccount.id == TradeHistory.account_id)
            .where(TradingAccount.user_id.in_(eligible_ids))
            .group_by(TradingAccount.user_id)
        )).all()
        for _uid, cnt in rows:
            if int(cnt or 0) >= int(min_trades or 0):
                activations += 1
    return activations, amount


async def _referred_account_type_key(db: AsyncSession, order_id: UUID) -> str | None:
    """Return the lowercase AccountGroup name for the account that
    placed ``order_id`` — used to look up the right per-lot rate in
    the tier's per_lot_by_account_type map. Returns None if any
    join fails (caller falls back to the flat per_lot).
    """
    from packages.common.src.models import Order, TradingAccount, AccountGroup

    row = (await db.execute(
        select(AccountGroup.name)
        .select_from(Order)
        .join(TradingAccount, TradingAccount.id == Order.account_id)
        .join(AccountGroup, AccountGroup.id == TradingAccount.account_group_id)
        .where(Order.id == order_id)
    )).first()
    if not row or not row[0]:
        return None
    return str(row[0]).strip().lower()


async def count_active_referrals(db: AsyncSession, ib_profile_id: UUID) -> int:
    """Active referrals = rows in the referrals table pointing at this IB.

    The tier ladder uses "active referrals" — we treat any Referral row
    as active (the platform soft-bans rather than deletes), which matches
    the IB dashboard's display count and keeps the tier resolver in sync
    with what the trader sees on their /business page.
    """
    n = (await db.execute(
        select(func.count()).select_from(Referral).where(
            Referral.ib_profile_id == ib_profile_id,
        )
    )).scalar() or 0
    return int(n)


async def _resolve_ib_per_lot(
    db: AsyncSession, ib: IBProfile, acct_type_key: str, plan,
) -> Decimal | None:
    """Per-lot commission rate for ONE earner, using THEIR OWN tier.

    Client spec 2026-06-16: every IB/sub-IB earns on their own tier rate
    (a Bronze IB earns on $5/lot, a Gold sub-IB on $10/lot), NOT on a shared
    pool. Priority:
      1. per-IB custom $/lot override (admin-set on the profile)
      2. admin manual tier override (forced Bronze/Silver/Gold/Platinum)
      3. auto tier, by the referred account type
      4. auto tier flat per_lot
      5. plan default
    Returns None when nothing resolves (this earner gets nothing this trade).
    """
    if ib.custom_commission_per_lot is not None and ib.custom_commission_per_lot > 0:
        return Decimal(str(ib.custom_commission_per_lot))

    tiers = await get_ib_tiers(db)
    tier = None
    # Admin manual tier override (tier_override column, added 2026-06-16).
    # getattr-safe so the engine still runs before the column exists.
    override_label = (getattr(ib, "tier_override", None) or "").strip().lower()
    if override_label:
        for t in tiers:
            if str(t.get("label") or "").strip().lower() == override_label:
                tier = t
                break
    if tier is None:
        activations, amount = await compute_ib_qualification(db, ib.id)
        tier = resolve_tier(activations, amount, tiers)

    if tier:
        type_map = tier.get("per_lot_by_account_type") or {}
        raw = type_map.get(acct_type_key) if acct_type_key else None
        if raw in (None, "") and isinstance(type_map, dict):
            raw = type_map.get("standard")  # last-resort default
        if raw in (None, ""):
            raw = tier.get("per_lot")
        if raw not in (None, ""):
            try:
                return Decimal(str(raw))
            except Exception:
                pass

    if plan and plan.commission_per_lot is not None:
        return Decimal(str(plan.commission_per_lot))
    return None


async def _is_full_ib(db: AsyncSession, ib: IBProfile) -> bool:
    """A 'full IB' is the Super IB (SDA05) itself or someone introduced
    DIRECTLY by it. Full IBs earn 100% on their direct referrals; Sub-IBs
    (anyone deeper in the tree) earn the standard 40% even on their own
    direct referrals (client correction 2026-06-16). Mirrors
    business_service._resolve_ib_type. Fallback when no Super IB is
    configured: a top-level profile (no parent) counts as a full IB.
    """
    from packages.common.src.settings_store import get_system_setting
    code = str(await get_system_setting("super_ib_code", None) or "SDA05").strip()
    if not code:
        return ib.parent_ib_id is None
    super_row = (await db.execute(
        select(IBProfile.id).where(IBProfile.referral_code == code)
    )).first()
    super_id = super_row[0] if super_row else None
    if super_id is None:
        return ib.parent_ib_id is None
    return ib.id == super_id or ib.parent_ib_id == super_id


async def distribute_ib_commission(
    db: AsyncSession,
    trader_user_id: UUID,
    order_id: UUID,
    lots: Decimal,
    instrument_symbol: str,
):
    """Called after a market order is filled. Distributes commission to IB chain.

    Eligibility gates (2026-05-26 client request, mirrors the user
    referral flow):
      • The trader's KYC must be approved (toggle: ib_commission_requires_kyc).
      • The trader must have closed at least N trades (default 3, toggle:
        ib_commission_min_trades). The current order doesn't count yet —
        we count rows in trade_history.
    Either gate failing → no commission this trade. The IB still earns
    from the same trader on every subsequent qualifying trade.
    """
    referral_q = await db.execute(
        select(Referral).where(Referral.referred_id == trader_user_id)
    )
    referral = referral_q.scalar_one_or_none()
    if not referral or not referral.ib_profile_id:
        return

    # ── Eligibility gates ────────────────────────────────────────────
    from packages.common.src.models import User, TradeHistory, TradingAccount
    from packages.common.src.settings_store import (
        get_bool_setting, get_int_setting,
    )

    requires_kyc = await get_bool_setting("ib_commission_requires_kyc", True)
    if requires_kyc:
        trader = (await db.execute(
            select(User).where(User.id == trader_user_id)
        )).scalar_one_or_none()
        kyc = (getattr(trader, "kyc_status", None) or "pending").lower()
        if kyc != "approved":
            return

    min_trades = await get_int_setting("ib_commission_min_trades", 3)
    if min_trades > 0:
        closed_n = (await db.execute(
            select(func.count())
            .select_from(TradeHistory)
            .join(TradingAccount, TradingAccount.id == TradeHistory.account_id)
            .where(TradingAccount.user_id == trader_user_id)
        )).scalar() or 0
        if int(closed_n) < min_trades:
            return

    ib_profile_q = await db.execute(
        select(IBProfile).where(IBProfile.id == referral.ib_profile_id, IBProfile.is_active == True)
    )
    direct_ib = ib_profile_q.scalar_one_or_none()
    if not direct_ib:
        return

    plan = None
    if direct_ib.commission_plan_id:
        plan_q = await db.execute(
            select(IBCommissionPlan).where(IBCommissionPlan.id == direct_ib.commission_plan_id)
        )
        plan = plan_q.scalar_one_or_none()

    if not plan:
        plan_q = await db.execute(
            select(IBCommissionPlan).where(IBCommissionPlan.is_default == True)
        )
        plan = plan_q.scalar_one_or_none()

    # ── Commission distribution (client spec 2026-06-16, corrected) ───
    # Each IB/sub-IB earns on THEIR OWN tier per-lot rate (Bronze $5, Gold
    # $10, ...), NOT a shared pool. Walking UP from the trader's direct
    # sponsor (index 0), the override ladder by RELATIVE depth is:
    #   level 1 (direct) = 40%, level 2 = 20%, 3 = 10%, 4 = 10%, 5 = 5%.
    # EXCEPTION (client correction): a FULL IB — the Super IB (SDA05) or
    # someone introduced directly by it — earns 100% (not 40%) on traders
    # DIRECTLY under them. A Sub-IB earns the standard 40% even on their own
    # direct referrals. Shares STACK up the chain (broker funds the overage
    # from the spread). The account-type bucket is the trader's order
    # account; each earner looks up THEIR rate for that bucket.
    acct_type_key = await _referred_account_type_key(db, order_id) or ""
    LADDER = [40, 20, 10, 10, 5]  # relative depth 1..5; nothing beyond 5

    current_ib = direct_ib
    for depth, base_pct in enumerate(LADDER):
        if current_ib is None:
            break

        # Direct sponsor (depth 0): 100% if a full IB, else 40%. Uplines
        # always use the ladder rate.
        pct = 100 if (depth == 0 and await _is_full_ib(db, current_ib)) else base_pct

        earner_per_lot = await _resolve_ib_per_lot(db, current_ib, acct_type_key, plan)
        if earner_per_lot is None or earner_per_lot <= 0:
            current_ib = await _get_parent_ib(current_ib, db)
            continue

        share = earner_per_lot * lots * Decimal(str(pct)) / Decimal("100")
        if share <= 0:
            current_ib = await _get_parent_ib(current_ib, db)
            continue

        db.add(IBCommission(
            ib_id=current_ib.id,
            source_user_id=trader_user_id,
            source_trade_id=order_id,
            commission_type="trade_lot",
            amount=share,
            mlm_level=depth + 1,  # 1 = direct sponsor, 2..6 = uplines
            status="paid",
        ))

        current_ib.total_earned = (current_ib.total_earned or Decimal("0")) + share

        # Commissions accumulate in users.ib_commission_balance; the IB
        # sweeps it to their main wallet from /business (2026-05-26 flow).
        ib_user = (await db.execute(
            select(User).where(User.id == current_ib.user_id).with_for_update()
        )).scalar_one_or_none()
        if ib_user is not None:
            ib_user.ib_commission_balance = (
                Decimal(str(ib_user.ib_commission_balance or 0)) + share
            )

        logger.info(
            f"IB commission depth {depth} ({pct}% of ${earner_per_lot}/lot): "
            f"${share:.2f} to {current_ib.referral_code} ({instrument_symbol} {lots} lots)"
        )

        current_ib = await _get_parent_ib(current_ib, db)


async def _get_parent_ib(ib: IBProfile, db: AsyncSession) -> IBProfile | None:
    if not ib.parent_ib_id:
        return None
    result = await db.execute(
        select(IBProfile).where(IBProfile.id == ib.parent_ib_id, IBProfile.is_active == True)
    )
    return result.scalar_one_or_none()
