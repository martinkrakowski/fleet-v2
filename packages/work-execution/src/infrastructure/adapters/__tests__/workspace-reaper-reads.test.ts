// Adapter tests for WorkspaceAdapter.listWorktrees, inspectWorktreeForRemoval
// and readFilesystemSpace (KW2, D18): fake-executor tests script a recording
// CommandExecutorPort and assert the exact argv sequence and the guards; a
// real-git describe proves the reads against actual git in a temporary
// repository.

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
import type {
  InspectWorktreeForRemovalRequest,
  ListWorktreesRequest,
} from '../../../application/ports/out/WorkspacePort.out-port.js';
import { WorkspaceAdapter } from '../WorkspaceAdapter.adapter.js';
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
const LOCKED_WT = `${WORKTREE_ROOT}/wt-locked`;
const PRUNABLE_WT = `${WORKTREE_ROOT}/wt-prunable`;
const HEAD = 'a'.repeat(40);
const DEFAULT_REF = 'origin/main';

const RECORDED_HOST: AttemptRunnerRecord = {
  kind: 'opencode',
  remotePort: 4166,
  host: 'lane-host',
  hostName: 'lane-host',
  agent: 'ex',
  model: 'm',
  variant: null,
};

function listRequest(overrides: Partial<ListWorktreesRequest> = {}): ListWorktreesRequest {
  return { repositoryRoot: CLONE, recordedHost: RECORDED_HOST, ...overrides };
}

