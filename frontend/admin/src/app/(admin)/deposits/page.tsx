'use client';

import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { adminApi, getAdminApiBase } from '@/lib/api';
import DateField from '@/components/ui/DateField';
import toast from 'react-hot-toast';
import {
  ArrowDownCircle,
  ArrowUpCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  History,
  Loader2,
  X,
  Download,
} from 'lucide-react';
import { downloadAdminReportPdf } from '@/lib/pdf/adminReportPdf';
import { usePermissions } from '@/lib/usePermissions';

type TabId = 'deposits' | 'withdrawals' | 'history';
type StatusFilter = 'pending' | 'approved' | 'rejected' | 'all';

interface Deposit {
  id: string;
  user_id: string;
  user_name: string;
  user_email: string;
  amount: number;
  currency: string;
  method: string;
  transaction_id: string;
  screenshot_url: string;
  status: 'pending' | 'approved' | 'auto_approved' | 'rejected';
  created_at: string;
  note?: string;
  reason?: string;
  // Bonus request fields (migration 0054). bonus_code is the promo
  // string the user typed at deposit time. bonus_status walks through
  // pending → granted | denied.
  bonus_code?: string | null;
  bonus_status?: 'pending' | 'granted' | 'denied' | null;
  bonus_amount?: number | null;
}

interface WithdrawalBankDetails {
  manual?: boolean;
  upi_id?: string | null;
  notes?: string | null;
  user_payout_qr_path?: string | null;
  oxapay_payout?: string;
  [key: string]: unknown;
}

interface Withdrawal {
  id: string;
  user_id: string;
  user_name: string;
  user_email: string;
  amount: number;
  currency: string;
  method: string;
  bank_name?: string;
  account_number?: string;
  ifsc_code?: string;
  bank_details?: WithdrawalBankDetails | null;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  note?: string;
  reason?: string;
}

interface TransactionRecord {
  id: string;
  user_id: string;
  user_name?: string;
  user_email?: string;
  type: string;
  amount: number;
  balance_after?: number;
  description?: string;
  created_at: string;
}

interface ActionModal {
  type: 'approve' | 'reject';
  target: 'deposit' | 'withdrawal';
  id: string;
  userName: string;
  amount: number;
}

const TABS: { id: TabId; label: string; icon: typeof ArrowDownCircle }[] = [
  { id: 'deposits', label: 'Deposits', icon: ArrowDownCircle },
  { id: 'withdrawals', label: 'Withdrawals', icon: ArrowUpCircle },
  { id: 'history', label: 'History', icon: History },
];

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

function statusBadge(status: string) {
  switch (status) {
    case 'approved':
    case 'auto_approved':
      return 'bg-success/15 text-success';
    case 'rejected':
      return 'bg-danger/15 text-danger';
    case 'pending':
      return 'bg-warning/15 text-warning';
    default:
      return 'bg-text-tertiary/15 text-text-tertiary';
  }
}

function statusLabel(status: string) {
  if (status === 'auto_approved') return 'Auto Approved';
  return status;
}

