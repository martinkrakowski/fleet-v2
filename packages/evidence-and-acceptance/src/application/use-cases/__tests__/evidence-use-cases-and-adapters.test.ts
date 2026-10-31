// Step 7 — application and infrastructure tests for evidence-and-acceptance.
// Covers the station invariants: exact-head binding, no implicit pass for
// pending/unknown/unresolved evidence, reviewer independence judged on the
// underlying model, explicit blockers, and scoped acceptance receipts.

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  EvidenceAssessmentRecord,
  FindingDispositionRecord,
  ReviewFindingRecord,
  ReviewReceiptRecord,
  VerificationReceiptRecord,
} from '../../../domain/evidence-records.js';
import type { EvidenceResultValue } from '../../../domain/value-objects/EvidenceResult.vo.js';
import type { EvidenceAssessmentRepositoryPort } from '../../ports/out/EvidenceAssessmentRepositoryPort.out-port.js';
import type { AttemptOwnerDecisionPort } from '../../ports/out/AttemptOwnerDecisionPort.out-port.js';
import type { EvidenceArchivePort } from '../../ports/out/EvidenceArchivePort.out-port.js';
import type { ForgeCheckStatus, ForgeEvidencePort } from '../../ports/out/ForgeEvidencePort.out-port.js';
import type {
  IndependentReviewPort,
  RunIndependentReviewRequest,
} from '../../ports/out/IndependentReviewPort.out-port.js';
import type { VerificationExecutorPort } from '../../ports/out/VerificationExecutorPort.out-port.js';
import type {
  AssessHeadAcceptanceRequest,
  AssessHeadAcceptanceResult,
} from '../../ports/in/AssessHeadAcceptancePort.in-port.js';
import type { InspectAcceptanceEvidenceResult } from '../../ports/in/InspectAcceptanceEvidencePort.in-port.js';
import type {
  RecordFindingDispositionResult,
} from '../../ports/in/RecordFindingDispositionPort.in-port.js';
import type { RecordReviewReceiptResult } from '../../ports/in/RecordReviewReceiptPort.in-port.js';
import type { RecordVerificationReceiptResult } from '../../ports/in/RecordVerificationReceiptPort.in-port.js';
import type { RequestIndependentReviewResult } from '../../ports/in/RequestIndependentReviewPort.in-port.js';
import type { RequestVerificationResult } from '../../ports/in/RequestVerificationPort.in-port.js';
import { AssessHeadAcceptanceUseCase } from '../AssessHeadAcceptanceUseCase.use-case.js';
import { InspectAcceptanceEvidenceUseCase } from '../InspectAcceptanceEvidenceUseCase.use-case.js';
import { RecordFindingDispositionUseCase } from '../RecordFindingDispositionUseCase.use-case.js';
import { RecordReviewReceiptUseCase } from '../RecordReviewReceiptUseCase.use-case.js';
import { RecordVerificationReceiptUseCase } from '../RecordVerificationReceiptUseCase.use-case.js';
import { RequestIndependentReviewUseCase } from '../RequestIndependentReviewUseCase.use-case.js';
import { RequestVerificationUseCase } from '../RequestVerificationUseCase.use-case.js';
import { EvidenceArchiveAdapter } from '../../../infrastructure/adapters/EvidenceArchiveAdapter.adapter.js';
import { EvidenceAssessment } from '../../../domain/entities/EvidenceAssessment.js';
import { EvidenceAssessmentRepositoryAdapter } from '../../../infrastructure/adapters/EvidenceAssessmentRepositoryAdapter.adapter.js';
import { ForgeEvidenceAdapter } from '../../../infrastructure/adapters/ForgeEvidenceAdapter.adapter.js';
import { IndependentReviewAdapter } from '../../../infrastructure/adapters/IndependentReviewAdapter.adapter.js';
import { VerificationExecutorAdapter } from '../../../infrastructure/adapters/VerificationExecutorAdapter.adapter.js';

const HEAD = '1111111111111111111111111111111111111111';
const OTHER_HEAD = '2222222222222222222222222222222222222222';
const IMPLEMENTER_MODEL = 'openrouter/z-ai/glm-5.3-flash';
const REVIEWER_MODEL = 'openrouter/poolside/laguna-s-2.1';
const NOW = '2026-10-15T00:00:00.000Z';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const created = mkdtempSync(join(tmpdir(), 'fleet-evidence-'));
  temporaryDirectories.push(created);
  return created;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0, temporaryDirectories.length)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
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

function verificationReceipt(
  overrides: Partial<VerificationReceiptRecord> = {},
): VerificationReceiptRecord {
  return {
    id: 'vr-1',
    assessmentId: 'ea-1',
    projectId: 'proj-1',
    attemptId: 'att-1',
    candidateHeadSha: HEAD,
    hostId: 'host-1',
    procedureName: 'ci',
    result: 'pass',
    exitCode: 0,
    evidenceRef: 'evidence://verification-ea-1-ci',
    policyRevision: 'policy-7',
    completedAtIso: NOW,
    ...overrides,
  };
}

function reviewReceipt(overrides: Partial<ReviewReceiptRecord> = {}): ReviewReceiptRecord {
  return {
    id: 'rr-1',
    assessmentId: 'ea-1',
    projectId: 'proj-1',
    attemptId: 'att-1',
    candidateHeadSha: HEAD,
    reviewerModel: REVIEWER_MODEL,
    implementerModel: IMPLEMENTER_MODEL,
    readOnlyVerified: true,
    result: 'pass',
    findings: [],
    evidenceRef: 'evidence://review-ea-1',
    policyRevision: 'policy-7',
    completedAtIso: NOW,
    ...overrides,
  };
}

function disposition(overrides: Partial<FindingDispositionRecord> = {}): FindingDispositionRecord {
  return {
    id: 'fd-1',
    assessmentId: 'ea-1',
    findingId: 'f-1',
    candidateHeadSha: HEAD,
    state: 'fixed',
    reason: 'patched in the candidate head',
    evidenceRef: 'evidence://fix-f-1',
    recordedBy: 'orchestrator',
    recordedAtIso: NOW,
    ...overrides,
  };
}

function assessmentRecord(
  overrides: Partial<EvidenceAssessmentRecord> = {},
): EvidenceAssessmentRecord {
  return {
    id: 'ea-1',
    projectId: 'proj-1',
    attemptId: 'att-1',
    candidateHeadSha: HEAD,
    policyRevision: 'policy-7',
    implementerModel: IMPLEMENTER_MODEL,
    requiredChecks: ['ci'],
    state: 'pending',
    verificationReceipts: [],
    reviewReceipts: [],
    findingDispositions: [],
    acceptanceReceiptId: null,
    blockers: [],
    revision: 0,
    updatedAtIso: NOW,
    ...overrides,
  };
}

interface FakeRepository extends EvidenceAssessmentRepositoryPort {
  readonly records: Map<string, EvidenceAssessmentRecord>;
  saved: number;
}

function fakeRepository(seed: readonly EvidenceAssessmentRecord[] = []): FakeRepository {
  const records = new Map<string, EvidenceAssessmentRecord>();
  for (const record of seed) {
    records.set(record.id, record);
  }
  return {
    records,
    saved: 0,
    async saveAssessment(record) {
      this.records.set(record.id, record);
      this.saved += 1;
    },
    async findAssessmentById(assessmentId) {
      return records.get(assessmentId) ?? null;
    },
    async findAssessmentByHead(candidateHeadSha) {
      for (const record of records.values()) {
        if (record.candidateHeadSha === candidateHeadSha) {
          return record;
        }
      }
      return null;
    },
  };
}

