// ForgeActionAdapter merge confirmation (A13): every non-zero `gh pr merge`
// exit is confirmed by a read of the pull request state before any refusal
// is reported, and the reported reasons never echo the gh output.
/**
 * Drives the adapter with a fake runGh, the verifyCurrentHeadSha fake
 * pattern, and a fake ForgeReadPort: merged at the expected head is
 * executed, open is refused with its kind, merged elsewhere, unavailable,
 * throwing, and a missing read port are all ambiguous, and exit 0 never
 * reads.
 */

import { describe, expect, it } from 'vitest';

import { ForgeActionAdapter } from '../ForgeActionAdapter.adapter.js';
import type { ForgeActionRequest } from '../../../application/ports/out/ForgeActionPort.out-port.js';
import type {
  ForgeReadPort,
  PullRequestSnapshot,
  ReadPullRequestRequest,
  ReadPullRequestResult,
} from '../../../application/ports/out/ForgeReadPort.out-port.js';

const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const BRANCH = 'feat/example-lane';
const MERGE_REFUSAL_STDERR = 'HTTP 403: Resource not accessible by integration';

function forgeActionRequest(): ForgeActionRequest {
  return {
    actionId: 'action-1',
    attemptId: 'attempt-1',
    workOrderId: 'wo-1',
    kind: 'merge-pr',
    expectedHeadSha: HEAD_SHA,
    branchName: BRANCH,
  };
}

interface SnapshotOverride {
  readonly state?: PullRequestSnapshot['state'];
  readonly headSha?: string;
}

function makeRunGh(result: { exitCode: number; stdout: string; stderr: string }) {
  const calls: string[][] = [];
  const timeouts: (number | undefined)[] = [];
  const runGh = async (args: readonly string[], _ghConfigDir?: string, timeoutMs?: number) => {
    calls.push([...args]);
    timeouts.push(timeoutMs);
    return result;
  };
  return { calls, timeouts, runGh };
}

function makeReadPort(result: ReadPullRequestResult | { throw: true }) {
  const readCalls: ReadPullRequestRequest[] = [];
  const port: ForgeReadPort = {
    readPullRequest: async (request) => {
      readCalls.push(request);
      if ('throw' in result) {
        throw new Error(MERGE_REFUSAL_STDERR);
      }
      return result;
    },
    isConfigured: () => true,
    listOpenPullRequestsByBase: async () => ({ outcome: "unavailable" as const, reason: "not-used" }),
  };
  return { readCalls, port };
}

function foundSnapshot(overrides: SnapshotOverride = {}): ReadPullRequestResult {
  return {
    outcome: 'found',
    pullRequest: {
      number: 12,
      state: overrides.state ?? 'merged',
      mergeState: 'clean',
      headSha: overrides.headSha ?? HEAD_SHA,
      headRef: BRANCH,
      baseRef: 'main',
      mergedAtIso: overrides.state === 'open' ? null : '2026-10-26T10:00:00.000Z',
      closedAtIso: null,
      mergeCommitSha: overrides.state === 'open' ? null : HEAD_SHA,
    },
  };
}

