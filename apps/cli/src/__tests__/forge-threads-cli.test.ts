/**
 * CLI-boundary tests for OG-8b: `forge threads list|reply|resolve`. T1-T9 run
 * against a stub helper injected through a partial runtime; T10-T13 use the
 * real composition with a recording `forgeGhRunner`, so no test spawns a
 * process or touches the network.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { FleetInstallation, ForgeSectionV2 } from '@fleet/installation';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli } from '../index.js';

const GITHUB_FORGE: ForgeSectionV2 = {
  mode: 'github',
  owner: 'example-owner',
  repo: 'example-repo',
};

/** Minimal v2 installation: one local host with a declared container runner. */
function makeInstallation(forge: ForgeSectionV2): FleetInstallation {
  return {
    schemaVersion: 2,
    hosts: {
      local: {
        transport: 'local',
        worktreeRoot: '/tmp/fleet-o8b-worktrees',
        roles: ['orchestrator', 'lane-runner'],
        runner: {
          kind: 'opencode',
          port: 46000,
          capabilities: {
            networkEgressRestricted: true,
            cpuAndMemoryLimited: true,
            processTreeTermination: true,
            filesystemScope: 'scoped-worktree',
          },
          maxLanes: 2,
        },
      },
    },
    forge,
  };
}

function collectIo(): {
  out: string[];
  err: string[];
  io: { stdout: (t: string) => void; stderr: (t: string) => void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
  };
}

/** A stub helper that records every port call and answers the same result. */
function recordingStub(answer: unknown): { calls: unknown[]; helper: Record<string, unknown> } {
  const calls: unknown[] = [];
  const call = (request: unknown): Promise<unknown> => {
    calls.push(request);
    return Promise.resolve(answer);
  };
  return {
    calls,
    helper: {
      listReviewThreads: call,
      replyToReviewThread: call,
      resolveReviewThread: call,
    },
  };
}

function stubRuntime(helper: unknown): FleetCliRuntime {
  return { execution: { reviewThreadHelper: helper } } as unknown as FleetCliRuntime;
}

function listArgv(extra: string[] = []): string[] {
  return ['forge', 'threads', 'list', '--repository', 'owner/repo', '--pull-request-number', '42', ...extra];
}

function replyArgv(bodyFile: string, extra: string[] = []): string[] {
  return [
    'forge',
    'threads',
    'reply',
    '--repository',
    'owner/repo',
    '--pull-request-number',
    '42',
    '--thread-id',
    'PRRT_1',
    '--body-file',
    bodyFile,
    ...extra,
  ];
}

function resolveArgv(extra: string[] = []): string[] {
  return [
    'forge',
    'threads',
    'resolve',
    '--repository',
    'owner/repo',
    '--pull-request-number',
    '42',
    '--thread-id',
    'PRRT_1',
    ...extra,
  ];
}

let scratchDirs: string[] = [];

function scratchDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-threads-'));
  scratchDirs.push(dir);
  return dir;
}

function bodyFile(content: string): string {
  const dir = scratchDir();
  const file = path.join(dir, 'body.txt');
  writeFileSync(file, content, 'utf8');
  return file;
}

const OK_THREAD = {
  threadId: 'PRRT_1',
  isResolved: false,
  path: 'src/a.ts',
  line: 7,
  author: 'owl',
  body: 'MARKER-BODY',
};

