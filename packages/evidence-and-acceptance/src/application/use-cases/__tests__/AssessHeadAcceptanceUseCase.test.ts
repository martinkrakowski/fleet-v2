import { describe, expect, it } from 'vitest';

import type {
  EvidenceAssessmentRecord,
  ReviewFindingRecord,
  ReviewReceiptRecord,
} from '../../../domain/evidence-records.js';
import type { EvidenceAssessmentRepositoryPort } from '../../ports/out/EvidenceAssessmentRepositoryPort.out-port.js';
import type { AttemptOwnerDecisionPort } from '../../ports/out/AttemptOwnerDecisionPort.out-port.js';
import { AssessHeadAcceptanceUseCase } from '../AssessHeadAcceptanceUseCase.use-case.js';
import { RecordFindingDispositionUseCase } from '../RecordFindingDispositionUseCase.use-case.js';

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
    implementerModel: 'seat-b/implementer',
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

function finding(findingId: string, overrides: Partial<ReviewFindingRecord> = {}): ReviewFindingRecord {
  return {
    findingId,
    severity: 'major',
    summary: `summary for ${findingId}`,
    filePath: 'src/a.ts',
    line: 12,
    state: 'unresolved',
    dispositionReason: null,
    dispositionEvidenceRef: null,
    ...overrides,
  };
}

