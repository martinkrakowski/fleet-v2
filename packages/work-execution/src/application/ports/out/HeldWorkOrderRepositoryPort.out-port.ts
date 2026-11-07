/**
 * Held work-order store (PT1ca): an overlap-refused registration is kept here
 * instead of being dropped. Each record is written intent-first (`stage:
 * 'intent'`, carrying the full request digest) and settled to `held` once the
 * intent is durable; a replay with a changed work order id, intent id or
 * request digest is refused before anything is written (F129). A store that
 * cannot be read is `unreadable`, never an empty list.
 */

import type { HeldWorkOrderRecord } from '../../../domain/held-work-order.js';

export type HeldWorkOrderListResult =
  | { readonly outcome: 'ok'; readonly records: readonly HeldWorkOrderRecord[] }
  | { readonly outcome: 'unreadable' };

export type RecordHoldIntentResult =
  | { readonly outcome: 'recorded'; readonly record: HeldWorkOrderRecord }
  | { readonly outcome: 'already-held'; readonly record: HeldWorkOrderRecord }
  | {
      readonly outcome: 'refused';
      readonly reason:
        | 'held-request-mismatch'
        | 'intent-digest-mismatch'
        | 'invalid-record'
        | 'store-full'
        | 'store-unavailable';
    };

export type CompleteHoldIntentResult =
  | { readonly outcome: 'held'; readonly record: HeldWorkOrderRecord }
  | {
      readonly outcome: 'refused';
      readonly reason:
        | 'intent-not-found'
        | 'intent-digest-mismatch'
        | 'invalid-record'
        | 'store-unavailable';
    };

export type HeldWorkOrderLookupResult =
  | { readonly outcome: 'found'; readonly record: HeldWorkOrderRecord }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'unreadable' };

export interface HeldWorkOrderRepositoryPort {
  listHeldWorkOrders(): Promise<HeldWorkOrderListResult>;
  findByWorkOrderId(workOrderId: string): Promise<HeldWorkOrderLookupResult>;
  findByIntentId(intentId: string): Promise<HeldWorkOrderLookupResult>;
  recordHoldIntent(record: HeldWorkOrderRecord): Promise<RecordHoldIntentResult>;
  completeHoldIntent(input: {
    readonly intentId: string;
    readonly workOrderId: string;
    readonly requestDigest: string;
  }): Promise<CompleteHoldIntentResult>;
  deleteHeldWorkOrder(
    workOrderId: string,
    requestDigest: string,
  ): Promise<{ readonly outcome: 'deleted' | 'not-found' | 'refused' }>;
}
