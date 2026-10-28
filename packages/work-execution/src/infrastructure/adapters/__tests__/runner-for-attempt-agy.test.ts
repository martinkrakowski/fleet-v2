import { describe, expect, it } from 'vitest';

import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
} from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import type { ExecutionRunnerPort } from '../../../application/ports/out/ExecutionRunnerPort.out-port.js';
import type { AttemptRunnerRecord } from '../../../domain/execution-records.js';
import { RunnerForAttemptAdapter } from '../RunnerForAttemptAdapter.adapter.js';
import { AgyRunnerAdapter } from '../AgyRunnerAdapter.adapter.js';
import { ExecutionRunnerAdapter } from '../ExecutionRunnerAdapter.adapter.js';
import { confirmRecordedHost } from '../ConfirmRecordedHost.js';

/**
 * Lane AG-2: the runner-for-attempt path reaches bin/agy-run on a confirmed
 * agy host when the root gives an agy executor for it. Every executor is a
 * recording fake — no bin/agy-run, no spawn, no ssh.
 */

/** A recording fake executor that answers every argv with a fixed exit. */
class RecordingExecutor implements CommandExecutorPort {
  readonly calls: { argv: readonly string[]; options?: CommandRunOptions }[] = [];

  constructor(private readonly exitCode: number | null = 0) {}

  async run(argv: readonly string[], options?: CommandRunOptions): Promise<CommandRunResult> {
    this.calls.push({ argv, options });
    return { exitCode: this.exitCode, signal: null, stdout: '', stderr: '' };
  }
}

const legacyStub: ExecutionRunnerPort = {
  describeCapabilities() {
    return {
      filesystemScope: 'scoped-worktree',
      networkEgressRestricted: true,
      cpuAndMemoryLimited: true,
      processTreeTermination: true,
      authoritativeCompletion: true,
      artifactPersistence: true,
    };
  },
  describeRunner() {
    return { kind: 'opencode', remotePort: 4000, host: null, agent: null, model: null, variant: null };
  },
  async startSession(_request) {
    return { outcome: 'refused', reason: 'stub' };
  },
  async inspectSession(_session) {
    return {
      runnerReachable: 'unknown',
      workspacePreparation: 'unprepared',
      workerCommand: 'not-started',
      completionReceipt: null,
      artifactsCollected: false,
    };
  },
  async stopSession(_request) {
    return { outcome: 'refused', reason: 'stub' };
  },
};

function agyAttemptRunner(): AttemptRunnerRecord {
  return {
    kind: 'agy',
    remotePort: null,
    host: null,
    hostName: 'agy-example',
    agent: null,
    model: 'm',
    variant: null,
  };
}

function makeAgyAdapter(executor: RecordingExecutor): RunnerForAttemptAdapter {
  return new RunnerForAttemptAdapter({
    hosts: {
      'agy-example': { transport: 'local', roles: ['lane-runner'], runner: { kind: 'agy', port: 46000 } },
    },
    legacyRunner: legacyStub,
    agyExecutorForHost: () => executor,
    agyRunBin: '/virtual/agy-run',
  });
}

function resolveAgyRunner(adapter: RunnerForAttemptAdapter): ExecutionRunnerPort {
  const result = adapter.runnerForAttempt({ runner: agyAttemptRunner() });
  if (!result.ok) throw new Error(`expected ok: ${JSON.stringify(result)}`);
  return result.runner;
}

