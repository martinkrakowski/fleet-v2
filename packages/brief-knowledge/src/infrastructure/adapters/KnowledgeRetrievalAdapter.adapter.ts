// @generated adapter stub — refined for migration step 5 (no behaviour).
/**
 * KnowledgeRetrievalAdapter implements KnowledgeRetrievalPort
 * (local-scoped-lexical-index). Implementation lands in a later wave; the
 * method refuses until then.
 */

import type { KnowledgeRetrievalPort, RankKeepersQuery, RankedKeeperMatch } from '../../application/ports/out/KnowledgeRetrievalPort.out-port.js';

export class KnowledgeRetrievalAdapter implements KnowledgeRetrievalPort {
  async rankEligibleKeepers(_query: RankKeepersQuery): Promise<readonly RankedKeeperMatch[]> {
    throw new Error('Not implemented: KnowledgeRetrievalAdapter.rankEligibleKeepers');
  }
}
