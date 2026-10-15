// Step 4 — fail-closed ForgeEvidenceAdapter tests. Every unreadable forge
// answer must surface as an `unknown` CI state or a `null` thread count,
// never as a pass or a zero, and a head that does not resolve to exactly one
// open pull request stops the read after a single gh call.

import { describe, expect, it } from 'vitest';

import type { GhCommandResult } from '../ForgeEvidenceAdapter.adapter.js';
import { ForgeEvidenceAdapter } from '../ForgeEvidenceAdapter.adapter.js';

const HEAD = '1111111111111111111111111111111111111111';
const OTHER_HEAD = '2222222222222222222222222222222222222222';
const OWNER = 'acme';
const REPO = 'widgets';
const PR_NUMBER = 37;
const UNRESOLVED_THREADS_QUERY =
  'query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){totalCount nodes{isResolved}}}}}';

/** Per-step scripted results; an Error makes that step's runGh reject. */
type GhScript = {
  readonly pulls?: GhCommandResult | Error;
  readonly checks?: GhCommandResult | Error;
  readonly threads?: GhCommandResult | Error;
};

function pullsResponse(entries: readonly unknown[]): GhCommandResult {
  return { exitCode: 0, stdout: JSON.stringify(entries) };
}

function openPull(number: number, headSha: string, state = 'open'): unknown {
  return { number, state, head: { sha: headSha } };
}

function checksResponse(buckets: readonly string[], exitCode = 0): GhCommandResult {
  return { exitCode, stdout: JSON.stringify(buckets.map((bucket) => ({ bucket }))) };
}

function threadsResponse(totalCount: number, unresolvedCount: number): GhCommandResult {
  const nodes = [
    ...Array.from({ length: unresolvedCount }, () => ({ isResolved: false })),
    ...(unresolvedCount < totalCount ? [{ isResolved: true }] : []),
  ];
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { totalCount, nodes } } } },
    }),
  };
}

/** A recording `gh` seam: every argv is captured, each step answers its script. */
function recordedGh(script: GhScript = {}): {
  readonly runGh: (args: readonly string[]) => Promise<GhCommandResult>;
  readonly calls: readonly (readonly string[])[];
} {
  const calls: string[][] = [];
  const runGh = async (args: readonly string[]): Promise<GhCommandResult> => {
    calls.push([...args]);
    const step =
      args[0] === 'pr' ? script.checks : args[1] === 'graphql' ? script.threads : script.pulls;
    if (step instanceof Error) {
      throw step;
    }
    return step ?? defaultResponse(args);
  };
  return { runGh, calls };
}

function defaultResponse(args: readonly string[]): GhCommandResult {
  if (args[0] === 'pr') {
    return checksResponse(['pass']);
  }
  if (args[1] === 'graphql') {
    return threadsResponse(0, 0);
  }
  return pullsResponse([openPull(PR_NUMBER, HEAD)]);
}

function adapterWith(script: GhScript): {
  readonly adapter: ForgeEvidenceAdapter;
  readonly calls: readonly (readonly string[])[];
} {
  const { runGh, calls } = recordedGh(script);
  return {
    adapter: new ForgeEvidenceAdapter({ owner: OWNER, repo: REPO, runGh }),
    calls,
  };
}