function recordingArchive(): EvidenceArchivePort & { readonly artifacts: Map<string, string> } {
  const artifacts = new Map<string, string>();
  return {
    artifacts,
    async archiveEvidence(request) {
      const digest = sha256Hex(request.content);
      artifacts.set(request.artifactId, request.content);
      return { evidenceRef: `evidence://${request.artifactId}@${digest}`, digest };
    },
    async readArchivedEvidence(evidenceRef) {
      for (const [artifactId, content] of artifacts) {
        if (evidenceRef.startsWith(`evidence://${artifactId}@`)) {
          return content;
        }
      }
      return null;
    },
  };
}

function stubExecutor(
  results: Readonly<Record<string, EvidenceResultValue>>,
): VerificationExecutorPort & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async executeVerificationCheck(request) {
      calls.push(request.procedureName);
      const result = results[request.procedureName] ?? 'unknown';
      return {
        result,
        exitCode: result === 'pass' ? 0 : result === 'fail' ? 1 : null,
        outputSummary: `${request.procedureName}: ${result}`,
        completedAtIso: NOW,
      };
    },
  };
}

function stubReviewer(
  response: Awaited<ReturnType<IndependentReviewPort['runIndependentReview']>>,
): IndependentReviewPort & { readonly calls: RunIndependentReviewRequest[] } {
  const calls: RunIndependentReviewRequest[] = [];
  return {
    calls,
    async runIndependentReview(request) {
      calls.push(request);
      return response;
    },
  };
}

function stubForge(status: ForgeCheckStatus): ForgeEvidencePort {
  return {
    async readForgeCheckStatus() {
      return status;
    },
  };
}

function requestVerification(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    assessmentId: 'ea-1',
    projectId: 'proj-1',
    attemptId: 'att-1',
    candidateHeadSha: HEAD,
    policyRevision: 'policy-7',
    hostId: 'host-1',
    implementerModel: IMPLEMENTER_MODEL,
    requiredChecks: ['ci', 'unit-tests'],
    nowIso: NOW,
    ...overrides,
  };
}

function requestReview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    assessmentId: 'ea-1',
    projectId: 'proj-1',
    attemptId: 'att-1',
    candidateHeadSha: HEAD,
    policyRevision: 'policy-7',
    implementerModel: IMPLEMENTER_MODEL,
    reviewerModel: REVIEWER_MODEL,
    nowIso: NOW,
    ...overrides,
  };
}

function assessRequest(overrides: Record<string, unknown> = {}): AssessHeadAcceptanceRequest {
  return {
    assessmentId: 'ea-1',
    candidateHeadSha: HEAD,
    policyRevision: 'policy-7',
    nowIso: NOW,
    ...overrides,
  } as AssessHeadAcceptanceRequest;
}

describe('unconfigured use cases refuse instead of guessing', () => {
  const unconfigured: readonly (readonly [string, { execute(input: unknown): Promise<unknown> }])[] = [
    ['RequestVerificationUseCase', new RequestVerificationUseCase()],
    ['RecordVerificationReceiptUseCase', new RecordVerificationReceiptUseCase()],
    ['RequestIndependentReviewUseCase', new RequestIndependentReviewUseCase()],
    ['RecordReviewReceiptUseCase', new RecordReviewReceiptUseCase()],
    ['RecordFindingDispositionUseCase', new RecordFindingDispositionUseCase()],
    ['AssessHeadAcceptanceUseCase', new AssessHeadAcceptanceUseCase()],
    ['InspectAcceptanceEvidenceUseCase', new InspectAcceptanceEvidenceUseCase()],
  ];

  it.each(unconfigured)('%s throws Not implemented without dependencies', async (name, useCase) => {
    await expect(useCase.execute(undefined)).rejects.toThrow(`Not implemented: ${name}`);
  });

  it('still refuses a configured use case that receives no request object', async () => {
    const useCase = new InspectAcceptanceEvidenceUseCase({ repo: fakeRepository() });
    await expect(useCase.execute(undefined)).rejects.toThrow(
      'Not implemented: InspectAcceptanceEvidenceUseCase',
    );
  });
});

describe('RequestVerificationUseCase', () => {
  it('runs every required check, archives output and records one receipt per check', async () => {
    const repo = fakeRepository();
    const archive = recordingArchive();
    const executor = stubExecutor({ ci: 'pass', 'unit-tests': 'not-applicable' });
    const useCase = new RequestVerificationUseCase({ repo, executor, archive });

    const result: RequestVerificationResult = await useCase.requestVerification(
      requestVerification() as never,
    );

    expect(executor.calls).toEqual(['ci', 'unit-tests']);
    expect(result.outcome).toBe('completed');
    if (result.outcome !== 'completed') {
      throw new Error('expected a completed verification');
    }
    expect(result.receipts.map((receipt) => receipt.procedureName)).toEqual(['ci', 'unit-tests']);
    expect(result.receipts[0]?.evidenceRef).toBe(
      `evidence://verification-ea-1-ci-${HEAD}@${sha256Hex('ci: pass')}`,
    );
    expect(result.assessment.verificationReceipts).toHaveLength(2);
    expect(result.assessment.state).toBe('pending');
    expect(result.assessment.blockers).toEqual([]);
    expect(result.assessment.revision).toBe(1);
    expect(archive.artifacts.get(`verification-ea-1-ci-${HEAD}`)).toBe('ci: pass');
  });

  it('rejects a request that names no required check', async () => {
    const useCase = new RequestVerificationUseCase({
      repo: fakeRepository(),
      executor: stubExecutor({}),
      archive: recordingArchive(),
    });

    const result = await useCase.requestVerification(
      requestVerification({ requiredChecks: [] }) as never,
    );

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'Verification requires at least one required check',
    });
  });

  it('rejects a request without an exact head', async () => {
    const useCase = new RequestVerificationUseCase({
      repo: fakeRepository(),
      executor: stubExecutor({}),
      archive: recordingArchive(),
    });

    const result = await useCase.requestVerification(
      requestVerification({ candidateHeadSha: '  ' }) as never,
    );

    expect(result.outcome).toBe('rejected');
  });

  it('keeps the assessment blocked when a check fails and never implies a pass', async () => {
    const repo = fakeRepository();
    const useCase = new RequestVerificationUseCase({
      repo,
      executor: stubExecutor({ ci: 'fail', 'unit-tests': 'pass' }),
      archive: recordingArchive(),
    });

    const result = await useCase.requestVerification(requestVerification() as never);

    if (result.outcome !== 'completed') {
      throw new Error('expected a completed verification');
    }
    expect(result.assessment.state).toBe('blocked');
    expect(result.assessment.blockers).toEqual([
      "required check 'ci' has no passing verification receipt",
    ]);
    expect(result.assessment.acceptanceReceiptId).toBeNull();
  });

  it('treats an unknown executor result as a blocker rather than a pass', async () => {
    const useCase = new RequestVerificationUseCase({
      repo: fakeRepository(),
      executor: stubExecutor({ ci: 'unknown', 'unit-tests': 'pending' }),
      archive: recordingArchive(),
    });

    const result = await useCase.requestVerification(requestVerification() as never);

    if (result.outcome !== 'completed') {
      throw new Error('expected a completed verification');
    }
    expect(result.assessment.blockers).toHaveLength(2);
  });

  it('replaces the earlier receipt for the same procedure instead of duplicating it', async () => {
    const repo = fakeRepository([
      assessmentRecord({
        verificationReceipts: [verificationReceipt({ id: 'vr-old', result: 'fail', exitCode: 1 })],
        revision: 1,
      }),
    ]);
    const useCase = new RequestVerificationUseCase({
      repo,
      executor: stubExecutor({ ci: 'pass' }),
      archive: recordingArchive(),
    });

    const result = await useCase.requestVerification(
      requestVerification({ requiredChecks: ['ci'] }) as never,
    );

    if (result.outcome !== 'completed') {
      throw new Error('expected a completed verification');
    }
    expect(result.assessment.verificationReceipts).toHaveLength(1);
    expect(result.assessment.verificationReceipts[0]?.id).toBe('vr-ea-1-ci');
    expect(result.assessment.revision).toBe(2);
  });
});

