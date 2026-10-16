import { describe, expect, it } from 'vitest';
import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  WorkOrderRecord,
} from '../../domain/execution-records.js';
import type {
  ActionAuthorizationPort,
  ConsumeActionAuthorizationRequest,
  ConsumeActionAuthorizationResult,
} from '../ports/out/ActionAuthorizationPort.out-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';
import type {
  ForgeActionPort,
  ForgeActionRequest,
  ForgeActionResult,
} from '../ports/out/ForgeActionPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../ports/out/WorkOrderRepositoryPort.out-port.js';
import { ExecuteAuthorizedForgeActionUseCase } from './ExecuteAuthorizedForgeActionUseCase.use-case.js';

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
}

function makeAttemptRecord(): AttemptRecord {
  return {
    id: 'att-001',
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
      const instance1 = new ExecuteAuthorizedForgeActionUseCase({
        attemptRepo,
        workOrderRepo,
        journal,
        authorizationPort,
        forgePort,
        acceptedReceiptByHead: {
          '1111111111111111111111111111111111111111': 'receipt-001',
        },
      });
      const result1 = await instance1.executeAuthorizedForgeAction(req);
      expect(result1.outcome).toBe('refused');
      expect(consumeCalls).toBe(1);
      expect(journal.entries).toHaveLength(1);
      expect(journal.entries[0]?.id).toBe('forge:forge-att-001:refused:1');

      // Instance 2 simulates a second process running with a fresh use case instance on the same journal
      const instance2 = new ExecuteAuthorizedForgeActionUseCase({
        attemptRepo,
        workOrderRepo,
        journal,
        authorizationPort,
        forgePort,
        acceptedReceiptByHead: {
          '1111111111111111111111111111111111111111': 'receipt-001',
        },
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
        workOrderRepo,
        journal,
        authorizationPort,
        forgePort: unconfiguredForgePort,
        acceptedReceiptByHead: {
          '1111111111111111111111111111111111111111': 'receipt-001',
        },
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
});
