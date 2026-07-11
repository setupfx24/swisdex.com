'use client';

/**
 * KYC reminder that pops once per session for a logged-in LIVE user who hasn't
 * completed KYC (client 2026-06-23: "jab bhi user login kare aur KYC na ki ho
 * to KYC option pop up hona chahiye"). Rendered from DashboardShell so it fires
 * on the first authenticated page after login.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuthStore } from '@/stores/authStore';

export default function KycLoginPrompt() {
  const user = useAuthStore((s) => s.user);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!user || user.is_demo) return;
    // Sequence the onboarding: while the profile is incomplete the
    // ProfileCompleteGate (a blocking modal) owns the screen — don't stack the
    // KYC popup on top of it. Once the user finishes the profile,
    // profile_complete flips true, this effect re-runs and the KYC popup shows
    // (client 2026-06-24: "pehle profile completion, fir KYC popup").
    if (user.profile_complete === false) return;
    const kyc = (user.kyc_status || 'pending').toLowerCase();
    // Already done or in review → no prompt. Only nudge pending/rejected.
    if (['approved', 'verified', 'submitted', 'under_review'].includes(kyc)) return;
    if (typeof window === 'undefined') return;
    if (sessionStorage.getItem('kyc_prompt_shown') === '1') return;
    sessionStorage.setItem('kyc_prompt_shown', '1');
    setOpen(true);
  }, [user]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setOpen(false)} />
      <div className="relative w-full max-w-md rounded-2xl border border-border-primary bg-bg-base shadow-2xl p-6 space-y-4 animate-in fade-in zoom-in-95">
        <div className="text-3xl">🪪</div>
        <h3 className="text-lg font-bold text-text-primary">Complete your KYC</h3>
        <p className="text-sm text-text-secondary leading-relaxed">
          Verify your identity to unlock deposits, withdrawals and live trading. It only takes a couple of minutes.
        </p>
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="flex-1 py-2.5 rounded-xl border border-border-primary bg-bg-secondary text-sm font-semibold text-text-secondary hover:bg-bg-hover transition-fast"
          >
            Later
          </button>
          <Link
            href="/kyc"
            onClick={() => setOpen(false)}
            className="flex-1 py-2.5 rounded-xl bg-[#55a630] text-sm font-bold text-white text-center hover:bg-[#4a9329] transition-fast"
          >
            Start KYC
          </Link>
        </div>
      </div>
    </div>
  );
}
