"""Profile Service — User profile CRUD, KYC document handling, session management."""
import logging
import uuid as _uuid
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID

from fastapi import HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.models import User, UserSession, KYCDocument
from packages.common.src.auth import hash_password, verify_password
from packages.common.src.config import get_settings
from packages.common.src.path_safety import PathTraversalError, safe_join_under_base
from packages.common.src.notify import create_notification

logger = logging.getLogger("profile_service")

ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".pdf", ".webp"}
MAX_FILE_BYTES = 10 * 1024 * 1024  # 10 MB
VALID_DOC_TYPES = {
    "passport", "national_id", "driving_license", "proof_of_address",
    "address_proof", "selfie", "bank_statement", "id_front", "id_back", "other",
}


def _kyc_upload_root() -> Path:
    raw = get_settings().KYC_UPLOAD_ROOT.strip() or "uploads/kyc"
    p = Path(raw)
    if not p.is_absolute():
        p = Path.cwd() / p
    try:
        p.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        logger.error("KYC upload directory not writable: %s — %s", p, e)
        raise HTTPException(
            status_code=503,
            detail="File upload is temporarily unavailable. Please contact support.",
        ) from e
    return p


async def _read_upload_file(upload: UploadFile, label: str) -> tuple[bytes, str]:
    if not upload.filename:
        raise HTTPException(status_code=400, detail=f"No file provided ({label})")
    suffix = Path(upload.filename).suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"File type not allowed for {label}. Upload JPG, PNG, PDF, or WEBP.",
        )
    content = await upload.read()
    if not content:
        raise HTTPException(status_code=400, detail=f"Empty file ({label})")
    if len(content) > MAX_FILE_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"File too large for {label}. Maximum size is 10 MB.",
        )
    # Magic-byte validation (security review F1): extension + Content-Type
    # are attacker-controlled, so verify the actual bytes are a real
    # image/PDF before we store a trader-supplied file that an admin will
    # later open. Adopt the detected canonical suffix as the stored one.
    from packages.common.src.upload_safety import assert_matches, UnsafeUploadError
    try:
        kind = assert_matches(content, declared_suffix=suffix, allowed_suffixes=ALLOWED_EXTENSIONS)
    except UnsafeUploadError as e:
        raise HTTPException(
            status_code=400,
            detail=f"File content does not match its type for {label}. Upload a valid JPG, PNG, PDF, or WEBP.",
        ) from e
    return content, kind.suffix


# ─── Profile ──────────────────────────────────────────────────────────────

async def get_profile(user_id: UUID, db: AsyncSession) -> dict:
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    kyc_result = await db.execute(
        select(KYCDocument)
        .where(KYCDocument.user_id == user.id)
        .order_by(KYCDocument.created_at.desc())
    )
    kyc_docs = kyc_result.scalars().all()

    kyc_documents = [
        {
            "id": str(doc.id),
            "document_type": doc.document_type,
            "status": doc.status,
            "rejection_reason": doc.rejection_reason,
            "created_at": doc.created_at.isoformat() if doc.created_at else None,
        }
        for doc in kyc_docs
    ]

    return {
        "id": str(user.id),
        "email": user.email,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "phone": user.phone,
        "country": user.country,
        "address": user.address,
        "city": user.city,
        "state": user.state,
        "postal_code": user.postal_code,
        "date_of_birth": user.date_of_birth.isoformat() if user.date_of_birth else None,
        "role": user.role,
        "status": user.status,
        "kyc_status": user.kyc_status,
        "two_factor_enabled": user.two_factor_enabled,
        "language": user.language,
        "theme": user.theme,
        "is_islamic": bool(getattr(user, "is_islamic", False)),
        "kyc_documents": kyc_documents,
        "created_at": user.created_at.isoformat() if user.created_at else None,
    }


