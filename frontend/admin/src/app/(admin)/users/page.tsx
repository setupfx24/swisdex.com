'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { adminApi } from '@/lib/api';
import DateField from '@/components/ui/DateField';
import toast from 'react-hot-toast';
import Link from 'next/link';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Ban,
  Calendar,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  DollarSign,
  Download,
  Eye,
  Loader2,
  LogIn,
  Minus,
  MoreHorizontal,
  Plus,
  Power,
  Search,
  ShieldOff,
  Trash2,
  UserRound,
  UserCheck,
  PauseCircle,
  XCircle,
  Archive,
  X,
} from 'lucide-react';
import { downloadAdminReportPdf } from '@/lib/pdf/adminReportPdf';

/** YYYY-MM-DD in local time (avoids the UTC-shift `toISOString()` pitfall). */
function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

type DatePresetKey = 'today' | 'yesterday' | 'day_before' | 'last_7' | 'last_30';

function datePresetRange(key: DatePresetKey): [string, string] {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const dayBefore = new Date(today); dayBefore.setDate(dayBefore.getDate() - 2);
  const last7Start = new Date(today); last7Start.setDate(last7Start.getDate() - 6);
  const last30Start = new Date(today); last30Start.setDate(last30Start.getDate() - 29);
  switch (key) {
    case 'today':       return [ymd(today), ymd(today)];
    case 'yesterday':   return [ymd(yesterday), ymd(yesterday)];
    case 'day_before':  return [ymd(dayBefore), ymd(dayBefore)];
    case 'last_7':      return [ymd(last7Start), ymd(today)];
    case 'last_30':     return [ymd(last30Start), ymd(today)];
  }
}

const DATE_PRESETS: { key: DatePresetKey; label: string }[] = [
  { key: 'today',      label: 'Today' },
  { key: 'yesterday',  label: 'Yesterday' },
  { key: 'day_before', label: 'Day Before' },
  { key: 'last_7',     label: 'Last 7 days' },
  { key: 'last_30',    label: 'Last 30 days' },
];

interface User {
  id: string;
  name: string;
  email: string;
  /** Total: main wallet + sum of trading account balances */
  balance: number;
  /** Total: main wallet + sum of trading account equity */
  equity: number;
  main_wallet_balance?: number;
  trading_balance?: number;
  trading_equity?: number;
  group: string;
  kyc_status: string;
  status: string;
}

interface UsersResponse {
  users: User[];
  total: number;
  page: number;
  pages: number;
}

type SortKey = keyof Pick<User, 'id' | 'name' | 'email' | 'balance' | 'equity' | 'group' | 'kyc_status' | 'status'>;
type SortDir = 'asc' | 'desc';
type FundAction = 'add-fund' | 'deduct-fund' | 'give-credit' | 'take-credit';

// Sentinel select-value representing the user's main wallet for deduct-fund.
const MAIN_WALLET_ID = '__main_wallet__';
type ModalType = FundAction | 'ban' | 'unban' | 'kill-switch' | 'delete' | null;

const FUND_LABELS: Record<FundAction, string> = {
  'add-fund': 'Add Fund',
  'deduct-fund': 'Deduct Fund',
  'give-credit': 'Give Credit',
  'take-credit': 'Take Credit',
};

function formatMoney(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function statusBadge(s: string) {
  switch (s?.toLowerCase()) {
    case 'active': return 'bg-success/15 text-success';
    case 'banned': case 'suspended': return 'bg-danger/15 text-danger';
    case 'pending': return 'bg-warning/15 text-warning';
    default: return 'bg-text-tertiary/15 text-text-tertiary';
  }
}

function kycBadge(k: string) {
  switch (k?.toLowerCase()) {
    case 'verified': case 'approved': return 'bg-success/15 text-success';
    case 'pending': return 'bg-warning/15 text-warning';
    case 'rejected': return 'bg-danger/15 text-danger';
    default: return 'bg-text-tertiary/15 text-text-tertiary';
  }
}

function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center py-4 animate-fade-in">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-bg-secondary border border-border-primary rounded-t-xl sm:rounded-xl shadow-modal w-full sm:max-w-lg sm:mx-4 p-6 animate-slide-down max-h-[90vh] overflow-y-auto overscroll-contain">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-base font-bold text-text-primary">{title}</h3>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-bg-hover transition-fast text-text-tertiary hover:text-text-primary">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="animate-pulse">
      {Array.from({ length: 10 }).map((_, i) => (
        <div key={i} className="flex items-center gap-5 px-5 py-5 border-b border-border-primary/30">
          <div className="h-4 w-20 bg-bg-hover rounded" />
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-bg-hover rounded-full" />
            <div className="h-4 w-28 bg-bg-hover rounded" />
          </div>
          <div className="h-4 w-40 bg-bg-hover rounded" />
          <div className="h-4 w-24 bg-bg-hover rounded ml-auto" />
          <div className="h-4 w-24 bg-bg-hover rounded" />
          <div className="h-4 w-14 bg-bg-hover rounded" />
          <div className="h-6 w-16 bg-bg-hover rounded" />
          <div className="h-6 w-16 bg-bg-hover rounded" />
          <div className="h-9 w-9 bg-bg-hover rounded-lg" />
        </div>
      ))}
    </div>
  );
}

const COLUMNS: { key: SortKey; label: string; align?: 'right' }[] = [
  { key: 'id', label: 'ID' },
  { key: 'name', label: 'Name' },
  { key: 'email', label: 'Email' },
  { key: 'balance', label: 'Balance', align: 'right' },
  { key: 'equity', label: 'Equity', align: 'right' },
  { key: 'group', label: 'Group' },
  { key: 'kyc_status', label: 'KYC' },
  { key: 'status', label: 'Status' },
];

