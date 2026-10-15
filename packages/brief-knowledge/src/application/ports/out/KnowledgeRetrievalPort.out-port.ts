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
