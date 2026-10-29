import { describe, expect, it } from 'vitest';

import { assessmentIdForAttempt } from '../../../domain/assessment-id.js';
import type { EvidenceAssessmentRecord } from '../../../domain/evidence-records.js';
import type { OpenEvidenceAssessmentRequest } from '../../ports/in/OpenEvidenceAssessmentPort.in-port.js';
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
import { OpenEvidenceAssessmentUseCase } from '../OpenEvidenceAssessmentUseCase.use-case.js';
import { RequestIndependentReviewUseCase } from '../RequestIndependentReviewUseCase.use-case.js';

const HEAD1 = '1111111111111111111111111111111111111111';
const HEAD2 = '2222222222222222222222222222222222222222';
const NOW_ISO = '2026-10-15T12:00:00.000Z';

class InMemoryAssessmentRepo implements EvidenceAssessmentRepositoryPort {
  private readonly records = new Map<string, EvidenceAssessmentRecord>();
  saveCalls = 0;
  findCalls = 0;

  constructor(initialRecords: EvidenceAssessmentRecord[] = []) {
    for (const record of initialRecords) {
      this.records.set(record.id, { ...record });
    }
  }

  async saveAssessment(record: EvidenceAssessmentRecord): Promise<void> {
    this.saveCalls += 1;
    this.records.set(record.id, { ...record });
  }

