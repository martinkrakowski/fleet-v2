import { describe, expect, it } from 'vitest';

import type { EvidenceAssessmentRecord, ReviewReceiptRecord } from '../../../domain/evidence-records.js';
import { latestReceiptPerReviewer, tallyReviews } from '../../../domain/review-selection.js';
import { ReviewReceipt } from '../../../domain/entities/ReviewReceipt.js';
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
  CheckReviewerSeatRequest,
  EvidenceSeatPolicyPort,
  ReviewerSeatCheck,
} from '../../ports/out/EvidenceSeatPolicyPort.out-port.js';
import type {
  RequestIndependentReviewRequest,
  RequestIndependentReviewResult,
  ReviewRejection,
} from '../../ports/in/RequestIndependentReviewPort.in-port.js';
import { RequestIndependentReviewUseCase } from '../RequestIndependentReviewUseCase.use-case.js';

const HEAD = '1'.repeat(40);
const OTHER_HEAD = '2'.repeat(40);
const REQUEST_ID = 'review-01JB0000000000000000000001';
const IMPLEMENTER = 'example-provider/glm-5.3';
const REVIEWER = 'example-provider/grok-4.7';

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

interface StubOutcome {
  result?: 'pass' | 'fail' | 'unknown';
  readOnlyVerified?: boolean;
  unavailableReason?: string;
}

class StubReviewer implements IndependentReviewPort {
  calls: RunIndependentReviewRequest[] = [];

  constructor(private readonly outcome: StubOutcome = {}) {}

  async runIndependentReview(
    request: RunIndependentReviewRequest,
  ): Promise<RunIndependentReviewResult> {
    this.calls.push(request);
    if (this.outcome.unavailableReason !== undefined) {
      return { outcome: 'unavailable', reason: this.outcome.unavailableReason };
    }
    return {
      outcome: 'completed',
      readOnlyVerified: this.outcome.readOnlyVerified ?? true,
      result: this.outcome.result ?? 'pass',
      findings: [],
      rawOutput: 'clean review',
      completedAtIso: '2026-10-28T12:00:00.000Z',
    };
  }
}

class StubArchive implements EvidenceArchivePort {
  calls: ArchiveEvidenceRequest[] = [];

  async archiveEvidence(request: ArchiveEvidenceRequest): Promise<ArchiveEvidenceResult> {
    this.calls.push(request);
    return {
      evidenceRef: `ref-${request.artifactId}`,
      digest: 'digest-1',
    };
  }

  async readArchivedEvidence(_evidenceRef: string): Promise<string | null> {
    return 'content';
  }
}

class StubSeatPolicy implements EvidenceSeatPolicyPort {
  calls: string[] = [];

  constructor(private readonly result: ReviewerSeatCheck) {}

  async checkReviewerSeat(request: CheckReviewerSeatRequest): Promise<ReviewerSeatCheck> {
    this.calls.push(request.reviewerModel);
    return this.result;
  }
}

function sampleRecord(overrides: Partial<EvidenceAssessmentRecord> = {}): EvidenceAssessmentRecord {
  return {
    id: 'assessment-attempt-example-1',
    projectId: 'project-example-1',
    attemptId: 'attempt-example-1',
    candidateHeadSha: HEAD,
    policyRevision: 'policy-example-1',
    implementerModel: IMPLEMENTER,
    requiredChecks: [],
    state: 'pending',
    verificationReceipts: [],
    reviewReceipts: [],
    findingDispositions: [],
    acceptanceReceiptId: null,
    blockers: [],
    revision: 0,
    updatedAtIso: '2026-10-28T12:00:00.000Z',
    ...overrides,
  };
}

function baseRequest(overrides: Partial<RequestIndependentReviewRequest> = {}): RequestIndependentReviewRequest {
  return {
    assessmentId: 'assessment-attempt-example-1',
    projectId: 'project-example-1',
    attemptId: 'attempt-example-1',
    candidateHeadSha: HEAD,
    policyRevision: 'policy-example-1',
    implementerModel: IMPLEMENTER,
    reviewerModel: REVIEWER,
    ...overrides,
  };
}

function receiptOf(result: RequestIndependentReviewResult): ReviewReceiptRecord {
  if (result.outcome !== 'reviewed') {
    throw new Error('expected a reviewed result');
  }
  return result.receipt;
}

function rejectionOf(
  result: RequestIndependentReviewResult,
): Extract<RequestIndependentReviewResult, { outcome: 'rejected' }> {
  if (result.outcome !== 'rejected') {
    throw new Error('expected a rejected result');
  }
  return result;
}

