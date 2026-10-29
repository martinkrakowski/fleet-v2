// ReviewRequestAdapter and CiStateAdapter: consumer-side conductor ports over
// the evidence context. Every mapping is owned here, never in the composition.
/**
 * Covers requestReview (validation, not-configured, receipt, rejection-code
 * mapping, mismatch and throw paths), findReviewReceipt (found, not-found,
 * receipt-mismatch, unreadable, not-configured) and readHeadCiState (each
 * state, head-moved, invalid head, not-configured, throw, another head, read
 * with unknown). All fakes are object literals; nothing touches a host.
 */

import { describe, expect, it } from 'vitest';

import type {
  EvidenceAssessmentRecord,
  InspectAcceptanceEvidenceRequest,
  InspectAcceptanceEvidenceResult,
  InspectHeadCiStateRequest,
  InspectHeadCiStateResult,
  RequestIndependentReviewRequest,
  RequestIndependentReviewResult,
  ReviewReceiptRecord,
  ReviewRejection,
} from '@fleet/evidence-and-acceptance';
import type {
  FindLatestReceiptOfKindRequest,
  ReviewRequest,
  ReviewRequestResult,
} from '../../../application/ports/out/ReviewRequestPort.out-port.js';
import { CiStateAdapter } from '../CiStateAdapter.adapter.js';
import { ReviewRequestAdapter } from '../ReviewRequestAdapter.adapter.js';

const ASSESSMENT_ID = 'assessment-attempt-example-1';
const HEAD = '0000000000000000000000000000000000000000';
const OTHER_HEAD = '1111111111111111111111111111111111111111';
const REQUEST_ID = 'review-01JB00000000000000000000NN';
const KIND = 'code-review';
const RECEIPT_ID = 'rr-assessment-attempt-example-1-00000000-review-01JB00000000000000000000NN';

function makeReceipt(overrides: Partial<ReviewReceiptRecord> = {}): ReviewReceiptRecord {
  return {
    id: RECEIPT_ID,
    assessmentId: ASSESSMENT_ID,
    projectId: 'project-example-1',
    attemptId: 'attempt-example-1',
    candidateHeadSha: HEAD,
    reviewerModel: 'example-provider/grok-4.7',
    implementerModel: 'example-provider/glm-5.3',
    readOnlyVerified: true,
    result: 'pass',
    findings: [
      {
        findingId: 'finding-example-1',
        severity: 'major',
        summary: 'first example finding',
        filePath: 'apps/api/src/index.ts',
        line: 3,
        state: 'unresolved',
        dispositionReason: 'fix applied later',
        dispositionEvidenceRef: 'evidence://example/finding-1',
      },
      {
        findingId: 'finding-example-2',
        severity: 'nit',
        summary: 'second example finding',
        filePath: null,
        line: null,
        state: 'unresolved',
        dispositionReason: 'no action',
        dispositionEvidenceRef: 'evidence://example/finding-2',
      },
    ],
    evidenceRef: 'evidence://example/review',
    policyRevision: 'policy-example-1',
    completedAtIso: '2026-10-28T00:00:00.000Z',
    kind: KIND,
    requestId: REQUEST_ID,
    ...overrides,
  };
}

function makeAssessment(overrides: Partial<EvidenceAssessmentRecord> = {}): EvidenceAssessmentRecord {
  return {
    id: ASSESSMENT_ID,
    projectId: 'project-example-1',
    attemptId: 'attempt-example-1',
    candidateHeadSha: HEAD,
    policyRevision: 'policy-example-1',
    implementerModel: 'example-provider/glm-5.3',
    requiredChecks: [],
    state: 'pending',
    verificationReceipts: [],
    reviewReceipts: [makeReceipt()],
    findingDispositions: [],
    acceptanceReceiptId: null,
    blockers: [],
    revision: 1,
    updatedAtIso: '2026-10-28T00:00:00.000Z',
    ...overrides,
  };
}

function makeReviewRequest(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    requestId: REQUEST_ID,
    kind: KIND,
    attemptId: 'attempt-example-1',
    projectId: 'project-example-1',
    candidateHeadSha: HEAD,
    policyRevision: 'policy-example-1',
    implementerModel: 'example-provider/glm-5.3',
    reviewerModel: 'example-provider/grok-4.7',
    ...overrides,
  };
}

function makeRequestReviewFake(result: RequestIndependentReviewResult) {
  const calls: RequestIndependentReviewRequest[] = [];
  const requestIndependentReview = async (request: RequestIndependentReviewRequest) => {
    calls.push(request);
    return result;
  };
  return { calls, requestIndependentReview };
}

