// @generated use-case scaffold — refined for step 4.
/**
 * RecordReviewReceiptUseCase retains an attributable, read-only review of one
 * exact head. A review by the implementer's own underlying model is refused:
 * a different provider seat alone is not an independent review.
 */

import type { EvidenceAssessmentRecord } from '../../domain/evidence-records.js';
import { EvidenceAssessment } from '../../domain/entities/EvidenceAssessment.js';
import { ReviewReceipt, underlyingModelFamily } from '../../domain/entities/ReviewReceipt.js';
import type { EvidenceAssessmentRepositoryPort } from '../ports/out/EvidenceAssessmentRepositoryPort.out-port.js';
import type {
  RecordReviewReceiptPort,
  RecordReviewReceiptRequest,
  RecordReviewReceiptResult,
} from '../ports/in/RecordReviewReceiptPort.in-port.js';

export interface RecordReviewReceiptDependencies {
  readonly repo: EvidenceAssessmentRepositoryPort;
}

const NOT_IMPLEMENTED = 'Not implemented: RecordReviewReceiptUseCase';

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class RecordReviewReceiptUseCase implements RecordReviewReceiptPort {
  constructor(private readonly deps?: RecordReviewReceiptDependencies) {}

  /** Generic entry point kept for callers that hold an untyped use case. */
  async execute(input: unknown): Promise<RecordReviewReceiptResult> {
    return this.run(input as RecordReviewReceiptRequest | undefined);
  }

  async recordReviewReceipt(request: RecordReviewReceiptRequest): Promise<RecordReviewReceiptResult> {
    return this.run(request);
  }

  private async run(request?: RecordReviewReceiptRequest): Promise<RecordReviewReceiptResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error(NOT_IMPLEMENTED);
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body flows into the validation below as a rejection.
    if (typeof request !== 'object' || request === null) {
      throw new Error(NOT_IMPLEMENTED);
    }
    const deps = this.deps;

    if (!isNonEmptyTrimmedString(request.assessmentId) || typeof request.receipt !== 'object' || request.receipt === null) {
      return { outcome: 'rejected', reason: 'Recording requires an assessmentId and a receipt' };
    }
    const receipt = request.receipt;

    const assessment = await deps.repo.findAssessmentById(request.assessmentId);
    if (assessment === null) {
      return { outcome: 'rejected', reason: 'Assessment not found' };
    }
    if (!receipt.readOnlyVerified) {
      return {
        outcome: 'rejected',
        reason: 'Review was not verified read-only, so it is not evidence',
      };
    }
    if (
      !isNonEmptyTrimmedString(receipt.reviewerModel) ||
      !isNonEmptyTrimmedString(receipt.implementerModel)
    ) {
      return {
        outcome: 'rejected',
        reason: 'Review receipt requires non-empty reviewerModel and implementerModel',
      };
    }
    if (
      underlyingModelFamily(receipt.reviewerModel) === underlyingModelFamily(receipt.implementerModel)
    ) {
      return {
        outcome: 'rejected',
        reason: `Reviewer ${receipt.reviewerModel} and implementer ${receipt.implementerModel} share the same underlying model`,
      };
    }
    if (receipt.candidateHeadSha !== assessment.candidateHeadSha) {
      return {
        outcome: 'rejected',
        reason: `Review receipt belongs to head ${receipt.candidateHeadSha}, not the assessed head ${assessment.candidateHeadSha}`,
      };
    }
    if (receipt.assessmentId !== assessment.id) {
      return {
        outcome: 'rejected',
        reason: `Review receipt belongs to assessment ${receipt.assessmentId}, not ${assessment.id}`,
      };
    }

    const validatedReceipt = ReviewReceipt.create(receipt);
    if (!validatedReceipt.success || validatedReceipt.value === undefined) {
      return {
        outcome: 'rejected',
        reason: validatedReceipt.error?.message ?? 'Invalid review receipt',
      };
    }

    const aggregate = EvidenceAssessment.fromRecord(assessment);
    aggregate.appendReviewReceipt(receipt, isNonEmptyTrimmedString(request.nowIso) ? request.nowIso : new Date().toISOString());
    const merged = aggregate.toRecord();
    const blockers = EvidenceAssessment.fromRecord(merged).collectBlockers();
    const updated: EvidenceAssessmentRecord = {
      ...merged,
      state: blockers.length > 0 ? 'blocked' : 'pending',
      blockers: [...blockers],
    };
    await deps.repo.saveAssessment(updated);
    return { outcome: 'recorded', assessment: updated };
  }
}