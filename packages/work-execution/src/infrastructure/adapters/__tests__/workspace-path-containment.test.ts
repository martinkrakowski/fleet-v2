import { describe, expect, it } from 'vitest';

import { WorkspaceAdapter } from '../WorkspaceAdapter.adapter.js';
import { WorktreePathRefusedError } from '../../../application/ports/out/WorkspacePort.out-port.js';
import type {
  CommandRunOptions,
  CommandRunResult,
  CommandExecutorPort,
} from '../../../application/ports/out/CommandExecutorPort.out-port.js';

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

describe('WorkspaceAdapter readWorktreeFile path containment', () => {
  it('throws WorktreePathRefusedError for an absolute path without calling the executor', async () => {
    const { executor, calls } = fakeExecutor(() => ({}));
    const adapter = new WorkspaceAdapter({ executor });

    await expect(adapter.readWorktreeFile('/wt', '/etc/passwd')).rejects.toBeInstanceOf(
      WorktreePathRefusedError,
    );
    await expect(adapter.readWorktreeFile('/wt', '/etc/passwd')).rejects.toMatchObject({
      relativePath: '/etc/passwd',
    });
    expect(calls).toHaveLength(0);
  });

  it('throws WorktreePathRefusedError for a .. path without calling the executor', async () => {
    const { executor, calls } = fakeExecutor(() => ({}));
    const adapter = new WorkspaceAdapter({ executor });

    await expect(adapter.readWorktreeFile('/wt', '../outside')).rejects.toBeInstanceOf(
      WorktreePathRefusedError,
    );
    await expect(adapter.readWorktreeFile('/wt', 'a/../../outside')).rejects.toBeInstanceOf(
      WorktreePathRefusedError,
    );
    expect(calls).toHaveLength(0);
  });

  it('reads an absolute path that lies inside the worktree', async () => {
    const { executor, calls } = fakeExecutor(() => ({ stdout: 'brief-bytes' }));
    const adapter = new WorkspaceAdapter({ executor });

    expect(await adapter.readWorktreeFile('/wt', '/wt/.lane/brief.md')).toBe('brief-bytes');
    expect(calls[0].argv).toEqual(['cat', '/wt/.lane/brief.md']);
  });

  it('throws WorktreePathRefusedError for absolute paths outside or beside the worktree', async () => {
    const { executor, calls } = fakeExecutor(() => ({}));
    const adapter = new WorkspaceAdapter({ executor });

    for (const relativePath of ['/wt/../etc/passwd', '/wtx/a', '/etc/passwd']) {
      await expect(adapter.readWorktreeFile('/wt', relativePath)).rejects.toBeInstanceOf(
        WorktreePathRefusedError,
      );
      await expect(adapter.readWorktreeFile('/wt', relativePath)).rejects.toMatchObject({
        relativePath,
      });
    }
    expect(calls).toHaveLength(0);
  });

  it('still reads a contained worktree file through the executor', async () => {
    const { executor, calls } = fakeExecutor((_call, index) =>
      index === 0 ? { stdout: 'manifest-bytes' } : { exitCode: 1 },
    );
    const adapter = new WorkspaceAdapter({ executor });

    expect(await adapter.readWorktreeFile('/wt', '.lane/brief-manifest.json')).toBe('manifest-bytes');
    expect(calls[0].argv).toEqual(['cat', '/wt/.lane/brief-manifest.json']);
  });

  it('reads under the worktree for dot and trailing-slash relative paths', async () => {
    const { executor, calls } = fakeExecutor(() => ({ stdout: 'payload-bytes' }));
    const adapter = new WorkspaceAdapter({ executor });

    expect(await adapter.readWorktreeFile('/wt', '.')).toBe('payload-bytes');
    expect(calls[0].argv).toEqual(['cat', '/wt']);
    expect(await adapter.readWorktreeFile('/wt', 'a/b/')).toBe('payload-bytes');
    expect(calls[1].argv).toEqual(['cat', '/wt/a/b/']);
  });

  it('throws WorktreePathRefusedError for a path containing NUL bytes', async () => {
    const { executor, calls } = fakeExecutor(() => ({}));
    const adapter = new WorkspaceAdapter({ executor });

    await expect(adapter.readWorktreeFile('/wt', 'a/b\0/c')).rejects.toBeInstanceOf(
      WorktreePathRefusedError,
    );
    await expect(adapter.readWorktreeFile('/wt', 'a/b\0/c')).rejects.toMatchObject({
      relativePath: 'a/b\0/c',
    });
    expect(calls).toHaveLength(0);
  });
});
