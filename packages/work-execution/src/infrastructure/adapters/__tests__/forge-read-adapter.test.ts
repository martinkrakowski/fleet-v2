// ForgeReadAdapter: one read-only gh pr view per call, by number or head
// branch, with an optional per-call repository; unreadable or mismatched
// answers are unavailable, never a guess and never absence.
/**
 * Covers the four captured gh pr view outputs (merged, open,
 * closed-unmerged, not-found for branch and number) plus the
 * unreadable/mismatch/unavailable paths and isConfigured. The A13 case
 * documents that a merge that landed is read as merged even though the
 * merge refusal's stderr alone would be classified permission.
 */

import { describe, expect, it } from 'vitest';

import type { GhInvocationResult } from '../ForgeActionAdapter.adapter.js';
import { classifyGhRefusal } from '../ForgeActionAdapter.adapter.js';
import {
  ForgeReadAdapter,
  PULL_REQUEST_VIEW_FIELDS,
  parsePullRequestView,
  type ForgeReadAdapterOptions,
} from '../ForgeReadAdapter.adapter.js';

const MERGED_FIXTURE = JSON.stringify({
  baseRefName: 'main',
  closedAt: '2026-10-25T20:12:08Z',
  headRefName: 'feat/example-lane',
  headRefOid: '3dd5d90509461e3d2154b52da28671aeffa84130',
  mergeCommit: { oid: '3fe9fac07688024ae64dc5a3da66010e4418d628' },
  mergedAt: '2026-10-25T20:12:08Z',
  mergeStateStatus: 'CLEAN',
  number: 202,
  state: 'MERGED',
});

const OPEN_FIXTURE = JSON.stringify({
  baseRefName: 'main',
  closedAt: null,
  headRefName: 'feat/example-open',
  headRefOid: '8e136fe0e0cc916b9d3485eaafe653e3143d9d63',
  mergeCommit: null,
  mergedAt: null,
  mergeStateStatus: 'BEHIND',
  number: 259,
  state: 'OPEN',
});

const CLOSED_UNMERGED_FIXTURE = JSON.stringify({
  baseRefName: 'main',
  closedAt: '2026-10-26T09:00:00Z',
  headRefName: 'feat/example-open',
  headRefOid: '8e136fe0e0cc916b9d3485eaafe653e3143d9d63',
  mergeCommit: null,
  mergedAt: null,
  mergeStateStatus: 'BLOCKED',
  number: 259,
  state: 'CLOSED',
});

const BRANCH_NOT_FOUND_STDERR = 'no pull requests found for branch "feat/example-missing"';
const NUMBER_NOT_FOUND_STDERR =
  'GraphQL: Could not resolve to a PullRequest with the number of 999999. (repository.pullRequest)';
const HTTP_401_STDERR = 'HTTP 401: Bad credentials (https://api.github.com/graphql)';

function makeRunGh(result: { exitCode: number; stdout: string; stderr: string }) {
  const calls: string[][] = [];
  const runGh = async (args: readonly string[]) => {
    calls.push([...args]);
    return result;
  };
  return { calls, runGh };
}

function makeAdapter(overrides: Partial<ForgeReadAdapterOptions> = {}) {
  return new ForgeReadAdapter({
    owner: 'example-owner',
    repo: 'example-repo',
    ...overrides,
  });
}

