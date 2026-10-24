// Evidence-context executors: stdin forwarding, timeout enforcement (the
// process tree is killed) and the captured-output budget. The ssh transport
// is exercised through a spawn mock (no network in lane tests).

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import { LocalExecutor } from '../LocalExecutor.adapter.js';
import { runSpawnOutcome } from '../spawn-run.js';

describe('evidence LocalExecutor', () => {
  it('returns stdin input through a real /bin/cat', async () => {
    const result = await new LocalExecutor().run(['/bin/cat'], { input: 'evidence-stdin' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('evidence-stdin');
  });

  it('kills a command that never exits at the timeout', async () => {
    const result = await new LocalExecutor().run(['/bin/sleep', '30'], { timeoutMs: 400 });
    expect(result.exitCode).toBeNull();
    expect(result.error).toContain('timeout');
  });

  it('reports an error when output exceeds maxBufferBytes', async () => {
    const result = await new LocalExecutor().run(
      ['/bin/sh', '-c', "head -c 200000 /dev/zero | tr '\\0' 'x'"],
      { maxBufferBytes: 1024 },
    );
    expect(result.error).toContain('maxBufferBytes');
    expect(result.exitCode).toBeNull();
  });
});

describe('evidence SshExecutor', () => {
  it('writes input to the ssh client stdin and closes it', async () => {
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
    vi.resetModules();
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));
    try {
      const { SshExecutor: FreshSshExecutor } = await import('../SshExecutor.adapter.js');
      const executor = new FreshSshExecutor({ host: 'verify.internal' });
      const pending = executor.run(['cat'], { input: 'verify-stdin-bytes' });
      setImmediate(() => child.emit('close', 0, null));
      const result = await pending;
      expect(result.exitCode).toBe(0);
      expect(written).toBe('verify-stdin-bytes');
      expect(ended).toBe(true);
      expect(spawnMock.mock.calls[0][0]).toBe('ssh');
    } finally {
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });

  it('kills a hung remote command at the timeout', async () => {
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
    vi.resetModules();
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));
    try {
      const { SshExecutor: FreshSshExecutor } = await import('../SshExecutor.adapter.js');
      const executor = new FreshSshExecutor({ host: 'verify.internal' });
      const pending = executor.run(['sleep', '999'], { timeoutMs: 300 });
      const result = await pending;
      expect(result.exitCode).toBeNull();
      expect(result.error).toContain('timeout');
    } finally {
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });
});

function setProcessEnv(key: string, value: string | undefined): () => void {
  const previous = process.env[key];
  process.env[key] = value;
  return () => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  };
}

describe('evidence default child environment (spawn-run allow-list)', () => {
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
        ['/bin/sh', '-c', 'printf %s "$EVIDENCE_EXECUTOR_TEST_VAR|$GH_TOKEN"'],
        { env: { EVIDENCE_EXECUTOR_TEST_VAR: 'explicit-wins' } },
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
    vi.resetModules();
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));
    try {
      const { SshExecutor: FreshSshExecutor } = await import('../SshExecutor.adapter.js');
      const executor = new FreshSshExecutor({ host: 'verify.internal' });
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

describe('evidence default run timeout (spawn-run)', () => {
  it('kills a hung command at the 60s default and reports the failure, never success', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 42_427,
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
    const spawnMock = vi.fn(() => child);
    vi.resetModules();
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

  it('decodes multi-byte UTF-8 characters split across stdout chunks without replacement characters', async () => {
    const outcome = await runSpawnOutcome(process.execPath, [
      '-e',
      'process.stdout.write(Buffer.from([0xe2,0x80])); setTimeout(() => process.stdout.write(Buffer.from([0x94])), 50)',
    ]);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe('—');
    expect(outcome.stdout).not.toContain('');
  });

  it('decodes multi-byte UTF-8 characters split across stderr chunks without replacement characters', async () => {
    const outcome = await runSpawnOutcome(process.execPath, [
      '-e',
      'process.stderr.write(Buffer.from([0xe2,0x80])); setTimeout(() => process.stderr.write(Buffer.from([0x94])), 50)',
    ]);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stderr).toBe('—');
    expect(outcome.stderr).not.toContain('');
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
