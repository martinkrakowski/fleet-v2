import { describe, expect, it } from 'vitest';
import type { EvidenceAssessmentRecord, ReceiptSubject, ReviewReceiptRecord } from '../evidence-records.js';
import { assessmentIdForBrief, assessmentIdForChain, attemptIdForBrief, attemptIdForChain } from '../evidence-records.js';
import { EvidenceAssessment } from '../entities/EvidenceAssessment.js';

const HEAD = '1111111111111111111111111111111111111111';
const DIGEST = 'd'.repeat(64);
const NOW = '2026-11-16T10:00:00.000Z';
const DIFFERENT_SUBJECT = 'Review receipt is about a different subject than this assessment';

function subject(overrides: Partial<ReceiptSubject>): ReceiptSubject {
  return {
    kind: 'attempt', projectId: 'proj-1', attemptId: null, chainName: null, integrationHeadSha: null,
    briefPackageDigest: null, baseCommit: null, ...overrides,
  };
}

const CHAIN_SUBJECT = subject({ kind: 'chain', chainName: 'main', integrationHeadSha: HEAD });
const BRIEF_SUBJECT = subject({ kind: 'brief', briefPackageDigest: DIGEST, baseCommit: HEAD });

function aggregateFor(id: string, attemptId: string): EvidenceAssessment {
  const record: EvidenceAssessmentRecord = {
    id, projectId: 'proj-1', attemptId, candidateHeadSha: HEAD, policyRevision: 'pol-1',
    implementerModel: 'seat-i/implementer', requiredChecks: [], state: 'pending', verificationReceipts: [],
    reviewReceipts: [], findingDispositions: [], acceptanceReceiptId: null, blockers: [], revision: 1, updatedAtIso: NOW,
  };
  return EvidenceAssessment.fromRecord(record);
}

function receipt(assessmentId: string, attemptId: string, overrides: Partial<ReviewReceiptRecord> = {}): ReviewReceiptRecord {
  return {
    id: 'rr-1', assessmentId, projectId: 'proj-1', attemptId, candidateHeadSha: HEAD,
    reviewerModel: 'seat-a/reviewer', implementerModel: 'seat-i/implementer', readOnlyVerified: true, result: 'pass',
    findings: [], evidenceRef: 'ref-1', policyRevision: 'pol-1', completedAtIso: NOW, ...overrides,
  };
}

describe('EvidenceAssessment.appendReviewReceipt refuses a receipt about another subject (CO18a7b)', () => {
  it('an attempt assessment refuses a chain-subject receipt and keeps its receipts and revision', () => {
    const aggregate = aggregateFor('asm-1', 'att-1');
    expect(() => aggregate.appendReviewReceipt(receipt('asm-1', 'att-1', { subject: CHAIN_SUBJECT }), NOW)).toThrow(DIFFERENT_SUBJECT);
    expect(aggregate.toRecord().reviewReceipts).toEqual([]);
    expect(aggregate.getRevision()).toBe(1);
  });

  it('an attempt assessment refuses an attempt subject naming another attempt or another project', () => {
    const aggregate = aggregateFor('asm-1', 'att-1');
    const otherAttempt = receipt('asm-1', 'att-1', { subject: subject({ attemptId: 'att-OTHER' }) });
    const otherProject = receipt('asm-1', 'att-1', { subject: subject({ projectId: 'proj-2', attemptId: 'att-1' }) });
    expect(() => aggregate.appendReviewReceipt(otherAttempt, NOW)).toThrow(DIFFERENT_SUBJECT);
    expect(() => aggregate.appendReviewReceipt(otherProject, NOW)).toThrow(DIFFERENT_SUBJECT);
    expect(aggregate.toRecord().reviewReceipts).toEqual([]);
  });

  it('an attempt assessment refuses a receipt whose own attemptId is another attempt', () => {
    const aggregate = aggregateFor('asm-1', 'att-1');
    expect(() => aggregate.appendReviewReceipt(receipt('asm-1', 'att-2'), NOW)).toThrow(DIFFERENT_SUBJECT);
  });

  it('an attempt assessment appends a receipt without a subject and one naming its own attempt', () => {
    const aggregate = aggregateFor('asm-1', 'att-1');
    aggregate.appendReviewReceipt(receipt('asm-1', 'att-1'), NOW);
    aggregate.appendReviewReceipt(receipt('asm-1', 'att-1', { id: 'rr-2', subject: subject({ attemptId: 'att-1' }) }), NOW);
    expect(aggregate.toRecord().reviewReceipts.map((stored) => stored.id)).toEqual(['rr-1', 'rr-2']);
  });

  it('a chain assessment appends its own chain receipt and refuses one for another chain', () => {
    const id = assessmentIdForChain('proj-1', 'main');
    const attemptId = attemptIdForChain('proj-1', 'main');
    const aggregate = aggregateFor(id, attemptId);
    aggregate.appendReviewReceipt(receipt(id, attemptId, { kind: 'pre-merge', subject: CHAIN_SUBJECT }), NOW);
    const otherChain = receipt(id, attemptId, { id: 'rr-2', kind: 'pre-merge', subject: subject({ kind: 'chain', chainName: 'other', integrationHeadSha: HEAD }) });
    expect(() => aggregate.appendReviewReceipt(otherChain, NOW)).toThrow(DIFFERENT_SUBJECT);
    expect(aggregate.toRecord().reviewReceipts.map((stored) => stored.id)).toEqual(['rr-1']);
  });

  it('a brief assessment appends its own brief-verify receipt', () => {
    const id = assessmentIdForBrief('proj-1', DIGEST);
    const attemptId = attemptIdForBrief('proj-1', DIGEST);
    const aggregate = aggregateFor(id, attemptId);
    aggregate.appendReviewReceipt(receipt(id, attemptId, { kind: 'brief-verify', subject: BRIEF_SUBJECT }), NOW);
    expect(aggregate.toRecord().reviewReceipts.map((stored) => stored.id)).toEqual(['rr-1']);
  });
});
