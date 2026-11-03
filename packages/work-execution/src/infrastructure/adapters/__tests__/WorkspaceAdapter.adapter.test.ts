import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  WorkspaceAdapter,
  resetWouldDestroyUntracked,
  topLevelTrackedPathspecs,
} from '../WorkspaceAdapter.adapter.js';
import type { CommandExecutorPort, CommandRunResult } from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import { LocalExecutor } from '../LocalExecutor.adapter.js';

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
      if (cmd.includes('diff') && cmd.includes('--binary') && cmd.includes('HEAD')) {
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
    expect(
      executedCommands.some(
        (c) =>
          c.includes('--no-ext-diff') &&
          c.includes('--no-textconv') &&
          c.includes('--no-color') &&
          c.includes('core.fsmonitor=false') &&
          c.includes('diff.noprefix=false'),
      ),
    ).toBe(true);
  });

  it('refuses git-refused when apply --check -R fails to verify patchPath contents', async () => {
    const executor = makeExecutor(async (argv) => {
      const cmd = argv.join(' ');
      if (cmd.includes('test -e /patch/target.patch') || cmd.includes('test -L /patch/target.patch')) {
        return { exitCode: 1, stdout: '', stderr: '' };
      }
      if (cmd.includes('diff') && cmd.includes('--binary') && cmd.includes('HEAD')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmd.includes('test -s /patch/.fleet-patch.123456')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmd.includes('mktemp')) {
        return { exitCode: 0, stdout: '/patch/.fleet-patch.123456\n', stderr: '' };
      }
      if (cmd.includes('mv -n /patch/.fleet-patch.123456 /patch/target.patch')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmd.includes('test -e /patch/.fleet-patch.123456')) {
        // temp file no longer exists: move succeeded
        return { exitCode: 1, stdout: '', stderr: '' };
      }
      if (cmd.includes('apply --check -R /patch/target.patch')) {
        // apply --check -R verification failed
        return { exitCode: 1, stdout: '', stderr: 'error: patch does not apply' };
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
      if (cmd.includes('diff') && cmd.includes('--binary') && cmd.includes('HEAD')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmd.includes('test -s /patch/.fleet-patch.123456')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmd.includes('mktemp')) {
        return { exitCode: 0, stdout: '/patch/.fleet-patch.123456\n', stderr: '' };
      }
      if (cmd.includes('mv -n /patch/.fleet-patch.123456 /patch/target.patch')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmd.includes('test -e /patch/.fleet-patch.123456')) {
        // temp file no longer exists: move succeeded
        return { exitCode: 1, stdout: '', stderr: '' };
      }
      if (cmd.includes('apply --check -R /patch/target.patch')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmd.includes('wc -c /patch/target.patch')) {
        return { exitCode: 0, stdout: '17 /patch/target.patch\n', stderr: '' };
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
      expect(result.patchBytes).toBe(17);
    }
  });
});

describe('WorkspaceAdapter verifySavedPatch', () => {
  it('returns true when git apply --check -R succeeds', async () => {
    const executor: CommandExecutorPort = {
      run: vi.fn().mockImplementation(async (argv: readonly string[]) => {
        if (argv[0] === 'git' && argv.includes('apply') && argv.includes('--check') && argv.includes('-R')) {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    };

    const adapter = new WorkspaceAdapter({ executor });
    const result = await adapter.verifySavedPatch({
      worktreePath: '/var/lane/wt',
      patchPath: '/patch/target.patch',
    });
    expect(result).toBe(true);
  });

  it('returns false when git apply --check -R fails', async () => {
    const executor: CommandExecutorPort = {
      run: vi.fn().mockImplementation(async (argv: readonly string[]) => {
        if (argv[0] === 'git' && argv.includes('apply')) {
          return { exitCode: 1, stdout: '', stderr: 'error: patch failed' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    };

    const adapter = new WorkspaceAdapter({ executor });
    const result = await adapter.verifySavedPatch({
      worktreePath: '/var/lane/wt',
      patchPath: '/patch/target.patch',
    });
    expect(result).toBe(false);
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
          const cmd = argv.join(' ');
          if (cmd.includes('rev-parse HEAD')) {
            return { exitCode: 0, stdout: '0123456789abcdef0123456789abcdef01234567\n', stderr: '' };
          }
          if (cmd.includes('ls-tree')) {
            return { exitCode: 0, stdout: 'tracked.txt\0', stderr: '' };
          }
          if (cmd.includes('ls-files') && cmd.includes('--cached')) {
            return { exitCode: 0, stdout: 'staged_dir/file.txt\0', stderr: '' };
          }
          if (cmd.includes('ls-files') && cmd.includes('--others') && cmd.includes('--directory')) {
            // Ignored directory obstructing staged addition!
            return { exitCode: 0, stdout: 'staged_dir/\0', stderr: '' };
          }
          if (cmd.includes('ls-files') && cmd.includes('--others')) {
            return { exitCode: 0, stdout: 'unrelated.txt\0', stderr: '' };
          }
          if (cmd.includes('config') && cmd.includes('filter')) {
            return { exitCode: 1, stdout: '', stderr: '' };
          }
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    };

    const adapter = new WorkspaceAdapter({ executor });
    const result = await adapter.resetWorktreeToHead({
      worktreePath: '/var/lane/wt',
    });

    // Proves --exclude-standard is NOT used and -z is used
    const lsFilesCalls = executedGitArgs.filter((args) => args.includes('ls-files') && args.includes('--others'));
    expect(lsFilesCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of lsFilesCalls) {
      expect(call).not.toContain('--exclude-standard');
      expect(call).toContain('-z');
      expect(call).toContain('core.fsmonitor=false');
      expect(call).toContain('diff.noprefix=false');
    }

    // Proves pathspecs are passed to the full listing
    const fullLsFilesCall = lsFilesCalls.find((args) => !args.includes('--directory'));
    expect(fullLsFilesCall).toBeDefined();
    expect(fullLsFilesCall).toContain(':(literal)staged_dir');
    expect(fullLsFilesCall).toContain(':(literal)tracked.txt');

    // Refused because staged_dir obstructs staged addition
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toBe('untracked-obstructs');
    }

    // Proves git reset --hard was never run
    const resetCalled = executedGitArgs.some((args) => args.includes('reset') && args.includes('--hard'));
    expect(resetCalled).toBe(false);
  });

  it('resets to head when untracked files do not obstruct', async () => {
    const executedGitArgs: string[][] = [];
    const executor: CommandExecutorPort = {
      run: vi.fn().mockImplementation(async (argv: readonly string[]) => {
        if (argv[0] === 'git') {
          const gitArgs = argv.slice(3);
          executedGitArgs.push(gitArgs);
          const cmd = argv.join(' ');
          if (cmd.includes('rev-parse HEAD')) {
            return { exitCode: 0, stdout: '0123456789abcdef0123456789abcdef01234567\n', stderr: '' };
          }
          if (cmd.includes('ls-tree')) {
            return { exitCode: 0, stdout: 'src/main.ts\0', stderr: '' };
          }
          if (cmd.includes('ls-files') && cmd.includes('--cached')) {
            return { exitCode: 0, stdout: 'src/main.ts\0', stderr: '' };
          }
          if (cmd.includes('ls-files') && cmd.includes('--others') && cmd.includes('--directory')) {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (cmd.includes('ls-files') && cmd.includes('--others')) {
            return { exitCode: 0, stdout: 'unrelated.txt\0', stderr: '' };
          }
          if (cmd.includes('reset') && cmd.includes('--hard')) {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (cmd.includes('config') && cmd.includes('filter')) {
            return { exitCode: 1, stdout: '', stderr: '' };
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
    expect(executedGitArgs.some((args) => args.includes('reset') && args.includes('--hard'))).toBe(true);
  });
});

describe('topLevelTrackedPathspecs (GB3)', () => {
  it('extracts unique top-level directories and root files with literal prefix', () => {
    const tracked = [
      'src/components/Button.tsx',
      'src/index.ts',
      'packages/pkg-a/src/main.ts',
      'package.json',
      'README.md',
      '',
    ];
    const pathspecs = topLevelTrackedPathspecs(tracked);
    expect(pathspecs).toEqual([
      ':(literal)package.json',
      ':(literal)packages',
      ':(literal)README.md',
      ':(literal)src',
    ]);
  });

  it('returns empty array when tracked paths are empty', () => {
    expect(topLevelTrackedPathspecs([])).toEqual([]);
    expect(topLevelTrackedPathspecs([''])).toEqual([]);
  });
});

describe('WorkspaceAdapter filter driver neutralization (GB3)', () => {
  it('neutralizes custom filter drivers configured in git config on reset --hard', async () => {
    const executedGitArgs: string[][] = [];
    const executor: CommandExecutorPort = {
      run: vi.fn().mockImplementation(async (argv: readonly string[]) => {
        const cmd = argv.join(' ');
        if (argv[0] === 'git') {
          executedGitArgs.push(argv.slice(3));
          if (cmd.includes('rev-parse HEAD')) {
            return { exitCode: 0, stdout: 'abcdef0123456789abcdef0123456789abcdef01\n', stderr: '' };
          }
          if (cmd.includes('ls-tree') || (cmd.includes('ls-files') && cmd.includes('--cached'))) {
            return { exitCode: 0, stdout: 'file.txt\0', stderr: '' };
          }
          if (cmd.includes('ls-files') && cmd.includes('--others')) {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (cmd.includes('config') && cmd.includes('filter')) {
            return {
              exitCode: 0,
              stdout: 'filter.custom_driver.clean\0filter.custom_driver.smudge\0filter.other.process\0',
              stderr: '',
            };
          }
          if (cmd.includes('reset') && cmd.includes('--hard')) {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    };

    const adapter = new WorkspaceAdapter({ executor });
    const result = await adapter.resetWorktreeToHead({ worktreePath: '/var/lane/wt' });
    expect(result.outcome).toBe('reset');

    const resetCall = executedGitArgs.find((args) => args.includes('reset') && args.includes('--hard'));
    expect(resetCall).toBeDefined();
    expect(resetCall).toContain('filter.custom_driver.clean=');
    expect(resetCall).toContain('filter.custom_driver.smudge=');
    expect(resetCall).toContain('filter.other.process=');
    expect(resetCall).toContain('filter.lfs.clean=');
  });

  it('refuses reset when filter driver name in git config contains unsafe characters', async () => {
    const executor: CommandExecutorPort = {
      run: vi.fn().mockImplementation(async (argv: readonly string[]) => {
        const cmd = argv.join(' ');
        if (argv[0] === 'git') {
          if (cmd.includes('rev-parse HEAD')) {
            return { exitCode: 0, stdout: 'abcdef0123456789abcdef0123456789abcdef01\n', stderr: '' };
          }
          if (cmd.includes('ls-tree') || (cmd.includes('ls-files') && cmd.includes('--cached'))) {
            return { exitCode: 0, stdout: 'file.txt\0', stderr: '' };
          }
          if (cmd.includes('ls-files') && cmd.includes('--others')) {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (cmd.includes('config') && cmd.includes('filter')) {
            return { exitCode: 0, stdout: 'filter.bad name;rm -rf.clean\0', stderr: '' };
          }
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    };

    const adapter = new WorkspaceAdapter({ executor });
    const result = await adapter.resetWorktreeToHead({ worktreePath: '/var/lane/wt' });
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toBe('git-refused');
    }
  });
});

describe('WorkspaceAdapter real-git tests (GB3)', () => {
  it('does not list many untracked files in an ignored directory that holds no tracked path in the full listing', async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fleet-real-git-large-'));
    try {
      const realExecutor = new LocalExecutor();
      await realExecutor.run(['git', 'init', '-q', tempDir]);
      await realExecutor.run(['git', '-C', tempDir, 'config', 'user.email', 'lane@example.invalid']);
      await realExecutor.run(['git', '-C', tempDir, 'config', 'user.name', 'Lane']);

      await fs.promises.writeFile(path.join(tempDir, '.gitignore'), 'node_modules/\n');
      await fs.promises.mkdir(path.join(tempDir, 'src'), { recursive: true });
      await fs.promises.writeFile(path.join(tempDir, 'src', 'main.ts'), 'export const x = 1;\n');
      await realExecutor.run(['git', '-C', tempDir, 'add', '.']);
      await realExecutor.run([
        'git',
        '-C',
        tempDir,
        '-c',
        'commit.gpgSign=false',
        'commit',
        '-q',
        '-m',
        'initial commit',
      ]);

      // Create ignored node_modules directory with many untracked files
      const nodeModulesPkg = path.join(tempDir, 'node_modules', 'dep-pkg');
      await fs.promises.mkdir(nodeModulesPkg, { recursive: true });
      for (let i = 0; i < 60; i += 1) {
        await fs.promises.writeFile(path.join(nodeModulesPkg, `index-${i}.js`), `module.exports = ${i};\n`);
      }

      const fullListingStdoutList: string[] = [];
      const executedCommands: string[][] = [];
      const recordingExecutor: CommandExecutorPort = {
        run: async (argv, options) => {
          executedCommands.push([...argv]);
          const outcome = await realExecutor.run(argv, options);
          if (argv.includes('ls-files') && argv.includes('--others') && !argv.includes('--directory')) {
            fullListingStdoutList.push(outcome.stdout);
          }
          return outcome;
        },
      };

      const adapter = new WorkspaceAdapter({ executor: recordingExecutor });
      const result = await adapter.resetWorktreeToHead({ worktreePath: tempDir });

      expect(result.outcome).toBe('reset');
      expect(fullListingStdoutList.length).toBe(2);
      for (const listing of fullListingStdoutList) {
        expect(listing).not.toContain('node_modules');
      }

      // Verify the full listing calls were scoped to top-level tracked paths
      const fullCalls = executedCommands.filter(
        (cmd) => cmd.includes('ls-files') && cmd.includes('--others') && !cmd.includes('--directory'),
      );
      expect(fullCalls.length).toBe(2);
      for (const call of fullCalls) {
        expect(call).toContain(':(literal).gitignore');
        expect(call).toContain(':(literal)src');
        expect(call).not.toContain(':(literal)node_modules');
      }

      // Verify untracked node_modules files survived the reset
      const stat0 = await fs.promises.stat(path.join(nodeModulesPkg, 'index-0.js'));
      expect(stat0.isFile()).toBe(true);
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('with diff.noprefix=true set in the repo, the saved patch still applies and restores the exact bytes', async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fleet-real-git-prefix-'));
    const patchDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fleet-patch-'));
    const patchPath = path.join(patchDir, 'saved.patch');
    try {
      const realExecutor = new LocalExecutor();
      await realExecutor.run(['git', 'init', '-q', tempDir]);
      await realExecutor.run(['git', '-C', tempDir, 'config', 'user.email', 'lane@example.invalid']);
      await realExecutor.run(['git', '-C', tempDir, 'config', 'user.name', 'Lane']);

      // Worktree config has diff.noprefix=true
      await realExecutor.run(['git', '-C', tempDir, 'config', 'diff.noprefix', 'true']);

      const testFile = path.join(tempDir, 'tracked.txt');
      const initialBytes = 'hello world\nline 2\nline 3\n';
      await fs.promises.writeFile(testFile, initialBytes);
      await realExecutor.run(['git', '-C', tempDir, 'add', 'tracked.txt']);
      await realExecutor.run([
        'git',
        '-C',
        tempDir,
        '-c',
        'commit.gpgSign=false',
        'commit',
        '-q',
        '-m',
        'initial',
      ]);

      const modifiedBytes = 'hello world\nline 2 modified\nline 3\nextra line 4\n';
      await fs.promises.writeFile(testFile, modifiedBytes);

      const adapter = new WorkspaceAdapter({ executor: realExecutor });
      const preserveResult = await adapter.preserveWorktreeEdits({
        worktreePath: tempDir,
        patchPath,
      });

      expect(preserveResult.outcome).toBe('preserved');
      if (preserveResult.outcome === 'preserved') {
        expect(preserveResult.patchBytes).toBeGreaterThan(0);
      }

      // Verify the patch still applies against the worktree
      const verified = await adapter.verifySavedPatch({
        worktreePath: tempDir,
        patchPath,
      });
      expect(verified).toBe(true);

      // Verify the saved patch has standard a/ and b/ prefixes despite diff.noprefix=true
      const patchContent = await fs.promises.readFile(patchPath, 'utf8');
      expect(patchContent).toContain('--- a/tracked.txt');
      expect(patchContent).toContain('+++ b/tracked.txt');

      // Reset the worktree to HEAD
      const resetResult = await adapter.resetWorktreeToHead({ worktreePath: tempDir });
      expect(resetResult.outcome).toBe('reset');

      // Verify file is back to initial state
      const afterResetBytes = await fs.promises.readFile(testFile, 'utf8');
      expect(afterResetBytes).toBe(initialBytes);

      // Apply the saved patch
      const applyResult = await realExecutor.run(['git', '-C', tempDir, 'apply', patchPath]);
      expect(applyResult.exitCode).toBe(0);

      // Verify exact bytes are restored
      const restoredBytes = await fs.promises.readFile(testFile, 'utf8');
      expect(restoredBytes).toBe(modifiedBytes);
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
      await fs.promises.rm(patchDir, { recursive: true, force: true });
    }
  });
});
