"""Transactional email via SMTP (Hostinger, SES, Gmail, etc.).

Single send path — `send_email(to, subject, html, text)` — used by every
business event (welcome, deposit, withdrawal, password reset). The
old `send_password_reset_email` is kept as a thin wrapper so existing
callers don't change.

The actual `smtplib` call runs in a thread (asyncio.to_thread) so the
event loop isn't blocked while SMTP handshakes.
"""
from __future__ import annotations

import asyncio
import logging
import os
import smtplib
import urllib.request
from email.message import EmailMessage
from typing import Optional

from .config import get_settings

logger = logging.getLogger(__name__)

# Brand logo bundled INSIDE the backend image so inline embedding never depends
# on a live network fetch of EMAIL_LOGO_URL (a transient fetch failure used to
# drop the logo to a remote <img> that image-blocking clients then hid). Read
# from disk first; the URL fetch below is only a fallback.
_LOCAL_LOGO_PATH = os.path.join(
    os.path.dirname(__file__), "email_templates", "swisdex_logo.png",
)


def _get_local_logo_bytes() -> Optional[tuple[bytes, str]]:
    """Bytes of the logo bundled with the backend, or None if it's absent."""
    try:
        with open(_LOCAL_LOGO_PATH, "rb") as f:
            data = f.read()
        if data:
            return (data, "png")
    except Exception:
        pass
    return None

# Cache of fetched logo bytes keyed by URL → (bytes, image_subtype). Filled
# lazily on the first send so we hit the network once, then embed the logo
# inline (cid:) in every mail. Inline images aren't blocked by Gmail/Outlook
# the way remote <img src="https://…"> are, which is why some clients showed
# a broken logo before. Failures are NOT cached so a transient fetch error
# just falls back to the remote URL and retries next send.
_LOGO_CACHE: dict[str, tuple[bytes, str]] = {}
_LOGO_CID = "swisdexlogo"


def _get_logo_bytes(url: str) -> Optional[tuple[bytes, str]]:
    """Fetch (and cache) the brand logo so it can be embedded inline.
    Returns (bytes, subtype) or None if the fetch fails."""
    if url in _LOGO_CACHE:
        return _LOGO_CACHE[url]
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "SwisDex-Mailer/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:  # noqa: S310 (trusted config URL)
            data = resp.read()
            ctype = (resp.headers.get("Content-Type") or "").lower()
        if not data:
            return None
        if "png" in ctype or url.lower().endswith(".png"):
            subtype = "png"
        elif "jpeg" in ctype or "jpg" in ctype or url.lower().endswith((".jpg", ".jpeg")):
            subtype = "jpeg"
        elif "gif" in ctype or url.lower().endswith(".gif"):
            subtype = "gif"
        else:
            subtype = "png"
        _LOGO_CACHE[url] = (data, subtype)
        return _LOGO_CACHE[url]
    except Exception:
        logger.warning("Could not fetch email logo %s — falling back to remote URL", url)
        return None


def smtp_configured() -> bool:
    s = get_settings()
    return bool(s.SMTP_HOST and str(s.SMTP_HOST).strip())


# Reserved / non-routable domains that can NEVER receive real mail (RFC 2606 /
# RFC 6761) plus our own demo-account domain. Sending to these always produces
# a "Undelivered Mail Returned to Sender" bounce that lands back in the sender
# inbox and, in volume, hurts sender reputation (real mail starts landing in
# spam). The demo downline seeded for the promo account use
# `@swisdex-promo.local`, which is why the inbox filled with bounces. We drop
# these at the single send choke point instead of attempting delivery.
_UNDELIVERABLE_SUFFIXES = (
    ".local", ".localhost", ".invalid", ".test", ".example",
    "@example.com", "@example.net", "@example.org",
)


# Platform-reserved addresses that never have a real mailbox — the shared
# demo login account chief among them. Suppressed unconditionally so no
# lifecycle email (statements, reminders, margin mails) ever bounces off them.
_ALWAYS_SUPPRESSED = {
    "demo@swisdex.com",
}


