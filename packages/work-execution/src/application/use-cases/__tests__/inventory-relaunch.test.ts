/**
 * Unit tests for CO26: the read-only relaunch inventory
 * (`InventoryRelaunchUseCase`). Fakes cover every rule: conducted versus
 * attempt-recorded populations, unrecorded worktrees (with the clone's own
 * main checkout and out-of-root entries skipped), running-worktrees and
 * unknown-worktree-read risk counts, unknown runner state for a missing or
 * refusing runner, an invalid request, and the read-only contract (the run
 * store's read is asserted to be called exactly once).
 */

import { describe, expect, it } from 'vitest';

import type { AttemptRecord, AttemptRunnerRecord } from '../../../domain/execution-records.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { ConductorDriverLeaseRecord } from '../../../domain/lane-run-lease.js';
import type { ConductorHaltRecord } from '../../../domain/conductor-halt.js';
import type {
  ListedWorktree,
  ListWorktreesRequest,
  ListWorktreesResult,
} from '../../ports/out/WorkspacePort.out-port.js';
import type {
  ExecutionRunnerPort,
  WorktreeRunState,
} from '../../ports/out/ExecutionRunnerPort.out-port.js';
import type { RunnerForAttemptPort } from '../../ports/out/RunnerForAttemptPort.out-port.js';
import type {
  InventoryRelaunchRequest,
  InventoryRelaunchResult,
  RelaunchCloneRef,
} from '../../ports/in/InventoryRelaunchPort.in-port.js';
import { InventoryRelaunchUseCase } from '../InventoryRelaunchUseCase.use-case.js';

const NOW = '2026-10-31T00:00:00.000Z';
const COMMIT = 'a'.repeat(40);

const RECORDED_HOST: AttemptRunnerRecord = {
  kind: 'opencode',
  remotePort: 46000,
  host: null,
  hostName: 'lane-host',
  agent: null,
  model: null,
  variant: null,
};

const HALT_RECORD: ConductorHaltRecord = {
  version: 1,
  halted: true,
  changedAtIso: NOW,
};

const LEASE_RECORD: ConductorDriverLeaseRecord = {
  version: 1,
  holderId: 'driver-1',
  fence: 1,
  leaseUntilIso: '2026-12-31T00:00:00.000Z',
};

const RUN: LaneRunRecord = {
  version: 1,
  runId: 'run-1',
  workOrderId: 'wo-a',
  tier: 1,
  seatPlanRef: 'c'.repeat(64),
  cursors: { 'first-pass': null, fix: null, review: null },
  round: 0,
  attemptIds: ['attempt-1'],
  prNumber: null,
  parked: null,
  parkCount: 0,
  lease: null,
  revision: 1,
  runPolicyRevision: 'pol-1',
};

function attemptFixture(id: string, overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id,
    workOrderId: 'wo-a',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/wt/lane-1',
    baseCommit: COMMIT,
    state: 'collected',
    outcome: null,
    briefDigest: 'b'.repeat(64),
    briefPackagePath: '.lane/brief-package',
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    runner: RECORDED_HOST,
    createdAtIso: NOW,
    updatedAtIso: NOW,
    ...overrides,
  };
}

function cloneFixture(overrides: Partial<RelaunchCloneRef> = {}): RelaunchCloneRef {
  return {
    projectId: 'proj-1',
    hostName: 'lane-host',
    clonePath: '/clones/repo',
    worktreeRoot: '/clones/repo-worktrees',
    recordedHost: RECORDED_HOST,
    ...overrides,
  };
}

function listedWorktree(path: string): ListedWorktree {
  return {
    path,
    head: COMMIT,
    branch: 'fleet/run-1',
    locked: false,
    prunable: false,
  };
}

