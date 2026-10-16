// Implemented for lane D1 (decision port plan, 2026-10-16).
/**
 * NullRankingAdviceAdapter implements KnowledgeRankingAdvicePort as the
 * deterministic alternative: no provider is configured, so every request
 * answers `unknown/not-configured` and the consumer keeps today's behaviour.
 */

import type {
  AdviseRankingQuery,
  KnowledgeRankingAdvicePort,
  RankingAdvice,
} from '../../application/ports/out/KnowledgeRankingAdvicePort.out-port.js';

export class NullRankingAdviceAdapter implements KnowledgeRankingAdvicePort {
  async adviseRanking(_req: AdviseRankingQuery): Promise<RankingAdvice> {
    return { status: 'unknown', reason: 'not-configured' };
  }
}