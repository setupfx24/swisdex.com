'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { clsx } from 'clsx';
import { Maximize2, Minimize2, Search, X } from 'lucide-react';
import { useUIStore } from '@/stores/uiStore';
import { TERMINAL_RESIZE, maxBottomPanelHeightPx } from '@/lib/terminalLayout';
import PanelResizeHandle from '@/components/trading/PanelResizeHandle';
import { useTradingStore, InstrumentInfo } from '@/stores/tradingStore';
import toast from 'react-hot-toast';
import { sounds, unlockAudio } from '@/lib/sounds';
import { getMarketStatus } from '@/lib/marketHours';
import { setPersistedTradingAccountId, tradingTerminalUrl } from '@/lib/tradingNav';
import Watchlist from '@/components/trading/Watchlist';
import InstrumentsTable from '@/components/trading/InstrumentsTable';
import OrderPanel from '@/components/trading/OrderPanel';
import RiskCalculator from '@/components/trading/RiskCalculator';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import PositionsPanel from '@/components/trading/PositionsPanel';
import { ActiveAccountBadge } from '@/components/trading/ActiveAccountBadge';
import TerminalLeftRail, { type TerminalSpaceId } from '@/components/trading/TerminalLeftRail';

// Client 2026-06-19 chose TradingView's polished Advanced Chart over the
// broker-fed native chart, accepting that its prices are TradingView's own
// Full TradingView Charting Library fed by OUR engine data (candles match the
// running P&L). The licensed library lives in public/charting_library/ and the
// datafeed in src/lib/charting/datafeed.ts. Revert to
// '@/components/charts/AdvancedChart' for the public OANDA widget.
const LiveChart = dynamic(() => import('@/components/charts/ChartingLibraryChart'), { ssr: false });
// In-house news panel (ForexFactory economic events + live forex headlines),
// replacing the previous TradingView news timeline embed. (client 2026-07-09)
const MarketNewsPanel = dynamic(() => import('@/components/charts/MarketNewsPanel'), {
  ssr: false,
});

const ORDER_MIN = 250;
const ORDER_MAX = 560;
const MARKETS_MIN = 560;
const MARKETS_MAX = 1200;
const BOTTOM_MIN = 160;

