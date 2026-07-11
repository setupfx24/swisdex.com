'use client';

/**
 * XM-style multi-step deposit flow (client 2026-06-26):
 *   grid -> notice (Accept & Continue) -> form (amount + live USD + declaration)
 *   -> confirm dialog -> QR page (admin QR + reference + UTR + Confirm Payment).
 * Funds settle in USD in the main wallet after live FX conversion.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { ArrowLeft, X } from 'lucide-react';
import api from '@/lib/api/client';

interface Method {
  id: string;
  method_key: string;
  display_name: string;
  pay_currency: string;
  qr_image?: string | null;
  upi_id?: string | null;
  bank_text?: string | null;
  notice?: string | null;
  declaration?: string | null;
  min_amount?: number | null;
  max_amount?: number | null;
}

function copyText(text: string, label: string) {
  navigator.clipboard?.writeText(text);
  toast.success(`${label} copied`);
}

export default function DepositMethodsPage() {
  const router = useRouter();
  const [methods, setMethods] = useState<Method[]>([]);
  const [step, setStep] = useState<'grid' | 'form' | 'qr'>('grid');
  const [sel, setSel] = useState<Method | null>(null);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [usd, setUsd] = useState<number | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [promo, setPromo] = useState('');
  const [utr, setUtr] = useState('');
  const [reference] = useState(() => 'SWD-' + Math.random().toString(36).slice(2, 8).toUpperCase());
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.get<{ items: Method[] }>('/wallet/deposit/methods')
      .then((r) => setMethods(Array.isArray(r?.items) ? r.items : []))
      .catch(() => {});
  }, []);

  // Live USD preview as the amount changes. Passes method_id so a method with
  // an admin-fixed rate previews at that fixed rate (not the live API).
  const refreshUsd = useCallback(async (cur: string, amt: string, methodId?: string) => {
    const n = parseFloat(amt);
    if (!cur || Number.isNaN(n) || n <= 0) { setUsd(null); return; }
    try {
      const mp = methodId ? `&method_id=${encodeURIComponent(methodId)}` : '';
      const q = await api.get<{ usd: number | null }>(`/wallet/deposit/fx-quote?currency=${encodeURIComponent(cur)}&amount=${n}${mp}`);
      setUsd(typeof q?.usd === 'number' ? q.usd : null);
    } catch { setUsd(null); }
  }, []);
  useEffect(() => {
    if (step !== 'form' || !sel) return;
    const t = setTimeout(() => void refreshUsd(sel.pay_currency, amount, sel.id), 400);
    return () => clearTimeout(t);
  }, [amount, sel, step, refreshUsd]);

  const pickMethod = (m: Method) => { setSel(m); setAmount(''); setUsd(null); setAgreed(false); setPromo(''); setNoticeOpen(true); };
  const cur = sel?.pay_currency || 'INR';

  const confirmPayment = async () => {
    if (!sel) return;
    setSubmitting(true);
    try {
      await api.post('/wallet/deposit/method', {
        method_id: sel.id, pay_amount: parseFloat(amount), utr: utr.trim() || null,
        bonus_code: promo.trim() || null,
      });
      toast.success('Deposit submitted — admin will verify and credit your wallet.');
      router.push('/wallet');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Submit failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-[100dvh] w-full overflow-y-auto bg-bg-base text-text-primary">
      <div className="border-b border-border-primary px-4 py-3 flex items-center justify-between">
        <span className="text-sm font-bold">Deposit</span>
        <button type="button" onClick={() => router.push('/wallet')} className="rounded-lg p-1 text-text-secondary hover:bg-bg-hover"><X className="h-5 w-5" /></button>
      </div>

      <div className="max-w-xl mx-auto w-full px-4 py-6 space-y-5">
        {/* STEP 1 — methods grid */}
        {step === 'grid' && (
          <>
            <h1 className="text-lg font-bold">Deposit Methods</h1>
            {methods.length === 0 ? (
              <p className="text-xs text-text-tertiary">No payment methods configured yet. Please contact support.</p>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {methods.map((m) => (
                  <button key={m.id} type="button" onClick={() => pickMethod(m)} className="flex flex-col items-center gap-2 rounded-xl border border-border-primary bg-bg-secondary p-4 hover:border-accent/50 transition-colors">
                    {m.qr_image ? <img src={m.qr_image} alt="" className="w-8 h-8 object-contain rounded" /> : <span className="w-8 h-8 rounded-full bg-accent/15" />}
                    <span className="text-xs font-semibold text-center">{m.display_name}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {/* STEP 3 — form */}
        {step === 'form' && sel && (
          <>
            <button type="button" onClick={() => setStep('grid')} className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary"><ArrowLeft className="h-3.5 w-3.5" /> Methods</button>
            <h1 className="text-lg font-bold">{sel.display_name}</h1>

            <div className="space-y-1">
              <label className="text-xs text-text-secondary">Amount ({cur})
                {(sel.min_amount != null || sel.max_amount != null) && (
                  <span className="text-text-tertiary"> · {sel.min_amount != null ? `Min ${sel.min_amount}` : ''} {sel.max_amount != null ? `Max ${sel.max_amount}` : ''}</span>
                )}
              </label>
              <input type="number" min="1" value={amount} onChange={(e) => setAmount(e.target.value)} onWheel={(e) => e.currentTarget.blur()} placeholder="0.00" className="w-full px-4 py-3 rounded-xl border border-border-primary bg-bg-secondary font-mono font-bold text-lg outline-none focus:border-accent/50" />
              <p className="text-[11px] text-text-tertiary">
                You will be credited{' '}
                <span className="font-bold text-accent">{usd != null ? `$${usd.toFixed(2)} USD` : '—'}</span>{' '}
                at the latest rate.
              </p>
              {(() => {
                const n = parseFloat(amount);
                if (!amount || Number.isNaN(n)) return null;
                if (sel.min_amount != null && n < sel.min_amount)
                  return <p className="text-[11px] text-red-400">Minimum deposit is {sel.min_amount} {cur}.</p>;
                if (sel.max_amount != null && n > sel.max_amount)
                  return <p className="text-[11px] text-red-400">Maximum deposit is {sel.max_amount} {cur}.</p>;
                return null;
              })()}
            </div>

            {/* Promo / bonus code (optional) — stored on the deposit; the
                matching BonusOffer is granted when admin credits it. */}
            <div className="space-y-1">
              <label className="text-xs text-text-secondary">Promo code <span className="text-text-tertiary">(optional)</span></label>
              <input
                value={promo}
                onChange={(e) => setPromo(e.target.value.toUpperCase())}
                placeholder="e.g. WELCOME50"
                maxLength={40}
                className="w-full px-4 py-3 rounded-xl border border-border-primary bg-bg-secondary font-mono uppercase tracking-wide outline-none focus:border-accent/50 placeholder:normal-case placeholder:tracking-normal"
              />
              {promo.trim() && (
                <p className="text-[11px] text-text-tertiary">Code <span className="font-mono font-bold text-accent">{promo.trim()}</span> will apply when your deposit is credited.</p>
              )}
            </div>

            {sel.upi_id ? <p className="text-[11px] text-text-tertiary">Pay to UPI: <span className="font-mono text-text-primary">{sel.upi_id}</span></p> : null}

            {sel.declaration ? (
              <label className="flex items-start gap-2 text-[11px] text-text-secondary cursor-pointer">
                <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 accent-accent" />
                <span>{sel.declaration}</span>
              </label>
            ) : null}

            <button
              type="button"
              disabled={
                !amount ||
                (!!sel.declaration && !agreed) ||
                (sel.min_amount != null && parseFloat(amount) < sel.min_amount) ||
                (sel.max_amount != null && parseFloat(amount) > sel.max_amount)
              }
              onClick={() => setConfirmOpen(true)}
              className="w-full py-3 rounded-xl bg-[#55a630] text-white font-bold disabled:opacity-50"
            >Deposit</button>
          </>
        )}

        {/* STEP 6 — QR page */}
        {step === 'qr' && sel && (
          <>
            <h1 className="text-lg font-bold">Scan & Pay</h1>
            <div className="rounded-xl border border-border-primary bg-bg-secondary p-4 space-y-3 text-center">
              <p className="text-sm font-bold">{cur} {Number(amount).toLocaleString()} <span className="text-text-tertiary text-xs">(≈ ${usd?.toFixed(2)} USD)</span></p>
              <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-left">
                <p className="text-[10px] uppercase tracking-wide text-amber-500/90">Order reference — add in your payment remark</p>
                <div className="flex items-center justify-between gap-2">
                  <p className="font-mono font-bold text-sm select-all">{reference}</p>
                  <button type="button" onClick={() => copyText(reference, 'Reference')} className="text-[10px] font-semibold text-[#55a630]">Copy</button>
                </div>
              </div>
              {sel.qr_image ? <img src={sel.qr_image} alt="Payment QR" className="mx-auto w-full max-w-[240px] object-contain rounded-lg border border-border-primary bg-white p-2" /> : null}
              {sel.upi_id ? <p className="text-xs">UPI: <span className="font-mono">{sel.upi_id}</span> <button type="button" onClick={() => copyText(sel.upi_id!, 'UPI')} className="text-[10px] text-[#55a630]">Copy</button></p> : null}
              {sel.bank_text ? <pre className="whitespace-pre-wrap break-words text-[11px] font-mono text-left bg-bg-base rounded-lg p-2 border border-border-primary">{sel.bank_text}</pre> : null}
            </div>

            <div className="space-y-1">
              <label className="text-xs text-text-secondary">Enter UTR / UPI reference number (after paying)</label>
              <input value={utr} onChange={(e) => setUtr(e.target.value)} placeholder="12-digit UTR" className="w-full px-4 py-3 rounded-xl border border-border-primary bg-bg-secondary font-mono outline-none focus:border-accent/50" />
            </div>
            <button type="button" disabled={submitting || !utr.trim()} onClick={() => void confirmPayment()} className="w-full py-3 rounded-xl bg-[#55a630] text-white font-bold disabled:opacity-50">{submitting ? 'Submitting…' : 'Confirm Payment'}</button>
          </>
        )}
      </div>

      {/* STEP 2 — notice / Accept & Continue */}
      {noticeOpen && sel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setNoticeOpen(false)} />
          <div className="relative w-full max-w-md rounded-2xl border border-border-primary bg-bg-primary p-5 space-y-3">
            <p className="text-sm font-bold">Before you proceed with {sel.display_name}:</p>
            <p className="text-xs text-text-secondary whitespace-pre-wrap">{sel.notice || 'Follow the payment instructions carefully and submit the UTR / reference immediately after payment, or the funds may not be credited.'}</p>
            <button type="button" onClick={() => { setNoticeOpen(false); setStep('form'); }} className="w-full py-2.5 rounded-xl bg-[#55a630] text-white font-bold">Accept and Continue</button>
          </div>
        </div>
      )}

      {/* STEP 5 — confirm dialog */}
      {confirmOpen && sel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setConfirmOpen(false)} />
          <div className="relative w-full max-w-md rounded-2xl border border-border-primary bg-bg-primary p-5 space-y-3">
            <p className="text-sm font-bold">Confirm your deposit</p>
            <ul className="text-xs text-text-secondary list-disc pl-4 space-y-1">
              <li>Pay the <b>exact</b> amount requested.</li>
              <li><b>Enter the correct UTR / UPI reference</b> after paying — else funds won&apos;t be credited.</li>
            </ul>
            <p className="text-xs">Deposit <b>{cur} {Number(amount).toLocaleString()}</b>{usd != null ? <> (≈ <b>${usd.toFixed(2)} USD</b>)</> : null} into your account.</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setConfirmOpen(false)} className="flex-1 py-2.5 rounded-xl border border-border-primary text-text-secondary font-semibold">Cancel</button>
              <button type="button" onClick={() => { setConfirmOpen(false); setStep('qr'); }} className="flex-1 py-2.5 rounded-xl bg-[#55a630] text-white font-bold">Confirm</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
