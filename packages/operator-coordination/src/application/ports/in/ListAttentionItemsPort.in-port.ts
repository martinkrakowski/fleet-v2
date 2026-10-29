// @generated inbound contract scaffold — refined for lane AM3b-4.
/**
 * ListAttentionItemsPort: list attention items, optionally by project, state,
 * kind and work order, one entry per item id, without mutating state. The
 * store stays generic; each caller owns its closed list of kinds.
 */

import type { AttentionItemRecord, AttentionItemState } from '../../../domain/attention-item-records.js';

export interface ListAttentionItemsRequest {
  readonly projectId?: string;
  readonly state?: AttentionItemState;
  readonly kind?: string;
  readonly workOrderId?: string;
}

/** One stored item with the revision it currently sits at. */
export interface ListAttentionItemsEntry {
  readonly item: AttentionItemRecord;
  readonly revision: number;
}

export interface ListAttentionItemsResult { readonly items: readonly ListAttentionItemsEntry[]; }

export interface ListAttentionItemsPort {
  listAttentionItems(request?: ListAttentionItemsRequest): Promise<ListAttentionItemsResult>;
}
