// @generated inbound contract scaffold — refined for lane CO19.
/**
 * AppendScorecardPort appends one lane-performance row for one terminal
 * conducted run to the versioned scorecard, derived only from read-only stores
 * (run record, attempts, run journal, acceptance receipts). A run already
 * present is a no-op that returns the recorded row; a non-terminal or
 * unreadable run is refused with a reason code. Ids, codes, counts and
 * durations only.
 */

import type { LaneScorecardRow } from '../out/LaneScorecardPort.out-port.js';

export interface AppendScorecardRequest {
  readonly runId: string;
  /** A zoned ISO instant; accepted, never written into the row. */
  readonly nowIso: string;
}

export type AppendScorecardRefusal =
  | 'invalid-request' | 'run-not-found' | 'run-not-terminal' | 'stores-unreadable'
  | 'scorecard-unreadable' | 'scorecard-locked' | 'duplicate-run';

export type AppendScorecardResult =
  | { readonly outcome: 'appended'; readonly row: LaneScorecardRow }
  | { readonly outcome: 'already-present'; readonly row: LaneScorecardRow }
  | { readonly outcome: 'refused'; readonly reason: AppendScorecardRefusal };

export interface AppendScorecardPort {
  appendScorecard(request: AppendScorecardRequest): Promise<AppendScorecardResult>;
}
