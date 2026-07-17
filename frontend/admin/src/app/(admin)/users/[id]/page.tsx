'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { adminApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import toast from 'react-hot-toast';
import Link from 'next/link';
import {
  ArrowLeft,
  Ban,
  CreditCard,
  DollarSign,
  Loader2,
  Mail,
  MapPin,
  Phone,
  Save,
  Shield,
  UserRound,
  Wallet,
  X,
  Download,
} from 'lucide-react';
import { downloadAdminReportPdf } from '@/lib/pdf/adminReportPdf';
import { usePermissions } from '@/lib/usePermissions';

interface UserDetail {
  user: {
    id: string;
    email: string;
    phone: string | null;
    first_name: string | null;
    last_name: string | null;
    country: string | null;
    address: string | null;
    role: string;
    status: string;
    kyc_status: string;
    is_demo: boolean;
    // Security / verification flags surfaced 2026-06-01 (#5) — admin
    // uses these to decide whether to trigger a reset / revoke sessions.
    email_verified?: boolean;
    two_factor_enabled?: boolean;
    bank_deposit_enabled?: boolean | null;
    is_promotional?: boolean;
    created_at: string | null;
  };
  accounts: {
    id: string;
    account_number: string;
    balance: number;
    credit: number;
    equity: number;
    margin_used: number;
    free_margin: number;
    margin_level: number;
    leverage: number;
    currency: string;
    is_demo: boolean;
    is_active: boolean;
    is_promotional?: boolean;
  }[];
  total_deposit: number;
  total_withdrawal: number;
  total_trades: number;
  open_positions: number;
  assigned_rm_id?: string | null;
  assigned_rm_name?: string | null;
}

