// Cross-context & forge station tests — acceptance and forge use cases,
// cross-context adapters and the forge adapter.
/**
 * Covers RequestAttemptAcceptanceUseCase (exact-head check, moved head,
 * same-model reviewer rejection including across providers, accepted
 * receipt propagation), ExecuteAuthorizedForgeActionUseCase (stale head,
 * missing acceptance receipt on merge, single-consumption grants,
 * ambiguous forge responses) and all five cross-context/forge adapters.
 */

import { describe, expect, it } from 'vitest';

import { RequestAttemptAcceptanceUseCase } from '../RequestAttemptAcceptanceUseCase.use-case.js';
import { ExecuteAuthorizedForgeActionUseCase } from '../ExecuteAuthorizedForgeActionUseCase.use-case.js';
import { AcceptanceAssessmentAdapter } from '../../../infrastructure/adapters/AcceptanceAssessmentAdapter.adapter.js';
import { ActionAuthorizationAdapter } from '../../../infrastructure/adapters/ActionAuthorizationAdapter.adapter.js';
import { BriefKnowledgeAdapter } from '../../../infrastructure/adapters/BriefKnowledgeAdapter.adapter.js';
import { ExecutionObservationAdapter } from '../../../infrastructure/adapters/ExecutionObservationAdapter.adapter.js';
import { ForgeActionAdapter } from '../../../infrastructure/adapters/ForgeActionAdapter.adapter.js';
import type {
  ExecuteAuthorizedForgeActionRequest,
} from '../../ports/in/ExecuteAuthorizedForgeActionPort.in-port.js';
import type {
  RequestAttemptAcceptanceRequest,
} from '../../ports/in/RequestAttemptAcceptancePort.in-port.js';
import type {
  AcceptanceAssessmentPort,
  AcceptanceAssessmentRequest,
  AcceptanceAssessmentResult,
} from '../../ports/out/AcceptanceAssessmentPort.out-port.js';
import type {
  ActionAuthorizationPort,
  ConsumeActionAuthorizationRequest,
  ConsumeActionAuthorizationResult,
  ResolveActionAuthorizationRequest,
  ResolveActionAuthorizationResult,
} from '../../ports/out/ActionAuthorizationPort.out-port.js';
import type { AttemptRepositoryPort } from '../../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../../ports/out/ExecutionJournalPort.out-port.js';
import type {
  AcceptanceEvidencePort,
  ReadAcceptanceRequest,
  ReadAcceptanceResult,
} from '../../ports/out/AcceptanceEvidencePort.out-port.js';
import type {
  ForgeActionPort,
  ForgeActionRequest,
  ForgeActionResult,
} from '../../ports/out/ForgeActionPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../../ports/out/WorkOrderRepositoryPort.out-port.js';
import type {
  BriefContextProposal,
  ForwardCompletedAttemptNotesRequest,
  RecordContextSelectionRequest,
  RequestBriefContextProposalsRequest,
} from '../../ports/out/BriefKnowledgePort.out-port.js';
import type {
  PublishExecutionObservationRequest,
} from '../../ports/out/ExecutionObservationPort.out-port.js';
import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  CapacityReservationRecord,
  WorkOrderRecord,
} from '../../../domain/execution-records.js';

const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const BASE_COMMIT = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const FIXED_NOW = '2026-10-15T08:00:00.000Z';
const LANE_ID = 'wk-p4-cross-forge';

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
    createdAtIso: FIXED_NOW,
    updatedAtIso: FIXED_NOW,
    ...overrides,
  };
}

