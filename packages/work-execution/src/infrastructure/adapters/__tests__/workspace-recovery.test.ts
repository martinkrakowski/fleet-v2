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
});
