'use client';

/**
 * Personal bank-deposit requests queue. A user asks for payment details from
 * the bank-deposit page; admin approves with a personal QR / bank / UPI (any
 * combination) and the user pays. See migration 0082.
 */
import { useCallback, useEffect, useState } from 'react';
import { adminApi } from '@/lib/api';
import toast from 'react-hot-toast';

interface DepositReq {
  id: string;
  user_name: string;
  user_email: string;
  amount: number | null;
  status: string;
  admin_qr?: string | null;
  admin_bank_text?: string | null;
  admin_upi?: string | null;
  admin_note?: string | null;
  created_at: string | null;
}

const STATUSES = ['pending', 'approved', 'rejected', 'all'] as const;

export default function DepositRequestsPage() {
  const [items, setItems] = useState<DepositReq[]>([]);
  const [status, setStatus] = useState<string>('pending');
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  // Per-row approve form state.
  const [qr, setQr] = useState<string | null>(null);
  const [bankText, setBankText] = useState('');
  const [upi, setUpi] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminApi.get<{ items: DepositReq[] }>(
        `/finance/deposit-requests?status=${status}`,
      );
      setItems(Array.isArray(res?.items) ? res.items : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load requests');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { void load(); }, [load]);

  const openApprove = (id: string) => {
    setOpenId(id);
    setQr(null); setBankText(''); setUpi(''); setNote('');
  };

  const onQrFile = (f: File | null) => {
    if (!f) { setQr(null); return; }
    if (f.size > 3 * 1024 * 1024) { toast.error('QR image too large (max 3MB)'); return; }
    const r = new FileReader();
    r.onload = () => setQr(String(r.result));
    r.onerror = () => toast.error('Could not read image');
    r.readAsDataURL(f);
  };

  const approve = async (id: string) => {
    if (!qr && !bankText.trim() && !upi.trim()) {
      toast.error('Provide a QR, bank details, or UPI id');
      return;
    }
    setBusy(true);
    try {
      await adminApi.post(`/finance/deposit-requests/${id}/approve`, {
        admin_qr: qr,
        admin_bank_text: bankText.trim() || null,
        admin_upi: upi.trim() || null,
        admin_note: note.trim() || null,
      });
      toast.success('Approved — user notified');
      setOpenId(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Approve failed');
    } finally {
      setBusy(false);
    }
  };

  const reject = async (id: string) => {
    const reason = window.prompt('Reason for rejecting (optional):') ?? '';
    setBusy(true);
    try {
      await adminApi.post(`/finance/deposit-requests/${id}/reject`, { admin_note: reason || null });
      toast.success('Request rejected');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Reject failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      <div className="mb-4">
        <h1 className="text-lg font-bold text-text-primary">Deposit Requests</h1>
        <p className="text-xs text-text-tertiary mt-1">Users asking for personal payment details. Approve with a QR / bank / UPI.</p>
      </div>

      <div className="mb-4 flex gap-2">
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(s)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium border ${status === s ? 'border-accent bg-accent/10 text-accent' : 'border-border-primary text-text-secondary hover:bg-bg-hover'}`}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-text-tertiary">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-text-tertiary">No requests.</p>
      ) : (
        <div className="space-y-3">
          {items.map((r) => (
            <div key={r.id} className="rounded-lg border border-border-primary bg-bg-secondary p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text-primary truncate">{r.user_name || r.user_email}</p>
                  <p className="text-xs text-text-tertiary">{r.user_email}</p>
                  <p className="text-xs text-text-secondary mt-1">
                    Amount: <span className="font-mono font-bold">${(r.amount ?? 0).toLocaleString()}</span>
                    {r.created_at && <span className="text-text-tertiary"> · {new Date(r.created_at).toLocaleString()}</span>}
                  </p>
                </div>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${r.status === 'pending' ? 'bg-amber-500/15 text-amber-400' : r.status === 'approved' ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger'}`}>
                  {r.status.toUpperCase()}
                </span>
              </div>

              {r.status === 'pending' && (
                <div className="mt-3">
                  {openId === r.id ? (
                    <div className="space-y-2 rounded-lg border border-border-primary bg-bg-base p-3">
                      <div>
                        <label className="text-xs text-text-secondary block mb-1">QR image (optional, max 3MB)</label>
                        <input type="file" accept="image/*" onChange={(e) => onQrFile(e.target.files?.[0] ?? null)} className="text-xs text-text-secondary" />
                        {qr && <img src={qr} alt="QR preview" className="mt-2 max-h-32 rounded border border-border-primary" />}
                      </div>
                      <textarea value={bankText} onChange={(e) => setBankText(e.target.value)} placeholder="Bank details (account no / IFSC / holder)…" className="w-full text-xs p-2 rounded-md bg-bg-input border border-border-primary h-16 resize-none" />
                      <input value={upi} onChange={(e) => setUpi(e.target.value)} placeholder="UPI ID (optional)" className="w-full text-xs p-2 rounded-md bg-bg-input border border-border-primary" />
                      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note to user (optional)" className="w-full text-xs p-2 rounded-md bg-bg-input border border-border-primary" />
                      <div className="flex gap-2 pt-1">
                        <button type="button" disabled={busy} onClick={() => void approve(r.id)} className="flex-1 rounded-md bg-success/15 text-success border border-success/30 py-1.5 text-xs font-semibold disabled:opacity-50">Send details</button>
                        <button type="button" onClick={() => setOpenId(null)} className="rounded-md border border-border-primary px-3 py-1.5 text-xs text-text-secondary">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <button type="button" onClick={() => openApprove(r.id)} className="rounded-md bg-accent/15 text-accent border border-accent/30 px-3 py-1.5 text-xs font-semibold">Approve + send details</button>
                      <button type="button" disabled={busy} onClick={() => void reject(r.id)} className="rounded-md border border-danger/30 text-danger px-3 py-1.5 text-xs font-semibold disabled:opacity-50">Reject</button>
                    </div>
                  )}
                </div>
              )}

              {r.status === 'approved' && (r.admin_bank_text || r.admin_upi || r.admin_qr) && (
                <div className="mt-2 text-xs text-text-tertiary">
                  Sent: {[r.admin_qr ? 'QR' : null, r.admin_bank_text ? 'bank' : null, r.admin_upi ? 'UPI' : null].filter(Boolean).join(', ')}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
