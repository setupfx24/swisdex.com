'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { adminApi } from '@/lib/api';
import DateField from '@/components/ui/DateField';
import toast from 'react-hot-toast';
import Link from 'next/link';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Edit3,
  Loader2,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { Download as DownloadIcon } from 'lucide-react';
import { downloadAdminReportPdf } from '@/lib/pdf/adminReportPdf';

interface Position {
  id: string;
  account_id: string;
  instrument_symbol: string;
  side: string;
  status: string;
  lots: number;
  open_price: number;
  close_price?: number;
  stop_loss?: number;
  take_profit?: number;
  swap: number;
  commission: number;
  profit: number;
  comment?: string;
  is_admin_modified: boolean;
  created_at: string;
  user_email?: string;
  account_number?: string;
  book_type?: string;
  is_demo?: boolean;
  is_lp_forwarded?: boolean;
}

interface PendingOrder {
  id: string;
  account_id: string;
  instrument_symbol: string;
  order_type: string;
  side: string;
  status: string;
  lots: number;
  price?: number;
  stop_loss?: number;
  take_profit?: number;
  filled_price?: number;
  commission: number;
  swap: number;
  comment?: string;
  is_admin_created: boolean;
  created_at: string;
  user_email?: string;
  account_number?: string;
}

interface ClosedTrade {
  id: string;
  user_email: string;
  account_number: string;
  instrument_symbol: string;
  side: string;
  lots: number;
  open_price: number;
  close_price: number;
  profit: number;
  close_reason: string;
  closed_at: string;
}

type TabId = 'open' | 'pending' | 'history';
type ModalType = 'modify' | 'close' | 'create' | null;

const TABS: { id: TabId; label: string }[] = [
  { id: 'open', label: 'Open Positions' },
  { id: 'pending', label: 'Pending Orders' },
  { id: 'history', label: 'Trade History' },
];

function formatMoney(n: number | undefined | null) {
  if (n == null) return '0.00';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(d: string | undefined | null) {
  if (!d) return '—';
  try { return new Date(d).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return d; }
}

function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode; wide?: boolean }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center animate-fade-in">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className={cn('relative bg-bg-secondary border border-border-primary rounded-md shadow-modal mx-4 p-5 animate-slide-down w-full', wide ? 'max-w-xl' : 'max-w-md')}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-bg-hover transition-fast text-text-tertiary hover:text-text-primary"><X size={14} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function TableSkeleton({ cols }: { cols: number }) {
  return (
    <div className="animate-pulse">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3 border-b border-border-primary/30">
          {Array.from({ length: cols }).map((_, j) => (
            <div key={j} className="h-3 bg-bg-hover rounded" style={{ width: `${60 + Math.random() * 40}px` }} />
          ))}
        </div>
      ))}
    </div>
  );
}

type Tick = { bid: number; ask: number };

