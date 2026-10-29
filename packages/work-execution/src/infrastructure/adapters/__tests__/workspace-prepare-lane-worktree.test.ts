import { describe, expect, it } from 'vitest';

import {
  WorkspaceAdapter,
  prepareLaneWorktreeRequestIsValid,
} from '../WorkspaceAdapter.adapter.js';
import type { CommandExecutorPort } from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import type { CommandRunResult } from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import type { AttemptRunnerRecord } from '../../../domain/execution-records.js';
import type { PrepareLaneWorktreeRequest } from '../../../application/ports/out/WorkspacePort.out-port.js';

import { physicalPathArgv } from '../ResolvePhysicalPath.helper.js';

const BASE = 'a'.repeat(40);
const CLONE = '/tmp/fleet-example-clone';
const WORKTREE = '/tmp/fleet-example-worktrees/0123abcdef0123abcdef0123abcdef01';
const BRANCH = 'fleet/run-01JB0000000000000000000000';
const HOST = 'lane-host-example';

const RECORDED_HOST: AttemptRunnerRecord = {
  kind: 'opencode',
  remotePort: 4097,
  host: null,
  hostName: HOST,
  agent: null,
  model: null,
  variant: null,
};

const defaultRequest: PrepareLaneWorktreeRequest = {
  clonePath: CLONE,
  worktreePath: WORKTREE,
  branch: BRANCH,
  baseCommit: BASE,
  recordedHost: RECORDED_HOST,
};

