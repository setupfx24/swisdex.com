'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  ArrowUpRight, ShieldCheck, BarChart3, Wallet, FileText, Gauge,
  Repeat, Gift, Users, Activity, AlertTriangle,
  ChevronDown, CheckCircle2,
} from 'lucide-react';
import { BannerPlaceholder } from '@/swisdex/components/BannerPlaceholder';
import { QuoteSection } from '@/swisdex/components/QuoteSection';
import { FixedReturnRateTable } from '@/swisdex/components/FixedReturnRateTable';

const SIGNUP_HREF = '/auth/register';

export default function AutomatedProfitPage() {
  return (
    <main className="min-h-screen bg-background">
      {/* 1. Hero */}
      <BannerPlaceholder
        title="Automated Profit Generation"
        tagline="Pre-built algorithmic investment plans designed to generate consistent monthly returns — even in volatile markets. Pick your tier, fund your account, the bots do the rest."
      />


      <section className="mx-auto max-w-[1200px] px-[var(--gutter)] py-10 sm:py-14">
        <div className="liquid-glass-strong rounded-3xl p-6 sm:p-10 grid lg:grid-cols-[1.2fr_1fr] gap-8 items-center">
          <div>
            <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full liquid-glass text-[11px] uppercase tracking-[0.16em] text-foreground/70">
              <span className="size-1.5 rounded-full bg-primary" /> Algo Powered
            </span>
            <h2 className="mt-5 font-display uppercase text-2xl sm:text-3xl md:text-4xl tracking-tight">
              Set it once. <span className="text-primary">Compound monthly.</span>
            </h2>
            <p className="mt-4 text-foreground/70 text-sm sm:text-base leading-relaxed max-w-xl">
              SwisDex Automated Profit plans are managed bot strategies with built-in capital protection,
              daily performance tracking, and flexible withdrawals. No charts to watch — open the dashboard
              once a week to see your returns.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link href="#plans" className="inline-flex items-center gap-2 rounded-full bg-primary text-white px-6 py-3 text-sm font-semibold uppercase tracking-wider hover:opacity-90">
                See Plans <ArrowUpRight className="size-4" />
              </Link>
              <Link href="#how-it-works" className="inline-flex items-center gap-2 rounded-full liquid-glass px-6 py-3 text-sm font-semibold uppercase tracking-wider hover:bg-foreground/10">
                How It Works
              </Link>
            </div>
          </div>
          {/* Algorithmic-trading dashboard stock photo. Swap for a branded
              screenshot once the production dashboard art is ready. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?auto=format&fit=crop&w=900&q=80"
            alt="Trading dashboard showing algorithmic performance"
            className="rounded-2xl w-full min-h-[260px] max-h-[340px] object-cover"
            style={{ border: '1px solid hsl(99 55% 42% / 0.35)' }}
          />
        </div>
      </section>

      {/* 2. How It Works (4 steps) */}
      <section id="how-it-works" className="mx-auto max-w-[1200px] px-[var(--gutter)] py-12 sm:py-16">
        <div className="text-center mb-10">
          <h2 className="font-display uppercase text-2xl sm:text-3xl md:text-4xl tracking-tight">How It Works</h2>
          <p className="mt-3 text-foreground/65 max-w-xl mx-auto text-sm sm:text-base">
            Four steps from signup to passive returns — typically completed in under 30 minutes.
          </p>
        </div>
        <ol className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {[
            { n: '01', icon: Users,    title: 'Open Account',    body: 'Sign up in under 3 minutes. Verification is automated and usually completes within 24 hours.' },
            { n: '02', icon: Wallet,   title: 'Choose & Fund',   body: 'Pick the plan that matches your goal — Starter, Growth, or Elite — and deposit via crypto, wire, or card.' },
            { n: '03', icon: Activity, title: 'Bots Activate',   body: 'The algorithmic engine starts trading within minutes of funding clearing. No manual setup required.' },
            { n: '04', icon: BarChart3, title: 'Track & Withdraw', body: 'Watch daily P&L in your dashboard. Withdraw profits or compound them — your choice, anytime.' },
          ].map(({ n, icon: Icon, title, body }) => (
            <li key={n} className="liquid-glass rounded-2xl p-6">
              <div className="flex items-center justify-between">
                <span className="font-display text-4xl text-primary/70">{n}</span>
                <div className="size-11 rounded-xl bg-primary/25 flex items-center justify-center"><Icon className="size-5 text-primary" /></div>
              </div>
              <h3 className="mt-4 font-display text-lg uppercase tracking-tight">{title}</h3>
              <p className="mt-2 text-sm text-foreground/65 leading-relaxed">{body}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Investor quote — Warren Buffett "make money while you sleep"
          Sits between How It Works and Plans per client request
          ("move this section 2 sections down"). */}
      <QuoteSection
        eyebrow="Why Automate"
        quote={
          <>
            &ldquo;If you don&rsquo;t find a way to{' '}
            <span className="text-primary font-bold">make money while you sleep</span>,
            you will <span className="text-primary font-bold">work until you die</span>.&rdquo;
          </>
        }
      />

      {/* 3. AI-POWERED STAKING PROGRAM policy — return rates by tenure and deposit tier */}
      <div id="plans">
        <FixedReturnRateTable />
      </div>

      {/* 4. Offers */}
      <section className="mx-auto max-w-[1200px] px-[var(--gutter)] py-12 sm:py-16">
        <div className="text-center mb-10">
          <h2 className="font-display uppercase text-2xl sm:text-3xl md:text-4xl tracking-tight">Bonuses & Offers</h2>
        </div>
        <div className="grid sm:grid-cols-3 gap-5">
          {[
            { icon: Gift,   title: 'Welcome Bonus',    amount: 'Up to $1,000', body: 'Tiered welcome bonus on your first deposit, credited to bonus equity. Fully tradeable from the moment it lands in your account.' },
            { icon: Users,  title: 'Referral Bonus',   amount: '$10 / friend', body: 'Earn $10 for every funded friend you refer — plus 10% of their first-month profits. No cap.' },
          ].map(({ icon: Icon, title, amount, body }) => (
            <article key={title} className="liquid-glass rounded-2xl p-6">
              <div className="size-11 rounded-xl bg-primary/25 flex items-center justify-center mb-4"><Icon className="size-5 text-primary" /></div>
              <h3 className="font-display text-lg uppercase tracking-tight">{title}</h3>
              <div className="mt-1 font-display text-2xl text-primary tabular-nums">{amount}</div>
              <p className="mt-2 text-sm text-foreground/65 leading-relaxed">{body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* 5. Features grid */}
      <section className="mx-auto max-w-[1200px] px-[var(--gutter)] py-12 sm:py-16">
        <div className="text-center mb-10">
          <h2 className="font-display uppercase text-2xl sm:text-3xl md:text-4xl tracking-tight">Built-In Protections</h2>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {[
            { icon: ShieldCheck, title: 'Capital Protection',     body: 'Hard drawdown caps stop trading before damage compounds. On-chain insurance covers policy-protected positions.' },
            { icon: BarChart3,   title: 'Daily Tracking',         body: 'Live equity curve, per-trade P&L, win-rate, and exposure metrics — refreshed every minute in your dashboard.' },
            { icon: Wallet,      title: 'Flexible Withdrawal',    body: 'Withdraw monthly (Starter), bi-weekly (Growth), or anytime (Elite). No lock-up beyond the first 7 days.' },
            { icon: FileText,    title: 'Transparent Reports',    body: 'Every fill, every fee, every adjustment is logged. Export your full statement to CSV or PDF on demand.' },
            { icon: Gauge,       title: 'Risk Management',        body: 'Stop-loss automation, position sizing by account risk %, regime-aware leverage — risk is governed, not guessed.' },
            { icon: Repeat,      title: 'Compound Option',        body: 'Toggle auto-reinvest to let monthly profits stack into your principal. Off by default — your choice, your control.' },
          ].map(({ icon: Icon, title, body }) => (
            <article key={title} className="liquid-glass rounded-2xl p-6">
              <div className="size-11 rounded-xl bg-primary/25 flex items-center justify-center mb-4"><Icon className="size-5 text-primary" /></div>
              <h3 className="font-display text-lg uppercase tracking-tight">{title}</h3>
              <p className="mt-2 text-sm text-foreground/65 leading-relaxed">{body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* 6. Performance chart placeholder */}
      <section className="mx-auto max-w-[1200px] px-[var(--gutter)] py-12 sm:py-16">
        <div className="liquid-glass-strong rounded-3xl p-6 sm:p-10">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-8">
            <div>
              <h2 className="font-display uppercase text-2xl sm:text-3xl tracking-tight">Historical Performance</h2>
              <p className="mt-2 text-foreground/60 text-sm">Aggregate Growth-tier track record. Past performance does not guarantee future results.</p>
            </div>
            <span className="liquid-glass rounded-full px-3 py-1 text-[11px] uppercase tracking-[0.16em] text-foreground/65 w-fit">Audited monthly</span>
          </div>
          <div className="grid sm:grid-cols-4 gap-4 mb-6">
            {[
              { label: '12-Mo Return',  value: '+108%' },
              { label: 'Avg Monthly',   value: '+9.4%' },
              { label: 'Max Drawdown',  value: '7.1%'  },
              { label: 'Profit Months', value: '11/12' },
            ].map((m) => (
              <div key={m.label} className="liquid-glass rounded-2xl p-5">
                <div className="text-[11px] uppercase tracking-[0.16em] text-foreground/55">{m.label}</div>
                <div className="mt-2 font-display text-3xl text-primary tabular-nums">{m.value}</div>
              </div>
            ))}
          </div>
          {/* TODO: Live equity-curve chart yahan aayega */}
          <div className="image-placeholder rounded-2xl bg-foreground/[0.05] min-h-[260px] flex items-center justify-center">
            <BarChart3 className="size-12 text-foreground/30" aria-hidden />
          </div>
        </div>
      </section>

      {/* 7. Eligibility */}
      <section className="mx-auto max-w-[1200px] px-[var(--gutter)] py-12 sm:py-16">
        <div className="grid lg:grid-cols-2 gap-6">
          <div className="liquid-glass rounded-3xl p-6 sm:p-8">
            <h2 className="font-display uppercase text-2xl tracking-tight">Eligibility</h2>
            <ul className="mt-5 space-y-3 text-sm text-foreground/75">
              {[
                'Age 18+ in a jurisdiction where retail CFD/crypto trading is permitted',
                'Valid government-issued ID for KYC verification',
                'Proof of address (utility bill or bank statement, less than 90 days old)',
                'Wallet or bank account in your own name',
                'Acknowledgement of the risk disclosure below',
              ].map((b) => (
                <li key={b} className="flex items-start gap-2.5">
                  <CheckCircle2 className="size-4 text-primary shrink-0 mt-0.5" />
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="liquid-glass rounded-3xl p-6 sm:p-8">
            <h2 className="font-display uppercase text-2xl tracking-tight">Not Eligible</h2>
            <ul className="mt-5 space-y-3 text-sm text-foreground/75">
              {[
                'Residents of currently restricted jurisdictions (full list at signup)',
                'US persons under current regulatory restrictions',
                'Sanctioned entities or individuals on prohibited lists',
                'Anyone unable or unwilling to complete KYC verification',
              ].map((b) => (
                <li key={b} className="flex items-start gap-2.5">
                  <span className="mt-1.5 size-1.5 rounded-full bg-foreground/40 shrink-0" />
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* 8. FAQ */}
      <section id="faq" className="mx-auto max-w-[800px] px-[var(--gutter)] py-12 sm:py-16">
        <h2 className="text-center font-display uppercase text-2xl sm:text-3xl tracking-tight mb-8">FAQ</h2>
        <div className="space-y-3">
          <FaqItem q="Are the monthly returns guaranteed?">
            No. The return bands shown are historical performance ranges. Past performance does not guarantee
            future results. Months can finish flat or negative — particularly during high-volatility regimes.
            Trade only with capital you can afford to lose.
          </FaqItem>
          <FaqItem q="When can I withdraw?">
            Starter: monthly window (1st–5th of each month). Growth: bi-weekly (1st & 15th). Elite: anytime,
            same-day for crypto, 1–3 business days for fiat. There is a 7-day initial lock-up on the first
            deposit to prevent abuse of the welcome bonus.
          </FaqItem>
          <FaqItem q="Who runs the algorithms?">
            The SwisDex quant desk — a team of senior systematic traders and ML engineers. Every strategy is
            walk-forward backtested for 5+ years, paper-traded for 90 days, and risk-capped for the first 60
            days of live deployment.
          </FaqItem>
          <FaqItem q="What's the difference between this and AI Auto Trading?">
            Automated Profit is a packaged plan with fixed tiers and curated strategy mixes — built for
            hands-off investors. AI Auto Trading is the underlying engine — for users who want full control
            over risk profile, allocation, and overrides.
          </FaqItem>
          <FaqItem q="What fees apply?">
            Zero management fee. Performance fee of 20% on profits above the high-water mark, deducted
            automatically at withdrawal. No deposit fees. Network/withdrawal fees pass through at cost.
          </FaqItem>
          <FaqItem q="Is my deposit insured?">
            Funds in segregated client accounts are held with tier-one banking partners. Open positions are
            policy-backed with on-chain insurance up to the policy limit. Insurance does not cover market loss
            within the policy threshold.
          </FaqItem>
        </div>
      </section>

      {/* 9. Risk disclosure (red border card) */}
      <section className="mx-auto max-w-[1200px] px-[var(--gutter)] py-12 sm:py-16">
        <div className="rounded-3xl p-6 sm:p-8" style={{ border: '1px solid hsl(0 100% 41% / 0.55)', background: 'hsl(0 100% 41% / 0.04)' }}>
          <div className="flex items-start gap-4">
            <div className="size-11 rounded-xl shrink-0 flex items-center justify-center" style={{ background: 'hsl(0 100% 41% / 0.18)' }}>
              <AlertTriangle className="size-5" style={{ color: 'hsl(0 100% 65%)' }} />
            </div>
            <div>
              <h2 className="font-display uppercase text-xl sm:text-2xl tracking-tight" style={{ color: 'hsl(0 100% 75%)' }}>
                Risk Disclosure
              </h2>
              <div className="mt-3 space-y-3 text-sm text-foreground/80 leading-relaxed">
                <p>
                  Trading and investing in forex, CFDs, cryptocurrencies, and algorithmic strategies carries a
                  high level of risk and may not be suitable for all investors. <strong>You can lose more than
                  your initial deposit.</strong> Leverage magnifies both gains and losses.
                </p>
                <p>
                  Past performance — including audited live performance — is not a reliable indicator of future
                  results. Monthly return bands published on this page are <strong>historical ranges, not
                  guarantees</strong>. Drawdown periods are normal and expected.
                </p>
                <p>
                  Before you invest, ensure you understand the risks involved and seek independent professional
                  advice if necessary. Only invest capital you can afford to lose entirely. SwisDex is not a
                  bank deposit — your investment is not protected by deposit-insurance schemes.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 10. CTA */}
      <section className="mx-auto max-w-[1200px] px-[var(--gutter)] pb-20">
        <div className="liquid-glass-strong rounded-3xl p-8 sm:p-12 text-center">
          <h2 className="font-display uppercase text-2xl sm:text-3xl tracking-tight">Start Earning Passively</h2>
          <p className="mt-4 text-foreground/70 max-w-xl mx-auto text-sm sm:text-base">
            Open a SwisDex account, pick your plan, and the bots take over. First deposit unlocks the welcome bonus.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Link href={SIGNUP_HREF} className="inline-flex items-center gap-2 rounded-full bg-primary text-white px-6 py-3 text-sm font-semibold uppercase tracking-wider hover:opacity-90">
              Open Account <ArrowUpRight className="size-4" />
            </Link>
            <Link href="#plans" className="inline-flex items-center gap-2 rounded-full liquid-glass px-6 py-3 text-sm font-semibold uppercase tracking-wider hover:bg-foreground/10">
              Compare Plans
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}

function FaqItem({ q, children }: { q: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="liquid-glass rounded-2xl">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="w-full flex items-center justify-between gap-4 px-5 py-4 text-left">
        <span className="font-display text-base sm:text-lg uppercase tracking-tight">{q}</span>
        <ChevronDown className={`size-5 text-foreground/55 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="px-5 pb-5 text-sm text-foreground/70 leading-relaxed">{children}</div>}
    </div>
  );
}
