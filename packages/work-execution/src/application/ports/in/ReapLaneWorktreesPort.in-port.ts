// @generated inbound contract scaffold — refined for EX-2b.
/**
 * ReapLaneWorktreesPort: on the operator's explicit request, list or remove
 * the clean worktree of every lane run that is terminal and whose work order
 * is terminal and whose attempts are all cancelled or collected with no held
 * reservation; never removes a dirty, locked or unlisted worktree and never
 * deletes a branch; a dry run removes nothing.
 */

export interface ReapLaneWorktreesRequest {
  /** Dry run: scan and list candidates exactly like a real run, but call no `removeLaneWorktree`. */
  readonly dryRun: boolean;
  /** Clock override for tests; absent falls back to the system clock. */
  readonly nowIso?: string;
}

/** One removed worktree: the run id and the kept branch's tip (null on a dry run). */
export interface RemovedLaneWorktreeEntry {
  readonly runId: string;
  /** The kept branch `fleet/<runId>`'s tip sha; null on a dry run, where nothing was removed. */
  readonly branchTip: string | null;
}

/** A refused or skipped run, with its typed reason. */
export interface RefusedOrSkippedRunEntry {
  readonly runId: string;
  readonly reason: string;
}

/** One removed worktree whose post-removal journal append failed, with the failure reason. */
export interface ReapWorktreeJournalFailureEntry {
  readonly runId: string;
  readonly attemptId: string;
  readonly branchTip: string;
  readonly reason: string;
}

export type ReapLaneWorktreesResult = {
  readonly outcome: 'reaped';
  readonly dryRun: boolean;
  /** Worktrees removed (or, on a dry run, that would be removed). */
  readonly removed: readonly RemovedLaneWorktreeEntry[];
  /** Worktrees already gone (the path is not listed): nothing to remove. */
  readonly alreadyRemoved: readonly { readonly runId: string }[];
  /** Eligible runs whose removal was refused or could not be decided (reason code). */
  readonly refused: readonly RefusedOrSkippedRunEntry[];
  /** Runs that are not removable candidates, with why. */
  readonly skipped: readonly RefusedOrSkippedRunEntry[];
  /** Removals whose post-removal journal append failed, one entry per removal with the failure reason. */
  readonly journalFailed: readonly ReapWorktreeJournalFailureEntry[];
};

export interface ReapLaneWorktreesPort {
  reapLaneWorktrees(request: ReapLaneWorktreesRequest): Promise<ReapLaneWorktreesResult>;
}