function inspectRequest(
  overrides: Partial<InspectWorktreeForRemovalRequest> = {},
): InspectWorktreeForRemovalRequest {
  return {
    repositoryRoot: CLONE,
    worktreePath: WORKTREE,
    defaultRef: DEFAULT_REF,
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

const LIST_MARKER = 'worktree list --porcelain';
const STATUS_MARKER = 'status --porcelain --untracked-files=all';
const GIT_DIR_MARKER = 'rev-parse --git-dir';
const INDEX_PATH_MARKER = 'rev-parse --git-path index';
const REFLOG_MARKER = 'reflog';
const STAT_GNU_MARKER = 'stat -c %Y';
const FIND_MARKER = 'find';
const DU_MARKER = 'du -sk';
const MERGE_BASE_MARKER = 'merge-base';
const TEST_E_MARKER = 'test -e';
const PWD_MARKER = 'pwd -P';

/** The porcelain list of a main checkout plus one clean linked worktree at WORKTREE. */
function worktreeListWith(head: string = HEAD, extra: string = ''): string {
  return (
    `worktree ${CLONE}\nHEAD ${'c'.repeat(40)}\nbranch refs/heads/main\n\n` +
    `worktree ${WORKTREE}\nHEAD ${head}\nbranch refs/heads/feature/wt\n${extra}`
  );
}

function listWithoutWorktree(): string {
  return `worktree ${CLONE}\nHEAD ${'c'.repeat(40)}\nbranch refs/heads/main\n`;
}

describe('worktree listing and removal-fact reads over a fake executor', () => {
  it('listWorktrees lists the main checkout, a locked linked worktree and a prunable entry with exactly one command', async () => {
    const { executor, calls } = fakeExecutor({
      [LIST_MARKER]: {
        stdout:
          `worktree ${CLONE}\nHEAD ${'c'.repeat(40)}\nbranch refs/heads/main\n\n` +
          `worktree ${LOCKED_WT}\nHEAD ${HEAD}\nbranch refs/heads/feature/locked\nlocked reason here\n\n` +
          `worktree ${PRUNABLE_WT}\nHEAD ${HEAD}\nbranch refs/heads/feature/prunable\nprunable reason here\n`,
      },
    });
    const adapter = new WorkspaceAdapter({ executorForRecordedHost: executorForRecordedHost(executor) });
    const result = await adapter.listWorktrees(listRequest());
    expect(result).toEqual({
      outcome: 'listed',
      worktrees: [
        { path: CLONE, head: 'c'.repeat(40), branch: 'main', locked: false, prunable: false },
        { path: LOCKED_WT, head: HEAD, branch: 'feature/locked', locked: true, prunable: false },
        { path: PRUNABLE_WT, head: HEAD, branch: 'feature/prunable', locked: false, prunable: true },
      ],
    });
    expect(calls.map((call) => call.argv)).toEqual([
      ['git', '-C', CLONE, 'worktree', 'list', '--porcelain'],
    ]);
  });

  it('listWorktrees answers unknown when git exits 128', async () => {
    const { executor, calls } = fakeExecutor({
      [LIST_MARKER]: { exitCode: 128, stderr: 'fatal: not a git repository' },
    });
    const adapter = new WorkspaceAdapter({ executorForRecordedHost: executorForRecordedHost(executor) });
    const result = await adapter.listWorktrees(listRequest());
    expect(result).toEqual({ outcome: 'unknown', reason: 'git worktree list failed' });
    expect(calls).toHaveLength(1);
  });

  it('listWorktrees answers unknown when git worktree list exits 0 with empty or malformed output', async () => {
    const { executor: emptyExecutor } = fakeExecutor({
      [LIST_MARKER]: { stdout: '' },
    });
    const emptyAdapter = new WorkspaceAdapter({
      executorForRecordedHost: executorForRecordedHost(emptyExecutor),
    });
    const emptyResult = await emptyAdapter.listWorktrees(listRequest());
    expect(emptyResult).toEqual({
      outcome: 'unknown',
      reason: 'git worktree list output could not be parsed',
    });

    const { executor: malformedExecutor } = fakeExecutor({
      [LIST_MARKER]: { stdout: 'unexpected output before any worktree\n' },
    });
    const malformedAdapter = new WorkspaceAdapter({
      executorForRecordedHost: executorForRecordedHost(malformedExecutor),
    });
    const malformedResult = await malformedAdapter.listWorktrees(listRequest());
    expect(malformedResult).toEqual({
      outcome: 'unknown',
      reason: 'git worktree list output could not be parsed',
    });
  });

  it('listWorktrees answers unknown invalid-request and runs no command for a relative repositoryRoot', async () => {
    const { executor, calls } = fakeExecutor();
    const adapter = new WorkspaceAdapter({ executorForRecordedHost: executorForRecordedHost(executor) });
    const result = await adapter.listWorktrees(listRequest({ repositoryRoot: 'relative/path' }));
    expect(result).toEqual({ outcome: 'unknown', reason: 'invalid-request' });
    expect(calls).toHaveLength(0);
  });

  it('inspectWorktreeForRemoval answers unknown (not refused) when git worktree list exits 0 with empty or malformed output', async () => {
    const { executor: emptyExecutor, calls: emptyCalls } = fakeExecutor({
      [LIST_MARKER]: { stdout: '' },
    });
    const emptyAdapter = new WorkspaceAdapter({
      executorForRecordedHost: executorForRecordedHost(emptyExecutor),
    });
    const emptyResult = await emptyAdapter.inspectWorktreeForRemoval(inspectRequest());
    expect(emptyResult).toEqual({
      outcome: 'unknown',
      reason: 'git worktree list output could not be parsed',
    });
    expect(emptyCalls).toHaveLength(1);

    const { executor: malformedExecutor, calls: malformedCalls } = fakeExecutor({
      [LIST_MARKER]: { stdout: 'corrupt worktree list output\n' },
    });
    const malformedAdapter = new WorkspaceAdapter({
      executorForRecordedHost: executorForRecordedHost(malformedExecutor),
    });
    const malformedResult = await malformedAdapter.inspectWorktreeForRemoval(inspectRequest());
    expect(malformedResult).toEqual({
      outcome: 'unknown',
      reason: 'git worktree list output could not be parsed',
    });
    expect(malformedCalls).toHaveLength(1);
  });

  it('inspectWorktreeForRemoval refuses not-a-linked-worktree for a path the list does not carry and runs no other command', async () => {
    const { executor, calls } = fakeExecutor({
      [LIST_MARKER]: { stdout: listWithoutWorktree() },
      [PWD_MARKER]: { stdout: `${WORKTREE}\n` },
    });
    const adapter = new WorkspaceAdapter({ executorForRecordedHost: executorForRecordedHost(executor) });
    const result = await adapter.inspectWorktreeForRemoval(inspectRequest());
    expect(result).toEqual({ outcome: 'refused', reason: 'not-a-linked-worktree' });
    const joined = calls.map((call) => call.argv.join(' ')).join('\n');
    expect(joined).not.toContain(MERGE_BASE_MARKER);
    expect(joined).not.toContain(STATUS_MARKER);
    expect(joined).not.toContain(GIT_DIR_MARKER);
    expect(joined).not.toContain(DU_MARKER);
  });

  it('inspectWorktreeForRemoval refuses invalid-request for a relative worktreePath and runs no command', async () => {
    const { executor, calls } = fakeExecutor();
    const adapter = new WorkspaceAdapter({ executorForRecordedHost: executorForRecordedHost(executor) });
    const result = await adapter.inspectWorktreeForRemoval(
      inspectRequest({ worktreePath: 'relative/path' }),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(calls).toHaveLength(0);
  });

  it('inspectWorktreeForRemoval never runs a mutating command', async () => {
    const { executor, calls } = fakeExecutor({
      [LIST_MARKER]: { stdout: worktreeListWith() },
      [PWD_MARKER]: { stdout: `${CLONE}\n` },
      [MERGE_BASE_MARKER]: { exitCode: 0 },
      [STATUS_MARKER]: { stdout: '' },
      [GIT_DIR_MARKER]: { stdout: `${WORKTREE}/.git\n` },
      [TEST_E_MARKER]: { exitCode: 1 },
      [REFLOG_MARKER]: { stdout: '2026-01-01T00:00:00+00:00\n' },
      [INDEX_PATH_MARKER]: { stdout: `${WORKTREE}/.git/index\n` },
      [FIND_MARKER]: { stdout: '1767225600\n' },
      [STAT_GNU_MARKER]: { stdout: '1767225600\n' },
      [DU_MARKER]: { stdout: `8\t${WORKTREE}\n` },
    });
    const adapter = new WorkspaceAdapter({ executorForRecordedHost: executorForRecordedHost(executor) });
    const result = await adapter.inspectWorktreeForRemoval(inspectRequest());
    expect(result.outcome).toBe('inspected');
    if (result.outcome !== 'inspected') return;
    expect(result.facts.head).toBe(HEAD);
    expect(result.facts.branch).toBe('feature/wt');
    expect(result.facts.detached).toBe(false);
    expect(result.facts.headOnDefault).toBe(true);
    expect(result.facts.status).toEqual({ tracked: 0, untracked: 0, unmerged: 0 });
    expect(result.facts.locked).toBe(false);
    expect(result.facts.inProgressOperations).toEqual([]);
    expect(typeof result.facts.lastActivity.iso).toBe('string');
    expect(result.facts.lastActivity.unknown).toBe(false);
    expect(result.facts.sizeBytes).toBe(8192);
    const banned = [
      '--force', 'prune', 'remove', 'lock', 'fetch', 'push', 'checkout',
      'reset', 'clean', 'update-ref', 'merge',
    ];
    for (const call of calls) {
      for (const token of call.argv) {
        expect(banned).not.toContain(token);
      }
    }
  });

  it('inspectWorktreeForRemoval requests reflog with --format=%gD and parses reflog selector timestamp', async () => {
    const { executor, calls } = fakeExecutor({
      [LIST_MARKER]: { stdout: worktreeListWith() },
      [PWD_MARKER]: { stdout: `${CLONE}\n` },
      [MERGE_BASE_MARKER]: { exitCode: 0 },
      [STATUS_MARKER]: { stdout: '' },
      [GIT_DIR_MARKER]: { stdout: `${WORKTREE}/.git\n` },
      [TEST_E_MARKER]: { exitCode: 1 },
      [REFLOG_MARKER]: { stdout: 'HEAD@{2026-06-01T12:00:00+00:00}\n' },
      [INDEX_PATH_MARKER]: { stdout: `${WORKTREE}/.git/index\n` },
      [FIND_MARKER]: { stdout: '1767225600\n' },
      [STAT_GNU_MARKER]: { stdout: '1767225600\n' },
      [DU_MARKER]: { stdout: `8\t${WORKTREE}\n` },
    });
    const adapter = new WorkspaceAdapter({ executorForRecordedHost: executorForRecordedHost(executor) });
    const result = await adapter.inspectWorktreeForRemoval(inspectRequest());
    expect(result.outcome).toBe('inspected');
    if (result.outcome !== 'inspected') return;
    const reflogCall = calls.find((call) => call.argv.includes('reflog'));
    expect(reflogCall?.argv).toContain('--format=%gD');
    expect(reflogCall?.argv).not.toContain('--format=%cd');
    expect(result.facts.lastActivity.iso).toBe('2026-06-01T12:00:00.000Z');
  });
});

describe('worktree listing and removal-fact reads against real git', () => {
  const createdDirs = new Set<string>();

  afterAll(async () => {
    await Promise.all(
      [...createdDirs].map((directory) => fs.rm(directory, { recursive: true, force: true })),
    );
  });

  interface ReaperReadSetup {
    repositoryRoot: string;
    worktreeRoot: string;
    worktreePath: string;
    branch: string;
    head: string;
    adapter: WorkspaceAdapter;
    git: (args: readonly string[], cwd?: string) => Promise<{ stdout: string; stderr: string }>;
  }

  async function setup(withGitignore = false): Promise<ReaperReadSetup> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-reaper-reads-'));
    createdDirs.add(root);
    const repositoryRoot = path.join(root, 'clone');
    const worktreeRoot = path.join(root, 'worktrees');
    const worktreePath = path.join(worktreeRoot, 'wt');
    const git = (args: readonly string[], cwd: string = repositoryRoot) =>
      execFileAsync(
        'git',
        ['-c', 'user.name=Fleet Test', '-c', 'user.email=fleet-test@example.invalid', ...args],
        { cwd },
      );
    await fs.mkdir(repositoryRoot);
    await git(['init']);
    await git(['config', 'user.name', 'Fleet Test']);
    await git(['config', 'user.email', 'fleet-test@example.invalid']);
    if (withGitignore) {
      await fs.writeFile(path.join(repositoryRoot, '.gitignore'), 'ignored.txt\n', 'utf8');
    }
    await fs.writeFile(path.join(repositoryRoot, 'README.md'), '# fleet test\n', 'utf8');
    await git(['add', '.']);
    await git(['commit', '-m', 'initial commit']);
    const { stdout: headStdout } = await git(['rev-parse', 'HEAD']);
    const head = headStdout.trim();
    await git(['update-ref', 'refs/remotes/origin/main', head]);
    const branch = 'feature/wt';
    await fs.mkdir(worktreeRoot);
    await git(['worktree', 'add', '-b', branch, worktreePath, head]);
    const adapter = new WorkspaceAdapter({
      executorForRecordedHost: () => ({ ok: true, executor: new LocalExecutor() }),
    });
    return { repositoryRoot, worktreeRoot, worktreePath, branch, head, adapter, git };
  }

  function listedRequest(setup_: ReaperReadSetup): ListWorktreesRequest {
    return { repositoryRoot: setup_.repositoryRoot, recordedHost: RECORDED_HOST };
  }

  function inspectedRequest(
    setup_: ReaperReadSetup,
    overrides: Partial<InspectWorktreeForRemovalRequest> = {},
  ): InspectWorktreeForRemovalRequest {
    return {
      repositoryRoot: setup_.repositoryRoot,
      worktreePath: setup_.worktreePath,
      defaultRef: 'origin/main',
      recordedHost: RECORDED_HOST,
      ...overrides,
    };
  }

  it('listWorktrees lists the clone and the linked worktree with its branch and HEAD', async () => {
    const s = await setup();
    const result = await s.adapter.listWorktrees(listedRequest(s));
    expect(result.outcome).toBe('listed');
    if (result.outcome !== 'listed') return;
    const linked = result.worktrees.find((entry) => entry.path === s.worktreePath);
    expect(linked).toBeDefined();
    expect(linked?.head).toBe(s.head);
    expect(linked?.branch).toBe(s.branch);
    expect(linked?.locked).toBe(false);
    expect(linked?.prunable).toBe(false);
    expect(result.worktrees.some((entry) => entry.path === s.repositoryRoot)).toBe(true);
  });

  it('listWorktrees marks a locked worktree and a prunable entry', async () => {
    const s = await setup();
    const lockedWt = path.join(s.worktreeRoot, 'wt-locked');
    const prunableWt = path.join(s.worktreeRoot, 'wt-prunable');
    await s.git(['worktree', 'add', '-b', 'feature/locked', lockedWt, s.head]);
    await s.git(['worktree', 'add', '-b', 'feature/prunable', prunableWt, s.head]);
    await s.git(['worktree', 'lock', lockedWt]);
    await fs.rm(prunableWt, { recursive: true, force: true });
    const result = await s.adapter.listWorktrees(listedRequest(s));
    expect(result.outcome).toBe('listed');
    if (result.outcome !== 'listed') return;
    const lockedEntry = result.worktrees.find((entry) => entry.path === lockedWt);
    const prunableEntry = result.worktrees.find((entry) => entry.path === prunableWt);
    expect(lockedEntry?.locked).toBe(true);
    expect(prunableEntry?.prunable).toBe(true);
  });

  it('inspectWorktreeForRemoval reads the facts of a merged worktree', async () => {
    const s = await setup();
    const result = await s.adapter.inspectWorktreeForRemoval(inspectedRequest(s));
    expect(result.outcome).toBe('inspected');
    if (result.outcome !== 'inspected') return;
    expect(result.facts.path).toBe(s.worktreePath);
    expect(result.facts.head).toBe(s.head);
    expect(result.facts.branch).toBe(s.branch);
    expect(result.facts.detached).toBe(false);
    expect(result.facts.headOnDefault).toBe(true);
    expect(result.facts.status).toEqual({ tracked: 0, untracked: 0, unmerged: 0 });
    expect(result.facts.locked).toBe(false);
    expect(result.facts.inProgressOperations).toEqual([]);
    expect(typeof result.facts.lastActivity.iso).toBe('string');
    expect(result.facts.sizeBytes).toBeGreaterThan(0);
  });

  it('inspectWorktreeForRemoval reports headOnDefault false for an unmerged worktree', async () => {
    const s = await setup();
    await fs.writeFile(path.join(s.worktreePath, 'second.txt'), 'second\n', 'utf8');
    await s.git(['add', '.'], s.worktreePath);
    await s.git(['commit', '-m', 'second commit'], s.worktreePath);
    const result = await s.adapter.inspectWorktreeForRemoval(inspectedRequest(s));
    expect(result.outcome).toBe('inspected');
    if (result.outcome !== 'inspected') return;
    expect(result.facts.headOnDefault).toBe(false);
    expect(result.facts.branch).toBe(s.branch);
  });

  it('inspectWorktreeForRemoval counts a dirty tracked file', async () => {
    const s = await setup();
    await fs.writeFile(path.join(s.worktreePath, 'README.md'), '# changed\n', 'utf8');
    const result = await s.adapter.inspectWorktreeForRemoval(inspectedRequest(s));
    expect(result.outcome).toBe('inspected');
    if (result.outcome !== 'inspected') return;
    expect(result.facts.status.tracked).toBe(1);
    expect(result.facts.status.untracked).toBe(0);
    expect(result.facts.status.unmerged).toBe(0);
  });

  it('inspectWorktreeForRemoval counts zero for a worktree holding only an ignored file', async () => {
    const s = await setup(true);
    await fs.writeFile(path.join(s.worktreePath, 'ignored.txt'), 'ignored\n', 'utf8');
    const result = await s.adapter.inspectWorktreeForRemoval(inspectedRequest(s));
    expect(result.outcome).toBe('inspected');
    if (result.outcome !== 'inspected') return;
    expect(result.facts.status).toEqual({ tracked: 0, untracked: 0, unmerged: 0 });
    expect(typeof result.facts.lastActivity.iso).toBe('string');
  });

  it('inspectWorktreeForRemoval reports a locked worktree', async () => {
    const s = await setup();
    await s.git(['worktree', 'lock', s.worktreePath]);
    const result = await s.adapter.inspectWorktreeForRemoval(inspectedRequest(s));
    expect(result.outcome).toBe('inspected');
    if (result.outcome !== 'inspected') return;
    expect(result.facts.locked).toBe(true);
  });

  it('inspectWorktreeForRemoval refuses the main checkout itself', async () => {
    const s = await setup();
    const result = await s.adapter.inspectWorktreeForRemoval(
      inspectedRequest(s, { worktreePath: s.repositoryRoot }),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'not-a-linked-worktree' });
  });

  it('inspectWorktreeForRemoval detects an in-progress MERGE_HEAD', async () => {
    const s = await setup();
    const { stdout: gitDirStdout } = await s.git(['rev-parse', '--git-dir'], s.worktreePath);
    const gitDir = gitDirStdout.trim();
    const mergeHead = path.isAbsolute(gitDir)
      ? path.join(gitDir, 'MERGE_HEAD')
      : path.join(s.worktreePath, gitDir, 'MERGE_HEAD');
    await fs.writeFile(mergeHead, `${'b'.repeat(40)}\n`, 'utf8');
    const result = await s.adapter.inspectWorktreeForRemoval(inspectedRequest(s));
    expect(result.outcome).toBe('inspected');
    if (result.outcome !== 'inspected') return;
    expect(result.facts.inProgressOperations).toContain('MERGE_HEAD');
  });

  it('inspectWorktreeForRemoval reports recent reflog timestamp when HEAD commit has an old committer date', async () => {
    const s = await setup();
    const oldCommitDate = '2020-01-01T00:00:00Z';
    await execFileAsync(
      'git',
      ['-c', 'user.name=Fleet Test', '-c', 'user.email=fleet-test@example.invalid', 'commit', '--allow-empty', '-m', 'old commit'],
      {
        cwd: s.worktreePath,
        env: {
          ...process.env,
          GIT_COMMITTER_DATE: oldCommitDate,
          GIT_AUTHOR_DATE: oldCommitDate,
        },
      },
    );
    // HEAD was recently updated by switching to a new branch in the worktree:
    await s.git(['checkout', '-b', 'feature/recent-action'], s.worktreePath);

    const result = await s.adapter.inspectWorktreeForRemoval(inspectedRequest(s));
    expect(result.outcome).toBe('inspected');
    if (result.outcome !== 'inspected') return;
    expect(result.facts.lastActivity.iso).toBeDefined();
    const reportedMs = Date.parse(result.facts.lastActivity.iso!);
    const oldMs = Date.parse(oldCommitDate);
    // %cd would report oldMs (2020), while %gD reports the reflog entry timestamp (recent):
    expect(reportedMs).toBeGreaterThan(oldMs);
  });

  it('readFilesystemSpace reads free and total bytes of the filesystem holding a path', async () => {
    const s = await setup();
    const result = await s.adapter.readFilesystemSpace({
      path: s.repositoryRoot,
      recordedHost: RECORDED_HOST,
    });
    expect(result.outcome).toBe('read');
    if (result.outcome !== 'read') return;
    expect(result.freeBytes).toBeGreaterThan(0);
    expect(result.totalBytes).toBeGreaterThanOrEqual(result.freeBytes);
  });
});