async def update_profile(
    user_id: UUID, update_data: dict, db: AsyncSession,
) -> dict:
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # The "Try with Demo Account" button signs everyone in as the SHARED
    # demo@swisdex.com user (User.is_demo=True). Letting any visitor mutate
    # that row corrupts identity for every subsequent visitor — exactly the
    # bug where one user's "abhi" first_name leaked into a stranger's demo
    # session. Reject profile edits on the shared demo identity.
    if bool(getattr(user, "is_demo", False)):
        raise HTTPException(
            status_code=403,
            detail=(
                "Profile editing is disabled on the shared demo account. "
                "Sign up for a real account to personalise your profile."
            ),
        )

    # date_of_birth arrives from the HTML <input type="date"> as a YYYY-MM-DD
    # string. The User column is a DateTime so we coerce here — asyncpg
    # otherwise raises DataError on commit.
    if "date_of_birth" in update_data:
        dob_raw = update_data["date_of_birth"]
        if dob_raw is None or (isinstance(dob_raw, str) and not dob_raw.strip()):
            update_data["date_of_birth"] = None
        elif isinstance(dob_raw, str):
            try:
                # Accept either "YYYY-MM-DD" or full ISO 8601.
                update_data["date_of_birth"] = datetime.fromisoformat(dob_raw[:10])
            except ValueError:
                raise HTTPException(
                    status_code=400,
                    detail="Invalid date of birth — expected YYYY-MM-DD.",
                )

    # Identity lock after KYC approval (client 2026-06-23): a pending/rejected
    # user may still fix details (e.g. a wrong DOB entered at signup), but once
    # KYC is approved name / DOB / country / address are frozen. We only block
    # an ACTUAL change to a locked field, so re-submitting unchanged values from
    # the form is fine.
    kyc = (user.kyc_status or "pending").lower()
    if kyc in ("approved", "verified"):
        LOCKED = ("first_name", "last_name", "date_of_birth", "country", "address", "nationality")
        for f in LOCKED:
            if f in update_data and update_data[f] is not None:
                cur = getattr(user, f, None)
                new = update_data[f]
                if f == "date_of_birth":
                    cur = cur.date() if hasattr(cur, "date") else cur
                    new = new.date() if hasattr(new, "date") else new
                    changed = cur != new
                else:
                    changed = str(cur or "").strip() != str(new or "").strip()
                if changed:
                    raise HTTPException(
                        status_code=403,
                        detail="Your profile is locked after KYC approval. Contact support to change verified details.",
                    )

    # Snapshot completeness BEFORE applying the patch so we can detect the
    # false→true transition that should fire the welcome email.
    was_complete = _is_profile_complete(user)

    for field, value in update_data.items():
        if value is not None:
            setattr(user, field, value)

    # Detect the transition after the patch and BEFORE commit so we can
    # stamp welcome_email_sent_at in the same write. Demo / staff users
    # are excluded inside _is_profile_complete already.
    now_complete = _is_profile_complete(user)
    should_fire_welcome = (
        (not was_complete)
        and now_complete
        and user.welcome_email_sent_at is None
    )
    if should_fire_welcome:
        user.welcome_email_sent_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(user)

    # Fire the dashboard-access email AFTER the commit succeeds — if SMTP
    # fails we've already saved the profile, and the same idempotency
    # column will prevent a duplicate send when the user re-saves.
    # send_dashboard_access_email is itself fire-and-forget, so this call
    # never blocks the response.
    if should_fire_welcome:
        try:
            await send_dashboard_access_email(user_id=user.id, db=db)
        except Exception as e:
            logger.warning(
                "Auto welcome email failed for %s: %s", user.email, e,
            )

    return {
        "id": str(user.id),
        "email": user.email,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "phone": user.phone,
        "country": user.country,
        "address": user.address,
        "city": user.city,
        "state": user.state,
        "postal_code": user.postal_code,
        "language": user.language,
        "theme": user.theme,
        "message": "Profile updated",
    }


def _is_profile_complete(user) -> bool:
    """Mirror of auth_service.get_me's profile_complete logic so update_profile
    can detect the same transition without an extra DB roundtrip. Demo + staff
    short-circuit to True so they never trigger the auto-welcome path."""
    if bool(getattr(user, "is_demo", False)):
        return True
    role = (getattr(user, "role", None) or "").lower()
    if role in ("admin", "super_admin", "employee", "manager", "support"):
        return True
    return bool(
        (user.first_name or "").strip()
        and (user.last_name or "").strip()
        and (user.phone or "").strip()
        and (user.country or "").strip()
        and (user.address or "").strip()
        and (user.city or "").strip()
        and (user.state or "").strip()
        and (user.postal_code or "").strip()
        and user.date_of_birth is not None
    )


