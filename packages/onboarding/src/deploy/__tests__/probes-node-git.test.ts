/**
 * The node git deploy probes against an injected executor and against a
 * real repository. Every test asserts the exact argv and options the
 * probes run, that each refusal rejects, and that no variable inherited
 * from the process environment reaches git.
 */

import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createNodeDeployGitProbes,
  GIT_BINARY_CANDIDATES,
  type DeployGitExec,
} from '../probes-node-git.js';

const TEST_GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
} as const;

const realGit = GIT_BINARY_CANDIDATES.find((c) => existsSync(c));

function makeTempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'deploy-git-')));
}

function makeRepo(dir: string, options: { commit: boolean; message?: string }): string {
  const run = (args: readonly string[]): void => {
    execFileSync(realGit as string, [...args], {
      cwd: dir,
      env: TEST_GIT_ENV,
      stdio: 'pipe',
    } satisfies ExecFileSyncOptions);
  };
  run(['init', '-q', '.']);
  if (!options.commit) {
    return '';
  }
  run([
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.invalid',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    options.message ?? 'one',
  ]);
  return execFileSync(realGit as string, ['rev-parse', 'HEAD'], {
    cwd: dir,
    env: TEST_GIT_ENV,
    stdio: 'pipe',
  } satisfies ExecFileSyncOptions)
    .toString('utf8')
    .trim();
}

