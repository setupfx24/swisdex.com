'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import toast from 'react-hot-toast';
import { clsx } from 'clsx';
import {
  ArrowDownToLine,
  Wallet,
  PieChart,
  Copy,
  Users,
  TrendingUp,
  History as HistoryIcon,
  Newspaper,
  UserRound,
  MessageCircle,
  Sun,
  Moon,
  LogOut,
  type LucideIcon,
} from 'lucide-react';
import { useUIStore } from '@/stores/uiStore';
import { useAuthStore } from '@/stores/authStore';
import { usePlatformStatusStore } from '@/stores/platformStatusStore';
import { useTradingStore } from '@/stores/tradingStore';
import {
  getPersistedTradingAccountId,
  setPersistedTradingAccountId,
  tradingTerminalUrl,
} from '@/lib/tradingNav';

/* ─── Icons ─── */

const IconHome = ({ active }: { active: boolean }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
    {!active && <polyline points="9 22 9 12 15 12 15 22" />}
  </svg>
);

const IconMarket = ({ active }: { active: boolean }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2 : 1.75} strokeLinecap="round" strokeLinejoin="round">
    <line x1="5" y1="3" x2="5" y2="6" /><rect x="3.25" y="6" width="3.5" height="8" rx="0.5" />
    <line x1="5" y1="14" x2="5" y2="18" /><line x1="12" y1="2" x2="12" y2="5" />
    <rect x="10.25" y="5" width="3.5" height="11" rx="0.5" /><line x1="12" y1="16" x2="12" y2="21" />
    <line x1="19" y1="5" x2="19" y2="8" /><rect x="17.25" y="8" width="3.5" height="7" rx="0.5" />
    <line x1="19" y1="15" x2="19" y2="19" />
  </svg>
);

const IconChart = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
    <polyline points="16 7 22 7 22 13" />
  </svg>
);

const IconOrders = ({ active }: { active: boolean }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2 : 1.75} strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="3" y1="9" x2="21" y2="9" />
    <line x1="9" y1="21" x2="9" y2="9" />
  </svg>
);

const IconMore = ({ active }: { active: boolean }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="5" cy="12" r="1.5" fill="currentColor" />
    <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    <circle cx="19" cy="12" r="1.5" fill="currentColor" />
  </svg>
);

/* More-sheet items */
const SHEET_ITEMS: { name: string; path: string; color: string; icon: LucideIcon }[] = [
  { name: 'Deposit', path: '/wallet', color: '#55a630', icon: ArrowDownToLine },
  { name: 'Wallet', path: '/wallet', color: '#3b82f6', icon: Wallet },
  { name: 'Portfolio', path: '/portfolio', color: '#8b5cf6', icon: PieChart },
  { name: 'MAMM', path: '/social', color: '#f59e0b', icon: Copy },
  { name: 'Affiliates', path: '/business', color: '#ec4899', icon: Users },
  { name: 'PAMM', path: '/pamm', color: '#06b6d4', icon: TrendingUp },
  { name: 'History', path: '/transactions', color: '#a855f7', icon: HistoryIcon },
  { name: 'News', path: '/news', color: '#f97316', icon: Newspaper },
  { name: 'Profile', path: '/profile', color: '#8b5cf6', icon: UserRound },
  { name: 'Support', path: '/support', color: '#14b8a6', icon: MessageCircle },
];

/* ─── Component ─── */

