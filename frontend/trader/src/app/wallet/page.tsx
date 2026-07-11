'use client';

import { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import { Card } from '@/components/ui/Card';
import DashboardShell from '@/components/layout/DashboardShell';
import DemoLockGate from '@/components/demo/DemoLockGate';
import { useAuthStore } from '@/stores/authStore';
import api from '@/lib/api/client';
import { fmtAccountMoney, isCentAccount, CENT_PER_USD, CENT_SYMBOL } from '@/lib/wallet/centDisplay';
import WalletDepositModal from '@/components/wallet/WalletDepositModal';
import P2PMarketplace from '@/components/wallet/P2PMarketplace';
import {
  ArrowUpRight,
  ArrowDownLeft,
  Wallet as WalletIcon,
  Clock,
  RefreshCcw,
  ArrowDownToLine,
  ArrowUpFromLine,
  TrendingUp,
  X,
  AlertTriangle,
} from 'lucide-react';

interface AccountItem {
  id: string;
  currency?: string;
  is_demo?: boolean;
  balance?: number;
}

interface LiveAccountRow {
  id: string;
  account_number: string;
  balance: number;
  credit?: number;
  margin_used?: number;
  currency?: string;
  free_margin?: number;
  is_cent_account?: boolean;
}

interface WalletData {
  balance: number;
  currency: string;
  main_wallet_balance: number;
  /** Welcome-bonus credit. Tradeable (sweeps to account.credit on the
   *  next main→trading transfer) but NOT withdrawable. Wiped on the
   *  user's first approved withdrawal. */
  main_wallet_bonus: number;
  /** ISO timestamp when admin first approved a withdrawal — once set,
   *  any leftover bonus has been forfeited and future deposits will
   *  not grant a new welcome bonus. */
  bonus_forfeited_at: string | null;
  total_deposited: number;
  total_withdrawn: number;
  pending_withdrawals: number;
  total_live_balance?: number;
}

interface WalletSummaryResponse {
  balance?: number;
  credit?: number;
  equity?: number;
  main_wallet_balance?: number;
  main_wallet_bonus?: number;
  bonus_forfeited_at?: string | null;
  total_deposited?: number;
  total_withdrawn?: number;
  total_live_balance?: number;
  live_accounts?: LiveAccountRow[];
}

interface WalletListItem {
  id: string;
  created_at: string | null;
  type: string;
  method: string;
  amount: number;
  status: string;
  currency: string;
}

interface BonusOfferLite {
  id: string;
  name: string;
  bonus_type: string | null;
  percentage: number | null;
  fixed_amount: number | null;
  min_deposit: number;
  max_bonus: number | null;
  lots_required: number;
  target_audience: string | null;
  starts_at: string | null;
  expires_at: string | null;
}

interface MyBonusRow {
  id: string;
  offer_name: string | null;
  amount: number;
  lots_traded: number;
  lots_required: number;
  status: string;
  released_at: string | null;
  expires_at: string | null;
  created_at: string | null;
}

interface BonusRequestRow {
  deposit_id: string;
  deposit_amount: number;
  deposit_status: string;
  bonus_code: string;
  bonus_status: 'pending' | 'granted' | 'denied' | null;
  bonus_amount: number | null;
  decided_at: string | null;
  created_at: string | null;
}

interface BonusOverview {
  active_offers: BonusOfferLite[];
  my_bonuses: MyBonusRow[];
  recent_requests: BonusRequestRow[];
}

const DEMO_FUNDING_MSG =
  'Demo accounts cannot deposit, withdraw, or transfer funds. Open a live account to use wallet funding.';

// Provider used for new deposits. NOWPayments replaced OxaPay in this build;
// the OxaPay backend code stays mounted so historical / in-flight OxaPay
// deposits still settle, but new deposits are always created against
// NOWPayments. Withdrawals still echo the OxaPay-style payout payload (only
// the inbound deposit channel changed).
const CRYPTO_DEPOSIT_METHOD = 'nowpayments';
const CRYPTO_WITHDRAW_METHOD = 'oxapay';

/** UI grid — selection is sent with NOWPayments / payout details for finance
 *  matching. Restricted to BSC (BEP-20) + Tron (TRC-20) chains only since
 *  the client's NOWPayments payout wallet is on BSC and they want users to
 *  fund via low-fee stablecoin chains. Re-enable ERC-20 / SOL / native BTC
 *  here once payout wallets exist on those chains in NOWPayments dashboard. */
const CRYPTO_ASSETS = [
  { id: 'USDT_BSC', label: 'USDT', sub: 'BSC (BEP-20)' },
  { id: 'USDT_TRC', label: 'USDT', sub: 'Tron (TRC-20)' },
  { id: 'USDC_BSC', label: 'USDC', sub: 'BSC (BEP-20)' },
  { id: 'BNB_BSC',  label: 'BNB',  sub: 'BSC' },
  { id: 'TRX',      label: 'TRX',  sub: 'Tron' },
] as const;

// 'crypto' = automated provider flow (NOWPayments for deposits, OxaPay-style
// payout details for withdrawals). 'manual' = legacy bank manual path.
type FundingChannel = 'crypto' | 'manual' | 'p2p';

interface ManualBankDetailsResponse {
  id?: string;
  bank_name?: string;
  account_holder?: string;
  account_number?: string;
  ifsc_code?: string;
  upi_id?: string;
  qr_code_url?: string;
}

function WalletPageContent() {
  const isDemo = useAuthStore((s) => s.user?.is_demo);
  const router = useRouter();
  const searchParams = useSearchParams();
  const accountFromUrl = searchParams.get('account');
  const withdrawDeepLinkHandled = useRef(false);

  const [wallet, setWallet] = useState<WalletData | null>(null);
  const [liveAccounts, setLiveAccounts] = useState<LiveAccountRow[]>([]);
  /** True when user has accounts but none are live (all demo) — block deposits, withdrawals, transfers. */
  const [demoFundingBlocked, setDemoFundingBlocked] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadGen = useRef(0);
  const fundPanelRef = useRef<HTMLDivElement>(null);

  const [fundMainTab, setFundMainTab] = useState<'deposit' | 'withdraw'>('deposit');
  const [depositUiSection, setDepositUiSection] = useState<'crypto' | 'manual' | 'p2p'>('crypto');
  const [withdrawUiSection, setWithdrawUiSection] = useState<'crypto' | 'bank' | 'p2p'>('crypto');
  // Admin-gated payment-method flags. Crypto is always on; Manual + P2P
  // are dynamic so finance can toggle them off without a redeploy.
  // Source: GET /wallet/payment-methods. Defaults match the backend's
  // get_bool_setting defaults so the UI behaves sanely while the call
  // is in flight.
  const [methodFlags, setMethodFlags] = useState<{
    crypto: boolean; manual: boolean; p2p: boolean;
  }>({ crypto: true, manual: true, p2p: false });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get<{ crypto: boolean; manual: boolean; p2p: boolean }>(
          '/wallet/payment-methods',
        );
        if (!cancelled && r) setMethodFlags(r);
      } catch { /* keep defaults if endpoint is briefly unavailable */ }
    })();
    return () => { cancelled = true; };
  }, []);
  const [selectedCryptoDeposit, setSelectedCryptoDeposit] = useState<string>(CRYPTO_ASSETS[0].id);
  const [selectedCryptoWithdraw, setSelectedCryptoWithdraw] = useState<string>(CRYPTO_ASSETS[0].id);

  const [depositChannel, setDepositChannel] = useState<FundingChannel>('crypto');
  // On-site wallet-connect deposit modal — opened from the deposit form's
  // submit handler when depositChannel === 'crypto'. The modal owns the
  // /wallet/deposit/wallet POST + the polling loop.
  const [walletDepositOpen, setWalletDepositOpen] = useState(false);
  const [walletDepositAmount, setWalletDepositAmount] = useState(0);
  const [walletDepositAsset, setWalletDepositAsset] = useState<string>(CRYPTO_ASSETS[0].id);
  const [depositAmount, setDepositAmount] = useState('');
  const [depositTxId, setDepositTxId] = useState('');
  const [depositProofFile, setDepositProofFile] = useState<File | null>(null);
  const [manualBankInfo, setManualBankInfo] = useState<ManualBankDetailsResponse | null>(null);
  // XM-style: all active banks to choose from + the currently selected one.
  const [manualBanks, setManualBanks] = useState<ManualBankDetailsResponse[]>([]);
  const [selectedBankId, setSelectedBankId] = useState<string | null>(null);
  // Unique payment reference the user must add in their bank transfer remark
  // so finance can match it (generated once per page load).
  const [depositReference] = useState(
    () => 'SWD-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
  );
  const [depositSubmitting, setDepositSubmitting] = useState(false);
  // Optional promo / bonus code typed at deposit time. Pending → admin
  // reviews + grants manually from the admin deposits page. Empty by
  // default; deposit goes through normally without any bonus request.
  const [depositBonusCode, setDepositBonusCode] = useState('');

  // Bonus overview block (Bonus chip in header jumps to /wallet#bonus).
  const [bonusOverview, setBonusOverview] = useState<BonusOverview | null>(null);
  const [bonusLoading, setBonusLoading] = useState(false);

  // Platform-wide wallet minimums (admin-tunable). Fetched from the
  // public /auth/platform-status so the form can show + enforce them
  // client-side before the request even leaves the page.
  const [minDeposit, setMinDeposit] = useState(50);
  const [minWithdraw, setMinWithdraw] = useState(70);
  // Auto crypto withdrawal threshold (0 = off) so the form can tell the user
  // which withdrawals go out instantly vs need review.
  const [cryptoAutoMax, setCryptoAutoMax] = useState(0);
  useEffect(() => {
    void (async () => {
      try {
        const s = await api.get<{ min_deposit_amount_usd?: number; min_withdrawal_amount_usd?: number; crypto_auto_withdrawal_enabled?: boolean; crypto_auto_withdrawal_max_usd?: number }>(
          '/auth/platform-status',
        );
        if (typeof s.min_deposit_amount_usd === 'number') setMinDeposit(s.min_deposit_amount_usd);
        if (typeof s.min_withdrawal_amount_usd === 'number') setMinWithdraw(s.min_withdrawal_amount_usd);
        if (s.crypto_auto_withdrawal_enabled && typeof s.crypto_auto_withdrawal_max_usd === 'number') {
          setCryptoAutoMax(s.crypto_auto_withdrawal_max_usd);
        }
      } catch { /* keep defaults */ }
    })();
  }, []);

  const [withdrawChannel, setWithdrawChannel] = useState<FundingChannel>('crypto');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawOxapayDetails, setWithdrawOxapayDetails] = useState('');
  const [manualWithdrawUpi, setManualWithdrawUpi] = useState('');
  const [manualWithdrawNotes, setManualWithdrawNotes] = useState('');
  const [manualWithdrawQrFile, setManualWithdrawQrFile] = useState<File | null>(null);
  const [withdrawSubmitting, setWithdrawSubmitting] = useState(false);
  // Bank withdrawal: local-currency estimate the user receives for their USD
  // amount, at the admin-fixed withdrawal rate (informational only).
  const [withdrawInr, setWithdrawInr] = useState<{ currency: string | null; local_amount: number | null } | null>(null);
  useEffect(() => {
    if (fundMainTab !== 'withdraw' || withdrawUiSection !== 'bank') { setWithdrawInr(null); return; }
    const n = parseFloat(withdrawAmount);
    if (Number.isNaN(n) || n <= 0) { setWithdrawInr(null); return; }
    const t = setTimeout(() => {
      api.get<{ currency: string | null; local_amount: number | null }>(`/wallet/withdraw/fx-quote?amount=${n}`)
        .then((q) => setWithdrawInr(q && q.local_amount != null ? q : null))
        .catch(() => setWithdrawInr(null));
    }, 400);
    return () => clearTimeout(t);
  }, [withdrawAmount, withdrawUiSection, fundMainTab]);

  /** Compact card transfers: trading ↔ main */
  const [balanceTransfer, setBalanceTransfer] = useState<{
    mode: 'to_main' | 'to_trading';
    tradingAccountId: string | null;
  } | null>(null);
  const [balanceTransferPickId, setBalanceTransferPickId] = useState('');
  const [balanceTransferAmount, setBalanceTransferAmount] = useState('');
  // Agreement to the credit-forfeit rule when a to-main transfer would drop the
  // trading balance below its bonus credit (client 2026-06-24).
  const [transferAgree, setTransferAgree] = useState(false);
  const [balanceTransferBusy, setBalanceTransferBusy] = useState(false);

  const fetchData = useCallback(
    async (isRefresh = false) => {
      const id = ++loadGen.current;
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setLoadError(null);

      try {
        const [summaryRes, wdRes, accountsRes] = await Promise.allSettled([
          api.get<WalletSummaryResponse>('/wallet/summary'),
          api.get<{ items?: WalletListItem[] }>('/wallet/withdrawals'),
          api.get<{ items?: AccountItem[] }>('/accounts'),
        ]);

        if (id !== loadGen.current) return;

        let currency = 'USD';
        let balance = 0;
        let mainWalletBalance = 0;
        let mainWalletBonus = 0;
        let bonusForfeitedAt: string | null = null;
        let totalDeposited = 0;
        let totalWithdrawn = 0;
        let totalLiveBalance: number | undefined;

        if (summaryRes.status === 'fulfilled' && summaryRes.value) {
          const s = summaryRes.value;
          const live = s.live_accounts || [];
          setLiveAccounts(live);
          mainWalletBalance = Number(s.main_wallet_balance) || 0;
          mainWalletBonus = Number(s.main_wallet_bonus) || 0;
          bonusForfeitedAt = s.bonus_forfeited_at ?? null;
          totalDeposited = Number(s.total_deposited) || 0;
          totalWithdrawn = Number(s.total_withdrawn) || 0;
          totalLiveBalance =
            typeof s.total_live_balance === 'number' ? s.total_live_balance : undefined;

          let targetId = selectedAccountId;
          if (!targetId || !live.some((a) => a.id === targetId)) {
            targetId =
              accountFromUrl && live.some((a) => a.id === accountFromUrl)
                ? accountFromUrl
                : live[0]?.id ?? null;
          }
          setSelectedAccountId(targetId);

          const sel = live.find((a) => a.id === targetId);
          balance = sel ? Number(sel.balance) || 0 : Number(s.balance) || 0;
          if (sel?.currency) currency = sel.currency;
        } else if (accountsRes.status === 'fulfilled') {
          const items = accountsRes.value?.items || [];
          const live = items.find((a) => a.is_demo === false) || items[0];
          if (live && typeof live.balance === 'number') balance = live.balance;
          if (summaryRes.status === 'rejected') {
            setLoadError('Wallet summary unavailable — balance from account only.');
            toast.error('Could not load wallet summary (totals may be incomplete).');
          }
        } else {
          const msg =
            summaryRes.status === 'rejected' && summaryRes.reason instanceof Error
              ? summaryRes.reason.message
              : 'Failed to load wallet';
          setLoadError(msg);
          toast.error(msg);
        }

        const wdItems =
          wdRes.status === 'fulfilled' ? wdRes.value?.items || [] : [];

        // Deposits always credit main wallet directly — no trading account required.
        setDemoFundingBlocked(false);

        if (wdRes.status === 'rejected') {
          toast.error('Could not load pending withdrawal count.');
        }

        const pendingWd = wdItems.filter(
          (w) => (w.status || '').toLowerCase() === 'pending',
        ).length;

        setWallet({
          balance,
          currency,
          main_wallet_balance: mainWalletBalance,
          main_wallet_bonus: mainWalletBonus,
          bonus_forfeited_at: bonusForfeitedAt,
          total_deposited: totalDeposited,
          total_withdrawn: totalWithdrawn,
          pending_withdrawals: pendingWd,
          total_live_balance: totalLiveBalance,
        });
      } catch (err) {
        if (id !== loadGen.current) return;
        const message = err instanceof Error ? err.message : 'Failed to load wallet';
        setLoadError(message);
        toast.error(message);
        setDemoFundingBlocked(false);
        setWallet({
          balance: 0,
          currency: 'USD',
          main_wallet_balance: 0,
          main_wallet_bonus: 0,
          bonus_forfeited_at: null,
          total_deposited: 0,
          total_withdrawn: 0,
          pending_withdrawals: 0,
        });
      } finally {
        if (id === loadGen.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [selectedAccountId, accountFromUrl],
  );

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: wallet?.currency || 'USD',
    }).format(n);

  const selectedDepositCrypto = CRYPTO_ASSETS.find((c) => c.id === selectedCryptoDeposit) ?? CRYPTO_ASSETS[0];
  const selectedWithdrawCrypto = CRYPTO_ASSETS.find((c) => c.id === selectedCryptoWithdraw) ?? CRYPTO_ASSETS[0];

  useEffect(() => {
    setDepositChannel(
      depositUiSection === 'crypto' ? 'crypto'
      : depositUiSection === 'p2p' ? 'p2p'
      : 'manual',
    );
  }, [depositUiSection]);

  useEffect(() => {
    setWithdrawChannel(
      withdrawUiSection === 'crypto' ? 'crypto'
      : withdrawUiSection === 'p2p' ? 'p2p'
      : 'manual',
    );
  }, [withdrawUiSection]);

  // If admin disables the section the user is currently on (e.g. they
  // had P2P open and admin just turned P2P off), snap them back to
  // Crypto so they're not staring at hidden content.
  useEffect(() => {
    if (depositUiSection === 'manual' && !methodFlags.manual) setDepositUiSection('crypto');
    if (depositUiSection === 'p2p' && !methodFlags.p2p) setDepositUiSection('crypto');
  }, [methodFlags, depositUiSection]);
  useEffect(() => {
    if (withdrawUiSection === 'bank' && !methodFlags.manual) setWithdrawUiSection('crypto');
    if (withdrawUiSection === 'p2p' && !methodFlags.p2p) setWithdrawUiSection('crypto');
  }, [methodFlags, withdrawUiSection]);

  const loadManualBankDetails = useCallback(async () => {
    try {
      const amt = parseFloat(depositAmount);
      // XM-style: fetch ALL active banks so the user can pick one.
      const qs = !Number.isNaN(amt) && amt > 0 ? `?amount=${amt}` : '';
      const res = await api.get<{ banks: ManualBankDetailsResponse[] }>(
        `/wallet/deposit/banks${qs}`,
      );
      const banks = Array.isArray(res?.banks) ? res.banks : [];
      setManualBanks(banks);
      // Keep the current selection if it's still in the list; else default to
      // the first bank.
      setSelectedBankId((prev) => {
        const keep = prev && banks.some((b) => b.id === prev) ? prev : (banks[0]?.id ?? null);
        const chosen = banks.find((b) => b.id === keep) ?? null;
        setManualBankInfo(chosen);
        return keep;
      });
    } catch {
      // Fallback to the legacy single-bank endpoint if the list isn't available.
      try {
        const amt = parseFloat(depositAmount);
        const body = !Number.isNaN(amt) && amt > 0 ? { amount: amt } : {};
        const d = await api.post<ManualBankDetailsResponse>('/wallet/deposit/bank-details', body);
        setManualBankInfo(d && Object.keys(d).length > 0 ? d : null);
        setManualBanks([]);
      } catch {
        setManualBankInfo(null);
        setManualBanks([]);
      }
    }
  }, [depositAmount]);

  const selectManualBank = useCallback((bank: ManualBankDetailsResponse) => {
    setSelectedBankId(bank.id ?? null);
    setManualBankInfo(bank);
  }, []);

  // Pre-fill the reference field with the generated code so it's submitted
  // (the user includes it in their bank transfer remark).
  useEffect(() => {
    setDepositTxId((prev) => prev || depositReference);
  }, [depositReference]);

  const scrollToFundPanel = () => {
    requestAnimationFrame(() => {
      fundPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const openDepositModal = () => {
    if (demoFundingBlocked) {
      toast.error(DEMO_FUNDING_MSG);
      return;
    }
    setDepositAmount('');
    setDepositTxId('');
    setDepositProofFile(null);
    setDepositBonusCode('');
    setDepositUiSection('crypto');
    setManualBankInfo(null);
    setFundMainTab('deposit');
    scrollToFundPanel();
  };

  const openWithdrawModal = () => {
    if (demoFundingBlocked) {
      toast.error(DEMO_FUNDING_MSG);
      return;
    }
    setWithdrawAmount('');
    setWithdrawOxapayDetails('');
    setWithdrawUiSection('crypto');
    setManualWithdrawUpi('');
    setManualWithdrawNotes('');
    setManualWithdrawQrFile(null);
    setFundMainTab('withdraw');
    scrollToFundPanel();
  };

  useEffect(() => {
    if (fundMainTab !== 'deposit' || depositUiSection !== 'manual') return;
    void loadManualBankDetails();
  }, [fundMainTab, depositUiSection, loadManualBankDetails]);

  // Bonus overview — fetched on mount + after the deposit form closes so
  // a freshly typed bonus_code shows up in the "Recent requests" list
  // immediately. Failure stays silent (the chip still works as a section
  // jump even if data isn't there yet).
  const loadBonusOverview = useCallback(async () => {
    setBonusLoading(true);
    try {
      const res = await api.get<BonusOverview>('/wallet/bonus/overview');
      setBonusOverview(res);
    } catch {
      /* ignore */
    } finally {
      setBonusLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBonusOverview();
  }, [loadBonusOverview]);

  // Scroll-to-anchor when the page is opened with /wallet#bonus (header
  // Bonus chip). Next.js's automatic hash scroll happens before the
  // section renders, so we re-trigger after the first paint.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.location.hash !== '#bonus') return;
    const id = window.setTimeout(() => {
      document.getElementById('bonus')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    }, 250);
    return () => window.clearTimeout(id);
  }, [bonusOverview]);

  /** Open withdraw modal from main wallet (?action=withdraw); external payouts use main balance only. */
  useEffect(() => {
    if (loading || withdrawDeepLinkHandled.current) return;
    const act = searchParams.get('action');
    if (!act || act.toLowerCase() !== 'withdraw') return;
    if (demoFundingBlocked) {
      withdrawDeepLinkHandled.current = true;
      toast.error(DEMO_FUNDING_MSG);
      const next = new URLSearchParams(searchParams.toString());
      next.delete('action');
      const qs = next.toString();
      router.replace(qs ? `/wallet?${qs}` : '/wallet', { scroll: false });
      return;
    }
    withdrawDeepLinkHandled.current = true;
    setFundMainTab('withdraw');
    setWithdrawUiSection('crypto');
    setWithdrawAmount('');
    setWithdrawOxapayDetails('');
    setManualWithdrawUpi('');
    setManualWithdrawNotes('');
    setManualWithdrawQrFile(null);
    scrollToFundPanel();
    const next = new URLSearchParams(searchParams.toString());
    next.delete('action');
    const qs = next.toString();
    router.replace(qs ? `/wallet?${qs}` : '/wallet', { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open once when deep-linked
  }, [loading, searchParams, router, demoFundingBlocked]);

  const submitWithdraw = async () => {
    if (demoFundingBlocked) {
      toast.error(DEMO_FUNDING_MSG);
      return;
    }
    const amt = parseFloat(withdrawAmount);
    if (!amt || amt <= 0) {
      toast.error('Enter a valid amount');
      return;
    }
    if (minWithdraw > 0 && amt < minWithdraw) {
      toast.error(`Minimum withdrawal is $${minWithdraw.toLocaleString()}.`);
      return;
    }
    if (withdrawChannel === 'crypto') {
      const detail = withdrawOxapayDetails.trim();
      if (!detail) {
        toast.error('Enter your wallet address or payout details');
        return;
      }
      const payout = [`[${selectedCryptoWithdraw}]`, detail].join(' ').trim();
      setWithdrawSubmitting(true);
      try {
        const res = await api.post<{ status?: string }>('/wallet/withdraw', {
          amount: amt,
          method: CRYPTO_WITHDRAW_METHOD,
          bank_details: { oxapay_payout: payout },
        });
        // Auto-withdrawals come back "processing" (sent to the payout provider);
        // manual ones come back "pending" (need admin approval).
        const isAuto = res?.status === 'processing';
        toast.success(
          isAuto
            ? `Withdrawal of $${amt.toLocaleString()} submitted — processing automatically`
            : `Withdrawal of $${amt.toLocaleString()} submitted — pending approval`,
        );
        // Reset so the user can't re-fire the same withdrawal.
        setWithdrawAmount('');
        setWithdrawOxapayDetails('');
        void fetchData(true);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Withdrawal failed');
      } finally {
        setWithdrawSubmitting(false);
      }
      return;
    }

    const upi = manualWithdrawUpi.trim();
    if (!upi && !manualWithdrawQrFile) {
      toast.error('Enter your bank details and/or upload a QR code for manual payout');
      return;
    }
    setWithdrawSubmitting(true);
    try {
      const fd = new FormData();
      fd.append('amount', String(amt));
      fd.append('upi_id', upi);
      fd.append('payout_notes', manualWithdrawNotes.trim());
      if (manualWithdrawQrFile) fd.append('file', manualWithdrawQrFile);
      const token = api.getToken();
      const res = await fetch('/api/v1/wallet/withdraw/manual/', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      const raw = await res.text();
      let json: { detail?: unknown; message?: string } = {};
      try {
        json = raw ? JSON.parse(raw) : {};
      } catch {
        throw new Error(raw.slice(0, 200) || `Request failed (${res.status})`);
      }
      if (!res.ok) {
        const d = json.detail;
        const msg =
          typeof d === 'string'
            ? d
            : Array.isArray(d)
              ? d.map((x: { msg?: string }) => x.msg).join(', ')
              : 'Withdrawal failed';
        throw new Error(msg);
      }
      toast.success(`Manual withdrawal of $${amt.toLocaleString()} submitted — pending approval`);
      // Reset so the user can't re-fire the same withdrawal request.
      setWithdrawAmount('');
      setManualWithdrawUpi('');
      setManualWithdrawNotes('');
      setManualWithdrawQrFile(null);
      void fetchData(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Withdrawal failed');
    } finally {
      setWithdrawSubmitting(false);
    }
  };

  // XM-style pre-deposit confirmation (client 2026-06-20): before a manual /
  // UPI deposit is submitted, show the "make sure you pay the exact amount and
  // submit the correct UTR" warning. Confirm then runs the real submit.
  const [showDepositConfirm, setShowDepositConfirm] = useState(false);
  const requestDepositConfirm = () => {
    if (demoFundingBlocked) { toast.error(DEMO_FUNDING_MSG); return; }
    const amt = parseFloat(depositAmount);
    if (!amt || amt <= 0) { toast.error('Enter a valid amount'); return; }
    if (minDeposit > 0 && amt < minDeposit) {
      toast.error(`Minimum deposit is $${minDeposit.toLocaleString()}.`); return;
    }
    if (!depositTxId.trim()) { toast.error('Enter your 12-digit UTR / payment reference'); return; }
    if (!depositProofFile) { toast.error('Please attach your payment screenshot'); return; }
    setShowDepositConfirm(true);
  };

  const submitDeposit = async () => {
    if (demoFundingBlocked) {
      toast.error(DEMO_FUNDING_MSG);
      return;
    }
    const amt = parseFloat(depositAmount);
    if (!amt || amt <= 0) {
      toast.error('Enter a valid amount');
      return;
    }
    if (minDeposit > 0 && amt < minDeposit) {
      toast.error(`Minimum deposit is $${minDeposit.toLocaleString()}.`);
      return;
    }
    if (depositChannel === 'crypto') {
      // NOWPayments hosted-checkout flow: backend creates an invoice and
      // returns payment_url. We redirect the browser to it; the user pays
      // on NOWPayments' page and the IPN webhook credits the deposit once
      // it confirms on-chain (no manual return-redirect needed — the user
      // can navigate back to /wallet anytime; the deposit will appear once
      // status flips to auto_approved server-side).
      setDepositSubmitting(true);
      try {
        // Intentionally do NOT send `crypto_currency` — leaving it unset
        // tells NOWPayments to show their hosted-page coin/network picker
        // so the user can choose USDT-BSC vs USDT-TRC20 vs USDC-BSC etc.
        // at checkout time. The picker only surfaces coins that are
        // enabled in the NOWPayments dashboard, so the operator controls
        // which networks are offered without touching this code.
        // Forward the promo code to the gateway so the deposit row is
        // stamped with bonus_code + bonus_status='pending'. Admin reviews
        // and grants on the deposits page after the IPN confirms.
        const _bonus = depositBonusCode.trim().toUpperCase();
        const resp = await api.post<{ id: string; status: string; payment_url?: string }>(
          '/wallet/deposit',
          {
            amount: amt,
            method: CRYPTO_DEPOSIT_METHOD,
            ...(_bonus ? { bonus_code: _bonus } : {}),
          },
        );
        if (resp.payment_url) {
          toast.success('Opening secure crypto checkout…');
          window.location.href = resp.payment_url;
          return;
        }
        toast.error('Could not start the payment — no checkout URL returned. Try again.');
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Could not start the payment';
        toast.error(msg);
      } finally {
        setDepositSubmitting(false);
      }
      return;
    }

    if (!depositTxId.trim()) {
      toast.error('Enter your payment reference');
      return;
    }
    // Payment screenshot is REQUIRED for manual/bank deposits (client
    // 2026-06-19) — finance needs proof of the transfer to credit it.
    if (!depositProofFile) {
      toast.error('Please attach your payment screenshot');
      return;
    }
    setDepositSubmitting(true);
    try {
      const fd = new FormData();
      fd.append('amount', String(amt));
      fd.append('transaction_id', depositTxId.trim());
      if (depositProofFile) fd.append('file', depositProofFile);
      const bonusTrim = depositBonusCode.trim();
      if (bonusTrim) fd.append('bonus_code', bonusTrim);
      const token = api.getToken();
      const res = await fetch('/api/v1/wallet/deposit/manual', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
        credentials: 'include',
      });
      const raw = await res.text();
      let json: { detail?: unknown; message?: string } = {};
      try {
        json = raw ? JSON.parse(raw) : {};
      } catch {
        throw new Error(raw.slice(0, 200) || `Request failed (${res.status})`);
      }
      if (!res.ok) {
        const d = json.detail;
        const msg =
          typeof d === 'string'
            ? d
            : Array.isArray(d)
              ? d.map((x: { msg?: string }) => x.msg).join(', ')
              : 'Deposit failed';
        throw new Error(msg);
      }
      toast.success(`Manual deposit of $${amt.toLocaleString()} submitted — pending approval`);
      // Reset the form after a successful submit so the user can't
      // accidentally fire the same deposit again (client report
      // 2026-05-28 — duplicate requests). Clearing the amount also
      // disables the Deposit button (it requires amt > 0).
      setDepositAmount('');
      setDepositTxId('');
      setDepositProofFile(null);
      setDepositBonusCode('');
      setManualBankInfo(null);
      void fetchData(true);
      void loadBonusOverview();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Deposit failed');
    } finally {
      setDepositSubmitting(false);
    }
  };

  const openTransferToMain = (tradingAccountId: string) => {
    if (demoFundingBlocked) {
      toast.error(DEMO_FUNDING_MSG);
      return;
    }
    setBalanceTransfer({ mode: 'to_main', tradingAccountId });
    setBalanceTransferAmount('');
    // Refresh the account list so a just-created account is selectable without
    // a manual page refresh (client 2026-06-25).
    void fetchData(true);
  };

  const openTransferFromMain = (tradingAccountId: string | null) => {
    if (demoFundingBlocked) {
      toast.error(DEMO_FUNDING_MSG);
      return;
    }
    setBalanceTransfer({ mode: 'to_trading', tradingAccountId });
    setBalanceTransferAmount('');
    void fetchData(true);
    const pick =
      tradingAccountId ??
      (selectedAccountId && liveAccounts.some((a) => a.id === selectedAccountId)
        ? selectedAccountId
        : liveAccounts[0]?.id) ??
      '';
    setBalanceTransferPickId(pick);
  };

  const closeBalanceTransfer = () => {
    setBalanceTransfer(null);
    setBalanceTransferAmount('');
    setBalanceTransferBusy(false);
    setTransferAgree(false);
  };

  const submitBalanceTransfer = async () => {
    if (demoFundingBlocked) {
      toast.error(DEMO_FUNDING_MSG);
      return;
    }
    if (!balanceTransfer) return;
    const tradingId =
      balanceTransfer.mode === 'to_main'
        ? balanceTransfer.tradingAccountId
        : balanceTransfer.tradingAccountId ?? balanceTransferPickId;
    if (!tradingId) {
      toast.error('Select a trading account');
      return;
    }
    const amt = parseFloat(balanceTransferAmount);
    if (!amt || amt <= 0) {
      toast.error('Enter a valid amount');
      return;
    }
    // Cent accounts display + accept ¢; the backend works in USD. Convert the
    // entered ¢ amount to USD (÷100) so e.g. ¢500 from a cent account lands as
    // $5.00 in the main wallet (client 2026-06-23).
    const txAccount = liveAccounts.find((a) => a.id === tradingId);
    const txIsCent = isCentAccount(txAccount);
    const usdAmt = txIsCent ? amt / CENT_PER_USD : amt;
    const enteredLabel = txIsCent ? `${CENT_SYMBOL}${amt.toLocaleString()}` : `$${amt.toLocaleString()}`;
    setBalanceTransferBusy(true);
    try {
      if (balanceTransfer.mode === 'to_main') {
        await api.post('/wallet/transfer-trading-to-main', {
          from_account_id: tradingId,
          amount: usdAmt,
        });
        toast.success(
          txIsCent
            ? `${enteredLabel} moved to main wallet ($${usdAmt.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`
            : `${enteredLabel} moved to main wallet`,
        );
      } else {
        await api.post('/wallet/transfer-main-to-trading', {
          to_account_id: tradingId,
          amount: usdAmt,
        });
        const num = liveAccounts.find((a) => a.id === tradingId)?.account_number ?? '';
        toast.success(`${enteredLabel} sent to ${num || 'trading account'}`);
      }
      closeBalanceTransfer();
      void fetchData(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Transfer failed');
      setBalanceTransferBusy(false);
    }
  };

  // Selected account for the transfer modal — drives ¢ vs $ rendering.
  const transferAccount = balanceTransfer
    ? liveAccounts.find((a) => a.id === (balanceTransfer.tradingAccountId ?? balanceTransferPickId))
    : undefined;
  const transferIsCent = isCentAccount(transferAccount);

  // Credit-forfeit rule (to-main transfers only): the bonus credit must stay
  // backed by real balance. Work out whether the typed amount would drop the
  // balance below the credit — if so we warn + require agreement.
  const transferCreditUsd = Number(transferAccount?.credit) || 0;
  const transferBalanceUsd = Number(transferAccount?.balance) || 0;
  const transferAmtUsd = (() => {
    const v = parseFloat(balanceTransferAmount);
    if (Number.isNaN(v) || v <= 0) return 0;
    return transferIsCent ? v / CENT_PER_USD : v;
  })();
  const transferWouldForfeit =
    !!balanceTransfer &&
    balanceTransfer.mode === 'to_main' &&
    transferCreditUsd > 0 &&
    (transferBalanceUsd - transferAmtUsd) < transferCreditUsd;
  // Heads-up when a to-main transfer would empty the trading account (balance
  // → 0). Only when there's no bonus credit, since the credit-forfeit block
  // already warns in that case (client 2026-06-26).
  const transferWouldEmpty =
    !!balanceTransfer &&
    balanceTransfer.mode === 'to_main' &&
    transferCreditUsd <= 0 &&
    transferAmtUsd > 0 &&
    (transferBalanceUsd - transferAmtUsd) <= 0.005;

  if (loading) {
    return (
      <DashboardShell mainClassName="flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 py-12">
          <div className="w-8 h-8 border-2 border-[#55a630] border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-text-secondary">Loading wallet...</span>
        </div>
      </DashboardShell>
    );
  }

  if (isDemo) {
    return (
      <DashboardShell>
        <DemoLockGate
          feature="Deposits & Withdrawals"
          description="Funding is only available on real trading accounts. Register a live account to deposit, withdraw and transfer funds."
        >
          <></>
        </DemoLockGate>
      </DashboardShell>
    );
  }

  return (
    <DashboardShell mainClassName="flex flex-col min-h-0 overflow-hidden p-0">
      <div className="dashboard-main-scroll flex-1 min-h-0 min-w-0 overflow-y-auto bg-bg-base">
        <div className="w-full max-w-full space-y-4 sm:space-y-6 px-2.5 sm:px-4 py-3 sm:py-4 pb-24 md:px-6 md:py-6">
          {/* Crucial-ui style page header */}
          <div className="mb-2 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-xl font-bold text-text-primary">Wallet</h1>
              <p className="text-sm text-text-secondary mt-1 max-w-xl">
                Manage deposits and withdrawals. Approved funds credit your main wallet.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void fetchData(true)}
              disabled={refreshing}
              className={clsx(
                'p-2 rounded-lg bg-card border border-border-primary hover:bg-bg-hover transition-all active:scale-95 shrink-0',
                refreshing && 'animate-spin cursor-not-allowed opacity-50',
              )}
              aria-label="Refresh wallet"
            >
              <RefreshCcw className="w-4 h-4 text-text-secondary" />
            </button>
          </div>

          {loadError && (
            <div className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-text-primary">
              {loadError}
            </div>
          )}

          {demoFundingBlocked && (
            <div className="rounded-xl border border-sell/30 bg-sell/10 px-3 py-2.5 text-xs text-text-primary">
              <p className="font-bold text-sell">Demo account — funding disabled</p>
              <p className="text-text-secondary mt-1 leading-relaxed">{DEMO_FUNDING_MSG}</p>
            </div>
          )}

          {/* ── Account Cards Grid ── */}
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2 sm:gap-3 md:gap-4">
              {/* ── Main Wallet Card ── */}
              <div
                className="relative group rounded-2xl overflow-hidden transition-all duration-300 hover:scale-[1.02]"
                style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-accent)',
                  boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
                }}
              >
                <div className="absolute top-0 right-0 w-24 h-24 rounded-bl-[60px] bg-[#55a630]/[0.04] group-hover:bg-[#55a630]/[0.08] transition-colors duration-500" />
                <div className="relative p-3 sm:p-4 md:p-5 flex flex-col gap-2.5 sm:gap-3">
                  <div className="flex items-center justify-between">
                    <div
                      className="w-9 h-9 sm:w-11 sm:h-11 rounded-lg sm:rounded-xl flex items-center justify-center border border-[#55a630]/25"
                      style={{ background: 'linear-gradient(135deg, rgba(85,166,48,0.18) 0%, rgba(85,166,48,0.05) 100%)' }}
                    >
                      <WalletIcon className="h-4 w-4 sm:h-5 sm:w-5 text-[#55a630]" strokeWidth={2} style={{ filter: 'drop-shadow(0 0 6px rgba(85,166,48,0.5))' }} />
                    </div>
                    {(wallet?.pending_withdrawals ?? 0) > 0 && (
                      <span className="text-[10px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-full px-2 py-0.5">
                        {wallet?.pending_withdrawals} pending
                      </span>
                    )}
                  </div>
                  <div>
                    <p className="text-[9px] sm:text-[10px] font-bold uppercase tracking-widest text-[#55a630]/60 mb-0.5 sm:mb-1">Main Wallet</p>
                    <p className="text-sm sm:text-lg md:text-xl font-bold tabular-nums font-mono text-text-primary truncate">
                      {fmt(wallet?.main_wallet_balance ?? 0)}
                    </p>
                    {/* Bonus credit lives next to the cash balance so the
                        user understands at a glance which portion is
                        withdrawable. Bonus is tradeable but cleared on
                        the first withdrawal (migration 0056). */}
                    {(wallet?.main_wallet_bonus ?? 0) > 0 && (
                      <div className="mt-1.5 pt-1.5 border-t border-[#55a630]/10">
                        <p className="text-[8px] sm:text-[9px] font-bold uppercase tracking-widest text-amber-400/70 mb-0.5">
                          Bonus credit
                        </p>
                        <p className="text-xs sm:text-sm font-bold tabular-nums font-mono text-amber-400 truncate">
                          {fmt(wallet?.main_wallet_bonus ?? 0)}
                        </p>
                        <p className="text-[8px] sm:text-[9px] text-text-tertiary mt-0.5 leading-tight">
                          Tradeable, not withdrawable. Cleared on first withdrawal.
                        </p>
                      </div>
                    )}
                    {wallet?.bonus_forfeited_at && (wallet?.main_wallet_bonus ?? 0) === 0 && (
                      <p className="mt-1.5 pt-1.5 border-t border-text-tertiary/10 text-[8px] sm:text-[9px] text-text-tertiary leading-tight">
                        Welcome-bonus eligibility used (forfeited on first withdrawal).
                      </p>
                    )}
                  </div>
                  {liveAccounts.length > 0 && (
                    <button
                      type="button"
                      onClick={() => openTransferFromMain(liveAccounts.length === 1 ? liveAccounts[0].id : null)}
                      disabled={demoFundingBlocked}
                      title="Add to trading account"
                      className="flex w-full items-center justify-center gap-1.5 rounded-xl py-2.5 text-[11px] font-bold transition-all bg-[#55a630]/10 text-[#55a630] border border-[#55a630]/20 hover:bg-[#55a630]/20 hover:border-[#55a630]/40 disabled:opacity-40 disabled:pointer-events-none"
                    >
                      <ArrowUpFromLine className="h-3.5 w-3.5 shrink-0" strokeWidth={2.25} />
                      To Trading
                    </button>
                  )}
                </div>
              </div>

              {/* ── Live Account Cards ── */}
              {liveAccounts.map((a) => {
                const cur = a.currency || wallet?.currency || 'USD';
                const bal = Number(a.balance) || 0;
                const line = isCentAccount(a)
                  ? fmtAccountMoney(bal, true)
                  : new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(bal);
                const isSel = a.id === selectedAccountId;
                const num = a.account_number || '';
                const isManaged = num.startsWith('IF') || num.startsWith('CF');
                const isPool = num.startsWith('PM') || num.startsWith('MM') || num.startsWith('CT');
                const cardLabel = num.startsWith('IF') ? 'PAMM Investment'
                  : num.startsWith('CF') ? 'MAM Account'
                  : num.startsWith('PM') ? 'PAMM Master Pool'
                  : num.startsWith('CT') ? 'MAM Master Pool'
                  : num;
                const ac = isManaged ? { r: '245,158,11', hex: '#f59e0b' } : isPool ? { r: '168,85,247', hex: '#a855f7' } : { r: '85,166,48', hex: '#55a630' };

                return (
                  <div
                    key={a.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Trading account ${num}`}
                    onClick={() => setSelectedAccountId(a.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedAccountId(a.id); } }}
                    className={clsx(
                      'relative group rounded-2xl overflow-hidden transition-all duration-300 cursor-pointer outline-none hover:scale-[1.02]',
                      isSel && 'ring-2 ring-[#55a630]/30',
                    )}
                    style={{
                      background: 'var(--bg-card)',
                      border: `1px solid rgba(${ac.r},${isSel ? 0.35 : 0.15})`,
                      boxShadow: isSel ? `0 2px 12px rgba(${ac.r},0.1)` : '0 2px 12px rgba(0,0,0,0.06)',
                    }}
                  >
                    <div className="absolute top-0 right-0 w-24 h-24 rounded-bl-[60px] transition-colors duration-500"
                      style={{ background: `rgba(${ac.r},0.03)` }}
                    />
                    <div className="relative p-3 sm:p-4 md:p-5 flex flex-col gap-2.5 sm:gap-3">
                      <div className="flex items-center justify-between">
                        <div
                          className="w-9 h-9 sm:w-11 sm:h-11 rounded-lg sm:rounded-xl flex items-center justify-center"
                          style={{ background: `linear-gradient(135deg, rgba(${ac.r},0.18) 0%, rgba(${ac.r},0.05) 100%)`, border: `1px solid rgba(${ac.r},0.22)` }}
                        >
                          <TrendingUp className="h-4 w-4 sm:h-5 sm:w-5" strokeWidth={2} style={{ color: ac.hex, filter: `drop-shadow(0 0 6px rgba(${ac.r},0.5))` }} />
                        </div>
                      </div>
                      <div>
                        <p className="text-[9px] sm:text-[10px] font-bold uppercase tracking-widest mb-0.5 sm:mb-1 truncate" style={{ color: `rgba(${ac.r},0.6)` }}>
                          {cardLabel}
                        </p>
                        <p className="text-sm sm:text-lg md:text-xl font-bold tabular-nums font-mono text-text-primary truncate">{line}</p>
                      </div>
                      {isManaged ? (
                        // CF / IF investor sub-account — engine-driven,
                        // user can't manually shuffle funds in/out.
                        <div className="flex items-center justify-center rounded-xl border py-2 text-[10px] font-bold tracking-wide"
                          style={{ borderColor: `rgba(${ac.r},0.15)`, color: `rgba(${ac.r},0.5)`, background: `rgba(${ac.r},0.04)` }}
                        >
                          Managed
                        </div>
                      ) : isPool ? (
                        // PM / CT / MM master pool — funds belong to
                        // investors, master cannot drain to main wallet
                        // (backend also enforces; this just hides the
                        // useless / dangerous button). Client report
                        // 2026-06-01: "pamm master fund transfer kar pa
                        // raha hai... pool amount sab withdraw le lega".
                        <div className="flex items-center justify-center rounded-xl border py-2 text-[10px] font-bold tracking-wide"
                          style={{ borderColor: `rgba(${ac.r},0.15)`, color: `rgba(${ac.r},0.5)`, background: `rgba(${ac.r},0.04)` }}
                          title="Pool funds belong to investors — not transferable to your main wallet"
                        >
                          Pool (held for investors)
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); openTransferToMain(a.id); }}
                            disabled={demoFundingBlocked}
                            title="Move to main wallet"
                            className="flex flex-1 items-center justify-center gap-1 rounded-xl border border-border-primary bg-bg-hover/40 py-2 text-[10px] font-semibold text-text-tertiary hover:bg-bg-hover hover:text-accent hover:border-accent/25 transition-all disabled:opacity-40"
                          >
                            <ArrowDownToLine className="h-3 w-3" strokeWidth={2.25} />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); openTransferFromMain(a.id); }}
                            disabled={demoFundingBlocked}
                            title="Add from main wallet"
                            className="flex flex-1 items-center justify-center gap-1 rounded-xl border border-border-primary bg-bg-hover/40 py-2 text-[10px] font-semibold text-text-tertiary hover:bg-bg-hover hover:text-accent hover:border-accent/25 transition-all disabled:opacity-40"
                          >
                            <ArrowUpFromLine className="h-3 w-3" strokeWidth={2.25} />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {liveAccounts.length > 1 && wallet?.total_live_balance != null &&
              Math.abs((wallet.total_live_balance ?? 0) - (wallet.balance || 0)) > 0.009 && (
              <p className="px-1 text-[11px] text-text-tertiary">
                All live accounts total:{' '}
                <span className="font-mono font-semibold text-text-secondary">
                  {new Intl.NumberFormat('en-US', { style: 'currency', currency: wallet?.currency || 'USD' }).format(wallet.total_live_balance)}
                </span>
              </p>
            )}
          </div>

          <div
            ref={fundPanelRef}
            id="wallet-fund-panel"
            className="scroll-mt-24 overflow-hidden rounded-xl border border-border-primary bg-card"
          >
            {/* Curved “crucial” tab shell — slides with spring; no mid-tab seam */}
            <div className="relative flex min-h-[52px] border-b border-border-primary bg-card">
              <div
                className="pointer-events-none absolute inset-0 z-0"
                aria-hidden
              >
                <div
                  className="absolute top-0 h-full w-1/2 transition-[transform] duration-500 ease-[cubic-bezier(0.34,1.45,0.64,1)] will-change-transform"
                  style={{
                    transform:
                      fundMainTab === 'deposit' ? 'translate3d(0,0,0)' : 'translate3d(100%,0,0)',
                  }}
                >
                  <div
                    className={clsx(
                      'absolute inset-x-1.5 top-0 h-full rounded-t-2xl border-2 border-b-0 border-accent bg-card-nested',
                      'animate-wallet-main-tab-glow',
                    )}
                  />
                </div>
              </div>
              {(['deposit', 'withdraw'] as const).map((t) => {
                const active = fundMainTab === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setFundMainTab(t)}
                    className={clsx(
                      'relative z-10 flex-1 border-0 bg-transparent py-3.5 text-sm font-semibold capitalize outline-none',
                      'transition-colors duration-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/50',
                      active ? 'text-accent' : 'text-text-secondary hover:text-text-primary',
                    )}
                  >
                    {active ? (
                      <span
                        key={fundMainTab}
                        className="relative inline-block animate-wallet-main-tab-text drop-shadow-[0_0_20px_rgba(85,166,48,0.7)]"
                      >
                        {t === 'deposit' ? 'Deposit' : 'Withdraw'}
                      </span>
                    ) : (
                      <span className="relative inline-block">{t === 'deposit' ? 'Deposit' : 'Withdraw'}</span>
                    )}
                  </button>
                );
              })}
            </div>

            <div
              key={fundMainTab}
              className="space-y-5 bg-card-nested p-4 md:p-6 animate-wallet-fund-enter-lg"
            >
              {fundMainTab === 'deposit' ? (
                <>
                  {/* Header */}
                  <div className="flex items-start gap-3">
                    <div className="w-11 h-11 rounded-xl bg-accent/10 flex items-center justify-center shrink-0 border border-accent/20">
                      <ArrowDownToLine className="w-5 h-5 text-accent" />
                    </div>
                    <div>
                      <h2 className="text-lg font-bold text-text-primary">Deposit funds</h2>
                      <p className="text-sm text-text-secondary">Add funds to your wallet or accounts</p>
                    </div>
                  </div>

                  {/* Deposit To */}
                  <div>
                    <p className="text-xs text-text-tertiary mb-2 font-medium uppercase tracking-wide">Deposit To</p>
                    <button
                      type="button"
                      className="w-full py-3.5 rounded-xl bg-[#55a630] text-white font-bold text-sm flex items-center justify-center gap-2"
                    >
                      <WalletIcon className="w-4 h-4" />
                      Wallet
                    </button>
                  </div>

                  {/* Deposit Method Tabs — manual + p2p are admin-gated */}
                  <div className="flex gap-2 border-b border-border-glass overflow-x-auto">
                    {(['crypto', 'manual', 'p2p'] as const)
                      .filter((m) => m === 'crypto' || methodFlags[m])
                      .map((method) => {
                      const active = depositUiSection === method;
                      return (
                        <button
                          key={method}
                          type="button"
                          onClick={() => {
                            // Bank / UPI deposit opens the XM-style multi-step
                            // methods flow (admin-configured QR/UPI/bank per
                            // method, live INR->USD). Crypto stays inline (client
                            // 2026-06-24/26).
                            if (method === 'manual') { router.push('/wallet/deposit/methods'); return; }
                            setDepositUiSection(method);
                          }}
                          className={clsx(
                            'px-4 py-2.5 text-sm font-semibold transition-all border-b-2 whitespace-nowrap',
                            active
                              ? 'border-accent text-accent'
                              : 'border-transparent text-text-tertiary hover:text-text-primary'
                          )}
                        >
                          {method === 'crypto'
                            ? 'Crypto'
                            : method === 'manual'
                            ? 'Bank Deposit'
                            : 'Request to RM'}
                        </button>
                      );
                    })}
                  </div>

                  {depositUiSection === 'p2p' ? (
                    <P2PMarketplace mode="buy" />
                  ) : depositUiSection === 'crypto' ? (
                    <>
                      {/* Crypto deposit via NOWPayments wallet-connect modal */}
                      <div className="space-y-1">
                        <label className="text-xs text-text-secondary">
                          Amount (USD)
                          {minDeposit > 0 && (
                            <span className="text-text-tertiary"> · min ${minDeposit.toLocaleString()}</span>
                          )}
                        </label>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary font-bold">$</span>
                          <input
                            type="number"
                            min="1"
                            step="0.01"
                            value={depositAmount}
                            onChange={(e) => setDepositAmount(e.target.value)}
                            placeholder="0.00"
                            className="w-full pl-7 pr-4 py-3 rounded-xl border border-border-primary bg-bg-secondary text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 font-mono font-bold text-lg"
                          />
                        </div>
                      </div>

                      <div className="rounded-xl border border-accent/20 bg-accent/5 px-4 py-3">
                        <p className="text-xs text-text-secondary leading-relaxed">
                          You&apos;ll be taken to a secure crypto checkout. Choose the coin and network you want to pay with there (USDT on BSC / TRC-20, USDC, BNB, etc.), then send the amount from your wallet (MetaMask, Trust, Binance, etc.). Once the transaction confirms on-chain, your wallet balance is credited automatically.
                        </p>
                      </div>

                      {/* Promo / bonus code — mirrors the field on the Manual
                          tab. Backend already accepts `bonus_code` on
                          /wallet/deposit (admin reviews + grants on approval),
                          this just surfaces it to crypto-paying users too. */}
                      <div className="space-y-1 min-w-0">
                        <label className="text-xs text-text-secondary">
                          Bonus / promo code <span className="text-text-tertiary text-[10px]">(optional)</span>
                        </label>
                        <input
                          type="text"
                          value={depositBonusCode}
                          onChange={(e) => setDepositBonusCode(e.target.value.toUpperCase())}
                          placeholder="e.g. SD100"
                          maxLength={40}
                          className="w-full px-4 py-3 rounded-xl border border-border-primary bg-bg-secondary text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 font-mono text-sm"
                        />
                        <p className="text-[10px] text-text-tertiary mt-1">
                          Have a promo code? Type it here. Admin will review your request and credit the bonus separately to your main wallet once the deposit confirms.
                        </p>
                      </div>

                      <button
                        type="button"
                        onClick={() => void submitDeposit()}
                        disabled={demoFundingBlocked || depositSubmitting || !depositAmount}
                        className={clsx(
                          'w-full py-3.5 rounded-xl font-bold text-base transition-all active:scale-[0.99]',
                          demoFundingBlocked || depositSubmitting || !depositAmount
                            ? 'bg-bg-hover text-text-tertiary cursor-not-allowed'
                            : 'bg-accent text-white hover:bg-[#5cffb8] shadow-neon-green-lg'
                        )}
                      >
                        {depositSubmitting ? 'Opening checkout…' : 'Pay with Crypto'}
                      </button>
                    </>
                  ) : (
                    <>
                      {/* Manual deposit — amount + bank details + proof */}
                      <div className="space-y-1">
                        <label className="text-xs text-text-secondary">
                          Amount (USD)
                          {minDeposit > 0 && (
                            <span className="text-text-tertiary"> · min ${minDeposit.toLocaleString()}</span>
                          )}
                        </label>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary font-bold">$</span>
                          <input
                            type="number"
                            min="1"
                            step="0.01"
                            value={depositAmount}
                            onChange={(e) => setDepositAmount(e.target.value)}
                            onBlur={() => void loadManualBankDetails()}
                            placeholder="0.00"
                            className="w-full pl-7 pr-4 py-3 rounded-xl border border-border-primary bg-bg-secondary text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 font-mono font-bold text-lg"
                          />
                        </div>
                      </div>

                      <div className="rounded-xl border border-border-primary bg-bg-secondary px-3 py-3 sm:px-4 space-y-2 min-w-0">
                        <p className="text-xs font-bold text-text-primary">Pay to this account (from admin)</p>
                        {/* XM-style bank picker — choose which bank to pay. */}
                        {manualBanks.length > 1 ? (
                          <div className="grid grid-cols-2 gap-2">
                            {manualBanks.map((b) => (
                              <button
                                key={b.id}
                                type="button"
                                onClick={() => selectManualBank(b)}
                                className={clsx(
                                  'text-left px-3 py-2 rounded-lg border text-[11px] transition-colors min-w-0',
                                  selectedBankId === b.id
                                    ? 'border-accent bg-accent/10 text-text-primary'
                                    : 'border-border-primary bg-bg-base hover:border-accent/40 text-text-secondary',
                                )}
                              >
                                <span className="block font-semibold truncate">{b.bank_name || 'Bank'}</span>
                                <span className="block font-mono text-[10px] text-text-tertiary truncate">{b.account_number}</span>
                              </button>
                            ))}
                          </div>
                        ) : null}
                        {/* Unique payment reference — finance matches this. */}
                        <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2">
                          <p className="text-[10px] uppercase tracking-wide text-amber-500/90 font-sans">
                            Payment reference — add this in your transfer remark
                          </p>
                          <p className="font-mono font-bold text-sm text-text-primary select-all break-all">{depositReference}</p>
                        </div>
                        {manualBankInfo && (manualBankInfo.bank_name || manualBankInfo.account_number) ? (
                          <div className="text-[11px] sm:text-xs text-text-secondary font-mono min-w-0 space-y-2">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
                              {manualBankInfo.bank_name ? (
                                <p className="break-words">
                                  <span className="text-text-tertiary font-sans text-[10px] uppercase tracking-wide">Bank</span>
                                  <br />
                                  {manualBankInfo.bank_name}
                                </p>
                              ) : null}
                              {manualBankInfo.account_holder ? (
                                <p className="break-words">
                                  <span className="text-text-tertiary font-sans text-[10px] uppercase tracking-wide">Holder</span>
                                  <br />
                                  {manualBankInfo.account_holder}
                                </p>
                              ) : null}
                              {manualBankInfo.account_number ? (
                                <p className="break-all">
                                  <span className="text-text-tertiary font-sans text-[10px] uppercase tracking-wide">A/C</span>
                                  <br />
                                  {manualBankInfo.account_number}
                                </p>
                              ) : null}
                              {manualBankInfo.ifsc_code ? (
                                <p className="break-all">
                                  <span className="text-text-tertiary font-sans text-[10px] uppercase tracking-wide">IFSC</span>
                                  <br />
                                  {manualBankInfo.ifsc_code}
                                </p>
                              ) : null}
                              {manualBankInfo.upi_id ? (
                                <p className="break-all sm:col-span-2">
                                  <span className="text-text-tertiary font-sans text-[10px] uppercase tracking-wide">UPI ID — pay here</span>
                                  <br />
                                  <span className="inline-flex items-center gap-2">
                                    <span className="font-bold text-text-primary select-all">{manualBankInfo.upi_id}</span>
                                    <button
                                      type="button"
                                      onClick={() => { navigator.clipboard?.writeText(manualBankInfo.upi_id || ''); toast.success('UPI ID copied'); }}
                                      className="text-[10px] font-sans font-semibold text-[#55a630] hover:underline"
                                    >
                                      Copy
                                    </button>
                                  </span>
                                </p>
                              ) : null}
                            </div>
                            {manualBankInfo.qr_code_url ? (
                              <div className="pt-1 flex justify-center">
                                <img
                                  src={manualBankInfo.qr_code_url}
                                  alt="Payment QR"
                                  className="w-full max-w-[220px] max-h-48 object-contain rounded-lg border border-border-primary bg-bg-base"
                                />
                              </div>
                            ) : null}
                          </div>
                        ) : (
                          <p className="text-[11px] text-amber-500/90">
                            No bank details configured yet. Enter amount and refresh, or contact support.
                          </p>
                        )}
                        <button
                          type="button"
                          onClick={() => void loadManualBankDetails()}
                          className="text-[10px] font-semibold text-[#55a630] hover:underline"
                        >
                          Refresh bank details
                        </button>
                      </div>
                      <div className="space-y-1 min-w-0">
                        <label className="text-xs text-text-secondary">
                          Reference / transaction ID <span className="text-red-400">*</span>
                          <span className="text-text-tertiary font-normal"> — pre-filled with your payment reference; you can add your bank UTR too</span>
                        </label>
                        <input
                          type="text"
                          value={depositTxId}
                          onChange={(e) => setDepositTxId(e.target.value)}
                          placeholder="Payment reference (and optional bank UTR)"
                          className="w-full px-4 py-3 rounded-xl border border-border-primary bg-bg-secondary text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 font-mono text-sm"
                        />
                      </div>
                      <div className="space-y-1 min-w-0">
                        <label className="text-xs text-text-secondary">
                          Payment screenshot <span className="text-danger">*</span>
                        </label>
                        <label
                          className={clsx(
                            'flex flex-col items-center justify-center w-full min-w-0 py-5 sm:py-6 px-2 rounded-xl border-2 border-dashed cursor-pointer transition-all',
                            depositProofFile
                              ? 'border-accent/40 bg-accent/5'
                              : 'border-border-primary hover:border-accent/30',
                          )}
                        >
                          <input
                            type="file"
                            accept=".jpg,.jpeg,.png,.pdf,.webp"
                            className="hidden"
                            onChange={(e) => setDepositProofFile(e.target.files?.[0] ?? null)}
                          />
                          {depositProofFile ? (
                            <span className="text-sm font-medium text-[#55a630] px-2 text-center">{depositProofFile.name}</span>
                          ) : (
                            <span className="text-xs text-[#666]">JPG, PNG, PDF, WEBP — max 10 MB</span>
                          )}
                        </label>
                      </div>
                      <div className="space-y-1 min-w-0">
                        <label className="text-xs text-text-secondary">
                          Bonus / promo code <span className="text-text-tertiary text-[10px]">(optional)</span>
                        </label>
                        <input
                          type="text"
                          value={depositBonusCode}
                          onChange={(e) => setDepositBonusCode(e.target.value.toUpperCase())}
                          placeholder="e.g. SD100"
                          maxLength={40}
                          className="w-full px-4 py-3 rounded-xl border border-border-primary bg-bg-secondary text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 font-mono text-sm"
                        />
                        <p className="text-[10px] text-text-tertiary mt-1">
                          Have a promo code? Type it here. Admin will review your request and credit the bonus separately to your main wallet.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={requestDepositConfirm}
                        disabled={
                          demoFundingBlocked ||
                          depositSubmitting ||
                          !depositAmount ||
                          !depositTxId.trim() ||
                          !depositProofFile
                        }
                        className={clsx(
                          'w-full py-3.5 rounded-xl font-bold text-base transition-all active:scale-[0.99]',
                          demoFundingBlocked ||
                            depositSubmitting ||
                            !depositAmount ||
                            !depositTxId.trim() ||
                            !depositProofFile
                            ? 'bg-bg-hover text-text-tertiary cursor-not-allowed'
                            : 'bg-accent text-white hover:bg-[#5cffb8] shadow-neon-green-lg',
                        )}
                      >
                        {depositSubmitting ? 'Submitting…' : `Deposit${depositAmount ? ` — $${parseFloat(depositAmount || '0').toLocaleString()}` : ''}`}
                      </button>
                    </>
                  )}
                </>
              ) : (
                <>
                  {/* Withdraw header */}
                  <div className="flex items-start gap-3">
                    <div className="w-11 h-11 rounded-xl bg-accent/10 flex items-center justify-center shrink-0 border border-accent/20">
                      <ArrowUpFromLine className="w-5 h-5 text-accent" />
                    </div>
                    <div>
                      <h2 className="text-lg font-bold text-text-primary">Withdraw funds</h2>
                      <p className="text-sm text-text-secondary">Withdraw from your main wallet</p>
                    </div>
                  </div>

                  {/* Wallet balance */}
                  <div className="rounded-xl border border-border-primary bg-bg-secondary p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-text-tertiary mb-1">Wallet Balance</p>
                    <p className="text-xl font-mono font-bold text-text-primary tabular-nums">
                      {fmt(wallet?.main_wallet_balance ?? 0)}
                    </p>
                  </div>

                  <p className="text-xs text-text-tertiary leading-relaxed">
                    Withdrawals are sent from your <span className="text-text-primary font-medium">main wallet</span> only. Ensure the amount
                    you need is available on the main wallet before requesting a payout.
                  </p>

                  {/* First-withdrawal forfeiture warning — the welcome
                      bonus disappears on first approved withdrawal. Only
                      shown when the user actually has pending bonus
                      (main wallet OR any account credit) and hasn't
                      already forfeited it. */}
                  {!wallet?.bonus_forfeited_at &&
                    ((wallet?.main_wallet_bonus ?? 0) > 0 ||
                      liveAccounts.some((a) => Number(a.credit) > 0)) && (
                      <div className="rounded-xl border border-amber-500/40 bg-amber-500/[0.07] p-3 flex gap-2.5">
                        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                        <div className="text-[11px] text-amber-200/90 leading-relaxed">
                          <span className="font-bold text-amber-300">Heads-up — bonus forfeiture.</span>{' '}
                          You currently have a welcome bonus credit. Submitting your
                          first withdrawal clears it immediately (both main-wallet bonus
                          and any bonus credit currently on a trading account). Trading
                          profits already in your account balance are unaffected.
                        </div>
                      </div>
                    )}

                  {/* Payment method sub-tabs — bank + p2p are admin-gated.
                      'bank' maps to the same wallet.manual_enabled flag as
                      the deposit-side 'manual' since both consume the same
                      finance-team manual rail. */}
                  <div className="flex gap-1 p-1 rounded-xl bg-bg-secondary border border-border-secondary">
                    {(['crypto', 'bank', 'p2p'] as const)
                      .filter((m) =>
                        m === 'crypto'
                          ? true
                          : m === 'bank'
                          ? methodFlags.manual
                          : methodFlags.p2p,
                      )
                      .map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setWithdrawUiSection(m)}
                        className={clsx(
                          'flex-1 py-2.5 text-xs font-bold rounded-lg transition-all duration-200',
                          withdrawUiSection === m
                            ? 'bg-accent text-white'
                            : 'text-text-tertiary hover:text-text-primary',
                        )}
                      >
                        {m === 'crypto' ? 'Crypto' : m === 'bank' ? 'Bank' : 'Request to RM'}
                      </button>
                    ))}
                  </div>

                  {withdrawUiSection === 'p2p' ? (
                    <P2PMarketplace mode="sell" />
                  ) : withdrawUiSection === 'crypto' ? (
                    <>
                      <div>
                        <p className="text-xs text-text-tertiary mb-3 font-medium uppercase tracking-wide">Payment Method</p>
                        {/* Featured selected coin — highlighted green so the
                            chosen method is clearly the selected one. */}
                        <div className="rounded-xl border-2 border-buy bg-buy/[0.08] p-4 mb-2 flex items-center justify-between gap-2">
                          <p className="text-base font-bold text-text-primary font-mono flex items-center gap-2.5">
                            <span className="text-xl leading-none text-buy" aria-hidden>◆</span>
                            <span>
                              {selectedWithdrawCrypto.label}{' '}
                              <span className="text-text-tertiary text-sm font-normal">({selectedWithdrawCrypto.sub})</span>
                            </span>
                          </p>
                          <span className="shrink-0 text-[11px] font-semibold text-buy uppercase tracking-wide">Selected</span>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          {CRYPTO_ASSETS.filter((c) => c.id !== selectedCryptoWithdraw).map((c) => (
                            <button
                              key={c.id}
                              type="button"
                              onClick={() => setSelectedCryptoWithdraw(c.id)}
                              className="rounded-xl border border-border-primary bg-bg-secondary p-3.5 text-left transition-colors hover:border-border-secondary hover:bg-bg-hover"
                            >
                              <div className="font-bold text-text-primary font-mono text-sm">{c.label}</div>
                              <div className="text-[11px] text-text-tertiary mt-0.5">({c.sub})</div>
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <label className="text-xs text-text-secondary">
                          Amount (USD)
                          {minWithdraw > 0 && (
                            <span className="text-text-tertiary"> · min ${minWithdraw.toLocaleString()}</span>
                          )}
                        </label>
                          <button
                            type="button"
                            onClick={() =>
                              setWithdrawAmount(String(Math.max(0, wallet?.main_wallet_balance ?? 0)))
                            }
                            className="text-xs font-bold text-[#55a630] hover:underline"
                          >
                            Max
                          </button>
                        </div>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary font-bold">$</span>
                          <input
                            type="number"
                            min="0.01"
                            step="0.01"
                            value={withdrawAmount}
                            onChange={(e) => setWithdrawAmount(e.target.value)}
                            placeholder="0.00"
                            className="w-full pl-7 pr-4 py-3 rounded-xl border border-border-primary bg-bg-secondary text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 font-mono font-bold text-lg"
                          />
                        </div>
                      </div>

                      <div className="space-y-1">
                        <label className="text-xs text-text-secondary">Wallet address / payout details</label>
                        <textarea
                          value={withdrawOxapayDetails}
                          onChange={(e) => setWithdrawOxapayDetails(e.target.value)}
                          placeholder={
                            withdrawUiSection === 'crypto'
                              ? 'Your crypto wallet address (network must match the withdrawal asset)'
                              : 'Bank account / payout instructions'
                          }
                          rows={3}
                          className="w-full px-4 py-3 rounded-xl border border-border-primary bg-bg-secondary text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 text-sm resize-none"
                        />
                      </div>
                      <p className="text-[11px] text-text-tertiary">Processing time: up to 24 hours.</p>

                      <button
                        type="button"
                        onClick={() => void submitWithdraw()}
                        disabled={
                          demoFundingBlocked ||
                          withdrawSubmitting ||
                          !withdrawAmount ||
                          !withdrawOxapayDetails.trim()
                        }
                        className={clsx(
                          'w-full py-3.5 rounded-xl font-bold text-base transition-all active:scale-[0.99]',
                          demoFundingBlocked ||
                            withdrawSubmitting ||
                            !withdrawAmount ||
                            !withdrawOxapayDetails.trim()
                            ? 'bg-bg-hover text-text-tertiary cursor-not-allowed'
                            : 'bg-accent text-white hover:bg-[#5cffb8] shadow-neon-green-lg',
                        )}
                      >
                        {withdrawSubmitting
                          ? 'Submitting…'
                          : `Withdraw funds${withdrawAmount ? ` — ${fmt(parseFloat(withdrawAmount || '0'))}` : ''}`}
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <label className="text-xs text-text-secondary">
                          Amount (USD)
                          {minWithdraw > 0 && (
                            <span className="text-text-tertiary"> · min ${minWithdraw.toLocaleString()}</span>
                          )}
                        </label>
                          <button
                            type="button"
                            onClick={() =>
                              setWithdrawAmount(String(Math.max(0, wallet?.main_wallet_balance ?? 0)))
                            }
                            className="text-xs font-bold text-[#55a630] hover:underline"
                          >
                            Max
                          </button>
                        </div>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary font-bold">$</span>
                          <input
                            type="number"
                            min="0.01"
                            step="0.01"
                            value={withdrawAmount}
                            onChange={(e) => setWithdrawAmount(e.target.value)}
                            placeholder="0.00"
                            className="w-full pl-7 pr-4 py-3 rounded-xl border border-border-primary bg-bg-secondary text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 font-mono font-bold text-lg"
                          />
                        </div>
                        {withdrawInr?.local_amount != null && (
                          <p className="text-[11px] text-text-secondary mt-1.5">
                            You&apos;ll receive ≈{' '}
                            <span className="font-bold text-text-primary">
                              {withdrawInr.local_amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {withdrawInr.currency}
                            </span>{' '}
                            at the current bank rate.
                          </p>
                        )}
                      </div>

                      <div className="rounded-xl border border-border-primary bg-bg-secondary px-4 py-3 space-y-2">
                        <p className="text-xs font-bold text-text-primary">Bank payout</p>
                        <p className="text-[11px] text-text-secondary leading-relaxed">
                          Provide your bank details and/or upload a QR code. Finance processes after approval.
                        </p>
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-text-secondary">Bank details</label>
                        <input
                          type="text"
                          value={manualWithdrawUpi}
                          onChange={(e) => setManualWithdrawUpi(e.target.value)}
                          placeholder="Account number / IFSC / SWIFT"
                          className="w-full px-4 py-3 rounded-xl border border-border-primary bg-bg-secondary text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 font-mono text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-text-secondary">Notes for finance (optional)</label>
                        <input
                          type="text"
                          value={manualWithdrawNotes}
                          onChange={(e) => setManualWithdrawNotes(e.target.value)}
                          placeholder="Account name, bank, etc."
                          className="w-full px-4 py-3 rounded-xl border border-border-primary bg-bg-secondary text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-text-secondary">Your QR code (optional)</label>
                        <label
                          className={clsx(
                            'flex flex-col items-center justify-center w-full py-6 rounded-xl border-2 border-dashed cursor-pointer transition-all',
                            manualWithdrawQrFile
                              ? 'border-accent/40 bg-accent/5'
                              : 'border-border-primary hover:border-accent/30',
                          )}
                        >
                          <input
                            type="file"
                            accept=".jpg,.jpeg,.png,.pdf,.webp"
                            className="hidden"
                            onChange={(e) => setManualWithdrawQrFile(e.target.files?.[0] ?? null)}
                          />
                          {manualWithdrawQrFile ? (
                            <span className="text-sm font-medium text-[#55a630] px-2 text-center">
                              {manualWithdrawQrFile.name}
                            </span>
                          ) : (
                            <span className="text-xs text-text-tertiary">JPG, PNG, PDF, WEBP</span>
                          )}
                        </label>
                      </div>
                      <button
                        type="button"
                        onClick={() => void submitWithdraw()}
                        disabled={
                          demoFundingBlocked ||
                          withdrawSubmitting ||
                          !withdrawAmount ||
                          (!manualWithdrawUpi.trim() && !manualWithdrawQrFile)
                        }
                        className={clsx(
                          'w-full py-3.5 rounded-xl font-bold text-base transition-all active:scale-[0.99]',
                          demoFundingBlocked ||
                            withdrawSubmitting ||
                            !withdrawAmount ||
                            (!manualWithdrawUpi.trim() && !manualWithdrawQrFile)
                            ? 'bg-bg-hover text-text-tertiary cursor-not-allowed'
                            : 'bg-accent text-white hover:bg-[#5cffb8] shadow-neon-green-lg',
                        )}
                      >
                        {withdrawSubmitting ? 'Submitting…' : 'Withdraw funds'}
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 md:gap-4">
            <Card variant="glass" className="flex flex-col gap-1 border-border-glass/30 relative overflow-hidden group">
              <div className="flex items-center gap-2 text-success text-[10px] md:text-xs font-bold uppercase tracking-wider">
                <ArrowDownLeft className="w-3 h-3" /> Total Deposits
              </div>
              <div className="text-base md:text-xl font-bold text-text-primary tabular-nums font-mono">
                {fmt(wallet?.total_deposited || 0)}
              </div>
              <div className="absolute top-0 right-0 w-12 h-12 bg-success/5 rounded-bl-full group-hover:bg-success/10 transition-colors" />
            </Card>
            <Card variant="glass" className="flex flex-col gap-1 border-border-glass/30 relative overflow-hidden group">
              <div className="flex items-center gap-2 text-buy text-[10px] md:text-xs font-bold uppercase tracking-wider">
                <ArrowUpRight className="w-3 h-3" /> Total Withdrawals
              </div>
              <div className="text-base md:text-xl font-bold text-text-primary tabular-nums font-mono">
                {fmt(wallet?.total_withdrawn || 0)}
              </div>
              <div className="absolute top-0 right-0 w-12 h-12 bg-buy/5 rounded-bl-full group-hover:bg-buy/10 transition-colors" />
            </Card>
          </div>

          <div className="bg-bg-secondary/50 border border-border-glass/20 rounded-xl p-4 flex gap-3">
            <div className="w-8 h-8 rounded-lg bg-buy/10 flex items-center justify-center shrink-0">
              <Clock className="w-4 h-4 text-buy" />
            </div>
            <div>
              <h5 className="text-text-primary font-bold text-xs uppercase tracking-wide">Processing Time</h5>
              <p className="text-text-tertiary text-[10px] leading-relaxed mt-0.5">
                Crypto and manual bank withdrawals are reviewed by finance; most requests are processed within 24 hours.
              </p>
            </div>
          </div>

          {/* Bonus section — header chip jumps here (/wallet#bonus). */}
          <section id="bonus" className="scroll-mt-24 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-bold text-text-primary">Bonus &amp; promo</h2>
              <button
                type="button"
                onClick={() => void loadBonusOverview()}
                disabled={bonusLoading}
                className="text-[10px] uppercase tracking-wider text-text-tertiary hover:text-text-primary disabled:opacity-50"
              >
                {bonusLoading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>

            {/* Active offers */}
            <div className="rounded-xl border border-border-glass/30 bg-bg-secondary/40 p-4">
              <p className="text-xxs font-bold uppercase tracking-wide text-[#55a630] mb-2">Active offers</p>
              {!bonusOverview || bonusOverview.active_offers.length === 0 ? (
                <p className="text-xs text-text-tertiary">No active offers at the moment. Check back later.</p>
              ) : (
                <ul className="space-y-2">
                  {bonusOverview.active_offers.map((o) => (
                    <li
                      key={o.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-bg-primary/40 border border-border-glass/20 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-text-primary truncate">{o.name}</p>
                        <p className="text-[10px] text-text-tertiary">
                          {o.percentage ? `${o.percentage}% of deposit` :
                            o.fixed_amount ? `$${o.fixed_amount.toFixed(2)} fixed` : 'Custom'}
                          {o.min_deposit > 0 && <> · min ${o.min_deposit.toFixed(2)}</>}
                          {o.max_bonus && <> · cap ${o.max_bonus.toFixed(2)}</>}
                          {o.expires_at && <> · ends {new Date(o.expires_at).toLocaleDateString()}</>}
                        </p>
                      </div>
                      <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-[#55a630] bg-[#55a630]/10 border border-[#55a630]/25 rounded-full px-2 py-0.5">
                        {o.bonus_type || 'bonus'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[10px] text-text-tertiary mt-2">
                Have a code? Type it in the deposit form&apos;s <span className="text-text-secondary font-medium">Bonus / promo code</span> field
                and admin will review your request.
              </p>
            </div>

            {/* Recent bonus requests on deposits */}
            <div className="rounded-xl border border-border-glass/30 bg-bg-secondary/40 p-4">
              <p className="text-xxs font-bold uppercase tracking-wide text-[#55a630] mb-2">My bonus requests</p>
              {!bonusOverview || bonusOverview.recent_requests.length === 0 ? (
                <p className="text-xs text-text-tertiary">You haven&apos;t requested a bonus code on any deposit yet.</p>
              ) : (
                <ul className="space-y-2">
                  {bonusOverview.recent_requests.map((r) => (
                    <li
                      key={r.deposit_id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-bg-primary/40 border border-border-glass/20 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-mono font-semibold text-text-primary">{r.bonus_code}</p>
                        <p className="text-[10px] text-text-tertiary">
                          Deposit ${r.deposit_amount.toFixed(2)} · {r.created_at ? new Date(r.created_at).toLocaleString() : '—'}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <span
                          className={clsx(
                            'inline-block text-[10px] font-bold uppercase tracking-wider rounded-full px-2 py-0.5 border',
                            r.bonus_status === 'granted'
                              ? 'bg-success/15 text-success border-success/30'
                              : r.bonus_status === 'denied'
                                ? 'bg-sell/15 text-sell border-sell/30'
                                : 'bg-warning/15 text-warning border-warning/30',
                          )}
                        >
                          {r.bonus_status || 'pending'}
                        </span>
                        {r.bonus_amount != null && r.bonus_status === 'granted' && (
                          <p className="text-[10px] text-success font-mono mt-0.5">+${r.bonus_amount.toFixed(2)}</p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Active / past UserBonus rows */}
            <div className="rounded-xl border border-border-glass/30 bg-bg-secondary/40 p-4">
              <p className="text-xxs font-bold uppercase tracking-wide text-[#55a630] mb-2">My bonus history</p>
              {!bonusOverview || bonusOverview.my_bonuses.length === 0 ? (
                <p className="text-xs text-text-tertiary">No bonuses credited yet.</p>
              ) : (
                <ul className="space-y-2">
                  {bonusOverview.my_bonuses.map((b) => (
                    <li
                      key={b.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-bg-primary/40 border border-border-glass/20 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-text-primary truncate">{b.offer_name || 'Bonus credit'}</p>
                        <p className="text-[10px] text-text-tertiary">
                          {b.created_at ? new Date(b.created_at).toLocaleString() : '—'}
                          {b.lots_required > 0 && (
                            <> · lots traded {b.lots_traded.toFixed(2)} / {b.lots_required.toFixed(2)}</>
                          )}
                          {b.expires_at && <> · expires {new Date(b.expires_at).toLocaleDateString()}</>}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-sm font-mono font-bold text-success">+${b.amount.toFixed(2)}</p>
                        <span
                          className={clsx(
                            'inline-block text-[9px] font-bold uppercase tracking-wider rounded-full px-1.5 py-0.5 mt-0.5 border',
                            b.status === 'released' || b.status === 'active'
                              ? 'bg-success/15 text-success border-success/30'
                              : b.status === 'expired' || b.status === 'forfeited'
                                ? 'bg-text-tertiary/15 text-text-tertiary border-border-glass/30'
                                : 'bg-warning/15 text-warning border-warning/30',
                          )}
                        >
                          {b.status}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      </div>

      {balanceTransfer && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="wallet-transfer-title"
        >
          <button
            type="button"
            className="absolute inset-0 bg-bg-base/80 backdrop-blur-sm"
            aria-label="Close"
            onClick={closeBalanceTransfer}
          />
          <div
            className="relative w-full max-w-sm rounded-t-2xl border border-border-primary bg-card-nested p-4 shadow-2xl sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-start justify-between gap-2">
              <h2 id="wallet-transfer-title" className="pr-6 text-sm font-bold text-text-primary">
                {balanceTransfer.mode === 'to_main' ? 'Move to main wallet' : 'Add from main wallet'}
              </h2>
              <button
                type="button"
                onClick={closeBalanceTransfer}
                className="shrink-0 rounded-lg p-1 text-text-secondary transition-colors hover:bg-bg-hover"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {balanceTransfer.mode === 'to_trading' && !balanceTransfer.tradingAccountId ? (
              <div className="mb-3 space-y-1">
                <label className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
                  Trading account
                </label>
                <select
                  value={balanceTransferPickId}
                  onChange={(e) => setBalanceTransferPickId(e.target.value)}
                  className="w-full rounded-lg border border-border-primary bg-bg-primary px-2.5 py-2 text-xs font-mono text-text-primary outline-none focus:border-accent/40"
                >
                  {liveAccounts.map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      {acc.account_number}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {balanceTransfer.mode === 'to_main' && balanceTransfer.tradingAccountId ? (
              <p className="mb-3 font-mono text-[11px] text-text-tertiary">
                From{' '}
                {liveAccounts.find((x) => x.id === balanceTransfer.tradingAccountId)?.account_number ?? '—'}
              </p>
            ) : null}
            {balanceTransfer.mode === 'to_trading' && balanceTransfer.tradingAccountId ? (
              <p className="mb-3 font-mono text-[11px] text-text-tertiary">
                To{' '}
                {liveAccounts.find((x) => x.id === balanceTransfer.tradingAccountId)?.account_number ?? '—'}
              </p>
            ) : null}
            <div className="mb-3 space-y-1">
              <label className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
                Amount ({transferIsCent ? CENT_SYMBOL : (wallet?.currency || 'USD')})
              </label>
              {transferIsCent && transferAccount && balanceTransfer.mode === 'to_main' ? (
                <p className="text-[10px] text-text-tertiary">
                  Available: {fmtAccountMoney(transferAccount.balance, true)} · credited to main wallet in USD
                </p>
              ) : null}
              <div className="relative">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs font-bold text-text-tertiary">
                  {transferIsCent ? CENT_SYMBOL : '$'}
                </span>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={balanceTransferAmount}
                  onChange={(e) => { setBalanceTransferAmount(e.target.value); setTransferAgree(false); }}
                  placeholder="0.00"
                  className="w-full rounded-lg border border-border-primary bg-bg-primary py-2 pl-7 pr-3 text-sm font-mono font-bold text-text-primary outline-none focus:border-accent/40"
                />
              </div>
            </div>

            {/* Credit-forfeit rule for to-main transfers (client 2026-06-24). */}
            {balanceTransfer.mode === 'to_main' && transferCreditUsd > 0 ? (
              <div className={clsx(
                'mb-3 rounded-lg border px-3 py-2.5 text-[11px] leading-relaxed',
                transferWouldForfeit ? 'border-red-500/40 bg-red-500/10 text-red-300' : 'border-amber-500/30 bg-amber-500/10 text-amber-200',
              )}>
                <p>
                  This account has <strong>{fmtAccountMoney(transferCreditUsd, transferIsCent)}</strong> bonus credit.
                  You must keep at least <strong>{fmtAccountMoney(transferCreditUsd, transferIsCent)}</strong> balance in it.
                </p>
                {transferWouldForfeit ? (
                  <p className="mt-1 font-semibold">
                    ⚠️ This transfer drops your balance below the credit — your entire{' '}
                    {fmtAccountMoney(transferCreditUsd, transferIsCent)} credit will be forfeited (insurance payouts are kept).
                  </p>
                ) : (
                  <p className="mt-1 text-text-tertiary">Withdraw more than that and the entire credit is forfeited (insurance payouts are kept).</p>
                )}
                {transferWouldForfeit ? (
                  <label className="mt-2 flex items-start gap-2 cursor-pointer text-text-secondary">
                    <input
                      type="checkbox"
                      checked={transferAgree}
                      onChange={(e) => setTransferAgree(e.target.checked)}
                      className="mt-0.5 accent-red-500"
                    />
                    <span>I understand my {fmtAccountMoney(transferCreditUsd, transferIsCent)} credit will be forfeited.</span>
                  </label>
                ) : null}
              </div>
            ) : null}

            {/* Empty-account heads-up (client 2026-06-26): warn before a
                transfer zeroes out the trading account. */}
            {transferWouldEmpty ? (
              <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[11px] leading-relaxed text-amber-200">
                ⚠️ This transfer moves your <strong>entire balance</strong> out — the account will be left at{' '}
                <strong>{fmtAccountMoney(0, transferIsCent)}</strong>. You can move funds back from your main wallet anytime.
              </div>
            ) : null}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={closeBalanceTransfer}
                className="flex-1 rounded-lg border border-border-primary py-2 text-xs font-semibold text-text-secondary transition-colors hover:bg-bg-hover"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitBalanceTransfer()}
                disabled={balanceTransferBusy || (transferWouldForfeit && !transferAgree)}
                className={clsx(
                  'flex-1 rounded-lg py-2 text-xs font-bold transition-colors',
                  (balanceTransferBusy || (transferWouldForfeit && !transferAgree))
                    ? 'cursor-not-allowed bg-border-primary text-text-tertiary opacity-60'
                    : 'bg-accent text-black hover:bg-accent/90',
                )}
              >
                {balanceTransferBusy ? '…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      <WalletDepositModal
        open={walletDepositOpen}
        onClose={() => setWalletDepositOpen(false)}
        amountUsd={walletDepositAmount}
        cryptoAsset={walletDepositAsset}
        onSettled={() => {
          // The IPN webhook already credited balance + sent the email; just
          // refresh the wallet view so the user sees the new total.
          void fetchData(true);
        }}
      />

      {/* XM-style pre-deposit confirmation (client 2026-06-20). */}
      {showDepositConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setShowDepositConfirm(false)} />
          <div className="relative w-full max-w-md rounded-2xl border border-border-primary bg-bg-base shadow-2xl p-5 sm:p-6 space-y-4 animate-in fade-in zoom-in-95">
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-base font-bold text-text-primary">Before your deposit is processed</h3>
              <button type="button" onClick={() => setShowDepositConfirm(false)} className="text-text-tertiary hover:text-text-primary">✕</button>
            </div>
            <p className="text-xs text-text-secondary">Please make sure the points below are met so your deposit is credited successfully:</p>
            <ul className="space-y-2.5 text-xs text-text-secondary">
              <li className="flex gap-2"><span className="text-[#55a630] font-bold">•</span><span>Pay the <strong className="text-text-primary">exact amount</strong> requested — a different amount may delay or block crediting.</span></li>
              <li className="flex gap-2"><span className="text-amber-500 font-bold">•</span><span><strong className="text-amber-500">Enter the correct 12-digit UTR / UPI reference</strong> after paying. If this is missed, the funds will not be credited.</span></li>
              <li className="flex gap-2"><span className="text-[#55a630] font-bold">•</span><span>UPI deposits may take up to <strong className="text-text-primary">20 minutes</strong> to credit. If it takes longer, contact live support.</span></li>
            </ul>
            <div className="rounded-lg bg-bg-secondary border border-border-primary px-3 py-2.5 text-xs text-text-secondary">
              Depositing <strong className="text-text-primary">${parseFloat(depositAmount || '0').toLocaleString()}</strong> · UTR/Ref:{' '}
              <span className="font-mono text-text-primary break-all">{depositTxId.trim()}</span>
            </div>
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowDepositConfirm(false)}
                className="flex-1 py-2.5 rounded-xl border border-border-primary bg-bg-secondary text-sm font-semibold text-text-secondary hover:bg-bg-hover transition-fast"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={depositSubmitting}
                onClick={() => { setShowDepositConfirm(false); void submitDeposit(); }}
                className="flex-1 py-2.5 rounded-xl bg-[#55a630] text-sm font-bold text-white hover:bg-[#4a9329] transition-fast disabled:opacity-50"
              >
                Confirm &amp; Submit
              </button>
            </div>
          </div>
        </div>
      )}

    </DashboardShell>
  );
}

export default function WalletPage() {
  return (
    <Suspense
      fallback={
        <DashboardShell mainClassName="flex items-center justify-center">
          <div className="flex flex-col items-center gap-3 py-12">
            <div className="w-8 h-8 border-2 border-[#55a630] border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-text-secondary">Loading wallet…</span>
          </div>
        </DashboardShell>
      }
    >
      <WalletPageContent />
    </Suspense>
  );
}
