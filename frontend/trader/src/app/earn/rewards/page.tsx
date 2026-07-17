'use client';

/**
 * Earn → Rewards (client 2026-07-11): admin-run referral staking offers.
 * Bring NEW referred users who lock AI Powered Staking during the offer
 * window; earn a tiered % of the volume they lock. Claim opens after the
 * offer ends and credits the main wallet.
 */
import { useCallback, useEffect, useState } from 'react';
import { Clock, Gift, Loader2, Trophy, Users } from 'lucide-react';
import toast from 'react-hot-toast';
import DashboardShell from '@/components/layout/DashboardShell';
import api from '@/lib/api/client';

// A tier pays EITHER reward_pct (% of the whole volume) OR reward_amount
// (flat USD) — exactly one is set (client 2026-07-13).
type Tier = { min_amount: number; max_amount: number | null; reward_pct: number | null; reward_amount: number | null };
type Campaign = {
  id: string;
  title: string;
  description: string | null;
  starts_at: string;
  ends_at: string;
  status: 'upcoming' | 'running' | 'ended';
  tiers: Tier[];
  my_staked_total: number;
  current_pct: number;
  current_reward_amount: number | null;
  projected_reward: number;
  claimable: boolean;
  claimed: boolean;
  claimed_amount: number | null;
};

const fmtUsd = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(n);

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });

function tierLabel(t: Tier) {
  return t.max_amount != null
    ? `${fmtUsd(t.min_amount)} – ${fmtUsd(t.max_amount)}`
    : `${fmtUsd(t.min_amount)}+`;
}

function tierReward(t: Tier) {
  return t.reward_amount != null ? `${fmtUsd(t.reward_amount)} flat` : `${t.reward_pct}% of volume`;
}

function inTier(t: Tier, total: number) {
  return total >= t.min_amount && (t.max_amount == null || total < t.max_amount);
}

export default function EarnRewardsPage() {
  return (
    <DashboardShell>
      <Inner />
    </DashboardShell>
  );
}