describe('node git deploy probes', () => {
  let dir: string;

  afterEach(() => {
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
  });

  describe('with an injected executor', () => {
    let root: string;
    let fakeGit: string;
    let exec: ReturnType<typeof vi.fn<DeployGitExec>>;

    afterEach(() => {
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    const start = (): void => {
      dir = makeTempDir();
      root = dir;
      fakeGit = join(dir, 'fake-git');
      writeFileSync(fakeGit, '', { mode: 0o755 });
      exec = vi.fn<DeployGitExec>();
    };

    const probes = (): ReturnType<typeof createNodeDeployGitProbes> =>
      createNodeDeployGitProbes({
        execFile: exec,
        gitBinaryCandidates: [fakeGit],
      });

    it('headCommit runs the resolved binary with the exact argv and options', async () => {
      start();
      vi.stubEnv('GIT_DIR', '/nowhere');
      vi.stubEnv('GH_TOKEN', 'planted');
      exec.mockResolvedValue({ stdout: 'a'.repeat(40) + '\n' });
      const id = await probes().headCommit(root);
      expect(exec.mock.calls).toEqual([
        [
          fakeGit,
          ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'rev-parse', '--verify', 'HEAD^{commit}'],
          {
            cwd: root,
            env: {
              GIT_CONFIG_NOSYSTEM: '1',
              GIT_CONFIG_GLOBAL: '/dev/null',
              GIT_TERMINAL_PROMPT: '0',
              GIT_OPTIONAL_LOCKS: '0',
              GIT_CEILING_DIRECTORIES: dirname(root),
              LC_ALL: 'C',
            },
            timeout: 10000,
            maxBuffer: 65536,
            windowsHide: true,
            encoding: 'utf8',
          },
        ],
      ]);
      expect(id).toBe('a'.repeat(40));
    });

    it('mergeInProgress runs one rev-parse naming the five markers in order', async () => {
      start();
      exec.mockResolvedValue({ stdout: 'no/a\nno/b\nno/c\nno/d\nno/e\n' });
      const result = await probes().mergeInProgress(root);
      expect(exec.mock.calls).toHaveLength(1);
      expect(exec.mock.calls[0][1]).toEqual([
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        'rev-parse',
        '--git-path',
        'MERGE_HEAD',
        '--git-path',
        'CHERRY_PICK_HEAD',
        '--git-path',
        'REVERT_HEAD',
        '--git-path',
        'rebase-merge',
        '--git-path',
        'rebase-apply',
      ]);
      expect(result).toBe(false);
    });

    it('a custom timeoutMs reaches the git call', async () => {
      start();
      exec.mockResolvedValue({ stdout: 'a'.repeat(40) + '\n' });
      const custom = createNodeDeployGitProbes({
        execFile: exec,
        gitBinaryCandidates: [fakeGit],
        timeoutMs: 1234,
      });
      await custom.headCommit(root);
      expect(exec.mock.calls[0][2].timeout).toBe(1234);
    });

    it.each([
      'HEAD\n',
      '',
      'a'.repeat(39) + '\n',
      'A'.repeat(40) + '\n',
      'a'.repeat(40) + '\n' + 'b'.repeat(40) + '\n',
    ])('headCommit rejects output that is not a lower-case 40 to 64 hex id', async (stdout) => {
      start();
      exec.mockResolvedValue({ stdout });
      await expect(probes().headCommit(root)).rejects.toThrow(
        'deploy probe: git printed no commit id',
      );
    });

    it.each([
      'no/a\nno/b\nno/c\nno/d\n',
      'no/a\nno/b\nno/c\nno/d\nno/e\nno/f\n',
      'no/a\nno/b\nno/c\nno/d\nno/e',
      'no/a\n\nno/c\nno/d\nno/e\n',
    ])('mergeInProgress rejects when git prints fewer or more than five paths', async (stdout) => {
      start();
      exec.mockResolvedValue({ stdout });
      await expect(probes().mergeInProgress(root)).rejects.toThrow(
        'deploy probe: git printed unexpected marker paths',
      );
    });

    it('mergeInProgress rejects when a marker cannot be examined', async () => {
      start();
      writeFileSync(join(root, 'blocker'), 'x');
      exec.mockResolvedValue({ stdout: 'blocker/x\nno/b\nno/c\nno/d\nno/e\n' });
      await expect(probes().mergeInProgress(root)).rejects.toMatchObject({ code: 'ENOTDIR' });
    });

    it('a failed git call rejects with a fixed message that names no path', async () => {
      start();
      const cause = new Error('Command failed: /secret/path');
      exec.mockRejectedValue(cause);
      const headError = await probes().headCommit(root).catch((error: unknown) => error);
      expect((headError as Error).message).toBe('deploy probe: git command failed');
      expect((headError as Error).message).not.toContain('/secret/path');
      expect((headError as { cause?: unknown }).cause).toBe(cause);
      exec.mockRejectedValue(cause);
      const mergeError = await probes().mergeInProgress(root).catch((error: unknown) => error);
      expect((mergeError as Error).message).toBe('deploy probe: git command failed');
      expect((mergeError as { cause?: unknown }).cause).toBe(cause);
    });

    it('rejects a relative, a non-normalised and a NUL repository path before any call', async () => {
      start();
      exec.mockResolvedValue({ stdout: '' });
      const bad = ['repo', dir + '/', dir + '/../x', dir + '\0'];
      for (const repoPath of bad) {
        await expect(probes().headCommit(repoPath)).rejects.toThrow(
          'deploy probe: invalid repository path',
        );
        await expect(probes().mergeInProgress(repoPath)).rejects.toThrow(
          'deploy probe: invalid repository path',
        );
      }
      expect(exec).not.toHaveBeenCalled();
    });

    it('rejects when no candidate is an executable regular file', async () => {
      dir = makeTempDir();
      writeFileSync(join(dir, 'plain'), '', { mode: 0o644 });
      const factory = () =>
        createNodeDeployGitProbes({
          execFile: exec,
          gitBinaryCandidates: [join(dir, 'missing'), dir, join(dir, 'plain')],
        });
      const subject = factory();
      await expect(subject.headCommit(dir)).rejects.toThrow('deploy probe: no git binary');
      await expect(subject.mergeInProgress(dir)).rejects.toThrow('deploy probe: no git binary');
      expect(exec).not.toHaveBeenCalled();
    });

    it('rejects a repository path that does not exist', async () => {
      start();
      const missing = join(dir, 'missing');
      await expect(probes().headCommit(missing)).rejects.toThrow();
      await expect(probes().mergeInProgress(missing)).rejects.toThrow();
      expect(exec).not.toHaveBeenCalled();
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
      'createNodeDeployGitProbes throws on a timeout that is not a positive finite number',
      (timeoutMs) => {
        expect(() => createNodeDeployGitProbes({ timeoutMs })).toThrow(
          'deploy probe: invalid git timeout',
        );
      },
    );
  });

  describe.skipIf(realGit === undefined)('with a real git repository', () => {
    let dir: string;
    let other: string;

    afterEach(() => {
      for (const path of [dir, other]) {
        if (path !== undefined) {
          rmSync(path, { recursive: true, force: true });
        }
      }
      vi.unstubAllEnvs();
    });

    const fresh = (): string => {
      dir = makeTempDir();
      return dir;
    };

    it('headCommit returns the commit just made', () => {
      const dir = fresh();
      const id = makeRepo(dir, { commit: true });
      return expect(createNodeDeployGitProbes().headCommit(dir)).resolves.toBe(id);
    });

    it('headCommit rejects in a repository with no commit', () => {
      const dir = fresh();
      makeRepo(dir, { commit: false });
      return expect(createNodeDeployGitProbes().headCommit(dir)).rejects.toThrow(
        'deploy probe: git command failed',
      );
    });

    it('headCommit rejects in a directory that is not a repository', () => {
      const dir = fresh();
      return expect(createNodeDeployGitProbes().headCommit(dir)).rejects.toThrow(
        'deploy probe: git command failed',
      );
    });

    it('headCommit rejects in a subdirectory of a repository', async () => {
      const dir = fresh();
      makeRepo(dir, { commit: true });
      mkdirSync(join(dir, 'sub'));
      await expect(createNodeDeployGitProbes().headCommit(join(dir, 'sub'))).rejects.toThrow(
        'deploy probe: git command failed',
      );
    });

    it('mergeInProgress is false in a clean repository', () => {
      const dir = fresh();
      makeRepo(dir, { commit: true });
      return expect(createNodeDeployGitProbes().mergeInProgress(dir)).resolves.toBe(false);
    });

    it.each(['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'] as const)(
      'mergeInProgress is true when %s exists',
      (marker) => {
        const dir = fresh();
        makeRepo(dir, { commit: true });
        if (marker === 'rebase-merge' || marker === 'rebase-apply') {
          mkdirSync(join(dir, '.git', marker));
        } else {
          writeFileSync(join(dir, '.git', marker), 'x');
        }
        return expect(createNodeDeployGitProbes().mergeInProgress(dir)).resolves.toBe(true);
      },
    );

    it('mergeInProgress rejects in a directory that is not a repository', () => {
      const dir = fresh();
      return expect(createNodeDeployGitProbes().mergeInProgress(dir)).rejects.toThrow(
        'deploy probe: git command failed',
      );
    });

    it('headCommit ignores a GIT_DIR inherited from the process environment', () => {
      dir = makeTempDir();
      other = makeTempDir();
      const id = makeRepo(dir, { commit: true });
      makeRepo(other, { commit: true, message: 'two' });
      vi.stubEnv('GIT_DIR', join(other, '.git'));
      return expect(createNodeDeployGitProbes().headCommit(dir)).resolves.toBe(id);
    });

    it('a git call that exceeds the timeout rejects', async () => {
      const dir = fresh();
      makeRepo(dir, { commit: true });
      writeFileSync(join(dir, 'slow-git'), '#!/bin/sh\nexec /bin/sleep 5\n', { mode: 0o755 });
      const probes = createNodeDeployGitProbes({
        gitBinaryCandidates: [join(dir, 'slow-git')],
        timeoutMs: 200,
      });
      await expect(probes.headCommit(dir)).rejects.toThrow('deploy probe: git command failed');
    }, 4000);
  });
});
