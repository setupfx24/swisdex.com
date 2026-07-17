'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import toast from 'react-hot-toast';
import {
  Loader2, Users, DollarSign, Copy as CopyIcon, ArrowUpRight, Gift,
  CheckCircle2, Wallet,
} from 'lucide-react';
import DashboardShell from '@/components/layout/DashboardShell';
import api from '@/lib/api/client';

interface ReferralDashboard {
  referral_code: string | null;
  referrals: number;
  qualified_referrals?: number;
  pending_referrals?: number;
  total_earned: number;
  required_trades?: number;
  // AI-Powered-Staking referral payout mode + admin-set percentages.
  fr_referral_mode?: 'principal' | 'interest';
  fr_referral_principal_pct?: number;
  fr_referral_interest_pct?: number;
  // The user's EFFECTIVE rate (custom override if admin set one, else global).
  fr_referral_principal_pct_effective?: number;
  fr_referral_interest_pct_effective?: number;
  // Promotional EXTRA income — the premium paid above the standard rate via a
  // custom per-user offer.
  extra_income?: number;
  extra_income_ledger?: { amount: number; note: string; created_at: string | null }[];
  // Per-entry commission breakdown — direct bounty vs AI-Powered-Staking, each
  // attributed to the referred user by name.
  commission_ledger?: CommissionLedgerEntry[];
}

interface CommissionLedgerEntry {
  amount: number;
  description: string;
  source: 'staking' | 'referral';
  created_at: string | null;
}

interface ReferralRow {
  user_id: string;
  name: string | null;
  email: string;
  trades: number;
  status: 'pending' | 'claimable' | 'claimed';
  // Human-readable reason from the server when status === 'pending'.
  // Doesn't leak the friend's raw KYC state — generic phrases only.
  pending_reason: string | null;
  qualified_at: string | null;
  claimed_at: string | null;
}

interface ReferralListResponse {
  items: ReferralRow[];
  commission_balance: number;
  next_bounty: number;
  required_trades: number;
  requires_kyc: boolean;
  requires_funded: boolean;
}

