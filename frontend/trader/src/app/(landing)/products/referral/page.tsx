'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowUpRight, Users, Zap, Wallet, CheckCircle2, ChevronDown,
} from 'lucide-react';
import { BannerPlaceholder } from '@/swisdex/components/BannerPlaceholder';

const SIGNUP_HREF = '/auth/register';

/** Wire shape from /api/v1/referral/tiers — kept lean: only the fields
 *  the marketing page actually renders. Admin owns the data in
 *  /config/ib-tiers (system_settings.ib_commission_tiers). */
type ApiTier = {
  label: string;
  per_lot: number;
  min_activations: number;
  min_amount: number;
  instant_payout: boolean;
};

type DisplayTier = {
  label: string;        // "Bronze"
  perLot: string;       // commission shown in the table, e.g. "$5"
  requirement: string;  // "5+ activations"
  range: string;        // activation count range shown in the header, e.g. "1-20", "101+"
};

/** Admin-driven qualification conditions surfaced under the table.
 *  Server enforces these in referral_service.maybe_pay_referral_after_trades —
 *  this object is just what the marketing page renders so trader copy
 *  always matches the live engine. */
type Qualification = {
  requires_kyc: boolean;
  requires_funded_account: boolean;
  required_trades: number;
};

const DEFAULT_QUALIFICATION: Qualification = {
  requires_kyc: true,
  requires_funded_account: true,
  required_trades: 3,
};

/** Fallback shown while the API is loading or empty. Mirrors the visual
 *  design the client signed off on, so a fresh install still renders the
 *  ladder rather than going blank. */
const FALLBACK_TIERS: DisplayTier[] = [
  { label: 'Bronze', perLot: '$5',  requirement: '5+ activations',  range: '1-20' },
  { label: 'Silver', perLot: '$7',  requirement: '20+ activations', range: '21-100' },
  { label: 'Gold',   perLot: '$10', requirement: '50+ activations', range: '101+' },
];

