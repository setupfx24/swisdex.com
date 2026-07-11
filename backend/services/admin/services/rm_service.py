"""Relationship Manager (RM) subsystem — service layer.

Flow (client request 2026-06-12):
  1. An RM (Employee.role="rm") is assigned users via User.assigned_rm_id.
  2. The RM collects money offline and raises a funding request with a proof
     file for one of THEIR users  → status 'pending'.
  3. Admin #1 (rm.manage) verifies the proof                → status 'approved'.
  4. Admin #2 (different person) releases the money into the user's main
     wallet                                                  → status 'credited'.
     The credit also writes a Deposit row (method="rm") so it shows up in the
     user's deposit history with the approving admin, plus a Transaction and a
     user notification.
  5. Either admin can reject with a reason                   → status 'rejected'.

The two-admin rule (approver ≠ crediter) is enforced here AND by a DB check
constraint (migration 0071).
"""
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

from fastapi import HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.config import get_settings
from packages.common.src.models import User, Employee, RMFundingRequest, Deposit, Transaction
from packages.common.src.path_safety import safe_join_under_base, PathTraversalError
from packages.common.src.upload_safety import assert_matches, UnsafeUploadError
from packages.common.src.notify import create_notification
from dependencies import write_audit_log

RM_PROOF_EXT = {".jpg", ".jpeg", ".png", ".pdf", ".webp"}
MAX_PROOF_BYTES = 10 * 1024 * 1024


def _name(u: User | None) -> str:
    if not u:
        return "—"
    return f"{u.first_name or ''} {u.last_name or ''}".strip() or (u.email or str(u.id))


