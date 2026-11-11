import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CoordinationRequestRecord } from '@fleet/operator-coordination';
import type { AttemptRecord, WorkOrderRecord } from '@fleet/work-execution';
import { coordinationCommands } from './commands/coordination.js';
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

  it('CO24g: an unbound owner grant resolved without an attempt refuses; with the attempt it binds', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempDir });
    await seed(runtime, 'grant-1');

    // The resolve omits the attempt: the real CLI composition's coordination
    // use case refuses the unbound owner grant without binding or consuming it.
    const refused = await runtime.coordination.resolveActionAuthorization.resolveActionAuthorization({
      projectId: 'project-1',
      actionScope: 'forge:push-and-open-pr',
      expectedHeadSha: HEAD,
    });
    expect(refused).toEqual({ outcome: 'blocked', reason: 'attempt-required' });

    const untouched = await runtime.coordination.coordinationRequestRepository.findRequestByGrantId('grant-1');
    expect(untouched?.grantAttemptId).toBeUndefined();
    expect(untouched?.consumptions).toHaveLength(0);

    // The same grant still resolves with the right attempt, and binds durably.
    expect(
      await runtime.coordination.resolveActionAuthorization.resolveActionAuthorization({
        projectId: 'project-1',
        actionScope: 'forge:push-and-open-pr',
        expectedHeadSha: HEAD,
        attemptId: 'att-A',
      }),
    ).toEqual({
      outcome: 'authorized',
      grantId: 'grant-1',
      requestId: 'req-grant-1',
      expectedHeadSha: HEAD,
      policyRevision: 'pol-1',
    });
    const bound = await runtime.coordination.coordinationRequestRepository.findRequestByGrantId('grant-1');
    expect(bound?.grantRecordVersion).toBe(2);
    expect(bound?.grantAttemptId).toBe('att-A');
  });
});