function independentReviewReceiptWithFindings(
  findings: readonly ReviewFindingRecord[],
  overrides: Partial<ReviewReceiptRecord> = {},
): ReviewReceiptRecord {
  return {
    id: 'rr-1',
    assessmentId: 'asm-1',
    projectId: 'proj-1',
    attemptId: 'att-1',
    candidateHeadSha: HEAD,
    reviewerModel: 'seat-a/reviewer',
    implementerModel: 'seat-b/implementer',
    readOnlyVerified: true,
    result: 'pass',
    findings,
    evidenceRef: 'ref-1',
    policyRevision: 'pol-1',
    completedAtIso: '2026-10-15T12:00:00.000Z',
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

  it('blocks acceptance when a seeded review receipt shares the implementer model family', async () => {
    const violating = sampleRecord({
      implementerModel: 'nvidia/abc/model-x',
      reviewReceipts: [
        {
          id: 'rr-bad',
          assessmentId: 'asm-1',
          projectId: 'proj-1',
          attemptId: 'att-1',
          candidateHeadSha: HEAD,
          reviewerModel: 'openrouter/abc/model-x',
          implementerModel: 'seat-c/impostor',
          readOnlyVerified: true,
          result: 'pass',
          findings: [],
          evidenceRef: 'ref-1',
          policyRevision: 'pol-1',
          completedAtIso: '2026-10-15T12:00:00.000Z',
        },
      ],
    });
    const repo = new InMemoryAssessmentRepo([violating]);
    const useCase = new AssessHeadAcceptanceUseCase({ repo });

    const result = await useCase.assessHeadAcceptance({
      assessmentId: 'asm-1',
      candidateHeadSha: HEAD,
      policyRevision: 'pol-1',
    });

    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.blockers.join('\n')).toContain('rr-bad');
      expect(result.blockers.join('\n')).toContain('not independent');
    }
  });

  it('blocks acceptance when a seeded review receipt records a different implementer seat', async () => {
    const violating = sampleRecord({
      reviewReceipts: [
        {
          id: 'rr-seat',
          assessmentId: 'asm-1',
          projectId: 'proj-1',
          attemptId: 'att-1',
          candidateHeadSha: HEAD,
          reviewerModel: 'seat-a/reviewer',
          implementerModel: 'seat-c/impostor',
          readOnlyVerified: true,
          result: 'pass',
          findings: [],
          evidenceRef: 'ref-1',
          policyRevision: 'pol-1',
          completedAtIso: '2026-10-15T12:00:00.000Z',
        },
      ],
    });
    const repo = new InMemoryAssessmentRepo([violating]);
    const useCase = new AssessHeadAcceptanceUseCase({ repo });

    const result = await useCase.assessHeadAcceptance({
      assessmentId: 'asm-1',
      candidateHeadSha: HEAD,
      policyRevision: 'pol-1',
    });

    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.blockers.join('\n')).toContain('rr-seat');
      expect(result.blockers.join('\n')).toContain('records implementer');
    }
  });

  it('blocks acceptance when the only review finding arrives pre-marked fixed until a fixed disposition resolves it', async () => {
    const record = sampleRecord({
      reviewReceipts: [independentReviewReceiptWithFindings([finding('f-1', { state: 'fixed' })])],
    });
    const repo = new InMemoryAssessmentRepo([record]);
    const assess = new AssessHeadAcceptanceUseCase({ repo, attemptOwnerDecisionPort: NO_OWNER_DECISIONS });

    const blocked = await assess.assessHeadAcceptance({
      assessmentId: 'asm-1',
      candidateHeadSha: HEAD,
      policyRevision: 'pol-1',
    });
    expect(blocked.outcome).toBe('blocked');
    if (blocked.outcome === 'blocked') {
      expect(blocked.blockers).toContain("finding 'f-1' is unresolved");
    }

    const dispositionUseCase = new RecordFindingDispositionUseCase({ repo });
    const recorded = await dispositionUseCase.recordFindingDisposition({
      assessmentId: 'asm-1',
      disposition: {
        id: 'fd-1',
        assessmentId: 'asm-1',
        findingId: 'f-1',
        candidateHeadSha: HEAD,
        state: 'fixed',
        reason: 'patched in the candidate head',
        evidenceRef: 'evidence://fix-f-1',
        recordedBy: 'orchestrator',
        recordedAtIso: '2026-10-16T00:00:00.000Z',
      },
    });
    expect(recorded.outcome).toBe('recorded');

    const accepted = await assess.assessHeadAcceptance({
      assessmentId: 'asm-1',
      candidateHeadSha: HEAD,
      policyRevision: 'pol-1',
    });
    expect(accepted.outcome).toBe('accepted');
    if (accepted.outcome === 'accepted') {
      expect(accepted.assessment.blockers).toEqual([]);
    }
  });

  it('blocks acceptance when the only review finding arrives pre-marked refuted until a refuted disposition resolves it', async () => {
    const record = sampleRecord({
      reviewReceipts: [independentReviewReceiptWithFindings([finding('f-1', { state: 'refuted' })])],
    });
    const repo = new InMemoryAssessmentRepo([record]);
    const assess = new AssessHeadAcceptanceUseCase({ repo, attemptOwnerDecisionPort: NO_OWNER_DECISIONS });

    const blocked = await assess.assessHeadAcceptance({
      assessmentId: 'asm-1',
      candidateHeadSha: HEAD,
      policyRevision: 'pol-1',
    });
    expect(blocked.outcome).toBe('blocked');
    if (blocked.outcome === 'blocked') {
      expect(blocked.blockers).toContain("finding 'f-1' is unresolved");
    }

    const dispositionUseCase = new RecordFindingDispositionUseCase({ repo });
    const recorded = await dispositionUseCase.recordFindingDisposition({
      assessmentId: 'asm-1',
      disposition: {
        id: 'fd-1',
        assessmentId: 'asm-1',
        findingId: 'f-1',
        candidateHeadSha: HEAD,
        state: 'refuted',
        reason: 'reproduced and the claim does not hold',
        evidenceRef: 'evidence://refutation-f-1',
        recordedBy: 'orchestrator',
        recordedAtIso: '2026-10-16T00:00:00.000Z',
      },
    });
    expect(recorded.outcome).toBe('recorded');

    const accepted = await assess.assessHeadAcceptance({
      assessmentId: 'asm-1',
      candidateHeadSha: HEAD,
      policyRevision: 'pol-1',
    });
    expect(accepted.outcome).toBe('accepted');
    if (accepted.outcome === 'accepted') {
      expect(accepted.assessment.blockers).toEqual([]);
    }
  });

  it('reports a finding present in two receipts once', async () => {
    const record = sampleRecord({
      reviewReceipts: [
        independentReviewReceiptWithFindings([finding('f-1', { state: 'fixed' })]),
        independentReviewReceiptWithFindings([finding('f-1', { state: 'refuted' })], {
          id: 'rr-2',
          reviewerModel: 'seat-c/reviewer',
        }),
      ],
    });
    const repo = new InMemoryAssessmentRepo([record]);
    const assess = new AssessHeadAcceptanceUseCase({ repo, attemptOwnerDecisionPort: NO_OWNER_DECISIONS });

    const result = await assess.assessHeadAcceptance({
      assessmentId: 'asm-1',
      candidateHeadSha: HEAD,
      policyRevision: 'pol-1',
    });
    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      const findingBlockers = result.blockers.filter(
        (blocker) => blocker === "finding 'f-1' is unresolved",
      );
      expect(findingBlockers).toHaveLength(1);
    }
  });
});

