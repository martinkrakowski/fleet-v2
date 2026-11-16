// The two readers of stored review receipts, attempt path: a receipt counts
// only when it is about the attempt being read. ReviewRequestAdapter answers
// `receipt-mismatch` for a latest receipt about another subject;
// AcceptanceReceiptReadAdapter projects such a receipt with the result
// `unknown`. All fakes are object literals.

import { describe, expect, it } from 'vitest';

import type {
  EvidenceAssessmentRecord,
  InspectAcceptanceEvidenceResult,
  RequestIndependentReviewResult,
  ReviewReceiptRecord,
} from '@fleet/evidence-and-acceptance';
import type { ReviewReceiptProjection } from '../../../application/ports/out/AcceptanceReceiptReadPort.out-port.js';
import { aggregateLinkReceipts } from '../../../application/use-cases/ReviewChainUseCase.use-case.js';
import { AcceptanceReceiptReadAdapter } from '../AcceptanceReceiptReadAdapter.adapter.js';
import { ReviewRequestAdapter } from '../ReviewRequestAdapter.adapter.js';

const HEAD = '1111111111111111111111111111111111111111';
const DIGEST = 'd'.repeat(64);
const REQUEST_ID = 'review-01JB00000000000000000000NN';
const MISMATCH = { outcome: 'unavailable', reason: 'receipt-mismatch' };

function subjectOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'attempt', projectId: 'proj-1', attemptId: 'att-1', chainName: null, integrationHeadSha: null,
    briefPackageDigest: null, baseCommit: null, ...overrides,
  };
}

function receipt(overrides: Record<string, unknown> = {}): ReviewReceiptRecord {
  return {
    id: 'rr-1', assessmentId: 'assessment-att-1', projectId: 'proj-1', attemptId: 'att-1', candidateHeadSha: HEAD,
    reviewerModel: 'example-provider/reviewer-1', implementerModel: 'example-provider/implementer-1',
    readOnlyVerified: true, result: 'pass', findings: [], evidenceRef: 'evidence://example/review',
    policyRevision: 'policy-1', completedAtIso: '2026-11-01T00:00:00.000Z', kind: 'pre-merge', ...overrides,
  } as unknown as ReviewReceiptRecord;
}

const failing = (overrides: Record<string, unknown> = {}): ReviewReceiptRecord =>
  receipt({
    result: 'fail',
    findings: [{
      findingId: 'f-1', severity: 'blocker', summary: 'example', filePath: null, line: null,
      state: 'unresolved', dispositionReason: null, dispositionEvidenceRef: null,
    }],
    ...overrides,
  });

function assessmentOf(reviewReceipts: readonly ReviewReceiptRecord[]): EvidenceAssessmentRecord {
  return {
    id: 'assessment-att-1', projectId: 'proj-1', attemptId: 'att-1', candidateHeadSha: HEAD,
    policyRevision: 'policy-1', implementerModel: 'example-provider/implementer-1', requiredChecks: [],
    state: 'pending', verificationReceipts: [], reviewReceipts, findingDispositions: [],
    acceptanceReceiptId: null, blockers: [], revision: 1, updatedAtIso: '2026-11-01T00:00:00.000Z',
  };
}

function adapterOver(reviewReceipts: readonly ReviewReceiptRecord[]): ReviewRequestAdapter {
  const inspected: InspectAcceptanceEvidenceResult = { outcome: 'found', assessment: assessmentOf(reviewReceipts) };
  return new ReviewRequestAdapter({ inspectAcceptanceEvidence: async () => inspected });
}

const latestPreMerge = (reviewReceipts: readonly ReviewReceiptRecord[]) =>
  adapterOver(reviewReceipts).findLatestReceiptOfKind({ attemptId: 'att-1', candidateHeadSha: HEAD, kind: 'pre-merge' });

const EARLIER = '2026-11-01T00:00:00.000Z';
const LATER = '2026-11-02T00:00:00.000Z';
const OTHER_ATTEMPT = subjectOf({ attemptId: 'att-OTHER' });

/** A subject whose ids are inherited, not own. */
function inheritedSubject(): unknown {
  return Object.create(subjectOf());
}

