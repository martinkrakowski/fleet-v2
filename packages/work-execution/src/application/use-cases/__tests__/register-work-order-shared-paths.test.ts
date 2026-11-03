import { describe, expect, it } from 'vitest';

import { RegisterWorkOrderUseCase } from '../RegisterWorkOrderUseCase.use-case.js';
import { WorkOrderRepositoryAdapter } from '../../../infrastructure/adapters/WorkOrderRepositoryAdapter.adapter.js';
import type { RegisterWorkOrderRequest } from '../../ports/in/RegisterWorkOrderPort.in-port.js';

const COMMIT = 'a'.repeat(40);

function registerRequest(overrides: Partial<RegisterWorkOrderRequest> = {}): RegisterWorkOrderRequest {
  return {
    workOrderId: 'wo-example-1',
    projectId: 'project-example-1',
    taskId: 'task-example-1',
    laneId: 'lane-example-1',
    repository: 'repo-example-1',
    baseCommit: COMMIT,
    policyRevision: 'policy-example-1',
    ownedPaths: ['packages/example/src'],
    ...overrides,
  };
}

describe('RegisterWorkOrderUseCase shared append paths (CG2)', () => {
  it('registers a second work order sharing only the manifest with disjoint packages', async () => {
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: new WorkOrderRepositoryAdapter() });
    const first = await useCase.registerWorkOrder(
      registerRequest({
        workOrderId: 'wo-a',
        ownedPaths: ['.architecture/manifest.yaml', 'packages/a/src'],
      }),
    );
    expect(first.outcome).toBe('registered');
    const second = await useCase.registerWorkOrder(
      registerRequest({
        workOrderId: 'wo-b',
        ownedPaths: ['.architecture/manifest.yaml', 'packages/b/src'],
      }),
    );
    expect(second.outcome).toBe('registered');
  });

  it('rejects a nested path under a registered package', async () => {
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: new WorkOrderRepositoryAdapter() });
    const first = await useCase.registerWorkOrder(
      registerRequest({ workOrderId: 'wo-a', ownedPaths: ['.architecture/manifest.yaml', 'packages/a/src'] }),
    );
    expect(first.outcome).toBe('registered');
    const second = await useCase.registerWorkOrder(
      registerRequest({ workOrderId: 'wo-b', ownedPaths: ['packages/a/src/x.ts'] }),
    );
    expect(second.outcome).toBe('rejected');
    expect(second.outcome === 'rejected' && second.reason.includes('Owned path conflicts with active work order')).toBe(true);
  });

  it('rejects two work orders owning the same non-shared file', async () => {
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: new WorkOrderRepositoryAdapter() });
    const first = await useCase.registerWorkOrder(
      registerRequest({ workOrderId: 'wo-a', ownedPaths: ['packages/a/src/x.ts'] }),
    );
    expect(first.outcome).toBe('registered');
    const second = await useCase.registerWorkOrder(
      registerRequest({ workOrderId: 'wo-b', ownedPaths: ['packages/a/src/x.ts'] }),
    );
    expect(second.outcome).toBe('rejected');
  });
});
