import { describe, expect, it } from 'vitest';

import type { EvidenceAssessmentRecord } from '../../../domain/evidence-records.js';
import type { EvidenceAssessmentRepositoryPort } from '../../ports/out/EvidenceAssessmentRepositoryPort.out-port.js';
import type { AttemptOwnerDecisionPort } from '../../ports/out/AttemptOwnerDecisionPort.out-port.js';
import { AssessHeadAcceptanceUseCase } from '../AssessHeadAcceptanceUseCase.use-case.js';

const HEAD = '1111111111111111111111111111111111111111';
const OTHER_HEAD = '2222222222222222222222222222222222222222';

/** An attempt whose frozen brief named no owner decisions. */
const NO_OWNER_DECISIONS: AttemptOwnerDecisionPort = {
  async readAttemptOwnerDecisionReferences() {
    return { outcome: 'recorded', ownerDecisionReferences: [] };
  },
};

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
    requiredChecks: [],
    state: 'pending',
    verificationReceipts: [],
    reviewReceipts: [
      {
        id: 'rr-1',
        assessmentId: 'asm-1',
        projectId: 'proj-1',
        attemptId: 'att-1',
        candidateHeadSha: HEAD,
        reviewerModel: 'seat-a/reviewer',
        implementerModel: 'seat-b/implementer',
        readOnlyVerified: true,
        result: 'pass',
        findings: [],
        evidenceRef: 'ref-1',
        policyRevision: 'pol-1',
        completedAtIso: '2026-10-15T12:00:00.000Z',
      },
    ],
    findingDispositions: [],
    acceptanceReceiptId: null,
    blockers: [],
    revision: 0,
    updatedAtIso: '2026-10-15T12:00:00.000Z',
    ...overrides,
  };
}

describe('AssessHeadAcceptanceUseCase', () => {
  it('re-assessing a stale record returns stale, not accepted', async () => {
    const staleRecord = sampleRecord({ state: 'stale' });
    const repo = new InMemoryAssessmentRepo([staleRecord]);
    const useCase = new AssessHeadAcceptanceUseCase({ repo, attemptOwnerDecisionPort: NO_OWNER_DECISIONS });

    const result = await useCase.assessHeadAcceptance({
      assessmentId: 'asm-1',
      candidateHeadSha: HEAD,
      policyRevision: 'pol-1',
    });

    expect(result.outcome).toBe('stale');
    if (result.outcome === 'stale') {
      expect(result.reason).toContain('stale');
    }
  });

  it('re-assessing an accepted record with the same head and policy returns the stored acceptance', async () => {
    // Idempotent by design (Fable should-fix on #47): a retry must not turn an
    // accepted head into a permanent failure.
    const acceptedRecord = sampleRecord({ state: 'accepted', acceptanceReceiptId: 'acc-1' });
    const repo = new InMemoryAssessmentRepo([acceptedRecord]);
    const useCase = new AssessHeadAcceptanceUseCase({ repo, attemptOwnerDecisionPort: NO_OWNER_DECISIONS });

    const result = await useCase.assessHeadAcceptance({
      assessmentId: 'asm-1',
      candidateHeadSha: HEAD,
      policyRevision: 'pol-1',
    });

    expect(result.outcome).toBe('accepted');
    expect(JSON.stringify(result)).toContain('acc-1');
  });

  it('re-assessing a rejected record returns rejected', async () => {
    const rejectedRecord = sampleRecord({ state: 'rejected' });
    const repo = new InMemoryAssessmentRepo([rejectedRecord]);
    const useCase = new AssessHeadAcceptanceUseCase({ repo, attemptOwnerDecisionPort: NO_OWNER_DECISIONS });

    const result = await useCase.assessHeadAcceptance({
      assessmentId: 'asm-1',
      candidateHeadSha: HEAD,
      policyRevision: 'pol-1',
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain('terminal state');
    }
  });

  it('marks assessment stale when head changes, and subsequent assessment returns stale', async () => {
    const pendingRecord = sampleRecord({ state: 'pending' });
    const repo = new InMemoryAssessmentRepo([pendingRecord]);
    const useCase = new AssessHeadAcceptanceUseCase({ repo, attemptOwnerDecisionPort: NO_OWNER_DECISIONS });

    // Request with different head sha
    const firstResult = await useCase.assessHeadAcceptance({
      assessmentId: 'asm-1',
      candidateHeadSha: OTHER_HEAD,
      policyRevision: 'pol-1',
    });
    expect(firstResult.outcome).toBe('stale');

    const stored = await repo.findAssessmentById('asm-1');
    expect(stored?.state).toBe('stale');

    // Second request with original head - record is now stale, so it must return stale!
    const secondResult = await useCase.assessHeadAcceptance({
      assessmentId: 'asm-1',
      candidateHeadSha: HEAD,
      policyRevision: 'pol-1',
    });
    expect(secondResult.outcome).toBe('stale');
  });

  it('accepts a pending assessment with passing evidence', async () => {
    const pendingRecord = sampleRecord({ state: 'pending' });
    const repo = new InMemoryAssessmentRepo([pendingRecord]);
    const useCase = new AssessHeadAcceptanceUseCase({ repo, attemptOwnerDecisionPort: NO_OWNER_DECISIONS });

    const result = await useCase.assessHeadAcceptance({
      assessmentId: 'asm-1',
      candidateHeadSha: HEAD,
      policyRevision: 'pol-1',
    });

    expect(result.outcome).toBe('accepted');
    if (result.outcome === 'accepted') {
      expect(result.receiptId).toContain('acc-asm-1');
      expect(result.assessment.state).toBe('accepted');
    }
  });
});
