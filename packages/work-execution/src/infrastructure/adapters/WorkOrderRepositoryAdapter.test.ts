import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { WorkOrderRecord } from '../../domain/execution-records.js';
import { WorkOrderRepositoryAdapter } from './WorkOrderRepositoryAdapter.adapter.js';

describe('WorkOrderRepositoryAdapter cross-process safe persistence', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-work-order-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('preserves both records when two adapter instances concurrently save to the same stateDir', async () => {
    const adapterA = new WorkOrderRepositoryAdapter({ stateDir: tempDir });
    const adapterB = new WorkOrderRepositoryAdapter({ stateDir: tempDir });

    const wo1: WorkOrderRecord = {
      id: 'wo-1',
      projectId: 'proj-1',
      taskId: 'task-1',
      laneId: 'lane-1',
      repository: 'repo-1',
      baseCommit: 'commit-1',
      ownedPaths: ['src/a'],
      policyRevision: 'pol-1',
      prerequisiteWorkOrderIds: [],
      state: 'approved',
      revision: 1,
      createdAtIso: '2026-10-15T10:00:00.000Z',
      updatedAtIso: '2026-10-15T10:00:00.000Z',
    };

    const wo2: WorkOrderRecord = {
      id: 'wo-2',
      projectId: 'proj-1',
      taskId: 'task-2',
      laneId: 'lane-2',
      repository: 'repo-1',
      baseCommit: 'commit-2',
      ownedPaths: ['src/b'],
      policyRevision: 'pol-1',
      prerequisiteWorkOrderIds: [],
      state: 'approved',
      revision: 1,
      createdAtIso: '2026-10-15T10:01:00.000Z',
      updatedAtIso: '2026-10-15T10:01:00.000Z',
    };

    await Promise.all([adapterA.saveWorkOrder(wo1), adapterB.saveWorkOrder(wo2)]);

    const found1FromA = await adapterA.findWorkOrderById('wo-1');
    const found2FromA = await adapterA.findWorkOrderById('wo-2');
    const found1FromB = await adapterB.findWorkOrderById('wo-1');
    const found2FromB = await adapterB.findWorkOrderById('wo-2');

    expect(found1FromA?.id).toBe('wo-1');
    expect(found2FromA?.id).toBe('wo-2');
    expect(found1FromB?.id).toBe('wo-1');
    expect(found2FromB?.id).toBe('wo-2');

    const projectOrders = await adapterA.listWorkOrdersByProject('proj-1');
    expect(projectOrders.map((o) => o.id).sort()).toEqual(['wo-1', 'wo-2']);
  });

  it('evaluates optimistic revision against the freshly read record', async () => {
    const adapterA = new WorkOrderRepositoryAdapter({ stateDir: tempDir });
    const adapterB = new WorkOrderRepositoryAdapter({ stateDir: tempDir });

    const wo1: WorkOrderRecord = {
      id: 'wo-1',
      projectId: 'proj-1',
      taskId: 'task-1',
      laneId: 'lane-1',
      repository: 'repo-1',
      baseCommit: 'commit-1',
      ownedPaths: ['src/a'],
      policyRevision: 'pol-1',
      prerequisiteWorkOrderIds: [],
      state: 'approved',
      revision: 1,
      createdAtIso: '2026-10-15T10:00:00.000Z',
      updatedAtIso: '2026-10-15T10:00:00.000Z',
    };

    await adapterA.saveWorkOrder(wo1);

    // adapterB advances wo1 to revision 2
    await adapterB.saveWorkOrder({ ...wo1, revision: 2 });

    // adapterA tries to save wo1 with stale revision 1
    await expect(adapterA.saveWorkOrder({ ...wo1, revision: 1 })).rejects.toThrow(
      'Stale work order revision for wo-1: expected > 2, got 1',
    );
  });

  it('throws and preserves file content when saving to a corrupt file', async () => {
    const filePath = path.join(tempDir, 'work-orders.json');
    const corruptContent = '{ not valid json';
    await fs.writeFile(filePath, corruptContent, 'utf8');

    const adapter = new WorkOrderRepositoryAdapter({ stateDir: tempDir });
    const wo: WorkOrderRecord = {
      id: 'wo-corrupt',
      projectId: 'proj-1',
      taskId: 'task-1',
      laneId: 'lane-1',
      repository: 'repo-1',
      baseCommit: 'commit-1',
      ownedPaths: ['src/a'],
      policyRevision: 'pol-1',
      prerequisiteWorkOrderIds: [],
      state: 'approved',
      revision: 1,
      createdAtIso: '2026-10-15T10:00:00.000Z',
      updatedAtIso: '2026-10-15T10:00:00.000Z',
    };

    await expect(adapter.saveWorkOrder(wo)).rejects.toThrow();

    const contentAfter = await fs.readFile(filePath, 'utf8');
    expect(contentAfter).toBe(corruptContent);
  });
});
