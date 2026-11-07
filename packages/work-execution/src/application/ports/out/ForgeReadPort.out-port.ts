// @generated outbound contract scaffold — refined for lane AM4b-2.
/**
 * Read-only PR-state read port (AM4b-2): reads one pull request's state by
 * number or head branch without mutating anything. Used by auto-merge A13
 * and the conductor's reconcile; the work board (WB5c) adds the list read
 * here.
 */

/** One pull request, by number or by its head branch. */
export type PullRequestRef =
  | { readonly kind: 'number'; readonly number: number }
  | { readonly kind: 'branch'; readonly branchName: string };

/** Overrides the adapter's configured repository for one read. */
export interface ForgeRepositoryRef {
  readonly owner: string;
  readonly repo: string;
}

export interface ReadPullRequestRequest {
  readonly ref: PullRequestRef;
  readonly repository?: ForgeRepositoryRef;
  /**
   * Optional per-read timeout cap (ms). When set, the read is bounded to
   * `min(adapter normal timeout, timeoutMs)` so a pass's deadline is never
   * overrun by a re-read. The daemon merge path sets it from the remaining
   * budget.
   */
  readonly timeoutMs?: number;
}

export type PullRequestState = 'open' | 'merged' | 'closed';

/**
 * Whether the branch merges without conflict (clean), is behind the base
 * (behind), or is blocked by conflict or failing checks (blocked); unknown
 * when the forge does not answer.
 */
export type PullRequestMergeState = 'clean' | 'behind' | 'blocked' | 'unknown';

export interface PullRequestSnapshot {
  readonly number: number;
  readonly state: PullRequestState;
  /** The forge's merge state: CLEAN → clean, BEHIND → behind, BLOCKED/DIRTY/UNSTABLE → blocked, else unknown. */
  readonly mergeState: PullRequestMergeState;
  /** The PR's current head commit (40 hex). */
  readonly headSha: string;
  readonly headRef: string;
  readonly baseRef: string;
  /**
   * Whether the pull request's head branch lives in a repository other than
   * the base repository (a fork). Absent or unreadable is never read from the
   * forge: the adapter refuses the whole read, so a consumer never assumes
   * same-repository.
   */
  readonly isCrossRepository: boolean;
  /** The login of the head repository's owner; the same fail-closed rule as `isCrossRepository`. */
  readonly headRepositoryOwner: string;
  /** Set exactly when `state` is `merged`. */
  readonly mergedAtIso: string | null;
  readonly closedAtIso: string | null;
  readonly mergeCommitSha: string | null;
}

export type ReadPullRequestResult =
  | { readonly outcome: 'found'; readonly pullRequest: PullRequestSnapshot }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'unavailable'; readonly reason: string };

export interface ListOpenPullRequestsByBaseRequest {
  /** `main` or `chain/<name>`; anything else is unavailable (`invalid-request`). */
  readonly base: string;
  readonly repository?: ForgeRepositoryRef;
  /** Optional per-read timeout cap (ms), as for `ReadPullRequestRequest`. */
  readonly timeoutMs?: number;
}

/** One open pull request: number, head and base only; no title, body, author, label or path. */
export interface OpenPullRequestSummary {
  readonly number: number;
  readonly headSha: string;
  readonly baseRef: string;
}

/** A partial or unreadable answer is `unavailable`, never an empty list. */
export type ListOpenPullRequestsByBaseResult =
  | { readonly outcome: 'listed'; readonly pullRequests: readonly OpenPullRequestSummary[] }
  | { readonly outcome: 'unavailable'; readonly reason: string };

// --- CO20: read-only merged-PR CI cost --------------------------------------

export interface ReadPullRequestCiCostRequest {
  readonly pullRequestNumber: number;
  readonly repository?: ForgeRepositoryRef;
  /** Optional per-read timeout cap (ms), as for `ReadPullRequestRequest`. */
  readonly timeoutMs?: number;
}

/** One workflow's share of a merged pull request's CI cost. */
export interface WorkflowCiCost {
  readonly workflowName: string;
  readonly checkRuns: number;
  readonly billedMinutes: number;
}

/** The whole CI cost of one merged pull request. */
export interface PullRequestCiCost {
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly totalCheckRuns: number;
  readonly totalBilledMinutes: number;
  readonly workflows: readonly WorkflowCiCost[];
}

/** Fixed reason codes only: never a path, a stderr line or an error message. */
export type PullRequestCiCostUnavailableReason =
  | 'forge-not-configured'
  | 'invalid-request'
  | 'invalid-repository'
  | 'pull-request-not-merged'
  | 'different-pull-request'
  | 'ci-cost-timed-out'
  | 'ci-cost-failed'
  | 'ci-cost-too-large'
  | 'partial-ci-cost'
  | 'unreadable-ci-cost';

export type ReadPullRequestCiCostResult =
  | { readonly outcome: 'found'; readonly cost: PullRequestCiCost }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'unavailable'; readonly reason: PullRequestCiCostUnavailableReason };

// --- PT1ca: read-only open-PR changed files ---------------------------------

export { MAX_PULL_REQUEST_CHANGED_FILES } from '../../../domain/held-work-order.js';

export interface ReadPullRequestChangedFilesRequest {
  readonly pullRequestNumber: number;
  readonly repository?: ForgeRepositoryRef;
  /** Optional per-read timeout cap (ms), as for `ReadPullRequestRequest`. */
  readonly timeoutMs?: number;
}

/** Fixed reason codes only: never a path, a stderr line or an error message. */
export type PullRequestChangedFilesUnknownReason =
  | 'forge-not-configured'
  | 'invalid-request'
  | 'invalid-repository'
  | 'files-timed-out'
  | 'files-failed'
  | 'files-too-large'
  | 'too-many-files'
  | 'unreadable-files';

/** A failed, partial, oversized or unscreened read is `unknown`, never an empty list. */
export type ReadPullRequestChangedFilesResult =
  | {
      readonly outcome: 'found';
      readonly files: readonly string[];
    }
  | {
      readonly outcome: 'unknown';
      readonly reason: PullRequestChangedFilesUnknownReason;
    };

export interface ForgeReadPort {
  /**
   * Read one pull request's changed file paths (at most
   * `MAX_PULL_REQUEST_CHANGED_FILES`, every path screened); mutates nothing.
   * Anything that cannot be read in full is `unknown`, never an empty list.
   */
  readPullRequestChangedFiles?(
    request: ReadPullRequestChangedFilesRequest,
  ): Promise<ReadPullRequestChangedFilesResult>;
  /**
   * Read one merged pull request's CI cost (check runs and billed minutes per
   * workflow), fully paginated; mutates nothing. An unreadable or partial
   * answer is unavailable, never an empty list or zero.
   */
  readPullRequestCiCost?(request: ReadPullRequestCiCostRequest): Promise<ReadPullRequestCiCostResult>;
  /** Read one pull request's state; mutates nothing. */
  readPullRequest(request: ReadPullRequestRequest): Promise<ReadPullRequestResult>;
  /**
   * List every open pull request against one base branch (fully paginated);
   * mutates nothing.
   */
  listOpenPullRequestsByBase(request: ListOpenPullRequestsByBaseRequest): Promise<ListOpenPullRequestsByBaseResult>;
  /** Whether a transport and a repository are configured. */
  isConfigured(): boolean;
}
