// Implemented for lane K5a (decision-kernel plan, 2026-10-16, §5).
/**
 * ListCandidateClaimsUseCase: read one attempt's candidate claims for the
 * disposition queue. An optional score map orders the candidates most
 * reusable first; everything the map does not order stays in id order. The
 * list is a re-sorting of the stored candidates only — it never truncates,
 * never drops one and never decides a disposition.
 */

import type { KnowledgeEntryRecord } from '../../domain/knowledge-records.js';
import type {
  ListCandidateClaimsPort,
  ListCandidateClaimsRequest,
  ListCandidateClaimsResult,
} from '../ports/in/ListCandidateClaimsPort.in-port.js';
import type { KnowledgeEntryRepositoryPort } from '../ports/out/KnowledgeEntryRepositoryPort.out-port.js';

export interface ListCandidateClaimsDependencies {
  readonly repo: KnowledgeEntryRepositoryPort;
}

export class ListCandidateClaimsUseCase implements ListCandidateClaimsPort {
  constructor(private readonly deps?: ListCandidateClaimsDependencies) {}

  async execute(request: ListCandidateClaimsRequest): Promise<ListCandidateClaimsResult> {
    return this.listCandidateClaims(request);
  }

  async listCandidateClaims(request: ListCandidateClaimsRequest): Promise<ListCandidateClaimsResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: ListCandidateClaimsUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body flows into the validation below as a rejection.
    if (!isValidRequest(request)) {
      throw new Error('Not implemented: ListCandidateClaimsUseCase');
    }
    if (isBlank(request.attemptId)) {
      return { outcome: 'rejected', reason: 'ListCandidateClaims requires a non-empty attemptId' };
    }
    if (request.scores !== undefined && !isValidScoreMap(request.scores)) {
      return {
        outcome: 'rejected',
        reason: 'ListCandidateClaims requires scores to be a map of candidate id to finite number',
      };
    }

    const entries = await this.deps.repo.listEntriesBySourceAttempt(request.attemptId);
    // Only undecided candidates are queued: an entry that already has a
    // disposition has left the queue, and triage never runs on it again.
    const candidates = entries.filter((entry) => entry.disposition === 'candidate');

    return { outcome: 'listed', candidates: sortByScoreThenId(candidates, request.scores) };
  }
}

/**
 * Higher score first; candidates the map does not score follow in id order.
 * Ties keep id order. The comparator is total, so sorting never drops an
 * entry and the result never depends on the host's locale (explicit
 * code-unit comparison for ids, as for the ranking contextRef digest).
 */
function sortByScoreThenId(
  candidates: readonly KnowledgeEntryRecord[],
  scores: Readonly<Record<string, number>> | undefined,
): KnowledgeEntryRecord[] {
  const scoreOf = (entry: KnowledgeEntryRecord): number => {
    const score = scores?.[entry.id];
    return typeof score === 'number' && Number.isFinite(score) ? score : Number.NEGATIVE_INFINITY;
  };
  return [...candidates].sort((left, right) => {
    const leftScore = scoreOf(left);
    const rightScore = scoreOf(right);
    if (leftScore !== rightScore) {
      return rightScore - leftScore;
    }
    return compareIds(left.id, right.id);
  });
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isValidScoreMap(scores: unknown): scores is Readonly<Record<string, number>> {
  if (typeof scores !== 'object' || scores === null || Array.isArray(scores)) {
    return false;
  }
  return Object.values(scores).every((value) => typeof value === 'number' && Number.isFinite(value));
}

function isValidRequest(request: unknown): request is ListCandidateClaimsRequest {
  return typeof request === 'object' && request !== null && !Array.isArray(request);
}

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}
