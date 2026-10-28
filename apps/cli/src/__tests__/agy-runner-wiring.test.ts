/**
 * AG-5: the CLI root wires the agy runner, the two-kind runner selector and
 * the edit-only commit step. No live dispatch: the runtime is built with
 * in-memory state (no `stateDir`) and only objects are inspected. The one
 * stop test points `FLEET_AGY_RUN_BIN` at a path that does not exist, so
 * the executor's spawn fails before any process runs; nothing else reaches
 * an executor.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AGY_SECURITY_TEXT_VERSION,
  type FleetInstallation,
  type ForgeSectionV2,
  type HostSection,
} from '@fleet/installation';
import type {
  AttemptRecord,
  CapacityReservationRecord,
  WorkOrderRecord,
} from '@fleet/work-execution';

import { createFleetCliRuntime } from '../composition.js';

const BASE = '0'.repeat(40);

/** Minimal v2 installation: one local opencode host carrying every role. */
function makeInstallation(forge: ForgeSectionV2): FleetInstallation {
  return {
    schemaVersion: 2,
    hosts: {
      local: {
        transport: 'local',
        worktreeRoot: '/tmp/fleet-o8-worktrees',
        roles: ['orchestrator', 'lane-runner'],
        runner: {
          kind: 'opencode',
          port: 46000,
          capabilities: {
            networkEgressRestricted: true,
            cpuAndMemoryLimited: true,
            processTreeTermination: true,
            filesystemScope: 'scoped-worktree',
          },
          maxLanes: 2,
        },
      },
    },
    forge,
  };
}

/** One agy lane-runner host: local transport, declared isolation floor (D7). */
function agyHostFixture(
  name: string,
  port: number,
  mode: 'edit-only' | 'full',
): HostSection {
  return {
    transport: 'local',
    worktreeRoot: `/tmp/fleet-agy-worktrees/${name}`,
    roles: ['lane-runner'],
    runner: {
      kind: 'agy',
      agyMode: mode,
      port,
      capabilities: {
        networkEgressRestricted: true,
        cpuAndMemoryLimited: true,
        processTreeTermination: true,
        filesystemScope: 'scoped-worktree',
      },
      ...(mode === 'full'
        ? {
            agyAcknowledgement: {
              textVersion: AGY_SECURITY_TEXT_VERSION,
              acceptedAt: '2026-10-16T00:00:00Z',
            },
          }
        : {}),
    },
  };
}

/** The base installation plus a second agy lane-runner host `agy-example`. */
function makeInstallationWithAgy(mode: 'edit-only' | 'full'): FleetInstallation {
  const base = makeInstallation({ mode: 'none' });
  return {
    ...base,
    hosts: {
      ...base.hosts,
      'agy-example': agyHostFixture('agy-example', 46100, mode),
    },
  };
}

/** Two agy lane-runner hosts, in that key order, after the opencode host. */
function makeTwoAgyHostsInstallation(): FleetInstallation {
  const base = makeInstallation({ mode: 'none' });
  return {
    ...base,
    hosts: {
      ...base.hosts,
      'agy-first': agyHostFixture('agy-first', 46101, 'edit-only'),
      'agy-second': agyHostFixture('agy-second', 46102, 'edit-only'),
    },
  };
}

function storedWorkOrder(overrides: Partial<WorkOrderRecord> = {}): WorkOrderRecord {
  return {
    id: 'wo-agy-1',
    projectId: 'proj-agy-1',
    taskId: 'task-agy-1',
    laneId: 'lane-agy-1',
    repository: 'git@example.org:acme/app.git',
    baseCommit: BASE,
    ownedPaths: [],
    policyRevision: 'policy-agy-1',
    prerequisiteWorkOrderIds: [],
    state: 'implementing',
    revision: 1,
    createdAtIso: '2026-10-15T08:00:00.000Z',
    updatedAtIso: '2026-10-15T08:00:00.000Z',
    ...overrides,
  };
}

function heldReservation(
  overrides: Partial<CapacityReservationRecord> = {},
): CapacityReservationRecord {
  return {
    id: 'res-agy-1',
    attemptId: 'attempt-example-1',
    hostId: 'agy-second',
    slotIndex: 0,
    held: true,
    seatTool: 'agy',
    hostName: 'agy-second',
    hostKind: 'agy',
    transport: 'local',
    sshAlias: null,
    port: 46102,
    worktreePath: '/tmp/fleet-agy-worktrees/agy-second/attempt-example-1',
    reservedAtIso: '2026-10-15T08:00:00.000Z',
    releasedAtIso: null,
    ...overrides,
  };
}

function storedAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'attempt-agy-1',
    workOrderId: 'wo-agy-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/tmp/fleet-agy-worktrees/agy-example/attempt-agy-1',
    baseCommit: BASE,
    state: 'running',
    outcome: null,
    briefDigest: 'digest-agy-1',
    briefPackagePath: '.lane/brief.md',
    sessionId: 'conv-example-1',
    completionReceipt: null,
    artifacts: null,
    runner: {
      kind: 'agy',
      remotePort: null,
      host: null,
      hostName: 'agy-example',
      agent: null,
      model: 'provider/model',
      variant: null,
    },
    createdAtIso: '2026-10-15T08:00:00.000Z',
    updatedAtIso: '2026-10-15T08:00:00.000Z',
    ...overrides,
  };
}

