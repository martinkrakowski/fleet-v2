import { describe, expect, it } from 'vitest';

import type {
  EvidenceAssessmentRecord,
  FindingDispositionRecord,
  ReceiptSubject,
  ReviewFindingRecord,
  ReviewReceiptRecord,
} from '../../../domain/evidence-records.js';
import { assessmentIdForBrief } from '../../../domain/evidence-records.js';
import type { EvidenceAssessmentRepositoryPort } from '../../ports/out/EvidenceAssessmentRepositoryPort.out-port.js';
import type { AttemptOwnerDecisionPort } from '../../ports/out/AttemptOwnerDecisionPort.out-port.js';
import { AssessHeadAcceptanceUseCase } from '../AssessHeadAcceptanceUseCase.use-case.js';

const HEAD = '1111111111111111111111111111111111111111';
const OTHER_HEAD = '2222222222222222222222222222222222222222';
const NO_REVIEW_PASSED = 'no read-only independent review passed for this candidate head';
const INVALID_RECEIPT_REASON =
  'Assessment record is invalid and cannot be assessed: EvidenceAssessment contains an invalid review receipt';

const NO_OWNER_DECISIONS: AttemptOwnerDecisionPort = {
  async readAttemptOwnerDecisionReferences() {
    return { outcome: 'recorded', ownerDecisionReferences: [] };
  },
};

function subject(overrides: Partial<ReceiptSubject>): ReceiptSubject {
  return {
    kind: 'attempt', projectId: 'proj-1', attemptId: null, chainName: null, integrationHeadSha: null,
    briefPackageDigest: null, baseCommit: null, ...overrides,
  };
}

const CHAIN_SUBJECT = subject({ kind: 'chain', chainName: 'main', integrationHeadSha: HEAD });
const OTHER_ATTEMPT_SUBJECT = subject({ attemptId: 'att-OTHER' });
const OTHER_PROJECT_SUBJECT = subject({ projectId: 'proj-2', attemptId: 'att-1' });
const BRIEF_SUBJECT = subject({ kind: 'brief', briefPackageDigest: 'd'.repeat(64), baseCommit: HEAD });
const OWN_ATTEMPT_SUBJECT = subject({ attemptId: 'att-1' });
const zeroFindingFail = (model: string, id: string): string =>
  `review by '${model}' failed for this head with no findings (unparseable-verdict, receipt '${id}')`;

function receipt(id: string, reviewerModel: string, overrides: Partial<ReviewReceiptRecord> = {}): ReviewReceiptRecord {
  return {
    id,
    assessmentId: 'asm-1',
    projectId: 'proj-1',
    attemptId: 'att-1',
    candidateHeadSha: HEAD,
    reviewerModel,
    implementerModel: 'seat-i/implementer',
    readOnlyVerified: true,
    result: 'pass',
    findings: [],
    evidenceRef: `ref-${id}`,
    policyRevision: 'pol-1',
    completedAtIso: '2026-11-16T10:00:00.000Z',
    ...overrides,
  };
}

function assessment(
  reviewReceipts: readonly ReviewReceiptRecord[],
  overrides: Partial<EvidenceAssessmentRecord> = {},
): EvidenceAssessmentRecord {
  return {
    id: 'asm-1',
    projectId: 'proj-1',
    attemptId: 'att-1',
    candidateHeadSha: HEAD,
    policyRevision: 'pol-1',
    implementerModel: 'seat-i/implementer',
    requiredChecks: [],
    state: 'pending',
    verificationReceipts: [],
    reviewReceipts,
    findingDispositions: [],
    acceptanceReceiptId: null,
    blockers: [],
    revision: 3,
    updatedAtIso: '2026-11-16T10:00:00.000Z',
    ...overrides,
  };
}

