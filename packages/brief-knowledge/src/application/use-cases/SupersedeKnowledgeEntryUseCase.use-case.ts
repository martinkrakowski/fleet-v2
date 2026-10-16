// Implemented for lane bk-usecases-adapters (migration step 6).
/**
 * SupersedeKnowledgeEntryUseCase: link a checked correction to the older entry
 * it replaces and exclude superseded content from normal retrieval.
 */

import { KnowledgeEntry } from '../../domain/entities/KnowledgeEntry.js';
import type { KnowledgeEntryRecord } from '../../domain/knowledge-records.js';
import type {
  SupersedeKnowledgeEntryPort,
  SupersedeKnowledgeEntryRequest,
  SupersedeKnowledgeEntryResult,
} from '../ports/in/SupersedeKnowledgeEntryPort.in-port.js';
import type { KnowledgeEntryRepositoryPort } from '../ports/out/KnowledgeEntryRepositoryPort.out-port.js';

export interface SupersedeKnowledgeEntryDependencies {
  readonly repo: KnowledgeEntryRepositoryPort;
}

export class SupersedeKnowledgeEntryUseCase implements SupersedeKnowledgeEntryPort {
  constructor(private readonly deps?: SupersedeKnowledgeEntryDependencies) {}

  async execute(request: SupersedeKnowledgeEntryRequest): Promise<SupersedeKnowledgeEntryResult> {
    return this.supersedeKnowledgeEntry(request);
  }

  async supersedeKnowledgeEntry(
    request: SupersedeKnowledgeEntryRequest,
  ): Promise<SupersedeKnowledgeEntryResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: SupersedeKnowledgeEntryUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body flows into the validation below as a rejection.
    if (!isValidRequest(request)) {
      throw new Error('Not implemented: SupersedeKnowledgeEntryUseCase');
    }
    if (isBlank(request.olderEntryId)) {
      return { outcome: 'rejected', reason: 'SupersedeKnowledgeEntry requires a non-empty olderEntryId' };
    }
    if (isBlank(request.newerEntryId)) {
      return { outcome: 'rejected', reason: 'SupersedeKnowledgeEntry requires a non-empty newerEntryId' };
    }
    if (isBlank(request.checkerId)) {
      return { outcome: 'rejected', reason: 'SupersedeKnowledgeEntry requires a non-empty checkerId' };
    }
    if (isBlank(request.reason)) {
      return { outcome: 'rejected', reason: 'SupersedeKnowledgeEntry requires a non-empty reason' };
    }
    if (request.olderEntryId === request.newerEntryId) {
      return {
        outcome: 'rejected',
        reason: 'SupersedeKnowledgeEntry requires distinct olderEntryId and newerEntryId',
      };
    }

    const repo = this.deps.repo;
    const olderEntry = await repo.findEntryById(request.olderEntryId);
    if (!olderEntry) {
      return { outcome: 'rejected', reason: `Knowledge entry not found: ${request.olderEntryId}` };
    }
    const newerEntry = await repo.findEntryById(request.newerEntryId);
    if (!newerEntry) {
      return { outcome: 'rejected', reason: `Knowledge entry not found: ${request.newerEntryId}` };
    }
    if (newerEntry.disposition !== 'accepted') {
      return { outcome: 'rejected', reason: 'Only accepted entries may supersede an older entry' };
    }

    const nowIso = request.nowIso ?? new Date().toISOString();
    let updatedOlder: KnowledgeEntryRecord;
    try {
      const olderAggregate = KnowledgeEntry.fromRecord(olderEntry);
      updatedOlder = olderAggregate.supersedeBy({
        newerEntryId: newerEntry.id,
        checkerId: request.checkerId,
        reason: request.reason,
        nowIso,
      });
    } catch (error) {
      return {
        outcome: 'rejected',
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    await repo.saveEntry(updatedOlder);

    return { outcome: 'superseded', olderEntry: updatedOlder, newerEntry };
  }
}

function isValidRequest(request: unknown): request is SupersedeKnowledgeEntryRequest {
  return typeof request === 'object' && request !== null && !Array.isArray(request);
}

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}
