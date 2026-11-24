import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FleetInstallation } from '@fleet/installation';
import { RegisterWorkOrderUseCase, type SubprocessRunner } from '@fleet/work-execution';
import { exitCodeForResult, resolveRunnerSettings, runCli, type CliIo } from './index.js';
import { createFleetCliRuntime } from './composition.js';

describe('CLI installation wiring', () => {
  let tempDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'fleet-cli-test-'));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createMockIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
      io: {
        stdout: (text: string) => {
          stdout.push(text);
        },
        stderr: (text: string) => {
          stderr.push(text);
        },
      },
      stdout,
      stderr,
    };
  }

  describe('runCli with installation file', () => {
    it('refuses invalid installation file with exit 2, names file and leaks no sentinel value', async () => {
      const invalidFilePath = join(tempDir, 'invalid-fleet.json');
      const sentinelValue = 'SUPER_SECRET_SENTINEL_TOKEN_12345';
      const sentinelKey = 'UNRECOGNIZED_SENTINEL_FIELD';
      writeFileSync(
        invalidFilePath,
        JSON.stringify({
          schemaVersion: 1,
          [sentinelKey]: sentinelValue,
        }),
      );

      process.env.FLEET_INSTALLATION_FILE = invalidFilePath;

      const { io, stderr } = createMockIo();
      const exitCode = await runCli(['help'], io);

      expect(exitCode).toBe(2);
      const combinedStderr = stderr.join('');
      expect(combinedStderr).toContain('installation invalid');
      expect(combinedStderr).toContain(invalidFilePath);
      expect(combinedStderr).not.toContain(sentinelValue);
      expect(combinedStderr).not.toContain(sentinelKey);
    });

    it('bypasses installation loading when runtime is explicitly injected', async () => {
      const invalidFilePath = join(tempDir, 'invalid-fleet.json');
      writeFileSync(
        invalidFilePath,
        JSON.stringify({
          schemaVersion: 1,
          UNKNOWN_KEY: 'foo',
        }),
      );

      process.env.FLEET_INSTALLATION_FILE = invalidFilePath;

      const dummyRuntime = createFleetCliRuntime({ stateDir: tempDir });
      const { io, stdout } = createMockIo();
      const exitCode = await runCli(['help'], io, dummyRuntime);

      expect(exitCode).toBe(0);
      expect(stdout.join('')).toContain('Commands:');
    });
  });

  describe('resolveRunnerSettings', () => {
    it('uses worktree.sshHost from installation when env is unset', () => {
      const installation: FleetInstallation = {
        schemaVersion: 1,
        worktree: {
          sshHost: 'ssh.installation.example',
        },
      };

      const resolved = resolveRunnerSettings(undefined, installation, {});
      expect(resolved.worktreeSshHost).toBe('ssh.installation.example');
    });

    it('prefers options over installation and environment', () => {
      const installation: FleetInstallation = {
        schemaVersion: 1,
        worktree: {
          sshHost: 'ssh.installation.example',
        },
        runner: {
          agent: 'installation-agent',
          model: 'installation-model',
          variant: 'installation-variant',
          remotePort: 8080,
          ocmRunBin: '/opt/installation/ocm-run',
          host: 'installation-ocm-host',
        },
      };

      const env: Record<string, string | undefined> = {
        FLEET_WORKTREE_SSH_HOST: 'ssh.env.example',
        FLEET_RUNNER_AGENT: 'env-agent',
        FLEET_RUNNER_MODEL: 'env-model',
        FLEET_RUNNER_VARIANT: 'env-variant',
        OCM_REMOTE_PORT: '9000',
        FLEET_OCM_RUN_BIN: '/opt/env/ocm-run',
        OCM_HOST: 'env-ocm-host',
      };

      const resolved = resolveRunnerSettings(
        {
          worktreeSshHost: 'ssh.options.example',
          runnerAgent: 'opt-agent',
          runnerModel: 'opt-model',
          runnerVariant: 'opt-variant',
          runnerRemotePort: 7000,
          ocmRunBin: '/opt/options/ocm-run',
          runnerRemoteHost: 'opt-ocm-host',
        },
        installation,
        env,
      );

      expect(resolved.worktreeSshHost).toBe('ssh.options.example');
      expect(resolved.runnerAgent).toBe('opt-agent');
      expect(resolved.runnerModel).toBe('opt-model');
      expect(resolved.runnerVariant).toBe('opt-variant');
      expect(resolved.runnerRemotePort).toBe(7000);
      expect(resolved.ocmRunBin).toBe('/opt/options/ocm-run');
      expect(resolved.runnerRemoteHost).toBe('opt-ocm-host');
    });

    it('prefers installation over environment when options are unset', () => {
      const installation: FleetInstallation = {
        schemaVersion: 1,
        worktree: {
          sshHost: 'ssh.installation.example',
        },
        runner: {
          agent: 'installation-agent',
          model: 'installation-model',
          variant: 'installation-variant',
          remotePort: 8080,
          ocmRunBin: '/opt/installation/ocm-run',
          host: 'installation-ocm-host',
        },
      };

      const env: Record<string, string | undefined> = {
        FLEET_WORKTREE_SSH_HOST: 'ssh.env.example',
        FLEET_RUNNER_AGENT: 'env-agent',
        FLEET_RUNNER_MODEL: 'env-model',
        FLEET_RUNNER_VARIANT: 'env-variant',
        OCM_REMOTE_PORT: '9000',
        FLEET_OCM_RUN_BIN: '/opt/env/ocm-run',
        OCM_HOST: 'env-ocm-host',
      };

      const resolved = resolveRunnerSettings({}, installation, env);

      expect(resolved.worktreeSshHost).toBe('ssh.installation.example');
      expect(resolved.runnerAgent).toBe('installation-agent');
      expect(resolved.runnerModel).toBe('installation-model');
      expect(resolved.runnerVariant).toBe('installation-variant');
      expect(resolved.runnerRemotePort).toBe(8080);
      expect(resolved.ocmRunBin).toBe('/opt/installation/ocm-run');
      expect(resolved.runnerRemoteHost).toBe('installation-ocm-host');
    });

    it('falls back to environment when neither options nor installation specify values', () => {
      const installation: FleetInstallation = {
        schemaVersion: 1,
      };

      const env: Record<string, string | undefined> = {
        FLEET_WORKTREE_SSH_HOST: 'ssh.env.example',
        FLEET_RUNNER_AGENT: 'env-agent',
        FLEET_RUNNER_MODEL: 'env-model',
        FLEET_RUNNER_VARIANT: 'env-variant',
        OCM_REMOTE_PORT: '9000',
        FLEET_OCM_RUN_BIN: '/opt/env/ocm-run',
        OCM_HOST: 'env-ocm-host',
      };

      const resolved = resolveRunnerSettings({}, installation, env);

      expect(resolved.worktreeSshHost).toBe('ssh.env.example');
      expect(resolved.runnerAgent).toBe('env-agent');
      expect(resolved.runnerModel).toBe('env-model');
      expect(resolved.runnerVariant).toBe('env-variant');
      expect(resolved.runnerRemotePort).toBe(9000);
      expect(resolved.ocmRunBin).toBe('/opt/env/ocm-run');
      expect(resolved.runnerRemoteHost).toBe('env-ocm-host');
    });

    it('resolves installation when passed on options.installation', () => {
      const installation: FleetInstallation = {
        schemaVersion: 1,
        worktree: {
          sshHost: 'ssh.nested.example',
        },
      };

      const resolved = resolveRunnerSettings({ installation }, undefined, {});
      expect(resolved.worktreeSshHost).toBe('ssh.nested.example');
    });
  });

  describe('attempt dispatch, stop and usage CLI commands', () => {
    it('refuses attempt dispatch --model gpt-5 with usage error naming the field', async () => {
      const dummyRuntime = createFleetCliRuntime({ stateDir: tempDir });
      const { io, stderr } = createMockIo();
      const exitCode = await runCli(
        ['attempt', 'dispatch', '--attemptId', 'att-1', '--model', 'gpt-5'],
        io,
        dummyRuntime,
      );

      expect(exitCode).toBe(2);
      const combinedStderr = stderr.join('');
      expect(combinedStderr).toContain('model');
      expect(combinedStderr).toContain('forbidden');
    });

    it('stops a running attempt with matching recorded port at CLI level', async () => {
      const spawnedCalls: Array<{ args: readonly string[]; env?: Record<string, string> }> = [];
      const mockRunner: SubprocessRunner = async (_cmd, args, env) => {
        spawnedCalls.push({ args, env });
        return { exitCode: 0, stdout: 'Session aborted', stderr: '' };
      };

      const runtime = createFleetCliRuntime({
        stateDir: tempDir,
        runnerRemotePort: 4166,
        runSubprocess: mockRunner,
      });

      const attemptId = 'att-running-1';
      await runtime.execution.attemptRepository.saveAttempt({
        id: attemptId,
        workOrderId: 'wo-1',
        kind: 'initial',
        fixNumber: 0,
        priorAttemptId: null,
        worktreePath: tempDir,
        baseCommit: 'commit-base',
        state: 'running',
        outcome: null,
        briefDigest: 'digest-1',
        briefPackagePath: '.lane/brief.md',
        sessionId: 'ses-123',
        completionReceipt: null,
        artifacts: null,
        runner: {
          kind: 'opencode',
          remotePort: 4166,
          host: null,
          agent: null,
          model: 'model-a',
          variant: null,
        },
        createdAtIso: '2026-10-15T00:00:00.000Z',
        updatedAtIso: '2026-10-15T00:00:00.000Z',
      });

      const { io, stdout, stderr } = createMockIo();
      const exitCode = await runCli(['attempt', 'stop', '--attemptId', attemptId], io, runtime);

      expect(exitCode).toBe(0);
      expect(stderr).toEqual([]);
      expect(spawnedCalls).toHaveLength(1);
      expect(spawnedCalls[0].args).toEqual(['--abort', '--dir', tempDir]);
      expect(spawnedCalls[0].env?.OCM_REMOTE_PORT).toBe('4166');

      const saved = await runtime.execution.attemptRepository.findAttemptById(attemptId);
      expect(saved?.state).toBe('cancelled');
      expect(saved?.outcome).toBe('stopped');
      expect(saved?.completionReceipt?.authoritative).toBe(true);

      const parsedStdout = JSON.parse(stdout.join(''));
      expect(parsedStdout.outcome).toBe('terminated');
    });

    it('attempt usage exits 1 when the read is unavailable and 0 when it reads', async () => {
      // The command returns the usage port's result, so the outcome alone
      // decides the exit code: `unavailable` is a refusal-family exit (1),
      // `read` completes (0).
      expect(exitCodeForResult({ outcome: 'unavailable' }, 'attempt', 'usage')).toBe(1);
      expect(exitCodeForResult({ outcome: 'read' }, 'attempt', 'usage')).toBe(0);

      // End to end through the same command path the neighbouring cases
      // use: an attempt with no session id is an unavailable read (the port
      // decides; nothing is run), so the command exits 1 while still
      // printing the result and storing the unavailable usage record.
      const runtime = createFleetCliRuntime({ stateDir: tempDir });
      const attemptId = 'att-usage-no-session';
      await runtime.execution.attemptRepository.saveAttempt({
        id: attemptId,
        workOrderId: 'wo-1',
        kind: 'initial',
        fixNumber: 0,
        priorAttemptId: null,
        worktreePath: tempDir,
        baseCommit: 'commit-base',
        state: 'ended',
        outcome: null,
        briefDigest: 'digest-1',
        briefPackagePath: '.lane/brief.md',
        sessionId: null,
        completionReceipt: null,
        artifacts: null,
        runner: null,
        createdAtIso: '2026-10-15T00:00:00.000Z',
        updatedAtIso: '2026-10-15T00:00:00.000Z',
      });

      const { io, stdout } = createMockIo();
      const exitCode = await runCli(['attempt', 'usage', '--attemptId', attemptId], io, runtime);

      expect(exitCode).toBe(1);
      const parsed = JSON.parse(stdout.join(''));
      expect(parsed.outcome).toBe('unavailable');
      expect(parsed.usage.reason).toBe('no session id');
      const saved = await runtime.execution.attemptRepository.findAttemptById(attemptId);
      expect(saved?.usage?.reason).toBe('no session id');
    });
  });

  describe('work-order rerun stored baseBranch (RP1c)', () => {
    const activeProfile = {
      projectId: 'proj-1',
      status: 'active' as const,
      repository: 'git@example.org:acme/app.git',
      clones: {},
      gateProcedures: [],
      revision: 1,
    };

    /** A runtime whose store holds one stopped work order `wo-old` with the given extra fields. */
    async function seedStoppedWorkOrder(extra: Record<string, unknown>) {
      const runtime = createFleetCliRuntime({ stateDir: mkdtempSync(join(tempDir, 'rerun-')) });
      // Registration runs the real use case over the runtime's own work-order store with a fixed active profile.
      Object.assign(runtime.execution, {
        registerWorkOrder: new RegisterWorkOrderUseCase({
          workOrderRepo: runtime.execution.workOrderRepository,
          profileRead: { readProjectProfile: async () => activeProfile },
        }),
      });
      await runtime.execution.workOrderRepository.saveWorkOrder({
        id: 'wo-old',
        projectId: 'proj-1',
        taskId: 'task-1',
        laneId: 'lane-1',
        repository: 'git@example.org:acme/app.git',
        baseCommit: 'abc123',
        ownedPaths: ['packages/app-a/**'],
        policyRevision: 'policy-7',
        prerequisiteWorkOrderIds: [],
        state: 'stopped',
        revision: 1,
        createdAtIso: '2026-11-21T08:00:00.000Z',
        updatedAtIso: '2026-11-21T08:00:00.000Z',
        ...extra,
      } as unknown as Parameters<typeof runtime.execution.workOrderRepository.saveWorkOrder>[0]);
      return runtime;
    }

    it('refuses a stopped work order whose stored baseBranch is staging with unsupported-base-branch, exits 1 and registers nothing', async () => {
      const runtime = await seedStoppedWorkOrder({ baseBranch: 'staging' });
      const { io, stdout } = createMockIo();
      const exitCode = await runCli(
        ['work-order', 'rerun', '--from', 'wo-old', '--workOrderId', 'wo-new', '--yes'],
        io,
        runtime,
      );

      expect(exitCode).toBe(1);
      expect(JSON.parse(stdout.join(''))).toEqual({
        outcome: 'refused',
        reason: 'unsupported-base-branch',
        message: 'work-order rerun refused: stored baseBranch must be main or chain/<lowercase-dashes>',
      });
      expect(await runtime.execution.workOrderRepository.findWorkOrderById('wo-new')).toBeNull();
    });

    it('reruns a stopped work order with an absent stored baseBranch on main and a chain/<name> one on that chain', async () => {
      for (const [extra, expected] of [
        [{}, 'main'],
        [{ baseBranch: 'main' }, 'main'],
        [{ baseBranch: 'chain/example-1' }, 'chain/example-1'],
      ] as const) {
        const runtime = await seedStoppedWorkOrder(extra);
        const { io, stdout } = createMockIo();
        const exitCode = await runCli(
          ['work-order', 'rerun', '--from', 'wo-old', '--workOrderId', 'wo-new', '--yes'],
          io,
          runtime,
        );

        expect(exitCode).toBe(0);
        expect(JSON.parse(stdout.join(''))).toMatchObject({ outcome: 'registered' });
        expect((await runtime.execution.workOrderRepository.findWorkOrderById('wo-new'))?.baseBranch).toBe(expected);
      }
    });
  });

  describe('coordination resolve-auth head requirement (GR1a2 M5)', () => {
    it('exits 2 for a non-shadow scope without --expected-head-sha and reaches the use case head-free for merge:import-shadow', async () => {
      const runtime = createFleetCliRuntime({ stateDir: tempDir });

      // A non-shadow scope keeps the head requirement: a missing flag is a
      // usage error at the CLI boundary, never the use case's
      // not-implemented throw.
      const nonShadow = createMockIo();
      const nonShadowCode = await runCli(
        ['coordination', 'resolve-auth', '--projectId', 'proj-1', '--actionScope', 'forge:merge-pr'],
        nonShadow.io,
        runtime,
      );
      expect(nonShadowCode).toBe(2);
      expect(nonShadow.stderr.join('')).toContain('--expected-head-sha');
      expect(nonShadow.stdout).toEqual([]);

      // The standing shadow import grant is head-free: the same invocation
      // without the flag reaches the use case, which answers with its own
      // typed result (no grant is recorded in this fixture, so the resolve is
      // blocked at `grant-missing`).
      const shadow = createMockIo();
      const shadowCode = await runCli(
        ['coordination', 'resolve-auth', '--projectId', 'proj-1', '--actionScope', 'merge:import-shadow'],
        shadow.io,
        runtime,
      );
      expect(shadowCode).toBe(1);
      const parsed = JSON.parse(shadow.stdout.join('')) as { outcome: string; reason: string };
      expect(parsed).toEqual({ outcome: 'blocked', reason: 'grant-missing' });
    });
  });
});

