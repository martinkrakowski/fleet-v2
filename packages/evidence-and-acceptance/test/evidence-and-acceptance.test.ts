import { describe, expect, it } from 'vitest';
import {
  EvidenceAssessment,
  type EvidenceAssessmentRecord,
  type FindingDispositionRecord,
  type ReviewReceiptRecord,
  type VerificationReceiptRecord,
} from '../src/domain/index.js';
import {
  AssessHeadAcceptanceUseCase,
  RecordFindingDispositionUseCase,
  RecordReviewReceiptUseCase,
  RecordVerificationReceiptUseCase,
  RequestIndependentReviewUseCase,
  RequestVerificationUseCase,
} from '../src/application/use-cases/index.js';
import {
  EvidenceArchiveAdapter,
  EvidenceAssessmentRepositoryAdapter,
  IndependentReviewAdapter,
  VerificationExecutorAdapter,
} from '../src/infrastructure/adapters/index.js';

function makeAssessmentRecord(overrides: Partial<EvidenceAssessmentRecord> = {}): EvidenceAssessmentRecord {
  return {
    id: 'asmt-1',
    projectId: 'proj-1',
    attemptId: 'att-1',
    candidateHeadSha: '0123456789abcdef0123456789abcdef01234567',
    policyRevision: 'pol-1',
    requiredChecks: ['unit-test'],
    state: 'pending',
    verificationReceipts: [],
    reviewReceipts: [],
    findingDispositions: [],
    acceptanceReceiptId: null,
    blockers: [],
    revision: 1,
    updatedAtIso: '2026-10-16T00:00:00.000Z',
    ...overrides,
  };
}

function makeVerificationReceipt(overrides: Partial<VerificationReceiptRecord> = {}): VerificationReceiptRecord {
  return {
    id: 'vr-1',
    assessmentId: 'asmt-1',
    projectId: 'proj-1',
    attemptId: 'att-1',
    candidateHeadSha: '0123456789abcdef0123456789abcdef01234567',
    hostId: 'host-1',
    procedureName: 'unit-test',
    result: 'pass',
    exitCode: 0,
    evidenceRef: 'evidence://artifact-1@0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    policyRevision: 'pol-1',
    completedAtIso: '2026-10-16T00:00:00.000Z',
    ...overrides,
  };
}

function makeReviewReceipt(overrides: Partial<ReviewReceiptRecord> = {}): ReviewReceiptRecord {
  return {
    id: 'rr-1',
    assessmentId: 'asmt-1',
    projectId: 'proj-1',
    attemptId: 'att-1',
    candidateHeadSha: '0123456789abcdef0123456789abcdef01234567',
    reviewerModel: 'provider-a/model-reviewer',
    implementerModel: 'provider-b/model-implementer',
    readOnlyVerified: true,
    result: 'pass',
    findings: [],
    evidenceRef: 'evidence://artifact-2@0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    policyRevision: 'pol-1',
    completedAtIso: '2026-10-16T00:00:00.000Z',
    ...overrides,
  };
}

function makeFindingDisposition(overrides: Partial<FindingDispositionRecord> = {}): FindingDispositionRecord {
  return {
    id: 'fd-1',
    assessmentId: 'asmt-1',
    findingId: 'finding-1',
    candidateHeadSha: '0123456789abcdef0123456789abcdef01234567',
    state: 'fixed',
    reason: 'Fixed in commit',
    evidenceRef: 'evidence://artifact-3@0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    recordedBy: 'operator-1',
    recordedAtIso: '2026-10-16T00:00:00.000Z',
    ...overrides,
  };
}

describe('EvidenceAssessment aggregate terminal state enforcement', () => {
  const terminalStates = ['stale', 'accepted', 'rejected'] as const;

  for (const state of terminalStates) {
    it(`refuses appendVerificationReceipt when assessment is in terminal state '${state}'`, () => {
      const assessment = EvidenceAssessment.fromRecord(
        makeAssessmentRecord({
          state,
          acceptanceReceiptId: state === 'accepted' ? 'acc-stored-1' : null,
        }),
      );
      const receipt = makeVerificationReceipt();
      expect(() => assessment.appendVerificationReceipt(receipt, '2026-10-16T01:00:00.000Z')).toThrow(
        `Cannot append verification receipt to an assessment in terminal state '${state}'`,
      );
    });

    it(`refuses appendReviewReceipt when assessment is in terminal state '${state}'`, () => {
      const assessment = EvidenceAssessment.fromRecord(
        makeAssessmentRecord({
          state,
          acceptanceReceiptId: state === 'accepted' ? 'acc-stored-1' : null,
        }),
      );
      const receipt = makeReviewReceipt();
      expect(() => assessment.appendReviewReceipt(receipt, '2026-10-16T01:00:00.000Z')).toThrow(
        `Cannot append review receipt to an assessment in terminal state '${state}'`,
      );
    });

    it(`refuses appendFindingDisposition when assessment is in terminal state '${state}'`, () => {
      const assessment = EvidenceAssessment.fromRecord(
        makeAssessmentRecord({
          state,
          acceptanceReceiptId: state === 'accepted' ? 'acc-stored-1' : null,
        }),
      );
      const disposition = makeFindingDisposition();
      expect(() => assessment.appendFindingDisposition(disposition, '2026-10-16T01:00:00.000Z')).toThrow(
        `Cannot append finding disposition to an assessment in terminal state '${state}'`,
      );
    });
  }
});

