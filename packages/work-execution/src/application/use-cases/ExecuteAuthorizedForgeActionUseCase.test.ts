import { describe, expect, it } from 'vitest';
import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  CapacityReservationRecord,
  WorkOrderRecord,
} from '../../domain/execution-records.js';
import type {
  ActionAuthorizationPort,
  ConsumeActionAuthorizationRequest,
  ConsumeActionAuthorizationResult,
} from '../ports/out/ActionAuthorizationPort.out-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type {
  ExecutionJournalPort,
  ReserveCapacityAtomicallyRequest,
} from '../ports/out/ExecutionJournalPort.out-port.js';
import type {
  ForgeActionPort,
  ForgeActionRequest,
  ForgeActionResult,
} from '../ports/out/ForgeActionPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../ports/out/WorkOrderRepositoryPort.out-port.js';
import type {
  AcceptanceEvidencePort,
  ReadAcceptanceRequest,
  ReadAcceptanceResult,
} from '../ports/out/AcceptanceEvidencePort.out-port.js';
import type { AttemptOwnerDecisionPort } from '../ports/out/AttemptOwnerDecisionPort.out-port.js';
import type {
  OwnerDecisionPort,
} from '../ports/out/OwnerDecisionPort.out-port.js';
import { ExecuteAuthorizedForgeActionUseCase } from './ExecuteAuthorizedForgeActionUseCase.use-case.js';

class InMemoryAcceptanceEvidencePort implements AcceptanceEvidencePort {
  constructor(private readonly result: ReadAcceptanceResult) {}

  async readAcceptance(_request: ReadAcceptanceRequest): Promise<ReadAcceptanceResult> {
    return this.result;
  }
}

class InMemoryAttemptRepo implements AttemptRepositoryPort {
  constructor(private attempt: AttemptRecord | null) {}

  async findAttemptById(_id: string): Promise<AttemptRecord | null> {
    return this.attempt;
  }
  async saveAttempt(record: AttemptRecord): Promise<void> {
    this.attempt = record;
  }
  async listAttemptsByWorkOrder(workOrderId: string): Promise<readonly AttemptRecord[]> {
    return this.attempt && this.attempt.workOrderId === workOrderId ? [this.attempt] : [];
  }
  async listAllAttempts(): Promise<readonly AttemptRecord[]> {
    return this.attempt ? [this.attempt] : [];
  }
}

class InMemoryWorkOrderRepo implements WorkOrderRepositoryPort {
  constructor(private workOrder: WorkOrderRecord | null) {}

  async findWorkOrderById(_id: string): Promise<WorkOrderRecord | null> {
    return this.workOrder;
  }
  async saveWorkOrder(record: WorkOrderRecord): Promise<void> {
    this.workOrder = record;
  }
  async listWorkOrdersByProject(projectId?: string): Promise<readonly WorkOrderRecord[]> {
    if (!this.workOrder) return [];
    if (projectId && this.workOrder.projectId !== projectId) return [];
    return [this.workOrder];
  }
}

class InMemoryJournal implements ExecutionJournalPort {
  readonly entries: ActionJournalEntryRecord[] = [];
  private seenIds = new Set<string>();

  async appendJournalEntry(entry: ActionJournalEntryRecord): Promise<void> {
    if (this.seenIds.has(entry.id)) {
      throw new Error(`Duplicate journal entry id: ${entry.id}`);
    }
    this.seenIds.add(entry.id);
    this.entries.push(entry);
  }

  async listJournalEntriesForAttempt(attemptId: string): Promise<readonly ActionJournalEntryRecord[]> {
    return this.entries.filter((e) => e.attemptId === attemptId);
  }

  async saveCapacityReservation(): Promise<void> {}
  async listActiveReservations(): Promise<readonly []> {
    return [];
  }
  async releaseCapacityReservation(): Promise<boolean> {
    return false;
  }
  async reserveCapacityAtomically(request: ReserveCapacityAtomicallyRequest) {
    const reservation: CapacityReservationRecord = { ...request.record!, slotIndex: 0 };
    return { outcome: 'reserved' as const, reservation };
  }
}

function makeAttemptRecord(): AttemptRecord {
  return {
    id: 'att-001',
    ownerDecisionReferences: [],
    workOrderId: 'wo-001',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    state: 'collected',
    outcome: 'done',
    baseCommit: 'base-000',
    worktreePath: '/tmp/worktree',
    briefDigest: 'sha256-brief',
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts: {
      headCommit: '1111111111111111111111111111111111111111',
      commitsSinceBase: ['1111111111111111111111111111111111111111'],
      collectedArtifactPaths: ['/tmp/patch.diff'],
      notes: 'present',
    },
    createdAtIso: '2026-10-15T10:00:00Z',
    updatedAtIso: '2026-10-15T10:30:00Z',
  };
}

