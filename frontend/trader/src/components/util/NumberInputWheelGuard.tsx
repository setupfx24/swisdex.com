'use client';

import { useEffect } from 'react';

/**
 * Mouse-wheel over a FOCUSED <input type="number"> silently changes its value
 * (e.g. a trader types 1000, scrolls the page, and it becomes 999.97). Blur the
 * field on wheel so the page still scrolls but the amount never changes —
 * applies app-wide to every number input (client 2026-06-26).
 */
export default function NumberInputWheelGuard() {
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      const t = e.target as HTMLElement | null;
      if (t instanceof HTMLInputElement && t.type === 'number' && document.activeElement === t) {
        t.blur();
      }
    };
    document.addEventListener('wheel', onWheel, { passive: true });
    return () => document.removeEventListener('wheel', onWheel);
  }, []);
  return null;
}
