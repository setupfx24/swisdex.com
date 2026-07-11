'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import { Minus, Plus, ChevronDown, X, Wifi, WifiOff } from 'lucide-react';
import { useTradingStore, type TradingAccount, type TickData } from '@/stores/tradingStore';
import api from '@/lib/api/client';
import { sounds, unlockAudio } from '@/lib/sounds';
import { getDigits } from '@/lib/utils';
import { fmtAccountMoney, isCentAccount } from '@/lib/wallet/centDisplay';
import { getMarketStatus } from '@/lib/marketHours';
import { wsManager, type ConnectionStatus } from '@/lib/ws/wsManager';
import { extractTicksFromPayload } from '@/lib/ws/normalizePricePayload';

interface AccountTradePanelProps {
  account: TradingAccount;
  onClose: () => void;
}

type OrderSide = 'buy' | 'sell';
type OrderTab = 'market' | 'pending';

/* ─── mini positions table ─── */
interface MiniPosition {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  lots: number;
  /** Engine lots (0.0001 on a cent account). Used for live P&L so a cent
   *  position doesn't show 100× the real P&L. Falls back to lots. */
  effective_lots?: number;
  open_price: number;
  profit: number;
}

export default function AccountTradePanel({ account, onClose }: AccountTradePanelProps) {
  const {
    selectedSymbol,
    setSelectedSymbol,
    prices,
    instruments,
    watchlist,
    updatePrice,
    setInstruments,
    setActiveAccount,
  } = useTradingStore();

  const [side, setSide] = useState<OrderSide>('buy');
  const [orderTab, setOrderTab] = useState<OrderTab>('market');
  const [lots, setLots] = useState(0.01);
  const [slEnabled, setSlEnabled] = useState(false);
  const [tpEnabled, setTpEnabled] = useState(false);
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [symbolPickerOpen, setSymbolPickerOpen] = useState(false);
  const [wsStatus, setWsStatus] = useState<ConnectionStatus>('disconnected');
  const [positions, setPositions] = useState<MiniPosition[]>([]);
  const [posLoading, setPosLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const bootstrapped = useRef(false);

  const tick = prices[selectedSymbol];
  const instrumentInfo = instruments.find((i) => i.symbol === selectedSymbol);
  const segment = (instrumentInfo as any)?.segment as string | undefined;
  const digits = getDigits(selectedSymbol);
  const contractSize = instrumentInfo?.contract_size || 100000;

  const marketStatus = useMemo(
    () => getMarketStatus(selectedSymbol, segment),
    [selectedSymbol, segment, Math.floor(Date.now() / 60_000)],
  );

  const execPrice = tick ? (side === 'buy' ? tick.ask : tick.bid) : 0;

  const marginRequired = useMemo(() => {
    if (!execPrice || !account) return 0;
    return (lots * contractSize * execPrice) / account.leverage;
  }, [execPrice, lots, account, contractSize]);

  const freeMargin = account.free_margin;
  const hasEnoughMargin = freeMargin >= marginRequired;

  /* ─── Bootstrap: WS + price polling + instruments + positions ─── */
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    setActiveAccount(account);

    // 1. Connect WebSocket prices
    wsManager.connect();
    const unsubMsg = wsManager.onMessage((data) => {
      const ticks = extractTicksFromPayload(data);
      for (const t of ticks) updatePrice(t);
    });
    const unsubStatus = wsManager.onStatusChange(setWsStatus);
    setWsStatus(wsManager.status);

    // 2. Fetch instruments if empty
    if (instruments.length === 0) {
      api.get<unknown>('/instruments/').then((res) => {
        const list = Array.isArray(res) ? res : ((res as any)?.items ?? []);
        if (list.length > 0) {
          setInstruments(
            list.map((i: any) => ({
              symbol: String(i.symbol),
              display_name: String(i.display_name || i.symbol),
              segment: String(i.segment?.name || i.segment || ''),
              digits: Number(i.digits ?? 5),
              pip_size: Number(i.pip_size ?? 0.0001),
              min_lot: Number(i.min_lot ?? 0.01),
              max_lot: Number(i.max_lot ?? 100),
              lot_step: Number(i.lot_step ?? 0.01),
              contract_size: Number(i.contract_size ?? 100000),
            })),
          );
        }
      }).catch(() => {});
    }

    // 3. Poll prices from REST as fallback
    let pollActive = true;
    const pollPrices = async () => {
      try {
        const raw = await api.get<unknown>('/instruments/prices/all', undefined, { timeoutMs: 15000 });
        if (!pollActive) return;
        for (const t of extractTicksFromPayload(raw)) updatePrice(t);
      } catch {}
    };
    void pollPrices();
    const pricePoll = setInterval(pollPrices, 1500);

    return () => {
      pollActive = false;
      unsubMsg();
      unsubStatus();
      clearInterval(pricePoll);
    };
  }, []);

  /* ─── Fetch positions for this account ─── */
  const fetchPositions = useCallback(async () => {
    setPosLoading(true);
    try {
      const res = await api.get<any[]>(`/positions/`, { account_id: account.id, status: 'open' });
      const list = Array.isArray(res) ? res : [];
      setPositions(
        list.map((p: any) => ({
          id: String(p.id),
          symbol: String(p.symbol || ''),
          side: p.side as 'buy' | 'sell',
          lots: Number(p.lots) || 0,
          effective_lots: p.effective_lots != null ? Number(p.effective_lots) : undefined,
          open_price: Number(p.open_price) || 0,
          profit: Number(p.profit) || 0,
        })),
      );
    } catch {
      setPositions([]);
    } finally {
      setPosLoading(false);
    }
  }, [account.id]);

  useEffect(() => {
    void fetchPositions();
    const poll = setInterval(fetchPositions, 2000);
    return () => clearInterval(poll);
  }, [fetchPositions]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setSymbolPickerOpen(false);
      }
    }
    if (symbolPickerOpen) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [symbolPickerOpen]);

  // Auto-set SL/TP defaults
  useEffect(() => {
    if (slEnabled && !stopLoss && execPrice > 0) {
      setStopLoss((side === 'buy' ? execPrice * 0.99 : execPrice * 1.01).toFixed(digits));
    }
  }, [slEnabled]);

  useEffect(() => {
    if (tpEnabled && !takeProfit && execPrice > 0) {
      setTakeProfit((side === 'buy' ? execPrice * 1.02 : execPrice * 0.98).toFixed(digits));
    }
  }, [tpEnabled]);

  const adjustLots = (delta: number) => {
    setLots((prev) => parseFloat(Math.max(0.01, prev + delta).toFixed(2)));
  };

  const handleSubmit = () => {
    unlockAudio();
    if (orderTab === 'market' && !marketStatus.isOpen) {
      toast.error(marketStatus.reason || 'Market is closed');
      return;
    }
    if (!hasEnoughMargin) {
      toast.error(`Insufficient margin`);
      return;
    }
    // MT5-style: instant sound + optimistic position, no button disable
    sounds.orderPlaced();
    toast.success(`${side.toUpperCase()} ${lots} ${selectedSymbol}`, { duration: 1500 });

    // Optimistic position injection for instant visual feedback
    if (orderTab === 'market' && tick) {
      const optimisticPos: MiniPosition = {
        id: `optim-${Date.now().toString(36)}`,
        symbol: selectedSymbol,
        side,
        lots,
        effective_lots: lots * (Number((account as { account_group?: { lot_size_multiplier?: number } }).account_group?.lot_size_multiplier) || 1),
        open_price: execPrice,
        profit: 0,
      };
      setPositions((prev) => [optimisticPos, ...prev]);
    }

    api.post('/orders/', {
      account_id: account.id,
      symbol: selectedSymbol,
      order_type: orderTab === 'market' ? 'market' : 'limit',
      side,
      lots,
      stop_loss: slEnabled && stopLoss ? parseFloat(stopLoss) : undefined,
      take_profit: tpEnabled && takeProfit ? parseFloat(takeProfit) : undefined,
    }).then(() => {
      void fetchPositions();
    }).catch((e: any) => {
      toast.error(e.message || 'Order failed');
      void fetchPositions(); // rollback: re-fetch real state
    });
  };

  const displaySymbols = watchlist.length > 0 ? watchlist : ['EURUSD', 'GBPUSD', 'XAUUSD', 'BTCUSD', 'ETHUSD', 'US30'];
  const isConnected = wsStatus === 'connected';

  return (
    <div className="rounded-xl border border-border-primary bg-bg-base overflow-hidden mt-3 trade-panel-enter">
      {/* ═══ Header ═══ */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border-primary bg-bg-secondary">
        <div className="flex items-center gap-2.5">
          <div className="w-2 h-2 rounded-full" style={{ background: marketStatus.isOpen ? '#55a630' : '#ef5350' }} />
          <span className="text-sm font-bold text-text-primary tracking-tight">Trade</span>
          <span className="text-[11px] text-text-tertiary font-mono">#{account.account_number}</span>
        </div>
        <button type="button" onClick={onClose} className="p-1.5 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors">
          <X size={14} />
        </button>
      </div>

      <div className="flex flex-col lg:flex-row">
        {/* ═══ ORDER PANEL (left/top) ═══ */}
        <div className="flex-1 min-w-0 border-r border-border-primary">
          <div className="p-3 space-y-3">
            {/* Symbol Picker */}
            <div className="relative" ref={dropdownRef}>
              <button
                type="button"
                onClick={() => setSymbolPickerOpen((v) => !v)}
                className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-bg-hover transition-colors bg-bg-secondary border border-border-primary"
              >
                <div className="flex items-center gap-2.5">
                  <div className="w-3.5 h-3.5 rounded-full shrink-0" style={{ background: 'linear-gradient(135deg, #ffb300, #42a5f5)' }} />
                  <span className="text-sm font-bold text-text-primary font-mono">{selectedSymbol}</span>
                  {/* Live price badge */}
                  {tick && (
                    <span className="text-[10px] font-mono text-text-tertiary">
                      {tick.bid.toFixed(digits)} / {tick.ask.toFixed(digits)}
                    </span>
                  )}
                  {isConnected ? (
                    <span className="flex items-center gap-1" title="Live prices">
                      <Wifi size={10} className="text-[#55a630]" />
                      <span className="w-1.5 h-1.5 rounded-full bg-[#55a630] animate-pulse" />
                    </span>
                  ) : (
                    <span className="flex items-center gap-1" title="Disconnected">
                      <WifiOff size={10} className="text-[#f57c00]" />
                    </span>
                  )}
                </div>
                <ChevronDown size={14} className={clsx('text-text-tertiary transition-transform', symbolPickerOpen && 'rotate-180')} />
              </button>

              {symbolPickerOpen && (
                <div className="absolute left-0 right-0 z-50 mt-1 rounded-lg overflow-y-auto shadow-2xl max-h-[220px] bg-card border border-border-primary">
                  {displaySymbols.map((sym) => {
                    const t = prices[sym];
                    const d = getDigits(sym);
                    return (
                      <button
                        key={sym}
                        type="button"
                        onClick={() => { setSelectedSymbol(sym); setSymbolPickerOpen(false); setStopLoss(''); setTakeProfit(''); }}
                        className={clsx(
                          'w-full flex items-center justify-between px-3 py-2 text-left transition-colors',
                          sym === selectedSymbol ? 'bg-accent/[0.08]' : 'hover:bg-bg-hover',
                        )}
                        style={{ borderLeft: sym === selectedSymbol ? '2px solid #55a630' : '2px solid transparent' }}
                      >
                        <span className="text-xs font-bold text-text-primary font-mono">{sym}</span>
                        {t && (
                          <div className="flex items-center gap-3">
                            <span className="text-[10px] font-mono text-red-400">{t.bid.toFixed(d)}</span>
                            <span className="text-[10px] font-mono text-[#55a630]">{t.ask.toFixed(d)}</span>
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Market / Pending tabs */}
            <div className="flex border-b border-border-primary">
              {(['market', 'pending'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setOrderTab(t)}
                  className="flex-1 py-2 text-xs font-semibold capitalize transition-all"
                  style={{
                    borderBottom: orderTab === t ? '2px solid var(--accent, #55a630)' : '2px solid transparent',
                    color: orderTab === t ? 'var(--text-primary)' : 'var(--text-tertiary)',
                  }}
                >
                  {t}
                </button>
              ))}
            </div>

            {/* Sell / Buy buttons */}
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => setSide('sell')}
                className="py-3 rounded-lg text-center transition-all duration-150 active:scale-[0.97]"
                style={{
                  background: side === 'sell' ? '#ef5350' : 'rgba(239,83,80,0.12)',
                  color: side === 'sell' ? '#fff' : '#ef5350',
                }}
              >
                <div className="text-xs font-bold">Sell</div>
                {tick && <div className="text-[13px] font-mono tabular-nums mt-0.5">{tick.bid.toFixed(digits)}</div>}
              </button>
              <button
                type="button"
                onClick={() => setSide('buy')}
                className="py-3 rounded-lg text-center transition-all duration-150 active:scale-[0.97]"
                style={{
                  background: side === 'buy' ? '#55a630' : 'rgba(85,166,48,0.12)',
                  color: side === 'buy' ? '#000' : '#55a630',
                }}
              >
                <div className="text-xs font-bold">Buy</div>
                {tick && <div className="text-[13px] font-mono tabular-nums mt-0.5">{tick.ask.toFixed(digits)}</div>}
              </button>
            </div>

            {/* Bid / Ask / Spread */}
            {tick && (
              <div className="flex items-center justify-between px-1">
                <div className="text-center">
                  <div className="text-xs font-mono font-semibold text-red-400">{tick.bid.toFixed(digits)}</div>
                  <div className="text-[9px] text-text-tertiary">Bid</div>
                </div>
                <div className="text-center">
                  <div className="text-[10px] font-mono text-text-tertiary">
                    {(tick.spread / (instrumentInfo?.pip_size || 0.0001)).toFixed(1)}
                  </div>
                  <div className="text-[9px] text-text-tertiary">Spread</div>
                </div>
                <div className="text-center">
                  <div className="text-xs font-mono font-semibold text-[#55a630]">{tick.ask.toFixed(digits)}</div>
                  <div className="text-[9px] text-text-tertiary">Ask</div>
                </div>
              </div>
            )}

            {/* SL / TP toggles */}
            <div className="flex items-center gap-4 border-t border-border-primary pt-2.5">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <div
                  onClick={() => { setSlEnabled((p) => !p); if (slEnabled) setStopLoss(''); }}
                  className="w-8 h-[18px] rounded-full relative transition-colors cursor-pointer"
                  style={{ background: slEnabled ? '#ef5350' : 'var(--bg-secondary)' }}
                >
                  <div className="absolute top-[3px] w-3 h-3 rounded-full bg-white transition-all" style={{ left: slEnabled ? '16px' : '3px' }} />
                </div>
                <span className="text-[10px] text-text-secondary">SL</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <div
                  onClick={() => { setTpEnabled((p) => !p); if (tpEnabled) setTakeProfit(''); }}
                  className="w-8 h-[18px] rounded-full relative transition-colors cursor-pointer"
                  style={{ background: tpEnabled ? '#55a630' : 'var(--bg-secondary)' }}
                >
                  <div className="absolute top-[3px] w-3 h-3 rounded-full bg-white transition-all" style={{ left: tpEnabled ? '16px' : '3px' }} />
                </div>
                <span className="text-[10px] text-text-secondary">TP</span>
              </label>
              <div className="ml-auto text-[9px] font-mono text-text-tertiary">1:{account.leverage}</div>
            </div>

            {/* Volume */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">Volume</span>
                <div className="flex gap-0.5">
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-bg-hover text-text-secondary">Lots</span>
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-medium text-text-tertiary cursor-pointer hover:text-text-secondary transition-colors">Units</span>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => adjustLots(-0.01)} className="w-8 h-9 rounded-lg flex items-center justify-center transition-colors text-text-secondary hover:text-text-primary bg-bg-secondary border border-border-primary">
                  <Minus size={12} />
                </button>
                <input
                  type="number"
                  value={lots}
                  onChange={(e) => setLots(parseFloat(e.target.value) || 0.01)}
                  step={0.01}
                  min={0.01}
                  className="flex-1 text-center text-sm font-mono font-bold py-2 rounded-lg focus:outline-none bg-bg-secondary border border-border-primary text-text-primary"
                />
                <button type="button" onClick={() => adjustLots(0.01)} className="w-8 h-9 rounded-lg flex items-center justify-center transition-colors text-text-secondary hover:text-text-primary bg-bg-secondary border border-border-primary">
                  <Plus size={12} />
                </button>
              </div>
            </div>

            {/* SL input */}
            {slEnabled && (
              <div>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-red-400 mb-1 block">Stop Loss</span>
                <input
                  type="number"
                  value={stopLoss}
                  onChange={(e) => setStopLoss(e.target.value)}
                  step={execPrice > 100 ? 0.01 : 0.00001}
                  placeholder={`e.g. ${(execPrice * (side === 'buy' ? 0.99 : 1.01)).toFixed(digits)}`}
                  className="w-full text-sm font-mono py-2 px-3 rounded-lg focus:outline-none"
                  style={{ background: 'var(--bg-secondary)', border: '1px solid rgba(239,83,80,0.25)', color: '#ef5350' }}
                />
              </div>
            )}

            {/* TP input */}
            {tpEnabled && (
              <div>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-[#55a630] mb-1 block">Take Profit</span>
                <input
                  type="number"
                  value={takeProfit}
                  onChange={(e) => setTakeProfit(e.target.value)}
                  step={execPrice > 100 ? 0.01 : 0.00001}
                  placeholder={`e.g. ${(execPrice * (side === 'buy' ? 1.02 : 0.98)).toFixed(digits)}`}
                  className="w-full text-sm font-mono py-2 px-3 rounded-lg focus:outline-none"
                  style={{ background: 'var(--bg-secondary)', border: '1px solid rgba(85,166,48,0.25)', color: '#55a630' }}
                />
              </div>
            )}

            {/* Order summary */}
            <div className="rounded-xl p-2.5 space-y-1.5 bg-bg-secondary" style={{ border: `1px solid ${!hasEnoughMargin ? 'rgba(239,83,80,0.3)' : 'var(--border-primary)'}` }}>
              {[
                { label: 'Exec. Price', value: execPrice > 0 ? execPrice.toFixed(digits) : '—', color: 'var(--text-primary)' },
                { label: 'Margin Required', value: fmtAccountMoney(marginRequired, isCentAccount(account)), color: !hasEnoughMargin ? '#ef5350' : 'var(--text-primary)' },
                { label: 'Free Margin', value: fmtAccountMoney(freeMargin, isCentAccount(account)), color: !hasEnoughMargin ? '#ef5350' : '#55a630' },
                { label: 'Feed', value: isConnected ? '● Connected' : '○ Disconnected', color: isConnected ? '#55a630' : '#f57c00' },
              ].map((row) => (
                <div key={row.label} className="flex items-center justify-between">
                  <span className="text-[10px] text-text-tertiary">{row.label}</span>
                  <span className="text-[11px] font-mono" style={{ color: row.color }}>{row.value}</span>
                </div>
              ))}
              {!hasEnoughMargin && (
                <div className="text-[10px] text-red-400 font-semibold text-center pt-1.5" style={{ borderTop: '1px solid rgba(239,83,80,0.15)' }}>
                  ⚠ Insufficient margin
                </div>
              )}
            </div>

            {/* Submit */}
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!hasEnoughMargin || (orderTab === 'market' && !marketStatus.isOpen)}
              className="w-full py-3.5 rounded-xl text-sm font-bold transition-transform duration-75 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.96]"
              style={{
                background: side === 'buy' ? '#55a630' : '#ef5350',
                color: side === 'buy' ? '#000' : '#fff',
                boxShadow: side === 'buy' ? '0 4px 20px rgba(85,166,48,0.2)' : '0 4px 20px rgba(239,83,80,0.2)',
              }}
            >
              {`${side === 'buy' ? 'Buy' : 'Sell'} ${selectedSymbol}`}
            </button>

            {!marketStatus.isOpen && orderTab === 'market' && (
              <div className="rounded-lg px-3 py-2 text-[10px] text-red-400/80 leading-snug text-center" style={{ background: 'rgba(239,83,80,0.06)', border: '1px solid rgba(239,83,80,0.15)' }}>
                {marketStatus.reason}
              </div>
            )}
          </div>
        </div>

        {/* ═══ POSITIONS PANEL (right/bottom) ═══ */}
        <div className="lg:w-[340px] shrink-0 border-t border-border-primary">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border-primary bg-bg-secondary">
            <span className="text-[10px] font-bold uppercase tracking-wider text-text-tertiary">Open Positions</span>
            <span className="text-[9px] font-mono text-text-tertiary">{positions.length}</span>
          </div>

          {posLoading && positions.length === 0 ? (
            <div className="flex items-center justify-center py-6">
              <div className="w-4 h-4 border-2 border-[#55a630] border-t-transparent rounded-full animate-spin" />
            </div>
          ) : positions.length === 0 ? (
            <div className="text-center py-6 text-[11px] text-text-tertiary">No open positions</div>
          ) : (
            <div className="overflow-y-auto" style={{ maxHeight: '200px' }}>
              {positions.map((pos) => {
                const liveTick = prices[pos.symbol];
                const cp = liveTick ? (pos.side === 'buy' ? liveTick.bid : liveTick.ask) : 0;
                const inst = instruments.find((i) => i.symbol === pos.symbol);
                const cs = inst?.contract_size || 100000;
                // Engine lots, not display lots — else a cent position's live
                // P&L shows 100× too large (client 2026-06-23: "¢4 then suddenly
                // ¢45000 loss" = a tick update arrived without effective_lots and
                // fell back to display lots). When effective_lots is missing,
                // derive it from display lots × the account multiplier instead of
                // trusting the raw display lots.
                const _lotMult = Number((account as { account_group?: { lot_size_multiplier?: number } }).account_group?.lot_size_multiplier) || 1;
                const pnlLots = pos.effective_lots ?? (pos.lots * _lotMult);
                const livePnl = cp > 0
                  ? pos.side === 'buy'
                    ? (cp - pos.open_price) * pnlLots * cs
                    : (pos.open_price - cp) * pnlLots * cs
                  : pos.profit;
                const pnlColor = livePnl >= 0 ? '#55a630' : '#ef5350';
                const d = getDigits(pos.symbol);

                return (
                  <div
                    key={pos.id}
                    className="flex items-center justify-between px-3 py-2 hover:bg-bg-hover transition-colors border-b border-border-primary"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span
                          className="text-[9px] font-bold uppercase px-1 py-0.5 rounded"
                          style={{
                            background: pos.side === 'buy' ? 'rgba(85,166,48,0.12)' : 'rgba(239,83,80,0.12)',
                            color: pos.side === 'buy' ? '#55a630' : '#ef5350',
                          }}
                        >
                          {pos.side}
                        </span>
                        <span className="text-[11px] font-bold text-text-primary font-mono">{pos.symbol}</span>
                        <span className="text-[9px] text-text-tertiary font-mono">{pos.lots}</span>
                      </div>
                      <div className="text-[9px] text-text-tertiary font-mono mt-0.5">
                        Open: {pos.open_price.toFixed(d)}
                        {cp > 0 && <span className="ml-2">Now: {cp.toFixed(d)}</span>}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[11px] font-mono font-bold tabular-nums" style={{ color: pnlColor }}>
                        {fmtAccountMoney(livePnl, isCentAccount(account), { signDisplay: 'always' })}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Account summary footer */}
          <div className="px-3 py-2 space-y-1 border-t border-border-primary bg-bg-secondary">
            {[
              { label: 'Balance', value: fmtAccountMoney(account.balance, isCentAccount(account)) },
              { label: 'Equity', value: fmtAccountMoney(account.equity, isCentAccount(account)) },
              { label: 'Margin Used', value: fmtAccountMoney(account.margin_used, isCentAccount(account)) },
              { label: 'Free Margin', value: fmtAccountMoney(account.free_margin, isCentAccount(account)), color: '#55a630' },
            ].map((r) => (
              <div key={r.label} className="flex items-center justify-between">
                <span className="text-[9px] text-text-tertiary">{r.label}</span>
                <span className="text-[10px] font-mono tabular-nums" style={{ color: r.color || 'var(--text-primary)' }}>{r.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
