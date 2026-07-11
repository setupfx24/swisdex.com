import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import api from '@/lib/api/client';

/** Per-instrument contract size used ONLY as a fallback when the instrument
 *  feed didn't carry one. A flat 100000 (forex standard lot) is wrong for
 *  metals/crypto and made live P&L wildly off (e.g. XAUUSD 0.01 lot showed a
 *  1000× P&L vs the backend, so the running value never matched the close —
 *  client 2026-06-19). Metals = 100 oz/lot, crypto = 1 coin/lot. */
export function defaultContractSize(symbol: string): number {
  const s = (symbol || '').trim().toUpperCase();
  if (s.startsWith('XAU') || s.startsWith('XAG') || s.startsWith('XPT') || s.startsWith('XPD')) return 100;
  if (s.startsWith('BTC') || s.startsWith('ETH') || s.startsWith('XRP') || s.startsWith('LTC') || s.startsWith('SOL') || s.includes('USDT')) return 1;
  return 100000;
}

/**
 * Live floating P&L for one position, valued at the tick MID (the same
 * "user close quote" basis the backend uses). SINGLE source of truth shared by
 * the tick handler AND the positions refresh — so a refresh recomputes the
 * live number instead of slamming it to the server's `profit` (often 0/stale),
 * which was the ~1s "P&L flickers to zero" flash. Returns null when there's no
 * usable tick, so the caller keeps whatever value it already had.
 */
export function livePnlFor(
  pos: { side: string; open_price: number; lots: number; effective_lots?: number },
  tick: { bid: number; ask: number } | undefined | null,
  instruments: Array<{ symbol: string; contract_size?: number | null; base_currency?: string | null; quote_currency?: string | null }>,
  symbol: string,
): { cp: number; pnl: number } | null {
  if (!tick) return null;
  const sym = (symbol || '').trim().toUpperCase();
  // Value P&L at the tick MID (bid+ask)/2 — the calc validated as correct. The
  // profit→negative→profit "flicker" was NOT this math; it was the 1.5s REST
  // price poll clobbering the fresh WS bid with a round-trip-stale value (fixed
  // by the tick freshness guard in updatePrice — see lastAppliedTickTs below).
  const cp = (tick.bid > 0 && tick.ask > 0)
    ? (tick.bid + tick.ask) / 2
    : (pos.side === 'buy' ? tick.bid : tick.ask);
  if (!(cp > 0)) return null;
  const inst =
    instruments.find((i) => i.symbol === sym) ||
    instruments.find((i) => String(i.symbol).toUpperCase() === sym);
  const cs = inst?.contract_size || defaultContractSize(sym);
  const pnlLots = pos.effective_lots ?? pos.lots;
  let pnl = pos.side === 'buy'
    ? (cp - pos.open_price) * pnlLots * cs
    : (pos.open_price - cp) * pnlLots * cs;
  const base = (inst?.base_currency || (sym.length >= 6 ? sym.slice(0, 3) : '')).toUpperCase();
  const quote = (inst?.quote_currency || (sym.length >= 6 ? sym.slice(3, 6) : '')).toUpperCase();
  if (quote && quote !== 'USD' && base === 'USD' && cp) {
    pnl = pnl / cp;
  }
  return { cp, pnl };
}

// ─── Live-price freshness guard (fixes the P&L flicker WITHOUT freezing it) ───
// Two sources write prices: the live WS (/ws/prices, bursty — gaps up to ~2.5s)
// and the 1.5s REST poll (/instruments/prices/all). The poll's value is
// round-trip-stale, so applying it right after a fresher WS tick snapped the P&L
// backward for one frame — the reported profit→negative→profit flicker. Ticks
// carry a millisecond server timestamp; we ignore one whose ts is older/equal to
// the last APPLIED tick for that symbol (also drops duplicate re-publishes, which
// carry the same value). We never freeze: if nothing fresh arrived for
// STALE_TICK_GRACE_MS we let even a stale value through, so a dead WS falls back
// to the poll. Centralised here so every caller (trading layout + trade panel,
// each WS + poll) is covered. (client 2026-07-10)
const lastAppliedTickTs = new Map<string, number>();   // last applied server ts (epoch ms)
const lastAppliedTickWall = new Map<string, number>(); // wall-clock of last apply (epoch ms)
const STALE_TICK_GRACE_MS = 3000;