function makeWorkOrder(overrides: Partial<WorkOrderRecord> = {}): WorkOrderRecord {
  return {
    id: 'wo-1',
    projectId: 'project-1',
    taskId: 'task-1',
    laneId: LANE_ID,
    repository: 'github.com/org/repo',
    baseCommit: BASE_COMMIT,
    ownedPaths: ['packages/work-execution/src'],
    policyRevision: 'policy-7',
    prerequisiteWorkOrderIds: [],
    state: 'verifying',
    revision: 2,
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

class InMemoryWorkOrderRepository implements WorkOrderRepositoryPort {
  readonly saved: WorkOrderRecord[] = [];
  private readonly orders = new Map<string, WorkOrderRecord>();

  constructor(records: readonly WorkOrderRecord[] = []) {
    for (const record of records) {
      this.orders.set(record.id, record);
    }
  }

  async saveWorkOrder(record: WorkOrderRecord): Promise<void> {
    this.saved.push(record);
    this.orders.set(record.id, record);
  }

  async findWorkOrderById(workOrderId: string): Promise<WorkOrderRecord | null> {
    return this.orders.get(workOrderId) ?? null;
  }

  async listWorkOrdersByProject(projectId?: string): Promise<readonly WorkOrderRecord[]> {
    const all = [...this.orders.values()];
    return projectId === undefined ? all : all.filter((o) => o.projectId === projectId);
  }
}

class InMemoryJournal implements ExecutionJournalPort {
  readonly entries: ActionJournalEntryRecord[] = [];

  async appendJournalEntry(entry: ActionJournalEntryRecord): Promise<void> {
    this.entries.push(entry);
  }

  async listJournalEntriesForAttempt(attemptId: string): Promise<readonly ActionJournalEntryRecord[]> {
    return this.entries.filter((e) => e.attemptId === attemptId);
  }

  async saveCapacityReservation(reservation: CapacityReservationRecord): Promise<void> {
    void reservation;
  }

  async listActiveReservations(_hostId?: string): Promise<readonly CapacityReservationRecord[]> {
    return [];
  }

  async releaseCapacityReservation(_attemptId: string, _releasedAtIso: string): Promise<boolean> {
    return false;
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
}

class FakeActionAuthorization implements ActionAuthorizationPort {
  readonly consumeRequests: ConsumeActionAuthorizationRequest[] = [];
  result: ConsumeActionAuthorizationResult = { outcome: 'consumed', actionId: 'action-1' };

  async resolveActionAuthorization(
    _request: ResolveActionAuthorizationRequest,
  ): Promise<ResolveActionAuthorizationResult> {
    throw new Error('resolveActionAuthorization is not used by the forge use case');
  }

  async consumeActionAuthorization(
    request: ConsumeActionAuthorizationRequest,
  ): Promise<ConsumeActionAuthorizationResult> {
    this.consumeRequests.push(request);
    return this.result;
  }
}

class FakeForge implements ForgeActionPort {
  readonly requests: ForgeActionRequest[] = [];
  journalAtCall: readonly ActionJournalEntryRecord[] = [];
  result: ForgeActionResult = { outcome: 'executed', headSha: HEAD_SHA };
  configured = true;

  constructor(private readonly journal?: InMemoryJournal) {}

  isConfigured(): boolean {
    return this.configured;
  }

  async performForgeAction(request: ForgeActionRequest): Promise<ForgeActionResult> {
    this.requests.push(request);
    this.journalAtCall = this.journal ? [...this.journal.entries] : [];
    return this.result;
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

class FakeAcceptanceEvidence implements AcceptanceEvidencePort {
  constructor(
    private readonly result: ReadAcceptanceResult = {
      outcome: 'found',
      assessment: {
        state: 'accepted',
        candidateHeadSha: HEAD_SHA,
        policyRevision: 'policy-7',
        acceptanceReceiptId: 'receipt-1',
      },
    },
  ) {}

  async readAcceptance(_request: ReadAcceptanceRequest): Promise<ReadAcceptanceResult> {
    return this.result;
  }
}

function forgeRequest(overrides: Partial<ExecuteAuthorizedForgeActionRequest> = {}): ExecuteAuthorizedForgeActionRequest {
  return {
    actionId: 'action-1',
    attemptId: 'attempt-1',
    workOrderId: 'wo-1',
    kind: 'merge-pr',
    expectedHeadSha: HEAD_SHA,
    authorizationGrantId: 'grant-1',
    ...overrides,
  };
}

describe('RequestAttemptAcceptanceUseCase', () => {
  it('throws when unconfigured', async () => {
    const useCase = new RequestAttemptAcceptanceUseCase();

    await expect(useCase.requestAttemptAcceptance(acceptanceRequest())).rejects.toThrow(
      'Not implemented: RequestAttemptAcceptanceUseCase',
    );
    await expect(useCase.execute(acceptanceRequest())).rejects.toThrow(
      'Not implemented: RequestAttemptAcceptanceUseCase',
    );
  });

  it('rejects when the attempt is not found', async () => {
    const useCase = new RequestAttemptAcceptanceUseCase({
      attemptRepo: new InMemoryAttemptRepository(),
      acceptancePort: new FakeAcceptanceAssessment(),
    });

    const result = await useCase.requestAttemptAcceptance(acceptanceRequest());

    expect(result).toEqual({ outcome: 'rejected', reason: 'Attempt not found' });
  });

  it('rejects an attempt that has not ended or been collected', async () => {
    const useCase = new RequestAttemptAcceptanceUseCase({
      attemptRepo: new InMemoryAttemptRepository([makeAttempt({ state: 'running' })]),
      acceptancePort: new FakeAcceptanceAssessment(),
    });

    const result = await useCase.requestAttemptAcceptance(acceptanceRequest());

    expect(result).toEqual({
      outcome: 'rejected',
      reason: "Attempt is not ready for acceptance: state is 'running'",
    });
  });

  it('rejects an attempt without collected artifacts', async () => {
    const useCase = new RequestAttemptAcceptanceUseCase({
      attemptRepo: new InMemoryAttemptRepository([
        makeAttempt({ state: 'ended', artifacts: null }),
      ]),
      acceptancePort: new FakeAcceptanceAssessment(),
    });

    const result = await useCase.requestAttemptAcceptance(acceptanceRequest());

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'Attempt has no collected artifacts',
    });
  });

  it('rejects a moved candidate head with the expected and actual heads', async () => {
    const useCase = new RequestAttemptAcceptanceUseCase({
      attemptRepo: new InMemoryAttemptRepository([makeAttempt()]),
      acceptancePort: new FakeAcceptanceAssessment(),
    });

    const result = await useCase.requestAttemptAcceptance(
      acceptanceRequest({ candidateHeadSha: OTHER_SHA }),
    );

    expect(result).toEqual({
      outcome: 'rejected',
      reason: `Candidate head mismatch: expected ${HEAD_SHA}, got ${OTHER_SHA}`,
    });
  });

  it('rejects a reviewer that is the implementer model and never assesses', async () => {
    const acceptancePort = new FakeAcceptanceAssessment();
    const useCase = new RequestAttemptAcceptanceUseCase({
      attemptRepo: new InMemoryAttemptRepository([makeAttempt()]),
      acceptancePort,
      implementerModelByAttempt: { 'attempt-1': 'nvidia/z-ai/glm-5.3' },
    });

    const result = await useCase.requestAttemptAcceptance(
      acceptanceRequest({ reviewerModel: 'nvidia/z-ai/glm-5.3' }),
    );

    expect(result.outcome).toBe('rejected');
    expect(result.outcome === 'rejected' && result.reason).toContain(
      'matches implementer model nvidia/z-ai/glm-5.3',
    );
    expect(acceptancePort.requests).toHaveLength(0);
  });

  it('rejects the same base model across different providers', async () => {
    const acceptancePort = new FakeAcceptanceAssessment();
    const useCase = new RequestAttemptAcceptanceUseCase({
      attemptRepo: new InMemoryAttemptRepository([makeAttempt()]),
      acceptancePort,
    });

    // No per-attempt map: the default implementer seat is nvidia/z-ai/glm-5.3.
    const result = await useCase.requestAttemptAcceptance(
      acceptanceRequest({ reviewerModel: 'openrouter/z-ai/glm-5.3' }),
    );

    expect(result.outcome).toBe('rejected');
    expect(result.outcome === 'rejected' && result.reason).toContain('an independent reviewer is required');
    expect(acceptancePort.requests).toHaveLength(0);
  });

  it('rejects when no work order is available to scope the assessment', async () => {
    const acceptancePort = new FakeAcceptanceAssessment();
    const useCase = new RequestAttemptAcceptanceUseCase({
      attemptRepo: new InMemoryAttemptRepository([makeAttempt()]),
      acceptancePort,
    });

    const result = await useCase.requestAttemptAcceptance(acceptanceRequest());

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'Acceptance requires the work order policy revision; no work order is available',
    });
    expect(acceptancePort.requests).toHaveLength(0);
  });

  it('accepts the exact head and propagates the receipt', async () => {
    const acceptancePort = new FakeAcceptanceAssessment();
    const workOrderRepo = new InMemoryWorkOrderRepository([makeWorkOrder()]);
    const useCase = new RequestAttemptAcceptanceUseCase({
      attemptRepo: new InMemoryAttemptRepository([makeAttempt()]),
      workOrderRepo,
      acceptancePort,
      now: () => FIXED_NOW,
    });

    const result = await useCase.requestAttemptAcceptance(acceptanceRequest());

    expect(result).toEqual({
      outcome: 'accepted',
      candidateHeadSha: HEAD_SHA,
      receiptId: 'receipt-1',
    });
    expect(acceptancePort.requests).toEqual([
      {
        attemptId: 'attempt-1',
        workOrderId: 'wo-1',
        candidateHeadSha: HEAD_SHA,
        policyRevision: 'policy-7',
      },
    ]);
    expect(workOrderRepo.saved).toEqual([
      expect.objectContaining({
        id: 'wo-1',
        state: 'ready-to-merge',
        revision: 3,
        updatedAtIso: FIXED_NOW,
      }),
    ]);
  });

  it('also accepts through the execute entry point', async () => {
    const useCase = new RequestAttemptAcceptanceUseCase({
      attemptRepo: new InMemoryAttemptRepository([makeAttempt()]),
      workOrderRepo: new InMemoryWorkOrderRepository([makeWorkOrder()]),
      acceptancePort: new FakeAcceptanceAssessment(),
      now: () => FIXED_NOW,
    });

    const result = await useCase.execute(acceptanceRequest());

    expect(result).toEqual({
      outcome: 'accepted',
      candidateHeadSha: HEAD_SHA,
      receiptId: 'receipt-1',
    });
  });

  it('never regresses a terminal work order on acceptance', async () => {
    const workOrderRepo = new InMemoryWorkOrderRepository([makeWorkOrder({ state: 'merged' })]);
    const useCase = new RequestAttemptAcceptanceUseCase({
      attemptRepo: new InMemoryAttemptRepository([makeAttempt()]),
      workOrderRepo,
      acceptancePort: new FakeAcceptanceAssessment(),
      now: () => FIXED_NOW,
    });

    const result = await useCase.requestAttemptAcceptance(acceptanceRequest());

    expect(result.outcome).toBe('accepted');
    expect(workOrderRepo.saved).toHaveLength(0);
  });

  it('rejects a receipt assessed for a different head as stale', async () => {
    const acceptancePort = new FakeAcceptanceAssessment();
    acceptancePort.result = {
      outcome: 'accepted',
      receiptId: 'receipt-1',
      assessedHeadSha: OTHER_SHA,
    };
    const workOrderRepo = new InMemoryWorkOrderRepository([makeWorkOrder()]);
    const useCase = new RequestAttemptAcceptanceUseCase({
      attemptRepo: new InMemoryAttemptRepository([makeAttempt()]),
      workOrderRepo,
      acceptancePort,
      now: () => FIXED_NOW,
    });

    const result = await useCase.requestAttemptAcceptance(acceptanceRequest());

    expect(result).toEqual({
      outcome: 'rejected',
      reason: `Stale: assessed head ${OTHER_SHA} does not match candidate head ${HEAD_SHA}`,
    });
    expect(workOrderRepo.saved).toHaveLength(0);
  });

  it('passes a rejected assessment through unchanged', async () => {
    const acceptancePort = new FakeAcceptanceAssessment();
    acceptancePort.result = {
      outcome: 'rejected',
      reason: 'verification failed on host alpha',
    };
    const workOrderRepo = new InMemoryWorkOrderRepository([makeWorkOrder()]);
    const useCase = new RequestAttemptAcceptanceUseCase({
      attemptRepo: new InMemoryAttemptRepository([makeAttempt()]),
      workOrderRepo,
      acceptancePort,
    });

    const result = await useCase.requestAttemptAcceptance(acceptanceRequest());

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'verification failed on host alpha',
    });
    expect(workOrderRepo.saved).toHaveLength(0);
  });

  it('rejects an unknown assessment without inventing a pass', async () => {
    const acceptancePort = new FakeAcceptanceAssessment();
    acceptancePort.result = { outcome: 'unknown', reason: 'evidence still pending' };
    const useCase = new RequestAttemptAcceptanceUseCase({
      attemptRepo: new InMemoryAttemptRepository([makeAttempt()]),
      workOrderRepo: new InMemoryWorkOrderRepository([makeWorkOrder()]),
      acceptancePort,
    });

    const result = await useCase.requestAttemptAcceptance(acceptanceRequest());

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'Unknown: evidence still pending',
    });
  });
});

