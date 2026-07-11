"""Dashboard-access email — sent after the trader finishes the profile-
completion gate (Save & Continue). Distinct from the verify-email message
that fires at signup: this one welcomes the trader into the platform and
hands them a one-click button to open the dashboard.

The link is just a deep URL into the trader app (`/accounts`). The user is
already authenticated in their original browser session via HttpOnly
cookies, so clicking it lands them on the dashboard. On a different
device, the trader app's auth guard will bounce them through /auth/login
first — same behaviour as any other deep link.
"""
from __future__ import annotations

from html import escape

from .base import render_layout


def render_dashboard_access(
    *,
    first_name: str | None,
    dashboard_url: str,
) -> tuple[str, str, str]:
    name = (first_name or "trader").strip() or "trader"

    intro = (
        "Your profile is complete and your SwisDex dashboard is ready. "
        "Click the button below to jump straight in — your trading "
        "accounts, deposits, and rewards are all one tap away."
    )

    body_html = (
        '<div style="margin:0 0 22px;padding:18px 20px;border:1px solid #e5e7eb;'
        'border-radius:8px;background:#f4f5f7;">'
        '<p style="margin:0 0 8px;color:#55a630;font-size:12px;font-weight:700;'
        'letter-spacing:0.8px;text-transform:uppercase;">You\'re all set</p>'
        '<p style="margin:0;color:#6b7280;font-size:13px;line-height:1.6;">'
        "We've saved your profile details. The dashboard is where you'll "
        "fund your account, open positions, follow top traders, and claim "
        "Earn Hub rewards."
        '</p>'
        '</div>'
        '<p style="margin:0 0 8px;color:#1a1a1a;font-size:14px;font-weight:700;">'
        "What you can do next:"
        '</p>'
        '<ul style="margin:0 0 16px;padding:0 0 0 18px;color:#1a1a1a;">'
        '<li style="margin:0 0 6px;font-size:13px;line-height:1.6;">'
        "Open your first trading account (live or demo)"
        '</li>'
        '<li style="margin:0 0 6px;font-size:13px;line-height:1.6;">'
        "Fund your wallet with a crypto or manual deposit"
        '</li>'
        '<li style="margin:0 0 6px;font-size:13px;line-height:1.6;">'
        "Browse markets and place your first trade"
        '</li>'
        '<li style="margin:0 0 6px;font-size:13px;line-height:1.6;">'
        "Complete KYC to unlock higher leverage and withdrawal limits"
        '</li>'
        '</ul>'
        '<p style="margin:18px 0 0;color:#6b7280;font-size:12px;line-height:1.6;">'
        "If the button doesn't work, copy and paste this link into your browser:<br>"
        f'<span style="color:#55a630;word-break:break-all;">{escape(dashboard_url)}</span>'
        '</p>'
    )

    subject = "Your SwisDex dashboard is ready"
    html = render_layout(
        hero_eyebrow="Profile Complete",
        title=f"Welcome aboard, {name}",
        intro=intro,
        body_html=body_html,
        cta_label="Open Dashboard",
        cta_url=dashboard_url,
        footer_note=(
            "You're receiving this email because you completed the SwisDex "
            "profile setup. If this wasn't you, please contact support."
        ),
    )

    text = (
        f"Welcome aboard, {name}\n\n"
        "Your profile is complete and your SwisDex dashboard is ready.\n"
        "Open it here:\n\n"
        f"  {dashboard_url}\n\n"
        "What you can do next:\n"
        "  - Open your first trading account (live or demo)\n"
        "  - Fund your wallet with a crypto or manual deposit\n"
        "  - Browse markets and place your first trade\n"
        "  - Complete KYC to unlock higher leverage and withdrawal limits\n\n"
        "If you didn't complete a SwisDex profile, please contact support.\n"
    )
    return subject, html, text
