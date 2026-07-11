'use client';

/**
 * Super-admin Finance Overview.
 *
 * Headline cards for the whole company's money — each card is clickable
 * and opens a drill-down modal with its segregation (P&L by source,
 * deposits/withdrawals by method, credit split, fixed-return by tenure +
 * maturity schedule, pending by mode). Data: GET /analytics/finance-overview
 * (super_admin only). Clicking a method/tenure row inside a drill opens a
 * second-level per-USER breakdown via /analytics/finance-overview/drill.
 */
import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Loader2, X, TrendingUp, ArrowDownCircle, ArrowUpCircle, Gift, Lock, Clock, ChevronRight, Megaphone, Plus } from 'lucide-react';
import { adminApi } from '@/lib/api';
import DateField from '@/components/ui/DateField';

interface Row { label?: string; method?: string; tenure?: string; month?: string; amount?: number; principal?: number; count?: number; key?: string }
interface Overview {
  net_pnl: { total: number; sources: Row[] };
  promotional_expenses: { total: number; sources: Row[] };
  deposits: { total: number; by_method: Row[] };
  withdrawals: { total: number; by_method: Row[] };
  net_credit: { total: number; bonus: number; account_credit: number; insurance_credited_lifetime: number };
  fixed_return: {
    collected: number; interest_paid_to_date: number; projected_payable: number;
    accrued_to_date?: number; accrued_unpaid?: number; by_tenure: Row[]; maturing: Row[];
    by_user?: { user_id: string | null; name: string; email: string | null; principal: number; interest_accrued: number; interest_paid: number; count: number }[];
    referral_commission?: { user_id: string | null; name: string; email: string | null; amount: number; count: number }[];
  };
  pending_deposits: { total: number; by_method: Row[] };
  pending_withdrawals: { total: number; by_method: Row[] };
}