def _suppressed_addresses() -> set:
    """Exact addresses that must never be emailed: the built-in
    platform-reserved set plus ops' blacklist (comma-separated env
    EMAIL_SUPPRESSION_LIST). For mailboxes that don't exist (team test
    accounts like ib1@gmail.com, the shared demo user) — every lifecycle
    email to them hard-bounces back to the sender inbox and, in volume,
    hurts sender reputation (client 2026-07-14)."""
    try:
        from packages.common.src.config import get_settings
        raw = (getattr(get_settings(), "EMAIL_SUPPRESSION_LIST", "") or "")
    except Exception:  # noqa: BLE001 — never let config issues break sending
        raw = ""
    return _ALWAYS_SUPPRESSED | {a.strip().lower() for a in raw.split(",") if a.strip()}


def _is_undeliverable(to_email: str) -> bool:
    addr = (to_email or "").strip().lower()
    if addr in _suppressed_addresses():
        return True
    return any(addr.endswith(sfx) for sfx in _UNDELIVERABLE_SUFFIXES)


# ── Per-category From aliases ─────────────────────────────────────────
# Callers pass a `category=` keyword to `send_email`. The category is
# mapped to a settings field; if that field is blank, we fall through
# to the legacy single SMTP_FROM. This keeps backward compat (existing
# call sites that omit category continue to work) while letting each
# topical email come from a topical address.
#
# Display names per category — surfaces a useful sender label in the
# inbox preview even when the underlying mailbox is the generic support
# account. Override globally with MAIL_FROM_NAME (legacy behaviour).
_CATEGORY_DISPLAY_NAMES: dict[str, str] = {
    "account":    "SwisDex Account",
    "insure":     "SwisDex Insurance",
    "affiliates": "SwisDex Affiliates",
    "voucher":    "SwisDex Rewards",
    "stacking":   "SwisDex Earn",
    "info":       "SwisDex",
    "support":    "SwisDex Support",
    "default":    "SwisDex",
}


def _category_address(category: str) -> str | None:
    """Look up the alias address configured for a given category. Returns
    None when no per-category alias is set so the caller falls back to
    the legacy SMTP_FROM / SMTP_USER address."""
    s = get_settings()
    field = {
        "account":    getattr(s, "SMTP_FROM_ACCOUNT", "") or "",
        "insure":     getattr(s, "SMTP_FROM_INSURE", "") or "",
        "affiliates": getattr(s, "SMTP_FROM_AFFILIATES", "") or "",
        "voucher":    getattr(s, "SMTP_FROM_VOUCHER", "") or "",
        "stacking":   getattr(s, "SMTP_FROM_STACKING", "") or "",
        "info":       getattr(s, "SMTP_FROM_INFO", "") or "",
        "support":    getattr(s, "SMTP_FROM_SUPPORT", "") or "",
    }.get(category, "")
    addr = field.strip()
    return addr or None


def _from_address(category: str = "default") -> str:
    """Build the From header with the canonical display name.

    Routing:
      1. If a per-category alias env var is set (SMTP_FROM_<CATEGORY>),
         use it — wrapped with a category-aware display name.
      2. Otherwise fall back to SMTP_FROM, then SMTP_USER — wrapped with
         the global MAIL_FROM_NAME.

    Returns "<Display Name> <bare-email>" (RFC 5322 'name-addr').

    If the configured value is already in 'Name <addr>' form, we replace
    the name rather than nest two display names.
    """
    s = get_settings()

    cat = (category or "default").strip().lower()
    cat_addr = _category_address(cat)

    if cat_addr:
        raw = cat_addr
        name = _CATEGORY_DISPLAY_NAMES.get(cat) or _CATEGORY_DISPLAY_NAMES["default"]
    else:
        raw = (s.SMTP_FROM or s.SMTP_USER or "").strip()
        if not raw:
            raise ValueError("SMTP_FROM or SMTP_USER must be set when SMTP_HOST is set")
        # Legacy single-address path keeps the global display name so we
        # don't silently break existing branding.
        name = (getattr(s, "MAIL_FROM_NAME", None) or "SwisDex").strip()

    # Strip any pre-existing 'Name <addr>' wrapping — keep just the address.
    if "<" in raw and raw.endswith(">"):
        try:
            addr = raw[raw.rindex("<") + 1: -1].strip()
        except ValueError:
            addr = raw
    else:
        addr = raw
    return f"{name} <{addr}>"


