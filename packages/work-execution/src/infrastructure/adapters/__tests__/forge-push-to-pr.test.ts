// Forge action adapter tests for the `push-to-pr` kind (AM4b-3). The PR is
// read before anything is pushed and again afterwards; missing, closed or
// unreadable PRs refuse, an already-current head is a no-op, a moved head is
// refused, and a confirmation that does not show the head is ambiguous.

import { describe, expect, it } from 'vitest';

import { ForgeActionAdapter } from '../ForgeActionAdapter.adapter.js';
import type { ForgeActionRequest } from '../../../application/ports/out/ForgeActionPort.out-port.js';
import type {
  ForgeReadPort,
  ForgeRepositoryRef,
  PullRequestRef,
  PullRequestState,
  ReadPullRequestRequest,
  ReadPullRequestResult,
} from '../../../application/ports/out/ForgeReadPort.out-port.js';

const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const LANE_ID = 'wk-p4-push-to-pr';

function forgeActionRequest(overrides: Partial<ForgeActionRequest> = {}): ForgeActionRequest {
  return {
    actionId: 'action-1',
    attemptId: 'attempt-1',
    workOrderId: 'wo-1',
    kind: 'push-to-pr',
    expectedHeadSha: HEAD_SHA,
    branchName: `feat/${LANE_ID}`,
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

/** A verifier that records how many times it ran and returns a fixed head. */
function makeVerifier(head: string) {
  const state = { calls: 0 };
  const verify = async () => {
    state.calls += 1;
    return head;
  };
  return { state, verify };
}

/** One `found` read result for a pull request in the given state. */
function pr(number: number, state: PullRequestState, headSha: string): ReadPullRequestResult {
  return {
    outcome: 'found',
    pullRequest: {
      number,
      state,
      mergeState: 'clean',
      headSha,
      headRef: `feat/${LANE_ID}`,
      baseRef: 'main',
      mergedAtIso: state === 'merged' ? '2026-10-25T20:12:08Z' : null,
      closedAtIso: state === 'closed' ? '2026-10-25T20:12:08Z' : null,
      mergeCommitSha: state === 'merged' ? headSha : null,
    },
  };
}

/** A reader serving a queue of results and recording every read call. */
class FakeReader implements ForgeReadPort {
  readonly calls: { ref: PullRequestRef; repository?: ForgeRepositoryRef }[] = [];
  private readonly queue: Array<ReadPullRequestResult | Error>;
  configured = true;

  constructor(results: Array<ReadPullRequestResult | Error>) {
    this.queue = [...results];
  }

  isConfigured(): boolean {
    return this.configured;
  }

  async readPullRequest(request: ReadPullRequestRequest): Promise<ReadPullRequestResult> {
    this.calls.push({ ref: request.ref, repository: request.repository });
    const next = this.queue.shift();
    if (next instanceof Error) {
      throw next;
    }
    if (next === undefined) {
      throw new Error('FakeReader exhausted');
    }
    return next;
  }
}

describe('ForgeActionAdapter push-to-pr', () => {
  it('pushes to an open PR and confirms the head landed', async () => {
    const { calls: ghCalls, runGh } = makeRunGh({ exitCode: 0, stdout: '', stderr: '' });
    const reader = new FakeReader([pr(42, 'open', OTHER_SHA), pr(42, 'open', HEAD_SHA)]);
    const verifier = makeVerifier(HEAD_SHA);
    const adapter = new ForgeActionAdapter({
      runGh,
      verifyCurrentHeadSha: verifier.verify,
      pullRequestRead: reader,
    });

    const result = await adapter.performForgeAction(forgeActionRequest());

    expect(result).toEqual({
      outcome: 'executed',
      pullRequestNumber: 42,
      headSha: HEAD_SHA,
    });
    expect(reader.calls).toEqual([
      { ref: { kind: 'branch', branchName: `feat/${LANE_ID}` } },
      { ref: { kind: 'branch', branchName: `feat/${LANE_ID}` } },
    ]);
    expect(verifier.state.calls).toBe(1);
    expect(ghCalls).toHaveLength(0);
  });

  it('treats an already-current PR head as a no-op executed result', async () => {
    const { calls: ghCalls, runGh } = makeRunGh({ exitCode: 0, stdout: '', stderr: '' });
    const reader = new FakeReader([pr(7, 'open', HEAD_SHA)]);
    const verifier = makeVerifier(HEAD_SHA);
    const adapter = new ForgeActionAdapter({
      runGh,
      verifyCurrentHeadSha: verifier.verify,
      pullRequestRead: reader,
    });

    const result = await adapter.performForgeAction(forgeActionRequest());

    expect(result).toEqual({ outcome: 'executed', pullRequestNumber: 7, headSha: HEAD_SHA });
    expect(reader.calls).toHaveLength(1);
    expect(verifier.state.calls).toBe(0);
    expect(ghCalls).toHaveLength(0);
  });

  it('refuses without a pull request read', async () => {
    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: '', stderr: '' });
    const verifier = makeVerifier(HEAD_SHA);
    const adapter = new ForgeActionAdapter({ runGh, verifyCurrentHeadSha: verifier.verify });

    const result = await adapter.performForgeAction(forgeActionRequest());

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Cannot push to a pull request without a pull request read',
      refusalKind: 'other',
    });
    expect(verifier.state.calls).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it.each([
    {
      name: 'not-found',
      read: { outcome: 'not-found' } as ReadPullRequestResult,
      reason: `No pull request exists for branch feat/${LANE_ID}; push-to-pr never opens one`,
    },
    {
      name: 'merged',
      read: pr(9, 'merged', OTHER_SHA),
      reason: `Pull request #9 for branch feat/${LANE_ID} is merged, not open`,
    },
    {
      name: 'closed',
      read: pr(9, 'closed', OTHER_SHA),
      reason: `Pull request #9 for branch feat/${LANE_ID} is closed, not open`,
    },
    {
      name: 'unavailable',
      read: { outcome: 'unavailable' as const, reason: 'gh pr view timed out' },
      reason: `Could not read the pull request for branch feat/${LANE_ID}: gh pr view timed out`,
    },
  ])('%s pre-read refuses before pushing or verifying', async ({ read, reason }) => {
    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: '', stderr: '' });
    const reader = new FakeReader([read]);
    const verifier = makeVerifier(HEAD_SHA);
    const adapter = new ForgeActionAdapter({
      runGh,
      verifyCurrentHeadSha: verifier.verify,
      pullRequestRead: reader,
    });

    const result = await adapter.performForgeAction(forgeActionRequest());

    expect(result).toEqual({ outcome: 'refused', reason, refusalKind: 'other' });
    expect(verifier.state.calls).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('refuses when the pre-read throws', async () => {
    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: '', stderr: '' });
    const reader = new FakeReader([new Error('read exploded')]);
    const verifier = makeVerifier(HEAD_SHA);
    const adapter = new ForgeActionAdapter({
      runGh,
      verifyCurrentHeadSha: verifier.verify,
      pullRequestRead: reader,
    });

    const result = await adapter.performForgeAction(forgeActionRequest());

    expect(result).toEqual({
      outcome: 'refused',
      reason: `Could not read the pull request for branch feat/${LANE_ID}: read exploded`,
      refusalKind: 'other',
    });
    expect(verifier.state.calls).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('refuses a moved head after the pre-read with one read only', async () => {
    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: '', stderr: '' });
    const reader = new FakeReader([pr(42, 'open', OTHER_SHA)]);
    const verifier = makeVerifier(OTHER_SHA);
    const adapter = new ForgeActionAdapter({
      runGh,
      verifyCurrentHeadSha: verifier.verify,
      pullRequestRead: reader,
    });

    const result = await adapter.performForgeAction(forgeActionRequest());

    expect(result).toEqual({
      outcome: 'refused',
      reason: `Moved head: branch feat/${LANE_ID} is at ${OTHER_SHA}, expected ${HEAD_SHA}`,
      refusalKind: 'other',
    });
    expect(reader.calls).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  it.each([
    {
      name: 'another head',
      read: pr(42, 'open', OTHER_SHA),
      what: `#42 open at ${OTHER_SHA}`,
    },
    {
      name: 'closed',
      read: pr(42, 'closed', OTHER_SHA),
      what: `#42 closed at ${OTHER_SHA}`,
    },
    {
      name: 'not-found',
      read: { outcome: 'not-found' } as ReadPullRequestResult,
      what: 'no pull request',
    },
    {
      name: 'unavailable',
      read: { outcome: 'unavailable' as const, reason: 'gh pr view failed (exit 1)' },
      what: 'gh pr view failed (exit 1)',
    },
  ])('post-read %s is ambiguous for reconciliation', async ({ read, what }) => {
    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: '', stderr: '' });
    const reader = new FakeReader([pr(42, 'open', OTHER_SHA), read]);
    const verifier = makeVerifier(HEAD_SHA);
    const adapter = new ForgeActionAdapter({
      runGh,
      verifyCurrentHeadSha: verifier.verify,
      pullRequestRead: reader,
    });

    const result = await adapter.performForgeAction(forgeActionRequest());

    expect(result).toEqual({
      outcome: 'ambiguous',
      reason: `After the push step for branch feat/${LANE_ID}, pull request #42 does not show head ${HEAD_SHA}: ${what}`,
    });
    expect(calls).toHaveLength(0);
  });

  it('treats a throwing post-read as ambiguous for reconciliation', async () => {
    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: '', stderr: '' });
    const reader = new FakeReader([pr(42, 'open', OTHER_SHA), new Error('read exploded')]);
    const verifier = makeVerifier(HEAD_SHA);
    const adapter = new ForgeActionAdapter({
      runGh,
      verifyCurrentHeadSha: verifier.verify,
      pullRequestRead: reader,
    });

    const result = await adapter.performForgeAction(forgeActionRequest());

    expect(result).toEqual({
      outcome: 'ambiguous',
      reason: `After the push step for branch feat/${LANE_ID}, its pull request could not be read`,
    });
    expect(calls).toHaveLength(0);
  });

  it('is ambiguous when the post-read finds a different open pull request at the head', async () => {
    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: '', stderr: '' });
    const reader = new FakeReader([pr(42, 'open', OTHER_SHA), pr(43, 'open', HEAD_SHA)]);
    const verifier = makeVerifier(HEAD_SHA);
    const adapter = new ForgeActionAdapter({
      runGh,
      verifyCurrentHeadSha: verifier.verify,
      pullRequestRead: reader,
    });

    const result = await adapter.performForgeAction(forgeActionRequest());

    expect(result.outcome).toBe('ambiguous');
    expect(calls).toHaveLength(0);
  });

  it('leaves push-and-open-pr and merge-pr gh arguments unchanged and never reads', async () => {
    const { calls, runGh } = makeRunGh({
      exitCode: 0,
      stdout: 'https://github.com/org/repo/pull/123\n',
      stderr: '',
    });
    const reader = new FakeReader([]);
    const verifier = makeVerifier(HEAD_SHA);
    const adapter = new ForgeActionAdapter({
      runGh,
      verifyCurrentHeadSha: verifier.verify,
      pullRequestRead: reader,
    });

    const createResult = await adapter.performForgeAction(
      forgeActionRequest({ kind: 'push-and-open-pr' }),
    );
    const mergeResult = await adapter.performForgeAction(forgeActionRequest({ kind: 'merge-pr' }));

    expect(createResult).toEqual({ outcome: 'executed', pullRequestNumber: 123, headSha: HEAD_SHA });
    expect(mergeResult).toEqual({ outcome: 'executed', headSha: HEAD_SHA });
    expect(calls[0]?.slice(0, 4)).toEqual(['pr', 'create', '--head', `feat/${LANE_ID}`]);
    expect(calls[1]).toEqual([
      'pr',
      'merge',
      `feat/${LANE_ID}`,
      '--match-head-commit',
      HEAD_SHA,
      '--merge',
    ]);
    expect(reader.calls).toHaveLength(0);
  });

  it('passes -R on every gh argv when a repository is configured', async () => {
    const { calls, runGh } = makeRunGh({
      exitCode: 0,
      stdout: 'https://github.com/acme/widgets/pull/5\n',
      stderr: '',
    });
    const adapter = new ForgeActionAdapter({
      runGh,
      verifyCurrentHeadSha: async () => HEAD_SHA,
      repository: { owner: 'acme', repo: 'widgets' },
    });

    await adapter.performForgeAction(forgeActionRequest({ kind: 'push-and-open-pr' }));
    await adapter.performForgeAction(forgeActionRequest({ kind: 'merge-pr' }));

    expect(calls[0]).toEqual([
      'pr',
      'create',
      '-R',
      'acme/widgets',
      '--head',
      `feat/${LANE_ID}`,
      '--title',
      'Fleet work order wo-1',
      '--body',
      `Attempt attempt-1 (action action-1) at head ${HEAD_SHA}.`,
    ]);
    expect(calls[1]).toEqual([
      'pr',
      'merge',
      '-R',
      'acme/widgets',
      `feat/${LANE_ID}`,
      '--match-head-commit',
      HEAD_SHA,
      '--merge',
    ]);
  });

  it('confirmation reads name the repository and read by number when one is known', async () => {
    const reader = new FakeReader([pr(42, 'merged', HEAD_SHA)]);
    const { runGh } = makeRunGh({ exitCode: 1, stdout: '', stderr: 'pull request not mergeable\n' });
    const adapter = new ForgeActionAdapter(
      {
        runGh,
        verifyCurrentHeadSha: async () => HEAD_SHA,
        repository: { owner: 'acme', repo: 'widgets' },
      },
      reader,
    );

    const result = await adapter.performForgeAction(
      forgeActionRequest({ kind: 'merge-pr', pullRequestNumber: 42 }),
    );

    expect(result).toEqual({ outcome: 'executed', headSha: HEAD_SHA });
    expect(reader.calls).toEqual([
      { ref: { kind: 'number', number: 42 }, repository: { owner: 'acme', repo: 'widgets' } },
    ]);
  });

  it('confirmation reads by branch when no pull request number is known', async () => {
    const reader = new FakeReader([pr(7, 'merged', HEAD_SHA)]);
    const { runGh } = makeRunGh({ exitCode: 1, stdout: '', stderr: 'pull request not mergeable\n' });
    const adapter = new ForgeActionAdapter(
      {
        runGh,
        verifyCurrentHeadSha: async () => HEAD_SHA,
        repository: { owner: 'acme', repo: 'widgets' },
      },
      reader,
    );

    const result = await adapter.performForgeAction(forgeActionRequest({ kind: 'merge-pr' }));

    expect(result).toEqual({ outcome: 'executed', headSha: HEAD_SHA });
    expect(reader.calls).toEqual([
      {
        ref: { kind: 'branch', branchName: `feat/${LANE_ID}` },
        repository: { owner: 'acme', repo: 'widgets' },
      },
    ]);
  });

  it('push-to-pr reads name the repository when one is configured', async () => {
    const reader = new FakeReader([pr(42, 'open', OTHER_SHA), pr(42, 'open', HEAD_SHA)]);
    const verifier = makeVerifier(HEAD_SHA);
    const adapter = new ForgeActionAdapter({
      runGh: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      verifyCurrentHeadSha: verifier.verify,
      pullRequestRead: reader,
      repository: { owner: 'acme', repo: 'widgets' },
    });

    const result = await adapter.performForgeAction(forgeActionRequest());

    expect(result).toEqual({ outcome: 'executed', pullRequestNumber: 42, headSha: HEAD_SHA });
    expect(reader.calls).toEqual([
      {
        ref: { kind: 'branch', branchName: `feat/${LANE_ID}` },
        repository: { owner: 'acme', repo: 'widgets' },
      },
      {
        ref: { kind: 'branch', branchName: `feat/${LANE_ID}` },
        repository: { owner: 'acme', repo: 'widgets' },
      },
    ]);
  });

  describe('push-and-open-pr title and body (K6-2)', () => {
    it('uses the provided title and body instead of the defaults, each as one arg', async () => {
      const { calls, runGh } = makeRunGh({
        exitCode: 0,
        stdout: 'https://github.com/org/repo/pull/124\n',
        stderr: '',
      });
      const adapter = new ForgeActionAdapter({
        runGh,
        verifyCurrentHeadSha: async () => HEAD_SHA,
      });

      const result = await adapter.performForgeAction(
        forgeActionRequest({
          kind: 'push-and-open-pr',
          title: 'feat: a titled change',
          body: 'first line\nsecond line',
        }),
      );

      expect(result).toEqual({ outcome: 'executed', pullRequestNumber: 124, headSha: HEAD_SHA });
      expect(calls).toEqual([
        [
          'pr',
          'create',
          '--head',
          `feat/${LANE_ID}`,
          '--title',
          'feat: a titled change',
          '--body',
          'first line\nsecond line',
        ],
      ]);
    });

    it('keeps the exact default title and body argv when none are provided', async () => {
      const { calls, runGh } = makeRunGh({
        exitCode: 0,
        stdout: 'https://github.com/org/repo/pull/125\n',
        stderr: '',
      });
      const adapter = new ForgeActionAdapter({
        runGh,
        verifyCurrentHeadSha: async () => HEAD_SHA,
      });

      await adapter.performForgeAction(forgeActionRequest({ kind: 'push-and-open-pr' }));

      expect(calls).toEqual([
        [
          'pr',
          'create',
          '--head',
          `feat/${LANE_ID}`,
          '--title',
          'Fleet work order wo-1',
          '--body',
          `Attempt attempt-1 (action action-1) at head ${HEAD_SHA}.`,
        ],
      ]);
    });

    it('does not leak title or body into merge-pr argv', async () => {
      const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: '', stderr: '' });
      const adapter = new ForgeActionAdapter({
        runGh,
        verifyCurrentHeadSha: async () => HEAD_SHA,
      });

      await adapter.performForgeAction(
        forgeActionRequest({ kind: 'merge-pr', title: 'ignored', body: 'ignored' }),
      );

      expect(calls).toEqual([
        [
          'pr',
          'merge',
          `feat/${LANE_ID}`,
          '--match-head-commit',
          HEAD_SHA,
          '--merge',
        ],
      ]);
    });
  });

  describe('push-and-open-pr base branch (CB-D2)', () => {
    it('appends --base chain/example right after --head on push-and-open-pr', async () => {
      const { calls, runGh } = makeRunGh({
        exitCode: 0,
        stdout: 'https://github.com/org/repo/pull/200\n',
        stderr: '',
      });
      const adapter = new ForgeActionAdapter({
        runGh,
        verifyCurrentHeadSha: async () => HEAD_SHA,
      });

      const result = await adapter.performForgeAction(
        forgeActionRequest({ kind: 'push-and-open-pr', baseBranch: 'chain/example' }),
      );

      expect(result).toEqual({ outcome: 'executed', pullRequestNumber: 200, headSha: HEAD_SHA });
      expect(calls).toHaveLength(1);
      const headIndex = calls[0]!.indexOf('--head');
      expect(calls[0]![headIndex + 1]).toBe(`feat/${LANE_ID}`);
      expect(calls[0]![headIndex + 2]).toBe('--base');
      expect(calls[0]![headIndex + 3]).toBe('chain/example');
    });

    it('appends --base main right after --head on push-and-open-pr', async () => {
      const { calls, runGh } = makeRunGh({
        exitCode: 0,
        stdout: 'https://github.com/org/repo/pull/201\n',
        stderr: '',
      });
      const adapter = new ForgeActionAdapter({
        runGh,
        verifyCurrentHeadSha: async () => HEAD_SHA,
      });

      const result = await adapter.performForgeAction(
        forgeActionRequest({ kind: 'push-and-open-pr', baseBranch: 'main' }),
      );

      expect(result).toEqual({ outcome: 'executed', pullRequestNumber: 201, headSha: HEAD_SHA });
      const headIndex = calls[0]!.indexOf('--head');
      expect(calls[0]![headIndex + 2]).toBe('--base');
      expect(calls[0]![headIndex + 3]).toBe('main');
    });

    it('refuses an unparsable base branch without calling gh', async () => {
      const { calls, runGh } = makeRunGh({
        exitCode: 0,
        stdout: 'https://github.com/org/repo/pull/202\n',
        stderr: '',
      });
      const adapter = new ForgeActionAdapter({
        runGh,
        verifyCurrentHeadSha: async () => HEAD_SHA,
      });

      const result = await adapter.performForgeAction(
        forgeActionRequest({ kind: 'push-and-open-pr', baseBranch: 'release' }),
      );

      expect(result).toEqual({ outcome: 'refused', reason: 'Invalid base branch', refusalKind: 'other' });
      expect(calls).toEqual([]);
    });
  });

});