describe('review kind pass gate (PC-1)', () => {
  it('does not accept a passing brief-check receipt alone', async () => {
    const record = sampleRecord({
      reviewReceipts: [independentReviewReceiptWithFindings([], { kind: 'brief-check' })],
    });
    const repo = new InMemoryAssessmentRepo([record]);
    const useCase = new AssessHeadAcceptanceUseCase({ repo, attemptOwnerDecisionPort: NO_OWNER_DECISIONS });

    const result = await useCase.assessHeadAcceptance({
      assessmentId: 'asm-1',
      candidateHeadSha: HEAD,
      policyRevision: 'pol-1',
    });
    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.blockers).toContain('no read-only independent review passed for this candidate head');
    }
  });

  it('accepts a passing code-review alongside a passing brief-check', async () => {
    const record = sampleRecord({
      reviewReceipts: [
        independentReviewReceiptWithFindings([], { kind: 'brief-check' }),
        independentReviewReceiptWithFindings([], { id: 'rr-2', kind: 'code-review' }),
      ],
    });
    const repo = new InMemoryAssessmentRepo([record]);
    const useCase = new AssessHeadAcceptanceUseCase({ repo, attemptOwnerDecisionPort: NO_OWNER_DECISIONS });

    const result = await useCase.assessHeadAcceptance({
      assessmentId: 'asm-1',
      candidateHeadSha: HEAD,
      policyRevision: 'pol-1',
    });
    expect(result.outcome).toBe('accepted');
  });

  it('blocks a failing brief-check even alongside a passing code-review', async () => {
    const record = sampleRecord({
      reviewReceipts: [
        independentReviewReceiptWithFindings([], { kind: 'brief-check', result: 'fail' }),
        independentReviewReceiptWithFindings([], { id: 'rr-2', kind: 'code-review' }),
      ],
    });
    const repo = new InMemoryAssessmentRepo([record]);
    const useCase = new AssessHeadAcceptanceUseCase({ repo, attemptOwnerDecisionPort: NO_OWNER_DECISIONS });

    const result = await useCase.assessHeadAcceptance({
      assessmentId: 'asm-1',
      candidateHeadSha: HEAD,
      policyRevision: 'pol-1',
    });
    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.blockers.join('\n')).toContain("review by 'seat-a/reviewer' failed");
    }
  });

  it('treats a kind-less passing receipt exactly as on main', async () => {
    const record = sampleRecord(); // the default review receipt has no kind and passes
    const repo = new InMemoryAssessmentRepo([record]);
    const useCase = new AssessHeadAcceptanceUseCase({ repo, attemptOwnerDecisionPort: NO_OWNER_DECISIONS });

    const result = await useCase.assessHeadAcceptance({
      assessmentId: 'asm-1',
      candidateHeadSha: HEAD,
      policyRevision: 'pol-1',
    });
    expect(result.outcome).toBe('accepted');
  });
});
