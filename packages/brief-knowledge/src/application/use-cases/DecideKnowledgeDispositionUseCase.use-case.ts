// Implemented for lane bk-usecases-adapters (migration step 6).
/**
 * DecideKnowledgeDispositionUseCase: accept, defer, reject or flag a policy
 * proposal with checker identity and reasons. Deliberate disposition — not
 * capture — promotes a candidate into reusable context, and a policy
 * proposal never becomes an accepted keeper.
 */

import { KNOWLEDGE_DISPOSITIONS } from '../../domain/value-objects/KnowledgeDisposition.vo.js';
import type { KnowledgeEntryRecord } from '../../domain/knowledge-records.js';
import type {
  DecideKnowledgeDispositionPort,
  DecideKnowledgeDispositionRequest,
  DecideKnowledgeDispositionResult,
} from '../ports/in/DecideKnowledgeDispositionPort.in-port.js';
import type { KnowledgeEntryRepositoryPort } from '../ports/out/KnowledgeEntryRepositoryPort.out-port.js';

/** Claims mentioning rule/seat/permission/policy changes are policy proposals. */
const POLICY_PROPOSAL_PATTERN = /\b(rules?|seats?|permissions?|polic(?:y|ies))\b/i;

export interface DecideKnowledgeDispositionDependencies {
  readonly repo: KnowledgeEntryRepositoryPort;
}

export class DecideKnowledgeDispositionUseCase implements DecideKnowledgeDispositionPort {
  constructor(private readonly deps?: DecideKnowledgeDispositionDependencies) {}

  async execute(request: DecideKnowledgeDispositionRequest): Promise<DecideKnowledgeDispositionResult> {
    return this.decideKnowledgeDisposition(request);
  }

  async decideKnowledgeDisposition(
    request: DecideKnowledgeDispositionRequest,
  ): Promise<DecideKnowledgeDispositionResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: DecideKnowledgeDispositionUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body flows into the validation below as a rejection.
    if (!isValidRequest(request)) {
      throw new Error('Not implemented: DecideKnowledgeDispositionUseCase');
    }
    if (isBlank(request.entryId)) {
      return { outcome: 'rejected', reason: 'DecideKnowledgeDisposition requires a non-empty entryId' };
    }
    if (!KNOWLEDGE_DISPOSITIONS.includes(request.disposition)) {
      return { outcome: 'rejected', reason: 'DecideKnowledgeDisposition requires a valid disposition' };
    }
    if (isBlank(request.checkerId)) {
      return { outcome: 'rejected', reason: 'DecideKnowledgeDisposition requires a non-empty checkerId' };
    }
    if (isBlank(request.reason)) {
      return { outcome: 'rejected', reason: 'DecideKnowledgeDisposition requires a non-empty reason' };
    }

    const repo = this.deps.repo;
    const entry = await repo.findEntryById(request.entryId);
    if (!entry) {
      return { outcome: 'rejected', reason: `Knowledge entry not found: ${request.entryId}` };
    }

    if (request.disposition === 'accepted' && entry.verification !== 'supported') {
      return {
        outcome: 'rejected',
        reason: 'Only supported (verified) claims may be accepted as keepers',
      };
    }
    if (request.disposition === 'accepted' && proposesPolicyChange(entry.claimText)) {
      return {
        outcome: 'rejected',
        reason: 'Policy proposals must receive policy-proposal disposition, never accepted',
      };
    }

    const nowIso = request.nowIso ?? new Date().toISOString();
    const updated: KnowledgeEntryRecord = {
      ...entry,
      disposition: request.disposition,
      checkerId: request.checkerId,
      dispositionReason: request.reason,
      revision: entry.revision + 1,
      updatedAtIso: nowIso,
    };
    await repo.saveEntry(updated);

    return { outcome: 'decided', entry: updated };
  }
}

/** A claim that proposes changing rules, seats or permissions is a policy proposal. */
function proposesPolicyChange(claimText: string): boolean {
  return POLICY_PROPOSAL_PATTERN.test(claimText);
}

function isValidRequest(request: unknown): request is DecideKnowledgeDispositionRequest {
  return typeof request === 'object' && request !== null && !Array.isArray(request);
}

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}
