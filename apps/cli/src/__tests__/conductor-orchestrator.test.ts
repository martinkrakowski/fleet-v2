// O9b: the thin caller over the store's one locked register-or-adopt operation.
/**
 * Helper tests drive `registerConductorOrchestrator` over a real in-memory
 * store (failure-injected) and a fake `listProfiles`; the interleaving tests
 * run the three raced orderings against the REAL adapter in a temp directory;
 * the composition tests run the real `conductor run --live --once` through
 * `createFleetCliRuntime` and read the stored session through a fresh
 * adapter. No test dispatches a subprocess, touches a runner or reaches the
 * network.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { containsSecretShape } from '@fleet/shared';
import { parseInstallation, type FleetInstallation } from '@fleet/installation';
import {
  OrchestratorSession,
  OrchestratorSessionRepositoryAdapter,
  OrchestratorSessionRevisionConflictError,
  type OrchestratorSessionIdentity,
  type OrchestratorSessionListQuery,
  type OrchestratorSessionRecord,
  type OrchestratorSessionRepositoryPort,
  type ProjectProfileRecord,
  type RegisterOrAdoptSessionResult,
  type StoredOrchestratorSession,
} from '@fleet/operator-coordination';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli, type CliIo } from '../index.js';
import type { ConductorCliOptions } from '../conductor.js';
import type { RunnerTunnelPort } from '../runner-tunnel.js';
import {
  heartbeatConductorOrchestrator,
  heartbeatOrReRegisterConductorOrchestrator,
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

/**
 * A failure-injecting wrapper over a REAL in-memory store, so the helper is
 * always exercised through the store's own contract, never a hand-written
 * decision.
 */
class FakeSessionRepository implements OrchestratorSessionRepositoryPort {
  private readonly inner = new OrchestratorSessionRepositoryAdapter();
  failNextSave = false;
  failNextAdoption = false;
  listShouldThrow = false;
  getShouldThrow = false;

  async registerOrAdoptSession(
    identity: OrchestratorSessionIdentity,
    nowIso: string,
  ): Promise<RegisterOrAdoptSessionResult> {
    if (this.failNextAdoption) {
      this.failNextAdoption = false;
      throw new Error('adoption-failed');
    }
    return this.inner.registerOrAdoptSession(identity, nowIso);
  }

