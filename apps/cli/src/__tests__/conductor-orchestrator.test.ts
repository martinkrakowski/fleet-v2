// O9 first slice: live conductor orchestrator session registration (L9).
/**
 * Helper tests drive `registerConductorOrchestrator` over a fake session
 * repository and a fake `listProfiles`; the composition tests run the real
 * `conductor run --live --once` through `createFleetCliRuntime` and read the
 * stored session through a fresh adapter. No test dispatches a subprocess,
 * touches a runner or reaches the network.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { containsSecretShape } from '@fleet/shared';
import type { FleetInstallation } from '@fleet/installation';
import {
  OrchestratorSession,
  OrchestratorSessionRepositoryAdapter,
  OrchestratorSessionRevisionConflictError,
  type OrchestratorSessionListQuery,
  type OrchestratorSessionRecord,
  type OrchestratorSessionRepositoryPort,
  type ProjectProfileRecord,
  type StoredOrchestratorSession,
} from '@fleet/operator-coordination';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli, type CliIo } from '../index.js';
import type { ConductorCliOptions } from '../conductor.js';
import {
  heartbeatConductorOrchestrator,
  pollDelayWhileRegistered,
  registerConductorOrchestrator,
  retireConductorOrchestrator,
  type RegisterConductorOrchestratorInput,
} from '../conductor-orchestrator.js';

const NOW = '2026-10-27T10:00:00.000Z';
const PAST = '2026-10-27T09:00:00.000Z';
/** Before NOW, within 300 s of its heartbeat: an active session is lapsed at NOW. */
const LAPSED_HEARTBEAT = '2026-10-27T09:58:30.000Z';
const LAPSED_LEASE = '2026-10-27T09:59:30.000Z';
/** After NOW, within 300 s of its heartbeat: an active session is attached at NOW. */
const ATTACHED_HEARTBEAT = '2026-10-27T10:00:00.000Z';
const ATTACHED_LEASE = '2026-10-27T10:01:00.000Z';

function copy(stored: StoredOrchestratorSession): StoredOrchestratorSession {
  return {
    revision: stored.revision,
    session: {
      ...stored.session,
      projects: stored.session.projects.slice(),
      claims: stored.session.claims.slice(),
      scopes: stored.session.scopes.slice(),
    },
  };
}

class FakeSessionRepository implements OrchestratorSessionRepositoryPort {
  private readonly store = new Map<string, StoredOrchestratorSession>();
  failNextSave = false;
  listShouldThrow = false;
  getShouldThrow = false;

  async save(
    session: OrchestratorSessionRecord,
    expectedRevision: number,
  ): Promise<StoredOrchestratorSession> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error('save-failed');
    }
    const existing = this.store.get(session.orchestratorId);
    const storedRevision = existing === undefined ? 0 : existing.revision;
    if (storedRevision !== expectedRevision) {
      throw new OrchestratorSessionRevisionConflictError(
        session.orchestratorId,
        expectedRevision + 1,
        'conflict',
      );
    }
    const stored: StoredOrchestratorSession = { revision: expectedRevision + 1, session };
    this.store.set(session.orchestratorId, stored);
    return copy(stored);
  }

  async get(orchestratorId: string): Promise<StoredOrchestratorSession | null> {
    if (this.getShouldThrow) {
      throw new Error('get-failed');
    }
    const found = this.store.get(orchestratorId);
    return found === undefined ? null : copy(found);
  }

  async list(
    query?: OrchestratorSessionListQuery,
  ): Promise<readonly StoredOrchestratorSession[]> {
    if (this.listShouldThrow) {
      throw new Error('list-failed');
    }
    const entries = [...this.store.values()];
    const filtered =
      query?.status === undefined
        ? entries
        : entries.filter((entry) => entry.session.status === query.status);
    return filtered.map(copy);
  }

  snapshot(): StoredOrchestratorSession[] {
    return [...this.store.values()].map(copy);
  }
}

