'use client';

/**
 * Combined market-news panel for the trading terminal — replaces the
 * TradingView news timeline embed. Two tabs:
 *   • Events    — ForexFactory economic calendar (via /api/economic-calendar)
 *   • Headlines — live forex news (via /api/market-news)
 * Both are SwisDex-themed and self-hosted (no third-party iframe).
 */
import { useState } from 'react';
import { clsx } from 'clsx';
import { CalendarDays, Newspaper } from 'lucide-react';
import ForexFactoryEvents from './ForexFactoryEvents';
import MarketHeadlines from './MarketHeadlines';

type NewsTab = 'events' | 'headlines';

export default function MarketNewsPanel({
  className,
  defaultTab = 'events',
}: {
  className?: string;
  defaultTab?: NewsTab;
}) {
  const [tab, setTab] = useState<NewsTab>(defaultTab);

  const tabs: { id: NewsTab; label: string; icon: typeof CalendarDays }[] = [
    { id: 'events', label: 'Events', icon: CalendarDays },
    { id: 'headlines', label: 'Headlines', icon: Newspaper },
  ];

  return (
    <div className={clsx('flex flex-col min-h-0 h-full bg-card', className)}>
      <div className="flex border-b border-border-primary shrink-0">
        {tabs.map(({ id, label, icon: Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={clsx(
                'relative flex-1 inline-flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold transition-colors',
                active ? 'text-accent' : 'text-text-secondary hover:text-text-primary',
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
              {active && (
                <span className="absolute bottom-0 left-3 right-3 h-0.5 rounded-full bg-accent shadow-[0_0_10px_rgba(85,166,48,0.5)]" />
              )}
            </button>
          );
        })}
      </div>
      <div className="flex-1 min-h-0">
        {tab === 'events' ? (
          <ForexFactoryEvents className="h-full" />
        ) : (
          <MarketHeadlines className="h-full" />
        )}
      </div>
    </div>
  );
}
