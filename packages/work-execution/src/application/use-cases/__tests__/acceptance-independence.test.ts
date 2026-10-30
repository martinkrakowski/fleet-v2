// Acceptance independence tests — L9 (findings M8).
/**
 * Covers RequestAttemptAcceptanceUseCase's reviewer-independence gate: the
 * owner-decided family rule (underlyingModelFamily + isSameModelFamily) is the
 * only basis for independence, so a provider prefix or a tier/suffix change
 * alone is never independence, and an empty family fails closed.
 */

import { describe, expect, it } from 'vitest';

import { RequestAttemptAcceptanceUseCase } from '../RequestAttemptAcceptanceUseCase.use-case.js';
import type {
  RequestAttemptAcceptanceRequest,
} from '../../ports/in/RequestAttemptAcceptancePort.in-port.js';
import type {
  AcceptanceAssessmentPort,
  AcceptanceAssessmentRequest,
  AcceptanceAssessmentResult,
} from '../../ports/out/AcceptanceAssessmentPort.out-port.js';
import type { AttemptRepositoryPort } from '../../ports/out/AttemptRepositoryPort.out-port.js';
import type { AttemptRecord } from '../../../domain/execution-records.js';

const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';
const BASE_COMMIT = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const FIXED_NOW = '2026-10-15T08:00:00.000Z';

function makeAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'attempt-1',
    ownerDecisionReferences: [],
    workOrderId: 'wo-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/tmp/opencode/lanes/attempt-1',
    baseCommit: BASE_COMMIT,
    state: 'collected',
    outcome: 'done',
    briefDigest: 'digest-1',
    briefPackagePath: null,
    sessionId: 'session-1',
    completionReceipt: null,
    artifacts: {
      headCommit: HEAD_SHA,
      commitsSinceBase: [HEAD_SHA],
      collectedArtifactPaths: [],
      notes: 'present',
    },
    runner: {
      kind: 'opencode',
      remotePort: 4166,
      host: null,
      agent: null,
      model: 'nvidia/z-ai/glm-5.3',
      variant: null,
    },
    createdAtIso: FIXED_NOW,
    updatedAtIso: FIXED_NOW,
    ...overrides,
  };
}

class InMemoryAttemptRepository implements AttemptRepositoryPort {
  private readonly attempts = new Map<string, AttemptRecord>();

  constructor(records: readonly AttemptRecord[] = []) {
    for (const record of records) {
      this.attempts.set(record.id, record);
    }
  }

  async saveAttempt(record: AttemptRecord): Promise<void> {
    this.attempts.set(record.id, record);
  }

  async findAttemptById(attemptId: string): Promise<AttemptRecord | null> {
    return this.attempts.get(attemptId) ?? null;
  }

  async listAttemptsByWorkOrder(workOrderId: string): Promise<readonly AttemptRecord[]> {
    return [...this.attempts.values()].filter((a) => a.workOrderId === workOrderId);
  }

  async listAllAttempts(): Promise<readonly AttemptRecord[]> {
    return [...this.attempts.values()];
  }
}

class FakeAcceptanceAssessment implements AcceptanceAssessmentPort {
  readonly requests: AcceptanceAssessmentRequest[] = [];
  result: AcceptanceAssessmentResult = {
    outcome: 'accepted',
    receiptId: 'receipt-1',
    assessedHeadSha: HEAD_SHA,
  };

  async assessHeadAcceptance(request: AcceptanceAssessmentRequest): Promise<AcceptanceAssessmentResult> {
    this.requests.push(request);
    return this.result;
  }

  async assessHeadReceipts(): Promise<never> {
    throw new Error('assessHeadReceipts is not used by this test');
  }
}

function acceptanceRequest(overrides: Partial<RequestAttemptAcceptanceRequest> = {}): RequestAttemptAcceptanceRequest {
  return {
    attemptId: 'attempt-1',
    candidateHeadSha: HEAD_SHA,
    reviewerModel: 'openrouter/anthropic/claude-sonnet-4.5',
    ...overrides,
  };
}

