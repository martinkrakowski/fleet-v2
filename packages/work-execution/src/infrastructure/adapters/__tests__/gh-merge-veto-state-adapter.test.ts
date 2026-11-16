// Covers the brief's acceptance fixtures: the tier label rule (one distinct
// digit, else the stricter '2'), the 100-path cap after full validation,
// head-moved, every malformed answer row, the not-polluted __proto__ key, and
// every refusal of readMergeVetoState without calling gh and without echoing
// any forge or error text.

import { describe, expect, it } from 'vitest';

import type { GhInvocationResult } from '../ForgeActionAdapter.adapter.js';
import type { MergeVetoStateFields } from '../../../application/ports/out/MergeVetoPort.out-port.js';
import {
  GhMergeVetoStateAdapter,
  MAX_CHANGED_PATHS,
  MERGE_VETO_STATE_QUERY,
  MERGE_VETO_UNREAD_FIELDS,
  parseMergeVetoState,
} from '../GhMergeVetoStateAdapter.adapter.js';

const HEAD = '3dd5d90509461e3d2154b52da28671aeffa84130';
const NOW_MS = Date.parse('2026-11-01T12:00:00.000Z');
const DEADLINE = '2026-11-01T12:01:00.000Z';
const REQUEST = {
  repository: { owner: 'acme', repo: 'widgets' },
  pullRequestNumber: 7,
  headOid: HEAD,
  deadlineIso: DEADLINE,
};

interface PrOverrides {
  headRefOid?: unknown;
  title?: unknown;
  additions?: unknown;
  deletions?: unknown;
  labels?: unknown;
  files?: unknown;
}

function answer(overrides: PrOverrides = {}): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          headRefOid: HEAD,
          title: 'feat: add widget',
          additions: 12,
          deletions: 3,
          labels: { nodes: [{ name: 'bug' }, { name: 'tier:1' }] },
          files: { nodes: [{ path: 'a.ts' }, { path: 'b/c.ts' }] },
          ...overrides,
        },
      },
    },
  });
}

interface RecordedCall {
  args: readonly string[];
  timeoutMs: number | undefined;
}

function makeFake(stdout: string): { runGh: (args: readonly string[], timeoutMs?: number) => Promise<GhInvocationResult>; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const runGh = async (args: readonly string[], timeoutMs?: number): Promise<GhInvocationResult> => {
    calls.push({ args, timeoutMs });
    return { exitCode: 0, stdout, stderr: '' };
  };
  return { runGh, calls };
}

function adapterWith(stdout: string): { adapter: GhMergeVetoStateAdapter; calls: RecordedCall[] } {
  const fake = makeFake(stdout);
  const adapter = new GhMergeVetoStateAdapter({ runGh: fake.runGh, now: () => NOW_MS });
  return { adapter, calls: fake.calls };
}

const READ_STATE: MergeVetoStateFields = {
  tier: '1',
  title: 'feat: add widget',
  changedPaths: ['a.ts', 'b/c.ts'],
  additions: 12,
  deletions: 3,
  hardToUndo: null,
  fixRounds: null,
  reviewerFamilies: null,
  replyResolvedThreads: null,
  majorBlockerFindings: null,
  headChangedAfterReview: false,
};

type ReadResult = { status: 'read'; state: MergeVetoStateFields };

function asRead(result: { readonly status: string }): ReadResult {
  if (result.status !== 'read') throw new Error(`expected a read answer, got ${result.status}`);
  return result as unknown as ReadResult;
}