describe('ForgeReadAdapter.readPullRequest', () => {
  it('reads a merged PR by number and calls exactly gh pr view with the view fields', async () => {
    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: MERGED_FIXTURE, stderr: '' });
    const adapter = makeAdapter({ runGh });

    const result = await adapter.readPullRequest({ ref: { kind: 'number', number: 202 } });

    expect(result).toEqual({
      outcome: 'found',
      pullRequest: {
        number: 202,
        state: 'merged',
        mergeState: 'clean',
        headSha: '3dd5d90509461e3d2154b52da28671aeffa84130',
        headRef: 'feat/example-lane',
        baseRef: 'main',
        mergedAtIso: '2026-10-25T20:12:08.000Z',
        closedAtIso: '2026-10-25T20:12:08.000Z',
        mergeCommitSha: '3fe9fac07688024ae64dc5a3da66010e4418d628',
      },
    });
    expect(calls).toEqual([
      ['pr', 'view', '202', '-R', 'example-owner/example-repo', '--json', PULL_REQUEST_VIEW_FIELDS],
    ]);
  });

  it('reads an open PR by branch and passes the branch name', async () => {
    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: OPEN_FIXTURE, stderr: '' });
    const adapter = makeAdapter({ runGh });

    const result = await adapter.readPullRequest({
      ref: { kind: 'branch', branchName: 'feat/example-open' },
    });

    expect(result).toEqual({
      outcome: 'found',
      pullRequest: {
        number: 259,
        state: 'open',
        mergeState: 'behind',
        headSha: '8e136fe0e0cc916b9d3485eaafe653e3143d9d63',
        headRef: 'feat/example-open',
        baseRef: 'main',
        mergedAtIso: null,
        closedAtIso: null,
        mergeCommitSha: null,
      },
    });
    expect(calls[0]).toEqual([
      'pr',
      'view',
      'feat/example-open',
      '-R',
      'example-owner/example-repo',
      '--json',
      PULL_REQUEST_VIEW_FIELDS,
    ]);
  });

  it('reads a closed-unmerged PR with closedAt set and mergedAt null', async () => {
    const { runGh } = makeRunGh({ exitCode: 0, stdout: CLOSED_UNMERGED_FIXTURE, stderr: '' });
    const adapter = makeAdapter({ runGh });

    const result = await adapter.readPullRequest({
      ref: { kind: 'branch', branchName: 'feat/example-open' },
    });

    expect(result).toEqual({
      outcome: 'found',
      pullRequest: expect.objectContaining({
        state: 'closed',
        closedAtIso: '2026-10-26T09:00:00.000Z',
        mergedAtIso: null,
        mergeCommitSha: null,
        mergeState: 'blocked',
      }),
    });
  });

  it.each([
    ['CLEAN', 'clean'],
    ['BEHIND', 'behind'],
    ['BLOCKED', 'blocked'],
    ['DIRTY', 'blocked'],
    ['UNSTABLE', 'blocked'],
    ['HAS_HOOKS', 'unknown'],
    [null, 'unknown'],
    [undefined, 'unknown'],
    [42, 'unknown'],
  ])('maps gh mergeStateStatus %s to mergeState %s', (status, expected) => {
    const payload = JSON.stringify({
      ...JSON.parse(OPEN_FIXTURE),
      mergeStateStatus: status,
    });
    const result = parsePullRequestView(payload, { kind: 'branch', branchName: 'feat/example-open' });
    expect(result).toEqual({
      outcome: 'found',
      pullRequest: expect.objectContaining({ mergeState: expected }),
    });
  });

  it('is not-found when gh reports no PR for the branch or the number', async () => {
    const branch = makeRunGh({ exitCode: 1, stdout: '', stderr: BRANCH_NOT_FOUND_STDERR });
    const branchResult = await makeAdapter({ runGh: branch.runGh }).readPullRequest({
      ref: { kind: 'branch', branchName: 'feat/example-missing' },
    });
    expect(branchResult).toEqual({ outcome: 'not-found' });

    const number = makeRunGh({ exitCode: 1, stdout: '', stderr: NUMBER_NOT_FOUND_STDERR });
    const numberResult = await makeAdapter({ runGh: number.runGh }).readPullRequest({
      ref: { kind: 'number', number: 999999 },
    });
    expect(numberResult).toEqual({ outcome: 'not-found' });
  });

  it('is unavailable without a runner or with a missing or invalid repository, never running gh', async () => {
    const noRunner = new ForgeReadAdapter({ owner: 'example-owner', repo: 'example-repo' });
    expect(await noRunner.readPullRequest({ ref: { kind: 'number', number: 202 } })).toEqual({
      outcome: 'unavailable',
      reason: 'forge read is not configured',
    });

    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: MERGED_FIXTURE, stderr: '' });
    const missingOwner = new ForgeReadAdapter({ repo: 'example-repo', runGh });
    expect(await missingOwner.readPullRequest({ ref: { kind: 'number', number: 202 } })).toEqual({
      outcome: 'unavailable',
      reason: 'forge repository is not configured or not valid',
    });

    const badRepository = makeAdapter({ runGh });
    expect(
      await badRepository.readPullRequest({
        ref: { kind: 'number', number: 202 },
        repository: { owner: 'bad owner', repo: 'x' },
      }),
    ).toEqual({
      outcome: 'unavailable',
      reason: 'forge repository is not configured or not valid',
    });

    expect(calls).toHaveLength(0);
  });

  it('is unavailable for a non-safe-integer pull request number, never running gh', async () => {
    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: MERGED_FIXTURE, stderr: '' });
    const adapter = makeAdapter({ runGh });

    const zero = await adapter.readPullRequest({ ref: { kind: 'number', number: 0 } });
    const negative = await adapter.readPullRequest({ ref: { kind: 'number', number: -1 } });
    const fraction = await adapter.readPullRequest({ ref: { kind: 'number', number: 1.5 } });

    expect(zero).toEqual({ outcome: 'unavailable', reason: 'pull request number is not valid' });
    expect(negative).toEqual({ outcome: 'unavailable', reason: 'pull request number is not valid' });
    expect(fraction).toEqual({ outcome: 'unavailable', reason: 'pull request number is not valid' });
    expect(calls).toHaveLength(0);
  });

  it('is unavailable for an unsafe or numeric branch name, never running gh', async () => {
    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: MERGED_FIXTURE, stderr: '' });
    const adapter = makeAdapter({ runGh });

    const space = await adapter.readPullRequest({ ref: { kind: 'branch', branchName: 'bad branch' } });
    const dotdot = await adapter.readPullRequest({ ref: { kind: 'branch', branchName: '..' } });
    const numeric = await adapter.readPullRequest({ ref: { kind: 'branch', branchName: '12345' } });

    expect(space).toEqual({ outcome: 'unavailable', reason: 'branch name is not valid' });
    expect(dotdot).toEqual({ outcome: 'unavailable', reason: 'branch name is not valid' });
    expect(numeric).toEqual({ outcome: 'unavailable', reason: 'branch name is not valid' });
    expect(calls).toHaveLength(0);
  });

  it('is unavailable with a fixed reason when gh rejects, never echoing the error', async () => {
    const rejecting = async () => {
      throw new Error('gh not found in fixed locations');
    };
    const adapter = makeAdapter({ runGh: rejecting });

    const result = await adapter.readPullRequest({ ref: { kind: 'number', number: 202 } });

    expect(result).toEqual({
      outcome: 'unavailable',
      reason: 'gh pr view could not complete',
    });
    expect(result.outcome === 'unavailable' && result.reason).not.toContain('https');
  });

  it('is unavailable with a fixed reason for a non-not-found non-zero exit, never echoing stderr', async () => {
    const failed = makeRunGh({ exitCode: 1, stdout: '', stderr: HTTP_401_STDERR });

    const result = await makeAdapter({ runGh: failed.runGh }).readPullRequest({
      ref: { kind: 'number', number: 202 },
    });

    expect(result).toEqual({
      outcome: 'unavailable',
      reason: 'gh pr view failed (exit 1)',
    });
    expect(result.outcome === 'unavailable' && result.reason).not.toContain('https');
  });

  it.each([
    ['not json', 'not json', null],
    ['empty array', '[]', null],
    [
      'draft state',
      JSON.stringify({ ...JSON.parse(OPEN_FIXTURE), state: 'DRAFT' }),
      null,
    ],
    ['bad head oid', JSON.stringify({ ...JSON.parse(OPEN_FIXTURE), headRefOid: 'XYZZY' }), 'XYZZY'],
    ['string number', JSON.stringify({ ...JSON.parse(OPEN_FIXTURE), number: '202' }), null],
    [
      'short merge commit',
      JSON.stringify({ ...JSON.parse(OPEN_FIXTURE), mergeCommit: { oid: 'short' } }),
      'short',
    ],
    ['merged without mergedAt', JSON.stringify({ ...JSON.parse(MERGED_FIXTURE), mergedAt: null }), null],
    [
      'open with mergedAt',
      JSON.stringify({ ...JSON.parse(OPEN_FIXTURE), mergedAt: '2026-10-25T20:12:08Z' }),
      null,
    ],
  ])(
    'is unavailable with the fixed reason for %s, never echoing the bad value',
    async (_name, payload, badValue) => {
      const { runGh } = makeRunGh({ exitCode: 0, stdout: payload, stderr: '' });
      const adapter = makeAdapter({ runGh });

      const result = await adapter.readPullRequest({ ref: { kind: 'number', number: 202 } });

      expect(result).toEqual({
        outcome: 'unavailable',
        reason: 'gh pr view returned an unreadable pull request',
      });
      if (badValue !== null && result.outcome === 'unavailable') {
        expect(result.reason).not.toContain(badValue);
      }
    },
  );

  it('is unavailable when the answer does not match the requested number', async () => {
    const wrongNumber = makeRunGh({ exitCode: 0, stdout: MERGED_FIXTURE, stderr: '' });

    const result = await makeAdapter({ runGh: wrongNumber.runGh }).readPullRequest({
      ref: { kind: 'number', number: 203 },
    });

    expect(result).toEqual({
      outcome: 'unavailable',
      reason: 'gh pr view answered for a different pull request',
    });
  });

  it('is unavailable when the answer does not match the requested branch', async () => {
    const wrongBranch = makeRunGh({ exitCode: 0, stdout: MERGED_FIXTURE, stderr: '' });

    const result = await makeAdapter({ runGh: wrongBranch.runGh }).readPullRequest({
      ref: { kind: 'branch', branchName: 'feat/other' },
    });

    expect(result).toEqual({
      outcome: 'unavailable',
      reason: 'gh pr view answered for a different pull request',
    });
  });

  it('is unavailable with a fixed reason when the read outlives the deadline', async () => {
    const never = () => new Promise<GhInvocationResult>(() => undefined);
    const adapter = makeAdapter({ runGh: never, timeoutMs: 20 });

    const result = await adapter.readPullRequest({ ref: { kind: 'number', number: 202 } });

    expect(result).toEqual({
      outcome: 'unavailable',
      reason: 'gh pr view timed out',
    });
  });

  it('a read that rejects after the deadline won raises no unhandled rejection', async () => {
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

      const result = await adapter.readPullRequest({ ref: { kind: 'number', number: 202 } });
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(result).toEqual({ outcome: 'unavailable', reason: 'gh pr view timed out' });
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('is unavailable without parsing when the stdout exceeds one mebibyte', async () => {
    const oversized = 'x'.repeat(1_048_577);
    const { runGh } = makeRunGh({ exitCode: 0, stdout: oversized, stderr: '' });
    const adapter = makeAdapter({ runGh });

    const result = await adapter.readPullRequest({ ref: { kind: 'number', number: 202 } });

    expect(result).toEqual({
      outcome: 'unavailable',
      reason: 'gh pr view output too large',
    });
  });

  it('honors a per-call repository override on the -R flag', async () => {
    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: MERGED_FIXTURE, stderr: '' });
    const adapter = makeAdapter({ runGh });

    const result = await adapter.readPullRequest({
      ref: { kind: 'number', number: 202 },
      repository: { owner: 'example-org', repo: 'other-repo' },
    });

    expect(result.outcome).toBe('found');
    expect(calls[0]).toEqual([
      'pr',
      'view',
      '202',
      '-R',
      'example-org/other-repo',
      '--json',
      PULL_REQUEST_VIEW_FIELDS,
    ]);
  });
});