function makeInspectFake(result: InspectAcceptanceEvidenceResult) {
  const calls: InspectAcceptanceEvidenceRequest[] = [];
  const inspectAcceptanceEvidence = async (request: InspectAcceptanceEvidenceRequest) => {
    calls.push(request);
    return result;
  };
  return { calls, inspectAcceptanceEvidence };
}

function makeHeadCiFake(result: InspectHeadCiStateResult) {
  const calls: InspectHeadCiStateRequest[] = [];
  const inspectHeadCiState = async (request: InspectHeadCiStateRequest) => {
    calls.push(request);
    return result;
  };
  return { calls, inspectHeadCiState };
}

const EXPECTED_SUMMARY = {
  receiptId: RECEIPT_ID,
  requestId: REQUEST_ID,
  kind: KIND,
  reviewerModel: 'example-provider/grok-4.7',
  candidateHeadSha: HEAD,
  verdict: 'passed',
  findings: [
    {
      findingId: 'finding-example-1',
      severity: 'major',
      summary: 'first example finding',
      filePath: 'apps/api/src/index.ts',
      line: 3,
    },
    {
      findingId: 'finding-example-2',
      severity: 'nit',
      summary: 'second example finding',
      filePath: null,
      line: null,
    },
  ],
};

describe('ReviewRequestAdapter.requestReview', () => {
  it('returns a receipt summary for a passing review and passes the conductor coordinates', async () => {
    const { calls, requestIndependentReview } = makeRequestReviewFake({
      outcome: 'reviewed',
      receipt: makeReceipt(),
    });
    const adapter = new ReviewRequestAdapter({ requestIndependentReview });

    const result = await adapter.requestReview(makeReviewRequest());

    expect(result).toEqual({ outcome: 'receipt', receipt: EXPECTED_SUMMARY });
    expect(calls).toHaveLength(1);
    expect(calls[0].assessmentId).toBe(ASSESSMENT_ID);
    expect(calls[0].kind).toBe(KIND);
    expect(calls[0].requestId).toBe(REQUEST_ID);
    expect(calls[0].candidateHeadSha).toBe(HEAD);
  });

  it('summaries carry exactly five keys and never the disposition or evidence fields', async () => {
    const { requestIndependentReview } = makeRequestReviewFake({
      outcome: 'reviewed',
      receipt: makeReceipt(),
    });
    const adapter = new ReviewRequestAdapter({ requestIndependentReview });

    const result = await adapter.requestReview(makeReviewRequest());

    expect(result.outcome).toBe('receipt');
    if (result.outcome === 'receipt') {
      expect(Object.keys(result.receipt.findings[0])).toEqual([
        'findingId',
        'severity',
        'summary',
        'filePath',
        'line',
      ]);
      expect(Object.keys(result.receipt.findings[1])).toEqual([
        'findingId',
        'severity',
        'summary',
        'filePath',
        'line',
      ]);
    }
    expect(JSON.stringify(result)).not.toContain('dispositionReason');
    expect(JSON.stringify(result)).not.toContain('dispositionEvidenceRef');
    expect(JSON.stringify(result)).not.toContain('evidence://');
  });

  it.each([
    ['fail', 'failed'],
    ['unknown', 'unknown'],
    ['pending', 'unknown'],
  ] as const)('maps a %s receipt verdict to %s', async (resultValue, expectedVerdict) => {
    const { requestIndependentReview } = makeRequestReviewFake({
      outcome: 'reviewed',
      receipt: makeReceipt({ result: resultValue }),
    });
    const adapter = new ReviewRequestAdapter({ requestIndependentReview });

    const result = await adapter.requestReview(makeReviewRequest());

    expect(result).toEqual({
      outcome: 'receipt',
      receipt: expect.objectContaining({ verdict: expectedVerdict }),
    });
  });

  const REJECTION_CASES: readonly (readonly [ReviewRejection, ReviewRequestResult])[] = [
    ['review-unavailable', { outcome: 'no-receipt', reason: 'review-unavailable', detail: null }],
    ['not-read-only', { outcome: 'no-receipt', reason: 'not-read-only', detail: null }],
    ['invalid-receipt', { outcome: 'no-receipt', reason: 'invalid-receipt', detail: null }],
    ['invalid-request', { outcome: 'refused', reason: 'invalid-request', detail: null }],
    ['not-independent', { outcome: 'refused', reason: 'not-independent', detail: null }],
    ['seat-refused', { outcome: 'refused', reason: 'seat-refused', detail: null }],
    ['no-assessment', { outcome: 'refused', reason: 'no-assessment', detail: null }],
    ['assessment-mismatch', { outcome: 'refused', reason: 'assessment-mismatch', detail: null }],
    ['assessment-terminal', { outcome: 'refused', reason: 'assessment-terminal', detail: null }],
    ['request-id-reused', { outcome: 'refused', reason: 'request-id-reused', detail: null }],
  ];

  it.each(REJECTION_CASES)(
    'maps rejection %s without leaking the delegate reason text',
    async (rejection, expected) => {
      const { requestIndependentReview } = makeRequestReviewFake({
        outcome: 'rejected',
        reason: 'free text from the delegate never reaches the caller',
        rejection,
      });
      const adapter = new ReviewRequestAdapter({ requestIndependentReview });

      const result = await adapter.requestReview(makeReviewRequest());

      expect(result).toEqual(expected);
      expect(JSON.stringify(result)).not.toContain('free text from the delegate never reaches the caller');
    },
  );

  it('maps a rejected without a rejection code to refused unclassified', async () => {
    const { requestIndependentReview } = makeRequestReviewFake({
      outcome: 'rejected',
      reason: 'no explicit rejection code',
    });
    const adapter = new ReviewRequestAdapter({ requestIndependentReview });

    const result = await adapter.requestReview(makeReviewRequest());

    expect(result).toEqual({ outcome: 'refused', reason: 'unclassified', detail: null });
    expect(JSON.stringify(result)).not.toContain('no explicit rejection code');
  });

  it('carries a matching delegate code as detail on no-receipt', async () => {
    const { requestIndependentReview } = makeRequestReviewFake({
      outcome: 'rejected',
      reason: 'free text from the delegate never reaches the caller',
      rejection: 'review-unavailable',
      code: 'route-no-auth-file',
    });
    const adapter = new ReviewRequestAdapter({ requestIndependentReview });

    const result = await adapter.requestReview(makeReviewRequest());

    expect(result).toEqual({
      outcome: 'no-receipt',
      reason: 'review-unavailable',
      detail: 'route-no-auth-file',
    });
    expect(JSON.stringify(result)).not.toContain('free text from the delegate never reaches the caller');
  });

  it('leaves detail null for a code that does not match the journal pattern', async () => {
    const { requestIndependentReview } = makeRequestReviewFake({
      outcome: 'rejected',
      reason: 'free text from the delegate never reaches the caller',
      rejection: 'review-unavailable',
      code: 'Not-A-Pattern-Code',
    } as unknown as RequestIndependentReviewResult);
    const adapter = new ReviewRequestAdapter({ requestIndependentReview });

    const result = await adapter.requestReview(makeReviewRequest());

    expect(result).toEqual({
      outcome: 'no-receipt',
      reason: 'review-unavailable',
      detail: null,
    });
  });

  it('is unknown receipt-mismatch when the receipt answers another request id', async () => {
    const { requestIndependentReview } = makeRequestReviewFake({
      outcome: 'reviewed',
      receipt: makeReceipt({ requestId: 'review-other' }),
    });
    const adapter = new ReviewRequestAdapter({ requestIndependentReview });

    const result = await adapter.requestReview(makeReviewRequest());

    expect(result).toEqual({ outcome: 'unknown', reason: 'receipt-mismatch' });
  });

  it.each([
    ['another kind', { kind: 'pre-merge' as const }],
    ['no kind', { kind: undefined }],
    ['another attempt', { attemptId: 'attempt-other' }],
  ])('is unknown receipt-mismatch when the receipt has %s', async (_label, override) => {
    const { requestIndependentReview } = makeRequestReviewFake({
      outcome: 'reviewed',
      receipt: makeReceipt(override as Partial<ReviewReceiptRecord>),
    });
    const adapter = new ReviewRequestAdapter({ requestIndependentReview });

    const result = await adapter.requestReview(makeReviewRequest({ kind: 'code-review' }));

    expect(result).toEqual({ outcome: 'unknown', reason: 'receipt-mismatch' });
  });

  it('is unknown receipt-mismatch when the receipt answers another head', async () => {
    const { requestIndependentReview } = makeRequestReviewFake({
      outcome: 'reviewed',
      receipt: makeReceipt({ candidateHeadSha: OTHER_HEAD }),
    });
    const adapter = new ReviewRequestAdapter({ requestIndependentReview });

    const result = await adapter.requestReview(makeReviewRequest());

    expect(result).toEqual({ outcome: 'unknown', reason: 'receipt-mismatch' });
  });

  it('is unknown delegate-failed when the delegate throws', async () => {
    const requestIndependentReview = async (): Promise<RequestIndependentReviewResult> => {
      throw new Error('delegate exploded');
    };
    const adapter = new ReviewRequestAdapter({ requestIndependentReview });

    const result = await adapter.requestReview(makeReviewRequest());

    expect(result).toEqual({ outcome: 'unknown', reason: 'delegate-failed' });
  });

  it.each([
    ['bad head', { candidateHeadSha: 'not-a-sha' }],
    ['unknown kind', { kind: 'unknown-kind' }],
    ['empty reviewer', { reviewerModel: '   ' }],
    ['request id with a space', { requestId: 'review-01JB 00000000000000000000NN' }],
  ] as const)(
    'refuses an invalid request (%s) without calling the delegate',
    async (_name, overrides) => {
      const { calls, requestIndependentReview } = makeRequestReviewFake({
        outcome: 'reviewed',
        receipt: makeReceipt(),
      });
      const adapter = new ReviewRequestAdapter({ requestIndependentReview });

      const result = await adapter.requestReview(makeReviewRequest(overrides as Partial<ReviewRequest>));

      expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request', detail: null });
      expect(calls).toHaveLength(0);
    },
  );

  it('refuses as not-configured when no delegates are bound', async () => {
    const adapter = new ReviewRequestAdapter();

    const result = await adapter.requestReview(makeReviewRequest());

    expect(result).toEqual({ outcome: 'refused', reason: 'not-configured', detail: null });
  });

  it('forwards briefText with a brief-check request', async () => {
    const { calls, requestIndependentReview } = makeRequestReviewFake({
      outcome: 'reviewed',
      receipt: makeReceipt({ kind: 'brief-check' }),
    });
    const adapter = new ReviewRequestAdapter({ requestIndependentReview });

    const result = await adapter.requestReview(
      makeReviewRequest({ kind: 'brief-check', briefText: '1. Add the review seat.\n2. Wire the checklist.' }),
    );

    expect(result).toEqual({
      outcome: 'receipt',
      receipt: { ...EXPECTED_SUMMARY, kind: 'brief-check' },
    });
    expect(calls[0].briefText).toBe('1. Add the review seat.\n2. Wire the checklist.');
  });

  it('does not forward briefText with a code-review request', async () => {
    const { calls, requestIndependentReview } = makeRequestReviewFake({
      outcome: 'reviewed',
      receipt: makeReceipt(),
    });
    const adapter = new ReviewRequestAdapter({ requestIndependentReview });

    const result = await adapter.requestReview(
      makeReviewRequest({ kind: 'code-review', briefText: '1. Add the review seat.' }),
    );

    expect(result).toEqual({ outcome: 'receipt', receipt: EXPECTED_SUMMARY });
    expect('briefText' in calls[0]).toBe(false);
  });

  it('refuses a brief-check request whose brief exceeds 64 KiB without calling the delegate', async () => {
    const { calls, requestIndependentReview } = makeRequestReviewFake({
      outcome: 'reviewed',
      receipt: makeReceipt(),
    });
    const adapter = new ReviewRequestAdapter({ requestIndependentReview });

    const result = await adapter.requestReview(
      makeReviewRequest({ kind: 'brief-check', briefText: 'a'.repeat(64 * 1024 + 1) }),
    );

    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request', detail: null });
    expect(calls).toHaveLength(0);
  });

  it('accepts a brief-check request whose brief is exactly 64 KiB', async () => {
    const { calls, requestIndependentReview } = makeRequestReviewFake({
      outcome: 'reviewed',
      receipt: makeReceipt({ kind: 'brief-check' }),
    });
    const adapter = new ReviewRequestAdapter({ requestIndependentReview });

    const result = await adapter.requestReview(
      makeReviewRequest({ kind: 'brief-check', briefText: 'a'.repeat(64 * 1024) }),
    );

    expect(result).toEqual({
      outcome: 'receipt',
      receipt: { ...EXPECTED_SUMMARY, kind: 'brief-check' },
    });
    expect(calls).toHaveLength(1);
  });

  it('counts a multibyte brief against the 64 KiB byte cap, not the character count', async () => {
    const { calls, requestIndependentReview } = makeRequestReviewFake({
      outcome: 'reviewed',
      receipt: makeReceipt(),
    });
    const adapter = new ReviewRequestAdapter({ requestIndependentReview });

    // 32769 'é' characters are 65538 utf-8 bytes: over the cap with room to spare.
    const result = await adapter.requestReview(
      makeReviewRequest({ kind: 'brief-check', briefText: 'é'.repeat(32 * 1024 + 1) }),
    );

    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request', detail: null });
    expect(calls).toHaveLength(0);
  });
});