async def change_password(
    user_id: UUID, current_password: str, new_password: str, db: AsyncSession,
) -> dict:
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # Shared demo identity — see update_profile for the rationale. Letting a
    # visitor change the demo password would lock every subsequent visitor
    # out of the shared account.
    if bool(getattr(user, "is_demo", False)):
        raise HTTPException(
            status_code=403,
            detail="Password changes are disabled on the shared demo account.",
        )

    if not verify_password(current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")

    if current_password == new_password:
        raise HTTPException(status_code=400, detail="New password must be different")

    # Same strength policy as signup + reset-password. Without this, a
    # signed-in user could "change" their password to '12345678'.
    from packages.common.src.password_policy import validate_password, PasswordTooWeak
    try:
        validate_password(new_password, disallow=[
            (user.email or "").split("@", 1)[0],
            user.first_name or "",
            user.last_name or "",
        ])
    except PasswordTooWeak as e:
        raise HTTPException(status_code=400, detail=e.reason)

    user.password_hash = hash_password(new_password)
    await db.commit()

    return {"message": "Password changed successfully"}


# ─── Sessions ─────────────────────────────────────────────────────────────

async def list_sessions(user_id: UUID, db: AsyncSession) -> dict:
    result = await db.execute(
        select(UserSession)
        .where(UserSession.user_id == user_id, UserSession.is_active == True)
        .order_by(UserSession.created_at.desc())
    )
    sessions = result.scalars().all()

    return {
        "sessions": [
            {
                "id": str(s.id),
                "ip_address": str(s.ip_address) if s.ip_address else None,
                "user_agent": s.user_agent,
                "device_info": s.device_info,
                "created_at": s.created_at.isoformat() if s.created_at else None,
                "expires_at": s.expires_at.isoformat() if s.expires_at else None,
            }
            for s in sessions
        ],
        "total": len(sessions),
    }


async def terminate_session(user_id: UUID, session_id: UUID, db: AsyncSession) -> dict:
    result = await db.execute(
        select(UserSession).where(
            UserSession.id == session_id,
            UserSession.user_id == user_id,
        )
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if not session.is_active:
        raise HTTPException(status_code=400, detail="Session already terminated")

    session.is_active = False
    await db.commit()

    return {"message": "Session terminated", "session_id": str(session_id)}


# ─── KYC ──────────────────────────────────────────────────────────────────

async def submit_kyc(
    user_id: UUID,
    document_type: str,
    file: UploadFile,
    document_type_2: str | None,
    file_2: UploadFile | None,
    residential_address: str | None,
    city: str | None,
    postal_code: str | None,
    country_of_residence: str | None,
    db: AsyncSession,
    document_type_3: str | None = None,
    file_3: UploadFile | None = None,
) -> dict:
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if user.kyc_status in ("under_review", "submitted"):
        raise HTTPException(
            status_code=400,
            detail="Your documents are already submitted and under review. Please wait.",
        )
    if user.kyc_status in ("verified", "approved"):
        raise HTTPException(status_code=400, detail="Your KYC is already verified.")

    if document_type not in VALID_DOC_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid document type. Allowed: {', '.join(sorted(VALID_DOC_TYPES))}",
        )

    has_second = bool(file_2 and file_2.filename)
    if has_second:
        if not document_type_2 or document_type_2 not in VALID_DOC_TYPES:
            raise HTTPException(
                status_code=400,
                detail="Select a valid document type for the second file.",
            )
    elif document_type_2 and document_type_2.strip():
        raise HTTPException(
            status_code=400,
            detail="Second document type was set but no second file was uploaded.",
        )

    has_third = bool(file_3 and file_3.filename)
    if has_third:
        if not document_type_3 or document_type_3 not in VALID_DOC_TYPES:
            raise HTTPException(
                status_code=400,
                detail="Select a valid document type for the selfie/third file.",
            )

    uploads: list[tuple[str, bytes, str]] = []
    c1, s1 = await _read_upload_file(file, "primary document")
    uploads.append((document_type, c1, s1))
    if has_second:
        c2, s2 = await _read_upload_file(file_2, "second document")
        uploads.append((document_type_2, c2, s2))
    if has_third:
        c3, s3 = await _read_upload_file(file_3, "selfie")
        uploads.append((document_type_3, c3, s3))

    root = _kyc_upload_root()
    try:
        user_upload_dir = safe_join_under_base(root, str(user_id))
    except PathTraversalError:
        raise HTTPException(status_code=400, detail="Invalid upload path")
    user_upload_dir.mkdir(parents=True, exist_ok=True)

    saved_docs: list[KYCDocument] = []
    try:
        for dtype, content, suffix in uploads:
            safe_name = f"{dtype}_{_uuid.uuid4().hex}{suffix}"
            try:
                file_path = safe_join_under_base(user_upload_dir, safe_name)
            except PathTraversalError:
                raise HTTPException(status_code=400, detail="Invalid file path")
            try:
                file_path.write_bytes(content)
            except OSError as e:
                logger.exception("KYC file write failed: %s", file_path)
                raise HTTPException(
                    status_code=503,
                    detail="Could not store upload. Please try again or contact support.",
                ) from e

            doc = KYCDocument(
                user_id=user_id,
                document_type=dtype,
                file_url=str(file_path),
                status="pending",
            )
            db.add(doc)
            saved_docs.append(doc)

        addr_parts: list[str] = []
        if residential_address and residential_address.strip():
            addr_parts.append(residential_address.strip())
        line2 = ", ".join(
            p for p in [(city or "").strip(), (postal_code or "").strip()] if p
        )
        if line2:
            addr_parts.append(line2)
        if addr_parts:
            user.address = "\n".join(addr_parts)
        if country_of_residence and country_of_residence.strip():
            user.country = country_of_residence.strip()

        user.kyc_status = "submitted"

        await create_notification(
            db,
            user_id,
            title="KYC submitted",
            message="Your documents were received and are pending review. We will notify you when verification is complete.",
            notif_type="kyc",
            action_url="/profile",
            commit=False,
        )
        await db.commit()
        for d in saved_docs:
            await db.refresh(d)
    except IntegrityError as e:
        await db.rollback()
        logger.exception("KYC database constraint failed (run migration 005_kyc_document_types.sql?): %s", e)
        raise HTTPException(
            status_code=400,
            detail=(
                "Could not save KYC data. Your server database may need the latest migration "
                "(kyc document types). Contact support if this continues."
            ),
        ) from e

    primary = saved_docs[0]
    return {
        "message": "KYC submitted successfully. We will review it within 1–2 business days.",
        "document_id": str(primary.id),
        "document_type": primary.document_type,
        "status": primary.status,
        "documents_submitted": len(saved_docs),
    }


async def get_kyc_file(user_id: UUID, document_id: UUID, db: AsyncSession) -> Path:
    result = await db.execute(
        select(KYCDocument).where(
            KYCDocument.id == document_id,
            KYCDocument.user_id == user_id,
        )
    )
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    file_path = Path(doc.file_url)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found on server")

    return file_path


# ─── Dashboard-access email ────────────────────────────────────────────────
# Sent AFTER the trader hits Save & Continue on the profile-completion gate.
# Distinct from the verify-email message that fires at signup — this one is
# the welcome-to-your-dashboard hand-off and contains a deep link straight
# into /accounts. The user is already authenticated via HttpOnly cookies
# in the original browser, so clicking the link opens the dashboard with
# no extra token exchange.

async def send_dashboard_access_email(
    user_id: UUID, db: AsyncSession,
) -> dict:
    """Send the 'Your dashboard is ready' email to the authenticated user.

    Idempotent: callable as many times as the trader hits Save & Continue
    or the resend button in the popup. Returns a small dict so the API
    layer can echo a friendly message; never raises on SMTP failure (we
    swallow + log so the trader can still proceed in-app).
    """
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # Demo identity short-circuits — the shared demo@swisdex.com account
    # must never be spammed via the dashboard email.
    if bool(getattr(user, "is_demo", False)):
        return {"message": "Skipped for demo account", "sent": False}

    try:
        from packages.common.src.smtp_mail import (
            send_email, smtp_configured, fire_and_forget,
        )
        from packages.common.src.email_templates import render_dashboard_access

        if not smtp_configured():
            logger.info(
                "SMTP not configured — dashboard-access email skipped for %s",
                user.email,
            )
            return {"message": "Email not configured", "sent": False}

        st = get_settings()
        trader_app_url = (
            getattr(st, "TRADER_APP_URL", None) or "https://trade.swisdex.com"
        ).rstrip("/")
        dashboard_url = f"{trader_app_url}/accounts"
        subject, html, text = render_dashboard_access(
            first_name=user.first_name,
            dashboard_url=dashboard_url,
        )
        fire_and_forget(send_email(user.email, subject, html, text=text, category="support"))
    except Exception as e:
        logger.warning(
            "dashboard-access email scheduling failed for %s: %s",
            user.email, e,
        )
        return {"message": "Could not send email — try again later", "sent": False}

    return {"message": "Dashboard link sent — check your email.", "sent": True}
