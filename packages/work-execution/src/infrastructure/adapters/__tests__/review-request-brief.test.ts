// Brief-verify review subject (CO18a3a). Every refusal is a typed result.
// Cost bounds pinned here: briefText above 64 KiB, project id above 200
// characters, a receipt list or findings array whose length is 2^32-1, and an
// array-like whose length is Number.MAX_SAFE_INTEGER. Those cases return
// without iterating the claimed length.
import { describe, expect, it } from 'vitest';

import { assessmentIdForBrief, attemptIdForBrief } from '@fleet/evidence-and-acceptance';
import type {
  EvidenceAssessmentRecord,
  InspectAcceptanceEvidenceRequest,
  InspectAcceptanceEvidenceResult,
  RequestIndependentReviewRequest,
  RequestIndependentReviewResult,
  ReviewReceiptRecord,
} from '@fleet/evidence-and-acceptance';
import type {
  FindLatestReceiptOfKindRequest,
  FindReviewReceiptRequest,
  ReviewRequest,
} from '../../../application/ports/out/ReviewRequestPort.out-port.js';
import { ReviewRequestAdapter } from '../ReviewRequestAdapter.adapter.js';

const PROJECT = 'proj-1';
const DIGEST = 'ab'.repeat(32);
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const REQUEST_ID = 'brief-verify:wo-1:0123456789ab';
const POLICY = 'policy-1';
const IMPLEMENTER = 'impl-model';
const REVIEWER = 'reviewer-model';
const PRIMARY = 'example-provider/grok-4.7';
const FALLBACK = 'example-provider/fallback-seat';
const ATTEMPT = attemptIdForBrief(PROJECT, DIGEST);
const ASSESSMENT_ID = assessmentIdForBrief(PROJECT, DIGEST);
const BRIEF_TEXT = 'Review the frozen brief.';
const INVALID = { outcome: 'refused', reason: 'invalid-request', detail: null } as const;
const UNAVAILABLE_INVALID = { outcome: 'unavailable', reason: 'invalid-request' } as const;
const MISMATCH_UNKNOWN = { outcome: 'unknown', reason: 'receipt-mismatch' } as const;
const MISMATCH_UNAVAILABLE = { outcome: 'unavailable', reason: 'receipt-mismatch' } as const;
const NO_RECEIPT = { outcome: 'no-receipt', reason: 'review-unavailable', detail: null } as const;

/** A secret shape built at runtime so the source never contains the token. */
function secretShape(): string {
  return 'sk-' + 'A'.repeat(20);
}

function storedSubject(overrides: {
  readonly projectId?: string;
  readonly attemptId?: string | null;
  readonly briefPackageDigest?: string | null;
  readonly baseCommit?: string | null;
} = {}) {
  return {
    kind: 'brief' as const,
    projectId: overrides.projectId ?? PROJECT,
    attemptId: overrides.attemptId ?? null,
    chainName: null,
    integrationHeadSha: null,
    briefPackageDigest: overrides.briefPackageDigest ?? DIGEST,
    baseCommit: overrides.baseCommit ?? HEAD,
  };
}

function finding(overrides: Record<string, unknown> = {}) {
  return {
    findingId: 'f-1',
    severity: 'major',
    summary: 'example finding',
    filePath: 'src/a.ts',
    line: 4,
    state: 'unresolved',
    dispositionReason: null,
    dispositionEvidenceRef: null,
    ...overrides,
  };
}

function briefReceipt(overrides: Partial<ReviewReceiptRecord> = {}): ReviewReceiptRecord {
  return {
    id: 'rr-brief-1',
    assessmentId: ASSESSMENT_ID,
    projectId: PROJECT,
    attemptId: ATTEMPT,
    candidateHeadSha: HEAD,
    reviewerModel: REVIEWER,
    implementerModel: IMPLEMENTER,
    readOnlyVerified: true,
    result: 'pass',
    findings: [finding()],
    evidenceRef: 'evidence://example/review',
    policyRevision: POLICY,
    completedAtIso: '2026-11-17T00:00:00.000Z',
    kind: 'brief-verify',
    requestId: REQUEST_ID,
    subject: storedSubject(),
    ...overrides,
  } as ReviewReceiptRecord;
}

function briefAssessment(receipts: readonly ReviewReceiptRecord[]): EvidenceAssessmentRecord {
  return {
    id: ASSESSMENT_ID,
    projectId: PROJECT,
    attemptId: ATTEMPT,
    candidateHeadSha: HEAD,
    policyRevision: POLICY,
    implementerModel: IMPLEMENTER,
    requiredChecks: [],
    state: 'pending',
    verificationReceipts: [],
    reviewReceipts: receipts,
    findingDispositions: [],
    acceptanceReceiptId: null,
    blockers: [],
    revision: 1,
    updatedAtIso: '2026-11-17T00:00:00.000Z',
  };
}

function briefSubject(overrides: {
  readonly projectId?: string;
  readonly briefPackageDigest?: string;
  readonly baseCommit?: string;
} = {}) {
  return {
    kind: 'brief' as const,
    projectId: overrides.projectId ?? PROJECT,
    briefPackageDigest: overrides.briefPackageDigest ?? DIGEST,
    baseCommit: overrides.baseCommit ?? HEAD,
  };
}

function briefRequest(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    requestId: REQUEST_ID,
    kind: 'brief-verify',
    attemptId: ATTEMPT,
    projectId: PROJECT,
    candidateHeadSha: HEAD,
    subject: briefSubject(),
    policyRevision: POLICY,
    implementerModel: IMPLEMENTER,
    reviewerModel: REVIEWER,
    briefText: BRIEF_TEXT,
    ...overrides,
  };
}

function forProject(projectId: string, overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return briefRequest({
    projectId,
    attemptId: attemptIdForBrief(projectId, DIGEST),
    subject: briefSubject({ projectId }),
    ...overrides,
  });
}

function briefFind(overrides: Partial<FindReviewReceiptRequest> = {}): FindReviewReceiptRequest {
  return {
    attemptId: ATTEMPT,
    requestId: REQUEST_ID,
    candidateHeadSha: HEAD,
    subject: briefSubject(),
    ...overrides,
  };
}

function briefLatest(overrides: Partial<FindLatestReceiptOfKindRequest> = {}): FindLatestReceiptOfKindRequest {
  return {
    attemptId: ATTEMPT,
    candidateHeadSha: HEAD,
    kind: 'brief-verify',
    subject: briefSubject(),
    ...overrides,
  };
}

function reviewing(result: RequestIndependentReviewResult | 'throw') {
  const calls: RequestIndependentReviewRequest[] = [];
  const requestIndependentReview = async (request: RequestIndependentReviewRequest) => {
    calls.push(request);
    if (result === 'throw') {
      throw new Error('delegate exploded');
    }
    return result;
  };
  return { calls, requestIndependentReview };
}

