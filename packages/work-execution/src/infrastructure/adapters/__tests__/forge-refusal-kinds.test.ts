// Forge refusal kinds: the classifier over recorded gh output and the
// adapter's refusal results, including the kind-other pre-checks.
/**
 * Covers classifyGhRefusal over the representative gh fixtures (permission
 * before protection before conflict, case-insensitive) and the adapter's
 * refused results carrying refusalKind for both merge-pr and
 * push-and-open-pr, with its own pre-checks always other and never running gh.
 */

import { describe, expect, it } from 'vitest';

import {
  ForgeActionAdapter,
  classifyGhRefusal,
} from '../ForgeActionAdapter.adapter.js';
import type { ForgeActionRequest } from '../../../application/ports/out/ForgeActionPort.out-port.js';
import type {
  ForgeReadPort,
  ReadPullRequestRequest,
  ReadPullRequestResult,
} from '../../../application/ports/out/ForgeReadPort.out-port.js';

const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const PERMISSION_FIXTURE = 'GraphQL: Resource not accessible by integration (mergePullRequest)';
const CONFLICT_FIXTURE = 'GraphQL: Pull request has merge conflicts (mergePullRequest)';
const REPO = 'example-owner/example-repo';
const LANE_BRANCH = 'feat/example-lane';
const USER = 'example-user';

/** Representative gh exit-1 stderr lines (stdout empty) and their kinds. */
const FIXTURES: ReadonlyArray<readonly [string, string]> = [
  [
    `X Pull request ${REPO}#12 is not mergeable: the merge commit cannot be cleanly created.`,
    'conflict',
  ],
  ['GraphQL: Pull request has merge conflicts (mergePullRequest)', 'conflict'],
  [
    `X Pull request ${REPO}#12 is not mergeable: the base branch policy prohibits the merge.`,
    'protection',
  ],
  ['GraphQL: Required status check "ci" is expected. (mergePullRequest)', 'protection'],
  [
    'GraphQL: At least 1 approving review is required by reviewers with write access. (mergePullRequest)',
    'protection',
  ],
  [
    'GraphQL: Repository rule violations found\n\n- Changes must be made through a pull request.',
    'protection',
  ],
  ['GraphQL: branch protection (organization rules)', 'protection'],
  ['GraphQL: Resource not accessible by integration (mergePullRequest)', 'permission'],
  [
    `GraphQL: ${USER} does not have the correct permissions to execute \`MergePullRequest\` (mergePullRequest)`,
    'permission',
  ],
  [
    'HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login',
    'permission',
  ],
  ['HTTP 403: Must have admin rights to Repository. (https://api.github.com/graphql)', 'permission'],
  ['GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)', 'other'],
  ['GraphQL: Pull Request is not mergeable (mergePullRequest)', 'other'],
  ['pull request not mergeable', 'other'],
  ['', 'other'],
];

describe('classifyGhRefusal', () => {
  it.each(FIXTURES)('classifies stderr %j as %s', (stderr, kind) => {
    expect(classifyGhRefusal(stderr, '')).toBe(kind);
  });

  it('classifies the same message from stdout with empty stderr', () => {
    expect(classifyGhRefusal('', CONFLICT_FIXTURE)).toBe('conflict');
    expect(
      classifyGhRefusal('', 'HTTP 403: Must have admin rights to Repository. (https://api.github.com/graphql)'),
    ).toBe('permission');
  });

  it('lets permission win over protection when both appear', () => {
    expect(classifyGhRefusal('HTTP 403: blocked by branch protection', '')).toBe('permission');
  });

  it('lets protection win over conflict when both appear', () => {
    expect(
      classifyGhRefusal('Required status check "ci" is expected; merge commit cannot be cleanly created', ''),
    ).toBe('protection');
  });

  it('matches upper-cased output case-insensitively', () => {
    expect(
      classifyGhRefusal('GRAPHQL: PULL REQUEST HAS MERGE CONFLICTS (MERGEPULLREQUEST)', ''),
    ).toBe('conflict');
  });
});

