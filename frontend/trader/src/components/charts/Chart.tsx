'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { ChartEngine } from '@/charting/core/ChartEngine';
import { OHLCV, ChartType, Timeframe } from '@/charting/core/types';
import { useTradingStore } from '@/stores/tradingStore';
import { useUIStore } from '@/stores/uiStore';
import * as indicators from '@/charting/indicators';
import { cn, getDigits } from '@/lib/utils';
import api from '@/lib/api/client';

const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '30m', '1H', '4H', '1D', '1W', '1M'];

// Map our timeframe labels to the gateway /bars `resolution` (TradingView
// style) and to a bar length in seconds. Client 2026-06-19: the terminal
// chart must show the BROKER's own prices (same source as the bid/ask in the
// order panel) — not TradingView's external feed — so the candles match what
// you actually trade at, and there's no slow external widget to re-inject.
const TF_TO_RESOLUTION: Record<string, string> = {
  '1m': '1', '5m': '5', '15m': '15', '30m': '30',
  '1H': '60', '4H': '240', '1D': '1D', '1W': '1W', '1M': '1M',
};
const TF_SECONDS: Record<string, number> = {
  '1m': 60, '5m': 300, '15m': 900, '30m': 1800,
  '1H': 3600, '4H': 14400, '1D': 86400, '1W': 604800, '1M': 2592000,
};
const CHART_TYPES: { label: string; value: ChartType }[] = [
  { label: 'Candles', value: 'candlestick' },
  { label: 'Line', value: 'line' },
  { label: 'Area', value: 'area' },
  { label: 'H-Ashi', value: 'heikin_ashi' },
];

const INDICATOR_LIST = [
  { name: 'SMA 20', fn: (d: OHLCV[]) => indicators.sma(d, 20), color: '#F7931A' },
  { name: 'SMA 50', fn: (d: OHLCV[]) => indicators.sma(d, 50), color: '#8B5CF6' },
  { name: 'EMA 20', fn: (d: OHLCV[]) => indicators.ema(d, 20), color: '#29B6F6' },
  { name: 'BB Upper', fn: (d: OHLCV[]) => indicators.bollingerBands(d).upper, color: '#2962FF' },
  { name: 'BB Middle', fn: (d: OHLCV[]) => indicators.bollingerBands(d).middle, color: '#2962FF80' },
  { name: 'BB Lower', fn: (d: OHLCV[]) => indicators.bollingerBands(d).lower, color: '#2962FF' },
  { name: 'VWAP', fn: (d: OHLCV[]) => indicators.vwap(d), color: '#FF2440' },
];

function generateDemoData(symbol: string, count: number): OHLCV[] {
  const data: OHLCV[] = [];
  const basePrices: Record<string, number> = {
    EURUSD: 1.085, GBPUSD: 1.268, USDJPY: 154.5, XAUUSD: 2340, BTCUSD: 67500,
    US30: 39800, NAS100: 18500, USOIL: 78.5, ETHUSD: 3450, AUDUSD: 0.652,
  };
  let price = basePrices[symbol] || 1.0;
  const now = Date.now() / 1000;
  const interval = 60;

  for (let i = 0; i < count; i++) {
    const volatility = price * 0.001;
    const open = price;
    const change1 = (Math.random() - 0.48) * volatility;
    const change2 = (Math.random() - 0.48) * volatility;
    const high = Math.max(open, open + change1, open + change2) + Math.random() * volatility * 0.5;
    const low = Math.min(open, open + change1, open + change2) - Math.random() * volatility * 0.5;
    const close = open + (Math.random() - 0.48) * volatility;
    data.push({ time: now - (count - i) * interval, open, high, low, close, volume: Math.random() * 1000 + 100 });
    price = close;
  }
  return data;
}

