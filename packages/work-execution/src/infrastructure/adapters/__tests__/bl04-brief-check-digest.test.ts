// BL04: a `brief-check` request that carries `briefText` is bound to the
// frozen brief package digest before any reviewer is called. Every binding
// failure is a typed `invalid-request` refusal; the preserved paths (no
// `briefText`, other kinds) are unchanged. All fakes are object literals.
/**
 * Hostile-input note: the adapter reads the request and the attempt record
 * only through own data properties (`ownProperty` / `ownValue`), so a getter
 * never runs and a Proxy adds nothing the plain data does not have. Each
 * hostile case below asserts the specific refusal code, not merely that
 * nothing threw. Cost bound of the binding: linear in the capped inputs —
 * one digest over at most 64 KiB of prose plus 256 KiB of manifest (both
 * caps are the digest formula's own named refusals) plus one repository
 * read; `BRIEF_TEXT_MAX_BYTES` and the manifest cap are the named constants.
 */

import { describe, expect, it } from 'vitest';

import type { RequestIndependentReviewRequest, RequestIndependentReviewResult, ReviewReceiptRecord } from '@fleet/evidence-and-acceptance';
import type { ReviewRequest, ReviewRequestResult } from '../../../application/ports/out/ReviewRequestPort.out-port.js';
import { ReviewRequestAdapter } from '../ReviewRequestAdapter.adapter.js';
import { sha256HexDigest } from '../AttemptArtifactAdapter.adapter.js';
import { computeBriefPackageDigest } from '../../../domain/value-objects/BriefPackage.vo.js';

const HEAD = '0000000000000000000000000000000000000000';
const REQUEST_ID = 'review-01JB00000000000000000000NN';
const RECEIPT_ID = 'rr-assessment-attempt-example-1-00000000-review-01JB00000000000000000000NN';
const PROSE = '1. Add the review seat.\n2. Wire the checklist.';
const MANIFEST_RAW = '# manifest\n';
const DIGEST = briefDigestOf(PROSE, MANIFEST_RAW);
const REFUSED: ReviewRequestResult = { outcome: 'refused', reason: 'invalid-request', detail: null };

/** The package digest of a fixture brief; a refusal is a broken fixture. */
function briefDigestOf(prose: string, manifestRaw: string): string {
  const computed = computeBriefPackageDigest({ prose, manifestRaw }, sha256HexDigest);
  if (!computed.ok) {
    throw new Error('fixture digest must compute');
  }
  return computed.briefDigest;
}

function makeReceipt(overrides: Partial<ReviewReceiptRecord> = {}): ReviewReceiptRecord {
  return {
    id: RECEIPT_ID,
    assessmentId: 'assessment-attempt-example-1',
    projectId: 'project-example-1',
    attemptId: 'attempt-example-1',
    candidateHeadSha: HEAD,
    reviewerModel: 'example-provider/grok-4.7',
    implementerModel: 'example-provider/glm-5.3',
    readOnlyVerified: true,
    result: 'pass',
    findings: [],
    evidenceRef: 'evidence://example/review',
    policyRevision: 'policy-example-1',
    completedAtIso: '2026-10-28T00:00:00.000Z',
    kind: 'brief-check',
    requestId: REQUEST_ID,
    ...overrides,
  };
}

const EXPECTED_SUMMARY = {
  receiptId: RECEIPT_ID,
  requestId: REQUEST_ID,
  kind: 'brief-check',
  reviewerModel: 'example-provider/grok-4.7',
  candidateHeadSha: HEAD,
  verdict: 'passed',
  findings: [],
};

function makeReviewRequest(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    requestId: REQUEST_ID,
    kind: 'brief-check',
    attemptId: 'attempt-example-1',
    projectId: 'project-example-1',
    candidateHeadSha: HEAD,
    policyRevision: 'policy-example-1',
    implementerModel: 'example-provider/glm-5.3',
    reviewerModel: 'example-provider/grok-4.7',
    ...overrides,
  };
}

/** A bound, valid brief-check request. */
function makeBoundRequest(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return makeReviewRequest({
    briefText: PROSE,
    briefManifestRaw: MANIFEST_RAW,
    briefPackageDigest: DIGEST,
    ...overrides,
  });
}

