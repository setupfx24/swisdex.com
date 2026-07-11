/**
 * Client-side deposit / withdrawal statement PDF (portrait A4, tabular).
 * Mirrors tradeStatementPdf so users can pull a proper money-movement
 * statement — all, deposits-only, or withdrawals-only, over a custom date
 * range (client 2026-06-19). jspdf is dynamically imported on export only.
 */

export type TransactionStatementRow = {
  created_at?: string | null;
  /** deposit | withdrawal | transfer | bonus | credit | fixed_return | … */
  type: string;
  method?: string | null;
  /** Signed amount: + for money in, − for money out. */
  signedAmount: number;
  amount: number;
  currency?: string | null;
  status: string;
  description?: string | null;
};

export type TransactionStatementMeta = {
  userName?: string;
  userEmail?: string;
  userId?: string;
  accountLabel?: string;
  periodLabel?: string;
  /** "All transactions" | "Deposits" | "Withdrawals" — shown in the header. */
  kindLabel?: string;
};

function fmtUsd(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function titleCase(s: string): string {
  return (s || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch {
    return iso;
  }
}

export async function downloadTransactionStatementPdf(
  rows: TransactionStatementRow[],
  meta?: TransactionStatementMeta,
): Promise<void> {
  const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  let y = 16;

  doc.setFillColor(41, 98, 255);
  doc.rect(0, 0, pageW, 10, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text('SwisDex', margin, 7);

  doc.setTextColor(30, 30, 30);
  doc.setFontSize(16);
  doc.text(`${meta?.kindLabel || 'Transaction'} statement`, margin, y);
  y += 8;

  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(80, 80, 80);

  if (meta?.userName || meta?.userEmail) {
    const who = [meta?.userName, meta?.userEmail ? `<${meta.userEmail}>` : '']
      .filter(Boolean).join('  ');
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30, 30, 30);
    doc.text(`Account holder: ${who}`, margin, y);
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(80, 80, 80);
  }
  if (meta?.userId) { doc.text(`User ID: ${meta.userId}`, margin, y); y += 4; }
  if (meta?.accountLabel) { doc.text(`Account: ${meta.accountLabel}`, margin, y); y += 4; }
  if (meta?.periodLabel) { doc.text(`Period: ${meta.periodLabel}`, margin, y); y += 4; }
  doc.text(`Generated: ${formatWhen(new Date().toISOString())} (local time)`, margin, y);
  y += 4;
  doc.text(`Rows: ${rows.length}`, margin, y);
  y += 5;

  // Totals — money in / money out from the signed amounts (completed only).
  const completed = rows.filter((r) => (r.status || '').toLowerCase() === 'completed');
  const totalIn = completed.filter((r) => r.signedAmount > 0).reduce((s, r) => s + r.signedAmount, 0);
  const totalOut = completed.filter((r) => r.signedAmount < 0).reduce((s, r) => s + Math.abs(r.signedAmount), 0);
  doc.setTextColor(30, 30, 30);
  doc.text(`Total in (completed): ${fmtUsd(totalIn)}   ·   Total out (completed): ${fmtUsd(totalOut)}`, margin, y);
  y += 6;

  const body = rows.map((r) => [
    formatWhen(r.created_at),
    titleCase(r.type),
    r.method ? titleCase(r.method) : '—',
    `${r.signedAmount >= 0 ? '+' : '−'}${fmtUsd(Math.abs(r.signedAmount))}`,
    titleCase(r.status),
  ]);

  autoTable(doc, {
    startY: y,
    head: [['Date', 'Type', 'Method', 'Amount (USD)', 'Status']],
    body,
    foot: [[
      { content: 'Net (completed)', colSpan: 3, styles: { fontStyle: 'bold', halign: 'right', textColor: [30, 30, 30] } },
      { content: fmtUsd(totalIn - totalOut), styles: { fontStyle: 'bold', halign: 'right', textColor: (totalIn - totalOut) >= 0 ? [0, 120, 80] : [180, 0, 50] } },
      { content: '', styles: {} },
    ]],
    showFoot: 'lastPage',
    theme: 'striped',
    headStyles: { fillColor: [41, 98, 255], textColor: 255, fontStyle: 'bold', fontSize: 8, cellPadding: 2 },
    bodyStyles: { fontSize: 7.5, cellPadding: 1.6, textColor: [40, 40, 40] },
    footStyles: { fillColor: [245, 245, 245], fontSize: 8 },
    alternateRowStyles: { fillColor: [252, 252, 252] },
    columnStyles: {
      0: { cellWidth: 40 },
      1: { cellWidth: 32 },
      2: { cellWidth: 38 },
      3: { cellWidth: 34, halign: 'right', font: 'courier' },
      4: { cellWidth: 28 },
    },
    margin: { left: margin, right: margin },
    didDrawPage: (data) => {
      const pageCount = doc.getNumberOfPages();
      doc.setFontSize(7);
      doc.setTextColor(140, 140, 140);
      doc.text(`Page ${data.pageNumber} of ${pageCount}`, pageW - margin - 28, doc.internal.pageSize.getHeight() - 6);
      doc.text('SwisDex — for information only. Not tax or legal advice.', margin, doc.internal.pageSize.getHeight() - 6);
    },
  });

  const safeDate = new Date().toISOString().slice(0, 10);
  const slug = (meta?.kindLabel || 'transactions').toLowerCase().replace(/\s+/g, '-');
  doc.save(`swisdex-${slug}-statement-${safeDate}.pdf`);
}