describe('ExecuteAuthorizedForgeActionUseCase', () => {
  function makeDeps(
    overrides: {
      attempt?: AttemptRecord;
      workOrder?: WorkOrderRecord | null;
      authorization?: FakeActionAuthorization | ActionAuthorizationPort;
      forgeResult?: ForgeActionResult;
      acceptanceEvidence?: ReadAcceptanceResult | null;
    } = {},
  ) {
    const journal = new InMemoryJournal();
    const authorization =
      overrides.authorization ??
      new FakeActionAuthorization();
    const forgePort = new FakeForge(journal);
    forgePort.result = overrides.forgeResult ?? { outcome: 'executed', headSha: HEAD_SHA };
    const workOrderRepo = new InMemoryWorkOrderRepository(
      overrides.workOrder === null ? [] : [overrides.workOrder ?? makeWorkOrder()],
    );
    // Merges read acceptance through the port; `null` leaves it unwired to
    // exercise the fail-closed unconfigured branch.
    const acceptanceEvidencePort =
      overrides.acceptanceEvidence === undefined
        ? new FakeAcceptanceEvidence()
        : overrides.acceptanceEvidence === null
          ? undefined
          : new FakeAcceptanceEvidence(overrides.acceptanceEvidence);
    const attemptRepo = new InMemoryAttemptRepository([overrides.attempt ?? makeAttempt()]);
    const useCase = new ExecuteAuthorizedForgeActionUseCase({
      attemptRepo,
      workOrderRepo,
      journal,
      authorizationPort: authorization,
      forgePort,
      acceptanceEvidencePort,
      attemptOwnerDecisionPort: {
        async readAttemptOwnerDecisionReferences({ attemptId }) {
          const record = await attemptRepo.findAttemptById(attemptId);
          if (record === null) {
            return { outcome: 'unknown', reason: `No attempt is recorded for ${attemptId}` };
          }
          if (record.ownerDecisionReferences === undefined) {
            return {
              outcome: 'unknown',
              reason: `attempt ${attemptId} was recorded before owner decision references were frozen`,
            };
          }
          return { outcome: 'recorded', ownerDecisionReferences: record.ownerDecisionReferences };
        },
      },
      now: () => FIXED_NOW,
    });
    return { journal, authorization, forgePort, workOrderRepo, useCase };
  }

  it('throws when unconfigured', async () => {
    const useCase = new ExecuteAuthorizedForgeActionUseCase();

    await expect(useCase.executeAuthorizedForgeAction(forgeRequest())).rejects.toThrow(
      'Not implemented: ExecuteAuthorizedForgeActionUseCase',
    );
    await expect(useCase.execute(forgeRequest())).rejects.toThrow(
      'Not implemented: ExecuteAuthorizedForgeActionUseCase',
    );
  });

  it('refuses when the attempt or work order is missing', async () => {
    const { useCase } = makeDeps({ workOrder: null });

    const result = await useCase.executeAuthorizedForgeAction(forgeRequest());

    expect(result).toEqual({ outcome: 'refused', reason: 'Attempt or work order not found' });
  });

  it('refuses a stale expected head before consuming any grant', async () => {
    const authorization = new FakeActionAuthorization();
    const { useCase, forgePort } = makeDeps({ authorization });

    const result = await useCase.executeAuthorizedForgeAction(
      forgeRequest({ expectedHeadSha: OTHER_SHA }),
    );

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Moved head: attempt headCommit does not match expectedHeadSha',
    });
    expect(authorization.consumeRequests).toHaveLength(0);
    expect(forgePort.requests).toHaveLength(0);
  });

  it('refuses a merge when the acceptance assessment is for another head', async () => {
    const authorization = new FakeActionAuthorization();
    const { useCase, forgePort } = makeDeps({
      authorization,
      acceptanceEvidence: {
        outcome: 'found',
        assessment: {
          state: 'accepted',
          candidateHeadSha: OTHER_SHA,
          policyRevision: 'policy-7',
          acceptanceReceiptId: 'receipt-other',
        },
      },
    });

    const result = await useCase.executeAuthorizedForgeAction(forgeRequest());

    expect(result).toEqual({
      outcome: 'refused',
      reason: `Cannot merge: assessment head '${OTHER_SHA}' does not match expectedHeadSha '${HEAD_SHA}'`,
    });
    expect(authorization.consumeRequests).toHaveLength(0);
    expect(forgePort.requests).toHaveLength(0);
  });

  it('refuses a merge when no acceptance evidence port is configured at all', async () => {
    const authorization = new FakeActionAuthorization();
    const { useCase, forgePort } = makeDeps({ authorization, acceptanceEvidence: null });

    const result = await useCase.executeAuthorizedForgeAction(forgeRequest());

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Cannot merge without a configured acceptance evidence port',
    });
    expect(authorization.consumeRequests).toHaveLength(0);
    expect(forgePort.requests).toHaveLength(0);
  });

  it('executes a push-and-open-pr without requiring an acceptance receipt', async () => {
    const { useCase, forgePort, workOrderRepo } = makeDeps({
      acceptanceEvidence: { outcome: 'not-found', reason: 'no assessment recorded' },
      forgeResult: { outcome: 'executed', pullRequestNumber: 42, headSha: HEAD_SHA },
    });

    const result = await useCase.executeAuthorizedForgeAction(
      forgeRequest({ kind: 'push-and-open-pr' }),
    );

    expect(result).toEqual({
      outcome: 'executed',
      pullRequestNumber: 42,
      headSha: HEAD_SHA,
    });
    expect(forgePort.requests).toHaveLength(1);
    expect(workOrderRepo.saved).toHaveLength(0);
  });

  it('refuses an unconsumed grant, journals the refusal and never forges', async () => {
    const authorization = new FakeActionAuthorization();
    authorization.result = {
      outcome: 'refused',
      reason: 'Authorization grant already consumed by action other-1',
    };
    const { useCase, journal, forgePort } = makeDeps({ authorization });

    const result = await useCase.executeAuthorizedForgeAction(forgeRequest());

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Authorization grant already consumed by action other-1',
    });
    expect(authorization.consumeRequests).toEqual([
      {
        authorizationGrantId: 'grant-1',
        actionId: 'action-1',
        actionKind: 'merge-pr',
        expectedHeadSha: HEAD_SHA,
        attemptId: 'attempt-1',
      },
    ]);
    expect(forgePort.requests).toHaveLength(0);
    expect(journal.entries.map((entry) => entry.status)).toEqual(['refused']);
    expect(journal.entries[0]).toEqual(
      expect.objectContaining({
        action: 'forge',
        baseCommit: BASE_COMMIT,
        detail: 'Authorization grant already consumed by action other-1',
        recordedAtIso: FIXED_NOW,
      }),
    );
  });

  it('records forge intent durably before the subprocess runs and completes a merge', async () => {
    const { useCase, journal, forgePort, workOrderRepo } = makeDeps();

    const result = await useCase.executeAuthorizedForgeAction(forgeRequest());

    expect(result).toEqual({ outcome: 'executed', headSha: HEAD_SHA });
    // Intent was already durable when the forge port was invoked.
    expect(forgePort.journalAtCall.map((entry) => entry.status)).toEqual(['intent-recorded']);
    expect(journal.entries.map((entry) => entry.status)).toEqual([
      'intent-recorded',
      'completed',
    ]);
    for (const entry of journal.entries) {
      expect(entry.action).toBe('forge');
      expect(entry.recordedAtIso).toBe(FIXED_NOW);
    }
    expect(forgePort.requests).toEqual([
      {
        actionId: 'action-1',
        attemptId: 'attempt-1',
        workOrderId: 'wo-1',
        kind: 'merge-pr',
        expectedHeadSha: HEAD_SHA,
        branchName: `feat/${LANE_ID}`,
      },
    ]);
    expect(workOrderRepo.saved).toEqual([
      expect.objectContaining({
        id: 'wo-1',
        state: 'merged',
        revision: 3,
        updatedAtIso: FIXED_NOW,
      }),
    ]);
  });

  it('reports an ambiguous forge response for reconciliation', async () => {
    const { useCase, journal, forgePort } = makeDeps({
      forgeResult: { outcome: 'ambiguous', reason: 'merge request timed out' },
    });

    const result = await useCase.executeAuthorizedForgeAction(forgeRequest());

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Ambiguous forge response requires reconciliation: merge request timed out',
    });
    expect(journal.entries.map((entry) => entry.status)).toEqual([
      'intent-recorded',
      'ambiguous',
    ]);
    expect(forgePort.requests).toHaveLength(1);
  });

  it('reports a refused forge response with its reason', async () => {
    const { useCase, journal } = makeDeps({
      forgeResult: { outcome: 'refused', reason: 'gh pr merge failed (exit 1)' },
    });

    const result = await useCase.executeAuthorizedForgeAction(forgeRequest());

    expect(result).toEqual({ outcome: 'refused', reason: 'gh pr merge failed (exit 1)' });
    expect(journal.entries.map((entry) => entry.status)).toEqual([
      'intent-recorded',
      'refused',
    ]);
  });

  it('enforces single grant consumption through the real authorization adapter', async () => {
    const grants = new Map<string, { expectedHeadSha: string; kind: string; consumedByActionId: string | null }>([
      ['grant-1', { expectedHeadSha: HEAD_SHA, kind: 'merge-pr', consumedByActionId: null }],
    ]);
    const authorization = new ActionAuthorizationAdapter({ grants });
    const { useCase, forgePort, journal, workOrderRepo } = makeDeps({ authorization });

    const first = await useCase.executeAuthorizedForgeAction(forgeRequest());
    const second = await useCase.executeAuthorizedForgeAction(
      forgeRequest({ actionId: 'action-2' }),
    );

    expect(first).toEqual({ outcome: 'executed', headSha: HEAD_SHA });
    expect(second.outcome).toBe('refused');
    expect(second.outcome === 'refused' && second.reason).toContain(
      'Authorization grant already consumed by action action-1',
    );
    expect(forgePort.requests).toHaveLength(1);
    expect(journal.entries.at(-1)?.status).toBe('refused');
    expect(workOrderRepo.saved).toHaveLength(1);
  });
});

