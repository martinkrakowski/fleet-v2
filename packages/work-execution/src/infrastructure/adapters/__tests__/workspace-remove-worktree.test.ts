// Adapter tests for WorkspaceAdapter.removeWorktree (KW3', conductor plan
// §3.10.3): fake-executor tests script a recording CommandExecutorPort and
// assert the exact argv sequence, the re-read guards and the refusals; a
// real-git describe proves the removal against actual git in a temporary
// repository. The guards under test include containment against the resolved
// physical paths (a symlinked path may not escape the worktree root), the
// in-progress operation probes (only exit 1 means "absent") and the bounded
// activity re-check (a write to an ignored file after the read refuses busy).

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
import type { RemoveWorktreeRequest } from '../../../application/ports/out/WorkspacePort.out-port.js';
import { WorkspaceAdapter } from '../WorkspaceAdapter.adapter.js';
import { LocalExecutor } from '../LocalExecutor.adapter.js';

const execFileAsync = promisify(execFile);

type RunCall = { argv: readonly string[]; options?: CommandRunOptions };

type CannedSpec =
  | Partial<CommandRunResult>
  | ((ctx: { callIndex: number; argv: readonly string[]; joined: string }) => Partial<CommandRunResult>);

/**
 * Recording fake executor. Canned results are matched by the first marker that
 * is a substring of the joined argv; unmatched runs default to exit 2 so an
 * unscripted argv is never a silent pass. A canned value may be a function of
 * the call index and argv, for commands that repeat with different answers
 * (the re-list after a removal, the post-removal existence probe vs the
 * in-progress probes, the physical-path questions, the two stat reads).
 */
function fakeExecutor(
  canned: Readonly<Record<string, CannedSpec>> = {},
): { executor: CommandExecutorPort; calls: RunCall[] } {
  const calls: RunCall[] = [];
  const markerCounts = new Map<string, number>();
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
        if (marker === undefined) {
          return { signal: null, stdout: '', stderr: '', exitCode: 2 };
        }
        const callIndex = markerCounts.get(marker) ?? 0;
        markerCounts.set(marker, callIndex + 1);
        const spec = canned[marker];
        const partial =
          typeof spec === 'function' ? spec({ callIndex, argv, joined }) : spec;
        return { signal: null, stdout: '', stderr: '', exitCode: 0, ...partial };
      },
    },
    calls,
  };
}

const CLONE = '/srv/fleet/clone';
const WORKTREE_ROOT = '/srv/fleet/worktrees';
const WORKTREE = `${WORKTREE_ROOT}/wt1`;
const LINKED_WORKTREE = '/elsewhere/wt1';
const BRANCH = 'fleet/run-01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OTHER_BRANCH = 'fleet/run-02ARZ3NDEKTSV4RRFFQ69G5FAV';
const HEAD = 'a'.repeat(40);

/** The caller-read activity baseline (KW2 `lastActivity.iso`). */
const ACTIVITY_ISO = '2026-11-06T00:00:00.000Z';

const RECORDED_HOST: AttemptRunnerRecord = {
  kind: 'opencode',
  remotePort: 4166,
  host: 'lane-host',
  hostName: 'lane-host',
  agent: 'ex',
  model: 'm',
  variant: null,
};

