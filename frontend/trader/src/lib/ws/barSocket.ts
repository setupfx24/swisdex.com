/**
 * Singleton WebSocket client for live OHLC bar updates from the gateway.
 *
 * Connects to /ws/bars and forwards server-pushed `bar_update` events to
 * registered listeners filtered by (symbol, resolution). Replaces the
 * trader frontend's old client-side bar synthesis (which assembled the
 * in-progress candle from raw ticks and drifted from the server's
 * authoritative aggregation in market-data/src/bar_aggregator.py).
 *
 * Wire protocol mirrors the server hub at gateway/src/main.py:bar_stream:
 *   client → server: {"type":"subscribe","symbol":"XAUUSD","resolution":"5"}
 *                    {"type":"unsubscribe","symbol":"XAUUSD","resolution":"5"}
 *                    {"type":"ping"}
 *   server → client: {"type":"bar_update","symbol":"XAUUSD","resolution":"5",
 *                     "bar":{"time":1731000000,"open":...,"high":...,...}}
 *                    {"type":"pong"}
 *                    {"type":"subscribed",...}
 *
 * `bar.time` is bar-START in epoch SECONDS (matches the rest of the bar
 * pipeline). The TradingView datafeed expects MILLISECONDS — conversion
 * happens in datafeed.ts where we relay the bar to TV's onRealtimeCallback.
 */
import { getWebSocketBaseUrl } from './getWebSocketBaseUrl';

export interface ServerBar {
  time: number;   // epoch seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type BarUpdateCallback = (bar: ServerBar) => void;

interface ListenerEntry {
  key: string;     // SYMBOL_UPPER + ':' + resolution-string
  symbol: string;  // upper
  resolution: string;
  callback: BarUpdateCallback;
}

class BarSocket {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<ListenerEntry>>(); // key → entries
  private connecting = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly maxReconnectAttempts = 50; // ~quasi-permanent retry
  // Fires after a RE-connect (not the first connect) so the datafeed can reset
  // TradingView's bar cache and re-fetch history — heals bars missed while the
  // socket was down (client 2026-07-03).
  private _everConnected = false;
  private _reconnectListeners = new Set<() => void>();

  /** Register a callback fired after the socket RE-connects. Returns an
   *  unsubscribe function. */
  onReconnect(cb: () => void): () => void {
    this._reconnectListeners.add(cb);
    return () => { this._reconnectListeners.delete(cb); };
  }

  private subKey(symbol: string, resolution: string) {
    return `${symbol.toUpperCase()}:${resolution}`;
  }

  /** Open the WS if it isn't already, and re-send subscriptions on reconnect. */
  private connect() {
    if (this.connecting) return;
    if (this.ws?.readyState === WebSocket.OPEN) return;
    this.connecting = true;

    let ws: WebSocket;
    try {
      ws = new WebSocket(`${getWebSocketBaseUrl()}/ws/bars`);
    } catch {
      this.connecting = false;
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.connecting = false;
      const wasReconnect = this._everConnected;
      this._everConnected = true;
      this.reconnectAttempts = 0;
      // Re-subscribe to everything any chart is currently asking for.
      // On a fresh page-load this is empty; on a reconnect it restores state.
      for (const key of this.listeners.keys()) {
        const [symbol, resolution] = key.split(':');
        this.send({ type: 'subscribe', symbol, resolution });
      }
      this.startPing();
      // On a RECONNECT (not the first open), notify listeners so the chart can
      // re-fetch history and fill any bars missed while the socket was down —
      // otherwise TradingView leaves a gap at those minutes until a manual
      // refresh (client 2026-07-03).
      if (wasReconnect) {
        for (const cb of this._reconnectListeners) {
          try { cb(); } catch { /* listener errors must not break the socket */ }
        }
      }
    };

    ws.onmessage = (event) => {
      let msg: { type?: string; symbol?: string; resolution?: string; bar?: ServerBar };
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg?.type === 'bar_update' && msg.symbol && msg.resolution && msg.bar) {
        const key = this.subKey(msg.symbol, msg.resolution);
        const set = this.listeners.get(key);
        if (!set) return;
        for (const entry of set) entry.callback(msg.bar);
      } else if (msg?.type === 'ping') {
        // Server keep-alive — no-op; the underlying ws ping handles this.
      }
    };

    ws.onclose = () => {
      this.connecting = false;
      this.stopPing();
      this.ws = null;
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // Let onclose handle reconnect; force-close so we don't dangle.
      try { ws.close(); } catch { /* ignore */ }
    };
  }

  private send(payload: Record<string, unknown>) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch {
      // Connection died between readyState check and send — ignore;
      // reconnect handler will replay subscriptions on reopen.
    }
  }

  private startPing() {
    this.stopPing();
    // Send a 25s app-level ping so the gateway's idle-disconnect timer never
    // trips on a quiet symbol (e.g. weekend forex).
    this.pingTimer = setInterval(() => this.send({ type: 'ping' }), 25_000);
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    if (this.reconnectTimer) return;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** Register a listener for bar updates on (symbol, resolution).
   *  Returns an unsubscribe function — call it from TV's unsubscribeBars. */
  subscribe(symbol: string, resolution: string, callback: BarUpdateCallback): () => void {
    const key = this.subKey(symbol, resolution);
    const entry: ListenerEntry = { key, symbol: symbol.toUpperCase(), resolution, callback };
    let set = this.listeners.get(key);
    const wasEmpty = !set || set.size === 0;
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(entry);

    // Open the socket lazily on first subscribe.
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      this.connect();
    }
    if (wasEmpty && this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: 'subscribe', symbol: entry.symbol, resolution: entry.resolution });
    }

    return () => {
      const s = this.listeners.get(key);
      if (!s) return;
      s.delete(entry);
      if (s.size === 0) {
        this.listeners.delete(key);
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.send({ type: 'unsubscribe', symbol: entry.symbol, resolution: entry.resolution });
        }
      }
    };
  }
}

export const barSocket = new BarSocket();
