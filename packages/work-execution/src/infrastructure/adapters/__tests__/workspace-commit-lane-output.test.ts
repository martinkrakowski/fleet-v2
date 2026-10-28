import { describe, expect, it } from 'vitest';

import {
  WorkspaceAdapter,
  editOnlyCommitMessage,
} from '../WorkspaceAdapter.adapter.js';
import type { CommandExecutorPort } from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import type { CommandRunResult } from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import type { AttemptRunnerRecord } from '../../../domain/execution-records.js';
import type { CommitLaneOutputRequest } from '../../../application/ports/out/WorkspacePort.out-port.js';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const NEW = 'c'.repeat(40);
const PARENT_D = 'd'.repeat(40);
const TREE_1 = '1'.repeat(40);
const TREE_2 = '2'.repeat(40);
const WORKTREE = '/tmp/fleet-example-worktree';
const BRANCH = 'refs/heads/lane-example';

const COMMIT_CONFIG = [
  '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'core.fsmonitor=false',
];

const DEFAULT_ATTEMPT = 'attempt-example-1';
const DEFAULT_MODEL = 'gemini-example-high';

const defaultRequest: CommitLaneOutputRequest = {
  worktreePath: WORKTREE,
  expectedHead: HEAD_A,
  attemptId: DEFAULT_ATTEMPT,
  implementerModel: DEFAULT_MODEL,
  allowedPathPrefixes: ['packages/example/'],
};

/** One fake executor run's answer, keyed by the git subcommand or tail. */
const ZERO = '0'.repeat(40);
/** Raw `diff-tree -z` output for modified regular files (mode 100644). */
function raw(...paths: string[]): string {
  return paths.map((p) => ':100644 100644 ' + ZERO + ' ' + ZERO + ' M\0' + p + '\0').join('');
}

function scripted(answers: Record<string, CommandRunResult>) {
  const recorded: readonly string[][] = [];
  const executor: CommandExecutorPort = {
    async run(argv) {
      (recorded as string[][]).push([...argv]);
      const args = argv.slice(3); // drop `git -C <worktree>`; the -c block follows
      let rest: readonly string[];
      if (args[0] === '-c') {
        const configEnd = args.findIndex((a) => a !== '-c' && !a.includes('='));
        rest = args.slice(configEnd);
      } else {
        rest = args;
      }
      const key = rest.join(' ');
      return answers[key] ?? answers[rest[0]] ?? { exitCode: 1, signal: null, stdout: '', stderr: 'missing' };
    },
  };
  return { executor, recorded: recorded as readonly (readonly string[])[] };
}

const happyAnswers: Record<string, CommandRunResult> = {
  'rev-parse --verify HEAD^{commit}': { exitCode: 0, signal: null, stdout: HEAD_A + '\n', stderr: '' },
  'symbolic-ref -q HEAD': { exitCode: 0, signal: null, stdout: BRANCH + '\n', stderr: '' },
  'add -A -- .': { exitCode: 0, signal: null, stdout: '', stderr: '' },
  'write-tree': { exitCode: 0, signal: null, stdout: TREE_2 + '\n', stderr: '' },
  'rev-parse --verify HEAD^{tree}': { exitCode: 0, signal: null, stdout: TREE_1 + '\n', stderr: '' },
  ['diff-tree -r --no-renames -z ' + HEAD_A + ' ' + TREE_2]: {
    exitCode: 0, signal: null, stdout: raw('packages/example/a.ts'), stderr: '',
  },
  'commit-tree': { exitCode: 0, signal: null, stdout: NEW + '\n', stderr: '' },
  'update-ref': { exitCode: 0, signal: null, stdout: '', stderr: '' },
};

describe('editOnlyCommitMessage', () => {
  it('is the three-line form with the two trailers', () => {
    const message = editOnlyCommitMessage('attempt-example-1', 'gemini-example-high');
    expect(message).toBe(
      'fleet: edit-only lane output for attempt-example-1\n\n' +
      'Implemented-By: agy gemini-example-high\n' +
      'Fleet-Attempt: attempt-example-1\n',
    );
    expect(message).toContain('Implemented-By: agy gemini-example-high');
    expect(message).toContain('Fleet-Attempt: attempt-example-1');
  });
});

