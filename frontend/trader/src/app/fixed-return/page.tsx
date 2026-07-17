'use client';

import { useEffect, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import { Loader2, Lock, AlertTriangle, CheckCircle2, Clock, Calendar, ChevronsUp } from 'lucide-react';

import DashboardShell from '@/components/layout/DashboardShell';
import Modal from '@/components/ui/Modal';
import api from '@/lib/api/client';

interface Tier { label: string; min_amount: number }
interface Tenure { label: string; days: number }
interface RateConfig {
  tiers: Tier[];
  tenures: Tenure[];
  rate_matrix_pct: number[][];
  early_withdrawal_fee_pct: number;
  lock_months: number;
  // Interest-payout window (admin-set, default 25–30): "Withdraw interest"
  // only works on these days of the month. The open flag is computed
  // server-side (UTC) so it always matches the API's own gate.
  payout_day_start: number;
  payout_day_end: number;
  payout_window_open: boolean;
  // Standard (post-launch) ladder, always present; equals rate_matrix_pct
  // unless a pre-launch offer (below) or personal override is active.
  base_rate_matrix_pct?: number[][];
  // Pre-launch offer (client 2026-07-14): when enabled, rate_matrix_pct above
  // IS this matrix (what users see is what they get); the standard sheet is
  // shown for comparison behind a toggle.
  prelaunch?: { enabled: boolean; headline: string; rate_matrix_pct: number[][] } | null;
}

interface LockRow {
  id: string;
  principal: number;
  tier_label: string;
  tenure_label: string;
  tenure_days: number;
  rate_pct: number;
  lock_months: number;
  locked_at: string | null;
  matures_at: string | null;
  next_payout_at: string | null;
  settled_at: string | null;
  early_requested_at: string | null;
  state: 'active' | 'early_pending' | 'principal_pending' | 'matured' | 'withdrawn_early';
  payouts_count: number;
  total_interest_paid: number;
  // Pro-rata interest since the last cycle credit (or lock open if no
  // cycle yet) — recomputed by the backend on every fetch.
  accrued_since_last_payout: number;
  // total_interest_paid + accrued_since_last_payout, convenience field.
  interest_to_date: number;
  projected_total_interest: number;
  projected_total_payout: number;
  payout: number | null;
  fee_paid: number | null;
}

const fmtUsd = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

const fmtDate = (s: string | null) => {
  if (!s) return '—';
  try { return new Date(s).toLocaleDateString(); } catch { return s; }
};

const daysBetween = (a: string | null, now: Date) => {
  if (!a) return 0;
  return Math.max(0, Math.ceil((new Date(a).getTime() - now.getTime()) / 86_400_000));
};

export default function FixedReturnPage() {
  const [cfg, setCfg] = useState<RateConfig | null>(null);
  const [locks, setLocks] = useState<LockRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const [amount, setAmount] = useState<string>('1000');
  const [tenureLabel, setTenureLabel] = useState<string>('');
  // Plan upgrade (client 2026-07-11): opens a modal with higher tenures,
  // top-up cost, and the elapsed interest that will be credited.
  const [upgradeFor, setUpgradeFor] = useState<LockRow | null>(null);
  const [upgradeOpts, setUpgradeOpts] = useState<any | null>(null);
  const [upgradePick, setUpgradePick] = useState<string>('');
  const [upgrading, setUpgrading] = useState(false);
  // Pre-launch sheet toggle (client 2026-07-14): 'live' = the pre-launch
  // rates currently in force, 'standard' = the post-launch ladder preview.
  const [sheetView, setSheetView] = useState<'live' | 'standard'>('live');
  // Custom in-app confirmation dialog (replaces native window.confirm).
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    danger?: boolean;
    onConfirm: () => void;
  } | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [c, l] = await Promise.all([
        api.get<RateConfig>('/fixed-return/config'),
        api.get<LockRow[]>('/fixed-return/locks').catch(() => [] as LockRow[]),
      ]);
      setCfg(c);
      setLocks(l || []);
      if (!tenureLabel && c.tenures.length > 0) setTenureLabel(c.tenures[0].label);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to load AI-POWERED STAKING PROGRAM');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const principal = useMemo(() => {
    const n = Number(amount);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [amount]);

  const tierIdx = useMemo(() => {
    if (!cfg) return -1;
    let idx = -1;
    cfg.tiers.forEach((t, i) => {
      if (principal >= t.min_amount) idx = i;
    });
    return idx;
  }, [cfg, principal]);

  const tenureIdx = useMemo(() => {
    if (!cfg) return -1;
    return cfg.tenures.findIndex((t) => t.label === tenureLabel);
  }, [cfg, tenureLabel]);

  const ratePct = useMemo(() => {
    if (!cfg || tierIdx < 0 || tenureIdx < 0) return 0;
    return cfg.rate_matrix_pct[tenureIdx]?.[tierIdx] ?? 0;
  }, [cfg, tierIdx, tenureIdx]);

  // Projected interest (client spec 2026-05-26): rate_pct is a
  // PER-MONTH percentage; the tenure decides the cadence and bundles
  // `monthsPerCycle` months of accrual into one credit. So:
  //   perCycle = principal * rate% * monthsPerCycle
  //   total    = principal * rate% * lockMonths
  // Example: $1000 at 2% Quarterly → $20/mo × 3 = $60 per quarterly payout.
  const projected = useMemo(() => {
    if (!cfg || tenureIdx < 0 || ratePct <= 0 || principal <= 0) {
      return { perCycle: 0, cycles: 0, total: 0, payout: principal };
    }
    const t = cfg.tenures[tenureIdx];
    const monthsPerCycle =
      t.days >= 700 ? 24
      : t.days >= 350 ? 12
      : t.days >= 170 ? 6
      : t.days >= 80 ? 3
      : 1;
    const cycles = Math.max(1, Math.floor(cfg.lock_months / monthsPerCycle));
    const perCycle = principal * (ratePct / 100) * monthsPerCycle;
    const total = principal * (ratePct / 100) * cfg.lock_months;
    return { perCycle, cycles, total, payout: principal + total };
  }, [cfg, tenureIdx, ratePct, principal]);

  const minAmount = cfg?.tiers[0]?.min_amount ?? 0;
  const eligible = principal >= minAmount && tenureIdx >= 0;

  // Open the custom confirmation dialog before committing funds. The Lock
  // button calls this; submitLock runs only after the user confirms.
  const requestLock = () => {
    if (!cfg) return;
    if (!eligible) {
      toast.error(`Minimum lock amount is ${fmtUsd(minAmount)}`);
      return;
    }
    setConfirmDialog({
      title: 'Confirm your staking lock',
      message:
        `• Amount: ${fmtUsd(principal)}\n` +
        `• Lock period: ${cfg.lock_months} months\n` +
        `• Payout cycle: ${tenureLabel}\n\n` +
        `This amount will be locked from your main wallet for the full term. ` +
        `Early withdrawal carries a ${cfg.early_withdrawal_fee_pct}% penalty and ` +
        `claws back interest paid to date.`,
      confirmLabel: `Lock ${fmtUsd(principal)}`,
      onConfirm: () => submitLock(false),
    });
  };

  const submitLock = async (acknowledgeBonusForfeit = false) => {
    if (!cfg) return;
    setSubmitting(true);
    try {
      await api.post('/fixed-return/lock', {
        principal,
        tenure_label: tenureLabel,
        acknowledge_bonus_forfeit: acknowledgeBonusForfeit,
      });
      toast.success(`Locked ${fmtUsd(principal)} for ${cfg.lock_months} months`);
      await load();
    } catch (e: any) {
      // 409 → locking would forfeit the user's bonus. Show a custom warning and
      // let them agree, then re-submit with acknowledgement (client 2026-06-30).
      if (e?.status === 409 && !acknowledgeBonusForfeit) {
        setSubmitting(false);
        setConfirmDialog({
          title: 'Bonus will be forfeited',
          message: `${e?.message || 'Your bonus will be forfeited.'}\n\nDo you agree and want to continue?`,
          confirmLabel: 'Agree & continue',
          danger: true,
          onConfirm: () => submitLock(true),
        });
        return;
      }
      toast.error(e?.message || 'Lock failed');
    } finally {
      setSubmitting(false);
    }
  };

  const withdraw = (l: LockRow) => {
    if (!cfg) return;
    const now = Date.now();
    const matured = !!(l.matures_at && new Date(l.matures_at).getTime() <= now);
    const message = matured
      ? `Request to withdraw your principal of ${fmtUsd(l.principal)}. The request goes to admin for approval — the principal is credited to your wallet once approved. Interest (${fmtUsd(l.total_interest_paid)} so far) was already paid in cycles.`
      : `Early withdrawal request:\n• ${cfg.early_withdrawal_fee_pct}% penalty on principal\n• ALL interest paid to date (${fmtUsd(l.total_interest_paid)}) claws back\n\nThe request goes to admin for approval — funds are NOT credited until approved. Projected return after approval: ${fmtUsd(Math.max(0, l.principal * (1 - cfg.early_withdrawal_fee_pct / 100) - l.total_interest_paid))}.`;
    setConfirmDialog({
      title: matured ? 'Withdraw principal' : 'Request early withdrawal',
      message,
      confirmLabel: matured ? 'Submit request' : 'Submit request',
      danger: !matured,
      onConfirm: () => doWithdraw(l, matured),
    });
  };

  const doWithdraw = async (l: LockRow, matured: boolean) => {
    setWithdrawing(l.id);
    try {
      await api.post(`/fixed-return/locks/${l.id}/withdraw`, {});
      toast.success(
        matured
          ? 'Principal-withdrawal request submitted — awaiting admin approval'
          : 'Early-withdrawal request submitted — awaiting admin approval',
      );
      await load();
    } catch (e: any) {
      toast.error(e?.message || 'Withdrawal failed');
    } finally {
      setWithdrawing(null);
    }
  };

  const openUpgrade = async (l: LockRow) => {
    setUpgradeFor(l);
    setUpgradeOpts(null);
    setUpgradePick('');
    try {
      const o = await api.get<any>(`/fixed-return/locks/${l.id}/upgrade-options`);
      setUpgradeOpts(o);
      if (o?.options?.length) setUpgradePick(o.options[0].tenure_label);
    } catch (e: any) {
      toast.error(e?.message || 'Could not load upgrade options');
      setUpgradeFor(null);
    }
  };

  const [withdrawingInterest, setWithdrawingInterest] = useState<string | null>(null);
  const withdrawInterest = async (l: LockRow) => {
    setWithdrawingInterest(l.id);
    try {
      const r = await api.post<{ interest_withdrawn: number }>(`/fixed-return/locks/${l.id}/withdraw-interest`, {});
      toast.success(`${fmtUsd(r.interest_withdrawn)} interest credited to your wallet.`);
      await load();
    } catch (e: any) {
      toast.error(e?.message || 'Interest withdrawal failed');
    } finally {
      setWithdrawingInterest(null);
    }
  };

  const doUpgrade = async () => {
    if (!upgradeFor || !upgradePick) return;
    setUpgrading(true);
    try {
      const r = await api.post<any>(`/fixed-return/locks/${upgradeFor.id}/upgrade`, {
        new_tenure_label: upgradePick,
      });
      toast.success(
        `Upgraded to ${upgradePick}! ${r.elapsed_interest_credited > 0 ? fmtUsd(r.elapsed_interest_credited) + ' interest credited. ' : ''}New principal ${fmtUsd(r.new_lock.principal)}.`,
      );
      setUpgradeFor(null);
      await load();
    } catch (e: any) {
      toast.error(e?.message || 'Upgrade failed');
    } finally {
      setUpgrading(false);
    }
  };

  if (loading || !cfg) {
    return (
      <DashboardShell>
        <div className="flex justify-center py-16">
          <Loader2 className="animate-spin text-accent" size={24} />
        </div>
      </DashboardShell>
    );
  }

  // Server-computed flag (UTC) — falls back to open if an older backend
  // doesn't send it yet; the API enforces the window regardless.
  const payoutWindowOpen = cfg.payout_window_open !== false;

  const prelaunchOn = !!cfg.prelaunch?.enabled;
  // Which sheet the table shows: the live (pre-launch) rates or the standard
  // post-launch ladder for comparison. Locks are ALWAYS priced off
  // cfg.rate_matrix_pct — the standard view is informational only.
  const showStandardSheet = prelaunchOn && sheetView === 'standard';
  const displayMatrix = showStandardSheet
    ? (cfg.base_rate_matrix_pct ?? cfg.rate_matrix_pct)
    : cfg.rate_matrix_pct;

  return (
    <DashboardShell>
      <div className="px-4 sm:px-6 py-6 space-y-6 max-w-[1200px] mx-auto">
        <header>
          <h1 className="text-2xl font-bold text-text-primary">AI-POWERED STAKING PROGRAM </h1>
          <p className="mt-1 text-sm text-text-secondary max-w-2xl">
            Lock your principal for{' '}
            <strong className="text-text-primary">{cfg.lock_months} months</strong>.
            Earn interest every cycle (Month / Quarter / etc. — your choice) and get your
            principal back at maturity.
          </p>
        </header>

        {/* Pre-launch offer switch (client 2026-07-14): while the offer runs,
            the pre-launch sheet IS the live rate; the standard ladder stays
            viewable for comparison. */}
        {prelaunchOn && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setSheetView('live')}
              className={clsx(
                'inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-bold transition-fast border',
                sheetView === 'live'
                  ? 'bg-accent text-white border-accent'
                  : 'border-border-primary text-text-secondary hover:bg-bg-hover',
              )}
            >
              🚀 Pre launch
            </button>
            <button
              onClick={() => setSheetView('standard')}
              className={clsx(
                'inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold transition-fast border',
                sheetView === 'standard'
                  ? 'bg-bg-hover text-text-primary border-border-primary'
                  : 'border-border-primary text-text-tertiary hover:bg-bg-hover',
              )}
            >
              Standard rates
            </button>
            <span className="text-[11px] font-semibold text-accent">
              {cfg.prelaunch?.headline}
            </span>
          </div>
        )}

        {/* Rate matrix */}
        <section className="rounded-xl border border-border-primary bg-bg-secondary overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border-primary bg-bg-tertiary/40">
                <th className="text-left px-4 py-3 text-xs uppercase tracking-wide text-text-tertiary">Tenure (payout cycle)</th>
                {cfg.tiers.map((t, i) => (
                  <th
                    key={i}
                    className={clsx(
                      'px-4 py-3 text-center text-xs uppercase tracking-wide',
                      i === tierIdx ? 'text-accent font-semibold' : 'text-text-tertiary',
                    )}
                  >
                    {t.label}
                    <div className="text-[10px] font-normal text-text-tertiary/70 mt-0.5">
                      ≥ {fmtUsd(t.min_amount)}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cfg.tenures.map((tn, ti) => (
                <tr
                  key={ti}
                  className={clsx(
                    'border-b border-border-primary/40',
                    tn.label === tenureLabel && 'bg-accent/[0.05]',
                  )}
                >
                  <th scope="row" className="text-left px-4 py-3 font-medium text-text-primary">
                    {tn.label}
                    <div className="text-[10px] font-normal text-text-tertiary mt-0.5">every {tn.days} days</div>
                  </th>
                  {cfg.tiers.map((_, ci) => {
                    const highlight = !showStandardSheet && ti === tenureIdx && ci === tierIdx;
                    return (
                      <td
                        key={ci}
                        className={clsx(
                          'px-4 py-3 text-center font-mono tabular-nums',
                          highlight
                            ? 'text-accent font-bold bg-accent/10'
                            : 'text-text-secondary',
                        )}
                      >
                        {(displayMatrix[ti]?.[ci] ?? 0).toFixed(2)}%
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[11px] text-text-tertiary px-4 py-2">
            {showStandardSheet
              ? 'Standard rates — these apply after the pre-launch offer ends. New locks today get the Pre launch rates.'
              : <>Each cell is the % paid <strong>per cycle</strong>. Your lock runs for {cfg.lock_months} months total.</>}
          </p>
        </section>

        {/* Calculator + lock form */}
        <section className="grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-border-primary bg-bg-secondary p-5">
            <h2 className="text-sm font-semibold text-text-primary mb-3">Open a new lock</h2>
            <label className="block text-xs font-medium text-text-secondary mb-1">Principal (USD)</label>
            <input
              type="number"
              min={0}
              step={100}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-bg-input border border-border-primary rounded-md font-mono tabular-nums text-text-primary"
            />
            <label className="block text-xs font-medium text-text-secondary mb-1 mt-3">Payout cycle</label>
            <select
              value={tenureLabel}
              onChange={(e) => setTenureLabel(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-bg-input border border-border-primary rounded-md text-text-primary"
            >
              {cfg.tenures.map((t) => (
                <option key={t.label} value={t.label}>{t.label} (every {t.days} days)</option>
              ))}
            </select>

            <button
              onClick={requestLock}
              disabled={submitting || !eligible}
              className="mt-4 inline-flex items-center justify-center gap-2 w-full px-4 py-2.5 bg-accent text-white font-semibold rounded-md hover:bg-accent/90 disabled:opacity-50 transition-fast"
            >
              {submitting ? <Loader2 size={16} className="animate-spin" /> : <Lock size={14} />}
              Lock {fmtUsd(principal || 0)} for {cfg.lock_months} months
            </button>
            {!eligible && principal > 0 && (
              <p className="mt-2 text-[11px] text-amber-400 flex items-center gap-1">
                <AlertTriangle size={11} /> Minimum lock amount is {fmtUsd(minAmount)}.
              </p>
            )}
          </div>

          <div className="rounded-xl border border-border-primary bg-bg-secondary p-5">
            <h2 className="text-sm font-semibold text-text-primary mb-3">Projected return</h2>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-md bg-bg-tertiary/40 p-3">
                <div className="text-[11px] text-text-tertiary uppercase">Tier</div>
                <div className="font-mono tabular-nums text-text-primary mt-1">
                  {tierIdx >= 0 ? cfg.tiers[tierIdx].label : '—'}
                </div>
              </div>
              <div className="rounded-md bg-bg-tertiary/40 p-3">
                <div className="text-[11px] text-text-tertiary uppercase">Rate per cycle</div>
                <div className="font-mono tabular-nums text-accent mt-1">{ratePct.toFixed(2)}%</div>
              </div>
              <div className="rounded-md bg-bg-tertiary/40 p-3">
                <div className="text-[11px] text-text-tertiary uppercase">Per cycle</div>
                <div className="font-mono tabular-nums text-buy mt-1">
                  {fmtUsd(eligible ? projected.perCycle : 0)}
                </div>
                <div className="text-[10px] text-text-tertiary mt-0.5">
                  × {eligible ? projected.cycles : 0} payouts
                </div>
              </div>
              <div className="rounded-md bg-bg-tertiary/40 p-3">
                <div className="text-[11px] text-text-tertiary uppercase">Total interest</div>
                <div className="font-mono tabular-nums text-buy font-semibold mt-1">
                  {fmtUsd(eligible ? projected.total : 0)}
                </div>
                <div className="text-[10px] text-text-tertiary mt-0.5">
                  over {cfg.lock_months} months
                </div>
              </div>
            </div>
            <div className="mt-3 rounded-md bg-accent/[0.06] border border-accent/25 px-3 py-2">
              <div className="text-[11px] text-text-tertiary">Total at maturity</div>
              <div className="font-mono tabular-nums text-text-primary font-bold text-lg">
                {fmtUsd(eligible ? projected.payout : 0)}
              </div>
              <div className="text-[10px] text-text-tertiary mt-0.5">
                = principal + cumulative interest
              </div>
            </div>
          </div>
        </section>

        {/* Active + history */}
        <section>
          <h2 className="text-sm font-semibold text-text-primary mb-3">Your locks</h2>
          {locks.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border-primary p-10 text-center text-sm text-text-tertiary">
              No locks yet. Open one above to start earning periodic interest.
            </div>
          ) : (
            <div className="space-y-3">
              {locks.map((l) => {
                const now = new Date();
                const matured = l.matures_at && new Date(l.matures_at) <= now;
                const isActive = l.state === 'active';
                const isPending = l.state === 'early_pending' || l.state === 'principal_pending';
                const isPrincipalPending = l.state === 'principal_pending';
                return (
                  <div
                    key={l.id}
                    className="rounded-xl border border-border-primary bg-bg-secondary p-4 space-y-3"
                  >
                    {/* Top row: metric grid */}
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                      <div>
                        <div className="text-[10px] text-text-tertiary uppercase tracking-wide">Principal</div>
                        <div className="font-mono tabular-nums text-text-primary font-semibold">
                          {fmtUsd(l.principal)}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-text-tertiary uppercase tracking-wide">Cycle</div>
                        <div className="text-text-primary text-sm">{l.tenure_label}</div>
                        <div className="text-[10px] text-text-tertiary">
                          <span className="font-mono tabular-nums text-accent">{l.rate_pct.toFixed(2)}%</span>/month
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-text-tertiary uppercase tracking-wide">Interest earned</div>
                        <div className="font-mono tabular-nums text-buy">
                          {fmtUsd(l.interest_to_date ?? l.total_interest_paid)}
                        </div>
                        <div className="text-[10px] text-text-tertiary">
                          {l.payouts_count} cycle{l.payouts_count === 1 ? '' : 's'} paid
                          {l.accrued_since_last_payout > 0 && (
                            <> · <span className="text-amber-400">+{fmtUsd(l.accrued_since_last_payout)} accruing</span></>
                          )}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-text-tertiary uppercase tracking-wide">Next payout</div>
                        <div className="text-text-primary text-sm flex items-center gap-1">
                          <Calendar size={11} className="text-text-tertiary shrink-0" />
                          {l.next_payout_at ? fmtDate(l.next_payout_at) : '—'}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-text-tertiary uppercase tracking-wide">Matures</div>
                        <div className="text-text-primary text-sm flex items-center gap-1">
                          <Clock size={11} className="text-text-tertiary shrink-0" />
                          <span>{fmtDate(l.matures_at)}</span>
                          {isActive && l.matures_at && !matured && (
                            <span className="text-[10px] text-text-tertiary">
                              ({daysBetween(l.matures_at, now)}d)
                            </span>
                          )}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-text-tertiary uppercase tracking-wide">Status</div>
                        <span
                          className={clsx(
                            'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium mt-0.5',
                            isActive && !matured && 'bg-amber-500/10 text-amber-400',
                            isActive && matured && 'bg-buy/15 text-buy',
                            isPending && 'bg-amber-500/20 text-amber-300',
                            l.state === 'matured' && 'bg-buy/15 text-buy',
                            l.state === 'withdrawn_early' && 'bg-text-tertiary/10 text-text-tertiary',
                          )}
                        >
                          {isActive && matured && <CheckCircle2 size={11} />}
                          {l.state === 'matured' && <CheckCircle2 size={11} />}
                          {isPending && <Clock size={11} />}
                          {isPending
                            ? 'Pending approval'
                            : isActive
                              ? (matured ? 'Matured' : 'Active')
                              : l.state === 'matured'
                                ? 'Settled'
                                : 'Closed (early)'}
                        </span>
                      </div>
                    </div>

                    {/* Start date + per-day / per-month interest + payouts taken.
                        rate_pct is a PER-MONTH %, so month = principal×rate%,
                        day = month/30. (client 2026-07-11) */}
                    {(() => {
                      const perMonth = l.principal * (l.rate_pct / 100);
                      const perDay = perMonth / 30;
                      return (
                        <div className="flex flex-wrap gap-x-6 gap-y-1.5 pt-2 border-t border-border-primary/40 text-[11px]">
                          <div>
                            <span className="text-text-tertiary">Started: </span>
                            <span className="text-text-primary font-medium">{fmtDate(l.locked_at)}</span>
                          </div>
                          <div>
                            <span className="text-text-tertiary">Interest / day: </span>
                            <span className="text-buy font-mono font-medium">{fmtUsd(perDay)}</span>
                          </div>
                          <div>
                            <span className="text-text-tertiary">Interest / month: </span>
                            <span className="text-buy font-mono font-medium">{fmtUsd(perMonth)}</span>
                          </div>
                          <div>
                            <span className="text-text-tertiary">Payouts received: </span>
                            <span className="text-text-primary font-medium">
                              {l.payouts_count} time{l.payouts_count === 1 ? '' : 's'} ({fmtUsd(l.total_interest_paid)})
                            </span>
                          </div>
                          <div>
                            <span className="text-text-tertiary">Current interest (not yet paid): </span>
                            <span className="text-amber-400 font-mono font-medium">{fmtUsd(l.accrued_since_last_payout)}</span>
                          </div>
                        </div>
                      );
                    })()}

                    {/* Pending-approval banner — moved out of the action row so
                        it never overlaps the status pill on narrow widths. */}
                    {isPending && (
                      <div className="rounded-md border border-amber-400/40 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-300 flex items-start gap-2">
                        <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                        <span>
                          {isPrincipalPending ? 'Principal-withdrawal request submitted' : 'Early-withdrawal request submitted'}
                          {l.early_requested_at ? ` on ${fmtDate(l.early_requested_at)}` : ''}.
                          {isPrincipalPending
                            ? ' Your principal will be credited to your wallet once an admin approves.'
                            : ' Funds stay locked until an admin approves; interest pauses meanwhile.'}
                        </span>
                      </div>
                    )}

                    {/* Action row — separate band, full-width on mobile so the
                        button never sits beside dense text. */}
                    {(isActive || isPending) && (
                      <div className="flex flex-wrap items-center justify-end gap-2 pt-1 border-t border-border-primary/40">
                        {isActive && !matured && (
                          <button
                            onClick={() => openUpgrade(l)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-fast border border-buy/40 text-buy hover:bg-buy/10"
                          >
                            <ChevronsUp size={13} /> Upgrade plan
                          </button>
                        )}
                        {/* Withdraw interest — direct to wallet, no approval.
                            Shown when there is accrued interest to pull, but only
                            clickable inside the admin payout window (default day
                            25–30 of each month); outside it the button is greyed
                            out and the backend refuses anyway. */}
                        {isActive && l.accrued_since_last_payout > 0 && (
                          <div className="flex flex-col items-end gap-0.5">
                            <button
                              onClick={() => void withdrawInterest(l)}
                              disabled={withdrawingInterest === l.id || !payoutWindowOpen}
                              title={payoutWindowOpen ? undefined : `Available only from day ${cfg.payout_day_start} to ${cfg.payout_day_end} of each month`}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-fast border border-buy/40 text-buy hover:bg-buy/10 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                            >
                              {withdrawingInterest === l.id && <Loader2 size={11} className="animate-spin" />}
                              Withdraw interest ({fmtUsd(l.accrued_since_last_payout)})
                            </button>
                            {!payoutWindowOpen && (
                              <span className="text-[10px] text-text-tertiary">
                                Available {cfg.payout_day_start}–{cfg.payout_day_end} of every month
                              </span>
                            )}
                          </div>
                        )}
                        {isActive && (
                          <button
                            onClick={() => withdraw(l)}
                            disabled={withdrawing === l.id}
                            className={clsx(
                              'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-fast disabled:opacity-50',
                              matured
                                ? 'bg-buy text-white hover:bg-buy/90'
                                : 'border border-amber-400/40 text-amber-400 hover:bg-amber-400/10',
                            )}
                          >
                            {withdrawing === l.id && <Loader2 size={11} className="animate-spin" />}
                            {matured ? 'Withdraw principal' : 'Request early withdrawal'}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <Modal
        open={!!confirmDialog}
        onClose={() => setConfirmDialog(null)}
        title={confirmDialog?.title}
        width="sm"
      >
        {confirmDialog && (
          <div className="space-y-4">
            <p className="text-sm text-text-secondary whitespace-pre-line leading-relaxed">
              {confirmDialog.message}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmDialog(null)}
                className="px-4 py-2 text-sm font-medium rounded-md border border-border-primary text-text-secondary hover:bg-bg-hover transition-fast"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const fn = confirmDialog.onConfirm;
                  setConfirmDialog(null);
                  fn();
                }}
                className={clsx(
                  'px-4 py-2 text-sm font-semibold rounded-md text-white transition-fast',
                  confirmDialog.danger ? 'bg-red-500 hover:bg-red-500/90' : 'bg-accent hover:bg-accent/90',
                )}
              >
                {confirmDialog.confirmLabel}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Upgrade plan modal */}
      <Modal
        open={!!upgradeFor}
        onClose={() => setUpgradeFor(null)}
        title="Upgrade your plan"
        width="sm"
      >
        {upgradeFor && (
          <div className="space-y-4">
            {!upgradeOpts ? (
              <div className="flex justify-center py-8"><Loader2 className="animate-spin text-text-tertiary" /></div>
            ) : !upgradeOpts.can_upgrade ? (
              <p className="text-sm text-text-secondary">
                This is already the highest plan — nothing higher to upgrade to.
              </p>
            ) : (
              <>
                <p className="text-sm text-text-secondary leading-relaxed">
                  Move from <strong className="text-text-primary">{upgradeFor.tenure_label}</strong> to a
                  higher plan. Your elapsed interest is credited to your wallet, a top-up is debited, and a
                  new bigger plan starts.
                </p>

                {/* Choose new plan */}
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1.5">New plan</label>
                  <div className="flex flex-wrap gap-1.5">
                    {upgradeOpts.options.map((o: any) => (
                      <button
                        key={o.tenure_label}
                        onClick={() => setUpgradePick(o.tenure_label)}
                        className={clsx(
                          'px-3 py-1.5 rounded-md text-xs font-semibold border transition-fast',
                          upgradePick === o.tenure_label
                            ? 'bg-accent/15 text-accent border-accent/50'
                            : 'border-border-primary text-text-secondary hover:bg-bg-hover',
                        )}
                      >
                        {o.tenure_label} · {o.new_rate_pct}%/mo
                      </button>
                    ))}
                  </div>
                </div>

                {/* Breakdown */}
                <div className="rounded-lg border border-border-primary bg-bg-base p-3 space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-text-tertiary">Elapsed interest → wallet</span>
                    <span className="font-mono font-semibold text-buy">+{fmtUsd(upgradeOpts.elapsed_interest)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-tertiary">Top-up debited ({upgradeOpts.topup_pct}% of {fmtUsd(upgradeOpts.current_principal)})</span>
                    <span className="font-mono font-semibold text-red-400">−{fmtUsd(upgradeOpts.topup_amount)}</span>
                  </div>
                  <div className="flex justify-between border-t border-border-primary/50 pt-1.5">
                    <span className="text-text-secondary font-medium">New principal</span>
                    <span className="font-mono font-bold text-text-primary">{fmtUsd(upgradeOpts.new_principal)}</span>
                  </div>
                </div>
                <p className="text-[11px] text-text-tertiary">
                  The {fmtUsd(upgradeOpts.topup_amount)} top-up is auto-debited from your main wallet.
                  Make sure you have enough balance.
                </p>

                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setUpgradeFor(null)}
                    className="px-4 py-2 text-sm font-medium rounded-md border border-border-primary text-text-secondary hover:bg-bg-hover transition-fast"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => void doUpgrade()}
                    disabled={upgrading || !upgradePick}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-md text-white bg-accent hover:bg-accent/90 transition-fast disabled:opacity-50"
                  >
                    {upgrading && <Loader2 size={13} className="animate-spin" />}
                    Upgrade to {upgradePick || '…'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </Modal>
    </DashboardShell>
  );
}
