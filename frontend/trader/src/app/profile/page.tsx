'use client';

import { useState, useEffect, useCallback } from 'react';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import { User, Shield, Bell, Monitor, Sun, Moon, Palette, Copy } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useUIStore } from '@/stores/uiStore';
import { useTradingStore } from '@/stores/tradingStore';
import { Button } from '@/components/ui/Button';
import DashboardShell from '@/components/layout/DashboardShell';
import LinkedWalletCard from '@/components/profile/LinkedWalletCard';
import DOBPicker from '@/components/forms/DOBPicker';
import api from '@/lib/api/client';

interface Profile {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  phone: string;
  country: string;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  date_of_birth?: string | null;
  kyc_status: string;
  two_factor_enabled: boolean;
  /** Registration date — shown as "Member since" (B2-6). */
  created_at?: string;
}

interface Session {
  id: string;
  ip_address: string;
  user_agent: string;
  device_info: string;
  created_at: string;
}

type TabId = 'profile' | 'security' | 'notifications' | 'sessions' | 'theme';

const TABS: { id: TabId; label: string; icon: React.ElementType }[] = [
  { id: 'profile',       label: 'Profile',       icon: User },
  { id: 'security',      label: 'Security',       icon: Shield },
  { id: 'notifications', label: 'Notifications',  icon: Bell },
  { id: 'sessions',      label: 'Sessions',       icon: Monitor },
  { id: 'theme',         label: 'Theme',          icon: Palette },
];

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(n || 0);
}

