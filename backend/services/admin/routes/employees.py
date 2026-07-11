import uuid

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.database import get_db
from dependencies import get_current_admin, EMPLOYEE_ROLE_PERMISSIONS
from packages.common.src.models import User, EmployeeCustomRole, Employee
from packages.common.src.admin_schemas import EmployeeIn, EmployeeUpdate
from services import employee_service

router = APIRouter(prefix="/employees", tags=["Employees"])


# Static catalog of permissions the admin UI renders as checkboxes. Keep in sync
# with require_permission() call sites across the admin backend.
PERMISSION_CATALOG = {
    # Client 2026-06-20: the catalog was missing several permissions the
    # backend actually checks (users.delete, funds.approve, config.*,
    # analytics.finance, settings.*, insurance.manage, trades.manage,
    # users.impersonate), so an admin could not grant the matching access and
    # the relevant sidebar pages (Approvals, Config, Finance Overview, …) never
    # appeared for any custom-role employee. Now every require_permission() key
    # is grantable here.
    "Users":       ["users.view", "users.add_fund", "users.deduct_fund", "users.ban", "users.block_trading", "users.kill_switch", "users.set_password", "users.delete", "users.impersonate"],
    "KYC":         ["kyc.view", "kyc.manage"],
    "Deposits":    ["deposits.view", "deposits.approve", "deposits.reject"],
    "Withdrawals": ["withdrawals.view", "withdrawals.approve", "withdrawals.reject"],
    "Approvals":   ["funds.approve"],
    "Trading":     ["trades.view", "trades.modify", "trades.close", "trades.create", "trades.manage", "positions.view", "orders.view"],
    "Social":      ["social.view", "social.manage"],
    "Banks":       ["banks.view", "banks.create", "banks.update"],
    "IB":          ["ib.view", "ib.manage"],
    "Insurance":   ["insurance.manage"],
    "Marketing":   ["banners.view", "banners.create", "banners.update", "banners.delete", "bonus.view", "bonus.create", "bonus.update"],
    "Support":     ["tickets.view", "tickets.reply", "tickets.assign"],
    "Analytics":   ["analytics.view", "analytics.finance", "exposure.view"],
    "Config":      ["config.view", "config.update"],
    "Settings":    ["settings.update", "settings.manage"],
    "Audit":       ["audit_logs.view"],
    "RM":          ["rm.view", "rm.request", "rm.manage", "rm.assign"],
    "Fixed Return": ["fixed_return.view", "fixed_return.manage"],
    # Task assignment + daily reports (client 2026-06-16). tasks.assign lets an
    # employee assign work + see all reports; every employee sees/updates their
    # OWN tasks without any permission.
    "Tasks":       ["tasks.assign", "tasks.view_all"],
}


