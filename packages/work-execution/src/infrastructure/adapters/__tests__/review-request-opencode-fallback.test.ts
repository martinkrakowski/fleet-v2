// ReviewRequestAdapter: the D1C opencode fallback. When a review request is
// rejected as `review-unavailable` with an API-transport code (`transport`,
// `transport-failed`, `seat-busy`, `timeout`), the adapter re-requests the same
// review once against the configured opencode fallback reviewer seat. Every
// refusal path here is covered for both attempt reviews and chain reviews.
/**
 * Covers: no fallback on a completed verdict, non-API-transport refusals
 * surfaced unchanged, the absent/blank/equal fallback seat, the single-retry
 * bound, null/malformed/throwing delegate answers, delegate throws,
 * not-configured, fallback receipt mismatches, swallowed archive failures and
 * the successful fallback on each API-transport code. All fakes are object
 * literals; nothing touches a host.
 */

import { describe, expect, it } from 'vitest';

import { attemptIdForChain } from '@fleet/evidence-and-acceptance';
import type {
  RequestIndependentReviewRequest,
  RequestIndependentReviewResult,
  ReviewReceiptRecord,
} from '@fleet/evidence-and-acceptance';
import type { ReviewRequest } from '../../../application/ports/out/ReviewRequestPort.out-port.js';
import { ReviewRequestAdapter } from '../ReviewRequestAdapter.adapter.js';

const HEAD = '0000000000000000000000000000000000000000';
const CHAIN_HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PROJECT_ID = 'project-example-1';
const CHAIN_NAME = 'main';
const CHAIN_ATTEMPT_ID = attemptIdForChain(PROJECT_ID, CHAIN_NAME);
const REQUEST_ID = 'review-01JB00000000000000000000NN';
const KIND = 'code-review';
const PRIMARY_MODEL = 'example-provider/grok-4.7';
const FALLBACK_MODEL = 'example-provider/glm-5.3';
const RECEIPT_ID = 'rr-assessment-attempt-example-1-00000000-review-01JB00000000000000000000NN';

function makeReceipt(overrides: Partial<ReviewReceiptRecord> = {}): ReviewReceiptRecord {
  return {
    id: RECEIPT_ID,
    assessmentId: 'assessment-attempt-example-1',
    projectId: PROJECT_ID,
    attemptId: 'attempt-example-1',
    candidateHeadSha: HEAD,
    reviewerModel: FALLBACK_MODEL,
    implementerModel: 'example-provider/impl-1',
    readOnlyVerified: true,
    result: 'pass',
    findings: [
      {
        findingId: 'finding-example-1',
        severity: 'nit',
        summary: 'an example finding',
        filePath: null,
        line: null,
        state: 'unresolved',
        dispositionReason: 'no action',
        dispositionEvidenceRef: 'evidence://example/finding-1',
      },
    ],
    evidenceRef: 'evidence://example/review',
    policyRevision: 'policy-example-1',
    completedAtIso: '2026-11-14T00:00:00.000Z',
    kind: KIND,
    requestId: REQUEST_ID,
    ...overrides,
  };
}

function makeChainReceipt(overrides: Partial<ReviewReceiptRecord> = {}): ReviewReceiptRecord {
  return makeReceipt({
    id: 'rr-chain-' + REQUEST_ID,
    attemptId: CHAIN_ATTEMPT_ID,
    candidateHeadSha: CHAIN_HEAD,
    kind: 'pre-merge',
    subject: {
      kind: 'chain',
      projectId: PROJECT_ID,
      attemptId: null,
      chainName: CHAIN_NAME,
      integrationHeadSha: CHAIN_HEAD,
      briefPackageDigest: null,
      baseCommit: null,
    },
    ...overrides,
  });
}

function makeReviewRequest(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    requestId: REQUEST_ID,
    kind: KIND,
    attemptId: 'attempt-example-1',
    projectId: PROJECT_ID,
    candidateHeadSha: HEAD,
    policyRevision: 'policy-example-1',
    implementerModel: 'example-provider/impl-1',
    reviewerModel: PRIMARY_MODEL,
    ...overrides,
  };
}

function makeChainRequest(): ReviewRequest {
  return makeReviewRequest({
    attemptId: CHAIN_ATTEMPT_ID,
    candidateHeadSha: CHAIN_HEAD,
    kind: 'pre-merge',
    reviewerModel: PRIMARY_MODEL,
    subject: {
      kind: 'chain',
      projectId: PROJECT_ID,
      chainName: CHAIN_NAME,
      integrationHeadSha: CHAIN_HEAD,
    },
  });
}