/** A subject whose `attemptId` sits under an own `__proto__` key, as JSON.parse stores it. */
function protoKeySubject(): unknown {
  return JSON.parse(
    '{"kind":"attempt","projectId":"proj-1","__proto__":{"attemptId":"att-1"},"chainName":null,' +
      '"integrationHeadSha":null,"briefPackageDigest":null,"baseCommit":null}',
  );
}

const NOT_ABOUT: readonly (readonly [string, () => unknown])[] = [
  ['another attempt', () => OTHER_ATTEMPT],
  ['another project', () => subjectOf({ projectId: 'proj-OTHER' })],
  ['the attempt id in another letter case', () => subjectOf({ attemptId: 'ATT-1' })],
  ['the attempt id with a trailing space', () => subjectOf({ attemptId: 'att-1 ' })],
  ['the project id with a leading space', () => subjectOf({ projectId: ' proj-1' })],
  ['a look-alike attempt id (Cyrillic a)', () => subjectOf({ attemptId: 'аtt-1' })],
  ['a chain', () => subjectOf({ kind: 'chain', attemptId: null, chainName: 'main', integrationHeadSha: HEAD })],
  ['a brief', () => subjectOf({ kind: 'brief', attemptId: null, briefPackageDigest: DIGEST, baseCommit: HEAD })],
  ['an attempt with a chain field also set', () => subjectOf({ chainName: 'main' })],
  ['an unknown kind', () => subjectOf({ kind: 'release' })],
  ['null', () => null],
  ['a string', () => 'att-1'],
  ['inherited ids only', inheritedSubject],
  ['an attempt id under an own __proto__ key', protoKeySubject],
];

describe('ReviewRequestAdapter.findLatestReceiptOfKind: the receipt subject (attempt path)', () => {
  it('finds a receipt that has no subject, with the same summary as before', async () => {
    expect(await latestPreMerge([receipt()])).toEqual({
      outcome: 'found',
      receipt: {
        receiptId: 'rr-1', requestId: null, kind: 'pre-merge', reviewerModel: 'example-provider/reviewer-1',
        candidateHeadSha: HEAD, verdict: 'passed', findings: [],
      },
    });
  });

  it('finds a receipt whose attempt subject restates the attempt and the project', async () => {
    const result = await latestPreMerge([receipt({ subject: subjectOf() })]);

    expect(result).toMatchObject({ outcome: 'found', receipt: { receiptId: 'rr-1', verdict: 'passed' } });
  });

  it.each(NOT_ABOUT)('answers receipt-mismatch for a passing receipt whose subject is %s', async (_label, make) => {
    expect(await latestPreMerge([receipt({ subject: make() })])).toEqual(MISMATCH);
  });

  it('answers receipt-mismatch for a subject that is an accessor, and never runs the getter', async () => {
    let reads = 0;
    const hostile = receipt();
    Object.defineProperty(hostile, 'subject', {
      enumerable: true,
      get() {
        reads += 1;
        return subjectOf();
      },
    });

    expect(await latestPreMerge([hostile])).toEqual(MISMATCH);
    expect(reads).toBe(0);
  });

  it('answers receipt-mismatch for a receipt whose own projectId is not the assessment projectId', async () => {
    expect(await latestPreMerge([receipt({ projectId: 'proj-OTHER' })])).toEqual(MISMATCH);
  });

  it('answers receipt-mismatch for a receipt that carries an own __proto__ key', async () => {
    const hostile = receipt();
    Object.defineProperty(hostile, '__proto__', { value: {}, enumerable: true, writable: true, configurable: true });

    expect(await latestPreMerge([hostile])).toEqual(MISMATCH);
  });

  it('a later pass about another attempt is not read as the verdict when an earlier fail is about the attempt', async () => {
    const result = await latestPreMerge([
      failing({ id: 'rr-about-fail', completedAtIso: EARLIER }),
      receipt({ id: 'rr-other-pass', completedAtIso: LATER, subject: OTHER_ATTEMPT }),
    ]);

    expect(result).toEqual(MISMATCH);
  });

  it('a later fail about another attempt after a pass about the attempt answers receipt-mismatch, never the pass', async () => {
    const result = await latestPreMerge([
      receipt({ id: 'rr-about-pass', completedAtIso: EARLIER }),
      failing({ id: 'rr-other-fail', completedAtIso: LATER, subject: OTHER_ATTEMPT }),
    ]);

    expect(result).toEqual(MISMATCH);
  });

  it('an earlier pass about another attempt does not hide a later fail about the attempt', async () => {
    const result = await latestPreMerge([
      receipt({ id: 'rr-other-pass', completedAtIso: EARLIER, subject: OTHER_ATTEMPT }),
      failing({ id: 'rr-about-fail', completedAtIso: LATER }),
    ]);

    expect(result).toMatchObject({ outcome: 'found', receipt: { receiptId: 'rr-about-fail', verdict: 'failed' } });
  });

  it('a later pass about the attempt is found after an earlier pass about another attempt', async () => {
    const result = await latestPreMerge([
      receipt({ id: 'rr-other-pass', completedAtIso: EARLIER, subject: OTHER_ATTEMPT }),
      receipt({ id: 'rr-about-pass', completedAtIso: LATER }),
    ]);

    expect(result).toMatchObject({ outcome: 'found', receipt: { receiptId: 'rr-about-pass', verdict: 'passed' } });
  });

  it('a receipt of another kind about another attempt does not change the answer for this kind', async () => {
    const result = await latestPreMerge([
      receipt({ id: 'rr-about-pass' }),
      receipt({ id: 'rr-other-code-review', kind: 'code-review', completedAtIso: LATER, subject: OTHER_ATTEMPT }),
    ]);

    expect(result).toMatchObject({ outcome: 'found', receipt: { receiptId: 'rr-about-pass' } });
  });
});

