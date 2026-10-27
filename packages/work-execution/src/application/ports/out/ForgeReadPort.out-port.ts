// @generated outbound contract scaffold — refined for lane AM4b-2.
/**
 * Read-only PR-state read port (AM4b-2): reads one pull request's state by
 * number or head branch without mutating anything. Used by auto-merge A13
 * and the conductor's reconcile; the work board (WB5c) adds the list read
 * here.
 */

/** One pull request, by number or by its head branch. */
export type ForgePullRequestRef =
  | { readonly kind: 'number'; readonly number: number }
  | { readonly kind: 'branch'; readonly branchName: string };

/** Overrides the adapter's configured repository for one read. */
export interface ForgeRepositoryRef {
  readonly owner: string;
  readonly repo: string;
}

export interface ReadPullRequestRequest {
  readonly ref: ForgePullRequestRef;
  readonly repository?: ForgeRepositoryRef;
}

export type PullRequestState = 'open' | 'merged' | 'closed';

export interface PullRequestSnapshot {
  readonly number: number;
  readonly state: PullRequestState;
  /** The PR's current head commit (40 hex). */
  readonly headSha: string;
  readonly headRef: string;
  readonly baseRef: string;
  /** Set exactly when `state` is `merged`. */
  readonly mergedAtIso: string | null;
  readonly closedAtIso: string | null;
  readonly mergeCommitSha: string | null;
}

export type ReadPullRequestResult =
  | { readonly outcome: 'found'; readonly pullRequest: PullRequestSnapshot }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'unavailable'; readonly reason: string };

export interface ForgeReadPort {
  /** Read one pull request's state; mutates nothing. */
  readPullRequest(request: ReadPullRequestRequest): Promise<ReadPullRequestResult>;
  /** Whether a transport and a repository are configured. */
  isConfigured(): boolean;
}
