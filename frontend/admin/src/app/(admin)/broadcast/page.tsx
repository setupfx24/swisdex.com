'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { Loader2, Megaphone, Send, AlertTriangle } from 'lucide-react';
import { adminApi } from '@/lib/api';

/**
 * Mass-email admin tool.
 *
 * Today: scheduled-maintenance notice. The form materializes a
 * recipient cohort (all / verified / funded_only), then POSTs to
 * /admin/broadcast/maintenance which queues per-user transactional
 * sends through the same SMTP path as every other system email.
 *
 * Dry-run returns the would-be recipient count without sending so the
 * admin can sanity-check the audience filter before firing.
 */

const SERVICE_OPTIONS = [
  'Trading',
  'Deposits',
  'Withdrawals',
  'Charts',
  'WebSocket feed',
  'IB / Affiliate',
  'PAMM / Copy Trading',
];

export default function BroadcastPage() {
  const [windowLabel, setWindowLabel] = useState('');
  const [duration, setDuration] = useState('~2 hours');
  const [mSubject, setMSubject] = useState('');
  const [mTitle, setMTitle] = useState('');
  const [services, setServices] = useState<string[]>(['Trading']);
  const [reason, setReason] = useState('');
  const [customHtml, setCustomHtml] = useState('');
  const [audience, setAudience] = useState<'all' | 'verified' | 'funded_only'>('verified');
  const [throttleMs, setThrottleMs] = useState(500);

  const [recipientPreview, setRecipientPreview] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [sending, setSending] = useState(false);

  // ── Custom announcement (free title + body + audience segment) ──
  const [anSubject, setAnSubject] = useState('');
  const [anHeading, setAnHeading] = useState('');
  const [anIntro, setAnIntro] = useState('');
  const [anMessage, setAnMessage] = useState('');
  const [anCtaLabel, setAnCtaLabel] = useState('');
  const [anCtaUrl, setAnCtaUrl] = useState('');
  const [anAudience, setAnAudience] = useState<'all' | 'funded_only' | 'ib' | 'pamm_mam' | 'fixed_return'>('all');
  const [anPreview, setAnPreview] = useState<number | null>(null);
  const [anSending, setAnSending] = useState(false);

  const anPayload = (dry: boolean) => ({
    subject: anSubject.trim(),
    heading: anHeading.trim(),
    intro: anIntro.trim() || null,
    message_html: anMessage.trim(),
    cta_label: anCtaLabel.trim() || null,
    cta_url: anCtaUrl.trim() || null,
    audience: anAudience,
    dry_run: dry,
  });
  const anValid = anSubject.trim().length > 2 && anHeading.trim().length > 2 && anMessage.trim().length > 2;

  const anRun = async (dry: boolean) => {
    if (!anValid) { toast.error('Fill subject, heading and message'); return; }
    if (!dry) {
      const c = anPreview != null ? `Send to ${anPreview.toLocaleString()} users?` : 'Send announcement now?';
      if (!confirm(c)) return;
    }
    setAnSending(true);
    try {
      const res = await adminApi.post<{ would_send_to?: number; recipients?: number; message?: string }>(
        '/broadcast/announce', anPayload(dry),
      );
      if (dry) { setAnPreview(res.would_send_to ?? 0); }
      else { toast.success(res.message || 'Queued', { duration: 6000 }); setAnPreview(null); }
    } catch (e: any) {
      toast.error(e.message || 'Failed');
    } finally {
      setAnSending(false);
    }
  };

  const buildPayload = (dry: boolean) => ({
    window_label: windowLabel.trim(),
    expected_duration: duration.trim(),
    subject: mSubject.trim() || null,
    title: mTitle.trim() || null,
    impacted_services: services,
    reason: reason.trim() || null,
    custom_message_html: customHtml.trim() || null,
    audience,
    throttle_per_100_ms: throttleMs,
    dry_run: dry,
  });

  const canFire = windowLabel.trim().length > 3 && duration.trim().length > 1;

  const runPreview = async () => {
    if (!canFire) {
      toast.error('Fill in window and duration first');
      return;
    }
    setPreviewing(true);
    try {
      const res = await adminApi.post<{ would_send_to: number }>(
        '/broadcast/maintenance',
        buildPayload(true),
      );
      setRecipientPreview(res.would_send_to);
    } catch (e: any) {
      toast.error(e.message || 'Preview failed');
    } finally {
      setPreviewing(false);
    }
  };

  const runSend = async () => {
    if (!canFire) {
      toast.error('Fill in window and duration first');
      return;
    }
    const confirmMsg =
      recipientPreview != null
        ? `Send maintenance notice to ${recipientPreview.toLocaleString()} users?`
        : 'Send maintenance notice now? (no preview was run)';
    if (!confirm(confirmMsg)) return;

    setSending(true);
    try {
      const res = await adminApi.post<{ recipients: number; message: string }>(
        '/broadcast/maintenance',
        buildPayload(false),
      );
      toast.success(`${res.message}`, { duration: 6000 });
      setRecipientPreview(null);
    } catch (e: any) {
      toast.error(e.message || 'Send failed');
    } finally {
      setSending(false);
    }
  };

  const toggleService = (s: string) => {
    setServices((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
    setRecipientPreview(null);
  };

  return (
    <div className="p-6 space-y-4 max-w-3xl">
      <div className="flex items-center gap-2">
        <Megaphone size={18} className="text-accent" />
        <div>
          <h1 className="text-lg font-semibold text-text-primary">Broadcast — Maintenance Notice</h1>
          <p className="text-xxs text-text-tertiary mt-0.5">
            Send an outage notice to every active verified user. Use the dry-run preview to confirm
            the recipient count before firing.
          </p>
        </div>
      </div>

      <div className="bg-bg-secondary border border-border-primary rounded-md p-5 space-y-4">
        {/* Editable email subject + heading — blank falls back to the
            default "Scheduled maintenance …". */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xxs text-text-tertiary uppercase mb-1">Email subject (optional)</label>
            <input
              value={mSubject}
              onChange={(e) => { setMSubject(e.target.value); setRecipientPreview(null); }}
              placeholder="Scheduled maintenance — 13 Jun 2026"
              className="w-full px-3 py-2 text-xs bg-bg-tertiary border border-border-primary rounded-md focus:outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="block text-xxs text-text-tertiary uppercase mb-1">Heading in email (optional)</label>
            <input
              value={mTitle}
              onChange={(e) => setMTitle(e.target.value)}
              placeholder="Scheduled maintenance"
              className="w-full px-3 py-2 text-xs bg-bg-tertiary border border-border-primary rounded-md focus:outline-none focus:border-accent"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xxs text-text-tertiary uppercase mb-1">Window label</label>
            <input
              value={windowLabel}
              onChange={(e) => { setWindowLabel(e.target.value); setRecipientPreview(null); }}
              placeholder="Sun 25 May 2026, 18:00–20:00 UTC"
              className="w-full px-3 py-2 text-xs bg-bg-tertiary border border-border-primary rounded-md focus:outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="block text-xxs text-text-tertiary uppercase mb-1">Expected duration</label>
            <input
              value={duration}
              onChange={(e) => { setDuration(e.target.value); setRecipientPreview(null); }}
              placeholder="~2 hours"
              className="w-full px-3 py-2 text-xs bg-bg-tertiary border border-border-primary rounded-md focus:outline-none focus:border-accent"
            />
          </div>
        </div>

        <div>
          <label className="block text-xxs text-text-tertiary uppercase mb-1">Services impacted</label>
          <div className="flex flex-wrap gap-1.5">
            {SERVICE_OPTIONS.map((s) => {
              const on = services.includes(s);
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggleService(s)}
                  className={[
                    'px-2.5 py-1 rounded-md text-xxs border transition-fast',
                    on
                      ? 'bg-accent/15 text-accent border-accent/40'
                      : 'bg-bg-tertiary text-text-secondary border-border-primary hover:bg-bg-hover',
                  ].join(' ')}
                >
                  {s}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label className="block text-xxs text-text-tertiary uppercase mb-1">Reason (optional)</label>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Database upgrade · Liquidity provider switchover · etc."
            className="w-full px-3 py-2 text-xs bg-bg-tertiary border border-border-primary rounded-md focus:outline-none focus:border-accent"
            maxLength={400}
          />
        </div>

        <div>
          <label className="block text-xxs text-text-tertiary uppercase mb-1">Custom message (HTML allowed, optional)</label>
          <textarea
            rows={3}
            value={customHtml}
            onChange={(e) => setCustomHtml(e.target.value)}
            placeholder="Extra paragraph appended to the standard maintenance template."
            className="w-full px-3 py-2 text-xs bg-bg-tertiary border border-border-primary rounded-md focus:outline-none focus:border-accent resize-none font-mono"
            maxLength={4000}
          />
          <p className="text-xxs text-text-tertiary mt-1">
            Renders inside a bordered block under the impact summary. Plain HTML only — no scripts.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xxs text-text-tertiary uppercase mb-1">Audience</label>
            <select
              value={audience}
              onChange={(e) => { setAudience(e.target.value as any); setRecipientPreview(null); }}
              className="w-full px-3 py-2 text-xs bg-bg-tertiary border border-border-primary rounded-md focus:outline-none focus:border-accent"
            >
              <option value="all">All active verified users</option>
              <option value="verified">Verified users (same as 'all' today)</option>
              <option value="funded_only">Funded only (balance &gt; 0)</option>
            </select>
          </div>
          <div>
            <label className="block text-xxs text-text-tertiary uppercase mb-1">Throttle per 100 emails (ms)</label>
            <input
              type="number"
              min={0}
              max={10000}
              step={100}
              value={throttleMs}
              onChange={(e) => setThrottleMs(parseInt(e.target.value || '0', 10))}
              className="w-full px-3 py-2 text-xs font-mono bg-bg-tertiary border border-border-primary rounded-md focus:outline-none focus:border-accent"
            />
            <p className="text-xxs text-text-tertiary mt-1">SMTP relays throttle bursts; 500ms is safe.</p>
          </div>
        </div>

        {recipientPreview != null && (
          <div className="rounded-md bg-accent/10 border border-accent/30 px-3 py-2 text-xs text-accent">
            Dry-run: would email <strong>{recipientPreview.toLocaleString()}</strong> user(s).
          </div>
        )}

        <div className="rounded-md bg-warning/10 border border-warning/30 px-3 py-2 text-xxs text-warning flex items-start gap-2">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>
            Every recipient receives the email immediately. There is no scheduled-send queue —
            fire only when the window and message are final.
          </span>
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={runPreview}
            disabled={!canFire || previewing || sending}
            className="px-3 py-1.5 rounded-md text-xs text-text-secondary border border-border-primary hover:bg-bg-hover disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {previewing ? <Loader2 size={13} className="animate-spin" /> : <Megaphone size={13} />}
            {previewing ? 'Counting…' : 'Preview audience'}
          </button>
          <button
            onClick={runSend}
            disabled={!canFire || sending || previewing}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {sending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
            {sending ? 'Sending…' : 'Send to recipients'}
          </button>
        </div>
      </div>

      {/* ── Custom Announcement (any title/body, targeted audience) ── */}
      <div className="flex items-center gap-2 pt-2">
        <Megaphone size={18} className="text-accent" />
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Custom Announcement</h2>
          <p className="text-xxs text-text-tertiary mt-0.5">
            Send any message (event, offer, update) with your own title to a chosen audience — All / IB / PAMM-MAM / Fixed-return / Funded.
          </p>
        </div>
      </div>

      <div className="bg-bg-secondary border border-border-primary rounded-md p-5 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xxs text-text-tertiary uppercase mb-1">Email subject</label>
            <input value={anSubject} onChange={(e) => { setAnSubject(e.target.value); setAnPreview(null); }}
              placeholder="New: Diwali bonus is live 🎉"
              className="w-full px-3 py-2 text-xs bg-bg-tertiary border border-border-primary rounded-md focus:outline-none focus:border-accent" />
          </div>
          <div>
            <label className="block text-xxs text-text-tertiary uppercase mb-1">Heading (in email)</label>
            <input value={anHeading} onChange={(e) => setAnHeading(e.target.value)}
              placeholder="Celebrate with 50% deposit bonus"
              className="w-full px-3 py-2 text-xs bg-bg-tertiary border border-border-primary rounded-md focus:outline-none focus:border-accent" />
          </div>
        </div>
        <div>
          <label className="block text-xxs text-text-tertiary uppercase mb-1">Intro line (optional)</label>
          <input value={anIntro} onChange={(e) => setAnIntro(e.target.value)}
            placeholder="A short lead under the heading."
            className="w-full px-3 py-2 text-xs bg-bg-tertiary border border-border-primary rounded-md focus:outline-none focus:border-accent" maxLength={300} />
        </div>
        <div>
          <label className="block text-xxs text-text-tertiary uppercase mb-1">Message (HTML allowed)</label>
          <textarea rows={4} value={anMessage} onChange={(e) => setAnMessage(e.target.value)}
            placeholder="<p>Full details of your event or offer…</p>"
            className="w-full px-3 py-2 text-xs bg-bg-tertiary border border-border-primary rounded-md focus:outline-none focus:border-accent resize-none font-mono" maxLength={8000} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xxs text-text-tertiary uppercase mb-1">Button label (optional)</label>
            <input value={anCtaLabel} onChange={(e) => setAnCtaLabel(e.target.value)} placeholder="Claim now"
              className="w-full px-3 py-2 text-xs bg-bg-tertiary border border-border-primary rounded-md focus:outline-none focus:border-accent" />
          </div>
          <div>
            <label className="block text-xxs text-text-tertiary uppercase mb-1">Button link (optional)</label>
            <input value={anCtaUrl} onChange={(e) => setAnCtaUrl(e.target.value)} placeholder="https://trade.swisdex.com/bonus"
              className="w-full px-3 py-2 text-xs bg-bg-tertiary border border-border-primary rounded-md focus:outline-none focus:border-accent" />
          </div>
        </div>
        <div>
          <label className="block text-xxs text-text-tertiary uppercase mb-1">Audience</label>
          <select value={anAudience} onChange={(e) => { setAnAudience(e.target.value as any); setAnPreview(null); }}
            className="w-full px-3 py-2 text-xs bg-bg-tertiary border border-border-primary rounded-md focus:outline-none focus:border-accent">
            <option value="all">All active verified users</option>
            <option value="funded_only">Funded only (balance &gt; 0)</option>
            <option value="ib">IB / Affiliates</option>
            <option value="pamm_mam">PAMM / MAM managers</option>
            <option value="fixed_return">AI-POWERED STAKING PROGRAM holders</option>
          </select>
        </div>

        {anPreview != null && (
          <div className="rounded-md bg-accent/10 border border-accent/30 px-3 py-2 text-xs text-accent">
            Dry-run: would email <strong>{anPreview.toLocaleString()}</strong> user(s).
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button onClick={() => anRun(true)} disabled={!anValid || anSending}
            className="px-3 py-1.5 rounded-md text-xs text-text-secondary border border-border-primary hover:bg-bg-hover disabled:opacity-50 inline-flex items-center gap-1.5">
            {anSending ? <Loader2 size={13} className="animate-spin" /> : <Megaphone size={13} />} Preview audience
          </button>
          <button onClick={() => anRun(false)} disabled={!anValid || anSending}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-accent/15 text-accent border border-accent/30 hover:bg-accent/25 disabled:opacity-50 inline-flex items-center gap-1.5">
            {anSending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} Send announcement
          </button>
        </div>
      </div>
    </div>
  );
}