describe('Use cases terminal assessment rejection (Fix 1)', () => {
  const terminalStates = ['stale', 'accepted', 'rejected'] as const;

  for (const state of terminalStates) {
    it(`RequestVerificationUseCase rejects assessment in terminal state '${state}' without saving`, async () => {
      const repo = new EvidenceAssessmentRepositoryAdapter();
      const executor = new VerificationExecutorAdapter();
      const archive = new EvidenceArchiveAdapter();
      const useCase = new RequestVerificationUseCase({ repo, executor, archive });

      const initial = makeAssessmentRecord({
        state,
        acceptanceReceiptId: state === 'accepted' ? 'acc-existing-1' : null,
      });
      await repo.saveAssessment(initial);

      const result = await useCase.requestVerification({
        assessmentId: initial.id,
        projectId: initial.projectId,
        attemptId: initial.attemptId,
        candidateHeadSha: initial.candidateHeadSha,
        policyRevision: initial.policyRevision,
        hostId: 'host-1',
        requiredChecks: ['unit-test'],
      });

      expect(result.outcome).toBe('rejected');
      if (result.outcome === 'rejected') {
        expect(result.reason).toContain(state);
      }
      const stored = await repo.findAssessmentById(initial.id);
      expect(stored?.revision).toBe(initial.revision);
      expect(stored?.state).toBe(state);
      expect(stored?.acceptanceReceiptId).toBe(initial.acceptanceReceiptId);
    });

    it(`RequestIndependentReviewUseCase rejects assessment in terminal state '${state}' without saving`, async () => {
      const repo = new EvidenceAssessmentRepositoryAdapter();
      const reviewer = new IndependentReviewAdapter();
      const archive = new EvidenceArchiveAdapter();
      const useCase = new RequestIndependentReviewUseCase({ repo, reviewer, archive });

      const initial = makeAssessmentRecord({
        state,
        acceptanceReceiptId: state === 'accepted' ? 'acc-existing-1' : null,
      });
      await repo.saveAssessment(initial);

      const result = await useCase.requestIndependentReview({
        assessmentId: initial.id,
        projectId: initial.projectId,
        attemptId: initial.attemptId,
        candidateHeadSha: initial.candidateHeadSha,
        policyRevision: initial.policyRevision,
        implementerModel: 'provider-a/impl-model',
        reviewerModel: 'provider-b/rev-model',
      });

      expect(result.outcome).toBe('rejected');
      if (result.outcome === 'rejected') {
        expect(result.reason).toContain(state);
      }
      const stored = await repo.findAssessmentById(initial.id);
      expect(stored?.revision).toBe(initial.revision);
      expect(stored?.state).toBe(state);
    });

    it(`RecordReviewReceiptUseCase rejects assessment in terminal state '${state}' without saving`, async () => {
      const repo = new EvidenceAssessmentRepositoryAdapter();
      const useCase = new RecordReviewReceiptUseCase({ repo });

      const initial = makeAssessmentRecord({
        state,
        acceptanceReceiptId: state === 'accepted' ? 'acc-existing-1' : null,
      });
      await repo.saveAssessment(initial);

      const result = await useCase.recordReviewReceipt({
        assessmentId: initial.id,
        receipt: makeReviewReceipt(),
      });

      expect(result.outcome).toBe('rejected');
      if (result.outcome === 'rejected') {
        expect(result.reason).toContain(state);
      }
      const stored = await repo.findAssessmentById(initial.id);
      expect(stored?.revision).toBe(initial.revision);
      expect(stored?.state).toBe(state);
    });

    it(`RecordVerificationReceiptUseCase rejects assessment in terminal state '${state}' without saving`, async () => {
      const repo = new EvidenceAssessmentRepositoryAdapter();
      const useCase = new RecordVerificationReceiptUseCase({ repo });

      const initial = makeAssessmentRecord({
        state,
        acceptanceReceiptId: state === 'accepted' ? 'acc-existing-1' : null,
      });
      await repo.saveAssessment(initial);

      const result = await useCase.recordVerificationReceipt({
        assessmentId: initial.id,
        receipt: makeVerificationReceipt(),
      });

      expect(result.outcome).toBe('rejected');
      if (result.outcome === 'rejected') {
        expect(result.reason).toContain(state);
      }
      const stored = await repo.findAssessmentById(initial.id);
      expect(stored?.revision).toBe(initial.revision);
      expect(stored?.state).toBe(state);
    });

    it(`RecordFindingDispositionUseCase rejects assessment in terminal state '${state}' without saving`, async () => {
      const repo = new EvidenceAssessmentRepositoryAdapter();
      const useCase = new RecordFindingDispositionUseCase({ repo });

      const initial = makeAssessmentRecord({
        state,
        acceptanceReceiptId: state === 'accepted' ? 'acc-existing-1' : null,
        reviewReceipts: [
          makeReviewReceipt({
            findings: [
              {
                findingId: 'finding-1',
                severity: 'minor',
                summary: 'Finding 1',
                filePath: null,
                line: null,
                state: 'unresolved',
                dispositionReason: null,
                dispositionEvidenceRef: null,
              },
            ],
          }),
        ],
      });
      await repo.saveAssessment(initial);

      const result = await useCase.recordFindingDisposition({
        assessmentId: initial.id,
        disposition: makeFindingDisposition(),
      });

      expect(result.outcome).toBe('rejected');
      if (result.outcome === 'rejected') {
        expect(result.reason).toContain(state);
      }
      const stored = await repo.findAssessmentById(initial.id);
      expect(stored?.revision).toBe(initial.revision);
      expect(stored?.state).toBe(state);
    });
  }
});

