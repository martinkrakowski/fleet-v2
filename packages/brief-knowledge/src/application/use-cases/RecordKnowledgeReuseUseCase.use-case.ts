// Implemented for lane bk-usecases-adapters (migration step 6).
/**
 * RecordKnowledgeReuseUseCase: record inclusion, demonstrated benefit, wrong
 * turns or unknown usefulness with attributable evidence. Inclusion alone
 * does not prove saved work; `helped` requires demonstrated benefit.
 */

import { KNOWLEDGE_REUSE_OUTCOMES } from '../../domain/value-objects/KnowledgeReuseOutcome.vo.js';
import type {
  KnowledgeEntryRecord,
  KnowledgeReuseRecord,
} from '../../domain/knowledge-records.js';
import type {
  RecordKnowledgeReusePort,
  RecordKnowledgeReuseRequest,
  RecordKnowledgeReuseResult,
} from '../ports/in/RecordKnowledgeReusePort.in-port.js';
import type { KnowledgeEntryRepositoryPort } from '../ports/out/KnowledgeEntryRepositoryPort.out-port.js';

export interface RecordKnowledgeReuseDependencies {
  readonly repo: KnowledgeEntryRepositoryPort;
}

export class RecordKnowledgeReuseUseCase implements RecordKnowledgeReusePort {
  constructor(private readonly deps?: RecordKnowledgeReuseDependencies) {}

  async execute(request: RecordKnowledgeReuseRequest): Promise<RecordKnowledgeReuseResult> {
    return this.recordKnowledgeReuse(request);
  }

  async recordKnowledgeReuse(request: RecordKnowledgeReuseRequest): Promise<RecordKnowledgeReuseResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: RecordKnowledgeReuseUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body flows into the validation below as a rejection.
    if (!isValidRequest(request)) {
      throw new Error('Not implemented: RecordKnowledgeReuseUseCase');
    }
    if (isBlank(request.entryId)) {
      return { outcome: 'rejected', reason: 'RecordKnowledgeReuse requires a non-empty entryId' };
    }
    if (isBlank(request.reuseId)) {
      return { outcome: 'rejected', reason: 'RecordKnowledgeReuse requires a non-empty reuseId' };
    }
    if (isBlank(request.attemptId)) {
      return { outcome: 'rejected', reason: 'RecordKnowledgeReuse requires a non-empty attemptId' };
    }
    if (!KNOWLEDGE_REUSE_OUTCOMES.includes(request.outcome)) {
      return { outcome: 'rejected', reason: 'RecordKnowledgeReuse requires a valid reuse outcome' };
    }

    const repo = this.deps.repo;
    const entry = await repo.findEntryById(request.entryId);
    if (!entry) {
      return { outcome: 'rejected', reason: `Knowledge entry not found: ${request.entryId}` };
    }

    const recordedAtIso = request.nowIso ?? new Date().toISOString();
    const reuse: KnowledgeReuseRecord = {
      id: request.reuseId,
      entryId: request.entryId,
      version: entry.version,
      attemptId: request.attemptId,
      outcome: request.outcome,
      evidenceRef: request.evidenceRef ?? null,
      recordedAtIso,
    };

    const updated: KnowledgeEntryRecord = {
      ...entry,
      reuses: [...entry.reuses, reuse],
      revision: entry.revision + 1,
      updatedAtIso: recordedAtIso,
    };
    await repo.saveEntry(updated);

    return { outcome: 'recorded', entry: updated, reuse };
  }
}

function isValidRequest(request: unknown): request is RecordKnowledgeReuseRequest {
  return typeof request === 'object' && request !== null && !Array.isArray(request);
}

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}
