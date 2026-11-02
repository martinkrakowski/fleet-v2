// GhForgeMergeReadAdapter: one read-only gh api graphql reader per page for
// the merge pass's facts — PR state and live head, merge state, required
// contexts by name with creator login, and fully paginated review threads.
/**
 * Covers the brief's acceptance fixtures: missing context ≠ green; skipped /
 * neutral required ≠ green; 150 threads across two pages; a later page that
 * errors makes threads unknown; network error → forge-error and shape-broken
 * JSON → unreadable (not forge-error); a call past the deadline is not
 * issued and a late call races to a deadline outcome; the premerge creator
 * verdict; head/merge-state mapping including a non-40-hex head; and the
 * cursor-argument behaviour when a required context appears only on page two.
 */

import { describe, expect, it } from 'vitest';

import type { GhInvocationResult } from '../ForgeActionAdapter.adapter.js';
import {
  GhForgeMergeReadAdapter,
  parseMergeContextsPage,
  parseMergePrMeta,
  parseReviewThreadsPage,
  type GhForgeMergeReadAdapterOptions,
} from '../GhForgeMergeReadAdapter.adapter.js';

const VALID_SHA = '3dd5d90509461e3d2154b52da28671aeffa84130';
const NOW_ISO = '2026-11-01T12:00:00.000Z';

interface PageOverrides {
  state?: string;
  headRefOid?: string;
  mergeStateStatus?: string | null;
  contextsNodes?: unknown[];
  contextsHasNextPage?: boolean;
  contextsEndCursor?: string | null;
  threadsNodes?: unknown[];
  threadsHasNextPage?: boolean;
  threadsEndCursor?: string | null;
}

function page(overrides: PageOverrides = {}): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          state: overrides.state ?? 'OPEN',
          headRefOid: overrides.headRefOid ?? VALID_SHA,
          mergeStateStatus: 'mergeStateStatus' in overrides ? overrides.mergeStateStatus : 'CLEAN',
          statusCheckRollup: {
            contexts: {
              pageInfo: {
                hasNextPage: overrides.contextsHasNextPage ?? false,
                endCursor: overrides.contextsEndCursor ?? null,
              },
              nodes: overrides.contextsNodes ?? [],
            },
          },
          reviewThreads: {
            pageInfo: {
              hasNextPage: overrides.threadsHasNextPage ?? false,
              endCursor: overrides.threadsEndCursor ?? null,
            },
            nodes: overrides.threadsNodes ?? [],
          },
        },
      },
    },
  });
}

function checkRun(name: string, conclusion: string, login: string | null = null): Record<string, unknown> {
  return {
    __typename: 'CheckRun',
    name,
    status: 'COMPLETED',
    conclusion,
    creator: login === null ? null : { login },
  };
}

function statusContext(context: string, state: string, login: string | null = null): Record<string, unknown> {
  return {
    __typename: 'StatusContext',
    context,
    state,
    creator: login === null ? null : { login },
  };
}

const openThread = { isResolved: false };
const resolvedThread = { isResolved: true };

function makeRunGh(result: { exitCode: number; stdout: string; stderr: string }) {
  const calls: string[][] = [];
  const runGh = async (args: readonly string[]) => {
    calls.push([...args]);
    return result;
  };
  return { calls, runGh };
}

function makeAdapter(overrides: Partial<GhForgeMergeReadAdapterOptions> = {}) {
  const adapter = new GhForgeMergeReadAdapter({
    runGh: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
    now: () => Date.parse(NOW_ISO),
    ...overrides,
  });
  return adapter;
}

const BASE_REQUEST = {
  repository: { owner: 'example-owner', repo: 'example-repo' },
  pullRequestNumber: 202,
  headSha: VALID_SHA,
  requiredContexts: ['gate', 'premerge'],
  nowIso: NOW_ISO,
  deadlineIso: '2026-11-01T12:01:00.000Z',
};

