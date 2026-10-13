// @generated outbound contract scaffold — refined for migration step 1.
/**
 * WorkspacePort: prepare scoped Git worktrees and inspect them as typed
 * records without resetting user work. Worktree inspection belongs here, not
 * on the runner port; the first adapter uses reviewed Git subprocesses.
 */

export interface WorktreeInspectionRequest {
  readonly worktreePath: string;
  readonly baseCommit: string;
  readonly expectedArtifactPaths: readonly string[];
}

/**
 * Worktree inspection reported as a typed record, never as prose logs. Readiness
 * is not complete without this inspection (see docs/runbooks/runner-readiness.md).
 */
export interface WorktreeInspection {
  readonly worktreePath: string;
  readonly checkedOutCommit: string;
  readonly matchesBaseCommit: boolean;
  readonly uncommittedPaths: readonly string[];
  readonly untrackedPaths: readonly string[];
  readonly residueFromEarlierAttempts: readonly string[];
  readonly missingExpectedArtifacts: readonly string[];
}

export interface WorkspacePort {
  /** Inspect the worktree as a typed record; part of readiness, once per prepared environment. */
  inspectWorktree(request: WorktreeInspectionRequest): Promise<WorktreeInspection>;
}
