import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import { LocalExecutor } from '../LocalExecutor.adapter.js';
import { SshExecutor, posixQuote, sshArgvFor } from '../SshExecutor.adapter.js';
import { runSpawnOutcome } from '../spawn-run.js';
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

  it('kills a command that never exits when the timeout expires', async () => {
    const startedAt = Date.now();
    const result = await new LocalExecutor().run(['/bin/sleep', '30'], { timeoutMs: 400 });
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(result.exitCode).toBeNull();
    expect(result.error).toContain('timeout');
  });

  it('succeeds with more than 1 MiB of stdout (runner-parity output budget)', async () => {
    const result = await new LocalExecutor().run([
      '/bin/sh',
      '-c',
      "head -c 1048577 /dev/zero | tr '\\0' 'x'",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBe(1_048_577);
  });

  it('reports an error instead of truncating when stdout exceeds maxBufferBytes', async () => {
    const result = await new LocalExecutor().run(
      ['/bin/sh', '-c', "head -c 200000 /dev/zero | tr '\\0' 'x'"],
      { maxBufferBytes: 1024 },
    );
    expect(result.error).toContain('maxBufferBytes');
    expect(result.exitCode).toBeNull();
  });
});

describe('SshExecutor argv construction', () => {
  it('builds the exact batch-mode ssh argv with POSIX quoting', () => {
    expect(
      sshArgvFor('lanehost', ['git', '-C', '/worktree with space', 'log', "--format='%h'"]),
    ).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=15',
      'lanehost',
      '--',
      "'git' '-C' '/worktree with space' 'log' '--format='\\''%h'\\'''",
    ]);
    expect(posixQuote("it's")).toBe("'it'\\''s'");
  });

  it('refuses an unsafe host without spawning any subprocess', async () => {
    const spawnMock = vi.fn();
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));
    try {
      const { SshExecutor: FreshSshExecutor } = await import('../SshExecutor.adapter.js');
      const executor = new FreshSshExecutor({ host: '-oProxyCommand=x' });
      const result = await executor.run(['git', 'status']);
      expect(result.exitCode).toBeNull();
      expect(result.error).toContain('unsafe SSH host');
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });

  it('writes input to the ssh client stdin and closes it, and carries the env', async () => {
    let written = '';
    let ended = false;
    const child = Object.assign(new EventEmitter(), {
      pid: 42_424,
      stdin: {
        write: (chunk: string) => {
          written += chunk;
          return true;
        },
        end: () => {
          ended = true;
        },
        on: () => child,
      },
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn((signal?: NodeJS.Signals) => {
        if (signal === 'SIGKILL') setImmediate(() => child.emit('close', null, 'SIGKILL'));
      }),
    });
    const spawnMock = vi.fn((..._args: unknown[]) => child);
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));
    try {
      const { SshExecutor: FreshSshExecutor } = await import('../SshExecutor.adapter.js');
      const executor = new FreshSshExecutor({ host: 'lanehost' });
      const pending = executor.run(['cat'], { input: 'remote-stdin-bytes', env: { HOME: '/h' } });
      setImmediate(() => {
        child.emit('close', 0, null);
      });
      const result = await pending;
      expect(result.exitCode).toBe(0);
      expect(written).toBe('remote-stdin-bytes');
      expect(ended).toBe(true);
      expect(spawnMock.mock.calls[0][0]).toBe('ssh');
      expect(
        (spawnMock.mock.calls[0][2] as { env?: Record<string, string> } | undefined)?.env,
      ).toEqual({ HOME: '/h' });
    } finally {
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });

  it('kills a hung remote command at the timeout instead of leaving stdin open', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 42_425,
      exitCode: null,
      signalCode: null,
      stdin: { write: () => true, end: () => {}, on: () => child },
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn((signal?: NodeJS.Signals) => {
        if (signal === 'SIGKILL') setImmediate(() => child.emit('close', null, 'SIGKILL'));
      }),
    });
    const spawnMock = vi.fn((..._args: unknown[]) => child);
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));
    try {
      const { SshExecutor: FreshSshExecutor } = await import('../SshExecutor.adapter.js');
      const executor = new FreshSshExecutor({ host: 'lanehost' });
      const pending = executor.run(['sleep', '999'], { input: 'ignored', timeoutMs: 300 });
      const result = await pending;
      expect(result.exitCode).toBeNull();
      expect(result.error).toContain('timeout');
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

  it('applies buildRunnerEnv on the executor path: allow-list plus OCM overrides, never secrets', async () => {
    const previousToken = process.env.GH_TOKEN;
    process.env.GH_TOKEN = 'gh-secret-token';
    try {
      const withPort = fakeExecutor(() => ({}));
      const withPortAdapter = new ExecutionRunnerAdapter({
        executor: withPort.executor,
        remotePort: 4321,
        ocmRunBin: '/bin/echo',
      });
      await withPortAdapter.startSession(sessionRequest);
      const envWithPort = withPort.calls[0].options?.env;
      // The OCM override travels alongside the allow-listed host variables.
      expect(envWithPort?.OCM_REMOTE_PORT).toBe('4321');
      expect(typeof envWithPort?.PATH).toBe('string');
      expect(typeof envWithPort?.HOME).toBe('string');
      // A planted credential is stripped.
      expect(envWithPort?.GH_TOKEN).toBeUndefined();
      // The runner output budget matches the reviewed 64 MiB.
      expect(withPort.calls[0].options?.maxBufferBytes).toBe(64 * 1024 * 1024);

      const withoutPort = fakeExecutor(() => ({}));
      const withoutPortAdapter = new ExecutionRunnerAdapter({
        executor: withoutPort.executor,
        ocmRunBin: '/bin/echo',
      });
      await withoutPortAdapter.startSession(sessionRequest);
      const envWithoutPort = withoutPort.calls[0].options?.env;
      expect(envWithoutPort?.OCM_REMOTE_PORT).toBeUndefined();
      expect(typeof envWithoutPort?.PATH).toBe('string');
      expect(typeof envWithoutPort?.HOME).toBe('string');
      expect(envWithoutPort?.GH_TOKEN).toBeUndefined();
    } finally {
      if (previousToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previousToken;
    }
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
      worktree: { sshHost: 'lanehost' },
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

  it('refuses an ssh host spec without an sshAlias instead of silently going local', () => {
    expect(() => executorForHost({ transport: 'ssh' })).toThrow(/sshAlias/);
    expect(() =>
      resolveRoleExecutors({
        hosts: { broken: { transport: 'ssh', roles: ['lane-runner'] } },
      }),
    ).toThrow(/sshAlias/);
  });
});

/** A never-exiting child: only the process-tree kill can end it. */
function hungChild(pid: number) {
  const child = Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    signalCode: null,
    stdin: { write: () => true, end: () => {}, on: () => child },
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn((signal?: NodeJS.Signals) => {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        queueMicrotask(() => child.emit('close', null, signal));
      }
      return true;
    }),
  });
  return child;
}

