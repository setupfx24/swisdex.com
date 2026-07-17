'use client';

/**
 * Risk Management (client 2026-07-10).
 *  - Exposure board: per-instrument NET lots being traded + running P&L.
 *  - Running trades: every open trade, filterable by instrument and
 *    sortable by biggest profit / biggest loss / latest.
 * Auto-refreshes every 10s so the desk sees live risk without reloading.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { Gauge, Loader2, RefreshCw, TrendingDown, TrendingUp, Clock, Search, X } from 'lucide-react';
import { adminApi } from '@/lib/api';
import { cn } from '@/lib/utils';

interface ExposureRow {
  symbol: string; buy_lots: number; sell_lots: number; net_lots: number;
  trades: number; pnl: number;
}
interface TradeRow {
  position_id: string; symbol: string; side: string; lots: number;
  open_price: number; current_price: number | null; pnl: number;
  opened_at: string | null; account_number: string;
  is_demo: boolean; is_promotional: boolean;
  user_name: string; user_email: string;
}

const fmtMoney = (v: number) =>
  `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pnlClass = (v: number) => (v > 0 ? 'text-success' : v < 0 ? 'text-danger' : 'text-text-secondary');

export default function RiskPage() {
  const [book, setBook] = useState<'all' | 'real' | 'demo'>('all');
  const [exposure, setExposure] = useState<ExposureRow[]>([]);
  const [totals, setTotals] = useState<{ instruments: number; trades: number; pnl: number }>({ instruments: 0, trades: 0, pnl: 0 });
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [tradesTotal, setTradesTotal] = useState(0);
  const [symbolFilter, setSymbolFilter] = useState('');
  const [userFilter, setUserFilter] = useState('');       // selected user email ('' = all)
  const [userQuery, setUserQuery] = useState('');         // search text in the box
  const [userOpen, setUserOpen] = useState(false);        // dropdown open
  const userBoxRef = useRef<HTMLDivElement>(null);
  const [sort, setSort] = useState<'latest' | 'profit' | 'loss'>('latest');
  const [loading, setLoading] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const qs = new URLSearchParams({ book, sort, per_page: '100' });
      if (symbolFilter) qs.set('symbol', symbolFilter);
      const [exp, tr] = await Promise.all([
        adminApi.get<{ items: ExposureRow[]; totals: any }>(`/risk/exposure?book=${book}`),
        adminApi.get<{ items: TradeRow[]; total: number }>(`/risk/trades?${qs}`),
      ]);
      setExposure(exp?.items || []);
      setTotals(exp?.totals || { instruments: 0, trades: 0, pnl: 0 });
      setTrades(tr?.items || []);
      setTradesTotal(tr?.total || 0);
      setRefreshedAt(new Date());
    } catch (e: any) {
      if (!silent) toast.error(e?.message || 'Failed to load risk data');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [book, sort, symbolFilter]);

  useEffect(() => { load(); }, [load]);
  // Live-ish board: silent refresh every 10s.
  useEffect(() => {
    const id = setInterval(() => load(true), 10_000);
    return () => clearInterval(id);
  }, [load]);

  const symbols = exposure.map((e) => e.symbol);
  // Unique users across the open trades (for the running-trades user filter).
  const users = Array.from(
    new Map(trades.map((t) => [t.user_email, { email: t.user_email, name: t.user_name }])).values(),
  ).sort((a, b) => a.name.localeCompare(b.name));
  const q = userQuery.trim().toLowerCase();
  const userMatches = q
    ? users.filter((u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
    : users;
  const selectedUser = users.find((u) => u.email === userFilter) || null;
  const visibleTrades = userFilter ? trades.filter((t) => t.user_email === userFilter) : trades;

  // Close the user dropdown on outside click.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (userBoxRef.current && !userBoxRef.current.contains(e.target as Node)) setUserOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Gauge size={18} className="text-text-secondary" />
          <h1 className="text-lg font-semibold text-text-primary">Risk Management</h1>
        </div>
        <div className="flex items-center gap-2">
          {refreshedAt && (
            <span className="text-xxs text-text-tertiary">Updated {refreshedAt.toLocaleTimeString()}</span>
          )}
          <select
            value={book}
            onChange={(e) => setBook(e.target.value as any)}
            className="text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md text-text-primary"
            title="Which accounts to include"
          >
            <option value="all">All accounts</option>
            <option value="real">Real only</option>
            <option value="demo">Demo only</option>
          </select>
          <button
            onClick={() => load()}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xxs font-medium text-text-secondary border border-border-primary hover:bg-bg-hover"
          >
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
      </div>

      {/* Totals strip */}
      <div className="grid grid-cols-3 gap-2 max-w-xl">
        {[
          { label: 'Instruments in play', value: String(totals.instruments) },
          { label: 'Running trades', value: String(totals.trades) },
          // Broker P&L = −(users' P&L). When users are in profit, the broker
          // (B-book) is in loss, and vice versa.
          { label: 'Broker running P&L', value: fmtMoney(-totals.pnl), cls: pnlClass(-totals.pnl) },
        ].map((c) => (
          <div key={c.label} className="rounded-lg border border-border-primary bg-bg-secondary px-3 py-2.5">
            <div className="text-xxs text-text-tertiary">{c.label}</div>
            <div className={cn('text-base font-bold font-mono tabular-nums mt-0.5', c.cls || 'text-text-primary')}>{c.value}</div>
          </div>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="animate-spin text-text-tertiary" /></div>
      ) : (
        <>
          {/* ── Exposure by instrument ── */}
          <div className="rounded-lg border border-border-primary bg-bg-secondary overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border-primary">
              <h3 className="text-xs font-semibold text-text-primary">Net exposure by instrument</h3>
              <p className="text-xxs text-text-tertiary mt-0.5">Net lots = buy − sell across all open trades. <strong className="text-text-secondary">Broker P&L</strong> is the broker&apos;s side (green = broker profit / users losing, red = broker loss / users winning).</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="bg-bg-tertiary/40">
                  <tr className="text-xxs uppercase text-text-tertiary">
                    <th className="px-3 py-2">Instrument</th>
                    <th className="px-3 py-2 text-right">Buy lots</th>
                    <th className="px-3 py-2 text-right">Sell lots</th>
                    <th className="px-3 py-2 text-right">Net lots</th>
                    <th className="px-3 py-2 text-right">Trades</th>
                    <th className="px-3 py-2 text-right">Broker P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {!exposure.length ? (
                    <tr><td colSpan={6} className="px-4 py-6 text-center text-xxs text-text-tertiary">No open trades.</td></tr>
                  ) : exposure.map((r) => (
                    <tr
                      key={r.symbol}
                      onClick={() => setSymbolFilter(symbolFilter === r.symbol ? '' : r.symbol)}
                      className={cn(
                        'border-t border-border-primary/50 text-xs cursor-pointer hover:bg-bg-hover/40',
                        symbolFilter === r.symbol && 'bg-buy/5',
                      )}
                      title="Click to filter the trades list to this instrument"
                    >
                      <td className="px-3 py-2 font-semibold text-text-primary">{r.symbol}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-success">{r.buy_lots.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-danger">{r.sell_lots.toFixed(2)}</td>
                      <td className={cn('px-3 py-2 text-right font-mono tabular-nums font-bold', r.net_lots > 0 ? 'text-success' : r.net_lots < 0 ? 'text-danger' : 'text-text-secondary')}>
                        {r.net_lots > 0 ? '+' : ''}{r.net_lots.toFixed(2)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-text-secondary">{r.trades}</td>
                      <td className={cn('px-3 py-2 text-right font-mono tabular-nums font-bold', pnlClass(-r.pnl))}>{fmtMoney(-r.pnl)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Running trades ── */}
          <div className="rounded-lg border border-border-primary bg-bg-secondary overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border-primary flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-xs font-semibold text-text-primary">Running trades ({userFilter ? `${visibleTrades.length} of ${tradesTotal}` : tradesTotal})</h3>
                <p className="text-xxs text-text-tertiary mt-0.5">Every open position, live P&L per trade (from the user&apos;s side).</p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {/* Searchable user filter: type to search + pick from the list. */}
                <div ref={userBoxRef} className="relative">
                  <div className="flex items-center gap-1 min-w-[180px] text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md">
                    <Search size={12} className="text-text-tertiary shrink-0" />
                    <input
                      value={userOpen ? userQuery : (selectedUser ? selectedUser.name : userQuery)}
                      onChange={(e) => { setUserQuery(e.target.value); setUserOpen(true); }}
                      onFocus={() => { setUserOpen(true); setUserQuery(''); }}
                      placeholder="All users — search…"
                      className="flex-1 bg-transparent outline-none text-text-primary placeholder:text-text-tertiary min-w-0"
                    />
                    {userFilter && (
                      <button
                        type="button"
                        onClick={() => { setUserFilter(''); setUserQuery(''); setUserOpen(false); }}
                        className="text-text-tertiary hover:text-danger shrink-0"
                        title="Clear user filter"
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                  {userOpen && (
                    <div className="absolute left-0 right-0 top-full mt-1 z-20 max-h-56 overflow-y-auto rounded-md border border-border-primary bg-bg-secondary shadow-dropdown">
                      <button
                        type="button"
                        onClick={() => { setUserFilter(''); setUserQuery(''); setUserOpen(false); }}
                        className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-hover border-b border-border-primary/50 text-text-secondary"
                      >
                        All users
                      </button>
                      {userMatches.length === 0 ? (
                        <div className="px-3 py-2 text-xxs text-text-tertiary">No matching user.</div>
                      ) : userMatches.map((u) => (
                        <button
                          key={u.email}
                          type="button"
                          onClick={() => { setUserFilter(u.email); setUserQuery(''); setUserOpen(false); }}
                          className={cn(
                            'w-full text-left px-3 py-1.5 hover:bg-bg-hover border-b border-border-primary/40 last:border-0',
                            u.email === userFilter && 'bg-buy/10',
                          )}
                        >
                          <span className="block text-xs text-text-primary">{u.name}</span>
                          <span className="block text-[10px] text-text-tertiary">{u.email}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <select
                  value={symbolFilter}
                  onChange={(e) => setSymbolFilter(e.target.value)}
                  className="text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md text-text-primary"
                >
                  <option value="">All instruments</option>
                  {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                {([
                  ['latest', 'Latest', Clock],
                  ['profit', 'Big profit', TrendingUp],
                  ['loss', 'Big loss', TrendingDown],
                ] as const).map(([key, label, Icon]) => (
                  <button
                    key={key}
                    onClick={() => setSort(key)}
                    className={cn(
                      'inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xxs font-medium border transition-fast',
                      sort === key
                        ? key === 'profit' ? 'bg-success/15 text-success border-success/40'
                          : key === 'loss' ? 'bg-danger/15 text-danger border-danger/40'
                          : 'bg-buy/15 text-buy border-buy/40'
                        : 'bg-bg-input text-text-secondary border-border-primary hover:bg-bg-hover',
                    )}
                  >
                    <Icon size={12} /> {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="bg-bg-tertiary/40">
                  <tr className="text-xxs uppercase text-text-tertiary">
                    <th className="px-3 py-2">User</th>
                    <th className="px-3 py-2">Account</th>
                    <th className="px-3 py-2">Instrument</th>
                    <th className="px-3 py-2">Side</th>
                    <th className="px-3 py-2 text-right">Lots</th>
                    <th className="px-3 py-2 text-right">Entry</th>
                    <th className="px-3 py-2 text-right">Current</th>
                    <th className="px-3 py-2 text-right">Running P&L</th>
                    <th className="px-3 py-2">Opened</th>
                  </tr>
                </thead>
                <tbody>
                  {!visibleTrades.length ? (
                    <tr><td colSpan={9} className="px-4 py-6 text-center text-xxs text-text-tertiary">No running trades{userFilter ? ' for this user' : symbolFilter ? ` for ${symbolFilter}` : ''}.</td></tr>
                  ) : visibleTrades.map((t) => (
                    <tr key={t.position_id} className="border-t border-border-primary/50 text-xs hover:bg-bg-hover/30">
                      <td className="px-3 py-2">
                        <span className="text-text-primary">{t.user_name}</span>
                        {t.is_demo && <span className="ml-1.5 text-[9px] px-1.5 py-0.5 rounded bg-warning/15 text-warning font-semibold uppercase">Demo</span>}
                        {t.is_promotional && <span className="ml-1.5 text-[9px] px-1.5 py-0.5 rounded bg-buy/15 text-buy font-semibold uppercase">Promo</span>}
                        <span className="block text-[10px] text-text-tertiary">{t.user_email}</span>
                      </td>
                      <td className="px-3 py-2 font-mono text-text-secondary">{t.account_number}</td>
                      <td className="px-3 py-2 font-semibold text-text-primary">{t.symbol}</td>
                      <td className="px-3 py-2">
                        <span className={cn('text-[10px] px-2 py-0.5 rounded-md font-bold uppercase', t.side === 'buy' ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger')}>
                          {t.side}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-text-primary">{t.lots.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-text-secondary">{t.open_price}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-text-secondary">{t.current_price ?? '—'}</td>
                      <td className={cn('px-3 py-2 text-right font-mono tabular-nums font-bold', pnlClass(t.pnl))}>{fmtMoney(t.pnl)}</td>
                      <td className="px-3 py-2 text-[11px] text-text-tertiary whitespace-nowrap">
                        {t.opened_at ? new Date(t.opened_at).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
