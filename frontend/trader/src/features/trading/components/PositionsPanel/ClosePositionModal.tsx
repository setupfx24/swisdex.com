'use client';

import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { X, Layers, TrendingUp, TrendingDown } from 'lucide-react';
import type { InstrumentInfo, Position } from '@/stores/tradingStore';
import type { CloseModal, BulkCloseType } from './positionsPanel.utils';
import { snapLotsForCloseFraction, formatLotsInput } from './positionsPanel.utils';

interface ClosePositionModalProps {
  closeModal: CloseModal;
  setCloseModal: React.Dispatch<React.SetStateAction<CloseModal>>;
  closeSubmitting: boolean;
  instruments: InstrumentInfo[];
  /** Live positions — used to read unrealised P&L for the booking preview. */
  positions?: Position[];
  onClose: (id: string, lots?: number) => void;
  setBulkConfirm: React.Dispatch<React.SetStateAction<BulkCloseType | null>>;
  bulkBusy: boolean;
  positionsCount: number;
  profitCount: number;
  lossCount: number;
}

export function ClosePositionModal({
  closeModal,
  setCloseModal,
  closeSubmitting,
  instruments,
  positions,
  onClose,
  setBulkConfirm,
  bulkBusy,
  positionsCount,
  profitCount,
  lossCount,
}: ClosePositionModalProps) {
  if (!closeModal || typeof document === 'undefined') return null;

  const livePos = positions?.find((p) => p.id === closeModal.id);
  const livePnl = livePos?.profit ?? 0;
  const typedLots = parseFloat(closeModal.closeLots);
  const typedRatio = livePos && livePos.lots > 0 && Number.isFinite(typedLots) && typedLots > 0
    ? Math.min(1, typedLots / livePos.lots)
    : null;
  const typedBooking = typedRatio != null ? livePnl * typedRatio : null;

  return createPortal(
    <div className="fixed inset-0 p-0" style={{ zIndex: 2147483646, isolation: 'isolate' }}>
      <button
        type="button"
        tabIndex={-1}
        aria-label="Dismiss"
        className="absolute inset-0 z-0 m-0 h-full w-full cursor-default border-0 bg-black/60 p-0 backdrop-blur-sm"
        onClick={() => { if (!closeSubmitting) setCloseModal(null); }}
      />
      <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="close-position-title"
          className="pointer-events-auto relative w-full max-w-[280px] rounded-xl border border-border-primary p-3.5 shadow-2xl overflow-hidden"
          style={{ background: 'var(--bg-card)' }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-2 mb-3">
            <h3 id="close-position-title" className="text-sm font-bold text-text-primary">
              Close Position
            </h3>
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setCloseModal(null); }}
              className={clsx(
                'shrink-0 w-7 h-7 flex items-center justify-center rounded-lg transition-colors',
                'bg-bg-hover text-text-tertiary hover:text-text-primary',
              )}
              aria-label="Close dialog"
            >
              <X className="w-4 h-4" strokeWidth={2.5} />
            </button>
          </div>

          <div className="space-y-3">
            <div className={clsx('rounded-lg p-3 space-y-1.5 border', 'bg-bg-secondary border-border-primary')}>
              <div className="flex justify-between text-[11px] font-medium">
                <span className="text-text-tertiary">Symbol</span>
                <span className="font-mono text-text-primary">{closeModal.symbol}</span>
              </div>
              <div className="flex justify-between text-[11px] font-medium">
                <span className="text-text-tertiary">Side</span>
                <span className={clsx('font-bold', closeModal.side === 'buy' ? 'text-buy' : 'text-sell')}>
                  {closeModal.side.toUpperCase()}
                </span>
              </div>
              <div className="flex justify-between text-[11px] font-medium">
                <span className="text-text-tertiary">Open lots</span>
                <span className="font-mono text-text-primary">{closeModal.lots}</span>
              </div>
              {typedBooking != null && (
                <div className="flex justify-between text-[11px] font-medium pt-1 mt-1 border-t border-border-primary/50">
                  <span className="text-text-tertiary">Estimated booking</span>
                  <span className={clsx('font-mono font-bold tabular-nums', typedBooking >= 0 ? 'text-buy' : 'text-sell')}>
                    {typedBooking >= 0 ? '+' : '-'}${Math.abs(typedBooking).toFixed(2)}
                  </span>
                </div>
              )}
            </div>

            <div>
              <label className={clsx('text-[9px] font-bold uppercase tracking-wider block mb-1.5', 'text-text-tertiary')}>
                Lots to close
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 mb-2">
                {([25, 50, 75] as const).map((pct) => {
                  const v = livePos ? livePnl * (pct / 100) : null;
                  const presetLots = snapLotsForCloseFraction(closeModal.lots, closeModal.symbol, instruments, pct / 100);
                  const active = formatLotsInput(presetLots) === formatLotsInput(parseFloat(closeModal.closeLots) || 0);
                  return (
                    <button
                      key={pct}
                      type="button"
                      onClick={() => {
                        setCloseModal((m) => {
                          if (!m) return m;
                          const v2 = snapLotsForCloseFraction(m.lots, m.symbol, instruments, pct / 100);
                          return { ...m, closeLots: formatLotsInput(v2) };
                        });
                      }}
                      className={clsx(
                        'cursor-pointer flex flex-col items-center justify-center px-2 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wide border transition-colors',
                        active
                          ? 'bg-accent/15 border-accent/50 text-accent ring-1 ring-inset ring-accent/30'
                          : 'bg-bg-secondary border-border-primary text-text-primary hover:bg-bg-hover',
                      )}
                    >
                      <span>{pct}%</span>
                      {v != null && (
                        <span className={clsx(
                          'text-[9px] font-mono normal-case tracking-normal mt-0.5',
                          v >= 0 ? 'text-buy' : 'text-sell',
                        )}>
                          {v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(2)}
                        </span>
                      )}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => setCloseModal((m) => m ? { ...m, closeLots: formatLotsInput(m.lots) } : m)}
                  className={clsx(
                    'cursor-pointer flex flex-col items-center justify-center px-2 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wide border transition-colors',
                    formatLotsInput(closeModal.lots) === formatLotsInput(parseFloat(closeModal.closeLots) || 0)
                      ? 'bg-accent/15 border-accent/50 text-accent ring-1 ring-inset ring-accent/30'
                      : 'bg-bg-secondary border-border-primary text-text-primary hover:bg-bg-hover',
                  )}
                >
                  <span>Full</span>
                  {livePos && (
                    <span className={clsx(
                      'text-[9px] font-mono normal-case tracking-normal mt-0.5',
                      livePnl >= 0 ? 'text-buy' : 'text-sell',
                    )}>
                      {livePnl >= 0 ? '+' : '-'}${Math.abs(livePnl).toFixed(2)}
                    </span>
                  )}
                </button>
              </div>
              <input
                type="number"
                step="0.01"
                min="0.01"
                max={closeModal.lots}
                value={closeModal.closeLots}
                onChange={(e) => setCloseModal({ ...closeModal, closeLots: e.target.value })}
                className={clsx(
                  'w-full px-3 py-2 rounded-lg font-mono text-sm outline-none transition-all border',
                  'bg-bg-secondary border-border-primary text-text-primary focus:border-sell',
                )}
              />
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setCloseModal(null)}
                className={clsx('flex-1 py-2.5 font-bold rounded-lg text-sm active:scale-[0.98] transition-all', 'bg-bg-hover text-text-primary')}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={closeSubmitting}
                onClick={() => {
                  const cl = parseFloat(closeModal.closeLots);
                  if (Number.isNaN(cl) || cl <= 0) return;
                  if (cl > closeModal.lots + 1e-9) return;
                  onClose(closeModal.id, cl < closeModal.lots - 1e-9 ? cl : undefined);
                }}
                className="flex-1 py-2.5 bg-sell text-white font-bold rounded-lg shadow-lg shadow-sell/20 active:scale-[0.98] transition-all text-sm flex items-center justify-center gap-2 disabled:opacity-70 disabled:pointer-events-none"
              >
                {closeSubmitting ? (
                  <>
                    <span className="w-3.5 h-3.5 rounded-full border-2 border-white border-t-transparent animate-spin" />
                    Closing…
                  </>
                ) : 'Close'}
              </button>
            </div>

            <div className={clsx('pt-3 mt-1 border-t border-border-primary')}>
              <p className={clsx('text-[9px] font-semibold uppercase tracking-wider text-center mb-2', 'text-text-tertiary')}>
                Bulk close
              </p>
              <div className="grid grid-cols-3 gap-1.5">
                <button
                  type="button"
                  onClick={() => { setCloseModal(null); setBulkConfirm('all'); }}
                  disabled={bulkBusy || positionsCount === 0}
                  className={clsx(
                    'flex flex-col items-center gap-0.5 py-2 px-0.5 rounded-lg border active:scale-[0.98] transition-all disabled:opacity-40',
                    'bg-bg-secondary border-border-primary hover:bg-bg-hover',
                  )}
                >
                  <Layers className="w-3.5 h-3.5 text-text-secondary" />
                  <span className="text-[9px] font-bold text-text-primary">All</span>
                  <span className="text-[9px] tabular-nums text-text-tertiary">({positionsCount})</span>
                </button>
                <button
                  type="button"
                  onClick={() => { setCloseModal(null); setBulkConfirm('profit'); }}
                  disabled={bulkBusy || profitCount === 0}
                  className={clsx(
                    'flex flex-col items-center gap-0.5 py-2 px-0.5 rounded-lg border active:scale-[0.98] transition-all disabled:opacity-40',
                    'bg-accent/5 border-accent/20 hover:bg-accent/10',
                  )}
                >
                  <TrendingUp className="w-3.5 h-3.5 text-accent" />
                  <span className="text-[9px] font-bold text-accent">Profit</span>
                  <span className="text-[9px] tabular-nums text-text-tertiary">({profitCount})</span>
                </button>
                <button
                  type="button"
                  onClick={() => { setCloseModal(null); setBulkConfirm('loss'); }}
                  disabled={bulkBusy || lossCount === 0}
                  className={clsx(
                    'flex flex-col items-center gap-0.5 py-2 px-0.5 rounded-lg border active:scale-[0.98] transition-all disabled:opacity-40',
                    'bg-sell/5 border-sell/20 hover:bg-sell/10',
                  )}
                >
                  <TrendingDown className="w-3.5 h-3.5 text-sell" />
                  <span className="text-[9px] font-bold text-sell">Loss</span>
                  <span className="text-[9px] tabular-nums text-text-tertiary">({lossCount})</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
