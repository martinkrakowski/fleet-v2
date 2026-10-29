import { describe, expect, it } from 'vitest';
import type { EvidenceAssessmentRecord, ReviewReceiptRecord } from '../../domain/evidence-records.js';
import type {
  ForgeCheckStatus,
  ForgeEvidencePort,
} from '../ports/out/ForgeEvidencePort.out-port.js';
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
    implementerModel: 'implementer-model',
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

describe('AssessHeadAcceptanceUseCase forge mode (D6)', () => {
  const request = {
    assessmentId: 'assessment-att-1',
    candidateHeadSha: CANDIDATE_HEAD,
    policyRevision: 'pol-1',
  };

  function forgeProbePort(): ForgeEvidencePort & { readonly calls: number } {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      async readForgeCheckStatus(): Promise<ForgeCheckStatus> {
        calls += 1;
        throw new Error('forge transport must not be read in mode none');
      },
    };
  }

  it('mode none without a CI requirement accepts receipt-only and records forgeEvidence not-configured', async () => {
    const repo = new InMemoryEvidenceAssessmentRepo(makePassingAssessmentRecord());
    const forge = forgeProbePort();
    const useCase = new AssessHeadAcceptanceUseCase({
      repo,
      forgeEvidence: forge,
      forgeMode: 'none',
      ownerDecisionPort: new InMemoryOwnerDecisionPort({ outcome: 'approved', decisionId: 'door-1' }),
      attemptOwnerDecisionPort: new InMemoryAttemptOwnerDecisionPort({
        outcome: 'recorded',
        ownerDecisionReferences: [],
      }),
    });

    const result = await useCase.assessHeadAcceptance(request);

    expect(result.outcome).toBe('accepted');
    // The forge is never read in mode none, and the assessment records the
    // distinct not-configured value, never unknown.
    expect(forge.calls).toBe(0);
    expect(repo.assessment?.forgeEvidence).toBe('not-configured');
  });

  it('mode none blocks a brief that names a CI requirement', async () => {
    const repo = new InMemoryEvidenceAssessmentRepo(
      makePassingAssessmentRecord({ requiredChecks: ['ci', 'unit-tests'] }),
    );
    const forge = forgeProbePort();
    const useCase = new AssessHeadAcceptanceUseCase({
      repo,
      forgeEvidence: forge,
      forgeMode: 'none',
      ownerDecisionPort: new InMemoryOwnerDecisionPort({ outcome: 'approved', decisionId: 'door-1' }),
      attemptOwnerDecisionPort: new InMemoryAttemptOwnerDecisionPort({
        outcome: 'recorded',
        ownerDecisionReferences: [],
      }),
    });

    const result = await useCase.assessHeadAcceptance(request);

    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(
        result.blockers.some((blocker) =>
          blocker.includes("forge mode is 'none'") && blocker.includes('not-configured'),
        ),
      ).toBe(true);
    }
    expect(repo.assessment?.state).toBe('blocked');
    expect(repo.assessment?.forgeEvidence).toBe('not-configured');
  });

  it('mode github keeps the forge read binding and records no forgeEvidence value', async () => {
    const repo = new InMemoryEvidenceAssessmentRepo(makePassingAssessmentRecord());
    const useCase = new AssessHeadAcceptanceUseCase({
      repo,
      forgeEvidence: {
        async readForgeCheckStatus() {
          return {
            candidateHeadSha: CANDIDATE_HEAD,
            ciState: 'unknown',
            unresolvedThreadCount: null,
            observedHeadSha: CANDIDATE_HEAD,
          };
        },
      },
      forgeMode: 'github',
      ownerDecisionPort: new InMemoryOwnerDecisionPort({ outcome: 'approved', decisionId: 'door-1' }),
      attemptOwnerDecisionPort: new InMemoryAttemptOwnerDecisionPort({
        outcome: 'recorded',
        ownerDecisionReferences: [],
      }),
    });

    const result = await useCase.assessHeadAcceptance(request);

    // A failing forge read still blocks exactly as before.
    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.blockers.some((blocker) => blocker.includes("CI state 'unknown'"))).toBe(true);
    }
    expect(repo.assessment?.forgeEvidence).toBeUndefined();
  });

  it('mode github replaces a previously stored not-configured forgeEvidence with the real forge read', async () => {
    const repo = new InMemoryEvidenceAssessmentRepo(
      makePassingAssessmentRecord({ forgeEvidence: 'not-configured' }),
    );
    let reads = 0;
    const useCase = new AssessHeadAcceptanceUseCase({
      repo,
      forgeEvidence: {
        async readForgeCheckStatus() {
          reads += 1;
          return {
            candidateHeadSha: CANDIDATE_HEAD,
            ciState: 'pass',
            unresolvedThreadCount: 0,
            observedHeadSha: CANDIDATE_HEAD,
          };
        },
      },
      forgeMode: 'github',
      ownerDecisionPort: new InMemoryOwnerDecisionPort({ outcome: 'approved', decisionId: 'door-1' }),
      attemptOwnerDecisionPort: new InMemoryAttemptOwnerDecisionPort({
        outcome: 'recorded',
        ownerDecisionReferences: [],
      }),
    });

    const result = await useCase.assessHeadAcceptance(request);

    // The real forge read decides: the stale not-configured marker is never
    // carried over, and acceptance is no longer receipt-only.
    expect(reads).toBe(1);
    expect(result.outcome).toBe('accepted');
    expect(repo.assessment?.forgeEvidence).toBeUndefined();
  });
});

