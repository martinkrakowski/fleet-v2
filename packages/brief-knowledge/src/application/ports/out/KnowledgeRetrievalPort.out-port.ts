// @generated outbound contract scaffold — refined for migration step 5.
/**
 * KnowledgeRetrievalPort: filter by authorized scope and rank lexical
 * matches without returning rejected, superseded or inapplicable facts.
 * Bounds are explicit and positive; shared scope is reviewed, and no
 * transcripts, secrets or client content are ingested.
 */

import type { KnowledgeEntryRecord } from '../../../domain/knowledge-records.js';

export interface RankKeepersQuery {
  readonly projectId: string;
  /**
   * The lane the brief is for. It names the ranking `contextRef` of an advised
   * reordering, so the receipt, its outcome and a recorded selection join on
   * the same reference.
   */
  readonly laneId?: string;
  readonly taskSummary: string;
  readonly pathPrefixes: readonly string[];
  readonly maxEntries: number;
  readonly maxTotalChars: number;
  /** Candidates are entry records the use case already trusts as keepers. */
  readonly candidateKeepers: readonly KnowledgeEntryRecord[];
}

export interface RankedKeeperMatch {
  readonly entry: KnowledgeEntryRecord;
  readonly score: number;
  readonly matchReason: string;
}

/**
 * One ranking plus the ranking `contextRef` its receipt settled. The reference
 * travels with the result it belongs to, never as per-instance state on the
 * port, so two concurrent rankings each report their own reference.
 */
export interface RankEligibleKeepersResult {
  /** Exactly the matches `rankEligibleKeepers` returns for the same query. */
  readonly matches: readonly RankedKeeperMatch[];
  /**
   * Present when an advised reordering settled a receipt; absent when advice
   * was off, the budget refused, fewer than two entries made an advice call
   * pointless, or no settlement could be recorded.
   */
  readonly rankingContextRef?: string;
}

export interface KnowledgeRetrievalPort {
  /** Rank eligible keepers within explicit bounds; inapplicable facts are filtered out before ranking. */
  rankEligibleKeepers(query: RankKeepersQuery): Promise<readonly RankedKeeperMatch[]>;
  /**
   * Optional: the same ranking as `rankEligibleKeepers`, plus the ranking
   * `contextRef` its receipt settled. The plain lexical adapter advises
   * nothing, answers no reference, and stays assignable to this port.
   */
  rankEligibleKeepersWithContext?(query: RankKeepersQuery): Promise<RankEligibleKeepersResult>;
}
