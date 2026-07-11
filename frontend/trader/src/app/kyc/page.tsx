'use client';

import { useState, useEffect, useCallback } from 'react';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import DashboardShell from '@/components/layout/DashboardShell';
import api from '@/lib/api/client';
import {
  ShieldCheck,
  Clock,
  CheckCircle2,
  XCircle,
  Upload,
  FileText,
  ChevronDown,
  FileImage,
  Camera,
  MapPin,
  X,
} from 'lucide-react';

interface KycDocument {
  id: string;
  document_type: string;
  status: string;
  rejection_reason: string | null;
  created_at: string;
}

interface Profile {
  kyc_status: string;
  kyc_documents: KycDocument[];
  country?: string;
  address?: string | null;
}

const DOC_TYPES = [
  { value: 'passport', label: 'Passport' },
  { value: 'national_id', label: 'National ID' },
  { value: 'driving_license', label: 'Driving License' },
  { value: 'id_front', label: 'ID Front' },
  { value: 'id_back', label: 'ID Back' },
  { value: 'proof_of_address', label: 'Proof of Address' },
  { value: 'selfie', label: 'Selfie with ID' },
  { value: 'bank_statement', label: 'Bank Statement' },
  { value: 'other', label: 'Other' },
] as const;

/** Backend: new users `pending`; after upload `submitted`; admin sets `approved` / `rejected`. */
function normalizeKycStatus(raw: string) {
  return (raw || '').toLowerCase().trim();
}

function StatusBadge({ status, kind = 'user' }: { status: string; kind?: 'user' | 'document' }) {
  const s = normalizeKycStatus(status);
  if (s === 'pending' && kind === 'document') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/25 text-amber-400 text-[10px] font-semibold">
        <Clock size={10} strokeWidth={2.5} />
        Pending
      </span>
    );
  }
  if (s === 'verified' || s === 'approved') {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-accent/10 border border-accent/25 text-accent text-xs font-semibold">
        <CheckCircle2 size={11} strokeWidth={2.5} />
        Approved
      </span>
    );
  }
  if (s === 'submitted' || s === 'under_review') {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/25 text-amber-400 text-xs font-semibold">
        <Clock size={11} strokeWidth={2.5} />
        Under Review
      </span>
    );
  }
  if (s === 'rejected' || s === 'failed') {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-red-500/10 border border-red-500/25 text-red-400 text-xs font-semibold">
        <XCircle size={11} strokeWidth={2.5} />
        Rejected
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs font-semibold">
      <Clock size={11} strokeWidth={2.5} />
      Not Started
    </span>
  );
}

/**
 * Phone KYC kept failing (client 2026-06-20): mobile camera photos are often
 * 5–12 MB and tripped the 10 MB cap / magic-byte check on the server. Re-encode
 * any picked image to a resized JPEG client-side so it's a clean, small,
 * server-accepted file. PDFs and undecodable files pass through unchanged.
 */
