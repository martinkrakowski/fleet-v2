import { describe, expect, it } from 'vitest';
import type { EvidenceAssessmentRecord } from '../../domain/evidence-records.js';
import type { EvidenceAssessmentRepositoryPort } from '../ports/out/EvidenceAssessmentRepositoryPort.out-port.js';
import type {
  OwnerDecisionPort,
  OwnerDecisionResult,
  ResolveOwnerDecisionRequest,
} from '../ports/out/OwnerDecisionPort.out-port.js';
import type {
  AttemptOwnerDecisionPort,
  AttemptOwnerDecisionResult,
  ReadAttemptOwnerDecisionRequest,
} from '../ports/out/AttemptOwnerDecisionPort.out-port.js';
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
  readonly requests: ResolveOwnerDecisionRequest[] = [];

  constructor(private readonly result: OwnerDecisionResult) {}

  async resolveOwnerDecision(request: ResolveOwnerDecisionRequest): Promise<OwnerDecisionResult> {
    this.requests.push(request);
    return this.result;
  }
}

/** The frozen doors recorded on the attempt at dispatch. */
class InMemoryAttemptOwnerDecisionPort implements AttemptOwnerDecisionPort {
  readonly requests: ReadAttemptOwnerDecisionRequest[] = [];

  constructor(private readonly result: AttemptOwnerDecisionResult) {}

  async readAttemptOwnerDecisionReferences(
    request: ReadAttemptOwnerDecisionRequest,
  ): Promise<AttemptOwnerDecisionResult> {
    this.requests.push(request);
    return this.result;
  }
}

class ThrowingAttemptOwnerDecisionPort implements AttemptOwnerDecisionPort {
  async readAttemptOwnerDecisionReferences(): Promise<AttemptOwnerDecisionResult> {
    throw new Error('attempt store is unreadable');
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

const CANDIDATE_HEAD = '1111111111111111111111111111111111111111';

describe('AssessHeadAcceptanceUseCase (M15: Owner Decision / One-Way Door)', () => {
  const request = {
    assessmentId: 'assessment-att-1',
    candidateHeadSha: CANDIDATE_HEAD,
    policyRevision: 'pol-1',
  };

  it('records no owner decisions and accepts the exact head', async () => {
    const repo = new InMemoryEvidenceAssessmentRepo(makePassingAssessmentRecord());
    const attemptDoors = new InMemoryAttemptOwnerDecisionPort({
      outcome: 'recorded',
      ownerDecisionReferences: [],
    });
    const ownerDecisionPort = new InMemoryOwnerDecisionPort({
      outcome: 'approved',
      decisionId: 'door-1',
    });

    const useCase = new AssessHeadAcceptanceUseCase({ repo, ownerDecisionPort, attemptOwnerDecisionPort: attemptDoors });
    const result = await useCase.assessHeadAcceptance(request);

    expect(result.outcome).toBe('accepted');
    if (result.outcome === 'accepted') {
      expect(result.candidateHeadSha).toBe(CANDIDATE_HEAD);
      expect(result.receiptId).toContain('acc-assessment-att-1-');
    }
    expect(repo.assessment?.state).toBe('accepted');
    expect(attemptDoors.requests).toEqual([{ attemptId: 'att-1' }]);
    expect(ownerDecisionPort.requests).toHaveLength(0);
  });

  it('decided one-way door for the candidate head -> acceptance passes', async () => {
    const repo = new InMemoryEvidenceAssessmentRepo(makePassingAssessmentRecord());
    const ownerDecisionPort = new InMemoryOwnerDecisionPort({
      outcome: 'approved',
      decisionId: 'door-1',
    });

    const useCase = new AssessHeadAcceptanceUseCase({
      repo,
      ownerDecisionPort,
      attemptOwnerDecisionPort: new InMemoryAttemptOwnerDecisionPort({
        outcome: 'recorded',
        ownerDecisionReferences: ['door-1'],
      }),
    });

    const result = await useCase.assessHeadAcceptance(request);

    expect(result.outcome).toBe('accepted');
    expect(ownerDecisionPort.requests).toEqual([
      { decisionReference: 'door-1', candidateHeadSha: CANDIDATE_HEAD },
    ]);
    expect(repo.assessment?.state).toBe('accepted');
  });

  it('a declined one-way door -> acceptance blocked', async () => {
    const repo = new InMemoryEvidenceAssessmentRepo(makePassingAssessmentRecord());
    const ownerDecisionPort = new InMemoryOwnerDecisionPort({
      outcome: 'not-approved',
      reason: "coordination request door-1 is 'declined'",
    });

    const useCase = new AssessHeadAcceptanceUseCase({
      repo,
      ownerDecisionPort,
      attemptOwnerDecisionPort: new InMemoryAttemptOwnerDecisionPort({
        outcome: 'recorded',
        ownerDecisionReferences: ['door-1'],
      }),
    });

    const result = await useCase.assessHeadAcceptance(request);

    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(
        result.blockers.some((blocker) =>
          blocker.includes("owner decision 'door-1' is not approved: coordination request door-1 is 'declined'"),
        ),
      ).toBe(true);
    }
    expect(repo.assessment?.state).toBe('blocked');
  });

  it('an undecided one-way door -> acceptance blocked', async () => {
    const repo = new InMemoryEvidenceAssessmentRepo(makePassingAssessmentRecord());
    const ownerDecisionPort = new InMemoryOwnerDecisionPort({
      outcome: 'not-approved',
      reason: "coordination request door-1 is 'awaiting-decision'",
    });

    const useCase = new AssessHeadAcceptanceUseCase({
      repo,
      ownerDecisionPort,
      attemptOwnerDecisionPort: new InMemoryAttemptOwnerDecisionPort({
        outcome: 'recorded',
        ownerDecisionReferences: ['door-1'],
      }),
    });

    const result = await useCase.assessHeadAcceptance(request);

    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.blockers.some((blocker) => blocker.includes("'awaiting-decision'"))).toBe(true);
    }
    expect(repo.assessment?.state).toBe('blocked');
  });

