'use client';

/**
 * Admin → Reward Offers (client 2026-07-11): referral staking campaigns.
 * Create a time-bound offer with tiered %-of-volume payouts; monitor
 * qualifying volume, referrer leaderboard, and claims paid.
 */
import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Gift, Loader2, Plus, Trash2, Trophy, X } from 'lucide-react';
import { adminApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import DateField from '@/components/ui/DateField';

// reward_type picks what the single value input means: percent of the whole
// qualifying volume, or a flat USD amount (client 2026-07-13).
interface Tier { min_amount: number | string; max_amount: number | string | null; reward_type: 'pct' | 'fixed'; reward_value: number | string }
interface Campaign {
  id: string; title: string; description: string | null;
  starts_at: string; ends_at: string; is_active: boolean;
  status: 'upcoming' | 'running' | 'ended';
  tiers: { min_amount: number; max_amount: number | null; reward_pct: number | null; reward_amount: number | null }[];
  stats: { qualifying_volume: number; referrers: number; claims_paid: number; claims_paid_amount: number };
}
interface LeaderRow {
  user_id: string; name: string; email: string;
  qualifying_volume: number; referred_users: number;
  claimed: boolean; claimed_amount: number | null;
}

const fmtUsd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });

export default function RewardCampaignsPage() {
  const [items, setItems] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [leaderFor, setLeaderFor] = useState<Campaign | null>(null);
  const [leaders, setLeaders] = useState<LeaderRow[] | null>(null);

  // Create form state
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [tiers, setTiers] = useState<Tier[]>([{ min_amount: 1000, max_amount: 2000, reward_type: 'pct', reward_value: 5 }]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await adminApi.get<{ items: Campaign[] }>('/reward-campaigns');
      setItems(r?.items || []);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to load');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const openLeaderboard = async (c: Campaign) => {
    setLeaderFor(c); setLeaders(null);
    try {
      const r = await adminApi.get<{ items: LeaderRow[] }>(`/reward-campaigns/${c.id}/leaderboard`);
      setLeaders(r?.items || []);
    } catch (e: any) { toast.error(e?.message || 'Failed to load leaderboard'); }
  };

  const toggleActive = async (c: Campaign) => {
    try {
      await adminApi.patch(`/reward-campaigns/${c.id}`, { is_active: !c.is_active });
      toast.success(c.is_active ? 'Offer paused' : 'Offer resumed');
      await load();
    } catch (e: any) { toast.error(e?.message || 'Failed'); }
  };

  const submit = async () => {
    if (!title.trim()) { toast.error('Title required'); return; }
    if (!startDate || !endDate) { toast.error('Start and end dates required'); return; }
    const cleanTiers = tiers
      .map((t) => {
        const value = parseFloat(String(t.reward_value)) || 0;
        return {
          min_amount: parseFloat(String(t.min_amount)) || 0,
          max_amount: t.max_amount === null || String(t.max_amount).trim() === '' ? null : parseFloat(String(t.max_amount)),
          reward_pct: t.reward_type === 'pct' && value > 0 ? value : null,
          reward_amount: t.reward_type === 'fixed' && value > 0 ? value : null,
        };
      })
      .filter((t) => (t.reward_pct ?? 0) > 0 || (t.reward_amount ?? 0) > 0);
    if (!cleanTiers.length) { toast.error('Add at least one tier with a percent or fixed amount'); return; }
    setSaving(true);
    try {
      await adminApi.post('/reward-campaigns', {
        title: title.trim(),
        description: description.trim() || null,
        starts_at: `${startDate}T00:00:00Z`,
        ends_at: `${endDate}T23:59:59Z`,
        tiers: cleanTiers,
      });
      toast.success('Offer created');
      setShowCreate(false);
      setTitle(''); setDescription(''); setStartDate(''); setEndDate('');
      setTiers([{ min_amount: 1000, max_amount: 2000, reward_type: 'pct', reward_value: 5 }]);
      await load();
    } catch (e: any) { toast.error(e?.message || 'Create failed'); }
    finally { setSaving(false); }
  };

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-5xl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Gift size={18} className="text-text-secondary" />
          <div>
            <h1 className="text-lg font-semibold text-text-primary">Reward Offers</h1>
            <p className="text-xxs text-text-tertiary mt-0.5">
              Time-bound referral staking offers: NEW referred users lock AI Powered Staking in the window →
              the referrer earns a tiered % of that volume, claimable after the offer ends.
            </p>
          </div>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-buy rounded-md hover:bg-buy-light transition-fast"
        >
          <Plus size={13} /> New Offer
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="animate-spin text-text-tertiary" /></div>
      ) : items.length === 0 ? (
        <p className="text-sm text-text-tertiary py-10 text-center">No offers yet — create the first one.</p>
      ) : (
        <div className="space-y-3">
          {items.map((c) => (
            <div key={c.id} className="rounded-lg border border-border-primary bg-bg-secondary p-4 space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-text-primary">{c.title}</span>
                    <span className={cn(
                      'text-[10px] px-2 py-0.5 rounded-md font-bold uppercase',
                      c.status === 'running' ? 'bg-success/15 text-success'
                        : c.status === 'upcoming' ? 'bg-warning/15 text-warning'
                        : 'bg-bg-hover text-text-tertiary',
                    )}>{c.status}</span>
                    {!c.is_active && <span className="text-[10px] px-2 py-0.5 rounded-md font-bold uppercase bg-danger/15 text-danger">paused</span>}
                  </div>
                  {c.description && <p className="text-xs text-text-secondary mt-0.5">{c.description}</p>}
                  <p className="text-[11px] text-text-tertiary mt-0.5">{fmtDate(c.starts_at)} → {fmtDate(c.ends_at)}</p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => void openLeaderboard(c)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xxs font-medium text-text-secondary border border-border-primary hover:bg-bg-hover"
                  >
                    <Trophy size={12} /> Leaderboard
                  </button>
                  <button
                    onClick={() => void toggleActive(c)}
                    className={cn(
                      'px-2.5 py-1.5 rounded-md text-xxs font-medium border transition-fast',
                      c.is_active
                        ? 'text-danger border-danger/40 hover:bg-danger/10'
                        : 'text-success border-success/40 hover:bg-success/10',
                    )}
                  >
                    {c.is_active ? 'Pause' : 'Resume'}
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {c.tiers.map((t, i) => (
                  <span key={i} className="text-[10px] font-mono px-2 py-1 rounded-md bg-bg-input border border-border-primary text-text-secondary">
                    {t.max_amount != null ? `${fmtUsd(t.min_amount)}–${fmtUsd(t.max_amount)}` : `${fmtUsd(t.min_amount)}+`}
                    <span className="text-buy font-bold">
                      {' '}→ {t.reward_amount != null ? `${fmtUsd(t.reward_amount)} flat` : `${t.reward_pct}%`}
                    </span>
                  </span>
                ))}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  ['Qualifying volume', fmtUsd(c.stats.qualifying_volume)],
                  ['Referrers', String(c.stats.referrers)],
                  ['Claims paid', String(c.stats.claims_paid)],
                  ['Paid out', fmtUsd(c.stats.claims_paid_amount)],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-md bg-bg-input/50 border border-border-primary/50 px-2.5 py-1.5">
                    <div className="text-[10px] text-text-tertiary">{label}</div>
                    <div className="text-xs font-bold font-mono text-text-primary">{value}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowCreate(false)} />
          <div className="relative w-full max-w-lg rounded-xl border border-border-primary bg-bg-secondary p-5 space-y-3 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-text-primary">New Reward Offer</h2>
              <button onClick={() => setShowCreate(false)} className="p-1 text-text-tertiary hover:text-text-primary"><X size={16} /></button>
            </div>
            <div>
              <label className="block text-xxs text-text-tertiary mb-1">Title</label>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. July Staking Sprint"
                className="w-full text-xs py-2 px-2 bg-bg-input border border-border-primary rounded-md text-text-primary" />
            </div>
            <div>
              <label className="block text-xxs text-text-tertiary mb-1">Description (optional)</label>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2}
                placeholder="Shown to users on the Rewards page"
                className="w-full text-xs py-2 px-2 bg-bg-input border border-border-primary rounded-md text-text-primary resize-none" />
            </div>
            <div className="flex gap-3">
              <div>
                <label className="block text-xxs text-text-tertiary mb-1">Start date</label>
                <DateField value={startDate} onChange={setStartDate} />
              </div>
              <div>
                <label className="block text-xxs text-text-tertiary mb-1">End date</label>
                <DateField value={endDate} onChange={setEndDate} />
              </div>
            </div>
            <div className="space-y-2">
              <label className="block text-xxs text-text-tertiary">
                Reward tiers — referred staking volume range → reward paid to the referrer
                (percent of the whole volume, or a fixed $ amount)
              </label>
              {tiers.map((t, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <input type="number" min="0" value={t.min_amount ?? ''} onChange={(e) => setTiers((p) => p.map((x, xi) => xi === i ? { ...x, min_amount: e.target.value } : x))}
                    placeholder="Min $" className="w-24 text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md font-mono text-text-primary" />
                  <span className="text-xxs text-text-tertiary">to</span>
                  <input type="number" min="0" value={t.max_amount ?? ''} onChange={(e) => setTiers((p) => p.map((x, xi) => xi === i ? { ...x, max_amount: e.target.value } : x))}
                    placeholder="Max $ (blank = ∞)" className="w-28 text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md font-mono text-text-primary" />
                  <span className="text-xxs text-text-tertiary">→</span>
                  <input type="number" min="0" step="0.1" value={t.reward_value ?? ''} onChange={(e) => setTiers((p) => p.map((x, xi) => xi === i ? { ...x, reward_value: e.target.value } : x))}
                    placeholder={t.reward_type === 'pct' ? '%' : '$'} className="w-20 text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md font-mono text-text-primary" />
                  <select
                    value={t.reward_type}
                    onChange={(e) => setTiers((p) => p.map((x, xi) => xi === i ? { ...x, reward_type: e.target.value as 'pct' | 'fixed' } : x))}
                    className="text-xs py-1.5 px-1.5 bg-bg-input border border-border-primary rounded-md text-text-primary"
                    title="Percent of the whole referred volume, or a fixed $ payout"
                  >
                    <option value="pct">% of volume</option>
                    <option value="fixed">$ fixed</option>
                  </select>
                  {tiers.length > 1 && (
                    <button onClick={() => setTiers((p) => p.filter((_, xi) => xi !== i))} className="p-1 text-danger/70 hover:text-danger"><Trash2 size={13} /></button>
                  )}
                </div>
              ))}
              <button onClick={() => setTiers((p) => [...p, { min_amount: '', max_amount: '', reward_type: 'pct', reward_value: '' }])}
                className="inline-flex items-center gap-1 text-xxs font-medium text-buy hover:underline">
                <Plus size={12} /> Add tier
              </button>
            </div>
            <button onClick={() => void submit()} disabled={saving}
              className="w-full py-2.5 rounded-md text-xs font-bold text-white bg-buy hover:bg-buy-light disabled:opacity-50">
              {saving ? 'Creating…' : 'Create Offer'}
            </button>
          </div>
        </div>
      )}

      {/* Leaderboard modal */}
      {leaderFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setLeaderFor(null)} />
          <div className="relative w-full max-w-2xl rounded-xl border border-border-primary bg-bg-secondary p-5 space-y-3 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-text-primary">Leaderboard — {leaderFor.title}</h2>
              <button onClick={() => setLeaderFor(null)} className="p-1 text-text-tertiary hover:text-text-primary"><X size={16} /></button>
            </div>
            {leaders === null ? (
              <div className="flex justify-center py-8"><Loader2 className="animate-spin text-text-tertiary" /></div>
            ) : leaders.length === 0 ? (
              <p className="text-xs text-text-tertiary py-6 text-center">No qualifying referrals yet.</p>
            ) : (
              <table className="w-full text-left">
                <thead className="bg-bg-tertiary/40">
                  <tr className="text-xxs uppercase text-text-tertiary">
                    <th className="px-3 py-2">#</th>
                    <th className="px-3 py-2">Referrer</th>
                    <th className="px-3 py-2 text-right">Referred users</th>
                    <th className="px-3 py-2 text-right">Volume</th>
                    <th className="px-3 py-2 text-right">Claimed</th>
                  </tr>
                </thead>
                <tbody>
                  {leaders.map((r, i) => (
                    <tr key={r.user_id} className="border-t border-border-primary/50 text-xs">
                      <td className="px-3 py-2 text-text-tertiary">{i + 1}</td>
                      <td className="px-3 py-2">
                        <span className="text-text-primary">{r.name}</span>
                        <span className="block text-[10px] text-text-tertiary">{r.email}</span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{r.referred_users}</td>
                      <td className="px-3 py-2 text-right font-mono font-bold text-text-primary">{fmtUsd(r.qualifying_volume)}</td>
                      <td className="px-3 py-2 text-right">
                        {r.claimed
                          ? <span className="text-success font-bold">{r.claimed_amount != null ? fmtUsd(r.claimed_amount) : 'Yes'}</span>
                          : <span className="text-text-tertiary">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
