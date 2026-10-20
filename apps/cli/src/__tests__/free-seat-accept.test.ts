// Free-seat wiring at the CLI composition boundary (free-seat plan FS3a-B):
// a v2 installation with policy.useFreeSeats false reaches the accept use
// case through AllowedSeatAdapter, so a free reviewer is rejected while a
// paid reviewer passes the seat check.
import { describe, expect, it } from 'vitest';

import { createFleetCliRuntime } from '../composition.js';
import type { FleetInstallation } from '@fleet/installation';
import type { AttemptRecord, WorkOrderRecord } from '@fleet/work-execution';

const installation: FleetInstallation = {
  schemaVersion: 2,
  forge: { mode: 'none' },
  hosts: {
    here: {
      transport: 'local',
      worktreeRoot: '/tmp/wt',
      roles: ['orchestrator', 'lane-runner', 'verifier'],
      runner: { kind: 'opencode', port: 46000 },
    },
  },
  seats: [
    { id: 'impl-paid', tool: 'opencode', model: 'provider-a/glm-5.3', roles: ['implementer'], costClass: 'paid' },
    { id: 'rev-paid', tool: 'opencode', model: 'provider-b/grok-4.7', roles: ['reviewer'], costClass: 'paid' },
    {
      id: 'rev-free',
      tool: 'opencode',
      model: 'provider-c/longcat-2.5-preview-free',
      roles: ['reviewer'],
      costClass: 'free',
    },
  ],
  chains: {
    implementer: [{ seatId: 'impl-paid' }],
    reviewer: [{ seatId: 'rev-free' }, { seatId: 'rev-paid' }],
  },
  policy: { useFreeSeats: false },
};

const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';

function makeWorkOrder(): WorkOrderRecord {
  return {
    id: 'wo-free-seat',
    projectId: 'proj-cli-test',
    taskId: 'task-cli-test',
    laneId: 'lane-cli-test',
    repository: 'github.com/org/repo',
    state: 'verifying',
    revision: 1,
    baseCommit: '0000000000000000000000000000000000000000',
    ownedPaths: ['src/'],
    policyRevision: 'pol-1',
    prerequisiteWorkOrderIds: [],
    createdAtIso: '2026-10-15T10:00:00Z',
    updatedAtIso: '2026-10-15T10:00:00Z',
  };
}

function makeAttempt(): AttemptRecord {
  return {
    id: 'att-free-seat',
    workOrderId: 'wo-free-seat',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    state: 'collected',
    outcome: 'done',
    baseCommit: '0000000000000000000000000000000000000000',
    worktreePath: '/tmp/worktree',
    briefDigest: 'digest-1',
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    ownerDecisionReferences: [],
    artifacts: {
      headCommit: HEAD_SHA,
      commitsSinceBase: [HEAD_SHA],
      collectedArtifactPaths: ['/tmp/patch.diff'],
      notes: 'present',
    },
    runner: {
      kind: 'opencode',
      remotePort: null,
      host: null,
      agent: null,
      model: 'provider-a/glm-5.3',
      variant: null,
    },
    createdAtIso: '2026-10-15T10:00:00Z',
    updatedAtIso: '2026-10-15T10:30:00Z',
  };
}

describe('free-seat policy at the CLI composition boundary', () => {
  it('rejects a free reviewer and passes a paid reviewer through the seat check', async () => {
    const rt = createFleetCliRuntime({ installation });
    await rt.execution.workOrderRepository.saveWorkOrder(makeWorkOrder());
    await rt.execution.attemptRepository.saveAttempt(makeAttempt());

    const free = await rt.execution.requestAttemptAcceptance.requestAttemptAcceptance({
      attemptId: 'att-free-seat',
      candidateHeadSha: HEAD_SHA,
      reviewerModel: 'provider-c/longcat-2.5-preview-free',
    });

    expect(free.outcome).toBe('rejected');
    expect(free.outcome === 'rejected' && free.reason).toContain('is a free seat');
    expect(free.outcome === 'rejected' && free.reason).toContain('rev-free');

    // The paid reviewer clears the seat check; any later rejection comes from
    // the acceptance evidence side, never from the free-seat policy.
    const paid = await rt.execution.requestAttemptAcceptance.requestAttemptAcceptance({
      attemptId: 'att-free-seat',
      candidateHeadSha: HEAD_SHA,
      reviewerModel: 'provider-b/grok-4.7',
    });

    if (paid.outcome === 'rejected') {
      expect(paid.reason).not.toContain('useFreeSeats');
      expect(paid.reason).not.toContain('is a free seat');
    }
  });
});
