'use client';

import { useEffect, useState, useCallback } from 'react';
import { adminApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Loader2, CheckCircle, XCircle, Users, RefreshCw, Edit, Settings, Plus, Trash2, Star, AlertTriangle, ChevronRight, ChevronDown, GitBranch, ArrowRightLeft, UserX } from 'lucide-react';
import toast from 'react-hot-toast';

interface IBApplication {
  id: string;
  user_id: string;
  user_name: string;
  user_email: string;
  status: string;
  created_at: string;
  application_data?: any;
}

interface IBAgent {
  id: string;
  user_id: string;
  user_name: string;
  user_email: string;
  referral_code: string;
  referral_count: number;
  total_earned: number;
  pending_payout: number;
  level: number;
  ib_type?: 'super_ib' | 'ib' | 'sub_ib' | null;
  is_active: boolean;
  commission_plan_id?: string;
  custom_commission_per_lot?: number;
  custom_commission_per_trade?: number;
  tier_override?: string | null;
  created_at: string;
}

interface CommissionPlan {
  id: string;
  name: string;
  is_default: boolean;
  commission_per_lot: number;
  commission_per_trade: number;
  spread_share_pct: number;
  cpa_per_deposit: number;
  mlm_levels: number;
  mlm_distribution: number[];
}

interface IBTreeNode {
  id: string;
  user_id: string;
  name: string;
  email: string;
  referral_code: string;
  level: number;
  ib_type?: 'super_ib' | 'ib' | 'sub_ib';
  total_earned: number;
  referral_count: number;
  children: IBTreeNode[];
}

interface ReferralUser {
  user_id: string;
  name: string;
  email: string;
  trades: number;
  commission_generated: number;
  joined_at: string | null;
  is_ib?: boolean;
  ib_level?: number | null;
  ib_type?: 'super_ib' | 'ib' | 'sub_ib' | null;
}

interface UnassignedUser {
  user_id: string;
  name: string;
  email: string;
  created_at: string | null;
}

type Tab = 'applications' | 'active' | 'tree';

// Role filter shared by the Active IBs table and the IB Tree.
type RoleFilter = 'all' | 'super_ib' | 'ib' | 'sub_ib';
const ROLE_FILTERS: { id: RoleFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'super_ib', label: 'Super IB' },
  { id: 'ib', label: 'IB' },
  { id: 'sub_ib', label: 'Sub-IB' },
];

function roleLabel(type?: string | null): string {
  return type === 'super_ib' ? 'Super IB' : type === 'sub_ib' ? 'Sub-IB' : 'IB';
}

function roleBadgeClass(type?: string | null): string {
  return type === 'super_ib'
    ? 'bg-primary/10 text-primary border-primary/25'
    : type === 'sub_ib'
      ? 'bg-amber-500/10 text-amber-500 border-amber-500/25'
      : 'bg-bg-tertiary border-border-primary text-text-secondary';
}

function RoleBadge({ type }: { type?: string | null }) {
  return (
    <span className={cn('text-xxs px-1.5 py-0.5 rounded-sm border whitespace-nowrap', roleBadgeClass(type))}>
      {roleLabel(type)}
    </span>
  );
}

