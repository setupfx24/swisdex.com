"""Eligibility-nudge email — fired when a user has a funded account and
hasn't yet engaged with the AI-POWERED STAKING PROGRAM or Trade Insurance products.

The engine picks a single nudge based on which product is the better
fit (FR for idle balances, Insurance for active traders) so users don't
get two separate emails on the same day.
"""
from __future__ import annotations

from decimal import Decimal

from .base import render_layout, kv_table


def _fmt_money(amount: Decimal | float, currency: str = "USD") -> str:
    a = float(amount or 0)
    return f"${a:,.2f}" if currency.upper() == "USD" else f"{a:,.2f} {currency.upper()}"


def render_fr_insurance_eligibility(
    *,
    first_name: str | None,
    flavor: str,  # "fr" | "insurance" | "both"
    funded_balance: Decimal | float,
    fr_min_rate_pct: float = 6.0,
    fr_max_rate_pct: float = 18.0,
    insurance_base_payout_pct: float = 80.0,
    trader_app_url: str = "https://trade.swisdex.com",
) -> tuple[str, str, str]:
    """Pick subject/body based on flavor. The body links to the relevant
    product pages so the user can opt-in without admin involvement."""
    name = (first_name or "trader").strip() or "trader"

    if flavor == "fr":
        title = "Your balance can be earning"
        intro = (
            f"You're holding {_fmt_money(funded_balance)} on SwisDex. "
            f"AI-POWERED STAKING PROGRAM turns it into {fr_min_rate_pct:.0f}–{fr_max_rate_pct:.0f}% "
            "annualized yield while you wait for the next setup."
        )
        body = kv_table([
            ("Your eligible balance", _fmt_money(funded_balance)),
            ("Indicative rate", f"{fr_min_rate_pct:.0f}–{fr_max_rate_pct:.0f}% p.a."),
            ("Payout cadence", "Periodic — credited to your wallet automatically"),
            ("Lock", "24-month maximum; early-unlock available with a small fee"),
        ]) + f"""
        <p style="margin:16px 0 0;color:#6b7280;font-size:13px;line-height:1.6;">
          Cash on the sidelines costs you yield. Allocate any portion of your
          balance to a AI-POWERED STAKING PROGRAM plan and SwisDex pays interest on the
          allocated amount until you withdraw — no trading required.
        </p>
        """
        cta_label = "Browse AI-POWERED STAKING PROGRAM plans"
        cta_url = f"{trader_app_url.rstrip('/')}/fixed-return"
        subject = "Earn yield on the cash you're not trading"

    elif flavor == "insurance":
        title = "Trade with a safety net"
        intro = (
            "Your account has been active recently. Trade Insurance refunds "
            f"up to {insurance_base_payout_pct:.0f}% of a losing trade's lost "
            "premium so a single bad call doesn't wipe out a week's gains."
        )
        body = kv_table([
            ("How it works", "Pay a small per-trade premium when you open a position"),
            ("Payout on loss", f"Up to {insurance_base_payout_pct:.0f}% of the lost amount"),
            ("Eligible instruments", "Major FX, gold, indices, top crypto"),
            ("Cap", "Per-trade + lifetime caps set by the platform"),
        ]) + """
        <p style="margin:16px 0 0;color:#6b7280;font-size:13px;line-height:1.6;">
          Toggle insurance on the trade ticket — the premium is shown
          before you confirm, and the refund is automatic if your trade
          closes in loss within the eligible window.
        </p>
        """
        cta_label = "Enable Trade Insurance"
        cta_url = f"{trader_app_url.rstrip('/')}/insurance"
        subject = "Add a safety net to your next trade"

    else:  # "both"
        title = "Two products you haven't tried yet"
        intro = (
            f"You're sitting on {_fmt_money(funded_balance)} and trading "
            "regularly. SwisDex has two complementary products that work "
            "well for accounts like yours."
        )
        body = f"""
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
               border="0" style="border-collapse:separate;border-spacing:0 12px;">
          <tr>
            <td style="padding:14px 16px;border:1px solid #e5e7eb;border-radius:8px;
                       background:#f4f5f7;">
              <p style="margin:0 0 6px;color:#55a630;font-size:12px;font-weight:700;
                        letter-spacing:0.4px;text-transform:uppercase;">
                AI-POWERED STAKING PROGRAM
              </p>
              <p style="margin:0;color:#1a1a1a;font-size:14px;line-height:1.6;">
                Earn {fr_min_rate_pct:.0f}–{fr_max_rate_pct:.0f}% p.a. on
                idle cash. Lock terms up to 24 months, periodic interest
                payouts.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 16px;border:1px solid #e5e7eb;border-radius:8px;
                       background:#f4f5f7;">
              <p style="margin:0 0 6px;color:#55a630;font-size:12px;font-weight:700;
                        letter-spacing:0.4px;text-transform:uppercase;">
                Trade Insurance
              </p>
              <p style="margin:0;color:#1a1a1a;font-size:14px;line-height:1.6;">
                Refund up to {insurance_base_payout_pct:.0f}% of a losing
                trade's lost amount. Toggle per trade.
              </p>
            </td>
          </tr>
        </table>
        """
        cta_label = "Open AI-POWERED STAKING PROGRAM"
        cta_url = f"{trader_app_url.rstrip('/')}/fixed-return"
        secondary_cta_label = "Enable Insurance"
        secondary_cta_url = f"{trader_app_url.rstrip('/')}/insurance"
        subject = "Two SwisDex products that fit your account"

        html = render_layout(
            title=title, intro=intro, body_html=body,
            cta_label=cta_label, cta_url=cta_url,
            secondary_cta_label=secondary_cta_label, secondary_cta_url=secondary_cta_url,
            hero_eyebrow="Eligibility update",
        )
        text = (
            f"Hi {name},\n\n{intro}\n\n"
            f"AI-POWERED STAKING PROGRAM: {cta_url}\n"
            f"Trade Insurance: {secondary_cta_url}\n"
        )
        return subject, html, text

    html = render_layout(
        title=title, intro=intro, body_html=body,
        cta_label=cta_label, cta_url=cta_url,
        hero_eyebrow="Eligibility update",
    )
    text = (
        f"Hi {name},\n\n{intro}\n\n"
        f"Open: {cta_url}\n"
    )
    return subject, html, text
