'use client';

/**
 * Live forex/market news headlines from /api/market-news (ForexLive / FXStreet
 * RSS — ForexFactory has no public news feed). Replaces the TradingView news
 * timeline embed with a SwisDex-themed, in-house list.
 */
import { useCallback, useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { ExternalLink, Loader2, RefreshCw, Newspaper } from 'lucide-react';

interface Headline {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedAt: string | null;
  summary: string | null;
  category: string | null;
}

function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export default function MarketHeadlines({ className }: { className?: string }) {
  const [items, setItems] = useState<Headline[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch('/api/market-news', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Request failed'))))
      .then((data: { items: Headline[] }) => {
        if (cancelled) return;
        setItems(Array.isArray(data?.items) ? data.items : []);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load news.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  return (
    <div className={clsx('flex flex-col min-h-0 bg-card', className)}>
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-primary shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <Newspaper className="w-3.5 h-3.5 text-accent shrink-0" />
          <span className="text-xs font-semibold text-text-primary truncate">Market Headlines</span>
        </div>
        <button
          type="button"
          onClick={refresh}
          className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
          aria-label="Refresh headlines"
        >
          <RefreshCw className={clsx('w-3.5 h-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading ? (
          <div className="py-12 flex flex-col items-center justify-center gap-2 text-text-secondary">
            <Loader2 className="w-6 h-6 animate-spin text-accent" />
            <span className="text-xs">Loading headlines…</span>
          </div>
        ) : error ? (
          <div className="py-12 px-4 text-center text-xs text-text-secondary">
            <p className="text-sell mb-2">{error}</p>
            <button type="button" onClick={refresh} className="text-accent font-semibold hover:underline">
              Try again
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="py-12 text-center text-xs text-text-tertiary">No headlines right now.</div>
        ) : (
          <ul className="divide-y divide-border-primary">
            {items.map((h) => (
              <li key={h.id}>
                <a
                  href={h.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex flex-col gap-1 px-3 py-2.5 hover:bg-bg-hover/50 transition-colors"
                >
                  <p className="text-xs font-medium text-text-primary leading-snug group-hover:text-accent transition-colors line-clamp-2">
                    {h.title}
                    <ExternalLink className="inline-block w-3 h-3 ml-1 mb-0.5 text-text-tertiary opacity-0 group-hover:opacity-100 transition-opacity" />
                  </p>
                  {h.summary ? (
                    <p className="text-[11px] text-text-tertiary leading-snug line-clamp-2">{h.summary}</p>
                  ) : null}
                  <div className="flex items-center gap-2 text-[10px] text-text-tertiary">
                    <span className="font-semibold text-text-secondary">{h.source}</span>
                    {h.publishedAt ? (
                      <>
                        <span aria-hidden>·</span>
                        <span className="tabular-nums">{timeAgo(h.publishedAt)}</span>
                      </>
                    ) : null}
                    {h.category ? (
                      <>
                        <span aria-hidden>·</span>
                        <span className="truncate max-w-[8rem]">{h.category}</span>
                      </>
                    ) : null}
                  </div>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-border-primary shrink-0">
        <p className="text-center text-[10px] text-text-tertiary leading-relaxed">
          Live forex headlines. Not investment advice.
        </p>
      </div>
    </div>
  );
}
