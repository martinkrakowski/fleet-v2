// @generated inbound contract scaffold — refined for lane CO27.
/**
 * SaveLaneEditsPort: save one lane worktree's edits before any abort (cutover
 * plan CO27, §4 step 5, invariants I2 and I7). It refuses a busy worktree (a
 * runner session still live there), an unreadable tree or a lane diff check
 * with a finding; otherwise it records the intent under
 * `relaunch/<planDigest>/<lane>/save`, writes a save ref on the lane host's
 * clone without pushing, re-reads the ref, verifies that its tree digest equals
 * the worktree's and records the result. A repeat with the same key returns the
 * recorded save. It never resets, removes or aborts anything; the result
 * carries ids, codes and digests only — never a path, a line or a matched value.
 */

import type { AttemptRunnerRecord } from '../../../domain/execution-records.js';
import type { LaneDiffSecretPattern } from '../../../domain/lane-diff-check.js';

export interface SaveLaneEditsRequest {
  /** Hex digest of the relaunch plan (7–64 lowercase hex chars). */
  readonly planDigest: string;
  /** The lane id inside that plan. */
  readonly laneId: string;
  /** The recorded attempt, when the lane has one. */
  readonly attemptId: string | null;
  /** Absolute path of the lane worktree on the recorded host. */
  readonly worktreePath: string;
  /** Absolute path of the lane clone on the recorded host. */
  readonly clonePath: string;
  /** The recorded host block; null means no recorded host and is refused. */
  readonly recordedHost: AttemptRunnerRecord | null;
  /** 40–64 hex chars: the dispatch base. */
  readonly baseCommit: string;
  /** From the frozen brief. */
  readonly allowedPathPrefixes: readonly string[];
  readonly policyProtectedPaths?: readonly string[];
  readonly secretPatterns?: readonly LaneDiffSecretPattern[];
  /** ISO 8601 with an explicit zone. */
  readonly nowIso: string;
}

export type SaveLaneEditsRefusalCode =
  | 'invalid-request'
  | 'worktree-busy'
  | 'worktree-state-unknown'
  | 'diff-check-error'
  | 'diff-check-findings'
  | 'journal-unavailable'
  | 'journal-unreadable'
  | 'save-refused'
  | 'save-unknown'
  | 'tree-digest-mismatch';

export type SaveLaneEditsResult =
  | {
      readonly outcome: 'saved' | 'already-saved';
      readonly planDigest: string;
      readonly laneId: string;
      readonly journalKey: string;
      readonly saveRef: string;
      readonly commitId: string;
      readonly treeDigest: string;
    }
  | {
      readonly outcome: 'refused';
      readonly reason: SaveLaneEditsRefusalCode;
      /** Counts by rule code, or fixed tokens. Never a path, a line or a matched value. */
      readonly detail: Readonly<Record<string, number | string>> | null;
    }
  | { readonly outcome: 'unknown'; readonly reason: 'save-unknown' };

export interface SaveLaneEditsPort {
  /** Never throws on runtime input; an invalid request is a typed refusal. */
  saveLaneEdits(request: SaveLaneEditsRequest): Promise<SaveLaneEditsResult>;
}
