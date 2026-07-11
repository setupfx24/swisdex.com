'use client';

/**
 * Full TradingView Charting Library chart — pro UI fed by OUR engine data so the
 * candles match the running P&L (unlike the Advanced Chart WIDGET, which streams
 * TradingView's public OANDA feed). Wires the licensed library in
 * `public/charting_library/` to `swisDexDatafeed` (history = gateway
 * /instruments/{sym}/bars from the InfoWay BarAggregator; live = /ws/bars).
 *
 * Also draws a BUY/SELL position line on the chart for each open trade on the
 * current symbol (entry price + side + live P&L), updated as positions change.
 *
 * Revert to '@/components/charts/AdvancedChart' for the public widget.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTradingStore, defaultContractSize, livePnlFor } from '@/stores/tradingStore';
import { useUIStore } from '@/stores/uiStore';
import { swisDexDatafeed } from '@/lib/charting/datafeed';
import api from '@/lib/api/client';
import toast from 'react-hot-toast';
import { createBroker } from '@/lib/charting/broker';

// The licensed library attaches `TradingView` to window once the script runs.
// Use `any` for the widget/chart — the bundled .d.ts is huge and we only touch
// a few methods, each guarded by try/catch. Read it via a local cast rather
// than augmenting the global Window (AdvancedChart.tsx already declares
// window.TradingView with a different widget type — augmenting again clashes).
type TVWidget = { onChartReady?: (cb: () => void) => void; activeChart?: () => any; remove?: () => void };
type TVWidgetCtor = new (opts: Record<string, unknown>) => TVWidget;
function tvCtor(): TVWidgetCtor | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { TradingView?: { widget?: TVWidgetCtor } }).TradingView?.widget;
}

let _libPromise: Promise<void> | null = null;
function loadChartingLibrary(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (tvCtor()) return Promise.resolve();
  if (_libPromise) return _libPromise;
  _libPromise = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/charting_library/charting_library.standalone.js';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { _libPromise = null; reject(new Error('charting_library failed to load')); };
    document.head.appendChild(s);
  });
  return _libPromise;
}



// localStorage key for the persisted chart layout (drawings, studies,
// settings, timeframe) — survives page refreshes.
const CHART_SAVE_KEY = 'swisdex_chart_layout_v1';

// Stale-price thresholds (ms): how long without a tick before a position
// line's P&L is treated as stale. Crypto trades 24/7 (short), forex/metals
// are quiet at weekends (long so we don't spam "stale" when no ticks are
// expected), otherwise a normal live-market threshold.
const STALE_MS = { crypto: 3000, normal: 5000, weekendClosed: 60000 };
const STALE_COLOR = '#6b7280';

// Chart line colours — blue/red industry standard (Vantage / Exness style).
// Blue = anything BUY-related (Ask line, BUY entry, profit); Red = anything
// SELL-related (Bid line, SELL entry, loss). Green/red was ambiguous with the
// P&L palette, so BUY moved to blue. (client 2026-07-09)
const CHART_BUY_COLOR = '#3b82f6';   // blue — BUY position entry line
const CHART_SELL_COLOR = '#ef4444';  // red  — SELL position entry line
const CHART_ASK_COLOR = '#3b82f6';   // blue — the single ASK (spread) line drawn above the BID candle
const PROFIT_COLOR = '#3b82f6';      // blue — entry-line P&L label when in profit
const LOSS_COLOR = '#ef4444';        // red  — entry-line P&L label when in loss
const BREAKEVEN_COLOR = '#9ca3af';   // gray — entry-line P&L label near break-even

// Where the on-chart close (✕) button sits, measured from the chart's RIGHT edge:
// just left of each line's right-axis P&L label (label + price box ≈ 260px), so the
// ✕ reads as part of the P&L pill instead of hiding behind the left drawing toolbar.
const CLOSE_BTN_RIGHT_PX = 268;

// True-MT5 chart lines (client 2026-07-10): the candle is drawn at the BID
// (datafeed halfSpreadOf), so the library's own last-price line IS the LTP
// (bid). Enable + thin it here; the single blue ASK/spread line above is drawn
// separately from the same live tick so it can never drift from the candle.
const LTP_LINE_OVERRIDES: Record<string, string | number | boolean> = {
  'mainSeriesProperties.showPriceLine': true,
  'mainSeriesProperties.priceLineWidth': 1,
};

// ── Native TradingView Trading-Terminal position lines (2026-07-10) ──────────
// Wire the broker adapter (lib/charting/broker.ts) so the LIBRARY draws its own
// position line per trade: entry + live P&L + close (✕) + draggable TP/SL — like
// the reference chart. When ON, the custom HTML overlay below (shape entry lines,
// P&L labels, ✕ buttons, stale watchdog) is GATED OFF so there are no double
// lines. Flip this to `false` to instantly restore the custom overlay if the
// native render ever needs tuning — nothing else changes.
const USE_NATIVE_BROKER: boolean = false;
// configFlags mirror broker.ts brokerConfig(): supportPositionBrackets → the TP/SL
// buttons; supportClosePosition/PartialClose → the ✕; supportPLUpdate → live P&L.
const BROKER_CONFIG = {
  configFlags: {
    supportOrderBrackets: false,
    supportPositionBrackets: true,
    supportClosePosition: true,
    supportPartialClosePosition: true,
    supportReversePosition: false,
    supportNativeReversePosition: false,
    supportMarketOrders: true,
    supportLimitOrders: true,
    supportStopOrders: true,
    supportStopLimitOrders: false,
    supportModifyOrder: true,
    supportCancelOrder: true,
    supportEditAmount: true,
    showQuantityInsteadOfAmount: true,
    supportLevel2Data: false,
    showNotificationsLog: true,
    supportPLUpdate: true,
    supportPositionNetting: false,
    positionPLInInstrumentCurrency: false,
  },
};


// In-app dialog replacing window.confirm / window.prompt for the on-chart
// trade buttons (close ✕, SL/TP drag + type-a-price). Native browser popups
// broke the platform look (client 2026-07-10) — this renders the same styled
// modal the positions panel uses. `input` switches it to prompt mode.
type ChartDialog = {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  input?: { defaultValue: string; placeholder: string };
  onConfirm: (value?: string) => void;
} | null;

export default function ChartingLibraryChart() {
  const selectedSymbol = useTradingStore((s) => s.selectedSymbol);
  const positions = useTradingStore((s) => s.positions);
  const pendingOrders = useTradingStore((s) => s.pendingOrders);
  const theme = useUIStore((s) => s.theme);

  const containerRef = useRef<HTMLDivElement>(null);
  // Overlay layer above the chart for the on-chart close (✕) buttons.
  const overlayRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<TVWidget | null>(null);
  // Map position id -> chart position-line object, so we update/remove in place.
  const linesRef = useRef<Map<string, any>>(new Map());
  // The symbol the widget is currently displaying. Used to avoid a redundant
  // setSymbol() right after creation and to detect a real change.
  const appliedSymbolRef = useRef<string>('');
  const [ready, setReady] = useState(false);
  const [dialog, setDialog] = useState<ChartDialog>(null);
  const [dialogValue, setDialogValue] = useState('');
  const openDialog = (d: NonNullable<ChartDialog>) => {
    setDialogValue(d.input?.defaultValue ?? '');
    setDialog(d);
  };

  // Create the widget once (and recreate ONLY on theme change — that needs a
  // full rebuild). The symbol is intentionally NOT a dependency here: changing
  // it is handled in-place by the effect below via setSymbol(). Tearing down and
  // rebuilding the whole widget on every symbol change left a visible window
  // where the chart still showed the OLD symbol while the order ticket already
  // showed the NEW one — and if the async rebuild errored (swallowed below) the
  // chart got stuck on the stale symbol (live desync 2026-06-29: chart EURUSD
  // vs ticket XAUUSD).
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    linesRef.current.clear();

    loadChartingLibrary().then(() => {
      const Ctor = tvCtor();
      if (cancelled || !containerRef.current || !Ctor) return;
      try { widgetRef.current?.remove?.(); } catch { /* noop */ }
      // Read the latest symbol from the store at creation time (the effect does
      // not depend on it, so the closure value could be stale).
      const initialSymbol = useTradingStore.getState().selectedSymbol || 'XAUUSD';
      // Restore the saved chart layout (drawings, indicators/studies, chart
      // style, timeframe) so a page refresh no longer wipes the user's
      // analysis. Persisted to localStorage via onAutoSaveNeeded below
      // (client 2026-07-08: "on refresh all analysis disappears").
      let savedData: any;
      try {
        const s = localStorage.getItem(CHART_SAVE_KEY);
        if (s) savedData = JSON.parse(s);
      } catch { /* corrupt / no storage → start fresh */ }
      // Explicit background / grid / text colours per app theme. Passed to the
      // widget AND re-applied on ready so a restored (dark) saved_data layout
      // can't leave the chart dark in light mode. (client 2026-07-09)
      const themeOverrides: Record<string, string> = theme === 'light'
        ? {
            'paneProperties.background': '#ffffff',
            'paneProperties.backgroundType': 'solid',
            'paneProperties.vertGridProperties.color': '#ececec',
            'paneProperties.horzGridProperties.color': '#ececec',
            'scalesProperties.textColor': '#131722',
            'scalesProperties.lineColor': '#e0e3eb',
          }
        : {
            'paneProperties.background': '#0c0e12',
            'paneProperties.backgroundType': 'solid',
            'paneProperties.vertGridProperties.color': '#1c1f26',
            'paneProperties.horzGridProperties.color': '#1c1f26',
            'scalesProperties.textColor': '#b2b5be',
            'scalesProperties.lineColor': '#2a2e39',
          };
      const w = new Ctor({
        symbol: initialSymbol,
        interval: '5',
        container: containerRef.current,
        datafeed: swisDexDatafeed,
        library_path: '/charting_library/',
        locale: 'en',
        theme: theme === 'light' ? 'Light' : 'Dark',
        autosize: true,
        timezone: 'Asia/Kolkata',
        // Debounced auto-save fires onAutoSaveNeeded ~2s after any change.
        auto_save_delay: 2,
        // Re-load the previous layout if we have one.
        ...(savedData ? { saved_data: savedData } : {}),
        // Removed 'use_localstorage_for_settings' from disabled so the library
        // also persists chart style/settings per browser.
        // Hide TradingView's own account-manager panel when the native broker is
        // on — the app already has its right-side order panel + bottom positions
        // table; we only want the on-chart position LINES from the broker.
        disabled_features: USE_NATIVE_BROKER
          ? ['header_symbol_search', 'trading_account_manager']
          : ['header_symbol_search'],
        // NOTE: do NOT enable 'study_templates' — it needs a server
        // charts_storage_url/client_id/user_id, which we don't run, so the
        // library fired GET .../undefined/undefined/study_templates → 404 spam
        // in the console. Layout persistence uses saved_data + onAutoSaveNeeded
        // (localStorage) and does NOT need this feature.
        enabled_features: [],
        // Native Trading-Terminal broker → the library draws each position's line
        // with P&L + close (✕) + draggable TP/SL (see broker.ts). Gated by the flag.
        ...(USE_NATIVE_BROKER ? {
          broker_factory: (host: any) => createBroker(host),
          broker_config: BROKER_CONFIG,
        } : {}),
        // Faint SwisDex/symbol watermark in the chart background (restores the
        // branding the old Advanced Chart widget showed) — client 2026-06-26.
        overrides: {
          'symbolWatermarkProperties.transparency': 84,
          'symbolWatermarkProperties.color': theme === 'light'
            ? 'rgba(40,40,40,0.10)' : 'rgba(200,200,200,0.10)',
          // Theme colours here AND re-applied in onChartReady — a restored
          // saved_data layout carries its own (often dark) background/grid and
          // overrides `theme:'Light'`, which left a dark chart in light mode.
          ...themeOverrides,
          // The bid LTP line (series last-price line).
          ...LTP_LINE_OVERRIDES,
        },
      });
      widgetRef.current = w;
      appliedSymbolRef.current = initialSymbol;
      try {
        w.onChartReady?.(() => {
          if (cancelled) return;
          setReady(true);
          // Force the theme colours AFTER saved_data has loaded — its stored
          // (possibly dark) background/grid would otherwise win over theme:'Light'.
          try { (w as any).applyOverrides?.(themeOverrides); } catch { /* noop */ }
          // Ensure the bid LTP line is on even if a saved layout turned it off.
          try { (w as any).applyOverrides?.(LTP_LINE_OVERRIDES); } catch { /* noop */ }
          // Persist the FULL layout (drawings + studies + settings + interval)
          // on every change so it survives a refresh. save() serialises the
          // whole widget state; we stash it in localStorage. subscribe/save are
          // runtime methods not on the TVWidget type, so go through `any`.
          try {
            const wAny = w as any;
            wAny.subscribe?.('onAutoSaveNeeded', () => {
              try {
                wAny.save?.((state: any) => {
                  try { localStorage.setItem(CHART_SAVE_KEY, JSON.stringify(state)); } catch { /* quota */ }
                });
              } catch { /* noop */ }
            });
          } catch { /* noop */ }
        });
      } catch { /* noop */ }
    }).catch(() => { /* library missing/unapproved */ });

    return () => {
      cancelled = true;
      setReady(false);
      try { widgetRef.current?.remove?.(); } catch { /* noop */ }
      widgetRef.current = null;
      appliedSymbolRef.current = '';
      linesRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  // Change the symbol IN PLACE when selectedSymbol changes — keeps the chart in
  // lock-step with the order ticket (both read the same store symbol) instead of
  // rebuilding the widget. TradingView drives the datafeed's unsubscribe →
  // resolveSymbol → getBars → subscribeBars for the new symbol.
  useEffect(() => {
    if (!ready) return;
    const w = widgetRef.current;
    const sym = selectedSymbol || 'XAUUSD';
    if (!w?.activeChart || appliedSymbolRef.current === sym) return;
    try {
      const chart = w.activeChart();
      // Position lines are symbol-specific overlays; remove the shapes (they're
      // createShape entities → removeEntity, not .remove()) and drop our refs so
      // the reconcile effect re-creates them for the new symbol.
      for (const [, entry] of linesRef.current) {
        try { if (entry && entry.id != null) chart?.removeEntity(entry.id); } catch { /* noop */ }
      }
      linesRef.current.clear();
      chart?.setSymbol?.(sym, () => { /* resolved */ });
      appliedSymbolRef.current = sym;
    } catch { /* noop */ }
  }, [selectedSymbol, ready]);

  // Reconcile chart lines whenever positions / pending orders change. Each open
  // position gets an ENTRY line whose LINE colour is fixed by side (BUY blue /
  // SELL red) and whose LABEL shows the LIVE P&L coloured by profit/loss
  // (blue/red/gray), throttled to 500ms; plus SL (amber) / TP (teal). Each
  // pending order gets its entry (BUY blue / SELL purple, dashed) + SL/TP.
  //
  // Drawn with createShape('horizontal_line') — the CORE Charting Library API.
  // createPositionLine/createOrderLine are Trading-Terminal-only and render
  // NOTHING in this build, which is why the entry lines were invisible. Shapes
  // span the FULL chart width and stay pinned to the price scale through
  // zoom / scroll / timeframe changes; they're created once, moved with
  // setPoints when a price (e.g. SL/TP) changes, and removed when the
  // position/order closes. linesRef maps key -> { id, price, creating }.
  //
  // Trade-off vs the old (invisible) order lines: these aren't drag-to-modify.
  // Since the draggable lines never rendered, visible-but-static is strictly
  // better; SL/TP is still edited from the positions table.
  useEffect(() => {
    const w = widgetRef.current;
    if (!ready || !w?.activeChart) return;
    let chart: any;
    try { chart = w.activeChart(); } catch { return; }
    if (!chart?.createShape) return;
    if (USE_NATIVE_BROKER) return; // native broker draws position/order/SL-TP lines

    const sym = (selectedSymbol || '').toUpperCase();
    const myPos = positions.filter((p) => (p.symbol || '').toUpperCase() === sym);
    const myPending = (pendingOrders || []).filter((o: any) => (o.symbol || '').toUpperCase() === sym);
    const inst = useTradingStore.getState().instruments.find(
      (i) => String(i.symbol).toUpperCase() === sym,
    );
    const digits = inst?.digits ?? 2;
    const cs = Number(inst?.contract_size) || defaultContractSize(sym);
    const fp = (n: number) => Number(n).toFixed(digits);

    // P&L → LABEL colour: blue in profit, red in loss, gray near break-even.
    const pnlColor = (pnl: number) =>
      Math.abs(pnl) < 0.10 ? BREAKEVEN_COLOR : pnl > 0 ? PROFIT_COLOR : LOSS_COLOR;

    // `color` is the LINE colour, `textColor` the LABEL colour. For position
    // entry lines they differ: the line is fixed by side (BUY blue / SELL red)
    // while the label tracks P&L (profit blue / loss red / gray). SL/TP/pending
    // omit textColor → it falls back to the line colour.
    // `label:false` suppresses the TV shape's text label — used for open-position
    // entry lines, whose label is now the Vantage-style HTML overlay pill.
    type Desired = { key: string; price: number; color: string; textColor?: string; text: string; dashed: boolean; pnl?: number; label?: boolean };
    const desired: Desired[] = [];

    // ── Open positions: entry line labelled with LIVE P&L, coloured by P&L
    //    state (not side). p.profit is the SAME value the positions table and
    //    top floating-P&L bar use (livePnlFor) → single source of truth, so the
    //    line can never disagree with the table. SL (amber) / TP (teal) too. ──
    for (const p of myPos) {
      const pnl = Number(p.profit || 0);
      const lots = Number(p.lots || 0);
      const entry = Number(p.open_price || 0);
      const notional = entry * lots * cs;
      const pct = notional > 0 ? (pnl / notional) * 100 : 0;
      const pnlStr = `${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`;
      const pctStr = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
      // Line colour by SIDE (BUY blue / SELL red); label colour by P&L.
      const sideColor = p.side.toUpperCase() === 'BUY' ? CHART_BUY_COLOR : CHART_SELL_COLOR;
      desired.push({
        key: p.id, price: entry, color: sideColor, textColor: pnlColor(pnl),
        // Live P&L rendered as the TV shape's OWN label — TradingView pins it
        // exactly on the entry price (right axis), so it can never drift like the
        // old HTML overlay pill did (this Advanced-Charts build exposes no
        // priceToCoordinate, so pixel math was unreliable). (2026-07-10)
        text: `${p.side.toUpperCase()} ${lots}  ${pnlStr} (${pctStr})`,
        dashed: false, pnl, label: true,
      });
      if (p.stop_loss && Number(p.stop_loss) > 0) {
        const slp = Number(p.stop_loss);
        const r = livePnlFor(p, { bid: slp, ask: slp }, useTradingStore.getState().instruments, sym);
        const pl = r ? `  ${r.pnl >= 0 ? '+' : '−'}$${Math.abs(r.pnl).toFixed(2)}` : '';
        desired.push({ key: `${p.id}-sl`, price: slp, color: '#f59e0b', text: `SL ${fp(slp)}${pl}`, dashed: true });
      }
      if (p.take_profit && Number(p.take_profit) > 0) {
        const tpp = Number(p.take_profit);
        const r = livePnlFor(p, { bid: tpp, ask: tpp }, useTradingStore.getState().instruments, sym);
        const pl = r ? `  ${r.pnl >= 0 ? '+' : '−'}$${Math.abs(r.pnl).toFixed(2)}` : '';
        desired.push({ key: `${p.id}-tp`, price: tpp, color: '#14b8a6', text: `TP ${fp(tpp)}${pl}`, dashed: true });
      }
    }

    // ── Pending orders (limit/stop): entry + SL + TP. ──
    for (const o of myPending) {
      const pColor = o.side === 'buy' ? '#3b82f6' : '#a855f7';
      desired.push({ key: `ord-${o.id}`, price: Number(o.price), color: pColor,
        text: `${String(o.order_type || '').toUpperCase()} ${o.side.toUpperCase()} ${fp(Number(o.price))}`, dashed: true });
      if (o.stop_loss && Number(o.stop_loss) > 0)
        desired.push({ key: `ord-${o.id}-sl`, price: Number(o.stop_loss), color: '#f59e0b', text: `SL ${fp(Number(o.stop_loss))}`, dashed: true });
      if (o.take_profit && Number(o.take_profit) > 0)
        desired.push({ key: `ord-${o.id}-tp`, price: Number(o.take_profit), color: '#14b8a6', text: `TP ${fp(Number(o.take_profit))}`, dashed: true });
    }

    const shapeOpts = (text: string, lineColor: string, textColor: string, dashed: boolean, showLabel = true) => ({
      shape: 'horizontal_line',
      text,
      lock: true, disableSelection: true, disableSave: true, disableUndo: true,
      overrides: {
        linecolor: lineColor, linestyle: dashed ? 2 : 0, linewidth: dashed ? 1 : 2,
        showLabel, textcolor: textColor, fontsize: 11, bold: true,
        horzLabelsAlign: 'right', vertLabelsAlign: 'middle',
      },
    });

    const t = Math.floor(Date.now() / 1000);
    const now = Date.now();
    // Throttle the live-P&L label refresh: 500ms normally, 1000ms once 10+
    // positions are open, so streaming ticks never thrash the chart.
    const throttleMs = myPos.length >= 10 ? 1000 : 500;
    const wanted = new Set(desired.map((d) => d.key));

    for (const d of desired) {
      const existing = linesRef.current.get(d.key);
      if (!existing) {
        // createShape is ASYNC (Promise<EntityId>). Reserve the key with a
        // 'creating' entry so a re-render mid-create doesn't spawn a duplicate.
        const entry: any = { id: null, price: d.price, creating: true, text: d.text, color: d.color, textColor: d.textColor ?? d.color, pnl: d.pnl ?? null, propAt: now };
        linesRef.current.set(d.key, entry);
        chart.createShape({ time: t, price: d.price }, shapeOpts(d.label === false ? '' : d.text, d.color, d.textColor ?? d.color, d.dashed, d.label !== false))
          .then((id: any) => {
            if (linesRef.current.get(d.key) === entry) { entry.id = id; entry.creating = false; }
            else { try { chart.removeEntity(id); } catch { /* closed mid-create */ } }
          })
          .catch(() => { if (linesRef.current.get(d.key) === entry) linesRef.current.delete(d.key); });
      } else if (existing.id != null) {
        // Price moved (SL/TP edited) → slide the existing line, no recreate.
        if (existing.price !== d.price) {
          try { chart.getShapeById(existing.id)?.setPoints([{ time: t, price: d.price }]); } catch { /* noop */ }
          existing.price = d.price;
        }
        // Live label + colour refresh. For P&L lines (entry): throttle AND
        // only when P&L moved > $0.01 or the profit/loss colour flipped — so we
        // don't setProperties on every micro-tick. SL/TP/order labels are
        // static, so they update immediately when they actually change.
        const nextTextColor = d.textColor ?? d.color;
        if (d.text !== existing.text || d.color !== existing.color || nextTextColor !== existing.textColor) {
          const isPnl = d.pnl != null;
          const throttleOk = !isPnl || (now - (existing.propAt || 0) >= throttleMs);
          // For entry lines the LINE colour is fixed by side, so the P&L flip
          // shows up in the LABEL colour — trigger on that too.
          const worthIt = !isPnl
            || d.color !== existing.color
            || nextTextColor !== existing.textColor
            || Math.abs((d.pnl as number) - (existing.pnl ?? 0)) > 0.01;
          if (throttleOk && worthIt) {
            try {
              chart.getShapeById(existing.id)?.setProperties({
                // Entry lines carry NO visible text — the HTML overlay pill is
                // their label (showLabel:false alone didn't suppress it in this
                // build, so keep the shape text empty too). (client 2026-07-09)
                text: d.label === false ? '' : d.text, linecolor: d.color, textcolor: nextTextColor,
              });
            } catch { /* keep last-known label on error */ }
            existing.text = d.text;
            existing.color = d.color;
            existing.textColor = nextTextColor;
            existing.pnl = d.pnl ?? existing.pnl;
            existing.propAt = now;
          }
        }
      }
    }

    // Remove lines whose position / order / SL / TP is gone (or symbol changed).
    for (const [key, entry] of linesRef.current) {
      if (!wanted.has(key)) {
        if (entry && entry.id != null) { try { chart.removeEntity(entry.id); } catch { /* noop */ } }
        linesRef.current.delete(key);
      }
    }
  }, [positions, pendingOrders, selectedSymbol, ready]);

  // Stale-price watchdog. The reconcile above only runs when `positions`
  // changes — i.e. on a tick — so if the feed stalls it simply STOPS and the
  // last P&L freezes silently. This 1s interval independently detects "no tick
  // for the selected symbol in > threshold" and greys the position entry lines
  // to "... | -- (stale)". Recovery is automatic: the next tick re-runs the
  // reconcile, which restores the live P&L label + colour. Hooks the EXISTING
  // store stream (no new subscription); cleans up on unmount / symbol switch.
  useEffect(() => {
    if (USE_NATIVE_BROKER) return; // native broker owns position P&L; no custom greying
    const w = widgetRef.current;
    if (!ready || !w?.activeChart) return;
    let chart: any;
    try { chart = w.activeChart(); } catch { return; }
    if (!chart?.getShapeById) return;
    const sym = (selectedSymbol || '').toUpperCase();
    const inst = useTradingStore.getState().instruments.find(
      (i) => String(i.symbol).toUpperCase() === sym,
    );
    const isCrypto = String(inst?.segment || '').toLowerCase() === 'crypto'
      || /BTC|ETH|USDT|XRP|SOL|LTC|DOGE|BNB/.test(sym);
    const day = new Date().getUTCDay(); // 0 Sun … 6 Sat
    const isWeekend = day === 0 || day === 6;
    const threshold = isCrypto
      ? STALE_MS.crypto
      : (isWeekend ? STALE_MS.weekendClosed : STALE_MS.normal);

    // Track last-tick receive time for THIS symbol via the existing store
    // stream. prices[sym] gets a fresh object reference on every tick.
    let lastPrice = useTradingStore.getState().prices[sym];
    let lastTickAt = Date.now();
    const unsub = useTradingStore.subscribe((state) => {
      const p = state.prices[sym];
      if (p !== lastPrice) { lastPrice = p; lastTickAt = Date.now(); }
    });

    let stale = false;
    const interval = setInterval(() => {
      const isStale = Date.now() - lastTickAt > threshold;
      if (isStale === stale) return;          // only act on a transition
      stale = isStale;
      if (!isStale) return;                    // recovery handled by the reconcile
      const now = Date.now();
      // (a) Position ENTRY lines (carry live P&L; entry.pnl != null). SL/TP and
      //     pending-order labels are static, so leave them untouched.
      for (const [, entry] of linesRef.current) {
        if (!entry || entry.id == null || entry.pnl == null) continue;
        // Entry lines have NO shape text (the overlay pill is the label); just
        // grey the LINE to signal stale — never write visible text back on it.
        try {
          chart.getShapeById(entry.id)?.setProperties({
            linecolor: STALE_COLOR, textcolor: STALE_COLOR,
          });
        } catch { /* noop */ }
        entry.color = STALE_COLOR;
        entry.textColor = STALE_COLOR;
        entry.propAt = now; // so the reconcile's throttle lets recovery through
      }
      // (Live BUY/SELL quote lines removed — nothing to grey here anymore.)
    }, 1000);

    return () => { clearInterval(interval); try { unsub(); } catch { /* noop */ } };
  }, [ready, selectedSymbol]);

  // ── Single ASK (spread) line ────────────────────────────────────────────────
  // The candle is drawn at the BID (datafeed halfSpreadOf), so the library's own
  // last-price line is the LTP (bid). This draws ONE blue ask line half a spread
  // above it. Crucially it reads the SAME `tradingStore.prices[sym]` tick that
  // the datafeed's 150ms interval uses to nudge the candle close to the bid — so
  // the gap between candle and ask line is always exactly the live spread and can
  // never "jump" the way the old /ws/prices-fed bid/ask lines did (they rode a
  // different socket/clock than the /ws/bars candle). Created once per symbol,
  // moved with setPoints, removed on symbol switch / unmount. (client 2026-07-10)
  useEffect(() => {
    const w = widgetRef.current;
    if (!ready || !w?.activeChart) return;
    let chart: any;
    try { chart = w.activeChart(); } catch { return; }
    if (!chart?.createShape) return;

    const sym = (selectedSymbol || '').toUpperCase();
    const inst = useTradingStore.getState().instruments.find(
      (i) => String(i.symbol).toUpperCase() === sym,
    );
    const digits = inst?.digits ?? 5;
    const round = (n: number) => Number(n.toFixed(digits));

    let cancelled = false;
    let lineId: any = null;
    let creating = false;
    let lastAsk = NaN;

    const apply = () => {
      if (cancelled) return;
      const t = useTradingStore.getState().prices[sym];
      if (!t || !(t.ask > 0) || !(t.bid > 0)) return;
      // Only draw the ask line when the admin has actually configured a spread.
      // With spread 0 (ask == bid) it just overlaps the candle / LTP line AND
      // jitters with every tick — so remove it and bail. It reappears above the
      // candle the moment a real spread is set. (2026-07-10)
      if (t.ask - t.bid < Math.pow(10, -digits)) {
        if (lineId != null) { try { chart.removeEntity(lineId); } catch { /* noop */ } lineId = null; }
        lastAsk = NaN;
        return;
      }
      const ask = round(t.ask);
      if (ask === lastAsk) return;         // only move when the ask actually changes
      lastAsk = ask;
      const at = Math.floor(Date.now() / 1000);
      if (lineId != null) {
        try { chart.getShapeById(lineId)?.setPoints([{ time: at, price: ask }]); } catch { /* noop */ }
      } else if (!creating) {
        creating = true;
        chart.createShape({ time: at, price: ask }, {
          shape: 'horizontal_line',
          lock: true, disableSelection: true, disableSave: true, disableUndo: true,
          overrides: {
            linecolor: CHART_ASK_COLOR, linestyle: 2, linewidth: 1,
            showLabel: true, textcolor: CHART_ASK_COLOR, fontsize: 11, bold: true,
            horzLabelsAlign: 'right', vertLabelsAlign: 'middle',
          },
        }).then((id: any) => {
          if (cancelled) { try { chart.removeEntity(id); } catch { /* noop */ } return; }
          lineId = id; creating = false;
        }).catch(() => { creating = false; });
      }
    };

    apply();
    // ~6.6/s, matching the datafeed's candle-close nudge cadence.
    const iv = setInterval(apply, 150);
    return () => {
      cancelled = true;
      clearInterval(iv);
      if (lineId != null) { try { chart.removeEntity(lineId); } catch { /* noop */ } }
    };
  }, [ready, selectedSymbol]);

  // Stable key of the open positions on this symbol — the close-button overlay
  // rebuilds its ✕ buttons only when the position SET changes, not every tick.
  const symU = (selectedSymbol || '').toUpperCase();
  const positionsKey = positions
    .filter((p) => (p.symbol || '').toUpperCase() === symU)
    .map((p) => `${p.id}:${p.side}:${p.lots}`)
    .join('|');

  // ── On-chart CLOSE (✕) button per position ──────────────────────────────────
  // P&L is a native TV shape label (always pinned to the exact price). The close
  // button MUST be clickable HTML, and this build has no priceToCoordinate — so
  // we CALIBRATE price→pixel from TradingView's OWN crosshair: two crosshair
  // samples at different Y give an exact linear map (containerY = m·price + c),
  // with none of the fragile getVisiblePriceRange math that mislocated the old
  // pill. A ✕ sits at the LEFT of each entry line (clear of the right-axis P&L
  // label), updated on a rAF. It appears once the cursor has moved over the chart
  // (which it has when you go to click it) and stays pinned through pan/zoom; the
  // next crosshair sample re-locks it. (2026-07-10)
  useEffect(() => {
    if (USE_NATIVE_BROKER) return; // native broker draws the ✕ close button
    const w = widgetRef.current;
    const overlay = overlayRef.current;
    if (!ready || !w?.activeChart || !overlay) return;
    let chart: any;
    try { chart = w.activeChart(); } catch { return; }
    if (!chart?.crossHairMoved) return;

    const sym = (selectedSymbol || '').toUpperCase();

    // Live price→pixel. The SCALE comes from the price scale (getVisiblePriceRange
    // + pane height), which updates on EVERY zoom/pan — so the ✕ follows the line
    // in real time (the old 2-point crosshair calibration went stale on wheel-zoom
    // because a zoom fires no crosshair event). The crosshair only pins the
    // constant vertical OFFSET (the pane's top edge), which does NOT move when you
    // zoom the price scale; it's re-locked on every mouse move. (2026-07-10)
    type Geo = { top: number; bottom: number; h: number; log: boolean };
    const geom = (): Geo | null => {
      try {
        const pane = chart.getPanes?.()[0];
        const ps = pane?.getMainSourcePriceScale?.();
        if (!ps) return null;
        const mode = ps.getMode?.() ?? 0;            // 0 linear, 1 log
        if (mode !== 0 && mode !== 1) return null;
        const range = ps.getVisiblePriceRange?.();
        const h = pane?.getHeight?.() || 0;
        if (!range || !(h > 0) || !(range.to > range.from)) return null;
        if (mode === 1 && !(range.from > 0)) return null;
        return { top: range.to, bottom: range.from, h, log: mode === 1 };
      } catch { return null; }
    };
    const paneY = (price: number, g: Geo): number => {
      if (g.log) {
        if (!(price > 0)) return NaN;
        const lt = Math.log(g.top), lb = Math.log(g.bottom);
        return (g.h * (lt - Math.log(price))) / (lt - lb);
      }
      return (g.h * (g.top - price)) / (g.top - g.bottom);
    };
    let calibOffset: number | null = null; // container-Y of the pane's top edge
    const onCross = (p: any) => {
      if (!p || typeof p.price !== 'number' || typeof p.offsetY !== 'number') return;
      const g = geom();
      if (!g) return;
      const py = paneY(p.price, g);
      if (Number.isFinite(py)) calibOffset = p.offsetY - py;
    };
    let crossSub: any = null;
    try { crossSub = chart.crossHairMoved(); crossSub?.subscribe?.(null, onCross); } catch { /* noop */ }

    // Inverse of paneY: container-Y → price (drives the drag-to-set gesture below).
    const priceForY = (containerY: number): number | null => {
      const g = geom();
      if (!g || calibOffset == null) return null;
      const py = containerY - calibOffset; // pane-relative Y
      if (g.log) {
        const lt = Math.log(g.top), lb = Math.log(g.bottom);
        return Math.exp(lt - (py / g.h) * (lt - lb));
      }
      return g.top - (py / g.h) * (g.top - g.bottom);
    };

    const digits = (useTradingStore.getState().instruments.find(
      (i) => String(i.symbol).toUpperCase() === sym,
    )?.digits) ?? 2;

    // Set / clear a position's stop-loss or take-profit from the chart. Sends BOTH
    // brackets (new + existing) so the other isn't wiped; the backend SL/TP engine
    // auto-closes when hit, and the reconcile effect draws the amber/teal line.
    const setBracket = (p: any, kind: 'sl' | 'tp') => {
      const label = kind === 'sl' ? 'Stop Loss' : 'Take Profit';
      const t = useTradingStore.getState().prices[sym];
      const cur = kind === 'sl' ? p.stop_loss : p.take_profit;
      const dflt = Number(cur) || (t ? (p.side === 'buy' ? t.bid : t.ask) : Number(p.open_price)) || 0;
      openDialog({
        title: `${label} — ${String(p.side).toUpperCase()} ${p.lots} ${sym}`,
        body: 'Enter the price. Leave blank to remove.',
        confirmLabel: 'Save',
        input: { defaultValue: dflt ? dflt.toFixed(digits) : '', placeholder: 'Price' },
        onConfirm: (raw) => {
          const trimmed = (raw ?? '').trim();
          const val = trimmed === '' ? null : parseFloat(trimmed);
          if (val !== null && !(val > 0)) { toast.error('Invalid price'); return; }
          (async () => {
            try {
              // Send ONLY the bracket being changed. The backend does a partial
              // update (an omitted field is left untouched), so the OTHER bracket
              // is never affected. Re-sending it from the button's captured `p`
              // was the bug: `p` is a stale closure — the buttons only rebuild on
              // id/side/lots change (positionsKey), NOT on SL/TP change — so its
              // copy of the other bracket was old and reverted it. (client 2026-07-10)
              await api.put(`/positions/${p.id}`,
                kind === 'sl' ? { stop_loss: val } : { take_profit: val });
              toast.success(val === null ? `${label} removed` : `${label} set @ ${val}`);
              await useTradingStore.getState().refreshPositions();
            } catch (err) {
              toast.error(err instanceof Error ? err.message : `Failed to set ${label}`);
            }
          })();
        },
      });
    };

    const mkBtn = (txt: string, bg: string, title: string, onClick: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = txt;
      b.title = title;
      b.style.cssText =
        `display:flex;align-items:center;justify-content:center;height:18px;min-width:18px;`
        + `padding:0 ${txt.length > 1 ? '5' : '0'}px;border:0;border-radius:3px;cursor:pointer;`
        + `font-size:10px;font-weight:700;line-height:1;color:#fff;pointer-events:auto;`
        + `background:${bg};box-shadow:0 1px 3px rgba(0,0,0,.55);`;
      b.onmouseenter = () => { b.style.filter = 'brightness(1.15)'; };
      b.onmouseleave = () => { b.style.filter = 'none'; };
      b.onclick = (e) => { e.stopPropagation(); onClick(); };
      return b;
    };

    // Draggable SL/TP button: press & drag up/down → a dashed preview line follows
    // the cursor showing the target price → release → confirm → PUT. A plain click
    // (no drag) falls back to the type-a-price prompt.
    const mkDragBtn = (txt: string, bg: string, title: string, p: any, kind: 'sl' | 'tp'): HTMLButtonElement => {
      const color = kind === 'sl' ? '#f59e0b' : '#14b8a6';
      const zoneBg = kind === 'sl' ? 'rgba(239,68,68,0.13)' : 'rgba(20,184,166,0.13)';
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = txt;
      b.title = `${title} — drag up/down to set, or click to type`;
      b.style.cssText =
        `display:flex;align-items:center;justify-content:center;height:18px;min-width:18px;`
        + `padding:0 5px;border:0;border-radius:3px;cursor:ns-resize;`
        + `font-size:10px;font-weight:700;line-height:1;color:#fff;pointer-events:auto;`
        + `background:${bg};box-shadow:0 1px 3px rgba(0,0,0,.55);`;
      b.onmouseenter = () => { b.style.filter = 'brightness(1.15)'; };
      b.onmouseleave = () => { b.style.filter = 'none'; };
      b.onpointerdown = (e) => {
        e.preventDefault(); e.stopPropagation();
        // Capture the pointer to the button: the drag follows the cursor and won't
        // "let go" even if it leaves the button — released only on pointerup.
        try { b.setPointerCapture(e.pointerId); } catch { /* noop */ }
        const startY = e.clientY;
        let moved = false;
        // Preview: shaded zone (entry → cursor) + dashed line + price label.
        const zone = document.createElement('div');
        zone.style.cssText = `position:absolute;left:0;right:0;top:0;height:0;background:${zoneBg};pointer-events:none;z-index:6;`;
        const line = document.createElement('div');
        line.style.cssText = `position:absolute;left:0;right:0;top:0;height:0;border-top:1px dashed ${color};pointer-events:none;z-index:7;`;
        const lbl = document.createElement('div');
        lbl.style.cssText = `position:absolute;right:2px;top:0;transform:translateY(-50%);background:${color};`
          + `color:#fff;font:700 10px system-ui;padding:1px 6px;border-radius:3px;pointer-events:none;z-index:8;white-space:nowrap;`;
        overlay.appendChild(zone); overlay.appendChild(line); overlay.appendChild(lbl);
        const entryY = (): number | null => {
          const g = geom();
          if (!g || calibOffset == null) return null;
          return paneY(Number(p.open_price) || 0, g) + calibOffset;
        };
        const cleanup = () => { for (const el of [zone, line, lbl]) { try { overlay.removeChild(el); } catch { /* noop */ } } };
        b.onpointermove = (ev) => {
          if (Math.abs(ev.clientY - startY) > 3) moved = true;
          const r = containerRef.current?.getBoundingClientRect();
          if (!r) return;
          const cy = ev.clientY - r.top;
          const price = priceForY(cy);
          line.style.top = `${cy}px`;
          lbl.style.top = `${cy}px`;
          // Show the target price AND the projected P&L at that price (same helper
          // the live P&L uses, evaluated at the SL/TP level — accurate).
          let ptxt = `${kind === 'sl' ? 'SL' : 'TP'} ${price ? price.toFixed(digits) : '—'}`;
          if (price) {
            const rr = livePnlFor(p, { bid: price, ask: price }, useTradingStore.getState().instruments, sym);
            if (rr) ptxt += `  ${rr.pnl >= 0 ? '+' : '−'}$${Math.abs(rr.pnl).toFixed(2)}`;
          }
          lbl.textContent = ptxt;
          const ey = entryY();
          if (ey != null) { zone.style.top = `${Math.min(ey, cy)}px`; zone.style.height = `${Math.abs(ey - cy)}px`; }
        };
        b.onpointerup = (ev) => {
          b.onpointermove = null; b.onpointerup = null;
          try { b.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
          cleanup();
          if (!moved) { setBracket(p, kind); return; } // plain click → type-a-price
          const r = containerRef.current?.getBoundingClientRect();
          const price = r ? priceForY(ev.clientY - r.top) : null;
          if (!price || !(price > 0)) { toast.error('Could not read price'); return; }
          const label = kind === 'sl' ? 'Stop Loss' : 'Take Profit';
          const proj = livePnlFor(p, { bid: price, ask: price }, useTradingStore.getState().instruments, sym);
          const projTxt = proj ? ` → ${proj.pnl >= 0 ? 'profit' : 'loss'} ${proj.pnl >= 0 ? '+' : '−'}$${Math.abs(proj.pnl).toFixed(2)}` : '';
          const applyBracket = async () => {
            try {
              // Only the dragged bracket — the backend partial-update keeps the
              // other intact (see setBracket note; `p` is a stale closure, so
              // re-sending its copy of the other bracket reverted it). (client 2026-07-10)
              await api.put(`/positions/${p.id}`,
                kind === 'sl' ? { stop_loss: price } : { take_profit: price });
              toast.success(`${label} set @ ${price.toFixed(digits)}`);
              await useTradingStore.getState().refreshPositions();
            } catch (err) {
              toast.error(err instanceof Error ? err.message : `Failed to set ${label}`);
            }
          };
          openDialog({
            title: `Set ${label} @ ${price.toFixed(digits)}`,
            body: `${String(p.side).toUpperCase()} ${p.lots} ${sym}${projTxt}`,
            confirmLabel: `Set ${kind.toUpperCase()}`,
            onConfirm: () => { void applyBracket(); },
          });
        };
      };
      return b;
    };

    // One button GROUP per open position: [SL] [TP] [✕], pinned to the entry line.
    const myPos = useTradingStore.getState().positions.filter(
      (p) => (p.symbol || '').toUpperCase() === sym,
    );
    const btns: { p: any; entry: number; el: HTMLDivElement; slZone: HTMLDivElement; tpZone: HTMLDivElement }[] = [];
    for (const p of myPos) {
      const side = String(p.side).toUpperCase();
      const sideColor = side === 'BUY' ? CHART_BUY_COLOR : CHART_SELL_COLOR;
      const root = document.createElement('div');
      root.style.cssText =
        `position:absolute;right:${CLOSE_BTN_RIGHT_PX}px;transform:translateY(-50%);`
        + `display:flex;align-items:center;gap:3px;pointer-events:none;visibility:hidden;z-index:6;`;
      root.appendChild(mkDragBtn('SL', 'rgba(245,158,11,0.97)', `Stop loss ${side} ${p.lots} ${sym}`, p, 'sl'));
      root.appendChild(mkDragBtn('TP', 'rgba(20,184,166,0.97)', `Take profit ${side} ${p.lots} ${sym}`, p, 'tp'));
      root.appendChild(mkBtn('✕', sideColor, `Close ${side} ${p.lots} ${sym} at market`, () => {
        openDialog({
          title: 'Close position',
          body: `Close ${side} ${Number(p.lots)} ${sym} at market?`,
          confirmLabel: 'Close position',
          danger: true,
          onConfirm: () => {
            root.style.visibility = 'hidden';
            try { useTradingStore.getState().removePosition(p.id); } catch { /* noop */ }
            (async () => {
              try {
                const res = await api.post<{ profit?: number; close_price?: number }>(
                  `/positions/${p.id}/close`, {}, { timeoutMs: 8000 },
                );
                const pnl = Number(res?.profit ?? 0);
                toast.success(`Closed @ ${res?.close_price ?? ''} | ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`);
              } catch (err) {
                toast.error(err instanceof Error ? err.message : 'Close failed');
              } finally {
                Promise.all([
                  useTradingStore.getState().refreshPositions(),
                  useTradingStore.getState().refreshAccount(),
                ]).catch(() => {});
              }
            })();
          },
        });
      }));
      // Persistent shaded zones (entry → SL red, entry → TP green), positioned in
      // the sync loop from the LIVE bracket prices. Below the buttons/lines (z 4).
      const slZone = document.createElement('div');
      slZone.style.cssText = `position:absolute;left:0;right:0;top:0;height:0;background:rgba(239,68,68,0.10);pointer-events:none;visibility:hidden;z-index:4;`;
      const tpZone = document.createElement('div');
      tpZone.style.cssText = `position:absolute;left:0;right:0;top:0;height:0;background:rgba(20,184,166,0.10);pointer-events:none;visibility:hidden;z-index:4;`;
      overlay.appendChild(slZone); overlay.appendChild(tpZone);
      overlay.appendChild(root);
      btns.push({ p, entry: Number(p.open_price) || 0, el: root, slZone, tpZone });
    }
    if (btns.length === 0) {
      try { crossSub?.unsubscribe?.(null, onCross); } catch { /* noop */ }
      return () => {};
    }

    let raf = 0;
    const sync = () => {
      raf = requestAnimationFrame(sync);
      // Re-read the price scale EVERY frame so the line/buttons/zones follow live
      // through zoom/pan; the crosshair-locked offset stays constant across a zoom.
      const g = geom();
      if (!g || calibOffset == null) {
        for (const b of btns) { b.el.style.visibility = 'hidden'; b.slZone.style.visibility = 'hidden'; b.tpZone.style.visibility = 'hidden'; }
        return;
      }
      const off = calibOffset;
      const h = containerRef.current?.clientHeight || g.h;
      const live = useTradingStore.getState().positions;
      const drawZone = (el: HTMLDivElement, entryY: number, price: unknown) => {
        const pr = Number(price);
        if (!(pr > 0)) { el.style.visibility = 'hidden'; return; }
        const zy = paneY(pr, g) + off;
        const top = Math.min(entryY, zy), ht = Math.abs(entryY - zy);
        if (ht < 1) { el.style.visibility = 'hidden'; return; }
        el.style.top = `${top}px`; el.style.height = `${ht}px`; el.style.visibility = 'visible';
      };
      for (const b of btns) {
        const y = paneY(b.entry, g) + off;
        if (!(y > 8) || y > h - 8) { b.el.style.visibility = 'hidden'; }
        else { b.el.style.top = `${y}px`; b.el.style.visibility = 'visible'; }
        const lp = live.find((x) => x.id === b.p.id);
        drawZone(b.slZone, y, lp?.stop_loss);
        drawZone(b.tpZone, y, lp?.take_profit);
      }
    };
    raf = requestAnimationFrame(sync);

    return () => {
      cancelAnimationFrame(raf);
      try { crossSub?.unsubscribe?.(null, onCross); } catch { /* noop */ }
      for (const b of btns) { for (const el of [b.el, b.slZone, b.tpZone]) { try { overlay.removeChild(el); } catch { /* noop */ } } }
    };
  }, [ready, selectedSymbol, positionsKey]);

  return (
    <div className="relative w-full h-full min-h-[320px]">
      <div ref={containerRef} className="w-full h-full min-h-[320px]" />
      <div ref={overlayRef} className="pointer-events-none absolute inset-0 overflow-hidden" />
      {dialog &&
        typeof document !== 'undefined' &&
        createPortal(
          <div className="fixed inset-0 p-0" style={{ zIndex: 2147483646, isolation: 'isolate' }}>
            <button
              type="button"
              tabIndex={-1}
              aria-label="Dismiss"
              className="absolute inset-0 z-0 m-0 h-full w-full cursor-default border-0 bg-black/60 p-0 backdrop-blur-sm"
              onClick={() => setDialog(null)}
            />
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-4">
              <div
                role="dialog"
                aria-modal="true"
                className="relative w-full max-w-[300px] rounded-xl border p-3.5 shadow-2xl overflow-hidden pointer-events-auto bg-card border-border-primary"
                onMouseDown={(e) => e.stopPropagation()}
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <h3 className="text-sm font-bold pr-2 text-text-primary">{dialog.title}</h3>
                  <button
                    type="button"
                    onClick={() => setDialog(null)}
                    className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg transition-colors bg-bg-hover text-text-tertiary hover:text-text-primary"
                    aria-label="Close"
                  >
                    ✕
                  </button>
                </div>
                <p className="text-xs text-text-secondary mb-3">{dialog.body}</p>
                {dialog.input && (
                  <input
                    autoFocus
                    type="number"
                    step="any"
                    value={dialogValue}
                    onChange={(e) => setDialogValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const d = dialog; setDialog(null); d.onConfirm(dialogValue);
                      } else if (e.key === 'Escape') { setDialog(null); }
                    }}
                    placeholder={dialog.input.placeholder}
                    className="w-full mb-3 px-3 py-2 rounded-lg border border-border-primary bg-bg-input font-mono text-sm text-text-primary outline-none focus:border-accent/50"
                  />
                )}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setDialog(null)}
                    className="flex-1 py-2.5 font-bold rounded-lg text-sm active:scale-[0.98] transition-all bg-bg-hover text-text-primary"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => { const d = dialog; setDialog(null); d.onConfirm(dialogValue); }}
                    className={`flex-1 py-2.5 text-white font-bold rounded-lg shadow-lg active:scale-[0.98] transition-all text-sm ${dialog.danger ? 'bg-sell shadow-sell/20' : 'bg-buy shadow-buy/20'}`}
                  >
                    {dialog.confirmLabel}
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
