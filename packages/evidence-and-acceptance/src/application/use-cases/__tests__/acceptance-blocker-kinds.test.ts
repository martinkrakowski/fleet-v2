import { describe, expect, it } from 'vitest';

import type {
  EvidenceAssessmentRecord,
  ReviewFindingRecord,
  ReviewReceiptRecord,
} from '../../../domain/evidence-records.js';
import {
  ACCEPTANCE_BLOCKER_KINDS,
  acceptanceBlocker,
  isAcceptanceBlockerKind,
} from '../../../domain/acceptance-blockers.js';
import type { EvidenceResultValue } from '../../../domain/value-objects/EvidenceResult.vo.js';
import type {
  AssessHeadAcceptanceRequest,
  AssessHeadAcceptanceResult,
} from '../../ports/in/AssessHeadAcceptancePort.in-port.js';
import type { EvidenceAssessmentRepositoryPort } from '../../ports/out/EvidenceAssessmentRepositoryPort.out-port.js';
import type { AttemptOwnerDecisionPort } from '../../ports/out/AttemptOwnerDecisionPort.out-port.js';
import type { ForgeEvidencePort } from '../../ports/out/ForgeEvidencePort.out-port.js';
import {
  AssessHeadAcceptanceUseCase,
  type AssessHeadAcceptanceDependencies,
} from '../AssessHeadAcceptanceUseCase.use-case.js';

const HEAD = '1111111111111111111111111111111111111111';
const OTHER_HEAD = '2222222222222222222222222222222222222222';

/** An attempt whose frozen brief named no owner decisions. */
const NO_OWNER_DECISIONS: AttemptOwnerDecisionPort = {
  async readAttemptOwnerDecisionReferences() {
    return { outcome: 'recorded', ownerDecisionReferences: [] };
  },
};

