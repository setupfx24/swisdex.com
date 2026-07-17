'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTradingStore, type Position, type InstrumentInfo } from '@/stores/tradingStore';
import { clsx } from 'clsx';
import api from '@/lib/api/client';
import toast from 'react-hot-toast';
import { sounds, unlockAudio } from '@/lib/sounds';
import {
  RefreshCw,
  Download,
  Pencil,
  Check,
  X,
  ChevronDown,
  ChevronRight,
  TrendingUp,
  TrendingDown,
  Layers,
  Info,
  LayoutGrid,
  LayoutList,
  ArrowRight,
  Share2,
} from 'lucide-react';
import { ActiveAccountBadge } from '@/components/trading/ActiveAccountBadge';
import ShareTradeModal from '@/components/trading/ShareTradeModal';
import { fmtAccountMoney, isCentAccount } from '@/lib/wallet/centDisplay';

interface ClosedTrade {
  id: string;
  symbol: string;
  side: string;
  lots: number;
  open_price: number;
  close_price: number;
  pnl: number;
  commission: number;
  swap: number;
  close_time: string;
  close_reason?: string;
  trade_type?: string;
}

type CloseModal = { id: string; symbol: string; side: string; lots: number; closeLots: string } | null;
type SltpEdit = { positionId: string; sl: string; tp: string } | null;
type BulkCloseType = 'all' | 'profit' | 'loss';

type TabId = 'open' | 'pending' | 'history';

/** Maps API close_reason (sl, tp, manual, …) to a short label + badge style for history.
 *  When a trigger price is available (SL/TP hits close at the level itself), the label
 *  includes "@ <price>" so the user sees exactly where it fired. */
function closeReasonBadge(
  reason: string | null | undefined,
  triggerPrice?: number,
  digits: number = 5,
): { label: string; className: string } {
  const r = (reason || 'manual').toLowerCase();
  const priceStr = triggerPrice != null && Number.isFinite(triggerPrice)
    ? ` @ ${Number(triggerPrice).toFixed(digits)}`
    : '';
  if (r === 'sl' || r === 'stop_loss')
    return { label: `Stop loss${priceStr}`, className: 'bg-sell/15 text-sell border border-sell/25' };
  if (r === 'tp' || r === 'take_profit')
    return { label: `Take profit${priceStr}`, className: 'bg-buy/15 text-buy border border-buy/25' };
  if (r === 'admin')
    return { label: 'Admin', className: 'bg-warning/15 text-warning border border-warning/25' };
  if (r === 'margin' || r === 'liquidation' || r === 'margin_call')
    return { label: 'Margin', className: 'bg-sell/20 text-sell border border-sell/30' };
  // Treat copy_close / copy / manual / anything else as manual close for clarity.
  return { label: 'Manual close', className: 'bg-text-tertiary/15 text-text-tertiary border border-border-glass' };
}

