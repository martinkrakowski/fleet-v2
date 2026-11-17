// delete-branch adapter tests (lane CO11): the sweep's branch deletes.
// The ref is read before any DELETE (an absent branch is already swept), the
// read tip is verified to be an ancestor of main and re-read unchanged before
// the delete is pinned to it, the DELETE's timeout is computed after the
// reads, a non-chain-or-link branch refuses before any gh call, and a
// non-zero DELETE is re-read rather than guessed.

import { describe, expect, it } from 'vitest';

import { ForgeActionAdapter, type GhInvocationResult } from '../ForgeActionAdapter.adapter.js';
import type { MergeForgeDeleteBranchRequest } from '../../../application/ports/out/MergeForgeActionPort.out-port.js';

const NOW = '2026-11-11T12:00:00.000Z';
const DEADLINE = '2026-11-11T13:00:00.000Z';
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

type GhCall = { readonly args: readonly string[]; readonly configDir?: string; readonly timeoutMs?: number };

interface Harness {
  readonly adapter: ForgeActionAdapter;
  readonly calls: GhCall[];
}

function harness(
  respond: (call: GhCall, index: number) => GhInvocationResult | Promise<GhInvocationResult>,
): Harness {
  const calls: GhCall[] = [];
  const adapter = new ForgeActionAdapter(
    {
      nowIso: () => NOW,
      runGh: async (args, configDir, timeoutMs) => {
        const call = { args, configDir, timeoutMs };
        calls.push(call);
        return respond(call, calls.length - 1);
      },
    },
    undefined,
    { mergeGhConfigDir: '/tmp/merger-config' },
  );
  return { adapter, calls };
}

function request(overrides: Partial<MergeForgeDeleteBranchRequest> = {}): MergeForgeDeleteBranchRequest {
  return {
    kind: 'delete-branch',
    actionId: 'chain-sweep/foo@r1/chain',
    repository: { owner: 'acme', repo: 'widgets' },
    branchName: 'chain/foo',
    deadlineIso: DEADLINE,
    ...overrides,
  };
}

function refReadFound(sha: string = SHA): GhInvocationResult {
  return { exitCode: 0, stdout: JSON.stringify({ ref: 'refs/heads/chain/foo', object: { sha } }), stderr: '' };
}

function refReadAbsent(): GhInvocationResult {
  return { exitCode: 1, stdout: '', stderr: 'HTTP 404: Not Found' };
}

function refReadFoundFor(branchName: string, sha: string): GhInvocationResult {
  return { exitCode: 0, stdout: JSON.stringify({ ref: `refs/heads/${branchName}`, object: { sha } }), stderr: '' };
}

function repoReadOk(): GhInvocationResult {
  return { exitCode: 0, stdout: '{"name":"widgets"}', stderr: '' };
}

function compareMerged(status = 'behind'): GhInvocationResult {
  return { exitCode: 0, stdout: JSON.stringify({ status }), stderr: '' };
}

/** The happy path: ref read, compare behind, re-read at the same tip, DELETE. */
function mergedThenDelete(deleteResult: GhInvocationResult = { exitCode: 0, stdout: '', stderr: '' }) {
  return (call: GhCall, index: number): GhInvocationResult => {
    if (index === 0) {
      return refReadFound();
    }
    if (index === 1) {
      return compareMerged();
    }
    if (index === 2) {
      return refReadFound();
    }
    if (index === 3) {
      return deleteResult;
    }
    if (index === 4) {
      return refReadFound();
    }
    return repoReadOk();
  };
}

