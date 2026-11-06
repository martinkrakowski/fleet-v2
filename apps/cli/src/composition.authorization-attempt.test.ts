import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CoordinationRequestRecord } from '@fleet/operator-coordination';
import type { AttemptRecord, WorkOrderRecord } from '@fleet/work-execution';
import { createFleetCliRuntime } from './composition.js';

// CO24d: the CLI composition binds a grant to the attempt resolved for it.
// Everything below runs through the real CLI composition's authorization
// adapter, delegate, coordination use case and repositories; only the gh
// subprocess is a spy.

const HEAD = '3'.repeat(40);

function workOrder(id: string): WorkOrderRecord {
  return {
    id,
    projectId: 'project-1',
    taskId: `task-${id}`,
    laneId: `lane-${id}`,
    repository: 'github.com/org/repo',
    state: 'approved',
    revision: 1,
    baseCommit: '0'.repeat(40),
    ownedPaths: ['src/'],
    policyRevision: 'pol-1',
    prerequisiteWorkOrderIds: [],
    createdAtIso: '2026-11-06T10:00:00.000Z',
    updatedAtIso: '2026-11-06T10:00:00.000Z',
  };
}

function attempt(id: string, workOrderId: string): AttemptRecord {
  return {
    id,
    workOrderId,
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    state: 'collected',
    outcome: 'done',
    baseCommit: '0'.repeat(40),
    worktreePath: '/tmp/worktree',
    briefDigest: 'digest-1',
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts: {
      headCommit: HEAD,
      commitsSinceBase: [HEAD],
      collectedArtifactPaths: [],
      notes: 'present',
    },
    ownerDecisionReferences: [],
    createdAtIso: '2026-11-06T09:00:00.000Z',
    updatedAtIso: '2026-11-06T10:00:00.000Z',
  };
}

function grant(grantId: string): CoordinationRequestRecord {
  return {
    id: `req-${grantId}`,
    projectId: 'project-1',
    kind: 'action-decision',
    actionScope: 'forge:push-and-open-pr',
    expectedHeadSha: HEAD,
    proposalDigest: 'prop-1',
    policyRevision: 'pol-1',
    decisionRevision: 'dec-1',
    grantId,
    state: 'approved',
    deliveryStatus: 'pending',
    deliveryGapReason: null,
    revision: 1,
    consumptions: [],
    acknowledgements: [],
    createdAtIso: '2026-11-06T10:00:00.000Z',
    updatedAtIso: '2026-11-06T10:00:00.000Z',
  };
}

describe('CLI composition: grant bound to its resolved attempt (CO24d)', () => {
  let tempDir: string;
  const runGh = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: '' }) as never);

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-cli-co24d-'));
    runGh.mockClear();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  async function seed(runtime: ReturnType<typeof createFleetCliRuntime>, grantId: string): Promise<void> {
    await runtime.coordination.coordinationRequestRepository.saveRequest(grant(grantId));
    for (const suffix of ['A', 'B']) {
      await runtime.execution.workOrderRepository.saveWorkOrder(workOrder(`wo-${suffix}`));
      await runtime.execution.attemptRepository.saveAttempt(attempt(`att-${suffix}`, `wo-${suffix}`));
    }
  }

  async function resolveForA(runtime: ReturnType<typeof createFleetCliRuntime>) {
    return runtime.execution.actionAuthorization.resolveActionAuthorization({
      actionId: 'action-resolve',
      projectId: 'project-1',
      workOrderId: 'wo-A',
      attemptId: 'att-A',
      actionKind: 'push-and-open-pr',
      expectedHeadSha: HEAD,
      policyRevision: 'pol-1',
    });
  }

  it('refuses a forge action for attempt B on a grant resolved for attempt A: forge never called, grant unconsumed', async () => {
    const runtime = createFleetCliRuntime({
      stateDir: tempDir,
      forgeActionDelegate: { runGh, verifyCurrentHeadSha: async () => ({ outcome: 'verified' }) as never },
    });
    await seed(runtime, 'grant-1');
    expect(await resolveForA(runtime)).toEqual({ outcome: 'granted', authorizationGrantId: 'grant-1' });

    const result = await runtime.execution.executeAuthorizedForgeAction.executeAuthorizedForgeAction({
      actionId: 'action-b',
      attemptId: 'att-B',
      workOrderId: 'wo-B',
      kind: 'push-and-open-pr',
      expectedHeadSha: HEAD,
      authorizationGrantId: 'grant-1',
      branchName: 'feat/lane-b',
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'grant-attempt-mismatch' });
    expect(runGh).not.toHaveBeenCalled();
    const stored = await runtime.coordination.coordinationRequestRepository.findRequestByGrantId('grant-1');
    expect(stored?.consumptions).toHaveLength(0);
  });

  it('refuses a mismatching attempt at the authorization seam and consumes the matching one', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempDir });
    await seed(runtime, 'grant-1');
    await resolveForA(runtime);
    const port = runtime.execution.actionAuthorization;

    expect(
      await port.consumeActionAuthorization({
        authorizationGrantId: 'grant-1',
        actionId: 'action-b',
        actionKind: 'push-and-open-pr',
        expectedHeadSha: HEAD,
        attemptId: 'att-B',
      }),
    ).toEqual({ outcome: 'refused', reason: 'grant-attempt-mismatch' });

    expect(
      await port.consumeActionAuthorization({
        authorizationGrantId: 'grant-1',
        actionId: 'action-a',
        actionKind: 'push-and-open-pr',
        expectedHeadSha: HEAD,
        attemptId: 'att-A',
      }),
    ).toEqual({ outcome: 'consumed', actionId: 'action-a' });
    const stored = await runtime.coordination.coordinationRequestRepository.findRequestByGrantId('grant-1');
    expect(stored?.consumptions[0]?.attemptId).toBe('att-A');
  });

  it('does not fall back to another collected attempt at the same head when the grant has no resolved attempt', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempDir });
    await seed(runtime, 'grant-1');
    // No resolve ran: no coordinates exist for the grant, yet attempts A and B sit at the head.
    const result = await runtime.execution.actionAuthorization.consumeActionAuthorization({
      authorizationGrantId: 'grant-1',
      actionId: 'action-b',
      actionKind: 'push-and-open-pr',
      expectedHeadSha: HEAD,
    });
    expect(result.outcome).toBe('refused');
    const stored = await runtime.coordination.coordinationRequestRepository.findRequestByGrantId('grant-1');
    expect(stored?.consumptions).toHaveLength(0);
  });

  it('uses the resolved attempt when the request names none', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempDir });
    await seed(runtime, 'grant-1');
    await resolveForA(runtime);
    const result = await runtime.execution.actionAuthorization.consumeActionAuthorization({
      authorizationGrantId: 'grant-1',
      actionId: 'action-a',
      actionKind: 'push-and-open-pr',
      expectedHeadSha: HEAD,
    });
    expect(result).toEqual({ outcome: 'consumed', actionId: 'action-a' });
  });
});
