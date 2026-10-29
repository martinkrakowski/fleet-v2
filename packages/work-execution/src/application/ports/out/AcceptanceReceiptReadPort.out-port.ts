// @generated outbound contract scaffold — refined for lane OT2b-1.
/**
 * AcceptanceReceiptReadPort: the telemetry receipt read (plan §3.2, §3.3).
 * Reads one attempt's verification and review receipts at one candidate head
 * and projects them to telemetry-safe values only. A receipt id crosses the
 * port ONLY as the branded `TelemetryHashInput`; every other record field
 * stays inside the evidence context. Failure is a value: an unreadable store
 * is `unavailable`, never a throw and never a partial result.
 */

import type { TelemetryHashInput } from '../../../domain/run-telemetry-ids.js';

export type ReceiptResult = 'pending' | 'pass' | 'fail' | 'unknown' | 'not-applicable';
export type ReceiptReviewKind = 'brief-check' | 'code-review' | 'pre-merge';

export interface VerificationReceiptProjection {
  readonly receiptId: TelemetryHashInput;   // hash input only, never sent
  readonly result: ReceiptResult;
  readonly exitCode: number | null;
  readonly completedAtIso: string;
}

export interface ReviewReceiptProjection {
  readonly receiptId: TelemetryHashInput;
  readonly kind: ReceiptReviewKind;
  readonly result: ReceiptResult;
  readonly findings: { readonly blocker: number; readonly major: number; readonly minor: number; readonly nit: number };
  readonly completedAtIso: string;
}

export type ReadReceiptsForHeadResult =
  | { readonly outcome: 'found'; readonly verification: readonly VerificationReceiptProjection[]; readonly review: readonly ReviewReceiptProjection[] }
  | { readonly outcome: 'none' }
  | { readonly outcome: 'unavailable'; readonly reason: 'evidence-unreadable' };

export interface AcceptanceReceiptReadPort {
  readReceiptsForHead(attemptId: string, headSha: string): Promise<ReadReceiptsForHeadResult>;
}
