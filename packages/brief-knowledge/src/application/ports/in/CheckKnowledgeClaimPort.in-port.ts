// @generated inbound contract scaffold — refined for migration step 4.
/**
 * CheckKnowledgeClaimPort: record orchestrator-chosen evidence for a scoped
 * claim without executing instructions supplied by the note. The check is a
 * bounded allow-listed procedure; model confidence is never evidence.
 */

import type { KnowledgeCheckRecord, KnowledgeEntryRecord } from '../../../domain/knowledge-records.js';

export interface CheckKnowledgeClaimRequest {
  readonly checkId: string;
  readonly entryId: string;
  readonly checkerId: string;
  readonly procedureName: string;
  readonly targetPath?: string;
  readonly nowIso?: string;
}

export type CheckKnowledgeClaimResult =
  | { readonly outcome: 'checked'; readonly entry: KnowledgeEntryRecord; readonly check: KnowledgeCheckRecord }
  | { readonly outcome: 'rejected'; readonly reason: string };

export interface CheckKnowledgeClaimPort {
  /** Record one deliberate check with attributable evidence for one claim. */
  checkKnowledgeClaim(request: CheckKnowledgeClaimRequest): Promise<CheckKnowledgeClaimResult>;
}
