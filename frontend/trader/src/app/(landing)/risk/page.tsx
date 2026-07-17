'use client';

/**
 * Risk Disclaimer — public legal page.
 * Linked from footer; previously 404'd. Boilerplate adapted to SwisDex's
 * product mix (forex, CFDs, crypto, fixed-return-insurance plans).
 */
import Link from 'next/link';
import { ArrowUpRight, ShieldAlert, TriangleAlert, Info, Mail } from 'lucide-react';
import { BannerPlaceholder } from '@/swisdex/components/BannerPlaceholder';

const SECTIONS = [
  {
    h: '1. General Risk Warning',
    p: `Trading forex, contracts-for-difference (CFDs), crypto-assets, and structured-yield
    products carries a high level of risk and can result in losses that exceed your initial
    deposit. These products may not be suitable for every investor. You should only trade with
    capital you can afford to lose, and seek independent advice if you do not fully understand
    the risks involved.`,
  },
  {
    h: '2. Leverage',
    p: `Leverage allows you to control a position size larger than your account balance — and
    amplifies both gains and losses. A relatively small adverse market move can wipe out your
    margin and trigger a stop-out. SwisDex offers leverage up to 1:1000 across most pairs;
    leverage is a tool, not free capital. Size positions to your stop-loss, not to the maximum
    leverage available.`,
  },
  {
    h: '3. Volatility & Liquidity',
    p: `Crypto markets are open 24/7 and can move several percent in minutes during news or
    liquidations. Forex majors, indices, and energies have well-defined session hours; outside
    those hours spreads widen and liquidity thins. Order execution at the published market price
    is NOT guaranteed during gaps, slippage, or low-liquidity windows.`,
  },
  {
    h: '4. CFD-Specific Risks',
    p: `CFDs are derivative products — you do not own the underlying asset. P&L mirrors the price
    movement of the underlying but is settled in cash. Holding CFDs overnight incurs swap charges
    that compound. A negative-balance protection mechanism applies to retail accounts where
    available, but slippage during extreme moves can still wipe out the entire margin.`,
  },
  {
    h: '5. Crypto-Asset Risks',
    p: `Crypto-assets are subject to regulatory uncertainty, smart-contract risk, exchange-rate
    risk, and operational risk from custodians and bridges. On-chain transactions are
    irreversible. SwisDex DEX trades settle through smart-contracts that have been audited but
    are not guaranteed to be free of exploits. Do not deposit crypto you cannot afford to lose.`,
  },
  {
    h: '6. Welcome Bonus & Promotions',
    p: `Bonus equity is credited as tradeable balance and is absorbed by losing trades before your
    deposited capital. Bonus terms and unlock conditions are disclosed in your dashboard at the
    time of opt-in. Bonus equity is not in itself withdrawable.`,
  },
  {
    h: '7. AI-POWERED STAKING PROGRAM Plans',
    p: `AI-POWERED STAKING PROGRAM ("FRI") plans pay a contractual yield at maturity, underwritten by
    independent regulated insurance counterparties. Capital protection at maturity is subject to
    the underwriter's continuing solvency and the policy terms. FRI plans are NOT bank deposits
    and are NOT covered by deposit-insurance schemes. Early withdrawal, where permitted, forfeits
    accrued yield and may incur an exit fee.`,
  },
  {
    h: '8. Trade Insurance',
    p: `Trade Insurance, where activated on the order ticket, refunds a stated percentage of any
    covered losing trade up to the policy cap disclosed at the time of opt-in. The fee is
    deducted on trade open and is non-refundable. Insurance payouts are subject to minimum trade
    duration and the policy conditions visible at activation.`,
  },
  {
    h: '9. AI & Algo Trading',
    p: `Our AI-driven auto-trading and algorithmic strategies analyse historical and live market
    data but cannot anticipate every market condition. Past back-tested or live performance is
    not indicative of future results. You are responsible for monitoring positions, setting
    risk limits, and pausing strategies during high-impact news.`,
  },
  {
    h: '10. Tax Treatment',
    p: `The tax treatment of trading profits, swap interest, and bonus equity varies by
    jurisdiction. You are responsible for declaring and paying any applicable tax. SwisDex does
    not provide tax advice — consult a qualified tax adviser for your situation.`,
  },
  {
    h: '11. No Investment Advice',
    p: `Information published on swisdex.com, in market commentary, and inside the platform is
    general in nature and does not constitute personalised investment advice. We do not consider
    your individual objectives, financial situation, or needs.`,
  },
  {
    h: '12. Jurisdictional Restrictions',
    p: `SwisDex Services are not available to residents of jurisdictions where the offering of
    CFD, forex, or crypto-derivative trading is prohibited under local law. You are responsible
    for ensuring your use of the Services complies with the laws of your jurisdiction.`,
  },
  {
    h: '13. Acknowledgement',
    p: `By opening a SwisDex account you confirm you have read, understood, and accepted this Risk
    Disclaimer alongside our Terms of Service and Privacy Policy. You trade at your own risk.`,
  },
];

