import { describe, expect, it } from 'vitest';

import {
  WorkspaceAdapter,
  prepareLaneWorktreeRequestIsValid,
} from '../WorkspaceAdapter.adapter.js';
import type { CommandExecutorPort } from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import type { CommandRunResult } from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import type { AttemptRunnerRecord } from '../../../domain/execution-records.js';
import type { PrepareLaneWorktreeRequest, ResolveBaseTipRequest } from '../../../application/ports/out/WorkspacePort.out-port.js';

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
const CAT_FILE_ARGV = ['git', '-C', CLONE, 'cat-file', '-e', BASE + '^{commit}'];
const FETCH_ARGV = [
  'git', '-C', CLONE, '-c', 'core.hooksPath=/dev/null',
  'fetch', '--quiet', 'origin',
];
const LS_REMOTE_CHAIN_ARGV = [
  'git', '-C', CLONE, '-c', 'core.hooksPath=/dev/null',
  'ls-remote', '--exit-code', 'origin', 'refs/heads/chain/example',
];
const LS_REMOTE_MAIN_ARGV = [
  'git', '-C', CLONE, '-c', 'core.hooksPath=/dev/null',
  'ls-remote', '--exit-code', 'origin', 'refs/heads/main',
];

function resolveBaseTipRequest(overrides: Partial<ResolveBaseTipRequest> = {}): ResolveBaseTipRequest {
  return {
    clonePath: CLONE,
    baseBranch: 'chain/example',
    recordedHost: RECORDED_HOST,
    ...overrides,
  };
}

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
 * An answer may be a sequence (array) to serve repeated identical argv, as
 * when the base-commit probe runs again after a fetch.
 */