describe('AcceptanceAssessmentAdapter', () => {
  it('rejects while unconfigured', async () => {
    const adapter = new AcceptanceAssessmentAdapter();

    await expect(
      adapter.assessHeadAcceptance({
        attemptId: 'attempt-1',
        workOrderId: 'wo-1',
        candidateHeadSha: HEAD_SHA,
        policyRevision: 'policy-7',
      }),
    ).rejects.toThrow('Not implemented: AcceptanceAssessmentAdapter.assessHeadAcceptance');
  });

  it('delegates to the configured assess function', async () => {
    const requests: AcceptanceAssessmentRequest[] = [];
    const adapter = new AcceptanceAssessmentAdapter({
      assess: async (request) => {
        requests.push(request);
        return { outcome: 'accepted', receiptId: 'receipt-9', assessedHeadSha: request.candidateHeadSha };
      },
    });

    const result = await adapter.assessHeadAcceptance({
      attemptId: 'attempt-1',
      workOrderId: 'wo-1',
      candidateHeadSha: HEAD_SHA,
      policyRevision: 'policy-7',
    });

    expect(result).toEqual({
      outcome: 'accepted',
      receiptId: 'receipt-9',
      assessedHeadSha: HEAD_SHA,
    });
    expect(requests).toHaveLength(1);
  });
});