/** Seed one session through the aggregate, then the repository (never hand-written JSON). */
async function seedSession(
  repo: FakeSessionRepository,
  overrides: Partial<OrchestratorSessionRecord> = {},
): Promise<StoredOrchestratorSession> {
  const result = OrchestratorSession.create({
    orchestratorId: 'orch-seed-1',
    cliKind: 'conductor',
    model: null,
    host: 'local',
    projects: [],
    claims: ['start-lane-run'],
    scopes: ['orchestrate'],
    registeredByTokenId: 'conductor-driver',
    startedAtIso: PAST,
    lastHeartbeatIso: LAPSED_HEARTBEAT,
    leaseUntilIso: LAPSED_LEASE,
    lastPolledRequestsAtIso: null,
    status: 'active',
    ...overrides,
  });
  if (!result.success) {
    throw result.error;
  }
  return repo.save(result.value.toRecord(), 0);
}

function profilesFixture(count: number, status: 'active' | 'retired' = 'active'): ProjectProfileRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    projectId: `project-${String(index).padStart(2, '0')}`,
    displayName: `Project ${index}`,
    repository: `repo-${index}`,
    designatedDispatcherHost: 'local',
    policyRevision: 'policy-rev-1',
    maxConcurrentLanes: 1,
    runnerCapabilities: {},
    revision: 0,
    updatedAtIso: PAST,
    status,
    defaultBranch: null,
    clones: {},
    gateProcedures: [],
    defaultAllowedPathPrefixes: [],
    lastProbe: null,
  }));
}

/** Fresh ids across calls, like the real ULID minter; the helper itself stays stateless. */
let idCounter = 0;

function makeRegisterInput(
  repo: FakeSessionRepository,
  overrides: Partial<RegisterConductorOrchestratorInput> = {},
): RegisterConductorOrchestratorInput {
  return {
    sessionRepo: repo,
    listProfiles: async () => [],
    installation: { schemaVersion: 2, hosts: { local: { transport: 'local' } } },
    clock: { nowIso: () => NOW },
    newOrchestratorId: () => `id-${++idCounter}`,
    ...overrides,
  };
}

function sparseHostsArray(): unknown[] {
  const array: unknown[] = [];
  array[1] = { transport: 'local' };
  return array;
}

function throwingHostsInstallation(): unknown {
  return {
    schemaVersion: 2,
    get hosts(): never {
      throw new Error('hosts-getter-threw');
    },
  };
}

interface RunResult {
  readonly code: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

interface CapturedIo extends CliIo {
  readonly outLines: string[];
  readonly errLines: string[];
}

function captureIo(): CapturedIo {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    stdout: (text: string) => {
      outLines.push(text);
    },
    stderr: (text: string) => {
      errLines.push(text);
    },
  };
}

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-v2-conductor-orchestrator-test-'));
}

function makeInstallation(conductorEnabled: boolean): FleetInstallation {
  return {
    schemaVersion: 2,
    hosts: {
      local: {
        transport: 'local',
        worktreeRoot: '/tmp/fleet-k7-worktrees',
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
    forge: { mode: 'none' },
    ...(conductorEnabled ? { policy: { conductor: { enabled: true } } } : {}),
  };
}

function runtimeOf(stateDir: string, installation: FleetInstallation): FleetCliRuntime {
  return createFleetCliRuntime({
    stateDir,
    installation,
    runSubprocess: () => {
      throw new Error('the conductor must never dispatch a subprocess');
    },
    // The runtime's own environment carries no OCM_HOST/OCM_REMOTE_PORT, so
    // no composition test here ever opens a real tunnel from the process
    // environment.
    env: {},
  });
}

async function runConductorArgs(
  runtime: FleetCliRuntime,
  stateDir: string,
  args: readonly string[],
): Promise<RunResult> {
  const io = captureIo();
  const code = await runCli(
    ['conductor', ...args],
    io,
    runtime,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { now: () => NOW, stateDir } satisfies ConductorCliOptions,
  );
  return { code, stdout: io.outLines, stderr: io.errLines };
}

function runLiveOnce(runtime: FleetCliRuntime, stateDir: string): Promise<RunResult> {
  return runConductorArgs(runtime, stateDir, ['run', '--live', '--once']);
}

describe('o9-runtime-input-refused: registerConductorOrchestrator input refusal', () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly overrides: Partial<RegisterConductorOrchestratorInput>;
    readonly code: 'register-unknown' | 'host-unknown';
  }> = [
    { name: 'null installation', overrides: { installation: null }, code: 'register-unknown' },
    { name: 'non-object installation', overrides: { installation: 'not-an-object' }, code: 'register-unknown' },
    {
      name: 'installation whose hosts getter throws',
      overrides: { installation: throwingHostsInstallation() },
      code: 'register-unknown',
    },
    {
      name: 'sparse hosts array',
      overrides: { installation: { schemaVersion: 2, hosts: sparseHostsArray() } },
      code: 'host-unknown',
    },
    {
      name: 'host with an unknown transport',
      overrides: { installation: { schemaVersion: 2, hosts: { h: { transport: 'wormhole' } } } },
      code: 'host-unknown',
    },
    {
      name: 'listProfiles result that is not an array',
      overrides: { listProfiles: async () => ({ not: 'an array' }) as never },
      code: 'register-unknown',
    },
    {
      name: 'readable v2 installation with no local host',
      overrides: { installation: { schemaVersion: 2, hosts: { h: { transport: 'ssh' } } } },
      code: 'host-unknown',
    },
  ];

  it.each(cases)('$name is $code and writes nothing', async ({ overrides, code }) => {
    const repo = new FakeSessionRepository();
    const result = await registerConductorOrchestrator(makeRegisterInput(repo, overrides));
    expect(result).toEqual({ code, orchestratorId: null });
    expect(repo.snapshot()).toEqual([]);
  });
});

