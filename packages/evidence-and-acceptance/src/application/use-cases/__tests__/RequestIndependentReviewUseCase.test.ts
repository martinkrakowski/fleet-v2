import { describe, expect, it } from 'vitest';

import type { EvidenceAssessmentRecord } from '../../../domain/evidence-records.js';
import type {
  ArchiveEvidenceRequest,
  ArchiveEvidenceResult,
  EvidenceArchivePort,
} from '../../ports/out/EvidenceArchivePort.out-port.js';
import {
  EvidenceAssessmentRevisionConflictError,
  type EvidenceAssessmentRepositoryPort,
} from '../../ports/out/EvidenceAssessmentRepositoryPort.out-port.js';
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
import type { RequestIndependentReviewRequest } from '../../ports/in/RequestIndependentReviewPort.in-port.js';
import { ReviewReceipt } from '../../../domain/entities/ReviewReceipt.js';
import { isValidChainName } from '../../../domain/evidence-records.js';
import { RequestIndependentReviewUseCase } from '../RequestIndependentReviewUseCase.use-case.js';

const HEAD1 = '1111111111111111111111111111111111111111';
const HEAD2 = '2222222222222222222222222222222222222222';

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

/** A repository whose save is refused as a lost race (stale revision). */
class RevisionConflictOnSaveRepo extends InMemoryAssessmentRepo {
  async saveAssessment(record: EvidenceAssessmentRecord): Promise<void> {
    throw new EvidenceAssessmentRevisionConflictError(
      record.id,
      record.revision,
      'store revision moved under the writer',
    );
  }
}

class StubReviewer implements IndependentReviewPort {
  calls: RunIndependentReviewRequest[] = [];