describe('AssessHeadAcceptanceUseCase forge observed head (PC-2b)', () => {
  const request = {
    assessmentId: 'assessment-att-1',
    candidateHeadSha: CANDIDATE_HEAD,
    policyRevision: 'pol-1',
  };
  const OTHER_HEAD = '2222222222222222222222222222222222222222';

  function forgeStatusPort(ciState: 'pass' | 'pending', observedHeadSha: string | null): ForgeEvidencePort {
    return {
      async readForgeCheckStatus(): Promise<ForgeCheckStatus> {
        return {
          candidateHeadSha: CANDIDATE_HEAD,
          ciState,
          unresolvedThreadCount: 0,
          observedHeadSha,
        };
      },
    };
  }

  function acceptanceUseCase(forge: ForgeEvidencePort) {
    return new AssessHeadAcceptanceUseCase({
      repo: new InMemoryEvidenceAssessmentRepo(makePassingAssessmentRecord()),
      forgeEvidence: forge,
      forgeMode: 'github',
      ownerDecisionPort: new InMemoryOwnerDecisionPort({ outcome: 'approved', decisionId: 'door-1' }),
      attemptOwnerDecisionPort: new InMemoryAttemptOwnerDecisionPort({
        outcome: 'recorded',
        ownerDecisionReferences: [],
      }),
    });
  }

  it('pass with observedHeadSha equal to the candidate head is accepted', async () => {
    const result = await acceptanceUseCase(forgeStatusPort('pass', CANDIDATE_HEAD)).assessHeadAcceptance(
      request,
    );

    expect(result.outcome).toBe('accepted');
  });

  it('pass with observedHeadSha for another head is blocked: head moved, kind other, no CI-state blocker', async () => {
    const result = await acceptanceUseCase(forgeStatusPort('pass', OTHER_HEAD)).assessHeadAcceptance(
      request,
    );

    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.blockerDetails).toContainEqual({
        kind: 'other',
        text: 'forge pull request head moved while CI state was read',
      });
      expect(result.blockers.some((blocker) => blocker.includes('forge reports CI state'))).toBe(false);
      if (result.assessment === undefined) {
        throw new Error('expected a blocked assessment record');
      }
      expect(result.assessment.blockers).toEqual([
        'forge pull request head moved while CI state was read',
      ]);
    }
  });

  it('pass with observedHeadSha null is blocked: could not confirm the head', async () => {
    const result = await acceptanceUseCase(forgeStatusPort('pass', null)).assessHeadAcceptance(request);

    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.blockerDetails).toContainEqual({
        kind: 'other',
        text: 'forge could not confirm the pull request head after reading CI state',
      });
      expect(result.blockers.some((blocker) => blocker.includes('forge reports CI state'))).toBe(false);
    }
  });

  it('pending with another head is blocked with the head blocker as well, so it is never ci-pending only', async () => {
    const result = await acceptanceUseCase(forgeStatusPort('pending', OTHER_HEAD)).assessHeadAcceptance(
      request,
    );

    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.blockerDetails).toEqual([
        { kind: 'other', text: 'forge pull request head moved while CI state was read' },
        { kind: 'ci-pending', text: "forge reports CI state 'pending' for this candidate head" },
      ]);
      expect(result.blockerDetails.every((blocker) => blocker.kind === 'ci-pending')).toBe(false);
    }
  });
});

