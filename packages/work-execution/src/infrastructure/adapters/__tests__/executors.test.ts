import { describe, it, expect, vi } from 'vitest';

import { LocalExecutor } from '../LocalExecutor.adapter.js';
import { SshExecutor, posixQuote, sshArgvFor } from '../SshExecutor.adapter.js';
import { executorForHost, resolveRoleExecutors } from '../ExecutorSelector.adapter.js';
import { WorkspaceAdapter } from '../WorkspaceAdapter.adapter.js';
import { AttemptArtifactAdapter } from '../AttemptArtifactAdapter.adapter.js';
import { ExecutionRunnerAdapter } from '../ExecutionRunnerAdapter.adapter.js';
import type { CommandRunOptions, CommandRunResult, CommandExecutorPort } from '../../../application/ports/out/CommandExecutorPort.out-port.js';

type RunCall = { argv: readonly string[]; options?: CommandRunOptions };

/** A recording fake executor with scripted outcomes per call. */
function fakeExecutor(respond: (call: RunCall, index: number) => Partial<CommandRunResult>): {
  executor: CommandExecutorPort;
  calls: RunCall[];
} {
  const calls: RunCall[] = [];
  return {
    executor: {
      run: async (argv: readonly string[], options?: CommandRunOptions): Promise<CommandRunResult> => {
        const index = calls.length;
        const call: RunCall = { argv, options };
        calls.push(call);
        return { exitCode: 0, signal: null, stdout: '', stderr: '', ...respond(call, index) };
      },
    },
    calls,
  };
}