describe('RequestIndependentReviewUseCase', () => {
  const completedReview = {
    outcome: 'completed' as const,
    readOnlyVerified: true,
    result: 'pass' as const,
    findings: [finding('f-1')],
    rawOutput: 'reviewer output',
    completedAtIso: NOW,
  };

  it('rejects a reviewer identical to the implementer', async () => {
    const reviewer = stubReviewer(completedReview);
    const useCase = new RequestIndependentReviewUseCase({
      repo: fakeRepository(),
      reviewer,
      archive: recordingArchive(),
    });

    const result = await useCase.requestIndependentReview(
      requestReview({ reviewerModel: IMPLEMENTER_MODEL }) as never,
    );

    expect(result.outcome).toBe('rejected');
    if (result.outcome !== 'rejected') {
      throw new Error('expected a rejection');
    }
    expect(result.reason).toContain('share the same underlying model');
    expect(reviewer.calls).toHaveLength(0);
  });

  it('rejects the same underlying model arriving through a different provider', async () => {
    const reviewer = stubReviewer(completedReview);
    const useCase = new RequestIndependentReviewUseCase({
      repo: fakeRepository(),
      reviewer,
      archive: recordingArchive(),
    });

    const result = await useCase.requestIndependentReview(
      requestReview({
        implementerModel: 'nvidia/z-ai/glm-5.3-flash',
        reviewerModel: 'openrouter/z-ai/glm-5.3-flash',
      }) as never,
    );

    expect(result.outcome).toBe('rejected');
    if (result.outcome !== 'rejected') {
      throw new Error('expected a rejection');
    }
    expect(result.reason).toContain('share the same underlying model');
    expect(reviewer.calls).toHaveLength(0);
  });

  it('rejects a review that could not prove it stayed read-only', async () => {
    const useCase = new RequestIndependentReviewUseCase({
      repo: fakeRepository([assessmentRecord({ requiredChecks: [] })]),
      reviewer: stubReviewer({ ...completedReview, readOnlyVerified: false }),
      archive: recordingArchive(),
    });

    const result = await useCase.requestIndependentReview(requestReview() as never);

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'Independent review was not verified read-only, so it is not evidence',
    });
  });

  it('rejects an unavailable reviewer seat', async () => {
    const useCase = new RequestIndependentReviewUseCase({
      repo: fakeRepository([assessmentRecord({ requiredChecks: [] })]),
      reviewer: stubReviewer({ outcome: 'unavailable', reason: 'seat is busy', code: 'transport-failed' }),
      archive: recordingArchive(),
    });

    const result = await useCase.requestIndependentReview(requestReview() as never);

    expect(result).toEqual({ outcome: 'rejected', reason: 'seat is busy' });
  });

  it('archives the raw output and appends the receipt to the assessment', async () => {
    const repo = fakeRepository([assessmentRecord({ requiredChecks: [] })]);
    const archive = recordingArchive();
    const reviewer = stubReviewer(completedReview);
    const useCase = new RequestIndependentReviewUseCase({ repo, reviewer, archive });

    const result: RequestIndependentReviewResult = await useCase.requestIndependentReview(
      requestReview() as never,
    );

    expect(result.outcome).toBe('reviewed');
    if (result.outcome !== 'reviewed') {
      throw new Error('expected a recorded review');
    }
    expect(result.receipt.id).toBe(`rr-ea-1-${HEAD.slice(0, 8)}`);
    expect(result.receipt.evidenceRef).toBe(
      `evidence://review-ea-1-${HEAD}@${sha256Hex('reviewer output')}`,
    );
    expect(reviewer.calls[0]).toEqual({
      attemptId: 'att-1',
      candidateHeadSha: HEAD,
      implementerModel: IMPLEMENTER_MODEL,
      reviewerModel: REVIEWER_MODEL,
      diffSummary: undefined,
    });
    const stored = repo.records.get('ea-1');
    expect(stored?.reviewReceipts).toHaveLength(1);
    expect(stored?.blockers).toEqual(["finding 'f-1' is unresolved"]);
    expect(stored?.state).toBe('blocked');
  });

  it('rejects when no assessment exists yet', async () => {
    const repo = fakeRepository();
    const reviewer = stubReviewer(completedReview);
    const useCase = new RequestIndependentReviewUseCase({
      repo,
      reviewer,
      archive: recordingArchive(),
    });

    const result = await useCase.requestIndependentReview(requestReview() as never);

    expect(result).toEqual({
      outcome: 'rejected',
      reason: "No assessment exists for assessmentId 'ea-1'",
    });
    expect(reviewer.calls).toHaveLength(0);
    expect(repo.saved).toBe(0);
  });

  it('rejects when the assessment exists for another candidate head', async () => {
    const repo = fakeRepository([assessmentRecord({ candidateHeadSha: OTHER_HEAD })]);
    const reviewer = stubReviewer(completedReview);
    const useCase = new RequestIndependentReviewUseCase({
      repo,
      reviewer,
      archive: recordingArchive(),
    });

    const result = await useCase.requestIndependentReview(requestReview() as never);

    expect(result.outcome).toBe('rejected');
    if (result.outcome !== 'rejected') {
      throw new Error('expected a rejection');
    }
    expect(result.reason).toContain('exists for candidate head');
    expect(reviewer.calls).toHaveLength(0);
    expect(repo.saved).toBe(0);
  });
});

describe('RecordVerificationReceiptUseCase', () => {
  it('rejects an unknown assessment', async () => {
    const useCase = new RecordVerificationReceiptUseCase({ repo: fakeRepository() });

    const result = await useCase.recordVerificationReceipt({
      assessmentId: 'ea-missing',
      receipt: verificationReceipt(),
    });

    expect(result).toEqual({ outcome: 'rejected', reason: 'Assessment not found' });
  });

  it('rejects a receipt produced for another head', async () => {
    const useCase = new RecordVerificationReceiptUseCase({
      repo: fakeRepository([assessmentRecord()]),
    });

    const result = await useCase.recordVerificationReceipt({
      assessmentId: 'ea-1',
      receipt: verificationReceipt({ candidateHeadSha: OTHER_HEAD }),
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome !== 'rejected') {
      throw new Error('expected a rejection');
    }
    expect(result.reason).toContain('not the assessed head');
  });

  it('rejects a receipt produced under another acceptance policy revision', async () => {
    const useCase = new RecordVerificationReceiptUseCase({
      repo: fakeRepository([assessmentRecord()]),
    });

    const result = await useCase.recordVerificationReceipt({
      assessmentId: 'ea-1',
      receipt: verificationReceipt({ policyRevision: 'policy-6' }),
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome !== 'rejected') {
      throw new Error('expected a rejection');
    }
    expect(result.reason).toContain('policy revision');
  });

  it('refuses to record a launched check as a completed one', async () => {
    const useCase = new RecordVerificationReceiptUseCase({
      repo: fakeRepository([assessmentRecord()]),
    });

    const result = await useCase.recordVerificationReceipt({
      assessmentId: 'ea-1',
      receipt: verificationReceipt({ result: 'pending', exitCode: null }),
    });

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'A launched check is not a completed one: a pending result is not evidence',
    });
  });

  it('records the receipt, replaces the same procedure and advances the revision', async () => {
    const repo = fakeRepository([
      assessmentRecord({
        verificationReceipts: [verificationReceipt({ id: 'vr-old', result: 'fail', exitCode: 1 })],
        revision: 3,
      }),
    ]);
    const useCase = new RecordVerificationReceiptUseCase({ repo });

    const result: RecordVerificationReceiptResult = await useCase.recordVerificationReceipt({
      assessmentId: 'ea-1',
      receipt: verificationReceipt({ id: 'vr-new' }),
      nowIso: NOW,
    });

    expect(result.outcome).toBe('recorded');
    if (result.outcome !== 'recorded') {
      throw new Error('expected a recorded receipt');
    }
    expect(result.assessment.verificationReceipts).toHaveLength(1);
    expect(result.assessment.verificationReceipts[0]?.id).toBe('vr-new');
    expect(result.assessment.revision).toBe(4);
    expect(result.assessment.state).toBe('pending');
    expect(result.assessment.blockers).toEqual([]);
  });
});