describe('AssessHeadAcceptanceUseCase review dissent (R1)', () => {
  const request = {
    assessmentId: 'assessment-att-1',
    candidateHeadSha: CANDIDATE_HEAD,
    policyRevision: 'pol-1',
  };

  function reviewReceipt(overrides?: Partial<ReviewReceiptRecord>): ReviewReceiptRecord {
    return {
      id: 'review-1',
      assessmentId: 'assessment-att-1',
      projectId: 'proj-1',
      attemptId: 'att-1',
      candidateHeadSha: CANDIDATE_HEAD,
      reviewerModel: 'reviewer-a',
      implementerModel: 'implementer-model',
      readOnlyVerified: true,
      result: 'pass',
      findings: [],
      evidenceRef: 'evidence-ref-1',
      policyRevision: 'pol-1',
      completedAtIso: '2026-10-15T10:00:00Z',
      ...overrides,
    };
  }

  function useCaseFor(reviewReceipts: readonly ReviewReceiptRecord[]) {
    const repo = new InMemoryEvidenceAssessmentRepo(
      makePassingAssessmentRecord({ reviewReceipts }),
    );
    const useCase = new AssessHeadAcceptanceUseCase({
      repo,
      ownerDecisionPort: new InMemoryOwnerDecisionPort({
        outcome: 'approved',
        decisionId: 'door-1',
      }),
      attemptOwnerDecisionPort: new InMemoryAttemptOwnerDecisionPort({
        outcome: 'recorded',
        ownerDecisionReferences: [],
      }),
    });
    return { repo, useCase };
  }

  it('reviewer A pass plus reviewer B fail (no findings) blocks with a dissent blocker and an opposing tally', async () => {
    const { repo, useCase } = useCaseFor([
      reviewReceipt({ id: 'review-a-pass', reviewerModel: 'reviewer-a', result: 'pass' }),
      reviewReceipt({ id: 'review-b-fail', reviewerModel: 'reviewer-b', result: 'fail' }),
    ]);

    const result = await useCase.assessHeadAcceptance(request);

    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(
        result.blockers.some((blocker) =>
          blocker.includes("review by 'reviewer-b' failed for this head"),
        ),
      ).toBe(true);
      expect(result.reviewTally).toEqual({ pass: 1, fail: 1, unknown: 0, disagreement: true });
    }
    expect(repo.assessment?.state).toBe('blocked');
  });

  it('the same reviewer fail then pass later accepts with a non-disagreeing tally', async () => {
    const { repo, useCase } = useCaseFor([
      reviewReceipt({ id: 'review-a-fail', reviewerModel: 'reviewer-a', result: 'fail' }),
      reviewReceipt({ id: 'review-a-pass', reviewerModel: 'reviewer-a', result: 'pass' }),
    ]);

    const result = await useCase.assessHeadAcceptance(request);

    expect(result.outcome).toBe('accepted');
    if (result.outcome === 'accepted') {
      expect(result.reviewTally).toEqual({ pass: 1, fail: 0, unknown: 0, disagreement: false });
    }
    expect(repo.assessment?.state).toBe('accepted');
  });

  it('the same reviewer pass then fail later blocks', async () => {
    const { repo, useCase } = useCaseFor([
      reviewReceipt({ id: 'review-a-pass', reviewerModel: 'reviewer-a', result: 'pass' }),
      reviewReceipt({ id: 'review-a-fail', reviewerModel: 'reviewer-a', result: 'fail' }),
    ]);

    const result = await useCase.assessHeadAcceptance(request);

    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(
        result.blockers.some((blocker) =>
          blocker.includes("review by 'reviewer-a' failed for this head"),
        ),
      ).toBe(true);
    }
    expect(repo.assessment?.state).toBe('blocked');
  });

  it("reviewer A fail plus B pass, then C pass, still blocks: another reviewer's pass never answers a dissent", async () => {
    const { repo, useCase } = useCaseFor([
      reviewReceipt({ id: 'review-a-fail', reviewerModel: 'reviewer-a', result: 'fail' }),
      reviewReceipt({ id: 'review-b-pass', reviewerModel: 'reviewer-b', result: 'pass' }),
      reviewReceipt({ id: 'review-c-pass', reviewerModel: 'reviewer-c', result: 'pass' }),
    ]);

    const result = await useCase.assessHeadAcceptance(request);

    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(
        result.blockers.some((blocker) =>
          blocker.includes("review by 'reviewer-a' failed for this head"),
        ),
      ).toBe(true);
    }
    expect(repo.assessment?.state).toBe('blocked');
  });

  it('unknown only blocks with the existing no-review-passed message and no fail line', async () => {
    const { repo, useCase } = useCaseFor([
      reviewReceipt({ id: 'review-a-unknown', reviewerModel: 'reviewer-a', result: 'unknown' }),
    ]);

    const result = await useCase.assessHeadAcceptance(request);

    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(
        result.blockers.some((blocker) =>
          blocker.includes('no read-only independent review passed for this candidate head'),
        ),
      ).toBe(true);
      expect(result.blockers.some((blocker) => blocker.includes('failed for this head'))).toBe(false);
    }
    expect(repo.assessment?.state).toBe('blocked');
  });

  it('reviewer A pass plus B unknown accepts', async () => {
    const { repo, useCase } = useCaseFor([
      reviewReceipt({ id: 'review-a-pass', reviewerModel: 'reviewer-a', result: 'pass' }),
      reviewReceipt({ id: 'review-b-unknown', reviewerModel: 'reviewer-b', result: 'unknown' }),
    ]);

    const result = await useCase.assessHeadAcceptance(request);

    expect(result.outcome).toBe('accepted');
    expect(repo.assessment?.state).toBe('accepted');
  });

  it('a non-read-only fail is not counted alongside a passing reviewer', async () => {
    const { repo, useCase } = useCaseFor([
      reviewReceipt({
        id: 'review-a-fail-not-readonly',
        reviewerModel: 'reviewer-a',
        result: 'fail',
        readOnlyVerified: false,
      }),
      reviewReceipt({ id: 'review-b-pass', reviewerModel: 'reviewer-b', result: 'pass' }),
    ]);

    const result = await useCase.assessHeadAcceptance(request);

    expect(result.outcome).toBe('accepted');
    expect(repo.assessment?.state).toBe('accepted');
  });

  it('a reviewer whose receipt records a different implementer seat is an independence blocker, not a fail line', async () => {
    const { repo, useCase } = useCaseFor([
      reviewReceipt({
        id: 'review-a-fail-mismatch',
        reviewerModel: 'reviewer-a',
        implementerModel: 'other-implementer',
        result: 'fail',
      }),
      reviewReceipt({ id: 'review-b-pass', reviewerModel: 'reviewer-b', result: 'pass' }),
    ]);

    const result = await useCase.assessHeadAcceptance(request);

    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(
        result.blockers.some((blocker) =>
          blocker.includes("instead of the assessment's seat 'implementer-model'"),
        ),
      ).toBe(true);
      expect(result.blockers.some((blocker) => blocker.includes('failed for this head'))).toBe(false);
    }
    expect(repo.assessment?.state).toBe('blocked');
  });

  it('a fail for a different head does not affect this head', async () => {
    const { repo, useCase } = useCaseFor([
      reviewReceipt({
        id: 'review-a-fail-other-head',
        reviewerModel: 'reviewer-a',
        result: 'fail',
        candidateHeadSha: '2222222222222222222222222222222222222222',
      }),
      reviewReceipt({ id: 'review-b-pass', reviewerModel: 'reviewer-b', result: 'pass' }),
    ]);

    const result = await useCase.assessHeadAcceptance(request);

    expect(result.outcome).toBe('accepted');
    expect(repo.assessment?.state).toBe('accepted');
  });
});