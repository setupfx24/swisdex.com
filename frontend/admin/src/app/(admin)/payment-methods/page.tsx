'use client';

/**
 * Deposit payment methods — per-method admin config that drives the XM-style
 * trader deposit flow. Each method carries its own QR / UPI / bank text, the
 * step-2 notice + step-4 declaration, min/max and pay currency.
 */
import { useCallback, useEffect, useState } from 'react';
import { adminApi } from '@/lib/api';
import toast from 'react-hot-toast';

interface Method {
  id: string;
  method_key: string;
  display_name: string;
  enabled: boolean;
  sort_order: number;
  pay_currency: string;
  qr_image?: string | null;
  upi_id?: string | null;
  bank_text?: string | null;
  notice?: string | null;
  declaration?: string | null;
  min_amount?: number | null;
  max_amount?: number | null;
  usd_rate?: number | null;
  withdrawal_usd_rate?: number | null;
}

type Draft = Partial<Method> & { _new?: boolean };

const EMPTY: Draft = {
  _new: true, method_key: '', display_name: '', enabled: true, sort_order: 0,
  pay_currency: 'INR', qr_image: '', upi_id: '', bank_text: '', notice: '',
  declaration: '', min_amount: undefined, max_amount: undefined,
  usd_rate: undefined, withdrawal_usd_rate: undefined,
};

