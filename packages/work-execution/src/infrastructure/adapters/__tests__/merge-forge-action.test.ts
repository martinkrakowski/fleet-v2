// MergeForgeActionPort tests for the repo-scoped merge pass path (DT6a):
// the adapter performs merge-pr / update-branch / post-status against an
// explicit repository with per-kind GH_CONFIG_DIR routing, a deadline
// budget that refuses calls with fewer than 2 s left, and reads that are
// bounded to the remaining time. Every delegate is injected; nothing writes
// to a forge. Style follows forge-post-status.test.ts.

import { describe, expect, it } from 'vitest';

import { ForgeActionAdapter } from '../ForgeActionAdapter.adapter.js';
import type { MergeForgeActionRequest } from '../../../application/ports/out/MergeForgeActionPort.out-port.js';
import type {
  PullRequestSnapshot,
  ReadPullRequestRequest,
  ReadPullRequestResult,
} from '../../../application/ports/out/ForgeReadPort.out-port.js';

const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const BRANCH = 'feat/merge-lane';
const OWNER = 'fleet';
const REPO = 'fleet-v2';
const PR_NUMBER = 12;
const MERGE_DIR = '/state/gh/merge';
const PREMERGE_DIR = '/state/gh/premerge';
const DEADLINE_ISO = '2026-11-01T12:00:10.000Z';

function mergeRequest(
  overrides: {
    kind?: MergeForgeActionRequest['kind'];
    status?: unknown;
    [key: string]: unknown;
  } = {},
): MergeForgeActionRequest {
  return {
    actionId: 'action-merge-1',
    repository: { owner: OWNER, repo: REPO },
    pullRequestNumber: PR_NUMBER,
    branchName: BRANCH,
    expectedHeadSha: HEAD_SHA,
    deadlineIso: DEADLINE_ISO,
    kind: 'merge-pr',
    ...overrides,
  } as MergeForgeActionRequest;
}

type ReadBehavior = ReadPullRequestResult | { throw: true };

interface RunGhCall {
  readonly args: string[];
  readonly ghConfigDir?: string;
  readonly timeoutMs?: number;
}

function makeRunGh(result: { exitCode: number; stdout: string; stderr: string } | { throw: true }) {
  const calls: RunGhCall[] = [];
  const runGh = async (args: readonly string[], ghConfigDir?: string, timeoutMs?: number) => {
    calls.push({ args: [...args], ghConfigDir, timeoutMs });
    if ('throw' in result) {
      throw new Error('gh subprocess timed out');
    }
    return result;
  };
  return { calls, runGh };
}

function makeReader(behavior: ReadBehavior | ReadBehavior[]) {
  const requests: ReadPullRequestRequest[] = [];
  const pending: ReadBehavior[] = Array.isArray(behavior) ? [...behavior] : [behavior];
  let last = pending[pending.length - 1]!;
  const readPullRequest = async (request: ReadPullRequestRequest): Promise<ReadPullRequestResult> => {
    requests.push(request);
    if (pending.length > 0) {
      last = pending.shift()!;
    }
    if ('throw' in last) {
      throw new Error('pull request read failed');
    }
    return last;
  };
  return { requests, readPullRequest };
}

function foundSnapshot(
  overrides: {
    readonly state?: PullRequestSnapshot['state'];
    readonly headSha?: string;
    readonly headRef?: string;
  } = {},
): ReadPullRequestResult {
  return {
    outcome: 'found',
    pullRequest: {
      number: PR_NUMBER,
      state: overrides.state ?? 'open',
      mergeState: 'clean',
      headSha: overrides.headSha ?? HEAD_SHA,
      headRef: overrides.headRef ?? BRANCH,
      isCrossRepository: false,
      headRepositoryOwner: 'fleet',      baseRef: 'main',
      mergedAtIso: overrides.state === 'merged' ? '2026-11-01T12:00:05.000Z' : null,
      closedAtIso: null,
      mergeCommitSha: overrides.state === 'merged' ? HEAD_SHA : null,
    },
  };
}

function makeClock(nowIso?: string) {
  const current = nowIso ?? '2026-11-01T12:00:00.000Z';
  return { nowIso: () => current };
}

