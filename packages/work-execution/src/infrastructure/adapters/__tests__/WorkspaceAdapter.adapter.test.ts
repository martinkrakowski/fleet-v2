import { describe, expect, it, vi } from 'vitest';
import {
  WorkspaceAdapter,
  resetWouldDestroyUntracked,
} from '../WorkspaceAdapter.adapter.js';
import type { CommandExecutorPort, CommandRunResult } from '../../../application/ports/out/CommandExecutorPort.out-port.js';

describe('resetWouldDestroyUntracked (Findings 3 & 5)', () => {
  it('detects collision when an untracked directory obstructs a staged addition', () => {
    // Staged addition in index is tracked, but absent from HEAD. Untracked directory obstructs it.
    const trackedPaths = ['staged_dir/file.txt'];
    const untrackedFiles = ['staged_dir'];
    expect(resetWouldDestroyUntracked(trackedPaths, untrackedFiles)).toBe(true);
  });

  it('detects collision when an untracked directory or file is inside a tracked directory', () => {
    const trackedPaths = ['dist'];
    const untrackedFiles = ['dist/output.js'];
    expect(resetWouldDestroyUntracked(trackedPaths, untrackedFiles)).toBe(true);
  });

  it('detects collision when an untracked file or directory exactly matches a tracked path', () => {
    const trackedPaths = ['src/index.ts'];
    const untrackedFiles = ['src/index.ts'];
    expect(resetWouldDestroyUntracked(trackedPaths, untrackedFiles)).toBe(true);
  });

  it('detects collision when an untracked directory masks a tracked file', () => {
    const trackedPaths = ['src/components/Button.tsx'];
    const untrackedFiles = ['src/components'];
    expect(resetWouldDestroyUntracked(trackedPaths, untrackedFiles)).toBe(true);
  });

  it('returns false when tracked and untracked paths do not collide', () => {
    const trackedPaths = ['src/a.ts', 'src/b.ts'];
    const untrackedFiles = ['src/c.ts', 'other/file.txt'];
    expect(resetWouldDestroyUntracked(trackedPaths, untrackedFiles)).toBe(false);
  });
});

