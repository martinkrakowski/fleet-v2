// Chain refresh daemon job tests (lane CO8): the registry registers one
// chain-refresh job per repository when the refresh use case dependency is
// present, none when it is absent, and the job runs the use case within the
// tick deadline, mapping the result to a DaemonJobOutcome.

import { describe, expect, it } from 'vitest';

import { DaemonJobRegistry } from '../RunDaemonTickUseCase.use-case.js';
import type { DaemonRepositoryRef } from '../../ports/in/RunDaemonTickPort.in-port.js';
import type { RefreshChainsCommand, RefreshChainsPort, RefreshChainsResult } from '../../ports/in/RefreshChainsPort.in-port.js';
import type {
  ChainAttentionCommand,
  ChainAttentionPort,
  RaiseChainAttentionResult,
} from '../../ports/out/ChainAttentionPort.out-port.js';
import type { MergeRepoPolicy } from '../../../domain/merge-queue-decider.js';

const DIGEST_A = '00000000000a';
const DIGEST_B = '00000000000b';
const NOW = '2026-11-01T12:00:00.000Z';
const DEADLINE = '2026-11-01T12:00:45.000Z';

function mergePolicy(): MergeRepoPolicy {
  return {
    policyRevision: 'rev-1',
    shadow: true,
    unattended: true,
    updateBranch: false,
    veto: { mode: 'off' },
  };
}

function repoRef(digest: string, overrides: Partial<DaemonRepositoryRef> = {}): DaemonRepositoryRef {
  return {
    owner: 'fleet',
    repo: `v2-${digest.slice(-1)}`,
    repoDigest: digest,
    projectId: 'proj-1',
    policy: mergePolicy(),
    ...overrides,
  };
}

class FakeRefresh implements RefreshChainsPort {
  readonly requests: RefreshChainsCommand[] = [];
  result: RefreshChainsResult = { outcome: 'completed', reasonCode: null, chains: [] };

  async runRefreshChains(command: RefreshChainsCommand): Promise<RefreshChainsResult> {
    this.requests.push(command);
    return this.result;
  }
}

class FakeAttention implements Pick<ChainAttentionPort, 'raiseChainAttention'> {
  readonly raises: ChainAttentionCommand[] = [];
  result: RaiseChainAttentionResult = { outcome: 'raised', reasonCode: null };
  throwOnRaise = false;

  async raiseChainAttention(command: ChainAttentionCommand): Promise<RaiseChainAttentionResult> {
    this.raises.push(command);
    if (this.throwOnRaise) {
      throw new Error('attention store exploded');
    }
    return this.result;
  }
}

describe('DaemonJobRegistry chain-refresh', () => {
  it('the registry registers one chain-refresh job per repository with its lease scope', () => {
    const registry = new DaemonJobRegistry({ mergePass: {} as never, chainRefresh: new FakeRefresh() });
    const jobs = registry.instances([repoRef(DIGEST_A), repoRef(DIGEST_B)]);
    expect(jobs.map((job) => job.jobId)).toEqual([
      `merge-pass:${DIGEST_A}`,
      `merge-pass:${DIGEST_B}`,
      `chain-refresh:${DIGEST_A}`,
      `chain-refresh:${DIGEST_B}`,
    ]);
    expect(jobs[2]!.leaseScope).toBe(`chain-refresh/${DIGEST_A}`);
    expect(jobs[3]!.leaseScope).toBe(`chain-refresh/${DIGEST_B}`);
  });

  it('the chain-refresh job runs the refresh use case within the tick deadline', async () => {
    const refresh = new FakeRefresh();
    refresh.result = { outcome: 'completed', reasonCode: null, chains: [{ chainName: 'one', key: 'chain-refresh/one@aaaaaaaaaaaa', outcome: 'merged' }] };
    const registry = new DaemonJobRegistry({ mergePass: {} as never, chainRefresh: refresh });
    const jobs = registry.instances([repoRef(DIGEST_A)]);
    const refreshJob = jobs.find((job) => job.jobId === `chain-refresh:${DIGEST_A}`);
    expect(refreshJob).toBeDefined();
    const outcome = await refreshJob!.pass({ nowIso: NOW, deadlineIso: DEADLINE });
    expect(outcome).toEqual({ outcome: 'completed', progressed: true });
    expect(refresh.requests).toHaveLength(1);
    expect(refresh.requests[0]).toEqual({
      repository: { owner: 'fleet', repo: 'v2-a' },
      projectId: 'proj-1',
      nowIso: NOW,
      deadlineIso: DEADLINE,
    });
  });

  it('maps a skipped and a refused result to their outcomes', async () => {
    const skippedRefresh = new FakeRefresh();
    skippedRefresh.result = { outcome: 'skipped', reasonCode: 'main-unreadable', chains: [] };
    const registry = new DaemonJobRegistry({ mergePass: {} as never, chainRefresh: skippedRefresh });
    const jobs = registry.instances([repoRef(DIGEST_A)]);
    expect(await jobs[1]!.pass({ nowIso: NOW, deadlineIso: DEADLINE })).toEqual({
      outcome: 'skipped',
      reasonCode: 'main-unreadable',
    });

    const refusedRefresh = new FakeRefresh();
    refusedRefresh.result = { outcome: 'refused', reasonCode: 'invalid-request', chains: [] };
    const registry2 = new DaemonJobRegistry({ mergePass: {} as never, chainRefresh: refusedRefresh });
    const jobs2 = registry2.instances([repoRef(DIGEST_A)]);
    expect(await jobs2[1]!.pass({ nowIso: NOW, deadlineIso: DEADLINE })).toEqual({
      outcome: 'refused',
      reasonCode: 'invalid-request',
    });
  });

  it('the registry registers no chain-refresh job when the dependency is absent', () => {
    const registry = new DaemonJobRegistry({ mergePass: {} as never });
    const jobs = registry.instances([repoRef(DIGEST_A)]);
    expect(jobs.map((job) => job.jobId)).toEqual([`merge-pass:${DIGEST_A}`]);
  });
});