function snapshotToStdout(pullRequest: PullRequestSnapshot): string {
  return JSON.stringify({
    number: pullRequest.number,
    state: pullRequest.state.toUpperCase(),
    headRefOid: pullRequest.headSha,
    headRefName: pullRequest.headRef,
    baseRefName: pullRequest.baseRef,
    mergedAt: pullRequest.mergedAtIso,
    closedAt: pullRequest.closedAtIso,
    mergeCommit: pullRequest.mergeCommitSha !== null ? { oid: pullRequest.mergeCommitSha } : null,
    mergeStateStatus: pullRequest.mergeState.toUpperCase(),
    isCrossRepository: pullRequest.isCrossRepository,
    headRepositoryOwner: { login: pullRequest.headRepositoryOwner },
  });
}

function makeAdapter(options: {
  readonly runGhResult?: { exitCode: number; stdout: string; stderr: string } | { throw: true };
  readonly reader?: ReadBehavior | ReadBehavior[];
  readonly config?: { readonly premergeGhConfigDir?: string; readonly mergeGhConfigDir?: string };
  readonly nowIso?: string;
} = {}) {
  const { calls, runGh } = makeRunGh(
    options.runGhResult ?? { exitCode: 0, stdout: '', stderr: '' },
  );
  const { requests, readPullRequest } = makeReader(options.reader ?? foundSnapshot());
  const config = options.config ?? {
    mergeGhConfigDir: MERGE_DIR,
    premergeGhConfigDir: PREMERGE_DIR,
  };
  const adapter = new ForgeActionAdapter(
    {
      runGh: async (args, ghConfigDir, timeoutMs) => {
        if (args[0] === 'pr' && args[1] === 'view') {
          const isNumber = /^\d+$/.test(args[2] ?? '');
          const ref = isNumber
            ? { kind: 'number' as const, number: parseInt(args[2]!, 10) }
            : { kind: 'branch' as const, branchName: args[2]! };
          let repository: { owner: string; repo: string } | undefined;
          const rIndex = args.indexOf('-R');
          if (rIndex !== -1 && args[rIndex + 1]) {
            const [owner, repo] = args[rIndex + 1]!.split('/');
            if (owner && repo) {
              repository = { owner, repo };
            }
          }
          const readResult = await readPullRequest({ ref, repository, timeoutMs });
          if (readResult.outcome === 'found') {
            return {
              exitCode: 0,
              stdout: snapshotToStdout(readResult.pullRequest),
              stderr: '',
            };
          }
          if (readResult.outcome === 'not-found') {
            return {
              exitCode: 1,
              stdout: '',
              stderr: 'no pull requests found for branch',
            };
          }
          return {
            exitCode: 1,
            stdout: '',
            stderr: readResult.reason,
          };
        }
        return runGh(args, ghConfigDir, timeoutMs);
      },
      pullRequestRead: { readPullRequest },
      nowIso: makeClock(options.nowIso).nowIso,
    },
    undefined,
    config,
  );
  return { adapter, calls, requests };
}

