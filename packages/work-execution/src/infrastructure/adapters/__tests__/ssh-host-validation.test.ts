import { describe, it, expect, vi, beforeEach } from 'vitest';

type ExecFileCallback = (
  error: Error | null,
  result?: { stdout: string; stderr: string } | string,
) => void;

const execFileMock = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: readonly string[],
    optionsOrCallback?: unknown,
    callback?: ExecFileCallback,
  ) => {
    const cb = typeof optionsOrCallback === 'function'
      ? (optionsOrCallback as ExecFileCallback)
      : callback;
    return execFileMock(file, args, cb);
  },
}));

import { isSafeSshHost, WorkspaceAdapter } from '../WorkspaceAdapter.adapter.js';
import { AttemptArtifactAdapter } from '../AttemptArtifactAdapter.adapter.js';

describe('isSafeSshHost', () => {
  it('accepts valid ssh host strings', () => {
    expect(isSafeSshHost('midnight')).toBe(true);
    expect(isSafeSshHost('runner.local')).toBe(true);
    expect(isSafeSshHost('user@midnight')).toBe(true);
    expect(isSafeSshHost('deployer@192.168.1.50')).toBe(true);
    expect(isSafeSshHost('host-name-1')).toBe(true);
    expect(isSafeSshHost('user.name@host-1.example.com')).toBe(true);
  });

  it('rejects unsafe ssh host strings starting with hyphen or containing options', () => {
    expect(isSafeSshHost('-oProxyCommand=x')).toBe(false);
    expect(isSafeSshHost('-oProxyCommand=touch /tmp/pwn')).toBe(false);
    expect(isSafeSshHost('-h')).toBe(false);
    expect(isSafeSshHost('-host')).toBe(false);
    expect(isSafeSshHost('user@-host')).toBe(false);
    expect(isSafeSshHost('')).toBe(false);
    expect(isSafeSshHost('host with spaces')).toBe(false);
    expect(isSafeSshHost('host;rm -rf /')).toBe(false);
    expect(isSafeSshHost('host`id`')).toBe(false);
    expect(isSafeSshHost('host$(id)')).toBe(false);
  });
});

describe('WorkspaceAdapter SSH host validation and invocation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses to inspect a worktree when sshHost starts with -oProxyCommand=x and spawns no subprocess', async () => {
    const adapter = new WorkspaceAdapter({ sshHost: '-oProxyCommand=x' });

    await expect(
      adapter.inspectWorktree({
        worktreePath: '/nonexistent/worktree/path/for/test',
        baseCommit: 'commit000',
        expectedArtifactPaths: [],
      }),
    ).rejects.toThrow(/unsafe SSH host/);

    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('inserts -- before the command when invoking ssh on a safe host', async () => {
    execFileMock.mockImplementation(
      (_file: string, _args: readonly string[], cb: ExecFileCallback | undefined) => {
        if (cb) {
          cb(null, { stdout: 'commit1234567\n', stderr: '' });
        }
      },
    );

    const adapter = new WorkspaceAdapter({ sshHost: 'midnight' });

    await adapter.inspectWorktree({
      worktreePath: '/nonexistent/remote/worktree',
      baseCommit: 'commit1234567',
      expectedArtifactPaths: [],
    });

    expect(execFileMock).toHaveBeenCalled();
    const calls = execFileMock.mock.calls;
    for (const call of calls) {
      const [cmd, args] = call as [string, readonly string[]];
      expect(cmd).toBe('ssh');
      expect(args[0]).toBe('midnight');
      expect(args[1]).toBe('--');
    }
  });
});

describe('AttemptArtifactAdapter SSH host validation and invocation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses placeFrozenBrief with typed refusal when sshHost is -oProxyCommand=x and spawns no subprocess', async () => {
    const adapter = new AttemptArtifactAdapter({ sshHost: '-oProxyCommand=x' });

    const result = await adapter.placeFrozenBrief({
      attemptId: 'att-test-1',
      worktreePath: '/nonexistent/worktree/path',
      proseMarkdown: '# Test brief',
      manifestJson: '{}',
    });

    expect(result.outcome).toBe('refused');
    expect((result as { reason: string }).reason).toContain('unsafe SSH host');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('refuses collectCompletedAttemptArtifacts with typed refusal when sshHost is -oProxyCommand=x and spawns no subprocess', async () => {
    const adapter = new AttemptArtifactAdapter({ sshHost: '-oProxyCommand=x' });

    const result = await adapter.collectCompletedAttemptArtifacts({
      attemptId: 'att-test-1',
      worktreePath: '/nonexistent/worktree/path',
      baseCommit: 'commit000',
      expectedArtifactPaths: [],
      completionReceipt: {
        attemptId: 'att-test-1',
        sessionId: 'sess-test-1',
        endedAtIso: '2026-10-16T00:00:00.000Z',
        authoritative: true,
        exitStatus: 0,
        stoppedByRequest: false,
      },
    });

    expect(result.outcome).toBe('refused');
    expect((result as { reason: string }).reason).toContain('unsafe SSH host');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('inserts -- before the command on safe host during placeFrozenBrief', async () => {
    execFileMock.mockImplementation(
      (_file: string, _args: readonly string[], cb: ExecFileCallback | undefined) => {
        if (cb) {
          cb(null, { stdout: '', stderr: '' });
        }
      },
    );

    const adapter = new AttemptArtifactAdapter({ sshHost: 'midnight' });

    const result = await adapter.placeFrozenBrief({
      attemptId: 'att-test-2',
      worktreePath: '/nonexistent/remote/worktree',
      proseMarkdown: '# Safe brief',
      manifestJson: '{"safe":true}',
    });

    expect(result.outcome).toBe('placed');
    expect(execFileMock).toHaveBeenCalled();
    const calls = execFileMock.mock.calls;
    for (const call of calls) {
      const [cmd, args] = call as [string, readonly string[]];
      expect(cmd).toBe('ssh');
      expect(args[0]).toBe('midnight');
      expect(args[1]).toBe('--');
    }
  });
});
