import { describe, expect, it } from 'vitest';

import {
  assessmentIdForChain,
  attemptIdForChain,
  receiptSubjectOf,
} from '../../../domain/evidence-records.js';
import type { EvidenceAssessmentRecord, ReceiptSubject } from '../../../domain/evidence-records.js';
import { ReceiptSubjectKind } from '../../../domain/value-objects/ReceiptSubjectKind.vo.js';
import type {
  ArchiveEvidenceRequest,
  ArchiveEvidenceResult,
  EvidenceArchivePort,
} from '../../ports/out/EvidenceArchivePort.out-port.js';
import type { EvidenceAssessmentRepositoryPort } from '../../ports/out/EvidenceAssessmentRepositoryPort.out-port.js';
import type {
  IndependentReviewPort,
  RunIndependentReviewRequest,
  RunIndependentReviewResult,
} from '../../ports/out/IndependentReviewPort.out-port.js';
import type { RequestIndependentReviewRequest } from '../../ports/in/RequestIndependentReviewPort.in-port.js';
import { RequestIndependentReviewUseCase } from '../RequestIndependentReviewUseCase.use-case.js';

const HEAD = '1'.repeat(40);
const OTHER_HEAD = '2'.repeat(40);
const PROJECT = 'project-example-1';
const CHAIN = 'example-chain';
const REQUEST_ID = 'chain-review:example-chain:111111111111';
const IMPLEMENTER = 'example-provider/glm-5.3';
const REVIEWER = 'example-provider/grok-4.7';

class InMemoryAssessmentRepo implements EvidenceAssessmentRepositoryPort {
  readonly records = new Map<string, EvidenceAssessmentRecord>();
  saves = 0;

  async saveAssessment(record: EvidenceAssessmentRecord): Promise<void> {
    this.saves += 1;
    this.records.set(record.id, { ...record });
  }

  async findAssessmentById(assessmentId: string): Promise<EvidenceAssessmentRecord | null> {
    const record = this.records.get(assessmentId);
    return record ? { ...record } : null;
  }

  async findAssessmentByHead(candidateHeadSha: string): Promise<EvidenceAssessmentRecord | null> {
    for (const record of this.records.values()) {
      if (record.candidateHeadSha === candidateHeadSha) {
        return { ...record };
      }
    }
    return null;
  }
}

class StubReviewer implements IndependentReviewPort {
  calls: RunIndependentReviewRequest[] = [];

  async runIndependentReview(request: RunIndependentReviewRequest): Promise<RunIndependentReviewResult> {
    this.calls.push(request);
    return {
      outcome: 'completed',
      readOnlyVerified: true,
      result: 'pass',
      findings: [],
      rawOutput: 'clean review',
      completedAtIso: '2026-11-06T12:00:00.000Z',
    };
  }
}

class StubArchive implements EvidenceArchivePort {
  async archiveEvidence(request: ArchiveEvidenceRequest): Promise<ArchiveEvidenceResult> {
    return { evidenceRef: `ref-${request.artifactId}`, digest: 'digest-1' };
  }

  async readArchivedEvidence(): Promise<string | null> {
    return 'content';
  }
}

function chainSubject(overrides: Partial<ReceiptSubject> = {}): ReceiptSubject {
  return {
    kind: 'chain', projectId: PROJECT, attemptId: null, chainName: CHAIN, integrationHeadSha: HEAD,
    briefPackageDigest: null, baseCommit: null, ...overrides,
  };
}

function chainRequest(overrides: Partial<RequestIndependentReviewRequest> = {}): RequestIndependentReviewRequest {
  return {
    assessmentId: assessmentIdForChain(PROJECT, CHAIN),
    projectId: PROJECT,
    attemptId: attemptIdForChain(PROJECT, CHAIN),
    candidateHeadSha: HEAD,
    policyRevision: 'policy-1',
    implementerModel: IMPLEMENTER,
    reviewerModel: REVIEWER,
    kind: 'pre-merge',
    requestId: REQUEST_ID,
    subject: chainSubject(),
    nowIso: '2026-11-06T12:00:00.000Z',
    ...overrides,
  };
}

function harness() {
  const repo = new InMemoryAssessmentRepo();
  const reviewer = new StubReviewer();
  const useCase = new RequestIndependentReviewUseCase({ repo, reviewer, archive: new StubArchive() });
  return { repo, reviewer, useCase };
}

