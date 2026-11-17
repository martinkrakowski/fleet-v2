// Lane OG-8a: ReviewThreadHelperPort behaviour through GhReviewThreadHelperAdapter.
import { describe, expect, it } from 'vitest';

import type {
  ListReviewThreadsRequest,
  ReplyToReviewThreadRequest,
  ResolveReviewThreadRequest,
} from '../../../application/ports/out/ReviewThreadHelperPort.out-port.js';
import type { GhInvocationResult } from '../ForgeActionAdapter.adapter.js';
import { GhReviewThreadHelperAdapter } from '../GhReviewThreadHelperAdapter.adapter.js';

const NOW_MS = Date.parse('2026-11-16T12:00:00.000Z');
const DEADLINE = new Date(NOW_MS + 60_000).toISOString();
const MAX_PAGES = 50;

type Node = Record<string, unknown>;

function thread(id: string, overrides: Node = {}): Node {
  return {
    id,
    isResolved: false,
    path: `src/${id}.ts`,
    line: 7,
    comments: { nodes: [{ body: `body of ${id}`, author: { login: 'reviewer' } }] },
    ...overrides,
  };
}

function listAnswer(nodes: readonly unknown[], options: { total?: number; hasNextPage?: boolean; endCursor?: unknown; extra?: Node } = {}): GhInvocationResult {
  return {
    exitCode: 0,
    stderr: '',
    stdout: JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              totalCount: options.total ?? nodes.length,
              pageInfo: {
                hasNextPage: options.hasNextPage ?? false,
                endCursor: options.endCursor === undefined ? null : options.endCursor,
              },
              nodes,
            },
            ...options.extra,
          },
        },
      },
    }),
  };
}

function checkAnswer(value: unknown): GhInvocationResult {
  return { exitCode: 0, stderr: '', stdout: JSON.stringify({ data: { node: value } }) };
}

function onThread(): Node {
  return {
    __typename: 'PullRequestReviewThread',
    id: 'PRRT_1',
    pullRequest: { number: 42, repository: { name: 'v2', owner: { login: 'fleet' } } },
  };
}

const REPLY_ANSWER: GhInvocationResult = {
  exitCode: 0,
  stderr: '',
  stdout: JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { id: 'IC_1' } } } }),
};

const RESOLVE_ANSWER: GhInvocationResult = {
  exitCode: 0,
  stderr: '',
  stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { id: 'PRRT_1', isResolved: true } } } }),
};

function listRequest(overrides: Partial<ListReviewThreadsRequest> = {}): ListReviewThreadsRequest {
  return { repository: { owner: 'fleet', repo: 'v2' }, pullRequestNumber: 42, deadlineIso: DEADLINE, ...overrides };
}

function replyRequest(overrides: Partial<ReplyToReviewThreadRequest> = {}): ReplyToReviewThreadRequest {
  return {
    repository: { owner: 'fleet', repo: 'v2' },
    pullRequestNumber: 42,
    deadlineIso: DEADLINE,
    threadId: 'PRRT_1',
    body: 'a reply',
    ...overrides,
  };
}

function resolveRequest(overrides: Partial<ResolveReviewThreadRequest> = {}): ResolveReviewThreadRequest {
  return {
    repository: { owner: 'fleet', repo: 'v2' },
    pullRequestNumber: 42,
    deadlineIso: DEADLINE,
    threadId: 'PRRT_1',
    ...overrides,
  };
}

function scripted(...answers: (GhInvocationResult | (() => never))[]) {
  const calls: { args: readonly string[]; timeoutMs: number | undefined }[] = [];
  const runGh = async (args: readonly string[], timeoutMs?: number): Promise<GhInvocationResult> => {
    calls.push({ args, timeoutMs });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    return typeof answer === 'function' ? answer() : answer;
  };
  return { calls, runGh };
}

function adapterFor(
  runGh: (args: readonly string[], timeoutMs?: number) => Promise<GhInvocationResult>,
  overrides: { now?: () => number; timeoutMs?: number } = {},
) {
  return new GhReviewThreadHelperAdapter({ runGh, now: overrides.now ?? (() => NOW_MS), timeoutMs: overrides.timeoutMs });
}

