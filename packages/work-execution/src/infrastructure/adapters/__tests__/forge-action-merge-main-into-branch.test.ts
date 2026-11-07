// ForgeActionAdapter merge-main-into-branch tests (lane CO8): the adapter
// merges main into a chain/<name> branch through the forge merge API, reports
// an already up to date branch as already-applied, a conflict as a refusal of
// kind conflict, a missing branch as branch-gone, and refuses anything that is
// not a chain branch. Every delegate is injected; nothing writes to a forge.

import { describe, expect, it } from 'vitest';

import { ForgeActionAdapter } from '../ForgeActionAdapter.adapter.js';
import type { MergeForgeActionRequest } from '../../../application/ports/out/MergeForgeActionPort.out-port.js';

const MAIN_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const OWNER = 'fleet';
const REPO = 'fleet-v2';
const BRANCH = 'chain/example';
const MERGE_DIR = '/state/gh/merge';
const DEADLINE_ISO = '2026-11-01T12:00:10.000Z';
const KEY = `chain-refresh/example@${MAIN_SHA.slice(0, 12)}`;

type GhAnswer = { exitCode: number; stdout: string; stderr: string } | { throw: true };

const OK_MERGE = { exitCode: 0, stdout: JSON.stringify({ sha: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` }), stderr: '' };
const NO_BODY = { exitCode: 0, stdout: '', stderr: '' };
const CONFLICT = { exitCode: 1, stdout: '', stderr: 'gh: Merge conflict (HTTP 409)' };
const MISSING = { exitCode: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };
const BAD_GATEWAY = { exitCode: 1, stdout: '', stderr: 'gh: Bad gateway (HTTP 502)' };
const REF_OK = { exitCode: 0, stdout: JSON.stringify({ ref: `refs/heads/${BRANCH}`, object: { sha: MAIN_SHA } }), stderr: '' };
const REPO_OK = { exitCode: 0, stdout: '{}', stderr: '' };

interface MergeRequestOverrides {
  branchName?: unknown;
  sourceBranch?: unknown;
  expectedHeadSha?: unknown;
  repository?: unknown;
  actionId?: unknown;
  deadlineIso?: unknown;
  pullRequestNumber?: unknown;
  status?: unknown;
  [key: string]: unknown;
}

function mergeRequest(overrides: MergeRequestOverrides = {}): MergeForgeActionRequest {
  return {
    kind: 'merge-main-into-branch',
    actionId: KEY,
    repository: { owner: OWNER, repo: REPO },
    branchName: BRANCH,
    sourceBranch: 'main',
    expectedHeadSha: MAIN_SHA,
    deadlineIso: DEADLINE_ISO,
    ...overrides,
  } as unknown as MergeForgeActionRequest;
}

function makeAdapter(script: { merges?: GhAnswer; refs?: GhAnswer; repoProbe?: GhAnswer; nowIso?: string } = {}) {
  const calls: { args: string[]; ghConfigDir?: string; timeoutMs?: number }[] = [];
  const runGh = async (args: readonly string[], ghConfigDir?: string, timeoutMs?: number) => {
    calls.push({ args: [...args], ghConfigDir, timeoutMs });
    const joined = args.join(' ');
    let answer: GhAnswer;
    if (joined.includes('/merges')) answer = script.merges ?? OK_MERGE;
    else if (joined.includes('/git/ref/heads/')) answer = script.refs ?? REF_OK;
    else if (joined.includes(`repos/${OWNER}/${REPO}`)) answer = script.repoProbe ?? REPO_OK;
    else answer = script.merges ?? OK_MERGE;
    if ('throw' in answer) {
      throw new Error('gh subprocess timed out');
    }
    return answer;
  };
  const adapter = new ForgeActionAdapter(
    { runGh, nowIso: () => script.nowIso ?? '2026-11-01T12:00:00.000Z' },
    undefined,
    { mergeGhConfigDir: MERGE_DIR },
  );
  return { adapter, calls };
}

describe('ForgeActionAdapter merge-main-into-branch (lane CO8)', () => {
  it('merges main into a chain branch through the forge merge API', async () => {
    const { adapter, calls } = makeAdapter({ merges: OK_MERGE });
    const result = await adapter.performMergeForgeAction(mergeRequest());
    expect(result).toEqual({ outcome: 'executed', headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual([
      'api', '--method', 'POST', `repos/${OWNER}/${REPO}/merges`,
      '-f', `base=${BRANCH}`, '-f', 'head=main',
    ]);
    expect(calls[0]!.ghConfigDir).toBe(MERGE_DIR);
    expect(calls[0]!.timeoutMs).toBeLessThanOrEqual(30_000);
  });

  it('reports an already up to date branch as already applied', async () => {
    const { adapter, calls } = makeAdapter({ merges: NO_BODY });
    expect(await adapter.performMergeForgeAction(mergeRequest())).toEqual({ outcome: 'already-applied' });
    expect(calls).toHaveLength(1);
  });

  it('reports a conflict as a refusal of kind conflict', async () => {
    const { adapter, calls } = makeAdapter({ merges: CONFLICT });
    const result = await adapter.performMergeForgeAction(mergeRequest());
    expect(result).toEqual({ outcome: 'refused', reason: 'merge into the chain branch conflicts with main', refusalKind: 'conflict' });
    expect(calls).toHaveLength(1);
  });

  it('reports a missing chain branch as branch-gone and an unreadable branch as unknown', async () => {
    const gone = makeAdapter({ merges: MISSING, refs: MISSING, repoProbe: REPO_OK });
    expect(await gone.adapter.performMergeForgeAction(mergeRequest())).toEqual({ outcome: 'branch-gone' });
    expect(gone.calls).toHaveLength(3);

    const unknown = makeAdapter({ merges: MISSING, refs: MISSING, repoProbe: BAD_GATEWAY });
    expect((await unknown.adapter.performMergeForgeAction(mergeRequest())).outcome).toBe('ambiguous');
  });

  it('refuses to merge into a branch that is not a chain branch', async () => {
    for (const branchName of ['main', 'feat/x', 'chain/Bad', 'chain/a/b']) {
      const { adapter, calls } = makeAdapter();
      const result = await adapter.performMergeForgeAction(mergeRequest({ branchName }));
      expect(result.outcome).toBe('refused');
      expect(calls).toHaveLength(0);
      if (branchName !== 'main') {
        expect(JSON.stringify(result)).not.toContain(String(branchName));
      }
    }
  });

  it('readMergeBranchHead is widened to accept main as well as chain branches', async () => {
    const mainRef = { exitCode: 0, stdout: JSON.stringify({ ref: 'refs/heads/main', object: { sha: MAIN_SHA } }), stderr: '' };
    const { adapter, calls } = makeAdapter({ refs: mainRef });
    const result = await adapter.readMergeBranchHead({
      repository: { owner: OWNER, repo: REPO },
      branchName: 'main',
      deadlineIso: DEADLINE_ISO,
    });
    expect(result).toEqual({ outcome: 'found', headSha: MAIN_SHA });
    expect(calls).toHaveLength(1);
  });

  it('is ambiguous when the delegate throws, with no input echoed', async () => {
    const { adapter } = makeAdapter({ merges: { throw: true } });
    expect(await adapter.performMergeForgeAction(mergeRequest())).toEqual({
      outcome: 'ambiguous',
      reason: 'gh api merge-main-into-branch could not complete',
    });
  });

  it('refuses invalid requests before any gh call', async () => {
    const bad: MergeRequestOverrides[] = [
      { sourceBranch: 'develop' },
      { expectedHeadSha: 'abc' },
      { expectedHeadSha: MAIN_SHA.toUpperCase() },
      { repository: { owner: '..', repo: REPO } },
      { repository: null },
      { deadlineIso: 'tomorrow' },
      { actionId: '' },
      { pullRequestNumber: 5 },
      { status: { context: 'premerge', state: 'success', description: 'x' } },
    ];
    for (const overrides of bad) {
      const { adapter, calls } = makeAdapter();
      expect((await adapter.performMergeForgeAction(mergeRequest(overrides))).outcome).toBe('refused');
      expect(calls).toHaveLength(0);
    }
  });

  it('refuses to start with under two seconds of budget left', async () => {
    const { adapter, calls } = makeAdapter();
    const result = await adapter.performMergeForgeAction(mergeRequest({ deadlineIso: '2026-11-01T12:00:01.000Z' }));
    expect(result).toEqual({ outcome: 'refused', reason: 'budget-exhausted', refusalKind: 'other' });
    expect(calls).toHaveLength(0);
  });
});