function formatMoney(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(d: string) {
  return new Date(d).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function openAdminBinaryFile(path: string, token: string | null) {
  const res = await fetch(path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error('Failed to load file');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener,noreferrer');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Inline image that loads via auth header, shows thumbnail + click to expand. */
function AuthImage({ src, token, alt, className }: { src: string; token: string | null; alt: string; className?: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(src, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok || cancelled) return;
        const blob = await res.blob();
        if (cancelled) return;
        setBlobUrl(URL.createObjectURL(blob));
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [src, token]);

  if (!blobUrl) return <span className="text-xxs text-text-tertiary">Loading...</span>;

  return (
    <>
      <img
        src={blobUrl}
        alt={alt}
        className={cn('cursor-pointer rounded border border-border-primary bg-white object-contain hover:opacity-80 transition-fast', className || 'w-10 h-10')}
        onClick={() => setExpanded(true)}
      />
      {expanded && (
        <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setExpanded(false)}>
          <div className="relative max-w-[90vw] max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
            <button type="button" onClick={() => setExpanded(false)} className="absolute -top-3 -right-3 z-10 w-8 h-8 rounded-full bg-bg-secondary border border-border-primary flex items-center justify-center text-text-primary hover:bg-sell/20 hover:text-sell">
              <X size={16} />
            </button>
            <img src={blobUrl} alt={alt} className="max-w-[85vw] max-h-[85vh] rounded-lg border border-border-primary shadow-modal object-contain bg-white" />
          </div>
        </div>
      )}
    </>
  );
}

function withdrawalPayoutSummary(w: Withdrawal): string {
  const bd = w.bank_details;
  if (!bd || typeof bd !== 'object') return '—';
  if (bd.oxapay_payout && typeof bd.oxapay_payout === 'string') return bd.oxapay_payout;
  if (bd.manual) {
    const parts: string[] = [];
    if (bd.upi_id) parts.push(`UPI: ${bd.upi_id}`);
    if (bd.notes) parts.push(String(bd.notes));
    if (bd.user_payout_qr_path) parts.push('QR attached');
    return parts.length ? parts.join(' · ') : 'Manual';
  }
  try {
    return JSON.stringify(bd);
  } catch {
    return '—';
  }
}

const PAGE_SIZE = 20;

export default function DepositsPage() {
  // Allow deep-links from the notification bell (e.g. /deposits?tab=withdrawals)
  // to land on the right tab. Reads `?tab=` once on mount; if the value
  // matches a real TabId we honour it, otherwise we fall back to 'deposits'.
  const initialTab: TabId = (() => {
    if (typeof window === 'undefined') return 'deposits';
    const t = new URLSearchParams(window.location.search).get('tab');
    return t === 'withdrawals' || t === 'history' ? (t as TabId) : 'deposits';
  })();
  const [activeTab, setActiveTab] = useState<TabId>(initialTab);
  const { can } = usePermissions();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);

  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [depositsTotal, setDepositsTotal] = useState(0);
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  const [withdrawalsTotal, setWithdrawalsTotal] = useState(0);

  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [transactionsTotal, setTransactionsTotal] = useState(0);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [actionModal, setActionModal] = useState<ActionModal | null>(null);
  const [actionNote, setActionNote] = useState('');
  const [actionReason, setActionReason] = useState('');
  const [verifiedAmount, setVerifiedAmount] = useState('');
  const [actionLoading, setActionLoading] = useState(false);

  const fetchDeposits = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, string> = {
        page: String(page),
        per_page: String(PAGE_SIZE),
      };

      let endpoint: string;
      if (statusFilter === 'pending') {
        endpoint = '/finance/deposits/pending';
      } else {
        endpoint = '/finance/deposits';
        if (statusFilter !== 'all') params.status = statusFilter;
      }
      if (dateFrom) params.start_date = dateFrom;
      if (dateTo) params.end_date = dateTo;

      const res = await adminApi.get<{ items: Deposit[]; total: number }>(
        endpoint,
        params,
      );
      setDeposits(res.items || []);
      setDepositsTotal(res.total || 0);
    } catch (e: any) {
      setError(e.message);
      setDeposits([]);
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter, dateFrom, dateTo]);

  const fetchWithdrawals = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, string> = {
        page: String(page),
        per_page: String(PAGE_SIZE),
      };

      let endpoint: string;
      if (statusFilter === 'pending') {
        endpoint = '/finance/withdrawals/pending';
      } else {
        endpoint = '/finance/withdrawals';
        if (statusFilter !== 'all') params.status = statusFilter;
      }
      if (dateFrom) params.start_date = dateFrom;
      if (dateTo) params.end_date = dateTo;

      const res = await adminApi.get<{ items: Withdrawal[]; total: number }>(
        endpoint,
        params,
      );
      setWithdrawals(res.items || []);
      setWithdrawalsTotal(res.total || 0);
    } catch (e: any) {
      setError(e.message);
      setWithdrawals([]);
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter, dateFrom, dateTo]);

  const fetchTransactions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, string> = {
        page: String(page),
        per_page: String(PAGE_SIZE),
        // Funding History tab = ONLY real deposits + withdrawals. Whitelist
        // (server-side `Transaction.type IN (...)`), so transfers, trade P&L,
        // fees, commissions, bonuses etc. never leak in — robust against any
        // new transaction type (client 2026-06-26).
        only: 'deposit,withdrawal',
      };
      if (dateFrom) params.start_date = dateFrom;
      if (dateTo) params.end_date = dateTo;
      const res = await adminApi.get<{ items: TransactionRecord[]; total: number }>(
        '/transactions', params,
      );
      setTransactions(res.items || []);
      setTransactionsTotal(res.total || 0);
    } catch (e: any) {
      setError(e.message);
      setTransactions([]);
    } finally {
      setLoading(false);
    }
  }, [page, dateFrom, dateTo]);

  useEffect(() => {
    if (activeTab === 'deposits') fetchDeposits();
    else if (activeTab === 'withdrawals') fetchWithdrawals();
    else fetchTransactions();
  }, [activeTab, fetchDeposits, fetchWithdrawals, fetchTransactions]);

  useEffect(() => {
    setPage(1);
  }, [activeTab, statusFilter, dateFrom, dateTo]);

  const handleAction = async () => {
    if (!actionModal) return;
    if (actionModal.type === 'reject' && !actionReason.trim()) {
      toast.error('Reason is required for rejection');
      return;
    }

    setActionLoading(true);
    try {
      const basePath =
        actionModal.target === 'deposit'
          ? `/finance/deposits/${actionModal.id}`
          : `/finance/withdrawals/${actionModal.id}`;

      if (actionModal.type === 'approve') {
        // For deposit approvals the admin confirms the amount actually
        // received (proof-verified), which may differ from the figure
        // the user typed. We credit THAT, not the user-claimed value
        // (audit H1). Withdrawals carry no verified-amount concept.
        let verified: number | undefined;
        if (actionModal.target === 'deposit') {
          const v = parseFloat(verifiedAmount);
          if (!Number.isFinite(v) || v <= 0) {
            toast.error('Enter the verified amount received (must be greater than 0)');
            setActionLoading(false);
            return;
          }
          verified = v;
        }
        // Every deposit/withdrawal approval now needs a 2nd super-admin
        // sign-off (any amount). The backend returns HTTP 202 with
        // detail.code='approval_required' on the first (authority-admin)
        // approval — the money is NOT moved yet; a super admin must approve
        // it in /approvals. adminApi treats 202 as success and returns the
        // body, so we branch on the code.
        const resp: any = await adminApi.post(`${basePath}/approve`, {
          note: actionNote.trim() || undefined,
          verified_amount: verified,
        });
        if (resp?.detail?.code === 'approval_required') {
          toast.success(
            'Sent for super-admin approval. It will be credited once a super admin approves it in /approvals.',
            { duration: 6000 },
          );
        } else {
          toast.success('Approved successfully');
        }
      } else {
        await adminApi.post(`${basePath}/reject`, {
          reason: actionReason.trim(),
        });
        toast.success('Rejected successfully');
      }

      setActionModal(null);
      setActionNote('');
      setActionReason('');
      setVerifiedAmount('');

      if (activeTab === 'deposits') fetchDeposits();
      else fetchWithdrawals();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setActionLoading(false);
    }
  };

  const currentItems = activeTab === 'deposits' ? deposits : activeTab === 'withdrawals' ? withdrawals : transactions;
  const currentTotal = activeTab === 'deposits' ? depositsTotal : activeTab === 'withdrawals' ? withdrawalsTotal : transactionsTotal;
  const totalPages = Math.max(1, Math.ceil(currentTotal / PAGE_SIZE));

  // Export the CURRENT tab's list (deposits or withdrawals) to PDF, honouring
  // the status + date-range filters above, with totals (client 2026-06-19).
  const downloadReport = () => {
    const isWd = activeTab === 'withdrawals';
    const list: Array<Deposit | Withdrawal> = isWd ? withdrawals : deposits;
    if (!list.length) { toast.error('Nothing to export for the current filters'); return; }
    const total = list.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const period = (dateFrom || dateTo) ? `${dateFrom || 'start'} → ${dateTo || 'today'}` : 'All time';
    void downloadAdminReportPdf(
      isWd ? 'Withdrawals report' : 'Deposits report',
      [
        { header: 'Date', width: 34 },
        { header: 'User', width: 44 },
        { header: 'Email', width: 56 },
        { header: 'Method', width: 28 },
        { header: 'Amount (USD)', width: 28, align: 'right', mono: true },
        { header: 'Status', width: 24 },
      ],
      list.map((r) => [
        formatDate(r.created_at),
        r.user_name || '—',
        r.user_email || '—',
        r.method || '—',
        `$${(Number(r.amount) || 0).toFixed(2)}`,
        r.status,
      ]),
      {
        subtitle: `${isWd ? 'Withdrawals' : 'Deposits'} · status: ${statusFilter}`,
        periodLabel: period,
        summaryLines: [
          `Total ${isWd ? 'withdrawals' : 'deposits'} shown: $${total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
          `Count: ${list.length}`,
        ],
        filename: isWd ? 'withdrawals-report' : 'deposits-report',
      },
    );
  };

  return (
    <>
      <div className="p-6 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-text-primary">Deposits & Withdrawals</h1>
            <p className="text-xxs text-text-tertiary mt-0.5">
              Review and manage funding requests
            </p>
          </div>
          {activeTab !== 'history' && (
            <button
              type="button"
              onClick={downloadReport}
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-border-primary bg-bg-secondary text-text-primary hover:bg-bg-hover transition-fast"
              title="Download the current list (filters + dates applied) as PDF"
            >
              <Download size={14} className="text-buy" /> Download PDF
            </button>
          )}
        </div>

        <div className="bg-bg-secondary border border-border-primary rounded-md">
          {/* Tabs */}
          <div className="flex items-center justify-between border-b border-border-primary">
            <div className="flex gap-1 p-1">
              {TABS.map((t) => {
                const Icon = t.icon;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setActiveTab(t.id)}
                    className={cn(
                      'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-fast',
                      activeTab === t.id
                        ? 'bg-bg-hover text-text-primary border border-border-primary'
                        : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover/60',
                    )}
                  >
                    <Icon size={13} />
                    {t.label}
                  </button>
                );
              })}
            </div>

            <div className="pr-3 flex items-center gap-3 flex-wrap justify-end py-1">
              {/* Custom date range — applies to all tabs (filters created_at) */}
              <div className="flex items-center gap-1.5">
                <span className="text-xxs text-text-tertiary">From</span>
                <DateField value={dateFrom} max={dateTo || undefined} onChange={setDateFrom} />
                <span className="text-xxs text-text-tertiary">To</span>
                <DateField value={dateTo} min={dateFrom || undefined} onChange={setDateTo} />
                {(dateFrom || dateTo) && (
                  <button
                    type="button"
                    onClick={() => { setDateFrom(''); setDateTo(''); }}
                    className="text-xxs text-text-tertiary hover:text-text-primary underline"
                  >
                    Clear
                  </button>
                )}
              </div>

              {/* Status filter — hide for history tab */}
              <div className={cn('flex items-center gap-2', activeTab === 'history' && 'hidden')}>
                <span className="text-xxs text-text-tertiary">Status:</span>
                <div className="relative">
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                    className="text-xs py-1 pl-2 pr-7 appearance-none bg-bg-input border border-border-primary rounded-md text-text-primary"
                  >
                    {STATUS_FILTERS.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    size={12}
                    className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Content */}
          <div className="p-0">
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 size={20} className="animate-spin text-text-tertiary" />
              </div>
            ) : error ? (
              <div className="text-center py-16 text-xs text-danger">{error}</div>
            ) : currentItems.length === 0 ? (
              <div className="text-center py-16 text-xs text-text-tertiary">
                No {activeTab} found
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  {activeTab === 'deposits' ? (
                    <table className="w-full min-w-[1000px]" data-tab="deposits">
                      <thead>
                        <tr className="border-b border-border-primary bg-bg-tertiary/40">
                          {[
                            'ID',
                            'User',
                            'Amount',
                            'Method',
                            'Transaction ID',
                            'Screenshot',
                            'Status',
                            'Bonus',
                            'Date',
                            'Actions',
                          ].map((col) => (
                            <th
                              key={col}
                              className={cn(
                                'text-left px-4 py-2.5 text-xxs font-medium text-text-tertiary uppercase tracking-wide',
                                col === 'Amount' && 'text-right',
                                col === 'Actions' && 'text-right',
                              )}
                            >
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {deposits.map((d) => (
                          <tr
                            key={d.id}
                            className="border-b border-border-primary/50 transition-fast hover:bg-bg-hover"
                          >
                            <td className="px-4 py-2.5 text-xs text-text-secondary font-mono tabular-nums">
                              {d.id}
                            </td>
                            <td className="px-4 py-2.5">
                              <p className="text-xs text-text-primary">{d.user_name}</p>
                              <p className="text-xxs text-text-tertiary">{d.user_email}</p>
                            </td>
                            <td className="px-4 py-2.5 text-xs text-text-primary text-right font-mono tabular-nums">
                              ${formatMoney(d.amount)}
                            </td>
                            <td className="px-4 py-2.5 text-xs text-text-secondary">{d.method}</td>
                            <td className="px-4 py-2.5 text-xs text-text-secondary font-mono tabular-nums">
                              {d.transaction_id}
                            </td>
                            <td className="px-4 py-2.5">
                              {d.screenshot_url ? (
                                <AuthImage
                                  src={`${getAdminApiBase()}/finance/deposits/${d.id}/screenshot`}
                                  token={adminApi.getToken()}
                                  alt={`Deposit proof ${d.id}`}
                                  className="w-12 h-12"
                                />
                              ) : (
                                <span className="text-xxs text-text-tertiary">—</span>
                              )}
                            </td>
                            <td className="px-4 py-2.5">
                              <span
                                className={cn(
                                  'inline-flex px-1.5 py-0.5 rounded-sm text-xxs font-medium capitalize',
                                  statusBadge(d.status),
                                )}
                              >
                                {statusLabel(d.status)}
                              </span>
                            </td>
                            <td className="px-4 py-2.5">
                              {d.bonus_code ? (
                                <div className="flex flex-col gap-1 items-start">
                                  <span className="text-xxs font-mono font-semibold text-accent">
                                    {d.bonus_code}
                                  </span>
                                  <span
                                    className={cn(
                                      'inline-flex px-1.5 py-0.5 rounded-sm text-[10px] font-medium capitalize',
                                      d.bonus_status === 'granted'
                                        ? 'bg-success/15 text-success'
                                        : d.bonus_status === 'denied'
                                          ? 'bg-danger/15 text-danger'
                                          : 'bg-warning/15 text-warning',
                                    )}
                                  >
                                    {d.bonus_status || 'pending'}
                                    {d.bonus_amount != null && d.bonus_status === 'granted' && (
                                      <> · ${formatMoney(d.bonus_amount)}</>
                                    )}
                                  </span>
                                  {/* Grant/Deny inline buttons removed —
                                      two action pairs in the same row
                                      (Grant/Deny + Approve/Reject) were
                                      confusing for ops. The bonus pill
                                      stays so admin still sees the code +
                                      pending state; the deposit Approve /
                                      Reject column below now drives both
                                      decisions. */}
                                </div>
                              ) : (
                                <span className="text-xxs text-text-tertiary">—</span>
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-xs text-text-tertiary font-mono tabular-nums whitespace-nowrap">
                              {formatDate(d.created_at)}
                            </td>
                            <td className="px-4 py-2.5 text-right">
                              {d.status === 'pending' && (can('deposits.approve') || can('deposits.reject')) && (
                                <div className="flex items-center justify-end gap-1.5">
                                  {can('deposits.approve') && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setVerifiedAmount(String(d.amount));
                                      setActionModal({
                                        type: 'approve',
                                        target: 'deposit',
                                        id: d.id,
                                        userName: d.user_name,
                                        amount: d.amount,
                                      });
                                    }}
                                    className="px-2 py-1 rounded-md text-xxs font-medium bg-success/15 text-success border border-success/30 hover:bg-success/25 transition-fast"
                                  >
                                    Approve
                                  </button>
                                  )}
                                  {can('deposits.reject') && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setActionModal({
                                        type: 'reject',
                                        target: 'deposit',
                                        id: d.id,
                                        userName: d.user_name,
                                        amount: d.amount,
                                      })
                                    }
                                    className="px-2 py-1 rounded-md text-xxs font-medium bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25 transition-fast"
                                  >
                                    Reject
                                  </button>
                                  )}
                                </div>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : activeTab === 'withdrawals' ? (
                    <table className="w-full min-w-[1000px]">
                      <thead>
                        <tr className="border-b border-border-primary bg-bg-tertiary/40">
                          {[
                            'ID',
                            'User',
                            'Amount',
                            'Method',
                            'Bank Details',
                            'Status',
                            'Date',
                            'Actions',
                          ].map((col) => (
                            <th
                              key={col}
                              className={cn(
                                'text-left px-4 py-2.5 text-xxs font-medium text-text-tertiary uppercase tracking-wide',
                                col === 'Amount' && 'text-right',
                                col === 'Actions' && 'text-right',
                              )}
                            >
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {withdrawals.map((w) => (
                          <tr
                            key={w.id}
                            className="border-b border-border-primary/50 transition-fast hover:bg-bg-hover"
                          >
                            <td className="px-4 py-2.5 text-xs text-text-secondary font-mono tabular-nums">
                              {w.id}
                            </td>
                            <td className="px-4 py-2.5">
                              <p className="text-xs text-text-primary">{w.user_name}</p>
                              <p className="text-xxs text-text-tertiary">{w.user_email}</p>
                            </td>
                            <td className="px-4 py-2.5 text-xs text-sell text-right font-mono tabular-nums">
                              -${formatMoney(w.amount)}
                            </td>
                            <td className="px-4 py-2.5 text-xs text-text-secondary">{w.method}</td>
                            <td className="px-4 py-2.5 max-w-[280px]">
                              <p className="text-xs text-text-primary break-words">{withdrawalPayoutSummary(w)}</p>
                              {w.bank_details?.user_payout_qr_path ? (
                                <div className="mt-1">
                                  <AuthImage
                                    src={`${getAdminApiBase()}/finance/withdrawals/${w.id}/payout-qr`}
                                    token={adminApi.getToken()}
                                    alt={`Payout QR ${w.id}`}
                                    className="w-10 h-10"
                                  />
                                </div>
                              ) : null}
                            </td>
                            <td className="px-4 py-2.5">
                              <span
                                className={cn(
                                  'inline-flex px-1.5 py-0.5 rounded-sm text-xxs font-medium capitalize',
                                  statusBadge(w.status),
                                )}
                              >
                                {w.status}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 text-xs text-text-tertiary font-mono tabular-nums whitespace-nowrap">
                              {formatDate(w.created_at)}
                            </td>
                            <td className="px-4 py-2.5 text-right">
                              {w.status === 'pending' && (can('withdrawals.approve') || can('withdrawals.reject')) && (
                                <div className="flex items-center justify-end gap-1.5">
                                  {can('withdrawals.approve') && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setActionModal({
                                        type: 'approve',
                                        target: 'withdrawal',
                                        id: w.id,
                                        userName: w.user_name,
                                        amount: w.amount,
                                      })
                                    }
                                    className="px-2 py-1 rounded-md text-xxs font-medium bg-success/15 text-success border border-success/30 hover:bg-success/25 transition-fast"
                                  >
                                    Approve
                                  </button>
                                  )}
                                  {can('withdrawals.reject') && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setActionModal({
                                        type: 'reject',
                                        target: 'withdrawal',
                                        id: w.id,
                                        userName: w.user_name,
                                        amount: w.amount,
                                      })
                                    }
                                    className="px-2 py-1 rounded-md text-xxs font-medium bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25 transition-fast"
                                  >
                                    Reject
                                  </button>
                                  )}
                                </div>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : activeTab === 'history' ? (
                    <table className="w-full min-w-[800px]">
                      <thead>
                        <tr className="border-b border-border-primary bg-bg-tertiary/40">
                          {['Type', 'User', 'Amount', 'Description', 'Date'].map(
                            (h) => (
                              <th
                                key={h}
                                className="px-3 py-2 text-left text-xxs font-semibold text-text-tertiary uppercase tracking-wider"
                              >
                                {h}
                              </th>
                            ),
                          )}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border-primary">
                        {(transactions as TransactionRecord[]).map((t) => {
                          const isPositive = t.amount >= 0;
                          // Generic "adjustment" rows carry the real reason in
                          // `description` (e.g. "Manual credit", "Insurance payout").
                          // Show that name instead of the bare type (client 2026-06-20).
                          const _desc = (t.description || '').trim();
                          const typeLabel = t.type === 'admin_commission' ? 'Admin Commission'
                            : t.type === 'ib_commission' ? 'Master Fee'
                            : t.type === 'commission' ? 'Performance Fee'
                            : t.type === 'deposit' ? 'Deposit'
                            : t.type === 'withdrawal' ? 'Withdrawal'
                            : t.type === 'adjustment'
                              ? (_desc && _desc.toLowerCase() !== 'adjustment' ? _desc : 'Adjustment')
                              : (_desc && _desc.toLowerCase() !== t.type.toLowerCase() ? _desc : t.type.replace(/_/g, ' '));
                          const typeBadge = t.type === 'admin_commission' ? 'bg-purple-500/15 text-purple-600'
                            : t.type === 'ib_commission' ? 'bg-blue-500/15 text-blue-600'
                            : t.type === 'deposit' ? 'bg-success/15 text-success'
                            : t.type === 'withdrawal' ? 'bg-danger/15 text-danger'
                            : 'bg-text-tertiary/15 text-text-tertiary';
                          return (
                            <tr key={t.id} className="hover:bg-bg-hover/40 transition-fast">
                              <td className="px-3 py-2.5">
                                <span className={cn('inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold capitalize', typeBadge)}>
                                  {typeLabel}
                                </span>
                              </td>
                              <td className="px-3 py-2.5 text-xs">
                                <div className="font-medium text-text-primary">{t.user_name || '—'}</div>
                                <div className="text-text-tertiary text-[10px]">{t.user_email || t.user_id?.slice(0, 8)}</div>
                              </td>
                              <td className="px-3 py-2.5 text-xs font-mono font-semibold">
                                <span className={isPositive ? 'text-success' : 'text-danger'}>
                                  {isPositive ? '+' : ''}{formatMoney(t.amount)}
                                </span>
                              </td>
                              <td className="px-3 py-2.5 text-xs text-text-secondary max-w-[300px] truncate">
                                {t.description || '—'}
                              </td>
                              <td className="px-3 py-2.5 text-xxs text-text-tertiary whitespace-nowrap">
                                {formatDate(t.created_at)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  ) : null}
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="px-4 py-3 border-t border-border-primary flex items-center justify-between">
                    <p className="text-xxs text-text-tertiary">
                      Showing {(page - 1) * PAGE_SIZE + 1}–
                      {Math.min(page * PAGE_SIZE, currentTotal)} of {currentTotal}
                    </p>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        disabled={page <= 1}
                        onClick={() => setPage((p) => p - 1)}
                        className="p-1.5 rounded-md border border-border-primary text-text-secondary hover:bg-bg-hover disabled:opacity-30 disabled:pointer-events-none transition-fast"
                      >
                        <ChevronLeft size={14} />
                      </button>
                      <span className="px-2 text-xs text-text-secondary font-mono tabular-nums">
                        {page} / {totalPages}
                      </span>
                      <button
                        type="button"
                        disabled={page >= totalPages}
                        onClick={() => setPage((p) => p + 1)}
                        className="p-1.5 rounded-md border border-border-primary text-text-secondary hover:bg-bg-hover disabled:opacity-30 disabled:pointer-events-none transition-fast"
                      >
                        <ChevronRight size={14} />
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Action modal */}
      {actionModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md bg-bg-secondary border border-border-primary rounded-md shadow-modal animate-fade-in">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border-primary">
              <h2 className="text-sm font-semibold text-text-primary capitalize">
                {actionModal.type} {actionModal.target}
              </h2>
              <button
                type="button"
                onClick={() => {
                  setActionModal(null);
                  setActionNote('');
                  setActionReason('');
                  setVerifiedAmount('');
                }}
                className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-fast"
              >
                <X size={16} />
              </button>
            </div>

            <div className="p-4 space-y-4">
              <div className="p-3 rounded-md bg-bg-tertiary border border-border-primary">
                <p className="text-xxs text-text-tertiary">User</p>
                <p className="text-xs text-text-primary font-medium">{actionModal.userName}</p>
                <p className="text-xxs text-text-tertiary mt-2">Amount</p>
                <p className="text-sm text-text-primary font-mono tabular-nums">
                  ${formatMoney(actionModal.amount)}
                </p>
              </div>

              {actionModal.type === 'approve' ? (
                <div className="space-y-4">
                  {actionModal.target === 'deposit' && (
                    <div>
                      <label className="block text-xxs text-text-tertiary mb-1">
                        Verified amount received <span className="text-danger">*</span>
                      </label>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={verifiedAmount}
                        onChange={(e) => setVerifiedAmount(e.target.value)}
                        placeholder="Amount confirmed from proof"
                        className="w-full px-3 py-2 text-xs bg-bg-input border border-border-primary rounded-md placeholder:text-text-tertiary transition-fast focus:border-buy font-mono tabular-nums"
                      />
                      <p className="text-xxs text-text-tertiary mt-1">
                        This amount is credited — not the user-claimed figure. Confirm against the deposit proof.
                      </p>
                    </div>
                  )}
                  <div>
                    <label className="block text-xxs text-text-tertiary mb-1">
                      Note (optional)
                    </label>
                    <textarea
                      value={actionNote}
                      onChange={(e) => setActionNote(e.target.value)}
                      rows={3}
                      placeholder="Add an optional note..."
                      className="w-full px-3 py-2 text-xs bg-bg-input border border-border-primary rounded-md placeholder:text-text-tertiary transition-fast focus:border-buy resize-none"
                    />
                  </div>
                </div>
              ) : (
                <div>
                  <label className="block text-xxs text-text-tertiary mb-1">
                    Reason <span className="text-danger">*</span>
                  </label>
                  <textarea
                    value={actionReason}
                    onChange={(e) => setActionReason(e.target.value)}
                    rows={3}
                    placeholder="Provide a reason for rejection..."
                    className="w-full px-3 py-2 text-xs bg-bg-input border border-border-primary rounded-md placeholder:text-text-tertiary transition-fast focus:border-buy resize-none"
                  />
                </div>
              )}
            </div>

            <div className="px-4 py-3 border-t border-border-primary flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setActionModal(null);
                  setActionNote('');
                  setActionReason('');
                  setVerifiedAmount('');
                }}
                className="px-3 py-1.5 text-xs text-text-secondary border border-border-primary rounded-md hover:bg-bg-hover transition-fast"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={actionLoading}
                onClick={handleAction}
                className={cn(
                  'px-3 py-1.5 text-xs font-medium rounded-md transition-fast inline-flex items-center gap-1.5',
                  actionModal.type === 'approve'
                    ? 'bg-success text-white hover:bg-success/80'
                    : 'bg-danger text-white hover:bg-danger/80',
                  actionLoading && 'opacity-50 pointer-events-none',
                )}
              >
                {actionLoading && <Loader2 size={12} className="animate-spin" />}
                {actionModal.type === 'approve' ? 'Confirm Approval' : 'Confirm Rejection'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