describe('Fix 1 required lifecycle scenario', () => {
  it('assessment pending at head H; assess with H-prime marks stale; record-verification for H refused; assess with H returns stale', async () => {
    const headH = '1111111111111111111111111111111111111111';
    const headHPrime = '2222222222222222222222222222222222222222';
    const policy = 'policy-v1';

    const repo = new EvidenceAssessmentRepositoryAdapter();
    const assessUseCase = new AssessHeadAcceptanceUseCase({ repo });
    const recordVerificationUseCase = new RecordVerificationReceiptUseCase({ repo });

    // Assessment pending at head H
    const initial = makeAssessmentRecord({
      id: 'asmt-lifecycle',
      candidateHeadSha: headH,
      policyRevision: policy,
      state: 'pending',
      requiredChecks: ['unit-test'],
      verificationReceipts: [],
      revision: 1,
    });
    await repo.saveAssessment(initial);

    // Assess with H' marks it stale
    const assessHPrimeResult = await assessUseCase.assessHeadAcceptance({
      assessmentId: initial.id,
      candidateHeadSha: headHPrime,
      policyRevision: policy,
    });
    expect(assessHPrimeResult.outcome).toBe('stale');

    const staleStored = await repo.findAssessmentById(initial.id);
    expect(staleStored?.state).toBe('stale');

    // Record-verification for H is refused
    const recordResult = await recordVerificationUseCase.recordVerificationReceipt({
      assessmentId: initial.id,
      receipt: makeVerificationReceipt({
        assessmentId: initial.id,
        candidateHeadSha: headH,
        policyRevision: policy,
      }),
    });
    expect(recordResult.outcome).toBe('rejected');
    if (recordResult.outcome === 'rejected') {
      expect(recordResult.reason).toContain('stale');
    }

    // Assess with H returns stale, never accepted
    const assessHResult = await assessUseCase.assessHeadAcceptance({
      assessmentId: initial.id,
      candidateHeadSha: headH,
      policyRevision: policy,
    });
    expect(assessHResult.outcome).toBe('stale');
  });

  it('accepted -> a new receipt is refused and stored acceptanceReceiptId is untouched; rejected -> refused', async () => {
    const repo = new EvidenceAssessmentRepositoryAdapter();
    const recordVerificationUseCase = new RecordVerificationReceiptUseCase({ repo });

    const storedReceiptId = 'acc-permanent-receipt-123';
    const acceptedRecord = makeAssessmentRecord({
      id: 'asmt-accepted',
      state: 'accepted',
      acceptanceReceiptId: storedReceiptId,
      revision: 1,
    });
    await repo.saveAssessment(acceptedRecord);

    const recordResultOnAccepted = await recordVerificationUseCase.recordVerificationReceipt({
      assessmentId: acceptedRecord.id,
      receipt: makeVerificationReceipt({ assessmentId: acceptedRecord.id }),
    });
    expect(recordResultOnAccepted.outcome).toBe('rejected');
    if (recordResultOnAccepted.outcome === 'rejected') {
      expect(recordResultOnAccepted.reason).toContain('accepted');
    }

    const storedAfterRefusal = await repo.findAssessmentById(acceptedRecord.id);
    expect(storedAfterRefusal?.acceptanceReceiptId).toBe(storedReceiptId);
    expect(storedAfterRefusal?.state).toBe('accepted');
    expect(storedAfterRefusal?.revision).toBe(1);

    // Rejected -> refused
    const rejectedRecord = makeAssessmentRecord({
      id: 'asmt-rejected',
      state: 'rejected',
      acceptanceReceiptId: null,
      revision: 1,
    });
    await repo.saveAssessment(rejectedRecord);

    const recordResultOnRejected = await recordVerificationUseCase.recordVerificationReceipt({
      assessmentId: rejectedRecord.id,
      receipt: makeVerificationReceipt({ assessmentId: rejectedRecord.id }),
    });
    expect(recordResultOnRejected.outcome).toBe('rejected');
    if (recordResultOnRejected.outcome === 'rejected') {
      expect(recordResultOnRejected.reason).toContain('rejected');
    }
  });
});

