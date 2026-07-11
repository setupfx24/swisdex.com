"""Admin Support Service — tickets listing, detail, reply, assign, status."""
import uuid
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.models import User, SupportTicket, TicketMessage
from packages.common.src.admin_schemas import (
    TicketOut, TicketDetailOut, TicketMessageOut, PaginatedResponse,
    TicketReplyRequest, TicketStatusUpdate, TicketAssignRequest,
)
from dependencies import write_audit_log


def _ticket_to_out(t: SupportTicket, user: User = None, msg_count: int = 0,
                   assignee: User = None) -> TicketOut:
    assigned_name = None
    if assignee:
        assigned_name = (
            f"{assignee.first_name or ''} {assignee.last_name or ''}".strip()
            or assignee.email
        )
    return TicketOut(
        id=str(t.id),
        user_id=str(t.user_id),
        subject=t.subject,
        status=t.status,
        priority=t.priority,
        assigned_to=str(t.assigned_to) if t.assigned_to else None,
        assigned_name=assigned_name,
        created_at=t.created_at,
        updated_at=t.updated_at,
        user_email=user.email if user else None,
        user_name=f"{user.first_name or ''} {user.last_name or ''}".strip() if user else None,
        message_count=msg_count,
    )


async def list_tickets(
    page: int,
    per_page: int,
    status_filter: str | None,
    priority_filter: str | None,
    db: AsyncSession,
    assigned_to: uuid.UUID | None = None,
) -> PaginatedResponse:
    query = select(SupportTicket)
    if status_filter:
        query = query.where(SupportTicket.status == status_filter)
    if priority_filter:
        query = query.where(SupportTicket.priority == priority_filter)
    # Reply-only employees only see tickets assigned to them (client 2026-06-23).
    if assigned_to is not None:
        query = query.where(SupportTicket.assigned_to == assigned_to)

    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0

    query = query.order_by(SupportTicket.updated_at.desc()).offset((page - 1) * per_page).limit(per_page)
    result = await db.execute(query)
    tickets = result.scalars().all()

    items = []
    for t in tickets:
        user_q = await db.execute(select(User).where(User.id == t.user_id))
        user = user_q.scalar_one_or_none()

        # Assigned employee (assigned_to is a FK to users.id) so the list can
        # show WHO it's assigned to instead of always "—". Without this the
        # frontend's `assigned_name` was undefined → every ticket read
        # "not assigned" even after assignment (client 2026-07-08).
        assignee = None
        if t.assigned_to:
            assignee = (await db.execute(
                select(User).where(User.id == t.assigned_to)
            )).scalar_one_or_none()

        msg_count_q = await db.execute(
            select(func.count(TicketMessage.id)).where(TicketMessage.ticket_id == t.id)
        )
        msg_count = msg_count_q.scalar() or 0

        items.append(_ticket_to_out(t, user, msg_count, assignee))

    return PaginatedResponse(items=items, total=total, page=page, per_page=per_page)


async def get_ticket_detail(ticket_id: uuid.UUID, db: AsyncSession) -> TicketDetailOut:
    result = await db.execute(select(SupportTicket).where(SupportTicket.id == ticket_id))
    ticket = result.scalar_one_or_none()
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")

    user_q = await db.execute(select(User).where(User.id == ticket.user_id))
    user = user_q.scalar_one_or_none()

    msg_q = await db.execute(
        select(TicketMessage).where(TicketMessage.ticket_id == ticket_id).order_by(TicketMessage.created_at.asc())
    )
    messages = msg_q.scalars().all()

    msg_count_q = await db.execute(
        select(func.count(TicketMessage.id)).where(TicketMessage.ticket_id == ticket_id)
    )
    msg_count = msg_count_q.scalar() or 0

    msg_items = []
    for m in messages:
        sender_q = await db.execute(select(User).where(User.id == m.sender_id))
        sender = sender_q.scalar_one_or_none()
        msg_items.append(TicketMessageOut(
            id=str(m.id),
            ticket_id=str(m.ticket_id),
            sender_id=str(m.sender_id),
            message=m.message,
            attachments=m.attachments,
            is_admin=m.is_admin or False,
            created_at=m.created_at,
            sender_name=f"{sender.first_name or ''} {sender.last_name or ''}".strip() if sender else None,
        ))

    return TicketDetailOut(
        ticket=_ticket_to_out(ticket, user, msg_count),
        messages=msg_items,
    )