function fmt(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function statusColor(s: string) {
  switch (s?.toLowerCase()) {
    case 'active': return 'bg-success/15 text-success';
    case 'banned': case 'suspended': return 'bg-danger/15 text-danger';
    default: return 'bg-warning/15 text-warning';
  }
}

/** Assign a user to a Relationship Manager. Renders only for admins who hold
 *  rm.assign (the /rm/list call 403s otherwise → we hide the card). */
function RMAssignCard({ userId, currentRmId, currentRmName, onSaved }: {
  userId: string; currentRmId: string | null | undefined; currentRmName: string | null | undefined; onSaved: () => void;
}) {
  const [rms, setRms] = useState<Array<{ id: string; name: string; email: string | null }>>([]);
  const [allowed, setAllowed] = useState(false);
  const [sel, setSel] = useState(currentRmId || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    adminApi.get<{ rms: typeof rms }>('/rm/list')
      .then((d) => { setRms(d.rms || []); setAllowed(true); })
      .catch(() => setAllowed(false));
  }, []);
  useEffect(() => { setSel(currentRmId || ''); }, [currentRmId]);

  if (!allowed) return null;

  const save = async () => {
    setSaving(true);
    try {
      await adminApi.post(`/rm/assign/${userId}`, { rm_id: sel || null });
      toast.success('RM assignment updated');
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to update');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-bg-secondary border border-border-primary rounded-lg p-5">
      <h2 className="text-base font-bold text-text-primary mb-1">Relationship Manager</h2>
      <p className="text-xxs text-text-tertiary mb-3">
        {currentRmName ? <>Currently managed by <span className="text-text-secondary">{currentRmName}</span>.</> : 'No RM assigned.'}
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        <select value={sel} onChange={(e) => setSel(e.target.value)}
          className="text-sm py-1.5 px-2 bg-bg-input border border-border-primary rounded-md text-text-primary min-w-[220px]">
          <option value="">— Unassigned —</option>
          {rms.map((r) => <option key={r.id} value={r.id}>{r.name} {r.email ? `(${r.email})` : ''}</option>)}
        </select>
        <button onClick={save} disabled={saving || sel === (currentRmId || '')}
          className="text-sm font-medium bg-accent text-white rounded-md px-3 py-1.5 disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

/** Per-referrer override of the AI-POWERED STAKING PROGRAM referral commission %. Blank on a
 *  leg = fall back to the global rate. Hidden if the endpoint 403s. */
function FrReferralOverrideCard({ userId }: { userId: string }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [info, setInfo] = useState<{
    mode: string; principal_pct_override: number | null; interest_pct_override: number | null;
    global_principal_pct: number; global_interest_pct: number;
  } | null>(null);
  const [prin, setPrin] = useState('');
  const [intr, setIntr] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await adminApi.get<any>(`/users/${userId}/fr-referral-override`);
      setInfo(d);
      setPrin(d.principal_pct_override != null ? String(d.principal_pct_override) : '');
      setIntr(d.interest_pct_override != null ? String(d.interest_pct_override) : '');
    } catch {
      setInfo(null);
    } finally {
      setLoading(false);
    }
  }, [userId]);
  useEffect(() => { load(); }, [load]);

  if (loading || !info) return null;

  const save = async () => {
    setSaving(true);
    try {
      await adminApi.post(`/users/${userId}/fr-referral-override`, {
        principal_pct: prin.trim() === '' ? null : parseFloat(prin),
        interest_pct: intr.trim() === '' ? null : parseFloat(intr),
      });
      toast.success('AI-POWERED STAKING PROGRAM referral override saved');
      load();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to save override');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-bg-secondary border border-border-primary rounded-lg p-5">
      <h2 className="text-base font-bold text-text-primary mb-1">AI-POWERED STAKING PROGRAM referral commission</h2>
      <p className="text-xxs text-text-tertiary mb-3">
        Custom % this user earns for referring AI-POWERED STAKING PROGRAM (AI-POWERED STAKING PROGRAM) lockers.
        Leave a field blank to use the global rate. Their payout mode is{' '}
        <span className="text-text-secondary">{info.mode}</span> (commission applies to that leg).
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xxs text-text-tertiary uppercase tracking-wide">Principal % override</label>
          <input type="number" min="0" max="100" step="0.01" value={prin}
            onChange={(e) => setPrin(e.target.value)}
            placeholder={`Global: ${info.global_principal_pct}%`}
            className="w-full mt-1 py-1.5 px-2 bg-bg-input border border-border-primary rounded-md text-sm text-text-primary" />
        </div>
        <div>
          <label className="block text-xxs text-text-tertiary uppercase tracking-wide">Interest % override</label>
          <input type="number" min="0" max="100" step="0.01" value={intr}
            onChange={(e) => setIntr(e.target.value)}
            placeholder={`Global: ${info.global_interest_pct}%`}
            className="w-full mt-1 py-1.5 px-2 bg-bg-input border border-border-primary rounded-md text-sm text-text-primary" />
        </div>
      </div>
      <div className="flex items-center gap-3 mt-3">
        <button onClick={save} disabled={saving}
          className="text-sm font-medium bg-accent text-white rounded-md px-3 py-1.5 disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={() => { setPrin(''); setIntr(''); }}
          className="text-xs text-text-tertiary hover:text-text-primary underline">Clear both (use global)</button>
      </div>
    </div>
  );
}

function kycColor(k: string) {
  switch (k?.toLowerCase()) {
    case 'verified': case 'approved': return 'bg-success/15 text-success';
    case 'pending': return 'bg-warning/15 text-warning';
    case 'rejected': return 'bg-danger/15 text-danger';
    default: return 'bg-text-tertiary/15 text-text-tertiary';
  }
}

export default function UserDetailPage() {
  const params = useParams();
  const router = useRouter();
  const userId = params.id as string;
  const { can } = usePermissions();

  const [data, setData] = useState<UserDetail | null>(null);
  const [deposits, setDeposits] = useState<Array<{ id: string; amount: number; method: string; status: string; created_at: string | null; approved_at: string | null; approved_by: string | null; reference: string | null }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bankBusy, setBankBusy] = useState(false);
  const [promoBusy, setPromoBusy] = useState(false);

  const fetchUser = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminApi.get<UserDetail>(`/users/${userId}`);
      setData(res);
      adminApi
        .get<{ deposits: typeof deposits }>(`/users/${userId}/deposits`)
        .then((d) => setDeposits(d.deposits || []))
        .catch(() => {});
    } catch (e: any) {
      setError(e.message || 'Failed to load user');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { fetchUser(); }, [fetchUser]);

  // Mark/unmark a trading account as promotional (pilot). Promo accounts stay
  // fully live on the user's own dashboard but are excluded from admin's real
  // company financials.
  const togglePromo = async (next: boolean) => {
    setPromoBusy(true);
    try {
      await adminApi.post(`/users/${userId}/promotional`, { is_promotional: next });
      toast.success(next ? 'User marked promotional' : 'User removed from promotional');
      await fetchUser();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to update');
    } finally { setPromoBusy(false); }
  };

  if (loading) {
    return (
      <>
        <div className="flex items-center justify-center py-32">
          <Loader2 size={24} className="animate-spin text-text-tertiary" />
        </div>
      </>
    );
  }

  if (error || !data) {
    return (
      <>
        <div className="p-6">
          <button onClick={() => router.back()} className="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary transition-fast mb-4">
            <ArrowLeft size={16} /> Back
          </button>
          <div className="text-center py-20 text-sm text-danger">{error || 'User not found'}</div>
        </div>
      </>
    );
  }

  const { user, accounts, total_deposit, total_withdrawal, total_trades, open_positions } = data;
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email.split('@')[0];

  // Full per-user detail report (client 2026-06-20 "user ki poori detail ki
  // PDF"): profile + totals as headline lines, trading accounts as the table.
  const exportUserPdf = () => {
    void downloadAdminReportPdf(
      `User report — ${name}`,
      [
        { header: 'Account', width: 38 },
        { header: 'Balance', width: 26, align: 'right', mono: true },
        { header: 'Credit', width: 24, align: 'right', mono: true },
        { header: 'Equity', width: 26, align: 'right', mono: true },
        { header: 'Margin used', width: 26, align: 'right', mono: true },
        { header: 'Leverage', width: 20, align: 'right' },
        { header: 'Currency', width: 20 },
      ],
      accounts.map(a => [
        a.account_number, `$${fmt(a.balance)}`, `$${fmt(a.credit)}`, `$${fmt(a.equity)}`,
        `$${fmt(a.margin_used)}`, `1:${a.leverage}`, a.currency,
      ]),
      {
        subtitle: `User: ${name} <${user.email}> | ID: ${user.id}`,
        summaryLines: [
          `Email: ${user.email}    Phone: ${user.phone || '-'}`,
          `Country: ${user.country || '-'}    Address: ${user.address || '-'}`,
          `Status: ${user.status}    KYC: ${user.kyc_status}    Joined: ${(user.created_at || '').slice(0, 10) || '-'}`,
          `Total deposits: $${fmt(total_deposit)}    Total withdrawals: $${fmt(total_withdrawal)}`,
          `Total trades: ${total_trades}    Open positions: ${open_positions}    Accounts: ${accounts.length}`,
        ],
        filename: `user-${name.replace(/\s+/g, '-').toLowerCase()}`,
      },
    );
  };

  // #12 (client 2026-06-20): download THIS user's deposit/withdrawal history.
  // Pulls their money transactions (trades excluded) and renders a PDF.
  const exportFundingPdf = async () => {
    try {
      const res = await adminApi.get<{ items: Array<{ type: string; amount: number; status: string; created_at: string | null; method?: string | null; description?: string | null }> }>(
        '/transactions', { search: user.email, exclude: 'trading,trade', per_page: '500' },
      );
      const items = res?.items || [];
      if (!items.length) { toast.error('No deposit/withdrawal history for this user'); return; }
      const completed = items.filter((i) => (i.status || '').toLowerCase() === 'completed');
      const totIn = completed.filter((i) => /deposit|bonus|commission|credit|fixed_return|transfer_in/i.test(i.type || '')).reduce((s, i) => s + (Number(i.amount) || 0), 0);
      const totOut = completed.filter((i) => /withdraw|transfer_out|debit/i.test(i.type || '')).reduce((s, i) => s + Math.abs(Number(i.amount) || 0), 0);
      void downloadAdminReportPdf(
        `Deposit & withdrawal history - ${name}`,
        [
          { header: 'Date', width: 36 },
          { header: 'Type', width: 30 },
          { header: 'Method', width: 38 },
          { header: 'Amount (USD)', width: 28, align: 'right', mono: true },
          { header: 'Status', width: 24 },
        ],
        items.map((i) => [
          (i.created_at || '').replace('T', ' ').slice(0, 16) || '-',
          (i.type || '-').replace(/_/g, ' '),
          i.method || i.description || '-',
          `$${fmt(Number(i.amount) || 0)}`,
          i.status || '-',
        ]),
        {
          subtitle: `User: ${name} <${user.email}> | ID: ${user.id}`,
          summaryLines: [
            `Rows: ${items.length}`,
            `Total in (completed): $${fmt(totIn)}    Total out (completed): $${fmt(totOut)}`,
          ],
          filename: `user-${name.replace(/\s+/g, '-').toLowerCase()}-funding`,
        },
      );
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Could not load history');
    }
  };

  return (
    <>
      <div className="p-6 space-y-6">
        {/* Back + Header */}
        <div>
          <button onClick={() => router.back()} className="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary transition-fast mb-4">
            <ArrowLeft size={16} /> Back to Users
          </button>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-full bg-buy/10 border-2 border-buy/20 flex items-center justify-center">
                <UserRound size={28} className="text-buy" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-text-primary">{name}</h1>
                <p className="text-sm text-text-tertiary">{user.email}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={exportUserPdf} title="Download this user's full detail as PDF"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-border-primary bg-bg-secondary text-text-primary hover:bg-bg-hover transition-fast">
                <Download size={14} className="text-buy" /> PDF
              </button>
              <span className={cn('px-3 py-1.5 rounded-lg text-xs font-semibold', statusColor(user.status))}>{user.status}</span>
              <span className={cn('px-3 py-1.5 rounded-lg text-xs font-semibold', kycColor(user.kyc_status))}>KYC: {user.kyc_status}</span>
            </div>
          </div>
        </div>

        {/* Info Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { label: 'Total Deposits', value: `$${fmt(total_deposit)}`, icon: DollarSign, color: 'text-success' },
            { label: 'Total Withdrawals', value: `$${fmt(total_withdrawal)}`, icon: Wallet, color: 'text-warning' },
            { label: 'Total Trades', value: total_trades.toLocaleString(), icon: CreditCard, color: 'text-buy' },
            { label: 'Open Positions', value: open_positions.toLocaleString(), icon: Shield, color: 'text-text-primary' },
          ].map(c => (
            <div key={c.label} className="bg-bg-secondary border border-border-primary rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <c.icon size={16} className={c.color} />
                <p className="text-xs text-text-tertiary">{c.label}</p>
              </div>
              <p className="text-lg font-bold text-text-primary font-mono tabular-nums">{c.value}</p>
            </div>
          ))}
        </div>

        {/* RM assignment (only visible to admins with rm.assign) */}
        <RMAssignCard
          userId={userId}
          currentRmId={data.assigned_rm_id}
          currentRmName={data.assigned_rm_name}
          onSaved={fetchUser}
        />

        {/* Per-referrer AI-POWERED STAKING PROGRAM referral commission % override */}
        <FrReferralOverrideCard userId={userId} />

        {/* Deposit history — how each deposit was made + which admin approved */}
        <div className="bg-bg-secondary border border-border-primary rounded-lg p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-bold text-text-primary">Deposit history</h2>
            <button
              type="button"
              onClick={exportFundingPdf}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-border-primary bg-bg-base text-text-primary hover:bg-bg-hover transition-fast"
              title="Download this user's deposit & withdrawal history as PDF"
            >
              <Download size={14} className="text-buy" /> Deposit/Withdrawal PDF
            </button>
          </div>
          {deposits.length === 0 ? (
            <p className="text-xs text-text-tertiary">No deposits.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-text-tertiary text-left uppercase tracking-wide">
                    <th className="py-2 pr-3">Date</th>
                    <th className="py-2 pr-3">Amount</th>
                    <th className="py-2 pr-3">Method</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3">Approved by</th>
                    <th className="py-2 pr-3">Reference</th>
                  </tr>
                </thead>
                <tbody>
                  {deposits.map((d) => (
                    <tr key={d.id} className="border-t border-border-primary/50">
                      <td className="py-2 pr-3 text-text-secondary whitespace-nowrap">{d.created_at ? new Date(d.created_at).toLocaleString() : '—'}</td>
                      <td className="py-2 pr-3 font-mono text-text-primary">${fmt(d.amount)}</td>
                      <td className="py-2 pr-3 text-text-primary capitalize">{(d.method || '—').replace(/_/g, ' ')}</td>
                      <td className="py-2 pr-3">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${['approved', 'auto_approved'].includes(d.status) ? 'bg-success/15 text-success' : d.status === 'pending' ? 'bg-warning/15 text-warning' : 'bg-bg-tertiary text-text-tertiary'}`}>{d.status}</span>
                      </td>
                      <td className="py-2 pr-3 text-text-secondary">{d.approved_by || (['approved', 'auto_approved'].includes(d.status) ? 'auto' : '—')}</td>
                      <td className="py-2 pr-3 text-text-tertiary font-mono truncate max-w-[160px]">{d.reference || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* User Details */}
        <div className="bg-bg-secondary border border-border-primary rounded-lg p-5">
          <h2 className="text-base font-bold text-text-primary mb-4">Personal Information</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              { label: 'Email', value: user.email, icon: Mail },
              { label: 'Phone', value: user.phone || '—', icon: Phone },
              { label: 'Country', value: user.country || '—', icon: MapPin },
              { label: 'Address', value: user.address || '—', icon: MapPin },
              { label: 'Role', value: user.role },
              { label: 'Member Since', value: user.created_at ? new Date(user.created_at).toLocaleDateString() : '—' },
            ].map(f => (
              <div key={f.label}>
                <p className="text-xs text-text-tertiary mb-1">{f.label}</p>
                <p className="text-sm text-text-primary">{f.value}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Account security & sessions — Reset Password, Revoke, list */}
        <SecurityCard userId={userId} user={user} />

        {/* AI-POWERED STAKING PROGRAM — managing these requires fixed_return.manage (client
            2026-06-20: a normal employee was still able to grant AI-POWERED STAKING PROGRAM). */}
        {can('fixed_return.manage') && (
          <>
            <FixedReturnOverrideCard userId={userId} />
            <FixedReturnGrantCard userId={userId} />
            <FixedReturnBonusCard userId={userId} />
          </>
        )}

        {/* Per-user bank deposit visibility (client 2026-06-23) */}
        {can('users.add_fund') && (
          <div className="bg-bg-secondary border border-border-primary rounded-lg p-5 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-text-primary">Bank deposit option</h3>
              <p className="text-xxs text-text-tertiary mt-0.5">
                Show the bank/manual deposit option to THIS client. {data.user.bank_deposit_enabled == null
                  ? 'Currently following the global setting.'
                  : data.user.bank_deposit_enabled ? 'Enabled for this client.' : 'Hidden for this client.'}
              </p>
            </div>
            <button
              type="button"
              disabled={bankBusy}
              onClick={async () => {
                setBankBusy(true);
                try {
                  const next = !(data.user.bank_deposit_enabled ?? false);
                  await adminApi.post(`/users/${userId}/bank-deposit`, { enabled: next });
                  toast.success(`Bank deposit ${next ? 'enabled' : 'disabled'} for this client`);
                  void fetchUser();
                } catch (e: unknown) {
                  toast.error(e instanceof Error ? e.message : 'Failed');
                } finally {
                  setBankBusy(false);
                }
              }}
              className={cn('relative w-10 h-5 rounded-full transition-fast shrink-0', data.user.bank_deposit_enabled ? 'bg-success' : 'bg-bg-tertiary border border-border-primary', bankBusy && 'opacity-50')}
            >
              <span className={cn('absolute top-0.5 w-4 h-4 rounded-full bg-white transition-fast shadow-sm', data.user.bank_deposit_enabled ? 'left-[22px]' : 'left-0.5')} />
            </button>
          </div>
        )}

        {/* Whole-user promotional / pilot flag (client 2026-07-03) */}
        {can('users.add_fund') && (
          <div className="bg-bg-secondary border border-border-primary rounded-lg p-5 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-text-primary">
                Promotional (pilot) account
                {data.user.is_promotional && (
                  <span className="ml-2 px-2 py-0.5 rounded text-xxs font-semibold bg-accent/15 text-accent align-middle">PROMO</span>
                )}
              </h3>
              <p className="text-xxs text-text-tertiary mt-0.5">
                Mark the WHOLE user as promotional. Everything stays live on their own dashboard,
                but ALL their activity (every account&apos;s trades / deposits / withdrawals +
                referral / IB / AI-POWERED STAKING PROGRAM) is EXCLUDED from the real company financials.{' '}
                {data.user.is_promotional ? 'Currently promotional.' : 'Currently a real account.'}
              </p>
            </div>
            <button
              type="button"
              disabled={promoBusy}
              onClick={() => togglePromo(!data.user.is_promotional)}
              title="Promotional users are excluded from real company financials but fully live on their own dashboard"
              className={cn('relative w-10 h-5 rounded-full transition-fast shrink-0', data.user.is_promotional ? 'bg-accent' : 'bg-bg-tertiary border border-border-primary', promoBusy && 'opacity-50')}
            >
              <span className={cn('absolute top-0.5 w-4 h-4 rounded-full bg-white transition-fast shadow-sm', data.user.is_promotional ? 'left-[22px]' : 'left-0.5')} />
            </button>
          </div>
        )}

        {/* Trading Accounts */}
        <div className="bg-bg-secondary border border-border-primary rounded-lg p-5">
          <h2 className="text-base font-bold text-text-primary mb-4">Trading Accounts ({accounts.length})</h2>
          {accounts.length === 0 ? (
            <p className="text-sm text-text-tertiary py-6 text-center">No trading accounts</p>
          ) : (
            <div className="space-y-3">
              {accounts.map(a => (
                <div key={a.id} className="border border-border-primary rounded-lg p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <p className="text-sm font-semibold text-text-primary font-mono">{a.account_number}</p>
                      <p className="text-xs text-text-tertiary">{a.currency} · Leverage {a.leverage}:1 {a.is_demo ? '· Demo' : ''}</p>
                    </div>
                    <span className={cn('px-2 py-1 rounded text-xxs font-semibold', a.is_active ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger')}>
                      {a.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                    {[
                      { label: 'Balance', value: `$${fmt(a.balance)}` },
                      { label: 'Credit', value: `$${fmt(a.credit)}` },
                      { label: 'Equity', value: `$${fmt(a.equity)}` },
                      { label: 'Margin Used', value: `$${fmt(a.margin_used)}` },
                      { label: 'Free Margin', value: `$${fmt(a.free_margin)}` },
                      { label: 'Margin Level', value: a.margin_level > 0 ? `${fmt(a.margin_level)}%` : '—' },
                    ].map(f => (
                      <div key={f.label}>
                        <p className="text-xxs text-text-tertiary uppercase tracking-wide">{f.label}</p>
                        <p className="text-sm text-text-primary font-mono tabular-nums">{f.value}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}


// ─── AI-POWERED STAKING PROGRAM per-user rate override ─────────────────────────────

interface FRConfig {
  tiers: { label: string; min_amount: number }[];
  tenures: { label: string; days: number }[];
  rate_matrix_pct: number[][];
}

function FixedReturnOverrideCard({ userId }: { userId: string }) {
  const [globalCfg, setGlobalCfg] = useState<FRConfig | null>(null);
  // null = no override set; matrix = override active.
  const [override, setOverride] = useState<number[][] | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Pull the global config from /settings so the editor's rows/columns
      // line up with whatever the admin set on /config/fixed-return.
      const [all, ov] = await Promise.all([
        adminApi.get<{ key: string; value: any }[]>('/settings').catch(() => []),
        adminApi.get<{ rate_override: { rate_matrix_pct?: number[][] } | null }>(
          `/fixed-return/users/${userId}/rate-override`,
        ).catch(() => ({ rate_override: null })),
      ]);
      const list = Array.isArray(all) ? all : [];
      const raw = list.find((s) => s.key === 'fixed_return_rates')?.value;
      const fallback: FRConfig = {
        tiers: [
          { label: '$1K', min_amount: 1000 },
          { label: '$10K', min_amount: 10000 },
          { label: '$25K', min_amount: 25000 },
          { label: '$50K', min_amount: 50000 },
          { label: '$100K', min_amount: 100000 },
        ],
        tenures: [
          { label: 'Month', days: 30 },
          { label: 'Quarter', days: 90 },
          { label: 'Half-Year', days: 180 },
          { label: 'Year', days: 365 },
          { label: '2 Year', days: 730 },
        ],
        rate_matrix_pct: [
          [1, 2, 2.5, 3, 4],
          [2, 3, 3, 3.5, 4.5],
          [3, 4, 4.5, 5, 5],
          [4, 5, 5.5, 6, 5.5],
          [5, 6, 6.5, 7, 7],
        ],
      };
      const cfg: FRConfig = raw && Array.isArray(raw.tiers) ? {
        tiers: raw.tiers,
        tenures: raw.tenures || fallback.tenures,
        rate_matrix_pct: Array.isArray(raw.rate_matrix_pct) ? raw.rate_matrix_pct : fallback.rate_matrix_pct,
      } : fallback;
      setGlobalCfg(cfg);
      const matrix = ov?.rate_override?.rate_matrix_pct;
      setOverride(Array.isArray(matrix) ? matrix : null);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  const enable = () => {
    if (!globalCfg) return;
    // Seed override with a copy of the current global matrix so admin
    // can edit just the cells they want different.
    setOverride(globalCfg.rate_matrix_pct.map((row) => [...row]));
  };

  const disable = async () => {
    if (!window.confirm('Clear this user\'s personal rate matrix? They will revert to the global ladder.')) return;
    setSaving(true);
    try {
      await adminApi.put(`/fixed-return/users/${userId}/rate-override`, { rate_matrix_pct: null });
      toast.success('Personal override removed');
      load();
    } catch (e: any) {
      toast.error(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const updateCell = (ti: number, ci: number, value: string) => {
    setOverride((prev) => {
      if (!prev) return prev;
      const n = parseFloat(value);
      const m = prev.map((row) => row.slice());
      m[ti][ci] = Number.isFinite(n) ? n : 0;
      return m;
    });
  };

  const save = async () => {
    if (!override) return;
    setSaving(true);
    try {
      await adminApi.put(`/fixed-return/users/${userId}/rate-override`, { rate_matrix_pct: override });
      toast.success('Personal rate matrix saved');
      load();
    } catch (e: any) {
      toast.error(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (loading || !globalCfg) {
    return (
      <div className="bg-bg-secondary border border-border-primary rounded-lg p-5">
        <Loader2 size={16} className="animate-spin text-text-tertiary" />
      </div>
    );
  }

  const isActive = override !== null;

  return (
    <div className="bg-bg-secondary border border-border-primary rounded-lg p-5">
      <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-text-primary">AI-POWERED STAKING PROGRAM — Personal Rates</h2>
          <p className="text-xs text-text-tertiary mt-0.5 max-w-2xl">
            Set a custom rate matrix that only applies to this trader. When inactive, the user
            sees the global ladder configured on{' '}
            <Link href="/config/fixed-return" className="text-buy hover:text-buy-light underline underline-offset-2">
              /config/fixed-return
            </Link>.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isActive ? (
            <>
              <button
                onClick={save}
                disabled={saving}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white bg-buy rounded-md hover:bg-buy-light disabled:opacity-50"
              >
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                Save
              </button>
              <button
                onClick={disable}
                disabled={saving}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs text-text-secondary border border-border-primary rounded-md hover:bg-bg-hover disabled:opacity-50"
              >
                <X size={12} /> Use global
              </button>
            </>
          ) : (
            <button
              onClick={enable}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white bg-buy rounded-md hover:bg-buy-light"
            >
              Set custom rates
            </button>
          )}
        </div>
      </div>

      {isActive && override ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px]">
            <thead>
              <tr className="border-b border-border-primary bg-bg-tertiary/40">
                <th className="text-left px-3 py-2 text-xxs uppercase tracking-wide text-text-tertiary">Tenure</th>
                {globalCfg.tiers.map((t, i) => (
                  <th key={i} className="px-3 py-2 text-center text-xxs uppercase tracking-wide text-text-tertiary">
                    {t.label}
                    <div className="text-[10px] font-normal text-text-tertiary/70 mt-0.5">
                      ≥ ${t.min_amount.toLocaleString()}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {globalCfg.tenures.map((tn, ti) => (
                <tr key={ti} className="border-b border-border-primary/40">
                  <th scope="row" className="text-left px-3 py-2 font-medium text-text-primary text-xs">
                    {tn.label}
                    <div className="text-[10px] font-normal text-text-tertiary mt-0.5">every {tn.days} days</div>
                  </th>
                  {globalCfg.tiers.map((_, ci) => (
                    <td key={ci} className="px-2 py-2 text-center">
                      <input
                        type="number"
                        step="0.01"
                        min={0}
                        value={override[ti]?.[ci] ?? 0}
                        onChange={(e) => updateCell(ti, ci, e.target.value)}
                        className="w-16 px-2 py-1 text-xs bg-bg-input border border-border-primary rounded font-mono tabular-nums text-text-primary text-center"
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[11px] text-text-tertiary mt-2">
            Each cell is the % paid <strong>per month</strong>. Same shape as the global matrix —
            if you re-shape global later, the override must match the new shape or it will be
            ignored (fall back to global) until re-saved here.
          </p>
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border-primary px-4 py-6 text-center text-xs text-text-tertiary">
          No personal rates set — this user sees the global ladder.
        </div>
      )}
    </div>
  );
}


// ─── Account security & sessions ─────────────────────────────────────

interface UserSession {
  id: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string | null;
  expires_at: string | null;
}

function SecurityCard({
  userId,
  user,
}: {
  userId: string;
  user: UserDetail['user'];
}) {
  const [sessions, setSessions] = useState<UserSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [resetting, setResetting] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokingAll, setRevokingAll] = useState(false);
  const [settingPwd, setSettingPwd] = useState(false);
  const [pwdResult, setPwdResult] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminApi.get<{ items: UserSession[] }>(
        `/users/${userId}/sessions`,
      );
      setSessions(res.items || []);
    } catch {
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  const triggerReset = async () => {
    if (!window.confirm(
      `Send a password reset email to ${user.email}?\n\nThe user will receive a one-time 15-minute link to set a new password. You will NOT see the plain password — it's never stored in readable form anywhere in the system.`,
    )) return;
    setResetting(true);
    try {
      const res = await adminApi.post<{ message: string; sent: boolean }>(
        `/users/${userId}/reset-password`, {},
      );
      toast.success(res.message || 'Reset email sent');
    } catch (e: any) {
      toast.error(e?.message || 'Failed to trigger reset');
    } finally {
      setResetting(false);
    }
  };

  const setUserPassword = async () => {
    const custom = window.prompt(
      `Set a NEW password for ${user.email}.\n\nLeave blank to auto-generate a strong one. You'll SEE the password once so you can share it with the user. (The old password can't be shown — it's encrypted.)`,
      '',
    );
    if (custom === null) return; // cancelled
    setSettingPwd(true);
    setPwdResult(null);
    try {
      const res = await adminApi.post<{ message: string; password: string }>(
        `/users/${userId}/set-password`, { password: custom.trim() || undefined },
      );
      setPwdResult(res.password);
      toast.success('Password set — copy it below');
    } catch (e: any) {
      toast.error(e?.message || 'Failed to set password');
    } finally {
      setSettingPwd(false);
    }
  };

  const revokeOne = async (sid: string) => {
    if (!window.confirm('Revoke this session? The user will be logged out from that device.')) return;
    setRevoking(sid);
    try {
      await adminApi.delete(`/users/${userId}/sessions/${sid}`);
      toast.success('Session revoked');
      loadSessions();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to revoke');
    } finally {
      setRevoking(null);
    }
  };

  const revokeAll = async () => {
    if (!window.confirm(`Revoke ALL ${sessions.length} active session(s) for ${user.email}?\n\nThe user will be forced to re-authenticate on every device.`)) return;
    setRevokingAll(true);
    try {
      await adminApi.post(`/users/${userId}/sessions/revoke-all`, {});
      toast.success('All sessions revoked');
      loadSessions();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to revoke');
    } finally {
      setRevokingAll(false);
    }
  };

  return (
    <div className="bg-bg-secondary border border-border-primary rounded-lg p-5 space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-text-primary">Account Security</h2>
          <p className="text-xs text-text-tertiary mt-0.5 max-w-2xl">
            Passwords are stored as <span className="text-text-secondary">bcrypt hashes</span> —
            plain text is never retrievable, even by admins. Use the actions
            below to help users regain access or to lock out suspicious sessions.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          <button
            type="button"
            onClick={setUserPassword}
            disabled={settingPwd}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-primary bg-primary/15 border border-primary/30 rounded-md hover:bg-primary/25 disabled:opacity-50"
          >
            {settingPwd ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            Set Password
          </button>
          <button
            type="button"
            onClick={triggerReset}
            disabled={resetting}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-buy rounded-md hover:bg-buy-light disabled:opacity-50"
          >
            {resetting ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            Send Reset Email
          </button>
        </div>
      </div>

      {pwdResult && (
        <div className="rounded-lg border border-primary/30 bg-primary/10 px-4 py-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-wide text-text-tertiary">New password (share with the user — shown once)</p>
            <p className="font-mono font-bold text-sm text-text-primary select-all break-all">{pwdResult}</p>
          </div>
          <button
            type="button"
            onClick={() => { navigator.clipboard?.writeText(pwdResult); toast.success('Copied'); }}
            className="text-xs text-primary hover:underline shrink-0"
          >
            Copy
          </button>
        </div>
      )}

      {/* Flags row — email verified, 2FA */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
        <Flag
          label="Email verified"
          value={user.email_verified ? 'Yes' : 'No'}
          good={!!user.email_verified}
        />
        <Flag
          label="Two-factor (2FA)"
          value={user.two_factor_enabled ? 'Enabled' : 'Disabled'}
          good={!!user.two_factor_enabled}
        />
        <Flag label="Account status" value={user.status} good={user.status === 'active'} />
        <Flag label="KYC" value={user.kyc_status || '—'} good={['verified', 'approved'].includes((user.kyc_status || '').toLowerCase())} />
      </div>

      {/* Sessions */}
      <div className="pt-2">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-bold text-text-primary">
            Active Sessions ({sessions.length})
          </h3>
          {sessions.length > 0 && (
            <button
              type="button"
              onClick={revokeAll}
              disabled={revokingAll}
              className="text-xs text-danger hover:underline disabled:opacity-50"
            >
              {revokingAll ? 'Revoking…' : 'Revoke all'}
            </button>
          )}
        </div>
        {loading ? (
          <div className="py-4 text-center"><Loader2 size={16} className="animate-spin text-text-tertiary inline-block" /></div>
        ) : sessions.length === 0 ? (
          <div className="text-xs text-text-tertiary py-3 text-center border border-dashed border-border-primary rounded-md">
            No active sessions
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px]">
              <thead>
                <tr className="border-b border-border-primary text-text-tertiary text-xxs uppercase tracking-wide">
                  <th className="text-left py-2">IP</th>
                  <th className="text-left py-2">User agent</th>
                  <th className="text-left py-2">Created</th>
                  <th className="text-right py-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id} className="border-b border-border-primary/40 last:border-0">
                    <td className="py-2 text-xs font-mono text-text-secondary">{s.ip_address || '—'}</td>
                    <td className="py-2 text-xs text-text-tertiary truncate max-w-[280px]" title={s.user_agent || ''}>
                      {s.user_agent || '—'}
                    </td>
                    <td className="py-2 text-xxs text-text-tertiary">
                      {s.created_at ? new Date(s.created_at).toLocaleString() : '—'}
                    </td>
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        onClick={() => revokeOne(s.id)}
                        disabled={revoking === s.id}
                        className="text-xxs text-danger hover:underline disabled:opacity-50"
                      >
                        {revoking === s.id ? 'Revoking…' : 'Revoke'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Flag({ label, value, good }: { label: string; value: string; good: boolean }) {
  return (
    <div className="rounded-md border border-border-primary bg-bg-tertiary/30 px-3 py-2">
      <p className="text-[10px] uppercase text-text-tertiary tracking-wide">{label}</p>
      <p className={cn(
        'text-sm font-bold mt-0.5',
        good ? 'text-success' : 'text-warning',
      )}>{value}</p>
    </div>
  );
}

// ─── AI-POWERED STAKING PROGRAM — Admin grant ──────────────────────────────────────
// Admin-side form that creates a AI-POWERED STAKING PROGRAM lock for this user with
// custom terms (principal, tenure, optional rate / lock-months override,
// optional broker-funded source). Same engine path as a trader-self-
// locked position — once created, the gateway interest engine drives
// payouts the same way.
const GRANT_TENURES = ['Month', 'Quarter', 'Half-Year', 'Year', '2 Year'] as const;

function FixedReturnBonusCard({ userId }: { userId: string }) {
  const [mode, setMode] = useState<'percent' | 'fixed'>('percent');
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const v = parseFloat(value);
    if (!Number.isFinite(v) || v <= 0) { toast.error('Enter a positive value'); return; }
    if (!window.confirm(
      mode === 'percent'
        ? `Grant a bonus of ${v}% of this user's active Fixed-Return principal?`
        : `Grant a flat $${v.toFixed(2)} Fixed-Return bonus to this user?`
    )) return;
    setSubmitting(true);
    try {
      const res = await adminApi.post<{ amount: number }>(`/fixed-return/users/${userId}/bonus`, { mode, value: v });
      toast.success(`Bonus of $${(res.amount ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2 })} credited`);
      setValue('');
    } catch (e: any) {
      toast.error(e?.message || 'Bonus failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-bg-secondary border border-border-primary rounded-lg p-5">
      <div className="mb-3">
        <h2 className="text-base font-bold text-text-primary">AI-POWERED STAKING PROGRAM — Special Bonus</h2>
        <p className="text-xs text-text-tertiary mt-0.5 max-w-2xl">
          Reward a Fixed-Return holder with a one-off bonus credited to their main wallet —
          either a <span className="text-text-primary font-semibold">percentage of their active locked principal</span> or a
          <span className="text-text-primary font-semibold"> flat amount</span>.
        </p>
      </div>
      <div className="flex items-end gap-3 flex-wrap">
        <label className="block">
          <span className="block text-[10px] uppercase text-text-tertiary mb-1">Type</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as any)}
            className="px-3 py-2 rounded-md bg-bg-tertiary border border-border-primary text-sm text-text-primary outline-none focus:border-accent/50">
            <option value="percent">% of active principal</option>
            <option value="fixed">Flat amount (USD)</option>
          </select>
        </label>
        <label className="block">
          <span className="block text-[10px] uppercase text-text-tertiary mb-1">{mode === 'percent' ? 'Percent (%)' : 'Amount (USD)'}</span>
          <input type="number" step="0.01" min="0" value={value} onChange={(e) => setValue(e.target.value)}
            placeholder={mode === 'percent' ? 'e.g. 5' : 'e.g. 100'}
            className="w-40 px-3 py-2 rounded-md bg-bg-tertiary border border-border-primary text-sm text-text-primary font-mono outline-none focus:border-accent/50" />
        </label>
        <button onClick={submit} disabled={submitting}
          className="px-4 py-2 rounded-md text-sm font-medium bg-accent text-white disabled:opacity-50">
          {submitting ? 'Granting…' : 'Grant bonus'}
        </button>
      </div>
    </div>
  );
}

function FixedReturnGrantCard({ userId }: { userId: string }) {
  const [principal, setPrincipal] = useState('');
  const [tenure, setTenure] = useState<typeof GRANT_TENURES[number]>('Year');
  const [ratePctOverride, setRatePctOverride] = useState('');
  const [lockMonthsOverride, setLockMonthsOverride] = useState('');
  const [source, setSource] = useState<'user_wallet' | 'admin_grant'>('user_wallet');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const p = parseFloat(principal);
    if (!Number.isFinite(p) || p <= 0) {
      toast.error('Enter a positive principal');
      return;
    }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        principal: p,
        tenure_label: tenure,
        source,
      };
      const r = parseFloat(ratePctOverride);
      if (ratePctOverride.trim() && Number.isFinite(r) && r >= 0) body.rate_pct_override = r;
      const m = parseInt(lockMonthsOverride, 10);
      if (lockMonthsOverride.trim() && Number.isFinite(m) && m > 0) body.lock_months_override = m;
      if (note.trim()) body.note = note.trim();
      await adminApi.post(`/fixed-return/users/${userId}/grant`, body);
      toast.success('AI-POWERED STAKING PROGRAM lock created');
      setPrincipal('');
      setRatePctOverride('');
      setLockMonthsOverride('');
      setNote('');
    } catch (e: any) {
      toast.error(e?.message || 'Grant failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-bg-secondary border border-border-primary rounded-lg p-5">
      <div className="mb-4">
        <h2 className="text-base font-bold text-text-primary">AI-POWERED STAKING PROGRAM — Grant a Lock</h2>
        <p className="text-xs text-text-tertiary mt-0.5 max-w-2xl">
          Create a AI-POWERED STAKING PROGRAM position for this user with any rate, tenure, or
          lock duration. Use <span className="text-text-primary font-semibold">User wallet</span>{' '}
          to debit their main balance (admin acts on their behalf), or{' '}
          <span className="text-text-primary font-semibold">Admin grant</span>{' '}
          for a broker-funded promo (no wallet debit).
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-3">
        <label className="block">
          <span className="block text-[10px] uppercase text-text-tertiary mb-1">Principal (USD)</span>
          <input
            type="number"
            step="0.01"
            min="0"
            value={principal}
            onChange={(e) => setPrincipal(e.target.value)}
            placeholder="e.g. 10000"
            className="w-full px-3 py-2 rounded-md bg-bg-tertiary border border-border-primary text-sm text-text-primary font-mono outline-none focus:border-accent/50"
          />
        </label>
        <label className="block">
          <span className="block text-[10px] uppercase text-text-tertiary mb-1">Tenure (payout cadence)</span>
          <select
            value={tenure}
            onChange={(e) => setTenure(e.target.value as any)}
            className="w-full px-3 py-2 rounded-md bg-bg-tertiary border border-border-primary text-sm text-text-primary outline-none focus:border-accent/50"
          >
            {GRANT_TENURES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="block text-[10px] uppercase text-text-tertiary mb-1">Source</span>
          <select
            value={source}
            onChange={(e) => setSource(e.target.value as any)}
            className="w-full px-3 py-2 rounded-md bg-bg-tertiary border border-border-primary text-sm text-text-primary outline-none focus:border-accent/50"
          >
            <option value="user_wallet">User wallet (debit balance)</option>
            <option value="admin_grant">Admin grant (broker-funded)</option>
          </select>
        </label>
        <label className="block">
          <span className="block text-[10px] uppercase text-text-tertiary mb-1">
            Rate % override <span className="lowercase">(optional)</span>
          </span>
          <input
            type="number"
            step="0.01"
            min="0"
            value={ratePctOverride}
            onChange={(e) => setRatePctOverride(e.target.value)}
            placeholder="Leave blank to use matrix rate"
            className="w-full px-3 py-2 rounded-md bg-bg-tertiary border border-border-primary text-sm text-text-primary font-mono outline-none focus:border-accent/50"
          />
        </label>
        <label className="block">
          <span className="block text-[10px] uppercase text-text-tertiary mb-1">
            Lock months override <span className="lowercase">(optional)</span>
          </span>
          <input
            type="number"
            min="1"
            max="240"
            value={lockMonthsOverride}
            onChange={(e) => setLockMonthsOverride(e.target.value)}
            placeholder="Leave blank for global default"
            className="w-full px-3 py-2 rounded-md bg-bg-tertiary border border-border-primary text-sm text-text-primary font-mono outline-none focus:border-accent/50"
          />
        </label>
        <label className="block sm:col-span-2 lg:col-span-3">
          <span className="block text-[10px] uppercase text-text-tertiary mb-1">
            Note <span className="lowercase">(written to the audit ledger)</span>
          </span>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. VIP onboarding promo"
            maxLength={240}
            className="w-full px-3 py-2 rounded-md bg-bg-tertiary border border-border-primary text-sm text-text-primary outline-none focus:border-accent/50"
          />
        </label>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          disabled={submitting || !principal}
          onClick={submit}
          className={cn(
            'inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-bold transition-colors',
            submitting || !principal
              ? 'bg-bg-tertiary text-text-tertiary cursor-not-allowed'
              : 'bg-buy text-white hover:bg-buy-light',
          )}
        >
          {submitting ? 'Creating…' : 'Grant AI-POWERED STAKING PROGRAM'}
        </button>
      </div>
    </div>
  );
}
