'use client';

import { useEffect, useState, useCallback } from 'react';
import { adminApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Loader2, Save, AlertTriangle, Shield, Lock, Eye, EyeOff } from 'lucide-react';
import toast from 'react-hot-toast';

interface Settings {
  default_leverage: number;
  margin_call_level: number;
  stop_out_level: number;
  max_open_trades: number;
  max_pending_orders: number;
  max_lot_size: number;
  min_lot_size: number;
  ib_min_deposit_usd: number;
  // Platform-wide minimums applied to every trader's deposit /
  // withdrawal submission. 0 = no minimum.
  min_deposit_amount_usd: number;
  min_withdrawal_amount_usd: number;
  // Auto crypto withdrawal (NOWPayments payout). Crypto withdrawals at/below
  // the max are paid out automatically; larger ones need admin approval.
  crypto_auto_withdrawal_enabled: boolean;
  crypto_auto_withdrawal_max_usd: number;
  dual_approval_threshold_usd: number;
  deposit_dual_approval_min_usd: number;
  withdrawal_dual_approval_min_usd: number;
  referral_commission_amount_usd: number;
  referral_qualifying_trades: number;
  // IB commission gates (mirror of the referral gates above).
  // Trader's KYC must be approved + at least N closed trades on file
  // before the IB engine pays out on any subsequent trade.
  ib_commission_requires_kyc: boolean;
  ib_commission_min_trades: number;
  maintenance_mode: boolean;
  allow_new_registrations: boolean;
  allow_deposits: boolean;
  allow_withdrawals: boolean;
  // Show/hide the PAMM and MAM (copy-trading) products in the trader app.
  pamm_enabled: boolean;
  mam_enabled: boolean;
  // Allow Trade Insurance on PAMM/MAM pool + managed accounts.
  pamm_mam_insurance_enabled: boolean;
  // Admin-controlled payment-method tabs in the trader wallet.
  // Crypto (NOWPayments) is always on; these two toggle the
  // remaining tabs in real time via /wallet/payment-methods.
  'wallet.manual_enabled': boolean;
  'wallet.p2p_enabled': boolean;
  // Relationship-manager email — where the "Request to RM" deposit /
  // withdraw form delivers the user's request. Must be set before
  // wallet.p2p_enabled becomes useful; gateway returns 503 otherwise.
  'wallet.rm_email': string;
  [key: string]: number | boolean | string;
}

interface SystemSettingRow {
  key: string;
  value: unknown;
}

const DEFAULT_SETTINGS: Settings = {
  default_leverage: 100,
  margin_call_level: 80,
  stop_out_level: 50,
  max_open_trades: 200,
  max_pending_orders: 100,
  max_lot_size: 100,
  min_lot_size: 0.01,
  ib_min_deposit_usd: 100,
  min_deposit_amount_usd: 50,
  min_withdrawal_amount_usd: 70,
  crypto_auto_withdrawal_enabled: false,
  crypto_auto_withdrawal_max_usd: 0,
  dual_approval_threshold_usd: 1000,
  deposit_dual_approval_min_usd: 0,
  withdrawal_dual_approval_min_usd: 0,
  referral_commission_amount_usd: 5,
  referral_qualifying_trades: 3,
  ib_commission_requires_kyc: true,
  ib_commission_min_trades: 3,
  maintenance_mode: false,
  allow_new_registrations: true,
  allow_deposits: true,
  allow_withdrawals: true,
  pamm_enabled: true,
  pamm_mam_insurance_enabled: false,
  mam_enabled: true,
  'wallet.manual_enabled': true,
  'wallet.p2p_enabled': false,
  'wallet.rm_email': '',
};

