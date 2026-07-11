'use client';

import { useCallback, useEffect, useState } from 'react';
import DashboardShell from '@/components/layout/DashboardShell';
import { ShieldCheck, Loader2, HelpCircle, Wallet, CheckCircle2 } from 'lucide-react';
import { insuranceApi, type PolicyOut, type ClaimOut } from '@/lib/api/insurance';
import InsuranceOnboardingModal from '@/components/insurance/InsuranceOnboardingModal';
import toast from 'react-hot-toast';

const STATUS_COLOR: Record<PolicyOut['status'], string> = {
  active: '#55a630',
  claimed: '#22c55e',
  expired: '#888888',
  denied: '#ef4444',
};

// Tier labels are now admin-defined free-form strings (e.g. "50%", "70%").
// Render verbatim; only capitalise the legacy lowercase enum values for
// backwards compat with rows created before the 2026-05-25 cleanup.
function formatTier(t: string | null | undefined): string {
  if (!t) return '—';
  const lower = t.toLowerCase();
  if (lower === 'basic' || lower === 'advanced' || lower === 'pro' || lower === 'elite') {
    return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  }
  return t;
}

// Maps the technical reason code from the claims engine to a short
// trader-friendly explanation. Anything we don't recognise falls
// through to a generic fallback so we never render a raw code.
function formatReason(code: string | null | undefined): string | null {
  if (!code) return null;
  switch (code) {
    case 'not_a_loss':           return 'Your trade closed in profit, so there was nothing to claim — insurance only covers a loss.';
    case 'min_duration':         return 'The trade was closed too soon after opening. An insured trade must stay open for a minimum time before it can be claimed.';
    case 'hedge':                return 'You had an opposite (hedge) trade open on the same instrument, so this was not a real loss — no payout.';
    case 'cooldown':             return 'You claimed insurance recently. There is a short wait between claims — you can claim again once the cooldown period ends.';
    case 'daily_claim_limit':    return 'You have used all your insurance claims for today. Please try again tomorrow.';
    case 'daily_payout_limit':   return "Today's maximum insurance payout has already been reached. Please try again tomorrow.";
    case 'vol_too_low':          return 'The market was too calm (very low movement) when the trade closed — claims are not available in these conditions.';
    case 'vol_too_high':         return 'The market was moving too fast (extreme volatility) when the trade closed — claims are paused in these conditions.';
    case 'news_blackout':        return 'Claims were paused during a major market news event when this trade closed.';
    case 'insurance_disabled':   return 'Insurance was switched off at the time this trade closed.';
    case 'policy_expired':       return 'The trade stayed open past the insurance cover window, so the cover had already expired before it closed.';
    case 'cap_exhausted':        return 'The coverage limit for this trade was already fully paid out on earlier partial closes.';
    case 'zero_payout':          return 'The covered part of the loss worked out to zero, so there was no payout.';
    default:                     return code.replace(/_/g, ' ');
  }
}