export default function Chart() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<ChartEngine | null>(null);
  const { selectedSymbol, prices } = useTradingStore();
  const { chartTimeframe: selectedTimeframe, setChartTimeframe: setSelectedTimeframe } = useUIStore();
  const [chartType, setChartType] = useState<ChartType>('candlestick');
  const [activeIndicators, setActiveIndicators] = useState<string[]>([]);
  const [showIndicatorMenu, setShowIndicatorMenu] = useState(false);
  const [hoveredOHLC, setHoveredOHLC] = useState<{ o: number; h: number; l: number; c: number } | null>(null);
  const [isSynthetic, setIsSynthetic] = useState(false);
  const dataRef = useRef<OHLCV[]>([]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const engine = new ChartEngine(canvasRef.current);
    engineRef.current = engine;
    engine.setDigits(getDigits(selectedSymbol));
    engine.setChartType(chartType);

    let cancelled = false;
    const applyBars = (bars: OHLCV[], synthetic: boolean) => {
      if (cancelled) return;
      dataRef.current = bars;
      engine.setData(bars);
      setIsSynthetic(synthetic);
    };

    // Pull real broker bars; fall back to clearly-labelled synthetic data only
    // if every source fails (matches the /bars `noData` contract).
    (async () => {
      try {
        const res = await api.get<{ bars?: OHLCV[]; noData?: boolean }>(
          `/instruments/${encodeURIComponent(selectedSymbol)}/bars`,
          { resolution: TF_TO_RESOLUTION[selectedTimeframe] || '5' },
        );
        const bars = (res?.bars || []).map((b) => ({
          time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0,
        }));
        if (bars.length > 0 && !res?.noData) {
          applyBars(bars, false);
        } else {
          applyBars(generateDemoData(selectedSymbol, 500), true);
        }
      } catch {
        applyBars(generateDemoData(selectedSymbol, 500), true);
      }
    })();

    return () => { cancelled = true; engine.destroy(); };
  }, [selectedSymbol, selectedTimeframe]);

  useEffect(() => { engineRef.current?.setChartType(chartType); }, [chartType]);

  useEffect(() => {
    const tick = prices[selectedSymbol];
    const engine = engineRef.current;
    if (!tick || !engine) return;
    const mid = (tick.bid + tick.ask) / 2;
    engine.setCurrentPrice(mid);

    // Grow / open the forming candle from the SAME broker mid-price that
    // drives the order panel's bid/ask, so the chart stays in lock-step with
    // what the trader sees (client 2026-06-19).
    const data = dataRef.current;
    if (data.length === 0) return;
    const barSec = TF_SECONDS[selectedTimeframe] || 300;
    const nowSec = Math.floor(Date.now() / 1000);
    const bucket = nowSec - (nowSec % barSec);
    const last = data[data.length - 1];
    if (bucket <= last.time) {
      const updated: OHLCV = { ...last, high: Math.max(last.high, mid), low: Math.min(last.low, mid), close: mid };
      engine.appendCandle(updated);
    } else {
      engine.appendCandle({ time: bucket, open: mid, high: mid, low: mid, close: mid, volume: 0 });
    }
  }, [prices, selectedSymbol, selectedTimeframe]);

  useEffect(() => {
    const data = dataRef.current;
    if (!engineRef.current || data.length === 0) return;
    for (const indName of activeIndicators) {
      const ind = INDICATOR_LIST.find((i) => i.name === indName);
      if (ind) {
        engineRef.current.setIndicatorData(ind.name, ind.fn(data), ind.color);
      }
    }
    INDICATOR_LIST
      .filter((i) => !activeIndicators.includes(i.name))
      .forEach((i) => engineRef.current?.removeIndicator(i.name));
  }, [activeIndicators]);

  const toggleIndicator = (name: string) => {
    setActiveIndicators((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]
    );
  };

  const digits = getDigits(selectedSymbol);
  const lastCandle = dataRef.current[dataRef.current.length - 1];
  const ohlc = hoveredOHLC || (lastCandle ? { o: lastCandle.open, h: lastCandle.high, l: lastCandle.low, c: lastCandle.close } : null);

  return (
    <div className="flex flex-col h-full bg-bg-primary">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-2 py-1 border-b border-border-primary bg-bg-secondary">
        <span className="text-sm font-semibold text-text-primary mr-2">{selectedSymbol}</span>
        {isSynthetic && (
          <span
            className="mr-2 px-1.5 py-0.5 rounded-sm text-[10px] font-medium bg-warning/15 text-warning"
            title="Live market history is temporarily unavailable for this symbol — showing simulated bars. Prices in the order panel are still real."
          >
            Demo data
          </span>
        )}

        {ohlc && (
          <div className="flex items-center gap-2 mr-3 text-xxs tabular-nums font-mono">
            <span className="text-text-tertiary">O</span><span className="text-text-secondary">{ohlc.o.toFixed(digits)}</span>
            <span className="text-text-tertiary">H</span><span className="text-text-secondary">{ohlc.h.toFixed(digits)}</span>
            <span className="text-text-tertiary">L</span><span className="text-text-secondary">{ohlc.l.toFixed(digits)}</span>
            <span className="text-text-tertiary">C</span><span className={ohlc.c >= ohlc.o ? 'text-buy' : 'text-sell'}>{ohlc.c.toFixed(digits)}</span>
          </div>
        )}

        <div className="w-px h-4 bg-border-primary mx-1" />

        {/* Timeframes */}
        <div className="flex gap-0.5">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              onClick={() => setSelectedTimeframe(tf)}
              className={cn(
                'px-1.5 py-0.5 text-xxs rounded-sm transition-fast',
                selectedTimeframe === tf ? 'bg-buy text-text-inverse' : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover',
              )}
            >
              {tf}
            </button>
          ))}
        </div>

        <div className="w-px h-4 bg-border-primary mx-1" />

        {/* Chart Types */}
        <div className="flex gap-0.5">
          {CHART_TYPES.map((ct) => (
            <button
              key={ct.value}
              onClick={() => setChartType(ct.value)}
              className={cn(
                'px-1.5 py-0.5 text-xxs rounded-sm transition-fast',
                chartType === ct.value ? 'bg-buy text-text-inverse' : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover',
              )}
            >
              {ct.label}
            </button>
          ))}
        </div>

        <div className="w-px h-4 bg-border-primary mx-1" />

        {/* Indicators */}
        <div className="relative">
          <button
            onClick={() => setShowIndicatorMenu(!showIndicatorMenu)}
            className="flex items-center gap-1 px-1.5 py-0.5 text-xxs text-text-tertiary hover:text-text-secondary hover:bg-bg-hover rounded-sm transition-fast"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" /></svg>
            Indicators {activeIndicators.length > 0 && `(${activeIndicators.length})`}
          </button>
          {showIndicatorMenu && (
            <div className="absolute top-full left-0 mt-1 bg-bg-tertiary border border-border-primary rounded-md shadow-dropdown z-50 p-1 min-w-[160px] animate-slide-down">
              {INDICATOR_LIST.map((ind) => (
                <button
                  key={ind.name}
                  onClick={() => toggleIndicator(ind.name)}
                  className="flex items-center w-full px-2 py-1.5 text-xs hover:bg-bg-hover rounded-sm gap-2 transition-fast"
                >
                  <div
                    className="w-3 h-3 rounded-sm border"
                    style={{
                      backgroundColor: activeIndicators.includes(ind.name) ? ind.color : 'transparent',
                      borderColor: ind.color,
                    }}
                  />
                  <span className="text-text-primary">{ind.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <button className="flex items-center gap-1 px-1.5 py-0.5 text-xxs text-text-tertiary hover:text-text-secondary hover:bg-bg-hover rounded-sm transition-fast">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
          Draw
        </button>
      </div>

      {/* Canvas */}
      <div className="flex-1 relative">
        <canvas ref={canvasRef} className="w-full h-full" style={{ cursor: 'crosshair' }} />
      </div>
    </div>
  );
}
