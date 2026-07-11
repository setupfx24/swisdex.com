'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { adminApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  Users, TrendingUp, Wallet, ArrowDownToLine,
  DollarSign, HeadphonesIcon, Loader2, RefreshCw,
  Download as DownloadIcon,
} from 'lucide-react';
import { downloadAdminReportPdf } from '@/lib/pdf/adminReportPdf';
import toast from 'react-hot-toast';
import { formatDistanceToNow } from 'date-fns';

/** Matches admin API `DashboardStats` */
interface DashboardStats {
  total_users: number;
  active_traders: number;
  deposits_today: number;
  withdrawals_today: number;
  platform_pnl: number;
  commission_paid: number;
  pending_deposits_count: number;
  open_tickets_count: number;
}

interface Deposit {
  id: string;
  user_email: string | null;
  amount: number;
  status: string;
  created_at: string;
}

interface Ticket {
  id: string;
  subject: string;
  user_email: string | null;
  status: string;
  created_at: string;
}

interface RevenuePoint {
  date: string;
  deposits: number;
  withdrawals: number;
  net: number;
}

interface LivePosition {
  id: string;
  instrument_symbol: string | null;
  side: string;
  lots: number;
  open_price: number;
  profit: number;
  user_email: string | null;
  account_number: string | null;
  created_at: string | null;
}

const OPEN_TICKET_STATUSES = new Set(['open', 'in_progress']);

const STAT_CONFIG: Array<{
  key: keyof DashboardStats;
  label: string;
  icon: typeof Users;
  format: (v: number) => string;
  pnl?: boolean;
  highlight?: boolean;
}> = [
  { key: 'total_users', label: 'Total Users', icon: Users, format: (v) => v.toLocaleString() },
  { key: 'active_traders', label: 'Active Traders', icon: TrendingUp, format: (v) => v.toLocaleString() },
  { key: 'deposits_today', label: 'Deposits Today', icon: Wallet, format: (v) => `$${v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}` },
  { key: 'pending_deposits_count', label: 'Pending Deposits', icon: ArrowDownToLine, format: (v) => v.toLocaleString(), highlight: true },
  { key: 'platform_pnl', label: 'Platform P&L', icon: DollarSign, format: (v) => `${v >= 0 ? '+' : ''}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`, pnl: true },
  { key: 'open_tickets_count', label: 'Open Tickets', icon: HeadphonesIcon, format: (v) => v.toLocaleString() },
];

