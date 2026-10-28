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
  const runGh = async (args: readonly string[]) => {
    calls.push([...args]);
    return result;
  };
  return { calls, runGh };
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
