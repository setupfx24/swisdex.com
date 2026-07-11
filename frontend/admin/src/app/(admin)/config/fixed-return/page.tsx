'use client';

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Loader2, Save, Plus, Trash2, Check, X, Clock } from 'lucide-react';
import { adminApi } from '@/lib/api';
import { cn } from '@/lib/utils';

interface Tier { label: string; min_amount: number }
interface Tenure { label: string; days: number }
interface RateConfig {
  tiers: Tier[];
  tenures: Tenure[];
  rate_matrix_pct: number[][];
}

const FALLBACK: RateConfig = {
  tiers: [
    { label: '$1K',   min_amount: 1000 },
    { label: '$10K',  min_amount: 10000 },
    { label: '$25K',  min_amount: 25000 },
    { label: '$50K',  min_amount: 50000 },
    { label: '$100K', min_amount: 100000 },
  ],
  tenures: [
    { label: 'Month',     days: 30 },
    { label: 'Quarter',   days: 90 },
    { label: 'Half-Year', days: 180 },
    { label: 'Year',      days: 365 },
    { label: '2 Year',    days: 730 },
  ],
  rate_matrix_pct: [
    [1.0, 2.0, 2.5, 3.0, 4.0],
    [2.0, 3.0, 3.0, 3.5, 4.5],
    [3.0, 4.0, 4.5, 5.0, 5.0],
    [4.0, 5.0, 5.5, 6.0, 5.5],
    [5.0, 6.0, 6.5, 7.0, 7.0],
  ],
};

