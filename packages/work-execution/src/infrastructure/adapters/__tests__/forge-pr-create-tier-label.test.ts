// Forge action adapter tests for the conducted-open tier label (CP1B): a
// valid `tier:1` / `tier:2` label is placed once, immediately after `--label`
// on the existing `gh pr create` argv; an invalid label refuses before `gh`
// runs; and a missing label creates without one.

import { describe, expect, it } from 'vitest';

import { ForgeActionAdapter } from '../ForgeActionAdapter.adapter.js';
import type { ForgeActionRequest } from '../../../application/ports/out/ForgeActionPort.out-port.js';

const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';
const TITLE = 'My explicit title';

function prCreateRequest(
  overrides: Partial<ForgeActionRequest> = {},
): ForgeActionRequest {
  return {
    actionId: 'action-1',
    attemptId: 'attempt-1',
    workOrderId: 'wo-1',
    kind: 'push-and-open-pr',
    expectedHeadSha: HEAD_SHA,
    branchName: 'feat/wk-p4-pr-create',
    title: TITLE,
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

function makeVerifier(head: string) {
  const state = { calls: 0 };
  const verify = async () => {
    state.calls += 1;
    return head;
  };
  return { state, verify };
}

describe('ForgeActionAdapter runPrCreate tier label (CP1B)', () => {
  it('puts --label tier:1 once on gh pr create and keeps the given title', async () => {
    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: '/pull/7', stderr: '' });
    const adapter = new ForgeActionAdapter({
      runGh,
      verifyCurrentHeadSha: makeVerifier(HEAD_SHA).verify,
    });

    const result = await adapter.performForgeAction(
      prCreateRequest({ tierLabel: 'tier:1' }),
    );

    expect(result.outcome).toBe('executed');
    expect(calls).toHaveLength(1);
    const args = calls[0]!;
    const labelIdx = args.indexOf('--label');
    expect(labelIdx).toBeGreaterThan(-1);
    expect(args[labelIdx + 1]).toBe('tier:1');
    expect(args.filter((a) => a === '--label')).toHaveLength(1);
    expect(args).not.toContain('tier:2');
    expect(args).toContain(TITLE);
  });

  it('puts --label tier:2 once on gh pr create', async () => {
    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: '/pull/7', stderr: '' });
    const adapter = new ForgeActionAdapter({
      runGh,
      verifyCurrentHeadSha: makeVerifier(HEAD_SHA).verify,
    });

    const result = await adapter.performForgeAction(
      prCreateRequest({ tierLabel: 'tier:2' }),
    );

    expect(result.outcome).toBe('executed');
    expect(calls).toHaveLength(1);
    const args = calls[0]!;
    const labelIdx = args.indexOf('--label');
    expect(labelIdx).toBeGreaterThan(-1);
    expect(args[labelIdx + 1]).toBe('tier:2');
    expect(args.filter((a) => a === '--label')).toHaveLength(1);
    expect(args).not.toContain('tier:1');
    expect(args).toContain(TITLE);
  });

  it('refuses an invalid tierLabel and does not call gh', async () => {
    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: '/pull/7', stderr: '' });
    const adapter = new ForgeActionAdapter({
      runGh,
      verifyCurrentHeadSha: makeVerifier(HEAD_SHA).verify,
    });

    const result = await adapter.performForgeAction(
      prCreateRequest({ tierLabel: 'tier:0' as unknown as 'tier:1' | 'tier:2' }),
    );

    expect(result).toEqual({
      outcome: 'refused',
      refusalKind: 'other',
      reason: 'tierLabel must be tier:1 or tier:2',
    });
    expect(calls).toHaveLength(0);
  });

  it('creates without a label when tierLabel is absent', async () => {
    const { calls, runGh } = makeRunGh({ exitCode: 0, stdout: '/pull/7', stderr: '' });
    const adapter = new ForgeActionAdapter({
      runGh,
      verifyCurrentHeadSha: makeVerifier(HEAD_SHA).verify,
    });

    const result = await adapter.performForgeAction(prCreateRequest());

    expect(result.outcome).toBe('executed');
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain('--label');
  });

  it('reports a non-zero gh exit as refused when a tier label was requested', async () => {
    const { calls, runGh } = makeRunGh({
      exitCode: 1,
      stdout: '',
      stderr: 'something went wrong\n',
    });
    const adapter = new ForgeActionAdapter({
      runGh,
      verifyCurrentHeadSha: makeVerifier(HEAD_SHA).verify,
    });

    const result = await adapter.performForgeAction(
      prCreateRequest({ tierLabel: 'tier:1' }),
    );

    expect(result.outcome).toBe('refused');
    expect(result).not.toHaveProperty('pullRequestNumber');
    expect(calls).toHaveLength(1);
  });

  it('reports a thrown gh invocation as ambiguous when a tier label was requested', async () => {
    const runGh = async () => {
      throw new Error('gh exploded');
    };
    const adapter = new ForgeActionAdapter({
      runGh,
      verifyCurrentHeadSha: makeVerifier(HEAD_SHA).verify,
    });

    const result = await adapter.performForgeAction(
      prCreateRequest({ tierLabel: 'tier:1' }),
    );

    expect(result.outcome).toBe('ambiguous');
  });
});