  async save(
    session: OrchestratorSessionRecord,
    expectedRevision: number,
  ): Promise<StoredOrchestratorSession> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error('save-failed');
    }
    return this.inner.save(session, expectedRevision);
  }

  async get(orchestratorId: string): Promise<StoredOrchestratorSession | null> {
    if (this.getShouldThrow) {
      throw new Error('get-failed');
    }
    return this.inner.get(orchestratorId);
  }

  async list(
    query?: OrchestratorSessionListQuery,
  ): Promise<readonly StoredOrchestratorSession[]> {
    if (this.listShouldThrow) {
      throw new Error('list-failed');
    }
    return this.inner.list(query);
  }

  async snapshot(): Promise<StoredOrchestratorSession[]> {
    return (await this.inner.list()).map(copy);
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

const RUNNER_CAPABILITIES = {
  networkEgressRestricted: true,
  cpuAndMemoryLimited: true,
  processTreeTermination: true,
  filesystemScope: 'scoped-worktree',
} as const;

/**
 * The real sunrise v2 shape: an ssh lane-runner host next to the local
 * orchestrator host. Every registration test uses it; a one-host fixture hid
 * F174.
 */
function makeMultiHostInstallation(conductorEnabled: boolean): FleetInstallation {
  return {
    schemaVersion: 2,
    hosts: {
      solstice: {
        transport: 'ssh',
        sshAlias: 'solstice',
        worktreeRoot: '/tmp/fleet-o9c-solstice-worktrees',
        roles: ['lane-runner'],
        runner: { kind: 'opencode', port: 46000, capabilities: RUNNER_CAPABILITIES, maxLanes: 2 },
      },
      'this-machine': {
        transport: 'local',
        worktreeRoot: '/tmp/fleet-o9c-local-worktrees',
        roles: ['orchestrator', 'verifier'],
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

/** The two-host installation has an ssh lane-runner host; no test may open a real forward to it. */
const noTunnel: RunnerTunnelPort = {
  ensureTunnel: async () => 'not-applicable',
  stop: async () => {},
  release: async () => {},
};

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
    { now: () => NOW, stateDir, tunnel: noTunnel } satisfies ConductorCliOptions,
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
    expect(await repo.snapshot()).toEqual([]);
  });
});

describe('o9c-multi-host: the local host is chosen among every host entry', () => {
  it('the multi-host fixture is a valid v2 installation', () => {
    expect(parseInstallation(makeMultiHostInstallation(true)).ok).toBe(true);
  });

  it('o9c-two-host-registers-on-local: solstice (ssh) plus this-machine (local) registers a session on this-machine', async () => {
    const repo = new FakeSessionRepository();
    const result = await registerConductorOrchestrator(
      makeRegisterInput(repo, { installation: makeMultiHostInstallation(true) }),
    );
    expect(result.code).toBe('registered');
    expect(result.orchestratorId).toMatch(/^orch-/);
    const rows = await repo.snapshot();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.session.host).toBe('this-machine');
    expect(rows[0]!.session.status).toBe('active');
  });

  it('o9c-order-independent: the local host is found wherever it sits in the host list', async () => {
    const repo = new FakeSessionRepository();
    const installation = {
      schemaVersion: 2,
      hosts: { solstice: { transport: 'ssh' }, 'this-machine': { transport: 'local' }, other: { transport: 'ssh' } },
    };
    const result = await registerConductorOrchestrator(makeRegisterInput(repo, { installation }));
    expect(result.code).toBe('registered');
    expect((await repo.snapshot())[0]!.session.host).toBe('this-machine');
  });

  it('o9c-no-local-host: two ssh hosts are host-unknown and write nothing', async () => {
    const repo = new FakeSessionRepository();
    const installation = {
      schemaVersion: 2,
      hosts: { solstice: { transport: 'ssh' }, equinox: { transport: 'ssh' } },
    };
    const result = await registerConductorOrchestrator(makeRegisterInput(repo, { installation }));
    expect(result).toEqual({ code: 'host-unknown', orchestratorId: null });
    expect(await repo.snapshot()).toEqual([]);
  });

  it('o9c-two-local-hosts: two local hosts are host-unknown and write nothing', async () => {
    const repo = new FakeSessionRepository();
    const installation = {
      schemaVersion: 2,
      hosts: {
        solstice: { transport: 'ssh' },
        'this-machine': { transport: 'local' },
        'that-machine': { transport: 'local' },
      },
    };
    const result = await registerConductorOrchestrator(makeRegisterInput(repo, { installation }));
    expect(result).toEqual({ code: 'host-unknown', orchestratorId: null });
    expect(await repo.snapshot()).toEqual([]);
  });

  it('o9c-malformed-entry-among-hosts: a non-object or throwing host entry is register-unknown, never a throw', async () => {
    const throwingEntry = {
      get transport(): never {
        throw new Error('transport-getter-threw');
      },
    };
    const entries: readonly unknown[] = ['not-an-object', null, throwingEntry];
    for (const broken of entries) {
      const repo = new FakeSessionRepository();
      const result = await registerConductorOrchestrator(
        makeRegisterInput(repo, {
          installation: {
            schemaVersion: 2,
            hosts: { solstice: { transport: 'ssh' }, 'this-machine': { transport: 'local' }, broken },
          },
        }),
      );
      expect(result).toEqual({ code: 'register-unknown', orchestratorId: null });
      expect(await repo.snapshot()).toEqual([]);
    }
  });
});

