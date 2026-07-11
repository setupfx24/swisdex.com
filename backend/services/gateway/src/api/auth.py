"""Authentication API — Register, Login, 2FA, Password Change, Demo login, Password reset."""
import json
import logging

from fastapi import APIRouter, Depends, HTTPException, status, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from packages.common.src.database import get_db
from packages.common.src.schemas import (
    RegisterRequest, LoginRequest, UserResponse,
    ForgotPasswordRequest, ResetPasswordRequest, MessageResponse, BootstrapSessionRequest,
    GoogleAuthRequest,
    WalletNonceRequest, WalletNonceResponse, WalletVerifyRequest,
)
from packages.common.src.auth import get_current_user
from ..services.auth_service import (
    AuthServiceError,
    register_user, login_user, demo_login as _demo_login,
    google_oauth as _google_oauth,
    refresh_token as _refresh_token, bootstrap_session as _bootstrap_session,
    forgot_password as _forgot_password, reset_password as _reset_password,
    setup_2fa as _setup_2fa, verify_2fa as _verify_2fa,
    change_password as _change_password, get_me as _get_me, logout_user,
    client_ip_for_inet,
    confirm_email_verification as _confirm_email_verification,
    resend_verification_email as _resend_verification_email,
)
from ..services import wallet_auth_service

logger = logging.getLogger("auth_api")

router = APIRouter()

# Keep this alias so orders.py (and any other module) that does
#   from .auth import _client_ip_for_inet
# continues to work without changes until orders.py is also refactored.
_client_ip_for_inet = client_ip_for_inet


@router.get("/platform-status")
async def platform_status():
    """Public: returns current platform flags so the frontend can gate UI
    (maintenance banner, register button, etc.). No auth required."""
    from packages.common.src.settings_store import get_bool_setting, get_float_setting
    return {
        "maintenance_mode": await get_bool_setting("maintenance_mode", False),
        "allow_new_registrations": await get_bool_setting("allow_new_registrations", True),
        "allow_deposits": await get_bool_setting("allow_deposits", True),
        "allow_withdrawals": await get_bool_setting("allow_withdrawals", True),
        # Copy-trading product visibility — admin can hide PAMM and/or
        # MAM/Copy-Trading from the trader app entirely.
        "pamm_enabled": await get_bool_setting("pamm_enabled", True),
        "mam_enabled": await get_bool_setting("mam_enabled", True),
        # Wallet minimums so the deposit/withdraw form can show the limit
        # up-front instead of only rejecting on submit.
        "min_deposit_amount_usd": float(await get_float_setting("min_deposit_amount_usd", 50.0)),
        "min_withdrawal_amount_usd": float(await get_float_setting("min_withdrawal_amount_usd", 70.0)),
        # Auto crypto withdrawal threshold — crypto withdrawals at/below this are
        # paid out automatically; larger ones need admin approval. 0 = off.
        "crypto_auto_withdrawal_enabled": await get_bool_setting("crypto_auto_withdrawal_enabled", False),
        "crypto_auto_withdrawal_max_usd": float(await get_float_setting("crypto_auto_withdrawal_max_usd", 0.0)),
    }


@router.get("/company-ib-code")
async def company_ib_code(db: AsyncSession = Depends(get_db)):
    """Public: returns the company / 'House' IB's referral code if one is
    designated. Used by the signup page's 'Apply' button to populate the
    referral code field with the broker's own IB code so unreferred
    signups can still claim the welcome bonus through the house tree.

    Returns ``{"referral_code": null}`` when no company IB is designated
    or the picked user has no active IB profile. The endpoint deliberately
    exposes only the code — no user identity, no stats — because it's
    unauthenticated.
    """
    from packages.common.src.settings_store import get_system_setting
    from packages.common.src.models import IBProfile

    raw_uid = await get_system_setting("company_ib_user_id", None)
    if not raw_uid or not isinstance(raw_uid, str) or not raw_uid.strip():
        return {"referral_code": None}

    try:
        from uuid import UUID as _UUID
        uid = _UUID(raw_uid.strip())
    except Exception:
        return {"referral_code": None}

    from sqlalchemy import select as _select
    row = (await db.execute(
        _select(IBProfile).where(
            IBProfile.user_id == uid,
            IBProfile.is_active == True,
        )
    )).scalar_one_or_none()
    return {"referral_code": row.referral_code if row else None}


