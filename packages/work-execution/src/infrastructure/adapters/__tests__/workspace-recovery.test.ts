/**
 * GB3 adapter tests for the WorkspaceAdapter recovery methods, against real
 * files and real git output (no stubs): preserveWorktreeEdits writes a patch
 * outside the worktree, refuses inside-worktree / traversal / symlink-alias /
 * existing destinations before any git command, and resetWorktreeToHead
 * restores tracked edits while leaving untracked paths untouched, refusing
 * when restoring a tracked path would destroy an untracked one.
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
} from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import { WorkspaceAdapter } from '../WorkspaceAdapter.adapter.js';
import { LocalExecutor } from '../LocalExecutor.adapter.js';

const execFileAsync = promisify(execFile);

const createdDirs = new Set<string>();

afterAll(async () => {
  await Promise.all(
    [...createdDirs].map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function makeTempDir(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  createdDirs.add(directory);
  return directory;
}

async function git(repoPath: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-c', 'user.name=Fleet Test', '-c', 'user.email=fleet-test@example.invalid', ...args],
    { cwd: repoPath },
  );
  return stdout;
}

/** Real temporary Git repository with a tracked README.md. */
async function createGitRepo(): Promise<string> {
  const repoPath = await makeTempDir('fleet-repo-');
  await git(repoPath, ['init']);
  await fs.writeFile(path.join(repoPath, 'README.md'), '# fleet test\n', 'utf8');
  await git(repoPath, ['add', '.']);
  await git(repoPath, ['commit', '-m', 'initial commit']);
  return repoPath;
}

/** An executor that records every argv array it runs, delegating to a real executor. */
class RecordingExecutor implements CommandExecutorPort {
  readonly commands: string[][] = [];

  constructor(private readonly inner: CommandExecutorPort) {}

  async run(argv: readonly string[], options?: CommandRunOptions): Promise<CommandRunResult> {
    this.commands.push([...argv]);
    return this.inner.run(argv, options);
  }
}

function gitCommands(recording: RecordingExecutor): string[][] {
  return recording.commands.filter((argv) => argv[0] === 'git');
}