  async findAssessmentById(assessmentId: string): Promise<EvidenceAssessmentRecord | null> {
    this.findCalls += 1;
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

class ThrowingFindRepo implements EvidenceAssessmentRepositoryPort {
  async findAssessmentById(): Promise<EvidenceAssessmentRecord | null> {
    throw new Error('store exploded');
  }

  async findAssessmentByHead(): Promise<EvidenceAssessmentRecord | null> {
    throw new Error('store exploded');
  }

  async saveAssessment(): Promise<void> {
    throw new Error('store exploded');
  }
}

class ThrowingSaveRepo extends InMemoryAssessmentRepo {
  override async saveAssessment(): Promise<void> {
    throw new Error('store exploded');
  }
}

class StubReviewer implements IndependentReviewPort {
  calls: RunIndependentReviewRequest[] = [];

  async runIndependentReview(
    request: RunIndependentReviewRequest,
  ): Promise<RunIndependentReviewResult> {
    this.calls.push(request);
    return {
      outcome: 'completed',
      readOnlyVerified: true,
      result: 'pass',
      findings: [],
      rawOutput: 'clean review',
      completedAtIso: NOW_ISO,
    };
  }
}

class StubArchive implements EvidenceArchivePort {
  calls: ArchiveEvidenceRequest[] = [];

  async archiveEvidence(request: ArchiveEvidenceRequest): Promise<ArchiveEvidenceResult> {
    this.calls.push(request);
    return {
      evidenceRef: `ref-${request.artifactId}`,
      digest: 'digest-1',
    };
  }

  async readArchivedEvidence(_evidenceRef: string): Promise<string | null> {
    return 'content';
  }
}

function sampleRequest(overrides: Partial<OpenEvidenceAssessmentRequest> = {}): OpenEvidenceAssessmentRequest {
  return {
    attemptId: 'att-1',
    projectId: 'proj-1',
    candidateHeadSha: HEAD1,
    policyRevision: 'pol-1',
    implementerModel: 'anthropic/claude-3-5-sonnet',
    requiredChecks: ['lint'],
    nowIso: NOW_ISO,
    ...overrides,
  };
}

function sampleRecord(overrides: Partial<EvidenceAssessmentRecord> = {}): EvidenceAssessmentRecord {
  return {
    id: assessmentIdForAttempt('att-1'),
    projectId: 'proj-1',
    attemptId: 'att-1',
    candidateHeadSha: HEAD1,
    policyRevision: 'pol-1',
    implementerModel: 'anthropic/claude-3-5-sonnet',
    requiredChecks: ['lint'],
    state: 'pending',
    verificationReceipts: [],
    reviewReceipts: [],
    findingDispositions: [],
    acceptanceReceiptId: null,
    blockers: [],
    revision: 0,
    updatedAtIso: NOW_ISO,
    ...overrides,
  };
}

describe('OpenEvidenceAssessmentUseCase', () => {
  it('opens a new pending assessment when none is stored', async () => {
    const repo = new InMemoryAssessmentRepo([]);
    const useCase = new OpenEvidenceAssessmentUseCase({ repo });

    const result = await useCase.openEvidenceAssessment(sampleRequest());

    expect(result).toEqual({ outcome: 'opened', assessmentId: assessmentIdForAttempt('att-1') });
    expect(repo.findCalls).toBe(1);
    expect(repo.saveCalls).toBe(1);
    const stored = await repo.findAssessmentById(assessmentIdForAttempt('att-1'));
    expect(stored).toEqual({
      id: assessmentIdForAttempt('att-1'),
      projectId: 'proj-1',
      attemptId: 'att-1',
      candidateHeadSha: HEAD1,
      policyRevision: 'pol-1',
      implementerModel: 'anthropic/claude-3-5-sonnet',
      requiredChecks: ['lint'],
      state: 'pending',
      verificationReceipts: [],
      reviewReceipts: [],
      findingDispositions: [],
      acceptanceReceiptId: null,
      blockers: [],
      revision: 1,
      updatedAtIso: NOW_ISO,
    });
  });

  it('is idempotent: a second call answers exists and writes nothing', async () => {
    const repo = new InMemoryAssessmentRepo([]);
    const useCase = new OpenEvidenceAssessmentUseCase({ repo });

    const first = await useCase.openEvidenceAssessment(sampleRequest());
    expect(first.outcome).toBe('opened');
    const second = await useCase.openEvidenceAssessment(sampleRequest());

    expect(second).toEqual({ outcome: 'exists', assessmentId: assessmentIdForAttempt('att-1') });
    expect(repo.saveCalls).toBe(1);
    const stored = await repo.findAssessmentById(assessmentIdForAttempt('att-1'));
    expect(stored?.revision).toBe(1);
  });

  it('answers exists for a stored assessment at the same head, policy and implementer and writes nothing', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const useCase = new OpenEvidenceAssessmentUseCase({ repo });

    const result = await useCase.openEvidenceAssessment(sampleRequest());

    expect(result).toEqual({ outcome: 'exists', assessmentId: assessmentIdForAttempt('att-1') });
    expect(repo.saveCalls).toBe(0);
  });

  it('refuses head-mismatch when the stored assessment is at another head and never marks it stale', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord({ candidateHeadSha: HEAD2 })]);
    const useCase = new OpenEvidenceAssessmentUseCase({ repo });

    const result = await useCase.openEvidenceAssessment(sampleRequest());

    expect(result).toEqual({ outcome: 'refused', reason: 'head-mismatch' });
    expect(repo.saveCalls).toBe(0);
    const stored = await repo.findAssessmentById(assessmentIdForAttempt('att-1'));
    expect(stored?.candidateHeadSha).toBe(HEAD2);
    expect(stored?.state).toBe('pending');
    expect(stored?.revision).toBe(0);
  });

  it('refuses head-mismatch when the stored policy revision differs', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord({ policyRevision: 'pol-2' })]);
    const useCase = new OpenEvidenceAssessmentUseCase({ repo });

    const result = await useCase.openEvidenceAssessment(sampleRequest());

    expect(result).toEqual({ outcome: 'refused', reason: 'head-mismatch' });
    expect(repo.saveCalls).toBe(0);
  });

  it('refuses head-mismatch when the stored implementer seat differs', async () => {
    const repo = new InMemoryAssessmentRepo([
      sampleRecord({ implementerModel: 'openai/gpt-4o' }),
    ]);
    const useCase = new OpenEvidenceAssessmentUseCase({ repo });

    const result = await useCase.openEvidenceAssessment(sampleRequest());

    expect(result).toEqual({ outcome: 'refused', reason: 'head-mismatch' });
    expect(repo.saveCalls).toBe(0);
  });

  it('refuses terminal when the stored assessment at the same head is rejected', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord({ state: 'rejected' })]);
    const useCase = new OpenEvidenceAssessmentUseCase({ repo });

    const result = await useCase.openEvidenceAssessment(sampleRequest());

    expect(result).toEqual({ outcome: 'refused', reason: 'terminal' });
    expect(repo.saveCalls).toBe(0);
    const stored = await repo.findAssessmentById(assessmentIdForAttempt('att-1'));
    expect(stored?.state).toBe('rejected');
    expect(stored?.revision).toBe(0);
  });

  it('refuses terminal when the stored assessment at the same head is stale', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord({ state: 'stale' })]);
    const useCase = new OpenEvidenceAssessmentUseCase({ repo });

    const result = await useCase.openEvidenceAssessment(sampleRequest());

    expect(result).toEqual({ outcome: 'refused', reason: 'terminal' });
    expect(repo.saveCalls).toBe(0);
  });

  it('refuses invalid-request and never calls the store when the candidate head sha is not 40 lowercase hex', async () => {
    const repo = new InMemoryAssessmentRepo([]);
    const useCase = new OpenEvidenceAssessmentUseCase({ repo });

    const result = await useCase.openEvidenceAssessment(sampleRequest({ candidateHeadSha: 'ABC123' }));

    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(repo.findCalls).toBe(0);
    expect(repo.saveCalls).toBe(0);
  });

  it('refuses invalid-request and never calls the store when a required field is empty', async () => {
    const repo = new InMemoryAssessmentRepo([]);
    const useCase = new OpenEvidenceAssessmentUseCase({ repo });

    const result = await useCase.openEvidenceAssessment(sampleRequest({ attemptId: '   ' }));

    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(repo.findCalls).toBe(0);
    expect(repo.saveCalls).toBe(0);
  });

  it('refuses invalid-request when requiredChecks is not an array of non-empty strings', async () => {
    const repo = new InMemoryAssessmentRepo([]);
    const useCase = new OpenEvidenceAssessmentUseCase({ repo });

    const result = await useCase.openEvidenceAssessment(
      sampleRequest({ requiredChecks: ['lint', ''] }),
    );

    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(repo.findCalls).toBe(0);
    expect(repo.saveCalls).toBe(0);
  });

  it('returns store-unreadable with the fixed code when finding throws', async () => {
    const repo = new ThrowingFindRepo();
    const useCase = new OpenEvidenceAssessmentUseCase({ repo });

    const result = await useCase.openEvidenceAssessment(sampleRequest());

    expect(result).toEqual({ outcome: 'refused', reason: 'store-unreadable' });
  });

  it('returns store-unreadable when saving throws', async () => {
    const repo = new ThrowingSaveRepo();
    const useCase = new OpenEvidenceAssessmentUseCase({ repo });

    const result = await useCase.openEvidenceAssessment(sampleRequest());

    expect(result).toEqual({ outcome: 'refused', reason: 'store-unreadable' });
  });

  it('throws Not implemented when unconfigured', async () => {
    const useCase = new OpenEvidenceAssessmentUseCase();

    await expect(useCase.openEvidenceAssessment(sampleRequest())).rejects.toThrow(
      'Not implemented: OpenEvidenceAssessmentUseCase',
    );
  });
});

