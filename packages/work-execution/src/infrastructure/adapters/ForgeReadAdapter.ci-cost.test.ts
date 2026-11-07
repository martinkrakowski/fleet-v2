// ForgeReadAdapter.readPullRequestCiCost (CO20): one read-only paginated
// graphql query per merged pull request; check runs and billed whole minutes
// per workflow; a thrown, partial, incomplete, oversized, unmerged or
// unreadable answer is unavailable, never zero or empty, and carries fixed
// reason codes only — never a path, a stderr line or a secret shape.

import { describe, expect, it } from 'vitest';

import type { GhInvocationResult } from './ForgeActionAdapter.adapter.js';
import {
  ForgeReadAdapter,
  MAX_CI_COST_PAGES,
  MAX_CI_COST_WORKFLOWS,
  PULL_REQUEST_CI_COST_QUERY,
  WORKFLOW_NAME_MAX_LENGTH,
  isSafeWorkflowName,
  parsePullRequestCiCostPage,
  type ForgeReadAdapterOptions,
} from './ForgeReadAdapter.adapter.js';
import type { ReadPullRequestCiCostRequest, ReadPullRequestCiCostResult } from '../../application/ports/out/ForgeReadPort.out-port.js';

const HEAD = '3dd5d90509461e3d2154b52da28671aeffa84130';
const HEAD_OTHER = '8e136fe0e0cc916b9d3485eaafe653e3143d9d63';

function ok(stdout: string): GhInvocationResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function makeAdapter(options: Partial<ForgeReadAdapterOptions> = {}): ForgeReadAdapter {
  return new ForgeReadAdapter({ owner: 'fleet', repo: 'fleet-v2', runGh: async () => ok(''), ...options });
}

interface SuiteSpec {
  readonly name: string;
  readonly runs: readonly RunSpec[];
  readonly hasMore?: boolean;
}

type RunSpec = readonly [number, number] | 'in-progress' | 'queued';

function checkRunOf(start: number, end: number): Record<string, unknown> {
  const stamp = (seconds: number) =>
    `2026-01-01T00:${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}Z`;
  return { status: 'COMPLETED', startedAt: stamp(start), completedAt: stamp(end) };
}

/** A full GraphQL page string for one pull request, built from terse specs. */
function pageJson(specs: {
  readonly number?: number;
  readonly state?: string;
  readonly head?: string;
  readonly suites?: readonly SuiteSpec[];
  readonly suiteHasNextPage?: boolean;
  readonly suiteEndCursor?: string | null;
}): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          number: specs.number ?? 7,
          state: specs.state ?? 'MERGED',
          headRefOid: specs.head ?? HEAD,
          commits: {
            nodes: [
              {
                commit: {
                  oid: specs.head ?? HEAD,
                  checkSuites: {
                    pageInfo: {
                      hasNextPage: specs.suiteHasNextPage ?? false,
                      endCursor: specs.suiteEndCursor ?? null,
                    },
                    nodes: (specs.suites ?? []).map((suite) => ({
                      workflowRun: { workflow: { name: suite.name } },
                      checkRuns: {
                        pageInfo: { hasNextPage: suite.hasMore ?? false },
                        nodes: suite.runs.map((run) =>
                          run === 'in-progress' || run === 'queued'
                            ? {
                                status: run === 'in-progress' ? 'IN_PROGRESS' : 'QUEUED',
                                startedAt: '2026-01-01T00:00:00Z',
                                completedAt: null,
                              }
                            : checkRunOf(run[0], run[1]),
                        ),
                      },
                    })),
                  },
                },
              },
            ],
          },
        },
      },
    },
  });
}

function read(adapter: ForgeReadAdapter, request: ReadPullRequestCiCostRequest): Promise<ReadPullRequestCiCostResult> {
  return adapter.readPullRequestCiCost(request);
}