function makeRunner(inspectState: WorktreeRunState): ExecutionRunnerPort {
  return {
    describeCapabilities: () => ({
      filesystemScope: 'scoped-worktree' as const,
      networkEgressRestricted: true,
      cpuAndMemoryLimited: true,
      processTreeTermination: true,
      authoritativeCompletion: true,
      artifactPersistence: true,
    }),
    async startSession() {
      throw new Error('unused fake runner method');
    },
    async inspectSession() {
      throw new Error('unused fake runner method');
    },
    async stopSession() {
      throw new Error('unused fake runner method');
    },
    async inspectWorktreeRun() {
      return inspectState;
    },
  };
}

function makeRunnerWithoutInspect(): ExecutionRunnerPort {
  return {
    describeCapabilities: () => ({
      filesystemScope: 'scoped-worktree' as const,
      networkEgressRestricted: true,
      cpuAndMemoryLimited: true,
      processTreeTermination: true,
      authoritativeCompletion: true,
      artifactPersistence: true,
    }),
    async startSession() {
      throw new Error('unused fake runner method');
    },
    async inspectSession() {
      throw new Error('unused fake runner method');
    },
    async stopSession() {
      throw new Error('unused fake runner method');
    },
  };
}

function makeRunnerForAttempt(runner: ExecutionRunnerPort): RunnerForAttemptPort {
  return {
    runnerForAttempt() {
      return { ok: true, runner };
    },
  };
}

interface Harness {
  readonly useCase: InventoryRelaunchUseCase;
  /** How many times each store was read so far. */
  readonly readCalls: {
    readonly runs: () => number;
    readonly attempts: () => number;
    readonly listWorktrees: () => number;
  };
}

function harness(options: {
  runs?: LaneRunRecord[];
  attempts?: AttemptRecord[];
  workspaceResult?: ListWorktreesResult;
  workspaceFn?: (request: ListWorktreesRequest) => ListWorktreesResult | Promise<ListWorktreesResult>;
  halted?: boolean;
  driverLease?: ConductorDriverLeaseRecord | null;
  runnerForAttempt?: RunnerForAttemptPort;
  computeDigest?: (text: string) => string;
} = {}): Harness {
  let runCalls = 0;
  const runRepo = {
    async list() {
      runCalls += 1;
      return options.runs ?? [];
    },
  };
  let attemptCalls = 0;
  const attemptRepo = {
    async listAllAttempts() {
      attemptCalls += 1;
      return options.attempts ?? [];
    },
  };
  let listCalls = 0;
  const workspace = {
    async listWorktrees(request: ListWorktreesRequest) {
      listCalls += 1;
      if (options.workspaceFn !== undefined) {
        return options.workspaceFn(request);
      }
      return options.workspaceResult ?? { outcome: 'listed', worktrees: [] };
    },
  };
  const halt = {
    async read() {
      return options.halted === true
        ? { state: 'halted' as const, record: HALT_RECORD }
        : { state: 'clear' as const, record: null };
    },
  };
  const driverLease = {
    async read() {
      return options.driverLease ?? null;
    },
  };
  const useCase = new InventoryRelaunchUseCase({
    runRepo,
    attemptRepo,
    workspace,
    halt,
    driverLease,
    ...(options.runnerForAttempt !== undefined ? { runnerForAttempt: options.runnerForAttempt } : {}),
    computeDigest: options.computeDigest ?? ((_text: string) => 'a'.repeat(64)),
  });
  return {
    useCase,
    readCalls: { runs: () => runCalls, attempts: () => attemptCalls, listWorktrees: () => listCalls },
  };
}

function inventory(h: Harness, request: InventoryRelaunchRequest): Promise<InventoryRelaunchResult> {
  return h.useCase.inventoryRelaunch(request);
}

