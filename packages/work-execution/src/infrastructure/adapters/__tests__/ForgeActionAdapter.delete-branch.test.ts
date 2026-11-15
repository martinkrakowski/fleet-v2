// delete-branch adapter tests (lane CO11): the sweep's one branch delete.
// The ref is read before any DELETE (an absent branch is already swept), the
// argv is exactly the git-refs DELETE, a non-chain branch refuses before any
// gh call, and a non-zero DELETE is re-read rather than guessed.

import { describe, expect, it } from 'vitest';

import { ForgeActionAdapter, type GhInvocationResult } from '../ForgeActionAdapter.adapter.js';
import type { MergeForgeDeleteBranchRequest } from '../../../application/ports/out/MergeForgeActionPort.out-port.js';

const NOW = '2026-11-11T12:00:00.000Z';
const DEADLINE = '2026-11-11T13:00:00.000Z';
const SHA = 'a'.repeat(40);

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

function refReadFound(): GhInvocationResult {
  return { exitCode: 0, stdout: JSON.stringify({ ref: 'refs/heads/chain/foo', object: { sha: SHA } }), stderr: '' };
}

function refReadAbsent(): GhInvocationResult {
  return { exitCode: 1, stdout: '', stderr: 'HTTP 404: Not Found' };
}

function repoReadOk(): GhInvocationResult {
  return { exitCode: 0, stdout: '{"name":"widgets"}', stderr: '' };
}

describe('ForgeActionAdapter delete-branch', () => {
  it('delete-branch of chain/foo sends one DELETE and returns executed', async () => {
    const { adapter, calls } = harness((call, index) => (index === 0 ? refReadFound() : { exitCode: 0, stdout: '', stderr: '' }));
    const result = await adapter.performMergeForgeAction(request());
    expect(result).toEqual({ outcome: 'executed', headSha: SHA });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args).toEqual([
      'api',
      '--method',
      'DELETE',
      'repos/acme/widgets/git/refs/heads/chain/foo',
    ]);
    expect(calls[1]!.configDir).toBe('/tmp/merger-config');
    const argv = calls[1]!.args.join(' ');
    expect(argv).not.toContain('worktree');
    expect(argv).not.toContain('prune');
    expect(argv).not.toContain('--delete-branch');
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
    expect(result.outcome).toBe('refused');
    expect(result).toMatchObject({ refusalKind: 'other' });
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
    const { adapter } = harness((call, index) => {
      if (index === 0) {
        return refReadFound();
      }
      if (index === 1) {
        return { exitCode: 1, stdout: '', stderr: 'HTTP 422: something else' };
      }
      return refReadFound();
    });
    const result = await adapter.performMergeForgeAction(request());
    expect(result.outcome).toBe('refused');
    expect(result).toMatchObject({ reason: 'gh api delete-branch failed', refusalKind: 'other' });
  });

  it('a non-zero DELETE whose re-read is not-found returns branch-gone', async () => {
    const { adapter } = harness((call, index) => {
      if (index === 0) {
        return refReadFound();
      }
      if (index === 1) {
        return { exitCode: 1, stdout: '', stderr: 'HTTP 422: something else' };
      }
      if (index === 2) {
        return refReadAbsent();
      }
      return repoReadOk();
    });
    const result = await adapter.performMergeForgeAction(request());
    expect(result).toEqual({ outcome: 'branch-gone' });
  });
});
