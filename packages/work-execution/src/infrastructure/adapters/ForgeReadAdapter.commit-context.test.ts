// ForgeReadAdapter.readCommitContext (SH10): one named check context at one
// exact commit, one read-only paginated graphql query. A thrown, partial,
// oversized or unreadable answer is unavailable, never `missing`, and the
// result carries the asked head and a closed code only.

import { describe, expect, it } from 'vitest';

import type { GhInvocationResult } from './ForgeActionAdapter.adapter.js';
import {
  COMMIT_CONTEXT_QUERY,
  ForgeReadAdapter,
  MAX_COMMIT_CONTEXT_PAGES,
  parseCommitContextPage,
  type ForgeReadAdapterOptions,
} from './ForgeReadAdapter.adapter.js';
import type {
  ReadCommitContextRequest,
  ReadCommitContextResult,
} from '../../application/ports/out/ForgeReadPort.out-port.js';

const HEAD = '3dd5d90509461e3d2154b52da28671aeffa84130';
const OTHER_HEAD = '8e136fe0e0cc916b9d3485eaafe653e3143d9d63';
const OTHER_CONTEXT = 'lint-check';
const CURSOR = 'page-cursor-1';

function ok(stdout: string): GhInvocationResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function makeAdapter(options: Partial<ForgeReadAdapterOptions> = {}): ForgeReadAdapter {
  return new ForgeReadAdapter({ owner: 'fleet', repo: 'fleet-v2', runGh: async () => ok(''), ...options });
}

function read(adapter: ForgeReadAdapter, request: ReadCommitContextRequest): Promise<ReadCommitContextResult> {
  return adapter.readCommitContext(request);
}

type NodeSpec =
  | { readonly kind: 'check'; readonly name: string; readonly status: string; readonly conclusion: string | null }
  | { readonly kind: 'status'; readonly name: string; readonly state: string }
  | { readonly kind: 'other'; readonly typename: string };

function nodeOf(node: NodeSpec): Record<string, unknown> {
  if (node.kind === 'check') {
    return { __typename: 'CheckRun', name: node.name, status: node.status, conclusion: node.conclusion };
  }
  if (node.kind === 'status') {
    return { __typename: 'StatusContext', context: node.name, state: node.state };
  }
  return { __typename: node.typename };
}

function check(name: string, status: string, conclusion: string | null): NodeSpec {
  return { kind: 'check', name, status, conclusion };
}

function status(name: string, state: string): NodeSpec {
  return { kind: 'status', name, state };
}

/** A full GraphQL page for one commit's rollup. `object: null` and `rollup: null` are explicit. */
function page(spec: {
  readonly oid?: string;
  readonly object?: null;
  readonly rollup?: null;
  readonly nodes?: readonly NodeSpec[];
  readonly hasNextPage?: boolean;
  readonly endCursor?: string | null;
} = {}): string {
  const object =
    spec.object === null
      ? null
      : {
          oid: spec.oid ?? HEAD,
          statusCheckRollup:
            spec.rollup === null
              ? null
              : {
                  contexts: {
                    pageInfo: { hasNextPage: spec.hasNextPage ?? false, endCursor: spec.endCursor ?? null },
                    nodes: (spec.nodes ?? []).map(nodeOf),
                  },
                },
        };
  return JSON.stringify({ data: { repository: { object } } });
}

function found(state: string): ReadCommitContextResult {
  return { outcome: 'found', headSha: HEAD, state: state as 'success' };
}

function unavailable(reason: string): ReadCommitContextResult {
  return { outcome: 'unavailable', reason: reason as 'invalid-request' };
}

const GATE = { headSha: HEAD, contextName: 'gate' } as const;
const CLOSED_PAGE = { hasNextPage: false, endCursor: null } as const;

function contextsBody(nodes: readonly unknown[], pageInfo: unknown): string {
  return JSON.stringify({
    data: {
      repository: {
        object: {
          oid: HEAD,
          statusCheckRollup: { contexts: { pageInfo, nodes } },
        },
      },
    },
  });
}