function makeRequest(overrides: Partial<RemoveWorktreeRequest> = {}): RemoveWorktreeRequest {
  return {
    repositoryRoot: CLONE,
    worktreeRoot: WORKTREE_ROOT,
    worktreePath: WORKTREE,
    expectedHead: HEAD,
    expectedBranch: BRANCH,
    expectedLastActivityIso: ACTIVITY_ISO,
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
const GIT_DIR_MARKER = 'rev-parse --git-dir';
const TEST_E_MARKER = 'test -e';
const HEAD_MARKER = 'rev-parse HEAD';
const REMOVE_MARKER = 'worktree remove';
const PWD_MARKER = 'pwd -P';
const REFLOG_MARKER = 'reflog show';
const FIND_MARKER = 'find';
const STAT_MARKER = 'stat -c %Y';
/** 2026-11-06T00:00:00Z, the epoch second of `ACTIVITY_ISO`. */
const ACTIVITY_EPOCH = 1793923200;
/** A stat answer with a sub-second part, older than `ACTIVITY_ISO`. */
const QUIET_STAT = '1700000000 2023-11-14 22:13:20.000000000 +0000\n';
const INDEX_MARKER = 'rev-parse --git-path index';

/**
 * The canned answers for a quiet activity re-read: the physical-path questions
 * answer with the path as given, and every activity read answers with an mtime
 * older than `ACTIVITY_ISO`, so the bounded-activity guard passes. The `find`
 * marker precedes `stat` so the tree-walk command (which embeds `stat -c %Y`)
 * matches the walk marker, not the stat marker.
 */
function quietActivityCanned(): Readonly<Record<string, CannedSpec>> {
  return {
    [PWD_MARKER]: ({ argv }) => ({ stdout: `${argv[argv.length - 1]}\n` }),
    [REFLOG_MARKER]: { stdout: 'HEAD@{2026-11-05T00:00:00+00:00}\n' },
    [FIND_MARKER]: { stdout: QUIET_STAT },
    [STAT_MARKER]: { stdout: QUIET_STAT },
    [INDEX_MARKER]: { stdout: `${WORKTREE}/.git/index\n` },
  };
}

async function removeWith(
  canned: Readonly<Record<string, CannedSpec>>,
  request: RemoveWorktreeRequest = makeRequest(),
): Promise<{ result: Awaited<ReturnType<WorkspaceAdapter['removeWorktree']>>; calls: RunCall[] }> {
  const { executor, calls } = fakeExecutor({
    [PWD_MARKER]: ({ argv }) => ({ stdout: `${argv[argv.length - 1]}\n` }),
    ...canned,
  });
  const adapter = new WorkspaceAdapter({ executorForRecordedHost: executorForRecordedHost(executor) });
  const result = await adapter.removeWorktree(request);
  return { result, calls };
}

describe('removeWorktree over a fake executor', () => {
  it('removes a clean listed worktree with the exact argv sequence and no branch command', async () => {
    const { result, calls } = await removeWith({
      [LIST_MARKER]: ({ callIndex }) =>
        callIndex === 0 ? { stdout: worktreeList() } : { stdout: listWithoutWorktree() },
      [HEAD_MARKER]: { stdout: `${HEAD}\n` },
      [STATUS_MARKER]: { stdout: '' },
      [GIT_DIR_MARKER]: { stdout: `${WORKTREE}/.git\n` },
      [TEST_E_MARKER]: { exitCode: 1 },
      ...quietActivityCanned(),
      [REMOVE_MARKER]: { exitCode: 0 },
    });
    expect(result).toEqual({ outcome: 'removed', branchTip: HEAD });
    expect(calls.map((call) => call.argv)).toEqual([
      ['git', '-C', CLONE, 'worktree', 'list', '--porcelain'],
      ['sh', '-c', 'cd -- "$1" && pwd -P', 'sh', CLONE],
      ['sh', '-c', 'cd -- "$1" && pwd -P', 'sh', WORKTREE_ROOT],
      ['sh', '-c', 'cd -- "$1" && pwd -P', 'sh', WORKTREE],
      ['git', '-C', WORKTREE, 'rev-parse', 'HEAD'],
      ['git', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', WORKTREE, 'status', '--porcelain', '--untracked-files=all'],
      ['git', '-C', WORKTREE, 'rev-parse', '--git-dir'],
      ['test', '-e', `${WORKTREE}/.git/rebase-merge`],
      ['test', '-e', `${WORKTREE}/.git/rebase-apply`],
      ['test', '-e', `${WORKTREE}/.git/MERGE_HEAD`],
      ['test', '-e', `${WORKTREE}/.git/CHERRY_PICK_HEAD`],
      ['test', '-e', `${WORKTREE}/.git/REVERT_HEAD`],
      ['test', '-e', `${WORKTREE}/.git/BISECT_LOG`],
      ['git', '-C', WORKTREE, 'reflog', 'show', '-1', '--date=iso-strict', '--format=%gD', 'HEAD'],
      ['stat', '-c', '%Y', WORKTREE],
      ['git', '-C', WORKTREE, 'rev-parse', '--git-path', 'index'],
      ['stat', '-c', '%Y %y', `${WORKTREE}/.git/index`],
      ['find', WORKTREE, '-name', '.git', '-prune', '-o', '-type', 'f', '-exec', 'stat', '-c', '%Y %y', '{}', '+'],
      ['git', '-C', CLONE, 'worktree', 'remove', WORKTREE],
      ['test', '-e', WORKTREE],
      ['git', '-C', CLONE, 'worktree', 'list', '--porcelain'],
    ]);
    const removeCalls = calls.filter((call) => call.argv.includes('remove'));
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0]?.argv).toEqual(['git', '-C', CLONE, 'worktree', 'remove', WORKTREE]);
    // No argv token is a banned git operation or flag; the in-progress probe
    // path `rebase-merge` is a file name, not a git command, so the check is
    // per token, never a substring of a path.
    const allArgvTokens = calls.flatMap((call) => [...call.argv]);
    for (const banned of ['--force', 'prune', 'branch', 'checkout', 'fetch', 'push', 'reset', 'clean', 'update-ref', 'merge', 'rm']) {
      expect(allArgvTokens).not.toContain(banned);
    }
  });

  it('refuses head-moved when the live HEAD differs from expectedHead and issues no remove', async () => {
    const { result, calls } = await removeWith({
      [LIST_MARKER]: { stdout: worktreeList() },
      [HEAD_MARKER]: { stdout: `${'b'.repeat(40)}\n` },
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'head-moved' });
    expect(calls.some((call) => call.argv.includes('remove'))).toBe(false);
  });

  it('refuses detached when the listed entry carries no branch', async () => {
    const detachedList = worktreeList().replace(`branch refs/heads/${BRANCH}\n`, 'detached\n');
    const { result, calls } = await removeWith({
      [LIST_MARKER]: { stdout: detachedList },
      [HEAD_MARKER]: { stdout: `${HEAD}\n` },
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'detached' });
    expect(calls.some((call) => call.argv.includes('remove'))).toBe(false);
  });

  it('refuses branch-mismatch when the branch is not the expected one', async () => {
    const { result, calls } = await removeWith({
      [LIST_MARKER]: { stdout: worktreeList().replace(BRANCH, OTHER_BRANCH) },
      [HEAD_MARKER]: { stdout: `${HEAD}\n` },
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'branch-mismatch' });
    expect(calls.some((call) => call.argv.includes('remove'))).toBe(false);
  });

  it('refuses dirty when the porcelain output names a changed path', async () => {
    const { result, calls } = await removeWith({
      [LIST_MARKER]: { stdout: worktreeList() },
      [HEAD_MARKER]: { stdout: `${HEAD}\n` },
      [STATUS_MARKER]: { stdout: ' M src/a.ts\n' },
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'dirty' });
    expect(calls.some((call) => call.argv.includes('remove'))).toBe(false);
  });

  it('refuses locked when the list carries the lock', async () => {
    const { result, calls } = await removeWith({
      [LIST_MARKER]: { stdout: `${worktreeList()}locked reason here\n` },
      [HEAD_MARKER]: { stdout: `${HEAD}\n` },
      [STATUS_MARKER]: { stdout: '' },
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'locked' });
    expect(calls.some((call) => call.argv.includes('remove'))).toBe(false);
  });

  it('refuses busy when an in-progress operation file is present', async () => {
    const { result, calls } = await removeWith({
      [LIST_MARKER]: { stdout: worktreeList() },
      [HEAD_MARKER]: { stdout: `${HEAD}\n` },
      [STATUS_MARKER]: { stdout: '' },
      [GIT_DIR_MARKER]: { stdout: `${WORKTREE}/.git\n` },
      [TEST_E_MARKER]: { exitCode: 0 },
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'busy' });
    expect(calls.some((call) => call.argv.includes('remove'))).toBe(false);
  });

  it('refuses not-a-linked-worktree when the list does not carry the path', async () => {
    const { result, calls } = await removeWith({
      [LIST_MARKER]: { stdout: listWithoutWorktree() },
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'not-a-linked-worktree' });
    expect(calls.some((call) => call.argv.includes('remove'))).toBe(false);
  });

  it('refuses path-refused for a path outside the worktree root, with no command run', async () => {
    const { result, calls } = await removeWith(
      {},
      makeRequest({ worktreePath: '/srv/fleet/elsewhere/wt1' }),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'path-refused' });
    expect(calls).toHaveLength(0);
  });

  it('refuses path-refused when a symlinked path resolves to a worktree outside the root', async () => {
    const list = worktreeList().replace(
      `worktree ${WORKTREE}\nHEAD ${HEAD}\nbranch refs/heads/${BRANCH}\n`,
      `worktree ${LINKED_WORKTREE}\nHEAD ${HEAD}\nbranch refs/heads/${BRANCH}\n`,
    );
    const { result, calls } = await removeWith(
      {
        [LIST_MARKER]: { stdout: list },
        [PWD_MARKER]: ({ argv }) => {
          const target = argv[argv.length - 1];
          if (target === `${WORKTREE_ROOT}/link`) {
            return { stdout: `${LINKED_WORKTREE}\n` };
          }
          return { stdout: `${target}\n` };
        },
      },
      makeRequest({ worktreePath: `${WORKTREE_ROOT}/link` }),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'path-refused' });
    expect(calls.some((call) => call.argv.includes('remove'))).toBe(false);
  });

  it.each([
    ['a malformed expectedHead', { expectedHead: 'not-a-sha' }],
    ['an all-zero expectedHead', { expectedHead: '0'.repeat(40) }],
    ['branch main', { expectedBranch: 'main' }],
    ['an empty expectedLastActivityIso', { expectedLastActivityIso: '' }],
    ['a non-timestamp expectedLastActivityIso', { expectedLastActivityIso: 'zz' }],
    ['a normalised calendar date in expectedLastActivityIso', { expectedLastActivityIso: '2026-11-31T00:00:00.000Z' }],
    ['a whole-second expectedLastActivityIso', { expectedLastActivityIso: '2026-11-06T00:00:00Z' }],
    ['a record without a host name', { recordedHost: { ...RECORDED_HOST, hostName: null } }],
  ])('refuses invalid-request for %s, with no command run', async (_label, overrides) => {
    const { result, calls } = await removeWith({}, makeRequest(overrides));
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(calls).toHaveLength(0);
  });

  it('answers unknown when the recorded host does not resolve and runs nothing', async () => {
    const { executor, calls } = fakeExecutor({});
    const adapter = new WorkspaceAdapter({ executorForRecordedHost: executorForRecordedHost(executor) });
    const result = await adapter.removeWorktree(
      makeRequest({ recordedHost: { ...RECORDED_HOST, hostName: 'gone-host' } }),
    );
    expect(result).toEqual({ outcome: 'unknown', reason: 'no executor for the recorded host' });
    expect(calls).toHaveLength(0);
  });

  it('answers unknown when the remove never reports an exit code', async () => {
    const { result } = await removeWith({
      [LIST_MARKER]: { stdout: worktreeList() },
      [HEAD_MARKER]: { stdout: `${HEAD}\n` },
      [STATUS_MARKER]: { stdout: '' },
      [GIT_DIR_MARKER]: { stdout: `${WORKTREE}/.git\n` },
      [TEST_E_MARKER]: { exitCode: 1 },
      ...quietActivityCanned(),
      [REMOVE_MARKER]: { exitCode: null, signal: 'SIGTERM' },
    });
    expect(result.outcome).toBe('unknown');
  });

  it('refuses git-refused when the remove exits non-zero', async () => {
    const { result } = await removeWith({
      [LIST_MARKER]: { stdout: worktreeList() },
      [HEAD_MARKER]: { stdout: `${HEAD}\n` },
      [STATUS_MARKER]: { stdout: '' },
      [GIT_DIR_MARKER]: { stdout: `${WORKTREE}/.git\n` },
      [TEST_E_MARKER]: { exitCode: 1 },
      ...quietActivityCanned(),
      [REMOVE_MARKER]: { exitCode: 128, stderr: 'fatal' },
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'git-refused' });
  });

  it('answers partial when the directory is still there after a successful remove', async () => {
    const { result } = await removeWith({
      [LIST_MARKER]: { stdout: worktreeList() },
      [HEAD_MARKER]: { stdout: `${HEAD}\n` },
      [STATUS_MARKER]: { stdout: '' },
      [GIT_DIR_MARKER]: { stdout: `${WORKTREE}/.git\n` },
      [TEST_E_MARKER]: ({ joined }) =>
        joined === `test -e ${WORKTREE}` ? { exitCode: 0 } : { exitCode: 1 },
      ...quietActivityCanned(),
      [REMOVE_MARKER]: { exitCode: 0 },
    });
    expect(result).toEqual({ outcome: 'partial', detail: 'directory-present' });
  });

  it('answers partial when git still lists the path after a successful remove', async () => {
    const { result } = await removeWith({
      [LIST_MARKER]: { stdout: worktreeList() },
      [HEAD_MARKER]: { stdout: `${HEAD}\n` },
      [STATUS_MARKER]: { stdout: '' },
      [GIT_DIR_MARKER]: { stdout: `${WORKTREE}/.git\n` },
      [TEST_E_MARKER]: { exitCode: 1 },
      ...quietActivityCanned(),
      [REMOVE_MARKER]: { exitCode: 0 },
    });
    expect(result).toEqual({ outcome: 'partial', detail: 'admin-entry-present' });
  });

  it('answers unknown when the existence probe never reports an exit code', async () => {
    const { result } = await removeWith({
      [LIST_MARKER]: { stdout: worktreeList() },
      [HEAD_MARKER]: { stdout: `${HEAD}\n` },
      [STATUS_MARKER]: { stdout: '' },
      [GIT_DIR_MARKER]: { stdout: `${WORKTREE}/.git\n` },
      [TEST_E_MARKER]: ({ joined }) =>
        joined === `test -e ${WORKTREE}` ? { exitCode: null } : { exitCode: 1 },
      ...quietActivityCanned(),
      [REMOVE_MARKER]: { exitCode: 0 },
    });
    expect(result.outcome).toBe('unknown');
  });

  it('answers unknown when the existence probe fails with an unexpected exit', async () => {
    const { result } = await removeWith({
      [LIST_MARKER]: { stdout: worktreeList() },
      [HEAD_MARKER]: { stdout: `${HEAD}\n` },
      [STATUS_MARKER]: { stdout: '' },
      [GIT_DIR_MARKER]: { stdout: `${WORKTREE}/.git\n` },
      [TEST_E_MARKER]: ({ joined }) =>
        joined === `test -e ${WORKTREE}` ? { exitCode: 127 } : { exitCode: 1 },
      ...quietActivityCanned(),
      [REMOVE_MARKER]: { exitCode: 0 },
    });
    expect(result.outcome).toBe('unknown');
  });

  it('answers unknown when the post-removal worktree list fails', async () => {
    const { result } = await removeWith({
      [LIST_MARKER]: ({ callIndex }) =>
        callIndex === 0 ? { stdout: worktreeList() } : { exitCode: 128 },
      [HEAD_MARKER]: { stdout: `${HEAD}\n` },
      [STATUS_MARKER]: { stdout: '' },
      [GIT_DIR_MARKER]: { stdout: `${WORKTREE}/.git\n` },
      [TEST_E_MARKER]: { exitCode: 1 },
      ...quietActivityCanned(),
      [REMOVE_MARKER]: { exitCode: 0 },
    });
    expect(result.outcome).toBe('unknown');
  });

  it('answers unknown when the post-removal worktree list cannot be parsed', async () => {
    const { result } = await removeWith({
      [LIST_MARKER]: ({ callIndex }) =>
        callIndex === 0 ? { stdout: worktreeList() } : { stdout: 'not porcelain' },
      [HEAD_MARKER]: { stdout: `${HEAD}\n` },
      [STATUS_MARKER]: { stdout: '' },
      [GIT_DIR_MARKER]: { stdout: `${WORKTREE}/.git\n` },
      [TEST_E_MARKER]: { exitCode: 1 },
      ...quietActivityCanned(),
      [REMOVE_MARKER]: { exitCode: 0 },
    });
    expect(result.outcome).toBe('unknown');
  });

  it('answers unknown when an in-progress operation probe exits with an unexpected status', async () => {
    const { result, calls } = await removeWith({
      [LIST_MARKER]: { stdout: worktreeList() },
      [HEAD_MARKER]: { stdout: `${HEAD}\n` },
      [STATUS_MARKER]: { stdout: '' },
      [GIT_DIR_MARKER]: { stdout: `${WORKTREE}/.git\n` },
      [TEST_E_MARKER]: { exitCode: 127 },
    });
    expect(result.outcome).toBe('unknown');
    expect(calls.some((call) => call.argv.includes('remove'))).toBe(false);
  });

  it('refuses busy for a write later in the same whole second as the caller-read baseline', async () => {
    const canned = (fraction: string): Record<string, CannedSpec> => ({
      [LIST_MARKER]: ({ callIndex }) =>
        callIndex === 0 ? { stdout: worktreeList() } : { stdout: listWithoutWorktree() },
      [HEAD_MARKER]: { stdout: `${HEAD}\n` },
      [STATUS_MARKER]: { stdout: '' },
      [GIT_DIR_MARKER]: { stdout: `${WORKTREE}/.git\n` },
      [TEST_E_MARKER]: { exitCode: 1 },
      [REMOVE_MARKER]: { exitCode: 0 },
      ...quietActivityCanned(),
      [FIND_MARKER]: { stdout: `${ACTIVITY_EPOCH} 2026-11-06 00:00:00.${fraction} +0000\n` },
    });
    const baseline = makeRequest({ expectedLastActivityIso: '2026-11-06T00:00:00.200Z' });
    const later = await removeWith(canned('600000000'), baseline);
    expect(later.result).toEqual({ outcome: 'refused', reason: 'busy' });
    expect(later.calls.some((call) => call.argv.includes('remove'))).toBe(false);
    const same = await removeWith(canned('200000000'), baseline);
    expect(same.result).toEqual({ outcome: 'removed', branchTip: HEAD });
  });

  it('refuses busy when the activity readings carry no sub-second part', async () => {
    const { result, calls } = await removeWith({
      [LIST_MARKER]: { stdout: worktreeList() },
      [HEAD_MARKER]: { stdout: `${HEAD}\n` },
      [STATUS_MARKER]: { stdout: '' },
      [GIT_DIR_MARKER]: { stdout: `${WORKTREE}/.git\n` },
      [TEST_E_MARKER]: { exitCode: 1 },
      ...quietActivityCanned(),
      [FIND_MARKER]: { stdout: '1700000000\n' },
      [REMOVE_MARKER]: { exitCode: 0 },
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'busy' });
    expect(calls.some((call) => call.argv.includes('remove'))).toBe(false);
  });

  it('refuses not-a-linked-worktree when the repository root cannot be resolved to a physical path', async () => {
    const { result, calls } = await removeWith({
      [LIST_MARKER]: { stdout: worktreeList() },
      [HEAD_MARKER]: { stdout: `${HEAD}\n` },
      [STATUS_MARKER]: { stdout: '' },
      [GIT_DIR_MARKER]: { stdout: `${WORKTREE}/.git\n` },
      [TEST_E_MARKER]: { exitCode: 1 },
      ...quietActivityCanned(),
      [PWD_MARKER]: ({ argv }) =>
        argv[argv.length - 1] === CLONE ? { exitCode: 1 } : { stdout: `${argv[argv.length - 1]}\n` },
      [REMOVE_MARKER]: { exitCode: 0 },
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'not-a-linked-worktree' });
    expect(calls.some((call) => call.argv.includes('remove'))).toBe(false);
  });

  it('refuses path-refused when the requested path now resolves outside the listed physical path', async () => {
    const { result, calls } = await removeWith({
      [LIST_MARKER]: { stdout: worktreeList() },
      [HEAD_MARKER]: { stdout: `${HEAD}\n` },
      [STATUS_MARKER]: { stdout: '' },
      [GIT_DIR_MARKER]: { stdout: `${WORKTREE}/.git\n` },
      [TEST_E_MARKER]: { exitCode: 1 },
      ...quietActivityCanned(),
      [PWD_MARKER]: ({ argv }) =>
        argv[argv.length - 1] === WORKTREE ? { stdout: '/elsewhere/other-worktree\n' } : { stdout: `${argv[argv.length - 1]}\n` },
      [REMOVE_MARKER]: { exitCode: 0 },
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'path-refused' });
    expect(calls.some((call) => call.argv.includes('remove'))).toBe(false);
  });

  it('refuses path-refused when the requested path is a symlink to a listed worktree inside the root', async () => {
    const { result, calls } = await removeWith({
      [LIST_MARKER]: { stdout: worktreeList().replace(WORKTREE, `${WORKTREE_ROOT}/real-wt`) },
      [HEAD_MARKER]: { stdout: `${HEAD}\n` },
      [STATUS_MARKER]: { stdout: '' },
      [GIT_DIR_MARKER]: { stdout: `${WORKTREE}/.git\n` },
      [TEST_E_MARKER]: { exitCode: 1 },
      ...quietActivityCanned(),
      [PWD_MARKER]: ({ argv }) =>
        argv[argv.length - 1] === WORKTREE
          ? { stdout: `${WORKTREE_ROOT}/real-wt\n` }
          : { stdout: `${argv[argv.length - 1]}\n` },
      [REMOVE_MARKER]: { exitCode: 0 },
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'path-refused' });
    expect(calls.some((call) => call.argv.includes('remove'))).toBe(false);
  });

  it('answers unknown when the worktree root cannot be resolved to a physical path', async () => {
    const { result, calls } = await removeWith({
      [LIST_MARKER]: ({ callIndex }) =>
        callIndex === 0 ? { stdout: worktreeList() } : { stdout: listWithoutWorktree() },
      [HEAD_MARKER]: { stdout: `${HEAD}\n` },
      [STATUS_MARKER]: { stdout: '' },
      [GIT_DIR_MARKER]: { stdout: `${WORKTREE}/.git\n` },
      [TEST_E_MARKER]: { exitCode: 1 },
      ...quietActivityCanned(),
      [PWD_MARKER]: ({ argv }) =>
        argv[argv.length - 1] === WORKTREE_ROOT ? { exitCode: 1 } : { stdout: `${argv[argv.length - 1]}\n` },
      [REMOVE_MARKER]: { exitCode: 0 },
    });
    expect(result.outcome).toBe('unknown');
    expect(calls.some((call) => call.argv.includes('remove'))).toBe(false);
  });

  it('refuses busy when the newest activity moved past the caller-read baseline', async () => {
    const { result, calls } = await removeWith({
      [LIST_MARKER]: { stdout: worktreeList() },
      [HEAD_MARKER]: { stdout: `${HEAD}\n` },
      [STATUS_MARKER]: { stdout: '' },
      [GIT_DIR_MARKER]: { stdout: `${WORKTREE}/.git\n` },
      [TEST_E_MARKER]: { exitCode: 1 },
      [REFLOG_MARKER]: { stdout: 'HEAD@{2026-11-05T00:00:00+00:00}\n' },
      [FIND_MARKER]: { stdout: '1900000000\n' },
      [STAT_MARKER]: { stdout: '1700000000\n' },
      [INDEX_MARKER]: { stdout: `${WORKTREE}/.git/index\n` },
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'busy' });
    expect(calls.some((call) => call.argv.includes('remove'))).toBe(false);
  });

  it('refuses busy when the bounded activity walk cannot answer', async () => {
    const { result, calls } = await removeWith({
      [LIST_MARKER]: { stdout: worktreeList() },
      [HEAD_MARKER]: { stdout: `${HEAD}\n` },
      [STATUS_MARKER]: { stdout: '' },
      [GIT_DIR_MARKER]: { stdout: `${WORKTREE}/.git\n` },
      [TEST_E_MARKER]: { exitCode: 1 },
      [REFLOG_MARKER]: { stdout: 'HEAD@{2026-11-05T00:00:00+00:00}\n' },
      [FIND_MARKER]: { exitCode: 128 },
      [STAT_MARKER]: { stdout: '1700000000\n' },
      [INDEX_MARKER]: { stdout: `${WORKTREE}/.git/index\n` },
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'busy' });
    expect(calls.some((call) => call.argv.includes('remove'))).toBe(false);
  });

  it('refuses busy when no activity baseline was read under the hold', async () => {
    const { result, calls } = await removeWith(
      {
        [LIST_MARKER]: { stdout: worktreeList() },
        [HEAD_MARKER]: { stdout: `${HEAD}\n` },
        [STATUS_MARKER]: { stdout: '' },
        [GIT_DIR_MARKER]: { stdout: `${WORKTREE}/.git\n` },
        [TEST_E_MARKER]: { exitCode: 1 },
        ...quietActivityCanned(),
      },
      makeRequest({ expectedLastActivityIso: null }),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'busy' });
    expect(calls.some((call) => call.argv.includes('remove'))).toBe(false);
  });
});