async def reply_to_ticket(
    ticket_id: uuid.UUID,
    body: TicketReplyRequest,
    admin_id: uuid.UUID,
    ip_address: str | None,
    db: AsyncSession,
) -> dict:
    result = await db.execute(select(SupportTicket).where(SupportTicket.id == ticket_id))
    ticket = result.scalar_one_or_none()
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")

    message = TicketMessage(
        ticket_id=ticket_id,
        sender_id=admin_id,
        message=body.message,
        attachments=body.attachments,
        is_admin=True,
    )
    db.add(message)

    if ticket.status == "open":
        ticket.status = "in_progress"
    ticket.updated_at = datetime.utcnow()

    await write_audit_log(
        db, admin_id, "reply_ticket", "support_ticket", ticket_id,
        new_values={"message_length": len(body.message)},
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": "Reply sent successfully"}


async def assign_ticket(
    ticket_id: uuid.UUID,
    body: TicketAssignRequest,
    admin_id: uuid.UUID,
    ip_address: str | None,
    db: AsyncSession,
) -> dict:
    result = await db.execute(select(SupportTicket).where(SupportTicket.id == ticket_id))
    ticket = result.scalar_one_or_none()
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")

    old_assigned = str(ticket.assigned_to) if ticket.assigned_to else None
    # Validate the assignee: parse the UUID and confirm it's a real admin/
    # employee user. assigned_to is a FK to users.id — sending an employees-table
    # PK (or any non-user id) used to raise → HTTP 500. Now a clean 400.
    try:
        assignee_id = uuid.UUID(str(body.admin_id))
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="Invalid assignee id")
    assignee = (await db.execute(
        select(User).where(
            User.id == assignee_id,
            User.role.in_(["admin", "super_admin"]),
        )
    )).scalar_one_or_none()
    if not assignee:
        raise HTTPException(status_code=400, detail="Assignee is not a valid admin/employee")
    ticket.assigned_to = assignee_id
    ticket.updated_at = datetime.utcnow()

    await write_audit_log(
        db, admin_id, "assign_ticket", "support_ticket", ticket_id,
        old_values={"assigned_to": old_assigned},
        new_values={"assigned_to": body.admin_id},
        ip_address=ip_address,
    )

    # Build the assignment-notification email to the assignee (employee) WITH
    # the ticket's attachments, so they can action it straight from their inbox
    # (client 2026-07-09). Assemble the payload NOW, while the session is live —
    # commit expires the ORM attributes, so ticket.user/.messages must be read
    # first. Best-effort: a mail problem must never fail the assignment.
    assign_email = None
    try:
        from html import escape as _escape
        # Every attachment across the ticket's messages (same {name,type,data}
        # base64 shape the mailer's _attach_files consumes).
        ticket_attachments: list = []
        for _m in (ticket.messages or []):
            if isinstance(_m.attachments, list):
                ticket_attachments.extend(_m.attachments)
        try:
            submitter_email = ticket.user.email if ticket.user else None
        except Exception:
            submitter_email = None
        first_msg = ""
        if ticket.messages:
            _ordered = sorted(ticket.messages, key=lambda mm: mm.created_at or datetime.min)
            first_msg = (_ordered[0].message or "") if _ordered else ""
        if assignee.email:
            _subj = ticket.subject or "Support ticket"
            _n = len(ticket_attachments)
            _html = (
                "<p>A support ticket has been <b>assigned to you</b> on SwisDex.</p>"
                f"<p><b>Subject:</b> {_escape(_subj)}<br>"
                f"<b>From:</b> {_escape(submitter_email or 'user')}<br>"
                f"<b>Priority:</b> {_escape(ticket.priority or 'medium')}<br>"
                f"<b>Status:</b> {_escape(ticket.status or 'open')}</p>"
                f"<p><b>Message:</b><br>{_escape(first_msg).replace(chr(10), '<br>')}</p>"
                + (f"<p><b>Attachments:</b> {_n} file(s) attached to this email (also in the admin panel).</p>"
                   if _n else "")
                + "<p>Open the Support section in the admin panel to reply.</p>"
            )
            _text = (
                "A support ticket has been assigned to you.\n"
                f"Subject: {_subj}\nFrom: {submitter_email or 'user'}\n"
                f"Priority: {ticket.priority or 'medium'}\nStatus: {ticket.status or 'open'}\n\n"
                f"{first_msg}\n"
                + (f"\nAttachments: {_n} file(s) — attached, or view in the admin panel.\n" if _n else "")
            )
            assign_email = (assignee.email, _subj, _html, _text, ticket_attachments or None)
    except Exception:
        import logging
        logging.getLogger(__name__).exception("assign-ticket email build failed")

    await db.commit()

    # Fire AFTER commit so SMTP latency never delays the response and a delivery
    # failure never rolls back the assignment.
    if assign_email:
        try:
            from packages.common.src.smtp_mail import send_email, fire_and_forget
            _to, _subj, _html, _text, _atts = assign_email
            fire_and_forget(send_email(
                _to, subject=f"Support ticket assigned to you: {_subj}",
                html=_html, text=_text, category="support", attachments=_atts,
            ))
        except Exception:
            import logging
            logging.getLogger(__name__).exception("assign-ticket email send failed")

    return {"message": "Ticket assigned"}


async def update_ticket_status(
    ticket_id: uuid.UUID,
    body: TicketStatusUpdate,
    admin_id: uuid.UUID,
    ip_address: str | None,
    db: AsyncSession,
) -> dict:
    result = await db.execute(select(SupportTicket).where(SupportTicket.id == ticket_id))
    ticket = result.scalar_one_or_none()
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")

    valid_statuses = ["open", "in_progress", "resolved", "escalated", "closed"]
    if body.status not in valid_statuses:
        raise HTTPException(status_code=400, detail=f"Invalid status. Must be one of: {valid_statuses}")

    old_status = ticket.status
    ticket.status = body.status
    ticket.updated_at = datetime.utcnow()

    await write_audit_log(
        db, admin_id, "update_ticket_status", "support_ticket", ticket_id,
        old_values={"status": old_status},
        new_values={"status": body.status},
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": "Ticket status updated"}
