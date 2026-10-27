// @generated outbound contract scaffold — refined for lane WB3a-2.
/**
 * OwnerItemRepositoryPort: persist owner items as their own aggregate in their
 * own file; never shares another store. One item per natural key; nothing is
 * ever deleted. A stored item grants nothing.
 */

import type { OwnerItemRecord, OwnerItemState } from '../../../domain/owner-item-records.js';
import type { OwnerItemKindValue } from '../../../domain/value-objects/OwnerItemKind.vo.js';

/** A save that lost a race: the stored revision is not the one the caller read. */
export class OwnerItemRevisionConflictError extends Error {
  readonly itemId: string;
  readonly attemptedRevision: number;
  constructor(itemId: string, attemptedRevision: number, reason: string) {
    super(reason);
    this.name = 'OwnerItemRevisionConflictError';
    this.itemId = itemId;
    this.attemptedRevision = attemptedRevision;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A save whose natural key another item already holds (one merge, one plan decision, one question per item). */
export class OwnerItemKeyConflictError extends Error {
  readonly itemId: string;
  /** The item that holds the key. */
  readonly heldByItemId: string;
  constructor(itemId: string, heldByItemId: string, reason: string) {
    super(reason);
    this.name = 'OwnerItemKeyConflictError';
    this.itemId = itemId;
    this.heldByItemId = heldByItemId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface StoredOwnerItem {
  readonly revision: number;
  readonly item: OwnerItemRecord;
}

export interface OwnerItemListQuery {
  readonly projectId?: string;
  readonly state?: OwnerItemState;
  readonly kind?: OwnerItemKindValue;
}

export interface OwnerItemRepositoryPort {
  /** Store `item` at `expectedRevision + 1`; 0 means new. A moved revision or a held key raises its error. */
  save(item: OwnerItemRecord, expectedRevision: number): Promise<StoredOwnerItem>;
  /** Known absence is null. */
  get(itemId: string): Promise<StoredOwnerItem | null>;
  /** The item holding a natural key (`ownerItemKeys`), or null. */
  findByKey(key: string): Promise<StoredOwnerItem | null>;
  /** Sorted by createdAtIso, then itemId. All filters combine. */
  list(query?: OwnerItemListQuery): Promise<readonly StoredOwnerItem[]>;
}
