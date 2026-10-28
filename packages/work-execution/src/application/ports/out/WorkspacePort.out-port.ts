// @generated outbound contract scaffold — refined for migration step 1.
/**
 * WorkspacePort: prepare scoped Git worktrees and inspect them as typed
 * records without resetting user work. Worktree inspection belongs here, not
 * on the runner port; the first adapter uses reviewed Git subprocesses. The
 * edit-only commit (stage the change set, commit it on the checked-out
 * branch, move the branch by compare-and-swap) is the one write this port
 * makes.
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

/**
 * One edit-only commit (plan §3.3; 2026-10-16 plan, "Edit-only flow" step 4).
 */
export interface CommitLaneOutputRequest {
  readonly worktreePath: string;
  /** The HEAD the lane was dispatched on: 40 or 64 lowercase hex. The commit's only parent. */
  readonly expectedHead: string;
  /** The attempt id, written as the `Fleet-Attempt` trailer. */
  readonly attemptId: string;
  /** The model that implemented the change, written as `Implemented-By: agy <model>`. */
  readonly implementerModel: string;
  /**
   * The frozen brief's allowed path prefixes. The staged tree is re-checked
   * against them after staging, so a file written between the diff check and
   * staging is never committed; at least one non-empty string is required.
   */
  readonly allowedPathPrefixes: readonly string[];
  /** The attempt's recorded runner block: the commit runs on that host's executor. */
  readonly recordedHost?: AttemptRunnerRecord | null;
}

export type CommitLaneOutputRefusal =
  | 'invalid-request'
  | 'outside-allowed-paths'
  | 'head-moved'
  | 'detached-head'
  | 'ref-moved';

export type CommitLaneOutputResult =
  | { readonly outcome: 'committed'; readonly headCommit: string; readonly branchRef: string }
  /** HEAD is already this attempt's commit on top of `expectedHead` (a crash after the commit). */
  | { readonly outcome: 'already-committed'; readonly headCommit: string; readonly branchRef: string }
  /** The staged tree equals HEAD's tree: the lane changed nothing. */
  | { readonly outcome: 'nothing-to-commit' }
  | { readonly outcome: 'refused'; readonly reason: CommitLaneOutputRefusal }
  /** A git command failed or ended without an exit code; nothing is known to have moved. */
  | { readonly outcome: 'error'; readonly reason: string };

export interface WorkspacePort {
  /** Inspect the worktree as a typed record; part of readiness, once per prepared environment. */
  inspectWorktree(request: WorktreeInspectionRequest): Promise<WorktreeInspection>;

  /** Read a text file from the worktree, locally or remotely. Returns null if missing. */
  readWorktreeFile?(
    worktreePath: string,
    relativePath: string,
    recordedHost?: AttemptRunnerRecord | null,
  ): Promise<string | null>;

  /**
   * Edit-only seats only (plan §3.3): stage the worktree's change set and
   * commit it on the checked-out branch, with `expectedHead` as the only
   * parent, moving the branch by compare-and-swap. Never pushes.
   */
  commitLaneOutput?(request: CommitLaneOutputRequest): Promise<CommitLaneOutputResult>;
}

/**
 * Thrown when a worktree file read is asked for a path that is not a safe
 * worktree-relative path (absolute, `..` escape, NUL, or not a non-empty
 * string). The read is refused before any command runs, so the runner host
 * never sees the path.
 */
export class WorktreePathRefusedError extends Error {
  readonly relativePath: string;

  constructor(relativePath: string, reason: string) {
    super(`Refused worktree-relative path ${relativePath}: ${reason}`);
    this.name = 'WorktreePathRefusedError';
    this.relativePath = relativePath;
  }
}
