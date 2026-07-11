"""SwisDex company expense ledger — Tally/Excel-style CRUD.

Admin records the broker's own operating expenses (Date, Name, Amount, Reason,
Result) and they persist as a running book. Super-admin gated (analytics.finance),
same as Finance Overview, since it's company financial data.
"""
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.database import get_db
from packages.common.src.models import CompanyExpense, User
from dependencies import require_permission, write_audit_log

router = APIRouter(prefix="/expenses", tags=["Company Expenses"])


class ExpenseBody(BaseModel):
    expense_date: date = Field(description="YYYY-MM-DD")
    name: str = Field(min_length=1, max_length=200)
    amount: float = Field(gt=0)
    reason: Optional[str] = None
    result: Optional[str] = None


def _row(e: CompanyExpense) -> dict:
    return {
        "id": str(e.id),
        "expense_date": e.expense_date.isoformat() if e.expense_date else None,
        "name": e.name,
        "amount": float(e.amount or 0),
        "reason": e.reason,
        "result": e.result,
        "created_at": e.created_at.isoformat() if e.created_at else None,
    }


@router.get("")
async def list_expenses(
    start_date: Optional[date] = Query(None),
    end_date: Optional[date] = Query(None),
    admin: User = Depends(require_permission("analytics.finance")),
    db: AsyncSession = Depends(get_db),
):
    """List expenses (newest first) + the total for the (optionally filtered) set."""
    q = select(CompanyExpense)
    if start_date is not None:
        q = q.where(CompanyExpense.expense_date >= start_date)
    if end_date is not None:
        q = q.where(CompanyExpense.expense_date <= end_date)
    rows = (await db.execute(
        q.order_by(CompanyExpense.expense_date.desc(), CompanyExpense.created_at.desc())
    )).scalars().all()
    total = float(sum((e.amount or Decimal("0")) for e in rows))
    return {"items": [_row(e) for e in rows], "total": round(total, 2), "count": len(rows)}


@router.post("")
async def create_expense(
    body: ExpenseBody,
    admin: User = Depends(require_permission("analytics.finance")),
    db: AsyncSession = Depends(get_db),
):
    try:
        amt = Decimal(str(body.amount))
    except (InvalidOperation, TypeError):
        raise HTTPException(status_code=400, detail="Invalid amount")
    e = CompanyExpense(
        expense_date=body.expense_date,
        name=body.name.strip(),
        amount=amt,
        reason=(body.reason or None),
        result=(body.result or None),
        created_by=admin.id,
    )
    db.add(e)
    await db.flush()
    await write_audit_log(
        db, admin.id, "company_expense_add", "company_expense", e.id,
        new_values={"name": e.name, "amount": str(amt), "date": body.expense_date.isoformat()},
    )
    await db.commit()
    return _row(e)


@router.put("/{expense_id}")
async def update_expense(
    expense_id: UUID,
    body: ExpenseBody,
    admin: User = Depends(require_permission("analytics.finance")),
    db: AsyncSession = Depends(get_db),
):
    e = (await db.execute(
        select(CompanyExpense).where(CompanyExpense.id == expense_id)
    )).scalar_one_or_none()
    if not e:
        raise HTTPException(status_code=404, detail="Expense not found")
    e.expense_date = body.expense_date
    e.name = body.name.strip()
    e.amount = Decimal(str(body.amount))
    e.reason = body.reason or None
    e.result = body.result or None
    await write_audit_log(
        db, admin.id, "company_expense_update", "company_expense", e.id,
        new_values={"name": e.name, "amount": str(e.amount)},
    )
    await db.commit()
    return _row(e)


@router.delete("/{expense_id}")
async def delete_expense(
    expense_id: UUID,
    admin: User = Depends(require_permission("analytics.finance")),
    db: AsyncSession = Depends(get_db),
):
    e = (await db.execute(
        select(CompanyExpense).where(CompanyExpense.id == expense_id)
    )).scalar_one_or_none()
    if not e:
        raise HTTPException(status_code=404, detail="Expense not found")
    await write_audit_log(
        db, admin.id, "company_expense_delete", "company_expense", e.id,
        old_values={"name": e.name, "amount": str(e.amount)},
    )
    await db.delete(e)
    await db.commit()
    return {"deleted": True, "id": str(expense_id)}
