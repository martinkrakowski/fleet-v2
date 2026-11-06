// Lane CO24: read-only review-thread reader behind PullRequestFindingsReadPort.
import { describe, expect, it } from 'vitest';

import type { PullRequestFindingsRequest } from '../../../application/ports/out/PullRequestFindingsReadPort.out-port.js';
import type { GhInvocationResult } from '../ForgeActionAdapter.adapter.js';
import { PullRequestFindingsReadAdapter } from '../PullRequestFindingsReadAdapter.adapter.js';

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const NOW_MS = Date.parse('2026-11-06T12:00:00.000Z');

type Node = Record<string, unknown>;

function thread(id: string, overrides: Node = {}): Node {
  return {
    id,
    isResolved: false,
    path: `src/${id}.ts`,
    line: 7,
    comments: { nodes: [{ body: `body of ${id}`, author: { __typename: 'User' } }] },
    ...overrides,
  };
}

function page(
  nodes: readonly unknown[],
  options: { head?: string; state?: unknown; total?: number; hasNextPage?: boolean; endCursor?: string | null } = {},
): GhInvocationResult {
  return {
    exitCode: 0,
    stderr: '',
    stdout: JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            state: options.state === undefined ? 'OPEN' : options.state,
            headRefOid: options.head ?? HEAD,
            reviewThreads: {
              totalCount: options.total ?? nodes.length,
              pageInfo: {
                hasNextPage: options.hasNextPage ?? false,
                endCursor: options.endCursor === undefined ? null : options.endCursor,
              },
              nodes,
            },
          },
        },
      },
    }),
  };
}

