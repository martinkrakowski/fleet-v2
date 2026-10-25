// ListUnregisteredProjectsUseCase tests (P3d): adopt candidates from work orders.
// Covers: only unprofiled projects are listed (active and retired profiles
// excluded) sorted by projectId, id trimming and empty-id skipping, work-order
// and active counts, distinct sorted repositories, latest base commit with
// id tie-break, ownedPaths cap at 50, single reads of both ports, propagating
// port errors, the unconfigured throw, and non-plain input refusal.

import { describe, expect, it } from 'vitest';

import { ListUnregisteredProjectsUseCase } from '../ListUnregisteredProjectsUseCase.use-case.js';
import type { WorkOrderRepositoryPort } from '../../ports/out/WorkOrderRepositoryPort.out-port.js';
import type {
  ProjectProfileReadPort,
  ProjectProfileView,
} from '../../ports/out/ProjectProfileReadPort.out-port.js';
import type { WorkOrderRecord } from '../../../domain/execution-records.js';

function makeWorkOrder(overrides: Partial<WorkOrderRecord> = {}): WorkOrderRecord {
  return {
    id: 'wo-1',
    projectId: 'proj-a',
    taskId: 'task-1',
    laneId: 'lane-1',
    repository: 'acme/repo',
    baseCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ownedPaths: ['src/a'],
    policyRevision: 'policy-1',
    prerequisiteWorkOrderIds: [],
    state: 'approved',
    revision: 1,
    createdAtIso: '2026-10-01T08:00:00.000Z',
    updatedAtIso: '2026-10-01T08:00:00.000Z',
    ...overrides,
  };
}

function makeProfile(overrides: Partial<ProjectProfileView> = {}): ProjectProfileView {
  return {
    projectId: 'proj-a',
    status: 'active',
    repository: 'acme/repo',
    clones: { here: { path: '/srv/clone', worktreeRoot: '/srv/worktree' } },
    gateProcedures: ['verify-head'],
    revision: 1,
    ...overrides,
  };
}

class RecordingWorkOrderRepository implements WorkOrderRepositoryPort {
  listCalls = 0;
  saveCalls = 0;

  constructor(private readonly workOrders: readonly WorkOrderRecord[]) {}

  async saveWorkOrder(): Promise<void> {
    this.saveCalls += 1;
  }

  async findWorkOrderById(workOrderId: string): Promise<WorkOrderRecord | null> {
    return this.workOrders.find((workOrder) => workOrder.id === workOrderId) ?? null;
  }

  async listWorkOrdersByProject(): Promise<readonly WorkOrderRecord[]> {
    this.listCalls += 1;
    return this.workOrders;
  }
}

class RecordingProfileRead implements ProjectProfileReadPort {
  calls: string[] = [];

  constructor(private readonly profiles: ReadonlyMap<string, ProjectProfileView>) {}

  async readProjectProfile(projectId: string): Promise<ProjectProfileView | null> {
    this.calls.push(projectId);
    return this.profiles.get(projectId) ?? null;
  }
}

function makeUseCase(options: {
  workOrders?: readonly WorkOrderRecord[];
  profiles?: readonly [string, ProjectProfileView][];
} = {}) {
  const workOrderRepo = new RecordingWorkOrderRepository(options.workOrders ?? []);
  const profileRead = new RecordingProfileRead(new Map(options.profiles ?? []));
  const useCase = new ListUnregisteredProjectsUseCase({ workOrderRepo, profileRead });
  return { useCase, workOrderRepo, profileRead };
}

function expectListed(useCase: ListUnregisteredProjectsUseCase) {
  return useCase.execute({}).then((result) => {
    if (result.outcome !== 'listed') {
      throw new Error(`expected listed, got ${result.outcome}`);
    }
    return result;
  });
}