const fmt = (n: number | undefined) =>
  `$${(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

type Drill = { title: string; render: () => React.ReactNode } | null;
type UserDrill = { title: string; section: string; method?: string; tenure?: string; sort?: string } | null;

interface UserRow { user_id: string | null; name: string; email: string | null; amount: number; count: number }

/** Second-level drill: who (per user) is behind a card/source row. Supports a
 *  client-side name/email search and, for the trading section, a top
 *  gainers / top losers sort. */
function UserBreakdown({ section, method, tenure, initialSort, startDate, endDate }: { section: string; method?: string; tenure?: string; initialSort?: string; startDate?: string; endDate?: string }) {
  const [rows, setRows] = useState<UserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState(initialSort || 'amount');
  const isTrading = section === 'trading';

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const params: Record<string, string> = { section };
        if (method) params.method = method;
        if (tenure) params.tenure = tenure;
        if (isTrading) params.sort = sort;
        if (startDate) params.start_date = startDate;
        if (endDate) params.end_date = endDate;
        const d = await adminApi.get<{ users: UserRow[]; total: number }>('/analytics/finance-overview/drill', params);
        if (alive) { setRows(d.users || []); setTotal(d.total || 0); }
      } catch (e: any) {
        toast.error(e?.message || 'Failed to load per-user breakdown');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [section, method, tenure, sort, isTrading, startDate, endDate]);

  const q = search.trim().toLowerCase();
  const shown = q
    ? rows.filter((u) => (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q))
    : rows;
  const shownTotal = q ? shown.reduce((s, u) => s + (u.amount || 0), 0) : total;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search user name / email…"
          className="flex-1 min-w-[180px] text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md text-text-primary placeholder:text-text-tertiary"
        />
        {isTrading && (
          <div className="flex items-center gap-1">
            {(['gainers', 'losers'] as const).map((s) => (
              <button key={s} type="button" onClick={() => setSort(s)}
                className={`text-xs px-2 py-1 rounded-md capitalize border ${sort === s ? 'bg-bg-hover text-text-primary border-border-primary' : 'text-text-secondary border-transparent hover:bg-bg-hover/60'}`}>
                Top {s}
              </button>
            ))}
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center py-8"><Loader2 className="animate-spin text-text-tertiary" size={18} /></div>
      ) : (
        <table className="w-full text-sm">
          <thead><tr className="text-text-tertiary text-xxs uppercase tracking-wide">
            <th className="text-left py-2">User</th><th className="text-right py-2">{isTrading ? 'User P&L' : 'Amount'}</th><th className="text-right py-2">Count</th>
          </tr></thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan={3} className="py-4 text-center text-text-tertiary text-xs">No data</td></tr>}
            {shown.map((u, i) => (
              <tr key={u.user_id || i} className="border-t border-border-primary/50">
                <td className="py-2">
                  {u.user_id
                    ? <a href={`/users/${u.user_id}`} className="text-accent hover:underline">{u.name}</a>
                    : <span className="text-text-primary">{u.name}</span>}
                  {u.email && <span className="block text-xxs text-text-tertiary">{u.email}</span>}
                </td>
                <td className={`py-2 text-right font-mono ${isTrading ? (u.amount >= 0 ? 'text-buy' : 'text-sell') : 'text-text-primary'}`}>{fmt(u.amount)}</td>
                <td className="py-2 text-right text-text-tertiary">{u.count}</td>
              </tr>
            ))}
            {shown.length > 0 && (
              <tr className="border-t-2 border-border-primary font-bold">
                <td className="py-2 text-text-primary">Total ({shown.length} users)</td>
                <td className="py-2 text-right font-mono text-text-primary">{fmt(shownTotal)}</td>
                <td />
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function FinanceOverviewPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [drill, setDrill] = useState<Drill>(null);
  const [userDrill, setUserDrill] = useState<UserDrill>(null);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState({ amount: '', category: 'extra_fr_interest', user_id: '', note: '' });
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (dateFrom) params.start_date = dateFrom;
      if (dateTo) params.end_date = dateTo;
      const d = await adminApi.get<Overview>('/analytics/finance-overview', params);
      setData(d);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to load finance overview');
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo]);
  useEffect(() => { load(); }, [load]);

  const submitExpense = async () => {
    const amt = parseFloat(addForm.amount);
    if (!amt || amt <= 0) { toast.error('Enter an amount greater than zero'); return; }
    setSubmitting(true);
    try {
      await adminApi.post('/analytics/promotional-expenses', {
        amount: amt,
        category: addForm.category,
        note: addForm.note.trim() || undefined,
        user_id: addForm.user_id.trim() || undefined,
      });
      toast.success('Promotional expense logged');
      setAddOpen(false);
      setAddForm({ amount: '', category: 'extra_fr_interest', user_id: '', note: '' });
      load();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to add promotional expense');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading && !data) {
    return <div className="flex items-center justify-center h-96"><Loader2 className="animate-spin text-text-tertiary" size={22} /></div>;
  }
  if (!data) return null;

  // ── reusable breakdown table ──
  // When `section` is passed, each row is clickable and opens the per-user
  // drill-down for that method/tenure (GET /analytics/finance-overview/drill).
  const methodTable = (rows: Row[], valKey: 'amount' | 'principal' = 'amount', section?: string) => (
    <table className="w-full text-sm">
      <thead><tr className="text-text-tertiary text-xxs uppercase tracking-wide">
        <th className="text-left py-2">Method</th><th className="text-right py-2">Amount</th><th className="text-right py-2">Count</th>
      </tr></thead>
      <tbody>
        {rows.length === 0 && <tr><td colSpan={3} className="py-4 text-center text-text-tertiary text-xs">No data</td></tr>}
        {rows.map((r, i) => {
          const label = (r.method || r.tenure || r.month || '—').replace(/_/g, ' ');
          // 'maturing' rows are keyed by month (no per-user drill); only
          // method/tenure rows are drillable.
          const drillable = !!section && r.month === undefined;
          return (
            <tr key={i} className="border-t border-border-primary/50">
              <td className="py-2 text-text-primary capitalize">
                {drillable ? (
                  <button
                    type="button"
                    onClick={() => setUserDrill({
                      title: `${label} — by user`,
                      section: section!,
                      method: r.method,
                      tenure: r.tenure,
                    })}
                    className="text-accent hover:underline capitalize"
                  >
                    {label}
                  </button>
                ) : label}
              </td>
              <td className="py-2 text-right font-mono text-text-primary">{fmt(r[valKey])}</td>
              <td className="py-2 text-right text-text-tertiary">{r.count ?? '—'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  const cards: { title: string; value: number; sub?: string; icon: any; accent?: boolean; drill: Drill }[] = [
    {
      title: 'Net P&L (company)', value: data.net_pnl.total, icon: TrendingUp, accent: true,
      sub: 'Real profit to broker', drill: {
        title: 'Net P&L — by source (click a source for per-user)',
        render: () => (
          <table className="w-full text-sm">
            <tbody>
              {data.net_pnl.sources.map((s, i) => (
                <tr key={i} className="border-t border-border-primary/50">
                  <td className="py-2 text-text-primary">
                    {s.key ? (
                      <button
                        type="button"
                        onClick={() => setUserDrill({
                          title: `${s.label} — by user`,
                          section: s.key!,
                          sort: s.key === 'trading' ? 'gainers' : undefined,
                        })}
                        className="text-accent hover:underline text-left"
                      >
                        {s.label}
                      </button>
                    ) : s.label}
                  </td>
                  <td className={`py-2 text-right font-mono ${(s.amount ?? 0) >= 0 ? 'text-buy' : 'text-sell'}`}>
                    {(s.amount ?? 0) >= 0 ? '+' : '−'}{fmt(Math.abs(s.amount ?? 0))}
                  </td>
                </tr>
              ))}
              <tr className="border-t-2 border-border-primary font-bold">
                <td className="py-2 text-text-primary">Net P&L</td>
                <td className={`py-2 text-right font-mono ${data.net_pnl.total >= 0 ? 'text-buy' : 'text-sell'}`}>{fmt(data.net_pnl.total)}</td>
              </tr>
            </tbody>
          </table>
        ),
      },
    },
    {
      title: 'Promotional Expenses', value: data.promotional_expenses.total, icon: Megaphone,
      sub: 'Incentives given out', drill: {
        title: 'Promotional Expenses — by category',
        render: () => (
          <div className="space-y-3">
            <table className="w-full text-sm"><tbody>
              {data.promotional_expenses.sources.map((s, i) => (
                <tr key={i} className="border-t border-border-primary/50">
                  <td className="py-2 text-text-primary">{s.label}</td>
                  <td className="py-2 text-right font-mono text-text-primary">{fmt(s.amount)}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-border-primary font-bold">
                <td className="py-2 text-text-primary">Total promotional spend</td>
                <td className="py-2 text-right font-mono text-text-primary">{fmt(data.promotional_expenses.total)}</td>
              </tr>
            </tbody></table>
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => setUserDrill({ title: 'Promotional Expenses — by user', section: 'promotional_expenses' })}
                className="text-xs text-accent hover:underline inline-flex items-center gap-0.5"
              >
                View by user <ChevronRight size={11} />
              </button>
              <button
                type="button"
                onClick={() => { setDrill(null); setAddOpen(true); }}
                className="text-xs inline-flex items-center gap-1 rounded-md border border-border-primary px-2.5 py-1.5 text-text-secondary hover:bg-bg-hover"
              >
                <Plus size={12} /> Add Promotional Expense
              </button>
            </div>
          </div>
        ),
      },
    },
    {
      title: 'Net Deposits', value: data.deposits.total, icon: ArrowDownCircle,
      drill: { title: 'Deposits — by method (click a method for per-user)', render: () => methodTable(data.deposits.by_method, 'amount', 'deposits') },
    },
    {
      title: 'Net Withdrawals', value: data.withdrawals.total, icon: ArrowUpCircle,
      drill: { title: 'Withdrawals — by method (click a method for per-user)', render: () => methodTable(data.withdrawals.by_method, 'amount', 'withdrawals') },
    },
    {
      title: 'Net Credit (tradable)', value: data.net_credit.total, icon: Gift,
      sub: 'Bonus + insurance + grants', drill: {
        title: 'Net Credit — breakdown',
        render: () => (
          <table className="w-full text-sm"><tbody>
            <tr className="border-t border-border-primary/50"><td className="py-2 text-text-primary">Deposit bonus (wallet)</td><td className="py-2 text-right font-mono text-text-primary">{fmt(data.net_credit.bonus)}</td></tr>
            <tr className="border-t border-border-primary/50"><td className="py-2 text-text-primary">Account credit (bonus / insurance grants)</td><td className="py-2 text-right font-mono text-text-primary">{fmt(data.net_credit.account_credit)}</td></tr>
            <tr className="border-t border-border-primary/50"><td className="py-2 text-text-tertiary text-xs">Insurance credited (lifetime, ref)</td><td className="py-2 text-right font-mono text-text-tertiary text-xs">{fmt(data.net_credit.insurance_credited_lifetime)}</td></tr>
            <tr><td colSpan={2} className="pt-3">
              <button
                type="button"
                onClick={() => setUserDrill({ title: 'Net Credit — by user', section: 'net_credit' })}
                className="text-xs text-accent hover:underline inline-flex items-center gap-0.5"
              >
                View by user <ChevronRight size={11} />
              </button>
            </td></tr>
          </tbody></table>
        ),
      },
    },
    {
      title: 'Fixed Return collected', value: data.fixed_return.collected, icon: Lock,
      sub: `Payable: ${fmt(data.fixed_return.projected_payable)}`, drill: {
        title: 'Fixed Return — by tenure & maturity',
        render: () => (
          <div className="space-y-4">
            {/* ── Overview tiles ── */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {[
                { label: 'Collected', val: data.fixed_return.collected, tone: 'text-text-primary' },
                { label: 'Interest paid', val: data.fixed_return.interest_paid_to_date, tone: 'text-text-primary' },
                { label: 'Projected payable', val: data.fixed_return.projected_payable, tone: 'text-amber-400' },
                { label: 'Accrued to date', val: data.fixed_return.accrued_to_date ?? 0, tone: 'text-buy' },
                { label: 'Accrued unpaid', val: data.fixed_return.accrued_unpaid ?? 0, tone: 'text-amber-400' },
              ].map((c) => (
                <div key={c.label} className="rounded-lg border border-border-primary bg-bg-secondary/50 px-3 py-2.5">
                  <p className="text-[10px] text-text-tertiary uppercase tracking-wide">{c.label}</p>
                  <p className={`font-mono text-sm font-semibold mt-0.5 ${c.tone}`}>{fmt(c.val)}</p>
                </div>
              ))}
            </div>

            {/* ── By tenure ── */}
            <div className="rounded-lg border border-border-primary overflow-hidden">
              <div className="px-3 py-2 bg-bg-tertiary/40 border-b border-border-primary">
                <p className="text-xs font-semibold text-text-primary">By tenure</p>
                <p className="text-[10px] text-text-tertiary">Locked principal per payout cycle — click a row for the per-user breakdown</p>
              </div>
              <div className="p-2.5">{methodTable(data.fixed_return.by_tenure, 'principal', 'fixed_return')}</div>
            </div>

            {/* ── Maturing ── */}
            <div className="rounded-lg border border-border-primary overflow-hidden">
              <div className="px-3 py-2 bg-bg-tertiary/40 border-b border-border-primary">
                <p className="text-xs font-semibold text-text-primary">Maturing</p>
                <p className="text-[10px] text-text-tertiary">Principal maturing by month</p>
              </div>
              <div className="p-2.5">{methodTable(data.fixed_return.maturing, 'principal')}</div>
            </div>

            {/* ── Interest by user ── */}
            <div className="rounded-lg border border-border-primary overflow-hidden">
              <div className="px-3 py-2 bg-bg-tertiary/40 border-b border-border-primary">
                <p className="text-xs font-semibold text-text-primary">Interest by user</p>
                <p className="text-[10px] text-text-tertiary">Whose locks generated how much interest</p>
              </div>
              <div className="p-2.5">
                {(data.fixed_return.by_user?.length ?? 0) > 0 ? (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-text-tertiary border-b border-border-primary">
                        <th className="text-left py-1.5 font-medium">User</th>
                        <th className="text-right py-1.5 font-medium">Interest accrued</th>
                        <th className="text-right py-1.5 font-medium">Interest paid</th>
                        <th className="text-right py-1.5 font-medium">Principal</th>
                        <th className="text-right py-1.5 font-medium">Locks</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.fixed_return.by_user!.map((u, i) => (
                        <tr key={i} className="border-b border-border-primary/40">
                          <td className="py-1.5">
                            {u.user_id ? <a href={`/users/${u.user_id}`} className="text-accent hover:underline">{u.name}</a> : u.name}
                            {u.email && <span className="text-text-tertiary block text-[10px]">{u.email}</span>}
                          </td>
                          <td className="py-1.5 text-right font-mono text-buy">{fmt(u.interest_accrued)}</td>
                          <td className="py-1.5 text-right font-mono text-text-primary">{fmt(u.interest_paid)}</td>
                          <td className="py-1.5 text-right font-mono text-text-tertiary">{fmt(u.principal)}</td>
                          <td className="py-1.5 text-right text-text-tertiary">{u.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : <p className="text-xs text-text-tertiary py-1">No active locks.</p>}
              </div>
            </div>

            {/* ── Staking referral commission ── */}
            <div className="rounded-lg border border-border-primary overflow-hidden">
              <div className="px-3 py-2 bg-bg-tertiary/40 border-b border-border-primary">
                <p className="text-xs font-semibold text-text-primary">Staking referral commission</p>
                <p className="text-[10px] text-text-tertiary">Which referrer received how much from AI Powered Staking</p>
              </div>
              <div className="p-2.5">
                {(data.fixed_return.referral_commission?.length ?? 0) > 0 ? (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-text-tertiary border-b border-border-primary">
                        <th className="text-left py-1.5 font-medium">User</th>
                        <th className="text-right py-1.5 font-medium">Commission</th>
                        <th className="text-right py-1.5 font-medium">Payouts</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.fixed_return.referral_commission!.map((u, i) => (
                        <tr key={i} className="border-b border-border-primary/40">
                          <td className="py-1.5">
                            {u.user_id ? <a href={`/users/${u.user_id}`} className="text-accent hover:underline">{u.name}</a> : u.name}
                            {u.email && <span className="text-text-tertiary block text-[10px]">{u.email}</span>}
                          </td>
                          <td className="py-1.5 text-right font-mono text-buy">{fmt(u.amount)}</td>
                          <td className="py-1.5 text-right text-text-tertiary">{u.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : <p className="text-xs text-text-tertiary py-1">No staking referral commission yet.</p>}
              </div>
            </div>
          </div>
        ),
      },
    },
    {
      title: 'Pending Deposits', value: data.pending_deposits.total, icon: Clock,
      drill: { title: 'Pending deposits — by method (click for per-user)', render: () => methodTable(data.pending_deposits.by_method, 'amount', 'pending_deposits') },
    },
    {
      title: 'Pending Withdrawals', value: data.pending_withdrawals.total, icon: Clock,
      drill: { title: 'Pending withdrawals — by method (click for per-user)', render: () => methodTable(data.pending_withdrawals.by_method, 'amount', 'pending_withdrawals') },
    },
  ];

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-6xl">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold text-text-primary">Finance Overview</h1>
          <p className="text-xxs text-text-tertiary mt-0.5">
            {dateFrom || dateTo ? 'Flow figures filtered by date. Net Credit stays a live balance.' : 'Company-wide real-time money. Click any card to drill down.'}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Custom date range — restricts flow figures (P&L, deposits,
              withdrawals, fixed-return collected) to the window. */}
          <span className="text-xxs text-text-tertiary">From</span>
          <DateField value={dateFrom} max={dateTo || undefined} onChange={setDateFrom} />
          <span className="text-xxs text-text-tertiary">To</span>
          <DateField value={dateTo} min={dateFrom || undefined} onChange={setDateTo} />
          {(dateFrom || dateTo) && (
            <button type="button" onClick={() => { setDateFrom(''); setDateTo(''); }}
              className="text-xxs text-text-tertiary hover:text-text-primary underline">Clear</button>
          )}
          <button onClick={load} className="text-xxs text-text-secondary border border-border-primary rounded-md px-3 py-1.5 hover:bg-bg-hover">Refresh</button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {cards.map((c) => {
          const Icon = c.icon;
          return (
            <button
              key={c.title}
              type="button"
              onClick={() => setDrill(c.drill)}
              className={`text-left rounded-xl border p-4 transition-colors hover:bg-bg-hover/40 ${c.accent ? 'border-accent/40 bg-accent/[0.04]' : 'border-border-primary bg-bg-secondary'}`}
            >
              <div className="flex items-center justify-between">
                <span className="text-xxs text-text-tertiary uppercase tracking-wide">{c.title}</span>
                <Icon size={15} className={c.accent ? 'text-accent' : 'text-text-tertiary'} />
              </div>
              <p className={`mt-2 text-2xl font-bold font-mono ${c.accent ? (c.value >= 0 ? 'text-buy' : 'text-sell') : 'text-text-primary'}`}>{fmt(c.value)}</p>
              <div className="mt-1 flex items-center justify-between">
                <span className="text-xxs text-text-tertiary">{c.sub || ''}</span>
                <span className="inline-flex items-center gap-0.5 text-xxs text-accent">Details <ChevronRight size={11} /></span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Drill-down modal */}
      {drill && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setDrill(null)} />
          <div className="relative w-full max-w-lg max-h-[85vh] overflow-y-auto bg-bg-secondary border border-border-primary rounded-xl shadow-modal">
            <div className="flex items-center justify-between px-5 py-3 border-b border-border-primary sticky top-0 bg-bg-secondary">
              <h2 className="text-sm font-bold text-text-primary">{drill.title}</h2>
              <button onClick={() => setDrill(null)} className="p-1.5 rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary"><X size={16} /></button>
            </div>
            <div className="p-5">{drill.render()}</div>
          </div>
        </div>
      )}

      {/* Per-user drill-down modal (layered above the method modal) */}
      {userDrill && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setUserDrill(null)} />
          <div className="relative w-full max-w-lg max-h-[85vh] overflow-y-auto bg-bg-secondary border border-border-primary rounded-xl shadow-modal">
            <div className="flex items-center justify-between px-5 py-3 border-b border-border-primary sticky top-0 bg-bg-secondary">
              <h2 className="text-sm font-bold text-text-primary capitalize">{userDrill.title}</h2>
              <button onClick={() => setUserDrill(null)} className="p-1.5 rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary"><X size={16} /></button>
            </div>
            <div className="p-5">
              <UserBreakdown section={userDrill.section} method={userDrill.method} tenure={userDrill.tenure} initialSort={userDrill.sort} startDate={dateFrom} endDate={dateTo} />
            </div>
          </div>
        </div>
      )}

      {/* Add Promotional Expense modal */}
      {addOpen && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setAddOpen(false)} />
          <div className="relative w-full max-w-md bg-bg-secondary border border-border-primary rounded-xl shadow-modal">
            <div className="flex items-center justify-between px-5 py-3 border-b border-border-primary">
              <h2 className="text-sm font-bold text-text-primary">Add Promotional Expense</h2>
              <button onClick={() => setAddOpen(false)} className="p-1.5 rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary"><X size={16} /></button>
            </div>
            <div className="p-5 space-y-3">
              <p className="text-xxs text-text-tertiary">
                Log a give-away that has no other record (e.g. extra Fixed Return interest or a custom benefit).
                It's added to the Promotional Expenses total. To also move money into a user's wallet, use Add Fund on the user page.
              </p>
              <div>
                <label className="block text-xxs text-text-tertiary uppercase tracking-wide">Amount (USD) *</label>
                <input
                  type="number" min="0" step="0.01" value={addForm.amount}
                  onChange={(e) => setAddForm({ ...addForm, amount: e.target.value })}
                  className="w-full mt-1 rounded-md bg-bg-tertiary border border-border-primary px-3 py-2 text-sm text-text-primary font-mono"
                  placeholder="0.00"
                />
              </div>
              <div>
                <label className="block text-xxs text-text-tertiary uppercase tracking-wide">Category</label>
                <select
                  value={addForm.category}
                  onChange={(e) => setAddForm({ ...addForm, category: e.target.value })}
                  className="w-full mt-1 rounded-md bg-bg-tertiary border border-border-primary px-3 py-2 text-sm text-text-primary"
                >
                  <option value="extra_fr_interest">Extra Fixed Return interest</option>
                  <option value="fr_referral_bonus">Fixed Return referral bonus</option>
                  <option value="custom_benefit">Custom promotional benefit</option>
                  <option value="manual">Other</option>
                </select>
              </div>
              <div>
                <label className="block text-xxs text-text-tertiary uppercase tracking-wide">Recipient user ID (optional)</label>
                <input
                  type="text" value={addForm.user_id}
                  onChange={(e) => setAddForm({ ...addForm, user_id: e.target.value })}
                  className="w-full mt-1 rounded-md bg-bg-tertiary border border-border-primary px-3 py-2 text-sm text-text-primary font-mono"
                  placeholder="UUID (leave blank for a general promo cost)"
                />
              </div>
              <div>
                <label className="block text-xxs text-text-tertiary uppercase tracking-wide">Note</label>
                <textarea
                  value={addForm.note} rows={2}
                  onChange={(e) => setAddForm({ ...addForm, note: e.target.value })}
                  className="w-full mt-1 rounded-md bg-bg-tertiary border border-border-primary px-3 py-2 text-sm text-text-primary"
                  placeholder="What was given and why"
                />
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button onClick={() => setAddOpen(false)} className="text-xs px-3 py-2 rounded-md border border-border-primary text-text-secondary hover:bg-bg-hover">Cancel</button>
                <button
                  onClick={submitExpense} disabled={submitting}
                  className="text-xs px-3 py-2 rounded-md bg-accent text-white hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-1"
                >
                  {submitting && <Loader2 size={12} className="animate-spin" />} Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