  it('an approval recorded for another scope on the same head -> acceptance blocked', async () => {
    const repo = new InMemoryEvidenceAssessmentRepo(makePassingAssessmentRecord());
    const ownerDecisionPort = new InMemoryOwnerDecisionPort({
      outcome: 'not-approved',
      reason:
        "coordination request door-1 is 'approved' for scope 'forge:merge-pr' at " +
        `${CANDIDATE_HEAD}; it does not authorize owner-decision:door-1 at ${CANDIDATE_HEAD}`,
    });

    const useCase = new AssessHeadAcceptanceUseCase({
      repo,
      ownerDecisionPort,
      attemptOwnerDecisionPort: new InMemoryAttemptOwnerDecisionPort({
        outcome: 'recorded',
        ownerDecisionReferences: ['door-1'],
      }),
    });

    const result = await useCase.assessHeadAcceptance(request);

    expect(result.outcome).toBe('blocked');
    expect(ownerDecisionPort.requests).toHaveLength(1);
    expect(repo.assessment?.state).toBe('blocked');
  });

  it('an unknown one-way door -> acceptance blocked', async () => {
    const repo = new InMemoryEvidenceAssessmentRepo(makePassingAssessmentRecord());
    const ownerDecisionPort = new InMemoryOwnerDecisionPort({
      outcome: 'unknown',
      reason: 'No coordination request is recorded for owner decision door-unknown',
    });

    const useCase = new AssessHeadAcceptanceUseCase({
      repo,
      ownerDecisionPort,
      attemptOwnerDecisionPort: new InMemoryAttemptOwnerDecisionPort({
        outcome: 'recorded',
        ownerDecisionReferences: ['door-unknown'],
      }),
    });

    const result = await useCase.assessHeadAcceptance(request);

    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(
        result.blockers.some((blocker) =>
          blocker.includes("owner decision 'door-unknown' is unknown: No coordination request is recorded"),
        ),
      ).toBe(true);
    }
    expect(repo.assessment?.state).toBe('blocked');
  });

  it('an old attempt recorded without owner decision references -> acceptance blocked', async () => {
    const repo = new InMemoryEvidenceAssessmentRepo(makePassingAssessmentRecord());
    const useCase = new AssessHeadAcceptanceUseCase({
      repo,
      ownerDecisionPort: new InMemoryOwnerDecisionPort({ outcome: 'approved', decisionId: 'door-1' }),
      attemptOwnerDecisionPort: new InMemoryAttemptOwnerDecisionPort({
        outcome: 'unknown',
        reason: 'attempt att-1 was recorded before owner decision references were frozen',
      }),
    });

    const result = await useCase.assessHeadAcceptance(request);

    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(
        result.blockers.some((blocker) =>
          blocker.includes("owner decision references for attempt 'att-1' are unknown"),
        ),
      ).toBe(true);
    }
    expect(repo.assessment?.state).toBe('blocked');
  });

  it('an unreadable attempt record -> acceptance blocked, never an empty door list', async () => {
    const repo = new InMemoryEvidenceAssessmentRepo(makePassingAssessmentRecord());
    const useCase = new AssessHeadAcceptanceUseCase({
      repo,
      ownerDecisionPort: new InMemoryOwnerDecisionPort({ outcome: 'approved', decisionId: 'door-1' }),
      attemptOwnerDecisionPort: new ThrowingAttemptOwnerDecisionPort(),
    });

    const result = await useCase.assessHeadAcceptance(request);

    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(
        result.blockers.some((blocker) =>
          blocker.includes('could not be read: attempt store is unreadable'),
        ),
      ).toBe(true);
    }
  });

  it('an unconfigured attempt owner decision port -> acceptance blocked', async () => {
    const repo = new InMemoryEvidenceAssessmentRepo(makePassingAssessmentRecord());
    const useCase = new AssessHeadAcceptanceUseCase({
      repo,
      ownerDecisionPort: new InMemoryOwnerDecisionPort({ outcome: 'approved', decisionId: 'door-1' }),
    });

    const result = await useCase.assessHeadAcceptance(request);

    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(
        result.blockers.some((blocker) =>
          blocker.includes('no attempt owner decision port is configured'),
        ),
      ).toBe(true);
    }
  });

  it('an already accepted assessment with a newly undecided door -> blocked, not the stored acceptance', async () => {
    const repo = new InMemoryEvidenceAssessmentRepo(
      makePassingAssessmentRecord({
        state: 'accepted',
        acceptanceReceiptId: 'acc-assessment-att-1-11111111',
      }),
    );
    const ownerDecisionPort = new InMemoryOwnerDecisionPort({
      outcome: 'not-approved',
      reason: "coordination request door-1 is 'awaiting-decision'",
    });

    const useCase = new AssessHeadAcceptanceUseCase({
      repo,
      ownerDecisionPort,
      attemptOwnerDecisionPort: new InMemoryAttemptOwnerDecisionPort({
        outcome: 'recorded',
        ownerDecisionReferences: ['door-1'],
      }),
    });

    const result = await useCase.assessHeadAcceptance(request);

    expect(result.outcome).toBe('blocked');
    expect(repo.assessment?.state).toBe('blocked');
    expect(repo.assessment?.acceptanceReceiptId).toBeNull();
  });

  it('an already accepted assessment with every door approved -> the stored acceptance', async () => {
    const repo = new InMemoryEvidenceAssessmentRepo(
      makePassingAssessmentRecord({
        state: 'accepted',
        acceptanceReceiptId: 'acc-assessment-att-1-11111111',
      }),
    );

    const useCase = new AssessHeadAcceptanceUseCase({
      repo,
      ownerDecisionPort: new InMemoryOwnerDecisionPort({ outcome: 'approved', decisionId: 'door-1' }),
      attemptOwnerDecisionPort: new InMemoryAttemptOwnerDecisionPort({
        outcome: 'recorded',
        ownerDecisionReferences: ['door-1'],
      }),
    });

    const result = await useCase.assessHeadAcceptance(request);

    expect(result.outcome).toBe('accepted');
    if (result.outcome === 'accepted') {
      expect(result.receiptId).toBe('acc-assessment-att-1-11111111');
    }
  });

  it('a request carrying owner decision references is rejected', async () => {
    const repo = new InMemoryEvidenceAssessmentRepo(makePassingAssessmentRecord());
    const attemptDoors = new InMemoryAttemptOwnerDecisionPort({
      outcome: 'recorded',
      ownerDecisionReferences: [],
    });
    const useCase = new AssessHeadAcceptanceUseCase({ repo, attemptOwnerDecisionPort: attemptDoors });

    const result = await useCase.execute({
      ...request,
      ownerDecisionReferences: ['door-chosen-by-caller'],
    });

    expect(result).toEqual({
      outcome: 'rejected',
      reason:
        "'ownerDecisionReferences' must not be supplied; owner decisions are read from the attempt record",
    });
    expect(attemptDoors.requests).toHaveLength(0);
  });
});