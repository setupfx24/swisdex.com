'use client';

import { useEffect, useState, useCallback } from 'react';
import { adminApi } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { cn } from '@/lib/utils';
import { Loader2, Plus, Pencil, Trash2, RefreshCw, UserCog, Activity, LogIn, ShieldCheck, Copy, Check, KeyRound } from 'lucide-react';
import toast from 'react-hot-toast';

interface Employee {
  id: string;
  user_id: string;
  email: string;
  full_name: string;
  role: string;
  phone?: string;
  is_active: boolean;
  deleted?: boolean;
  last_active?: string;
  created_at: string;
  extra_permissions?: string[];
}

interface PermissionCatalog {
  catalog: Record<string, string[]>;
  role_defaults: Record<string, string[]>;
}

interface ActivityLog {
  id: string;
  action: string;
  details: string;
  ip_address?: string;
  created_at: string;
}

const EMPTY_FORM = { email: '', full_name: '', role: 'support', phone: '', password: '' };

export default function EmployeesPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [submitting, setSubmitting] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [activityModal, setActivityModal] = useState<Employee | null>(null);
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  // Super-admin-defined custom roles, shown in the role dropdown.
  const [customRoles, setCustomRoles] = useState<{ id: string; name: string }[]>([]);

  // Permissions modal state
  const [permModal, setPermModal] = useState<Employee | null>(null);
  const [permCatalog, setPermCatalog] = useState<PermissionCatalog | null>(null);
  const [permSelected, setPermSelected] = useState<Set<string>>(new Set());
  const [permLoading, setPermLoading] = useState(false);
  const [permSaving, setPermSaving] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [res, roles] = await Promise.all([
        adminApi.get<{ employees: Employee[] }>('/employees'),
        adminApi.get<{ items: { id: string; name: string }[] }>('/employees/roles').catch(() => ({ items: [] })),
      ]);
      setEmployees(res.employees || []);
      setCustomRoles(roles?.items || []);
    } catch (e: any) {
      toast.error(e.message || 'Failed to load employees');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const openCreate = () => {
    setEditId(null);
    setForm({ ...EMPTY_FORM });
    setShowModal(true);
  };

  const openEdit = (emp: Employee) => {
    setEditId(emp.id);
    setForm({ email: emp.email, full_name: emp.full_name, role: emp.role, phone: emp.phone || '', password: '' });
    setShowModal(true);
  };

  const openPermissions = async (emp: Employee) => {
    setPermModal(emp);
    setPermLoading(true);
    try {
      const [cat, current] = await Promise.all([
        adminApi.get<PermissionCatalog>('/employees/permissions/catalog'),
        adminApi.get<{ extra_permissions: string[] }>(`/employees/${emp.id}/permissions`),
      ]);
      setPermCatalog(cat);
      setPermSelected(new Set(current.extra_permissions || []));
    } catch (e: any) {
      toast.error(e.message || 'Failed to load permissions');
      setPermModal(null);
    } finally {
      setPermLoading(false);
    }
  };

  const togglePerm = (p: string) => {
    setPermSelected(prev => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });
  };

  const savePermissions = async () => {
    if (!permModal) return;
    setPermSaving(true);
    try {
      await adminApi.put(`/employees/${permModal.id}/permissions`, {
        extra_permissions: Array.from(permSelected),
      });
      toast.success('Permissions updated');
      setPermModal(null);
      fetchData();
    } catch (e: any) {
      toast.error(e.message || 'Failed to save permissions');
    } finally {
      setPermSaving(false);
    }
  };

  const openActivity = async (emp: Employee) => {
    setActivityModal(emp);
    setActivityLoading(true);
    try {
      const res = await adminApi.get<{ logs: ActivityLog[] }>(`/employees/${emp.id}/activity`);
      setActivityLogs(res.logs || []);
    } catch (e: any) {
      toast.error(e.message || 'Failed to load activity');
    } finally {
      setActivityLoading(false);
    }
  };

  const handleSubmit = async () => {
    if (!form.full_name.trim()) { toast.error('Name is required'); return; }
    if (!editId && !form.email.trim()) { toast.error('Email is required'); return; }
    setSubmitting(true);
    try {
      if (editId) {
        await adminApi.put(`/employees/${editId}`, { full_name: form.full_name, role: form.role });
        toast.success('Employee updated');
      } else {
        const body: any = { email: form.email, full_name: form.full_name, role: form.role };
        if (form.phone) body.phone = form.phone;
        if (form.password) body.password = form.password;
        const res = await adminApi.post<{ password?: string }>('/employees', body);
        const pwd = res.password || form.password;
        toast.success(`Employee created!`, { duration: 8000 });
        if (pwd) {
          setTimeout(() => {
            alert(`Employee Login Credentials:\n\nEmail: ${form.email}\nPassword: ${pwd}\nRole: ${form.role}\n\nAdmin Login: ${window.location.origin}/login`);
          }, 500);
        }
      }
      setShowModal(false);
      fetchData();
    } catch (e: any) {
      toast.error(e.message || 'Failed to save');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await adminApi.delete(`/employees/${id}`);
      toast.success('Employee deleted');
      setDeleteConfirm(null);
      fetchData();
    } catch (e: any) {
      toast.error(e.message || 'Failed to delete');
    }
  };

  const toggleActive = async (emp: Employee) => {
    try {
      await adminApi.put(`/employees/${emp.id}`, { is_active: !emp.is_active });
      toast.success(emp.is_active ? 'Employee deactivated' : 'Employee activated');
      fetchData();
    } catch (e: any) {
      toast.error(e.message || 'Failed to update');
    }
  };

  const updateForm = (key: string, val: string) => setForm((f) => ({ ...f, [key]: val }));

  function roleBadgeClass(role: string) {
    switch (role) {
      case 'super_admin': return 'bg-danger/15 text-danger';
      case 'trade_manager': return 'bg-accent/15 text-accent';
      case 'finance': return 'bg-warning/15 text-warning';
      case 'deposit_manager': return 'bg-warning/15 text-warning';
      case 'withdrawal_manager': return 'bg-warning/15 text-warning';
      case 'rm': return 'bg-accent/15 text-accent';
      case 'risk_manager': return 'bg-sell/15 text-sell';
      case 'marketing': return 'bg-success/15 text-success';
      case 'support': return 'bg-buy/15 text-buy';
      default: return 'bg-text-tertiary/15 text-text-tertiary';
    }
  }

  const loginUrl = typeof window !== 'undefined' ? `${window.location.origin}/login` : '/login';
  const [copied, setCopied] = useState(false);
  const copyLoginLink = async () => {
    try {
      await navigator.clipboard.writeText(loginUrl);
      setCopied(true);
      toast.success('Login link copied');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy — please copy manually');
    }
  };

  return (
    <>
      <div className="p-6 space-y-4">
        {/* Shareable login link — admin copies it to hand to new employees */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 rounded-md border border-border-primary bg-bg-secondary px-3 py-2">
          <div className="flex items-center gap-2 shrink-0">
            <LogIn size={14} className="text-buy" />
            <span className="text-xs font-medium text-text-primary">Employee login link</span>
          </div>
          <input
            readOnly
            value={loginUrl}
            onFocus={(e) => e.currentTarget.select()}
            className="flex-1 min-w-0 text-xxs font-mono bg-bg-input border border-border-primary rounded px-2 py-1 text-text-secondary"
          />
          <button
            type="button"
            onClick={copyLoginLink}
            className="shrink-0 inline-flex items-center gap-1 px-3 py-1 rounded-md text-xxs font-semibold border transition-fast bg-buy/10 border-buy/30 text-buy hover:bg-buy/20"
            title="Copy login link"
          >
            {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
          </button>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-text-primary">Employee Management</h1>
            <p className="text-xxs text-text-tertiary mt-0.5">Manage admin employees, roles, and activity</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={openCreate} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-buy/15 text-buy border border-buy/30 hover:bg-buy/25 transition-fast">
              <Plus size={14} /> Add Employee
            </button>
            <button onClick={fetchData} className="p-1.5 rounded-md border border-border-primary text-text-secondary hover:bg-bg-hover transition-fast">
              <RefreshCw size={14} />
            </button>
          </div>
        </div>

        <div className="bg-bg-secondary border border-border-primary rounded-md overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={20} className="animate-spin text-text-tertiary" />
            </div>
          ) : employees.length === 0 ? (
            <div className="text-center text-xs text-text-tertiary py-12">No employees found</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px]">
                <thead>
                  <tr className="border-b border-border-primary bg-bg-tertiary/40">
                    {['Name', 'Email', 'Role', 'Status', 'Last Active', 'Actions'].map((col) => (
                      <th key={col} className={cn('text-left px-4 py-2.5 text-xxs font-medium text-text-tertiary uppercase tracking-wide', col === 'Actions' && 'text-right')}>
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {employees.map((emp) => (
                    <tr key={emp.id} className="border-b border-border-primary/50 transition-fast hover:bg-bg-hover">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <UserCog size={12} className="text-text-tertiary" />
                          <span className="text-xs text-text-primary">{emp.full_name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-text-secondary">{emp.email}</td>
                      <td className="px-4 py-2.5">
                        <span className={cn('inline-flex px-1.5 py-0.5 rounded-sm text-xxs font-medium', roleBadgeClass(emp.role))}>{emp.role}</span>
                      </td>
                      <td className="px-4 py-2.5">
                        {emp.deleted ? (
                          <span className="inline-flex px-1.5 py-0.5 rounded-sm text-xxs font-medium bg-danger/15 text-danger" title="This employee was deleted; their record is kept for history.">
                            Deleted
                          </span>
                        ) : (
                          <button onClick={() => toggleActive(emp)} className={cn('inline-flex px-1.5 py-0.5 rounded-sm text-xxs font-medium cursor-pointer transition-fast', emp.is_active ? 'bg-success/15 text-success hover:bg-success/25' : 'bg-text-tertiary/15 text-text-tertiary hover:bg-text-tertiary/25')}>
                            {emp.is_active ? 'Active' : 'Inactive'}
                          </button>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-text-tertiary font-mono tabular-nums">{emp.last_active || '—'}</td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button onClick={async () => {
                            try {
                              // Backend sets the swisdex_admin httpOnly cookie on the response;
                              // hard-reload makes the next page boot with the impersonated session.
                              const res = await adminApi.post<{ access_token: string; employee_email: string; employee_role: string }>(`/employees/${emp.id}/login-as`);
                              toast.success(`Logging in as ${res.employee_email} (${res.employee_role})`);
                              if (typeof window !== 'undefined') {
                                useAuthStore.setState({ admin: null, isAuthenticated: false });
                                setTimeout(() => {
                                  window.location.replace('/dashboard');
                                }, 300);
                              }
                            } catch (e: any) { toast.error(e.message || 'Failed to login as employee'); }
                          }} className="px-2 py-1 rounded-md text-xxs font-medium text-buy border border-buy/30 hover:bg-buy/15 transition-fast" title="Login As Employee">
                            <LogIn size={11} className="inline mr-0.5" />Login
                          </button>
                          <button onClick={() => openPermissions(emp)} className="p-1 rounded-md text-accent border border-accent/30 hover:bg-accent/10 transition-fast" title="Permissions">
                            <ShieldCheck size={12} />
                          </button>
                          <button onClick={() => openActivity(emp)} className="p-1 rounded-md text-text-secondary border border-border-primary hover:bg-bg-hover transition-fast" title="Activity Log">
                            <Activity size={12} />
                          </button>
                          <button onClick={() => openEdit(emp)} className="p-1 rounded-md text-text-secondary border border-border-primary hover:bg-bg-hover transition-fast" title="Edit">
                            <Pencil size={12} />
                          </button>
                          <button
                            onClick={async () => {
                              const pwd = window.prompt(`Set a new password for ${emp.full_name || emp.email}\n(leave blank to auto-generate a strong one):`, '');
                              if (pwd === null) return;
                              try {
                                const res = await adminApi.post<{ password?: string }>(`/users/${emp.user_id}/set-password`, { password: pwd || undefined });
                                window.alert(`New password for ${emp.email}:\n\n${res.password || pwd}\n\nHand this to the employee. Their existing sessions are now logged out.`);
                              } catch (e: any) { toast.error(e?.message || 'Failed to set password'); }
                            }}
                            className="p-1 rounded-md text-warning border border-warning/30 hover:bg-warning/15 transition-fast"
                            title="Set Password"
                          >
                            <KeyRound size={12} />
                          </button>
                          <button onClick={() => setDeleteConfirm(emp.id)} className="p-1 rounded-md text-danger border border-danger/30 hover:bg-danger/15 transition-fast" title="Delete">
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {showModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setShowModal(false)}>
          <div className="bg-bg-secondary border border-border-primary rounded-md shadow-modal w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-border-primary">
              <h3 className="text-sm font-semibold text-text-primary">{editId ? 'Edit Employee' : 'Add Employee'}</h3>
            </div>
            <div className="px-5 py-4 space-y-3">
              {!editId && (
                <>
                  <div>
                    <label className="block text-xxs text-text-tertiary mb-1">Email</label>
                    <input type="email" value={form.email} onChange={(e) => updateForm('email', e.target.value)} className="w-full text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md" placeholder="employee@company.com" />
                  </div>
                  <div>
                    <label className="block text-xxs text-text-tertiary mb-1">Password</label>
                    <input type="text" value={form.password} onChange={(e) => updateForm('password', e.target.value)} className="w-full text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md font-mono" placeholder="Leave empty for auto-generated" />
                    <p className="text-xxs text-text-tertiary mt-0.5">If empty, a secure password will be auto-generated</p>
                  </div>
                </>
              )}
              <div>
                <label className="block text-xxs text-text-tertiary mb-1">Full Name</label>
                <input value={form.full_name} onChange={(e) => updateForm('full_name', e.target.value)} className="w-full text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md" placeholder="John Doe" />
              </div>
              <div>
                <label className="block text-xxs text-text-tertiary mb-1">Role</label>
                <select value={form.role} onChange={(e) => updateForm('role', e.target.value)} className="w-full text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md">
                  <option value="support">Support</option>
                  <option value="trade_manager">Trade Manager</option>
                  <option value="finance">Finance (deposits + withdrawals)</option>
                  <option value="deposit_manager">Deposit Manager</option>
                  <option value="withdrawal_manager">Withdrawal Manager</option>
                  <option value="risk_manager">Risk Manager</option>
                  <option value="marketing">Marketing</option>
                  <option value="rm">Relationship Manager (RM)</option>
                  <option value="super_admin">Super Admin</option>
                  {customRoles.length > 0 && (
                    <optgroup label="Custom roles">
                      {customRoles.map((r) => <option key={r.id} value={r.name}>{r.name}</option>)}
                    </optgroup>
                  )}
                </select>
              </div>
              {!editId && (
                <div>
                  <label className="block text-xxs text-text-tertiary mb-1">Phone (optional)</label>
                  <input value={form.phone} onChange={(e) => updateForm('phone', e.target.value)} className="w-full text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md" placeholder="+1 555 0100" />
                </div>
              )}
            </div>
            <div className="px-5 py-3 border-t border-border-primary flex justify-end gap-2">
              <button onClick={() => setShowModal(false)} className="px-3 py-1.5 rounded-md text-xs text-text-secondary border border-border-primary hover:bg-bg-hover transition-fast">Cancel</button>
              <button onClick={handleSubmit} disabled={submitting} className="px-3 py-1.5 rounded-md text-xs font-medium bg-buy/15 text-buy border border-buy/30 hover:bg-buy/25 transition-fast disabled:opacity-50">
                {submitting ? 'Saving...' : editId ? 'Update' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirm && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setDeleteConfirm(null)}>
          <div className="bg-bg-secondary border border-border-primary rounded-md shadow-modal w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-border-primary">
              <h3 className="text-sm font-semibold text-text-primary">Delete Employee</h3>
            </div>
            <div className="px-5 py-4">
              <p className="text-xs text-text-secondary">Are you sure you want to <span className="text-danger font-semibold">permanently delete</span> this employee? They will be removed from the employee list and lose all admin access. This cannot be undone.</p>
              <p className="text-xxs text-text-tertiary mt-2">Tip: to only temporarily disable them, use the <span className="font-medium">Active/Inactive</span> toggle instead.</p>
            </div>
            <div className="px-5 py-3 border-t border-border-primary flex justify-end gap-2">
              <button onClick={() => setDeleteConfirm(null)} className="px-3 py-1.5 rounded-md text-xs text-text-secondary border border-border-primary hover:bg-bg-hover transition-fast">Cancel</button>
              <button onClick={() => handleDelete(deleteConfirm)} className="px-3 py-1.5 rounded-md text-xs font-medium bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25 transition-fast">Delete Permanently</button>
            </div>
          </div>
        </div>
      )}

      {permModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => !permSaving && setPermModal(null)}>
          <div className="bg-bg-secondary border border-border-primary rounded-md shadow-modal w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-border-primary flex items-center gap-2">
              <ShieldCheck size={14} className="text-accent" />
              <div>
                <h3 className="text-sm font-semibold text-text-primary">Permissions — {permModal.full_name}</h3>
                <p className="text-xxs text-text-tertiary mt-0.5">
                  Role <span className="font-mono text-text-secondary">{permModal.role}</span> already grants its default permissions. Check extra sections this employee should also see.
                </p>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {permLoading || !permCatalog ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 size={18} className="animate-spin text-text-tertiary" />
                </div>
              ) : (
                <div className="space-y-4">
                  {Object.entries(permCatalog.catalog).map(([group, perms]) => {
                    const roleDefaults = new Set(permCatalog.role_defaults[permModal.role] || []);
                    const allStar = roleDefaults.has('*');
                    return (
                      <div key={group} className="border border-border-primary rounded-md">
                        <div className="px-3 py-2 bg-bg-tertiary/40 border-b border-border-primary">
                          <h4 className="text-xxs font-semibold text-text-primary uppercase tracking-wide">{group}</h4>
                        </div>
                        <div className="px-3 py-2 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                          {perms.map((p) => {
                            const fromRole = allStar || roleDefaults.has(p);
                            const checked = fromRole || permSelected.has(p);
                            return (
                              <label key={p} className={cn('flex items-center gap-2 px-2 py-1 rounded text-xxs cursor-pointer transition-fast', fromRole ? 'text-text-tertiary bg-bg-hover/30' : 'text-text-primary hover:bg-bg-hover')}>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={fromRole}
                                  onChange={() => togglePerm(p)}
                                  className="w-3.5 h-3.5 accent-accent"
                                />
                                <span className="font-mono">{p}</span>
                                {fromRole && <span className="ml-auto text-[9px] uppercase text-success font-bold">role</span>}
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="px-5 py-3 border-t border-border-primary flex justify-end gap-2">
              <button onClick={() => setPermModal(null)} disabled={permSaving} className="px-3 py-1.5 rounded-md text-xs text-text-secondary border border-border-primary hover:bg-bg-hover transition-fast">Cancel</button>
              <button onClick={savePermissions} disabled={permSaving || permLoading} className="px-3 py-1.5 rounded-md text-xs font-medium bg-accent/15 text-accent border border-accent/30 hover:bg-accent/25 transition-fast disabled:opacity-50">
                {permSaving ? 'Saving…' : 'Save Permissions'}
              </button>
            </div>
          </div>
        </div>
      )}

      {activityModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setActivityModal(null)}>
          <div className="bg-bg-secondary border border-border-primary rounded-md shadow-modal w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-border-primary">
              <h3 className="text-sm font-semibold text-text-primary">Activity Log</h3>
              <p className="text-xxs text-text-tertiary mt-0.5">{activityModal.full_name}</p>
            </div>
            <div className="max-h-[400px] overflow-y-auto">
              {activityLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 size={16} className="animate-spin text-text-tertiary" />
                </div>
              ) : activityLogs.length === 0 ? (
                <div className="text-center text-xs text-text-tertiary py-8">No activity logs</div>
              ) : (
                <div className="divide-y divide-border-primary/50">
                  {activityLogs.map((log) => (
                    <div key={log.id} className="px-5 py-3">
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-xs text-text-primary font-medium">{log.action}</span>
                        <span className="text-xxs text-text-tertiary font-mono tabular-nums">{log.created_at}</span>
                      </div>
                      <p className="text-xxs text-text-secondary">{log.details}</p>
                      {log.ip_address && <p className="text-xxs text-text-tertiary mt-0.5 font-mono">{log.ip_address}</p>}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="px-5 py-3 border-t border-border-primary flex justify-end">
              <button onClick={() => setActivityModal(null)} className="px-3 py-1.5 rounded-md text-xs text-text-secondary border border-border-primary hover:bg-bg-hover transition-fast">Close</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
