// Outbound contract (KS3): find and record a gate receipt by its full versioned key (KS2, D29).
/**
 * GateReceiptReusePort finds a recorded gate receipt by the full versioned key
 * of the speed plan §3.2.2 and records a new one under that key. A lookup hits
 * only on an equal key; an unreadable component, an unknown key version or an
 * unreadable store is a miss, never a hit, so the caller runs the predicate as
 * usual. Only a passing result is ever stored. It never runs a predicate,
 * never throws for runtime input and stores no secret-shaped value.
 */

import type { CheckCoverage } from '@fleet/evidence-and-acceptance';
import type { GateReceiptKey } from '../../../domain/gate-receipt-key.js';

/** The longest `detail` a stored receipt carries; longer text is refused, not cut. */
export const GATE_RECEIPT_MAX_DETAIL_LENGTH = 300;

/** What a receipt keeps of a passing predicate: its exit, its duration, one short line and its coverage. */
export interface StoredGatePassResult {
  readonly verdict: 'pass';
  readonly exitCode: number | null;
  readonly durationMs: number;
  /** One short line (at most GATE_RECEIPT_MAX_DETAIL_LENGTH characters); never command output. */
  readonly detail: string;
  readonly coverage?: CheckCoverage;
}

export type FindGateReceiptMissReason =
  | 'no-stored-receipt'
  | 'stored-key-unreadable'
  | 'stored-key-version-unknown'
  | 'supplied-key-unreadable'
  | 'key-changed'
  | 'stored-result-unreadable'
  | 'store-unavailable';

export type FindGateReceiptResult =
  | { readonly outcome: 'hit'; readonly result: StoredGatePassResult }
  | { readonly outcome: 'miss'; readonly reason: FindGateReceiptMissReason };

export interface RecordGateReceiptRequest {
  readonly key: GateReceiptKey;
  readonly result: StoredGatePassResult;
}

/** `already-recorded` is the idempotent answer: the first receipt under a key stays. */
export type RecordGateReceiptResult =
  | { readonly outcome: 'recorded' }
  | { readonly outcome: 'already-recorded' }
  | { readonly outcome: 'refused'; readonly reason: 'key-unreadable' | 'result-not-storable' }
  | { readonly outcome: 'unavailable' };

export interface GateReceiptReusePort {
  findGateReceipt(key: GateReceiptKey): Promise<FindGateReceiptResult>;
  recordGateReceipt(request: RecordGateReceiptRequest): Promise<RecordGateReceiptResult>;
}
