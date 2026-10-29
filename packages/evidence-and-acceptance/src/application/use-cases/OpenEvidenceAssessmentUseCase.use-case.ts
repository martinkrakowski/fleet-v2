// @generated use-case scaffold — refined for step 4.
/**
 * OpenEvidenceAssessmentUseCase creates or resolves the pending acceptance
 * assessment that one attempt's independent review binds to (follow-up (b)).
 * It is idempotent: the conductor may call it on every review act, and a
 * second call for the same head, policy and implementer seat answers
 * `exists` without writing. A stored assessment at another head, under
 * another policy or on another implementer seat is refused with
 * `head-mismatch` (never overwritten, never marked stale — acceptance owns
 * staleness), and a terminal assessment at the same head is refused with
 * `terminal`.
 */

import { assessmentIdForAttempt } from '../../domain/assessment-id.js';
import type { EvidenceAssessmentRecord } from '../../domain/evidence-records.js';
import { AssessmentState } from '../../domain/value-objects/AssessmentState.vo.js';
import type { EvidenceAssessmentRepositoryPort } from '../ports/out/EvidenceAssessmentRepositoryPort.out-port.js';
import type {
  OpenEvidenceAssessmentPort,
  OpenEvidenceAssessmentRequest,
  OpenEvidenceAssessmentResult,
} from '../ports/in/OpenEvidenceAssessmentPort.in-port.js';

export interface OpenEvidenceAssessmentDependencies {
  readonly repo: EvidenceAssessmentRepositoryPort;
}

const NOT_IMPLEMENTED = 'Not implemented: OpenEvidenceAssessmentUseCase';
const CANDIDATE_HEAD_SHA_PATTERN = /^[0-9a-f]{40}$/;

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class OpenEvidenceAssessmentUseCase implements OpenEvidenceAssessmentPort {
  constructor(private readonly deps?: OpenEvidenceAssessmentDependencies) {}

  /** Generic entry point kept for callers that hold an untyped use case. */
  async execute(input: unknown): Promise<OpenEvidenceAssessmentResult> {
    return this.run(input as OpenEvidenceAssessmentRequest | undefined);
  }

  async openEvidenceAssessment(request: OpenEvidenceAssessmentRequest): Promise<OpenEvidenceAssessmentResult> {
    return this.run(request);
  }

  private async run(request?: OpenEvidenceAssessmentRequest): Promise<OpenEvidenceAssessmentResult> {
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

    // Validate first: no store call happens on an invalid request.
    if (
      !isNonEmptyTrimmedString(request.attemptId) ||
      !isNonEmptyTrimmedString(request.projectId) ||
      !CANDIDATE_HEAD_SHA_PATTERN.test(request.candidateHeadSha) ||
      !isNonEmptyTrimmedString(request.policyRevision) ||
      !isNonEmptyTrimmedString(request.implementerModel) ||
      !Array.isArray(request.requiredChecks) ||
      !request.requiredChecks.every(isNonEmptyTrimmedString)
    ) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }

    const nowIso = isNonEmptyTrimmedString(request.nowIso) ? request.nowIso : new Date().toISOString();
    const assessmentId = assessmentIdForAttempt(request.attemptId);

    let existing: EvidenceAssessmentRecord | null;
    try {
      existing = await deps.repo.findAssessmentById(assessmentId);
    } catch {
      // A throwing store answers the fixed code, never the adapter's error text.
      return { outcome: 'refused', reason: 'store-unreadable' };
    }

    if (existing === null) {
      // Save a pending record exactly as RequestVerification would before adding
      // receipts: no receipts, no blockers, and this lane's opening write is
      // already revision 1.
      const record: EvidenceAssessmentRecord = {
        id: assessmentId,
        projectId: request.projectId,
        attemptId: request.attemptId,
        candidateHeadSha: request.candidateHeadSha,
        policyRevision: request.policyRevision,
        implementerModel: request.implementerModel,
        requiredChecks: [...request.requiredChecks],
        state: 'pending',
        verificationReceipts: [],
        reviewReceipts: [],
        findingDispositions: [],
        acceptanceReceiptId: null,
        blockers: [],
        revision: 1,
        updatedAtIso: nowIso,
      };
      try {
        await deps.repo.saveAssessment(record);
      } catch {
        return { outcome: 'refused', reason: 'store-unreadable' };
      }
      return { outcome: 'opened', assessmentId };
    }

    // A stored assessment that does not match the request identity is refused,
    // never overwritten and never marked stale: acceptance owns staleness.
    if (
      existing.candidateHeadSha !== request.candidateHeadSha ||
      existing.policyRevision !== request.policyRevision ||
      existing.implementerModel !== request.implementerModel
    ) {
      return { outcome: 'refused', reason: 'head-mismatch' };
    }

    // Rejected and stale assessments are terminal; a pending or blocked
    // assessment at the same identity answers `exists` without writing.
    if (AssessmentState.create(existing.state).value?.isTerminal()) {
      return { outcome: 'refused', reason: 'terminal' };
    }

    return { outcome: 'exists', assessmentId };
  }
}