function RevenueChart({ points }: { points: RevenuePoint[] }) {
  if (!points.length) {
    return (
      <div className="h-52 sm:h-64 flex items-center justify-center text-text-tertiary text-sm px-4 text-center">
        No revenue data in this range
      </div>
    );
  }

  const maxBar = Math.max(
    1,
    ...points.map((p) => Math.max(p.deposits, p.withdrawals, Math.abs(p.net))),
  );

  return (
    <div className="p-4 overflow-x-auto">
      <div className="flex items-end gap-0.5 sm:gap-1 min-h-[200px] sm:min-h-[240px] pb-8 min-w-[min(100%,720px)]">
        {points.map((p, i) => {
          const hDep = (p.deposits / maxBar) * 100;
          const hWdr = (p.withdrawals / maxBar) * 100;
          const showLabel = i % Math.ceil(points.length / 8) === 0 || i === points.length - 1;
          return (
            <div
              key={p.date}
              className="flex-1 min-w-[6px] max-w-[20px] flex flex-col items-center justify-end group relative"
            >
              <div
                className="w-full flex gap-px items-end justify-center"
                style={{ height: '180px' }}
              >
                <div
                  className="w-[45%] rounded-t-sm bg-buy/70 min-h-[2px] transition-all group-hover:bg-buy"
                  style={{ height: `${Math.max(hDep, p.deposits > 0 ? 4 : 0)}%` }}
                  title={`Deposits: $${p.deposits.toFixed(2)}`}
                />
                <div
                  className="w-[45%] rounded-t-sm bg-sell/60 min-h-[2px] transition-all group-hover:bg-sell"
                  style={{ height: `${Math.max(hWdr, p.withdrawals > 0 ? 4 : 0)}%` }}
                  title={`Withdrawals: $${p.withdrawals.toFixed(2)}`}
                />
              </div>
              {showLabel && (
                <span className="absolute -bottom-6 left-1/2 -translate-x-1/2 text-[9px] sm:text-xxs text-text-tertiary whitespace-nowrap rotate-0">
                  {p.date.slice(5)}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-4 mt-2 text-xxs text-text-tertiary">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-sm bg-buy/70" /> Deposits
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-sm bg-sell/60" /> Withdrawals
        </span>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [revenuePoints, setRevenuePoints] = useState<RevenuePoint[]>([]);
  const [livePositions, setLivePositions] = useState<LivePosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [feedLoading, setFeedLoading] = useState(false);

  const fetchLivePositions = useCallback(async () => {
    try {
      setFeedLoading(true);
      const res = await adminApi.get<{ items: LivePosition[] }>('/trades/positions', {
        status: 'open',
        per_page: '30',
        page: '1',
      });
      setLivePositions(res.items || []);
    } catch {
      setLivePositions([]);
    } finally {
      setFeedLoading(false);
    }
  }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [
        statsRes,
        depositsRes,
        ticketsRes,
        revenueRes,
        positionsRes,
      ] = await Promise.allSettled([
        adminApi.get<DashboardStats>('/dashboard/stats'),
        adminApi.get<{ items: Deposit[] }>('/finance/deposits', {
          status: 'pending',
          per_page: '5',
          page: '1',
        }),
        adminApi.get<{ items: Ticket[] }>('/support/tickets', {
          per_page: '40',
          page: '1',
        }),
        adminApi.get<{ points: RevenuePoint[] }>('/dashboard/revenue', { days: '30' }),
        adminApi.get<{ items: LivePosition[] }>('/trades/positions', {
          status: 'open',
          per_page: '30',
          page: '1',
        }),
      ]);

      if (statsRes.status === 'fulfilled') {
        setStats(statsRes.value);
      } else {
        setStats(null);
        const msg = statsRes.reason instanceof Error ? statsRes.reason.message : 'Failed to load stats';
        // A limited employee (e.g. one a super-admin impersonated) may lack
        // analytics.view — the stat cards just render "—", so don't spam a
        // permission toast. Only surface genuine failures (client 2026-06-24).
        if (!/permission|required|forbidden|unauthor|403/i.test(msg)) toast.error(msg);
      }

      if (depositsRes.status === 'fulfilled') {
        setDeposits(depositsRes.value.items || []);
      } else {
        setDeposits([]);
      }

      if (ticketsRes.status === 'fulfilled') {
        const items = ticketsRes.value.items || [];
        setTickets(items.filter((t) => OPEN_TICKET_STATUSES.has(t.status)).slice(0, 5));
      } else {
        setTickets([]);
      }

      if (revenueRes.status === 'fulfilled') {
        setRevenuePoints(revenueRes.value.points || []);
      } else {
        setRevenuePoints([]);
      }

      if (positionsRes.status === 'fulfilled') {
        setLivePositions(positionsRes.value.items || []);
      } else {
        setLivePositions([]);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load dashboard';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      fetchLivePositions();
    }, 15000);
    return () => window.clearInterval(id);
  }, [fetchLivePositions]);

  // Today's snapshot as a PDF (client 2026-06-20 admin #2): deposits,
  // withdrawals, P&L, users and pending counts as of now.
  const downloadSummaryPdf = () => {
    if (!stats) return;
    const m = (n: number) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    void downloadAdminReportPdf(
      "Today's summary",
      [{ header: 'Metric', width: 70 }, { header: 'Value', width: 50, align: 'right', mono: true }],
      [
        ['Deposits today', m(stats.deposits_today)],
        ['Withdrawals today', m(stats.withdrawals_today)],
        ['Platform P&L', m(stats.platform_pnl)],
        ['Commission paid', m(stats.commission_paid)],
        ['Total users', String(stats.total_users)],
        ['Active traders', String(stats.active_traders)],
        ['Pending deposits', String(stats.pending_deposits_count)],
        ['Open tickets', String(stats.open_tickets_count)],
      ],
      {
        subtitle: 'Platform snapshot',
        periodLabel: 'Today',
        landscape: false,
        filename: 'today-summary',
      },
    );
  };

  return (
    <>
      <div className="p-4 sm:p-6 space-y-6 max-w-[1600px] mx-auto w-full">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-text-primary">Dashboard</h2>
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <button
              type="button"
              onClick={downloadSummaryPdf}
              disabled={!stats}
              className="flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs text-text-primary bg-bg-secondary border border-border-primary rounded-md hover:bg-bg-hover transition-fast disabled:opacity-50 w-full sm:w-auto"
            >
              <DownloadIcon size={12} className="text-buy" />
              Today's summary PDF
            </button>
            <button
              type="button"
              onClick={fetchData}
              disabled={loading}
              className="flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary bg-bg-secondary border border-border-primary rounded-md hover:bg-bg-hover transition-fast disabled:opacity-50 w-full sm:w-auto"
            >
              <RefreshCw size={12} className={cn(loading && 'animate-spin')} />
              Refresh
            </button>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 sm:gap-3">
          {STAT_CONFIG.map((s) => {
            const val = stats ? stats[s.key] : null;
            return (
              <div key={s.key} className="bg-bg-secondary border border-border-primary rounded-md p-3 min-w-0">
                <div className="flex items-center justify-between mb-2 gap-1">
                  <span className="text-xxs text-text-tertiary truncate">{s.label}</span>
                  <s.icon size={14} className="text-text-tertiary shrink-0" />
                </div>
                <div
                  className={cn(
                    'text-base sm:text-lg font-semibold tabular-nums font-mono break-all',
                    loading && 'animate-pulse',
                    s.pnl && val != null && val >= 0 ? 'text-buy' : '',
                    s.pnl && val != null && val < 0 ? 'text-sell' : '',
                    !s.pnl ? 'text-text-primary' : '',
                    s.highlight && val != null && val > 0 ? 'text-warning' : '',
                  )}
                >
                  {loading ? '—' : val != null ? s.format(Number(val)) : '—'}
                </div>
              </div>
            );
          })}
        </div>

        {/* Two Column */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6">
          {/* Pending Deposits */}
          <div className="bg-bg-secondary border border-border-primary rounded-md min-w-0">
            <div className="px-4 py-3 border-b border-border-primary flex items-center justify-between gap-2">
              <h3 className="text-sm sm:text-md font-semibold text-text-primary">Pending Deposits</h3>
              {deposits.length > 0 && (
                <span className="px-1.5 py-0.5 text-xxs bg-warning/15 text-warning rounded-sm shrink-0">
                  {deposits.length} pending
                </span>
              )}
            </div>
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 size={16} className="animate-spin text-text-tertiary" />
              </div>
            ) : deposits.length === 0 ? (
              <div className="p-4 text-sm text-text-tertiary text-center py-8">
                No pending deposits
              </div>
            ) : (
              <div className="divide-y divide-border-primary">
                {deposits.map((d) => (
                  <div key={d.id} className="px-4 py-2.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 text-xs">
                    <div className="min-w-0">
                      <span className="text-text-primary break-all">{d.user_email || '—'}</span>
                      <span className="text-text-tertiary ml-2 whitespace-nowrap">
                        {d.created_at
                          ? formatDistanceToNow(new Date(d.created_at), { addSuffix: true })
                          : ''}
                      </span>
                    </div>
                    <span className="font-mono text-buy font-medium shrink-0">
                      ${Number(d.amount).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Open Tickets */}
          <div className="bg-bg-secondary border border-border-primary rounded-md min-w-0">
            <div className="px-4 py-3 border-b border-border-primary flex items-center justify-between gap-2">
              <h3 className="text-sm sm:text-md font-semibold text-text-primary">Open Support Tickets</h3>
              {tickets.length > 0 && (
                <span className="px-1.5 py-0.5 text-xxs bg-sell/15 text-sell rounded-sm shrink-0">
                  {tickets.length} open
                </span>
              )}
            </div>
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 size={16} className="animate-spin text-text-tertiary" />
              </div>
            ) : tickets.length === 0 ? (
              <div className="p-4 text-sm text-text-tertiary text-center py-8">
                No open tickets
              </div>
            ) : (
              <div className="divide-y divide-border-primary">
                {tickets.map((t) => (
                  <Link
                    key={t.id}
                    href={`/support?ticket=${t.id}`}
                    className="px-4 py-2.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 text-xs hover:bg-bg-hover transition-fast"
                  >
                    <div className="min-w-0">
                      <span className="text-text-primary">{t.subject}</span>
                      <span className="text-text-tertiary ml-2 break-all">{t.user_email || '—'}</span>
                    </div>
                    <span className="text-text-tertiary shrink-0">
                      {t.created_at
                        ? formatDistanceToNow(new Date(t.created_at), { addSuffix: true })
                        : ''}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Revenue */}
        <div className="bg-bg-secondary border border-border-primary rounded-md min-w-0">
          <div className="px-4 py-3 border-b border-border-primary">
            <h3 className="text-sm sm:text-md font-semibold text-text-primary">Revenue (Last 30 Days)</h3>
            <p className="text-xxs text-text-tertiary mt-0.5">Approved deposits vs completed withdrawals by day</p>
          </div>
          {loading ? (
            <div className="h-52 flex items-center justify-center">
              <Loader2 size={18} className="animate-spin text-text-tertiary" />
            </div>
          ) : (
            <RevenueChart points={revenuePoints} />
          )}
        </div>

        {/* Live Trade Feed */}
        <div className="bg-bg-secondary border border-border-primary rounded-md min-w-0">
          <div className="px-4 py-3 border-b border-border-primary flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <h3 className="text-sm sm:text-md font-semibold text-text-primary">Live Trade Feed</h3>
              <p className="text-xxs text-text-tertiary mt-0.5">Open positions (refreshes every 15s)</p>
            </div>
            {feedLoading && (
              <Loader2 size={14} className="animate-spin text-text-tertiary sm:ml-auto" />
            )}
          </div>
          <div className="px-2 sm:px-4 py-3 overflow-x-auto">
            {loading && livePositions.length === 0 ? (
              <div className="flex justify-center py-6">
                <Loader2 size={16} className="animate-spin text-text-tertiary" />
              </div>
            ) : livePositions.length === 0 ? (
              <p className="text-xs text-text-tertiary text-center py-6">No open positions</p>
            ) : (
              <table className="w-full text-xs min-w-[640px]">
                <thead>
                  <tr className="text-left text-text-tertiary border-b border-border-primary">
                    <th className="pb-2 pr-2 font-medium">Symbol</th>
                    <th className="pb-2 pr-2 font-medium">Side</th>
                    <th className="pb-2 pr-2 font-medium text-right">Lots</th>
                    <th className="pb-2 pr-2 font-medium text-right">Open</th>
                    <th className="pb-2 pr-2 font-medium text-right">P&amp;L</th>
                    <th className="pb-2 font-medium">Account / User</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums">
                  {livePositions.map((p) => (
                    <tr key={p.id} className="border-b border-border-primary/50 hover:bg-bg-tertiary/30">
                      <td className="py-2 pr-2 text-text-primary">{p.instrument_symbol || '—'}</td>
                      <td className={cn('py-2 pr-2 font-medium', p.side === 'buy' ? 'text-buy' : 'text-sell')}>
                        {p.side?.toUpperCase() || '—'}
                      </td>
                      <td className="py-2 pr-2 text-right">{p.lots}</td>
                      <td className="py-2 pr-2 text-right">{p.open_price?.toLocaleString?.() ?? p.open_price}</td>
                      <td
                        className={cn(
                          'py-2 pr-2 text-right font-medium',
                          p.profit >= 0 ? 'text-buy' : 'text-sell',
                        )}
                      >
                        {p.profit >= 0 ? '+' : ''}
                        {Number(p.profit).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </td>
                      <td className="py-2 text-text-tertiary break-all max-w-[200px]">
                        {p.account_number || '—'}
                        {p.user_email ? (
                          <span className="block text-xxs sm:inline sm:ml-1">{p.user_email}</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
