import { describe, expect, it } from 'vitest';

import type { EvidenceAssessmentRecord, ReceiptSubject, ReviewReceiptRecord } from '../../../domain/evidence-records.js';
import type { EvidenceAssessmentRepositoryPort } from '../../ports/out/EvidenceAssessmentRepositoryPort.out-port.js';
import { RecordReviewReceiptUseCase } from '../RecordReviewReceiptUseCase.use-case.js';

const HEAD = '1111111111111111111111111111111111111111';
const DIFFERENT_SUBJECT = 'Review receipt is about a different subject than this assessment';

function subject(overrides: Partial<ReceiptSubject>): ReceiptSubject {
  return {
    kind: 'attempt', projectId: 'proj-1', attemptId: null, chainName: null, integrationHeadSha: null,
    briefPackageDigest: null, baseCommit: null, ...overrides,
  };
}

function receipt(id: string, overrides: Partial<ReviewReceiptRecord> = {}): ReviewReceiptRecord {
  return {
    id, assessmentId: 'asm-1', projectId: 'proj-1', attemptId: 'att-1', candidateHeadSha: HEAD,
    reviewerModel: 'seat-a/reviewer', implementerModel: 'seat-i/implementer', readOnlyVerified: true, result: 'pass',
    findings: [], evidenceRef: `ref-${id}`, policyRevision: 'pol-1', completedAtIso: '2026-11-16T10:00:00.000Z',
    ...overrides,
  };
}

function assessment(reviewReceipts: readonly ReviewReceiptRecord[] = []): EvidenceAssessmentRecord {
  return {
    id: 'asm-1', projectId: 'proj-1', attemptId: 'att-1', candidateHeadSha: HEAD, policyRevision: 'pol-1',
    implementerModel: 'seat-i/implementer', requiredChecks: [], state: 'pending', verificationReceipts: [],
    reviewReceipts, findingDispositions: [], acceptanceReceiptId: null, blockers: [], revision: 3,
    updatedAtIso: '2026-11-16T10:00:00.000Z',
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
  const useCase = new RecordReviewReceiptUseCase({ repo });
  const record = (candidate: ReviewReceiptRecord) =>
    useCase.recordReviewReceipt({ assessmentId: 'asm-1', receipt: candidate, nowIso: '2026-11-16T10:01:00.000Z' });
  return { saved, record };
}

describe('RecordReviewReceiptUseCase refuses a receipt about another subject (CO18a7b)', () => {
  it.each([
    ['a chain subject', subject({ kind: 'chain', chainName: 'main', integrationHeadSha: HEAD })],
    ['an attempt subject naming another attempt', subject({ attemptId: 'att-OTHER' })],
    ['an attempt subject naming another project', subject({ projectId: 'proj-2', attemptId: 'att-1' })],
  ])('%s on an attempt assessment is rejected and nothing is saved', async (_name, foreign) => {
    const { saved, record } = wire(assessment());
    await expect(record(receipt('rr-1', { subject: foreign }))).resolves.toEqual({ outcome: 'rejected', reason: DIFFERENT_SUBJECT });
    expect(saved).toEqual([]);
  });

  it('a receipt without a subject and one naming its own attempt are recorded', async () => {
    const plain = wire(assessment());
    const own = wire(assessment());
    expect((await plain.record(receipt('rr-1'))).outcome).toBe('recorded');
    expect((await own.record(receipt('rr-1', { subject: subject({ attemptId: 'att-1' }) }))).outcome).toBe('recorded');
    expect(plain.saved).toHaveLength(1);
    expect(own.saved[0]?.reviewReceipts.map((stored) => stored.id)).toEqual(['rr-1']);
  });

  it('a stored assessment holding an invalid receipt is a typed rejection, never a throw, and nothing is saved', async () => {
    const bad = receipt('bad', {
      kind: 'code-review',
      subject: subject({ kind: 'brief', briefPackageDigest: 'd'.repeat(64), baseCommit: HEAD }),
    });
    const { saved, record } = wire(assessment([bad]));
    await expect(record(receipt('rr-2'))).resolves.toEqual({
      outcome: 'rejected',
      reason: 'EvidenceAssessment contains an invalid review receipt',
    });
    expect(saved).toEqual([]);
  });
});