def _attach_files(msg: EmailMessage, attachments: Optional[list]) -> None:
    """Attach caller-supplied files (e.g. support-ticket screenshots).

    Each item is a {name, type, data} dict where `data` is a base64 data URL
    (``data:image/png;base64,...``) or a bare base64 string. Silently skips a
    file that can't be decoded, or one over ~8 MB (SMTP servers reject huge
    messages) — the note in the body still tells the admin to check the panel.
    """
    import base64 as _b64
    for att in (attachments or []):
        try:
            raw = (att.get("data") or "") if isinstance(att, dict) else ""
            if not raw:
                continue
            mime = (att.get("type") or "").strip() if isinstance(att, dict) else ""
            if raw.strip().lower().startswith("data:") and "," in raw:
                header, b64 = raw.split(",", 1)
                if not mime and ":" in header and ";" in header:
                    mime = header.split(":", 1)[1].split(";", 1)[0].strip()
            else:
                b64 = raw
            content = _b64.b64decode(b64, validate=False)
            if not content or len(content) > 8 * 1024 * 1024:
                continue
            mime = mime or "application/octet-stream"
            maintype, _, subtype = mime.partition("/")
            msg.add_attachment(
                content, maintype=(maintype or "application"),
                subtype=(subtype or "octet-stream"),
                filename=(att.get("name") if isinstance(att, dict) else None) or "attachment",
            )
        except Exception:
            logger.warning("could not attach a file to email")


def _send_sync(to_email: str, subject: str, html: str, text: Optional[str], category: str,
               attachments: Optional[list] = None) -> None:
    s = get_settings()
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = _from_address(category)
    # Reply-To matches the From so a user hitting "Reply" goes back to the
    # topical inbox (e.g. account@) rather than the SMTP-credential mailbox
    # — important when those addresses differ.
    try:
        msg["Reply-To"] = msg["From"]
    except Exception:
        pass
    msg["To"] = to_email

    # Embed the brand logo inline (cid:) when the html references the
    # configured EMAIL_LOGO_URL and we can fetch its bytes. This sidesteps
    # the remote-image blocking that made the logo look broken in some
    # clients. If the fetch fails we leave the remote <img src> untouched.
    logo_bytes: Optional[tuple[bytes, str]] = None
    logo_url = (getattr(s, "EMAIL_LOGO_URL", "") or "").strip()
    if logo_url and logo_url in html:
        # Prefer the bundled logo (no network) and only fetch the URL if it's
        # missing from the image — guarantees the inline logo on every send.
        logo_bytes = _get_local_logo_bytes() or _get_logo_bytes(logo_url)
        if logo_bytes:
            html = html.replace(logo_url, f"cid:{_LOGO_CID}")

    # Always include a plain-text fallback. If the caller didn't give us one,
    # produce a crude strip-tags version of the html so picky clients still
    # render something.
    plain = text if text else _strip_tags(html)
    msg.set_content(plain)
    msg.add_alternative(html, subtype="html")

    if logo_bytes:
        # Attach the image to the html part so it becomes multipart/related
        # (alternative[text, related[html, image]]). Content-ID matches the
        # cid: reference we rewrote into the html above.
        html_part = msg.get_payload()[-1]
        try:
            html_part.add_related(
                logo_bytes[0], maintype="image", subtype=logo_bytes[1],
                cid=f"<{_LOGO_CID}>",
                # Mark it inline WITH a filename — without these the logo shows
                # up as a stray "noname" attachment in Gmail/Outlook
                # (client 2026-06-26).
                disposition="inline",
                filename=f"logo.{logo_bytes[1] or 'png'}",
            )
        except Exception:
            logger.exception("Failed to embed inline logo — mail will use remote URL fallback")

    # Real file attachments last, so they sit at the top level (multipart/mixed)
    # and don't disturb the inline-logo related part above.
    _attach_files(msg, attachments)

    host = str(s.SMTP_HOST).strip()
    port = int(s.SMTP_PORT)
    with smtplib.SMTP(host, port, timeout=30) as server:
        if s.SMTP_USE_TLS:
            server.starttls()
        user = (s.SMTP_USER or "").strip()
        pwd = (s.SMTP_PASSWORD or "").strip()
        if user:
            server.login(user, pwd)
        server.send_message(msg)