describe('o9 registerConductorOrchestrator store and retire behaviour', () => {
  it('o9-store-failure-leaves-a-retry: a failing save is register-unknown, then a retry registers', async () => {
    const repo = new FakeSessionRepository();
    repo.failNextSave = true;
    const first = await registerConductorOrchestrator(makeRegisterInput(repo));
    expect(first).toEqual({ code: 'register-unknown', orchestratorId: null });
    const second = await registerConductorOrchestrator(makeRegisterInput(repo));
    expect(second.code).toBe('registered');
    expect(second.orchestratorId).toMatch(/^orch-/);
    expect(pollDelayWhileRegistered(120_000)).toBe(60_000);
  });

  it('o9-lapsed-session-retired-once: retires only lapsed conductor-driver sessions, never attached ones', async () => {
    const repo = new FakeSessionRepository();
    await seedSession(repo, { orchestratorId: 'orch-lapsed-1' });
    const first = await registerConductorOrchestrator(makeRegisterInput(repo));
    expect(first.code).toBe('registered');

    const afterFirst = repo.snapshot();
    expect(afterFirst.filter((entry) => entry.session.status === 'retired')).toHaveLength(1);
    expect(afterFirst.filter((entry) => entry.session.status === 'retired')[0]!.session.orchestratorId).toBe(
      'orch-lapsed-1',
    );
    const activeAfterFirst = afterFirst.filter((entry) => entry.session.status === 'active');
    expect(activeAfterFirst).toHaveLength(1);
    expect(activeAfterFirst[0]!.session.orchestratorId).toBe(first.orchestratorId);

    // The CLI registers once, so this second register only proves the helper is
    // stateless: the new row is still attached at NOW, so it is not retired,
    // and a second active row is created. The first new row's id is unchanged.
    const second = await registerConductorOrchestrator(makeRegisterInput(repo));
    expect(second.code).toBe('registered');
    const afterSecond = repo.snapshot();
    expect(afterSecond.filter((entry) => entry.session.status === 'retired')).toHaveLength(1);
    expect(afterSecond.filter((entry) => entry.session.status === 'active')).toHaveLength(2);
    const originalNew = afterSecond.find((entry) => entry.session.orchestratorId === first.orchestratorId);
    expect(originalNew).toBeDefined();
    expect(originalNew!.session.status).toBe('active');
  });

  it('o9-heartbeat-between-list-and-retire-stays-live: a session heartbeated after the list snapshot is not retired', async () => {
    class HeartbeatAfterListRepository extends FakeSessionRepository {
      override async list(query?: OrchestratorSessionListQuery): Promise<readonly StoredOrchestratorSession[]> {
        const snapshot = await super.list(query);
        // Another process heartbeats the lapsed session right after the snapshot.
        for (const entry of snapshot) {
          const current = await this.get(entry.session.orchestratorId);
          if (current !== null) {
            await this.save(
              {
                ...current.session,
                lastHeartbeatIso: ATTACHED_HEARTBEAT,
                leaseUntilIso: ATTACHED_LEASE,
              },
              current.revision,
            );
          }
        }
        return snapshot;
      }
    }
    const repo = new HeartbeatAfterListRepository();
    await seedSession(repo, { orchestratorId: 'orch-raced-1' });
    const result = await registerConductorOrchestrator(makeRegisterInput(repo));
    expect(result.code).toBe('registered');
    const raced = repo.snapshot().find((entry) => entry.session.orchestratorId === 'orch-raced-1');
    expect(raced).toBeDefined();
    expect(raced!.session.status).toBe('active');
  });

  it('o9-unreadable-store-is-unknown: an unreadable profile store and session store are both register-unknown', async () => {
    const repo = new FakeSessionRepository();
    const viaProfiles = await registerConductorOrchestrator(
      makeRegisterInput(repo, {
        listProfiles: async () => {
          throw new Error('profiles-unreadable');
        },
      }),
    );
    expect(viaProfiles).toEqual({ code: 'register-unknown', orchestratorId: null });
    expect(repo.snapshot()).toEqual([]);

    const listThrowsRepo = new FakeSessionRepository();
    listThrowsRepo.listShouldThrow = true;
    const viaList = await registerConductorOrchestrator(makeRegisterInput(listThrowsRepo));
    expect(viaList).toEqual({ code: 'register-unknown', orchestratorId: null });
    expect(listThrowsRepo.snapshot()).toEqual([]);
  });

  it('o9-project-list-is-bounded: 65 active profiles are projects-over-cap and register no session', async () => {
    const repo = new FakeSessionRepository();
    const result = await registerConductorOrchestrator(
      makeRegisterInput(repo, { listProfiles: async () => profilesFixture(65) }),
    );
    expect(result).toEqual({ code: 'projects-over-cap', orchestratorId: null });
    expect(repo.snapshot()).toEqual([]);
  });

  it('o9-project-list-is-bounded: 65 lapsed conductor-driver sessions retire at most 64', async () => {
    const repo = new FakeSessionRepository();
    await Promise.all(
      Array.from({ length: 65 }, (_, index) =>
        seedSession(repo, { orchestratorId: `orch-lapsed-${String(index).padStart(2, '0')}` }),
      ),
    );
    const result = await registerConductorOrchestrator(makeRegisterInput(repo));
    expect(result.code).toBe('registered');
    const snapshot = repo.snapshot();
    expect(snapshot.filter((entry) => entry.session.status === 'retired')).toHaveLength(64);
    // One lapsed row stays active (the scan cap) plus the newly registered row.
    expect(snapshot.filter((entry) => entry.session.status === 'active')).toHaveLength(2);
  });
});

