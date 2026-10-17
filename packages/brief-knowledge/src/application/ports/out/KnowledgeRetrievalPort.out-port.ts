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

export interface KnowledgeRetrievalPort {
  /** Rank eligible keepers within explicit bounds; inapplicable facts are filtered out before ranking. */
  rankEligibleKeepers(query: RankKeepersQuery): Promise<readonly RankedKeeperMatch[]>;
}

/**
 * Exposed by the advised decorator: the ranking `contextRef` of the last
 * ranking whose receipt was settled, `null` when advice was off, the budget
 * refused or nothing could be settled. The plain retrieval adapter has no
 * such reference and stays assignable to this optional shape.
 */
export interface RankingContextRefReporter {
  readonly lastRankingContextRef?: string | null;
}
