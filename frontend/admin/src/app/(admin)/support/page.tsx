'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { adminApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Loader2, RefreshCw, Send, ArrowLeft, MessageSquare, Lock } from 'lucide-react';
import toast from 'react-hot-toast';

interface Ticket {
  id: string;
  user_id: string;
  user_name: string;
  user_email: string;
  subject: string;
  category: string;
  priority: string;
  status: string;
  assigned_to?: string;
  assigned_name?: string;
  created_at: string;
  updated_at: string;
}

interface TicketMessage {
  id: string;
  sender_type: 'user' | 'admin';
  sender_name: string;
  message: string;
  is_internal_note: boolean;
  created_at: string;
}

interface Employee {
  id: string;
  user_id: string;
  full_name: string;
}

function priorityBadgeClass(p: string) {
  switch (p) {
    case 'high': case 'urgent': return 'bg-danger/15 text-danger';
    case 'medium': return 'bg-warning/15 text-warning';
    default: return 'bg-text-tertiary/15 text-text-tertiary';
  }
}

function statusBadgeClass(s: string) {
  switch (s) {
    case 'open': return 'bg-buy/15 text-buy';
    case 'in_progress': return 'bg-warning/15 text-warning';
    case 'resolved': case 'closed': return 'bg-success/15 text-success';
    default: return 'bg-text-tertiary/15 text-text-tertiary';
  }
}

