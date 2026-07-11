import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.database import get_db
from dependencies import require_permission, get_current_admin, resolve_employee_permissions
from packages.common.src.models import User
from packages.common.src.admin_schemas import TicketReplyRequest, TicketStatusUpdate, TicketAssignRequest
from services import support_service

router = APIRouter(prefix="/support", tags=["Support"])


@router.get("/tickets")
async def list_tickets(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    status_filter: str = Query(None, alias="status"),
    priority_filter: str = Query(None, alias="priority"),
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    # An employee with a ticket ASSIGNED to them must see it even if they don't
    # have the broad tickets.view (client 2026-06-23/24: assigned ticket wasn't
    # showing on the assignee's dashboard). Managers (tickets.view / *) see
    # everything; everyone else is scoped to their OWN assigned tickets — no
    # hard 403, so an assignee never gets locked out of their own queue.
    perms = await resolve_employee_permissions(admin, db)
    can_view_all = "*" in perms or "tickets.view" in perms
    return await support_service.list_tickets(
        page=page, per_page=per_page,
        status_filter=status_filter, priority_filter=priority_filter,
        assigned_to=None if can_view_all else admin.id, db=db,
    )


@router.get("/tickets/{ticket_id}")
async def get_ticket_detail(
    ticket_id: uuid.UUID,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    perms = await resolve_employee_permissions(admin, db)
    can_view_all = "*" in perms or "tickets.view" in perms
    detail = await support_service.get_ticket_detail(ticket_id=ticket_id, db=db)
    if not can_view_all:
        # An assignee can always OPEN their own assigned ticket to read it.
        # Posting a reply still requires tickets.reply (enforced on /reply),
        # so this only gates VIEW access (client 2026-06-24).
        # detail is a TicketDetailOut (Pydantic) — assigned_to lives on
        # detail.ticket, NOT detail.get(...) which 500'd for every assigned
        # employee (client 2026-07-08).
        if str(getattr(detail.ticket, "assigned_to", None) or "") != str(admin.id):
            raise HTTPException(status_code=403, detail="You can only open tickets assigned to you")
    return detail


@router.post("/tickets/{ticket_id}/reply")
async def reply_to_ticket(
    ticket_id: uuid.UUID,
    body: TicketReplyRequest,
    request: Request,
    admin: User = Depends(require_permission("tickets.reply")),
    db: AsyncSession = Depends(get_db),
):
    return await support_service.reply_to_ticket(
        ticket_id=ticket_id, body=body, admin_id=admin.id,
        ip_address=request.client.host if request.client else None, db=db,
    )


@router.put("/tickets/{ticket_id}/assign")
async def assign_ticket(
    ticket_id: uuid.UUID,
    body: TicketAssignRequest,
    request: Request,
    admin: User = Depends(require_permission("tickets.assign")),
    db: AsyncSession = Depends(get_db),
):
    return await support_service.assign_ticket(
        ticket_id=ticket_id, body=body, admin_id=admin.id,
        ip_address=request.client.host if request.client else None, db=db,
    )


@router.put("/tickets/{ticket_id}/status")
async def update_ticket_status(
    ticket_id: uuid.UUID,
    body: TicketStatusUpdate,
    request: Request,
    admin: User = Depends(require_permission("tickets.assign")),
    db: AsyncSession = Depends(get_db),
):
    return await support_service.update_ticket_status(
        ticket_id=ticket_id, body=body, admin_id=admin.id,
        ip_address=request.client.host if request.client else None, db=db,
    )
