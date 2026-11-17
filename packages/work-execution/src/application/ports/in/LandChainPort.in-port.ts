/**
 * LandChainPort (lane CO10): land one started, reviewed chain onto `main` by
 * opening or adopting one integration pull request, recording a keyed intent
 * and a compare-and-set landing mark, re-checking every link and unfinished
 * batch after that mark, and only then enqueuing the pull request on the
 * daemon merge queue. A dry run writes nothing. Every rejection is a fixed
 * reason code; unknown stays unknown and nothing throws out of the port. An
 * apply-phase `halted` refusal additionally carries a read-only `progress`
 * summary of how far the landing got; pre-apply halts carry none.
 */

/** Read-only report of how far an apply-phase landing got when the kill switch tripped. */
export interface LandChainHaltProgress {
  /** The open integration pull request this run found, opened or adopted; null when none is known. */
  readonly integrationPullRequestNumber: number | null;
  /** 'posted' only when THIS run's premerge status post succeeded; 'not-recorded' otherwise (an earlier run may have posted). */
  readonly premergeStatus: 'posted' | 'not-recorded';
  /** The stored landing mark read at refusal time: 'landing' only for this landing's own key and head in state landing; 'unknown' when the mark could not be read. */
  readonly landingMark: 'landing' | 'not-landing' | 'unknown';
}

export type LandChainRefusal =
  | 'invalid-request'
  | 'halted'
  | 'secret-shaped'
  | 'chain-not-found'
  | 'chain-not-started'
  | 'conflict-mark'
  | 'refresh-in-flight'
  | 'review-not-started'
  | 'chain-tip-moved'
  | 'too-many-links'
  | 'no-links'
  | 'link-unsettled'
  | 'link-receipt-missing'
  | 'link-receipt-failed'
  | 'receipt-missing'
  | 'receipt-wrong-head'
  | 'verdict-failed'
  | 'batch-unfinished'
  | 'integration-pr-wrong-base'
  | 'integration-pr-ambiguous'
  | 'landing-mark-stale'
  | 'landing-mark-conflict'
  | 'intent-digest-mismatch'
  | 'enqueue-refused'
  | 'forge-refused';

export type LandChainUnknown =
  | 'chain-unreadable'
  | 'store-unavailable'
  | 'forge-unavailable'
  | 'head-lookup-unavailable'
  | 'batch-unreadable'
  | 'journal-unreadable'
  | 'queue-unreadable'
  | 'verdict-unknown'
  | 'id-unavailable'
  | 'budget-exhausted';

export type LandChainResult =
  | {
      readonly outcome: 'dry-run';
      readonly title: string;
      readonly body: string;
      readonly action: 'open' | 'adopt';
      readonly pullRequestNumber: number | null;
    }
  | {
      readonly outcome: 'landed';
      readonly title: string;
      readonly body: string;
      readonly pullRequestNumber: number;
      readonly headSha: string;
      readonly entryId: string;
    }
  | { readonly outcome: 'refused'; readonly reason: LandChainRefusal; readonly progress?: LandChainHaltProgress }
  | { readonly outcome: 'unknown'; readonly reason: LandChainUnknown };

export interface LandChainPort {
  execute(input: unknown): Promise<LandChainResult>;
}