describe('WorkspaceAdapter commitLaneOutput', () => {
  it('commits and moves the branch by compare-and-swap on the happy path', async () => {
    const { executor, recorded } = scripted(happyAnswers);
    const adapter = new WorkspaceAdapter({ executor });
    const result = await adapter.commitLaneOutput!(defaultRequest);
    expect(result).toEqual({
      outcome: 'committed',
      headCommit: NEW,
      branchRef: BRANCH,
    });
    const subcommands = recorded.map((argv) => argv[3 + COMMIT_CONFIG.length]);
    expect(subcommands).toEqual([
      'rev-parse', 'symbolic-ref', 'add', 'write-tree', 'rev-parse', 'diff-tree', 'commit-tree', 'update-ref',
    ]);
    for (const argv of recorded) {
      expect(argv.slice(0, 3 + COMMIT_CONFIG.length)).toEqual(['git', '-C', WORKTREE, ...COMMIT_CONFIG]);
    }
    const commitTree = recorded.find((argv) => argv[3 + COMMIT_CONFIG.length] === 'commit-tree')!;
    expect(commitTree).toContain('-p');
    expect(commitTree[commitTree.indexOf('-p') + 1]).toBe(HEAD_A);
    expect(commitTree).toContain('--no-gpg-sign');
    expect(commitTree[commitTree.indexOf('-m') + 1]).toBe(
      editOnlyCommitMessage(DEFAULT_ATTEMPT, DEFAULT_MODEL),
    );
    const updateRef = recorded.find((argv) => argv[3 + COMMIT_CONFIG.length] === 'update-ref')!;
    expect(updateRef.slice(-3)).toEqual([BRANCH, NEW, HEAD_A]);
  });

  it('reports nothing-to-commit when the staged tree equals the HEAD tree', async () => {
    const answers: Record<string, CommandRunResult> = {
      ...happyAnswers,
      'write-tree': { exitCode: 0, signal: null, stdout: TREE_1 + '\n', stderr: '' },
    };
    const { executor, recorded } = scripted(answers);
    const adapter = new WorkspaceAdapter({ executor });
    const result = await adapter.commitLaneOutput!(defaultRequest);
    expect(result).toEqual({ outcome: 'nothing-to-commit' });
    const subcommands = recorded.map((argv) => argv[3 + COMMIT_CONFIG.length]);
    expect(subcommands).not.toContain('commit-tree');
    expect(subcommands).not.toContain('update-ref');
  });

  it('refuses outside-allowed-paths when the staged tree touches a path outside the prefixes', async () => {
    const answers: Record<string, CommandRunResult> = {
      ...happyAnswers,
      ['diff-tree -r --no-renames -z ' + HEAD_A + ' ' + TREE_2]: {
        exitCode: 0, signal: null, stdout: raw('packages/example/a.ts', 'scripts/late.sh'), stderr: '',
      },
    };
    const { executor, recorded } = scripted(answers);
    const adapter = new WorkspaceAdapter({ executor });
    const result = await adapter.commitLaneOutput!(defaultRequest);
    expect(result).toEqual({ outcome: 'refused', reason: 'outside-allowed-paths' });
    const subcommands = recorded.map((argv) => argv[3 + COMMIT_CONFIG.length]);
    expect(subcommands).not.toContain('commit-tree');
    expect(subcommands).not.toContain('update-ref');
  });

  it('accepts a prefix without a trailing slash and refuses a sibling prefix path', async () => {
    const acceptAnswers: Record<string, CommandRunResult> = {
      ...happyAnswers,
      ['diff-tree -r --no-renames -z ' + HEAD_A + ' ' + TREE_2]: {
        exitCode: 0, signal: null, stdout: raw('packages/example/a.ts'), stderr: '',
      },
    };
    const accept = scripted(acceptAnswers);
    const acceptResult = await new WorkspaceAdapter({ executor: accept.executor })
      .commitLaneOutput!({ ...defaultRequest, allowedPathPrefixes: ['packages/example'] });
    expect(acceptResult).toEqual({ outcome: 'committed', headCommit: NEW, branchRef: BRANCH });

    const refuseAnswers: Record<string, CommandRunResult> = {
      ...happyAnswers,
      ['diff-tree -r --no-renames -z ' + HEAD_A + ' ' + TREE_2]: {
        exitCode: 0, signal: null, stdout: raw('packages/example-other/a.ts'), stderr: '',
      },
    };
    const refuse = scripted(refuseAnswers);
    const refuseResult = await new WorkspaceAdapter({ executor: refuse.executor })
      .commitLaneOutput!({ ...defaultRequest, allowedPathPrefixes: ['packages/example'] });
    expect(refuseResult).toEqual({ outcome: 'refused', reason: 'outside-allowed-paths' });
    const subcommands = refuse.recorded.map((argv) => argv[3 + COMMIT_CONFIG.length]);
    expect(subcommands).not.toContain('commit-tree');
    expect(subcommands).not.toContain('update-ref');
  });

  it('refuses invalid requests when no allowed path prefix is given, before any command', async () => {
    const { executor, recorded } = scripted(happyAnswers);
    const adapter = new WorkspaceAdapter({ executor });
    const requests: CommitLaneOutputRequest[] = [
      { ...defaultRequest, allowedPathPrefixes: [] },
      { ...defaultRequest, allowedPathPrefixes: [''] },
    ];
    for (const request of requests) {
      const result = await adapter.commitLaneOutput!(request);
      expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    }
    expect(recorded).toEqual([]);
  });

  it('reports an error with a fixed reason when diff-tree fails', async () => {
    const answers: Record<string, CommandRunResult> = {
      ...happyAnswers,
      ['diff-tree -r --no-renames -z ' + HEAD_A + ' ' + TREE_2]: {
        exitCode: 128, signal: null, stdout: '', stderr: 'XYZZY',
      },
    };
    const { executor } = scripted(answers);
    const adapter = new WorkspaceAdapter({ executor });
    const result = await adapter.commitLaneOutput!(defaultRequest);
    expect(result).toEqual({ outcome: 'error', reason: 'git diff-tree failed' });
  });

  it('refuses head-moved when HEAD moved without the attempt commit', async () => {
    const answers: Record<string, CommandRunResult> = {
      ...happyAnswers,
      'rev-parse --verify HEAD^{commit}': { exitCode: 0, signal: null, stdout: HEAD_B + '\n', stderr: '' },
      'show -s --format=%P HEAD': { exitCode: 0, signal: null, stdout: PARENT_D + '\n', stderr: '' },
    };
    const { executor, recorded } = scripted(answers);
    const adapter = new WorkspaceAdapter({ executor });
    const result = await adapter.commitLaneOutput!(defaultRequest);
    expect(result).toEqual({ outcome: 'refused', reason: 'head-moved' });
    const subcommands = recorded.map((argv) => argv[3 + COMMIT_CONFIG.length]);
    expect(subcommands).not.toContain('add');
  });

  it('reads an already-committed crash as already-committed when parents, message and tree all match', async () => {
    const answers: Record<string, CommandRunResult> = {
      ...happyAnswers,
      'rev-parse --verify HEAD^{commit}': { exitCode: 0, signal: null, stdout: NEW + '\n', stderr: '' },
      'show -s --format=%P HEAD': { exitCode: 0, signal: null, stdout: HEAD_A + '\n', stderr: '' },
      'show -s --format=%B HEAD': {
        exitCode: 0,
        signal: null,
        stdout: editOnlyCommitMessage(DEFAULT_ATTEMPT, DEFAULT_MODEL) + '\n',
        stderr: '',
      },
      'write-tree': { exitCode: 0, signal: null, stdout: TREE_2 + '\n', stderr: '' },
      'rev-parse --verify HEAD^{tree}': { exitCode: 0, signal: null, stdout: TREE_2 + '\n', stderr: '' },
    };
    const { executor, recorded } = scripted(answers);
    const adapter = new WorkspaceAdapter({ executor });
    const result = await adapter.commitLaneOutput!(defaultRequest);
    expect(result).toEqual({ outcome: 'already-committed', headCommit: NEW, branchRef: BRANCH });
    const subcommands = recorded.map((argv) => argv[3 + COMMIT_CONFIG.length]);
    expect(subcommands).not.toContain('commit-tree');
    expect(subcommands).not.toContain('update-ref');
  });

  it('refuses head-moved for an agent commit carrying the trailer instead of the adapter message', async () => {
    const answers: Record<string, CommandRunResult> = {
      ...happyAnswers,
      'rev-parse --verify HEAD^{commit}': { exitCode: 0, signal: null, stdout: NEW + '\n', stderr: '' },
      'show -s --format=%P HEAD': { exitCode: 0, signal: null, stdout: HEAD_A + '\n', stderr: '' },
      'show -s --format=%B HEAD': {
        exitCode: 0,
        signal: null,
        stdout: 'feat: agent work\n\nFleet-Attempt: ' + DEFAULT_ATTEMPT + '\n',
        stderr: '',
      },
    };
    const { executor, recorded } = scripted(answers);
    const adapter = new WorkspaceAdapter({ executor });
    const result = await adapter.commitLaneOutput!(defaultRequest);
    expect(result).toEqual({ outcome: 'refused', reason: 'head-moved' });
    const subcommands = recorded.map((argv) => argv[3 + COMMIT_CONFIG.length]);
    expect(subcommands).not.toContain('add');
    expect(subcommands).not.toContain('commit-tree');
    expect(subcommands).not.toContain('update-ref');
  });

  it('refuses head-moved when the commit is ours but the worktree holds changes beyond it', async () => {
    const answers: Record<string, CommandRunResult> = {
      ...happyAnswers,
      'rev-parse --verify HEAD^{commit}': { exitCode: 0, signal: null, stdout: NEW + '\n', stderr: '' },
      'show -s --format=%P HEAD': { exitCode: 0, signal: null, stdout: HEAD_A + '\n', stderr: '' },
      'show -s --format=%B HEAD': {
        exitCode: 0,
        signal: null,
        stdout: editOnlyCommitMessage(DEFAULT_ATTEMPT, DEFAULT_MODEL),
        stderr: '',
      },
      'write-tree': { exitCode: 0, signal: null, stdout: TREE_2 + '\n', stderr: '' },
      'rev-parse --verify HEAD^{tree}': { exitCode: 0, signal: null, stdout: TREE_1 + '\n', stderr: '' },
    };
    const { executor, recorded } = scripted(answers);
    const adapter = new WorkspaceAdapter({ executor });
    const result = await adapter.commitLaneOutput!(defaultRequest);
    expect(result).toEqual({ outcome: 'refused', reason: 'head-moved' });
    const subcommands = recorded.map((argv) => argv[3 + COMMIT_CONFIG.length]);
    expect(subcommands).not.toContain('commit-tree');
    expect(subcommands).not.toContain('update-ref');
  });

  it('refuses detached-head when symbolic-ref fails', async () => {
    const answers: Record<string, CommandRunResult> = {
      ...happyAnswers,
      'symbolic-ref -q HEAD': { exitCode: 1, signal: null, stdout: '', stderr: '' },
    };
    const { executor, recorded } = scripted(answers);
    const adapter = new WorkspaceAdapter({ executor });
    const result = await adapter.commitLaneOutput!(defaultRequest);
    expect(result).toEqual({ outcome: 'refused', reason: 'detached-head' });
    const subcommands = recorded.map((argv) => argv[3 + COMMIT_CONFIG.length]);
    expect(subcommands).not.toContain('add');
  });

  it('refuses ref-moved when update-ref loses the compare-and-swap', async () => {
    const answers: Record<string, CommandRunResult> = {
      ...happyAnswers,
      'update-ref': { exitCode: 1, signal: null, stdout: '', stderr: '' },
    };
    const { executor } = scripted(answers);
    const adapter = new WorkspaceAdapter({ executor });
    const result = await adapter.commitLaneOutput!(defaultRequest);
    expect(result).toEqual({ outcome: 'refused', reason: 'ref-moved' });
  });

  it('reports an error with a fixed reason on a failed write-tree and never leaks stderr', async () => {
    const answers: Record<string, CommandRunResult> = {
      ...happyAnswers,
      'write-tree': { exitCode: 128, signal: null, stdout: '', stderr: 'XYZZY' },
    };
    const { executor } = scripted(answers);
    const adapter = new WorkspaceAdapter({ executor });
    const result = await adapter.commitLaneOutput!(defaultRequest);
    expect(result).toEqual({ outcome: 'error', reason: 'git write-tree failed' });
    if (result.outcome === 'error') {
      expect(result.reason).not.toContain(WORKTREE);
      expect(result.reason).not.toContain('XYZZY');
    }
  });

  it('reports an error when a command ends without an exit code', async () => {
    const answers: Record<string, CommandRunResult> = {
      ...happyAnswers,
      'add -A -- .': { exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '', error: 'timeout' },
    };
    const { executor } = scripted(answers);
    const adapter = new WorkspaceAdapter({ executor });
    const result = await adapter.commitLaneOutput!(defaultRequest);
    expect(result).toEqual({ outcome: 'error', reason: 'git add failed' });
  });

  it('refuses invalid requests before running any command', async () => {
    const { executor, recorded } = scripted(happyAnswers);
    const adapter = new WorkspaceAdapter({ executor });
    const requests: CommitLaneOutputRequest[] = [
      { ...defaultRequest, expectedHead: 'HEAD' },
      { ...defaultRequest, expectedHead: 'A'.repeat(40) },
      { ...defaultRequest, attemptId: '--amend' },
      { ...defaultRequest, implementerModel: '-x' },
      { ...defaultRequest, worktreePath: 'relative/path' },
      { ...defaultRequest, worktreePath: '/' },
    ];
    for (const request of requests) {
      const result = await adapter.commitLaneOutput!(request);
      expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    }
    expect(recorded).toEqual([]);
  });

  it('runs every command on the recorded host executor and none on the default one', async () => {
    const recordedHost: AttemptRunnerRecord = {
      hostName: 'lane-example',
    } as AttemptRunnerRecord;
    const defaultScript = scripted(happyAnswers);
    const recordedScript = scripted(happyAnswers);
    const adapter = new WorkspaceAdapter({
      executor: defaultScript.executor,
      executorForRecordedHost: () => ({ ok: true, executor: recordedScript.executor }),
    });
    const result = await adapter.commitLaneOutput!({ ...defaultRequest, recordedHost });
    expect(result).toEqual({ outcome: 'committed', headCommit: NEW, branchRef: BRANCH });
    expect(recordedScript.recorded.length).toBe(8);
    expect(defaultScript.recorded).toEqual([]);
  });

  it('reports an error when the recorded host cannot be resolved', async () => {
    const recordedHost: AttemptRunnerRecord = {
      hostName: 'lane-example',
    } as AttemptRunnerRecord;
    const adapter = new WorkspaceAdapter({
      executor: scripted(happyAnswers).executor,
      executorForRecordedHost: () => ({ ok: false, reason: 'gone' }),
    });
    const result = await adapter.commitLaneOutput!({ ...defaultRequest, recordedHost });
    expect(result).toEqual({ outcome: 'error', reason: 'worktree host could not be resolved' });
  });

  it('refuses head-moved for the adapter message preceded by a newline', async () => {
    const answers: Record<string, CommandRunResult> = {
      ...happyAnswers,
      'rev-parse --verify HEAD^{commit}': { exitCode: 0, signal: null, stdout: NEW + '\n', stderr: '' },
      'show -s --format=%P HEAD': { exitCode: 0, signal: null, stdout: HEAD_A + '\n', stderr: '' },
      'show -s --format=%B HEAD': {
        exitCode: 0, signal: null, stdout: '\n' + editOnlyCommitMessage(DEFAULT_ATTEMPT, DEFAULT_MODEL) + '\n', stderr: '',
      },
      'rev-parse --verify HEAD^{tree}': { exitCode: 0, signal: null, stdout: TREE_2 + '\n', stderr: '' },
    };
    const { executor } = scripted(answers);
    const adapter = new WorkspaceAdapter({ executor });
    expect(await adapter.commitLaneOutput!(defaultRequest)).toEqual({ outcome: 'refused', reason: 'head-moved' });
  });

  it.each([
    ['a symlink', ':000000 120000 ' + '0'.repeat(40) + ' ' + '1'.repeat(40) + ' A\0packages/example/link\0'],
    ['a gitlink', ':000000 160000 ' + '0'.repeat(40) + ' ' + '1'.repeat(40) + ' A\0packages/example/sub\0'],
    ['a protected path under a prefix', raw('packages/example/package.json')],
  ])('refuses outside-allowed-paths for %s in the staged tree', async (_name, stdout) => {
    const answers: Record<string, CommandRunResult> = {
      ...happyAnswers,
      ['diff-tree -r --no-renames -z ' + HEAD_A + ' ' + TREE_2]: { exitCode: 0, signal: null, stdout, stderr: '' },
    };
    const { executor, recorded } = scripted(answers);
    const adapter = new WorkspaceAdapter({ executor });
    expect(await adapter.commitLaneOutput!(defaultRequest)).toEqual({ outcome: 'refused', reason: 'outside-allowed-paths' });
    const subcommands = recorded.map((argv) => argv[3 + COMMIT_CONFIG.length]);
    expect(subcommands).not.toContain('commit-tree');
  });
});
