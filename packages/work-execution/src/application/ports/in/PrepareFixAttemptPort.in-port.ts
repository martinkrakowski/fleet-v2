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
  readonly nowIso?: string;
}

export type PrepareFixAttemptResult =
  | { readonly outcome: 'prepared'; readonly attempt: AttemptRecord }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface PrepareFixAttemptPort {
  /** Prepare a fresh fix attempt after the prior attempt is collected or cancelled. */
  prepareFixAttempt(request: PrepareFixAttemptRequest): Promise<PrepareFixAttemptResult>;
}
