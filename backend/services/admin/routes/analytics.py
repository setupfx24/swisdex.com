from datetime import datetime, time, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.database import get_db
from dependencies import require_permission
from packages.common.src.models import User
from services import analytics_service

router = APIRouter(prefix="/analytics", tags=["Analytics"])


class PromotionalExpenseBody(BaseModel):
    amount: float = Field(gt=0, description="Give-away amount in USD (must be > 0)")
    category: Optional[str] = Field(default="manual", description="e.g. extra_fr_interest, custom_benefit, manual")
    note: Optional[str] = None
    user_id: Optional[UUID] = Field(default=None, description="Recipient user (optional)")


def _parse_date_bound(value: str | None, *, end_of_day: bool) -> datetime | None:
    """Parse a YYYY-MM-DD query string into a UTC datetime. Use start of day
    for the `from` bound and end of day for the `to` bound so the filter
    is inclusive of the end date the admin actually picked."""
    if not value:
        return None
    try:
        d = datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid date '{value}', expected YYYY-MM-DD")
    t = time.max if end_of_day else time.min
    return datetime.combine(d, t, tzinfo=timezone.utc)


@router.get("/dashboard")
async def analytics_dashboard(
    start_date: str | None = Query(None, description="YYYY-MM-DD; inclusive lower bound for the custom range"),
    end_date:   str | None = Query(None, description="YYYY-MM-DD; inclusive upper bound for the custom range"),
    admin: User = Depends(require_permission("analytics.view")),
    db: AsyncSession = Depends(get_db),
):
    return await analytics_service.analytics_dashboard(
        db=db,
        start_date=_parse_date_bound(start_date, end_of_day=False),
        end_date=_parse_date_bound(end_date, end_of_day=True),
    )


@router.get("/finance-overview")
async def finance_overview(
    start_date: str | None = Query(None, description="YYYY-MM-DD; restrict flow figures to this window"),
    end_date:   str | None = Query(None, description="YYYY-MM-DD; restrict flow figures to this window"),
    # Company-wide financial overview = sensitive; super_admin-only via a
    # permission no employee role holds (analytics.finance).
    admin: User = Depends(require_permission("analytics.finance")),
    db: AsyncSession = Depends(get_db),
):
    return await analytics_service.finance_overview(
        db=db,
        start_date=_parse_date_bound(start_date, end_of_day=False),
        end_date=_parse_date_bound(end_date, end_of_day=True),
    )


@router.get("/finance-overview/drill")
async def finance_overview_drill(
    section: str = Query(..., description="deposits|withdrawals|pending_deposits|pending_withdrawals|net_credit|fixed_return|trading|commission|swap|pamm_mam|insurance_fees|insurance_payouts|ib_commission|referral|promotional_expenses"),
    method: str | None = Query(None, description="filter deposit/withdrawal rows by method"),
    tenure: str | None = Query(None, description="filter fixed_return locks by tenure label"),
    sort: str = Query("amount", description="amount | gainers | losers (trading only)"),
    start_date: str | None = Query(None),
    end_date:   str | None = Query(None),
    admin: User = Depends(require_permission("analytics.finance")),
    db: AsyncSession = Depends(get_db),
):
    """Per-user drill-down behind a Finance Overview card (super_admin only)."""
    return await analytics_service.finance_overview_drill(
        db=db, section=section, method=method, tenure=tenure, sort=sort,
        start_date=_parse_date_bound(start_date, end_of_day=False),
        end_date=_parse_date_bound(end_date, end_of_day=True),
    )


@router.get("/promotional-expenses")
async def list_promotional_expenses(
    limit: int = Query(100, ge=1, le=500),
    admin: User = Depends(require_permission("analytics.finance")),
    db: AsyncSession = Depends(get_db),
):
    """Recent MANUAL promotional-expense entries (super_admin only)."""
    return await analytics_service.list_promotional_expenses(db=db, limit=limit)


@router.post("/promotional-expenses")
async def add_promotional_expense(
    body: PromotionalExpenseBody,
    admin: User = Depends(require_permission("analytics.finance")),
    db: AsyncSession = Depends(get_db),
):
    """Log a manual promotional give-away (super_admin only)."""
    return await analytics_service.add_promotional_expense(
        db=db, admin_id=admin.id, amount=body.amount,
        category=body.category, note=body.note, user_id=body.user_id,
    )


@router.get("/exposure")
async def get_exposure(
    profitable_sort: str = Query("profit", description="profit | win_rate — ranking for top profitable users"),
    start_date: str | None = Query(None, description="YYYY-MM-DD — restrict the profit/win-rate ranking"),
    end_date: str | None = Query(None, description="YYYY-MM-DD — restrict the profit/win-rate ranking"),
    admin: User = Depends(require_permission("analytics.view")),
    db: AsyncSession = Depends(get_db),
):
    return await analytics_service.get_exposure(
        db=db,
        profitable_sort=profitable_sort,
        start_date=_parse_date_bound(start_date, end_of_day=False),
        end_date=_parse_date_bound(end_date, end_of_day=True),
    )