describe('ForgeReadAdapter.isConfigured', () => {
  it('is false without a runner or owner, true with both', () => {
    expect(new ForgeReadAdapter().isConfigured()).toBe(false);
    expect(
      new ForgeReadAdapter({ owner: 'example-owner', repo: 'example-repo' }).isConfigured(),
    ).toBe(false);

    const { runGh } = makeRunGh({ exitCode: 0, stdout: MERGED_FIXTURE, stderr: '' });
    expect(makeAdapter({ runGh }).isConfigured()).toBe(true);
  });
});

describe('A13: a merge that landed is read as merged despite the refusal stderr', () => {
  it('reports executed (found/merged) where the classifier alone would say permission', async () => {
    const mergeStderr = 'HTTP 403: Resource not accessible by integration';
    expect(classifyGhRefusal(mergeStderr, '')).toBe('permission');

    const { runGh } = makeRunGh({ exitCode: 0, stdout: MERGED_FIXTURE, stderr: '' });
    const adapter = makeAdapter({ runGh });
    const result = await adapter.readPullRequest({ ref: { kind: 'number', number: 202 } });

    expect(result).toEqual({
      outcome: 'found',
      pullRequest: expect.objectContaining({
        state: 'merged',
        mergedAtIso: '2026-10-25T20:12:08.000Z',
        mergeCommitSha: '3fe9fac07688024ae64dc5a3da66010e4418d628',
      }),
    });
  });
});
