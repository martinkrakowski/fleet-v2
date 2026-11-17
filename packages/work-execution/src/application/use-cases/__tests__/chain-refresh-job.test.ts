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

describe('DaemonJobRegistry chain-refresh under an operator halt', () => {
  const HALTED = { state: 'halted', record: { version: 1, halted: true, changedAtIso: NOW } } as const;
  const haltedRefusal: RefreshChainsResult = { outcome: 'refused', reasonCode: 'halted', chains: [] };

  async function haltedJob(result: RefreshChainsResult, halt?: { readonly answer: unknown }) {
    let reads = 0;
    const read = async () => {
      reads += 1;
      if (halt?.answer instanceof Error) throw halt.answer;
      return halt?.answer;
    };
    const refresh = new FakeRefresh();
    refresh.result = result;
    const registry = new DaemonJobRegistry({
      mergePass: {} as never,
      chainRefresh: refresh,
      ...(halt === undefined ? {} : { halt: { read } as never }),
    });
    const outcome = await registry.instances([repoRef(DIGEST_A)])[1]!.pass({ nowIso: NOW, deadlineIso: DEADLINE });
    return { outcome, reads };
  }

  it('a halted refusal with a confirmed operator halt is skipped as halted', async () => {
    const { outcome, reads } = await haltedJob(haltedRefusal, { answer: HALTED });
    expect(outcome).toEqual({ outcome: 'skipped', reasonCode: 'halted' });
    expect(reads).toBe(1);
  });

  it('chains settled before a mid-pass halt are counted in the reason code', async () => {
    const result: RefreshChainsResult = {
      outcome: 'refused',
      reasonCode: 'halted',
      chains: [
        { chainName: 'a', key: 'k', outcome: 'merged' },
        { chainName: 'b', key: 'k', outcome: 'up-to-date' },
        { chainName: 'c', key: 'k', outcome: 'skipped' },
      ],
    };
    const { outcome, reads } = await haltedJob(result, { answer: HALTED });
    expect(outcome).toEqual({ outcome: 'skipped', reasonCode: 'halted-after-2' });
    expect(reads).toBe(1);
  });

  it.each([
    ['unreadable', { state: 'unreadable' }],
    ['clear', { state: 'clear', record: null }],
    ['a malformed record', { state: 'halted', record: { halted: true } }],
    ['halted: false', { state: 'halted', record: { version: 1, halted: false, changedAtIso: NOW } }],
    ['null', null],
    ['an array', []],
    ['a throw', new Error('read failed')],
  ] as readonly [string, unknown][])('a halted refusal stays refused when the halt read is %s', async (_label, answer) => {
    const { outcome, reads } = await haltedJob(haltedRefusal, { answer });
    expect(outcome).toEqual({ outcome: 'refused', reasonCode: 'halted' });
    expect(reads).toBe(1);
  });

  it('a halted refusal stays refused when the registry has no halt', async () => {
    const { outcome, reads } = await haltedJob(haltedRefusal);
    expect(outcome).toEqual({ outcome: 'refused', reasonCode: 'halted' });
    expect(reads).toBe(0);
  });

  it('a halted refusal whose chains is not an array is refused as malformed', async () => {
    const { outcome } = await haltedJob(
      { outcome: 'refused', reasonCode: 'halted', chains: 'x' as never },
      { answer: HALTED },
    );
    expect(outcome).toEqual({ outcome: 'refused', reasonCode: 'chain-refresh-malformed' });
  });

  it.each([
    ['invalid-request', 'invalid-request'],
    ['halted-ish', 'halted-ish'],
    [7, 'job-failed'],
  ] as readonly [string, unknown][])('every other refusal reason stays refused and never reads the halt', async (given, expected) => {
    const { outcome, reads } = await haltedJob(
      { outcome: 'refused', reasonCode: given as never, chains: [] },
      { answer: HALTED },
    );
    expect(outcome).toEqual({ outcome: 'refused', reasonCode: expected });
    expect(reads).toBe(0);
  });

  it('a completed or skipped result never reads the halt', async () => {
    const completed = await haltedJob({ outcome: 'completed', reasonCode: null, chains: [] }, { answer: HALTED });
    expect(completed.outcome).toEqual({ outcome: 'completed', progressed: false });
    expect(completed.reads).toBe(0);
    const skipped = await haltedJob(
      { outcome: 'skipped', reasonCode: 'main-unreadable', chains: [] },
      { answer: HALTED },
    );
    expect(skipped.outcome).toEqual({ outcome: 'skipped', reasonCode: 'main-unreadable' });
    expect(skipped.reads).toBe(0);
  });

  it('a conflict and a branch-gone chain count as settled, an unknown chain outcome does not', async () => {
    const { outcome } = await haltedJob(
      {
        outcome: 'refused',
        reasonCode: 'halted',
        chains: [
          { chainName: 'a', key: 'k', outcome: 'conflict' },
          { chainName: 'b', key: 'k', outcome: 'branch-gone' },
          { chainName: 'c', key: 'k', outcome: 'weird' },
          null,
        ] as never,
      },
      { answer: HALTED },
    );
    expect(outcome).toEqual({ outcome: 'skipped', reasonCode: 'halted-after-2' });
  });
});
