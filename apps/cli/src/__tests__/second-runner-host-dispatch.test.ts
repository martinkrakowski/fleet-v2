/**
 * MR1D: a v2 installation with two `ssh` `opencode` lane-runner hosts composes,
 * reserves across both (most-free-slots), and dispatches the second host's
 * reservation through that host's own runner — its own port, alias and auth
 * file in the runner subprocess environment, never the first host's. No live
 * dispatch: every runner subprocess runs through an injected `runSubprocess`
 * spy, and the workspace reads come from a fake `WorkspacePort`.
 *
 * For each new test below, the single production line whose change would make
 * it fail (the PR-notes lines):
 * - capacity spread over both hosts (reservations 1-2 on runner-a, 3 on
 *   runner-b, 4th refused): `ReserveExecutionCapacityUseCase.use-case.ts`
 *   line 292 (`const freeSlots = candidate.maxLanes - (heldPerHostName.get(candidate.name) ?? 0);`).
 * - second-host dispatch uses runner-b's own runner (port 4266, alias
 *   `runner-b.example`, auth file `/run/fleet/runner-b-auth`):
 *   `composition.ts` line ~721 (`runnerForHost: (hostName) => { const resolved = runnerForAttempt.runnerForHostName(hostName); ...`).
 * - declared `inherited-directory` is refused with the isolation reason:
 *   `DispatchAttemptUseCase.use-case.ts` line 446 (`return { outcome: 'refused', reason: 'Runner capabilities do not satisfy required isolation' };`).
 * - the saved attempt carries `runner.hostName === 'runner-b'` and
 *   `remotePort === 4266`: `ExecutionRunnerAdapter.adapter.ts`
 *   `startedSessionResult` (`hostName: this.configuredHostName()`).
 * - both tunnel targets and the set adapter:
 *   `composition.ts` `resolveRunnerTunnelTargets` / the `tunnelTargets.length >= 2`
 *   set-adapter branch at the `runnerTunnel` composition.
 * - single-host composition unchanged (4166 / `runner-a.example`):
 *   `ExecutorSelector.adapter.ts` `resolveExecutionRunnerHost` (the first
 *   lane-runner host is the selected one).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FleetInstallation, HostSection } from '@fleet/installation';
import type { WorkOrderRecord, AttemptRecord, LaneRunRecord } from '@fleet/work-execution';
import {
  DispatchAttemptUseCase,
  LaneRunAdmissionAdapter,
  simpleDeterministicHexDigest,
  type LaneRunAdmissionAdapterOptions,
  type WorkspacePort,
} from '@fleet/work-execution';

import { isTunnelHostUp, laneRunnerCandidateHosts } from '../conductor-wiring.js';
import {
  createFleetCliRuntime,
  resolveRunnerTunnelTargets,
  type FleetCliRuntime,
} from '../composition.js';
import { RunnerTunnelSetAdapter } from '../runner-tunnel.js';

const BASE = '0'.repeat(40);

const ISOLATION_FLOOR = {
  networkEgressRestricted: true,
  cpuAndMemoryLimited: true,
  processTreeTermination: true,
  filesystemScope: 'scoped-worktree',
} as const;

function runnerHost(
  name: 'runner-a' | 'runner-b',
  port: number,
  maxLanes: number,
  capabilities: NonNullable<HostSection["runner"]>["capabilities"] = ISOLATION_FLOOR,
): HostSection {
  return {
    transport: 'ssh',
    sshAlias: `${name}.example`,
    worktreeRoot: `/srv/fleet/${name}`,
    roles: ['lane-runner'],
    runner: {
      kind: 'opencode',
      port,
      authFile: `/run/fleet/${name}-auth`,
      maxLanes,
      capabilities,
    },
  };
}

function twoHostInstallation(
  runnerBCapabilities: NonNullable<HostSection["runner"]>["capabilities"] = ISOLATION_FLOOR,
): FleetInstallation {
  return {
    schemaVersion: 2,
    forge: { mode: 'none' },
    hosts: {
      orch: {
        transport: 'local',
        worktreeRoot: '/srv/fleet/orchestrator',
        roles: ['orchestrator'],
      },
      'runner-a': runnerHost('runner-a', 4166, 2),
      'runner-b': runnerHost('runner-b', 4266, 1, runnerBCapabilities),
    },
  };
}

function singleHostInstallation(): FleetInstallation {
  return {
    schemaVersion: 2,
    forge: { mode: 'none' },
    hosts: {
      orch: {
        transport: 'local',
        worktreeRoot: '/srv/fleet/orchestrator',
        roles: ['orchestrator'],
      },
      'runner-a': runnerHost('runner-a', 4166, 1),
    },
  };
}

function storedWorkOrder(overrides: Partial<WorkOrderRecord> = {}): WorkOrderRecord {
  return {
    id: 'wo-mr1d-1',
    projectId: 'proj-mr1d-1',
    taskId: 'task-mr1d-1',
    laneId: 'lane-mr1d-1',
    repository: 'git@example.org:acme/app.git',
    baseCommit: BASE,
    ownedPaths: [],
    policyRevision: 'policy-mr1d-1',
    prerequisiteWorkOrderIds: [],
    state: 'implementing',
    revision: 1,
    createdAtIso: '2026-11-01T08:00:00.000Z',
    updatedAtIso: '2026-11-01T08:00:00.000Z',
    ...overrides,
  };
}

/** The worktree path a reserve allocates for one attempt id under a host root. */
function worktreePathFor(worktreeRoot: string, attemptId: string): string {
  return `${worktreeRoot.replace(/\/+$/, '')}/${simpleDeterministicHexDigest(attemptId).slice(0, 32)}`;
}

