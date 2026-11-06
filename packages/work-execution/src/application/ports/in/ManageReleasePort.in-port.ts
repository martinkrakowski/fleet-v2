// @generated inbound contract scaffold — refined for lane CO14.
/**
 * ManageReleasePort installs, swaps and rolls back the built fleet-v2 release
 * that a scheduler unit executes through the `current` pointer. Without
 * `apply` it only reports the plan; with `apply` it needs explicit deployment
 * authority and a conductor driver lease that is not live. It never installs
 * or edits a scheduler unit, and no result carries a path or the authority.
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
  /** Explicit deployment authority; required when apply is true. */
  readonly authority: string | null;
}

export type ManageReleaseRefusal =
  | 'invalid-request'
  | 'authority-required'
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