describe('ForgeActionAdapter merge-pass path (MergeForgeActionPort)', () => {
  it('refuses a moved head before any gh call', async () => {
    const { adapter, calls, requests } = makeAdapter({
      reader: foundSnapshot({ headSha: OTHER_SHA }),
      config: { mergeGhConfigDir: MERGE_DIR },
    });
    const result = await adapter.performMergeForgeAction(mergeRequest());
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'the pull request head moved since verification',
      refusalKind: 'other',
    });
    expect(calls).toHaveLength(0);
    expect(requests).toHaveLength(1);
  });

  it('refuses when the pull request head branch does not match the request branch', async () => {
    const { adapter, calls, requests } = makeAdapter({
      reader: foundSnapshot({ headRef: 'feat/other-branch' }),
      config: { mergeGhConfigDir: MERGE_DIR },
    });
    const result = await adapter.performMergeForgeAction(mergeRequest());
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'the pull request head branch does not match the request',
      refusalKind: 'other',
    });
    expect(calls).toHaveLength(0);
    expect(requests).toHaveLength(1);
  });

  it('merges pinned to the repo and the expected head with the merger config dir', async () => {
    const { adapter, calls } = makeAdapter({
      config: { mergeGhConfigDir: MERGE_DIR },
    });
    const result = await adapter.performMergeForgeAction(mergeRequest());
    expect(result).toEqual({ outcome: 'executed', headSha: HEAD_SHA });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([
      'pr',
      'merge',
      '-R',
      `${OWNER}/${REPO}`,
      String(PR_NUMBER),
      '--match-head-commit',
      HEAD_SHA,
      '--merge',
    ]);
    expect(calls[0].ghConfigDir).toBe(MERGE_DIR);
  });

  it('re-reads the head up to three times after update-branch and reports the new head', async () => {
    const { adapter, calls } = makeAdapter({
      reader: [
        foundSnapshot(),
        foundSnapshot(),
        foundSnapshot({ headSha: OTHER_SHA }),
      ],
      config: { mergeGhConfigDir: MERGE_DIR },
    });
    const result = await adapter.performMergeForgeAction(mergeRequest({ kind: 'update-branch' }));
    expect(result).toEqual({ outcome: 'executed', headSha: OTHER_SHA });
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0]).toBe('api');
    expect(calls[0].args[1]).toBe(`repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/update-branch`);
    expect(calls[0].args).toContain(`expected_head_sha=${HEAD_SHA}`);
    expect(calls[0].args).toContain('PUT');
    expect(calls[0].ghConfigDir).toBe(MERGE_DIR);
  });

  it('reports ambiguous when all re-reads still show the old head', async () => {
    const { adapter, calls } = makeAdapter({
      reader: [
        foundSnapshot(),
        foundSnapshot(),
        foundSnapshot(),
        foundSnapshot(),
      ],
      config: { mergeGhConfigDir: MERGE_DIR },
    });
    const result = await adapter.performMergeForgeAction(mergeRequest({ kind: 'update-branch' }));
    expect(result).toEqual({
      outcome: 'ambiguous',
      reason: 'branch update accepted but the head is unchanged',
    });
    expect(calls).toHaveLength(1);
  });

  it('refuses a status field on a non-post-status kind without reading or calling gh', async () => {
    const { adapter, calls, requests } = makeAdapter();
    const withStatus = {
      ...mergeRequest(),
      status: {
        context: 'premerge' as const,
        state: 'success' as const,
        description: 'pre-merge receipt recorded',
      },
    } as unknown as MergeForgeActionRequest;
    const result = await adapter.performMergeForgeAction(withStatus);
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'status is only valid for post-status',
      refusalKind: 'other',
    });
    expect(calls).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it('refuses a post-status request without a status object without reading or calling gh', async () => {
    const { adapter, calls, requests } = makeAdapter();
    const withoutStatus = {
      actionId: 'action-merge-1',
      repository: { owner: OWNER, repo: REPO },
      pullRequestNumber: PR_NUMBER,
      branchName: BRANCH,
      expectedHeadSha: HEAD_SHA,
      deadlineIso: DEADLINE_ISO,
      kind: 'post-status',
    } as unknown as MergeForgeActionRequest;
    const result = await adapter.performMergeForgeAction(withoutStatus);
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'status is required for post-status',
      refusalKind: 'other',
    });
    expect(calls).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it('routes each kind to its identity config dir and classifies a merger permission failure', async () => {
    process.env.GH_CONFIG_DIR = '/inherited/config';
    try {
      const { adapter, calls } = makeAdapter({
        runGhResult: { exitCode: 1, stdout: '', stderr: 'HTTP 403: must have write access' },
        reader: foundSnapshot(),
        config: { premergeGhConfigDir: PREMERGE_DIR, mergeGhConfigDir: MERGE_DIR },
      });
      const result = await adapter.performMergeForgeAction(mergeRequest());
      expect(result).toEqual({
        outcome: 'refused',
        reason: 'gh pr merge exited non-zero; the pull request is not merged',
        refusalKind: 'permission',
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].ghConfigDir).toBe(MERGE_DIR);
      expect(calls[0].ghConfigDir).not.toBe(process.env.GH_CONFIG_DIR);
    } finally {
      delete process.env.GH_CONFIG_DIR;
    }
  });

  it('posts status with the premerge config dir only', async () => {
    const { adapter, calls } = makeAdapter({
      config: { premergeGhConfigDir: PREMERGE_DIR, mergeGhConfigDir: MERGE_DIR },
    });
    const result = await adapter.performMergeForgeAction(
      mergeRequest({
        kind: 'post-status',
        status: {
          context: 'premerge',
          state: 'success',
          description: 'pre-merge receipt recorded',
        },
      }),
    );
    expect(result).toEqual({ outcome: 'executed', headSha: HEAD_SHA });
    expect(calls).toHaveLength(1);
    expect(calls[0].ghConfigDir).toBe(PREMERGE_DIR);
  });

  it('refuses a merge without a merger identity even when GH_CONFIG_DIR is inherited', async () => {
    process.env.GH_CONFIG_DIR = '/inherited/config';
    try {
      const { adapter, calls, requests } = makeAdapter({
        config: { premergeGhConfigDir: PREMERGE_DIR },
      });
      const result = await adapter.performMergeForgeAction(mergeRequest());
      expect(result).toEqual({
        outcome: 'refused',
        reason: 'no merger identity is configured',
        refusalKind: 'other',
      });
      expect(calls).toHaveLength(0);
      expect(requests).toHaveLength(0);
    } finally {
      delete process.env.GH_CONFIG_DIR;
    }
  });

  it('refuses post-status without a premerge identity before reading the head', async () => {
    const { adapter, calls, requests } = makeAdapter({
      config: { mergeGhConfigDir: MERGE_DIR },
    });
    const result = await adapter.performMergeForgeAction(
      mergeRequest({
        kind: 'post-status',
        status: {
          context: 'premerge',
          state: 'success',
          description: 'pre-merge receipt recorded',
        },
      }),
    );
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'no premerge identity is configured',
      refusalKind: 'other',
    });
    expect(calls).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it('refuses an unsafe branch name before reading the head or calling gh', async () => {
    const { adapter, calls, requests } = makeAdapter({
      config: { mergeGhConfigDir: MERGE_DIR },
    });
    const result = await adapter.performMergeForgeAction(
      mergeRequest({ branchName: '--admin' }),
    );
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Invalid branch name: --admin',
      refusalKind: 'other',
    });
    expect(calls).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it('refuses an invalid expected head SHA before reading the head or calling gh', async () => {
    const { adapter, calls, requests } = makeAdapter({
      config: { mergeGhConfigDir: MERGE_DIR },
    });
    const result = await adapter.performMergeForgeAction(
      mergeRequest({ expectedHeadSha: 'not-a-valid-sha' }),
    );
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Invalid expected head SHA: not-a-valid-sha',
      refusalKind: 'other',
    });
    expect(calls).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it('refuses an invalid repository owner or repo before reading the head', async () => {
    const { adapter, calls, requests } = makeAdapter({
      config: { mergeGhConfigDir: MERGE_DIR },
    });
    const result = await adapter.performMergeForgeAction(
      mergeRequest({ repository: { owner: 'bad/owner', repo: REPO } }),
    );
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Invalid repository owner or repo',
      refusalKind: 'other',
    });
    expect(calls).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it('refuses an unpaired status description on post-status before reading the head', async () => {
    const { adapter, calls, requests } = makeAdapter({
      config: { premergeGhConfigDir: PREMERGE_DIR },
    });
    const result = await adapter.performMergeForgeAction(
      mergeRequest({
        kind: 'post-status',
        status: {
          context: 'premerge',
          state: 'success',
          description: 'arbitrary description phrase',
        },
      }),
    );
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'status description does not match its state',
      refusalKind: 'other',
    });
    expect(calls).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it('refuses an unparseable deadline before any call', async () => {
    const { adapter, calls, requests } = makeAdapter({
      config: { mergeGhConfigDir: MERGE_DIR },
    });
    const result = await adapter.performMergeForgeAction(
      mergeRequest({ deadlineIso: 'not-a-valid-iso-date' }),
    );
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'unparseable deadline',
      refusalKind: 'other',
    });
    expect(calls).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it('reports ambiguous with head-could-not-be-read when update-branch re-reads never answer', async () => {
    const { adapter, calls, requests } = makeAdapter({
      reader: [
        foundSnapshot(),
        { outcome: 'unavailable', reason: 'read timed out' },
        { outcome: 'unavailable', reason: 'read timed out' },
        { outcome: 'unavailable', reason: 'read timed out' },
      ],
      config: { mergeGhConfigDir: MERGE_DIR },
    });
    const result = await adapter.performMergeForgeAction(mergeRequest({ kind: 'update-branch' }));
    expect(result).toEqual({
      outcome: 'ambiguous',
      reason: 'branch update accepted but the head could not be read',
    });
    expect(calls).toHaveLength(1);
    expect(requests).toHaveLength(4);
  });

  it('reports ambiguous when update-branch fails and the head changed, whatever the refusal says', async () => {
    for (const stderr of ['HTTP 500 internal server error', 'merge conflict: cannot be cleanly created']) {
      const { adapter } = makeAdapter({
        runGhResult: { exitCode: 1, stdout: '', stderr },
        reader: [foundSnapshot(), foundSnapshot({ headSha: OTHER_SHA })],
        config: { mergeGhConfigDir: MERGE_DIR },
      });
      const result = await adapter.performMergeForgeAction(mergeRequest({ kind: 'update-branch' }));
      expect(result).toEqual({
        outcome: 'ambiguous',
        reason: 'gh api update-branch failed (exit 1) and the head changed',
      });
    }
  });

  it('reports ambiguous when update-branch fails with no definite refusal and the head is unchanged', async () => {
    const { adapter } = makeAdapter({
      runGhResult: { exitCode: 1, stdout: '', stderr: 'HTTP 500 internal server error' },
      reader: foundSnapshot(),
      config: { mergeGhConfigDir: MERGE_DIR },
    });
    const result = await adapter.performMergeForgeAction(mergeRequest({ kind: 'update-branch' }));
    expect(result.outcome).toBe('ambiguous');
  });

  it('reports refused when update-branch definitely refused and the head is unchanged', async () => {
    const { adapter } = makeAdapter({
      runGhResult: { exitCode: 1, stdout: '', stderr: 'HTTP 403: must have write access' },
      reader: foundSnapshot(),
      config: { mergeGhConfigDir: MERGE_DIR },
    });
    const result = await adapter.performMergeForgeAction(mergeRequest({ kind: 'update-branch' }));
    expect(result.outcome).toBe('refused');
  });

  it('continues update-branch re-reading after an unavailable read and reports the new head', async () => {
    const { adapter, calls, requests } = makeAdapter({
      reader: [
        foundSnapshot(),
        { outcome: 'unavailable', reason: 'temporary hiccup' },
        foundSnapshot({ headSha: OTHER_SHA }),
      ],
      config: { mergeGhConfigDir: MERGE_DIR },
    });
    const result = await adapter.performMergeForgeAction(mergeRequest({ kind: 'update-branch' }));
    expect(result).toEqual({ outcome: 'executed', headSha: OTHER_SHA });
    expect(calls).toHaveLength(1);
    expect(requests).toHaveLength(3);
  });

  it('refuses past the deadline without starting any call', async () => {
    const { adapter, calls, requests } = makeAdapter({
      nowIso: '2026-11-01T12:00:11.000Z',
      config: { mergeGhConfigDir: MERGE_DIR },
    });
    const result = await adapter.performMergeForgeAction(mergeRequest());
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'budget-exhausted',
      refusalKind: 'other',
    });
    expect(calls).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it('refuses when fewer than 2 seconds remain before the deadline', async () => {
    const { adapter, calls, requests } = makeAdapter({
      nowIso: '2026-11-01T12:00:08.500Z',
      config: { mergeGhConfigDir: MERGE_DIR },
    });
    const result = await adapter.performMergeForgeAction(mergeRequest());
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'budget-exhausted',
      refusalKind: 'other',
    });
    expect(calls).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it('bounds every call to the remaining budget', async () => {
    const { adapter, calls, requests } = makeAdapter({
      nowIso: '2026-11-01T12:00:05.000Z',
      config: { mergeGhConfigDir: MERGE_DIR },
    });
    const result = await adapter.performMergeForgeAction(mergeRequest());
    expect(result).toEqual({ outcome: 'executed', headSha: HEAD_SHA });
    expect(calls[0].timeoutMs).toBeLessThanOrEqual(5000);
    expect(requests[0].timeoutMs).toBeLessThanOrEqual(5000);
  });

  it('reports ambiguous when a write times out, never refused', async () => {
    const { adapter } = makeAdapter({
      runGhResult: { throw: true },
      config: { mergeGhConfigDir: MERGE_DIR },
    });
    const result = await adapter.performMergeForgeAction(mergeRequest());
    expect(result).toEqual({ outcome: 'ambiguous', reason: 'gh pr merge could not complete' });
  });
});

