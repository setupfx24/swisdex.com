/**
 * Custom datafeed for the TradingView Advanced Charting Library.
 *
 * - Crypto history: Binance REST API (real OHLCV data)
 * - Other instruments: Synthetic candles anchored to current live price
 * - Live updates: builds bars from Zustand price ticks (WebSocket fed)
 *
 * Modelled after setupfx24's SetupfxDatafeed — fast, no backend bar dependency.
 */
import type {
  Bar,
  DatafeedConfiguration,
  HistoryCallback,
  IBasicDataFeed,
  LibrarySymbolInfo,
  PeriodParams,
  ResolutionString,
  ResolveCallback,
  SearchSymbolResultItem,
  SearchSymbolsCallback,
  SubscribeBarsCallback,
} from '@/types/charting_library';
import { useTradingStore } from '@/stores/tradingStore';
import { barSocket, type ServerBar } from '@/lib/ws/barSocket';

/* ─── Resolution maps ─── */

// Resolutions offered in the interval menu (client 2026-07-13 added 3m, 10m,
// 45m, 2h, 3h, W, M, 3M, 6M, 12M). Only SERVER_RESOLUTIONS exist on the
// backend — every other entry is built CLIENT-SIDE by the charting library
// from a base resolution (3←1, 10←5, 45←15, 120/180←60, W/M/3M/6M/12M←1D),
// declared via intraday_multipliers + has_weekly_and_monthly:false below.
// The datafeed therefore only ever receives requests for SERVER_RESOLUTIONS.
const SERVER_RESOLUTIONS = ['1', '5', '15', '30', '60', '240'] as ResolutionString[];

const SUPPORTED_RESOLUTIONS: ResolutionString[] = [
  '1', '3', '5', '10', '15', '30', '45', '60', '120', '180', '240',
  '1D', '1W', '1M', '3M', '6M', '12M',
] as ResolutionString[];

const RESOLUTION_TO_SECONDS: Record<string, number> = {
  '1': 60, '3': 180, '5': 300, '10': 600, '15': 900, '30': 1800, '45': 2700,
  '60': 3600, '120': 7200, '180': 10800, '240': 14400, D: 86400, '1D': 86400,
  '1W': 604800, '1M': 2592000, '3M': 7776000, '6M': 15552000, '12M': 31104000,
};

/* ─── Binance (crypto) ─── */

const BINANCE_PAIRS: Record<string, string> = {
  BTCUSD: 'BTCUSDT', ETHUSD: 'ETHUSDT', LTCUSD: 'LTCUSDT',
  XRPUSD: 'XRPUSDT', SOLUSD: 'SOLUSDT', BNBUSD: 'BNBUSDT',
  DOGEUSD: 'DOGEUSDT', ADAUSD: 'ADAUSDT', TRXUSD: 'TRXUSDT',
  LINKUSD: 'LINKUSDT', DOTUSD: 'DOTUSDT', AVAXUSD: 'AVAXUSDT',
};

// Binance history fetch was removed (client 2026-06-26): InfoWay feeds crypto
// too, so the engine /bars endpoint is the single candle source for every
// symbol. BINANCE_PAIRS above is kept only to classify a symbol as crypto.

/* ─── Symbol category (weekend-bar filter) ─── */

function getSymbolCategory(symbol: string): string {
  const s = symbol.toUpperCase();
  if (s.startsWith('XAU') || s.startsWith('XAG')) return 'metals';
  if (['USOIL', 'UKOIL', 'NGAS'].includes(s)) return 'commodities';
  if (['US30', 'US500', 'NAS100', 'UK100', 'GER40'].includes(s)) return 'indices';
  if (BINANCE_PAIRS[s]) return 'crypto';
  return 'forex';
}

// Drop Saturday/Sunday candles from a NON-crypto symbol's history (client
// 2026-07-11). Forex / metals / indices / commodities markets are closed on
// weekends, so weekend bars are dashed "no-trade" fillers that just clutter the
// chart. New bars already exclude weekends; this strips the OLD ones from the
// history the chart renders. Crypto (24/7) is left untouched. Weekday is read
// in UTC — bar.time is bar-open in ms UTC.
function dropWeekendBars(bars: Bar[], symbol: string): Bar[] {
  if (getSymbolCategory(symbol) === 'crypto') return bars;
  return bars.filter((b) => {
    const day = new Date(b.time).getUTCDay(); // 0 = Sun, 6 = Sat
    return day !== 0 && day !== 6;
  });
}