function wire(stored: EvidenceAssessmentRecord) {
  const saved: EvidenceAssessmentRecord[] = [];
  const repo: EvidenceAssessmentRepositoryPort = {
    async findAssessmentById(id) {
      return id === stored.id ? stored : null;
    },
    async findAssessmentByHead() {
      return null;
    },
    async saveAssessment(record) {
      saved.push(record);
    },
  };
  const useCase = new AssessHeadAcceptanceUseCase({ repo, attemptOwnerDecisionPort: NO_OWNER_DECISIONS });
  const request = { assessmentId: 'asm-1', candidateHeadSha: HEAD, policyRevision: 'pol-1' };
  return { saved, useCase, request };
}

async function blockersOf(reviewReceipts: readonly ReviewReceiptRecord[], overrides: Partial<EvidenceAssessmentRecord> = {}) {
  const { useCase, request } = wire(assessment(reviewReceipts, overrides));
  const full = await useCase.assessHeadAcceptance(request);
  const receipts = await useCase.assessHeadReceipts(request);
  return {
    full: full.outcome === 'blocked' ? full.blockers : full.outcome,
    receipts: receipts.outcome === 'blocked' ? receipts.blockers : receipts.outcome,
    tally: full.outcome === 'blocked' ? full.reviewTally : undefined,
  };
}

