/**
 * Generic admin report → PDF (client 2026-06-19). One helper powers every
 * admin export: deposits, withdrawals, users, trades — for a single user or
 * the whole company, over any custom date range, with summary totals.
 *
 * jspdf is dynamically imported so it's only pulled when an admin exports.
 */

export type AdminReportColumn = {
  header: string;
  /** mm width; omit to let autotable auto-size. */
  width?: number;
  align?: 'left' | 'right' | 'center';
  /** Monospaced (numbers / ids / amounts). */
  mono?: boolean;
};

export type AdminReportMeta = {
  /** e.g. "Deposits", "Withdrawals", "User: john@x.com", "All users". */
  subtitle?: string;
  /** Date range covered, e.g. "2026-06-01 → 2026-06-19" or "All time". */
  periodLabel?: string;
  /** Admin who generated it. */
  generatedBy?: string;
  /** Headline figures shown above the table, e.g.
   *  ["Total deposited: $12,340.00", "Count: 57"]. */
  summaryLines?: string[];
  /** Base file name (without extension). */
  filename?: string;
  /** Landscape for wide tables (default true). */
  landscape?: boolean;
};

function formatWhen(d: Date): string {
  return d.toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

// jsPDF's built-in Helvetica is Latin-1 only, so characters like the arrow
// (→), bullet (·•) and em-dash (—) render in a different/odd glyph — which is
// the "font doesn't match" the client saw on the custom-period line. Map the
// common offenders to ASCII so every line uses the same font (client 2026-06-20).
function s(v: unknown): string {
  return String(v == null ? '' : v)
    .replace(/[→]/g, 'to')
    .replace(/[·•]/g, '-')
    .replace(/[—–]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[^\x00-\xFF]/g, '');
}

export async function downloadAdminReportPdf(
  title: string,
  columns: AdminReportColumn[],
  rows: (string | number)[][],
  meta?: AdminReportMeta,
): Promise<void> {
  const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);

  const doc = new jsPDF({
    orientation: meta?.landscape === false ? 'portrait' : 'landscape',
    unit: 'mm',
    format: 'a4',
  });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  let y = 16;

  // Brand bar
  doc.setFillColor(85, 166, 48);
  doc.rect(0, 0, pageW, 10, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text('SwisDex — Admin', margin, 7);

  doc.setTextColor(30, 30, 30);
  doc.setFontSize(16);
  doc.text(s(title), margin, y);
  y += 8;

  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(80, 80, 80);

  if (meta?.subtitle) { doc.text(s(meta.subtitle), margin, y); y += 4; }
  if (meta?.periodLabel) { doc.text(`Period: ${s(meta.periodLabel)}`, margin, y); y += 4; }
  doc.text(`Generated: ${formatWhen(new Date())} (local time)`, margin, y);
  y += 4;
  if (meta?.generatedBy) { doc.text(`By: ${s(meta.generatedBy)}`, margin, y); y += 4; }
  doc.text(`Rows: ${rows.length}`, margin, y);
  y += 5;

  if (meta?.summaryLines?.length) {
    doc.setTextColor(30, 30, 30);
    doc.setFont('helvetica', 'bold');
    for (const line of meta.summaryLines) { doc.text(s(line), margin, y); y += 4.5; }
    doc.setFont('helvetica', 'normal');
    y += 1;
  }

  const columnStyles: Record<number, Record<string, unknown>> = {};
  columns.forEach((c, i) => {
    const s: Record<string, unknown> = {};
    if (c.width) s.cellWidth = c.width;
    if (c.align) s.halign = c.align;
    if (c.mono) s.font = 'courier';
    columnStyles[i] = s;
  });

  autoTable(doc, {
    startY: y,
    head: [columns.map((c) => s(c.header))],
    body: rows.map((r) => r.map((v) => s(v))),
    theme: 'striped',
    headStyles: { fillColor: [85, 166, 48], textColor: 255, fontStyle: 'bold', fontSize: 8, cellPadding: 2 },
    bodyStyles: { fontSize: 7, cellPadding: 1.5, textColor: [40, 40, 40] },
    alternateRowStyles: { fillColor: [252, 252, 252] },
    columnStyles,
    margin: { left: margin, right: margin },
    didDrawPage: (data) => {
      const pageCount = doc.getNumberOfPages();
      doc.setFontSize(7);
      doc.setTextColor(140, 140, 140);
      doc.text(`Page ${data.pageNumber} of ${pageCount}`, pageW - margin - 28, doc.internal.pageSize.getHeight() - 6);
      doc.text('SwisDex Admin — confidential. For internal use only.', margin, doc.internal.pageSize.getHeight() - 6);
    },
  });

  const safeDate = new Date().toISOString().slice(0, 10);
  const slug = (meta?.filename || title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  doc.save(`swisdex-${slug}-${safeDate}.pdf`);
}