const fmtUsd = (n: number) => `$${(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

function adaptApi(t: ApiTier): DisplayTier {
  const requirement = t.min_activations > 0 ? `${t.min_activations}+ activations` : '—';
  return {
    label: t.label,
    perLot: fmtUsd(t.per_lot || 0),
    requirement,
    range: t.min_activations > 0 ? `${t.min_activations}+` : '—', // refined below once neighbours are known
  };
}

/** Turn a sorted list of API tiers into display rows whose activation header
 *  reads as a range ("1-20", "21-100", … last "+"). A tier's range runs from
 *  its own activation threshold up to one below the next tier's threshold. */
function buildTiers(apiTiers: ApiTier[]): DisplayTier[] {
  return apiTiers.map((t, i) => {
    const d = adaptApi(t);
    const lo = t.min_activations > 0 ? t.min_activations : 1;
    const next = apiTiers[i + 1];
    d.range = next
      ? `${lo}-${Math.max(lo, (next.min_activations || lo) - 1)}`
      : `${lo}+`;
    return d;
  });
}

/** Header gradient cycles through (neutral / brand / accent) so the third
 *  card visually pops as the top tier. Keyed by index — admin can add 4+
 *  tiers and the cycle keeps going. */
const TIER_HEADER_GRADIENTS = [
  'linear-gradient(180deg, #1f2937 0%, #0a0a0a 100%)',
  'linear-gradient(180deg, #55a630 0%, #1a3210 100%)',
  'linear-gradient(180deg, #d00000 0%, #3d0000 100%)',
];

/** Comma-join with " and " before the last element so the activation
 *  sentence reads naturally for 1, 2, or 3 conditions. */
function joinClauses(parts: string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

export default function ReferralPage() {
  // Admin-managed tiers + qualification gates. Both fall back to the
  // documented defaults if the API is unreachable so the marketing page
  // never goes blank or out-of-sync with backend reality on first deploy.
  const [tiers, setTiers] = useState<DisplayTier[]>(FALLBACK_TIERS);
  const [qual, setQual] = useState<Qualification>(DEFAULT_QUALIFICATION);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/v1/referral/tiers', { credentials: 'omit' });
        if (!res.ok) return;
        const data: {
          tiers?: ApiTier[];
          qualification?: Partial<Qualification>;
        } = await res.json();
        if (cancelled) return;
        // Only accept the API response if it looks like real tier data:
        //   – at least one tier has a non-zero per-lot payout, AND
        //   – the tiers actually differ in min_activations (i.e. it's a
        //     ladder, not all-1s / all-0s which is what an un-seeded admin
        //     endpoint returns).
        // Otherwise keep FALLBACK_TIERS so the marketing page still shows
        // meaningful ranges + rewards rather than "1-1 / 1-1 / 1+  $0 $0 $0".
        const apiList = data.tiers || [];
        const hasPayout   = apiList.some(t => (t.per_lot || 0) > 0);
        const uniqueGates = new Set(apiList.map(t => t.min_activations)).size;
        const looksReal   = apiList.length > 0 && hasPayout && uniqueGates >= apiList.length;
        if (looksReal) {
          setTiers(buildTiers(apiList));
        }
        if (data.qualification) {
          setQual({
            requires_kyc: data.qualification.requires_kyc ?? DEFAULT_QUALIFICATION.requires_kyc,
            requires_funded_account:
              data.qualification.requires_funded_account ?? DEFAULT_QUALIFICATION.requires_funded_account,
            required_trades:
              data.qualification.required_trades ?? DEFAULT_QUALIFICATION.required_trades,
          });
        }
      } catch {
        /* keep fallback — public marketing page must never error out */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Compose the activation copy from the admin gates so the card stays
  // accurate when admin flips KYC / funded off for a promo. Always lists
  // "signs up via your referral link" — that's structural, not a toggle.
  const activationBits: string[] = ['signs up via your referral link'];
  if (qual.requires_kyc) activationBits.push('completes KYC verification');
  if (qual.requires_funded_account) activationBits.push('funds their account');
  const activationSentence = `Your friend ${joinClauses(activationBits)}.`;
  const tradesTitle = `Minimum ${qual.required_trades} trade${qual.required_trades === 1 ? '' : 's'}`;
  const tradesBody = `Your friend places at least ${qual.required_trades} trade${qual.required_trades === 1 ? '' : 's'} after activation. The moment the ${ordinal(qual.required_trades)} trade closes, your bounty is paid instantly.`;


  return (
    <main className="min-h-screen bg-background">
      <BannerPlaceholder
        title="Referral Program"
        tagline="Share your link, earn instantly. Per-referral payouts that scale with your volume — paid the moment your friend qualifies."
      />

      {/* Intro */}
      <section className="mx-auto max-w-[1200px] px-[var(--gutter)] py-12 sm:py-16">
        <div className="liquid-glass-strong rounded-3xl p-6 sm:p-10 grid lg:grid-cols-[1.2fr_1fr] gap-8 items-center">
          <div>
            <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full liquid-glass text-[11px] uppercase tracking-[0.16em] text-foreground/70">
              <span className="size-1.5 rounded-full bg-primary" /> Instant Per-Referral Bounty
            </span>
            <h2 className="mt-5 font-display uppercase text-2xl sm:text-3xl md:text-4xl tracking-tight">
              Refer. Activate. <span className="text-primary">Get Paid Instantly.</span>
            </h2>
            <p className="mt-4 text-foreground/70 text-sm sm:text-base leading-relaxed max-w-xl">
              Every time a friend signs up with your link, activates their account, and places their first 3 trades,
              you receive a one-time referral bounty straight to your wallet. No waiting. No claw-back. The more
              referrals you bring, the higher the per-referral payout.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link href={SIGNUP_HREF} className="inline-flex items-center gap-2 rounded-full bg-primary text-white px-6 py-3 text-sm font-semibold uppercase tracking-wider hover:opacity-90">
                Get Your Link <ArrowUpRight className="size-4" />
              </Link>
              <Link href="#tiers" className="inline-flex items-center gap-2 rounded-full liquid-glass px-6 py-3 text-sm font-semibold uppercase tracking-wider hover:bg-foreground/10">
                See Payouts
              </Link>
            </div>
          </div>
          {/* Referral illustration — branded artwork dropped by the client. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/refer_banner.png"
            alt="Referral program illustration"
            className="rounded-2xl w-full min-h-[260px] max-h-[340px] object-cover"
            style={{ border: '1px solid hsl(99 55% 42% / 0.35)' }}
          />
        </div>
      </section>

      {/* Referral payout tiers */}
      <section id="tiers" className="mx-auto max-w-[1200px] px-[var(--gutter)] py-12 sm:py-16">
        <div className="text-center mb-10">
          <h2 className="font-display uppercase text-2xl sm:text-3xl md:text-4xl tracking-tight">Referral Payouts</h2>
          <p className="mt-3 text-foreground/65 max-w-xl mx-auto text-sm sm:text-base">
            Move up the ladder automatically as your active referrals grow — no manual upgrade.
          </p>
        </div>

        <div className="overflow-x-auto -mx-[var(--gutter)] px-[var(--gutter)]">
          <div className="min-w-[640px] rounded-2xl overflow-hidden border border-foreground/15">
            <table className="w-full" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th className="bg-foreground/[0.04] border-r border-foreground/15 px-5 py-4 text-left text-xs uppercase tracking-[0.16em] text-foreground/55">
                    Activation
                  </th>
                  {tiers.map((t, i) => (
                    <th
                      key={`${t.label}-${i}`}
                      className={`px-5 py-4 text-center font-display uppercase tracking-[0.16em] text-sm text-white${
                        i < tiers.length - 1 ? ' border-r border-white/10' : ''
                      }`}
                      style={{ background: TIER_HEADER_GRADIENTS[i % TIER_HEADER_GRADIENTS.length] }}
                    >
                      {t.range}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {/* Reward row */}
                <tr className="border-t border-foreground/10">
                  <td className="px-5 py-4 text-sm text-foreground/75 bg-foreground/[0.04] border-r border-foreground/15">
                    Reward
                  </td>
                  {tiers.map((t, i) => {
                    const isMid = tiers.length >= 3 && i === Math.floor(tiers.length / 2);
                    return (
                      <td
                        key={`perlot-${i}`}
                        className={`px-5 py-4 text-center text-sm font-semibold ${
                          isMid ? 'text-foreground bg-primary/[0.08]' : 'text-foreground/90 bg-foreground/[0.02]'
                        }${i < tiers.length - 1 ? ' border-r border-foreground/10' : ''}`}
                      >
                        {t.perLot}
                      </td>
                    );
                  })}
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <p className="mt-5 text-center text-xs text-foreground/45 max-w-2xl mx-auto leading-relaxed">
          You earn the reward of the highest tier you reach. A tier unlocks once your activations
          cross its threshold. An activation = a referred client who completes KYC and at least 3 trades.
          Top partners can be set a custom rate.
        </p>
      </section>

      {/* Terms & Conditions */}
      <section className="mx-auto max-w-[1200px] px-[var(--gutter)] py-12 sm:py-16">
        <div className="liquid-glass-strong rounded-3xl p-6 sm:p-10 max-w-3xl mx-auto">
          <div className="text-center mb-6">
            <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/25 text-primary text-[11px] uppercase tracking-[0.18em] font-semibold">
              Terms &amp; Conditions
            </span>
            <h2 className="mt-4 font-display uppercase text-2xl sm:text-3xl tracking-tight">
              How a Referral Qualifies
            </h2>
            <p className="mt-3 text-foreground/65 text-sm sm:text-base">
              Two simple requirements — both must be met for a referral to count and trigger your payout.
            </p>
          </div>
          <ol className="grid sm:grid-cols-2 gap-4">
            {[
              { n: '1', title: 'Activation of user',  body: activationSentence },
              { n: '2', title: tradesTitle,           body: tradesBody },
            ].map((t) => (
              <li key={t.n} className="liquid-glass rounded-2xl p-5 sm:p-6">
                <div className="flex items-center justify-between">
                  <span className="font-display text-4xl text-primary/70">{t.n}</span>
                  <CheckCircle2 className="size-5 text-primary" aria-hidden />
                </div>
                <h3 className="mt-3 font-display text-lg uppercase tracking-tight">{t.title}</h3>
                <p className="mt-2 text-sm text-foreground/65 leading-relaxed">{t.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Why refer */}
      <section className="mx-auto max-w-[1200px] px-[var(--gutter)] py-12 sm:py-16">
        <div className="text-center mb-10">
          <h2 className="font-display uppercase text-2xl sm:text-3xl md:text-4xl tracking-tight">Why Refer Friends to SwisDex</h2>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {[
            { icon: Zap,    title: 'Instant Payout',     body: 'No weekly batching, no holding period. The bounty hits your wallet the moment your referral completes 3 trades.' },
            { icon: Users,  title: 'No Cap on Referrals', body: 'Refer 5 or 5,000 friends — your per-referral payout only goes up as you grow.' },
            { icon: Wallet, title: 'Stacks With IB',     body: 'If you upgrade to the IB partner programme later, your existing referrals stay credited to you for life.' },
          ].map(({ icon: Icon, title, body }) => (
            <article key={title} className="liquid-glass rounded-2xl p-6">
              <div className="size-11 rounded-xl bg-primary/25 flex items-center justify-center mb-4"><Icon className="size-5 text-primary" /></div>
              <h3 className="font-display text-lg uppercase tracking-tight">{title}</h3>
              <p className="mt-2 text-sm text-foreground/65 leading-relaxed">{body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="mx-auto max-w-[800px] px-[var(--gutter)] py-12 sm:py-16">
        <h2 className="text-center font-display uppercase text-2xl sm:text-3xl tracking-tight mb-8">FAQ</h2>
        <div className="space-y-3">
          <FaqItem q="How do I get my referral link?">
            Open a SwisDex account, head to the Dashboard → Referrals tab, and your unique link is ready to copy
            and share. You can also generate QR codes and tracked landing pages from the same screen.
          </FaqItem>
          <FaqItem q="When do I get paid?">
            The moment your referred friend completes their 3rd trade after activation, the bounty for that
            referral is paid instantly to your SwisDex wallet. You can withdraw it immediately or use it as
            trading equity.
          </FaqItem>
          <FaqItem q="What counts as an active referral for the tier ladder?">
            Any referral that has cleared both T&amp;C conditions (activated account + minimum 3 trades).
            Once you have 21+ active referrals, every subsequent referral pays $7 instead of $5. At 100+
            actives, the per-referral payout jumps to $10.
          </FaqItem>
          <FaqItem q="What's the difference between Referral and IB?">
            Referral pays a one-time bounty per qualifying friend. IB (Introducing Broker) pays a recurring
            per-lot commission on every trade your network places, for life. You can run both side-by-side.
          </FaqItem>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-[1200px] px-[var(--gutter)] pb-20">
        <div className="liquid-glass-strong rounded-3xl p-8 sm:p-12 text-center">
          <h2 className="font-display uppercase text-2xl sm:text-3xl tracking-tight">Start Earning From Day One</h2>
          <p className="mt-4 text-foreground/70 max-w-xl mx-auto text-sm sm:text-base">
            Open a SwisDex account, grab your referral link, and share it with one friend today.
            Their first $5 bounty could land in your wallet by the end of the week.
          </p>
          <Link href={SIGNUP_HREF} className="mt-7 inline-flex items-center gap-2 rounded-full bg-primary text-white px-6 py-3 text-sm font-semibold uppercase tracking-wider hover:opacity-90">
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
