// @generated inbound contract scaffold — refined for migration step 4.
/**
 * PublishAcceptedKeeperPort: publish one accepted fact with source and
 * checker attribution; preserve failed delivery for reconciliation. Shelf
 * failure does not fail otherwise acceptable work.
 */

import type { KnowledgeEntryRecord } from '../../../domain/knowledge-records.js';

export interface PublishAcceptedKeeperRequest {
  readonly entryId: string;
  readonly nowIso?: string;
}

export type PublishAcceptedKeeperResult =
  | { readonly outcome: 'published'; readonly entry: KnowledgeEntryRecord; readonly externalRef: string }
  | { readonly outcome: 'delivery-failed'; readonly entry: KnowledgeEntryRecord; readonly reason: string }
  | { readonly outcome: 'rejected'; readonly reason: string };

export interface PublishAcceptedKeeperPort {
  /** Publish one accepted keeper; failed delivery is preserved for reconciliation. */
  publishAcceptedKeeper(request: PublishAcceptedKeeperRequest): Promise<PublishAcceptedKeeperResult>;
}