export default function InsurancePage() {
  const [policies, setPolicies] = useState<PolicyOut[] | null>(null);
  const [claims, setClaims] = useState<ClaimOut[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [claimingId, setClaimingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [p, c] = await Promise.all([
      insuranceApi.policies(100),
      insuranceApi.claims(100),
    ]);
    setPolicies(p);
    setClaims(c);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await load();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [load]);

  const handleClaim = async (claimId: string, amount: string) => {
    setClaimingId(claimId);
    try {
      const res = await insuranceApi.claimPayout(claimId);
      const dest = res.credited_to === 'credit' ? 'trading credit (tradable)' : 'main balance';
      toast.success(`$${Number(amount).toFixed(2)} credited to your ${dest}.`);
      await load();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Could not claim payout. Try again.';
      toast.error(msg);
    } finally {
      setClaimingId(null);
    }
  };

  const pendingClaims = (claims || []).filter((c) => c.status === 'pending');
  const paidClaims = (claims || []).filter((c) => c.status === 'paid');

  // Stat totals for the summary strip.
  const totalClaimableAmount = pendingClaims.reduce(
    (s, c) => s + Number(c.claim_amount || 0), 0,
  );
  const totalClaimedAmount = paidClaims.reduce(
    (s, c) => s + Number(c.claim_amount || 0), 0,
  );

  return (
    <DashboardShell>
      <InsuranceOnboardingModal />
      <div className="space-y-5 pb-8">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <h1 className="text-2xl font-bold text-text-primary tracking-tight flex items-center gap-2">
            <ShieldCheck size={22} className="text-[#55a630]" /> Trade Insurance
          </h1>
          <button
            type="button"
            onClick={() => {
              try { localStorage.removeItem('fx-insurance-onboarded'); } catch { /* private mode */ }
              window.location.reload();
            }}
            className="text-xs text-text-tertiary hover:text-text-primary inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border-primary hover:border-[#55a630]/40"
          >
            <HelpCircle size={13} /> How it works
          </button>
        </div>
        <p className="text-sm text-text-secondary -mt-1">
          Per-trade protection. Pay a small fee to recover part of any loss on insured trades.
        </p>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-text-secondary py-10 justify-center">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        ) : (
          <>
            {/* Summary strip — three stat cards. Total Claimed is the
                lifetime sum of claim payouts already swept into the
                user's trading credit (tradable, not withdrawable). */}
            <section className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <Stat
                label="Claimable"
                value={`$${totalClaimableAmount.toFixed(2)}`}
                sub={pendingClaims.length > 0 ? `${pendingClaims.length} payout${pendingClaims.length === 1 ? '' : 's'} waiting` : 'none yet'}
                tone={pendingClaims.length > 0 ? 'text-[#55a630]' : 'text-text-secondary'}
              />
              <Stat
                label="Total Claimed"
                value={`$${totalClaimedAmount.toFixed(2)}`}
                sub={paidClaims.length > 0 ? `across ${paidClaims.length} payout${paidClaims.length === 1 ? '' : 's'}` : 'no payouts yet'}
                tone="text-green-500"
              />
              <Stat
                label="Policies"
                value={String(policies?.length ?? 0)}
                sub={`${(policies || []).filter((p) => p.status === 'active').length} active`}
                tone="text-text-primary"
              />
            </section>
            {/* Claimable — trader presses Claim to credit account.credit */}
            <Card
              title={`Claimable${pendingClaims.length ? ` (${pendingClaims.length})` : ''}`}
              accent={pendingClaims.length > 0}
            >
              {pendingClaims.length === 0 ? (
                <Empty msg="No payouts waiting. When an insured trade closes in eligible loss, the payout appears here for you to claim." />
              ) : (
                <ul className="divide-y divide-border-primary">
                  {pendingClaims.map((c) => (
                    <li key={c.id} className="py-3 flex items-center gap-3 flex-wrap">
                      <span
                        className="text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded-full"
                        style={{
                          color: '#55a630',
                          background: '#55a6301f',
                          border: '1px solid #55a63055',
                        }}
                      >
                        pending
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-text-primary truncate">
                          {c.instrument_symbol || '—'}{' '}
                          <span className="text-text-tertiary">·</span>{' '}
                          <span className="text-[#55a630]">{formatTier(c.tier)}</span>
                        </p>
                        <p className="text-[10px] text-text-tertiary">
                          Loss ${Number(c.loss_amount).toFixed(2)}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-base font-bold text-green-500 font-mono tabular-nums">
                          ${Number(c.claim_amount).toFixed(2)}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleClaim(c.id, c.claim_amount)}
                        disabled={claimingId === c.id}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-semibold bg-[#55a630] hover:bg-[#4a9329] text-black disabled:opacity-60 disabled:cursor-wait transition-colors"
                      >
                        {claimingId === c.id ? (
                          <>
                            <Loader2 size={13} className="animate-spin" /> Claiming…
                          </>
                        ) : (
                          <>
                            <Wallet size={13} /> Claim
                          </>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {pendingClaims.length > 0 && (
                <p className="text-[11px] text-text-tertiary mt-3">
                  Claimed funds are credited to your <span className="text-text-secondary font-medium">trading credit</span> — tradable, not withdrawable.
                </p>
              )}
            </Card>

            <Card title="Policies">
              {!policies || policies.length === 0 ? (
                <Empty msg="You have no insurance policies yet. Activate insurance from the order ticket on the trading terminal." />
              ) : (
                <ul className="divide-y divide-border-primary">
                  {policies.map((p) => {
                    const reason = formatReason(p.settled_reason);
                    return (
                      <li key={p.id} className="py-3 flex items-start gap-3 flex-wrap">
                        <span
                          className="text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded-full mt-0.5"
                          style={{
                            color: STATUS_COLOR[p.status],
                            background: `${STATUS_COLOR[p.status]}1f`,
                            border: `1px solid ${STATUS_COLOR[p.status]}55`,
                          }}
                        >
                          {p.status}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-text-primary truncate">
                            {p.instrument_symbol || '—'}{' '}
                            <span className="text-text-tertiary">·</span>{' '}
                            <span className="text-[#55a630]">{formatTier(p.tier)}</span>
                          </p>
                          {reason && (p.status === 'denied' || p.status === 'expired') && (
                            <p className="text-[11px] text-text-tertiary mt-0.5">
                              <span className="font-medium text-text-secondary">Reason:</span> {reason}
                            </p>
                          )}
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-xs font-mono tabular-nums text-text-primary">
                            ${Number(p.fee).toFixed(2)} fee
                          </p>
                          <p className="text-[10px] text-text-tertiary">
                            {Number(p.coverage_pct).toFixed(0)}% covered · max ${Number(p.max_cap).toFixed(0)}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>

            <Card title="Claim history">
              {paidClaims.length === 0 ? (
                <Empty msg="No claims yet. When you press Claim above, the payout will appear here." />
              ) : (
                <ul className="divide-y divide-border-primary">
                  {paidClaims.map((c) => (
                    <li key={c.id} className="py-3 flex items-center gap-3">
                      <CheckCircle2 size={14} className="text-green-500 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-text-primary">
                          {c.instrument_symbol || '—'}{' '}
                          <span className="text-text-tertiary">·</span>{' '}
                          <span className="text-[#55a630]">{formatTier(c.tier)}</span>
                          <span className="text-text-tertiary"> · </span>
                          Loss ${Number(c.loss_amount).toFixed(2)} → payout{' '}
                          <span className="font-bold text-green-500">${Number(c.claim_amount).toFixed(2)}</span>
                        </p>
                        <p className="text-[10px] text-text-tertiary">
                          {c.paid_at ? new Date(c.paid_at).toLocaleString() : '—'}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </>
        )}
      </div>
    </DashboardShell>
  );
}

function Card({ title, children, accent = false }: { title: string; children: React.ReactNode; accent?: boolean }) {
  return (
    <div
      className="rounded-2xl p-4 md:p-5"
      style={{
        background: 'var(--bg-card)',
        border: accent ? '1px solid #55a63080' : '1px solid var(--border-primary)',
        boxShadow: accent ? '0 0 0 1px #55a63022 inset' : undefined,
      }}
    >
      <h2 className="text-base font-bold text-text-primary mb-3">{title}</h2>
      {children}
    </div>
  );
}

function Empty({ msg }: { msg: string }) {
  return <p className="text-sm text-text-secondary text-center py-6">{msg}</p>;
}

function Stat({
  label, value, sub, tone,
}: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div
      className="rounded-2xl p-4"
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-primary)',
      }}
    >
      <p className="text-[10px] uppercase tracking-wider text-text-tertiary">{label}</p>
      <p className={`text-xl sm:text-2xl font-bold font-mono tabular-nums mt-1 ${tone || 'text-text-primary'}`}>
        {value}
      </p>
      {sub && <p className="text-[10px] text-text-tertiary mt-0.5">{sub}</p>}
    </div>
  );
}
