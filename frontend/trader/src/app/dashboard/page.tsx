'use client';

/**
 * Broker home — replaces the old open-positions / quick-actions dashboard.
 * Layout follows the Elev8-style brief: account balance card with action
 * buttons, popular deposit methods, top daily movers, status program /
 * rewards, invite-friends banner, deposit bonus, and the existing admin-
 * configurable banner carousel.
 */

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { clsx } from 'clsx';
import {
  ChevronDown, ArrowDownToLine, ArrowUpFromLine,
  TrendingUp, TrendingDown, ArrowRight, Gift,
  ShieldCheck, ExternalLink, Loader2, Calculator,
} from 'lucide-react';
import DashboardShell from '@/components/layout/DashboardShell';
import api from '@/lib/api/client';
import toast from 'react-hot-toast';
import { fmtAccountMoney, isCentAccount } from '@/lib/wallet/centDisplay';

interface AccountRow {
  id: string;
  account_number: string;
  balance: number;
  equity: number;
  free_margin: number;
  margin_used?: number;
  leverage: number;
  is_demo: boolean;
  swap_free?: boolean;
  account_group_name?: string | null;
  // Cent-account display flag (Mig 0068). Populated from
  // `account_group.is_cent_account` on the backend payload. Use
  // fmtAccountMoney(value, isCentAccount(account)) on every visible
  // money figure so balances render in ¢ for cent groups.
  account_group?: { is_cent_account?: boolean | null } | null;
  is_cent_account?: boolean | null;
}

interface Banner {
  id: string;
  title: string;
  image_url: string;
  link_url: string;
  position: string;
}

interface PriceTick { symbol?: string; bid?: number; ask?: number; }
interface BarRow { time: number; open: number; close: number; }

const TOP_MOVER_SYMBOLS = ['XAUUSD', 'NAS100', 'BTCUSD', 'EURUSD'];

const fmtUsd = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })
    .format(Number.isFinite(n) ? n : 0);

const fmtNum = (n: number, dp = 2) =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })
    .format(Number.isFinite(n) ? n : 0);

const tradeUrl = (accountId: string) => {
  const host = process.env.NEXT_PUBLIC_TRADE_HOST;
  const path = `/trading/terminal?account=${encodeURIComponent(accountId)}&view=chart`;
  return host ? `https://${host}${path}` : path;
};

export default function DashboardPage() {
  return (
    <DashboardShell>
      <BrokerHome />
    </DashboardShell>
  );
}

