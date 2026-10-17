import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  AttemptRecord,
  AttemptRunnerRecord,
  WorkOrderRecord,
} from '../../../domain/execution-records.js';
import type { ExecutionJournalPort } from '../../../application/ports/out/ExecutionJournalPort.out-port.js';
import type { ExecutionRunnerPort, RunnerIsolationCapabilities } from '../../../application/ports/out/ExecutionRunnerPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../../../application/ports/out/WorkOrderRepositoryPort.out-port.js';
import type { WorkspacePort } from '../../../application/ports/out/WorkspacePort.out-port.js';
import { AttemptRepositoryAdapter } from '../AttemptRepositoryAdapter.adapter.js';
import { DispatchAttemptUseCase } from '../../../application/use-cases/DispatchAttemptUseCase.use-case.js';
import { RunnerSelectorAdapter } from '../RunnerSelectorAdapter.adapter.js';
import type { RunnerSelectorLaneRunnerHost } from '../RunnerSelectorAdapter.adapter.js';
import type { RunnerSelectorPort } from '../../../application/ports/out/RunnerSelectorPort.out-port.js';

// ---------------------------------------------------------------------------
// RunnerSelectorAdapter
// ---------------------------------------------------------------------------

describe('RunnerSelectorAdapter', () => {
  const opencodeHosts: Record<string, RunnerSelectorLaneRunnerHost> = {
    lane: { transport: 'ssh', sshAlias: 'lane-host.lan', roles: ['lane-runner'], runner: { kind: 'opencode', port: 4166 } },
  };
  const agyHosts: Record<string, RunnerSelectorLaneRunnerHost> = {
    lane: { transport: 'local', roles: ['lane-runner'], runner: { kind: 'agy', port: 46000 } },
  };

  it('selects the opencode lane-runner host for an opencode seat', () => {
    const selector = new RunnerSelectorAdapter({ hosts: opencodeHosts });
    expect(selector.selectRunner({ seatTool: 'opencode' })).toEqual({
      ok: true,
      kind: 'opencode',
      hostName: 'lane',
      transport: 'ssh',
      sshAlias: 'lane-host.lan',
      remotePort: 4166,
    });
  });

  it('narrowing the union: an agy seat on an agy host is refused as runner-not-available', () => {
    const selector = new RunnerSelectorAdapter({ hosts: agyHosts });
    expect(selector.selectRunner({ seatTool: 'agy' })).toEqual({
      ok: false,
      reason: 'runner-not-available',
    });
  });

  it('selects the agy lane-runner host, on no port, once an agy adapter is provided', () => {
    const selector = new RunnerSelectorAdapter({
      hosts: agyHosts,
      implementedRunnerKinds: ['opencode', 'agy'],
    });
    expect(selector.selectRunner({ seatTool: 'agy' })).toEqual({
      ok: true,
      kind: 'agy',
      hostName: 'lane',
      transport: 'local',
      remotePort: null,
    });
  });

  it('still refuses an agy seat when the root has no agy adapter, and never falls back', () => {
    expect(
      new RunnerSelectorAdapter({
        hosts: agyHosts,
        implementedRunnerKinds: ['opencode'],
      }).selectRunner({ seatTool: 'agy' }),
    ).toEqual({ ok: false, reason: 'runner-not-available' });
    expect(
      new RunnerSelectorAdapter({ hosts: agyHosts, implementedRunnerKinds: ['agy'] }).selectRunner({
        seatTool: 'opencode',
      }),
    ).toEqual({ ok: false, reason: 'runner-not-available' });
  });

  it('leaves the opencode selection unchanged when an agy adapter joins it', () => {
    const selector = new RunnerSelectorAdapter({
      hosts: opencodeHosts,
      implementedRunnerKinds: ['opencode', 'agy'],
    });
    expect(selector.selectRunner({ seatTool: 'opencode' })).toEqual({
      ok: true,
      kind: 'opencode',
      hostName: 'lane',
      transport: 'ssh',
      sshAlias: 'lane-host.lan',
      remotePort: 4166,
    });
  });

  it('refuses a seat whose tool does not match the lane-runner host kind', () => {
    const selector = new RunnerSelectorAdapter({ hosts: opencodeHosts });
    expect(selector.selectRunner({ seatTool: 'agy' })).toEqual({
      ok: false,
      reason: 'runner-not-available',
    });
  });

  it('keeps the legacy env-only opencode behaviour when no v2 lane-runner host exists', () => {
    const selector = new RunnerSelectorAdapter({ hosts: {} });
    expect(selector.selectRunner({ seatTool: 'opencode' })).toEqual({
      ok: true,
      kind: 'opencode',
      hostName: null,
      remotePort: null,
    });
    expect(selector.selectRunner({ seatTool: 'agy' })).toEqual({
      ok: false,
      reason: 'runner-not-available',
    });
  });

  it('treats an absent seat tool as the opencode seat', () => {
    const selector = new RunnerSelectorAdapter({ hosts: opencodeHosts });
    expect(selector.selectRunner({ seatTool: '' })).toMatchObject({ ok: true, kind: 'opencode' });
  });
});