describe('OpenEvidenceAssessmentUseCase unlocks RequestIndependentReview (follow-up (b))', () => {
  it('lets RequestIndependentReviewUseCase run after opened instead of refusing no-assessment', async () => {
    const repo = new InMemoryAssessmentRepo([]);
    const reviewer = new StubReviewer();
    const archive = new StubArchive();
    const openUseCase = new OpenEvidenceAssessmentUseCase({ repo });
    const reviewUseCase = new RequestIndependentReviewUseCase({ repo, reviewer, archive });
    const assessmentId = assessmentIdForAttempt('att-1');

    // Before opening, an independent review has no assessment to bind to.
    const before = await reviewUseCase.requestIndependentReview({
      assessmentId,
      projectId: 'proj-1',
      attemptId: 'att-1',
      candidateHeadSha: HEAD1,
      policyRevision: 'pol-1',
      implementerModel: 'anthropic/claude-3-5-sonnet',
      reviewerModel: 'openai/gpt-4o',
    });
    expect(before.outcome).toBe('rejected');
    if (before.outcome === 'rejected') {
      expect(before.reason).toContain('No assessment exists');
    }

    const opened = await openUseCase.openEvidenceAssessment(sampleRequest());
    expect(opened.outcome).toBe('opened');

    // After opening, the same review runs instead of refusing no-assessment.
    const after = await reviewUseCase.requestIndependentReview({
      assessmentId,
      projectId: 'proj-1',
      attemptId: 'att-1',
      candidateHeadSha: HEAD1,
      policyRevision: 'pol-1',
      implementerModel: 'anthropic/claude-3-5-sonnet',
      reviewerModel: 'openai/gpt-4o',
    });
    expect(after.outcome).toBe('reviewed');
    expect(reviewer.calls).toHaveLength(1);
    const stored = await repo.findAssessmentById(assessmentId);
    expect(stored?.reviewReceipts).toHaveLength(1);
  });
});
