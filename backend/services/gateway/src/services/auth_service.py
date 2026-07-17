"""Auth Service — Registration, login, token management, demo user, 2FA, password reset."""
import ipaddress
import json
import logging
import secrets
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from time import monotonic

import pyotp
from fastapi import Request
from fastapi.responses import JSONResponse
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from uuid import UUID

from packages.common.src.config import get_settings
from packages.common.src.models import (
    User, UserSession, TradingAccount, AccountGroup,
    IBProfile, Referral, PasswordResetToken, UserRefreshToken, UserAuditLog,
    Position, PositionStatus, Order, OrderStatus,
)
from packages.common.src.schemas import TokenResponse
from packages.common.src.auth import (
    hash_password, verify_password, create_access_token,
    hash_token, decode_token,
)

logger = logging.getLogger("auth_service")

DEMO_SHARED_EMAIL = "demo@swisdex.com"
# Client 2026-07-14: the demo playground must ALWAYS greet the visitor with
# $100,000 — the shared account was drained to ~$0 by previous visitors'
# trades because the balance was only set once at creation.
DEMO_STARTING_BALANCE = Decimal("100000")

_rate_buckets: dict[str, list[float]] = {}


# ─── Exceptions ───────────────────────────────────────────────────────────

class AuthServiceError(Exception):
    def __init__(self, detail: str, status_code: int = 400):
        self.detail = detail
        self.status_code = status_code
        super().__init__(detail)


# Statuses that block sign-in. "suspended" is a temporary admin hold,
# "terminated" / "deleted" are end-of-life (soft-delete keeps the data but
# the user can never log in again). Centralised so every auth path agrees.
_LOGIN_BLOCKED_STATUSES = {"banned", "blocked", "suspended", "terminated", "deleted"}


def login_block_message(status: str | None) -> str | None:
    """Return a user-facing reason if this account status blocks login, else None."""
    s = (status or "").lower()
    if s not in _LOGIN_BLOCKED_STATUSES:
        return None
    return {
        "banned": "Account has been banned",
        "blocked": "Account has been blocked",
        "suspended": "Your account is temporarily suspended. Please contact support.",
        "terminated": "Account has been terminated",
        "deleted": "Account no longer exists",
    }.get(s, "Account is not active")


# ─── Utility: IP parsing ─────────────────────────────────────────────────

def _parse_one_ip(raw: str) -> str | None:
    h = raw.strip()
    if not h:
        return None
    if "," in h:
        h = h.split(",")[0].strip()
    if h.startswith("[") and "]" in h:
        h = h[1 : h.index("]")]
    if "%" in h:
        h = h.split("%", 1)[0]
    try:
        ipaddress.ip_address(h)
        return h
    except ValueError:
        return None


def _allowed_origins() -> set[str]:
    raw = (get_settings().CORS_ORIGINS or "").split(",")
    return {o.strip().rstrip("/") for o in raw if o.strip()}


def assert_same_origin(request: Request) -> None:
    """Reject state-changing auth requests whose Origin/Referer is not on our allow-list.

    Defense in depth on top of CORS + SameSite=strict cookies. Browsers always
    send Origin on cross-origin POSTs; if it's missing entirely (e.g. curl from
    a script), we allow the call — the attacker would still need a valid id_token
    for our audience, which they cannot mint."""
    origin = (request.headers.get("origin") or "").strip().rstrip("/")
    referer = (request.headers.get("referer") or "").strip()
    if not origin and not referer:
        return  # non-browser caller; id_token audience check still gates auth
    allowed = _allowed_origins()
    if not allowed:
        return  # not configured — trust CORS layer
    if origin and origin in allowed:
        return
    if referer:
        # match referer prefix against any allowed origin
        for ao in allowed:
            if referer.startswith(ao + "/") or referer == ao:
                return
    raise AuthServiceError("Origin not allowed", 403)


def client_ip_for_inet(request: Request) -> str | None:
    """Return a value PostgreSQL INET accepts, or None. Prefers the
    non-forgeable X-Real-IP (set by our nginx) then the right-most
    X-Forwarded-For hop, so audit rows record the real client rather than
    a value a client prepended to the header (audit H3)."""
    real = request.headers.get("x-real-ip") or request.headers.get("X-Real-IP")
    if real:
        got = _parse_one_ip(real)
        if got:
            return got
    ff = request.headers.get("x-forwarded-for") or request.headers.get("X-Forwarded-For")
    if ff:
        for part in reversed(ff.split(",")):
            got = _parse_one_ip(part)
            if got:
                return got
    host = request.client.host if request.client else None
    return _parse_one_ip(str(host)) if host else None


# ─── Utility: rate limiting (Redis-backed sliding window) ────────────────

from packages.common.src.rate_limit import rate_limit_request as _rl_request


async def rate_limit_http(
    request: Request,
    bucket: str,
    max_requests: int,
    window_sec: float,
    *,
    extra_key: str | None = None,
) -> None:
    """Throttle the caller in ``bucket`` to ``max_requests`` per ``window_sec``.

    Identified by client IP (X-Forwarded-For first hop) optionally combined
    with ``extra_key`` (e.g. submitted email or wallet address) so a single
    IP can't iterate identifiers without paying for it. Raises HTTP 429 on
    overflow. Silently no-ops if Redis is unreachable.

    All call sites are awaited — we changed this from sync to async after
    the prior no-op was retired."""
    await _rl_request(
        request,
        bucket,
        max_requests=max_requests,
        window_sec=window_sec,
        extra_key=extra_key,
    )


# ─── Utility: cookies ────────────────────────────────────────────────────

def _request_appears_secure(request: Request) -> bool:
    if request.headers.get("x-forwarded-proto", "").lower().startswith("https"):
        return True
    return request.url.scheme == "https"


def _cookie_secure_flag(request: Request) -> bool:
    st = get_settings()
    if st.COOKIE_SECURE is not None:
        return st.COOKIE_SECURE
    return _request_appears_secure(request)


def _cookie_samesite() -> str:
    v = get_settings().COOKIE_SAMESITE.lower().strip()
    if v not in ("lax", "strict", "none"):
        return "strict"
    return v


def _cookie_domain() -> str | None:
    d = get_settings().COOKIE_DOMAIN.strip()
    return d or None


