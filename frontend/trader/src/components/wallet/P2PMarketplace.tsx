'use client';

/**
 * Manual deposit/withdraw request — relays user details to the
 * relationship manager (RM) over email.
 *
 * Replaces the earlier P2P-marketplace concept per client decision
 * 2026-06-09. No escrow, no ads, no order matching — just a form that
 * captures name + amount + phone (+ payout details on withdraw), then
 * fires an email to the RM the admin configured in system settings
 * (`wallet.rm_email`).
 *
 * The component file name stays "P2PMarketplace" so the wallet page's
 * existing import + the admin's `wallet.p2p_enabled` toggle keep
 * working without any cross-file rename churn.
 */
import { useEffect, useState } from 'react';
import { Mail, Phone, CheckCircle2, Loader2, Info } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '@/lib/api/client';
import { useAuthStore } from '@/stores/authStore';

type Side = 'buy' | 'sell';

// Payment methods the trader can request for an RM-coordinated deposit
// (client 2026-06-16). The RM shares the matching payment detail.
const RM_METHODS: { key: string; label: string; hint: string }[] = [
  { key: 'Cryptocurrency', label: 'Cryptocurrency', hint: 'Your RM will share a crypto wallet address to send to.' },
  { key: 'BinancePay', label: 'BinancePay', hint: 'Your RM will share their BinancePay ID / QR.' },
  { key: 'UPI', label: 'UPI', hint: 'Your RM will share a UPI ID to pay to.' },
  { key: 'USDT', label: 'USDT', hint: 'Your RM will share a USDT (TRC20/ERC20) address.' },
  { key: 'Local Bank Transfer', label: 'Local Bank Transfer', hint: 'Your RM will share bank account / IFSC details.' },
  { key: 'Cash', label: 'Cash', hint: 'Your RM will coordinate an in-person / cash payment with you.' },
];

interface UserProfile {
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
}