describe('ReviewRequestAdapter.findReviewReceipt', () => {
  it('finds the receipt recorded for a request id', async () => {
    const { calls, inspectAcceptanceEvidence } = makeInspectFake({
      outcome: 'found',
      assessment: makeAssessment(),
    });
    const adapter = new ReviewRequestAdapter({ inspectAcceptanceEvidence });

    const result = await adapter.findReviewReceipt({
      attemptId: 'attempt-example-1',
      requestId: REQUEST_ID,
      candidateHeadSha: HEAD,
    });

    expect(result).toEqual({ outcome: 'found', receipt: EXPECTED_SUMMARY });
    expect(calls).toEqual([{ assessmentId: ASSESSMENT_ID }]);
  });

  it('is not-found when no receipt carries the request id', async () => {
    const { inspectAcceptanceEvidence } = makeInspectFake({
      outcome: 'found',
      assessment: makeAssessment({ reviewReceipts: [makeReceipt({ requestId: 'review-other' })] }),
    });
    const adapter = new ReviewRequestAdapter({ inspectAcceptanceEvidence });

    const result = await adapter.findReviewReceipt({
      attemptId: 'attempt-example-1',
      requestId: REQUEST_ID,
      candidateHeadSha: HEAD,
    });

    expect(result).toEqual({ outcome: 'not-found' });
  });

  it('is not-found when the assessment is absent', async () => {
    const { inspectAcceptanceEvidence } = makeInspectFake({
      outcome: 'not-found',
      query: ASSESSMENT_ID,
    });
    const adapter = new ReviewRequestAdapter({ inspectAcceptanceEvidence });

    const result = await adapter.findReviewReceipt({
      attemptId: 'attempt-example-1',
      requestId: REQUEST_ID,
      candidateHeadSha: HEAD,
    });

    expect(result).toEqual({ outcome: 'not-found' });
  });

  it('is not-found when the found assessment belongs to another attempt', async () => {
    const { inspectAcceptanceEvidence } = makeInspectFake({
      outcome: 'found',
      assessment: makeAssessment({ attemptId: 'attempt-example-2' }),
    });
    const adapter = new ReviewRequestAdapter({ inspectAcceptanceEvidence });

    const result = await adapter.findReviewReceipt({
      attemptId: 'attempt-example-1',
      requestId: REQUEST_ID,
      candidateHeadSha: HEAD,
    });

    expect(result).toEqual({ outcome: 'not-found' });
  });

  it('is unavailable receipt-mismatch when two receipts carry the request id', async () => {
    const { inspectAcceptanceEvidence } = makeInspectFake({
      outcome: 'found',
      assessment: makeAssessment({
        reviewReceipts: [makeReceipt(), makeReceipt({ id: RECEIPT_ID + '-second' })],
      }),
    });
    const adapter = new ReviewRequestAdapter({ inspectAcceptanceEvidence });

    const result = await adapter.findReviewReceipt({
      attemptId: 'attempt-example-1',
      requestId: REQUEST_ID,
      candidateHeadSha: HEAD,
    });

    expect(result).toEqual({ outcome: 'unavailable', reason: 'receipt-mismatch' });
  });

  it('is unavailable receipt-mismatch when the receipt carries the request id but no kind', async () => {
    const { inspectAcceptanceEvidence } = makeInspectFake({
      outcome: 'found',
      assessment: makeAssessment({ reviewReceipts: [makeReceipt({ kind: undefined })] }),
    });
    const adapter = new ReviewRequestAdapter({ inspectAcceptanceEvidence });

    const result = await adapter.findReviewReceipt({
      attemptId: 'attempt-example-1',
      requestId: REQUEST_ID,
      candidateHeadSha: HEAD,
    });

    expect(result).toEqual({ outcome: 'unavailable', reason: 'receipt-mismatch' });
  });

  it('is unavailable receipt-mismatch when the receipt names another attempt than its assessment', async () => {
    const { inspectAcceptanceEvidence } = makeInspectFake({
      outcome: 'found',
      assessment: makeAssessment({ reviewReceipts: [makeReceipt({ attemptId: 'attempt-other' })] }),
    });
    const adapter = new ReviewRequestAdapter({ inspectAcceptanceEvidence });

    const result = await adapter.findReviewReceipt({
      attemptId: 'attempt-example-1',
      requestId: REQUEST_ID,
      candidateHeadSha: HEAD,
    });

    expect(result).toEqual({ outcome: 'unavailable', reason: 'receipt-mismatch' });
  });

  it('is unavailable receipt-mismatch when the receipt answers another head', async () => {
    const { inspectAcceptanceEvidence } = makeInspectFake({
      outcome: 'found',
      assessment: makeAssessment({ reviewReceipts: [makeReceipt({ candidateHeadSha: OTHER_HEAD })] }),
    });
    const adapter = new ReviewRequestAdapter({ inspectAcceptanceEvidence });

    const result = await adapter.findReviewReceipt({
      attemptId: 'attempt-example-1',
      requestId: REQUEST_ID,
      candidateHeadSha: HEAD,
    });

    expect(result).toEqual({ outcome: 'unavailable', reason: 'receipt-mismatch' });
  });

  it('is unavailable unreadable when the inspection delegate throws', async () => {
    const inspectAcceptanceEvidence = async (): Promise<InspectAcceptanceEvidenceResult> => {
      throw new Error('inspection exploded');
    };
    const adapter = new ReviewRequestAdapter({ inspectAcceptanceEvidence });

    const result = await adapter.findReviewReceipt({
      attemptId: 'attempt-example-1',
      requestId: REQUEST_ID,
      candidateHeadSha: HEAD,
    });

    expect(result).toEqual({ outcome: 'unavailable', reason: 'unreadable' });
  });

  it('is unavailable not-configured when no inspection delegate is bound', async () => {
    const adapter = new ReviewRequestAdapter();

    const result = await adapter.findReviewReceipt({
      attemptId: 'attempt-example-1',
      requestId: REQUEST_ID,
      candidateHeadSha: HEAD,
    });

    expect(result).toEqual({ outcome: 'unavailable', reason: 'not-configured' });
  });
});

