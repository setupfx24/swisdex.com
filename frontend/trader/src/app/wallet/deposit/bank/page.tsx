'use client';

/**
 * Dedicated bank-deposit page (client 2026-06-23: "bank se deposit lenge tab
 * naya page khulna chahiye XM ki tarah"). Reuses the existing manual-deposit
 * endpoints (/wallet/deposit/banks + /wallet/deposit/manual) on its own route
 * instead of the cramped inline tab.
 */
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { clsx } from 'clsx';
import { ArrowLeft, X } from 'lucide-react';
import api from '@/lib/api/client';

interface BankDetails {
  id?: string;
  bank_name?: string;
  account_holder?: string;
  account_number?: string;
  ifsc_code?: string;
  upi_id?: string;
  qr_code_url?: string;
}

interface DepositReq {
  id: string;
  amount: number | null;
  status: string;
  admin_qr?: string | null;
  admin_bank_text?: string | null;
  admin_upi?: string | null;
  admin_note?: string | null;
}

function copyText(text: string, label: string) {
  navigator.clipboard?.writeText(text);
  toast.success(`${label} copied`);
}

export default function BankDepositPage() {
  const router = useRouter();
  const [amount, setAmount] = useState('');
  const [banks, setBanks] = useState<BankDetails[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [utr, setUtr] = useState('');
  const [proof, setProof] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [minDeposit, setMinDeposit] = useState(0);
  const [reference] = useState(() => 'SWD-' + Math.random().toString(36).slice(2, 8).toUpperCase());
  // Personal payment-details requests (admin-assigned QR / bank / UPI).
  const [myReqs, setMyReqs] = useState<DepositReq[]>([]);
  const [reqBusy, setReqBusy] = useState(false);

  const bank = banks.find((b) => b.id === selectedId) ?? banks[0] ?? null;
  const approvedReq = myReqs.find((r) => r.status === 'approved');
  const pendingReq = myReqs.find((r) => r.status === 'pending');

  const loadMyReqs = useCallback(async () => {
    try {
      const r = await api.get<{ items: DepositReq[] }>('/wallet/deposit/my-requests');
      setMyReqs(Array.isArray(r?.items) ? r.items : []);
    } catch { /* non-fatal */ }
  }, []);
  useEffect(() => { void loadMyReqs(); }, [loadMyReqs]);

  const submitRequest = async () => {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { toast.error('Enter an amount first'); return; }
    setReqBusy(true);
    try {
      await api.post('/wallet/deposit/request', { amount: amt });
      toast.success('Request sent — the admin will share payment details shortly.');
      await loadMyReqs();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send request');
    } finally {
      setReqBusy(false);
    }
  };

  useEffect(() => {
    api.get<{ min_deposit_amount_usd?: number }>('/auth/platform-status')
      .then((s) => { if (typeof s.min_deposit_amount_usd === 'number') setMinDeposit(s.min_deposit_amount_usd); })
      .catch(() => {});
  }, []);

  const loadBanks = useCallback(async () => {
    try {
      const amt = parseFloat(amount);
      const qs = !Number.isNaN(amt) && amt > 0 ? `?amount=${amt}` : '';
      const res = await api.get<{ banks: BankDetails[] }>(`/wallet/deposit/banks${qs}`);
      const list = Array.isArray(res?.banks) ? res.banks : [];
      setBanks(list);
      setSelectedId((prev) => (prev && list.some((b) => b.id === prev) ? prev : (list[0]?.id ?? null)));
    } catch {
      try {
        const d = await api.post<BankDetails>('/wallet/deposit/bank-details', {});
        setBanks(d && Object.keys(d).length > 0 ? [d] : []);
      } catch { setBanks([]); }
    }
  }, [amount]);

  useEffect(() => { void loadBanks(); }, [loadBanks]);

  const requestConfirm = () => {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { toast.error('Enter a valid amount'); return; }
    if (minDeposit > 0 && amt < minDeposit) { toast.error(`Minimum deposit is $${minDeposit.toLocaleString()}.`); return; }
    if (!utr.trim()) { toast.error('Enter your bank reference / UTR'); return; }
    if (!proof) { toast.error('Please attach your payment screenshot'); return; }
    setShowConfirm(true);
  };

  const submit = async () => {
    setShowConfirm(false);
    const amt = parseFloat(amount);
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append('amount', String(amt));
      fd.append('transaction_id', utr.trim());
      if (proof) fd.append('file', proof);
      const token = api.getToken();
      const res = await fetch('/api/v1/wallet/deposit/manual', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
        credentials: 'include',
      });
      const raw = await res.text();
      let json: { detail?: unknown } = {};
      try { json = raw ? JSON.parse(raw) : {}; } catch { throw new Error(raw.slice(0, 200) || `Request failed (${res.status})`); }
      if (!res.ok) {
        const d = json.detail;
        throw new Error(typeof d === 'string' ? d : Array.isArray(d) ? d.map((x: { msg?: string }) => x.msg).join(', ') : 'Deposit failed');
      }
      toast.success(`Bank deposit of $${amt.toLocaleString()} submitted — pending approval`);
      router.push('/wallet');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Deposit failed');
    } finally {
      setSubmitting(false);
    }
  };

  const Row = ({ label, value }: { label: string; value?: string | null }) =>
    value ? (
      <div className="flex items-center justify-between gap-3 py-2 border-b border-border-primary/60 last:border-0">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wide text-text-tertiary">{label}</p>
          <p className="text-sm text-text-primary font-mono break-all">{value}</p>
        </div>
        <button type="button" onClick={() => copyText(value, label)} className="text-[10px] font-semibold text-[#55a630] hover:underline shrink-0">Copy</button>
      </div>
    ) : null;

  return (
    <div className="min-h-[100dvh] w-full overflow-y-auto bg-bg-base text-text-primary">
      {/* Branded checkout header — focused full-screen payment page, no app
          chrome (client 2026-06-24: render like the NOWPayments checkout). */}
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border-glass/60 bg-bg-base/95 backdrop-blur px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          {/* Two logo variants, swapped by theme (same as AppSidebar). */}
          <img src="/images/swisdex_png5.png" alt="SwisDex" className="h-7 w-auto object-contain shrink-0 hidden dark:block" />
          <img src="/images/swisdex_png.png" alt="SwisDex" className="h-7 w-auto object-contain shrink-0 dark:hidden" />
          <span className="text-[11px] font-semibold text-text-secondary border-l border-border-primary pl-2 ml-1 hidden sm:inline">Secure Bank Deposit</span>
        </div>
        <button type="button" onClick={() => router.push('/wallet')} aria-label="Close" className="p-1.5 rounded-lg text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-fast">
          <X size={18} />
        </button>
      </div>

      <div className="max-w-xl mx-auto w-full px-4 py-6 space-y-5">
        <button type="button" onClick={() => router.push('/wallet')} className="inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary">
          <ArrowLeft size={16} /> Back to Wallet
        </button>

        <div>
          <h1 className="text-xl font-bold text-text-primary">Bank Deposit</h1>
          <p className="text-xs text-text-tertiary mt-1">Transfer to the account below, then submit your reference and a screenshot.</p>
        </div>

        {/* Amount */}
        <div className="space-y-1">
          <label className="text-xs text-text-secondary">Amount (USD){minDeposit > 0 && <span className="text-text-tertiary"> · min ${minDeposit.toLocaleString()}</span>}</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary font-bold">$</span>
            <input type="number" min="1" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} onBlur={() => void loadBanks()} placeholder="0.00" className="w-full pl-7 pr-4 py-3 rounded-xl border border-border-primary bg-bg-secondary text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 font-mono font-bold text-lg" />
          </div>
        </div>

        {/* Personal payment details (admin-assigned via request → approve). */}
        <div className="rounded-xl border border-accent/30 bg-accent/5 p-4 space-y-3">
          {approvedReq ? (
            <>
              <p className="text-xs font-bold text-text-primary">Your personal payment details</p>
              {approvedReq.admin_note && (
                <p className="text-[11px] text-text-secondary">{approvedReq.admin_note}</p>
              )}
              {approvedReq.admin_bank_text && (
                <pre className="whitespace-pre-wrap break-words text-[11px] font-mono text-text-primary bg-bg-base rounded-lg p-2 border border-border-primary">{approvedReq.admin_bank_text}</pre>
              )}
              {approvedReq.admin_upi && <Row label="UPI ID" value={approvedReq.admin_upi} />}
              {approvedReq.admin_qr && (
                <div className="pt-1 flex justify-center">
                  <img src={approvedReq.admin_qr} alt="Personal payment QR" className="w-full max-w-[220px] max-h-48 object-contain rounded-lg border border-border-primary bg-bg-base" />
                </div>
              )}
              <p className="text-[10px] text-text-tertiary">Pay using the above, then submit your reference + screenshot below.</p>
            </>
          ) : pendingReq ? (
            <p className="text-xs text-amber-300">⏳ Your request is pending — the admin will share your personal payment details shortly. Refresh to check.</p>
          ) : (
            <div className="space-y-2">
              <p className="text-xs font-bold text-text-primary">Need personal payment details?</p>
              <p className="text-[11px] text-text-secondary">Enter the amount above, then request a personal QR / bank / UPI from the admin.</p>
              <button type="button" onClick={() => void submitRequest()} disabled={reqBusy} className="w-full rounded-lg bg-accent text-black py-2 text-xs font-bold disabled:opacity-50">
                {reqBusy ? 'Sending…' : 'Request payment details'}
              </button>
            </div>
          )}
        </div>

        {/* Bank picker + details */}
        <div className="rounded-xl border border-border-primary bg-bg-secondary p-4 space-y-3">
          <p className="text-xs font-bold text-text-primary">Pay to this account</p>
          {banks.length > 1 && (
            <div className="grid grid-cols-2 gap-2">
              {banks.map((b) => (
                <button key={b.id} type="button" onClick={() => setSelectedId(b.id ?? null)} className={clsx('text-left px-3 py-2 rounded-lg border text-[11px] transition-colors min-w-0', selectedId === b.id ? 'border-accent bg-accent/10 text-text-primary' : 'border-border-primary bg-bg-base hover:border-accent/40 text-text-secondary')}>
                  <span className="block font-semibold truncate">{b.bank_name || 'Bank'}</span>
                  <span className="block font-mono text-[10px] text-text-tertiary truncate">{b.account_number}</span>
                </button>
              ))}
            </div>
          )}
          <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2">
            <p className="text-[10px] uppercase tracking-wide text-amber-500/90">Payment reference — add this in your transfer remark</p>
            <div className="flex items-center justify-between gap-2">
              <p className="font-mono font-bold text-sm text-text-primary select-all break-all">{reference}</p>
              <button type="button" onClick={() => copyText(reference, 'Reference')} className="text-[10px] font-semibold text-[#55a630] hover:underline shrink-0">Copy</button>
            </div>
          </div>
          {bank ? (
            <div>
              <Row label="Bank" value={bank.bank_name} />
              <Row label="Account Holder" value={bank.account_holder} />
              <Row label="Account Number" value={bank.account_number} />
              <Row label="IFSC" value={bank.ifsc_code} />
              <Row label="UPI ID" value={bank.upi_id} />
              {bank.qr_code_url && (
                <div className="pt-2 flex justify-center">
                  <img src={bank.qr_code_url} alt="Payment QR" className="w-full max-w-[220px] max-h-48 object-contain rounded-lg border border-border-primary bg-bg-base" />
                </div>
              )}
            </div>
          ) : (
            <p className="text-[11px] text-amber-500/90">No bank details configured yet. Enter an amount and refresh, or contact support.</p>
          )}
        </div>

        {/* Reference / UTR */}
        <div className="space-y-1">
          <label className="text-xs text-text-secondary">Bank reference / UTR <span className="text-red-400">*</span></label>
          <input type="text" value={utr} onChange={(e) => setUtr(e.target.value)} placeholder="12-digit UTR or transfer reference" className="w-full px-4 py-3 rounded-xl border border-border-primary bg-bg-secondary text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 font-mono text-sm" />
        </div>

        {/* Screenshot */}
        <div className="space-y-1">
          <label className="text-xs text-text-secondary">Payment screenshot <span className="text-red-400">*</span></label>
          <label className={clsx('flex flex-col items-center justify-center w-full py-6 px-2 rounded-xl border-2 border-dashed cursor-pointer transition-all', proof ? 'border-accent/40 bg-accent/5' : 'border-border-primary hover:border-accent/30')}>
            <input type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => setProof(e.target.files?.[0] ?? null)} />
            <span className="text-xs text-text-secondary">{proof ? proof.name : 'Tap to upload your transfer screenshot'}</span>
          </label>
        </div>

        <button type="button" onClick={requestConfirm} disabled={submitting || !amount || !utr.trim() || !proof} className="w-full py-3.5 rounded-xl bg-[#55a630] text-sm font-bold text-white hover:bg-[#4a9329] transition-fast disabled:opacity-50 disabled:cursor-not-allowed">
          {submitting ? 'Submitting…' : 'Submit Bank Deposit'}
        </button>
      </div>

      {showConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setShowConfirm(false)} />
          <div className="relative w-full max-w-md rounded-2xl border border-border-primary bg-bg-base shadow-2xl p-5 sm:p-6 space-y-4">
            <h3 className="text-base font-bold text-text-primary">Before your deposit is processed</h3>
            <ul className="space-y-2.5 text-xs text-text-secondary">
              <li className="flex gap-2"><span className="text-[#55a630] font-bold">•</span><span>Pay the <strong className="text-text-primary">exact amount</strong> requested.</span></li>
              <li className="flex gap-2"><span className="text-amber-500 font-bold">•</span><span>Add the <strong className="text-amber-500">payment reference</strong> ({reference}) in your transfer remark.</span></li>
              <li className="flex gap-2"><span className="text-[#55a630] font-bold">•</span><span>Bank deposits are credited after admin verification — usually within a few hours.</span></li>
            </ul>
            <div className="rounded-lg bg-bg-secondary border border-border-primary px-3 py-2.5 text-xs text-text-secondary">
              Depositing <strong className="text-text-primary">${parseFloat(amount || '0').toLocaleString()}</strong> · UTR: <span className="font-mono text-text-primary break-all">{utr.trim()}</span>
            </div>
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={() => setShowConfirm(false)} className="flex-1 py-2.5 rounded-xl border border-border-primary bg-bg-secondary text-sm font-semibold text-text-secondary hover:bg-bg-hover transition-fast">Cancel</button>
              <button type="button" disabled={submitting} onClick={submit} className="flex-1 py-2.5 rounded-xl bg-[#55a630] text-sm font-bold text-white hover:bg-[#4a9329] transition-fast disabled:opacity-50">Confirm &amp; Submit</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
