/**
 * Tests for the composition-root runner profile selection (D4, D5, D6): the
 * capability report derived from an installation's lane-runner entry, the
 * forge mode, and the transport-trimmed runner environment. No subprocess is
 * spawned; the executor seam captures the environment.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { CommandExecutorPort, CommandRunOptions } from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import type { StartRunnerSessionRequest } from '../../../application/ports/out/ExecutionRunnerPort.out-port.js';
import { ExecutionRunnerAdapter, buildRunnerEnv } from '../ExecutionRunnerAdapter.adapter.js';
import {
  resolveInstallationForgeMode,
  resolveRunnerCapabilityProfile,
} from '../ExecutorSelector.adapter.js';

afterEach(() => {
  delete process.env.SSH_AUTH_SOCK;
});

describe('buildRunnerEnv transport trimming (D5)', () => {
  it('drops SSH_AUTH_SOCK for a local runner host and keeps the rest of the allow-list', () => {
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
    process.env.HOME = '/home/operator';

    const local = buildRunnerEnv(undefined, { transport: 'local' });
    expect(local.SSH_AUTH_SOCK).toBeUndefined();
    expect(local.HOME).toBe('/home/operator');

    const ssh = buildRunnerEnv(undefined, { transport: 'ssh' });
    expect(ssh.SSH_AUTH_SOCK).toBe('/tmp/agent.sock');

    const unset = buildRunnerEnv();
    expect(unset.SSH_AUTH_SOCK).toBe('/tmp/agent.sock');
  });
});

describe('ExecutionRunnerAdapter runner environment (D5)', () => {
  const startRequest: StartRunnerSessionRequest = {
    attemptId: 'att-env-1',
    worktreePath: '/tmp/runner-profile-worktree',
    briefPackagePath: '/tmp/runner-profile-worktree/.lane/brief.md',
    baseCommit: 'abc123',
    stepLimit: 10,
    timeLimitSeconds: 10,
    requiredCapabilities: {
      filesystemScope: 'scoped-worktree',
      networkEgressRestricted: true,
      cpuAndMemoryLimited: true,
      processTreeTermination: true,
      authoritativeCompletion: true,
      artifactPersistence: true,
    },
    model: 'example-provider/example-model',
  };

  function capturingExecutor(): { port: CommandExecutorPort; envs: Record<string, string>[] } {
    const envs: Record<string, string>[] = [];
    const port: CommandExecutorPort = {
      async run(_argv: readonly string[], options?: CommandRunOptions) {
        envs.push({ ...(options?.env ?? {}) });
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({ sessionID: 'ses_env-1' }),
          stderr: '',
        };
      },
    };
    return { port, envs };
  }

  it('omits SSH_AUTH_SOCK from the runner environment for a local host', async () => {
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
    const { port, envs } = capturingExecutor();
    const adapter = new ExecutionRunnerAdapter({
      executor: port,
      remotePort: 46000,
      runnerTransport: 'local',
    });

    const result = await adapter.startSession(startRequest);
    expect(result.outcome).toBe('started');
    expect(envs).toHaveLength(1);
    expect(envs[0].SSH_AUTH_SOCK).toBeUndefined();
  });

  it('keeps SSH_AUTH_SOCK in the runner environment for an ssh host', async () => {
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
    const { port, envs } = capturingExecutor();
    const adapter = new ExecutionRunnerAdapter({
      executor: port,
      remotePort: 46000,
      runnerTransport: 'ssh',
    });

    const result = await adapter.startSession(startRequest);
    expect(result.outcome).toBe('started');
    expect(envs[0].SSH_AUTH_SOCK).toBe('/tmp/agent.sock');
  });
});

describe('resolveRunnerCapabilityProfile (D4)', () => {
  const containerDeclaration = {
    source: 'declared' as const,
    filesystemScope: 'scoped-worktree' as const,
    networkEgressRestricted: true,
    cpuAndMemoryLimited: true,
    processTreeTermination: true,
  };

  it('maps a declared container profile with its transport and lane budget', () => {
    const profile = resolveRunnerCapabilityProfile({
      'build-host': {
        transport: 'local',
        roles: ['orchestrator', 'lane-runner'],
        runner: { capabilities: containerDeclaration, maxLanes: 3 },
      },
    });
    expect(profile).toEqual({
      transport: 'local',
      maxLanes: 3,
      capabilities: {
        source: 'declared',
        filesystemScope: 'scoped-worktree',
        networkEgressRestricted: true,
        cpuAndMemoryLimited: true,
        processTreeTermination: true,
        authoritativeCompletion: true,
        artifactPersistence: true,
      },
    });
  });

  it('maps an undeclared runner to filesystemScope unknown', () => {
    const profile = resolveRunnerCapabilityProfile({
      lane: {
        transport: 'ssh',
        roles: ['lane-runner'],
        runner: {
          capabilities: {
            source: 'undeclared',
            filesystemScope: 'unknown',
            networkEgressRestricted: null,
            cpuAndMemoryLimited: null,
            processTreeTermination: null,
          },
        },
      },
    });
    expect(profile?.capabilities).toEqual({
      source: 'undeclared',
      filesystemScope: 'unknown',
      networkEgressRestricted: false,
      cpuAndMemoryLimited: false,
      processTreeTermination: false,
      authoritativeCompletion: true,
      artifactPersistence: true,
    });
  });

  it('maps a legacy-asserted runner to today behaviour and no declaration becomes undeclared', () => {
    const legacy = resolveRunnerCapabilityProfile({
      lane: {
        transport: 'ssh',
        roles: ['lane-runner'],
        runner: {
          capabilities: {
            source: 'legacy-asserted',
            filesystemScope: 'scoped-worktree',
            networkEgressRestricted: true,
            cpuAndMemoryLimited: true,
            processTreeTermination: true,
          },
        },
      },
    });
    expect(legacy?.capabilities).toMatchObject({
      source: 'legacy-asserted',
      filesystemScope: 'scoped-worktree',
      networkEgressRestricted: true,
    });

    const bare = resolveRunnerCapabilityProfile({
      lane: { transport: 'local', roles: ['lane-runner'], runner: {} },
    });
    expect(bare?.capabilities.filesystemScope).toBe('unknown');
    expect(bare?.capabilities.source).toBe('undeclared');
  });

  it('returns undefined without a lane-runner host or runner block', () => {
    expect(resolveRunnerCapabilityProfile(undefined)).toBeUndefined();
    expect(resolveRunnerCapabilityProfile({})).toBeUndefined();
    expect(
      resolveRunnerCapabilityProfile({
        lane: { transport: 'local', roles: ['orchestrator'] },
      }),
    ).toBeUndefined();
  });
});

describe('resolveInstallationForgeMode (D6)', () => {
  it('reads the v2 modes and the v1 owner/repo mapping', () => {
    expect(resolveInstallationForgeMode({ forge: { mode: 'none' } })).toBe('none');
    expect(
      resolveInstallationForgeMode({ forge: { mode: 'github', owner: 'o', repo: 'r' } }),
    ).toBe('github');
    expect(resolveInstallationForgeMode({ forge: { owner: 'o', repo: 'r' } })).toBe('github');
    expect(resolveInstallationForgeMode(undefined)).toBeUndefined();
    expect(resolveInstallationForgeMode({})).toBeUndefined();
  });
});
