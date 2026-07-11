'use client';

import dynamic from 'next/dynamic';
import { useMemo, useState, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import DashboardShell from '@/components/layout/DashboardShell';
import { Calendar, RefreshCw, Search, ChevronDown, ChevronLeft, Beef, Loader2, Radio } from 'lucide-react';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import {
  getCalendarQueryRange,
  type CalendarDayTab,
  type EconomicCalendarApiResponse,
  type EconomicCalendarEventDTO,
  type EconomicImpactLevel,
} from '@/lib/economic-calendar';

// In-house live forex headlines (ForexLive / FXStreet), replacing the previous
// TradingView news timeline embed. (client 2026-07-09)
const MarketHeadlines = dynamic(() => import('@/components/charts/MarketHeadlines'), {
  ssr: false,
  loading: () => (
    <div className="min-h-[480px] flex items-center justify-center bg-bg-secondary border-t border-border-primary">
      <Loader2 className="w-10 h-10 animate-spin text-accent" />
    </div>
  ),
});

type ImpactFilter = 'all' | EconomicImpactLevel;
type NewsMainTab = 'calendar' | 'live';

interface CalEvent {
  id: string;
  when: Date;
  region?: string;
  currency: string;
  flag: string;
  impact: EconomicImpactLevel;
  title: string;
  actual?: string;
  previous?: string;
  consensus?: string;
}

const TIMEZONES = [
  { id: 'Asia/Kolkata', label: 'Calcutta (UTC+5:30)' },
  { id: 'Europe/London', label: 'London (UTC+0)' },
  { id: 'Europe/Berlin', label: 'Berlin (UTC+1)' },
  { id: 'America/New_York', label: 'New York (UTC-5)' },
  { id: 'Asia/Tokyo', label: 'Tokyo (UTC+9)' },
  { id: 'Australia/Sydney', label: 'Sydney (UTC+10)' },
  { id: 'UTC', label: 'UTC' },
];

function dtoToCalEvent(d: EconomicCalendarEventDTO): CalEvent {
  return {
    id: d.id,
    when: new Date(d.datetime),
    region: d.region,
    currency: d.currency,
    flag: d.flag?.trim() ? d.flag : '·',
    impact: d.impact,
    title: d.title,
    actual: d.actual ?? undefined,
    previous: d.previous ?? undefined,
    consensus: d.consensus ?? undefined,
  };
}

function formatTime(d: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: tz,
    }).format(d);
  } catch {
    return new Intl.DateTimeFormat('en-GB', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(d);
  }
}

function ImpactBulls({ impact }: { impact: EconomicImpactLevel }) {
  const n = impact === 'high' ? 3 : impact === 'medium' ? 2 : 1;
  const active =
    impact === 'high' ? 'text-red-400' : impact === 'medium' ? 'text-orange-400' : 'text-text-tertiary';
  const muted = 'text-text-tertiary/50';
  return (
    <div className="flex gap-0.5 items-center shrink-0" aria-label={`${impact} impact`}>
      {[0, 1, 2].map((i) => (
        <Beef key={i} className={clsx('w-3.5 h-3.5', i < n ? active : muted)} strokeWidth={2} />
      ))}
    </div>
  );
}

