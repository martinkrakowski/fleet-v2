// @generated outbound contract scaffold — refined for KS4a (warm worktree pool, D35).
/**
 * WorktreePoolPort: keep warm, ready worktrees per project so a lane run
 * starts on a prepared worktree instead of waiting for create, install and
 * build. The adapter (KS4b) owns the host executor work; this contract only
 * fixes what the pool takes, resets and refills.
 */

import type { AttemptRunnerRecord } from '../../../domain/execution-records.js';
import type { WorktreePoolEntryRecord } from '../../../domain/worktree-pool-records.js';

/** The request to take one warm worktree out of the project's pool. */
export interface TakeWarmWorktreeRequest {
  /** The pool's project. */
  readonly projectId: string;
  /** 40 lowercase hex: the base the caller will run at. */
  readonly baseCommit: string;
  /** The admitted run, when known. */
  readonly runId?: string | null;
  /**
   * The recorded host the pool must work on. The contract requires it: the
   * pool never substitutes its own host, so a caller without a recorded host
   * is refused rather than served from a wrong clone.
   */
  readonly recordedHost: AttemptRunnerRecord;
}

export type TakeWarmWorktreeResult =
  | { readonly outcome: 'taken'; readonly entry: WorktreePoolEntryRecord }
  /** The pool had nothing warm for the project. */
  | { readonly outcome: 'empty' }
  | { readonly outcome: 'refused'; readonly reason: 'invalid-request' };

/** The request to move one pooled worktree back to a base commit. */
export interface ResetWorktreeToBaseRequest {
  /** Absolute path of a worktree the pool handed out. */
  readonly worktreePath: string;
  /** 40 lowercase hex: the base to move it to. */
  readonly baseCommit: string;
  /**
   * The recorded host the pool must work on. The contract requires it: the
   * pool never substitutes its own host, so a caller without a recorded host
   * is refused rather than reset on a wrong clone.
   */
  readonly recordedHost: AttemptRunnerRecord;
}

export type ResetWorktreeToBaseResult =
  | { readonly outcome: 'reset'; readonly entry: WorktreePoolEntryRecord }
  | {
      readonly outcome: 'refused';
      readonly reason: 'invalid-request' | 'unknown-worktree' | 'not-accounted-for';
    }
  /** The executor did not answer: nothing is known. */
  | { readonly outcome: 'unknown' };

/** The request to refill a project's pool after a merge moved its base. */
export interface RefillWorktreePoolRequest {
  /** The pool's project. */
  readonly projectId: string;
  /** 40 lowercase hex: the commit the merge moved the project to. */
  readonly mergedBaseCommit: string;
  /**
   * The recorded host the pool must work on. The contract requires it: the
   * pool never substitutes its own host, so a caller without a recorded host
   * is refused rather than refilled on a wrong clone.
   */
  readonly recordedHost: AttemptRunnerRecord;
}

export type RefillWorktreePoolResult =
  | { readonly outcome: 'refilled'; readonly entries: readonly WorktreePoolEntryRecord[] }
  | { readonly outcome: 'refused'; readonly reason: 'invalid-request' | 'pool-full' }
  | { readonly outcome: 'unknown' };

export interface WorktreePoolPort {
  // Optional until KS4b implements the adapter; the generated empty stub must keep type-checking.
  take?(request: TakeWarmWorktreeRequest): Promise<TakeWarmWorktreeResult>;
  resetToBase?(request: ResetWorktreeToBaseRequest): Promise<ResetWorktreeToBaseResult>;
  refillAfterMerge?(request: RefillWorktreePoolRequest): Promise<RefillWorktreePoolResult>;
}