describe('ForgeActionAdapter merge confirmation after a non-zero gh exit', () => {
  it('reports executed when the merge refusal is confirmed by a merged read at the expected head', async () => {
    const { runGh } = makeRunGh({ exitCode: 1, stdout: '', stderr: MERGE_REFUSAL_STDERR });
    const { readCalls, port } = makeReadPort(foundSnapshot());
    const adapter = new ForgeActionAdapter(
      { runGh, verifyCurrentHeadSha: async () => HEAD_SHA },
      port,
    );

    const result = await adapter.performForgeAction(forgeActionRequest());

    expect(result).toEqual({ outcome: 'executed', headSha: HEAD_SHA });
    expect(readCalls).toEqual([
      { ref: { kind: 'branch', branchName: BRANCH } },
    ]);
    expect(result.outcome === 'refused' || result.outcome === 'ambiguous').toBe(false);
    expect(JSON.stringify(result)).not.toContain('HTTP 403');
  });

  it('confirms a 7-hex expected head as a prefix of the merged 40-hex head', async () => {
    const shortHead = HEAD_SHA.slice(0, 7);
    const { runGh } = makeRunGh({ exitCode: 1, stdout: '', stderr: MERGE_REFUSAL_STDERR });
    const { port } = makeReadPort(foundSnapshot());
    const adapter = new ForgeActionAdapter(
      { runGh, verifyCurrentHeadSha: async () => shortHead },
      port,
    );

    const result = await adapter.performForgeAction({ ...forgeActionRequest(), expectedHeadSha: shortHead });

    expect(result).toEqual({ outcome: 'executed', headSha: shortHead });
  });

  it('refuses with the classifier kind when the pull request is still open', async () => {
    const { runGh } = makeRunGh({ exitCode: 1, stdout: '', stderr: MERGE_REFUSAL_STDERR });
    const { port } = makeReadPort(foundSnapshot({ state: 'open' }));
    const adapter = new ForgeActionAdapter(
      { runGh, verifyCurrentHeadSha: async () => HEAD_SHA },
      port,
    );

    const result = await adapter.performForgeAction(forgeActionRequest());

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'gh pr merge exited non-zero; the pull request is not merged',
      refusalKind: 'permission',
    });
  });

  it('reports ambiguous when the pull request merged at a different head', async () => {
    const { runGh } = makeRunGh({ exitCode: 1, stdout: '', stderr: MERGE_REFUSAL_STDERR });
    const { port } = makeReadPort(foundSnapshot({ headSha: OTHER_SHA }));
    const adapter = new ForgeActionAdapter(
      { runGh, verifyCurrentHeadSha: async () => HEAD_SHA },
      port,
    );

    const result = await adapter.performForgeAction(forgeActionRequest());

    expect(result).toEqual({
      outcome: 'ambiguous',
      reason: 'the pull request merged at a different head',
    });
    expect(JSON.stringify(result)).not.toContain('HTTP 403');
  });

  it('reports ambiguous when the read is unavailable', async () => {
    const { runGh } = makeRunGh({ exitCode: 1, stdout: '', stderr: MERGE_REFUSAL_STDERR });
    const { port } = makeReadPort({
      outcome: 'unavailable',
      reason: 'gh pr view could not complete',
    });
    const adapter = new ForgeActionAdapter(
      { runGh, verifyCurrentHeadSha: async () => HEAD_SHA },
      port,
    );

    const result = await adapter.performForgeAction(forgeActionRequest());

    expect(result).toEqual({
      outcome: 'ambiguous',
      reason: 'gh pr merge exited non-zero and the pull request state could not be read',
    });
    expect(JSON.stringify(result)).not.toContain('HTTP 403');
  });

  it('reports ambiguous when the read throws', async () => {
    const { runGh } = makeRunGh({ exitCode: 1, stdout: '', stderr: MERGE_REFUSAL_STDERR });
    const { port } = makeReadPort({ throw: true });
    const adapter = new ForgeActionAdapter(
      { runGh, verifyCurrentHeadSha: async () => HEAD_SHA },
      port,
    );

    const result = await adapter.performForgeAction(forgeActionRequest());

    expect(result).toEqual({
      outcome: 'ambiguous',
      reason: 'gh pr merge exited non-zero and the pull request state could not be read',
    });
    expect(JSON.stringify(result)).not.toContain('HTTP 403');
  });

  it('reports ambiguous when no read port is wired at all', async () => {
    const { runGh } = makeRunGh({ exitCode: 1, stdout: '', stderr: MERGE_REFUSAL_STDERR });
    const adapter = new ForgeActionAdapter({
      runGh,
      verifyCurrentHeadSha: async () => HEAD_SHA,
    });

    const result = await adapter.performForgeAction(forgeActionRequest());

    expect(result).toEqual({
      outcome: 'ambiguous',
      reason: 'gh pr merge exited non-zero and the pull request state could not be read',
    });
    expect(JSON.stringify(result)).not.toContain('HTTP 403');
  });

  it('merges the resolved pull request number, pinned to the expected head, in the bound repository (WB5b2)', async () => {
    const { runGh, calls } = makeRunGh({ exitCode: 0, stdout: '', stderr: '' });
    const adapter = new ForgeActionAdapter({
      runGh,
      verifyCurrentHeadSha: async () => HEAD_SHA,
      repository: { owner: 'acme', repo: 'app' },
    });

    const result = await adapter.performForgeAction({ ...forgeActionRequest(), pullRequestNumber: 42 });

    expect(result).toEqual({ outcome: 'executed', headSha: HEAD_SHA });
    expect(calls).toEqual([
      ['pr', 'merge', '-R', 'acme/app', '42', '--match-head-commit', HEAD_SHA, '--merge'],
    ]);
    expect(calls[0]).not.toContain(BRANCH);
  });

  it('reports executed on exit 0 without ever reading the pull request', async () => {
    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: '', stderr: '' });
    const { readCalls, port } = makeReadPort(foundSnapshot());
    const adapter = new ForgeActionAdapter(
      { runGh, verifyCurrentHeadSha: async () => HEAD_SHA },
      port,
    );

    const result = await adapter.performForgeAction(forgeActionRequest());

    expect(result).toEqual({ outcome: 'executed', headSha: HEAD_SHA });
    expect(calls).toHaveLength(1);
    expect(readCalls).toHaveLength(0);
  });
});

