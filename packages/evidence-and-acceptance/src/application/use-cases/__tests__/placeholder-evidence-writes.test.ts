import { describe, expect, it } from 'vitest';

import type {
  EvidenceAssessmentRecord,
  ReviewFindingRecord,
  ReviewReceiptRecord,
} from '../../../domain/evidence-records.js';
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
import type {
  ExecuteVerificationCheckRequest,
  ExecuteVerificationCheckResult,
  VerificationExecutorPort,
} from '../../ports/out/VerificationExecutorPort.out-port.js';
import { RecordFindingDispositionUseCase } from '../RecordFindingDispositionUseCase.use-case.js';
import { RecordReviewReceiptUseCase } from '../RecordReviewReceiptUseCase.use-case.js';
import { RecordVerificationReceiptUseCase } from '../RecordVerificationReceiptUseCase.use-case.js';
import { RequestIndependentReviewUseCase } from '../RequestIndependentReviewUseCase.use-case.js';
import { RequestVerificationUseCase } from '../RequestVerificationUseCase.use-case.js';

const HEAD1 = '1111111111111111111111111111111111111111';

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

class StubReviewer implements IndependentReviewPort {
  calls: RunIndependentReviewRequest[] = [];

  constructor(private readonly findings: readonly ReviewFindingRecord[] = []) {}

  async runIndependentReview(
    request: RunIndependentReviewRequest,
  ): Promise<RunIndependentReviewResult> {
    this.calls.push(request);
    return {
      outcome: 'completed',
      readOnlyVerified: true,
      result: 'pass',
      findings: this.findings,
      rawOutput: 'clean review',
      completedAtIso: '2026-10-15T12:00:00.000Z',
    };
  }
}

class StubArchive implements EvidenceArchivePort {
  calls: ArchiveEvidenceRequest[] = [];

  constructor(private readonly evidenceRef?: string) {}

  async archiveEvidence(request: ArchiveEvidenceRequest): Promise<ArchiveEvidenceResult> {
    this.calls.push(request);
    return {
      evidenceRef: this.evidenceRef ?? `ref-${request.artifactId}`,
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
    implementerModel: 'anthropic/claude-3-5-sonnet',
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

function sampleReceipt(overrides: Partial<ReviewReceiptRecord> = {}): ReviewReceiptRecord {
  return {
    id: 'rr-1',
    assessmentId: 'asm-1',
    projectId: 'proj-1',
    attemptId: 'att-1',
    candidateHeadSha: HEAD1,
    reviewerModel: 'openai/gpt-4o',
    implementerModel: 'anthropic/claude-3-5-sonnet',
    readOnlyVerified: true,
    result: 'pass',
    findings: [],
    evidenceRef: 'ref-1',
    policyRevision: 'pol-1',
    completedAtIso: '2026-10-15T12:00:00.000Z',
    ...overrides,
  };
}

function sampleFinding(overrides: Partial<ReviewFindingRecord> = {}): ReviewFindingRecord {
  return {
    findingId: 'f-1',
    severity: 'major',
    summary: 'finding summary',
    filePath: null,
    line: null,
    state: 'unresolved',
    dispositionReason: null,
    dispositionEvidenceRef: null,
    ...overrides,
  };
}

describe('placeholder evidence refusals on new writes (A2, D1)', () => {
  it('refuses a review receipt whose evidenceRef is a whole placeholder', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const useCase = new RecordReviewReceiptUseCase({ repo });

    const result = await useCase.recordReviewReceipt({
      assessmentId: 'asm-1',
      receipt: sampleReceipt({ evidenceRef: 'n/a' }),
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain('evidenceRef');
      expect(result.reason).not.toContain('n/a');
    }
    expect((await repo.findAssessmentById('asm-1'))?.revision).toBe(0);
  });

  it('names the finding summary when it is a whole placeholder, without echoing it', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const useCase = new RecordReviewReceiptUseCase({ repo });

    const result = await useCase.recordReviewReceipt({
      assessmentId: 'asm-1',
      receipt: sampleReceipt({
        findings: [sampleFinding({ summary: 'should work' })],
      }),
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain('findings[0].summary');
      expect(result.reason).not.toContain('should work');
    }
    expect((await repo.findAssessmentById('asm-1'))?.revision).toBe(0);
  });

  it('accepts a D2 sentence as a review finding summary', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const useCase = new RecordReviewReceiptUseCase({ repo });

    const result = await useCase.recordReviewReceipt({
      assessmentId: 'asm-1',
      receipt: sampleReceipt({
        findings: [sampleFinding({ summary: 'Seems the lock is released twice at line 40' })],
      }),
    });

    expect(result.outcome).toBe('recorded');
  });

  it('accepts a todo.ts:40 evidenceRef on a review receipt', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const useCase = new RecordReviewReceiptUseCase({ repo });

    const result = await useCase.recordReviewReceipt({
      assessmentId: 'asm-1',
      receipt: sampleReceipt({ evidenceRef: 'todo.ts:40' }),
    });

    expect(result.outcome).toBe('recorded');
  });

  it('refuses an independent review whose finding summary is a whole placeholder', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const reviewer = new StubReviewer([sampleFinding({ summary: 'LGTM' })]);
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

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain('findings[0].summary');
      expect(result.reason).not.toContain('LGTM');
    }
    expect((await repo.findAssessmentById('asm-1'))?.revision).toBe(0);
  });