export default function TradesPage() {
  const [activeTab, setActiveTab] = useState<TabId>('open');
  const [searchFilter, setSearchFilter] = useState('');
  const [symbolFilter, setSymbolFilter] = useState('');
  // Custom date range + gainers/losers sort (client 2026-06-12).
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sortMode, setSortMode] = useState<'recent' | 'gainers' | 'losers'>('recent');

  const [positions, setPositions] = useState<Position[]>([]);
  const [posPage, setPosPage] = useState(1);
  const [posPages, setPosPages] = useState(1);
  const [posTotal, setPosTotal] = useState(0);
  const [posLoading, setPosLoading] = useState(true);

  const [orders, setOrders] = useState<PendingOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersTotal, setOrdersTotal] = useState(0);

  const [history, setHistory] = useState<ClosedTrade[]>([]);
  const [histPage, setHistPage] = useState(1);
  const [histPages, setHistPages] = useState(1);
  const [histTotal, setHistTotal] = useState(0);
  const [histLoading, setHistLoading] = useState(false);

  const [openActionsId, setOpenActionsId] = useState<string | null>(null);

  const pricesRef = useRef<Record<string, Tick>>({});
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const wsUrl = (process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:8000').replace('http', 'ws');
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      ws = new WebSocket(`${wsUrl}/ws/prices`);
      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.symbol && data.bid && data.ask) {
            pricesRef.current[data.symbol] = { bid: parseFloat(data.bid), ask: parseFloat(data.ask) };
          }
        } catch {}
      };
      ws.onclose = () => { reconnectTimer = setTimeout(connect, 3000); };
      ws.onerror = () => ws?.close();
    }
    connect();

    const tickRender = setInterval(() => forceUpdate(n => n + 1), 1000);

    return () => {
      ws?.close();
      clearTimeout(reconnectTimer);
      clearInterval(tickRender);
    };
  }, []);

  const [modalType, setModalType] = useState<ModalType>(null);
  const [selectedPosition, setSelectedPosition] = useState<Position | null>(null);
  const [modifySl, setModifySl] = useState('');
  const [modifyTp, setModifyTp] = useState('');
  const [modifyOpenPrice, setModifyOpenPrice] = useState('');
  const [modifyLots, setModifyLots] = useState('');
  const [modifyCommission, setModifyCommission] = useState('');
  const [modifySwap, setModifySwap] = useState('');
  const [modifyOpenTime, setModifyOpenTime] = useState('');
  const [actionReason, setActionReason] = useState('');
  const [modalSubmitting, setModalSubmitting] = useState(false);

  // Create trade modal state
  const [createUserSearch, setCreateUserSearch] = useState('');
  const [createUsers, setCreateUsers] = useState<{ id: string; name: string; email: string; accounts?: { id: string; name: string }[] }[]>([]);
  const [createSelectedUser, setCreateSelectedUser] = useState<{ id: string; name: string; email: string; accounts?: { id: string; name: string }[] } | null>(null);
  const [createAccountId, setCreateAccountId] = useState('');
  const [createSymbol, setCreateSymbol] = useState('');
  const [createInstrumentId, setCreateInstrumentId] = useState('');
  const [instrumentSearch, setInstrumentSearch] = useState('');
  const [instruments, setInstruments] = useState<{ id: string; symbol: string; display_name: string; segment: string }[]>([]);
  const [showInstrumentDropdown, setShowInstrumentDropdown] = useState(false);
  const [createSide, setCreateSide] = useState<'buy' | 'sell'>('buy');
  const [createType, setCreateType] = useState('market');
  const [createLots, setCreateLots] = useState('');
  const [createPrice, setCreatePrice] = useState('');
  const [createSl, setCreateSl] = useState('');
  const [createTp, setCreateTp] = useState('');
  const [createReason, setCreateReason] = useState('');
  const [userSearchLoading, setUserSearchLoading] = useState(false);

  /** Full fetch with loading spinner — only on initial load or manual refresh. */
  const fetchPositions = useCallback(async (silent = false) => {
    if (!silent) setPosLoading(true);
    try {
      const params: Record<string, string> = { page: String(posPage), limit: '20', sort: sortMode };
      if (dateFrom) params.start_date = dateFrom;
      if (dateTo) params.end_date = dateTo;
      const data = await adminApi.get<any>('/trades/positions', params);
      setPositions(data.items || data.positions || []);
      setPosTotal(data.total || 0);
      setPosPages(data.pages || Math.ceil((data.total || 0) / 20) || 1);
    } catch (e) {
      if (!silent) toast.error(e instanceof Error ? e.message : 'Failed to load positions');
    } finally {
      if (!silent) setPosLoading(false);
    }
  }, [posPage, dateFrom, dateTo, sortMode]);

  const fetchOrders = useCallback(async (silent = false) => {
    if (!silent) setOrdersLoading(true);
    try {
      const data = await adminApi.get<any>('/trades/orders', { status: 'pending' });
      setOrders(data.items || data.orders || []);
      setOrdersTotal(data.total || 0);
    } catch (e) {
      if (!silent) toast.error(e instanceof Error ? e.message : 'Failed to load orders');
    } finally {
      if (!silent) setOrdersLoading(false);
    }
  }, []);

  const fetchHistory = useCallback(async (silent = false) => {
    if (!silent) setHistLoading(true);
    try {
      const params: Record<string, string> = { page: String(histPage), limit: '20', sort: sortMode };
      if (dateFrom) params.start_date = dateFrom;
      if (dateTo) params.end_date = dateTo;
      const data = await adminApi.get<any>('/trades/history', params);
      setHistory(data.items || data.trades || []);
      setHistTotal(data.total || 0);
      setHistPages(data.pages || Math.ceil((data.total || 0) / 20) || 1);
    } catch (e) {
      if (!silent) toast.error(e instanceof Error ? e.message : 'Failed to load history');
    } finally {
      if (!silent) setHistLoading(false);
    }
  }, [histPage, dateFrom, dateTo, sortMode]);

  /** Initial load — shows spinner. */
  useEffect(() => {
    if (activeTab === 'open') fetchPositions(false);
    else if (activeTab === 'pending') fetchOrders(false);
    else fetchHistory(false);
  }, [activeTab, fetchPositions, fetchOrders, fetchHistory]);

  /** Silent background poll every 5s — no spinner, no flicker, data just updates. */
  useEffect(() => {
    const poll = setInterval(() => {
      if (activeTab === 'open') fetchPositions(true);
      else if (activeTab === 'pending') fetchOrders(true);
      else fetchHistory(true);
    }, 5000);
    return () => clearInterval(poll);
  }, [activeTab, fetchPositions, fetchOrders, fetchHistory]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-actions-menu]')) setOpenActionsId(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const openModifyModal = (pos: Position) => {
    setSelectedPosition(pos);
    setModifySl(pos.stop_loss ? String(pos.stop_loss) : '');
    setModifyTp(pos.take_profit ? String(pos.take_profit) : '');
    setModifyOpenPrice(pos.open_price ? String(pos.open_price) : '');
    setModifyLots(pos.lots ? String(pos.lots) : '');
    setModifyCommission(pos.commission ? String(pos.commission) : '');
    setModifySwap(pos.swap ? String(pos.swap) : '');
    setModifyOpenTime(pos.created_at ? new Date(pos.created_at).toISOString().slice(0, 16) : '');
    setActionReason('');
    setModalType('modify');
    setOpenActionsId(null);
  };

  const openCloseModal = (pos: Position) => {
    setSelectedPosition(pos);
    setActionReason('');
    setModalType('close');
    setOpenActionsId(null);
  };

  const openCreateModal = () => {
    setCreateUserSearch('');
    setCreateUsers([]);
    setCreateSelectedUser(null);
    setCreateAccountId('');
    setCreateSymbol('');
    setCreateInstrumentId('');
    setInstrumentSearch('');
    setShowInstrumentDropdown(false);
    setCreateSide('buy');
    setCreateType('market');
    setCreateLots('');
    setCreatePrice('');
    setCreateSl('');
    setCreateTp('');
    setCreateReason('');
    setModalType('create');
    fetchInstruments();
  };

  const fetchInstruments = async () => {
    try {
      const data = await adminApi.get<{ items: typeof instruments }>('/trades/instruments');
      setInstruments(data.items || []);
    } catch { /* silent */ }
  };

  const selectInstrument = (inst: typeof instruments[0]) => {
    setCreateSymbol(inst.symbol);
    setCreateInstrumentId(inst.id);
    setInstrumentSearch('');
    setShowInstrumentDropdown(false);
  };

  const closeModal = () => { setModalType(null); setSelectedPosition(null); };

  const submitModify = async () => {
    if (!selectedPosition) return;
    setModalSubmitting(true);
    try {
      const body: Record<string, unknown> = { reason: actionReason };
      if (modifySl) body.stop_loss = parseFloat(modifySl);
      if (modifyTp) body.take_profit = parseFloat(modifyTp);
      if (modifyOpenPrice) body.open_price = parseFloat(modifyOpenPrice);
      if (modifyLots) body.lots = parseFloat(modifyLots);
      if (modifyCommission) body.commission = parseFloat(modifyCommission);
      if (modifySwap) body.swap = parseFloat(modifySwap);
      if (modifyOpenTime) body.open_time = new Date(modifyOpenTime).toISOString();
      await adminApi.put(`/trades/position/${selectedPosition.id}/modify`, body);
      toast.success('Position modified');
      closeModal();
      fetchPositions();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Modify failed');
    } finally {
      setModalSubmitting(false);
    }
  };

  const submitClose = async () => {
    if (!selectedPosition) return;
    setModalSubmitting(true);
    try {
      await adminApi.post(`/trades/position/${selectedPosition.id}/close`, { reason: actionReason });
      toast.success('Position closed');
      closeModal();
      fetchPositions();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Close failed');
    } finally {
      setModalSubmitting(false);
    }
  };

  const searchUsers = async (q: string) => {
    setCreateUserSearch(q);
    if (q.length < 2) { setCreateUsers([]); return; }
    setUserSearchLoading(true);
    try {
      const data = await adminApi.get<{ users: typeof createUsers }>('/users', { search: q, per_page: '10' });
      setCreateUsers(data.users || []);
    } catch { /* silent */ } finally {
      setUserSearchLoading(false);
    }
  };

  const selectUserForTrade = async (u: typeof createUsers[0]) => {
    setCreateUsers([]);
    setCreateUserSearch('');
    try {
      const detail = await adminApi.get<any>(`/users/${u.id}`);
      const rawAccounts: any[] = detail.accounts || [];
      const mapped = rawAccounts.map((a: any) => ({ id: a.id, name: `${a.account_number}${a.is_demo ? ' (Demo)' : ''} — $${Number(a.balance || 0).toLocaleString()}` }));
      setCreateSelectedUser({ ...u, accounts: mapped });
      const live = rawAccounts.find((a: any) => !a.is_demo);
      setCreateAccountId(live ? live.id : rawAccounts[0]?.id || '');
    } catch {
      setCreateSelectedUser(u);
    }
  };

  const submitCreateTrade = async () => {
    if (!createSelectedUser) { toast.error('Select a user'); return; }
    if (!createAccountId) { toast.error('Select an account'); return; }
    if (!createSymbol) { toast.error('Enter a symbol'); return; }
    if (!createLots || parseFloat(createLots) <= 0) { toast.error('Enter valid lots'); return; }
    if (!createReason) { toast.error('Reason is required'); return; }
    if (createType !== 'market' && !createPrice) { toast.error('Price required for non-market orders'); return; }

    setModalSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        account_id: createAccountId,
        symbol: createSymbol.replace('/', '').toUpperCase(),
        side: createSide,
        lots: parseFloat(createLots),
        comment: createReason,
      };
      if (createInstrumentId) body.instrument_id = createInstrumentId;
      if (createPrice) body.price = parseFloat(createPrice);
      if (createSl) body.stop_loss = parseFloat(createSl);
      if (createTp) body.take_profit = parseFloat(createTp);

      await adminApi.post('/trades/create', body);
      toast.success('Trade created successfully');
      closeModal();
      fetchPositions();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create trade');
    } finally {
      setModalSubmitting(false);
    }
  };

  const Pagination = ({ page, pages: totalPages, total, onPageChange }: { page: number; pages: number; total: number; onPageChange: (p: number) => void }) => {
    if (totalPages <= 1) return null;
    return (
      <div className="flex items-center justify-between px-4 py-3 border-t border-border-primary">
        <p className="text-xxs text-text-tertiary">Page {page} of {totalPages} &middot; {total} records</p>
        <div className="flex items-center gap-1">
          <button disabled={page <= 1} onClick={() => onPageChange(page - 1)} className={cn('p-1.5 rounded-md border border-border-primary text-text-secondary transition-fast', page <= 1 ? 'opacity-40 cursor-not-allowed' : 'hover:bg-bg-hover')}>
            <ChevronLeft size={14} />
          </button>
          {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
            let p: number;
            if (totalPages <= 5) p = i + 1;
            else if (page <= 3) p = i + 1;
            else if (page >= totalPages - 2) p = totalPages - 4 + i;
            else p = page - 2 + i;
            return (
              <button key={p} onClick={() => onPageChange(p)} className={cn('min-w-[28px] h-7 px-1 rounded-md text-xs font-medium transition-fast', page === p ? 'bg-buy/15 text-buy border border-buy/30' : 'text-text-secondary hover:bg-bg-hover')}>
                {p}
              </button>
            );
          })}
          <button disabled={page >= totalPages} onClick={() => onPageChange(page + 1)} className={cn('p-1.5 rounded-md border border-border-primary text-text-secondary transition-fast', page >= totalPages ? 'opacity-40 cursor-not-allowed' : 'hover:bg-bg-hover')}>
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
    );
  };

  // Export the active tab (open positions or closed history) to PDF, with the
  // date-range filter + total P&L summary (client 2026-06-20).
  const exportTradesPdf = () => {
    const period = (dateFrom || dateTo) ? `${dateFrom || 'start'} → ${dateTo || 'today'}` : 'All time';
    if (activeTab === 'history') {
      if (!history.length) return;
      const totalPnl = history.reduce((s, t) => s + (Number(t.profit) || 0), 0);
      void downloadAdminReportPdf(
        'Closed trades report',
        [
          { header: 'Closed', width: 34 }, { header: 'User', width: 50 },
          { header: 'Symbol', width: 22 }, { header: 'Side', width: 14 },
          { header: 'Lots', width: 16, align: 'right', mono: true },
          { header: 'Open', width: 22, align: 'right', mono: true },
          { header: 'Close', width: 22, align: 'right', mono: true },
          { header: 'P&L (USD)', width: 24, align: 'right', mono: true },
        ],
        history.map(t => [
          (t.closed_at || '').replace('T', ' ').slice(0, 16), t.user_email || '—',
          t.instrument_symbol, (t.side || '').toUpperCase(), String(t.lots),
          String(t.open_price), String(t.close_price),
          `$${(Number(t.profit) || 0).toFixed(2)}`,
        ]),
        {
          subtitle: 'Closed trades', periodLabel: period,
          summaryLines: [`Trades: ${history.length}`, `Total realized P&L: $${totalPnl.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`],
          filename: 'closed-trades-report',
        },
      );
    } else {
      if (!positions.length) return;
      const totalPnl = positions.reduce((s, p) => s + (Number(p.profit) || 0), 0);
      void downloadAdminReportPdf(
        'Open positions report',
        [
          { header: 'Opened', width: 34 }, { header: 'User', width: 50 },
          { header: 'Symbol', width: 22 }, { header: 'Side', width: 14 },
          { header: 'Lots', width: 16, align: 'right', mono: true },
          { header: 'Open', width: 22, align: 'right', mono: true },
          { header: 'P&L (USD)', width: 24, align: 'right', mono: true },
        ],
        positions.map(p => [
          (p.created_at || '').replace('T', ' ').slice(0, 16), p.user_email || '—',
          p.instrument_symbol, (p.side || '').toUpperCase(), String(p.lots),
          String(p.open_price), `$${(Number(p.profit) || 0).toFixed(2)}`,
        ]),
        {
          subtitle: 'Open positions', periodLabel: period,
          summaryLines: [`Positions: ${positions.length}`, `Total floating P&L: $${totalPnl.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`],
          filename: 'open-positions-report',
        },
      );
    }
  };

  return (
    <>
      <div className="p-6 space-y-4">
        {/* Header */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-lg font-semibold text-text-primary">Trades</h1>
            <p className="text-xxs text-text-tertiary mt-0.5">Positions, pending orders, and history</p>
          </div>
          <div className="flex items-center gap-2">
            {(activeTab === 'open' || activeTab === 'history') && (
              <button type="button" onClick={exportTradesPdf} className={cn(
                'inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md border',
                'bg-bg-secondary text-xs font-medium text-text-secondary border-border-primary transition-fast hover:bg-bg-hover hover:text-text-primary',
              )} title="Download the current tab (with date filter) as PDF">
                <DownloadIcon size={14} className="text-buy" /> Download PDF
              </button>
            )}
            <Link href="/trades/create" className={cn(
              'inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md border',
              'bg-bg-secondary text-xs font-medium text-text-secondary border-border-primary transition-fast hover:bg-bg-hover hover:text-text-primary',
            )}>
              Full Form
            </Link>
            <button type="button" onClick={openCreateModal} className={cn(
              'inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md border border-buy/30',
              'bg-buy/15 text-xs font-medium text-buy transition-fast hover:bg-buy/25',
            )}>
              <Plus size={14} /> Create Trade
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3">
          <div className="relative max-w-xs">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
            <input type="search" value={searchFilter} onChange={e => setSearchFilter(e.target.value)} placeholder="Filter by user..." className="w-full pl-9 pr-3 py-1.5 text-xs bg-bg-input border border-border-primary rounded-md placeholder:text-text-tertiary focus:border-buy transition-fast" />
          </div>
          <input type="text" value={symbolFilter} onChange={e => setSymbolFilter(e.target.value)} placeholder="Symbol..." className="w-28 px-3 py-1.5 text-xs bg-bg-input border border-border-primary rounded-md placeholder:text-text-tertiary focus:border-buy transition-fast uppercase" />
          {/* Custom date range (server-side) */}
          <DateField value={dateFrom} max={dateTo || undefined} onChange={setDateFrom} />
          <DateField value={dateTo} min={dateFrom || undefined} onChange={setDateTo} />
          {/* Top gainers / losers */}
          <select value={sortMode} onChange={e => setSortMode(e.target.value as 'recent' | 'gainers' | 'losers')} className="px-2 py-1.5 text-xs bg-bg-input border border-border-primary rounded-md text-text-primary focus:border-buy transition-fast">
            <option value="recent">Most recent</option>
            <option value="gainers">Top gainers</option>
            <option value="losers">Top losers</option>
          </select>
          {(dateFrom || dateTo || sortMode !== 'recent') && (
            <button type="button" onClick={() => { setDateFrom(''); setDateTo(''); setSortMode('recent'); }} className="px-2 py-1.5 text-xs text-text-secondary border border-border-primary rounded-md hover:bg-bg-hover">Clear</button>
          )}
        </div>

        {/* Tabs & Tables */}
        <div className="bg-bg-secondary border border-border-primary rounded-md">
          <div className="flex flex-wrap gap-1 p-1 border-b border-border-primary">
            {TABS.map(t => (
              <button key={t.id} type="button" onClick={() => setActiveTab(t.id)} className={cn(
                'px-3 py-1.5 rounded-md text-xs font-medium transition-fast',
                activeTab === t.id ? 'bg-bg-hover text-text-primary border border-border-primary' : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover/60',
              )}>
                {t.label}
                {t.id === 'open' && posTotal > 0 && <span className="ml-1.5 px-1 py-0.5 text-xxs bg-buy/15 text-buy rounded-sm tabular-nums">{posTotal}</span>}
                {t.id === 'pending' && ordersTotal > 0 && <span className="ml-1.5 px-1 py-0.5 text-xxs bg-warning/15 text-warning rounded-sm tabular-nums">{ordersTotal}</span>}
              </button>
            ))}
          </div>

          {/* Open Positions */}
          {activeTab === 'open' && (
            <div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border-primary bg-bg-tertiary/40">
                      {['User', 'Symbol', 'Side', 'Lots', 'Open', 'Current', 'Spread', 'P&L', 'Comm.', 'SL', 'TP', 'Opened', ''].map(c => (
                        <th key={c} className="text-left px-3 py-2 text-xxs font-medium text-text-tertiary uppercase tracking-wide whitespace-nowrap">{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {!posLoading && positions
                      .filter(p => {
                        if (searchFilter && !`${p.user_email || ''} ${p.account_number || ''}`.toLowerCase().includes(searchFilter.toLowerCase())) return false;
                        if (symbolFilter && !p.instrument_symbol?.toLowerCase().includes(symbolFilter.toLowerCase())) return false;
                        return true;
                      })
                      .map(p => {
                      const tick = p.instrument_symbol ? pricesRef.current[p.instrument_symbol] : null;
                      const isBuy = p.side?.toLowerCase() === 'buy';
                      const currentPrice = tick ? (isBuy ? tick.bid : tick.ask) : null;
                      const spread = tick ? ((tick.ask - tick.bid) * 100000).toFixed(1) : '—';
                      const contractSize = p.instrument_symbol?.match(/BTC|ETH/) ? 1
                        : p.instrument_symbol?.match(/XAU/) ? 100
                        : p.instrument_symbol?.match(/XAG/) ? 50
                        : p.instrument_symbol?.match(/OIL/) ? 1000
                        : p.instrument_symbol?.match(/US30|US500|NAS/) ? 1
                        : 100000;
                      const livePnl = currentPrice
                        ? (isBuy ? (currentPrice - p.open_price) : (p.open_price - currentPrice)) * p.lots * contractSize
                        : p.profit || 0;
                      return (
                      <tr key={p.id} className={cn('border-b border-border-primary/50 transition-fast hover:bg-bg-hover', livePnl > 0 && 'bg-success/[0.03]', livePnl < 0 && 'bg-danger/[0.03]')}>
                        <td className="px-3 py-2 text-xs text-text-primary truncate max-w-[160px]" title={p.user_email || ''}>{p.user_email || p.account_number || '—'}</td>
                        <td className="px-3 py-2 text-xs text-text-primary font-semibold">{p.instrument_symbol}</td>
                        <td className="px-3 py-2"><span className={cn('text-xs font-bold', isBuy ? 'text-buy' : 'text-sell')}>{p.side?.toUpperCase()}</span></td>
                        <td className="px-3 py-2 text-xs text-text-primary font-mono tabular-nums">{p.lots}</td>
                        <td className="px-3 py-2 text-xs text-text-secondary font-mono tabular-nums">{p.open_price}</td>
                        <td className="px-3 py-2 text-xs text-text-primary font-mono tabular-nums font-medium">{currentPrice?.toFixed(5) || '—'}</td>
                        <td className="px-3 py-2 text-xxs text-text-tertiary font-mono tabular-nums">{spread}</td>
                        <td className={cn('px-3 py-2 text-xs font-mono tabular-nums font-bold', livePnl >= 0 ? 'text-success' : 'text-danger')}>
                          {livePnl >= 0 ? '+' : ''}{formatMoney(livePnl)}
                        </td>
                        <td className="px-3 py-2 text-xxs text-text-tertiary font-mono tabular-nums">{p.commission ? formatMoney(p.commission) : '0'}</td>
                        <td className="px-3 py-2 text-xs text-sell font-mono tabular-nums">{p.stop_loss || '—'}</td>
                        <td className="px-3 py-2 text-xs text-buy font-mono tabular-nums">{p.take_profit || '—'}</td>
                        <td className="px-3 py-2 text-xxs text-text-tertiary whitespace-nowrap">{formatDate(p.created_at)}</td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <div className="flex items-center gap-1">
                            {p.is_lp_forwarded ? (
                              <span
                                className="px-2 py-1 text-xxs font-bold uppercase tracking-wide text-info bg-info/10 border border-info/30 rounded"
                                title="A-book trade — forwarded to LP, admin cannot edit"
                              >
                                A-book · LP
                              </span>
                            ) : (
                              <button onClick={() => openModifyModal(p)} className="px-2 py-1 text-xxs font-medium text-text-secondary bg-bg-hover border border-border-primary rounded hover:text-buy hover:border-buy/30 transition-fast" title="Edit Trade">
                                <Edit3 size={11} className="inline mr-0.5" />Edit
                              </button>
                            )}
                            <button onClick={() => openCloseModal(p)} className="px-2 py-1 text-xxs font-medium text-sell bg-sell/10 border border-sell/20 rounded hover:bg-sell/20 transition-fast" title="Close Position">
                              <Trash2 size={11} className="inline mr-0.5" />Close
                            </button>
                          </div>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {posLoading && <TableSkeleton cols={13} />}
              {!posLoading && positions.length === 0 && (
                <div className="px-4 py-12 text-center text-xs text-text-tertiary">No open positions</div>
              )}
              <Pagination page={posPage} pages={posPages} total={posTotal} onPageChange={setPosPage} />
            </div>
          )}

          {/* Pending Orders */}
          {activeTab === 'pending' && (
            <div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px]">
                  <thead>
                    <tr className="border-b border-border-primary bg-bg-tertiary/40">
                      {['ID', 'User', 'Symbol', 'Side', 'Type', 'Lots', 'Price', 'Trigger', 'Status', 'Created'].map(c => (
                        <th key={c} className={cn('text-left px-4 py-2.5 text-xxs font-medium text-text-tertiary uppercase tracking-wide', ['Lots', 'Price', 'Trigger'].includes(c) && 'text-right')}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {!ordersLoading && orders
                      .filter(o => {
                        if (searchFilter && !`${o.user_email || ''} ${o.account_number || ''}`.toLowerCase().includes(searchFilter.toLowerCase())) return false;
                        if (symbolFilter && !o.instrument_symbol?.toLowerCase().includes(symbolFilter.toLowerCase())) return false;
                        return true;
                      })
                      .map(o => (
                      <tr key={o.id} className="border-b border-border-primary/50 transition-fast hover:bg-bg-hover">
                        <td className="px-4 py-2.5 text-xxs text-text-tertiary font-mono tabular-nums">{o.id.slice(0, 8)}</td>
                        <td className="px-4 py-2.5 text-xs text-text-primary">{o.user_email || o.account_number || '—'}</td>
                        <td className="px-4 py-2.5 text-xs text-text-primary font-medium">{o.instrument_symbol}</td>
                        <td className="px-4 py-2.5"><span className={cn('text-xs font-medium', o.side?.toLowerCase() === 'buy' ? 'text-buy' : 'text-sell')}>{o.side?.toUpperCase()}</span></td>
                        <td className="px-4 py-2.5 text-xs text-text-secondary capitalize">{o.order_type?.replace('_', ' ')}</td>
                        <td className="px-4 py-2.5 text-xs text-text-primary text-right font-mono tabular-nums">{o.lots}</td>
                        <td className="px-4 py-2.5 text-xs text-text-secondary text-right font-mono tabular-nums">{o.price || '—'}</td>
                        <td className="px-4 py-2.5 text-xs text-text-secondary text-right font-mono tabular-nums">{o.filled_price || '—'}</td>
                        <td className="px-4 py-2.5"><span className={cn('inline-flex px-1.5 py-0.5 rounded-sm text-xxs font-medium bg-warning/15 text-warning')}>{o.status}</span></td>
                        <td className="px-4 py-2.5 text-xxs text-text-tertiary font-mono tabular-nums">{formatDate(o.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {ordersLoading && <TableSkeleton cols={10} />}
              {!ordersLoading && orders.length === 0 && (
                <div className="px-4 py-12 text-center text-xs text-text-tertiary">No pending orders</div>
              )}
            </div>
          )}

          {/* Trade History */}
          {activeTab === 'history' && (
            <div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[920px]">
                  <thead>
                    <tr className="border-b border-border-primary bg-bg-tertiary/40">
                      {['Closed', 'User', 'Symbol', 'Side', 'Lots', 'Open', 'Close', 'P&L', 'Reason'].map(c => (
                        <th key={c} className={cn('text-left px-4 py-2.5 text-xxs font-medium text-text-tertiary uppercase tracking-wide', ['Lots', 'Open', 'Close', 'P&L'].includes(c) && 'text-right')}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {!histLoading && history
                      .filter(t => {
                        if (searchFilter && !`${t.user_email || ''} ${t.account_number || ''}`.toLowerCase().includes(searchFilter.toLowerCase())) return false;
                        if (symbolFilter && !t.instrument_symbol?.toLowerCase().includes(symbolFilter.toLowerCase())) return false;
                        return true;
                      })
                      .map(t => {
                      const reason = t.close_reason || 'manual';
                      const reasonLabel = reason === 'sl' ? 'SL' : reason === 'tp' ? 'TP' : reason === 'admin' ? 'Admin' : 'Manual';
                      const reasonColor = reason === 'sl' ? 'bg-danger/15 text-danger' : reason === 'tp' ? 'bg-success/15 text-success' : reason === 'admin' ? 'bg-warning/15 text-warning' : 'bg-text-tertiary/15 text-text-tertiary';
                      return (
                      <tr key={t.id} className="border-b border-border-primary/50 transition-fast hover:bg-bg-hover">
                        <td className="px-4 py-2.5 text-xxs text-text-tertiary font-mono tabular-nums">{formatDate(t.closed_at)}</td>
                        <td className="px-4 py-2.5 text-xs text-text-primary">{t.user_email || t.account_number || '—'}</td>
                        <td className="px-4 py-2.5 text-xs text-text-primary font-medium">{t.instrument_symbol}</td>
                        <td className="px-4 py-2.5"><span className={cn('text-xs font-medium', t.side?.toLowerCase() === 'buy' ? 'text-buy' : 'text-sell')}>{t.side?.toUpperCase()}</span></td>
                        <td className="px-4 py-2.5 text-xs text-text-primary text-right font-mono tabular-nums">{t.lots}</td>
                        <td className="px-4 py-2.5 text-xs text-text-secondary text-right font-mono tabular-nums">{t.open_price}</td>
                        <td className="px-4 py-2.5 text-xs text-text-secondary text-right font-mono tabular-nums">{t.close_price}</td>
                        <td className={cn('px-4 py-2.5 text-xs text-right font-mono tabular-nums font-medium', (t.profit || 0) >= 0 ? 'text-success' : 'text-danger')}>
                          {(t.profit || 0) >= 0 ? '+' : ''}{formatMoney(t.profit)}
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={cn('inline-flex px-2 py-0.5 rounded text-xxs font-semibold', reasonColor)}>{reasonLabel}</span>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {histLoading && <TableSkeleton cols={9} />}
              {!histLoading && history.length === 0 && (
                <div className="px-4 py-12 text-center text-xs text-text-tertiary">No closed trades</div>
              )}
              <Pagination page={histPage} pages={histPages} total={histTotal} onPageChange={setHistPage} />
            </div>
          )}
        </div>
      </div>

      {/* Modify Position Modal */}
      <Modal open={modalType === 'modify'} onClose={closeModal} title={`Edit — ${selectedPosition?.instrument_symbol} ${selectedPosition?.side?.toUpperCase()} ${selectedPosition?.lots} lots`} wide>
        <div className="space-y-3">
          {selectedPosition && (() => {
            const tick = selectedPosition.instrument_symbol ? pricesRef.current[selectedPosition.instrument_symbol] : null;
            const isBuy = selectedPosition.side?.toLowerCase() === 'buy';
            const cp = tick ? (isBuy ? tick.bid : tick.ask) : null;
            return (
              <div className="grid grid-cols-3 gap-2 p-3 bg-bg-tertiary/50 border border-border-primary rounded-md text-xs">
                <div><p className="text-xxs text-text-tertiary">User</p><p className="text-text-primary truncate">{selectedPosition.user_email}</p></div>
                <div><p className="text-xxs text-text-tertiary">Side</p><p className={cn('font-bold', isBuy ? 'text-buy' : 'text-sell')}>{selectedPosition.side?.toUpperCase()}</p></div>
                <div><p className="text-xxs text-text-tertiary">Current Price</p><p className="text-text-primary font-mono">{cp?.toFixed(5) || '—'}</p></div>
              </div>
            );
          })()}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xxs text-text-tertiary mb-1">Open Price</label>
              <input type="number" step="any" value={modifyOpenPrice} onChange={e => setModifyOpenPrice(e.target.value)} className="w-full px-3 py-2 text-xs bg-bg-input border border-border-primary rounded-md font-mono tabular-nums placeholder:text-text-tertiary focus:border-buy transition-fast" />
            </div>
            <div>
              <label className="block text-xxs text-text-tertiary mb-1">Lots</label>
              <input type="number" step="0.01" min="0.01" value={modifyLots} onChange={e => setModifyLots(e.target.value)} className="w-full px-3 py-2 text-xs bg-bg-input border border-border-primary rounded-md font-mono tabular-nums placeholder:text-text-tertiary focus:border-buy transition-fast" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xxs text-text-tertiary mb-1">Stop Loss</label>
              <input type="number" step="any" value={modifySl} onChange={e => setModifySl(e.target.value)} placeholder="None" className="w-full px-3 py-2 text-xs bg-bg-input border border-border-primary rounded-md font-mono tabular-nums placeholder:text-text-tertiary focus:border-sell transition-fast" />
            </div>
            <div>
              <label className="block text-xxs text-text-tertiary mb-1">Take Profit</label>
              <input type="number" step="any" value={modifyTp} onChange={e => setModifyTp(e.target.value)} placeholder="None" className="w-full px-3 py-2 text-xs bg-bg-input border border-border-primary rounded-md font-mono tabular-nums placeholder:text-text-tertiary focus:border-buy transition-fast" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xxs text-text-tertiary mb-1">Commission</label>
              <input type="number" step="any" value={modifyCommission} onChange={e => setModifyCommission(e.target.value)} placeholder="0" className="w-full px-3 py-2 text-xs bg-bg-input border border-border-primary rounded-md font-mono tabular-nums placeholder:text-text-tertiary focus:border-buy transition-fast" />
            </div>
            <div>
              <label className="block text-xxs text-text-tertiary mb-1">Swap</label>
              <input type="number" step="any" value={modifySwap} onChange={e => setModifySwap(e.target.value)} placeholder="0" className="w-full px-3 py-2 text-xs bg-bg-input border border-border-primary rounded-md font-mono tabular-nums placeholder:text-text-tertiary focus:border-buy transition-fast" />
            </div>
          </div>
          <div>
            <label className="block text-xxs text-text-tertiary mb-1">Open Time</label>
            <input type="datetime-local" value={modifyOpenTime} onChange={e => setModifyOpenTime(e.target.value)} className="w-full px-3 py-2 text-xs bg-bg-input border border-border-primary rounded-md text-text-primary focus:border-buy transition-fast" />
          </div>
          <div>
            <label className="block text-xxs text-text-tertiary mb-1">Reason</label>
            <textarea value={actionReason} onChange={e => setActionReason(e.target.value)} rows={2} placeholder="Reason for modification..." className="w-full px-3 py-2 text-xs bg-bg-input border border-border-primary rounded-md placeholder:text-text-tertiary focus:border-buy transition-fast resize-none" />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={closeModal} className="px-3 py-1.5 rounded-md text-xs font-medium text-text-secondary border border-border-primary hover:bg-bg-hover transition-fast">Cancel</button>
            <button onClick={submitModify} disabled={modalSubmitting} className="px-4 py-1.5 rounded-md text-xs font-medium bg-buy text-white hover:bg-buy-light disabled:opacity-50 transition-fast">
              {modalSubmitting ? <Loader2 size={14} className="animate-spin" /> : 'Save Changes'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Close Position Modal */}
      <Modal open={modalType === 'close'} onClose={closeModal} title={`Close — ${selectedPosition?.instrument_symbol} ${selectedPosition?.side?.toUpperCase()} ${selectedPosition?.lots} lots`}>
        <div className="space-y-4">
          {selectedPosition && (() => {
            const tick = selectedPosition.instrument_symbol ? pricesRef.current[selectedPosition.instrument_symbol] : null;
            const isBuy = selectedPosition.side?.toLowerCase() === 'buy';
            const cp = tick ? (isBuy ? tick.bid : tick.ask) : null;
            const contractSize = selectedPosition.instrument_symbol?.match(/BTC|ETH/) ? 1
              : selectedPosition.instrument_symbol?.match(/XAU/) ? 100
              : selectedPosition.instrument_symbol?.match(/XAG/) ? 50
              : selectedPosition.instrument_symbol?.match(/OIL/) ? 1000
              : selectedPosition.instrument_symbol?.match(/US30|US500|NAS/) ? 1
              : 100000;
            const livePnl = cp ? (isBuy ? (cp - selectedPosition.open_price) : (selectedPosition.open_price - cp)) * selectedPosition.lots * contractSize : 0;
            return (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 p-3 bg-bg-tertiary/50 border border-border-primary rounded-md text-xs">
              <div><p className="text-xxs text-text-tertiary">Side</p><p className={cn('font-bold', isBuy ? 'text-buy' : 'text-sell')}>{selectedPosition.side?.toUpperCase()}</p></div>
              <div><p className="text-xxs text-text-tertiary">Lots</p><p className="text-text-primary font-mono">{selectedPosition.lots}</p></div>
              <div><p className="text-xxs text-text-tertiary">Open</p><p className="text-text-primary font-mono">{selectedPosition.open_price}</p></div>
              <div><p className="text-xxs text-text-tertiary">Current</p><p className="text-text-primary font-mono">{cp?.toFixed(5) || '—'}</p></div>
              <div><p className="text-xxs text-text-tertiary">P&L</p><p className={cn('font-mono font-bold', livePnl >= 0 ? 'text-success' : 'text-danger')}>{livePnl >= 0 ? '+' : ''}{formatMoney(livePnl)}</p></div>
              <div><p className="text-xxs text-text-tertiary">User</p><p className="text-text-primary truncate">{selectedPosition.user_email}</p></div>
              <div><p className="text-xxs text-text-tertiary">SL</p><p className="text-sell font-mono">{selectedPosition.stop_loss || '—'}</p></div>
              <div><p className="text-xxs text-text-tertiary">TP</p><p className="text-buy font-mono">{selectedPosition.take_profit || '—'}</p></div>
            </div>
            );
          })()}
          <div>
            <label className="block text-xxs text-text-tertiary mb-1">Reason</label>
            <textarea value={actionReason} onChange={e => setActionReason(e.target.value)} rows={2} placeholder="Reason for closing..." className="w-full px-3 py-2 text-xs bg-bg-input border border-border-primary rounded-md placeholder:text-text-tertiary focus:border-buy transition-fast resize-none" />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={closeModal} className="px-3 py-1.5 rounded-md text-xs font-medium text-text-secondary border border-border-primary hover:bg-bg-hover transition-fast">Cancel</button>
            <button onClick={submitClose} disabled={modalSubmitting} className="px-4 py-1.5 rounded-md text-xs font-medium bg-danger text-white hover:opacity-90 disabled:opacity-50 transition-fast">
              {modalSubmitting ? <Loader2 size={14} className="animate-spin" /> : 'Close Position'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Create Trade Modal */}
      <Modal open={modalType === 'create'} onClose={closeModal} title="Create Trade" wide>
        <div className="space-y-3">
          <div className="p-2.5 rounded-md bg-warning/10 border border-warning/20">
            <p className="text-xxs text-warning font-medium">This trade will appear as the user&apos;s own trade</p>
          </div>

          {/* User Search */}
          <div>
            <label className="block text-xxs text-text-tertiary mb-1">User</label>
            {createSelectedUser ? (
              <div className="flex items-center justify-between p-2 bg-bg-tertiary/50 border border-border-primary rounded-md">
                <div>
                  <p className="text-xs text-text-primary">{createSelectedUser.name}</p>
                  <p className="text-xxs text-text-secondary">{createSelectedUser.email}</p>
                </div>
                <button onClick={() => { setCreateSelectedUser(null); setCreateAccountId(''); }} className="p-1 rounded hover:bg-bg-hover text-text-tertiary"><X size={12} /></button>
              </div>
            ) : (
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
                <input type="text" value={createUserSearch} onChange={e => searchUsers(e.target.value)} placeholder="Search by email or name..." className="w-full pl-9 pr-3 py-2 text-xs bg-bg-input border border-border-primary rounded-md placeholder:text-text-tertiary focus:border-buy transition-fast" />
                {createUsers.length > 0 && (
                  <div className="absolute left-0 right-0 top-full mt-1 z-10 max-h-40 overflow-y-auto border border-border-primary rounded-md bg-bg-secondary shadow-dropdown">
                    {createUsers.map(u => (
                      <button key={u.id} onClick={() => selectUserForTrade(u)} className="w-full text-left px-3 py-2 text-xs hover:bg-bg-hover transition-fast border-b border-border-primary/50 last:border-0">
                        <p className="text-text-primary">{u.name}</p>
                        <p className="text-xxs text-text-tertiary">{u.email}</p>
                      </button>
                    ))}
                  </div>
                )}
                {userSearchLoading && <Loader2 size={14} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-text-tertiary" />}
              </div>
            )}
          </div>

          {/* Account */}
          {createSelectedUser && (
            <div>
              <label className="block text-xxs text-text-tertiary mb-1">Account</label>
              {createSelectedUser.accounts && createSelectedUser.accounts.length > 0 ? (
                <div className="relative">
                  <select value={createAccountId} onChange={e => setCreateAccountId(e.target.value)} className="w-full text-xs py-2 pl-3 pr-8 appearance-none bg-bg-input border border-border-primary rounded-md text-text-primary">
                    {createSelectedUser.accounts.map(a => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
                  </select>
                  <ChevronDown size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary" />
                </div>
              ) : (
                <input type="text" value={createAccountId} onChange={e => setCreateAccountId(e.target.value)} placeholder="Enter account ID" className="w-full px-3 py-2 text-xs bg-bg-input border border-border-primary rounded-md placeholder:text-text-tertiary focus:border-buy transition-fast" />
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xxs text-text-tertiary mb-1">Symbol</label>
              <div className="relative">
                {createSymbol ? (
                  <div className="flex items-center justify-between px-3 py-2 bg-bg-input border border-border-primary rounded-md">
                    <span className="text-xs text-text-primary font-semibold">{createSymbol}</span>
                    <button type="button" onClick={() => { setCreateSymbol(''); setCreateInstrumentId(''); }} className="text-text-tertiary hover:text-text-primary"><X size={12} /></button>
                  </div>
                ) : (
                  <>
                    <input
                      type="text"
                      value={instrumentSearch}
                      onChange={e => { setInstrumentSearch(e.target.value); setShowInstrumentDropdown(true); }}
                      onFocus={() => setShowInstrumentDropdown(true)}
                      placeholder="Search instruments..."
                      className="w-full px-3 py-2 text-xs bg-bg-input border border-border-primary rounded-md uppercase placeholder:text-text-tertiary focus:border-buy transition-fast"
                    />
                    {showInstrumentDropdown && (
                      <div className="absolute left-0 right-0 top-full mt-1 z-20 max-h-48 overflow-y-auto border border-border-primary rounded-md bg-bg-secondary shadow-dropdown">
                        {instruments
                          .filter(i => !instrumentSearch || i.symbol.toLowerCase().includes(instrumentSearch.toLowerCase()) || (i.display_name || '').toLowerCase().includes(instrumentSearch.toLowerCase()))
                          .map(i => (
                          <button key={i.id} type="button" onClick={() => selectInstrument(i)} className="w-full text-left px-3 py-2 text-xs hover:bg-bg-hover transition-fast border-b border-border-primary/50 last:border-0 flex items-center justify-between">
                            <span className="text-text-primary font-semibold">{i.symbol}</span>
                            <span className="text-xxs text-text-tertiary">{i.display_name} · {i.segment}</span>
                          </button>
                        ))}
                        {instruments.filter(i => !instrumentSearch || i.symbol.toLowerCase().includes(instrumentSearch.toLowerCase())).length === 0 && (
                          <p className="px-3 py-2 text-xxs text-text-tertiary">No instruments found</p>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
            <div>
              <label className="block text-xxs text-text-tertiary mb-1">Lots</label>
              <input type="number" step="0.01" min="0.01" value={createLots} onChange={e => setCreateLots(e.target.value)} placeholder="0.01" className="w-full px-3 py-2 text-xs bg-bg-input border border-border-primary rounded-md font-mono tabular-nums placeholder:text-text-tertiary focus:border-buy transition-fast" />
            </div>
          </div>

          {/* Side Toggle */}
          <div>
            <label className="block text-xxs text-text-tertiary mb-1">Side</label>
            <div className="flex gap-2">
              <button onClick={() => setCreateSide('buy')} className={cn('flex-1 py-2 rounded-md text-xs font-medium border transition-fast', createSide === 'buy' ? 'bg-buy/15 text-buy border-buy/30' : 'bg-bg-input text-text-secondary border-border-primary hover:border-border-secondary')}>Buy</button>
              <button onClick={() => setCreateSide('sell')} className={cn('flex-1 py-2 rounded-md text-xs font-medium border transition-fast', createSide === 'sell' ? 'bg-sell/15 text-sell border-sell/30' : 'bg-bg-input text-text-secondary border-border-primary hover:border-border-secondary')}>Sell</button>
            </div>
          </div>

          {/* Type */}
          <div>
            <label className="block text-xxs text-text-tertiary mb-1">Order Type</label>
            <div className="flex gap-2">
              {['market', 'limit', 'stop'].map(t => (
                <button key={t} onClick={() => setCreateType(t)} className={cn('flex-1 py-2 rounded-md text-xs font-medium border transition-fast capitalize', createType === t ? 'bg-buy/15 text-buy border-buy/30' : 'bg-bg-input text-text-secondary border-border-primary hover:border-border-secondary')}>{t}</button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xxs text-text-tertiary mb-1">
              Price {createType === 'market' && <span className="text-text-tertiary">(optional — auto from market)</span>}
            </label>
            <input type="number" step="any" value={createPrice} onChange={e => setCreatePrice(e.target.value)} placeholder={createType === 'market' ? 'Auto (live price)' : '0.00'} className="w-full px-3 py-2 text-xs bg-bg-input border border-border-primary rounded-md font-mono tabular-nums placeholder:text-text-tertiary focus:border-buy transition-fast" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xxs text-text-tertiary mb-1">Stop Loss</label>
              <input type="number" step="any" value={createSl} onChange={e => setCreateSl(e.target.value)} placeholder="Optional" className="w-full px-3 py-2 text-xs bg-bg-input border border-border-primary rounded-md font-mono tabular-nums placeholder:text-text-tertiary focus:border-buy transition-fast" />
            </div>
            <div>
              <label className="block text-xxs text-text-tertiary mb-1">Take Profit</label>
              <input type="number" step="any" value={createTp} onChange={e => setCreateTp(e.target.value)} placeholder="Optional" className="w-full px-3 py-2 text-xs bg-bg-input border border-border-primary rounded-md font-mono tabular-nums placeholder:text-text-tertiary focus:border-buy transition-fast" />
            </div>
          </div>

          <div>
            <label className="block text-xxs text-text-tertiary mb-1">Reason <span className="text-danger">*</span></label>
            <textarea value={createReason} onChange={e => setCreateReason(e.target.value)} rows={2} placeholder="Required — why this trade is being created" className="w-full px-3 py-2 text-xs bg-bg-input border border-border-primary rounded-md placeholder:text-text-tertiary focus:border-buy transition-fast resize-none" />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={closeModal} className="px-3 py-1.5 rounded-md text-xs font-medium text-text-secondary border border-border-primary hover:bg-bg-hover transition-fast">Cancel</button>
            <button onClick={submitCreateTrade} disabled={modalSubmitting} className="px-4 py-1.5 rounded-md text-xs font-medium bg-buy text-white hover:bg-buy-light disabled:opacity-50 transition-fast">
              {modalSubmitting ? <Loader2 size={14} className="animate-spin" /> : 'Create Trade'}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