// --- create-branch and the branch-head read (lane CO7) -----------------------

const CHAIN_BRANCH = 'chain/example';
const REF_URL = `repos/${OWNER}/${REPO}/git/ref/heads/${CHAIN_BRANCH}`;

type GhAnswer = { exitCode: number; stdout: string; stderr: string } | { throw: true };

function refBody(sha: string, branch = CHAIN_BRANCH): string {
  return JSON.stringify({ ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
}

function makeChainAdapter(answers: GhAnswer[], config: { mergeGhConfigDir?: string } = { mergeGhConfigDir: MERGE_DIR }) {
  const calls: RunGhCall[] = [];
  const pending = [...answers];
  const adapter = new ForgeActionAdapter(
    {
      runGh: async (args, ghConfigDir, timeoutMs) => {
        calls.push({ args: [...args], ghConfigDir, timeoutMs });
        const next = pending.shift() ?? { exitCode: 1, stdout: '', stderr: 'no scripted answer' };
        if ('throw' in next) {
          throw new Error('gh subprocess timed out');
        }
        return next;
      },
      nowIso: makeClock().nowIso,
    },
    undefined,
    config,
  );
  return { adapter, calls };
}

function createBranchRequest(overrides: Record<string, unknown> = {}): MergeForgeActionRequest {
  return {
    kind: 'create-branch',
    actionId: 'chain-start-1',
    repository: { owner: OWNER, repo: REPO },
    branchName: CHAIN_BRANCH,
    sourceBranch: 'main',
    expectedHeadSha: HEAD_SHA,
    deadlineIso: DEADLINE_ISO,
    ...overrides,
  } as MergeForgeActionRequest;
}

const OK = { exitCode: 0, stdout: '{}', stderr: '' };
const EXISTS = { exitCode: 1, stdout: '', stderr: 'gh: Reference already exists (HTTP 422)' };
const MISSING = { exitCode: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };

describe('ForgeActionAdapter create-branch (lane CO7)', () => {
  it('sends the exact argv with the merge identity and a bounded timeout', async () => {
    const { adapter, calls } = makeChainAdapter([OK]);
    const result = await adapter.performMergeForgeAction(createBranchRequest());
    expect(result).toEqual({ outcome: 'executed', headSha: HEAD_SHA });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual([
      'api', '--method', 'POST', `repos/${OWNER}/${REPO}/git/refs`,
      '-f', `ref=refs/heads/${CHAIN_BRANCH}`, '-f', `sha=${HEAD_SHA}`,
    ]);
    expect(calls[0]!.ghConfigDir).toBe(MERGE_DIR);
    expect(calls[0]!.timeoutMs).toBeLessThanOrEqual(30_000);
  });

  it('reports an existing ref at the expected commit as executed', async () => {
    const { adapter, calls } = makeChainAdapter([EXISTS, { exitCode: 0, stdout: refBody(HEAD_SHA), stderr: '' }]);
    expect(await adapter.performMergeForgeAction(createBranchRequest())).toEqual({
      outcome: 'executed',
      headSha: HEAD_SHA,
    });
    expect(calls[1]!.args).toEqual(['api', REF_URL]);
  });

  it('refuses an existing ref at another commit', async () => {
    const { adapter } = makeChainAdapter([EXISTS, { exitCode: 0, stdout: refBody(OTHER_SHA), stderr: '' }]);
    expect(await adapter.performMergeForgeAction(createBranchRequest())).toEqual({
      outcome: 'refused',
      reason: 'branch-exists-at-other-commit',
      refusalKind: 'other',
    });
  });

  it('classifies the create failure when the read-back finds no branch', async () => {
    const forbidden = { exitCode: 1, stdout: '', stderr: 'gh: Resource not accessible by integration (HTTP 403)' };
    const { adapter } = makeChainAdapter([forbidden, MISSING, OK]);
    const result = await adapter.performMergeForgeAction(createBranchRequest());
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.refusalKind).toBe('permission');
    }
  });

  it('is ambiguous when the create fails and the read-back cannot answer', async () => {
    const { adapter } = makeChainAdapter([EXISTS, { exitCode: 1, stdout: '', stderr: 'gh: Bad gateway (HTTP 502)' }]);
    expect(await adapter.performMergeForgeAction(createBranchRequest())).toEqual({
      outcome: 'ambiguous',
      reason: 'create-branch failed and the branch could not be read back',
    });
  });

  it('is ambiguous when the delegate throws, with no input echoed', async () => {
    const { adapter } = makeChainAdapter([{ throw: true }]);
    const result = await adapter.performMergeForgeAction(createBranchRequest());
    expect(result).toEqual({ outcome: 'ambiguous', reason: 'gh api create-branch could not complete' });
  });

  it('refuses invalid requests before any gh call without echoing the value', async () => {
    const bad: Record<string, unknown>[] = [
      { branchName: 'main' },
      { branchName: 'feat/x' },
      { branchName: 'chain/Bad' },
      { branchName: 'chain/a/b' },
      { sourceBranch: 'develop' },
      { expectedHeadSha: 'abc' },
      { expectedHeadSha: OTHER_SHA.toUpperCase() },
      { repository: { owner: '..', repo: REPO } },
      { repository: { owner: OWNER, repo: 'a b' } },
      { repository: null },
      { deadlineIso: 'tomorrow' },
      { actionId: '' },
      { pullRequestNumber: 5 },
      { status: { context: 'premerge', state: 'success', description: 'x' } },
    ];
    for (const overrides of bad) {
      const { adapter, calls } = makeChainAdapter([OK]);
      const result = await adapter.performMergeForgeAction(createBranchRequest(overrides));
      expect(result.outcome).toBe('refused');
      expect(calls).toHaveLength(0);
      expect(JSON.stringify(result)).not.toContain('develop');
      expect(JSON.stringify(result)).not.toContain('chain/Bad');
    }
  });

  it('refuses a throwing getter, a kind getter and a sparse repository without throwing', async () => {
    const thrower = (key: string) => {
      const request = { ...createBranchRequest() } as unknown as Record<string, unknown>;
      Object.defineProperty(request, key, { get() { throw new Error('boom'); }, enumerable: true });
      return request as unknown as MergeForgeActionRequest;
    };
    for (const key of ['deadlineIso', 'branchName', 'expectedHeadSha', 'repository', 'actionId']) {
      const { adapter, calls } = makeChainAdapter([OK]);
      const result = await adapter.performMergeForgeAction(thrower(key));
      expect(result.outcome).toBe('refused');
      expect(calls).toHaveLength(0);
    }
    const trapped = new Proxy(createBranchRequest(), {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'pullRequestNumber') throw new Error('boom');
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const proxied = makeChainAdapter([OK]);
    await expect(proxied.adapter.performMergeForgeAction(trapped)).resolves.toMatchObject({ outcome: 'refused' });
    expect(proxied.calls).toHaveLength(0);
    const kindGetter = Object.defineProperty({}, 'kind', { get() { throw new Error('boom'); }, enumerable: true });
    const { adapter } = makeChainAdapter([OK]);
    await expect(adapter.performMergeForgeAction(kindGetter as unknown as MergeForgeActionRequest)).resolves.toMatchObject({
      outcome: 'refused',
    });
  });

  it('refuses a null request and a missing merge identity without a gh call', async () => {
    const first = makeChainAdapter([OK]);
    const nullResult = await first.adapter.performMergeForgeAction(null as unknown as MergeForgeActionRequest);
    expect(nullResult.outcome).toBe('refused');
    const second = makeChainAdapter([OK], {});
    expect(await second.adapter.performMergeForgeAction(createBranchRequest())).toEqual({
      outcome: 'refused',
      reason: 'no merger identity is configured',
      refusalKind: 'other',
    });
    expect(second.calls).toHaveLength(0);
  });

  it('refuses to start with under two seconds of budget left', async () => {
    const { adapter, calls } = makeChainAdapter([OK]);
    const result = await adapter.performMergeForgeAction(
      createBranchRequest({ deadlineIso: '2026-11-01T12:00:01.000Z' }),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'budget-exhausted', refusalKind: 'other' });
    expect(calls).toHaveLength(0);
  });
});

