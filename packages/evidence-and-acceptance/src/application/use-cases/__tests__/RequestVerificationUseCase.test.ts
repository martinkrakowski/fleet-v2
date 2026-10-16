import { describe, expect, it } from 'vitest';

import type { EvidenceAssessmentRecord } from '../../../domain/evidence-records.js';
import type {
  ArchiveEvidenceRequest,
  ArchiveEvidenceResult,
  EvidenceArchivePort,
} from '../../ports/out/EvidenceArchivePort.out-port.js';
import type { EvidenceAssessmentRepositoryPort } from '../../ports/out/EvidenceAssessmentRepositoryPort.out-port.js';
import type {
  ExecuteVerificationCheckRequest,
  ExecuteVerificationCheckResult,
  VerificationExecutorPort,
} from '../../ports/out/VerificationExecutorPort.out-port.js';
import { RequestVerificationUseCase } from '../RequestVerificationUseCase.use-case.js';

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

class StubExecutor implements VerificationExecutorPort {
  calls: ExecuteVerificationCheckRequest[] = [];

  async executeVerificationCheck(
    request: ExecuteVerificationCheckRequest,
  ): Promise<ExecuteVerificationCheckResult> {
    this.calls.push(request);
    return {
      result: 'pass',
      exitCode: 0,
      outputSummary: 'check passed',
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
    requiredChecks: ['lint'],
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

describe('RequestVerificationUseCase identity comparison (M13)', () => {
  it('refuses with typed rejected when candidate head does not match existing assessment', async () => {
    const existing = sampleRecord({ candidateHeadSha: HEAD1 });
    const repo = new InMemoryAssessmentRepo([existing]);
    const executor = new StubExecutor();
    const archive = new StubArchive();
    const useCase = new RequestVerificationUseCase({ repo, executor, archive });

    const result = await useCase.requestVerification({
      assessmentId: 'asm-1',
      projectId: 'proj-1',
      attemptId: 'att-1',
      candidateHeadSha: HEAD2, // mismatched head!
      policyRevision: 'pol-1',
      hostId: 'host-1',
      requiredChecks: ['lint'],
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain('head');
    }
    expect(executor.calls).toHaveLength(0);
    expect(archive.calls).toHaveLength(0);

    const stored = await repo.findAssessmentById('asm-1');
    expect(stored?.verificationReceipts).toHaveLength(0);
  });

  it('refuses with typed rejected when policy revision does not match existing assessment', async () => {
    const existing = sampleRecord({ policyRevision: 'pol-1' });
    const repo = new InMemoryAssessmentRepo([existing]);
    const executor = new StubExecutor();
    const archive = new StubArchive();
    const useCase = new RequestVerificationUseCase({ repo, executor, archive });

    const result = await useCase.requestVerification({
      assessmentId: 'asm-1',
      projectId: 'proj-1',
      attemptId: 'att-1',
      candidateHeadSha: HEAD1,
      policyRevision: 'pol-2', // mismatched policy revision!
      hostId: 'host-1',
      requiredChecks: ['lint'],
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain('policy revision');
    }
    expect(executor.calls).toHaveLength(0);
    expect(archive.calls).toHaveLength(0);
  });

  it('refuses with typed rejected when attemptId does not match existing assessment', async () => {
    const existing = sampleRecord({ attemptId: 'att-1' });
    const repo = new InMemoryAssessmentRepo([existing]);
    const executor = new StubExecutor();
    const archive = new StubArchive();
    const useCase = new RequestVerificationUseCase({ repo, executor, archive });

    const result = await useCase.requestVerification({
      assessmentId: 'asm-1',
      projectId: 'proj-1',
      attemptId: 'att-2', // mismatched attempt!
      candidateHeadSha: HEAD1,
      policyRevision: 'pol-1',
      hostId: 'host-1',
      requiredChecks: ['lint'],
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain('attempt');
    }
    expect(executor.calls).toHaveLength(0);
  });

  it('refuses with typed rejected when projectId does not match existing assessment', async () => {
    const existing = sampleRecord({ projectId: 'proj-1' });
    const repo = new InMemoryAssessmentRepo([existing]);
    const executor = new StubExecutor();
    const archive = new StubArchive();
    const useCase = new RequestVerificationUseCase({ repo, executor, archive });

    const result = await useCase.requestVerification({
      assessmentId: 'asm-1',
      projectId: 'proj-2', // mismatched project!
      attemptId: 'att-1',
      candidateHeadSha: HEAD1,
      policyRevision: 'pol-1',
      hostId: 'host-1',
      requiredChecks: ['lint'],
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain('project');
    }
    expect(executor.calls).toHaveLength(0);
  });

  it('completes verification and merges receipts when request matches existing assessment identity', async () => {
    const existing = sampleRecord({
      candidateHeadSha: HEAD1,
      policyRevision: 'pol-1',
      attemptId: 'att-1',
      projectId: 'proj-1',
    });
    const repo = new InMemoryAssessmentRepo([existing]);
    const executor = new StubExecutor();
    const archive = new StubArchive();
    const useCase = new RequestVerificationUseCase({ repo, executor, archive });

    const result = await useCase.requestVerification({
      assessmentId: 'asm-1',
      projectId: 'proj-1',
      attemptId: 'att-1',
      candidateHeadSha: HEAD1,
      policyRevision: 'pol-1',
      hostId: 'host-1',
      requiredChecks: ['lint'],
    });

    expect(result.outcome).toBe('completed');
    if (result.outcome === 'completed') {
      expect(result.receipts).toHaveLength(1);
      expect(result.receipts[0].procedureName).toBe('lint');
      expect(result.assessment.verificationReceipts).toHaveLength(1);
    }
  });

  it('creates a new assessment when none exists', async () => {
    const repo = new InMemoryAssessmentRepo([]);
    const executor = new StubExecutor();
    const archive = new StubArchive();
    const useCase = new RequestVerificationUseCase({ repo, executor, archive });

    const result = await useCase.requestVerification({
      assessmentId: 'asm-brand-new',
      projectId: 'proj-1',
      attemptId: 'att-1',
      candidateHeadSha: HEAD1,
      policyRevision: 'pol-1',
      hostId: 'host-1',
      requiredChecks: ['lint'],
    });

    expect(result.outcome).toBe('completed');
    const stored = await repo.findAssessmentById('asm-brand-new');
    expect(stored).not.toBeNull();
    expect(stored?.candidateHeadSha).toBe(HEAD1);
  });
});