describe('WorkspaceAdapter preserveWorktreeEdits (Finding 4)', () => {
  function makeExecutor(
    runFn: (argv: readonly string[]) => Promise<{ exitCode: number | null; stdout: string; stderr: string; signal?: string | null; error?: string }>,
  ): CommandExecutorPort {
    return {
      run: vi.fn().mockImplementation(async (argv: readonly string[]): Promise<CommandRunResult> => {
        const res = await runFn(argv);
        return {
          exitCode: res.exitCode,
          stdout: res.stdout,
          stderr: res.stderr,
          signal: res.signal ?? null,
          ...(res.error !== undefined ? { error: res.error } : {}),
        };
      }),
    };
  }

  it('refuses destination-exists when tempPath still exists after mv -n (skipped move)', async () => {
    const executedCommands: string[][] = [];
    const executor = makeExecutor(async (argv) => {
      executedCommands.push([...argv]);
      const cmd = argv.join(' ');
      if (cmd.includes('test -e /patch/target.patch') || cmd.includes('test -L /patch/target.patch')) {
        // Did not exist initially
        return { exitCode: 1, stdout: '', stderr: '' };
      }
      if (cmd.includes('diff --binary HEAD')) {
        return { exitCode: 0, stdout: 'diff --git a/file b/file\n+new line', stderr: '' };
      }
      if (cmd.includes('mktemp')) {
        return { exitCode: 0, stdout: '/patch/.fleet-patch.123456\n', stderr: '' };
      }
      if (cmd.includes('tee /patch/.fleet-patch.123456')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmd.includes('mv -n /patch/.fleet-patch.123456 /patch/target.patch')) {
        // mv -n returns 0 even when skipped due to destination appearing
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmd.includes('test -e /patch/.fleet-patch.123456')) {
        // temp file still exists! Move was skipped because destination exists!
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmd.includes('rm -f /patch/.fleet-patch.123456')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmd.includes('pwd -P')) {
        return { exitCode: 0, stdout: `${argv[4] ?? ''}\n`, stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const adapter = new WorkspaceAdapter({ executor });
    const result = await adapter.preserveWorktreeEdits({
      worktreePath: '/var/lane/wt',
      patchPath: '/patch/target.patch',
    });

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toBe('destination-exists');
    }
    expect(executedCommands.some((c) => c.includes('rm') && c.includes('/patch/.fleet-patch.123456'))).toBe(true);
  });

  it('refuses git-refused when cmp fails to verify patchPath contents', async () => {
    const executor = makeExecutor(async (argv) => {
      const cmd = argv.join(' ');
      if (cmd.includes('test -e /patch/target.patch') || cmd.includes('test -L /patch/target.patch')) {
        return { exitCode: 1, stdout: '', stderr: '' };
      }
      if (cmd.includes('diff --binary HEAD')) {
        return { exitCode: 0, stdout: 'diff content', stderr: '' };
      }
      if (cmd.includes('mktemp')) {
        return { exitCode: 0, stdout: '/patch/.fleet-patch.123456\n', stderr: '' };
      }
      if (cmd.includes('tee /patch/.fleet-patch.123456')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmd.includes('mv -n /patch/.fleet-patch.123456 /patch/target.patch')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmd.includes('test -e /patch/.fleet-patch.123456')) {
        // temp file no longer exists: move succeeded
        return { exitCode: 1, stdout: '', stderr: '' };
      }
      if (cmd.includes('cmp - /patch/target.patch')) {
        // cmp verification failed
        return { exitCode: 1, stdout: '', stderr: 'mismatch' };
      }
      if (cmd.includes('pwd -P')) {
        return { exitCode: 0, stdout: `${argv[4] ?? ''}\n`, stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const adapter = new WorkspaceAdapter({ executor });
    const result = await adapter.preserveWorktreeEdits({
      worktreePath: '/var/lane/wt',
      patchPath: '/patch/target.patch',
    });

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toBe('git-refused');
    }
  });

  it('preserves patch when destination does not exist and verify succeeds', async () => {
    const executor = makeExecutor(async (argv) => {
      const cmd = argv.join(' ');
      if (cmd.includes('test -e /patch/target.patch') || cmd.includes('test -L /patch/target.patch')) {
        return { exitCode: 1, stdout: '', stderr: '' };
      }
      if (cmd.includes('diff --binary HEAD')) {
        return { exitCode: 0, stdout: 'diff content here', stderr: '' };
      }
      if (cmd.includes('mktemp')) {
        return { exitCode: 0, stdout: '/patch/.fleet-patch.123456\n', stderr: '' };
      }
      if (cmd.includes('tee /patch/.fleet-patch.123456')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmd.includes('mv -n /patch/.fleet-patch.123456 /patch/target.patch')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmd.includes('test -e /patch/.fleet-patch.123456')) {
        // temp file no longer exists: move succeeded
        return { exitCode: 1, stdout: '', stderr: '' };
      }
      if (cmd.includes('cmp - /patch/target.patch')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmd.includes('pwd -P')) {
        return { exitCode: 0, stdout: `${argv[4] ?? ''}\n`, stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const adapter = new WorkspaceAdapter({ executor });
    const result = await adapter.preserveWorktreeEdits({
      worktreePath: '/var/lane/wt',
      patchPath: '/patch/target.patch',
    });

    expect(result.outcome).toBe('preserved');
    if (result.outcome === 'preserved') {
      expect(result.patchPath).toBe('/patch/target.patch');
      expect(result.patchBytes).toBe(Buffer.byteLength('diff content here', 'utf8'));
    }
  });
});

describe('WorkspaceAdapter resetWorktreeToHead (Findings 3 & 5)', () => {
  it('queries untracked and ignored paths without --exclude-standard and refuses on obstruction', async () => {
    const executedGitArgs: string[][] = [];
    const executor: CommandExecutorPort = {
      run: vi.fn().mockImplementation(async (argv: readonly string[]) => {
        if (argv[0] === 'git') {
          const gitArgs = argv.slice(3); // skip git, -C, worktreePath
          executedGitArgs.push(gitArgs);
          const subcmd = gitArgs.join(' ');
          if (subcmd === 'rev-parse HEAD') {
            return { exitCode: 0, stdout: '0123456789abcdef0123456789abcdef01234567\n', stderr: '' };
          }
          if (subcmd.startsWith('ls-tree')) {
            return { exitCode: 0, stdout: 'tracked.txt\n', stderr: '' };
          }
          if (subcmd === 'ls-files --cached') {
            return { exitCode: 0, stdout: 'staged_dir/file.txt\n', stderr: '' };
          }
          if (subcmd === 'ls-files --others') {
            return { exitCode: 0, stdout: 'unrelated.txt\n', stderr: '' };
          }
          if (subcmd === 'ls-files --others --directory') {
            // Ignored directory obstructing staged addition!
            return { exitCode: 0, stdout: 'staged_dir/\n', stderr: '' };
          }
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    };

    const adapter = new WorkspaceAdapter({ executor });
    const result = await adapter.resetWorktreeToHead({
      worktreePath: '/var/lane/wt',
    });

    // Proves --exclude-standard is NOT used
    const lsFilesCalls = executedGitArgs.filter((args) => args[0] === 'ls-files' && args.includes('--others'));
    expect(lsFilesCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of lsFilesCalls) {
      expect(call).not.toContain('--exclude-standard');
    }

    // Refused because staged_dir obstructs staged addition
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toBe('untracked-obstructs');
    }

    // Proves git reset --hard was never run
    const resetCalled = executedGitArgs.some((args) => args.includes('reset'));
    expect(resetCalled).toBe(false);
  });

  it('resets to head when untracked files do not obstruct', async () => {
    const executedGitArgs: string[][] = [];
    const executor: CommandExecutorPort = {
      run: vi.fn().mockImplementation(async (argv: readonly string[]) => {
        if (argv[0] === 'git') {
          const gitArgs = argv.slice(3);
          executedGitArgs.push(gitArgs);
          const subcmd = gitArgs.join(' ');
          if (subcmd === 'rev-parse HEAD') {
            return { exitCode: 0, stdout: '0123456789abcdef0123456789abcdef01234567\n', stderr: '' };
          }
          if (subcmd.startsWith('ls-tree')) {
            return { exitCode: 0, stdout: 'src/main.ts\n', stderr: '' };
          }
          if (subcmd === 'ls-files --cached') {
            return { exitCode: 0, stdout: 'src/main.ts\n', stderr: '' };
          }
          if (subcmd === 'ls-files --others') {
            return { exitCode: 0, stdout: 'unrelated.txt\n', stderr: '' };
          }
          if (subcmd === 'ls-files --others --directory') {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (subcmd === 'reset --hard') {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    };

    const adapter = new WorkspaceAdapter({ executor });
    const result = await adapter.resetWorktreeToHead({
      worktreePath: '/var/lane/wt',
    });

    expect(result.outcome).toBe('reset');
    if (result.outcome === 'reset') {
      expect(result.headCommit).toBe('0123456789abcdef0123456789abcdef01234567');
    }
    expect(executedGitArgs.some((args) => args.includes('reset'))).toBe(true);
  });
});