describe('ActionAuthorizationAdapter', () => {
  function makeGrants() {
    return new Map<string, { expectedHeadSha: string; kind: string; consumedByActionId: string | null }>([
      ['grant-1', { expectedHeadSha: HEAD_SHA, kind: 'merge-pr', consumedByActionId: null }],
    ]);
  }

  function resolveRequest(overrides: Partial<ResolveActionAuthorizationRequest> = {}): ResolveActionAuthorizationRequest {
    return {
      actionId: 'action-1',
      projectId: 'project-1',
      workOrderId: 'wo-1',
      attemptId: 'attempt-1',
      actionKind: 'merge-pr',
      expectedHeadSha: HEAD_SHA,
      policyRevision: 'policy-7',
      ...overrides,
    };
  }

  function consumeRequest(overrides: Partial<ConsumeActionAuthorizationRequest> = {}): ConsumeActionAuthorizationRequest {
    return {
      authorizationGrantId: 'grant-1',
      actionId: 'action-1',
      actionKind: 'merge-pr',
      expectedHeadSha: HEAD_SHA,
      attemptId: 'attempt-1',
      ...overrides,
    };
  }

  it('rejects while unconfigured', async () => {
    const adapter = new ActionAuthorizationAdapter();

    await expect(adapter.resolveActionAuthorization(resolveRequest())).rejects.toThrow(
      'Not implemented: ActionAuthorizationAdapter.resolveActionAuthorization',
    );
    await expect(
      adapter.consumeActionAuthorization(consumeRequest()),
    ).rejects.toThrow('Not implemented: ActionAuthorizationAdapter.consumeActionAuthorization');
  });

  it('resolves only an unconsumed grant matching the head and kind', async () => {
    const adapter = new ActionAuthorizationAdapter({ grants: makeGrants() });

    const applicable = await adapter.resolveActionAuthorization(resolveRequest());
    const movedHead = await adapter.resolveActionAuthorization(
      resolveRequest({ expectedHeadSha: OTHER_SHA }),
    );
    const otherKind = await adapter.resolveActionAuthorization(
      resolveRequest({ actionKind: 'push-and-open-pr' }),
    );

    expect(applicable).toEqual({ outcome: 'granted', authorizationGrantId: 'grant-1' });
    expect(movedHead.outcome).toBe('blocked');
    expect(otherKind.outcome).toBe('blocked');
  });

  it('blocks resolution once the grant has been consumed', async () => {
    const grants = makeGrants();
    const adapter = new ActionAuthorizationAdapter({ grants });
    await adapter.consumeActionAuthorization(consumeRequest());

    const result = await adapter.resolveActionAuthorization(resolveRequest());

    expect(result.outcome).toBe('blocked');
  });

  it('consumes a grant exactly once and stays idempotent for the same action', async () => {
    const grants = makeGrants();
    const adapter = new ActionAuthorizationAdapter({ grants });

    const first = await adapter.consumeActionAuthorization(consumeRequest());
    const retry = await adapter.consumeActionAuthorization(consumeRequest());

    expect(first).toEqual({ outcome: 'consumed', actionId: 'action-1' });
    expect(retry).toEqual({ outcome: 'consumed', actionId: 'action-1' });
    expect(grants.get('grant-1')?.consumedByActionId).toBe('action-1');
  });

  it('refuses a second unrelated action and an unknown grant', async () => {
    const adapter = new ActionAuthorizationAdapter({ grants: makeGrants() });
    await adapter.consumeActionAuthorization(consumeRequest());

    const secondAction = await adapter.consumeActionAuthorization(
      consumeRequest({ actionId: 'action-2' }),
    );
    const unknown = await adapter.consumeActionAuthorization(
      consumeRequest({ authorizationGrantId: 'grant-missing' }),
    );

    expect(secondAction).toEqual({
      outcome: 'refused',
      reason: 'Authorization grant already consumed by action action-1',
    });
    expect(unknown).toEqual({
      outcome: 'refused',
      reason: 'Authorization grant not found: grant-missing',
    });
  });

  it('delegates to configured supplier functions when provided', async () => {
    const consumeRequests: ConsumeActionAuthorizationRequest[] = [];
    const adapter = new ActionAuthorizationAdapter({
      resolveGrant: async () => ({ outcome: 'granted', authorizationGrantId: 'grant-2' }),
      consumeGrant: async (request) => {
        consumeRequests.push(request);
        return { outcome: 'consumed', actionId: request.actionId };
      },
    });

    const resolved = await adapter.resolveActionAuthorization(resolveRequest());
    const req = consumeRequest({
      authorizationGrantId: 'grant-2',
      actionId: 'action-9',
    });
    const consumed = await adapter.consumeActionAuthorization(req);

    expect(resolved).toEqual({ outcome: 'granted', authorizationGrantId: 'grant-2' });
    expect(consumed).toEqual({ outcome: 'consumed', actionId: 'action-9' });
    expect(consumeRequests).toEqual([req]);
  });
});