describe('ReviewRequestAdapter.findReviewReceipt: the receipt subject (attempt path)', () => {
  const find = (stored: ReviewReceiptRecord) =>
    adapterOver([stored]).findReviewReceipt({ attemptId: 'att-1', requestId: REQUEST_ID, candidateHeadSha: HEAD });

  it('finds the receipt of the request id when it has no subject', async () => {
    const result = await find(receipt({ requestId: REQUEST_ID }));

    expect(result).toMatchObject({ outcome: 'found', receipt: { receiptId: 'rr-1', requestId: REQUEST_ID, verdict: 'passed' } });
  });

  it('answers receipt-mismatch when the receipt of the request id is about another attempt', async () => {
    expect(await find(receipt({ requestId: REQUEST_ID, subject: OTHER_ATTEMPT }))).toEqual(MISMATCH);
  });

  it('answers receipt-mismatch when the receipt of the request id is about a chain', async () => {
    const chain = subjectOf({ kind: 'chain', attemptId: null, chainName: 'main', integrationHeadSha: HEAD });

    expect(await find(receipt({ requestId: REQUEST_ID, subject: chain }))).toEqual(MISMATCH);
  });
});

describe('ReviewRequestAdapter.requestReview: the receipt subject (attempt path)', () => {
  const request = (answered: ReviewReceiptRecord) =>
    new ReviewRequestAdapter({
      requestIndependentReview: async (): Promise<RequestIndependentReviewResult> => ({ outcome: 'reviewed', receipt: answered }),
    }).requestReview({
      requestId: REQUEST_ID, kind: 'pre-merge', attemptId: 'att-1', projectId: 'proj-1', policyRevision: 'policy-1',
      implementerModel: 'example-provider/implementer-1', reviewerModel: 'example-provider/reviewer-1',
      candidateHeadSha: HEAD,
    });

  it('returns the receipt when the answered receipt has no subject', async () => {
    const result = await request(receipt({ requestId: REQUEST_ID }));

    expect(result).toMatchObject({ outcome: 'receipt', receipt: { receiptId: 'rr-1', verdict: 'passed' } });
  });

  it('answers unknown receipt-mismatch when the answered receipt is about another attempt', async () => {
    const result = await request(receipt({ requestId: REQUEST_ID, subject: OTHER_ATTEMPT }));

    expect(result).toEqual({ outcome: 'unknown', reason: 'receipt-mismatch' });
  });

  it('answers unknown receipt-mismatch when the answered receipt names another project', async () => {
    const result = await request(receipt({ requestId: REQUEST_ID, projectId: 'proj-OTHER' }));

    expect(result).toEqual({ outcome: 'unknown', reason: 'receipt-mismatch' });
  });
});

