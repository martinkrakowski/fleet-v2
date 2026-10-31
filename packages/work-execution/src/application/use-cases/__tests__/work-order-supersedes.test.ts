// WO-1: lineage — a work order can record the terminal work order it supersedes.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { WorkOrderRecord } from '../../../domain/execution-records.js';
import { WorkOrder } from '../../../domain/entities/WorkOrder.js';
import type { WorkOrderRepositoryPort } from '../../ports/out/WorkOrderRepositoryPort.out-port.js';
import { RegisterWorkOrderUseCase } from '../RegisterWorkOrderUseCase.use-case.js';
import { WorkOrderRepositoryAdapter } from '../../../infrastructure/adapters/WorkOrderRepositoryAdapter.adapter.js';

const tempStateDirs: string[] = [];

afterEach(() => {
  for (const dir of tempStateDirs.splice(0)) {
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
      return [...orders.values()].filter((order) => order.projectId === projectId);
    },
  };
}

function validWorkOrderRequest(
  overrides: Partial<Parameters<RegisterWorkOrderUseCase['registerWorkOrder']>[0]> = {},
) {
  return {
    workOrderId: 'wo-sup-b',
    projectId: 'example-project',
    taskId: 'task-1',
    laneId: 'lane-1',
    repository: 'https://example.com/example.git',
    baseCommit: 'abc123',
    ownedPaths: ['packages/example/**'],
    policyRevision: 'pol-1',
    nowIso: '2026-10-31T08:00:00.000Z',
    ...overrides,
  };
}

function storedRecord(id: string, state: WorkOrderRecord['state']): WorkOrderRecord {
  return {
    id,
    projectId: 'example-project',
    taskId: 'task-1',
    laneId: 'lane-1',
    repository: 'https://example.com/example.git',
    baseCommit: 'abc123',
    ownedPaths: ['packages/example/**'],
    policyRevision: 'pol-1',
    prerequisiteWorkOrderIds: [],
    state,
    revision: 1,
    createdAtIso: '2026-10-31T08:00:00.000Z',
    updatedAtIso: '2026-10-31T08:00:00.000Z',
  };
}

async function registerTerminal(
  useCase: RegisterWorkOrderUseCase,
  repo: WorkOrderRepositoryPort,
  id: string,
  state: 'stopped' | 'merged' = 'stopped',
): Promise<void> {
  // Terminal work orders release their paths, so a successor may own the same paths.
  const registered = await useCase.registerWorkOrder(validWorkOrderRequest({ workOrderId: id }));
  expect(registered.outcome).toBe('registered');
  const record = (registered as { workOrder: WorkOrderRecord }).workOrder;
  await repo.saveWorkOrder({ ...record, state, revision: record.revision + 1 });
}