// ---------------------------------------------------------------------------
// Old records without `kind` read as opencode
// ---------------------------------------------------------------------------

describe('AttemptRepositoryAdapter record normalization (O14c1)', () => {
  let tempDir: string;

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('reads a record persisted before `kind` as an opencode runner record', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-attempt-repo-kind-'));
    // Old-shape record: no runner kind, an opencode port number.
    const oldRecord = {
      id: 'att-old',
      workOrderId: 'wo-1',
      kind: 'initial',
      fixNumber: 0,
      priorAttemptId: null,
      worktreePath: '/tmp/worktree-old',
      baseCommit: 'commit-1',
      state: 'running',
      outcome: null,
      briefDigest: null,
      briefPackagePath: null,
      sessionId: 'ses-old',
      completionReceipt: null,
      artifacts: null,
      runner: { remotePort: 4166, host: null, agent: null, model: 'm', variant: null },
      createdAtIso: '2026-10-15T10:00:00.000Z',
      updatedAtIso: '2026-10-15T10:00:00.000Z',
    };
    await fs.writeFile(path.join(tempDir, 'attempts.json'), JSON.stringify([oldRecord]), 'utf8');

    const adapter = new AttemptRepositoryAdapter({ stateDir: tempDir });
    const loaded = await adapter.findAttemptById('att-old');
    expect(loaded?.runner).toEqual({
      kind: 'opencode',
      remotePort: 4166,
      host: null,
      hostName: null,
      agent: null,
      model: 'm',
      variant: null,
    });
  });

  it('reads an old record whose runner has no port as remotePort null, never a crash', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-attempt-repo-port-'));
    const oldRecord = {
      id: 'att-old-portless',
      workOrderId: 'wo-1',
      kind: 'initial',
      fixNumber: 0,
      priorAttemptId: null,
      worktreePath: '/tmp/worktree-old',
      baseCommit: 'commit-1',
      state: 'running',
      outcome: null,
      briefDigest: null,
      briefPackagePath: null,
      sessionId: 'ses-old',
      completionReceipt: null,
      artifacts: null,
      runner: { host: null, agent: null, model: 'm', variant: null },
      createdAtIso: '2026-10-15T10:00:00.000Z',
      updatedAtIso: '2026-10-15T10:00:00.000Z',
    };
    await fs.writeFile(path.join(tempDir, 'attempts.json'), JSON.stringify([oldRecord]), 'utf8');

    const adapter = new AttemptRepositoryAdapter({ stateDir: tempDir });
    const loaded = await adapter.findAttemptById('att-old-portless');
    expect(loaded?.runner).toEqual({
      kind: 'opencode',
      remotePort: null,
      host: null,
      hostName: null,
      agent: null,
      model: 'm',
      variant: null,
    });
  });

  it('keeps an agy kind when a record already carries it', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-attempt-repo-agy-'));
    const agyRecord = {
      id: 'att-agy',
      workOrderId: 'wo-1',
      kind: 'initial',
      fixNumber: 0,
      priorAttemptId: null,
      worktreePath: '/tmp/worktree-agy',
      baseCommit: 'commit-1',
      state: 'running',
      outcome: null,
      briefDigest: null,
      briefPackagePath: null,
      sessionId: 'ses-agy',
      completionReceipt: null,
      artifacts: null,
      runner: { kind: 'agy', remotePort: null, host: null, agent: null, model: 'm', variant: null },
      createdAtIso: '2026-10-15T10:00:00.000Z',
      updatedAtIso: '2026-10-15T10:00:00.000Z',
    };
    await fs.writeFile(path.join(tempDir, 'attempts.json'), JSON.stringify([agyRecord]), 'utf8');

    const adapter = new AttemptRepositoryAdapter({ stateDir: tempDir });
    const loaded = await adapter.findAttemptById('att-agy');
    expect(loaded?.runner?.kind).toBe('agy');
    expect(loaded?.runner?.remotePort).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Dispatch wiring: new records carry kind; an agy seat is refused, nothing spawns
// ---------------------------------------------------------------------------

function storedWorkOrder(overrides: Partial<WorkOrderRecord> = {}): WorkOrderRecord {
  return {
    id: 'wo-1',
    projectId: 'proj-1',
    taskId: 'task-1',
    laneId: 'lane-1',
    repository: '/repo',
    baseCommit: 'abc123',
    ownedPaths: ['src/**'],
    policyRevision: 'policy-1',
    prerequisiteWorkOrderIds: [],
    state: 'implementing',
    revision: 1,
    createdAtIso: '2026-10-15T07:00:00.000Z',
    updatedAtIso: '2026-10-15T07:00:00.000Z',
    ...overrides,
  };
}

function makeWorkOrderRepo() {
  const orders = new Map<string, WorkOrderRecord>();
  return {
    orders,
    port: {
      async findWorkOrderById(id: string) {
        return orders.get(id) ?? null;
      },
    } as WorkOrderRepositoryPort,
  };
}

function makeAttemptRepo() {
  const attempts = new Map<string, AttemptRecord>();
  return {
    attempts,
    port: {
      async findAttemptById(id: string) {
        return attempts.get(id) ?? null;
      },
      async saveAttempt(record: AttemptRecord) {
        attempts.set(record.id, record);
      },
    } as NonNullable<ConstructorParameters<typeof DispatchAttemptUseCase>[0]>['attemptRepo'],
  };
}

function makeJournal(extraReservations: { id: string; attemptId: string }[] = []) {
  const entries: unknown[] = [];
  const port: ExecutionJournalPort = {
    async appendJournalEntry(entry) {
      entries.push(entry);
    },
    async listJournalEntriesForAttempt() {
      return [];
    },
    async listActiveReservations() {
      return [
        {
          id: 'res-1',
          attemptId: 'attempt-1',
          hostId: 'h',
          slotIndex: 0,
          held: true,
          seatTool: 'opencode',
          reservedAtIso: '',
          releasedAtIso: null,
        },
        ...extraReservations.map((reservation, index) => ({
          id: reservation.id,
          attemptId: reservation.attemptId,
          hostId: 'h',
          slotIndex: index + 1,
          held: true,
          seatTool: 'opencode' as const,
          reservedAtIso: '',
          releasedAtIso: null,
        })),
      ];
    },
    async releaseCapacityReservation() {
      return true;
    },
    async saveCapacityReservation() {},
    async reserveCapacityAtomically() {
      throw new Error('reserveCapacityAtomically must not be called');
    },
  };
  return { entries, port };
}

function makeRunnerSpy() {
  const startCalls: unknown[] = [];
  const capabilities: RunnerIsolationCapabilities = {
    filesystemScope: 'scoped-worktree',
    networkEgressRestricted: true,
    cpuAndMemoryLimited: true,
    processTreeTermination: true,
    authoritativeCompletion: true,
    artifactPersistence: true,
  };
  const runnerRecord: AttemptRunnerRecord = {
    kind: 'opencode',
    remotePort: 4166,
    host: null,
    agent: null,
    model: 'm',
    variant: null,
  };
  const port: ExecutionRunnerPort = {
    describeCapabilities: () => capabilities,
    describeRunner: () => runnerRecord,
    async startSession(request) {
      startCalls.push(request);
      return { outcome: 'started', sessionId: 'ses-1', runner: runnerRecord };
    },
    async inspectSession() {
      throw new Error('inspectSession must not be called');
    },
    async stopSession() {
      throw new Error('stopSession must not be called');
    },
  };
  return { startCalls, port };
}

function makeWorkspace() {
  const port: WorkspacePort = {
    async inspectWorktree(request) {
      return {
        worktreePath: request.worktreePath,
        checkedOutCommit: request.baseCommit,
        matchesBaseCommit: true,
        uncommittedPaths: [],
        untrackedPaths: [],
        residueFromEarlierAttempts: [],
        missingExpectedArtifacts: [],
      };
    },
    async readWorktreeFile(_worktreePath: string, relativePath: string) {
      if (relativePath === '.lane/brief-manifest.json' || relativePath === '.lane/brief.md') {
        return JSON.stringify({
          modelAssignment: { model: 'm', agent: null, variant: null },
          independentReviewer: 'reviewer-m',
        });
      }
      return null;
    },
  } as WorkspacePort;
  return { port };
}

function dispatchRequest() {
  return {
    attemptId: 'attempt-1',
    workOrderId: 'wo-1',
    worktreePath: '/lanes/attempt-1',
    briefPackagePath: '.lane/brief.md',
    briefDigest: 'digest-1',
    baseCommit: 'abc123',
    stepLimit: 40,
    timeLimitSeconds: 3600,
    expectedArtifacts: [],
    nowIso: '2026-10-15T08:00:00.000Z',
  };
}

describe('DispatchAttemptUseCase runner selection (O14c1)', () => {
  function makeSetup(selectorHosts?: Record<string, RunnerSelectorLaneRunnerHost>) {
    const workOrderRepo = makeWorkOrderRepo();
    workOrderRepo.orders.set('wo-1', storedWorkOrder());
    const attemptRepo = makeAttemptRepo();
    const journal = makeJournal();
    const runner = makeRunnerSpy();
    const workspace = makeWorkspace();
    const selector = new RunnerSelectorAdapter({ hosts: selectorHosts ?? {} });
    const useCase = new DispatchAttemptUseCase({
      workOrderRepo: workOrderRepo.port,
      attemptRepo: attemptRepo.port,
      journal: journal.port,
      workspace: workspace.port,
      runner: runner.port,
      runnerSelector: selector,
    });
    return { attemptRepo, journal, runner, useCase };
  }

  it('writes kind opencode into the new attempt record', async () => {
    const setup = makeSetup();
    const result = await setup.useCase.dispatchAttempt(dispatchRequest());
    expect(result.outcome).toBe('started');
    const saved = setup.attemptRepo.attempts.get('attempt-1');
    expect(saved?.runner?.kind).toBe('opencode');
    expect(saved?.runner?.remotePort).toBe(4166);
  });

  it('refuses an agy seat with runner-not-available and nothing is spawned', async () => {
    const agyHosts: Record<string, RunnerSelectorLaneRunnerHost> = {
      lane: { transport: 'local', roles: ['lane-runner'], runner: { kind: 'agy', port: 46000 } },
    };
    const setup = makeSetup(agyHosts);
    const result = await setup.useCase.dispatchAttempt(dispatchRequest());
    expect(result).toEqual({ outcome: 'refused', reason: 'runner-not-available' });
    expect(setup.runner.startCalls).toEqual([]);
    expect(setup.journal.entries).toEqual([]);
    expect(setup.attemptRepo.attempts.size).toBe(0);
  });

  it('passes the frozen manifest seat tool to the selector, and only a manifest written before the field existed reads as opencode (H8)', async () => {
    const selectionCalls: string[] = [];
    let manifestSeatTool: unknown;
    const selector: RunnerSelectorPort = {
      selectRunner(request) {
        (selectionCalls as string[]).push(request.seatTool);
        return { ok: true, kind: 'opencode', hostName: null, remotePort: null };
      },
    };
    const workOrderRepo = makeWorkOrderRepo();
    workOrderRepo.orders.set('wo-1', storedWorkOrder());
    const attemptRepo = makeAttemptRepo();
    const workspace = makeWorkspace();
    const baseFile = await workspace.port.readWorktreeFile?.('/lanes/attempt-1', '.lane/brief-manifest.json');
    const base = JSON.parse(baseFile ?? '{}') as Record<string, unknown>;
    const useCase = new DispatchAttemptUseCase({
      workOrderRepo: workOrderRepo.port,
      attemptRepo: attemptRepo.port,
      journal: makeJournal([{ id: 'res-2', attemptId: 'attempt-2' }]).port,
      workspace: {
        ...workspace.port,
        readWorktreeFile: async (_path: string, relativePath: string) =>
          relativePath === '.lane/brief-manifest.json'
            ? JSON.stringify({ ...base, seatTool: manifestSeatTool })
            : null,
      } as WorkspacePort,
      runner: makeRunnerSpy().port,
      runnerSelector: selector,
    });

    manifestSeatTool = 'agy';
    const agyDispatch = await useCase.dispatchAttempt(dispatchRequest());
    expect(agyDispatch.outcome).toBe('started');
    expect(selectionCalls).toEqual(['agy']);

    // A manifest with no seatTool keeps today's behaviour: the opencode seat.
    manifestSeatTool = undefined;
    selectionCalls.length = 0;
    const legacyDispatch = await useCase.dispatchAttempt({
      ...dispatchRequest(),
      attemptId: 'attempt-2',
    });
    expect(legacyDispatch.outcome).toBe('started');
    expect(selectionCalls).toEqual(['opencode']);
  });
});
