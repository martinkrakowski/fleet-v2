// @generated inbound contract scaffold — refined for migration step 4.
/**
 * RecordKnowledgeReusePort: record inclusion, demonstrated benefit, wrong
 * turns or unknown usefulness with attributable evidence. Inclusion alone
 * does not prove saved work; `helped` requires demonstrated benefit.
 */

import type { KnowledgeEntryRecord, KnowledgeReuseRecord } from '../../../domain/knowledge-records.js';
import type { KnowledgeReuseOutcomeValue } from '../../../domain/value-objects/KnowledgeReuseOutcome.vo.js';

export interface RecordKnowledgeReuseRequest {
  readonly reuseId: string;
  readonly entryId: string;
  readonly attemptId: string;
  readonly outcome: KnowledgeReuseOutcomeValue;
  readonly evidenceRef?: string | null;
  readonly nowIso?: string;
}

export type RecordKnowledgeReuseResult =
  | { readonly outcome: 'recorded'; readonly entry: KnowledgeEntryRecord; readonly reuse: KnowledgeReuseRecord }
  | { readonly outcome: 'rejected'; readonly reason: string };

export interface RecordKnowledgeReusePort {
  /** Record one attributable reuse outcome for one entry version. */
  recordKnowledgeReuse(request: RecordKnowledgeReuseRequest): Promise<RecordKnowledgeReuseResult>;
}
