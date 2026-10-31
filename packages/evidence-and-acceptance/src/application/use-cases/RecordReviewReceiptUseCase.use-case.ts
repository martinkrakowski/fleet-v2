// @generated use-case scaffold — refined for step 4.
/**
 * RecordReviewReceiptUseCase retains an attributable, read-only review of one
 * exact head. A review by the implementer's own underlying model is refused:
 * a different provider seat alone is not an independent review. When the
 * assessment records a requested reviewer, the receipt must name the same
 * model. When the free-seat policy port is bound and the flag is false, a
 * free, unknown or ambiguous reviewer is refused.
 */

import type { EvidenceAssessmentRecord, ReviewFindingRecord } from '../../domain/evidence-records.js';
import { EvidenceAssessment } from '../../domain/entities/EvidenceAssessment.js';
import { AssessmentState } from '../../domain/value-objects/AssessmentState.vo.js';
import { ReviewReceipt, isSameModelFamily, underlyingModelFamily } from '../../domain/entities/ReviewReceipt.js';
import { placeholderEvidenceRefusal, placeholderReviewReceiptField } from '../../domain/placeholder-evidence.js';
import type { EvidenceAssessmentRepositoryPort } from '../ports/out/EvidenceAssessmentRepositoryPort.out-port.js';
import type { EvidenceSeatPolicyPort } from '../ports/out/EvidenceSeatPolicyPort.out-port.js';
import type {
  RecordReviewReceiptPort,
  RecordReviewReceiptRequest,
  RecordReviewReceiptResult,
} from '../ports/in/RecordReviewReceiptPort.in-port.js';

export interface RecordReviewReceiptDependencies {
  readonly repo: EvidenceAssessmentRepositoryPort;
  readonly seatPolicy?: EvidenceSeatPolicyPort;
}

const NOT_IMPLEMENTED = 'Not implemented: RecordReviewReceiptUseCase';

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Rewrite each finding's id to `<receiptId>:<findingId>` unless it already
 * starts with `<receiptId>:`. Transport-numbered ids such as `review-1` are
 * unique only inside one receipt, and several receipts land on one head
 * (brief-check, code-review, pre-merge, re-reviews); scoping at record time
 * makes stored ids unique across receipts so a disposition can name exactly
 * one finding. The "exactly one receipt holds the id" evaluation rule in
 * EvidenceAssessment stays as defence in depth for records written before
 * this scoping.
 */
export function scopeFindingIdsToReceipt(
  receiptId: string,
  findings: readonly ReviewFindingRecord[],
): ReviewFindingRecord[] {
  const prefix = `${receiptId}:`;
  return findings.map((finding) =>
    finding.findingId.startsWith(prefix)
      ? { ...finding }
      : { ...finding, findingId: prefix + finding.findingId },
  );
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
    if (AssessmentState.create(assessment.state).value?.isTerminal()) {
      return {
        outcome: 'rejected',
        reason: `Assessment '${assessment.id}' is in terminal state '${assessment.state}'`,
      };
    }
    if (receipt.candidateHeadSha !== assessment.candidateHeadSha) {
      return {
        outcome: 'rejected',
        reason: `Review receipt belongs to head ${receipt.candidateHeadSha}, not the assessed head ${assessment.candidateHeadSha}`,
      };
    }
    if (receipt.policyRevision !== assessment.policyRevision) {
      return {
        outcome: 'rejected',
        reason: `Review receipt was produced under policy revision ${receipt.policyRevision}, not the assessed ${assessment.policyRevision}`,
      };
    }
    if (receipt.attemptId !== assessment.attemptId) {
      return {
        outcome: 'rejected',
        reason: `Review receipt belongs to attempt ${receipt.attemptId}, not the assessed attempt ${assessment.attemptId}`,
      };
    }
    if (receipt.projectId !== assessment.projectId) {
      return {
        outcome: 'rejected',
        reason: `Review receipt belongs to project ${receipt.projectId}, not the assessed project ${assessment.projectId}`,
      };
    }
    if (receipt.assessmentId !== assessment.id) {
      return {
        outcome: 'rejected',
        reason: `Review receipt belongs to assessment ${receipt.assessmentId}, not ${assessment.id}`,
      };
    }
    if (!receipt.readOnlyVerified) {
      return {
        outcome: 'rejected',
        reason: 'Review was not verified read-only, so it is not evidence',
      };
    }
    // The implementer identity on the receipt is a fact about the attempt's
    // recorded seat, not a caller-supplied label: it must restate the seat the
    // assessment recorded at creation.
    if (
      !isNonEmptyTrimmedString(receipt.reviewerModel) ||
      !isNonEmptyTrimmedString(receipt.implementerModel)
    ) {
      return {
        outcome: 'rejected',
        reason: 'Review receipt requires non-empty reviewerModel and implementerModel',
      };
    }
    if (receipt.implementerModel !== assessment.implementerModel) {
      return {
        outcome: 'rejected',
        reason: `Review receipt claims implementer '${receipt.implementerModel}', but assessment '${assessment.id}' was implemented on seat '${assessment.implementerModel}'`,
      };
    }
    if (
      isSameModelFamily(
        underlyingModelFamily(receipt.reviewerModel),
        underlyingModelFamily(assessment.implementerModel),
      )
    ) {
      return {
        outcome: 'rejected',
        reason: `Reviewer ${receipt.reviewerModel} shares the same underlying model as the implementer ${assessment.implementerModel}`,
      };
    }
    if (
      assessment.requestedReviewerModel !== undefined &&
      receipt.reviewerModel.trim() !== assessment.requestedReviewerModel
    ) {
      return {
        outcome: 'rejected',
        reason: `Review receipt names reviewer '${receipt.reviewerModel}', but assessment '${assessment.id}' requested reviewer '${assessment.requestedReviewerModel}'`,
      };
    }
    if (deps.seatPolicy) {
      const check = await deps.seatPolicy.checkReviewerSeat({
        reviewerModel: receipt.reviewerModel,
      });
      if (check.outcome === 'refused') {
        return { outcome: 'rejected', reason: check.reason };
      }
    }

    // Caller-supplied finding states are not trusted: every incoming finding is
    // normalised to unresolved with null disposition fields. Dispositions are
    // recorded only through RecordFindingDispositionUseCase.
    const normalizedReceipt = Array.isArray(receipt.findings)
      ? {
          ...receipt,
          findings: scopeFindingIdsToReceipt(
            receipt.id,
            receipt.findings.map((finding) => ({
              ...finding,
              state: 'unresolved' as const,
              dispositionReason: null,
              dispositionEvidenceRef: null,
            })),
          ),
        }
      : receipt;

    const validatedReceipt = ReviewReceipt.create(normalizedReceipt);
    if (!validatedReceipt.success || validatedReceipt.value === undefined) {
      return {
        outcome: 'rejected',
        reason: validatedReceipt.error?.message ?? 'Invalid review receipt',
      };
    }

    // New writes only (plan §3.1, D1): stored receipts are not re-checked on load.
    const placeholderField = placeholderReviewReceiptField(normalizedReceipt);
    if (placeholderField !== null) {
      return { outcome: 'rejected', reason: placeholderEvidenceRefusal('Review receipt', placeholderField) };
    }

    const aggregate = EvidenceAssessment.fromRecord(assessment);
    aggregate.appendReviewReceipt(normalizedReceipt, isNonEmptyTrimmedString(request.nowIso) ? request.nowIso : new Date().toISOString());
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