async function reviewsOf(reviewReceipts: readonly ReviewReceiptRecord[]): Promise<readonly ReviewReceiptProjection[]> {
  const adapter = new AcceptanceReceiptReadAdapter({
    inspector: { inspectAcceptanceEvidence: async () => ({ outcome: 'found', assessment: assessmentOf(reviewReceipts) }) },
  });
  const read = await adapter.readReceiptsForHead('att-1', HEAD);
  if (read.outcome !== 'found') {
    throw new Error('expected a found read, got ' + read.outcome);
  }
  return read.review;
}

const resultsOf = async (reviewReceipts: readonly ReviewReceiptRecord[]): Promise<readonly string[]> =>
  (await reviewsOf(reviewReceipts)).map((review) => review.result);

const linkVerdictOf = async (reviewReceipts: readonly ReviewReceiptRecord[]) =>
  aggregateLinkReceipts([{ pullRequestNumber: 1, attemptId: 'att-1', receipts: await reviewsOf(reviewReceipts) }]);

describe('AcceptanceReceiptReadAdapter: the review receipt subject', () => {
  it('projects the stored result of a receipt that has no subject', async () => {
    expect(await resultsOf([receipt(), receipt({ id: 'rr-2', result: 'fail' })])).toEqual(['pass', 'fail']);
  });

  it('projects the stored result of a receipt whose attempt subject restates the attempt and the project', async () => {
    expect(await resultsOf([receipt({ subject: subjectOf() })])).toEqual(['pass']);
  });

  it('projects a pass about another attempt as unknown and keeps its kind and completion time', async () => {
    const [review] = await reviewsOf([receipt({ completedAtIso: LATER, subject: OTHER_ATTEMPT })]);

    expect({ kind: review?.kind, result: review?.result, completedAtIso: review?.completedAtIso }).toEqual({
      kind: 'pre-merge', result: 'unknown', completedAtIso: LATER,
    });
  });

  it.each(NOT_ABOUT)('projects a pass whose subject is %s as unknown', async (_label, make) => {
    expect(await resultsOf([receipt({ subject: make() })])).toEqual(['unknown']);
  });

  it('projects a subject that is an accessor as unknown and never runs the getter', async () => {
    let reads = 0;
    const hostile = receipt();
    Object.defineProperty(hostile, 'subject', {
      enumerable: true,
      get() {
        reads += 1;
        return subjectOf();
      },
    });

    expect(await resultsOf([hostile])).toEqual(['unknown']);
    expect(reads).toBe(0);
  });

  it('a link whose latest pre-merge receipt is a pass about another attempt aggregates to verdict-unknown', async () => {
    const aggregate = await linkVerdictOf([
      receipt({ id: 'rr-about-fail', result: 'fail', completedAtIso: EARLIER }),
      receipt({ id: 'rr-other-pass', completedAtIso: LATER, subject: OTHER_ATTEMPT }),
    ]);

    expect(aggregate).toEqual({ ok: false, reason: 'verdict-unknown' });
  });

  it('a link whose latest pre-merge receipt is a fail about the attempt still aggregates to a fail', async () => {
    const aggregate = await linkVerdictOf([
      receipt({ id: 'rr-other-pass', completedAtIso: EARLIER, subject: OTHER_ATTEMPT }),
      receipt({ id: 'rr-about-fail', result: 'fail', completedAtIso: LATER }),
    ]);

    expect(aggregate).toMatchObject({ ok: true, links: [{ result: 'fail' }] });
  });

  it('a link whose latest pre-merge receipt is a pass about the attempt still aggregates to a pass', async () => {
    const aggregate = await linkVerdictOf([
      receipt({ id: 'rr-other-pass', completedAtIso: EARLIER, subject: OTHER_ATTEMPT }),
      receipt({ id: 'rr-about-pass', completedAtIso: LATER }),
    ]);

    expect(aggregate).toMatchObject({ ok: true, links: [{ result: 'pass' }] });
  });
});
