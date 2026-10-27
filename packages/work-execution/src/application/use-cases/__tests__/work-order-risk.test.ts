// AM2: risk on work orders — registration, refusal, resolver, entity, frozen saves.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_WORK_ORDER_RISK,
  WORK_ORDER_RISKS,
  parseWorkOrderRisk,
  resolveWorkOrderRisk,
  type WorkOrderRecord,
} from '../../../domain/execution-records.js';
import { WorkOrder } from '../../../domain/entities/WorkOrder.js';
import type { WorkOrderRepositoryPort } from '../../ports/out/WorkOrderRepositoryPort.out-port.js';
import { RegisterWorkOrderUseCase } from '../RegisterWorkOrderUseCase.use-case.js';
import { WorkOrderRepositoryAdapter } from '../../../infrastructure/adapters/WorkOrderRepositoryAdapter.adapter.js';

const tempStateDirs: string[] = [];

afterAll(() => {
  for (const dir of tempStateDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeWorkOrderRepo(): WorkOrderRepositoryPort & { orders: Map<string, WorkOrderRecord> } {
  const orders = new Map<string, WorkOrderRecord>();
  return {
    orders,
    async saveWorkOrder(record) {
      orders.set(record.id, record);
    },
    async findWorkOrderById(workOrderId) {
      return orders.get(workOrderId) ?? null;
    },
    async listWorkOrdersByProject(projectId) {
      return [...orders.values()].filter(
        (order) => projectId === undefined || order.projectId === projectId,
      );
    },
  };
}

function validWorkOrderRequest(
  overrides: Partial<Parameters<RegisterWorkOrderUseCase['registerWorkOrder']>[0]> = {},
) {
  return {
    workOrderId: 'wo-risk-example-1',
    projectId: 'example-project',
    taskId: 'task-1',
    laneId: 'lane-1',
    repository: 'https://example.com/example.git',
    baseCommit: 'abc123',
    ownedPaths: ['packages/example/**'],
    policyRevision: 'pol-1',
    nowIso: '2026-10-15T08:00:00.000Z',
    ...overrides,
  };
}

describe('work order risk (AM2)', () => {
  it('registers an absent risk as high and writes the own key', async () => {
    const repo = makeWorkOrderRepo();
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo });
    const result = await useCase.registerWorkOrder(validWorkOrderRequest());
    expect(result.outcome).toBe('registered');
    if (result.outcome !== 'registered') throw new Error('unreachable');
    expect(result.workOrder.risk).toBe('high');
    const saved = repo.orders.get('wo-risk-example-1');
    expect(saved).toBeDefined();
    expect(Object.hasOwn(saved!, 'risk')).toBe(true);
    expect(saved!.risk).toBe('high');
  });

  it('registers explicit standard and high values', async () => {
    const repo = makeWorkOrderRepo();
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo });
    const standard = await useCase.registerWorkOrder(
      validWorkOrderRequest({ workOrderId: 'wo-risk-example-standard', risk: 'standard' }),
    );
    expect(standard.outcome).toBe('registered');
    if (standard.outcome !== 'registered') throw new Error('unreachable');
    expect(standard.workOrder.risk).toBe('standard');
    const high = await useCase.registerWorkOrder(
      validWorkOrderRequest({
        workOrderId: 'wo-risk-example-high',
        ownedPaths: ['packages/example-other/**'],
        risk: 'high',
      }),
    );
    expect(high.outcome).toBe('registered');
    if (high.outcome !== 'registered') throw new Error('unreachable');
    expect(high.workOrder.risk).toBe('high');
  });

  it.each(['low', 'STANDARD', '', null, 1, true, {}])(
    'refuses a bad risk value without saving or echoing it',
    async (bad) => {
      const repo = makeWorkOrderRepo();
      const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo });
      const result = await useCase.execute(
        validWorkOrderRequest({ risk: bad as never }) as unknown,
      );
      expect(result).toEqual({
        outcome: 'rejected',
        reason: "Work order risk must be 'standard' or 'high'",
      });
      expect(repo.orders.size).toBe(0);
      expect(result.outcome === 'rejected' && result.reason.includes('low')).toBe(false);
    },
  );

  it('checks risk after the required-field check', async () => {
    const repo = makeWorkOrderRepo();
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo });
    const result = await useCase.registerWorkOrder(
      validWorkOrderRequest({ taskId: '', risk: 'low' as never }),
    );
    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'Missing required work order fields: taskId',
    });
    expect(repo.orders.size).toBe(0);
  });

  it('resolves stored risk values', () => {
    expect(resolveWorkOrderRisk({})).toBe('high');
    expect(resolveWorkOrderRisk({ risk: undefined })).toBe('high');
    expect(resolveWorkOrderRisk({ risk: 'medium' as never })).toBe('high');
    expect(resolveWorkOrderRisk({ risk: 'standard' })).toBe('standard');
    expect(DEFAULT_WORK_ORDER_RISK).toBe('high');
    expect([...WORK_ORDER_RISKS]).toEqual(['standard', 'high']);
    expect(parseWorkOrderRisk('high')).toBe('high');
    expect(parseWorkOrderRisk('x')).toBeUndefined();
  });

  it('reads risk through the WorkOrder entity without validating it', () => {
    const base = {
      id: 'wo-risk-example-1',
      projectId: 'example-project',
      taskId: 'task-1',
      laneId: 'lane-1',
      repository: 'https://example.com/example.git',
      baseCommit: 'abc123',
      ownedPaths: ['packages/example/**'],
      policyRevision: 'pol-1',
      prerequisiteWorkOrderIds: [],
      state: 'approved',
      revision: 1,
      createdAtIso: '2026-10-15T08:00:00.000Z',
      updatedAtIso: '2026-10-15T08:00:00.000Z',
    } as const;
    expect(WorkOrder.fromRecord({ ...base }).getRisk()).toBe('high');
    expect(WorkOrder.fromRecord({ ...base, risk: 'standard' }).getRisk()).toBe('standard');
    const bogus = WorkOrder.fromRecord({ ...base, risk: 'bogus' as never });
    expect(bogus.getRisk()).toBe('high');
    expect(bogus.toRecord().risk).toBe('bogus');
    expect(WorkOrder.fromRecord({ ...base, risk: 'standard' }).toRecord().risk).toBe('standard');
  });

  it('keeps risk frozen through a later markMerged-shaped save', async () => {
    const repo = makeWorkOrderRepo();
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo });
    const registered = await useCase.registerWorkOrder(
      validWorkOrderRequest({ risk: 'standard' }),
    );
    if (registered.outcome !== 'registered') throw new Error('unreachable');
    await repo.saveWorkOrder({ ...registered.workOrder, state: 'merged', revision: 2 });
    const reread = await repo.findWorkOrderById('wo-risk-example-1');
    expect(reread?.state).toBe('merged');
    expect(reread?.revision).toBe(2);
    expect(reread?.risk).toBe('standard');
  });

  it('reads a legacy stored record as high and persists risk through the file store', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-wo-risk-'));
    tempStateDirs.push(stateDir);

    const legacy: WorkOrderRecord = {
      id: 'wo-risk-legacy-1',
      projectId: 'example-project',
      taskId: 'task-0',
      laneId: 'lane-0',
      repository: 'https://example.com/example.git',
      baseCommit: 'abc123',
      ownedPaths: ['packages/legacy/**'],
      policyRevision: 'pol-1',
      prerequisiteWorkOrderIds: [],
      state: 'approved',
      revision: 1,
      createdAtIso: '2026-10-15T08:00:00.000Z',
      updatedAtIso: '2026-10-15T08:00:00.000Z',
    };
    writeFileSync(path.join(stateDir, 'work-orders.json'), JSON.stringify([legacy]));

    const first = new WorkOrderRepositoryAdapter({ stateDir });
    const found = await first.findWorkOrderById('wo-risk-legacy-1');
    expect(found).not.toBeNull();
    expect(Object.hasOwn(found!, 'risk')).toBe(false);
    expect(resolveWorkOrderRisk(found!)).toBe('high');

    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: first });
    const registered = await useCase.registerWorkOrder(
      validWorkOrderRequest({ workOrderId: 'wo-risk-example-2', risk: 'standard' }),
    );
    expect(registered.outcome).toBe('registered');

    const second = new WorkOrderRepositoryAdapter({ stateDir });
    const reread = await second.findWorkOrderById('wo-risk-example-2');
    expect(reread?.risk).toBe('standard');
  });
});