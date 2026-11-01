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
  overrides: { readonly state?: PullRequestSnapshot['state']; readonly headSha?: string } = {},
): ReadPullRequestResult {
  return {
    outcome: 'found',
    pullRequest: {
      number: PR_NUMBER,
      state: overrides.state ?? 'open',
      mergeState: 'clean',
      headSha: overrides.headSha ?? HEAD_SHA,
      headRef: BRANCH,
      baseRef: 'main',
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
  const adapter = new ForgeActionAdapter(
    {
      runGh,
      pullRequestRead: { readPullRequest },
      nowIso: makeClock(options.nowIso).nowIso,
    },
    undefined,
    options.config,
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
      BRANCH,
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
    expect(result.outcome).toBe('refused');
    expect(calls).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it('refuses when fewer than 2 seconds remain before the deadline', async () => {
    const { adapter, calls, requests } = makeAdapter({
      nowIso: '2026-11-01T12:00:08.500Z',
      config: { mergeGhConfigDir: MERGE_DIR },
    });
    const result = await adapter.performMergeForgeAction(mergeRequest());
    expect(result.outcome).toBe('refused');
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
