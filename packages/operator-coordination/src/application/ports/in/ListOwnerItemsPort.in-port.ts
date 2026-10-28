// @generated inbound contract scaffold — refined for lane WB3a-3-1.
/**
 * ListOwnerItemsPort: list owner items, optionally by project, state and kind,
 * one entry per item id. Gating is derived, never stored; reading writes
 * nothing.
 */

import type { OwnerItemBlockRecord, OwnerItemRecord, OwnerItemState } from '../../../domain/owner-item-records.js';
import type { OwnerItemKindValue } from '../../../domain/value-objects/OwnerItemKind.vo.js';

export interface ListOwnerItemsRequest {
  readonly projectId?: string;
  readonly state?: OwnerItemState;
  readonly kind?: OwnerItemKindValue;
}

export interface ListOwnerItemsEntry {
  readonly item: OwnerItemRecord;
  readonly revision: number;
  /** isOwnerItemGating(item): open, a gating kind, and a lane or work-order block. */
  readonly gating: boolean;
  /** ownerItemGatedBlocks(item), in input order; empty when not gating. */
  readonly gatedBlocks: readonly OwnerItemBlockRecord[];
}

export interface ListOwnerItemsResult { readonly items: readonly ListOwnerItemsEntry[]; }

export interface ListOwnerItemsPort {
  listOwnerItems(request?: ListOwnerItemsRequest): Promise<ListOwnerItemsResult>;
}
