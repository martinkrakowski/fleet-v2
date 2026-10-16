// @generated use-case scaffold — refined for step 4.
/**
 * RequestIndependentReviewUseCase binds a read-only review of one exact head
 * to its evidence. The reviewer must be a different underlying model from the
 * implementer: changing the provider seat prefix is not independence.
 */

import type { EvidenceAssessmentRecord, ReviewReceiptRecord } from '../../domain/evidence-records.js';
import { EvidenceAssessment } from '../../domain/entities/EvidenceAssessment.js';
import { AssessmentState } from '../../domain/value-objects/AssessmentState.vo.js';
import { ReviewReceipt, underlyingModelFamily } from '../../domain/entities/ReviewReceipt.js';
import type { EvidenceAssessmentRepositoryPort } from '../ports/out/EvidenceAssessmentRepositoryPort.out-port.js';
import type { EvidenceArchivePort } from '../ports/out/EvidenceArchivePort.out-port.js';
import type { IndependentReviewPort } from '../ports/out/IndependentReviewPort.out-port.js';
import type {
  RequestIndependentReviewPort,
  RequestIndependentReviewRequest,
  RequestIndependentReviewResult,
} from '../ports/in/RequestIndependentReviewPort.in-port.js';

export interface RequestIndependentReviewDependencies {
  readonly repo: EvidenceAssessmentRepositoryPort;
  readonly reviewer: IndependentReviewPort;
  readonly archive: EvidenceArchivePort;
}

const NOT_IMPLEMENTED = 'Not implemented: RequestIndependentReviewUseCase';

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Reviewer independence is judged on the underlying model, not the seat. */
function sharesUnderlyingModel(implementerModel: string, reviewerModel: string): boolean {
  return (
    implementerModel === reviewerModel ||
    underlyingModelFamily(implementerModel) === underlyingModelFamily(reviewerModel)
  );
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
      return {
        outcome: 'rejected',
        reason:
          'Independent review requires non-empty assessmentId, projectId, attemptId, candidateHeadSha, policyRevision, implementerModel and reviewerModel',
      };
    }
    if (sharesUnderlyingModel(request.implementerModel, request.reviewerModel)) {
      return {
        outcome: 'rejected',
        reason: `Independent review requires a distinct underlying model: ${request.reviewerModel} and ${request.implementerModel} share the same underlying model`,
      };
    }

    const existing = await deps.repo.findAssessmentById(request.assessmentId);
    if (existing === null) {
      return {
        outcome: 'rejected',
        reason: `No assessment exists for assessmentId '${request.assessmentId}'`,
      };
    }
    if (existing.candidateHeadSha !== request.candidateHeadSha) {
      return {
        outcome: 'rejected',
        reason: `Assessment '${request.assessmentId}' exists for candidate head '${existing.candidateHeadSha}', not '${request.candidateHeadSha}'`,
      };
    }
    if (
      existing.projectId !== request.projectId ||
      existing.attemptId !== request.attemptId ||
      existing.policyRevision !== request.policyRevision
    ) {
      return {
        outcome: 'rejected',
        reason:
          'Assessment identity mismatch (projectId, attemptId, or policyRevision does not match existing assessment)',
      };
    }
    if (existing.implementerModel !== request.implementerModel) {
      return {
        outcome: 'rejected',
        reason: `Assessment '${existing.id}' was implemented on seat '${existing.implementerModel}', not '${request.implementerModel}'`,
      };
    }

    if (AssessmentState.create(existing.state).value?.isTerminal()) {
      return {
        outcome: 'rejected',
        reason: `Assessment '${existing.id}' is in terminal state '${existing.state}'`,
      };
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
      return { outcome: 'rejected', reason: run.reason };
    }
    if (!run.readOnlyVerified) {
      return {
        outcome: 'rejected',
        reason: 'Independent review was not verified read-only, so it is not evidence',
      };
    }

    const archived = await deps.archive.archiveEvidence({
      artifactId: `review-${request.assessmentId}-${request.candidateHeadSha}`,
      candidateHeadSha: request.candidateHeadSha,
      content: run.rawOutput,
    });

    const candidate: ReviewReceiptRecord = {
      id: `rr-${request.assessmentId}-${request.candidateHeadSha.slice(0, 8)}`,
      assessmentId: request.assessmentId,
      projectId: request.projectId,
      attemptId: request.attemptId,
      candidateHeadSha: request.candidateHeadSha,
      reviewerModel: request.reviewerModel,
      implementerModel: request.implementerModel,
      readOnlyVerified: run.readOnlyVerified,
      result: run.result,
      findings: run.findings.map((finding) => ({ ...finding })),
      evidenceRef: archived.evidenceRef,
      policyRevision: request.policyRevision,
      completedAtIso: run.completedAtIso,
    };
    const validated = ReviewReceipt.create(candidate);
    if (!validated.success || validated.value === undefined) {
      return {
        outcome: 'rejected',
        reason: validated.error?.message ?? 'Independent review produced an invalid receipt',
      };
    }
    const receipt = validated.value.toRecord();

    const assessment = EvidenceAssessment.fromRecord(existing);
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