export default function PaymentMethodsPage() {
  const [items, setItems] = useState<Method[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminApi.get<{ items: Method[] }>('/finance/payment-methods');
      setItems(Array.isArray(res?.items) ? res.items : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const onQrFile = (f: File | null) => {
    if (!f || !draft) return;
    if (f.size > 3 * 1024 * 1024) { toast.error('QR image too large (max 3MB)'); return; }
    const r = new FileReader();
    r.onload = () => setDraft((d) => d ? { ...d, qr_image: String(r.result) } : d);
    r.readAsDataURL(f);
  };

  const save = async () => {
    if (!draft) return;
    if (draft._new && !String(draft.method_key || '').trim()) { toast.error('Enter a method key'); return; }
    if (!String(draft.display_name || '').trim()) { toast.error('Enter a display name'); return; }
    setBusy(true);
    try {
      const body = {
        method_key: draft.method_key, display_name: draft.display_name,
        enabled: draft.enabled, sort_order: Number(draft.sort_order) || 0,
        pay_currency: draft.pay_currency, qr_image: draft.qr_image || null,
        upi_id: draft.upi_id || null, bank_text: draft.bank_text || null,
        notice: draft.notice || null, declaration: draft.declaration || null,
        min_amount: draft.min_amount ?? null, max_amount: draft.max_amount ?? null,
        usd_rate: draft.usd_rate ?? null, withdrawal_usd_rate: draft.withdrawal_usd_rate ?? null,
      };
      if (draft._new) await adminApi.post('/finance/payment-methods', body);
      else await adminApi.put(`/finance/payment-methods/${draft.id}`, body);
      toast.success('Saved');
      setDraft(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const del = async (m: Method) => {
    if (!window.confirm(`Delete "${m.display_name}"?`)) return;
    try {
      await adminApi.delete(`/finance/payment-methods/${m.id}`);
      toast.success('Deleted');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed');
    }
  };

  const field = (label: string, node: React.ReactNode) => (
    <div className="space-y-1">
      <label className="text-xs text-text-secondary block">{label}</label>
      {node}
    </div>
  );
  const inputCls = 'w-full text-xs py-2 px-3 bg-bg-input border border-border-primary rounded-md outline-none focus:border-accent/50';

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-text-primary">Deposit Payment Methods</h1>
          <p className="text-xs text-text-tertiary mt-1">Each method's QR / UPI / bank + notice + declaration shown to traders.</p>
        </div>
        <button type="button" onClick={() => setDraft({ ...EMPTY })} className="px-3 py-1.5 rounded-md text-xs font-medium bg-accent/15 text-accent border border-accent/30">+ Add method</button>
      </div>

      {loading ? <p className="text-sm text-text-tertiary">Loading…</p> : (
        <div className="space-y-2">
          {items.length === 0 && <p className="text-sm text-text-tertiary">No methods yet. Add one.</p>}
          {items.map((m) => (
            <div key={m.id} className="rounded-lg border border-border-primary bg-bg-secondary p-3 flex items-center justify-between gap-3">
              <div className="min-w-0 flex items-center gap-3">
                {m.qr_image ? <img src={m.qr_image} alt="QR" className="w-10 h-10 rounded object-contain border border-border-primary" /> : null}
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text-primary truncate">{m.display_name} <span className="text-text-tertiary text-xs">({m.method_key})</span></p>
                  <p className="text-xs text-text-tertiary">{m.pay_currency} · {m.enabled ? 'Enabled' : 'Disabled'} · order {m.sort_order}{m.upi_id ? ` · UPI ${m.upi_id}` : ''}</p>
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button type="button" onClick={() => setDraft({ ...m })} className="text-xs text-buy hover:underline">Edit</button>
                <button type="button" onClick={() => void del(m)} className="text-xs text-danger hover:underline">Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {draft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setDraft(null)} />
          <div className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl border border-border-primary bg-bg-primary p-4 space-y-3">
            <h2 className="text-sm font-bold text-text-primary">{draft._new ? 'Add' : 'Edit'} payment method</h2>
            <div className="grid grid-cols-2 gap-3">
              {field('Method key (slug)', <input disabled={!draft._new} value={draft.method_key ?? ''} onChange={(e) => setDraft({ ...draft, method_key: e.target.value })} placeholder="upi" className={inputCls} />)}
              {field('Display name', <input value={draft.display_name ?? ''} onChange={(e) => setDraft({ ...draft, display_name: e.target.value })} placeholder="UPI" className={inputCls} />)}
              {field('Pay currency', <input value={draft.pay_currency ?? 'INR'} onChange={(e) => setDraft({ ...draft, pay_currency: e.target.value.toUpperCase() })} className={inputCls} />)}
              {field('Sort order', <input type="number" value={draft.sort_order ?? 0} onChange={(e) => setDraft({ ...draft, sort_order: Number(e.target.value) })} className={inputCls} />)}
              {field('Min amount', <input type="number" value={draft.min_amount ?? ''} onChange={(e) => setDraft({ ...draft, min_amount: e.target.value === '' ? undefined : Number(e.target.value) })} className={inputCls} />)}
              {field('Max amount', <input type="number" value={draft.max_amount ?? ''} onChange={(e) => setDraft({ ...draft, max_amount: e.target.value === '' ? undefined : Number(e.target.value) })} className={inputCls} />)}
              {field(`Deposit: 1 USD = ? ${draft.pay_currency || 'INR'}`, <input type="number" step="0.01" min="0" value={draft.usd_rate ?? ''} onChange={(e) => setDraft({ ...draft, usd_rate: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder="e.g. 83 (blank = live)" className={inputCls} />)}
              {field(`Withdrawal: 1 USD = ? ${draft.pay_currency || 'INR'}`, <input type="number" step="0.01" min="0" value={draft.withdrawal_usd_rate ?? ''} onChange={(e) => setDraft({ ...draft, withdrawal_usd_rate: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder="e.g. 85 (blank = live)" className={inputCls} />)}
            </div>
            <p className="text-[11px] text-text-tertiary -mt-1">
              Enter the <b>dollar price</b> — how many {draft.pay_currency || 'INR'} equal 1 USD (e.g. 83). Blank = live FX API. Deposit &amp; withdrawal priced separately.
              {draft.usd_rate ? ` Deposit: 5000 ${draft.pay_currency || 'INR'} → $${(5000 / Number(draft.usd_rate)).toFixed(2)}.` : ''}
              {draft.withdrawal_usd_rate ? ` Withdrawal: $100 → ${(100 * Number(draft.withdrawal_usd_rate)).toFixed(2)} ${draft.pay_currency || 'INR'}.` : ''}
            </p>
            {field('UPI ID', <input value={draft.upi_id ?? ''} onChange={(e) => setDraft({ ...draft, upi_id: e.target.value })} placeholder="name@bank" className={inputCls} />)}
            {field('Bank details (account / IFSC / holder)', <textarea value={draft.bank_text ?? ''} onChange={(e) => setDraft({ ...draft, bank_text: e.target.value })} className={`${inputCls} h-16 resize-none`} />)}
            {field('QR image', <div><input type="file" accept="image/*" onChange={(e) => onQrFile(e.target.files?.[0] ?? null)} className="text-xs text-text-secondary" />{draft.qr_image ? <img src={draft.qr_image} alt="QR" className="mt-2 max-h-32 rounded border border-border-primary" /> : null}</div>)}
            {field('Notice (step-2 "Accept & Continue")', <textarea value={draft.notice ?? ''} onChange={(e) => setDraft({ ...draft, notice: e.target.value })} placeholder="UPI deposits may take up to 20 minutes…" className={`${inputCls} h-16 resize-none`} />)}
            {field('Declaration (step-4 checkbox)', <textarea value={draft.declaration ?? ''} onChange={(e) => setDraft({ ...draft, declaration: e.target.value })} placeholder="I declare the deposit is from a bank account in my name…" className={`${inputCls} h-16 resize-none`} />)}
            <label className="flex items-center gap-2 text-xs text-text-secondary">
              <input type="checkbox" checked={!!draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> Enabled (visible to traders)
            </label>
            <div className="flex gap-2 pt-1">
              <button type="button" disabled={busy} onClick={() => void save()} className="flex-1 rounded-md bg-accent/15 text-accent border border-accent/30 py-2 text-xs font-semibold disabled:opacity-50">{busy ? 'Saving…' : 'Save'}</button>
              <button type="button" onClick={() => setDraft(null)} className="rounded-md border border-border-primary px-3 py-2 text-xs text-text-secondary">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
