"""Periodic statement digest — weekly (Monday) and monthly (1st of month).

Pulls a per-user snapshot of trading activity over the relevant window:
realized P/L, total volume, deposits, withdrawals, commissions paid,
bonus credits, FR interest, insurance refunds. The engine assembles
this dict; the template just formats it.
"""
from __future__ import annotations

from decimal import Decimal

from .base import render_layout, kv_table


def _fmt_money(amount: Decimal | float, currency: str = "USD") -> str:
    a = float(amount or 0)
    sign = "" if a >= 0 else "-"
    return f"{sign}${abs(a):,.2f}" if currency.upper() == "USD" else f"{a:,.2f} {currency.upper()}"


def _fmt_lots(v: Decimal | float) -> str:
    return f"{float(v or 0):,.2f}"


def _fmt_int(v: int | None) -> str:
    return f"{int(v or 0):,}"


def render_statement_digest(
    *,
    first_name: str | None,
    period_label: str,           # "Week of 18–24 May 2026" / "May 2026"
    period_kind: str,            # "weekly" | "monthly"
    closing_balance: Decimal | float,
    realized_pnl: Decimal | float,
    total_volume_lots: Decimal | float,
    trades_closed: int,
    deposits_total: Decimal | float,
    withdrawals_total: Decimal | float,
    commissions_paid: Decimal | float,
    swap_paid: Decimal | float,
    bonus_credited: Decimal | float = 0,
    fr_interest_credited: Decimal | float = 0,
    insurance_refunds: Decimal | float = 0,
    currency: str = "USD",
    trader_app_url: str = "https://trade.swisdex.com",
) -> tuple[str, str, str]:
    name = (first_name or "trader").strip() or "trader"
    cadence = "weekly" if period_kind == "weekly" else "monthly"

    intro = (
        f"Your {cadence} SwisDex statement for {period_label}. Numbers "
        "below are based on activity settled to your trading and main "
        "wallet during the period."
    )

    pnl_row_color = "#55a630" if float(realized_pnl) >= 0 else "#e0524d"
    pnl_html = f"""
    <div style="margin:0 0 20px;padding:18px 20px;border:1px solid #e5e7eb;
                border-radius:10px;background:#f4f5f7;">
      <p style="margin:0 0 6px;color:#6b7280;font-size:12px;
                letter-spacing:0.4px;text-transform:uppercase;">
        Realized P/L
      </p>
      <p style="margin:0;color:{pnl_row_color};font-size:28px;font-weight:700;
                font-variant-numeric:tabular-nums;">
        {_fmt_money(realized_pnl, currency)}
      </p>
    </div>
    """

    rows: list[tuple[str, str]] = [
        ("Trades closed", _fmt_int(trades_closed)),
        ("Volume traded", f"{_fmt_lots(total_volume_lots)} lots"),
        ("Deposits", _fmt_money(deposits_total, currency)),
        ("Withdrawals", _fmt_money(withdrawals_total, currency)),
        ("Commissions paid", _fmt_money(-abs(float(commissions_paid)), currency)),
        ("Swap paid", _fmt_money(-abs(float(swap_paid)), currency)),
    ]
    if float(bonus_credited) > 0:
        rows.append(("Bonus credited", _fmt_money(bonus_credited, currency)))
    if float(fr_interest_credited) > 0:
        rows.append(("AI-POWERED STAKING PROGRAM interest", _fmt_money(fr_interest_credited, currency)))
    if float(insurance_refunds) > 0:
        rows.append(("Insurance refunds", _fmt_money(insurance_refunds, currency)))
    rows.append(("Closing balance", _fmt_money(closing_balance, currency)))

    body = pnl_html + kv_table(rows) + """
    <p style="margin:16px 0 0;color:#6b7280;font-size:13px;line-height:1.6;">
      Open the trader app for a per-trade breakdown and to download a CSV
      for your records.
    </p>
    """

    subject = f"Your SwisDex {cadence} statement — {period_label}"
    html = render_layout(
        title=f"{cadence.title()} statement",
        intro=intro,
        body_html=body,
        cta_label="View full statement",
        cta_url=f"{trader_app_url.rstrip('/')}/portfolio",
        hero_eyebrow=period_label,
    )
    text_lines = [
        f"Hi {name},",
        "",
        f"Your {cadence} SwisDex statement for {period_label}.",
        "",
        f"Realized P/L:        {_fmt_money(realized_pnl, currency)}",
        f"Trades closed:       {_fmt_int(trades_closed)}",
        f"Volume:              {_fmt_lots(total_volume_lots)} lots",
        f"Deposits:            {_fmt_money(deposits_total, currency)}",
        f"Withdrawals:         {_fmt_money(withdrawals_total, currency)}",
        f"Commissions paid:    {_fmt_money(-abs(float(commissions_paid)), currency)}",
        f"Swap paid:           {_fmt_money(-abs(float(swap_paid)), currency)}",
    ]
    if float(bonus_credited) > 0:
        text_lines.append(f"Bonus credited:      {_fmt_money(bonus_credited, currency)}")
    if float(fr_interest_credited) > 0:
        text_lines.append(f"FR interest:         {_fmt_money(fr_interest_credited, currency)}")
    if float(insurance_refunds) > 0:
        text_lines.append(f"Insurance refunds:   {_fmt_money(insurance_refunds, currency)}")
    text_lines += [
        f"Closing balance:     {_fmt_money(closing_balance, currency)}",
        "",
        f"Full statement: {trader_app_url.rstrip('/')}/portfolio",
    ]
    return subject, html, "\n".join(text_lines)