describe('parseMergeVetoState', () => {
  it('reports the five fields the forge cannot answer as null, never as a zero or an empty list', () => {
    const state = asRead(parseMergeVetoState(answer(), HEAD)).state;
    const unread = ['hardToUndo', 'fixRounds', 'reviewerFamilies', 'replyResolvedThreads', 'majorBlockerFindings'] as const;
    for (const key of unread) {
      expect(state[key]).toBeNull();
    }
    expect(MERGE_VETO_UNREAD_FIELDS).toEqual({
      hardToUndo: null, fixRounds: null, reviewerFamilies: null, replyResolvedThreads: null, majorBlockerFindings: null,
    });
    expect(Object.isFrozen(MERGE_VETO_UNREAD_FIELDS)).toBe(true);
  });

  it('maps a well-formed answer to the full state', () => {
    expect(parseMergeVetoState(answer(), HEAD)).toEqual({ status: 'read', state: READ_STATE });
  });

  it('answers tier 2 when no tier label is present', () => {
    expect(asRead(parseMergeVetoState(answer({ labels: { nodes: [{ name: 'bug' }] } }), HEAD)).state.tier).toBe('2');
  });

  it('answers tier 2 when two different tier labels are present', () => {
    expect(asRead(parseMergeVetoState(answer({ labels: { nodes: [{ name: 'tier:0' }, { name: 'tier:1' }] } }), HEAD)).state.tier).toBe('2');
  });

  it('reads the tier once when the same tier label is repeated', () => {
    expect(asRead(parseMergeVetoState(answer({ labels: { nodes: [{ name: 'tier:0' }, { name: 'tier:0' }] } }), HEAD)).state.tier).toBe('0');
  });

  it('ignores labels that only resemble a tier label', () => {
    expect(
      asRead(parseMergeVetoState(
        answer({ labels: { nodes: [{ name: 'tier:10' }, { name: 'xtier:1' }, { name: 'tier:1 ' }, { name: 'Tier:1' }] } }),
        HEAD,
      )).state.tier,
    ).toBe('2');
  });

  it('keeps the first MAX_CHANGED_PATHS paths when the forge lists more', () => {
    const nodes = Array.from({ length: MAX_CHANGED_PATHS + 1 }, (_, i) => ({ path: `p${i}` }));
    const expected = Array.from({ length: MAX_CHANGED_PATHS }, (_, i) => `p${i}`);
    expect(asRead(parseMergeVetoState(answer({ files: { nodes } }), HEAD)).state.changedPaths).toEqual(expected);
  });

  it('answers head-moved when the forge head differs from the expected head', () => {
    expect(parseMergeVetoState(answer(), 'a'.repeat(40))).toEqual({ status: 'unavailable', reason: 'head-moved' });
  });

  it.each([
    ['text that is not JSON', () => '{'],
    ['a root array', () => '[]'],
    ['a root null', () => 'null'],
    ['errors beside valid data', () => JSON.stringify({ errors: [{ message: 'x' }], data: JSON.parse(answer()).data })],
    ['data null', () => JSON.stringify({ data: null })],
    ['repository null', () => JSON.stringify({ data: { repository: null } })],
    ['pullRequest null', () => JSON.stringify({ data: { repository: { pullRequest: null } } })],
    ['a 39-character headRefOid', () => answer({ headRefOid: 'a'.repeat(39) })],
    ['an upper-case headRefOid', () => answer({ headRefOid: HEAD.toUpperCase() })],
    ['a null headRefOid', () => answer({ headRefOid: null })],
    ['title 7', () => answer({ title: 7 })],
    ['an empty title', () => answer({ title: '' })],
    ['a title of 1025 characters', () => answer({ title: 'x'.repeat(1025) })],
    ['additions -1', () => answer({ additions: -1 })],
    ['additions 1.5', () => answer({ additions: 1.5 })],
    ['additions a string', () => answer({ additions: '12' })],
    ['a null deletions', () => answer({ deletions: null })],
    ['null labels', () => answer({ labels: null })],
    ['labels nodes not an array', () => answer({ labels: { nodes: 'x' } })],
    ['a null label node', () => answer({ labels: { nodes: [null] } })],
    ['a label node with a non-string name', () => answer({ labels: { nodes: [{ name: 7 }] } })],
    ['an array files', () => answer({ files: [] })],
    ['files nodes an array-like object', () => answer({ files: { nodes: { length: 2 } } })],
    ['a file node without a path', () => answer({ files: { nodes: [{}] } })],
    ['an empty file path', () => answer({ files: { nodes: [{ path: '' }] } })],
    ['a non-object file node', () => answer({ files: { nodes: [{ path: 'a.ts' }, 'b.ts'] } })],
    ['a null 101st file node', () =>
      answer({ files: { nodes: [...Array.from({ length: 100 }, (_, i) => ({ path: `p${i}` })), null] } })],
  ])('answers forge-answer-malformed for %s', (_name, text) => {
    expect(parseMergeVetoState(text(), HEAD)).toEqual({ status: 'unavailable', reason: 'forge-answer-malformed' });
  });

  it('does not copy a __proto__ key from the answer into the state', () => {
    const text =
      `{"data":{"repository":{"pullRequest":{"__proto__":{"polluted":true},"headRefOid":"${HEAD}",` +
      `"title":"feat: add widget","additions":12,"deletions":3,` +
      `"labels":{"nodes":[{"name":"tier:1"}]},"files":{"nodes":[{"path":"a.ts"}]}}}}}`;
    const result = parseMergeVetoState(text, HEAD);
    expect(asRead(result).state).toEqual({ ...READ_STATE, changedPaths: ['a.ts'] });
    expect(Object.keys(asRead(result).state)).toEqual(Object.keys(READ_STATE));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('GhMergeVetoStateAdapter', () => {
  it('reports not configured and unavailable without a runGh delegate', async () => {
    const adapter = new GhMergeVetoStateAdapter({ now: () => NOW_MS });
    expect(adapter.isConfigured()).toBe(false);
    expect(await adapter.readMergeVetoState(REQUEST)).toEqual({ status: 'unavailable', reason: 'not-configured' });
  });

  it('reads the state through one allow-listed read-only graphql call', async () => {
    const { adapter, calls } = adapterWith(answer());
    expect(await adapter.readMergeVetoState(REQUEST)).toEqual({ status: 'read', state: READ_STATE });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([
      'api', 'graphql',
      '-f', 'query=' + MERGE_VETO_STATE_QUERY,
      '-f', 'owner=acme',
      '-f', 'repo=widgets',
      '-F', 'number=7',
    ]);
    expect(adapter.isConfigured()).toBe(true);
  });

  it('the query is a query and names no mutation', () => {
    expect(MERGE_VETO_STATE_QUERY.trimStart().startsWith('query ')).toBe(true);
    expect(/mutation/i.test(MERGE_VETO_STATE_QUERY)).toBe(false);
  });

  it('passes the normal timeout when the deadline is further away', async () => {
    const fake = makeFake(answer());
    const adapter = new GhMergeVetoStateAdapter({ runGh: fake.runGh, now: () => NOW_MS });
    await adapter.readMergeVetoState(REQUEST);
    expect(fake.calls[0].timeoutMs).toBe(30000);
  });

  it('passes the time left when the deadline is nearer than the normal timeout', async () => {
    const deadline = new Date(NOW_MS + 5000).toISOString();
    const fake = makeFake(answer());
    const adapter = new GhMergeVetoStateAdapter({ runGh: fake.runGh, now: () => NOW_MS });
    await adapter.readMergeVetoState({ ...REQUEST, deadlineIso: deadline });
    expect(fake.calls[0].timeoutMs).toBe(5000);
  });

  it.each([
    ['an owner with a slash', { ...REQUEST, repository: { owner: 'a/b', repo: 'widgets' } }],
    ['an empty owner', { ...REQUEST, repository: { owner: '', repo: 'widgets' } }],
    ['a repo with a newline', { ...REQUEST, repository: { owner: 'acme', repo: 'r\n' } }],
    ['a repo of 101 characters', { ...REQUEST, repository: { owner: 'acme', repo: 'r'.repeat(101) } }],
    ['a zero pull request number', { ...REQUEST, pullRequestNumber: 0 }],
    ['a fractional pull request number', { ...REQUEST, pullRequestNumber: 1.5 }],
    ['a string pull request number', { ...REQUEST, pullRequestNumber: '7' as unknown as number }],
    ['a 39-character headOid', { ...REQUEST, headOid: 'a'.repeat(39) }],
    ['an upper-case headOid', { ...REQUEST, headOid: HEAD.toUpperCase() }],
    ['a numeric deadlineIso', { ...REQUEST, deadlineIso: 5 as unknown as string }],
    ['a null repository', { ...REQUEST, repository: null } as unknown as typeof REQUEST],
    ['a null request', null as unknown as typeof REQUEST],
  ])('answers invalid-request without calling gh for %s', async (_name, request) => {
    const { adapter, calls } = adapterWith(answer());
    expect(await adapter.readMergeVetoState(request)).toEqual({ status: 'unavailable', reason: 'invalid-request' });
    expect(calls).toHaveLength(0);
  });

  it('answers state-read-failed without calling gh when a request getter throws', async () => {
    const request: unknown = {
      get repository(): never {
        throw new Error('SECRET-GETTER');
      },
      pullRequestNumber: 7,
      headOid: HEAD,
      deadlineIso: DEADLINE,
    };
    const { adapter, calls } = adapterWith(answer());
    expect(await adapter.readMergeVetoState(request as typeof REQUEST)).toEqual({
      status: 'unavailable',
      reason: 'state-read-failed',
    });
    expect(calls).toHaveLength(0);
  });

  it('answers invalid-deadline without calling gh when the deadline is not a time', async () => {
    const { adapter, calls } = adapterWith(answer());
    expect(await adapter.readMergeVetoState({ ...REQUEST, deadlineIso: 'soon' })).toEqual({
      status: 'unavailable',
      reason: 'invalid-deadline',
    });
    expect(calls).toHaveLength(0);
  });

  it('answers budget-exhausted without calling gh when under two seconds remain', async () => {
    const deadline = new Date(NOW_MS + 1999).toISOString();
    const { adapter, calls } = adapterWith(answer());
    expect(await adapter.readMergeVetoState({ ...REQUEST, deadlineIso: deadline })).toEqual({
      status: 'unavailable',
      reason: 'budget-exhausted',
    });
    expect(calls).toHaveLength(0);
  });

  it('calls gh when exactly two seconds remain', async () => {
    const deadline = new Date(NOW_MS + 2000).toISOString();
    const { adapter, calls } = adapterWith(answer());
    const result = await adapter.readMergeVetoState({ ...REQUEST, deadlineIso: deadline });
    expect(calls).toHaveLength(1);
    expect(calls[0].timeoutMs).toBe(2000);
    expect(result.status).toBe('read');
  });

  it('answers forge-call-failed without echoing the error when runGh rejects', async () => {
    const runGh = async (): Promise<GhInvocationResult> => {
      throw new Error('SECRET-REJECT');
    };
    const adapter = new GhMergeVetoStateAdapter({ runGh, now: () => NOW_MS });
    expect(await adapter.readMergeVetoState(REQUEST)).toEqual({ status: 'unavailable', reason: 'forge-call-failed' });
  });

  it('answers forge-call-failed when runGh throws synchronously', async () => {
    const runGh = (): Promise<GhInvocationResult> => {
      throw new Error('SECRET-THROW');
    };
    const adapter = new GhMergeVetoStateAdapter({ runGh, now: () => NOW_MS });
    expect(await adapter.readMergeVetoState(REQUEST)).toEqual({ status: 'unavailable', reason: 'forge-call-failed' });
  });

  it('answers forge-timeout when runGh does not settle in time', async () => {
    const runGh = (): Promise<GhInvocationResult> => new Promise(() => undefined);
    const adapter = new GhMergeVetoStateAdapter({ runGh, timeoutMs: 20, now: () => NOW_MS });
    expect(await adapter.readMergeVetoState(REQUEST)).toEqual({ status: 'unavailable', reason: 'forge-timeout' });
  });

  it('answers forge-exit-nonzero without echoing forge output', async () => {
    const runGh = async (): Promise<GhInvocationResult> => ({ exitCode: 1, stdout: 'SECRET-OUT', stderr: 'SECRET-ERR' });
    const adapter = new GhMergeVetoStateAdapter({ runGh, now: () => NOW_MS });
    expect(await adapter.readMergeVetoState(REQUEST)).toEqual({ status: 'unavailable', reason: 'forge-exit-nonzero' });
  });

  it.each([
    ['null', async () => null as unknown as GhInvocationResult],
    ['a text', async () => 'text' as unknown as GhInvocationResult],
    ['a result without an exit code', async () => ({ stdout: answer(), stderr: '' }) as GhInvocationResult],
    ['a non-string stdout', async () => ({ exitCode: 0, stdout: 5, stderr: '' }) as unknown as GhInvocationResult],
  ])('answers forge-answer-malformed when the gh result is %s', async (_name, makeGh) => {
    const adapter = new GhMergeVetoStateAdapter({ runGh: makeGh, now: () => NOW_MS });
    expect(await adapter.readMergeVetoState(REQUEST)).toEqual({ status: 'unavailable', reason: 'forge-answer-malformed' });
  });

  it.each([
    ['an empty stdout', ''],
    ['a whitespace-only stdout', ' \n'],
  ])('answers forge-output-empty for %s', async (_name, stdout) => {
    const runGh = async (): Promise<GhInvocationResult> => ({ exitCode: 0, stdout, stderr: '' });
    const adapter = new GhMergeVetoStateAdapter({ runGh, now: () => NOW_MS });
    expect(await adapter.readMergeVetoState(REQUEST)).toEqual({ status: 'unavailable', reason: 'forge-output-empty' });
  });

  it('answers forge-output-too-large when stdout exceeds 1048576 bytes', async () => {
    const runGh = async (): Promise<GhInvocationResult> => ({ exitCode: 0, stdout: 'x'.repeat(1_048_577), stderr: '' });
    const adapter = new GhMergeVetoStateAdapter({ runGh, now: () => NOW_MS });
    expect(await adapter.readMergeVetoState(REQUEST)).toEqual({ status: 'unavailable', reason: 'forge-output-too-large' });
  });

  it('answers head-moved when the forge head is not the requested head', async () => {
    const { adapter } = adapterWith(answer({ headRefOid: 'a'.repeat(40) }));
    expect(await adapter.readMergeVetoState(REQUEST)).toEqual({ status: 'unavailable', reason: 'head-moved' });
  });
});