describe('RunnerForAttemptAdapter agy host (AG-2)', () => {
  it('builds and caches an AgyRunnerAdapter for a confirmed agy host', () => {
    const executor = new RecordingExecutor();
    const adapter = new RunnerForAttemptAdapter({
      hosts: {
        'agy-example': { transport: 'local', roles: ['lane-runner'], runner: { kind: 'agy', port: 46000 } },
      },
      legacyRunner: legacyStub,
      agyExecutorForHost: () => executor,
    });
    const record = agyAttemptRunner();
    const first = adapter.runnerForAttempt({ runner: record });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.runner).toBeInstanceOf(AgyRunnerAdapter);
    expect(first.runner.describeRunner?.()?.kind).toBe('agy');
    const second = adapter.runnerForAttempt({ runner: record });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.runner).toBe(first.runner);
  });

  it('inspects a worktree through agy-run --status on the fake executor', async () => {
    const executor = new RecordingExecutor();
    const runner = resolveAgyRunner(makeAgyAdapter(executor));
    if (!runner.inspectWorktreeRun) throw new Error('expected inspectWorktreeRun');
    const result = await runner.inspectWorktreeRun({
      attemptId: 'att-1',
      worktreePath: '/lanes/att-1',
      runner: agyAttemptRunner(),
    });
    expect(result).toEqual({ state: 'idle' });
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0].argv[0].endsWith('agy-run')).toBe(true);
    expect(executor.calls[0].argv).toContain('--status');
    expect(executor.calls[0].argv).toContain('--dir');
  });

  it('stops a session through agy-run --abort and reports terminated', async () => {
    const executor = new RecordingExecutor();
    const runner = resolveAgyRunner(makeAgyAdapter(executor));
    const result = await runner.stopSession({
      attemptId: 'att-1',
      sessionId: 'ses-1',
      gracePeriodSeconds: 10,
      worktreePath: '/lanes/att-1',
      runner: agyAttemptRunner(),
    });
    expect(result).toEqual({
      outcome: 'terminated',
      receipt: expect.objectContaining({ stoppedByRequest: true, exitStatus: null }),
    });
    expect(executor.calls[0].argv).toContain('--abort');
  });

  it('refuses when the agy executor for the host is null', () => {
    const adapter = new RunnerForAttemptAdapter({
      hosts: {
        'agy-example': { transport: 'local', roles: ['lane-runner'], runner: { kind: 'agy', port: 46000 } },
      },
      legacyRunner: legacyStub,
      agyExecutorForHost: () => null,
    });
    expect(adapter.runnerForAttempt({ runner: agyAttemptRunner() })).toEqual({
      ok: false,
      reason: 'recorded host agy-example has no agy executor',
    });
  });

  it("keeps today's refusal when no agy executor option is given", () => {
    const adapter = new RunnerForAttemptAdapter({
      hosts: {
        'agy-example': { transport: 'local', roles: ['lane-runner'], runner: { kind: 'agy', port: 46000 } },
      },
      legacyRunner: legacyStub,
    });
    expect(adapter.runnerForAttempt({ runner: agyAttemptRunner() })).toEqual({
      ok: false,
      reason: 'recorded host agy-example runner kind agy has no adapter',
    });
  });

  it('keeps the recorded opencode path unchanged', () => {
    const adapter = new RunnerForAttemptAdapter({
      hosts: {
        'oc-example': { transport: 'local', roles: ['lane-runner'], runner: { kind: 'opencode', port: 4166 } },
      },
      legacyRunner: legacyStub,
      executor: new RecordingExecutor(),
      agyExecutorForHost: () => new RecordingExecutor(),
    });
    const result = adapter.runnerForAttempt({
      runner: {
        kind: 'opencode',
        remotePort: 4166,
        host: null,
        hostName: 'oc-example',
        agent: null,
        model: 'm',
        variant: null,
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runner).toBeInstanceOf(ExecutionRunnerAdapter);
      expect(result.runner.describeRunner?.()?.kind).toBe('opencode');
    }
  });

  it('records the host name and ssh alias on the built agy runner', () => {
    const executor = new RecordingExecutor();
    const local = new RunnerForAttemptAdapter({
      hosts: {
        'agy-example': { transport: 'local', roles: ['lane-runner'], runner: { kind: 'agy', port: 46000 } },
      },
      legacyRunner: legacyStub,
      agyExecutorForHost: () => executor,
    });
    const localResult = local.runnerForAttempt({ runner: agyAttemptRunner() });
    expect(localResult.ok).toBe(true);
    if (localResult.ok) {
      expect(localResult.runner.describeRunner?.()).toMatchObject({ hostName: 'agy-example', host: null });
    }

    const ssh = new RunnerForAttemptAdapter({
      hosts: {
        'agy-ssh-example': {
          transport: 'ssh',
          sshAlias: 'agy-alias-example',
          roles: ['lane-runner'],
          runner: { kind: 'agy', port: 46000 },
        },
      },
      legacyRunner: legacyStub,
      agyExecutorForHost: () => executor,
    });
    const sshResult = ssh.runnerForAttempt({
      runner: { ...agyAttemptRunner(), hostName: 'agy-ssh-example', host: 'agy-alias-example' },
    });
    expect(sshResult.ok).toBe(true);
    if (sshResult.ok) {
      expect(sshResult.runner.describeRunner?.()).toMatchObject({
        hostName: 'agy-ssh-example',
        host: 'agy-alias-example',
      });
    }
  });

  it('confirms an agy record with a null port against a host that declares one; port mismatch still refuses opencode', () => {
    const hosts = {
      'agy-example': {
        transport: 'local' as const,
        roles: ['lane-runner'],
        runner: { kind: 'agy' as const, port: 46000 },
      },
      'oc-example': {
        transport: 'local' as const,
        roles: ['lane-runner'],
        runner: { kind: 'opencode' as const, port: 4166 },
      },
    };
    expect(confirmRecordedHost(agyAttemptRunner(), hosts)).toEqual({
      ok: true,
      name: 'agy-example',
      spec: hosts['agy-example'],
      transport: 'local',
    });
    const ocRecord = {
      kind: 'opencode' as const,
      remotePort: 4166,
      host: null,
      hostName: 'oc-example',
      agent: null,
      model: 'm',
      variant: null,
    };
    const mismatched = {
      ...hosts,
      'oc-example': {
        transport: 'local' as const,
        roles: ['lane-runner'],
        runner: { kind: 'opencode' as const, port: 9999 },
      },
    };
    expect(confirmRecordedHost(ocRecord, mismatched)).toEqual({
      ok: false,
      reason: 'recorded host oc-example changed or was removed',
    });
  });

  it('keeps the agy runner literal identical without the new options', () => {
    const adapter = new AgyRunnerAdapter({ executor: new RecordingExecutor() });
    expect(adapter.describeRunner()).toEqual({
      kind: 'agy',
      remotePort: null,
      host: null,
      agent: null,
      model: null,
      variant: null,
    });
  });
});
