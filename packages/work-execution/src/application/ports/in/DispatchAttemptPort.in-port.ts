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
  readonly nowIso?: string;
  readonly seatOverride?: AttemptSeatOverrideRecord;
  readonly reviewerSeat?: string;
  /**
   * The installation schema version the dispatching root runs under (H9a2).
   * A v2 installation never defaults the seat tool: a frozen manifest whose
   * model assignment carries no `seatTool` refuses. A v1 or absent
   * installation keeps the legacy opencode default.
   */
  readonly installationSchemaVersion?: number;
}

export type DispatchAttemptResult =
  | { readonly outcome: 'started'; readonly attempt: AttemptRecord; readonly sessionId: string }
  | { readonly outcome: 'unknown'; readonly attempt: AttemptRecord; readonly reason: string }
  | { readonly outcome: 'refused'; readonly reason: string }
  /**
   * The start was blocked because a session may be live in the worktree. The
   * reservation is kept and the attempt stays `blocked` until reconcile or
   * stop resolves the worktree.
   */
  | { readonly outcome: 'blocked'; readonly attempt: AttemptRecord; readonly reason: string };

export interface DispatchAttemptPort {
  /** Start one prepared attempt; `unknown` never releases capacity. */
  dispatchAttempt(request: DispatchAttemptRequest): Promise<DispatchAttemptResult>;
}
