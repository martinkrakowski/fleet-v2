// @generated inbound contract scaffold — refined for K4-1.
/**
 * CancelPreparedAttemptPort: cancel an attempt that was never dispatched in
 * the record only: an `intent-recorded` attempt becomes `cancelled` by CAS
 * on its revision, so a concurrent writer loses; a held reservation is
 * released and reported released only when the release is confirmed. No
 * runner is contacted, and dispatch refuses a cancelled attempt.
 */

import type { AttemptRecord } from '../../../domain/execution-records.js';

export interface CancelPreparedAttemptRequest {
  readonly attemptId: string;
  readonly nowIso: string;
}

export type CancelPreparedAttemptRefusal = 'attempt-missing' | 'not-prepared' | 'changed';

export type CancelPreparedAttemptResult =
  | {
      readonly outcome: 'cancelled';
      readonly attempt: AttemptRecord;
      /** `released` only when the release was confirmed; `none-held` when no reservation was held. */
      readonly capacity: 'released' | 'none-held' | 'held';
    }
  | { readonly outcome: 'refused'; readonly reason: CancelPreparedAttemptRefusal };

export interface CancelPreparedAttemptPort {
  /** Record-only: an `intent-recorded` attempt becomes `cancelled`; no runner is contacted. */
  cancelPreparedAttempt(request: CancelPreparedAttemptRequest): Promise<CancelPreparedAttemptResult>;
}
