// @generated outbound contract scaffold — refined for migration step 5.
/**
 * KeeperPublicationPort: write attributed keeper entries to the configured
 * shelf provider. Entries matching secret patterns are refused before any
 * provider runs and written nowhere. Failed delivery is preserved for
 * reconciliation; shelf failure does not fail otherwise acceptable work.
 */

import type { KnowledgeEntryRecord } from '../../../domain/knowledge-records.js';

export interface PublishKeeperToShelfRequest {
  readonly entry: KnowledgeEntryRecord;
}

export type PublishKeeperToShelfResult =
  | { readonly outcome: 'published'; readonly externalRef: string }
  | { readonly outcome: 'failed'; readonly reason: string; readonly retryable?: boolean };

export interface KeeperPublicationPort {
  /** Write one attributed keeper entry to the shelf; failures come back for reconciliation. */
  publishKeeperToShelf(request: PublishKeeperToShelfRequest): Promise<PublishKeeperToShelfResult>;
}
