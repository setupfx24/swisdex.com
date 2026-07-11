"""Employee task assignment + daily reports (client 2026-06-16).

Flow:
  * A manager (tasks.assign) assigns a task to an employee.
  * The employee sees their tasks (GET /my) and marks each Done or Undone;
    Undone requires a reason ("kya reh gaya / kyun nahi hua").
  * Managers (tasks.view_all) review everyone's tasks = the daily reports.
Every employee can see + update their OWN tasks without any permission.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.database import get_db
from packages.common.src.models import EmployeeTask, Employee, User
from dependencies import get_current_admin, require_permission, write_audit_log

router = APIRouter()


class TaskCreate(BaseModel):
    assigned_to: uuid.UUID
    title: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    due_date: Optional[date] = None


class TaskUpdate(BaseModel):
    status: str  # 'done' | 'undone' | 'pending'
    undone_reason: Optional[str] = None


def _task_out(t: EmployeeTask, *, who: dict | None = None) -> dict:
    return {
        "id": str(t.id),
        "assigned_by": str(t.assigned_by) if t.assigned_by else None,
        "assigned_to": str(t.assigned_to),
        "title": t.title,
        "description": t.description,
        "due_date": t.due_date.isoformat() if t.due_date else None,
        "status": t.status,
        "undone_reason": t.undone_reason,
        "completed_at": t.completed_at.isoformat() if t.completed_at else None,
        "created_at": t.created_at.isoformat() if t.created_at else None,
        **(who or {}),
    }


async def _name_map(db: AsyncSession, user_ids: list) -> dict:
    ids = [u for u in {str(x) for x in user_ids if x}]
    if not ids:
        return {}
    rows = (await db.execute(
        select(User.id, User.first_name, User.last_name, User.email).where(User.id.in_(ids))
    )).all()
    return {
        str(r[0]): {
            "name": " ".join(filter(None, [r[1], r[2]])).strip() or r[3],
            "email": r[3],
        }
        for r in rows
    }


@router.post("")
async def assign_task(
    body: TaskCreate,
    request: Request,
    admin: User = Depends(require_permission("tasks.assign")),
    db: AsyncSession = Depends(get_db),
):
    """Assign a task to an employee (super-admin → anyone; managers with
    tasks.assign → employees)."""
    task = EmployeeTask(
        assigned_by=admin.id,
        assigned_to=body.assigned_to,
        title=body.title.strip(),
        description=(body.description or "").strip() or None,
        due_date=body.due_date,
        status="pending",
    )
    db.add(task)
    await write_audit_log(
        db, admin.id, "assign_task", "employee_task", task.id,
        new_values={"assigned_to": str(body.assigned_to), "title": body.title},
        ip_address=request.client.host if request.client else None,
    )
    await db.commit()
    return {"message": "Task assigned", "id": str(task.id)}


@router.get("/my")
async def my_tasks(
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """The logged-in employee's own tasks (their daily to-do)."""
    rows = (await db.execute(
        select(EmployeeTask)
        .where(EmployeeTask.assigned_to == admin.id)
        .order_by(desc(EmployeeTask.created_at))
        .limit(500)
    )).scalars().all()
    who = await _name_map(db, [t.assigned_by for t in rows])
    return {"items": [
        {**_task_out(t), "assigned_by_name": who.get(str(t.assigned_by), {}).get("name")}
        for t in rows
    ]}


@router.patch("/{task_id}")
async def update_task_status(
    task_id: uuid.UUID,
    body: TaskUpdate,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Employee marks their task Done or Undone (+reason). Only the assignee."""
    task = (await db.execute(
        select(EmployeeTask).where(EmployeeTask.id == task_id).with_for_update()
    )).scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.assigned_to != admin.id:
        raise HTTPException(status_code=403, detail="You can only update tasks assigned to you")

    status = (body.status or "").lower()
    if status not in ("pending", "done", "undone"):
        raise HTTPException(status_code=400, detail="status must be pending, done or undone")
    if status == "undone" and not (body.undone_reason or "").strip():
        raise HTTPException(status_code=400, detail="Please add a reason for an undone task")

    task.status = status
    task.undone_reason = (body.undone_reason or "").strip() or None if status == "undone" else None
    task.completed_at = datetime.now(timezone.utc) if status == "done" else None
    await db.commit()
    return {"message": "Updated", "status": status}


@router.get("")
async def list_all_tasks(
    assigned_to: Optional[uuid.UUID] = Query(default=None),
    status: Optional[str] = Query(default=None),
    on_date: Optional[date] = Query(default=None, description="Filter to tasks created on this date (daily report)"),
    admin: User = Depends(require_permission("tasks.view_all")),
    db: AsyncSession = Depends(get_db),
):
    """Reports view — admin/super-admin see all employees' tasks (the daily
    reports). Filter by employee, status, or date."""
    stmt = select(EmployeeTask).order_by(desc(EmployeeTask.created_at)).limit(1000)
    if assigned_to is not None:
        stmt = stmt.where(EmployeeTask.assigned_to == assigned_to)
    if status in ("pending", "done", "undone"):
        stmt = stmt.where(EmployeeTask.status == status)
    if on_date is not None:
        stmt = stmt.where(EmployeeTask.created_at >= datetime.combine(on_date, datetime.min.time()))
        stmt = stmt.where(EmployeeTask.created_at < datetime.combine(on_date, datetime.max.time()))
    rows = (await db.execute(stmt)).scalars().all()
    who = await _name_map(db, [t.assigned_to for t in rows] + [t.assigned_by for t in rows])
    return {"items": [
        {
            **_task_out(t),
            "assigned_to_name": who.get(str(t.assigned_to), {}).get("name"),
            "assigned_to_email": who.get(str(t.assigned_to), {}).get("email"),
            "assigned_by_name": who.get(str(t.assigned_by), {}).get("name"),
        }
        for t in rows
    ]}


@router.get("/assignable-employees")
async def assignable_employees(
    admin: User = Depends(require_permission("tasks.assign")),
    db: AsyncSession = Depends(get_db),
):
    """Employees a manager can assign tasks to (active employees, excluding
    the manager themselves — client 2026-06-20: an employee could assign work
    to their own self)."""
    rows = (await db.execute(
        select(Employee.user_id, Employee.role, User.first_name, User.last_name, User.email)
        .join(User, User.id == Employee.user_id)
        .where(Employee.is_active == True, Employee.user_id != admin.id)
    )).all()
    return {"items": [
        {
            "user_id": str(r[0]),
            "role": r[1],
            "name": " ".join(filter(None, [r[2], r[3]])).strip() or r[4],
            "email": r[4],
        }
        for r in rows
    ]}