const ADD_ARGV = [
  'git', '-C', CLONE, '-c', 'core.hooksPath=/dev/null',
  'worktree', 'add', '-b', BRANCH, WORKTREE, BASE,
];
const PATH_PROBE_ARGV = ['test', '-e', WORKTREE];
const BRANCH_PROBE_ARGV = ['git', '-C', CLONE, 'rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`];
const HEAD_ARGV = ['git', '-C', WORKTREE, 'rev-parse', '--show-toplevel', 'HEAD', '--abbrev-ref', 'HEAD'];
const STATUS_ARGV = ['git', '-C', WORKTREE, 'status', '--porcelain', '--untracked-files=all'];
const LIST_ARGV = ['git', '-C', CLONE, 'worktree', 'list', '--porcelain'];

const ok: (stdout?: string) => CommandRunResult = (stdout = '') => ({
  exitCode: 0, signal: null, stdout, stderr: '',
});
const failed: (exitCode: number) => CommandRunResult = (exitCode) => ({
  exitCode, signal: null, stdout: '', stderr: 'git refused',
});

/**
 * Two fake executors, one per configured host, each recording every argv.
 * The adapter routes the recorded host to `reserved` and every other host
 * to `other`, so the tests can prove the other host was never called.
 */
function twoHostExecutors(answers: Record<string, CommandRunResult>) {
  const reservedLog: string[][] = [];
  const otherLog: string[][] = [];
  const makeExecutor = (log: string[][]) => ({
    async run(argv: readonly string[]) {
      log.push([...argv]);
      return answers[argv.join(' ')] ?? failed(1);
    },
  });
  const reserved = makeExecutor(reservedLog) as CommandExecutorPort;
  const other = makeExecutor(otherLog) as CommandExecutorPort;
  const adapter = new WorkspaceAdapter({
    executorForRecordedHost: (recorded) =>
      recorded?.hostName === HOST
        ? { ok: true, executor: reserved }
        : { ok: true, executor: other },
  });
  return { adapter, reservedLog, otherLog };
}

/** Answers of a fresh path with a free branch: the create succeeds. */
const freshPathAnswers: Record<string, CommandRunResult> = {
  [PATH_PROBE_ARGV.join(' ')]: failed(1),
  [BRANCH_PROBE_ARGV.join(' ')]: failed(1),
  [ADD_ARGV.join(' ')]: ok(),
};

/** The read answers of a worktree exactly what a prior start would have made. */
function preparedAnswers(branch: string, statusStdout: string): Record<string, CommandRunResult> {
  return {
    [PATH_PROBE_ARGV.join(' ')]: ok(),
    // The order real git prints for HEAD_ARGV (checked against git 2.x): toplevel, commit, branch.
    [HEAD_ARGV.join(' ')]: ok(WORKTREE + '\n' + BASE + '\n' + branch + '\n'),
    [STATUS_ARGV.join(' ')]: ok(statusStdout),
    [LIST_ARGV.join(' ')]: ok('worktree ' + CLONE + '\n\nworktree ' + WORKTREE + '\n'),
  };
}

describe('prepareLaneWorktreeRequestIsValid', () => {
  it('accepts the canonical request shape', () => {
    expect(prepareLaneWorktreeRequestIsValid(defaultRequest)).toBe(true);
  });
});

describe('WorkspaceAdapter prepareLaneWorktree', () => {
  it('creates the worktree in one worktree add call on the reserved host only', async () => {
    const { adapter, reservedLog, otherLog } = twoHostExecutors(freshPathAnswers);
    const result = await adapter.prepareLaneWorktree!(defaultRequest);
    expect(result).toEqual({ outcome: 'prepared' });
    expect(reservedLog).toEqual([PATH_PROBE_ARGV, BRANCH_PROBE_ARGV, ADD_ARGV]);
    expect(reservedLog[2]).toContain('-c');
    expect(reservedLog[2]).toContain('core.hooksPath=/dev/null');
    expect(reservedLog[2]).not.toContain('--force');
    expect(otherLog).toEqual([]);
  });

  it('reads an already prepared worktree as already-prepared without adding', async () => {
    const { adapter, reservedLog } = twoHostExecutors(preparedAnswers(BRANCH, ''));
    const result = await adapter.prepareLaneWorktree!(defaultRequest);
    expect(result).toEqual({ outcome: 'already-prepared' });
    expect(reservedLog.some((argv) => argv.includes('add'))).toBe(false);
  });

  it('reads a symlinked worktree as already-prepared when toplevel and the list entry are its physical path', async () => {
    const PHYSICAL = '/private' + WORKTREE;
    const answers: Record<string, CommandRunResult> = {
      ...preparedAnswers(BRANCH, ''),
      [physicalPathArgv(WORKTREE).join(' ')]: ok(`${PHYSICAL}\n`),
    };
    answers[HEAD_ARGV.join(' ')] = ok(`${PHYSICAL}\n${BASE}\n${BRANCH}\n`);
    answers[LIST_ARGV.join(' ')] = ok(`worktree ${CLONE}\n\nworktree ${PHYSICAL}\n`);
    const { adapter, reservedLog } = twoHostExecutors(answers);
    const result = await adapter.prepareLaneWorktree!(defaultRequest);
    expect(result).toEqual({ outcome: 'already-prepared' });
    expect(reservedLog).toContainEqual(physicalPathArgv(WORKTREE));
    expect(reservedLog.some((argv) => argv.includes('add'))).toBe(false);
  });

  it('refuses an existing path on another branch', async () => {
    const otherBranch = 'fleet/run-01JC000000000000000000000J';
    const { adapter } = twoHostExecutors(preparedAnswers(otherBranch, ''));
    const result = await adapter.prepareLaneWorktree!(defaultRequest);
    expect(result).toEqual({ outcome: 'refused', reason: 'path-exists-other' });
  });

  it('refuses an existing matching worktree holding an untracked file', async () => {
    const { adapter } = twoHostExecutors(preparedAnswers(BRANCH, '?? .lane/notes.md\n'));
    const result = await adapter.prepareLaneWorktree!(defaultRequest);
    expect(result).toEqual({ outcome: 'refused', reason: 'path-exists-other' });
  });

  it('refuses when the branch already exists elsewhere', async () => {
    const answers: Record<string, CommandRunResult> = {
      [PATH_PROBE_ARGV.join(' ')]: failed(1),
      [BRANCH_PROBE_ARGV.join(' ')]: ok(BASE + '\n'),
    };
    const { adapter, reservedLog } = twoHostExecutors(answers);
    const result = await adapter.prepareLaneWorktree!(defaultRequest);
    expect(result).toEqual({ outcome: 'refused', reason: 'branch-exists-other' });
    expect(reservedLog.some((argv) => argv.includes('add'))).toBe(false);
  });

  it('refuses when worktree add exits 128, and reads a thrown timeout as unknown', async () => {
    const refusedAnswers: Record<string, CommandRunResult> = {
      ...freshPathAnswers,
      [ADD_ARGV.join(' ')]: failed(128),
    };
    const refusedResult = await twoHostExecutors(refusedAnswers).adapter
      .prepareLaneWorktree!(defaultRequest);
    expect(refusedResult).toEqual({ outcome: 'refused', reason: 'git-refused' });

    const unknownExecutor: CommandExecutorPort = {
      async run() {
        throw new Error('timed out');
      },
    };
    const unknownAdapter = new WorkspaceAdapter({
      executorForRecordedHost: () => ({ ok: true, executor: unknownExecutor }),
    });
    const unknownResult = await unknownAdapter.prepareLaneWorktree!(defaultRequest);
    expect(unknownResult).toEqual({ outcome: 'unknown' });
  });

  it('refuses invalid requests before any executor call, naming no path', async () => {
    const invalidRequests: readonly PrepareLaneWorktreeRequest[] = [
      { ...defaultRequest, clonePath: 'relative/clone' },
      { ...defaultRequest, worktreePath: CLONE + '/../elsewhere' },
      { ...defaultRequest, worktreePath: CLONE + '/nested-worktree' },
      { ...defaultRequest, branch: 'main' },
      { ...defaultRequest, baseCommit: 'abc123' },
    ];
    for (const request of invalidRequests) {
      const { adapter, reservedLog, otherLog } = twoHostExecutors(freshPathAnswers);
      const result = await adapter.prepareLaneWorktree!(request);
      expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
      expect(reservedLog).toEqual([]);
      expect(otherLog).toEqual([]);
      const printed = JSON.stringify(result);
      expect(printed.includes(request.clonePath)).toBe(false);
      expect(printed.includes(request.worktreePath)).toBe(false);
    }
  });
});