function readContexts(nodes: readonly unknown[], pageInfo: unknown): Promise<ReadCommitContextResult> {
  return read(makeAdapter({ runGh: async () => ok(contextsBody(nodes, pageInfo)) }), GATE);
}

function checkNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { __typename: 'CheckRun', name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS', ...overrides };
}

function statusNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { __typename: 'StatusContext', context: 'gate', state: 'SUCCESS', ...overrides };
}

describe('readCommitContext', () => {
  it('returns success for one CheckRun gate whose conclusion is SUCCESS', async () => {
    const adapter = makeAdapter({
      runGh: async () => ok(page({ nodes: [check('gate', 'COMPLETED', 'SUCCESS'), { kind: 'other', typename: 'CheckSuite' }] })),
    });
    expect(await read(adapter, GATE)).toEqual(found('success'));
  });

  it('returns failure for one CheckRun gate whose conclusion is FAILURE', async () => {
    const adapter = makeAdapter({ runGh: async () => ok(page({ nodes: [check('gate', 'COMPLETED', 'FAILURE')] })) });
    expect(await read(adapter, GATE)).toEqual(found('failure'));
  });

  it('returns pending for one CheckRun gate whose status is IN_PROGRESS', async () => {
    const adapter = makeAdapter({ runGh: async () => ok(page({ nodes: [check('gate', 'IN_PROGRESS', null)] })) });
    expect(await read(adapter, GATE)).toEqual(found('pending'));
  });

  it('returns other for one CheckRun gate whose conclusion is CANCELLED', async () => {
    const adapter = makeAdapter({ runGh: async () => ok(page({ nodes: [check('gate', 'COMPLETED', 'CANCELLED')] })) });
    expect(await read(adapter, GATE)).toEqual(found('other'));
  });

  it('returns other for one CheckRun gate whose conclusion is TIMED_OUT', async () => {
    const adapter = makeAdapter({ runGh: async () => ok(page({ nodes: [check('gate', 'COMPLETED', 'TIMED_OUT')] })) });
    expect(await read(adapter, GATE)).toEqual(found('other'));
  });

  it('returns other for one CheckRun gate whose conclusion is null', async () => {
    const adapter = makeAdapter({ runGh: async () => ok(page({ nodes: [check('gate', 'COMPLETED', null)] })) });
    expect(await read(adapter, GATE)).toEqual(found('other'));
  });

  it('returns success for one StatusContext gate whose state is SUCCESS', async () => {
    const adapter = makeAdapter({ runGh: async () => ok(page({ nodes: [status('gate', 'SUCCESS')] })) });
    expect(await read(adapter, GATE)).toEqual(found('success'));
  });

  it('returns failure for one StatusContext gate whose state is ERROR', async () => {
    const adapter = makeAdapter({ runGh: async () => ok(page({ nodes: [status('gate', 'ERROR')] })) });
    expect(await read(adapter, GATE)).toEqual(found('failure'));
  });

  it('returns failure for one StatusContext gate whose state is FAILURE', async () => {
    const adapter = makeAdapter({ runGh: async () => ok(page({ nodes: [status('gate', 'FAILURE')] })) });
    expect(await read(adapter, GATE)).toEqual(found('failure'));
  });

  it('returns pending for one StatusContext gate whose state is PENDING', async () => {
    const adapter = makeAdapter({ runGh: async () => ok(page({ nodes: [status('gate', 'PENDING')] })) });
    expect(await read(adapter, GATE)).toEqual(found('pending'));
  });

  it('returns pending for one StatusContext gate whose state is EXPECTED', async () => {
    const adapter = makeAdapter({ runGh: async () => ok(page({ nodes: [status('gate', 'EXPECTED')] })) });
    expect(await read(adapter, GATE)).toEqual(found('pending'));
  });

  it('returns missing when no node is named gate', async () => {
    const adapter = makeAdapter({
      runGh: async () => ok(page({ nodes: [check(OTHER_CONTEXT, 'COMPLETED', 'SUCCESS'), status('build', 'FAILURE')] })),
    });
    const result = await read(adapter, GATE);
    expect(result).toEqual(found('missing'));
    expect(JSON.stringify(result)).not.toContain(OTHER_CONTEXT);
    expect(JSON.stringify(result)).not.toContain('build');
  });

  it('returns missing when statusCheckRollup is null', async () => {
    const adapter = makeAdapter({ runGh: async () => ok(page({ rollup: null })) });
    expect(await read(adapter, GATE)).toEqual(found('missing'));
  });

  it('returns ambiguous when two gate nodes are SUCCESS and FAILURE', async () => {
    const adapter = makeAdapter({
      runGh: async () =>
        ok(page({ nodes: [check('gate', 'COMPLETED', 'SUCCESS'), check('gate', 'COMPLETED', 'FAILURE')] })),
    });
    expect(await read(adapter, GATE)).toEqual(found('ambiguous'));
  });

  it('returns success when two gate nodes are both SUCCESS', async () => {
    const adapter = makeAdapter({
      runGh: async () =>
        ok(page({ nodes: [check('gate', 'COMPLETED', 'SUCCESS'), check('gate', 'COMPLETED', 'SUCCESS')] })),
    });
    expect(await read(adapter, GATE)).toEqual(found('success'));
  });

  it('returns success when the gate match spans pages, with exactly two runGh calls and the second carrying after the cursor, and the result echoes neither', async () => {
    const calls: (readonly string[])[] = [];
    const adapter = makeAdapter({
      runGh: async (args) => {
        calls.push(args);
        const after = args.some((arg) => arg.startsWith('after='));
        if (!after) {
          return ok(page({ nodes: [check('gate', 'COMPLETED', 'SUCCESS')], hasNextPage: true, endCursor: CURSOR }));
        }
        return ok(page({ nodes: [check(OTHER_CONTEXT, 'COMPLETED', 'FAILURE')] }));
      },
    });
    const result = await read(adapter, GATE);
    expect(result).toEqual(found('success'));
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain(`after=${CURSOR}`);
    expect(JSON.stringify(result)).not.toContain(CURSOR);
    expect(JSON.stringify(result)).not.toContain(OTHER_CONTEXT);
  });

  it('returns partial-contexts when hasNextPage is still true on the last allowed page', async () => {
    let calls = 0;
    const adapter = makeAdapter({
      runGh: async () => {
        calls += 1;
        return ok(page({ nodes: [check('gate', 'COMPLETED', 'SUCCESS')], hasNextPage: true, endCursor: `c${calls}` }));
      },
    });
    expect(await read(adapter, GATE)).toEqual(unavailable('partial-contexts'));
    expect(calls).toBe(MAX_COMMIT_CONTEXT_PAGES);
  });

  it('returns not-found when the commit object is null', async () => {
    const adapter = makeAdapter({ runGh: async () => ok(page({ object: null })) });
    expect(await read(adapter, GATE)).toEqual({ outcome: 'not-found' });
  });

  it('returns unreadable-contexts when the commit oid differs from the asked head', async () => {
    const adapter = makeAdapter({
      runGh: async () => ok(page({ oid: OTHER_HEAD, nodes: [check('gate', 'COMPLETED', 'SUCCESS')] })),
    });
    expect(await read(adapter, GATE)).toEqual(unavailable('unreadable-contexts'));
  });

  it('returns unreadable-contexts when the GraphQL answer carries an errors array', async () => {
    const adapter = makeAdapter({
      runGh: async () => ok(JSON.stringify({ errors: [{ message: 'secret path /tmp/forge' }], data: { repository: { object: null } } })),
    });
    const result = await read(adapter, GATE);
    expect(result).toEqual(unavailable('unreadable-contexts'));
    expect(JSON.stringify(result)).not.toContain('/tmp/forge');
  });

  it('returns unreadable-contexts when stdout is not json', async () => {
    const adapter = makeAdapter({ runGh: async () => ok('<html>') });
    expect(await read(adapter, GATE)).toEqual(unavailable('unreadable-contexts'));
  });

  it('returns unreadable-contexts when a context node is null', async () => {
    const body = JSON.stringify({
      data: {
        repository: {
          object: {
            oid: HEAD,
            statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [null] } },
          },
        },
      },
    });
    const adapter = makeAdapter({ runGh: async () => ok(body) });
    expect(await read(adapter, GATE)).toEqual(unavailable('unreadable-contexts'));
  });

  it('returns unreadable-contexts when the nodes array is sparse', () => {
    const nodes = new Array(1);
    expect(
      parseCommitContextPage(
        {
          data: {
            repository: {
              object: {
                oid: HEAD,
                statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } },
              },
            },
          },
        },
        HEAD,
        'gate',
        0,
      ),
    ).toEqual({ kind: 'fail', reason: 'unreadable-contexts' });
  });

  it('returns unreadable-contexts when hasNextPage is true and the cursor is empty', async () => {
    const adapter = makeAdapter({ runGh: async () => ok(page({ hasNextPage: true, endCursor: '' })) });
    expect(await read(adapter, GATE)).toEqual(unavailable('unreadable-contexts'));
  });

  it('returns unreadable-contexts when a later page has a null commit object', async () => {
    const adapter = makeAdapter({
      runGh: async (args) =>
        args.some((arg) => arg.startsWith('after='))
          ? ok(page({ object: null }))
          : ok(page({ nodes: [check('gate', 'COMPLETED', 'SUCCESS')], hasNextPage: true, endCursor: CURSOR })),
    });
    expect(await read(adapter, GATE)).toEqual(unavailable('unreadable-contexts'));
  });

  it('returns unreadable-contexts when a later page has a null statusCheckRollup', async () => {
    const adapter = makeAdapter({
      runGh: async (args) =>
        args.some((arg) => arg.startsWith('after='))
          ? ok(page({ rollup: null }))
          : ok(page({ nodes: [check(OTHER_CONTEXT, 'COMPLETED', 'SUCCESS')], hasNextPage: true, endCursor: CURSOR })),
    });
    const result = await read(adapter, GATE);
    expect(result).toEqual(unavailable('unreadable-contexts'));
    expect(JSON.stringify(result)).not.toContain(OTHER_CONTEXT);
  });

  it('returns context-failed when gh exits 1', async () => {
    const adapter = makeAdapter({
      runGh: async () => ({ exitCode: 1, stdout: page({ nodes: [check('gate', 'COMPLETED', 'SUCCESS')] }), stderr: 'denied at /home/someone/bin/gh' }),
    });
    const result = await read(adapter, GATE);
    expect(result).toEqual(unavailable('context-failed'));
    expect(JSON.stringify(result)).not.toContain('/home/someone');
  });

  it('returns context-too-large when stdout exceeds the read cap', async () => {
    const adapter = makeAdapter({
      runGh: async () => ok(`${page({ nodes: [check('gate', 'COMPLETED', 'SUCCESS')] })}${' '.repeat(1_048_577)}`),
    });
    expect(await read(adapter, GATE)).toEqual(unavailable('context-too-large'));
  });

  it('returns context-timed-out when runGh never resolves within timeoutMs 50', async () => {
    const adapter = makeAdapter({
      runGh: () => new Promise<GhInvocationResult>(() => undefined),
    });
    expect(await read(adapter, { headSha: HEAD, contextName: 'gate', timeoutMs: 50 })).toEqual(
      unavailable('context-timed-out'),
    );
  });

  it('returns context-timed-out when timeoutMs is not positive and does not call runGh', async () => {
    let calls = 0;
    const adapter = makeAdapter({
      runGh: async () => {
        calls += 1;
        return ok(page({ nodes: [check('gate', 'COMPLETED', 'SUCCESS')] }));
      },
    });
    expect(await read(adapter, { headSha: HEAD, contextName: 'gate', timeoutMs: 0 })).toEqual(unavailable('context-timed-out'));
    expect(await read(adapter, { headSha: HEAD, contextName: 'gate', timeoutMs: -1 })).toEqual(unavailable('context-timed-out'));
    expect(calls).toBe(0);
  });

  it('returns invalid-request for a 39-hex head', async () => {
    const adapter = makeAdapter();
    expect(await read(adapter, { headSha: HEAD.slice(0, 39), contextName: 'gate' })).toEqual(unavailable('invalid-request'));
  });

  it('returns invalid-request for an uppercase head', async () => {
    const adapter = makeAdapter();
    expect(await read(adapter, { headSha: HEAD.toUpperCase(), contextName: 'gate' })).toEqual(unavailable('invalid-request'));
  });

  it('returns invalid-request for a context name starting with a dash', async () => {
    const adapter = makeAdapter();
    expect(await read(adapter, { headSha: HEAD, contextName: '-gate' })).toEqual(unavailable('invalid-request'));
  });

  it('returns invalid-request for a secret-shaped context name', async () => {
    const token = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
    let calls = 0;
    const adapter = makeAdapter({
      runGh: async () => {
        calls += 1;
        return ok(page({ nodes: [check('gate', 'COMPLETED', 'SUCCESS')] }));
      },
    });
    const result = await read(adapter, { headSha: HEAD, contextName: token });
    expect(result).toEqual(unavailable('invalid-request'));
    expect(JSON.stringify(result)).not.toContain(token);
    expect(calls).toBe(0);
  });

  it('returns invalid-request for a non-object request', async () => {
    const adapter = makeAdapter();
    expect(await read(adapter, null as never)).toEqual(unavailable('invalid-request'));
    expect(await read(adapter, undefined as never)).toEqual(unavailable('invalid-request'));
    expect(await read(adapter, 7 as never)).toEqual(unavailable('invalid-request'));
    expect(await read(adapter, [] as never)).toEqual(unavailable('invalid-request'));
    expect(await read(adapter, new Date() as never)).toEqual(unavailable('invalid-request'));
  });

  it('returns invalid-request when timeoutMs is not a finite number', async () => {
    const adapter = makeAdapter();
    expect(await read(adapter, { headSha: HEAD, contextName: 'gate', timeoutMs: Number.NaN })).toEqual(
      unavailable('invalid-request'),
    );
  });

  it('returns invalid-request when reading the request throws', async () => {
    const throwing: Record<string, unknown> = {};
    Object.defineProperty(throwing, 'headSha', {
      get() {
        throw new Error('boom at /var/secret');
      },
    });
    const result = await read(makeAdapter(), throwing as never);
    expect(result).toEqual(unavailable('invalid-request'));
    expect(JSON.stringify(result)).not.toContain('/var/secret');
  });

  it('returns forge-not-configured when no runGh is configured', async () => {
    expect(await new ForgeReadAdapter().readCommitContext(GATE)).toEqual(unavailable('forge-not-configured'));
  });

  it('returns invalid-repository for an invalid repository override', async () => {
    const adapter = makeAdapter();
    expect(await read(adapter, { ...GATE, repository: { owner: 'a/b', repo: 'fleet-v2' } })).toEqual(
      unavailable('invalid-repository'),
    );
    expect(await read(adapter, { ...GATE, repository: { owner: '', repo: 'x' } })).toEqual(unavailable('invalid-repository'));
  });

  it('sends a read-only graphql argv with every variable through -f and never -X, --method or mutation', async () => {
    let seen: readonly string[] = [];
    const adapter = makeAdapter({
      runGh: async (args) => {
        seen = args;
        return ok(page({ nodes: [check('gate', 'COMPLETED', 'SUCCESS')] }));
      },
    });
    await read(adapter, GATE);
    expect(seen).toContain('graphql');
    expect(seen[0]).toBe('api');
    expect(seen[1]).toBe('graphql');
    expect(seen).toContain(`query=${COMMIT_CONTEXT_QUERY}`);
    expect(seen).toContain('owner=fleet');
    expect(seen).toContain('repo=fleet-v2');
    expect(seen).toContain(`oid=${HEAD}`);
    expect(COMMIT_CONTEXT_QUERY).not.toContain('mutation');
    for (let index = 2; index < seen.length; index += 2) {
      expect(seen[index]).toBe('-f');
      expect(seen[index + 1]).toMatch(/^[A-Za-z][A-Za-z0-9]*=/);
    }
    for (const arg of seen) {
      expect(arg).not.toBe('-X');
      expect(arg).not.toBe('--method');
      expect(arg).not.toContain('mutation');
    }
  });

  it('returns unreadable-contexts when a CheckRun name is not a string', async () => {
    expect(await readContexts([checkNode({ name: 7 })], CLOSED_PAGE)).toEqual(unavailable('unreadable-contexts'));
  });

  it('returns unreadable-contexts when a CheckRun status is not a string', async () => {
    expect(await readContexts([checkNode({ status: 7 })], CLOSED_PAGE)).toEqual(unavailable('unreadable-contexts'));
  });

  it('returns unreadable-contexts when a CheckRun conclusion is not a string or null', async () => {
    expect(await readContexts([checkNode({ conclusion: 7 })], CLOSED_PAGE)).toEqual(unavailable('unreadable-contexts'));
  });

  it('returns unreadable-contexts when a StatusContext context is not a string', async () => {
    expect(await readContexts([statusNode({ context: 7 })], CLOSED_PAGE)).toEqual(unavailable('unreadable-contexts'));
  });

  it('returns unreadable-contexts when a StatusContext state is not a string', async () => {
    expect(await readContexts([statusNode({ state: 7 })], CLOSED_PAGE)).toEqual(unavailable('unreadable-contexts'));
  });

  it('returns unreadable-contexts when a node __typename is not a string', async () => {
    const node = { __typename: 7, name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS' };
    expect(await readContexts([node], CLOSED_PAGE)).toEqual(unavailable('unreadable-contexts'));
  });

  it('returns missing when a node has an unknown __typename', async () => {
    const result = await readContexts([{ __typename: 'CheckSuite' }], CLOSED_PAGE);
    expect(result).toEqual(found('missing'));
    expect(JSON.stringify(result)).not.toContain('CheckSuite');
  });

  it('returns success when hasNextPage is false and endCursor is null', async () => {
    expect(await readContexts([checkNode()], CLOSED_PAGE)).toEqual(found('success'));
  });

  it('returns unreadable-contexts when pageInfo omits endCursor', async () => {
    expect(await readContexts([checkNode()], { hasNextPage: false })).toEqual(unavailable('unreadable-contexts'));
  });

  it('returns unreadable-contexts when pageInfo endCursor is not a string or null', async () => {
    expect(await readContexts([checkNode()], { hasNextPage: false, endCursor: 7 })).toEqual(
      unavailable('unreadable-contexts'),
    );
  });

  it('returns unreadable-contexts when pageInfo hasNextPage is not a boolean', async () => {
    expect(await readContexts([checkNode()], { hasNextPage: 'false', endCursor: null })).toEqual(
      unavailable('unreadable-contexts'),
    );
  });

  it('returns unreadable-contexts when hasNextPage is true and endCursor is absent', async () => {
    expect(await readContexts([checkNode()], { hasNextPage: true })).toEqual(unavailable('unreadable-contexts'));
  });
});