def attach_auth_cookies(
    response: JSONResponse,
    request: Request,
    *,
    access_token: str,
    access_expires_at: datetime,
    raw_refresh: str,
) -> None:
    st = get_settings()
    secure = _cookie_secure_flag(request)
    ss = _cookie_samesite()
    domain = _cookie_domain()
    exp = access_expires_at
    if exp.tzinfo is None:
        exp = exp.replace(tzinfo=timezone.utc)
    max_age_access = max(60, int((exp - datetime.now(timezone.utc)).total_seconds()))
    max_age_refresh = max(3600, st.JWT_REFRESH_EXPIRY_DAYS * 86400)
    access_kw: dict = {
        "key": st.ACCESS_TOKEN_COOKIE_NAME,
        "value": access_token,
        "httponly": True,
        "secure": secure,
        "samesite": ss,
        "path": "/",
    }
    if domain:
        access_kw["domain"] = domain
    if not st.JWT_REFRESH_SESSION_COOKIE:
        access_kw["max_age"] = max_age_access
    response.set_cookie(**access_kw)
    refresh_kw: dict = {
        "key": st.REFRESH_TOKEN_COOKIE_NAME,
        "value": raw_refresh,
        "httponly": True,
        "secure": secure,
        "samesite": ss,
        "path": "/",
    }
    if domain:
        refresh_kw["domain"] = domain
    if not st.JWT_REFRESH_SESSION_COOKIE:
        refresh_kw["max_age"] = max_age_refresh
    response.set_cookie(**refresh_kw)


def clear_auth_cookies(response: JSONResponse, request: Request) -> None:
    st = get_settings()
    secure = _cookie_secure_flag(request)
    ss = _cookie_samesite()
    domain = _cookie_domain()
    delete_kw_a = dict(path="/", samesite=ss, secure=secure)
    delete_kw_r = dict(path="/", samesite=ss, secure=secure)
    if domain:
        delete_kw_a["domain"] = domain
        delete_kw_r["domain"] = domain
    response.delete_cookie(st.ACCESS_TOKEN_COOKIE_NAME, **delete_kw_a)
    response.delete_cookie(st.REFRESH_TOKEN_COOKIE_NAME, **delete_kw_r)


# ─── Utility: transactional email senders ────────────────────────────────


def _send_welcome_email(user: User, *, via_google: bool) -> None:
    """Schedule a welcome email after a successful signup. Fire-and-forget:
    SMTP latency or failure must never delay the API response or roll back
    the signup. Used today only for the Google-OAuth path — regular
    signups receive verify_email.py which embeds the same welcome content
    plus the Verify CTA."""
    try:
        from packages.common.src.smtp_mail import (
            send_email, smtp_configured, fire_and_forget,
        )
        if not smtp_configured():
            return
        from packages.common.src.email_templates import render_welcome
        st = get_settings()
        # Same credentials block as verify_email — surface the first active
        # trading account number if one already exists. (Google sign-up
        # usually has none yet; the credentials row is then omitted.)
        trading_id: str | None = None
        try:
            primary = next(
                (a for a in (user.accounts or []) if a.is_active and not a.is_demo),
                None,
            ) or next((a for a in (user.accounts or []) if a.is_active), None)
            if primary and primary.account_number:
                trading_id = str(primary.account_number)
        except Exception:
            trading_id = None
        subject, html, text = render_welcome(
            first_name=user.first_name,
            trader_app_url=st.TRADER_APP_URL or "https://trade.swisdex.com",
            via_google=via_google,
            username=user.email,
            trading_id=trading_id,
        )
        fire_and_forget(send_email(user.email, subject, html, text=text, category="support"))
    except Exception as e:
        logger.warning("welcome email scheduling failed for %s: %s", user.email, e)


# ─── Email verification ───────────────────────────────────────────────────

EMAIL_VERIFY_EXPIRES_HOURS = 24
EMAIL_VERIFY_TOKEN_TYPE = "email_verify"


def _build_verify_url(user: User) -> str:
    """Sign a 24h JWT for email verification and return the click-through URL.
    The token has type=email_verify so it can't be reused as a session token
    even if a server-side bug accepted it on the wrong route."""
    from packages.common.src.auth import create_email_verify_token
    st = get_settings()
    base = (st.TRADER_APP_URL or "https://trade.swisdex.com").rstrip("/")
    token, _exp = create_email_verify_token(
        str(user.id), expires_hours=EMAIL_VERIFY_EXPIRES_HOURS,
    )
    return f"{base}/auth/verify-email?token={token}"


def _send_verify_email(user: User, request: Request | None = None) -> bool:
    """Schedule the focused verify-your-email message. Fire-and-forget.

    Returns True only if the email was actually built and handed to the
    SMTP sender — so the API can report `verification_sent` honestly instead
    of always claiming success (which masked "SMTP not configured" and render
    failures, making "email not arriving" impossible to diagnose).

    Template is intentionally minimal: greeting + verify CTA + expiry +
    "ignore if you didn't sign up" reassurance.
    """
    try:
        from packages.common.src.smtp_mail import (
            send_email, smtp_configured, fire_and_forget,
        )
        if not smtp_configured():
            logger.warning(
                "verify-email NOT sent for %s: SMTP is not configured "
                "(SMTP_HOST is empty in this service's environment)", user.email,
            )
            # Dev-only escape hatch: sign-in is blocked until the link is
            # clicked, so without SMTP a local signup could never log in.
            # Print the link in the gateway log so devs can click it there.
            if get_settings().ENVIRONMENT == "development":
                logger.warning("DEV verify link for %s: %s", user.email, _build_verify_url(user))
            return False
        from packages.common.src.email_templates.verify_email import render_verify_email
        verify_url = _build_verify_url(user)
        subject, html, text = render_verify_email(
            first_name=user.first_name,
            verify_url=verify_url,
            expires_hours=EMAIL_VERIFY_EXPIRES_HOURS,
        )
        fire_and_forget(send_email(user.email, subject, html, text=text, category="support"))
        logger.info("verify-email queued for %s", user.email)
        return True
    except Exception as e:
        logger.warning("verify-email scheduling failed for %s: %s", user.email, e)
        return False


async def confirm_email_verification(
    token: str, request: Request, db: AsyncSession,
) -> JSONResponse:
    """Validate a verify token, flip user.email_verified=True, and auto-login.

    Issuing the session cookies here makes the verify-email click the single
    entry point into the app — register_user no longer sets cookies, so this
    is the only path that grants a session to a freshly-signed-up user. That
    closes the email-verification bypass that the cookies-on-register flow
    had.

    Idempotent: clicking the link twice (e.g. once in inbox preview, once
    in the inbox itself) still returns a fresh session. Raises
    AuthServiceError on bad/expired tokens or unknown users.
    """
    from packages.common.src.auth import decode_email_verify_token
    payload = decode_email_verify_token(token)
    if not payload or payload.get("type") != EMAIL_VERIFY_TOKEN_TYPE:
        raise AuthServiceError("Verification link is invalid or expired", 400)
    user_id = payload.get("sub")
    if not user_id:
        raise AuthServiceError("Verification link is invalid", 400)
    res = await db.execute(select(User).where(User.id == UUID(str(user_id))))
    user = res.scalar_one_or_none()
    if not user:
        raise AuthServiceError("Account not found", 404)
    if not user.email_verified:
        user.email_verified = True
        user.email_verified_at = datetime.now(timezone.utc)
        await db.commit()
    return await issue_auth_json_response(
        user, request, db, status_code=200, user_audit_action="EMAIL_VERIFY",
    )


