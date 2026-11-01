// Forge action adapter tests for the `post-status` kind (KS7a): the pre-merge
// review receipt posted to `gh api repos/<owner>/<repo>/statuses/<sha>` with a
// fixed `premerge` context, after the branch head is verified. Only the paired
// description/state combinations pass; every malformed field refuses without
// calling `gh`.

import { describe, expect, it } from 'vitest';

import { ForgeActionAdapter } from '../ForgeActionAdapter.adapter.js';
import type { ForgeActionRequest } from '../../../application/ports/out/ForgeActionPort.out-port.js';

const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';

function forgeActionRequest(overrides: Partial<ForgeActionRequest> = {}): ForgeActionRequest {
  return {
    actionId: 'action-1',
    attemptId: 'attempt-1',
    workOrderId: 'wo-1',
    kind: 'post-status',
    expectedHeadSha: HEAD_SHA,
    branchName: 'feat/lane',
    status: {
      context: 'premerge',
      state: 'success',
      description: 'pre-merge receipt recorded',
    },
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

function makeAdapter(options: {
  runGhResult: { exitCode: number; stdout: string; stderr: string };
  verifyHead?: string;
  repository?: { owner: string; repo: string } | null;
}) {
  const { calls, runGh } = makeRunGh(options.runGhResult);
  const verifier = makeVerifier(options.verifyHead ?? HEAD_SHA);
  const adapter = new ForgeActionAdapter({
    runGh,
    verifyCurrentHeadSha: verifier.verify,
    ...(options.repository === null
      ? {}
      : { repository: options.repository ?? { owner: 'fleet', repo: 'fleet-v2' } }),
  });
  return { adapter, calls, verifier };
}

const POST_ARGV = [
  'api',
  '-X',
  'POST',
  `repos/fleet/fleet-v2/statuses/${HEAD_SHA}`,
  '-f',
  'state=success',
  '-f',
  'context=premerge',
  '-f',
  'description=pre-merge receipt recorded',
];

describe('ForgeActionAdapter post-status', () => {
  it('posts a success receipt and verifies the head first', async () => {
    const { adapter, calls, verifier } = makeAdapter({
      runGhResult: { exitCode: 0, stdout: '', stderr: '' },
    });
    const result = await adapter.performForgeAction(forgeActionRequest());
    expect(result).toEqual({ outcome: 'executed', headSha: HEAD_SHA });
    expect(verifier.state.calls).toBe(1);
    expect(calls).toEqual([POST_ARGV]);
  });

  it('posts a pending receipt', async () => {
    const { adapter, calls } = makeAdapter({
      runGhResult: { exitCode: 0, stdout: '', stderr: '' },
    });
    const result = await adapter.performForgeAction(
      forgeActionRequest({
        status: { context: 'premerge', state: 'pending', description: 'waiting for the pre-merge review' },
      }),
    );
    expect(result).toEqual({ outcome: 'executed', headSha: HEAD_SHA });
    expect(calls[0]).toContain('-f');
    expect(calls[0]).toContain('state=pending');
    expect(calls[0]).toContain('description=waiting for the pre-merge review');
  });

  it.each([['findings: 0'], ['findings: 2'], ['findings: 999']])(
    'posts a failure receipt for %s',
    async (description) => {
      const { adapter, calls } = makeAdapter({
        runGhResult: { exitCode: 0, stdout: '', stderr: '' },
      });
      const result = await adapter.performForgeAction(
        forgeActionRequest({
          status: { context: 'premerge', state: 'failure', description },
        }),
      );
      expect(result).toEqual({ outcome: 'executed', headSha: HEAD_SHA });
      expect(calls[0]).toContain(`description=${description}`);
    },
  );

  it('posts a success receipt with the tier-1 not-required description', async () => {
    const { adapter, calls } = makeAdapter({
      runGhResult: { exitCode: 0, stdout: '', stderr: '' },
    });
    const result = await adapter.performForgeAction(
      forgeActionRequest({
        status: { context: 'premerge', state: 'success', description: 'not required for tier 1' },
      }),
    );
    expect(result).toEqual({ outcome: 'executed', headSha: HEAD_SHA });
    expect(calls[0]).toContain('description=not required for tier 1');
  });

  it.each([['findings: 00'], ['findings: 1000'], ['findings: blocker']])(
    'refuses the failure description %s without running gh',
    async (description) => {
      const { adapter, calls, verifier } = makeAdapter({
        runGhResult: { exitCode: 0, stdout: '', stderr: '' },
      });
      const result = await adapter.performForgeAction(
        forgeActionRequest({
          status: { context: 'premerge', state: 'failure', description },
        }),
      );
      expect(result.outcome).toBe('refused');
      expect(result).toHaveProperty('refusalKind', 'other');
      expect(calls).toEqual([]);
      expect(verifier.state.calls).toBe(0);
    },
  );

  it.each([['0123456789ab'], [`${HEAD_SHA}${'0123456789abcdef01234567'}`]])(
    'refuses a non-40-hex expected head sha and never verifies or runs gh',
    async (sha) => {
      const { adapter, calls, verifier } = makeAdapter({
        runGhResult: { exitCode: 0, stdout: '', stderr: '' },
      });
      const result = await adapter.performForgeAction(
        forgeActionRequest({ expectedHeadSha: sha }),
      );
      expect(result.outcome).toBe('refused');
      expect(result).toHaveProperty('refusalKind', 'other');
      expect(calls).toEqual([]);
      expect(verifier.state.calls).toBe(0);
    },
  );

  it('refuses a status on a merge-pr request without running gh', async () => {
    const { adapter, calls, verifier } = makeAdapter({
      runGhResult: { exitCode: 0, stdout: '', stderr: '' },
    });
    const result = await adapter.performForgeAction(
      forgeActionRequest({
        kind: 'merge-pr',
        status: { context: 'premerge', state: 'success', description: 'pre-merge receipt recorded' },
      }),
    );
    if (result.outcome !== 'refused') {
      throw new Error(`expected refusal, got ${result.outcome}`);
    }
    expect(result.reason).toBe('status is only valid for post-status');
    expect(calls).toEqual([]);
    expect(verifier.state.calls).toBe(0);
  });

  it('refuses a post-status request without a status object without running gh', async () => {
    const { adapter, calls, verifier } = makeAdapter({
      runGhResult: { exitCode: 0, stdout: '', stderr: '' },
    });
    const request = forgeActionRequest();
    const withoutStatus: ForgeActionRequest = { ...request, status: undefined };
    const result = await adapter.performForgeAction(withoutStatus);
    expect(result.outcome).toBe('refused');
    expect(calls).toEqual([]);
    expect(verifier.state.calls).toBe(0);
  });

  it.each([
    ['owner a/b', { owner: 'a/b', repo: 'fleet-v2' }],
    ['no repository', null],
  ])('refuses when %s and never runs gh', async (_name, repository) => {
    const { adapter, calls, verifier } = makeAdapter({
      runGhResult: { exitCode: 0, stdout: '', stderr: '' },
      repository,
    });
    const result = await adapter.performForgeAction(forgeActionRequest());
    if (result.outcome !== 'refused') {
      throw new Error(`expected refusal, got ${result.outcome}`);
    }
    expect(calls).toEqual([]);
    expect(verifier.state.calls).toBe(0);
  });

  it('refuses a live head different from the expected head and never runs gh', async () => {
    const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
    const { adapter, calls } = makeAdapter({
      runGhResult: { exitCode: 0, stdout: '', stderr: '' },
      verifyHead: OTHER_SHA,
    });
    const result = await adapter.performForgeAction(forgeActionRequest());
    if (result.outcome !== 'refused') {
      throw new Error(`expected refusal, got ${result.outcome}`);
    }
    expect(result.reason).toContain('Moved head:');
    expect(calls).toEqual([]);
  });

  it('refuses a non-zero exit with the stderr first line and a classified refusal', async () => {
    const { adapter } = makeAdapter({
      runGhResult: { exitCode: 4, stdout: '', stderr: 'HTTP 422: something else\nsecond line\n' },
    });
    const result = await adapter.performForgeAction(forgeActionRequest());
    if (result.outcome !== 'refused') {
      throw new Error(`expected refusal, got ${result.outcome}`);
    }
    expect(result.reason).toBe('gh api statuses failed (exit 4): HTTP 422: something else');
    expect(result).toHaveProperty('refusalKind');
    expect(result.reason).not.toContain('description=');
  });

  it('reports ambiguous when gh throws', async () => {
    const verify = async () => HEAD_SHA;
    const adapter = new ForgeActionAdapter({
      runGh: async () => {
        throw new Error('spawn gone');
      },
      verifyCurrentHeadSha: verify,
      repository: { owner: 'fleet', repo: 'fleet-v2' },
    });
    const result = await adapter.performForgeAction(forgeActionRequest());
    expect(result).toEqual({
      outcome: 'ambiguous',
      reason: 'gh api statuses could not complete: spawn gone',
    });
  });
});
