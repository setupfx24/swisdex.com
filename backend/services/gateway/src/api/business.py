"""IB / Sub-Broker Business API — Referrals, commissions, MLM tree."""
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.database import get_db
from packages.common.src.auth import get_current_user
from ..services import business_service
from ..services import referral_service

router = APIRouter()


@router.get("/referral/me")
async def my_referral_dashboard(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """User-level referral dashboard — every user has a code, not just IBs.

    Returns referral_code, count of users they've referred, total
    commission they've earned, and the current admin-set %.
    """
    return await referral_service.get_my_referral_dashboard(db, current_user["user_id"])


class FrReferralModeRequest(BaseModel):
    mode: str


@router.put("/referral/fr-mode")
async def set_fr_referral_mode(
    req: FrReferralModeRequest,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Set the referrer's global AI-Powered-Staking referral payout mode
    ('principal' or 'interest')."""
    mode = await referral_service.set_fr_referral_mode(
        db, current_user["user_id"], req.mode,
    )
    return {"fr_referral_mode": mode}


@router.get("/referral/list")
async def my_referrals_list(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Per-friend table for the trader /referral page. One row per
    referred user: name, email, trades_count, status
    (pending/claimable/claimed). Also includes the referrer's current
    commission_balance and next-claim bounty preview."""
    return await referral_service.list_my_referrals(db, current_user["user_id"])


@router.post("/referral/claim/{referred_user_id}")
async def claim_one_referral(
    referred_user_id: UUID,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    amount, err = await referral_service.claim_referral_bounty(
        db,
        referrer_id=current_user["user_id"],
        referred_user_id=referred_user_id,
    )
    if err == "not_found":
        raise HTTPException(404, "Referral not found")
    if err == "not_eligible":
        raise HTTPException(409, "This referral hasn't qualified yet")
    if err == "already_claimed":
        raise HTTPException(409, "Already claimed")
    if err == "zero_bounty":
        raise HTTPException(409, "Bounty configuration is zero — contact support")
    if err or amount is None:
        raise HTTPException(500, "Claim failed")
    await db.commit()
    return {"amount": float(amount), "status": "claimed"}


@router.post("/referral/withdraw")
async def withdraw_my_referral_commission(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    amount, err = await referral_service.withdraw_referral_commission(
        db, user_id=current_user["user_id"],
    )
    if err == "user_missing":
        raise HTTPException(404, "User not found")
    if err == "zero_balance":
        raise HTTPException(409, "Nothing to withdraw")
    if err or amount is None:
        raise HTTPException(500, "Withdraw failed")
    await db.commit()

    # Fire a notification AFTER commit so the user sees a fresh bell.
    try:
        from packages.common.src.notify import create_notification
        await create_notification(
            db, current_user["user_id"],
            title="Referral commission moved",
            message=(
                f"${float(amount):.2f} added to your main wallet from "
                f"referral commission."
            ),
            notif_type="success",
            action_url="/referral",
        )
        await db.commit()
    except Exception:
        # Never break the withdraw if notification side-effect fails.
        pass
    return {"amount": float(amount), "status": "withdrawn"}


@router.get("/status")
async def ib_status(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await business_service.ib_status(user_id=current_user["user_id"], db=db)


@router.post("/apply", status_code=201)
async def apply_ib(
    application_data: dict = None,
    referral_code: str = Query(None),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await business_service.apply_ib(
        user_id=current_user["user_id"], application_data=application_data, db=db,
    )


@router.post("/apply-sub-broker", status_code=201)
async def apply_sub_broker(
    application_data: dict = None,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await business_service.apply_sub_broker(
        user_id=current_user["user_id"], application_data=application_data, db=db,
    )


@router.get("/ib/dashboard")
async def ib_dashboard(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await business_service.ib_dashboard(user_id=current_user["user_id"], db=db)


@router.post("/ib/transfer")
async def transfer_ib_commission(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Sweep the IB's accumulated commission pool into their main
    wallet. Writes a Transaction + notification."""
    return await business_service.transfer_ib_commission_to_main_wallet(
        user_id=current_user["user_id"], db=db,
    )


@router.get("/ib/referrals")
async def ib_referrals(
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await business_service.ib_referrals(
        user_id=current_user["user_id"], page=page, per_page=per_page, db=db,
    )


@router.get("/ib/commissions")
async def ib_commissions(
    status: str = Query(None, pattern="^(pending|paid|cancelled)$"),
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await business_service.ib_commissions(
        user_id=current_user["user_id"], status=status,
        page=page, per_page=per_page, db=db,
    )


@router.get("/ib/tree")
async def ib_tree(
    max_depth: int = Query(5, ge=1, le=10),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await business_service.ib_tree(
        user_id=current_user["user_id"], max_depth=max_depth, db=db,
    )


@router.post("/ib/generate-link")
async def generate_referral_link(
    utm_source: str = Query(None),
    utm_medium: str = Query(None),
    utm_campaign: str = Query(None),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await business_service.generate_referral_link(
        user_id=current_user["user_id"],
        utm_source=utm_source, utm_medium=utm_medium, utm_campaign=utm_campaign,
        db=db,
    )


@router.get("/sub-broker/dashboard")
async def sub_broker_dashboard(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await business_service.sub_broker_dashboard(
        user_id=current_user["user_id"], db=db,
    )