async def resend_verification_email(email: str, request: Request, db: AsyncSession) -> None:
    """Resend the verify link. Rate-limited and silently no-op for unknown
    emails so we don't leak account existence."""
    await rate_limit_http(request, "resend-verify", 3, 600.0)
    res = await db.execute(select(User).where(func.lower(User.email) == email.lower()))
    user = res.scalar_one_or_none()
    if not user:
        return  # no-op (don't leak whether the email is registered)
    if user.email_verified:
        return  # already verified
    _send_verify_email(user, request)


async def _maybe_send_new_login_email(
    user: User,
    request: Request,
    db: AsyncSession,
    new_session_id: UUID,
) -> None:
    """If this login is from a device we haven't seen before, email the user.

    "Unrecognized" = no prior UserSession (older than this one) shares the
    same user_agent string for this user. We compare on user-agent rather
    than IP to avoid noisy alerts for users on mobile networks where the
    IP changes constantly. Best-effort, fire-and-forget — never blocks the
    login response or rolls anything back."""
    try:
        ua = (request.headers.get("user-agent") or "").strip()
        if not ua:
            return
        prior_q = await db.execute(
            select(UserSession.id)
            .where(
                UserSession.user_id == user.id,
                UserSession.id != new_session_id,
                UserSession.user_agent == ua,
            )
            .limit(1)
        )
        if prior_q.scalar_one_or_none() is not None:
            return  # known device — no email

        # Also skip if this is the user's very first session ever (no point
        # warning them about their own initial login from registration).
        first_q = await db.execute(
            select(func.count())
            .select_from(UserSession)
            .where(UserSession.user_id == user.id)
        )
        if (first_q.scalar() or 0) <= 1:
            return

        from packages.common.src.smtp_mail import (
            send_email, smtp_configured, fire_and_forget,
        )
        if not smtp_configured() or not user.email:
            return
        from packages.common.src.email_templates import render_new_login

        ip = client_ip_for_inet(request) or None
        when_utc = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        st = get_settings()
        subject, html, text = render_new_login(
            first_name=user.first_name,
            ip_address=str(ip) if ip else None,
            user_agent=ua,
            location=None,
            when_utc=when_utc,
            trader_app_url=st.TRADER_APP_URL or "https://trade.swisdex.com",
        )
        fire_and_forget(send_email(user.email, subject, html, text=text, category="support"))
    except Exception as e:
        logger.debug("new-login email check failed for %s: %s", getattr(user, "email", "?"), e)


# ─── Utility: account number ─────────────────────────────────────────────

def generate_account_number() -> str:
    return f"PT{secrets.randbelow(90000000) + 10000000}"


# ─── Utility: referral attribution ───────────────────────────────────────

async def _consume_referral(db: AsyncSession, user_id: UUID, referral_code: str) -> None:
    """Attach a new user to the IB whose referral_code they used. Silent no-op if the code
    is missing, expired, or owned by an inactive IB — we don't want to block signup over it.
    On a successful link, also credits the IB referrer the signup bonus (XP/AC/PS)
    per XP_Reward_mechanism slide 4."""
    code = (referral_code or "").strip()
    if not code:
        return
    ib_q = await db.execute(
        select(IBProfile).where(IBProfile.referral_code == code, IBProfile.is_active == True)
    )
    ib_profile = ib_q.scalar_one_or_none()
    if ib_profile:
        db.add(Referral(referrer_id=ib_profile.user_id, referred_id=user_id, ib_profile_id=ib_profile.id))
        # Also set referred_by_user_id so the IB earns the PERSONAL referral
        # reward too (client 2026-06-23): the referral amount goes to EVERYONE
        # who refers — including IBs — while per-lot commission stays IB-only.
        # Without this an IB-code signup left referred_by_user_id NULL, so the
        # IB got no referral payout on the referee's first deposit / trades.
        new_user = (await db.execute(
            select(User).where(User.id == user_id)
        )).scalar_one_or_none()
        if (new_user is not None and new_user.referred_by_user_id is None
                and ib_profile.user_id != user_id):
            new_user.referred_by_user_id = ib_profile.user_id
        # Best-effort: a rewards-side failure must not block the signup itself.
        try:
            from . import rewards_service
            await rewards_service.award_signup_referral_bonus(
                db, referrer_user_id=ib_profile.user_id, referred_user_id=user_id,
            )
        except Exception as _e:
            logger.debug("signup referral bonus failed: %s", _e)


async def _attach_to_company_ib(db: AsyncSession, user_id: UUID) -> None:
    """If admin has designated a company IB AND the auto-attach toggle is
    on, parent any unreferred signup under that IB. This is what makes
    the 'House IB' a real default sink — bonus campaigns + organic
    signups all roll up to it so the broker can see them in one tree.
    """
    from packages.common.src.settings_store import (
        get_bool_setting, get_system_setting,
    )
    from sqlalchemy import func as _func

    company_ib = None

    # 1. Admin-configured company IB (only when the auto-attach toggle is on).
    if await get_bool_setting("company_ib_attach_unreferred", False):
        raw_uid = await get_system_setting("company_ib_user_id", None)
        if raw_uid and isinstance(raw_uid, str) and raw_uid.strip():
            try:
                company_user_id = UUID(raw_uid.strip())
                if company_user_id != user_id:
                    company_ib = (await db.execute(
                        select(IBProfile).where(
                            IBProfile.user_id == company_user_id,
                            IBProfile.is_active == True,
                        )
                    )).scalar_one_or_none()
            except (ValueError, AttributeError):
                company_ib = None

    # 2. Fall back to the Super IB (SDA05 root). Client 2026-06-19: every
    #    no-code / unreferred signup must land UNDER the Super IB — previously
    #    this only happened if an admin toggled company_ib_attach_unreferred,
    #    so organic signups were orphaned (never under the Super IB).
    if company_ib is None:
        code = str(await get_system_setting("super_ib_code", None) or "SDA05").strip()
        if code:
            company_ib = (await db.execute(
                select(IBProfile).where(
                    _func.lower(IBProfile.referral_code) == code.lower(),
                    IBProfile.is_active == True,
                )
            )).scalar_one_or_none()

    if company_ib is None or company_ib.user_id == user_id:
        return  # no default IB sink exists yet (or self-attribution)

    db.add(Referral(
        referrer_id=company_ib.user_id,
        referred_id=user_id,
        ib_profile_id=company_ib.id,
    ))
    # Same treatment as a code-based IB referral — Super IB gets the
    # XP/AC/PS signup bonus that a regular IB would earn for the same
    # unreferred user. Without this the Super IB sees the user in its
    # tree (and earns trade commissions) but is silently shorted on the
    # one-time signup credit. Best-effort: a rewards failure must not
    # block signup.
    try:
        from . import rewards_service
        await rewards_service.award_signup_referral_bonus(
            db, referrer_user_id=company_ib.user_id, referred_user_id=user_id,
        )
    except Exception as _e:
        logger.debug("Super IB signup bonus failed: %s", _e)