/** A scripted child that exits 0 right after spawn (next microtask). */
function quickChild(pid: number) {
  const child = Object.assign(new EventEmitter(), {
    pid,
    stdin: { write: () => true, end: () => {}, on: () => child },
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
  queueMicrotask(() => child.emit('close', 0, null));
  return child;
}

function setProcessEnv(key: string, value: string | undefined): () => void {
  const previous = process.env[key];
  process.env[key] = value;
  return () => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  };
}

describe('default child environment (spawn-run allow-list)', () => {
  it('keeps a planted GH_TOKEN out of a local child environment when no env is given', async () => {
    const restore = setProcessEnv('GH_TOKEN', 'gh-secret-token');
    try {
      const result = await new LocalExecutor().run(['/bin/sh', '-c', 'printf %s "$GH_TOKEN"']);
      expect(result.exitCode).toBe(0);
      // The credential never reached the child.
      expect(result.stdout).toBe('');
    } finally {
      restore();
    }
  });

  it('keeps the allow-listed working set for a local child and drops SSH_AUTH_SOCK', async () => {
    const restore = setProcessEnv('SSH_AUTH_SOCK', '/tmp/planted-agent.sock');
    try {
      const path_ = await new LocalExecutor().run(['/bin/sh', '-c', 'printf %s "$PATH"']);
      expect(path_.exitCode).toBe(0);
      expect(path_.stdout.length).toBeGreaterThan(0);
      expect(path_.stdout).toBe(process.env.PATH);
      const agent = await new LocalExecutor().run(['/bin/sh', '-c', 'printf %s "$SSH_AUTH_SOCK"']);
      expect(agent.exitCode).toBe(0);
      // SSH_AUTH_SOCK is an ssh-only allowance; a local child never sees it.
      expect(agent.stdout).toBe('');
    } finally {
      restore();
    }
  });

  it('treats an explicit env as the complete environment instead of merging the allow-list', async () => {
    const restore = setProcessEnv('GH_TOKEN', 'gh-secret-token');
    try {
      const result = await new LocalExecutor().run(
        ['/bin/sh', '-c', 'printf %s "$LANE_EXECUTOR_TEST_VAR|$GH_TOKEN"'],
        { env: { LANE_EXECUTOR_TEST_VAR: 'explicit-wins' } },
      );
      expect(result.exitCode).toBe(0);
      // The explicit variable travels; nothing else (the planted token) is
      // merged in behind the caller's back.
      expect(result.stdout).toBe('explicit-wins|');
    } finally {
      restore();
    }
  });

  it('gives the ssh client an allow-listed environment: GH_TOKEN stripped, SSH_AUTH_SOCK kept', async () => {
    const restoreToken = setProcessEnv('GH_TOKEN', 'gh-secret-token');
    const restoreSock = setProcessEnv('SSH_AUTH_SOCK', '/tmp/planted-agent.sock');
    const child = Object.assign(new EventEmitter(), {
      pid: 42_426,
      stdin: { write: () => true, end: () => {}, on: () => child },
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    const spawnMock = vi.fn((..._args: unknown[]) => child);
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));
    try {
      const { SshExecutor: FreshSshExecutor } = await import('../SshExecutor.adapter.js');
      const executor = new FreshSshExecutor({ host: 'lanehost' });
      const pending = executor.run(['git', 'status']);
      setImmediate(() => child.emit('close', 0, null));
      const result = await pending;
      expect(result.exitCode).toBe(0);
      const env = (spawnMock.mock.calls[0][2] as { env?: Record<string, string> } | undefined)?.env;
      expect(env).toBeDefined();
      expect(env?.GH_TOKEN).toBeUndefined();
      // The ssh transport keeps the host's agent socket.
      expect(env?.SSH_AUTH_SOCK).toBe('/tmp/planted-agent.sock');
      expect(typeof env?.PATH).toBe('string');
      expect(typeof env?.HOME).toBe('string');
    } finally {
      restoreToken();
      restoreSock();
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });
});

describe('default run timeout (spawn-run)', () => {
  it('kills a hung command at the 60s default and reports the failure, never success', async () => {
    const child = hungChild(42_427);
    const spawnMock = vi.fn(() => child);
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));
    vi.useFakeTimers();
    try {
      const { runSpawnOutcome: freshRunSpawnOutcome } = await import('../spawn-run.js');
      const pending = freshRunSpawnOutcome('/bin/sleep', ['999']);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(child.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      const outcome = await pending;
      expect(outcome.exitCode).toBeNull();
      expect(outcome.signal).toBe('SIGTERM');
      expect(outcome.error).toContain('60000ms timeout');
    } finally {
      vi.useRealTimers();
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });

  it('still completes a fast command normally under the default budget', async () => {
    const outcome = await runSpawnOutcome('/bin/echo', ['fleet']);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe('fleet\n');
    expect(outcome.error).toBeUndefined();
  });
});

describe('explicit per-command budgets through the adapters', () => {
  it('WorkspaceAdapter gives every git command and test probe a 60s budget', async () => {
    const { executor, calls } = fakeExecutor((call, index) =>
      index === 0 ? { stdout: 'base0000\n' } : index === 1 ? { stdout: '' } : { exitCode: 1 },
    );
    const adapter = new WorkspaceAdapter({ executor: executor });
    await adapter.inspectWorktree({
      worktreePath: '/wt',
      baseCommit: 'base0000',
      expectedArtifactPaths: [],
    });
    const gitCalls = calls.filter((call) => call.argv[0] === 'git');
    const probeCalls = calls.filter((call) => call.argv[0] === 'test');
    expect(gitCalls.length).toBeGreaterThanOrEqual(2);
    expect(probeCalls.length).toBeGreaterThanOrEqual(1); // residue probes
    for (const call of [...gitCalls, ...probeCalls]) {
      expect(call.options?.timeoutMs).toBe(60_000);
    }
  });

  it('WorkspaceAdapter gives cat reads a 60s budget', async () => {
    const { executor, calls } = fakeExecutor(() => ({ stdout: 'file-bytes' }));
    const adapter = new WorkspaceAdapter({ executor: executor });
    await adapter.readWorktreeFile('/wt', '.lane/brief.md');
    expect(calls).toHaveLength(1);
    expect(calls[0].argv[0]).toBe('cat');
    expect(calls[0].options?.timeoutMs).toBe(60_000);
  });

  it('AttemptArtifactAdapter gives tee 120s and every other command 60s', async () => {
    const { executor, calls } = fakeExecutor((call) =>
      call.argv[0] === 'tee' ? { exitCode: 0 } : {},
    );
    const adapter = new AttemptArtifactAdapter({ executor: executor });
    const result = await adapter.placeFrozenBrief({
      attemptId: 'att-1',
      worktreePath: '/wt',
      proseMarkdown: '# Brief',
      manifestJson: '{}',
    });
    expect(result.outcome).toBe('placed');
    const teeCalls = calls.filter((call) => call.argv[0] === 'tee');
    expect(teeCalls).toHaveLength(2);
    for (const call of teeCalls) {
      expect(call.options?.timeoutMs).toBe(120_000);
    }
    const otherCalls = calls.filter((call) => call.argv[0] !== 'tee');
    expect(otherCalls.length).toBeGreaterThanOrEqual(3); // 2x check-ignore + mkdir
    for (const call of otherCalls) {
      expect(call.options?.timeoutMs).toBe(60_000);
    }
  });

  it('AttemptArtifactAdapter gives cat reads a 60s budget', async () => {
    const { executor, calls } = fakeExecutor(() => ({ stdout: '{}' }));
    const adapter = new AttemptArtifactAdapter({ executor: executor });
    await adapter.readBriefManifest('/wt');
    expect(calls).toHaveLength(1);
    expect(calls[0].argv[0]).toBe('cat');
    expect(calls[0].options?.timeoutMs).toBe(60_000);
  });
});

describe('a hung command through an adapter is killed at its budget', () => {
  it('WorkspaceAdapter: a hung git command dies at the 60s budget and the inspection fails, never succeeds', async () => {
    const child = hungChild(42_428);
    const spawnMock = vi.fn(() => child);
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));
    vi.useFakeTimers();
    try {
      const { LocalExecutor: FreshLocalExecutor } = await import('../LocalExecutor.adapter.js');
      const { WorkspaceAdapter: FreshWorkspaceAdapter } = await import(
        '../WorkspaceAdapter.adapter.js'
      );
      const adapter = new FreshWorkspaceAdapter({ executor: new FreshLocalExecutor() });
      const pending = adapter.inspectWorktree({
        worktreePath: '/wt',
        baseCommit: 'base0000',
        expectedArtifactPaths: [],
      });
      // Attach the rejection expectation before the kill lands, so the
      // rejection is never unhandled.
      const expectation = expect(pending).rejects.toThrow(/rev-parse HEAD failed/);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(child.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      await expectation;
    } finally {
      vi.useRealTimers();
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });

  it('AttemptArtifactAdapter: a hung tee dies at the 120s budget and the brief is refused, never placed', async () => {
    let nextPid = 43_000;
    const hung = hungChild(42_429);
    const spawnMock = vi.fn((file: string) => (file === 'tee' ? hung : quickChild(nextPid++)));
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));
    vi.useFakeTimers();
    try {
      const { LocalExecutor: FreshLocalExecutor } = await import('../LocalExecutor.adapter.js');
      const { AttemptArtifactAdapter: FreshAttemptArtifactAdapter } = await import(
        '../AttemptArtifactAdapter.adapter.js'
      );
      const adapter = new FreshAttemptArtifactAdapter({ executor: new FreshLocalExecutor() });
      const pending = adapter.placeFrozenBrief({
        attemptId: 'att-1',
        worktreePath: '/wt',
        proseMarkdown: '# Brief',
        manifestJson: '{}',
      });
      await vi.advanceTimersByTimeAsync(119_999);
      expect(hung.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(hung.kill).toHaveBeenCalledWith('SIGTERM');
      const result = await pending;
      expect(result.outcome).toBe('refused');
      expect((result as { reason?: string }).reason).toContain('120000ms timeout');
    } finally {
      vi.useRealTimers();
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });
});

describe('a timed-out child never reports a real exit code (spawn-run close handler)', () => {
  it('a child that traps SIGTERM and exits 0 still reports exitCode null with an error', async () => {
    const result = await runSpawnOutcome('/bin/sh', ['-c', 'trap "exit 0" TERM; sleep 30'], {
      timeoutMs: 300,
    });
    expect(result.exitCode).toBeNull();
    expect(result.error).toBeDefined();
    expect(result.error).not.toBe('');
  });

  it('kills the whole process tree: the grandchild is gone after the timeout', async () => {
    const result = await runSpawnOutcome(
      '/bin/sh',
      ['-c', 'sleep 999 & echo $!; wait'],
      { timeoutMs: 300 },
    );
    expect(result.exitCode).toBeNull();
    expect(result.error).toBeDefined();
    const grandchildPid = Number(result.stdout.trim().split('\n')[0]);
    expect(Number.isFinite(grandchildPid)).toBe(true);
    // The kill is asynchronous and the orphan is reaped by init, so poll briefly.
    const isAlive = (): boolean => {
      try {
        process.kill(grandchildPid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 3000;
    while (isAlive() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(isAlive()).toBe(false);
  });
});

describe('exit code null is failure/unknown, never an answer (adapters)', () => {
  it('WorkspaceAdapter: a null-exit-code probe throws instead of reporting absence', async () => {
    const { executor } = fakeExecutor(() => ({ exitCode: null, error: 'timeout' }));
    const adapter = new WorkspaceAdapter({ executor: executor });
    await expect(
      adapter.inspectWorktree({
        worktreePath: '/wt',
        baseCommit: 'base0000',
        expectedArtifactPaths: [],
      }),
    ).rejects.toThrow();
  });

  it('AttemptArtifactAdapter: a null-exit-code check-ignore throws instead of "not ignored"', async () => {
    const { executor } = fakeExecutor(() => ({ exitCode: null, error: 'timeout' }));
    const adapter = new AttemptArtifactAdapter({ executor: executor });
    await expect(
      adapter.verifyIgnoredPaths({ worktreePath: '/wt', candidatePaths: ['.lane/brief.md'] }),
    ).rejects.toThrow(/check-ignore failed/);
  });
});

describe('runner start budget (ExecutionRunnerAdapter)', () => {
  it('runs the start under the start budget plus grace and reports a timed-out start as unknown, never started', async () => {
    const { executor, calls } = fakeExecutor(() => ({ exitCode: null, error: 'timeout' }));
    const adapter = new ExecutionRunnerAdapter({
      executor: executor,
      remotePort: 4321,
      ocmRunBin: '/bin/echo',
      startBudgetSeconds: 10,
    });
    const result = await adapter.startSession(sessionRequest);
    expect(result.outcome).toBe('unknown');
    // 10 s budget + 30 s grace.
    expect(calls[0].options?.timeoutMs).toBe(40_000);
  });
});