describe('LocalExecutor', () => {
  it('runs a real /bin/echo and reports its stdout and exit code', async () => {
    const result = await new LocalExecutor().run(['/bin/echo', 'hello', 'fleet']);
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe('hello fleet\n');
    expect(result.stderr).toBe('');
  });

  it('runs a failing command with its exit code and stderr', async () => {
    const result = await new LocalExecutor().run(['/bin/sh', '-c', 'echo boom >&2; exit 3']);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('boom');
  });

  it('reports a missing binary as an error without an exit code', async () => {
    const result = await new LocalExecutor().run(['/definitely/not/a/binary']);
    expect(result.exitCode).toBeNull();
    expect(result.error).toBeDefined();
  });

  it('forwards stdin input to the command', async () => {
    const result = await new LocalExecutor().run(['/bin/cat'], { input: 'piped-bytes' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('piped-bytes');
  });
});

describe('SshExecutor argv construction', () => {
  it('builds the exact batch-mode ssh argv with POSIX quoting', () => {
    expect(
      sshArgvFor('midnight', ['git', '-C', '/worktree with space', 'log', "--format='%h'"]),
    ).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=15',
      'midnight',
      '--',
      "'git' '-C' '/worktree with space' 'log' '--format='\\''%h'\\'''",
    ]);
    expect(posixQuote("it's")).toBe("'it'\\''s'");
  });

  it('refuses an unsafe host without spawning any subprocess', async () => {
    const execFileMock = vi.fn();
    vi.doMock('node:child_process', () => ({ execFile: execFileMock }));
    try {
      const { SshExecutor: FreshSshExecutor } = await import('../SshExecutor.adapter.js');
      const executor = new FreshSshExecutor({ host: '-oProxyCommand=x' });
      const result = await executor.run(['git', 'status']);
      expect(result.exitCode).toBeNull();
      expect(result.error).toContain('unsafe SSH host');
      expect(execFileMock).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });
});

describe('WorkspaceAdapter with a fake executor', () => {
  it('runs git through the executor and reads the status porcelain output', async () => {
    const { executor, calls } = fakeExecutor((call, index) =>
      index === 0
        ? { stdout: 'commit1234567\n' }
        : { stdout: ' M src/a.ts\n?? notes.md\n' },
    );
    const adapter = new WorkspaceAdapter({ executor: executor });
    const inspection = await adapter.inspectWorktree({
      worktreePath: '/wt',
      baseCommit: 'commit1234567',
      expectedArtifactPaths: ['.lane/notes.md'],
    });
    expect(inspection.checkedOutCommit).toBe('commit1234567');
    expect(inspection.uncommittedPaths).toEqual(['src/a.ts']);
    expect(inspection.untrackedPaths).toEqual(['notes.md']);
    expect(calls[0].argv.slice(0, 3)).toEqual(['git', '-C', '/wt']);
    // Existence probes run as commands through the executor, not the local fs.
    expect(calls.some((call) => call.argv[0] === 'test' && call.argv[1] === '-e')).toBe(true);
  });

  it('reads a worktree file through the executor and reports absence as null', async () => {
    const { executor } = fakeExecutor((call, index) =>
      index === 0 ? { stdout: 'manifest-bytes' } : { exitCode: 1 },
    );
    const adapter = new WorkspaceAdapter({ executor: executor });
    expect(await adapter.readWorktreeFile('/wt', '.lane/brief-manifest.json')).toBe('manifest-bytes');
    expect(await adapter.readWorktreeFile('/wt', '.lane/missing.json')).toBeNull();
  });
});

describe('AttemptArtifactAdapter with a fake executor', () => {
  it('places a frozen brief through mkdir and stdin tee, byte-identical', async () => {
    const { executor, calls } = fakeExecutor((call) =>
      call.argv[0] === 'tee' ? { exitCode: 0 } : {},
    );    const adapter = new AttemptArtifactAdapter({ executor: executor });
    const result = await adapter.placeFrozenBrief({
      attemptId: 'att-1',
      worktreePath: '/wt',
      proseMarkdown: '# Brief with \'quotes\' and $vars',
      manifestJson: '{"k":1}',
    });
    expect(result.outcome).toBe('placed');
    const mkdir = calls.find((call) => call.argv[0] === 'mkdir');
    expect(mkdir?.argv).toEqual(['mkdir', '-p', '/wt/.lane']);
    const teeCalls = calls.filter((call) => call.argv[0] === 'tee');
    expect(teeCalls.map((call) => call.argv[1])).toEqual([
      '/wt/.lane/brief.md',
      '/wt/.lane/brief-manifest.json',
    ]);
    expect(teeCalls[0].options?.input).toBe('# Brief with \'quotes\' and $vars');
    expect(teeCalls[1].options?.input).toBe('{"k":1}');
  });

  it('refuses a brief whose target paths are not gitignored', async () => {
    const { executor } = fakeExecutor((_call, index) => (index === 0 ? { exitCode: 1 } : {}));
    const adapter = new AttemptArtifactAdapter({ executor: executor });
    const result = await adapter.placeFrozenBrief({
      attemptId: 'att-1',
      worktreePath: '/wt',
      proseMarkdown: '# Brief',
      manifestJson: '{}',
    });
    expect(result.outcome).toBe('refused');
  });

  it('collects artifacts through the executor with the recorded head and notes', async () => {
    const { executor } = fakeExecutor((_call, index) => {
      // rev-parse HEAD, rev-list, then existence probes.
      if (index === 0) return { stdout: 'head111\n' };
      if (index === 1) return { stdout: 'head111\nbase000\n' };
      if (index === 2) return { exitCode: 0 }; // .lane/notes.md exists (notes probe)
      return { exitCode: 0 }; // .lane/notes.md exists (artifact probe)
    });
    const adapter = new AttemptArtifactAdapter({ executor: executor });
    const result = await adapter.collectCompletedAttemptArtifacts({
      attemptId: 'att-1',
      worktreePath: '/wt',
      baseCommit: 'base000',
      expectedArtifactPaths: [],
      completionReceipt: {
        attemptId: 'att-1',
        sessionId: 'sess-1',
        endedAtIso: '2026-10-16T00:00:00.000Z',
        authoritative: true,
        exitStatus: 0,
        stoppedByRequest: false,
      },
    });
    expect(result.outcome).toBe('collected');
    const artifacts = (result as { artifacts?: { headCommit: string; notes: string; collectedArtifactPaths: string[] } }).artifacts;
    expect(artifacts?.headCommit).toBe('head111');
    expect(artifacts?.notes).toBe('present');
    expect(artifacts?.collectedArtifactPaths).toEqual(['.lane/notes.md']);
  });
});

  const sessionRequest = {
    attemptId: 'att-1',
    worktreePath: '/wt',
    briefPackagePath: '/wt/.lane/brief.md',
    baseCommit: 'base000',
    stepLimit: 10,
    timeLimitSeconds: 60,
    model: 'glm-5.3',
    requiredCapabilities: {
      filesystemScope: 'scoped-worktree',
      networkEgressRestricted: true,
      cpuAndMemoryLimited: true,
      processTreeTermination: true,
      authoritativeCompletion: true,
      artifactPersistence: true,
    },
  } as const;

  describe('ExecutionRunnerAdapter with a fake executor', () => {
  it('starts a session through the executor and parses the session id', async () => {
    const { executor, calls } = fakeExecutor((_call, index) =>
      index === 0 ? { stdout: '{"sessionID":"ses_abc123"}\n' } : {},
    );
    const adapter = new ExecutionRunnerAdapter({
      executor: executor,
      remotePort: 4321,
      ocmRunBin: '/bin/echo',
    });
    const result = await adapter.startSession(sessionRequest);
    expect(result.outcome).toBe('started');
    expect((result as { sessionId: string }).sessionId).toBe('ses_abc123');
    expect(calls[0].argv[0]).toBe('/bin/echo');
    expect(calls[0].options?.env?.OCM_REMOTE_PORT).toBe('4321');
  });

  it('reports an executor spawn failure as an unknown outcome', async () => {
    const { executor } = fakeExecutor((_call, index) =>
      index === 0 ? { exitCode: null, error: 'spawn failed' } : {},
    );
    const adapter = new ExecutionRunnerAdapter({
      executor: executor,
      remotePort: 4321,
      ocmRunBin: '/bin/echo',
    });
    const result = await adapter.startSession(sessionRequest);
    expect(result.outcome).toBe('unknown');
  });
});

describe('resolveRoleExecutors', () => {
  it('maps a v1 installation to the owner hosts: worktree ssh host, runner host, port kept separate', () => {
    const executors = resolveRoleExecutors({
      worktree: { sshHost: 'midnight' },
      runner: { host: 'tunnel-host', ocmRunBin: '/opt/ocm-run' },
      verification: { sshHost: 'verifier.internal', procedures: {} },
    });
    expect(executors.orchestrator).toBeInstanceOf(LocalExecutor);
    expect(executors.worktree).toBeInstanceOf(SshExecutor);
    expect(executors.verifier).toBeInstanceOf(SshExecutor);
  });

  it('keeps runner.host and runner.ocmRunBin out of the executor mapping', () => {
    // runner.host is the OCM_HOST tunnel target, never the worktree executor.
    const executors = resolveRoleExecutors({
      runner: { host: 'tunnel-host', ocmRunBin: '/opt/ocm-run' },
    });
    expect(executors.worktree).toBeInstanceOf(LocalExecutor);
    expect(executors.verifier).toBeInstanceOf(LocalExecutor);
  });

  it('never constructs an SshExecutor for a single-machine v2 installation', () => {
    const executors = resolveRoleExecutors({
      hosts: {
        devbox: {
          transport: 'local',
          worktreeRoot: '/srv/fleet',
          roles: ['orchestrator', 'lane-runner', 'verifier'],
        },
      },
    });
    expect(executors.orchestrator).toBeInstanceOf(LocalExecutor);
    expect(executors.worktree).toBeInstanceOf(LocalExecutor);
    expect(executors.verifier).toBeInstanceOf(LocalExecutor);
  });

  it('picks ssh executors per role from a multi-machine v2 installation', () => {
    const executors = resolveRoleExecutors({
      hosts: {
        lane: { transport: 'ssh', sshAlias: 'lane-host', roles: ['lane-runner'] },
        verify: { transport: 'ssh', sshAlias: 'verify-host', roles: ['verifier'] },
        here: { transport: 'local', roles: ['orchestrator'] },
      },
    });
    expect(executors.worktree).toBeInstanceOf(SshExecutor);
    expect(executors.verifier).toBeInstanceOf(SshExecutor);
    expect(executors.orchestrator).toBeInstanceOf(LocalExecutor);
  });

  it('lets a root override win over the installation mapping', () => {
    const executors = resolveRoleExecutors(
      { hosts: { devbox: { transport: 'local', roles: ['lane-runner'] } } },
      { worktreeSshHost: 'override-host' },
    );
    expect(executors.worktree).toBeInstanceOf(SshExecutor);
  });

  it('selects a local executor for an undefined or local host spec', () => {
    expect(executorForHost(undefined)).toBeInstanceOf(LocalExecutor);
    expect(executorForHost({ transport: 'local' })).toBeInstanceOf(LocalExecutor);
  });
});