export interface TickData {
  symbol: string;
  bid: number;
  ask: number;
  timestamp: string;
  spread: number;
}

export interface Position {
  id: string;
  account_id: string;
  symbol: string;
  side: 'buy' | 'sell';
  /** Display lots — what the trader typed (e.g. 0.01 on a cent
   *  account). Shown in the QTY column. */
  lots: number;
  /** Raw engine lots (e.g. 0.0001 on a cent account, multiplier 0.01).
   *  MUST be used for live P&L recompute — using `lots` overstates a
   *  cent position's P&L 100×. Falls back to `lots` when absent
   *  (standard accounts where the two are equal). */
  effective_lots?: number;
  open_price: number;
  current_price?: number;
  stop_loss?: number;
  take_profit?: number;
  swap: number;
  commission: number;
  profit: number;
  /** copy_trade | self_trade when API provides it (open positions / copy trading). */
  trade_type?: string;
  created_at: string;
  // Insurance markers per position — null when no active policy. Used
  // by PositionsPanel to render an "Insurance OK in 25s / Expires in
  // 2h 15m" countdown chip next to the close button.
  insurance_activated_at?: string | null;
  insurance_eligible_at?: string | null;
  insurance_expires_at?: string | null;
}

export interface PendingOrder {
  id: string;
  account_id: string;
  symbol: string;
  order_type: string;
  side: 'buy' | 'sell';
  status: string;
  lots: number;
  price: number;
  stop_loss?: number;
  take_profit?: number;
  created_at: string;
}

/** Account type (account_groups) — spreads / commission / min deposit configured in admin. */
export interface AccountGroupInfo {
  id: string;
  name: string;
  spread_markup: number;
  commission_per_lot: number;
  minimum_deposit: number;
  swap_free: boolean;
  leverage_default: number;
  /** Hard ceiling from migration 0020; falls back to leverage_default for legacy rows. */
  max_leverage?: number;
  /** Smaller of max_leverage and the per-user KYC cap (50 for non-KYC). Use this
   *  to clamp the leverage picker — leverage_default is just a UI hint, not the cap. */
  effective_max_leverage?: number;
  /** Cent-account display flag (Mig 0068). When true, the trader UI
   *  multiplies visible balance / equity / P&L by 100 and renders ¢. */
  is_cent_account?: boolean | null;
  /** Lot scaling factor (Mig 0069). 1 = no scaling. 0.01 = cent group:
   *  the order panel multiplies the margin preview + insurance quote
   *  lots by this so the displayed margin + the "Insufficient margin"
   *  gate match what the backend actually charges. */
  lot_size_multiplier?: number | null;
  /** Per-account-type insurance gate (Mig 0070). False = hide the
   *  Trade Insurance picker for accounts of this type. */
  insurance_enabled?: boolean | null;
}

export interface TradingAccount {
  id: string;
  account_number: string;
  balance: number;
  credit: number;
  equity: number;
  margin_used: number;
  free_margin: number;
  margin_level: number;
  leverage: number;
  currency: string;
  is_demo: boolean;
  account_group?: AccountGroupInfo | null;
}

export interface InstrumentInfo {
  symbol: string;
  display_name: string;
  segment: string;
  digits: number;
  pip_size: number;
  min_lot: number;
  max_lot: number;
  lot_step: number;
  contract_size: number;
  base_currency?: string | null;
  quote_currency?: string | null;
}

