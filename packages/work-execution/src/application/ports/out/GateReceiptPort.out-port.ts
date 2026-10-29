// GateReceiptPort: the conducted gate's verification receipts (KF-13a).
/**
 * Record one verification receipt per acceptance check of a frozen brief, at
 * the collected head, in the evidence context's assessment. One call per
 * gate carries every receipt in check order; a rejected record is
 * unavailable, never a guess — acceptance is never attempted without the
 * gate's evidence.
 */

import type { CheckCoverage } from '@fleet/evidence-and-acceptance';
import type { GatePredicateVerdict } from './GatePredicatePort.out-port.js';

export interface RecordGateReceiptsRequest {
  readonly attemptId: string;
  readonly projectId: string;
  /** 40 lowercase hex: the exact collected head the gate evaluated. */
  readonly candidateHeadSha: string;
  readonly hostId: string;
  readonly policyRevision: string;
  readonly completedAtIso: string;
  readonly evidenceRef: string;
  /** One entry per acceptance check, in the frozen brief's check order. */
  readonly receipts: readonly {
    readonly procedureName: string;
    readonly result: GatePredicateVerdict;
    readonly exitCode: number | null;
    readonly coverage?: CheckCoverage;
  }[];
}

export type RecordGateReceiptsResult =
  | { readonly outcome: 'recorded'; readonly count: number }
  | { readonly outcome: 'unavailable'; readonly reason: string };

export interface GateReceiptPort {
  recordGateReceipts(request: RecordGateReceiptsRequest): Promise<RecordGateReceiptsResult>;
}