export default function P2PMarketplace({ mode }: { mode: Side }) {
  // mode='buy'  → deposit flow (user gives money, RM credits SwisDex balance)
  // mode='sell' → withdraw flow (user pulls money out via RM)
  const side: 'deposit' | 'withdraw' = mode === 'buy' ? 'deposit' : 'withdraw';
  const authUser = useAuthStore((s) => s.user) as UserProfile | null;

  const [amount, setAmount] = useState<string>('');
  const [method, setMethod] = useState<string>(''); // chosen payment method (deposit only)
  const [phone, setPhone] = useState<string>(authUser?.phone || '');
  const [payoutDetails, setPayoutDetails] = useState<string>('');
  const [note, setNote] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  // Admin-fixed bank rate (dollar price = local units per 1 USD) so the RM form
  // shows the local-currency equivalent of the USD amount — easier for the user.
  const [rate, setRate] = useState<{ currency: string; deposit: number | null; withdraw: number | null } | null>(null);

  // Re-prime phone when the auth store hydrates after first paint.
  useEffect(() => {
    if (!phone && authUser?.phone) setPhone(authUser.phone);
  }, [authUser?.phone, phone]);

  // Pull the admin's fixed bank rate (from the payment-methods config) once.
  useEffect(() => {
    api.get<{ items: { pay_currency?: string; usd_rate?: number | null; withdrawal_usd_rate?: number | null }[] }>('/wallet/deposit/methods')
      .then((r) => {
        const m = (r?.items || []).find((x) => x.usd_rate != null || x.withdrawal_usd_rate != null);
        if (m) setRate({ currency: m.pay_currency || 'INR', deposit: m.usd_rate ?? null, withdraw: m.withdrawal_usd_rate ?? null });
      })
      .catch(() => {});
  }, []);

  const fullName = (
    [authUser?.first_name, authUser?.last_name].filter(Boolean).join(' ').trim()
    || authUser?.email
    || '—'
  );

  // Local-currency estimate at the admin's fixed rate. Shown for local methods
  // on deposit (what they'll pay) and always on withdraw (what they'll receive).
  const LOCAL_METHODS = ['UPI', 'Local Bank Transfer', 'Cash'];
  const dollarPrice = rate ? (side === 'deposit' ? rate.deposit : rate.withdraw) : null;
  const showLocal =
    dollarPrice != null && Number(amount) > 0 &&
    (side === 'withdraw' || LOCAL_METHODS.includes(method));
  const localAmount = showLocal ? Number(amount) * (dollarPrice as number) : null;

  const submit = async () => {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast.error('Enter a valid amount');
      return;
    }
    if (side === 'deposit' && !method) {
      toast.error('Choose a payment method');
      return;
    }
    if (!phone || phone.trim().length < 7) {
      toast.error('Enter a valid phone number');
      return;
    }
    if (side === 'withdraw' && !payoutDetails.trim()) {
      toast.error('Add your payout details (bank A/C)');
      return;
    }
    setSubmitting(true);
    try {
      await api.post<{ status: string; message: string }>(
        '/wallet/deposit/rm-request',
        {
          amount: amt,
          phone: phone.trim(),
          side,
          method: side === 'deposit' ? method : undefined,
          payout_details: side === 'withdraw' ? payoutDetails.trim() : undefined,
          note: note.trim() || undefined,
        },
      );
      setDone(true);
      toast.success(side === 'deposit'
        ? 'Request sent — your RM will contact you shortly'
        : 'Withdrawal request sent — your RM will coordinate payout');
    } catch (e: any) {
      toast.error(e?.message || 'Failed to submit request');
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div className="rounded-xl border border-accent/20 bg-accent/5 p-6 text-center space-y-3">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-accent/15">
          <CheckCircle2 className="w-6 h-6 text-accent" />
        </div>
        <div className="text-base font-bold text-text-primary">
          {side === 'deposit' ? 'Deposit request submitted' : 'Withdrawal request submitted'}
        </div>
        <p className="text-xs text-text-tertiary max-w-md mx-auto leading-relaxed">
          Your relationship manager has been notified by email and will contact
          you on <span className="text-text-primary font-semibold">{phone}</span>{' '}
          within <span className="text-text-primary font-semibold">24 hours</span>{' '}
          to coordinate the payment.
        </p>
        <button
          type="button"
          onClick={() => { setDone(false); setAmount(''); setNote(''); setMethod(''); }}
          className="mt-2 text-xs text-accent hover:underline"
        >
          Submit another request
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Intro */}
      <div className="rounded-xl border border-accent/20 bg-accent/5 px-4 py-3 flex items-start gap-2.5">
        <Mail className="w-4 h-4 text-accent shrink-0 mt-0.5" />
        <div className="text-xs text-text-secondary leading-relaxed">
          <span className="text-text-primary font-bold">
            Request Manually (Mail to RM).
          </span>{' '}
          {side === 'deposit'
            ? 'Fill the form — your name, amount, and phone number go to your relationship manager by email. They\'ll contact you to coordinate the payment.'
            : 'Fill the form — your name, amount, phone, and payout details go to your relationship manager by email. They\'ll process your withdrawal manually.'}
        </div>
      </div>

      {/* Form */}
      <div className="space-y-3">
        {side === 'deposit' && (
          <Field label="Payment method">
            <div className="grid grid-cols-2 gap-2">
              {RM_METHODS.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => setMethod(m.key)}
                  className={`px-3 py-2.5 rounded-xl border text-xs font-semibold transition-colors text-left ${
                    method === m.key
                      ? 'border-accent bg-accent/10 text-text-primary'
                      : 'border-border-primary bg-bg-secondary text-text-secondary hover:border-accent/40'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            {method ? (
              <p className="mt-1.5 text-[11px] text-text-tertiary leading-relaxed">
                {RM_METHODS.find((m) => m.key === method)?.hint}
              </p>
            ) : null}
          </Field>
        )}

        <Field label="Name">
          <input
            type="text"
            value={fullName}
            disabled
            className="w-full px-3 py-2.5 rounded-xl border border-border-primary bg-bg-secondary text-text-secondary text-sm cursor-not-allowed opacity-80"
          />
        </Field>

        <Field label={`Amount (USD)${side === 'withdraw' ? ' to withdraw' : ' to deposit'}`}>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary font-bold">$</span>
            <input
              type="number"
              min={1}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              // Stop the mouse wheel from silently changing the amount when the
              // field is focused (e.g. 1000 -> 999.97 from a few scroll ticks).
              onWheel={(e) => e.currentTarget.blur()}
              placeholder="0.00"
              className="w-full pl-7 pr-4 py-2.5 rounded-xl border border-border-primary bg-bg-secondary text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 font-mono font-bold text-base"
            />
          </div>
          {localAmount != null && rate && (
            <p className="text-[11px] text-text-secondary mt-1.5">
              {side === 'deposit' ? "You'll pay" : "You'll receive"} ≈{' '}
              <span className="font-bold text-text-primary">
                {localAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {rate.currency}
              </span>{' '}
              at the current rate.
            </p>
          )}
        </Field>

        <Field label="Phone number">
          <div className="relative">
            <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-tertiary" />
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+91 98765 43210"
              className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-border-primary bg-bg-secondary text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 text-sm"
            />
          </div>
        </Field>

        {side === 'withdraw' && (
          <Field label="Payout details (bank A/C / IFSC)">
            <textarea
              value={payoutDetails}
              onChange={(e) => setPayoutDetails(e.target.value)}
              placeholder="e.g. Bank: HDFC, A/C 123456789, IFSC HDFC0001234"
              rows={3}
              className="w-full px-3 py-2.5 rounded-xl border border-border-primary bg-bg-secondary text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 text-sm resize-none"
            />
          </Field>
        )}

        <Field label={`Note ${'(optional)'}`}>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Anything the RM should know"
            maxLength={240}
            className="w-full px-3 py-2.5 rounded-xl border border-border-primary bg-bg-secondary text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 text-sm"
          />
        </Field>

        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting || !amount || !phone || (side === 'deposit' && !method)}
          className="w-full mt-2 py-3 rounded-xl font-bold text-sm uppercase tracking-wider bg-accent text-white disabled:bg-bg-hover disabled:text-text-tertiary disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
          {submitting
            ? 'Sending…'
            : side === 'deposit'
            ? 'Submit deposit request'
            : 'Submit withdrawal request'}
        </button>

        <div className="flex items-start gap-1.5 text-[11px] text-text-tertiary leading-relaxed mt-1">
          <Info className="w-3 h-3 shrink-0 mt-0.5" />
          <span>
            Your request goes to your relationship manager by email. They reach
            out within 24 hours. No funds move until you confirm with them.
          </span>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[10px] uppercase tracking-wider text-text-tertiary mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}