describe('ForgeActionAdapter delete-branch', () => {
  it('delete-branch of chain/foo sends one DELETE and returns executed', async () => {
    const { adapter, calls } = harness(mergedThenDelete());
    const result = await adapter.performMergeForgeAction(request());
    expect(result).toEqual({ outcome: 'executed', headSha: SHA });
    expect(calls).toHaveLength(4);
    expect(calls[3]!.args).toEqual([
      'api',
      '--method',
      'DELETE',
      'repos/acme/widgets/git/refs/heads/chain/foo',
    ]);
    expect(calls[3]!.configDir).toBe('/tmp/merger-config');
    const argv = calls[3]!.args.join(' ');
    expect(argv).not.toContain('worktree');
    expect(argv).not.toContain('prune');
    expect(argv).not.toContain('--delete-branch');
  });

  it('delete-branch verifies the read tip is an ancestor of main before the delete', async () => {
    const { adapter, calls } = harness(mergedThenDelete());
    await adapter.performMergeForgeAction(request());
    expect(calls[1]!.args).toEqual(['api', 'repos/acme/widgets/compare/main...'.concat(SHA)]);
  });

  it('a branch whose tip is not merged into main is refused before any delete', async () => {
    const { adapter, calls } = harness((call, index) => {
      if (index === 0) {
        return refReadFound();
      }
      if (index === 1) {
        return compareMerged('diverged');
      }
      return repoReadOk();
    });
    const result = await adapter.performMergeForgeAction(request());
    expect(result.outcome).toBe('refused');
    expect(result).toMatchObject({ reason: 'delete-branch deletes only a branch merged into main', refusalKind: 'other' });
    expect(calls.some((call) => call.args.includes('DELETE'))).toBe(false);
  });

  it('a branch that moves after the read is never deleted', async () => {
    const { adapter, calls } = harness((call, index) => {
      if (index === 0) {
        return refReadFound();
      }
      if (index === 1) {
        return compareMerged();
      }
      if (index === 2) {
        return refReadFound(OTHER_SHA);
      }
      return repoReadOk();
    });
    const result = await adapter.performMergeForgeAction(request());
    expect(result.outcome).toBe('refused');
    expect(result).toMatchObject({ reason: 'the branch moved while the delete was prepared' });
    expect(calls.some((call) => call.args.includes('DELETE'))).toBe(false);
  });

  it('a link branch is deleted like a chain branch, at its own ref', async () => {
    const { adapter, calls } = harness((call, index) => {
      if (index === 0 || index === 2) {
        return refReadFoundFor('feature/widget-1', SHA);
      }
      if (index === 1) {
        return compareMerged();
      }
      if (index === 3) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return repoReadOk();
    });
    const result = await adapter.performMergeForgeAction(
      request({ branchName: 'feature/widget-1', actionId: 'chain-sweep/foo@r1/link/0' }),
    );
    expect(result).toEqual({ outcome: 'executed', headSha: SHA });
    expect(calls[3]!.args).toEqual([
      'api',
      '--method',
      'DELETE',
      'repos/acme/widgets/git/refs/heads/feature/widget-1',
    ]);
  });

  it('delete-branch of an already-absent chain branch returns branch-gone and does not DELETE', async () => {
    const { adapter, calls } = harness((call, index) => (index === 0 ? refReadAbsent() : repoReadOk()));
    const result = await adapter.performMergeForgeAction(request());
    expect(result).toEqual({ outcome: 'branch-gone' });
    expect(calls).toHaveLength(2);
    expect(calls.some((call) => call.args.includes('DELETE'))).toBe(false);
  });

  it('delete-branch refuses main and does not call gh', async () => {
    const { adapter, calls } = harness(() => refReadFound());
    const result = await adapter.performMergeForgeAction(request({ branchName: 'main' }));
    expect(result.outcome).toBe('refused');
    expect(result).toMatchObject({ refusalKind: 'other' });
    expect(calls).toHaveLength(0);
  });

  it('delete-branch refuses release/1 and does not call gh', async () => {
    const { adapter, calls } = harness(() => refReadFound());
    const result = await adapter.performMergeForgeAction(request({ branchName: 'release/1' }));
    expect(result.outcome).toBe('refused');
    expect(calls).toHaveLength(0);
  });

  it('delete-branch refuses a request that carries a pull request number', async () => {
    const { adapter, calls } = harness(() => refReadFound());
    const result = await adapter.performMergeForgeAction(request({ ...( { pullRequestNumber: 7 } as unknown as Partial<MergeForgeDeleteBranchRequest>) }));
    expect(result.outcome).toBe('refused');
    expect(calls).toHaveLength(0);
  });

  it('delete-branch with no merger identity refuses before gh', async () => {
    const adapter = new ForgeActionAdapter({ nowIso: () => NOW, runGh: async () => refReadFound() });
    const result = await adapter.performMergeForgeAction(request());
    const typed = result as { outcome: string; refusalKind?: string };
    expect(typed.outcome).toBe('refused');
    expect(typed.refusalKind).toBe('other');
  });

  it('delete-branch with a past deadline refuses before gh', async () => {
    const calls: GhCall[] = [];
    const adapter = new ForgeActionAdapter(
      {
        nowIso: () => '2026-11-11T14:00:00.000Z',
        runGh: async (args, configDir, timeoutMs) => {
          calls.push({ args, configDir, timeoutMs });
          return refReadFound();
        },
      },
      undefined,
      { mergeGhConfigDir: '/tmp/merger-config' },
    );
    const result = await adapter.performMergeForgeAction(request());
    expect(result.outcome).toBe('refused');
    expect(result).toMatchObject({ reason: 'budget-exhausted', refusalKind: 'other' });
    expect(calls).toHaveLength(0);
  });

  it('a non-zero DELETE that leaves the branch present is refused', async () => {
    const { adapter } = harness(mergedThenDelete({ exitCode: 1, stdout: '', stderr: 'HTTP 422: something else' }));
    const result = await adapter.performMergeForgeAction(request());
    expect(result.outcome).toBe('refused');
    expect(result).toMatchObject({ reason: 'gh api delete-branch failed', refusalKind: 'other' });
  });

  it('a non-zero DELETE whose re-read is not-found returns branch-gone', async () => {
    const { adapter } = harness((call, index) => {
      if (index === 0 || index === 2) {
        return refReadFound();
      }
      if (index === 1) {
        return compareMerged();
      }
      if (index === 3) {
        return { exitCode: 1, stdout: '', stderr: 'HTTP 422: something else' };
      }
      if (index === 4) {
        return refReadAbsent();
      }
      return repoReadOk();
    });
    const result = await adapter.performMergeForgeAction(request());
    expect(result).toEqual({ outcome: 'branch-gone' });
  });
});