describe('RecordVerificationReceiptUseCase malformed input', () => {
  it('returns rejected instead of throwing for null, string, number and an object missing a required field', async () => {
    const repo = fakeRepository([assessmentRecord()]);
    const useCase = new RecordVerificationReceiptUseCase({ repo });

    const missingRequiredField = verificationReceipt();
    delete (missingRequiredField as { evidenceRef?: string }).evidenceRef;

    const inputs: unknown[] = [null, 'x', 42, missingRequiredField];
    for (const receipt of inputs) {
      const result = await useCase.recordVerificationReceipt({
        assessmentId: 'ea-1',
        receipt: receipt as never,
      });
      expect(result.outcome).toBe('rejected');
    }
    expect(repo.saved).toBe(0);
  });
});

describe('RecordReviewReceiptUseCase', () => {
  it('rejects a review that was not verified read-only', async () => {
    const useCase = new RecordReviewReceiptUseCase({
      repo: fakeRepository([assessmentRecord({ requiredChecks: [] })]),
    });

    const result = await useCase.recordReviewReceipt({
      assessmentId: 'ea-1',
      receipt: reviewReceipt({ readOnlyVerified: false }),
    });

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'Review was not verified read-only, so it is not evidence',
    });
  });

  it('rejects the implementer reviewing its own model through another provider', async () => {
    const useCase = new RecordReviewReceiptUseCase({
      repo: fakeRepository([assessmentRecord({ requiredChecks: [] })]),
    });

    const result: RecordReviewReceiptResult = await useCase.recordReviewReceipt({
      assessmentId: 'ea-1',
      receipt: reviewReceipt({
        reviewerModel: 'nvidia/z-ai/glm-5.3-flash',
        implementerModel: 'openrouter/z-ai/glm-5.3-flash',
      }),
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome !== 'rejected') {
      throw new Error('expected a rejection');
    }
    expect(result.reason).toContain('shares the same underlying model as the implementer');
  });

  it('rejects a review bound to another head', async () => {
    const useCase = new RecordReviewReceiptUseCase({
      repo: fakeRepository([assessmentRecord({ requiredChecks: [] })]),
    });

    const result = await useCase.recordReviewReceipt({
      assessmentId: 'ea-1',
      receipt: reviewReceipt({ candidateHeadSha: OTHER_HEAD }),
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome !== 'rejected') {
      throw new Error('expected a rejection');
    }
    expect(result.reason).toContain('not the assessed head');
  });

  it('records an attributable independent review and advances the revision', async () => {
    const repo = fakeRepository([assessmentRecord({ requiredChecks: [], revision: 2 })]);
    const useCase = new RecordReviewReceiptUseCase({ repo });

    const result = await useCase.recordReviewReceipt({
      assessmentId: 'ea-1',
      receipt: reviewReceipt(),
      nowIso: NOW,
    });

    expect(result.outcome).toBe('recorded');
    if (result.outcome !== 'recorded') {
      throw new Error('expected a recorded review');
    }
    expect(result.assessment.reviewReceipts).toHaveLength(1);
    expect(result.assessment.revision).toBe(3);
  });
});