export default function MobileBottomNav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { theme, toggleTheme } = useUIStore();
  const logout = useAuthStore((s) => s.logout);
  const accounts = useTradingStore((s) => s.accounts);
  const activeAccount = useTradingStore((s) => s.activeAccount);
  const setActiveAccount = useTradingStore((s) => s.setActiveAccount);
  const [showMore, setShowMore] = useState(false);
  const pammEnabled = usePlatformStatusStore((s) => s.pamm_enabled);
  const mamEnabled = usePlatformStatusStore((s) => s.mam_enabled);
  const sheetItems = useMemo(
    () => SHEET_ITEMS.filter((it) => {
      if (it.path === '/pamm' && !pammEnabled) return false;
      if (it.path === '/social' && !mamEnabled) return false;
      return true;
    }),
    [pammEnabled, mamEnabled],
  );

  const tradingAccountId = useMemo(() => {
    if (pathname?.startsWith('/trading/terminal')) return searchParams.get('account');
    return getPersistedTradingAccountId();
  }, [pathname, searchParams]);

  /** Resolve a usable account: persisted → active → first available. Persist it for next time. */
  const resolveTradingAccount = (): string | null => {
    if (tradingAccountId) return tradingAccountId;
    if (activeAccount?.id) {
      setPersistedTradingAccountId(activeAccount.id);
      return activeAccount.id;
    }
    if (accounts.length > 0) {
      const first = accounts[0];
      setActiveAccount(first);
      setPersistedTradingAccountId(first.id);
      return first.id;
    }
    return null;
  };

  const goToTerminalView = (view: 'watchlist' | 'chart' | 'order') => (e: React.MouseEvent) => {
    e.preventDefault();
    const id = resolveTradingAccount();
    if (id) {
      router.push(tradingTerminalUrl(id, { view }));
      return;
    }
    toast.error('Open a trading account first');
    router.push('/trading');
  };

  const isLandingPage =
    pathname === '/' ||
    pathname === '/markets' ||
    pathname === '/account-types' ||
    pathname === '/how-it-works' ||
    pathname === '/bonus' ||
    pathname?.startsWith('/academy') ||
    pathname?.startsWith('/risk-management') ||
    pathname?.startsWith('/products') ||
    pathname?.startsWith('/services') ||
    pathname?.startsWith('/company') ||
    pathname?.startsWith('/education') ||
    ['/trading/forex', '/trading/commodities', '/trading/indices', '/trading/crypto'].includes(pathname || '') ||
    ['/platforms/web', '/platforms/copy-trading', '/platforms/prop-trading', '/platforms/ib-management', '/platforms/super-admin'].includes(pathname || '') ||
    ['/accounts/standard', '/accounts/pro', '/accounts/demo'].includes(pathname || '');
  const isPublicPage =
    isLandingPage || pathname === '/privacy' || pathname === '/terms' ||
    pathname === '/risk' || pathname === '/about' || pathname === '/contact' ||
    pathname === '/platforms' || pathname === '/white-label';
  // Hide on the focused full-screen deposit checkout (client 2026-06-24).
  if (pathname?.startsWith('/auth') || pathname?.startsWith('/wallet/deposit') || isPublicPage) return null;

  const currentView = searchParams.get('view') || '';
  const isTradingArea = pathname?.startsWith('/trading');
  const chartHref = tradingAccountId
    ? tradingTerminalUrl(tradingAccountId, { view: 'chart' })
    : '/trading';
  const marketHref = tradingAccountId
    ? tradingTerminalUrl(tradingAccountId, { view: 'watchlist' })
    : '/trading';
  const ordersHref = tradingAccountId
    ? tradingTerminalUrl(tradingAccountId, { view: 'order' })
    : '/trading';

  const isHome = pathname === '/dashboard';
  const isMarket = isTradingArea && (currentView === 'watchlist' || (!currentView && pathname === '/trading'));
  const isChart = isTradingArea && (currentView === 'chart' || (pathname?.includes('/terminal') && !currentView));
  const isOrders = isTradingArea && currentView === 'order';

  const handleLogout = () => { setShowMore(false); logout(); router.push('/auth/login'); };

  return (
    <>
      <nav
        className="lg:hidden fixed bottom-0 left-0 right-0 z-[60]"
        style={{ paddingBottom: 'max(0px, env(safe-area-inset-bottom, 0px))' }}
      >
        <div className="relative bg-bg-base">
          {/* Top border glow */}
          <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-[#55a630]/20 to-transparent" />

          <div className="flex items-end justify-around h-[62px] px-1">
            {/* Home */}
            <Link href="/dashboard" className="flex flex-col items-center justify-center gap-[2px] flex-1 py-2">
              <span className={clsx('transition-colors', isHome ? 'text-accent' : 'text-text-tertiary')}>
                <IconHome active={isHome} />
              </span>
              <span className={clsx('text-[10px] font-semibold', isHome ? 'text-accent' : 'text-text-tertiary')}>Home</span>
            </Link>

            {/* Market */}
            <a
              href={marketHref}
              onClick={goToTerminalView('watchlist')}
              className="flex flex-col items-center justify-center gap-[2px] flex-1 py-2"
            >
              <span className={clsx('transition-colors', isMarket ? 'text-accent' : 'text-text-tertiary')}>
                <IconMarket active={isMarket} />
              </span>
              <span className={clsx('text-[10px] font-semibold', isMarket ? 'text-accent' : 'text-text-tertiary')}>Market</span>
            </a>

            {/* Chart — elevated center button */}
            <a
              href={chartHref}
              onClick={goToTerminalView('chart')}
              className="flex flex-col items-center justify-center flex-1 -mt-4"
            >
              <div className={clsx(
                'w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg transition-all',
                isChart
                  ? 'bg-accent text-text-inverse shadow-[0_4px_20px_rgba(85,166,48,0.4)]'
                  : 'bg-bg-secondary text-text-secondary border border-border-primary',
              )}>
                <IconChart />
              </div>
              <span className={clsx('text-[10px] font-semibold mt-1', isChart ? 'text-accent' : 'text-text-tertiary')}>Chart</span>
            </a>

            {/* Orders */}
            <a
              href={ordersHref}
              onClick={goToTerminalView('order')}
              className="flex flex-col items-center justify-center gap-[2px] flex-1 py-2"
            >
              <span className={clsx('transition-colors', isOrders ? 'text-accent' : 'text-text-tertiary')}>
                <IconOrders active={isOrders} />
              </span>
              <span className={clsx('text-[10px] font-semibold', isOrders ? 'text-accent' : 'text-text-tertiary')}>Orders</span>
            </a>

            {/* More */}
            <button onClick={() => setShowMore(true)} className="flex flex-col items-center justify-center gap-[2px] flex-1 py-2">
              <span className={clsx('transition-colors', showMore ? 'text-accent' : 'text-text-tertiary')}>
                <IconMore active={showMore} />
              </span>
              <span className={clsx('text-[10px] font-semibold', showMore ? 'text-accent' : 'text-text-tertiary')}>More</span>
            </button>
          </div>
        </div>
      </nav>

      {/* ── More Bottom Sheet ─── */}
      {showMore && (
        <div className="fixed inset-0 z-[80] lg:hidden flex flex-col justify-end" onClick={() => setShowMore(false)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div
            className="relative rounded-t-3xl border-t border-border-primary shadow-2xl bg-bg-primary"
            style={{ paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom, 0px))' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 rounded-full bg-text-tertiary/30" />
            </div>
            <div className="flex items-center justify-between px-5 pt-2 pb-4">
              <span className="text-text-primary font-bold text-base">Quick Access</span>
              <button onClick={() => setShowMore(false)} className="w-8 h-8 flex items-center justify-center rounded-full bg-bg-hover text-text-secondary">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            </div>

            <div className="grid grid-cols-5 gap-y-5 gap-x-2 px-4 pb-5">
              {sheetItems.map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.name}
                    href={item.path}
                    onClick={() => setShowMore(false)}
                    className="flex flex-col items-center gap-2 active:scale-95 transition-transform"
                  >
                    <div
                      className="w-12 h-12 rounded-2xl flex items-center justify-center"
                      style={{ background: `${item.color}15`, boxShadow: `0 0 0 1px ${item.color}22` }}
                    >
                      <Icon size={22} strokeWidth={1.75} style={{ color: item.color }} />
                    </div>
                    <span className="text-[10px] text-text-secondary font-medium text-center">{item.name}</span>
                  </Link>
                );
              })}
            </div>

            <div className="mx-4 h-px bg-border-primary mb-4" />
            <div className="flex gap-3 px-4 pb-2">
              <button onClick={toggleTheme}
                className="flex-1 flex items-center gap-3 px-4 py-3 rounded-2xl bg-bg-secondary border border-border-primary active:scale-[0.98]">
                {theme === 'dark'
                  ? <Sun size={16} className="text-accent" strokeWidth={2} />
                  : <Moon size={16} className="text-accent" strokeWidth={2} />}
                <span className="text-text-primary text-sm font-semibold">{theme === 'dark' ? 'Light' : 'Dark'}</span>
              </button>
              <button onClick={handleLogout}
                className="flex items-center gap-3 px-4 py-3 rounded-2xl bg-red-500/[0.06] border border-red-500/[0.12] active:scale-[0.98]">
                <LogOut size={16} className="text-red-400" strokeWidth={2} />
                <span className="text-red-400 text-sm font-semibold">Log Out</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
