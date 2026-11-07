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
  isCrossRepository: false,
  headRepositoryOwner: { login: 'example-owner' },
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
  isCrossRepository: false,
  headRepositoryOwner: { login: 'example-owner' },
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
  isCrossRepository: false,
  headRepositoryOwner: { login: 'example-owner' },
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
        isCrossRepository: false,
        headRepositoryOwner: 'example-owner',
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
        isCrossRepository: false,
        headRepositoryOwner: 'example-owner',
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

  it('a branch read parses the snapshot baseRef from a recorded payload (R4a)', async () => {
    const payload = JSON.stringify({
      baseRefName: 'chain/x',
      closedAt: null,
      headRefName: 'feat/example-chain',
      headRefOid: '8e136fe0e0cc916b9d3485eaafe653e3143d9d63',
      mergeCommit: null,
      mergedAt: null,
      mergeStateStatus: 'CLEAN',
      number: 311,
      isCrossRepository: false,
      headRepositoryOwner: { login: 'example-owner' },
      state: 'OPEN',
    });
    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: payload, stderr: '' });
    const result = await makeAdapter({ runGh }).readPullRequest({
      ref: { kind: 'branch', branchName: 'feat/example-chain' },
    });

    expect(result).toEqual({
      outcome: 'found',
      pullRequest: expect.objectContaining({ baseRef: 'chain/x', number: 311, state: 'open' }),
    });
    expect(calls).toHaveLength(1);
  });

  it('parses a fork PR with isCrossRepository true and a head owner login (WB5b3)', async () => {
    const payload = JSON.stringify({
      ...JSON.parse(OPEN_FIXTURE),
      isCrossRepository: true,
      headRepositoryOwner: { login: 'fork-owner' },
    });
    const { runGh } = makeRunGh({ exitCode: 0, stdout: payload, stderr: '' });
    const result = await makeAdapter({ runGh }).readPullRequest({
      ref: { kind: 'number', number: 259 },
    });

    expect(result).toEqual({
      outcome: 'found',
      pullRequest: expect.objectContaining({
        isCrossRepository: true,
        headRepositoryOwner: 'fork-owner',
      }),
    });
  });

  it('a branch read with two open PRs reads unavailable from a recorded failure body (R4a)', async () => {
    const { runGh } = makeRunGh({
      exitCode: 1,
      stdout: '',
      stderr: 'multiple pull requests match for branch "feat/example-chain"',
    });
    const result = await makeAdapter({ runGh }).readPullRequest({
      ref: { kind: 'branch', branchName: 'feat/example-chain' },
    });

    expect(result.outcome).toBe('unavailable');
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
      'missing isCrossRepository',
      JSON.stringify((() => {
        const rest = JSON.parse(OPEN_FIXTURE) as Record<string, unknown>;
        delete rest.isCrossRepository;
        return rest;
      })()),
      null,
    ],
    [
      'missing headRepositoryOwner',
      JSON.stringify((() => {
        const rest = JSON.parse(OPEN_FIXTURE) as Record<string, unknown>;
        delete rest.headRepositoryOwner;
        return rest;
      })()),
      null,
    ],
    [
      'headRepositoryOwner without a login',
      JSON.stringify({ ...JSON.parse(OPEN_FIXTURE), headRepositoryOwner: { name: 'No Login' } }),
      null,
    ],
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

  it('passes effectiveTimeoutMs to runGh when timeoutMs is provided on the request', async () => {
    const timeouts: Array<number | undefined> = [];
    const runGh = async (_args: readonly string[], timeoutMs?: number) => {
      timeouts.push(timeoutMs);
      return { exitCode: 0, stdout: OPEN_FIXTURE, stderr: '' };
    };
    const adapter = makeAdapter({ runGh, timeoutMs: 30000 });
    await adapter.readPullRequest({ ref: { kind: 'number', number: 259 }, timeoutMs: 5000 });
    expect(timeouts).toEqual([5000]);
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

describe('ForgeReadAdapter.containsCommit (CT-2b)', () => {
  const SHA_A = '3dd5d90509461e3d2154b52da28671aeffa84130';
  const SHA_B = '3fe9fac07688024ae64dc5a3da66010e4418d628';

  function compareFixture(status: string): string {
    return JSON.stringify({ status, ahead_by: status === 'ahead' ? 1 : 0, behind_by: 0 });
  }

  it('answers equal shas as contains: true with no gh call', async () => {
    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: '', stderr: '' });
    const adapter = makeAdapter({ runGh });
    expect(await adapter.containsCommit({ ancestorSha: SHA_A, descendantSha: SHA_A })).toEqual({
      outcome: 'answered',
      contains: true,
    });
    expect(calls).toEqual([]);
  });

  it('calls exactly gh api compare with the two shas and reads identical as contains', async () => {
    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: compareFixture('identical'), stderr: '' });
    const adapter = makeAdapter({ runGh });
    expect(await adapter.containsCommit({ ancestorSha: SHA_A, descendantSha: SHA_B })).toEqual({
      outcome: 'answered',
      contains: true,
    });
    expect(calls).toEqual([
      ['api', `repos/example-owner/example-repo/compare/${SHA_A}...${SHA_B}`, '--jq', '{status: .status}'],
    ]);
  });

  it('reads ahead as contains: true', async () => {
    const { runGh } = makeRunGh({ exitCode: 0, stdout: compareFixture('ahead'), stderr: '' });
    expect(await makeAdapter({ runGh }).containsCommit({ ancestorSha: SHA_A, descendantSha: SHA_B })).toEqual({
      outcome: 'answered',
      contains: true,
    });
  });

  it('reads behind as contains: false', async () => {
    const { runGh } = makeRunGh({ exitCode: 0, stdout: compareFixture('behind'), stderr: '' });
    expect(await makeAdapter({ runGh }).containsCommit({ ancestorSha: SHA_A, descendantSha: SHA_B })).toEqual({
      outcome: 'answered',
      contains: false,
    });
  });

  it('reads diverged as contains: false', async () => {
    const { runGh } = makeRunGh({ exitCode: 0, stdout: compareFixture('diverged'), stderr: '' });
    expect(await makeAdapter({ runGh }).containsCommit({ ancestorSha: SHA_A, descendantSha: SHA_B })).toEqual({
      outcome: 'answered',
      contains: false,
    });
  });

  it('reads an unknown status as unavailable', async () => {
    const { runGh } = makeRunGh({ exitCode: 0, stdout: compareFixture('complicated'), stderr: '' });
    expect(await makeAdapter({ runGh }).containsCommit({ ancestorSha: SHA_A, descendantSha: SHA_B })).toEqual({
      outcome: 'unavailable',
      reason: 'gh api compare returned an unreadable answer',
    });
  });

  it('reads malformed JSON and a missing status as unavailable', async () => {
    const malformed = makeRunGh({ exitCode: 0, stdout: 'not json', stderr: '' });
    expect(await makeAdapter({ runGh: malformed.runGh }).containsCommit({ ancestorSha: SHA_A, descendantSha: SHA_B })).toEqual({
      outcome: 'unavailable',
      reason: 'gh api compare returned an unreadable answer',
    });
    const missing = makeRunGh({ exitCode: 0, stdout: JSON.stringify({ ahead_by: 1 }), stderr: '' });
    expect(await makeAdapter({ runGh: missing.runGh }).containsCommit({ ancestorSha: SHA_A, descendantSha: SHA_B })).toEqual({
      outcome: 'unavailable',
      reason: 'gh api compare returned an unreadable answer',
    });
  });

  it('reads a non-zero exit as unavailable, never not-found', async () => {
    const { runGh } = makeRunGh({ exitCode: 1, stdout: '', stderr: 'HTTP 404: Not Found' });
    expect(await makeAdapter({ runGh }).containsCommit({ ancestorSha: SHA_A, descendantSha: SHA_B })).toEqual({
      outcome: 'unavailable',
      reason: 'gh api compare failed (exit 1)',
    });
  });

  it('reads a timed-out compare as unavailable', async () => {
    const never = async () => new Promise<GhInvocationResult>(() => undefined);
    const adapter = makeAdapter({ runGh: never, timeoutMs: 5 });
    expect(await adapter.containsCommit({ ancestorSha: SHA_A, descendantSha: SHA_B })).toEqual({
      outcome: 'unavailable',
      reason: 'gh api compare timed out',
    });
  });

  it('reads an invalid sha or an invalid repository as unavailable without a gh call', async () => {
    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: compareFixture('identical'), stderr: '' });
    const adapter = makeAdapter({ runGh });
    expect(await adapter.containsCommit({ ancestorSha: 'short', descendantSha: SHA_B })).toEqual({
      outcome: 'unavailable',
      reason: 'commit sha is not valid',
    });
    expect(await adapter.containsCommit({ ancestorSha: SHA_A, descendantSha: SHA_A.toUpperCase() })).toEqual({
      outcome: 'unavailable',
      reason: 'commit sha is not valid',
    });
    expect(await adapter.containsCommit({ ancestorSha: SHA_A, descendantSha: SHA_B, repository: { owner: 'bad owner', repo: 'example-repo' } })).toEqual({
      outcome: 'unavailable',
      reason: 'forge repository is not configured or not valid',
    });
    expect(calls).toEqual([]);
  });
});

