import { describe, expect, it } from 'vitest';
import type { ReceiptSubject, ReviewReceiptRecord } from '../evidence-records.js';
import { REVIEW_KINDS, assessmentIdForBrief, attemptIdForBrief } from '../evidence-records.js';
import { ReviewReceipt } from '../entities/ReviewReceipt.js';
import {
  decideReviewReceiptOutcome,
  isAttemptReceiptSubject,
  isFullyDispositioned,
  latestReceiptPerReviewer,
  reviewKindOf,
  satisfiesFullyDispositionedReviewPassGate,
  satisfiesReviewPassGate,
  tallyReviews,
  ZERO_FINDING_PASS_DIFF_LINE_THRESHOLD,
} from '../review-selection.js';
import type { ReviewDiffFacts } from '../review-selection.js';

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
    const blockingFinding = {
      findingId: 'rr-1:f-1',
      severity: 'major' as const,
      summary: 's',
      filePath: 'src/a.ts',
      line: 1,
      state: 'unresolved' as const,
      dispositionReason: null,
      dispositionEvidenceRef: null,
    };
    expect(
      tallyReviews([receipt({ result: 'pass' }), receipt({ result: 'fail', findings: [blockingFinding] })]),
    ).toEqual({
      pass: 1,
      fail: 1,
      unknown: 0,
      disagreement: true,
    });
    // RV3: a fail receipt with zero findings is an unparseable verdict and
    // tallies as unknown, never as a fail.
    expect(tallyReviews([receipt({ result: 'pass' }), receipt({ result: 'fail' })])).toEqual({
      pass: 1,
      fail: 0,
      unknown: 1,
      disagreement: false,
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
      receipt({
        id: 'review-code',
        result: 'fail',
        findings: [
          {
            findingId: 'rr-1:f-1',
            severity: 'major',
            summary: 's',
            filePath: 'src/a.ts',
            line: 1,
            state: 'unresolved',
            dispositionReason: null,
            dispositionEvidenceRef: null,
          },
        ],
      }),
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

describe('decideReviewReceiptOutcome diff-facts gate (U4a / D3)', () => {
  const domainFile = 'packages/evidence-and-acceptance/src/domain/review-selection.ts';
  const domainFileDotSlash = './packages/work-execution/src/domain/lane-diff-check.ts';

  it('a large domain diff with a zero-finding pass reads unknown', () => {
    for (const changedLines of [200, 448]) {
      for (const file of [domainFile, domainFileDotSlash]) {
        expect(decideReviewReceiptOutcome(receipt(), undefined, undefined, { changedLines, files: [file] })).toEqual({
          outcome: 'unknown',
          unknownReason: 'unparseable-verdict',
        });
      }
    }
  });

  it('a large diff touching protected paths with a zero-finding pass reads unknown', () => {
    for (const file of [
      'scripts/lane-diff-check.sh',
      '.github/workflows/ci.yml',
      'AGENTS.md',
      'packages/evidence-and-acceptance/package.json',
      'node_modules/.claude/package.json',
    ]) {
      expect(decideReviewReceiptOutcome(receipt(), undefined, undefined, { changedLines: 448, files: [file] })).toEqual(
        { outcome: 'unknown', unknownReason: 'unparseable-verdict' },
      );
    }
  });

  it('the same large domain diff with one minor finding still reads pass', () => {
    const minor = {
      findingId: 'rr-1:f-1',
      severity: 'minor' as const,
      summary: 's',
      filePath: domainFile,
      line: 1,
      state: 'unresolved' as const,
      dispositionReason: null,
      dispositionEvidenceRef: null,
    };
    expect(
      decideReviewReceiptOutcome(receipt({ findings: [minor] }), undefined, undefined, {
        changedLines: 448,
        files: [domainFile],
      }),
    ).toEqual({ outcome: 'pass', carriedMinors: [minor] });
    const nit = { ...minor, severity: 'nit' as const };
    expect(
      decideReviewReceiptOutcome(receipt({ findings: [nit] }), undefined, undefined, {
        changedLines: 448,
        files: [domainFile],
      }),
    ).toEqual({ outcome: 'pass', carriedMinors: [nit] });
  });

  it('a small diff with a zero-finding pass reads pass', () => {
    expect(ZERO_FINDING_PASS_DIFF_LINE_THRESHOLD).toBe(200);
    for (const changedLines of [199, 0]) {
      for (const file of [domainFile, 'scripts/lane-diff-check.sh']) {
        expect(decideReviewReceiptOutcome(receipt(), undefined, undefined, { changedLines, files: [file] })).toEqual({
          outcome: 'pass',
          carriedMinors: [],
        });
      }
    }
  });

  it('a large diff touching neither domain nor a protected path reads pass', () => {
    expect(
      decideReviewReceiptOutcome(receipt(), undefined, undefined, {
        changedLines: 500,
        files: [
          'packages/work-execution/src/infrastructure/git-adapter.ts',
          'packages/work-execution/src/application/run-lane.ts',
          'apps/web/src/app/page.tsx',
          'docs/architecture.md',
          'packages/evidence-and-acceptance/src/domain/__tests__/review-selection.test.ts',
          'node_modules/pkg/package.json',
        ],
      }),
    ).toEqual({ outcome: 'pass', carriedMinors: [] });
  });

  it('omitting diffFacts reproduces today\u2019s result on every existing case', () => {
    const minor = {
      findingId: 'rr-1:f-1',
      severity: 'minor' as const,
      summary: 's',
      filePath: 'src/a.ts',
      line: 1,
      state: 'unresolved' as const,
      dispositionReason: null,
      dispositionEvidenceRef: null,
    };
    const blocker = { ...minor, severity: 'major' as const };
    expect(decideReviewReceiptOutcome(receipt())).toEqual({ outcome: 'pass', carriedMinors: [] });
    expect(decideReviewReceiptOutcome(receipt({ findings: [minor] }))).toEqual({
      outcome: 'pass',
      carriedMinors: [minor],
    });
    expect(decideReviewReceiptOutcome(receipt({ findings: [minor] }), new Set(['rr-1:f-1']))).toEqual({
      outcome: 'pass',
      carriedMinors: [],
    });
    expect(decideReviewReceiptOutcome(receipt({ result: 'fail', findings: [blocker] }))).toEqual({ outcome: 'fail' });
    expect(
      decideReviewReceiptOutcome(receipt({ result: 'fail', findings: [blocker] }), new Set(['rr-1:f-1']), new Set<string>()),
    ).toEqual({ outcome: 'pass', carriedMinors: [] });
    expect(decideReviewReceiptOutcome(receipt({ result: 'fail' }))).toEqual({
      outcome: 'unknown',
      unknownReason: 'unparseable-verdict',
    });
    expect(decideReviewReceiptOutcome(receipt({ result: 'fail', unknownReason: 'no-findings-on-fail' }))).toEqual({
      outcome: 'unknown',
      unknownReason: 'no-findings-on-fail',
    });
    expect(
      decideReviewReceiptOutcome(receipt({ result: 'fail', unknownReason: 'no-findings-on-fail' }), undefined, undefined, {
        changedLines: 448,
        files: [domainFile],
      }),
    ).toEqual({ outcome: 'unknown', unknownReason: 'no-findings-on-fail' });
    expect(decideReviewReceiptOutcome(receipt({ result: 'unknown' }))).toEqual({
      outcome: 'unknown',
      unknownReason: 'unparseable-verdict',
    });
    expect(decideReviewReceiptOutcome(receipt({ result: 'pending' }))).toEqual({
      outcome: 'unknown',
      unknownReason: 'unparseable-verdict',
    });
    expect(decideReviewReceiptOutcome(receipt({ readOnlyVerified: false }))).toEqual({
      outcome: 'unknown',
      unknownReason: 'unparseable-verdict',
    });
    expect(decideReviewReceiptOutcome('not-a-receipt')).toEqual({
      outcome: 'unknown',
      unknownReason: 'unparseable-verdict',
    });
  });

  it('hostile diffFacts values fail closed to today\u2019s behaviour rather than throwing', () => {
    class Hostile {
      get changedLines(): number {
        throw new Error('boom');
      }
    }
    const throwingGetter = (key: string, value: unknown): ReviewDiffFacts =>
      ({ get [key]() {
        throw new Error('boom');
      }, [key === 'changedLines' ? 'files' : 'changedLines']: value }) as unknown as ReviewDiffFacts;
    const hostiles: readonly unknown[] = [
      null,
      42,
      'bad',
      true,
      [],
      new Hostile(),
      { changedLines: -1, files: [domainFile] },
      { changedLines: -200, files: [domainFile] },
      { changedLines: 200.5, files: [domainFile] },
      { changedLines: Number.NaN, files: [domainFile] },
      { changedLines: Number.POSITIVE_INFINITY, files: [domainFile] },
      { changedLines: '448', files: [domainFile] },
      { changedLines: 448, files: domainFile },
      { changedLines: 448, files: { 0: domainFile, length: 1 } },
      { changedLines: 448, files: new Array(2) },
      { changedLines: 448, files: [domainFile, 7] },
      throwingGetter('changedLines', [domainFile]),
      throwingGetter('files', 448),
      (() => {
        const files: string[] = [];
        Object.defineProperty(files, 0, {
          enumerable: true,
          get(): string {
            throw new Error('boom');
          },
        });
        files.length = 1;
        return { changedLines: 448, files };
      })(),
      new Proxy(
        { changedLines: 448, files: [domainFile] },
        {
          getPrototypeOf(): never {
            throw new Error('boom');
          },
          getOwnPropertyDescriptor(): never {
            throw new Error('boom');
          },
        },
      ),
    ];
    for (const facts of hostiles) {
      expect(() =>
        decideReviewReceiptOutcome(receipt(), undefined, undefined, facts as unknown as ReviewDiffFacts),
      ).not.toThrow();
      expect(decideReviewReceiptOutcome(receipt(), undefined, undefined, facts as unknown as ReviewDiffFacts)).toEqual({
        outcome: 'pass',
        carriedMinors: [],
      });
      const blocking = {
        findingId: 'rr-1:f-1',
        severity: 'major' as const,
        summary: 's',
        filePath: 'src/a.ts',
        line: 1,
        state: 'unresolved' as const,
        dispositionReason: null,
        dispositionEvidenceRef: null,
      };
      expect(
        decideReviewReceiptOutcome(receipt({ result: 'fail', findings: [blocking] }), undefined, undefined, facts as unknown as ReviewDiffFacts),
      ).toEqual({ outcome: 'fail' });
    }
  });
});

describe('isAttemptReceiptSubject', () => {
  const DIGEST = 'd'.repeat(64);
  const BASE = 'a'.repeat(40);

  function briefSubject(): ReceiptSubject {
    return {
      kind: 'brief', projectId: 'proj-1', attemptId: null, chainName: null, integrationHeadSha: null,
      briefPackageDigest: DIGEST, baseCommit: BASE,
    };
  }

  function chainSubject(): ReceiptSubject {
    return {
      kind: 'chain', projectId: 'proj-1', attemptId: null, chainName: 'main', integrationHeadSha: BASE,
      briefPackageDigest: null, baseCommit: null,
    };
  }

  it('returns false for null, undefined, primitives and arrays', () => {
    for (const value of [null, undefined, 42, 'receipt', true, Symbol.iterator, [], [receipt()]]) {
      expect(isAttemptReceiptSubject(value)).toBe(false);
    }
  });

  it('returns false when a getter on subject or attemptId throws or is an accessor', () => {
    for (const key of ['subject', 'attemptId']) {
      const throwing = receipt();
      Object.defineProperty(throwing, key, { get() { throw new Error('boom'); }, enumerable: true });
      expect(isAttemptReceiptSubject(throwing)).toBe(false);
      const accessorOnly: Record<string, unknown> = { ...receipt() };
      Object.defineProperty(accessorOnly, key, { get: () => undefined, enumerable: true });
      expect(isAttemptReceiptSubject(accessorOnly)).toBe(false);
    }
  });

  it('returns false for a Proxy that throws on getOwnPropertyDescriptor, without throwing itself', () => {
    const hostile = new Proxy(receipt(), {
      getOwnPropertyDescriptor(): never {
        throw new Error('boom');
      },
    });
    expect(isAttemptReceiptSubject(hostile)).toBe(false);
  });

  it('ignores prototype-polluting keys: a JSON-parsed __proto__ with no own subject is a legacy attempt receipt, and one with a non-attempt subject is not', () => {
    expect(isAttemptReceiptSubject(JSON.parse('{"attemptId":"att-1","__proto__":{"kind":"chain"}}'))).toBe(true);
    expect(
      isAttemptReceiptSubject(JSON.parse('{"attemptId":"att-1","__proto__":{"kind":"chain"},"subject":{"kind":"chain","projectId":"proj-1","attemptId":null,"chainName":"main","integrationHeadSha":"' + 'a'.repeat(40) + '","briefPackageDigest":null,"baseCommit":null}}')),
    ).toBe(false);
  });

  it('returns false for a chain: or brief: attemptId, even without a subject', () => {
    expect(isAttemptReceiptSubject(receipt({ attemptId: 'chain:proj-1:main' }))).toBe(false);
    expect(isAttemptReceiptSubject(receipt({ attemptId: attemptIdForBrief('proj-1', DIGEST) }))).toBe(false);
  });

  it('returns false for brief and chain subjects, true for an explicit attempt subject', () => {
    expect(isAttemptReceiptSubject(receipt({ subject: briefSubject() }))).toBe(false);
    expect(isAttemptReceiptSubject(receipt({ subject: chainSubject() }))).toBe(false);
    expect(
      isAttemptReceiptSubject(
        receipt({
          subject: { kind: 'attempt', projectId: 'proj-1', attemptId: 'att-1', chainName: null, integrationHeadSha: null, briefPackageDigest: null, baseCommit: null },
        }),
      ),
    ).toBe(true);
  });

  it('returns true for a legacy receipt without a subject and for a hostile object with prototype-polluting own keys and an attempt subject', () => {
    expect(isAttemptReceiptSubject(receipt())).toBe(true);
    expect(isAttemptReceiptSubject({ attemptId: 'att-1', __proto__: null })).toBe(true);
  });
});

describe('attempt isolation of the review pass gates', () => {
  const DIGEST = 'd'.repeat(64);
  const BASE = 'a'.repeat(40);
  const finding = {
    findingId: 'rr-1:f-1',
    severity: 'major' as const,
    summary: 's',
    filePath: 'src/a.ts',
    line: 1,
    state: 'out-of-scope' as const,
    dispositionReason: 'not in scope',
    dispositionEvidenceRef: 'ref-d',
  };

  function briefSubject(): ReceiptSubject {
    return {
      kind: 'brief', projectId: 'proj-1', attemptId: null, chainName: null, integrationHeadSha: null,
      briefPackageDigest: DIGEST, baseCommit: BASE,
    };
  }

  it('a passing brief-verify receipt never satisfies either gate', () => {
    const briefVerify = receipt({ kind: 'brief-verify', result: 'pass', attemptId: attemptIdForBrief('proj-1', DIGEST), subject: briefSubject() });
    expect(satisfiesReviewPassGate(briefVerify)).toBe(false);
    expect(satisfiesFullyDispositionedReviewPassGate(briefVerify, new Set(), new Set())).toBe(false);
  });

  it('a passing chain receipt never satisfies either gate', () => {
    const chain = receipt({
      kind: 'code-review',
      result: 'pass',
      attemptId: 'chain:proj-1:main',
      subject: { kind: 'chain', projectId: 'proj-1', attemptId: null, chainName: 'main', integrationHeadSha: BASE, briefPackageDigest: null, baseCommit: null },
    });
    expect(satisfiesReviewPassGate(chain)).toBe(false);
    expect(satisfiesFullyDispositionedReviewPassGate(chain, new Set(), new Set())).toBe(false);
  });

  it('a code-review carrying a brief subject never satisfies either gate, even fully dispositioned', () => {
    const briefSubjectReceipt = receipt({ kind: 'code-review', result: 'fail', findings: [finding], subject: briefSubject() });
    expect(satisfiesReviewPassGate(briefSubjectReceipt)).toBe(false);
    expect(
      satisfiesFullyDispositionedReviewPassGate(briefSubjectReceipt, new Set([finding.findingId]), new Set()),
    ).toBe(false);
  });

  it('a code-review with a subject that is not an attempt is never a pass, keeping the legacy attempt receipt passing', () => {
    expect(satisfiesReviewPassGate(receipt({ result: 'pass' }))).toBe(true);
    expect(satisfiesReviewPassGate(receipt({ result: 'pass', subject: briefSubject() }))).toBe(false);
  });
});

describe('ReviewReceipt brief-verify invariants', () => {
  const DIGEST = 'd'.repeat(64);
  const BASE = 'a'.repeat(40);

  function briefVerifyProps(overrides: Partial<Parameters<typeof ReviewReceipt.create>[0]> = {}) {
    return {
      id: 'rr-1',
      assessmentId: assessmentIdForBrief('proj-1', DIGEST),
      projectId: 'proj-1',
      attemptId: attemptIdForBrief('proj-1', DIGEST),
      candidateHeadSha: BASE,
      reviewerModel: 'seat-a/reviewer',
      implementerModel: 'seat-b/implementer',
      readOnlyVerified: true,
      result: 'pass' as const,
      findings: [],
      evidenceRef: 'ref-1',
      policyRevision: 'pol-1',
      completedAtIso: '2026-10-15T12:00:00.000Z',
      kind: 'brief-verify' as const,
      subject: {
        kind: 'brief' as const, projectId: 'proj-1', attemptId: null, chainName: null, integrationHeadSha: null,
        briefPackageDigest: DIGEST, baseCommit: BASE,
      },
      ...overrides,
    };
  }

  it('accepts a valid brief-verify receipt carrying a brief subject', () => {
    const created = ReviewReceipt.create(briefVerifyProps());
    expect(created.success).toBe(true);
  });

  type BriefVerifyOverrides = Partial<Parameters<typeof ReviewReceipt.create>[0]>;
  const refusals: readonly [string, BriefVerifyOverrides, string][] = [
    ['brief-verify without a brief subject', { subject: undefined }, 'requires a brief subject'],
    ['a brief subject under a wrong kind', { kind: 'code-review' }, 'requires the brief-verify kind'],
    ['an invalid projectId in the brief subject', { subject: { kind: 'brief', projectId: 'proj/1', attemptId: null, chainName: null, integrationHeadSha: null, briefPackageDigest: 'd'.repeat(64), baseCommit: 'a'.repeat(40) } }, 'invalid projectId'],
    ['an invalid briefPackageDigest in the brief subject', { subject: { kind: 'brief', projectId: 'proj-1', attemptId: null, chainName: null, integrationHeadSha: null, briefPackageDigest: 'd'.repeat(63), baseCommit: 'a'.repeat(40) } }, 'invalid briefPackageDigest'],
    ['an invalid baseCommit in the brief subject', { subject: { kind: 'brief', projectId: 'proj-1', attemptId: null, chainName: null, integrationHeadSha: null, briefPackageDigest: 'd'.repeat(64), baseCommit: 'zzz' } }, 'invalid baseCommit'],
    ['a projectId that disagrees with the subject', { projectId: 'proj-2' }, 'projectId that disagrees'],
    ['a candidateHeadSha that disagrees with the subject baseCommit', { candidateHeadSha: 'b'.repeat(40) }, 'candidateHeadSha that disagrees'],
    ['an attemptId that is not the brief attempt id', { attemptId: 'att-1' }, 'attemptId that is not the brief attempt id'],
    ['an assessmentId that is not the brief assessment id', { assessmentId: 'asm-1' }, 'assessmentId that is not the brief assessment id'],
  ];
  it.each(refusals)('refuses %s with a fixed error, never a throw', (_title, overrides, messagePart) => {
    const created = ReviewReceipt.create(briefVerifyProps(overrides));
    expect(created.success).toBe(false);
    expect(created.error).toBeInstanceOf(Error);
    expect(created.error?.message).toContain(messagePart);
  });

  it('a brief-verify attemptId mirrors attemptIdForBrief and its assessment mirrors assessmentIdForBrief', () => {
    expect(attemptIdForBrief('proj-1', DIGEST)).toBe(`brief:proj-1:${DIGEST}`);
    expect(assessmentIdForBrief('proj-1', DIGEST)).toBe(assessmentIdForBrief('proj-1', DIGEST));
    expect(assessmentIdForBrief('proj-1', DIGEST)).not.toBe(attemptIdForBrief('proj-1', DIGEST));
  });
});