describe('AG-5: agy runner wiring in the CLI root', () => {
  let previousAgyRunBin: string | undefined;

  beforeEach(() => {
    previousAgyRunBin = process.env.FLEET_AGY_RUN_BIN;
    process.env.FLEET_AGY_RUN_BIN = '/nonexistent/fleet-example/agy-run';
  });

  afterEach(() => {
    if (previousAgyRunBin === undefined) {
      delete process.env.FLEET_AGY_RUN_BIN;
    } else {
      process.env.FLEET_AGY_RUN_BIN = previousAgyRunBin;
    }
  });

  it('without an agy host dispatch and commitEditOnlyAttempt exist and recorded agy hosts are refused', () => {
    const runtime = createFleetCliRuntime({ installation: makeInstallation({ mode: 'none' }) });
    expect(runtime.execution.dispatchAttempt).toBeDefined();
    expect(runtime.execution.commitEditOnlyAttempt).toBeDefined();
    const resolution = runtime.execution.runnerForAttempt.runnerForAttempt({
      runner: {
        kind: 'agy',
        hostName: 'missing',
        remotePort: null,
        host: null,
        agent: null,
        model: null,
        variant: null,
      },
    });
    expect(resolution.ok).toBe(false);
  });

  it('with an edit-only agy host a recorded agy attempt resolves to an agy runner', () => {
    const runtime = createFleetCliRuntime({ installation: makeInstallationWithAgy('edit-only') });
    const resolution = runtime.execution.runnerForAttempt.runnerForAttempt({
      runner: {
        kind: 'agy',
        hostName: 'agy-example',
        remotePort: null,
        host: null,
        agent: null,
        model: null,
        variant: null,
      },
    });
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.runner.describeRunner?.()?.kind).toBe('agy');
    }
  });

  it('commitEditOnlyAttempt refuses a missing attempt', async () => {
    const runtime = createFleetCliRuntime({ installation: makeInstallationWithAgy('edit-only') });
    const result = await runtime.execution.commitEditOnlyAttempt.commitEditOnlyAttempt({
      attemptId: 'no-such-attempt',
    });
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toBe('attempt-missing');
    }
  });

  it('commitEditOnlyAttempt is not applicable to a full agy host', async () => {
    const runtime = createFleetCliRuntime({ installation: makeInstallationWithAgy('full') });
    await runtime.execution.attemptRepository.saveAttempt(
      storedAttempt({
        id: 'attempt-full-1',
        worktreePath: '/tmp/fleet-agy-worktrees/agy-example/attempt-full-1',
        state: 'ended',
        outcome: 'done',
        sessionId: 'conv-full-1',
        completionReceipt: {
          attemptId: 'attempt-full-1',
          sessionId: 'conv-full-1',
          endedAtIso: '2026-10-16T08:00:00.000Z',
          authoritative: true,
          exitStatus: 0,
          stoppedByRequest: false,
        },
      }),
    );
    const result = await runtime.execution.commitEditOnlyAttempt.commitEditOnlyAttempt({
      attemptId: 'attempt-full-1',
    });
    expect(result.outcome).toBe('not-applicable');
  });

  it('the installation still validates with both hosts', () => {
    expect(() =>
      createFleetCliRuntime({ installation: makeInstallationWithAgy('edit-only') }),
    ).not.toThrow();
  });

  it('two agy hosts wire only the first for dispatch; recorded attempts on the second still resolve', async () => {
    const runtime = createFleetCliRuntime({ installation: makeTwoAgyHostsInstallation() });

    await runtime.execution.workOrderRepository.saveWorkOrder(storedWorkOrder());
    await runtime.execution.executionJournal.saveCapacityReservation(heldReservation());

    const result = await runtime.execution.dispatchAttempt.dispatchAttempt({
      attemptId: 'attempt-example-1',
      workOrderId: 'wo-agy-1',
      worktreePath: '/tmp/fleet-agy-worktrees/agy-second/attempt-example-1',
      briefPackagePath: '.lane/brief.md',
      briefDigest: 'digest-agy-1',
      baseCommit: BASE,
      stepLimit: 40,
      timeLimitSeconds: 3600,
      installationSchemaVersion: 2,
    });
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(
        result.reason.startsWith(
          'Reservation host agy-second is not the configured runner host agy-first',
        ),
      ).toBe(true);
    }

    await runtime.execution.attemptRepository.saveAttempt(
      storedAttempt({
        id: 'attempt-example-2',
        worktreePath: '/tmp/fleet-agy-worktrees/agy-second/attempt-example-2',
        runner: {
          kind: 'agy',
          remotePort: null,
          host: null,
          hostName: 'agy-second',
          agent: null,
          model: 'provider/model',
          variant: null,
        },
      }),
    );
    const resolution = runtime.execution.runnerForAttempt.runnerForAttempt({
      runner: {
        kind: 'agy',
        remotePort: null,
        host: null,
        hostName: 'agy-second',
        agent: null,
        model: 'provider/model',
        variant: null,
      },
    });
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.runner.describeRunner?.()?.hostName).toBe('agy-second');
    }
  });

  it('a recorded agy attempt reaches the agy runner through the stop path', async () => {
    const runtime = createFleetCliRuntime({ installation: makeInstallationWithAgy('edit-only') });
    await runtime.execution.attemptRepository.saveAttempt(
      storedAttempt({
        id: 'attempt-stop-1',
        worktreePath: '/tmp/fleet-agy-worktrees/agy-example/attempt-stop-1',
        sessionId: 'conv-example-1',
      }),
    );
    const result = await runtime.execution.stopAttempt.stopAttempt({ attemptId: 'attempt-stop-1' });
    expect(['unknown', 'still-running']).toContain(result.outcome);
    if (result.outcome === 'unknown' || result.outcome === 'still-running') {
      expect(result.reason).toContain('agy-run --abort');
    }
  });
});
