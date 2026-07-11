import { getWebSocketBaseUrl } from './getWebSocketBaseUrl';

type PriceCallback = (data: TickData) => void;

export interface TickData {
  symbol: string;
  bid: number;
  ask: number;
  timestamp: string;
  spread: number;
}

/**
 * Live bid/ask stream from the gateway's /ws/prices channel.
 *
 * Hardened 2026-07-09 to match barSocket's reliability after a production
 * incident where this socket went "half-open" (TCP alive, stream dead) and
 * silently froze the bid/ask panel + P&L at a stale price while the chart
 * (barSocket, which HAS these safeguards) kept updating — a ~4pt divergence:
 *   1. HALF-OPEN WATCHDOG — the server pushes a {type:'ping'} every 30s, so we
 *      should hear SOMETHING (tick or ping) at least that often. If nothing
 *      arrives for DEAD_MS we force-close → reconnect. This is what caught the
 *      stall the old code missed (it only reacted to onclose/onerror, which
 *      never fire on a half-open socket).
 *   2. maxReconnectAttempts 10 → 50 (was giving up permanently after 10).
 *   3. onReconnect hook so consumers can refetch a fresh snapshot on recovery.
 * NOTE: /ws/prices does NOT read client frames, so we deliberately do NOT send
 * client pings (they'd just buffer server-side) — the server's own 30s ping is
 * our heartbeat.
 */
class PriceSocket {
  private ws: WebSocket | null = null;
  private callbacks: Set<PriceCallback> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 50; // was 10 — matches barSocket (quasi-permanent)

  // Half-open detection: last time ANY frame (tick or server ping) arrived.
  private lastMessageAt = 0;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  // Server pings every 30s → 45s of total silence means the stream is dead.
  private readonly DEAD_MS = 45_000;

  private _everConnected = false;
  private _reconnectListeners = new Set<() => void>();

  /** Register a callback fired after the socket RE-connects (not first open),
   *  so a consumer can refetch the latest bid/ask snapshot. Returns unsubscribe. */
  onReconnect(cb: () => void): () => void {
    this._reconnectListeners.add(cb);
    return () => { this._reconnectListeners.delete(cb); };
  }

  connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    const wsUrl = `${getWebSocketBaseUrl()}/ws/prices`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        const wasReconnect = this._everConnected;
        this._everConnected = true;
        this.reconnectAttempts = 0;
        this.lastMessageAt = Date.now();
        this.startWatchdog();
        // On a RECONNECT, let consumers refetch so the panel doesn't sit on a
        // stale value between reconnect and the first fresh tick.
        if (wasReconnect) {
          for (const cb of this._reconnectListeners) {
            try { cb(); } catch { /* listener errors must not break the socket */ }
          }
        }
      };

      this.ws.onmessage = (event) => {
        this.lastMessageAt = Date.now();
        let data: TickData & { type?: string };
        try {
          data = JSON.parse(event.data);
        } catch {
          return; // ignore malformed messages
        }
        // Server heartbeat — keeps the connection provably alive but is NOT a
        // price tick; don't dispatch it to consumers.
        if ((data as { type?: string }).type === 'ping') return;
        this.callbacks.forEach((cb) => { try { cb(data); } catch { /* consumer error */ } });
      };

      this.ws.onclose = () => {
        this.stopWatchdog();
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.ws?.close();
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  /** Force a reconnect when the stream goes silent past DEAD_MS (half-open). */
  private startWatchdog() {
    this.stopWatchdog();
    this.watchdogTimer = setInterval(() => {
      if (
        this.ws?.readyState === WebSocket.OPEN &&
        Date.now() - this.lastMessageAt > this.DEAD_MS
      ) {
        // No tick AND no server ping for DEAD_MS → the socket is dead even
        // though readyState says OPEN. Close it to trigger onclose → reconnect.
        try { this.ws.close(); } catch { /* noop */ }
      }
    }, 10_000);
  }

  private stopWatchdog() {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  private scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    if (this.reconnectTimer) return;

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  subscribe(callback: PriceCallback) {
    this.callbacks.add(callback);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.connect();
    }
    return () => {
      this.callbacks.delete(callback);
    };
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopWatchdog();
    this.ws?.close();
    this.ws = null;
    this.callbacks.clear();
  }
}

export const priceSocket = new PriceSocket();