function fmt(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function getOrigin() {
  if (typeof window === 'undefined') return 'https://swisdex.com';
  return window.location.origin;
}

const STATUS_BADGE: Record<ReferralRow['status'], { label: string; bg: string; fg: string }> = {
  pending:   { label: 'PENDING',   bg: '#f5a52422', fg: '#f5a524' },
  claimable: { label: 'CLAIMABLE', bg: '#55a63022', fg: '#55a630' },
  claimed:   { label: 'CLAIMED',   bg: '#2e2e2e',   fg: '#9ca3af' },
};

export default function ReferralPage() {
  const [head, setHead] = useState<ReferralDashboard | null>(null);
  const [list, setList] = useState<ReferralListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);

  const load = useCallback(async () => {
    const [h, l] = await Promise.all([
      api.get<ReferralDashboard>('/business/referral/me').catch(() => null),
      api.get<ReferralListResponse>('/business/referral/list').catch(() => null),
    ]);
    if (h) setHead(h);
    if (l) setList(l);
  }, []);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  const handleClaim = async (row: ReferralRow) => {
    setClaimingId(row.user_id);
    try {
      const res = await api.post<{ amount: number }>(`/business/referral/claim/${row.user_id}`, {});
      toast.success(`Claimed $${fmt(Number(res.amount))} from ${row.name || row.email}`);
      await load();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Could not claim';
      toast.error(msg);
    } finally {
      setClaimingId(null);
    }
  };

  const handleWithdraw = async () => {
    setWithdrawing(true);
    try {
      const res = await api.post<{ amount: number }>(`/business/referral/withdraw`, {});
      toast.success(`$${fmt(Number(res.amount))} added to your main wallet`);
      await load();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Could not withdraw';
      toast.error(msg);
    } finally {
      setWithdrawing(false);
    }
  };

  if (loading) {
    return (
      <DashboardShell>
        <div className="flex justify-center py-16">
          <Loader2 className="animate-spin text-accent" size={24} />
        </div>
      </DashboardShell>
    );
  }

  const link = head?.referral_code
    ? `${getOrigin()}/auth/register?ref=${head.referral_code}`
    : '';
  const balance = list?.commission_balance ?? 0;
  const nextBounty = list?.next_bounty ?? 0;
  const rows = list?.items ?? [];
  const claimableRows = rows.filter((r) => r.status === 'claimable');

  return (
    <DashboardShell>
      <div className="px-4 sm:px-6 py-6 space-y-6 max-w-[1100px] mx-auto">
        <header>
          <h1 className="text-2xl font-bold text-text-primary flex items-center gap-2">
            <Gift size={22} className="text-accent" /> Referral
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            Invite friends. They qualify after completing{' '}
            <strong className="text-text-primary">{list?.required_trades ?? 3}</strong>{' '}
            closed trades{list?.requires_kyc ? ' and approved KYC' : ''}. Claim each
            qualified referral to add their bounty to your commission balance, then
            withdraw to your main wallet. For multi-level commissions see{' '}
            <Link href="/business" className="text-accent hover:underline">Affiliates (IB)</Link>.
          </p>
        </header>

        {/* Stats */}
        <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard icon={<Users size={12} />} label="Total referrals" value={String(head?.referrals ?? 0)} tone="text-accent" />
          <StatCard
            icon={<Gift size={12} />}
            label="Claimable"
            value={String(claimableRows.length)}
            tone="text-buy"
            sub={claimableRows.length > 0 ? `next $${fmt(nextBounty)}` : 'none yet'}
          />
          <StatCard
            icon={<Wallet size={12} />}
            label="Commission balance"
            value={`$${fmt(balance)}`}
            tone="text-buy"
            sub="ready to withdraw"
          />
          <StatCard
            icon={<DollarSign size={12} />}
            label="Total earned"
            value={`$${fmt(head?.total_earned ?? 0)}`}
            tone="text-buy"
          />
          {(head?.extra_income ?? 0) > 0 && (
            <StatCard
              icon={<Gift size={12} />}
              label="Extra income"
              value={`$${fmt(head?.extra_income ?? 0)}`}
              tone="text-buy"
              sub="bonus rate offered to you"
            />
          )}
        </section>

        {/* Withdraw bar — only when there's something to move */}
        {balance > 0 && (
          <section className="rounded-xl border border-buy/40 bg-buy/[0.06] p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-wider text-text-tertiary">Available commission</p>
              <p className="text-2xl font-bold text-buy font-mono tabular-nums">${fmt(balance)}</p>
              <p className="text-[11px] text-text-tertiary mt-0.5">
                Withdrawing moves the amount into your main wallet — appears in Transactions and a notification fires.
              </p>
            </div>
            <button
              type="button"
              onClick={handleWithdraw}
              disabled={withdrawing}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-buy hover:bg-buy/90 text-black font-semibold text-sm disabled:opacity-60 disabled:cursor-wait transition-colors"
            >
              {withdrawing ? <Loader2 size={14} className="animate-spin" /> : <Wallet size={14} />}
              Withdraw to Main Wallet
            </button>
          </section>
        )}

        {/* Link */}
        {head?.referral_code ? (
          <section className="rounded-xl border border-border-primary bg-card p-5 space-y-3">
            <div>
              <p className="text-xs text-text-tertiary mb-2">Your referral link</p>
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={link}
                  className="flex-1 text-xs font-mono bg-bg-secondary border border-border-primary rounded-md px-3 py-2 text-text-primary min-w-0"
                />
                <button
                  type="button"
                  onClick={() => { navigator.clipboard.writeText(link); toast.success('Copied'); }}
                  className="shrink-0 inline-flex items-center justify-center gap-1 px-3 py-2 text-xs font-semibold rounded-md border border-accent text-accent hover:bg-accent hover:text-white transition-colors"
                >
                  <CopyIcon size={12} /> Copy link
                </button>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-text-tertiary">
              <span>
                Code:{' '}
                <code className="font-mono text-text-secondary bg-bg-secondary px-1.5 py-0.5 rounded">
                  {head.referral_code}
                </code>
              </span>
              <Link href="/business" className="inline-flex items-center gap-1 text-accent hover:underline">
                IB / Affiliates dashboard <ArrowUpRight size={11} />
              </Link>
            </div>
          </section>
        ) : (
          <section className="rounded-xl border border-border-primary bg-card p-6 text-center text-sm text-text-secondary">
            Your referral code is being generated. Refresh the page in a moment.
          </section>
        )}

        {/* Commission breakdown — where each chunk came from + which friend */}
        {(head?.commission_ledger?.length ?? 0) > 0 && (
          <section className="rounded-xl border border-border-primary bg-card p-5 space-y-3">
            <div>
              <p className="text-sm font-semibold text-text-primary">Commission breakdown</p>
              <p className="text-[11px] text-text-tertiary mt-0.5">
                Where each commission came from — direct referral bounty vs AI-POWERED STAKING PROGRAM — and from which friend.
              </p>
            </div>
            <div className="divide-y divide-border-primary/60 -mt-1">
              {head!.commission_ledger!.map((e, i) => (
                <div key={i} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={`shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide ${
                          e.source === 'staking' ? 'bg-accent/15 text-accent' : 'bg-buy/15 text-buy'
                        }`}
                      >
                        {e.source === 'staking' ? 'Staking' : 'Referral'}
                      </span>
                      <span className="text-xs text-text-secondary truncate">{e.description}</span>
                    </div>
                    {e.created_at && (
                      <span className="text-[10px] text-text-tertiary">
                        {new Date(e.created_at).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                  <span className="shrink-0 font-mono tabular-nums text-buy font-semibold">
                    +${fmt(e.amount)}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* AI-Powered-Staking referral payout mode (client 2026-06-30) */}
        {head?.referral_code && (
          <section className="rounded-xl border border-border-primary bg-card p-5 space-y-3">
            <div>
              <p className="text-sm font-semibold text-text-primary">AI-POWERED STAKING PROGRAM — referral payout</p>
              <p className="text-[11px] text-text-tertiary mt-0.5">
                When someone you referred locks into AI-POWERED STAKING PROGRAM, choose how your commission is paid.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {([
                { mode: 'principal' as const, label: 'On principal', pct: head.fr_referral_principal_pct_effective ?? head.fr_referral_principal_pct ?? 0, desc: 'Paid once when they lock — % of their principal.' },
                { mode: 'interest' as const, label: 'On interest', pct: head.fr_referral_interest_pct_effective ?? head.fr_referral_interest_pct ?? 0, desc: 'Paid on every interest payout — % of each payout.' },
              ]).map((opt) => {
                const active = (head.fr_referral_mode ?? 'principal') === opt.mode;
                return (
                  <button
                    key={opt.mode}
                    type="button"
                    onClick={async () => {
                      try {
                        await api.put('/business/referral/fr-mode', { mode: opt.mode });
                        setHead((h) => (h ? { ...h, fr_referral_mode: opt.mode } : h));
                        toast.success('Payout mode saved');
                      } catch (e: any) { toast.error(e?.message || 'Failed to save'); }
                    }}
                    className={`text-left rounded-lg border p-3 transition-colors ${active ? 'border-accent bg-accent/10' : 'border-border-primary hover:bg-bg-hover/30'}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-text-primary">{opt.label}</span>
                      <span className="text-xs font-mono text-accent">{opt.pct}%</span>
                    </div>
                    <p className="text-[10px] text-text-tertiary mt-1">{opt.desc}</p>
                    {active && <span className="inline-block mt-1.5 text-[10px] text-accent">✓ Selected</span>}
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-text-tertiary">Commission lands in your referral balance above — withdraw it from here.</p>
          </section>
        )}

        {/* Per-friend list */}
        <section className="rounded-xl border border-border-primary bg-card p-4 md:p-5 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="text-base font-bold text-text-primary">Your friends</h2>
            <p className="text-[11px] text-text-tertiary">
              Eligible after {list?.required_trades ?? 3} trades
              {list?.requires_kyc ? ' + KYC' : ''}
              {list?.requires_funded ? ' + first deposit' : ''}
            </p>
          </div>
          {rows.length === 0 ? (
            <p className="text-sm text-text-secondary text-center py-8">
              You haven&apos;t referred anyone yet. Share your link to get started.
            </p>
          ) : (
            <div className="overflow-x-auto -mx-4 sm:-mx-5">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  {/* KYC column intentionally omitted — exposing a
                      referred friend's KYC state to the referrer is a
                      privacy leak the friend never consented to. Bounty
                      eligibility still enforces KYC server-side. */}
                  <tr className="text-left text-[10px] uppercase tracking-wider text-text-tertiary border-b border-border-primary">
                    <th className="px-4 sm:px-5 py-2">Friend</th>
                    <th className="px-3 py-2 text-right">Trades</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2 sm:pr-5 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const badge = STATUS_BADGE[r.status];
                    const tradesNeeded = list?.required_trades ?? 3;
                    return (
                      <tr key={r.user_id} className="border-b border-border-primary/50 last:border-b-0">
                        <td className="px-4 sm:px-5 py-2.5">
                          <p className="font-semibold text-text-primary truncate max-w-[200px]">
                            {r.name || '—'}
                          </p>
                          <p className="text-[11px] text-text-tertiary truncate max-w-[200px]">{r.email}</p>
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                          <span className={r.trades >= tradesNeeded ? 'text-buy font-semibold' : 'text-text-primary'}>
                            {r.trades}
                          </span>
                          <span className="text-text-tertiary"> / {tradesNeeded}</span>
                        </td>
                        <td className="px-3 py-2.5">
                          <span
                            className="text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full inline-flex items-center gap-1"
                            style={{ color: badge.fg, background: badge.bg, border: `1px solid ${badge.fg}55` }}
                          >
                            {r.status === 'claimed' && <CheckCircle2 size={10} />}
                            {badge.label}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 sm:pr-5 text-right">
                          {r.status === 'claimable' ? (
                            <button
                              type="button"
                              onClick={() => handleClaim(r)}
                              disabled={claimingId === r.user_id}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-buy/15 hover:bg-buy/25 text-buy border border-buy/40 text-xs font-semibold disabled:opacity-60 disabled:cursor-wait transition-colors"
                            >
                              {claimingId === r.user_id ? (
                                <Loader2 size={12} className="animate-spin" />
                              ) : (
                                <Wallet size={12} />
                              )}
                              Claim
                            </button>
                          ) : r.status === 'claimed' ? (
                            <span className="text-[11px] text-text-tertiary">paid</span>
                          ) : (
                            // Pending — server tells us which gate is
                            // blocking the row (KYC not done, no first
                            // deposit, N trades to go, etc.).
                            <span className="text-[11px] text-text-tertiary text-right inline-block max-w-[180px]">
                              {r.pending_reason
                                || `${Math.max(0, tradesNeeded - r.trades)} trade${tradesNeeded - r.trades === 1 ? '' : 's'} to go`}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </DashboardShell>
  );
}

function StatCard({
  icon, label, value, tone, sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-border-primary bg-card p-4">
      <div className="flex items-center gap-2 text-xs text-text-tertiary uppercase">
        {icon} {label}
      </div>
      <p className={`text-xl font-bold font-mono tabular-nums mt-1 ${tone}`}>{value}</p>
      {sub && <p className="text-[10px] text-text-tertiary mt-0.5">{sub}</p>}
    </div>
  );
}
