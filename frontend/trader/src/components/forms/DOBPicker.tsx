'use client';

/**
 * DOBPicker — calendar input for date-of-birth on the profile completion
 * gate. Uses react-day-picker so we can hide adjacent-month days (the
 * native <input type="date"> shows greyed leading/trailing days and the
 * browser owns that, so the client-asked "only this month's days" is
 * only possible with a custom picker).
 *
 * The calendar popover is rendered through a portal into document.body
 * so it escapes the ProfileCompleteGate modal's overflow container —
 * otherwise it gets clipped when the DOB field sits near the bottom of
 * the form card. Position is computed from the trigger's rect, and
 * flipped above the field when there isn't enough room below.
 *
 * Constraints baked into the picker:
 *   • max = today − 18 years (matches the 18+ submit-time guard)
 *   • min = today − 120 years
 *   • default month opens at ~25 years ago if no value set
 *   • year + month dropdowns so the user doesn't click prev-month 30×
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DayPicker } from 'react-day-picker';
import { Calendar } from 'lucide-react';

interface DOBPickerProps {
  value: string;                       // YYYY-MM-DD (empty if unset)
  onChange: (iso: string) => void;
  minAgeYears?: number;
  disabled?: boolean;
}

const POPOVER_WIDTH = 320;
const POPOVER_HEIGHT_ESTIMATE = 380;  // rough — used for flip decision; real height re-checked once mounted

function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseIso(s: string): Date | undefined {
  if (!s) return undefined;
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return undefined;
  return new Date(y, m - 1, d);
}

interface PopoverPos {
  top: number;
  left: number;
}

export default function DOBPicker({
  value,
  onChange,
  minAgeYears = 18,
  disabled = false,
}: DOBPickerProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<PopoverPos | null>(null);
  const [mounted, setMounted] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const selected = parseIso(value);

  const { minDate, maxDate, fallbackMonth } = useMemo(() => {
    const today = new Date();
    const max = new Date(today.getFullYear() - minAgeYears, today.getMonth(), today.getDate());
    const min = new Date(today.getFullYear() - 120, 0, 1);
    const fallback = new Date(today.getFullYear() - 25, today.getMonth(), 1);
    return { minDate: min, maxDate: max, fallbackMonth: fallback };
  }, [minAgeYears]);

  // Defer portal mount until after first client render to avoid SSR mismatch.
  useEffect(() => { setMounted(true); }, []);

  // Compute popover position from the trigger button's viewport rect every
  // time we open. Done with useLayoutEffect so the popover appears in its
  // final spot on the same paint (no visible flicker).
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;
    const spaceBelow = viewportH - rect.bottom;
    const spaceAbove = rect.top;
    const openAbove = spaceBelow < POPOVER_HEIGHT_ESTIMATE + 8 && spaceAbove > spaceBelow;
    const top = openAbove
      ? Math.max(8, rect.top - POPOVER_HEIGHT_ESTIMATE - 4)
      : rect.bottom + 4;
    // Clamp horizontally so the popover never escapes the viewport on
    // narrow screens (modal is centred so this is mostly defensive).
    const left = Math.min(
      Math.max(8, rect.left),
      viewportW - POPOVER_WIDTH - 8,
    );
    setPos({ top, left });
  }, [open]);

  // Outside-click + Esc to close. Scroll/resize close because re-positioning
  // mid-scroll on a portal-mounted popover is visually janky and rarely
  // what the user wants.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popoverRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onScrollOrResize = () => setOpen(false);
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [open]);

  const display = selected
    ? selected.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    : '';

  const popover = open && !disabled && pos && mounted ? (
    <div
      ref={popoverRef}
      className="dob-popover fixed z-[300] rounded-xl border border-border-primary bg-bg-secondary shadow-2xl p-2"
      style={{ top: pos.top, left: pos.left, width: POPOVER_WIDTH }}
      role="dialog"
      aria-label="Select date of birth"
    >
      <DayPicker
        mode="single"
        selected={selected}
        onSelect={(d) => {
          if (d) {
            onChange(toIso(d));
            setOpen(false);
          }
        }}
        // No showOutsideDays — each month must start at the 1st with no
        // trailing/leading days from the prev/next month (client 2026-06-24:
        // "har month sirf 1 se start ho", was showing 28,29,30,31,1,2).
        captionLayout="dropdown"
        startMonth={minDate}
        endMonth={maxDate}
        defaultMonth={selected || fallbackMonth}
        disabled={{ after: maxDate, before: minDate }}
      />
    </div>
  ) : null;

  return (
    <div className="relative">
      <Calendar
        size={14}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
        aria-hidden
      />
      <button
        ref={triggerRef}
        type="button"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        className="w-full pl-9 pr-3 py-2.5 rounded-lg border border-border-primary bg-bg-secondary text-text-primary outline-none focus:border-[#55a630]/50 text-sm text-left disabled:opacity-60"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {display || <span className="text-text-tertiary">Select date</span>}
      </button>
      {popover && createPortal(popover, document.body)}
    </div>
  );
}