describe('RecordFindingDispositionUseCase', () => {
  const withFindings = (): EvidenceAssessmentRecord =>
    assessmentRecord({
      requiredChecks: [],
      reviewReceipts: [
        reviewReceipt({
          result: 'fail',
          findings: [finding('f-1'), finding('f-2')],
        }),
      ],
    });

  it('rejects a disposition that does not resolve the finding', async () => {
    const useCase = new RecordFindingDispositionUseCase({
      repo: fakeRepository([withFindings()]),
    });

    const result = await useCase.recordFindingDisposition({
      assessmentId: 'ea-1',
      disposition: disposition({ state: 'unresolved' }),
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome !== 'rejected') {
      throw new Error('expected a rejection');
    }
    expect(result.reason).toContain('fixed, refuted or out-of-scope');
  });

  it('rejects a disposition without a reason or an evidence reference', async () => {
    const useCase = new RecordFindingDispositionUseCase({
      repo: fakeRepository([withFindings()]),
    });

    const withoutReason = await useCase.recordFindingDisposition({
      assessmentId: 'ea-1',
      disposition: disposition({ reason: '   ' }),
    });
    const withoutEvidence = await useCase.recordFindingDisposition({
      assessmentId: 'ea-1',
      disposition: disposition({ evidenceRef: '' }),
    });

    expect(withoutReason.outcome).toBe('rejected');
    expect(withoutEvidence.outcome).toBe('rejected');
  });

  it('rejects a disposition recorded against another head', async () => {
    const useCase = new RecordFindingDispositionUseCase({
      repo: fakeRepository([withFindings()]),
    });

    const result = await useCase.recordFindingDisposition({
      assessmentId: 'ea-1',
      disposition: disposition({ candidateHeadSha: OTHER_HEAD }),
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome !== 'rejected') {
      throw new Error('expected a rejection');
    }
    expect(result.reason).toContain('not the assessed head');
  });

  it('rejects a disposition for a finding that was never raised', async () => {
    const useCase = new RecordFindingDispositionUseCase({
      repo: fakeRepository([withFindings()]),
    });

    const result = await useCase.recordFindingDisposition({
      assessmentId: 'ea-1',
      disposition: disposition({ findingId: 'f-404' }),
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome !== 'rejected') {
      throw new Error('expected a rejection');
    }
    expect(result.reason).toContain("No finding 'f-404'");
  });

  it('resolves only the named finding and preserves unresolved findings elsewhere', async () => {
    const repo = fakeRepository([withFindings()]);
    const useCase = new RecordFindingDispositionUseCase({ repo });

    const result: RecordFindingDispositionResult = await useCase.recordFindingDisposition({
      assessmentId: 'ea-1',
      disposition: disposition(),
      nowIso: NOW,
    });

    expect(result.outcome).toBe('recorded');
    if (result.outcome !== 'recorded') {
      throw new Error('expected a recorded disposition');
    }
    const findings = result.assessment.reviewReceipts[0]?.findings ?? [];
    expect(findings[0]?.state).toBe('fixed');
    expect(findings[0]?.dispositionReason).toBe('patched in the candidate head');
    expect(findings[0]?.dispositionEvidenceRef).toBe('evidence://fix-f-1');
    expect(findings[1]?.state).toBe('unresolved');
    expect(result.assessment.findingDispositions).toHaveLength(1);
    expect(result.assessment.blockers).toEqual(["finding 'f-2' is unresolved"]);
    expect(result.assessment.state).toBe('blocked');
    expect(result.assessment.revision).toBe(1);
  });

  it('records an evidence-backed refutation', async () => {
    const repo = fakeRepository([
      assessmentRecord({
        requiredChecks: [],
        reviewReceipts: [reviewReceipt({ result: 'fail', findings: [finding('f-1')] })],
      }),
    ]);
    const useCase = new RecordFindingDispositionUseCase({ repo });

    const result = await useCase.recordFindingDisposition({
      assessmentId: 'ea-1',
      disposition: disposition({ state: 'refuted', reason: 'the claim does not hold' }),
    });

    expect(result.outcome).toBe('recorded');
    if (result.outcome !== 'recorded') {
      throw new Error('expected a recorded disposition');
    }
    expect(result.assessment.reviewReceipts[0]?.findings[0]?.state).toBe('refuted');
    expect(result.assessment.blockers).toEqual([]);
  });

  it('records an out-of-scope disposition and drops the finding from the blockers', async () => {
    const repo = fakeRepository([withFindings()]);
    const useCase = new RecordFindingDispositionUseCase({ repo });

    const result = await useCase.recordFindingDisposition({
      assessmentId: 'ea-1',
      disposition: disposition({
        state: 'out-of-scope',
        reason: 'the finding names files this lane never changed',
      }),
      nowIso: NOW,
    });

    expect(result.outcome).toBe('recorded');
    if (result.outcome !== 'recorded') {
      throw new Error('expected a recorded disposition');
    }
    const findings = result.assessment.reviewReceipts[0]?.findings ?? [];
    expect(findings[0]?.state).toBe('out-of-scope');
    expect(findings[0]?.dispositionReason).toBe('the finding names files this lane never changed');
    expect(findings[1]?.state).toBe('unresolved');
    expect(result.assessment.blockers).toEqual(["finding 'f-2' is unresolved"]);
    expect(result.assessment.state).toBe('blocked');
  });

  it('refuses an out-of-scope disposition for a finding id raised by more than one receipt', async () => {
    const repo = fakeRepository([
      assessmentRecord({
        requiredChecks: [],
        reviewReceipts: [
          reviewReceipt({ id: 'rr-1', result: 'fail', findings: [finding('f-1')] }),
          reviewReceipt({ id: 'rr-2', result: 'fail', findings: [finding('f-1')] }),
        ],
      }),
    ]);
    const useCase = new RecordFindingDispositionUseCase({ repo });

    const result = await useCase.recordFindingDisposition({
      assessmentId: 'ea-1',
      disposition: disposition({ state: 'out-of-scope' }),
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome !== 'rejected') {
      throw new Error('expected a rejection');
    }
    expect(result.reason).toBe(
      'An out-of-scope disposition needs a finding id raised by exactly one receipt',
    );
    // Nothing was saved: the finding stays unresolved exactly as before.
    expect(repo.saved).toBe(0);
    const stored = repo.records.get('ea-1');
    if (!stored) {
      throw new Error('expected the seeded assessment to remain');
    }
    for (const receipt of stored.reviewReceipts) {
      for (const findingRecord of receipt.findings) {
        expect(findingRecord.state).toBe('unresolved');
      }
    }
  });

  it('refuses an out-of-scope disposition without a reason or an evidence reference', async () => {
    const useCase = new RecordFindingDispositionUseCase({
      repo: fakeRepository([withFindings()]),
    });

    const withoutReason = await useCase.recordFindingDisposition({
      assessmentId: 'ea-1',
      disposition: disposition({ state: 'out-of-scope', reason: '   ' }),
    });
    const withoutEvidence = await useCase.recordFindingDisposition({
      assessmentId: 'ea-1',
      disposition: disposition({ state: 'out-of-scope', evidenceRef: '' }),
    });

    expect(withoutReason.outcome).toBe('rejected');
    expect(withoutEvidence.outcome).toBe('rejected');
  });

  it('refuses an out-of-scope disposition for a finding id no receipt raised', async () => {
    const repo = fakeRepository([withFindings()]);
    const useCase = new RecordFindingDispositionUseCase({ repo });

    const result = await useCase.recordFindingDisposition({
      assessmentId: 'ea-1',
      disposition: disposition({ state: 'out-of-scope', findingId: 'f-404' }),
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome !== 'rejected') {
      throw new Error('expected a rejection');
    }
    expect(result.reason).toContain("No finding 'f-404'");
    expect(repo.saved).toBe(0);
  });

  it('lets a colliding receipt raise a finding id an earlier disposition resolved', async () => {
    const repo = fakeRepository([withFindings()]);
    const dispositionUseCase = new RecordFindingDispositionUseCase({ repo });
    const reviewUseCase = new RecordReviewReceiptUseCase({ repo });

    const dispositionResult = await dispositionUseCase.recordFindingDisposition({
      assessmentId: 'ea-1',
      disposition: disposition(),
      nowIso: NOW,
    });
    expect(dispositionResult.outcome).toBe('recorded');
    if (dispositionResult.outcome !== 'recorded') {
      throw new Error('expected a recorded disposition');
    }
    expect(dispositionResult.assessment.blockers).toEqual(["finding 'f-2' is unresolved"]);

    // A later receipt on the same head raises the same per-receipt id again.
    const receiptResult = await reviewUseCase.recordReviewReceipt({
      assessmentId: 'ea-1',
      receipt: reviewReceipt({ id: 'rr-2', result: 'fail', findings: [finding('f-1')] }),
      nowIso: NOW,
    });
    expect(receiptResult.outcome).toBe('recorded');
    if (receiptResult.outcome !== 'recorded') {
      throw new Error('expected a recorded receipt');
    }
    expect(receiptResult.assessment.blockers).toEqual([
      "finding 'f-1' is unresolved",
      "finding 'f-2' is unresolved",
    ]);
    expect(receiptResult.assessment.state).toBe('blocked');
  });

  it('keeps an id held by two receipts blocked under fixed and refuted dispositions', async () => {
    for (const state of ['fixed', 'refuted'] as const) {
      const repo = fakeRepository([
        assessmentRecord({
          requiredChecks: [],
          reviewReceipts: [
            reviewReceipt({ id: 'rr-1', result: 'fail', findings: [finding('f-1')] }),
            reviewReceipt({ id: 'rr-2', result: 'fail', findings: [finding('f-1')] }),
          ],
          findingDispositions: [disposition({ state })],
        }),
      ]);
      const assessment = EvidenceAssessment.fromRecord(repo.records.get('ea-1')!);
      expect(assessment.unresolvedFindingIds()).toEqual(['f-1']);
      expect(assessment.collectBlockers()).toEqual(["finding 'f-1' is unresolved"]);
    }
  });
});

describe('RecordFindingDispositionUseCase malformed input', () => {
  it('returns rejected instead of throwing for null, string, number and an object missing a required field', async () => {
    const repo = fakeRepository([
      assessmentRecord({
        requiredChecks: [],
        reviewReceipts: [reviewReceipt({ result: 'fail', findings: [finding('f-1')] })],
      }),
    ]);
    const useCase = new RecordFindingDispositionUseCase({ repo });

    const missingRequiredField = disposition();
    delete (missingRequiredField as { recordedBy?: string }).recordedBy;

    const inputs: unknown[] = [null, 'x', 42, missingRequiredField];
    for (const received of inputs) {
      const result = await useCase.recordFindingDisposition({
        assessmentId: 'ea-1',
        disposition: received as never,
      });
      expect(result.outcome).toBe('rejected');
    }
    expect(repo.saved).toBe(0);
  });
});

describe('AssessHeadAcceptanceUseCase', () => {
  /** An attempt whose frozen brief named no owner decisions. */
  const noOwnerDecisions: AttemptOwnerDecisionPort = {
    async readAttemptOwnerDecisionReferences() {
      return { outcome: 'recorded', ownerDecisionReferences: [] };
    },
  };
  function completeEvidence(
    overrides: Partial<EvidenceAssessmentRecord> = {},
  ): EvidenceAssessmentRecord {
    return assessmentRecord({
      verificationReceipts: [verificationReceipt({ procedureName: 'ci', result: 'pass' })],
      reviewReceipts: [reviewReceipt({ result: 'pass', findings: [] })],
      ...overrides,
    });
  }

  it('rejects an assessment that does not exist', async () => {
    const useCase = new AssessHeadAcceptanceUseCase({ repo: fakeRepository(), attemptOwnerDecisionPort: noOwnerDecisions });

    const result = await useCase.assessHeadAcceptance(assessRequest());

    expect(result).toEqual({ outcome: 'rejected', reason: 'Assessment not found' });
  });

  it('rejects an acceptance request without a policy revision', async () => {
    const repo = fakeRepository([completeEvidence()]);
    const useCase = new AssessHeadAcceptanceUseCase({ repo, attemptOwnerDecisionPort: noOwnerDecisions });

    const result = await useCase.assessHeadAcceptance(assessRequest({ policyRevision: '' }));

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'Acceptance requires an assessmentId, a candidateHeadSha, and a policyRevision',
    });
    expect(repo.records.get('ea-1')?.state).toBe('pending');
  });

  it('marks the assessment stale when the candidate head moved', async () => {
    const repo = fakeRepository([completeEvidence()]);
    const useCase = new AssessHeadAcceptanceUseCase({ repo, attemptOwnerDecisionPort: noOwnerDecisions });

    const result: AssessHeadAcceptanceResult = await useCase.assessHeadAcceptance(
      assessRequest({ candidateHeadSha: OTHER_HEAD }),
    );

    expect(result).toEqual({
      outcome: 'stale',
      reason: 'Candidate head or policy revision changed',
    });
    expect(repo.records.get('ea-1')?.state).toBe('stale');
    expect(repo.records.get('ea-1')?.acceptanceReceiptId).toBeNull();
  });

  it('marks the assessment stale when the acceptance policy revision changed', async () => {
    const repo = fakeRepository([completeEvidence()]);
    const useCase = new AssessHeadAcceptanceUseCase({ repo, attemptOwnerDecisionPort: noOwnerDecisions });

    const result = await useCase.assessHeadAcceptance(assessRequest({ policyRevision: 'policy-8' }));

    expect(result.outcome).toBe('stale');
    expect(repo.records.get('ea-1')?.state).toBe('stale');
  });

  it('blocks a required check that has no receipt, or has a non-passing one', async () => {
    for (const receipt of [null, verificationReceipt({ result: 'fail' }), verificationReceipt({ result: 'pending' }), verificationReceipt({ result: 'unknown' })]) {
      const repo = fakeRepository([
        completeEvidence({ verificationReceipts: receipt === null ? [] : [receipt] }),
      ]);
      const useCase = new AssessHeadAcceptanceUseCase({ repo, attemptOwnerDecisionPort: noOwnerDecisions });

      const result = await useCase.assessHeadAcceptance(assessRequest());

      expect(result.outcome).toBe('blocked');
      if (result.outcome !== 'blocked') {
        throw new Error('expected a blocked assessment');
      }
      expect(result.blockers[0]).toContain("required check 'ci'");
      expect(result.assessment?.state).toBe('blocked');
      expect(result.assessment?.acceptanceReceiptId).toBeNull();
    }
  });

  it('blocks when an independent read-only review failed for the head', async () => {
    const repo = fakeRepository([
      completeEvidence({
        reviewReceipts: [reviewReceipt({ result: 'fail' })],
      }),
    ]);
    const useCase = new AssessHeadAcceptanceUseCase({ repo, attemptOwnerDecisionPort: noOwnerDecisions });

    const result = await useCase.assessHeadAcceptance(assessRequest());

    expect(result.outcome).toBe('blocked');
    if (result.outcome !== 'blocked') {
      throw new Error('expected a blocked assessment');
    }
    expect(result.blockers).toEqual([
      "review by 'openrouter/poolside/laguna-s-2.1' failed for this head (receipt 'rr-1')",
    ]);
  });

  it('blocks an unresolved finding and accepts once it is resolved with evidence', async () => {
    const repo = fakeRepository([
      completeEvidence({
        reviewReceipts: [reviewReceipt({ result: 'pass', findings: [finding('f-1')] })],
      }),
    ]);
    const useCase = new AssessHeadAcceptanceUseCase({ repo, attemptOwnerDecisionPort: noOwnerDecisions });

    const blocked = await useCase.assessHeadAcceptance(assessRequest());

    expect(blocked.outcome).toBe('blocked');
    if (blocked.outcome !== 'blocked') {
      throw new Error('expected a blocked assessment');
    }
    expect(blocked.blockers).toEqual(["finding 'f-1' is unresolved"]);

    const dispositionUseCase = new RecordFindingDispositionUseCase({ repo });
    await dispositionUseCase.recordFindingDisposition({
      assessmentId: 'ea-1',
      disposition: disposition(),
      nowIso: NOW,
    });

    const accepted = await useCase.assessHeadAcceptance(assessRequest());

    expect(accepted.outcome).toBe('accepted');
    if (accepted.outcome !== 'accepted') {
      throw new Error('expected an accepted assessment');
    }
    expect(accepted.receiptId).toBe(`acc-ea-1-${HEAD.slice(0, 8)}`);
    expect(accepted.candidateHeadSha).toBe(HEAD);
    expect(accepted.assessment.state).toBe('accepted');
    expect(accepted.assessment.acceptanceReceiptId).toBe(accepted.receiptId);
    expect(accepted.assessment.blockers).toEqual([]);
  });

  it('blocks on an unresolved finding that a disposition for another finding leaves open', async () => {
    const repo = fakeRepository([
      completeEvidence({
        reviewReceipts: [
          reviewReceipt({ result: 'pass', findings: [finding('f-1'), finding('f-2')] }),
        ],
      }),
    ]);
    const useCase = new AssessHeadAcceptanceUseCase({ repo, attemptOwnerDecisionPort: noOwnerDecisions });

    await new RecordFindingDispositionUseCase({ repo }).recordFindingDisposition({
      assessmentId: 'ea-1',
      disposition: disposition(),
    });
    const result = await useCase.assessHeadAcceptance(assessRequest());

    expect(result.outcome).toBe('blocked');
    if (result.outcome !== 'blocked') {
      throw new Error('expected a blocked assessment');
    }
    expect(result.blockers).toEqual(["finding 'f-2' is unresolved"]);
  });

  it('blocks while forge CI has not passed', async () => {
    const useCase = new AssessHeadAcceptanceUseCase({
      repo: fakeRepository([completeEvidence()]),
      attemptOwnerDecisionPort: noOwnerDecisions,
      forgeEvidence: stubForge({
        candidateHeadSha: HEAD,
        ciState: 'pending',
        unresolvedThreadCount: 0,
        observedHeadSha: HEAD,
      }),
    });

    const result = await useCase.assessHeadAcceptance(assessRequest());

    expect(result.outcome).toBe('blocked');
    if (result.outcome !== 'blocked') {
      throw new Error('expected a blocked assessment');
    }
    expect(result.blockers).toEqual(["forge reports CI state 'pending' for this candidate head"]);
  });

  it('blocks while the forge still carries unresolved review threads', async () => {
    const useCase = new AssessHeadAcceptanceUseCase({
      repo: fakeRepository([completeEvidence()]),
      attemptOwnerDecisionPort: noOwnerDecisions,
      forgeEvidence: stubForge({
        candidateHeadSha: HEAD,
        ciState: 'pass',
        unresolvedThreadCount: 2,
        observedHeadSha: HEAD,
      }),
    });

    const result = await useCase.assessHeadAcceptance(assessRequest());

    expect(result.outcome).toBe('blocked');
    if (result.outcome !== 'blocked') {
      throw new Error('expected a blocked assessment');
    }
    expect(result.blockers).toEqual([
      'forge reports 2 unresolved review thread(s) for this candidate head',
    ]);
  });

  it('blocks acceptance when the forge could not read review threads', async () => {
    const useCase = new AssessHeadAcceptanceUseCase({
      repo: fakeRepository([completeEvidence()]),
      attemptOwnerDecisionPort: noOwnerDecisions,
      forgeEvidence: stubForge({
        candidateHeadSha: HEAD,
        ciState: 'pass',
        unresolvedThreadCount: null,
        observedHeadSha: HEAD,
      }),
    });

    const result = await useCase.assessHeadAcceptance(assessRequest());

    expect(result.outcome).toBe('blocked');
    if (result.outcome !== 'blocked') {
      throw new Error('expected a blocked assessment');
    }
    expect(result.blockers).toEqual([
      'forge could not read review threads for this candidate head',
    ]);
  });

  it('accepts a head with passing checks, a passing independent review and a clean forge', async () => {
    const repo = fakeRepository([completeEvidence()]);
    const useCase = new AssessHeadAcceptanceUseCase({
      repo,
      attemptOwnerDecisionPort: noOwnerDecisions,
      forgeEvidence: stubForge({
        candidateHeadSha: HEAD,
        ciState: 'pass',
        unresolvedThreadCount: 0,
        observedHeadSha: HEAD,
      }),
    });

    const result = await useCase.assessHeadAcceptance(assessRequest());

    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') {
      throw new Error('expected an accepted assessment');
    }
    expect(result.assessment.blockers).toEqual([]);
    expect(result.assessment.state).toBe('accepted');
  });
});

describe('InspectAcceptanceEvidenceUseCase', () => {
  const repo = fakeRepository([
    assessmentRecord({
      verificationReceipts: [verificationReceipt()],
      reviewReceipts: [reviewReceipt()],
      revision: 4,
    }),
  ]);
  const useCase = new InspectAcceptanceEvidenceUseCase({ repo });

  it('finds the assessment and its provenance by identity', async () => {
    const result: InspectAcceptanceEvidenceResult = await useCase.inspectAcceptanceEvidence({
      assessmentId: 'ea-1',
    });

    expect(result.outcome).toBe('found');
    if (result.outcome !== 'found') {
      throw new Error('expected a found assessment');
    }
    expect(result.assessment.revision).toBe(4);
    expect(result.assessment.verificationReceipts).toHaveLength(1);
    expect(result.assessment.reviewReceipts).toHaveLength(1);
  });

  it('finds the assessment by exact head', async () => {
    const result = await useCase.inspectAcceptanceEvidence({ candidateHeadSha: HEAD });

    expect(result.outcome).toBe('found');
  });

  it('reports unknown identities and heads as not found', async () => {
    const byId = await useCase.inspectAcceptanceEvidence({ assessmentId: 'ea-404' });
    const byHead = await useCase.inspectAcceptanceEvidence({ candidateHeadSha: OTHER_HEAD });
    const empty = await useCase.inspectAcceptanceEvidence({});

    expect(byId).toEqual({ outcome: 'not-found', query: 'ea-404' });
    expect(byHead).toEqual({ outcome: 'not-found', query: OTHER_HEAD });
    expect(empty).toEqual({ outcome: 'not-found', query: '' });
  });
});

describe('EvidenceAssessmentRepositoryAdapter', () => {
  it('saves and finds an assessment by identity and by exact head', async () => {
    const adapter = new EvidenceAssessmentRepositoryAdapter();

    await adapter.saveAssessment(assessmentRecord({ revision: 1 }));

    expect((await adapter.findAssessmentById('ea-1'))?.revision).toBe(1);
    expect((await adapter.findAssessmentByHead(HEAD))?.id).toBe('ea-1');
    expect(await adapter.findAssessmentById('ea-404')).toBeNull();
    expect(await adapter.findAssessmentByHead(OTHER_HEAD)).toBeNull();
  });

  it('refuses a write that does not advance the stored revision', async () => {
    const adapter = new EvidenceAssessmentRepositoryAdapter();
    await adapter.saveAssessment(assessmentRecord({ revision: 2 }));

    await expect(adapter.saveAssessment(assessmentRecord({ revision: 2 }))).rejects.toThrow(
      'Optimistic concurrency conflict for assessment ea-1',
    );
    await expect(adapter.saveAssessment(assessmentRecord({ revision: 1 }))).rejects.toThrow(
      'Optimistic concurrency conflict',
    );
    await expect(adapter.saveAssessment(assessmentRecord({ revision: 3 }))).resolves.toBeUndefined();
    expect((await adapter.findAssessmentById('ea-1'))?.revision).toBe(3);
  });

  it('returns stored records as copies so callers cannot mutate the store', async () => {
    const adapter = new EvidenceAssessmentRepositoryAdapter();
    await adapter.saveAssessment(assessmentRecord({ revision: 1 }));

    const found = await adapter.findAssessmentById('ea-1');
    if (found === null) {
      throw new Error('expected a stored assessment');
    }
    (found.blockers as string[]).push('injected blocker');

    expect((await adapter.findAssessmentById('ea-1'))?.blockers).toEqual([]);
  });

  it('persists and restores assessments from the configured state directory', async () => {
    const stateDir = temporaryDirectory();
    const writer = new EvidenceAssessmentRepositoryAdapter({ stateDir });
    await writer.saveAssessment(assessmentRecord({ revision: 2 }));

    const reader = new EvidenceAssessmentRepositoryAdapter({ stateDir });

    expect((await reader.findAssessmentById('ea-1'))?.revision).toBe(2);
    await expect(reader.saveAssessment(assessmentRecord({ revision: 2 }))).rejects.toThrow(
      'Optimistic concurrency conflict',
    );
  });
});

describe('EvidenceArchiveAdapter', () => {
  it('addresses content by its sha-256 digest and reads it back', async () => {
    const adapter = new EvidenceArchiveAdapter();

    const result = await adapter.archiveEvidence({
      artifactId: 'verification-ea-1-ci',
      candidateHeadSha: HEAD,
      content: 'ci: pass',
    });

    expect(result.digest).toBe(sha256Hex('ci: pass'));
    expect(result.evidenceRef).toBe(`evidence://verification-ea-1-ci@${sha256Hex('ci: pass')}`);
    expect(await adapter.readArchivedEvidence(result.evidenceRef)).toBe('ci: pass');
  });

  it('stores identical content once under one digest', async () => {
    const adapter = new EvidenceArchiveAdapter();
    const first = await adapter.archiveEvidence({
      artifactId: 'a',
      candidateHeadSha: HEAD,
      content: 'same',
    });
    const second = await adapter.archiveEvidence({
      artifactId: 'b',
      candidateHeadSha: HEAD,
      content: 'same',
    });

    expect(second.digest).toBe(first.digest);
  });

  it('restores archived content from the configured archive directory', async () => {
    const archiveDir = temporaryDirectory();
    const writer = new EvidenceArchiveAdapter({ archiveDir });
    const written = await writer.archiveEvidence({
      artifactId: 'verification-ea-1-ci',
      candidateHeadSha: HEAD,
      content: 'ci: pass',
    });

    const reader = new EvidenceArchiveAdapter({ archiveDir });

    expect(await reader.readArchivedEvidence(written.evidenceRef)).toBe('ci: pass');
  });

  it('returns null for an unparseable reference', async () => {
    const adapter = new EvidenceArchiveAdapter();

    expect(await adapter.readArchivedEvidence('evidence://no-digest')).toBeNull();
    expect(await adapter.readArchivedEvidence(`evidence://x@${'0'.repeat(64)}`)).toBeNull();
  });
});

describe('VerificationExecutorAdapter', () => {
  it('delegates to the configured check transport', async () => {
    const adapter = new VerificationExecutorAdapter({
      runCheck: async (request) => ({
        result: 'pass',
        exitCode: 0,
        outputSummary: `${request.procedureName} passed on ${request.candidateHeadSha}`,
        completedAtIso: NOW,
      }),
    });

    const result = await adapter.executeVerificationCheck({
      hostId: 'host-1',
      candidateHeadSha: HEAD,
      procedureName: 'ci',
    });

    expect(result).toEqual({
      result: 'pass',
      exitCode: 0,
      outputSummary: `ci passed on ${HEAD}`,
      completedAtIso: NOW,
    });
  });

  it('never runs a procedure that is not allow-listed and reports it as unknown', async () => {
    const adapter = new VerificationExecutorAdapter({
      allowListedCommands: { ci: '/nonexistent/verify-run.sh' },
    });

    const result = await adapter.executeVerificationCheck({
      hostId: 'host-1',
      candidateHeadSha: HEAD,
      procedureName: 'unit-tests',
    });

    expect(result.result).toBe('unknown');
    expect(result.exitCode).toBeNull();
    expect(result.outputSummary).toContain('no allow-listed verification command');
  });

  it('runs an allow-listed command and records its exit result', async () => {
    const directory = temporaryDirectory();
    const passing = join(directory, 'pass.sh');
    const failing = join(directory, 'fail.sh');
    writeFileSync(passing, '#!/bin/sh\necho "all good"\nexit 0\n', { mode: 0o755 });
    writeFileSync(failing, '#!/bin/sh\necho "boom"\nexit 2\n', { mode: 0o755 });
    const adapter = new VerificationExecutorAdapter({
      allowListedCommands: { ci: passing, 'unit-tests': failing },
    });

    const passed = await adapter.executeVerificationCheck({
      hostId: 'host-1',
      candidateHeadSha: HEAD,
      procedureName: 'ci',
    });
    const failed = await adapter.executeVerificationCheck({
      hostId: 'host-1',
      candidateHeadSha: HEAD,
      procedureName: 'unit-tests',
    });

    expect(passed.result).toBe('pass');
    expect(passed.exitCode).toBe(0);
    expect(passed.outputSummary).toContain('all good');
    expect(failed.result).toBe('fail');
    expect(failed.exitCode).toBe(2);
    expect(failed.outputSummary).toContain('boom');
  });
});

describe('ForgeEvidenceAdapter', () => {
  it('returns the configured static status for a head', async () => {
    const adapter = new ForgeEvidenceAdapter({
      statuses: {
        [HEAD]: {
          candidateHeadSha: HEAD,
          ciState: 'pass',
          unresolvedThreadCount: 0,
          observedHeadSha: HEAD,
        },
      },
    });

    expect(await adapter.readForgeCheckStatus({ candidateHeadSha: HEAD })).toEqual({
      candidateHeadSha: HEAD,
      ciState: 'pass',
      unresolvedThreadCount: 0,
      observedHeadSha: HEAD,
    });
  });

  it('reports unknown rather than passing when no forge transport is configured', async () => {
    const adapter = new ForgeEvidenceAdapter();

    expect(await adapter.readForgeCheckStatus({ candidateHeadSha: HEAD })).toEqual({
      candidateHeadSha: HEAD,
      ciState: 'unknown',
      unresolvedThreadCount: null,
      observedHeadSha: null,
    });
  });

  it('maps gh pr checks buckets and counts unresolved review threads', async () => {
    const adapter = new ForgeEvidenceAdapter({
      owner: 'acme',
      repo: 'widgets',
      runGh: async (args) => {
        if (args[0] === 'pr') {
          return {
            exitCode: 0,
            stdout: JSON.stringify([{ bucket: 'pass' }, { bucket: 'skipping' }]),
          };
        }
        if (args[1] === 'graphql') {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      totalCount: 2,
                      nodes: [{ isResolved: true }, { isResolved: false }],
                    },
                  },
                },
              },
            }),
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify([{ number: 7, state: 'open', head: { sha: HEAD } }]),
        };
      },
    });

    expect(await adapter.readForgeCheckStatus({ candidateHeadSha: HEAD })).toEqual({
      candidateHeadSha: HEAD,
      ciState: 'pass',
      unresolvedThreadCount: 1,
      observedHeadSha: HEAD,
    });
  });

  it('never reports a failing or unreadable forge state as a pass', async () => {
    const failing = new ForgeEvidenceAdapter({
      owner: 'acme',
      repo: 'widgets',
      runGh: async (args) => {
        if (args[0] === 'pr') {
          return { exitCode: 0, stdout: JSON.stringify([{ bucket: 'fail' }]) };
        }
        if (args[1] === 'graphql') {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: { reviewThreads: { totalCount: 0, nodes: [] } },
                },
              },
            }),
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify([{ number: 7, state: 'open', head: { sha: HEAD } }]),
        };
      },
    });
    const unreadable = new ForgeEvidenceAdapter({
      owner: 'acme',
      repo: 'widgets',
      runGh: async () => ({ exitCode: 1, stdout: 'gh: not authenticated' }),
    });

    expect((await failing.readForgeCheckStatus({ candidateHeadSha: HEAD })).ciState).toBe('fail');
    expect((await unreadable.readForgeCheckStatus({ candidateHeadSha: HEAD })).ciState).toBe('unknown');
  });
});