describe('work order supersedes (WO-1)', () => {
  it.each([
    ['not a string', 1 as never],
    ['not a string', null as never],
    ['blank', '   ' as never],
  ])('refuses a %s supersedesWorkOrderId', async (_label, bad) => {
    const repo = makeWorkOrderRepo();
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo });
    const result = await useCase.registerWorkOrder(
      validWorkOrderRequest({ supersedesWorkOrderId: bad }),
    );
    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'supersedesWorkOrderId must be a non-empty string',
    });
    expect(repo.orders.size).toBe(0);
  });

  it('refuses a work order superseding itself', async () => {
    const repo = makeWorkOrderRepo();
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo });
    const result = await useCase.registerWorkOrder(
      validWorkOrderRequest({ workOrderId: 'wo-sup-self', supersedesWorkOrderId: 'wo-sup-self' }),
    );
    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'A work order cannot supersede itself',
    });
    expect(repo.orders.size).toBe(0);
  });

  it('refuses a missing superseded work order', async () => {
    const repo = makeWorkOrderRepo();
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo });
    const result = await useCase.registerWorkOrder(
      validWorkOrderRequest({ supersedesWorkOrderId: 'wo-sup-missing' }),
    );
    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'Superseded work order not found: wo-sup-missing',
    });
    expect(repo.orders.size).toBe(0);
  });

  it('refuses a superseded work order in another project', async () => {
    const repo = makeWorkOrderRepo();
    repo.orders.set('wo-sup-other', {
      ...storedRecord('wo-sup-other', 'stopped'),
      projectId: 'other-project',
    });
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo });
    const result = await useCase.registerWorkOrder(
      validWorkOrderRequest({ supersedesWorkOrderId: 'wo-sup-other' }),
    );
    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'Superseded work order is in another project: wo-sup-other',
    });
    expect(repo.orders.size).toBe(1);
  });

  it.each(['approved', 'implementing'] as const)(
    'refuses a non-terminal superseded work order (%s)',
    async (state) => {
      const repo = makeWorkOrderRepo();
      repo.orders.set('wo-sup-active', storedRecord('wo-sup-active', state as never));
      const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo });
      const result = await useCase.registerWorkOrder(
        validWorkOrderRequest({ supersedesWorkOrderId: 'wo-sup-active' }),
      );
      expect(result).toEqual({
        outcome: 'rejected',
        reason: `Superseded work order is not terminal: wo-sup-active (${state})`,
      });
      expect(repo.orders.size).toBe(1);
    },
  );

  it('refuses a work order naming a parent already superseded by another', async () => {
    const repo = makeWorkOrderRepo();
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo });
    await registerTerminal(useCase, repo, 'wo-sup-parent');
    const first = await useCase.registerWorkOrder(
      validWorkOrderRequest({ supersedesWorkOrderId: 'wo-sup-parent' }),
    );
    expect(first.outcome).toBe('registered');
    const second = await useCase.registerWorkOrder(
      validWorkOrderRequest({
        workOrderId: 'wo-sup-second',
        supersedesWorkOrderId: 'wo-sup-parent',
      }),
    );
    expect(second).toEqual({
      outcome: 'rejected',
      reason: 'Work order wo-sup-parent is already superseded by wo-sup-b',
    });
    expect(repo.orders.size).toBe(2);
  });

  it('supersedes a stopped and a merged work order and stores the trimmed id', async () => {
    const repo = makeWorkOrderRepo();
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo });
    await registerTerminal(useCase, repo, 'wo-sup-stopped', 'stopped');
    await registerTerminal(useCase, repo, 'wo-sup-merged', 'merged');

    const stopped = await useCase.registerWorkOrder(
      validWorkOrderRequest({
        workOrderId: 'wo-sup-successor-1',
        supersedesWorkOrderId: ' wo-sup-stopped ',
      }),
    );
    expect(stopped.outcome).toBe('registered');
    if (stopped.outcome !== 'registered') throw new Error('unreachable');
    expect(stopped.workOrder.supersedesWorkOrderId).toBe('wo-sup-stopped');
    const merged = await useCase.registerWorkOrder(
      validWorkOrderRequest({
        workOrderId: 'wo-sup-successor-2',
        ownedPaths: ['packages/example-two/**'],
        supersedesWorkOrderId: 'wo-sup-merged',
      }),
    );
    expect(merged.outcome).toBe('registered');
    if (merged.outcome !== 'registered') throw new Error('unreachable');
    expect(merged.workOrder.supersedesWorkOrderId).toBe('wo-sup-merged');
    expect(repo.orders.get('wo-sup-successor-1')?.supersedesWorkOrderId).toBe('wo-sup-stopped');
    expect(repo.orders.get('wo-sup-successor-2')?.supersedesWorkOrderId).toBe('wo-sup-merged');
  });

  it('omits the supersedesWorkOrderId key when the field is absent', async () => {
    const repo = makeWorkOrderRepo();
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo });
    const registered = await useCase.registerWorkOrder(validWorkOrderRequest());
    expect(registered.outcome).toBe('registered');
    const saved = repo.orders.get('wo-sup-b');
    expect(saved).toBeDefined();
    expect(Object.hasOwn(saved!, 'supersedesWorkOrderId')).toBe(false);
  });

  it('builds a linear chain: A stopped, B supersedes A, B stopped, C supersedes B', async () => {
    const repo = makeWorkOrderRepo();
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo });
    await registerTerminal(useCase, repo, 'wo-chain-a');
    const b = await useCase.registerWorkOrder(
      validWorkOrderRequest({ workOrderId: 'wo-chain-b', supersedesWorkOrderId: 'wo-chain-a' }),
    );
    expect(b.outcome).toBe('registered');
    const bRecord = (b as { workOrder: WorkOrderRecord }).workOrder;
    await repo.saveWorkOrder({ ...bRecord, state: 'stopped', revision: bRecord.revision + 1 });
    const c = await useCase.registerWorkOrder(
      validWorkOrderRequest({ workOrderId: 'wo-chain-c', supersedesWorkOrderId: 'wo-chain-b' }),
    );
    expect(c.outcome).toBe('registered');

    const d = await useCase.registerWorkOrder(
      validWorkOrderRequest({ workOrderId: 'wo-chain-d', supersedesWorkOrderId: 'wo-chain-a' }),
    );
    expect(d).toEqual({
      outcome: 'rejected',
      reason: 'Work order wo-chain-a is already superseded by wo-chain-b',
    });
    expect(repo.orders.size).toBe(3);
  });

  it('round-trips the field through the file-backed adapter', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-wo-supersedes-'));
    tempStateDirs.push(stateDir);
    const repo = new WorkOrderRepositoryAdapter({ stateDir });
    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo });
    await registerTerminal(useCase, repo, 'wo-round-parent');
    const registered = await useCase.registerWorkOrder(
      validWorkOrderRequest({ workOrderId: 'wo-round-child', supersedesWorkOrderId: 'wo-round-parent' }),
    );
    expect(registered.outcome).toBe('registered');

    const reread = await new WorkOrderRepositoryAdapter({ stateDir }).findWorkOrderById(
      'wo-round-child',
    );
    expect(reread?.supersedesWorkOrderId).toBe('wo-round-parent');
    expect(reread?.state).toBe('approved');
  });

  it('keeps the field through the WorkOrder entity and refuses a blank or self value', () => {
    const base = storedRecord('wo-entity-1', 'approved');
    expect(WorkOrder.fromRecord({ ...base, supersedesWorkOrderId: 'wo-entity-0' }).toRecord()).toEqual(
      { ...base, supersedesWorkOrderId: 'wo-entity-0' },
    );
    expect(() => WorkOrder.fromRecord({ ...base, supersedesWorkOrderId: '   ' })).toThrow(
      'WorkOrder supersedesWorkOrderId must be a non-empty string',
    );
    expect(() => WorkOrder.fromRecord({ ...base, supersedesWorkOrderId: 1 as never })).toThrow(
      'WorkOrder supersedesWorkOrderId must be a non-empty string',
    );
    expect(() => WorkOrder.fromRecord({ ...base, supersedesWorkOrderId: 'wo-entity-1' })).toThrow(
      'WorkOrder cannot supersede itself',
    );
    // An own key holding undefined counts as absent and is not copied.
    const withUndefinedKey = { ...base, supersedesWorkOrderId: undefined } as WorkOrderRecord;
    const stored = WorkOrder.fromRecord(withUndefinedKey).toRecord();
    expect(Object.hasOwn(stored, 'supersedesWorkOrderId')).toBe(false);
  });

  it('reads a legacy stored record without the field and persists a successor beside it', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-wo-supersedes-legacy-'));
    tempStateDirs.push(stateDir);
    writeFileSync(path.join(stateDir, 'work-orders.json'), JSON.stringify([storedRecord('wo-legacy', 'stopped')]));

    const repo = new WorkOrderRepositoryAdapter({ stateDir });
    const found = await repo.findWorkOrderById('wo-legacy');
    expect(found).not.toBeNull();
    expect(Object.hasOwn(found!, 'supersedesWorkOrderId')).toBe(false);

    const useCase = new RegisterWorkOrderUseCase({ workOrderRepo: repo });
    const registered = await useCase.registerWorkOrder(
      validWorkOrderRequest({ workOrderId: 'wo-legacy-child', supersedesWorkOrderId: 'wo-legacy' }),
    );
    expect(registered.outcome).toBe('registered');
    const reread = await new WorkOrderRepositoryAdapter({ stateDir }).findWorkOrderById(
      'wo-legacy-child',
    );
    expect(reread?.supersedesWorkOrderId).toBe('wo-legacy');
  });
});
