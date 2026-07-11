'use client';

import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { adminApi } from '@/lib/api';
import toast from 'react-hot-toast';
import { Loader2, Plus, Save, Trash2, X } from 'lucide-react';

interface Instrument { id: string; symbol: string; display_name: string; segment: string; segment_id: string | null; }
interface AccountGroup { id: string; name: string }
interface SpreadRow {
  _key: string;
  scope: string;
  instrument_id: string | null;
  segment_id: string | null;
  user_id: string | null;
  /** NULL = applies to every account type (wildcard). When set, this rule
      only fires for trades on accounts in this group. */
  account_group_id: string | null;
  spread_type: string;
  value: number;
  is_enabled: boolean;
  _user_label?: string;
}

const newKey = () => `row_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export default function SpreadsPage() {
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [accountGroups, setAccountGroups] = useState<AccountGroup[]>([]);
  const [rows, setRows] = useState<SpreadRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Global spread boost — multiplies EVERY resolved spread by (1 + pct/100)
  // at read time (backend system settings); rules below are never mutated,
  // so turning it OFF restores the original values instantly.
  const [boostOn, setBoostOn] = useState(false);
  const [boostPct, setBoostPct] = useState<number>(0);
  const [boostSaving, setBoostSaving] = useState(false);
  const [userSearchKey, setUserSearchKey] = useState<string | null>(null);
  const [userSearchQuery, setUserSearchQuery] = useState('');
  const [userSearchResults, setUserSearchResults] = useState<{ id: string; name: string; email: string }[]>([]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [instRes, spreadRes, groupRes, settingsRes] = await Promise.all([
        adminApi.get<{ items: Instrument[] }>('/config/instruments'),
        adminApi.get<any[]>('/config/spreads'),
        // /admin/account-types returns the AccountGroup list (Standard,
        // ECN, VIP, ...). Used to power the per-account-type dropdown
        // on each rule row. Falls back to empty list if endpoint changes.
        adminApi.get<{ items: AccountGroup[] } | AccountGroup[]>('/account-types').catch(() => ({ items: [] as AccountGroup[] })),
        // System settings — spread_boost_enabled / spread_boost_percent.
        adminApi.get<any[]>('/settings').catch(() => [] as any[]),
      ]);
      const settingsList: { key: string; value: any }[] = Array.isArray(settingsRes) ? settingsRes : [];
      const sVal = (k: string) => settingsList.find(s => s.key === k)?.value;
      const rawOn = sVal('spread_boost_enabled');
      setBoostOn(rawOn === true || rawOn === 'true' || rawOn === 1);
      const rawPct = parseFloat(String(sVal('spread_boost_percent') ?? ''));
      setBoostPct(Number.isFinite(rawPct) ? rawPct : 0);
      setInstruments(instRes.items || []);
      const groupsRaw: any = groupRes;
      const groupsList: AccountGroup[] = Array.isArray(groupsRaw)
        ? groupsRaw
        : (groupsRaw?.items || []);
      setAccountGroups(groupsList);
      setRows((spreadRes || []).map((c: any) => ({
        _key: newKey(),
        scope: c.scope, instrument_id: c.instrument_id, segment_id: c.segment_id,
        user_id: c.user_id,
        account_group_id: c.account_group_id ?? null,
        spread_type: c.spread_type, value: c.value, is_enabled: c.is_enabled,
        _user_label: c.user_id ? `User ${c.user_id.slice(0, 8)}` : undefined,
      })));
    } catch (e: any) { toast.error(e.message || 'Failed to load'); } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Unique segments derived from the instruments list (each instrument
  // carries segment + segment_id). Powers the Per-Segment dropdown so
  // admin can set one spread for an entire asset class.
  const segments = (() => {
    const seen = new Map<string, string>();
    for (const i of instruments) {
      if (i.segment_id && !seen.has(i.segment_id)) {
        seen.set(i.segment_id, i.segment || i.segment_id.slice(0, 8));
      }
    }
    return Array.from(seen, ([id, name]) => ({ id, name }));
  })();

  const addRow = (scope: string) => setRows(prev => [...prev, { _key: newKey(), scope, instrument_id: null, segment_id: null, user_id: null, account_group_id: null, spread_type: 'fixed', value: 1, is_enabled: true }]);
  const updateRow = (key: string, field: string, val: any) => {
    setRows(prev => prev.map(r => {
      if (r._key !== key) return r;
      const u: SpreadRow = { ...r, [field]: val };
      if (field === 'instrument_id') { const inst = instruments.find(x => x.id === val); u.segment_id = inst?.segment_id || null; }
      return u;
    }));
  };
  // Per-Instrument row with instrument="All" (null id) is semantically a global
  // default — re-tag its scope so the engine's priority chain lets it fall through
  // for symbols that don't have a specific override.
  const normalizeRows = (list: SpreadRow[]): SpreadRow[] =>
    list.map(r =>
      r.scope === 'instrument' && !r.instrument_id
        ? { ...r, scope: 'default', segment_id: null }
        : r,
    );

  const removeRow = async (key: string) => {
    const next = rows.filter(r => r._key !== key);
    setRows(next);
    try {
      const normalized = normalizeRows(next);
      const cleaned = normalized.filter(r =>
        !(r.scope === 'user' && !r.user_id) && !(r.scope === 'segment' && !r.segment_id),
      );
      await adminApi.put('/config/spreads', {
        configs: cleaned.map(r => ({ scope: r.scope, instrument_id: r.instrument_id, segment_id: r.segment_id, user_id: r.user_id, account_group_id: r.account_group_id, spread_type: r.spread_type, value: r.value, is_enabled: r.is_enabled })),
      });
      toast.success('Rule removed');
    } catch (e: any) {
      toast.error(e.message || 'Could not delete — restoring');
      fetchData();
    }
  };

  const searchUsers = async (q: string, key: string) => {
    setUserSearchQuery(q); setUserSearchKey(key);
    if (q.length < 2) { setUserSearchResults([]); return; }
    try { const d = await adminApi.get<{ users: any[] }>('/users', { search: q, per_page: '8' }); setUserSearchResults((d.users || []).map((u: any) => ({ id: u.id, name: u.name, email: u.email }))); } catch {}
  };
  const selectUser = (key: string, u: { id: string; name: string; email: string }) => {
    setRows(prev => prev.map(r => r._key === key ? { ...r, user_id: u.id, _user_label: `${u.name} (${u.email})` } : r));
    setUserSearchKey(null); setUserSearchQuery(''); setUserSearchResults([]);
  };

  const saveBoost = async (on: boolean, pct: number) => {
    if (on && (!Number.isFinite(pct) || pct <= 0)) {
      toast.error('Enter a percent value above 0 before turning the boost ON.');
      return;
    }
    setBoostSaving(true);
    try {
      await adminApi.put('/settings', {
        settings: { spread_boost_enabled: on, spread_boost_percent: pct },
      });
      setBoostOn(on);
      toast.success(
        on
          ? `Spread boost ON — every spread is now +${pct}%`
          : 'Spread boost OFF — original spreads restored',
      );
    } catch (e: any) {
      toast.error(e.message || 'Failed to save spread boost');
    } finally {
      setBoostSaving(false);
    }
  };

  const saveAll = async () => {
    const badUser = rows.find(r => r.scope === 'user' && !r.user_id);
    if (badUser) { toast.error('Pick a user for every Per-User rule or remove that row.'); return; }
    const badSegment = rows.find(r => r.scope === 'segment' && !r.segment_id);
    if (badSegment) { toast.error('Pick a segment for every Per-Segment rule or remove that row.'); return; }
    const cleaned = normalizeRows(rows);
    setSaving(true);
    try {
      await adminApi.put('/config/spreads', { configs: cleaned.map(r => ({ scope: r.scope, instrument_id: r.instrument_id, segment_id: r.segment_id, user_id: r.user_id, account_group_id: r.account_group_id, spread_type: r.spread_type, value: r.value, is_enabled: r.is_enabled })) });
      toast.success('Spreads saved'); fetchData();
    } catch (e: any) { toast.error(e.message || 'Save failed'); } finally { setSaving(false); }
  };

  if (loading) return <><div className="flex items-center justify-center h-96"><Loader2 size={20} className="animate-spin text-text-tertiary" /></div></>;

  const globalRows = rows.filter(r => r.scope === 'default');
  const instrumentRows = rows.filter(r => r.scope === 'instrument');
  const segmentRows = rows.filter(r => r.scope === 'segment');
  const userRows = rows.filter(r => r.scope === 'user');

  const renderTable = (title: string, items: SpreadRow[], scopeType: string) => (
      <div className="bg-bg-secondary border border-border-primary rounded-md">
        <div className="px-4 py-2.5 border-b border-border-primary flex items-center justify-between">
          <h3 className="text-xs font-semibold text-text-primary">{title}</h3>
          <button onClick={() => addRow(scopeType)} className="inline-flex items-center gap-1 px-2 py-1 text-xxs font-medium text-text-secondary border border-border-primary rounded hover:bg-bg-hover transition-fast"><Plus size={11} /> Add</button>
        </div>
        <div className="overflow-visible">
          <table className="w-full">
            <thead><tr className="border-b border-border-primary bg-bg-tertiary/40">
              {(scopeType === 'instrument' ? ['Instrument'] : scopeType === 'segment' ? ['Segment'] : scopeType === 'user' ? ['User', 'Instrument'] : []).concat(['Account type', 'Type', 'Value (pips)', 'On', '']).map(c => (
                <th key={c} className="text-left px-3 py-2 text-xxs font-medium text-text-tertiary uppercase tracking-wide">{c}</th>
              ))}
            </tr></thead>
            <tbody>
              {items.length === 0 ? <tr><td colSpan={7} className="px-4 py-6 text-center text-xxs text-text-tertiary">No rules.</td></tr> : items.map(r => {
                const k = r._key;
                return (
                  <tr key={k} className="border-b border-border-primary/50 hover:bg-bg-hover/30">
                    {scopeType === 'user' && (
                      <td className="px-3 py-2">
                        {r._user_label ? (
                          <div className="flex items-center gap-1"><span className="text-xs text-text-primary truncate max-w-[140px]">{r._user_label}</span><button onClick={() => setRows(prev => prev.map(x => x._key === k ? { ...x, user_id: null, _user_label: undefined } : x))} className="text-text-tertiary hover:text-danger"><X size={10} /></button></div>
                        ) : (
                          <div className="relative">
                            <input type="text" value={userSearchKey === k ? userSearchQuery : ''} onChange={e => searchUsers(e.target.value, k)} onFocus={() => setUserSearchKey(k)} placeholder="Search user..." className="w-36 px-2 py-1 text-xxs bg-bg-input border border-border-primary rounded text-text-primary placeholder:text-text-tertiary" />
                            {userSearchKey === k && userSearchResults.length > 0 && (
                              <div className="absolute left-0 right-0 top-full mt-1 z-20 max-h-32 overflow-y-auto border border-border-primary rounded bg-bg-secondary shadow-dropdown">
                                {userSearchResults.map(u => <button key={u.id} onClick={() => selectUser(k, u)} className="w-full text-left px-2 py-1.5 text-xxs hover:bg-bg-hover border-b border-border-primary/50 last:border-0"><span className="text-text-primary">{u.name}</span> <span className="text-text-tertiary">{u.email}</span></button>)}
                              </div>
                            )}
                          </div>
                        )}
                      </td>
                    )}
                    {(scopeType === 'instrument' || scopeType === 'user') && (
                      <td className="px-3 py-2"><select value={r.instrument_id || ''} onChange={e => updateRow(k, 'instrument_id', e.target.value || null)} className="text-xs py-1 pl-2 pr-6 appearance-none bg-bg-input border border-border-primary rounded text-text-primary w-32"><option value="">All</option>{instruments.map(i => <option key={i.id} value={i.id}>{i.symbol}</option>)}</select></td>
                    )}
                    {scopeType === 'segment' && (
                      <td className="px-3 py-2"><select value={r.segment_id || ''} onChange={e => updateRow(k, 'segment_id', e.target.value || null)} className="text-xs py-1 pl-2 pr-6 appearance-none bg-bg-input border border-border-primary rounded text-text-primary w-40"><option value="">Select segment…</option>{segments.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></td>
                    )}
                    <td className="px-3 py-2">
                      <select
                        value={r.account_group_id || ''}
                        onChange={e => updateRow(k, 'account_group_id', e.target.value || null)}
                        className="text-xs py-1 pl-2 pr-6 appearance-none bg-bg-input border border-border-primary rounded text-text-primary w-28"
                        title="Account types this rule applies to. 'Any' = wildcard."
                      >
                        <option value="">Any</option>
                        {accountGroups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-2"><select value={r.spread_type} onChange={e => updateRow(k, 'spread_type', e.target.value)} className="text-xs py-1 pl-2 pr-6 appearance-none bg-bg-input border border-border-primary rounded text-text-primary w-24"><option value="fixed">Fixed</option><option value="variable">Variable</option></select></td>
                    <td className="px-3 py-2"><input type="number" step="0.1" min="0" value={r.value} onChange={e => updateRow(k, 'value', parseFloat(e.target.value) || 0)} className="w-20 px-2 py-1 text-xs bg-bg-input border border-border-primary rounded font-mono tabular-nums text-text-primary" /></td>
                    <td className="px-3 py-2"><button onClick={() => updateRow(k, 'is_enabled', !r.is_enabled)} className={cn('w-8 h-4 rounded-full transition-fast relative', r.is_enabled ? 'bg-buy' : 'bg-bg-hover border border-border-primary')}><span className={cn('absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-fast', r.is_enabled ? 'left-[16px]' : 'left-0.5')} /></button></td>
                    <td className="px-3 py-2"><button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); void removeRow(k); }} className="p-1 text-text-tertiary hover:text-danger transition-fast" title="Delete rule"><Trash2 size={12} /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );

  return (
    <>
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-text-primary">Spread Configuration</h1>
            <p className="text-xxs text-text-tertiary mt-0.5">
              Priority (highest → lowest):{' '}
              <strong className="text-text-secondary">Per-User → Per-Instrument → Per-Segment → Default</strong>.
              A Per-Segment rule applies that spread to <strong className="text-text-secondary">every instrument
              in that segment</strong> unless a Per-Instrument or Per-User rule overrides it. Default applies to
              anything not covered by the rules above. If nothing matches, spread is{' '}
              <strong className="text-text-secondary">0</strong>.
            </p>
          </div>
          <button onClick={saveAll} disabled={saving} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-buy rounded-md hover:bg-buy-light disabled:opacity-50 transition-fast">
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save All
          </button>
        </div>
        {/* Global spread boost — read-time multiplier over every rule below. */}
        <div className="bg-bg-secondary border border-border-primary rounded-md px-4 py-3 flex flex-wrap items-center gap-4">
          <div className="min-w-[220px]">
            <h3 className="text-xs font-semibold text-text-primary">Global Spread Boost</h3>
            <p className="text-xxs text-text-tertiary mt-0.5">
              ON: every spread below increases by this percent (display + fills). OFF: original values return. Rules are never modified.
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              step="1"
              min="0"
              value={boostPct}
              onChange={e => setBoostPct(parseFloat(e.target.value) || 0)}
              className="w-20 px-2 py-1 text-xs bg-bg-input border border-border-primary rounded font-mono tabular-nums text-text-primary"
              title="Percent to increase all spreads by"
            />
            <span className="text-xs text-text-secondary">%</span>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-text-primary cursor-pointer">
              <input
                type="radio"
                name="spread-boost"
                checked={boostOn}
                disabled={boostSaving}
                onChange={() => saveBoost(true, boostPct)}
                className="accent-buy"
              />
              On
            </label>
            <label className="flex items-center gap-1.5 text-xs text-text-primary cursor-pointer">
              <input
                type="radio"
                name="spread-boost"
                checked={!boostOn}
                disabled={boostSaving}
                onChange={() => saveBoost(false, boostPct)}
                className="accent-buy"
              />
              Off
            </label>
          </div>
          {boostOn && (
            <div className="flex items-center gap-2">
              <span className="text-xxs font-semibold text-buy border border-buy/40 rounded px-2 py-0.5">ACTIVE +{boostPct}%</span>
              <button
                onClick={() => saveBoost(true, boostPct)}
                disabled={boostSaving}
                className="text-xxs font-medium text-text-secondary border border-border-primary rounded px-2 py-0.5 hover:bg-bg-hover transition-fast disabled:opacity-50"
                title="Save a changed percent while the boost stays on"
              >
                {boostSaving ? 'Saving…' : 'Update %'}
              </button>
            </div>
          )}
        </div>
        {renderTable('Default (All Instruments)', globalRows, 'default')}
        {renderTable('Per Segment (e.g. Forex / Metals / Crypto — applies to every instrument in that segment)', segmentRows, 'segment')}
        {renderTable('Per Instrument', instrumentRows, 'instrument')}
        {renderTable('Per User (Override)', userRows, 'user')}
      </div>
    </>
  );
}
