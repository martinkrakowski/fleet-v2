import { describe, expect, it } from 'vitest';

import type {
  EvidenceAssessmentRecord,
  ReviewReceiptRecord,
} from '../../../domain/evidence-records.js';
import type { EvidenceAssessmentRepositoryPort } from '../../ports/out/EvidenceAssessmentRepositoryPort.out-port.js';
import type {
  CheckReviewerSeatRequest,
  EvidenceSeatPolicyPort,
  ReviewerSeatCheck,
} from '../../ports/out/EvidenceSeatPolicyPort.out-port.js';
import { RecordReviewReceiptUseCase } from '../RecordReviewReceiptUseCase.use-case.js';

const HEAD = '1111111111111111111111111111111111111111';

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

function sampleRecord(overrides: Partial<EvidenceAssessmentRecord> = {}): EvidenceAssessmentRecord {
  return {
    id: 'asm-1',
    projectId: 'proj-1',
    attemptId: 'att-1',
    candidateHeadSha: HEAD,
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

class StubSeatPolicy implements EvidenceSeatPolicyPort {
  calls: string[] = [];

  constructor(private readonly result: ReviewerSeatCheck) {}

  async checkReviewerSeat(request: CheckReviewerSeatRequest): Promise<ReviewerSeatCheck> {
    this.calls.push(request.reviewerModel);
    return this.result;
  }
}

function sampleReceipt(overrides: Partial<ReviewReceiptRecord> = {}): ReviewReceiptRecord {
  return {
    id: 'rr-1',
    assessmentId: 'asm-1',
    projectId: 'proj-1',
    attemptId: 'att-1',
    candidateHeadSha: HEAD,
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

describe('RecordReviewReceiptUseCase blank model handling', () => {
  it('treats an empty reviewerModel string as typed rejection, never throwing', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const useCase = new RecordReviewReceiptUseCase({ repo });

    const receipt = sampleReceipt({ reviewerModel: '' });

    const result = await useCase.recordReviewReceipt({
      assessmentId: 'asm-1',
      receipt,
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain('reviewerModel');
    }
  });

  it('treats a whitespace-only reviewerModel as typed rejection, never throwing', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const useCase = new RecordReviewReceiptUseCase({ repo });

    const receipt = sampleReceipt({ reviewerModel: '   ' });

    const result = await useCase.recordReviewReceipt({
      assessmentId: 'asm-1',
      receipt,
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain('reviewerModel');
    }
  });

  it('treats an empty implementerModel string as typed rejection, never throwing', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const useCase = new RecordReviewReceiptUseCase({ repo });

    const receipt = sampleReceipt({ implementerModel: '' });

    const result = await useCase.recordReviewReceipt({
      assessmentId: 'asm-1',
      receipt,
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain('implementerModel');
    }
  });

  it('treats a whitespace-only implementerModel as typed rejection, never throwing', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const useCase = new RecordReviewReceiptUseCase({ repo });

    const receipt = sampleReceipt({ implementerModel: '   ' });

    const result = await useCase.recordReviewReceipt({
      assessmentId: 'asm-1',
      receipt,
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain('implementerModel');
    }
  });

  it('rejects when reviewerModel and implementerModel share the same underlying model', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const useCase = new RecordReviewReceiptUseCase({ repo });

    const receipt = sampleReceipt({
      reviewerModel: 'openrouter/claude-3-5-sonnet',
      implementerModel: 'anthropic/claude-3-5-sonnet',
    });

    const result = await useCase.recordReviewReceipt({
      assessmentId: 'asm-1',
      receipt,
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain('shares the same underlying model as the implementer');
    }
  });

  it('records a valid review receipt successfully', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const useCase = new RecordReviewReceiptUseCase({ repo });

    const receipt = sampleReceipt();

    const result = await useCase.recordReviewReceipt({
      assessmentId: 'asm-1',
      receipt,
    });

    expect(result.outcome).toBe('recorded');
    if (result.outcome === 'recorded') {
      expect(result.assessment.reviewReceipts).toHaveLength(1);
    }
    const stored = await repo.findAssessmentById('asm-1');
    expect(stored?.reviewReceipts).toHaveLength(1);
  });

  it('refuses a receipt claiming the implementer seat with a fake implementer field', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const useCase = new RecordReviewReceiptUseCase({ repo });

    // The reviewer IS the implementer's own model, dressed up with a receipt
    // implementer field that differs from the assessment's recorded seat.
    const receipt = sampleReceipt({
      reviewerModel: 'bedrock/anthropic/claude-3-5-sonnet',
      implementerModel: 'openai/gpt-4o',
    });

    const result = await useCase.recordReviewReceipt({
      assessmentId: 'asm-1',
      receipt,
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain("claims implementer 'openai/gpt-4o'");
      expect(result.reason).toContain('claude-3-5-sonnet');
    }
    const stored = await repo.findAssessmentById('asm-1');
    expect(stored?.reviewReceipts).toHaveLength(0);
  });

  it('refuses a receipt whose implementer field differs from the recorded seat', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const useCase = new RecordReviewReceiptUseCase({ repo });

    const receipt = sampleReceipt({ implementerModel: 'openai/gpt-4o' });

    const result = await useCase.recordReviewReceipt({
      assessmentId: 'asm-1',
      receipt,
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain('was implemented on seat');
    }
    const stored = await repo.findAssessmentById('asm-1');
    expect(stored?.reviewReceipts).toHaveLength(0);
  });
});

describe('free-seat policy and requested reviewer (FS3b)', () => {
  it('refuses a receipt naming a reviewer other than the requested one', async () => {
    const repo = new InMemoryAssessmentRepo([
      sampleRecord({ requestedReviewerModel: 'openai/gpt-4o' }),
    ]);
    const useCase = new RecordReviewReceiptUseCase({ repo });

    const result = await useCase.recordReviewReceipt({
      assessmentId: 'asm-1',
      receipt: sampleReceipt({ reviewerModel: 'openai/gpt-5' }),
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain("requested reviewer 'openai/gpt-4o'");
    }
    const stored = await repo.findAssessmentById('asm-1');
    expect(stored?.reviewReceipts).toHaveLength(0);
  });

  it('records a receipt naming the requested reviewer', async () => {
    const repo = new InMemoryAssessmentRepo([
      sampleRecord({ requestedReviewerModel: 'openai/gpt-4o' }),
    ]);
    const useCase = new RecordReviewReceiptUseCase({ repo });

    const result = await useCase.recordReviewReceipt({
      assessmentId: 'asm-1',
      receipt: sampleReceipt(),
    });

    expect(result.outcome).toBe('recorded');
    const stored = await repo.findAssessmentById('asm-1');
    expect(stored?.reviewReceipts).toHaveLength(1);
  });

  it('keeps today behaviour when no review was requested', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const useCase = new RecordReviewReceiptUseCase({ repo });

    const result = await useCase.recordReviewReceipt({
      assessmentId: 'asm-1',
      receipt: sampleReceipt(),
    });

    expect(result.outcome).toBe('recorded');
    const stored = await repo.findAssessmentById('asm-1');
    expect(stored?.reviewReceipts).toHaveLength(1);
  });

  it('refuses with the seat policy reason and does not save', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const seatPolicy = new StubSeatPolicy({
      outcome: 'refused',
      reason: 'reviewer model is free',
    });
    const useCase = new RecordReviewReceiptUseCase({ repo, seatPolicy });

    const result = await useCase.recordReviewReceipt({
      assessmentId: 'asm-1',
      receipt: sampleReceipt(),
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toBe('reviewer model is free');
    }
    const stored = await repo.findAssessmentById('asm-1');
    expect(stored?.revision).toBe(0);
  });

  it('refuses when the requested reviewer matches but the seat policy refuses', async () => {
    const repo = new InMemoryAssessmentRepo([
      sampleRecord({ requestedReviewerModel: 'openai/gpt-4o' }),
    ]);
    const seatPolicy = new StubSeatPolicy({
      outcome: 'refused',
      reason: 'reviewer model is free',
    });
    const useCase = new RecordReviewReceiptUseCase({ repo, seatPolicy });

    const result = await useCase.recordReviewReceipt({
      assessmentId: 'asm-1',
      receipt: sampleReceipt(),
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toBe('reviewer model is free');
    }
  });
});
