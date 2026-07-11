'use client';

/**
 * RM Manual Requests — the trader-submitted "Request to RM" deposit/withdraw
 * forms (mail-to-RM). Emails go to the RM, and each request is also persisted
 * here so admin can see + track them. Separate from RM Requests (the two-admin
 * funding approve→credit flow).
 */
import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { adminApi } from '@/lib/api';

interface ManualReq {
  id: string;
  user_id: string | null;
  user_name: string | null;
  user_email: string | null;
  side: string;
  amount: number;
  method: string | null;
  phone: string | null;
  payout_details: string | null;
  note: string | null;
  status: string;
  created_at: string | null;
}

const STATUSES = ['all', 'new', 'contacted', 'done', 'cancelled'] as const;
const NEXT: Record<string, { label: string; to: string }[]> = {
  new: [{ label: 'Mark contacted', to: 'contacted' }, { label: 'Mark done', to: 'done' }, { label: 'Cancel', to: 'cancelled' }],
  contacted: [{ label: 'Mark done', to: 'done' }, { label: 'Cancel', to: 'cancelled' }],
  done: [{ label: 'Reopen', to: 'new' }],
  cancelled: [{ label: 'Reopen', to: 'new' }],
};

const statusColor = (s: string) =>
  s === 'new' ? 'bg-warning/15 text-warning'
    : s === 'contacted' ? 'bg-accent/15 text-accent'
      : s === 'done' ? 'bg-success/15 text-success'
        : 'bg-text-tertiary/15 text-text-tertiary';

const fmt = (n: number) => `$${(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function RmManualRequestsPage() {
  const [rows, setRows] = useState<ManualReq[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await adminApi.get<{ items: ManualReq[] }>('/rm/manual-requests', statusFilter === 'all' ? {} : { status: statusFilter });
      setRows(d.items || []);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);
  useEffect(() => { load(); }, [load]);

  const setStatus = async (id: string, to: string) => {
    setBusy(id);
    try {
      await adminApi.post(`/rm/manual-requests/${id}/status`, { status: to });
      toast.success('Status updated');
      load();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to update');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-6xl">
      <div>
        <h1 className="text-lg font-semibold text-text-primary">RM Manual Requests</h1>
        <p className="text-xxs text-text-tertiary mt-0.5">
          Trader "Request to RM" deposit/withdraw forms. They also email the RM — this is the tracked copy.
        </p>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`text-xs px-3 py-1.5 rounded-md capitalize border ${statusFilter === s ? 'bg-bg-hover text-text-primary border-border-primary' : 'text-text-secondary border-transparent hover:bg-bg-hover/60'}`}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-border-primary bg-bg-secondary overflow-x-auto">
        <table className="w-full text-sm min-w-[860px]">
          <thead>
            <tr className="text-text-tertiary text-xxs uppercase tracking-wide border-b border-border-primary">
              <th className="text-left py-2.5 px-4">Date</th>
              <th className="text-left py-2.5 px-4">User</th>
              <th className="text-left py-2.5 px-4">Type</th>
              <th className="text-right py-2.5 px-4">Amount</th>
              <th className="text-left py-2.5 px-4">Method</th>
              <th className="text-left py-2.5 px-4">Phone</th>
              <th className="text-left py-2.5 px-4">Details / Note</th>
              <th className="text-left py-2.5 px-4">Status</th>
              <th className="text-right py-2.5 px-4">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={9} className="py-8 text-center text-text-tertiary text-xs">Loading…</td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={9} className="py-8 text-center text-text-tertiary text-xs">No requests.</td></tr>}
            {!loading && rows.map((r) => (
              <tr key={r.id} className="border-b border-border-primary/50 align-top">
                <td className="py-2.5 px-4 text-text-secondary whitespace-nowrap">{r.created_at ? new Date(r.created_at).toLocaleString() : '—'}</td>
                <td className="py-2.5 px-4">
                  {r.user_id
                    ? <a href={`/users/${r.user_id}`} className="text-accent hover:underline">{r.user_name || '—'}</a>
                    : <span className="text-text-primary">{r.user_name || '—'}</span>}
                  {r.user_email && <span className="block text-xxs text-text-tertiary">{r.user_email}</span>}
                </td>
                <td className="py-2.5 px-4 capitalize text-text-secondary">{r.side}</td>
                <td className="py-2.5 px-4 text-right font-mono text-text-primary whitespace-nowrap">{fmt(r.amount)}</td>
                <td className="py-2.5 px-4 text-text-secondary">{r.method || '—'}</td>
                <td className="py-2.5 px-4 text-text-secondary whitespace-nowrap">{r.phone || '—'}</td>
                <td className="py-2.5 px-4 text-text-secondary max-w-[220px]">
                  {r.payout_details && <div className="text-xs">{r.payout_details}</div>}
                  {r.note && <div className="text-xxs text-text-tertiary">{r.note}</div>}
                  {!r.payout_details && !r.note && '—'}
                </td>
                <td className="py-2.5 px-4"><span className={`text-xxs px-2 py-0.5 rounded-full capitalize ${statusColor(r.status)}`}>{r.status}</span></td>
                <td className="py-2.5 px-4 text-right whitespace-nowrap">
                  <div className="inline-flex flex-col gap-1 items-end">
                    {(NEXT[r.status] || []).map((a) => (
                      <button
                        key={a.to}
                        disabled={busy === r.id}
                        onClick={() => setStatus(r.id, a.to)}
                        className="text-xxs px-2 py-1 rounded-md border border-border-primary text-text-secondary hover:bg-bg-hover disabled:opacity-50"
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
