// Implemented adapter — conductor review & CI station (cross-context step).
/**
 * ReviewRequestAdapter implements ReviewRequestPort by in-process delegation to
 * evidence-and-acceptance request/review and inspection use cases. It owns
 * every mapping; the composition root only binds the delegates. Unlike the
 * acceptance adapters it never throws: every failure is a typed result with a
 * reason code, and no transport or forge text reaches the caller.
 */

import {
  REVIEW_KINDS,
  REVIEW_REQUEST_ID_PATTERN,
  assessmentIdForAttempt,
} from '@fleet/evidence-and-acceptance';
import type {
  EvidenceResultValue,
  InspectAcceptanceEvidencePort,
  InspectAcceptanceEvidenceResult,
  RequestIndependentReviewPort,
  RequestIndependentReviewResult,
  ReviewReceiptRecord,
  ReviewRejection,
} from '@fleet/evidence-and-acceptance';
import type {
  FindReviewReceiptRequest,
  FindReviewReceiptResult,
  ReviewRequest,
  ReviewRequestPort,
  ReviewRequestResult,
  ReviewReceiptSummary,
  ReviewVerdict,
} from '../../application/ports/out/ReviewRequestPort.out-port.js';

const HEAD_PATTERN = /^[0-9a-f]{40}$/;
const REVIEW_KIND_VALUES: readonly string[] = REVIEW_KINDS;
const BRIEF_TEXT_MAX_BYTES = 64 * 1024;

export interface ReviewRequestDelegates {
  readonly requestIndependentReview?: RequestIndependentReviewPort['requestIndependentReview'];
  readonly inspectAcceptanceEvidence?: InspectAcceptanceEvidencePort['inspectAcceptanceEvidence'];
}

