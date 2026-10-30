// @generated inbound contract scaffold — refined for migration step 1.
/**
 * PrepareFixAttemptPort: create a fresh attempt with a small handover and
 * numbered fixes after the prior attempt is collected or cancelled. A fix
 * round never resumes the prior session; its conversation is not the new
 * attempt's.
 */

import type { AttemptRecord } from '../../../domain/execution-records.js';

export interface PrepareFixAttemptRequest {
  readonly fixAttemptId: string;
  readonly workOrderId: string;
  readonly priorAttemptId: string;
  readonly worktreePath?: string;
  readonly baseCommit?: string;
  readonly numberedFixes: readonly string[];
  /**
   * The brief digest and package path of the fix round's brief package, placed
   * by the conductor from the prior attempt's frozen manifest before this fix
   * attempt starts (KF-6). Both or neither; non-empty strings.
   */
  readonly briefDigest?: string;
  readonly briefPackagePath?: string;
  /**
   * Seat ids the installation currently marks unhealthy (S1). They are only
   * ever skipped, never added; absent means none. Used only when the prior
   * attempt carries a seat plan.
   */
  readonly unhealthySeatIds?: readonly string[];
  readonly nowIso?: string;
}

export type PrepareFixAttemptResult =
  | { readonly outcome: 'prepared'; readonly attempt: AttemptRecord }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface PrepareFixAttemptPort {
  /** Prepare a fresh fix attempt after the prior attempt is collected or cancelled. */
  prepareFixAttempt(request: PrepareFixAttemptRequest): Promise<PrepareFixAttemptResult>;
}