export default function ProfilePage() {
  const [tab, setTab] = useState<TabId>('profile');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Profile form
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [country, setCountry] = useState('');
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [postal, setPostal] = useState('');
  const [dob, setDob] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);

  // Password form
  const [currentPass, setCurrentPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);

  // Sessions
  const [terminatingSession, setTerminatingSession] = useState<string | null>(null);

  // 2FA setup
  const [showTwoFaSetup, setShowTwoFaSetup] = useState(false);
  const [twoFaUri, setTwoFaUri] = useState('');
  const [twoFaSecret, setTwoFaSecret] = useState('');
  const [twoFaBackupCodes, setTwoFaBackupCodes] = useState<string[]>([]);
  const [twoFaCode, setTwoFaCode] = useState('');
  const [settingUp2Fa, setSettingUp2Fa] = useState(false);
  const [verifying2Fa, setVerifying2Fa] = useState(false);

  // Notification preferences
  const [notifPrefs, setNotifPrefs] = useState<Record<string, boolean>>(() => {
    if (typeof window === 'undefined') return {};
    try { return JSON.parse(localStorage.getItem('notifPrefs') || '{}'); }
    catch { return {}; }
  });

  const toggleNotifPref = (key: string) => {
    setNotifPrefs((prev) => {
      const updated = { ...prev, [key]: !prev[key] };
      localStorage.setItem('notifPrefs', JSON.stringify(updated));
      return updated;
    });
  };

  const handleSetup2Fa = async () => {
    try {
      setSettingUp2Fa(true);
      const res = await api.post<{ qr_uri: string; secret: string; backup_codes: string[] }>('/auth/2fa/setup');
      setTwoFaUri(res.qr_uri || '');
      setTwoFaSecret(res.secret || '');
      setTwoFaBackupCodes(Array.isArray(res.backup_codes) ? res.backup_codes : []);
      setShowTwoFaSetup(true);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to initiate 2FA setup');
    } finally { setSettingUp2Fa(false); }
  };

  const handleVerify2Fa = async () => {
    if (!twoFaCode.trim()) { toast.error('Please enter the verification code'); return; }
    try {
      setVerifying2Fa(true);
      await api.post('/auth/2fa/verify', { code: twoFaCode });
      toast.success('2FA enabled successfully!');
      setShowTwoFaSetup(false);
      setTwoFaCode(''); setTwoFaUri(''); setTwoFaSecret(''); setTwoFaBackupCodes([]);
      fetchProfile();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Invalid verification code');
    } finally { setVerifying2Fa(false); }
  };

  const handleDisable2Fa = async () => {
    try {
      setSettingUp2Fa(true);
      await api.delete('/auth/2fa');
      toast.success('2FA disabled');
      fetchProfile();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to disable 2FA');
    } finally { setSettingUp2Fa(false); }
  };

  const fetchProfile = useCallback(async () => {
    try {
      setLoading(true); setError(null);
      const data = await api.get<Profile>('/profile');
      setProfile(data);
      setFirstName(data.first_name ?? '');
      setLastName(data.last_name ?? '');
      setPhone(data.phone ?? '');
      setCountry(data.country ?? '');
      setAddress((data.address ?? '').trim());
      setCity((data.city ?? '').trim());
      setState((data.state ?? '').trim());
      setPostal((data.postal_code ?? '').trim());
      setDob((data.date_of_birth ?? '').slice(0, 10));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load profile');
    } finally { setLoading(false); }
  }, []);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await api.get<{ sessions: Session[] }>('/profile/sessions');
      setSessions(res.sessions ?? []);
    } catch { /* non-critical */ }
  }, []);

  useEffect(() => { fetchProfile(); }, [fetchProfile]);
  useEffect(() => { if (tab === 'sessions') fetchSessions(); }, [tab, fetchSessions]);

  const handleSaveProfile = async () => {
    try {
      setSavingProfile(true);
      await api.put('/profile', {
        first_name: firstName, last_name: lastName,
        phone, country, address, city, state, postal_code: postal,
        date_of_birth: dob || null,
      });
      toast.success('Profile updated successfully!');
      fetchProfile();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to update profile');
    } finally { setSavingProfile(false); }
  };

  const handleChangePassword = async () => {
    if (!currentPass || !newPass) { toast.error('Please fill in all password fields'); return; }
    if (newPass !== confirmPass) { toast.error('New passwords do not match'); return; }
    try {
      setChangingPassword(true);
      await api.put('/profile/password', { current_password: currentPass, new_password: newPass });
      toast.success('Password changed successfully!');
      setCurrentPass(''); setNewPass(''); setConfirmPass('');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to change password');
    } finally { setChangingPassword(false); }
  };

  const handleTerminateSession = async (sessionId: string) => {
    try {
      setTerminatingSession(sessionId);
      await api.delete(`/profile/sessions/${sessionId}`);
      toast.success('Session terminated');
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to terminate session');
    } finally { setTerminatingSession(null); }
  };

  const { theme, setTheme } = useUIStore();

  // Demo accounts are practice / virtual-funds — the active session may
  // belong to a real user, but we anonymise the profile surface so the
  // trader can demo without their KYC name being on display. Profile
  // edits are still allowed (they save against the underlying user
  // record), but the avatar / display name show "Demo Account" while
  // the active account is a demo.
  const isDemo = !!useTradingStore((s) => s.activeAccount?.is_demo);
  const displayFirst = isDemo ? 'Demo' : (profile?.first_name ?? '');
  const displayLast = isDemo ? 'Account' : (profile?.last_name ?? '');
  const displayEmail = isDemo ? 'demo@swisdex.com' : (profile?.email ?? '');
  const initials = isDemo
    ? 'DA'
    : (`${(profile?.first_name?.[0] ?? '').toUpperCase()}${(profile?.last_name?.[0] ?? '').toUpperCase()}` || 'U');
  const username = isDemo ? 'demo' : (profile?.email ? profile.email.split('@')[0] : '');
  // Identity is editable until KYC is approved, then locked (client 2026-06-23).
  const kycLocked = !isDemo && (profile?.kyc_status === 'approved' || profile?.kyc_status === 'verified');

  const inputCls =
    'w-full bg-bg-secondary border border-border-primary rounded-xl py-3 px-4 text-sm text-text-primary focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 transition-colors placeholder:text-text-tertiary disabled:opacity-50 disabled:cursor-not-allowed';
  const labelCls = 'text-xs text-text-secondary block mb-1.5 font-medium';

  const tabIndex = TABS.findIndex((t) => t.id === tab);
  const slideIndex = tabIndex >= 0 ? tabIndex : 0;

  return (
    <DashboardShell mainClassName="p-0 flex flex-col min-h-0 overflow-hidden">
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        <div className="w-full max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-4 sm:py-6 pb-24 space-y-5">
          <section className="relative overflow-hidden rounded-xl border border-border-primary bg-card">
            <div
              className="pointer-events-none absolute inset-0 bg-gradient-to-br from-accent/[0.12] via-transparent to-accent/[0.05]"
              aria-hidden
            />
            <div className="relative z-10 px-4 sm:px-6 py-5 sm:py-7">
              <h1 className="text-xl sm:text-2xl font-bold text-text-primary tracking-tight">Settings</h1>
              <p className="text-sm text-text-secondary mt-1 max-w-2xl">
                Profile, security, notifications, and active sessions — aligned with SwisDex.
              </p>
            </div>
          </section>

        {loading && (
          <div className="rounded-xl border border-border-primary bg-card flex flex-col items-center gap-3 py-20">
            <div className="h-8 w-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-text-secondary">Loading settings…</span>
          </div>
        )}
        {!loading && error && (
          <div className="rounded-xl border border-border-primary bg-card text-center space-y-3 py-12 px-4">
            <p className="text-sell text-sm">{error}</p>
            <Button variant="outline" size="sm" onClick={fetchProfile}>
              Retry
            </Button>
          </div>
        )}

        {!loading && !error && (
          <div className="overflow-hidden rounded-xl border border-border-primary bg-card">
            <div className="relative flex min-h-[52px] border-b border-border-primary bg-card">
              <div className="pointer-events-none absolute inset-0 z-0" aria-hidden>
                <div
                  className="absolute top-0 h-full w-1/5 transition-[transform] duration-500 ease-[cubic-bezier(0.34,1.45,0.64,1)] will-change-transform"
                  style={{ transform: `translate3d(${slideIndex * 100}%,0,0)` }}
                >
                  <div
                    className={clsx(
                      'absolute inset-x-1 top-0 h-full rounded-t-2xl border-2 border-b-0 border-accent bg-card-nested',
                      'animate-wallet-main-tab-glow',
                    )}
                  />
                </div>
              </div>
              {TABS.map((t) => {
                const active = tab === t.id;
                const Icon = t.icon;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setTab(t.id)}
                    className={clsx(
                      'relative z-10 flex-1 min-w-0 border-0 bg-transparent py-3.5 px-1 sm:px-2 text-[11px] sm:text-xs font-semibold outline-none inline-flex items-center justify-center gap-1.5',
                      'transition-colors duration-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/50',
                      active ? 'text-accent' : 'text-text-secondary hover:text-text-primary',
                    )}
                  >
                    <Icon size={14} className="shrink-0 opacity-90" />
                    {active ? (
                      <span className="relative inline-block animate-wallet-main-tab-text drop-shadow-[0_0_16px_rgba(85,166,48,0.6)] truncate">
                        {t.label}
                      </span>
                    ) : (
                      <span className="truncate">{t.label}</span>
                    )}
                  </button>
                );
              })}
            </div>

            <div key={tab} className="bg-card-nested p-4 md:p-6 animate-wallet-fund-enter-lg min-h-[200px]">
        {/* ── Profile tab ── */}
        {tab === 'profile' && (
          <div className="max-w-2xl mx-auto space-y-5">
            <div className="rounded-xl border border-border-primary bg-card p-5 sm:p-6 noise-texture">
              <h2 className="text-sm font-semibold text-text-primary mb-5">Profile Information</h2>

              {/* Avatar row */}
              <div className="flex items-center gap-4 mb-6">
                <div className="relative">
                  <div className="w-16 h-16 rounded-full bg-accent/15 border border-accent/30 flex items-center justify-center text-xl font-bold text-accent">
                    {initials}
                  </div>
                </div>
                <div>
                  <p className="text-sm font-semibold text-text-primary">{displayFirst} {displayLast}</p>
                  <p className="text-xs text-text-tertiary">{displayEmail}</p>
                  <p className={clsx('text-[10px] mt-0.5', isDemo ? 'text-text-secondary' : (profile?.kyc_status === 'verified' ? 'text-accent' : 'text-warning'))}>
                    {isDemo
                      ? 'Practice mode — virtual funds'
                      : (profile?.kyc_status === 'verified' ? 'Verified Account' : `KYC: ${profile?.kyc_status ?? 'not started'}`)}
                  </p>
                </div>
              </div>

              {isDemo ? (
                <div className="rounded-lg border border-accent/30 bg-accent/[0.06] px-4 py-4 text-sm text-text-secondary leading-relaxed">
                  <p className="font-semibold text-text-primary mb-1">Practice mode</p>
                  <p>
                    Personal details are hidden while you're trading on a demo account.
                    Switch to your live account to view or edit profile, KYC, and contact info.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Username (read-only) */}
                  <div>
                    <label className={labelCls}>Username</label>
                    <input
                      type="text"
                      value={`@${username}`}
                      disabled
                      className={`${inputCls} opacity-50 cursor-not-allowed`}
                    />
                  </div>

                  {kycLocked && (
                    <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-[11px] text-amber-600">
                      Your profile is locked after KYC approval. Contact support to change verified details.
                    </div>
                  )}

                  {/* Name row */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className={labelCls}>First Name</label>
                      <input type="text" value={firstName} onChange={(e) => setFirstName(e.target.value)} disabled={kycLocked} className={inputCls} />
                    </div>
                    <div>
                      <label className={labelCls}>Last Name</label>
                      <input type="text" value={lastName} onChange={(e) => setLastName(e.target.value)} disabled={kycLocked} className={inputCls} />
                    </div>
                  </div>

                  {/* Date of Birth — editable until KYC approval (client 2026-06-23).
                      Custom DOBPicker (not native <input type=date>) so the
                      calendar starts each month at the 1st with no trailing
                      prev/next-month days (client 2026-06-24). */}
                  <div>
                    <label className={labelCls}>Date of Birth</label>
                    <DOBPicker value={dob} onChange={setDob} disabled={kycLocked} />
                  </div>

                  {/* Email + Phone */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className={labelCls}>Email</label>
                      <input
                        type="email"
                        defaultValue={profile?.email ?? ''}
                        disabled
                        className={`${inputCls} opacity-50 cursor-not-allowed`}
                      />
                    </div>
                    <div>
                      <label className={labelCls}>Phone Number</label>
                      <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={kycLocked} className={inputCls} />
                    </div>
                  </div>

                  {/* Street address */}
                  <div>
                    <label className={labelCls}>Street Address</label>
                    <input type="text" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="House number, street" disabled={kycLocked} className={inputCls} />
                  </div>

                  {/* City + State */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className={labelCls}>City</label>
                      <input type="text" value={city} onChange={(e) => setCity(e.target.value)} disabled={kycLocked} className={inputCls} />
                    </div>
                    <div>
                      <label className={labelCls}>State / Province</label>
                      <input type="text" value={state} onChange={(e) => setState(e.target.value)} disabled={kycLocked} className={inputCls} />
                    </div>
                  </div>

                  {/* Postal + Country */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className={labelCls}>Postal / Zip Code</label>
                      <input type="text" value={postal} onChange={(e) => setPostal(e.target.value)} disabled={kycLocked} className={inputCls} placeholder="" />
                    </div>
                    <div>
                      <label className={labelCls}>Country</label>
                      <input type="text" value={country} onChange={(e) => setCountry(e.target.value)} disabled={kycLocked} className={inputCls} placeholder="e.g. India" />
                    </div>
                  </div>

                  {/* Registration date — read-only (client 2026-06-19: user
                      should see when they joined). Per-account creation dates
                      live on the Accounts page. */}
                  {profile?.created_at && (
                    <div>
                      <label className={labelCls}>Member since</label>
                      <input
                        type="text"
                        value={new Date(profile.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}
                        disabled
                        className={`${inputCls} opacity-60 cursor-not-allowed`}
                      />
                    </div>
                  )}

                  {!kycLocked && (
                    <div className="flex justify-end pt-1">
                      <Button variant="primary" onClick={handleSaveProfile} loading={savingProfile}>
                        Save Changes
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>

          </div>
        )}

        {/* ── Security tab ── */}
        {tab === 'security' && (
          <div className="max-w-lg mx-auto space-y-6">
            <div className="rounded-xl border border-border-primary bg-card p-5 sm:p-6 noise-texture">
              <h3 className="text-base font-semibold text-text-primary mb-4">Change Password</h3>
              <div className="space-y-3">
                <div>
                  <label className={labelCls}>Current Password</label>
                  <input type="password" value={currentPass} onChange={(e) => setCurrentPass(e.target.value)} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>New Password</label>
                  <input type="password" value={newPass} onChange={(e) => setNewPass(e.target.value)} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Confirm New Password</label>
                  <input type="password" value={confirmPass} onChange={(e) => setConfirmPass(e.target.value)} className={inputCls} />
                </div>
                <Button variant="primary" onClick={handleChangePassword} loading={changingPassword}>
                  Update Password
                </Button>
              </div>
            </div>

            <div className="rounded-xl border border-border-primary bg-card p-5 sm:p-6 noise-texture">
              <h3 className="text-base font-semibold text-text-primary mb-1">Two-Factor Authentication</h3>
              <p className="text-sm text-text-secondary mb-4">Add an extra layer of security to your account.</p>

              {showTwoFaSetup ? (
                <div className="space-y-4">
                  <div className="bg-bg-secondary border border-border-primary rounded-xl p-4 flex flex-col items-center gap-3">
                    <p className="text-xs text-text-secondary text-center">Scan this QR code with your authenticator app (Google Authenticator, Authy, 1Password, etc.):</p>
                    {twoFaUri ? (
                      <div className="bg-white p-3 rounded-lg">
                        <QRCodeSVG value={twoFaUri} size={180} includeMargin={false} level="M" />
                      </div>
                    ) : (
                      <div className="text-xs text-amber-400">QR data missing — try Cancel and Enable again.</div>
                    )}
                    {twoFaSecret && (
                      <div className="w-full">
                        <p className="text-[11px] text-text-tertiary mb-1 text-center">Or enter this secret manually:</p>
                        <div className="flex items-center gap-2">
                          <code className="flex-1 font-mono text-xs text-text-primary bg-card rounded-md px-3 py-2 border border-border-primary select-all break-all">
                            {twoFaSecret}
                          </code>
                          <button
                            type="button"
                            onClick={() => { navigator.clipboard.writeText(twoFaSecret); toast.success('Secret copied'); }}
                            className="p-2 text-text-tertiary hover:text-text-primary border border-border-primary rounded-md"
                            aria-label="Copy secret"
                          >
                            <Copy size={14} />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {twoFaBackupCodes.length > 0 && (
                    <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-4">
                      <p className="text-xs font-semibold text-amber-400 mb-1">Save your backup codes</p>
                      <p className="text-[11px] text-text-secondary mb-3">
                        Each code can be used <strong>once</strong> if you lose access to your authenticator app.
                        Store them in your password manager — they will not be shown again.
                      </p>
                      <div className="grid grid-cols-2 gap-2 font-mono text-xs text-text-primary">
                        {twoFaBackupCodes.map((c) => (
                          <code key={c} className="bg-card rounded-md px-2 py-1.5 border border-border-primary select-all text-center">
                            {c}
                          </code>
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={() => { navigator.clipboard.writeText(twoFaBackupCodes.join('\n')); toast.success('Backup codes copied'); }}
                        className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-text-secondary hover:text-text-primary"
                      >
                        <Copy size={11} /> Copy all
                      </button>
                    </div>
                  )}

                  <div>
                    <label className={labelCls}>Verification Code</label>
                    <input type="text" inputMode="numeric" autoComplete="one-time-code" value={twoFaCode} onChange={(e) => setTwoFaCode(e.target.value.replace(/\D/g, ''))} placeholder="Enter 6-digit code" maxLength={6} className={inputCls} />
                  </div>
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" onClick={() => { setShowTwoFaSetup(false); setTwoFaCode(''); setTwoFaUri(''); setTwoFaSecret(''); setTwoFaBackupCodes([]); }}>Cancel</Button>
                    <Button variant="primary" size="sm" onClick={handleVerify2Fa} loading={verifying2Fa}>Verify & Enable</Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <span className="text-sm text-text-primary">{profile?.two_factor_enabled ? '2FA is enabled' : '2FA is disabled'}</span>
                  <Button
                    variant={profile?.two_factor_enabled ? 'danger' : 'primary'}
                    size="sm"
                    onClick={profile?.two_factor_enabled ? handleDisable2Fa : handleSetup2Fa}
                    loading={settingUp2Fa}
                  >
                    {profile?.two_factor_enabled ? 'Disable 2FA' : 'Enable 2FA'}
                  </Button>
                </div>
              )}
            </div>

            <LinkedWalletCard />
          </div>
        )}

        {/* ── Notifications tab ── */}
        {tab === 'notifications' && (
          <div className="max-w-lg mx-auto space-y-2">
            {[
              { label: 'Trade Executed',   desc: 'When a trade is placed or closed',          key: 'trade_executed' },
              { label: 'Deposit Approved', desc: 'When a deposit is processed',               key: 'deposit_approved' },
              { label: 'Margin Warning',   desc: 'When margin level drops below threshold',   key: 'margin_warning' },
              { label: 'Price Alerts',     desc: 'Custom price level notifications',          key: 'price_alerts' },
              { label: 'Copy Trading',     desc: 'When a copied trader opens a position',     key: 'copy_trading' },
              { label: 'Newsletter',       desc: 'Weekly market analysis and updates',        key: 'newsletter' },
            ].map((n) => (
              <div
                key={n.key}
                className="rounded-xl border border-border-primary bg-card px-4 py-3 flex items-center justify-between gap-3 noise-texture"
              >
                <div className="min-w-0">
                  <div className="text-sm text-text-primary">{n.label}</div>
                  <div className="text-[10px] text-text-tertiary mt-0.5">{n.desc}</div>
                </div>
                <button
                  type="button"
                  onClick={() => toggleNotifPref(n.key)}
                  className={clsx(
                    'relative w-9 h-5 rounded-full transition-all flex-shrink-0 border',
                    notifPrefs[n.key] ? 'bg-accent border-accent' : 'bg-bg-secondary border-border-primary',
                  )}
                  aria-pressed={!!notifPrefs[n.key]}
                >
                  <div
                    className={clsx(
                      'absolute top-0.5 w-4 h-4 rounded-full transition-all shadow-sm',
                      notifPrefs[n.key] ? 'left-[18px] bg-black' : 'left-0.5 bg-text-primary',
                    )}
                  />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* ── Theme tab ── */}
        {tab === 'theme' && (
          <div className="max-w-lg mx-auto space-y-5">
            <div className="rounded-xl border border-border-primary bg-card p-5 sm:p-6 noise-texture">
              <h3 className="text-base font-semibold text-text-primary mb-1">Theme Settings</h3>
              <p className="text-sm text-text-secondary mb-5">Choose your preferred appearance.</p>
              <div className="grid grid-cols-2 gap-4">
                {/* Dark Blue */}
                <button
                  type="button"
                  onClick={() => setTheme('dark')}
                  className={clsx(
                    'relative rounded-xl border-2 p-4 text-left transition-all',
                    theme === 'dark'
                      ? 'border-accent bg-accent/8 ring-2 ring-accent/20'
                      : 'border-border-primary hover:border-border-secondary',
                  )}
                >
                  <div className="w-full h-20 rounded-lg mb-3 overflow-hidden" style={{ background: '#0a0a0a', border: '1px solid #2a2a2a' }}>
                    <div className="h-3 flex items-center px-2 gap-1" style={{ background: '#111' }}>
                      <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                      <span className="w-1.5 h-1.5 rounded-full bg-yellow-500" />
                      <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                    </div>
                    <div className="flex h-[calc(100%-12px)]">
                      <div className="w-1/4 border-r" style={{ borderColor: '#2a2a2a', background: '#0d0d0d' }} />
                      <div className="flex-1 p-1.5">
                        <div className="h-1.5 w-3/4 rounded-full mb-1" style={{ background: '#55a630' }} />
                        <div className="h-1 w-1/2 rounded-full" style={{ background: '#333' }} />
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Moon size={14} className="text-accent shrink-0" />
                    <span className="text-sm font-semibold text-text-primary">Dark Blue</span>
                  </div>
                  <p className="text-[10px] text-text-tertiary mt-0.5 ml-[22px]">Dark background with blue accents</p>
                  {theme === 'dark' && (
                    <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-accent flex items-center justify-center">
                      <svg width="10" height="8" viewBox="0 0 10 8" fill="none"><path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </div>
                  )}
                </button>

                {/* Light White */}
                <button
                  type="button"
                  onClick={() => setTheme('light')}
                  className={clsx(
                    'relative rounded-xl border-2 p-4 text-left transition-all',
                    theme === 'light'
                      ? 'border-accent bg-accent/8 ring-2 ring-accent/20'
                      : 'border-border-primary hover:border-border-secondary',
                  )}
                >
                  <div className="w-full h-20 rounded-lg mb-3 overflow-hidden" style={{ background: '#ffffff', border: '1px solid #e5e7eb' }}>
                    <div className="h-3 flex items-center px-2 gap-1" style={{ background: '#f9fafb' }}>
                      <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
                      <span className="w-1.5 h-1.5 rounded-full bg-yellow-400" />
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                    </div>
                    <div className="flex h-[calc(100%-12px)]">
                      <div className="w-1/4 border-r" style={{ borderColor: '#e5e7eb', background: '#f9fafb' }} />
                      <div className="flex-1 p-1.5">
                        <div className="h-1.5 w-3/4 rounded-full mb-1" style={{ background: '#111827' }} />
                        <div className="h-1 w-1/2 rounded-full" style={{ background: '#d1d5db' }} />
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Sun size={14} className="text-warning shrink-0" />
                    <span className="text-sm font-semibold text-text-primary">Light</span>
                  </div>
                  <p className="text-[10px] text-text-tertiary mt-0.5 ml-[22px]">Clean white with black text</p>
                  {theme === 'light' && (
                    <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-accent flex items-center justify-center">
                      <svg width="10" height="8" viewBox="0 0 10 8" fill="none"><path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </div>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Sessions tab ── */}
        {tab === 'sessions' && (
          <div className="max-w-2xl mx-auto">
            <div className="rounded-xl border border-border-primary bg-card p-5 sm:p-6 noise-texture">
              <h3 className="text-base font-semibold text-text-primary mb-4">Active Sessions</h3>
              {sessions.length === 0 ? (
                <p className="text-sm text-text-tertiary text-center py-4">No active sessions</p>
              ) : (
                <div className="space-y-3">
                  {sessions.map((s) => (
                    <div
                      key={s.id}
                      className="bg-bg-secondary border border-border-primary rounded-xl p-4 flex items-center justify-between gap-3 flex-wrap"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-text-primary">{s.device_info || s.user_agent || 'Unknown Device'}</div>
                        <div className="text-xs text-text-tertiary mt-0.5">
                          IP: {s.ip_address} • {new Date(s.created_at).toLocaleString()}
                        </div>
                      </div>
                      <Button variant="danger" size="sm" onClick={() => handleTerminateSession(s.id)} loading={terminatingSession === s.id}>
                        Terminate
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
            </div>
          </div>
        )}

        </div>
      </div>
    </DashboardShell>
  );
}
