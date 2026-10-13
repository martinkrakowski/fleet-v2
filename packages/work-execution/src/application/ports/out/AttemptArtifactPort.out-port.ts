// @generated outbound contract scaffold — refined for migration step 1.
/**
 * AttemptArtifactPort: place frozen briefs and templates under verified
 * ignored paths and collect bounded immutable artifacts after lane completion.
 */

import type { CommandCompletionReceipt } from './ExecutionRunnerPort.out-port.js';

export interface PlaceFrozenBriefRequest {
  readonly attemptId: string;
  readonly worktreePath: string;
  readonly proseMarkdown: string;
  readonly manifestJson: string;
}

/** Paths must be ignored by the worktree's index before the package is placed. */
export type PlaceFrozenBriefResult =
  | {
      readonly outcome: 'placed';
      readonly prosePath: string;
      readonly manifestPath: string;
    }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface VerifyIgnoredPathsRequest {
  readonly worktreePath: string;
  readonly candidatePaths: readonly string[];
}

export type VerifyIgnoredPathsResult =
  | { readonly outcome: 'ignored'; readonly checkedPaths: readonly string[] }
  | { readonly outcome: 'not-ignored'; readonly offendingPaths: readonly string[] };

export interface CollectCompletedAttemptArtifactsRequest {
  readonly attemptId: string;
  readonly worktreePath: string;
  readonly baseCommit: string;
  readonly expectedArtifactPaths: readonly string[];
  readonly completionReceipt: CommandCompletionReceipt;
}

export interface CollectedAttemptArtifacts {
  readonly headCommit: string;
  readonly commitsSinceBase: readonly string[];
  readonly collectedArtifactPaths: readonly string[];
  /** Missing notes are recorded explicitly; absence is a fact, not an error. */
  readonly notes: 'present' | 'missing';
}

export type CollectCompletedAttemptArtifactsResult =
  | { readonly outcome: 'collected'; readonly artifacts: CollectedAttemptArtifacts }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface AttemptArtifactPort {
  /** Verify candidate paths are ignored before placing anything in the worktree. */
  verifyIgnoredPaths(request: VerifyIgnoredPathsRequest): Promise<VerifyIgnoredPathsResult>;

  /** Place the frozen brief package in the ignored worktree path. */
  placeFrozenBrief(request: PlaceFrozenBriefRequest): Promise<PlaceFrozenBriefResult>;

  /** Collect artifacts only after an authoritative matching completion. */
  collectCompletedAttemptArtifacts(
    request: CollectCompletedAttemptArtifactsRequest,
  ): Promise<CollectCompletedAttemptArtifactsResult>;
}
