import { describe, expect, it } from 'vitest';
import type { EvidenceAssessmentRecord } from '../../domain/evidence-records.js';
import type { EvidenceAssessmentRepositoryPort } from '../ports/out/EvidenceAssessmentRepositoryPort.out-port.js';
import type {
  OwnerDecisionPort,
  OwnerDecisionResult,
  ResolveOwnerDecisionRequest,
} from '../ports/out/OwnerDecisionPort.out-port.js';
import { AssessHeadAcceptanceUseCase } from './AssessHeadAcceptanceUseCase.use-case.js';

class InMemoryEvidenceAssessmentRepo implements EvidenceAssessmentRepositoryPort {
  constructor(public assessment: EvidenceAssessmentRecord | null) {}

  async findAssessmentById(id: string): Promise<EvidenceAssessmentRecord | null> {
    return this.assessment && this.assessment.id === id ? this.assessment : null;
  }

  async findAssessmentByHead(candidateHeadSha: string): Promise<EvidenceAssessmentRecord | null> {
    return this.assessment && this.assessment.candidateHeadSha === candidateHeadSha
      ? this.assessment
      : null;
  }

  async saveAssessment(assessment: EvidenceAssessmentRecord): Promise<void> {
    this.assessment = assessment;
  }
}

class InMemoryOwnerDecisionPort implements OwnerDecisionPort {
  constructor(private readonly result: OwnerDecisionResult) {}

  async resolveOwnerDecision(_request: ResolveOwnerDecisionRequest): Promise<OwnerDecisionResult> {
    return this.result;
  }
}

function makePassingAssessmentRecord(
  overrides?: Partial<EvidenceAssessmentRecord>,
): EvidenceAssessmentRecord {
  return {
    id: 'assessment-att-1',
    projectId: 'proj-1',
    attemptId: 'att-1',
    candidateHeadSha: '1111111111111111111111111111111111111111',
    policyRevision: 'pol-1',
    requiredChecks: [],
    state: 'pending',
    verificationReceipts: [],
    reviewReceipts: [
      {
        id: 'review-1',
        assessmentId: 'assessment-att-1',
        projectId: 'proj-1',
        attemptId: 'att-1',
        candidateHeadSha: '1111111111111111111111111111111111111111',
        reviewerModel: 'reviewer-model',
        implementerModel: 'implementer-model',
        readOnlyVerified: true,
        result: 'pass',
        findings: [],
        evidenceRef: 'evidence-ref-1',
        policyRevision: 'pol-1',
        completedAtIso: '2026-10-15T10:00:00Z',
      },
    ],
    findingDispositions: [],
    acceptanceReceiptId: null,
    blockers: [],
    revision: 1,
    updatedAtIso: '2026-10-15T10:00:00Z',
    ...overrides,
  };
}

