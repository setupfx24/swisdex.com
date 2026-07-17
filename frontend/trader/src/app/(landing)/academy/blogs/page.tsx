'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Search, Calendar, User, ArrowRight, ArrowUpRight, ArrowLeft } from 'lucide-react';
import { BannerPlaceholder } from '@/swisdex/components/BannerPlaceholder';
import SuccessModal from '@/swisdex/components/SuccessModal';

interface Post {
  id: string;
  title: string;
  excerpt: string;
  author: string;
  date: string;
  category: string;
  featured?: boolean;
}

const POSTS: Post[] = [
  { id: 'b1', title: 'Why 2026 Is the Year of Range Trading on EUR/USD', excerpt: 'Central bank divergence has narrowed. Here is what mean reversion looks like at the end of a hiking cycle.', author: 'Daniel R.', date: 'Mar 18, 2026', category: 'Forex',     featured: true },
  { id: 'b2', title: 'A Beginner Guide to Choosing Your First Trading Account', excerpt: 'Standard vs ECN, minimum deposits, and what spread actually costs you per round-trip.',                       author: 'Priya N.',  date: 'Mar 15, 2026', category: 'Guides'   },
  { id: 'b3', title: 'On-Chain Indicators That Actually Predict BTC Tops',     excerpt: 'MVRV, SOPR, miner outflows — separating the signal from the noise on the most-watched cryptocurrency.',         author: 'James L.',  date: 'Mar 12, 2026', category: 'Crypto'   },
  { id: 'b4', title: 'Three Mistakes Every Funded Trader Makes in Week One',   excerpt: 'Position sizing, news avoidance, and journaling — the boring stuff that decides who keeps the account.',         author: 'Sarah K.',  date: 'Mar 09, 2026', category: 'Strategy' },
  { id: 'b5', title: 'How to Read a TradingView Heat Map Properly',             excerpt: 'Sector flows, relative strength, and a quick screening method that takes under five minutes a day.',              author: 'Liam T.',   date: 'Mar 06, 2026', category: 'Tools'    },
  { id: 'b6', title: 'Hedging With Gold When the Dollar Wobbles',               excerpt: 'XAU/USD positioning against DXY, real yields, and why central banks keep buying.',                                author: 'Sophia M.', date: 'Mar 03, 2026', category: 'Commodities' },
  { id: 'b7', title: 'Stop-Loss Hunting Is Real — Here Is How to Avoid It',     excerpt: 'Why your protective stop keeps getting tagged before the move resumes, and what to do about it.',                author: 'Michael R.',date: 'Feb 28, 2026', category: 'Strategy' },
];

const PAGE_SIZE = 4;
const CATEGORIES = ['Forex', 'Crypto', 'Strategy', 'Tools', 'Commodities', 'Guides'] as const;