function twoHostExecutors(answers: Record<string, CommandRunResult | CommandRunResult[]>) {
  const reservedLog: string[][] = [];
  const otherLog: string[][] = [];
  const makeExecutor = (log: string[][]) => ({
    async run(argv: readonly string[]) {
      log.push([...argv]);
      const entry = answers[argv.join(' ')];
      if (Array.isArray(entry)) {
        const next = entry.shift();
        return next ?? failed(1);
      }
      return entry ?? failed(1);
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
  [CAT_FILE_ARGV.join(' ')]: ok(),
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
    expect(reservedLog).toEqual([PATH_PROBE_ARGV, BRANCH_PROBE_ARGV, CAT_FILE_ARGV, ADD_ARGV]);
    expect(reservedLog[3]).toContain('-c');
    expect(reservedLog[3]).toContain('core.hooksPath=/dev/null');
    expect(reservedLog[3]).not.toContain('--force');
    expect(otherLog).toEqual([]);
  });

  it('does not fetch when the base commit is already present, and adds the worktree', async () => {
    const { adapter, reservedLog } = twoHostExecutors(freshPathAnswers);
    const result = await adapter.prepareLaneWorktree!(defaultRequest);
    expect(result).toEqual({ outcome: 'prepared' });
    expect(reservedLog.some((argv) => argv.includes('fetch'))).toBe(false);
    expect(reservedLog).toContainEqual(CAT_FILE_ARGV);
    expect(reservedLog).toContainEqual(ADD_ARGV);
  });

  it('fetches origin when the base commit is missing, then adds the worktree', async () => {
    const answers: Record<string, CommandRunResult | CommandRunResult[]> = {
      [PATH_PROBE_ARGV.join(' ')]: failed(1),
      [BRANCH_PROBE_ARGV.join(' ')]: failed(1),
      [CAT_FILE_ARGV.join(' ')]: [failed(1), ok()],
      [FETCH_ARGV.join(' ')]: ok(),
      [ADD_ARGV.join(' ')]: ok(),
    };
    const { adapter, reservedLog } = twoHostExecutors(answers);
    const result = await adapter.prepareLaneWorktree!(defaultRequest);
    expect(result).toEqual({ outcome: 'prepared' });
    expect(reservedLog).toEqual([
      PATH_PROBE_ARGV,
      BRANCH_PROBE_ARGV,
      CAT_FILE_ARGV,
      FETCH_ARGV,
      CAT_FILE_ARGV,
      ADD_ARGV,
    ]);
    // The fetch is exactly the hardened default-remote fetch — never a
    // caller-supplied ref or the base commit.
    const fetchIndex = reservedLog.findIndex((argv) => argv.includes('fetch'));
    expect(fetchIndex).toBeGreaterThan(-1);
    expect(reservedLog[fetchIndex]).toEqual(FETCH_ARGV);
    expect(reservedLog[fetchIndex]).not.toContain(BASE);
  });

  it('refuses git-refused when the base is still missing after the fetch, without adding', async () => {
    const answers: Record<string, CommandRunResult> = {
      [PATH_PROBE_ARGV.join(' ')]: failed(1),
      [BRANCH_PROBE_ARGV.join(' ')]: failed(1),
      [CAT_FILE_ARGV.join(' ')]: failed(1),
      [FETCH_ARGV.join(' ')]: ok(),
    };
    const { adapter, reservedLog } = twoHostExecutors(answers);
    const result = await adapter.prepareLaneWorktree!(defaultRequest);
    expect(result).toEqual({ outcome: 'refused', reason: 'git-refused' });
    expect(reservedLog.some((argv) => argv.includes('add'))).toBe(false);
  });

  it('reads a hanging fetch as unknown without adding', async () => {
    const hanging: CommandRunResult = { exitCode: null, signal: null, stdout: '', stderr: '' };
    const answers: Record<string, CommandRunResult> = {
      [PATH_PROBE_ARGV.join(' ')]: failed(1),
      [BRANCH_PROBE_ARGV.join(' ')]: failed(1),
      [CAT_FILE_ARGV.join(' ')]: failed(1),
      [FETCH_ARGV.join(' ')]: hanging,
    };
    const { adapter, reservedLog } = twoHostExecutors(answers);
    const result = await adapter.prepareLaneWorktree!(defaultRequest);
    expect(result).toEqual({ outcome: 'unknown' });
    expect(reservedLog.some((argv) => argv.includes('add'))).toBe(false);
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

describe('WorkspaceAdapter resolveBaseTip', () => {
  it('resolves chain/example on the reserved host only, never fetching', async () => {
    const tip = 'b'.repeat(40);
    const answers = {
      [LS_REMOTE_CHAIN_ARGV.join(' ')]: ok(tip + '\trefs/heads/chain/example\n'),
    };
    const { adapter, reservedLog, otherLog } = twoHostExecutors(answers);
    const result = await adapter.resolveBaseTip!(resolveBaseTipRequest());
    expect(result).toEqual({ outcome: 'resolved', tip });
    expect(reservedLog).toEqual([LS_REMOTE_CHAIN_ARGV]);
    expect(otherLog).toEqual([]);
    expect(reservedLog.some((argv) => argv.includes('fetch'))).toBe(false);
  });

  it('returns missing on exit 2 (the branch does not exist on the forge)', async () => {
    const answers = { [LS_REMOTE_CHAIN_ARGV.join(' ')]: failed(2) };
    const { adapter, reservedLog } = twoHostExecutors(answers);
    const result = await adapter.resolveBaseTip!(resolveBaseTipRequest());
    expect(result).toEqual({ outcome: 'missing' });
    expect(reservedLog).toEqual([LS_REMOTE_CHAIN_ARGV]);
  });

  it('returns the 40-hex tip of a single good main line', async () => {
    const tip = 'b'.repeat(40);
    const answers = {
      [LS_REMOTE_MAIN_ARGV.join(' ')]: ok(tip + '\trefs/heads/main\n'),
    };
    const { adapter } = twoHostExecutors(answers);
    const result = await adapter.resolveBaseTip!(resolveBaseTipRequest({ baseBranch: 'main' }));
    expect(result).toEqual({ outcome: 'resolved', tip });
  });

  it('returns unknown on a 64-hex line', async () => {
    const answers = {
      [LS_REMOTE_CHAIN_ARGV.join(' ')]: ok('c'.repeat(64) + '\trefs/heads/chain/example\n'),
    };
    const { adapter } = twoHostExecutors(answers);
    const result = await adapter.resolveBaseTip!(resolveBaseTipRequest());
    expect(result).toEqual({ outcome: 'unknown' });
  });

  it('returns unknown on two lines', async () => {
    const answers = {
      [LS_REMOTE_CHAIN_ARGV.join(' ')]: ok(
        'a'.repeat(40) + '\trefs/heads/chain/example\n' + 'b'.repeat(40) + '\trefs/heads/chain/example\n',
      ),
    };
    const { adapter } = twoHostExecutors(answers);
    const result = await adapter.resolveBaseTip!(resolveBaseTipRequest());
    expect(result).toEqual({ outcome: 'unknown' });
  });

  it('returns unknown on exit 128', async () => {
    const answers = { [LS_REMOTE_CHAIN_ARGV.join(' ')]: failed(128) };
    const { adapter } = twoHostExecutors(answers);
    const result = await adapter.resolveBaseTip!(resolveBaseTipRequest());
    expect(result).toEqual({ outcome: 'unknown' });
  });

  it('returns unknown on a null exit and on a thrown timeout', async () => {
    const hanging: CommandRunResult = { exitCode: null, signal: null, stdout: '', stderr: '' };
    const answers = { [LS_REMOTE_CHAIN_ARGV.join(' ')]: hanging };
    const hangingResult = await twoHostExecutors(answers).adapter.resolveBaseTip!(resolveBaseTipRequest());
    expect(hangingResult).toEqual({ outcome: 'unknown' });

    const throwingExecutor: CommandExecutorPort = {
      async run() {
        throw new Error('timed out');
      },
    };
    const throwingAdapter = new WorkspaceAdapter({
      executorForRecordedHost: () => ({ ok: true, executor: throwingExecutor }),
    });
    const throwingResult = await throwingAdapter.resolveBaseTip!(resolveBaseTipRequest());
    expect(throwingResult).toEqual({ outcome: 'unknown' });
  });

  it('refuses a relative clonePath before any executor call', async () => {
    const { adapter, reservedLog, otherLog } = twoHostExecutors(freshPathAnswers);
    const result = await adapter.resolveBaseTip!(resolveBaseTipRequest({ clonePath: 'relative/clone' }));
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(reservedLog).toEqual([]);
    expect(otherLog).toEqual([]);
  });
});
