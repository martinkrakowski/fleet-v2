// @generated inbound contract scaffold — refined for migration step 1.
/**
 * ReconcileAttemptPort: compare durable action intent with the matching
 * server/session state before any retry, collection or release. Unknown
 * stays unknown; it never becomes ended and never frees capacity.
 */

import type { AttemptRecord, CommandCompletionReceipt } from '../../../domain/execution-records.js';
import type { RunnerSessionStatus } from '../out/ExecutionRunnerPort.out-port.js';

export interface ReconcileAttemptRequest {
  readonly attemptId: string;
  readonly nowIso?: string;
}

export type ReconcileAttemptResult =
  | { readonly outcome: 'active'; readonly attempt: AttemptRecord; readonly status: RunnerSessionStatus }
  | { readonly outcome: 'ended'; readonly attempt: AttemptRecord; readonly receipt: CommandCompletionReceipt }
  | { readonly outcome: 'unknown'; readonly attempt: AttemptRecord; readonly reason: string }
  | { readonly outcome: 'not-found'; readonly attemptId: string };

export interface ReconcileAttemptPort {
  /** Reconcile one attempt against its runner session before acting again. */
  reconcileAttempt(request: ReconcileAttemptRequest): Promise<ReconcileAttemptResult>;
}
