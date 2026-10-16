import { describe, expect, it } from 'vitest';

import type { EvidenceAssessmentRecord } from '../../../domain/evidence-records.js';
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
import { RequestIndependentReviewUseCase } from '../RequestIndependentReviewUseCase.use-case.js';

const HEAD1 = '1111111111111111111111111111111111111111';
const HEAD2 = '2222222222222222222222222222222222222222';

class InMemoryAssessmentRepo implements EvidenceAssessmentRepositoryPort {
  private readonly records = new Map<string, EvidenceAssessmentRecord>();

  constructor(initialRecords: EvidenceAssessmentRecord[] = []) {
    for (const record of initialRecords) {
      this.records.set(record.id, { ...record });
    }
  }

  async saveAssessment(record: EvidenceAssessmentRecord): Promise<void> {
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
      completedAtIso: '2026-10-15T12:00:00.000Z',
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

function sampleRecord(overrides: Partial<EvidenceAssessmentRecord> = {}): EvidenceAssessmentRecord {
  return {
    id: 'asm-1',
    projectId: 'proj-1',
    attemptId: 'att-1',
    candidateHeadSha: HEAD1,
    policyRevision: 'pol-1',
    requiredChecks: [],
    state: 'pending',
    verificationReceipts: [],
    reviewReceipts: [],
    findingDispositions: [],
    acceptanceReceiptId: null,
    blockers: [],
    revision: 0,
    updatedAtIso: '2026-10-15T12:00:00.000Z',
    ...overrides,
  };
}

describe('RequestIndependentReviewUseCase assessment presence (M13)', () => {
  it('returns rejected when no assessment exists for the assessmentId', async () => {
    const repo = new InMemoryAssessmentRepo([]);
    const reviewer = new StubReviewer();
    const archive = new StubArchive();
    const useCase = new RequestIndependentReviewUseCase({ repo, reviewer, archive });

    const result = await useCase.requestIndependentReview({
      assessmentId: 'asm-nonexistent',
      projectId: 'proj-1',
      attemptId: 'att-1',
      candidateHeadSha: HEAD1,
      policyRevision: 'pol-1',
      implementerModel: 'anthropic/claude-3-5-sonnet',
      reviewerModel: 'openai/gpt-4o',
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain('No assessment exists');
    }
    // Must not call reviewer or archive when assessment is absent
    expect(reviewer.calls).toHaveLength(0);
    expect(archive.calls).toHaveLength(0);
  });

  it('returns rejected when existing assessment has a different candidate head sha', async () => {
    const existing = sampleRecord({ candidateHeadSha: HEAD1 });
    const repo = new InMemoryAssessmentRepo([existing]);
    const reviewer = new StubReviewer();
    const archive = new StubArchive();
    const useCase = new RequestIndependentReviewUseCase({ repo, reviewer, archive });

    const result = await useCase.requestIndependentReview({
      assessmentId: 'asm-1',
      projectId: 'proj-1',
      attemptId: 'att-1',
      candidateHeadSha: HEAD2, // mismatched head!
      policyRevision: 'pol-1',
      implementerModel: 'anthropic/claude-3-5-sonnet',
      reviewerModel: 'openai/gpt-4o',
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain('candidate head');
    }
    expect(reviewer.calls).toHaveLength(0);
  });

  it('records review receipt and updates assessment when assessment exists for the head', async () => {
    const existing = sampleRecord({ candidateHeadSha: HEAD1 });
    const repo = new InMemoryAssessmentRepo([existing]);
    const reviewer = new StubReviewer();
    const archive = new StubArchive();
    const useCase = new RequestIndependentReviewUseCase({ repo, reviewer, archive });

    const result = await useCase.requestIndependentReview({
      assessmentId: 'asm-1',
      projectId: 'proj-1',
      attemptId: 'att-1',
      candidateHeadSha: HEAD1,
      policyRevision: 'pol-1',
      implementerModel: 'anthropic/claude-3-5-sonnet',
      reviewerModel: 'openai/gpt-4o',
    });

    expect(result.outcome).toBe('reviewed');
    if (result.outcome === 'reviewed') {
      expect(result.receipt.result).toBe('pass');
      expect(result.receipt.candidateHeadSha).toBe(HEAD1);
    }

    const stored = await repo.findAssessmentById('asm-1');
    expect(stored?.reviewReceipts).toHaveLength(1);
    expect(stored?.reviewReceipts[0].reviewerModel).toBe('openai/gpt-4o');
  });
});
