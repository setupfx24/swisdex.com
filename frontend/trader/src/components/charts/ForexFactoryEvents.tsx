'use client';

/**
 * Compact ForexFactory economic-events panel (today + this week) for the
 * trading terminal. Sources the same free ForexFactory calendar mirror as the
 * full /news Calendar tab, via /api/economic-calendar. High/medium/low impact,
 * forecast / previous / actual.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { CalendarDays, Loader2, RefreshCw } from 'lucide-react';
import {
  getCalendarQueryRange,
  type EconomicCalendarApiResponse,
  type EconomicCalendarEventDTO,
  type EconomicImpactLevel,
} from '@/lib/economic-calendar';

type ImpactFilter = 'all' | 'high' | 'medium';

function ImpactDots({ impact }: { impact: EconomicImpactLevel }) {
  const n = impact === 'high' ? 3 : impact === 'medium' ? 2 : 1;
  const color =
    impact === 'high' ? 'bg-red-400' : impact === 'medium' ? 'bg-orange-400' : 'bg-text-tertiary/60';
  return (
    <div className="flex gap-0.5 items-center shrink-0" aria-label={`${impact} impact`}>
      {[0, 1, 2].map((i) => (
        <span key={i} className={clsx('w-1.5 h-1.5 rounded-full', i < n ? color : 'bg-text-tertiary/25')} />
      ))}
    </div>
  );
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
}

function fmtDay(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(d);
}

export default function ForexFactoryEvents({ className }: { className?: string }) {
  const [source, setSource] = useState<EconomicCalendarEventDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [impact, setImpact] = useState<ImpactFilter>('all');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const { from, to } = getCalendarQueryRange('week');
    setLoading(true);
    setError(null);
    fetch(`/api/economic-calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, {
      cache: 'no-store',
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Request failed'))))
      .then((data: EconomicCalendarApiResponse) => {
        if (cancelled) return;
        setSource(Array.isArray(data?.events) ? data.events : []);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load calendar.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // Upcoming-first: drop events older than ~2h, keep by impact filter, group by day.
  const grouped = useMemo(() => {
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    let list = source.filter((e) => Date.parse(e.datetime) >= cutoff);
    if (impact !== 'all') list = list.filter((e) => e.impact === impact);
    list.sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime));
    const byDay = new Map<string, EconomicCalendarEventDTO[]>();
    for (const e of list) {
      const key = fmtDay(e.datetime);
      const arr = byDay.get(key) || [];
      arr.push(e);
      byDay.set(key, arr);
    }
    return Array.from(byDay.entries());
  }, [source, impact]);

  return (
    <div className={clsx('flex flex-col min-h-0 bg-card', className)}>
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-primary shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <CalendarDays className="w-3.5 h-3.5 text-accent shrink-0" />
          <span className="text-xs font-semibold text-text-primary truncate">Economic Events</span>
          <span className="text-[10px] text-text-tertiary">· ForexFactory</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {(['all', 'high', 'medium'] as ImpactFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setImpact(f)}
              className={clsx(
                'px-1.5 py-0.5 rounded text-[10px] font-semibold capitalize transition-colors',
                impact === f ? 'bg-accent/15 text-accent' : 'text-text-tertiary hover:text-text-secondary',
              )}
            >
              {f}
            </button>
          ))}
          <button
            type="button"
            onClick={refresh}
            className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
            aria-label="Refresh events"
          >
            <RefreshCw className={clsx('w-3.5 h-3.5', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading ? (
          <div className="py-12 flex flex-col items-center justify-center gap-2 text-text-secondary">
            <Loader2 className="w-6 h-6 animate-spin text-accent" />
            <span className="text-xs">Loading events…</span>
          </div>
        ) : error ? (
          <div className="py-12 px-4 text-center text-xs text-text-secondary">
            <p className="text-sell mb-2">{error}</p>
            <button type="button" onClick={refresh} className="text-accent font-semibold hover:underline">
              Try again
            </button>
          </div>
        ) : grouped.length === 0 ? (
          <div className="py-12 text-center text-xs text-text-tertiary">No upcoming events for this filter.</div>
        ) : (
          grouped.map(([day, events]) => (
            <div key={day}>
              <div className="sticky top-0 z-10 px-3 py-1 bg-bg-secondary/95 backdrop-blur border-b border-border-primary text-[10px] font-bold uppercase tracking-wide text-text-tertiary">
                {day}
              </div>
              <ul className="divide-y divide-border-primary">
                {events.map((e) => (
                  <li key={e.id} className="flex gap-2 px-3 py-2 hover:bg-bg-hover/40 transition-colors">
                    <div className="w-12 shrink-0 text-[11px] font-mono text-text-secondary tabular-nums pt-0.5">
                      {fmtTime(e.datetime)}
                    </div>
                    <span className="text-sm leading-none pt-0.5 shrink-0" title={e.currency}>
                      {e.flag}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] font-bold font-mono text-text-secondary shrink-0">
                          {e.currency}
                        </span>
                        <ImpactDots impact={e.impact} />
                      </div>
                      <p className="text-xs font-medium text-text-primary leading-snug mt-0.5 line-clamp-2">
                        {e.title}
                      </p>
                      {(e.actual || e.consensus || e.previous) ? (
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5 text-[10px] text-text-tertiary">
                          {e.actual && e.actual !== '—' ? (
                            <span>
                              A: <span className="text-accent font-mono font-semibold">{e.actual}</span>
                            </span>
                          ) : null}
                          {e.consensus && e.consensus !== '—' ? (
                            <span>
                              F: <span className="text-text-primary font-mono">{e.consensus}</span>
                            </span>
                          ) : null}
                          {e.previous && e.previous !== '—' ? (
                            <span>
                              P: <span className="text-text-primary font-mono">{e.previous}</span>
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