describe('Fix 2: Re-assessing an already-accepted head with the same head and policy', () => {
  it('returns accepted with the STORED receipt (idempotent), not rejected', async () => {
    const head = '3333333333333333333333333333333333333333';
    const policy = 'pol-fixed';
    const storedReceipt = 'acc-stored-receipt-999';

    const repo = new EvidenceAssessmentRepositoryAdapter();
    const assessUseCase = new AssessHeadAcceptanceUseCase({ repo });

    const acceptedRecord = makeAssessmentRecord({
      id: 'asmt-idempotent-accept',
      candidateHeadSha: head,
      policyRevision: policy,
      state: 'accepted',
      acceptanceReceiptId: storedReceipt,
      revision: 2,
    });
    await repo.saveAssessment(acceptedRecord);

    const result = await assessUseCase.assessHeadAcceptance({
      assessmentId: acceptedRecord.id,
      candidateHeadSha: head,
      policyRevision: policy,
    });

    expect(result.outcome).toBe('accepted');
    if (result.outcome === 'accepted') {
      expect(result.receiptId).toBe(storedReceipt);
      expect(result.candidateHeadSha).toBe(head);
      expect(result.assessment.state).toBe('accepted');
      expect(result.assessment.acceptanceReceiptId).toBe(storedReceipt);
    }

    // Still revision 2 (idempotent, no extra write)
    const stored = await repo.findAssessmentById(acceptedRecord.id);
    expect(stored?.revision).toBe(2);
  });
});

