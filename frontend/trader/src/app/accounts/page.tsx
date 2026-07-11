'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import {
  ChevronDown,
  Pencil,
  TrendingDown,
  TrendingUp,
  ArrowLeftRight,
  BookOpen,
  ExternalLink,
  Trash2,
  Wallet,
  Landmark,
} from 'lucide-react';
import DashboardShell from '@/components/layout/DashboardShell';
import { Button } from '@/components/ui/Button';
import api from '@/lib/api/client';
import { useAuthStore } from '@/stores/authStore';
import { useTradingStore, type TradingAccount, type AccountGroupInfo } from '@/stores/tradingStore';
import {
  getPersistedTradingAccountId,
  setPersistedTradingAccountId,
  tradingTerminalUrl,
} from '@/lib/tradingNav';
import Modal from '@/components/ui/Modal';
import AccountTypePickerModal from '@/components/accounts/AccountTypePickerModal';
import { fmtAccountMoney, isCentAccount } from '@/lib/wallet/centDisplay';

const ALIAS_PREFIX = 'ptd-account-alias:';

type TabId = 'accounts' | 'transfer';
type TransferEndKind = 'wallet' | 'trading';

interface AccountRow {
  id: string;
  account_number: string;
  balance: number;
  credit: number;
  equity: number;
  margin_used: number;
  free_margin: number;
  margin_level: number;
  leverage: number;
  currency: string;
  is_demo: boolean;
  account_group?: AccountGroupInfo | null;
  created_at?: string;
  // MAM sub-account markers — backend sets these when the row is an
  // investor sub-account. Frontend uses lifetime_pnl in place of the
  // default floating-only P&L so closed mirrored trades show up.
  is_managed_account?: boolean;
  allocation_amount?: number | null;
  lifetime_pnl?: number | null;
  lifetime_pnl_pct?: number | null;
}

function fmt(n: number, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2 }).format(n);
}

// Cent-aware wrapper: every visible money figure on this page should
// flow through this so cent-group accounts render in ¢. Wallet-side
// USD totals (transfer flows) still use fmt() since the main wallet
// is always USD regardless of which trading-account currency we're
// moving funds to.
function fmtRow(row: { account_group?: AccountGroupInfo | null } | null | undefined, n: number) {
  return fmtAccountMoney(n, isCentAccount(row ?? null));
}

function readAlias(id: string): string {
  if (typeof window === 'undefined') return '';
  try {
    return localStorage.getItem(`${ALIAS_PREFIX}${id}`) || '';
  } catch {
    return '';
  }
}

function writeAlias(id: string, value: string) {
  try {
    const v = value.trim();
    if (v) localStorage.setItem(`${ALIAS_PREFIX}${id}`, v);
    else localStorage.removeItem(`${ALIAS_PREFIX}${id}`);
  } catch {
    /* ignore */
  }
}

function toTradingAccount(row: AccountRow): TradingAccount {
  return {
    id: row.id,
    account_number: row.account_number,
    balance: row.balance,
    credit: row.credit,
    equity: row.equity,
    margin_used: row.margin_used,
    free_margin: row.free_margin,
    margin_level: row.margin_level,
    leverage: row.leverage,
    currency: row.currency,
    is_demo: row.is_demo,
    account_group: row.account_group ?? null,
  };
}

const DEMO_FUNDING_MSG =
  'Demo accounts cannot transfer funds. Open a live account to move balance between accounts.';