/** One-shot prefill for order panel (clone from open position). */
export type OrderFormCloneDraft = {
  symbol: string;
  side: 'buy' | 'sell';
  lots: number;
  stop_loss?: number | null;
  take_profit?: number | null;
};

interface TradingState {
  activeAccount: TradingAccount | null;
  accounts: TradingAccount[];
  positions: Position[];
  pendingOrders: PendingOrder[];
  selectedSymbol: string;
  prices: Record<string, TickData>;
  prevPrices: Record<string, number>;
  watchlist: string[];
  instruments: InstrumentInfo[];

  setActiveAccount: (a: TradingAccount | null) => void;
  setAccounts: (a: TradingAccount[]) => void;
  setPositions: (p: Position[]) => void;
  setPendingOrders: (o: PendingOrder[]) => void;
  setSelectedSymbol: (s: string) => void;
  updatePrice: (t: TickData) => void;
  addToWatchlist: (s: string) => void;
  removeFromWatchlist: (s: string) => void;
  setInstruments: (i: InstrumentInfo[]) => void;
  removePosition: (id: string) => void;
  removeAccount: (id: string) => void;
  refreshPositions: () => Promise<void>;
  refreshPendingOrders: () => Promise<void>;
  refreshAccount: () => Promise<void>;
  placeOrder: (data: {
    account_id: string;
    symbol: string;
    side: 'buy' | 'sell';
    order_type: 'market' | 'limit' | 'stop' | 'stop_limit';
    lots: number;
    price?: number;
    stop_loss?: number;
    take_profit?: number;
    stop_limit_price?: number;
  }) => Promise<any>;

  orderFormCloneDraft: OrderFormCloneDraft | null;
  setOrderFormCloneDraft: (d: OrderFormCloneDraft | null) => void;
}

const DEFAULT_WATCHLIST = [
  'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD',
  'XAUUSD', 'XAGUSD', 'USOIL', 'BTCUSD', 'ETHUSD', 'SOLUSD',
  'US30', 'NAS100', 'GER40', 'EURJPY', 'GBPJPY',
];

const DEFAULT_SYMBOL = 'XAUUSD';
const SYMBOL_STORAGE_KEY = 'swisdex-selected-symbol';

function getPersistedSymbol(): string {
  if (typeof window === 'undefined') return DEFAULT_SYMBOL;
  try {
    return sessionStorage.getItem(SYMBOL_STORAGE_KEY) || DEFAULT_SYMBOL;
  } catch {
    return DEFAULT_SYMBOL;
  }
}