/* ─── Wait for price ─── */

/** Wait up to `timeoutMs` for a live price tick for `symbol` to appear in the store. */
function waitForPrice(symbol: string, timeoutMs = 8000): Promise<{ bid: number; ask: number } | null> {
  const tick = useTradingStore.getState().prices[symbol];
  if (tick && tick.bid > 0) return Promise.resolve(tick);

  return new Promise((resolve) => {
    const start = Date.now();
    const unsub = useTradingStore.subscribe((state) => {
      const t = state.prices[symbol];
      if (t && t.bid > 0) { unsub(); resolve(t); }
      else if (Date.now() - start > timeoutMs) { unsub(); resolve(null); }
    });
    // Safety timeout in case no ticks come at all
    setTimeout(() => { unsub(); resolve(null); }, timeoutMs + 100);
  });
}

/* ─── Config ─── */

const CONFIG: DatafeedConfiguration = {
  supported_resolutions: SUPPORTED_RESOLUTIONS,
  exchanges: [
    { value: '', name: 'All', desc: 'All exchanges' },
    { value: 'SwisDex', name: 'SwisDex', desc: 'SwisDex' },
  ],
  symbols_types: [
    { name: 'All', value: '' },
    { name: 'Forex', value: 'forex' },
    { name: 'Crypto', value: 'crypto' },
    { name: 'Index', value: 'index' },
    { name: 'Commodity', value: 'commodity' },
    { name: 'Stock', value: 'stock' },
  ],
  supports_marks: false,
  supports_timescale_marks: false,
  supports_time: true,
};

/* ─── Subscription state ─── */
//
// subscribeBars now uses the gateway's /ws/bars channel — see
// `lib/ws/barSocket.ts` and `gateway/src/main.py:bar_stream`. The server
// pushes pre-aggregated OHLC for the in-progress candle on every tick;
// the frontend just relays them to TradingView. The previous tick-based
// client-side synthesis has been removed because it drifted from the
// server's authoritative aggregation in market-data/bar_aggregator.py
// (different clocks, different filtering, floating-point accumulation),
// which is what produced the "candles don't match TradingView" symptom.
interface Subscription {
  symbol: string;
  resolution: string;
  onTick: SubscribeBarsCallback;
  /** TradingView's "your data changed, drop cache + re-fetch" callback. Called
   *  on a socket RECONNECT so bars missed during the drop are re-pulled. */
  resetCache?: () => void;
  unsubscribe: () => void;
}

const subscriptions = new Map<string, Subscription>();

// Register ONCE: when the bar socket re-connects after a drop, reset every live
// subscription's cache so TradingView re-calls getBars and fills any gap left by
// the missed realtime bars (client 2026-07-03).
let _reconnectHooked = false;
function ensureReconnectHook() {
  if (_reconnectHooked) return;
  _reconnectHooked = true;
  barSocket.onReconnect(() => {
    for (const sub of subscriptions.values()) {
      try { sub.resetCache?.(); } catch { /* ignore */ }
    }
  });
}

/* ─── Bid-based chart shift ─── */
//
// The engine's BarAggregator builds candles from the raw tick MID
// (market-data/src/bar_aggregator.py: mid = (bid+ask)/2), but every other
// price the trader sees — the order panel's BID/ASK and the positions
// panel's "current" price (bid for buys) — is the spread-widened quote.
// With a wide admin spread (e.g. BTCUSD 1700 points) the chart floated
// half a spread above the bid, so chart / BID / P&L all looked different.
//
// Fix (client 2026-07-04): draw the chart at the BID, the MT4/MT5
// convention — shift every bar down by half the live spread taken from
// the same store tick the panels render. Chart last price == panel BID ==
// buy-position current price by construction. Historical bars are shifted
// by the CURRENT half-spread (fixed-markup assumption), which keeps the
// candle series continuous with the live bar.