function rowsToSettings(rows: SystemSettingRow[]): Settings {
  const map: Record<string, unknown> = {};
  for (const row of rows) {
    map[row.key] = row.value;
  }
  const num = (k: keyof Settings, d: number) => {
    const v = map[k as string];
    if (v === undefined || v === null) return d;
    const n = typeof v === 'number' ? v : parseFloat(String(v));
    return Number.isFinite(n) ? n : d;
  };
  const bool = (k: keyof Settings, d: boolean) => {
    const v = map[k as string];
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return v.toLowerCase() === 'true' || v === '1';
    return d;
  };
  return {
    default_leverage: num('default_leverage', DEFAULT_SETTINGS.default_leverage),
    margin_call_level: num('margin_call_level', DEFAULT_SETTINGS.margin_call_level),
    stop_out_level: num('stop_out_level', DEFAULT_SETTINGS.stop_out_level),
    max_open_trades: num('max_open_trades', DEFAULT_SETTINGS.max_open_trades),
    max_pending_orders: num('max_pending_orders', DEFAULT_SETTINGS.max_pending_orders),
    max_lot_size: num('max_lot_size', DEFAULT_SETTINGS.max_lot_size),
    min_lot_size: num('min_lot_size', DEFAULT_SETTINGS.min_lot_size),
    ib_min_deposit_usd: num('ib_min_deposit_usd', DEFAULT_SETTINGS.ib_min_deposit_usd),
    min_deposit_amount_usd: num('min_deposit_amount_usd', DEFAULT_SETTINGS.min_deposit_amount_usd),
    min_withdrawal_amount_usd: num('min_withdrawal_amount_usd', DEFAULT_SETTINGS.min_withdrawal_amount_usd),
    crypto_auto_withdrawal_enabled: bool('crypto_auto_withdrawal_enabled', DEFAULT_SETTINGS.crypto_auto_withdrawal_enabled),
    crypto_auto_withdrawal_max_usd: num('crypto_auto_withdrawal_max_usd', DEFAULT_SETTINGS.crypto_auto_withdrawal_max_usd),
    dual_approval_threshold_usd: num('dual_approval_threshold_usd', DEFAULT_SETTINGS.dual_approval_threshold_usd),
    deposit_dual_approval_min_usd: num('deposit_dual_approval_min_usd', DEFAULT_SETTINGS.deposit_dual_approval_min_usd),
    withdrawal_dual_approval_min_usd: num('withdrawal_dual_approval_min_usd', DEFAULT_SETTINGS.withdrawal_dual_approval_min_usd),
    referral_commission_amount_usd: num(
      'referral_commission_amount_usd',
      DEFAULT_SETTINGS.referral_commission_amount_usd as number,
    ),
    referral_qualifying_trades: num(
      'referral_qualifying_trades',
      DEFAULT_SETTINGS.referral_qualifying_trades as number,
    ),
    ib_commission_requires_kyc: bool(
      'ib_commission_requires_kyc',
      DEFAULT_SETTINGS.ib_commission_requires_kyc,
    ),
    ib_commission_min_trades: num(
      'ib_commission_min_trades',
      DEFAULT_SETTINGS.ib_commission_min_trades as number,
    ),
    maintenance_mode: bool('maintenance_mode', DEFAULT_SETTINGS.maintenance_mode),
    allow_new_registrations: bool('allow_new_registrations', DEFAULT_SETTINGS.allow_new_registrations),
    allow_deposits: bool('allow_deposits', DEFAULT_SETTINGS.allow_deposits),
    allow_withdrawals: bool('allow_withdrawals', DEFAULT_SETTINGS.allow_withdrawals),
    pamm_enabled: bool('pamm_enabled', DEFAULT_SETTINGS.pamm_enabled),
    mam_enabled: bool('mam_enabled', DEFAULT_SETTINGS.mam_enabled),
    pamm_mam_insurance_enabled: bool('pamm_mam_insurance_enabled', DEFAULT_SETTINGS.pamm_mam_insurance_enabled),
    'wallet.manual_enabled': bool('wallet.manual_enabled', DEFAULT_SETTINGS['wallet.manual_enabled']),
    'wallet.p2p_enabled': bool('wallet.p2p_enabled', DEFAULT_SETTINGS['wallet.p2p_enabled']),
    'wallet.rm_email': (() => {
      const v = map['wallet.rm_email'];
      return typeof v === 'string' ? v : DEFAULT_SETTINGS['wallet.rm_email'];
    })(),
  };
}