export default function UsersPage() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [kycFilter, setKycFilter] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  // Created-at date range. Empty strings = no filter (default — show all).
  // Backend: created_at between [date_from 00:00 UTC, date_to 23:59:59 UTC].
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [activeDatePreset, setActiveDatePreset] = useState<DatePresetKey | 'custom' | null>(null);
  const [page, setPage] = useState(1);
  const [users, setUsers] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [openActionsId, setOpenActionsId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Dual-approval threshold — admin-editable in Settings. Used to show the
  // real limit in the Add/Deduct Fund modal instead of a hard-coded $1,000
  // (client 2026-06-24). Falls back to 1000 if Settings aren't readable.
  const [dualThreshold, setDualThreshold] = useState(1000);
  useEffect(() => {
    adminApi.get<{ key: string; value: unknown }[]>('/settings')
      .then((rows) => {
        const row = Array.isArray(rows) ? rows.find((r) => r.key === 'dual_approval_threshold_usd') : undefined;
        const n = row ? Number(row.value) : NaN;
        if (Number.isFinite(n) && n >= 0) setDualThreshold(n);
      })
      .catch(() => { /* no settings access → keep default */ });
  }, []);

  // Effective permissions of the logged-in admin/employee — drives which
  // actions appear in the 3-dot menu. A limited employee must NOT see (or be
  // tempted to click) Ban / Kill-switch / Terminate / Delete etc. they have no
  // permission for (client 2026-06-19). super_admin gets "*" = everything.
  const [perms, setPerms] = useState<string[]>([]);
  useEffect(() => {
    adminApi.get<{ permissions?: string[] }>('/auth/me')
      .then((m) => setPerms(m?.permissions || []))
      .catch(() => setPerms([]));
  }, []);
  const can = (perm?: string) => !perm || perms.includes('*') || perms.includes(perm);

  // After the actions menu mounts, measure its REAL height and nudge it up if
  // it overflows the viewport bottom — otherwise the long menu's last items
  // (Soft Delete / Delete Permanently) get pushed off-screen. The estimate in
  // toggleActions can't know the exact height (it varies: reactivate vs
  // suspend+terminate), so we correct it here. Guard prevents a re-render loop.
  useLayoutEffect(() => {
    if (!openActionsId || !menuPos || !menuRef.current) return;
    const margin = 8;
    const h = menuRef.current.offsetHeight;
    const maxTop = window.innerHeight - h - margin;
    const clamped = Math.max(margin, Math.min(menuPos.top, maxTop));
    if (Math.abs(clamped - menuPos.top) > 1) {
      setMenuPos((p) => (p ? { ...p, top: clamped } : p));
    }
  }, [openActionsId, menuPos]);

  const [modalType, setModalType] = useState<ModalType>(null);
  const [modalUser, setModalUser] = useState<User | null>(null);
  const [modalAmount, setModalAmount] = useState('');
  const [modalReason, setModalReason] = useState('');
  const [modalClosePositions, setModalClosePositions] = useState(true);
  const [modalSubmitting, setModalSubmitting] = useState(false);
  const [modalAccounts, setModalAccounts] = useState<{ id: string; account_number: string; balance: number; currency: string }[]>([]);
  const [modalAccountId, setModalAccountId] = useState('');
  const [loadingAccounts, setLoadingAccounts] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 400);
    return () => clearTimeout(t);
  }, [search]);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = { page: String(page), limit: '20' };
      if (debouncedSearch) params.search = debouncedSearch;
      if (statusFilter) params.status = statusFilter;
      if (kycFilter) params.kyc_status = kycFilter;
      if (dateFrom) params.date_from = dateFrom;
      if (dateTo) params.date_to = dateTo;
      const data = await adminApi.get<UsersResponse>('/users', params);
      setUsers(data.users || []);
      setTotal(data.total || 0);
      setPages(data.pages || 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch, statusFilter, kycFilter, dateFrom, dateTo]);

  const applyDatePreset = (key: DatePresetKey) => {
    const [s, e] = datePresetRange(key);
    setDateFrom(s); setDateTo(e); setActiveDatePreset(key); setPage(1);
  };
  const clearDateRange = () => {
    setDateFrom(''); setDateTo(''); setActiveDatePreset(null); setPage(1);
  };

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpenActionsId(null);
        setMenuPos(null);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const sorted = useMemo(() => {
    if (!sortKey) return users;
    return [...users].sort((a, b) => {
      const va = a[sortKey], vb = b[sortKey];
      if (typeof va === 'number' && typeof vb === 'number') return sortDir === 'asc' ? va - vb : vb - va;
      return sortDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
    });
  }, [users, sortKey, sortDir]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  };

  const toggleActions = (userId: string, e: React.MouseEvent<HTMLButtonElement>) => {
    if (openActionsId === userId) {
      setOpenActionsId(null);
      setMenuPos(null);
    } else {
      const btn = e.currentTarget;
      const rect = btn.getBoundingClientRect();
      const menuW = 190;
      // Generous estimate for the full menu (~12 items + dividers). The exact
      // height is corrected after mount by the useLayoutEffect above; this just
      // gets the initial placement close so there's no visible jump.
      const menuH = 470;
      const margin = 8;

      // Anchor horizontally to the STATUS cell (the td immediately before the
      // action cell) so the menu always sits over the STATUS column and stays
      // inside the viewport regardless of table scroll position.
      const row = btn.closest('tr');
      const statusCell = row?.querySelectorAll('td') ?? [];
      const statusRect =
        statusCell.length >= 2
          ? (statusCell[statusCell.length - 2] as HTMLElement).getBoundingClientRect()
          : null;

      let left = statusRect ? statusRect.left : rect.left - menuW - margin;
      // Clamp strictly inside the viewport.
      left = Math.max(margin, Math.min(window.innerWidth - menuW - margin, left));

      // Open ABOVE the 3-dot button by default. Fall back to below only if the
      // menu wouldn't fit above the viewport top.
      let top = rect.top - menuH - margin;
      if (top < margin) {
        top = Math.min(rect.bottom + margin, window.innerHeight - menuH - margin);
        top = Math.max(margin, top);
      }

      setMenuPos({ top, left });
      setOpenActionsId(userId);
    }
  };

  const openModal = async (type: ModalType, user: User) => {
    setModalType(type);
    setModalUser(user);
    setModalAmount('');
    setModalReason('');
    setModalClosePositions(true);
    setModalAccounts([]);
    setModalAccountId('');
    setOpenActionsId(null);
    setMenuPos(null);

    // add-fund goes to main wallet — no account selector needed
    if (type && isFundAction(type) && type !== 'add-fund') {
      setLoadingAccounts(true);
      try {
        const detail = await adminApi.get<{ accounts: { id: string; account_number: string; balance: number; currency: string; is_demo?: boolean }[] }>(`/users/${user.id}`);
        const accs = detail.accounts || [];
        setModalAccounts(accs);
        // Default to Main Wallet for deduct-fund (matches prior main-first behavior).
        // Give/take credit must target a trading account.
        if (type === 'deduct-fund') {
          setModalAccountId(MAIN_WALLET_ID);
        } else {
          const live = accs.find((a: any) => !a.is_demo) || accs[0];
          if (live) setModalAccountId(live.id);
        }
      } catch {
        toast.error('Failed to load user accounts');
      } finally {
        setLoadingAccounts(false);
      }
    }
  };

  const closeModal = () => {
    setModalType(null);
    setModalUser(null);
    setModalAccounts([]);
    setModalAccountId('');
  };

  const submitFundAction = async () => {
    if (!modalUser || !modalType) return;
    // For add-fund: no account needed (goes to main wallet)
    // For deduct-fund: account_id is optional (tries main wallet first)
    if (modalType === 'deduct-fund' && !modalAccountId) { toast.error('Select an account'); return; }
    const amt = parseFloat(modalAmount);
    if (isNaN(amt) || amt <= 0) { toast.error('Enter a valid amount'); return; }
    setModalSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        amount: amt,
        description: modalReason || undefined,
      };
      if (modalType === 'deduct-fund') {
        // Main wallet vs trading account is an explicit choice in the dropdown.
        if (modalAccountId === MAIN_WALLET_ID) {
          payload.source = 'main_wallet';
        } else if (modalAccountId) {
          payload.source = 'trading_account';
          payload.account_id = modalAccountId;
        }
      } else if (modalType !== 'add-fund' && modalAccountId) {
        payload.account_id = modalAccountId;
      }
      // Backend returns HTTP 202 with detail.code='approval_required' when the
      // amount is >= ADMIN_DUAL_APPROVAL_THRESHOLD (default $1000). The fund is
      // NOT applied yet — a second admin must approve via /admin/approvals.
      // The API client treats 202 as success and returns the body, so without
      // this branch we'd show "successful" while the user's wallet stays the
      // same. Surface the pending state explicitly instead.
      const resp = await adminApi.post<{ detail?: { code?: string; request_id?: string; threshold_usd?: number; message?: string } }>(
        `/users/${modalUser.id}/${modalType}`,
        payload,
      );
      if (resp?.detail?.code === 'approval_required') {
        toast(
          `Pending — amount ≥ $${resp.detail.threshold_usd?.toLocaleString() ?? dualThreshold.toLocaleString()}. ` +
          `A second admin must approve this in /approvals.`,
          { icon: '⏳', duration: 6000 },
        );
      } else {
        toast.success(`${FUND_LABELS[modalType as FundAction]} successful`);
      }
      closeModal();
      fetchUsers();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setModalSubmitting(false);
    }
  };

  const submitBanAction = async () => {
    if (!modalUser || !modalType) return;
    setModalSubmitting(true);
    try {
      await adminApi.post(`/users/${modalUser.id}/${modalType}`);
      toast.success(modalType === 'ban' ? 'User banned' : 'User unbanned');
      closeModal();
      fetchUsers();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setModalSubmitting(false);
    }
  };

  const submitKillSwitch = async () => {
    if (!modalUser) return;
    setModalSubmitting(true);
    try {
      await adminApi.post(`/users/${modalUser.id}/kill-switch`, { close_positions: modalClosePositions });
      toast.success('Kill switch activated');
      closeModal();
      fetchUsers();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setModalSubmitting(false);
    }
  };

  // Lifecycle status actions (suspend / terminate / soft-delete / reactivate).
  // All keep the user's data — only `status` changes. Simple confirm flow.
  const quickStatusAction = async (
    u: { id: string; name?: string; email?: string },
    endpoint: string, confirmMsg: string, successMsg: string,
  ) => {
    setOpenActionsId(null); setMenuPos(null);
    if (!window.confirm(confirmMsg)) return;
    try {
      await adminApi.post(`/users/${u.id}/${endpoint}`);
      toast.success(successMsg);
      fetchUsers();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action failed');
    }
  };

  const submitDeleteUser = async () => {
    if (!modalUser) return;
    setModalSubmitting(true);
    try {
      await adminApi.delete(`/users/${modalUser.id}`);
      toast.success(`User ${modalUser.email} deleted`);
      closeModal();
      fetchUsers();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setModalSubmitting(false);
    }
  };

  const handleLoginAs = async (user: User) => {
    setOpenActionsId(null);
    setMenuPos(null);
    // Open the popup synchronously inside the user-gesture to avoid popup
    // blockers; we set the URL after the token is minted.
    const popup = window.open('about:blank', '_blank');
    try {
      const data = await adminApi.post<{ access_token: string; user_email: string }>(`/users/${user.id}/login-as`);
      if (!data?.access_token) throw new Error('No access token returned');
      const host = typeof window !== 'undefined' ? window.location.hostname : '';
      const proto = typeof window !== 'undefined' ? window.location.protocol : 'https:';
      const traderUrl = process.env.NEXT_PUBLIC_TRADER_URL
        || (host.startsWith('admin.') ? `${proto}//${host.replace(/^admin\./, '')}` : 'http://localhost:3000');
      const url = `${traderUrl}/auth/impersonate?token=${encodeURIComponent(data.access_token)}`;
      if (popup && !popup.closed) {
        popup.location.href = url;
      } else {
        // Popup was blocked — fall back to same-tab navigation.
        window.location.href = url;
      }
      toast.success(`Logged in as ${data.user_email}`);
    } catch (e) {
      if (popup && !popup.closed) popup.close();
      toast.error(e instanceof Error ? e.message : 'Login-as failed');
    }
  };

  const exportCsv = () => {
    const headers = ['ID', 'Name', 'Email', 'Balance', 'Equity', 'Group', 'KYC', 'Status'];
    const rows = sorted.map(u => [u.id, u.name, u.email, u.balance, u.equity, u.group, u.kyc_status, u.status].join(','));
    const blob = new Blob([[headers.join(','), ...rows].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'users-export.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  const exportPdf = () => {
    if (!sorted.length) return;
    const period = (dateFrom || dateTo) ? `${dateFrom || 'start'} → ${dateTo || 'today'}` : 'All time';
    const totalBal = sorted.reduce((s, u) => s + (Number(u.balance) || 0), 0);
    void downloadAdminReportPdf(
      'Users report',
      [
        { header: 'Name', width: 40 },
        { header: 'Email', width: 58 },
        { header: 'Balance (USD)', width: 28, align: 'right', mono: true },
        { header: 'Equity (USD)', width: 28, align: 'right', mono: true },
        { header: 'Group', width: 24 },
        { header: 'KYC', width: 20 },
        { header: 'Status', width: 20 },
      ],
      sorted.map(u => [
        u.name || '—', u.email || '—',
        `$${(Number(u.balance) || 0).toFixed(2)}`,
        `$${(Number(u.equity) || 0).toFixed(2)}`,
        u.group || '—', u.kyc_status || '—', u.status || '—',
      ]),
      {
        subtitle: `Users${statusFilter ? ` · status: ${statusFilter}` : ''}${debouncedSearch ? ` · search: "${debouncedSearch}"` : ''}`,
        periodLabel: period,
        summaryLines: [
          `Users listed: ${sorted.length}`,
          `Total balance (listed): $${totalBal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        ],
        filename: 'users-report',
      },
    );
  };

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <ArrowUpDown size={10} className="text-text-tertiary opacity-0 group-hover:opacity-100 transition-fast" />;
    return sortDir === 'asc' ? <ArrowUp size={10} className="text-buy" /> : <ArrowDown size={10} className="text-buy" />;
  };

  const isFundAction = (t: ModalType): t is FundAction => !!t && t in FUND_LABELS;

  return (
    <>
      <div className="p-6 space-y-5 min-w-0 max-w-full">
        {/* Header */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-xl font-bold text-text-primary">User Management</h1>
            <p className="text-sm text-text-tertiary mt-1">
              {loading ? 'Loading...' : `${total} total users`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={exportPdf} className={cn(
              'inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-border-primary',
              'bg-bg-secondary text-sm text-text-primary font-medium transition-fast hover:bg-bg-hover',
            )}>
              <Download size={16} className="text-buy" />
              Download PDF
            </button>
            <button type="button" onClick={exportCsv} className={cn(
              'inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-border-primary',
              'bg-bg-secondary text-sm text-text-primary font-medium transition-fast hover:bg-bg-hover',
            )}>
              <Download size={16} className="text-text-secondary" />
              Export CSV
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="bg-bg-secondary border border-border-primary rounded-lg p-5 space-y-4">
          <div className="relative max-w-lg">
            <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-text-tertiary" />
            <input
              type="search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search name, email, or ID..."
              className={cn(
                'w-full pl-11 pr-4 py-3 text-sm bg-bg-input border border-border-primary rounded-lg',
                'placeholder:text-text-tertiary transition-fast focus:border-buy',
              )}
            />
          </div>
          <div className="flex flex-wrap gap-4">
            {([
              { label: 'Status', value: statusFilter, onChange: (v: string) => { setStatusFilter(v); setPage(1); }, options: [{ v: '', t: 'All statuses' }, { v: 'active', t: 'Active' }, { v: 'suspended', t: 'Suspended' }, { v: 'banned', t: 'Banned' }, { v: 'terminated', t: 'Terminated' }, { v: 'deleted', t: 'Soft-deleted' }, { v: 'pending', t: 'Pending' }] },
              { label: 'KYC', value: kycFilter, onChange: (v: string) => { setKycFilter(v); setPage(1); }, options: [{ v: '', t: 'All KYC' }, { v: 'verified', t: 'Verified' }, { v: 'pending', t: 'Pending' }, { v: 'rejected', t: 'Rejected' }] },
              { label: 'Group', value: groupFilter, onChange: setGroupFilter, options: [{ v: '', t: 'All groups' }, { v: 'Retail', t: 'Retail' }, { v: 'IB', t: 'IB' }, { v: 'VIP', t: 'VIP' }] },
            ] as const).map(f => (
              <div key={f.label}>
                <label className="block text-xs font-medium text-text-tertiary mb-1.5">{f.label}</label>
                <div className="relative min-w-[160px]">
                  <select value={f.value} onChange={e => f.onChange(e.target.value)} className="w-full text-sm py-2.5 pl-3 pr-9 appearance-none bg-bg-input border border-border-primary rounded-lg">
                    {f.options.map(o => <option key={o.v || 'all'} value={o.v}>{o.t}</option>)}
                  </select>
                  <ChevronDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
                </div>
              </div>
            ))}
          </div>

          {/* Created-at date range — quick presets + custom inputs */}
          <div className="pt-4 border-t border-border-primary/60">
            <div className="flex items-center gap-2 mb-2">
              <Calendar size={13} className="text-text-tertiary" />
              <span className="text-xxs uppercase tracking-wide text-text-tertiary font-medium">
                Registered (date range)
              </span>
              {activeDatePreset && (
                <span className="text-xxs text-text-secondary ml-1">
                  · {activeDatePreset === 'custom'
                      ? (dateFrom === dateTo ? dateFrom : `${dateFrom} → ${dateTo}`)
                      : DATE_PRESETS.find(p => p.key === activeDatePreset)?.label}
                </span>
              )}
              {(dateFrom || dateTo) && (
                <button
                  onClick={clearDateRange}
                  className="ml-auto text-xxs text-text-tertiary hover:text-text-primary inline-flex items-center gap-1"
                >
                  <X size={11} /> Clear
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {DATE_PRESETS.map((p) => (
                <button
                  key={p.key}
                  onClick={() => applyDatePreset(p.key)}
                  className={cn(
                    'px-2.5 py-1 rounded-md text-xs font-medium border transition-fast',
                    activeDatePreset === p.key
                      ? 'bg-buy/15 border-buy/40 text-buy'
                      : 'border-border-primary text-text-secondary hover:bg-bg-hover',
                  )}
                >
                  {p.label}
                </button>
              ))}
              <span className="mx-1 text-text-tertiary text-xxs">|</span>
              <DateField value={dateFrom} max={dateTo || undefined} onChange={(v) => { setDateFrom(v); setActiveDatePreset('custom'); setPage(1); }} />
              <span className="text-xxs text-text-tertiary">to</span>
              <DateField value={dateTo} min={dateFrom || undefined} onChange={(v) => { setDateTo(v); setActiveDatePreset('custom'); setPage(1); }} />
            </div>
          </div>
        </div>

        {/* Users Table */}
        <div className="bg-bg-secondary border border-border-primary rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b-2 border-border-primary bg-bg-tertiary/50">
                  {COLUMNS.map(col => (
                    <th
                      key={col.key}
                      onClick={() => handleSort(col.key)}
                      className={cn(
                        'group cursor-pointer select-none px-3 py-3 text-[10px] font-semibold text-text-tertiary uppercase tracking-wider whitespace-nowrap',
                        col.align === 'right' ? 'text-right' : 'text-left',
                      )}
                    >
                      <span className="inline-flex items-center gap-1">
                        {col.label}
                        <SortIcon col={col.key} />
                      </span>
                    </th>
                  ))}
                  <th className="px-2 py-3 text-[10px] font-semibold text-text-tertiary uppercase tracking-wider text-center whitespace-nowrap w-[50px]"></th>
                </tr>
              </thead>
              <tbody>
                {!loading && sorted.map(u => (
                  <tr key={u.id} className="border-b border-border-primary/40 transition-fast hover:bg-bg-hover/60 group/row">
                    <td className="px-3 py-3 text-text-tertiary font-mono tabular-nums whitespace-nowrap" title={u.id}>{u.id.slice(0, 8)}…</td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      <Link href={`/users/${u.id}`} className="inline-flex items-center gap-2 hover:text-buy transition-fast">
                        <div className="w-7 h-7 rounded-full bg-buy/10 border border-buy/20 flex items-center justify-center shrink-0">
                          <UserRound size={13} className="text-buy" />
                        </div>
                        <span className="text-xs font-medium text-text-primary">{u.name}</span>
                      </Link>
                    </td>
                    <td className="px-3 py-3 text-text-secondary whitespace-nowrap">{u.email}</td>
                    <td className="px-3 py-3 text-right whitespace-nowrap">
                      <div className="text-text-primary font-mono tabular-nums font-medium">${formatMoney(u.balance)}</div>
                      {u.main_wallet_balance !== undefined && (
                        <div className="text-[10px] text-text-tertiary font-mono tabular-nums mt-0.5">
                          Wallet ${formatMoney(u.main_wallet_balance)} · Trading ${formatMoney(u.trading_balance ?? 0)}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3 text-text-primary text-right font-mono tabular-nums font-medium whitespace-nowrap">${formatMoney(u.equity)}</td>
                    <td className="px-3 py-3 text-text-secondary whitespace-nowrap">{u.group}</td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      <span className={cn('inline-flex px-2 py-0.5 rounded text-[10px] font-semibold', kycBadge(u.kyc_status))}>{u.kyc_status}</span>
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      <span className={cn('inline-flex px-2 py-0.5 rounded text-[10px] font-semibold', statusBadge(u.status))}>{u.status}</span>
                    </td>
                    <td className="px-2 py-3 text-center whitespace-nowrap" data-actions-menu>
                      <button
                        type="button"
                        onClick={(e) => toggleActions(u.id, e)}
                        className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-border-primary text-text-secondary transition-fast hover:bg-bg-hover hover:text-text-primary hover:border-border-secondary"
                      >
                        <MoreHorizontal size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {loading && <TableSkeleton />}
          {!loading && sorted.length === 0 && (
            <div className="px-6 py-16 text-center text-sm text-text-tertiary">No users match filters</div>
          )}
        </div>

        {/* Pagination */}
        {!loading && pages > 1 && (
          <div className="flex items-center justify-between">
            <p className="text-sm text-text-tertiary">
              Page {page} of {pages} &middot; {total} users
            </p>
            <div className="flex items-center gap-1.5">
              <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className={cn('p-2 rounded-lg border border-border-primary text-text-secondary transition-fast', page <= 1 ? 'opacity-40 cursor-not-allowed' : 'hover:bg-bg-hover hover:text-text-primary')}>
                <ChevronLeft size={16} />
              </button>
              {Array.from({ length: Math.min(pages, 7) }, (_, i) => {
                let p: number;
                if (pages <= 7) p = i + 1;
                else if (page <= 4) p = i + 1;
                else if (page >= pages - 3) p = pages - 6 + i;
                else p = page - 3 + i;
                return (
                  <button key={p} onClick={() => setPage(p)} className={cn(
                    'min-w-[36px] h-9 px-2 rounded-lg text-sm font-medium transition-fast',
                    page === p ? 'bg-buy/15 text-buy border border-buy/30' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                  )}>
                    {p}
                  </button>
                );
              })}
              <button disabled={page >= pages} onClick={() => setPage(p => p + 1)} className={cn('p-2 rounded-lg border border-border-primary text-text-secondary transition-fast', page >= pages ? 'opacity-40 cursor-not-allowed' : 'hover:bg-bg-hover hover:text-text-primary')}>
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Fixed-position Actions Dropdown */}
      {openActionsId && menuPos && (() => {
        const u = sorted.find(x => x.id === openActionsId);
        if (!u) return null;
        const closeMenu = () => { setOpenActionsId(null); setMenuPos(null); };
        // Each entry carries the permission the BACKEND enforces for it, so
        // the menu only shows what this admin can actually do. Backend gating:
        // ban/unban/suspend/terminate/soft-delete → users.ban,
        // kill-switch → users.kill_switch, login-as → users.impersonate,
        // permanent delete → users.delete, funds → users.add_fund/deduct_fund.
        const rawItems = [
          { label: 'View Profile', icon: Eye, perm: 'users.view', action: () => { closeMenu(); router.push(`/users/${u.id}`); } },
          { label: 'Add Fund', icon: Plus, perm: 'users.add_fund', action: () => openModal('add-fund', u) },
          { label: 'Deduct Fund', icon: Minus, perm: 'users.deduct_fund', action: () => openModal('deduct-fund', u) },
          { label: 'Give Credit', icon: CreditCard, perm: 'users.add_fund', action: () => openModal('give-credit', u) },
          { label: 'Take Credit', icon: DollarSign, perm: 'users.deduct_fund', action: () => openModal('take-credit', u) },
          { divider: true } as any,
          { label: u.status?.toLowerCase() === 'banned' ? 'Unban User' : 'Ban User', icon: Ban, perm: 'users.ban', action: () => openModal(u.status?.toLowerCase() === 'banned' ? 'unban' : 'ban', u), danger: true },
          { label: 'Kill Switch', icon: Power, perm: 'users.kill_switch', action: () => openModal('kill-switch', u), danger: true },
          { divider: true } as any,
          // Lifecycle: reactivate is offered when the account is in any
          // login-blocked state; otherwise suspend / terminate / soft-delete.
          ...(['suspended', 'terminated', 'deleted'].includes((u.status || '').toLowerCase())
            ? [{ label: 'Reactivate User', icon: UserCheck, perm: 'users.ban', action: () => quickStatusAction(u, 'reactivate', `Reactivate ${u.name}? They will be able to log in again.`, 'User reactivated') }]
            : [
                { label: 'Suspend (temporary)', icon: PauseCircle, perm: 'users.ban', action: () => quickStatusAction(u, 'suspend', `Suspend ${u.name}? They can't log in until reactivated. Data is kept.`, 'User suspended'), danger: true },
                { label: 'Terminate Account', icon: XCircle, perm: 'users.ban', action: () => quickStatusAction(u, 'terminate', `Terminate ${u.name}? Account closes but all history stays.`, 'User terminated'), danger: true },
              ]),
          { divider: true } as any,
          { label: 'Login As User', icon: LogIn, perm: 'users.impersonate', action: () => handleLoginAs(u) },
          { divider: true } as any,
          { label: 'Soft Delete (keep records)', icon: Archive, perm: 'users.ban', action: () => quickStatusAction(u, 'soft-delete', `Soft-delete ${u.name}? They can never log in, but ALL records stay with the broker. Reversible.`, 'User soft-deleted'), danger: true },
          { label: 'Delete Permanently', icon: Trash2, perm: 'users.delete', action: () => openModal('delete', u), danger: true },
        ];
        // Hide actions this admin lacks permission for, then drop any divider
        // that became leading / trailing / doubled-up after the filtering.
        const permitted = rawItems.filter((it: any) => it.divider || can(it.perm));
        const menuItems = permitted.filter((it: any, i: number) => {
          if (!it.divider) return true;
          const prev = permitted.slice(0, i).reverse().find((x: any) => !x.divider);
          const next = permitted.slice(i + 1).find((x: any) => !x.divider);
          return prev && next; // keep a divider only if real items sit on both sides
        });
        // Portal the dropdown to document.body so `position: fixed` stays
        // viewport-relative even when an ancestor has a CSS `transform`
        // (e.g. the `animate-page-in` wrapper) which would otherwise become
        // the containing block.
        if (typeof document === 'undefined') return null;
        return createPortal(
          <>
            <div className="fixed inset-0 z-40" onMouseDown={closeMenu} />
            <div
              ref={menuRef}
              data-actions-menu
              className="fixed z-50 w-[190px] py-1 rounded-lg border border-border-primary bg-bg-secondary shadow-dropdown text-left animate-slide-down overflow-y-auto overscroll-contain"
              style={{ top: menuPos.top, left: menuPos.left, maxHeight: `calc(100vh - ${menuPos.top}px - 8px)` }}
              onMouseDown={e => e.stopPropagation()}
              onClick={e => e.stopPropagation()}
            >
              {menuItems.map((item, idx) => {
                if (item.divider) return <div key={idx} className="my-1.5 border-t border-border-primary" />;
                return (
                  <button
                    key={idx}
                    type="button"
                    className={cn('flex items-center gap-2 w-full text-left px-3 py-2 text-xs transition-fast hover:bg-bg-hover', item.danger ? 'text-danger hover:text-danger' : 'text-text-secondary hover:text-text-primary')}
                    onClick={() => item.action()}
                  >
                    <item.icon size={15} /> {item.label}
                  </button>
                );
              })}
            </div>
          </>,
          document.body,
        );
      })()}

      {/* Fund Action Modal */}
      <Modal open={isFundAction(modalType)} onClose={closeModal} title={modalType && isFundAction(modalType) ? `${FUND_LABELS[modalType]} — ${modalUser?.name}` : ''}>
        <div className="space-y-4">

          {/* Amount FIRST so it's visible immediately — no scrolling needed. */}
          <div>
            <label className="block text-xs font-medium text-text-tertiary mb-1.5">Amount (USD)</label>
            <div className="relative">
              <DollarSign size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-text-tertiary" />
              <input type="number" min="0" step="0.01" autoFocus value={modalAmount} onChange={e => setModalAmount(e.target.value)} placeholder="0.00" className="w-full pl-11 pr-4 py-3 text-sm bg-bg-input border border-border-primary rounded-lg font-mono tabular-nums placeholder:text-text-tertiary focus:border-buy transition-fast" />
            </div>
          </div>

          {/* Add Fund: goes to Main Wallet — inform admin */}
          {modalType === 'add-fund' && (
            <div className="p-3.5 rounded-lg bg-buy/10 border border-buy/25 flex items-start gap-2.5">
              <DollarSign size={15} className="text-buy mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-semibold text-buy">Funds go to Main Wallet</p>
                <p className="text-xs text-text-secondary mt-0.5 leading-relaxed">
                  The amount will be credited to the user&apos;s <strong>main wallet</strong>. The user must then transfer funds to their trading account from the Wallet page.
                </p>
                <p className="text-[11px] text-text-tertiary mt-1.5 leading-snug">
                  Amounts of <strong>${dualThreshold.toLocaleString()} or more</strong> require a second admin to approve in <strong>/approvals</strong> before the wallet is credited. A repeat fund-add to the same user within 24h also needs approval, even below this limit.
                </p>
              </div>
            </div>
          )}

          {/* Deduct Fund: choose source — main wallet OR specific trading account */}
          {modalType === 'deduct-fund' && (
            <>
              <div className="p-3.5 rounded-lg bg-warning/10 border border-warning/25">
                <p className="text-xs text-text-secondary leading-relaxed">
                  <span className="font-semibold text-warning">Source:</span> Choose whether to deduct from the user&apos;s main wallet or a specific trading account.
                </p>
              </div>
              <div>
                <label className="block text-xs font-medium text-text-tertiary mb-1.5">Deduct from</label>
                {loadingAccounts ? (
                  <div className="flex items-center gap-2 py-3 text-sm text-text-tertiary">
                    <Loader2 size={14} className="animate-spin" /> Loading accounts...
                  </div>
                ) : (
                  <select
                    value={modalAccountId}
                    onChange={e => setModalAccountId(e.target.value)}
                    className="w-full py-3 px-4 text-sm bg-bg-input border border-border-primary rounded-lg appearance-none"
                  >
                    <option value={MAIN_WALLET_ID}>Main Wallet</option>
                    {modalAccounts.length > 0 && (
                      <optgroup label="Trading accounts">
                        {modalAccounts.map((a: any) => (
                          <option key={a.id} value={a.id}>
                            {a.account_number}{a.is_demo ? ' (Demo)' : ''} — ${formatMoney(a.balance)} {a.currency}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                )}
              </div>
            </>
          )}

          {/* Give/Take Credit: account selector */}
          {(modalType === 'give-credit' || modalType === 'take-credit') && (
            <div>
              <label className="block text-xs font-medium text-text-tertiary mb-1.5">Account</label>
              {loadingAccounts ? (
                <div className="flex items-center gap-2 py-3 text-sm text-text-tertiary">
                  <Loader2 size={14} className="animate-spin" /> Loading accounts...
                </div>
              ) : modalAccounts.length === 0 ? (
                <p className="text-sm text-danger">No trading accounts found for this user.</p>
              ) : (
                <select
                  value={modalAccountId}
                  onChange={e => setModalAccountId(e.target.value)}
                  className="w-full py-3 px-4 text-sm bg-bg-input border border-border-primary rounded-lg appearance-none"
                >
                  {modalAccounts.map((a: any) => (
                    <option key={a.id} value={a.id}>
                      {a.account_number}{a.is_demo ? ' (Demo)' : ''} — ${formatMoney(a.balance)} {a.currency}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-text-tertiary mb-1.5">Reason</label>
            <textarea value={modalReason} onChange={e => setModalReason(e.target.value)} rows={2} placeholder="Optional reason..." className="w-full px-4 py-3 text-sm bg-bg-input border border-border-primary rounded-lg placeholder:text-text-tertiary focus:border-buy transition-fast resize-none" />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={closeModal} className="px-5 py-2.5 rounded-lg text-sm font-medium text-text-secondary border border-border-primary hover:bg-bg-hover transition-fast">Cancel</button>
            <button
              type="button"
              onClick={submitFundAction}
              disabled={modalSubmitting || (modalType !== 'add-fund' && !modalAccountId)}
              className={cn('px-5 py-2.5 rounded-lg text-sm font-medium transition-fast inline-flex items-center gap-2', 'bg-buy text-white hover:bg-buy-light disabled:opacity-50')}
            >
              {modalSubmitting && <Loader2 size={14} className="animate-spin" />}
              Confirm
            </button>
          </div>
        </div>
      </Modal>

      {/* Ban/Unban Modal */}
      <Modal open={modalType === 'ban' || modalType === 'unban'} onClose={closeModal} title={modalType === 'ban' ? `Ban ${modalUser?.name}?` : `Unban ${modalUser?.name}?`}>
        <div className="space-y-5">
          <p className="text-sm text-text-secondary leading-relaxed">
            {modalType === 'ban'
              ? 'This will prevent the user from logging in and trading. Their open positions will remain active.'
              : 'This will restore the user\'s access to the platform.'}
          </p>
          <div className="flex justify-end gap-3">
            <button type="button" onClick={closeModal} className="px-5 py-2.5 rounded-lg text-sm font-medium text-text-secondary border border-border-primary hover:bg-bg-hover transition-fast">Cancel</button>
            <button type="button" onClick={submitBanAction} disabled={modalSubmitting} className={cn('px-5 py-2.5 rounded-lg text-sm font-medium transition-fast inline-flex items-center gap-2', modalType === 'ban' ? 'bg-danger text-white hover:bg-sell-light disabled:opacity-50' : 'bg-success text-white hover:opacity-90 disabled:opacity-50')}>
              {modalSubmitting && <Loader2 size={14} className="animate-spin" />}
              {modalType === 'ban' ? 'Ban User' : 'Unban User'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Kill Switch Modal */}
      <Modal open={modalType === 'kill-switch'} onClose={closeModal} title={`Kill Switch — ${modalUser?.name}`}>
        <div className="space-y-5">
          <div className="p-4 rounded-lg bg-danger/10 border border-danger/20">
            <p className="text-sm text-danger font-semibold flex items-center gap-2">
              <ShieldOff size={16} /> This action is destructive
            </p>
            <p className="text-sm text-text-secondary mt-2 leading-relaxed">
              Kill switch will immediately disable the user&apos;s account and optionally close all open positions at market price.
            </p>
          </div>
          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={modalClosePositions} onChange={e => setModalClosePositions(e.target.checked)} className="w-4 h-4 rounded accent-danger" />
            <span className="text-sm text-text-primary">Close all open positions</span>
          </label>
          <div className="flex justify-end gap-3">
            <button type="button" onClick={closeModal} className="px-5 py-2.5 rounded-lg text-sm font-medium text-text-secondary border border-border-primary hover:bg-bg-hover transition-fast">Cancel</button>
            <button type="button" onClick={submitKillSwitch} disabled={modalSubmitting} className="px-5 py-2.5 rounded-lg text-sm font-medium bg-danger text-white hover:bg-sell-light disabled:opacity-50 transition-fast inline-flex items-center gap-2">
              {modalSubmitting && <Loader2 size={14} className="animate-spin" />}
              Activate Kill Switch
            </button>
          </div>
        </div>
      </Modal>

      {/* Delete User Modal */}
      <Modal open={modalType === 'delete'} onClose={closeModal} title={`Delete ${modalUser?.name}?`}>
        <div className="space-y-4">
          <div className="p-4 rounded-lg bg-danger/10 border border-danger/20">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-danger/20 border border-danger/30 flex items-center justify-center shrink-0">
                <Trash2 size={18} className="text-danger" />
              </div>
              <div>
                <p className="text-sm font-semibold text-danger">⚠ Permanent delete — cannot be undone</p>
                <p className="text-xs text-text-secondary mt-1">{modalUser?.email}</p>
              </div>
            </div>
          </div>
          <div className="p-3 rounded-lg bg-bg-tertiary border border-border-primary text-xs text-text-secondary space-y-1.5">
            <p className="font-semibold text-text-primary">This will permanently delete:</p>
            <ul className="list-disc pl-5 space-y-0.5">
              <li>All trading accounts & their history (trades, orders, positions)</li>
              <li>Wallet balances, deposits, withdrawals, transactions</li>
              <li>Copy trade allocations, master accounts, IB profile & commissions</li>
              <li>KYC documents, support tickets, sessions, notifications</li>
              <li>The user login itself</li>
            </ul>
          </div>
          <div className="flex justify-end gap-3">
            <button type="button" onClick={closeModal} className="px-5 py-2.5 rounded-lg text-sm font-medium text-text-secondary border border-border-primary hover:bg-bg-hover transition-fast">Cancel</button>
            <button type="button" onClick={submitDeleteUser} disabled={modalSubmitting} className="px-5 py-2.5 rounded-lg text-sm font-medium bg-danger text-white hover:bg-sell-light disabled:opacity-50 transition-fast inline-flex items-center gap-2">
              {modalSubmitting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
              Delete User
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
