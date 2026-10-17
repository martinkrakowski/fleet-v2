// @generated outbound contract scaffold — refined for migration step 1.
/**
 * WorkspacePort: prepare scoped Git worktrees and inspect them as typed
 * records without resetting user work. Worktree inspection belongs here, not
 * on the runner port; the first adapter uses reviewed Git subprocesses.
 */

import type { AttemptRunnerRecord } from '../../../domain/execution-records.js';

export interface WorktreeInspectionRequest {
  readonly worktreePath: string;
  readonly baseCommit: string;
  readonly expectedArtifactPaths: readonly string[];
  /**
   * H9b2. The attempt's recorded runner block, when the read is for a
   * recorded attempt: the recorded host is the truth, so the read goes
   * through that host's executor. A legacy record (no host name) keeps the
   * configured executor. Absent on reads that are not for a recorded
   * attempt.
   */
  readonly recordedHost?: AttemptRunnerRecord | null;
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

  /** Read a text file from the worktree, locally or remotely. Returns null if missing. */
  readWorktreeFile?(
    worktreePath: string,
    relativePath: string,
    recordedHost?: AttemptRunnerRecord | null,
  ): Promise<string | null>;
}
