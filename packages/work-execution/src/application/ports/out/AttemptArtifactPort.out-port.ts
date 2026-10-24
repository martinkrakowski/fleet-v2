// @generated outbound contract scaffold — refined for migration step 1.
/**
 * AttemptArtifactPort: place frozen briefs and templates under verified
 * ignored paths and collect bounded immutable artifacts after lane completion.
 */

import type {
  AttemptRunnerRecord,
  CollectedAttemptArtifacts,
  CommandCompletionReceipt,
} from '../../../domain/execution-records.js';

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
  /**
   * H9b2. The attempt's recorded runner block: the recorded host is the
   * truth, so the artifact read goes through that host's executor. A legacy
   * record (no host name) keeps the configured executor.
   */
  readonly recordedHost?: AttemptRunnerRecord | null;
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

  /** Read a brief manifest from the worktree, locally or remotely. Returns null if missing. */
  readBriefManifest?(
    worktreePath: string,
    manifestPath?: string,
    recordedHost?: AttemptRunnerRecord | null,
  ): Promise<string | null>;

  /**
   * Read one worktree-relative brief file (for example the frozen prose at
   * `.lane/brief.md`), locally or remotely, with the same containment and
   * null-if-missing contract as `readBriefManifest`. Returns null if missing.
   */
  readBriefFile?(
    worktreePath: string,
    relativePath: string,
    recordedHost?: AttemptRunnerRecord | null,
  ): Promise<string | null>;
}
