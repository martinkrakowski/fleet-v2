// @generated outbound contract scaffold — refined for migration step 5.
/**
 * KnowledgeEntryRepositoryPort: persist candidate/keeper versions, checks,
 * supersession and reuse history. Records are stored exactly as the use case
 * produced them; the repository adds no domain decisions of its own.
 */

import type { KnowledgeEntryRecord, KnowledgeTriageFlag } from '../../../domain/knowledge-records.js';
import type { ContextSelectionProps } from '../../../domain/value-objects/ContextSelection.vo.js';

export interface KnowledgeEntryRepositoryPort {
  /** Persist one entry record, replacing the stored version in whole. */
  saveEntry(record: KnowledgeEntryRecord): Promise<void>;

  /** Known absence is null; unreadable state is an error. */
  findEntryById(entryId: string): Promise<KnowledgeEntryRecord | null>;

  /** List entries for one project, or every project when no id is given. */
  listEntriesByProject(projectId?: string): Promise<readonly KnowledgeEntryRecord[]>;

  /**
   * List every entry captured from one attempt, in capture order: the
   * candidate-claim triage reads an attempt's queue through it.
   */
  listEntriesBySourceAttempt(attemptId: string): Promise<readonly KnowledgeEntryRecord[]>;

  /**
   * Attach one candidate's triage escalation. Write-once: refuses — by
   * throwing — when the entry already carries a triage flag or already has a
   * decided disposition (anything but `candidate`), and for an unknown entry
   * id or an undeclared flag value. The write bumps the record's revision;
   * timestamps stay with the use cases that own the clock.
   */
  setTriageFlag(entryId: string, flag: KnowledgeTriageFlag): Promise<void>;

  /** Persist the orchestrator's selections for one attempt before context freezes. */
  saveContextSelections(attemptId: string, selections: readonly ContextSelectionProps[]): Promise<void>;

  /** List recorded selections for one attempt in recorded order. */
  listContextSelections(attemptId: string): Promise<readonly ContextSelectionProps[]>;
}