describe('BriefKnowledgeAdapter', () => {
  const proposal: BriefContextProposal = {
    proposalId: 'proposal-1',
    knowledgeEntryId: 'entry-1',
    version: 'v3',
    proposedBecause: 'ranked for the lane path',
  };

  it('rejects while unconfigured', async () => {
    const adapter = new BriefKnowledgeAdapter();

    await expect(
      adapter.requestBriefContextProposals({
        projectId: 'project-1',
        laneId: LANE_ID,
        taskSummary: 'summary',
      }),
    ).rejects.toThrow('Not implemented: BriefKnowledgeAdapter.requestBriefContextProposals');
    await expect(
      adapter.recordContextSelection({ attemptId: 'attempt-1', selections: [] }),
    ).rejects.toThrow('Not implemented: BriefKnowledgeAdapter.recordContextSelection');
    await expect(
      adapter.forwardCompletedAttemptNotes({
        attemptId: 'attempt-1',
        workOrderId: 'wo-1',
        headCommit: HEAD_SHA,
        notes: null,
      }),
    ).rejects.toThrow('Not implemented: BriefKnowledgeAdapter.forwardCompletedAttemptNotes');
  });

  it('delegates proposals, selections and notes to supplier functions', async () => {
    const proposalsRequests: RequestBriefContextProposalsRequest[] = [];
    const selectionRequests: RecordContextSelectionRequest[] = [];
    const notesRequests: ForwardCompletedAttemptNotesRequest[] = [];
    const adapter = new BriefKnowledgeAdapter({
      propose: async (request) => {
        proposalsRequests.push(request);
        return { outcome: 'proposed', proposals: [proposal] };
      },
      recordSelection: async (request) => {
        selectionRequests.push(request);
        return { outcome: 'recorded' };
      },
      forwardNotes: async (request) => {
        notesRequests.push(request);
        return request.notes === null
          ? { outcome: 'refused', reason: 'no notes collected' }
          : { outcome: 'forwarded' };
      },
    });

    const proposed = await adapter.requestBriefContextProposals({
      projectId: 'project-1',
      laneId: LANE_ID,
      taskSummary: 'summary',
    });
    const recorded = await adapter.recordContextSelection({
      attemptId: 'attempt-1',
      selections: [{ proposalId: 'proposal-1', knowledgeEntryId: 'entry-1', version: 'v3', accepted: true }],
    });
    const forwarded = await adapter.forwardCompletedAttemptNotes({
      attemptId: 'attempt-1',
      workOrderId: 'wo-1',
      headCommit: HEAD_SHA,
      notes: 'a bounded note',
    });

    expect(proposed).toEqual({ outcome: 'proposed', proposals: [proposal] });
    expect(recorded).toEqual({ outcome: 'recorded' });
    expect(forwarded).toEqual({ outcome: 'forwarded' });
    expect(proposalsRequests).toHaveLength(1);
    expect(selectionRequests).toHaveLength(1);
    expect(notesRequests).toEqual([
      { attemptId: 'attempt-1', workOrderId: 'wo-1', headCommit: HEAD_SHA, notes: 'a bounded note' },
    ]);
  });

  it('serves an in-memory store when enabled', async () => {
    const adapter = new BriefKnowledgeAdapter({ enableInMemory: true, proposals: [proposal] });

    const proposed = await adapter.requestBriefContextProposals({
      projectId: 'project-1',
      laneId: LANE_ID,
      taskSummary: 'summary',
    });
    const recorded = await adapter.recordContextSelection({
      attemptId: 'attempt-1',
      selections: [],
    });
    const forwarded = await adapter.forwardCompletedAttemptNotes({
      attemptId: 'attempt-1',
      workOrderId: 'wo-1',
      headCommit: HEAD_SHA,
      notes: null,
    });

    expect(proposed).toEqual({ outcome: 'proposed', proposals: [proposal] });
    expect(recorded).toEqual({ outcome: 'recorded' });
    expect(forwarded).toEqual({ outcome: 'forwarded' });
  });
});