  it('accepts an independent review with a TODO-prefixed finding summary', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const reviewer = new StubReviewer([sampleFinding({ summary: 'TODO: null check missing at line 40' })]);
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
  });

  it('refuses an independent review whose archived evidenceRef is a whole placeholder; accepts real refs', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const reviewer = new StubReviewer();

    const placeholderUseCase = new RequestIndependentReviewUseCase({
      repo,
      reviewer,
      archive: new StubArchive('TBD'),
    });
    const placeholderResult = await placeholderUseCase.requestIndependentReview({
      assessmentId: 'asm-1',
      projectId: 'proj-1',
      attemptId: 'att-1',
      candidateHeadSha: HEAD1,
      policyRevision: 'pol-1',
      implementerModel: 'anthropic/claude-3-5-sonnet',
      reviewerModel: 'openai/gpt-4o',
    });
    expect(placeholderResult.outcome).toBe('rejected');
    if (placeholderResult.outcome === 'rejected') {
      expect(placeholderResult.reason).toContain('evidenceRef');
      expect(placeholderResult.reason).not.toContain('TBD');
    }
    expect((await repo.findAssessmentById('asm-1'))?.revision).toBe(0);

    const defaultUseCase = new RequestIndependentReviewUseCase({
      repo,
      reviewer,
      archive: new StubArchive(),
    });
    const defaultResult = await defaultUseCase.requestIndependentReview({
      assessmentId: 'asm-1',
      projectId: 'proj-1',
      attemptId: 'att-1',
      candidateHeadSha: HEAD1,
      policyRevision: 'pol-1',
      implementerModel: 'anthropic/claude-3-5-sonnet',
      reviewerModel: 'openai/gpt-4o',
    });
    expect(defaultResult.outcome).toBe('reviewed');
  });

  it('refuses a verification receipt whose evidenceRef is a whole placeholder', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const useCase = new RecordVerificationReceiptUseCase({ repo });

    const result = await useCase.recordVerificationReceipt({
      assessmentId: 'asm-1',
      receipt: {
        id: 'vr-1',
        assessmentId: 'asm-1',
        projectId: 'proj-1',
        attemptId: 'att-1',
        candidateHeadSha: HEAD1,
        hostId: 'host-1',
        procedureName: 'lint',
        result: 'pass',
        exitCode: 0,
        evidenceRef: 'n/a',
        policyRevision: 'pol-1',
        completedAtIso: '2026-10-15T12:00:00.000Z',
      },
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain('evidenceRef');
      expect(result.reason).not.toContain('n/a');
    }
    expect((await repo.findAssessmentById('asm-1'))?.revision).toBe(0);
  });

  it('refuses a requested verification whose archive returns a whole placeholder reference, leaving nothing stored', async () => {
    const repo = new InMemoryAssessmentRepo([]);
    const executor = new StubExecutor();
    const archive = new StubArchive('n/a');
    const useCase = new RequestVerificationUseCase({ repo, executor, archive });

    const result = await useCase.requestVerification({
      assessmentId: 'asm-new-1',
      projectId: 'proj-1',
      attemptId: 'att-1',
      candidateHeadSha: HEAD1,
      policyRevision: 'pol-1',
      hostId: 'host-1',
      implementerModel: 'anthropic/claude-3-5-sonnet',
      requiredChecks: ['lint'],
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain('evidenceRef');
      expect(result.reason).not.toContain('n/a');
    }
    expect(await repo.findAssessmentById('asm-new-1')).toBeNull();
  });

  it('refuses a disposition whose reason or evidenceRef is a placeholder', async () => {
    const repo = new InMemoryAssessmentRepo([
      sampleRecord({ reviewReceipts: [sampleReceipt({ findings: [sampleFinding()] })] }),
    ]);
    const useCase = new RecordFindingDispositionUseCase({ repo });

    const reasonResult = await useCase.recordFindingDisposition({
      assessmentId: 'asm-1',
      disposition: {
        id: 'fd-1',
        assessmentId: 'asm-1',
        findingId: 'f-1',
        candidateHeadSha: HEAD1,
        state: 'fixed',
        reason: 'n/a',
        evidenceRef: 'ref-fd-1',
        recordedBy: 'checker-1',
        recordedAtIso: '2026-10-15T12:00:00.000Z',
      },
    });
    expect(reasonResult.outcome).toBe('rejected');
    if (reasonResult.outcome === 'rejected') {
      expect(reasonResult.reason).toContain('reason');
      expect(reasonResult.reason).not.toContain('n/a');
    }

    const evidenceResult = await useCase.recordFindingDisposition({
      assessmentId: 'asm-1',
      disposition: {
        id: 'fd-2',
        assessmentId: 'asm-1',
        findingId: 'f-1',
        candidateHeadSha: HEAD1,
        state: 'fixed',
        reason: 'Fixed at line 12',
        evidenceRef: 'TODO',
        recordedBy: 'checker-1',
        recordedAtIso: '2026-10-15T12:00:00.000Z',
      },
    });
    expect(evidenceResult.outcome).toBe('rejected');
    if (evidenceResult.outcome === 'rejected') {
      expect(evidenceResult.reason).toContain('evidenceRef');
      expect(evidenceResult.reason).not.toContain('TODO');
    }
    expect((await repo.findAssessmentById('asm-1'))?.revision).toBe(0);
  });

  it('records a disposition on a pre-A2 assessment whose stored records hold placeholders (D1)', async () => {
    const repo = new InMemoryAssessmentRepo([
      sampleRecord({
        reviewReceipts: [sampleReceipt({ evidenceRef: 'n/a', findings: [sampleFinding({ summary: 'n/a' })] })],
      }),
    ]);
    const useCase = new RecordFindingDispositionUseCase({ repo });

    const result = await useCase.recordFindingDisposition({
      assessmentId: 'asm-1',
      disposition: {
        id: 'fd-1',
        assessmentId: 'asm-1',
        findingId: 'f-1',
        candidateHeadSha: HEAD1,
        state: 'fixed',
        reason: 'None of the tests passed at line 40',
        evidenceRef: 'ref-fd-1',
        recordedBy: 'checker-1',
        recordedAtIso: '2026-10-15T12:00:00.000Z',
      },
    });

    expect(result.outcome).toBe('recorded');
  });
});
