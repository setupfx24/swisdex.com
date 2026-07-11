'use client';



import { useState, useEffect, useMemo } from 'react';

import { clsx } from 'clsx';

import toast from 'react-hot-toast';

import DashboardShell from '@/components/layout/DashboardShell';

import DemoLockGate from '@/components/demo/DemoLockGate';

import { useAuthStore } from '@/stores/authStore';

import api from '@/lib/api/client';



type TabId = 'ib' | 'sub-broker' | 'network';



const TABS: { id: TabId; label: string }[] = [

  { id: 'ib', label: 'IB Program' },

  { id: 'sub-broker', label: 'Sub-Broker' },

  { id: 'network', label: 'My Network' },

];



function fmt(n: number) { return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function fmtDate(d: string) { try { return new Date(d).toLocaleDateString(); } catch { return d; } }

function Spinner() {
  return (
    <div className="flex justify-center py-16">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
    </div>
  );
}



export default function BusinessPage() {

  const isDemo = useAuthStore((s) => s.user?.is_demo);

  const [tab, setTab] = useState<TabId>('ib');

  // A Sub-IB does NOT run the IB Program — their dashboard is My Network (their
  // normal invitees) + Sub-Broker (downline who became Sub-IB). Hide the IB
  // Program tab for them (client 2026-06-26).
  const [bizSubIb, setBizSubIb] = useState(false);
  useEffect(() => {
    // The IB dashboard is the source of truth for is_sub_ib (drives the
    // "You're a Sub-IB" prompt); status carries ib_type. Check both so the IB
    // Program tab hides regardless of which one resolves first.
    Promise.allSettled([
      api.get<{ ib_type?: string; is_sub_ib?: boolean }>('/business/status'),
      api.get<{ ib_type?: string; is_sub_ib?: boolean }>('/business/ib/dashboard'),
    ]).then((res) => {
      const sub = res.some((r) =>
        r.status === 'fulfilled' && (r.value?.is_sub_ib === true || r.value?.ib_type === 'sub_ib'),
      );
      setBizSubIb(sub);
    });
  }, []);

  const visibleTabs = useMemo(
    () => (bizSubIb ? TABS.filter((t) => t.id !== 'ib') : TABS),
    [bizSubIb],
  );
  // Keep the active tab valid for the visible set (Sub-IB default = Sub-Broker).
  useEffect(() => {
    if (!visibleTabs.some((t) => t.id === tab)) setTab(visibleTabs[0]?.id ?? 'network');
  }, [visibleTabs, tab]);

  const tabIndex = visibleTabs.findIndex((t) => t.id === tab);

  const slideIndex = tabIndex >= 0 ? tabIndex : 0;

  const tabCount = visibleTabs.length || 1;

  if (isDemo) {
    return (
      <DashboardShell>
        <DemoLockGate
          feature="Affiliates & IB rewards"
          description="IB commissions, sub-broker partnerships and network payouts require a real trading account. Register a live account to start earning."
        >
          <></>
        </DemoLockGate>
      </DashboardShell>
    );
  }



  return (

    <DashboardShell mainClassName="p-0 flex flex-col min-h-0 overflow-hidden">

      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">

        <div className="w-full max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-4 sm:py-6">

          <section className="relative overflow-hidden rounded-xl border border-border-primary bg-card mb-4 sm:mb-5">

            <div

              className="pointer-events-none absolute inset-0 bg-gradient-to-br from-accent/[0.12] via-transparent to-accent/[0.05]"

              aria-hidden

            />

            <div className="relative z-10 px-4 sm:px-6 py-5 sm:py-8">

              <h1 className="text-xl sm:text-3xl font-bold text-text-primary mb-2 leading-tight">Business</h1>

            </div>

          </section>

          <div className="overflow-hidden rounded-xl border border-border-primary bg-card">

            <div className="relative flex min-h-[52px] border-b border-border-primary bg-card">

              <div className="pointer-events-none absolute inset-0 z-0" aria-hidden>

                <div

                  className="absolute top-0 h-full transition-[transform] duration-500 ease-[cubic-bezier(0.34,1.45,0.64,1)] will-change-transform"

                  style={{ width: `${100 / tabCount}%`, transform: `translate3d(${slideIndex * 100}%,0,0)` }}

                >

                  <div

                    className={clsx(

                      'absolute inset-x-1 top-0 h-full rounded-t-2xl border-2 border-b-0 border-accent bg-card-nested',

                      'animate-wallet-main-tab-glow',

                    )}

                  />

                </div>

              </div>

              {visibleTabs.map((t) => {

                const active = tab === t.id;

                return (

                  <button

                    key={t.id}

                    type="button"

                    onClick={() => setTab(t.id)}

                    className={clsx(

                      'relative z-10 flex-1 min-w-0 border-0 bg-transparent py-3.5 px-1 sm:px-2 text-xs sm:text-sm font-semibold outline-none',

                      'transition-colors duration-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/50',

                      active ? 'text-accent' : 'text-text-secondary hover:text-text-primary',

                    )}

                  >

                    {active ? (

                      <span className="relative inline-block animate-wallet-main-tab-text drop-shadow-[0_0_20px_rgba(85,166,48,0.7)]">

                        {t.label}

                      </span>

                    ) : (

                      <span className="relative inline-block truncate">{t.label}</span>

                    )}

                  </button>

                );

              })}

            </div>

            <div key={tab} className="bg-card-nested p-4 md:p-6 animate-wallet-fund-enter-lg min-h-[200px]">

              {tab === 'ib' && <IBTab />}

              {tab === 'sub-broker' && <SubBrokerTab />}

              {tab === 'network' && <NetworkTab />}

            </div>

          </div>

        </div>

      </div>

    </DashboardShell>

  );

}





function IBTab() {

  const [status, setStatus] = useState<any>(null);

  const [dashboard, setDashboard] = useState<any>(null);

  const [referrals, setReferrals] = useState<any[]>([]);

  const [commissions, setCommissions] = useState<any[]>([]);

  const [loading, setLoading] = useState(true);

  const [applying, setApplying] = useState(false);



  // Exposed so the Transfer-to-Main-Wallet click can refresh the
  // commission_balance + earnings_by_user lists in place.
  const fetchDashboard = async () => {
    try {
      const d = await api.get<any>('/business/ib/dashboard');
      setDashboard(d);
    } catch { /* ignore */ }
  };

  useEffect(() => {

    (async () => {

      try {

        const s = await api.get<any>('/business/status');

        setStatus(s);

        if (s.is_ib) {

          const [d, r, c] = await Promise.all([

            api.get<any>('/business/ib/dashboard'),

            api.get<any>('/business/ib/referrals'),

            api.get<any>('/business/ib/commissions'),

          ]);

          setDashboard(d);

          setReferrals(r.items || []);

          setCommissions(c.items || []);

        }

      } catch {} finally { setLoading(false); }

    })();

  }, []);



  const handleApply = async () => {

    setApplying(true);

    try {

      await api.post('/business/apply', {});

      toast.success('IB application submitted!');

      const s = await api.get<any>('/business/status');

      setStatus(s);

    } catch (e: any) { toast.error(e.message || 'Failed'); } finally { setApplying(false); }

  };



  // Deeper users (introduced by another IB, not the Super IB) can't apply as a
  // full IB — they self-apply as a Sub-IB instead. On approval they're linked
  // under their introducing IB and earn per-lot MLM commission on their own
  // downline (client 2026-06-29).
  const handleApplySubIb = async () => {

    setApplying(true);

    try {

      await api.post('/business/apply-sub-broker', {});

      toast.success('Sub-IB application submitted!');

      const s = await api.get<any>('/business/status');

      setStatus(s);

    } catch (e: any) { toast.error(e.message || 'Failed'); } finally { setApplying(false); }

  };



  if (loading) return <Spinner />;



  if (!status?.is_ib && status?.application_status === 'pending') {

    return (

      <div className="rounded-xl border border-border-primary bg-card p-6 sm:p-8 noise-texture text-center max-w-lg mx-auto">

        <div className="text-2xl mb-2">⏳</div>

        <h3 className="text-sm font-semibold text-text-primary">Application Pending</h3>

        <p className="text-xxs text-text-tertiary mt-1">Your application is under review by the admin team.</p>

      </div>

    );

  }



  if (!status?.is_ib) {

    // Client 2026-06-19: only Super-IB-introduced (or no-referral) users may
    // self-apply. A user introduced by another IB/affiliate sees ONLY a
    // "Contact SwisDex to become an IB" prompt — no self-apply / eligibility.
    if (status?.can_become_ib === false) {
      // Introduced by another IB (not the Super IB) → can't apply as a full IB,
      // but CAN self-apply as a Sub-IB. On approval they're linked under their
      // introducing IB and earn per-lot MLM commission on their own downline
      // (client 2026-06-29). Same min-deposit gate as the full-IB flow.
      const subElig = status?.eligibility as
        | { min_deposit_required_usd: number; total_deposits_usd: number; is_eligible: boolean; kyc_approved?: boolean }
        | undefined;
      const subMin = subElig?.min_deposit_required_usd ?? 0;
      const subDeposits = subElig?.total_deposits_usd ?? 0;
      const subKyc = subElig?.kyc_approved !== false; // KYC cleared (or unknown)
      const subDepositOk = subMin <= 0 || subDeposits >= subMin;
      const subEligible = subElig ? subElig.is_eligible : true; // deposit AND kyc
      const subPct = subMin > 0 ? Math.min(100, (subDeposits / subMin) * 100) : 100;
      const subRemaining = Math.max(0, subMin - subDeposits);
      return (
        <div className="rounded-xl border border-border-primary bg-card p-6 sm:p-10 noise-texture text-center space-y-5 max-w-2xl mx-auto">
          <div className="text-3xl">🤝</div>
          <span className="inline-block text-xs font-semibold px-2.5 py-0.5 rounded-md bg-warning/15 text-warning">You joined under an IB</span>
          <h3 className="text-lg sm:text-xl font-bold text-text-primary">Become a Sub-IB</h3>
          <p className="text-sm text-text-secondary leading-relaxed">
            You joined through an Introducing Broker, so the full IB program isn&apos;t
            available here. You can apply as a <strong>Sub-IB</strong> instead — build your
            own network and earn per-lot commission on your downline&apos;s trades.
          </p>

          {subElig && (subMin > 0 || !subKyc) && (
            <div className="rounded-lg border border-border-primary bg-bg-secondary p-4 text-left space-y-2">
              {!subKyc && (
                <p className="text-[11px] text-warning">
                  ⚠ Complete your KYC verification first — it&apos;s required before becoming a Sub-IB.
                </p>
              )}
              {subMin > 0 && (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-text-secondary">Eligibility</span>
                    <span className={clsx('text-xs font-bold tabular-nums', subDepositOk ? 'text-success' : 'text-warning')}>
                      ${fmt(subDeposits)} / ${fmt(subMin)}
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-bg-tertiary overflow-hidden">
                    <div
                      className={clsx('h-full transition-all', subDepositOk ? 'bg-success' : 'bg-warning')}
                      style={{ width: `${subPct}%` }}
                    />
                  </div>
                  <p className={clsx('text-[11px]', subDepositOk ? 'text-success' : 'text-text-tertiary')}>
                    {subDepositOk
                      ? 'You meet the minimum deposit requirement.'
                      : `Deposit ${'$' + fmt(subRemaining)} more in approved funds to apply as a Sub-IB.`}
                  </p>
                </>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={handleApplySubIb}
            disabled={applying || !subEligible}
            className={clsx(
              'w-full max-w-xs mx-auto px-6 py-3.5 rounded-xl text-sm font-bold transition-all border-2 border-accent',
              (applying || !subEligible)
                ? 'opacity-50 cursor-not-allowed bg-bg-secondary text-text-tertiary'
                : 'bg-accent text-black hover:brightness-110 shadow-[0_0_24px_rgba(85,166,48,0.35)]',
            )}
          >
            {applying ? 'Submitting...' : subEligible ? 'Apply as Sub-IB' : (!subKyc ? 'Complete KYC first' : 'Deposit to Unlock')}
          </button>
        </div>
      );
    }

    const eligibility = status?.eligibility as
      | { min_deposit_required_usd: number; total_deposits_usd: number; is_eligible: boolean; kyc_approved?: boolean }
      | undefined;

    const minRequired = eligibility?.min_deposit_required_usd ?? 0;

    const currentDeposits = eligibility?.total_deposits_usd ?? 0;

    const kycOk = eligibility?.kyc_approved !== false; // KYC cleared (or unknown)

    const depositOk = minRequired <= 0 || currentDeposits >= minRequired;

    const eligible = eligibility ? eligibility.is_eligible : true; // deposit AND kyc

    const pct = minRequired > 0 ? Math.min(100, (currentDeposits / minRequired) * 100) : 100;

    const remaining = Math.max(0, minRequired - currentDeposits);

    return (

      <div className="rounded-xl border border-border-primary bg-card p-6 sm:p-10 noise-texture text-center space-y-5 max-w-2xl mx-auto">

        <h3 className="text-lg sm:text-xl font-bold text-text-primary">Become an Introducing Broker</h3>

        {eligibility && (minRequired > 0 || !kycOk) && (

          <div className="rounded-lg border border-border-primary bg-bg-secondary p-4 text-left space-y-2">

            {!kycOk && (
              <p className="text-[11px] text-warning">
                ⚠ Complete your KYC verification first — it&apos;s required before becoming an IB.
              </p>
            )}

            {minRequired > 0 && (
              <>
                <div className="flex items-center justify-between gap-2">

                  <span className="text-xs font-semibold text-text-secondary">Eligibility</span>

                  <span className={clsx('text-xs font-bold tabular-nums', depositOk ? 'text-success' : 'text-warning')}>

                    ${fmt(currentDeposits)} / ${fmt(minRequired)}

                  </span>

                </div>

                <div className="h-2 rounded-full bg-bg-tertiary overflow-hidden">

                  <div

                    className={clsx('h-full transition-all', depositOk ? 'bg-success' : 'bg-warning')}

                    style={{ width: `${pct}%` }}

                  />

                </div>

                <p className={clsx('text-[11px]', depositOk ? 'text-success' : 'text-text-tertiary')}>

                  {depositOk

                    ? 'You meet the minimum deposit requirement.'

                    : `Deposit ${'$' + fmt(remaining)} more in approved funds to qualify for the IB program.`}

                </p>
              </>
            )}

          </div>

        )}

        <button

          type="button"

          onClick={handleApply}

          disabled={applying || !eligible}

          className={clsx(

            'w-full max-w-xs mx-auto px-6 py-3.5 rounded-xl text-sm font-bold transition-all border-2 border-accent',

            (applying || !eligible)

              ? 'opacity-50 cursor-not-allowed bg-bg-secondary text-text-tertiary'

              : 'bg-accent text-black hover:brightness-110 shadow-[0_0_24px_rgba(85,166,48,0.35)]',

          )}

        >

          {applying ? 'Submitting...' : eligible ? 'Apply Now' : (!kycOk ? 'Complete KYC first' : 'Deposit to Unlock')}

        </button>

      </div>

    );

  }



  // A Sub-IB (anyone not introduced directly by the Super IB) does NOT get the
  // IB program section — only a prompt to apply to SwisDex (client 2026-06-23:
  // "sub-sub wale ko IB section show ho raha hai").
  if (dashboard?.is_sub_ib) {
    return (
      <div className="rounded-xl border border-border-primary bg-card p-6 sm:p-8 noise-texture text-center max-w-lg mx-auto space-y-3">
        <div className="text-2xl">🤝</div>
        <h3 className="text-sm font-semibold text-text-primary">You&apos;re a Sub-IB</h3>
        <p className="text-xxs text-text-tertiary">
          The IB program is available to full IBs. To become a full IB, apply to SwisDex.
        </p>
        <a
          href="/support?topic=ib-upgrade"
          className="inline-block text-xs font-medium px-4 py-2 rounded-md bg-accent/15 text-accent border border-accent/30 hover:bg-accent/25"
        >
          Apply to SwisDex to become an IB
        </a>
      </div>
    );
  }

  return (

    <div className="space-y-4">

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">

        {[

          { label: 'Total Earned', value: `$${fmt(dashboard?.total_earned || 0)}`, color: 'text-success' },

          { label: 'Pending Payout', value: `$${fmt(dashboard?.pending_payout || 0)}`, color: 'text-warning' },

          // Downline economics (client 2026-06-19): collective deposit pool +
          // active user count drive which per-lot tier the IB earns.
          { label: 'Users Deposit Pool', value: `$${fmt(status?.deposit_pool_usd || 0)}`, color: 'text-accent' },

          { label: 'Active Users', value: `${status?.active_users || 0}${status?.total_referred ? ` / ${status.total_referred}` : ''}`, color: 'text-success' },

          { label: 'Referrals', value: String(dashboard?.total_referrals ?? status?.total_referred ?? 0), color: 'text-accent' },

        ].map(c => (

          <div key={c.label} className="rounded-xl border border-border-primary bg-card p-3 noise-texture">

            <p className="text-xxs text-text-tertiary">{c.label}</p>

            <p className={clsx('text-lg font-bold font-mono tabular-nums mt-0.5', c.color)}>{c.value}</p>

          </div>

        ))}

      </div>

      {dashboard?.tier && (

        <div className="rounded-xl border border-accent/25 bg-accent/[0.04] p-4">

          <div className="flex flex-wrap items-center justify-between gap-3">

            <div>

              <p className="text-xxs text-text-tertiary uppercase">Current tier</p>

              <p className="text-lg font-bold text-accent mt-0.5">

                {dashboard.tier.label}

              </p>

              {/* Per-lot breakdown across account types — what the IB earns
                  varies by which account type the referred user trades on. */}

              {dashboard.tier.per_lot_by_account_type ? (

                <div className="flex flex-wrap gap-3 mt-2 text-xs text-text-secondary">

                  {[

                    { key: 'standard', label: 'Standard' },

                    { key: 'ecn',      label: 'ECN' },

                    { key: 'vip',      label: 'VIP' },

                  ].map((a) => {

                    const rate = dashboard.tier.per_lot_by_account_type?.[a.key];

                    if (rate == null) return null;

                    return (

                      <span key={a.key} className="inline-flex items-baseline gap-1">

                        <span className="text-text-tertiary">{a.label}:</span>

                        <strong className="text-text-primary font-mono tabular-nums">${rate}/lot</strong>

                      </span>

                    );

                  })}

                </div>

              ) : (

                <p className="text-sm font-mono text-text-primary mt-1">${dashboard.tier.per_lot}/lot</p>

              )}

              <p className="text-xxs text-text-tertiary mt-1">

                {dashboard.activations ?? 0} activations · ${Number(dashboard.referral_deposit_total ?? 0).toLocaleString('en-US')} referred deposits

              </p>

            </div>

            {dashboard?.next_tier ? (

              <div className="text-right">

                <p className="text-xxs text-text-tertiary uppercase">Next tier</p>

                <p className="text-sm font-bold text-text-primary mt-0.5">

                  {dashboard.next_tier.label} (${dashboard.next_tier.per_lot}/lot)

                </p>

                <p className="text-xxs text-text-tertiary mt-1">

                  {[
                    dashboard.needed_activations_for_next != null && dashboard.needed_activations_for_next > 0
                      ? `${dashboard.needed_activations_for_next} more activations`
                      : null,
                    dashboard.needed_amount_for_next != null && dashboard.needed_amount_for_next > 0
                      ? `$${Number(dashboard.needed_amount_for_next).toLocaleString('en-US')} more deposits`
                      : null,
                  ].filter(Boolean).join(' or ') || 'Almost there'} to unlock

                </p>

              </div>

            ) : (

              <div className="text-right">

                <p className="text-xxs text-text-tertiary uppercase">Status</p>

                <p className="text-sm font-bold text-success mt-0.5">Top tier reached</p>

              </div>

            )}

          </div>

        </div>

      )}

      {/* Commission pool + Transfer-to-Main-Wallet (2026-05-26 client
          spec). Commissions accumulate per trade in a separate balance;
          IB presses Transfer to move the pool into the main wallet,
          then withdraws from there. Card hides itself if the pool is
          empty AND there's no history of past transfers. */}

      <div className="rounded-xl border border-success/30 bg-success/[0.06] p-4 flex flex-wrap items-center justify-between gap-3">

        <div className="min-w-0">

          <p className="text-xxs uppercase tracking-wider text-text-tertiary">Available commission</p>

          <p className="text-2xl font-bold text-success font-mono tabular-nums mt-0.5">${fmt(dashboard?.commission_balance || 0)}</p>

          <p className="text-[11px] text-text-tertiary mt-0.5">

            Transfer moves the amount into your main wallet — Transactions + notification fire on transfer.

          </p>

        </div>

        <button

          type="button"

          onClick={async () => {

            try {

              const res = await api.post<{ transferred: number }>('/business/ib/transfer', {});

              toast.success(`$${fmt(res.transferred)} moved to main wallet`);

              await fetchDashboard();

            } catch (e: any) {

              toast.error(e?.message || 'Transfer failed');

            }

          }}

          disabled={!(dashboard?.commission_balance > 0)}

          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-success hover:bg-success/90 text-black font-semibold text-sm disabled:opacity-40 disabled:cursor-not-allowed transition-colors"

        >

          Transfer to Main Wallet

        </button>

      </div>

      {/* Per-trader earnings — "kis user se kitna earn kiya" view */}

      {Array.isArray(dashboard?.earnings_by_user) && dashboard.earnings_by_user.length > 0 && (

        <div className="rounded-xl border border-border-primary bg-card noise-texture overflow-hidden">

          <div className="px-4 py-3 border-b border-border-primary">

            <h3 className="text-xs font-semibold text-text-primary">Earnings by Trader</h3>

            <p className="text-[11px] text-text-tertiary mt-0.5">Lifetime commission attributed to each of your referred users.</p>

          </div>

          <table className="w-full text-xs">

            <thead><tr className="border-b border-border-primary text-xxs text-text-tertiary">

              <th className="px-4 py-2 text-left">Trader</th>

              <th className="px-4 py-2 text-right">Trades</th>

              <th className="px-4 py-2 text-right">Earned</th>

            </tr></thead>

            <tbody>

              {dashboard.earnings_by_user.map((r: any) => (

                <tr key={r.user_id} className="border-b border-border-primary/50 last:border-b-0 hover:bg-bg-hover/30">

                  <td className="px-4 py-2.5">

                    <p className="text-text-primary font-semibold truncate max-w-[200px]">{r.name || '—'}</p>

                    <p className="text-[10px] text-text-tertiary truncate max-w-[200px]">{r.email}</p>

                  </td>

                  <td className="px-4 py-2.5 text-right font-mono text-text-secondary tabular-nums">{r.trades_attributed}</td>

                  <td className="px-4 py-2.5 text-right font-mono font-bold text-success tabular-nums">${fmt(r.total_commission || 0)}</td>

                </tr>

              ))}

            </tbody>

          </table>

        </div>

      )}

      <div className="rounded-xl border border-accent/25 bg-accent/[0.04] p-3 text-xs text-text-secondary leading-relaxed">

        IB commissions accumulate as your referred users trade. Press <span className="text-text-primary font-semibold">Transfer to Main Wallet</span> above to move the pool into withdrawable balance, then <span className="text-text-primary font-semibold">withdraw</span> from the Wallet page.

      </div>



      {dashboard?.referral_link && (

        <div className="rounded-xl border border-border-primary bg-card p-4 noise-texture">

          <p className="text-xxs text-text-tertiary mb-2">Your Referral Link</p>

          <div className="flex items-center gap-2">

            <input type="text" readOnly value={dashboard.referral_link} className="flex-1 text-xs font-mono bg-bg-secondary border border-border-primary rounded-lg px-3 py-2 text-text-primary focus:outline-none" />

            <button type="button" onClick={() => { navigator.clipboard.writeText(dashboard.referral_link); toast.success('Copied!'); }} className="shrink-0 px-3 py-2 text-xs font-semibold rounded-lg border border-accent text-accent hover:bg-accent hover:text-black transition-colors">Copy</button>

          </div>

          <p className="text-xxs text-text-tertiary mt-2">Code: <span className="text-accent font-mono font-bold">{dashboard.referral_code}</span></p>

        </div>

      )}



      {referrals.length > 0 && (

        <div className="rounded-xl border border-border-primary bg-card noise-texture overflow-hidden">

          <div className="px-4 py-3 border-b border-border-primary"><h3 className="text-xs font-semibold text-text-primary">My Referrals</h3></div>

          <table className="w-full text-xs">

            <thead><tr className="border-b border-border-primary text-xxs text-text-tertiary">

              <th className="px-4 py-2 text-left">User</th><th className="px-4 py-2 text-left">Joined</th><th className="px-4 py-2 text-right">Balance</th>

            </tr></thead>

            <tbody>

              {referrals.map((r: any) => (

                <tr key={r.id} className="border-b border-border-primary/50 hover:bg-bg-hover/30">

                  <td className="px-4 py-2"><p className="text-text-primary">{r.referred_user?.name}</p><p className="text-xxs text-text-tertiary">{r.referred_user?.email}</p></td>

                  <td className="px-4 py-2 text-text-tertiary">{r.referred_user?.joined_at ? fmtDate(r.referred_user.joined_at) : '—'}</td>

                  <td className="px-4 py-2 text-right font-mono text-text-primary">${fmt(r.total_deposit || 0)}</td>

                </tr>

              ))}

            </tbody>

          </table>

        </div>

      )}



      {commissions.length > 0 && (

        <div className="rounded-xl border border-border-primary bg-card noise-texture overflow-hidden">

          <div className="px-4 py-3 border-b border-border-primary"><h3 className="text-xs font-semibold text-text-primary">Commission History</h3></div>

          <table className="w-full text-xs">

            <thead><tr className="border-b border-border-primary text-xxs text-text-tertiary">

              <th className="px-4 py-2 text-left">From</th><th className="px-4 py-2 text-left">Type</th><th className="px-4 py-2 text-left">Level</th><th className="px-4 py-2 text-right">Amount</th><th className="px-4 py-2 text-right">Status</th>

            </tr></thead>

            <tbody>

              {commissions.map((c: any) => (

                <tr key={c.id} className="border-b border-border-primary/50 hover:bg-bg-hover/30">

                  <td className="px-4 py-2"><p className="text-text-primary">{c.source_user?.name}</p></td>

                  <td className="px-4 py-2 text-text-secondary capitalize">{c.commission_type?.replace('_', ' ')}</td>

                  <td className="px-4 py-2 text-text-secondary">L{c.mlm_level}</td>

                  <td className="px-4 py-2 text-right font-mono text-success">${fmt(c.amount || 0)}</td>

                  <td className="px-4 py-2 text-right"><span className={clsx('px-1.5 py-0.5 rounded text-xxs font-medium', c.status === 'paid' ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning')}>{c.status}</span></td>

                </tr>

              ))}

            </tbody>

          </table>

        </div>

      )}

    </div>

  );

}





function SubBrokerTab() {

  const [status, setStatus] = useState<any>(null);

  const [dashboard, setDashboard] = useState<any>(null);

  // The full IB-dashboard payload (tier, deposit pool, per-user commission
  // breakdown) — surfaced here so a Sub-IB sees their tier/pool/earnings even
  // though the IB Program tab is hidden for them (client 2026-06-29).
  const [ibDash, setIbDash] = useState<any>(null);

  const [loading, setLoading] = useState(true);



  useEffect(() => {

    (async () => {

      try {

        const s = await api.get<any>('/business/status');

        setStatus(s);

        if (s.is_ib) {

          const [d, ib] = await Promise.allSettled([
            api.get<any>('/business/sub-broker/dashboard'),
            api.get<any>('/business/ib/dashboard'),
          ]);
          if (d.status === 'fulfilled') setDashboard(d.value);
          if (ib.status === 'fulfilled') setIbDash(ib.value);

        }

      } catch {} finally { setLoading(false); }

    })();

  }, []);



  if (loading) return <Spinner />;



  if (status?.application_status === 'pending') {

    return (

      <div className="rounded-xl border border-border-primary bg-card p-6 sm:p-8 noise-texture text-center max-w-lg mx-auto">

        <div className="text-2xl mb-2">⏳</div>

        <h3 className="text-sm font-semibold text-text-primary">Application Pending</h3>

        <p className="text-xxs text-text-tertiary mt-1">Your sub-broker application is under review.</p>

      </div>

    );

  }



  if (dashboard) {

    return (

      <div className="space-y-4">

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">

          {[

            { label: 'Sub-Brokers', value: String(dashboard.direct_clients || 0), color: 'text-accent' },

            // Pool + active users come from /business/status (always present),
            // so a Sub-IB sees their direct downline's deposit pool up top even
            // if the richer /ib/dashboard fetch is slow/unavailable (client
            // 2026-06-29: "Sub-IB ko direct user ka pool amount nahi dikh raha").
            { label: 'Users Deposit Pool', value: `$${fmt(status?.deposit_pool_usd || 0)}`, color: 'text-accent' },

            { label: 'Active Users', value: `${status?.active_users || 0}${status?.total_referred ? ` / ${status.total_referred}` : ''}`, color: 'text-success' },

            { label: 'Total Earned', value: `$${fmt(dashboard.total_earned || 0)}`, color: 'text-success' },

            { label: 'Pending', value: `$${fmt(dashboard.pending_payout || 0)}`, color: 'text-warning' },

            { label: 'Commission', value: `$${fmt(dashboard.total_commission || 0)}`, color: 'text-text-primary' },

          ].map(c => (

            <div key={c.label} className="rounded-xl border border-border-primary bg-card p-3 noise-texture">

              <p className="text-xxs text-text-tertiary">{c.label}</p>

              <p className={clsx('text-lg font-bold font-mono tabular-nums mt-0.5', c.color)}>{c.value}</p>

            </div>

          ))}

        </div>



        <div className="rounded-xl border border-border-primary bg-card p-4 noise-texture space-y-3">

          {/* Full shareable referral link (client 2026-06-30: Sub-IB ka link
              generate nahi ho raha tha — sirf code dikh raha tha). */}
          <div>
            <p className="text-xxs text-text-tertiary mb-1">Your referral link</p>
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={ibDash?.referral_link || (typeof window !== 'undefined' ? `${window.location.origin}/auth/register?ref=${dashboard.referral_code}` : '')}
                className="flex-1 text-xs font-mono bg-bg-secondary border border-border-primary rounded-lg px-3 py-2 text-text-primary focus:outline-none"
              />
              <button
                type="button"
                onClick={() => {
                  const link = ibDash?.referral_link || `${window.location.origin}/auth/register?ref=${dashboard.referral_code}`;
                  navigator.clipboard.writeText(link);
                  toast.success('Link copied!');
                }}
                className="shrink-0 px-3 py-2 text-xs font-semibold rounded-lg border border-accent text-accent hover:bg-accent hover:text-black transition-colors"
              >
                Copy
              </button>
            </div>
          </div>

          <div>
            <p className="text-xxs text-text-tertiary mb-1">Your referral code</p>
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold font-mono text-accent">{dashboard.referral_code}</span>
              <button type="button" onClick={() => { navigator.clipboard.writeText(dashboard.referral_code); toast.success('Copied!'); }} className="px-2 py-1 text-xxs font-semibold rounded-lg border border-accent text-accent hover:bg-accent hover:text-black transition-colors">Copy</button>
            </div>
          </div>

        </div>

        {/* Transfer commission to main wallet — a Sub-IB withdraws their
            earnings the same way a full IB does (client 2026-06-30: "total earn
            dikha raha hai par claim/wallet me nahi ja raha"). */}
        {ibDash && (
          <div className="rounded-xl border border-success/30 bg-success/[0.06] p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xxs uppercase tracking-wider text-text-tertiary">Available commission</p>
              <p className="text-2xl font-bold text-success font-mono tabular-nums mt-0.5">${fmt(ibDash.commission_balance || 0)}</p>
              <p className="text-[11px] text-text-tertiary mt-0.5">Transfer moves it into your main wallet — then withdraw from the Wallet page.</p>
            </div>
            <button
              type="button"
              onClick={async () => {
                try {
                  const res = await api.post<{ transferred: number }>('/business/ib/transfer', {});
                  toast.success(`$${fmt(res.transferred)} moved to main wallet`);
                  const [d, ib] = await Promise.allSettled([
                    api.get<any>('/business/sub-broker/dashboard'),
                    api.get<any>('/business/ib/dashboard'),
                  ]);
                  if (d.status === 'fulfilled') setDashboard(d.value);
                  if (ib.status === 'fulfilled') setIbDash(ib.value);
                } catch (e: any) { toast.error(e?.message || 'Transfer failed'); }
              }}
              disabled={!(ibDash.commission_balance > 0)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-success hover:bg-success/90 text-black font-semibold text-sm disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Transfer to Main Wallet
            </button>
          </div>
        )}



        {/* Which tier the Sub-IB falls in + progress to the next one (client
            2026-06-29). Pool / active users are shown in the top cards above. */}
        {ibDash && (
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-border-primary bg-card p-3 noise-texture">
              <p className="text-xxs text-text-tertiary">Your Tier</p>
              <p className="text-lg font-bold mt-0.5 text-accent">{ibDash.tier?.label || 'Unranked'}</p>
              <p className="text-xxs text-text-tertiary">{ibDash.tier?.per_lot != null ? `$${fmt(ibDash.tier.per_lot)}/lot` : 'No tier yet — base rate applies'}</p>
            </div>
            <div className="rounded-xl border border-border-primary bg-card p-3 noise-texture">
              <p className="text-xxs text-text-tertiary">Next Tier</p>
              <p className="text-lg font-bold mt-0.5 text-text-primary">{ibDash.next_tier?.label || 'Top tier'}</p>
              <p className="text-xxs text-text-tertiary">
                {ibDash.next_tier
                  ? [ibDash.needed_activations_for_next ? `${ibDash.needed_activations_for_next} more users` : null,
                     ibDash.needed_amount_for_next ? `$${fmt(ibDash.needed_amount_for_next)} more pool` : null]
                     .filter(Boolean).join(' or ') || '—'
                  : '—'}
              </p>
            </div>
          </div>
        )}

        {/* Per-user commission breakdown — "kis user se kitna mila" (client
            2026-06-29). Same data the full-IB dashboard shows. */}
        {ibDash?.earnings_by_user?.length > 0 && (
          <div className="rounded-xl border border-border-primary bg-card noise-texture overflow-hidden">
            <div className="px-4 py-3 border-b border-border-primary"><h3 className="text-xs font-semibold text-text-primary">Commission by User</h3></div>
            <table className="w-full text-xs">
              <thead><tr className="border-b border-border-primary text-xxs text-text-tertiary">
                <th className="px-4 py-2 text-left">User</th><th className="px-4 py-2 text-right">Trades</th><th className="px-4 py-2 text-right">Earned</th>
              </tr></thead>
              <tbody>
                {ibDash.earnings_by_user.map((u: any) => (
                  <tr key={u.user_id} className="border-b border-border-primary/50 hover:bg-bg-hover/30">
                    <td className="px-4 py-2"><p className="text-text-primary">{u.name || u.email}</p><p className="text-xxs text-text-tertiary">{u.email}</p></td>
                    <td className="px-4 py-2 text-right font-mono text-text-secondary">{u.trades_attributed}</td>
                    <td className="px-4 py-2 text-right font-mono text-success">${fmt(u.total_commission || 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}



        {dashboard.clients?.length > 0 && (

          <div className="rounded-xl border border-border-primary bg-card noise-texture overflow-hidden">

            <div className="px-4 py-3 border-b border-border-primary"><h3 className="text-xs font-semibold text-text-primary">Your Sub-Brokers</h3></div>

            <table className="w-full text-xs">

              <thead><tr className="border-b border-border-primary text-xxs text-text-tertiary">

                <th className="px-4 py-2 text-left">Client</th><th className="px-4 py-2 text-left">Status</th><th className="px-4 py-2 text-right">Balance</th><th className="px-4 py-2 text-left">Joined</th>

              </tr></thead>

              <tbody>

                {dashboard.clients.map((c: any) => (

                  <tr key={c.user_id} className="border-b border-border-primary/50 hover:bg-bg-hover/30">

                    <td className="px-4 py-2"><p className="text-text-primary">{c.name}</p><p className="text-xxs text-text-tertiary">{c.email}</p></td>

                    <td className="px-4 py-2"><span className={clsx('px-1.5 py-0.5 rounded text-xxs font-medium', c.status === 'active' ? 'bg-success/15 text-success' : 'bg-text-tertiary/15 text-text-tertiary')}>{c.status}</span></td>

                    <td className="px-4 py-2 text-right font-mono text-text-primary">${fmt(c.total_balance || 0)}</td>

                    <td className="px-4 py-2 text-text-tertiary">{c.joined_at ? fmtDate(c.joined_at) : '—'}</td>

                  </tr>

                ))}

              </tbody>

            </table>

          </div>

        )}

      </div>

    );

  }

  // A full IB does NOT apply to be a sub-broker (client 2026-06-20): they
  // already have a higher tier. Show their network pointer instead of the
  // apply form.
  if (status?.is_ib) {
    return (
      <div className="rounded-xl border border-border-primary bg-card p-6 sm:p-8 noise-texture text-center max-w-lg mx-auto space-y-2">
        <div className="text-2xl">✅</div>
        <h3 className="text-sm font-semibold text-text-primary">You're already an IB</h3>
        <p className="text-xxs text-text-tertiary">
          As an IB you don&apos;t need to apply as a sub-broker. See your sub-IBs and downline in the
          <span className="text-accent font-medium"> My Network</span> tab.
        </p>
      </div>
    );
  }

  // A user who can become a FULL IB (introduced by the Super IB, or with no
  // referrer) is on the IB track — they must NOT be offered the sub-broker /
  // sub-IB apply (client 2026-06-29: "IB ko sub-IB banne ka option dikh raha
  // hai"). Only a user introduced by ANOTHER IB (can_become_ib === false)
  // belongs here. (!== false also covers the undefined/loading case → safer to
  // hide the form than to wrongly offer it.)
  if (status?.can_become_ib !== false) {
    return (
      <div className="rounded-xl border border-border-primary bg-card p-6 sm:p-8 noise-texture text-center max-w-lg mx-auto space-y-2">
        <div className="text-2xl">🚀</div>
        <h3 className="text-sm font-semibold text-text-primary">Become a full IB instead</h3>
        <p className="text-xxs text-text-tertiary">
          You&apos;re eligible for the full Introducing Broker program — apply from the
          <span className="text-accent font-medium"> IB Program</span> tab. The sub-broker
          path is only for users who joined through an existing IB.
        </p>
      </div>
    );
  }

  // can_become_ib === false → introduced by another IB → sub-IB track. The
  // single apply entry point is the IB Program tab's "Apply as Sub-IB" button
  // (client 2026-06-29: keep sub-IB apply in ONE place — no duplicate form).
  return (
    <div className="rounded-xl border border-border-primary bg-card p-6 sm:p-8 noise-texture text-center max-w-lg mx-auto space-y-2">
      <div className="text-2xl">🤝</div>
      <h3 className="text-sm font-semibold text-text-primary">Apply as a Sub-IB</h3>
      <p className="text-xxs text-text-tertiary">
        You joined through an Introducing Broker. Apply as a Sub-IB from the
        <span className="text-accent font-medium"> IB Program</span> tab — once approved,
        your downline and earnings show up here and in My Network.
      </p>
    </div>
  );

}





function NetworkTab() {

  const [tree, setTree] = useState<any>(null);

  const [loading, setLoading] = useState(true);



  useEffect(() => {

    (async () => {

      try {

        const res = await api.get<any>('/business/ib/tree');

        setTree(res);

      } catch {}

      setLoading(false);

    })();

  }, []);



  if (loading) return <Spinner />;

  if (!tree) return <div className="rounded-xl border border-dashed border-border-primary bg-bg-secondary/50 py-16 px-4 text-center text-sm text-text-secondary max-w-lg mx-auto">You need to be an approved IB to see your network.</div>;



  return (

    <div className="space-y-4">

      <div className="rounded-xl border border-border-primary bg-card p-4 noise-texture">

        <div className="flex items-center justify-between mb-3">

          <h3 className="text-sm font-semibold text-text-primary">Your MLM Network</h3>

          <span className="text-xxs text-text-tertiary">{tree.total_nodes || 0} members</span>

        </div>

        <div className="flex items-center gap-3 text-xs">

          <span className="text-text-tertiary">Your Code: <span className="text-accent font-mono font-bold">{tree.root?.referral_code}</span></span>

          <span className="text-text-tertiary">Level: <span className="text-text-primary font-bold">L{Math.max(1, (tree.root?.level || 2) - 1)}</span></span>

          <span className="text-text-tertiary">Total Earned: <span className="text-success font-mono font-bold">${fmt(tree.root?.total_earned || 0)}</span></span>

        </div>

      </div>



      {tree.tree?.length > 0 ? (

        <div className="rounded-xl border border-border-primary bg-card p-4 noise-texture">

          <h4 className="text-xs font-semibold text-text-primary mb-3">Downline Tree</h4>

          <div className="space-y-1">

            {tree.tree.map((node: any) => <TreeNode key={node.id} node={node} depth={0} />)}

          </div>

        </div>

      ) : (

        <div className="text-center py-8 text-xs text-text-tertiary">No downline members yet. Share your referral link to grow your network.</div>

      )}

    </div>

  );

}





function TreeNode({ node, depth }: { node: any; depth: number }) {

  const [expanded, setExpanded] = useState(depth < 2);

  const hasChildren = node.children?.length > 0;



  return (

    <div style={{ marginLeft: depth * 20 }}>

      <button onClick={() => hasChildren && setExpanded(!expanded)} className="flex items-center gap-2 w-full text-left py-1.5 px-2 rounded hover:bg-bg-hover/30 transition-fast text-xs">

        {hasChildren ? (

          <span className="text-text-tertiary">{expanded ? '▼' : '▶'}</span>

        ) : (

          <span className="text-text-tertiary ml-1">•</span>

        )}

        <span className="text-text-primary font-medium">{node.name || node.email}</span>

        <span className="text-xxs text-accent font-mono">L{node.depth}</span>

        <span className="text-xxs text-text-tertiary ml-auto font-mono">${fmt(node.total_earned || 0)}</span>

        {!node.is_active && <span className="text-xxs px-1 py-0.5 rounded bg-danger/15 text-danger">inactive</span>}

      </button>

      {expanded && hasChildren && node.children.map((child: any) => (

        <TreeNode key={child.id} node={child} depth={depth + 1} />

      ))}

    </div>

  );

}