function BrokerHome() {
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [banners, setBanners] = useState<Banner[]>([]);
  const [movers, setMovers] = useState<{ symbol: string; pct: number; price: number }[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [accs, b] = await Promise.all([
          api.get<{ items: AccountRow[] } | AccountRow[]>('/accounts'),
          api.get<{ banners: Banner[] }>('/banners', { page: 'dashboard' }).catch(() => ({ banners: [] as Banner[] })),
        ]);
        if (cancelled) return;
        const list: AccountRow[] = Array.isArray(accs) ? accs : (accs as { items: AccountRow[] }).items || [];
        setAccounts(list);
        if (list.length > 0) setActiveId((cur) => cur ?? list[0].id);
        setBanners(b.banners || []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Daily bars (oldest→newest, today is the last row) only change once a
    // day, so we fetch them ONCE per symbol and keep the day-open in a ref
    // that the polling loop reads. Prices come from /prices/all and refresh
    // every tick — the previous "fetch once on mount" build left the
    // movers card showing whatever pct was computed at page load and
    // never updating, which clients read as "Top Movers not live".
    type BarsResp = { bars?: BarRow[] } | BarRow[] | null | undefined;
    const dayOpenBySymbol: Record<string, number> = {};
    const closeFallbackBySymbol: Record<string, number> = {};

    const loadBars = async () => {
      const barsRaw = await Promise.all(
        TOP_MOVER_SYMBOLS.map((s) =>
          api.get<BarsResp>(`/instruments/${s}/bars`, { resolution: '1D' }).catch(() => null as BarsResp),
        ),
      );
      if (cancelled) return;
      TOP_MOVER_SYMBOLS.forEach((sym, i) => {
        const resp = barsRaw[i];
        const bars: BarRow[] = Array.isArray(resp) ? resp : (resp?.bars ?? []);
        const dayBar = bars.length > 0 ? bars[bars.length - 1] : null;
        if (dayBar) {
          dayOpenBySymbol[sym] = Number(dayBar.open);
          closeFallbackBySymbol[sym] = Number(dayBar.close);
        }
      });
    };

    const recompute = async () => {
      try {
        const ticksRaw = await api.get<PriceTick[]>('/instruments/prices/all').catch(
          () => [] as PriceTick[],
        );
        if (cancelled) return;
        const tickMap = new Map<string, number>();
        for (const t of ticksRaw || []) {
          if (t?.symbol && t.bid && t.ask) tickMap.set(t.symbol.toUpperCase(), (t.bid + t.ask) / 2);
        }
        const out = TOP_MOVER_SYMBOLS.map((sym) => {
          const dayOpen = dayOpenBySymbol[sym];
          const price = tickMap.get(sym) ?? closeFallbackBySymbol[sym] ?? NaN;
          const pct = (Number.isFinite(dayOpen) && dayOpen > 0 && Number.isFinite(price))
            ? ((price - dayOpen) / dayOpen) * 100
            : 0;
          return { symbol: sym, pct, price };
        });
        setMovers(out);
      } catch { /* keep previous values on transient failure */ }
    };

    // Initial sequence: load bars first so the first render has a valid
    // dayOpen baseline, then loop the recompute every 5s using the live
    // /prices/all snapshot. Reload bars hourly so we pick up the new day
    // when the date rolls over (cheap — 4 small responses cached upstream).
    const timers: { priceTimer?: ReturnType<typeof setInterval>; barTimer?: ReturnType<typeof setInterval> } = {};
    (async () => {
      await loadBars();
      if (cancelled) return;
      await recompute();
      if (cancelled) return;
      timers.priceTimer = setInterval(() => { void recompute(); }, 5000);
      timers.barTimer = setInterval(() => { void loadBars(); }, 60 * 60 * 1000);
    })();

    return () => {
      cancelled = true;
      if (timers.priceTimer) clearInterval(timers.priceTimer);
      if (timers.barTimer) clearInterval(timers.barTimer);
    };
  }, []);

  const activeAccount = useMemo(
    () => accounts.find((a) => a.id === activeId) || accounts[0] || null,
    [accounts, activeId],
  );

  return (
    <div className="space-y-5 pb-8 max-w-[1200px] mx-auto w-full">
      {/* Promotional banners sit at the TOP so a new banner pushes the rest
          of the dashboard down rather than hiding at the bottom. */}
      {banners.length > 0 && <BannerStrip banners={banners} />}
      <AccountBalanceCard
        accounts={accounts}
        active={activeAccount}
        onChangeAccount={setActiveId}
        loading={loading}
      />
      <TopMoversCard movers={movers} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <InviteFriendsCard />
        <BonusCard />
      </div>
    </div>
  );
}

