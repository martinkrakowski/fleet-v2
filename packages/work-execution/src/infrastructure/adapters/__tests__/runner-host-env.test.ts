/**
 * Lane H3a: the runner environment comes from the installation's selected
 * lane-runner host, never from the process environment.
 *
 * With a v2 installation host the adapter sets `OCM_HOST`, `OCM_REMOTE_PORT`
 * and `OPENCODE_AUTH_FILE` itself and refuses to start without a port, while
 * legacy mode (a v1 or absent installation) keeps today's environment-based
 * behaviour. No subprocess is spawned here: the two seams (the injected
 * subprocess runner and the command executor) capture what would be passed to
 * `ocm-run`.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { CommandExecutorPort } from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import type {
  RunnerIsolationCapabilities,
  StartRunnerSessionRequest,
} from '../../../application/ports/out/ExecutionRunnerPort.out-port.js';
import type { AttemptRecord } from '../../../domain/execution-records.js';
import type { AttemptRepositoryPort } from '../../../application/ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../../../application/ports/out/ExecutionJournalPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../../../application/ports/out/WorkOrderRepositoryPort.out-port.js';
import type { WorkspacePort } from '../../../application/ports/out/WorkspacePort.out-port.js';
import type { SubprocessRunner } from '../ExecutionRunnerAdapter.adapter.js';
import {
  RUNNER_ENV_ALLOWLIST,
  ExecutionRunnerAdapter,
  buildRunnerEnv,
} from '../ExecutionRunnerAdapter.adapter.js';
import { AttemptRepositoryAdapter } from '../AttemptRepositoryAdapter.adapter.js';
import { DispatchAttemptUseCase } from '../../../application/use-cases/DispatchAttemptUseCase.use-case.js';

const capabilities: RunnerIsolationCapabilities = {
  source: 'legacy-asserted',
  filesystemScope: 'scoped-worktree',
  networkEgressRestricted: true,
  cpuAndMemoryLimited: true,
  processTreeTermination: true,
  authoritativeCompletion: true,
  artifactPersistence: true,
};

const startRequest: StartRunnerSessionRequest = {
  attemptId: 'att-h3a',
  worktreePath: '/tmp/fleet-h3a-worktree',
  briefPackagePath: '/tmp/fleet-h3a-worktree/.lane/brief.md',
  baseCommit: 'abc123',
  stepLimit: 50,
  timeLimitSeconds: 3600,
  requiredCapabilities: capabilities,
  model: 'example-provider/example-model',
};

/** Every host variable a stale export could try to redirect a lane with. */
const PLANTED: Readonly<Record<string, string>> = {
  OCM_REMOTE_PORT: '1111',
  OCM_HOST: 'planted.example',
  OPENCODE_AUTH_FILE: '/tmp/planted-auth.env',
};

const plantedSnapshot: Readonly<Record<string, string | undefined>> = Object.fromEntries(
  Object.keys(PLANTED).map((key) => [key, process.env[key]]),
);

/** Plants a stale routing environment for the duration of one test. */
function plantStaleRoutingEnvironment(): void {
  for (const [key, value] of Object.entries(PLANTED)) {
    process.env[key] = value;
  }
}

