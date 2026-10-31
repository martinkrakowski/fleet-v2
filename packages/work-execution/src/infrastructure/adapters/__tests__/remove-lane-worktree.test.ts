// Adapter tests for WorkspaceAdapter.removeLaneWorktree (EX-2a): fake-executor
// tests script a recording CommandExecutorPort and assert the exact argv
// sequence, the guards and the refusals; a real-git describe proves the
// removal against actual git in a temporary repository.

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
import type { ExecutorForRecordedHostResult } from '../ExecutorForHost.helper.js';
import type { AttemptRunnerRecord } from '../../../domain/execution-records.js';
import type { RemoveLaneWorktreeRequest } from '../../../application/ports/out/WorkspacePort.out-port.js';
import { WorkspaceAdapter } from '../WorkspaceAdapter.adapter.js';
import { physicalPathArgv } from '../ResolvePhysicalPath.helper.js';
import { LocalExecutor } from '../LocalExecutor.adapter.js';

const execFileAsync = promisify(execFile);

type RunCall = { argv: readonly string[]; options?: CommandRunOptions };

/**
 * Recording fake executor. Canned results are matched by the first marker that
 * is a substring of the joined argv; unmatched runs default to exit 2 so an
 * unscripted argv is never a silent pass.
 */
function fakeExecutor(
  canned: Readonly<Record<string, Partial<CommandRunResult>>> = {},
): { executor: CommandExecutorPort; calls: RunCall[] } {
  const calls: RunCall[] = [];
  return {
    executor: {
      run: async (
        argv: readonly string[],
        options?: CommandRunOptions,
      ): Promise<CommandRunResult> => {
        const call: RunCall = { argv, options };
        calls.push(call);
        const joined = argv.join(' ');
        const marker = Object.keys(canned).find((key) => joined.includes(key));
        const partial =
          marker !== undefined ? { exitCode: 0, ...canned[marker] } : { exitCode: 2 };
        return { signal: null, stdout: '', stderr: '', ...partial };
      },
    },
    calls,
  };
}

const CLONE = '/srv/fleet/clone';
const WORKTREE_ROOT = '/srv/fleet/worktrees';
const WORKTREE = `${WORKTREE_ROOT}/wt1`;
const BRANCH = 'fleet/run-01ARZ3NDEKTSV4RRFFQ69G5FAV';
const HEAD = 'a'.repeat(40);

const RECORDED_HOST: AttemptRunnerRecord = {
  kind: 'opencode',
  remotePort: 4166,
  host: 'lane-host',
  hostName: 'lane-host',
  agent: 'ex',
  model: 'm',
  variant: null,
};

function makeRequest(overrides: Partial<RemoveLaneWorktreeRequest> = {}): RemoveLaneWorktreeRequest {
  return {
    clonePath: CLONE,
    worktreeRoot: WORKTREE_ROOT,
    worktreePath: WORKTREE,
    branch: BRANCH,
    recordedHost: RECORDED_HOST,
    ...overrides,
  };
}

/** The recorded host resolves to the scripted executor; anything else refuses. */
function executorForRecordedHost(executor: CommandExecutorPort): {
  (recorded: AttemptRunnerRecord | null | undefined): ExecutorForRecordedHostResult;
} {
  return (recorded) => {
    if (recorded !== null && recorded !== undefined && recorded.hostName === 'lane-host') {
      return { ok: true, executor };
    }
    return { ok: false, reason: 'no executor for the recorded host' };
  };
}

/** The porcelain list of one clean linked worktree at WORKTREE on BRANCH. */
function worktreeList(head: string = HEAD): string {
  return (
    `worktree ${CLONE}\nHEAD ${'c'.repeat(40)}\nbranch refs/heads/main\n\n` +
    `worktree ${WORKTREE}\nHEAD ${head}\nbranch refs/heads/${BRANCH}\n`
  );
}

/** The porcelain list with only the clone: the worktree is not listed. */
function listWithoutWorktree(): string {
  return `worktree ${CLONE}\nHEAD ${'c'.repeat(40)}\nbranch refs/heads/main\n`;
}

const LIST_MARKER = 'worktree list --porcelain';
const STATUS_MARKER = 'status --porcelain --untracked-files=all';
const REMOVE_MARKER = 'worktree remove';