def _req_to_out(r: RMFundingRequest, rm: User | None, user: User | None,
                approver: User | None = None, crediter: User | None = None) -> dict:
    return {
        "id": str(r.id),
        "rm_id": str(r.rm_id),
        "rm_name": _name(rm),
        "user_id": str(r.user_id),
        "user_name": _name(user),
        "user_email": user.email if user else None,
        "amount": float(r.amount or 0),
        "currency": r.currency,
        "method": r.method,
        "note": r.note,
        "has_proof": bool(r.proof_path),
        "status": r.status,
        "approved_by": _name(approver) if approver else None,
        "approved_at": r.approved_at.isoformat() if r.approved_at else None,
        "credited_by": _name(crediter) if crediter else None,
        "credited_at": r.credited_at.isoformat() if r.credited_at else None,
        "rejection_reason": r.rejection_reason,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


def _rm_proof_root() -> Path:
    raw = (get_settings().WALLET_UPLOAD_ROOT or "").strip() or "uploads/wallet"
    return Path(raw)


# ── RM-facing ────────────────────────────────────────────────────────

async def list_my_users(rm_id: uuid.UUID, db: AsyncSession) -> dict:
    rows = (await db.execute(
        select(User).where(User.assigned_rm_id == rm_id).order_by(User.created_at.desc())
    )).scalars().all()
    return {"users": [{
        "id": str(u.id),
        "name": _name(u),
        "email": u.email,
        "phone": u.phone,
        "main_wallet_balance": float(u.main_wallet_balance or 0),
        "kyc_status": u.kyc_status,
        "created_at": u.created_at.isoformat() if u.created_at else None,
    } for u in rows]}


async def list_my_requests(rm_id: uuid.UUID, db: AsyncSession) -> dict:
    rows = (await db.execute(
        select(RMFundingRequest).where(RMFundingRequest.rm_id == rm_id)
        .order_by(RMFundingRequest.created_at.desc()).limit(300)
    )).scalars().all()
    out = []
    for r in rows:
        user = (await db.execute(select(User).where(User.id == r.user_id))).scalar_one_or_none()
        out.append(_req_to_out(r, None, user))
    return {"requests": out}


async def create_funding_request(
    rm_id: uuid.UUID, user_id: uuid.UUID, amount: Decimal, method: str | None,
    note: str | None, file: UploadFile, db: AsyncSession,
) -> dict:
    if amount is None or amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be greater than 0")

    # The RM may only raise requests for users assigned to THEM.
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.assigned_rm_id != rm_id:
        raise HTTPException(status_code=403, detail="This user is not assigned to you")

    # Proof file is mandatory — it's the whole point of the flow.
    if not file or not file.filename:
        raise HTTPException(status_code=400, detail="A proof file is required")
    suffix = Path(file.filename).suffix.lower()
    if suffix not in RM_PROOF_EXT:
        raise HTTPException(status_code=400, detail="Allowed file types: JPG, PNG, PDF, WEBP")
    content = await file.read()
    if len(content) > MAX_PROOF_BYTES:
        raise HTTPException(status_code=400, detail="File too large (max 10 MB)")
    try:
        kind = assert_matches(content, declared_suffix=suffix, allowed_suffixes=RM_PROOF_EXT)
    except UnsafeUploadError as e:
        raise HTTPException(status_code=400, detail=str(e))
    suffix = kind.suffix

    try:
        rm_dir = safe_join_under_base(_rm_proof_root(), "rm_proofs", str(rm_id))
    except PathTraversalError:
        raise HTTPException(status_code=400, detail="Invalid upload path")
    rm_dir.mkdir(parents=True, exist_ok=True)
    safe = f"rm_{uuid.uuid4().hex}{suffix}"
    try:
        out_path = safe_join_under_base(rm_dir, safe)
    except PathTraversalError:
        raise HTTPException(status_code=400, detail="Invalid file path")
    try:
        out_path.write_bytes(content)
    except OSError as e:
        raise HTTPException(status_code=503, detail="Could not save file") from e

    req = RMFundingRequest(
        rm_id=rm_id,
        user_id=user_id,
        amount=Decimal(str(amount)),
        method=(method or "rm").strip()[:40],
        note=(note or "").strip() or None,
        proof_path=str(out_path.resolve()),
        status="pending",
    )
    db.add(req)
    await db.commit()
    await db.refresh(req)
    return {"message": "Funding request submitted for admin review", "id": str(req.id)}


# ── Admin-facing (rm.manage) ─────────────────────────────────────────

async def list_requests(status: str | None, db: AsyncSession) -> dict:
    q = select(RMFundingRequest)
    if status and status != "all":
        q = q.where(RMFundingRequest.status == status)
    q = q.order_by(RMFundingRequest.created_at.desc()).limit(500)
    rows = (await db.execute(q)).scalars().all()

    # Batch-resolve the people referenced across all rows.
    ids = set()
    for r in rows:
        ids.update([r.rm_id, r.user_id, r.approved_by, r.credited_by])
    ids.discard(None)
    umap = {}
    if ids:
        for u in (await db.execute(select(User).where(User.id.in_(list(ids))))).scalars().all():
            umap[u.id] = u

    out = [
        _req_to_out(
            r, umap.get(r.rm_id), umap.get(r.user_id),
            umap.get(r.approved_by), umap.get(r.credited_by),
        ) for r in rows
    ]
    return {"requests": out}


async def get_proof_file(req_id: uuid.UUID, db: AsyncSession):
    r = (await db.execute(select(RMFundingRequest).where(RMFundingRequest.id == req_id))).scalar_one_or_none()
    if not r or not r.proof_path:
        raise HTTPException(status_code=404, detail="Proof not found")
    p = Path(r.proof_path)
    if not p.is_file():
        raise HTTPException(status_code=404, detail="File missing on server")
    return FileResponse(str(p), filename=p.name, media_type="application/octet-stream")


async def _load_pending(req_id: uuid.UUID, db: AsyncSession) -> RMFundingRequest:
    r = (await db.execute(
        select(RMFundingRequest).where(RMFundingRequest.id == req_id).with_for_update()
    )).scalar_one_or_none()
    if not r:
        raise HTTPException(status_code=404, detail="Request not found")
    return r


async def approve_request(req_id: uuid.UUID, admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession) -> dict:
    """Admin #1 verifies the proof. Moves pending → approved."""
    r = await _load_pending(req_id, db)
    if r.status != "pending":
        raise HTTPException(status_code=409, detail=f"Request is already {r.status}")
    r.status = "approved"
    r.approved_by = admin_id
    r.approved_at = datetime.now(timezone.utc)
    await write_audit_log(
        db, admin_id, "rm_funding_approve", "rm_funding_request", r.id,
        new_values={"amount": str(r.amount), "user_id": str(r.user_id)},
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": "Proof approved. A second admin must release the funds.", "status": r.status}


async def credit_request(req_id: uuid.UUID, admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession) -> dict:
    """Admin #2 (different person) releases the funds into the user's main
    wallet. Moves approved → credited and records a Deposit + Transaction."""
    r = await _load_pending(req_id, db)
    if r.status == "credited":
        raise HTTPException(status_code=409, detail="Already credited")
    if r.status != "approved":
        raise HTTPException(status_code=409, detail="Request must be approved by a first admin before crediting")
    if r.approved_by and r.approved_by == admin_id:
        raise HTTPException(status_code=403, detail="The crediting admin must be different from the approving admin")

    user = (await db.execute(
        select(User).where(User.id == r.user_id).with_for_update()
    )).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    amt = Decimal(str(r.amount))
    old_balance = user.main_wallet_balance or Decimal("0")
    user.main_wallet_balance = old_balance + amt

    # Deposit row so the funding shows in the user's deposit history with the
    # approving (crediting) admin, exactly like a normal approved deposit.
    deposit = Deposit(
        user_id=user.id,
        amount=amt,
        currency=r.currency or "USD",
        method="rm",
        status="approved",
        transaction_id=f"RM-{str(r.id)[:8]}",
        approved_by=admin_id,
        approved_at=datetime.now(timezone.utc),
    )
    db.add(deposit)
    await db.flush()

    txn = Transaction(
        user_id=user.id,
        account_id=None,
        type="deposit",
        amount=amt,
        balance_after=user.main_wallet_balance,
        description=f"RM funding (request {str(r.id)[:8]})",
        reference_id=deposit.id,
        created_by=admin_id,
    )
    db.add(txn)

    r.status = "credited"
    r.credited_by = admin_id
    r.credited_at = datetime.now(timezone.utc)
    r.deposit_id = deposit.id

    await write_audit_log(
        db, admin_id, "rm_funding_credit", "rm_funding_request", r.id,
        old_values={"main_wallet_balance": str(old_balance)},
        new_values={"main_wallet_balance": str(user.main_wallet_balance), "amount": str(amt)},
        ip_address=ip_address,
    )
    await create_notification(
        db, user.id,
        title="Funds Added",
        message=(
            f"${float(amt):,.2f} collected by your relationship manager has been "
            "added to your main wallet."
        ),
        notif_type="deposit",
        action_url="/wallet",
        commit=False,
    )
    await db.commit()
    return {
        "message": "Funds released to the user's main wallet",
        "status": r.status,
        "new_main_wallet_balance": float(user.main_wallet_balance),
    }


async def reject_request(req_id: uuid.UUID, admin_id: uuid.UUID, reason: str,
                         ip_address: str | None, db: AsyncSession) -> dict:
    r = await _load_pending(req_id, db)
    if r.status in ("credited", "rejected"):
        raise HTTPException(status_code=409, detail=f"Request is already {r.status}")
    if not (reason or "").strip():
        raise HTTPException(status_code=400, detail="A reason is required to reject")
    r.status = "rejected"
    r.rejected_by = admin_id
    r.rejected_at = datetime.now(timezone.utc)
    r.rejection_reason = reason.strip()
    await write_audit_log(
        db, admin_id, "rm_funding_reject", "rm_funding_request", r.id,
        new_values={"reason": reason.strip()}, ip_address=ip_address,
    )
    await db.commit()
    return {"message": "Request rejected", "status": r.status}


async def list_rms(db: AsyncSession) -> dict:
    """All active RM employees (for the assign-user dropdown)."""
    emps = (await db.execute(
        select(Employee).where(Employee.role == "rm", Employee.is_active == True)  # noqa: E712
    )).scalars().all()
    out = []
    for e in emps:
        u = (await db.execute(select(User).where(User.id == e.user_id))).scalar_one_or_none()
        out.append({"id": str(e.user_id), "name": _name(u), "email": u.email if u else None})
    return {"rms": out}


async def list_manual_requests(db: AsyncSession, status_filter: str | None = None) -> dict:
    """Trader-submitted 'Request to RM' deposit/withdraw requests (migration
    0093) so admin sees them in the panel, not just the RM's inbox."""
    from packages.common.src.models import RmManualRequest
    q = select(RmManualRequest).order_by(RmManualRequest.created_at.desc())
    if status_filter and status_filter != "all":
        q = q.where(RmManualRequest.status == status_filter)
    rows = (await db.execute(q.limit(500))).scalars().all()
    uids = [r.user_id for r in rows if r.user_id]
    umap: dict = {}
    if uids:
        for uid, fn, ln, em in (await db.execute(
            select(User.id, User.first_name, User.last_name, User.email).where(User.id.in_(uids))
        )).all():
            umap[uid] = {"name": (f"{fn or ''} {ln or ''}".strip() or em), "email": em}
    return {"items": [
        {
            "id": str(r.id),
            "user_id": str(r.user_id) if r.user_id else None,
            "user_name": umap.get(r.user_id, {}).get("name"),
            "user_email": umap.get(r.user_id, {}).get("email"),
            "side": r.side,
            "amount": float(r.amount or 0),
            "method": r.method,
            "phone": r.phone,
            "payout_details": r.payout_details,
            "note": r.note,
            "status": r.status,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]}


async def set_manual_request_status(
    req_id: uuid.UUID, status: str, admin_id: uuid.UUID, ip_address: str | None, db: AsyncSession,
) -> dict:
    from packages.common.src.models import RmManualRequest
    allowed = {"new", "contacted", "done", "cancelled"}
    if status not in allowed:
        raise HTTPException(status_code=400, detail=f"status must be one of {sorted(allowed)}")
    r = (await db.execute(
        select(RmManualRequest).where(RmManualRequest.id == req_id)
    )).scalar_one_or_none()
    if not r:
        raise HTTPException(status_code=404, detail="Request not found")
    r.status = status
    await write_audit_log(
        db, admin_id, "rm_manual_request_status", "rm_manual_request", r.id,
        new_values={"status": status}, ip_address=ip_address,
    )
    await db.commit()
    return {"id": str(req_id), "status": status}


async def assign_user(user_id: uuid.UUID, rm_id: uuid.UUID | None, admin_id: uuid.UUID,
                      ip_address: str | None, db: AsyncSession) -> dict:
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if rm_id is not None:
        emp = (await db.execute(
            select(Employee).where(Employee.user_id == rm_id, Employee.role == "rm")
        )).scalar_one_or_none()
        if not emp:
            raise HTTPException(status_code=400, detail="Target is not an RM")
    old = user.assigned_rm_id
    user.assigned_rm_id = rm_id
    await write_audit_log(
        db, admin_id, "rm_assign_user", "user", user_id,
        old_values={"assigned_rm_id": str(old) if old else None},
        new_values={"assigned_rm_id": str(rm_id) if rm_id else None},
        ip_address=ip_address,
    )
    await db.commit()
    return {"message": "RM assignment updated", "assigned_rm_id": str(rm_id) if rm_id else None}


async def pending_count(db: AsyncSession) -> int:
    return int((await db.execute(
        select(func.count(RMFundingRequest.id)).where(RMFundingRequest.status.in_(["pending", "approved"]))
    )).scalar() or 0)
