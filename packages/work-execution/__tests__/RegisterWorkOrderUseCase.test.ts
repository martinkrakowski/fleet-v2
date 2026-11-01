import { describe, expect, it } from 'vitest';
import type { WorkOrderRecord } from '../src/domain/execution-records.js';
import type { WorkOrderRepositoryPort } from '../src/application/ports/out/WorkOrderRepositoryPort.out-port.js';
import { RegisterWorkOrderUseCase } from '../src/application/use-cases/RegisterWorkOrderUseCase.use-case.js';

class InMemoryWorkOrderRepo implements WorkOrderRepositoryPort {
  private workOrders = new Map<string, WorkOrderRecord>();

  async saveWorkOrder(record: WorkOrderRecord): Promise<void> {
    this.workOrders.set(record.id, record);
  }

  async findWorkOrderById(workOrderId: string): Promise<WorkOrderRecord | null> {
    return this.workOrders.get(workOrderId) ?? null;
  }

  async listWorkOrdersByProject(projectId?: string): Promise<readonly WorkOrderRecord[]> {
    const all = Array.from(this.workOrders.values());
    if (projectId) {
      return all.filter((w) => w.projectId === projectId);
    }
    return all;
  }
}

function makeWorkOrderRecord(overrides?: Partial<WorkOrderRecord>): WorkOrderRecord {
  return {
    id: 'wo-001',
    projectId: 'proj-alpha',
    taskId: 'task-001',
    laneId: 'lane-001',
    repository: 'github.com/org/repo',
    baseCommit: '0000000000000000000000000000000000000000',
    ownedPaths: ['src/a/'],
    policyRevision: 'pol-1',
    prerequisiteWorkOrderIds: [],
    state: 'approved',
    revision: 1,
    createdAtIso: '2026-10-15T10:00:00Z',
    updatedAtIso: '2026-10-15T10:00:00Z',
    ...overrides,
  };
}

describe('RegisterWorkOrderUseCase (Appendix A)', () => {
  it('registers a work order successfully with unique id', async () => {
    const repo = new InMemoryWorkOrderRepo();
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo });

    const result = await useCase.registerWorkOrder({
      workOrderId: 'wo-unique-1',
      projectId: 'proj-alpha',
      taskId: 'task-1',
      laneId: 'lane-1',
      repository: 'github.com/org/repo',
      baseCommit: '0000000000000000000000000000000000000000',
      ownedPaths: ['src/feature/'],
      policyRevision: 'pol-1',
    });

    expect(result.outcome).toBe('registered');
    const stored = await repo.findWorkOrderById('wo-unique-1');
    expect(stored).not.toBeNull();
    expect(stored?.id).toBe('wo-unique-1');
  });

  it('refuses duplicate id in the same project', async () => {
    const repo = new InMemoryWorkOrderRepo();
    await repo.saveWorkOrder(makeWorkOrderRecord({ id: 'wo-dup-1', projectId: 'proj-alpha' }));

    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo });

    const result = await useCase.registerWorkOrder({
      workOrderId: 'wo-dup-1',
      projectId: 'proj-alpha',
      taskId: 'task-2',
      laneId: 'lane-2',
      repository: 'github.com/org/repo',
      baseCommit: '0000000000000000000000000000000000000000',
      ownedPaths: ['src/feature-2/'],
      policyRevision: 'pol-1',
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain('Work order already registered: wo-dup-1');
    }
  });

  it('refuses duplicate id across different projects', async () => {
    const repo = new InMemoryWorkOrderRepo();
    // Register under proj-alpha
    await repo.saveWorkOrder(makeWorkOrderRecord({ id: 'wo-dup-cross', projectId: 'proj-alpha' }));

    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo });

    // Try to register the same workOrderId under proj-beta
    const result = await useCase.registerWorkOrder({
      workOrderId: 'wo-dup-cross',
      projectId: 'proj-beta',
      taskId: 'task-beta',
      laneId: 'lane-beta',
      repository: 'github.com/org/repo',
      baseCommit: '0000000000000000000000000000000000000000',
      ownedPaths: ['src/beta/'],
      policyRevision: 'pol-1',
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain('Work order already registered: wo-dup-cross');
    }
  });
});

describe('RegisterWorkOrderUseCase baseBranch (CB1)', () => {
  function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      workOrderId: 'wo-base-branch-1',
      projectId: 'proj-alpha',
      taskId: 'task-1',
      laneId: 'lane-1',
      repository: 'github.com/org/repo',
      baseCommit: '0000000000000000000000000000000000000000',
      ownedPaths: ['src/a/'],
      policyRevision: 'pol-1',
      ...overrides,
    };
  }

  it('stores main when the payload omits baseBranch', async () => {
    const repo = new InMemoryWorkOrderRepo();
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo });
    const result = await useCase.registerWorkOrder(request() as never);
    expect(result.outcome).toBe('registered');
    const stored = await repo.findWorkOrderById('wo-base-branch-1');
    expect(stored?.baseBranch).toBe('main');
  });

  it('stores a parsed chain base branch', async () => {
    const repo = new InMemoryWorkOrderRepo();
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo });
    const result = await useCase.registerWorkOrder(request({ baseBranch: 'chain/example' }) as never);
    expect(result.outcome).toBe('registered');
    const stored = await repo.findWorkOrderById('wo-base-branch-1');
    expect(stored?.baseBranch).toBe('chain/example');
  });

  it('refuses an unparsable base branch with the reason code and registers nothing', async () => {
    const repo = new InMemoryWorkOrderRepo();
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo });
    const result = await useCase.registerWorkOrder(request({ baseBranch: 'release' }) as never);
    expect(result).toEqual({ outcome: 'rejected', reason: 'invalid-base-branch' });
    expect(await repo.findWorkOrderById('wo-base-branch-1')).toBeNull();
  });
});