function isNonEmptyTrimmed(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function isReviewKind(value: unknown): boolean {
  return typeof value === 'string' && REVIEW_KIND_VALUES.includes(value);
}

/** A brief longer than 64 KiB is a refusal, never a truncated forward. */
function briefTextByteLength(briefText: string): number {
  return Buffer.byteLength(briefText, 'utf8');
}

function isValidReviewRequest(request: ReviewRequest): boolean {
  return (
    REVIEW_REQUEST_ID_PATTERN.test(request.requestId) &&
    isReviewKind(request.kind) &&
    isNonEmptyTrimmed(request.attemptId) &&
    isNonEmptyTrimmed(request.projectId) &&
    isNonEmptyTrimmed(request.policyRevision) &&
    isNonEmptyTrimmed(request.implementerModel) &&
    isNonEmptyTrimmed(request.reviewerModel) &&
    HEAD_PATTERN.test(request.candidateHeadSha)
  );
}

function isValidFindReceiptRequest(request: FindReviewReceiptRequest): boolean {
  return (
    REVIEW_REQUEST_ID_PATTERN.test(request.requestId) &&
    isNonEmptyTrimmed(request.attemptId) &&
    HEAD_PATTERN.test(request.candidateHeadSha)
  );
}

function mapVerdict(result: EvidenceResultValue): ReviewVerdict {
  if (result === 'pass') {
    return 'passed';
  }
  if (result === 'fail') {
    return 'failed';
  }
  return 'unknown';
}

/**
 * One shared summary builder used by requestReview and findReviewReceipt. The kind and request id are the
 * values the caller has already matched on the receipt; nothing is defaulted here.
 */
function summaryOf(
  receipt: ReviewReceiptRecord,
  kind: ReviewReceiptSummary['kind'],
  requestId: string,
): ReviewReceiptSummary {
  return {
    receiptId: receipt.id,
    requestId,
    kind,
    reviewerModel: receipt.reviewerModel,
    candidateHeadSha: receipt.candidateHeadSha,
    verdict: mapVerdict(receipt.result),
    findings: receipt.findings.map((finding) => ({
      findingId: finding.findingId,
      severity: finding.severity,
      summary: finding.summary,
      filePath: finding.filePath,
      line: finding.line,
    })),
  };
}

function mapRejection(rejection: ReviewRejection | undefined): ReviewRequestResult {
  switch (rejection) {
    case 'review-unavailable':
    case 'not-read-only':
    case 'invalid-receipt':
      return { outcome: 'no-receipt', reason: rejection };
    case 'invalid-request':
    case 'not-independent':
    case 'seat-refused':
    case 'no-assessment':
    case 'assessment-mismatch':
    case 'assessment-terminal':
    case 'request-id-reused':
      return { outcome: 'refused', reason: rejection };
    default:
      return { outcome: 'refused', reason: 'unclassified' };
  }
}

export class ReviewRequestAdapter implements ReviewRequestPort {
  constructor(private readonly delegates: ReviewRequestDelegates = {}) {}

  async requestReview(request: ReviewRequest): Promise<ReviewRequestResult> {
    if (
      !isValidReviewRequest(request) ||
      (request.briefText !== undefined &&
        (typeof request.briefText !== 'string' ||
          briefTextByteLength(request.briefText) > BRIEF_TEXT_MAX_BYTES))
    ) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    if (!this.delegates.requestIndependentReview) {
      return { outcome: 'refused', reason: 'not-configured' };
    }
    let result: RequestIndependentReviewResult;
    try {
      result = await this.delegates.requestIndependentReview({
        assessmentId: assessmentIdForAttempt(request.attemptId),
        projectId: request.projectId,
        attemptId: request.attemptId,
        candidateHeadSha: request.candidateHeadSha,
        policyRevision: request.policyRevision,
        implementerModel: request.implementerModel,
        reviewerModel: request.reviewerModel,
        kind: request.kind,
        requestId: request.requestId,
        // The frozen brief flows through only for a brief-check, so any other
        // kind's transport call carries exactly the fields it carried before.
        ...(request.kind === 'brief-check' && request.briefText !== undefined
          ? { briefText: request.briefText }
          : {}),
        ...(request.nowIso !== undefined ? { nowIso: request.nowIso } : {}),
      });
    } catch {
      return { outcome: 'unknown', reason: 'delegate-failed' };
    }
    if (result.outcome === 'reviewed') {
      const receipt = result.receipt;
      if (
        receipt.requestId !== request.requestId ||
        receipt.kind !== request.kind ||
        receipt.attemptId !== request.attemptId ||
        receipt.candidateHeadSha !== request.candidateHeadSha
      ) {
        return { outcome: 'unknown', reason: 'receipt-mismatch' };
      }
      return { outcome: 'receipt', receipt: summaryOf(receipt, request.kind, request.requestId) };
    }
    return mapRejection(result.rejection);
  }

  async findReviewReceipt(request: FindReviewReceiptRequest): Promise<FindReviewReceiptResult> {
    if (!isValidFindReceiptRequest(request)) {
      return { outcome: 'unavailable', reason: 'invalid-request' };
    }
    if (!this.delegates.inspectAcceptanceEvidence) {
      return { outcome: 'unavailable', reason: 'not-configured' };
    }
    let inspected: InspectAcceptanceEvidenceResult;
    try {
      inspected = await this.delegates.inspectAcceptanceEvidence({
        assessmentId: assessmentIdForAttempt(request.attemptId),
      });
    } catch {
      return { outcome: 'unavailable', reason: 'unreadable' };
    }
    if (inspected.outcome === 'not-found') {
      return { outcome: 'not-found' };
    }
    const assessment = inspected.assessment;
    if (assessment.attemptId !== request.attemptId) {
      return { outcome: 'not-found' };
    }
    const matches = assessment.reviewReceipts.filter(
      (receipt) => receipt.requestId === request.requestId,
    );
    if (matches.length === 0) {
      return { outcome: 'not-found' };
    }
    const [only] = matches;
    if (
      matches.length > 1 ||
      only.candidateHeadSha !== request.candidateHeadSha ||
      only.attemptId !== request.attemptId ||
      only.kind === undefined
    ) {
      return { outcome: 'unavailable', reason: 'receipt-mismatch' };
    }
    return { outcome: 'found', receipt: summaryOf(only, only.kind, request.requestId) };
  }
}
