// @generated outbound contract scaffold — refined for lane AM3b-2.
/**
 * AttentionItemRepositoryPort: persist attention items as their own aggregate
 * in their own store; never shares another store. One item per (project,
 * subject, kind); an item's key never changes; nothing is ever deleted. A
 * stored item grants nothing.
 */

import type {
  AttentionItemRecord,
  AttentionItemState,
} from '../../../domain/attention-item-records.js';

/** A save that lost a race: the stored revision is not the one the caller read. */
export class AttentionItemRevisionConflictError extends Error {
  readonly itemId: string;
  readonly attemptedRevision: number;
  constructor(itemId: string, attemptedRevision: number, reason: string) {
    super(reason);
    this.name = 'AttentionItemRevisionConflictError';
    this.itemId = itemId;
    this.attemptedRevision = attemptedRevision;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A save whose key (attentionItemKey) another item already holds. */
export class AttentionItemKeyConflictError extends Error {
  readonly itemId: string;
  /** The item that holds the key. */
  readonly heldByItemId: string;
  constructor(itemId: string, heldByItemId: string, reason: string) {
    super(reason);
    this.name = 'AttentionItemKeyConflictError';
    this.itemId = itemId;
    this.heldByItemId = heldByItemId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface StoredAttentionItem {
  readonly revision: number;
  readonly item: AttentionItemRecord;
}

export interface AttentionItemListQuery {
  readonly projectId?: string;
  readonly state?: AttentionItemState;
  readonly kind?: string;
  readonly workOrderId?: string;
}

export interface AttentionItemRepositoryPort {
  /** Store at expectedRevision + 1; 0 means new. A moved revision or a held key raises its error and writes nothing. */
  save(item: AttentionItemRecord, expectedRevision: number): Promise<StoredAttentionItem>;
  /** Known absence is null. */
  get(itemId: string): Promise<StoredAttentionItem | null>;
  /** The item holding attentionItemKey(...), or null. */
  findByKey(key: string): Promise<StoredAttentionItem | null>;
  /** Sorted by firstRaisedAtIso, then itemId. All filters combine. */
  list(query?: AttentionItemListQuery): Promise<readonly StoredAttentionItem[]>;
}