export default function SupportPage() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('open');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [messages, setMessages] = useState<TicketMessage[]>([]);
  const [msgLoading, setMsgLoading] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [isInternal, setIsInternal] = useState(false);
  const [sending, setSending] = useState(false);
  const [employees, setEmployees] = useState<Employee[]>([]);

  const fetchTickets = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (statusFilter) params.status = statusFilter;
      if (priorityFilter) params.priority = priorityFilter;
      const res = await adminApi.get<{ items: Ticket[] }>('/support/tickets', params);
      setTickets(res.items || []);
    } catch (e: any) {
      toast.error(e.message || 'Failed to load tickets');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, priorityFilter]);

  useEffect(() => { fetchTickets(); }, [fetchTickets]);

  // Deep-link from the dashboard (/support?ticket=<id>) — auto-open that ticket
  // so the admin lands straight on the reply box (client 2026-06-26).
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (autoOpenedRef.current || tickets.length === 0 || typeof window === 'undefined') return;
    const id = new URLSearchParams(window.location.search).get('ticket');
    if (!id) return;
    autoOpenedRef.current = true;
    const t = tickets.find((x) => x.id === id) ?? ({ id } as Ticket);
    void openTicket(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickets]);

  useEffect(() => {
    adminApi.get<{ employees: Employee[] }>('/employees').then((r) => setEmployees(r.employees || [])).catch(() => {});
  }, []);

  const openTicket = async (ticket: Ticket) => {
    setSelectedTicket(ticket);
    setMsgLoading(true);
    try {
      const res = await adminApi.get<{ ticket: Ticket; messages: TicketMessage[] }>(`/support/tickets/${ticket.id}`);
      setMessages(res.messages || []);
    } catch (e: any) {
      toast.error(e.message || 'Failed to load messages');
    } finally {
      setMsgLoading(false);
    }
  };

  const handleReply = async () => {
    if (!selectedTicket || !replyText.trim()) return;
    setSending(true);
    try {
      await adminApi.post(`/support/tickets/${selectedTicket.id}/reply`, { message: replyText, is_internal_note: isInternal });
      toast.success(isInternal ? 'Internal note added' : 'Reply sent');
      setReplyText('');
      setIsInternal(false);
      openTicket(selectedTicket);
    } catch (e: any) {
      toast.error(e.message || 'Failed to send');
    } finally {
      setSending(false);
    }
  };

  const handleAssign = async (ticketId: string, adminId: string) => {
    try {
      await adminApi.put(`/support/tickets/${ticketId}/assign`, { admin_id: adminId });
      toast.success(adminId ? 'Ticket assigned' : 'Ticket unassigned');
      fetchTickets();
      // Reflect the change immediately in the open ticket (the dropdown binds
      // to selectedTicket.assigned_to) instead of waiting for a re-open.
      if (selectedTicket?.id === ticketId) {
        const emp = employees.find((e) => e.user_id === adminId);
        setSelectedTicket((prev) => prev ? {
          ...prev,
          assigned_to: adminId || undefined,
          assigned_name: emp?.full_name,
        } : null);
      }
    } catch (e: any) {
      toast.error(e.message || 'Failed to assign');
    }
  };

  const handleStatusChange = async (ticketId: string, status: string) => {
    try {
      await adminApi.put(`/support/tickets/${ticketId}/status`, { status });
      toast.success('Status updated');
      fetchTickets();
      if (selectedTicket?.id === ticketId) {
        setSelectedTicket((prev) => prev ? { ...prev, status } : null);
      }
    } catch (e: any) {
      toast.error(e.message || 'Failed to update status');
    }
  };

  return (
    <>
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-text-primary">Support Tickets</h1>
            <p className="text-xxs text-text-tertiary mt-0.5">Manage customer support requests</p>
          </div>
          <button onClick={fetchTickets} className="p-1.5 rounded-md border border-border-primary text-text-secondary hover:bg-bg-hover transition-fast">
            <RefreshCw size={14} />
          </button>
        </div>

        {selectedTicket ? (
          <div className="bg-bg-secondary border border-border-primary rounded-md">
            <div className="px-4 py-3 border-b border-border-primary flex items-center gap-3">
              <button onClick={() => setSelectedTicket(null)} className="p-1 rounded-md text-text-secondary hover:bg-bg-hover transition-fast">
                <ArrowLeft size={14} />
              </button>
              <div className="flex-1 min-w-0">
                <h2 className="text-sm font-medium text-text-primary truncate">{selectedTicket.subject}</h2>
                <p className="text-xxs text-text-tertiary">{selectedTicket.user_name} — {selectedTicket.user_email}</p>
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={selectedTicket.status}
                  onChange={(e) => handleStatusChange(selectedTicket.id, e.target.value)}
                  className="text-xxs py-1 px-2 bg-bg-input border border-border-primary rounded-md"
                >
                  <option value="open">Open</option>
                  <option value="in_progress">In Progress</option>
                  <option value="resolved">Resolved</option>
                  <option value="closed">Closed</option>
                </select>
                <select
                  value={selectedTicket.assigned_to || ''}
                  onChange={(e) => handleAssign(selectedTicket.id, e.target.value)}
                  className="text-xxs py-1 px-2 bg-bg-input border border-border-primary rounded-md"
                >
                  <option value="">Unassigned</option>
                  {employees.map((emp) => (
                    // assigned_to is a FK to users.id, so send the employee's
                    // USER id, not the employees-table PK (was causing a 500).
                    <option key={emp.id} value={emp.user_id}>{emp.full_name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="p-4 max-h-[400px] overflow-y-auto space-y-3">
              {msgLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 size={16} className="animate-spin text-text-tertiary" />
                </div>
              ) : messages.length === 0 ? (
                <div className="text-center text-xs text-text-tertiary py-8">No messages</div>
              ) : (
                messages.map((msg) => (
                  <div key={msg.id} className={cn('p-3 rounded-md border max-w-[80%]', msg.is_internal_note ? 'bg-warning/5 border-warning/20 ml-auto' : msg.sender_type === 'admin' ? 'bg-buy/5 border-buy/20 ml-auto' : 'bg-bg-tertiary border-border-primary')}>
                    <div className="flex items-center gap-2 mb-1">
                      {msg.is_internal_note && <Lock size={10} className="text-warning" />}
                      <span className={cn('text-xxs font-medium', msg.sender_type === 'admin' ? 'text-buy' : 'text-text-primary')}>{msg.sender_name}</span>
                      <span className="text-xxs text-text-tertiary font-mono tabular-nums">{msg.created_at}</span>
                      {msg.is_internal_note && <span className="text-xxs text-warning">(Internal)</span>}
                    </div>
                    <p className="text-xs text-text-secondary whitespace-pre-wrap">{msg.message}</p>
                    {Array.isArray((msg as { attachments?: { name?: string; type?: string; data?: string }[] }).attachments) && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {((msg as { attachments?: { name?: string; type?: string; data?: string }[] }).attachments || []).map((a, i) => (
                          a?.data ? (
                            (a.type || '').startsWith('image/') ? (
                              <a key={i} href={a.data} target="_blank" rel="noreferrer" title={a.name}>
                                <img src={a.data} alt={a.name || 'attachment'} className="max-h-32 rounded border border-border-primary" />
                              </a>
                            ) : (
                              <a key={i} href={a.data} download={a.name || 'attachment'} className="text-xxs text-buy underline">{a.name || 'Download attachment'}</a>
                            )
                          ) : null
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>

            <div className="p-4 border-t border-border-primary space-y-2">
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={isInternal} onChange={(e) => setIsInternal(e.target.checked)} className="w-3 h-3 accent-warning" />
                  <span className="text-xxs text-text-secondary">Internal note</span>
                </label>
              </div>
              <div className="flex gap-2">
                <textarea
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  rows={2}
                  placeholder={isInternal ? 'Add internal note...' : 'Type your reply...'}
                  className="flex-1 text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md resize-none"
                />
                <button
                  onClick={handleReply}
                  disabled={sending || !replyText.trim()}
                  className="self-end px-3 py-1.5 rounded-md text-xs font-medium bg-buy/15 text-buy border border-buy/30 hover:bg-buy/25 transition-fast disabled:opacity-50"
                >
                  <Send size={14} />
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="bg-bg-secondary border border-border-primary rounded-md p-4">
              <div className="flex flex-wrap gap-3">
                <div>
                  <label className="block text-xxs text-text-tertiary mb-1">Status</label>
                  <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md min-w-[140px]">
                    <option value="">All</option>
                    <option value="open">Open</option>
                    <option value="in_progress">In Progress</option>
                    <option value="resolved">Resolved</option>
                    <option value="closed">Closed</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xxs text-text-tertiary mb-1">Priority</label>
                  <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)} className="text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md min-w-[140px]">
                    <option value="">All</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="urgent">Urgent</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="bg-bg-secondary border border-border-primary rounded-md overflow-hidden">
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 size={20} className="animate-spin text-text-tertiary" />
                </div>
              ) : tickets.length === 0 ? (
                <div className="text-center text-xs text-text-tertiary py-12">No tickets found</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1000px]">
                    <thead>
                      <tr className="border-b border-border-primary bg-bg-tertiary/40">
                        {['ID', 'User', 'Subject', 'Category', 'Priority', 'Status', 'Assigned', 'Date'].map((col) => (
                          <th key={col} className="text-left px-4 py-2.5 text-xxs font-medium text-text-tertiary uppercase tracking-wide">
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {tickets.map((t) => (
                        <tr
                          key={t.id}
                          onClick={() => openTicket(t)}
                          className="border-b border-border-primary/50 transition-fast hover:bg-bg-hover cursor-pointer"
                        >
                          <td className="px-4 py-2.5 text-xs text-text-secondary font-mono tabular-nums">{t.id}</td>
                          <td className="px-4 py-2.5">
                            <p className="text-xs text-text-primary">{t.user_name}</p>
                            <p className="text-xxs text-text-tertiary">{t.user_email}</p>
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-1.5">
                              <MessageSquare size={12} className="text-text-tertiary shrink-0" />
                              <span className="text-xs text-text-primary truncate max-w-[200px]">{t.subject}</span>
                            </div>
                          </td>
                          <td className="px-4 py-2.5 text-xs text-text-secondary">{t.category}</td>
                          <td className="px-4 py-2.5">
                            <span className={cn('inline-flex px-1.5 py-0.5 rounded-sm text-xxs font-medium', priorityBadgeClass(t.priority))}>{t.priority}</span>
                          </td>
                          <td className="px-4 py-2.5">
                            <span className={cn('inline-flex px-1.5 py-0.5 rounded-sm text-xxs font-medium', statusBadgeClass(t.status))}>{t.status}</span>
                          </td>
                          <td className="px-4 py-2.5 text-xs text-text-secondary">{t.assigned_name || '—'}</td>
                          <td className="px-4 py-2.5 text-xs text-text-tertiary font-mono tabular-nums">{t.created_at}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