# ─── Core: issue auth response ───────────────────────────────────────────

async def issue_auth_json_response(
    user: User,
    request: Request,
    db: AsyncSession,
    *,
    status_code: int = 200,
    user_audit_action: str | None = None,
    audit_metadata: dict | None = None,
) -> JSONResponse:
    """Create user_session + refresh row, commit, return JSON (+ HttpOnly cookies).

    All inserts (session, refresh, optional audit log) are flushed together and
    committed atomically. Any exception raised before this commit leaves the
    transaction open for the route handler to roll back."""
    token, expires = create_access_token(str(user.id), user.role)
    new_session = UserSession(
        user_id=user.id,
        token_hash=hash_token(token),
        ip_address=client_ip_for_inet(request),
        user_agent=request.headers.get("user-agent"),
        expires_at=expires,
    )
    db.add(new_session)
    st = get_settings()
    raw_refresh = secrets.token_urlsafe(48)
    ref_exp = datetime.now(timezone.utc) + timedelta(days=st.JWT_REFRESH_EXPIRY_DAYS)
    db.add(
        UserRefreshToken(
            user_id=user.id,
            token_hash=hash_token(raw_refresh),
            expires_at=ref_exp,
            revoked=False,
        )
    )
    if user_audit_action:
        ua = (request.headers.get("user-agent") or "").strip()
        # device_info is plain Text; embed structured audit metadata (e.g. Google sub/email)
        # as a JSON suffix so it's later searchable via ILIKE without a schema change.
        device_info: str | None = ua[:2048] if ua else None
        if audit_metadata:
            try:
                meta_json = json.dumps(audit_metadata, separators=(",", ":"))
            except (TypeError, ValueError):
                meta_json = ""
            if meta_json:
                marker = f" :: meta={meta_json}"
                device_info = ((device_info or "") + marker)[:4096]
            # Also emit a structured app-log line so SIEM can pick it up without
            # parsing device_info, and so we don't lose the event if the DB write fails.
            logger.info(
                "auth_audit action=%s user_id=%s meta=%s",
                user_audit_action, user.id, audit_metadata,
            )
        db.add(
            UserAuditLog(
                user_id=user.id,
                action_type=user_audit_action,
                ip_address=client_ip_for_inet(request),
                device_info=device_info,
            )
        )
    await db.commit()

    # Best-effort: if the action is a LOGIN and this device hasn't been seen
    # before, fire a "new sign-in" email. Never raises into the login path.
    if user_audit_action == "LOGIN":
        try:
            await _maybe_send_new_login_email(user, request, db, new_session.id)
        except Exception:
            pass

    display_token = token if st.JWT_INCLUDE_LEGACY_JSON_TOKEN else ""
    # Mobile clients need the refresh token in the response body — they
    # can't read the HttpOnly pt_refresh cookie. Gated behind a flag so
    # web-only deployments keep the refresh token cookie-only (lower
    # exposure surface).
    body = TokenResponse(
        access_token=display_token,
        user_id=str(user.id),
        role=user.role,
        expires_at=expires,
        refresh_token=(raw_refresh if st.JWT_INCLUDE_REFRESH_IN_JSON else None),
    )
    resp = JSONResponse(content=body.model_dump(mode="json"), status_code=status_code)
    attach_auth_cookies(
        resp, request,
        access_token=token,
        access_expires_at=expires,
        raw_refresh=raw_refresh,
    )
    return resp


# ─── Registration ─────────────────────────────────────────────────────────

async def register_user(
    email: str,
    password: str,
    first_name: str,
    last_name: str,
    phone: str | None,
    country: str | None,
    referral_code: str | None,
    request: Request,
    db: AsyncSession,
) -> dict:
    from packages.common.src.settings_store import get_bool_setting

    await rate_limit_http(request, "register", 15, 3600.0)
    if await get_bool_setting("maintenance_mode", False):
        raise AuthServiceError(
            "Platform is under maintenance. Registrations are temporarily disabled.", 503
        )
    if not await get_bool_setting("allow_new_registrations", True):
        raise AuthServiceError("New registrations are currently disabled", 403)

    # Reject weak passwords ("12345678", common-list, single-class, etc.)
    # before we even hash + persist. Disallow list seeds substring checks
    # so traders can't make their email/name the password.
    from packages.common.src.password_policy import validate_password, PasswordTooWeak
    try:
        validate_password(password, disallow=[
            (email or "").split("@", 1)[0],
            first_name or "",
            last_name or "",
        ])
    except PasswordTooWeak as e:
        raise AuthServiceError(e.reason, 400)

    existing = await db.execute(select(User).where(User.email == email))
    if existing.scalar_one_or_none():
        raise AuthServiceError("Email already registered")

    user = User(
        email=email,
        password_hash=hash_password(password),
        first_name=first_name,
        last_name=last_name,
        phone=phone,
        country=country,
        role="user",
        status="active",
        kyc_status="pending",
        # Client 2026-07-10: email verification is MANDATORY again (reverses
        # the 2026-06-16 auto-verify). login_user 403s with email_unverified
        # until the user clicks the link; confirm_email_verification is the
        # only path that flips this and grants the first session. Google
        # sign-ups stay exempt — Google already asserts email_verified.
        email_verified=False,
        email_verified_at=None,
    )
    db.add(user)
    await db.flush()

    # Personal referral code (separate from IB MLM). Filled at signup so
    # the user has something to share from the /referral page on day 1.
    from . import referral_service as _ref
    await _ref.ensure_referral_code(db, user)

    linked_to_referrer = False
    if referral_code:
        # Try user-level referral first; if that fails, fall back to IB
        # MLM. The two systems coexist — a code uniquely belongs to one
        # of them (User.referral_code or IBProfile.referral_code).
        linked = await _ref.attach_referrer_by_code(db, user.id, referral_code)
        if linked is None:
            await _consume_referral(db, user.id, referral_code)
        linked_to_referrer = True  # any code attempt counts; bad codes still mean "they tried"

    # Fallback: if no ?ref= was used at all, optionally parent the new
    # user under the designated company IB so the house tree captures
    # all organic signups (admin toggle: company_ib_attach_unreferred).
    if not linked_to_referrer:
        try:
            await _attach_to_company_ib(db, user.id)
        except Exception as _ce:
            logger.debug("company-IB attach failed: %s", _ce)

    # Audit the registration so it shows on the admin Audit Logs page under
    # the "Registration" filter (action_type=REGISTER). Previously email
    # signups wrote no audit row at register time, so that filter was always
    # empty.
    try:
        _ua = request.headers.get("user-agent") if request else None
    except Exception:
        _ua = None
    db.add(UserAuditLog(
        user_id=user.id,
        action_type="REGISTER",
        ip_address=client_ip_for_inet(request) if request else None,
        device_info=_ua[:2048] if _ua else None,
    ))

    await db.commit()

    # Verification email is now the gate: sign-in stays blocked (403
    # email_unverified) until the link is clicked.
    verification_sent = _send_verify_email(user, request)
    return {
        "email": user.email,
        "verification_sent": verification_sent,
        "message": "Account created. Check your email to verify and sign in.",
    }