function Inner() {
  const [items, setItems] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<Campaign[]>('/rewards/campaigns');
      setItems(Array.isArray(r) ? r : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load offers');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const claim = async (c: Campaign) => {
    setClaiming(c.id);
    try {
      const r = await api.post<{ reward_amount: number }>(`/rewards/campaigns/${c.id}/claim`, {});
      toast.success(`${fmtUsd(r.reward_amount)} credited to your wallet! 🎉`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Claim failed');
    } finally {
      setClaiming(null);
    }
  };

  return (
    <div className="px-4 sm:px-6 py-6 space-y-5 max-w-[1000px] mx-auto">
      <header>
        <h1 className="text-2xl font-bold text-text-primary flex items-center gap-2">
          <Gift className="text-[#55a630]" size={24} /> Rewards
        </h1>
        <p className="mt-1 text-sm text-text-secondary max-w-2xl">
          Limited-time offers: invite new users with your referral link — when they join and lock{' '}
          <strong className="text-text-primary">AI Powered Staking</strong> during the offer period,
          you earn a percentage of everything they stake. Claim your reward to your wallet once the
          offer ends.
        </p>
      </header>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="animate-spin text-text-tertiary" /></div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-border-primary bg-bg-secondary p-10 text-center">
          <Trophy size={32} className="mx-auto text-text-tertiary mb-3" />
          <p className="text-sm text-text-secondary">No reward offers are running right now.</p>
          <p className="text-xs text-text-tertiary mt-1">Check back soon — new offers appear here.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {items.map((c) => {
            const nextTier = c.tiers.find((t) => c.my_staked_total < t.min_amount);
            const maxTierMin = c.tiers.length ? Math.max(...c.tiers.map((t) => t.min_amount)) : 0;
            const barTarget = nextTier ? nextTier.min_amount : Math.max(maxTierMin, c.my_staked_total) || 1;
            const barPct = Math.max(0, Math.min(100, (c.my_staked_total / barTarget) * 100));
            return (
              <div key={c.id} className="rounded-2xl border border-border-primary bg-bg-secondary p-5 space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-base font-bold text-text-primary">{c.title}</h2>
                      <span className={
                        'text-[10px] px-2 py-0.5 rounded-md font-bold uppercase ' +
                        (c.status === 'running' ? 'bg-[#55a630]/15 text-[#55a630]'
                          : c.status === 'upcoming' ? 'bg-amber-500/15 text-amber-400'
                          : 'bg-bg-hover text-text-tertiary')
                      }>
                        {c.status}
                      </span>
                    </div>
                    {c.description ? <p className="text-xs text-text-secondary mt-1">{c.description}</p> : null}
                    <p className="text-[11px] text-text-tertiary mt-1 flex items-center gap-1">
                      <Clock size={11} /> {fmtDate(c.starts_at)} → {fmtDate(c.ends_at)}
                    </p>
                  </div>
                  {c.claimed ? (
                    <span className="shrink-0 text-xs font-bold text-[#55a630] border border-[#55a630]/40 rounded-lg px-3 py-1.5">
                      Claimed {c.claimed_amount != null ? fmtUsd(c.claimed_amount) : ''} ✓
                    </span>
                  ) : c.claimable ? (
                    <button
                      type="button"
                      disabled={claiming === c.id}
                      onClick={() => void claim(c)}
                      className="shrink-0 px-4 py-2 rounded-xl bg-[#55a630] text-white text-sm font-bold hover:bg-[#3f7d22] disabled:opacity-50"
                    >
                      {claiming === c.id ? 'Claiming…' : `Claim ${fmtUsd(c.projected_reward)}`}
                    </button>
                  ) : null}
                </div>

                {/* Tier table */}
                <div className="rounded-xl border border-border-primary/60 overflow-hidden">
                  <table className="w-full text-left">
                    <thead className="bg-bg-tertiary/40">
                      <tr className="text-[10px] uppercase text-text-tertiary">
                        <th className="px-3 py-1.5">Referred staking volume</th>
                        <th className="px-3 py-1.5 text-right">Your reward</th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.tiers.map((t, i) => {
                        const active = inTier(t, c.my_staked_total);
                        return (
                          <tr key={i} className={'border-t border-border-primary/40 text-xs ' + (active ? 'bg-[#55a630]/8' : '')}>
                            <td className="px-3 py-1.5 font-mono text-text-primary">
                              {tierLabel(t)}
                              {active && <span className="ml-2 text-[9px] font-bold text-[#55a630] uppercase">← you are here</span>}
                            </td>
                            <td className="px-3 py-1.5 text-right font-bold text-[#55a630]">{tierReward(t)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* My progress */}
                <div>
                  <div className="flex items-center justify-between text-xs mb-1.5">
                    <span className="text-text-secondary flex items-center gap-1">
                      <Users size={12} /> Your referrals&apos; staking this offer
                    </span>
                    <span className="font-bold font-mono text-text-primary">{fmtUsd(c.my_staked_total)}</span>
                  </div>
                  <div className="h-2 rounded-full bg-bg-hover overflow-hidden">
                    <div className="h-full rounded-full bg-[#55a630] transition-all" style={{ width: `${barPct}%` }} />
                  </div>
                  <div className="flex items-center justify-between text-[11px] mt-1.5">
                    <span className="text-text-tertiary">
                      {nextTier
                        ? `${fmtUsd(nextTier.min_amount - c.my_staked_total)} more to reach ${nextTier.reward_amount != null ? fmtUsd(nextTier.reward_amount) : `${nextTier.reward_pct}%`}`
                        : c.projected_reward > 0 ? 'Top tier reached 🎉' : ''}
                    </span>
                    <span className={c.projected_reward > 0 ? 'font-bold text-[#55a630]' : 'text-text-tertiary'}>
                      {c.projected_reward > 0
                        ? `Projected reward: ${fmtUsd(c.projected_reward)}${c.current_reward_amount == null && c.current_pct > 0 ? ` (${c.current_pct}%)` : ''}`
                        : c.tiers.length ? `Reach ${fmtUsd(c.tiers[0].min_amount)} to start earning` : ''}
                    </span>
                  </div>
                  {c.status === 'running' && c.projected_reward > 0 && !c.claimed && (
                    <p className="text-[11px] text-amber-400/90 mt-2">
                      Claim unlocks when the offer ends on {fmtDate(c.ends_at)} — keep referring to reach a higher tier!
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
