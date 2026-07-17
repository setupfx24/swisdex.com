"""Welcome email — sent ONLY when no email-verification step is needed.

In practice this fires for Google OAuth sign-ups (Google has already
verified the email, so we skip our own verify-link round-trip). Regular
email/password sign-ups receive the richer verify_email.py template
instead, which embeds the same welcome content plus the Verify CTA.

Layout matches the brand spec in verify_email.py so both onboarding
emails feel consistent — just without the verification prompt.
"""
from __future__ import annotations

from html import escape

from .base import render_layout


def _bullet(title: str, body: str) -> str:
    return f"""
    <li style="margin:0 0 14px;padding:0;">
      <strong style="color:#1a1a1a;font-size:14px;display:block;line-height:1.4;">
        {escape(title)}
      </strong>
      <span style="color:#6b7280;font-size:13px;line-height:1.6;display:block;margin-top:2px;">
        {escape(body)}
      </span>
    </li>
    """


def render_welcome(
    *,
    first_name: str | None,
    trader_app_url: str,
    via_google: bool = False,
    username: str | None = None,
    trading_id: str | None = None,
) -> tuple[str, str, str]:
    name = (first_name or "trader").strip() or "trader"

    intro = (
        "Thank you for choosing SwisDex. We are excited to welcome you to "
        "a growing community of active crypto and derivatives traders using "
        "one of the most advanced decentralized trading ecosystems available "
        "today. At SwisDex, your funds remain in your wallet while our "
        "infrastructure handles seamless and secure trade execution."
    )
    if via_google:
        intro += (
            " You signed in with Google — no password to remember; you can "
            "add one any time from your profile if you want."
        )

    experience_html = (
        '<p style="margin:24px 0 12px;color:#1a1a1a;font-size:14px;font-weight:700;">'
        "Here's what you're about to experience:"
        '</p>'
        '<ul style="margin:0 0 24px;padding:0 0 0 18px;color:#1a1a1a;">'
        + _bullet(
            "Powerful Web & Mobile Trading Platform",
            "Access fast and responsive trading tools designed for both beginners and professional traders.",
        )
        + _bullet(
            "Earn Hub Rewards",
            "Unlock daily streak rewards, Spin & Win bonuses, staking opportunities, and platform tasks.",
        )
        + _bullet(
            "Advanced Risk Management",
            "Trade with smart execution systems, leverage controls, and secure wallet-based infrastructure.",
        )
        + _bullet(
            "Demo Trading Account",
            "Practice your strategies in a completely risk-free environment before entering live markets.",
        )
        + '</ul>'
    )

    # Product & rewards highlights (client 2026-06-20: the welcome mail should
    # introduce referral, insurance, bonus, fixed-return and PAMM/MAM).
    products_html = (
        '<p style="margin:24px 0 12px;color:#1a1a1a;font-size:14px;font-weight:700;">'
        "Ways to earn more and protect your capital:"
        '</p>'
        '<ul style="margin:0 0 24px;padding:0 0 0 18px;color:#1a1a1a;">'
        + _bullet(
            "Referral Rewards",
            "Share your referral link — earn rewards when the people you invite join and start trading.",
        )
        + _bullet(
            "Trade Insurance",
            "Optionally insure a position so a covered loss is partly refunded. Trade with a built-in safety net.",
        )
        + _bullet(
            "Deposit Bonus",
            "Qualifying deposits can earn a bonus credited straight to your wallet, so you can size up from day one.",
        )
        + _bullet(
            "AI-POWERED STAKING PROGRAM",
            "Park capital in the AI-POWERED STAKING PROGRAM product for steady, capital-protected returns over a chosen term.",
        )
        + _bullet(
            "Introducing Broker (IB)",
            "Become an Introducing Broker and earn per-lot commissions on the clients you bring to SwisDex.",
        )
        + _bullet(
            "PAMM & MAM Investing",
            "Invest alongside expert money managers — or run a pool yourself — with profits shared automatically.",
        )
        + '</ul>'
    )

    credentials_html = ""
    if username or trading_id:
        credentials_html = (
            '<div style="margin:0 0 24px;padding:18px 20px;border:1px solid #e5e7eb;'
            'border-radius:8px;background:#f4f5f7;">'
            '<p style="margin:0 0 10px;color:#55a630;font-size:12px;font-weight:700;'
            'letter-spacing:0.8px;text-transform:uppercase;">Your Account Credentials</p>'
        )
        if username:
            credentials_html += (
                '<p style="margin:0 0 6px;color:#6b7280;font-size:13px;">'
                "To access your SwisDex Dashboard:"
                '</p>'
                '<p style="margin:0 0 14px;color:#1a1a1a;font-size:14px;">'
                f'<strong style="color:#1a1a1a;">Username:</strong> '
                f'<span style="color:#55a630;">{escape(username)}</span>'
                '</p>'
            )
        if trading_id:
            credentials_html += (
                '<p style="margin:14px 0 6px;color:#6b7280;font-size:13px;">'
                "To access your Trading Terminal:"
                '</p>'
                '<p style="margin:0;color:#1a1a1a;font-size:14px;">'
                f'<strong style="color:#1a1a1a;">Trading ID:</strong> '
                f'<span style="color:#55a630;font-variant-numeric:tabular-nums;">{escape(trading_id)}</span>'
                '</p>'
            )
        credentials_html += '</div>'

    def li(text: str) -> str:
        return (
            f'<li style="margin:0 0 6px;color:#1a1a1a;font-size:13px;line-height:1.6;">'
            f'{escape(text)}</li>'
        )
    why_html = (
        '<p style="margin:28px 0 10px;color:#1a1a1a;font-size:14px;font-weight:700;">'
        "Why Trade with SwisDex"
        '</p>'
        '<ul style="margin:0 0 8px;padding:0 0 0 18px;">'
        + li("Decentralized wallet-based trading")
        + li("Fast order execution")
        + li("Demo & live trading accounts")
        + li("Earn Hub rewards and staking")
        + li("Advanced charting and market tools")
        + li("Multi-device trading access")
        + li("24/7 support assistance")
        + li("Daily market insights and platform updates")
        + '</ul>'
    )

    closing = (
        '<p style="margin:28px 0 6px;color:#6b7280;font-size:13px;line-height:1.6;">'
        "If you have any questions or require assistance, our support team is always available."
        '</p>'
        '<p style="margin:14px 0 0;color:#1a1a1a;font-size:13px;line-height:1.6;">'
        "Best regards,<br>"
        '<strong>The SwisDex Broker House Team</strong>'
        '</p>'
        '<p style="margin:18px 0 0;color:#6b7280;font-size:11px;line-height:1.6;">'
        "Trading digital assets and leveraged products involves risk and may "
        "result in the loss of capital. Please trade responsibly."
        '</p>'
    )

    body_html = experience_html + products_html + credentials_html + why_html + closing

    subject = "Welcome to SwisDex"
    html = render_layout(
        hero_eyebrow="Welcome to the Future of Decentralized Trading",
        title=f"Dear {name},",
        intro=intro,
        body_html=body_html,
        cta_label="Open Dashboard",
        cta_url=f"{trader_app_url.rstrip('/')}/accounts",
        footer_note=(
            "If you didn't create this account, contact support@swisdex.com immediately."
        ),
    )
    text = (
        "Welcome to the Future of Decentralized Trading\n\n"
        f"Dear {name},\n\n"
        "Thank you for choosing SwisDex. We are excited to welcome you to a "
        "growing community of active crypto and derivatives traders.\n\n"
        "Here's what you're about to experience:\n"
        "  • Powerful Web & Mobile Trading Platform — fast, responsive tools for every level.\n"
        "  • Earn Hub Rewards — daily streaks, Spin & Win, staking, tasks.\n"
        "  • Advanced Risk Management — smart execution, leverage controls, wallet-based security.\n"
        "  • Demo Trading Account — practice strategies risk-free.\n\n"
        "Ways to earn more and protect your capital:\n"
        "  • Referral Rewards — earn when the people you invite join and start trading.\n"
        "  • Trade Insurance — insure a position so a covered loss is partly refunded.\n"
        "  • Deposit Bonus — qualifying deposits earn a bonus credited to your wallet.\n"
        "  • AI-POWERED STAKING PROGRAM — steady, capital-protected returns over a chosen term.\n"
        "  • Introducing Broker (IB) — earn per-lot commissions on the clients you bring in.\n"
        "  • PAMM & MAM Investing — invest alongside expert money managers, or run a pool yourself.\n\n"
    )
    if username:
        text += f"Username: {username}\n"
    if trading_id:
        text += f"Trading ID: {trading_id}\n"
    text += (
        f"\nOpen your dashboard: {trader_app_url.rstrip('/')}/accounts\n\n"
        "Why Trade with SwisDex:\n"
        "  • Decentralized wallet-based trading\n"
        "  • Fast order execution\n"
        "  • Demo & live trading accounts\n"
        "  • Earn Hub rewards and staking\n"
        "  • Advanced charting and market tools\n"
        "  • Multi-device trading access\n"
        "  • 24/7 support assistance\n"
        "  • Daily market insights and platform updates\n\n"
        "Best regards,\n"
        "The SwisDex Broker House Team\n\n"
        "Didn't create this account? Email support@swisdex.com immediately.\n"
    )
    return subject, html, text