describe('a receipt about another subject is not evidence for this assessment (CO18a7a)', () => {
  it('a lone passing code-review whose attempt subject names another attempt never accepts', async () => {
    const result = await blockersOf([receipt('a1', 'seat-a/reviewer', { subject: OTHER_ATTEMPT_SUBJECT })]);
    expect(result.full).toEqual([NO_REVIEW_PASSED]);
    expect(result.receipts).toEqual([NO_REVIEW_PASSED]);
  });

  it('a lone passing code-review whose attempt subject names another project never accepts', async () => {
    const result = await blockersOf([receipt('a1', 'seat-a/reviewer', { subject: OTHER_PROJECT_SUBJECT })]);
    expect(result.full).toEqual([NO_REVIEW_PASSED]);
    expect(result.receipts).toEqual([NO_REVIEW_PASSED]);
  });

  it('a zero-finding fail stays a blocker when the same reviewer later passes with a chain subject', async () => {
    const result = await blockersOf([
      receipt('a1', 'seat-a/reviewer'),
      receipt('b1', 'seat-b/reviewer', { result: 'fail' }),
      receipt('b2', 'seat-b/reviewer', { subject: CHAIN_SUBJECT }),
    ]);
    const expected = [zeroFindingFail('seat-b/reviewer', 'b1')];
    expect(result.full).toEqual(expected);
    expect(result.receipts).toEqual(expected);
    expect(result.tally).toEqual({ pass: 1, fail: 0, unknown: 1, disagreement: false });
  });

  it('a refuted major fail stays a blocker when the same reviewer later passes with another attempt as subject', async () => {
    const major: ReviewFindingRecord = {
      findingId: 'b1#1', severity: 'major', summary: 'wrong bound', filePath: 'src/a.ts', line: 3,
      state: 'unresolved', dispositionReason: null, dispositionEvidenceRef: null,
    };
    const refuted: FindingDispositionRecord = {
      id: 'disp-1', assessmentId: 'asm-1', findingId: 'b1#1', candidateHeadSha: HEAD, state: 'refuted',
      reason: 'not reachable', evidenceRef: 'ref-disp-1', recordedBy: 'operator', recordedAtIso: '2026-11-16T10:05:00.000Z',
    };
    const result = await blockersOf(
      [
        receipt('a1', 'seat-a/reviewer'),
        receipt('b1', 'seat-b/reviewer', { result: 'fail', findings: [major] }),
        receipt('b2', 'seat-b/reviewer', { subject: OTHER_ATTEMPT_SUBJECT }),
      ],
      { findingDispositions: [refuted] },
    );
    const expected = ["review by 'seat-b/reviewer' failed for this head (receipt 'b1')"];
    expect(result.full).toEqual(expected);
    expect(result.receipts).toEqual(expected);
    expect(result.tally).toEqual({ pass: 1, fail: 1, unknown: 0, disagreement: true });
  });

  it('a zero-finding fail about another subject still blocks after the same reviewer passed, as it did before', async () => {
    const result = await blockersOf([
      receipt('a1', 'seat-a/reviewer'),
      receipt('a2', 'seat-a/reviewer', { result: 'fail', subject: CHAIN_SUBJECT }),
    ]);
    expect(result.full).toEqual([zeroFindingFail('seat-a/reviewer', 'a2')]);
    expect(result.receipts).toEqual([zeroFindingFail('seat-a/reviewer', 'a2')]);
  });

  it('a zero-finding fail about another subject by a second reviewer still blocks beside a counted pass', async () => {
    const result = await blockersOf([
      receipt('a1', 'seat-a/reviewer'),
      receipt('b1', 'seat-b/reviewer', { result: 'fail', subject: OTHER_ATTEMPT_SUBJECT }),
    ]);
    expect(result.full).toEqual([zeroFindingFail('seat-b/reviewer', 'b1')]);
    expect(result.receipts).toEqual([zeroFindingFail('seat-b/reviewer', 'b1')]);
    expect(result.tally).toEqual({ pass: 1, fail: 0, unknown: 0, disagreement: false });
  });

  it("a pass about another subject that follows the same reviewer's counted pass never accepts", async () => {
    const result = await blockersOf([
      receipt('a1', 'seat-a/reviewer'),
      receipt('a2', 'seat-a/reviewer', { subject: CHAIN_SUBJECT }),
    ]);
    expect(result.full).toEqual([NO_REVIEW_PASSED]);
    expect(result.receipts).toEqual([NO_REVIEW_PASSED]);
  });

  it('a later pass about this assessment by the same reviewer accepts after a fail about another subject', async () => {
    const result = await blockersOf([
      receipt('a1', 'seat-a/reviewer'),
      receipt('a2', 'seat-a/reviewer', { result: 'fail', subject: CHAIN_SUBJECT }),
      receipt('a3', 'seat-a/reviewer'),
    ]);
    expect(result.full).toBe('accepted');
    expect(result.receipts).toBe('receipts-passed');
  });

  it('a lone code-review pass without a subject still accepts', async () => {
    const result = await blockersOf([receipt('a1', 'seat-a/reviewer')]);
    expect(result.full).toBe('accepted');
    expect(result.receipts).toBe('receipts-passed');
  });

  it('a lone code-review pass whose attempt subject names this attempt and project still accepts', async () => {
    const result = await blockersOf([receipt('a1', 'seat-a/reviewer', { subject: OWN_ATTEMPT_SUBJECT })]);
    expect(result.full).toBe('accepted');
    expect(result.receipts).toBe('receipts-passed');
  });

  it("a chain assessment still counts its own chain receipts: the reviewer's later pre-merge pass replaces the earlier one", async () => {
    const chainReceipt = (id: string, result: 'pass' | 'fail') =>
      receipt(id, 'seat-a/reviewer', { attemptId: 'chain:proj-1:main', kind: 'pre-merge', result, subject: CHAIN_SUBJECT });
    const result = await blockersOf([chainReceipt('c1', 'fail'), chainReceipt('c2', 'pass')], { attemptId: 'chain:proj-1:main' });
    expect(result.full).toEqual([NO_REVIEW_PASSED]);
    expect(result.tally).toEqual({ pass: 1, fail: 0, unknown: 0, disagreement: false });
  });

  it("a brief assessment still counts its own brief receipts: the reviewer's later brief-verify pass replaces the earlier one", async () => {
    const briefAssessmentId = assessmentIdForBrief('proj-1', 'd'.repeat(64));
    const briefAttemptId = `brief:proj-1:${'d'.repeat(64)}`;
    const briefReceipt = (id: string, result: 'pass' | 'fail') =>
      receipt(id, 'seat-a/reviewer', {
        assessmentId: briefAssessmentId, attemptId: briefAttemptId, kind: 'brief-verify', result, subject: BRIEF_SUBJECT,
      });
    const { useCase } = wire(
      assessment([briefReceipt('v1', 'fail'), briefReceipt('v2', 'pass')], { id: briefAssessmentId, attemptId: briefAttemptId }),
    );
    const full = await useCase.assessHeadAcceptance({ assessmentId: briefAssessmentId, candidateHeadSha: HEAD, policyRevision: 'pol-1' });
    expect(full.outcome === 'blocked' ? full.blockers : full.outcome).toEqual([NO_REVIEW_PASSED]);
    expect(full.outcome === 'blocked' ? full.reviewTally : undefined).toEqual({ pass: 1, fail: 0, unknown: 0, disagreement: false });
  });
});