  async runIndependentReview(
    request: RunIndependentReviewRequest,
  ): Promise<RunIndependentReviewResult> {
    this.calls.push(request);
    return {
      outcome: 'completed',
      readOnlyVerified: true,
      result: 'pass',
      findings: [],
      rawOutput: 'clean review',
      completedAtIso: '2026-10-15T12:00:00.000Z',
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
    id: 'asm-1',
    projectId: 'proj-1',
    attemptId: 'att-1',
    candidateHeadSha: HEAD1,
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

describe('RequestIndependentReviewUseCase assessment presence (M13)', () => {
  it('returns rejected when no assessment exists for the assessmentId', async () => {
    const repo = new InMemoryAssessmentRepo([]);
    const reviewer = new StubReviewer();
    const archive = new StubArchive();
    const useCase = new RequestIndependentReviewUseCase({ repo, reviewer, archive });

    const result = await useCase.requestIndependentReview({
      assessmentId: 'asm-nonexistent',
      projectId: 'proj-1',
      attemptId: 'att-1',
      candidateHeadSha: HEAD1,
      policyRevision: 'pol-1',
      implementerModel: 'anthropic/claude-3-5-sonnet',
      reviewerModel: 'openai/gpt-4o',
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain('No assessment exists');
    }
    // Must not call reviewer or archive when assessment is absent
    expect(reviewer.calls).toHaveLength(0);
    expect(archive.calls).toHaveLength(0);
  });

  it('returns rejected when existing assessment has a different candidate head sha', async () => {
    const existing = sampleRecord({ candidateHeadSha: HEAD1 });
    const repo = new InMemoryAssessmentRepo([existing]);
    const reviewer = new StubReviewer();
    const archive = new StubArchive();
    const useCase = new RequestIndependentReviewUseCase({ repo, reviewer, archive });

    const result = await useCase.requestIndependentReview({
      assessmentId: 'asm-1',
      projectId: 'proj-1',
      attemptId: 'att-1',
      candidateHeadSha: HEAD2, // mismatched head!
      policyRevision: 'pol-1',
      implementerModel: 'anthropic/claude-3-5-sonnet',
      reviewerModel: 'openai/gpt-4o',
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain('candidate head');
    }
    expect(reviewer.calls).toHaveLength(0);
  });

  it('records review receipt and updates assessment when assessment exists for the head', async () => {
    const existing = sampleRecord({ candidateHeadSha: HEAD1 });
    const repo = new InMemoryAssessmentRepo([existing]);
    const reviewer = new StubReviewer();
    const archive = new StubArchive();
    const useCase = new RequestIndependentReviewUseCase({ repo, reviewer, archive });

    const result = await useCase.requestIndependentReview({
      assessmentId: 'asm-1',
      projectId: 'proj-1',
      attemptId: 'att-1',
      candidateHeadSha: HEAD1,
      policyRevision: 'pol-1',
      implementerModel: 'anthropic/claude-3-5-sonnet',
      reviewerModel: 'openai/gpt-4o',
    });

    expect(result.outcome).toBe('reviewed');
    if (result.outcome === 'reviewed') {
      expect(result.receipt.result).toBe('pass');
      expect(result.receipt.candidateHeadSha).toBe(HEAD1);
    }

    const stored = await repo.findAssessmentById('asm-1');
    expect(stored?.reviewReceipts).toHaveLength(1);
    expect(stored?.reviewReceipts[0].reviewerModel).toBe('openai/gpt-4o');
  });

  it('suffixes a second requestId-less receipt id with the receipt count on the same head (KF-33b2)', async () => {
    const existing = sampleRecord({ candidateHeadSha: HEAD1 });
    const repo = new InMemoryAssessmentRepo([existing]);
    const useCase = new RequestIndependentReviewUseCase({ repo, reviewer: new StubReviewer(), archive: new StubArchive() });

    const first = await useCase.requestIndependentReview({
      assessmentId: 'asm-1',
      projectId: 'proj-1',
      attemptId: 'att-1',
      candidateHeadSha: HEAD1,
      policyRevision: 'pol-1',
      implementerModel: 'anthropic/claude-3-5-sonnet',
      reviewerModel: 'openai/gpt-4o',
    });
    expect(first.outcome).toBe('reviewed');
    if (first.outcome === 'reviewed') {
      expect(first.receipt.id).toBe('rr-asm-1-11111111');
    }

    const second = await useCase.requestIndependentReview({
      assessmentId: 'asm-1',
      projectId: 'proj-1',
      attemptId: 'att-1',
      candidateHeadSha: HEAD1,
      policyRevision: 'pol-1',
      implementerModel: 'anthropic/claude-3-5-sonnet',
      reviewerModel: 'openai/gpt-4o',
    });
    expect(second.outcome).toBe('reviewed');
    if (second.outcome === 'reviewed') {
      expect(second.receipt.id).toBe('rr-asm-1-11111111-1');
    }
    const stored = await repo.findAssessmentById('asm-1');
    expect(stored?.reviewReceipts.map((receipt) => receipt.id)).toEqual(['rr-asm-1-11111111', 'rr-asm-1-11111111-1']);
  });

  it('stores reviewer-reported finding states as unresolved with no disposition', async () => {
    const existing = sampleRecord({ candidateHeadSha: HEAD1 });
    const repo = new InMemoryAssessmentRepo([existing]);
    class FixedFindingReviewer extends StubReviewer {
      override async runIndependentReview(
        request: RunIndependentReviewRequest,
      ): Promise<RunIndependentReviewResult> {
        const base = await super.runIndependentReview(request);
        return {
          ...base,
          findings: [
            {
              findingId: 'f-1',
              severity: 'major',
              summary: 'claimed fixed by the reviewer',
              filePath: null,
              line: null,
              state: 'fixed',
              dispositionReason: 'reviewer says so',
              dispositionEvidenceRef: 'nowhere',
            },
          ],
        } as RunIndependentReviewResult;
      }
    }
    const useCase = new RequestIndependentReviewUseCase({
      repo,
      reviewer: new FixedFindingReviewer(),
      archive: new StubArchive(),
    });

    const result = await useCase.requestIndependentReview({
      assessmentId: 'asm-1',
      projectId: 'proj-1',
      attemptId: 'att-1',
      candidateHeadSha: HEAD1,
      policyRevision: 'pol-1',
      implementerModel: 'anthropic/claude-3-5-sonnet',
      reviewerModel: 'openai/gpt-4o',
    });

    expect(result.outcome).toBe('reviewed');
    const stored = await repo.findAssessmentById('asm-1');
    expect(stored?.reviewReceipts[0].findings).toEqual([
      expect.objectContaining({
        findingId: 'rr-asm-1-11111111:f-1',
        state: 'unresolved',
        dispositionReason: null,
        dispositionEvidenceRef: null,
      }),
    ]);
  });
});

describe('free-seat policy and requested reviewer (FS3b)', () => {
  it('refuses with the seat policy reason and never calls reviewer or archive', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const reviewer = new StubReviewer();
    const archive = new StubArchive();
    const seatPolicy = new StubSeatPolicy({
      outcome: 'refused',
      reason: 'reviewer model is free',
    });
    const useCase = new RequestIndependentReviewUseCase({ repo, reviewer, archive, seatPolicy });

    const result = await useCase.requestIndependentReview({
      assessmentId: 'asm-1',
      projectId: 'proj-1',
      attemptId: 'att-1',
      candidateHeadSha: HEAD1,
      policyRevision: 'pol-1',
      implementerModel: 'anthropic/claude-3-5-sonnet',
      reviewerModel: 'openai/gpt-4o',
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toBe('reviewer model is free');
    }
    expect(reviewer.calls).toHaveLength(0);
    expect(archive.calls).toHaveLength(0);
    const stored = await repo.findAssessmentById('asm-1');
    expect(stored?.requestedReviewerModel).toBeUndefined();
  });

  it('records the requested reviewer when the seat policy allows it', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const reviewer = new StubReviewer();
    const archive = new StubArchive();
    const seatPolicy = new StubSeatPolicy({ outcome: 'allowed' });
    const useCase = new RequestIndependentReviewUseCase({ repo, reviewer, archive, seatPolicy });

    const result = await useCase.requestIndependentReview({
      assessmentId: 'asm-1',
      projectId: 'proj-1',
      attemptId: 'att-1',
      candidateHeadSha: HEAD1,
      policyRevision: 'pol-1',
      implementerModel: 'anthropic/claude-3-5-sonnet',
      reviewerModel: 'openai/gpt-4o',
    });

    expect(result.outcome).toBe('reviewed');
    expect(seatPolicy.calls).toEqual(['openai/gpt-4o']);
    const stored = await repo.findAssessmentById('asm-1');
    expect(stored?.requestedReviewerModel).toBe('openai/gpt-4o');
  });

  it('binds the requested reviewer when the reviewer is unavailable', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const reviewer = new StubReviewer();
    reviewer.runIndependentReview = async () => ({
      outcome: 'unavailable',
      reason: 'seat is busy',
      code: 'transport-failed',
    });
    const archive = new StubArchive();
    const useCase = new RequestIndependentReviewUseCase({ repo, reviewer, archive });

    const result = await useCase.requestIndependentReview({
      assessmentId: 'asm-1',
      projectId: 'proj-1',
      attemptId: 'att-1',
      candidateHeadSha: HEAD1,
      policyRevision: 'pol-1',
      implementerModel: 'anthropic/claude-3-5-sonnet',
      reviewerModel: 'openai/gpt-4o',
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toBe('seat is busy');
    }
    const stored = await repo.findAssessmentById('asm-1');
    expect(stored?.requestedReviewerModel).toBe('openai/gpt-4o');
    expect(stored?.revision).toBe(1);
  });

  it('stores the requested reviewer trimmed when the request carries whitespace', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const reviewer = new StubReviewer();
    const archive = new StubArchive();
    const useCase = new RequestIndependentReviewUseCase({ repo, reviewer, archive });

    const result = await useCase.requestIndependentReview({
      assessmentId: 'asm-1',
      projectId: 'proj-1',
      attemptId: 'att-1',
      candidateHeadSha: HEAD1,
      policyRevision: 'pol-1',
      implementerModel: 'anthropic/claude-3-5-sonnet',
      reviewerModel: ' openai/gpt-4o ',
    });

    expect(result.outcome).toBe('reviewed');
    const stored = await repo.findAssessmentById('asm-1');
    expect(stored?.requestedReviewerModel).toBe('openai/gpt-4o');
  });

  it('returns the rejection, not a throw, when the unavailable-path save hits a revision conflict', async () => {
    const repo = new RevisionConflictOnSaveRepo([sampleRecord()]);
    const reviewer = new StubReviewer();
    reviewer.runIndependentReview = async () => ({
      outcome: 'unavailable',
      reason: 'seat is busy',
      code: 'transport-failed',
    });
    const archive = new StubArchive();
    const useCase = new RequestIndependentReviewUseCase({ repo, reviewer, archive });

    const result = await useCase.requestIndependentReview({
      assessmentId: 'asm-1',
      projectId: 'proj-1',
      attemptId: 'att-1',
      candidateHeadSha: HEAD1,
      policyRevision: 'pol-1',
      implementerModel: 'anthropic/claude-3-5-sonnet',
      reviewerModel: 'openai/gpt-4o',
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toBe('seat is busy');
    }
  });
});

describe('brief-check requires the brief text (SEC-4)', () => {
  const REQUEST_ID = 'review-01JB0000000000000000000001';

  function requestFor(
    kind: 'brief-check' | 'code-review',
    briefText?: string,
  ): RequestIndependentReviewRequest {
    return {
      assessmentId: 'asm-1',
      projectId: 'proj-1',
      attemptId: 'att-1',
      candidateHeadSha: HEAD1,
      policyRevision: 'pol-1',
      implementerModel: 'anthropic/claude-3-5-sonnet',
      reviewerModel: 'openai/gpt-4o',
      kind,
      ...(briefText !== undefined ? { briefText } : {}),
    };
  }

  it('refuses a brief-check without the brief text as invalid-request before any transport call or write', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const reviewer = new StubReviewer();
    const archive = new StubArchive();
    const useCase = new RequestIndependentReviewUseCase({ repo, reviewer, archive });

    const requests = [
      { ...requestFor('brief-check'), requestId: REQUEST_ID },
      { ...requestFor('brief-check', ''), requestId: REQUEST_ID },
      { ...requestFor('brief-check', '   '), requestId: REQUEST_ID },
    ];
    for (const request of requests) {
      const result = await useCase.requestIndependentReview(request);
      expect(result.outcome).toBe('rejected');
      if (result.outcome === 'rejected') {
        expect(result.rejection).toBe('invalid-request');
        expect(result.reason).toBe('A brief-check review requires the brief text');
      }
    }
    expect(reviewer.calls).toHaveLength(0);
    expect(archive.calls).toHaveLength(0);
    const stored = await repo.findAssessmentById('asm-1');
    expect(stored?.reviewReceipts).toHaveLength(0);
    expect(stored?.revision).toBe(0);
  });

  it('a refused brief-check consumes no request id: the same id with a real brief is reviewed', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const reviewer = new StubReviewer();
    const archive = new StubArchive();
    const useCase = new RequestIndependentReviewUseCase({ repo, reviewer, archive });

    const refused = await useCase.requestIndependentReview({ ...requestFor('brief-check'), requestId: REQUEST_ID });
    expect(refused.outcome).toBe('rejected');

    const retried = await useCase.requestIndependentReview({
      ...requestFor('brief-check', 'Do the thing.'),
      requestId: REQUEST_ID,
    });
    expect(retried.outcome).toBe('reviewed');
    expect(reviewer.calls).toHaveLength(1);
  });

  it('still runs a brief-check carrying a real briefText', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const reviewer = new StubReviewer();
    const archive = new StubArchive();
    const useCase = new RequestIndependentReviewUseCase({ repo, reviewer, archive });

    const result = await useCase.requestIndependentReview(
      requestFor('brief-check', 'Do the thing.'),
    );

    expect(result.outcome).toBe('reviewed');
    expect(reviewer.calls).toHaveLength(1);
    expect(reviewer.calls[0]?.kind).toBe('brief-check');
    expect(reviewer.calls[0]?.briefText).toBe('Do the thing.');
  });

  it('still runs a code-review without a briefText', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const reviewer = new StubReviewer();
    const archive = new StubArchive();
    const useCase = new RequestIndependentReviewUseCase({ repo, reviewer, archive });

    const result = await useCase.requestIndependentReview(requestFor('code-review'));

    expect(result.outcome).toBe('reviewed');
    expect(reviewer.calls).toHaveLength(1);
    expect(reviewer.calls[0]?.kind).toBe('code-review');
    expect('briefText' in reviewer.calls[0]).toBe(false);
  });
});