describe('GhForgeMergeReadAdapter.readForgeMerge', () => {
  it('calls gh api graphql with the allow-listed argv, query and typed number', async () => {
    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: page(), stderr: '' });
    await makeAdapter({ runGh }).readForgeMerge(BASE_REQUEST);

    expect(calls).toHaveLength(1);
    const argv = calls[0];
    expect(argv.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(argv).toContain('-f');
    expect(argv).toContain('-F');
    expect(argv).toContain('owner=example-owner');
    expect(argv).toContain('repo=example-repo');
    expect(argv).toContain('number=202');
    expect(argv).not.toContain('contextsAfter=');
    expect(argv).not.toContain('threadsAfter=');
    const queryArg = argv.find((arg) => arg.startsWith('query='));
    expect(queryArg).toBeDefined();
    expect(queryArg).toContain('$contextsAfter');
    expect(queryArg).toContain('$threadsAfter');
    expect(queryArg).toContain('statusCheckRollup');
    expect(queryArg).toContain('reviewThreads');
    expect(queryArg).toContain('creator { login }');
    expect(queryArg).not.toMatch(/\.\.\.\s*on\s*CheckRun\s*\{[^}]*creator/);
  });

  it('records a required context absent from all pages as missing, not green', async () => {
    const { calls, runGh } = makeRunGh({
      exitCode: 0,
      stdout: page({ contextsNodes: [checkRun('gate', 'SUCCESS')] }),
      stderr: '',
    });
    const result = await makeAdapter({ runGh }).readForgeMerge(BASE_REQUEST);

    expect(result).toEqual({
      outcome: 'ok',
      prState: 'open',
      liveHeadSha: VALID_SHA,
      mergeState: 'clean',
      contexts: [
        { name: 'gate', state: 'SUCCESS', isGreen: true, creatorLogin: null },
        { name: 'premerge', state: 'missing', isGreen: false, creatorLogin: null },
      ],
      unresolvedThreads: 0,
    });
    expect(calls).toHaveLength(1);
  });

  it('reports a failure context as read and not green, distinct from missing', async () => {
    const { runGh } = makeRunGh({
      exitCode: 0,
      stdout: page({ contextsNodes: [checkRun('gate', 'FAILURE')] }),
      stderr: '',
    });
    const result = await makeAdapter({ runGh }).readForgeMerge({
      ...BASE_REQUEST,
      requiredContexts: ['gate'],
    });

    expect(result).toMatchObject({
      outcome: 'ok',
      contexts: [{ name: 'gate', state: 'FAILURE', isGreen: false }],
    });
  });

  it('treats SKIPPED and NEUTRAL required contexts as not green, reporting the state', async () => {
    const { runGh } = makeRunGh({
      exitCode: 0,
      stdout: page({
        contextsNodes: [checkRun('gate', 'SKIPPED'), statusContext('premerge', 'NEUTRAL')],
      }),
      stderr: '',
    });
    const result = await makeAdapter({ runGh }).readForgeMerge(BASE_REQUEST);

    expect(result).toMatchObject({
      outcome: 'ok',
      contexts: [
        { name: 'gate', state: 'SKIPPED', isGreen: false },
        { name: 'premerge', state: 'NEUTRAL', isGreen: false },
      ],
    });
  });

  it('reads 150 open threads across two pages, one call per page, passing the cursor', async () => {
    const page1 = page({
      contextsNodes: [checkRun('gate', 'SUCCESS')],
      threadsNodes: Array.from({ length: 100 }, () => openThread),
      threadsHasNextPage: true,
      threadsEndCursor: 't1',
    });
    const page2 = page({
      contextsNodes: [checkRun('gate', 'SUCCESS')],
      threadsNodes: Array.from({ length: 50 }, () => openThread),
    });
    const calls: string[][] = [];
    const responses = [page1, page2];
    const runGh = async (args: readonly string[]) => {
      calls.push([...args]);
      return { exitCode: 0, stdout: responses.shift() ?? '', stderr: '' };
    };

    const result = await makeAdapter({ runGh }).readForgeMerge({
      ...BASE_REQUEST,
      requiredContexts: ['gate'],
    });

    expect(result).toMatchObject({ outcome: 'ok', unresolvedThreads: 150 });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('-f');
    expect(calls[1]).toContain('threadsAfter=t1');
  });

  it('returns unknown threads, not a partial count, when a later threads page is malformed', async () => {
    const page1 = page({
      contextsNodes: [checkRun('gate', 'SUCCESS')],
      threadsNodes: Array.from({ length: 100 }, () => openThread),
      threadsHasNextPage: true,
      threadsEndCursor: 't1',
    });
    const page2 = page({
      contextsNodes: [checkRun('gate', 'SUCCESS')],
      threadsNodes: Array.from({ length: 50 }, () => openThread),
      threadsHasNextPage: true,
      threadsEndCursor: 't2',
    });
    const page3 = page({ contextsNodes: [checkRun('gate', 'SUCCESS')], threadsNodes: [null] });
    const responses = [page1, page2, page3];
    const runGh = async (_args: readonly string[]) => ({
      exitCode: 0,
      stdout: responses.shift() ?? '',
      stderr: '',
    });

    const result = await makeAdapter({ runGh }).readForgeMerge({
      ...BASE_REQUEST,
      requiredContexts: ['gate'],
    });

    expect(result).toEqual(expect.objectContaining({ outcome: 'ok', unresolvedThreads: 'unknown' }));
  });

  it('classifies a rejected delegate as forge-error, never echoing the error', async () => {
    const adapter = makeAdapter({
      runGh: async () => {
        throw new Error('gh not found in fixed locations');
      },
    });
    const result = await adapter.readForgeMerge(BASE_REQUEST);

    expect(result).toEqual({
      outcome: 'unavailable',
      code: 'forge-error',
      reason: 'gh api graphql could not complete',
    });
  });

  it('classifies a non-zero exit with stderr as forge-error, never echoing stderr', async () => {
    const { runGh } = makeRunGh({
      exitCode: 1,
      stdout: '',
      stderr: 'HTTP 401: Bad credentials (https://api.github.com/graphql)',
    });
    const result = await makeAdapter({ runGh }).readForgeMerge(BASE_REQUEST);

    expect(result).toEqual({
      outcome: 'unavailable',
      code: 'forge-error',
      reason: 'gh api graphql failed (exit 1)',
    });
  });

  it('classifies the pull-request resolve message as not-found, not forge-error', async () => {
    const { runGh } = makeRunGh({
      exitCode: 1,
      stdout: '',
      stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 999999. (repository.pullRequest)',
    });
    const result = await makeAdapter({ runGh }).readForgeMerge({
      ...BASE_REQUEST,
      pullRequestNumber: 999999,
    });

    expect(result).toEqual({ outcome: 'not-found' });
  });

  it('classifies parseable-but-shape-broken JSON as unreadable, not forge-error', async () => {
    const { runGh } = makeRunGh({
      exitCode: 0,
      stdout: '{"repository":{"pullRequest":{}}}',
      stderr: '',
    });
    const result = await makeAdapter({ runGh }).readForgeMerge(BASE_REQUEST);

    expect(result).toEqual({
      outcome: 'unavailable',
      code: 'unreadable',
      reason: 'gh api graphql returned an unreadable answer',
    });
  });

  it('classifies a malformed present required context as unknown, not missing', async () => {
    const { runGh } = makeRunGh({
      exitCode: 0,
      stdout: page({ contextsNodes: [checkRun('gate', 'SUCCESS'), null] }),
      stderr: '',
    });
    const result = await makeAdapter({ runGh }).readForgeMerge(BASE_REQUEST);

    expect(result).toEqual({
      outcome: 'unavailable',
      code: 'unknown',
      reason: 'a context node is malformed',
    });
  });

  it('returns budget-exhausted without issuing a call when under 2s remain', async () => {
    const calls: string[][] = [];
    const runGh = async (args: readonly string[]) => {
      calls.push([...args]);
      return { exitCode: 0, stdout: page(), stderr: '' };
    };
    const result = await makeAdapter({ runGh }).readForgeMerge({
      ...BASE_REQUEST,
      deadlineIso: '2026-11-01T12:00:01.000Z',
    });

    expect(result).toEqual({ outcome: 'budget-exhausted' });
    expect(calls).toEqual([]);
  });

  it('races a call that settles after the deadline to a deadline outcome, not an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const late = () =>
        new Promise<GhInvocationResult>((_resolve, reject) => {
          setTimeout(() => reject(new Error('late failure')), 40);
        });
      const adapter = makeAdapter({ runGh: late, timeoutMs: 10 });

      const result = await adapter.readForgeMerge(BASE_REQUEST);
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(result).toEqual({
        outcome: 'unavailable',
        code: 'forge-error',
        reason: 'gh api graphql timed out',
      });
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('does not count a premerge SUCCESS by another login as green', async () => {
    const { runGh } = makeRunGh({
      exitCode: 0,
      stdout: page({ contextsNodes: [checkRun('premerge', 'SUCCESS', 'other-login')] }),
      stderr: '',
    });
    const result = await makeAdapter({ runGh }).readForgeMerge({
      ...BASE_REQUEST,
      posterLogin: 'poster',
    });

    expect(result).toMatchObject({
      outcome: 'ok',
      contexts: expect.arrayContaining([
        expect.objectContaining({ name: 'premerge', state: 'SUCCESS', isGreen: false, creatorLogin: 'other-login' }),
      ]),
    });
  });

  it('counts a premerge SUCCESS by the poster login as green', async () => {
    const { runGh } = makeRunGh({
      exitCode: 0,
      stdout: page({ contextsNodes: [checkRun('premerge', 'SUCCESS', 'poster')] }),
      stderr: '',
    });
    const result = await makeAdapter({ runGh }).readForgeMerge({
      ...BASE_REQUEST,
      posterLogin: 'poster',
    });

    expect(result).toMatchObject({
      outcome: 'ok',
      contexts: expect.arrayContaining([
        expect.objectContaining({ name: 'premerge', state: 'SUCCESS', isGreen: true, creatorLogin: 'poster' }),
      ]),
    });
  });

  it('echoes headRefOid as liveHeadSha', async () => {
    const { runGh } = makeRunGh({ exitCode: 0, stdout: page(), stderr: '' });
    const result = await makeAdapter({ runGh }).readForgeMerge(BASE_REQUEST);

    expect(result).toMatchObject({ outcome: 'ok', liveHeadSha: VALID_SHA });
  });

  it.each([
    ['CLEAN', 'clean'],
    ['BEHIND', 'behind'],
    ['BLOCKED', 'blocked'],
    ['DIRTY', 'blocked'],
    ['UNSTABLE', 'blocked'],
    [null, 'unknown'],
  ])('maps mergeStateStatus %s to mergeState %s', async (status, expected) => {
    const { runGh } = makeRunGh({
      exitCode: 0,
      stdout: page({ mergeStateStatus: status as string | null }),
      stderr: '',
    });
    const result = await makeAdapter({ runGh }).readForgeMerge(BASE_REQUEST);

    expect(result).toMatchObject({ outcome: 'ok', mergeState: expected });
  });

  it('rejects a head oid that is not 40 hex as unknown', async () => {
    const { runGh } = makeRunGh({
      exitCode: 0,
      stdout: page({ headRefOid: 'a'.repeat(36) }),
      stderr: '',
    });
    const result = await makeAdapter({ runGh }).readForgeMerge(BASE_REQUEST);

    expect(result).toEqual({
      outcome: 'unavailable',
      code: 'unknown',
      reason: 'the head oid is not 40 hex',
    });
  });

  it('reads a required context that appears only on the second page, passing the cursor', async () => {
    const page1 = page({
      contextsNodes: [checkRun('gate', 'SUCCESS')],
      contextsHasNextPage: true,
      contextsEndCursor: 'c1',
    });
    const page2 = page({
      contextsNodes: [checkRun('premerge', 'SUCCESS', 'poster')],
    });
    const calls: string[][] = [];
    const responses = [page1, page2];
    const runGh = async (args: readonly string[]) => {
      calls.push([...args]);
      return { exitCode: 0, stdout: responses.shift() ?? '', stderr: '' };
    };

    const result = await makeAdapter({ runGh }).readForgeMerge({
      ...BASE_REQUEST,
      posterLogin: 'poster',
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('-f');
    expect(calls[1]).toContain('contextsAfter=c1');
    expect(result).toMatchObject({
      outcome: 'ok',
      contexts: [
        { name: 'gate', state: 'SUCCESS', isGreen: true },
        { name: 'premerge', state: 'SUCCESS', isGreen: true, creatorLogin: 'poster' },
      ],
    });
  });

  it('returns unavailable, not a partial set, when a later contexts page is unreadable', async () => {
    const page1 = page({
      contextsNodes: [checkRun('gate', 'SUCCESS')],
      contextsHasNextPage: true,
      contextsEndCursor: 'c1',
    });
    const broken = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            state: 'OPEN',
            headRefOid: VALID_SHA,
            mergeStateStatus: 'CLEAN',
            statusCheckRollup: {
              contexts: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: 'not-an-array' },
            },
            reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          },
        },
      },
    });
    const responses = [page1, broken];
    const runGh = async (_args: readonly string[]) => ({
      exitCode: 0,
      stdout: responses.shift() ?? '',
      stderr: '',
    });

    const result = await makeAdapter({ runGh }).readForgeMerge(BASE_REQUEST);

    expect(result).toEqual({
      outcome: 'unavailable',
      code: 'unreadable',
      reason: 'gh api graphql returned an unreadable contexts page',
    });
  });

  it('is unavailable without a runGh delegate, never running gh', async () => {
    const adapter = new GhForgeMergeReadAdapter();
    const result = await adapter.readForgeMerge(BASE_REQUEST);

    expect(result).toEqual({
      outcome: 'unavailable',
      code: 'forge-error',
      reason: 'merge read is not configured',
    });
  });

  it('is unavailable for an invalid repository or pull request number, never running gh', async () => {
    const calls: string[][] = [];
    const runGh = async (args: readonly string[]) => {
      calls.push([...args]);
      return { exitCode: 0, stdout: page(), stderr: '' };
    };
    const adapter = makeAdapter({ runGh });

    const badRepo = await adapter.readForgeMerge({
      ...BASE_REQUEST,
      repository: { owner: 'bad owner', repo: 'x' },
    });
    const badNumber = await adapter.readForgeMerge({ ...BASE_REQUEST, pullRequestNumber: 0 });

    expect(badRepo).toEqual({
      outcome: 'unavailable',
      code: 'forge-error',
      reason: 'forge repository is not configured or not valid',
    });
    expect(badNumber).toEqual({
      outcome: 'unavailable',
      code: 'forge-error',
      reason: 'pull request number is not valid',
    });
    expect(calls).toEqual([]);
  });

  it('fails with unreadable when a top-level errors array is present even with data', async () => {
    const payloadWithErrors = JSON.stringify({
      errors: [{ message: 'Field error' }],
      data: {
        repository: {
          pullRequest: {
            state: 'OPEN',
            headRefOid: VALID_SHA,
            mergeStateStatus: 'CLEAN',
            statusCheckRollup: null,
            reviewThreads: null,
          },
        },
      },
    });
    const { runGh } = makeRunGh({ exitCode: 0, stdout: payloadWithErrors, stderr: '' });
    const result = await makeAdapter({ runGh }).readForgeMerge(BASE_REQUEST);

    expect(result).toEqual({
      outcome: 'unavailable',
      code: 'unreadable',
      reason: 'gh api graphql returned an unreadable answer',
    });
  });

  it('does not select creator in the CheckRun fragment', async () => {
    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: page(), stderr: '' });
    await makeAdapter({ runGh }).readForgeMerge(BASE_REQUEST);

    const argv = calls[0];
    const queryArg = argv.find((arg) => arg.startsWith('query='));
    expect(queryArg).toBeDefined();
    expect(queryArg).not.toMatch(/\.\.\.\s*on\s*CheckRun\s*\{[^}]*creator/);
  });

  it('does not re-accumulate threads when contexts span more pages than threads', async () => {
    const page1 = page({
      contextsNodes: [checkRun('gate', 'SUCCESS')],
      contextsHasNextPage: true,
      contextsEndCursor: 'c1',
      threadsNodes: [openThread, openThread, openThread],
      threadsHasNextPage: false,
      threadsEndCursor: null,
    });
    const page2 = page({
      contextsNodes: [statusContext('premerge', 'SUCCESS', 'poster')],
      contextsHasNextPage: false,
      contextsEndCursor: null,
      threadsNodes: [openThread, openThread, openThread],
      threadsHasNextPage: false,
      threadsEndCursor: null,
    });
    const calls: string[][] = [];
    const responses = [page1, page2];
    const runGh = async (args: readonly string[]) => {
      calls.push([...args]);
      return { exitCode: 0, stdout: responses.shift() ?? '', stderr: '' };
    };

    const result = await makeAdapter({ runGh }).readForgeMerge({
      ...BASE_REQUEST,
      posterLogin: 'poster',
    });

    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({
      outcome: 'ok',
      unresolvedThreads: 3,
      contexts: [
        { name: 'gate', state: 'SUCCESS', isGreen: true },
        { name: 'premerge', state: 'SUCCESS', isGreen: true, creatorLogin: 'poster' },
      ],
    });
  });

  it('fails as unknown when hasNextPage is true but endCursor is null', async () => {
    const malformedPage = page({
      contextsHasNextPage: true,
      contextsEndCursor: null,
    });
    const { runGh } = makeRunGh({ exitCode: 0, stdout: malformedPage, stderr: '' });
    const result = await makeAdapter({ runGh }).readForgeMerge(BASE_REQUEST);

    expect(result).toEqual({
      outcome: 'unavailable',
      code: 'unknown',
      reason: 'pageInfo hasNextPage is true but endCursor is null',
    });
  });

  it('fails as unknown when headRefOid changes between pages', async () => {
    const OTHER_SHA = '1111111111111111111111111111111111111111';
    const page1 = page({
      headRefOid: VALID_SHA,
      contextsNodes: [checkRun('gate', 'SUCCESS')],
      contextsHasNextPage: true,
      contextsEndCursor: 'c1',
    });
    const page2 = page({
      headRefOid: OTHER_SHA,
      contextsNodes: [statusContext('premerge', 'SUCCESS', 'poster')],
      contextsHasNextPage: false,
    });
    const responses = [page1, page2];
    const runGh = async () => ({
      exitCode: 0,
      stdout: responses.shift() ?? '',
      stderr: '',
    });

    const result = await makeAdapter({ runGh }).readForgeMerge(BASE_REQUEST);

    expect(result).toEqual({
      outcome: 'unavailable',
      code: 'unknown',
      reason: 'the head oid changed between pages',
    });
  });

  it('fails as unknown when a finished threads connection changes in a replay (150-thread shape)', async () => {
    const responses = [
      page({
        contextsNodes: [checkRun('gate', 'SUCCESS')],
        contextsHasNextPage: true,
        contextsEndCursor: 'c1',
        threadsNodes: Array.from({ length: 150 }, () => resolvedThread),
      }),
      page({
        contextsNodes: [checkRun('other', 'SUCCESS')],
        threadsNodes: [...Array.from({ length: 149 }, () => resolvedThread), openThread],
      }),
    ];
    const runGh = async () => ({ exitCode: 0, stdout: responses.shift() ?? '', stderr: '' });
    const result = await makeAdapter({ runGh }).readForgeMerge({ ...BASE_REQUEST, requiredContexts: ['gate'] });
    expect(result).toMatchObject({ outcome: 'unavailable', code: 'unknown' });
  });

  it('fails as unknown when a finished contexts connection changes in a replay', async () => {
    const responses = [
      page({
        contextsNodes: [checkRun('gate', 'SUCCESS')],
        threadsNodes: Array.from({ length: 100 }, () => openThread),
        threadsHasNextPage: true,
        threadsEndCursor: 't1',
      }),
      page({
        contextsNodes: [checkRun('gate', 'FAILURE')],
        threadsNodes: Array.from({ length: 50 }, () => openThread),
      }),
    ];
    const runGh = async () => ({ exitCode: 0, stdout: responses.shift() ?? '', stderr: '' });
    const result = await makeAdapter({ runGh }).readForgeMerge({ ...BASE_REQUEST, requiredContexts: ['gate'] });
    expect(result).toMatchObject({ outcome: 'unavailable', code: 'unknown' });
  });

  it('does not count a premerge SUCCESS with absent creator as green', async () => {
    const { runGh } = makeRunGh({
      exitCode: 0,
      stdout: page({ contextsNodes: [statusContext('premerge', 'SUCCESS', null)] }),
      stderr: '',
    });
    const result = await makeAdapter({ runGh }).readForgeMerge({
      ...BASE_REQUEST,
      posterLogin: 'poster',
    });

    expect(result).toMatchObject({
      outcome: 'ok',
      contexts: expect.arrayContaining([
        expect.objectContaining({ name: 'premerge', state: 'SUCCESS', isGreen: false, creatorLogin: null }),
      ]),
    });
  });

  it('treats null reviewThreads as unknown, not zero unresolved threads', async () => {
    const payloadWithNullThreads = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            state: 'OPEN',
            headRefOid: VALID_SHA,
            mergeStateStatus: 'CLEAN',
            statusCheckRollup: {
              contexts: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [checkRun('gate', 'SUCCESS')],
              },
            },
            reviewThreads: null,
          },
        },
      },
    });
    const { runGh } = makeRunGh({ exitCode: 0, stdout: payloadWithNullThreads, stderr: '' });
    const result = await makeAdapter({ runGh }).readForgeMerge({
      ...BASE_REQUEST,
      requiredContexts: ['gate'],
    });

    expect(result).toMatchObject({
      outcome: 'ok',
      unresolvedThreads: 'unknown',
    });
  });

  it('updates prState and mergeState from a later page when the head oid matches', async () => {
    const page1 = page({
      contextsNodes: [checkRun('gate', 'SUCCESS')],
      contextsHasNextPage: true,
      contextsEndCursor: 'c1',
      mergeStateStatus: 'CLEAN',
      state: 'OPEN',
    });
    const page2 = page({
      contextsNodes: [statusContext('premerge', 'SUCCESS', 'poster')],
      contextsHasNextPage: false,
      mergeStateStatus: 'BLOCKED',
      state: 'CLOSED',
    });
    const responses = [page1, page2];
    const runGh = async () => ({
      exitCode: 0,
      stdout: responses.shift() ?? '',
      stderr: '',
    });

    const result = await makeAdapter({ runGh }).readForgeMerge({
      ...BASE_REQUEST,
      posterLogin: 'poster',
    });

    expect(result).toMatchObject({
      outcome: 'ok',
      prState: 'closed',
      mergeState: 'blocked',
    });
  });

  it('fails as unknown when hasNextPage is true but endCursor is an empty string', async () => {
    const malformedPage = page({
      contextsHasNextPage: true,
      contextsEndCursor: '',
    });
    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: malformedPage, stderr: '' });
    const result = await makeAdapter({ runGh }).readForgeMerge(BASE_REQUEST);

    expect(result).toEqual({
      outcome: 'unavailable',
      code: 'unknown',
      reason: 'pageInfo hasNextPage is true but endCursor is null',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain('contextsAfter=');
  });

  it('returns budget-exhausted when the clock advances under 2s before a second page', async () => {
    const page1 = page({
      contextsNodes: [checkRun('gate', 'SUCCESS')],
      contextsHasNextPage: true,
      contextsEndCursor: 'c1',
    });
    const page2 = page({
      contextsNodes: [statusContext('premerge', 'SUCCESS', 'poster')],
      contextsHasNextPage: false,
    });
    const calls: string[][] = [];
    const responses = [page1, page2];
    const runGh = async (args: readonly string[]) => {
      calls.push([...args]);
      return { exitCode: 0, stdout: responses.shift() ?? '', stderr: '' };
    };

    const startMs = Date.parse(NOW_ISO);
    let currentMs = startMs;
    const advancingRunGh = async (args: readonly string[]) => {
      const res = await runGh(args);
      currentMs = startMs + 9_000;
      return res;
    };
    const adapter = makeAdapter({
      runGh: advancingRunGh,
      now: () => currentMs,
    });

    const result = await adapter.readForgeMerge({
      ...BASE_REQUEST,
      deadlineIso: new Date(startMs + 10_000).toISOString(),
      posterLogin: 'poster',
    });

    expect(result).toEqual({ outcome: 'budget-exhausted' });
    expect(calls).toHaveLength(1);
  });
});