// Depth-first flatten of the IB tree — used to render a flat, role-filtered list.
function flattenTree(nodes: IBTreeNode[]): IBTreeNode[] {
  const out: IBTreeNode[] = [];
  const walk = (arr: IBTreeNode[]) => {
    for (const n of arr) {
      out.push(n);
      if (n.children?.length) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

// Reusable role filter pill bar.
function RoleFilterBar({ value, onChange }: { value: RoleFilter; onChange: (r: RoleFilter) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {ROLE_FILTERS.map((f) => (
        <button
          key={f.id}
          type="button"
          onClick={() => onChange(f.id)}
          className={cn(
            'px-2.5 py-1 rounded-md text-xxs font-medium border transition-fast',
            value === f.id
              ? 'bg-primary/15 text-primary border-primary/30'
              : 'bg-transparent text-text-tertiary border-border-primary hover:text-text-secondary hover:border-border-secondary',
          )}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}

function formatMoney(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function IBPage() {
  const [tab, setTab] = useState<Tab>('applications');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [applications, setApplications] = useState<IBApplication[]>([]);
  const [agents, setAgents] = useState<IBAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [approveModal, setApproveModal] = useState<IBApplication | null>(null);
  const [rejectModal, setRejectModal] = useState<IBApplication | null>(null);
  const [editCommissionModal, setEditCommissionModal] = useState<IBAgent | null>(null);
  const [rejectAgentModal, setRejectAgentModal] = useState<IBAgent | null>(null);
  const [commissionPlansModal, setCommissionPlansModal] = useState(false);
  const [commissionPlans, setCommissionPlans] = useState<CommissionPlan[]>([]);
  const [editingPlan, setEditingPlan] = useState<CommissionPlan | 'new' | null>(null);
  const [deletingPlanId, setDeletingPlanId] = useState<string | null>(null);
  const [planForm, setPlanForm] = useState({
    name: '',
    is_default: false,
    commission_per_lot: '',
    commission_per_trade: '',
    mlm_distribution: [40, 25, 15, 10, 10] as number[],
  });
  const [commissionPlan, setCommissionPlan] = useState('default');
  const [customPerLot, setCustomPerLot] = useState('');
  const [customPerTrade, setCustomPerTrade] = useState('');
  const [tierOverride, setTierOverride] = useState(''); // '' = Auto
  const [rejectReason, setRejectReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // IB Tree state
  const [ibTree, setIbTree] = useState<IBTreeNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [selectedIB, setSelectedIB] = useState<IBTreeNode | null>(null);
  const [ibReferrals, setIbReferrals] = useState<ReferralUser[]>([]);
  const [referralsLoading, setReferralsLoading] = useState(false);
  const [unassignedUsers, setUnassignedUsers] = useState<UnassignedUser[]>([]);
  const [unassignedLoading, setUnassignedLoading] = useState(false);
  const [transferModal, setTransferModal] = useState<{ userId: string; userName: string; currentIbId?: string } | null>(null);
  const [transferTargetIb, setTransferTargetIb] = useState('');
  const [allAgents, setAllAgents] = useState<IBAgent[]>([]);

  // IB program settings — surfaced here for findability. Persisted via the
  // generic /settings endpoint (same key as the system Settings page).
  const [minDeposit, setMinDeposit] = useState<number>(100);
  const [minDepositLoaded, setMinDepositLoaded] = useState(false);
  const [savingMinDeposit, setSavingMinDeposit] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const all = await adminApi.get<{ key: string; value: any }[]>('/settings');
        const list = Array.isArray(all) ? all : [];
        const row = list.find((s) => s.key === 'ib_min_deposit_usd');
        if (row != null) {
          const n = Number(row.value);
          if (Number.isFinite(n)) setMinDeposit(n);
        }
      } catch {/* keep default */} finally {
        setMinDepositLoaded(true);
      }
    })();
  }, []);

  const saveMinDeposit = async () => {
    if (minDeposit < 0) { toast.error('Min deposit cannot be negative'); return; }
    setSavingMinDeposit(true);
    try {
      await adminApi.put('/settings', { settings: { ib_min_deposit_usd: minDeposit } });
      toast.success('IB minimum deposit saved');
    } catch (e: any) {
      toast.error(e?.message || 'Save failed');
    } finally {
      setSavingMinDeposit(false);
    }
  };

  // Company / House IB state — the designated IB the broker uses for
  // its own marketing campaigns and as the default parent for
  // unreferred signups when the auto-attach toggle is on.
  interface CompanyIBState {
    user_id: string | null;
    user_email: string | null;
    ib_profile_id: string | null;
    referral_code: string | null;
    referral_link: string | null;
    referrals_count: number;
    attach_unreferred: boolean;
  }
  const [companyIB, setCompanyIB] = useState<CompanyIBState | null>(null);
  const [companyIBLoaded, setCompanyIBLoaded] = useState(false);
  const [companyIBPicker, setCompanyIBPicker] = useState<string>('');
  const [companyIBAttach, setCompanyIBAttach] = useState<boolean>(false);
  const [savingCompanyIB, setSavingCompanyIB] = useState(false);

  const loadCompanyIB = useCallback(async () => {
    try {
      const c = await adminApi.get<CompanyIBState>('/business/company-ib');
      setCompanyIB(c);
      setCompanyIBPicker(c?.user_id || '');
      setCompanyIBAttach(!!c?.attach_unreferred);
    } catch {/* leave default */} finally {
      setCompanyIBLoaded(true);
    }
  }, []);

  useEffect(() => { loadCompanyIB(); }, [loadCompanyIB]);

  const saveCompanyIB = async () => {
    setSavingCompanyIB(true);
    try {
      const updated = await adminApi.put<CompanyIBState>('/business/company-ib', {
        user_id: companyIBPicker,
        attach_unreferred: companyIBAttach,
      });
      setCompanyIB(updated);
      toast.success(companyIBPicker ? 'Super IB updated' : 'Super IB cleared');
    } catch (e: any) {
      toast.error(e?.message || 'Save failed');
    } finally {
      setSavingCompanyIB(false);
    }
  };

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      if (tab === 'applications') {
        const res = await adminApi.get<{ items: IBApplication[] }>('/business/ib/applications', { status: 'pending' });
        setApplications(res.items || []);
      } else if (tab === 'active') {
        const res = await adminApi.get<{ items: IBAgent[] }>('/business/ib/agents');
        setAgents(res.items || []);
      } else if (tab === 'tree') {
        setTreeLoading(true);
        setUnassignedLoading(true);
        const [treeRes, unassignedRes, agentsRes] = await Promise.all([
          adminApi.get<IBTreeNode[]>('/business/ib/tree'),
          adminApi.get<{ items: UnassignedUser[] }>('/business/ib/users/unassigned', { per_page: '100' }),
          adminApi.get<{ items: IBAgent[] }>('/business/ib/agents'),
        ]);
        const treeArr = Array.isArray(treeRes) ? treeRes : [];
        setIbTree(treeArr);
        // Auto-expand the ENTIRE hierarchy so the full tree (every sub-IB
        // level, with each IB's user + sub-IB counts) is visible at once
        // instead of being collapsed behind the chevrons. Admins wanted the
        // whole downline / history in view without clicking each node open.
        const allIds = new Set<string>();
        const collect = (nodes: IBTreeNode[]) => nodes.forEach((n) => {
          allIds.add(n.id);
          if (n.children && n.children.length) collect(n.children);
        });
        collect(treeArr);
        setExpandedNodes(allIds);
        setUnassignedUsers(unassignedRes.items || []);
        setAllAgents(agentsRes.items || []);
        setTreeLoading(false);
        setUnassignedLoading(false);
      }
    } catch (e: any) {
      toast.error(e.message || 'Failed to load data');
    } finally {
      setLoading(false);
      setTreeLoading(false);
      setUnassignedLoading(false);
    }
  }, [tab]);

  const fetchIBReferrals = useCallback(async (ibId: string) => {
    setReferralsLoading(true);
    try {
      const res = await adminApi.get<{ referrals: ReferralUser[] }>(`/business/ib/agents/${ibId}/referrals`);
      setIbReferrals(res.referrals || []);
    } catch (e: any) {
      toast.error(e.message || 'Failed to load referrals');
    } finally {
      setReferralsLoading(false);
    }
  }, []);

  const handleTransferUser = async () => {
    if (!transferModal || !transferTargetIb) return;
    setSubmitting(true);
    try {
      await adminApi.put(`/business/ib/users/${transferModal.userId}/move`, { new_ib_id: transferTargetIb });
      toast.success(`${transferModal.userName} transferred successfully`);
      setTransferModal(null);
      setTransferTargetIb('');
      // Refresh tree data
      fetchData();
      if (selectedIB) fetchIBReferrals(selectedIB.id);
    } catch (e: any) {
      toast.error(e.message || 'Failed to transfer user');
    } finally {
      setSubmitting(false);
    }
  };

  const toggleNode = (id: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectIB = (node: IBTreeNode) => {
    setSelectedIB(node);
    fetchIBReferrals(node.id);
  };

  // Find a tree node by its user id (recursive) so a sub-IB shown in an IB's
  // user list can be clicked to drill straight into that sub-IB's own users.
  const findNodeByUserId = (nodes: IBTreeNode[], userId: string): IBTreeNode | null => {
    for (const n of nodes) {
      if (n.user_id === userId) return n;
      const hit = findNodeByUserId(n.children || [], userId);
      if (hit) return hit;
    }
    return null;
  };
  const drillIntoUser = (userId: string) => {
    const node = findNodeByUserId(ibTree, userId);
    if (node) selectIB(node);
  };

  const fetchCommissionPlans = useCallback(async () => {
    try {
      const res = await adminApi.get<{ items: CommissionPlan[] }>('/business/ib/commission-plans');
      setCommissionPlans(res.items || []);
    } catch (e: any) {
      toast.error(e.message || 'Failed to load commission plans');
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => { fetchCommissionPlans(); }, [fetchCommissionPlans]);

  const handleApprove = async () => {
    if (!approveModal) return;
    setSubmitting(true);
    try {
      const body: any = { commission_plan: commissionPlan };
      if (commissionPlan === 'custom') {
        if (customPerLot) body.custom_per_lot = parseFloat(customPerLot);
        if (customPerTrade) body.custom_per_trade = parseFloat(customPerTrade);
      }
      await adminApi.post(`/business/ib/applications/${approveModal.id}/approve`, body);
      toast.success('Application approved');
      setApproveModal(null);
      setCommissionPlan('default');
      setCustomPerLot('');
      setCustomPerTrade('');
      fetchData();
    } catch (e: any) {
      toast.error(e.message || 'Failed to approve');
    } finally {
      setSubmitting(false);
    }
  };

  const handleReject = async () => {
    if (!rejectModal) return;
    setSubmitting(true);
    try {
      await adminApi.post(`/business/ib/applications/${rejectModal.id}/reject`, { reason: rejectReason });
      toast.success('Application rejected');
      setRejectModal(null);
      setRejectReason('');
      fetchData();
    } catch (e: any) {
      toast.error(e.message || 'Failed to reject');
    } finally {
      setSubmitting(false);
    }
  };

  const handleEditCommission = async () => {
    if (!editCommissionModal) return;
    setSubmitting(true);
    try {
      const body: any = {};
      if (commissionPlan === 'custom') {
        // Custom rates — clear plan, send custom values
        body.commission_plan_id = null;
        if (customPerLot) body.custom_commission_per_lot = parseFloat(customPerLot);
        if (customPerTrade) body.custom_commission_per_trade = parseFloat(customPerTrade);
      } else if (commissionPlan && commissionPlan !== 'default') {
        // Specific plan UUID selected
        body.commission_plan_id = commissionPlan;
      } else {
        // Default — clear everything
        body.commission_plan_id = null;
      }
      // Manual tier override — always sent so '' clears it back to Auto.
      body.tier_override = tierOverride;
      await adminApi.put(`/business/ib/agents/${editCommissionModal.id}/commission`, body);
      toast.success('Commission updated successfully');
      setEditCommissionModal(null);
      setCommissionPlan('default');
      setCustomPerLot('');
      setCustomPerTrade('');
      fetchData();
    } catch (e: any) {
      toast.error(e.message || 'Failed to update commission');
    } finally {
      setSubmitting(false);
    }
  };

  const openPlanEditor = (plan: CommissionPlan | 'new') => {
    if (plan === 'new') {
      setPlanForm({
        name: '',
        is_default: commissionPlans.length === 0,
        commission_per_lot: '',
        commission_per_trade: '',
        mlm_distribution: [40, 25, 15, 10, 10],
      });
    } else {
      setPlanForm({
        name: plan.name,
        is_default: plan.is_default,
        commission_per_lot: plan.commission_per_lot ? String(plan.commission_per_lot) : '',
        commission_per_trade: plan.commission_per_trade ? String(plan.commission_per_trade) : '',
        mlm_distribution: (plan.mlm_distribution && plan.mlm_distribution.length > 0)
          ? [...plan.mlm_distribution]
          : [40, 25, 15, 10, 10],
      });
    }
    setEditingPlan(plan);
  };

  const addLevel = () => {
    if (planForm.mlm_distribution.length >= 20) return;
    setPlanForm((f) => ({ ...f, mlm_distribution: [...f.mlm_distribution, 0] }));
  };

  const removeLevel = (idx: number) => {
    if (planForm.mlm_distribution.length <= 1) return;
    setPlanForm((f) => ({ ...f, mlm_distribution: f.mlm_distribution.filter((_, i) => i !== idx) }));
  };

  const updateLevelPct = (idx: number, v: number) => {
    setPlanForm((f) => ({
      ...f,
      mlm_distribution: f.mlm_distribution.map((x, i) => (i === idx ? v : x)),
    }));
  };

  const handleSavePlan = async () => {
    if (!planForm.name.trim()) {
      toast.error('Plan name required');
      return;
    }
    const total = planForm.mlm_distribution.reduce((a, b) => a + (Number(b) || 0), 0);
    if (total > 100) {
      toast.error('MLM distribution total cannot exceed 100%');
      return;
    }
    setSubmitting(true);
    try {
      const body = {
        name: planForm.name.trim(),
        is_default: planForm.is_default,
        commission_per_lot: parseFloat(planForm.commission_per_lot) || 0,
        commission_per_trade: parseFloat(planForm.commission_per_trade) || 0,
        spread_share_pct: 0,
        cpa_per_deposit: 0,
        mlm_levels: planForm.mlm_distribution.length,
        mlm_distribution: planForm.mlm_distribution.map((x) => Number(x) || 0),
      };
      if (editingPlan === 'new') {
        await adminApi.post('/business/ib/commission-plans', body);
        toast.success('Plan created');
      } else if (editingPlan) {
        await adminApi.put(`/business/ib/commission-plans/${editingPlan.id}`, body);
        toast.success('Plan updated');
      }
      setEditingPlan(null);
      await fetchCommissionPlans();
    } catch (e: any) {
      toast.error(e.message || 'Failed to save plan');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeletePlan = async (planId: string) => {
    setSubmitting(true);
    try {
      await adminApi.delete(`/business/ib/commission-plans/${planId}`);
      toast.success('Plan deleted');
      setDeletingPlanId(null);
      await fetchCommissionPlans();
    } catch (e: any) {
      toast.error(e.message || 'Failed to delete');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRejectAgent = async () => {
    if (!rejectAgentModal) return;
    setSubmitting(true);
    try {
      await adminApi.post(`/business/ib/agents/${rejectAgentModal.id}/reject`, { reason: rejectReason });
      toast.success('IB rejected successfully');
      setRejectAgentModal(null);
      setRejectReason('');
      fetchData();
    } catch (e: any) {
      toast.error(e.message || 'Failed to reject IB');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-text-primary">IB Management</h1>
            <p className="text-xxs text-text-tertiary mt-0.5">Manage Introducing Broker applications and active agents</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setCommissionPlansModal(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-border-primary text-text-secondary hover:bg-bg-hover transition-fast">
              <Settings size={14} />
              Commission Plans
            </button>
            <button onClick={fetchData} className="p-1.5 rounded-md border border-border-primary text-text-secondary hover:bg-bg-hover transition-fast">
              <RefreshCw size={14} />
            </button>
          </div>
        </div>

        {minDepositLoaded && (
          <div className="bg-bg-secondary border border-border-primary rounded-md p-4 flex flex-wrap items-center gap-3">
            <div className="flex-1 min-w-[200px]">
              <h2 className="text-sm font-semibold text-text-primary">IB Program — Minimum Deposit Gate</h2>
              <p className="text-xxs text-text-tertiary mt-0.5">
                A user must have at least this much in lifetime approved deposits before they can submit an IB application.
                Apply / sub-broker endpoints both enforce this.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                step={50}
                value={minDeposit}
                onChange={(e) => setMinDeposit(parseFloat(e.target.value) || 0)}
                className="w-28 text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md font-mono tabular-nums text-right text-text-primary"
              />
              <span className="text-xs text-text-tertiary">USD</span>
              <button
                onClick={saveMinDeposit}
                disabled={savingMinDeposit}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium text-white bg-buy hover:bg-buy-light disabled:opacity-50"
              >
                {savingMinDeposit ? <Loader2 size={12} className="animate-spin" /> : null} Save
              </button>
            </div>
          </div>
        )}

        {/* Company / House IB — the IB the broker owns and uses for its
            own bonus campaigns and as the default parent for unreferred
            signups. Designate any approved IB from the dropdown. */}
        {companyIBLoaded && (
          <div className="bg-bg-secondary border border-accent/30 rounded-md p-4 space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-sm font-semibold text-text-primary">Super IB (House Master)</h2>
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded-sm font-medium uppercase tracking-wide ${
                      companyIB?.user_id && companyIB?.attach_unreferred
                        ? 'bg-buy/15 text-buy'
                        : 'bg-text-tertiary/15 text-text-tertiary'
                    }`}
                  >
                    {companyIB?.user_id && companyIB?.attach_unreferred
                      ? 'Auto-attach ON'
                      : !companyIB?.user_id
                        ? 'Not designated'
                        : 'Auto-attach OFF'}
                  </span>
                </div>
                <p className="text-xxs text-text-tertiary mt-0.5 max-w-2xl">
                  Pick one approved IB as the platform&apos;s <strong>Super IB</strong>. When auto-attach is
                  ON, every new signup that does not enter an IB referral code is parented under the
                  Super IB. The Super IB earns the same signup bonus + ongoing trade commissions as any
                  regular IB referral; edit its commission row in the Active IBs tab to tune the rate.
                </p>
              </div>
              <button
                onClick={saveCompanyIB}
                disabled={savingCompanyIB}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium text-white bg-buy hover:bg-buy-light disabled:opacity-50"
              >
                {savingCompanyIB ? <Loader2 size={12} className="animate-spin" /> : null} Save
              </button>
            </div>

            <div className="grid sm:grid-cols-[1fr_auto] gap-3 items-start">
              <div className="space-y-2">
                <label className="text-xxs text-text-tertiary uppercase tracking-wide block">Designated Super IB</label>
                <select
                  value={companyIBPicker}
                  onChange={(e) => setCompanyIBPicker(e.target.value)}
                  className="w-full text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md text-text-primary"
                >
                  <option value="">— None (auto-attach disabled regardless of toggle) —</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.user_id}>
                      {a.user_name} ({a.user_email}) · {a.referral_code}
                    </option>
                  ))}
                </select>
                <label className="flex items-start gap-2 text-xs text-text-secondary cursor-pointer mt-1 select-none">
                  <input
                    type="checkbox"
                    checked={companyIBAttach}
                    onChange={(e) => setCompanyIBAttach(e.target.checked)}
                    className="mt-0.5 rounded border-border-primary"
                  />
                  <span>
                    <strong>Auto-attach unreferred signups under the Super IB.</strong>
                    <br />
                    <span className="text-text-tertiary text-xxs">
                      ON = every new user who signs up without entering a referral code is parented
                      under the Super IB at signup. OFF = unreferred users have no IB (orphan).
                    </span>
                  </span>
                </label>
              </div>
              <div className="text-xxs text-text-tertiary space-y-1 min-w-[180px]">
                <div>
                  <div className="text-text-tertiary">Current</div>
                  <div className="text-text-primary font-mono text-xs truncate">
                    {companyIB?.user_email || '—'}
                  </div>
                </div>
                {companyIB?.referral_code && (
                  <div>
                    <div className="text-text-tertiary">Code</div>
                    <div className="text-text-primary font-mono text-xs">{companyIB.referral_code}</div>
                  </div>
                )}
                <div>
                  <div className="text-text-tertiary">Referrals on file</div>
                  <div className="text-text-primary font-mono text-xs">{companyIB?.referrals_count ?? 0}</div>
                </div>
              </div>
            </div>

            {companyIB?.referral_link && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <input
                  type="text"
                  readOnly
                  value={companyIB.referral_link}
                  className="flex-1 min-w-[280px] text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md font-mono text-text-secondary"
                />
                <button
                  type="button"
                  onClick={() => {
                    if (!companyIB.referral_link) return;
                    navigator.clipboard.writeText(companyIB.referral_link);
                    toast.success('Link copied');
                  }}
                  className="px-2 py-1.5 text-xs border border-border-primary rounded-md text-text-secondary hover:bg-bg-hover"
                >
                  Copy
                </button>
              </div>
            )}
          </div>
        )}

        <div className="bg-bg-secondary border border-border-primary rounded-md">
          <div className="flex gap-1 p-1 border-b border-border-primary">
            {([['applications', 'Applications'], ['active', 'Active IBs'], ['tree', 'IB Tree']] as const).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={cn(
                  'px-3 py-1.5 rounded-md text-xs font-medium transition-fast',
                  tab === id
                    ? 'bg-bg-hover text-text-primary border border-border-primary'
                    : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover/60',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="p-4">
            {loading && tab !== 'tree' ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 size={20} className="animate-spin text-text-tertiary" />
              </div>
            ) : tab === 'applications' ? (
              applications.length === 0 ? (
                <div className="text-center text-xs text-text-tertiary py-12">No pending applications</div>
              ) : (
                <div className="border border-border-primary rounded-md overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[800px]">
                      <thead>
                        <tr className="border-b border-border-primary bg-bg-tertiary/40">
                          {['Name', 'Email', 'Status', 'Applied', 'Actions'].map((col) => (
                            <th key={col} className={cn('text-left px-4 py-2.5 text-xxs font-medium text-text-tertiary uppercase tracking-wide', col === 'Actions' && 'text-right')}>
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {applications.map((app) => (
                          <tr key={app.id} className="border-b border-border-primary/50 transition-fast hover:bg-bg-hover">
                            <td className="px-4 py-2.5 text-xs text-text-primary">{app.user_name || '—'}</td>
                            <td className="px-4 py-2.5 text-xs text-text-secondary">{app.user_email}</td>
                            <td className="px-4 py-2.5"><span className="text-xxs px-1.5 py-0.5 rounded-sm bg-warning/15 text-warning font-medium">{app.status}</span></td>
                            <td className="px-4 py-2.5 text-xs text-text-tertiary">{app.created_at ? new Date(app.created_at).toLocaleDateString() : '—'}</td>
                            <td className="px-4 py-2.5 text-right">
                              <div className="flex items-center justify-end gap-2">
                                <button onClick={() => setApproveModal(app)} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xxs font-medium bg-success/15 text-success border border-success/30 hover:bg-success/25 transition-fast">
                                  <CheckCircle size={12} /> Approve
                                </button>
                                <button onClick={() => setRejectModal(app)} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xxs font-medium bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25 transition-fast">
                                  <XCircle size={12} /> Reject
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            ) : tab === 'active' ? (
              (() => {
                const filteredAgents = agents.filter((a) => roleFilter === 'all' || a.ib_type === roleFilter);
                return (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <RoleFilterBar value={roleFilter} onChange={setRoleFilter} />
                    <span className="text-xxs text-text-tertiary">{filteredAgents.length} IB{filteredAgents.length !== 1 ? 's' : ''}</span>
                  </div>
                  {filteredAgents.length === 0 ? (
                    <div className="text-center text-xs text-text-tertiary py-12">{agents.length === 0 ? 'No active IBs' : 'No IBs match this filter'}</div>
                  ) : (
                  <div className="border border-border-primary rounded-md overflow-hidden">
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[1020px]">
                        <thead>
                          <tr className="border-b border-border-primary bg-bg-tertiary/40">
                            {['Name', 'Referral Code', 'Role', 'Level', 'Referrals', 'Total Earned', 'Pending', 'Joined', 'Actions'].map((col) => (
                            <th key={col} className={cn('text-left px-4 py-2.5 text-xxs font-medium text-text-tertiary uppercase tracking-wide', ['Total Earned', 'Pending'].includes(col) && 'text-right', col === 'Actions' && 'text-right')}>
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {filteredAgents.map((agent) => (
                          <tr key={agent.id} className="border-b border-border-primary/50 transition-fast hover:bg-bg-hover">
                            <td className="px-4 py-2.5">
                              <div className="flex items-center gap-1.5">
                                <Users size={12} className="text-text-tertiary" />
                                <span className="text-xs text-text-primary">{agent.user_name}</span>
                              </div>
                              <p className="text-xxs text-text-tertiary mt-0.5">{agent.user_email}</p>
                            </td>
                            <td className="px-4 py-2.5 text-xs text-buy font-mono tabular-nums">
                              <button
                                type="button"
                                onClick={() => {
                                  const next = window.prompt(
                                    `Set custom referral code for ${agent.user_email}\n(3-20 chars, A-Z and 0-9 only)`,
                                    agent.referral_code,
                                  );
                                  if (!next || next.trim() === agent.referral_code) return;
                                  (async () => {
                                    try {
                                      await adminApi.put(
                                        `/business/ib/agents/${agent.id}/referral-code`,
                                        { code: next.trim() },
                                      );
                                      toast.success('Referral code updated');
                                      fetchData();
                                      loadCompanyIB();
                                    } catch (e: any) {
                                      toast.error(e?.message || 'Update failed');
                                    }
                                  })();
                                }}
                                title="Click to set a custom code (e.g. SDASIA)"
                                className="hover:underline cursor-pointer"
                              >
                                {agent.referral_code}
                              </button>
                            </td>
                            <td className="px-4 py-2.5"><RoleBadge type={agent.ib_type} /></td>
                            <td className="px-4 py-2.5 text-xs text-text-primary">L{agent.level}</td>
                            <td className="px-4 py-2.5 text-xs text-text-primary font-mono tabular-nums">{agent.referral_count}</td>
                            <td className="px-4 py-2.5 text-xs text-success text-right font-mono tabular-nums">${formatMoney(agent.total_earned)}</td>
                            <td className="px-4 py-2.5 text-xs text-warning text-right font-mono tabular-nums">${formatMoney(agent.pending_payout)}</td>
                            <td className="px-4 py-2.5 text-xs text-text-tertiary">{agent.created_at ? new Date(agent.created_at).toLocaleDateString() : '—'}</td>
                            <td className="px-4 py-2.5 text-right">
                              <div className="flex items-center justify-end gap-2">
                                <button
                                  onClick={() => { setEditCommissionModal(agent); setCommissionPlan(agent.commission_plan_id || 'default'); setCustomPerLot(agent.custom_commission_per_lot?.toString() || ''); setCustomPerTrade(agent.custom_commission_per_trade?.toString() || ''); setTierOverride(agent.tier_override || ''); }}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xxs font-medium bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 transition-fast"
                                >
                                  <Edit size={12} /> Edit
                                </button>
                                <button onClick={() => setRejectAgentModal(agent)} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xxs font-medium bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25 transition-fast">
                                  <XCircle size={12} /> Reject
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
                );
              })()
            ) : (
              /* ── IB Tree Tab ─────────────────────────────────────────── */
              <div className="space-y-4">
                {treeLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 size={20} className="animate-spin text-text-tertiary" />
                  </div>
                ) : (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {/* Left: IB Tree */}
                    <div className="border border-border-primary rounded-md overflow-hidden">
                      <div className="px-3 py-2 bg-bg-tertiary/40 border-b border-border-primary flex items-center gap-1.5">
                        <GitBranch size={13} className="text-text-tertiary" />
                        <span className="text-xs font-medium text-text-primary">IB Hierarchy</span>
                        <span className="ml-auto text-xxs text-text-tertiary">{ibTree.length} root IB{ibTree.length !== 1 ? 's' : ''}</span>
                      </div>
                      <div className="px-3 py-2 border-b border-border-primary">
                        <RoleFilterBar value={roleFilter} onChange={setRoleFilter} />
                      </div>
                      {(() => {
                        if (ibTree.length === 0) {
                          return <div className="text-center text-xs text-text-tertiary py-10">No IBs found</div>;
                        }
                        // Role filter active → flat list of matching nodes only
                        // (e.g. Sub-IB shows just the sub-IBs, no hierarchy).
                        if (roleFilter !== 'all') {
                          const flat = flattenTree(ibTree).filter((n) => n.ib_type === roleFilter);
                          return flat.length === 0 ? (
                            <div className="text-center text-xs text-text-tertiary py-10">No {roleLabel(roleFilter)}s found</div>
                          ) : (
                            <div className="max-h-[500px] overflow-y-auto">
                              {flat.map((node) => (
                                <IBTreeNodeRow
                                  key={node.id}
                                  node={{ ...node, children: [] }}
                                  depth={0}
                                  expanded={expandedNodes}
                                  onToggle={toggleNode}
                                  selected={selectedIB?.id}
                                  onSelect={selectIB}
                                  onTransfer={(userId, userName) => { setTransferModal({ userId, userName }); setTransferTargetIb(''); }}
                                />
                              ))}
                            </div>
                          );
                        }
                        // Default → full hierarchy.
                        return (
                          <div className="max-h-[500px] overflow-y-auto">
                            {ibTree.map((node) => (
                              <IBTreeNodeRow
                                key={node.id}
                                node={node}
                                depth={0}
                                expanded={expandedNodes}
                                onToggle={toggleNode}
                                selected={selectedIB?.id}
                                onSelect={selectIB}
                                onTransfer={(userId, userName) => { setTransferModal({ userId, userName }); setTransferTargetIb(''); }}
                              />
                            ))}
                          </div>
                        );
                      })()}
                    </div>

                    {/* Right: Selected IB Users */}
                    <div className="border border-border-primary rounded-md overflow-hidden">
                      {!selectedIB ? (
                        <div className="flex flex-col items-center justify-center py-16 text-center">
                          <GitBranch size={24} className="text-text-tertiary mb-2" />
                          <p className="text-xs text-text-tertiary">Click an IB on the left to view its users</p>
                        </div>
                      ) : (
                        <>
                          <div className="px-3 py-2 bg-bg-tertiary/40 border-b border-border-primary">
                            <div className="flex items-center justify-between">
                              <div>
                                <span className="text-xs font-medium text-text-primary">{selectedIB.name || selectedIB.email}</span>
                                <span className="ml-2 text-xxs text-text-tertiary font-mono">{selectedIB.referral_code}</span>
                              </div>
                              <div className="flex items-center gap-2 text-xxs text-text-tertiary">
                                <span>{selectedIB.referral_count} user{selectedIB.referral_count !== 1 ? 's' : ''}</span>
                                <span>{selectedIB.children.length} sub-IB{selectedIB.children.length !== 1 ? 's' : ''}</span>
                              </div>
                            </div>
                          </div>
                          {referralsLoading ? (
                            <div className="flex items-center justify-center py-8">
                              <Loader2 size={16} className="animate-spin text-text-tertiary" />
                            </div>
                          ) : ibReferrals.length === 0 ? (
                            <div className="text-center text-xs text-text-tertiary py-10">No users under this IB</div>
                          ) : (
                            <div className="max-h-[460px] overflow-y-auto">
                              {ibReferrals.map((u) => (
                                <div key={u.user_id} className="flex items-center justify-between px-3 py-2.5 border-b border-border-primary/50 hover:bg-bg-hover transition-fast">
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-1.5 min-w-0">
                                      <p className="text-xs text-text-primary truncate">{u.name || u.email}</p>
                                      {u.is_ib && (
                                        <button
                                          type="button"
                                          onClick={(e) => { e.stopPropagation(); drillIntoUser(u.user_id); }}
                                          title="View this IB's own users"
                                          className="shrink-0 inline-flex items-center gap-0.5 text-xxs px-1.5 py-0.5 rounded-sm bg-buy/10 text-buy border border-buy/20 hover:bg-buy/20 transition-fast"
                                        >
                                          {u.ib_type === 'super_ib' ? 'Super IB' : u.ib_type === 'sub_ib' ? 'Sub-IB' : 'IB'} <ChevronRight size={9} />
                                        </button>
                                      )}
                                    </div>
                                    <p className="text-xxs text-text-tertiary truncate">{u.email}</p>
                                    <p className="text-xxs text-text-tertiary mt-0.5">{u.trades} trade{u.trades !== 1 ? 's' : ''} · ${formatMoney(u.commission_generated)} comm.</p>
                                  </div>
                                  <button
                                    onClick={() => { setTransferModal({ userId: u.user_id, userName: u.name || u.email, currentIbId: selectedIB.id }); setTransferTargetIb(''); }}
                                    className="ml-2 shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-xxs font-medium bg-primary/10 text-primary border border-primary/25 hover:bg-primary/20 transition-fast"
                                  >
                                    <ArrowRightLeft size={11} /> Transfer
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )}

                {/* Unassigned Users Section */}
                <div className="border border-border-primary rounded-md overflow-hidden">
                  <div className="px-3 py-2 bg-bg-tertiary/40 border-b border-border-primary flex items-center gap-1.5">
                    <UserX size={13} className="text-text-tertiary" />
                    <span className="text-xs font-medium text-text-primary">Unassigned Users</span>
                    <span className="ml-auto text-xxs text-text-tertiary">{unassignedUsers.length} user{unassignedUsers.length !== 1 ? 's' : ''} not under any IB</span>
                  </div>
                  {unassignedLoading ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 size={16} className="animate-spin text-text-tertiary" />
                    </div>
                  ) : unassignedUsers.length === 0 ? (
                    <div className="text-center text-xs text-text-tertiary py-8">All users are assigned to an IB</div>
                  ) : (
                    <div className="overflow-x-auto max-h-[320px] overflow-y-auto">
                      <table className="w-full min-w-[600px]">
                        <thead className="sticky top-0 bg-bg-secondary">
                          <tr className="border-b border-border-primary">
                            {['Name', 'Email', 'Joined', 'Action'].map((col) => (
                              <th key={col} className={cn('text-left px-4 py-2 text-xxs font-medium text-text-tertiary uppercase tracking-wide', col === 'Action' && 'text-right')}>
                                {col}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {unassignedUsers.map((u) => (
                            <tr key={u.user_id} className="border-b border-border-primary/50 hover:bg-bg-hover transition-fast">
                              <td className="px-4 py-2.5 text-xs text-text-primary">{u.name || '—'}</td>
                              <td className="px-4 py-2.5 text-xs text-text-secondary">{u.email}</td>
                              <td className="px-4 py-2.5 text-xs text-text-tertiary">{u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}</td>
                              <td className="px-4 py-2.5 text-right">
                                <button
                                  onClick={() => { setTransferModal({ userId: u.user_id, userName: u.name || u.email }); setTransferTargetIb(''); }}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xxs font-medium bg-buy/10 text-buy border border-buy/25 hover:bg-buy/20 transition-fast"
                                >
                                  <ArrowRightLeft size={11} /> Assign to IB
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Approve Modal */}
      {approveModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setApproveModal(null)}>
          <div className="bg-bg-secondary border border-border-primary rounded-md shadow-modal w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-border-primary">
              <h3 className="text-sm font-semibold text-text-primary">Approve IB Application</h3>
              <p className="text-xxs text-text-tertiary mt-0.5">{approveModal.user_name} — {approveModal.user_email}</p>
            </div>
            <div className="px-5 py-4 space-y-3">
              <div>
                <label className="block text-xxs text-text-tertiary mb-1">Commission Plan</label>
                <select value={commissionPlan} onChange={(e) => setCommissionPlan(e.target.value)} className="w-full text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md">
                  <option value="default">Default</option>
                  <option value="custom">Custom</option>
                </select>
              </div>
              {commissionPlan === 'custom' && (
                <>
                  <div>
                    <label className="block text-xxs text-text-tertiary mb-1">Custom Rate Per Lot ($)</label>
                    <input type="number" step="0.01" value={customPerLot} onChange={(e) => setCustomPerLot(e.target.value)} placeholder="e.g. 5.00" className="w-full text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md" />
                  </div>
                  <div>
                    <label className="block text-xxs text-text-tertiary mb-1">Custom Rate Per Trade ($)</label>
                    <input type="number" step="0.01" value={customPerTrade} onChange={(e) => setCustomPerTrade(e.target.value)} placeholder="e.g. 2.00" className="w-full text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md" />
                  </div>
                </>
              )}
            </div>
            <div className="px-5 py-3 border-t border-border-primary flex justify-end gap-2">
              <button onClick={() => setApproveModal(null)} className="px-3 py-1.5 rounded-md text-xs text-text-secondary border border-border-primary hover:bg-bg-hover transition-fast">Cancel</button>
              <button onClick={handleApprove} disabled={submitting} className="px-3 py-1.5 rounded-md text-xs font-medium bg-success/15 text-success border border-success/30 hover:bg-success/25 transition-fast disabled:opacity-50">
                {submitting ? 'Approving...' : 'Approve'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reject Modal */}
      {rejectModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setRejectModal(null)}>
          <div className="bg-bg-secondary border border-border-primary rounded-md shadow-modal w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-border-primary">
              <h3 className="text-sm font-semibold text-text-primary">Reject IB Application</h3>
              <p className="text-xxs text-text-tertiary mt-0.5">{rejectModal.user_name} — {rejectModal.user_email}</p>
            </div>
            <div className="px-5 py-4 space-y-3">
              <div>
                <label className="block text-xxs text-text-tertiary mb-1">Rejection Reason</label>
                <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} rows={3} placeholder="Provide a reason for rejection..." className="w-full text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md resize-none" />
              </div>
            </div>
            <div className="px-5 py-3 border-t border-border-primary flex justify-end gap-2">
              <button onClick={() => setRejectModal(null)} className="px-3 py-1.5 rounded-md text-xs text-text-secondary border border-border-primary hover:bg-bg-hover transition-fast">Cancel</button>
              <button onClick={handleReject} disabled={submitting || !rejectReason.trim()} className="px-3 py-1.5 rounded-md text-xs font-medium bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25 transition-fast disabled:opacity-50">
                {submitting ? 'Rejecting...' : 'Reject'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Commission Modal */}
      {editCommissionModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setEditCommissionModal(null)}>
          <div className="bg-bg-secondary border border-border-primary rounded-md shadow-modal w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-border-primary">
              <h3 className="text-sm font-semibold text-text-primary">Edit IB Commission</h3>
              <p className="text-xxs text-text-tertiary mt-0.5">{editCommissionModal.user_name} — {editCommissionModal.user_email}</p>
            </div>
            <div className="px-5 py-4 space-y-3">
              <div>
                <label className="block text-xxs text-text-tertiary mb-1">Commission Plan</label>
                <select value={commissionPlan} onChange={(e) => setCommissionPlan(e.target.value)} className="w-full text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md">
                  <option value="default">Default Plan</option>
                  {commissionPlans.map((plan) => (
                    <option key={plan.id} value={plan.id}>{plan.name}</option>
                  ))}
                  <option value="custom">Custom Rates</option>
                </select>
              </div>
              <div>
                <label className="block text-xxs text-text-tertiary mb-1">Tier override</label>
                <select value={tierOverride} onChange={(e) => setTierOverride(e.target.value)} className="w-full text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md">
                  <option value="">Auto (by activations / deposits)</option>
                  <option value="Bronze">Bronze</option>
                  <option value="Silver">Silver</option>
                  <option value="Gold">Gold</option>
                  <option value="Platinum">Platinum</option>
                </select>
                <p className="text-[10px] text-text-tertiary mt-1">Forces this IB/sub-IB onto a fixed tier rate. A custom per-lot rate above still wins over this.</p>
              </div>
              {commissionPlan === 'custom' && (
                <>
                  <div>
                    <label className="block text-xxs text-text-tertiary mb-1">Custom Rate Per Lot ($)</label>
                    <input type="number" step="0.01" value={customPerLot} onChange={(e) => setCustomPerLot(e.target.value)} placeholder="e.g. 5.00" className="w-full text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md" />
                  </div>
                  <div>
                    <label className="block text-xxs text-text-tertiary mb-1">Custom Rate Per Trade ($)</label>
                    <input type="number" step="0.01" value={customPerTrade} onChange={(e) => setCustomPerTrade(e.target.value)} placeholder="e.g. 2.00" className="w-full text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md" />
                  </div>
                </>
              )}
            </div>
            <div className="px-5 py-3 border-t border-border-primary flex justify-end gap-2">
              <button onClick={() => setEditCommissionModal(null)} className="px-3 py-1.5 rounded-md text-xs text-text-secondary border border-border-primary hover:bg-bg-hover transition-fast">Cancel</button>
              <button onClick={handleEditCommission} disabled={submitting} className="px-3 py-1.5 rounded-md text-xs font-medium bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 transition-fast disabled:opacity-50">
                {submitting ? 'Updating...' : 'Update Commission'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reject Agent Modal */}
      {rejectAgentModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setRejectAgentModal(null)}>
          <div className="bg-bg-secondary border border-border-primary rounded-md shadow-modal w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-border-primary">
              <h3 className="text-sm font-semibold text-text-primary">Reject Active IB</h3>
              <p className="text-xxs text-text-tertiary mt-0.5">{rejectAgentModal.user_name} — {rejectAgentModal.user_email}</p>
            </div>
            <div className="px-5 py-4 space-y-3">
              <div>
                <label className="block text-xxs text-text-tertiary mb-1">Rejection Reason</label>
                <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} rows={3} placeholder="Provide a reason for rejecting this IB..." className="w-full text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md resize-none" />
              </div>
              <div className="bg-warning/10 border border-warning/30 rounded-md p-3">
                <p className="text-xxs text-warning">⚠️ This will deactivate the IB and change their role back to regular user.</p>
              </div>
            </div>
            <div className="px-5 py-3 border-t border-border-primary flex justify-end gap-2">
              <button onClick={() => setRejectAgentModal(null)} className="px-3 py-1.5 rounded-md text-xs text-text-secondary border border-border-primary hover:bg-bg-hover transition-fast">Cancel</button>
              <button onClick={handleRejectAgent} disabled={submitting || !rejectReason.trim()} className="px-3 py-1.5 rounded-md text-xs font-medium bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25 transition-fast disabled:opacity-50">
                {submitting ? 'Rejecting...' : 'Reject IB'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Commission Plans Modal */}
      {commissionPlansModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => { setCommissionPlansModal(false); setEditingPlan(null); }}>
          <div className="bg-bg-secondary border border-border-primary rounded-md shadow-modal w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-border-primary flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-text-primary">Commission Plans</h3>
                <p className="text-xxs text-text-tertiary mt-0.5">
                  {editingPlan ? (editingPlan === 'new' ? 'Create a new plan' : 'Edit plan details') : 'Default plan applies to all IBs unless overridden'}
                </p>
              </div>
              <button onClick={() => { setCommissionPlansModal(false); setEditingPlan(null); }} className="text-text-tertiary hover:text-text-primary">
                <XCircle size={16} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto">
              {!editingPlan ? (
                <div className="p-5 space-y-3">
                  {commissionPlans.length === 0 ? (
                    <div className="text-center py-8 text-xxs text-text-tertiary">
                      No plans yet. Create your first plan to start distributing commissions.
                    </div>
                  ) : (
                    commissionPlans.map((plan) => (
                      <div key={plan.id} className="border border-border-primary rounded-md p-3 flex items-center justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs font-semibold text-text-primary truncate">{plan.name}</span>
                            {plan.is_default && (
                              <span className="inline-flex items-center gap-0.5 text-xxs px-1.5 py-0.5 rounded-sm bg-buy/15 text-buy font-medium">
                                <Star size={10} /> Default
                              </span>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xxs text-text-tertiary">
                            <span>${plan.commission_per_lot}/lot</span>
                            <span>${plan.commission_per_trade}/trade</span>
                            <span className="font-mono">[{(plan.mlm_distribution || []).join(', ')}]</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button onClick={() => openPlanEditor(plan)} className="p-1.5 rounded text-primary hover:bg-primary/10" title="Edit">
                            <Edit size={13} />
                          </button>
                          {!plan.is_default && (
                            <button onClick={() => setDeletingPlanId(plan.id)} className="p-1.5 rounded text-danger hover:bg-danger/10" title="Delete">
                              <Trash2 size={13} />
                            </button>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                  <button onClick={() => openPlanEditor('new')} className="w-full mt-2 px-3 py-2 rounded-md text-xs font-medium bg-buy/15 text-buy border border-buy/30 hover:bg-buy/25 transition-fast inline-flex items-center justify-center gap-1.5">
                    <Plus size={14} /> New Plan
                  </button>
                </div>
              ) : (
                <div className="p-5 space-y-3">
                  <div>
                    <label className="block text-xxs text-text-tertiary mb-1">Plan Name</label>
                    <input
                      value={planForm.name}
                      onChange={(e) => setPlanForm({ ...planForm, name: e.target.value })}
                      placeholder="e.g. Standard Plan"
                      className="w-full text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md"
                    />
                  </div>
                  <label className="flex items-center gap-2 text-xs text-text-primary cursor-pointer">
                    <input
                      type="checkbox"
                      checked={planForm.is_default}
                      onChange={(e) => setPlanForm({ ...planForm, is_default: e.target.checked })}
                      className="rounded"
                    />
                    Set as default plan (applied to all new IBs)
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xxs text-text-tertiary mb-1">Commission per Lot ($)</label>
                      <input
                        type="number" step="0.01" min="0"
                        value={planForm.commission_per_lot}
                        onChange={(e) => setPlanForm({ ...planForm, commission_per_lot: e.target.value })}
                        placeholder="6.00"
                        className="w-full text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-xxs text-text-tertiary mb-1">Commission per Trade ($)</label>
                      <input
                        type="number" step="0.01" min="0"
                        value={planForm.commission_per_trade}
                        onChange={(e) => setPlanForm({ ...planForm, commission_per_trade: e.target.value })}
                        placeholder="0.00"
                        className="w-full text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md font-mono"
                      />
                    </div>
                  </div>

                  <div className="pt-2">
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-xxs text-text-tertiary uppercase tracking-wide">MLM Levels — % per level</label>
                      <button onClick={addLevel} disabled={planForm.mlm_distribution.length >= 20} className="text-xxs px-2 py-1 rounded bg-buy/15 text-buy border border-buy/30 hover:bg-buy/25 inline-flex items-center gap-1 disabled:opacity-50">
                        <Plus size={10} /> Add Level
                      </button>
                    </div>
                    <div className="space-y-1.5">
                      {planForm.mlm_distribution.map((pct, idx) => (
                        <div key={idx} className="flex items-center gap-2">
                          <span className="text-xxs text-text-tertiary w-12 shrink-0">L{idx + 1}</span>
                          <input
                            type="number" step="0.1" min="0" max="100"
                            value={pct}
                            onChange={(e) => updateLevelPct(idx, parseFloat(e.target.value) || 0)}
                            className="w-20 text-xs py-1 px-2 bg-bg-input border border-border-primary rounded-md font-mono tabular-nums"
                          />
                          <span className="text-xxs text-text-tertiary">%</span>
                          <div className="flex-1 h-1.5 bg-bg-tertiary rounded-full overflow-hidden">
                            <div className="h-full bg-buy rounded-full" style={{ width: `${Math.min(pct, 100)}%` }} />
                          </div>
                          <button
                            onClick={() => removeLevel(idx)}
                            disabled={planForm.mlm_distribution.length <= 1}
                            className="p-1 rounded text-danger hover:bg-danger/10 disabled:opacity-30 disabled:cursor-not-allowed"
                            title="Remove level"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                    {(() => {
                      const total = planForm.mlm_distribution.reduce((a, b) => a + (Number(b) || 0), 0);
                      const over = total > 100;
                      return (
                        <div className={cn('mt-2.5 p-2 rounded-md text-xxs flex items-center gap-1.5', over ? 'bg-danger/10 text-danger border border-danger/20' : 'bg-bg-tertiary text-text-secondary border border-border-primary')}>
                          {over && <AlertTriangle size={12} />}
                          <span className="font-mono">Total: {total.toFixed(1)}%</span>
                          {!over && <span className="ml-auto">Broker keeps {(100 - total).toFixed(1)}%</span>}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              )}
            </div>

            <div className="px-5 py-3 border-t border-border-primary flex justify-end gap-2">
              {editingPlan ? (
                <>
                  <button onClick={() => setEditingPlan(null)} className="px-3 py-1.5 rounded-md text-xs text-text-secondary border border-border-primary hover:bg-bg-hover">Back</button>
                  <button onClick={handleSavePlan} disabled={submitting} className="px-3 py-1.5 rounded-md text-xs font-medium bg-success/15 text-success border border-success/30 hover:bg-success/25 disabled:opacity-50">
                    {submitting ? 'Saving…' : (editingPlan === 'new' ? 'Create Plan' : 'Save')}
                  </button>
                </>
              ) : (
                <button onClick={() => { setCommissionPlansModal(false); }} className="px-3 py-1.5 rounded-md text-xs text-text-secondary border border-border-primary hover:bg-bg-hover">Close</button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Delete plan confirmation */}
      {deletingPlanId && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" onClick={() => setDeletingPlanId(null)}>
          <div className="bg-bg-secondary border border-border-primary rounded-md shadow-modal w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-border-primary">
              <h3 className="text-sm font-semibold text-text-primary">Delete Plan?</h3>
              <p className="text-xxs text-text-tertiary mt-0.5">
                IBs on this plan will fall back to the default plan.
              </p>
            </div>
            <div className="px-5 py-3 border-t border-border-primary flex justify-end gap-2">
              <button onClick={() => setDeletingPlanId(null)} className="px-3 py-1.5 rounded-md text-xs text-text-secondary border border-border-primary hover:bg-bg-hover">Cancel</button>
              <button onClick={() => handleDeletePlan(deletingPlanId)} disabled={submitting} className="px-3 py-1.5 rounded-md text-xs font-medium bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25 disabled:opacity-50">
                {submitting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Transfer / Assign User Modal */}
      {transferModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setTransferModal(null)}>
          <div className="bg-bg-secondary border border-border-primary rounded-md shadow-modal w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-border-primary">
              <h3 className="text-sm font-semibold text-text-primary">
                {transferModal.currentIbId ? 'Transfer User to Another IB' : 'Assign User to IB'}
              </h3>
              <p className="text-xxs text-text-tertiary mt-0.5">{transferModal.userName}</p>
            </div>
            <div className="px-5 py-4 space-y-3">
              <div>
                <label className="block text-xxs text-text-tertiary mb-1">Select Target IB</label>
                <select
                  value={transferTargetIb}
                  onChange={(e) => setTransferTargetIb(e.target.value)}
                  className="w-full text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md"
                >
                  <option value="">— Choose an IB —</option>
                  {allAgents
                    .filter((a) => a.id !== transferModal.currentIbId)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.user_name || a.user_email} ({a.referral_code}) · L{a.level}
                      </option>
                    ))}
                </select>
              </div>
              {transferTargetIb && (
                <div className="p-2.5 rounded-md bg-bg-tertiary/40 border border-border-primary text-xxs text-text-secondary">
                  User will be placed under <span className="font-medium text-text-primary">
                    {allAgents.find((a) => a.id === transferTargetIb)?.user_name || ''}
                  </span> ({allAgents.find((a) => a.id === transferTargetIb)?.referral_code})
                </div>
              )}
            </div>
            <div className="px-5 py-3 border-t border-border-primary flex justify-end gap-2">
              <button onClick={() => setTransferModal(null)} className="px-3 py-1.5 rounded-md text-xs text-text-secondary border border-border-primary hover:bg-bg-hover transition-fast">
                Cancel
              </button>
              <button
                onClick={handleTransferUser}
                disabled={submitting || !transferTargetIb}
                className="px-3 py-1.5 rounded-md text-xs font-medium bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 transition-fast disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                <ArrowRightLeft size={13} />
                {submitting ? 'Transferring…' : (transferModal.currentIbId ? 'Transfer' : 'Assign')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ── IBTreeNodeRow Component ─────────────────────────────────────── */
function IBTreeNodeRow({
  node,
  depth,
  expanded,
  onToggle,
  selected,
  onSelect,
  onTransfer,
}: {
  node: IBTreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  selected?: string;
  onSelect: (node: IBTreeNode) => void;
  onTransfer: (userId: string, userName: string) => void;
}) {
  const isExpanded = expanded.has(node.id);
  const isSelected = selected === node.id;
  const hasChildren = node.children && node.children.length > 0;

  return (
    <div>
      <div
        className={cn(
          'flex items-center gap-1 px-3 py-2 border-b border-border-primary/40 cursor-pointer transition-fast group',
          isSelected ? 'bg-primary/10 border-l-2 border-l-primary' : 'hover:bg-bg-hover',
        )}
        style={{ paddingLeft: `${12 + depth * 18}px` }}
        onClick={() => onSelect(node)}
      >
        {/* Expand/collapse toggle */}
        <button
          onClick={(e) => { e.stopPropagation(); if (hasChildren) onToggle(node.id); }}
          className={cn('shrink-0 p-0.5 rounded transition-fast', hasChildren ? 'text-text-tertiary hover:text-text-primary' : 'opacity-0 pointer-events-none')}
        >
          {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>

        <GitBranch size={12} className={cn('shrink-0', isSelected ? 'text-primary' : 'text-text-tertiary')} />

        <div className="flex-1 min-w-0">
          <p className={cn('text-xs truncate font-medium', isSelected ? 'text-primary' : 'text-text-primary')}>
            {node.name || node.email}
          </p>
          <p className="text-xxs text-text-tertiary truncate">{node.email}</p>
        </div>

        <div className="flex items-center gap-2 ml-2 shrink-0">
          <span className="text-xxs text-text-tertiary font-mono">{node.referral_code}</span>
          {/* ROLE by lineage (from backend ib_type): super_ib = ONLY the SDA05
              root, ib = directly under it, sub_ib = deeper. NOT by tree depth —
              that badged every root IB as "Super IB". (client 2026-07-09) */}
          <span className={cn(
            'text-xxs px-1.5 py-0.5 rounded-sm border',
            node.ib_type === 'super_ib'
              ? 'bg-primary/10 text-primary border-primary/25'
              : node.ib_type === 'sub_ib'
                ? 'bg-amber-500/10 text-amber-500 border-amber-500/25'
                : 'bg-bg-tertiary border-border-primary text-text-secondary',
          )}>
            {node.ib_type === 'super_ib' ? 'Super IB' : node.ib_type === 'sub_ib' ? `Sub-IB · L${node.level}` : 'IB'}
          </span>
          {node.referral_count > 0 && (
            <span className="text-xxs px-1.5 py-0.5 rounded-sm bg-primary/10 text-primary border border-primary/20">
              {node.referral_count} user{node.referral_count !== 1 ? 's' : ''}
            </span>
          )}
          {hasChildren && (
            <span className="text-xxs px-1.5 py-0.5 rounded-sm bg-buy/10 text-buy border border-buy/20">
              {node.children.length} below
            </span>
          )}
        </div>
      </div>

      {/* Children */}
      {isExpanded && hasChildren && (
        <div className="border-l border-border-primary/30 ml-6">
          {node.children.map((child) => (
            <IBTreeNodeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              selected={selected}
              onSelect={onSelect}
              onTransfer={onTransfer}
            />
          ))}
        </div>
      )}
    </div>
  );
}