const BRIEF_PROSE = '# Frozen brief\n\nExecute the lane.\n';
const BRIEF_MANIFEST = JSON.stringify({
  modelAssignment: { model: 'provider/glm-5.3', seatTool: 'opencode' },
});
const BRIEF_DIGEST = simpleDeterministicHexDigest(`${BRIEF_PROSE}\n${BRIEF_MANIFEST}`);

/** A clean worktree holding the frozen brief prose and its manifest. */
function fakeWorkspace(worktreePath: string): WorkspacePort {
  return {
    inspectWorktree: async () => ({
      worktreePath,
      checkedOutCommit: BASE,
      matchesBaseCommit: true,
      uncommittedPaths: [],
      untrackedPaths: [],
      residueFromEarlierAttempts: [],
      missingExpectedArtifacts: [],
    }),
    readWorktreeFile: async (_path: string, file: string) =>
      file.endsWith('-manifest.json') ? BRIEF_MANIFEST : BRIEF_PROSE,
  } as unknown as WorkspacePort;
}

function startedSubprocess(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ sessionID: 'ses-mr1d-1' }),
    stderr: '',
  }));
}

/** One dispatch through the composed stores, the fake workspace and a per-host runner. */
function manualDispatch(
  runtime: FleetCliRuntime,
  workspace: WorkspacePort,
): DispatchAttemptUseCase {
  return new DispatchAttemptUseCase({
    workOrderRepo: runtime.execution.workOrderRepository,
    attemptRepo: runtime.execution.attemptRepository,
    journal: runtime.execution.executionJournal,
    workspace,
    runner: runtime.execution.runner,
    runnerForHost: (hostName) => {
      const resolved = runtime.execution.runnerForAttempt.runnerForHostName(hostName);
      return resolved.ok ? resolved.runner : null;
    },
  });
}

function dispatchRequest(
  attemptId: string,
  worktreePath: string,
): Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0] {
  return {
    attemptId,
    workOrderId: 'wo-mr1d-1',
    worktreePath,
    briefPackagePath: '.lane/brief.md',
    briefDigest: BRIEF_DIGEST,
    baseCommit: BASE,
    stepLimit: 40,
    timeLimitSeconds: 3600,
    installationSchemaVersion: 2,
  };
}