describe('RequestAttemptAcceptanceUseCase independence', () => {
  it.each([
    ['openrouter/poolside/laguna-s-2.1:free', 'openrouter/poolside/laguna-s-2.1'],
    ['nvidia/z-ai/glm-5.3', 'z-ai/glm-5.3'],
    ['nvidia/z-ai/glm-5.3', 'openrouter/z-ai/glm-5.3-flash'],
    ['x/glm-5.3#low', 'glm-5.3'],
    ['a/claude-sonnet-4-5@20250929', 'claude-3-5-sonnet'],
  ])('rejects implementer %s with reviewer %s as the same family', async (implementerModel, reviewerModel) => {
    const acceptancePort = new FakeAcceptanceAssessment();
    const useCase = new RequestAttemptAcceptanceUseCase({
      attemptRepo: new InMemoryAttemptRepository([
        makeAttempt({ runner: { kind: 'opencode', remotePort: 4166, host: null, agent: null, model: implementerModel, variant: null } }),
      ]),
      acceptancePort,
    });

    const result = await useCase.requestAttemptAcceptance(
      acceptanceRequest({ reviewerModel }),
    );

    expect(result.outcome).toBe('rejected');
    expect(result.outcome === 'rejected' && result.reason).toContain(
      'an independent reviewer is required',
    );
    expect(acceptancePort.requests).toHaveLength(0);
  });

  it('fails closed when the implementer model has an empty family', async () => {
    const acceptancePort = new FakeAcceptanceAssessment();
    const useCase = new RequestAttemptAcceptanceUseCase({
      attemptRepo: new InMemoryAttemptRepository([
        makeAttempt({ runner: { kind: 'opencode', remotePort: 4166, host: null, agent: null, model: '4o-mini', variant: null } }),
      ]),
      acceptancePort,
    });

    const result = await useCase.requestAttemptAcceptance(
      acceptanceRequest({ reviewerModel: 'openrouter/anthropic/claude-sonnet-4.5' }),
    );

    expect(result.outcome).toBe('rejected');
    expect(result.outcome === 'rejected' && result.reason).toContain(
      'an independent reviewer is required',
    );
    expect(acceptancePort.requests).toHaveLength(0);
  });

  it('rejects a request whose reviewerModel is not a string', async () => {
    const acceptancePort = new FakeAcceptanceAssessment();
    const useCase = new RequestAttemptAcceptanceUseCase({
      attemptRepo: new InMemoryAttemptRepository([makeAttempt()]),
      acceptancePort,
    });

    const result = await useCase.requestAttemptAcceptance(
      acceptanceRequest({ reviewerModel: undefined as unknown as string }),
    );

    expect(result).toEqual({ outcome: 'rejected', reason: 'reviewerModel is required' });
    expect(acceptancePort.requests).toHaveLength(0);
  });

  it('rejects a reviewer model with an empty family', async () => {
    const acceptancePort = new FakeAcceptanceAssessment();
    const useCase = new RequestAttemptAcceptanceUseCase({
      attemptRepo: new InMemoryAttemptRepository([
        makeAttempt({ runner: { kind: 'opencode', remotePort: 4166, host: null, agent: null, model: 'openrouter/inception/mercury-3', variant: null } }),
      ]),
      acceptancePort,
    });

    const result = await useCase.requestAttemptAcceptance(
      acceptanceRequest({ reviewerModel: '4o-mini' }),
    );

    expect(result.outcome).toBe('rejected');
    expect(result.outcome === 'rejected' && result.reason).toContain(
      'an independent reviewer is required',
    );
    expect(acceptancePort.requests).toHaveLength(0);
  });

  it('accepts a reviewer of a different family past the independence check', async () => {
    const acceptancePort = new FakeAcceptanceAssessment();
    const useCase = new RequestAttemptAcceptanceUseCase({
      attemptRepo: new InMemoryAttemptRepository([
        makeAttempt({ runner: { kind: 'opencode', remotePort: 4166, host: null, agent: null, model: 'openrouter/inception/mercury-3', variant: null } }),
      ]),
      acceptancePort,
    });

    // The reviewer and implementer are different families, so the request
    // passes independence; with no work order wired it is then refused at the
    // policy-revision check rather than the independence gate.
    const result = await useCase.requestAttemptAcceptance(
      acceptanceRequest({ reviewerModel: 'openrouter/z-ai/glm-5.3-flash' }),
    );

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'Acceptance requires the work order policy revision; no work order is available',
    });
    expect(acceptancePort.requests).toHaveLength(0);
  });
});
