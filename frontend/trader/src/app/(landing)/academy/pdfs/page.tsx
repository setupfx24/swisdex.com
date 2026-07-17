'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { FileText, Download, ArrowUpRight, Mail } from 'lucide-react';
import { BannerPlaceholder } from '@/swisdex/components/BannerPlaceholder';
import SuccessModal from '@/swisdex/components/SuccessModal';

type Cat = 'Guides' | 'E-books' | 'Reports';

interface Pdf {
  id: string;
  title: string;
  description: string;
  pages: number;
  size: string;
  category: Cat;
}

const PDFS: Pdf[] = [
  { id: 'p1', title: 'The Beginner Forex Handbook',          description: 'Pip basics, lot sizing, margin, leverage and your first 30 days.', pages: 42, size: '3.1 MB', category: 'Guides'   },
  { id: 'p2', title: 'Risk Management Playbook',             description: 'Position sizing, stop-loss placement, and the math behind the 1% rule.', pages: 28, size: '1.8 MB', category: 'Guides'   },
  { id: 'p3', title: 'Advanced Price Action Patterns',       description: 'Breakouts, retests, double tops, head & shoulders — high-probability setups.', pages: 56, size: '5.4 MB', category: 'Guides'   },
  { id: 'p4', title: 'Crypto Trading: 0 → Pro',              description: 'BTC market structure, alt rotation, on-chain signals, and tax basics.', pages: 78, size: '6.9 MB', category: 'E-books'  },
  { id: 'p5', title: 'Algorithmic Trading 101',              description: 'Python basics, backtesting, paper trading, and going live with capital.', pages: 64, size: '4.7 MB', category: 'E-books'  },
  { id: 'p6', title: 'Q1 2026 Forex Outlook',                description: 'USD strength scenarios, ECB rate path, and major currency cross views.', pages: 18, size: '1.2 MB', category: 'Reports'  },
  { id: 'p7', title: 'Gold & Commodities Monthly Brief',     description: 'XAU/USD positioning, oil flows, and key macro events this month.',     pages: 14, size: '0.9 MB', category: 'Reports'  },
  { id: 'p8', title: 'Index CFD Strategy Guide',             description: 'US30, NAS100, GER40 — when to trend-follow vs. mean-revert.',           pages: 36, size: '2.6 MB', category: 'Guides'   },
];

const TABS: Array<'All' | Cat> = ['All', 'Guides', 'E-books', 'Reports'];

export default function AcademyPdfsPage() {
  const [tab, setTab] = useState<'All' | Cat>('All');
  const [email, setEmail] = useState('');
  const [showSuccess, setShowSuccess] = useState(false);

  const list = useMemo(() => (tab === 'All' ? PDFS : PDFS.filter((p) => p.category === tab)), [tab]);

  return (
    <main className="min-h-screen bg-background">
      <BannerPlaceholder
        title="SwisDex Academy — PDFs"
        tagline="Downloadable guides, e-books, and quarterly research — read offline, refer back any time."
      />

      {/* Category tabs */}
      <section id="categories" className="mx-auto max-w-[1200px] px-[var(--gutter)] py-6 sm:py-10">
        <div className="flex flex-wrap justify-center gap-2 p-1.5 rounded-full liquid-glass w-fit mx-auto">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              aria-pressed={tab === t}
              className={`px-4 py-2 rounded-full text-sm font-body transition-colors ${
                tab === t ? 'bg-primary text-white' : 'text-foreground/70 hover:text-foreground'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </section>

      {/* PDF grid */}
      <section id="pdfs" className="mx-auto max-w-[1200px] px-[var(--gutter)] pb-16 sm:pb-20">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {list.map((p) => (
            <article key={p.id} className="liquid-glass rounded-2xl overflow-hidden flex flex-col">
              {/* TODO: PDF cover thumbnail yahan aayega */}
              <div
                className="image-placeholder relative aspect-[3/4] bg-foreground/[0.06] flex items-center justify-center"
                aria-label={`${p.title} cover`}
              >
                <FileText className="size-12 text-foreground/40" aria-hidden />
                <span className="absolute top-2 left-2 text-[10px] px-2 py-0.5 rounded-md bg-primary/30 text-primary uppercase tracking-wider">
                  {p.category}
                </span>
              </div>
              <div className="p-5 flex flex-col gap-3 flex-1">
                <h3 className="font-display text-lg uppercase tracking-tight text-foreground leading-tight">
                  {p.title}
                </h3>
                <p className="text-sm text-foreground/65 leading-relaxed flex-1">{p.description}</p>
                <div className="flex items-center justify-between text-xs text-foreground/55">
                  <span>{p.pages} pages</span>
                  <span>{p.size}</span>
                </div>
                <button
                  type="button"
                  className="mt-2 inline-flex items-center justify-center gap-2 rounded-full bg-primary/25 hover:bg-primary/40 text-primary px-4 py-2.5 text-xs font-semibold uppercase tracking-wider transition-colors"
                  aria-label={`Download ${p.title}`}
                >
                  <Download className="size-4" /> Download
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* Email-gate form */}
      <section id="gate" className="mx-auto max-w-[1200px] px-[var(--gutter)] pb-20">
        <div className="liquid-glass-strong rounded-3xl p-6 sm:p-10 grid md:grid-cols-2 gap-8 items-center">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/25 text-primary text-[11px] uppercase tracking-[0.16em] mb-4">
              <Mail className="size-3.5" /> Premium Library
            </div>
            <h2 className="font-display uppercase text-2xl sm:text-3xl tracking-tight">Get every new release in your inbox</h2>
            <p className="mt-3 text-foreground/65 text-sm sm:text-base max-w-md">
              Drop your email — we send each new guide, e-book, and quarterly report as soon as it's published. No spam, unsubscribe anytime.
            </p>
          </div>
          <form
            onSubmit={(e) => { e.preventDefault(); setShowSuccess(true); setEmail(''); }}
            className="flex flex-col sm:flex-row gap-3"
            aria-label="Subscribe for new PDFs"
          >
            <label className="flex-1">
              <span className="sr-only">Email address</span>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full liquid-glass rounded-full px-4 py-3 text-sm bg-transparent text-foreground placeholder:text-foreground/40 outline-none focus:ring-2 focus:ring-primary/60"
              />
            </label>
            <button
              type="submit"
              className="inline-flex items-center justify-center gap-2 rounded-full bg-primary text-white px-6 py-3 text-sm font-semibold uppercase tracking-wider hover:opacity-90"
            >
              Subscribe <ArrowUpRight className="size-4" />
            </button>
          </form>
        </div>
      </section>

      <SuccessModal
        open={showSuccess}
        title="You're on the list"
        message="Thanks for subscribing. We'll send each new guide, e-book, and quarterly report straight to your inbox as soon as it's published."
        ctaLabel="OK"
        onClose={() => setShowSuccess(false)}
        footnote="No spam — unsubscribe anytime from any email."
      />
    </main>
  );
}