describe('InventoryRelaunchUseCase', () => {
  it('classifies an attempt of a recorded run as conducted and an unrun attempt as attempt-recorded', async () => {
    const h = harness({
      runs: [{ ...RUN, attemptIds: ['attempt-1'] }],
      attempts: [
        attemptFixture('attempt-1', { worktreePath: '/clones/repo-worktrees/wt-a' }),
        attemptFixture('attempt-2', { worktreePath: '/clones/repo-worktrees/wt-b' }),
      ],
      workspaceResult: {
        outcome: 'listed',
        worktrees: [
          listedWorktree('/clones/repo'),
          listedWorktree('/clones/repo-worktrees/wt-a'),
          listedWorktree('/clones/repo-worktrees/wt-b'),
        ],
      },
      runnerForAttempt: makeRunnerForAttempt(makeRunner({ state: 'idle' })),
    });
    const result = await inventory(h, { nowIso: NOW, hostName: null, clones: [cloneFixture()] });
    if (result.outcome !== 'inventoried') throw new Error('expected inventoried');
    expect(result.hosts).toHaveLength(1);
    const host = result.hosts[0];
    expect(host.hostName).toBe('lane-host');
    expect(host.counts).toEqual({ conducted: 1, attemptRecorded: 1, unrecorded: 0 });
    expect(host.riskFlags).toEqual([]);
    expect(host.lanes).toEqual([
      {
        population: 'conducted',
        laneId: 'run-1',
        hostName: 'lane-host',
        worktreePath: '/clones/repo-worktrees/wt-a',
        runId: 'run-1',
        attemptId: 'attempt-1',
        runnerState: 'idle',
      },
      {
        population: 'attempt-recorded',
        laneId: 'attempt-2',
        hostName: 'lane-host',
        worktreePath: '/clones/repo-worktrees/wt-b',
        runId: null,
        attemptId: 'attempt-2',
        runnerState: 'idle',
      },
    ]);
  });

  it('lists an unrecorded worktree with a digest lane id and skips the clone main checkout', async () => {
    const h = harness({
      attempts: [],
      workspaceResult: {
        outcome: 'listed',
        worktrees: [listedWorktree('/clones/repo'), listedWorktree('/clones/repo-worktrees/wt-1')],
      },
      runnerForAttempt: makeRunnerForAttempt(makeRunner({ state: 'idle' })),
    });
    const result = await inventory(h, { nowIso: NOW, hostName: null, clones: [cloneFixture()] });
    if (result.outcome !== 'inventoried') throw new Error('expected inventoried');
    expect(result.hosts).toHaveLength(1);
    const host = result.hosts[0];
    expect(host.cloneCount).toBe(1);
    expect(host.worktreeCount).toBe(2);
    expect(host.counts).toEqual({ conducted: 0, attemptRecorded: 0, unrecorded: 1 });
    expect(host.lanes).toEqual([
      {
        population: 'unrecorded',
        laneId: 'worktree-aaaaaaaaaaaa',
        hostName: 'lane-host',
        worktreePath: '/clones/repo-worktrees/wt-1',
        runId: null,
        attemptId: null,
        runnerState: 'idle',
      },
    ]);
  });

  it('skips a listed worktree outside the clone worktree root', async () => {
    const h = harness({
      attempts: [],
      workspaceResult: {
        outcome: 'listed',
        worktrees: [
          listedWorktree('/clones/repo'),
          listedWorktree('/elsewhere/wt'),
          listedWorktree('/clones/repo-worktrees/wt-1'),
        ],
      },
      runnerForAttempt: makeRunnerForAttempt(makeRunner({ state: 'idle' })),
    });
    const result = await inventory(h, { nowIso: NOW, hostName: null, clones: [cloneFixture()] });
    if (result.outcome !== 'inventoried') throw new Error('expected inventoried');
    const host = result.hosts[0];
    expect(host.counts.unrecorded).toBe(1);
    expect(host.lanes.map((lane) => lane.worktreePath)).toEqual(['/clones/repo-worktrees/wt-1']);
  });

  it('counts a running lane in the running-worktrees flag with the path on the row', async () => {
    const h = harness({
      runs: [{ ...RUN, attemptIds: ['attempt-1'] }],
      attempts: [attemptFixture('attempt-1', { worktreePath: '/clones/repo-worktrees/wt-lane-1' })],
      workspaceResult: {
        outcome: 'listed',
        worktrees: [listedWorktree('/clones/repo'), listedWorktree('/clones/repo-worktrees/wt-lane-1')],
      },
      runnerForAttempt: makeRunnerForAttempt(makeRunner({ state: 'running', sessionId: 'ses-1' })),
    });
    const result = await inventory(h, { nowIso: NOW, hostName: null, clones: [cloneFixture()] });
    if (result.outcome !== 'inventoried') throw new Error('expected inventoried');
    const host = result.hosts[0];
    expect(host.riskFlags).toEqual([{ code: 'running-worktrees', count: 1 }]);
    expect(host.lanes[0]).toMatchObject({
      worktreePath: '/clones/repo-worktrees/wt-lane-1',
      runnerState: 'running',
    });
  });

  it('counts an unreadable listing as unknown-worktree-read and never throws', async () => {
    const h = harness({
      attempts: [],
      workspaceResult: { outcome: 'unknown', reason: 'git worktree list failed' },
      runnerForAttempt: makeRunnerForAttempt(makeRunner({ state: 'idle' })),
    });
    const result = await inventory(h, { nowIso: NOW, hostName: null, clones: [cloneFixture()] });
    if (result.outcome !== 'inventoried') throw new Error('expected inventoried');
    const host = result.hosts[0];
    expect(host.counts).toEqual({ conducted: 0, attemptRecorded: 0, unrecorded: 0 });
    expect(host.cloneCount).toBe(1);
    expect(host.worktreeCount).toBe(0);
    expect(host.riskFlags).toEqual([{ code: 'unknown-worktree-read', count: 1 }]);
    expect(host.lanes).toEqual([]);
  });

  it('reports unknown runner state when the runner has no inspect or refuses', async () => {
    const h = harness({
      runs: [{ ...RUN, attemptIds: ['attempt-1'] }],
      attempts: [
        attemptFixture('attempt-1', {
          worktreePath: '/clones/repo-worktrees/wt-a',
          runner: { ...RECORDED_HOST, hostName: 'host-a' },
        }),
        attemptFixture('attempt-2', {
          worktreePath: '/clones/repo-worktrees/wt-b',
          runner: { ...RECORDED_HOST, hostName: 'host-b' },
        }),
      ],
      workspaceResult: {
        outcome: 'listed',
        worktrees: [
          listedWorktree('/clones/repo'),
          listedWorktree('/clones/repo-worktrees/wt-a'),
          listedWorktree('/clones/repo-worktrees/wt-b'),
        ],
      },
      runnerForAttempt: {
        runnerForAttempt(request) {
          if (request.runner?.hostName === 'host-a') {
            return { ok: true, runner: makeRunnerWithoutInspect() };
          }
          return { ok: false, reason: 'recorded host unavailable' };
        },
      },
    });
    const result = await inventory(h, { nowIso: NOW, hostName: null, clones: [cloneFixture()] });
    if (result.outcome !== 'inventoried') throw new Error('expected inventoried');
    const states = result.hosts.flatMap((host) => host.lanes.map((lane) => lane.runnerState));
    expect(states.sort()).toEqual(['unknown', 'unknown']);
  });

  it('refuses an invalid request (a nowIso without a zone)', async () => {
    const h = harness();
    const result = await inventory(h, {
      nowIso: '2026-10-31T00:00:00', // no zone
      hostName: null,
      clones: [],
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
  });

  it('reads only and calls the run store list exactly once', async () => {
    const h = harness({
      runs: [{ ...RUN, attemptIds: ['attempt-1'] }],
      attempts: [attemptFixture('attempt-1', { worktreePath: '/clones/repo-worktrees/wt-a' })],
      workspaceResult: {
        outcome: 'listed',
        worktrees: [listedWorktree('/clones/repo'), listedWorktree('/clones/repo-worktrees/wt-a')],
      },
      runnerForAttempt: makeRunnerForAttempt(makeRunner({ state: 'idle' })),
    });
    const result = await inventory(h, { nowIso: NOW, hostName: null, clones: [cloneFixture()] });
    if (result.outcome !== 'inventoried') throw new Error('expected inventoried');
    expect(result.hosts[0].lanes).toHaveLength(1);
    expect(h.readCalls.runs()).toBe(1);
    expect(h.readCalls.attempts()).toBe(1);
  });

  it('counts a clone whose host is absent from the installation as an unknown listing and never lists locally', async () => {
    const h = harness({
      attempts: [],
      workspaceResult: {
        outcome: 'listed',
        worktrees: [listedWorktree('/clones/repo'), listedWorktree('/clones/repo-worktrees/wt-1')],
      },
      runnerForAttempt: makeRunnerForAttempt(makeRunner({ state: 'idle' })),
    });
    const result = await inventory(h, { nowIso: NOW, hostName: null, clones: [cloneFixture({ recordedHost: null })] });
    if (result.outcome !== 'inventoried') throw new Error('expected inventoried');
    const host = result.hosts[0];
    expect(host.cloneCount).toBe(1);
    expect(host.worktreeCount).toBe(0);
    expect(host.counts).toEqual({ conducted: 0, attemptRecorded: 0, unrecorded: 0 });
    expect(host.riskFlags).toEqual([{ code: 'unknown-worktree-read', count: 1 }]);
    expect(host.lanes).toEqual([]);
    expect(h.readCalls.listWorktrees()).toBe(0);
  });

  it('drops a recorded attempt whose worktree no longer appears in the current clone listing', async () => {
    const h = harness({
      runs: [{ ...RUN, attemptIds: ['attempt-1'] }],
      attempts: [attemptFixture('attempt-1', { worktreePath: '/clones/repo-worktrees/gone' })],
      workspaceResult: {
        outcome: 'listed',
        worktrees: [listedWorktree('/clones/repo'), listedWorktree('/clones/repo-worktrees/wt-1')],
      },
      runnerForAttempt: makeRunnerForAttempt(makeRunner({ state: 'idle' })),
    });
    const result = await inventory(h, { nowIso: NOW, hostName: null, clones: [cloneFixture()] });
    if (result.outcome !== 'inventoried') throw new Error('expected inventoried');
    const host = result.hosts[0];
    expect(host.counts).toEqual({ conducted: 0, attemptRecorded: 0, unrecorded: 1 });
    expect(host.lanes.map((lane) => lane.worktreePath)).toEqual(['/clones/repo-worktrees/wt-1']);
    expect(host.lanes[0]).toMatchObject({ population: 'unrecorded' });
  });

  it('keeps a recorded lane whose worktree is still listed without duplicating it as unrecorded', async () => {
    const h = harness({
      runs: [{ ...RUN, attemptIds: ['attempt-1'] }],
      attempts: [attemptFixture('attempt-1', { worktreePath: '/clones/repo-worktrees/wt-a' })],
      workspaceResult: {
        outcome: 'listed',
        worktrees: [listedWorktree('/clones/repo'), listedWorktree('/clones/repo-worktrees/wt-a')],
      },
      runnerForAttempt: makeRunnerForAttempt(makeRunner({ state: 'idle' })),
    });
    const result = await inventory(h, { nowIso: NOW, hostName: null, clones: [cloneFixture()] });
    if (result.outcome !== 'inventoried') throw new Error('expected inventoried');
    const host = result.hosts[0];
    expect(host.counts).toEqual({ conducted: 1, attemptRecorded: 0, unrecorded: 0 });
    expect(host.lanes).toHaveLength(1);
    expect(host.lanes[0]).toMatchObject({
      population: 'conducted',
      worktreePath: '/clones/repo-worktrees/wt-a',
    });
  });

  it('reports the conductor status and the global risk flags as counts', async () => {
    const h = harness({
      runs: [{ ...RUN, attemptIds: [] }],
      attempts: [],
      halted: true,
      driverLease: LEASE_RECORD,
    });
    const result = await inventory(h, { nowIso: NOW, hostName: null, clones: [] });
    expect(result).toEqual({
      outcome: 'inventoried',
      nowIso: NOW,
      conductor: { halted: true, driverLease: 'live', runCount: 1 },
      riskFlags: [
        { code: 'conductor-halted', count: 1 },
        { code: 'driver-lease-live', count: 1 },
      ],
      hosts: [],
    });
  });
});