describe('ExecutionObservationAdapter', () => {
  function observationRequest(): PublishExecutionObservationRequest {
    return {
      projectId: 'project-1',
      entry: {
        id: 'forge:action-1:intent-recorded:1',
        attemptId: 'attempt-1',
        workOrderId: 'wo-1',
        action: 'forge',
        baseCommit: BASE_COMMIT,
        recordedAtIso: FIXED_NOW,
        status: 'intent-recorded',
        sessionId: null,
        detail: null,
      },
    };
  }

  it('rejects while unconfigured', async () => {
    const adapter = new ExecutionObservationAdapter();

    await expect(adapter.publishExecutionObservation(observationRequest())).rejects.toThrow(
      'Not implemented: ExecutionObservationAdapter.publishExecutionObservation',
    );
  });

  it('publishes through the delegate and records the delivery attempt', async () => {
    const requests: PublishExecutionObservationRequest[] = [];
    const adapter = new ExecutionObservationAdapter({
      publish: async (request) => {
        requests.push(request);
        return { outcome: 'published' };
      },
      recorded: [],
    });

    const result = await adapter.publishExecutionObservation(observationRequest());

    expect(result).toEqual({ outcome: 'published' });
    expect(requests).toHaveLength(1);
  });

  it('turns a throwing transport into a delivery gap instead of failing the lane', async () => {
    const recorded: PublishExecutionObservationRequest[] = [];
    const adapter = new ExecutionObservationAdapter({
      publish: () => Promise.reject(new Error('Waves endpoint unreachable')),
      recorded,
    });

    const result = await adapter.publishExecutionObservation(observationRequest());

    expect(result).toEqual({
      outcome: 'delivery-gap',
      reason: 'Waves endpoint unreachable',
    });
    expect(recorded).toHaveLength(1);
  });

  it('passes a delegate delivery gap through unchanged', async () => {
    const adapter = new ExecutionObservationAdapter({
      publish: async () => ({ outcome: 'delivery-gap', reason: 'relay backlog' }),
    });

    const result = await adapter.publishExecutionObservation(observationRequest());

    expect(result).toEqual({ outcome: 'delivery-gap', reason: 'relay backlog' });
  });

  it('records but reports a delivery gap when only recording is configured', async () => {
    const recorded: PublishExecutionObservationRequest[] = [];
    const adapter = new ExecutionObservationAdapter({ recorded });

    const result = await adapter.publishExecutionObservation(observationRequest());

    expect(result).toEqual({
      outcome: 'delivery-gap',
      reason: 'No observation transport configured',
    });
    expect(recorded).toHaveLength(1);
  });
});