describe('DaemonJobRegistry chain-refresh invalid mode (CO8a)', () => {
  it('the registry registers one skipped invalid job per repository with its lease scope', () => {
    const attention = new FakeAttention();
    const registry = new DaemonJobRegistry({
      mergePass: {} as never,
      chainRefreshMode: 'invalid',
      chainAttention: attention,
    });
    const jobs = registry.instances([repoRef(DIGEST_A), repoRef(DIGEST_B)]);
    expect(jobs.map((job) => job.jobId)).toEqual([
      `merge-pass:${DIGEST_A}`,
      `merge-pass:${DIGEST_B}`,
      `chain-refresh:${DIGEST_A}`,
      `chain-refresh:${DIGEST_B}`,
    ]);
    expect(jobs[2]!.leaseScope).toBe(`chain-refresh/${DIGEST_A}`);
  });

  it('the invalid job raises exactly one policy-level attention item and is skipped with chain-refresh-mode-invalid', async () => {
    const attention = new FakeAttention();
    const registry = new DaemonJobRegistry({
      mergePass: {} as never,
      chainRefreshMode: 'invalid',
      chainAttention: attention,
    });
    const jobs = registry.instances([repoRef(DIGEST_A)]);
    const refreshJob = jobs.find((job) => job.jobId === `chain-refresh:${DIGEST_A}`);
    expect(refreshJob).toBeDefined();
    const outcome = await refreshJob!.pass({ nowIso: NOW, deadlineIso: DEADLINE });
    expect(outcome).toEqual({ outcome: 'skipped', reasonCode: 'chain-refresh-mode-invalid' });
    expect(attention.raises).toEqual([
      {
        projectId: 'proj-1',
        repository: { owner: 'fleet', repo: 'v2-a' },
        kind: 'chain-refresh-mode-invalid',
      },
    ]);
  });

  it('a repeat of the invalid job refreshes the same attention item (never duplicates)', async () => {
    const attention = new FakeAttention();
    const registry = new DaemonJobRegistry({
      mergePass: {} as never,
      chainRefreshMode: 'invalid',
      chainAttention: attention,
    });
    const jobs = registry.instances([repoRef(DIGEST_A)]);
    const refreshJob = jobs.find((job) => job.jobId === `chain-refresh:${DIGEST_A}`);
    expect(refreshJob).toBeDefined();
    await refreshJob!.pass({ nowIso: NOW, deadlineIso: DEADLINE });
    await refreshJob!.pass({ nowIso: NOW, deadlineIso: DEADLINE });
    // The same key both times: the store refreshes one item, never a duplicate.
    expect(attention.raises).toHaveLength(2);
    expect(attention.raises[0]).toEqual(attention.raises[1]);
  });

  it('the invalid job refuses when the attention store refuses the raise', async () => {
    const attention = new FakeAttention();
    attention.result = { outcome: 'refused', reasonCode: 'store-unreadable' };
    const registry = new DaemonJobRegistry({
      mergePass: {} as never,
      chainRefreshMode: 'invalid',
      chainAttention: attention,
    });
    const jobs = registry.instances([repoRef(DIGEST_A)]);
    const refreshJob = jobs.find((job) => job.jobId === `chain-refresh:${DIGEST_A}`);
    expect(refreshJob).toBeDefined();
    const outcome = await refreshJob!.pass({ nowIso: NOW, deadlineIso: DEADLINE });
    expect(outcome).toEqual({ outcome: 'refused', reasonCode: 'chain-refresh-attention-refused' });
    expect(attention.raises).toHaveLength(1);
  });

  it('the invalid job refuses when the attention raise throws', async () => {
    const attention = new FakeAttention();
    attention.throwOnRaise = true;
    const registry = new DaemonJobRegistry({
      mergePass: {} as never,
      chainRefreshMode: 'invalid',
      chainAttention: attention,
    });
    const jobs = registry.instances([repoRef(DIGEST_A)]);
    const refreshJob = jobs.find((job) => job.jobId === `chain-refresh:${DIGEST_A}`);
    expect(refreshJob).toBeDefined();
    const outcome = await refreshJob!.pass({ nowIso: NOW, deadlineIso: DEADLINE });
    expect(outcome).toEqual({ outcome: 'refused', reasonCode: 'chain-refresh-attention-failed' });
    expect(attention.raises).toHaveLength(1);
  });

  it('the invalid job refuses when no attention store is wired', async () => {
    const registry = new DaemonJobRegistry({
      mergePass: {} as never,
      chainRefreshMode: 'invalid',
    });
    const jobs = registry.instances([repoRef(DIGEST_A)]);
    const refreshJob = jobs.find((job) => job.jobId === `chain-refresh:${DIGEST_A}`);
    expect(refreshJob).toBeDefined();
    const outcome = await refreshJob!.pass({ nowIso: NOW, deadlineIso: DEADLINE });
    expect(outcome).toEqual({ outcome: 'refused', reasonCode: 'chain-refresh-attention-unavailable' });
  });
});