describe('o9 heartbeat and retire helpers', () => {
  it('heartbeat renews an attached conductor session and reports refusal/unknown', async () => {
    const repo = new FakeSessionRepository();
    const attached = await seedSession(repo, {
      orchestratorId: 'orch-attached-1',
      lastHeartbeatIso: ATTACHED_HEARTBEAT,
      leaseUntilIso: ATTACHED_LEASE,
    });
    const renewed = await heartbeatConductorOrchestrator(repo, { nowIso: () => NOW }, attached.session.orchestratorId);
    expect(renewed).toEqual({ code: 'renewed' });
    expect(repo.snapshot()[0]!.revision).toBe(attached.revision + 1);

    expect(
      await heartbeatConductorOrchestrator(repo, { nowIso: () => NOW }, 'orch-missing-1'),
    ).toEqual({ code: 'heartbeat-refused' });

    const throwingRepo = new FakeSessionRepository();
    throwingRepo.getShouldThrow = true;
    expect(
      await heartbeatConductorOrchestrator(throwingRepo, { nowIso: () => NOW }, 'orch-any-1'),
    ).toEqual({ code: 'heartbeat-unknown' });
  });

  it('retire retires idempotently and reports refusal/unknown', async () => {
    const repo = new FakeSessionRepository();
    const attached = await seedSession(repo, {
      orchestratorId: 'orch-attached-2',
      lastHeartbeatIso: ATTACHED_HEARTBEAT,
      leaseUntilIso: ATTACHED_LEASE,
    });
    const retired = await retireConductorOrchestrator(repo, { nowIso: () => NOW }, attached.session.orchestratorId);
    expect(retired).toEqual({ code: 'retired' });
    expect(
      await retireConductorOrchestrator(repo, { nowIso: () => NOW }, attached.session.orchestratorId),
    ).toEqual({ code: 'retired' });

    expect(
      await retireConductorOrchestrator(repo, { nowIso: () => NOW }, 'orch-missing-2'),
    ).toEqual({ code: 'retire-refused' });

    const throwingRepo = new FakeSessionRepository();
    throwingRepo.getShouldThrow = true;
    expect(
      await retireConductorOrchestrator(throwingRepo, { nowIso: () => NOW }, 'orch-any-2'),
    ).toEqual({ code: 'retire-unknown' });
  });
});