/** An attempt-owner-decision port backed by one attempt repository. */
function attemptDoorsFrom(repo: AttemptRepositoryPort): AttemptOwnerDecisionPort {
  return {
    async readAttemptOwnerDecisionReferences({ attemptId }) {
      const record = await repo.findAttemptById(attemptId);
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
  };
}

function makeWorkOrderRecord(): WorkOrderRecord {
  return {
    id: 'wo-001',
    projectId: 'proj-001',
    taskId: 'task-001',
    laneId: 'lane-auth',
    repository: 'github.com/org/repo',
    state: 'approved',
    revision: 1,
    baseCommit: 'base-000',
    ownedPaths: ['src/'],
    policyRevision: 'pol-1',
    prerequisiteWorkOrderIds: [],
    createdAtIso: '2026-10-15T09:00:00Z',
    updatedAtIso: '2026-10-15T10:35:00Z',
  };
}

describe('ExecuteAuthorizedForgeActionUseCase', () => {
  describe('forge mode none (D6)', () => {
    it('refuses every forge action before any grant is consumed, journalled or executed', async () => {
      const journal = new InMemoryJournal();
      const attemptRepo = new InMemoryAttemptRepo(makeAttemptRecord());
      const workOrderRepo = new InMemoryWorkOrderRepo(makeWorkOrderRecord());

      let consumed = false;
      const authorizationPort: ActionAuthorizationPort = {
        async resolveActionAuthorization() {
          return { outcome: 'granted', authorizationGrantId: 'g-1' };
        },
        async consumeActionAuthorization(
          _req: ConsumeActionAuthorizationRequest,
        ): Promise<ConsumeActionAuthorizationResult> {
          consumed = true;
          return { outcome: 'consumed', actionId: _req.actionId };
        },
      };
      const forgePort: ForgeActionPort = {
        isConfigured: () => true,
        async performForgeAction(): Promise<ForgeActionResult> {
          throw new Error('Should never be called');
        },
      };

      const useCase = new ExecuteAuthorizedForgeActionUseCase({
        attemptRepo,
        workOrderRepo,
        journal,
        authorizationPort,
        forgePort,
        forgeMode: 'none',
      });

      const result = await useCase.executeAuthorizedForgeAction({
        actionId: 'forge-att-001',
        attemptId: 'att-001',
        workOrderId: 'wo-001',
        kind: 'push-and-open-pr',
        expectedHeadSha: '1111111111111111111111111111111111111111',
        authorizationGrantId: 'grant-001',
      });

      expect(result.outcome).toBe('refused');
      if (result.outcome === 'refused') {
        expect(result.reason).toContain("Forge mode is 'none'");
      }
      expect(consumed).toBe(false);
      expect(journal.entries).toHaveLength(0);
    });
  });

  describe('M7: journal sequence derivation across use case instances', () => {
    it('two use-case instances on the same journal, the second after a refusal, produce distinct ids and a typed result, no throw', async () => {
      const journal = new InMemoryJournal();
      const attemptRepo = new InMemoryAttemptRepo(makeAttemptRecord());
      const workOrderRepo = new InMemoryWorkOrderRepo(makeWorkOrderRecord());

      let consumeCalls = 0;
      const authorizationPort: ActionAuthorizationPort = {
        async resolveActionAuthorization() {
          return { outcome: 'granted', authorizationGrantId: 'g-1' };
        },
        async consumeActionAuthorization(_req: ConsumeActionAuthorizationRequest): Promise<ConsumeActionAuthorizationResult> {
          consumeCalls++;
          return { outcome: 'refused', reason: 'grant scope does not match' };
        },
      };

      const forgePort: ForgeActionPort = {
        isConfigured: () => true,
        async performForgeAction(_req: ForgeActionRequest): Promise<ForgeActionResult> {
          return { outcome: 'executed', headSha: '1111111111111111111111111111111111111111' };
        },
      };

      const req = {
        actionId: 'forge-att-001',
        attemptId: 'att-001',
        workOrderId: 'wo-001',
        kind: 'merge-pr' as const,
        expectedHeadSha: '1111111111111111111111111111111111111111',
        authorizationGrantId: 'grant-001',
      };

      // Instance 1 runs and is refused by authorization
      const defaultAcceptancePort = new InMemoryAcceptanceEvidencePort({
        outcome: 'found',
        assessment: {
          candidateHeadSha: '1111111111111111111111111111111111111111',
          policyRevision: 'pol-1',
          state: 'accepted',
          acceptanceReceiptId: 'receipt-001',
        },
      });

      const instance1 = new ExecuteAuthorizedForgeActionUseCase({
        attemptRepo,
        attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
        workOrderRepo,
        journal,
        authorizationPort,
        forgePort,
        acceptedReceiptByHead: {
          '1111111111111111111111111111111111111111': 'receipt-001',
        },
        acceptanceEvidencePort: defaultAcceptancePort,
      });
      const result1 = await instance1.executeAuthorizedForgeAction(req);
      expect(result1.outcome).toBe('refused');
      expect(consumeCalls).toBe(1);
      expect(journal.entries).toHaveLength(1);
      expect(journal.entries[0]?.id).toBe('forge:forge-att-001:refused:1');

      // Instance 2 simulates a second process running with a fresh use case instance on the same journal
      const instance2 = new ExecuteAuthorizedForgeActionUseCase({
        attemptRepo,
        attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
        workOrderRepo,
        journal,
        authorizationPort,
        forgePort,
        acceptedReceiptByHead: {
          '1111111111111111111111111111111111111111': 'receipt-001',
        },
        acceptanceEvidencePort: defaultAcceptancePort,
      });
      // This should NOT throw a duplicate key error!
      const result2 = await instance2.executeAuthorizedForgeAction(req);
      expect(result2.outcome).toBe('refused');
      expect(consumeCalls).toBe(2);
      expect(journal.entries).toHaveLength(2);
      expect(journal.entries[1]?.id).toBe('forge:forge-att-001:refused:2');
      expect(journal.entries[0]?.id).not.toBe(journal.entries[1]?.id);
    });
  });

  describe('M10: forge readiness before consumption', () => {
    it('refuses with unavailable and leaves grant unconsumed when forgePort is not configured', async () => {
      const journal = new InMemoryJournal();
      const attemptRepo = new InMemoryAttemptRepo(makeAttemptRecord());
      const workOrderRepo = new InMemoryWorkOrderRepo(makeWorkOrderRecord());

      let consumed = false;
      const authorizationPort: ActionAuthorizationPort = {
        async resolveActionAuthorization() {
          return { outcome: 'granted', authorizationGrantId: 'g-1' };
        },
        async consumeActionAuthorization(_req: ConsumeActionAuthorizationRequest): Promise<ConsumeActionAuthorizationResult> {
          consumed = true;
          return { outcome: 'consumed', actionId: _req.actionId };
        },
      };

      // Unconfigured forge port (e.g. no delegate bound)
      const unconfiguredForgePort: ForgeActionPort = {
        isConfigured: () => false,
        async performForgeAction(): Promise<ForgeActionResult> {
          throw new Error('Should never be called');
        },
      };

      const useCase = new ExecuteAuthorizedForgeActionUseCase({
        attemptRepo,
        attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
        workOrderRepo,
        journal,
        authorizationPort,
        forgePort: unconfiguredForgePort,
        acceptedReceiptByHead: {
          '1111111111111111111111111111111111111111': 'receipt-001',
        },
        acceptanceEvidencePort: new InMemoryAcceptanceEvidencePort({
          outcome: 'found',
          assessment: {
            candidateHeadSha: '1111111111111111111111111111111111111111',
            policyRevision: 'pol-1',
            state: 'accepted',
            acceptanceReceiptId: 'receipt-001',
          },
        }),
      });

      const result = await useCase.executeAuthorizedForgeAction({
        actionId: 'act-1',
        attemptId: 'att-001',
        workOrderId: 'wo-001',
        kind: 'merge-pr',
        expectedHeadSha: '1111111111111111111111111111111111111111',
        authorizationGrantId: 'grant-001',
      });

      expect(result).toEqual({ outcome: 'refused', reason: 'unavailable' });
      expect(consumed).toBe(false);
      expect(journal.entries).toHaveLength(0);
    });
  });

  describe('M12: acceptance evidence verification before merge-pr', () => {
    const validAssessment = {
      candidateHeadSha: '1111111111111111111111111111111111111111',
      policyRevision: 'pol-1',
      state: 'accepted' as const,
      acceptanceReceiptId: 'receipt-001',
    };

    const mergeReq = {
      actionId: 'forge-act-1',
      attemptId: 'att-001',
      workOrderId: 'wo-001',
      kind: 'merge-pr' as const,
      expectedHeadSha: '1111111111111111111111111111111111111111',
      authorizationGrantId: 'grant-001',
    };

    const successfulAuthPort: ActionAuthorizationPort = {
      async resolveActionAuthorization() {
        return { outcome: 'granted', authorizationGrantId: 'grant-001' };
      },
      async consumeActionAuthorization(req) {
        return { outcome: 'consumed', actionId: req.actionId };
      },
    };

    const successfulForgePort: ForgeActionPort = {
      isConfigured: () => true,
      async performForgeAction() {
        return { outcome: 'executed', headSha: '1111111111111111111111111111111111111111' };
      },
    };

    it('stale assessment with a receipt in the map -> merge refused', async () => {
      const journal = new InMemoryJournal();
      const attemptRepo = new InMemoryAttemptRepo(makeAttemptRecord());
      const workOrderRepo = new InMemoryWorkOrderRepo(makeWorkOrderRecord());

      const acceptanceEvidencePort = new InMemoryAcceptanceEvidencePort({
        outcome: 'found',
        assessment: {
          ...validAssessment,
          state: 'stale',
        },
      });

      const useCase = new ExecuteAuthorizedForgeActionUseCase({
        attemptRepo,
        attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
        workOrderRepo,
        journal,
        authorizationPort: successfulAuthPort,
        forgePort: successfulForgePort,
        acceptedReceiptByHead: {
          '1111111111111111111111111111111111111111': 'receipt-001',
        },
        acceptanceEvidencePort,
      });

      const result = await useCase.executeAuthorizedForgeAction(mergeReq);
      expect(result.outcome).toBe('refused');
      expect((result as { reason: string }).reason).toContain('stale');
    });

    it('policy moved -> merge refused', async () => {
      const journal = new InMemoryJournal();
      const attemptRepo = new InMemoryAttemptRepo(makeAttemptRecord());
      const workOrderRepo = new InMemoryWorkOrderRepo(makeWorkOrderRecord()); // has policyRevision: 'pol-1'

      const acceptanceEvidencePort = new InMemoryAcceptanceEvidencePort({
        outcome: 'found',
        assessment: {
          ...validAssessment,
          policyRevision: 'pol-old-0',
        },
      });

      const useCase = new ExecuteAuthorizedForgeActionUseCase({
        attemptRepo,
        attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
        workOrderRepo,
        journal,
        authorizationPort: successfulAuthPort,
        forgePort: successfulForgePort,
        acceptedReceiptByHead: {
          '1111111111111111111111111111111111111111': 'receipt-001',
        },
        acceptanceEvidencePort,
      });

      const result = await useCase.executeAuthorizedForgeAction(mergeReq);
      expect(result.outcome).toBe('refused');
      expect((result as { reason: string }).reason).toContain('policy revision');
    });

    it('blocked assessment -> merge refused', async () => {
      const journal = new InMemoryJournal();
      const attemptRepo = new InMemoryAttemptRepo(makeAttemptRecord());
      const workOrderRepo = new InMemoryWorkOrderRepo(makeWorkOrderRecord());

      const acceptanceEvidencePort = new InMemoryAcceptanceEvidencePort({
        outcome: 'found',
        assessment: {
          ...validAssessment,
          state: 'blocked',
        },
      });

      const useCase = new ExecuteAuthorizedForgeActionUseCase({
        attemptRepo,
        attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
        workOrderRepo,
        journal,
        authorizationPort: successfulAuthPort,
        forgePort: successfulForgePort,
        acceptedReceiptByHead: {
          '1111111111111111111111111111111111111111': 'receipt-001',
        },
        acceptanceEvidencePort,
      });

      const result = await useCase.executeAuthorizedForgeAction(mergeReq);
      expect(result.outcome).toBe('refused');
      expect((result as { reason: string }).reason).toContain('blocked');
    });

    it('missing assessment in evidence context -> merge refused', async () => {
      const journal = new InMemoryJournal();
      const attemptRepo = new InMemoryAttemptRepo(makeAttemptRecord());
      const workOrderRepo = new InMemoryWorkOrderRepo(makeWorkOrderRecord());

      const acceptanceEvidencePort = new InMemoryAcceptanceEvidencePort({
        outcome: 'not-found',
        reason: 'no acceptance assessment recorded for the attempt head',
      });

      const useCase = new ExecuteAuthorizedForgeActionUseCase({
        attemptRepo,
        attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
        workOrderRepo,
        journal,
        authorizationPort: successfulAuthPort,
        forgePort: successfulForgePort,
        acceptedReceiptByHead: {
          '1111111111111111111111111111111111111111': 'receipt-001',
        },
        acceptanceEvidencePort,
      });

      const result = await useCase.executeAuthorizedForgeAction(mergeReq);
      expect(result.outcome).toBe('refused');
      expect((result as { reason: string }).reason).toContain('not found');
    });

    it('assessment head mismatch -> merge refused', async () => {
      const journal = new InMemoryJournal();
      const attemptRepo = new InMemoryAttemptRepo(makeAttemptRecord());
      const workOrderRepo = new InMemoryWorkOrderRepo(makeWorkOrderRecord());

      const acceptanceEvidencePort = new InMemoryAcceptanceEvidencePort({
        outcome: 'found',
        assessment: {
          ...validAssessment,
          candidateHeadSha: '2222222222222222222222222222222222222222',
        },
      });

      const useCase = new ExecuteAuthorizedForgeActionUseCase({
        attemptRepo,
        attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
        workOrderRepo,
        journal,
        authorizationPort: successfulAuthPort,
        forgePort: successfulForgePort,
        acceptedReceiptByHead: {
          '1111111111111111111111111111111111111111': 'receipt-001',
        },
        acceptanceEvidencePort,
      });

      const result = await useCase.executeAuthorizedForgeAction(mergeReq);
      expect(result.outcome).toBe('refused');
      expect((result as { reason: string }).reason).toContain('does not match expectedHeadSha');
    });

    it('null acceptance receipt ID -> merge refused', async () => {
      const journal = new InMemoryJournal();
      const attemptRepo = new InMemoryAttemptRepo(makeAttemptRecord());
      const workOrderRepo = new InMemoryWorkOrderRepo(makeWorkOrderRecord());

      const acceptanceEvidencePort = new InMemoryAcceptanceEvidencePort({
        outcome: 'found',
        assessment: {
          ...validAssessment,
          acceptanceReceiptId: null,
        },
      });

      const useCase = new ExecuteAuthorizedForgeActionUseCase({
        attemptRepo,
        attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
        workOrderRepo,
        journal,
        authorizationPort: successfulAuthPort,
        forgePort: successfulForgePort,
        acceptedReceiptByHead: {
          '1111111111111111111111111111111111111111': 'receipt-001',
        },
        acceptanceEvidencePort,
      });

      const result = await useCase.executeAuthorizedForgeAction(mergeReq);
      expect(result.outcome).toBe('refused');
      expect((result as { reason: string }).reason).toContain('no receipt ID');
    });

    it('an acceptance evidence read that throws -> merge refused, never forged', async () => {
      const journal = new InMemoryJournal();
      const attemptRepo = new InMemoryAttemptRepo(makeAttemptRecord());
      const workOrderRepo = new InMemoryWorkOrderRepo(makeWorkOrderRecord());

      let consumed = false;
      const authorizationPort: ActionAuthorizationPort = {
        async resolveActionAuthorization() {
          return { outcome: 'granted', authorizationGrantId: 'grant-001' };
        },
        async consumeActionAuthorization() {
          consumed = true;
          return { outcome: 'consumed', actionId: 'act-1' };
        },
      };

      let forgeCalls = 0;
      const forgePort: ForgeActionPort = {
        isConfigured: () => true,
        async performForgeAction() {
          forgeCalls += 1;
          return { outcome: 'executed', headSha: '1111111111111111111111111111111111111111' };
        },
      };

      const acceptanceEvidencePort: AcceptanceEvidencePort = {
        async readAcceptance(): Promise<ReadAcceptanceResult> {
          throw new Error('evidence store is unreadable');
        },
      };

      const useCase = new ExecuteAuthorizedForgeActionUseCase({
        attemptRepo,
        attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
        workOrderRepo,
        journal,
        authorizationPort,
        forgePort,
        acceptanceEvidencePort,
      });

      const result = await useCase.executeAuthorizedForgeAction({
        actionId: 'act-1',
        attemptId: 'att-001',
        workOrderId: 'wo-001',
        kind: 'merge-pr',
        expectedHeadSha: '1111111111111111111111111111111111111111',
        authorizationGrantId: 'grant-001',
      });

      expect(result.outcome).toBe('refused');
      expect((result as { reason: string }).reason).toContain(
        'acceptance evidence could not be read: evidence store is unreadable',
      );
      expect(consumed).toBe(false);
      expect(forgeCalls).toBe(0);
      expect(journal.entries).toHaveLength(0);
    });

    it('executes merge when assessment is accepted, head and policy match, and receipt ID exists', async () => {
      const journal = new InMemoryJournal();
      const attemptRepo = new InMemoryAttemptRepo(makeAttemptRecord());
      const workOrderRepo = new InMemoryWorkOrderRepo(makeWorkOrderRecord());

      const acceptanceEvidencePort = new InMemoryAcceptanceEvidencePort({
        outcome: 'found',
        assessment: validAssessment,
      });

      const useCase = new ExecuteAuthorizedForgeActionUseCase({
        attemptRepo,
        attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
        workOrderRepo,
        journal,
        authorizationPort: successfulAuthPort,
        forgePort: successfulForgePort,
        acceptedReceiptByHead: {
          '1111111111111111111111111111111111111111': 'receipt-001',
        },
        acceptanceEvidencePort,
      });

      const result = await useCase.executeAuthorizedForgeAction(mergeReq);
      expect(result.outcome).toBe('executed');
      expect((result as { headSha: string }).headSha).toBe('1111111111111111111111111111111111111111');
      expect(journal.entries).toHaveLength(2); // intent-recorded + completed
    });
  });

  describe('one-way door re-check at forge time', () => {
    const HEAD = '1111111111111111111111111111111111111111';
    const mergeReq = {
      actionId: 'forge-att-001',
      attemptId: 'att-001',
      workOrderId: 'wo-001',
      kind: 'merge-pr' as const,
      expectedHeadSha: HEAD,
      authorizationGrantId: 'grant-001',
    };

    function acceptancePortFound() {
      return new InMemoryAcceptanceEvidencePort({
        outcome: 'found',
        assessment: {
          candidateHeadSha: HEAD,
          policyRevision: 'pol-1',
          state: 'accepted',
          acceptanceReceiptId: 'receipt-001',
        },
      });
    }

    function ownerPortWith(
      result:
        | { outcome: 'approved'; decisionId: string }
        | { outcome: 'not-approved'; reason: string }
        | { outcome: 'unknown'; reason: string },
      calls: { resolve: number },
    ): OwnerDecisionPort {
      return {
        async resolveOwnerDecision() {
          calls.resolve++;
          return result;
        },
      };
    }

    function baseDeps(attempt: AttemptRecord, ownerPort?: OwnerDecisionPort) {
      const authPort: ActionAuthorizationPort = {
        async resolveActionAuthorization() {
          return { outcome: 'granted', authorizationGrantId: 'grant-001' };
        },
        async consumeActionAuthorization(req) {
          return { outcome: 'consumed', actionId: req.actionId };
        },
      };
      const forgePort: ForgeActionPort = {
        isConfigured: () => true,
        async performForgeAction() {
          return { outcome: 'executed', headSha: HEAD };
        },
      };
      const attemptRepo = new InMemoryAttemptRepo(attempt);
      return {
        attemptRepo,
        workOrderRepo: new InMemoryWorkOrderRepo(makeWorkOrderRecord()),
        journal: new InMemoryJournal(),
        authorizationPort: authPort,
        forgePort,
        acceptedReceiptByHead: { [HEAD]: 'receipt-001' },
        acceptanceEvidencePort: acceptancePortFound(),
        attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
        ...(ownerPort !== undefined ? { ownerDecisionPort: ownerPort } : {}),
      };
    }

    function attemptWithDoors(
      doors: readonly string[] | undefined,
    ): AttemptRecord {
      const record = makeAttemptRecord();
      if (doors === undefined) {
        // An attempt recorded before the field existed.
        const { ownerDecisionReferences: _omitted, ...rest } = record;
        void _omitted;
        return rest as AttemptRecord;
      }
      return { ...record, ownerDecisionReferences: doors };
    }

    it('journals an ambiguous outcome and rethrows when the forge call throws', async () => {
      const forgeError = new Error('forge subprocess exploded');
      const deps = baseDeps(attemptWithDoors([]));
      const throwingForgePort: ForgeActionPort = {
        isConfigured: () => true,
        async performForgeAction() {
          throw forgeError;
        },
      };
      const useCase = new ExecuteAuthorizedForgeActionUseCase({ ...deps, forgePort: throwingForgePort });
      await expect(useCase.executeAuthorizedForgeAction(mergeReq)).rejects.toBe(forgeError);
      const statuses = deps.journal.entries.map((entry) => entry.status);
      expect(statuses).toEqual(['intent-recorded', 'ambiguous']);
      const ambiguous = deps.journal.entries[1]!;
      expect(ambiguous.id).toBe('forge:forge-att-001:ambiguous:2');
      expect(ambiguous.detail).toBe('forge subprocess exploded');
      expect(ambiguous).not.toHaveProperty('authorizedBy');
    });

    it('the ambiguous entry carries authorizedBy when the request names it', async () => {
      const forgeError = new Error('forge subprocess exploded');
      const deps = baseDeps(attemptWithDoors([]));
      const throwingForgePort: ForgeActionPort = {
        isConfigured: () => true,
        async performForgeAction() {
          throw forgeError;
        },
      };
      const useCase = new ExecuteAuthorizedForgeActionUseCase({ ...deps, forgePort: throwingForgePort });
      await expect(
        useCase.executeAuthorizedForgeAction({ ...mergeReq, authorizedBy: 'policy:autoMerge@0123456789ab' }),
      ).rejects.toBe(forgeError);
      const ambiguous = deps.journal.entries[1]!;
      expect(ambiguous.status).toBe('ambiguous');
      expect(ambiguous.authorizedBy).toBe('policy:autoMerge@0123456789ab');
    });

    it('rethrows the original forge error even when the ambiguous journal append throws', async () => {
      const forgeError = new Error('forge subprocess exploded');
      const deps = baseDeps(attemptWithDoors([]));
      const throwingForgePort: ForgeActionPort = {
        isConfigured: () => true,
        async performForgeAction() {
          throw forgeError;
        },
      };
      const journal = deps.journal as InMemoryJournal;
      const baseAppend = journal.appendJournalEntry.bind(journal);
      journal.appendJournalEntry = async (entry) => {
        if (entry.status === 'ambiguous') {
          throw new Error('journal unavailable');
        }
        await baseAppend(entry);
      };
      const useCase = new ExecuteAuthorizedForgeActionUseCase({ ...deps, journal, forgePort: throwingForgePort });
      await expect(useCase.executeAuthorizedForgeAction(mergeReq)).rejects.toBe(forgeError);
      expect(deps.journal.entries.map((entry) => entry.status)).toEqual(['intent-recorded']);
    });

    it('an approved door does not block the merge', async () => {
      const calls = { resolve: 0 };
      const useCase = new ExecuteAuthorizedForgeActionUseCase(
        baseDeps(attemptWithDoors(['req-door-1']), ownerPortWith({ outcome: 'approved', decisionId: 'req-door-1' }, calls)),
      );      const result = await useCase.executeAuthorizedForgeAction(mergeReq);
      expect(result.outcome).toBe('executed');
      expect(calls.resolve).toBe(1);
    });

    it('an undecided or declined door refuses before the grant is consumed', async () => {
      for (const decision of [
        { outcome: 'not-approved' as const, reason: 'awaiting decision' },
        { outcome: 'unknown' as const, reason: 'no recorded decision' },
      ]) {
        const calls = { resolve: 0 };
        const consumed: { value: boolean } = { value: false };
        const authPort: ActionAuthorizationPort = {
          async resolveActionAuthorization() {
            return { outcome: 'granted', authorizationGrantId: 'grant-001' };
          },
          async consumeActionAuthorization(req) {
            consumed.value = true;
            return { outcome: 'consumed', actionId: req.actionId };
          },
        };
        const deps = {
          ...baseDeps(attemptWithDoors(['req-door-open']), ownerPortWith(decision, calls)),
          authorizationPort: authPort,
        };
        const useCase = new ExecuteAuthorizedForgeActionUseCase(deps);
        const result = await useCase.executeAuthorizedForgeAction(mergeReq);
        expect(result.outcome).toBe('refused');
        expect((result as { reason: string }).reason).toContain(
          `'req-door-open' is ${decision.outcome === 'not-approved' ? 'not approved' : 'unknown'}`,
        );
        expect(consumed.value).toBe(false);
        expect(calls.resolve).toBe(1);
      }
    });

    it('an attempt recorded before doors were frozen refuses without resolving anything', async () => {
      const calls = { resolve: 0 };
      const useCase = new ExecuteAuthorizedForgeActionUseCase(
        baseDeps(attemptWithDoors(undefined), ownerPortWith({ outcome: 'approved', decisionId: 'x' }, calls)),
      );
      const result = await useCase.executeAuthorizedForgeAction(mergeReq);
      expect(result.outcome).toBe('refused');
      expect((result as { reason: string }).reason).toContain('are unknown');
      expect(calls.resolve).toBe(0);
    });

    it('recorded doors with no owner decision port refuse', async () => {
      const useCase = new ExecuteAuthorizedForgeActionUseCase(
        baseDeps(attemptWithDoors(['req-door-1'])),
      );
      const result = await useCase.executeAuthorizedForgeAction(mergeReq);
      expect(result.outcome).toBe('refused');
      expect((result as { reason: string }).reason).toContain('no owner decision port is configured');
    });

    it('an empty door list does not require the port and executes', async () => {
      const useCase = new ExecuteAuthorizedForgeActionUseCase(
        baseDeps(attemptWithDoors([])),
      );
      const result = await useCase.executeAuthorizedForgeAction(mergeReq);
      expect(result.outcome).toBe('executed');
    });
  });

  describe('PR title and body forwarding (K6-2)', () => {
    const HEAD = '1111111111111111111111111111111111111111';

    function capturingDeps() {
      const seen: Array<Record<string, unknown>> = [];
      const journal = new InMemoryJournal();
      const attemptRepo = new InMemoryAttemptRepo(makeAttemptRecord());
      const workOrderRepo = new InMemoryWorkOrderRepo(makeWorkOrderRecord());
      const authorizationPort: ActionAuthorizationPort = {
        async resolveActionAuthorization() {
          return { outcome: 'granted', authorizationGrantId: 'grant-001' };
        },
        async consumeActionAuthorization(req) {
          return { outcome: 'consumed', actionId: req.actionId };
        },
      };
      const forgePort: ForgeActionPort = {
        isConfigured: () => true,
        async performForgeAction(request: ForgeActionRequest): Promise<ForgeActionResult> {
          seen.push({ ...request });
          return { outcome: 'executed', pullRequestNumber: 42, headSha: request.expectedHeadSha };
        },
      };
      const useCase = new ExecuteAuthorizedForgeActionUseCase({
        attemptRepo,
        attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
        workOrderRepo,
        journal,
        authorizationPort,
        forgePort,
        acceptanceEvidencePort: new InMemoryAcceptanceEvidencePort({
          outcome: 'found',
          assessment: {
            candidateHeadSha: HEAD,
            policyRevision: 'pol-1',
            state: 'accepted',
            acceptanceReceiptId: 'receipt-001',
          },
        }),
      });
      return { useCase, seen };
    }

    it('forwards title and body to the forge only for push-and-open-pr', async () => {
      const { useCase, seen } = capturingDeps();

      const result = await useCase.executeAuthorizedForgeAction({
        actionId: 'act-open',
        attemptId: 'att-001',
        workOrderId: 'wo-001',
        kind: 'push-and-open-pr',
        expectedHeadSha: HEAD,
        authorizationGrantId: 'grant-001',
        title: 'My PR title',
        body: 'My PR body\nwith a second line',
      });

      expect(result.outcome).toBe('executed');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        kind: 'push-and-open-pr',
        title: 'My PR title',
        body: 'My PR body\nwith a second line',
      });
    });

    it('omits title and body for push-to-pr even when the request carries them', async () => {
      const { useCase, seen } = capturingDeps();

      const result = await useCase.executeAuthorizedForgeAction({
        actionId: 'act-push',
        attemptId: 'att-001',
        workOrderId: 'wo-001',
        kind: 'push-to-pr',
        expectedHeadSha: HEAD,
        authorizationGrantId: 'grant-001',
        title: 'should not forward',
        body: 'should not forward',
      });

      expect(result.outcome).toBe('executed');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ kind: 'push-to-pr' });
      expect(seen[0]).not.toHaveProperty('title');
      expect(seen[0]).not.toHaveProperty('body');
    });

    it('omits title and body for merge-pr', async () => {
      const { useCase, seen } = capturingDeps();

      const result = await useCase.executeAuthorizedForgeAction({
        actionId: 'act-merge',
        attemptId: 'att-001',
        workOrderId: 'wo-001',
        kind: 'merge-pr',
        expectedHeadSha: HEAD,
        authorizationGrantId: 'grant-001',
        title: 'should not forward',
        body: 'should not forward',
      });

      expect(result.outcome).toBe('executed');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ kind: 'merge-pr' });
      expect(seen[0]).not.toHaveProperty('title');
      expect(seen[0]).not.toHaveProperty('body');
    });

    it('forwards neither title nor body when the push-and-open-pr request omits them', async () => {
      const { useCase, seen } = capturingDeps();

      const result = await useCase.executeAuthorizedForgeAction({
        actionId: 'act-open-2',
        attemptId: 'att-001',
        workOrderId: 'wo-001',
        kind: 'push-and-open-pr',
        expectedHeadSha: HEAD,
        authorizationGrantId: 'grant-001',
      });

      expect(result.outcome).toBe('executed');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ kind: 'push-and-open-pr' });
      expect(seen[0]).not.toHaveProperty('title');
      expect(seen[0]).not.toHaveProperty('body');
    });
  });

  describe('recorded branch name on forge requests (KF-5b)', () => {
    const HEAD = '1111111111111111111111111111111111111111';

    function capturingDeps() {
      const seen: Array<Record<string, unknown>> = [];
      const journal = new InMemoryJournal();
      const attemptRepo = new InMemoryAttemptRepo(makeAttemptRecord());
      const workOrderRepo = new InMemoryWorkOrderRepo(makeWorkOrderRecord());
      const authorizationPort: ActionAuthorizationPort = {
        async resolveActionAuthorization() {
          return { outcome: 'granted', authorizationGrantId: 'grant-001' };
        },
        async consumeActionAuthorization(req) {
          return { outcome: 'consumed', actionId: req.actionId };
        },
      };
      const forgePort: ForgeActionPort = {
        isConfigured: () => true,
        async performForgeAction(request: ForgeActionRequest): Promise<ForgeActionResult> {
          seen.push({ ...request });
          return { outcome: 'executed', pullRequestNumber: 42, headSha: request.expectedHeadSha };
        },
      };
      const useCase = new ExecuteAuthorizedForgeActionUseCase({
        attemptRepo,
        attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
        workOrderRepo,
        journal,
        authorizationPort,
        forgePort,
        acceptanceEvidencePort: new InMemoryAcceptanceEvidencePort({
          outcome: 'found',
          assessment: {
            candidateHeadSha: HEAD,
            policyRevision: 'pol-1',
            state: 'accepted',
            acceptanceReceiptId: 'receipt-001',
          },
        }),
      });
      return { useCase, seen, journal };
    }

    it('defaults to feat/<laneId> when the request carries no branch name', async () => {
      const { useCase, seen } = capturingDeps();

      const result = await useCase.executeAuthorizedForgeAction({
        actionId: 'act-open',
        attemptId: 'att-001',
        workOrderId: 'wo-001',
        kind: 'push-and-open-pr',
        expectedHeadSha: HEAD,
        authorizationGrantId: 'grant-001',
      });

      expect(result.outcome).toBe('executed');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ kind: 'push-and-open-pr', branchName: 'feat/lane-auth' });
    });

    it("forwards the run's recorded branch when the request carries one", async () => {
      const { useCase, seen } = capturingDeps();

      const result = await useCase.executeAuthorizedForgeAction({
        actionId: 'act-open',
        attemptId: 'att-001',
        workOrderId: 'wo-001',
        kind: 'push-and-open-pr',
        expectedHeadSha: HEAD,
        authorizationGrantId: 'grant-001',
        branchName: 'fleet/run-01JB0000000000000000000000',
      });

      expect(result.outcome).toBe('executed');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ branchName: 'fleet/run-01JB0000000000000000000000' });
    });

    it('refuses an unsafe branch name before any grant is consumed or forge call runs', async () => {
      for (const branchName of ['bad branch', '12345', 'a..b']) {
        const journal = new InMemoryJournal();
        const attemptRepo = new InMemoryAttemptRepo(makeAttemptRecord());
        const workOrderRepo = new InMemoryWorkOrderRepo(makeWorkOrderRecord());
        let consumed = false;
        let forgeCalls = 0;
        const authorizationPort: ActionAuthorizationPort = {
          async resolveActionAuthorization() {
            return { outcome: 'granted', authorizationGrantId: 'grant-001' };
          },
          async consumeActionAuthorization(req) {
            consumed = true;
            return { outcome: 'consumed', actionId: req.actionId };
          },
        };
        const forgePort: ForgeActionPort = {
          isConfigured: () => true,
          async performForgeAction(): Promise<ForgeActionResult> {
            forgeCalls += 1;
            return { outcome: 'executed', headSha: HEAD };
          },
        };
        const useCase = new ExecuteAuthorizedForgeActionUseCase({
          attemptRepo,
          attemptOwnerDecisionPort: attemptDoorsFrom(attemptRepo),
          workOrderRepo,
          journal,
          authorizationPort,
          forgePort,
          acceptanceEvidencePort: new InMemoryAcceptanceEvidencePort({
            outcome: 'found',
            assessment: {
              candidateHeadSha: HEAD,
              policyRevision: 'pol-1',
              state: 'accepted',
              acceptanceReceiptId: 'receipt-001',
            },
          }),
        });

        const result = await useCase.executeAuthorizedForgeAction({
          actionId: 'act-1',
          attemptId: 'att-001',
          workOrderId: 'wo-001',
          kind: 'merge-pr',
          expectedHeadSha: HEAD,
          authorizationGrantId: 'grant-001',
          branchName,
        });

        expect(result).toEqual({ outcome: 'refused', reason: 'branchName must be a safe branch name' });
        expect(consumed).toBe(false);
        expect(forgeCalls).toBe(0);
        expect(journal.entries).toHaveLength(0);
      }
    });
  });
});
