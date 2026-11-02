// RequestVerificationUseCase budget rule (DT8 correction 1): the deadline is
// threaded through to every executor call, a call with under 2 seconds
// remaining is not started, and callers that pass no deadline keep today's
// timeout.

import { describe, expect, it } from 'vitest';

import type { EvidenceAssessmentRecord } from '../../../domain/evidence-records.js';
import type { EvidenceResultValue } from '../../../domain/value-objects/EvidenceResult.vo.js';
import type { EvidenceArchivePort } from '../../ports/out/EvidenceArchivePort.out-port.js';
import type { EvidenceAssessmentRepositoryPort } from '../../ports/out/EvidenceAssessmentRepositoryPort.out-port.js';
import type {
  ExecuteVerificationCheckRequest,
  ExecuteVerificationCheckResult,
  VerificationExecutorPort,
} from '../../ports/out/VerificationExecutorPort.out-port.js';
import type { RequestVerificationResult } from '../../ports/in/RequestVerificationPort.in-port.js';
import { RequestVerificationUseCase } from '../RequestVerificationUseCase.use-case.js';

const HEAD = '1111111111111111111111111111111111111111';
const IMPLEMENTER_MODEL = 'openrouter/z-ai/glm-5.3-flash';
const NOW = '2026-10-15T00:00:00.000Z';
const DEADLINE = '2026-10-15T00:00:30.000Z';

const emptyRepo: EvidenceAssessmentRepositoryPort = {
  async findAssessmentById() {
    return null;
  },
  async findAssessmentByHead() {
    return null;
  },
  async saveAssessment(record: EvidenceAssessmentRecord) {
    void record;
  },
};

const archive: EvidenceArchivePort = {
  async archiveEvidence(request) {
    return { evidenceRef: `evidence://${request.artifactId}`, digest: 'd' };
  },
  async readArchivedEvidence() {
    return null;
  },
};

class RecordingExecutor implements VerificationExecutorPort {
  readonly calls: ExecuteVerificationCheckRequest[] = [];

  constructor(private readonly result: EvidenceResultValue = 'pass') {}

  async executeVerificationCheck(
    request: ExecuteVerificationCheckRequest,
  ): Promise<ExecuteVerificationCheckResult> {
    this.calls.push(request);
    return {
      result: this.result,
      exitCode: this.result === 'pass' ? 0 : 1,
      outputSummary: `${request.procedureName}: ${this.result}`,
      completedAtIso: NOW,
    };
  }
}

function verificationRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    assessmentId: 'ea-deadline',
    projectId: 'proj-deadline',
    attemptId: 'att-deadline',
    candidateHeadSha: HEAD,
    policyRevision: 'policy-7',
    hostId: 'host-1',
    implementerModel: IMPLEMENTER_MODEL,
    requiredChecks: ['ci'],
    nowIso: NOW,
    ...overrides,
  };
}

describe('RequestVerificationUseCase deadline budget', () => {
  it('forwards the deadline to every executor call when one is supplied', async () => {
    const executor = new RecordingExecutor();
    const useCase = new RequestVerificationUseCase({
      repo: emptyRepo,
      executor,
      archive,
      clock: () => new Date(NOW),
    });

    const result: RequestVerificationResult = await useCase.requestVerification(
      verificationRequest({ deadlineIso: DEADLINE }) as never,
    );

    expect(result.outcome).toBe('completed');
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.deadlineIso).toBe(DEADLINE);
  });

  it('does not start an executor call with under 2 seconds remaining', async () => {
    const executor = new RecordingExecutor();
    const useCase = new RequestVerificationUseCase({
      repo: emptyRepo,
      executor,
      archive,
      clock: () => new Date(NOW),
    });

    const result = await useCase.requestVerification(
      verificationRequest({ deadlineIso: '2026-10-15T00:00:01.000Z' }) as never,
    );

    expect(result).toEqual({
      outcome: 'not-started',
      reason: expect.stringContaining('budget exhausted'),
    });
    expect(executor.calls).toEqual([]);
  });

  it('keeps today\'s timeout when no deadline is supplied', async () => {
    const executor = new RecordingExecutor();
    const useCase = new RequestVerificationUseCase({
      repo: emptyRepo,
      executor,
      archive,
      clock: () => new Date(NOW),
    });

    const result = await useCase.requestVerification(verificationRequest() as never);

    expect(result.outcome).toBe('completed');
    expect('deadlineIso' in (executor.calls[0] ?? {})).toBe(false);
  });

  it('exhausts budget mid-sequence when the injected clock advances past the deadline before a subsequent check', async () => {
    const executor = new RecordingExecutor();
    let tick = 0;
    const timestamps = [
      '2026-10-15T00:00:00.000Z',
      '2026-10-15T00:00:02.100Z',
    ];
    const clock = () => timestamps[Math.min(tick++, timestamps.length - 1)]!;

    const useCase = new RequestVerificationUseCase({
      repo: emptyRepo,
      executor,
      archive,
      clock,
    });

    const result = await useCase.requestVerification({
      assessmentId: 'ea-multi-deadline',
      projectId: 'fleet-core-worker',
      attemptId: 'att-20261015-multi',
      candidateHeadSha: '9f8e7d6c5b4a3928170123456789abcdef012345',
      policyRevision: 'pol-rev-42',
      hostId: 'verify-host-lin-01',
      implementerModel: 'anthropic/claude-3-5-sonnet',
      requiredChecks: ['lint', 'acceptance'],
      deadlineIso: '2026-10-15T00:00:03.000Z',
    });

    expect(result).toEqual({
      outcome: 'not-started',
      reason: "Verification budget exhausted before starting check 'acceptance'",
    });
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.procedureName).toBe('lint');
  });
});