describe('GhForgeMergeReadAdapter.isConfigured', () => {
  it('is true only with a runGh delegate', () => {
    expect(new GhForgeMergeReadAdapter().isConfigured()).toBe(false);
    expect(makeAdapter().isConfigured()).toBe(true);
  });
});

describe('pure GraphQL parsers', () => {
  it('parseMergeContextsPage normalizes CheckRun and StatusContext nodes', () => {
    const result = parseMergeContextsPage(
      page({
        contextsNodes: [checkRun('gate', 'SUCCESS', 'runner'), statusContext('premerge', 'PENDING')],
      }),
    );
    expect(result).toEqual({
      kind: 'page',
      nodes: [
        { name: 'gate', state: 'SUCCESS', creatorLogin: 'runner' },
        { name: 'premerge', state: 'PENDING', creatorLogin: null },
      ],
      hasNextPage: false,
      endCursor: null,
    });
  });

  it('parseMergeContextsPage reports a malformed node as unknown', () => {
    const result = parseMergeContextsPage(page({ contextsNodes: [null] }));
    expect(result).toEqual({ kind: 'unknown', reason: 'a context node is malformed' });
  });

  it('parseReviewThreadsPage counts unresolved threads', () => {
    const result = parseReviewThreadsPage(
      page({ threadsNodes: [openThread, resolvedThread, openThread] }),
    );
    expect(result).toEqual({ kind: 'page', unresolved: 2, hasNextPage: false, endCursor: null });
  });

  it('parseMergePrMeta maps the PR state and head', () => {
    const result = parseMergePrMeta(page({ state: 'MERGED', mergeStateStatus: 'BLOCKED' }));
    expect(result).toEqual({
      kind: 'ok',
      prState: 'merged',
      liveHeadSha: VALID_SHA,
      mergeState: 'blocked',
    });
  });

  it('parseMergePrMeta rejects a head oid that is not 40 hex as unknown', () => {
    const result = parseMergePrMeta(page({ headRefOid: 'short' }));
    expect(result).toEqual({ kind: 'unknown', reason: 'the head oid is not 40 hex' });
  });

  it('parseMergeContextsPage reports pageInfo with hasNextPage true and null endCursor as unknown', () => {
    const result = parseMergeContextsPage(
      page({ contextsHasNextPage: true, contextsEndCursor: null }),
    );
    expect(result).toEqual({
      kind: 'unknown',
      reason: 'pageInfo hasNextPage is true but endCursor is null',
    });
  });

  it('parseReviewThreadsPage returns unreadable when reviewThreads is null', () => {
    const payload = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            state: 'OPEN',
            headRefOid: VALID_SHA,
            mergeStateStatus: 'CLEAN',
            reviewThreads: null,
          },
        },
      },
    });
    const result = parseReviewThreadsPage(payload);
    expect(result).toEqual({ kind: 'unreadable' });
  });

  it('parseMergeContextsPage reports pageInfo with hasNextPage true and empty string endCursor as unknown', () => {
    const result = parseMergeContextsPage(
      page({ contextsHasNextPage: true, contextsEndCursor: '' }),
    );
    expect(result).toEqual({
      kind: 'unknown',
      reason: 'pageInfo hasNextPage is true but endCursor is null',
    });
  });
});