export default function AcademyBlogsPage() {
  const [search, setSearch] = useState('');
  const [page, setPage]     = useState(1);
  const [showSuccess, setShowSuccess] = useState(false);

  const featured = POSTS.find((p) => p.featured) ?? POSTS[0];
  const rest = POSTS.filter((p) => p.id !== featured.id);

  const filtered = useMemo(() => {
    if (!search) return rest;
    return rest.filter((p) =>
      `${p.title} ${p.excerpt} ${p.author} ${p.category}`.toLowerCase().includes(search.toLowerCase()),
    );
  }, [rest, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageItems = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <main className="min-h-screen bg-background">
      <BannerPlaceholder
        title="SwisDex Academy — Blog"
        tagline="Market insights, strategy breakdowns, and platform tips from our trading desk."
      />

      <div className="mx-auto max-w-[1200px] px-[var(--gutter)] py-12 sm:py-16">
        {/* Featured post */}
        <article className="liquid-glass-strong rounded-3xl overflow-hidden grid md:grid-cols-2 mb-12">
          {/* TODO: Featured post hero image yahan aayegi */}
          <div className="image-placeholder relative aspect-[4/3] md:aspect-auto bg-foreground/[0.06] min-h-[260px]" aria-label={`${featured.title} cover`} />
          <div className="p-6 sm:p-10 flex flex-col gap-4 justify-center">
            <div className="inline-flex items-center gap-2 self-start text-[11px] uppercase tracking-[0.16em] text-primary">
              Featured · {featured.category}
            </div>
            <h2 className="font-display text-2xl sm:text-3xl md:text-4xl uppercase tracking-tight leading-tight">
              {featured.title}
            </h2>
            <p className="text-foreground/65 text-sm sm:text-base leading-relaxed">{featured.excerpt}</p>
            <div className="flex items-center gap-4 text-xs text-foreground/55">
              <span className="inline-flex items-center gap-1.5"><User className="size-3.5" /> {featured.author}</span>
              <span className="inline-flex items-center gap-1.5"><Calendar className="size-3.5" /> {featured.date}</span>
            </div>
            <button type="button" className="mt-2 self-start inline-flex items-center gap-2 text-sm font-semibold text-primary hover:opacity-80">
              Read Full Story <ArrowUpRight className="size-4" />
            </button>
          </div>
        </article>

        <div className="grid lg:grid-cols-[1fr_320px] gap-10">
          {/* Blog grid */}
          <div>
            <div className="grid sm:grid-cols-2 gap-5">
              {pageItems.map((p) => (
                <article key={p.id} className="liquid-glass rounded-2xl overflow-hidden flex flex-col">
                  {/* TODO: Post thumbnail yahan aayega */}
                  <div className="image-placeholder relative aspect-video bg-foreground/[0.06]" aria-label={`${p.title} thumbnail`} />
                  <div className="p-5 flex flex-col gap-3 flex-1">
                    <span className="text-[10px] uppercase tracking-[0.16em] text-primary self-start">{p.category}</span>
                    <h3 className="font-display text-lg uppercase tracking-tight text-foreground leading-tight">{p.title}</h3>
                    <div className="flex items-center gap-3 text-[11px] text-foreground/55">
                      <span className="inline-flex items-center gap-1"><User className="size-3" /> {p.author}</span>
                      <span className="inline-flex items-center gap-1"><Calendar className="size-3" /> {p.date}</span>
                    </div>
                    <p className="text-sm text-foreground/65 leading-relaxed flex-1">{p.excerpt}</p>
                    <button type="button" className="mt-2 inline-flex items-center gap-2 text-xs font-semibold text-primary hover:opacity-80 self-start">
                      Read More <ArrowRight className="size-3.5" />
                    </button>
                  </div>
                </article>
              ))}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <nav className="mt-10 flex items-center justify-center gap-2" aria-label="Pagination">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={safePage === 1}
                  className="size-10 rounded-full liquid-glass flex items-center justify-center text-foreground disabled:opacity-30"
                  aria-label="Previous page"
                >
                  <ArrowLeft className="size-4" />
                </button>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setPage(n)}
                    aria-current={n === safePage ? 'page' : undefined}
                    className={`size-10 rounded-full text-sm font-semibold ${
                      n === safePage ? 'bg-primary text-white' : 'liquid-glass text-foreground/80 hover:text-foreground'
                    }`}
                  >
                    {n}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={safePage === totalPages}
                  className="size-10 rounded-full liquid-glass flex items-center justify-center text-foreground disabled:opacity-30"
                  aria-label="Next page"
                >
                  <ArrowRight className="size-4" />
                </button>
              </nav>
            )}
          </div>

          {/* Sidebar */}
          <aside className="flex flex-col gap-6" aria-label="Sidebar">
            <div className="liquid-glass rounded-2xl p-5">
              <h3 className="font-display uppercase text-sm tracking-[0.16em] text-foreground/55 mb-4">Search</h3>
              <div className="liquid-glass rounded-xl flex items-center gap-2 px-3.5 py-2.5">
                <Search className="size-4 text-foreground/55" />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                  placeholder="Search posts…"
                  className="bg-transparent text-sm text-foreground placeholder:text-foreground/40 outline-none flex-1 min-w-0"
                  aria-label="Search blog posts"
                />
              </div>
            </div>

            <div className="liquid-glass rounded-2xl p-5">
              <h3 className="font-display uppercase text-sm tracking-[0.16em] text-foreground/55 mb-4">Recent Posts</h3>
              <ul className="flex flex-col gap-3">
                {POSTS.slice(0, 4).map((p) => (
                  <li key={p.id}>
                    <button type="button" className="text-left text-sm text-foreground/80 hover:text-primary transition-colors">
                      {p.title}
                    </button>
                    <div className="text-[11px] text-foreground/45 mt-0.5">{p.date}</div>
                  </li>
                ))}
              </ul>
            </div>

            <div className="liquid-glass rounded-2xl p-5">
              <h3 className="font-display uppercase text-sm tracking-[0.16em] text-foreground/55 mb-4">Categories</h3>
              <div className="flex flex-wrap gap-2">
                {CATEGORIES.map((c) => (
                  <button key={c} type="button" className="px-3 py-1 rounded-full liquid-glass text-xs text-foreground/85 hover:text-primary transition-colors">
                    {c}
                  </button>
                ))}
              </div>
            </div>

            <form
              onSubmit={(e) => { e.preventDefault(); setShowSuccess(true); }}
              className="liquid-glass-strong rounded-2xl p-5"
              aria-label="Newsletter signup"
            >
              <h3 className="font-display uppercase text-sm tracking-[0.16em] text-foreground/55 mb-2">Weekly Newsletter</h3>
              <p className="text-xs text-foreground/65 mb-4">One email every Friday. Trade ideas, market recap, no fluff.</p>
              <label className="block">
                <span className="sr-only">Email address</span>
                <input
                  type="email"
                  required
                  placeholder="you@example.com"
                  className="w-full liquid-glass rounded-xl px-3.5 py-2.5 text-sm bg-transparent text-foreground placeholder:text-foreground/40 outline-none focus:ring-2 focus:ring-primary/60"
                />
              </label>
              <button type="submit" className="mt-3 w-full rounded-full bg-primary text-white px-4 py-2.5 text-xs font-semibold uppercase tracking-wider hover:opacity-90">
                Subscribe
              </button>
            </form>
          </aside>
        </div>
      </div>

      <SuccessModal
        open={showSuccess}
        title="You're subscribed"
        message="Thanks for joining. Every Friday you'll get a fresh trade idea, a market recap, and the week's best educational blog — direct to your inbox."
        ctaLabel="OK"
        onClose={() => setShowSuccess(false)}
        footnote="No spam. Unsubscribe anytime."
      />
    </main>
  );
}