/** Reserve n attempts, returning each reserve result in order. */
async function reserve(
  runtime: FleetCliRuntime,
  count: number,
  prefix: string,
): Promise<readonly unknown[]> {
  const candidates = laneRunnerCandidateHosts(runtime.installation);
  expect(candidates).toBeDefined();
  const results: unknown[] = [];
  for (let index = 1; index <= count; index += 1) {
    const attemptId = `${prefix}-${index}`;
    results.push(
      await runtime.execution.reserveExecutionCapacity.reserveExecutionCapacity({
        reservationId: `res-${attemptId}`,
        attemptId,
        workOrderId: 'wo-mr1d-1',
        seatTool: 'opencode',
        candidateHosts: candidates,
      }),
    );
  }
  return results;
}

describe('MR1D: second runner host registry, capacity and dispatch', () => {
  const stateDirs: string[] = [];

  afterEach(() => {
    for (const dir of stateDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function compose(installation: FleetInstallation): FleetCliRuntime {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-mr1d-'));
    stateDirs.push(stateDir);
    return createFleetCliRuntime({ stateDir, installation });
  }

  it('reserves across both hosts by most free slots and refuses a fourth reservation', async () => {
    const runtime = compose(twoHostInstallation());
    await runtime.execution.workOrderRepository.saveWorkOrder(storedWorkOrder());
    const [first, second, third, fourth] = (await reserve(
      runtime,
      4,
      'attempt-cap',
    )) as Array<{ outcome: string; reservation?: { hostName: string; port: number | null } }>;
    expect(first?.outcome).toBe('reserved');
    expect(first?.reservation?.hostName).toBe('runner-a');
    expect(first?.reservation?.port).toBe(4166);
    expect(second?.outcome).toBe('reserved');
    expect(second?.reservation?.hostName).toBe('runner-a');
    expect(second?.reservation?.port).toBe(4166);
    expect(third?.outcome).toBe('reserved');
    expect(third?.reservation?.hostName).toBe('runner-b');
    expect(third?.reservation?.port).toBe(4266);
    expect(fourth).toEqual({ outcome: 'no-capacity' });
  });

  it('dispatches the runner-b reservation through runner-b only', async () => {
    const runSubprocess = startedSubprocess();
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-mr1d-'));
    stateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({
      stateDir,
      installation: twoHostInstallation(),
      runSubprocess: runSubprocess as never,
    });
    await runtime.execution.workOrderRepository.saveWorkOrder(storedWorkOrder());
    const reservations = (await reserve(runtime, 3, 'attempt-b')) as Array<
      { outcome: string; reservation?: { hostName: string; worktreePath: string } }
    >;
    const runnerBReservation = reservations[2]?.reservation;
    expect(runnerBReservation?.hostName).toBe('runner-b');
    const worktreePath = worktreePathFor('/srv/fleet/runner-b', 'attempt-b-3');
    expect(runnerBReservation?.worktreePath).toBe(worktreePath);

    const dispatch = manualDispatch(runtime, fakeWorkspace(worktreePath));
    const result = await dispatch.dispatchAttempt(dispatchRequest('attempt-b-3', worktreePath));
    expect(result.outcome).toBe('started');

    expect(runSubprocess).toHaveBeenCalled();
    const envs = runSubprocess.mock.calls.map(
      (call: unknown[]) => call[2] as Record<string, string>,
    );
    const startEnvs = envs.filter((env) => env?.OCM_REMOTE_PORT !== undefined);
    expect(startEnvs.length).toBeGreaterThan(0);
    for (const env of startEnvs) {
      expect(env.OCM_REMOTE_PORT).toBe('4266');
      expect(env.OCM_HOST).toBe('runner-b.example');
      expect(env.OPENCODE_AUTH_FILE).toBe('/run/fleet/runner-b-auth');
    }
    for (const env of envs) {
      expect(env?.OCM_REMOTE_PORT).not.toBe('4166');
      expect(env?.OCM_HOST).not.toBe('runner-a.example');
      expect(env?.OPENCODE_AUTH_FILE).not.toBe('/run/fleet/runner-a-auth');
    }

    const stored = await runtime.execution.attemptRepository.findAttemptById('attempt-b-3');
    expect(stored?.runner?.hostName).toBe('runner-b');
    expect(stored?.runner?.remotePort).toBe(4266);
  });

  it('refuses a runner-b dispatch when runner-b declares inherited-directory', async () => {
    const runtime = compose(
      twoHostInstallation({
        ...ISOLATION_FLOOR,
        filesystemScope: 'inherited-directory',
      }),
    );
    await runtime.execution.workOrderRepository.saveWorkOrder(storedWorkOrder());
    const reservations = (await reserve(runtime, 3, 'attempt-iso')) as Array<
      { outcome: string; reservation?: { hostName: string } }
    >;
    expect(reservations[2]?.reservation?.hostName).toBe('runner-b');
    const worktreePath = worktreePathFor('/srv/fleet/runner-b', 'attempt-iso-3');
    const result = await runtime.execution.dispatchAttempt.dispatchAttempt(
      dispatchRequest('attempt-iso-3', worktreePath),
    );
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Runner capabilities do not satisfy required isolation',
    });
  });

  it('wires both tunnel targets and the set adapter for two hosts', () => {
    const installation = twoHostInstallation();
    expect(resolveRunnerTunnelTargets(installation)).toEqual([
      { hostName: 'runner-a', sshHost: 'runner-a.example', remotePort: 4166 },
      { hostName: 'runner-b', sshHost: 'runner-b.example', remotePort: 4266 },
    ]);
    const runtime = compose(installation);
    expect(runtime.runnerTunnel).toBeInstanceOf(RunnerTunnelSetAdapter);
  });

  it('a single-host composition dispatches to runner-a unchanged', async () => {
    const runSubprocess = startedSubprocess();
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-mr1d-'));
    stateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({
      stateDir,
      installation: singleHostInstallation(),
      runSubprocess: runSubprocess as never,
    });
    await runtime.execution.workOrderRepository.saveWorkOrder(storedWorkOrder());
    const reservations = (await reserve(runtime, 1, 'attempt-a')) as Array<
      { outcome: string; reservation?: { hostName: string } }
    >;
    expect(reservations[0]?.reservation?.hostName).toBe('runner-a');
    const worktreePath = worktreePathFor('/srv/fleet/runner-a', 'attempt-a-1');
    const dispatch = manualDispatch(runtime, fakeWorkspace(worktreePath));
    const result = await dispatch.dispatchAttempt(dispatchRequest('attempt-a-1', worktreePath));
    expect(result.outcome).toBe('started');

    const envs = runSubprocess.mock.calls.map(
      (call: unknown[]) => call[2] as Record<string, string>,
    );
    const startEnvs = envs.filter((env) => env?.OCM_REMOTE_PORT !== undefined);
    expect(startEnvs.length).toBeGreaterThan(0);
    for (const env of startEnvs) {
      expect(env.OCM_REMOTE_PORT).toBe('4166');
      expect(env.OCM_HOST).toBe('runner-a.example');
      expect(env.OPENCODE_AUTH_FILE).toBe('/run/fleet/runner-a-auth');
    }
  });
});

// ---------------------------------------------------------------------------
// IH1b: a down tunnel host is excluded at reservation only
// ---------------------------------------------------------------------------

const IH1B_NOW = '2026-11-20T10:00:00.000Z';

/** A work order whose repository is unique, so no two orders overlap. */
function ih1bWorkOrder(index: number): WorkOrderRecord {
  return {
    ...storedWorkOrder(),
    id: `wo-ih1b-${index}`,
    repository: `git@example.org:acme/ih1b-${index}.git`,
  };
}

describe('IH1b: a down tunnel host is excluded at reservation only', () => {
  const stateDirs: string[] = [];

  afterEach(() => {
    for (const dir of stateDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function compose(installation: FleetInstallation): FleetCliRuntime {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-ih1b-'));
    stateDirs.push(stateDir);
    return createFleetCliRuntime({ stateDir, installation });
  }

  /** The admission adapter over the runtime's real stores, with an optional up-set filter. */
  function admissionOf(
    runtime: FleetCliRuntime,
    isHostUp?: (hostName: string) => boolean,
  ): LaneRunAdmissionAdapter {
    let seq = 0;
    return new LaneRunAdmissionAdapter({
      reserve: runtime.execution.reserveExecutionCapacity,
      runRepo: runtime.conductor.laneRunRepository,
      runJournal: runtime.conductor.laneRunJournal,
      workOrderRepo: runtime.execution.workOrderRepository,
      attemptRepo: runtime.execution.attemptRepository,
      executionJournal: runtime.execution.executionJournal,
      maxActiveRuns: 8,
      candidateHosts: laneRunnerCandidateHosts(runtime.installation),
      newReservationId: () => `res-ih1b-${(seq += 1)}`,
      ...(isHostUp === undefined ? {} : { isHostUp }),
    });
  }

  it('reserves only on the host whose tunnel is up, preserving tie-break and maxLanes there', async () => {
    const runtime = compose(twoHostInstallation());
    for (const index of [1, 2, 3]) {
      await runtime.execution.workOrderRepository.saveWorkOrder(ih1bWorkOrder(index));
    }
    // runner-b's tunnel is down; only runner-a may be offered to the reserve.
    const admission = admissionOf(runtime, (hostName) => hostName !== 'runner-b');
    const first = await admission.reserveFirst({
      attemptId: 'ih1b-1',
      workOrderId: 'wo-ih1b-1',
      seatTool: 'opencode',
      nowIso: IH1B_NOW,
    });
    expect(first).toMatchObject({ outcome: 'reserved', hostName: 'runner-a', port: 4166 });
    const second = await admission.reserveFirst({
      attemptId: 'ih1b-2',
      workOrderId: 'wo-ih1b-2',
      seatTool: 'opencode',
      nowIso: IH1B_NOW,
    });
    // The up host's own maxLanes (2) is preserved: the second lane still lands there.
    expect(second).toMatchObject({ outcome: 'reserved', hostName: 'runner-a', port: 4166 });
    const third = await admission.reserveFirst({
      attemptId: 'ih1b-3',
      workOrderId: 'wo-ih1b-3',
      seatTool: 'opencode',
      nowIso: IH1B_NOW,
    });
    // runner-a is full and runner-b is down: a wait, never a park.
    expect(third).toEqual({ outcome: 'no-capacity' });
  });

  it('reserveFirst answers no-capacity when every candidate host is down', async () => {
    const runtime = compose(twoHostInstallation());
    await runtime.execution.workOrderRepository.saveWorkOrder(ih1bWorkOrder(1));
    const admission = admissionOf(runtime, () => false);
    const result = await admission.reserveFirst({
      attemptId: 'ih1b-all-down',
      workOrderId: 'wo-ih1b-1',
      seatTool: 'opencode',
      nowIso: IH1B_NOW,
    });
    expect(result).toEqual({ outcome: 'no-capacity' });
  });

  it('reserveFirst follows the tunnel up-set through the wiring helper for a single required ssh host', async () => {
    const runtime = compose(singleHostInstallation());
    await runtime.execution.workOrderRepository.saveWorkOrder(ih1bWorkOrder(1));
    const managed = new Set(
      (laneRunnerCandidateHosts(runtime.installation) ?? [])
        .filter((host) => host.transport === 'ssh' && host.kind === 'opencode')
        .map((host) => host.name),
    );
    expect([...managed]).toEqual(['runner-a']);
    const upSet = new Set<string>(['runner-a']);
    const up = admissionOf(runtime, (hostName) => isTunnelHostUp(hostName, managed, () => upSet));
    expect(await up.reserveFirst({
      attemptId: 'ih1b-single-up',
      workOrderId: 'wo-ih1b-1',
      seatTool: 'opencode',
      nowIso: IH1B_NOW,
    })).toMatchObject({ outcome: 'reserved', hostName: 'runner-a' });

    const downRuntime = compose(singleHostInstallation());
    await downRuntime.execution.workOrderRepository.saveWorkOrder(ih1bWorkOrder(1));
    const emptySet = new Set<string>();
    const down = admissionOf(downRuntime, (hostName) => isTunnelHostUp(hostName, managed, () => emptySet));
    expect(await down.reserveFirst({
      attemptId: 'ih1b-single-down',
      workOrderId: 'wo-ih1b-1',
      seatTool: 'opencode',
      nowIso: IH1B_NOW,
    })).toEqual({ outcome: 'no-capacity' });
  });

  it('isTunnelHostUp is unrestricted before the tunnel starts and fails closed on throwing or malformed upHosts', () => {
    const managed = new Set(['runner-a']);
    const up = (): (() => ReadonlySet<string> | null) => () => new Set(['runner-a']);
    expect(isTunnelHostUp('runner-a', managed, up())).toBe(true);
    // The tunnel has not started (`conductor start`): unrestricted.
    expect(isTunnelHostUp('runner-a', managed, () => null)).toBe(true);
    // A port mock without the optional method: unrestricted.
    expect(isTunnelHostUp('runner-a', managed, undefined)).toBe(true);
    // A down or malformed up-set fails closed.
    expect(isTunnelHostUp('runner-a', managed, () => new Set())).toBe(false);
    expect(isTunnelHostUp('runner-a', managed, (() => 'nope') as unknown as () => ReadonlySet<string> | null)).toBe(false);
    expect(isTunnelHostUp('runner-a', managed, (): never => { throw new Error('upHosts blew up'); })).toBe(false);
    // A host that needs no tunnel (local or agy) is never excluded.
    expect(isTunnelHostUp('here', managed, () => new Set())).toBe(true);
    expect(isTunnelHostUp('agy-host', managed, () => new Set())).toBe(true);
  });

  it('admit still admits a pinned attempt even when its host is not in upHosts', async () => {
    const runtime = compose(twoHostInstallation());
    const worktreePath = '/srv/fleet/runner-a/pinned-attempt';
    const run = {
      runId: 'run-ih1b-1',
      workOrderId: 'wo-ih1b-1',
      attemptIds: ['ih1b-pinned'],
    } as unknown as LaneRunRecord;
    const attempt = {
      workOrderId: 'wo-ih1b-1',
      worktreePath,
      runner: { hostName: 'runner-a' },
    } as unknown as AttemptRecord;
    const reserveCalls: Array<Record<string, unknown>> = [];
    const reserve = {
      reserveExecutionCapacity: async (
        request: { hostId?: string; worktreePath?: string; maxSlots?: number },
      ) => {
        reserveCalls.push(request as Record<string, unknown>);
        return {
          outcome: 'reserved' as const,
          reservation: {
            hostName: request.hostId ?? null,
            hostKind: 'opencode' as const,
            worktreePath: request.worktreePath ?? null,
            transport: 'ssh' as const,
            sshAlias: 'runner-a.example',
            port: 4166,
          },
        };
      },
    } as unknown as LaneRunAdmissionAdapterOptions['reserve'];
    const options: LaneRunAdmissionAdapterOptions = {
      reserve,
      runRepo: { list: async () => [run] },
      runJournal: { listForRun: async () => [] },
      workOrderRepo: { findWorkOrderById: async () => ih1bWorkOrder(1) },
      attemptRepo: { findAttemptById: async () => attempt },
      executionJournal: {
        listActiveReservations: async () => [],
        releaseCapacityReservation: async () => true,
      },
      maxActiveRuns: 1,
      candidateHosts: laneRunnerCandidateHosts(runtime.installation),
      newReservationId: () => 'res-ih1b-admit',
      // Every host reads as down, yet the pinned attempt must still admit.
      isHostUp: () => false,
    };
    const admission = new LaneRunAdmissionAdapter(options);
    const result = await admission.admit({
      attemptId: 'ih1b-pinned',
      workOrderId: 'wo-ih1b-1',
      seatTool: 'opencode',
      worktreePath,
      nowIso: IH1B_NOW,
    });
    expect(result).toEqual({ outcome: 'admitted' });
    expect(reserveCalls[0]?.hostId).toBe('runner-a');
    expect(reserveCalls[0]?.worktreePath).toBe(worktreePath);
  });
});