export default function FixedReturnConfigPage() {
  const [cfg, setCfg] = useState<RateConfig>(FALLBACK);
  const [feePct, setFeePct] = useState<number>(5);
  const [lockMonths, setLockMonths] = useState<number>(24);
  // Day-of-month payout window. Defaults match the client's banking
  // cycle (25th → 30th). Setting both to 1/31 disables the gate.
  const [payoutDayStart, setPayoutDayStart] = useState<number>(25);
  const [payoutDayEnd, setPayoutDayEnd] = useState<number>(30);
  // AI-Staking referral commission % (referrer chooses which one applies).
  const [refPrincipalPct, setRefPrincipalPct] = useState<number>(0);
  const [refInterestPct, setRefInterestPct] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const all = await adminApi.get<{ key: string; value: any }[]>('/settings');
      const list = Array.isArray(all) ? all : [];
      const rates = list.find((s) => s.key === 'fixed_return_rates')?.value;
      const fee = list.find((s) => s.key === 'fixed_return_early_withdrawal_fee_pct')?.value;
      const lock = list.find((s) => s.key === 'fixed_return_lock_months')?.value;
      const dayStart = list.find((s) => s.key === 'fixed_return_payout_day_start')?.value;
      const dayEnd = list.find((s) => s.key === 'fixed_return_payout_day_end')?.value;
      const refPrin = list.find((s) => s.key === 'fr_referral_principal_pct')?.value;
      const refInt = list.find((s) => s.key === 'fr_referral_interest_pct')?.value;
      if (rates && Array.isArray(rates.tiers)) {
        setCfg(normalize(rates));
      }
      if (fee != null) {
        const n = Number(fee);
        if (Number.isFinite(n)) setFeePct(n);
      }
      if (lock != null) {
        const n = Number(lock);
        if (Number.isFinite(n) && n > 0) setLockMonths(Math.floor(n));
      }
      if (dayStart != null) {
        const n = Number(dayStart);
        if (Number.isFinite(n) && n >= 1 && n <= 31) setPayoutDayStart(Math.floor(n));
      }
      if (dayEnd != null) {
        const n = Number(dayEnd);
        if (Number.isFinite(n) && n >= 1 && n <= 31) setPayoutDayEnd(Math.floor(n));
      }
      if (refPrin != null) { const n = Number(refPrin); if (Number.isFinite(n) && n >= 0) setRefPrincipalPct(n); }
      if (refInt != null) { const n = Number(refInt); if (Number.isFinite(n) && n >= 0) setRefInterestPct(n); }
    } catch (e: any) {
      toast.error(e?.message || 'Failed to load AI Powered Staking config');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const normalize = (raw: any): RateConfig => {
    const tiers: Tier[] = Array.isArray(raw.tiers) ? raw.tiers : FALLBACK.tiers;
    const tenures: Tenure[] = Array.isArray(raw.tenures) ? raw.tenures : FALLBACK.tenures;
    const matrix: number[][] = tenures.map((_, ti) =>
      tiers.map((_, ci) => {
        const v = raw.rate_matrix_pct?.[ti]?.[ci];
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      }),
    );
    return { tiers, tenures, rate_matrix_pct: matrix };
  };

  const updateCell = (ti: number, ci: number, value: number) => {
    setCfg((prev) => {
      const m = prev.rate_matrix_pct.map((row) => row.slice());
      m[ti][ci] = value;
      return { ...prev, rate_matrix_pct: m };
    });
  };

  const updateTier = (ci: number, field: keyof Tier, value: string) => {
    setCfg((prev) => {
      const tiers = prev.tiers.slice();
      const t = { ...tiers[ci] };
      if (field === 'min_amount') {
        const n = Number(value); t.min_amount = Number.isFinite(n) ? n : 0;
      } else {
        t.label = value;
      }
      tiers[ci] = t;
      return { ...prev, tiers };
    });
  };

  const updateTenure = (ti: number, field: keyof Tenure, value: string) => {
    setCfg((prev) => {
      const tenures = prev.tenures.slice();
      const t = { ...tenures[ti] };
      if (field === 'days') {
        const n = Number(value); t.days = Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
      } else {
        t.label = value;
      }
      tenures[ti] = t;
      return { ...prev, tenures };
    });
  };

  const addTier = () => {
    setCfg((prev) => ({
      ...prev,
      tiers: [...prev.tiers, { label: 'New', min_amount: 0 }],
      rate_matrix_pct: prev.rate_matrix_pct.map((row) => [...row, 0]),
    }));
  };

  const removeTier = (ci: number) => {
    if (cfg.tiers.length <= 1) return;
    setCfg((prev) => ({
      ...prev,
      tiers: prev.tiers.filter((_, i) => i !== ci),
      rate_matrix_pct: prev.rate_matrix_pct.map((row) => row.filter((_, i) => i !== ci)),
    }));
  };

  const addTenure = () => {
    setCfg((prev) => ({
      ...prev,
      tenures: [...prev.tenures, { label: 'New', days: 30 }],
      rate_matrix_pct: [...prev.rate_matrix_pct, prev.tiers.map(() => 0)],
    }));
  };

  const removeTenure = (ti: number) => {
    if (cfg.tenures.length <= 1) return;
    setCfg((prev) => ({
      ...prev,
      tenures: prev.tenures.filter((_, i) => i !== ti),
      rate_matrix_pct: prev.rate_matrix_pct.filter((_, i) => i !== ti),
    }));
  };

  const save = async () => {
    if (feePct < 0 || feePct > 100) {
      toast.error('Fee must be between 0 and 100');
      return;
    }
    if (cfg.tiers.some((t) => !t.label.trim() || t.min_amount < 0)) {
      toast.error('Every tier needs a label and non-negative min amount');
      return;
    }
    if (cfg.tenures.some((t) => !t.label.trim() || t.days <= 0)) {
      toast.error('Every tenure needs a label and positive days');
      return;
    }
    if (lockMonths <= 0 || lockMonths > 120) {
      toast.error('Lock period must be between 1 and 120 months');
      return;
    }
    if (payoutDayStart < 1 || payoutDayStart > 31 || payoutDayEnd < 1 || payoutDayEnd > 31) {
      toast.error('Payout window days must be between 1 and 31');
      return;
    }
    if (payoutDayStart > payoutDayEnd) {
      toast.error('Payout window start day must be ≤ end day');
      return;
    }
    setSaving(true);
    try {
      await adminApi.put('/settings', {
        settings: {
          fixed_return_rates: cfg,
          fixed_return_early_withdrawal_fee_pct: feePct,
          fixed_return_lock_months: lockMonths,
          fixed_return_payout_day_start: payoutDayStart,
          fixed_return_payout_day_end: payoutDayEnd,
          fr_referral_principal_pct: refPrincipalPct,
          fr_referral_interest_pct: refInterestPct,
        },
      });
      toast.success('AI Powered Staking config saved');
    } catch (e: any) {
      toast.error(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 size={20} className="animate-spin text-text-tertiary" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-text-primary">AI Powered Staking — Rate Matrix</h1>
          <p className="text-xxs text-text-tertiary mt-0.5 max-w-3xl">
            Every lock runs for the full <strong>Lock period</strong> below. <strong>Tenure</strong> is the
            payout cadence — the user receives <em>principal × rate%</em> every cycle (Month / Quarter / etc.)
            and the principal back at maturity. The cell value is the % paid per cycle.
          </p>
        </div>
        <button
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-buy rounded-md hover:bg-buy-light disabled:opacity-50 transition-fast"
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save
        </button>
      </div>

      <div className="bg-bg-secondary border border-border-primary rounded-md p-4 flex flex-wrap gap-6">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-text-secondary">
            Lock period (months)
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={120}
              step={1}
              value={lockMonths}
              onChange={(e) => setLockMonths(parseInt(e.target.value) || 1)}
              className="w-24 px-2 py-1 text-xs bg-bg-input border border-border-primary rounded font-mono tabular-nums text-text-primary"
            />
            <span className="text-xxs text-text-tertiary">months</span>
          </div>
          <p className="text-[10px] text-text-tertiary max-w-xs">
            All new locks run for this many calendar months. Principal is returned at maturity;
            interest is paid in cycles defined by the tenure rows below.
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-text-secondary">
            Early-withdrawal fee (% of principal)
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              max={100}
              step="0.01"
              value={feePct}
              onChange={(e) => setFeePct(parseFloat(e.target.value) || 0)}
              className="w-24 px-2 py-1 text-xs bg-bg-input border border-border-primary rounded font-mono tabular-nums text-text-primary"
            />
            <span className="text-xxs text-text-tertiary">%</span>
          </div>
          <p className="text-[10px] text-text-tertiary max-w-xs">
            On early withdrawal: <strong>principal × (1 − fee%) − interest paid so far</strong>.
            Interest payments to date claw back from the returned principal.
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-text-secondary">
            Payout window (day of month)
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={31}
              step={1}
              value={payoutDayStart}
              onChange={(e) => setPayoutDayStart(Math.min(31, Math.max(1, parseInt(e.target.value) || 1)))}
              className="w-16 px-2 py-1 text-xs bg-bg-input border border-border-primary rounded font-mono tabular-nums text-text-primary"
            />
            <span className="text-xxs text-text-tertiary">to</span>
            <input
              type="number"
              min={1}
              max={31}
              step={1}
              value={payoutDayEnd}
              onChange={(e) => setPayoutDayEnd(Math.min(31, Math.max(1, parseInt(e.target.value) || 1)))}
              className="w-16 px-2 py-1 text-xs bg-bg-input border border-border-primary rounded font-mono tabular-nums text-text-primary"
            />
          </div>
          <p className="text-[10px] text-text-tertiary max-w-xs">
            Interest cycles only credit between these dates each month
            (default 25 → 30). Outside the window, due interest sits as
            a pending payout and lands the moment the window opens. Set
            both to 1 / 31 to disable the gate.
          </p>
        </div>
      </div>

      <div className="bg-bg-secondary border border-border-primary rounded-md p-4 flex flex-wrap gap-6">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-text-secondary">Referral — % of principal</label>
          <div className="flex items-center gap-2">
            <input
              type="number" min={0} max={100} step="0.1" value={refPrincipalPct}
              onChange={(e) => setRefPrincipalPct(Math.max(0, parseFloat(e.target.value) || 0))}
              className="w-24 px-2 py-1 text-xs bg-bg-input border border-border-primary rounded font-mono tabular-nums text-text-primary"
            />
            <span className="text-xxs text-text-tertiary">%</span>
          </div>
          <p className="text-[10px] text-text-tertiary max-w-xs">
            Paid ONCE to the referrer when a referred user locks — for referrers who chose
            &quot;On principal&quot; mode. 0 = off.
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-text-secondary">Referral — % of interest</label>
          <div className="flex items-center gap-2">
            <input
              type="number" min={0} max={100} step="0.1" value={refInterestPct}
              onChange={(e) => setRefInterestPct(Math.max(0, parseFloat(e.target.value) || 0))}
              className="w-24 px-2 py-1 text-xs bg-bg-input border border-border-primary rounded font-mono tabular-nums text-text-primary"
            />
            <span className="text-xxs text-text-tertiary">%</span>
          </div>
          <p className="text-[10px] text-text-tertiary max-w-xs">
            Paid on EACH interest payout the referred user receives — for referrers who chose
            &quot;On interest&quot; mode. 0 = off.
          </p>
        </div>
      </div>

      <div className="bg-bg-secondary border border-border-primary rounded-md overflow-x-auto">
        <table className="w-full min-w-[720px]">
          <thead>
            <tr className="border-b border-border-primary bg-bg-tertiary/40">
              <th className="text-left px-3 py-2 text-xxs font-medium text-text-tertiary uppercase tracking-wide">
                Tenure
              </th>
              <th className="text-left px-3 py-2 text-xxs font-medium text-text-tertiary uppercase tracking-wide">
                Days
              </th>
              {cfg.tiers.map((t, ci) => (
                <th key={ci} className="px-3 py-2 text-xxs font-medium text-text-tertiary uppercase tracking-wide">
                  <div className="flex flex-col items-center gap-1">
                    <input
                      value={t.label}
                      onChange={(e) => updateTier(ci, 'label', e.target.value)}
                      className="w-16 px-1.5 py-0.5 text-[11px] bg-bg-input border border-border-primary rounded font-medium text-text-primary text-center"
                    />
                    <input
                      type="number"
                      min={0}
                      step={100}
                      value={t.min_amount}
                      onChange={(e) => updateTier(ci, 'min_amount', e.target.value)}
                      className="w-20 px-1.5 py-0.5 text-[10px] bg-bg-input border border-border-primary rounded font-mono tabular-nums text-text-secondary text-center"
                      title="Min amount in USD"
                    />
                    <button
                      onClick={() => removeTier(ci)}
                      disabled={cfg.tiers.length <= 1}
                      className="p-0.5 text-text-tertiary hover:text-danger disabled:opacity-30 transition-fast"
                      title="Remove tier"
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>
                </th>
              ))}
              <th className="px-2 py-2">
                <button
                  onClick={addTier}
                  className="inline-flex items-center gap-1 px-1.5 py-1 text-xxs text-text-secondary border border-border-primary rounded hover:bg-bg-hover"
                  title="Add tier"
                >
                  <Plus size={11} />
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {cfg.tenures.map((tn, ti) => (
              <tr key={ti} className="border-b border-border-primary/50 hover:bg-bg-hover/30">
                <td className="px-3 py-2">
                  <input
                    value={tn.label}
                    onChange={(e) => updateTenure(ti, 'label', e.target.value)}
                    className="w-24 px-2 py-1 text-xs bg-bg-input border border-border-primary rounded text-text-primary"
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={tn.days}
                    onChange={(e) => updateTenure(ti, 'days', e.target.value)}
                    className="w-16 px-2 py-1 text-xs bg-bg-input border border-border-primary rounded font-mono tabular-nums text-text-primary"
                  />
                </td>
                {cfg.tiers.map((_, ci) => (
                  <td key={ci} className="px-3 py-2">
                    <input
                      type="number"
                      step="0.1"
                      min={0}
                      value={cfg.rate_matrix_pct[ti]?.[ci] ?? 0}
                      onChange={(e) => updateCell(ti, ci, parseFloat(e.target.value) || 0)}
                      className="w-16 px-2 py-1 text-xs bg-bg-input border border-border-primary rounded font-mono tabular-nums text-text-primary text-center"
                    />
                  </td>
                ))}
                <td className="px-2 py-2 text-right">
                  <button
                    onClick={() => removeTenure(ti)}
                    disabled={cfg.tenures.length <= 1}
                    className={cn(
                      'p-1 text-text-tertiary hover:text-danger disabled:opacity-30 transition-fast',
                    )}
                    title="Remove tenure"
                  >
                    <Trash2 size={12} />
                  </button>
                </td>
              </tr>
            ))}
            <tr>
              <td colSpan={cfg.tiers.length + 3} className="px-3 py-2">
                <button
                  onClick={addTenure}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xxs text-text-secondary border border-border-primary rounded hover:bg-bg-hover"
                >
                  <Plus size={11} /> Add tenure
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <PendingEarlyWithdrawals />
    </div>
  );
}


// ─── Early-withdrawal approval queue ─────────────────────────────────

interface PendingRow {
  id: string;
  user_id: string;
  user_email: string;
  user_name: string | null;
  principal: number;
  total_interest_paid: number;
  projected_payout: number;
  projected_fee: number;
  tenure_label: string;
  rate_pct: number;
  early_requested_at: string | null;
  locked_at: string | null;
  matures_at: string | null;
}

function PendingEarlyWithdrawals() {
  const [rows, setRows] = useState<PendingRow[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await adminApi.get<PendingRow[]>('/fixed-return/pending');
      setRows(Array.isArray(data) ? data : []);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to load early-withdrawal queue');
      setRows([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const approve = async (r: PendingRow) => {
    if (!window.confirm(
      `Approve early withdrawal for ${r.user_email}?\n\nUser will receive $${r.projected_payout.toFixed(2)} (principal $${r.principal.toFixed(2)} − fee $${r.projected_fee.toFixed(2)} − interest claw-back $${r.total_interest_paid.toFixed(2)}).`,
    )) return;
    setBusyId(r.id);
    try {
      await adminApi.post(`/fixed-return/${r.id}/approve`, {});
      toast.success('Approved — funds credited to user\'s main wallet');
      load();
    } catch (e: any) {
      toast.error(e?.message || 'Approve failed');
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (r: PendingRow) => {
    const reason = window.prompt(
      `Reject early withdrawal for ${r.user_email}?\nOptional reason (shown on the user's transaction log):`,
      '',
    );
    if (reason === null) return;
    setBusyId(r.id);
    try {
      await adminApi.post(`/fixed-return/${r.id}/reject`, { reason: reason || null });
      toast.success('Rejected — lock reverted to active');
      load();
    } catch (e: any) {
      toast.error(e?.message || 'Reject failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="bg-bg-secondary border border-border-primary rounded-md">
      <div className="px-4 py-3 border-b border-border-primary flex items-center gap-2">
        <Clock size={14} className="text-amber-400" />
        <h2 className="text-sm font-semibold text-text-primary">Early-withdrawal approvals</h2>
        <span className="text-xxs text-text-tertiary ml-2">
          {rows == null ? '…' : `${rows.length} pending`}
        </span>
        <button
          onClick={load}
          className="ml-auto text-xxs text-text-secondary hover:text-text-primary"
        >
          Refresh
        </button>
      </div>
      <div className="overflow-x-auto">
        {rows == null ? (
          <div className="px-4 py-6 text-center"><Loader2 size={16} className="animate-spin text-text-tertiary inline-block" /></div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-text-tertiary">
            No early-withdrawal requests waiting.
          </div>
        ) : (
          <table className="w-full min-w-[760px]">
            <thead>
              <tr className="border-b border-border-primary bg-bg-tertiary/40">
                <th className="text-left px-4 py-2.5 text-xxs font-medium text-text-tertiary uppercase tracking-wide">User</th>
                <th className="text-right px-4 py-2.5 text-xxs font-medium text-text-tertiary uppercase tracking-wide">Principal</th>
                <th className="text-right px-4 py-2.5 text-xxs font-medium text-text-tertiary uppercase tracking-wide">Interest paid</th>
                <th className="text-right px-4 py-2.5 text-xxs font-medium text-text-tertiary uppercase tracking-wide">Fee</th>
                <th className="text-right px-4 py-2.5 text-xxs font-medium text-text-tertiary uppercase tracking-wide">Payout</th>
                <th className="text-left  px-4 py-2.5 text-xxs font-medium text-text-tertiary uppercase tracking-wide">Requested</th>
                <th className="text-right px-4 py-2.5 text-xxs font-medium text-text-tertiary uppercase tracking-wide">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border-primary/50 last:border-0 hover:bg-bg-hover/30">
                  <td className="px-4 py-2.5">
                    <div className="text-xs text-text-primary truncate max-w-[220px]">{r.user_name || '—'}</div>
                    <div className="text-xxs text-text-tertiary truncate max-w-[220px]">{r.user_email}</div>
                  </td>
                  <td className="px-4 py-2.5 text-right text-xs font-mono tabular-nums text-text-primary">
                    ${r.principal.toFixed(2)}
                  </td>
                  <td className="px-4 py-2.5 text-right text-xs font-mono tabular-nums text-buy">
                    ${r.total_interest_paid.toFixed(2)}
                  </td>
                  <td className="px-4 py-2.5 text-right text-xs font-mono tabular-nums text-danger">
                    -${r.projected_fee.toFixed(2)}
                  </td>
                  <td className="px-4 py-2.5 text-right text-xs font-mono tabular-nums text-text-primary font-semibold">
                    ${r.projected_payout.toFixed(2)}
                  </td>
                  <td className="px-4 py-2.5 text-xxs text-text-secondary whitespace-nowrap">
                    {r.early_requested_at ? new Date(r.early_requested_at).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button
                        onClick={() => approve(r)}
                        disabled={busyId === r.id}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xxs text-white bg-buy rounded hover:bg-buy-light disabled:opacity-50"
                      >
                        <Check size={12} /> Approve
                      </button>
                      <button
                        onClick={() => reject(r)}
                        disabled={busyId === r.id}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xxs text-text-secondary border border-border-primary rounded hover:bg-bg-hover disabled:opacity-50"
                      >
                        <X size={12} /> Reject
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