describe('unknown cause codes on receipts and the chain-name guard (RV2, CO9 #774)', () => {
  const REQUEST_ID = 'review-01JB0000000000000000000002';

  function codeReviewRequest(): RequestIndependentReviewRequest {
    return {
      assessmentId: 'asm-1',
      projectId: 'proj-1',
      attemptId: 'att-1',
      candidateHeadSha: HEAD1,
      policyRevision: 'pol-1',
      implementerModel: 'anthropic/claude-3-5-sonnet',
      reviewerModel: 'openai/gpt-4o',
      kind: 'code-review',
      requestId: REQUEST_ID,
    };
  }

  function unknownReviewer(unknownReason: string): StubReviewer {
    const reviewer = new StubReviewer();
    const delegate = reviewer.runIndependentReview.bind(reviewer);
    reviewer.runIndependentReview = async (request) => {
      // The default stub answer is discarded; only the call is recorded.
      await delegate(request);
      return {
        outcome: 'completed',
        readOnlyVerified: true,
        result: 'unknown',
        findings: [],
        rawOutput: 'the reviewer could not decide',
        completedAtIso: '2026-11-06T00:00:00.000Z',
        unknownReason: unknownReason as never,
      };
    };
    return reviewer;
  }

  for (const unknownReason of ['empty', 'unparseable-verdict', 'no-findings-on-fail']) {
    it(`stores unknownReason '${unknownReason}' on the receipt and replays it without a second review`, async () => {
      const repo = new InMemoryAssessmentRepo([sampleRecord()]);
      const reviewer = unknownReviewer(unknownReason);
      const archive = new StubArchive();
      const useCase = new RequestIndependentReviewUseCase({ repo, reviewer, archive });

      const first = await useCase.requestIndependentReview(codeReviewRequest());
      expect(first.outcome).toBe('reviewed');
      if (first.outcome !== 'reviewed') {
        throw new Error('expected a recorded review');
      }
      expect(first.receipt.result).toBe('unknown');
      expect(first.receipt.unknownReason).toBe(unknownReason);

      const stored = await repo.findAssessmentById('asm-1');
      expect(stored?.reviewReceipts[0]?.unknownReason).toBe(unknownReason);

      // Replaying the same requestId returns the stored receipt, unknownReason
      // included, without running a second review.
      const replay = await useCase.requestIndependentReview(codeReviewRequest());
      expect(replay).toEqual(first);
      expect(reviewer.calls).toHaveLength(1);
    });
  }

  it('a completed pass receipt carries no unknownReason key at all', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const reviewer = new StubReviewer();
    const archive = new StubArchive();
    const useCase = new RequestIndependentReviewUseCase({ repo, reviewer, archive });

      const result = await useCase.requestIndependentReview(codeReviewRequest());
      expect(result.outcome).toBe('reviewed');
      if (result.outcome !== 'reviewed') {
        throw new Error('expected a recorded review');
      }
      expect('unknownReason' in result.receipt).toBe(false);
  });

  it('robustness (1): ReviewReceipt.create refuses null, wrong-typed fields, sparse findings, invalid unknownReason, and throwing getters without throwing', () => {
    function receiptProps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        id: 'rr-1',
        assessmentId: 'asm-1',
        projectId: 'proj-1',
        attemptId: 'att-1',
        candidateHeadSha: HEAD1,
        reviewerModel: 'openai/gpt-4o',
        implementerModel: 'anthropic/claude-3-5-sonnet',
        readOnlyVerified: true,
        result: 'unknown',
        findings: [],
        evidenceRef: 'ref-1',
        policyRevision: 'pol-1',
        completedAtIso: '2026-11-06T00:00:00.000Z',
        ...overrides,
      };
    }
    const refusing: unknown[] = [
      null,
      42,
      'x',
      [],
      receiptProps({ unknownReason: 'not-a-code' }),
      receiptProps({ result: 'pass', unknownReason: 'empty' }),
      receiptProps({ result: 'fail', unknownReason: 'empty' }),
      receiptProps({ findings: [null] }),
      receiptProps({ findings: new Array(1) }),
      Object.defineProperty({}, 'result', { get() { throw new Error('boom'); }, enumerable: true }),
    ];
    for (const bad of refusing) {
      const created = ReviewReceipt.create(bad as never);
      expect(created.success).toBe(false);
      expect(created.error).toBeInstanceOf(Error);
    }
    // A sparse findings array is refused with the finding message, not a throw.
    const sparse = ReviewReceipt.create(receiptProps({ findings: new Array(1) }) as never);
    expect(sparse.success).toBe(false);

    // A valid unknown receipt with a declared code is accepted, and the absent
    // code is omitted entirely from the record.
    const unknown = ReviewReceipt.create(receiptProps({ unknownReason: 'empty' }) as never);
    expect(unknown.success).toBe(true);
    expect(unknown.value?.getUnknownReason()).toBe('empty');
    expect(unknown.value?.toRecord()).toMatchObject({ unknownReason: 'empty' });
    const plain = ReviewReceipt.create(receiptProps({ result: 'pass' }) as never);
    expect(plain.success).toBe(true);
    expect('unknownReason' in plain.value!.toRecord()).toBe(false);
  });

  it('robustness (3): replaying a requestId returns the stored unknown receipt and unknownReason without a second review call', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const reviewer = unknownReviewer('unparseable-verdict');
    const archive = new StubArchive();
    const useCase = new RequestIndependentReviewUseCase({ repo, reviewer, archive });

    const first = await useCase.requestIndependentReview(codeReviewRequest());
    const replay = await useCase.requestIndependentReview(codeReviewRequest());
    expect(replay).toEqual(first);
    expect(reviewer.calls).toHaveLength(1);
  });

  it('fail-first: a chain subject with a rejected chain name is refused before any assessment or review request', async () => {
    const repo = new InMemoryAssessmentRepo([]);
    const reviewer = new StubReviewer();
    const archive = new StubArchive();
    const useCase = new RequestIndependentReviewUseCase({ repo, reviewer, archive });

    const result = await useCase.requestIndependentReview({
      assessmentId: 'asm-chain-1',
      projectId: 'proj-1',
      attemptId: 'att-chain-1',
      candidateHeadSha: HEAD1,
      policyRevision: 'pol-1',
      implementerModel: 'anthropic/claude-3-5-sonnet',
      reviewerModel: 'openai/gpt-4o',
      kind: 'pre-merge',
      requestId: REQUEST_ID,
      subject: {
        kind: 'chain',
        projectId: 'proj-1',
        chainName: 'bad/name',
        integrationHeadSha: HEAD1,
      },
    } as never);

    expect(result.outcome).toBe('rejected');
    if (result.outcome !== 'rejected') {
      throw new Error('expected a rejection');
    }
    expect(result.rejection).toBe('invalid-request');
    expect(reviewer.calls).toHaveLength(0);
    expect(archive.calls).toHaveLength(0);
    expect(await repo.findAssessmentById('asm-chain-1')).toBeNull();
  });

  it('parity: the local chain-name validator accepts exactly the chain domain set', async () => {
    // The cases the chain-name tests pin (work-execution base-branch.ts CHAIN_PATTERN),
    // mirrored here because contexts never import across.
    const accepted = ['example', 'a-b-1', 'a'.repeat(194)];
    for (const value of accepted) {
      expect(isValidChainName(value), value).toBe(true);
    }
    for (const value of ['Chain/x', 'chain/x', 'a/b', 'a--b', '-a', 'a-', '', 'A', 'a b', 'a'.repeat(195), 'a'.repeat(200), 42, null, undefined, {}, ['a']]) {
      expect(isValidChainName(value), String(value)).toBe(false);
    }
  });
});