describe('ForgeEvidenceAdapter', () => {
  it('reads the head through owner/repo and records the exact argv of all three gh calls', async () => {
    const { adapter, calls } = adapterWith({
      checks: checksResponse(['pass', 'skipping']),
      threads: threadsResponse(3, 2),
    });

    expect(await adapter.readForgeCheckStatus({ candidateHeadSha: HEAD })).toEqual({
      candidateHeadSha: HEAD,
      ciState: 'pass',
      unresolvedThreadCount: 2,
    });
    expect(calls).toEqual([
      ['api', `repos/${OWNER}/${REPO}/commits/${HEAD}/pulls`],
      ['pr', 'checks', String(PR_NUMBER), '-R', `${OWNER}/${REPO}`, '--json', 'bucket'],
      [
        'api',
        'graphql',
        '-f',
        `query=${UNRESOLVED_THREADS_QUERY}`,
        '-F',
        `owner=${OWNER}`,
        '-F',
        `repo=${REPO}`,
        '-F',
        `number=${PR_NUMBER}`,
      ],
    ]);
  });

  it('maps every check bucket fixture; an empty or unrecognised list is never a pass', async () => {
    const fixtures: readonly [string, GhCommandResult, string][] = [
      ['pass', checksResponse(['pass']), 'pass'],
      ['fail', checksResponse(['fail']), 'fail'],
      ['cancel', checksResponse(['cancel']), 'fail'],
      ['pending while gh exits 8', checksResponse(['pending'], 8), 'pending'],
      ['skipping only', checksResponse(['skipping']), 'pass'],
      ['no checks at all', checksResponse([]), 'unknown'],
      ['unrecognised bucket', checksResponse(['nonsense']), 'unknown'],
    ];

    for (const [label, checks, expectedCiState] of fixtures) {
      const { adapter } = adapterWith({ checks, threads: threadsResponse(1, 1) });
      const status = await adapter.readForgeCheckStatus({ candidateHeadSha: HEAD });
      expect(status.ciState, label).toBe(expectedCiState);
      expect(status.unresolvedThreadCount, label).toBe(1);
    }
  });

  it('stops after one gh call when no pull request for the head is open', async () => {
    const { adapter, calls } = adapterWith({
      pulls: pullsResponse([openPull(PR_NUMBER, HEAD, 'closed')]),
    });

    expect(await adapter.readForgeCheckStatus({ candidateHeadSha: HEAD })).toEqual({
      candidateHeadSha: HEAD,
      ciState: 'unknown',
      unresolvedThreadCount: null,
    });
    expect(calls).toEqual([['api', `repos/${OWNER}/${REPO}/commits/${HEAD}/pulls`]]);
  });

  it('stops after one gh call when the head resolves to two open pull requests', async () => {
    const { adapter, calls } = adapterWith({
      pulls: pullsResponse([openPull(31, HEAD), openPull(32, HEAD)]),
    });

    expect(await adapter.readForgeCheckStatus({ candidateHeadSha: HEAD })).toEqual({
      candidateHeadSha: HEAD,
      ciState: 'unknown',
      unresolvedThreadCount: null,
    });
    expect(calls).toEqual([['api', `repos/${OWNER}/${REPO}/commits/${HEAD}/pulls`]]);
  });

  it('stops after one gh call when the only pull request has a different head', async () => {
    const { adapter, calls } = adapterWith({
      pulls: pullsResponse([openPull(PR_NUMBER, OTHER_HEAD)]),
    });

    expect(await adapter.readForgeCheckStatus({ candidateHeadSha: HEAD })).toEqual({
      candidateHeadSha: HEAD,
      ciState: 'unknown',
      unresolvedThreadCount: null,
    });
    expect(calls).toEqual([['api', `repos/${OWNER}/${REPO}/commits/${HEAD}/pulls`]]);
  });

  it('reports unknown CI but still reads threads when gh pr checks fails', async () => {
    const { adapter, calls } = adapterWith({
      checks: { exitCode: 1, stdout: 'gh: checks unavailable' },
      threads: threadsResponse(3, 2),
    });

    expect(await adapter.readForgeCheckStatus({ candidateHeadSha: HEAD })).toEqual({
      candidateHeadSha: HEAD,
      ciState: 'unknown',
      unresolvedThreadCount: 2,
    });
    expect(calls.length).toBe(3);
  });

  it('reports a null thread count when the threads call exits non-zero', async () => {
    const { adapter } = adapterWith({ threads: { exitCode: 1, stdout: 'gh: graphql failed' } });

    expect(await adapter.readForgeCheckStatus({ candidateHeadSha: HEAD })).toEqual({
      candidateHeadSha: HEAD,
      ciState: 'pass',
      unresolvedThreadCount: null,
    });
  });

  it('reports a null thread count when the threads payload is not JSON', async () => {
    const { adapter } = adapterWith({ threads: { exitCode: 0, stdout: 'not graphql json' } });

    expect(await adapter.readForgeCheckStatus({ candidateHeadSha: HEAD })).toEqual({
      candidateHeadSha: HEAD,
      ciState: 'pass',
      unresolvedThreadCount: null,
    });
  });

  it('reports a null thread count when the threads payload misses the reviewThreads path', async () => {
    const { adapter } = adapterWith({
      threads: {
        exitCode: 0,
        stdout: JSON.stringify({ data: { repository: { pullRequest: null } } }),
      },
    });

    expect(await adapter.readForgeCheckStatus({ candidateHeadSha: HEAD })).toEqual({
      candidateHeadSha: HEAD,
      ciState: 'pass',
      unresolvedThreadCount: null,
    });
  });

  it('reports a null thread count when review threads span more than one page', async () => {
    const { adapter } = adapterWith({ threads: threadsResponse(101, 2) });

    expect(await adapter.readForgeCheckStatus({ candidateHeadSha: HEAD })).toEqual({
      candidateHeadSha: HEAD,
      ciState: 'pass',
      unresolvedThreadCount: null,
    });
  });

  it('counts exactly the unresolved review threads on one page', async () => {
    const { adapter } = adapterWith({ threads: threadsResponse(3, 2) });

    expect(await adapter.readForgeCheckStatus({ candidateHeadSha: HEAD })).toEqual({
      candidateHeadSha: HEAD,
      ciState: 'pass',
      unresolvedThreadCount: 2,
    });
  });

  it('turns a rejecting runGh at any step into unknown and null instead of throwing', async () => {
    const rejectingPulls = adapterWith({ pulls: new Error('gh exploded') });
    const rejectingChecks = adapterWith({ checks: new Error('gh exploded') });
    const rejectingThreads = adapterWith({ threads: new Error('gh exploded') });

    for (const { adapter } of [rejectingPulls, rejectingChecks, rejectingThreads]) {
      expect(await adapter.readForgeCheckStatus({ candidateHeadSha: HEAD })).toEqual({
        candidateHeadSha: HEAD,
        ciState: 'unknown',
        unresolvedThreadCount: null,
      });
    }
  });

  it('refuses without any gh call when owner or repo is missing or malformed', async () => {
    const missingOwner = recordedGh();
    const missingRepo = recordedGh();
    const malformedOwner = recordedGh();

    const withoutOwner = new ForgeEvidenceAdapter({ repo: REPO, runGh: missingOwner.runGh });
    const withoutRepo = new ForgeEvidenceAdapter({ owner: OWNER, runGh: missingRepo.runGh });
    const withSlashInOwner = new ForgeEvidenceAdapter({
      owner: 'fleet/fleet',
      repo: REPO,
      runGh: malformedOwner.runGh,
    });

    for (const adapter of [withoutOwner, withoutRepo, withSlashInOwner]) {
      expect(await adapter.readForgeCheckStatus({ candidateHeadSha: HEAD })).toEqual({
        candidateHeadSha: HEAD,
        ciState: 'unknown',
        unresolvedThreadCount: null,
      });
    }
    expect(missingOwner.calls).toEqual([]);
    expect(missingRepo.calls).toEqual([]);
    expect(malformedOwner.calls).toEqual([]);
  });

  it('refuses without any gh call when the candidate head is not a 40-hex sha', async () => {
    const { adapter, calls } = adapterWith({});

    for (const candidateHeadSha of ['', 'abc123', 'A'.repeat(40)]) {
      expect(await adapter.readForgeCheckStatus({ candidateHeadSha })).toEqual({
        candidateHeadSha,
        ciState: 'unknown',
        unresolvedThreadCount: null,
      });
    }
    expect(calls).toEqual([]);
  });
});