describe('Fix 3: Identity comparison in RecordVerificationReceiptUseCase and RecordReviewReceiptUseCase', () => {
  it('RecordVerificationReceiptUseCase checks mismatch in each field (head, policy, attempt, project)', async () => {
    const repo = new EvidenceAssessmentRepositoryAdapter();
    const useCase = new RecordVerificationReceiptUseCase({ repo });

    const assessment = makeAssessmentRecord({
      id: 'asmt-ident-test-vr',
      projectId: 'proj-expected',
      attemptId: 'att-expected',
      candidateHeadSha: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
      policyRevision: 'pol-expected',
      state: 'pending',
    });
    await repo.saveAssessment(assessment);

    // Mismatch in candidateHeadSha
    const headMismatch = await useCase.recordVerificationReceipt({
      assessmentId: assessment.id,
      receipt: makeVerificationReceipt({
        assessmentId: assessment.id,
        projectId: assessment.projectId,
        attemptId: assessment.attemptId,
        policyRevision: assessment.policyRevision,
        candidateHeadSha: 'ffff9999ffff9999ffff9999ffff9999ffff9999',
      }),
    });
    expect(headMismatch.outcome).toBe('rejected');
    if (headMismatch.outcome === 'rejected') {
      expect(headMismatch.reason).toContain('head');
    }

    // Mismatch in policyRevision
    const policyMismatch = await useCase.recordVerificationReceipt({
      assessmentId: assessment.id,
      receipt: makeVerificationReceipt({
        assessmentId: assessment.id,
        projectId: assessment.projectId,
        attemptId: assessment.attemptId,
        candidateHeadSha: assessment.candidateHeadSha,
        policyRevision: 'pol-wrong',
      }),
    });
    expect(policyMismatch.outcome).toBe('rejected');
    if (policyMismatch.outcome === 'rejected') {
      expect(policyMismatch.reason).toContain('policy');
    }

    // Mismatch in attemptId
    const attemptMismatch = await useCase.recordVerificationReceipt({
      assessmentId: assessment.id,
      receipt: makeVerificationReceipt({
        assessmentId: assessment.id,
        projectId: assessment.projectId,
        candidateHeadSha: assessment.candidateHeadSha,
        policyRevision: assessment.policyRevision,
        attemptId: 'att-wrong',
      }),
    });
    expect(attemptMismatch.outcome).toBe('rejected');
    if (attemptMismatch.outcome === 'rejected') {
      expect(attemptMismatch.reason).toContain('attempt');
    }

    // Mismatch in projectId
    const projectMismatch = await useCase.recordVerificationReceipt({
      assessmentId: assessment.id,
      receipt: makeVerificationReceipt({
        assessmentId: assessment.id,
        attemptId: assessment.attemptId,
        candidateHeadSha: assessment.candidateHeadSha,
        policyRevision: assessment.policyRevision,
        projectId: 'proj-wrong',
      }),
    });
    expect(projectMismatch.outcome).toBe('rejected');
    if (projectMismatch.outcome === 'rejected') {
      expect(projectMismatch.reason).toContain('project');
    }
  });

  it('RecordReviewReceiptUseCase checks mismatch in each field (head, policy, attempt, project)', async () => {
    const repo = new EvidenceAssessmentRepositoryAdapter();
    const useCase = new RecordReviewReceiptUseCase({ repo });

    const assessment = makeAssessmentRecord({
      id: 'asmt-ident-test-rr',
      projectId: 'proj-expected',
      attemptId: 'att-expected',
      candidateHeadSha: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
      policyRevision: 'pol-expected',
      state: 'pending',
    });
    await repo.saveAssessment(assessment);

    // Mismatch in candidateHeadSha
    const headMismatch = await useCase.recordReviewReceipt({
      assessmentId: assessment.id,
      receipt: makeReviewReceipt({
        assessmentId: assessment.id,
        projectId: assessment.projectId,
        attemptId: assessment.attemptId,
        policyRevision: assessment.policyRevision,
        candidateHeadSha: 'ffff9999ffff9999ffff9999ffff9999ffff9999',
      }),
    });
    expect(headMismatch.outcome).toBe('rejected');
    if (headMismatch.outcome === 'rejected') {
      expect(headMismatch.reason).toContain('head');
    }

    // Mismatch in policyRevision
    const policyMismatch = await useCase.recordReviewReceipt({
      assessmentId: assessment.id,
      receipt: makeReviewReceipt({
        assessmentId: assessment.id,
        projectId: assessment.projectId,
        attemptId: assessment.attemptId,
        candidateHeadSha: assessment.candidateHeadSha,
        policyRevision: 'pol-wrong',
      }),
    });
    expect(policyMismatch.outcome).toBe('rejected');
    if (policyMismatch.outcome === 'rejected') {
      expect(policyMismatch.reason).toContain('policy');
    }

    // Mismatch in attemptId
    const attemptMismatch = await useCase.recordReviewReceipt({
      assessmentId: assessment.id,
      receipt: makeReviewReceipt({
        assessmentId: assessment.id,
        projectId: assessment.projectId,
        candidateHeadSha: assessment.candidateHeadSha,
        policyRevision: assessment.policyRevision,
        attemptId: 'att-wrong',
      }),
    });
    expect(attemptMismatch.outcome).toBe('rejected');
    if (attemptMismatch.outcome === 'rejected') {
      expect(attemptMismatch.reason).toContain('attempt');
    }

    // Mismatch in projectId
    const projectMismatch = await useCase.recordReviewReceipt({
      assessmentId: assessment.id,
      receipt: makeReviewReceipt({
        assessmentId: assessment.id,
        attemptId: assessment.attemptId,
        candidateHeadSha: assessment.candidateHeadSha,
        policyRevision: assessment.policyRevision,
        projectId: 'proj-wrong',
      }),
    });
    expect(projectMismatch.outcome).toBe('rejected');
    if (projectMismatch.outcome === 'rejected') {
      expect(projectMismatch.reason).toContain('project');
    }
  });
});