describe('a stored assessment the aggregate refuses is a typed rejection, never a throw (CO18a7a)', () => {
  const poisoned = () =>
    assessment([
      receipt('a1', 'seat-a/reviewer'),
      receipt('bad', 'seat-b/reviewer', { kind: 'code-review', subject: BRIEF_SUBJECT }),
    ]);

  it('a code-review receipt with a brief subject on an ordinary attemptId rejects the full assessment and saves nothing', async () => {
    const { saved, useCase, request } = wire(poisoned());
    await expect(useCase.assessHeadAcceptance(request)).resolves.toEqual({ outcome: 'rejected', reason: INVALID_RECEIPT_REASON });
    expect(saved).toEqual([]);
  });

  it('the same stored record rejects the receipts-only assessment and saves nothing', async () => {
    const { saved, useCase, request } = wire(poisoned());
    await expect(useCase.assessHeadReceipts(request)).resolves.toEqual({ outcome: 'rejected', reason: INVALID_RECEIPT_REASON });
    expect(saved).toEqual([]);
  });

  it('the same stored record asked at another head is rejected, not marked stale, and saves nothing', async () => {
    const { saved, useCase, request } = wire(poisoned());
    await expect(useCase.assessHeadAcceptance({ ...request, candidateHeadSha: OTHER_HEAD })).resolves.toEqual({
      outcome: 'rejected',
      reason: INVALID_RECEIPT_REASON,
    });
    expect(saved).toEqual([]);
  });

  it('a stored accepted assessment that holds the invalid receipt is rejected, never returned as accepted', async () => {
    const { saved, useCase, request } = wire({ ...poisoned(), state: 'accepted', acceptanceReceiptId: 'acc-asm-1-11111111' });
    await expect(useCase.assessHeadAcceptance(request)).resolves.toEqual({ outcome: 'rejected', reason: INVALID_RECEIPT_REASON });
    await expect(useCase.assessHeadReceipts(request)).resolves.toEqual({ outcome: 'rejected', reason: INVALID_RECEIPT_REASON });
    expect(saved).toEqual([]);
  });

  it('a stored record whose reviewReceipts is not an array is rejected as unreadable and saves nothing', async () => {
    const broken = { ...assessment([]), reviewReceipts: null } as unknown as EvidenceAssessmentRecord;
    const { saved, useCase, request } = wire(broken);
    await expect(useCase.assessHeadAcceptance(request)).resolves.toEqual({
      outcome: 'rejected',
      reason: 'Assessment record is invalid and cannot be assessed: unreadable record',
    });
    expect(saved).toEqual([]);
  });

  it('a valid stored record is still accepted and saved once', async () => {
    const { saved, useCase, request } = wire(assessment([receipt('a1', 'seat-a/reviewer')]));
    const result = await useCase.assessHeadAcceptance(request);
    expect(result.outcome).toBe('accepted');
    expect(saved).toHaveLength(1);
    expect(saved[0]?.state).toBe('accepted');
  });
});