function halfSpreadOf(tick?: { bid: number; ask: number } | null): number {
  // Client 2026-07-10 (true MT5): draw the candle at the BID. The candle's own
  // last-price line IS the LTP (bid), matching the panel BID and a buy
  // position's "current" price by construction. A single blue ASK line is
  // drawn half a spread above it (ChartingLibraryChart) as the spread line.
  // Shift = half the LIVE spread from the same store tick the panels render,
  // so the candle close == bid exactly and never drifts from the ask line.
  if (!tick || !(tick.bid > 0) || !(tick.ask > 0)) return 0;
  return (tick.ask - tick.bid) / 2;
}

function symbolDigits(sym: string): number {
  const inst = useTradingStore.getState().instruments.find(
    (i) => i.symbol.toUpperCase() === sym,
  );
  return inst?.digits ?? 5;
}

function toBidBar(bar: Bar, halfSpread: number, digits: number): Bar {
  if (halfSpread <= 0) return bar;
  const shift = (v: number) => Number((v - halfSpread).toFixed(digits));
  return {
    ...bar,
    open: shift(bar.open), high: shift(bar.high),
    low: shift(bar.low), close: shift(bar.close),
  };
}

/* ─── Helpers ─── */

function segmentToSymbolType(segment: string | undefined): string {
  switch ((segment || '').toLowerCase()) {
    case 'forex': return 'forex';
    case 'crypto': return 'crypto';
    case 'indices': case 'index': return 'index';
    case 'commodities': case 'commodity': return 'commodity';
    case 'stocks': case 'stock': return 'stock';
    default: return '';
  }
}

/* ═══════════ DATAFEED ═══════════ */

