'use client';

/**
 * Account & Data Deletion — public page.
 *
 * Required by Google Play (Data safety → "Account deletion" URL) and Apple.
 * Must be reachable WITHOUT login, so it lives under (landing). Explains how
 * a user requests deletion, what is erased, and what we are legally required
 * to retain (financial/AML records). Linked from the Play Console listing.
 */
import Link from 'next/link';
import { Trash2, Mail, ShieldCheck, Clock, ArrowUpRight } from 'lucide-react';
import { BannerPlaceholder } from '@/swisdex/components/BannerPlaceholder';

const SUPPORT_EMAIL = 'support@swisdex.com';
const SUBJECT = 'Account Deletion Request';

export default function DeleteAccountPage() {
  const mailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(SUBJECT)}&body=${encodeURIComponent(
    'I would like to permanently delete my SwisDex account and associated data.\n\nRegistered email: \nRegistered phone (if any): \nReason (optional): ',
  )}`;

  return (
    <main className="min-h-screen bg-background">
      <BannerPlaceholder
        title="Delete Your Account"
        tagline="Request permanent deletion of your SwisDex account and personal data. This page explains how, what is removed, and what we are required to keep."
      />

      <section className="mx-auto max-w-[820px] px-[var(--gutter)] py-12 sm:py-16 space-y-10">
        {/* How to request */}
        <div>
          <h2 className="flex items-center gap-2 font-display uppercase text-xl sm:text-2xl tracking-tight">
            <Trash2 className="size-5 text-primary" /> How to request deletion
          </h2>
          <p className="mt-3 text-foreground/70 text-sm sm:text-base leading-relaxed">
            You can request deletion of your SwisDex account and associated personal data in either of these ways:
          </p>
          <ol className="mt-4 space-y-3 text-sm sm:text-base text-foreground/80">
            <li className="flex gap-3">
              <span className="shrink-0 w-6 h-6 rounded-full bg-primary/20 text-primary text-xs font-bold flex items-center justify-center">1</span>
              <span>
                <span className="font-semibold text-foreground">In the app / website:</span> Go to{' '}
                <span className="font-medium">Settings → Account → Delete account</span> and follow the prompts, or contact 24/7 support from the help menu.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="shrink-0 w-6 h-6 rounded-full bg-primary/20 text-primary text-xs font-bold flex items-center justify-center">2</span>
              <span>
                <span className="font-semibold text-foreground">By email:</span> Send a deletion request from your registered email address to{' '}
                <a href={mailto} className="text-primary hover:underline font-medium">{SUPPORT_EMAIL}</a>{' '}
                with the subject &quot;{SUBJECT}&quot;.
              </span>
            </li>
          </ol>

          <a
            href={mailto}
            className="mt-6 inline-flex items-center gap-2 rounded-full bg-primary text-white px-6 py-3 text-sm font-semibold uppercase tracking-wider hover:opacity-90"
          >
            <Mail className="size-4" /> Request account deletion
          </a>
        </div>

        {/* What gets deleted */}
        <div>
          <h2 className="flex items-center gap-2 font-display uppercase text-xl sm:text-2xl tracking-tight">
            <ShieldCheck className="size-5 text-primary" /> What is deleted
          </h2>
          <p className="mt-3 text-foreground/70 text-sm sm:text-base leading-relaxed">
            Once your request is verified and any open positions / pending balances are settled, we permanently remove:
          </p>
          <ul className="mt-4 grid sm:grid-cols-2 gap-2 text-sm text-foreground/80">
            {[
              'Profile & contact details (name, email, phone, address)',
              'KYC documents & verification images',
              'Login credentials & active sessions',
              'Trading accounts & preferences',
              'Watchlists, settings, and app data',
              'Marketing / communication preferences',
            ].map((x) => (
              <li key={x} className="flex items-start gap-2">
                <span className="mt-1.5 size-1.5 rounded-full bg-primary shrink-0" />
                <span>{x}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* What we retain */}
        <div>
          <h2 className="flex items-center gap-2 font-display uppercase text-xl sm:text-2xl tracking-tight">
            <Clock className="size-5 text-[#e8b923]" /> What we must retain (and for how long)
          </h2>
          <p className="mt-3 text-foreground/70 text-sm sm:text-base leading-relaxed">
            As a financial services provider, we are legally required (anti-money-laundering, tax, and audit
            regulations) to retain certain records even after account deletion. These are kept only as long as the
            law requires, stored securely, and are not used for any other purpose:
          </p>
          <ul className="mt-4 space-y-2 text-sm text-foreground/80">
            {[
              'Transaction, deposit & withdrawal records (financial/AML compliance) — typically up to 5–7 years.',
              'Identity-verification records required by KYC/AML law for the mandated retention period.',
              'Records needed to resolve disputes, prevent fraud, or comply with a legal/regulatory order.',
            ].map((x) => (
              <li key={x} className="flex items-start gap-2">
                <span className="mt-1.5 size-1.5 rounded-full bg-[#e8b923] shrink-0" />
                <span>{x}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-foreground/45 leading-relaxed">
            After the mandated retention period expires, this residual data is permanently deleted as well.
          </p>
        </div>

        {/* Timeline + conditions */}
        <div>
          <h2 className="font-display uppercase text-xl sm:text-2xl tracking-tight">Timeline &amp; conditions</h2>
          <ul className="mt-4 space-y-2 text-sm text-foreground/80">
            <li className="flex items-start gap-2"><span className="mt-1.5 size-1.5 rounded-full bg-primary shrink-0" /><span>Requests are verified against your registered identity to protect your account from fraudulent deletion.</span></li>
            <li className="flex items-start gap-2"><span className="mt-1.5 size-1.5 rounded-full bg-primary shrink-0" /><span>Before deletion, please <span className="font-medium text-foreground">withdraw any remaining balance</span> and close all open positions. We will contact you if action is needed.</span></li>
            <li className="flex items-start gap-2"><span className="mt-1.5 size-1.5 rounded-full bg-primary shrink-0" /><span>Deletion is normally completed within <span className="font-medium text-foreground">30 days</span> of a verified request.</span></li>
            <li className="flex items-start gap-2"><span className="mt-1.5 size-1.5 rounded-full bg-primary shrink-0" /><span>Account deletion is permanent and cannot be undone.</span></li>
          </ul>
        </div>

        {/* Contact */}
        <div className="liquid-glass-strong rounded-2xl p-6 sm:p-8 text-center">
          <h2 className="font-display uppercase text-lg sm:text-xl tracking-tight">Questions about your data?</h2>
          <p className="mt-2 text-foreground/70 text-sm">
            Contact our team at{' '}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary hover:underline">{SUPPORT_EMAIL}</a>
            {' '}or see our{' '}
            <Link href="/privacy" className="text-primary hover:underline">Privacy Policy</Link>.
          </p>
          <a
            href={mailto}
            className="mt-5 inline-flex items-center gap-2 rounded-full liquid-glass px-5 py-2.5 text-sm font-semibold uppercase tracking-wider hover:bg-foreground/10"
          >
            Email us <ArrowUpRight className="size-4" />
          </a>
        </div>
      </section>
    </main>
  );
}
