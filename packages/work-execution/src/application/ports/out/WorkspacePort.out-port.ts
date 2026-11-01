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
import type { BaseBranchValue } from '../../../domain/base-branch.js';

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

/**
 * K7-5a (owner decision K7-D7, "Start reserves first"): the request to create
 * one lane run's worktree at exactly the path the capacity reserve chose, on
 * a new branch at the work order's base, in the project profile's clone on
 * the reserved host.
 */
export interface PrepareLaneWorktreeRequest {
  /** The project profile's clone on the reserved host (absolute, normalised). */
  readonly clonePath: string;
  /** The reservation's worktree path (absolute, normalised, outside the clone). */
  readonly worktreePath: string;
  /** 'fleet/' + runId. */
  readonly branch: string;
  /** 40 lowercase hex: the work order's base. */
  readonly baseCommit: string;
  /** Routes the executor to the reserved host. */
  readonly recordedHost: AttemptRunnerRecord;
}

export type PrepareLaneWorktreeResult =
  | { readonly outcome: 'prepared' }
  /**
   * The path is already a worktree of this clone on `branch`, HEAD at
   * `baseCommit`, nothing uncommitted or untracked.
   */
  | { readonly outcome: 'already-prepared' }
  | {
      readonly outcome: 'refused';
      readonly reason: 'invalid-request' | 'path-exists-other' | 'branch-exists-other' | 'git-refused';
    }
  /** The executor did not answer (timeout, transport): the worktree may or may not exist. */
  | { readonly outcome: 'unknown' };

/**
 * CB-D2 (CB2): the request to resolve the tip of one lane run's base branch
 * on the forge, through the reserved host's executor, at start time. The
 * answer feeds the worktree's base commit and the frozen brief, so the
 * run's chain link starts exactly at its base's tip.
 */
export interface ResolveBaseTipRequest {
  /** The project profile's clone on the reserved host (absolute, normalised). */
  readonly clonePath: string;
  /** The resolved base branch (`main` or `chain/<name>`). */
  readonly baseBranch: BaseBranchValue;
  /** Routes the executor to the reserved host. */
  readonly recordedHost: AttemptRunnerRecord;
}

export type ResolveBaseTipResult =
  | { readonly outcome: 'resolved'; readonly tip: string }
  /** The base branch does not exist on the forge; never a fallback to `main`. */
  | { readonly outcome: 'missing' }
  /** The executor did not answer (timeout, transport): nothing is known. */
  | { readonly outcome: 'unknown' }
  | { readonly outcome: 'refused'; readonly reason: 'invalid-request' };

/**
 * EX-2a (D17): the request to remove one finished lane run's worktree. The
 * branch is the record of the run and is never touched; only the worktree
 * directory goes.
 */
export interface RemoveLaneWorktreeRequest {
  /** The project profile's clone the worktree belongs to (absolute, normalised). */
  readonly clonePath: string;
  /** The worktree root the worktree path must sit under (absolute, normalised). */
  readonly worktreeRoot: string;
  /** The worktree to remove (absolute, normalised, under `worktreeRoot`). */
  readonly worktreePath: string;
  /** The lane-run branch the worktree must be checked out on. */
  readonly branch: string;
  /** The attempt's recorded runner block: the removal runs on that host's executor. */
  readonly recordedHost: AttemptRunnerRecord;
}

export type RemoveLaneWorktreeResult =
  /** Removed; `branchTip` is the listed HEAD sha the removal answered. The branch is kept. */
  | { readonly outcome: 'removed'; readonly branchTip: string }
  /** The path is gone: nothing to remove. */
  | { readonly outcome: 'already-removed' }
  | {
      readonly outcome: 'refused';
      readonly reason:
        | 'invalid-request'
        | 'not-a-worktree'
        | 'branch-mismatch'
        | 'locked'
        | 'dirty'
        | 'git-refused';
    }
  /** The executor did not answer (timeout, transport): the worktree may or may not be removed. */
  | { readonly outcome: 'unknown' };

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

  /**
   * K7-5a (K7-D7): create the run's worktree at the reserved path on a new
   * branch at the base; never forces, never removes, never resets. A
   * worktree already prepared exactly this way reads as `already-prepared`,
   * so a retried start is safe.
   */
  prepareLaneWorktree?(request: PrepareLaneWorktreeRequest): Promise<PrepareLaneWorktreeResult>;

  /**
   * CB-D2 (CB2): resolve the tip of the run's base branch on the forge,
   * through the reserved host's executor. A base branch that does not exist
   * on the forge is `missing`, never a fallback to `main`.
   */
  resolveBaseTip?(request: ResolveBaseTipRequest): Promise<ResolveBaseTipResult>;

  /**
   * EX-2a (D17): remove one finished lane run's clean worktree, keeping its
   * branch. The Rules: never `--force`, never delete or touch a branch,
   * never `prune`, never `worktree move` — the only write is `git worktree
   * remove <path>` with no flags. Every command runs through the recorded
   * host's executor: when the recorded host is not named, or no host
   * executor is configured, nothing runs. A path git does not list as a
   * worktree of the clone, a locked worktree, a dirty worktree or a
   * worktree checked out on a branch other than the requested one is
   * refused, never removed. Gitdir linkage is proven by the `worktree list`
   * check: git itself lists the path as a worktree of this clone (E6,
   * conductor-plan :146).
   */
  removeLaneWorktree?(request: RemoveLaneWorktreeRequest): Promise<RemoveLaneWorktreeResult>;
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