async function prepareKycFile(file: File | null): Promise<File | null> {
  if (!file) return null;
  if (!file.type.startsWith('image/')) return file; // PDF etc. — leave as-is
  try {
    const bitmap = await createImageBitmap(file);
    const maxDim = 2000;
    let { width, height } = bitmap;
    if (Math.max(width, height) > maxDim) {
      const scale = maxDim / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob: Blob | null = await new Promise((res) =>
      canvas.toBlob((b) => res(b), 'image/jpeg', 0.85),
    );
    if (!blob || blob.size === 0) return file;
    const base = (file.name.replace(/\.[^.]+$/, '') || 'kyc').slice(0, 60);
    return new File([blob], `${base}.jpg`, { type: 'image/jpeg' });
  } catch {
    return file; // browser couldn't decode (rare) — send the original
  }
}

export default function KycPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [showFormModal, setShowFormModal] = useState(false);

  const [docType, setDocType] = useState('passport');
  const [file, setFile] = useState<File | null>(null);
  const [docType2, setDocType2] = useState('proof_of_address');
  const [file2, setFile2] = useState<File | null>(null);
  const [file3, setFile3] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const fetchProfile = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api.get<Profile>('/profile');
      setProfile(data);
    } catch {
      toast.error('Failed to load KYC status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchProfile();
  }, [fetchProfile]);

  const kycStatus = normalizeKycStatus(profile?.kyc_status ?? '');
  const isVerified = kycStatus === 'verified' || kycStatus === 'approved';
  const isReview = kycStatus === 'submitted' || kycStatus === 'under_review';
  const isRejected = kycStatus === 'rejected' || kycStatus === 'failed';
  const isNotStarted = !isVerified && !isReview && !isRejected;
  const canSubmit = !isVerified && !isReview;

  const openForm = () => {
    setFile(null);
    setFile2(null);
    setFile3(null);
    setShowFormModal(true);
  };

  const handleSubmit = async () => {
    if (!file) {
      toast.error('Please upload your government ID');
      return;
    }
    if (!file2) {
      toast.error('Please upload your proof of address');
      return;
    }
    if (!file3) {
      toast.error('Please upload a selfie with your ID');
      return;
    }
    const fd = new FormData();
    fd.append('document_type', docType);
    fd.append('file', file);
    fd.append('document_type_2', docType2);
    fd.append('file_2', file2);
    fd.append('document_type_3', 'selfie');
    fd.append('file_3', file3);

    setSubmitting(true);
    try {
      const token = api.getToken();
      const res = await fetch('/api/v1/profile/kyc/submit/', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      const raw = await res.text();
      let json: { detail?: unknown } = {};
      try {
        json = raw ? JSON.parse(raw) : {};
      } catch {
        /* ignore */
      }
      if (!res.ok) {
        const d = json.detail;
        throw new Error(
          typeof d === 'string'
            ? d
            : Array.isArray(d)
              ? d.map((x: { msg?: string }) => x.msg).join(', ')
              : `Submit failed (${res.status})`,
        );
      }
      toast.success('KYC submitted — our team will review within 1–2 business days');
      setShowFormModal(false);
      void fetchProfile();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Submission failed');
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls =
    'w-full bg-bg-input border border-border-primary rounded-xl px-4 py-3 text-text-primary text-sm outline-none focus:border-accent/50 transition-colors placeholder:text-text-tertiary';
  const selectCls = `${inputCls} appearance-none cursor-pointer`;

  if (loading) {
    return (
      <DashboardShell mainClassName="p-0 flex flex-col min-h-0 overflow-hidden">
        <div className="flex flex-1 items-center justify-center py-20">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-text-secondary">Loading…</span>
          </div>
        </div>
      </DashboardShell>
    );
  }

  return (
    <DashboardShell mainClassName="p-0 flex flex-col min-h-0 overflow-hidden">
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        <div className="w-full max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-4 sm:py-6 pb-24 space-y-5 sm:space-y-6">
          <section className="relative overflow-hidden rounded-xl border border-border-primary bg-card">
            <div
              className="pointer-events-none absolute inset-0 bg-gradient-to-br from-accent/[0.12] via-transparent to-accent/[0.05]"
              aria-hidden
            />
            <div className="relative z-10 px-4 sm:px-6 py-5 sm:py-7">
              <h1 className="text-xl sm:text-2xl font-bold text-text-primary tracking-tight">KYC Verification</h1>
              <p className="text-sm text-text-secondary mt-1 max-w-2xl">
                Complete identity verification to unlock deposits, withdrawals, and live trading — same secure styling as
                the rest of SwisDex.
              </p>
            </div>
          </section>

        {/* Approved — full success state */}
        {isVerified && (
          <div className="rounded-xl border border-border-primary bg-card overflow-hidden ring-1 ring-accent/15">
            <div className="p-8 md:p-10 text-center space-y-5">
              <div className="w-20 h-20 rounded-full bg-accent/15 border border-accent/30 flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-10 h-10 text-accent" strokeWidth={2} />
              </div>
              <div>
                <StatusBadge status={profile?.kyc_status ?? 'approved'} />
                <h2 className="text-xl font-bold text-text-primary mt-4">Identity verified</h2>
                <p className="text-sm text-text-secondary mt-2 max-w-md mx-auto leading-relaxed">
                  Your account is fully verified. You can deposit, withdraw, and use all live trading features.
                </p>
              </div>
            </div>
            {(profile?.kyc_documents?.length ?? 0) > 0 && (
              <div className="border-t border-border-primary bg-card-nested px-5 py-4">
                <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-3">
                  Submitted documents
                </p>
                <ul className="space-y-2">
                  {profile!.kyc_documents.map((doc) => (
                    <li
                      key={doc.id}
                      className="flex items-center justify-between gap-3 text-sm text-text-primary py-2 border-b border-border-primary/80 last:border-0"
                    >
                      <span className="capitalize">{doc.document_type.replace(/_/g, ' ')}</span>
                      <StatusBadge status={doc.status} kind="document" />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Main flow: not yet approved */}
        {!isVerified && (
          <>
            <div className="rounded-xl border border-border-primary bg-card overflow-hidden shadow-[0_0_0_1px_rgba(0,0,0,0.2)]">
              <div className="p-5 md:p-6 border-b border-border-primary flex flex-wrap items-start gap-4">
                <div className="w-11 h-11 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
                  <ShieldCheck size={22} className="text-accent" strokeWidth={2} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-base font-bold text-text-primary">Identity Verification</p>
                  <p className="text-xs text-text-secondary mt-0.5">
                    Secure KYC — upload government ID, selfie, and proof of address
                  </p>
                </div>
                <div className="shrink-0 w-full sm:w-auto flex justify-start sm:justify-end">
                  <StatusBadge status={profile?.kyc_status ?? ''} />
                </div>
              </div>

              {isReview && (
                <div className="p-6 md:p-8 space-y-4">
                  <div className="w-full bg-bg-secondary rounded-full h-1.5 overflow-hidden border border-border-primary/80">
                    <div
                      className="bg-accent h-full rounded-full animate-pulse opacity-90"
                      style={{ width: '60%' }}
                    />
                  </div>
                  <p className="text-sm text-text-secondary leading-relaxed">
                    Your documents are under review. This usually takes <span className="text-text-primary font-medium">24–48 hours</span>.
                    We&apos;ll notify you when the decision is ready.
                  </p>
                </div>
              )}

              {isRejected && profile?.kyc_documents?.some((d) => d.rejection_reason) && (
                <div className="px-5 py-4 border-t border-border-primary bg-red-500/5">
                  <p className="text-xs font-semibold text-red-400 mb-1">Rejection reason</p>
                  {profile.kyc_documents
                    .filter((d) => d.rejection_reason)
                    .map((d) => (
                      <p key={d.id} className="text-sm text-text-secondary">
                        {d.rejection_reason}
                      </p>
                    ))}
                </div>
              )}

              {(isNotStarted || isRejected) && (
                <div className="p-8 md:p-10 text-center space-y-5">
                  <div className="w-[4.5rem] h-[4.5rem] rounded-2xl bg-accent/10 border border-accent/25 flex items-center justify-center mx-auto">
                    <FileImage size={32} className="text-accent" strokeWidth={1.75} />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold text-text-primary">Start Verification</h2>
                    <p className="text-sm text-text-secondary mt-2 max-w-sm mx-auto leading-relaxed">
                      Complete a quick identity verification to unlock deposits, withdrawals, and live trading features.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={openForm}
                    className="inline-flex items-center justify-center gap-2 w-full sm:w-auto min-w-[240px] px-8 py-3.5 rounded-xl text-sm font-bold border-2 border-accent bg-accent text-black hover:brightness-110 transition-all shadow-[0_0_24px_rgba(85,166,48,0.35)]"
                  >
                    <ShieldCheck size={18} strokeWidth={2.5} />
                    {isRejected ? 'Re-submit KYC' : 'Start KYC Verification'}
                  </button>
                </div>
              )}
            </div>

            {/* Info sections — only before review / same as reference */}
            {(isNotStarted || isRejected) && (
              <>
                <div className="rounded-xl border border-border-primary bg-card p-5 md:p-6">
                  <h3 className="text-sm font-bold text-text-primary mb-5">What You&apos;ll Need</h3>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                    {[
                      {
                        num: '1',
                        title: 'Government ID',
                        desc: "Passport, driver's license, or national ID card",
                        Icon: FileText,
                      },
                      {
                        num: '2',
                        title: 'Selfie Photo',
                        desc: 'Take a live photo for identity matching',
                        Icon: Camera,
                      },
                      {
                        num: '3',
                        title: 'Proof of Address',
                        desc: 'Utility bill or bank statement (last 3 months)',
                        Icon: MapPin,
                      },
                    ].map(({ num, title, desc, Icon }) => (
                      <div key={num} className="text-center md:text-left">
                        <div className="w-9 h-9 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center mx-auto md:mx-0 mb-3 text-accent text-sm font-bold">
                          {num}
                        </div>
                        <div className="flex md:block items-start gap-3 justify-center md:justify-start">
                          <Icon size={18} className="text-accent shrink-0 md:hidden" />
                          <div>
                            <p className="text-sm font-semibold text-text-primary">{title}</p>
                            <p className="text-xs text-text-secondary mt-1 leading-relaxed">{desc}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-xl border border-border-primary bg-card p-5 md:p-6">
                  <h3 className="text-sm font-bold text-text-primary mb-4">Why Verify?</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {[
                      'Access live trading accounts',
                      'Deposit and withdraw funds',
                      'Higher transaction limits',
                      'Join affiliate program',
                    ].map((item) => (
                      <div
                        key={item}
                        className="flex items-center gap-3 p-3.5 rounded-xl bg-card-nested border border-border-primary"
                      >
                        <div className="w-8 h-8 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
                          <CheckCircle2 size={16} className="text-accent" strokeWidth={2.5} />
                        </div>
                        <span className="text-sm text-text-primary font-medium leading-snug">{item}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {(profile?.kyc_documents?.length ?? 0) > 0 && !isVerified && (
              <div className="rounded-xl border border-border-primary bg-card overflow-hidden">
                <div className="px-5 py-3.5 border-b border-border-primary">
                  <h3 className="text-sm font-bold text-text-primary">Submitted Documents</h3>
                </div>
                <ul className="divide-y divide-border-primary">
                  {profile!.kyc_documents.map((doc) => (
                    <li key={doc.id} className="px-5 py-3.5 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <FileText size={14} className="text-accent/70 shrink-0" />
                        <span className="text-sm text-text-primary capitalize truncate">
                          {doc.document_type.replace(/_/g, ' ')}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <StatusBadge status={doc.status} kind="document" />
                        <span className="text-[11px] text-text-tertiary">
                          {new Date(doc.created_at).toLocaleDateString()}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
        </div>
      </div>

      {/* Modal: submit form */}
      {showFormModal && canSubmit && (
        <div
          className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="kyc-modal-title"
        >
          <button
            type="button"
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            aria-label="Close"
            onClick={() => !submitting && setShowFormModal(false)}
          />
          <div className="relative w-full sm:max-w-lg max-h-[92dvh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-border-primary bg-card shadow-2xl sidebar-scroll">
            <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-5 py-4 border-b border-border-primary bg-card">
              <h3 id="kyc-modal-title" className="text-base font-bold text-text-primary">
                {isRejected ? 'Re-submit documents' : 'Submit documents'}
              </h3>
              <button
                type="button"
                onClick={() => !submitting && setShowFormModal(false)}
                className="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>

            <div className="p-5 space-y-5">
              <div className="space-y-2">
                <label className="text-xs text-text-secondary uppercase tracking-wide font-semibold">
                  Primary document *
                </label>
                <div className="relative">
                  <select
                    value={docType}
                    onChange={(e) => setDocType(e.target.value)}
                    className={selectCls}
                  >
                    {DOC_TYPES.slice(0, 6).map((d) => (
                      <option key={d.value} value={d.value} className="bg-card">
                        {d.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    size={14}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none"
                  />
                </div>
                <label
                  className={clsx(
                    'flex items-center justify-center gap-2 w-full min-h-[5.5rem] rounded-xl border-2 border-dashed cursor-pointer transition-colors px-3',
                    file
                      ? 'border-accent/40 bg-accent/5'
                      : 'border-border-primary hover:border-border-accent bg-card-nested',
                  )}
                >
                  <input
                    type="file"
                    accept="image/*,application/pdf"
                    className="hidden"
                    onChange={async (e) => { const f = e.target.files?.[0] ?? null; setFile(await prepareKycFile(f)); }}
                  />
                  {file ? (
                    <span className="text-sm text-accent font-medium break-all text-center">{file.name}</span>
                  ) : (
                    <div className="flex flex-col items-center gap-1 text-center py-2">
                      <Upload size={18} className="text-text-tertiary" />
                      <span className="text-xs text-text-secondary">
                        Tap to upload · JPG, PNG, PDF, WEBP · max 10 MB
                      </span>
                    </div>
                  )}
                </label>
              </div>

              <div className="space-y-2">
                <label className="text-xs text-text-secondary uppercase tracking-wide font-semibold">
                  Proof of address *
                </label>
                <div className="relative">
                  <select
                    value={docType2}
                    onChange={(e) => setDocType2(e.target.value)}
                    className={selectCls}
                  >
                    {DOC_TYPES.map((d) => (
                      <option key={d.value} value={d.value} className="bg-card">
                        {d.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    size={14}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none"
                  />
                </div>
                <label
                  className={clsx(
                    'flex items-center justify-center w-full min-h-[4rem] rounded-xl border-2 border-dashed cursor-pointer transition-colors',
                    file2
                      ? 'border-accent/40 bg-accent/5'
                      : 'border-border-primary hover:border-border-accent bg-card-nested',
                  )}
                >
                  <input
                    type="file"
                    accept="image/*,application/pdf"
                    className="hidden"
                    onChange={async (e) => { const f = e.target.files?.[0] ?? null; setFile2(await prepareKycFile(f)); }}
                  />
                  {file2 ? (
                    <span className="text-xs text-accent font-medium px-2 break-all text-center">{file2.name}</span>
                  ) : (
                    <span className="text-xs text-text-secondary">Upload proof of address (utility bill / bank statement)</span>
                  )}
                </label>
              </div>

              <div className="space-y-2">
                <label className="text-xs text-text-secondary uppercase tracking-wide font-semibold">
                  Selfie with ID *
                </label>
                <label
                  className={clsx(
                    'flex items-center justify-center gap-2 w-full min-h-[4rem] rounded-xl border-2 border-dashed cursor-pointer transition-colors px-3',
                    file3
                      ? 'border-accent/40 bg-accent/5'
                      : 'border-border-primary hover:border-border-accent bg-card-nested',
                  )}
                >
                  <input
                    type="file"
                    accept="image/*"
                    capture="user"
                    className="hidden"
                    onChange={async (e) => { const f = e.target.files?.[0] ?? null; setFile3(await prepareKycFile(f)); }}
                  />
                  {file3 ? (
                    <span className="text-xs text-accent font-medium px-2 break-all text-center">{file3.name}</span>
                  ) : (
                    <div className="flex flex-col items-center gap-1 text-center py-2">
                      <Camera size={18} className="text-text-tertiary" />
                      <span className="text-xs text-text-secondary">
                        Upload a selfie holding your ID · JPG, PNG, WEBP
                      </span>
                    </div>
                  )}
                </label>
              </div>

              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={submitting}
                className="w-full py-3.5 rounded-xl border-2 border-accent bg-accent hover:brightness-110 disabled:opacity-60 text-black font-bold text-sm transition-all flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(85,166,48,0.25)]"
              >
                {submitting ? (
                  <>
                    <div className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin" />
                    Uploading…
                  </>
                ) : (
                  <>
                    <ShieldCheck size={18} />
                    Submit for review
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </DashboardShell>
  );
}

