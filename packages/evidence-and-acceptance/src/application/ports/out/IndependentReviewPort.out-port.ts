// @generated outbound contract scaffold — refined for step 4.
/**
 * Obtain an attributable read-only review from the configured independent
 * seat; transport and provider selection belong to the adapter.
 */

import type { EvidenceResultValue } from '../../../domain/value-objects/EvidenceResult.vo.js';
import type {
  ReviewFindingRecord,
  ReviewKind,
  ReviewUnknownReason,
} from '../../../domain/evidence-records.js';

export interface RunIndependentReviewRequest {
  readonly attemptId: string;
  readonly candidateHeadSha: string;
  readonly implementerModel: string;
  readonly reviewerModel: string;
  readonly diffSummary?: string;
  /** The review kind for conductor requests; a manual review carries no kind. */
  readonly kind?: ReviewKind;
  /** The frozen brief for a brief-check request; only meaningful with `kind`. */
  readonly briefText?: string;
}

/**
 * The fixed reason codes of an unavailable review (KF-14a): the route codes
 * name the reviewer route refusal, the seat codes the seat selection refusal,
 * and the rest the adapter-level failures. A code is a typed token, never a
 * transport or forge message.
 */
export const REVIEW_UNAVAILABLE_CODES = [
  'route-host-changed', 'route-not-opencode', 'route-no-port', 'route-no-auth-file',
  'route-unresolved',
  'seat-none', 'seat-ambiguous', 'seat-implementer', 'seat-tool-no-transport', 'seat-variant-unsupported',
  'same-family', 'transport-missing', 'transport-failed',
  'timeout', 'transport',
  'seat-busy',
] as const;
export type ReviewUnavailableCode = (typeof REVIEW_UNAVAILABLE_CODES)[number];

/**
 * The bounded transport diagnostic of an unavailable review (RV4): exit
 * code, timeout flag, capped stderr and whether stdout was empty. `stderr`
 * is capped at 2048 bytes before it leaves the transport; `stderr === null`
 * and `stdoutEmpty === null` mean the read threw, never `''` or `false`.
 * The message of the transport error never carries stderr or a path.
 */
export interface ReviewTransportDiagnostic {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stderr: string | null;
  readonly stdoutEmpty: boolean | null;
}

export type RunIndependentReviewResult =
  | {
      readonly outcome: 'completed';
      readonly readOnlyVerified: boolean;
      readonly result: EvidenceResultValue;
      readonly findings: readonly ReviewFindingRecord[];
      readonly rawOutput: string;
      readonly completedAtIso: string;
      /** Fixed cause code when `result === 'unknown'`; absent otherwise. */
      readonly unknownReason?: ReviewUnknownReason;
    }
  | {
      readonly outcome: 'unavailable';
      readonly reason: string;
      readonly code: ReviewUnavailableCode;
      /** The bounded transport diagnostic (RV4); absent when the transport carried none. */
      readonly diagnostic?: ReviewTransportDiagnostic;
    };

export interface IndependentReviewPort {
  runIndependentReview(request: RunIndependentReviewRequest): Promise<RunIndependentReviewResult>;
}
