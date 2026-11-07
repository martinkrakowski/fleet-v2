/**
 * Unit tests for CO26: the read-only relaunch inventory
 * (`InventoryRelaunchUseCase`). Fakes cover every rule: conducted versus
 * attempt-recorded populations, unrecorded worktrees (with the clone's own
 * main checkout and out-of-root entries skipped), running-worktrees and
 * unknown-worktree-read risk counts, unknown runner state for a missing or
 * refusing runner, an invalid request, and the read-only contract (the run
 * store's read is asserted to be called exactly once). The CO26 review
 * findings each have a case: the host filter, a throwing listing, a host
 * absent from the installation, a reused path (branch and session proof),
 * the conducted row's own run, and reads that throw never escaping.
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
    // The unrun attempt's claim on its path is not proven by any fact: counted.
    expect(host.riskFlags).toEqual([{ code: 'unproven-lane-records', count: 1 }]);
    expect(host.lanes).toEqual([
      {
        population: 'conducted',
        laneId: 'run-1',
        hostName: 'lane-host',
        worktreePath: '/clones/repo-worktrees/wt-a',
        runId: 'run-1',
        attemptId: 'attempt-1',
        runnerState: 'idle',
        ownership: 'proven',
      },
      {
        population: 'attempt-recorded',
        laneId: 'attempt-2',
        hostName: 'lane-host',
        worktreePath: '/clones/repo-worktrees/wt-b',
        runId: null,
        attemptId: 'attempt-2',
        runnerState: 'idle',
        ownership: 'unknown',
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
        ownership: 'none',
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
      attempts: [attemptFixture('attempt-1', { worktreePath: '/clones/repo-worktrees/wt-lane-1', sessionId: 'ses-1' })],
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
      workspaceFn: (request) => ({
        outcome: 'listed',
        worktrees: [
          listedWorktree('/clones/repo'),
          listedWorktree(
            request.recordedHost?.hostName === 'host-a' ? '/clones/repo-worktrees/wt-a' : '/clones/repo-worktrees/wt-b',
          ),
        ],
      }),
      runnerForAttempt: {
        runnerForAttempt(request) {
          if (request.runner?.hostName === 'host-a') {
            return { ok: true, runner: makeRunnerWithoutInspect() };
          }
          return { ok: false, reason: 'recorded host unavailable' };
        },
      },
    });
    const result = await inventory(h, {
      nowIso: NOW,
      hostName: null,
      clones: [
        cloneFixture({ hostName: 'host-a', recordedHost: { ...RECORDED_HOST, hostName: 'host-a' } }),
        cloneFixture({ hostName: 'host-b', recordedHost: { ...RECORDED_HOST, hostName: 'host-b' } }),
      ],
    });
    if (result.outcome !== 'inventoried') throw new Error('expected inventoried');
    expect(result.hosts.map((host) => host.lanes.length)).toEqual([1, 1]);
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
  it('reports only the requested host: other hosts\' clones and attempts are left out', async () => {
    const h = harness({
      runs: [{ ...RUN, attemptIds: ['attempt-1'] }],
      attempts: [
        attemptFixture('attempt-1', {
          worktreePath: '/clones/repo-worktrees/wt-a',
          runner: { ...RECORDED_HOST, hostName: 'other-host' },
        }),
      ],
      workspaceResult: {
        outcome: 'listed',
        worktrees: [listedWorktree('/clones/repo'), listedWorktree('/clones/repo-worktrees/wt-b')],
      },
      runnerForAttempt: makeRunnerForAttempt(makeRunner({ state: 'idle' })),
    });
    const result = await inventory(h, {
      nowIso: NOW,
      hostName: 'lane-host',
      clones: [
        cloneFixture(),
        cloneFixture({ hostName: 'other-host', recordedHost: { ...RECORDED_HOST, hostName: 'other-host' } }),
      ],
    });
    if (result.outcome !== 'inventoried') throw new Error('expected inventoried');
    expect(result.hosts.map((host) => host.hostName)).toEqual(['lane-host']);
    expect(result.hosts[0].counts).toEqual({ conducted: 0, attemptRecorded: 0, unrecorded: 1 });
    expect(h.readCalls.listWorktrees()).toBe(1);
  });

  it('never lets an attempt recorded on another host claim the same path on this host', async () => {
    const h = harness({
      runs: [{ ...RUN, attemptIds: ['attempt-1'] }],
      attempts: [
        attemptFixture('attempt-1', {
          worktreePath: '/clones/repo-worktrees/wt-a',
          runner: { ...RECORDED_HOST, hostName: 'other-host' },
        }),
      ],
      workspaceResult: {
        outcome: 'listed',
        worktrees: [listedWorktree('/clones/repo'), listedWorktree('/clones/repo-worktrees/wt-a')],
      },
      runnerForAttempt: makeRunnerForAttempt(makeRunner({ state: 'idle' })),
    });
    const result = await inventory(h, { nowIso: NOW, hostName: null, clones: [cloneFixture()] });
    if (result.outcome !== 'inventoried') throw new Error('expected inventoried');
    expect(result.hosts.map((host) => host.hostName)).toEqual(['lane-host']);
    expect(result.hosts[0].lanes[0]).toMatchObject({ population: 'unrecorded', hostName: 'lane-host' });
  });

  it('counts a throwing listWorktrees as an unknown listing and never throws', async () => {
    const h = harness({
      attempts: [],
      workspaceFn: () => {
        throw new Error('ssh failed');
      },
      runnerForAttempt: makeRunnerForAttempt(makeRunner({ state: 'idle' })),
    });
    const result = await inventory(h, { nowIso: NOW, hostName: null, clones: [cloneFixture()] });
    if (result.outcome !== 'inventoried') throw new Error('expected inventoried');
    expect(result.hosts[0].riskFlags).toEqual([{ code: 'unknown-worktree-read', count: 1 }]);
    expect(result.hosts[0].lanes).toEqual([]);
  });

  it('drops a conducted record whose reaped path was reused on another branch', async () => {
    const h = harness({
      runs: [{ ...RUN, attemptIds: ['attempt-1'] }],
      attempts: [attemptFixture('attempt-1', { worktreePath: '/clones/repo-worktrees/wt-a' })],
      workspaceResult: {
        outcome: 'listed',
        worktrees: [
          listedWorktree('/clones/repo'),
          { ...listedWorktree('/clones/repo-worktrees/wt-a'), branch: 'fleet/hand-lane-9' },
        ],
      },
      runnerForAttempt: makeRunnerForAttempt(makeRunner({ state: 'running', sessionId: 'ses-new' })),
    });
    const result = await inventory(h, { nowIso: NOW, hostName: null, clones: [cloneFixture()] });
    if (result.outcome !== 'inventoried') throw new Error('expected inventoried');
    const host = result.hosts[0];
    expect(host.counts).toEqual({ conducted: 0, attemptRecorded: 0, unrecorded: 1 });
    expect(host.lanes[0]).toMatchObject({ population: 'unrecorded', runId: null, attemptId: null, ownership: 'none' });
  });

  it('reports a detached conducted claim as unproven rather than trusting the path', async () => {
    const h = harness({
      runs: [{ ...RUN, attemptIds: ['attempt-1'] }],
      attempts: [attemptFixture('attempt-1', { worktreePath: '/clones/repo-worktrees/wt-a' })],
      workspaceResult: {
        outcome: 'listed',
        worktrees: [listedWorktree('/clones/repo'), { ...listedWorktree('/clones/repo-worktrees/wt-a'), branch: null }],
      },
      runnerForAttempt: makeRunnerForAttempt(makeRunner({ state: 'idle' })),
    });
    const result = await inventory(h, { nowIso: NOW, hostName: null, clones: [cloneFixture()] });
    if (result.outcome !== 'inventoried') throw new Error('expected inventoried');
    expect(result.hosts[0].lanes[0]).toMatchObject({ population: 'conducted', ownership: 'unknown' });
    expect(result.hosts[0].riskFlags).toEqual([{ code: 'unproven-lane-records', count: 1 }]);
  });

  it('drops an attempt-recorded claim when another session runs in its reused path', async () => {
    const h = harness({
      attempts: [
        attemptFixture('attempt-2', { worktreePath: '/clones/repo-worktrees/wt-b', sessionId: 'ses-old' }),
      ],
      workspaceResult: {
        outcome: 'listed',
        worktrees: [listedWorktree('/clones/repo'), listedWorktree('/clones/repo-worktrees/wt-b')],
      },
      runnerForAttempt: makeRunnerForAttempt(makeRunner({ state: 'running', sessionId: 'ses-new' })),
    });
    const result = await inventory(h, { nowIso: NOW, hostName: null, clones: [cloneFixture()] });
    if (result.outcome !== 'inventoried') throw new Error('expected inventoried');
    const host = result.hosts[0];
    expect(host.counts).toEqual({ conducted: 0, attemptRecorded: 0, unrecorded: 1 });
    expect(host.lanes[0]).toMatchObject({
      population: 'unrecorded',
      laneId: 'worktree-aaaaaaaaaaaa',
      attemptId: null,
      runnerState: 'running',
      ownership: 'none',
    });
  });

  it('proves an attempt-recorded claim when its own session runs there', async () => {
    const h = harness({
      attempts: [
        attemptFixture('attempt-2', { worktreePath: '/clones/repo-worktrees/wt-b', sessionId: 'ses-own' }),
      ],
      workspaceResult: {
        outcome: 'listed',
        worktrees: [listedWorktree('/clones/repo'), listedWorktree('/clones/repo-worktrees/wt-b')],
      },
      runnerForAttempt: makeRunnerForAttempt(makeRunner({ state: 'running', sessionId: 'ses-own' })),
    });
    const result = await inventory(h, { nowIso: NOW, hostName: null, clones: [cloneFixture()] });
    if (result.outcome !== 'inventoried') throw new Error('expected inventoried');
    expect(result.hosts[0].lanes[0]).toMatchObject({
      population: 'attempt-recorded',
      attemptId: 'attempt-2',
      ownership: 'proven',
    });
    expect(result.hosts[0].riskFlags).toEqual([{ code: 'running-worktrees', count: 1 }]);
  });

  it('takes the conducted row from the run\'s own latest attempt, not a later hand-run attempt', async () => {
    const h = harness({
      runs: [{ ...RUN, attemptIds: ['attempt-1'] }],
      attempts: [
        attemptFixture('attempt-1', { worktreePath: '/clones/repo-worktrees/wt-a', createdAtIso: NOW }),
        attemptFixture('attempt-9', {
          worktreePath: '/clones/repo-worktrees/wt-a',
          createdAtIso: '2026-10-31T01:00:00.000Z',
        }),
      ],
      workspaceResult: {
        outcome: 'listed',
        worktrees: [listedWorktree('/clones/repo'), listedWorktree('/clones/repo-worktrees/wt-a')],
      },
      runnerForAttempt: makeRunnerForAttempt(makeRunner({ state: 'idle' })),
    });
    const result = await inventory(h, { nowIso: NOW, hostName: null, clones: [cloneFixture()] });
    if (result.outcome !== 'inventoried') throw new Error('expected inventoried');
    expect(result.hosts[0].lanes).toEqual([
      expect.objectContaining({ population: 'conducted', laneId: 'run-1', runId: 'run-1', attemptId: 'attempt-1' }),
    ]);
  });

  it('picks the run whose branch is checked out when two runs recorded the same path', async () => {
    const h = harness({
      runs: [
        { ...RUN, runId: 'run-1', attemptIds: ['attempt-1'] },
        { ...RUN, runId: 'run-2', attemptIds: ['attempt-2'] },
      ],
      attempts: [
        attemptFixture('attempt-1', { worktreePath: '/clones/repo-worktrees/wt-a', createdAtIso: NOW }),
        attemptFixture('attempt-2', {
          worktreePath: '/clones/repo-worktrees/wt-a',
          createdAtIso: '2026-10-30T00:00:00.000Z',
        }),
      ],
      workspaceResult: {
        outcome: 'listed',
        worktrees: [
          listedWorktree('/clones/repo'),
          { ...listedWorktree('/clones/repo-worktrees/wt-a'), branch: 'fleet/run-2' },
        ],
      },
      runnerForAttempt: makeRunnerForAttempt(makeRunner({ state: 'idle' })),
    });
    const result = await inventory(h, { nowIso: NOW, hostName: null, clones: [cloneFixture()] });
    if (result.outcome !== 'inventoried') throw new Error('expected inventoried');
    expect(result.hosts[0].lanes[0]).toMatchObject({ runId: 'run-2', attemptId: 'attempt-2', ownership: 'proven' });
  });

  it('refuses rather than throws when the records cannot be read', async () => {
    const useCase = new InventoryRelaunchUseCase({
      runRepo: {
        async list() {
          throw new Error('disk gone');
        },
      },
      attemptRepo: { listAllAttempts: async () => [] },
      workspace: { listWorktrees: async () => ({ outcome: 'listed', worktrees: [] }) },
      halt: { read: async () => ({ state: 'clear' as const, record: null }) },
      driverLease: { read: async () => null },
      computeDigest: () => 'a'.repeat(64),
    });
    await expect(useCase.inventoryRelaunch({ nowIso: NOW, hostName: null, clones: [] })).resolves.toEqual({
      outcome: 'refused',
      reason: 'records-unreadable',
    });
  });

  // CO29a-ro2: any read failure that is not genuine absence (ENOENT) makes
  // the whole inventory answer `unknown` — a throwing halt or lease read is
  // never guessed as halted or left `inventoried` with an unknown lease.
  it('answers unknown with both reason codes when the halt and lease reads throw non-absence errors', async () => {
    const useCase = new InventoryRelaunchUseCase({
      runRepo: { list: async () => [] },
      attemptRepo: { listAllAttempts: async () => [] },
      workspace: { listWorktrees: async () => ({ outcome: 'listed', worktrees: [] }) },
      halt: {
        async read() {
          throw Object.assign(new Error('unreadable halt'), { code: 'EACCES' });
        },
      },
      driverLease: {
        async read() {
          throw Object.assign(new Error('unreadable lease'), { code: 'EACCES' });
        },
      },
      computeDigest: () => 'a'.repeat(64),
    });
    await expect(useCase.inventoryRelaunch({ nowIso: NOW, hostName: null, clones: [] })).resolves.toEqual({
      outcome: 'unknown',
      reasons: ['halt-unreadable', 'lease-unreadable'],
    });
  });

  it('answers unknown with halt-unreadable when only the halt read throws an EACCES-style error', async () => {
    const useCase = new InventoryRelaunchUseCase({
      runRepo: { list: async () => [] },
      attemptRepo: { listAllAttempts: async () => [] },
      workspace: { listWorktrees: async () => ({ outcome: 'listed', worktrees: [] }) },
      halt: {
        async read() {
          throw Object.assign(new Error('unreadable halt'), { code: 'EACCES' });
        },
      },
      driverLease: { read: async () => null },
      computeDigest: () => 'a'.repeat(64),
    });
    await expect(useCase.inventoryRelaunch({ nowIso: NOW, hostName: null, clones: [] })).resolves.toEqual({
      outcome: 'unknown',
      reasons: ['halt-unreadable'],
    });
  });

  it('answers unknown with lease-unreadable when only the lease read throws an EACCES-style error', async () => {
    const useCase = new InventoryRelaunchUseCase({
      runRepo: { list: async () => [] },
      attemptRepo: { listAllAttempts: async () => [] },
      workspace: { listWorktrees: async () => ({ outcome: 'listed', worktrees: [] }) },
      halt: { read: async () => ({ state: 'clear' as const, record: null }) },
      driverLease: {
        async read() {
          throw Object.assign(new Error('unreadable lease'), { code: 'EACCES' });
        },
      },
      computeDigest: () => 'a'.repeat(64),
    });
    await expect(useCase.inventoryRelaunch({ nowIso: NOW, hostName: null, clones: [] })).resolves.toEqual({
      outcome: 'unknown',
      reasons: ['lease-unreadable'],
    });
  });

  it('plans normally when the halt and lease reads report genuine absence (ENOENT)', async () => {
    const useCase = new InventoryRelaunchUseCase({
      runRepo: { list: async () => [] },
      attemptRepo: { listAllAttempts: async () => [] },
      workspace: { listWorktrees: async () => ({ outcome: 'listed', worktrees: [] }) },
      halt: {
        async read() {
          throw Object.assign(new Error('absent marker'), { code: 'ENOENT' });
        },
      },
      driverLease: {
        async read() {
          throw Object.assign(new Error('absent lease'), { code: 'ENOENT' });
        },
      },
      computeDigest: () => 'a'.repeat(64),
    });
    const result = await useCase.inventoryRelaunch({ nowIso: NOW, hostName: null, clones: [] });
    if (result.outcome !== 'inventoried') throw new Error('expected inventoried');
    expect(result.conductor).toEqual({ halted: false, driverLease: 'absent', runCount: 0 });
    expect(result.riskFlags).toEqual([]);
  });

  // CO29a-ro2: an unreadable halt marker or driver lease is never a value.
  it('answers unknown with halt-unreadable when the halt marker reads unreadable', async () => {
    const useCase = new InventoryRelaunchUseCase({
      runRepo: { list: async () => [] },
      attemptRepo: { listAllAttempts: async () => [] },
      workspace: { listWorktrees: async () => ({ outcome: 'listed', worktrees: [] }) },
      halt: { read: async () => ({ state: 'unreadable' as const }) },
      driverLease: { read: async () => null },
      computeDigest: () => 'a'.repeat(64),
    });
    await expect(useCase.inventoryRelaunch({ nowIso: NOW, hostName: null, clones: [] })).resolves.toEqual({
      outcome: 'unknown',
      reasons: ['halt-unreadable'],
    });
  });

  it('answers unknown with lease-unreadable when the lease read throws the typed unreadable error', async () => {
    const useCase = new InventoryRelaunchUseCase({
      runRepo: { list: async () => [] },
      attemptRepo: { listAllAttempts: async () => [] },
      workspace: { listWorktrees: async () => ({ outcome: 'listed', worktrees: [] }) },
      halt: { read: async () => ({ state: 'clear' as const, record: null }) },
      driverLease: {
        async read() {
          throw Object.assign(new Error('unreadable lease'), { name: 'StateFileUnreadableReadOnlyError' });
        },
      },
      computeDigest: () => 'a'.repeat(64),
    });
    await expect(useCase.inventoryRelaunch({ nowIso: NOW, hostName: null, clones: [] })).resolves.toEqual({
      outcome: 'unknown',
      reasons: ['lease-unreadable'],
    });
  });

  it('answers unknown with both reason codes when halt and lease are both unreadable', async () => {
    const useCase = new InventoryRelaunchUseCase({
      runRepo: { list: async () => [] },
      attemptRepo: { listAllAttempts: async () => [] },
      workspace: { listWorktrees: async () => ({ outcome: 'listed', worktrees: [] }) },
      halt: { read: async () => ({ state: 'unreadable' as const }) },
      driverLease: {
        async read() {
          throw Object.assign(new Error('unreadable lease'), { name: 'StateFileUnreadableError' });
        },
      },
      computeDigest: () => 'a'.repeat(64),
    });
    await expect(useCase.inventoryRelaunch({ nowIso: NOW, hostName: null, clones: [] })).resolves.toEqual({
      outcome: 'unknown',
      reasons: ['halt-unreadable', 'lease-unreadable'],
    });
  });

  it('keeps a conducted claim the branch disproved when the runner reports its own session running there', async () => {
    const h = harness({
      runs: [{ ...RUN, attemptIds: ['attempt-1'] }],
      attempts: [
        attemptFixture('attempt-1', { worktreePath: '/clones/repo-worktrees/wt-a', sessionId: 'ses-run-1' }),
      ],
      workspaceResult: {
        outcome: 'listed',
        worktrees: [
          listedWorktree('/clones/repo'),
          { ...listedWorktree('/clones/repo-worktrees/wt-a'), branch: 'fleet/renamed' },
        ],
      },
      runnerForAttempt: makeRunnerForAttempt(makeRunner({ state: 'running', sessionId: 'ses-run-1' })),
    });
    const result = await inventory(h, { nowIso: NOW, hostName: null, clones: [cloneFixture()] });
    if (result.outcome !== 'inventoried') throw new Error('expected inventoried');
    expect(result.hosts[0].counts).toEqual({ conducted: 1, attemptRecorded: 0, unrecorded: 0 });
    expect(result.hosts[0].lanes[0]).toMatchObject({
      population: 'conducted',
      laneId: 'run-1',
      runId: 'run-1',
      attemptId: 'attempt-1',
      ownership: 'proven',
    });
  });

  it('counts the rows whose runner state is unknown', async () => {
    const h = harness({
      attempts: [],
      workspaceResult: {
        outcome: 'listed',
        worktrees: [listedWorktree('/clones/repo'), listedWorktree('/clones/repo-worktrees/wt-1')],
      },
    });
    const result = await inventory(h, { nowIso: NOW, hostName: null, clones: [cloneFixture()] });
    if (result.outcome !== 'inventoried') throw new Error('expected inventoried');
    expect(result.hosts[0].riskFlags).toEqual([
      { code: 'unrecorded-worktrees', count: 1 },
      { code: 'unknown-runner-state', count: 1 },
    ]);
  });
  it('reports a branch-proven conducted claim as unproven when another session runs there', async () => {
    const h = harness({
      runs: [{ ...RUN, attemptIds: ['attempt-1', 'attempt-2'] }],
      attempts: [
        attemptFixture('attempt-1', { worktreePath: '/clones/repo-worktrees/wt-a', sessionId: 'ses-1' }),
        attemptFixture('attempt-2', {
          worktreePath: '/clones/repo-worktrees/wt-a',
          sessionId: 'ses-2',
          createdAtIso: '2026-10-31T01:00:00.000Z',
        }),
      ],
      workspaceResult: {
        outcome: 'listed',
        worktrees: [listedWorktree('/clones/repo'), listedWorktree('/clones/repo-worktrees/wt-a')],
      },
      runnerForAttempt: makeRunnerForAttempt(makeRunner({ state: 'running', sessionId: 'ses-foreign' })),
    });
    const result = await inventory(h, { nowIso: NOW, hostName: null, clones: [cloneFixture()] });
    if (result.outcome !== 'inventoried') throw new Error('expected inventoried');
    expect(result.hosts[0].lanes[0]).toMatchObject({
      population: 'conducted',
      runId: 'run-1',
      attemptId: 'attempt-2',
      ownership: 'unknown',
    });
    expect(result.hosts[0].riskFlags).toEqual([
      { code: 'running-worktrees', count: 1 },
      { code: 'unproven-lane-records', count: 1 },
    ]);
  });

  it('keeps a branch-proven conducted claim proven when an earlier attempt of the run is the running session', async () => {
    const h = harness({
      runs: [{ ...RUN, attemptIds: ['attempt-1', 'attempt-2'] }],
      attempts: [
        attemptFixture('attempt-1', { worktreePath: '/clones/repo-worktrees/wt-a', sessionId: 'ses-1' }),
        attemptFixture('attempt-2', {
          worktreePath: '/clones/repo-worktrees/wt-a',
          sessionId: 'ses-2',
          createdAtIso: '2026-10-31T01:00:00.000Z',
        }),
      ],
      workspaceResult: {
        outcome: 'listed',
        worktrees: [listedWorktree('/clones/repo'), listedWorktree('/clones/repo-worktrees/wt-a')],
      },
      runnerForAttempt: makeRunnerForAttempt(makeRunner({ state: 'running', sessionId: 'ses-1' })),
    });
    const result = await inventory(h, { nowIso: NOW, hostName: null, clones: [cloneFixture()] });
    if (result.outcome !== 'inventoried') throw new Error('expected inventoried');
    expect(result.hosts[0].lanes[0]).toMatchObject({ population: 'conducted', ownership: 'proven' });
  });
});