export default function AccountsPage() {
  const user = useAuthStore((s) => s.user);
  const setStoreAccounts = useTradingStore((s) => s.setAccounts);
  const setActiveAccount = useTradingStore((s) => s.setActiveAccount);
  const removeAccount = useTradingStore((s) => s.removeAccount);

  const [tab, setTab] = useState<TabId>('accounts');
  const [rows, setRows] = useState<AccountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadGen = useRef(0);

  const [transferFrom, setTransferFrom] = useState('');
  const [transferTo, setTransferTo] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferSubmitting, setTransferSubmitting] = useState(false);
  const [accountPickerOpen, setAccountPickerOpen] = useState(false);
  const [kycGateOpen, setKycGateOpen] = useState(false);
  const kycAutoShown = useRef(false);
  const [demoUpgradeOpen, setDemoUpgradeOpen] = useState(false);
  /** After creating an account, open-account sets sessionStorage; expand that card on Accounts. */
  const [expandAccountId, setExpandAccountId] = useState<string | null>(null);
  const [fromKind, setFromKind] = useState<TransferEndKind>('trading');
  const [toKind, setToKind] = useState<TransferEndKind>('trading');
  const [mainWalletBalance, setMainWalletBalance] = useState(0);
  const [transferKindsInitialized, setTransferKindsInitialized] = useState(false);

  /** Unified transfer source/dest ID: 'wallet' or account UUID. */
  const [uniFrom, setUniFrom] = useState('wallet');
  const [uniTo, setUniTo] = useState('');
  // Agreement to the credit-forfeit rule when a transfer OUT of a trading
  // account would drop its balance below its bonus credit.
  const [transferAgree, setTransferAgree] = useState(false);
  // Proper confirmation popup shown when a transfer would forfeit bonus credit.
  const [forfeitConfirmOpen, setForfeitConfirmOpen] = useState(false);
  const [uniInitialized, setUniInitialized] = useState(false);

  const fetchWalletSummary = useCallback(async () => {
    try {
      const s = await api.get<{ main_wallet_balance?: number }>('/wallet/summary');
      setMainWalletBalance(Number(s.main_wallet_balance) || 0);
    } catch {
      setMainWalletBalance(0);
    }
  }, []);

  const fetchAccounts = useCallback(async (signal?: AbortSignal) => {
    const id = ++loadGen.current;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<any>('/accounts', undefined, { signal });
      if (id !== loadGen.current) return;
      const list: AccountRow[] = Array.isArray(res) ? res : (res?.items ?? []);
      setRows(list);
      const tradingList = list.map(toTradingAccount);
      setStoreAccounts(tradingList);
    } catch (e) {
      if (id !== loadGen.current) return;
      const msg = e instanceof Error ? e.message : 'Failed to load accounts';
      setError(msg);
      toast.error(msg);
    } finally {
      if (id === loadGen.current) setLoading(false);
    }
  }, [setStoreAccounts]);

  useEffect(() => {
    document.documentElement.setAttribute('data-page', 'accounts');
    return () => {
      document.documentElement.removeAttribute('data-page');
    };
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void fetchAccounts(ac.signal);
    return () => {
      ac.abort();
      loadGen.current += 1;
    };
  }, [fetchAccounts]);

  useEffect(() => {
    if (loading || rows.length === 0) return;
    let id: string | null = null;
    try {
      id = sessionStorage.getItem('ptd-accounts-expand');
    } catch {
      /* ignore */
    }
    if (!id) return;
    if (!rows.some((r) => r.id === id)) return;
    setExpandAccountId(id);
    try {
      sessionStorage.removeItem('ptd-accounts-expand');
    } catch {
      /* ignore */
    }
  }, [loading, rows]);

  useEffect(() => {
    if (!expandAccountId) return;
    const el = document.getElementById(`account-card-${expandAccountId}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [expandAccountId]);

  useEffect(() => {
    if (tab !== 'transfer' || user?.is_demo) return;
    void fetchWalletSummary();
  }, [tab, user?.is_demo, fetchWalletSummary]);

  const demoFundingBlocked = rows.length > 0 && !rows.some((a) => !a.is_demo);
  const liveAccounts = useMemo(() => rows.filter((a) => !a.is_demo), [rows]);

  useEffect(() => {
    if (loading || transferKindsInitialized) return;
    if (liveAccounts.length >= 2) {
      setFromKind('trading');
      setToKind('trading');
    } else if (liveAccounts.length === 1) {
      setFromKind('wallet');
      setToKind('trading');
    }
    setTransferKindsInitialized(true);
  }, [loading, liveAccounts.length, transferKindsInitialized]);

  useEffect(() => {
    if (liveAccounts.length < 2 && fromKind === 'trading' && toKind === 'trading') {
      setFromKind('wallet');
      setToKind('trading');
    }
  }, [liveAccounts.length, fromKind, toKind]);

  // Proactively show the KYC prompt once for an unverified LIVE user who has no
  // live account yet — so the popup actually appears without them having to
  // click "New Account" (client 2026-06-20: "KYC popup nahi aa raha").
  useEffect(() => {
    if (kycAutoShown.current || loading || !user) return;
    // Sequence onboarding: while the profile is incomplete the
    // ProfileCompleteGate (blocking modal) owns the screen — don't auto-pop
    // the "Complete KYC to open a live account" gate on top of it. Once the
    // profile is done this effect re-runs and the KYC gate can show (client
    // 2026-06-24: "pehle profile form, fir KYC").
    if (user.profile_complete === false) return;
    const kyc = (user.kyc_status || 'pending').toLowerCase();
    const approved = kyc === 'approved' || kyc === 'verified';
    if (!user.is_demo && !approved && liveAccounts.length === 0) {
      kycAutoShown.current = true;
      setKycGateOpen(true);
    }
  }, [loading, user, liveAccounts.length]);

  /* Show all active accounts. CF/IF (follower copy-trade / managed sub-accounts)
     render with "View Trades" instead of Trade — the copy engine places trades
     there automatically. Pool accounts (CT/PM/MM) shown for master funding.
     Inactive accounts are hidden via is_active (delete_master sets this false). */
  const visibleRows = useMemo(() => {
    if (user?.is_demo) return rows.filter((a) => a.is_demo);
    return rows.filter((a) => {
      if ((a as { is_active?: boolean }).is_active === false) return false;
      return true;
    });
  }, [rows, user?.is_demo]);

  /** Sync store + session before opening terminal (navigation via `<Link href>` so clicks always work). */
  const prepareTradeSession = (row: AccountRow) => {
    setActiveAccount(toTradingAccount(row));
    setPersistedTradingAccountId(row.id);
  };

  const handleAccountRemoved = (id: string) => {
    removeAccount(id);
    setRows((prev) => {
      const next = prev.filter((r) => r.id !== id);
      setStoreAccounts(next.map(toTradingAccount));
      return next;
    });
    if (getPersistedTradingAccountId() === id) setPersistedTradingAccountId(null);
  };

  const pickFromKind = (k: TransferEndKind) => {
    if (k === 'wallet' && toKind === 'wallet') setToKind('trading');
    setFromKind(k);
  };

  const pickToKind = (k: TransferEndKind) => {
    if (k === 'wallet' && fromKind === 'wallet') setFromKind('trading');
    setToKind(k);
  };

  const fromWalletDisabled = toKind === 'wallet';
  const fromTradingDisabled = toKind === 'trading' && liveAccounts.length < 2;
  const toWalletDisabled = fromKind === 'wallet';
  const toTradingDisabled = fromKind === 'trading' && liveAccounts.length < 2;

  const effectiveFromId = transferFrom || liveAccounts[0]?.id || '';
  const effectiveToId = useMemo(() => {
    if (transferTo && transferTo !== effectiveFromId) return transferTo;
    const other = liveAccounts.find((a) => a.id !== effectiveFromId);
    return other?.id || liveAccounts[0]?.id || '';
  }, [transferTo, effectiveFromId, liveAccounts]);

  const maxTransferAmount = useMemo(() => {
    if (fromKind === 'wallet') return Math.max(0, mainWalletBalance);
    const a = liveAccounts.find((x) => x.id === effectiveFromId);
    if (!a) return 0;
    return Math.max(0, Number(a.free_margin ?? 0));
  }, [fromKind, mainWalletBalance, liveAccounts, effectiveFromId]);

  /* ── Unified transfer helpers ── */
  useEffect(() => {
    if (uniInitialized || loading) return;
    // Only mark initialised once we've actually picked valid accounts. If the
    // effect fires while liveAccounts is still empty (loading flipped before
    // the list arrived), marking it initialised left uniTo='' forever — the
    // <select> then showed the first option while the state stayed empty, so
    // the transfer POSTed an empty UUID (client 2026-06-26).
    if (liveAccounts.length >= 2) {
      setUniFrom(liveAccounts[0].id);
      setUniTo(liveAccounts[1].id);
      setUniInitialized(true);
    } else if (liveAccounts.length === 1) {
      setUniFrom('wallet');
      setUniTo(liveAccounts[0].id);
      setUniInitialized(true);
    }
    // 0 accounts → leave un-initialised; re-runs when the list loads.
  }, [loading, liveAccounts, uniInitialized]);

  /** All selectable options: wallet + each live account */
  const transferOptions = useMemo(() => {
    const opts: Array<{ id: string; label: string; sublabel: string; balance: number }> = [
      { id: 'wallet', label: 'Main Wallet', sublabel: 'Wallet', balance: mainWalletBalance },
    ];
    for (const a of liveAccounts) {
      opts.push({
        id: a.id,
        label: `#${a.account_number}`,
        sublabel: a.account_group?.name ?? 'Live',
        balance: Number(a.free_margin ?? a.balance ?? 0),
      });
    }
    return opts;
  }, [liveAccounts, mainWalletBalance]);

  const uniFromBalance = useMemo(() => {
    if (uniFrom === 'wallet') return mainWalletBalance;
    const a = liveAccounts.find((x) => x.id === uniFrom);
    return a ? Math.max(0, Number(a.free_margin ?? 0)) : 0;
  }, [uniFrom, liveAccounts, mainWalletBalance]);

  // Credit-forfeit warning: moving money OUT of a trading account that drops
  // its balance below its bonus credit forfeits the whole (non-insurance)
  // credit (client 2026-06-26).
  const uniFromAccount = useMemo(
    () => (uniFrom === 'wallet' ? null : liveAccounts.find((x) => x.id === uniFrom) ?? null),
    [uniFrom, liveAccounts],
  );
  const uniFromCredit = Number(uniFromAccount?.credit ?? 0);
  const uniWouldForfeit = useMemo(() => {
    if (!uniFromAccount || uniFromCredit <= 0) return false;
    const amt = parseFloat(transferAmount);
    if (Number.isNaN(amt) || amt <= 0) return false;
    return (Number(uniFromAccount.balance ?? 0) - amt) < uniFromCredit;
  }, [uniFromAccount, uniFromCredit, transferAmount]);

  const swapFromTo = () => {
    setTransferAgree(false);
    const prev = uniFrom;
    setUniFrom(uniTo);
    setUniTo(prev);
  };

  const submitUnifiedTransfer = async () => {
    if (demoFundingBlocked) { toast.error(DEMO_FUNDING_MSG); return; }
    let amt = parseFloat(transferAmount);
    if (!amt || amt <= 0) { toast.error('Enter a valid amount'); return; }
    if (!uniFrom || !uniTo) { toast.error('Select a source and destination account'); return; }
    if (uniFrom === uniTo) { toast.error('Select different source and destination'); return; }
    if (uniFrom === 'wallet' && uniTo === 'wallet') { toast.error('Cannot transfer wallet to wallet'); return; }
    // "Max" fills the 2-decimal display, which can sit a hair above the true
    // balance (e.g. 16694.4599 shown as 16694.46). Treat a within-1-cent
    // overshoot as "transfer all" and send the exact balance (client 2026-06-26).
    if (amt > uniFromBalance) {
      if (amt - uniFromBalance <= 0.01) { amt = uniFromBalance; }
      else { toast.error('Insufficient balance'); return; }
    }

    setTransferSubmitting(true);
    try {
      if (uniFrom === 'wallet') {
        await api.post('/wallet/transfer-main-to-trading', { to_account_id: uniTo, amount: amt });
        const num = liveAccounts.find((a) => a.id === uniTo)?.account_number ?? '';
        toast.success(`Sent ${fmt(amt)} to account ${num}`);
      } else if (uniTo === 'wallet') {
        await api.post('/wallet/transfer-trading-to-main', { from_account_id: uniFrom, amount: amt });
        toast.success(`Moved ${fmt(amt)} to your wallet`);
      } else {
        await api.post('/wallet/transfer-internal', { from_account_id: uniFrom, to_account_id: uniTo, amount: amt });
        const toNum = liveAccounts.find((a) => a.id === uniTo)?.account_number ?? '';
        toast.success(`Moved ${fmt(amt)} to ${toNum}`);
      }
      setTransferAmount('');
      void fetchAccounts();
      void fetchWalletSummary();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Transfer failed');
    } finally {
      setTransferSubmitting(false);
    }
  };

  const submitTransfer = async () => {
    if (demoFundingBlocked) {
      toast.error(DEMO_FUNDING_MSG);
      return;
    }
    const amt = parseFloat(transferAmount);
    if (!amt || amt <= 0) {
      toast.error('Enter a valid amount');
      return;
    }
    if (fromKind === 'wallet' && toKind === 'wallet') {
      toast.error('Select a trading account on one side');
      return;
    }

    const fromId = transferFrom || liveAccounts[0]?.id || '';
    const toId =
      transferTo ||
      liveAccounts.find((a) => a.id !== fromId)?.id ||
      liveAccounts[0]?.id ||
      '';

    setTransferSubmitting(true);
    try {
      if (fromKind === 'wallet' && toKind === 'trading') {
        const tid = toId || liveAccounts[0]?.id;
        if (!tid) {
          toast.error('Select a trading account');
          return;
        }
        if (amt > mainWalletBalance + 1e-9) {
          toast.error('Insufficient wallet balance');
          return;
        }
        await api.post('/wallet/transfer-main-to-trading', { to_account_id: tid, amount: amt });
        const num = liveAccounts.find((a) => a.id === tid)?.account_number ?? '';
        toast.success(`Sent ${fmt(amt)} to account ${num}`);
      } else if (fromKind === 'trading' && toKind === 'wallet') {
        if (!fromId) {
          toast.error('Select a trading account');
          return;
        }
        const acc = liveAccounts.find((a) => a.id === fromId);
        const avail = acc ? Math.max(0, Number(acc.free_margin ?? 0)) : 0;
        if (amt > avail + 1e-9) {
          toast.error('Insufficient available balance on that account');
          return;
        }
        await api.post('/wallet/transfer-trading-to-main', { from_account_id: fromId, amount: amt });
        toast.success(`Moved ${fmt(amt)} to your wallet`);
      } else {
        if (!fromId || !toId) {
          toast.error('You need two live accounts to transfer between them');
          return;
        }
        if (fromId === toId) {
          toast.error('Choose two different accounts');
          return;
        }
        const acc = liveAccounts.find((a) => a.id === fromId);
        const avail = acc ? Math.max(0, Number(acc.free_margin ?? 0)) : 0;
        if (amt > avail + 1e-9) {
          toast.error('Insufficient available balance on the source account');
          return;
        }
        await api.post('/wallet/transfer-internal', {
          from_account_id: fromId,
          to_account_id: toId,
          amount: amt,
        });
        const toNum = liveAccounts.find((a) => a.id === toId)?.account_number ?? '';
        toast.success(`Moved ${fmt(amt)} to ${toNum}`);
      }
      setTransferAmount('');
      void fetchAccounts();
      void fetchWalletSummary();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Transfer failed');
    } finally {
      setTransferSubmitting(false);
    }
  };

  const newAccountCtaClass =
    'inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg border-2 border-[#55a630] text-[#55a630] text-sm font-bold hover:bg-[#55a630]/10 transition-colors shrink-0';

  /** Open the account-type picker. Picker now hosts a Real/Demo toggle —
   *  Demo accounts don't need KYC, so we open the picker regardless of KYC
   *  status and let the modal show its own KYC banner when the user
   *  actually selects Real. (Was: hard-blocked the picker if KYC wasn't
   *  approved, which made demo accounts unreachable for new users.) */
  const handleOpenNewAccount = () => {
    // Unverified real users get a clear KYC prompt popup before the picker
    // (client 2026-06-19: "kyc popup nahi aa raha"). Demo users skip it — they
    // can only open demo accounts anyway, so go straight to the picker.
    const kyc = (user?.kyc_status || 'pending').toLowerCase();
    const approved = kyc === 'approved' || kyc === 'verified';
    if (!user?.is_demo && !approved) {
      setKycGateOpen(true);
      return;
    }
    setAccountPickerOpen(true);
  };

  return (
    <DashboardShell>
      <AccountTypePickerModal
        open={accountPickerOpen}
        onClose={() => setAccountPickerOpen(false)}
        onCreated={() => void fetchAccounts()}
      />
      <Modal
        open={kycGateOpen}
        onClose={() => setKycGateOpen(false)}
        title="Complete KYC to open a live account"
        width="md"
        className="border border-border-primary bg-bg-card shadow-2xl"
      >
        <div className="space-y-4 p-1">
          <p className="text-sm text-text-secondary leading-relaxed">
            Live trading accounts are only available after your identity verification is approved. Submit your KYC documents and wait for review to continue.
          </p>
          {(() => {
            const kyc = (user?.kyc_status || 'pending').toLowerCase();
            const label =
              kyc === 'pending' || !kyc
                ? 'Not started'
                : kyc === 'submitted' || kyc === 'under_review'
                  ? 'Under review'
                  : kyc === 'rejected' || kyc === 'failed'
                    ? 'Rejected — please resubmit'
                    : kyc;
            const color =
              kyc === 'rejected' || kyc === 'failed'
                ? 'text-sell bg-sell/10 border-sell/30'
                : kyc === 'submitted' || kyc === 'under_review'
                  ? 'text-warning bg-warning/10 border-warning/30'
                  : 'text-text-secondary bg-bg-tertiary border-border-primary';
            return (
              <div className={clsx('rounded-lg border px-3 py-2 text-xs font-semibold uppercase tracking-wider inline-flex', color)}>
                KYC status: {label}
              </div>
            );
          })()}
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-3 border-t border-border-primary">
            <button
              type="button"
              onClick={() => setKycGateOpen(false)}
              className="px-5 py-2.5 rounded-lg border border-border-primary bg-bg-card text-sm font-semibold text-text-primary hover:bg-bg-hover transition-colors"
            >
              Close
            </button>
            {/* Demo doesn't need KYC — let the user practise right away. */}
            <button
              type="button"
              onClick={() => { setKycGateOpen(false); setAccountPickerOpen(true); }}
              className="px-5 py-2.5 rounded-lg border border-border-primary bg-bg-card text-sm font-semibold text-text-primary hover:bg-bg-hover transition-colors"
            >
              Open Demo instead
            </button>
            <Link
              href="/kyc"
              onClick={() => setKycGateOpen(false)}
              className="px-5 py-2.5 rounded-lg bg-[#55a630] text-white text-sm font-bold hover:bg-[#3f7d22] transition-colors text-center"
            >
              Complete KYC
            </Link>
          </div>
        </div>
      </Modal>
      <Modal
        open={demoUpgradeOpen}
        onClose={() => setDemoUpgradeOpen(false)}
        title="Register a real account"
        width="md"
        className="border border-border-primary bg-bg-card shadow-2xl"
      >
        <div className="space-y-4 p-1">
          <p className="text-sm text-text-secondary leading-relaxed">
            Demo accounts are provisioned by our team and cannot add new trading accounts. To open additional accounts, please register a real account.
          </p>
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-3 border-t border-border-primary">
            <button
              type="button"
              onClick={() => setDemoUpgradeOpen(false)}
              className="px-5 py-2.5 rounded-lg border border-border-primary bg-bg-card text-sm font-semibold text-text-primary hover:bg-bg-hover transition-colors"
            >
              Close
            </button>
            <Link
              href="/auth/register"
              onClick={() => setDemoUpgradeOpen(false)}
              className="px-5 py-2.5 rounded-lg bg-[#55a630] text-white text-sm font-bold hover:bg-[#3f7d22] transition-colors text-center"
            >
              Register Real Account
            </Link>
          </div>
        </div>
      </Modal>
      {/* Accounts / Internal Transfer — full-width edge-to-edge, straight top line
          meeting the sidebar's right border; only the active-tab indicator curves. */}
      <div className="relative -mx-4 md:-mx-6 -mt-4 md:-mt-6 mb-8">
        <div className="overflow-hidden border-b border-accent/40 bg-card">
          <div className="relative flex min-h-[64px] sm:min-h-[100px] border-t border-accent/40 bg-card">
              <div className="pointer-events-none absolute inset-0 z-0" aria-hidden>
                <div
                  className="absolute top-0 h-full w-1/2 transition-[transform] duration-500 ease-[cubic-bezier(0.34,1.45,0.64,1)] will-change-transform"
                  style={{
                    transform: tab === 'accounts' ? 'translate3d(0,0,0)' : 'translate3d(100%,0,0)',
                  }}
                >
                  {/* Only the inner edge (facing the other tab) curves; the outer edge
                      drops flush with the panel's left/right border. */}
                  <div
                    className={clsx(
                      'absolute top-0 h-full border-t-2 border-b-0 border-accent bg-card-nested',
                      'animate-wallet-main-tab-glow',
                      tab === 'accounts'
                        ? 'left-0 right-1.5 rounded-tr-2xl border-r-2'
                        : 'left-1.5 right-0 rounded-tl-2xl border-l-2',
                    )}
                  />
                </div>
              </div>
              {(
                [
                  { id: 'accounts' as const, label: 'Accounts' },
                  { id: 'transfer' as const, label: 'Internal Transfer' },
                ] as const
              ).map((t) => {
                const active = tab === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setTab(t.id)}
                    className={clsx(
                      'relative z-10 flex-1 border-0 bg-transparent px-4 py-5 text-center text-sm font-semibold outline-none sm:py-7 sm:text-lg',
                      'transition-colors duration-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/50',
                      active ? 'text-accent' : 'text-text-secondary hover:text-text-primary',
                    )}
                  >
                    {active ? (
                      <span
                        key={tab}
                        className="relative inline-block animate-wallet-main-tab-text drop-shadow-[0_0_20px_rgba(85,166,48,0.7)]"
                      >
                        {t.label}
                      </span>
                    ) : (
                      <span className="relative inline-block">{t.label}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

      <div className="page-main w-full space-y-6">
        {tab === 'accounts' && (
          <div key="tab-accounts" className="animate-wallet-fund-enter-lg">
            {/* Outer shell — nested cards open inside; soft green light pulse like wallet tabs */}
            <div className="relative overflow-hidden rounded-2xl border border-border-primary bg-card">
              <div
                className="pointer-events-none absolute inset-0 z-0 rounded-2xl opacity-[0.28] animate-wallet-main-tab-glow"
                aria-hidden
              />
              <div className="pointer-events-none absolute inset-x-0 top-0 z-0 h-px bg-gradient-to-r from-transparent via-accent/35 to-transparent" aria-hidden />
              <div className="relative z-[1] space-y-6 p-5 sm:p-6">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <h1 className="text-xl font-bold tracking-tight text-text-primary sm:text-2xl">
                      Trading Accounts
                    </h1>
                    <p className="mt-1 text-sm text-text-secondary">Manage your trading accounts</p>
                  </div>
                  {user?.is_demo ? (
                    <button type="button" onClick={() => setDemoUpgradeOpen(true)} className={newAccountCtaClass}>
                      <span className="text-lg leading-none">+</span>
                      New Account
                    </button>
                  ) : (
                    <button type="button" onClick={handleOpenNewAccount} className={newAccountCtaClass}>
                      <span className="text-lg leading-none">+</span>
                      New Account
                    </button>
                  )}
                </div>

                {loading && (
                  <div className="flex flex-col items-center gap-3 py-16">
                    <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                    <span className="text-sm text-text-secondary">Loading accounts…</span>
                  </div>
                )}

                {!loading && error && (
                  <div className="space-y-3 rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-center">
                    <p className="text-sm text-red-400">{error}</p>
                    <Button variant="outline" size="sm" onClick={() => void fetchAccounts()}>
                      Retry
                    </Button>
                  </div>
                )}

                {!loading && !error && visibleRows.length === 0 && (
                  <div className="rounded-xl border border-border-primary bg-card-nested p-8 text-center">
                    <p className="text-sm text-text-secondary">
                      {user?.is_demo
                        ? 'No demo trading account is linked yet.'
                        : 'You do not have a trading account yet. Use the "New Account" button above to open one.'}
                    </p>
                  </div>
                )}

                {!loading && !error && visibleRows.length > 0 && (
                  <ul className="space-y-3">
                    {visibleRows.map((row) => (
                      <AccountCard
                        key={row.id}
                        row={row}
                        initialExpanded={row.id === expandAccountId}
                        tradeHref={tradingTerminalUrl(row.id, { view: 'chart' })}
                        onTradePrepare={() => prepareTradeSession(row)}
                        onRemoved={handleAccountRemoved}
                      />
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        )}

        {tab === 'transfer' && (
          <div
            key="tab-transfer"
            className="w-full max-w-full animate-wallet-fund-enter-lg space-y-6"
          >
            <div className="rounded-2xl border border-accent/20 bg-card p-5 sm:p-6 shadow-[0_2px_12px_rgba(0,0,0,0.08)]">
              <div className="flex items-start gap-3 mb-6">
                <div className="w-11 h-11 rounded-xl bg-accent/15 border border-accent/35 flex items-center justify-center shrink-0 text-accent">
                  <ArrowLeftRight size={22} strokeWidth={2.25} />
                </div>
                <div>
                  <h1 className="text-xl font-bold text-text-primary tracking-tight">Internal Transfer</h1>
                  <p className="text-sm text-text-secondary mt-1 leading-relaxed max-w-prose">
                    Move funds between your main wallet and live trading accounts, or between accounts.
                  </p>
                </div>
              </div>

              {demoFundingBlocked && (
                <div className="mb-5 rounded-xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-sm text-amber-600">
                  {DEMO_FUNDING_MSG}
                </div>
              )}

              {liveAccounts.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border-secondary bg-bg-base px-5 py-10 text-center">
                  <p className="text-sm text-white/80 mb-4">No live trading accounts yet. Open one to deposit and transfer.</p>
                  {!user?.is_demo && (
                    <button
                      type="button"
                      onClick={() => {
                        setTab('accounts');
                        handleOpenNewAccount();
                      }}
                      className="text-sm font-bold text-[#55a630] hover:underline"
                    >
                      Open live account
                    </button>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  {/* ── FROM ── */}
                  <div className="space-y-2">
                    <p className="text-xs font-bold uppercase tracking-wider text-white/50">From</p>
                    <select
                      value={uniFrom}
                      onChange={(e) => {
                        const v = e.target.value;
                        setUniFrom(v);
                        if (uniTo === v) {
                          const alt = transferOptions.find((o) => o.id !== v);
                          if (alt) setUniTo(alt.id);
                        }
                      }}
                      className="accounts-native-select w-full px-4 py-3 rounded-xl text-sm font-semibold"
                    >
                      {transferOptions.map((o) => (
                        <option key={o.id} value={o.id} disabled={o.id === uniTo}>
                          {o.label} — {o.sublabel} — {fmt(o.balance)}
                        </option>
                      ))}
                    </select>
                    {/* From card */}
                    {(() => {
                      const opt = transferOptions.find((o) => o.id === uniFrom);
                      if (!opt) return null;
                      const isWallet = uniFrom === 'wallet';
                      return (
                        <div className="rounded-xl border border-accent/35 bg-bg-base p-4 flex items-center gap-3">
                          <div className="w-10 h-10 rounded-full bg-[#55a630]/12 flex items-center justify-center text-[#55a630] shrink-0">
                            {isWallet ? <Wallet size={20} strokeWidth={2} /> : <Landmark size={20} strokeWidth={2} />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-semibold text-text-primary">{opt.label}</div>
                            <div className="text-[10px] uppercase tracking-wide text-text-tertiary font-semibold mt-0.5">
                              {isWallet ? 'Balance' : 'Available'}
                            </div>
                          </div>
                          <div className="text-xl font-bold text-accent tabular-nums font-mono shrink-0">
                            {fmt(opt.balance)}
                          </div>
                        </div>
                      );
                    })()}
                  </div>

                  {/* ── SWAP BUTTON ── */}
                  <div className="flex justify-center">
                    <button
                      type="button"
                      onClick={swapFromTo}
                      className="group w-10 h-10 rounded-full border border-accent/30 bg-bg-base flex items-center justify-center text-accent/80 hover:bg-accent/10 hover:border-accent/60 transition-all active:scale-95"
                      title="Swap direction"
                    >
                      <ArrowLeftRight size={16} className="rotate-90 group-hover:scale-110 transition-transform" />
                    </button>
                  </div>

                  {/* ── TO ── */}
                  <div className="space-y-2">
                    <p className="text-xs font-bold uppercase tracking-wider text-text-tertiary">To</p>
                    <select
                      value={uniTo}
                      onChange={(e) => {
                        const v = e.target.value;
                        setUniTo(v);
                        if (uniFrom === v) {
                          const alt = transferOptions.find((o) => o.id !== v);
                          if (alt) setUniFrom(alt.id);
                        }
                      }}
                      className="accounts-native-select w-full px-4 py-3 rounded-xl text-sm font-semibold"
                    >
                      {transferOptions
                        .filter((o) => o.id !== uniFrom)
                        .map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label} — {o.sublabel} — {fmt(o.balance)}
                          </option>
                        ))}
                    </select>
                    {/* To card */}
                    {(() => {
                      const opt = transferOptions.find((o) => o.id === uniTo);
                      if (!opt) return null;
                      const isWallet = uniTo === 'wallet';
                      return (
                        <div className="rounded-xl border border-border-primary bg-bg-base p-4 flex items-center gap-3">
                          <div className="w-10 h-10 rounded-full bg-[#55a630]/12 flex items-center justify-center text-[#55a630] shrink-0">
                            {isWallet ? <Wallet size={20} strokeWidth={2} /> : <Landmark size={20} strokeWidth={2} />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-semibold text-text-primary">{opt.label}</div>
                            <div className="text-[10px] uppercase tracking-wide text-text-tertiary font-semibold mt-0.5">
                              {isWallet ? 'Wallet' : 'Balance'}
                            </div>
                          </div>
                          <div className="text-lg font-bold text-text-primary tabular-nums font-mono shrink-0">
                            {fmt(opt.balance)}
                          </div>
                        </div>
                      );
                    })()}
                  </div>

                  {/* ── AMOUNT ── */}
                  <div className="pt-3 space-y-2 border-t border-border-primary">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label className="text-sm font-medium text-text-primary">Amount</label>
                      <button
                        type="button"
                        onClick={() =>
                          setTransferAmount(uniFromBalance > 0 ? uniFromBalance.toFixed(2) : '')
                        }
                        disabled={uniFromBalance <= 0}
                        className="text-sm font-bold text-[#55a630] hover:underline disabled:opacity-40 disabled:pointer-events-none"
                      >
                        Max: {fmt(uniFromBalance)}
                      </button>
                    </div>
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={transferAmount}
                      onChange={(e) => { setTransferAmount(e.target.value); setTransferAgree(false); }}
                      onWheel={(e) => e.currentTarget.blur()}
                      placeholder="0.00"
                      className="w-full px-4 py-3.5 rounded-xl border border-border-primary bg-bg-base font-mono font-semibold text-text-primary text-base placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent/50"
                    />
                  </div>

                  {/* ── SUBMIT ── (credit-forfeit case opens the agreement
                      modal below; the inline red banner was replaced by it) */}
                  <button
                    type="button"
                    onClick={() => {
                      if (uniWouldForfeit) { setTransferAgree(false); setForfeitConfirmOpen(true); }
                      else { void submitUnifiedTransfer(); }
                    }}
                    disabled={
                      demoFundingBlocked ||
                      transferSubmitting ||
                      !transferAmount.trim() ||
                      uniFromBalance <= 0 ||
                      uniFrom === uniTo
                    }
                    className="w-full py-3.5 rounded-xl bg-[#55a630] text-white text-base font-bold hover:bg-[#3f7d22] disabled:opacity-45 disabled:pointer-events-none transition-colors flex items-center justify-center gap-2"
                  >
                    <ArrowLeftRight size={20} />
                    {transferSubmitting ? 'Transferring…' : 'Transfer'}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Bonus-forfeit confirmation popup */}
      {forfeitConfirmOpen && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setForfeitConfirmOpen(false)} />
          <div className="relative w-full max-w-sm bg-bg-secondary border border-red-500/40 rounded-2xl shadow-modal p-6 text-center space-y-4">
            <div className="mx-auto w-12 h-12 rounded-full bg-red-500/15 flex items-center justify-center text-2xl" aria-hidden>⚠️</div>
            <h2 className="text-base font-bold text-text-primary">Bonus credit will be forfeited</h2>
            <p className="text-sm text-text-secondary leading-relaxed">
              This transfer drops the account below its{' '}
              <span className="font-bold text-text-primary">{fmt(uniFromCredit)}</span> bonus credit. Your{' '}
              <span className="font-bold text-red-400">entire {fmt(uniFromCredit)} credit</span> will be forfeited
              (insurance payouts are kept). This can&apos;t be undone.
            </p>
            <label className="flex items-start gap-2.5 rounded-xl border border-border-primary bg-bg-base px-3 py-2.5 text-left cursor-pointer select-none">
              <input
                type="checkbox"
                checked={transferAgree}
                onChange={(e) => setTransferAgree(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-red-500 cursor-pointer"
              />
              <span className="text-xs text-text-secondary leading-relaxed">
                I agree — I understand my{' '}
                <span className="font-bold text-red-400">{fmt(uniFromCredit)} bonus credit will be permanently forfeited</span>{' '}
                by this transfer.
              </span>
            </label>
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => { setForfeitConfirmOpen(false); setTransferAgree(false); }}
                className="flex-1 py-2.5 rounded-xl border border-border-primary text-text-secondary hover:bg-bg-hover text-sm font-medium"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={transferSubmitting || !transferAgree}
                onClick={() => { setForfeitConfirmOpen(false); void submitUnifiedTransfer(); }}
                className="flex-1 py-2.5 rounded-xl bg-red-500 text-white hover:bg-red-600 text-sm font-bold disabled:opacity-45 disabled:pointer-events-none"
              >
                Yes, forfeit &amp; transfer
              </button>
            </div>
          </div>
        </div>
      )}
    </DashboardShell>
  );
}

const TREND_TABS = ['24H', '7D', '30D', '90D', '1Y'] as const;

function formatCreated(d?: string) {
  if (!d) return '—';
  const t = Date.parse(d);
  if (!Number.isFinite(t)) return '—';
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(t);
}

interface BalanceHistoryResponse {
  account_id: string;
  period: string;
  bucket_seconds: number;
  current_balance: number;
  items: Array<{ time: number; balance: number }>; // time is unix seconds
}

const TAB_TO_PERIOD: Record<(typeof TREND_TABS)[number], string> = {
  '24H': '24h', '7D': '7d', '30D': '30d', '90D': '90d', '1Y': '1y',
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtYLabel(v: number): string {
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `$${(v / 1e3).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}

function BalanceTrendBlock({ accountId }: { accountId: string }) {
  const [tab, setTab] = useState<(typeof TREND_TABS)[number]>('7D');
  const [items, setItems] = useState<Array<{ time: number; balance: number }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get<BalanceHistoryResponse>('/portfolio/balance-history', {
        account_id: accountId,
        period: TAB_TO_PERIOD[tab],
      })
      .then((res) => {
        if (cancelled) return;
        setItems(Array.isArray(res?.items) ? res.items : []);
      })
      .catch(() => { if (!cancelled) setItems([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [accountId, tab]);

  /* Project backend buckets onto the chart space. */
  const { dailyPoints, xLabels } = useMemo(() => {
    let labelFn: (d: Date) => string;
    if (tab === '24H') {
      labelFn = (d) => `${d.getHours().toString().padStart(2, '0')}:00`;
    } else if (tab === '7D' || tab === '30D') {
      labelFn = (d) => DAY_NAMES[d.getDay()];
    } else if (tab === '90D') {
      labelFn = (d) => `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`;
    } else {
      labelFn = (d) => MONTH_SHORT[d.getMonth()];
    }

    const pts: { x: number; y: number }[] = items.map((it) => ({
      x: it.time * 1000,
      y: it.balance,
    }));
    const labels: string[] = items.map((it) => labelFn(new Date(it.time * 1000)));

    return { dailyPoints: pts, xLabels: labels };
  }, [items, tab]);

  /* Chart dimensions with margins for labels */
  const W = 480;
  const H = 160;
  const ML = 48; // left margin for Y-axis labels
  const MR = 8;
  const MT = 12;
  const MB = 22; // bottom margin for X-axis labels

  const { path, areaPath, isProfit, pnlValue, pnlPct, yTicks, screenPts } = useMemo(() => {
    if (dailyPoints.length < 2) return { path: '', areaPath: '', isProfit: true, pnlValue: 0, pnlPct: 0, yTicks: [] as { y: number; label: string }[], screenPts: [] as { sx: number; sy: number }[] };

    const ys = dailyPoints.map((p) => p.y);
    const yMin = Math.min(...ys);
    const yMax = Math.max(...ys);
    const yPad = (yMax - yMin) * 0.1 || 1;
    const yLo = yMin - yPad;
    const yHi = yMax + yPad;
    const yRange = yHi - yLo || 1;
    const xMin = dailyPoints[0].x;
    const xMax = dailyPoints[dailyPoints.length - 1].x;
    const xRange = xMax - xMin || 1;

    const chartW = W - ML - MR;
    const chartH = H - MT - MB;

    const pts = dailyPoints.map((p) => ({
      sx: ML + ((p.x - xMin) / xRange) * chartW,
      sy: MT + (1 - (p.y - yLo) / yRange) * chartH,
    }));

    const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.sx.toFixed(1)},${p.sy.toFixed(1)}`).join(' ');
    const area = `${linePath} L${pts[pts.length - 1].sx.toFixed(1)},${H - MB} L${pts[0].sx.toFixed(1)},${H - MB} Z`;

    const first = dailyPoints[0].y;
    const last = dailyPoints[dailyPoints.length - 1].y;
    const diff = last - first;
    const pct = first > 0 ? (diff / first) * 100 : 0;

    /* Generate 3-4 Y-axis ticks */
    const tickCount = 4;
    const ticks: { y: number; label: string }[] = [];
    for (let i = 0; i < tickCount; i++) {
      const val = yLo + (yRange * i) / (tickCount - 1);
      const sy = MT + (1 - (val - yLo) / yRange) * chartH;
      ticks.push({ y: sy, label: fmtYLabel(val) });
    }

    return { path: linePath, areaPath: area, isProfit: diff >= 0, pnlValue: diff, pnlPct: pct, yTicks: ticks, screenPts: pts };
  }, [dailyPoints]);

  const lineColor = isProfit ? '#f59e0b' : '#ef4444'; // amber like Crucial Markets
  const gradId = `trend-grad-${accountId}`;

  /* Thin down X-axis labels to avoid overlap */
  const maxXLabels = tab === '24H' ? 8 : tab === '7D' ? 8 : tab === '30D' ? 10 : 8;
  const xStep = Math.max(1, Math.ceil(xLabels.length / maxXLabels));

  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[13px] font-medium text-text-secondary">Balance Trend</div>
        <div className="flex flex-wrap items-center gap-1">
          {TREND_TABS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={clsx(
                'px-2.5 py-1 rounded-md text-[10px] font-bold transition-colors',
                tab === t ? 'bg-accent/20 text-accent border border-accent/40' : 'text-text-tertiary border border-transparent hover:bg-bg-hover hover:text-text-secondary',
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      <div className="rounded-xl bg-bg-base border border-border-primary relative overflow-hidden" style={{ minHeight: '140px', maxHeight: '220px', aspectRatio: `${W}/${H + 10}` }}>
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="h-5 w-5 border-2 border-[#55a630] border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <svg className="w-full h-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={lineColor} stopOpacity="0.35" />
                <stop offset="100%" stopColor={lineColor} stopOpacity="0.02" />
              </linearGradient>
            </defs>

            {/* Horizontal grid lines at Y ticks */}
            {yTicks.map((tick, i) => (
              <g key={i}>
                <line x1={ML} y1={tick.y} x2={W - MR} y2={tick.y} stroke="#1a1a1a" strokeWidth="0.5" />
                <text x={ML - 6} y={tick.y + 3} textAnchor="end" fill="#555" fontSize="9" fontFamily="monospace">
                  {tick.label}
                </text>
              </g>
            ))}

            {/* X-axis labels */}
            {xLabels.map((label, i) => {
              if (i % xStep !== 0 && i !== xLabels.length - 1) return null;
              const sx = screenPts[i]?.sx;
              if (sx == null) return null;
              return (
                <text key={i} x={sx} y={H - 4} textAnchor="middle" fill="#555" fontSize="9">
                  {label}
                </text>
              );
            })}

            {dailyPoints.length >= 2 && (
              <>
                {/* Area fill */}
                <path d={areaPath} fill={`url(#${gradId})`} />
                {/* Line */}
                <path d={path} fill="none" stroke={lineColor} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                {/* Data point dots */}
                {screenPts.map((p, i) => {
                  if (i % xStep !== 0 && i !== screenPts.length - 1) return null;
                  return <circle key={i} cx={p.sx} cy={p.sy} r="3" fill={lineColor} stroke="#080808" strokeWidth="1.5" />;
                })}
              </>
            )}

            {dailyPoints.length < 2 && (
              <text x={W / 2} y={H / 2} textAnchor="middle" dominantBaseline="middle" fill="#444" fontSize="11">
                Not enough data for this period
              </text>
            )}
          </svg>
        )}
      </div>
    </div>
  );
}

function AccountCard({
  row,
  initialExpanded = false,
  tradeHref,
  onTradePrepare,
  onRemoved,
}: {
  row: AccountRow;
  initialExpanded?: boolean;
  tradeHref: string;
  onTradePrepare: () => void;
  onRemoved: (id: string) => void;
}) {
  const [open, setOpen] = useState(initialExpanded);
  const [aliasDraft, setAliasDraft] = useState('');
  const [editingAlias, setEditingAlias] = useState(false);
  const [closeModal, setCloseModal] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setAliasDraft(readAlias(row.id));
  }, [row.id]);

  useEffect(() => {
    if (initialExpanded) setOpen(true);
  }, [initialExpanded]);

  const alias = readAlias(row.id);
  // For MAM sub-accounts the backend ships lifetime_pnl = equity − the
  // original allocation amount. The default floating-only number reads
  // $0 whenever positions are flat — which for a copy account is most
  // of the time — so we honour the lifetime number when it's present
  // (client report 2026-06-01: "MAM P&L not showing anything").
  // Regular accounts keep the floating-only path so bonus / insurance
  // credit doesn't masquerade as P&L on a zero-trades account.
  const floatingPnl = row.equity - row.balance - (row.credit || 0);
  const floatingBase = row.balance + (row.credit || 0);
  const floatingPct =
    floatingBase > 0 && Number.isFinite(row.equity) ? (floatingPnl / floatingBase) * 100 : 0;
  const pnl = row.is_managed_account && row.lifetime_pnl != null
    ? row.lifetime_pnl
    : floatingPnl;
  const pct = row.is_managed_account && row.lifetime_pnl_pct != null
    ? row.lifetime_pnl_pct
    : floatingPct;
  const pnlPositive = pnl >= 0;
  const idLabel = row.is_demo ? `#D#${row.account_number}` : `#L#${row.account_number}`;

  const confirmCloseAccount = async () => {
    setDeleting(true);
    try {
      await api.delete(`/accounts/${row.id}`);
      toast.success(row.is_demo ? 'Demo account removed.' : 'Account closed.');
      setCloseModal(false);
      onRemoved(row.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not close account');
    } finally {
      setDeleting(false);
    }
  };

  const accountLabel = row.is_demo
    ? 'Demo Account'
    : row.account_number.startsWith('PM')
      ? 'PAMM Pool Account'
      : row.account_number.startsWith('MM')
        ? 'MAM Pool Account'
        : row.account_number.startsWith('CT')
          ? 'MAM Master Account'
          : row.account_number.startsWith('CF')
            ? 'MAM Account'
            : row.account_number.startsWith('IF')
              ? 'Investment Account'
              : 'Live Account';

  const isManagedAccount = row.account_number.startsWith('IF') || row.account_number.startsWith('CF');
  const isPoolAccount = row.account_number.startsWith('PM') || row.account_number.startsWith('MM') || row.account_number.startsWith('CT');

  return (
    <li
      id={`account-card-${row.id}`}
      className="relative overflow-hidden rounded-2xl transition-all duration-300"
      style={{
        background: 'var(--bg-card)',
        border: open ? '1px solid var(--border-accent)' : '1px solid var(--border-primary)',
        boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
      }}
    >
      {/* ── Header Row — always visible ── */}
      <div
        className="flex w-full items-start gap-2 sm:gap-3 px-3 sm:px-5 md:px-6 py-4 sm:py-5 cursor-pointer transition-colors hover:bg-bg-hover"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((o) => !o); } }}
        role="button"
        tabIndex={0}
        aria-expanded={open}
      >
        <span
          className={clsx(
            'mt-2 h-2.5 w-2.5 rounded-full shrink-0',
            row.is_demo ? 'bg-sky-400 shadow-[0_0_6px_rgba(56,189,248,0.7)]' : 'bg-[#55a630] shadow-[0_0_6px_rgba(85,166,48,0.7)]',
          )}
          aria-hidden
        />
        <div className="flex-1 min-w-0">
          {/* Account name + ID + alias */}
          <div className="flex flex-wrap items-center gap-x-2 sm:gap-x-3 gap-y-1 mb-3 sm:mb-4">
            <span className="text-sm sm:text-base font-bold text-text-primary">{accountLabel}</span>
            <span className="text-xs sm:text-sm text-text-tertiary font-mono">{idLabel}</span>
            {!editingAlias ? (
              <span className="inline-flex items-center gap-1 text-sm" onClick={(e) => e.stopPropagation()}>
                {alias ? (
                  <>
                    <span className="text-text-secondary">{alias}</span>
                    <button type="button" onClick={() => { setAliasDraft(alias); setEditingAlias(true); }} className="rounded p-0.5 text-accent/70 hover:text-accent hover:bg-accent/10" aria-label="Edit label"><Pencil size={13} /></button>
                  </>
                ) : (
                  <button type="button" onClick={() => { setAliasDraft(''); setEditingAlias(true); }} className="text-accent/60 hover:text-accent text-xs font-semibold">+ Add label</button>
                )}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <input value={aliasDraft} onChange={(e) => setAliasDraft(e.target.value)} placeholder="Alias" className="px-2 py-1 rounded-lg border border-border-primary bg-bg-input text-sm text-text-primary w-36 max-w-[50vw] outline-none focus:border-accent/30" autoFocus onKeyDown={(e) => { if (e.key === 'Enter') { writeAlias(row.id, aliasDraft); setEditingAlias(false); } if (e.key === 'Escape') setEditingAlias(false); }} />
                <button type="button" className="text-xs text-accent font-semibold" onClick={() => { writeAlias(row.id, aliasDraft); setEditingAlias(false); }}>Save</button>
              </span>
            )}
          </div>

          {/* Stats row — Balance | Equity | P&L | Leverage */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 sm:gap-x-6 gap-y-2 sm:gap-y-3">
            <div className="min-w-0">
              <p className="text-[10px] sm:text-[11px] text-text-tertiary font-medium mb-0.5">Balance</p>
              <p className="text-sm sm:text-lg font-bold text-text-primary tabular-nums font-mono truncate">{fmtRow(row, row.balance)}</p>
            </div>
            <div className="min-w-0">
              <p className="text-[10px] sm:text-[11px] text-text-tertiary font-medium mb-0.5">Equity</p>
              <p className="text-sm sm:text-lg font-bold text-text-primary tabular-nums font-mono truncate">{fmtRow(row, row.equity)}</p>
              {(row.credit || 0) > 0 && (
                <p className="text-[10px] sm:text-[11px] text-amber-400/80 font-medium tabular-nums mt-0.5 truncate">
                  incl. {fmtRow(row, row.credit)} credit
                </p>
              )}
            </div>
            <div className="min-w-0">
              <p className="text-[10px] sm:text-[11px] text-text-tertiary font-medium mb-0.5">
                P&amp;L
                {row.is_managed_account && row.allocation_amount != null && (
                  <span className="ml-1 text-text-tertiary/60">vs ${row.allocation_amount.toLocaleString()}</span>
                )}
              </p>
              <div className="flex items-center gap-1">
                <span className={clsx('text-sm sm:text-lg font-bold tabular-nums font-mono truncate', pnlPositive ? 'text-[#55a630]' : 'text-red-400')}>
                  {/* Lifetime P&L is exact (equity − allocation), so drop
                      the "~ approximation" prefix that the floating-only
                      path uses. */}
                  {row.is_managed_account ? '' : '~ '}{pnlPositive ? '+' : ''}{fmtRow(row, pnl)}
                </span>
              </div>
              <p className={clsx('text-[10px] sm:text-xs font-semibold tabular-nums', pnlPositive ? 'text-[#55a630]/70' : 'text-red-400/70')}>
                ({pnlPositive ? '+' : ''}{pct.toFixed(2)}%)
              </p>
            </div>
            <div className="min-w-0">
              <p className="text-[10px] sm:text-[11px] text-text-tertiary font-medium mb-0.5">Leverage</p>
              <p className="text-sm sm:text-lg font-bold text-text-primary tabular-nums font-mono">1:{row.leverage}</p>
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
          className="text-text-tertiary shrink-0 mt-1 p-1.5 rounded-lg hover:bg-bg-hover hover:text-text-primary transition-colors"
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          <ChevronDown size={20} className={clsx('transition-transform duration-200', open && 'rotate-180')} />
        </button>
      </div>

      {/* ── Expanded Section ── */}
      {open && (
        <div className="px-3 sm:px-5 md:px-6 pb-4 sm:pb-5 pt-0" style={{ borderTop: '1px solid var(--border-primary)' }}>
          <div className="grid grid-cols-1 lg:grid-cols-[1.2fr_1fr] gap-4 sm:gap-6 pt-4 sm:pt-5">
            {/* Left — Balance Trend chart */}
            <BalanceTrendBlock accountId={row.id} />

            {/* Right — Account Details */}
            <div>
              <p className="text-[13px] font-medium text-text-secondary mb-3">Account Details</p>
              <div className="grid grid-cols-2 gap-x-4 sm:gap-x-6 gap-y-3 sm:gap-y-4">
                <div>
                  <p className="text-[11px] text-text-tertiary font-medium mb-0.5">Free Margin</p>
                  <p className="text-base font-bold text-text-primary font-mono tabular-nums">{fmtRow(row, row.free_margin)}</p>
                </div>
                <div>
                  <p className="text-[11px] text-text-tertiary font-medium mb-0.5">Margin Level</p>
                  <p className="text-base font-bold text-text-primary font-mono tabular-nums">
                    {Number.isFinite(row.margin_level) && row.margin_level > 0 ? `${row.margin_level.toFixed(2)}%` : '0.00%'}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-text-tertiary font-medium mb-0.5">Credit</p>
                  <p className="text-base font-bold font-mono tabular-nums text-amber-400">
                    {fmtRow(row, row.credit || 0)}
                  </p>
                  <p className="text-[10px] text-text-tertiary mt-0.5 leading-tight">
                    Bonus / insurance — tradeable, not withdrawable
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-text-tertiary font-medium mb-0.5">Currency</p>
                  <p className="text-base font-bold text-text-primary font-mono">{row.currency}</p>
                </div>
                <div>
                  <p className="text-[11px] text-text-tertiary font-medium mb-0.5">Created</p>
                  <p className="text-base font-bold text-text-primary">{formatCreated(row.created_at)}</p>
                </div>
                {row.account_group?.name ? (
                  <div className="col-span-2">
                    <p className="text-[11px] text-text-tertiary font-medium mb-0.5">Account Type</p>
                    <p className="text-base font-bold text-text-primary">{row.account_group.name}</p>
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {/* Action buttons row */}
          <div className="relative z-[60] flex flex-wrap items-center gap-2 pt-4 sm:pt-5 mt-4 sm:mt-5" style={{ borderTop: '1px solid var(--border-primary)' }}>
            {isManagedAccount ? (
              <>
                <Link
                  href={`/portfolio?account_id=${encodeURIComponent(row.id)}&account_no=${encodeURIComponent(row.account_number)}&tab=history`}
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-[#55a630] text-white text-sm font-bold hover:bg-[#3f7d22] transition-colors"
                >
                  <BookOpen size={16} />
                  View Trades
                </Link>
                <div className="rounded-lg border border-border-primary bg-bg-secondary px-4 py-2.5 text-xs text-text-tertiary flex items-center gap-2 sm:ml-auto">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                  {row.account_number.startsWith('IF') ? 'Managed by PAMM master' : 'Managed by MAM master'}
                </div>
              </>
            ) : isPoolAccount ? (
              <>
                <Link
                  href={`/portfolio?account_id=${encodeURIComponent(row.id)}&account_no=${encodeURIComponent(row.account_number)}&tab=history`}
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-border-primary text-text-primary text-sm font-semibold hover:border-border-secondary hover:bg-bg-hover transition-colors"
                >
                  <BookOpen size={16} />
                  Trade History
                </Link>
                <a
                  href={tradeHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => { e.stopPropagation(); onTradePrepare(); }}
                  className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-[#55a630] text-white text-sm font-bold hover:bg-[#3f7d22] transition-colors"
                >
                  Trade
                  <ExternalLink size={14} />
                </a>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setCloseModal(true); }}
                  className="inline-flex items-center justify-center gap-1.5 px-2.5 sm:px-3 py-2 sm:py-2.5 rounded-lg text-red-400 text-xs sm:text-sm font-medium hover:bg-red-500/10 transition-colors sm:ml-auto"
                >
                  <Trash2 size={14} />
                  Close Account
                </button>
              </>
            ) : (
              <>
                <Link
                  href={`/portfolio?account_id=${encodeURIComponent(row.id)}&account_no=${encodeURIComponent(row.account_number)}&tab=history`}
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex items-center justify-center gap-1.5 px-3 sm:px-4 py-2 sm:py-2.5 rounded-lg border border-border-primary text-text-primary text-xs sm:text-sm font-semibold hover:border-border-secondary hover:bg-bg-hover transition-colors"
                >
                  Trading Journal
                </Link>
                <a
                  href={tradeHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => { e.stopPropagation(); onTradePrepare(); }}
                  className="inline-flex items-center justify-center gap-1.5 px-4 sm:px-5 py-2 sm:py-2.5 rounded-lg bg-[#55a630] text-white text-xs sm:text-sm font-bold hover:bg-[#3f7d22] transition-colors"
                >
                  Trade
                  <ExternalLink size={13} />
                </a>
                <button
                  type="button"
                  onClick={() => setCloseModal(true)}
                  className="inline-flex items-center justify-center gap-1.5 px-2.5 sm:px-3 py-2 sm:py-2.5 rounded-lg text-red-400 text-xs sm:text-sm font-medium hover:bg-red-500/10 transition-colors sm:ml-auto"
                >
                  <Trash2 size={14} />
                  Close Account
                </button>
              </>
            )}
          </div>
        </div>
      )}

      <Modal open={closeModal} onClose={() => !deleting && setCloseModal(false)} title="Close account">
        <div className="p-4 space-y-4">
          <p className="text-sm text-text-secondary">
            Close {accountLabel.toLowerCase()} <span className="font-mono font-semibold">{row.account_number}</span>?
          </p>
          <ul className="text-xs text-text-tertiary space-y-1 pl-4 list-disc">
            <li>Any open positions will close at their open price (zero P&amp;L).</li>
            <li>Pending orders will be cancelled.</li>
            {row.balance + (row.equity - row.balance) > 0 ? (
              <li>
                <span className="text-text-secondary font-semibold">{fmtRow(row, row.balance)}</span>
                {isCentAccount(row) && (
                  <span className="text-text-tertiary">
                    {' '}(={fmt(row.balance, 'USD')} in your wallet)
                  </span>
                )}{' '}
                will transfer to your main wallet.
              </li>
            ) : null}
            {isPoolAccount ? (
              <li className="text-amber-500">
                Followers linked to this master will be refunded and stopped copying.
              </li>
            ) : null}
          </ul>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" disabled={deleting} onClick={() => setCloseModal(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className="bg-red-600 hover:bg-red-700 text-white"
              disabled={deleting}
              onClick={() => void confirmCloseAccount()}
            >
              {deleting ? 'Closing…' : 'Close account'}
            </Button>
          </div>
        </div>
      </Modal>
    </li>
  );
}