describe('WorkspaceAdapter GB3 recovery', () => {
  it('preserve writes a patch outside the worktree and reset restores the head, keeping untracked files', { timeout: 20000 }, async () => {
    const repoPath = await createGitRepo();
    const head = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
    const patchesDir = await makeTempDir('fleet-patches-');
    const patchPath = path.join(patchesDir, 'preserved.patch');
    await fs.writeFile(path.join(repoPath, 'README.md'), '# changed\n', 'utf8');
    await fs.writeFile(path.join(repoPath, 'scratch.txt'), 'scratch\n', 'utf8');

    const adapter = new WorkspaceAdapter({ executor: new LocalExecutor() });
    const preserved = await adapter.preserveWorktreeEdits({ worktreePath: repoPath, patchPath });
    expect(preserved.outcome).toBe('preserved');
    if (preserved.outcome !== 'preserved') return;
    expect(preserved.patchPath).toBe(patchPath);
    expect(preserved.patchBytes).toBeGreaterThan(0);
    const content = await fs.readFile(patchPath, 'utf8');
    expect(content.startsWith('diff --git')).toBe(true);

    const reset = await adapter.resetWorktreeToHead({ worktreePath: repoPath });
    expect(reset.outcome).toBe('reset');
    if (reset.outcome !== 'reset') return;
    expect(reset.headCommit).toBe(head);
    expect((await git(repoPath, ['rev-parse', 'HEAD'])).trim()).toBe(head);
    const status = await git(repoPath, ['status', '--porcelain', '--untracked-files=all']);
    expect(status.trim()).toBe('?? scratch.txt');
  });

  it('preserve refuses a clean worktree with nothing-to-preserve and writes nothing', { timeout: 20000 }, async () => {
    const repoPath = await createGitRepo();
    const patchesDir = await makeTempDir('fleet-patches-');
    const patchPath = path.join(patchesDir, 'clean.patch');
    const adapter = new WorkspaceAdapter({ executor: new LocalExecutor() });
    const result = await adapter.preserveWorktreeEdits({ worktreePath: repoPath, patchPath });
    expect(result).toEqual({ outcome: 'refused', reason: 'nothing-to-preserve' });
    await expect(fs.access(patchPath)).rejects.toThrow();
  });

  it('preserve refuses a patch path inside the worktree before any git command runs', { timeout: 20000 }, async () => {
    const repoPath = await createGitRepo();
    const recording = new RecordingExecutor(new LocalExecutor());
    const adapter = new WorkspaceAdapter({ executor: recording });
    const inside = path.join(repoPath, 'inside.patch');
    const result = await adapter.preserveWorktreeEdits({ worktreePath: repoPath, patchPath: inside });
    expect(result).toEqual({ outcome: 'refused', reason: 'patch-path-inside-worktree' });
    expect(gitCommands(recording)).toEqual([]);
    await expect(fs.access(inside)).rejects.toThrow();
  });

  it('preserve refuses a traversal patch path that starts inside the worktree', { timeout: 20000 }, async () => {
    const repoPath = await createGitRepo();
    const recording = new RecordingExecutor(new LocalExecutor());
    const adapter = new WorkspaceAdapter({ executor: recording });
    // A raw `..`-shaped path whose textual form begins inside the worktree is
    // refused before any command, no matter where the `..` would resolve.
    const traversal = repoPath + '/sub/../../escape.patch';
    const result = await adapter.preserveWorktreeEdits({ worktreePath: repoPath, patchPath: traversal });
    expect(result).toEqual({ outcome: 'refused', reason: 'patch-path-inside-worktree' });
    expect(gitCommands(recording)).toEqual([]);
  });

  it('preserve refuses a patch path whose parent is a symlink alias into the worktree', { timeout: 20000 }, async () => {
    const root = await makeTempDir('fleet-symlink-');
    const repoPath = path.join(root, 'wt');
    await fs.mkdir(repoPath, { recursive: true });
    await git(repoPath, ['init']);
    await fs.writeFile(path.join(repoPath, 'README.md'), '# fleet test\n', 'utf8');
    await git(repoPath, ['add', '.']);
    await git(repoPath, ['commit', '-m', 'initial commit']);
    await fs.symlink(repoPath, path.join(root, 'alias'));

    const patchPath = path.join(root, 'alias', 'inside.patch');
    const recording = new RecordingExecutor(new LocalExecutor());
    const adapter = new WorkspaceAdapter({ executor: recording });
    const result = await adapter.preserveWorktreeEdits({ worktreePath: repoPath, patchPath });
    expect(result).toEqual({ outcome: 'refused', reason: 'patch-path-inside-worktree' });
    expect(gitCommands(recording)).toEqual([]);
    await expect(fs.access(patchPath)).rejects.toThrow();
  });

  it('preserve refuses an existing destination and never overwrites it', { timeout: 20000 }, async () => {
    const repoPath = await createGitRepo();
    const patchesDir = await makeTempDir('fleet-patches-');
    const patchPath = path.join(patchesDir, 'existing.patch');
    await fs.writeFile(patchPath, 'do not clobber\n', 'utf8');
    await fs.writeFile(path.join(repoPath, 'README.md'), '# changed\n', 'utf8');
    const recording = new RecordingExecutor(new LocalExecutor());
    const adapter = new WorkspaceAdapter({ executor: recording });
    const result = await adapter.preserveWorktreeEdits({ worktreePath: repoPath, patchPath });
    expect(result).toEqual({ outcome: 'refused', reason: 'destination-exists' });
    expect(gitCommands(recording)).toEqual([]);
    expect(await fs.readFile(patchPath, 'utf8')).toBe('do not clobber\n');
  });

  it('reset refuses when an untracked directory obstructs restoring a tracked path, leaving it untouched', { timeout: 20000 }, async () => {
    const repoPath = await createGitRepo();
    const head = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
    await fs.rm(path.join(repoPath, 'README.md'));
    await fs.mkdir(path.join(repoPath, 'README.md'));
    await fs.writeFile(path.join(repoPath, 'README.md', 'inside.txt'), 'untracked payload\n', 'utf8');

    const adapter = new WorkspaceAdapter({ executor: new LocalExecutor() });
    const result = await adapter.resetWorktreeToHead({ worktreePath: repoPath });
    expect(result).toEqual({ outcome: 'refused', reason: 'untracked-obstructs' });
    // The untracked directory and its content are untouched; the tracked path
    // was not restored.
    expect(await fs.readFile(path.join(repoPath, 'README.md', 'inside.txt'), 'utf8')).toBe('untracked payload\n');
    const stat = await fs.stat(path.join(repoPath, 'README.md'));
    expect(stat.isDirectory()).toBe(true);
    expect((await git(repoPath, ['rev-parse', 'HEAD'])).trim()).toBe(head);
    const status = await git(repoPath, ['status', '--porcelain', '--untracked-files=all']);
    expect(status).toContain('README.md');
    expect(status).toContain('?? README.md/inside.txt');
  });

  it('reset refuses when a staged addition sits at a path occupied by an untracked directory', { timeout: 20000 }, async () => {
    const repoPath = await createGitRepo();
    const head = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
    // A staged addition at P (in the index, absent from HEAD) whose worktree
    // path is now an untracked directory: only the index lists P, so a
    // HEAD-only obstruction check would miss the collision.
    await fs.writeFile(path.join(repoPath, 'P'), 'staged\n', 'utf8');
    await git(repoPath, ['add', 'P']);
    await fs.rm(path.join(repoPath, 'P'));
    await fs.mkdir(path.join(repoPath, 'P'));
    await fs.writeFile(path.join(repoPath, 'P', 'inner.txt'), 'untracked payload\n', 'utf8');

    const adapter = new WorkspaceAdapter({ executor: new LocalExecutor() });
    const result = await adapter.resetWorktreeToHead({ worktreePath: repoPath });
    expect(result).toEqual({ outcome: 'refused', reason: 'untracked-obstructs' });
    // Nothing was reset: the untracked directory and the staged addition are
    // both untouched.
    expect(await fs.readFile(path.join(repoPath, 'P', 'inner.txt'), 'utf8')).toBe('untracked payload\n');
    const status = await git(repoPath, ['status', '--porcelain', '--untracked-files=all']);
    expect(status).toContain('AD P');
    expect(status).toContain('?? P/inner.txt');
    expect((await git(repoPath, ['rev-parse', 'HEAD'])).trim()).toBe(head);
  });

  it('preserve refuses destination-exists when mv -n skips silently on existing destination', { timeout: 20000 }, async () => {
    const repoPath = await createGitRepo();
    const patchesDir = await makeTempDir('fleet-patches-');
    const patchPath = path.join(patchesDir, 'raced-skip.patch');
    await fs.writeFile(path.join(repoPath, 'README.md'), '# changed\n', 'utf8');
    await fs.writeFile(patchPath, 'existing destination\n', 'utf8');

    const inner = new LocalExecutor();
    const skippingExecutor: CommandExecutorPort = {
      run: async (argv, options) => {
        if (argv[0] === 'mv' && argv.includes('-n')) {
          // Simulate mv -n silently skipping when destination exists (exit 0 without moving)
          return { exitCode: 0, stdout: '', stderr: '', signal: null };
        }
        return inner.run(argv, options);
      },
    };
    const adapter = new WorkspaceAdapter({ executor: skippingExecutor });
    const result = await adapter.preserveWorktreeEdits({ worktreePath: repoPath, patchPath });
    // Proves the destination-exists branch is hit when temp file remains after mv -n
    expect(result).toEqual({ outcome: 'refused', reason: 'destination-exists' });
    expect(await fs.readFile(patchPath, 'utf8')).toBe('existing destination\n');
    const leftovers = (await fs.readdir(patchesDir)).filter((name) => name.startsWith('.fleet-patch.'));
    expect(leftovers).toEqual([]);
  });

  it('preserve refuses git-refused when mv -n fails on existing destination', { timeout: 20000 }, async () => {
    const repoPath = await createGitRepo();
    const patchesDir = await makeTempDir('fleet-patches-');
    const patchPath = path.join(patchesDir, 'raced-fail.patch');
    await fs.writeFile(path.join(repoPath, 'README.md'), '# changed\n', 'utf8');

    const inner = new LocalExecutor();
    const failingExecutor: CommandExecutorPort = {
      run: async (argv, options) => {
        if (argv[0] === 'mv' && argv.includes('-n')) {
          // Simulate coreutils mv -n failing with exit 1 on existing destination
          return { exitCode: 1, stdout: '', stderr: 'mv: will not overwrite', signal: null };
        }
        return inner.run(argv, options);
      },
    };
    const adapter = new WorkspaceAdapter({ executor: failingExecutor });
    const result = await adapter.preserveWorktreeEdits({ worktreePath: repoPath, patchPath });
    // Proves the git-refused branch is hit when mv -n reports a non-zero exit code
    expect(result).toEqual({ outcome: 'refused', reason: 'git-refused' });
    const leftovers = (await fs.readdir(patchesDir)).filter((name) => name.startsWith('.fleet-patch.'));
    expect(leftovers).toEqual([]);
  });

  it('preserve refuses and never clobbers destination when destination appears after existence checks', { timeout: 20000 }, async () => {
    const repoPath = await createGitRepo();
    const patchesDir = await makeTempDir('fleet-patches-');
    const patchPath = path.join(patchesDir, 'raced.patch');
    await fs.writeFile(path.join(repoPath, 'README.md'), '# changed\n', 'utf8');
    // A racing writer creates the destination between the existence checks and
    // the rename: it hooks the git diff call, which runs after the checks.
    const inner = new LocalExecutor();
    const racing: CommandExecutorPort = {
      run: async (argv, options) => {
        const result = await inner.run(argv, options);
        if (argv[0] === 'git' && argv.includes('diff')) {
          await fs.writeFile(patchPath, 'raced writer\n', 'utf8');
        }
        return result;
      },
    };
    const adapter = new WorkspaceAdapter({ executor: racing });
    const result = await adapter.preserveWorktreeEdits({ worktreePath: repoPath, patchPath });
    // Depending on coreutils version, mv -n either skips silently (destination-exists)
    // or fails with non-zero exit (git-refused). In both cases it must refuse and not clobber.
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(['destination-exists', 'git-refused']).toContain(result.reason);
    }
    expect(await fs.readFile(patchPath, 'utf8')).toBe('raced writer\n');
    // The leftover temp file is cleaned up; no other file appeared.
    const leftovers = (await fs.readdir(patchesDir)).filter((name) => name.startsWith('.fleet-patch.'));
    expect(leftovers).toEqual([]);
  });

  it('reset refuses when a non-ASCII directory obstructs restoring a tracked path, leaving it untouched', { timeout: 20000 }, async () => {
    const repoPath = await createGitRepo();
    // Track a file in a non-ASCII directory 'é/a.txt'
    await fs.mkdir(path.join(repoPath, 'é'), { recursive: true });
    await fs.writeFile(path.join(repoPath, 'é', 'a.txt'), 'tracked in é\n', 'utf8');
    await git(repoPath, ['add', 'é/a.txt']);
    await git(repoPath, ['commit', '-m', 'track é/a.txt']);
    const head = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();

    // In worktree: replace the tracked directory 'é' with an untracked file at the same path
    await fs.rm(path.join(repoPath, 'é'), { recursive: true });
    await fs.writeFile(path.join(repoPath, 'é'), 'non-ascii untracked payload\n', 'utf8');

    const adapter = new WorkspaceAdapter({ executor: new LocalExecutor() });
    const result = await adapter.resetWorktreeToHead({ worktreePath: repoPath });
    expect(result).toEqual({ outcome: 'refused', reason: 'untracked-obstructs' });

    // The non-ASCII directory and its untracked content survive; the tracked path was not restored
    expect(await fs.readFile(path.join(repoPath, 'é'), 'utf8')).toBe('non-ascii untracked payload\n');
    expect((await git(repoPath, ['rev-parse', 'HEAD'])).trim()).toBe(head);
  });

  it('preserve and reset handles Latin-1 edits byte-faithfully and restores exact bytes with git apply', { timeout: 20000 }, async () => {
    const repoPath = await createGitRepo();
    const patchesDir = await makeTempDir('fleet-patches-');
    const patchPath = path.join(patchesDir, 'latin1.patch');

    // Create a tracked file with Latin-1 bytes
    const initialBytes = Buffer.from('latin-1 initial: \xe9\xe8\xe0\n', 'latin1');
    await fs.writeFile(path.join(repoPath, 'latin1.txt'), initialBytes);
    await git(repoPath, ['add', 'latin1.txt']);
    await git(repoPath, ['commit', '-m', 'track latin1.txt']);
    const head = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();

    // Edit the tracked file with different Latin-1 bytes
    const editedBytes = Buffer.from('latin-1 edited: \xf1\xfc\xf6 \xff\xfe\n', 'latin1');
    await fs.writeFile(path.join(repoPath, 'latin1.txt'), editedBytes);

    const adapter = new WorkspaceAdapter({ executor: new LocalExecutor() });
    const preserved = await adapter.preserveWorktreeEdits({ worktreePath: repoPath, patchPath });
    expect(preserved.outcome).toBe('preserved');
    if (preserved.outcome !== 'preserved') return;
    expect(preserved.patchBytes).toBeGreaterThan(0);

    const reset = await adapter.resetWorktreeToHead({ worktreePath: repoPath });
    expect(reset.outcome).toBe('reset');
    if (reset.outcome !== 'reset') return;
    expect(reset.headCommit).toBe(head);

    // After reset, worktree has initial content
    const resetBytes = await fs.readFile(path.join(repoPath, 'latin1.txt'));
    expect(Buffer.compare(resetBytes, initialBytes)).toBe(0);

    // Applying the patch restores the exact edited Latin-1 bytes
    await git(repoPath, ['apply', patchPath]);
    const restoredBytes = await fs.readFile(path.join(repoPath, 'latin1.txt'));
    expect(Buffer.compare(restoredBytes, editedBytes)).toBe(0);
  });

  it('reset refuses when an ignored path obstructs a tracked path and ensures ignored content survives', { timeout: 20000 }, async () => {
    const repoPath = await createGitRepo();
    // Track a file under dist/ in HEAD
    await fs.mkdir(path.join(repoPath, 'dist'), { recursive: true });
    await fs.writeFile(path.join(repoPath, 'dist', 'bundle.js'), 'tracked bundle\n', 'utf8');
    await git(repoPath, ['add', 'dist/bundle.js']);
    await git(repoPath, ['commit', '-m', 'track dist/bundle.js']);
    const head = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();

    // Ignore dist/ in .gitignore
    await fs.writeFile(path.join(repoPath, '.gitignore'), 'dist\n', 'utf8');
    // Remove the tracked file from worktree and replace dist with an ignored directory containing untracked content
    await fs.rm(path.join(repoPath, 'dist'), { recursive: true });
    await fs.writeFile(path.join(repoPath, 'dist'), 'ignored build artifact\n', 'utf8');

    // Confirm that git status sees dist/ as ignored
    const status = await git(repoPath, ['status', '--porcelain', '--ignored']);
    expect(status).toContain('!! dist');

    const adapter = new WorkspaceAdapter({ executor: new LocalExecutor() });
    const result = await adapter.resetWorktreeToHead({ worktreePath: repoPath });
    expect(result).toEqual({ outcome: 'refused', reason: 'untracked-obstructs' });

    // The ignored content survives and was not destroyed by reset
    expect(await fs.readFile(path.join(repoPath, 'dist'), 'utf8')).toBe('ignored build artifact\n');
    expect((await git(repoPath, ['rev-parse', 'HEAD'])).trim()).toBe(head);
  });
});
