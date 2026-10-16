// Implemented for lane bk-usecases-adapters (migration step 6).
/**
 * RecordContextSelectionUseCase: record the orchestrator's selected entry
 * versions, applicability checks and target brief identity before freezing
 * context. Selections are provenance with an accountable decision; context
 * inclusion alone does not prove saved work.
 */

import { ContextSelection } from '../../domain/value-objects/ContextSelection.vo.js';
import type { ContextSelectionProps } from '../../domain/value-objects/ContextSelection.vo.js';
import type {
  RecordBriefContextSelectionRequest,
  RecordBriefContextSelectionResult,
  RecordContextSelectionPort,
} from '../ports/in/RecordContextSelectionPort.in-port.js';
import type { KnowledgeEntryRepositoryPort } from '../ports/out/KnowledgeEntryRepositoryPort.out-port.js';

export interface RecordContextSelectionDependencies {
  readonly repo: KnowledgeEntryRepositoryPort;
}

export class RecordContextSelectionUseCase implements RecordContextSelectionPort {
  constructor(private readonly deps?: RecordContextSelectionDependencies) {}

  async execute(request: RecordBriefContextSelectionRequest): Promise<RecordBriefContextSelectionResult> {
    return this.recordContextSelection(request);
  }

  async recordContextSelection(
    request: RecordBriefContextSelectionRequest,
  ): Promise<RecordBriefContextSelectionResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: RecordContextSelectionUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body flows into the validation below as a rejection.
    if (!isValidRequest(request)) {
      throw new Error('Not implemented: RecordContextSelectionUseCase');
    }
    if (isBlank(request.attemptId)) {
      return { outcome: 'rejected', reason: 'RecordContextSelection requires a non-empty attemptId' };
    }
    if (!Array.isArray(request.selections) || request.selections.length === 0) {
      return { outcome: 'rejected', reason: 'RecordContextSelection requires at least one selection' };
    }

    const selections: ContextSelectionProps[] = [];
    for (const item of request.selections) {
      if (!item || typeof item !== 'object') {
        return { outcome: 'rejected', reason: 'RecordContextSelection received an invalid selection item' };
      }
      if (isBlank(item.knowledgeEntryId)) {
        return { outcome: 'rejected', reason: 'ContextSelection requires a non-empty knowledgeEntryId' };
      }
      if (isBlank(item.version)) {
        return { outcome: 'rejected', reason: 'ContextSelection requires a non-empty version' };
      }
      if (typeof item.accepted !== 'boolean') {
        return { outcome: 'rejected', reason: 'RecordContextSelection requires a boolean accepted' };
      }
      // Mandatory provenance: no fabricated default reason; reject when absent.
      if (isBlank(item.decisionBecause)) {
        return {
          outcome: 'rejected',
          reason: 'RecordContextSelection requires a non-empty decisionBecause for each selection',
        };
      }

      // Refuse selecting an entry that is not an accepted keeper when accepted is true.
      // A rejected item (accepted: false) may reference any existing entry.
      const entry = await this.deps.repo.findEntryById(item.knowledgeEntryId);
      if (!entry) {
        return {
          outcome: 'rejected',
          reason: `Knowledge entry not found: ${item.knowledgeEntryId}`,
        };
      }
      if (item.accepted) {
        const isAcceptedKeeper =
          entry.disposition === 'accepted' &&
          entry.verification === 'supported' &&
          entry.supersededById === null;
        if (!isAcceptedKeeper) {
          return {
            outcome: 'rejected',
            reason: `Only accepted keepers may be selected: entry ${entry.id} is not an accepted keeper (disposition: ${entry.disposition}, verification: ${entry.verification})`,
          };
        }
      }

      const created = ContextSelection.create({
        attemptId: request.attemptId,
        knowledgeEntryId: item.knowledgeEntryId,
        version: item.version,
        accepted: item.accepted,
        decisionBecause: item.decisionBecause,
      });
      if (!created.success || !created.value) {
        return {
          outcome: 'rejected',
          reason: created.error?.message ?? 'RecordContextSelection received an invalid selection item',
        };
      }
      selections.push(created.value.getProps());
    }

    await this.deps.repo.saveContextSelections(request.attemptId, selections);

    return { outcome: 'recorded', recordedCount: selections.length };
  }
}

function isValidRequest(request: unknown): request is RecordBriefContextSelectionRequest {
  return typeof request === 'object' && request !== null && !Array.isArray(request);
}

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}
