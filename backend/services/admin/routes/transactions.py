from datetime import datetime, time, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.database import get_db
from dependencies import require_permission
from packages.common.src.models import User
from services import transaction_service

router = APIRouter(prefix="/transactions", tags=["Transactions"])


def _date_bound(value: str | None, *, end_of_day: bool):
    """Parse YYYY-MM-DD → UTC datetime (start or end of day). None passes through."""
    if not value:
        return None
    try:
        d = datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        return None
    return datetime.combine(d, time.max if end_of_day else time.min, tzinfo=timezone.utc)


@router.get("")
async def list_transactions(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    type_filter: str = Query(None, alias="type"),
    search: str = Query(None),
    start_date: str | None = Query(None),
    end_date: str | None = Query(None),
    exclude: str | None = Query(None, description="Comma-separated transaction types to exclude (e.g. trading)"),
    only: str | None = Query(None, description="Comma-separated WHITELIST of types — show ONLY these (e.g. deposit,withdrawal)"),
    admin: User = Depends(require_permission("deposits.view")),
    db: AsyncSession = Depends(get_db),
):
    exclude_types = [t.strip() for t in exclude.split(",") if t.strip()] if exclude else None
    include_types = [t.strip() for t in only.split(",") if t.strip()] if only else None
    return await transaction_service.list_transactions(
        page=page, per_page=per_page, type_filter=type_filter, search=search, db=db,
        start_date=_date_bound(start_date, end_of_day=False),
        end_date=_date_bound(end_date, end_of_day=True),
        exclude_types=exclude_types,
        include_types=include_types,
    )


@router.get("/summary")
async def transaction_summary(
    admin: User = Depends(require_permission("deposits.view")),
    db: AsyncSession = Depends(get_db),
):
    return await transaction_service.get_transaction_summary(db=db)