# ─── Login ────────────────────────────────────────────────────────────────

async def login_user(
    email: str,
    password: str,
    totp_code: str | None,
    request: Request,
    db: AsyncSession,
) -> JSONResponse:
    await rate_limit_http(request, "login", 5, 300.0)
    # Case-insensitive email lookup so users who registered with mixed case can still
    # sign in. The unique index on lower(email) (migration 0018) enforces uniqueness.
    result = await db.execute(select(User).where(func.lower(User.email) == email.lower()))
    user = result.scalar_one_or_none()

    # OAuth-only accounts (Google sign-in) have no password_hash. Reject the password
    # attempt with a clear message rather than silently calling bcrypt on None.
    if user and not user.password_hash:
        raise AuthServiceError(
            "This account uses Google sign-in. Click 'Continue with Google' instead.",
            400,
        )

    if not user or not verify_password(password, user.password_hash):
        raise AuthServiceError("Invalid credentials", 401)

    # Staff accounts (admins / employees) are User rows with an elevated role.
    # They MUST sign in through the admin panel — entering staff credentials on
    # the trader login is rejected so the admin surface never leaks into the
    # trader app (client 2026-06-23: "superadmin credentials se user login nahi
    # hona chahiye"). Impersonation ("Login As") is unaffected: login_as_user /
    # login_as_employee mint a token for the TARGET user directly and never
    # pass through this credential check.
    if user.role in ("admin", "super_admin", "employee", "manager", "support"):
        raise AuthServiceError(
            "This is a staff account. Please sign in through the admin panel.",
            403,
        )

    # Gate sign-in until the user has confirmed ownership of the email.
    # Existing users (registered before migration 0038) were backfilled
    # with email_verified=True so this only blocks new sign-ups that
    # haven't clicked the link yet. The 403 carries a structured detail
    # so the frontend can render a "check your email + resend" UI.
    if not bool(getattr(user, "email_verified", True)):
        raise AuthServiceError(
            {
                "code": "email_unverified",
                "message": "Please confirm your email before signing in. Check your inbox for the verification link.",
            },
            403,
        )

    _blk = login_block_message(user.status)
    if _blk:
        raise AuthServiceError(_blk, 403)

    # Maintenance mode: only admin / super_admin / employee roles may log in.
    if user.role not in ("admin", "super_admin", "employee"):
        from packages.common.src.settings_store import get_bool_setting
        if await get_bool_setting("maintenance_mode", False):
            raise AuthServiceError(
                "Platform is under maintenance. Please try again later.", 503
            )

    if user.two_factor_enabled:
        secret = (user.two_factor_secret or "").strip()
        if not secret:
            raise AuthServiceError(
                "Two-factor authentication is misconfigured for this account. Contact support.", 403
            )
        if not totp_code:
            raise AuthServiceError("2FA code required")
        # Per-ACCOUNT throttle on the 2FA step (keyed on user id, not just IP)
        # so a holder of a valid password can't brute-force the 6-digit TOTP by
        # rotating source IPs. Legitimate users need only a couple of attempts.
        await rate_limit_http(request, "login-2fa", 5, 300.0, extra_key=str(user.id))
        totp = pyotp.TOTP(secret)
        if not totp.verify(totp_code):
            raise AuthServiceError("Invalid 2FA code", 401)

    return await issue_auth_json_response(user, request, db, user_audit_action="LOGIN")


# ─── Demo login ───────────────────────────────────────────────────────────

async def _ensure_shared_demo_user(db: AsyncSession) -> User:
    from packages.common.src.settings_store import get_int_setting

    result = await db.execute(select(User).where(User.email == DEMO_SHARED_EMAIL))
    existing = result.scalar_one_or_none()
    if existing:
        if not existing.is_demo:
            raise AuthServiceError("This email is reserved for the platform demo account", 403)
        # Repair drift. profile_service.update_profile now blocks edits on
        # is_demo users, but rows that were corrupted before this guard
        # landed will keep showing whatever name the last visitor typed
        # ("abhi", etc.) until reset. Reset to canonical "Demo Trader" on
        # every demo-login so any leftover personalisation is wiped before
        # the next visitor sees the profile.
        canonical = {
            "first_name": "Demo",
            "last_name": "Trader",
            "phone": None, "country": None,
            "address": None, "city": None,
            "state": None, "postal_code": None,
            "date_of_birth": None,
        }
        for field, expected in canonical.items():
            if getattr(existing, field, None) != expected:
                setattr(existing, field, expected)
        # commit happens via issue_auth_json_response in the caller
        return existing

    default_leverage = await get_int_setting("default_leverage", 100)
    demo_password = secrets.token_urlsafe(32)
    user = User(
        email=DEMO_SHARED_EMAIL,
        password_hash=hash_password(demo_password),
        first_name="Demo", last_name="Trader",
        role="user", status="active", kyc_status="pending",
        is_demo=True, two_factor_enabled=False, two_factor_secret=None,
    )
    db.add(user)
    await db.flush()

    default_group = await db.execute(
        select(AccountGroup).where(AccountGroup.name == "Standard", AccountGroup.is_demo == False).limit(1)
    )
    group = default_group.scalars().first()
    db.add(TradingAccount(
        user_id=user.id, account_group_id=group.id if group else None,
        account_number=generate_account_number(), leverage=default_leverage, currency="USD", is_demo=False,
    ))

    demo_group = await db.execute(select(AccountGroup).where(AccountGroup.name == "Demo").limit(1))
    dg = demo_group.scalars().first()
    db.add(TradingAccount(
        user_id=user.id, account_group_id=dg.id if dg else None,
        account_number=generate_account_number(),
        balance=DEMO_STARTING_BALANCE, equity=DEMO_STARTING_BALANCE, free_margin=DEMO_STARTING_BALANCE,
        leverage=100, currency="USD", is_demo=True,
    ))
    await db.flush()
    return user


