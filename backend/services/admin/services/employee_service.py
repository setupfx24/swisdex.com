"""Admin Employee Service — CRUD, activity logs, login-as."""
import uuid
from datetime import datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.auth import hash_password
from packages.common.src.models import User, Employee, AuditLog, EmployeeCustomRole
from packages.common.src.admin_schemas import (
    EmployeeIn, EmployeeUpdate, AuditLogOut, PaginatedResponse,
)
from dependencies import write_audit_log

VALID_EMPLOYEE_ROLES = [
    "super_admin", "trade_manager", "support", "finance", "risk_manager", "marketing", "rm",
    "deposit_manager", "withdrawal_manager",
]


async def _is_valid_role(role: str, db: AsyncSession) -> bool:
    """A role is valid if it's a built-in role OR a super-admin-defined custom
    role (client 2026-06-16)."""
    if role in VALID_EMPLOYEE_ROLES:
        return True
    found = (await db.execute(
        select(EmployeeCustomRole.id).where(EmployeeCustomRole.name == role)
    )).first()
    return found is not None


async def list_employees(db: AsyncSession) -> dict:
    result = await db.execute(select(Employee).order_by(Employee.created_at.desc()))
    employees = result.scalars().all()

    items = []
    for emp in employees:
        user_q = await db.execute(select(User).where(User.id == emp.user_id))
        user = user_q.scalar_one_or_none()
        full_name = f"{user.first_name or ''} {user.last_name or ''}".strip() if user else ""
        items.append({
            "id": str(emp.id),
            "user_id": str(emp.user_id),
            "role": emp.role,
            "is_active": emp.is_active,
            # A soft-deleted employee keeps its row (so its info stays visible)
            # but the linked user is demoted + terminated. Surface that as a
            # distinct "deleted" flag so the UI shows "Deleted", not just
            # "Inactive" (client 2026-06-20).
            "deleted": (getattr(user, "status", None) == "terminated") if user else False,
            "created_at": emp.created_at.isoformat() if emp.created_at else None,
            "email": user.email if user else None,
            "full_name": full_name,
            "first_name": user.first_name if user else None,
            "last_name": user.last_name if user else None,
            "phone": user.phone if user else None,
            "extra_permissions": list(getattr(emp, 'extra_permissions', None) or []),
        })
    return {"employees": items}