describe('IndependentReviewAdapter', () => {
  const request = {
    attemptId: 'att-1',
    candidateHeadSha: HEAD,
    implementerModel: IMPLEMENTER_MODEL,
    reviewerModel: REVIEWER_MODEL,
  };

  it('is unavailable when the reviewer shares the implementer model through another provider', async () => {
    const adapter = new IndependentReviewAdapter({
      runReview: async () => ({
        rawOutput: '',
        readOnlyVerified: true,
        result: 'pass',
        findings: [],
      }),
    });

    const result = await adapter.runIndependentReview({
      ...request,
      implementerModel: 'nvidia/z-ai/glm-5.3',
      reviewerModel: 'openrouter/z-ai/glm-5.3',
    });

    expect(result.outcome).toBe('unavailable');
    if (result.outcome !== 'unavailable') {
      throw new Error('expected an unavailable review seat');
    }
    expect(result.reason).toContain('share the same underlying model');
  });

  it('is unavailable when no transport is configured or the transport fails', async () => {
    const unconfigured = await new IndependentReviewAdapter().runIndependentReview(request);
    const failing = await new IndependentReviewAdapter({
      runReview: async () => {
        throw new Error('reviewer seat timed out');
      },
    }).runIndependentReview(request);

    expect(unconfigured).toEqual({
      outcome: 'unavailable',
      reason: 'No independent review transport is configured',
      code: 'transport-missing',
    });
    expect(failing).toEqual({
      outcome: 'unavailable',
      reason: 'reviewer seat timed out',
      code: 'transport-failed',
    });
  });

  it('reports a completed review and preserves an unverified read-only claim', async () => {
    const adapter = new IndependentReviewAdapter({
      runReview: async () => ({
        rawOutput: 'reviewer output',
        readOnlyVerified: false,
        result: 'fail' as const,
        findings: [finding('f-1')],
        completedAtIso: NOW,
      }),
    });

    const result = await adapter.runIndependentReview(request);

    expect(result.outcome).toBe('completed');
    if (result.outcome !== 'completed') {
      throw new Error('expected a completed review');
    }
    expect(result.readOnlyVerified).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.completedAtIso).toBe(NOW);
  });

  it('drives the review use case end to end through the adapter', async () => {
    const repo = fakeRepository([assessmentRecord({ requiredChecks: [] })]);
    const archive = new EvidenceArchiveAdapter();
    const reviewer = new IndependentReviewAdapter({
      runReview: async () => ({
        rawOutput: 'looks good',
        readOnlyVerified: true,
        result: 'pass' as const,
        findings: [],
        completedAtIso: NOW,
      }),
    });
    const useCase = new RequestIndependentReviewUseCase({ repo, reviewer, archive });

    const result = await useCase.requestIndependentReview(requestReview() as never);

    expect(result.outcome).toBe('reviewed');
    if (result.outcome !== 'reviewed') {
      throw new Error('expected a recorded review');
    }
    expect(result.receipt.evidenceRef).toContain(sha256Hex('looks good'));
    expect(await archive.readArchivedEvidence(result.receipt.evidenceRef)).toBe('looks good');
  });
});