describe('ForgeReadAdapter.readPullRequestChangedFiles', () => {
  const secretShaped = ['ghp', '_', 'x'.repeat(36)].join('');

  function filesStdout(paths: readonly string[], changedFiles?: number): string {
    return JSON.stringify({
      files: paths.map((path) => ({ path, additions: 1, deletions: 0 })),
      changedFiles: changedFiles ?? paths.length,
    });
  }

  function adapterFor(stdout: string, exitCode = 0) {
    const calls: (readonly string[])[] = [];
    const adapter = new ForgeReadAdapter({
      owner: 'acme',
      repo: 'fleet',
      runGh: async (args) => {
        calls.push(args);
        return { exitCode, stdout, stderr: '' };
      },
    });
    return { adapter, calls };
  }

  it('reads PR changed files exclusively via gh pr view without spawning git', async () => {
    const { adapter, calls } = adapterFor(filesStdout(['packages/b/src/y.ts', 'packages/a/src/x.ts', 'packages/a/src/x.ts']));
    const result = await adapter.readPullRequestChangedFiles({
      pullRequestNumber: 42,
      repository: { owner: 'acme', repo: 'fleet' },
    });
    expect(result).toEqual({ outcome: 'found', files: ['packages/a/src/x.ts', 'packages/b/src/y.ts'] });
    expect(calls).toEqual([['pr', 'view', '42', '-R', 'acme/fleet', '--json', 'files,changedFiles']]);
    expect(calls.every((args) => args[0] === 'pr')).toBe(true);
  });

  it('falls back to the configured repository', async () => {
    const { adapter, calls } = adapterFor(filesStdout(['a.ts']));
    expect(await adapter.readPullRequestChangedFiles({ pullRequestNumber: 7 })).toEqual({
      outcome: 'found',
      files: ['a.ts'],
    });
    expect(calls[0]).toEqual(['pr', 'view', '7', '-R', 'acme/fleet', '--json', 'files,changedFiles']);
  });

  it('enforces 100-file and 4-MiB stdout bounds on PR changed files and verifies changedFiles', async () => {
    const make = (count: number) => Array.from({ length: count }, (_, index) => `packages/p/file-${index}.ts`);
    const atBound = adapterFor(filesStdout(make(99)));
    const found = await atBound.adapter.readPullRequestChangedFiles({ pullRequestNumber: 1 });
    expect(found.outcome === 'found' && found.files.length).toBe(99);
    const at100 = adapterFor(filesStdout(make(100)));
    expect(await at100.adapter.readPullRequestChangedFiles({ pullRequestNumber: 1 })).toEqual({
      outcome: 'unknown',
      reason: 'too-many-files',
    });
    const overReported = adapterFor(filesStdout(make(50), 150));
    expect(await overReported.adapter.readPullRequestChangedFiles({ pullRequestNumber: 1 })).toEqual({
      outcome: 'unknown',
      reason: 'too-many-files',
    });
    const huge = adapterFor(`${' '.repeat(4_194_305)}${filesStdout(['a.ts'])}`);
    expect(await huge.adapter.readPullRequestChangedFiles({ pullRequestNumber: 1 })).toEqual({
      outcome: 'unknown',
      reason: 'files-too-large',
    });
  });

  it.each([
    ['traversal', '../secret'],
    ['absolute', '/etc/passwd'],
    ['trailing slash', 'packages/a/'],
    ['control character', 'packages/a\u0007b.ts'],
    ['leading whitespace', ' packages/a.ts'],
    ['double slash', 'packages//a.ts'],
    ['dot segment', 'packages/./a.ts'],
    ['secret-shaped', `packages/${secretShaped}.ts`],
    ['over-long', `packages/${'a'.repeat(520)}.ts`],
  ])('never drops an unscreened path (%s): the whole read is unreadable', async (_name, bad) => {
    const { adapter } = adapterFor(filesStdout(['packages/ok.ts', bad]));
    const result = await adapter.readPullRequestChangedFiles({ pullRequestNumber: 3 });
    expect(result).toEqual({ outcome: 'unknown', reason: 'unreadable-files' });
    expect(JSON.stringify(result)).not.toContain(secretShaped);
  });

  it('reads a non-zero exit, malformed JSON, missing changedFiles and a missing or sparse files array as unknown', async () => {
    expect(await adapterFor('', 1).adapter.readPullRequestChangedFiles({ pullRequestNumber: 3 })).toEqual({
      outcome: 'unknown',
      reason: 'files-failed',
    });
    for (const stdout of [
      '{ not json',
      '{}',
      '[]',
      '{"files":{}}',
      '{"files":[null]}',
      '{"files":[{"path":3}]}',
      '{"files":[{"path":"a.ts"}]}',
      '{"files":[{"path":"a.ts"}],"changedFiles":"1"}',
      '{"files":[{"path":"a.ts"}],"changedFiles":-1}',
    ]) {
      expect(await adapterFor(stdout).adapter.readPullRequestChangedFiles({ pullRequestNumber: 3 })).toEqual({
        outcome: 'unknown',
        reason: 'unreadable-files',
      });
    }
  });

  it('reads an empty files array with changedFiles: 0 as found with no files, never as unknown', async () => {
    expect(await adapterFor('{"files":[],"changedFiles":0}').adapter.readPullRequestChangedFiles({ pullRequestNumber: 3 })).toEqual({
      outcome: 'found',
      files: [],
    });
  });

  it('reads an inconsistent forge count as unknown: changedFiles smaller than the returned files', async () => {
    expect(
      await adapterFor('{"files":[{"path":"packages/other/file.ts"}],"changedFiles":0}').adapter.readPullRequestChangedFiles(
        { pullRequestNumber: 3 },
      ),
    ).toEqual({ outcome: 'unknown', reason: 'too-many-files' });
  });

  it('reads an inconsistent forge count as unknown: changedFiles larger than the returned files', async () => {
    expect(
      await adapterFor('{"files":[{"path":"a.ts"},{"path":"b.ts"}],"changedFiles":3}').adapter.readPullRequestChangedFiles(
        { pullRequestNumber: 3 },
      ),
    ).toEqual({ outcome: 'unknown', reason: 'too-many-files' });
  });

  it('returns files-timed-out without calling gh when timeoutMs is not positive', async () => {
    const { adapter, calls } = adapterFor(filesStdout(['a.ts']));
    expect(await adapter.readPullRequestChangedFiles({ pullRequestNumber: 3, timeoutMs: 0 })).toEqual({
      outcome: 'unknown',
      reason: 'files-timed-out',
    });
    expect(await adapter.readPullRequestChangedFiles({ pullRequestNumber: 3, timeoutMs: -5 })).toEqual({
      outcome: 'unknown',
      reason: 'files-timed-out',
    });
    expect(calls).toEqual([]);
  });

  it('returns files-timed-out when gh exceeds timeoutMs', async () => {
    const adapter = new ForgeReadAdapter({
      owner: 'acme',
      repo: 'fleet',
      runGh: () => new Promise<GhInvocationResult>(() => undefined),
    });
    expect(await adapter.readPullRequestChangedFiles({ pullRequestNumber: 3, timeoutMs: 20 })).toEqual({
      outcome: 'unknown',
      reason: 'files-timed-out',
    });
  });

  it('reads a thrown runner as files-failed and an unconfigured adapter as unknown', async () => {
    const throwing = new ForgeReadAdapter({
      owner: 'acme',
      repo: 'fleet',
      runGh: async () => {
        throw new Error('boom');
      },
    });
    expect(await throwing.readPullRequestChangedFiles({ pullRequestNumber: 3 })).toEqual({
      outcome: 'unknown',
      reason: 'files-failed',
    });
    expect(await new ForgeReadAdapter().readPullRequestChangedFiles({ pullRequestNumber: 3 })).toEqual({
      outcome: 'unknown',
      reason: 'forge-not-configured',
    });
    expect(
      await new ForgeReadAdapter({ owner: 'acme', repo: 'fleet' }).readPullRequestChangedFiles({
        pullRequestNumber: 3,
        repository: { owner: 'acme', repo: 'fleet' },
      }),
    ).toEqual({ outcome: 'unknown', reason: 'forge-not-configured' });
    const { adapter, calls } = adapterFor(filesStdout(['a.ts']));
    expect(
      await adapter.readPullRequestChangedFiles({ pullRequestNumber: 3, repository: { owner: 'bad owner', repo: 'x' } }),
    ).toEqual({ outcome: 'unknown', reason: 'invalid-repository' });
    expect(calls).toEqual([]);
  });

  it('returns invalid-request unknown on malformed runtime requests and throwing getters', async () => {
    const { adapter, calls } = adapterFor(filesStdout(['a.ts']));
    const throwingGetter = {
      get pullRequestNumber(): number {
        throw new Error('hostile getter');
      },
    };
    const requests: unknown[] = [
      null,
      7,
      'text',
      [],
      {},
      { pullRequestNumber: 0 },
      { pullRequestNumber: 1.5 },
      { pullRequestNumber: '42' },
      { pullRequestNumber: 1_000_000_000 },
      { pullRequestNumber: 3, unknownKey: true },
      { pullRequestNumber: 3, timeoutMs: Number.NaN },
      { pullRequestNumber: 3, timeoutMs: '20' },
      throwingGetter,
    ];
    for (const request of requests) {
      expect(await adapter.readPullRequestChangedFiles(request as never)).toEqual({
        outcome: 'unknown',
        reason: 'invalid-request',
      });
    }
    expect(calls).toEqual([]);
  });
});