describe('ReviewRequestAdapter.findLatestReceiptOfKind', () => {
  const makeFindRequest = (
    overrides: Partial<FindLatestReceiptOfKindRequest> = {},
  ): FindLatestReceiptOfKindRequest => ({
    attemptId: 'attempt-example-1',
    candidateHeadSha: HEAD,
    kind: KIND,
    ...overrides,
  });
  /** One lookup over an inspection fake: the receipts the assessment holds, and the request overrides. */
  const latestOf = async (
    inspected: InspectAcceptanceEvidenceResult,
    overrides: Partial<FindLatestReceiptOfKindRequest> = {},
  ) => {
    const { calls, inspectAcceptanceEvidence } = makeInspectFake(inspected);
    const adapter = new ReviewRequestAdapter({ inspectAcceptanceEvidence });
    const result = await adapter.findLatestReceiptOfKind(makeFindRequest(overrides));
    return { calls, result };
  };
  const withReceipts = (reviewReceipts: ReviewReceiptRecord[]): InspectAcceptanceEvidenceResult => ({
    outcome: 'found',
    assessment: makeAssessment({ reviewReceipts }),
  });
  const receiptIdOf = (result: unknown): unknown =>
    (result as { receipt?: { receiptId?: unknown } }).receipt?.receiptId;

  it('is not-found when no receipt matches, and leaks no evidence reference', async () => {
    const { result } = await latestOf(withReceipts([]));

    expect(result).toEqual({ outcome: 'not-found' });
    expect(JSON.stringify(result)).not.toContain('evidence://');
  });

  it("finds the one receipt of the kind with requestId equal to the receipt's", async () => {
    const { calls, result } = await latestOf({ outcome: 'found', assessment: makeAssessment() });

    expect(result).toEqual({ outcome: 'found', receipt: EXPECTED_SUMMARY });
    expect(calls).toEqual([{ assessmentId: ASSESSMENT_ID }]);
  });

  it('returns the receipt with the later instant when the older is listed last', async () => {
    const { result } = await latestOf(withReceipts([
      makeReceipt({ id: RECEIPT_ID + '-newer', completedAtIso: '2026-10-28T12:00:00.000Z' }),
      makeReceipt({ id: RECEIPT_ID + '-older', completedAtIso: '2026-10-28T06:00:00.000Z' }),
    ]));

    expect(receiptIdOf(result)).toBe(RECEIPT_ID + '-newer');
  });

  it('compares instants, not strings: a sub-second timestamp beats a whole-second one that sorts after it', async () => {
    const { result } = await latestOf(withReceipts([
      makeReceipt({ id: RECEIPT_ID + '-whole', completedAtIso: '2026-10-28T12:00:00Z' }),
      makeReceipt({ id: RECEIPT_ID + '-half', completedAtIso: '2026-10-28T12:00:00.500Z' }),
      makeReceipt({ id: RECEIPT_ID + '-offset', completedAtIso: '2026-10-28T13:00:00.000+02:00' }),
    ]));

    expect(receiptIdOf(result)).toBe(RECEIPT_ID + '-half');
  });

  it('never lets an unparseable timestamp win', async () => {
    const { result } = await latestOf(withReceipts([
      makeReceipt({ id: RECEIPT_ID + '-garbage', completedAtIso: 'not-a-time' }),
      makeReceipt({ id: RECEIPT_ID + '-real', completedAtIso: '2026-10-28T00:00:00.000Z' }),
      makeReceipt({ id: RECEIPT_ID + '-garbage-2', completedAtIso: 'later?' }),
    ]));

    expect(receiptIdOf(result)).toBe(RECEIPT_ID + '-real');
  });

  it('lets the later listed receipt win on an equal instant', async () => {
    const { result } = await latestOf(withReceipts([
      makeReceipt({ id: RECEIPT_ID + '-first' }),
      makeReceipt({ id: RECEIPT_ID + '-second' }),
    ]));

    expect(receiptIdOf(result)).toBe(RECEIPT_ID + '-second');
  });

  it.each([
    ['the receipts answer another head', [makeReceipt({ candidateHeadSha: OTHER_HEAD })], {}],
    ['only a kind-less receipt exists (never read as code-review)', [makeReceipt({ kind: undefined })], {}],
    ['only another kind exists', [makeReceipt({ kind: 'brief-check' })], {}],
  ] as const)('is not-found when %s', async (_label, reviewReceipts, overrides) => {
    const { result } = await latestOf(withReceipts([...reviewReceipts]), overrides);

    expect(result).toEqual({ outcome: 'not-found' });
  });

  it('finds a pre-merge receipt without requestId and reports requestId null', async () => {
    const { result } = await latestOf(
      withReceipts([makeReceipt({ kind: 'pre-merge', requestId: undefined, result: 'pass' })]),
      { kind: 'pre-merge' },
    );

    expect(result).toEqual({
      outcome: 'found',
      receipt: { ...EXPECTED_SUMMARY, kind: 'pre-merge', requestId: null },
    });
  });

  it.each([
    ["the found assessment belongs to another attempt", { outcome: 'found', assessment: makeAssessment({ attemptId: 'attempt-example-2' }) }],
    ['the assessment is absent', { outcome: 'not-found', query: ASSESSMENT_ID }],
  ] as const)('is not-found when %s', async (_label, inspected) => {
    const { result } = await latestOf(inspected as InspectAcceptanceEvidenceResult);

    expect(result).toEqual({ outcome: 'not-found' });
  });

  it('is unavailable unreadable when the inspection delegate throws', async () => {
    const inspectAcceptanceEvidence = async (): Promise<InspectAcceptanceEvidenceResult> => {
      throw new Error('inspection exploded');
    };
    const adapter = new ReviewRequestAdapter({ inspectAcceptanceEvidence });

    const result = await adapter.findLatestReceiptOfKind(makeFindRequest());

    expect(result).toEqual({ outcome: 'unavailable', reason: 'unreadable' });
  });

  it('is unavailable not-configured when no inspection delegate is bound', async () => {
    const adapter = new ReviewRequestAdapter();

    const result = await adapter.findLatestReceiptOfKind(makeFindRequest());

    expect(result).toEqual({ outcome: 'unavailable', reason: 'not-configured' });
  });

  it.each([
    ['a bad head', { candidateHeadSha: 'not-a-sha' }],
    ['an unknown kind', { kind: 'unknown-kind' }],
  ] as const)('is unavailable invalid-request for %s without calling the delegate', async (_label, overrides) => {
    const { calls, result } = await latestOf(
      { outcome: 'found', assessment: makeAssessment() },
      overrides as Partial<FindLatestReceiptOfKindRequest>,
    );

    expect(result).toEqual({ outcome: 'unavailable', reason: 'invalid-request' });
    expect(calls).toHaveLength(0);
  });
});

