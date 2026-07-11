/**
 * Cent-account display helpers.
 *
 * Backend stores all account balances in USD. When an account belongs
 * to an `is_cent_account = true` AccountGroup, the trader UI must
 * present those amounts as cents (¢) at 1 USD = 100 ¢ so beginners
 * see meaningful-looking numbers on small deposits.
 *
 * Conversion is display-only — pass the raw USD figure straight from
 * the API and let these helpers handle the multiplication + symbol
 * swap. NEVER persist the cent-converted value anywhere; the trading
 * engine, ledger, and reports all stay USD-based.
 */

export const CENT_SYMBOL = '¢';
export const CENT_PER_USD = 100;

export interface CentAware {
  is_cent_account?: boolean | null;
}

/** Whether an account row should render its money in ¢. Accepts both
 *  the flat shape (`{is_cent_account: true}` on the account row) and
 *  the nested shape (`account.account_group.is_cent_account`). */
export function isCentAccount(
  row:
    | (CentAware & { account_group?: CentAware | null })
    | null
    | undefined,
): boolean {
  if (!row) return false;
  if (row.is_cent_account) return true;
  if (row.account_group?.is_cent_account) return true;
  return false;
}

/** Format a USD amount for display, switching to ¢ when the source
 *  account is a cent account. Returns the symbol+value already
 *  formatted (e.g. "¢500.00" or "$5.00") so callers don't have to
 *  branch on the symbol. */
export function fmtAccountMoney(
  usd: number | null | undefined,
  isCent: boolean,
  opts: { decimals?: number; signDisplay?: 'auto' | 'always' | 'never' } = {},
): string {
  const decimals = opts.decimals ?? 2;
  const n = Number(usd);
  if (!Number.isFinite(n)) return isCent ? `${CENT_SYMBOL}0.00` : '$0.00';
  if (isCent) {
    const cents = n * CENT_PER_USD;
    // Sign goes BEFORE the ¢ symbol ("-¢400.00", not "¢-400.00").
    const sign =
      cents < 0 ? '-' : opts.signDisplay === 'always' && cents > 0 ? '+' : '';
    return `${sign}${CENT_SYMBOL}${Math.abs(cents).toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })}`;
  }
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    signDisplay: opts.signDisplay,
  });
}
