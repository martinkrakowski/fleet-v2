// @generated inbound contract scaffold — refined for migration step 1.
/**
 * DispatchAttemptPort: start one prepared, capacity-reserved attempt after
 * runner capabilities are verified. An unknown dispatch outcome retains the
 * reservation and enters reconciliation; it is never retried blindly.
 */

import type {
  AttemptRecord,
  AttemptSeatOverrideRecord,
} from '../../../domain/execution-records.js';
import type { RunnerIsolationCapabilities } from '../out/ExecutionRunnerPort.out-port.js';

export interface DispatchAttemptRequest {
  readonly attemptId: string;
  readonly workOrderId: string;
  readonly worktreePath: string;
  readonly briefPackagePath: string;
  readonly briefDigest: string;
  readonly baseCommit: string;
  readonly stepLimit: number;
  readonly timeLimitSeconds: number;
  readonly expectedArtifacts?: readonly string[];
  /**
   * Optional since D4: the requirements come from the brief's lane profile,
   * never from the caller. When omitted, dispatch requires the strict lane
   * profile below. A boundary that accepts an operator override is itself at
   * fault; the CLI refuses one as a usage error.
   */
  readonly requiredCapabilities?: RunnerIsolationCapabilities;
  readonly nowIso?: string;
  readonly seatOverride?: AttemptSeatOverrideRecord;
  readonly reviewerSeat?: string;
}

export type DispatchAttemptResult =
  | { readonly outcome: 'started'; readonly attempt: AttemptRecord; readonly sessionId: string }
  | { readonly outcome: 'unknown'; readonly attempt: AttemptRecord; readonly reason: string }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface DispatchAttemptPort {
  /** Start one prepared attempt; `unknown` never releases capacity. */
  dispatchAttempt(request: DispatchAttemptRequest): Promise<DispatchAttemptResult>;
}