// CO24e: the grant record names its attempt, so a grant is bound even when no
// resolve ran in this process. Runs through the real CLI composition: the real
// ActionAuthorizationAdapter, delegate, coordination use cases and file-backed
// repositories in a temp directory; only the gh subprocess is a spy.
describe('CLI composition: grant record names its attempt (CO24e)', () => {
  let tempDir: string;
  const runGh = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: '' }) as never);

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-cli-co24e-'));
    runGh.mockClear();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function runtimeOf() {
    return createFleetCliRuntime({
      stateDir: tempDir,
      forgeActionDelegate: { runGh, verifyCurrentHeadSha: async () => ({ outcome: 'verified' }) as never },
    });
  }

  async function seedAttempts(runtime: ReturnType<typeof createFleetCliRuntime>): Promise<void> {
    for (const suffix of ['A', 'B']) {
      await runtime.execution.workOrderRepository.saveWorkOrder(workOrder(`wo-${suffix}`));
      await runtime.execution.attemptRepository.saveAttempt(attempt(`att-${suffix}`, `wo-${suffix}`));
    }
  }

  function forgeFor(suffix: 'A' | 'B', grantId: string) {
    return {
      actionId: `action-${suffix}`,
      attemptId: `att-${suffix}`,
      workOrderId: `wo-${suffix}`,
      kind: 'push-and-open-pr' as const,
      expectedHeadSha: HEAD,
      authorizationGrantId: grantId,
      branchName: `feat/lane-${suffix}`,
    };
  }

  it('refuses attempt B on an owner grant recorded for attempt A, with no resolve in this process: forge never called', async () => {
    const runtime = runtimeOf();
    await seedAttempts(runtime);
    await runtime.coordination.coordinationRequestRepository.saveRequest({
      ...grant('grant-1'),
      grantRecordVersion: 2,
      grantAttemptId: 'att-A',
    });

    const result = await runtime.execution.executeAuthorizedForgeAction.executeAuthorizedForgeAction(
      forgeFor('B', 'grant-1'),
    );

    expect(result).toEqual({ outcome: 'refused', reason: 'grant-attempt-mismatch' });
    expect(runGh).not.toHaveBeenCalled();
    const stored = await runtime.coordination.coordinationRequestRepository.findRequestByGrantId('grant-1');
    expect(stored?.consumptions).toHaveLength(0);
  });

  it('refuses attempt B on a policy grant issued for attempt A', async () => {
    const runtime = runtimeOf();
    await seedAttempts(runtime);
    await runtime.coordination.coordinationRequestRepository.saveRequest({
      ...grant('grant-p'),
      decisionRevision: 'policy:conductor@309ab8c40bf2',
      policyGrant: { workOrderId: 'wo-A', attemptId: 'att-A', acceptanceReceiptId: 'receipt-1' },
      grantRecordVersion: 2,
      grantAttemptId: 'att-A',
    });
    const refused = await runtime.execution.executeAuthorizedForgeAction.executeAuthorizedForgeAction(
      forgeFor('B', 'grant-p'),
    );
    expect(refused).toEqual({ outcome: 'refused', reason: 'grant-attempt-mismatch' });
    expect(runGh).not.toHaveBeenCalled();
  });

  it('refuses a version-2 grant that records no attempt, whoever asks', async () => {
    const runtime = runtimeOf();
    await seedAttempts(runtime);
    await runtime.coordination.coordinationRequestRepository.saveRequest({
      ...grant('grant-1'),
      grantRecordVersion: 2,
    });
    const result = await runtime.execution.actionAuthorization.consumeActionAuthorization({
      authorizationGrantId: 'grant-1',
      actionId: 'action-a',
      actionKind: 'push-and-open-pr',
      expectedHeadSha: HEAD,
      attemptId: 'att-A',
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'grant-attempt-unrecorded' });
    expect(
      (await runtime.coordination.coordinationRequestRepository.findRequestByGrantId('grant-1'))?.consumptions,
    ).toHaveLength(0);
  });

  it('residual path: a coordinate-less legacy grant is consumed by attempt B at the exact head (CO24d rule, kept for old grants)', async () => {
    const runtime = runtimeOf();
    await seedAttempts(runtime);
    await runtime.coordination.coordinationRequestRepository.saveRequest(grant('grant-1'));
    // No resolve ran and the record names no attempt: scope and exact head are all that bind it.
    const result = await runtime.execution.actionAuthorization.consumeActionAuthorization({
      authorizationGrantId: 'grant-1',
      actionId: 'action-b',
      actionKind: 'push-and-open-pr',
      expectedHeadSha: HEAD,
      attemptId: 'att-B',
    });
    expect(result).toEqual({ outcome: 'consumed', actionId: 'action-b' });
  });

  it('closes the residual: the same grant, once resolved for A (new version), refuses B even in a fresh process without the coordinates file', async () => {
    const first = runtimeOf();
    await seedAttempts(first);
    await first.coordination.coordinationRequestRepository.saveRequest(grant('grant-1'));
    expect(
      await first.execution.actionAuthorization.resolveActionAuthorization({
        actionId: 'action-resolve',
        projectId: 'project-1',
        workOrderId: 'wo-A',
        attemptId: 'att-A',
        actionKind: 'push-and-open-pr',
        expectedHeadSha: HEAD,
        policyRevision: 'pol-1',
      }),
    ).toEqual({ outcome: 'granted', authorizationGrantId: 'grant-1' });
    await fs.rm(path.join(tempDir, 'authorization-coordinates.json'), { force: true });

    const second = runtimeOf();
    const stored = await second.coordination.coordinationRequestRepository.findRequestByGrantId('grant-1');
    expect(stored).toMatchObject({ grantRecordVersion: 2, grantAttemptId: 'att-A' });
    const result = await second.execution.executeAuthorizedForgeAction.executeAuthorizedForgeAction(
      forgeFor('B', 'grant-1'),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'grant-attempt-mismatch' });
    expect(runGh).not.toHaveBeenCalled();
  });

  it('a decision requested with an attempt records it, so forge execute without resolve-auth is bound', async () => {
    const runtime = runtimeOf();
    await seedAttempts(runtime);
    const requested = await coordinationCommands['request-decision'](
      {
        requestId: 'req-owner',
        projectId: 'project-1',
        kind: 'action-decision',
        actionScope: 'forge:push-and-open-pr',
        expectedHeadSha: HEAD,
        proposalDigest: 'prop-1',
        policyRevision: 'pol-1',
        attemptId: 'att-A',
      },
      runtime,
    );
    expect(requested).toMatchObject({ outcome: 'requested' });
    const stored = await runtime.coordination.coordinationRequestRepository.findRequestById('req-owner');
    expect(stored).toMatchObject({ grantRecordVersion: 2, grantAttemptId: 'att-A' });
  });
});
