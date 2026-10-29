/**
 * ProcessTreeTerminationPort is the outbound contract for terminating every
 * process on the attempt's recorded host whose working directory is inside
 * the attempt's worktree, TERM then KILL after a grace period; never a
 * process outside it; the count is reported; no host or no answer is refused
 * or unavailable, never a guess. Read-only with respect to records.
 */

import type { AttemptRunnerRecord } from "../../../domain/execution-records.js";

/** One termination request: the attempt whose worktree must be cleared. */
export interface TerminateWorktreeProcessesRequest {
  /** The attempt being stopped, cancelled or collected; identity only. */
  readonly attemptId: string;
  /** The attempt's worktree path (absolute); the kill boundary. */
  readonly worktreePath: string;
  /** The attempt's recorded runner block; a legacy record is never killed. */
  readonly runner: AttemptRunnerRecord | null | undefined;
  /** Seconds between TERM and KILL. */
  readonly gracePeriodSeconds: number;
}

/** Completed outcome of one worktree process-tree termination. */
export type TerminateWorktreeProcessesResult =
  | { readonly outcome: 'terminated'; readonly killed: number }
  | { readonly outcome: 'refused'; readonly reason: string }
  | { readonly outcome: 'unavailable'; readonly reason: string };

/**
 * Terminate every process inside the attempt's worktree on its recorded
 * host, fail closed.
 */
export interface ProcessTreeTerminationPort {
  terminateWorktreeProcesses(
    request: TerminateWorktreeProcessesRequest,
  ): Promise<TerminateWorktreeProcessesResult>;
}