describe('ForgeActionAdapter.findOpenPullRequestsByHead (legacy PR lookup)', () => {
  const BOUND = { owner: 'acme', repo: 'app' };
  const OWN_PR = (number: number, sha: string, owner: string, ref = BRANCH): unknown => ({
    number,
    head: { sha, ref, repo: { owner: { login: owner } } },
  });

  it('qualifies the head with the repository owner and ignores a fork PR of the same branch name', async () => {
    const { runGh, calls } = makeRunGh({
      exitCode: 0,
      stdout: JSON.stringify([
        OWN_PR(7, HEAD_SHA, 'acme'),
        OWN_PR(8, HEAD_SHA, 'a-fork-owner'),
        OWN_PR(9, HEAD_SHA, 'acme', 'feat/other'),
      ]),
      stderr: '',
    });
    const adapter = new ForgeActionAdapter({ runGh, repository: BOUND });

    const result = await adapter.findOpenPullRequestsByHead({
      repository: 'acme/app',
      branchName: BRANCH,
    });

    expect(result).toEqual({ outcome: 'read', pullRequests: [{ number: 7, headSha: HEAD_SHA }] });
    expect(calls).toHaveLength(1);
    const args = JSON.stringify(calls[0]);
    expect(args).toContain('head=acme%3Afeat%2Fexample-lane');
    expect(args).toContain('state=open');
  });

  it('reports unreadable on a gh failure, a non-JSON answer and a throwing runGh, never an empty list', async () => {
    for (const runGh of [
      makeRunGh({ exitCode: 1, stdout: '', stderr: 'boom' }).runGh,
      makeRunGh({ exitCode: 0, stdout: 'not json', stderr: '' }).runGh,
      async () => {
        throw new Error('spawn failed');
      },
    ]) {
      const adapter = new ForgeActionAdapter({ runGh, repository: BOUND });
      const result = await adapter.findOpenPullRequestsByHead({
        repository: 'acme/app',
        branchName: BRANCH,
      });
      expect(result.outcome).toBe('unreadable');
    }
  });

  it('refuses when no repository is bound, and never runs gh', async () => {
    const { runGh, calls } = makeRunGh({ exitCode: 0, stdout: '[]', stderr: '' });
    const adapter = new ForgeActionAdapter({ runGh });

    const result = await adapter.findOpenPullRequestsByHead({
      repository: 'acme/app',
      branchName: BRANCH,
    });

    expect(result).toEqual({ outcome: 'unreadable', reason: 'legacy-pr-lookup-unbound-repository' });
    expect(calls).toHaveLength(0);
  });

  it('refuses a query for a repository other than the bound one, and never runs gh', async () => {
    const { runGh, calls } = makeRunGh({ exitCode: 0, stdout: '[]', stderr: '' });
    const adapter = new ForgeActionAdapter({ runGh, repository: BOUND });

    const result = await adapter.findOpenPullRequestsByHead({
      repository: 'other-owner/app',
      branchName: BRANCH,
    });

    expect(result).toEqual({ outcome: 'unreadable', reason: 'legacy-pr-lookup-repository-mismatch' });
    expect(calls).toHaveLength(0);
  });

  it('bounds the lookup to 15 seconds and treats a full page as an incomplete list (WB5b2)', async () => {
    const one = makeRunGh({ exitCode: 0, stdout: JSON.stringify([OWN_PR(7, HEAD_SHA, 'acme')]), stderr: '' });
    const adapter = new ForgeActionAdapter({ runGh: one.runGh, repository: BOUND });
    await adapter.findOpenPullRequestsByHead({ repository: 'acme/app', branchName: BRANCH });
    expect(one.timeouts).toEqual([15_000]);

    const page = (count: number): string =>
      JSON.stringify(Array.from({ length: count }, (_, index) => OWN_PR(index + 1, HEAD_SHA, 'acme')));
    const full = makeRunGh({ exitCode: 0, stdout: page(20), stderr: '' });
    const fullResult = await new ForgeActionAdapter({
      runGh: full.runGh,
      repository: BOUND,
    }).findOpenPullRequestsByHead({ repository: 'acme/app', branchName: BRANCH });
    expect(fullResult).toEqual({
      outcome: 'unreadable',
      reason: 'the pull request lookup answer was not a complete list',
    });

    const short = makeRunGh({ exitCode: 0, stdout: page(19), stderr: '' });
    const shortResult = await new ForgeActionAdapter({
      runGh: short.runGh,
      repository: BOUND,
    }).findOpenPullRequestsByHead({ repository: 'acme/app', branchName: BRANCH });
    expect(shortResult.outcome).toBe('read');
  });

  it('screens the bound owner and repo with the repository pattern before they reach the endpoint, and never runs gh (WB5b2)', async () => {
    // The Kelvin sign lower-cases to a plain k, so the case-insensitive bound
    // comparison alone lets this owner through.
    const { runGh, calls } = makeRunGh({ exitCode: 0, stdout: '[]', stderr: '' });
    for (const bound of [
      { owner: 'acme-\u212A', repo: 'app' },
      { owner: 'acme', repo: 'ap\u212Ap' },
    ]) {
      const adapter = new ForgeActionAdapter({ runGh, repository: bound });
      const result = await adapter.findOpenPullRequestsByHead({
        repository: `${bound.owner.toLowerCase().replace('\u212a', 'k')}/${bound.repo.toLowerCase().replace('\u212a', 'k')}`,
        branchName: BRANCH,
      });
      expect(result.outcome).toBe('unreadable');
      expect(calls).toHaveLength(0);
    }
  });

  it('measures the response in bytes: a multibyte answer over the cap is refused', async () => {
    const entry = { ...(OWN_PR(7, HEAD_SHA, 'acme') as object), pad: '\u00e9'.repeat(140_000) };
    const stdout = JSON.stringify([entry]);
    expect(stdout.length).toBeLessThan(262_144);
    expect(Buffer.byteLength(stdout, 'utf8')).toBeGreaterThan(262_144);
    const { runGh } = makeRunGh({ exitCode: 0, stdout, stderr: '' });
    const adapter = new ForgeActionAdapter({ runGh, repository: BOUND });

    const result = await adapter.findOpenPullRequestsByHead({
      repository: 'acme/app',
      branchName: BRANCH,
    });

    expect(result.outcome).toBe('unreadable');
  });
});
