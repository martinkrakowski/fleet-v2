// Outbound port of KS2 part 2 (D29): the recorded gate receipts, found by their full versioned key.
/**
 * GateReceiptReusePort finds a recorded gate receipt by its full versioned key
 * (see `domain/gate-receipt-key.ts`) and records a new receipt under a key.
 * It never runs a predicate and stores no secret value: a key or reference
 * that is secret-shaped is refused, never stored and never echoed.
 *
 * Direction of failure: a lookup hits only on an equal key. An unreadable
 * component, an unknown key version, an unreadable or oversized store, a
 * timeout or any other fault is a `miss`, never a hit and never an exception;
 * the caller then runs the predicate as usual. A receipt is written once per
 * key: recording an equal key again leaves the first receipt in place.
 * Neither method ever throws.
 */
import type { GateReceiptKey } from '../../../domain/gate-receipt-key.js';

/** Only a decided verdict is stored; unknown and skipped results are never reusable. */
export type GateReceiptReuseVerdict = 'pass' | 'fail';

export type GateReceiptFindMissReason =
  | 'key-unreadable'
  | 'key-version-unknown'
  | 'no-stored-receipt'
  | 'store-unreadable'
  | 'store-version-unknown'
  | 'store-timeout'
  | 'store-failed';

export type FindGateReceiptResult =
  | {
      readonly outcome: 'hit';
      readonly verdict: GateReceiptReuseVerdict;
      /** The reference the original run recorded for its receipt (an id, never output). */
      readonly receiptRef: string;
    }
  | { readonly outcome: 'miss'; readonly reason: GateReceiptFindMissReason };

export interface RecordGateReceiptRequest {
  readonly key: GateReceiptKey;
  readonly verdict: GateReceiptReuseVerdict;
  readonly receiptRef: string;
}

export type RecordGateReceiptRefusalReason =
  | 'key-unreadable'
  | 'key-version-unknown'
  | 'verdict-unreadable'
  | 'receipt-ref-unreadable'
  | 'store-unreadable'
  | 'store-version-unknown'
  | 'store-full'
  | 'store-timeout'
  | 'store-failed'
  | 'store-read-only';

export type RecordGateReceiptResult =
  | { readonly outcome: 'recorded' }
  /** An equal key already holds a receipt; it was left unchanged. */
  | { readonly outcome: 'already-recorded' }
  | { readonly outcome: 'refused'; readonly reason: RecordGateReceiptRefusalReason };

export interface GateReceiptReusePort {
  findGateReceipt(key: GateReceiptKey): Promise<FindGateReceiptResult>;
  recordGateReceipt(request: RecordGateReceiptRequest): Promise<RecordGateReceiptResult>;
}