function argOf(args: readonly string[], prefix: string): string | undefined {
  const index = args.findIndex((arg) => arg.startsWith(prefix));
  return index === -1 ? undefined : args[index].slice(prefix.length);
}

describe('GhReviewThreadHelperAdapter', () => {
  it('returns unavailable unconfigured when runGh is omitted', async () => {
    const adapter = new GhReviewThreadHelperAdapter({ now: () => NOW_MS });
    expect(adapter.isConfigured()).toBe(false);
    expect(await adapter.listReviewThreads(listRequest())).toEqual({ outcome: 'unavailable', reason: 'unconfigured' });
    expect(await adapter.replyToReviewThread(replyRequest())).toEqual({ outcome: 'unavailable', reason: 'unconfigured' });
    expect(await adapter.resolveReviewThread(resolveRequest())).toEqual({ outcome: 'unavailable', reason: 'unconfigured' });
  });

  it('rejects invalid repository or pullRequestNumber with invalid-input and zero gh calls', async () => {
    for (const request of [
      listRequest({ repository: { owner: 'fleet/x', repo: 'v2' } }),
      listRequest({ repository: { owner: 'fleet', repo: 'v 2' } }),
      listRequest({ pullRequestNumber: 0 }),
      listRequest({ pullRequestNumber: 1.5 }),
      listRequest({ pullRequestNumber: Number.NaN }),
      listRequest({ pullRequestNumber: '42' as unknown as number }),
      replyRequest({ threadId: '   ' }),
      resolveRequest({ threadId: '' }),
      listRequest({ deadlineIso: 'not-a-date' }),
      listRequest({ deadlineIso: '' }),
    ]) {
      const { calls, runGh } = scripted(listAnswer([thread('PRRT_1')]));
      const run = request.deadlineIso !== undefined && 'threadId' in request && request.threadId !== undefined
        ? (request as ReplyToReviewThreadRequest).body !== undefined
          ? adapterFor(runGh).replyToReviewThread(request as ReplyToReviewThreadRequest)
          : adapterFor(runGh).resolveReviewThread(request as ResolveReviewThreadRequest)
        : adapterFor(runGh).listReviewThreads(request as ListReviewThreadsRequest);
      expect(await run).toEqual({ outcome: 'refused', code: 'invalid-input', reason: 'request is not valid' });
      expect(calls).toHaveLength(0);
    }
  });

  it('handles throwing getters on request without crashing', async () => {
    const request = {
      get repository(): never {
        throw new Error('getter trap');
      },
      get pullRequestNumber(): never {
        throw new Error('getter trap');
      },
      get deadlineIso(): never {
        throw new Error('getter trap');
      },
    };
    const { calls, runGh } = scripted(listAnswer([thread('PRRT_1')]));
    expect(await adapterFor(runGh).listReviewThreads(request as unknown as ListReviewThreadsRequest)).toEqual({
      outcome: 'refused',
      code: 'invalid-input',
      reason: 'request is not valid',
    });
    expect(calls).toHaveLength(0);
  });

  it('an empty, oversized or control-character body is invalid-input with zero gh calls', async () => {
    for (const body of ['', '   ', 'x'.repeat(8001), 'a\rb', 'a\x00b', 'a\x1bb', 'a\x7fb', 42 as unknown as string]) {
      const { calls, runGh } = scripted(checkAnswer(onThread()), REPLY_ANSWER);
      expect(await adapterFor(runGh).replyToReviewThread(replyRequest({ body }))).toEqual({
        outcome: 'refused',
        code: 'invalid-input',
        reason: 'request is not valid',
      });
      expect(calls).toHaveLength(0);
    }
  });

  it('an under-2-second deadline makes no call', async () => {
    const { calls, runGh } = scripted(listAnswer([thread('PRRT_1')]));
    expect(
      await adapterFor(runGh).listReviewThreads(
        listRequest({ deadlineIso: new Date(NOW_MS + 1_999).toISOString() }),
      ),
    ).toEqual({ outcome: 'unavailable', reason: 'budget-exhausted' });
    expect(calls).toHaveLength(0);

    // The budget is re-checked before the mutation, after the ownership
    // check: the wall clock advances 600 ms per gh call, so with a deadline
    // 2_500 ms out the check call sees 2_500 ms and the mutation only
    // 1_900 ms — refused with the check as the single gh call.
    const check = scripted(checkAnswer(onThread()), REPLY_ANSWER);
    const adapter = adapterFor(check.runGh, { now: () => NOW_MS + 600 * check.calls.length });
    expect(
      await adapter.replyToReviewThread(replyRequest({ deadlineIso: new Date(NOW_MS + 2_500).toISOString() })),
    ).toEqual({ outcome: 'unavailable', reason: 'budget-exhausted' });
    expect(check.calls).toHaveLength(1);
    expect(JSON.stringify(check.calls[0]!.args)).not.toContain('addPullRequestReviewThreadReply');

    // Exactly 2_000 ms remaining is still enough to start a call.
    const boundary = scripted(listAnswer([thread('PRRT_1')]));
    expect(
      await adapterFor(boundary.runGh).listReviewThreads(
        listRequest({ deadlineIso: new Date(NOW_MS + 2_000).toISOString() }),
      ),
    ).toMatchObject({ outcome: 'ok' });
  });

  it('returns unavailable timeout when gh exceeds call budget', async () => {
    const pending = () => new Promise<GhInvocationResult>(() => {});
    const calls: { args: readonly string[] }[] = [];
    const runGh = async (args: readonly string[]): Promise<GhInvocationResult> => {
      calls.push({ args });
      return pending();
    };
    expect(await adapterFor(runGh, { timeoutMs: 50 }).listReviewThreads(listRequest())).toEqual({
      outcome: 'unavailable',
      reason: 'timeout',
    });
    expect(calls).toHaveLength(1);
  });

  it('stderr never appears in a result', async () => {
    const failing: GhInvocationResult = { exitCode: 1, stderr: 'gh: secret token details', stdout: '' };
    const { calls, runGh } = scripted(failing);
    const adapter = adapterFor(runGh);
    expect(JSON.stringify(await adapter.listReviewThreads(listRequest()))).not.toContain('secret token details');
    expect(JSON.stringify(await adapter.replyToReviewThread(replyRequest()))).not.toContain('secret token details');
    expect(JSON.stringify(await adapter.resolveReviewThread(resolveRequest()))).not.toContain('secret token details');
    expect(calls).toHaveLength(3);
  });

  it('returns unavailable forge-error on empty stdout or rejected runGh', async () => {
    const { calls, runGh } = scripted(
      { exitCode: 0, stderr: '', stdout: '   ' },
      { exitCode: 1, stderr: 'boom', stdout: '' },
    );
    const adapter = adapterFor(runGh);
    expect(await adapter.listReviewThreads(listRequest())).toEqual({ outcome: 'unavailable', reason: 'forge-error' });
    expect(await adapter.listReviewThreads(listRequest())).toEqual({ outcome: 'unavailable', reason: 'forge-error' });
    expect(calls).toHaveLength(2);

    const rejecting = async (): Promise<GhInvocationResult> => {
      throw new Error('spawn failed with secrets');
    };
    expect(await adapterFor(rejecting).listReviewThreads(listRequest())).toEqual({
      outcome: 'unavailable',
      reason: 'forge-error',
    });
    expect(await adapterFor(rejecting).resolveReviewThread(resolveRequest())).toEqual({
      outcome: 'unavailable',
      reason: 'forge-error',
    });
  });

  it('pagination follows cursors and a short page is unreadable', async () => {
    const first = Array.from({ length: 3 }, (_, i) => thread(`PRRT_${i}`));
    const second = [thread('PRRT_z')];
    const { calls, runGh } = scripted(
      listAnswer(first, { total: 4, hasNextPage: true, endCursor: 'cursor-1' }),
      listAnswer(second, { total: 4, hasNextPage: false }),
    );
    const result = await adapterFor(runGh).listReviewThreads(listRequest());
    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.threads.map((t) => t.threadId)).toEqual(['PRRT_0', 'PRRT_1', 'PRRT_2', 'PRRT_z']);
    }
    expect(argOf(calls[0]!.args, 'after=')).toBeUndefined();
    expect(argOf(calls[1]!.args, 'after=')).toBe('cursor-1');

    const short = scripted(
      listAnswer(first, { total: 7, hasNextPage: true, endCursor: 'cursor-1' }),
      listAnswer(second, { total: 7, hasNextPage: false }),
    );
    expect(await adapterFor(short.runGh).listReviewThreads(listRequest())).toEqual({
      outcome: 'unavailable',
      reason: 'unreadable',
    });
  });

  it('returns unavailable unreadable on null fields, non-array nodes, and malformed records', async () => {
    const raw = (value: unknown): GhInvocationResult => ({ exitCode: 0, stderr: '', stdout: JSON.stringify(value) });
    const answers: unknown[] = [
      'not json',
      { errors: [{ message: 'bad' }] },
      { data: null },
      { data: {} },
      { data: { repository: null } },
      { data: { repository: { pullRequest: null } } },
      { data: { repository: { pullRequest: { reviewThreads: null } } } },
      { data: { repository: { pullRequest: { reviewThreads: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: 'nope' } } } } },
      { data: { repository: { pullRequest: { reviewThreads: { totalCount: 1, nodes: [thread('PRRT_1')] } } } } },
      { data: { repository: { pullRequest: { reviewThreads: { totalCount: 1, pageInfo: { hasNextPage: true, endCursor: null }, nodes: [thread('PRRT_1')] } } } } },
      { data: { repository: { pullRequest: { reviewThreads: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [{ id: '' }] } } } } },
      { data: { repository: { pullRequest: { reviewThreads: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [thread('PRRT_1', { comments: { nodes: 'nope' } })] } } } } },
      { data: { repository: { pullRequest: { reviewThreads: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [thread('PRRT_1', { comments: { nodes: [{ body: 7 }] } })] } } } } },
      { data: { repository: { pullRequest: { reviewThreads: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [thread('PRRT_1', { isResolved: 'yes' })] } } } } },
      { data: { repository: { pullRequest: { reviewThreads: { totalCount: -1, pageInfo: { hasNextPage: false }, nodes: [] } } } } },
    ];
    for (const answer of answers) {
      const { runGh } = scripted(raw(answer));
      expect(await adapterFor(runGh).listReviewThreads(listRequest())).toEqual({
        outcome: 'unavailable',
        reason: 'unreadable',
      });
    }

    // A count that changes between pages is unreadable.
    const drifting = scripted(
      listAnswer([thread('PRRT_1')], { total: 1, hasNextPage: true, endCursor: 'cursor-1' }),
      listAnswer([thread('PRRT_2')], { total: 2, hasNextPage: false }),
    );
    expect(await adapterFor(drifting.runGh).listReviewThreads(listRequest())).toEqual({
      outcome: 'unavailable',
      reason: 'unreadable',
    });
  });

  it('a thread id repeated across pages is unreadable even when the length matches totalCount', async () => {
    // Two pages each return thread A while totalCount is 2: the naive
    // threads.length === totalCount check would pass and drop thread B.
    const duplicated = scripted(
      listAnswer([thread('PRRT_A')], { total: 2, hasNextPage: true, endCursor: 'cursor-1' }),
      listAnswer([thread('PRRT_A')], { total: 2, hasNextPage: false }),
    );
    expect(await adapterFor(duplicated.runGh).listReviewThreads(listRequest())).toEqual({
      outcome: 'unavailable',
      reason: 'unreadable',
    });
    // The same id twice on a single page is equally a repetition.
    const samePage = scripted(
      listAnswer([thread('PRRT_A'), thread('PRRT_A')], { total: 2, hasNextPage: false }),
    );
    expect(await adapterFor(samePage.runGh).listReviewThreads(listRequest())).toEqual({
      outcome: 'unavailable',
      reason: 'unreadable',
    });
    // Distinct ids across pages remain a complete list.
    const distinct = scripted(
      listAnswer([thread('PRRT_A')], { total: 2, hasNextPage: true, endCursor: 'cursor-1' }),
      listAnswer([thread('PRRT_B')], { total: 2, hasNextPage: false }),
    );
    const result = await adapterFor(distinct.runGh).listReviewThreads(listRequest());
    expect(result.outcome).toBe('ok');
  });

  it('refuses thread-not-found before any mutation', async () => {
    for (const node of [null, { __typename: 'Issue' }]) {
      const { calls, runGh } = scripted(checkAnswer(node), REPLY_ANSWER);
      expect(await adapterFor(runGh).replyToReviewThread(replyRequest())).toEqual({
        outcome: 'refused',
        code: 'thread-not-found',
        reason: 'review thread not found',
      });
      expect(calls).toHaveLength(1);
      expect(JSON.stringify(calls[0]!.args)).not.toContain('addPullRequestReviewThreadReply');
    }
    const resolveCalls = scripted(checkAnswer(null), RESOLVE_ANSWER);
    expect(await adapterFor(resolveCalls.runGh).resolveReviewThread(resolveRequest())).toMatchObject({
      outcome: 'refused',
      code: 'thread-not-found',
    });
    expect(resolveCalls.calls).toHaveLength(1);
  });

  it('a thread of another pull request is refused before any mutation', async () => {
    const elsewhere = {
      __typename: 'PullRequestReviewThread',
      id: 'PRRT_1',
      pullRequest: { number: 43, repository: { name: 'v2', owner: { login: 'fleet' } } },
    };
    const { calls, runGh } = scripted(checkAnswer(elsewhere), REPLY_ANSWER);
    expect(await adapterFor(runGh).replyToReviewThread(replyRequest())).toEqual({
      outcome: 'refused',
      code: 'thread-not-on-pull-request',
      reason: 'review thread belongs to another pull request',
    });
    expect(calls).toHaveLength(1);

    const otherRepo = {
      __typename: 'PullRequestReviewThread',
      id: 'PRRT_1',
      pullRequest: { number: 42, repository: { name: 'other', owner: { login: 'fleet' } } },
    };
    const resolveCalls = scripted(checkAnswer(otherRepo), RESOLVE_ANSWER);
    expect(await adapterFor(resolveCalls.runGh).resolveReviewThread(resolveRequest())).toMatchObject({
      outcome: 'refused',
      code: 'thread-not-on-pull-request',
    });
    expect(resolveCalls.calls).toHaveLength(1);
  });

  it('owner and repo that differ from the request only by letter case pass the ownership check', async () => {
    const reply = scripted(checkAnswer(onThread()), REPLY_ANSWER);
    expect(
      await adapterFor(reply.runGh).replyToReviewThread(
        replyRequest({ repository: { owner: 'Fleet', repo: 'V2' } }),
      ),
    ).toEqual({ outcome: 'ok', commentId: 'IC_1' });
    expect(reply.calls).toHaveLength(2);

    const resolve = scripted(checkAnswer(onThread()), RESOLVE_ANSWER);
    expect(
      await adapterFor(resolve.runGh).resolveReviewThread(
        resolveRequest({ repository: { owner: 'Fleet', repo: 'V2' } }),
      ),
    ).toEqual({ outcome: 'ok', isResolved: true });
    expect(resolve.calls).toHaveLength(2);
  });

  it('a forge owner outside the repository pattern is refused even when its lower case equals the request', async () => {
    const check = { ...onThread(), pullRequest: { number: 42, repository: { name: 'v2', owner: { login: '\u212Aleet' } } } };
    const { calls, runGh } = scripted(checkAnswer(check), REPLY_ANSWER);
    expect(
      await adapterFor(runGh).replyToReviewThread(
        replyRequest({ repository: { owner: 'kleet', repo: 'v2' } }),
      ),
    ).toEqual({
      outcome: 'refused',
      code: 'thread-not-on-pull-request',
      reason: 'review thread belongs to another pull request',
    });
    expect(calls).toHaveLength(1);
  });

  it('an ownership check naming another thread id is thread-not-found before any mutation', async () => {
    // The check query returns a well-formed PullRequestReviewThread whose
    // pull request matches the request, but its node id is not the requested
    // thread: the response must not pass the ownership check.
    const impostor = {
      __typename: 'PullRequestReviewThread',
      id: 'PRRT_OTHER',
      pullRequest: { number: 42, repository: { name: 'v2', owner: { login: 'fleet' } } },
    };
    const replyCalls = scripted(checkAnswer(impostor), REPLY_ANSWER);
    expect(await adapterFor(replyCalls.runGh).replyToReviewThread(replyRequest())).toEqual({
      outcome: 'refused',
      code: 'thread-not-found',
      reason: 'review thread not found',
    });
    expect(replyCalls.calls).toHaveLength(1);
    expect(JSON.stringify(replyCalls.calls[0]!.args)).not.toContain('addPullRequestReviewThreadReply');

    const resolveCalls = scripted(checkAnswer(impostor), RESOLVE_ANSWER);
    expect(await adapterFor(resolveCalls.runGh).resolveReviewThread(resolveRequest())).toEqual({
      outcome: 'refused',
      code: 'thread-not-found',
      reason: 'review thread not found',
    });
    expect(resolveCalls.calls).toHaveLength(1);
    expect(JSON.stringify(resolveCalls.calls[0]!.args)).not.toContain('resolveReviewThread(input');

    // The matching id still passes.
    const honest = scripted(checkAnswer(onThread()), RESOLVE_ANSWER);
    expect(await adapterFor(honest.runGh).resolveReviewThread(resolveRequest())).toEqual({
      outcome: 'ok',
      isResolved: true,
    });
  });

  it('reply makes exactly one call', async () => {
    const { calls, runGh } = scripted(checkAnswer(onThread()), REPLY_ANSWER);
    expect(await adapterFor(runGh).replyToReviewThread(replyRequest())).toEqual({ outcome: 'ok', commentId: 'IC_1' });
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1]!.args)).toContain('addPullRequestReviewThreadReply');
    expect(argOf(calls[1]!.args, 'threadId=')).toBe('PRRT_1');
    expect(argOf(calls[1]!.args, 'body=')).toBe('a reply');
  });

  it('resolve makes exactly one call', async () => {
    const { calls, runGh } = scripted(checkAnswer(onThread()), RESOLVE_ANSWER);
    expect(await adapterFor(runGh).resolveReviewThread(resolveRequest())).toEqual({ outcome: 'ok', isResolved: true });
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1]!.args)).toContain('resolveReviewThread');
    expect(argOf(calls[1]!.args, 'threadId=')).toBe('PRRT_1');
  });

  it('a reply mutation response with non-empty errors and partial data is rejected as unavailable', async () => {
    const erroredReply: GhInvocationResult = {
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        data: { addPullRequestReviewThreadReply: { comment: { id: 'IC_1' } } },
        errors: [{ message: 'comment could not be persisted' }],
      }),
    };
    const { calls, runGh } = scripted(checkAnswer(onThread()), erroredReply);
    expect(await adapterFor(runGh).replyToReviewThread(replyRequest())).toEqual({ outcome: 'unavailable', reason: 'unreadable' });
    expect(calls).toHaveLength(2);
  });

  it('a resolve mutation response with non-empty errors and partial data is rejected as unavailable', async () => {
    const erroredResolve: GhInvocationResult = {
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        data: { resolveReviewThread: { thread: { id: 'PRRT_1', isResolved: true } } },
        errors: [{ message: 'thread state is uncertain' }],
      }),
    };
    const { calls, runGh } = scripted(checkAnswer(onThread()), erroredResolve);
    expect(await adapterFor(runGh).resolveReviewThread(resolveRequest())).toEqual({ outcome: 'unavailable', reason: 'unreadable' });
    expect(calls).toHaveLength(2);
  });

  it('the body never appears in the query text', async () => {
    const body = 'DROP TABLE papers; \u2713 unicode too';
    const { calls, runGh } = scripted(checkAnswer(onThread()), REPLY_ANSWER);
    expect(await adapterFor(runGh).replyToReviewThread(replyRequest({ body }))).toEqual({ outcome: 'ok', commentId: 'IC_1' });
    const queryText = argOf(calls[1]!.args, 'query=') ?? '';
    expect(queryText).not.toContain(body);
    expect(argOf(calls[1]!.args, 'body=')).toBe(body);
  });

  it('a thread with no comments or a null line is listed as typed fields, bodies capped at 2000 characters', async () => {
    const long = 'b'.repeat(2500);
    const { runGh } = scripted(
      listAnswer([
        thread('PRRT_long', { line: null, comments: { nodes: [{ body: long, author: { login: 'owl' } }] } }),
        thread('PRRT_empty', { comments: { nodes: [] } }),
        thread('PRRT_noauthor', { comments: { nodes: [{ body: 'text' }] } }),
      ]),
    );
    const result = await adapterFor(runGh).listReviewThreads(listRequest());
    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.threads).toEqual([
        { threadId: 'PRRT_long', isResolved: false, path: 'src/PRRT_long.ts', line: null, author: 'owl', body: 'b'.repeat(2000) },
        { threadId: 'PRRT_empty', isResolved: false, path: 'src/PRRT_empty.ts', line: 7, author: null, body: '' },
        { threadId: 'PRRT_noauthor', isResolved: false, path: 'src/PRRT_noauthor.ts', line: 7, author: null, body: 'text' },
      ]);
    }
  });

  it('too many pages or oversized stdout is unreadable', async () => {
    // A repeated cursor ends the walk before MAX_PAGES.
    const repeated = scripted(
      listAnswer([thread('PRRT_0')], { total: 2, hasNextPage: true, endCursor: 'cursor' }),
      listAnswer([thread('PRRT_1')], { total: 2, hasNextPage: true, endCursor: 'cursor' }),
    );
    expect(await adapterFor(repeated.runGh).listReviewThreads(listRequest())).toEqual({
      outcome: 'unavailable',
      reason: 'unreadable',
    });

    // Fifty distinct pages are walked; the walk stops at the bound before
    // fetching a fifty-first page.
    const pages = Array.from({ length: 60 }, (_, i) =>
      listAnswer([thread(`PRRT_${i}`)], { total: 60, hasNextPage: true, endCursor: `cursor-${i}` }),
    );
    const bounded = scripted(...pages);
    expect(await adapterFor(bounded.runGh).listReviewThreads(listRequest())).toEqual({
      outcome: 'unavailable',
      reason: 'unreadable',
    });
    expect(bounded.calls).toHaveLength(MAX_PAGES);

    const big = {
      data: {
        repository: {
          pullRequest: {
            padding: 'x'.repeat(1_100_000),
            reviewThreads: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [thread('PRRT_1')] },
          },
        },
      },
    };
    const oversized = scripted({ exitCode: 0, stderr: '', stdout: JSON.stringify(big) });
    expect(await adapterFor(oversized.runGh).listReviewThreads(listRequest())).toEqual({
      outcome: 'unavailable',
      reason: 'unreadable',
    });
  });

  describe('hostile input', () => {
    it('null and undefined requests and repository fields are invalid-input with zero gh calls', async () => {
      const { calls, runGh } = scripted(listAnswer([thread('PRRT_1')]));
      const adapter = adapterFor(runGh);
      for (const request of [null, undefined, {}, { repository: null }, { repository: { owner: null, repo: 'v2' } }]) {
        expect(await adapter.listReviewThreads(request as unknown as ListReviewThreadsRequest)).toEqual({
          outcome: 'refused',
          code: 'invalid-input',
          reason: 'request is not valid',
        });
      }
      expect(calls).toHaveLength(0);
    });

    it('a non-iterable, an array-like with a lying length, and array holes in review thread nodes are unreadable', async () => {
      // A non-array object posing as a node list.
      const lying = scripted(
        listAnswer(Object.assign({ length: 3 }, { 0: thread('PRRT_1') }) as unknown as unknown[]),
      );
      expect(await adapterFor(lying.runGh).listReviewThreads(listRequest())).toEqual({
        outcome: 'unavailable',
        reason: 'unreadable',
      });

      // A sparse array: the hole reaches the parser as undefined.
      const sparse = new Array(3);
      sparse[0] = thread('PRRT_1');
      sparse[2] = thread('PRRT_3');
      const holed = scripted(listAnswer(sparse, { total: 3 }));
      expect(await adapterFor(holed.runGh).listReviewThreads(listRequest())).toEqual({
        outcome: 'unavailable',
        reason: 'unreadable',
      });
    });

    it('a hostile Proxy request with throwing getters is invalid-input without crashing', async () => {
      const hostile = new Proxy(
        {},
        {
          get(): never {
            throw new Error('proxy trap');
          },
          getOwnPropertyDescriptor(): never {
            throw new Error('proxy trap');
          },
        },
      );
      const { calls, runGh } = scripted(listAnswer([thread('PRRT_1')]));
      expect(await adapterFor(runGh).listReviewThreads(hostile as unknown as ListReviewThreadsRequest)).toEqual({
        outcome: 'refused',
        code: 'invalid-input',
        reason: 'request is not valid',
      });
      expect(calls).toHaveLength(0);
    });

    it('prototype-polluting keys on the request and in the answer are inert', async () => {
      const polluted: Node = { repository: { owner: 'fleet', repo: 'v2' }, pullRequestNumber: 42, deadlineIso: DEADLINE };
      Object.defineProperty(polluted, '__proto__', { value: { owner: 'evil', repo: 'evil' }, enumerable: true, configurable: true });
      Object.defineProperty(polluted, 'constructor', { get() { throw new Error('polluting getter'); }, configurable: true });
      const { calls, runGh } = scripted(listAnswer([thread('PRRT_1')]));
      expect(await adapterFor(runGh).listReviewThreads(polluted as unknown as ListReviewThreadsRequest)).toMatchObject({
        outcome: 'ok',
      });
      expect(calls).toHaveLength(1);

      // A thread node carrying polluting keys is parsed by its own fields only.
      const answerThread = thread('PRRT_1');
      Object.defineProperty(answerThread, '__proto__', { value: { id: 'PRRT_evil' }, enumerable: true, configurable: true });
      const answer = scripted(listAnswer([answerThread]));
      expect(await adapterFor(answer.runGh).listReviewThreads(listRequest())).toMatchObject({
        outcome: 'ok',
        threads: [{ threadId: 'PRRT_1' }],
      });
    });

    it('a reply body at the 8000-character boundary is accepted and one over it is refused', async () => {
      const atLimit = 'x'.repeat(8000);
      const accepted = scripted(checkAnswer(onThread()), REPLY_ANSWER);
      expect(await adapterFor(accepted.runGh).replyToReviewThread(replyRequest({ body: atLimit }))).toEqual({
        outcome: 'ok',
        commentId: 'IC_1',
      });
      expect(argOf(accepted.calls[1]!.args, 'body=')).toBe(atLimit);

      const overLimit = 'x'.repeat(8001);
      const refusedCall = scripted(checkAnswer(onThread()), REPLY_ANSWER);
      expect(await adapterFor(refusedCall.runGh).replyToReviewThread(replyRequest({ body: overLimit }))).toEqual({
        outcome: 'refused',
        code: 'invalid-input',
        reason: 'request is not valid',
      });
      expect(refusedCall.calls).toHaveLength(0);
    });
  });
});
