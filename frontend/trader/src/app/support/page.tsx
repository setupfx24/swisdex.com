'use client';



import { useState, useEffect, useCallback } from 'react';

import { clsx } from 'clsx';

import toast from 'react-hot-toast';

import { Button } from '@/components/ui/Button';

import DashboardShell from '@/components/layout/DashboardShell';

import api from '@/lib/api/client';

import { Mail, MessageCircle } from 'lucide-react';

// Quick-contact channels rendered above the ticket list. Both gated on env
// vars so we never ship a broken mailto:/ or wa.me/ link — leave either
// empty in .env and that button hides.
const SUPPORT_EMAIL = (process.env.NEXT_PUBLIC_SUPPORT_EMAIL || '').trim();
const SUPPORT_WHATSAPP = (process.env.NEXT_PUBLIC_SUPPORT_WHATSAPP || '').trim();



interface Message {

  id: string;

  message: string;

  is_admin: boolean;

  created_at: string;

}



interface Ticket {

  id: string;

  subject: string;

  status: string;

  priority: string;

  message_count: number;

  created_at: string;

  messages?: Message[];

}



interface TicketDetail {

  id: string;

  subject: string;

  status: string;

  messages: Message[];

}



export default function SupportPage() {

  const [tickets, setTickets] = useState<Ticket[]>([]);

  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);

  const [ticketDetail, setTicketDetail] = useState<TicketDetail | null>(null);

  const [showNewTicket, setShowNewTicket] = useState(false);

  const [reply, setReply] = useState('');

  const [newSubject, setNewSubject] = useState('');

  const [newCategory, setNewCategory] = useState('Trading');

  const [newDescription, setNewDescription] = useState('');

  const [newFile, setNewFile] = useState<File | null>(null);

  const [loading, setLoading] = useState(true);

  const [detailLoading, setDetailLoading] = useState(false);

  const [sending, setSending] = useState(false);

  const [creating, setCreating] = useState(false);

  const [error, setError] = useState<string | null>(null);



  const fetchTickets = useCallback(async () => {

    try {

      setLoading(true);

      setError(null);

      const res = await api.get<{ items: Ticket[] }>('/support/tickets');

      const items = res.items ?? [];

      setTickets(items);

      if (items.length > 0 && !selectedTicketId) {

        setSelectedTicketId(items[0].id);

      }

    } catch (err: unknown) {

      const msg = err instanceof Error ? err.message : 'Failed to load tickets';

      setError(msg);

    } finally {

      setLoading(false);

    }

  }, [selectedTicketId]);



  const fetchTicketDetail = useCallback(async (id: string) => {

    try {

      setDetailLoading(true);

      const detail = await api.get<TicketDetail>(`/support/tickets/${id}`);

      setTicketDetail(detail);

    } catch (err: unknown) {

      toast.error(err instanceof Error ? err.message : 'Failed to load ticket');

    } finally {

      setDetailLoading(false);

    }

  }, []);



  useEffect(() => { fetchTickets(); }, [fetchTickets]);



  useEffect(() => {

    if (selectedTicketId) {

      fetchTicketDetail(selectedTicketId);

    } else {

      setTicketDetail(null);

    }

  }, [selectedTicketId, fetchTicketDetail]);



  const statusStyles = (s: string) => {

    const lower = s?.toLowerCase();

    if (lower === 'open') return 'bg-buy/15 text-buy';

    if (lower === 'in_progress' || lower === 'in progress') return 'bg-warning/15 text-warning';

    if (lower === 'resolved' || lower === 'closed') return 'bg-success/15 text-success';

    return 'bg-bg-hover text-text-secondary';

  };



  const handleSendReply = async () => {

    if (!reply.trim() || !selectedTicketId) return;

    try {

      setSending(true);

      await api.post(`/support/tickets/${selectedTicketId}/reply`, { message: reply });

      toast.success('Reply sent!');

      setReply('');

      fetchTicketDetail(selectedTicketId);

    } catch (err: unknown) {

      toast.error(err instanceof Error ? err.message : 'Failed to send reply');

    } finally {

      setSending(false);

    }

  };



  const handleCreateTicket = async () => {

    if (!newSubject.trim() || !newDescription.trim()) {

      toast.error('Please fill in all fields');

      return;

    }

    try {

      setCreating(true);

      // Optional attachment — sent inline as a base64 data URL in `attachments`
      // (backend already accepts the list). Capped at 3MB (client 2026-06-25).
      let attachments: { name: string; type: string; data: string }[] | undefined;
      if (newFile) {
        if (newFile.size > 3 * 1024 * 1024) {
          toast.error('Attachment too large (max 3MB).');
          setCreating(false);
          return;
        }
        const data = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.onerror = () => reject(new Error('read failed'));
          r.readAsDataURL(newFile);
        });
        attachments = [{ name: newFile.name, type: newFile.type, data }];
      }

      const res = await api.post<{ id: string }>('/support/tickets', {

        subject: newSubject,

        category: newCategory,

        message: newDescription,

        ...(attachments ? { attachments } : {}),

      });

      toast.success('Support ticket created!');

      setShowNewTicket(false);

      setNewSubject('');

      setNewDescription('');

      setNewCategory('Trading');

      setNewFile(null);

      await fetchTickets();

      if (res.id) setSelectedTicketId(res.id);

    } catch (err: unknown) {

      toast.error(err instanceof Error ? err.message : 'Failed to create ticket');

    } finally {

      setCreating(false);

    }

  };



  if (loading) {

    return (

      <DashboardShell mainClassName="flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 py-12">
          <div className="w-8 h-8 border-2 border-[#55a630] border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-[#888]">Loading support...</span>
        </div>
      </DashboardShell>

    );

  }



  return (

    <DashboardShell mainClassName="flex flex-col min-h-0 overflow-hidden p-0">

      {/* New Ticket Modal */}

      {showNewTicket && (

        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">

          <div className="absolute inset-0 bg-black/60" onClick={() => setShowNewTicket(false)} />

          <div className="relative w-full max-w-md max-h-[min(90vh,640px)] overflow-y-auto glass-card rounded-xl border border-border-glass shadow-2xl">

            <div className="flex items-center justify-between px-4 py-3 border-b border-border-glass">

              <h3 className="text-md font-semibold text-text-primary">New Support Ticket</h3>

              <button

                onClick={() => setShowNewTicket(false)}

                className="p-1 text-text-tertiary hover:text-text-primary transition-all rounded-md hover:bg-bg-hover"

              >

                ✕

              </button>

            </div>

            <div className="p-4 space-y-4">

              <div>

                <label className="text-xs text-text-secondary block mb-1.5 font-medium">Subject</label>

                <input

                  type="text"

                  value={newSubject}

                  onChange={(e) => setNewSubject(e.target.value)}

                  placeholder="Brief description of your issue"

                  className="skeu-input w-full text-text-primary rounded-xl py-3 px-4 text-sm"

                />

              </div>

              <div>

                <label className="text-xs text-text-secondary block mb-1.5 font-medium">Category</label>

                <select

                  value={newCategory}

                  onChange={(e) => setNewCategory(e.target.value)}

                  className="skeu-input w-full text-text-primary rounded-xl py-3 px-4 text-sm bg-bg-secondary"

                >

                  <option>Trading</option>

                  <option>Deposit</option>

                  <option>Withdrawal</option>

                  <option>Account</option>

                  <option>Technical</option>

                  <option>Other</option>

                </select>

              </div>

              <div>

                <label className="text-xs text-text-secondary block mb-1.5 font-medium">Description</label>

                <textarea

                  value={newDescription}

                  onChange={(e) => setNewDescription(e.target.value)}

                  placeholder="Describe your issue in detail..."

                  className="skeu-input w-full text-text-primary rounded-xl py-3 px-4 text-sm h-24 resize-none"

                />

              </div>

              <div>
                <label className="text-xs text-text-secondary block mb-1.5 font-medium">Attachment <span className="text-text-tertiary">(optional, max 3MB)</span></label>
                <input
                  type="file"
                  accept="image/*,application/pdf"
                  onChange={(e) => setNewFile(e.target.files?.[0] ?? null)}
                  className="w-full text-xs text-text-secondary file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-bg-hover file:text-text-primary file:cursor-pointer"
                />
                {newFile && <p className="text-[10px] text-text-tertiary mt-1 truncate">{newFile.name}</p>}
              </div>

              <div className="flex justify-end gap-2">

                <Button variant="ghost" onClick={() => setShowNewTicket(false)}>Cancel</Button>

                <Button variant="primary" onClick={handleCreateTicket} loading={creating}>Submit Ticket</Button>

              </div>

            </div>

          </div>

        </div>

      )}



      {error && !tickets.length ? (

        <div className="flex-1 flex items-center justify-center">

          <div className="text-center space-y-3">

            <p className="text-sell text-sm">{error}</p>

            <Button variant="outline" size="sm" onClick={fetchTickets}>Retry</Button>

          </div>

        </div>

      ) : (

        <div className="flex flex-col lg:flex-row flex-1 min-h-0 overflow-hidden">

          {/* Ticket List */}

          <div className="w-full lg:w-80 lg:max-w-[20rem] flex-shrink-0 glass-panel border-b lg:border-b-0 lg:border-r border-border-glass flex flex-col min-h-0 max-h-[min(42vh,20rem)] lg:max-h-none">

            <div className="p-3 border-b border-border-glass flex items-center justify-between gap-2">

              <span className="text-md font-semibold text-text-primary">Support</span>

              <button

                type="button"

                onClick={() => setShowNewTicket(true)}

                className="min-h-[40px] min-w-[40px] flex items-center justify-center text-text-tertiary hover:text-buy transition-all rounded-md hover:bg-bg-hover"

              >

                <span className="text-xl leading-none">+</span>

              </button>

            </div>

            {(SUPPORT_EMAIL || SUPPORT_WHATSAPP) && (

              <div className="px-3 py-2 border-b border-border-glass flex items-center gap-2">

                {SUPPORT_EMAIL && (

                  <a

                    href={`mailto:${SUPPORT_EMAIL}`}

                    className="flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md border border-[#55a630]/25 bg-[#55a630]/5 hover:bg-[#55a630]/10 transition-colors text-xs font-medium text-text-primary"

                    title={`Email ${SUPPORT_EMAIL}`}

                  >

                    <Mail size={13} className="text-[#55a630]" />

                    Email

                  </a>

                )}

                {SUPPORT_WHATSAPP && (

                  <a

                    href={`https://wa.me/${SUPPORT_WHATSAPP.replace(/[^\d]/g, '')}`}

                    target="_blank"

                    rel="noopener noreferrer"

                    className="flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md border border-[#25D366]/30 bg-[#25D366]/5 hover:bg-[#25D366]/10 transition-colors text-xs font-medium text-text-primary"

                    title="Chat on WhatsApp"

                  >

                    <MessageCircle size={13} className="text-[#25D366]" />

                    WhatsApp

                  </a>

                )}

              </div>

            )}

            <div className="flex-1 overflow-y-auto">

              {tickets.length === 0 ? (

                <div className="p-4 text-center text-sm text-text-tertiary">

                  <p className="mb-3">No tickets yet</p>

                  <Button variant="primary" size="sm" onClick={() => setShowNewTicket(true)}>

                    Create Ticket

                  </Button>

                </div>

              ) : (

                tickets.map((t) => (

                  <button

                    key={t.id}

                    onClick={() => setSelectedTicketId(t.id)}

                    className={clsx(

                      'w-full text-left px-3 py-3 border-b border-border-glass/50 transition-all',

                      selectedTicketId === t.id ? 'bg-buy/5 border-l-2 border-l-buy' : 'hover:bg-bg-hover/50',

                    )}

                  >

                    <div className="flex items-center justify-between mb-1">

                      <span className="text-sm font-medium text-text-primary truncate pr-2">{t.subject}</span>

                      <span className={clsx(

                        'inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded-sm flex-shrink-0',

                        statusStyles(t.status),

                      )}>

                        {t.status?.replace('_', ' ')}

                      </span>

                    </div>

                    <div className="flex items-center justify-between">

                      <span className="text-[10px] text-text-tertiary">

                        {t.message_count ?? 0} messages • {t.priority ?? 'normal'}

                      </span>

                      <span className="text-[10px] text-text-tertiary">

                        {new Date(t.created_at).toLocaleDateString()}

                      </span>

                    </div>

                  </button>

                ))

              )}

            </div>

          </div>



          {/* Conversation */}

          <div className="flex-1 flex flex-col min-w-0 min-h-[min(55vh,28rem)] lg:min-h-0">

            {detailLoading ? (

              <div className="flex-1 flex items-center justify-center">

                <div className="w-6 h-6 border-2 border-buy border-t-transparent rounded-full animate-spin" />

              </div>

            ) : ticketDetail ? (

              <>

                {/* Ticket Header */}

                <div className="px-4 py-3 border-b border-border-glass glass-panel">

                  <div className="flex items-center justify-between">

                    <div>

                      <h3 className="text-sm font-semibold text-text-primary">{ticketDetail.subject}</h3>

                      <div className="flex items-center gap-2 mt-0.5">

                        <span className="text-[10px] text-text-tertiary">#{ticketDetail.id}</span>

                        <span className={clsx(

                          'inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded-sm',

                          statusStyles(ticketDetail.status),

                        )}>

                          {ticketDetail.status?.replace('_', ' ')}

                        </span>

                      </div>

                    </div>

                  </div>

                </div>



                {/* Messages */}

                <div className="flex-1 p-4 overflow-y-auto space-y-4">

                  {(ticketDetail.messages ?? []).map((msg) => (

                    <div

                      key={msg.id}

                      className={clsx(

                        'max-w-[80%]',

                        !msg.is_admin ? 'ml-auto' : 'mr-auto',

                      )}

                    >

                      <div className={clsx(

                        'rounded-xl p-3 text-sm',

                        !msg.is_admin

                          ? 'bg-buy/15 text-text-primary rounded-br-sm'

                          : 'glass-card text-text-primary rounded-bl-sm',

                      )}>

                        {msg.message}

                      </div>

                      <div className={clsx(

                        'text-[10px] text-text-tertiary mt-1',

                        !msg.is_admin ? 'text-right' : 'text-left',

                      )}>

                        {msg.is_admin && <span className="text-buy mr-1">Support</span>}

                        {new Date(msg.created_at).toLocaleString()}

                      </div>

                    </div>

                  ))}

                </div>



                {/* Reply Input */}

                {ticketDetail.status?.toLowerCase() !== 'resolved' && ticketDetail.status?.toLowerCase() !== 'closed' && (

                  <div className="p-3 border-t border-border-glass glass-panel flex gap-2 items-end">

                    <textarea

                      value={reply}

                      onChange={(e) => setReply(e.target.value)}

                      onKeyDown={(e) => {

                        if (e.key === 'Enter' && !e.shiftKey && !sending) {

                          e.preventDefault();

                          handleSendReply();

                        }

                      }}

                      placeholder="Type a reply... (Shift+Enter for new line)"

                      rows={3}

                      className="skeu-input flex-1 text-text-primary rounded-xl py-2.5 px-4 text-sm resize-none"

                    />

                    <Button variant="primary" size="md" onClick={handleSendReply} loading={sending}>

                      Send →

                    </Button>

                  </div>

                )}

              </>

            ) : (

              <div className="flex-1 flex flex-col items-center justify-center text-text-tertiary text-sm">

                <div className="text-4xl mb-3 opacity-30">💬</div>

                <p>Select a ticket or create a new one</p>

              </div>

            )}

          </div>

        </div>

      )}

    </DashboardShell>

  );

}

