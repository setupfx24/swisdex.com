'use client';

/**
 * Reusable branded success dialog.
 *
 * Replaces raw `window.alert()` calls on public forms (newsletter,
 * early-access, one-shot demos). Same visual language as the contact
 * page StatusModal — dark card, brand-green halo icon, halo sits above
 * the card, primary OK button — so every success confirmation across
 * the site reads as one system.
 *
 * Usage:
 *   const [open, setOpen] = useState(false);
 *   …
 *   onSubmit={(e) => { e.preventDefault(); setOpen(true); }}
 *   …
 *   <SuccessModal
 *     open={open}
 *     title="Subscribed"
 *     message="Thanks — we'll email you the next drop."
 *     onClose={() => setOpen(false)}
 *   />
 */

import { useEffect } from 'react';
import { Check, X } from 'lucide-react';

interface SuccessModalProps {
  open: boolean;
  title?: string;
  message: string;
  ctaLabel?: string;
  onClose: () => void;
  /** Small footnote shown below the OK button (optional). */
  footnote?: string;
}

export default function SuccessModal({
  open,
  title = 'Success',
  message,
  ctaLabel = 'OK',
  onClose,
  footnote,
}: SuccessModalProps) {
  // Escape closes; body scroll locked while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="success-modal-title"
      className="fixed inset-0 z-[300] flex items-center justify-center px-4"
      style={{ background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(6px)' }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-[460px] rounded-2xl pt-16 pb-8 px-8 text-center shadow-2xl"
        style={{
          background: 'linear-gradient(180deg, #12161c 0%, #0a0d12 100%)',
          border: '1px solid rgba(255,255,255,0.08)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.65), inset 0 1px 0 rgba(255,255,255,0.05)',
          animation: 'swisdex-success-in 0.28s cubic-bezier(.22,1,.36,1)',
        }}
      >
        {/* Close (subtle, top-right) */}
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="absolute top-4 right-4 w-8 h-8 rounded-full flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>

        {/* Halo checkmark — sits half above the card top edge */}
        <div
          className="absolute left-1/2 -top-10 -translate-x-1/2 w-20 h-20 rounded-full flex items-center justify-center"
          style={{
            background: 'linear-gradient(180deg, #55a630 0%, #3d7a1f 100%)',
            boxShadow: '0 12px 32px rgba(85,166,48,0.45), inset 0 1px 0 rgba(255,255,255,0.25)',
            border: '4px solid #0a0d12',
          }}
        >
          <Check className="w-10 h-10 text-white" strokeWidth={3} />
        </div>

        <h3
          id="success-modal-title"
          className="text-3xl md:text-4xl font-bold mb-3 tracking-tight"
          style={{ color: '#ffffff' }}
        >
          {title}
        </h3>

        <p
          className="text-sm md:text-base leading-relaxed mb-8 max-w-[380px] mx-auto"
          style={{ color: 'rgba(255,255,255,0.68)' }}
        >
          {message}
        </p>

        <button
          type="button"
          onClick={onClose}
          className="w-full py-3.5 rounded-xl text-white font-semibold text-base transition-transform active:scale-[0.98]"
          style={{
            background: 'linear-gradient(180deg, #55a630 0%, #3d7a1f 100%)',
            boxShadow:
              '0 8px 24px rgba(85,166,48,0.35), inset 0 1px 0 rgba(255,255,255,0.18)',
          }}
        >
          {ctaLabel}
        </button>

        {footnote && (
          <p className="mt-4 text-xs" style={{ color: 'rgba(255,255,255,0.4)' }}>
            {footnote}
          </p>
        )}
      </div>

      <style>{`
        @keyframes swisdex-success-in {
          from { opacity: 0; transform: translateY(12px) scale(0.96); }
          to   { opacity: 1; transform: translateY(0)     scale(1); }
        }
      `}</style>
    </div>
  );
}
