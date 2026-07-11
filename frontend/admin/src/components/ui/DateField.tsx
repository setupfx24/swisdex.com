'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  addDays, addMonths, endOfMonth, endOfWeek, format, isAfter, isBefore,
  isSameDay, isSameMonth, parseISO, startOfDay, startOfMonth, startOfWeek,
} from 'date-fns';
import { cn } from '@/lib/utils';

/**
 * DateField — a fully-styled, dark-theme date picker that REPLACES the
 * browser-native <input type="date">.
 *
 * Why this exists: the native picker's calendar popup is rendered by the
 * browser and is NOT stylable via CSS, so adjacent-month "outside" days
 * render in the same weight as the current month and visually blend
 * together ("dates mix ho rahi hai"). This component renders the grid
 * ourselves so outside-month days are clearly muted and the current
 * month / selected day / today read cleanly on the admin dark theme.
 *
 * Drop-in contract: value and onChange use the SAME 'YYYY-MM-DD' string
 * (or '') the native input emitted, so page state/query logic is unchanged.
 */

interface DateFieldProps {
  value: string;                 // 'YYYY-MM-DD' or ''
  onChange: (v: string) => void; // emits 'YYYY-MM-DD' or ''
  min?: string;                  // 'YYYY-MM-DD' lower bound (inclusive)
  max?: string;                  // 'YYYY-MM-DD' upper bound (inclusive)
  placeholder?: string;
  className?: string;            // applied to the trigger button
}

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function parse(v?: string): Date | null {
  if (!v) return null;
  try {
    const d = parseISO(v);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

export default function DateField({
  value, onChange, min, max, placeholder = 'mm/dd/yyyy', className,
}: DateFieldProps) {
  const selected = parse(value);
  const minD = parse(min);
  const maxD = parse(max);
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState<Date>(selected || new Date());
  const ref = useRef<HTMLDivElement>(null);

  // Re-sync the visible month when the value changes from outside.
  useEffect(() => {
    if (selected) setViewMonth(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const days = useMemo(() => {
    const gridStart = startOfWeek(startOfMonth(viewMonth), { weekStartsOn: 0 });
    const gridEnd = endOfWeek(endOfMonth(viewMonth), { weekStartsOn: 0 });
    const out: Date[] = [];
    let d = gridStart;
    while (d <= gridEnd) {
      out.push(d);
      d = addDays(d, 1);
    }
    return out;
  }, [viewMonth]);

  const isDisabled = (d: Date) =>
    Boolean(
      (minD && isBefore(startOfDay(d), startOfDay(minD))) ||
      (maxD && isAfter(startOfDay(d), startOfDay(maxD))),
    );

  const pick = (d: Date) => {
    if (isDisabled(d)) return;
    onChange(format(d, 'yyyy-MM-dd'));
    setOpen(false);
  };

  const today = new Date();

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'text-xs py-1.5 px-2 bg-bg-input border border-border-primary rounded-md inline-flex items-center gap-2 min-w-[130px]',
          className,
        )}
      >
        <span className={selected ? 'text-text-primary' : 'text-text-tertiary'}>
          {selected ? format(selected, 'MM/dd/yyyy') : placeholder}
        </span>
        <CalendarIcon size={13} className="text-text-tertiary ml-auto" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 right-0 w-64 p-3 rounded-lg border border-border-primary bg-bg-secondary shadow-modal">
          {/* Month navigation */}
          <div className="flex items-center justify-between mb-2">
            <button
              type="button"
              onClick={() => setViewMonth((m) => addMonths(m, -1))}
              className="p-1 rounded hover:bg-bg-hover text-text-secondary"
              aria-label="Previous month"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-xs font-semibold text-text-primary">
              {format(viewMonth, 'MMMM yyyy')}
            </span>
            <button
              type="button"
              onClick={() => setViewMonth((m) => addMonths(m, 1))}
              className="p-1 rounded hover:bg-bg-hover text-text-secondary"
              aria-label="Next month"
            >
              <ChevronRight size={16} />
            </button>
          </div>

          {/* Weekday header */}
          <div className="grid grid-cols-7 gap-0.5 mb-1">
            {WEEKDAYS.map((w) => (
              <div key={w} className="text-center text-[10px] font-medium text-text-tertiary py-1">
                {w}
              </div>
            ))}
          </div>

          {/* Day grid — show ONLY the current month's days. Leading/trailing
              cells from the adjacent months are rendered blank so the calendar
              never shows previous- or next-month dates (client 2026-07-06). */}
          <div className="grid grid-cols-7 gap-0.5">
            {days.map((d, i) => {
              if (!isSameMonth(d, viewMonth)) {
                return <div key={i} className="h-7 w-7" aria-hidden />;
              }
              const sel = selected != null && isSameDay(d, selected);
              const isToday = isSameDay(d, today);
              const disabled = isDisabled(d);
              return (
                <button
                  key={i}
                  type="button"
                  disabled={disabled}
                  onClick={() => pick(d)}
                  className={cn(
                    'h-7 w-7 rounded text-[11px] tabular-nums flex items-center justify-center transition-colors',
                    sel
                      ? 'bg-buy text-white font-semibold'
                      : 'text-text-secondary hover:bg-bg-hover',
                    isToday && !sel ? 'ring-1 ring-buy/50' : '',
                    disabled ? 'opacity-30 cursor-not-allowed hover:bg-transparent' : '',
                  )}
                >
                  {format(d, 'd')}
                </button>
              );
            })}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between mt-2 pt-2 border-t border-border-primary">
            <button
              type="button"
              onClick={() => { onChange(''); setOpen(false); }}
              className="text-[11px] text-text-tertiary hover:text-text-primary"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => { setViewMonth(today); if (!isDisabled(today)) pick(today); }}
              className="text-[11px] text-buy hover:underline"
            >
              Today
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
