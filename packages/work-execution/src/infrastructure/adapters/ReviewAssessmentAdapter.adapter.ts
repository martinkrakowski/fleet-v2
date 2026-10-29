// Implemented adapter — conductor review & CI station (cross-context step).
/**
 * ReviewAssessmentAdapter implements ReviewAssessmentPort by in-process
 * delegation to the evidence context's OpenEvidenceAssessment use case. It
 * owns every mapping; the composition root only binds the delegate. Like the
 * other consumer adapters it never throws: every failure is a typed result
 * with a reason code, and no store text reaches the caller. `opened` and
 * `exists` both map to `open`; `requiredChecks` is always `[]` because the
 * gate already ran.
 */

import type {
  OpenEvidenceAssessmentPort,
  OpenEvidenceAssessmentResult,
} from '@fleet/evidence-and-acceptance';
import type {
  OpenReviewAssessmentRequest,
  OpenReviewAssessmentResult,
  ReviewAssessmentPort,
} from '../../application/ports/out/ReviewAssessmentPort.out-port.js';

const HEAD_PATTERN = /^[0-9a-f]{40}$/;

export interface ReviewAssessmentDelegates {
  readonly openEvidenceAssessment?: OpenEvidenceAssessmentPort['openEvidenceAssessment'];
}

function isNonEmptyTrimmed(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function isValidOpenRequest(request: OpenReviewAssessmentRequest): boolean {
  return (
    isNonEmptyTrimmed(request.attemptId) &&
    isNonEmptyTrimmed(request.projectId) &&
    isNonEmptyTrimmed(request.policyRevision) &&
    isNonEmptyTrimmed(request.implementerModel) &&
    HEAD_PATTERN.test(request.candidateHeadSha) &&
    Array.isArray(request.requiredChecks) &&
    request.requiredChecks.length > 0 &&
    request.requiredChecks.every(isNonEmptyTrimmed)
  );
}

function mapRefusal(outcome: Extract<OpenEvidenceAssessmentResult, { outcome: 'refused' }>): OpenReviewAssessmentResult {
  switch (outcome.reason) {
    case 'invalid-request':
    case 'head-mismatch':
    case 'terminal':
      return { outcome: 'unavailable', reason: outcome.reason };
    case 'store-unreadable':
      return { outcome: 'unavailable', reason: 'unreadable' };
    default:
      return { outcome: 'unavailable', reason: 'unreadable' };
  }
}

export class ReviewAssessmentAdapter implements ReviewAssessmentPort {
  constructor(private readonly delegates: ReviewAssessmentDelegates = {}) {}

  async openReviewAssessment(request: OpenReviewAssessmentRequest): Promise<OpenReviewAssessmentResult> {
    if (!isValidOpenRequest(request)) {
      return { outcome: 'unavailable', reason: 'invalid-request' };
    }
    if (!this.delegates.openEvidenceAssessment) {
      return { outcome: 'unavailable', reason: 'not-configured' };
    }
    let result: OpenEvidenceAssessmentResult;
    try {
      result = await this.delegates.openEvidenceAssessment({
        attemptId: request.attemptId,
        projectId: request.projectId,
        candidateHeadSha: request.candidateHeadSha,
        policyRevision: request.policyRevision,
        implementerModel: request.implementerModel,
        requiredChecks: [...request.requiredChecks],
      });
    } catch {
      return { outcome: 'unavailable', reason: 'unreadable' };
    }
    // Only a known answer is trusted: opened and exists are open; anything else is unreadable, never open.
    if (result?.outcome === 'refused') {
      return mapRefusal(result);
    }
    if (result?.outcome === 'opened' || result?.outcome === 'exists') {
      return { outcome: 'open' };
    }
    return { outcome: 'unavailable', reason: 'unreadable' };
  }
}