function request(overrides: Partial<PullRequestFindingsRequest> = {}): PullRequestFindingsRequest {
  return {
    repository: { owner: 'fleet', repo: 'v2' },
    pullRequestNumber: 42,
    expectedHeadSha: HEAD,
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

function adapterFor(runGh: (args: readonly string[], timeoutMs?: number) => Promise<GhInvocationResult>) {
  return new PullRequestFindingsReadAdapter({ runGh, now: () => NOW_MS });
}

describe('PullRequestFindingsReadAdapter', () => {
  it('reads unresolved review threads at the exact head through one read-only gh api graphql call', async () => {
    const { calls, runGh } = scripted(
      page([
        thread('PRRT_a'),
        thread('PRRT_b', { isResolved: true }),
        thread('PRRT_c', {
          line: null,
          comments: { nodes: [{ body: 'bot says', author: { __typename: 'Bot' } }] },
        }),
      ]),
    );

    const result = await adapterFor(runGh).readPullRequestFindings(request());

    expect(result).toEqual({
      outcome: 'available',
      headSha: HEAD,
      findings: [
        {
          threadId: 'PRRT_a',
          path: 'src/PRRT_a.ts',
          line: 7,
          authorKind: 'user',
          state: 'unresolved',
          text: 'body of PRRT_a',
        },
        {
          threadId: 'PRRT_c',
          path: 'src/PRRT_c.ts',
          line: null,
          authorKind: 'bot',
          state: 'unresolved',
          text: 'bot says',
        },
      ],
    });
    expect(calls).toHaveLength(1);
    const args = calls[0].args;
    expect(args.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(args).toContain('owner=fleet');
    expect(args).toContain('name=v2');
    expect(args).toContain('number=42');
    expect(args.some((arg) => arg.startsWith('after='))).toBe(false);
    const query = args.find((arg) => arg.startsWith('query=')) ?? '';
    expect(query).toContain('reviewThreads(first: 100, after: $after)');
    expect(query).toContain('headRefOid');
    expect(query).toMatch(/pullRequest\(number: \$number\) \{\s+state/);
    expect(query).toContain('totalCount');
    expect(calls[0].timeoutMs).toBe(30_000);
  });

  it('follows the cursor until every page is read', async () => {
    const { calls, runGh } = scripted(
      page([thread('PRRT_1'), thread('PRRT_2')], { total: 3, hasNextPage: true, endCursor: 'cursor-1' }),
      page([thread('PRRT_3')], { total: 3 }),
    );

    const result = await adapterFor(runGh).readPullRequestFindings(request());

    expect(calls).toHaveLength(2);
    expect(calls[0].args.some((arg) => arg.startsWith('after='))).toBe(false);
    expect(calls[1].args).toContain('after=cursor-1');
    expect(result.outcome).toBe('available');
    if (result.outcome === 'available') {
      expect(result.findings.map((entry) => entry.threadId)).toEqual(['PRRT_1', 'PRRT_2', 'PRRT_3']);
    }
  });

  it('reports a partial page as unavailable instead of an empty list', async () => {
    const short = adapterFor(scripted(page([thread('PRRT_1')], { total: 3 })).runGh);
    expect(await short.readPullRequestFindings(request())).toMatchObject({
      outcome: 'unavailable',
      code: 'partial-page',
    });

    const noCursor = adapterFor(scripted(page([thread('PRRT_1')], { total: 2, hasNextPage: true })).runGh);
    expect(await noCursor.readPullRequestFindings(request())).toMatchObject({
      outcome: 'unavailable',
      code: 'partial-page',
    });

    const shifting = adapterFor(
      scripted(
        page([thread('PRRT_1')], { total: 2, hasNextPage: true, endCursor: 'c1' }),
        page([thread('PRRT_1')], { total: 2 }),
      ).runGh,
    );
    expect(await shifting.readPullRequestFindings(request())).toMatchObject({
      outcome: 'unavailable',
      code: 'partial-page',
    });
  });

  it('reports a moved head as unavailable with code head-moved', async () => {
    const moved = adapterFor(scripted(page([thread('PRRT_1')], { head: OTHER_HEAD })).runGh);
    expect(await moved.readPullRequestFindings(request())).toEqual({ outcome: 'unavailable', code: 'head-moved' });

    const movedBetweenPages = adapterFor(
      scripted(
        page([thread('PRRT_1')], { total: 2, hasNextPage: true, endCursor: 'c1' }),
        page([thread('PRRT_2')], { total: 2, head: OTHER_HEAD }),
      ).runGh,
    );
    expect(await movedBetweenPages.readPullRequestFindings(request())).toEqual({
      outcome: 'unavailable',
      code: 'head-moved',
    });
  });

  it('never accepts an abbreviated head: only the exact full head is the same head', async () => {
    const { calls, runGh } = scripted(page([thread('PRRT_1')]));
    const adapter = adapterFor(runGh);

    for (const expectedHeadSha of [HEAD.slice(0, 7), HEAD.slice(0, 12), HEAD.slice(0, 39)]) {
      expect(await adapter.readPullRequestFindings(request({ expectedHeadSha }))).toMatchObject({
        outcome: 'unavailable',
        code: 'unreadable',
      });
    }
    expect(calls).toHaveLength(0);
  });

  it('reports a closed or merged pull request as unavailable with code not-open', async () => {
    for (const state of ['CLOSED', 'MERGED']) {
      const answer = page([thread('PRRT_1')], { state });
      expect(await adapterFor(scripted(answer).runGh).readPullRequestFindings(request())).toEqual({
        outcome: 'unavailable',
        code: 'not-open',
      });
    }
    for (const state of [null, 'open', 'DRAFT', 3]) {
      const answer = page([thread('PRRT_1')], { state });
      expect(await adapterFor(scripted(answer).runGh).readPullRequestFindings(request())).toMatchObject({
        outcome: 'unavailable',
        code: 'unreadable',
      });
    }
  });

  it('reports an unreadable forge answer as unavailable and never as an empty list', async () => {
    const answers: GhInvocationResult[] = [
      { exitCode: 1, stdout: '', stderr: 'gh: token ghp_secret failed' },
      { exitCode: 0, stdout: '', stderr: '' },
      { exitCode: 0, stdout: 'not json', stderr: '' },
      { exitCode: 0, stdout: JSON.stringify({ errors: [{ message: 'boom' }] }), stderr: '' },
      { exitCode: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: null } } }), stderr: '' },
      page([thread('PRRT_1', { isResolved: 'no' })]),
      page([thread('PRRT_1', { id: '' })]),
      page(['not a node']),
    ];

    for (const answer of answers) {
      const result = await adapterFor(scripted(answer).runGh).readPullRequestFindings(request());
      expect(result.outcome).toBe('unavailable');
      expect(JSON.stringify(result)).not.toContain('ghp_secret');
    }
    expect(await adapterFor(scripted(answers[0]).runGh).readPullRequestFindings(request())).toMatchObject({
      code: 'forge-error',
    });
    expect(await adapterFor(scripted(answers[2]).runGh).readPullRequestFindings(request())).toMatchObject({
      code: 'unreadable',
    });
    expect(await adapterFor(scripted(answers[7]).runGh).readPullRequestFindings(request())).toMatchObject({
      code: 'unreadable',
    });
  });

  it('reports an unknown author kind as unreadable rather than guessing', async () => {
    const kinds: unknown[] = [{ __typename: 'Organization' }, { __typename: 'Mannequin' }, null, {}];

    for (const author of kinds) {
      const answer = page([thread('PRRT_1', { comments: { nodes: [{ body: 'text', author }] } })]);
      expect(await adapterFor(scripted(answer).runGh).readPullRequestFindings(request())).toMatchObject({
        outcome: 'unavailable',
        code: 'unreadable',
      });
    }
    const resolvedUnknown = page([
      thread('PRRT_0'),
      thread('PRRT_1', { isResolved: true, comments: { nodes: [{ body: 'text', author: null }] } }),
    ]);
    expect(await adapterFor(scripted(resolvedUnknown).runGh).readPullRequestFindings(request())).toMatchObject({
      outcome: 'unavailable',
      code: 'unreadable',
    });
    const noComment = page([thread('PRRT_1', { comments: { nodes: [] } })]);
    expect(await adapterFor(scripted(noComment).runGh).readPullRequestFindings(request())).toMatchObject({
      outcome: 'unavailable',
      code: 'unreadable',
    });
  });

  it('never emits a mutation: every argv is api graphql and no resolve or comment appears', async () => {
    const { calls, runGh } = scripted(
      page([thread('PRRT_1')], { total: 2, hasNextPage: true, endCursor: 'c1' }),
      page([thread('PRRT_2')], { total: 2 }),
    );

    await adapterFor(runGh).readPullRequestFindings(request());

    expect(calls.length).toBeGreaterThan(0);
    for (const { args } of calls) {
      expect(args.slice(0, 2)).toEqual(['api', 'graphql']);
      expect(args).not.toContain('--method');
      expect(args).not.toContain('-X');
      const joined = args.join('\n');
      expect(joined).not.toMatch(/mutation/i);
      expect(joined).not.toContain('resolveReviewThread');
      expect(joined).not.toContain('addComment');
      expect(joined).not.toContain('addPullRequestReview');
      expect(joined).not.toMatch(/pr (comment|close|merge)/);
    }
  });

  it('refuses to start a call when the deadline has no budget left', async () => {
    const { calls, runGh } = scripted(page([thread('PRRT_1')]));
    const adapter = adapterFor(runGh);

    const exhausted = await adapter.readPullRequestFindings(
      request({ deadlineIso: new Date(NOW_MS + 1_500).toISOString() }),
    );
    const passed = await adapter.readPullRequestFindings(
      request({ deadlineIso: new Date(NOW_MS - 1_000).toISOString() }),
    );
    const invalid = await adapter.readPullRequestFindings(request({ deadlineIso: 'tomorrow-ish' }));

    for (const result of [exhausted, passed, invalid]) {
      expect(result).toEqual({ outcome: 'unavailable', code: 'forge-error', detail: 'deadline' });
    }
    expect(calls).toHaveLength(0);

    const bounded = await adapter.readPullRequestFindings(
      request({ deadlineIso: new Date(NOW_MS + 10_000).toISOString() }),
    );
    expect(bounded.outcome).toBe('available');
    expect(calls).toHaveLength(1);
    expect(calls[0].timeoutMs).toBe(10_000);
  });

  it('bounds the answer size and reports an oversized answer as unavailable', async () => {
    const hugeStdout: GhInvocationResult = { exitCode: 0, stderr: '', stdout: 'x'.repeat(1_048_577) };
    expect(await adapterFor(scripted(hugeStdout).runGh).readPullRequestFindings(request())).toMatchObject({
      outcome: 'unavailable',
      code: 'too-large',
    });

    const hugeBody = page([
      thread('PRRT_1', { comments: { nodes: [{ body: 'y'.repeat(4_097), author: { __typename: 'User' } }] } }),
    ]);
    expect(await adapterFor(scripted(hugeBody).runGh).readPullRequestFindings(request())).toMatchObject({
      outcome: 'unavailable',
      code: 'too-large',
    });

    const edgeBody = page([
      thread('PRRT_1', { comments: { nodes: [{ body: 'y'.repeat(4_096), author: { __typename: 'User' } }] } }),
    ]);
    expect((await adapterFor(scripted(edgeBody).runGh).readPullRequestFindings(request())).outcome).toBe('available');

    const tooManyThreads = page([thread('PRRT_1')], { total: 5_001, hasNextPage: true, endCursor: 'c1' });
    expect(await adapterFor(scripted(tooManyThreads).runGh).readPullRequestFindings(request())).toMatchObject({
      outcome: 'unavailable',
      code: 'too-large',
    });

    let pageNumber = 0;
    const endless = adapterFor(async () => {
      pageNumber += 1;
      return page([thread(`PRRT_${pageNumber}`)], { total: 4_000, hasNextPage: true, endCursor: `c${pageNumber}` });
    });
    expect(await endless.readPullRequestFindings(request())).toMatchObject({
      outcome: 'unavailable',
      code: 'too-large',
    });
    expect(pageNumber).toBe(50);
  });

  it('reports a thrown runner as unavailable instead of throwing', async () => {
    const throwing = adapterFor(async () => {
      throw new Error('spawn failed with token ghp_secret');
    });
    const result = await throwing.readPullRequestFindings(request());
    expect(result).toMatchObject({ outcome: 'unavailable', code: 'forge-error' });
    expect(JSON.stringify(result)).not.toContain('ghp_secret');

    const synchronous = adapterFor(() => {
      throw new Error('sync failure');
    });
    expect(await synchronous.readPullRequestFindings(request())).toMatchObject({
      outcome: 'unavailable',
      code: 'forge-error',
    });

    const unconfigured = new PullRequestFindingsReadAdapter();
    expect(unconfigured.isConfigured()).toBe(false);
    expect(await unconfigured.readPullRequestFindings(request())).toEqual({
      outcome: 'unavailable',
      code: 'unconfigured',
    });

    const badRequest = await adapterFor(scripted(page([])).runGh).readPullRequestFindings(
      null as unknown as PullRequestFindingsRequest,
    );
    expect(badRequest).toMatchObject({ outcome: 'unavailable', code: 'unreadable' });
  });

  it('returns typed fields only and carries no credential', async () => {
    const noisy = page([thread('PRRT_1')]);
    const parsed = JSON.parse(noisy.stdout) as { token?: string };
    // Built by join so the fake value never carries a credential-shaped
    // assignment in this file; the adapter must still drop it entirely.
    const fakeToken = ['ghp', 'fake', 'value', 'never', 'crosses'].join('_');
    parsed.token = fakeToken;
    const { runGh } = scripted({ ...noisy, stdout: JSON.stringify(parsed), stderr: `Authorization: bearer ${fakeToken}` });

    const adapter = adapterFor(runGh);
    const result = await adapter.readPullRequestFindings(request());

    expect(adapter.isConfigured()).toBe(true);
    expect(result.outcome).toBe('available');
    if (result.outcome === 'available') {
      expect(Object.keys(result).sort()).toEqual(['findings', 'headSha', 'outcome']);
      for (const entry of result.findings) {
        expect(Object.keys(entry).sort()).toEqual(['authorKind', 'line', 'path', 'state', 'text', 'threadId']);
      }
    }
    expect(JSON.stringify(result)).not.toContain(fakeToken);
    expect(JSON.stringify(result)).not.toContain('ghp_');
  });
});
