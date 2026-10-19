import { describe, it, expect } from 'vitest';

import { isSafeSshHost, WorkspaceAdapter } from '../WorkspaceAdapter.adapter.js';
import { AttemptArtifactAdapter } from '../AttemptArtifactAdapter.adapter.js';

describe('isSafeSshHost', () => {
  it('accepts valid ssh host strings', () => {
    expect(isSafeSshHost('lanehost')).toBe(true);
    expect(isSafeSshHost('runner.local')).toBe(true);
    expect(isSafeSshHost('user@lanehost')).toBe(true);
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

describe('WorkspaceAdapter and AttemptArtifactAdapter are executor-only', () => {
  it('refuses to inspect a worktree without a configured executor', async () => {
    await expect(
      new WorkspaceAdapter().inspectWorktree({
        worktreePath: '/wt',
        baseCommit: 'commit000',
        expectedArtifactPaths: [],
      }),
    ).rejects.toThrow(/requires a configured CommandExecutorPort executor/);
  });

  it('refuses to place a brief without a configured executor', async () => {
    await expect(
      new AttemptArtifactAdapter().placeFrozenBrief({
        attemptId: 'att-1',
        worktreePath: '/wt',
        proseMarkdown: '# Brief',
        manifestJson: '{}',
      }),
    ).rejects.toThrow(/requires a configured CommandExecutorPort executor/);
  });

  it('refuses to read a brief manifest without a configured executor', async () => {
    await expect(new AttemptArtifactAdapter().readBriefManifest('/wt')).rejects.toThrow(
      /requires a configured CommandExecutorPort executor/,
    );
  });

  it('documents the transport change: git runs through the ssh executor even when the worktree path exists locally', async () => {
    // The legacy adapters probed `existsSync(worktreePath)` and silently ran
    // locally; the executor path never does. Once a worktree ssh host is
    // configured the installation decides the transport, whatever the local
    // filesystem shows.
    const calls: Array<{ argv: readonly string[] }> = [];
    const executor = {
      run: async (argv: readonly string[]) => {
        calls.push({ argv });
        return { exitCode: 0, signal: null, stdout: 'commit1234567\n', stderr: '' };
      },
    };
    const adapter = new WorkspaceAdapter({ executor });
    await adapter.inspectWorktree({
      worktreePath: '/tmp', // exists locally, yet the executor is still used
      baseCommit: 'commit1234567',
      expectedArtifactPaths: [],
    });
    expect(calls[0].argv.slice(0, 3)).toEqual(['git', '-C', '/tmp']);
  });
});
