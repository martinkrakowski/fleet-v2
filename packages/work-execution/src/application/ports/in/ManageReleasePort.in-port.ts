// @generated inbound contract scaffold — refined for lane CO14.
/**
 * ManageReleasePort installs, swaps and rolls back the built fleet-v2 release
 * that a scheduler unit executes through the `current` pointer. Without
 * `apply` it only reports the plan; with `apply` it needs a recorded owner
 * grant for this release action at the target sha (resolved and consumed
 * through ActionAuthorizationPort, never a free-text token) and it holds the
 * conductor driver lease from just before the repoint through the repoint, so
 * nothing is repointed while a driver is live. It never installs or edits a
 * scheduler unit, and no result carries a path or a grant id.
 */

export type ReleaseAction = 'install' | 'swap' | 'rollback';

export interface ManageReleaseRequest {
  readonly action: ReleaseAction;
  /** Absolute release root; holds <sha> build dirs and the `current` symlink. */
  readonly root: string;
  /** 40 lowercase hex; required for install and swap, null for rollback. */
  readonly sha: string | null;
  /** Absolute checkout of the fleet-v2 repo to build from; install only. */
  readonly source: string | null;
  /** How many verified builds to keep (>= 2). */
  readonly keep: number;
  readonly apply: boolean;
  /**
   * The coordination project whose recorded owner grants are consulted;
   * required when apply is true. It names where the grant lives, it is not
   * itself authority: the grant must be recorded, approved, unconsumed and
   * scoped to `release:<action>` at the target sha.
   */
  readonly projectId: string | null;
}

export type ManageReleaseRefusal =
  | 'invalid-request'
  | 'release-root-state-dir-unknown'
  | 'authority-required'
  | 'authority-refused'
  | 'authority-unknown'
  | 'current-moved'
  | 'driver-lease-live'
  | 'lease-unknown'
  | 'not-found'
  | 'build-failed'
  | 'verify-failed'
  | 'store-unreadable'
  | 'failed';

export interface ManageReleasePlan {
  readonly outcome: 'planned';
  readonly action: ReleaseAction;
  readonly target: string | null;
  readonly current: string | null;
  readonly previous: string | null;
  readonly kept: readonly string[];
  readonly wouldPrune: readonly string[];
  readonly lease: 'live' | 'free';
}

export interface ManageReleaseApplied {
  readonly outcome: 'applied';
  readonly action: ReleaseAction;
  readonly target: string;
  readonly current: string;
  readonly kept: readonly string[];
  readonly pruned: readonly string[];
  /** `unreadable` means the retention cleanup did not complete; never a silent success. */
  readonly pruneOutcome: 'pruned' | 'unreadable';
  readonly rebuilt: boolean;
}

export type ManageReleaseResult =
  | { readonly outcome: 'refused'; readonly reason: ManageReleaseRefusal }
  | ManageReleasePlan
  | ManageReleaseApplied;

export interface ManageReleasePort {
  manageRelease(request: ManageReleaseRequest): Promise<ManageReleaseResult>;
}
