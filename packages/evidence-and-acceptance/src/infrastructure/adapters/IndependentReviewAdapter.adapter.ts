// @generated adapter stub — signature-matched for step 4 (no behaviour).
/**
 * IndependentReviewAdapter implements IndependentReviewPort.
 * Behaviour lands with the station implementation; every method refuses.
 */

import type { EvidenceResultValue } from '../../domain/value-objects/EvidenceResult.vo.js';
import type { ReviewFindingRecord } from '../../domain/evidence-records.js';
import { underlyingModelFamily } from '../../domain/entities/ReviewReceipt.js';
import type {
  IndependentReviewPort,
  RunIndependentReviewRequest,
  RunIndependentReviewResult,
} from '../../application/ports/out/IndependentReviewPort.out-port.js';

export interface IndependentReviewTransportResult {
  readonly rawOutput: string;
  readonly readOnlyVerified: boolean;
  readonly result: EvidenceResultValue;
  readonly findings: readonly ReviewFindingRecord[];
  readonly completedAtIso?: string;
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
    if (
      !isNonEmptyTrimmedString(request.candidateHeadSha) ||
      !isNonEmptyTrimmedString(request.implementerModel) ||
      !isNonEmptyTrimmedString(request.reviewerModel)
    ) {
      return {
        outcome: 'unavailable',
        reason: 'Independent review requires a candidate head and both model identities',
      };
    }
    if (
      request.reviewerModel === request.implementerModel ||
      underlyingModelFamily(request.reviewerModel) === underlyingModelFamily(request.implementerModel)
    ) {
      return {
        outcome: 'unavailable',
        reason: `Reviewer ${request.reviewerModel} and implementer ${request.implementerModel} share the same underlying model`,
      };
    }

    const runReview = this.options.runReview;
    if (runReview === undefined) {
      return {
        outcome: 'unavailable',
        reason: 'No independent review transport is configured',
      };
    }

    let review: IndependentReviewTransportResult;
    try {
      review = await runReview(request);
    } catch (error) {
      return {
        outcome: 'unavailable',
        reason: error instanceof Error ? error.message : 'Independent review transport failed',
      };
    }

    return {
      outcome: 'completed',
      readOnlyVerified: review.readOnlyVerified === true,
      result: review.result,
      findings: Array.isArray(review.findings) ? review.findings.map((finding) => ({ ...finding })) : [],
      rawOutput: typeof review.rawOutput === 'string' ? review.rawOutput : '',
      completedAtIso: isNonEmptyTrimmedString(review.completedAtIso)
        ? review.completedAtIso
        : new Date().toISOString(),
    };
  }
}