async def _ensure_demo_trading_account(db: AsyncSession, user: User) -> None:
    # NOTE: admin can provision multiple demo accounts for a user, so this
    # existence check MUST tolerate multiple rows — use .first(), not
    # scalar_one_or_none() which raises MultipleResultsFound on 2+ matches.
    q = await db.execute(
        select(TradingAccount.id)
        .where(TradingAccount.user_id == user.id, TradingAccount.is_demo == True)
        .limit(1)
    )
    if q.scalars().first() is not None:
        return
    demo_group = await db.execute(select(AccountGroup).where(AccountGroup.name == "Demo").limit(1))
    dg = demo_group.scalars().first()
    db.add(TradingAccount(
        user_id=user.id, account_group_id=dg.id if dg else None,
        account_number=generate_account_number(),
        balance=DEMO_STARTING_BALANCE, equity=DEMO_STARTING_BALANCE, free_margin=DEMO_STARTING_BALANCE,
        leverage=100, currency="USD", is_demo=True,
    ))
    await db.flush()


async def _reset_demo_state(db: AsyncSession, user: User) -> None:
    """Fresh playground on EVERY demo login (client 2026-07-14): the demo is a
    SHARED account, so previous visitors' trades drained it — new visitors saw
    $0 instead of the promised $100,000. Cancel leftover pending orders, close
    leftover open positions flat (at open price, zero P&L — no FK deletes),
    and reset every balance to DEMO_STARTING_BALANCE. Same philosophy as the
    profile-field reset above: each visitor gets the canonical demo."""
    if not user.is_demo:
        return
    now = datetime.now(timezone.utc)
    accounts = (await db.execute(
        select(TradingAccount).where(TradingAccount.user_id == user.id)
    )).scalars().all()
    for acct in accounts:
        pending = (await db.execute(
            select(Order).where(
                Order.account_id == acct.id, Order.status == OrderStatus.PENDING,
            )
        )).scalars().all()
        for o in pending:
            o.status = OrderStatus.CANCELLED
        open_pos = (await db.execute(
            select(Position).where(
                Position.account_id == acct.id, Position.status == PositionStatus.OPEN,
            )
        )).scalars().all()
        for p in open_pos:
            p.status = PositionStatus.CLOSED
            p.close_price = p.open_price
            p.profit = Decimal("0")
            p.closed_at = now
        acct.balance = DEMO_STARTING_BALANCE
        acct.equity = DEMO_STARTING_BALANCE
        acct.free_margin = DEMO_STARTING_BALANCE
        acct.margin_used = Decimal("0")
    user.main_wallet_balance = DEMO_STARTING_BALANCE


async def demo_login(request: Request, db: AsyncSession) -> JSONResponse:
    await rate_limit_http(request, "demo-login", 30, 60.0)
    user = await _ensure_shared_demo_user(db)
    await _ensure_demo_trading_account(db, user)
    await _reset_demo_state(db, user)
    _blk = login_block_message(user.status)
    if _blk:
        raise AuthServiceError(_blk, 403)
    return await issue_auth_json_response(user, request, db, user_audit_action="LOGIN")


# ─── Google OAuth ─────────────────────────────────────────────────────────

async def google_oauth(
    id_token_str: str,
    referral_code: str | None,
    request: Request,
    db: AsyncSession,
) -> JSONResponse:
    """Verify a Google id_token and sign the user in. Creates a new user, links to an
    existing email-based account, or returns the existing google-linked user."""
    assert_same_origin(request)
    await rate_limit_http(request, "google-oauth", 30, 60.0)

    st = get_settings()
    if not st.GOOGLE_CLIENT_ID:
        raise AuthServiceError("Google sign-in is not configured", 503)

    # Imported lazily so the rest of auth_service does not require google-auth
    # to be installed in environments that don't enable Google sign-in.
    try:
        from google.oauth2 import id_token as google_id_token  # type: ignore
        from google.auth.transport import requests as google_requests  # type: ignore
    except ImportError:
        raise AuthServiceError("Google sign-in dependency missing on server", 503)

    try:
        claims = google_id_token.verify_oauth2_token(
            id_token_str,
            google_requests.Request(),
            audience=st.GOOGLE_CLIENT_ID,
        )
    except ValueError as e:
        # Defensive: log without echoing the raw token payload back to the client.
        logger.warning("google id_token verification failed: %s", e)
        raise AuthServiceError("Invalid Google token", 401)

    # Issuer must be Google. verify_oauth2_token already checks this in current
    # versions of google-auth, but we re-validate explicitly so the contract is
    # part of *our* code and survives library upgrades.
    if claims.get("iss") not in ("accounts.google.com", "https://accounts.google.com"):
        raise AuthServiceError("Invalid token issuer", 401)

    # Authorized party (azp) — when set, must match our client id. Belt-and-braces
    # against a token minted for a different (sibling) client in the same project.
    azp = claims.get("azp")
    if azp and azp != st.GOOGLE_CLIENT_ID:
        raise AuthServiceError("Invalid authorized party", 401)

    if not claims.get("email_verified"):
        raise AuthServiceError("Google account email is not verified", 401)

    google_id = str(claims.get("sub") or "").strip()
    email = str(claims.get("email") or "").strip().lower()
    if not google_id or not email:
        raise AuthServiceError("Google token missing required claims", 401)

    first_name = (claims.get("given_name") or "").strip()
    last_name = (claims.get("family_name") or "").strip()

    is_new = False
    # Lookup-by-google_id first. with_for_update() takes a row lock so a racing
    # second request for the same google account can't double-insert.
    user = (
        await db.execute(
            select(User).where(User.google_id == google_id).with_for_update()
        )
    ).scalar_one_or_none()

    if user is None:
        # No google-linked row — try to link to an existing password account by email.
        # Lock the row so concurrent google logins for the same email serialize.
        user = (
            await db.execute(
                select(User).where(func.lower(User.email) == email).with_for_update()
            )
        ).scalar_one_or_none()
        if user is not None:
            # Reject linking if this email is already bound to a *different* google account.
            if user.google_id and user.google_id != google_id:
                raise AuthServiceError(
                    "Email is already linked to another Google account", 409
                )
            if not user.google_id:
                user.google_id = google_id
        else:
            user = User(
                email=email,
                password_hash=None,  # OAuth-only — no password
                google_id=google_id,
                first_name=first_name,
                last_name=last_name,
                role="user",
                status="active",
                kyc_status="pending",
                is_demo=False,
                language="en",
                theme="dark",
            )
            db.add(user)
            await db.flush()
            is_new = True
            # Personal referral code at signup (see register() — same call).
            from . import referral_service as _ref
            await _ref.ensure_referral_code(db, user)
            if referral_code:
                linked = await _ref.attach_referrer_by_code(db, user.id, referral_code)
                if linked is None:
                    await _consume_referral(db, user.id, referral_code)
            else:
                try:
                    await _attach_to_company_ib(db, user.id)
                except Exception as _ce:
                    logger.debug("company-IB attach (google) failed: %s", _ce)

    _blk = login_block_message(user.status)
    if _blk:
        raise AuthServiceError(_blk, 403)

    # Single commit point — issue_auth_json_response below adds session + refresh
    # rows and commits once. Any failure above raises before commit, so the
    # outer route handler's rollback restores a clean state.
    response = await issue_auth_json_response(
        user, request, db,
        status_code=201 if is_new else 200,
        user_audit_action="OAUTH_GOOGLE_REGISTER" if is_new else "OAUTH_GOOGLE_LOGIN",
        audit_metadata={"google_sub": google_id, "google_email": email},
    )
    # Welcome email only for first-time Google signups — returning users
    # logging in via Google have already received it.
    if is_new:
        _send_welcome_email(user, via_google=True)
    return response


