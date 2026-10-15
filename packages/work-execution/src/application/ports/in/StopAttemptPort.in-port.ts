// @generated inbound contract scaffold — refined for migration step 1.
/**
 * StopAttemptPort: request cancellation of the identified runner session and
 * establish its actual end before releasing capacity. A still-running or
 * unknown session keeps its reservation; capacity is released only on a
 * confirmed termination receipt.
 */

import type { AttemptRecord, CommandCompletionReceipt } from '../../../domain/execution-records.js';

export interface StopAttemptRequest {
  readonly attemptId: string;
  readonly gracePeriodSeconds?: number;
  readonly nowIso?: string;
}

export type StopAttemptResult =
  | {
      readonly outcome: 'terminated';
      readonly attempt: AttemptRecord;
      readonly receipt: CommandCompletionReceipt;
      readonly capacityReleased: boolean;
    }
  | { readonly outcome: 'still-running'; readonly attempt: AttemptRecord; readonly reason: string }
  | { readonly outcome: 'unknown'; readonly attempt: AttemptRecord; readonly reason: string }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface StopAttemptPort {
  /** Stop one attempt; only a confirmed termination releases capacity. */
  stopAttempt(request: StopAttemptRequest): Promise<StopAttemptResult>;
}
