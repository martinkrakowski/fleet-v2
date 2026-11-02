import { describe, it, expect } from 'vitest';
import { RegisterWorkOrderUseCase } from '../src/application/use-cases/RegisterWorkOrderUseCase.use-case.js';
import type { WorkOrderRecord } from '../src/domain/execution-records.js';

describe('RegisterWorkOrderUseCase', () => {
  function makeUseCase() {
    const savedOrders: WorkOrderRecord[] = [];
    const workOrderRepo = {
      findWorkOrderById: async () => null,
      listWorkOrdersByProject: async () => [],
      saveWorkOrder: async (record: WorkOrderRecord) => {
        savedOrders.push(record);
      },
    };
    return {
      useCase: new RegisterWorkOrderUseCase({ workOrderRepo }),
      savedOrders,
    };
  }

  const baseRequest = {
    workOrderId: 'wo-1',
    projectId: 'proj-1',
    taskId: 'task-1',
    laneId: 'lane-1',
    repository: 'https://github.com/example/repo',
    baseCommit: '1111111111111111111111111111111111111111',
    ownedPaths: ['packages/pkg-a/src/file.ts'],
    policyRevision: 'rev-1',
    planId: 'plan-1',
    planLaneId: 'lane-1',
  };

  it('rejects planProjectId when it is a non-string without throwing (finding 3)', async () => {
    const { useCase } = makeUseCase();
    const result = await useCase.registerWorkOrder({
      ...baseRequest,
      planProjectId: 7 as unknown as string,
    });
    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'plan-project-mismatch',
    });
  });

  it('rejects planProjectId when it has leading/trailing whitespace (finding 3)', async () => {
    const { useCase } = makeUseCase();
    const result = await useCase.registerWorkOrder({
      ...baseRequest,
      planProjectId: ' proj-1 ',
    });
    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'plan-project-mismatch',
    });
  });

  it('accepts exact planProjectId matching the work order project', async () => {
    const { useCase, savedOrders } = makeUseCase();
    const result = await useCase.registerWorkOrder({
      ...baseRequest,
      planProjectId: 'proj-1',
    });
    expect(result.outcome).toBe('registered');
    expect(savedOrders).toHaveLength(1);
    expect(savedOrders[0].planRef).toEqual({
      projectId: 'proj-1',
      planId: 'plan-1',
      laneId: 'lane-1',
    });
  });

  it('rejects planProjectId when it names a different project', async () => {
    const { useCase } = makeUseCase();
    const result = await useCase.registerWorkOrder({
      ...baseRequest,
      planProjectId: 'proj-2',
    });
    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'plan-project-mismatch',
    });
  });
});