# ─── Token refresh ────────────────────────────────────────────────────────

async def refresh_token(
    request: Request,
    db: AsyncSession,
    body_refresh_token: str | None = None,
) -> JSONResponse:
    await rate_limit_http(request, "auth-refresh", 60, 60.0)
    st = get_settings()
    # Mobile clients pass the refresh token in the JSON body; web sends an
    # empty body and we fall back to the HttpOnly pt_refresh cookie. The
    # cookie path is unchanged.
    raw = (body_refresh_token or "").strip() or request.cookies.get(st.REFRESH_TOKEN_COOKIE_NAME)
    if not raw or not raw.strip():
        raise AuthServiceError("Not authenticated", 401)
    th = hash_token(raw.strip())
    now = datetime.now(timezone.utc)
    q = await db.execute(
        select(UserRefreshToken).where(
            UserRefreshToken.token_hash == th,
            UserRefreshToken.revoked.is_(False),
            UserRefreshToken.expires_at > now,
        )
    )
    row = q.scalar_one_or_none()
    if not row:
        raise AuthServiceError("Invalid or expired session", 401)
    user = await db.get(User, row.user_id)
    if not user or login_block_message(user.status):
        raise AuthServiceError("Not authenticated", 401)
    row.revoked = True
    await db.flush()
    return await issue_auth_json_response(user, request, db)


# ─── Bootstrap session ────────────────────────────────────────────────────

async def bootstrap_session(access_token: str, request: Request, db: AsyncSession) -> JSONResponse:
    await rate_limit_http(request, "bootstrap-session", 30, 3600.0)
    try:
        payload = decode_token(access_token.strip())
    except Exception:
        raise AuthServiceError("Invalid token", 401)
    # Normal access tokens carry NO `type` claim; admin "Login As" impersonation
    # tokens carry type="user" (login_as_user) and are DELIBERATELY meant to open
    # a session for the target user. Any OTHER type (email_verify, password-reset,
    # …) is a single-purpose link token that must NOT be exchangeable for a
    # session — without this a leaked verify-email token could mint full cookies.
    if payload.get("type") not in (None, "user"):
        raise AuthServiceError("Invalid token", 401)
    try:
        uid = UUID(str(payload["sub"]))
    except (KeyError, ValueError, TypeError):
        raise AuthServiceError("Invalid token", 401)
    user = await db.get(User, uid)
    if not user:
        raise AuthServiceError("Invalid token", 401)
    _blk = login_block_message(user.status)
    if _blk:
        raise AuthServiceError(_blk, 403)
    return await issue_auth_json_response(user, request, db)


# ─── Forgot / Reset password ─────────────────────────────────────────────

async def forgot_password(email: str, request: Request, db: AsyncSession) -> dict:
    assert_same_origin(request)
    await rate_limit_http(request, "forgot-password", 5, 600.0, extra_key=email)
    msg = {"message": "If an account exists for this email, you will receive password reset instructions shortly."}
    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if not user or user.status in ("banned", "blocked"):
        return msg

    raw = secrets.token_urlsafe(32)
    token_hash = hash_token(raw)
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=15)
    db.add(PasswordResetToken(user_id=user.id, token_hash=token_hash, expires_at=expires_at, used=False))
    await db.commit()

    settings = get_settings()
    base = settings.TRADER_APP_URL.rstrip("/")
    link = f"{base}/auth/reset-password?token={raw}"

    from packages.common.src.smtp_mail import send_password_reset_email, smtp_configured
    if smtp_configured():
        sent = await send_password_reset_email(user.email, link)
        if sent:
            logger.info("Password reset email sent to %s", user.email)
        else:
            logger.error("Password reset email failed for %s", user.email)
    elif settings.ENVIRONMENT == "development":
        logger.warning("Password reset link (dev, SMTP not configured): %s", link)
    else:
        logger.warning("SMTP not configured — no email sent for %s", user.email)

    return msg