async def send_email(
    to_email: str,
    subject: str,
    html: str,
    *,
    text: Optional[str] = None,
    category: str = "info",
    attachments: Optional[list] = None,
) -> bool:
    """Send a transactional email. Returns True on success, False on
    misconfiguration or SMTP failure. Never raises — caller can ignore
    the result if they don't care.

    ``category`` selects which `From:` alias the message uses. Recognised:
      - account     — deposits, withdrawals
      - insure      — insured-trade payouts / reminders
      - affiliates  — IB, PAMM, MAM
      - voucher     — bonus, referral
      - stacking    — AI-POWERED STAKING PROGRAM, staking
      - info        — generic / website / default (the default)
      - support     — auth, KYC, password reset

    Unknown / blank categories fall back to the legacy SMTP_FROM address,
    so existing callers that don't pass the kwarg keep working.
    """
    if not smtp_configured():
        logger.warning("SMTP not configured — skipping email to %s subj=%r", to_email, subject)
        return False
    if not to_email or "@" not in to_email:
        logger.warning("Skipping email — bad recipient %r", to_email)
        return False
    # Demo / reserved domains (e.g. the @swisdex-promo.local downline) never
    # deliver — sending only generates bounce-backs to the sender inbox. Skip
    # silently (info log, not warning) so demo data doesn't pollute the queue.
    if _is_undeliverable(to_email):
        logger.info("Skipping email — non-deliverable/demo recipient %s subj=%r", to_email, subject)
        return False
    try:
        await asyncio.to_thread(_send_sync, to_email, subject, html, text, category, attachments)
        logger.info("email sent to=%s cat=%s subj=%r", to_email, category, subject)
        return True
    except Exception:
        logger.exception("Failed to send email to %s subj=%r", to_email, subject)
        return False


def fire_and_forget(coro) -> None:
    """Schedule a send_email coroutine on the running loop without awaiting.
    Use from API handlers + services so SMTP latency never delays a response
    and a delivery failure never rolls back a transaction."""
    try:
        asyncio.create_task(coro)
    except RuntimeError:
        # No running loop (sync context) — best-effort fallback.
        try:
            asyncio.run(coro)
        except Exception:
            logger.exception("fire_and_forget fallback failed")


# ─── Plain-text fallback ────────────────────────────────────────────


def _strip_tags(html: str) -> str:
    import re
    # Remove block-level tags as line breaks first so the plaintext is readable.
    txt = re.sub(r"</(p|div|h[1-6]|li|tr)>", "\n", html, flags=re.IGNORECASE)
    txt = re.sub(r"<br\s*/?>", "\n", txt, flags=re.IGNORECASE)
    txt = re.sub(r"<[^>]+>", "", txt)
    # Collapse whitespace.
    txt = re.sub(r"\n\s*\n+", "\n\n", txt)
    return txt.strip()


# ─── Backwards-compat helper used by auth_service.forgot_password ───


async def send_password_reset_email(
    to_email: str, reset_link: str, *, app_name: str = "SwisDex",
) -> bool:
    from .email_templates import render_password_reset
    subject, html, text = render_password_reset(app_name=app_name, reset_link=reset_link)
    # Password reset is a support-style transactional flow.
    return await send_email(to_email, subject, html, text=text, category="support")