/** A one-workflow page whose workflow name carries the suite's run spec. */
function singleSuite(name: string, run: RunSpec): string {
  return pageJson({ suites: [{ name, runs: [run] }] });
}

describe('readPullRequestCiCost', () => {
  it('aggregates check runs and rounded-up whole billed minutes (0s->0m, 1s->1m, 60s->1m, 61s->2m) per workflow across multiple pages, sorted by workflowName, using -f for string variables and -F for number', async () => {
    const calls: (readonly string[])[] = [];
    const adapter = new ForgeReadAdapter({
      owner: 'fleet',
      repo: 'fleet-v2',
      runGh: async (args) => {
        calls.push(args);
        return ok(pageJson({ suites: args.some((a) => a.startsWith('after='))
          ? [{ name: 'beta', runs: [[0, 60], [0, 62]] as RunSpec[] }]
          : [{ name: 'alpha', runs: [[0, 0], [0, 1]] as RunSpec[] }],
        suiteHasNextPage: !args.some((a) => a.startsWith('after=')),
        suiteEndCursor: args.some((a) => a.startsWith('after=')) ? null : 'c1' }));
      },
    });
    const result = await read(adapter, { pullRequestNumber: 7 });
    expect(result).toEqual({
      outcome: 'found',
      cost: {
        pullRequestNumber: 7,
        headSha: HEAD,
        totalCheckRuns: 4,
        totalBilledMinutes: 4,
        workflows: [
          { workflowName: 'alpha', checkRuns: 2, billedMinutes: 1 },
          { workflowName: 'beta', checkRuns: 2, billedMinutes: 3 },
        ],
      },
    });
    const first = calls[0] as readonly string[];
    expect(first.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(first).toContain(`query=${PULL_REQUEST_CI_COST_QUERY}`);
    expect(first).toContain('owner=fleet');
    expect(first).toContain('repo=fleet-v2');
    expect(first).toContain('-F');
    expect(first).toContain('number=7');
    expect((calls[1] as readonly string[])).toContain('after=c1');
  });

  it('returns unavailable without throwing on null, non-object, bad pullRequestNumber, bad repository, unknown status enum, sparse arrays, and throwing getters', async () => {
    const adapter = makeAdapter();
    expect(await read(adapter, undefined as never)).toEqual({ outcome: 'unavailable', reason: 'invalid-request' });
    expect(await read(adapter, null as never)).toEqual({ outcome: 'unavailable', reason: 'invalid-request' });
    expect(await read(adapter, 7 as never)).toEqual({ outcome: 'unavailable', reason: 'invalid-request' });
    expect(await read(adapter, [] as never)).toEqual({ outcome: 'unavailable', reason: 'invalid-request' });
    expect(await read(adapter, new Date() as never)).toEqual({ outcome: 'unavailable', reason: 'invalid-request' });
    expect(await read(adapter, { pullRequestNumber: 0 })).toEqual({ outcome: 'unavailable', reason: 'invalid-request' });
    expect(await read(adapter, { pullRequestNumber: 1.5 })).toEqual({ outcome: 'unavailable', reason: 'invalid-request' });
    expect(await read(adapter, { pullRequestNumber: '7' as never })).toEqual({ outcome: 'unavailable', reason: 'invalid-request' });
    expect(await read(adapter, { pullRequestNumber: 7, repository: { owner: '', repo: 'x' } })).toEqual({ outcome: 'unavailable', reason: 'invalid-repository' });
    expect(await read(adapter, { pullRequestNumber: 7, repository: { owner: 'a/b', repo: 'x' } })).toEqual({ outcome: 'unavailable', reason: 'invalid-repository' });
    const throwing = {};
    Object.defineProperty(throwing, 'pullRequestNumber', { get() { throw new Error('boom'); } });
    expect(await read(adapter, throwing as never)).toEqual({ outcome: 'unavailable', reason: 'invalid-request' });
    expect(
      await read(makeAdapter({ runGh: async () => ok(singleSuite('ci', 'queued')) }), { pullRequestNumber: 7 }),
    ).toEqual({ outcome: 'unavailable', reason: 'partial-ci-cost' });
    const sparse = new Array(2);
    sparse[0] = { commit: { oid: HEAD, checkSuites: { pageInfo: { hasNextPage: false }, nodes: [] } } };
    const sparseParse = parsePullRequestCiCostPage(
      {
        data: {
          repository: { pullRequest: { number: 7, state: 'MERGED', headRefOid: HEAD, commits: { nodes: sparse } } },
        },
      },
      7,
      0,
      null,
    );
    expect(sparseParse).toEqual({ kind: 'fail', reason: 'unreadable-ci-cost' });
  });

  it('is unavailable when no transport is configured', async () => {
    expect(await new ForgeReadAdapter().readPullRequestCiCost({ pullRequestNumber: 7 })).toEqual({
      outcome: 'unavailable',
      reason: 'forge-not-configured',
    });
  });

  it('bounds multi-page CI-cost reads by timeoutMs and returns ci-cost-timed-out when deadline expires mid-pagination', async () => {
    const never = new Promise<GhInvocationResult>(() => undefined);
    const mid = makeAdapter({
      runGh: async (args) => (args.some((a) => a.startsWith('after=')) ? never : ok(pageJson({ suites: [], suiteHasNextPage: true, suiteEndCursor: 'c1' }))),
      timeoutMs: 50,    });
    expect(await read(mid, { pullRequestNumber: 7 })).toEqual({ outcome: 'unavailable', reason: 'ci-cost-timed-out' });
    const early = makeAdapter({ runGh: async () => ok(singleSuite('ci', [0, 1])) });
    expect(await read(early, { pullRequestNumber: 7, timeoutMs: -1 })).toEqual({ outcome: 'unavailable', reason: 'ci-cost-timed-out' });
    expect(await read(early, { pullRequestNumber: 7, timeoutMs: Number.NaN })).toEqual({ outcome: 'unavailable', reason: 'invalid-request' });
    let calls = 0;
    const counted = makeAdapter({
      runGh: async () => {
        calls += 1;
        return ok(singleSuite('ci', [0, 1]));
      },
    });
    await read(counted, { pullRequestNumber: 7, timeoutMs: 0 });
    expect(calls).toBe(0);
  });

  it('returns { outcome: not-found } when page 1 has no pull request and unavailable (pull-request-not-merged) for OPEN or CLOSED PRs', async () => {
    const absent = makeAdapter({ runGh: async () => ok(JSON.stringify({ data: { repository: { pullRequest: null } } })) });
    expect(await read(absent, { pullRequestNumber: 7 })).toEqual({ outcome: 'not-found' });
    const absentRepository = makeAdapter({ runGh: async () => ok(JSON.stringify({ data: { repository: null } })) });
    expect(await read(absentRepository, { pullRequestNumber: 7 })).toEqual({ outcome: 'not-found' });
    for (const state of ['OPEN', 'CLOSED']) {
      const unmerged = makeAdapter({ runGh: async () => ok(pageJson({ state, suites: [{ name: 'ci', runs: [[0, 1]] }] })) });
      expect(await read(unmerged, { pullRequestNumber: 7 })).toEqual({ outcome: 'unavailable', reason: 'pull-request-not-merged' });
    }
  });

  it('reports thrown, partial, incomplete, and unmerged PR CI-cost answers as unavailable, never zero or empty', async () => {
    const thrown = makeAdapter({
      runGh: async () => {
        throw new Error('spawn failed at /home/someone/bin/gh');
      },
    });
    const thrownResult = await read(thrown, { pullRequestNumber: 7 });
    expect(thrownResult.outcome).toBe('unavailable');
    expect(JSON.stringify(thrownResult)).not.toContain('/home/someone');
    const failed = makeAdapter({ runGh: async () => ({ exitCode: 3, stdout: '', stderr: 'network down' }) });
    expect(await read(failed, { pullRequestNumber: 7 })).toEqual({ outcome: 'unavailable', reason: 'ci-cost-failed' });
    const graphqlErrors = makeAdapter({ runGh: async () => ok(JSON.stringify({ errors: [{ message: 'bad thing happened' }], data: null })) });
    expect(await read(graphqlErrors, { pullRequestNumber: 7 })).toEqual({ outcome: 'unavailable', reason: 'unreadable-ci-cost' });
    const notJson = makeAdapter({ runGh: async () => ok('<html>') });
    expect(await read(notJson, { pullRequestNumber: 7 })).toEqual({ outcome: 'unavailable', reason: 'unreadable-ci-cost' });
    const otherNumber = makeAdapter({ runGh: async () => ok(pageJson({ number: 9, suites: [{ name: 'ci', runs: [[0, 1]] }] })) });
    expect(await read(otherNumber, { pullRequestNumber: 7 })).toEqual({ outcome: 'unavailable', reason: 'different-pull-request' });
    const movedHead = makeAdapter({
      runGh: async (args) =>
        args.some((a) => a.startsWith('after='))
          ? ok(pageJson({ head: HEAD_OTHER, suites: [] }))
          : ok(pageJson({ head: HEAD, suites: [], suiteHasNextPage: true, suiteEndCursor: 'c1' })),
    });
    expect(await read(movedHead, { pullRequestNumber: 7 })).toEqual({ outcome: 'unavailable', reason: 'partial-ci-cost' });
    const truncatedRuns = makeAdapter({ runGh: async () => ok(pageJson({ suites: [{ name: 'ci', runs: [[0, 1]], hasMore: true }] })) });
    expect(await read(truncatedRuns, { pullRequestNumber: 7 })).toEqual({ outcome: 'unavailable', reason: 'partial-ci-cost' });
    const missingCursor = makeAdapter({ runGh: async () => ok(pageJson({ suites: [], suiteHasNextPage: true, suiteEndCursor: null })) });
    expect(await read(missingCursor, { pullRequestNumber: 7 })).toEqual({ outcome: 'unavailable', reason: 'partial-ci-cost' });
  });

  it('suppresses secret-shaped and path-shaped workflow names and gh stderr, returning fixed reason codes only', async () => {
    const token = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
    const secretShaped = makeAdapter({ runGh: async () => ok(singleSuite(`run-${token}`, [0, 1])) });
    const secretResult = await read(secretShaped, { pullRequestNumber: 7 });
    expect(secretResult).toEqual({ outcome: 'unavailable', reason: 'unreadable-ci-cost' });
    expect(JSON.stringify(secretResult)).not.toContain(token);
    const pathShaped = makeAdapter({ runGh: async () => ok(singleSuite('build/deploy', [0, 1])) });
    expect(await read(pathShaped, { pullRequestNumber: 7 })).toEqual({ outcome: 'unavailable', reason: 'unreadable-ci-cost' });
    const failingWithSecret = makeAdapter({ runGh: async () => ({ exitCode: 9, stdout: '', stderr: `denied for ${token}` }) });
    const failedResult = await read(failingWithSecret, { pullRequestNumber: 7 });
    expect(failedResult).toEqual({ outcome: 'unavailable', reason: 'ci-cost-failed' });
    expect(JSON.stringify(failedResult)).not.toContain(token);
    const nameTooLong = makeAdapter({ runGh: async () => ok(singleSuite('w'.repeat(WORKFLOW_NAME_MAX_LENGTH + 1), [0, 1])) });
    expect(await read(nameTooLong, { pullRequestNumber: 7 })).toEqual({ outcome: 'unavailable', reason: 'unreadable-ci-cost' });
  });

  it('invokes runGh only with read-only graphql argv and never passes mutating flags or shell syntax', async () => {
    let seen: readonly string[] = [];
    const adapter = makeAdapter({
      runGh: async (args) => {
        seen = args;
        return ok(singleSuite('ci', [0, 1]));
      },
    });
    await read(adapter, { pullRequestNumber: 7 });
    expect(seen[0]).toBe('api');
    expect(seen[1]).toBe('graphql');
    for (const arg of seen) {
      expect(arg).not.toMatch(/^(-X|--method|--input|-d|--raw-field)$/);
      expect(arg).not.toMatch(/[;&|`><]/);
    }
  });

  it('returns ci-cost-too-large or partial-ci-cost when gh stdout, page count, or workflow count exceeds bounds', async () => {
    const big = makeAdapter({
      runGh: async () => ok(`${pageJson({ suites: [{ name: 'ci', runs: [[0, 1]] }] })}${' '.repeat(1_048_577)}`),
    });
    expect(await read(big, { pullRequestNumber: 7 })).toEqual({ outcome: 'unavailable', reason: 'ci-cost-too-large' });
    const manySuites: SuiteSpec[] = [];
    for (let index = 0; index < MAX_CI_COST_WORKFLOWS + 1; index += 1) {
      manySuites.push({ name: `workflow-${index}`, runs: [[0, 1]] });
    }
    const tooManyWorkflows = makeAdapter({ runGh: async () => ok(pageJson({ suites: manySuites })) });
    expect(await read(tooManyWorkflows, { pullRequestNumber: 7 })).toEqual({ outcome: 'unavailable', reason: 'ci-cost-too-large' });
    let page = 0;
    const tooManyPages = makeAdapter({
      runGh: async () => {
        page += 1;
        return ok(pageJson({ suites: [], suiteHasNextPage: true, suiteEndCursor: `c${page}` }));
      },
    });
    expect(await read(tooManyPages, { pullRequestNumber: 7 })).toEqual({ outcome: 'unavailable', reason: 'partial-ci-cost' });
    expect(page).toBeLessThanOrEqual(MAX_CI_COST_PAGES);
  });

  it('skips a non-Actions suite (workflowRun null) and verifies the head across pages', async () => {
    const adapter = new ForgeReadAdapter({
      owner: 'fleet',
      repo: 'fleet-v2',
      runGh: async (args) => {
        if (args.some((a) => a.startsWith('after='))) {
          return ok(JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  number: 7,
                  state: 'MERGED',
                  headRefOid: HEAD,
                  commits: {
                    nodes: [{
                      commit: {
                        oid: HEAD,
                        checkSuites: {
                          pageInfo: { hasNextPage: false, endCursor: null },
                          nodes: [
                            { workflowRun: null, checkRuns: { pageInfo: { hasNextPage: false }, nodes: [checkRunOf(0, 1)] } },
                            { workflowRun: { workflow: { name: 'gamma' } }, checkRuns: { pageInfo: { hasNextPage: false }, nodes: [checkRunOf(0, 60)] } },
                          ],
                        },
                      },
                    }],
                  },
                },
              },
            },
          }));
        }
        return ok(pageJson({ suites: [], suiteHasNextPage: true, suiteEndCursor: 'c1' }));
      },
    });
    const result = await read(adapter, { pullRequestNumber: 7 });    expect(result).toEqual({
      outcome: 'found',
      cost: {
        pullRequestNumber: 7,
        headSha: HEAD,
        totalCheckRuns: 1,
        totalBilledMinutes: 1,
        workflows: [{ workflowName: 'gamma', checkRuns: 1, billedMinutes: 1 }],
      },
    });
  });

  it('rejects a workflow name that matches the legacy secret registry as well as the lane-diff one', () => {
    const slackShaped = ['xoxs', 'abcdefghij'].join('-');
    expect(isSafeWorkflowName(slackShaped)).toBe(false);
    expect(isSafeWorkflowName(`ci ${slackShaped}`)).toBe(false);
    expect(isSafeWorkflowName('build')).toBe(true);
  });
});