export const useTradingStore = create<TradingState>()((set, get) => ({
  activeAccount: null,
  accounts: [],
  positions: [],
  pendingOrders: [],
  selectedSymbol: getPersistedSymbol(),
  prices: {},
  prevPrices: {},
  watchlist: DEFAULT_WATCHLIST,
  instruments: [],
  orderFormCloneDraft: null,

  setActiveAccount: (a) => set({ activeAccount: a }),
  setAccounts: (a) => set({ accounts: a }),
  setPositions: (p) => set({ positions: p }),
  setPendingOrders: (o) => set({ pendingOrders: o }),
  setSelectedSymbol: (s) => {
    set({ selectedSymbol: s });
    try { sessionStorage.setItem(SYMBOL_STORAGE_KEY, s); } catch {}
  },
  setInstruments: (i) => set({ instruments: i }),
  setOrderFormCloneDraft: (d) => set({ orderFormCloneDraft: d }),
  removePosition: (id) => set((s) => ({ positions: s.positions.filter((p) => p.id !== id) })),

  removeAccount: (id) =>
    set((s) => ({
      accounts: s.accounts.filter((a) => a.id !== id),
      activeAccount: s.activeAccount?.id === id ? null : s.activeAccount,
    })),

  refreshPositions: async () => {
    const account = get().activeAccount;
    if (!account) return;
    try {
      const positions = await api.get<any[]>(`/positions/`, { account_id: account.id, status: 'open' });
      const list = Array.isArray(positions) ? positions : [];
      // Latest ticks/instruments so we can value each refreshed position at the
      // live MID immediately — otherwise the server's `profit` (often 0/stale
      // for a freshly-opened position) shows for ~1s until the next tick,
      // which is the "P&L flickers to zero" flash.
      const livePrices = get().prices;
      const liveInstruments = get().instruments;
      set({
        positions: list.map((p: any) => {
          const mapped = {
            id: p.id,
            account_id: p.account_id,
            symbol: p.symbol || '',
            side: p.side,
            lots: Number(p.lots) || 0,
            // Engine lots (0.0001 on a cent account). MUST be carried through
            // or the live P&L recompute below falls back to display `lots`
            // and a cent position's P&L jumps 100×. Was being dropped here.
            effective_lots: p.effective_lots != null ? Number(p.effective_lots) : undefined,
            open_price: Number(p.open_price) || 0,
            current_price: p.current_price != null ? Number(p.current_price) : undefined,
            stop_loss: p.stop_loss != null ? Number(p.stop_loss) : undefined,
            take_profit: p.take_profit != null ? Number(p.take_profit) : undefined,
            swap: Number(p.swap) || 0,
            commission: Number(p.commission) || 0,
            profit: Number(p.profit) || 0,
            trade_type: p.trade_type,
            created_at: p.created_at,
            // Insurance markers — without these the badge ALWAYS reads
            // "Not insured" and the countdown never renders (the backend
            // sends them; the mapper was silently discarding them).
            insurance_activated_at: p.insurance_activated_at ?? null,
            insurance_eligible_at: p.insurance_eligible_at ?? null,
            insurance_expires_at: p.insurance_expires_at ?? null,
          };
          const sym = (mapped.symbol || '').trim().toUpperCase();
          const r = livePnlFor(mapped, livePrices[sym], liveInstruments, sym);
          return r ? { ...mapped, current_price: r.cp, profit: r.pnl } : mapped;
        }),
      });
    } catch {}
  },

  refreshPendingOrders: async () => {
    const account = get().activeAccount;
    if (!account) return;
    try {
      const orders = await api.get<any[]>(`/orders/`, { account_id: account.id, status: 'pending' });
      const list = Array.isArray(orders) ? orders : [];
      set({
        pendingOrders: list.map((o: any) => ({
          id: String(o.id),
          account_id: String(o.account_id),
          symbol: String(o.symbol || (o.instrument as { symbol?: string })?.symbol || ''),
          order_type: String(o.order_type),
          side: o.side,
          status: String(o.status),
          lots: Number(o.lots) || 0,
          price: Number(o.price) || 0,
          stop_loss: o.stop_loss != null ? Number(o.stop_loss) : undefined,
          take_profit: o.take_profit != null ? Number(o.take_profit) : undefined,
          created_at: String(o.created_at ?? ''),
        })),
      });
    } catch {}
  },

  refreshAccount: async () => {
    const account = get().activeAccount;
    if (!account) return;
    try {
      const res = await api.get<any>('/accounts');
      const items = Array.isArray(res) ? res : (res?.items ?? []);
      const updated = items.find((a: any) => a.id === account.id);
      if (updated) {
        set({
          activeAccount: {
            ...account,
            balance: Number(updated.balance) || 0,
            equity: Number(updated.equity) || 0,
            margin_used: Number(updated.margin_used) || 0,
            free_margin: Number(updated.free_margin) || 0,
            credit: Number(updated.credit) || 0,
            margin_level: Number(updated.margin_level) || 0,
            leverage: Number(updated.leverage) || account.leverage,
            account_group: updated.account_group ?? account.account_group,
          },
        });
      }
    } catch {}
  },

  updatePrice: (tick) => set((state) => {
    const sym = String(tick.symbol || '').trim().toUpperCase();
    if (!sym) return state;
    const normalized: TickData = { ...tick, symbol: sym };

    // Freshness guard (see lastAppliedTickTs above): drop the round-trip-stale
    // REST-poll value (or a duplicate re-publish) that flashed the P&L backward,
    // but only while a fresher tick is recent — after STALE_TICK_GRACE_MS of
    // silence, let it through so a dead socket falls back to the poll (no freeze).
    const nowWall = Date.now();
    const ts = Date.parse(normalized.timestamp);
    const prevTs = lastAppliedTickTs.get(sym);
    const prevWall = lastAppliedTickWall.get(sym) ?? 0;
    if (Number.isFinite(ts) && prevTs !== undefined && ts <= prevTs
        && nowWall - prevWall < STALE_TICK_GRACE_MS) {
      return state; // stale/duplicate while a fresher value is live — ignore
    }
    lastAppliedTickWall.set(sym, nowWall);
    if (Number.isFinite(ts) && (prevTs === undefined || ts > prevTs)) {
      lastAppliedTickTs.set(sym, ts);
    }

    const prev = state.prices[sym];
    return {
      prevPrices: prev
        ? { ...state.prevPrices, [sym]: prev.bid }
        : state.prevPrices,
      prices: { ...state.prices, [sym]: normalized },
      positions: state.positions.map((pos) => {
        const pSym = String(pos.symbol || '').trim().toUpperCase();
        if (pSym !== sym) return pos;
        // Value floating P&L at the tick MID via the shared helper (same
        // "user close quote" basis the backend uses) — keeps the frontend in
        // lockstep with the backend so the number doesn't snap on refresh.
        const r = livePnlFor(pos, normalized, state.instruments, sym);
        if (!r) return pos;
        return { ...pos, current_price: r.cp, profit: r.pnl };
      }),
    };
  }),

  addToWatchlist: (s) => set((st) => ({
    watchlist: st.watchlist.includes(s) ? st.watchlist : [...st.watchlist, s],
  })),

  removeFromWatchlist: (s) => set((st) => ({
    watchlist: st.watchlist.filter((x) => x !== s),
  })),

  placeOrder: async (data) => {
    // Optimistic: market orders hit the book immediately — inject a position
    // row synchronously so the Positions panel reflects the trade without
    // waiting for the server round-trip.
    const s = get();
    const tick = s.prices[data.symbol];
    const optimisticId = `optim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    let rollback: (() => void) | null = null;
    if (data.order_type === 'market' && tick) {
      const execPrice = data.side === 'buy' ? tick.ask : tick.bid;
      const prev = s.positions;
      // Cent-account multiplier so the optimistic row's live P&L matches
      // the engine immediately (no 100× flash before the first refresh).
      const _mult = Number(s.activeAccount?.account_group?.lot_size_multiplier) || 1;
      const _dispLots = Number(data.lots) || 0;
      const optimisticPos = {
        id: optimisticId,
        account_id: data.account_id,
        symbol: data.symbol,
        side: data.side,
        lots: _dispLots,
        effective_lots: _dispLots * _mult,
        open_price: execPrice,
        current_price: execPrice,
        stop_loss: data.stop_loss,
        take_profit: data.take_profit,
        swap: 0,
        commission: 0,
        profit: 0,
        trade_type: 'self_trade',
        created_at: new Date().toISOString(),
      } as (typeof s.positions)[number];
      set({ positions: [optimisticPos, ...prev] });
      rollback = () => set({ positions: prev });
    }

    try {
      const res = await api.post<any>('/orders/', {
        account_id: data.account_id,
        symbol: data.symbol,
        side: data.side,
        order_type: data.order_type,
        lots: data.lots,
        price: data.price,
        stop_loss: data.stop_loss,
        take_profit: data.take_profit,
        stop_limit_price: data.stop_limit_price,
      });

      // Reconcile with server-authoritative state (replaces the optimistic row).
      Promise.all([get().refreshPositions(), get().refreshAccount()]).catch(() => {});

      return res;
    } catch (err) {
      if (rollback) rollback();
      throw err;
    }
  },
}));
