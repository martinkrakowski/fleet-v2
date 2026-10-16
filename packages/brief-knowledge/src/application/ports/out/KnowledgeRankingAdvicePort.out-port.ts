// Refined for lane D1 (decision port plan, 2026-10-16).
/**
 * KnowledgeRankingAdvicePort: ask a bounded advisory ranking judgement for
 * explicit candidates. Advisory only — an answer may reorder candidate
 * rankings but never satisfies a required check, replaces a review, grants
 * authority, removes a blocker or admits an entry. `unknown` always means
 * today's deterministic behaviour.
 */

/** One candidate as sent to the advice provider: declared fields only. */
export interface RankingAdviceCandidate {
  readonly id: string;
  readonly claimText: string;
}

export interface AdviseRankingQuery {
  readonly projectId: string;
  readonly taskSummary: string;
  readonly pathPrefixes: readonly string[];
  readonly candidates: readonly RankingAdviceCandidate[];
}

/** Successful advice: one decision score per candidate id, each in [0,1]. */
export interface AdvisedRanking {
  readonly status: 'advised';
  readonly scores: Record<string, number>;
  readonly model: string;
  readonly confidence: number;
}

export type RankingAdviceUnknownReason =
  | 'not-configured'
  | 'timeout'
  | 'transport'
  | 'shape'
  | 'redaction-refused'
  | 'budget'
  | 'low-confidence';

/** Unknown advice: the consumer keeps its deterministic result unchanged. */
export interface UnknownRankingAdvice {
  readonly status: 'unknown';
  readonly reason: RankingAdviceUnknownReason;
}

export type RankingAdvice = AdvisedRanking | UnknownRankingAdvice;

export interface KnowledgeRankingAdvicePort {
  /** Ask for an advisory ranking of the given candidates; unknown never throws. */
  adviseRanking(req: AdviseRankingQuery): Promise<RankingAdvice>;
}