describe('ForgeActionAdapter', () => {
  function forgeActionRequest(
    overrides: Partial<ForgeActionRequest> = {},
  ): ForgeActionRequest {
    return {
      actionId: 'action-1',
      attemptId: 'attempt-1',
      workOrderId: 'wo-1',
      kind: 'push-and-open-pr',
      expectedHeadSha: HEAD_SHA,
      branchName: `feat/${LANE_ID}`,
      ...overrides,
    };
  }

  function makeRunGh(result: { exitCode: number; stdout: string; stderr: string }) {
    const calls: string[][] = [];
    const runGh = async (args: readonly string[]) => {
      calls.push([...args]);
      return result;
    };
    return { calls, runGh };
  }

  it('throws while unconfigured', async () => {
    const adapter = new ForgeActionAdapter();

    await expect(adapter.performForgeAction(forgeActionRequest())).rejects.toThrow(
      'Not implemented: ForgeActionAdapter.performForgeAction',
    );
  });

  it('refuses a moved branch head and never runs gh', async () => {
    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: '', stderr: '' });
    const adapter = new ForgeActionAdapter({
      runGh,
      verifyCurrentHeadSha: async () => OTHER_SHA,
    });

    const result = await adapter.performForgeAction(forgeActionRequest());

    expect(result).toEqual({
      outcome: 'refused',
      reason: `Moved head: branch feat/${LANE_ID} is at ${OTHER_SHA}, expected ${HEAD_SHA}`,
    });
    expect(calls).toHaveLength(0);
  });

  it('treats a failed head verification as ambiguous, not as a refusal', async () => {
    const adapter = new ForgeActionAdapter({
      runGh: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      verifyCurrentHeadSha: () => Promise.reject(new Error('worktree unreadable')),
    });

    const result = await adapter.performForgeAction(forgeActionRequest());

    expect(result.outcome).toBe('ambiguous');
    expect(result.outcome === 'ambiguous' && result.reason).toContain('Could not verify the current head');
  });

  it('creates a pull request with allow-listed arguments and parses its number', async () => {
    const { calls, runGh } = makeRunGh({
      exitCode: 0,
      stdout: 'https://github.com/org/repo/pull/123\n',
      stderr: '',
    });
    const adapter = new ForgeActionAdapter({
      runGh,
      verifyCurrentHeadSha: async () => HEAD_SHA,
    });

    const result = await adapter.performForgeAction(forgeActionRequest());

    expect(result).toEqual({
      outcome: 'executed',
      pullRequestNumber: 123,
      headSha: HEAD_SHA,
    });
    expect(calls[0]?.slice(0, 4)).toEqual(['pr', 'create', '--head', `feat/${LANE_ID}`]);
    expect(calls[0]).toContain('--title');
    expect(calls[0]).toContain('--body');
  });

  it('reports an unparseable create response as ambiguous', async () => {
    const { runGh } = makeRunGh({ exitCode: 0, stdout: 'no url in this output', stderr: '' });
    const adapter = new ForgeActionAdapter({
      runGh,
      verifyCurrentHeadSha: async () => HEAD_SHA,
    });

    const result = await adapter.performForgeAction(forgeActionRequest());

    expect(result.outcome).toBe('ambiguous');
    expect(result.outcome === 'ambiguous' && result.reason).toContain(
      'no pull request number was reported',
    );
  });

  it('refuses a failed create with the command error', async () => {
    const { runGh } = makeRunGh({
      exitCode: 1,
      stdout: '',
      stderr: 'GraphQL: branch protection (organization rules)\n',
    });
    const adapter = new ForgeActionAdapter({
      runGh,
      verifyCurrentHeadSha: async () => HEAD_SHA,
    });

    const result = await adapter.performForgeAction(forgeActionRequest());

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'gh pr create failed (exit 1): GraphQL: branch protection (organization rules)',
    });
  });

  it('treats a crashing create invocation as ambiguous for reconciliation', async () => {
    const adapter = new ForgeActionAdapter({
      runGh: () => Promise.reject(new Error('gh binary missing')),
      verifyCurrentHeadSha: async () => HEAD_SHA,
    });

    const result = await adapter.performForgeAction(forgeActionRequest());

    expect(result).toEqual({
      outcome: 'ambiguous',
      reason: 'gh pr create could not complete: gh binary missing',
    });
  });

  it('merges pinned to the expected head with --match-head-commit', async () => {
    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: '', stderr: '' });
    const adapter = new ForgeActionAdapter({
      runGh,
      verifyCurrentHeadSha: async () => HEAD_SHA,
    });

    const result = await adapter.performForgeAction(forgeActionRequest({ kind: 'merge-pr' }));

    expect(result).toEqual({ outcome: 'executed', headSha: HEAD_SHA });
    expect(calls[0]).toEqual([
      'pr',
      'merge',
      `feat/${LANE_ID}`,
      '--match-head-commit',
      HEAD_SHA,
      '--merge',
    ]);
  });

  it('refuses a failed merge with the command error', async () => {
    const { runGh } = makeRunGh({ exitCode: 1, stdout: '', stderr: 'pull request not mergeable\n' });
    const adapter = new ForgeActionAdapter({
      runGh,
      verifyCurrentHeadSha: async () => HEAD_SHA,
    });

    const result = await adapter.performForgeAction(forgeActionRequest({ kind: 'merge-pr' }));

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'gh pr merge failed (exit 1): pull request not mergeable',
    });
  });

  it('refuses every invocation when verifyCurrentHeadSha is omitted', async () => {
    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: '', stderr: '' });
    const adapter = new ForgeActionAdapter({ runGh });

    const createResult = await adapter.performForgeAction(forgeActionRequest());
    const mergeResult = await adapter.performForgeAction(
      forgeActionRequest({ kind: 'merge-pr' }),
    );

    expect(createResult).toEqual({
      outcome: 'refused',
      reason: 'Cannot perform forge action without verifyCurrentHeadSha',
    });
    expect(mergeResult).toEqual({
      outcome: 'refused',
      reason: 'Cannot perform forge action without verifyCurrentHeadSha',
    });
    expect(calls).toHaveLength(0);
  });

  it('refuses an invalid expected head or branch without running gh', async () => {
    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: '', stderr: '' });
    const adapter = new ForgeActionAdapter({ runGh });

    const badHead = await adapter.performForgeAction(
      forgeActionRequest({ expectedHeadSha: 'not-a-sha' }),
    );
    const badBranch = await adapter.performForgeAction(forgeActionRequest({ branchName: 'bad branch' }));

    expect(badHead).toEqual({ outcome: 'refused', reason: 'Invalid expected head SHA: not-a-sha' });
    expect(badBranch).toEqual({ outcome: 'refused', reason: 'Invalid branch name: bad branch' });
    expect(calls).toHaveLength(0);
  });
});
