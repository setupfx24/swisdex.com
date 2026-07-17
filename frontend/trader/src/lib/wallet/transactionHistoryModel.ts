/** Shared types + pure helpers for wallet / transactions history UIs. */

export type TransactionKind =
  | 'deposit'
  | 'withdrawal'
  | 'transfer'
  | 'bonus'
  | 'correction'
  | 'profit'
  | 'loss'
  | 'adjustment'
  | 'credit'
  // AI-POWERED STAKING PROGRAM: lock, interest payouts, matured returns, early
  // withdrawal payouts/requests, admin grants — all carry their own
  // semantics so they render with a Fixed-Return label + are
  // filterable as a single category.
  | 'fixed_return';

export interface Transaction {
  id: string;
  type: TransactionKind;
  amount: number;
  signedAmount: number;
  currency: string;
  status: 'pending' | 'completed' | 'failed' | 'cancelled';
  method: string;
  created_at: string;
  tx_hash?: string;
  description?: string;
  account_id?: string | null;
}

export interface WalletLedgerItem {
  id: string;
  created_at: string | null;
  type: string;
  method: string;
  amount: number;
  status: string;
  currency: string;
  description?: string;
  account_id?: string | null;
}

export interface WalletListItem {
  id: string;
  created_at: string | null;
  type: string;
  method: string;
  amount: number;
  status: string;
  currency: string;
}

export function formatMethod(method: string): string {
  const m = (method || '').toLowerCase().replace(/-/g, '_');
  const labels: Record<string, string> = {
    bank_transfer: 'Bank transfer',
    bank: 'Bank transfer',
    upi: 'Bank',
    qr: 'QR code',
    crypto_btc: 'Bitcoin',
    crypto_eth: 'Ethereum',
    crypto_usdt: 'USDT',
    metamask: 'MetaMask',
    card: 'Card',
    oxapay: 'Crypto',
    nowpayments: 'Crypto',
    manual: 'Manual / Bank',
  };
  if (labels[m]) return labels[m];
  return method
    ? method.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    : '—';
}

export function normalizeStatus(raw: string): Transaction['status'] {
  const s = (raw || '').toLowerCase();
  if (['approved', 'auto_approved', 'completed'].includes(s)) return 'completed';
  if (s === 'pending') return 'pending';
  if (['rejected', 'failed'].includes(s)) return 'failed';
  if (['cancelled', 'canceled'].includes(s)) return 'cancelled';
  return 'pending';
}

export function mapLedgerToTransaction(row: WalletLedgerItem): Transaction {
  const raw = (row.type || '').toLowerCase();
  let uiType: TransactionKind = 'adjustment';
  if (raw === 'transfer') uiType = 'transfer';
  else if (raw === 'profit') uiType = 'profit';
  else if (raw === 'loss') uiType = 'loss';
  else if (raw === 'credit') uiType = 'credit';
  else if (raw === 'bonus') uiType = 'bonus';
  else if (raw === 'correction') uiType = 'correction';
  else if (raw === 'adjustment') uiType = 'adjustment';
  // Every AI-POWERED STAKING PROGRAM ledger entry the backend emits starts with the
  // `fixed_return` prefix — lock / interest / matured / early /
  // early_request / early_rejected / lock_admin / grant. Bucket them
  // into a single UI kind so users see "AI-POWERED STAKING PROGRAM" as a category.
  else if (raw.startsWith('fixed_return')) uiType = 'fixed_return';
  const amt = Number(row.amount) || 0;
  return {
    id: `ledger-${row.id}`,
    type: uiType,
    amount: Math.abs(amt),
    signedAmount: amt,
    currency: row.currency || 'USD',
    status: normalizeStatus(row.status || 'completed'),
    // For fixed_return rows the backend method is the raw type name
    // (e.g. "AI-POWERED STAKING PROGRAM Interest"). Keep it so the row sub-label
    // tells the user exactly which sub-event this is.
    method: row.method || formatMethod(raw),
    created_at: row.created_at || new Date(0).toISOString(),
    description: row.description?.trim() || undefined,
    account_id: row.account_id ?? undefined,
  };
}

