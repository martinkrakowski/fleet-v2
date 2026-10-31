import { describe, expect, it } from 'vitest';
import type { ReviewReceiptRecord } from '../evidence-records.js';
import { REVIEW_KINDS } from '../evidence-records.js';
import {
  isFullyDispositioned,
  latestReceiptPerReviewer,
  reviewKindOf,
  satisfiesFullyDispositionedReviewPassGate,
  satisfiesReviewPassGate,
  tallyReviews,
} from '../review-selection.js';

function receipt(overrides?: Partial<ReviewReceiptRecord>): ReviewReceiptRecord {
  return {
    id: 'review-1',
    assessmentId: 'assessment-att-1',
    projectId: 'proj-1',
    attemptId: 'att-1',
    candidateHeadSha: '1111111111111111111111111111111111111111',
    reviewerModel: 'reviewer-model',
    implementerModel: 'implementer-model',
    readOnlyVerified: true,
    result: 'pass',
    findings: [],
    evidenceRef: 'evidence-ref-1',
    policyRevision: 'pol-1',
    completedAtIso: '2026-10-15T10:00:00Z',
    ...overrides,
  };
}

describe('review-selection (R1)', () => {
  it('an empty list gives an empty list and an all-zero tally', () => {
    expect(latestReceiptPerReviewer([])).toEqual([]);
    expect(tallyReviews([])).toEqual({ pass: 0, fail: 0, unknown: 0, disagreement: false });
  });

  it('the same reviewer fail then pass keeps the pass', () => {
    const latest = latestReceiptPerReviewer([
      receipt({ id: 'review-fail', result: 'fail' }),
      receipt({ id: 'review-pass', result: 'pass' }),
    ]);
    expect(latest.map((record) => record.id)).toEqual(['review-pass']);
  });

  it('pass then fail keeps the fail', () => {
    const latest = latestReceiptPerReviewer([
      receipt({ id: 'review-pass', result: 'pass' }),
      receipt({ id: 'review-fail', result: 'fail' }),
    ]);
    expect(latest.map((record) => record.id)).toEqual(['review-fail']);
  });

  it('two reviewers keep one each, ordered by their last index', () => {
    const latest = latestReceiptPerReviewer([
      receipt({ id: 'review-a-1', reviewerModel: 'reviewer-a', result: 'pass' }),
      receipt({ id: 'review-b-1', reviewerModel: 'reviewer-b', result: 'fail' }),
      receipt({ id: 'review-a-2', reviewerModel: 'reviewer-a', result: 'fail' }),
    ]);
    expect(latest.map((record) => record.id)).toEqual(['review-b-1', 'review-a-2']);
  });

  it('a reviewer name with surrounding spaces is the same reviewer', () => {
    const latest = latestReceiptPerReviewer([
      receipt({ id: 'review-fail', reviewerModel: 'reviewer-model', result: 'fail' }),
      receipt({ id: 'review-pass', reviewerModel: '  reviewer-model  ', result: 'pass' }),
    ]);
    expect(latest.map((record) => record.id)).toEqual(['review-pass']);
  });

  it('disagreement is true only when both pass and fail are present', () => {
    expect(tallyReviews([receipt({ result: 'pass' }), receipt({ result: 'fail' })])).toEqual({
      pass: 1,
      fail: 1,
      unknown: 0,
      disagreement: true,
    });
    expect(tallyReviews([receipt({ result: 'pass' }), receipt({ result: 'pass' })])).toEqual({
      pass: 2,
      fail: 0,
      unknown: 0,
      disagreement: false,
    });
  });

  it('unknown and pending count as unknown', () => {
    expect(tallyReviews([receipt({ result: 'unknown' }), receipt({ result: 'pending' })])).toEqual({
      pass: 0,
      fail: 0,
      unknown: 2,
      disagreement: false,
    });
  });
});

describe('reviewKindOf', () => {
  it('a receipt without a kind reads as code-review', () => {
    expect(reviewKindOf(receipt())).toBe('code-review');
  });

  it.each(REVIEW_KINDS)('a receipt with kind %s reads back unchanged', (kind) => {
    expect(reviewKindOf(receipt({ kind }))).toBe(kind);
  });
});

describe('satisfiesReviewPassGate', () => {
  it('only a passing receipt with kind absent or code-review satisfies the gate', () => {
    expect(satisfiesReviewPassGate(receipt({ result: 'pass' }))).toBe(true);
    expect(satisfiesReviewPassGate(receipt({ result: 'pass', kind: 'code-review' }))).toBe(true);
    expect(satisfiesReviewPassGate(receipt({ result: 'pass', kind: 'brief-check' }))).toBe(false);
    expect(satisfiesReviewPassGate(receipt({ result: 'pass', kind: 'pre-merge' }))).toBe(false);
    expect(satisfiesReviewPassGate(receipt({ result: 'fail', kind: 'code-review' }))).toBe(false);
    expect(satisfiesReviewPassGate(receipt({ result: 'unknown' }))).toBe(false);
  });
});