describe('the chain subject in the evidence context', () => {
  it('records a pre-merge receipt carrying the chain subject on a chain-scoped assessment', async () => {
    const { repo, reviewer, useCase } = harness();
    const result = await useCase.requestIndependentReview(chainRequest());
    expect(result.outcome).toBe('reviewed');
    if (result.outcome !== 'reviewed') return;
    expect(result.receipt.kind).toBe('pre-merge');
    expect(result.receipt.requestId).toBe(REQUEST_ID);
    expect(result.receipt.subject).toEqual(chainSubject());
    expect(receiptSubjectOf(result.receipt)).toEqual(chainSubject());
    expect(reviewer.calls).toHaveLength(1);
    expect(reviewer.calls[0]).toMatchObject({ kind: 'pre-merge', candidateHeadSha: HEAD });
    const assessment = repo.records.get(assessmentIdForChain(PROJECT, CHAIN));
    expect(assessment).toMatchObject({
      projectId: PROJECT,
      candidateHeadSha: HEAD,
      implementerModel: IMPLEMENTER,
      attemptId: `chain:${PROJECT}:${CHAIN}`,
    });
    expect(assessment?.reviewReceipts).toHaveLength(1);
  });

  it('keeps the chain assessment id free of any path and of the attempt id space', () => {
    const id = assessmentIdForChain(PROJECT, CHAIN);
    expect(id).not.toContain('/');
    expect(id).toBe(`assessment-chain:${PROJECT}:${CHAIN}`);
    expect(assessmentIdForChain(PROJECT, 'other-chain')).not.toBe(id);
  });

  it('a replayed request id returns the stored receipt and runs no second review', async () => {
    const { repo, reviewer, useCase } = harness();
    const first = await useCase.requestIndependentReview(chainRequest());
    const second = await useCase.requestIndependentReview(chainRequest());
    expect(second).toEqual(first);
    expect(reviewer.calls).toHaveLength(1);
    expect(repo.records.get(assessmentIdForChain(PROJECT, CHAIN))?.reviewReceipts).toHaveLength(1);
  });

  it('refuses a request id reused with another head as request-id-reused', async () => {
    const { useCase } = harness();
    await useCase.requestIndependentReview(chainRequest());
    const reused = await useCase.requestIndependentReview(
      chainRequest({ candidateHeadSha: OTHER_HEAD, subject: chainSubject({ integrationHeadSha: OTHER_HEAD }) }),
    );
    expect(reused).toMatchObject({ outcome: 'rejected', rejection: 'request-id-reused' });
  });

  it('refuses a stored request id asked again under another kind, never replaying the receipt', async () => {
    const { reviewer, useCase } = harness();
    await useCase.requestIndependentReview(chainRequest());
    // A chain review is pre-merge only: the same id under another kind is no chain request at all.
    const reused = await useCase.requestIndependentReview(chainRequest({ kind: 'code-review' }));
    expect(reused).toMatchObject({ outcome: 'rejected', rejection: 'invalid-request' });
    expect(reviewer.calls).toHaveLength(1);
  });

  it('requires a reviewer of another model family than the implementer', async () => {
    const { reviewer, useCase } = harness();
    const same = await useCase.requestIndependentReview(chainRequest({ reviewerModel: 'other-provider/glm-5.2' }));
    expect(same).toMatchObject({ outcome: 'rejected', rejection: 'not-independent' });
    expect(reviewer.calls).toHaveLength(0);
  });

  it('refuses a brief subject and the brief-verify kind with invalid-request', async () => {
    const { reviewer, useCase } = harness();
    const brief = await useCase.requestIndependentReview(
      chainRequest({
        subject: {
          kind: 'brief', projectId: PROJECT, attemptId: null, chainName: null, integrationHeadSha: null,
          briefPackageDigest: 'd'.repeat(64), baseCommit: HEAD,
        },
      }),
    );
    expect(brief).toMatchObject({ outcome: 'rejected', rejection: 'invalid-request' });
    const verify = await useCase.requestIndependentReview(chainRequest({ kind: 'brief-verify' as never }));
    expect(verify).toMatchObject({ outcome: 'rejected', rejection: 'invalid-request' });
    expect(reviewer.calls).toHaveLength(0);
  });

  it('refuses a chain subject that disagrees with the request ids', async () => {
    const { useCase } = harness();
    const wrongHead = await useCase.requestIndependentReview(
      chainRequest({ subject: chainSubject({ integrationHeadSha: OTHER_HEAD }) }),
    );
    const wrongChain = await useCase.requestIndependentReview(chainRequest({ subject: chainSubject({ chainName: 'another' }) }));
    const noRequestId = await useCase.requestIndependentReview(chainRequest({ requestId: undefined }));
    for (const result of [wrongHead, wrongChain, noRequestId]) {
      expect(result.outcome).toBe('rejected');
    }
    expect(wrongHead).toMatchObject({ rejection: 'invalid-request' });
    expect(wrongChain).toMatchObject({ rejection: 'invalid-request' });
  });

  it('turns an unexpected store failure on a chain request into the typed rejection, never a throw', async () => {
    const { repo, useCase } = harness();
    repo.findAssessmentById = async () => {
      throw new Error('disk exploded at /secret/path');
    };
    const result = await useCase.requestIndependentReview(chainRequest());
    expect(result).toMatchObject({ outcome: 'rejected', rejection: 'review-unavailable' });
    expect(JSON.stringify(result)).not.toContain('/secret/path');
  });

  it('still reads a receipt recorded without a subject as an attempt subject', () => {
    const subject = receiptSubjectOf({ projectId: PROJECT, attemptId: 'attempt-1' });
    expect(subject).toEqual({
      kind: 'attempt', projectId: PROJECT, attemptId: 'attempt-1', chainName: null, integrationHeadSha: null,
      briefPackageDigest: null, baseCommit: null,
    });
  });

  it('treats an unknown or incomplete stored subject as no subject, never a pass', () => {
    const base = { projectId: PROJECT, attemptId: 'attempt-1' };
    expect(receiptSubjectOf({ ...base, subject: { kind: 'galaxy', projectId: PROJECT } })).toBeNull();
    expect(receiptSubjectOf({ ...base, subject: { kind: 'chain', projectId: PROJECT, chainName: CHAIN } })).toBeNull();
    expect(receiptSubjectOf({ ...base, subject: 'chain' })).toBeNull();
    const withGetter = {
      ...base,
      get subject() {
        throw new Error('getter ran');
      },
    };
    expect(receiptSubjectOf(withGetter)).toBeNull();
  });

  it('leaves an attempt request without a subject on the attempt path', async () => {
    const { repo, reviewer, useCase } = harness();
    const attemptAssessment = {
      id: 'assessment-attempt-1', projectId: PROJECT, attemptId: 'attempt-1', candidateHeadSha: HEAD,
      policyRevision: 'policy-1', implementerModel: IMPLEMENTER, requiredChecks: ['check'], state: 'pending' as const,
      verificationReceipts: [], reviewReceipts: [], findingDispositions: [], acceptanceReceiptId: null, blockers: [],
      revision: 1, updatedAtIso: '2026-11-06T11:00:00.000Z',
    };
    await repo.saveAssessment(attemptAssessment);
    const result = await useCase.requestIndependentReview({
      assessmentId: 'assessment-attempt-1', projectId: PROJECT, attemptId: 'attempt-1', candidateHeadSha: HEAD,
      policyRevision: 'policy-1', implementerModel: IMPLEMENTER, reviewerModel: REVIEWER, kind: 'code-review',
      requestId: 'review-attempt-1', nowIso: '2026-11-06T12:00:00.000Z',
    });
    expect(result.outcome).toBe('reviewed');
    if (result.outcome !== 'reviewed') return;
    expect(result.receipt.subject).toBeUndefined();
    expect(receiptSubjectOf(result.receipt)?.kind).toBe('attempt');
    expect(reviewer.calls).toHaveLength(1);
  });
});

describe('ReceiptSubjectKind', () => {
  it('accepts exactly attempt, chain and brief and fails, never throws, on anything else', () => {
    for (const value of ['attempt', 'chain', 'brief']) {
      const created = ReceiptSubjectKind.create(value);
      expect(created.success).toBe(true);
      expect(created.value?.getValue()).toBe(value);
    }
    for (const value of ['galaxy', '', 'Chain', null, undefined, 3, {}]) {
      const created = ReceiptSubjectKind.create(value);
      expect(created.success).toBe(false);
      expect(created.value).toBeUndefined();
    }
    const a = ReceiptSubjectKind.create('chain').value;
    const b = ReceiptSubjectKind.create('chain').value;
    const c = ReceiptSubjectKind.create('brief').value;
    expect(a?.equals(b as ReceiptSubjectKind)).toBe(true);
    expect(a?.equals(c as ReceiptSubjectKind)).toBe(false);
  });
});
