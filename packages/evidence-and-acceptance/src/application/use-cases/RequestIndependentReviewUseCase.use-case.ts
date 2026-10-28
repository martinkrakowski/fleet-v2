// @generated use-case scaffold — refined for step 4.
/**
 * RequestIndependentReviewUseCase binds a read-only review of one exact head
 * to its evidence. The reviewer must be a different underlying model from the
 * implementer: changing the provider seat prefix is not independence.
 */

import type {
  EvidenceAssessmentRecord,
  ReviewReceiptRecord,
} from '../../domain/evidence-records.js';
import { REVIEW_KINDS, REVIEW_REQUEST_ID_PATTERN } from '../../domain/evidence-records.js';
import { EvidenceAssessment } from '../../domain/entities/EvidenceAssessment.js';
import { AssessmentState } from '../../domain/value-objects/AssessmentState.vo.js';
import { ReviewReceipt, isSameModelFamily, underlyingModelFamily } from '../../domain/entities/ReviewReceipt.js';
import { placeholderEvidenceRefusal, placeholderReviewReceiptField } from '../../domain/placeholder-evidence.js';
import {
  EvidenceAssessmentRevisionConflictError,
  type EvidenceAssessmentRepositoryPort,
} from '../ports/out/EvidenceAssessmentRepositoryPort.out-port.js';
import type { EvidenceArchivePort } from '../ports/out/EvidenceArchivePort.out-port.js';
import type { IndependentReviewPort } from '../ports/out/IndependentReviewPort.out-port.js';
import type { EvidenceSeatPolicyPort } from '../ports/out/EvidenceSeatPolicyPort.out-port.js';
import type {
  RequestIndependentReviewPort,
  RequestIndependentReviewRequest,
  RequestIndependentReviewResult,
  ReviewRejection,
} from '../ports/in/RequestIndependentReviewPort.in-port.js';

export interface RequestIndependentReviewDependencies {
  readonly repo: EvidenceAssessmentRepositoryPort;
  readonly reviewer: IndependentReviewPort;
  readonly archive: EvidenceArchivePort;
  readonly seatPolicy?: EvidenceSeatPolicyPort;
}

const NOT_IMPLEMENTED = 'Not implemented: RequestIndependentReviewUseCase';

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Reviewer independence is judged on the underlying model, not the seat. */
function sharesUnderlyingModel(implementerModel: string, reviewerModel: string): boolean {
  return (
    implementerModel === reviewerModel ||
    isSameModelFamily(
      underlyingModelFamily(implementerModel),
      underlyingModelFamily(reviewerModel),
    )
  );
}

/** A rejection that carries the typed code only for conductor requests (those with a requestId). */
function rejectedFor(
  request: RequestIndependentReviewRequest,
  rejection: ReviewRejection,
  reason: string,
): RequestIndependentReviewResult {
  return request.requestId !== undefined
    ? { outcome: 'rejected', reason, rejection }
    : { outcome: 'rejected', reason };
}

export class RequestIndependentReviewUseCase implements RequestIndependentReviewPort {
  constructor(private readonly deps?: RequestIndependentReviewDependencies) {}

  /** Generic entry point kept for callers that hold an untyped use case. */
  async execute(input: unknown): Promise<RequestIndependentReviewResult> {
    return this.run(input as RequestIndependentReviewRequest | undefined);
  }

  async requestIndependentReview(
    request: RequestIndependentReviewRequest,
  ): Promise<RequestIndependentReviewResult> {
    return this.run(request);
  }

