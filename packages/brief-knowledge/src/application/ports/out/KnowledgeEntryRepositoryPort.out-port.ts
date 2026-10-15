// @generated outbound contract scaffold — refined for migration step 5.
/**
 * KnowledgeEntryRepositoryPort: persist candidate/keeper versions, checks,
 * supersession and reuse history. Records are stored exactly as the use case
 * produced them; the repository adds no domain decisions of its own.
 */

import type { KnowledgeEntryRecord } from '../../../domain/knowledge-records.js';
import type { ContextSelectionProps } from '../../../domain/value-objects/ContextSelection.vo.js';

export interface KnowledgeEntryRepositoryPort {
  /** Persist one entry record, replacing the stored version in whole. */
  saveEntry(record: KnowledgeEntryRecord): Promise<void>;

  /** Known absence is null; unreadable state is an error. */
  findEntryById(entryId: string): Promise<KnowledgeEntryRecord | null>;

  /** List entries for one project, or every project when no id is given. */
  listEntriesByProject(projectId?: string): Promise<readonly KnowledgeEntryRecord[]>;

  /** Persist the orchestrator's selections for one attempt before context freezes. */
  saveContextSelections(attemptId: string, selections: readonly ContextSelectionProps[]): Promise<void>;

  /** List recorded selections for one attempt in recorded order. */
  listContextSelections(attemptId: string): Promise<readonly ContextSelectionProps[]>;
}
