// Implemented for lane D1 (decision port plan, 2026-10-16).
/**
 * AdvisedKnowledgeRetrievalAdapter decorates an inner KnowledgeRetrievalPort
 * with an optional advisory reorder. Decisions only reorder the deterministic
 * set: membership never changes, so no entry can be admitted or dropped.
 * On `unknown` (and on any malformed advice) the inner result object is
 * returned unchanged, reference-equal. With fewer than two entries the advice
 * port is never called (no fee, no receipt).
 */

import type {
  KnowledgeRetrievalPort,
  RankKeepersQuery,
  RankedKeeperMatch,
} from '../../application/ports/out/KnowledgeRetrievalPort.out-port.js';
import type {
  KnowledgeRankingAdvicePort,
  RankingAdvice,
} from '../../application/ports/out/KnowledgeRankingAdvicePort.out-port.js';

/** Weight of the decision score in the combined order key. */
const DEFAULT_DECISION_WEIGHT = 0.5;

export class AdvisedKnowledgeRetrievalAdapter implements KnowledgeRetrievalPort {
  private readonly inner: KnowledgeRetrievalPort;
  private readonly advice: KnowledgeRankingAdvicePort;
  private readonly weight: number;

  constructor(
    inner: KnowledgeRetrievalPort,
    advice: KnowledgeRankingAdvicePort,
    weight: number = DEFAULT_DECISION_WEIGHT,
  ) {
    if (!inner || typeof inner.rankEligibleKeepers !== 'function') {
      throw new Error('AdvisedKnowledgeRetrievalAdapter requires an inner KnowledgeRetrievalPort');
    }
    if (!advice || typeof advice.adviseRanking !== 'function') {
      throw new Error('AdvisedKnowledgeRetrievalAdapter requires a KnowledgeRankingAdvicePort');
    }
    if (!Number.isFinite(weight)) {
      throw new Error('AdvisedKnowledgeRetrievalAdapter requires a finite weight');
    }
    this.inner = inner;
    this.advice = advice;
    this.weight = weight;
  }

  async rankEligibleKeepers(query: RankKeepersQuery): Promise<readonly RankedKeeperMatch[]> {
    // 1. The inner port is called with the original query.
    const innerResult = await this.inner.rankEligibleKeepers(query);

    // 4. With 0 or 1 entries the advice port is not called (no fee, no receipt).
    if (!Array.isArray(innerResult) || innerResult.length < 2) {
      return innerResult;
    }

    const advice: RankingAdvice = await this.advice.adviseRanking({
      projectId: query.projectId,
      taskSummary: query.taskSummary,
      pathPrefixes: query.pathPrefixes,
      candidates: innerResult.map((match) => ({
        id: match.entry.id,
        claimText: match.entry.claimText,
      })),
    });

    if (advice.status !== 'advised') {
      // 5. On unknown, return the inner result object unchanged.
      return innerResult;
    }

    const scores = validateScores(advice, innerResult);
    if (!scores) {
      // Malformed advice behaves exactly like unknown.
      return innerResult;
    }

    // 3. Order key: inner score / set maximum (in (0,1]) + weight × decisionScore.
    const maxScore = Math.max(...innerResult.map((match) => match.score));
    if (!Number.isFinite(maxScore) || maxScore <= 0) {
      return innerResult;
    }

    const reordered: RankedKeeperMatch[] = innerResult.map((match) => ({
      ...match,
      matchReason: withDecision(match.matchReason, advice),
    }));
    const keyOf = (match: RankedKeeperMatch): number =>
      match.score / maxScore + this.weight * scores[match.entry.id];
    reordered.sort((a, b) => keyOf(b) - keyOf(a) || a.entry.id.localeCompare(b.entry.id));
    return reordered;
  }
}

/** Validate every decision score is a finite number in [0,1]; missing ids fail. */
function validateScores(
  advice: Extract<RankingAdvice, { status: 'advised' }>,
  matches: readonly RankedKeeperMatch[],
): Record<string, number> | null {
  const scores: Record<string, number> = {};
  for (const match of matches) {
    const value = advice.scores[match.entry.id];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      return null;
    }
    scores[match.entry.id] = value;
  }
  if (
    typeof advice.confidence !== 'number' ||
    !Number.isFinite(advice.confidence) ||
    advice.confidence < 0 ||
    advice.confidence > 1 ||
    typeof advice.model !== 'string' ||
    advice.model.length === 0
  ) {
    return null;
  }
  return scores;
}

/** 6. matchReason becomes `<original>; decision(<model>, c=<confidence to 2dp>)`. */
function withDecision(
  original: string,
  advice: Extract<RankingAdvice, { status: 'advised' }>,
): string {
  const confidence = advice.confidence.toFixed(2);
  return `${original}; decision(${advice.model}, c=${confidence})`;
}