export default function RiskPage() {
  return (
    <main className="min-h-screen" style={{ background: '#08090b', color: '#f5f5f5' }}>
      <BannerPlaceholder
        title="Risk Disclaimer"
        tagline="Plain-English warnings about the risks of trading forex, CFDs, crypto, and structured-yield products."
      />

      <section className="mx-auto max-w-[840px] px-[var(--gutter)] pt-10 pb-6">
        <div
          className="rounded-2xl px-5 py-4 flex items-start gap-3 text-sm"
          style={{
            background: 'hsl(0 100% 41% / 0.10)',
            border: '1px solid hsl(0 100% 41% / 0.35)',
          }}
        >
          <TriangleAlert className="size-5 text-secondary shrink-0 mt-0.5" />
          <div className="text-foreground/85 leading-relaxed">
            <span className="font-semibold text-foreground">Important:</span> Trading carries
            significant risk. Past performance is not indicative of future results. You may lose
            some or all of your invested capital — only trade with money you can afford to lose.
          </div>
        </div>
      </section>

      <article className="mx-auto max-w-[840px] px-[var(--gutter)] py-8 sm:py-10 space-y-7">
        {SECTIONS.map(({ h, p }) => (
          <section key={h} className="liquid-glass rounded-2xl p-6 sm:p-7">
            <h2 className="font-display text-lg sm:text-xl uppercase tracking-tight text-foreground mb-3">
              {h}
            </h2>
            <p className="text-sm sm:text-[15px] leading-relaxed text-foreground/75">{p}</p>
          </section>
        ))}

        <div className="liquid-glass-strong rounded-2xl p-6 sm:p-7 flex flex-col sm:flex-row gap-4 sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <Info className="size-5 text-primary shrink-0 mt-0.5" />
            <p className="text-sm text-foreground/75 leading-relaxed">
              Cross-read with our{' '}
              <Link href="/terms" className="text-primary underline-offset-4 hover:underline">
                Terms of Service
              </Link>{' '}
              and{' '}
              <Link href="/privacy" className="text-primary underline-offset-4 hover:underline">
                Privacy Policy
              </Link>
              .
            </p>
          </div>
          <a
            href="mailto:info@swisdex.com"
            className="inline-flex items-center gap-2 rounded-full bg-primary text-white px-5 py-2.5 text-sm font-semibold uppercase tracking-wider hover:opacity-90 shrink-0"
          >
            <Mail className="size-4" /> Risk Queries
          </a>
        </div>
      </article>

      <section className="mx-auto max-w-[1200px] px-[var(--gutter)] pb-20">
        <div className="liquid-glass-strong rounded-3xl p-8 sm:p-12 text-center">
          <h2 className="font-display uppercase text-2xl sm:text-3xl tracking-tight inline-flex items-center gap-2">
            <ShieldAlert className="size-6 text-primary" /> Trade Responsibly
          </h2>
          <p className="mt-4 text-foreground/70 max-w-xl mx-auto text-sm sm:text-base">
            Open an account only after reading and accepting all our risk disclosures.
          </p>
          <Link
            href="/auth/register"
            className="mt-7 inline-flex items-center gap-2 rounded-full bg-primary text-white px-6 py-3 text-sm font-semibold uppercase tracking-wider hover:opacity-90"
          >
            Open Account <ArrowUpRight className="size-4" />
          </Link>
        </div>
      </section>
    </main>
  );
}