@router.post("/register", status_code=status.HTTP_201_CREATED)
async def register(req: RegisterRequest, request: Request, db: AsyncSession = Depends(get_db)):
    # Cloudflare Turnstile gate — no-ops if SECRET isn't configured (dev /
    # staging without a key), rejects with 400 otherwise. Runs BEFORE
    # register_user so we don't hit the DB / send email for failed
    # CAPTCHA submissions.
    from packages.common.src.turnstile import verify_turnstile_token
    remote_ip = request.client.host if request.client else None
    if not await verify_turnstile_token(req.cf_turnstile_token, remote_ip=remote_ip):
        raise HTTPException(
            status_code=400,
            detail="CAPTCHA verification failed — please reload and try again.",
        )
    try:
        return await register_user(
            email=req.email, password=req.password,
            first_name=req.first_name, last_name=req.last_name,
            phone=req.phone, country=req.country,
            referral_code=req.referral_code,
            request=request, db=db,
        )
    except AuthServiceError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)


@router.get("/verify-email")
async def verify_email(token: str, request: Request, db: AsyncSession = Depends(get_db)):
    """Verify the email address using the signed token from the click-link.

    On success the response carries the session cookies (auto-login) so the
    frontend can redirect the user straight into `/accounts` — this is the
    single entry point that grants a session for new signups, since
    /auth/register no longer issues cookies.

    Idempotent: clicking the link twice still returns 200 + fresh cookies.
    """
    try:
        return await _confirm_email_verification(token, request=request, db=db)
    except AuthServiceError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)


class _ResendVerifyBody(__import__("pydantic").BaseModel):
    email: str


@router.post("/resend-verification", response_model=MessageResponse)
async def resend_verification(body: _ResendVerifyBody, request: Request, db: AsyncSession = Depends(get_db)):
    """Resend the verify-email link. Rate-limited (3 per 10 min per IP) and
    silently no-ops for unknown / already-verified addresses so we don't
    leak account existence."""
    try:
        await _resend_verification_email(email=body.email, request=request, db=db)
    except AuthServiceError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)
    return {"message": "If that email is registered and unverified, we've sent a new link."}


@router.post("/login")
async def login(req: LoginRequest, request: Request, db: AsyncSession = Depends(get_db)):
    try:
        return await login_user(
            email=req.email, password=req.password,
            totp_code=req.totp_code, request=request, db=db,
        )
    except AuthServiceError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)


@router.post("/demo-login")
async def demo_login(request: Request, db: AsyncSession = Depends(get_db)):
    try:
        return await _demo_login(request=request, db=db)
    except AuthServiceError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)
    except Exception as e:
        logger.exception("demo-login failed unexpectedly")
        try:
            await db.rollback()
        except Exception:
            pass
        raise HTTPException(
            status_code=500,
            detail="Demo sign-in failed, please try again.",
        )


@router.post("/google")
async def google_auth(req: GoogleAuthRequest, request: Request, db: AsyncSession = Depends(get_db)):
    try:
        return await _google_oauth(
            id_token_str=req.id_token,
            referral_code=req.referral_code,
            request=request,
            db=db,
        )
    except AuthServiceError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)
    except Exception as e:
        logger.exception("google sign-in failed unexpectedly")
        try:
            await db.rollback()
        except Exception:
            pass
        raise HTTPException(
            status_code=500,
            detail="Google sign-in failed, please try again.",
        )


@router.post("/wallet/nonce", response_model=WalletNonceResponse)
async def wallet_nonce(
    req: WalletNonceRequest, request: Request, db: AsyncSession = Depends(get_db),
):
    """Issue a single-use SIWE nonce for the given wallet address. The
    client embeds it in the SIWE message and the wallet signs it. The
    nonce expires in 5 minutes and is consumed exactly once on verify."""
    try:
        return await wallet_auth_service.issue_nonce(
            req.address, req.chain_id, request, db,
        )
    except AuthServiceError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)