function settingsToPayload(s: Settings): Record<string, unknown> {
  return {
    default_leverage: s.default_leverage,
    margin_call_level: s.margin_call_level,
    stop_out_level: s.stop_out_level,
    max_open_trades: s.max_open_trades,
    max_pending_orders: s.max_pending_orders,
    max_lot_size: s.max_lot_size,
    min_lot_size: s.min_lot_size,
    ib_min_deposit_usd: s.ib_min_deposit_usd,
    min_deposit_amount_usd: s.min_deposit_amount_usd,
    min_withdrawal_amount_usd: s.min_withdrawal_amount_usd,
    crypto_auto_withdrawal_enabled: s.crypto_auto_withdrawal_enabled,
    crypto_auto_withdrawal_max_usd: s.crypto_auto_withdrawal_max_usd,
    dual_approval_threshold_usd: s.dual_approval_threshold_usd,
    deposit_dual_approval_min_usd: s.deposit_dual_approval_min_usd,
    withdrawal_dual_approval_min_usd: s.withdrawal_dual_approval_min_usd,
    // Fallback flat USD bounty — used only when referral_tiers
    // (the by-active-referral-count ladder, editable at /config/referral-tiers,
    // independent of IB) has no matching tier for the referrer's position.
    referral_commission_amount_usd: s.referral_commission_amount_usd,
    referral_qualifying_trades: s.referral_qualifying_trades,
    ib_commission_requires_kyc: s.ib_commission_requires_kyc,
    ib_commission_min_trades: s.ib_commission_min_trades,
    maintenance_mode: s.maintenance_mode,
    allow_new_registrations: s.allow_new_registrations,
    allow_deposits: s.allow_deposits,
    allow_withdrawals: s.allow_withdrawals,
    pamm_enabled: s.pamm_enabled,
    pamm_mam_insurance_enabled: s.pamm_mam_insurance_enabled,
    mam_enabled: s.mam_enabled,
    'wallet.manual_enabled': s['wallet.manual_enabled'],
    'wallet.p2p_enabled': s['wallet.p2p_enabled'],
    'wallet.rm_email': s['wallet.rm_email'],
  };
}

const ROLE_PERMISSIONS = [
  { role: 'Super Admin', users: true, trades: true, deposits: true, settings: true, employees: true, business: true },
  { role: 'Admin', users: true, trades: true, deposits: true, settings: true, employees: false, business: true },
  { role: 'Manager', users: true, trades: true, deposits: true, settings: false, employees: false, business: true },
  { role: 'Support', users: true, trades: false, deposits: false, settings: false, employees: false, business: false },
];