export const swisDexDatafeed: IBasicDataFeed = {
  onReady: (cb) => {
    setTimeout(() => cb(CONFIG), 0);
  },

  searchSymbols: (
    userInput: string, _exchange: string, symbolType: string, onResult: SearchSymbolsCallback,
  ) => {
    const { instruments } = useTradingStore.getState();
    const q = userInput.trim().toUpperCase();
    const result: SearchSymbolResultItem[] = instruments
      .filter((i) => {
        if (symbolType && segmentToSymbolType(i.segment) !== symbolType) return false;
        if (!q) return true;
        return i.symbol.toUpperCase().includes(q) || (i.display_name || '').toUpperCase().includes(q);
      })
      .slice(0, 50)
      .map((i) => ({
        symbol: i.symbol, full_name: i.symbol,
        description: i.display_name || i.symbol,
        exchange: 'SwisDex', ticker: i.symbol,
        type: segmentToSymbolType(i.segment) || 'forex',
      }));
    onResult(result);
  },

  resolveSymbol: (symbolName: string, onResolve: ResolveCallback, onError: (reason: string) => void) => {
    const sym = symbolName.split(':').pop()?.toUpperCase() || symbolName.toUpperCase();
    const inst = useTradingStore.getState().instruments.find((i) => i.symbol.toUpperCase() === sym);
    const digits = inst?.digits ?? 5;

    const info: LibrarySymbolInfo = {
      ticker: sym, name: sym,
      description: inst?.display_name || sym,
      type: segmentToSymbolType(inst?.segment) || 'forex',
      session: '24x7', timezone: 'Etc/UTC',
      exchange: 'SwisDex', listed_exchange: 'SwisDex',
      format: 'price', pricescale: Math.pow(10, digits), minmov: 1,
      has_intraday: true, has_daily: true,
      // false on purpose: the library BUILDS 1W/1M/3M/6M/12M from our 1D bars.
      has_weekly_and_monthly: false,
      // Base intraday resolutions the SERVER provides; anything else in
      // supported_resolutions (3, 10, 45, 120, 180) is aggregated client-side
      // from the closest base (client 2026-07-13 timeframe additions).
      intraday_multipliers: SERVER_RESOLUTIONS,
      daily_multipliers: ['1'] as ResolutionString[],
      supported_resolutions: SUPPORTED_RESOLUTIONS,
      volume_precision: 2, data_status: 'streaming',
    };
    setTimeout(() => onResolve(info), 0);
    void onError;
  },

  getBars: async (
    symbolInfo: LibrarySymbolInfo, resolution: ResolutionString,
    periodParams: PeriodParams, onResult: HistoryCallback, onError: (reason: string) => void,
  ) => {
    try {
      const sym = (symbolInfo.ticker || symbolInfo.name).toUpperCase();
      const { from, to } = periodParams;

      // 1. ENGINE bars FIRST for EVERY symbol — the InfoWay candles aggregated
      //    by market-data's BarAggregator (gateway /instruments/{sym}/bars).
      //    This is the same feed the running P&L is priced off, so the chart
      //    matches the P&L for crypto AND non-crypto (client 2026-06-26).
      try {
        const params = new URLSearchParams({
          resolution: String(resolution), from: String(from), to: String(to),
        });
        const res = await fetch(`/api/v1/instruments/${encodeURIComponent(sym)}/bars?${params}`);
        if (res.ok) {
          const data = await res.json();
          const rawBars = Array.isArray(data?.bars) ? data.bars : [];
          if (rawBars.length > 0) {
            // Engine bars are MID-based — shift to BID so the chart matches
            // the panel bid / P&L current price (see "Bid-based chart shift").
            // waitForPrice resolves instantly when a tick is already in the
            // store; the timeout only bites on a dead feed, where hs=0 keeps
            // the (mid) bars rather than blocking the chart.
            const liveTick = await waitForPrice(sym, 2500);
            const hs = halfSpreadOf(liveTick);
            const digits = symbolDigits(sym);
            const bars: Bar[] = rawBars.map((b: any) => toBidBar({
              time: b.time * 1000, open: b.open, high: b.high,
              low: b.low, close: b.close, volume: b.volume,
            }, hs, digits));
            onResult(dropWeekendBars(bars, sym), { noData: false });
            return;
          }
        }
      } catch { /* backend unavailable — fall through */ }

      // 2. No data → say so honestly. The synthetic random-walk fallback was
      //    REMOVED (client 2026-07-14): it painted flat fake bars anchored to
      //    TODAY'S price wherever real history hadn't loaded, which drew a
      //    giant cliff/"gap" where the fake region met real InfoWay history
      //    (e.g. XAUUSD 1h flat at ~4,050 jumping to the real ~4,800 of
      //    April). Never invent prices — the chart simply ends at the oldest
      //    real bar, like MT5.
      onResult([], { noData: true });
    } catch (err) {
      onError((err as Error).message || 'getBars failed');
    }
  },

  subscribeBars: (
    symbolInfo: LibrarySymbolInfo, resolution: ResolutionString,
    onTick: SubscribeBarsCallback, listenerGuid: string,
    onResetCacheNeededCallback?: () => void,
  ) => {
    const sym = (symbolInfo.ticker || symbolInfo.name).toUpperCase();
    const res = String(resolution);
    ensureReconnectHook();

    // Subscribe to the gateway's bar-update channel — the SOLE source for the
    // live candle. market-data publishes bar:current:<SYM>:<TF> to /ws/bars on
    // EVERY tick (plus a 1s heartbeat), so this alone keeps the candle live and
    // it always equals the server aggregation (hence the running P&L too).
    //
    // The old fixed-150ms "nudge" that ALSO pushed the /ws/prices store mid into
    // the candle close was REMOVED (2026-07-10). With the real InfoWay feed the
    // last-trade price bounces tick-to-tick, and /ws/bars (bar close) and
    // /ws/prices (store mid) arrive on SEPARATE sockets — at any instant they
    // hold DIFFERENT recent ticks. Driving the candle from BOTH made its close
    // flip between the two values ~10×/s: the visible "candle blinking". One
    // source ⇒ the candle moves once per real tick, no flicker.
    const unsub = barSocket.subscribe(sym, res, (bar: ServerBar) => {
      const sub = subscriptions.get(listenerGuid);
      if (!sub) return;
      // Shift the mid bar to BID using the live spread (0 until admin sets one).
      // Server emits seconds — TV wants ms.
      const hs = halfSpreadOf(useTradingStore.getState().prices[sym]);
      const digits = symbolDigits(sym);
      const b = toBidBar({
        time: bar.time * 1000,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      }, hs, digits);
      sub.onTick(b);
    });

    subscriptions.set(listenerGuid, {
      symbol: sym, resolution: res, onTick,
      resetCache: onResetCacheNeededCallback,
      unsubscribe: () => { unsub(); },
    });
  },

  unsubscribeBars: (listenerGuid: string) => {
    const sub = subscriptions.get(listenerGuid);
    if (sub) { sub.unsubscribe(); subscriptions.delete(listenerGuid); }
  },
};