describe('review kind and request id (PC-1)', () => {
  it('stores kind and requestId on a conductor receipt with the request id in the id', async () => {
    const reviewer = new StubReviewer();
    const archive = new StubArchive();
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const useCase = new RequestIndependentReviewUseCase({ repo, reviewer, archive });
    const result = await useCase.requestIndependentReview(
      baseRequest({ kind: 'brief-check', requestId: REQUEST_ID }),
    );
    expect(result.outcome).toBe('reviewed');
    const receipt = receiptOf(result);
    expect(receipt.kind).toBe('brief-check');
    expect(receipt.requestId).toBe(REQUEST_ID);
    expect(receipt.id.endsWith('-' + REQUEST_ID)).toBe(true);
    const stored = await repo.findAssessmentById('assessment-attempt-example-1');
    expect(stored?.reviewReceipts).toHaveLength(1);
    expect(stored?.reviewReceipts[0]?.requestId).toBe(REQUEST_ID);
  });

  it('keeps a manual receipt without kind or requestId and the old id shape', async () => {
    const reviewer = new StubReviewer();
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const useCase = new RequestIndependentReviewUseCase({ repo, reviewer, archive: new StubArchive() });
    const result = await useCase.requestIndependentReview(baseRequest());
    expect(result.outcome).toBe('reviewed');
    const receipt = receiptOf(result);
    expect('kind' in receipt).toBe(false);
    expect('requestId' in receipt).toBe(false);
    expect(receipt.id).toBe('rr-assessment-attempt-example-1-11111111');
  });

  it('replays a recorded request id without a second review', async () => {
    const reviewer = new StubReviewer();
    const archive = new StubArchive();
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const useCase = new RequestIndependentReviewUseCase({ repo, reviewer, archive });
    const first = await useCase.requestIndependentReview(
      baseRequest({ kind: 'brief-check', requestId: REQUEST_ID }),
    );
    const replay = await useCase.requestIndependentReview(
      baseRequest({ kind: 'brief-check', requestId: REQUEST_ID }),
    );
    expect(replay).toEqual(first);
    expect(reviewer.calls).toHaveLength(1);
    expect(archive.calls).toHaveLength(1);
  });

  it('refuses a reused request id with the typed code and never runs again', async () => {
    const reviewer = new StubReviewer();
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const useCase = new RequestIndependentReviewUseCase({ repo, reviewer, archive: new StubArchive() });
    await useCase.requestIndependentReview(baseRequest({ kind: 'brief-check', requestId: REQUEST_ID }));
    const replay = rejectionOf(
      await useCase.requestIndependentReview(baseRequest({ kind: 'code-review', requestId: REQUEST_ID })),
    );
    expect(replay.rejection).toBe('request-id-reused');
    expect(replay.reason).toBe(
      'Review request id ' + REQUEST_ID + ' was already used for another review',
    );
    expect(reviewer.calls).toHaveLength(1);
  });

  it('a reused request id naming a different head is request-id-reused, not assessment-mismatch', async () => {
    const reviewer = new StubReviewer();
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const useCase = new RequestIndependentReviewUseCase({ repo, reviewer, archive: new StubArchive() });
    await useCase.requestIndependentReview(baseRequest({ kind: 'brief-check', requestId: REQUEST_ID }));
    const replay = rejectionOf(
      await useCase.requestIndependentReview(
        baseRequest({ kind: 'brief-check', requestId: REQUEST_ID, candidateHeadSha: 'b'.repeat(40) }),
      ),
    );
    expect(replay.rejection).toBe('request-id-reused');
    expect(reviewer.calls).toHaveLength(1);
  });

  it('refuses malformed conductor fields without calling anything', async () => {
    const reviewer = new StubReviewer();
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const useCase = new RequestIndependentReviewUseCase({ repo, reviewer, archive: new StubArchive() });
    const bad = [
      baseRequest({ requestId: REQUEST_ID }),
      baseRequest({ kind: 'security-scan' as 'brief-check', requestId: REQUEST_ID }),
      baseRequest({ kind: 'brief-check', requestId: 'has space' }),
    ];
    for (const request of bad) {
      const result = rejectionOf(await useCase.requestIndependentReview(request));
      expect(result.rejection).toBe('invalid-request');
      expect(result.reason).toBe(
        'Independent review requires a known kind and a well-formed requestId together',
      );
    }
    expect(reviewer.calls).toHaveLength(0);
  });

  it('carries each typed rejection code for conductor requests', async () => {
    const refusingSeat = new StubSeatPolicy({ outcome: 'refused', reason: 'seat is busy' });
    const cases: Array<{
      name: string;
      record: EvidenceAssessmentRecord;
      reviewer: StubReviewer;
      seatPolicy?: EvidenceSeatPolicyPort;
      request: RequestIndependentReviewRequest;
      expected: ReviewRejection;
    }> = [
      {
        name: 'not-independent',
        record: sampleRecord(),
        reviewer: new StubReviewer(),
        request: baseRequest({ kind: 'brief-check', requestId: REQUEST_ID, reviewerModel: IMPLEMENTER }),
        expected: 'not-independent',
      },
      {
        name: 'seat-refused',
        record: sampleRecord(),
        reviewer: new StubReviewer(),
        seatPolicy: refusingSeat,
        request: baseRequest({ kind: 'brief-check', requestId: REQUEST_ID }),
        expected: 'seat-refused',
      },
      {
        name: 'no-assessment',
        record: sampleRecord(),
        reviewer: new StubReviewer(),
        request: baseRequest({
          kind: 'brief-check',
          requestId: REQUEST_ID,
          assessmentId: 'assessment-attempt-example-2',
        }),
        expected: 'no-assessment',
      },
      {
        name: 'assessment-mismatch (head)',
        record: sampleRecord(),
        reviewer: new StubReviewer(),
        request: baseRequest({ kind: 'brief-check', requestId: REQUEST_ID, candidateHeadSha: OTHER_HEAD }),
        expected: 'assessment-mismatch',
      },
      {
        name: 'assessment-terminal',
        record: sampleRecord({ state: 'accepted' }),
        reviewer: new StubReviewer(),
        request: baseRequest({ kind: 'brief-check', requestId: REQUEST_ID }),
        expected: 'assessment-terminal',
      },
      {
        name: 'review-unavailable',
        record: sampleRecord(),
        reviewer: new StubReviewer({ unavailableReason: 'transport down' }),
        request: baseRequest({ kind: 'brief-check', requestId: REQUEST_ID }),
        expected: 'review-unavailable',
      },
      {
        name: 'not-read-only',
        record: sampleRecord(),
        reviewer: new StubReviewer({ readOnlyVerified: false }),
        request: baseRequest({ kind: 'brief-check', requestId: REQUEST_ID }),
        expected: 'not-read-only',
      },
    ];
    for (const testCase of cases) {
      const repo = new InMemoryAssessmentRepo([testCase.record]);
      const useCase = new RequestIndependentReviewUseCase({
        repo,
        reviewer: testCase.reviewer,
        archive: new StubArchive(),
        seatPolicy: testCase.seatPolicy,
      });
      const result = rejectionOf(await useCase.requestIndependentReview(testCase.request));
      expect(result.rejection).toBe(testCase.expected);
    }
  });

  it('keeps the exact manual rejection shape without a requestId', async () => {
    const reviewer = new StubReviewer({ unavailableReason: 'transport down' });
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const useCase = new RequestIndependentReviewUseCase({ repo, reviewer, archive: new StubArchive() });
    const result = await useCase.requestIndependentReview(baseRequest());
    expect(result).toEqual({ outcome: 'rejected', reason: 'transport down' });
  });

  it('selects the latest receipt per reviewer and kind (R1, §3.4)', () => {
    const failBrief: ReviewReceiptRecord = {
      id: 'rr-a-1',
      assessmentId: 'assessment-attempt-example-1',
      projectId: 'project-example-1',
      attemptId: 'attempt-example-1',
      candidateHeadSha: HEAD,
      reviewerModel: REVIEWER,
      implementerModel: IMPLEMENTER,
      readOnlyVerified: true,
      result: 'fail',
      findings: [],
      evidenceRef: 'ref-1',
      policyRevision: 'policy-example-1',
      completedAtIso: '2026-10-28T12:00:00.000Z',
      kind: 'brief-check',
    };
    const passCode: ReviewReceiptRecord = { ...failBrief, id: 'rr-a-2', result: 'pass', kind: 'code-review' };
    const both = latestReceiptPerReviewer([failBrief, passCode]);
    expect(both).toHaveLength(2);
    expect(tallyReviews(both).disagreement).toBe(true);

    const failNoKind: ReviewReceiptRecord = { ...failBrief, kind: undefined };
    const codePass: ReviewReceiptRecord = { ...failBrief, id: 'rr-a-3', result: 'pass', kind: 'code-review' };
    expect(latestReceiptPerReviewer([failNoKind, codePass])).toEqual([codePass]);
  });

  it('validates kind and requestId on ReviewReceipt.create', () => {
    const base = {
      id: 'rr-a-1',
      assessmentId: 'assessment-attempt-example-1',
      projectId: 'project-example-1',
      attemptId: 'attempt-example-1',
      candidateHeadSha: HEAD,
      reviewerModel: REVIEWER,
      implementerModel: IMPLEMENTER,
      readOnlyVerified: true,
      result: 'pass' as const,
      findings: [],
      evidenceRef: 'ref-1',
      policyRevision: 'policy-example-1',
      completedAtIso: '2026-10-28T12:00:00.000Z',
    };
    expect(
      ReviewReceipt.create({ ...base, kind: 'security-scan' as 'brief-check' }).success,
    ).toBe(false);
    expect(ReviewReceipt.create({ ...base, kind: 'brief-check', requestId: 'has space' }).success).toBe(
      false,
    );
    expect(ReviewReceipt.create({ ...base, requestId: REQUEST_ID }).success).toBe(false);
  });
});