describe('CiStateAdapter.readHeadCiState', () => {
  it.each([
    ['pending', 'read'],
    ['passed', 'read'],
    ['failed', 'read'],
    ['unknown', 'not-configured'],
  ] as const)('passes %s through with its reason', async (state, reason) => {
    const { calls, inspectHeadCiState } = makeHeadCiFake({
      candidateHeadSha: HEAD,
      state,
      reason,
    });
    const adapter = new CiStateAdapter({ inspectHeadCiState });

    const result = await adapter.readHeadCiState({ headSha: HEAD });

    expect(result).toEqual({ headSha: HEAD, state, reason });
    expect(calls).toEqual([{ candidateHeadSha: HEAD }]);
  });

  it('passes unknown / head-moved through as head-moved', async () => {
    const { inspectHeadCiState } = makeHeadCiFake({
      candidateHeadSha: HEAD,
      state: 'unknown',
      reason: 'head-moved',
    });
    const adapter = new CiStateAdapter({ inspectHeadCiState });

    const result = await adapter.readHeadCiState({ headSha: HEAD });

    expect(result).toEqual({ headSha: HEAD, state: 'unknown', reason: 'head-moved' });
  });

  it('answers unknown/invalid-head for an invalid head without calling the delegate', async () => {
    const { calls, inspectHeadCiState } = makeHeadCiFake({
      candidateHeadSha: HEAD,
      state: 'passed',
      reason: 'read',
    });
    const adapter = new CiStateAdapter({ inspectHeadCiState });

    const result = await adapter.readHeadCiState({ headSha: 'nope' });

    expect(result).toEqual({ headSha: 'nope', state: 'unknown', reason: 'invalid-head' });
    expect(calls).toHaveLength(0);
  });

  it('answers unknown/not-configured when no delegate is bound', async () => {
    const adapter = new CiStateAdapter();

    const result = await adapter.readHeadCiState({ headSha: HEAD });

    expect(result).toEqual({ headSha: HEAD, state: 'unknown', reason: 'not-configured' });
  });

  it('answers unknown/unreadable when the delegate throws', async () => {
    const inspectHeadCiState = async (): Promise<InspectHeadCiStateResult> => {
      throw new Error('forge exploded');
    };
    const adapter = new CiStateAdapter({ inspectHeadCiState });

    const result = await adapter.readHeadCiState({ headSha: HEAD });

    expect(result).toEqual({ headSha: HEAD, state: 'unknown', reason: 'unreadable' });
  });

  it('answers unknown/unreadable when the answer names another head', async () => {
    const { inspectHeadCiState } = makeHeadCiFake({
      candidateHeadSha: OTHER_HEAD,
      state: 'passed',
      reason: 'read',
    });
    const adapter = new CiStateAdapter({ inspectHeadCiState });

    const result = await adapter.readHeadCiState({ headSha: HEAD });

    expect(result).toEqual({ headSha: HEAD, state: 'unknown', reason: 'unreadable' });
  });

  it.each([
    ['passed with head-moved', 'passed', 'head-moved'],
    ['failed with not-configured', 'failed', 'not-configured'],
    ['pending with unreadable', 'pending', 'unreadable'],
    ['an unknown state', 'green', 'read'],
    ['an unknown reason', 'unknown', 'because'],
  ])('answers unknown/unreadable for %s', async (_label, state, reason) => {
    const { inspectHeadCiState } = makeHeadCiFake({
      candidateHeadSha: HEAD,
      state,
      reason,
    } as unknown as InspectHeadCiStateResult);
    const adapter = new CiStateAdapter({ inspectHeadCiState });

    const result = await adapter.readHeadCiState({ headSha: HEAD });

    expect(result).toEqual({ headSha: HEAD, state: 'unknown', reason: 'unreadable' });
  });

  it('answers unknown/unreadable when read reports unknown', async () => {
    const { inspectHeadCiState } = makeHeadCiFake({
      candidateHeadSha: HEAD,
      state: 'unknown',
      reason: 'read',
    });
    const adapter = new CiStateAdapter({ inspectHeadCiState });

    const result = await adapter.readHeadCiState({ headSha: HEAD });

    expect(result).toEqual({ headSha: HEAD, state: 'unknown', reason: 'unreadable' });
  });
});
