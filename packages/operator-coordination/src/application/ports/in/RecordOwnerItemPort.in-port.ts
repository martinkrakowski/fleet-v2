// @generated inbound contract scaffold — refined for lane WB3a-3-1.
/**
 * RecordOwnerItemPort: record a new open owner item from a closed body,
 * find-or-create by natural key. createdBy comes from the caller's actor,
 * never the body; the moment comes from the injected clock and the id from the
 * injected source, never the body. A recorded item grants nothing.
 */

import type { OwnerItemRecord } from '../../../domain/owner-item-records.js';
import type { OwnerItemRefusalCode } from '../../../domain/entities/OwnerItem.js';

/** The only source of "now" for the owner-item use cases; injected, never from a request. */
export interface OwnerItemClock { readonly nowIso: () => string; }

/** Mints new owner item ids; injected by the composition root. */
export interface OwnerItemIdSource { readonly newItemId: () => string; }

/** The record body: exactly these keys. It never carries an id, a time, a creator or a state. */
export interface RecordOwnerItemBody {
  readonly projectId: string;
  readonly kind: string;
  readonly subject: string | null;
  readonly refs: readonly unknown[];
  readonly blocks: readonly unknown[];
}

export type RecordOwnerItemRefusalCode = 'request' | 'clock' | 'id-taken' | OwnerItemRefusalCode;

export type RecordOwnerItemResult =
  | { readonly outcome: 'recorded'; readonly item: OwnerItemRecord; readonly revision: number }
  | { readonly outcome: 'exists'; readonly item: OwnerItemRecord; readonly revision: number }
  | { readonly outcome: 'key-held'; readonly heldByItemId: string; readonly reason: string }
  | { readonly outcome: 'refused'; readonly code: RecordOwnerItemRefusalCode; readonly reason: string };

export interface RecordOwnerItemPort {
  /** `body` is untrusted. `actor` is who records it, supplied by the composition root, never the body. */
  recordOwnerItem(body: unknown, actor: string): Promise<RecordOwnerItemResult>;
}
