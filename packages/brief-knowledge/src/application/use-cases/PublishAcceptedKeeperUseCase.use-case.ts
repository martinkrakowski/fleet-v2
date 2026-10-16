// Implemented for lane bk-usecases-adapters (migration step 6).
/**
 * PublishAcceptedKeeperUseCase: publish one accepted fact with source and
 * checker attribution; preserve failed delivery for reconciliation. Shelf
 * failure does not fail otherwise acceptable work.
 */

import { KnowledgeEntry } from '../../domain/entities/KnowledgeEntry.js';
import type {
  PublishAcceptedKeeperPort,
  PublishAcceptedKeeperRequest,
  PublishAcceptedKeeperResult,
} from '../ports/in/PublishAcceptedKeeperPort.in-port.js';
import type { KeeperPublicationPort } from '../ports/out/KeeperPublicationPort.out-port.js';
import type { KnowledgeEntryRepositoryPort } from '../ports/out/KnowledgeEntryRepositoryPort.out-port.js';

export interface PublishAcceptedKeeperDependencies {
  readonly repo: KnowledgeEntryRepositoryPort;
  readonly publisher: KeeperPublicationPort;
}

export class PublishAcceptedKeeperUseCase implements PublishAcceptedKeeperPort {
  constructor(private readonly deps?: PublishAcceptedKeeperDependencies) {}

  async execute(request: PublishAcceptedKeeperRequest): Promise<PublishAcceptedKeeperResult> {
    return this.publishAcceptedKeeper(request);
  }

  async publishAcceptedKeeper(request: PublishAcceptedKeeperRequest): Promise<PublishAcceptedKeeperResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: PublishAcceptedKeeperUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body flows into the validation below as a rejection.
    if (!isValidRequest(request)) {
      throw new Error('Not implemented: PublishAcceptedKeeperUseCase');
    }
    if (isBlank(request.entryId)) {
      return { outcome: 'rejected', reason: 'PublishAcceptedKeeper requires a non-empty entryId' };
    }

    const { repo, publisher } = this.deps;
    const entry = await repo.findEntryById(request.entryId);
    if (!entry) {
      return { outcome: 'rejected', reason: `Knowledge entry not found: ${request.entryId}` };
    }
    if (entry.disposition !== 'accepted') {
      return { outcome: 'rejected', reason: 'Only accepted keepers may be published' };
    }
    if (entry.verification !== 'supported') {
      return { outcome: 'rejected', reason: 'Only supported keepers may be published' };
    }
    if (entry.supersededById !== null) {
      return { outcome: 'rejected', reason: 'Superseded keepers may not be published' };
    }

    try {
      KnowledgeEntry.fromRecord(entry);
    } catch (error) {
      return {
        outcome: 'rejected',
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    const publication = await publisher.publishKeeperToShelf({ entry });
    if (publication.outcome === 'failed') {
      // Preserve failed delivery for reconciliation without throwing.
      return { outcome: 'delivery-failed', entry, reason: publication.reason };
    }

    return { outcome: 'published', entry, externalRef: publication.externalRef };
  }
}

function isValidRequest(request: unknown): request is PublishAcceptedKeeperRequest {
  return typeof request === 'object' && request !== null && !Array.isArray(request);
}

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}
