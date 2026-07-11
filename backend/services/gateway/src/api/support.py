"""Support Tickets API — Create, list, reply to tickets."""
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.database import get_db
from packages.common.src.auth import get_current_user
from ..services import support_service

router = APIRouter()


class CreateTicketRequest(BaseModel):
    subject: str = Field(min_length=1, max_length=255)
    message: str = Field(min_length=1)
    priority: str = Field(default="medium", pattern="^(low|medium|high|urgent)$")
    # Optional inline attachments (base64 data URLs), same shape as replies —
    # the trader form sends these on the FIRST message too (client 2026-07-08).
    attachments: list | None = None


class ReplyTicketRequest(BaseModel):
    message: str = Field(min_length=1)
    attachments: list | None = None


@router.get("/tickets")
async def list_tickets(
    status: str = Query(None, pattern="^(open|in_progress|resolved|closed)$"),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await support_service.list_tickets(
        user_id=current_user["user_id"], status=status,
        page=page, per_page=per_page, db=db,
    )


@router.post("/tickets", status_code=201)
async def create_ticket(
    req: CreateTicketRequest,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await support_service.create_ticket(
        user_id=current_user["user_id"], subject=req.subject,
        message=req.message, priority=req.priority,
        attachments=req.attachments, db=db,
    )


@router.get("/tickets/{ticket_id}")
async def get_ticket(
    ticket_id: UUID,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await support_service.get_ticket(
        user_id=current_user["user_id"], ticket_id=ticket_id, db=db,
    )


@router.post("/tickets/{ticket_id}/reply", status_code=201)
async def reply_ticket(
    ticket_id: UUID,
    req: ReplyTicketRequest,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await support_service.reply_ticket(
        user_id=current_user["user_id"], ticket_id=ticket_id,
        message_text=req.message, attachments=req.attachments, db=db,
    )
