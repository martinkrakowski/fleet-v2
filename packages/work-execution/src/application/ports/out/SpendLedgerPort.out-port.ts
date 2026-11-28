// Outbound contract: the monthly spend ledger (CL1). Refined from the spend
// ledger row format in the domain; the store is a versioned JSONL file under
// `<stateDir>/spend/` or an in-memory hold. No result carries a path, file
// content or an error message.
/**
 * SpendLedgerPort: append one spend row and read one month's rows back. An
 * append is atomic under the store's lock, deduplicates by `attemptId` and
 * enforces the store's row and byte budget. A read returns the month's rows
 * in append order; a month it cannot validate, or a file whose header or
 * lines it cannot validate, is unreadable, and the first bad line is named by
 * its line number. Port implementations never throw: every failure is a
 * typed refusal.
 */

import type { SpendLedgerRow } from '../../../domain/spend-ledger.js';

export type SpendLedgerAppendRefusal =
  | 'invalid-row'
  | 'lock-timeout'
  | 'ledger-budget-exhausted'
  | 'store-unreadable';

export type SpendLedgerAppendResult =
  | { readonly outcome: 'appended' }
  | { readonly outcome: 'duplicate' }
  | { readonly outcome: 'refused'; readonly reason: SpendLedgerAppendRefusal };

export type SpendLedgerReadMonthResult =
  | { readonly outcome: 'read'; readonly rows: readonly SpendLedgerRow[] }
  | {
      readonly outcome: 'unreadable';
      readonly reason: 'invalid-month' | 'invalid-header' | 'malformed-row' | 'store-unreadable';
      readonly lineNumber?: number;
    };

export interface SpendLedgerPort {
  append(row: SpendLedgerRow): Promise<SpendLedgerAppendResult>;
  readMonth(month: string): Promise<SpendLedgerReadMonthResult>;
}
