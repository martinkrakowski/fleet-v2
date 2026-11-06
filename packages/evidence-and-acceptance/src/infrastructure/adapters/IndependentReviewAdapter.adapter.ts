// @generated adapter stub — signature-matched for step 4 (no behaviour).
/**
 * IndependentReviewAdapter implements IndependentReviewPort.
 * Behaviour lands with the station implementation; every method refuses.
 */

import type { EvidenceResultValue } from '../../domain/value-objects/EvidenceResult.vo.js';
import type { ReviewFindingRecord, ReviewUnknownReason } from '../../domain/evidence-records.js';
import { REVIEW_UNKNOWN_REASONS } from '../../domain/evidence-records.js';
import { isSameModelFamily, underlyingModelFamily } from '../../domain/entities/ReviewReceipt.js';
import type {
  IndependentReviewPort,
  RunIndependentReviewRequest,
  RunIndependentReviewResult,
} from '../../application/ports/out/IndependentReviewPort.out-port.js';
import { isTimeoutError, ReviewTransportError } from './OcmReviewTransport.adapter.js';

/** Re-exported so the timeout classification lives with the transport error it reads. */
export { isTimeoutError } from './OcmReviewTransport.adapter.js';

export interface IndependentReviewTransportResult {
  readonly rawOutput: string;
  readonly readOnlyVerified: boolean;
  readonly result: EvidenceResultValue;
  readonly findings: readonly ReviewFindingRecord[];
  readonly completedAtIso?: string;
  /** Fixed cause code when `result === 'unknown'`; absent otherwise. */
  readonly unknownReason?: ReviewUnknownReason;
}

export interface IndependentReviewOptions {
  /** Transport to the configured independent reviewer seat. */
  readonly runReview?: (
    request: RunIndependentReviewRequest,
  ) => Promise<IndependentReviewTransportResult>;
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A data property of `value`; a getter is never invoked and a throw reads as `undefined`. */
function ownValue(value: unknown, key: string): unknown {
  try {
    if (!isPlainRecord(value)) {
      return undefined;
    }
    return Object.getOwnPropertyDescriptor(value, key)?.value;
  } catch {
    return undefined;
  }
}

export class IndependentReviewAdapter implements IndependentReviewPort {
  constructor(private readonly options: IndependentReviewOptions = {}) {}

  /**
   * Independence is checked here as well as in the use case: a seat that
   * cannot prove it is a different underlying model, or that cannot prove it
   * stayed read-only, is unavailable as evidence rather than a review.
   */
  async runIndependentReview(
    request: RunIndependentReviewRequest,
  ): Promise<RunIndependentReviewResult> {
    // Runtime input never throws: a null, a non-object or a throwing getter
    // reads as the typed refusal below.
    const candidateHeadSha = ownValue(request, 'candidateHeadSha');
    const implementerModel = ownValue(request, 'implementerModel');
    const reviewerModel = ownValue(request, 'reviewerModel');
    if (
      !isNonEmptyTrimmedString(candidateHeadSha) ||
      !isNonEmptyTrimmedString(implementerModel) ||
      !isNonEmptyTrimmedString(reviewerModel)
    ) {
      return {
        outcome: 'unavailable',
        reason: 'Independent review requires a candidate head and both model identities',
        code: 'transport-failed',
      };
    }
    if (
      reviewerModel === implementerModel ||
      isSameModelFamily(
        underlyingModelFamily(reviewerModel),
        underlyingModelFamily(implementerModel),
      )
    ) {
      return {
        outcome: 'unavailable',
        reason: `Reviewer ${String(reviewerModel)} and implementer ${String(implementerModel)} share the same underlying model`,
        code: 'same-family',
      };
    }

    const runReview = this.options.runReview;
    if (runReview === undefined) {
      return {
        outcome: 'unavailable',
        reason: 'No independent review transport is configured',
        code: 'transport-missing',
      };
    }

    let review: IndependentReviewTransportResult;
    try {
      review = await runReview(request);
    } catch (error) {
      if (error instanceof ReviewTransportError) {
        return { outcome: 'unavailable', reason: error.message, code: error.code };
      }
      let reason = 'Independent review transport failed';
      try {
        if (error instanceof Error && typeof error.message === 'string') {
          reason = error.message;
        }
      } catch {
        // A hostile message getter keeps the fixed fallback reason.
      }
      return { outcome: 'unavailable', reason, code: isTimeoutError(error) ? 'timeout' : 'transport' };
    }

    // A malformed transport return is an unavailable transport, never a crash.
    try {
      if (!isPlainRecord(review)) {
        return {
          outcome: 'unavailable',
          reason: 'Independent review transport returned an invalid result',
          code: 'transport',
        };
      }
      const rawFindings: unknown = review.findings;
      // A sparse findings array is invalid transport output: a hole would read
      // as `undefined` and never as a finding. `Array.prototype.some` skips
      // holes, so density is checked by index.
      let findingsAreDense = Array.isArray(rawFindings);
      if (Array.isArray(rawFindings)) {
        for (let index = 0; index < rawFindings.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(rawFindings, index)) {
            findingsAreDense = false;
            break;
          }
        }
      }
      if (Array.isArray(rawFindings) && !findingsAreDense) {
        return {
          outcome: 'unavailable',
          reason: 'Independent review transport returned sparse findings',
          code: 'transport',
        };
      }
      // A non-plain finding is invalid transport output: dropping it would let
      // a fail receipt carry fewer findings than the reviewer returned.
      if (Array.isArray(rawFindings) && !rawFindings.every(isPlainRecord)) {
        return {
          outcome: 'unavailable',
          reason: 'Independent review transport returned non-plain findings',
          code: 'transport',
        };
      }
      // A non-array findings value is invalid transport output too: it must
      // never become a receipt with zero findings.
      if (!Array.isArray(rawFindings)) {
        return {
          outcome: 'unavailable',
          reason: 'Independent review transport returned non-array findings',
          code: 'transport',
        };
      }
      const findings = (rawFindings as unknown as ReviewFindingRecord[]).map((finding) => ({ ...finding }));
      const result: unknown = review.result;
      const unknownReason: unknown = review.unknownReason;
      return {
        outcome: 'completed',
        readOnlyVerified: review.readOnlyVerified === true,
        result: result === 'pass' || result === 'fail' || result === 'unknown' ? result : 'unknown',
        findings,
        rawOutput: typeof review.rawOutput === 'string' ? review.rawOutput : '',
        completedAtIso: isNonEmptyTrimmedString(review.completedAtIso)
          ? review.completedAtIso
          : new Date().toISOString(),
        // The fixed cause code travels only when the answer is unknown and the
        // code is one of the declared tokens; the key is omitted otherwise.
        ...(result === 'unknown' &&
        typeof unknownReason === 'string' &&
        (REVIEW_UNKNOWN_REASONS as readonly string[]).includes(unknownReason)
          ? { unknownReason: unknownReason as ReviewUnknownReason }
          : {}),
      };
    } catch {
      return {
        outcome: 'unavailable',
        reason: 'Independent review transport returned an invalid result',
        code: 'transport',
      };
    }
  }
}