function AccountBalanceCard({
  accounts, active, onChangeAccount, loading,
}: {
  accounts: AccountRow[];
  active: AccountRow | null;
  onChangeAccount: (id: string) => void;
  loading: boolean;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const a = active;

  return (
    <div
      className="rounded-2xl p-5 md:p-6"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border-primary)' }}
    >
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div className="relative">
          <button
            type="button"
            onClick={() => setPickerOpen((o) => !o)}
            className="flex items-center gap-2.5 rounded-xl px-3 py-2 transition-colors hover:bg-bg-hover"
            style={{ background: 'var(--bg-card-nested)', border: '1px solid var(--border-primary)' }}
          >
            <span
              className="text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded"
              style={a?.is_demo
                ? { color: '#f59e0b', background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.3)' }
                : { color: '#55a630', background: 'rgba(85,166,48,0.12)', border: '1px solid rgba(85,166,48,0.3)' }}
            >
              {a?.is_demo ? 'Demo' : 'Real'}
            </span>
            <span className="text-sm font-semibold tabular-nums text-text-primary">
              {a?.account_number || (loading ? '…' : 'No accounts')}
            </span>
            <ChevronDown size={14} className="text-text-tertiary" />
          </button>
          {pickerOpen && accounts.length > 0 && (
            <div
              className="absolute top-full left-0 mt-2 z-30 rounded-xl p-1.5 min-w-[260px]"
              style={{
                background: 'rgba(16,17,20,0.97)',
                border: '1px solid var(--border-primary)',
                boxShadow: '0 16px 40px rgba(0,0,0,0.55)',
              }}
            >
              {accounts.map((acc) => (
                <button
                  key={acc.id}
                  type="button"
                  onClick={() => { onChangeAccount(acc.id); setPickerOpen(false); }}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-sm hover:bg-bg-hover"
                  style={{ color: 'var(--text-primary)' }}
                >
                  <span
                    className="text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded"
                    style={acc.is_demo
                      ? { color: '#f59e0b', background: 'rgba(245,158,11,0.12)' }
                      : { color: '#55a630', background: 'rgba(85,166,48,0.12)' }}
                  >
                    {acc.is_demo ? 'Demo' : 'Real'}
                  </span>
                  <span className="font-semibold tabular-nums">#{acc.account_number}</span>
                  <span className="ml-auto text-xs text-text-tertiary tabular-nums">
                    {fmtAccountMoney(acc.balance, isCentAccount(acc))}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <Link
            href="/wallet"
            className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-bold transition-colors"
            style={{ background: '#55a630', color: '#1a1408' }}
          >
            <ArrowDownToLine size={14} /> Deposit
          </Link>
          <a
            href={a ? tradeUrl(a.id) : '#'}
            target={a ? '_blank' : undefined}
            rel="noopener noreferrer"
            aria-disabled={!a}
            className={clsx(
              'inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold transition-colors',
              !a && 'pointer-events-none opacity-50',
            )}
            style={{ border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
          >
            Trade <ExternalLink size={13} />
          </a>
          <Link
            href="/wallet"
            className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold transition-colors hover:bg-bg-hover"
            style={{ border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
          >
            <ArrowUpFromLine size={14} /> Withdraw
          </Link>
          <Link
            href="/accounts"
            className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold transition-colors hover:bg-bg-hover"
            style={{ border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
          >
            Details
          </Link>
          <Link
            href="/risk-calculator"
            className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold transition-colors hover:bg-bg-hover"
            style={{ border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }}
          >
            <Calculator size={14} /> Risk Calc
          </Link>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-x-6 gap-y-4 md:gap-x-8">
        <Stat label="Balance" value={fmtAccountMoney(a?.balance ?? 0, isCentAccount(a))} highlight />
        <Stat label="Free margin" value={fmtAccountMoney(a?.free_margin ?? 0, isCentAccount(a))} />
        <Stat label="Equity" value={fmtAccountMoney(a?.equity ?? 0, isCentAccount(a))} />
        <Stat label="Leverage" value={a ? `1:${a.leverage}` : '—'} />
        <Stat label="Server" value={isCentAccount(a) ? 'Cent' : '—'} />
        <Stat label="No swap" value={a?.swap_free ? 'Yes' : 'No'} />
      </div>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  // `min-w-0` lets the grid cell shrink below the value's intrinsic width
  // so wide balances ($113,900.00 etc.) clip with ellipsis instead of
  // overflowing into the next column. `truncate` adds the ellipsis. The
  // highlight tier keeps the green colour but matches the size of the
  // other stats — the previous text-2xl size was the root cause of the
  // visible overlap on narrow widths.
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-[0.14em] font-medium text-text-tertiary truncate">{label}</p>
      <p
        className={clsx(
          'mt-1 font-bold tabular-nums whitespace-nowrap overflow-hidden text-ellipsis',
          'text-base md:text-lg',
        )}
        style={{ color: highlight ? '#55a630' : 'var(--text-primary)' }}
        title={value}
      >
        {value}
      </p>
    </div>
  );
}

function TopMoversCard({ movers }: { movers: { symbol: string; pct: number; price: number }[] }) {
  return (
    <Card title="Top daily movers">
      <ul className="divide-y divide-border-primary">
        {movers.length === 0 && (
          <li className="py-8 text-center text-sm text-text-tertiary flex items-center justify-center gap-2">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </li>
        )}
        {movers.map((m) => {
          const up = m.pct >= 0;
          const Icon = up ? TrendingUp : TrendingDown;
          return (
            <li key={m.symbol} className="py-3 flex items-center gap-3">
              <span className="text-sm font-semibold text-text-primary flex-1">{m.symbol}</span>
              <span className="text-sm font-mono tabular-nums text-text-secondary">
                {Number.isFinite(m.price) && m.price > 0 ? fmtNum(m.price, m.symbol === 'BTCUSD' ? 0 : 4) : '—'}
              </span>
              <span
                className="inline-flex items-center gap-1 text-xs font-bold tabular-nums"
                style={{ color: up ? '#22c55e' : '#ef4444' }}
              >
                <Icon size={12} />
                {Number.isFinite(m.pct) ? `${up ? '+' : ''}${m.pct.toFixed(2)}%` : '—'}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}


function InviteFriendsCard() {
  // Personal referral (every user has a code) — NOT the IB program.
  // The IB version of this card used to point here and confused users
  // who hadn't applied as an IB; the personal-referral endpoint is the
  // right one for the dashboard's "Invite friends" CTA.
  const [link, setLink] = useState<string>('');
  const [code, setCode] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ referral_code?: string | null }>('/business/referral/me')
      .then((d) => {
        if (cancelled) return;
        const c = (d.referral_code || '').trim();
        setCode(c);
        if (c && typeof window !== 'undefined') {
          // Same shape as `${TRADER_APP_URL}/auth/register?ref=CODE` that
          // /business/company-ib returns server-side. Building on the
          // client keeps the link on the user's actual origin
          // (swisdex.com vs trade.swisdex.com vs local dev).
          setLink(`${window.location.origin}/auth/register?ref=${encodeURIComponent(c)}`);
        }
      })
      .catch(() => { /* card falls back to the static CTA */ });
    return () => { cancelled = true; };
  }, []);

  const onCopy = (value: string) => {
    try {
      navigator.clipboard.writeText(value);
      toast.success('Copied to clipboard');
    } catch {
      toast.error('Copy failed — please select the text manually');
    }
  };

  return (
    <Card>
      <div className="flex items-start gap-4">
        <div
          className="shrink-0 w-14 h-14 rounded-xl flex items-center justify-center"
          style={{ background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.3)' }}
        >
          <ShieldCheck size={26} className="text-green-500" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-bold text-text-primary">Invite friends, earn together</h3>
          <p className="text-xs text-text-secondary mt-0.5 leading-relaxed">
            Share your link — every trade your invitees make earns you commission for life.
          </p>
          {link ? (
            <>
              <div className="mt-3 flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={link}
                  onFocus={(e) => e.currentTarget.select()}
                  className="flex-1 min-w-0 text-[11px] font-mono bg-bg-secondary border border-border-primary rounded-md px-2.5 py-1.5 text-text-primary outline-none focus:border-[#55a630]/40"
                />
                <button
                  type="button"
                  onClick={() => onCopy(link)}
                  className="shrink-0 px-2.5 py-1.5 text-[11px] font-bold rounded-md border border-[#55a630]/40 text-[#55a630] hover:bg-[#55a630]/10 transition-colors"
                >
                  Copy
                </button>
              </div>
              {code && (
                <p className="text-[11px] text-text-tertiary mt-2">
                  Code:{' '}
                  <button
                    type="button"
                    onClick={() => onCopy(code)}
                    className="text-[#55a630] font-mono font-bold cursor-pointer hover:underline"
                    title="Click to copy your referral code"
                  >
                    {code}
                  </button>
                </p>
              )}
            </>
          ) : (
            <Link
              href="/referral"
              className="inline-flex items-center gap-1.5 mt-3 text-xs font-bold text-[#55a630] hover:underline"
            >
              Get your referral link <ArrowRight size={12} />
            </Link>
          )}
        </div>
      </div>
    </Card>
  );
}

function BonusCard() {
  return (
    <Card>
      <div className="flex items-center gap-4">
        <div
          className="shrink-0 w-14 h-14 rounded-xl flex items-center justify-center"
          style={{ background: 'rgba(85,166,48,0.14)', border: '1px solid rgba(85,166,48,0.32)' }}
        >
          <Gift size={26} className="text-[#55a630]" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-bold text-text-primary">Up to 100% deposit bonus</h3>
          <p className="text-xs text-text-secondary mt-0.5 leading-relaxed">
            Top up your account and we&apos;ll add up to 100% extra trading credit. No expiry, fully tradeable.
          </p>
          <Link
            href="/wallet"
            className="inline-flex items-center gap-1.5 mt-3 px-3 py-1.5 text-xs font-bold rounded-md"
            style={{ background: '#55a630', color: '#1a1408' }}
          >
            Get bonus <ArrowRight size={12} />
          </Link>
        </div>
      </div>
    </Card>
  );
}

function BannerStrip({ banners }: { banners: Banner[] }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (banners.length <= 1) return;
    const t = setInterval(() => setIndex((i) => (i + 1) % banners.length), 3000);
    return () => clearInterval(t);
  }, [banners.length]);
  if (banners.length === 0) return null;
  const b = banners[index];
  // Fixed 5:1 aspect ratio everywhere a banner shows (dashboard +
  // admin preview list). Previously the dashboard used height-only
  // classes (h-44/h-52/h-60) which gave a different aspect ratio at
  // every breakpoint — same banner looked 2:1 on mobile and 5:1 on
  // desktop, breaking the design. Recommended upload size: 1500×300.
  return (
    <div className="relative w-full rounded-2xl overflow-hidden" style={{ border: '1px solid var(--border-primary)' }}>
      <div className="relative w-full aspect-[5/1] bg-bg-secondary">
        {b.link_url ? (
          <a href={b.link_url} target="_blank" rel="noopener noreferrer" className="absolute inset-0 block">
            <img src={b.image_url} alt={b.title || 'Banner'} className="w-full h-full object-cover" />
          </a>
        ) : (
          <img src={b.image_url} alt={b.title || 'Banner'} className="w-full h-full object-cover" />
        )}
      </div>
      {banners.length > 1 && (
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1">
          {banners.map((_, i) => (
            <span
              key={i}
              className="w-1.5 h-1.5 rounded-full transition-colors"
              style={{ background: i === index ? '#55a630' : 'rgba(255,255,255,0.4)' }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div
      className="rounded-2xl p-4 md:p-5"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border-primary)' }}
    >
      {title && <h2 className="text-base font-bold text-text-primary mb-3">{title}</h2>}
      {children}
    </div>
  );
}
