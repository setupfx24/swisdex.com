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

const SUPPORTED_RESOLUTIONS: ResolutionString[] = [
  '1', '5', '15', '30', '60', '240', '1D',
] as ResolutionString[];

const RESOLUTION_TO_SECONDS: Record<string, number> = {
  '1': 60, '5': 300, '15': 900, '30': 1800,
  '60': 3600, '240': 14400, D: 86400, '1D': 86400,
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

/* ─── Synthetic historical candles (fallback) ─── */

function seededRand(seed: number) {
  let s = Math.abs(seed) % 2147483647;
  if (s === 0) s = 1;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

function getSymbolCategory(symbol: string): string {
  const s = symbol.toUpperCase();
  if (s.startsWith('XAU') || s.startsWith('XAG')) return 'metals';
  if (['USOIL', 'UKOIL', 'NGAS'].includes(s)) return 'commodities';
  if (['US30', 'US500', 'NAS100', 'UK100', 'GER40'].includes(s)) return 'indices';
  if (BINANCE_PAIRS[s]) return 'crypto';
  return 'forex';
}

function generateSyntheticBars(
  symbol: string, mid: number, spread: number,
  resolution: string, from: number, to: number,
): Bar[] {
  if (mid <= 0) return [];
  const resSec = RESOLUTION_TO_SECONDS[resolution] ?? 300;
  const cat = getSymbolCategory(symbol);

  let volPct = 0.0003;
  if (cat === 'metals') volPct = 0.0004;
  if (cat === 'indices') volPct = 0.0005;
  if (cat === 'commodities') volPct = 0.0006;
  if (cat === 'crypto') volPct = 0.001;
  const resFactor = Math.sqrt(resSec / 300);
  const volatility = Math.max(spread * 1.5, mid * volPct * resFactor);

  const nowSec = Math.floor(Date.now() / 1000);
  const toSec = Math.min(to, nowSec);
  const fromAligned = Math.floor(from / resSec) * resSec;
  const toAligned = Math.floor(toSec / resSec) * resSec;
  if (fromAligned >= toAligned) return [];

  const count = Math.min(Math.floor((toAligned - fromAligned) / resSec) + 1, 500);
  const startSec = toAligned - (count - 1) * resSec;

  // Seed must be STABLE across timeframe switches. Previously it included
  // floor(startSec / 86400) (a per-day offset), which changes when the user
  // changes resolution because resSec * (count - 1) shifts startSec across
  // day boundaries. That made the chart look like an entirely different
  // history every time the trader clicked 5m → 1h → 4h.
  // Now seeded only by symbol — pattern stays consistent across TF switches.
  // (Right architectural fix is to use real OHLC from AllTick REST; this
  // keeps the synthetic fallback usable until that lands.)
  const seed = symbol.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const rand = seededRand(seed);

  const increments = Array.from({ length: count }, () => (rand() - 0.5) * volatility * 2);
  let cumSum = 0;
  const cumSums = increments.map((inc) => { cumSum += inc; return cumSum; });
  const lastCum = cumSums[cumSums.length - 1];
  const prices = cumSums.map((c) => mid + (c - lastCum));

  const bars: Bar[] = [];
  let prev = mid - (cumSums[0] - lastCum);
  for (let i = 0; i < count; i++) {
    const open = prev;
    const close = prices[i];
    bars.push({
      time: (startSec + i * resSec) * 1000,
      open, close,
      high: Math.max(open, close) + Math.abs(rand() * volatility * 0.4),
      low: Math.min(open, close) - Math.abs(rand() * volatility * 0.4),
      volume: Math.floor(rand() * 500) + 50,
    });
    prev = close;
  }
  return bars;
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
      has_intraday: true, has_daily: true, has_weekly_and_monthly: false,
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
            onResult(bars, { noData: false });
            return;
          }
        }
      } catch { /* backend unavailable — fall through */ }

      // 2. Last resort — synthetic walk anchored to the current live mid.
      //    (Binance was removed: InfoWay feeds crypto too, so the engine /bars
      //    above is the single source for every symbol — client 2026-06-26.)
      //    Used only if both backend and Binance failed (fresh deploy with
      //    no aggregated bars in TimescaleDB yet). Synthetic bars do NOT
      //    aggregate across TFs, so this is intentionally the final fallback.
      const tick = await waitForPrice(sym);
      if (tick && tick.bid > 0) {
        // Anchor the synthetic walk at the BID, not the mid, for the same
        // chart==bid alignment as the engine-bar path above.
        const spread = Math.abs(tick.ask - tick.bid);
        const bars = generateSyntheticBars(sym, tick.bid, spread, String(resolution), from, to);
        if (bars.length > 0) {
          onResult(bars, { noData: false });
          return;
        }
      }

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