function inspecting(receipts: readonly ReviewReceiptRecord[]) {
  const calls: InspectAcceptanceEvidenceRequest[] = [];
  const inspectAcceptanceEvidence = async (
    request: InspectAcceptanceEvidenceRequest,
  ): Promise<InspectAcceptanceEvidenceResult> => {
    calls.push(request);
    return { outcome: 'found', assessment: briefAssessment(receipts) };
  };
  return { calls, inspectAcceptanceEvidence };
}

const STORED_EVIDENCE_SUBJECT = {
  kind: 'brief' as const,
  projectId: PROJECT,
  attemptId: null,
  chainName: null,
  integrationHeadSha: null,
  briefPackageDigest: DIGEST,
  baseCommit: HEAD,
};

const EXPECTED_SUMMARY = {
  receiptId: 'rr-brief-1',
  requestId: REQUEST_ID,
  kind: 'brief-verify' as const,
  reviewerModel: REVIEWER,
  candidateHeadSha: HEAD,
  verdict: 'passed' as const,
  findings: [{
    findingId: 'f-1',
    severity: 'major',
    summary: 'example finding',
    filePath: 'src/a.ts',
    line: 4,
  }],
};

describe('ReviewRequestAdapter brief-verify request', () => {
  it('dispatches one brief-verify review on the brief assessment and returns the receipt summary', async () => {
    const { calls, requestIndependentReview } = reviewing({ outcome: 'reviewed', receipt: briefReceipt() });
    const result = await new ReviewRequestAdapter({ requestIndependentReview }).requestReview(briefRequest());

    expect(result).toEqual({ outcome: 'receipt', receipt: EXPECTED_SUMMARY });
    expect(calls).toEqual([{
      assessmentId: ASSESSMENT_ID,
      projectId: PROJECT,
      attemptId: ATTEMPT,
      candidateHeadSha: HEAD,
      policyRevision: POLICY,
      implementerModel: IMPLEMENTER,
      reviewerModel: REVIEWER,
      kind: 'brief-verify',
      requestId: REQUEST_ID,
      subject: STORED_EVIDENCE_SUBJECT,
      briefText: BRIEF_TEXT,
    }]);
    if (result.outcome === 'receipt') {
      expect(Object.keys(result.receipt.findings[0] ?? {})).toEqual([
        'findingId', 'severity', 'summary', 'filePath', 'line',
      ]);
      expect(JSON.stringify(result)).not.toContain('evidence://');
    }
  });

  it('forwards a string nowIso and still omits diffSummary', async () => {
    const { calls, requestIndependentReview } = reviewing({ outcome: 'reviewed', receipt: briefReceipt() });
    const nowIso = '2026-11-17T00:00:00.000Z';
    await new ReviewRequestAdapter({ requestIndependentReview }).requestReview(briefRequest({ nowIso }));
    expect(calls[0]?.nowIso).toBe(nowIso);
    expect(calls[0]?.diffSummary).toBeUndefined();
  });

  it('maps a failing brief receipt to verdict failed', async () => {
    const { requestIndependentReview } = reviewing({
      outcome: 'reviewed',
      receipt: briefReceipt({ result: 'fail' }),
    });
    const result = await new ReviewRequestAdapter({ requestIndependentReview }).requestReview(briefRequest());
    expect(result).toEqual({
      outcome: 'receipt',
      receipt: { ...EXPECTED_SUMMARY, verdict: 'failed' },
    });
  });

  it('returns verdict unknown when readOnlyVerified is not true, including when the field is absent', async () => {
    const unverified = briefReceipt({ readOnlyVerified: false, result: 'pass' });
    const { requestIndependentReview } = reviewing({ outcome: 'reviewed', receipt: unverified });
    const result = await new ReviewRequestAdapter({ requestIndependentReview }).requestReview(briefRequest());
    expect(result).toMatchObject({ outcome: 'receipt', receipt: { verdict: 'unknown' } });

    const missing = briefReceipt();
    delete (missing as { readOnlyVerified?: boolean }).readOnlyVerified;
    const second = reviewing({ outcome: 'reviewed', receipt: missing });
    const omitted = await new ReviewRequestAdapter({
      requestIndependentReview: second.requestIndependentReview,
    }).requestReview(briefRequest());
    expect(omitted).toMatchObject({ outcome: 'receipt', receipt: { verdict: 'unknown' } });
  });

  it('accepts briefText of exactly 64 KiB and a multibyte brief of exactly 64 KiB', async () => {
    const exact = 'a'.repeat(64 * 1024);
    const multibyte = 'é'.repeat(32 * 1024);
    for (const briefText of [exact, multibyte]) {
      const { calls, requestIndependentReview } = reviewing({ outcome: 'reviewed', receipt: briefReceipt() });
      const result = await new ReviewRequestAdapter({ requestIndependentReview }).requestReview(briefRequest({ briefText }));
      expect(result.outcome).toBe('receipt');
      expect(calls[0]?.briefText).toBe(briefText);
    }
  });

  it('accepts a briefText that is non-empty after trim', async () => {
    const { calls, requestIndependentReview } = reviewing({ outcome: 'reviewed', receipt: briefReceipt() });
    await new ReviewRequestAdapter({ requestIndependentReview }).requestReview(briefRequest({ briefText: ' x ' }));
    expect(calls[0]?.briefText).toBe(' x ');
  });

  it('forwards a projectId of __proto__, constructor, or prototype as data and does not pollute Object.prototype', async () => {
    for (const projectId of ['__proto__', 'constructor', 'prototype']) {
      const { calls, requestIndependentReview } = reviewing({ outcome: 'reviewed', receipt: briefReceipt({
        projectId,
        attemptId: attemptIdForBrief(projectId, DIGEST),
        subject: storedSubject({ projectId }),
      }) });
      const result = await new ReviewRequestAdapter({ requestIndependentReview }).requestReview(forProject(projectId));
      expect(result.outcome).toBe('receipt');
      expect(calls[0]?.projectId).toBe(projectId);
      expect(calls[0]?.attemptId).toBe(attemptIdForBrief(projectId, DIGEST));
      expect(Object.getPrototypeOf(calls[0]?.subject)).toBe(Object.prototype);
      expect((Object.prototype as { polluted?: unknown }).polluted).toBeUndefined();
    }
  });

  it('accepts a brief subject with prototype-polluting own keys and dispatches only the brief fields', async () => {
    const subject = briefSubject();
    Object.defineProperty(subject, '__proto__', { value: { polluted: true }, enumerable: true });
    Object.defineProperty(subject, 'constructor', { value: { polluted: true }, enumerable: true });
    Object.defineProperty(subject, 'prototype', { value: { polluted: true }, enumerable: true });
    const { calls, requestIndependentReview } = reviewing({ outcome: 'reviewed', receipt: briefReceipt() });
    const result = await new ReviewRequestAdapter({ requestIndependentReview }).requestReview(
      briefRequest({ subject: subject as ReviewRequest['subject'] }),
    );
    expect(result.outcome).toBe('receipt');
    expect(calls[0]?.subject).toEqual(STORED_EVIDENCE_SUBJECT);
    expect((Object.prototype as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('accepts a brief subject whose chain fields are inherited and does not read them as own', async () => {
    const subject = Object.create({ chainName: 'example-chain', integrationHeadSha: HEAD }) as Record<string, unknown>;
    subject.kind = 'brief';
    subject.projectId = PROJECT;
    subject.briefPackageDigest = DIGEST;
    subject.baseCommit = HEAD;
    const { calls, requestIndependentReview } = reviewing({ outcome: 'reviewed', receipt: briefReceipt() });
    const result = await new ReviewRequestAdapter({ requestIndependentReview }).requestReview(
      briefRequest({ subject: subject as ReviewRequest['subject'] }),
    );
    expect(result.outcome).toBe('receipt');
    expect(calls).toHaveLength(1);
  });

  it('accepts a proxy brief subject whose get trap throws and does not invoke get', async () => {
    let gets = 0;
    const subject = new Proxy({
      kind: 'brief',
      projectId: PROJECT,
      briefPackageDigest: DIGEST,
      baseCommit: HEAD,
    }, {
      get() {
        gets += 1;
        throw new Error('get trap');
      },
    });
    const { calls, requestIndependentReview } = reviewing({ outcome: 'reviewed', receipt: briefReceipt() });
    const request = briefRequest();
    Object.defineProperty(request, 'subject', { value: subject, enumerable: true });
    const result = await new ReviewRequestAdapter({ requestIndependentReview }).requestReview(request);
    expect(result.outcome).toBe('receipt');
    expect(gets).toBe(0);
    expect(calls).toHaveLength(1);
  });
});

describe('ReviewRequestAdapter brief receipt lookup', () => {
  it('finds the stored brief receipt for a request id and does not spawn a reviewer', async () => {
    const review = reviewing({ outcome: 'reviewed', receipt: briefReceipt() });
    const inspect = inspecting([briefReceipt()]);
    const adapter = new ReviewRequestAdapter({
      requestIndependentReview: review.requestIndependentReview,
      inspectAcceptanceEvidence: inspect.inspectAcceptanceEvidence,
    });
    const found = await adapter.findReviewReceipt(briefFind());
    expect(found).toEqual({ outcome: 'found', receipt: EXPECTED_SUMMARY });
    expect(inspect.calls).toEqual([{ assessmentId: ASSESSMENT_ID }]);
    expect(review.calls).toHaveLength(0);
  });

  it('returns not-found for an unknown request id and does not spawn a reviewer', async () => {
    const review = reviewing({ outcome: 'reviewed', receipt: briefReceipt() });
    const inspect = inspecting([briefReceipt()]);
    const adapter = new ReviewRequestAdapter({
      requestIndependentReview: review.requestIndependentReview,
      inspectAcceptanceEvidence: inspect.inspectAcceptanceEvidence,
    });
    const missing = await adapter.findReviewReceipt(briefFind({ requestId: 'brief-verify:missing:0123456789ab' }));
    expect(missing).toEqual({ outcome: 'not-found' });
    expect(review.calls).toHaveLength(0);
    expect(inspect.calls).toHaveLength(1);
  });

  it('returns not-found when the assessment is absent', async () => {
    const inspectAcceptanceEvidence = async (): Promise<InspectAcceptanceEvidenceResult> => ({
      outcome: 'not-found',
      query: ASSESSMENT_ID,
    });
    const result = await new ReviewRequestAdapter({ inspectAcceptanceEvidence }).findReviewReceipt(briefFind());
    expect(result).toEqual({ outcome: 'not-found' });
  });

  it('returns not-found when the found assessment belongs to another attempt', async () => {
    const assessment = briefAssessment([briefReceipt()]);
    const inspectAcceptanceEvidence = async (): Promise<InspectAcceptanceEvidenceResult> => ({
      outcome: 'found',
      assessment: { ...assessment, attemptId: 'other-attempt' },
    });
    const result = await new ReviewRequestAdapter({ inspectAcceptanceEvidence }).findReviewReceipt(briefFind());
    expect(result).toEqual({ outcome: 'not-found' });
  });

  it('returns unavailable receipt-mismatch when two receipts carry the request id', async () => {
    const { inspectAcceptanceEvidence } = inspecting([
      briefReceipt(),
      briefReceipt({ id: 'rr-brief-2' }),
    ]);
    const result = await new ReviewRequestAdapter({ inspectAcceptanceEvidence }).findReviewReceipt(briefFind());
    expect(result).toEqual(MISMATCH_UNAVAILABLE);
  });

  it('returns unavailable receipt-mismatch when the stored receipt is a different kind, head, or subject', async () => {
    for (const receipt of [
      briefReceipt({ kind: 'code-review' }),
      briefReceipt({ candidateHeadSha: OTHER_HEAD }),
      briefReceipt({ attemptId: 'attempt-other' }),
      briefReceipt({ subject: undefined }),
      briefReceipt({ subject: storedSubject({ briefPackageDigest: 'cd'.repeat(32) }) as ReviewReceiptRecord['subject'] }),
    ]) {
      const { inspectAcceptanceEvidence } = inspecting([receipt]);
      const result = await new ReviewRequestAdapter({ inspectAcceptanceEvidence }).findReviewReceipt(briefFind());
      expect(result).toEqual(MISMATCH_UNAVAILABLE);
    }
  });

  it('returns verdict unknown when the stored brief receipt was not read-only verified', async () => {
    const { inspectAcceptanceEvidence } = inspecting([briefReceipt({ readOnlyVerified: false, result: 'pass' })]);
    const result = await new ReviewRequestAdapter({ inspectAcceptanceEvidence }).findReviewReceipt(briefFind());
    expect(result).toMatchObject({ outcome: 'found', receipt: { verdict: 'unknown', requestId: REQUEST_ID } });
  });

  it('finds and reads the latest brief receipt when the subject has prototype-polluting own keys', async () => {
    const subject = briefSubject();
    Object.defineProperty(subject, '__proto__', { value: { polluted: true }, enumerable: true });
    Object.defineProperty(subject, 'constructor', { value: { polluted: true }, enumerable: true });
    Object.defineProperty(subject, 'prototype', { value: { polluted: true }, enumerable: true });
    const { inspectAcceptanceEvidence } = inspecting([briefReceipt()]);
    const adapter = new ReviewRequestAdapter({ inspectAcceptanceEvidence });
    const found = await adapter.findReviewReceipt(
      briefFind({ subject: subject as FindReviewReceiptRequest['subject'] }),
    );
    expect(found).toEqual({ outcome: 'found', receipt: EXPECTED_SUMMARY });
    const latest = await adapter.findLatestReceiptOfKind(
      briefLatest({ subject: subject as FindLatestReceiptOfKindRequest['subject'] }),
    );
    expect(latest).toMatchObject({ outcome: 'found', receipt: { receiptId: 'rr-brief-1', kind: 'brief-verify' } });
    expect((Object.prototype as { polluted?: unknown }).polluted).toBeUndefined();
  });
});

describe('ReviewRequestAdapter latest brief receipt', () => {
  it('returns the later brief-verify receipt by instant, whether it is listed first or last', async () => {
    const older = briefReceipt({
      id: 'rr-old',
      requestId: 'brief-verify:old:0123456789ab',
      completedAtIso: '2026-10-01T00:00:00.000Z',
    });
    const newer = briefReceipt({
      id: 'rr-new',
      requestId: 'brief-verify:new:0123456789ab',
      completedAtIso: '2026-10-02T00:00:00.000Z',
    });
    const newerLast = inspecting([older, newer]);
    const lastResult = await new ReviewRequestAdapter({
      inspectAcceptanceEvidence: newerLast.inspectAcceptanceEvidence,
    }).findLatestReceiptOfKind(briefLatest());
    expect(lastResult).toMatchObject({ outcome: 'found', receipt: { receiptId: 'rr-new', kind: 'brief-verify' } });

    const newerFirst = inspecting([newer, older]);
    const firstResult = await new ReviewRequestAdapter({
      inspectAcceptanceEvidence: newerFirst.inspectAcceptanceEvidence,
    }).findLatestReceiptOfKind(briefLatest());
    expect(firstResult).toMatchObject({ outcome: 'found', receipt: { receiptId: 'rr-new' } });
  });

  it('lets the later listed brief receipt win when the instants are equal', async () => {
    const first = briefReceipt({ id: 'rr-first', requestId: 'brief-verify:first:0123456789ab' });
    const second = briefReceipt({ id: 'rr-second', requestId: 'brief-verify:second:0123456789ab' });
    const { inspectAcceptanceEvidence } = inspecting([first, second]);
    const result = await new ReviewRequestAdapter({ inspectAcceptanceEvidence }).findLatestReceiptOfKind(briefLatest());
    expect(result).toMatchObject({ outcome: 'found', receipt: { receiptId: 'rr-second' } });
  });

  it('returns a manual brief receipt with requestId null', async () => {
    const manual = briefReceipt();
    delete (manual as { requestId?: string }).requestId;
    const { inspectAcceptanceEvidence } = inspecting([manual]);
    const result = await new ReviewRequestAdapter({ inspectAcceptanceEvidence }).findLatestReceiptOfKind(briefLatest());
    expect(result).toMatchObject({ outcome: 'found', receipt: { receiptId: 'rr-brief-1', requestId: null, kind: 'brief-verify' } });
  });

  it('returns not-found when the brief assessment has no brief-verify receipt', async () => {
    const { inspectAcceptanceEvidence } = inspecting([briefReceipt({ kind: 'code-review' })]);
    const result = await new ReviewRequestAdapter({ inspectAcceptanceEvidence }).findLatestReceiptOfKind(briefLatest());
    expect(result).toEqual({ outcome: 'not-found' });
  });

  it('returns unavailable receipt-mismatch when one brief-verify receipt is not this brief', async () => {
    const good = briefReceipt({ id: 'rr-good', requestId: 'brief-verify:good:0123456789ab' });
    const bad = briefReceipt({ id: 'rr-bad', candidateHeadSha: OTHER_HEAD, requestId: 'brief-verify:bad:0123456789ab' });
    const { inspectAcceptanceEvidence } = inspecting([good, bad]);
    const result = await new ReviewRequestAdapter({ inspectAcceptanceEvidence }).findLatestReceiptOfKind(briefLatest());
    expect(result).toEqual(MISMATCH_UNAVAILABLE);
  });

  it('returns verdict unknown for a latest brief receipt that was not read-only verified', async () => {
    const { inspectAcceptanceEvidence } = inspecting([briefReceipt({ readOnlyVerified: false, result: 'pass' })]);
    const result = await new ReviewRequestAdapter({ inspectAcceptanceEvidence }).findLatestReceiptOfKind(briefLatest());
    expect(result).toMatchObject({ outcome: 'found', receipt: { verdict: 'unknown' } });
  });
});

describe('brief-verify invalid-request', () => {
  async function refused(request: ReviewRequest): Promise<void> {
    const { calls, requestIndependentReview } = reviewing({ outcome: 'reviewed', receipt: briefReceipt() });
    const result = await new ReviewRequestAdapter({ requestIndependentReview }).requestReview(request);
    expect(result).toEqual(INVALID);
    expect(calls).toHaveLength(0);
  }

  it.each([
    ['a null request', null],
    ['an undefined request', undefined],
    ['a numeric request', 4],
    ['a string request', 'brief'],
  ])('requestReview refuses %s with invalid-request and calls no delegate', async (_label, request) => {
    await refused(request as ReviewRequest);
  });

  it('requestReview refuses a sparse-array subject with invalid-request and calls no delegate', async () => {
    const subject: unknown[] = [];
    subject.length = 3;
    await refused(briefRequest({ subject: subject as unknown as ReviewRequest['subject'] }));
  });

  it('requestReview refuses an array-like subject with an enormous length and calls no delegate', async () => {
    const subject = { length: Number.MAX_SAFE_INTEGER, kind: 'brief', projectId: PROJECT };
    await refused(briefRequest({ subject: subject as unknown as ReviewRequest['subject'] }));
  });

  it.each([
    ['an empty project id', forProject('')],
    ['a project id with a colon', forProject('a:b')],
    ['a project id with a slash', forProject('a/b')],
    ['a project id longer than 200 characters', forProject('p'.repeat(201))],
    ['a project id with a control character', forProject('a\nb')],
    ['a project id with surrounding space', forProject(' proj')],
    ['a secret-shaped project id', forProject(secretShape())],
    ['a project id that disagrees with the request', briefRequest({
      projectId: 'other-proj',
      attemptId: ATTEMPT,
      subject: briefSubject(),
    })],
    ['an invalid brief digest', briefRequest({
      subject: briefSubject({ briefPackageDigest: 'ab'.repeat(31) }),
    })],
    ['an uppercase brief digest', briefRequest({
      subject: briefSubject({ briefPackageDigest: 'AB'.repeat(32) }),
    })],
    ['a base commit that is not 40 lowercase hex', briefRequest({
      subject: briefSubject({ baseCommit: 'xyz' }),
    })],
    ['a base commit that disagrees with the candidate head', briefRequest({
      subject: briefSubject({ baseCommit: OTHER_HEAD }),
    })],
    ['an attempt id that is not the brief pseudo id', briefRequest({ attemptId: 'attempt-1' })],
    ['a chain name on a brief subject', briefRequest({
      subject: { ...briefSubject(), chainName: 'example-chain' } as unknown as ReviewRequest['subject'],
    })],
    ['an integration head on a brief subject', briefRequest({
      subject: { ...briefSubject(), integrationHeadSha: HEAD } as unknown as ReviewRequest['subject'],
    })],
    ['a code-review kind on a brief subject', briefRequest({ kind: 'code-review' })],
    ['brief-verify with no subject', (() => {
      const request = briefRequest();
      const rest = { ...request };
      delete rest.subject;
      return rest;
    })()],
    ['brief-verify on an attempt subject', briefRequest({
      subject: { kind: 'attempt', projectId: PROJECT, attemptId: ATTEMPT, headSha: HEAD },
    })],
    ['brief-verify on a chain subject', briefRequest({
      subject: { kind: 'chain', projectId: PROJECT, chainName: 'example-chain', integrationHeadSha: HEAD },
    })],
    ['a missing briefText', (() => {
      const request = briefRequest();
      const rest = { ...request };
      delete rest.briefText;
      return rest;
    })()],
    ['an empty briefText', briefRequest({ briefText: '' })],
    ['a whitespace briefText', briefRequest({ briefText: ' \n\t ' })],
    ['a briefText over 64 KiB', briefRequest({ briefText: 'a'.repeat(64 * 1024 + 1) })],
    ['a multibyte briefText over 64 KiB', briefRequest({ briefText: 'é'.repeat(32 * 1024 + 1) })],
    ['a sparse-array briefText', briefRequest({ briefText: (() => {
      const text: unknown[] = [];
      text.length = 2;
      return text;
    })() as unknown as string })],
    ['a non-iterable briefText', briefRequest({ briefText: { length: 1 } as unknown as string })],
    ['a numeric briefText', briefRequest({ briefText: 7 as unknown as string })],
    ['a diffSummary', briefRequest({ diffSummary: 'scope' })],
    ['an empty diffSummary', briefRequest({ diffSummary: '' })],
    ['a numeric nowIso', briefRequest({ nowIso: 7 as unknown as string })],
    ['a request id with a space', briefRequest({ requestId: 'has space' })],
    ['a null request id', briefRequest({ requestId: null as unknown as string })],
    ['a numeric request id', briefRequest({ requestId: 4 as unknown as string })],
    ['a secret-shaped request id', briefRequest({ requestId: secretShape() })],
    ['an empty policy revision', briefRequest({ policyRevision: '   ' })],
    ['a secret-shaped policy revision', briefRequest({ policyRevision: secretShape() })],
    ['an empty implementer model', briefRequest({ implementerModel: '' })],
    ['a secret-shaped implementer model', briefRequest({ implementerModel: secretShape() })],
    ['an empty reviewer model', briefRequest({ reviewerModel: '' })],
    ['a secret-shaped reviewer model', briefRequest({ reviewerModel: secretShape() })],
    ['a digest inherited from the prototype', (() => {
      const subject = Object.create({ briefPackageDigest: DIGEST, baseCommit: HEAD }) as Record<string, unknown>;
      subject.kind = 'brief';
      subject.projectId = PROJECT;
      return briefRequest({ subject: subject as ReviewRequest['subject'] });
    })()],
  ])('requestReview refuses %s with invalid-request and calls no delegate', async (_label, request) => {
    await refused(request);
  });

  it('requestReview refuses a briefPackageDigest accessor with invalid-request and does not invoke the getter', async () => {
    let invoked = false;
    const subject = { kind: 'brief' as const, projectId: PROJECT, baseCommit: HEAD };
    Object.defineProperty(subject, 'briefPackageDigest', {
      enumerable: true,
      get() {
        invoked = true;
        return DIGEST;
      },
    });
    const request = briefRequest();
    Object.defineProperty(request, 'subject', { value: subject, enumerable: true });
    await refused(request);
    expect(invoked).toBe(false);
  });

  it('requestReview refuses a throwing baseCommit getter with invalid-request and does not invoke it', async () => {
    let invoked = false;
    const subject = { kind: 'brief' as const, projectId: PROJECT, briefPackageDigest: DIGEST };
    Object.defineProperty(subject, 'baseCommit', {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error('boom');
      },
    });
    const request = briefRequest();
    Object.defineProperty(request, 'subject', { value: subject, enumerable: true });
    await refused(request);
    expect(invoked).toBe(false);
  });

  it('requestReview refuses a throwing briefText getter with invalid-request and does not invoke it', async () => {
    let invoked = false;
    const request = briefRequest() as ReviewRequest & Record<string, unknown>;
    delete request.briefText;
    Object.defineProperty(request, 'briefText', {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error('boom');
      },
    });
    await refused(request);
    expect(invoked).toBe(false);
  });

  it('requestReview refuses a subject whose descriptor trap throws with invalid-request', async () => {
    const subject = new Proxy({
      kind: 'brief',
      projectId: PROJECT,
      briefPackageDigest: DIGEST,
      baseCommit: HEAD,
    }, {
      getOwnPropertyDescriptor() {
        throw new Error('trap');
      },
    });
    const request = briefRequest();
    Object.defineProperty(request, 'subject', { value: subject, enumerable: true });
    await refused(request);
  });

  it('requestReview refuses a kind accessor on a brief subject with invalid-request and does not invoke it', async () => {
    let invoked = false;
    const request = briefRequest() as ReviewRequest & Record<string, unknown>;
    delete request.kind;
    Object.defineProperty(request, 'kind', {
      enumerable: true,
      get() {
        invoked = true;
        return 'brief-verify';
      },
    });
    await refused(request);
    expect(invoked).toBe(false);
  });
});

describe('brief find unavailable invalid-request', () => {
  async function unavailableFind(request: FindReviewReceiptRequest): Promise<void> {
    const { calls, inspectAcceptanceEvidence } = inspecting([briefReceipt()]);
    const result = await new ReviewRequestAdapter({ inspectAcceptanceEvidence }).findReviewReceipt(request);
    expect(result).toEqual(UNAVAILABLE_INVALID);
    expect(calls).toHaveLength(0);
  }

  async function unavailableLatest(request: FindLatestReceiptOfKindRequest): Promise<void> {
    const { calls, inspectAcceptanceEvidence } = inspecting([briefReceipt()]);
    const result = await new ReviewRequestAdapter({ inspectAcceptanceEvidence }).findLatestReceiptOfKind(request);
    expect(result).toEqual(UNAVAILABLE_INVALID);
    expect(calls).toHaveLength(0);
  }

  it.each([
    ['a null find request', null],
    ['an undefined find request', undefined],
    ['a numeric find request', 4],
  ])('findReviewReceipt returns unavailable invalid-request for %s and does not inspect', async (_label, request) => {
    await unavailableFind(request as FindReviewReceiptRequest);
  });

  it.each([
    ['a null latest request', null],
    ['an undefined latest request', undefined],
    ['a numeric latest request', 9],
  ])('findLatestReceiptOfKind returns unavailable invalid-request for %s and does not inspect', async (_label, request) => {
    await unavailableLatest(request as FindLatestReceiptOfKindRequest);
  });

  it('findReviewReceipt returns unavailable invalid-request for a secret-shaped request id and does not inspect', async () => {
    await unavailableFind(briefFind({ requestId: secretShape() }));
  });

  it('findReviewReceipt returns unavailable invalid-request for a null request id and does not inspect', async () => {
    await unavailableFind(briefFind({ requestId: null as unknown as string }));
  });

  it('findReviewReceipt returns unavailable invalid-request when requestId is an accessor and does not invoke it', async () => {
    let invoked = false;
    const request = briefFind() as FindReviewReceiptRequest & Record<string, unknown>;
    delete request.requestId;
    Object.defineProperty(request, 'requestId', {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error('boom');
      },
    });
    await unavailableFind(request);
    expect(invoked).toBe(false);
  });

  it('findLatestReceiptOfKind refuses a non-brief-verify kind on a brief subject and does not inspect', async () => {
    await unavailableLatest(briefLatest({ kind: 'code-review' }));
    await unavailableLatest(briefLatest({ kind: 'pre-merge' }));
  });

  it('findLatestReceiptOfKind refuses brief-verify with no subject and does not inspect', async () => {
    const { calls, inspectAcceptanceEvidence } = inspecting([briefReceipt()]);
    const result = await new ReviewRequestAdapter({ inspectAcceptanceEvidence }).findLatestReceiptOfKind({
      attemptId: 'attempt-1',
      candidateHeadSha: HEAD,
      kind: 'brief-verify',
    });
    expect(result).toEqual(UNAVAILABLE_INVALID);
    expect(calls).toHaveLength(0);
  });

  it('findLatestReceiptOfKind refuses brief-verify on a valid chain subject and does not inspect', async () => {
    const chainSubject = {
      kind: 'chain' as const,
      projectId: PROJECT,
      chainName: 'example-chain',
      integrationHeadSha: HEAD,
    };
    const chainLookup = inspecting([]);
    await new ReviewRequestAdapter({
      inspectAcceptanceEvidence: chainLookup.inspectAcceptanceEvidence,
    }).findLatestReceiptOfKind({
      attemptId: 'chain:proj-1:example-chain',
      candidateHeadSha: HEAD,
      kind: 'pre-merge',
      subject: chainSubject,
    });
    expect(chainLookup.calls).toHaveLength(1);

    const briefLookup = inspecting([]);
    const result = await new ReviewRequestAdapter({
      inspectAcceptanceEvidence: briefLookup.inspectAcceptanceEvidence,
    }).findLatestReceiptOfKind({
      attemptId: 'chain:proj-1:example-chain',
      candidateHeadSha: HEAD,
      kind: 'brief-verify',
      subject: chainSubject,
    });
    expect(result).toEqual(UNAVAILABLE_INVALID);
    expect(briefLookup.calls).toHaveLength(0);
  });

  it('findReviewReceipt returns unavailable invalid-request for a mismatched brief attempt id and does not inspect', async () => {
    await unavailableFind(briefFind({ attemptId: 'attempt-1' }));
  });
});

describe('brief delegate configuration and failures', () => {
  it('requestReview returns refused not-configured when requestIndependentReview is absent', async () => {
    const result = await new ReviewRequestAdapter().requestReview(briefRequest());
    expect(result).toEqual({ outcome: 'refused', reason: 'not-configured', detail: null });
  });

  it('requestReview still returns invalid-request for a bad brief when no delegate is bound', async () => {
    const result = await new ReviewRequestAdapter().requestReview(briefRequest({ briefText: '' }));
    expect(result).toEqual(INVALID);
  });

  it('findReviewReceipt and findLatestReceiptOfKind return unavailable not-configured when inspect is absent', async () => {
    const adapter = new ReviewRequestAdapter();
    expect(await adapter.findReviewReceipt(briefFind())).toEqual({ outcome: 'unavailable', reason: 'not-configured' });
    expect(await adapter.findLatestReceiptOfKind(briefLatest())).toEqual({ outcome: 'unavailable', reason: 'not-configured' });
  });

  it('requestReview returns unknown delegate-failed when requestIndependentReview throws', async () => {
    const { requestIndependentReview } = reviewing('throw');
    const result = await new ReviewRequestAdapter({ requestIndependentReview }).requestReview(briefRequest());
    expect(result).toEqual({ outcome: 'unknown', reason: 'delegate-failed' });
  });

  it('find methods return unavailable unreadable when inspectAcceptanceEvidence throws', async () => {
    const inspectAcceptanceEvidence = async (): Promise<InspectAcceptanceEvidenceResult> => {
      throw new Error('inspection exploded');
    };
    const adapter = new ReviewRequestAdapter({ inspectAcceptanceEvidence });
    expect(await adapter.findReviewReceipt(briefFind())).toEqual({ outcome: 'unavailable', reason: 'unreadable' });
    expect(await adapter.findLatestReceiptOfKind(briefLatest())).toEqual({ outcome: 'unavailable', reason: 'unreadable' });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'reviewed'],
    ['a number', 4],
    ['an array', []],
    ['an unknown outcome', { outcome: 'nope' }],
    ['a reviewed result with no receipt', { outcome: 'reviewed' }],
    ['a reviewed result whose receipt is null', { outcome: 'reviewed', receipt: null }],
    ['a reviewed result whose receipt is a string', { outcome: 'reviewed', receipt: 'x' }],
  ])('requestReview returns no-receipt review-unavailable for a delegate reply that is %s', async (_label, reply) => {
    const { requestIndependentReview } = reviewing(reply as RequestIndependentReviewResult);
    const result = await new ReviewRequestAdapter({ requestIndependentReview }).requestReview(briefRequest());
    expect(result).toEqual(NO_RECEIPT);
  });

  it('requestReview returns no-receipt review-unavailable when the reply prototype trap throws', async () => {
    const reply = new Proxy({ outcome: 'reviewed', receipt: briefReceipt() }, {
      getPrototypeOf() {
        throw new Error('proto');
      },
    });
    const { requestIndependentReview } = reviewing(reply as unknown as RequestIndependentReviewResult);
    const result = await new ReviewRequestAdapter({ requestIndependentReview }).requestReview(briefRequest());
    expect(result).toEqual(NO_RECEIPT);
  });

  it.each([
    ['another request id', { requestId: 'brief-verify:other:0123456789ab' }],
    ['another head', { candidateHeadSha: OTHER_HEAD }],
    ['another kind', { kind: 'code-review' as const }],
    ['another attempt id', { attemptId: 'attempt-other' }],
    ['no subject', { subject: undefined }],
  ])('requestReview returns unknown receipt-mismatch when the receipt has %s', async (_label, overrides) => {
    const { requestIndependentReview } = reviewing({
      outcome: 'reviewed',
      receipt: briefReceipt(overrides),
    });
    const result = await new ReviewRequestAdapter({ requestIndependentReview }).requestReview(briefRequest());
    expect(result).toEqual(MISMATCH_UNKNOWN);
  });

  it('requestReview returns unknown receipt-mismatch for a findings hole and does not throw', async () => {
    const findings = [finding()];
    delete (findings as unknown[])[0];
    const { requestIndependentReview } = reviewing({
      outcome: 'reviewed',
      receipt: briefReceipt({ findings: findings as ReviewReceiptRecord['findings'] }),
    });
    const result = await new ReviewRequestAdapter({ requestIndependentReview }).requestReview(briefRequest());
    expect(result).toEqual(MISMATCH_UNKNOWN);
  });

  it('requestReview returns unknown receipt-mismatch for a finding with a bad severity', async () => {
    const { requestIndependentReview } = reviewing({
      outcome: 'reviewed',
      receipt: briefReceipt({
        findings: [finding({ severity: 'nope' })] as ReviewReceiptRecord['findings'],
      }),
    });
    const result = await new ReviewRequestAdapter({ requestIndependentReview }).requestReview(briefRequest());
    expect(result).toEqual(MISMATCH_UNKNOWN);
  });

  it('requestReview returns unknown receipt-mismatch for findings whose length is 2^32-1 without iterating them', async () => {
    const findings: unknown[] = [];
    findings.length = 2 ** 32 - 1;
    const { requestIndependentReview } = reviewing({
      outcome: 'reviewed',
      receipt: briefReceipt({ findings: findings as ReviewReceiptRecord['findings'] }),
    });
    const result = await new ReviewRequestAdapter({ requestIndependentReview }).requestReview(briefRequest());
    expect(result).toEqual(MISMATCH_UNKNOWN);
  });

  it('requestReview returns unknown receipt-mismatch for an array-like findings object with an enormous length', async () => {
    const { requestIndependentReview } = reviewing({
      outcome: 'reviewed',
      receipt: briefReceipt({
        findings: { length: Number.MAX_SAFE_INTEGER } as unknown as ReviewReceiptRecord['findings'],
      }),
    });
    const result = await new ReviewRequestAdapter({ requestIndependentReview }).requestReview(briefRequest());
    expect(result).toEqual(MISMATCH_UNKNOWN);
  });

  it('requestReview returns unknown receipt-mismatch when the receipt kind is an accessor and does not invoke it', async () => {
    let invoked = false;
    const receipt = briefReceipt() as ReviewReceiptRecord & Record<string, unknown>;
    delete receipt.kind;
    Object.defineProperty(receipt, 'kind', {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error('boom');
      },
    });
    const { requestIndependentReview } = reviewing({ outcome: 'reviewed', receipt });
    const result = await new ReviewRequestAdapter({ requestIndependentReview }).requestReview(briefRequest());
    expect(result).toEqual(MISMATCH_UNKNOWN);
    expect(invoked).toBe(false);
  });

  it('findReviewReceipt returns unavailable receipt-mismatch for non-dense findings', async () => {
    const findings = [finding()];
    delete (findings as unknown[])[0];
    const { inspectAcceptanceEvidence } = inspecting([
      briefReceipt({ findings: findings as ReviewReceiptRecord['findings'] }),
    ]);
    const result = await new ReviewRequestAdapter({ inspectAcceptanceEvidence }).findReviewReceipt(briefFind());
    expect(result).toEqual(MISMATCH_UNAVAILABLE);
  });

  it('findReviewReceipt returns unavailable unreadable when reviewReceipts is a non-iterable number', async () => {
    const assessment = briefAssessment([]);
    (assessment as { reviewReceipts: unknown }).reviewReceipts = 7;
    const inspectAcceptanceEvidence = async (): Promise<InspectAcceptanceEvidenceResult> => ({
      outcome: 'found',
      assessment,
    });
    const result = await new ReviewRequestAdapter({ inspectAcceptanceEvidence }).findReviewReceipt(briefFind());
    expect(result).toEqual({ outcome: 'unavailable', reason: 'unreadable' });
  });

  it('findReviewReceipt returns unavailable unreadable when reviewReceipts has a hole', async () => {
    const sparse: ReviewReceiptRecord[] = [];
    sparse.length = 2;
    const assessment = briefAssessment([]);
    (assessment as { reviewReceipts: unknown }).reviewReceipts = sparse;
    const inspectAcceptanceEvidence = async (): Promise<InspectAcceptanceEvidenceResult> => ({
      outcome: 'found',
      assessment,
    });
    const result = await new ReviewRequestAdapter({ inspectAcceptanceEvidence }).findReviewReceipt(briefFind());
    expect(result).toEqual({ outcome: 'unavailable', reason: 'unreadable' });
  });

  it('findReviewReceipt returns unavailable unreadable when reviewReceipts holds a number', async () => {
    const assessment = briefAssessment([]);
    (assessment as { reviewReceipts: unknown }).reviewReceipts = [7];
    const inspectAcceptanceEvidence = async (): Promise<InspectAcceptanceEvidenceResult> => ({
      outcome: 'found',
      assessment,
    });
    const result = await new ReviewRequestAdapter({ inspectAcceptanceEvidence }).findReviewReceipt(briefFind());
    expect(result).toEqual({ outcome: 'unavailable', reason: 'unreadable' });
  });

  it('findReviewReceipt returns unavailable unreadable for a receipt list of length 2^32-1 without iterating it', async () => {
    const huge: ReviewReceiptRecord[] = [];
    huge.length = 2 ** 32 - 1;
    const assessment = briefAssessment([]);
    (assessment as { reviewReceipts: unknown }).reviewReceipts = huge;
    const inspectAcceptanceEvidence = async (): Promise<InspectAcceptanceEvidenceResult> => ({
      outcome: 'found',
      assessment,
    });
    const result = await new ReviewRequestAdapter({ inspectAcceptanceEvidence }).findReviewReceipt(briefFind());
    expect(result).toEqual({ outcome: 'unavailable', reason: 'unreadable' });
  });

  it('findReviewReceipt returns unavailable unreadable for an array-like receipt list with an enormous length', async () => {
    const assessment = briefAssessment([]);
    (assessment as { reviewReceipts: unknown }).reviewReceipts = { length: Number.MAX_SAFE_INTEGER };
    const inspectAcceptanceEvidence = async (): Promise<InspectAcceptanceEvidenceResult> => ({
      outcome: 'found',
      assessment,
    });
    const result = await new ReviewRequestAdapter({ inspectAcceptanceEvidence }).findReviewReceipt(briefFind());
    expect(result).toEqual({ outcome: 'unavailable', reason: 'unreadable' });
  });

  it('findReviewReceipt returns unavailable unreadable when reviewReceipts is an accessor and does not invoke it', async () => {
    let invoked = false;
    const assessment = briefAssessment([briefReceipt()]);
    Object.defineProperty(assessment, 'reviewReceipts', {
      enumerable: true,
      get() {
        invoked = true;
        return [briefReceipt()];
      },
    });
    const inspectAcceptanceEvidence = async (): Promise<InspectAcceptanceEvidenceResult> => ({
      outcome: 'found',
      assessment,
    });
    const result = await new ReviewRequestAdapter({ inspectAcceptanceEvidence }).findReviewReceipt(briefFind());
    expect(result).toEqual({ outcome: 'unavailable', reason: 'unreadable' });
    expect(invoked).toBe(false);
  });

  it('findLatestReceiptOfKind returns unavailable unreadable when reviewReceipts is an accessor and does not invoke it', async () => {
    let invoked = false;
    const assessment = briefAssessment([briefReceipt()]);
    Object.defineProperty(assessment, 'reviewReceipts', {
      enumerable: true,
      get() {
        invoked = true;
        return [briefReceipt()];
      },
    });
    const inspectAcceptanceEvidence = async (): Promise<InspectAcceptanceEvidenceResult> => ({
      outcome: 'found',
      assessment,
    });
    const result = await new ReviewRequestAdapter({ inspectAcceptanceEvidence }).findLatestReceiptOfKind(briefLatest());
    expect(result).toEqual({ outcome: 'unavailable', reason: 'unreadable' });
    expect(invoked).toBe(false);
  });

  it('findLatestReceiptOfKind returns unavailable unreadable for the same hostile receipt lists', async () => {
    const sparse: ReviewReceiptRecord[] = [];
    sparse.length = 2;
    const huge: ReviewReceiptRecord[] = [];
    huge.length = 2 ** 32 - 1;
    const lists: unknown[] = [7, sparse, [4], huge, { length: Number.MAX_SAFE_INTEGER }];
    for (const reviewReceipts of lists) {
      const assessment = briefAssessment([]);
      (assessment as { reviewReceipts: unknown }).reviewReceipts = reviewReceipts;
      const inspectAcceptanceEvidence = async (): Promise<InspectAcceptanceEvidenceResult> => ({
        outcome: 'found',
        assessment,
      });
      const result = await new ReviewRequestAdapter({ inspectAcceptanceEvidence }).findLatestReceiptOfKind(briefLatest());
      expect(result).toEqual({ outcome: 'unavailable', reason: 'unreadable' });
    }
  });
});