export default function EconomicNewsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [mainTab, setMainTab] = useState<NewsMainTab>('calendar');

  useEffect(() => {
    const t = searchParams.get('tab');
    if (t === 'live') setMainTab('live');
    if (t === 'calendar') setMainTab('calendar');
  }, [searchParams]);

  const setMainTabAndUrl = useCallback(
    (tab: NewsMainTab) => {
      setMainTab(tab);
      router.replace(tab === 'live' ? '/news?tab=live' : '/news', { scroll: false });
    },
    [router],
  );

  const [dayTab, setDayTab] = useState<CalendarDayTab>('today');
  const [impactFilter, setImpactFilter] = useState<ImpactFilter>('all');
  const [timezone, setTimezone] = useState('Asia/Kolkata');
  const [search, setSearch] = useState('');
  const [tick, setTick] = useState(0);
  const [source, setSource] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const { from, to } = getCalendarQueryRange(dayTab);
    setLoading(true);
    setError(null);

    fetch(`/api/economic-calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, {
      cache: 'no-store',
    })
      .then(async (r) => {
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          throw new Error(typeof err?.error === 'string' ? err.error : 'Request failed');
        }
        return r.json() as Promise<EconomicCalendarApiResponse>;
      })
      .then((data) => {
        if (cancelled) return;
        setSource(data.events.map(dtoToCalEvent));
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Could not load calendar.');
          setSource([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [dayTab, tick]);

  const filtered = useMemo(() => {
    let list = [...source];
    if (impactFilter !== 'all') {
      list = list.filter((e) => e.impact === impactFilter);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (e) =>
          e.title.toLowerCase().includes(q) ||
          e.currency.toLowerCase().includes(q) ||
          (e.region?.toLowerCase().includes(q) ?? false),
      );
    }
    return list.sort((a, b) => a.when.getTime() - b.when.getTime());
  }, [source, impactFilter, search]);

  const onRefresh = useCallback(() => {
    setTick((t) => t + 1);
    toast.success('Calendar refreshed');
  }, []);

  const dayTabs: { id: CalendarDayTab; label: string }[] = [
    { id: 'yesterday', label: 'Yesterday' },
    { id: 'today', label: 'Today' },
    { id: 'tomorrow', label: 'Tomorrow' },
    { id: 'week', label: 'This Week' },
  ];

  const impactTabs: { id: ImpactFilter; label: string; bulls?: EconomicImpactLevel }[] = [
    { id: 'all', label: 'All' },
    { id: 'high', label: 'High', bulls: 'high' },
    { id: 'medium', label: 'Medium', bulls: 'medium' },
    { id: 'low', label: 'Low', bulls: 'low' },
  ];

  const mainTabIndex = mainTab === 'calendar' ? 0 : 1;

  return (
    <DashboardShell mainClassName="p-0 flex flex-col min-h-0 overflow-hidden">
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        <div className="w-full max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-4 sm:py-6 pb-24 text-text-primary [&_input]:text-text-primary [&_select]:text-text-primary">
          <section className="relative overflow-hidden rounded-xl border border-border-primary bg-card mb-4 sm:mb-5">
            <div
              className="pointer-events-none absolute inset-0 bg-gradient-to-br from-accent/[0.12] via-transparent to-accent/[0.05]"
              aria-hidden
            />
            <div className="relative z-10 px-4 sm:px-6 py-4 sm:py-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div className="flex items-center gap-2 min-w-0">
                <button
                  type="button"
                  onClick={() => router.back()}
                  className="p-1.5 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors shrink-0"
                  aria-label="Go back"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <div className="min-w-0">
                  <h1 className="text-lg sm:text-2xl font-bold text-text-primary tracking-tight">Economic News</h1>
                  <p className="text-xs sm:text-sm text-text-secondary mt-0.5">
                    Calendar events and live headlines — SwisDex theme
                  </p>
                </div>
              </div>
              {mainTab === 'calendar' && (
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={onRefresh}
                    className="p-2 rounded-lg text-text-tertiary hover:text-text-primary transition-colors"
                    aria-label="Refresh"
                  >
                    <RefreshCw className={clsx('w-4 h-4', loading && 'animate-spin')} />
                  </button>
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
                    <input
                      type="search"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search…"
                      className="w-32 sm:w-44 pl-8 pr-3 py-2 rounded-xl border border-border-primary bg-bg-secondary text-sm placeholder:text-text-tertiary outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20"
                    />
                  </div>
                </div>
              )}
            </div>
          </section>

          <div className="overflow-hidden rounded-xl border border-border-primary bg-card">
            <div className="relative flex min-h-[52px] border-b border-border-primary bg-card">
              <div className="pointer-events-none absolute inset-0 z-0" aria-hidden>
                <div
                  className="absolute top-0 h-full w-1/2 transition-[transform] duration-500 ease-[cubic-bezier(0.34,1.45,0.64,1)] will-change-transform"
                  style={{ transform: `translate3d(${mainTabIndex * 100}%,0,0)` }}
                >
                  <div
                    className={clsx(
                      'absolute inset-x-1 top-0 h-full rounded-t-2xl border-2 border-b-0 border-accent bg-card-nested',
                      'animate-wallet-main-tab-glow',
                    )}
                  />
                </div>
              </div>
              {(
                [
                  { id: 'calendar' as const, label: 'Calendar', icon: Calendar },
                  { id: 'live' as const, label: 'Live News', icon: Radio },
                ] as const
              ).map(({ id, label, icon: Icon }) => {
                const active = mainTab === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setMainTabAndUrl(id)}
                    className={clsx(
                      'relative z-10 flex-1 min-w-0 border-0 bg-transparent py-3.5 px-2 text-xs sm:text-sm font-semibold outline-none inline-flex items-center justify-center gap-2',
                      'transition-colors duration-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/50',
                      active ? 'text-accent' : 'text-text-secondary hover:text-text-primary',
                    )}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    {active ? (
                      <span className="relative inline-block animate-wallet-main-tab-text drop-shadow-[0_0_20px_rgba(85,166,48,0.7)]">
                        {label}
                      </span>
                    ) : (
                      <span className="relative inline-block truncate">{label}</span>
                    )}
                  </button>
                );
              })}
            </div>

            <div
              key={mainTab}
              className={clsx(
                'animate-wallet-fund-enter-lg',
                mainTab === 'live' ? 'bg-card-nested' : 'bg-card-nested p-4 md:p-6',
              )}
            >
              {mainTab === 'live' ? (
                <div className="overflow-hidden border-t border-border-primary">
                  <div className="h-[min(72vh,820px)] min-h-[520px] bg-bg-secondary">
                    <MarketHeadlines className="h-full min-h-[520px]" />
                  </div>
                </div>
              ) : null}

              {mainTab === 'calendar' ? (
                <>
                  <div className="relative mb-4">
                    <label className="sr-only" htmlFor="ecal-tz">
                      Timezone
                    </label>
                    <div className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5 text-text-tertiary z-10">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <circle cx="12" cy="12" r="10" strokeWidth="1.5" />
                        <path
                          d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"
                          strokeWidth="1.5"
                        />
                      </svg>
                      <span className="text-xs">Timezone:</span>
                    </div>
                    <select
                      id="ecal-tz"
                      value={timezone}
                      onChange={(e) => setTimezone(e.target.value)}
                      className="w-full appearance-none pl-28 pr-10 py-3 rounded-xl border border-border-primary bg-bg-secondary text-sm text-text-primary outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 cursor-pointer"
                    >
                      {TIMEZONES.map((tz) => (
                        <option key={tz.id} value={tz.id} className="bg-card text-text-primary">
                          {tz.label}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
                  </div>

                  <div className="flex border-b border-border-primary mb-4 overflow-x-auto">
                    {dayTabs.map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setDayTab(tab.id)}
                        className={clsx(
                          'relative px-4 py-3 text-sm whitespace-nowrap transition-colors duration-200',
                          dayTab === tab.id
                            ? 'text-text-primary font-bold'
                            : 'text-text-tertiary font-medium hover:text-text-secondary',
                        )}
                      >
                        {tab.label}
                        {dayTab === tab.id && (
                          <span className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full bg-accent shadow-[0_0_10px_rgba(85,166,48,0.5)]" />
                        )}
                      </button>
                    ))}
                  </div>

                  <div className="flex flex-wrap gap-2 mb-5">
                    {impactTabs.map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setImpactFilter(tab.id)}
                        className={clsx(
                          'inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-semibold border transition-all duration-200',
                          impactFilter === tab.id
                            ? 'bg-bg-secondary border-border-primary text-text-primary'
                            : 'bg-transparent border-border-primary text-text-tertiary hover:text-text-secondary hover:border-accent/30',
                        )}
                      >
                        {tab.bulls ? <ImpactBulls impact={tab.bulls} /> : null}
                        {tab.label}
                      </button>
                    ))}
                  </div>

                  <div className="rounded-xl border border-border-primary bg-card overflow-hidden">
                    {loading ? (
                      <div className="py-16 flex flex-col items-center justify-center gap-2 text-text-secondary">
                        <Loader2 className="w-8 h-8 animate-spin text-accent" />
                        <span className="text-sm text-text-primary">Loading events…</span>
                      </div>
                    ) : error ? (
                      <div className="py-16 px-4 text-center text-sm text-text-secondary">
                        <p className="text-sell mb-3">{error}</p>
                        <button
                          type="button"
                          onClick={() => setTick((t) => t + 1)}
                          className="text-accent font-semibold hover:underline"
                        >
                          Try again
                        </button>
                      </div>
                    ) : filtered.length === 0 ? (
                      <div className="py-16 text-center text-sm text-text-tertiary">No events for this filter.</div>
                    ) : (
                      <ul className="divide-y divide-border-primary">
                        {filtered.map((e) => (
                          <li
                            key={e.id}
                            className="px-4 py-4 md:px-5 hover:bg-bg-hover/40 transition-colors text-text-primary"
                          >
                            <div className="flex gap-3 md:gap-4">
                              <div className="w-16 md:w-20 shrink-0 text-xs font-mono text-text-secondary tabular-nums pt-0.5">
                                {formatTime(e.when, timezone)}
                              </div>
                              <div className="flex gap-2 shrink-0 items-start pt-0.5 min-w-[3.5rem]">
                                <span className="text-lg leading-none" title={e.currency}>
                                  {e.flag}
                                </span>
                                <div className="flex flex-col gap-0.5">
                                  {e.region ? (
                                    <span className="text-[10px] font-semibold text-text-tertiary leading-none">
                                      {e.region}
                                    </span>
                                  ) : null}
                                  <span className="text-xs font-bold text-text-primary font-mono">{e.currency}</span>
                                </div>
                              </div>
                              <div className="flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-4 flex-1 min-w-0">
                                <ImpactBulls impact={e.impact} />
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-bold text-text-primary leading-snug">{e.title}</p>
                                  <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 text-[11px] text-text-tertiary">
                                    {e.actual != null && e.actual !== '—' ? (
                                      <span>
                                        Act:{' '}
                                        <span className="text-accent font-mono font-semibold">{e.actual}</span>
                                      </span>
                                    ) : null}
                                    {e.previous != null && e.previous !== '—' ? (
                                      <span>
                                        Prev: <span className="text-text-primary font-mono">{e.previous}</span>
                                      </span>
                                    ) : null}
                                    {e.consensus != null && e.consensus !== '—' ? (
                                      <span>
                                        Cons: <span className="text-text-primary font-mono">{e.consensus}</span>
                                      </span>
                                    ) : null}
                                  </div>
                                </div>
                              </div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <p className="text-center text-xs text-text-tertiary mt-6">
                    Data from <code className="text-text-secondary">/api/economic-calendar</code> — connect your
                    provider when ready.{' '}
                    <a
                      href="https://tradingeconomics.com/calendar"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent hover:underline"
                    >
                      TradingEconomics calendar
                    </a>
                  </p>
                  <p className="text-center text-xs mt-2">
                    <Link href="/wallet" className="text-text-tertiary hover:text-accent">
                      Deposit / Withdraw
                    </Link>
                  </p>
                </>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}
