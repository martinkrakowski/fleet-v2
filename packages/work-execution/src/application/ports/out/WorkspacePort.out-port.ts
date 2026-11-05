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

/**
 * GB3: the request to preserve a refused dispatch's uncommitted tracked edits
 * as a patch file outside the worktree. The worktree root and the patch
 * destination's parent are canonicalized on the recorded host before any
 * command runs, and a destination that resolves inside the worktree, already
 * exists or is a symlink is refused before anything is written.
 */
export interface PreserveWorktreeEditsRequest {
  /** The attempt's recorded worktree root (absolute). */
  readonly worktreePath: string;
  /** Absolute path OUTSIDE the worktree where the patch file is written. */
  readonly patchPath: string;
  /** The attempt's recorded runner block: the preserve runs on that host's executor. */
  readonly recordedHost?: AttemptRunnerRecord | null;
}

export type PreserveWorktreeEditsResult =
  | { readonly outcome: 'preserved'; readonly patchPath: string; readonly patchBytes: number }
  | {
      readonly outcome: 'refused';
      readonly reason:
        | 'invalid-request'
        | 'patch-path-inside-worktree'
        | 'nothing-to-preserve'
        | 'destination-exists'
        | 'git-refused';
    }
  | { readonly outcome: 'error'; readonly reason: string };

/**
 * GB3: the request to discard one worktree's uncommitted tracked edits back to
 * its recorded head. The reset runs on the recorded host's executor and is
 * refused before it runs when restoring a tracked path could overwrite or
 * remove an untracked path; untracked files stay untouched.
 */
export interface ResetWorktreeToHeadRequest {
  /** The attempt's recorded worktree root (absolute). */
  readonly worktreePath: string;
  /** The attempt's recorded runner block: the reset runs on that host's executor. */
  readonly recordedHost?: AttemptRunnerRecord | null;
}

export type ResetWorktreeToHeadResult =
  | { readonly outcome: 'reset'; readonly headCommit: string }
  | {
      readonly outcome: 'refused';
      readonly reason: 'invalid-request' | 'untracked-obstructs' | 'git-refused';
    }
  | { readonly outcome: 'error'; readonly reason: string };

/**
 * GB3: the request to verify whether a preserved patch matches the worktree
 * (`git apply --check -R <patchPath>`).
 */
export interface VerifySavedPatchRequest {
  /** The attempt's recorded worktree root (absolute). */
  readonly worktreePath: string;
  /** Absolute path OUTSIDE the worktree where the patch file was preserved. */
  readonly patchPath: string;
  /** The attempt's recorded runner block: the check runs on that host's executor. */
  readonly recordedHost?: AttemptRunnerRecord | null;
}

/**
 * KW2 (D18): the request to list one registered clone's worktrees. The read
 * runs on the recorded host's executor. A clone that is not registered is
 * never read (D18: no host-wide scan, no unregistered repository).
 */
export interface ListWorktreesRequest {
  /** The registered clone to list (absolute, normalised). */
  readonly repositoryRoot: string;
  /** The attempt's recorded runner block: the read runs on that host's executor. */
  readonly recordedHost?: AttemptRunnerRecord | null;
}

/** One worktree of one clone, as `git worktree list --porcelain` reports it. */
export interface ListedWorktree {
  /** The worktree path as git lists it (absolute). */
  readonly path: string;
  /** The entry's HEAD sha, or null when the list carried none. */
  readonly head: string | null;
  /** The checked-out branch without `refs/heads/`, or null when detached. */
  readonly branch: string | null;
  /** The worktree is locked (`git worktree lock`); the reaper never touches it. */
  readonly locked: boolean;
  /** The administrative entry is stale (its directory is gone); never pruned here. */
  readonly prunable: boolean;
}

export type ListWorktreesResult =
  | { readonly outcome: 'listed'; readonly worktrees: readonly ListedWorktree[] }
  /** The command did not answer, or answered unreadably: nothing is known. */
  | { readonly outcome: 'unknown'; readonly reason: string };

/**
 * KW2 (D18): the request to read one worktree's removal facts. Every fact is
 * true, false or unknown, and unknown is never true (conductor plan §3.10.2).
 */
export interface InspectWorktreeForRemovalRequest {
  /** The registered clone the worktree belongs to (absolute, normalised). */
  readonly repositoryRoot: string;
  /** The worktree to inspect (absolute, normalised). */
  readonly worktreePath: string;
  /** The repository's remote-tracking default branch, e.g. `origin/main`. */
  readonly defaultRef: string;
  /** The attempt's recorded runner block: the read runs on that host's executor. */
  readonly recordedHost?: AttemptRunnerRecord | null;
}