describe('ListUnregisteredProjectsUseCase', () => {
  it('lists only projects without a profile, excluding active and retired, sorted by projectId', async () => {
    const { useCase } = makeUseCase({
      workOrders: [
        makeWorkOrder({ id: 'wo-1', projectId: 'zeta' }),
        makeWorkOrder({ id: 'wo-2', projectId: 'alpha' }),
        makeWorkOrder({ id: 'wo-3', projectId: 'active-proj' }),
        makeWorkOrder({ id: 'wo-4', projectId: 'retired-proj' }),
      ],
      profiles: [
        ['active-proj', makeProfile()],
        ['retired-proj', makeProfile({ status: 'retired' })],
      ],
    });

    const result = await expectListed(useCase);
    expect(result.projects.map((project) => project.projectId)).toEqual(['alpha', 'zeta']);
  });

  it('groups work orders by trimmed projectId and skips empty ids', async () => {
    const { useCase, profileRead } = makeUseCase({
      workOrders: [
        makeWorkOrder({ id: 'wo-1', projectId: '  p1 ' }),
        makeWorkOrder({ id: 'wo-2', projectId: 'p1' }),
        makeWorkOrder({ id: 'wo-3', projectId: '   ' }),
      ],
    });

    const result = await expectListed(useCase);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]).toMatchObject({ projectId: 'p1', workOrderCount: 2 });
    expect(profileRead.calls).toEqual(['p1']);
  });

  it('counts work orders and active work orders using the active-state rule', async () => {
    const { useCase } = makeUseCase({
      workOrders: [
        makeWorkOrder({ id: 'wo-1', state: 'approved' }),
        makeWorkOrder({ id: 'wo-2', state: 'implementing' }),
        makeWorkOrder({ id: 'wo-3', state: 'merged' }),
        makeWorkOrder({ id: 'wo-4', state: 'stopped' }),
        makeWorkOrder({ id: 'wo-5', state: 'ready-to-merge' }),
      ],
    });

    const result = await expectListed(useCase);
    expect(result.projects[0]).toMatchObject({
      workOrderCount: 5,
      activeWorkOrderCount: 3,
    });
  });

  it('collects distinct trimmed repositories sorted', async () => {
    const { useCase } = makeUseCase({
      workOrders: [
        makeWorkOrder({ id: 'wo-1', repository: '  zeta/repo ' }),
        makeWorkOrder({ id: 'wo-2', repository: 'alpha/repo' }),
        makeWorkOrder({ id: 'wo-3', repository: 'zeta/repo' }),
        makeWorkOrder({ id: 'wo-4', repository: 'alpha/repo' }),
      ],
    });

    const result = await expectListed(useCase);
    expect(result.projects[0].repositories).toEqual(['alpha/repo', 'zeta/repo']);
  });

  it('uses the base commit of the newest work order, breaking ties by greatest id', async () => {
    const { useCase } = makeUseCase({
      workOrders: [
        makeWorkOrder({
          id: 'wo-a',
          baseCommit: 'aaaa',
          updatedAtIso: '2026-10-01T00:00:00.000Z',
        }),
        makeWorkOrder({
          id: 'wo-b',
          baseCommit: 'bbbb',
          updatedAtIso: '2026-10-02T00:00:00.000Z',
        }),
        makeWorkOrder({
          id: 'wo-c',
          baseCommit: 'cccc',
          updatedAtIso: '2026-10-02T00:00:00.000Z',
        }),
      ],
    });

    const result = await expectListed(useCase);
    expect(result.projects[0]).toMatchObject({
      latestBaseCommit: 'cccc',
      lastUpdatedAtIso: '2026-10-02T00:00:00.000Z',
    });
  });

  it('caps owned paths at 50 distinct sorted values', async () => {
    const ownedPaths = Array.from(
      { length: 60 },
      (_, index) => `path-${String(index).padStart(2, '0')}`,
    );
    const { useCase } = makeUseCase({
      workOrders: [makeWorkOrder({ ownedPaths })],
    });

    const result = await expectListed(useCase);
    expect(result.projects[0].ownedPaths).toHaveLength(50);
    expect(result.projects[0].ownedPaths[0]).toBe('path-00');
    expect(result.projects[0].ownedPaths[49]).toBe('path-49');
  });

  it('reads listWorkOrdersByProject once and readProjectProfile once per candidate project', async () => {
    const { useCase, workOrderRepo, profileRead } = makeUseCase({
      workOrders: [
        makeWorkOrder({ id: 'wo-1', projectId: 'p1' }),
        makeWorkOrder({ id: 'wo-2', projectId: 'p1' }),
        makeWorkOrder({ id: 'wo-3', projectId: 'p2' }),
      ],
      profiles: [['p2', makeProfile()]],
    });

    await expectListed(useCase);
    expect(workOrderRepo.listCalls).toBe(1);
    expect(workOrderRepo.saveCalls).toBe(0);
    expect(profileRead.calls).toEqual(['p1', 'p2']);
  });

  it('propagates a profile read error instead of returning it', async () => {
    const profileRead: ProjectProfileReadPort = {
      readProjectProfile: async () => {
        throw new Error('read exploded');
      },
    };
    const workOrderRepo = new RecordingWorkOrderRepository([makeWorkOrder()]);
    const useCase = new ListUnregisteredProjectsUseCase({ workOrderRepo, profileRead });

    await expect(useCase.execute({})).rejects.toThrow('read exploded');
  });

  it('propagates a work order repository error instead of returning it', async () => {
    const workOrderRepo: WorkOrderRepositoryPort = {
      saveWorkOrder: async () => {
        throw new Error('never called');
      },
      findWorkOrderById: async () => null,
      listWorkOrdersByProject: async () => {
        throw new Error('list exploded');
      },
    };
    const profileRead = new RecordingProfileRead(new Map());
    const useCase = new ListUnregisteredProjectsUseCase({ workOrderRepo, profileRead });

    await expect(useCase.execute({})).rejects.toThrow('list exploded');
  });

  it('throws Not implemented when constructed without dependencies', async () => {
    const useCase = new ListUnregisteredProjectsUseCase();
    await expect(useCase.execute({})).rejects.toThrow(
      /^Not implemented: ListUnregisteredProjectsUseCase$/,
    );
  });

  it('refuses a non-plain object input', async () => {
    const { useCase } = makeUseCase();
    await expect(useCase.execute([])).rejects.toThrow('request must be an object');
    await expect(useCase.execute('x')).rejects.toThrow('request must be an object');
    await expect(useCase.execute(new Date())).rejects.toThrow('request must be an object');
  });

  it('accepts a plain empty object and a null-prototype object', async () => {
    const { useCase } = makeUseCase({
      workOrders: [makeWorkOrder({ projectId: 'p1' })],
    });

    const fromEmpty = await expectListed(useCase);
    expect(fromEmpty.projects).toHaveLength(1);

    const fromNullPrototype = await useCase.execute(Object.create(null));
    if (fromNullPrototype.outcome !== 'listed') {
      throw new Error(`expected listed, got ${fromNullPrototype.outcome}`);
    }
    expect(fromNullPrototype.projects).toHaveLength(1);
  });

  it('treats an omitted argument as an empty request', async () => {
    const workOrderRepo = { listWorkOrdersByProject: async () => [] } as never;
    const profileRead = { readProjectProfile: async () => null } as never;
    const useCase = new ListUnregisteredProjectsUseCase({ workOrderRepo, profileRead });
    await expect(useCase.execute()).resolves.toEqual({ outcome: 'listed', projects: [] });
  });
});
