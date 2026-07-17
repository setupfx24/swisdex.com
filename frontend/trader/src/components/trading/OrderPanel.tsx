'use client';

import { useState, useMemo, useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import { Minus, Plus, ChevronDown, Wifi, WifiOff } from 'lucide-react';
import { useTradingStore, type TradingAccount } from '@/stores/tradingStore';
import { useUIStore } from '@/stores/uiStore';
import api from '@/lib/api/client';
import { sounds, unlockAudio } from '@/lib/sounds';
import { getDigits } from '@/lib/utils';
import { getMarketStatus } from '@/lib/marketHours';
import { wsManager } from '@/lib/ws/wsManager';
import OrderPanelSymbolPicker from '@/components/trading/OrderPanelSymbolPicker';
import InsuranceTierPicker from '@/components/trading/InsuranceTierPicker';
import { insuranceApi, type InsuranceTier } from '@/lib/api/insurance';
import { fmtAccountMoney, isCentAccount } from '@/lib/wallet/centDisplay';

type OrderSide = 'buy' | 'sell';
type OrderType = 'market' | 'pending';

export default function OrderPanel() {
  const pathname = usePathname();
  const isTradingTerminal = Boolean(pathname?.startsWith('/trading/terminal'));

  const {
    selectedSymbol,
    setSelectedSymbol,
    prices,
    instruments,
    activeAccount,
    positions,
    setPositions,
    refreshPositions,
    refreshPendingOrders,
    refreshAccount,
    orderFormCloneDraft,
    setOrderFormCloneDraft,
  } = useTradingStore();
  const setTerminalMarketsOpen = useUIStore((s) => s.setTerminalMarketsOpen);
  const setTerminalNewsOpen = useUIStore((s) => s.setTerminalNewsOpen);

  const [side, setSide] = useState<OrderSide>('buy');
  const [orderTab, setOrderTab] = useState<OrderType>('market');
  const [lots, setLots] = useState('0.01');
  const [slEnabled, setSlEnabled] = useState(false);
  const [tpEnabled, setTpEnabled] = useState(false);
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  // Pending-order entry price + type (limit / stop). The Pending tab
  // previously submitted with no trigger price — the backend accepted
  // it but the order was effectively dead (nothing for the matching
  // engine to compare against). Now we require both a type and a
  // numeric price before the order can be sent.
  const [pendingType, setPendingType] = useState<'limit' | 'stop'>('limit');
  const [pendingPrice, setPendingPrice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [symbolPickerOpen, setSymbolPickerOpen] = useState(false);
  const [insuranceSelection, setInsuranceSelection] = useState<{ tier: InsuranceTier; fee: number } | null>(null);
  const [wsStatus, setWsStatus] = useState<'connected' | 'connecting' | 'disconnected'>('disconnected');
  // The user's OWN effective spread for this symbol/account. The shared price
  // broadcast can only carry the default spread, so per-account-type / per-user
  // spreads would otherwise show as 0 here. Fetched from /my-spread so the
  // panel shows the spread (and bid/ask) the user will actually trade at.
  const [mySpread, setMySpread] = useState<
    { value: number; spread_type: string; pip_size: number; effective_value: number } | null
  >(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const tick = prices[selectedSymbol];
  const instrumentInfo = instruments.find((i) => i.symbol === selectedSymbol);
  const segment = (instrumentInfo as any)?.segment as string | undefined;
  const digits = getDigits(selectedSymbol);
  const contractSize = instrumentInfo?.contract_size || 100000;

  // Pull the user's effective spread whenever the symbol or account changes.
  useEffect(() => {
    let cancelled = false;
    setMySpread(null);
    if (!selectedSymbol) return;
    const acct = activeAccount?.id ? `?account_id=${encodeURIComponent(activeAccount.id)}` : '';
    api
      .get<{ value: number; spread_type: string; pip_size: number; effective_value: number }>(
        `/instruments/${encodeURIComponent(selectedSymbol)}/my-spread${acct}`,
      )
      .then((r) => { if (!cancelled) setMySpread(r); })
      .catch(() => { if (!cancelled) setMySpread(null); });
    return () => { cancelled = true; };
  }, [selectedSymbol, activeAccount?.id]);

  // Effective bid/ask/spread around the broadcast mid using the user's own
  // spread (falls back to the broadcast quote until /my-spread resolves).
  const _mid = tick ? (tick.bid + tick.ask) / 2 : 0;
  const _pipSize = mySpread?.pip_size || instrumentInfo?.pip_size || 0.0001;
  // No admin spread config → ZERO spread (bid == ask == mid), never the raw
  // market spread. /my-spread returns 0 when nothing is configured; the final
  // `: 0` only bites if that fetch outright failed — still don't show the market
  // spread (client 2026-06-29).
  const _userSpreadPrice =
    mySpread && _mid
      ? (mySpread.spread_type === 'percentage'
          ? _mid * (mySpread.effective_value / 100)
          : mySpread.effective_value * _pipSize)
      : 0;
  const userBid = _mid ? _mid - _userSpreadPrice / 2 : (tick?.bid ?? 0);
  const userAsk = _mid ? _mid + _userSpreadPrice / 2 : (tick?.ask ?? 0);
  const userSpreadPips = _pipSize ? _userSpreadPrice / _pipSize : 0;

  const marketStatus = useMemo(
    () => getMarketStatus(selectedSymbol, segment),
    [selectedSymbol, segment, Math.floor(Date.now() / 60_000)],
  );

  const execPrice = tick ? (side === 'buy' ? userAsk : userBid) : 0;
  const lotsNum = parseFloat(lots) || 0;

  // Stale bid/ask detection — the price stream (priceSocket) can stall
  // "half-open" and freeze the panel at an old quote (prod incident 2026-07-09).
  // Mirror the chart's watchdog: if `tick` (prices[selectedSymbol]) hasn't
  // changed within the market threshold, flag it so the boxes dim + show a
  // "stale" note. Recovers instantly on the next fresh tick.
  const [priceStale, setPriceStale] = useState(false);
  const lastTickAtRef = useRef(Date.now());
  useEffect(() => { lastTickAtRef.current = Date.now(); setPriceStale(false); }, [tick]);
  useEffect(() => {
    const isCrypto = String(segment || '').toLowerCase() === 'crypto';
    const day = new Date().getUTCDay();
    const isWeekend = day === 0 || day === 6;
    const threshold = isCrypto ? 3000 : (isWeekend ? 60000 : 5000);
    const id = setInterval(() => {
      setPriceStale(Date.now() - lastTickAtRef.current > threshold);
    }, 1000);
    return () => clearInterval(id);
  }, [segment]);

  // Cent-account lot scaling (Mig 0069). The backend persists the
  // position at (typed lots × multiplier), so the margin preview +
  // the "Insufficient margin" gate must use the SAME effective lots,
  // or a cent account shows a 100×-too-high margin and falsely blocks
  // the trade. Standard accounts have multiplier=1 so this is a no-op.
  const lotMultiplier =
    (activeAccount?.account_group?.lot_size_multiplier as number | undefined) ?? 1;
  const effectiveLots = lotsNum * lotMultiplier;

  const marginRequired = useMemo(() => {
    if (!execPrice || !activeAccount) return 0;
    return (effectiveLots * contractSize * execPrice) / activeAccount.leverage;
  }, [execPrice, effectiveLots, activeAccount, contractSize]);

  const freeMargin = activeAccount?.free_margin || 0;
  const hasEnoughMargin = freeMargin >= marginRequired;

  useEffect(() => {
    const unsub = wsManager.onStatusChange(setWsStatus);
    setWsStatus(wsManager.status);
    return () => {
      unsub();
    };
  }, []);

  useEffect(() => {
    if (!orderFormCloneDraft) return;
    const d = orderFormCloneDraft;
    setSelectedSymbol(d.symbol);
    setSide(d.side);
    setLots(Math.max(0.01, Number(d.lots.toFixed(4))).toString());
    if (d.stop_loss != null && d.stop_loss !== undefined && !Number.isNaN(Number(d.stop_loss))) {
      setSlEnabled(true);
      setStopLoss(String(d.stop_loss));
    } else {
      setSlEnabled(false);
      setStopLoss('');
    }
    if (d.take_profit != null && d.take_profit !== undefined && !Number.isNaN(Number(d.take_profit))) {
      setTpEnabled(true);
      setTakeProfit(String(d.take_profit));
    } else {
      setTpEnabled(false);
      setTakeProfit('');
    }
    setOrderTab('market');
    setOrderFormCloneDraft(null);
    setTerminalMarketsOpen(false);
    setTerminalNewsOpen(false);
    toast.success('Order form filled — review and place');
  }, [orderFormCloneDraft, setSelectedSymbol, setOrderFormCloneDraft, setTerminalMarketsOpen, setTerminalNewsOpen]);

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
    setLots(Math.max(0.01, parseFloat((lotsNum + delta).toFixed(2))).toString());
  };

  // Pending-order trigger price. Parsed once so the submit handler +
  // the inline preview can both reuse it.
  const pendingPriceNum = orderTab === 'pending' ? parseFloat(pendingPrice) : NaN;
  const pendingPriceValid =
    orderTab !== 'pending' || (Number.isFinite(pendingPriceNum) && pendingPriceNum > 0);

  const handleSubmit = async () => {
    unlockAudio();
    if (!activeAccount) return;
    if (orderTab === 'market' && !marketStatus.isOpen) {
      toast.error(marketStatus.reason || 'Market is closed');
      return;
    }
    if (orderTab === 'pending') {
      if (!pendingPriceValid) {
        toast.error('Enter a trigger price for the pending order');
        return;
      }
      // Side-aware sanity check: a Buy Limit must be BELOW market,
      // Sell Limit ABOVE, Buy Stop ABOVE, Sell Stop BELOW. We don't
      // hard-reject (the matching engine handles it) but we surface
      // a clear warning before sending.
      const ref = side === 'buy' ? userAsk : userBid;
      if (ref > 0) {
        const aboveMarket = pendingPriceNum > ref;
        const belowMarket = pendingPriceNum < ref;
        const ok =
          (pendingType === 'limit' && side === 'buy'  && belowMarket) ||
          (pendingType === 'limit' && side === 'sell' && aboveMarket) ||
          (pendingType === 'stop'  && side === 'buy'  && aboveMarket) ||
          (pendingType === 'stop'  && side === 'sell' && belowMarket);
        if (!ok) {
          toast.error(
            `${side.toUpperCase()} ${pendingType.toUpperCase()} must be ` +
            (pendingType === 'limit'
              ? (side === 'buy' ? 'below' : 'above')
              : (side === 'buy' ? 'above' : 'below')) +
            ` market (${ref.toFixed(digits)})`,
          );
          return;
        }
      }
    }
    if (!hasEnoughMargin) {
      toast.error(`Insufficient margin`);
      return;
    }
    // Optimistic: instant feedback, API fires in background.
    sounds.orderPlaced();
    toast.success(`${side.toUpperCase()} ${lotsNum} ${selectedSymbol}`);

    // Only market orders hit the book immediately — show the position in
    // the panel without waiting for the API round-trip so the UI feels
    // synchronous with the tap.
    const optimisticId = `optim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    let rollback: (() => void) | null = null;
    if (orderTab === 'market') {
      const nowIso = new Date().toISOString();
      const optimisticPos = {
        id: optimisticId,
        account_id: activeAccount.id,
        symbol: selectedSymbol,
        side,
        lots: lotsNum,
        // Cent multiplier so live P&L matches the engine instantly.
        effective_lots: lotsNum * (Number(activeAccount.account_group?.lot_size_multiplier) || 1),
        open_price: execPrice,
        current_price: execPrice,
        stop_loss: slEnabled && stopLoss ? parseFloat(stopLoss) : undefined,
        take_profit: tpEnabled && takeProfit ? parseFloat(takeProfit) : undefined,
        swap: 0,
        commission: 0,
        profit: 0,
        trade_type: 'market',
        created_at: nowIso,
      } as (typeof positions)[number];
      const prev = positions;
      setPositions([optimisticPos, ...prev]);
      rollback = () => setPositions(prev);
    }

    const insuranceChoice = insuranceSelection;

    api.post<{ id: string; position_id: string | null }>('/orders/', {
      account_id: activeAccount.id,
      symbol: selectedSymbol,
      order_type:
        orderTab === 'market' ? 'market' : pendingType, // 'limit' | 'stop'
      side,
      lots: lotsNum,
      // Trigger price for pending orders. The backend's PlaceOrderRequest
      // accepts `price` on limit/stop orders and ignores it on market.
      price: orderTab === 'pending' ? pendingPriceNum : undefined,
      stop_loss: slEnabled && stopLoss ? parseFloat(stopLoss) : undefined,
      take_profit: tpEnabled && takeProfit ? parseFloat(takeProfit) : undefined,
    }).then(async (resp) => {
      // Insurance — only for market orders that immediately produced a position_id.
      if (insuranceChoice && resp?.position_id) {
        try {
          await insuranceApi.activate(resp.position_id, insuranceChoice.tier);
          toast.success(`Insured (${fmtAccountMoney(insuranceChoice.fee, isCentAccount(activeAccount))} fee)`);
        } catch (e: any) {
          const detail = e?.response?.data?.detail || e?.message || 'insurance_failed';
          toast.error(`Insurance not activated: ${detail}`);
        }
      }
      // Reset the picker so the next order starts fresh.
      setInsuranceSelection(null);
      // Reconcile with server-authoritative state. Pending orders also
      // need a refresh because a placed limit/stop never produces a
      // position; the optimistic-position path only covers market.
      Promise.all([refreshPositions(), refreshPendingOrders(), refreshAccount()]).catch(() => {});
    }).catch((e: any) => {
      if (rollback) rollback();
      toast.error(e.message || 'Order failed');
    });
  };

  const isConnected = wsStatus === 'connected';

  const pad = isTradingTerminal ? 'px-2 py-2 space-y-2' : 'p-4 space-y-4';
  const tabPad = isTradingTerminal ? 'py-1 text-[11px]' : 'py-1.5 text-xs';
  const obPad = isTradingTerminal ? 'py-2' : 'py-3';
  const volBtn = isTradingTerminal ? 'w-8 h-8' : 'w-10 h-10';
  const volIn = isTradingTerminal ? 'py-1.5 text-sm' : 'py-2.5 text-base';

  return (
    <div className="h-full min-h-0 flex flex-col overflow-hidden bg-bg-base">
      {/* ═══ Header ═══ */}
      <div
        className={clsx('shrink-0 flex items-center justify-between border-b border-border-primary bg-bg-secondary', isTradingTerminal ? 'px-2 py-2' : 'px-4 py-2.5')}
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <div className="relative flex items-center gap-1.5 min-w-0" ref={dropdownRef}>
            <div
              className={clsx('rounded-full shrink-0', isTradingTerminal ? 'w-3.5 h-3.5' : 'w-4 h-4')}
              style={{ background: 'linear-gradient(135deg, #ffb300, #42a5f5)' }}
              aria-hidden
            />
            <button
              type="button"
              onClick={() => setSymbolPickerOpen((o) => !o)}
              className="flex items-center gap-1 hover:bg-white/[0.05] py-1 pl-0 pr-0.5 rounded-lg transition-colors min-w-0"
            >
              <span
                className={clsx(
                  'font-bold text-text-primary font-mono truncate',
                  isTradingTerminal ? 'text-xs' : 'text-sm',
                )}
              >
                {selectedSymbol}
              </span>
              {!isTradingTerminal ? (
                <ChevronDown
                  size={14}
                  className={clsx('text-text-tertiary shrink-0 transition-transform', symbolPickerOpen && 'rotate-180')}
                />
              ) : (
                <ChevronDown
                  size={12}
                  className={clsx('text-text-tertiary shrink-0 transition-transform', symbolPickerOpen && 'rotate-180')}
                />
              )}
            </button>
            {symbolPickerOpen && (
              <div className="absolute top-full left-0 z-50 w-64 mt-1 rounded-lg border border-border-primary shadow-2xl bg-bg-secondary overflow-hidden">
                <OrderPanelSymbolPicker
                  onPick={(sym) => {
                    setSelectedSymbol(sym);
                    setSymbolPickerOpen(false);
                  }}
                />
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end shrink-0">
          <div className="flex items-center gap-1">
            <span
              className={clsx('font-bold', isTradingTerminal ? 'text-[9px]' : 'text-[10px]')}
              style={{ color: marketStatus.isOpen ? '#55a630' : '#f57c00' }}
            >
              {marketStatus.isOpen ? 'OPEN' : 'CLOSED'}
            </span>
            {isConnected ? (
              <Wifi size={isTradingTerminal ? 11 : 12} className="text-[#55a630]" />
            ) : (
              <WifiOff size={isTradingTerminal ? 11 : 12} className="text-[#f57c00]" />
            )}
          </div>
        </div>
      </div>

      {isTradingTerminal ? (
        <div className="h-px w-full shrink-0 bg-accent" aria-hidden />
      ) : null}

      <div
        className={clsx('flex-1 min-h-0 flex flex-col bg-bg-base', isTradingTerminal && 'overflow-hidden')}
      >
        <div
          className={clsx(
            'min-h-0',
            isTradingTerminal
              ? 'flex-1 overflow-y-auto overscroll-y-contain'
              : 'flex-1 overflow-y-auto min-h-0',
          )}
        >
          <div className={pad}>
          {/* Market / Pending tabs */}
          <div className="flex rounded-md overflow-hidden bg-bg-secondary border border-border-primary">
            {(['market', 'pending'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setOrderTab(t)}
                className={clsx('flex-1 font-semibold capitalize transition-all', tabPad)}
                style={{
                  background: orderTab === t ? 'var(--bg-hover)' : 'transparent',
                  color: orderTab === t ? 'var(--text-primary)' : 'var(--text-tertiary)',
                  borderBottom:
                    orderTab === t
                      ? `2px solid ${isTradingTerminal ? '#2962FF' : '#55a630'}`
                      : '2px solid transparent',
                }}
              >
                {t}
              </button>
            ))}
          </div>

          {/* Sell / Buy buttons */}
          <div className={clsx('grid grid-cols-2', isTradingTerminal ? 'gap-1.5' : 'gap-2')}>
             <button
                type="button"
                onClick={() => setSide('sell')}
                className={clsx(obPad, 'rounded-lg flex flex-col items-center justify-center transition-all duration-150 active:scale-[0.98]')}
                style={{
                  background: side === 'sell' ? 'rgba(239,83,80,0.15)' : 'var(--bg-secondary)',
                  border: side === 'sell' ? '1px solid #ef5350' : '1px solid var(--border-primary)',
                  color: side === 'sell' ? '#ef5350' : 'var(--text-secondary)',
                }}
             >
                <div className={clsx('font-bold uppercase tracking-wider', isTradingTerminal ? 'text-[10px] mb-0' : 'text-sm mb-0.5')}>Sell</div>
                <div className={clsx('font-mono font-bold', isTradingTerminal ? 'text-[13px]' : 'text-[15px]', side === 'sell' && 'text-red-400', priceStale && 'opacity-40')}>{tick ? userBid.toFixed(digits) : '---'}</div>
                <div className={clsx('text-text-tertiary', isTradingTerminal ? 'text-[8px] mt-0.5' : 'text-[9px] mt-1')}>Bid</div>
             </button>
             <button
                type="button"
                onClick={() => setSide('buy')}
                className={clsx(obPad, 'rounded-lg flex flex-col items-center justify-center transition-all duration-150 active:scale-[0.98]')}
                style={{
                  background: side === 'buy' ? 'rgba(85,166,48,0.15)' : 'var(--bg-secondary)',
                  border: side === 'buy' ? '1px solid #55a630' : '1px solid var(--border-primary)',
                  color: side === 'buy' ? '#55a630' : 'var(--text-secondary)',
                }}
             >
                <div className={clsx('font-bold uppercase tracking-wider', isTradingTerminal ? 'text-[10px] mb-0' : 'text-sm mb-0.5')}>Buy</div>
                <div className={clsx('font-mono font-bold', isTradingTerminal ? 'text-[13px]' : 'text-[15px]', side === 'buy' && 'text-[#55a630]', priceStale && 'opacity-40')}>{tick ? userAsk.toFixed(digits) : '---'}</div>
                <div className={clsx('text-text-tertiary', isTradingTerminal ? 'text-[8px] mt-0.5' : 'text-[9px] mt-1')}>Ask</div>
             </button>
          </div>

          {/* Pending-order trigger price (only on the Pending tab). The
              actual order_type sent to the backend is `limit` or `stop`
              depending on which sub-tab the trader picked. */}
          {orderTab === 'pending' && (
            <div className="mt-2 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] uppercase tracking-wider text-text-tertiary">
                  Pending type
                </span>
                <div className="inline-flex rounded-md overflow-hidden border border-border-primary">
                  {(['limit', 'stop'] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setPendingType(t)}
                      className={clsx(
                        'px-2.5 py-1 text-[11px] font-semibold capitalize transition-colors',
                        pendingType === t
                          ? 'bg-accent text-white'
                          : 'bg-bg-secondary text-text-secondary hover:text-text-primary',
                      )}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              <label className="block">
                <span className="text-[10px] uppercase tracking-wider text-text-tertiary">
                  Trigger price
                </span>
                <input
                  type="number"
                  inputMode="decimal"
                  step={1 / Math.pow(10, digits)}
                  min={0}
                  value={pendingPrice}
                  onChange={(e) => setPendingPrice(e.target.value)}
                  placeholder={tick ? (side === 'buy' ? userAsk : userBid).toFixed(digits) : '0.00'}
                  className={clsx(
                    'w-full mt-1 px-2.5 py-1.5 rounded-md font-mono text-sm bg-bg-input border text-text-primary',
                    pendingPrice && !pendingPriceValid
                      ? 'border-sell'
                      : 'border-border-primary',
                  )}
                />
              </label>
              <p className="text-[10px] text-text-tertiary leading-snug">
                {pendingType === 'limit'
                  ? side === 'buy'
                    ? 'Buy Limit — fills when price drops to your trigger.'
                    : 'Sell Limit — fills when price rises to your trigger.'
                  : side === 'buy'
                    ? 'Buy Stop — fills when price rises through your trigger (breakout).'
                    : 'Sell Stop — fills when price falls through your trigger (breakdown).'}
              </p>
            </div>
          )}

          {/* Spread — or a stale warning if the price stream has stalled. */}
          {tick && (
             <div className={clsx('flex items-center justify-center', isTradingTerminal ? '-mt-1' : '-mt-2')}>
                <span className={clsx('font-mono px-2 py-0.5 rounded-full border',
                  isTradingTerminal ? 'text-[9px]' : 'text-[10px]',
                  priceStale
                    ? 'bg-amber-500/10 text-amber-500 border-amber-500/25'
                    : 'bg-bg-secondary text-text-tertiary border-border-primary')}>
                  {priceStale ? '⚠ Price stale — reconnecting…' : `Spread: ${userSpreadPips.toFixed(1)}`}
                </span>
             </div>
          )}

          {/* SL / TP toggles */}
          <div className={clsx('flex items-center', isTradingTerminal ? 'gap-3 pt-1' : 'gap-5 pt-2')}>
            <label className="flex items-center gap-2 cursor-pointer">
              <div
                onClick={() => { setSlEnabled((p) => !p); if (slEnabled) setStopLoss(''); }}
                className="w-8 h-[18px] rounded-full relative transition-colors cursor-pointer border border-border-primary"
                style={{ background: slEnabled ? '#ef5350' : 'var(--bg-secondary)' }}
              >
                <div className="absolute top-[3px] w-2.5 h-2.5 rounded-full bg-white transition-all shadow-sm" style={{ left: slEnabled ? '18px' : '3px' }} />
              </div>
              <span className="text-[10px] uppercase font-semibold text-text-secondary">SL</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <div
                onClick={() => { setTpEnabled((p) => !p); if (tpEnabled) setTakeProfit(''); }}
                className="w-8 h-[18px] rounded-full relative transition-colors cursor-pointer border border-border-primary"
                style={{ background: tpEnabled ? '#55a630' : 'var(--bg-secondary)' }}
              >
                <div className="absolute top-[3px] w-2.5 h-2.5 rounded-full bg-white transition-all shadow-sm" style={{ left: tpEnabled ? '18px' : '3px' }} />
              </div>
              <span className="text-[10px] uppercase font-semibold text-text-secondary">TP</span>
            </label>
            {activeAccount && (
              <LeveragePicker
                account={activeAccount}
                onChanged={() => { void refreshAccount(); }}
              />
            )}
          </div>

          {/* Volume */}
          <div className={isTradingTerminal ? 'pt-1' : 'pt-2'}>
            <div className={clsx('flex items-center justify-between', isTradingTerminal ? 'mb-1' : 'mb-1.5')}>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">Volume</span>
              <div className="flex gap-0.5">
                <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-bg-hover text-text-secondary">Lots</span>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-medium text-text-tertiary hover:text-text-secondary cursor-pointer transition-colors">Units</span>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => adjustLots(-0.01)}
                className={clsx(volBtn, 'rounded-lg flex items-center justify-center transition-colors text-text-secondary hover:text-text-primary bg-bg-secondary border border-border-primary')}
              >
                <Minus size={isTradingTerminal ? 12 : 14} />
              </button>
              <input
                type="text"
                inputMode="decimal"
                value={lots}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === '' || /^\d*\.?\d{0,2}$/.test(v)) setLots(v);
                }}
                onBlur={() => {
                  const n = parseFloat(lots);
                  if (!Number.isFinite(n) || n <= 0) setLots('0.01');
                  else setLots(n.toFixed(2));
                }}
                className={clsx('flex-1 text-center font-mono font-bold rounded-lg focus:outline-none bg-bg-secondary border border-border-primary text-text-primary', volIn)}
              />
              <button
                type="button"
                onClick={() => adjustLots(0.01)}
                className={clsx(volBtn, 'rounded-lg flex items-center justify-center transition-colors text-text-secondary hover:text-text-primary bg-bg-secondary border border-border-primary')}
              >
                <Plus size={isTradingTerminal ? 12 : 14} />
              </button>
            </div>
          </div>

          {/* SL input */}
          {slEnabled && (
            <div className="pt-2">
              <span className="text-[10px] font-bold uppercase tracking-wider text-red-400 mb-1.5 block">Stop Loss</span>
              <input
                type="number"
                value={stopLoss}
                onChange={(e) => setStopLoss(e.target.value)}
                step={execPrice > 100 ? 0.01 : 0.00001}
                placeholder={`e.g. ${(execPrice * (side === 'buy' ? 0.99 : 1.01)).toFixed(digits)}`}
                className="w-full text-sm font-mono py-2.5 px-3 rounded-lg focus:outline-none bg-bg-secondary border border-red-500/30 text-red-400"
              />
            </div>
          )}

          {/* TP input */}
          {tpEnabled && (
            <div className="pt-2">
              <span className="text-[10px] font-bold uppercase tracking-wider text-[#55a630] mb-1.5 block">Take Profit</span>
              <input
                type="number"
                value={takeProfit}
                onChange={(e) => setTakeProfit(e.target.value)}
                step={execPrice > 100 ? 0.01 : 0.00001}
                placeholder={`e.g. ${(execPrice * (side === 'buy' ? 1.02 : 0.98)).toFixed(digits)}`}
                className="w-full text-sm font-mono py-2.5 px-3 rounded-lg focus:outline-none bg-bg-secondary border border-[#55a630]/30 text-[#55a630]"
              />
            </div>
          )}

          {/* Trade Insurance — only on market orders, and only when the
              account's TYPE has insurance enabled (admin per-type gate,
              Mig 0070). Default true when the flag is absent so legacy
              payloads keep showing the picker. */}
          {orderTab === 'market' && activeAccount &&
            (activeAccount.account_group?.insurance_enabled ?? true) && (
            <div className="pt-2">
              <InsuranceTierPicker
                accountId={activeAccount.id}
                symbol={selectedSymbol}
                side={side}
                // Quote on EFFECTIVE (cent-scaled) lots so the fee + the
                // coverage cap line up with the actual position the
                // backend opens. Display-side ¢ conversion is handled by
                // the picker's isCent prop.
                lots={effectiveLots}
                leverage={(activeAccount as any).leverage || 100}
                stopLoss={slEnabled && stopLoss ? parseFloat(stopLoss) : undefined}
                takeProfit={tpEnabled && takeProfit ? parseFloat(takeProfit) : undefined}
                onSelect={setInsuranceSelection}
                isCent={isCentAccount(activeAccount)}
              />
            </div>
          )}

          {!isTradingTerminal ? (
            <>
              <div className="py-2" />
              <div className="rounded-xl p-3 space-y-2 bg-bg-secondary border border-border-primary">
                {[
                  {
                    label: orderTab === 'pending' ? 'Trigger Price' : 'Exec. Price',
                    value: orderTab === 'pending'
                      ? (pendingPriceValid && Number.isFinite(pendingPriceNum)
                          ? pendingPriceNum.toFixed(digits)
                          : '—')
                      : (execPrice > 0 ? execPrice.toFixed(digits) : '—'),
                    color: 'var(--text-primary)',
                  },
                  // Cent-account display rebrand — Mig 0068. Same helper
                  // the dashboard + terminal status bar use so a cent
                  // account sees ¢ here too.
                  { label: 'Margin Required', value: fmtAccountMoney(marginRequired, isCentAccount(activeAccount)), color: !hasEnoughMargin ? '#ef5350' : 'var(--text-secondary)' },
                  { label: 'Free Margin', value: fmtAccountMoney(freeMargin, isCentAccount(activeAccount)), color: !hasEnoughMargin ? '#ef5350' : '#55a630' },
                  { label: 'Feed', value: isConnected ? '● Connected' : '○ Disconnected', color: isConnected ? '#55a630' : '#f57c00' },
                ].map((row) => (
                  <div key={row.label} className="flex items-center justify-between">
                    <span className="text-[11px] text-text-tertiary">{row.label}</span>
                    <span className="text-[11px] font-mono font-semibold" style={{ color: row.color }}>{row.value}</span>
                  </div>
                ))}
                {!hasEnoughMargin && (
                  <div className="text-[11px] text-red-500 font-bold text-center pt-2 mt-2" style={{ borderTop: '1px solid rgba(239,83,80,0.15)' }}>
                    ⚠ Insufficient margin
                  </div>
                )}
              </div>
              <div className="py-2" />
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!hasEnoughMargin || !activeAccount || (orderTab === 'market' && !marketStatus.isOpen) || !pendingPriceValid}
                className="w-full py-4 rounded-xl text-[15px] font-black tracking-wide uppercase transition-transform duration-75 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.96]"
                style={{
                  background: side === 'buy' ? '#55a630' : '#ef5350',
                  color: '#fff',
                  boxShadow: side === 'buy' ? '0 4px 20px rgba(85,166,48,0.2)' : '0 4px 20px rgba(239,83,80,0.2)',
                }}
              >
                {`${side === 'buy' ? 'Buy' : 'Sell'} ${selectedSymbol}`}
              </button>
              {!marketStatus.isOpen && orderTab === 'market' && (
                <div className="mt-4 rounded-lg px-3 py-2 text-[11px] text-red-400 leading-snug text-center" style={{ background: 'rgba(239,83,80,0.1)', border: '1px solid rgba(239,83,80,0.2)' }}>
                  {marketStatus.reason}
                </div>
              )}
            </>
          ) : null}
          </div>
        </div>

        {isTradingTerminal ? (
          <div className="shrink-0 border-t border-border-primary bg-bg-secondary px-2 pt-2 pb-2 space-y-1.5">
            <div className="flex items-center justify-between py-1.5 px-2 rounded-md bg-card border border-border-primary">
              <span className="text-[10px] text-text-tertiary">
                {orderTab === 'pending' ? 'Trigger Price' : 'Exec. Price'}
              </span>
              <span className="text-xs font-mono font-semibold text-text-primary">
                {orderTab === 'pending'
                  ? (pendingPriceValid && Number.isFinite(pendingPriceNum)
                      ? pendingPriceNum.toFixed(digits)
                      : '—')
                  : (execPrice > 0 ? execPrice.toFixed(digits) : '—')}
              </span>
            </div>
            <div className="flex items-center justify-between gap-1 px-1 text-[9px] text-text-tertiary">
              <span className="truncate">Mrgn {fmtAccountMoney(marginRequired, isCentAccount(activeAccount))}</span>
              <span className={clsx('shrink-0 font-mono', hasEnoughMargin ? 'text-[#55a630]' : 'text-[#ef5350]')}>
                Free {fmtAccountMoney(freeMargin, isCentAccount(activeAccount))}
              </span>
              <span
                className={clsx('shrink-0 font-mono', isConnected ? 'text-[#55a630]' : 'text-[#f57c00]')}
                title={isConnected ? 'Feed connected' : 'Feed disconnected'}
              >
                {isConnected ? '●' : '○'}
              </span>
            </div>
            {!hasEnoughMargin && (
              <div className="text-[10px] text-red-500 font-semibold text-center leading-tight">Insufficient margin</div>
            )}
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!hasEnoughMargin || !activeAccount || (orderTab === 'market' && !marketStatus.isOpen)}
              className="w-full py-2.5 rounded-lg text-sm font-black tracking-wide uppercase transition-transform duration-75 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.96]"
              style={{
                background: side === 'buy' ? '#55a630' : '#ef5350',
                color: '#fff',
                boxShadow: side === 'buy' ? '0 2px 12px rgba(85,166,48,0.2)' : '0 2px 12px rgba(239,83,80,0.2)',
              }}
            >
              {`${side === 'buy' ? 'Buy' : 'Sell'} ${selectedSymbol}`}
            </button>
            {!marketStatus.isOpen && orderTab === 'market' && (
              <div
                className="rounded px-2 py-1 text-[10px] text-red-400 leading-snug text-center"
                style={{ background: 'rgba(239,83,80,0.1)', border: '1px solid rgba(239,83,80,0.2)' }}
              >
                {marketStatus.reason}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Dropdown that lets the trader change leverage up to the per-user effective
 * cap. Reads account_group.effective_max_leverage (smaller of group ceiling
 * and KYC gate), falling back to max_leverage, then leverage_default for
 * legacy responses. Persists via PATCH /accounts/:id/leverage.
 */
function LeveragePicker({
  account,
  onChanged,
}: {
  account: TradingAccount;
  onChanged: () => void;
}) {
  const setActiveAccount = useTradingStore((s) => s.setActiveAccount);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // leverage_default is the headline value shown in marketing; the real cap
  // is effective_max_leverage. Falling back through max_leverage covers
  // older /accounts payloads that haven't been redeployed yet.
  const maxLev =
    account.account_group?.effective_max_leverage
    ?? account.account_group?.max_leverage
    ?? account.account_group?.leverage_default
    ?? account.leverage;
  const presets = useMemo(() => {
    const base = [1, 10, 25, 50, 100, 200, 300, 400, 500, 1000];
    const filtered = base.filter((v) => v <= maxLev);
    if (!filtered.includes(maxLev)) filtered.push(maxLev);
    return Array.from(new Set(filtered)).sort((a, b) => a - b);
  }, [maxLev]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const apply = async (lev: number) => {
    if (lev === account.leverage) { setOpen(false); return; }
    setSaving(true);
    try {
      await api.patch(`/accounts/${account.id}/leverage`, { leverage: lev });
      // Optimistic local update so the pill reflects the new value immediately.
      setActiveAccount({ ...account, leverage: lev });
      toast.success(`Leverage set to 1:${lev}`);
      onChanged();
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not change leverage');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ml-auto relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        disabled={saving}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-mono font-semibold text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-50"
        title={`Max 1:${maxLev} — click to change`}
      >
        1:{account.leverage}
        <ChevronDown size={10} />
      </button>
      {open && (
        <div
          className="absolute right-0 bottom-full mb-1 w-28 rounded-lg border border-border-primary shadow-xl py-1"
          style={{
            backgroundColor: 'var(--bg-card)',
            zIndex: 1000,
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
          }}
        >
          <div className="px-2 pb-1 pt-0.5 text-[9px] uppercase tracking-wider text-text-tertiary font-bold border-b border-border-primary mb-1">
            Max 1:{maxLev}
          </div>
          <div className="max-h-[220px] overflow-y-auto">
            {presets.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => void apply(v)}
                className={clsx(
                  'w-full text-left px-2 py-1 text-[11px] font-mono transition-colors',
                  v === account.leverage
                    ? 'bg-[#55a630]/15 text-[#55a630] font-bold'
                    : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                )}
              >
                1:{v}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