/** An attempt whose frozen door references are unreadable. */
const unknownDoors: AttemptOwnerDecisionPort = {
  async readAttemptOwnerDecisionReferences() {
    return { outcome: 'unknown', reason: 'example' };
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

function forge(ciState: EvidenceResultValue, unresolvedThreadCount: number | null): ForgeEvidencePort {
  return {
    async readForgeCheckStatus() {
      return { candidateHeadSha: HEAD, ciState, unresolvedThreadCount, observedHeadSha: HEAD };
    },
  };
}

async function assess(
  record: EvidenceAssessmentRecord,
  deps: Partial<AssessHeadAcceptanceDependencies> = {},
  request: Partial<AssessHeadAcceptanceRequest> = {},
): Promise<AssessHeadAcceptanceResult> {
  const useCase = new AssessHeadAcceptanceUseCase({
    repo: new InMemoryAssessmentRepo([record]),
    attemptOwnerDecisionPort: NO_OWNER_DECISIONS,
    ...deps,
  });
  return useCase.assessHeadAcceptance({
    assessmentId: 'asm-1',
    candidateHeadSha: HEAD,
    policyRevision: 'pol-1',
    ...request,
  });
}

function expectConsistent(result: AssessHeadAcceptanceResult): void {
  if (result.outcome !== 'blocked') {
    return;
  }
  expect(result.blockerDetails.map((detail) => detail.text)).toEqual(result.blockers);
  for (const detail of result.blockerDetails) {
    expect(isAcceptanceBlockerKind(detail.kind)).toBe(true);
  }
  expect(Object.hasOwn(result.assessment!, 'blockerDetails')).toBe(false);
  expect(result.assessment?.blockers).toEqual(result.blockers);
}

describe('acceptance blocker kinds (AM3c-1, A11)', () => {
  it('pending CI is the only blocker', async () => {
    const result = await assess(sampleRecord(), { forgeEvidence: forge('pending', 0) });
    expectConsistent(result);
    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.blockerDetails).toEqual([
        { kind: 'ci-pending', text: "forge reports CI state 'pending' for this candidate head" },
      ]);
    }
  });

  it('failed CI is ci-failed', async () => {
    const result = await assess(sampleRecord(), { forgeEvidence: forge('fail', 0) });
    expectConsistent(result);
    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.blockerDetails).toEqual([
        { kind: 'ci-failed', text: "forge reports CI state 'fail' for this candidate head" },
      ]);
    }
  });

  it('unknown CI is not pending', async () => {
    const result = await assess(sampleRecord(), { forgeEvidence: forge('unknown', 0) });
    expectConsistent(result);
    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.blockerDetails).toEqual([
        { kind: 'other', text: "forge reports CI state 'unknown' for this candidate head" },
      ]);
    }
  });

  it('unreadable threads are threads-unreadable', async () => {
    const result = await assess(sampleRecord(), { forgeEvidence: forge('pass', null) });
    expectConsistent(result);
    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.blockerDetails).toEqual([
        { kind: 'threads-unreadable', text: 'forge could not read review threads for this candidate head' },
      ]);
    }
  });

  it('unresolved threads are threads-unresolved', async () => {
    const result = await assess(sampleRecord(), { forgeEvidence: forge('pass', 3) });
    expectConsistent(result);
    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.blockerDetails).toEqual([
        {
          kind: 'threads-unresolved',
          text: 'forge reports 3 unresolved review thread(s) for this candidate head',
        },
      ]);
    }
  });

  it('pending CI with unresolved threads keeps both kinds in order', async () => {
    const result = await assess(sampleRecord(), { forgeEvidence: forge('pending', 2) });
    expectConsistent(result);
    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.blockerDetails.map((detail) => detail.kind)).toEqual([
        'ci-pending',
        'threads-unresolved',
      ]);
    }
  });

  it('no independent review recorded is review-missing', async () => {
    const result = await assess(sampleRecord({ reviewReceipts: [] }));
    expectConsistent(result);
    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.blockerDetails).toEqual([
        { kind: 'review-missing', text: 'no independent review was recorded for this candidate head' },
      ]);
    }
  });

  it('a receipt recording another implementer seat is review-missing', async () => {
    const receipt = independentReviewReceiptWithFindings([], { implementerModel: 'seat-c/other' });
    const result = await assess(sampleRecord({ reviewReceipts: [receipt] }));
    expectConsistent(result);
    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.blockerDetails).toHaveLength(1);
      expect(result.blockerDetails[0].kind).toBe('review-missing');
      expect(result.blockerDetails[0].text).toContain('is not independent');
    }
  });

  it('a failing review is other', async () => {
    const receipt = independentReviewReceiptWithFindings([], { result: 'fail' });
    const result = await assess(sampleRecord({ reviewReceipts: [receipt] }));
    expectConsistent(result);
    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.blockerDetails).toHaveLength(1);
      expect(result.blockerDetails[0].kind).toBe('other');
      expect(result.blockerDetails[0].text.startsWith("review by 'seat-a/reviewer' failed")).toBe(true);
    }
  });

  it('an unknown door decision blocks with a door kind', async () => {
    const result = await assess(sampleRecord(), { attemptOwnerDecisionPort: unknownDoors });
    expectConsistent(result);
    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.blockerDetails).toEqual([
        { kind: 'door', text: "owner decision references for attempt 'att-1' are unknown: example" },
      ]);
    }
  });

  it('an unresolved recorded reference without an owner decision port blocks with a door kind', async () => {
    const recordedDoors: AttemptOwnerDecisionPort = {
      async readAttemptOwnerDecisionReferences() {
        return { outcome: 'recorded', ownerDecisionReferences: ['door-example-1'] };
      },
    };
    const result = await assess(sampleRecord(), { attemptOwnerDecisionPort: recordedDoors });
    expectConsistent(result);
    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.blockerDetails).toEqual([
        {
          kind: 'door',
          text: "owner decision 'door-example-1' could not be resolved: no owner decision port is configured",
        },
      ]);
    }
  });

  it('an already accepted record still blocks when a door is unknown, with only door kinds', async () => {
    const accepted = sampleRecord({ state: 'accepted', acceptanceReceiptId: 'acc-1' });
    const result = await assess(accepted, { attemptOwnerDecisionPort: unknownDoors });
    expectConsistent(result);
    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.blockerDetails.map((detail) => detail.kind)).toEqual(['door']);
    }
  });

  it('a required check without a receipt is other', async () => {
    const result = await assess(sampleRecord({ requiredChecks: ['typecheck'] }));
    expectConsistent(result);
    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.blockerDetails).toEqual([
        { kind: 'other', text: "required check 'typecheck' has no completed verification receipt" },
      ]);
    }
  });

  it('an unresolved finding is other', async () => {
    const record = sampleRecord({
      reviewReceipts: [independentReviewReceiptWithFindings([finding('f-1')])],
    });
    const result = await assess(record);
    expectConsistent(result);
    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.blockerDetails).toEqual([
        { kind: 'other', text: "finding 'f-1' is unresolved" },
      ]);
    }
  });

  it('forge mode none with a CI requirement blocks twice as other', async () => {
    const record = sampleRecord({ requiredChecks: ['ci'] });
    const result = await assess(record, { forgeMode: 'none' });
    expectConsistent(result);
    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.blockerDetails).toEqual([
        { kind: 'other', text: "required check 'ci' has no completed verification receipt" },
        {
          kind: 'other',
          text: "forge mode is 'none': the brief requires CI state, and forge evidence is 'not-configured'",
        },
      ]);
    }
  });

  it('blocker texts are unchanged and ordered with their kinds', async () => {
    const record = sampleRecord({ requiredChecks: ['typecheck'], reviewReceipts: [] });
    const result = await assess(record, { attemptOwnerDecisionPort: unknownDoors });
    expectConsistent(result);
    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.blockers).toEqual([
        "owner decision references for attempt 'att-1' are unknown: example",
        "required check 'typecheck' has no completed verification receipt",
        'no independent review was recorded for this candidate head',
      ]);
      expect(result.blockerDetails.map((detail) => detail.kind)).toEqual([
        'door',
        'other',
        'review-missing',
      ]);
    }
  });

  it('a stale outcome carries no blocker details', async () => {
    const result = await assess(sampleRecord(), {}, { candidateHeadSha: OTHER_HEAD });
    expect(result).toEqual({ outcome: 'stale', reason: 'Candidate head or policy revision changed' });
    expect('blockerDetails' in result).toBe(false);
  });

  it('an unknown assessment id carries no blocker details', async () => {
    const result = await assess(sampleRecord(), {}, { assessmentId: 'missing' });
    expect(result).toEqual({ outcome: 'rejected', reason: 'Assessment not found' });
    expect('blockerDetails' in result).toBe(false);
  });

  it('an accepted result carries no blockerDetails key', async () => {
    const result = await assess(sampleRecord());
    expect(result.outcome).toBe('accepted');
    if (result.outcome === 'accepted') {
      expect('blockerDetails' in result).toBe(false);
    }
  });

  it('the kind list matches A11 and guards are sound', () => {
    expect(ACCEPTANCE_BLOCKER_KINDS).toEqual([
      'ci-pending',
      'ci-failed',
      'threads-unresolved',
      'threads-unreadable',
      'review-missing',
      'door',
      'stale',
      'other',
    ]);
    expect(isAcceptanceBlockerKind('pending')).toBe(false);
    expect(isAcceptanceBlockerKind('')).toBe(false);
    expect(isAcceptanceBlockerKind(null)).toBe(false);
    expect(isAcceptanceBlockerKind(42)).toBe(false);
    expect(Object.isFrozen(acceptanceBlocker('other', 'x'))).toBe(true);
  });
});
