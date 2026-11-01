// @generated outbound contract scaffold — refined for lane DT5.
/**
 * ForgeMergeReadPort reads the merge pass's forge facts for one exact head
 * (daemon-tick plan §3.3): PR state and live head, merge state status,
 * required contexts by name with creator login, and fully paginated review
 * threads. Every fact is read fail-closed: an unreadable or unknown answer
 * is never presented as complete, and `unknown` never merges.
 */

/** One repository the merge pass reads forge facts for. */
export interface ForgeMergeRepositoryRef {
  readonly owner: string;
  readonly repo: string;
}

export interface ReadForgeMergeRequest {
  readonly repository: ForgeMergeRepositoryRef;
  readonly pullRequestNumber: number;
  /**
   * The exact head the facts must be read at. The adapter reports the live
   * head; the decider compares it to this value itself (plan §3.3).
   */
  readonly headSha: string;
  /** Required context names at the exact head (default `['gate', 'premerge']`). */
  readonly requiredContexts: readonly string[];
  /** The D-DT8 poster identity; required to judge `premerge`. */
  readonly posterLogin?: string;
  /** The tick's start; the adapter's clock supplies fresher time for later pages. */
  readonly nowIso: string;
  /** Budget rule: every call takes min(timeoutMs, deadlineIso − now). */
  readonly deadlineIso: string;
}

export type ForgePrState = 'open' | 'merged' | 'closed';
export type ForgeMergeState = 'clean' | 'behind' | 'blocked' | 'unknown';

/** One required context, normalized from the rollup. */
export interface MergeContextSnapshot {
  readonly name: string;
  /**
   * Raw GraphQL state (`SUCCESS`, `FAILURE`, `SKIPPED`, `NEUTRAL`, ...) or
   * `'missing'` when the name never appears in any fully read page (aligns
   * with `MergeContextState` in merge-queue-decider.ts).
   */
  readonly state: string;
  /** `state === 'SUCCESS'` and, for `premerge`, the creator equals the poster. */
  readonly isGreen: boolean;
  readonly creatorLogin: string | null;
}

export type ReadForgeMergeResult =
  | {
      readonly outcome: 'ok';
      readonly prState: ForgePrState;
      readonly liveHeadSha: string;
      readonly mergeState: ForgeMergeState;
      readonly contexts: readonly MergeContextSnapshot[];
      readonly unresolvedThreads: number | 'unknown';
    }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'budget-exhausted' }
  | {
      readonly outcome: 'unavailable';
      readonly code: 'forge-error' | 'unreadable' | 'unknown';
      readonly reason: string;
    };

export interface ForgeMergeReadPort {
  /** Read the merge-pass forge facts for one PR at its live head. */
  readForgeMerge(request: ReadForgeMergeRequest): Promise<ReadForgeMergeResult>;
  /** Whether a transport delegate is configured. */
  isConfigured(): boolean;
}
