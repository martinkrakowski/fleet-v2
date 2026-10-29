import { describe, expect, it } from 'vitest';

import type { EvidenceAssessmentRecord } from '../../../domain/evidence-records.js';
import type {
  ArchiveEvidenceRequest,
  ArchiveEvidenceResult,
  EvidenceArchivePort,
} from '../../ports/out/EvidenceArchivePort.out-port.js';
import type {
  EvidenceAssessmentRepositoryPort,
} from '../../ports/out/EvidenceAssessmentRepositoryPort.out-port.js';
import type {
  IndependentReviewPort,
  RunIndependentReviewRequest,
  RunIndependentReviewResult,
} from '../../ports/out/IndependentReviewPort.out-port.js';
import type {
  RequestIndependentReviewPort,
  RequestIndependentReviewRequest,
} from '../../ports/in/RequestIndependentReviewPort.in-port.js';
import { RequestIndependentReviewUseCase } from '../RequestIndependentReviewUseCase.use-case.js';

const HEAD1 = '1111111111111111111111111111111111111111';

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

/** A recording fake: it remembers the exact transport call per run. */
class RecordingReviewer implements IndependentReviewPort {
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
      completedAtIso: '2026-10-27T12:00:00.000Z',
    };
  }
}

class StubArchive implements EvidenceArchivePort {
  async archiveEvidence(request: ArchiveEvidenceRequest): Promise<ArchiveEvidenceResult> {
    return {
      evidenceRef: `ref-${request.artifactId}`,
      digest: 'digest-1',
    };
  }

  async readArchivedEvidence(_evidenceRef: string): Promise<string | null> {
    return 'content';
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
    updatedAtIso: '2026-10-27T12:00:00.000Z',
    ...overrides,
  };
}

const BASE_REQUEST: RequestIndependentReviewRequest = {
  assessmentId: 'asm-1',
  projectId: 'proj-1',
  attemptId: 'att-1',
  candidateHeadSha: HEAD1,
  policyRevision: 'pol-1',
  implementerModel: 'anthropic/claude-3-5-sonnet',
  reviewerModel: 'openai/gpt-4o',
};

describe('review kind and brief pass through to the transport (K5-E1)', () => {
  it('a conductor request with a kind and a brief passes both to the transport', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const reviewer = new RecordingReviewer();
    const useCase: RequestIndependentReviewPort = new RequestIndependentReviewUseCase({
      repo,
      reviewer,
      archive: new StubArchive(),
    });

    const result = await useCase.requestIndependentReview({
      ...BASE_REQUEST,
      kind: 'brief-check',
      briefText: '1. Add the review seat.\n2. Wire the checklist.',
    });

    expect(result.outcome).toBe('reviewed');
    expect(reviewer.calls).toHaveLength(1);
    expect(reviewer.calls[0]).toEqual({
      attemptId: 'att-1',
      candidateHeadSha: HEAD1,
      implementerModel: 'anthropic/claude-3-5-sonnet',
      reviewerModel: 'openai/gpt-4o',
      kind: 'brief-check',
      briefText: '1. Add the review seat.\n2. Wire the checklist.',
    });
  });

  it('a conductor request with a code-review kind passes the kind and no briefText field', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const reviewer = new RecordingReviewer();
    const useCase: RequestIndependentReviewPort = new RequestIndependentReviewUseCase({
      repo,
      reviewer,
      archive: new StubArchive(),
    });

    const result = await useCase.requestIndependentReview({
      ...BASE_REQUEST,
      kind: 'code-review',
    });

    expect(result.outcome).toBe('reviewed');
    expect(reviewer.calls[0]?.kind).toBe('code-review');
    expect('briefText' in reviewer.calls[0]).toBe(false);
  });

  it('a manual request omits kind and briefText so the transport call is unchanged', async () => {
    const repo = new InMemoryAssessmentRepo([sampleRecord()]);
    const reviewer = new RecordingReviewer();
    const useCase: RequestIndependentReviewPort = new RequestIndependentReviewUseCase({
      repo,
      reviewer,
      archive: new StubArchive(),
    });

    const result = await useCase.requestIndependentReview(BASE_REQUEST);

    expect(result.outcome).toBe('reviewed');
    expect(reviewer.calls).toHaveLength(1);
    expect('kind' in reviewer.calls[0]).toBe(false);
    expect('briefText' in reviewer.calls[0]).toBe(false);
    expect(reviewer.calls[0]).toEqual({
      attemptId: 'att-1',
      candidateHeadSha: HEAD1,
      implementerModel: 'anthropic/claude-3-5-sonnet',
      reviewerModel: 'openai/gpt-4o',
    });
  });
});