  private async run(request?: RequestIndependentReviewRequest): Promise<RequestIndependentReviewResult> {
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

    if (
      !isNonEmptyTrimmedString(request.assessmentId) ||
      !isNonEmptyTrimmedString(request.projectId) ||
      !isNonEmptyTrimmedString(request.attemptId) ||
      !isNonEmptyTrimmedString(request.candidateHeadSha) ||
      !isNonEmptyTrimmedString(request.policyRevision) ||
      !isNonEmptyTrimmedString(request.implementerModel) ||
      !isNonEmptyTrimmedString(request.reviewerModel)
    ) {
      return rejectedFor(
        request,
        'invalid-request',
        'Independent review requires non-empty assessmentId, projectId, attemptId, candidateHeadSha, policyRevision, implementerModel and reviewerModel',
      );
    }
    if (
      (request.kind !== undefined && !REVIEW_KINDS.includes(request.kind)) ||
      (request.requestId !== undefined &&
        (typeof request.requestId !== 'string' || !REVIEW_REQUEST_ID_PATTERN.test(request.requestId))) ||
      (request.requestId !== undefined && request.kind === undefined)
    ) {
      return rejectedFor(
        request,
        'invalid-request',
        'Independent review requires a known kind and a well-formed requestId together',
      );
    }
    if (sharesUnderlyingModel(request.implementerModel, request.reviewerModel)) {
      return rejectedFor(
        request,
        'not-independent',
        `Independent review requires a distinct underlying model: ${request.reviewerModel} and ${request.implementerModel} share the same underlying model`,
      );
    }
    if (deps.seatPolicy) {
      const check = await deps.seatPolicy.checkReviewerSeat({
        reviewerModel: request.reviewerModel,
      });
      if (check.outcome === 'refused') {
        return rejectedFor(request, 'seat-refused', check.reason);
      }
    }

    const existing = await deps.repo.findAssessmentById(request.assessmentId);
    if (existing === null) {
      return rejectedFor(
        request,
        'no-assessment',
        `No assessment exists for assessmentId '${request.assessmentId}'`,
      );
    }
    if (existing.candidateHeadSha !== request.candidateHeadSha) {
      return rejectedFor(
        request,
        'assessment-mismatch',
        `Assessment '${request.assessmentId}' exists for candidate head '${existing.candidateHeadSha}', not '${request.candidateHeadSha}'`,
      );
    }
    if (
      existing.projectId !== request.projectId ||
      existing.attemptId !== request.attemptId ||
      existing.policyRevision !== request.policyRevision
    ) {
      return rejectedFor(
        request,
        'assessment-mismatch',
        'Assessment identity mismatch (projectId, attemptId, or policyRevision does not match existing assessment)',
      );
    }
    if (existing.implementerModel !== request.implementerModel) {
      return rejectedFor(
        request,
        'assessment-mismatch',
        `Assessment '${existing.id}' was implemented on seat '${existing.implementerModel}', not '${request.implementerModel}'`,
      );
    }

    // A replayed request id never runs a second review (§3.5): the recorded
    // receipt answers when reviewer, kind and head match the request.
    if (request.requestId !== undefined) {
      const found = existing.reviewReceipts.find(
        (receipt) => receipt.requestId === request.requestId,
      );
      if (found !== undefined) {
        if (
          found.reviewerModel.trim() === request.reviewerModel.trim() &&
          found.kind === request.kind &&
          found.candidateHeadSha === request.candidateHeadSha
        ) {
          return { outcome: 'reviewed', receipt: found };
        }
        return rejectedFor(
          request,
          'request-id-reused',
          'Review request id ' + request.requestId + ' was already used for another review',
        );
      }
    }

    if (AssessmentState.create(existing.state).value?.isTerminal()) {
      return rejectedFor(
        request,
        'assessment-terminal',
        `Assessment '${existing.id}' is in terminal state '${existing.state}'`,
      );
    }

    const nowIso = isNonEmptyTrimmedString(request.nowIso) ? request.nowIso : new Date().toISOString();
    const run = await deps.reviewer.runIndependentReview({
      attemptId: request.attemptId,
      candidateHeadSha: request.candidateHeadSha,
      implementerModel: request.implementerModel,
      reviewerModel: request.reviewerModel,
      diffSummary: request.diffSummary,
    });
    if (run.outcome === 'unavailable') {
      try {
        await deps.repo.saveAssessment({
          ...existing,
          requestedReviewerModel: request.reviewerModel.trim(),
          revision: existing.revision + 1,
          updatedAtIso: nowIso,
        });
      } catch (error) {
        if (error instanceof EvidenceAssessmentRevisionConflictError) {
          return rejectedFor(request, 'review-unavailable', run.reason);
        }
        throw error;
      }
      return rejectedFor(request, 'review-unavailable', run.reason);
    }
    if (!run.readOnlyVerified) {
      return rejectedFor(
        request,
        'not-read-only',
        'Independent review was not verified read-only, so it is not evidence',
      );
    }

    const archived = await deps.archive.archiveEvidence({
      artifactId: `review-${request.assessmentId}-${request.candidateHeadSha}`,
      candidateHeadSha: request.candidateHeadSha,
      content: run.rawOutput,
    });

    const kindFields: Partial<ReviewReceiptRecord> =
      request.kind !== undefined ? { kind: request.kind } : {};
    const requestIdFields: Partial<ReviewReceiptRecord> =
      request.requestId !== undefined ? { requestId: request.requestId } : {};
    const receiptId =
      request.requestId !== undefined
        ? 'rr-' + request.assessmentId + '-' + request.candidateHeadSha.slice(0, 8) + '-' + request.requestId
        : 'rr-' + request.assessmentId + '-' + request.candidateHeadSha.slice(0, 8);
    const candidate: ReviewReceiptRecord = {
      id: receiptId,
      assessmentId: request.assessmentId,
      projectId: request.projectId,
      attemptId: request.attemptId,
      candidateHeadSha: request.candidateHeadSha,
      reviewerModel: request.reviewerModel,
      implementerModel: request.implementerModel,
      readOnlyVerified: run.readOnlyVerified,
      result: run.result,
      // A reviewer-reported state is not a disposition: findings are stored
      // unresolved, and only RecordFindingDispositionUseCase resolves them.
      findings: run.findings.map((finding) => ({
        ...finding,
        state: 'unresolved' as const,
        dispositionReason: null,
        dispositionEvidenceRef: null,
      })),
      evidenceRef: archived.evidenceRef,
      policyRevision: request.policyRevision,
      completedAtIso: run.completedAtIso,
      ...kindFields,
      ...requestIdFields,
    };
    // New writes only (plan §3.1, D1): stored receipts are not re-checked on load.
    const placeholderField = placeholderReviewReceiptField(candidate);
    if (placeholderField !== null) {
      return rejectedFor(
        request,
        'invalid-receipt',
        placeholderEvidenceRefusal('Independent review receipt', placeholderField),
      );
    }
    const validated = ReviewReceipt.create(candidate);
    if (!validated.success || validated.value === undefined) {
      return rejectedFor(
        request,
        'invalid-receipt',
        validated.error?.message ?? 'Independent review produced an invalid receipt',
      );
    }
    const receipt = validated.value.toRecord();

    const assessment = EvidenceAssessment.fromRecord({
      ...existing,
      requestedReviewerModel: request.reviewerModel.trim(),
    });
    assessment.appendReviewReceipt(receipt, nowIso);
    const merged = assessment.toRecord();
    const blockers = EvidenceAssessment.fromRecord(merged).collectBlockers();
    const updated: EvidenceAssessmentRecord = {
      ...merged,
      state: blockers.length > 0 ? 'blocked' : 'pending',
      blockers: [...blockers],
    };
    await deps.repo.saveAssessment(updated);

    return { outcome: 'reviewed', receipt };
  }
}