describe('o9 live composition', () => {
  async function registerProfile(runtime: FleetCliRuntime): Promise<void> {
    const result = await runtime.coordination.registerProjectProfile.registerProjectProfile({
      projectId: 'project-example-1',
      displayName: 'Example Project',
      repository: 'repo-example-1',
      designatedDispatcherHost: 'local',
      policyRevision: 'policy-example-1',
      maxConcurrentLanes: 2,
      runnerCapabilities: {},
      nowIso: NOW,
    });
    expect(result.outcome).toBe('registered');
  }

  it('o9-output-is-ids-and-codes: stdout and stderr carry only ids and codes, never paths or secrets', async () => {
    const dir = tempStateDir();
    const runtime = runtimeOf(dir, makeInstallation(true));
    await registerProfile(runtime);
    const result = await runLiveOnce(runtime, dir);
    expect(result.code).toBe(0);

    expect(result.stdout).toHaveLength(1);
    const allOutput = [...result.stdout, ...result.stderr].join('\n');
    expect(allOutput).not.toContain(dir);
    expect(allOutput).not.toContain('worktreeRoot');
    expect(containsSecretShape(allOutput)).toBe(false);

    const registerLine = result.stderr.find((line) => line.includes('"orchestrator":"registered"'));
    expect(registerLine).toBeDefined();
    const registerDocument = JSON.parse(registerLine!) as { orchestrator: string; orchestratorId?: string };
    expect(registerDocument.orchestrator).toBe('registered');
    expect(registerDocument.orchestratorId).toMatch(/^orch-/);

    const retireLine = result.stderr.find((line) => line.includes('"orchestrator":"retired"'));
    expect(retireLine).toBeDefined();
    expect(JSON.parse(retireLine!)).toEqual({ orchestrator: 'retired' });
  });

  it('o9-real-composition-registers: registers and retires one conductor session through the real composition', async () => {
    const dir = tempStateDir();
    const runtime = runtimeOf(dir, makeInstallation(true));
    await registerProfile(runtime);
    const result = await runLiveOnce(runtime, dir);
    expect(result.code).toBe(0);

    const adapter = new OrchestratorSessionRepositoryAdapter({ stateDir: dir });
    const sessions = await adapter.list();
    expect(sessions).toHaveLength(1);
    const session = sessions[0]!.session;
    expect(session.cliKind).toBe('conductor');
    expect(session.claims).toEqual(['start-lane-run']);
    expect(session.registeredByTokenId).toBe('conductor-driver');
    expect(session.scopes).toEqual(['orchestrate']);
    expect(session.host).toBe('local');
    expect(session.status).toBe('retired');
    expect(session.model).toBeNull();
    expect(session.projects).toEqual(['project-example-1']);
  });

  it('dry-run writes no session; a disabled conductor writes no session', async () => {
    const dryDir = tempStateDir();
    const dryRuntime = runtimeOf(dryDir, makeInstallation(true));
    const dry = await runConductorArgs(dryRuntime, dryDir, ['run', '--dry-run', '--once']);
    expect(dry.code).toBe(0);
    const dryAdapter = new OrchestratorSessionRepositoryAdapter({ stateDir: dryDir });
    expect(await dryAdapter.list()).toEqual([]);

    const disabledDir = tempStateDir();
    const disabledRuntime = runtimeOf(disabledDir, makeInstallation(false));
    const disabled = await runLiveOnce(disabledRuntime, disabledDir);
    expect(disabled.code).toBe(1);
    expect(disabled.stdout).toHaveLength(1);
    expect(JSON.parse(disabled.stdout[0]!)).toEqual({ outcome: 'refused', reason: 'conductor-disabled' });
    const disabledAdapter = new OrchestratorSessionRepositoryAdapter({ stateDir: disabledDir });
    expect(await disabledAdapter.list()).toEqual([]);
  });
});