function downloadCsv(filename: string, rows: (string | number)[][]) {
  const esc = (c: string | number) => {
    const s = String(c);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const body = rows.map((r) => r.map(esc).join(',')).join('\n');
  const blob = new Blob([body], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

type PositionsPanelProps = {
  /** Terminal: minimal borders / grid lines (clean table). */
  variant?: 'default' | 'terminal';
};

function estimatePositionMargin(
  pos: Position,
  instruments: { symbol: string; contract_size: number }[],
  leverage: number,
): number | null {
  const inst = instruments.find((i) => i.symbol === pos.symbol);
  if (!inst || !leverage) return null;
  // Use engine lots (effective_lots) so the margin / notional estimate
  // matches the backend for cent accounts. Display lots would overstate
  // it 100×. Falls back to display lots when absent (standard accounts).
  const engineLots = pos.effective_lots ?? pos.lots;
  const notional = engineLots * inst.contract_size * pos.open_price;
  return notional / leverage;
}

function formatPositionOpenedAt(iso: string | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString(undefined, {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

function partitionCloneLots(pos: Position, instruments: InstrumentInfo[]): number {
  const inst = instruments.find((i) => i.symbol === pos.symbol);
  const step = inst?.lot_step ?? 0.01;
  const minL = inst?.min_lot ?? 0.01;
  const half = pos.lots / 2;
  let snapped = Math.floor(half / step) * step;
  snapped = Number(Math.max(minL, snapped).toFixed(8));
  if (snapped >= pos.lots - 1e-12) return minL;
  return snapped;
}

/** Lots for partial close by fraction of open size, snapped to instrument lot step. */
function snapLotsForCloseFraction(
  totalLots: number,
  symbol: string,
  instruments: InstrumentInfo[],
  fraction: number,
): number {
  if (fraction >= 1 - 1e-12) return totalLots;
  const inst = instruments.find((i) => i.symbol === symbol);
  const step = inst?.lot_step ?? 0.01;
  const minL = inst?.min_lot ?? 0.01;
  const raw = totalLots * Math.min(1, Math.max(0, fraction));
  let v = Math.floor(raw / step) * step;
  v = Number(Math.max(minL, Math.min(v, totalLots)).toFixed(8));
  if (v >= totalLots - 1e-12) {
    const backoff = Number((totalLots - step).toFixed(8));
    if (backoff >= minL - 1e-12) return backoff;
    return totalLots;
  }
  return v;
}

function formatLotsInput(n: number): string {
  const r = Number(n.toFixed(8));
  return String(r);
}

/** Terminal card view: compact; close / partial close open the same modal as table layout. */
function TerminalPositionStaticCard({
  pos,
  digits,
  isCent,
  marginExposureLine,
  swapsFeeLine,
  onCloseFull,
  onPartialClose,
}: {
  pos: Position;
  digits: number;
  isCent: boolean;
  marginExposureLine: string;
  swapsFeeLine: string;
  onCloseFull: () => void;
  onPartialClose: () => void;
}) {
  const pnl = pos.profit || 0;
  const cur = pos.current_price;
  const priceDown = cur != null && (pos.side === 'buy' ? cur < pos.open_price : cur > pos.open_price);

  return (
    <div className="w-full max-w-[300px] rounded-lg border border-border-primary bg-card overflow-hidden shadow-md">
      <div className="px-2.5 pt-2 pb-2 flex justify-between gap-2 border-b border-border-primary">
        <div className="min-w-0">
          <div className="text-xs font-bold text-text-primary font-mono tracking-tight">{pos.symbol}</div>
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            <span
              className={clsx(
                'text-[9px] font-extrabold uppercase px-1.5 py-0.5 rounded',
                pos.side === 'buy' ? 'bg-[#55a630]/18 text-[#55a630]' : 'bg-[#ff5252]/18 text-[#ff5252]',
              )}
            >
              {pos.side}
            </span>
            <span className="text-[10px] text-text-tertiary tabular-nums">{pos.lots} Lots</span>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div
            className={clsx(
              'inline-block px-2 py-0.5 rounded text-[10px] font-mono font-bold tabular-nums border',
              pnl >= 0
                ? 'bg-green-500/10 border-green-500/20 text-[#55a630]'
                : 'bg-red-500/10 border-red-500/20 text-[#ff5252]',
            )}
          >
            {pnl >= 0 ? '+' : ''}{fmtAccountMoney(pnl, isCent)}
          </div>
          <div className="flex justify-end gap-0.5 mt-1">
            <span className="text-[8px] font-semibold uppercase px-1 py-0.5 rounded bg-bg-secondary text-text-tertiary">
              SL
            </span>
            <span className="text-[8px] font-semibold uppercase px-1 py-0.5 rounded bg-bg-secondary text-text-tertiary">
              TP
            </span>
          </div>
        </div>
      </div>

      <div className="px-2.5 py-1.5 flex items-start justify-between gap-1.5">
        <div className="min-w-0 flex-1">
          <div className="text-[8px] font-bold uppercase tracking-wide text-text-tertiary">Entry price</div>
          <div className="text-[11px] font-mono font-semibold text-text-primary tabular-nums leading-tight">
            {pos.open_price.toFixed(digits)}
          </div>
          <div className="text-[8px] text-text-tertiary mt-0.5 leading-tight">{formatPositionOpenedAt(pos.created_at)}</div>
        </div>
        <ArrowRight className="w-3 h-3 text-text-tertiary shrink-0 mt-3" aria-hidden />
        <div className="min-w-0 flex-1 text-right">
          <div className="text-[8px] font-bold uppercase tracking-wide text-text-tertiary">Current price</div>
          <div className="text-[11px] font-mono font-semibold tabular-nums inline-flex items-center justify-end gap-0.5 text-text-primary leading-tight">
            {cur != null ? cur.toFixed(digits) : '—'}
            {cur != null &&
              (priceDown ? (
                <TrendingDown className="w-3 h-3 text-[#ff5252]" aria-hidden />
              ) : (
                <TrendingUp className="w-3 h-3 text-[#55a630]" aria-hidden />
              ))}
          </div>
        </div>
      </div>

      <div className="px-2.5 pb-1.5 grid grid-cols-2 gap-x-2 gap-y-1 text-[10px]">
        <div>
          <div className="text-[8px] font-semibold uppercase text-text-tertiary mb-px">Stop loss</div>
          <div className="font-mono text-text-primary leading-tight">
            {pos.stop_loss != null ? pos.stop_loss.toFixed(digits) : '—'}
          </div>
        </div>
        <div>
          <div className="text-[8px] font-semibold uppercase text-text-tertiary mb-px">Take profit</div>
          <div className="font-mono text-text-primary leading-tight">
            {pos.take_profit != null ? pos.take_profit.toFixed(digits) : '—'}
          </div>
        </div>
        <div>
          <div className="text-[8px] font-semibold uppercase text-text-tertiary mb-px">Swaps / Fee</div>
          <div className="font-mono text-text-secondary tabular-nums text-[10px] leading-tight">{swapsFeeLine}</div>
        </div>
        <div>
          <div className="text-[8px] font-semibold uppercase text-text-tertiary mb-px">Margin / Exposure</div>
          <div className="font-mono text-text-secondary tabular-nums text-[10px] leading-tight break-all">
            {marginExposureLine}
          </div>
        </div>
      </div>

      <p className="px-2.5 pb-1 text-[8px] text-text-tertiary font-mono truncate" title={pos.id}>
        POSITION ID: {pos.id}
      </p>

      <div className="px-2.5 pb-2 pt-0.5 flex flex-col gap-1.5 border-t border-border-primary">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onCloseFull();
          }}
          className="w-full py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wide bg-[#ff5252]/12 text-[#ff5252] border border-[#ff5252]/35 hover:bg-[#ff5252]/18 transition-colors"
        >
          Close
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPartialClose();
          }}
          className="w-full py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wide bg-bg-secondary text-text-primary border border-border-primary hover:bg-bg-hover transition-colors"
        >
          Partial close
        </button>
      </div>
    </div>
  );
}

export default function PositionsPanel({ variant = 'default' }: PositionsPanelProps) {
  const isTerminal = variant === 'terminal';
  const {
    positions,
    pendingOrders,
    activeAccount,
    accounts,
    removePosition,
    refreshPositions,
    refreshAccount,
    instruments,
  } = useTradingStore();
  const [activeTab, setActiveTab] = useState<TabId>('open');
  const [historyTrades, setHistoryTrades] = useState<ClosedTrade[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [closeModal, setCloseModal] = useState<CloseModal>(null);
  const [closeSubmitting, setCloseSubmitting] = useState(false);
  const [toolbarBusy, setToolbarBusy] = useState(false);
  const [sltpEdit, setSltpEdit] = useState<SltpEdit>(null);
  const [sltpSaving, setSltpSaving] = useState(false);
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false);
  const [bulkConfirm, setBulkConfirm] = useState<BulkCloseType | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const bulkMenuRef = useRef<HTMLDivElement>(null);
  const bulkBtnRef = useRef<HTMLButtonElement>(null);
  const bulkPopRef = useRef<HTMLDivElement>(null);
  // Fixed-position anchor for the portaled Close-All menu. It must be portaled to
  // <body>: the header row is overflow-x-auto (→ overflow-y:auto) inside an
  // overflow-hidden box, which clipped the old inline dropdown invisible — so the
  // button looked dead. (client 2026-07-11)
  const [bulkMenuPos, setBulkMenuPos] = useState<{ right: number; bottom: number } | null>(null);
  /** Terminal open tab: static trade cards vs compact table. */
  const [terminalOpenCardView, setTerminalOpenCardView] = useState(false);
  const [sharePosition, setSharePosition] = useState<Position | null>(null);

  const totalPnl = positions.reduce((s, p) => s + (p.profit || 0), 0);

  const profitPositions = positions.filter((p) => (p.profit || 0) > 0);
  const lossPositions = positions.filter((p) => (p.profit || 0) < 0);

  useEffect(() => {
    if (!bulkMenuOpen) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      // The menu is portaled to <body>, so accept clicks on either the trigger
      // wrapper or the popup itself; only an outside click closes it.
      if (bulkMenuRef.current?.contains(t) || bulkPopRef.current?.contains(t)) return;
      setBulkMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [bulkMenuOpen]);

  useEffect(() => {
    if (activeTab !== 'open') setBulkMenuOpen(false);
  }, [activeTab]);

  useEffect(() => {
    if (!closeModal && !bulkConfirm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (bulkConfirm) setBulkConfirm(null);
      else setCloseModal(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeModal, bulkConfirm]);

  const getDigits = (symbol: string) => {
    const inst = instruments.find((i) => i.symbol === symbol);
    return inst?.digits ?? 5;
  };

  const accountLabel = (accountId: string) => {
    const a = accounts.find((x) => x.id === accountId);
    return a?.account_number ?? accountId.slice(0, 8);
  };

  // Type badge resolver — demo accounts get a "Demo" pill, MAM
  // follower rows stay "Copy", everything else is "Real". Client
  // reported the column was showing "Real" on demo trades.
  const tradeTypeBadge = (
    accountId: string,
    tradeType: string | null | undefined,
  ): { label: string; cls: string } => {
    const a = accounts.find((x) => x.id === accountId);
    if (a?.is_demo) {
      return { label: 'Demo', cls: 'bg-warning/15 text-warning' };
    }
    if (tradeType === 'copy_trade') {
      return { label: 'Copy', cls: 'bg-info/15 text-info' };
    }
    return { label: 'Real', cls: 'bg-success/15 text-success' };
  };

  // Depend on activeAccount.id (a stable string), NOT the activeAccount
  // object — the Zustand store rebuilds the object reference on every
  // WS tick (balance/equity/profit refresh), so depending on the whole
  // object made loadHistory's identity change every second and the
  // useEffect below kept re-firing → "Loading history…" blinked on
  // forever for users sitting on the Closed Positions tab.
  const activeAccountId = activeAccount?.id ?? null;
  const loadHistory = useCallback(async () => {
    if (!activeAccountId) {
      setHistoryTrades([]);
      return;
    }
    setHistoryLoading(true);
    try {
      // Scope closed-positions list to the account the trader has
      // currently selected. Without this filter the panel pools every
      // account's history together, which is jarring when a brand-new
      // account inherits decades of trades from a sibling.
      const res = await api.get<{ items?: ClosedTrade[] } | ClosedTrade[]>('/portfolio/trades', {
        account_id: activeAccountId,
        page: '1',
        per_page: '200',
      });
      setHistoryTrades(
        (res && typeof res === 'object' && 'items' in res ? res.items : Array.isArray(res) ? res : []) || [],
      );
    } catch {
      setHistoryTrades([]);
    }
    setHistoryLoading(false);
  }, [activeAccountId]);

  useEffect(() => {
    if (activeTab === 'history') void loadHistory();
  }, [activeTab, loadHistory]);

  const closePosition = (id: string, lots?: number) => {
    unlockAudio();
    // Close modal instantly — don't wait for API
    setCloseModal(null);
    setCloseSubmitting(false);

    const body: Record<string, unknown> = {};
    if (lots) body.lots = lots;

    // Optimistic: remove from UI immediately for full close
    if (!lots) removePosition(id);

    void (async () => {
      try {
        const res = await api.post<{ profit?: number; close_price?: number; remaining_lots?: number }>(
          `/positions/${id}/close`,
          body,
          { timeoutMs: 8_000 },
        );
        const pnl = res.profit ?? 0;
        // Cent accounts must show ¢ (×100), not $ (client 2026-06-23: close
        // toast was converting cent P&L to $).
        const pnlStr = fmtAccountMoney(pnl, isCentAccount(activeAccount), { signDisplay: 'always' });
        pnl >= 0 ? sounds.profit() : sounds.loss();

        if (res.remaining_lots && res.remaining_lots > 0) {
          toast.success(
            `Partial close @ ${res.close_price}\nBooked: ${pnlStr}  •  ${res.remaining_lots} lots remain`,
            { duration: 5000 },
          );
        } else {
          toast.success(`Closed @ ${res.close_price} | P&L: ${pnlStr}`);
        }
        Promise.all([refreshPositions(), refreshAccount(), loadHistory()]).catch(() => {});
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Close failed');
        // Restore position if close failed
        refreshPositions().catch(() => {});
      }
    })();
  };

  const executeBulkClose = async (type: BulkCloseType) => {
    setBulkConfirm(null);
    setBulkBusy(true);
    const targets =
      type === 'all' ? positions : type === 'profit' ? profitPositions : lossPositions;
    if (targets.length === 0) {
      toast(
        type === 'profit'
          ? 'No profitable positions to close'
          : type === 'loss'
            ? 'No losing positions to close'
            : 'No open positions',
        { icon: 'ℹ️' },
      );
      setBulkBusy(false);
      return;
    }

    if (!activeAccount) {
      toast.error('No account selected');
      setBulkBusy(false);
      return;
    }

    // Single bulk endpoint — the previous fan-out of N parallel POST
    // /close calls race-conditioned on the shared trading_account row
    // and surfaced "Request failed" for most of the closes. The backend
    // now closes sequentially in one session and returns per-position
    // outcomes; we only need to render them.
    try {
      const res = await api.post<{
        closed_count: number;
        failed_count: number;
        skipped_no_tick: number;
        skipped_mam_copy: number;
        total_profit: number;
        closed: { position_id: string; symbol: string | null; profit: number; close_price: number }[];
        failed: { position_id: string; symbol: string | null; reason: string; status_code: number }[];
      }>(
        '/positions/close-all',
        { account_id: activeAccount.id, filter: type },
        { timeoutMs: 60_000 },
      );

      for (const c of res.closed) {
        try {
          (c.profit >= 0 ? sounds.profit() : sounds.loss());
        } catch {
          /* audio context blocked / muted — close already succeeded server-side */
        }
        removePosition(c.position_id);
      }

      if (res.closed_count > 0) {
        const totalStr = fmtAccountMoney(res.total_profit, isCentAccount(activeAccount), { signDisplay: 'always' });
        toast.success(
          `${res.closed_count} position${res.closed_count > 1 ? 's' : ''} closed — booked ${totalStr}`,
        );
      }
      if (res.failed_count > 0) {
        const firstReason = res.failed[0]?.reason || 'Unknown error';
        toast.error(`${res.failed_count} failed — ${firstReason}`);
      }
      if (res.skipped_mam_copy > 0) {
        toast(`${res.skipped_mam_copy} MAM-copied position${res.skipped_mam_copy > 1 ? 's' : ''} skipped (only master can close)`, { icon: 'ℹ️' });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Close All failed');
    }

    refreshPositions();
    refreshAccount();
    void loadHistory();
    setBulkBusy(false);
  };

  const saveSltpEdit = async () => {
    if (!sltpEdit) return;
    setSltpSaving(true);
    try {
      const body: Record<string, unknown> = {};
      const slVal = sltpEdit.sl.trim();
      const tpVal = sltpEdit.tp.trim();
      if (slVal !== '' && slVal !== '—') body.stop_loss = parseFloat(slVal);
      if (tpVal !== '' && tpVal !== '—') body.take_profit = parseFloat(tpVal);
      await api.put(`/positions/${sltpEdit.positionId}`, body);
      toast.success('SL/TP updated');
      setSltpEdit(null);
      refreshPositions();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Failed to update SL/TP');
    } finally {
      setSltpSaving(false);
    }
  };

  const handleRefresh = async () => {
    setToolbarBusy(true);
    try {
      if (activeTab === 'history') {
        await loadHistory();
        toast.success('History updated');
      } else {
        await refreshPositions();
        await refreshAccount();
        toast.success('Updated');
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Refresh failed');
    } finally {
      setToolbarBusy(false);
    }
  };

  const exportOpenCsv = () => {
    const rows: (string | number)[][] = [
      [
        'Account',
        'Symbol',
        'Side',
        'Qty',
        'Open Price',
        'Current',
        'P&L',
        'SL',
        'TP',
      ],
    ];
    for (const pos of positions) {
      const d = getDigits(pos.symbol);
      const comm = pos.commission || 0;
      const gross = pos.profit || 0;
      rows.push([
        accountLabel(pos.account_id),
        pos.symbol,
        pos.side,
        pos.lots,
        pos.open_price.toFixed(d),
        (pos.current_price ?? '').toString() ? Number(pos.current_price).toFixed(d) : '',
        gross - comm,
        pos.stop_loss != null ? pos.stop_loss : '',
        pos.take_profit != null ? pos.take_profit : '',
      ]);
    }
    downloadCsv(`open-positions-${Date.now()}.csv`, rows);
    toast.success('CSV downloaded');
  };

  const exportPendingCsv = () => {
    const rows: (string | number)[][] = [
      ['Account', 'Symbol', 'Side', 'Type', 'Qty', 'Price', 'SL', 'TP'],
    ];
    for (const o of pendingOrders) {
      const d = getDigits(o.symbol);
      rows.push([
        accountLabel(o.account_id),
        o.symbol,
        o.side,
        o.order_type,
        o.lots,
        o.price.toFixed(d),
        o.stop_loss != null ? o.stop_loss : '',
        o.take_profit != null ? o.take_profit : '',
      ]);
    }
    downloadCsv(`pending-orders-${Date.now()}.csv`, rows);
    toast.success('CSV downloaded');
  };

  const exportHistoryCsv = () => {
    const rows: (string | number)[][] = [
      [
        'Symbol',
        'Side',
        'Qty',
        'Open Price',
        'Close Price',
        'P&L',
        'Close reason',
        'Closed At',
      ],
    ];
    for (const t of historyTrades) {
      const d = getDigits(t.symbol);
      const comm = t.commission || 0;
      const gross = t.pnl || 0;
      rows.push([
        t.symbol,
        t.side,
        t.lots,
        t.open_price.toFixed(d),
        t.close_price.toFixed(d),
        gross - comm,
        closeReasonBadge(t.close_reason, t.close_price, d).label,
        t.close_time,
      ]);
    }
    downloadCsv(`trade-history-${Date.now()}.csv`, rows);
    toast.success('CSV downloaded');
  };

  const tabs: { id: TabId; label: string; count: number }[] = [
    { id: 'open', label: 'Open', count: positions.length },
    { id: 'pending', label: 'Pending', count: pendingOrders.length },
    { id: 'history', label: 'History', count: historyTrades.length },
  ];

  const exportCurrentCsv = () => {
    if (activeTab === 'open') exportOpenCsv();
    else if (activeTab === 'pending') exportPendingCsv();
    else exportHistoryCsv();
  };

  const accountMetrics = activeAccount
    ? [
        { label: 'Balance', value: activeAccount.balance as number },
        { label: 'Equity', value: activeAccount.balance + (activeAccount.credit || 0) + totalPnl },
        { label: 'Credit', value: activeAccount.credit || 0 },
        { label: 'Used Margin', value: activeAccount.margin_used },
        {
          label: 'Free Margin',
          value: activeAccount.balance + (activeAccount.credit || 0) + totalPnl - activeAccount.margin_used,
          color: 'text-info' as const,
        },
        {
          label: 'Floating PL',
          value: totalPnl,
          color: totalPnl >= 0 ? 'text-buy' : 'text-sell',
          signed: true as const,
        },
      ]
    : [];

  const th = 'text-left text-[10px] font-bold uppercase tracking-wider text-text-tertiary px-2 py-2 whitespace-nowrap';
  const td = 'px-2 py-2 text-[11px] sm:text-xs text-text-primary tabular-nums align-middle';
  const theadRowClass = clsx(!isTerminal && 'border-b border-border-glass/50');
  const tbodyRowClass = clsx(
    isTerminal
      ? 'hover:bg-white/[0.04] transition-colors'
      : 'border-b border-border-glass/30 hover:bg-bg-hover/25 transition-colors',
  );

  const tabTitle = (id: TabId) =>
    id === 'open' ? 'Positions' : id === 'history' ? 'Closed Positions' : 'Pending';

  const equity =
    activeAccount != null
      ? activeAccount.balance + (activeAccount.credit || 0) + totalPnl
      : 0;
  const freeMarginCalc =
    activeAccount != null ? equity - activeAccount.margin_used : 0;
  const marginLevelDisplay =
    activeAccount != null && activeAccount.margin_level > 0
      ? `${activeAccount.margin_level % 1 === 0 ? activeAccount.margin_level.toFixed(0) : activeAccount.margin_level.toFixed(2)}%`
      : '—';

  return (
    <div className={clsx('h-full w-full min-w-0 flex flex-col min-h-0', isTerminal ? 'bg-bg-base' : 'bg-bg-primary')}>
      {!isTerminal && activeAccount && (
        <div className="px-2 py-2 shrink-0 space-y-2 border-b border-border-glass bg-bg-secondary/30">
          <ActiveAccountBadge account={activeAccount} variant="compact" />
          <div className="flex flex-wrap gap-x-4 gap-y-1 items-center justify-between sm:justify-start text-[10px] sm:text-xs">
            {accountMetrics.map((item) => (
              <div key={item.label} className="flex items-baseline gap-1.5 shrink-0">
                <span className="text-text-tertiary font-medium whitespace-nowrap">{item.label}</span>
                <span
                  className={clsx(
                    'font-bold tabular-nums font-mono whitespace-nowrap',
                    'color' in item && item.color ? item.color : 'text-text-primary',
                  )}
                >
                  {'signed' in item && item.signed && item.value >= 0 ? '+' : ''}
                  {item.value.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className={clsx('flex-1 flex flex-col min-h-0 w-full min-w-0', isTerminal ? 'p-0' : 'p-1.5 sm:p-2')}>
        <div
          className={clsx(
            'flex flex-col flex-1 min-h-0 overflow-hidden w-full min-w-0',
            isTerminal
              ? 'rounded-none border-0 bg-transparent shadow-none'
              : 'rounded-xl border border-border-glass bg-bg-secondary/25 shadow-sm',
          )}
        >
          {isTerminal ? (
            <div className="flex shrink-0 items-end justify-between gap-2 sm:gap-4 min-w-0 px-2 sm:px-3 py-2 border-b border-border-primary">
              <div className="flex items-end gap-0 sm:gap-1 min-w-0 overflow-x-auto scrollbar-none no-scrollbar">
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    className={clsx(
                      'shrink-0 px-2 sm:px-2.5 pb-1 text-left transition-colors border-b-2 -mb-px',
                      activeTab === tab.id
                        ? 'text-text-primary border-accent font-semibold text-xs sm:text-sm'
                        : 'text-text-tertiary border-transparent font-medium text-xs sm:text-sm hover:text-text-secondary',
                    )}
                  >
                    <span className="whitespace-nowrap">
                      {tabTitle(tab.id)}
                      <span className="tabular-nums opacity-75 font-normal"> ({tab.count})</span>
                    </span>
                  </button>
                ))}
                <ChevronRight
                  className="w-4 h-4 text-text-tertiary shrink-0 mb-0.5 ml-0.5 opacity-80"
                  aria-hidden
                />
              </div>
              <div className="flex items-end gap-3 sm:gap-4 md:gap-5 shrink-0 min-w-0 overflow-x-auto scrollbar-none no-scrollbar">
                {activeAccount ? (() => {
                  // Cent-account display flag (Mig 0068). When true, every
                  // money figure in the terminal status bar is multiplied
                  // by 100 and rendered with ¢ instead of $. The engine
                  // math + Redis cache stay USD — this is a display-only
                  // rebrand. Earlier the dashboard + accounts page used
                  // this helper too (batch #6); now the trading terminal
                  // follows the same convention so a $5 deposit reads
                  // as ¢500 here as well.
                  const isCent = isCentAccount(activeAccount);
                  return (
                  <>
                    <div className="flex flex-col items-end gap-0.5 shrink-0">
                      <span className="text-[9px] font-semibold uppercase tracking-wide text-text-tertiary leading-none">
                        Balance
                      </span>
                      <span className="text-xs font-mono font-semibold text-text-primary tabular-nums leading-tight">
                        {fmtAccountMoney(activeAccount.balance, isCent)}
                      </span>
                    </div>
                    <div className="flex flex-col items-end gap-0.5 shrink-0">
                      <span className="text-[9px] font-semibold uppercase tracking-wide text-text-tertiary leading-none">
                        Floating P&amp;L
                      </span>
                      <span
                        className={clsx(
                          'text-xs font-mono font-semibold tabular-nums leading-tight',
                          totalPnl >= 0 ? 'text-[#55a630]' : 'text-[#ef5350]',
                        )}
                      >
                        {totalPnl >= 0 ? '+' : ''}{fmtAccountMoney(totalPnl, isCent)}
                      </span>
                    </div>
                    <div className="flex flex-col items-end gap-0.5 shrink-0">
                      <span className="text-[9px] font-semibold uppercase tracking-wide text-text-tertiary leading-none">
                        Equity
                      </span>
                      <span className="text-xs font-mono font-semibold text-text-primary tabular-nums leading-tight">
                        {fmtAccountMoney(equity, isCent)}
                      </span>
                    </div>
                    <div className="flex flex-col items-end gap-0.5 shrink-0">
                      <span className="text-[9px] font-semibold uppercase tracking-wide text-text-tertiary leading-none">
                        Margin Used
                      </span>
                      <span className="text-xs font-mono font-semibold text-text-primary tabular-nums leading-tight">
                        {fmtAccountMoney(activeAccount.margin_used, isCent)}
                      </span>
                    </div>
                    <div className="flex flex-col items-end gap-0.5 shrink-0">
                      <span className="text-[9px] font-semibold uppercase tracking-wide text-text-tertiary leading-none">
                        Free Margin
                      </span>
                      <span className="text-xs font-mono font-semibold text-text-primary tabular-nums leading-tight">
                        {fmtAccountMoney(freeMarginCalc, isCent)}
                      </span>
                    </div>
                    <div className="flex flex-col items-end gap-0.5 shrink-0">
                      <span className="text-[9px] font-semibold uppercase tracking-wide text-text-tertiary leading-none inline-flex items-center gap-0.5">
                        Margin Level
                        <Info className="w-3 h-3 text-text-tertiary" aria-label="Margin level info" />
                      </span>
                      <span className="text-xs font-mono font-semibold text-text-primary tabular-nums leading-tight">
                        {marginLevelDisplay}
                      </span>
                    </div>
                  </>
                  );
                })() : null}
                {isTerminal && activeTab === 'open' && (
                  <div className="flex items-center gap-1 shrink-0 pb-0.5 border-l border-border-primary ml-1 pl-2">
                    {positions.length > 0 && (
                      <div ref={bulkMenuRef}>
                        <button
                          ref={bulkBtnRef}
                          type="button"
                          onClick={() => {
                            if (bulkMenuOpen) { setBulkMenuOpen(false); return; }
                            const r = bulkBtnRef.current?.getBoundingClientRect();
                            if (r) setBulkMenuPos({
                              right: Math.max(4, window.innerWidth - r.right),
                              bottom: window.innerHeight - r.top + 6, // open UPWARD (panel sits at the bottom)
                            });
                            setBulkMenuOpen(true);
                          }}
                          className="flex items-center gap-0.5 px-2 py-1 rounded-md text-[11px] font-semibold text-text-secondary hover:text-text-primary hover:bg-bg-hover border border-border-primary hover:border-border-secondary transition-colors"
                        >
                          Close All
                          <ChevronDown
                            className={clsx('w-3.5 h-3.5 transition-transform shrink-0', bulkMenuOpen && 'rotate-180')}
                          />
                        </button>
                        {bulkMenuOpen && bulkMenuPos && typeof document !== 'undefined' && createPortal(
                          <div
                            ref={bulkPopRef}
                            style={{ position: 'fixed', right: bulkMenuPos.right, bottom: bulkMenuPos.bottom, zIndex: 2147483646 }}
                            className="min-w-[180px] py-1 rounded-lg border border-border-primary bg-card shadow-xl"
                          >
                            <button
                              type="button"
                              onClick={() => { setBulkMenuOpen(false); setBulkConfirm('all'); }}
                              className="w-full text-left px-3 py-2 text-xs text-text-primary hover:bg-bg-hover"
                            >
                              Close all ({positions.length})
                            </button>
                            <button
                              type="button"
                              onClick={() => { setBulkMenuOpen(false); setBulkConfirm('profit'); }}
                              disabled={profitPositions.length === 0}
                              className="w-full text-left px-3 py-2 text-xs text-accent hover:bg-bg-hover disabled:opacity-40"
                            >
                              Close profitable ({profitPositions.length})
                            </button>
                            <button
                              type="button"
                              onClick={() => { setBulkMenuOpen(false); setBulkConfirm('loss'); }}
                              disabled={lossPositions.length === 0}
                              className="w-full text-left px-3 py-2 text-xs text-[#ff5252] hover:bg-bg-hover disabled:opacity-40"
                            >
                              Close losing ({lossPositions.length})
                            </button>
                          </div>,
                          document.body,
                        )}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => setTerminalOpenCardView((v) => !v)}
                      className={clsx(
                        'p-1.5 rounded-md transition-colors border',
                        terminalOpenCardView
                          ? 'text-accent bg-accent/15 border-accent/35'
                          : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover border-transparent hover:border-border-primary',
                      )}
                      title={terminalOpenCardView ? 'Table view' : 'Card view'}
                      aria-pressed={terminalOpenCardView}
                    >
                      {terminalOpenCardView ? (
                        <LayoutList className="w-4 h-4" strokeWidth={1.75} />
                      ) : (
                        <LayoutGrid className="w-4 h-4" strokeWidth={1.75} />
                      )}
                    </button>
                  </div>
                )}
                <div className="flex items-center gap-0.5 shrink-0 pb-0.5 ml-1 pl-1">
                  <button
                    type="button"
                    onClick={() => void handleRefresh()}
                    disabled={toolbarBusy || (activeTab === 'history' && historyLoading)}
                    className="p-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover disabled:opacity-40 transition-colors"
                    title="Refresh"
                  >
                    <RefreshCw className={clsx('w-4 h-4', toolbarBusy && 'animate-spin')} />
                  </button>
                  <button
                    type="button"
                    onClick={exportCurrentCsv}
                    className="p-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
                    title="Download CSV"
                  >
                    <Download className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className={clsx('flex shrink-0 border-b border-border-glass', isTerminal ? 'bg-bg-secondary' : 'bg-bg-primary/40')}>
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    className={clsx(
                      'flex-1 min-w-0 py-2.5 px-1 sm:px-2 text-[10px] sm:text-xs font-bold transition-colors border-b-2 -mb-px',
                      activeTab === tab.id
                        ? clsx('text-text-primary border-[#55a630]', 'bg-bg-secondary/70')
                        : clsx(
                            'text-text-tertiary border-transparent hover:text-text-secondary',
                            'hover:bg-bg-hover/40',
                          ),
                    )}
                  >
                    <span className="block truncate text-center">{tab.label}</span>
                    <span className="block text-center tabular-nums opacity-90">({tab.count})</span>
                  </button>
                ))}
              </div>

              <div className={clsx('flex items-center justify-between gap-2 px-2 py-1.5 shrink-0 border-b border-border-glass/60', isTerminal ? 'bg-bg-secondary' : 'bg-bg-primary/20')}>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void handleRefresh()}
                    disabled={toolbarBusy || (activeTab === 'history' && historyLoading)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] sm:text-xs font-semibold text-text-secondary bg-bg-secondary/80 border border-border-glass hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
                  >
                    <RefreshCw className={clsx('w-3.5 h-3.5', toolbarBusy && 'animate-spin')} />
                    Refresh
                  </button>
                </div>
                <button
                  type="button"
                  onClick={exportCurrentCsv}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] sm:text-xs font-semibold text-text-secondary bg-bg-secondary/80 border border-border-glass hover:bg-bg-hover hover:text-text-primary"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download CSV
                </button>
              </div>
            </>
          )}

          <div
            className={clsx(
              'flex-1 overflow-auto min-h-0 flex flex-col w-full min-w-0',
              isTerminal ? 'bg-transparent' : 'bg-bg-primary/30',
            )}
          >
            {activeTab === 'open' && (
              <div className="min-w-0 w-full flex-1 flex flex-col min-h-0">
                {isTerminal && terminalOpenCardView ? (
                  <div className="flex-1 overflow-y-auto min-h-0 p-2 sm:p-3">
                    {positions.length === 0 ? (
                      <div className="px-4 py-12 text-center text-sm text-text-tertiary">No open positions</div>
                    ) : (
                      <div className="flex flex-wrap gap-2 content-start items-start">
                        {positions.map((pos) => {
                          const d = getDigits(pos.symbol);
                          const lev = activeAccount?.leverage ?? 100;
                          const m = estimatePositionMargin(pos, instruments, lev);
                          const inst = instruments.find((i) => i.symbol === pos.symbol);
                          // Engine lots for notional so cent positions
                          // don't show a 100×-inflated contract value.
                          const _engineLots = pos.effective_lots ?? pos.lots;
                          const notional =
                            inst != null ? _engineLots * inst.contract_size * pos.open_price : null;
                          // Cent-aware money strings for the card view.
                          // Notional stays in raw $ (it's the symbol's
                          // contract value, not the user's wallet), but
                          // margin, swap, and commission are wallet money
                          // and follow the account's currency.
                          const _isCent = isCentAccount(activeAccount);
                          const marginExposureLine =
                            m != null && notional != null
                              ? `${fmtAccountMoney(m, _isCent)} / $${notional.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
                              : notional != null
                                ? `— / $${notional.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
                                : '— / —';
                          const swapsFeeLine =
                            pos.swap === 0
                              ? `— / ${fmtAccountMoney(pos.commission, _isCent)}`
                              : `${fmtAccountMoney(pos.swap, _isCent)} / ${fmtAccountMoney(pos.commission, _isCent)}`;

                          return (
                            <TerminalPositionStaticCard
                              key={pos.id}
                              pos={pos}
                              digits={d}
                              isCent={isCentAccount(activeAccount)}
                              marginExposureLine={marginExposureLine}
                              swapsFeeLine={swapsFeeLine}
                              onCloseFull={() =>
                                setCloseModal({
                                  id: pos.id,
                                  symbol: pos.symbol,
                                  side: pos.side,
                                  lots: pos.lots,
                                  closeLots: String(pos.lots),
                                })
                              }
                              onPartialClose={() => {
                                const partLots = partitionCloneLots(pos, instruments);
                                if (partLots >= pos.lots - 1e-12) {
                                  toast.error('Position too small for partial close');
                                  return;
                                }
                                setCloseModal({
                                  id: pos.id,
                                  symbol: pos.symbol,
                                  side: pos.side,
                                  lots: pos.lots,
                                  closeLots: String(partLots),
                                });
                              }}
                            />
                          );
                        })}
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                {/* Mobile card layout */}
                <div className="md:hidden flex-1 overflow-y-auto space-y-2 p-2">
                  {positions.length === 0 ? (
                    <div className="px-4 py-12 text-center text-sm text-text-tertiary">No open positions</div>
                  ) : (
                    positions.map((pos) => {
                      const d = getDigits(pos.symbol);
                      // pos.profit is already the unrealized P&L from price
                      // movement. Commission was debited from balance at open
                      // and swap accrues continuously into balance — neither
                      // should be subtracted from the floating P&L again,
                      // otherwise the per-row number won't match the header
                      // "Floating P&L" which sums pos.profit directly.
                      const pnl = pos.profit || 0;
                      return (
                        <div key={pos.id} className="rounded-xl border border-border-glass bg-bg-secondary/40 p-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-bold text-text-primary">{pos.symbol}</span>
                              <span className={clsx('text-[10px] font-bold uppercase', pos.side === 'buy' ? 'text-buy' : 'text-sell')}>{pos.side}</span>
                              {(() => {
                                const b = tradeTypeBadge(pos.account_id, pos.trade_type);
                                return (
                                  <span className={clsx('text-[10px] px-1.5 py-0.5 rounded-sm font-medium', b.cls)}>
                                    {b.label}
                                  </span>
                                );
                              })()}
                            </div>
                            <span className="font-mono text-sm font-bold tabular-nums" style={{ color: pnl >= 0 ? '#2962FF' : '#FF2440' }}>
                              {fmtAccountMoney(pnl, isCentAccount(activeAccount), { signDisplay: 'always' })}
                            </span>
                          </div>
                          <div className="grid grid-cols-3 gap-x-3 gap-y-1 text-[11px]">
                            <div><span className="text-text-tertiary">Qty</span> <span className="text-text-primary font-mono">{pos.lots}</span></div>
                            <div><span className="text-text-tertiary">Open</span> <span className="text-text-primary font-mono">{pos.open_price.toFixed(d)}</span></div>
                            <div><span className="text-text-tertiary">Now</span> <span className="text-text-primary font-mono">{pos.current_price != null ? pos.current_price.toFixed(d) : '—'}</span></div>
                            <div><span className="text-text-tertiary">Acct</span> <span className="text-text-secondary">{accountLabel(pos.account_id)}</span></div>
                            {(() => {
                              const charges = (pos.commission || 0) + (pos.swap || 0);
                              // Charges (commission + swap) are a COST that reduces
                              // P&L, so a positive total must show as a deduction
                              // (-$x, red) — not a gain (+$x). Client 2026-06-23.
                              return (
                                <div>
                                  <span className="text-text-tertiary">Charges</span>{' '}
                                  <span className={clsx('font-mono', charges > 0 ? 'text-sell' : charges < 0 ? 'text-buy' : 'text-text-secondary')}>
                                    {charges === 0 ? '$0.00' : (charges > 0 ? '-' : '+') + '$' + Math.abs(charges).toFixed(2)}
                                  </span>
                                </div>
                              );
                            })()}
                          </div>
                          <div className="flex items-center justify-between pt-1 border-t border-border-glass/40">
                            <div className="text-[10px]">
                              {sltpEdit && sltpEdit.positionId === pos.id ? (
                                <div className="flex items-center gap-2 flex-wrap">
                                  <div className="flex items-center gap-1">
                                    <span className="text-text-tertiary">SL:</span>
                                    <input type="number" step="0.00001" value={sltpEdit.sl} onChange={(e) => setSltpEdit({ ...sltpEdit, sl: e.target.value })} className="w-20 px-1 py-0.5 text-[10px] font-mono bg-bg-input border border-border-glass rounded text-text-primary" placeholder="—" />
                                  </div>
                                  <div className="flex items-center gap-1">
                                    <span className="text-text-tertiary">TP:</span>
                                    <input type="number" step="0.00001" value={sltpEdit.tp} onChange={(e) => setSltpEdit({ ...sltpEdit, tp: e.target.value })} className="w-20 px-1 py-0.5 text-[10px] font-mono bg-bg-input border border-border-glass rounded text-text-primary" placeholder="—" />
                                  </div>
                                  <button type="button" onClick={() => void saveSltpEdit()} disabled={sltpSaving} className="p-1 rounded bg-buy/15 text-buy hover:bg-buy/25 disabled:opacity-50"><Check className="w-3.5 h-3.5" /></button>
                                  <button type="button" onClick={() => setSltpEdit(null)} className="p-1 rounded bg-sell/15 text-sell hover:bg-sell/25"><X className="w-3.5 h-3.5" /></button>
                                </div>
                              ) : (
                                <button type="button" onClick={() => setSltpEdit({ positionId: pos.id, sl: pos.stop_loss != null ? pos.stop_loss.toFixed(d) : '', tp: pos.take_profit != null ? pos.take_profit.toFixed(d) : '' })} className="text-text-tertiary active:text-text-secondary">
                                  SL: {pos.stop_loss != null ? pos.stop_loss.toFixed(d) : '—'} · TP: {pos.take_profit != null ? pos.take_profit.toFixed(d) : '—'}
                                  <Pencil className="w-2.5 h-2.5 inline ml-1 opacity-60" />
                                </button>
                              )}
                            </div>
                            <div className="inline-flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => setSharePosition(pos)}
                                className="p-1.5 rounded-lg text-text-tertiary active:text-text-primary"
                                aria-label="Share trade"
                              >
                                <Share2 className="w-4 h-4" />
                              </button>
                              {pos.trade_type === 'copy_trade' ? (
                                <span className="px-2 py-1.5 rounded-lg text-[10px] font-bold uppercase bg-info/15 text-info border border-info/30" title="MAM trade — only master can close">
                                  MAM
                                </span>
                              ) : (
                                <button type="button" onClick={() => setCloseModal({ id: pos.id, symbol: pos.symbol, side: pos.side, lots: pos.lots, closeLots: String(pos.lots) })} className="px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase bg-sell/15 text-sell border border-sell/30 active:bg-sell/25">
                                  Close
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
                {/* Desktop table layout — block + full width so table aligns left, not centered in flex */}
                <div className="hidden md:block w-full min-w-0 flex-1 overflow-x-auto">
                  <table className="w-full min-w-[920px] border-collapse">
                    <thead>
                      <tr className={theadRowClass}>
                        <th className={th}>Account</th>
                        <th className={th}>Symbol</th>
                        <th className={th}>Type</th>
                        <th className={th}>Side</th>
                        <th className={th}>Qty</th>
                        <th className={th}>Open</th>
                        <th className={th}>Current</th>
                        <th className={th}>
                          <span className="block">P&amp;L</span>
                        </th>
                        <th className={th}>
                          <span className="block">Charges</span>
                        </th>
                        <th className={th}>SL / TP</th>
                        <th className={clsx(th, 'text-right pr-3')}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {positions.map((pos) => {
                        const d = getDigits(pos.symbol);
                        // See mobile-card comment above — pos.profit is the
                        // unrealised P&L; commission/swap are already booked
                        // against balance and must not be subtracted twice.
                        const pnl = pos.profit || 0;
                        // Per-trade charges = commission + swap that the
                        // admin's spreads/charges config booked when the
                        // order opened. 0 when admin hasn't set any.
                        const charges = (pos.commission || 0) + (pos.swap || 0);
                        return (
                          <tr key={pos.id} className={tbodyRowClass}>
                            <td className={td}>{accountLabel(pos.account_id)}</td>
                            <td className={clsx(td, 'font-bold')}>{pos.symbol}</td>
                            <td className={td}>
                              {(() => {
                                const b = tradeTypeBadge(pos.account_id, pos.trade_type);
                                return (
                                  <span className={clsx('text-[10px] px-1.5 py-0.5 rounded-sm font-medium', b.cls)}>
                                    {b.label}
                                  </span>
                                );
                              })()}
                            </td>
                            <td className={td}>
                              <span
                                className={clsx(
                                  'font-bold uppercase',
                                  pos.side === 'buy' ? 'text-buy' : 'text-sell',
                                )}
                              >
                                {pos.side}
                              </span>
                            </td>
                            <td className={td}>{pos.lots}</td>
                            <td className={clsx(td, 'font-mono')}>{pos.open_price.toFixed(d)}</td>
                            <td className={clsx(td, 'font-mono')}>
                              {pos.current_price != null ? pos.current_price.toFixed(d) : '—'}
                            </td>
                            <td className={clsx(td, 'font-mono font-bold tabular-nums')} style={{ color: pnl >= 0 ? '#2962FF' : '#FF2440' }}>
                              {pnl >= 0 ? '+' : ''}{fmtAccountMoney(pnl, isCentAccount(activeAccount))}
                            </td>
                            <td className={clsx(td, 'font-mono tabular-nums', charges > 0 ? 'text-sell' : charges < 0 ? 'text-buy' : 'text-text-secondary')}>
                              {charges === 0 ? fmtAccountMoney(0, isCentAccount(activeAccount)) : (charges > 0 ? '-' : '+') + fmtAccountMoney(Math.abs(charges), isCentAccount(activeAccount)).replace('-', '')}
                            </td>
                            <td className={clsx(td, 'text-[10px]')}>
                              {sltpEdit && sltpEdit.positionId === pos.id ? (
                                <div className="flex flex-col gap-1">
                                  <div className="flex items-center gap-1">
                                    <span className="text-text-tertiary w-5">SL:</span>
                                    <input
                                      type="number"
                                      step="0.00001"
                                      value={sltpEdit.sl}
                                      onChange={(e) => setSltpEdit({ ...sltpEdit, sl: e.target.value })}
                                      className="w-20 px-1 py-0.5 text-[10px] font-mono bg-bg-input border border-border-glass rounded text-text-primary"
                                      placeholder="—"
                                    />
                                  </div>
                                  <div className="flex items-center gap-1">
                                    <span className="text-text-tertiary w-5">TP:</span>
                                    <input
                                      type="number"
                                      step="0.00001"
                                      value={sltpEdit.tp}
                                      onChange={(e) => setSltpEdit({ ...sltpEdit, tp: e.target.value })}
                                      className="w-20 px-1 py-0.5 text-[10px] font-mono bg-bg-input border border-border-glass rounded text-text-primary"
                                      placeholder="—"
                                    />
                                  </div>
                                  <div className="flex gap-1 mt-0.5">
                                    <button
                                      type="button"
                                      onClick={() => void saveSltpEdit()}
                                      disabled={sltpSaving}
                                      className="p-0.5 rounded bg-buy/15 text-buy hover:bg-buy/25 disabled:opacity-50"
                                      title="Save"
                                    >
                                      <Check className="w-3 h-3" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setSltpEdit(null)}
                                      className="p-0.5 rounded bg-sell/15 text-sell hover:bg-sell/25"
                                      title="Cancel"
                                    >
                                      <X className="w-3 h-3" />
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setSltpEdit({
                                    positionId: pos.id,
                                    sl: pos.stop_loss != null ? pos.stop_loss.toFixed(d) : '',
                                    tp: pos.take_profit != null ? pos.take_profit.toFixed(d) : '',
                                  })}
                                  className="text-left group cursor-pointer"
                                  title="Click to edit SL/TP"
                                >
                                  <span className="text-text-tertiary">SL: {pos.stop_loss != null ? pos.stop_loss.toFixed(d) : '—'}</span>
                                  <br />
                                  <span className="text-text-tertiary">TP: {pos.take_profit != null ? pos.take_profit.toFixed(d) : '—'}</span>
                                  <Pencil className="w-2.5 h-2.5 inline ml-1 opacity-0 group-hover:opacity-60 text-text-tertiary transition-opacity" />
                                </button>
                              )}
                              <InsuranceCountdown pos={pos} />
                            </td>
                            <td className={clsx(td, 'text-right pr-2')}>
                              <div className="inline-flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => setSharePosition(pos)}
                                  title="Share trade"
                                  className="p-1 rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-fast"
                                >
                                  <Share2 className="w-3.5 h-3.5" />
                                </button>
                                {pos.trade_type === 'copy_trade' ? (
                                  <span
                                    className="px-2 py-1 rounded-md text-[9px] font-bold uppercase bg-info/15 text-info border border-info/30"
                                    title="MAM trade — only master can close"
                                  >
                                    MAM
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setCloseModal({
                                        id: pos.id,
                                        symbol: pos.symbol,
                                        side: pos.side,
                                        lots: pos.lots,
                                        closeLots: String(pos.lots),
                                      })
                                    }
                                    className="px-2.5 py-1 rounded-md text-[10px] font-bold uppercase bg-sell/15 text-sell border border-sell/30 hover:bg-sell/25"
                                  >
                                    Close
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                      {positions.length === 0 && (
                        <tr>
                          <td colSpan={12} className="px-4 py-12 text-center text-sm text-text-tertiary">
                            No open positions
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                  </>
                )}
              </div>
            )}

            {activeTab === 'pending' && (
              <div className="min-w-0 w-full flex-1 flex flex-col min-h-0">
                {/* Mobile card layout */}
                <div className="md:hidden flex-1 overflow-y-auto space-y-2 p-2">
                  {pendingOrders.length === 0 ? (
                    <div className="px-4 py-12 text-center text-sm text-text-tertiary">No pending orders</div>
                  ) : (
                    pendingOrders.map((order) => {
                      const d = getDigits(order.symbol);
                      return (
                        <div key={order.id} className="rounded-xl border border-border-glass bg-bg-secondary/40 p-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-bold text-text-primary">{order.symbol}</span>
                              <span className={clsx('text-[10px] font-bold uppercase', order.side === 'buy' ? 'text-buy' : 'text-sell')}>{order.side}</span>
                              <span className="text-[10px] text-text-tertiary">{order.order_type.replace(/_/g, ' ')}</span>
                            </div>
                            <span className="text-xs font-mono font-semibold text-text-primary tabular-nums">@ {order.price.toFixed(d)}</span>
                          </div>
                          <div className="grid grid-cols-3 gap-x-3 gap-y-1 text-[11px]">
                            <div><span className="text-text-tertiary">Qty</span> <span className="text-text-primary font-mono">{order.lots}</span></div>
                            <div><span className="text-text-tertiary">SL</span> <span className="text-text-secondary font-mono">{order.stop_loss != null ? order.stop_loss.toFixed(d) : '—'}</span></div>
                            <div><span className="text-text-tertiary">TP</span> <span className="text-text-secondary font-mono">{order.take_profit != null ? order.take_profit.toFixed(d) : '—'}</span></div>
                          </div>
                          <div className="flex items-center justify-between pt-1 border-t border-border-glass/40">
                            <span className="text-[10px] text-text-tertiary">{accountLabel(order.account_id)}</span>
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  await api.delete(`/orders/${order.id}`);
                                  toast.success('Order cancelled');
                                  refreshPositions();
                                } catch (e: unknown) {
                                  toast.error(e instanceof Error ? e.message : 'Failed');
                                }
                              }}
                              className="px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase bg-sell/15 text-sell border border-sell/30 active:bg-sell/25"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
                {/* Desktop table layout */}
                <div className="hidden md:block w-full min-w-0 flex-1 overflow-x-auto">
                  <table className="w-full min-w-[560px] border-collapse">
                    <thead>
                      <tr className={theadRowClass}>
                        <th className={th}>Account</th>
                        <th className={th}>Symbol</th>
                        <th className={th}>Side</th>
                        <th className={th}>Type</th>
                        <th className={th}>Qty</th>
                        <th className={th}>Price</th>
                        <th className={th}>SL / TP</th>
                        <th className={clsx(th, 'text-right pr-3')}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pendingOrders.map((order) => {
                        const d = getDigits(order.symbol);
                        return (
                          <tr key={order.id} className={tbodyRowClass}>
                            <td className={td}>{accountLabel(order.account_id)}</td>
                            <td className={clsx(td, 'font-bold')}>{order.symbol}</td>
                            <td className={td}>
                              <span
                                className={clsx(
                                  'font-bold uppercase',
                                  order.side === 'buy' ? 'text-buy' : 'text-sell',
                                )}
                              >
                                {order.side}
                              </span>
                            </td>
                            <td className={clsx(td, 'text-text-tertiary')}>
                              {order.order_type.replace(/_/g, ' ')}
                            </td>
                            <td className={td}>{order.lots}</td>
                            <td className={clsx(td, 'font-mono')}>{order.price.toFixed(d)}</td>
                            <td className={clsx(td, 'text-[10px] text-text-tertiary')}>
                              SL: {order.stop_loss != null ? order.stop_loss.toFixed(d) : '—'}
                              <br />
                              TP: {order.take_profit != null ? order.take_profit.toFixed(d) : '—'}
                            </td>
                            <td className={clsx(td, 'text-right pr-2')}>
                              <button
                                type="button"
                                onClick={async () => {
                                  try {
                                    await api.delete(`/orders/${order.id}`);
                                    toast.success('Order cancelled');
                                    refreshPositions();
                                  } catch (e: unknown) {
                                    toast.error(e instanceof Error ? e.message : 'Failed');
                                  }
                                }}
                                className="px-2.5 py-1 rounded-md text-[10px] font-bold uppercase bg-sell/15 text-sell border border-sell/30 hover:bg-sell/25"
                              >
                                Cancel
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                      {pendingOrders.length === 0 && (
                        <tr>
                          <td colSpan={8} className="px-4 py-12 text-center text-sm text-text-tertiary">
                            No pending orders
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {activeTab === 'history' && (
              <div className="min-w-0 w-full flex-1 flex flex-col min-h-0 overflow-hidden">
                {historyLoading ? (
                  <div className="px-4 py-12 text-center text-text-tertiary animate-pulse text-sm flex-1 flex items-center justify-center min-h-[120px]">
                    Loading history…
                  </div>
                ) : (
                  <>
                  {/* Mobile card layout */}
                  <div className="md:hidden flex-1 overflow-y-auto space-y-2 p-2">
                    {historyTrades.length === 0 ? (
                      <div className="px-4 py-12 text-center text-sm text-text-tertiary">No trade history</div>
                    ) : (
                      historyTrades.map((trade) => {
                        const d = getDigits(trade.symbol);
                        // trade.pnl from /portfolio/trades is ALREADY net (price
                        // P&L − commission − swap). Use it directly — subtracting
                        // charges again double-counted commission and showed
                        // -$0.74 vs the -$0.67 on the close popup + trade history
                        // (client 2026-06-24).
                        const net = trade.pnl || 0;
                        const exitBadge = closeReasonBadge(trade.close_reason, trade.close_price, d);
                        return (
                          <div key={trade.id} className="rounded-xl border border-border-glass bg-bg-secondary/40 p-3 space-y-2">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-bold text-text-primary">{trade.symbol}</span>
                                <span className={clsx('text-[10px] font-bold uppercase', trade.side === 'buy' ? 'text-buy' : 'text-sell')}>{trade.side}</span>
                                {(() => {
                                  // Closed-positions list is scoped to activeAccount; trade row carries no account_id of its own.
                                  const b = tradeTypeBadge(activeAccount?.id ?? '', trade.trade_type);
                                  return (
                                    <span className={clsx('text-[10px] px-1.5 py-0.5 rounded-sm font-medium', b.cls)}>
                                      {b.label}
                                    </span>
                                  );
                                })()}
                              </div>
                              <span className="font-mono text-sm font-bold tabular-nums" style={{ color: net >= 0 ? '#2962FF' : '#FF2440' }}>
                                {fmtAccountMoney(net, isCentAccount(activeAccount), { signDisplay: 'always' })}
                              </span>
                            </div>
                            <div className="grid grid-cols-3 gap-x-3 gap-y-1 text-[11px]">
                              <div><span className="text-text-tertiary">Qty</span> <span className="text-text-primary font-mono">{trade.lots}</span></div>
                              <div><span className="text-text-tertiary">Open</span> <span className="text-text-primary font-mono">{trade.open_price.toFixed(d)}</span></div>
                              <div><span className="text-text-tertiary">Close</span> <span className="text-text-primary font-mono">{trade.close_price.toFixed(d)}</span></div>
                              <div>
                                <span className={clsx('inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide', exitBadge.className)}>
                                  {exitBadge.label}
                                </span>
                              </div>
                            </div>
                            <div className="text-[10px] text-text-tertiary pt-1 border-t border-border-glass/40">
                              {new Date(trade.close_time).toLocaleString()}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                  {/* Desktop table layout */}
                  <div className="hidden md:block w-full min-w-0 overflow-auto flex-1 min-h-0">
                  <table className="w-full min-w-[900px] border-collapse">
                    <thead>
                      <tr className={theadRowClass}>
                        <th className={th}>Symbol</th>
                        <th className={th}>Type</th>
                        <th className={th}>Side</th>
                        <th className={th}>Qty</th>
                        <th className={th}>Open</th>
                        <th className={th}>Close</th>
                        <th className={th}>
                          <span className="block">P&amp;L</span>
                        </th>
                        <th className={th}>
                          <span className="block">Close</span>
                          <span className="block text-[9px] font-normal normal-case text-text-tertiary tracking-normal">SL / TP / …</span>
                        </th>
                        <th className={th}>Closed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyTrades.map((trade) => {
                        const d = getDigits(trade.symbol);
                        // trade.pnl from /portfolio/trades is ALREADY net (price
                        // P&L − commission − swap). Use it directly — subtracting
                        // charges again double-counted commission and showed
                        // -$0.74 vs the -$0.67 on the close popup + trade history
                        // (client 2026-06-24).
                        const net = trade.pnl || 0;
                        const exitBadge = closeReasonBadge(trade.close_reason, trade.close_price, d);
                        return (
                          <tr key={trade.id} className={tbodyRowClass}>
                            <td className={clsx(td, 'font-bold')}>{trade.symbol}</td>
                            <td className={td}>
                              {(() => {
                                const b = tradeTypeBadge(activeAccount?.id ?? '', trade.trade_type);
                                return (
                                  <span className={clsx('text-[10px] px-1.5 py-0.5 rounded-sm font-medium', b.cls)}>
                                    {b.label}
                                  </span>
                                );
                              })()}
                            </td>
                            <td className={td}>
                              <span
                                className={clsx(
                                  'font-bold uppercase',
                                  trade.side === 'buy' ? 'text-buy' : 'text-sell',
                                )}
                              >
                                {trade.side}
                              </span>
                            </td>
                            <td className={td}>{trade.lots}</td>
                            <td className={clsx(td, 'font-mono')}>{trade.open_price.toFixed(d)}</td>
                            <td className={clsx(td, 'font-mono')}>{trade.close_price.toFixed(d)}</td>
                            <td className={clsx(td, 'font-mono font-bold tabular-nums')} style={{ color: net >= 0 ? '#2962FF' : '#FF2440' }}>
                              {fmtAccountMoney(net, isCentAccount(activeAccount), { signDisplay: 'always' })}
                            </td>
                            <td className={td}>
                              <span
                                className={clsx(
                                  'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide',
                                  exitBadge.className,
                                )}
                              >
                                {exitBadge.label}
                              </span>
                            </td>
                            <td className={clsx(td, 'text-[10px] text-text-tertiary')}>
                              {new Date(trade.close_time).toLocaleString()}
                            </td>
                          </tr>
                        );
                      })}
                      {historyTrades.length === 0 && (
                        <tr>
                          <td colSpan={11} className="px-4 py-12 text-center text-sm text-text-tertiary">
                            No trade history
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                  </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {bulkConfirm &&
        typeof document !== 'undefined' &&
        createPortal(
          (() => {
            const countMap = { all: positions.length, profit: profitPositions.length, loss: lossPositions.length };
            const labelMap = {
              all: 'Close All Positions',
              profit: 'Close Profitable Positions',
              loss: 'Close Losing Positions',
            };
            const descMap = {
              all: `Close all ${positions.length} open position${positions.length !== 1 ? 's' : ''} at market price.`,
              profit: `Close ${profitPositions.length} profitable position${profitPositions.length !== 1 ? 's' : ''} at market price.`,
              loss: `Close ${lossPositions.length} losing position${lossPositions.length !== 1 ? 's' : ''} at market price.`,
            };
            const count = countMap[bulkConfirm];
            const shell = clsx(
              'relative w-full max-w-[280px] rounded-xl border p-3.5 shadow-2xl overflow-hidden pointer-events-auto',
              'bg-card border-border-primary',
            );
            const titleCls = clsx('text-sm font-bold pr-2 text-text-primary');
            const bodyCls = clsx('text-xs text-text-secondary');
            return (
              <div className="fixed inset-0 p-0" style={{ zIndex: 2147483646, isolation: 'isolate' }}>
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label="Dismiss"
                  className="absolute inset-0 z-0 m-0 h-full w-full cursor-default border-0 bg-black/60 p-0 backdrop-blur-sm"
                  onClick={() => setBulkConfirm(null)}
                />
                <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-4">
                  <div
                    role="dialog"
                    aria-modal="true"
                    className={shell}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <h3 id="bulk-close-title" className={titleCls}>
                      {labelMap[bulkConfirm]}
                    </h3>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setBulkConfirm(null);
                      }}
                      className={clsx(
                        'shrink-0 w-7 h-7 flex items-center justify-center rounded-lg transition-colors',
                        'bg-bg-hover text-text-tertiary hover:text-text-primary',
                      )}
                      aria-label="Close"
                    >
                      <X className="w-4 h-4" strokeWidth={2.5} />
                    </button>
                  </div>
                  <p className={clsx(bodyCls, 'mb-2')}>{descMap[bulkConfirm]}</p>
                  {count === 0 ? (
                    <>
                      <p className={clsx('text-[11px] mb-3 text-text-tertiary')}>
                        No matching positions found.
                      </p>
                      <button
                        type="button"
                        onClick={() => setBulkConfirm(null)}
                        className={clsx(
                          'w-full py-2.5 font-bold rounded-lg text-sm',
                          'bg-bg-hover text-text-primary',
                        )}
                      >
                        OK
                      </button>
                    </>
                  ) : (
                    <>
                      <p className={clsx('text-[11px] mb-4 text-text-tertiary')}>
                        This action cannot be undone.
                      </p>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setBulkConfirm(null)}
                          className={clsx(
                            'flex-1 py-2.5 font-bold rounded-lg text-sm active:scale-[0.98] transition-all',
                            'bg-bg-hover text-text-primary',
                          )}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => void executeBulkClose(bulkConfirm)}
                          disabled={bulkBusy}
                          className="flex-1 py-2.5 bg-sell text-white font-bold rounded-lg shadow-lg shadow-sell/20 active:scale-[0.98] transition-all disabled:opacity-50 text-sm"
                        >
                          {bulkBusy ? 'Closing…' : 'Confirm'}
                        </button>
                      </div>
                    </>
                  )}
                  </div>
                </div>
              </div>
            );
          })(),
          document.body,
        )}

      {closeModal &&
        typeof document !== 'undefined' &&
        createPortal(
          <div className="fixed inset-0 p-0" style={{ zIndex: 2147483646, isolation: 'isolate' }}>
            <button
              type="button"
              tabIndex={-1}
              aria-label="Dismiss"
              className="absolute inset-0 z-0 m-0 h-full w-full cursor-default border-0 bg-black/60 p-0 backdrop-blur-sm"
              onClick={() => { if (!closeSubmitting) setCloseModal(null); }}
            />
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-4">
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="close-position-title"
                className="pointer-events-auto relative w-full max-w-[280px] rounded-xl border border-border-primary p-3.5 shadow-2xl overflow-hidden"
                style={{ background: 'var(--bg-card)' }}
                onMouseDown={(e) => e.stopPropagation()}
              >
              <div className="flex items-start justify-between gap-2 mb-3">
                <h3 id="close-position-title" className="text-sm font-bold text-text-primary">
                  Close Position
                </h3>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setCloseModal(null);
                  }}
                  className={clsx(
                    'shrink-0 w-7 h-7 flex items-center justify-center rounded-lg transition-colors',
                    'bg-bg-hover text-text-tertiary hover:text-text-primary',
                  )}
                  aria-label="Close dialog"
                >
                  <X className="w-4 h-4" strokeWidth={2.5} />
                </button>
              </div>

              <div className="space-y-3">
                <div
                  className={clsx(
                    'rounded-lg p-3 space-y-1.5 border',
                    'bg-bg-secondary border-border-primary',
                  )}
                >
                  <div className="flex justify-between text-[11px] font-medium">
                    <span className="text-text-tertiary">Symbol</span>
                    <span className="font-mono text-text-primary">{closeModal.symbol}</span>
                  </div>
                  <div className="flex justify-between text-[11px] font-medium">
                    <span className="text-text-tertiary">Side</span>
                    <span className={clsx('font-bold', closeModal.side === 'buy' ? 'text-buy' : 'text-sell')}>
                      {closeModal.side.toUpperCase()}
                    </span>
                  </div>
                  <div className="flex justify-between text-[11px] font-medium">
                    <span className="text-text-tertiary">Open lots</span>
                    <span className="font-mono text-text-primary">{closeModal.lots}</span>
                  </div>
                  {/*
                   * Live booking estimate: open position's unrealised P&L
                   * scaled to the slice the trader is about to close. Uses
                   * the same store the table reads, so the number matches
                   * what they were just looking at in the open-positions
                   * row to the cent.
                   */}
                  {(() => {
                    const pos = positions.find((p) => p.id === closeModal.id);
                    const cl = parseFloat(closeModal.closeLots);
                    if (!pos || !pos.lots || !Number.isFinite(cl) || cl <= 0) return null;
                    const ratio = Math.min(1, cl / pos.lots);
                    const booking = (pos.profit ?? 0) * ratio;
                    // '+' on profit, '-' on loss. The previous '' for
                    // losses dropped the negative sign so a $22.10 loss
                    // rendered identically to a $22.10 profit (only the
                    // colour told them apart — client report 2026-06-01).
                    const sign = booking >= 0 ? '+' : '-';
                    return (
                      <div className="flex justify-between text-[11px] font-medium pt-1 mt-1 border-t border-border-primary/50">
                        <span className="text-text-tertiary">Estimated booking</span>
                        <span className={clsx('font-mono font-bold tabular-nums', booking >= 0 ? 'text-buy' : 'text-sell')}>
                          {sign}${Math.abs(booking).toFixed(2)}
                        </span>
                      </div>
                    );
                  })()}
                </div>

                <div>
                  <label
                    className={clsx(
                      'text-[9px] font-bold uppercase tracking-wider block mb-1.5',
                      'text-text-tertiary',
                    )}
                  >
                    Lots to close
                  </label>
                  {(() => {
                    // Per-button booking preview: trader sees the realised
                    // P&L they'd book at each preset before clicking. The
                    // sign is colour-coded so a glance tells them whether
                    // 25%/50%/75%/Full is profit or loss.
                    const pos = positions.find((p) => p.id === closeModal.id);
                    const livePnl = pos?.profit ?? 0;
                    const previewFor = (frac: number) => {
                      // Show '-' on loss so the 25/50/75/FULL chips
                      // can't read like profit when the position is
                      // underwater (only colour was distinguishing them).
                      const v = livePnl * frac;
                      const sign = v >= 0 ? '+' : '-';
                      return { label: `${sign}$${Math.abs(v).toFixed(2)}`, positive: v >= 0 };
                    };
                    return (
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 mb-2">
                        {([25, 50, 75] as const).map((pct) => {
                          const pv = pos ? previewFor(pct / 100) : null;
                          const presetLots = snapLotsForCloseFraction(closeModal.lots, closeModal.symbol, instruments, pct / 100);
                          const active = formatLotsInput(presetLots) === formatLotsInput(parseFloat(closeModal.closeLots) || 0);
                          return (
                            <button
                              key={pct}
                              type="button"
                              onClick={() => {
                                setCloseModal((m) => {
                                  if (!m) return m;
                                  const v = snapLotsForCloseFraction(m.lots, m.symbol, instruments, pct / 100);
                                  return { ...m, closeLots: formatLotsInput(v) };
                                });
                              }}
                              className={clsx(
                                'cursor-pointer flex flex-col items-center justify-center px-2 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wide border transition-colors',
                                active
                                  ? 'bg-accent/15 border-accent/50 text-accent ring-1 ring-inset ring-accent/30'
                                  : 'bg-bg-secondary border-border-primary text-text-primary hover:bg-bg-hover',
                              )}
                            >
                              <span>{pct}%</span>
                              {pv && (
                                <span className={clsx(
                                  'text-[9px] font-mono normal-case tracking-normal mt-0.5',
                                  pv.positive ? 'text-buy' : 'text-sell',
                                )}>
                                  {pv.label}
                                </span>
                              )}
                            </button>
                          );
                        })}
                        <button
                          type="button"
                          onClick={() => {
                            setCloseModal((m) =>
                              m ? { ...m, closeLots: formatLotsInput(m.lots) } : m,
                            );
                          }}
                          className={clsx(
                            'cursor-pointer flex flex-col items-center justify-center px-2 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wide border transition-colors',
                            formatLotsInput(closeModal.lots) === formatLotsInput(parseFloat(closeModal.closeLots) || 0)
                              ? 'bg-accent/15 border-accent/50 text-accent ring-1 ring-inset ring-accent/30'
                              : 'bg-bg-secondary border-border-primary text-text-primary hover:bg-bg-hover',
                          )}
                        >
                          <span>Full</span>
                          {pos && (
                            <span className={clsx(
                              'text-[9px] font-mono normal-case tracking-normal mt-0.5',
                              livePnl >= 0 ? 'text-buy' : 'text-sell',
                            )}>
                              {livePnl >= 0 ? '+' : '-'}${Math.abs(livePnl).toFixed(2)}
                            </span>
                          )}
                        </button>
                      </div>
                    );
                  })()}
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    max={closeModal.lots}
                    value={closeModal.closeLots}
                    onChange={(e) => setCloseModal({ ...closeModal, closeLots: e.target.value })}
                    className={clsx(
                      'w-full px-3 py-2 rounded-lg font-mono text-sm outline-none transition-all border',
                      'bg-bg-secondary border-border-primary text-text-primary focus:border-sell',
                    )}
                  />
                </div>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setCloseModal(null)}
                    className={clsx(
                      'flex-1 py-2.5 font-bold rounded-lg text-sm active:scale-[0.98] transition-all',
                      'bg-bg-hover text-text-primary',
                    )}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={closeSubmitting}
                    onClick={() => {
                      const cl = parseFloat(closeModal.closeLots);
                      if (Number.isNaN(cl) || cl <= 0) {
                        toast.error('Invalid lots');
                        return;
                      }
                      if (cl > closeModal.lots + 1e-9) {
                        toast.error(`Cannot exceed ${closeModal.lots} lots`);
                        return;
                      }
                      closePosition(closeModal.id, cl < closeModal.lots - 1e-9 ? cl : undefined);
                    }}
                    className="flex-1 py-2.5 bg-sell text-white font-bold rounded-lg shadow-lg shadow-sell/20 active:scale-[0.98] transition-all text-sm flex items-center justify-center gap-2 disabled:opacity-70 disabled:pointer-events-none"
                  >
                    {closeSubmitting ? (
                      <>
                        <span className="w-3.5 h-3.5 rounded-full border-2 border-white border-t-transparent animate-spin" />
                        Closing…
                      </>
                    ) : 'Close'}
                  </button>
                </div>

                <div className={clsx('pt-3 mt-1 border-t border-border-primary')}>
                  <p
                    className={clsx(
                      'text-[9px] font-semibold uppercase tracking-wider text-center mb-2',
                      'text-text-tertiary',
                    )}
                  >
                    Bulk close
                  </p>
                  <div className="grid grid-cols-3 gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setCloseModal(null);
                        setBulkConfirm('all');
                      }}
                      disabled={bulkBusy || positions.length === 0}
                      className={clsx(
                        'flex flex-col items-center gap-0.5 py-2 px-0.5 rounded-lg border active:scale-[0.98] transition-all disabled:opacity-40',
                        'bg-bg-secondary border-border-primary hover:bg-bg-hover',
                      )}
                    >
                      <Layers className="w-3.5 h-3.5 text-text-secondary" />
                      <span className="text-[9px] font-bold text-text-primary">All</span>
                      <span className="text-[9px] tabular-nums text-text-tertiary">
                        ({positions.length})
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCloseModal(null);
                        setBulkConfirm('profit');
                      }}
                      disabled={bulkBusy || profitPositions.length === 0}
                      className={clsx(
                        'flex flex-col items-center gap-0.5 py-2 px-0.5 rounded-lg border active:scale-[0.98] transition-all disabled:opacity-40',
                        'bg-accent/5 border-accent/20 hover:bg-accent/10',
                      )}
                    >
                      <TrendingUp className="w-3.5 h-3.5 text-accent" />
                      <span className="text-[9px] font-bold text-accent">
                        Profit
                      </span>
                      <span className="text-[9px] tabular-nums text-text-tertiary">
                        ({profitPositions.length})
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCloseModal(null);
                        setBulkConfirm('loss');
                      }}
                      disabled={bulkBusy || lossPositions.length === 0}
                      className={clsx(
                        'flex flex-col items-center gap-0.5 py-2 px-0.5 rounded-lg border active:scale-[0.98] transition-all disabled:opacity-40',
                        'bg-sell/5 border-sell/20 hover:bg-sell/10',
                      )}
                    >
                      <TrendingDown className="w-3.5 h-3.5 text-sell" />
                      <span className="text-[9px] font-bold text-sell">
                        Loss
                      </span>
                      <span className="text-[9px] tabular-nums text-text-tertiary">
                        ({lossPositions.length})
                      </span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
          </div>,
          document.body,
        )}

      <ShareTradeModal
        open={!!sharePosition}
        onClose={() => setSharePosition(null)}
        position={sharePosition}
        leverage={Number(activeAccount?.leverage) || 100}
      />
    </div>
  );
}


// ─── Insurance countdown chip ───────────────────────────────────────
// Renders three states based on the backend's per-position insurance
// markers (insurance_eligible_at + insurance_expires_at):
//   • Pre-min: amber "Insurance OK in 25s"  (claim NOT yet eligible)
//   • Mid:     green  "✓ Insured · 2h 15m left"
//   • Expired: gray   "Insurance expired"
// Nothing renders when the position has no active policy. The chip
// ticks every second via a local clock so users see the countdown move.
function InsuranceCountdown({ pos }: { pos: Position }) {
  const [now, setNow] = useState(() => Date.now());
  const eligibleAt = pos.insurance_eligible_at ? new Date(pos.insurance_eligible_at).getTime() : null;
  const expiresAt = pos.insurance_expires_at ? new Date(pos.insurance_expires_at).getTime() : null;
  const hasInsurance = !!pos.insurance_activated_at;

  useEffect(() => {
    if (!hasInsurance) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasInsurance]);

  // Client report 2026-06-09: when no insurance tier was picked at
  // order time, the cell was empty and traders didn't know why. Show a
  // muted "Not insured" chip so the state is visible — and so users
  // realise insurance is opt-in (pick a tier in the order panel BEFORE
  // pressing BUY/SELL to get the countdown).
  if (!hasInsurance) {
    return (
      <div
        className="mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-text-tertiary/10 text-text-tertiary border border-text-tertiary/20"
        title="Pick an insurance tier in the order panel before placing the trade to activate coverage."
      >
        Not insured
      </div>
    );
  }

  const fmtRemaining = (ms: number): string => {
    if (ms < 0) ms = 0;
    const total = Math.ceil(ms / 1000);
    if (total < 60) return `${total}s`;
    const m = Math.floor(total / 60);
    const s = total % 60;
    if (m < 60) return `${m}m ${s}s`;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${h}h ${mm}m`;
  };

  // Pre-min state — not yet claim-eligible.
  if (eligibleAt && now < eligibleAt) {
    return (
      <div className="mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30">
        Insurance OK in {fmtRemaining(eligibleAt - now)}
      </div>
    );
  }

  // Mid state — eligible AND inside validity window.
  if (expiresAt && now < expiresAt) {
    return (
      <div className="mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-buy/15 text-buy border border-buy/30" title="Claim-eligible if this trade closes in loss">
        ✓ Insured · {fmtRemaining(expiresAt - now)} left
      </div>
    );
  }

  // Expired state — past validity window.
  return (
    <div className="mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-text-tertiary/10 text-text-tertiary border border-text-tertiary/20">
      Insurance expired
    </div>
  );
}