describe('o9 registerConductorOrchestrator through the store operation', () => {
  it('o9-store-failure-leaves-a-retry: a failing store operation is register-unknown, then a retry registers', async () => {
    const repo = new FakeSessionRepository();
    repo.failNextAdoption = true;
    const first = await registerConductorOrchestrator(makeRegisterInput(repo));
    expect(first).toEqual({ code: 'register-unknown', orchestratorId: null });
    expect(await repo.snapshot()).toEqual([]);
    const second = await registerConductorOrchestrator(makeRegisterInput(repo));
    expect(second.code).toBe('registered');
    expect(second.orchestratorId).toMatch(/^orch-/);
    expect(pollDelayWhileRegistered(120_000)).toBe(60_000);
  });

  it('o9b-lapsed-replaced-then-live-adopted: a lapsed session is replaced once, and a second register adopts the live one', async () => {
    const repo = new FakeSessionRepository();
    await seedSession(repo, { orchestratorId: 'orch-lapsed-1' });
    const first = await registerConductorOrchestrator(makeRegisterInput(repo));
    expect(first.code).toBe('registered');

    const afterFirst = await repo.snapshot();
    expect(afterFirst.filter((entry) => entry.session.status === 'retired')).toHaveLength(1);
    expect(afterFirst.filter((entry) => entry.session.status === 'retired')[0]!.session.orchestratorId).toBe(
      'orch-lapsed-1',
    );
    const activeAfterFirst = afterFirst.filter((entry) => entry.session.status === 'active');
    expect(activeAfterFirst).toHaveLength(1);
    expect(activeAfterFirst[0]!.session.orchestratorId).toBe(first.orchestratorId);

    // The store holds one live session for the identity now: a second register
    // adopts it, refreshes its heartbeat and registers nothing new.
    const second = await registerConductorOrchestrator(makeRegisterInput(repo));
    expect(second).toEqual({ code: 'registered', orchestratorId: first.orchestratorId });
    const afterSecond = await repo.snapshot();
    expect(afterSecond.filter((entry) => entry.session.status === 'retired')).toHaveLength(1);
    expect(afterSecond.filter((entry) => entry.session.status === 'active')).toHaveLength(1);
    expect(afterSecond.find((entry) => entry.session.orchestratorId === first.orchestratorId)).toBeDefined();
  });

  it('o9b-adopt-live-seeded-session: a live session another process registered is adopted, never duplicated', async () => {
    const repo = new FakeSessionRepository();
    await seedSession(repo, {
      orchestratorId: 'orch-adopt-1',
      lastHeartbeatIso: ATTACHED_HEARTBEAT,
      leaseUntilIso: ATTACHED_LEASE,
    });
    const result = await registerConductorOrchestrator(makeRegisterInput(repo));
    expect(result).toEqual({ code: 'registered', orchestratorId: 'orch-adopt-1' });
    const rows = await repo.snapshot();
    expect(rows.map((entry) => entry.session.orchestratorId)).toEqual(['orch-adopt-1']);
    expect(rows[0]!.session.status).toBe('active');
    // The adoption refreshed the heartbeat to the caller's now.
    expect(rows[0]!.session.lastHeartbeatIso).toBe(NOW);
  });

  it('o9-refused-heartbeat-re-registers-once: a retired session is replaced by a new one, one time only', async () => {
    const repo = new FakeSessionRepository();
    const input = makeRegisterInput(repo);
    const first = await registerConductorOrchestrator(input);
    expect(first.code).toBe('registered');
    const firstId = first.orchestratorId!;
    expect((await retireConductorOrchestrator(repo, input.clock, firstId)).code).toBe('retired');

    const healed = await heartbeatOrReRegisterConductorOrchestrator(input, firstId, true);
    expect(healed.code).toBe('heartbeat-refused');
    expect(healed.reRegistration).toBe('registered');
    expect(healed.orchestratorId).not.toBe(firstId);
    const active = (await repo.snapshot()).filter((entry) => entry.session.status === 'active');
    expect(active.map((entry) => entry.session.orchestratorId)).toEqual([healed.orchestratorId]);

    // Once used, a later refusal re-registers nothing.
    const again = await heartbeatOrReRegisterConductorOrchestrator(input, firstId, false);
    expect(again).toEqual({ code: 'heartbeat-refused', orchestratorId: firstId, reRegistration: null });
    expect((await repo.snapshot()).filter((entry) => entry.session.status === 'active')).toHaveLength(1);
  });

  it('o9-exhausted-heartbeat-retry-does-not-re-register: only a retired or missing session is replaced', async () => {
    class ConflictingHeartbeatRepository extends FakeSessionRepository {
      conflictSaves = false;
      override async save(
        session: OrchestratorSessionRecord,
        expectedRevision: number,
      ): Promise<StoredOrchestratorSession> {
        if (this.conflictSaves) {
          throw new OrchestratorSessionRevisionConflictError(session.orchestratorId, expectedRevision + 1, 'conflict');
        }
        return super.save(session, expectedRevision);
      }
    }
    const repo = new ConflictingHeartbeatRepository();
    const input = makeRegisterInput(repo);
    const first = await registerConductorOrchestrator(input);
    expect(first.code).toBe('registered');
    repo.conflictSaves = true; // every heartbeat save conflicts: the retry runs out and is refused
    const beat = await heartbeatOrReRegisterConductorOrchestrator(input, first.orchestratorId!, true);
    expect(beat).toEqual({ code: 'heartbeat-refused', orchestratorId: first.orchestratorId, reRegistration: null });
    repo.conflictSaves = false;
    expect((await repo.snapshot()).filter((entry) => entry.session.status === 'active')).toHaveLength(1);
  });

  it('o9-unreadable-store-is-unknown: an unreadable profile store and a failing store operation are both register-unknown', async () => {
    const repo = new FakeSessionRepository();
    const viaProfiles = await registerConductorOrchestrator(
      makeRegisterInput(repo, {
        listProfiles: async () => {
          throw new Error('profiles-unreadable');
        },
      }),
    );
    expect(viaProfiles).toEqual({ code: 'register-unknown', orchestratorId: null });
    expect(await repo.snapshot()).toEqual([]);

    const viaStore = await registerConductorOrchestrator(
      makeRegisterInput(repo, {
        sessionRepo: {
          registerOrAdoptSession: async () => {
            throw new Error('store-unreadable');
          },
        } as unknown as OrchestratorSessionRepositoryPort,
      }),
    );
    expect(viaStore).toEqual({ code: 'register-unknown', orchestratorId: null });
    expect(await repo.snapshot()).toEqual([]);
  });

  it('o9-project-list-is-bounded: 65 active profiles are projects-over-cap and register no session', async () => {
    const repo = new FakeSessionRepository();
    const result = await registerConductorOrchestrator(
      makeRegisterInput(repo, { listProfiles: async () => profilesFixture(65) }),
    );
    expect(result).toEqual({ code: 'projects-over-cap', orchestratorId: null });
    expect(await repo.snapshot()).toEqual([]);
  });
});

