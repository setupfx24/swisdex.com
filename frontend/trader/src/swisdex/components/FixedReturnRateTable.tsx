'use client';

/**
 * AI-POWERED STAKING PROGRAM Funds — rate matrix.
 * Columns: deposit tier. Rows: lock-up tenure. Cells: % return.
 *
 * Pulls the SAME live rate matrix the dashboard + calculator use
 * (/fixed-return/public-config) so all three stay in sync with admin.
 * Cells are PER-MONTH rates (the tenure sets the payout cadence), matching
 * the user-dashboard AI-POWERED STAKING PROGRAM product. Falls back to the seed ladder
 * if the endpoint is unreachable.
 */
import { useEffect, useState } from 'react';

interface Tier { label: string; min_amount: number }
interface Tenure { label: string; days: number }
interface RateConfig {
  tiers: Tier[];
  tenures: Tenure[];
  rate_matrix_pct: number[][];
}

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
};

const tierShort = (min: number) => `$${min >= 1000 ? `${min / 1000}K` : min}`;

const HEADER_BG = [
  'linear-gradient(180deg, #1f2937 0%, #0a0a0a 100%)',
  'linear-gradient(180deg, #2c3e50 0%, #0e1418 100%)',
  'linear-gradient(180deg, #55a630 0%, #1a3210 100%)',
  'linear-gradient(180deg, #2f7d18 0%, #0a1f08 100%)',
  'linear-gradient(180deg, #d00000 0%, #3d0000 100%)',
];

export function FixedReturnRateTable({ heading = true }: { heading?: boolean }) {
  const [cfg, setCfg] = useState<RateConfig>(FALLBACK);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/v1/fixed-return/public-config', { cache: 'no-store' });
        if (!res.ok) return;
        const c = (await res.json()) as RateConfig;
        if (!cancelled && c?.tiers?.length && c?.tenures?.length && c?.rate_matrix_pct?.length) {
          setCfg(c);
        }
      } catch {
        /* keep FALLBACK */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const tiers = cfg.tiers;
  return (
    <section className="mx-auto max-w-[1200px] px-[var(--gutter)] py-12 sm:py-16">
      {heading && (
        <div className="text-center mb-10">
          <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full liquid-glass text-[11px] uppercase tracking-[0.16em] text-foreground/70">
            <span className="size-1.5 rounded-full bg-primary" /> AI-POWERED STAKING PROGRAM Funds
          </span>
          <h2 className="mt-5 font-display uppercase text-2xl sm:text-3xl md:text-4xl tracking-tight">
            Return Rates by Tenure &amp; Tier
          </h2>
          <p className="mt-3 text-foreground/65 max-w-xl mx-auto text-sm sm:text-base">
            Lock your principal for a defined tenure and earn a AI-POWERED STAKING PROGRAM. Bigger deposits and longer
            lock-ups unlock higher rates.
          </p>
        </div>
      )}

      <div className="overflow-x-auto -mx-[var(--gutter)] px-[var(--gutter)]">
        <div className="min-w-[640px] rounded-2xl overflow-hidden border border-foreground/15">
          <table className="w-full" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th
                  scope="col"
                  className="bg-foreground/[0.04] border-r border-foreground/15 px-5 py-4 text-left text-xs uppercase tracking-[0.16em] text-foreground/55"
                >
                  Tenure
                </th>
                {tiers.map((tier, i) => (
                  <th
                    key={tier.min_amount}
                    scope="col"
                    className={`px-5 py-4 text-center font-display uppercase tracking-[0.16em] text-sm text-white ${
                      i < tiers.length - 1 ? 'border-r border-white/10' : ''
                    }`}
                    style={{ background: HEADER_BG[i % HEADER_BG.length] }}
                  >
                    {tierShort(tier.min_amount)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cfg.tenures.map((tn, ri) => (
                <tr key={tn.label} className="border-t border-foreground/10">
                  <th
                    scope="row"
                    className="px-5 py-4 text-left text-sm font-semibold text-foreground/85 bg-foreground/[0.04] border-r border-foreground/15"
                  >
                    {tn.label}
                  </th>
                  {tiers.map((_, ci) => {
                    const highlight = ri === cfg.tenures.length - 1 || ci === tiers.length - 1;
                    const v = cfg.rate_matrix_pct[ri]?.[ci];
                    return (
                      <td
                        key={ci}
                        className={`px-5 py-4 text-center text-sm tabular-nums ${
                          highlight ? 'text-primary font-semibold bg-primary/[0.08]' : 'text-foreground/90 bg-foreground/[0.02]'
                        } ${ci < tiers.length - 1 ? 'border-r border-foreground/10' : ''}`}
                      >
                        {v != null ? `${v}%` : '—'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="mt-5 text-center text-xs text-foreground/45 max-w-2xl mx-auto leading-relaxed">
        Rates are per month; the tenure sets how often the return is paid out.
        Early withdrawal forfeits the return earned to date and may incur a fee.
      </p>
    </section>
  );
}
