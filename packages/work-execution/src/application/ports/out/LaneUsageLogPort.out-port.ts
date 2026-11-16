// Outbound contract: the lane usage telemetry log (OG14). Refined from the
// lane usage row format in the domain; the store is a versioned JSONL file
// under `<stateDir>/telemetry/` or an in-memory hold. No result carries a
// path, file content or an error message.
/**
 * LaneUsageLogPort: append one usage row and read the rows back. An append
 * is atomic under the store's lock, deduplicates by `attemptId` and enforces
 * the store's row and byte budget. A read returns the rows in append order;
 * a file whose header or lines it cannot validate is unreadable, and the
 * first bad line is named by its line number. Port implementations never
 * throw: every failure is a typed refusal.
 */

import type { LaneUsageLogRow } from '../../../domain/lane-usage-log.js';

export type LaneUsageLogAppendRefusal =
  | 'invalid-row'
  | 'lock-timeout'
  | 'log-budget-exhausted'
  | 'store-unreadable';

export type LaneUsageLogAppendResult =
  | { readonly outcome: 'appended' }
  | { readonly outcome: 'duplicate' }
  | { readonly outcome: 'refused'; readonly reason: LaneUsageLogAppendRefusal };

export type LaneUsageLogReadResult =
  | { readonly outcome: 'read'; readonly rows: readonly LaneUsageLogRow[] }
  | {
      readonly outcome: 'unreadable';
      readonly reason: 'invalid-header' | 'malformed-row' | 'store-unreadable';
      readonly lineNumber?: number;
    };

export interface LaneUsageLogPort {
  append(row: LaneUsageLogRow): Promise<LaneUsageLogAppendResult>;
  read(): Promise<LaneUsageLogReadResult>;
}