export default function TradingTerminalPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const accountId = searchParams.get('account');
  const {
    orderPanelWidth,
    bottomPanelHeight,
    terminalMarketsOpen,
    terminalNewsOpen,
    setTerminalMarketsOpen,
    setTerminalNewsOpen,
    setOrderPanelWidth,
    setBottomPanelHeight,
    toggleTerminalMarkets,
  } = useUIStore();

  useDocumentTitle();

  const [opW, setOpW] = useState(orderPanelWidth);
  const [bpH, setBpH] = useState(bottomPanelHeight);
  const [isMobile, setIsMobile] = useState(false);

  /** Snapshot at pointer-down: stable clamps while store updates mid-drag. */
  const layoutDragStartRef = useRef({ op: 0, bp: 0, vw: 0, colH: 0 });
  const centerColumnRef = useRef<HTMLDivElement>(null);
  const bottomRestoreRef = useRef(320);
  const [activeSpace, setActiveSpace] = useState<TerminalSpaceId>('balanced');
  const [bottomCollapsed, setBottomCollapsed] = useState(false);
  const [chartExpanded, setChartExpanded] = useState(false);
  const [terminalCalcOpen, setTerminalCalcOpen] = useState(false);

  const snapshotLayout = useCallback(() => {
    const s = useUIStore.getState();
    const rect = centerColumnRef.current?.getBoundingClientRect();
    const col =
      rect?.height ??
      (typeof window !== 'undefined' ? window.innerHeight - 8 : 0);
    layoutDragStartRef.current = {
      op: s.orderPanelWidth,
      bp: s.bottomPanelHeight,
      vw: typeof window !== 'undefined' ? window.innerWidth : 0,
      colH: Math.max(120, col),
    };
  }, []);

  /** Between chart and order+markets rail: drag right widens the rail. */
  const onChartRailDrag = useCallback(
    (dx: number) => {
      const { op, vw } = layoutDragStartRef.current;
      const hardMax = terminalMarketsOpen ? MARKETS_MAX : ORDER_MAX;
      const hardMin = terminalMarketsOpen ? MARKETS_MIN : ORDER_MIN;
      const maxOp = Math.min(
        hardMax,
        vw - TERMINAL_RESIZE.handlesSlack - TERMINAL_RESIZE.chartMinWidth,
      );
      const next = Math.max(hardMin, Math.min(maxOp, op - dx));
      setOpW(next);
      setOrderPanelWidth(next);
    },
    [setOrderPanelWidth, terminalMarketsOpen],
  );

  const onBottomDrag = useCallback(
    (dy: number) => {
      const { bp, colH } = layoutDragStartRef.current;
      const maxBp = maxBottomPanelHeightPx(colH);
      const next = Math.max(BOTTOM_MIN, Math.min(maxBp, bp - dy));
      setBpH(next);
      setBottomPanelHeight(next);
    },
    [setBottomPanelHeight],
  );

  useEffect(() => {
    setOpW(orderPanelWidth);
  }, [orderPanelWidth]);

  /** Auto-size the right rail when switching to/from Markets view. */
  const orderWidthBeforeMarketsRef = useRef<number | null>(null);
  useEffect(() => {
    if (terminalMarketsOpen) {
      if (orderWidthBeforeMarketsRef.current == null) {
        orderWidthBeforeMarketsRef.current = opW;
      }
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1600;
      const target = Math.min(MARKETS_MAX, Math.max(MARKETS_MIN, Math.round(vw * 0.55)));
      setOpW(target);
      setOrderPanelWidth(target);
    } else if (orderWidthBeforeMarketsRef.current != null) {
      const restored = orderWidthBeforeMarketsRef.current;
      orderWidthBeforeMarketsRef.current = null;
      setOpW(restored);
      setOrderPanelWidth(restored);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalMarketsOpen]);

  useEffect(() => {
    setBpH(bottomPanelHeight);
  }, [bottomPanelHeight]);

  useEffect(() => {
    if (!bottomCollapsed) bottomRestoreRef.current = bottomPanelHeight;
  }, [bottomPanelHeight, bottomCollapsed]);

  const applySpace = useCallback(
    (id: TerminalSpaceId) => {
      setActiveSpace(id);
      setBottomCollapsed(false);
      if (id === 'balanced') {
        setOrderPanelWidth(340);
        setOpW(340);
        setBottomPanelHeight(320);
        setBpH(320);
      } else if (id === 'chart') {
        setOrderPanelWidth(ORDER_MIN);
        setOpW(ORDER_MIN);
        setBottomPanelHeight(200);
        setBpH(200);
      } else {
        setOrderPanelWidth(480);
        setOpW(480);
        setBottomPanelHeight(360);
        setBpH(360);
      }
    },
    [setOrderPanelWidth, setBottomPanelHeight],
  );

  const onToggleBottomPanel = useCallback(() => {
    const s = useUIStore.getState();
    if (bottomCollapsed) {
      const h = Math.max(BOTTOM_MIN, bottomRestoreRef.current);
      setBottomPanelHeight(h);
      setBpH(h);
      setBottomCollapsed(false);
    } else {
      bottomRestoreRef.current = s.bottomPanelHeight;
      setBottomPanelHeight(BOTTOM_MIN);
      setBpH(BOTTOM_MIN);
      setBottomCollapsed(true);
    }
  }, [bottomCollapsed, setBottomPanelHeight]);

  const onFocusSymbolSearch = useCallback(() => {
    setTerminalNewsOpen(false);
    setTerminalMarketsOpen(true);
    setChartExpanded(false);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.querySelector<HTMLInputElement>('[data-terminal-symbol-search]')?.focus();
      });
    });
  }, [setTerminalMarketsOpen, setTerminalNewsOpen]);

  const onPanelsSelectMarkets = useCallback(() => {
    setTerminalNewsOpen(false);
    setChartExpanded(false);
    setTerminalCalcOpen(false);
    setTerminalMarketsOpen(true);
  }, [setTerminalMarketsOpen, setTerminalNewsOpen]);

  const onPanelsSelectOrder = useCallback(() => {
    setTerminalNewsOpen(false);
    setChartExpanded(false);
    setTerminalCalcOpen(false);
    setTerminalMarketsOpen(false);
  }, [setTerminalMarketsOpen, setTerminalNewsOpen]);

  const onExpandFullChartFromRail = useCallback(() => {
    setTerminalNewsOpen(false);
    setTerminalMarketsOpen(false);
    setTerminalCalcOpen(false);
    setChartExpanded(true);
  }, [setTerminalMarketsOpen, setTerminalNewsOpen]);

  const onPanelsSelectNews = useCallback(() => {
    setChartExpanded(false);
    setTerminalCalcOpen(false);
    setTerminalNewsOpen(true);
  }, [setTerminalNewsOpen]);

  const onPanelsSelectCalc = useCallback(() => {
    setTerminalNewsOpen(false);
    setChartExpanded(false);
    setTerminalMarketsOpen(false);
    setTerminalCalcOpen(true);
  }, [setTerminalMarketsOpen, setTerminalNewsOpen]);
  const [lotSize, setLotSize] = useState('0.01');
  const [chartTabs, setChartTabs] = useState<string[]>([]);
  // orderSubmitting removed — MT5-style: never block rapid-fire clicks
  const [mobileSymbolSearch, setMobileSymbolSearch] = useState(false);
  const [mobileSearchQuery, setMobileSearchQuery] = useState('');
  const mobileSearchRef = useRef<HTMLInputElement>(null);

  const {
    selectedSymbol,
    prices,
    instruments,
    setSelectedSymbol,
    activeAccount,
    placeOrder,
  } = useTradingStore();

  const instrumentInfo = instruments.find((i: InstrumentInfo) => i.symbol === selectedSymbol);
  const mobileMarketStatus = getMarketStatus(selectedSymbol, (instrumentInfo as any)?.segment);
  /** Default `chart` so Trade opens chart + buy/sell (not symbol list only). Watchlist tab still passes view=watchlist. */
  const mobileView = searchParams.get('view') || 'chart';

  useEffect(() => {
    if (accountId) setPersistedTradingAccountId(accountId);
  }, [accountId]);

  useEffect(() => {
    if (!accountId) router.replace('/trading');
  }, [accountId, router]);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  useEffect(() => {
    if (!chartExpanded || !isMobile) return;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, [chartExpanded, isMobile]);

  useEffect(() => {
    if (!chartExpanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setChartExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chartExpanded]);

  // Sync selected symbol with tabs — use functional update to avoid stale closure duplicates
  useEffect(() => {
    if (selectedSymbol) {
      setChartTabs(prev => prev.includes(selectedSymbol) ? prev : [...prev, selectedSymbol]);
    }
  }, [selectedSymbol]);

  const removeTab = (e: React.MouseEvent, symbol: string) => {
    e.stopPropagation();
    const nextTabs = chartTabs.filter(s => s !== symbol);
    setChartTabs(nextTabs);
    if (selectedSymbol === symbol && nextTabs.length > 0) {
      setSelectedSymbol(nextTabs[nextTabs.length - 1]);
    }
  };

  if (!accountId) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-0 bg-bg-base">
        <p className="text-sm text-text-tertiary">Choose an account to trade…</p>
      </div>
    );
  }

  if (isMobile) {
    const digits = instruments.find((i: InstrumentInfo) => i.symbol === selectedSymbol)?.digits ?? 5;
    const price = prices[selectedSymbol];

    const handleLotChange = (val: number) => {
      const current = parseFloat(lotSize) || 0;
      const next = Math.max(0.01, +(current + val).toFixed(2));
      setLotSize(next.toFixed(2));
    };

    const placeMarketOrder = (side: 'buy' | 'sell') => {
      unlockAudio();
      if (!activeAccount) {
        toast.error('No account selected');
        return;
      }
      if (!mobileMarketStatus.isOpen) {
        toast.error(mobileMarketStatus.reason || 'Market is closed');
        return;
      }
      if (!selectedSymbol?.trim()) {
        toast.error('Select a symbol');
        return;
      }
      const lots = parseFloat(lotSize);
      if (!Number.isFinite(lots) || lots <= 0) {
        toast.error('Invalid lot size');
        return;
      }
      // MT5-style: instant sound + optimistic position, no button disable
      sounds.orderPlaced();
      toast.success(`${side.toUpperCase()} ${lotSize} ${selectedSymbol}`, { duration: 1500 });
      placeOrder({
        account_id: activeAccount.id,
        symbol: selectedSymbol,
        side,
        order_type: 'market',
        lots,
      }).catch((e: unknown) => {
        toast.error(e instanceof Error ? e.message : 'Order failed');
      });
    };

    return (
      <div className="flex-1 flex flex-col overflow-hidden min-h-0 pb-[70px] scrollbar-none bg-bg-base">
        <div className="flex-1 min-h-0 overflow-hidden relative flex flex-col scrollbar-none">
          {mobileView === 'watchlist' && <Watchlist />}
          {mobileView === 'news' && (
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden bg-bg-primary">
              <div className="shrink-0 flex items-center justify-between gap-2 px-3 py-2 border-b border-border-glass bg-bg-secondary">
                <button
                  type="button"
                  onClick={() => router.push(tradingTerminalUrl(accountId, { view: 'chart' }))}
                  className="text-xs font-semibold text-buy"
                >
                  ← Chart
                </button>
                <span className="text-xs font-bold text-text-primary uppercase tracking-wider">Live news</span>
                <span className="w-14" aria-hidden />
              </div>
              <div className="flex-1 min-h-0">
                <MarketNewsPanel className="h-full" />
              </div>
            </div>
          )}
          {mobileView === 'chart' && (
            <div className="h-full flex flex-col min-h-0">
              {/* Dynamic Chart Tabs Header */}
              {!chartExpanded ? (
              <div className="flex items-center gap-1.5 px-3 py-2 bg-bg-secondary border-b border-border-glass overflow-x-auto no-scrollbar scrollbar-none">
                {chartTabs.map((symbol) => (
                  <button
                    key={symbol}
                    onClick={() => setSelectedSymbol(symbol)}
                    className={clsx(
                      'px-4 py-1.5 rounded-xl text-xs font-extrabold transition-all border whitespace-nowrap flex items-center gap-2 group',
                      symbol === selectedSymbol
                        ? 'bg-bg-primary text-text-primary border-border-glass shadow-sm'
                        : 'bg-transparent text-text-tertiary border-transparent hover:text-text-primary'
                    )}
                  >
                    {symbol}
                    <div
                      onClick={(e) => removeTab(e, symbol)}
                      className="p-0.5 rounded-md hover:bg-sell/10 hover:text-sell transition-colors opacity-60 group-hover:opacity-100"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M18 6 6 18M6 6l12 12"/></svg>
                    </div>
                  </button>
                ))}

                <button
                  type="button"
                  onClick={() => { setMobileSymbolSearch(true); setMobileSearchQuery(''); setTimeout(() => mobileSearchRef.current?.focus(), 100); }}
                  className="shrink-0 w-10 h-[34px] flex items-center justify-center rounded-xl bg-bg-hover/80 text-text-primary border border-border-glass hover:bg-buy/10 transition-all active:scale-95"
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14" /></svg>
                </button>
                <button
                  type="button"
                  onClick={() => router.push(tradingTerminalUrl(accountId, { view: 'news' }))}
                  className="shrink-0 px-3 h-[34px] rounded-xl bg-bg-hover/80 text-text-primary border border-border-glass text-[10px] font-extrabold uppercase tracking-wide hover:bg-buy/10 transition-all active:scale-95"
                >
                  News
                </button>
              </div>
              ) : null}

              {/* ── Mobile Symbol Search Overlay ── */}
              {mobileSymbolSearch && (
                <div className="fixed inset-0 z-[90] flex flex-col bg-bg-base">
                  {/* Search header */}
                  <div className="shrink-0 flex items-center gap-2 px-3 py-3 border-b border-border-glass bg-bg-secondary">
                    <div className="relative flex-1 min-w-0">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary" />
                      <input
                        ref={mobileSearchRef}
                        type="text"
                        value={mobileSearchQuery}
                        onChange={(e) => setMobileSearchQuery(e.target.value)}
                        placeholder="Search symbol..."
                        className="w-full pl-10 pr-3 py-2.5 text-sm rounded-xl border border-border-glass bg-bg-primary text-text-primary placeholder:text-text-tertiary outline-none focus:border-buy/50 focus:ring-1 focus:ring-buy/20"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => setMobileSymbolSearch(false)}
                      className="shrink-0 px-3 py-2.5 text-sm font-semibold text-text-secondary hover:text-text-primary transition-colors"
                    >
                      Cancel
                    </button>
                  </div>

                  {/* Filtered instrument list */}
                  <div className="flex-1 min-h-0 overflow-y-auto scrollbar-none">
                    {(() => {
                      const q = mobileSearchQuery.toLowerCase().trim();
                      const matched = instruments.filter((inst: InstrumentInfo) =>
                        q === '' ? true : inst.symbol.toLowerCase().includes(q) || (inst.segment || '').toLowerCase().includes(q)
                      );
                      if (matched.length === 0 && q !== '') {
                        return (
                          <div className="flex flex-col items-center justify-center py-20 gap-3">
                            <Search className="w-10 h-10 text-text-tertiary/40" />
                            <p className="text-sm text-text-tertiary">No symbols match &ldquo;{mobileSearchQuery}&rdquo;</p>
                          </div>
                        );
                      }
                      return matched.map((inst: InstrumentInfo) => {
                        const tick = prices[inst.symbol];
                        const isInTabs = chartTabs.includes(inst.symbol);
                        return (
                          <button
                            key={inst.symbol}
                            type="button"
                            onClick={() => {
                              setSelectedSymbol(inst.symbol);
                              setChartTabs(prev => prev.includes(inst.symbol) ? prev : [...prev, inst.symbol]);
                              setMobileSymbolSearch(false);
                            }}
                            className={clsx(
                              'w-full flex items-center justify-between gap-3 px-4 py-3.5 text-left transition-colors',
                              isInTabs ? 'bg-buy/[0.06]' : 'hover:bg-bg-hover active:bg-buy/5',
                            )}
                          >
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-base font-bold text-text-primary font-mono">{inst.symbol}</span>
                                {isInTabs && <span className="text-buy text-[10px] font-bold">OPEN</span>}
                              </div>
                              <p className="text-xs text-text-tertiary mt-0.5 truncate uppercase tracking-wide">
                                {inst.segment || ''}
                              </p>
                            </div>
                            <div className="shrink-0 flex items-center gap-3">
                              {tick ? (
                                <span className="text-sm font-mono font-bold tabular-nums text-text-primary">
                                  {tick.bid.toFixed(inst.digits ?? 5)}
                                </span>
                              ) : null}
                              {!isInTabs && (
                                <span className="text-buy text-xs font-semibold">+ Open</span>
                              )}
                            </div>
                          </button>
                        );
                      });
                    })()}
                  </div>
                </div>
              )}

              {!chartExpanded && activeAccount ? (
                <div className="sm:hidden shrink-0 px-3 py-1.5 border-b border-border-glass bg-bg-secondary/40">
                  <ActiveAccountBadge account={activeAccount} variant="compact" />
                </div>
              ) : null}

              <div
                className={clsx(
                  'flex flex-col flex-1 min-h-0 overflow-hidden bg-bg-primary',
                  chartExpanded &&
                    'fixed inset-0 z-[100] h-[100dvh] pt-[env(safe-area-inset-top,0px)] pb-[env(safe-area-inset-bottom,0px)]',
                )}
              >
                {chartExpanded ? (
                  <div className="shrink-0 flex items-center justify-between gap-2 px-3 py-2 border-b border-border-glass bg-bg-secondary">
                    <span className="text-sm font-bold text-text-primary truncate">{selectedSymbol || 'Chart'}</span>
                    <button
                      type="button"
                      onClick={() => setChartExpanded(false)}
                      className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-text-secondary border border-border-glass hover:bg-bg-hover hover:text-text-primary"
                    >
                      <Minimize2 className="w-4 h-4 shrink-0" aria-hidden />
                      Close
                    </button>
                  </div>
                ) : null}
                <div className="flex-1 min-h-0 min-w-0 overflow-hidden relative">
                  <LiveChart />
                </div>
              </div>

              {/* Refined Quick Trade Bottom Bar */}
              <div className="fixed bottom-[calc(4rem+max(0.5rem,env(safe-area-inset-bottom,0px)))] left-0 right-0 p-3 bg-bg-secondary/95 backdrop-blur-xl border-t border-border-glass z-50">
                {!mobileMarketStatus.isOpen && (
                  <div className="mb-2 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-sell/10 border border-sell/20">
                    <span className="text-[9px] font-bold text-sell uppercase tracking-wider">● CLOSED</span>
                    <span className="text-[10px] text-sell/80 truncate">{mobileMarketStatus.reason}</span>
                  </div>
                )}
                <div className="flex items-center gap-2 mt-1 h-[52px]">
                   {/* SELL button */}
                   <button
                     type="button"
                     disabled={!mobileMarketStatus.isOpen}
                     onClick={() => placeMarketOrder('sell')}
                     className="flex-1 h-full bg-sell rounded-xl flex flex-col items-center justify-center shadow-lg shadow-sell/20 active:scale-[0.96] transition-transform duration-75 disabled:opacity-50 disabled:pointer-events-none min-w-0"
                   >
                     <span className="text-white text-[14px] font-black uppercase tracking-[0.05em]">Sell</span>
                     <span className="text-white/70 text-[10px] font-mono font-bold leading-tight">{price?.bid.toFixed(digits) || '--'}</span>
                   </button>

                   {/* Lot size controls — center */}
                   <div className="shrink-0 flex flex-col items-center">
                      <span className="text-[8px] font-bold text-text-tertiary uppercase tracking-wider leading-none mb-1">Lots</span>
                      <div className="flex items-center gap-1">
                         <button
                           onClick={() => handleLotChange(-0.01)}
                           className="w-8 h-8 flex items-center justify-center rounded-lg bg-bg-primary border border-border-glass text-text-primary active:scale-90 transition-transform"
                         >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M5 12h14"/></svg>
                         </button>
                         <input
                           type="text"
                           inputMode="decimal"
                           value={lotSize}
                           onChange={(e) => {
                             const v = e.target.value;
                             if (v === '' || /^\d*\.?\d{0,2}$/.test(v)) setLotSize(v);
                           }}
                           onBlur={() => {
                             const n = parseFloat(lotSize);
                             if (!Number.isFinite(n) || n <= 0) setLotSize('0.01');
                             else setLotSize(n.toFixed(2));
                           }}
                           className="w-16 h-9 text-[15px] font-black font-mono text-center bg-bg-primary border-2 border-border-glass rounded-lg text-text-primary outline-none"
                         />
                         <button
                           onClick={() => handleLotChange(0.01)}
                           className="w-8 h-8 flex items-center justify-center rounded-lg bg-bg-primary border border-border-glass text-text-primary active:scale-90 transition-transform"
                         >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M12 5v14M5 12h14"/></svg>
                         </button>
                      </div>
                   </div>

                   {/* BUY button */}
                   <button
                     type="button"
                     disabled={!mobileMarketStatus.isOpen}
                     onClick={() => placeMarketOrder('buy')}
                     className="flex-1 h-full bg-buy rounded-xl flex flex-col items-center justify-center shadow-lg shadow-buy/20 active:scale-[0.96] transition-transform duration-75 disabled:opacity-50 disabled:pointer-events-none min-w-0"
                   >
                     <span className="text-white text-[14px] font-black uppercase tracking-[0.05em]">Buy</span>
                     <span className="text-white/70 text-[10px] font-mono font-bold leading-tight">{price?.ask.toFixed(digits) || '--'}</span>
                   </button>
                </div>
              </div>
            </div>
          )}
          {mobileView === 'order' && <PositionsPanel />}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex overflow-hidden min-h-0 relative pt-[env(safe-area-inset-top,0px)] bg-bg-base">
      <TerminalLeftRail
        activeSpace={activeSpace}
        onSpaceChange={applySpace}
        terminalMarketsOpen={terminalMarketsOpen}
        onToggleMarkets={() => toggleTerminalMarkets()}
        bottomPanelCollapsed={bottomCollapsed}
        onToggleBottomPanel={onToggleBottomPanel}
        onFocusSymbolSearch={onFocusSymbolSearch}
        chartExpanded={chartExpanded}
        terminalNewsOpen={terminalNewsOpen}
        onPanelsSelectMarkets={onPanelsSelectMarkets}
        onPanelsSelectOrder={onPanelsSelectOrder}
        onExpandFullChart={onExpandFullChartFromRail}
        onPanelsSelectNews={onPanelsSelectNews}
        terminalCalcOpen={terminalCalcOpen}
        onPanelsSelectCalc={onPanelsSelectCalc}
      />
      <div
        ref={centerColumnRef}
        className="flex-1 flex flex-col overflow-hidden min-w-0 min-h-0 relative z-0"
      >
        <div className="flex-1 min-h-0 flex overflow-hidden">
          <div
            className={clsx(
              'flex flex-col overflow-hidden bg-bg-base flex-1 min-w-0 min-h-0 relative isolate z-0',
              chartExpanded &&
                'ring-1 ring-inset ring-accent/25 shadow-[inset_0_0_0_1px_rgba(85,166,48,0.08)]',
            )}
          >
            {chartExpanded ? (
              <div className="shrink-0 flex items-center justify-between gap-3 px-3 py-2 border-b border-border-primary bg-bg-secondary">
                <span className="text-xs font-semibold text-text-primary truncate">
                  {selectedSymbol ? `Chart — ${selectedSymbol}` : 'Chart'}
                </span>
                <span className="text-[10px] text-text-tertiary hidden sm:inline">Esc — normal view</span>
                <button
                  type="button"
                  onClick={() => setChartExpanded(false)}
                  className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold text-text-secondary border border-border-primary hover:bg-bg-hover hover:text-text-primary"
                >
                  <Minimize2 className="w-3.5 h-3.5 shrink-0" aria-hidden />
                  Normal view
                </button>
              </div>
            ) : null}
            <div className="flex-1 min-w-0 min-h-0 overflow-hidden relative">
              <LiveChart />
            </div>
          </div>

          <PanelResizeHandle
            axis="vertical"
            hitSize={TERMINAL_RESIZE.handleHitPx}
            onDragStart={snapshotLayout}
            onDrag={onChartRailDrag}
          />

          <div
            className="shrink-0 flex flex-col h-full min-h-0 overflow-hidden bg-bg-base border-l border-border-primary"
            style={{ width: opW }}
          >
            {terminalCalcOpen && !terminalNewsOpen ? (
              <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                <RiskCalculator />
              </div>
            ) : terminalNewsOpen ? (
              <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                <div className="shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-border-primary bg-bg-secondary">
                  <button
                    type="button"
                    onClick={() => {
                      setTerminalNewsOpen(false);
                      setTerminalMarketsOpen(true);
                    }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border-primary bg-card text-[11px] font-bold uppercase tracking-wide text-accent hover:bg-accent/10 hover:border-accent/40 transition-colors"
                  >
                    ← Markets
                  </button>
                  <span className="text-[11px] font-bold uppercase tracking-wider text-text-tertiary">Live News</span>
                  <button
                    type="button"
                    onClick={() => {
                      setTerminalNewsOpen(false);
                      setTerminalMarketsOpen(false);
                    }}
                    className="ml-auto px-3 py-1.5 rounded-lg border border-border-primary bg-card text-[11px] font-semibold text-text-secondary hover:text-text-primary hover:border-border-secondary transition-colors"
                  >
                    Close
                  </button>
                </div>
                <div className="flex-1 min-h-0">
                  <MarketNewsPanel className="h-full" />
                </div>
              </div>
            ) : terminalMarketsOpen ? (
              <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                <InstrumentsTable
                  onExitMarkets={() => {
                    setTerminalMarketsOpen(false);
                    setTerminalNewsOpen(false);
                  }}
                  onViewNews={() => {
                    setTerminalMarketsOpen(false);
                    setTerminalNewsOpen(true);
                  }}
                />
              </div>
            ) : (
              <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                <OrderPanel />
              </div>
            )}
          </div>
        </div>

        <PanelResizeHandle
          axis="horizontal"
          hitSize={TERMINAL_RESIZE.bottomHandleHitPx}
          onDragStart={snapshotLayout}
          onDrag={onBottomDrag}
          className="z-[80]"
        />

        <div
          className="shrink-0 overflow-hidden min-h-0 flex flex-col relative z-[1] border-t border-border-primary"
          style={{ height: bpH }}
        >
          <PositionsPanel variant="terminal" />
        </div>
      </div>
    </div>
  );
}