describe('ForgeActionAdapter readMergeBranchHead (lane CO7)', () => {
  const read = { repository: { owner: OWNER, repo: REPO }, branchName: CHAIN_BRANCH, deadlineIso: DEADLINE_ISO };

  it('returns found with the 40-hex head', async () => {
    const { adapter, calls } = makeChainAdapter([{ exitCode: 0, stdout: refBody(HEAD_SHA), stderr: '' }]);
    expect(await adapter.readMergeBranchHead(read)).toEqual({ outcome: 'found', headSha: HEAD_SHA });
    expect(calls[0]!.args).toEqual(['api', REF_URL]);
    expect(calls[0]!.ghConfigDir).toBe(MERGE_DIR);
  });

  it('returns not-found on a 404 only when the repository itself reads', async () => {
    const { adapter, calls } = makeChainAdapter([MISSING, OK]);
    expect(await adapter.readMergeBranchHead(read)).toEqual({ outcome: 'not-found' });
    expect(calls[1]!.args).toEqual(['api', `repos/${OWNER}/${REPO}`]);
  });

  it('keeps a 404 unavailable when the repository cannot be read or the probe throws', async () => {
    for (const probe of [MISSING, { throw: true } as GhAnswer]) {
      const { adapter } = makeChainAdapter([MISSING, probe]);
      expect((await adapter.readMergeBranchHead(read)).outcome).toBe('unavailable');
    }
  });

  it('returns unavailable, never not-found, for other failures and bad bodies', async () => {
    const bodies: GhAnswer[] = [
      { exitCode: 1, stdout: '', stderr: 'gh: Bad gateway (HTTP 502)' },
      { throw: true },
      { exitCode: 0, stdout: 'not json', stderr: '' },
      { exitCode: 0, stdout: '[]', stderr: '' },
      { exitCode: 0, stdout: JSON.stringify([{ ref: `refs/heads/${CHAIN_BRANCH}`, object: { sha: HEAD_SHA } }]), stderr: '' },
      { exitCode: 0, stdout: refBody('abc'), stderr: '' },
      { exitCode: 0, stdout: refBody(HEAD_SHA, 'chain/other'), stderr: '' },
      { exitCode: 0, stdout: `${' '.repeat(70_000)}{}`, stderr: '' },
    ];
    for (const answer of bodies) {
      const { adapter } = makeChainAdapter([answer]);
      expect((await adapter.readMergeBranchHead(read)).outcome).toBe('unavailable');
    }
  });

  it('is unavailable, not a rejection, for a throwing getter', async () => {
    const { adapter, calls } = makeChainAdapter([OK]);
    const request = {} as Record<string, unknown>;
    for (const key of ['deadlineIso', 'repository', 'branchName']) {
      Object.defineProperty(request, key, { get() { throw new Error('boom'); }, enumerable: true });
    }
    const result = await adapter.readMergeBranchHead(request as unknown as typeof read);
    expect(result.outcome).toBe('unavailable');
    expect(calls).toHaveLength(0);
  });

  it('is unavailable for invalid input, no identity and an exhausted budget, without a gh call', async () => {
    const cases = [
      { ...read, branchName: '' },
      { ...read, repository: { owner: '', repo: REPO } },
      { ...read, deadlineIso: 'soon' },
      { ...read, deadlineIso: '2026-11-01T12:00:01.000Z' },
      null,
    ];
    for (const request of cases) {
      const { adapter, calls } = makeChainAdapter([OK]);
      const result = await adapter.readMergeBranchHead(request as unknown as typeof read);
      expect(result.outcome).toBe('unavailable');
      expect(calls).toHaveLength(0);
    }
    const noIdentity = makeChainAdapter([OK], {});
    expect((await noIdentity.adapter.readMergeBranchHead(read)).outcome).toBe('unavailable');
    expect(noIdentity.calls).toHaveLength(0);
  });
});