describe('ForgeActionAdapter refusal kinds', () => {
  function forgeActionRequest(
    overrides: Partial<ForgeActionRequest> = {},
  ): ForgeActionRequest {
    return {
      actionId: 'action-1',
      attemptId: 'attempt-1',
      workOrderId: 'wo-1',
      kind: 'push-and-open-pr',
      expectedHeadSha: HEAD_SHA,
      branchName: LANE_BRANCH,
      ...overrides,
    };
  }

  function makeRunGh(result: { exitCode: number; stdout: string; stderr: string }) {
    const calls: string[][] = [];
    const runGh = async (args: readonly string[]) => {
      calls.push([...args]);
      return result;
    };
    return { calls, runGh };
  }

  /** A read port that answers `open` at the current head, so a merge refusal stays refused. */
  function makeOpenReadPort(): ForgeReadPort {
    const read = async (_request: ReadPullRequestRequest): Promise<ReadPullRequestResult> => ({
      outcome: 'found',
      pullRequest: {
        number: 12,
        state: 'open',
        headSha: HEAD_SHA,
        headRef: LANE_BRANCH,
        baseRef: 'main',
        mergedAtIso: null,
        closedAtIso: null,
        mergeCommitSha: null,
      },
    });
    return { readPullRequest: read, isConfigured: () => true };
  }

  it('kinds a refused create as permission', async () => {
    const { runGh } = makeRunGh({ exitCode: 1, stdout: '', stderr: PERMISSION_FIXTURE });
    const adapter = new ForgeActionAdapter({
      runGh,
      verifyCurrentHeadSha: async () => HEAD_SHA,
    });

    const result = await adapter.performForgeAction(forgeActionRequest());

    expect(result).toEqual({
      outcome: 'refused',
      reason: `gh pr create failed (exit 1): ${PERMISSION_FIXTURE}`,
      refusalKind: 'permission',
    });
  });

  it('kinds a refused merge as permission', async () => {
    const { runGh } = makeRunGh({ exitCode: 1, stdout: '', stderr: PERMISSION_FIXTURE });
    const adapter = new ForgeActionAdapter(
      {
        runGh,
        verifyCurrentHeadSha: async () => HEAD_SHA,
      },
      makeOpenReadPort(),
    );

    const result = await adapter.performForgeAction(
      forgeActionRequest({ kind: 'merge-pr' }),
    );

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'gh pr merge exited non-zero; the pull request is not merged',
      refusalKind: 'permission',
    });
  });

  it('kinds a refused merge as conflict', async () => {
    const { runGh } = makeRunGh({ exitCode: 1, stdout: '', stderr: CONFLICT_FIXTURE });
    const adapter = new ForgeActionAdapter(
      {
        runGh,
        verifyCurrentHeadSha: async () => HEAD_SHA,
      },
      makeOpenReadPort(),
    );

    const result = await adapter.performForgeAction(
      forgeActionRequest({ kind: 'merge-pr' }),
    );

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'gh pr merge exited non-zero; the pull request is not merged',
      refusalKind: 'conflict',
    });
  });

  it('kinds a refused merge from the whole failed output, with the fixed reason', async () => {
    const { runGh } = makeRunGh({
      exitCode: 1,
      stdout: '',
      stderr: `warning: something\n${PERMISSION_FIXTURE}\n`,
    });
    const adapter = new ForgeActionAdapter(
      {
        runGh,
        verifyCurrentHeadSha: async () => HEAD_SHA,
      },
      makeOpenReadPort(),
    );

    const result = await adapter.performForgeAction(
      forgeActionRequest({ kind: 'merge-pr' }),
    );

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'gh pr merge exited non-zero; the pull request is not merged',
      refusalKind: 'permission',
    });
  });

  it('refuses an invalid head as other, never running gh', async () => {
    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: '', stderr: '' });
    const adapter = new ForgeActionAdapter({ runGh });

    const result = await adapter.performForgeAction(
      forgeActionRequest({ expectedHeadSha: 'not-a-sha' }),
    );

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Invalid expected head SHA: not-a-sha',
      refusalKind: 'other',
    });
    expect(calls).toHaveLength(0);
  });

  it('refuses an invalid branch as other, never running gh', async () => {
    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: '', stderr: '' });
    const adapter = new ForgeActionAdapter({ runGh });

    const result = await adapter.performForgeAction(
      forgeActionRequest({ branchName: 'bad branch' }),
    );

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Invalid branch name: bad branch',
      refusalKind: 'other',
    });
    expect(calls).toHaveLength(0);
  });

  it('refuses without a verifier as other, never running gh', async () => {
    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: '', stderr: '' });
    const adapter = new ForgeActionAdapter({ runGh });

    const result = await adapter.performForgeAction(forgeActionRequest());

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Cannot perform forge action without verifyCurrentHeadSha',
      refusalKind: 'other',
    });
    expect(calls).toHaveLength(0);
  });

  it('refuses a moved head as other, never running gh', async () => {
    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: '', stderr: '' });
    const adapter = new ForgeActionAdapter({
      runGh,
      verifyCurrentHeadSha: async () => OTHER_SHA,
    });

    const result = await adapter.performForgeAction(forgeActionRequest());

    expect(result).toEqual({
      outcome: 'refused',
      reason: `Moved head: branch ${LANE_BRANCH} is at ${OTHER_SHA}, expected ${HEAD_SHA}`,
      refusalKind: 'other',
    });
    expect(calls).toHaveLength(0);
  });
});
