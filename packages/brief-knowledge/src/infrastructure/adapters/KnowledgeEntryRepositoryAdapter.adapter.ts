// @generated adapter stub — refined for migration step 5 (no behaviour).
/**
 * KnowledgeEntryRepositoryAdapter implements KnowledgeEntryRepositoryPort
 * (local-transactional-store). Implementation lands in a later wave; every
 * method refuses until then.
 */

import type { KnowledgeEntryRecord } from '../../domain/knowledge-records.js';
import type { ContextSelectionProps } from '../../domain/value-objects/ContextSelection.vo.js';
import type { KnowledgeEntryRepositoryPort } from '../../application/ports/out/KnowledgeEntryRepositoryPort.out-port.js';

export class KnowledgeEntryRepositoryAdapter implements KnowledgeEntryRepositoryPort {
  async saveEntry(_record: KnowledgeEntryRecord): Promise<void> {
    throw new Error('Not implemented: KnowledgeEntryRepositoryAdapter.saveEntry');
  }

  async findEntryById(_entryId: string): Promise<KnowledgeEntryRecord | null> {
    throw new Error('Not implemented: KnowledgeEntryRepositoryAdapter.findEntryById');
  }

  async listEntriesByProject(_projectId?: string): Promise<readonly KnowledgeEntryRecord[]> {
    throw new Error('Not implemented: KnowledgeEntryRepositoryAdapter.listEntriesByProject');
  }

  async saveContextSelections(_attemptId: string, _selections: readonly ContextSelectionProps[]): Promise<void> {
    throw new Error('Not implemented: KnowledgeEntryRepositoryAdapter.saveContextSelections');
  }

  async listContextSelections(_attemptId: string): Promise<readonly ContextSelectionProps[]> {
    throw new Error('Not implemented: KnowledgeEntryRepositoryAdapter.listContextSelections');
  }
}