@router.post("/wallet/verify")
async def wallet_verify(
    req: WalletVerifyRequest, request: Request, db: AsyncSession = Depends(get_db),
):
    """Verify a SIWE signature, find or create the user, and issue cookies.
    Reuses `issue_auth_json_response()` so wallet sessions are
    indistinguishable from email/Google sessions for downstream routes."""
    try:
        return await wallet_auth_service.login_or_register_with_wallet(
            req.message, req.signature, request, db,
            referral_code=req.referral_code,
        )
    except AuthServiceError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)
    except Exception as e:
        logger.exception("wallet verify failed unexpectedly")
        try:
            await db.rollback()
        except Exception:
            pass
        raise HTTPException(
            status_code=500,
            detail="Wallet sign-in failed, please try again.",
        )


@router.post("/refresh")
async def auth_refresh(request: Request, db: AsyncSession = Depends(get_db)):
    # Mobile path: refresh_token is provided in the JSON body (mobile cannot
    # use HttpOnly cookies). Web path: the body is empty and the service
    # reads the token from the pt_refresh cookie — byte-identical to the
    # pre-patch behaviour. Hand-parse the body so FastAPI's optional-body
    # behaviour stays out of the cookie path.
    body_refresh: str | None = None
    try:
        raw = await request.body()
        if raw:
            data = json.loads(raw)
            if isinstance(data, dict):
                v = data.get("refresh_token")
                if isinstance(v, str) and v.strip():
                    body_refresh = v.strip()
    except (ValueError, json.JSONDecodeError):
        # Malformed body — fall through to the cookie path; the service
        # will 401 if no usable refresh token can be found.
        pass
    try:
        return await _refresh_token(request=request, body_refresh_token=body_refresh, db=db)
    except AuthServiceError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)


@router.post("/bootstrap-session")
async def bootstrap_session(
    req: BootstrapSessionRequest, request: Request, db: AsyncSession = Depends(get_db),
):
    try:
        return await _bootstrap_session(
            access_token=req.access_token, request=request, db=db,
        )
    except AuthServiceError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)


@router.post("/forgot-password", response_model=MessageResponse)
async def forgot_password(req: ForgotPasswordRequest, request: Request, db: AsyncSession = Depends(get_db)):
    try:
        result = await _forgot_password(email=req.email, request=request, db=db)
        return MessageResponse(**result)
    except AuthServiceError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)


@router.post("/reset-password", response_model=MessageResponse)
async def reset_password(req: ResetPasswordRequest, request: Request, db: AsyncSession = Depends(get_db)):
    try:
        result = await _reset_password(token=req.token, new_password=req.new_password, request=request, db=db)
        return MessageResponse(**result)
    except AuthServiceError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)


@router.get("/me", response_model=UserResponse)
async def get_me(current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    try:
        return await _get_me(user_id=current_user["user_id"], db=db)
    except AuthServiceError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)


@router.post("/2fa/setup")
async def setup_2fa(request: Request, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    try:
        return await _setup_2fa(user_id=current_user["user_id"], request=request, db=db)
    except AuthServiceError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)


class Verify2FARequest(BaseModel):
    code: str


@router.post("/2fa/verify")
async def verify_2fa(
    body: Verify2FARequest,
    request: Request,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    try:
        return await _verify_2fa(user_id=current_user["user_id"], code=body.code, request=request, db=db)
    except AuthServiceError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)


class ChangePasswordBody(BaseModel):
    old_password: str
    new_password: str


@router.post("/password/change")
async def change_password(
    body: ChangePasswordBody,
    current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db),
):
    # Passwords MUST travel in the request body, never as query params — as
    # bare `str` args FastAPI bound them to the query string, leaking both the
    # old and new password into nginx/proxy access logs and browser history.
    try:
        return await _change_password(
            user_id=current_user["user_id"],
            old_password=body.old_password, new_password=body.new_password, db=db,
        )
    except AuthServiceError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)


@router.post("/logout")
async def logout(
    request: Request, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db),
):
    try:
        return await logout_user(user_id=current_user["user_id"], request=request, db=db)
    except AuthServiceError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)
