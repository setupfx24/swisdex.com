"""'Claim your first-deposit bonus' email — fires once 24h after signup
if the user hasn't deposited yet. The actual bonus amount is whatever
BonusOffer the admin has configured (typically 100% of first deposit);
this email just nudges the user into the funnel."""
from __future__ import annotations

from .base import render_layout


def render_first_deposit_bonus_offer(
    *,
    first_name: str | None,
    trader_app_url: str = "https://trade.swisdex.com",
    bonus_pct: int = 100,
) -> tuple[str, str, str]:
    name = (first_name or "trader").strip() or "trader"
    # The layout HTML-escapes `intro`, so any tags here render as literal text
    # (the "<strong>...</strong>" the client saw). Keep intro plain — emphasis
    # belongs in body_html, which is not escaped.
    intro = (
        f"You're eligible for a {bonus_pct}% bonus on your "
        "first deposit — but you haven't funded your wallet yet. "
        "Deposit any amount and we'll instantly match it up to the cap."
    )
    body = """
    <p style="margin:0 0 12px;color:#1a1a1a;font-size:14px;line-height:1.6;">
      What you get:
    </p>
    <ul style="margin:0 0 8px;padding-left:20px;color:#1a1a1a;font-size:14px;line-height:1.7;">
      <li>Bonus credited to your wallet the moment your deposit is approved</li>
      <li>Use it to size up trades immediately — no extra paperwork</li>
      <li>Combine with the Fixed Return product for capital-protected returns</li>
    </ul>
    <p style="margin:16px 0 0;color:#6b7280;font-size:13px;line-height:1.6;">
      Bonuses follow SwisDex's standard offer terms. Larger deposits unlock
      additional tiered rewards.
    </p>
    """
    subject = f"You're eligible for a {bonus_pct}% first-deposit bonus"
    html = render_layout(
        title="Claim your welcome bonus",
        intro=intro,
        body_html=body,
        cta_label="Deposit & claim bonus",
        cta_url=f"{trader_app_url.rstrip('/')}/wallet",
        footer_note=(
            "This is a one-time email about the bonus offer — we won't "
            "send it again."
        ),
    )
    text = (
        f"Hi {name},\n\n"
        f"You're eligible for a {bonus_pct}% bonus on your first deposit at SwisDex.\n\n"
        f"Deposit at: {trader_app_url.rstrip('/')}/wallet\n"
        "Bonus credits instantly when your deposit is approved.\n"
    )
    return subject, html, text