@router.get("")
async def list_employees(
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    return await employee_service.list_employees(db=db)


@router.post("")
async def create_employee(
    body: EmployeeIn,
    request: Request,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    return await employee_service.create_employee(
        body=body, admin=admin,
        ip_address=request.client.host if request.client else None, db=db,
    )


@router.put("/{employee_id}")
async def update_employee(
    employee_id: uuid.UUID,
    body: EmployeeUpdate,
    request: Request,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    return await employee_service.update_employee(
        employee_id=employee_id, body=body, admin=admin,
        ip_address=request.client.host if request.client else None, db=db,
    )


@router.delete("/{employee_id}")
async def delete_employee(
    employee_id: uuid.UUID,
    request: Request,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    return await employee_service.delete_employee(
        employee_id=employee_id, admin=admin,
        ip_address=request.client.host if request.client else None, db=db,
    )


@router.get("/{employee_id}/activity")
async def get_employee_activity(
    employee_id: uuid.UUID,
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    return await employee_service.get_employee_activity(
        employee_id=employee_id, page=page, per_page=per_page, db=db,
    )


@router.get("/permissions/catalog")
async def list_permission_catalog(admin: User = Depends(get_current_admin)):
    """Return the full permission catalog + role defaults for the admin UI."""
    return {
        "catalog": PERMISSION_CATALOG,
        "role_defaults": {role: sorted(perms) for role, perms in EMPLOYEE_ROLE_PERMISSIONS.items()},
    }


# ─── Custom employee roles (super-admin defined, reusable) ───────────────
class CustomRoleIn(BaseModel):
    name: str
    permissions: list[str] = []


@router.get("/roles")
async def list_custom_roles(
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    rows = (await db.execute(
        select(EmployeeCustomRole).order_by(EmployeeCustomRole.name)
    )).scalars().all()
    return {"items": [
        {"id": str(r.id), "name": r.name, "permissions": list(r.permissions or [])}
        for r in rows
    ]}


@router.post("/roles")
async def create_custom_role(
    body: CustomRoleIn,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    if admin.role != "super_admin":
        raise HTTPException(status_code=403, detail="Only super admins can manage roles")
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Role name is required")
    if name in EMPLOYEE_ROLE_PERMISSIONS:
        raise HTTPException(status_code=400, detail="That name is a built-in role — choose another")
    role = EmployeeCustomRole(name=name, permissions=list(body.permissions or []), created_by=admin.id)
    db.add(role)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="A role with that name already exists")
    return {"id": str(role.id), "name": role.name}


@router.put("/roles/{role_id}")
async def update_custom_role(
    role_id: uuid.UUID,
    body: CustomRoleIn,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    if admin.role != "super_admin":
        raise HTTPException(status_code=403, detail="Only super admins can manage roles")
    role = (await db.execute(
        select(EmployeeCustomRole).where(EmployeeCustomRole.id == role_id)
    )).scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=404, detail="Role not found")
    role.permissions = list(body.permissions or [])
    await db.commit()
    return {"message": "Role updated"}


@router.delete("/roles/{role_id}")
async def delete_custom_role(
    role_id: uuid.UUID,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    if admin.role != "super_admin":
        raise HTTPException(status_code=403, detail="Only super admins can manage roles")
    role = (await db.execute(
        select(EmployeeCustomRole).where(EmployeeCustomRole.id == role_id)
    )).scalar_one_or_none()
    if not role:
        raise HTTPException(status_code=404, detail="Role not found")
    in_use = (await db.execute(
        select(func.count()).select_from(Employee).where(Employee.role == role.name)
    )).scalar() or 0
    if in_use:
        raise HTTPException(status_code=409, detail=f"{in_use} employee(s) still use this role — reassign them first")
    await db.delete(role)
    await db.commit()
    return {"message": "Role deleted"}


@router.get("/{employee_id}/permissions")
async def get_employee_permissions(
    employee_id: uuid.UUID,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    return await employee_service.get_employee_permissions(employee_id=employee_id, db=db)


@router.put("/{employee_id}/permissions")
async def update_employee_permissions(
    employee_id: uuid.UUID,
    request: Request,
    body: dict = Body(...),
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    perms = body.get("extra_permissions") or []
    if not isinstance(perms, list):
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="extra_permissions must be a list of strings")
    return await employee_service.update_employee_permissions(
        employee_id=employee_id, extra_permissions=perms, admin=admin,
        ip_address=request.client.host if request.client else None, db=db,
    )


@router.post("/{employee_id}/login-as")
async def login_as_employee(
    employee_id: uuid.UUID,
    request: Request,
    response: Response,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    out = await employee_service.login_as_employee(
        employee_id=employee_id, admin=admin,
        ip_address=request.client.host if request.client else None, db=db,
    )
    # Mirror /auth/login: bake the impersonation JWT into the same
    # httpOnly swisdex_admin cookie the rest of the admin app reads from.
    token = out.get("access_token") if isinstance(out, dict) else getattr(out, "access_token", None)
    if token:
        from .auth import _set_admin_cookie  # local import avoids circular at module load
        _set_admin_cookie(response, request, token)
    return out
