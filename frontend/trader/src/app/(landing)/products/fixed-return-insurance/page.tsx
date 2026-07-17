'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  ShieldCheck, TrendingUp, Calendar, Lock, FileCheck, Scale,
  ChevronDown, ArrowUpRight, Info,
} from 'lucide-react';
import { BannerPlaceholder } from '@/swisdex/components/BannerPlaceholder';
import { FixedReturnRateTable } from '@/swisdex/components/FixedReturnRateTable';
import { FixedReturnCalculator } from '@/swisdex/components/FixedReturnCalculator';

export default function FixedReturnInsurancePage() {
  return (
    <main className="min-h-screen bg-background">
      <BannerPlaceholder
        title="AI-POWERED STAKING PROGRAM"
        tagline="Capital-protected, fixed-yield plans for the part of your portfolio that needs to sleep at night."
      />

      {/* Key features */}
      <section id="features" className="mx-auto max-w-[1200px] px-[var(--gutter)] py-16 sm:py-20">
        <div className="text-center mb-12">
          <h2 className="font-display uppercase text-2xl sm:text-3xl md:text-4xl tracking-tight">
            <span className="text-primary">Capital protection</span> meets a fixed yield
          </h2>
          <p className="mt-4 text-foreground/65 max-w-2xl mx-auto text-sm sm:text-base leading-relaxed">
            A regulated, third-party-underwritten product. Lock in a known return for a fixed tenure;
            withdraw your principal in full at maturity. Built for risk-averse capital allocations.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {[
            { icon: ShieldCheck, title: 'Capital Protection',       body: 'Your principal is segregated and underwritten by a Tier-1 insurance counterparty. Returned in full at maturity.' },
            { icon: TrendingUp,  title: 'AI-POWERED STAKING PROGRAMs',             body: 'A clearly stated annual yield — no surprises, no last-look. What you sign up for is what you receive.' },
            { icon: Calendar,    title: 'Flexible Tenure',           body: 'Choose 6 months, 12 months, or 24 months. Longer tenures earn higher yields.' },
            { icon: Lock,        title: 'Segregated Accounts',       body: 'Funds are held separately from SwisDex operating capital, in regulated bank custody.' },
            { icon: FileCheck,   title: 'Regulatory Compliance',     body: 'AML / KYC verified. Compliant with relevant financial market authorities in our operating jurisdictions.' },
            { icon: Scale,       title: 'Transparent Terms',         body: 'Plain-English contract. No hidden fees, no auto-renewal traps. Mature, withdraw, or roll — your call.' },
          ].map(({ icon: Icon, title, body }) => (
            <article key={title} className="liquid-glass rounded-2xl p-6">
              <div className="size-11 rounded-xl bg-primary/25 flex items-center justify-center mb-4"><Icon className="size-5 text-primary" /></div>
              <h3 className="font-display text-lg uppercase tracking-tight">{title}</h3>
              <p className="mt-2 text-sm text-foreground/65 leading-relaxed">{body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* AI-POWERED STAKING PROGRAM rate matrix */}
      <FixedReturnRateTable />

      {/* Interactive payout calculator — pulls from the same rate matrix */}
      <FixedReturnCalculator />

      {/* How it works timeline */}
      <section id="how" className="mx-auto max-w-[1200px] px-[var(--gutter)] py-12 sm:py-16">
        <h2 className="text-center font-display uppercase text-2xl sm:text-3xl md:text-4xl tracking-tight mb-12">
          How It Works
        </h2>
        <ol className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5" aria-label="Investment lifecycle">
          {[
            { n: '01', title: 'Apply',         body: 'Submit a short application with KYC documents. Approval typically within 24 hours.' },
            { n: '02', title: 'Fund the Plan', body: 'Transfer your principal via bank wire, card, or crypto. Funds enter the segregated trust account.' },
            { n: '03', title: 'Quarterly Updates', body: 'Receive performance statements and (where applicable) quarterly yield payouts.' },
            { n: '04', title: 'Mature & Withdraw', body: 'At the end of the tenure, your principal plus the AI-POWERED STAKING PROGRAM is wired back to your account.' },
          ].map(({ n, title, body }) => (
            <li key={n} className="liquid-glass rounded-2xl p-6">
              <span className="font-display text-4xl text-primary/70">{n}</span>
              <h3 className="mt-4 font-display text-lg uppercase tracking-tight">{title}</h3>
              <p className="mt-2 text-sm text-foreground/65 leading-relaxed">{body}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Risk disclosure */}
      <section id="risk-disclosure" className="mx-auto max-w-[1200px] px-[var(--gutter)] py-10">
        <div className="liquid-glass-strong rounded-3xl p-6 sm:p-8">
          <h2 className="font-display uppercase text-lg sm:text-xl tracking-tight inline-flex items-center gap-2">
            <Info className="size-5 text-secondary" /> Risk Disclosure & Regulatory Notice
          </h2>
          <div className="mt-4 text-xs sm:text-sm text-foreground/65 leading-relaxed space-y-3">
            <p>
              AI-POWERED STAKING PROGRAM plans are underwritten by independent, regulated insurance counterparties.
              Capital protection refers to the contractual obligation of the underwriter at maturity, subject
              to the underwriter's solvency and the terms of the policy.
            </p>
            <p>
              Stated yields are <strong className="text-foreground/85">indicative net returns</strong> before
              applicable taxes in your jurisdiction. Early withdrawal, where permitted, may incur fees and is
              not a guaranteed feature of every plan.
            </p>
            <p>
              These plans are <strong className="text-foreground/85">not bank deposits</strong> and are not
              covered by deposit-insurance schemes. They are insurance-wrapped investment products with
              specific risk factors. Past performance does not guarantee future returns.
            </p>
            <p>
              SwisDex Ltd is a distributor and does not provide individual financial advice. Please review
              the full plan documents and, where appropriate, consult a regulated advisor before investing.
            </p>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="mx-auto max-w-[800px] px-[var(--gutter)] py-12 sm:py-16">
        <h2 className="text-center font-display uppercase text-2xl sm:text-3xl tracking-tight mb-8">FAQ</h2>
        <div className="space-y-3">
          <FaqItem q="Is my capital really protected?">
            Yes. Your principal is held in a segregated trust account and contractually returned at maturity
            by the regulated underwriter, subject to the policy's full terms.
          </FaqItem>
          <FaqItem q="Are the returns guaranteed?">
            The stated annual return is the contractual yield for the policy. It is not floating or
            performance-linked. It is, however, subject to the underwriter's solvency — see the risk disclosure.
          </FaqItem>
          <FaqItem q="Can I withdraw early?">
            No — the lock-in is 2 years. If you withdraw before maturity, an early-withdrawal
            penalty will be applied and the yield earned to date is forfeited.
          </FaqItem>
          <FaqItem q="Do I need to be a SwisDex trading client to apply?">
            No. The plans are open to non-trading investors. KYC and AML verification is still required.
          </FaqItem>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-[1200px] px-[var(--gutter)] pb-20">
        <div className="liquid-glass-strong rounded-3xl p-8 sm:p-12 text-center">
          <h2 className="font-display uppercase text-2xl sm:text-3xl tracking-tight">Build the stable core of your portfolio</h2>
          <p className="mt-4 text-foreground/70 max-w-xl mx-auto text-sm sm:text-base">
            Capital-protected, fixed-yield, regulated. Apply in minutes, fund in days.
          </p>
          <Link href="/auth/register" className="mt-7 inline-flex items-center gap-2 rounded-full bg-primary text-white px-6 py-3 text-sm font-semibold uppercase tracking-wider hover:opacity-90">
            Open Account <ArrowUpRight className="size-4" />
          </Link>
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