interface ScriptedAnswer {
  readonly result?: RequestIndependentReviewResult;
  readonly throws?: boolean;
}

/**
 * A delegate that returns each scripted answer in order (or throws when the
 * answer carries `throws`), recording every request it received.
 */
function makeScriptedDelegate(script: readonly ScriptedAnswer[]) {
  const calls: RequestIndependentReviewRequest[] = [];
  const requestIndependentReview = async (request: RequestIndependentReviewRequest) => {
    calls.push(request);
    const answer = script[calls.length - 1];
    if (answer === undefined) {
      throw new Error('script exhausted — the adapter retried more times than allowed');
    }
    if (answer.throws === true) {
      throw new Error('delegate exploded');
    }
    return answer.result as RequestIndependentReviewResult;
  };
  return { calls, requestIndependentReview };
}

function unavailable(
  code: string,
  diagnostic?: { readonly exitCode: number; readonly timedOut: boolean; readonly stderr: string | null; readonly stdoutEmpty: boolean },
): RequestIndependentReviewResult {
  return {
    outcome: 'rejected',
    reason: 'the transport failed',
    rejection: 'review-unavailable',
    code: code as never,
    ...(diagnostic !== undefined ? { diagnostic } : {}),
  } as RequestIndependentReviewResult;
}

const BAD_FALLBACK_MODELS: readonly unknown[] = [undefined, '', '   ', 42, null];

