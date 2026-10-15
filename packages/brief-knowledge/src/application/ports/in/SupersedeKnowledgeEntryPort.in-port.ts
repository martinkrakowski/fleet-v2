// @generated inbound contract scaffold — refined for migration step 4.
/**
 * SupersedeKnowledgeEntryPort: link a checked correction to the older entry
 * it replaces and exclude superseded content from normal retrieval.
 */

import type { KnowledgeEntryRecord } from '../../../domain/knowledge-records.js';

export interface SupersedeKnowledgeEntryRequest {
  readonly olderEntryId: string;
  readonly newerEntryId: string;
  readonly checkerId: string;
  readonly reason: string;
  readonly nowIso?: string;
}

export type SupersedeKnowledgeEntryResult =
  | {
      readonly outcome: 'superseded';
      readonly olderEntry: KnowledgeEntryRecord;
      readonly newerEntry: KnowledgeEntryRecord;
    }
  | { readonly outcome: 'rejected'; readonly reason: string };

export interface SupersedeKnowledgeEntryPort {
  /** Link one checked correction to the older entry it replaces. */
  supersedeKnowledgeEntry(request: SupersedeKnowledgeEntryRequest): Promise<SupersedeKnowledgeEntryResult>;
}