describe('brief-verify retry budget', () => {
  function scripted(answers: readonly RequestIndependentReviewResult[]) {
    const calls: RequestIndependentReviewRequest[] = [];
    const requestIndependentReview = async (request: RequestIndependentReviewRequest) => {
      calls.push(request);
      const answer = answers[calls.length - 1];
      if (answer === undefined) {
        throw new Error('retried more than once');
      }
      return answer;
    };
    return { calls, requestIndependentReview };
  }

  const timeout = {
    outcome: 'rejected',
    reason: 'slow',
    rejection: 'review-unavailable',
    code: 'timeout',
  } as RequestIndependentReviewResult;

  it('retries a brief-verify timeout once against the fallback seat and then returns no-receipt', async () => {
    const { calls, requestIndependentReview } = scripted([timeout, timeout]);
    const result = await new ReviewRequestAdapter({
      requestIndependentReview,
      primaryApiReviewerModel: PRIMARY,
      opencodeFallbackReviewerModel: FALLBACK,
    }).requestReview(briefRequest({ reviewerModel: PRIMARY }));
    expect(result).toEqual({ outcome: 'no-receipt', reason: 'review-unavailable', detail: 'timeout' });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.reviewerModel).toBe(PRIMARY);
    expect(calls[1]?.reviewerModel).toBe(FALLBACK);
    expect(calls[1]?.kind).toBe('brief-verify');
    expect(calls[1]?.briefText).toBe(BRIEF_TEXT);
    expect(calls[1]?.attemptId).toBe(ATTEMPT);
  });

  it('maps the second brief-verify rejection to refused and does not retry again', async () => {
    const refused = {
      outcome: 'rejected',
      reason: 'no',
      rejection: 'seat-refused',
    } as RequestIndependentReviewResult;
    const { calls, requestIndependentReview } = scripted([timeout, refused]);
    const result = await new ReviewRequestAdapter({
      requestIndependentReview,
      primaryApiReviewerModel: PRIMARY,
      opencodeFallbackReviewerModel: FALLBACK,
    }).requestReview(briefRequest({ reviewerModel: PRIMARY }));
    expect(result).toEqual({ outcome: 'refused', reason: 'seat-refused', detail: null });
    expect(calls).toHaveLength(2);
  });

  it('does not retry a brief-verify review-unavailable that is not an API transport code', async () => {
    const route = {
      outcome: 'rejected',
      reason: 'no route',
      rejection: 'review-unavailable',
      code: 'route-no-port',
    } as RequestIndependentReviewResult;
    const { calls, requestIndependentReview } = scripted([route, timeout]);
    const result = await new ReviewRequestAdapter({
      requestIndependentReview,
      primaryApiReviewerModel: PRIMARY,
      opencodeFallbackReviewerModel: FALLBACK,
    }).requestReview(briefRequest({ reviewerModel: PRIMARY }));
    expect(result).toEqual({ outcome: 'no-receipt', reason: 'review-unavailable', detail: 'route-no-port' });
    expect(calls).toHaveLength(1);
  });
});