async def reset_password(token: str, new_password: str, request: Request, db: AsyncSession) -> dict:
    assert_same_origin(request)
    await rate_limit_http(request, "reset-password", 20, 600.0)
    token_hash = hash_token(token.strip())
    now = datetime.now(timezone.utc)
    result = await db.execute(
        select(PasswordResetToken).where(
            PasswordResetToken.token_hash == token_hash,
            PasswordResetToken.used.is_(False),
            PasswordResetToken.expires_at > now,
        )
    )
    row = result.scalar_one_or_none()
    if not row:
        raise AuthServiceError("Invalid or expired reset link")
    user = await db.get(User, row.user_id)
    if not user:
        raise AuthServiceError("Invalid or expired reset link")
    # Enforce the same policy here as at signup — otherwise "forgot password"
    # is a back-door for users to set "12345678".
    from packages.common.src.password_policy import validate_password, PasswordTooWeak
    try:
        validate_password(new_password, disallow=[
            (user.email or "").split("@", 1)[0],
            user.first_name or "",
            user.last_name or "",
        ])
    except PasswordTooWeak as e:
        raise AuthServiceError(e.reason, 400)
    user.password_hash = hash_password(new_password)
    row.used = True
    await db.commit()
    return {"message": "Password has been reset. You can sign in now."}


# ─── 2FA ──────────────────────────────────────────────────────────────────

def _generate_backup_codes(n: int = 10) -> list[str]:
    """Plain backup codes shown once to the user. Format: 4-4 hex
    (16 bits per group). Each is one-time use; we store bcrypt hashes
    server-side and discard the plaintext."""
    return [f"{secrets.token_hex(2)}-{secrets.token_hex(2)}" for _ in range(n)]


def _hash_backup_codes(codes: list[str]) -> list[str]:
    from packages.common.src.auth import hash_password
    return [hash_password(c) for c in codes]


def _consume_backup_code(stored_hashes: list[str], submitted: str) -> tuple[bool, list[str]]:
    """Return (matched, remaining_hashes_after_consume). bcrypt-compare
    submitted against each remaining hash in constant work (one per try).
    Single-use: matched hash is removed from the list."""
    from packages.common.src.auth import verify_password
    for i, h in enumerate(stored_hashes):
        try:
            if verify_password(submitted, h):
                return True, stored_hashes[:i] + stored_hashes[i + 1:]
        except Exception:
            continue
    return False, stored_hashes


async def setup_2fa(user_id: UUID, request: Request, db: AsyncSession) -> dict:
    assert_same_origin(request)
    await rate_limit_http(request, "2fa-setup", 5, 600.0, extra_key=str(user_id))
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    secret = pyotp.random_base32()
    totp = pyotp.TOTP(secret)
    provisioning_uri = totp.provisioning_uri(name=user.email, issuer_name="SwisDex")
    user.two_factor_secret = secret

    # Recovery codes — generate, hash, persist hashes, return plaintext to
    # the user (this is the ONE chance they have to copy them down).
    plaintext_codes = _generate_backup_codes()
    user.two_factor_backup_codes = _hash_backup_codes(plaintext_codes)

    await db.commit()
    return {
        "secret": secret,
        "qr_uri": provisioning_uri,
        "backup_codes": plaintext_codes,
        "backup_codes_warning": (
            "Store these codes in your password manager. Each can be used "
            "exactly once if you lose access to your authenticator app."
        ),
    }


async def verify_2fa(user_id: UUID, code: str, request: Request, db: AsyncSession) -> dict:
    assert_same_origin(request)
    # 5 attempts / 5 min per (IP, user) — TOTP is 6 digits, ~1m chance per try.
    await rate_limit_http(request, "2fa-verify", 5, 300.0, extra_key=str(user_id))
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user.two_factor_secret:
        raise AuthServiceError("2FA not set up")

    submitted = (code or "").strip()
    # Path A: 6-digit TOTP from authenticator app.
    if submitted.isdigit() and len(submitted) == 6:
        totp = pyotp.TOTP(user.two_factor_secret)
        if not totp.verify(submitted):
            raise AuthServiceError("Invalid code", 401)
    else:
        # Path B: backup recovery code (single-use). Format is xxxx-xxxx.
        stored = list(user.two_factor_backup_codes or [])
        ok, remaining = _consume_backup_code(stored, submitted)
        if not ok:
            raise AuthServiceError("Invalid code", 401)
        user.two_factor_backup_codes = remaining

    user.two_factor_enabled = True
    await db.commit()
    return {"message": "2FA enabled successfully"}


# ─── Password change ─────────────────────────────────────────────────────

async def change_password(user_id: UUID, old_password: str, new_password: str, db: AsyncSession) -> dict:
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not verify_password(old_password, user.password_hash):
        raise AuthServiceError("Current password is incorrect")
    user.password_hash = hash_password(new_password)
    await db.commit()
    return {"message": "Password changed successfully"}


# ─── Get current user profile ─────────────────────────────────────────────

async def get_me(user_id: UUID, db: AsyncSession) -> dict:
    """Return the user row plus the computed `profile_complete` flag.

    A profile is "complete" when all the fields the trader UI needs before
    deposits / trading become available are populated. Demo accounts and
    staff (admin/employee) auto-pass — they don't need to fill the gate."""
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise AuthServiceError("User not found", 404)

    if user.is_demo or user.role in ("admin", "super_admin", "employee", "manager", "support"):
        complete = True
    else:
        complete = bool(
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

    return {
        "id": user.id,
        "email": user.email,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "phone": user.phone,
        "country": user.country,
        "address": user.address,
        "city": user.city,
        "state": user.state,
        "postal_code": user.postal_code,
        "date_of_birth": user.date_of_birth,
        "role": user.role,
        "status": user.status,
        "kyc_status": user.kyc_status,
        "is_demo": bool(user.is_demo),
        "main_wallet_balance": float(user.main_wallet_balance or 0),
        "two_factor_enabled": bool(user.two_factor_enabled),
        "language": user.language or "en",
        "theme": user.theme or "dark",
        "profile_complete": complete,
        "wallet_address": user.wallet_address,
        "has_password": bool(user.password_hash),
        "has_google": bool(user.google_id),
        "created_at": user.created_at,
    }


# ─── Logout ───────────────────────────────────────────────────────────────

async def logout_user(user_id: UUID, request: Request, db: AsyncSession) -> JSONResponse:
    ua = (request.headers.get("user-agent") or "").strip()
    db.add(UserAuditLog(
        user_id=user_id, action_type="LOGOUT",
        ip_address=client_ip_for_inet(request),
        device_info=ua[:2048] if ua else None,
    ))
    await db.execute(
        update(UserRefreshToken).where(
            UserRefreshToken.user_id == user_id,
            UserRefreshToken.revoked.is_(False),
        ).values(revoked=True)
    )
    result = await db.execute(
        select(UserSession).where(UserSession.user_id == user_id, UserSession.is_active == True)
    )
    for s in result.scalars().all():
        s.is_active = False
    await db.commit()

    resp = JSONResponse(content={"message": "Logged out"})
    clear_auth_cookies(resp, request)
    return resp
