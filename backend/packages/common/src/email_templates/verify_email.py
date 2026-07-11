"""Sign-up verification email — focused, single-purpose.

Earlier versions bundled welcome / onboarding content (capability bullets,
credentials block, "Why Trade with SwisDex" list) into this email so the
trader got one rich message instead of two back-to-back. The client
flagged that the welcome flavour buried the verify CTA and felt
mismatched for the moment — at signup the user just needs to confirm
ownership of their inbox; welcome content makes more sense once they're
actually inside the app. Layout is intentionally minimal: greeting,
one-line ask, the green CTA, expiry note, and the standard "ignore if
you didn't sign up" reassurance.

The signed token in `verify_url` is a JWT with type=email_verify and a
24-hour expiry — see auth_service._build_verify_url.
"""
from __future__ import annotations

from .base import render_layout


def render_verify_email(
    *,
    first_name: str | None,
    verify_url: str,
    expires_hours: int = 24,
) -> tuple[str, str, str]:
    name = (first_name or "there").strip() or "there"

    intro = (
        f"Hi {name}, click the button below to confirm this is your email "
        "address and activate your SwisDex account."
    )

    body_html = (
        f'<p style="margin:18px 0 0;color:#6b7280;font-size:13px;line-height:1.6;">'
        f"For your security, this link will expire in {expires_hours} hours. "
        "If it expires, sign in to request a new one."
        '</p>'
    )

    subject = "Verify your SwisDex email address"
    html = render_layout(
        title="Verify your email address",
        intro=intro,
        body_html=body_html,
        cta_label="Verify My Account",
        cta_url=verify_url,
        footer_note=(
            "If you didn't sign up for SwisDex, you can safely ignore this "
            f"email — the link will expire in {expires_hours} hours and no "
            "account will be activated."
        ),
    )

    text = (
        "Verify your SwisDex email address\n\n"
        f"Hi {name},\n\n"
        "Click the link below to confirm this is your email address and "
        "activate your SwisDex account.\n\n"
        f"  {verify_url}\n\n"
        f"This link will expire in {expires_hours} hours.\n\n"
        "If you didn't sign up for SwisDex, you can safely ignore this email.\n"
    )
    return subject, html, text