describe('forge threads', () => {
  it('list makes one port call and prints ids, state, path, line, author and counts, never a body', async () => {
    const { calls, helper } = recordingStub({
      outcome: 'ok',
      threads: [OK_THREAD, { ...OK_THREAD, threadId: 'PRRT_2', isResolved: true }],
    });
    const { io, out, err } = collectIo();
    const before = Date.now();
    const code = await runCli(listArgv(), io, stubRuntime(helper));
    const after = Date.now();
    expect(code).toBe(0);
    expect(JSON.parse(out.join(''))).toEqual({
      outcome: 'ok',
      count: 2,
      unresolvedCount: 1,
      threads: [
        { threadId: 'PRRT_1', isResolved: false, path: 'src/a.ts', line: 7, author: 'owl' },
        { threadId: 'PRRT_2', isResolved: true, path: 'src/a.ts', line: 7, author: 'owl' },
      ],
    });
    expect(calls).toHaveLength(1);
    const request = calls[0] as Record<string, unknown>;
    expect(request).toEqual({
      repository: { owner: 'owner', repo: 'repo' },
      pullRequestNumber: 42,
      deadlineIso: expect.any(String),
    });
    const deadline = Date.parse(request['deadlineIso'] as string);
    expect(deadline).toBeGreaterThan(before);
    expect(deadline - after).toBeLessThanOrEqual(120000);
    expect(out.join('')).not.toContain('MARKER-BODY');
    expect(err.join('')).not.toContain('MARKER-BODY');
  });

  it('reply sends the stripped body file once and prints only the thread id and comment id', async () => {
    const { calls, helper } = recordingStub({ outcome: 'ok', commentId: 'IC_1' });
    const file = bodyFile('a\r\nb\u0007\tc\u202e');
    const { io, out, err } = collectIo();
    const code = await runCli(replyArgv(file), io, stubRuntime(helper));
    expect(code).toBe(0);
    expect(JSON.parse(out.join(''))).toEqual({ outcome: 'ok', threadId: 'PRRT_1', commentId: 'IC_1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ threadId: 'PRRT_1', body: 'a\nb c' });
    expect(out.join('') + err.join('')).not.toContain('b c');
    expect(out.join('') + err.join('')).not.toContain(file);
  });

  it('a multi-line body keeps every interior newline: only the carriage returns are removed', async () => {
    const { calls, helper } = recordingStub({ outcome: 'ok', commentId: 'IC_1' });
    const file = bodyFile('line one\r\nline two\r\n\r\nline three\n');
    const { io, out, err } = collectIo();
    const code = await runCli(replyArgv(file), io, stubRuntime(helper));
    expect(code).toBe(0);
    expect(JSON.parse(out.join(''))).toEqual({ outcome: 'ok', threadId: 'PRRT_1', commentId: 'IC_1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ body: 'line one\nline two\n\nline three\n' });
    expect(out.join('') + err.join('')).not.toContain(file);
  });

  it('resolve makes one port call and prints the thread as resolved', async () => {
    const { calls, helper } = recordingStub({ outcome: 'ok', isResolved: true });
    const { io, out } = collectIo();
    const code = await runCli(resolveArgv(), io, stubRuntime(helper));
    expect(code).toBe(0);
    expect(JSON.parse(out.join(''))).toEqual({ outcome: 'ok', threadId: 'PRRT_1', isResolved: true });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['subcommand missing', ['forge', 'threads', '--repository', 'owner/repo', '--pull-request-number', '42']],
    ['subcommand unknown', ['forge', 'threads', 'bogus']],
    ['a second positional', ['forge', 'threads', 'list', 'extra', '--repository', 'owner/repo', '--pull-request-number', '42']],
    ['an unknown flag', ['forge', 'threads', 'list', '--bogus', '1', '--repository', 'owner/repo', '--pull-request-number', '42']],
    ['repository missing', ['forge', 'threads', 'list', '--pull-request-number', '42']],
    ['repository not a string', ['forge', 'threads', 'list', '--json', '{"repository":5}', '--pull-request-number', '42']],
    ['repository without a slash', ['forge', 'threads', 'list', '--repository', 'owner-repo', '--pull-request-number', '42']],
    ['repository with three segments', ['forge', 'threads', 'list', '--repository', 'a/b/c', '--pull-request-number', '42']],
    ['repository with a .. segment', ['forge', 'threads', 'list', '--repository', '../repo', '--pull-request-number', '42']],
    ['repository with a trailing newline', ['forge', 'threads', 'list', '--repository', 'owner/repo\n', '--pull-request-number', '42']],
    ['pull request number missing', ['forge', 'threads', 'list', '--repository', 'owner/repo']],
    ['pull request number zero', ['forge', 'threads', 'list', '--repository', 'owner/repo', '--pull-request-number', '0']],
    ['pull request number negative', ['forge', 'threads', 'list', '--json', '{"pullRequestNumber":-1}', '--repository', 'owner/repo']],
    ['pull request number fractional', ['forge', 'threads', 'list', '--pull-request-number', '1.5', '--repository', 'owner/repo']],
    ['pull request number not a number', ['forge', 'threads', 'list', '--pull-request-number', 'abc', '--repository', 'owner/repo']],
    ['pull request number with no value', ['forge', 'threads', 'list', '--pull-request-number', '--repository', 'owner/repo']],
    ['thread id missing on resolve', ['forge', 'threads', 'resolve', '--repository', 'owner/repo', '--pull-request-number', '42']],
    ['thread id not a string', ['forge', 'threads', 'resolve', '--json', '{"threadId":5}', '--repository', 'owner/repo', '--pull-request-number', '42']],
    ['thread id with a space', ['forge', 'threads', 'resolve', '--thread-id', 'a b', '--repository', 'owner/repo', '--pull-request-number', '42']],
    ['thread id with a newline', ['forge', 'threads', 'resolve', '--thread-id', 'a\nb', '--repository', 'owner/repo', '--pull-request-number', '42']],
    ['thread id of 257 characters', ['forge', 'threads', 'resolve', '--thread-id', 'x'.repeat(257), '--repository', 'owner/repo', '--pull-request-number', '42']],
  ])('a usage error exits 2 with no port call: %s', async (_name, argv) => {
    const { calls, helper } = recordingStub({ outcome: 'ok', threads: [] });
    const { io, out } = collectIo();
    const code = await runCli(argv as string[], io, stubRuntime(helper));
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
    expect(out.join('')).toBe('');
  });

  it.each([
    ['body file missing', 'reply', (_dir: string) => []],
    ['body file blank', 'reply', () => ['   ']],
    ['body file absent', 'reply', (dir: string) => [path.join(dir, 'absent.txt')]],
    ['body file is a directory', 'reply', (dir: string) => [dir]],
    ['body file empty', 'reply', (dir: string) => {
      const file = path.join(dir, 'empty.txt');
      writeFileSync(file, '', 'utf8');
      return [file];
    }],
    ['body file over 32000 bytes', 'reply', (_dir: string) => [bodyFile('MARKER-BODY' + 'x'.repeat(32100))]],
    ['body file whitespace only', 'reply', () => [' \t\u0007\n ']],
    ['body over 8000 characters after stripping', 'reply', () => ['x'.repeat(9000)]],
  ])('a bad body file exits 2 with no port call: %s', async (_name, _sub, makeArgv) => {
    const { calls, helper } = recordingStub({ outcome: 'ok', commentId: 'IC_1' });
    const dir = scratchDir();
    const argvParts: string[] = makeArgv(dir);
    const { io, out, err } = collectIo();
    const code = await runCli(replyArgv(argvParts[0] ?? '', argvParts.slice(1)), io, stubRuntime(helper));
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
    const combined = err.join('');
    expect(combined).not.toContain('forge-threads-');
    expect(combined).not.toContain('MARKER-BODY');
    expect(out.join('')).toBe('');
  });

  it('a body of exactly 8000 characters is sent', async () => {
    const { calls, helper } = recordingStub({ outcome: 'ok', commentId: 'IC_1' });
    const file = bodyFile('x'.repeat(8000));
    const { io, out } = collectIo();
    const code = await runCli(replyArgv(file), io, stubRuntime(helper));
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { body: string }).body.length).toBe(8000);
    expect(JSON.parse(out.join(''))).toEqual({ outcome: 'ok', threadId: 'PRRT_1', commentId: 'IC_1' });
  });

  it('list turns a tab into a space, drops other control characters from forge text before printing and caps a long path', async () => {
    const { helper } = recordingStub({
      outcome: 'ok',
      threads: [
        {
          threadId: 'PRRT_\u00071',
          path: 'src/\u001b[31mx\u202e.ts',
          line: null,
          author: 'review\tbot\u2028',
          isResolved: false,
          body: '',
        },
      ],
    });
    const { io, out } = collectIo();
    const code = await runCli(listArgv(), io, stubRuntime(helper));
    expect(code).toBe(0);
    expect(JSON.parse(out.join(''))).toEqual({
      outcome: 'ok',
      count: 1,
      unresolvedCount: 1,
      threads: [{ threadId: 'PRRT_1', isResolved: false, path: 'src/[31mx.ts', line: null, author: 'review bot' }],
    });

    const longPath = 'y'.repeat(500);
    const { helper: helper2 } = recordingStub({
      outcome: 'ok',
      threads: [{ ...OK_THREAD, path: longPath }],
    });
    const { io: io2, out: out2 } = collectIo();
    await runCli(listArgv(), io2, stubRuntime(helper2));
    const parsed = JSON.parse(out2.join('')) as { threads: { path: string }[] };
    expect(parsed.threads[0]!.path).toBe('y'.repeat(400));
  });

  it.each([
    ['list refused invalid-input', 'list', { outcome: 'refused', code: 'invalid-input', reason: 'MARKER-REASON' }, { outcome: 'refused', code: 'invalid-input' }],
    ['list refused thread-not-found', 'list', { outcome: 'refused', code: 'thread-not-found', reason: 'MARKER-REASON' }, { outcome: 'refused', code: 'thread-not-found' }],
    ['list refused thread-not-on-pull-request', 'list', { outcome: 'refused', code: 'thread-not-on-pull-request', reason: 'MARKER-REASON' }, { outcome: 'refused', code: 'thread-not-on-pull-request' }],
    ['list unavailable unconfigured', 'list', { outcome: 'unavailable', reason: 'unconfigured' }, { outcome: 'unavailable', reason: 'unconfigured' }],
    ['list unavailable unreadable', 'list', { outcome: 'unavailable', reason: 'unreadable' }, { outcome: 'unavailable', reason: 'unreadable' }],
    ['list unavailable budget-exhausted', 'list', { outcome: 'unavailable', reason: 'budget-exhausted' }, { outcome: 'unavailable', reason: 'budget-exhausted' }],
    ['list unavailable forge-error', 'list', { outcome: 'unavailable', reason: 'forge-error' }, { outcome: 'unavailable', reason: 'forge-error' }],
    ['list unavailable timeout', 'list', { outcome: 'unavailable', reason: 'timeout' }, { outcome: 'unavailable', reason: 'timeout' }],
    ['list refused unknown code', 'list', { outcome: 'refused', code: 'other', reason: 'MARKER-REASON' }, { outcome: 'refused', code: 'unrecognised' }],
    ['list unavailable unknown reason', 'list', { outcome: 'unavailable', reason: 'other' }, { outcome: 'unavailable', reason: 'unrecognised' }],
    ['reply refused invalid-input', 'reply', { outcome: 'refused', code: 'invalid-input', reason: 'MARKER-REASON' }, { outcome: 'refused', code: 'invalid-input', mayHavePosted: false }],
    ['reply refused thread-not-found', 'reply', { outcome: 'refused', code: 'thread-not-found', reason: 'MARKER-REASON' }, { outcome: 'refused', code: 'thread-not-found', mayHavePosted: false }],
    ['reply refused thread-not-on-pull-request', 'reply', { outcome: 'refused', code: 'thread-not-on-pull-request', reason: 'MARKER-REASON' }, { outcome: 'refused', code: 'thread-not-on-pull-request', mayHavePosted: false }],
    ['reply unavailable unconfigured', 'reply', { outcome: 'unavailable', reason: 'unconfigured' }, { outcome: 'unavailable', reason: 'unconfigured', mayHavePosted: false }],
    ['reply unavailable unreadable', 'reply', { outcome: 'unavailable', reason: 'unreadable' }, { outcome: 'unavailable', reason: 'unreadable', mayHavePosted: true }],
    ['reply unavailable budget-exhausted', 'reply', { outcome: 'unavailable', reason: 'budget-exhausted' }, { outcome: 'unavailable', reason: 'budget-exhausted', mayHavePosted: false }],
    ['reply unavailable forge-error', 'reply', { outcome: 'unavailable', reason: 'forge-error' }, { outcome: 'unavailable', reason: 'forge-error', mayHavePosted: true }],
    ['reply unavailable timeout', 'reply', { outcome: 'unavailable', reason: 'timeout' }, { outcome: 'unavailable', reason: 'timeout', mayHavePosted: true }],
    ['reply refused unknown code', 'reply', { outcome: 'refused', code: 'other', reason: 'MARKER-REASON' }, { outcome: 'refused', code: 'unrecognised', mayHavePosted: false }],
    ['reply unavailable unknown reason', 'reply', { outcome: 'unavailable', reason: 'other' }, { outcome: 'unavailable', reason: 'unrecognised', mayHavePosted: true }],
    ['resolve refused invalid-input', 'resolve', { outcome: 'refused', code: 'invalid-input', reason: 'MARKER-REASON' }, { outcome: 'refused', code: 'invalid-input' }],
    ['resolve refused thread-not-found', 'resolve', { outcome: 'refused', code: 'thread-not-found', reason: 'MARKER-REASON' }, { outcome: 'refused', code: 'thread-not-found' }],
    ['resolve refused thread-not-on-pull-request', 'resolve', { outcome: 'refused', code: 'thread-not-on-pull-request', reason: 'MARKER-REASON' }, { outcome: 'refused', code: 'thread-not-on-pull-request' }],
    ['resolve unavailable unconfigured', 'resolve', { outcome: 'unavailable', reason: 'unconfigured' }, { outcome: 'unavailable', reason: 'unconfigured' }],
    ['resolve unavailable unreadable', 'resolve', { outcome: 'unavailable', reason: 'unreadable' }, { outcome: 'unavailable', reason: 'unreadable' }],
    ['resolve unavailable budget-exhausted', 'resolve', { outcome: 'unavailable', reason: 'budget-exhausted' }, { outcome: 'unavailable', reason: 'budget-exhausted' }],
    ['resolve unavailable forge-error', 'resolve', { outcome: 'unavailable', reason: 'forge-error' }, { outcome: 'unavailable', reason: 'forge-error' }],
    ['resolve unavailable timeout', 'resolve', { outcome: 'unavailable', reason: 'timeout' }, { outcome: 'unavailable', reason: 'timeout' }],
    ['resolve refused unknown code', 'resolve', { outcome: 'refused', code: 'other', reason: 'MARKER-REASON' }, { outcome: 'refused', code: 'unrecognised' }],
    ['resolve unavailable unknown reason', 'resolve', { outcome: 'unavailable', reason: 'other' }, { outcome: 'unavailable', reason: 'unrecognised' }],
  ])('a port failure prints only outcome and code and exits 1: %s', async (_name, sub, answer, expected) => {
    const { calls, helper } = recordingStub(answer);
    const { io, out, err } = collectIo();
    const argv =
      sub === 'list' ? listArgv() : sub === 'reply' ? replyArgv(bodyFile('hello')) : resolveArgv();
    const code = await runCli(argv, io, stubRuntime(helper));
    expect(code).toBe(1);
    expect(JSON.parse(out.join(''))).toEqual(expected);
    expect(out.join('') + err.join('')).not.toContain('MARKER-REASON');
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['null answer', 'list', null],
    ['string answer', 'list', 'nope'],
    ['array answer', 'list', []],
    ['answer without outcome', 'list', {}],
    ['answer with unknown outcome', 'list', { outcome: 'nope' }],
    ['ok list with non-array threads', 'list', { outcome: 'ok', threads: 'nope' }],
    ['ok list with 5001 threads', 'list', { outcome: 'ok', threads: Array.from({ length: 5001 }, (_, i) => ({ threadId: `t${i}`, isResolved: true, path: 'p', line: 1, author: null })) }],
    ['ok list with an array hole', 'list', { outcome: 'ok', threads: new Array(1) }],
    ['ok list with a wrong-typed field', 'list', { outcome: 'ok', threads: [{ ...OK_THREAD, threadId: 7 }] }],
    ['ok reply without a comment id', 'reply', { outcome: 'ok' }],
    ['ok resolve with isResolved not true', 'resolve', { outcome: 'ok', isResolved: false }],
  ])('a malformed port answer is unknown and exits 1: %s', async (_name, sub, answer) => {
    const { calls, helper } = recordingStub(answer);
    const { io, out } = collectIo();
    const argv =
      sub === 'list' ? listArgv() : sub === 'reply' ? replyArgv(bodyFile('hello')) : resolveArgv();
    const code = await runCli(argv, io, stubRuntime(helper));
    expect(code).toBe(1);
    const expected: Record<string, unknown> = { outcome: 'unknown', reason: 'malformed-port-response' };
    if (sub === 'reply') {
      expected['mayHavePosted'] = true;
    }
    expect(JSON.parse(out.join(''))).toEqual(expected);
    expect(calls).toHaveLength(1);
  });

  it('a port answer with a throwing getter is unknown', async () => {
    const helper = {
      listReviewThreads: async (): Promise<unknown> => ({
        get outcome(): never {
          throw new Error('MARKER-THROW');
        },
      }),
      replyToReviewThread: async (): Promise<unknown> => ({
        get outcome(): never {
          throw new Error('MARKER-THROW');
        },
      }),
      resolveReviewThread: async (): Promise<unknown> => ({
        get outcome(): never {
          throw new Error('MARKER-THROW');
        },
      }),
    };
    const { io, out, err } = collectIo();
    const code = await runCli(listArgv(), io, stubRuntime(helper));
    expect(code).toBe(1);
    expect(JSON.parse(out.join(''))).toEqual({ outcome: 'unknown', reason: 'malformed-port-response' });
    expect(out.join('') + err.join('')).not.toContain('MARKER-THROW');
  });

  it('a rejecting port method is unknown and is called once', async () => {
    const calls: unknown[] = [];
    const reject = (): Promise<never> => {
      calls.push(null);
      return Promise.reject(new Error('MARKER-THROW'));
    };
    const helper = {
      listReviewThreads: reject,
      replyToReviewThread: reject,
      resolveReviewThread: reject,
    };
    const { io, out, err } = collectIo();
    const code = await runCli(listArgv(), io, stubRuntime(helper));
    expect(code).toBe(1);
    expect(JSON.parse(out.join(''))).toEqual({ outcome: 'unknown', reason: 'malformed-port-response' });
    expect(calls).toHaveLength(1);
    expect(out.join('') + err.join('')).not.toContain('MARKER-THROW');
  });

  it('a missing port method is unavailable', async () => {
    const { io, out } = collectIo();
    const code = await runCli(
      replyArgv(bodyFile('hello')),
      io,
      stubRuntime({}),
    );
    expect(code).toBe(1);
    expect(JSON.parse(out.join(''))).toEqual({
      outcome: 'unavailable',
      reason: 'port-method-missing',
      mayHavePosted: false,
    });
  });

  it('under forge mode github a reply is one ownership check then one mutation carrying the stripped body', async () => {
    const recorded: { args: readonly string[]; timeoutMs: number | undefined }[] = [];
    const answers = [
      {
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({
          data: {
            node: {
              __typename: 'PullRequestReviewThread',
              id: 'PRRT_1',
              pullRequest: { number: 202, repository: { name: 'example-repo', owner: { login: 'example-owner' } } },
            },
          },
        }),
      },
      {
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { id: 'IC_1' } } } }),
      },
    ];
    let call = 0;
    const forgeGhRunner = async (args: readonly string[], timeoutMs?: number) => {
      recorded.push({ args, timeoutMs });
      const answer = answers[Math.min(call, answers.length - 1)];
      call += 1;
      return answer;
    };
    const file = bodyFile('hello\tworld');
    const runtime = createFleetCliRuntime({ installation: makeInstallation(GITHUB_FORGE), forgeGhRunner });
    const { io, out } = collectIo();
    const code = await runCli(
      [
        'forge',
        'threads',
        'reply',
        '--repository',
        'Example-Owner/Example-Repo',
        '--pull-request-number',
        '202',
        '--thread-id',
        'PRRT_1',
        '--body-file',
        file,
      ],
      io,
      runtime,
    );
    expect(code).toBe(0);
    expect(JSON.parse(out.join(''))).toEqual({ outcome: 'ok', threadId: 'PRRT_1', commentId: 'IC_1' });
    expect(recorded).toHaveLength(2);
    expect(recorded[1]!.args).toContain('threadId=PRRT_1');
    expect(recorded[1]!.args).toContain('body=hello world');
    for (const entry of recorded) {
      expect(entry.timeoutMs).toBe(30000);
    }
  });

  it('resolve under forge mode github reaches the resolve mutation once', async () => {
    const recorded: { args: readonly string[] }[] = [];
    const answers = [
      {
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({
          data: {
            node: {
              __typename: 'PullRequestReviewThread',
              id: 'PRRT_1',
              pullRequest: { number: 202, repository: { name: 'example-repo', owner: { login: 'example-owner' } } },
            },
          },
        }),
      },
      {
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { id: 'PRRT_1', isResolved: true } } } }),
      },
    ];
    let call = 0;
    const forgeGhRunner = async (args: readonly string[]) => {
      recorded.push({ args });
      const answer = answers[Math.min(call, answers.length - 1)];
      call += 1;
      return answer;
    };
    const runtime = createFleetCliRuntime({ installation: makeInstallation(GITHUB_FORGE), forgeGhRunner });
    const { io, out } = collectIo();
    const code = await runCli(
      ['forge', 'threads', 'resolve', '--repository', 'example-owner/example-repo', '--pull-request-number', '202', '--thread-id', 'PRRT_1'],
      io,
      runtime,
    );
    expect(code).toBe(0);
    expect(JSON.parse(out.join(''))).toEqual({ outcome: 'ok', threadId: 'PRRT_1', isResolved: true });
    expect(recorded).toHaveLength(2);
    expect(recorded.filter((entry) => entry.args.some((arg) => arg.includes('resolveReviewThread(')))).toHaveLength(1);
  });

  it('a reply whose mutation fails is not retried', async () => {
    const recorded: { args: readonly string[] }[] = [];
    const check = {
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        data: {
          node: {
            __typename: 'PullRequestReviewThread',
            id: 'PRRT_1',
            pullRequest: { number: 202, repository: { name: 'example-repo', owner: { login: 'example-owner' } } },
          },
        },
      }),
    };
    let call = 0;
    const forgeGhRunner = async (args: readonly string[]) => {
      recorded.push({ args });
      call += 1;
      return call === 1 ? check : { exitCode: 1, stdout: '', stderr: 'MARKER-STDERR' };
    };
    const runtime = createFleetCliRuntime({ installation: makeInstallation(GITHUB_FORGE), forgeGhRunner });
    const { io, out, err } = collectIo();
    const code = await runCli(
      [
        'forge',
        'threads',
        'reply',
        '--repository',
        'example-owner/example-repo',
        '--pull-request-number',
        '202',
        '--thread-id',
        'PRRT_1',
        '--body-file',
        bodyFile('hello'),
      ],
      io,
      runtime,
    );
    expect(code).toBe(1);
    expect(JSON.parse(out.join(''))).toEqual({ outcome: 'unavailable', reason: 'forge-error', mayHavePosted: true });
    expect(recorded).toHaveLength(2);
    expect(recorded.filter((entry) => entry.args.some((arg) => arg.includes('addPullRequestReviewThreadReply')))).toHaveLength(1);
    expect(out.join('') + err.join('')).not.toContain('MARKER-STDERR');
  });

  it('without forge mode github the helper is unconfigured and gh is never called', async () => {
    const recorded: { args: readonly string[] }[] = [];
    const forgeGhRunner = async (args: readonly string[]) => {
      recorded.push({ args });
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const runtime = createFleetCliRuntime({ installation: makeInstallation({ mode: 'none' }), forgeGhRunner });
    const { io, out } = collectIo();
    const code = await runCli(replyArgv(bodyFile('hello')), io, runtime);
    expect(code).toBe(1);
    expect(JSON.parse(out.join(''))).toEqual({ outcome: 'unavailable', reason: 'unconfigured', mayHavePosted: false });
    expect(recorded).toHaveLength(0);
  });

  it('only the forge threads command and the composition root name the review thread helper', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..');
    const cliSrc = path.join(repoRoot, 'apps', 'cli', 'src');
    const cliMatches = readdirSync(cliSrc, { recursive: true, encoding: 'utf8' })
      .filter(
        (file) =>
          (file.endsWith('.ts') || file.endsWith('.tsx')) &&
          !file.includes('__tests__') &&
          !file.endsWith('.test.ts') &&
          !file.endsWith('.test.tsx'),
      )
      .filter((file) => readFileSync(path.join(cliSrc, file), 'utf8').match(/ReviewThreadHelper|reviewThreadHelper/) !== null)
      .sort();
    expect(cliMatches).toEqual(['commands/forge-threads.ts', 'composition.ts']);

    const appSrc = path.join(repoRoot, 'packages', 'work-execution', 'src', 'application');
    const portMatches = readdirSync(appSrc, { recursive: true, encoding: 'utf8' })
      .filter((file) => statSync(path.join(appSrc, file)).isFile())
      .filter((file) => readFileSync(path.join(appSrc, file), 'utf8').match(/ReviewThreadHelper/) !== null)
      .sort();
    expect(portMatches).toEqual(['ports/out/ReviewThreadHelperPort.out-port.ts', 'ports/out/index.ts']);
  });
});

afterAll(() => {
  for (const dir of scratchDirs) {
    try {
      if (statSync(dir).isDirectory()) {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // already gone
    }
  }
  scratchDirs = [];
});
