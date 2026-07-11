"""Support Service — Ticket creation, listing, replies."""
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.models import SupportTicket, TicketMessage


async def list_tickets(
    user_id: UUID, status: str | None, page: int, per_page: int, db: AsyncSession,
) -> dict:
    base_filter = [SupportTicket.user_id == user_id]
    if status:
        base_filter.append(SupportTicket.status == status)

    count_result = await db.execute(
        select(func.count()).select_from(SupportTicket).where(*base_filter)
    )
    total = count_result.scalar() or 0

    result = await db.execute(
        select(SupportTicket)
        .where(*base_filter)
        .order_by(SupportTicket.updated_at.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
    )
    tickets = result.scalars().all()

    ticket_ids = [t.id for t in tickets]
    counts = {}
    if ticket_ids:
        cnt_rows = await db.execute(
            select(TicketMessage.ticket_id, func.count(TicketMessage.id))
            .where(TicketMessage.ticket_id.in_(ticket_ids))
            .group_by(TicketMessage.ticket_id)
        )
        counts = {row[0]: int(row[1]) for row in cnt_rows.all()}

    items = []
    for t in tickets:
        items.append({
            "id": str(t.id),
            "subject": t.subject,
            "status": t.status,
            "priority": t.priority,
            "message_count": counts.get(t.id, 0),
            "created_at": t.created_at.isoformat() if t.created_at else None,
            "updated_at": t.updated_at.isoformat() if t.updated_at else None,
        })

    return {
        "items": items,
        "total": total,
        "page": page,
        "per_page": per_page,
        "pages": (total + per_page - 1) // per_page if total else 0,
    }


async def create_ticket(
    user_id: UUID, subject: str, message: str, priority: str, db: AsyncSession,
    attachments: list | None = None,
) -> dict:
    ticket = SupportTicket(
        user_id=user_id,
        subject=subject,
        status="open",
        priority=priority,
    )
    db.add(ticket)
    await db.flush()

    first_message = TicketMessage(
        ticket_id=ticket.id,
        sender_id=user_id,
        message=message,
        attachments=attachments or None,
        is_admin=False,
    )
    db.add(first_message)
    await db.commit()
    await db.refresh(ticket)
    await db.refresh(first_message)

    # Email the support inbox so a new ticket isn't missed (client 2026-06-24:
    # "mail bhi jana chahiye support wale me"). The in-app admin bell already
    # counts open tickets; this adds the email channel. Best-effort — a mail
    # failure must never fail the ticket creation.
    try:
        from html import escape
        from packages.common.src.models import User as _User
        from packages.common.src.smtp_mail import send_email
        from packages.common.src.config import get_settings
        from packages.common.src.settings_store import get_system_setting

        submitter = (await db.execute(
            select(_User).where(_User.id == user_id)
        )).scalar_one_or_none()
        who = (submitter.email if submitter and submitter.email else str(user_id))
        support_to = (await get_system_setting("support_email", None)) or get_settings().ADMIN_EMAIL
        if support_to:
            await send_email(
                support_to,
                subject=f"New support ticket: {subject}",
                html=(
                    "<p>A new support ticket was submitted on SwisDex.</p>"
                    f"<p><b>From:</b> {escape(who)}<br>"
                    f"<b>Priority:</b> {escape(priority or 'normal')}<br>"
                    f"<b>Subject:</b> {escape(subject or '')}</p>"
                    f"<p><b>Message:</b><br>{escape(message or '').replace(chr(10), '<br>')}</p>"
                    + (f"<p><b>Attachments:</b> {len(attachments)} file(s) attached to this email (also in the admin panel).</p>"
                       if attachments else "")
                    + "<p>Open the Support section in the admin panel to reply.</p>"
                ),
                text=(
                    f"New support ticket from {who}\n"
                    f"Priority: {priority or 'normal'}\nSubject: {subject}\n\n{message}\n"
                    + (f"\nAttachments: {len(attachments)} file(s) — attached, or view in the admin panel.\n"
                       if attachments else "")
                ),
                category="support",
                attachments=attachments,
            )
    except Exception:
        import logging
        logging.getLogger(__name__).exception("support ticket email failed")

    # In-app alert for EVERY admin so a new ticket surfaces on their bell — not
    # only the email + open-count (client 2026-06-26: "report admin ke paas
    # nahi pahunch rahi"). Best-effort — never fail the ticket over a notify.
    try:
        from packages.common.src.notify import create_notification
        from packages.common.src.models import User as _Adm
        admin_ids = (await db.execute(
            select(_Adm.id).where(_Adm.role.in_(["admin", "super_admin"]))
        )).scalars().all()
        for aid in admin_ids:
            await create_notification(
                db, aid,
                title="New support ticket",
                message=(subject or "A user submitted a support ticket."),
                notif_type="info",
                action_url="/support",
            )
        await db.commit()
    except Exception:
        import logging
        logging.getLogger(__name__).exception("support ticket admin notify failed")

    return {
        "id": str(ticket.id),
        "subject": ticket.subject,
        "status": ticket.status,
        "priority": ticket.priority,
        "message": {
            "id": str(first_message.id),
            "message": first_message.message,
            "created_at": first_message.created_at.isoformat() if first_message.created_at else None,
        },
        "created_at": ticket.created_at.isoformat() if ticket.created_at else None,
    }


async def get_ticket(user_id: UUID, ticket_id: UUID, db: AsyncSession) -> dict:
    result = await db.execute(
        select(SupportTicket).where(
            SupportTicket.id == ticket_id,
            SupportTicket.user_id == user_id,
        )
    )
    ticket = result.scalar_one_or_none()
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")

    all_messages_result = await db.execute(
        select(TicketMessage)
        .where(TicketMessage.ticket_id == ticket_id)
        .order_by(TicketMessage.created_at.asc())
    )
    all_msgs = all_messages_result.scalars().all()

    messages = []
    for m in all_msgs:
        messages.append({
            "id": str(m.id),
            "message": m.message,
            "is_admin": m.is_admin,
            "attachments": m.attachments,
            "created_at": m.created_at.isoformat() if m.created_at else None,
        })

    return {
        "id": str(ticket.id),
        "subject": ticket.subject,
        "status": ticket.status,
        "priority": ticket.priority,
        "messages": messages,
        "created_at": ticket.created_at.isoformat() if ticket.created_at else None,
        "updated_at": ticket.updated_at.isoformat() if ticket.updated_at else None,
    }


async def reply_ticket(
    user_id: UUID, ticket_id: UUID, message_text: str,
    attachments: list | None, db: AsyncSession,
) -> dict:
    result = await db.execute(
        select(SupportTicket).where(
            SupportTicket.id == ticket_id,
            SupportTicket.user_id == user_id,
        )
    )
    ticket = result.scalar_one_or_none()
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")
    if ticket.status == "closed":
        raise HTTPException(status_code=400, detail="Cannot reply to a closed ticket")

    message = TicketMessage(
        ticket_id=ticket_id,
        sender_id=user_id,
        message=message_text,
        attachments=attachments,
        is_admin=False,
    )
    db.add(message)

    if ticket.status == "resolved":
        ticket.status = "open"

    await db.commit()
    await db.refresh(message)

    return {
        "id": str(message.id),
        "ticket_id": str(ticket_id),
        "message": message.message,
        "attachments": message.attachments,
        "created_at": message.created_at.isoformat() if message.created_at else None,
    }