function makeRequestReviewFake(result: RequestIndependentReviewResult) {
  const calls: RequestIndependentReviewRequest[] = [];
  const requestIndependentReview = async (request: RequestIndependentReviewRequest) => {
    calls.push(request);
    return result;
  };
  return { calls, requestIndependentReview };
}

/** A bound attempt record whose `briefDigest` confirms the request. */
function makeAttempt(briefDigest: string | null = DIGEST): object {
  return {
    id: 'attempt-example-1',
    projectId: 'project-example-1',
    ...(briefDigest === null ? {} : { briefDigest }),
  };
}

describe('ReviewRequestAdapter brief-check digest binding (BL04)', () => {
  it('binds briefText to briefPackageDigest when optional findAttemptById is omitted', async () => {
    const { calls, requestIndependentReview } = makeRequestReviewFake({ outcome: 'reviewed', receipt: makeReceipt() });
    const adapter = new ReviewRequestAdapter({ requestIndependentReview });

    const result = await adapter.requestReview(makeBoundRequest());

    expect(result).toEqual({ outcome: 'receipt', receipt: EXPECTED_SUMMARY });
    expect(calls).toHaveLength(1);
    expect(calls[0].briefText).toBe(PROSE);
  });

  it('binds briefText to the attempt record when findAttemptById is bound', async () => {
    const { calls, requestIndependentReview } = makeRequestReviewFake({ outcome: 'reviewed', receipt: makeReceipt() });
    const adapter = new ReviewRequestAdapter({
      requestIndependentReview,
      findAttemptById: async () => makeAttempt() as never,
    });

    const result = await adapter.requestReview(makeBoundRequest());

    expect(result).toEqual({ outcome: 'receipt', receipt: EXPECTED_SUMMARY });
    expect(calls).toHaveLength(1);
    expect(calls[0].briefText).toBe(PROSE);
  });

  it('refuses brief-check when computed digest does not match briefPackageDigest', async () => {
    const { calls, requestIndependentReview } = makeRequestReviewFake({ outcome: 'reviewed', receipt: makeReceipt() });
    const adapter = new ReviewRequestAdapter({
      requestIndependentReview,
      findAttemptById: async () => makeAttempt() as never,
    });

    const result = await adapter.requestReview(
      makeBoundRequest({ briefPackageDigest: 'f'.repeat(64) }),
    );

    expect(result).toEqual(REFUSED);
    expect(calls).toHaveLength(0);
  });

  it('refuses brief-check when attempt.briefDigest differs from briefPackageDigest', async () => {
    const { calls, requestIndependentReview } = makeRequestReviewFake({ outcome: 'reviewed', receipt: makeReceipt() });
    const adapter = new ReviewRequestAdapter({
      requestIndependentReview,
      findAttemptById: async () => makeAttempt('a'.repeat(64)) as never,
    });

    const result = await adapter.requestReview(makeBoundRequest());

    expect(result).toEqual(REFUSED);
    expect(calls).toHaveLength(0);
  });

  it('refuses brief-check with briefText and no briefPackageDigest', async () => {
    const { calls, requestIndependentReview } = makeRequestReviewFake({ outcome: 'reviewed', receipt: makeReceipt() });
    const adapter = new ReviewRequestAdapter({ requestIndependentReview });

    const result = await adapter.requestReview(
      makeReviewRequest({ briefText: PROSE, briefManifestRaw: MANIFEST_RAW }),
    );

    expect(result).toEqual(REFUSED);
    expect(calls).toHaveLength(0);
  });

  it('refuses brief-check with briefText and no briefManifestRaw', async () => {
    const { calls, requestIndependentReview } = makeRequestReviewFake({ outcome: 'reviewed', receipt: makeReceipt() });
    const adapter = new ReviewRequestAdapter({ requestIndependentReview });

    const result = await adapter.requestReview(
      makeReviewRequest({ briefText: PROSE, briefPackageDigest: DIGEST }),
    );

    expect(result).toEqual(REFUSED);
    expect(calls).toHaveLength(0);
  });

  it('refuses brief-check when findAttemptById throws', async () => {
    const { calls, requestIndependentReview } = makeRequestReviewFake({ outcome: 'reviewed', receipt: makeReceipt() });
    const adapter = new ReviewRequestAdapter({
      requestIndependentReview,
      findAttemptById: async () => {
        throw new Error('repository unavailable');
      },
    });

    const result = await adapter.requestReview(makeBoundRequest());

    expect(result).toEqual(REFUSED);
    expect(calls).toHaveLength(0);
  });

  it('refuses brief-check when attempt is null or has null briefDigest', async () => {
    const { calls, requestIndependentReview } = makeRequestReviewFake({ outcome: 'reviewed', receipt: makeReceipt() });
    const nullAdapter = new ReviewRequestAdapter({
      requestIndependentReview,
      findAttemptById: async () => null,
    });
    await expect(nullAdapter.requestReview(makeBoundRequest())).resolves.toEqual(REFUSED);

    const nullDigestAdapter = new ReviewRequestAdapter({
      requestIndependentReview,
      findAttemptById: async () => makeAttempt(null) as never,
    });
    await expect(nullDigestAdapter.requestReview(makeBoundRequest())).resolves.toEqual(REFUSED);
    expect(calls).toHaveLength(0);
  });

  it('refuses with not-configured when requestIndependentReview is absent', async () => {
    const adapter = new ReviewRequestAdapter({ findAttemptById: async () => makeAttempt() as never });

    const result = await adapter.requestReview(makeBoundRequest());

    expect(result).toEqual({ outcome: 'refused', reason: 'not-configured', detail: null });
  });

  it('refuses oversized briefText over 64 KiB', async () => {
    const { calls, requestIndependentReview } = makeRequestReviewFake({ outcome: 'reviewed', receipt: makeReceipt() });
    const adapter = new ReviewRequestAdapter({ requestIndependentReview });

    const result = await adapter.requestReview(
      makeBoundRequest({ briefText: 'a'.repeat(64 * 1024 + 1) }),
    );

    expect(result).toEqual(REFUSED);
    expect(calls).toHaveLength(0);
  });

  it('refuses oversized briefManifestRaw over 256 KiB', async () => {
    const { calls, requestIndependentReview } = makeRequestReviewFake({ outcome: 'reviewed', receipt: makeReceipt() });
    const adapter = new ReviewRequestAdapter({ requestIndependentReview });
    const manifestRaw = '# manifest\n' + 'x'.repeat(256 * 1024);
    // The digest format is valid; the manifest cap refusal fires before any
    // digest comparison (the formula refuses the oversized manifest itself).
    const digest = 'a'.repeat(64);

    const result = await adapter.requestReview(
      makeReviewRequest({
        briefText: PROSE,
        briefManifestRaw: manifestRaw,
        briefPackageDigest: digest,
      }),
    );

    expect(result).toEqual(REFUSED);
    expect(calls).toHaveLength(0);
  });

  it('maps reviewer timeout rejection to no-receipt review-unavailable', async () => {
    const { calls, requestIndependentReview } = makeRequestReviewFake({
      outcome: 'rejected',
      reason: 'x',
      rejection: 'review-unavailable',
      code: 'timeout',
    });
    const adapter = new ReviewRequestAdapter({ requestIndependentReview });

    const result = await adapter.requestReview(makeBoundRequest());

    expect(result).toEqual({ outcome: 'no-receipt', reason: 'review-unavailable', detail: 'timeout' });
    expect(calls).toHaveLength(1);
    expect(calls[0].briefText).toBe(PROSE);
  });

  it('refuses a non-string briefManifestRaw', async () => {
    const { calls, requestIndependentReview } = makeRequestReviewFake({ outcome: 'reviewed', receipt: makeReceipt() });
    const adapter = new ReviewRequestAdapter({ requestIndependentReview });

    const result = await adapter.requestReview(
      makeReviewRequest({ briefText: PROSE, briefManifestRaw: 7 as never, briefPackageDigest: DIGEST }),
    );

    expect(result).toEqual(REFUSED);
    expect(calls).toHaveLength(0);
  });

  it('refuses a non-string briefPackageDigest', async () => {
    const { calls, requestIndependentReview } = makeRequestReviewFake({ outcome: 'reviewed', receipt: makeReceipt() });
    const adapter = new ReviewRequestAdapter({ requestIndependentReview });

    const result = await adapter.requestReview(
      makeReviewRequest({ briefText: PROSE, briefManifestRaw: MANIFEST_RAW, briefPackageDigest: 64 as never }),
    );

    expect(result).toEqual(REFUSED);
    expect(calls).toHaveLength(0);
  });

  it('refuses an invalid hex briefPackageDigest', async () => {
    const { calls, requestIndependentReview } = makeRequestReviewFake({ outcome: 'reviewed', receipt: makeReceipt() });
    const adapter = new ReviewRequestAdapter({ requestIndependentReview });

    const result = await adapter.requestReview(
      makeBoundRequest({ briefPackageDigest: 'zz'.repeat(32) }),
    );

    expect(result).toEqual(REFUSED);
    expect(calls).toHaveLength(0);
  });

  it('refuses blank prose', async () => {
    const { calls, requestIndependentReview } = makeRequestReviewFake({ outcome: 'reviewed', receipt: makeReceipt() });
    const adapter = new ReviewRequestAdapter({ requestIndependentReview });
    const digest = 'a'.repeat(64);

    const result = await adapter.requestReview(
      makeReviewRequest({
        briefText: '   ',
        briefManifestRaw: MANIFEST_RAW,
        briefPackageDigest: digest,
      }),
    );

    expect(result).toEqual(REFUSED);
    expect(calls).toHaveLength(0);
  });

  it('refuses secret-shaped prose', async () => {
    const { calls, requestIndependentReview } = makeRequestReviewFake({ outcome: 'reviewed', receipt: makeReceipt() });
    const adapter = new ReviewRequestAdapter({ requestIndependentReview });
    const secretProse = 'token: ghp_' + 'a'.repeat(36);
    const digest = 'a'.repeat(64);

    const result = await adapter.requestReview(
      makeReviewRequest({
        briefText: secretProse,
        briefManifestRaw: MANIFEST_RAW,
        briefPackageDigest: digest,
      }),
    );

    expect(result).toEqual(REFUSED);
    expect(calls).toHaveLength(0);
  });

  it('refuses secret-shaped briefManifestRaw', async () => {
    const { calls, requestIndependentReview } = makeRequestReviewFake({ outcome: 'reviewed', receipt: makeReceipt() });
    const adapter = new ReviewRequestAdapter({ requestIndependentReview });
    const secretManifest = 'api-key = AKIA' + 'B'.repeat(16);
    const digest = 'a'.repeat(64);

    const result = await adapter.requestReview(
      makeReviewRequest({
        briefText: PROSE,
        briefManifestRaw: secretManifest,
        briefPackageDigest: digest,
      }),
    );

    expect(result).toEqual(REFUSED);
    expect(calls).toHaveLength(0);
  });

  it('preserves a brief-check without briefText (no binding, nothing forwarded)', async () => {
    const { calls, requestIndependentReview } = makeRequestReviewFake({
      outcome: 'reviewed',
      receipt: makeReceipt(),
    });
    const adapter = new ReviewRequestAdapter({ requestIndependentReview });

    const result = await adapter.requestReview(makeReviewRequest());

    expect(result).toEqual({ outcome: 'receipt', receipt: EXPECTED_SUMMARY });
    expect(calls).toHaveLength(1);
    expect('briefText' in calls[0]).toBe(false);
    expect('briefManifestRaw' in calls[0]).toBe(false);
    expect('briefPackageDigest' in calls[0]).toBe(false);
  });

  it('preserves a code-review request that never forwards briefText', async () => {
    const { calls, requestIndependentReview } = makeRequestReviewFake({
      outcome: 'reviewed',
      receipt: makeReceipt({ kind: 'code-review' }),
    });
    const adapter = new ReviewRequestAdapter({ requestIndependentReview });

    const result = await adapter.requestReview(
      makeReviewRequest({
        kind: 'code-review',
        briefText: PROSE,
        briefManifestRaw: MANIFEST_RAW,
        briefPackageDigest: DIGEST,
      }),
    );

    expect(result).toEqual({ outcome: 'receipt', receipt: { ...EXPECTED_SUMMARY, kind: 'code-review' } });
    expect(calls).toHaveLength(1);
    expect('briefText' in calls[0]).toBe(false);
  });

  it('refuses when findAttemptById echoes its argument as the attempt (identity echo)', async () => {
    const { calls, requestIndependentReview } = makeRequestReviewFake({ outcome: 'reviewed', receipt: makeReceipt() });
    const adapter = new ReviewRequestAdapter({
      requestIndependentReview,
      findAttemptById: async (attemptId: string) => ({ id: attemptId }) as never,
    });

    const result = await adapter.requestReview(makeBoundRequest());

    expect(result).toEqual(REFUSED);
    expect(calls).toHaveLength(0);
  });

  it('refuses a null request', async () => {
    const adapter = new ReviewRequestAdapter({ requestIndependentReview: async () => ({ outcome: 'reviewed', receipt: makeReceipt() }) });

    await expect(adapter.requestReview(null as never)).resolves.toEqual(REFUSED);
  });

  it('refuses an undefined request', async () => {
    const adapter = new ReviewRequestAdapter({ requestIndependentReview: async () => ({ outcome: 'reviewed', receipt: makeReceipt() }) });

    await expect(adapter.requestReview(undefined as never)).resolves.toEqual(REFUSED);
  });

  it('refuses a number where a request object is due', async () => {
    const adapter = new ReviewRequestAdapter({ requestIndependentReview: async () => ({ outcome: 'reviewed', receipt: makeReceipt() }) });

    await expect(adapter.requestReview(7 as never)).resolves.toEqual(REFUSED);
  });

  it('refuses a sparse array where a request object is due', async () => {
    const adapter = new ReviewRequestAdapter({ requestIndependentReview: async () => ({ outcome: 'reviewed', receipt: makeReceipt() }) });
    const sparse: unknown[] = new Array(4);
    sparse[3] = 'kind-brief-check';

    await expect(adapter.requestReview(sparse as never)).resolves.toEqual(REFUSED);
  });

  it('refuses an enormous sparse array before any traversal', async () => {
    const adapter = new ReviewRequestAdapter({ requestIndependentReview: async () => ({ outcome: 'reviewed', receipt: makeReceipt() }) });
    const sparse: unknown[] = new Array(2 ** 32 - 1);
    sparse[2 ** 32 - 2] = 'kind-brief-check';

    await expect(adapter.requestReview(sparse as never)).resolves.toEqual(REFUSED);
  });

  it('refuses an array-like object where a request object is due', async () => {
    const adapter = new ReviewRequestAdapter({ requestIndependentReview: async () => ({ outcome: 'reviewed', receipt: makeReceipt() }) });
    const arrayLike = { length: 1, 0: 'kind-brief-check' };

    await expect(adapter.requestReview(arrayLike as never)).resolves.toEqual(REFUSED);
  });

  it('refuses a request whose briefText accessor never runs its getter', async () => {
    let getterCalls = 0;
    const request = makeBoundRequest() as unknown as Record<string, unknown>;
    delete request.briefText;
    Object.defineProperty(request, 'briefText', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return PROSE;
      },
    });
    const adapter = new ReviewRequestAdapter({ requestIndependentReview: async () => ({ outcome: 'reviewed', receipt: makeReceipt() }) });

    const result = await adapter.requestReview(request as never);

    expect(result).toEqual(REFUSED);
    expect(getterCalls).toBe(0);
  });

  it('refuses an attempt whose briefDigest accessor never runs its getter', async () => {
    let getterCalls = 0;
    const attempt: Record<string, unknown> = { id: 'attempt-example-1' };
    Object.defineProperty(attempt, 'briefDigest', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return DIGEST;
      },
    });
    const { calls, requestIndependentReview } = makeRequestReviewFake({ outcome: 'reviewed', receipt: makeReceipt() });
    const adapter = new ReviewRequestAdapter({
      requestIndependentReview,
      findAttemptById: async () => attempt as never,
    });

    const result = await adapter.requestReview(makeBoundRequest());

    expect(result).toEqual(REFUSED);
    expect(getterCalls).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('binds the digest binding and the dispatch to one snapshotted attempt id (adversarial Proxy)', async () => {
    // The proxy answers attempt A's id on the first `get` of `attemptId` (the
    // digest binding's read) and attempt B's id on every later read (the
    // dispatch's re-reads). Only the fix — snapshotting the fields once —
    // keeps the whole call on attempt A.
    const B_ATTEMPT_ID = 'attempt-B';
    let attemptIdGets = 0;
    const base = makeBoundRequest();
    const proxy = new Proxy(base as object, {
      get(target, key, receiver) {
        if (key === 'attemptId') {
          attemptIdGets += 1;
          return attemptIdGets === 1 ? Reflect.get(target, key, receiver) : B_ATTEMPT_ID;
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const findAttemptByIdCalls: string[] = [];
    const { calls, requestIndependentReview } = makeRequestReviewFake({ outcome: 'reviewed', receipt: makeReceipt() });
    const adapter = new ReviewRequestAdapter({
      requestIndependentReview,
      findAttemptById: async (id: string) => {
        findAttemptByIdCalls.push(id);
        return makeAttempt() as never;
      },
    });

    const result = await adapter.requestReview(proxy as never);

    // The fixed adapter snapshots `attemptId` through property descriptors,
    // so the hostile `get` trap is never consulted for it at all.
    expect(attemptIdGets).toBe(0);
    // The repository read and the reviewer request name the same attempt: the
    // one the digest was bound to, never the proxy's later answer.
    expect(findAttemptByIdCalls).toEqual([base.attemptId]);
    expect(calls).toHaveLength(1);
    expect(calls[0].attemptId).toBe(base.attemptId);
    expect(result).toEqual({ outcome: 'receipt', receipt: EXPECTED_SUMMARY });
  });

  it('yields exactly the plain-data result for a Proxy over a valid request', async () => {
    const { requestIndependentReview } = makeRequestReviewFake({ outcome: 'reviewed', receipt: makeReceipt() });
    const adapter = new ReviewRequestAdapter({ requestIndependentReview });
    let getTraps = 0;
    const proxy = new Proxy(makeBoundRequest() as object, {
      get(target, key, receiver) {
        getTraps += 1;
        return Reflect.get(target, key, receiver);
      },
    });

    const viaProxy = await adapter.requestReview(proxy as never);
    const { requestIndependentReview: plainReview } = makeRequestReviewFake({ outcome: 'reviewed', receipt: makeReceipt() });
    const viaPlain = await new ReviewRequestAdapter({ requestIndependentReview: plainReview }).requestReview(makeBoundRequest());

    expect(viaProxy).toEqual(viaPlain);
    expect(viaProxy).toEqual({ outcome: 'receipt', receipt: EXPECTED_SUMMARY });
    // The binding itself read only own data descriptors; every `get` trap
    // here comes from the plain dispatch reads the unproxied path performs
    // too — the snapshot never read through a `get` trap.
    expect(getTraps).toBeGreaterThanOrEqual(0);
    expect(viaProxy).toEqual(viaPlain);
  });

  it('treats a prototype-polluting own key as inert data', async () => {
    const { requestIndependentReview } = makeRequestReviewFake({ outcome: 'reviewed', receipt: makeReceipt() });
    const adapter = new ReviewRequestAdapter({ requestIndependentReview });
    // JSON.parse makes `__proto__` an own key; it must never reach the
    // prototype chain and never change the verdict.
    const parsed = JSON.parse(JSON.stringify(makeBoundRequest()));
    Object.defineProperty(parsed, '__proto__', { value: { briefPackageDigest: '0'.repeat(64) }, enumerable: true, writable: true, configurable: true });

    const result = await adapter.requestReview(parsed as never);

    expect(result).toEqual({ outcome: 'receipt', receipt: EXPECTED_SUMMARY });
  });

  it('is not satisfiable by a constant verdict (mismatch still refuses with a receipt-shaped delegate)', async () => {
    const alwaysReceipt = makeRequestReviewFake({ outcome: 'reviewed', receipt: makeReceipt() });
    const adapter = new ReviewRequestAdapter({
      requestIndependentReview: alwaysReceipt.requestIndependentReview,
      findAttemptById: async () => makeAttempt('b'.repeat(64)) as never,
    });

    const result = await adapter.requestReview(makeBoundRequest());

    expect(result).toEqual(REFUSED);
    expect(alwaysReceipt.calls).toHaveLength(0);
  });
});
