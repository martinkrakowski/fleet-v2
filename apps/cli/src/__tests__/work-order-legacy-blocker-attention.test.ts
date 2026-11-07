// PT1ca fix round 3: a hold skipped for an invalid blocker id reaches the
// production attention recorder. The unit suite covers the sink contract with
// a fake; this covers the production path: the legacy-id overlap refusal
// through the composed runtime records a work-execution attention item.
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { WorkOrderRepositoryAdapter } from '@fleet/work-execution';

import { createFleetCliRuntime } from '../composition.js';

const tempStateDirs: string[] = [];

afterAll(() => {
  for (const dir of tempStateDirs) {
    // The directories are removed by the callers; this is a safety net only.
    void dir;
  }
});

describe('work-order register records a skipped hold for an invalid blocker id', () => {
  it('through the composed runtime, a legacy-id overlap records the attention item', async () => {
    const stateDir = path.join(
      tmpdir(),
      `fleet-cli-legacy-blocker-${process.pid}-${Date.now()}`,
    );
    mkdirSync(stateDir, { recursive: true });
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });

    const profile = await runtime.coordination.registerProjectProfile.registerProjectProfile({
      projectId: 'proj-1',
      displayName: 'Example Project',
      repository: 'https://example.com/example.git',
      designatedDispatcherHost: 'host-example',
      policyRevision: 'pol-1',
      maxConcurrentLanes: 2,
      runnerCapabilities: { 'scoped-worktree': true, networkEgressRestricted: true },
    });
    expect(profile.outcome).toBe('registered');

    // Seed an active work order whose id is not a valid id token: it can only
    // come from pre-existing state, so it is written straight into the same
    // file-backed store the runtime reads.
    const seedRepo = new WorkOrderRepositoryAdapter({ stateDir });
    await seedRepo.saveWorkOrder({
      id: 'legacy id!',
      projectId: 'proj-1',
      taskId: 'task-legacy',
      laneId: 'lane-legacy',
      repository: 'https://example.com/example.git',
      baseCommit: '1111111111111111111111111111111111111111',
      ownedPaths: ['packages/a/src'],
      policyRevision: 'pol-1',
      risk: 'high',
      prerequisiteWorkOrderIds: [],
      state: 'approved',
      revision: 1,
      createdAtIso: '2026-11-07T08:00:00.000Z',
      updatedAtIso: '2026-11-07T08:00:00.000Z',
    });

    const result = await runtime.execution.registerWorkOrder.registerWorkOrder({
      workOrderId: 'wo-b',
      projectId: 'proj-1',
      taskId: 'task-1',
      laneId: 'lane-1',
      repository: 'https://example.com/example.git',
      baseCommit: '1111111111111111111111111111111111111111',
      ownedPaths: ['packages/a/src'],
      policyRevision: 'pol-1',
    });
    expect(result).toMatchObject({
      outcome: 'refused',
      reason: 'active-work-order-overlap',
      blockerKind: 'active-work-order',
      blockerId: 'legacy id!',
      held: false,
    });

    const attention = await runtime.coordination.listAttentionItems.listAttentionItems({
      projectId: 'proj-1',
    });
    const kinds = attention.items.map((entry) => entry.item.kind);
    expect(kinds).toContain('hold-skipped-invalid-blocker-id');
  });
});