describe('ReviewRequestAdapter opencode fallback', () => {
  it('does not invoke fallback when primary review returns a completed pass or fail verdict', async () => {
    for (const resultValue of ['pass', 'fail'] as const) {
      for (const [request, receipt] of [
        [makeReviewRequest(), makeReceipt({ result: resultValue })],
        [makeChainRequest(), makeChainReceipt({ result: resultValue })],
      ] as const) {
        const { calls, requestIndependentReview } = makeScriptedDelegate([
          { result: { outcome: 'reviewed', receipt } },
        ]);
        const adapter = new ReviewRequestAdapter({ requestIndependentReview, opencodeFallbackReviewerModel: FALLBACK_MODEL });

        const result = await adapter.requestReview(request);

        expect(result.outcome).toBe('receipt');
        if (result.outcome === 'receipt') {
          expect(result.receipt.verdict).toBe(resultValue === 'pass' ? 'passed' : 'failed');
          expect(result.receipt.reviewerModel).toBe(FALLBACK_MODEL);
        }
        expect(calls).toHaveLength(1);
      }
    }
  });

  it('surfaces non-api-transport unavailable and config refusals without fallback', async () => {
    for (const [rejection, code] of [
      ['review-unavailable', 'transport-missing'],
      ['review-unavailable', 'seat-none'],
      ['review-unavailable', 'same-family'],
      ['review-unavailable', 'route-no-port'],
      ['seat-refused', undefined],
    ] as const) {
      for (const [request, receiptOf] of [
        [makeReviewRequest(), makeReceipt],
        [makeChainRequest(), makeChainReceipt],
      ] as const) {
        void receiptOf;
        const { calls, requestIndependentReview } = makeScriptedDelegate([
          {
            result: {
              outcome: 'rejected',
              reason: 'free text never reaches the caller',
              ...(rejection !== undefined ? { rejection } : {}),
              ...(code !== undefined ? { code: code as never } : {}),
            } as RequestIndependentReviewResult,
          },
        ]);
        const adapter = new ReviewRequestAdapter({ requestIndependentReview, opencodeFallbackReviewerModel: FALLBACK_MODEL });

        const result = await adapter.requestReview(request);

        expect(calls).toHaveLength(1);
        if (rejection === 'review-unavailable') {
          expect(result).toEqual({ outcome: 'no-receipt', reason: 'review-unavailable', detail: code });
        } else {
          expect(result).toEqual({ outcome: 'refused', reason: 'seat-refused', detail: null });
        }
      }
    }
  });

  it('returns unavailable without crashing when no opencode fallback seat is configured', async () => {
    for (const fallbackModel of BAD_FALLBACK_MODELS) {
      for (const [request, code] of [
        [makeReviewRequest(), 'transport'],
        [makeChainRequest(), 'seat-busy'],
      ] as const) {
        const { calls, requestIndependentReview } = makeScriptedDelegate([{ result: unavailable(code) }]);
        const delegates: Record<string, unknown> = { requestIndependentReview };
        if (fallbackModel !== undefined) {
          delegates.opencodeFallbackReviewerModel = fallbackModel;
        }
        const adapter = new ReviewRequestAdapter(delegates as never);

        const result = await adapter.requestReview(request);

        expect(result).toEqual({ outcome: 'no-receipt', reason: 'review-unavailable', detail: code });
        expect(calls).toHaveLength(1);
      }
    }
    // A fallback seat equal to the primary reviewer model is no fallback either.
    for (const request of [makeReviewRequest(), makeChainRequest()]) {
      const { calls, requestIndependentReview } = makeScriptedDelegate([{ result: unavailable('timeout') }]);
      const adapter = new ReviewRequestAdapter({
        requestIndependentReview,
        opencodeFallbackReviewerModel: request.reviewerModel,
      });

      const result = await adapter.requestReview(request);

      expect(result).toEqual({ outcome: 'no-receipt', reason: 'review-unavailable', detail: 'timeout' });
      expect(calls).toHaveLength(1);
      expect(calls[0].reviewerModel).toBe(request.reviewerModel);
    }
  });

  it('bounds opencode fallback to a single retry and never loops', async () => {
    for (const request of [makeReviewRequest(), makeChainRequest()]) {
      const { calls, requestIndependentReview } = makeScriptedDelegate([
        { result: unavailable('transport') },
        { result: unavailable('transport-failed') },
        { result: unavailable('timeout') },
      ]);
      const adapter = new ReviewRequestAdapter({ requestIndependentReview, opencodeFallbackReviewerModel: FALLBACK_MODEL });

      const result = await adapter.requestReview(request);

      expect(result).toEqual({ outcome: 'no-receipt', reason: 'review-unavailable', detail: 'transport-failed' });
      expect(calls).toHaveLength(2);
      expect(calls[1].reviewerModel).toBe(FALLBACK_MODEL);
    }
  });

  it('treats null, malformed, or throwing-getter review results as unavailable', async () => {
    const malformed: readonly unknown[] = [
      null,
      undefined,
      'reviewed',
      7,
      [],
      Object.create(null),
      {},
      { outcome: 'reviewed-but-typo' },
      { outcome: 'reviewed', receipt: null },
      { outcome: 'reviewed', receipt: 'not-an-object' },
      { outcome: 'reviewed', get receipt(): never { throw new Error('boom'); } },
      { get outcome(): never { throw new Error('boom'); } },
    ];
    for (const answer of malformed) {
      for (const request of [makeReviewRequest(), makeChainRequest()]) {
        const { calls, requestIndependentReview } = makeScriptedDelegate([
          { result: answer as RequestIndependentReviewResult },
        ]);
        const adapter = new ReviewRequestAdapter({ requestIndependentReview, opencodeFallbackReviewerModel: FALLBACK_MODEL });

        const result = await adapter.requestReview(request);

        expect(result).toEqual({ outcome: 'no-receipt', reason: 'review-unavailable', detail: null });
        expect(calls).toHaveLength(1);
      }
    }
  });

  it('returns unknown delegate-failed when primary or fallback delegate throws', async () => {
    for (const request of [makeReviewRequest(), makeChainRequest()]) {
      const primary = makeScriptedDelegate([{ throws: true }]);
      const adapter = new ReviewRequestAdapter({
        requestIndependentReview: primary.requestIndependentReview,
        opencodeFallbackReviewerModel: FALLBACK_MODEL,
      });
      await expect(adapter.requestReview(request)).resolves.toEqual({ outcome: 'unknown', reason: 'delegate-failed' });
      expect(primary.calls).toHaveLength(1);

      const fallback = makeScriptedDelegate([{ result: unavailable('transport') }, { throws: true }]);
      const withFallback = new ReviewRequestAdapter({
        requestIndependentReview: fallback.requestIndependentReview,
        opencodeFallbackReviewerModel: FALLBACK_MODEL,
      });
      await expect(withFallback.requestReview(request)).resolves.toEqual({ outcome: 'unknown', reason: 'delegate-failed' });
      expect(fallback.calls).toHaveLength(2);
    }
  });

  it('returns refused not-configured when requestIndependentReview delegate is absent', async () => {
    for (const request of [makeReviewRequest(), makeChainRequest()]) {
      const adapter = new ReviewRequestAdapter({ opencodeFallbackReviewerModel: FALLBACK_MODEL });
      await expect(adapter.requestReview(request)).resolves.toEqual({
        outcome: 'refused',
        reason: 'not-configured',
        detail: null,
      });
    }
  });

  it('returns unknown receipt-mismatch when fallback returns a mismatched or corrupt receipt', async () => {
    const mismatchedChain: readonly ReviewReceiptRecord[] = [
      makeChainReceipt({ requestId: 'review-01JB00000000000000000000XX' }),
      makeChainReceipt({ kind: KIND }),
      makeChainReceipt({ candidateHeadSha: HEAD }),
      makeChainReceipt({
        findings: [
          {
            findingId: 'finding-example-1',
            severity: 'catastrophic' as never,
            summary: 'a corrupt severity',
            filePath: null,
            line: null,
            state: 'unresolved',
            dispositionReason: 'no action',
            dispositionEvidenceRef: 'evidence://example/finding-1',
          } as never,
        ],
      }),
      makeChainReceipt({ findings: new Array(2) as never }),
    ];
    const mismatchedAttempt: readonly ReviewReceiptRecord[] = [
      makeReceipt({ requestId: 'review-01JB00000000000000000000XX' }),
      makeReceipt({ kind: 'pre-merge' }),
      makeReceipt({ attemptId: 'attempt-other-1' }),
      makeReceipt({ candidateHeadSha: CHAIN_HEAD }),
      makeReceipt({
        findings: [
          {
            findingId: 'finding-example-1',
            severity: 'catastrophic' as never,
            summary: 'a corrupt severity',
            filePath: null,
            line: null,
            state: 'unresolved',
            dispositionReason: 'no action',
            dispositionEvidenceRef: 'evidence://example/finding-1',
          } as never,
        ],
      }),
    ];
    for (const [request, answers] of [
      [makeReviewRequest(), mismatchedAttempt],
      [makeChainRequest(), mismatchedChain],
    ] as const) {
      for (const receipt of answers) {
        const { calls, requestIndependentReview } = makeScriptedDelegate([
          { result: unavailable('transport-failed') },
          { result: { outcome: 'reviewed', receipt } },
        ]);
        const adapter = new ReviewRequestAdapter({ requestIndependentReview, opencodeFallbackReviewerModel: FALLBACK_MODEL });

        const result = await adapter.requestReview(request);

        expect(result).toEqual({ outcome: 'unknown', reason: 'receipt-mismatch' });
        expect(calls).toHaveLength(2);
        expect(calls[1].reviewerModel).toBe(FALLBACK_MODEL);
      }
    }
  });

  it('swallows archiveEvidence errors and preserves the fallback review outcome', async () => {
    const diagnostic = { exitCode: 75, timedOut: false, stderr: null, stdoutEmpty: false };
    for (const request of [makeReviewRequest(), makeChainRequest()]) {
      const receipt = request.kind === 'pre-merge' && request.attemptId === CHAIN_ATTEMPT_ID ? makeChainReceipt() : makeReceipt();
      const boom = async (): Promise<never> => {
        throw new Error('archive exploded');
      };
      const { calls, requestIndependentReview } = makeScriptedDelegate([
        { result: unavailable('seat-busy', diagnostic) },
        { result: { outcome: 'reviewed', receipt } },
      ]);
      const adapter = new ReviewRequestAdapter({
        requestIndependentReview,
        archiveEvidence: boom,
        opencodeFallbackReviewerModel: FALLBACK_MODEL,
      });

      const result = await adapter.requestReview(request);

      expect(result.outcome).toBe('receipt');
      expect(calls).toHaveLength(2);

      // An archive failure on the primary (no fallback seat) keeps the mapped outcome too.
      const primary = makeScriptedDelegate([{ result: unavailable('timeout', diagnostic) }]);
      const primaryOnly = new ReviewRequestAdapter({ requestIndependentReview: primary.requestIndependentReview, archiveEvidence: boom });
      await expect(primaryOnly.requestReview(request)).resolves.toEqual({
        outcome: 'no-receipt',
        reason: 'review-unavailable',
        detail: 'timeout',
      });
      expect(primary.calls).toHaveLength(1);
    }
  });

  it('retries once against opencodeFallbackReviewerModel on each api-transport unavailable code for attempt and chain reviews', async () => {
    for (const code of ['transport', 'transport-failed', 'seat-busy', 'timeout'] as const) {
      for (const [request, receipt] of [
        [makeReviewRequest(), makeReceipt()],
        [makeChainRequest(), makeChainReceipt()],
      ] as const) {
        const { calls, requestIndependentReview } = makeScriptedDelegate([
          { result: unavailable(code) },
          { result: { outcome: 'reviewed', receipt } },
        ]);
        const adapter = new ReviewRequestAdapter({ requestIndependentReview, opencodeFallbackReviewerModel: FALLBACK_MODEL });

        const result = await adapter.requestReview(request);

        expect(result.outcome).toBe('receipt');
        expect(calls).toHaveLength(2);
        expect(calls[1].reviewerModel).toBe(FALLBACK_MODEL);
        expect(calls[1].requestId).toBe(REQUEST_ID);
      }
    }
  });
});