/** One worktree's porcelain status, counted. Ignored paths are never counted. */
export interface WorktreeStatusCounts {
  /** Tracked paths with a change (staged or not), unmerged paths excluded. */
  readonly tracked: number;
  /** Untracked paths (`??`). */
  readonly untracked: number;
  /** Paths in a merge state (`UU`, `AA`, `DD`, `AU`, `UA`, `DU`, `UD`). */
  readonly unmerged: number;
}

/** One worktree's last activity: the newest of the reflog, the index and the tree walk. */
export interface WorktreeLastActivity {
  /** The newest activity time as an ISO 8601 string, or null when none was readable. */
  readonly iso: string | null;
  /** The bounded tree walk did not finish (or a read was unreadable): `quiet` is unknown, never true. */
  readonly unknown: boolean;
}

/** Every fact the reaper needs about one worktree. */
export interface WorktreeRemovalFacts {
  readonly path: string;
  readonly head: string | null;
  /** The checked-out branch, or null when HEAD is detached. */
  readonly branch: string | null;
  readonly detached: boolean;
  /** HEAD is reachable from `defaultRef`; null when the answer is unknown. */
  readonly headOnDefault: boolean | null;
  readonly status: WorktreeStatusCounts;
  readonly locked: boolean;
  /** The in-progress operation files present in the worktree's git directory. */
  readonly inProgressOperations: readonly string[];
  readonly lastActivity: WorktreeLastActivity;
  /** The worktree's size in bytes, or null when the measurement ran out of budget. */
  readonly sizeBytes: number | null;
}

export type InspectWorktreeForRemovalResult =
  | { readonly outcome: 'inspected'; readonly facts: WorktreeRemovalFacts }
  | { readonly outcome: 'refused'; readonly reason: 'invalid-request' | 'not-a-linked-worktree' }
  | { readonly outcome: 'unknown'; readonly reason: string };

/**
 * KW2: the request to read the free space of the filesystem holding a path.
 */
export interface ReadFilesystemSpaceRequest {
  /** An absolute path on the filesystem to measure. */
  readonly path: string;
  /** The attempt's recorded runner block: the read runs on that host's executor. */
  readonly recordedHost?: AttemptRunnerRecord | null;
}

export type ReadFilesystemSpaceResult =
  | { readonly outcome: 'read'; readonly freeBytes: number; readonly totalBytes: number }
  | { readonly outcome: 'unknown'; readonly reason: string };

export interface WorkspacePort {
  /** Inspect the worktree as a typed record; part of readiness, once per prepared environment. */
  inspectWorktree(request: WorktreeInspectionRequest): Promise<WorktreeInspection>;

  /**
   * GB3: preserve the worktree's uncommitted tracked edits as a patch file
   * outside it (`git diff --binary HEAD`). Refuses before any command when the
   * patch path is not absolute, lies inside the worktree (including through a
   * symlink alias of its parent) or already exists; writes atomically without
   * following links or overwriting files.
   */
  preserveWorktreeEdits?(request: PreserveWorktreeEditsRequest): Promise<PreserveWorktreeEditsResult>;

  /**
   * GB3: verify that one preserved patch matches the worktree
   * (`git apply --check -R <patchPath>`).
   */
  verifySavedPatch?(request: VerifySavedPatchRequest): Promise<boolean>;

  /**
   * GB3: discard the worktree's tracked modifications back to HEAD
   * (`git reset --hard`, no ref argument), leaving untracked files untouched.
   * Refuses before resetting when restoring a tracked path would overwrite or
   * remove an untracked path; after resetting, verifies the untracked paths
   * are unchanged.
   */
  resetWorktreeToHead?(request: ResetWorktreeToHeadRequest): Promise<ResetWorktreeToHeadResult>;

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

  /**
   * KW2 (D18): list one registered clone's worktrees. Read-only: it never
   * prunes, removes, locks or fetches anything, and it never scans a host.
   */
  listWorktrees?(request: ListWorktreesRequest): Promise<ListWorktreesResult>;

  /**
   * KW2 (D18): read one worktree's removal facts — HEAD, branch or detached,
   * the ancestor answer against the default branch, the porcelain status
   * counts, the lock, the in-progress operations, the last activity and the
   * budgeted size.
   */
  inspectWorktreeForRemoval?(
    request: InspectWorktreeForRemovalRequest,
  ): Promise<InspectWorktreeForRemovalResult>;

  /**
   * KW2: read the free and total bytes of the filesystem holding a path.
   */
  readFilesystemSpace?(
    request: ReadFilesystemSpaceRequest,
  ): Promise<ReadFilesystemSpaceResult>;
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