describe('o9 heartbeat and retire helpers', () => {
  it('heartbeat renews an attached conductor session and reports refusals with their kind', async () => {
    const repo = new FakeSessionRepository();
    const attached = await seedSession(repo, {
      orchestratorId: 'orch-attached-1',
      lastHeartbeatIso: ATTACHED_HEARTBEAT,
      leaseUntilIso: ATTACHED_LEASE,
    });
    const renewed = await heartbeatConductorOrchestrator(repo, { nowIso: () => NOW }, attached.session.orchestratorId);
    expect(renewed).toEqual({ code: 'renewed', refusalKind: null });
    expect((await repo.snapshot())[0]!.revision).toBe(attached.revision + 1);

    expect(
      await heartbeatConductorOrchestrator(repo, { nowIso: () => NOW }, 'orch-missing-1'),
    ).toEqual({ code: 'heartbeat-refused', refusalKind: 'not-found' });

    const retiredRepo = new FakeSessionRepository();
    const retiredSession = await seedSession(retiredRepo, { orchestratorId: 'orch-retired-1' });
    await retireConductorOrchestrator(retiredRepo, { nowIso: () => NOW }, retiredSession.session.orchestratorId);
    expect(
      await heartbeatConductorOrchestrator(retiredRepo, { nowIso: () => NOW }, retiredSession.session.orchestratorId),
    ).toEqual({ code: 'heartbeat-refused', refusalKind: 'retired' });

    const throwingRepo = new FakeSessionRepository();
    throwingRepo.getShouldThrow = true;
    expect(
      await heartbeatConductorOrchestrator(throwingRepo, { nowIso: () => NOW }, 'orch-any-1'),
    ).toEqual({ code: 'heartbeat-unknown', refusalKind: null });
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

describe('o9b interleavings against the real adapter in a temp directory', () => {
  function fileAdapter(dir: string): OrchestratorSessionRepositoryAdapter {
    return new OrchestratorSessionRepositoryAdapter({ stateDir: dir });
  }

  function identityFor(
    dir: string,
    orchestratorId: string,
    overrides: Partial<OrchestratorSessionIdentity['registration']> = {},
  ): OrchestratorSessionIdentity {
    return {
      host: 'local',
      stateDir: dir,
      registration: {
        orchestratorId,
        model: null,
        projects: [],
        claims: ['start-lane-run'],
        scopes: ['orchestrate'],
        registeredByTokenId: 'conductor-driver',
        ...overrides,
      },
    };
  }

  async function activeIds(
    adapter: OrchestratorSessionRepositoryAdapter,
  ): Promise<readonly string[]> {
    return (await adapter.list({ status: 'active' })).map((entry) => entry.session.orchestratorId);
  }

  it('o9b-concurrent-register: two conductors registering the same identity at once end with one active session', async () => {
    const dir = tempStateDir();
    const [first, second] = await Promise.all([
      fileAdapter(dir).registerOrAdoptSession(identityFor(dir, 'orch-race-a'), NOW),
      fileAdapter(dir).registerOrAdoptSession(identityFor(dir, 'orch-race-b'), NOW),
    ]);
    // One registers over known absence; the other adopts the single live session.
    expect(new Set([first.outcome, second.outcome])).toEqual(new Set(['registered', 'adopted']));
    expect(await activeIds(fileAdapter(dir))).toHaveLength(1);
  });

  it('o9b-replace-before-save: a heartbeat of a replaced session reads the revision conflict, then adopts the replacement', async () => {
    const dir = tempStateDir();
    const mine = fileAdapter(dir);
    // This process's session is lapsed: another process retires it and registers a replacement.
    const seeded = await seedAdapterSession(mine, 'orch-mine-1');
    const replacement = await fileAdapter(dir).registerOrAdoptSession(
      identityFor(dir, 'orch-replacement-1'),
      NOW,
    );
    expect(replacement.outcome).toBe('registered');
    // The lapsed id is retired; the replacement is the single live session.
    expect(await activeIds(fileAdapter(dir))).toEqual(['orch-replacement-1']);

    // This process's save of the old record reads the revision conflict, never "still live".
    await expect(
      mine.save({ ...seeded.session, lastHeartbeatIso: NOW, leaseUntilIso: ATTACHED_LEASE }, seeded.revision),
    ).rejects.toThrow(OrchestratorSessionRevisionConflictError);
    expect(await activeIds(fileAdapter(dir))).toEqual(['orch-replacement-1']);

    // The next heartbeat is refused (retired) and the one locked operation adopts the replacement.
    const adoption = await mine.registerOrAdoptSession(identityFor(dir, 'orch-mine-2'), NOW);
    expect(adoption).toMatchObject({ outcome: 'adopted' });
    if (adoption.outcome !== 'refused') {
      expect(adoption.session.orchestratorId).toBe('orch-replacement-1');
    }
    expect(await activeIds(fileAdapter(dir))).toEqual(['orch-replacement-1']);
  });

  it('o9b-adopt-retired-id: a process holding a retired id re-registers into the single active session next to no duplicate', async () => {
    const dir = tempStateDir();
    const adapter = fileAdapter(dir);
    // A retired id is never reused; the replacement is active.
    const retiredRecord = OrchestratorSession.create({
      orchestratorId: 'orch-old-1',
      cliKind: 'conductor',
      model: null,
      host: 'local',
      projects: [],
      claims: ['start-lane-run'],
      scopes: ['orchestrate'],
      registeredByTokenId: 'conductor-driver',
      startedAtIso: PAST,
      lastHeartbeatIso: PAST,
      leaseUntilIso: '2026-10-27T09:00:01.000Z',
      lastPolledRequestsAtIso: null,
      status: 'retired',
    });
    if (!retiredRecord.success) {
      throw retiredRecord.error;
    }
    await adapter.save(retiredRecord.value.toRecord(), 0);
    await adapter.registerOrAdoptSession(identityFor(dir, 'orch-current-1'), NOW);
    expect(await activeIds(adapter)).toEqual(['orch-current-1']);

    // The lapsed process re-registers on its next heartbeat: it adopts the
    // replacement and the retired id stays retired.
    const next = await adapter.registerOrAdoptSession(identityFor(dir, 'orch-old-2'), NOW);
    expect(next).toMatchObject({ outcome: 'adopted' });
    if (next.outcome !== 'refused') {
      expect(next.session.orchestratorId).toBe('orch-current-1');
    }
    expect(await activeIds(adapter)).toEqual(['orch-current-1']);
  });

  it('o9b-second-active-refused: saving a second active session for the identity is refused with the typed error, on every save path', async () => {
    const dir = tempStateDir();
    const adapter = fileAdapter(dir);
    const first = await adapter.registerOrAdoptSession(identityFor(dir, 'orch-first-1'), NOW);
    expect(first.outcome).toBe('registered');
    const duplicateRecord = OrchestratorSession.create({
      orchestratorId: 'orch-second-1',
      cliKind: 'conductor',
      model: null,
      host: 'local',
      projects: [],
      claims: ['start-lane-run'],
      scopes: ['orchestrate'],
      registeredByTokenId: 'conductor-driver',
      startedAtIso: NOW,
      lastHeartbeatIso: NOW,
      leaseUntilIso: ATTACHED_LEASE,
      lastPolledRequestsAtIso: null,
      status: 'active',
    });
    if (!duplicateRecord.success) {
      throw duplicateRecord.error;
    }
    await expect(adapter.save(duplicateRecord.value.toRecord(), 0)).rejects.toMatchObject({
      name: 'OrchestratorSessionIdentityAlreadyActiveError',
      code: 'identity-already-active',
    });
    expect(await activeIds(adapter)).toEqual(['orch-first-1']);

    // A retired writer and a heartbeating writer never trip the invariant.
    const retiredOfSameRecord = OrchestratorSession.create({
      orchestratorId: 'orch-second-1',
      cliKind: 'conductor',
      model: null,
      host: 'local',
      projects: [],
      claims: ['start-lane-run'],
      scopes: ['orchestrate'],
      registeredByTokenId: 'conductor-driver',
      startedAtIso: PAST,
      lastHeartbeatIso: PAST,
      leaseUntilIso: '2026-10-27T09:00:01.000Z',
      lastPolledRequestsAtIso: null,
      status: 'retired',
    });
    if (!retiredOfSameRecord.success) {
      throw retiredOfSameRecord.error;
    }
    await expect(adapter.save(retiredOfSameRecord.value.toRecord(), 0)).resolves.toMatchObject({
      revision: 1,
    });
  });

  it('o9b-malformed-input-refused: a secret-shaped or unreadable identity is refused and writes nothing', async () => {
    const dir = tempStateDir();
    const adapter = fileAdapter(dir);
    const fakeSecret = ['sk', '-', 'x9y8z7'.repeat(4)].join('');
    await expect(
      adapter.registerOrAdoptSession(
        { ...identityFor(dir, 'orch-any-1'), host: fakeSecret },
        NOW,
      ),
    ).resolves.toEqual({ outcome: 'refused', reason: 'the conductor identity host was refused' });
    await expect(
      adapter.registerOrAdoptSession({ ...identityFor(dir, 'orch-any-2'), host: 7 as never }, NOW),
    ).resolves.toMatchObject({ outcome: 'refused' });
    await expect(
      adapter.registerOrAdoptSession(identityFor(dir, 'orch-any-3'), 'not-a-time'),
    ).resolves.toEqual({ outcome: 'refused', reason: 'the adoption time is not a valid timestamp' });
    expect(await adapter.list()).toEqual([]);
  });

  it('o9b-unreadable-store-refuses: an unreadable store refuses and never registers', async () => {
    const dir = tempStateDir();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'orchestrators.json'), 'not json at all', 'utf8');
    const adapter = fileAdapter(dir);
    await expect(adapter.registerOrAdoptSession(identityFor(dir, 'orch-any-4'), NOW)).resolves.toEqual({
      outcome: 'refused',
      reason: 'the orchestrator session store could not be read',
    });
    const raw = await (await import('node:fs/promises')).readFile(join(dir, 'orchestrators.json'), 'utf8');
    expect(raw).toBe('not json at all');
  });

  it('o9b-identity-state-dir-screened: a supplied state directory must name this store', async () => {
    const dir = tempStateDir();
    const adapter = fileAdapter(dir);
    await expect(
      adapter.registerOrAdoptSession(identityFor(join(dir, 'elsewhere'), 'orch-any-5'), NOW),
    ).resolves.toEqual({ outcome: 'refused', reason: 'the identity does not belong to this store' });
    expect(await adapter.list()).toEqual([]);
    await expect(adapter.registerOrAdoptSession(identityFor(dir, 'orch-mine-9'), NOW)).resolves.toMatchObject({
      outcome: 'registered',
    });
  });
});

/** Seed one session through the aggregate and a real file-backed adapter. */
async function seedAdapterSession(
  adapter: OrchestratorSessionRepositoryAdapter,
  orchestratorId: string,
): Promise<StoredOrchestratorSession> {
  const result = OrchestratorSession.create({
    orchestratorId,
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
  });
  if (!result.success) {
    throw result.error;
  }
  return adapter.save(result.value.toRecord(), 0);
}

describe('o9 live composition', () => {
  async function registerProfile(runtime: FleetCliRuntime, dispatcherHost = 'local'): Promise<void> {
    const result = await runtime.coordination.registerProjectProfile.registerProjectProfile({
      projectId: 'project-example-1',
      displayName: 'Example Project',
      repository: 'repo-example-1',
      designatedDispatcherHost: dispatcherHost,
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

  it('o9b-real-composition-one-active: the production path leaves exactly one session row and never a duplicate identity', async () => {
    const dir = tempStateDir();
    const runtime = runtimeOf(dir, makeInstallation(true));
    await registerProfile(runtime);
    const result = await runLiveOnce(runtime, dir);
    expect(result.code).toBe(0);
    // The whole production path went through the store's one locked operation:
    // one session for the conductor identity, retired on exit.
    const adapter = new OrchestratorSessionRepositoryAdapter({ stateDir: dir });
    const sessions = await adapter.list();
    expect(sessions.filter((entry) => entry.session.cliKind === 'conductor')).toHaveLength(1);
    expect(sessions.filter((entry) => entry.session.host === 'local' && entry.session.status === 'active'))
      .toHaveLength(0);
  });

  it('o9c-multi-host-composition: on the two-host installation the first pass registers one active session and a second run adopts it', async () => {
    const dir = tempStateDir();
    const installation = makeMultiHostInstallation(true);
    // A process killed before its exit retire leaves its session active. The
    // retire write is dropped to model that, so the next run finds the session.
    const dropRetire = (runtime: FleetCliRuntime): void => {
      const repository = runtime.coordination.orchestratorSessionRepository;
      const realSave = repository.save.bind(repository);
      vi.spyOn(repository, 'save').mockImplementation(async (session, expectedRevision) => {
        if (session.status === 'retired') {
          const current = await repository.get(session.orchestratorId);
          if (current !== null) {
            return current;
          }
        }
        return realSave(session, expectedRevision);
      });
    };
    const firstRuntime = runtimeOf(dir, installation);
    await registerProfile(firstRuntime, 'this-machine');
    dropRetire(firstRuntime);

    const first = await runLiveOnce(firstRuntime, dir);
    expect(first.code).toBe(0);
    expect(first.stderr.join('')).not.toContain('host-unknown');
    const firstLine = first.stderr.find((line) => line.includes('"orchestrator":"registered"'));
    expect(firstLine).toBeDefined();
    const firstId = (JSON.parse(firstLine!) as { orchestratorId: string }).orchestratorId;

    const adapter = new OrchestratorSessionRepositoryAdapter({ stateDir: dir });
    const afterFirst = await adapter.list({ status: 'active' });
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]!.session.orchestratorId).toBe(firstId);
    expect(afterFirst[0]!.session.host).toBe('this-machine');

    const secondRuntime = runtimeOf(dir, installation);
    dropRetire(secondRuntime);
    const second = await runLiveOnce(secondRuntime, dir);
    expect(second.code).toBe(0);
    const secondLine = second.stderr.find((line) => line.includes('"orchestrator":"registered"'));
    expect(secondLine).toBeDefined();
    expect((JSON.parse(secondLine!) as { orchestratorId: string }).orchestratorId).toBe(firstId);

    const afterSecond = await adapter.list();
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]!.session.status).toBe('active');
    expect(afterSecond[0]!.session.orchestratorId).toBe(firstId);
  });

  it('o9c-multi-host-retires-on-exit: an ordinary two-host run registers, then retires its one session', async () => {
    const dir = tempStateDir();
    const runtime = runtimeOf(dir, makeMultiHostInstallation(true));
    await registerProfile(runtime, 'this-machine');
    const result = await runLiveOnce(runtime, dir);
    expect(result.code).toBe(0);
    const sessions = await new OrchestratorSessionRepositoryAdapter({ stateDir: dir }).list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.session.host).toBe('this-machine');
    expect(sessions[0]!.session.status).toBe('retired');
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
