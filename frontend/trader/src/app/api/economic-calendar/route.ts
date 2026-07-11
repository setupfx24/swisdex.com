import { NextResponse } from 'next/server';
import {
  getMockCalendarEventsForRange,
  type EconomicCalendarApiResponse,
  type EconomicCalendarEventDTO,
  type EconomicImpactLevel,
} from '@/lib/economic-calendar';

// Free public mirror of ForexFactory's weekly calendar — same data, no
// auth required, no rate limit beyond reasonable courtesy. Both files
// are refreshed by faireconomy.media every ~15 minutes. The JSON feed
// carries full ISO-8601 datetimes WITH the utc offset (e.g.
// "2026-07-05T21:00:00-04:00"), so no timezone guessing is needed.
// (The CSV variant's times are UTC despite looking like wall times —
// parsing them as ET shifted every event 4-5h late. Client 2026-07-10.)
const FF_URLS = [
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  'https://nfs.faireconomy.media/ff_calendar_nextweek.json',
];

const CURRENCY_FLAG: Record<string, string> = {
  USD: '🇺🇸', EUR: '🇪🇺', GBP: '🇬🇧', JPY: '🇯🇵', AUD: '🇦🇺',
  NZD: '🇳🇿', CAD: '🇨🇦', CHF: '🇨🇭', CNY: '🇨🇳', HKD: '🇭🇰',
  SGD: '🇸🇬', INR: '🇮🇳', SEK: '🇸🇪', NOK: '🇳🇴', DKK: '🇩🇰',
  ZAR: '🇿🇦', BRL: '🇧🇷', MXN: '🇲🇽', RUB: '🇷🇺', TRY: '🇹🇷',
  KRW: '🇰🇷',
};

const REGION_FROM_CURRENCY: Record<string, string> = {
  USD: 'US', EUR: 'EU', GBP: 'GB', JPY: 'JP', AUD: 'AU', NZD: 'NZ',
  CAD: 'CA', CHF: 'CH', CNY: 'CN', HKD: 'HK', SGD: 'SG', INR: 'IN',
  SEK: 'SE', NOK: 'NO', DKK: 'DK', ZAR: 'ZA', BRL: 'BR', MXN: 'MX',
  RUB: 'RU', TRY: 'TR', KRW: 'KR',
};

function normalizeImpact(raw: string): EconomicImpactLevel | null {
  const v = raw.trim().toLowerCase();
  if (v === 'high') return 'high';
  if (v === 'medium') return 'medium';
  if (v === 'low') return 'low';
  // Holiday / Non-Economic / Tentative — show as low so users still see the row.
  if (v === 'holiday' || v === 'non-economic') return 'low';
  return null;
}

function toLocalYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function fetchOne(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    // next.revalidate gives us a 15-minute server-side cache shared across
    // all callers — well under the mirror's refresh cadence so we're a
    // good citizen and never block on a slow upstream during a render.
    const res = await fetch(url, {
      signal,
      headers: { 'user-agent': 'SwisDex-Calendar/1.0' },
      next: { revalidate: 900 },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// Feed row shape: {title, country, date: ISO-8601 with offset, impact,
// forecast, previous}. `new Date(date)` lands on the exact UTC instant —
// the browser then renders it in the user's chosen timezone.
function parseJsonFeed(text: string): EconomicCalendarEventDTO[] {
  let rows: unknown;
  try {
    rows = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];

  const out: EconomicCalendarEventDTO[] = [];
  for (const raw of rows) {
    const r = raw as Record<string, unknown>;
    const title = String(r.title ?? '').trim();
    const currency = String(r.country ?? '').trim().toUpperCase();
    const dateStr = String(r.date ?? '').trim();
    if (!title || !currency || !dateStr) continue;

    const impact = normalizeImpact(String(r.impact ?? ''));
    if (!impact) continue;

    const dt = new Date(dateStr);
    if (Number.isNaN(dt.getTime())) continue;

    const previous = String(r.previous ?? '').trim();
    const consensus = String(r.forecast ?? '').trim();

    out.push({
      id: `${currency}-${dt.getTime()}-${title}`.slice(0, 256),
      datetime: dt.toISOString(),
      region: REGION_FROM_CURRENCY[currency],
      currency,
      flag: CURRENCY_FLAG[currency] || '·',
      impact,
      title,
      actual: null,
      previous: previous || null,
      consensus: consensus || null,
    });
  }
  return out;
}

async function fetchFromFaireconomy(): Promise<EconomicCalendarEventDTO[] | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const texts = await Promise.all(FF_URLS.map((u) => fetchOne(u, ctrl.signal)));
    const events: EconomicCalendarEventDTO[] = [];
    for (const t of texts) if (t) events.push(...parseJsonFeed(t));
    if (events.length === 0) return null;
    return events;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET /api/economic-calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Sources rows from the free faireconomy.media mirror of ForexFactory
 * (this week + next week). Falls back to mock data if the mirror is
 * unreachable so the page never goes blank.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const from = searchParams.get('from');
  const to = searchParams.get('to');

  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return NextResponse.json({ error: 'Query params from and to (YYYY-MM-DD) are required.' }, { status: 400 });
  }
  if (from > to) {
    return NextResponse.json({ error: 'from must be <= to.' }, { status: 400 });
  }

  let events: EconomicCalendarEventDTO[] = [];
  const upstream = await fetchFromFaireconomy();
  if (upstream && upstream.length > 0) {
    events = upstream.filter((e) => {
      const ymd = toLocalYmd(new Date(e.datetime));
      return ymd >= from && ymd <= to;
    });
  } else {
    events = getMockCalendarEventsForRange(from, to);
  }

  const body: EconomicCalendarApiResponse = { events };
  return NextResponse.json(body);
}
