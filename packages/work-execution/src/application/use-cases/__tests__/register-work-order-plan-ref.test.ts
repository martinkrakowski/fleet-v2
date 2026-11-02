/**
 * Unit tests for the WB4a plan-link addition to RegisterWorkOrderUseCase.
 * In-memory work-order and lane-plan repo fakes; no filesystem or clock.
 */

import { describe, expect, it } from 'vitest';

import type { WorkOrderRecord } from '../../../domain/execution-records.js';
import type { LanePlanRecord } from '../../../domain/lane-plan-records.js';
import type { LanePlanRepositoryPort } from '../../ports/out/LanePlanRepositoryPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../../ports/out/WorkOrderRepositoryPort.out-port.js';
import { RegisterWorkOrderUseCase } from '../RegisterWorkOrderUseCase.use-case.js';

class FakeWorkOrderRepo implements WorkOrderRepositoryPort {
  readonly orders = new Map<string, WorkOrderRecord>();

  async saveWorkOrder(record: WorkOrderRecord): Promise<void> {
    this.orders.set(record.id, record);
  }

  async findWorkOrderById(workOrderId: string): Promise<WorkOrderRecord | null> {
    return this.orders.get(workOrderId) ?? null;
  }

  async listWorkOrdersByProject(projectId: string): Promise<readonly WorkOrderRecord[]> {
    return [...this.orders.values()].filter((order) => order.projectId === projectId);
  }
}

class FakeLanePlanRepo implements LanePlanRepositoryPort {
  constructor(private readonly plans: ReadonlyMap<string, LanePlanRecord>) {}

  async findLanePlan(projectId: string, planId: string): Promise<LanePlanRecord | null> {
    return this.plans.get(`${projectId}/${planId}`) ?? null;
  }

  async saveLanePlan(): Promise<void> {
    throw new Error('not used');
  }

  async listLanePlans(): Promise<readonly LanePlanRecord[]> {
    return [...this.plans.values()];
  }
}

function storedLane(laneId: string, aliases: readonly string[] = []) {
  return {
    laneId,
    aliases,
    scope: `scope ${laneId}`,
    packages: [`pkg-${laneId.toLowerCase()}`],
    sharedFiles: [] as readonly string[],
    tier: 0 as const,
    after: [] as readonly { projectId: string; planId: string; laneId: string }[],
    decisions: [] as readonly string[],
    status: 'planned' as const,
    brief: null,
    mergedPr: null,
  };
}

function storedPlan(overrides: Partial<LanePlanRecord> = {}): LanePlanRecord {
  return {
    version: 1,
    projectId: 'proj-1',
    planId: 'plan-1',
    revision: 1,
    digest: 'a'.repeat(64),
    doc: 'docs/plan.md',
    lanes: [storedLane('L1')],
    decisions: [],
    exclusiveOrder: [],
    importedAtIso: '2026-10-25T00:00:00.000Z',
    ...overrides,
  };
}

function validRequest(overrides: Partial<Parameters<RegisterWorkOrderUseCase['registerWorkOrder']>[0]> = {}) {
  return {
    workOrderId: 'wo-1',
    projectId: 'proj-1',
    taskId: 'task-1',
    laneId: 'lane-1',
    repository: 'git@example.org:acme/app.git',
    baseCommit: 'abc123',
    ownedPaths: ['packages/app-a/**'],
    policyRevision: 'policy-7',
    nowIso: '2026-10-15T08:00:00.000Z',
    ...overrides,
  };
}

describe('RegisterWorkOrderUseCase plan link', () => {
  it('rejects a planProjectId that differs from the work order project, writing nothing', async () => {
    const workOrderRepo = new FakeWorkOrderRepo();
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo });
    const result = await useCase.registerWorkOrder(
      validRequest({ planId: 'plan-1', planLaneId: 'L1', planProjectId: 'other-project' }),
    );
    expect(result.outcome).toBe('rejected');
    expect(result.outcome === 'rejected' ? result.reason : '').toBe('plan-project-mismatch');
    expect(workOrderRepo.orders.size).toBe(0);
  });

  it('rejects only one of planId/planLaneId as plan-ref-incomplete, writing nothing', async () => {
    const workOrderRepo = new FakeWorkOrderRepo();
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo });
    const onlyPlan = await useCase.registerWorkOrder(validRequest({ planId: 'plan-1' }));
    expect(onlyPlan.outcome).toBe('rejected');
    expect(onlyPlan.outcome === 'rejected' ? onlyPlan.reason : '').toBe('plan-ref-incomplete');
    const onlyLane = await useCase.registerWorkOrder(validRequest({ planLaneId: 'L1' }));
    expect(onlyLane.outcome).toBe('rejected');
    expect(onlyLane.outcome === 'rejected' ? onlyLane.reason : '').toBe('plan-ref-incomplete');
    expect(workOrderRepo.orders.size).toBe(0);
  });

  it('rejects an unknown plan as plan-not-found and an unknown lane as lane-not-found', async () => {
    const lanePlanRepo = new FakeLanePlanRepo(new Map([['proj-1/plan-1', storedPlan()]]));
    const workOrderRepo = new FakeWorkOrderRepo();
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo, lanePlanRepo });

    const unknownPlan = await useCase.registerWorkOrder(
      validRequest({ planId: 'plan-missing', planLaneId: 'L1' }),
    );
    expect(unknownPlan.outcome).toBe('rejected');
    expect(unknownPlan.outcome === 'rejected' ? unknownPlan.reason : '').toBe('plan-not-found');

    const unknownLane = await useCase.registerWorkOrder(
      validRequest({ planId: 'plan-1', planLaneId: 'nope' }),
    );
    expect(unknownLane.outcome).toBe('rejected');
    expect(unknownLane.outcome === 'rejected' ? unknownLane.reason : '').toBe('lane-not-found');
    expect(workOrderRepo.orders.size).toBe(0);
  });

  it('registers with planRef.projectId equal to the work order project, matching a lane id or alias', async () => {
    const lanePlanRepo = new FakeLanePlanRepo(
      new Map([['proj-1/plan-1', storedPlan({ lanes: [storedLane('L1', ['legacy-L1'])] })]]),
    );
    const workOrderRepo = new FakeWorkOrderRepo();
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo, lanePlanRepo });

    const byId = await useCase.registerWorkOrder(
      validRequest({ planId: 'plan-1', planLaneId: 'L1' }),
    );
    expect(byId.outcome).toBe('registered');
    if (byId.outcome === 'registered') {
      expect(byId.workOrder.planRef).toEqual({
        projectId: 'proj-1',
        planId: 'plan-1',
        laneId: 'L1',
      });
    }

    const byAlias = await useCase.registerWorkOrder(
      validRequest({
        workOrderId: 'wo-2',
        ownedPaths: ['packages/app-b/**'],
        planId: 'plan-1',
        planLaneId: 'legacy-L1',
      }),
    );
    expect(byAlias.outcome).toBe('registered');
    if (byAlias.outcome === 'registered') {
      expect(byAlias.workOrder.planRef).toEqual({
        projectId: 'proj-1',
        planId: 'plan-1',
        laneId: 'legacy-L1',
      });
    }
  });

  it('saves no planRef when the plan fields are absent, as before', async () => {
    const workOrderRepo = new FakeWorkOrderRepo();
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo });
    const result = await useCase.registerWorkOrder(validRequest());
    expect(result.outcome).toBe('registered');
    if (result.outcome === 'registered') {
      expect(result.workOrder.planRef).toBeUndefined();
    }
  });
});