export function mergeWalletHistory(
  deposits: WalletListItem[],
  withdrawals: WalletListItem[],
  ledger: WalletLedgerItem[],
): Transaction[] {
  const mapRow = (row: WalletListItem, kind: 'deposit' | 'withdrawal'): Transaction => {
    const n = Math.abs(Number(row.amount) || 0);
    return {
      id: `${kind}-${row.id}`,
      type: kind,
      amount: n,
      signedAmount: kind === 'deposit' ? n : -n,
      currency: row.currency || 'USD',
      status: normalizeStatus(row.status),
      method: formatMethod(row.method),
      created_at: row.created_at || new Date(0).toISOString(),
    };
  };

  const ledgerTx = ledger
    .map(mapLedgerToTransaction)
    // Realized trade P&L (profit/loss) belongs in the dedicated "Trades" tab,
    // NOT the money-movement history — showing it here made the deposit/
    // withdrawal history look like it contained trade history (client
    // 2026-06-19). Keep deposits, withdrawals, transfers, bonuses, credits,
    // fixed-return and fees; drop the per-trade P&L rows.
    .filter((t) => t.type !== 'profit' && t.type !== 'loss');

  const merged = [
    ...deposits.map((d) => mapRow(d, 'deposit')),
    ...withdrawals.map((w) => mapRow(w, 'withdrawal')),
    ...ledgerTx,
  ];
  merged.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return merged;
}

export function transactionMatchesTypeFilter(
  tx: Transaction,
  f: 'all' | 'deposit' | 'withdrawal' | 'transfer' | 'trading' | 'adjustment' | 'commission' | 'fixed_return',
): boolean {
  if (f === 'all') return true;
  if (f === 'deposit') return tx.type === 'deposit';
  if (f === 'withdrawal') return tx.type === 'withdrawal';
  if (f === 'transfer') return tx.type === 'transfer';
  if (f === 'trading') return tx.type === 'profit' || tx.type === 'loss';
  if (f === 'commission') return tx.type === 'credit' || tx.method.toLowerCase().includes('commission');
  if (f === 'fixed_return') return tx.type === 'fixed_return';
  if (f === 'adjustment')
    return (
      tx.type === 'adjustment' ||
      tx.type === 'credit' ||
      tx.type === 'correction' ||
      tx.type === 'bonus'
    );
  return true;
}

export function transactionTitle(tx: Transaction): string {
  switch (tx.type) {
    case 'deposit':
      return 'Deposit';
    case 'withdrawal':
      return 'Withdrawal';
    case 'transfer':
      return 'Transfer';
    case 'profit':
      return 'Realized profit';
    case 'loss':
      return 'Realized loss';
    case 'credit':
      return 'Credit';
    case 'adjustment': {
      // Every ledger row that collapses to "adjustment" still carries a
      // clean category in tx.method ("Insurance Fee", "Account Open
      // Transfer", "Swap", "IB Commission", …) and a detailed
      // description. Show the clean category as the title instead of a
      // bare "Adjustment"; fall back to the description, then the literal.
      const m = (tx.method || '').trim();
      if (m && m.toLowerCase() !== 'adjustment') return m;
      return tx.description || 'Adjustment';
    }
    case 'bonus': {
      const m = (tx.method || '').trim();
      if (m && m.toLowerCase() !== 'bonus') return m;
      return tx.description || 'Bonus';
    }
    case 'correction':
      return tx.description || 'Correction';
    case 'fixed_return':
      // The backend method is e.g. "AI-POWERED STAKING PROGRAM Lock Admin" / "Fixed
      // Return Interest" / "AI-POWERED STAKING PROGRAM Matured" — read that to pick
      // a precise label instead of a generic "AI-POWERED STAKING PROGRAM" everywhere.
      // Falls back to a generic when the method is empty.
      return fixedReturnLabel(tx.method);
    default:
      return tx.method || tx.description || 'Transaction';
  }
}

function fixedReturnLabel(method: string): string {
  const m = (method || '').toLowerCase();
  if (m.includes('interest')) return 'AI Staking — Interest';
  if (m.includes('matured')) return 'AI Staking — Matured';
  if (m.includes('early_request') || m.includes('early request')) return 'AI Staking — Early withdrawal requested';
  if (m.includes('early_rejected') || m.includes('early rejected')) return 'AI Staking — Early withdrawal rejected';
  if (m.includes('early')) return 'AI Staking — Early withdrawal';
  if (m.includes('grant')) return 'AI Staking — Admin grant';
  if (m.includes('lock')) return 'AI Staking — Lock';
  return 'AI-POWERED STAKING PROGRAM';
}

export const PAGE_SIZES = [10, 25, 50] as const;
