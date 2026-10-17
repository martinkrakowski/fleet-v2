// Refined for lane D1 (decision port plan, 2026-10-16); refined again for lane
// K2 (decision-kernel plan, 2026-10-16, §3).
/**
 * KnowledgeRankingAdvicePort: ask a bounded advisory ranking judgement for
 * explicit candidates. Advisory only — an answer may reorder candidate
 * rankings but never satisfies a required check, replaces a review, grants
 * authority, removes a blocker or admits an entry. `unknown` always means
 * today's deterministic behaviour.
 *
 * The ranking `contextRef` a settled receipt carries travels back on the
 * answer itself (`contextRef`), never as per-instance state on the port: two
 * concurrent calls each carry their own reference, and a caller that lost the
 * race can never read another call's reference.
 */

/** One candidate as sent to the advice provider: declared fields only. */
export interface RankingAdviceCandidate {
  readonly id: string;
  readonly claimText: string;
}

export interface AdviseRankingQuery {
  readonly projectId: string;
  /**
   * The lane the brief is for. It names the ranking `contextRef` the receipt,
   * its outcome and a recorded selection join on; absent scopes the reference
   * to `unscoped`.
   */
  readonly laneId?: string;
  readonly taskSummary: string;
  readonly pathPrefixes: readonly string[];
  readonly candidates: readonly RankingAdviceCandidate[];
}

/**
 * `ranking:<lane>:<sha256>` — the reference this call's receipt, its outcome
 * line and a recorded selection join on. Present whenever a receipt was
 * settled (even for an `unknown` answer, whose outcome still joins); absent
 * when advice was off, the budget refused or no settlement could be recorded.
 */
export interface RankingContextRefAnswer {
  readonly contextRef?: string;
}

/** Successful advice: one decision score per candidate id, each in [0,1]. */
export interface AdvisedRanking extends RankingContextRefAnswer {
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
export interface UnknownRankingAdvice extends RankingContextRefAnswer {
  readonly status: 'unknown';
  readonly reason: RankingAdviceUnknownReason;
}

export type RankingAdvice = AdvisedRanking | UnknownRankingAdvice;

export interface KnowledgeRankingAdvicePort {
  /** Ask for an advisory ranking of the given candidates; unknown never throws. */
  adviseRanking(req: AdviseRankingQuery): Promise<RankingAdvice>;
}
