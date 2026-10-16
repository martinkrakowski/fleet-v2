// Evidence-context executors: stdin forwarding, timeout enforcement (the
// process tree is killed) and the captured-output budget. The ssh transport
// is exercised through a spawn mock (no network in lane tests).

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import { LocalExecutor } from '../LocalExecutor.adapter.js';

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
