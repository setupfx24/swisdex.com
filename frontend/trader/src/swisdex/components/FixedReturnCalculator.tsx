'use client';

/**
 * AI-POWERED STAKING PROGRAM Funds — public landing calculator.
 *
 * Mirrors the user-dashboard AI-POWERED STAKING PROGRAM calculator (app/fixed-return):
 * it pulls the SAME live rate matrix the dashboard uses (via the public
 * /fixed-return/public-config endpoint) and runs the identical projection
 * math, so the website always shows the exact numbers a logged-in user
 * sees — no hard-coded table that drifts from what admin configures.
 *
 * rate_matrix_pct cells are PER-MONTH percentages; the tenure decides the
 * payout cadence (monthsPerCycle) and the global lock_months drives the
 * total — same contract as the dashboard.
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Calculator, ArrowUpRight, TrendingUp } from 'lucide-react';

interface Tier { label: string; min_amount: number }
interface Tenure { label: string; days: number }
interface RateConfig {
  tiers: Tier[];
  tenures: Tenure[];
  rate_matrix_pct: number[][];
  early_withdrawal_fee_pct: number;
  lock_months: number;
}

// Fallback used only if the public-config endpoint is unreachable, so the
// section still renders something sensible. Mirrors the seed ladder.
const FALLBACK: RateConfig = {
  tiers: [
    { label: '$1K+', min_amount: 1_000 },
    { label: '$10K+', min_amount: 10_000 },
    { label: '$25K+', min_amount: 25_000 },
    { label: '$50K+', min_amount: 50_000 },
    { label: '$100K+', min_amount: 100_000 },
  ],
  tenures: [
    { label: 'Month', days: 30 },
    { label: 'Quarter', days: 90 },
    { label: 'Half-Year', days: 180 },
    { label: 'Year', days: 365 },
    { label: '2 Year', days: 730 },
  ],
  rate_matrix_pct: [
    [1, 2, 2.5, 3, 4],
    [2, 3, 3, 3.5, 4.5],
    [3, 4, 4.5, 5, 5],
    [4, 5, 5.5, 6, 5.5],
    [5, 6, 6.5, 7, 7],
  ],
  early_withdrawal_fee_pct: 10,
  lock_months: 12,
};

const TENURE_DISPLAY: Record<string, string> = {
  Month: '1 Month',
  Quarter: '3 Months',
  'Half-Year': '6 Months',
  Year: '12 Months',
  '2 Year': '24 Months',
};

const fmtUSD = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

// Same cadence mapping as the dashboard (app/fixed-return/page.tsx).
function monthsPerCycleFor(days: number): number {
  if (days >= 700) return 24;
  if (days >= 350) return 12;
  if (days >= 170) return 6;
  if (days >= 80) return 3;
  return 1;
}

export function FixedReturnCalculator() {
  const [cfg, setCfg] = useState<RateConfig>(FALLBACK);
  const [amountStr, setAmountStr] = useState('10000');
  const [tenureLabel, setTenureLabel] = useState<string>('Year');

  // Pull the LIVE global rate matrix (public, no auth) so the marketing
  // calculator matches the real product. Falls back silently to FALLBACK.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/v1/fixed-return/public-config', { cache: 'no-store' });
        if (!res.ok) return;
        const c = (await res.json()) as RateConfig;
        if (cancelled || !c?.tiers?.length || !c?.tenures?.length) return;
        setCfg(c);
        if (!c.tenures.some((t) => t.label === tenureLabel)) {
          // Prefer a 1-year tenure if present, else the first one.
          const year = c.tenures.find((t) => t.days >= 350 && t.days < 700);
          setTenureLabel((year ?? c.tenures[0]).label);
        }
      } catch {
        /* keep FALLBACK */
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const principal = useMemo(() => {
    const n = parseFloat(amountStr || '0');
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [amountStr]);

  const tierIdx = useMemo(() => {
    let idx = -1;
    cfg.tiers.forEach((t, i) => {
      if (principal >= t.min_amount) idx = i;
    });
    // sub-minimum deposits still show the entry tier so the user sees a number
    return idx < 0 ? 0 : idx;
  }, [cfg, principal]);

  const tenureIdx = useMemo(
    () => cfg.tenures.findIndex((t) => t.label === tenureLabel),
    [cfg, tenureLabel],
  );

  const ratePct = useMemo(() => {
    if (tierIdx < 0 || tenureIdx < 0) return 0;
    return cfg.rate_matrix_pct[tenureIdx]?.[tierIdx] ?? 0;
  }, [cfg, tierIdx, tenureIdx]);

  // Identical projection to the dashboard.
  const projected = useMemo(() => {
    if (tenureIdx < 0 || ratePct <= 0 || principal <= 0) {
      return { perCycle: 0, cycles: 0, total: 0, payout: principal, monthly: 0 };
    }
    const t = cfg.tenures[tenureIdx];
    const mpc = monthsPerCycleFor(t.days);
    const cycles = Math.max(1, Math.floor(cfg.lock_months / mpc));
    const perCycle = principal * (ratePct / 100) * mpc;
    const total = principal * (ratePct / 100) * cfg.lock_months;
    const monthly = principal * (ratePct / 100);
    return { perCycle, cycles, total, payout: principal + total, monthly };
  }, [cfg, tenureIdx, ratePct, principal]);

  const activeTier = cfg.tiers[tierIdx];

  return (
    <section className="mx-auto max-w-[1200px] px-[var(--gutter)] py-12 sm:py-16">
      <div className="text-center mb-10">
        <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full liquid-glass text-[11px] uppercase tracking-[0.16em] text-foreground/70">
          <Calculator className="size-3.5" /> AI-POWERED STAKING PROGRAM Calculator
        </span>
        <h2 className="mt-5 font-display uppercase text-2xl sm:text-3xl md:text-4xl tracking-tight">
          Estimate Your Payout
        </h2>
        <p className="mt-3 text-foreground/65 max-w-xl mx-auto text-sm sm:text-base">
          Pick a deposit and tenure — see your AI-POWERED STAKING PROGRAM at maturity. Live
          rates, the same ones you get inside your account.
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Inputs */}
        <div className="liquid-glass rounded-3xl p-6 sm:p-7">
          <label className="block">
            <span className="text-xs uppercase tracking-[0.16em] text-foreground/55">Deposit (USD)</span>
            <div className="mt-2 relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-foreground/50 text-sm">$</span>
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step="100"
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                className="w-full rounded-xl border border-foreground/15 bg-foreground/[0.04] pl-8 pr-4 py-3 text-base tabular-nums focus:outline-none focus:border-primary/60"
                placeholder="10,000"
              />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {cfg.tiers.map((t) => (
                <button
                  key={t.min_amount}
                  type="button"
                  onClick={() => setAmountStr(String(t.min_amount))}
                  className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                    principal === t.min_amount
                      ? 'border-primary/70 bg-primary/15 text-primary'
                      : 'border-foreground/15 text-foreground/70 hover:border-foreground/30'
                  }`}
                >
                  ${t.min_amount >= 1000 ? `${t.min_amount / 1000}K` : t.min_amount}
                </button>
              ))}
            </div>
          </label>

          <fieldset className="mt-6">
            <legend className="text-xs uppercase tracking-[0.16em] text-foreground/55">Tenure</legend>
            <div className="mt-2 grid grid-cols-5 gap-2">
              {cfg.tenures.map((t) => (
                <button
                  key={t.label}
                  type="button"
                  onClick={() => setTenureLabel(t.label)}
                  className={`px-2 py-2 text-xs rounded-lg border transition-colors text-center ${
                    tenureLabel === t.label
                      ? 'border-primary/70 bg-primary/15 text-primary font-semibold'
                      : 'border-foreground/15 text-foreground/70 hover:border-foreground/30'
                  }`}
                  aria-pressed={tenureLabel === t.label}
                >
                  {TENURE_DISPLAY[t.label] ?? t.label}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="mt-6 text-xs text-foreground/50">
            Tier:{' '}
            <span className="text-foreground/80 font-semibold tabular-nums">
              {activeTier ? `$${activeTier.min_amount.toLocaleString('en-US')}+` : '—'}
            </span>
            {' · '}Rate: <span className="text-primary font-semibold">{ratePct.toFixed(2)}% / mo</span>
          </div>
        </div>

        {/* Outputs */}
        <div className="liquid-glass-strong rounded-3xl p-6 sm:p-7">
          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-foreground/55">
            <TrendingUp className="size-3.5 text-primary" /> Projected payout
          </div>

          <div className="mt-3">
            <div className="text-xs uppercase tracking-wider text-foreground/55">You earn (total)</div>
            <div className="mt-1 font-display text-4xl sm:text-5xl text-primary tabular-nums">
              {fmtUSD(projected.total)}
            </div>
          </div>

          <dl className="mt-6 grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-wider text-foreground/55">Principal</dt>
              <dd className="mt-1 text-base tabular-nums">{fmtUSD(principal)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wider text-foreground/55">Monthly interest</dt>
              <dd className="mt-1 text-base tabular-nums">{fmtUSD(projected.monthly)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wider text-foreground/55">Per payout</dt>
              <dd className="mt-1 text-base font-semibold tabular-nums">
                {fmtUSD(projected.perCycle)}
                <span className="text-foreground/45 text-xs"> × {projected.cycles}</span>
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wider text-foreground/55">Total at maturity</dt>
              <dd className="mt-1 text-base font-semibold tabular-nums">{fmtUSD(projected.payout)}</dd>
            </div>
          </dl>

          <Link
            href="/auth/register"
            className="mt-7 inline-flex items-center gap-2 rounded-full bg-primary text-white px-6 py-3 text-sm font-semibold uppercase tracking-wider hover:opacity-90"
          >
            Open a Plan <ArrowUpRight className="size-4" />
          </Link>
          <p className="mt-3 text-[11px] text-foreground/45 leading-relaxed">
            Estimates only — actual contract terms may vary by jurisdiction
            and KYC tier. Early withdrawal forfeits the accrued return.
          </p>
        </div>
      </div>
    </section>
  );
}
