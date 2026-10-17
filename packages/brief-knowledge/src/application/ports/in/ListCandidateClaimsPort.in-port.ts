// Refined for lane K5a (decision-kernel plan, 2026-10-16, §5).
/**
 * ListCandidateClaimsPort: read one attempt's candidate claims so a checker
 * or the triage pipeline can walk the disposition queue most-reusable-first.
 * A re-sorted list is advisory ordering only — it never decides a
 * disposition, never truncates and never drops a candidate.
 */

import type { KnowledgeEntryRecord } from '../../../domain/knowledge-records.js';

export interface ListCandidateClaimsRequest {
  /** The attempt whose captured candidate claims are listed. */
  readonly attemptId: string;
  /**
   * Optional triage scores keyed by candidate entry id; higher is more
   * reusable and sorts first, unscored candidates follow in id order. Ids the
   * map does not mention are never an error.
   */
  readonly scores?: Readonly<Record<string, number>>;
}

export type ListCandidateClaimsResult =
  | { readonly outcome: 'listed'; readonly candidates: readonly KnowledgeEntryRecord[] }
  | { readonly outcome: 'rejected'; readonly reason: string };

export interface ListCandidateClaimsPort {
  /** List one attempt's candidate claims, most reusable first; never truncated. */
  listCandidateClaims(request: ListCandidateClaimsRequest): Promise<ListCandidateClaimsResult>;
}
