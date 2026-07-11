import { NextResponse } from 'next/server';

/**
 * GET /api/market-news
 *
 * Live forex/market news headlines. ForexFactory has NO public news feed
 * (only its economic calendar, which we already source in
 * /api/economic-calendar), so headlines come from established forex-news RSS
 * feeds instead. Sources are tried in order; the first that yields items wins.
 * Falls back to an empty list (never throws) so the panel degrades gracefully.
 */

interface MarketHeadlineDTO {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedAt: string | null; // ISO
  summary: string | null;
  category: string | null;
}

// Forex-focused public RSS feeds — no API key, refreshed continuously.
const SOURCES: { name: string; url: string }[] = [
  { name: 'ForexLive', url: 'https://www.forexlive.com/feed/news/' },
  { name: 'FXStreet', url: 'https://www.fxstreet.com/rss/news' },
  { name: 'DailyFX', url: 'https://www.dailyfx.com/feeds/market-news' },
];

function stripTags(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();
}

function pick(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? stripTags(m[1]) : null;
}

function parseRss(xml: string, sourceName: string): MarketHeadlineDTO[] {
  const out: MarketHeadlineDTO[] = [];
  // Support both RSS <item> and Atom <entry>.
  const blocks = xml.match(/<(item|entry)[\s\S]*?<\/(item|entry)>/gi) || [];
  for (const block of blocks) {
    const title = pick(block, 'title');
    if (!title) continue;
    // Atom uses <link href="…"/>; RSS uses <link>…</link>.
    let url = pick(block, 'link');
    if (!url) {
      const href = block.match(/<link[^>]*href=["']([^"']+)["']/i);
      url = href ? href[1] : null;
    }
    const pub = pick(block, 'pubDate') || pick(block, 'published') || pick(block, 'updated');
    let publishedAt: string | null = null;
    if (pub) {
      const d = new Date(pub);
      if (!Number.isNaN(d.getTime())) publishedAt = d.toISOString();
    }
    const summaryRaw = pick(block, 'description') || pick(block, 'summary');
    const summary = summaryRaw ? summaryRaw.slice(0, 260) : null;
    const category = pick(block, 'category');
    out.push({
      id: `${sourceName}-${(url || title).slice(0, 180)}`,
      title,
      url: url || '#',
      source: sourceName,
      publishedAt,
      summary,
      category,
    });
  }
  return out;
}

async function fetchSource(src: { name: string; url: string }, signal: AbortSignal): Promise<MarketHeadlineDTO[]> {
  try {
    const res = await fetch(src.url, {
      signal,
      headers: {
        // Some feeds 403 a missing UA; present a normal one.
        'user-agent': 'Mozilla/5.0 (compatible; SwisDex-News/1.0; +https://swisdex.com)',
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
      // Shared 5-minute server cache — headlines don't need to be sub-minute.
      next: { revalidate: 300 },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRss(xml, src.name);
  } catch {
    return [];
  }
}

export async function GET() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    let items: MarketHeadlineDTO[] = [];
    // First source that returns something wins (keeps one consistent source).
    for (const src of SOURCES) {
      items = await fetchSource(src, ctrl.signal);
      if (items.length > 0) break;
    }
    // Newest first; cap to a sensible panel length.
    items.sort((a, b) => {
      const ta = a.publishedAt ? Date.parse(a.publishedAt) : 0;
      const tb = b.publishedAt ? Date.parse(b.publishedAt) : 0;
      return tb - ta;
    });
    return NextResponse.json({ items: items.slice(0, 40) });
  } finally {
    clearTimeout(timer);
  }
}