describe('isFullyDispositioned (KF-33b3)', () => {
  const outOfScope = new Set(['rr-1:f-1', 'rr-1:f-2']);
  const unresolved = new Set<string>();
  const finding = (findingId: string) => ({
    findingId,
    severity: 'major' as const,
    summary: `summary for ${findingId}`,
    filePath: 'src/a.ts',
    line: 12,
    state: 'unresolved' as const,
    dispositionReason: null,
    dispositionEvidenceRef: null,
  });

  it('is false for pass and unknown receipts, whatever the dispositions', () => {
    expect(
      isFullyDispositioned(receipt({ result: 'pass', findings: [finding('rr-1:f-1')] }), outOfScope, unresolved),
    ).toBe(false);
    expect(
      isFullyDispositioned(receipt({ result: 'unknown', findings: [finding('rr-1:f-1')] }), outOfScope, unresolved),
    ).toBe(false);
  });

  it('is false for a fail receipt with zero findings', () => {
    expect(isFullyDispositioned(receipt({ result: 'fail', findings: [] }), outOfScope, unresolved)).toBe(false);
  });

  it('is true for a fail receipt whose every finding is out-of-scope resolved and not unresolved', () => {
    expect(
      isFullyDispositioned(
        receipt({ result: 'fail', findings: [finding('rr-1:f-1'), finding('rr-1:f-2')] }),
        outOfScope,
        unresolved,
      ),
    ).toBe(true);
  });

  it('is false when any finding is unresolved', () => {
    expect(
      isFullyDispositioned(
        receipt({ result: 'fail', findings: [finding('rr-1:f-1'), finding('rr-1:f-2')] }),
        outOfScope,
        new Set(['rr-1:f-2']),
      ),
    ).toBe(false);
  });

  it('is false when a finding is not in the out-of-scope-resolved set, even when it is otherwise resolved (fixed/refuted)', () => {
    // The set is built by the caller from out-of-scope dispositions only, so a
    // finding resolved by fixed/refuted never appears in it (KF-33b3 S1).
    const noOutOfScope = new Set<string>();
    expect(
      isFullyDispositioned(receipt({ result: 'fail', findings: [finding('rr-1:f-1')] }), noOutOfScope, unresolved),
    ).toBe(false);
  });

  it('is false when only some findings are in the out-of-scope-resolved set (mixed)', () => {
    const mixed = new Set(['rr-1:f-1']);
    expect(
      isFullyDispositioned(
        receipt({ result: 'fail', findings: [finding('rr-1:f-1'), finding('rr-1:f-2')] }),
        mixed,
        unresolved,
      ),
    ).toBe(false);
  });
});

describe('satisfiesFullyDispositionedReviewPassGate (KF-33b3)', () => {
  const outOfScope = new Set(['rr-1:f-1']);
  const unresolved = new Set<string>();
  const finding = { findingId: 'rr-1:f-1', severity: 'major' as const, summary: 's', filePath: 'src/a.ts', line: 1, state: 'unresolved' as const, dispositionReason: null, dispositionEvidenceRef: null };

  it('a fully dispositioned failing code-review satisfies the gate like a pass', () => {
    expect(
      satisfiesFullyDispositionedReviewPassGate(
        receipt({ result: 'fail', kind: 'code-review', findings: [finding] }),
        outOfScope,
        unresolved,
      ),
    ).toBe(true);
    expect(
      satisfiesFullyDispositionedReviewPassGate(
        receipt({ result: 'fail', findings: [finding] }),
        outOfScope,
        unresolved,
      ),
    ).toBe(true);
  });

  it('a fully dispositioned failing brief-check (or any non-code-review kind) never satisfies the gate', () => {
    expect(
      satisfiesFullyDispositionedReviewPassGate(
        receipt({ result: 'fail', kind: 'brief-check', findings: [finding] }),
        outOfScope,
        unresolved,
      ),
    ).toBe(false);
    expect(
      satisfiesFullyDispositionedReviewPassGate(
        receipt({ result: 'fail', kind: 'pre-merge', findings: [finding] }),
        outOfScope,
        unresolved,
      ),
    ).toBe(false);
  });

  it('a failing code-review that is not fully dispositioned never satisfies the gate', () => {
    expect(
      satisfiesFullyDispositionedReviewPassGate(
        receipt({ result: 'fail', kind: 'code-review', findings: [finding] }),
        new Set<string>(),
        unresolved,
      ),
    ).toBe(false);
    expect(
      satisfiesFullyDispositionedReviewPassGate(
        receipt({ result: 'fail', kind: 'code-review', findings: [] }),
        outOfScope,
        unresolved,
      ),
    ).toBe(false);
  });
});

describe('review kind selection', () => {
  it('different kinds from the same reviewer are kept separately, in recording order', () => {
    const latest = latestReceiptPerReviewer([
      receipt({ id: 'review-brief', kind: 'brief-check', result: 'pass' }),
      receipt({ id: 'review-code', result: 'fail' }),
    ]);
    expect(latest.map((record) => record.id)).toEqual(['review-brief', 'review-code']);
    expect(tallyReviews(latest)).toEqual({
      pass: 1,
      fail: 1,
      unknown: 0,
      disagreement: true,
    });
  });

  it('an untyped receipt and a later explicit code-review receipt collapse to the later one', () => {
    const latest = latestReceiptPerReviewer([
      receipt({ id: 'review-untyped', result: 'pass' }),
      receipt({ id: 'review-code', kind: 'code-review', result: 'fail' }),
    ]);
    expect(latest.map((record) => record.id)).toEqual(['review-code']);
  });
});