afterEach(() => {
  for (const key of Object.keys(PLANTED)) {
    const previous = plantedSnapshot[key];
    // Deleting rather than assigning undefined keeps Node from coercing the
    // variable to the literal string "undefined" in later subprocess envs.
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  delete process.env.SSH_AUTH_SOCK;
});

function scriptedRunner(): { runner: SubprocessRunner; envs: Record<string, string>[] } {
  const envs: Record<string, string>[] = [];
  const runner: SubprocessRunner = async (_command, _args, env) => {
    envs.push({ ...(env ?? {}) });
    return { exitCode: 0, stdout: '{"sessionID":"ses_h3a"}', stderr: '' };
  };
  return { runner, envs };
}

function capturingExecutor(): { executor: CommandExecutorPort; envs: Record<string, string>[] } {
  const envs: Record<string, string>[] = [];
  const executor: CommandExecutorPort = {
    async run(_argv: readonly string[], options) {
      envs.push({ ...(options?.env ?? {}) });
      return {
        exitCode: 0,
        signal: null,
        stdout: '{"sessionID":"ses_h3a"}',
        stderr: '',
      };
    },
  };
  return { executor, envs };
}

describe('ExecutionRunnerAdapter v2 host routing (H3a)', () => {
  it('sets OCM_HOST, OCM_REMOTE_PORT and OPENCODE_AUTH_FILE from the ssh host, ignoring planted variables', async () => {
    plantStaleRoutingEnvironment();
    const { runner, envs } = scriptedRunner();
    const adapter = new ExecutionRunnerAdapter({
      runSubprocess: runner,
      host: {
        hostName: 'midnight',
        transport: 'ssh',
        sshAlias: 'm',
        remotePort: 4166,
        authFile: '/home/operator/.config/opencode/server-auth.env',
      },
    });

    const result = await adapter.startSession(startRequest);

    expect(result.outcome).toBe('started');
    expect(envs).toHaveLength(1);
    expect(envs[0]).toEqual({
      OCM_REMOTE_PORT: '4166',
      OCM_HOST: 'm',
      OPENCODE_AUTH_FILE: '/home/operator/.config/opencode/server-auth.env',
    });
  });

  it('sets an empty OCM_HOST for a local host so an inherited alias cannot tunnel the lane elsewhere', async () => {
    plantStaleRoutingEnvironment();
    const { executor, envs } = capturingExecutor();
    const adapter = new ExecutionRunnerAdapter({
      executor,
      host: { hostName: 'this-machine', transport: 'local', remotePort: 46000 },
    });

    const result = await adapter.startSession(startRequest);

    expect(result.outcome).toBe('started');
    expect(envs[0].OCM_HOST).toBe('');
    expect(envs[0].OCM_REMOTE_PORT).toBe('46000');
    // A planted auth file is not the installation's, so it is not forwarded.
    expect(envs[0].OPENCODE_AUTH_FILE).toBeUndefined();
  });

  it('trims the ssh agent from the v2 local host environment and keeps it for an ssh host', async () => {
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
    const local = capturingExecutor();
    const ssh = capturingExecutor();

    await new ExecutionRunnerAdapter({
      executor: local.executor,
      host: { hostName: 'this-machine', transport: 'local', remotePort: 46000 },
    }).startSession(startRequest);
    await new ExecutionRunnerAdapter({
      executor: ssh.executor,
      host: { hostName: 'midnight', transport: 'ssh', sshAlias: 'm', remotePort: 4166 },
    }).startSession(startRequest);

    expect(local.envs[0].SSH_AUTH_SOCK).toBeUndefined();
    expect(ssh.envs[0].SSH_AUTH_SOCK).toBe('/tmp/agent.sock');
  });

  it('refuses to start without a port and spawns nothing', async () => {
    plantStaleRoutingEnvironment();
    const { runner, envs } = scriptedRunner();
    const adapter = new ExecutionRunnerAdapter({
      runSubprocess: runner,
      host: { hostName: 'midnight', transport: 'ssh', sshAlias: 'm', authFile: '/tmp/auth.env' },
    });

    const result = await adapter.startSession(startRequest);

    expect(result).toEqual({
      outcome: 'refused',
      reason: "Runner host 'midnight' declares no port; a dispatch cannot be addressed",
    });
    // Zero spawns, and the planted port was never borrowed as a substitute.
    expect(envs).toEqual([]);
    expect(adapter.describeRunner()).toBeUndefined();
  });

  it('refuses an ssh host with no alias rather than dialling the orchestrator loopback', async () => {
    const { runner, envs } = scriptedRunner();
    const adapter = new ExecutionRunnerAdapter({
      runSubprocess: runner,
      host: { hostName: 'midnight', transport: 'ssh', remotePort: 4166 },
    });

    const result = await adapter.startSession(startRequest);

    expect(result).toEqual({
      outcome: 'refused',
      reason: "Runner host 'midnight' is ssh but declares no ssh alias; a dispatch cannot be addressed",
    });
    expect(envs).toEqual([]);
  });

  it('refuses a host name that fails the loader host-name rule (H3b)', async () => {
    plantStaleRoutingEnvironment();
    const { runner, envs } = scriptedRunner();
    const adapter = new ExecutionRunnerAdapter({
      runSubprocess: runner,
      host: {
        hostName: '../escape',
        transport: 'ssh',
        sshAlias: 'm',
        remotePort: 4166,
      },
    });

    // The name passed in is the loader-validated host-map key; a name the
    // loader would refuse never reaches a subprocess.
    expect(adapter.configuredHostName()).toBeNull();

    const result = await adapter.startSession(startRequest);

    expect(result).toEqual({
      outcome: 'refused',
      reason: "Runner host name '../escape' is missing or not a valid installation host name; a dispatch cannot be addressed",
    });
    expect(envs).toEqual([]);
    // Nothing is recorded under the invalid name.
    expect(adapter.describeRunner()?.hostName).toBeNull();
  });

  it('keeps OCM_HOST and OCM_REMOTE_PORT out of the inherited allow-list', () => {
    expect(RUNNER_ENV_ALLOWLIST).not.toContain('OCM_HOST');
    expect(RUNNER_ENV_ALLOWLIST).not.toContain('OCM_REMOTE_PORT');
    expect(RUNNER_ENV_ALLOWLIST).not.toContain('OPENCODE_AUTH_FILE');
    // A planted routing variable is never inherited, in any mode.
    expect(buildRunnerEnv()).not.toHaveProperty('OCM_HOST');
    expect(buildRunnerEnv()).not.toHaveProperty('OCM_REMOTE_PORT');
  });
});

describe('ExecutionRunnerAdapter legacy mode is unchanged (H3a)', () => {
  it('still resolves the configured port and host options first', async () => {
    plantStaleRoutingEnvironment();
    const { runner, envs } = scriptedRunner();
    const adapter = new ExecutionRunnerAdapter({
      runSubprocess: runner,
      remotePort: 4166,
      remoteHost: 'midnight.lan',
    });

    const result = await adapter.startSession(startRequest);

    expect(result.outcome).toBe('started');
    expect(envs[0]).toEqual({ OCM_REMOTE_PORT: '4166', OCM_HOST: 'midnight.lan' });
  });

  it('still falls back to the environment when no option is configured', async () => {
    plantStaleRoutingEnvironment();
    const { executor, envs } = capturingExecutor();
    const adapter = new ExecutionRunnerAdapter({ executor });

    const result = await adapter.startSession(startRequest);

    expect(result.outcome).toBe('started');
    expect(envs[0].OCM_REMOTE_PORT).toBe(PLANTED.OCM_REMOTE_PORT);
    expect(envs[0].OCM_HOST).toBe(PLANTED.OCM_HOST);
  });

  it('records no host name in legacy mode', async () => {
    plantStaleRoutingEnvironment();
    const adapter = new ExecutionRunnerAdapter({ remotePort: 4166, remoteHost: 'midnight.lan' });

    expect(adapter.describeRunner()).toEqual({
      kind: 'opencode',
      remotePort: 4166,
      host: 'midnight.lan',
      hostName: null,
      agent: null,
      model: null,
      variant: null,
    });
  });

  it('sends no routing variables when nothing is configured and nothing is set', async () => {
    const { runner, envs } = scriptedRunner();
    const adapter = new ExecutionRunnerAdapter({ runSubprocess: runner });

    const result = await adapter.startSession(startRequest);

    expect(result.outcome).toBe('started');
    expect(envs[0]).toEqual({});
  });
});

describe('Attempts record the installation host name (H3a)', () => {
  it('describes and records the selected host name', async () => {
    const { runner } = scriptedRunner();
    const adapter = new ExecutionRunnerAdapter({
      runSubprocess: runner,
      host: { hostName: 'midnight', transport: 'ssh', sshAlias: 'm', remotePort: 4166 },
    });

    expect(adapter.describeRunner()?.hostName).toBe('midnight');
    const result = await adapter.startSession(startRequest);
    expect(result).toMatchObject({
      outcome: 'started',
      runner: { hostName: 'midnight', host: 'm', remotePort: 4166 },
    });
  });

  it('persists the host name on the dispatched attempt', async () => {
    const attempts = new Map<string, AttemptRecord>();
    const attemptRepo = {
      async findAttemptById(id: string) {
        return attempts.get(id) ?? null;
      },
      async saveAttempt(record: AttemptRecord) {
        attempts.set(record.id, record);
      },
    } as AttemptRepositoryPort;
    const workOrderRepo = {
      async findWorkOrderById(id: string) {
        return id === 'wo-1'
          ? {
              id: 'wo-1',
              projectId: 'proj-1',
              taskId: 'task-1',
              laneId: 'lane-1',
              repository: '/repo',
              baseCommit: 'abc123',
              ownedPaths: ['src/**'],
              policyRevision: 'policy-1',
              prerequisiteWorkOrderIds: [],
              state: 'approved' as const,
              revision: 1,
              createdAtIso: '2026-10-15T07:00:00.000Z',
              updatedAtIso: '2026-10-15T07:00:00.000Z',
            }
          : null;
      },
    } as WorkOrderRepositoryPort;
    const journal: ExecutionJournalPort = {
      async appendJournalEntry() {},
      async listJournalEntriesForAttempt() {
        return [];
      },
      async listActiveReservations() {
        return [
          {
            id: 'res-1',
            attemptId: 'attempt-1',
            hostId: 'midnight',
            slotIndex: 0,
            held: true,
            seatTool: 'opencode',
            reservedAtIso: '2026-10-15T07:00:00.000Z',
            releasedAtIso: null,
          },
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
    const workspace: WorkspacePort = {
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
      async readWorktreeFile() {
        return JSON.stringify({ modelAssignment: { model: 'm', agent: null, variant: null } });
      },
    };
    const { runner } = scriptedRunner();
    const runnerAdapter = new ExecutionRunnerAdapter({
      runSubprocess: runner,
      host: { hostName: 'midnight', transport: 'ssh', sshAlias: 'm', remotePort: 4166 },
    });
    const useCase = new DispatchAttemptUseCase({
      workOrderRepo,
      attemptRepo,
      journal,
      workspace,
      runner: runnerAdapter,
    });

    const result = await useCase.dispatchAttempt({
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
    });

    expect(result.outcome).toBe('started');
    expect(attempts.get('attempt-1')?.runner?.hostName).toBe('midnight');
  });

  it('reads a record persisted before the host name existed with hostName null', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-h3a-attempts-'));
    try {
      // An old record: a runner block that never held an installation host name.
      await fs.writeFile(
        path.join(stateDir, 'attempts.json'),
        JSON.stringify([
          {
            id: 'att-legacy',
            workOrderId: 'wo-1',
            kind: 'initial',
            fixNumber: 0,
            priorAttemptId: null,
            worktreePath: '/lanes/attempt-1',
            baseCommit: 'abc123',
            state: 'running',
            outcome: null,
            briefDigest: null,
            briefPackagePath: null,
            sessionId: 'ses-legacy',
            completionReceipt: null,
            artifacts: null,
            runner: { remotePort: 4166, host: 'm', agent: null, model: 'm', variant: null },
            createdAtIso: '2026-10-15T08:00:00.000Z',
            updatedAtIso: '2026-10-15T08:00:00.000Z',
          },
        ]),
        'utf8',
      );

      const adapter = new AttemptRepositoryAdapter({ stateDir });
      const loaded = await adapter.findAttemptById('att-legacy');

      expect(loaded?.runner?.hostName).toBeNull();
      // The alias stays in `host`: a legacy record is read with the old rule.
      expect(loaded?.runner?.host).toBe('m');
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it('round-trips a recorded host name through the repository', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-h3a-attempts-host-'));
    try {
      const adapter = new AttemptRepositoryAdapter({ stateDir });
      await adapter.saveAttempt({
        id: 'att-named',
        workOrderId: 'wo-1',
        kind: 'initial',
        fixNumber: 0,
        priorAttemptId: null,
        worktreePath: '/lanes/attempt-1',
        baseCommit: 'abc123',
        state: 'running',
        outcome: null,
        briefDigest: null,
        briefPackagePath: null,
        sessionId: 'ses-named',
        completionReceipt: null,
        artifacts: null,
        runner: {
          kind: 'opencode',
          remotePort: 4166,
          host: 'm',
          hostName: 'midnight',
          agent: null,
          model: 'm',
          variant: null,
        },
        createdAtIso: '2026-10-15T08:00:00.000Z',
        updatedAtIso: '2026-10-15T08:00:00.000Z',
      });

      expect((await adapter.findAttemptById('att-named'))?.runner?.hostName).toBe('midnight');
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});