const PERM_COLS = ['users', 'trades', 'deposits', 'settings', 'employees', 'business'] as const;

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pwNew !== pwConfirm) { toast.error('New passwords do not match'); return; }
    if (pwNew.length < 8) { toast.error('Password must be at least 8 characters'); return; }
    setPwSaving(true);
    try {
      await adminApi.post('/auth/change-password', { current_password: pwCurrent, new_password: pwNew });
      toast.success('Password changed successfully');
      setPwCurrent(''); setPwNew(''); setPwConfirm('');
    } catch (e: any) {
      toast.error(e.message || 'Failed to change password');
    } finally {
      setPwSaving(false);
    }
  };

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminApi.get<SystemSettingRow[]>('/settings');
      setSettings(rowsToSettings(Array.isArray(res) ? res : []));
    } catch (e: any) {
      toast.error(e.message || 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  const validateSettings = (s: Settings): string | null => {
    if (s.default_leverage < 1 || s.default_leverage > 5000) return 'Default leverage must be between 1 and 5000';
    if (s.margin_call_level <= 0 || s.margin_call_level > 500) return 'Margin call level must be between 1% and 500%';
    if (s.stop_out_level <= 0 || s.stop_out_level > 500) return 'Stop out level must be between 1% and 500%';
    if (s.stop_out_level >= s.margin_call_level) return 'Stop out level must be below margin call level';
    if (s.max_open_trades < 1) return 'Max open trades must be at least 1';
    if (s.max_pending_orders < 1) return 'Max pending orders must be at least 1';
    if (s.min_lot_size <= 0) return 'Min lot size must be greater than 0';
    if (s.max_lot_size <= 0) return 'Max lot size must be greater than 0';
    if (s.min_lot_size >= s.max_lot_size) return 'Min lot size must be less than max lot size';
    if (s.ib_min_deposit_usd < 0) return 'IB minimum deposit cannot be negative';
    if (s.min_deposit_amount_usd < 0) return 'Minimum deposit cannot be negative';
    if (s.min_withdrawal_amount_usd < 0) return 'Minimum withdrawal cannot be negative';
    if (s.referral_commission_amount_usd < 0) {
      return 'Referral payout cannot be negative';
    }
    if (s.referral_qualifying_trades < 1) {
      return 'Qualifying trades must be at least 1';
    }
    return null;
  };

  const handleSave = async () => {
    if (!settings) return;
    const err = validateSettings(settings);
    if (err) { toast.error(err); return; }
    setSaving(true);
    try {
      await adminApi.put('/settings', { settings: settingsToPayload(settings) });
      toast.success('Settings saved');
    } catch (e: any) {
      toast.error(e.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  // Keep raw string while typing so users can clear/retype without the value
  // snapping to 0 mid-edit (parseFloat('') is NaN → old code stored 0).
  const updateNum = (key: string, val: string) => {
    if (val === '') {
      setSettings((s) => s ? { ...s, [key]: 0 } : null);
      return;
    }
    const n = parseFloat(val);
    if (!Number.isFinite(n)) return;
    setSettings((s) => s ? { ...s, [key]: n } : null);
  };

  const updateBool = (key: string, val: boolean) => {
    setSettings((s) => s ? { ...s, [key]: val } : null);
  };

  return (
    <>
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-text-primary">System Settings</h1>
            <p className="text-xxs text-text-tertiary mt-0.5">Platform configuration and maintenance controls</p>
          </div>
          <button
            onClick={handleSave}
            disabled={saving || !settings}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-buy/15 text-buy border border-buy/30 hover:bg-buy/25 transition-fast disabled:opacity-50"
          >
            <Save size={14} />
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={20} className="animate-spin text-text-tertiary" />
          </div>
        ) : settings ? (
          <div className="space-y-4">
            {settings.maintenance_mode && (
              <div className="bg-danger/10 border border-danger/30 rounded-md p-4 flex items-center gap-3">
                <AlertTriangle size={20} className="text-danger shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-danger">Maintenance Mode Active</p>
                  <p className="text-xxs text-danger/80 mt-0.5">The platform is currently in maintenance mode. Users cannot access trading features.</p>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="bg-bg-secondary border border-border-primary rounded-md">
                <div className="px-4 py-3 border-b border-border-primary">
                  <h2 className="text-sm font-medium text-text-primary">Trading Parameters</h2>
                </div>
                <div className="p-4 space-y-3">
                  {[
                    { key: 'default_leverage', label: 'Default Leverage', suffix: ':1', step: '1' },
                    { key: 'margin_call_level', label: 'Margin Call Level', suffix: '%', step: '1' },
                    { key: 'stop_out_level', label: 'Stop Out Level', suffix: '%', step: '1' },
                    { key: 'max_open_trades', label: 'Max Open Trades', suffix: '', step: '1' },
                    { key: 'max_pending_orders', label: 'Max Pending Orders', suffix: '', step: '1' },
                    { key: 'max_lot_size', label: 'Max Lot Size', suffix: ' lots', step: '0.01' },
                    { key: 'min_lot_size', label: 'Min Lot Size', suffix: ' lots', step: '0.01' },
                  ].map((field) => (
                    <div key={field.key} className="flex items-center justify-between gap-4">
                      <label className="text-xs text-text-secondary shrink-0">{field.label}</label>
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          step={field.step}
                          min="0"
                          value={settings[field.key] as number}
                          onChange={(e) => updateNum(field.key, e.target.value)}
                          className="w-24 text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md font-mono tabular-nums text-right"
                        />
                        {field.suffix && <span className="text-xxs text-text-tertiary w-8">{field.suffix}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-bg-secondary border border-border-primary rounded-md">
                <div className="px-4 py-3 border-b border-border-primary">
                  <h2 className="text-sm font-medium text-text-primary">Platform Controls</h2>
                </div>
                <div className="p-4 space-y-3">
                  {[
                    { key: 'maintenance_mode', label: 'Maintenance Mode', desc: 'Disables all trading and user access', danger: true },
                    { key: 'allow_new_registrations', label: 'Allow New Registrations', desc: 'Enable or disable new user sign-ups' },
                    { key: 'allow_deposits', label: 'Allow Deposits', desc: 'Enable or disable deposit functionality' },
                    { key: 'allow_withdrawals', label: 'Allow Withdrawals', desc: 'Enable or disable withdrawal requests' },
                    { key: 'pamm_enabled', label: 'Show PAMM to customers', desc: 'Off = hide the PAMM product from the trader app' },
                    { key: 'mam_enabled', label: 'Show MAM / Copy Trading to customers', desc: 'Off = hide MAM / copy-trading from the trader app' },
                    { key: 'pamm_mam_insurance_enabled', label: 'Trade Insurance on PAMM / MAM accounts', desc: 'Off = PAMM/MAM pool + managed accounts cannot buy Trade Insurance' },
                    // Per-method tabs in the trader wallet. Crypto (NOWPayments)
                    // is always on; these two toggle the Manual + P2P tabs in
                    // real time. Gateway also hard-rejects API calls on the
                    // disabled rails so the gate is enforced server-side.
                    { key: 'wallet.manual_enabled', label: 'Manual (Bank/UPI) Deposits + Withdrawals', desc: 'Show the Manual deposit tab and Bank withdrawal tab in the trader wallet' },
                    { key: 'wallet.p2p_enabled', label: 'Request to RM (Manual Mail Flow)', desc: 'Show the "Request to RM" tab in deposit + withdraw — user form submits via email to the relationship manager. Set the RM email below before enabling.' },
                  ].map((toggle) => (
                    <div key={toggle.key} className={cn('flex items-center justify-between gap-4 p-3 rounded-md border', toggle.danger && settings[toggle.key] ? 'border-danger/30 bg-danger/5' : 'border-border-primary')}>
                      <div>
                        <p className={cn('text-xs font-medium', toggle.danger && settings[toggle.key] ? 'text-danger' : 'text-text-primary')}>{toggle.label}</p>
                        <p className="text-xxs text-text-tertiary mt-0.5">{toggle.desc}</p>
                      </div>
                      <button
                        onClick={() => updateBool(toggle.key, !settings[toggle.key])}
                        className={cn(
                          'relative w-9 h-5 rounded-full transition-fast shrink-0',
                          settings[toggle.key] ? (toggle.danger ? 'bg-danger' : 'bg-success') : 'bg-bg-tertiary border border-border-primary',
                        )}
                      >
                        <span className={cn('absolute top-0.5 w-4 h-4 rounded-full bg-white transition-fast shadow-sm', settings[toggle.key] ? 'left-[18px]' : 'left-0.5')} />
                      </button>
                    </div>
                  ))}

                  {/* RM email — destination address for the "Request to RM"
                      deposit/withdraw form. Gateway returns 503 to the
                      trader if this is blank, so admins are nudged to
                      set it before flipping the toggle above. */}
                  <div className="p-3 rounded-md border border-border-primary">
                    <label className="text-xs font-medium text-text-primary block">
                      Relationship Manager email
                    </label>
                    <p className="text-xxs text-text-tertiary mt-0.5 mb-2">
                      Where the "Request to RM" form emails the user's name,
                      amount, and phone. Required when the toggle above is on.
                    </p>
                    <input
                      type="email"
                      value={typeof settings['wallet.rm_email'] === 'string' ? (settings['wallet.rm_email'] as string) : ''}
                      onChange={(e) => setSettings((s) => s ? { ...s, 'wallet.rm_email': e.target.value } : null)}
                      placeholder="rm@yourbroker.com"
                      className="w-full text-xs py-2 px-3 bg-bg-input border border-border-primary rounded-md outline-none focus:border-accent/50"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-bg-secondary border border-border-primary rounded-md">
              <div className="px-4 py-3 border-b border-border-primary">
                <h2 className="text-sm font-medium text-text-primary">Wallet Limits</h2>
                <p className="text-xxs text-text-tertiary mt-0.5">
                  Platform-wide minimum amounts every trader sees on the deposit /
                  withdrawal form. Set 0 to disable a minimum.
                </p>
              </div>
              <div className="p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <label className="text-xs text-text-secondary block">Minimum Deposit</label>
                    <p className="text-xxs text-text-tertiary mt-0.5">Any deposit below this amount is rejected before it reaches the bank/crypto picker.</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-xxs text-text-tertiary">$</span>
                    <input
                      type="number"
                      step="1"
                      min="0"
                      value={settings.min_deposit_amount_usd}
                      onChange={(e) => updateNum('min_deposit_amount_usd', e.target.value)}
                      className="w-28 text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md font-mono tabular-nums text-right"
                    />
                    <span className="text-xxs text-text-tertiary w-8">USD</span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <label className="text-xs text-text-secondary block">Minimum Withdrawal</label>
                    <p className="text-xxs text-text-tertiary mt-0.5">Any withdrawal request below this amount is rejected with a clear message.</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-xxs text-text-tertiary">$</span>
                    <input
                      type="number"
                      step="1"
                      min="0"
                      value={settings.min_withdrawal_amount_usd}
                      onChange={(e) => updateNum('min_withdrawal_amount_usd', e.target.value)}
                      className="w-28 text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md font-mono tabular-nums text-right"
                    />
                    <span className="text-xxs text-text-tertiary w-8">USD</span>
                  </div>
                </div>

                {/* Auto crypto withdrawal (NOWPayments payout) */}
                <div className="flex items-center justify-between gap-4 p-3 rounded-md border border-border-primary">
                  <div>
                    <p className="text-xs font-medium text-text-primary">Auto Crypto Withdrawal (NOWPayments)</p>
                    <p className="text-xxs text-text-tertiary mt-0.5">Send crypto withdrawals automatically via NOWPayments. Needs NOWPayments payout credentials + whitelisting/2FA disabled on their dashboard.</p>
                  </div>
                  <button
                    onClick={() => updateBool('crypto_auto_withdrawal_enabled', !settings.crypto_auto_withdrawal_enabled)}
                    className={cn('relative w-9 h-5 rounded-full transition-fast shrink-0', settings.crypto_auto_withdrawal_enabled ? 'bg-success' : 'bg-bg-tertiary border border-border-primary')}
                  >
                    <span className={cn('absolute top-0.5 w-4 h-4 rounded-full bg-white transition-fast shadow-sm', settings.crypto_auto_withdrawal_enabled ? 'left-[18px]' : 'left-0.5')} />
                  </button>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <label className="text-xs text-text-secondary block">Auto-Withdrawal Max (USD)</label>
                    <p className="text-xxs text-text-tertiary mt-0.5">Crypto withdrawals at or below this amount are paid out automatically; larger ones need admin approval. 0 = nothing auto.</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-xxs text-text-tertiary">$</span>
                    <input
                      type="number"
                      step="1"
                      min="0"
                      value={settings.crypto_auto_withdrawal_max_usd}
                      onChange={(e) => updateNum('crypto_auto_withdrawal_max_usd', e.target.value)}
                      className="w-28 text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md font-mono tabular-nums text-right"
                    />
                    <span className="text-xxs text-text-tertiary w-8">USD</span>
                  </div>
                </div>

                {/* Dual-approval threshold (client 2026-06-23: make the $1000
                    second-sign-off limit editable). */}
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <label className="text-xs text-text-secondary block">Dual-Approval Threshold</label>
                    <p className="text-xxs text-text-tertiary mt-0.5">Admin fund add/deduct at or above this amount needs a second admin sign-off. (A repeat fund-add to the same user within 24h always needs approval, regardless of this limit.)</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-xxs text-text-tertiary">$</span>
                    <input
                      type="number"
                      step="1"
                      min="0"
                      value={settings.dual_approval_threshold_usd}
                      onChange={(e) => updateNum('dual_approval_threshold_usd', e.target.value)}
                      className="w-28 text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md font-mono tabular-nums text-right"
                    />
                    <span className="text-xxs text-text-tertiary w-8">USD</span>
                  </div>
                </div>

                {/* Deposit dual-approval limit (client 2026-07-08): user
                    deposits at/above this need a second super-admin sign-off. */}
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <label className="text-xs text-text-secondary block">Deposit Dual-Approval Limit</label>
                    <p className="text-xxs text-text-tertiary mt-0.5">A user deposit at or above this amount needs a second super-admin sign-off in Approvals before it's credited. 0 = off (no limit).</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-xxs text-text-tertiary">$</span>
                    <input
                      type="number"
                      step="1"
                      min="0"
                      value={settings.deposit_dual_approval_min_usd}
                      onChange={(e) => updateNum('deposit_dual_approval_min_usd', e.target.value)}
                      className="w-28 text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md font-mono tabular-nums text-right"
                    />
                    <span className="text-xxs text-text-tertiary w-8">USD</span>
                  </div>
                </div>

                {/* Withdrawal dual-approval limit. */}
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <label className="text-xs text-text-secondary block">Withdrawal Dual-Approval Limit</label>
                    <p className="text-xxs text-text-tertiary mt-0.5">A user withdrawal at or above this amount needs a second super-admin sign-off in Approvals before it's paid out. 0 = off (no limit).</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-xxs text-text-tertiary">$</span>
                    <input
                      type="number"
                      step="1"
                      min="0"
                      value={settings.withdrawal_dual_approval_min_usd}
                      onChange={(e) => updateNum('withdrawal_dual_approval_min_usd', e.target.value)}
                      className="w-28 text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md font-mono tabular-nums text-right"
                    />
                    <span className="text-xxs text-text-tertiary w-8">USD</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-bg-secondary border border-border-primary rounded-md">
              <div className="px-4 py-3 border-b border-border-primary">
                <h2 className="text-sm font-medium text-text-primary">Business / IB Program</h2>
                <p className="text-xxs text-text-tertiary mt-0.5">Eligibility gate for users applying to become an Introducing Broker.</p>
              </div>
              <div className="p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <label className="text-xs text-text-secondary block">Minimum Deposit for IB Application</label>
                    <p className="text-xxs text-text-tertiary mt-0.5">Lifetime approved deposits required before a user can apply for IB or sub-broker.</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-xxs text-text-tertiary">$</span>
                    <input
                      type="number"
                      step="1"
                      min="0"
                      value={settings.ib_min_deposit_usd}
                      onChange={(e) => updateNum('ib_min_deposit_usd', e.target.value)}
                      className="w-28 text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md font-mono tabular-nums text-right"
                    />
                    <span className="text-xxs text-text-tertiary w-8">USD</span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-4 pt-3 border-t border-border-primary/60">
                  <div className="min-w-0 flex-1">
                    <label className="text-xs text-text-secondary block">Require KYC on the trader</label>
                    <p className="text-xxs text-text-tertiary mt-0.5">If on, the IB chain only earns commission on trades placed by a KYC-approved trader.</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => updateBool('ib_commission_requires_kyc', !settings.ib_commission_requires_kyc)}
                    className={cn(
                      'inline-flex h-6 w-11 items-center rounded-full transition-fast shrink-0',
                      settings.ib_commission_requires_kyc ? 'bg-success' : 'bg-bg-tertiary',
                    )}
                    aria-pressed={settings.ib_commission_requires_kyc}
                  >
                    <span
                      className={cn(
                        'inline-block h-5 w-5 transform rounded-full bg-white transition-fast',
                        settings.ib_commission_requires_kyc ? 'translate-x-5' : 'translate-x-1',
                      )}
                    />
                  </button>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <label className="text-xs text-text-secondary block">Minimum closed trades</label>
                    <p className="text-xxs text-text-tertiary mt-0.5">IB commission only pays after the referred trader has closed at least this many trades. 0 disables the gate.</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <input
                      type="number"
                      step="1"
                      min="0"
                      value={settings.ib_commission_min_trades}
                      onChange={(e) => updateNum('ib_commission_min_trades', e.target.value)}
                      className="w-24 text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md font-mono tabular-nums text-right"
                    />
                    <span className="text-xxs text-text-tertiary">trades</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-bg-secondary border border-border-primary rounded-md">
              <div className="px-4 py-3 border-b border-border-primary">
                <h2 className="text-sm font-medium text-text-primary">User Referral Program</h2>
                <p className="text-xxs text-text-tertiary mt-0.5">
                  Flat payout the referrer earns once their referred user qualifies.
                  Separate from the IB MLM program.
                </p>
              </div>
              <div className="p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <label className="text-xs text-text-secondary block">Fallback payout (any account type)</label>
                    <p className="text-xxs text-text-tertiary mt-0.5">
                      Used only when the referred user&apos;s account type isn&apos;t in the
                      per-type table below.
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-xxs text-text-tertiary">$</span>
                    <input
                      type="number"
                      step="0.5"
                      min="0"
                      value={settings.referral_commission_amount_usd as number}
                      onChange={(e) => updateNum('referral_commission_amount_usd', e.target.value)}
                      className="w-24 text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md font-mono tabular-nums text-right"
                    />
                    <span className="text-xxs text-text-tertiary w-8">USD</span>
                  </div>
                </div>

                <div className="rounded-md border border-border-primary/60 p-3 space-y-1">
                  <div className="text-xs text-text-secondary font-medium">Per-referral ladder (by referrer's active count)</div>
                  <p className="text-xxs text-text-tertiary">
                    Bounty scales with the <span className="text-text-secondary">referrer's</span> number of qualified referrals
                    (e.g. 1–20 → $5, 21–100 → $7, 101+ → $10) — NOT by the referred user's account type.
                    This ladder is <span className="text-text-secondary">independent of IB</span>: edit it on its own
                    Referral Tiers page (the IB per-lot ladder lives separately under Config → IB Tiers).
                  </p>
                  <a
                    href="/config/referral-tiers"
                    className="inline-flex items-center gap-1.5 mt-1 text-xs text-buy hover:text-buy-light underline underline-offset-2"
                  >
                    Open referral tier editor →
                  </a>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <label className="text-xs text-text-secondary block">Qualifying trades</label>
                    <p className="text-xxs text-text-tertiary mt-0.5">
                      Number of CLOSED trades the referred user must make before the payout fires.
                      Open positions don&apos;t count.
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <input
                      type="number"
                      step="1"
                      min="1"
                      value={settings.referral_qualifying_trades as number}
                      onChange={(e) => updateNum('referral_qualifying_trades', e.target.value)}
                      className="w-24 text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md font-mono tabular-nums text-right"
                    />
                    <span className="text-xxs text-text-tertiary w-8">trades</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-bg-secondary border border-border-primary rounded-md">
              <div className="px-4 py-3 border-b border-border-primary flex items-center gap-2">
                <Shield size={14} className="text-text-tertiary" />
                <h2 className="text-sm font-medium text-text-primary">Role Permissions</h2>
                <span className="text-xxs text-text-tertiary ml-auto">Read-only</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[600px]">
                  <thead>
                    <tr className="border-b border-border-primary bg-bg-tertiary/40">
                      <th className="text-left px-4 py-2.5 text-xxs font-medium text-text-tertiary uppercase tracking-wide">Role</th>
                      {PERM_COLS.map((col) => (
                        <th key={col} className="text-center px-4 py-2.5 text-xxs font-medium text-text-tertiary uppercase tracking-wide">{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ROLE_PERMISSIONS.map((row) => (
                      <tr key={row.role} className="border-b border-border-primary/50">
                        <td className="px-4 py-2.5 text-xs text-text-primary font-medium">{row.role}</td>
                        {PERM_COLS.map((col) => (
                          <td key={col} className="px-4 py-2.5 text-center">
                            <span className={cn('inline-flex w-5 h-5 items-center justify-center rounded-full text-xxs font-bold', row[col] ? 'bg-success/15 text-success' : 'bg-bg-tertiary text-text-tertiary')}>
                              {row[col] ? '✓' : '—'}
                            </span>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="bg-bg-secondary border border-border-primary rounded-md">
              <div className="px-4 py-3 border-b border-border-primary flex items-center gap-2">
                <Lock size={14} className="text-text-tertiary" />
                <h2 className="text-sm font-medium text-text-primary">Change Password</h2>
              </div>
              <form onSubmit={handleChangePassword} className="p-4">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {[
                    { label: 'Current Password', value: pwCurrent, set: setPwCurrent, show: showCurrent, toggle: () => setShowCurrent(v => !v) },
                    { label: 'New Password', value: pwNew, set: setPwNew, show: showNew, toggle: () => setShowNew(v => !v) },
                    { label: 'Confirm New Password', value: pwConfirm, set: setPwConfirm, show: showConfirm, toggle: () => setShowConfirm(v => !v) },
                  ].map((field) => (
                    <div key={field.label} className="space-y-1">
                      <label className="text-xs text-text-secondary">{field.label}</label>
                      <div className="relative">
                        <input
                          type={field.show ? 'text' : 'password'}
                          value={field.value}
                          onChange={(e) => field.set(e.target.value)}
                          required
                          placeholder="••••••••"
                          className="w-full pl-3 pr-8 py-2 text-xs bg-bg-input border border-border-primary rounded-md focus:border-buy transition-fast"
                        />
                        <button
                          type="button"
                          onClick={field.toggle}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary transition-fast"
                        >
                          {field.show ? <EyeOff size={13} /> : <Eye size={13} />}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-4 flex justify-end">
                  <button
                    type="submit"
                    disabled={pwSaving || !pwCurrent || !pwNew || !pwConfirm}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-buy/15 text-buy border border-buy/30 hover:bg-buy/25 transition-fast disabled:opacity-50"
                  >
                    {pwSaving ? <Loader2 size={13} className="animate-spin" /> : <Lock size={13} />}
                    {pwSaving ? 'Updating...' : 'Update Password'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}