async def create_employee(
    body: EmployeeIn,
    admin: User,
    ip_address: str | None,
    db: AsyncSession,
) -> dict:
    if admin.role != "super_admin":
        raise HTTPException(status_code=403, detail="Only super admins can create employees")

    if not await _is_valid_role(body.role, db):
        raise HTTPException(status_code=400, detail=f"Invalid role. Built-in: {VALID_EMPLOYEE_ROLES}, or a custom role.")

    existing_q = await db.execute(select(User).where(User.email == body.email))
    if existing_q.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Email already in use")

    import secrets
    raw_password = body.password or secrets.token_urlsafe(12)
    password_hash = hash_password(raw_password)

    first_name = body.first_name
    last_name = body.last_name
    if not first_name and body.full_name:
        parts = body.full_name.strip().split(" ", 1)
        first_name = parts[0]
        last_name = parts[1] if len(parts) > 1 else ""

    user = User(
        email=body.email,
        password_hash=password_hash,
        first_name=first_name or "",
        last_name=last_name or "",
        phone=body.phone,
        role="admin",
        status="active",
        kyc_status="approved",
    )
    db.add(user)
    await db.flush()

    employee = Employee(
        user_id=user.id,
        role=body.role,
        is_active=True,
    )
    db.add(employee)
    await db.flush()

    await write_audit_log(
        db, admin.id, "create_employee", "employee", employee.id,
        new_values={"email": body.email, "role": body.role},
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": "Employee created", "id": str(employee.id), "user_id": str(user.id), "password": raw_password}


async def update_employee(
    employee_id: uuid.UUID,
    body: EmployeeUpdate,
    admin: User,
    ip_address: str | None,
    db: AsyncSession,
) -> dict:
    if admin.role != "super_admin":
        raise HTTPException(status_code=403, detail="Only super admins can update employees")

    result = await db.execute(select(Employee).where(Employee.id == employee_id))
    employee = result.scalar_one_or_none()
    if not employee:
        raise HTTPException(status_code=404, detail="Employee not found")

    old_values = {"role": employee.role, "is_active": employee.is_active}

    if body.role is not None:
        if not await _is_valid_role(body.role, db):
            raise HTTPException(status_code=400, detail=f"Invalid role. Built-in: {VALID_EMPLOYEE_ROLES}, or a custom role.")
        employee.role = body.role

    if body.is_active is not None:
        employee.is_active = body.is_active

    user_q = await db.execute(select(User).where(User.id == employee.user_id))
    user = user_q.scalar_one_or_none()
    if user:
        # The admin UI sends a single full_name — split it into first/last so
        # the name actually updates (it was being ignored before).
        if body.full_name is not None and body.full_name.strip():
            parts = body.full_name.strip().split(" ", 1)
            user.first_name = parts[0]
            user.last_name = parts[1] if len(parts) > 1 else ""
        if body.first_name is not None:
            user.first_name = body.first_name
        if body.last_name is not None:
            user.last_name = body.last_name

    await write_audit_log(
        db, admin.id, "update_employee", "employee", employee_id,
        old_values=old_values,
        new_values={"role": employee.role, "is_active": employee.is_active},
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": "Employee updated"}


async def delete_employee(
    employee_id: uuid.UUID,
    admin: User,
    ip_address: str | None,
    db: AsyncSession,
) -> dict:
    """Remove an employee from the active roster while KEEPING their record.

    Client 2026-06-20: a deleted employee's information must still be visible.
    So we SOFT-delete — set Employee.is_active=False (the row stays so the admin
    can still see who they were, their role and activity) and demote the linked
    user out of admin (role=user, status=terminated, sessions revoked) so they
    lose all access. The frontend marks is_active=False employees as "Deleted".
    (We don't drop the users row either — audit_logs / tickets FK it.)
    """
    if admin.role != "super_admin":
        raise HTTPException(status_code=403, detail="Only super admins can delete employees")

    result = await db.execute(select(Employee).where(Employee.id == employee_id))
    employee = result.scalar_one_or_none()
    if not employee:
        raise HTTPException(status_code=404, detail="Employee not found")

    # Guard: deleting your own employee record would lock you out.
    if employee.user_id == admin.id:
        raise HTTPException(status_code=400, detail="You cannot delete your own account")

    user_q = await db.execute(select(User).where(User.id == employee.user_id))
    user = user_q.scalar_one_or_none()
    user_email = user.email if user else None

    employee.is_active = False  # soft delete — keep the record visible
    if user:
        user.role = "user"
        user.status = "terminated"
        # Revoke any live admin sessions for this account.
        if hasattr(user, "password_epoch"):
            user.password_epoch = (user.password_epoch or 0) + 1

    await write_audit_log(
        db, admin.id, "delete_employee", "employee", employee_id,
        new_values={"deleted": True, "email": user_email, "demoted_to": "user", "status": "terminated"},
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": "Employee deleted"}


async def get_employee_activity(
    employee_id: uuid.UUID,
    page: int,
    per_page: int,
    db: AsyncSession,
) -> PaginatedResponse:
    result = await db.execute(select(Employee).where(Employee.id == employee_id))
    employee = result.scalar_one_or_none()
    if not employee:
        raise HTTPException(status_code=404, detail="Employee not found")

    query = select(AuditLog).where(AuditLog.admin_id == employee.user_id)

    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0

    query = query.order_by(AuditLog.created_at.desc()).offset((page - 1) * per_page).limit(per_page)
    result = await db.execute(query)
    logs = result.scalars().all()

    items = [
        AuditLogOut(
            id=str(log.id),
            admin_id=str(log.admin_id),
            action=log.action,
            entity_type=log.entity_type,
            entity_id=str(log.entity_id) if log.entity_id else None,
            old_values=log.old_values,
            new_values=log.new_values,
            ip_address=str(log.ip_address) if log.ip_address else None,
            created_at=log.created_at,
        )
        for log in logs
    ]

    return PaginatedResponse(items=items, total=total, page=page, per_page=per_page)


async def get_employee_permissions(employee_id: uuid.UUID, db: AsyncSession) -> dict:
    result = await db.execute(select(Employee).where(Employee.id == employee_id))
    emp = result.scalar_one_or_none()
    if not emp:
        raise HTTPException(status_code=404, detail="Employee not found")
    return {
        "employee_id": str(emp.id),
        "role": emp.role,
        "extra_permissions": list(emp.extra_permissions or []),
    }


async def update_employee_permissions(
    employee_id: uuid.UUID,
    extra_permissions: list,
    admin: User,
    ip_address: str | None,
    db: AsyncSession,
) -> dict:
    if admin.role != "super_admin":
        raise HTTPException(status_code=403, detail="Only super admins can edit permissions")
    result = await db.execute(select(Employee).where(Employee.id == employee_id))
    emp = result.scalar_one_or_none()
    if not emp:
        raise HTTPException(status_code=404, detail="Employee not found")
    old_perms = list(emp.extra_permissions or [])
    clean = sorted({str(p).strip() for p in extra_permissions if str(p).strip()})
    emp.extra_permissions = clean
    await write_audit_log(
        db, admin.id, "update_employee_permissions", "employee", emp.id,
        old_values={"extra_permissions": old_perms},
        new_values={"extra_permissions": clean},
        ip_address=ip_address,
    )
    await db.commit()
    return {"employee_id": str(emp.id), "extra_permissions": clean}


async def login_as_employee(
    employee_id: uuid.UUID,
    admin: User,
    ip_address: str | None,
    db: AsyncSession,
) -> dict:
    if admin.role != "super_admin":
        raise HTTPException(status_code=403, detail="Only super admins can login as employees")

    result = await db.execute(select(Employee).where(Employee.id == employee_id))
    employee = result.scalar_one_or_none()
    if not employee:
        raise HTTPException(status_code=404, detail="Employee not found")

    user_q = await db.execute(select(User).where(User.id == employee.user_id))
    user = user_q.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="Employee user not found")

    import jwt
    from packages.common.src.config import get_settings
    settings = get_settings()

    expire = datetime.utcnow() + timedelta(hours=8)
    payload = {
        "admin_id": str(user.id),
        "role": user.role,
        "type": "admin",
        "employee_role": employee.role,
        "impersonated_by": str(admin.id),
        "exp": expire,
        "iat": datetime.utcnow(),
    }
    token = jwt.encode(payload, settings.ADMIN_JWT_SECRET, algorithm=settings.ADMIN_JWT_ALGORITHM)

    await write_audit_log(
        db, admin.id, "login_as_employee", "employee", employee_id,
        new_values={"employee_email": user.email, "employee_role": employee.role},
        ip_address=ip_address,
    )
    await db.commit()

    return {
        "access_token": token,
        "token_type": "bearer",
        "employee_email": user.email,
        "employee_role": employee.role,
    }