describe('removeWorktree against real git', () => {
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
    physicalWorktreePath: string;
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
      physicalWorktreePath: await fs.realpath(worktreePath),
      branch,
      head: head.trim(),
      adapter,
    };
  }

  /** The activity baseline a caller reads under its hold (KW2 `lastActivity.iso`). */
  async function lastActivityIso(
    s: Awaited<ReturnType<typeof setup>>,
  ): Promise<string | null> {
    const inspected = await s.adapter.inspectWorktreeForRemoval({
      repositoryRoot: s.clonePath,
      worktreePath: s.worktreePath,
      defaultRef: 'origin/main',
      recordedHost: RECORDED_HOST,
    });
    if (inspected.outcome !== 'inspected') {
      throw new Error(`inspect for the activity baseline failed: ${inspected.outcome}`);
    }
    return inspected.facts.lastActivity.iso;
  }

  async function removeWorktree(
    s: Awaited<ReturnType<typeof setup>>,
    overrides: Partial<RemoveWorktreeRequest> = {},
  ): Promise<Awaited<ReturnType<WorkspaceAdapter['removeWorktree']>>> {
    return s.adapter.removeWorktree(
      makeRequest({
        repositoryRoot: s.clonePath,
        worktreeRoot: s.worktreeRoot,
        worktreePath: s.worktreePath,
        expectedHead: s.head,
        expectedBranch: s.branch,
        expectedLastActivityIso: await lastActivityIso(s),
        ...overrides,
      }),
    );
  }

  async function cloneState(clonePath: string): Promise<{ listed: string; head: string; status: string }> {
    const listed = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: clonePath });
    const head = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: clonePath });
    const status = await execFileAsync('git', ['status', '--porcelain'], { cwd: clonePath });
    return { listed: listed.stdout, head: head.stdout.trim(), status: status.stdout };
  }

  it('removes a clean worktree, keeps the branch and leaves the clone unchanged', async () => {
    const s = await setup();
    const before = await cloneState(s.clonePath);
    const result = await removeWorktree(s);
    expect(result).toEqual({ outcome: 'removed', branchTip: s.head });
    const after = await cloneState(s.clonePath);
    // git lists the physical path; compare against it so a symlinked TMPDIR cannot make this vacuous.
    expect(before.listed).toContain(s.physicalWorktreePath);
    expect(after.listed).not.toContain(s.physicalWorktreePath);
    await expect(
      execFileAsync('git', ['rev-parse', '--verify', `refs/heads/${s.branch}`], { cwd: s.clonePath }),
    ).resolves.toBeTruthy();
    expect(after.head).toBe(before.head);
    expect(after.status).toBe(before.status);
  });

  it('refuses head-moved for a moved HEAD and keeps the worktree listed', async () => {
    const s = await setup();
    const gitInWorktree = (args: readonly string[]) =>
      execFileAsync(
        'git',
        ['-c', 'user.name=Fleet Test', '-c', 'user.email=fleet-test@example.invalid', ...args],
        { cwd: s.worktreePath },
      );
    await fs.writeFile(path.join(s.worktreePath, 'new.txt'), 'new\n', 'utf8');
    await gitInWorktree(['add', '.']);
    await gitInWorktree(['commit', '-m', 'move head']);
    const result = await removeWorktree(s);
    expect(result).toEqual({ outcome: 'refused', reason: 'head-moved' });
    const listed = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: s.clonePath });
    expect(listed.stdout).toContain(s.physicalWorktreePath);
  });

  it('refuses dirty for a file written after the read and keeps the worktree listed', async () => {
    const s = await setup();
    await fs.writeFile(path.join(s.worktreePath, 'untracked.txt'), 'x\n', 'utf8');
    const result = await removeWorktree(s);
    expect(result).toEqual({ outcome: 'refused', reason: 'dirty' });
    const listed = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: s.clonePath });
    expect(listed.stdout).toContain(s.physicalWorktreePath);
  });

  it('refuses locked for a locked worktree and keeps the worktree listed', async () => {
    const s = await setup();
    await execFileAsync('git', ['worktree', 'lock', s.worktreePath], { cwd: s.clonePath });
    const result = await removeWorktree(s);
    expect(result).toEqual({ outcome: 'refused', reason: 'locked' });
    const listed = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: s.clonePath });
    expect(listed.stdout).toContain(s.physicalWorktreePath);
  });

  it('refuses busy for an operation in progress and keeps the worktree listed', async () => {
    const s = await setup();
    const rawGitDir = (await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd: s.worktreePath })).stdout.trim();
    const gitDir = rawGitDir.startsWith('/') ? rawGitDir : path.join(s.worktreePath, rawGitDir);
    await fs.writeFile(path.join(gitDir, 'MERGE_HEAD'), 'x\n', 'utf8');
    const result = await removeWorktree(s);
    expect(result).toEqual({ outcome: 'refused', reason: 'busy' });
    const listed = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: s.clonePath });
    expect(listed.stdout).toContain(s.physicalWorktreePath);
  });

  it('refuses busy for an ignored file written after the read and keeps the worktree listed', async () => {
    const s = await setup();
    // Ignore a name through the clone's exclude file so the porcelain status
    // stays clean: only the bounded-activity re-check can see this write.
    await fs.appendFile(path.join(s.clonePath, '.git', 'info', 'exclude'), '\nignored-activity.txt\n', 'utf8');
    const baseline = await lastActivityIso(s);
    const ignored = path.join(s.worktreePath, 'ignored-activity.txt');
    await fs.writeFile(ignored, 'x\n', 'utf8');
    // Force a distinctly newer mtime than the baseline read, so the walk's
    // second resolution cannot make the comparison vacuous.
    await fs.utimes(ignored, new Date('2030-01-01T00:00:00Z'), new Date('2030-01-01T00:00:00Z'));
    const result = await s.adapter.removeWorktree(
      makeRequest({
        repositoryRoot: s.clonePath,
        worktreeRoot: s.worktreeRoot,
        worktreePath: s.worktreePath,
        expectedHead: s.head,
        expectedBranch: s.branch,
        expectedLastActivityIso: baseline,
      }),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'busy' });
    const listed = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: s.clonePath });
    expect(listed.stdout).toContain(s.physicalWorktreePath);
  });

  it('refuses busy for an ignored-file write in the same whole second as the baseline and keeps the worktree listed', async () => {
    const s = await setup();
    await fs.appendFile(path.join(s.clonePath, '.git', 'info', 'exclude'), '\nignored-activity.txt\n', 'utf8');
    const ignored = path.join(s.worktreePath, 'ignored-activity.txt');
    await fs.writeFile(ignored, 'x\n', 'utf8');
    // The ignored file is the newest activity at a controlled sub-second time.
    const first = new Date('2030-01-01T00:00:00.125Z');
    await fs.utimes(ignored, first, first);
    const baseline = await lastActivityIso(s);
    expect(baseline).toBe('2030-01-01T00:00:00.125Z');
    // A later write inside the same whole second: whole-second mtimes cannot tell it apart.
    const second = new Date('2030-01-01T00:00:00.750Z');
    await fs.utimes(ignored, second, second);
    const result = await removeWorktree(s, { expectedLastActivityIso: baseline });
    expect(result).toEqual({ outcome: 'refused', reason: 'busy' });
    const listed = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: s.clonePath });
    expect(listed.stdout).toContain(s.physicalWorktreePath);
  });

  it('refuses not-a-linked-worktree for a plain directory and leaves it untouched', async () => {
    const s = await setup();
    const plainDir = path.join(s.worktreeRoot, 'plain');
    await fs.mkdir(plainDir);
    await fs.writeFile(path.join(plainDir, 'keep.txt'), 'keep\n', 'utf8');
    const result = await s.adapter.removeWorktree(
      makeRequest({
        repositoryRoot: s.clonePath,
        worktreeRoot: s.worktreeRoot,
        worktreePath: plainDir,
        expectedHead: s.head,
        expectedBranch: s.branch,
        expectedLastActivityIso: null,
      }),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'not-a-linked-worktree' });
    const kept = await fs.readFile(path.join(plainDir, 'keep.txt'), 'utf8');
    expect(kept).toBe('keep\n');
  });
});