async function removeWith(
  canned: Readonly<Record<string, Partial<CommandRunResult>>>,
  request: RemoveLaneWorktreeRequest = makeRequest(),
): Promise<{ result: Awaited<ReturnType<WorkspaceAdapter['removeLaneWorktree']>>; calls: RunCall[] }> {
  const { executor, calls } = fakeExecutor(canned);
  const adapter = new WorkspaceAdapter({ executorForRecordedHost: executorForRecordedHost(executor) });
  const result = await adapter.removeLaneWorktree(request);
  return { result, calls };
}

describe('removeLaneWorktree over a fake executor', () => {
  it('removes a clean listed worktree with the exact argv sequence and no branch command', async () => {
    const { result, calls } = await removeWith({
      [LIST_MARKER]: { stdout: worktreeList() },
      [STATUS_MARKER]: { stdout: '' },
      [REMOVE_MARKER]: { exitCode: 0 },
    });
    expect(result).toEqual({ outcome: 'removed', branchTip: HEAD });
    expect(calls.map((call) => call.argv)).toEqual([
      ['git', '-C', CLONE, 'worktree', 'list', '--porcelain'],
      ['git', '-C', WORKTREE, 'status', '--porcelain', '--untracked-files=all'],
      ['git', '-C', CLONE, 'worktree', 'remove', WORKTREE],
    ]);
    const joined = calls.map((call) => call.argv.join(' ')).join('\n');
    expect(joined).not.toContain('branch');
    expect(joined).not.toContain('--force');
    expect(joined).not.toContain('prune');
  });

  it('answers already-removed when the path is neither listed nor present', async () => {
    const { result, calls } = await removeWith({
      [LIST_MARKER]: { stdout: listWithoutWorktree() },
      'test -e': { exitCode: 1 },
    });
    expect(result).toEqual({ outcome: 'already-removed' });
    expect(calls.some((call) => call.argv.includes('remove'))).toBe(false);
  });

  it('refuses not-a-worktree when the path exists but git does not list it', async () => {
    const { result, calls } = await removeWith({
      [LIST_MARKER]: { stdout: listWithoutWorktree() },
      'test -e': { exitCode: 0 },
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'not-a-worktree' });
    expect(calls.some((call) => call.argv.includes('remove'))).toBe(false);
  });

  it('refuses branch-mismatch for another branch and never removes', async () => {
    const { result, calls } = await removeWith({
      [LIST_MARKER]: { stdout: worktreeList() },
      [STATUS_MARKER]: { stdout: '' },
    }, makeRequest({ branch: 'fleet/run-02ARZ3NDEKTSV4RRFFQ69G5FAV' }));
    expect(result).toEqual({ outcome: 'refused', reason: 'branch-mismatch' });
    expect(calls.some((call) => call.argv.includes('remove'))).toBe(false);
  });

  it('refuses branch-mismatch for a detached entry and never removes', async () => {
    const { result, calls } = await removeWith({
      [LIST_MARKER]: {
        stdout:
          `worktree ${CLONE}\nHEAD ${'c'.repeat(40)}\nbranch refs/heads/main\n\n` +
          `worktree ${WORKTREE}\nHEAD ${HEAD}\ndetached\n`,
      },
      [STATUS_MARKER]: { stdout: '' },
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'branch-mismatch' });
    expect(calls.some((call) => call.argv.includes('remove'))).toBe(false);
  });

  it('refuses locked and never removes', async () => {
    const { result, calls } = await removeWith({
      [LIST_MARKER]: { stdout: `${worktreeList()}locked reason here\n` },
      [STATUS_MARKER]: { stdout: '' },
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'locked' });
    expect(calls.some((call) => call.argv.includes('remove'))).toBe(false);
  });

  it('refuses dirty and issues no remove', async () => {
    const { result, calls } = await removeWith({
      [LIST_MARKER]: { stdout: worktreeList() },
      [STATUS_MARKER]: { stdout: ' M src/a.ts\n' },
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'dirty' });
    expect(calls.some((call) => call.argv.includes('remove'))).toBe(false);
  });

  it('refuses git-refused when status exits non-zero', async () => {
    const { result, calls } = await removeWith({
      [LIST_MARKER]: { stdout: worktreeList() },
      [STATUS_MARKER]: { exitCode: 128, stderr: 'fatal' },
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'git-refused' });
    expect(calls.some((call) => call.argv.includes('remove'))).toBe(false);
  });

  it('answers unknown when status never reports an exit code', async () => {
    const { result, calls } = await removeWith({
      [LIST_MARKER]: { stdout: worktreeList() },
      [STATUS_MARKER]: { exitCode: null, error: 'timeout' },
    });
    expect(result).toEqual({ outcome: 'unknown' });
    expect(calls.some((call) => call.argv.includes('remove'))).toBe(false);
  });

  it('refuses git-refused when the remove exits non-zero', async () => {
    const { result } = await removeWith({
      [LIST_MARKER]: { stdout: worktreeList() },
      [STATUS_MARKER]: { stdout: '' },
      [REMOVE_MARKER]: { exitCode: 128, stderr: 'fatal' },
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'git-refused' });
  });

  it('answers unknown when the remove never reports an exit code', async () => {
    const { result } = await removeWith({
      [LIST_MARKER]: { stdout: worktreeList() },
      [STATUS_MARKER]: { stdout: '' },
      [REMOVE_MARKER]: { exitCode: null, error: 'timeout' },
    });
    expect(result).toEqual({ outcome: 'unknown' });
  });

  it('refuses invalid-request for a worktree outside the worktree root, with no command run', async () => {
    const { result, calls } = await removeWith(
      {},
      makeRequest({ worktreePath: '/srv/fleet/elsewhere/wt1' }),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(calls).toHaveLength(0);
  });

  it('refuses invalid-request for a worktree inside the clone, with no command run', async () => {
    const { result, calls } = await removeWith(
      {},
      makeRequest({
        worktreeRoot: CLONE,
        worktreePath: `${CLONE}/inner/wt1`,
      }),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(calls).toHaveLength(0);
  });

  it('refuses invalid-request for an invalid branch, with no command run', async () => {
    const { result, calls } = await removeWith({}, makeRequest({ branch: 'main' }));
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(calls).toHaveLength(0);
  });

  it('refuses invalid-request for a record without a host name, with no command run', async () => {
    const { result, calls } = await removeWith(
      {},
      makeRequest({ recordedHost: { ...RECORDED_HOST, hostName: null } }),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(calls).toHaveLength(0);
  });

  it('answers unknown and runs nothing when the adapter has no executorForRecordedHost', async () => {
    const { executor, calls } = fakeExecutor({ [LIST_MARKER]: { stdout: worktreeList() } });
    const adapter = new WorkspaceAdapter({ executor });
    const result = await adapter.removeLaneWorktree(makeRequest());
    expect(result).toEqual({ outcome: 'unknown' });
    expect(calls).toHaveLength(0);
  });

  it('answers unknown when the recorded host does not resolve', async () => {
    const { executor, calls } = fakeExecutor({ [LIST_MARKER]: { stdout: worktreeList() } });
    const adapter = new WorkspaceAdapter({ executorForRecordedHost: executorForRecordedHost(executor) });
    const result = await adapter.removeLaneWorktree(
      makeRequest({ recordedHost: { ...RECORDED_HOST, hostName: 'gone-host' } }),
    );
    expect(result).toEqual({ outcome: 'unknown' });
    expect(calls).toHaveLength(0);
  });

  it('removes a symlinked worktree whose physical form git lists', async () => {
    const physical = `/private${WORKTREE}`;
    const { result, calls } = await removeWith({
      [LIST_MARKER]: { stdout: worktreeList().replace(WORKTREE, physical) },
      [STATUS_MARKER]: { stdout: '' },
      [REMOVE_MARKER]: { exitCode: 0 },
      'pwd -P': { stdout: `${physical}\n` },
    });
    expect(result).toEqual({ outcome: 'removed', branchTip: HEAD });
    expect(calls.some((call) => call.argv.join(' ') === physicalPathArgv(WORKTREE).join(' '))).toBe(true);
    expect(calls[calls.length - 1]?.argv).toEqual(['git', '-C', CLONE, 'worktree', 'remove', WORKTREE]);
  });
});

describe('removeLaneWorktree against real git', () => {
  const createdDirs = new Set<string>();

  afterAll(async () => {
    await Promise.all(
      [...createdDirs].map((directory) => fs.rm(directory, { recursive: true, force: true })),
    );
  });

  async function setup(): Promise<{
    clonePath: string;
    worktreeRoot: string;
    worktreePath: string;
    branch: string;
    head: string;
    adapter: WorkspaceAdapter;
  }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-remove-wt-'));
    createdDirs.add(root);
    const clonePath = path.join(root, 'clone');
    const worktreeRoot = path.join(root, 'worktrees');
    const worktreePath = path.join(worktreeRoot, 'wt');
    const git = (args: readonly string[], cwd: string = clonePath) =>
      execFileAsync(
        'git',
        ['-c', 'user.name=Fleet Test', '-c', 'user.email=fleet-test@example.invalid', ...args],
        { cwd },
      );
    await fs.mkdir(clonePath);
    await git(['init']);
    await git(['config', 'user.name', 'Fleet Test']);
    await git(['config', 'user.email', 'fleet-test@example.invalid']);
    await fs.writeFile(path.join(clonePath, 'README.md'), '# fleet test\n', 'utf8');
    await git(['add', '.']);
    await git(['commit', '-m', 'initial commit']);
    const { stdout: head } = await git(['rev-parse', 'HEAD']);
    const branch = 'fleet/run-01ARZ3NDEKTSV4RRFFQ69G5FAV';
    await fs.mkdir(worktreeRoot);
    await git(['worktree', 'add', '-b', branch, worktreePath, head.trim()]);
    const adapter = new WorkspaceAdapter({
      executorForRecordedHost: () => ({ ok: true, executor: new LocalExecutor() }),
    });
    return {
      clonePath,
      worktreeRoot,
      worktreePath,
      branch,
      head: head.trim(),
      adapter,
    };
  }

  async function cloneState(clonePath: string): Promise<{ listed: string; head: string; status: string }> {
    const listed = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: clonePath });
    const head = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: clonePath });
    const status = await execFileAsync('git', ['status', '--porcelain'], { cwd: clonePath });
    return { listed: listed.stdout, head: head.stdout.trim(), status: status.stdout };
  }

  it('removes a clean worktree, keeps the branch and leaves the clone unchanged', async () => {
    const setup_ = await setup();
    const before = await cloneState(setup_.clonePath);
    const result = await setup_.adapter.removeLaneWorktree(
      makeRequest({
        clonePath: setup_.clonePath,
        worktreeRoot: setup_.worktreeRoot,
        worktreePath: setup_.worktreePath,
        branch: setup_.branch,
      }),
    );
    expect(result).toEqual({ outcome: 'removed', branchTip: setup_.head });
    const after = await cloneState(setup_.clonePath);
    expect(after.listed).not.toContain(setup_.worktreePath);
    await expect(
      execFileAsync('git', ['rev-parse', '--verify', `refs/heads/${setup_.branch}`], { cwd: setup_.clonePath }),
    ).resolves.toBeTruthy();
    expect(after.head).toBe(before.head);
    expect(after.status).toBe(before.status);
  });

  it('refuses dirty for an untracked file and keeps the worktree listed', async () => {
    const setup_ = await setup();
    await fs.writeFile(path.join(setup_.worktreePath, 'untracked.txt'), 'x\n', 'utf8');
    const result = await setup_.adapter.removeLaneWorktree(
      makeRequest({
        clonePath: setup_.clonePath,
        worktreeRoot: setup_.worktreeRoot,
        worktreePath: setup_.worktreePath,
        branch: setup_.branch,
      }),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'dirty' });
    const listed = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: setup_.clonePath });
    expect(listed.stdout).toContain(setup_.worktreePath);
  });

  it('refuses locked for a locked worktree and keeps the worktree listed', async () => {
    const setup_ = await setup();
    await execFileAsync('git', ['worktree', 'lock', setup_.worktreePath], { cwd: setup_.clonePath });
    const result = await setup_.adapter.removeLaneWorktree(
      makeRequest({
        clonePath: setup_.clonePath,
        worktreeRoot: setup_.worktreeRoot,
        worktreePath: setup_.worktreePath,
        branch: setup_.branch,
      }),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'locked' });
    const listed = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: setup_.clonePath });
    expect(listed.stdout).toContain(setup_.worktreePath);
  });

  it('refuses not-a-worktree for a plain directory and leaves it untouched', async () => {
    const setup_ = await setup();
    const plainDir = path.join(setup_.worktreeRoot, 'plain');
    await fs.mkdir(plainDir);
    await fs.writeFile(path.join(plainDir, 'keep.txt'), 'keep\n', 'utf8');
    const result = await setup_.adapter.removeLaneWorktree(
      makeRequest({
        clonePath: setup_.clonePath,
        worktreeRoot: setup_.worktreeRoot,
        worktreePath: plainDir,
        branch: setup_.branch,
      }),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'not-a-worktree' });
    const kept = await fs.readFile(path.join(plainDir, 'keep.txt'), 'utf8');
    expect(kept).toBe('keep\n');
  });
});