describe('AssessHeadAcceptanceUseCase (M15: Owner Decision / One-Way Door)', () => {
  const candidateHeadSha = '1111111111111111111111111111111111111111';

  it('undecided one-way door -> acceptance blocked', async () => {
    const repo = new InMemoryEvidenceAssessmentRepo(makePassingAssessmentRecord());
    const ownerDecisionPort = new InMemoryOwnerDecisionPort({
      outcome: 'resolved',
      decision: {
        id: 'req-door-1',
        state: 'awaiting-decision',
        expectedHeadSha: candidateHeadSha,
      },
    });

    const useCase = new AssessHeadAcceptanceUseCase({
      repo,
      ownerDecisionPort,
    });

    const result = await useCase.assessHeadAcceptance({
      assessmentId: 'assessment-att-1',
      candidateHeadSha,
      policyRevision: 'pol-1',
      ownerDecisionReferences: ['door-1'],
    });

    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.blockers.some((b) => b.includes("state 'awaiting-decision', not 'approved'"))).toBe(true);
    }
    expect(repo.assessment?.state).toBe('blocked');
  });

  it('unresolvable one-way door -> acceptance blocked', async () => {
    const repo = new InMemoryEvidenceAssessmentRepo(makePassingAssessmentRecord());
    const ownerDecisionPort = new InMemoryOwnerDecisionPort({
      outcome: 'unresolvable',
      reason: 'No coordination request found for reference door-missing',
    });

    const useCase = new AssessHeadAcceptanceUseCase({
      repo,
      ownerDecisionPort,
    });

    const result = await useCase.assessHeadAcceptance({
      assessmentId: 'assessment-att-1',
      candidateHeadSha,
      policyRevision: 'pol-1',
      ownerDecisionReferences: ['door-missing'],
    });

    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.blockers.some((b) => b.includes('could not be resolved'))).toBe(true);
    }
    expect(repo.assessment?.state).toBe('blocked');
  });

  it('unknown one-way door -> acceptance blocked', async () => {
    const repo = new InMemoryEvidenceAssessmentRepo(makePassingAssessmentRecord());
    const ownerDecisionPort = new InMemoryOwnerDecisionPort({
      outcome: 'unknown',
      reason: 'Transport unreachable',
    });

    const useCase = new AssessHeadAcceptanceUseCase({
      repo,
      ownerDecisionPort,
    });

    const result = await useCase.assessHeadAcceptance({
      assessmentId: 'assessment-att-1',
      candidateHeadSha,
      policyRevision: 'pol-1',
      ownerDecisionReferences: ['door-unknown'],
    });

    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.blockers.some((b) => b.includes('is unknown: Transport unreachable'))).toBe(true);
    }
    expect(repo.assessment?.state).toBe('blocked');
  });

  it('one-way door approved for wrong head -> acceptance blocked', async () => {
    const repo = new InMemoryEvidenceAssessmentRepo(makePassingAssessmentRecord());
    const ownerDecisionPort = new InMemoryOwnerDecisionPort({
      outcome: 'resolved',
      decision: {
        id: 'req-door-1',
        state: 'approved',
        expectedHeadSha: '9999999999999999999999999999999999999999',
      },
    });

    const useCase = new AssessHeadAcceptanceUseCase({
      repo,
      ownerDecisionPort,
    });

    const result = await useCase.assessHeadAcceptance({
      assessmentId: 'assessment-att-1',
      candidateHeadSha,
      policyRevision: 'pol-1',
      ownerDecisionReferences: ['door-1'],
    });

    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(
        result.blockers.some((b) =>
          b.includes("was approved for head '9999999999999999999999999999999999999999', not candidate head '1111111111111111111111111111111111111111'"),
        ),
      ).toBe(true);
    }
    expect(repo.assessment?.state).toBe('blocked');
  });

  it('unconfigured ownerDecisionPort with door references -> acceptance blocked', async () => {
    const repo = new InMemoryEvidenceAssessmentRepo(makePassingAssessmentRecord());
    const useCase = new AssessHeadAcceptanceUseCase({
      repo,
      // ownerDecisionPort omitted
    });

    const result = await useCase.assessHeadAcceptance({
      assessmentId: 'assessment-att-1',
      candidateHeadSha,
      policyRevision: 'pol-1',
      ownerDecisionReferences: ['door-1'],
    });

    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.blockers.some((b) => b.includes("owner decision 'door-1' could not be resolved"))).toBe(
        true,
      );
    }
    expect(repo.assessment?.state).toBe('blocked');
  });

  it('decided one-way door (approved for candidate head) -> acceptance passes', async () => {
    const repo = new InMemoryEvidenceAssessmentRepo(makePassingAssessmentRecord());
    const ownerDecisionPort = new InMemoryOwnerDecisionPort({
      outcome: 'resolved',
      decision: {
        id: 'req-door-1',
        state: 'approved',
        expectedHeadSha: candidateHeadSha,
      },
    });

    const useCase = new AssessHeadAcceptanceUseCase({
      repo,
      ownerDecisionPort,
    });

    const result = await useCase.assessHeadAcceptance({
      assessmentId: 'assessment-att-1',
      candidateHeadSha,
      policyRevision: 'pol-1',
      ownerDecisionReferences: ['door-1'],
    });

    expect(result.outcome).toBe('accepted');
    if (result.outcome === 'accepted') {
      expect(result.candidateHeadSha).toBe(candidateHeadSha);
      expect(result.receiptId).toContain('acc-assessment-att-1-');
    }
    expect(repo.assessment?.state).toBe('accepted');
    expect(repo.assessment?.acceptanceReceiptId).not.toBeNull();
  });
});
