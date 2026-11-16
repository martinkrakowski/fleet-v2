// OG-15: the chain operations gate on the conductor halt, fail closed.
import { describe, expect, it } from 'vitest';

import { RefreshChainsUseCase } from '../RefreshChainsUseCase.use-case.js';
import { StartChainUseCase } from '../StartChainUseCase.use-case.js';
import { SweepChainsUseCase } from '../SweepChainsUseCase.use-case.js';
import type { ChainRecordDecision, ChainRecordRead, ChainRepositoryPort } from '../../ports/out/ChainRepositoryPort.out-port.js';
import type { ChainAttentionPort } from '../../ports/out/ChainAttentionPort.out-port.js';
import type { ConductorHaltPort } from '../../ports/out/ConductorHaltPort.out-port.js';
import type { ConductorHaltState } from '../../../domain/conductor-halt.js';
import type { MergeBranchHeadResult, MergeForgeActionPort, MergeForgeActionResult } from '../../ports/out/MergeForgeActionPort.out-port.js';
import type { ChainRecord } from '../../../domain/chain-records.js';

const OWNER = 'fleet';
const REPO = 'v2';
const PROJECT = 'proj-1';
const NOW = '2026-11-01T12:00:00.000Z';
const DEADLINE = '2026-11-01T12:10:00.000Z';
const HEAD = '0123456789abcdef0123456789abcdef01234567';

const haltedState = {
  state: 'halted',
  record: { version: 1, halted: true, changedAtIso: NOW },
} as unknown as ConductorHaltState;

type HaltAnswer = ConductorHaltState | null | unknown[] | Record<string, unknown>;

function haltFake(answer: HaltAnswer | Error): Pick<ConductorHaltPort, 'read'> {
  return {
    async read(): Promise<ConductorHaltState> {
      if (answer instanceof Error) {
        throw answer;
      }
      return answer as ConductorHaltState;
    },
  };
}

/** A halt whose answer can be flipped mid-call (the already-sent case). */
function mutableHaltFake(): { halt: Pick<ConductorHaltPort, 'read'>; haltNow(): void } {
  let halted = false;
  return {
    halt: {
      async read(): Promise<ConductorHaltState> {
        return halted ? haltedState : { state: 'clear', record: null };
      },
    },
    haltNow(): void {
      halted = true;
    },
  };
}

interface RepoFake extends ChainRepositoryPort {
  readonly counts: Record<string, number>;
}

function repoFake(options: { list?: readonly ChainRecord[]; read?: ChainRecordRead } = {}): RepoFake {
  const counts: Record<string, number> = {
    recordChainIntent: 0,
    recordChainOutcome: 0,
    recordChainReviewPin: 0,
    recordChainRefreshIntent: 0,
    recordChainRefreshOutcome: 0,
    recordChainSwept: 0,
  };
  const recorded: ChainRecordDecision = { outcome: 'recorded' };
  return {
    counts,
    async listChains() {
      return { status: 'ok', records: options.list ?? [] };
    },
    async readChain(): Promise<ChainRecordRead> {
      return options.read ?? { status: 'not-found' };
    },
    async recordChainIntent() {
      counts.recordChainIntent += 1;
      return recorded;
    },
    async recordChainOutcome() {
      counts.recordChainOutcome += 1;
      return recorded;
    },
    async recordChainReviewPin() {
      counts.recordChainReviewPin += 1;
      return recorded;
    },
    async recordChainRefreshIntent() {
      counts.recordChainRefreshIntent += 1;
      return recorded;
    },
    async recordChainRefreshOutcome() {
      counts.recordChainRefreshOutcome += 1;
      return recorded;
    },
    async recordChainSwept() {
      counts.recordChainSwept += 1;
      return recorded;
    },
  };
}

function forgeFake(
  options: {
    head?: MergeBranchHeadResult;
    action?: MergeForgeActionResult;
    onAction?: () => void;
  } = {},
): MergeForgeActionPort & { headCalls: number; actionCalls: number } {
  const adapter = {
    headCalls: 0,
    actionCalls: 0,
    async readMergeBranchHead(): Promise<MergeBranchHeadResult> {
      adapter.headCalls += 1;
      return options.head ?? { outcome: 'found', headSha: HEAD };
    },
    async performMergeForgeAction(): Promise<MergeForgeActionResult> {
      adapter.actionCalls += 1;
      options.onAction?.();
      return options.action ?? { outcome: 'executed', headSha: HEAD };
    },
    isConfigured(): boolean {
      return true;
    },
  };
  return adapter as MergeForgeActionPort & { headCalls: number; actionCalls: number };
}

function attentionFake(): ChainAttentionPort & { raises: number; clears: number } {
  return {
    raises: 0,
    clears: 0,
    async raiseChainAttention() {
      this.raises += 1;
      return { outcome: 'raised', reasonCode: null };
    },
    async clearChainAttention() {
      this.clears += 1;
      return { outcome: 'cleared', reasonCode: null };
    },
  } as ChainAttentionPort & { raises: number; clears: number };
}

function makeRecord(overrides: Partial<ChainRecord> = {}): ChainRecord {
  return {
    schemaVersion: 1,
    repository: { owner: OWNER, repo: REPO },
    chainName: 'fix-thing',
    branchName: 'chain/fix-thing',
    sourceBranch: 'main',
    expectedHeadSha: HEAD,
    actionKey: 'start-key-1',
    state: 'started',
    reason: null,
    createdAtIso: NOW,
    revision: 2,
    ...overrides,
  };
}

function makeStartCommand(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repository: { owner: OWNER, repo: REPO },
    chainName: 'fix-thing',
    expectedHeadSha: HEAD,
    actionKey: 'start-key-1',
    nowIso: NOW,
    deadlineIso: DEADLINE,
    ...overrides,
  };
}

const refreshCommand = {
  repository: { owner: OWNER, repo: REPO },
  projectId: PROJECT,
  nowIso: NOW,
  deadlineIso: DEADLINE,
};

const sweepCommand = {
  repository: { owner: OWNER, repo: REPO },
  projectId: PROJECT,
  nowIso: NOW,
  deadlineIso: DEADLINE,
  mode: 'apply' as const,
};

/** Every fail-closed answer the halt port may give besides a clear read. */
const failClosedAnswers: readonly [string, HaltAnswer | Error][] = [
  ['an unreadable marker', { state: 'unreadable' } as ConductorHaltState],
  ['a throwing read', new Error('store gone')],
  ['a null answer', null],
  ['an array answer', []],
  ['an off-contract marker', { state: 'weird' }],
  ['a marker without a state tag', {}],
  ['a clear tag with a halted record', { state: 'clear', record: { halted: true } }],
  ['a clear tag with a malformed record', { state: 'clear', record: 'nope' }],
  ['a clear tag without a record', { state: 'clear' }],
  ['a clear tag whose record has only halted false', { state: 'clear', record: { halted: false } }],
  ['a clear tag whose record has the wrong version', { state: 'clear', record: { version: 2, halted: false, changedAtIso: NOW } }],
  ['a clear tag whose record has an invalid timestamp', { state: 'clear', record: { version: 1, halted: false, changedAtIso: 'not-a-time' } }],
];

const clearHalt = haltFake({ state: 'clear', record: null });

describe('RefreshChainsUseCase halt gating', () => {
  function makeRefresh(options: { halt?: Pick<ConductorHaltPort, 'read'>; onAction?: () => void; list?: readonly ChainRecord[]; mode?: 'shadow' | 'live' } = {}) {
    const records = options.list ?? [makeRecord()];
    const repo = repoFake({ list: records, read: { status: 'ok', record: records[0]! } });
    const forge = forgeFake({ onAction: options.onAction });
    const attention = attentionFake();
    const useCase = new RefreshChainsUseCase({ chains: repo, forge, attention, now: () => NOW, mode: options.mode ?? 'live', halt: options.halt ?? clearHalt });
    return { repo, forge, attention, useCase };
  }

  it('RefreshChainsUseCase refuses halted with zero forge calls', async () => {
    const { repo, forge, useCase } = makeRefresh({ halt: haltFake(haltedState) });

    const result = await useCase.runRefreshChains(refreshCommand);

    expect(result).toEqual({ outcome: 'refused', reasonCode: 'halted', chains: [] });
    expect(forge.headCalls).toBe(0);
    expect(forge.actionCalls).toBe(0);
    expect(repo.counts.recordChainRefreshIntent).toBe(0);
    expect(repo.counts.recordChainRefreshOutcome).toBe(0);
  });

  it.each(failClosedAnswers)('RefreshChainsUseCase refuses on an unreadable halt read: %s', async (_name, answer) => {
    const { repo, forge, useCase } = makeRefresh({ halt: haltFake(answer) });

    const result = await useCase.runRefreshChains(refreshCommand);

    expect(result).toEqual({ outcome: 'refused', reasonCode: 'halted', chains: [] });
    expect(forge.actionCalls).toBe(0);
    expect(repo.counts.recordChainRefreshIntent).toBe(0);
    expect(repo.counts.recordChainRefreshOutcome).toBe(0);
  });

  it('RefreshChainsUseCase refuses when halt port is missing read', async () => {
    const { forge, useCase } = makeRefresh({ halt: {} as unknown as Pick<ConductorHaltPort, 'read'> });

    const result = await useCase.runRefreshChains(refreshCommand);

    expect(result).toEqual({ outcome: 'refused', reasonCode: 'halted', chains: [] });
    expect(forge.actionCalls).toBe(0);
  });

  it('RefreshChainsUseCase runs normally when halt is clear', async () => {
    const { repo, forge, useCase } = makeRefresh({ halt: haltFake({ state: 'clear', record: null }) });

    const result = await useCase.runRefreshChains(refreshCommand);

    expect(result.outcome).toBe('completed');
    expect(result.chains).toEqual([{ chainName: 'fix-thing', key: `chain-refresh/fix-thing@${HEAD.slice(0, 12)}`, outcome: 'merged' }]);
    expect(forge.actionCalls).toBe(1);
    expect(repo.counts.recordChainRefreshIntent).toBe(1);
    expect(repo.counts.recordChainRefreshOutcome).toBe(1);
  });

  it('RefreshChainsUseCase refuses halted when the halt dependency is missing', async () => {
    for (const missing of [undefined, null]) {
      const repo = repoFake({ list: [makeRecord()], read: { status: 'ok', record: makeRecord() } });
      const forge = forgeFake();
      const useCase = new RefreshChainsUseCase({ chains: repo, forge, attention: attentionFake(), now: () => NOW, mode: 'live', halt: missing as never });

      const result = await useCase.runRefreshChains(refreshCommand);

      expect(result).toEqual({ outcome: 'refused', reasonCode: 'halted', chains: [] });
      expect(forge.headCalls).toBe(0);
      expect(forge.actionCalls).toBe(0);
      expect(repo.counts.recordChainRefreshIntent).toBe(0);
    }
  });

  it('RefreshChainsUseCase reads the halt at the pass start and before each started chain', async () => {
    let reads = 0;
    const countingHalt: Pick<ConductorHaltPort, 'read'> = {
      async read() {
        reads += 1;
        return { state: 'clear', record: null };
      },
    };
    const first = makeRefresh({ halt: countingHalt });

    const firstResult = await first.useCase.runRefreshChains(refreshCommand);

    expect(firstResult.outcome).toBe('completed');
    expect(reads).toBe(2);

    const twoStarted = [makeRecord(), makeRecord({ chainName: 'second-thing', branchName: 'chain/second-thing' })];
    let secondReads = 0;
    const secondHalt: Pick<ConductorHaltPort, 'read'> = {
      async read() {
        secondReads += 1;
        return { state: 'clear', record: null };
      },
    };
    const second = makeRefresh({ list: twoStarted, halt: secondHalt });

    const secondResult = await second.useCase.runRefreshChains(refreshCommand);

    expect(secondResult.outcome).toBe('completed');
    expect(secondReads).toBe(3);
  });

  it('a halt raised after the first chain stops the second chain', async () => {
    const mutable = mutableHaltFake();
    const list = [makeRecord(), makeRecord({ chainName: 'second-thing', branchName: 'chain/second-thing' })];
    const { repo, forge, useCase } = makeRefresh({ list, halt: mutable.halt, onAction: () => mutable.haltNow() });

    const result = await useCase.runRefreshChains(refreshCommand);

    expect(result).toEqual({
      outcome: 'refused',
      reasonCode: 'halted',
      chains: [{ chainName: 'fix-thing', key: 'chain-refresh/fix-thing@' + HEAD.slice(0, 12), outcome: 'merged' }],
    });
    expect(forge.actionCalls).toBe(1);
    expect(repo.counts.recordChainRefreshIntent).toBe(1);
    expect(repo.counts.recordChainRefreshOutcome).toBe(1);
  });

  it('a halt read that fails before a chain refuses the pass', async () => {
    let reads = 0;
    const flakyHalt: Pick<ConductorHaltPort, 'read'> = {
      async read() {
        reads += 1;
        if (reads >= 2) {
          throw new Error('store gone');
        }
        return { state: 'clear', record: null };
      },
    };
    const { repo, forge, useCase } = makeRefresh({ halt: flakyHalt });

    const result = await useCase.runRefreshChains(refreshCommand);

    expect(result).toEqual({ outcome: 'refused', reasonCode: 'halted', chains: [] });
    expect(forge.actionCalls).toBe(0);
    expect(repo.counts.recordChainRefreshIntent).toBe(0);
  });

  it('a clear answer with a lifted halted false record runs', async () => {
    const { forge, useCase } = makeRefresh({ halt: haltFake({ state: 'clear', record: { version: 1, halted: false, changedAtIso: NOW } }) });

    const result = await useCase.runRefreshChains(refreshCommand);

    expect(result.outcome).toBe('completed');
    expect(result.chains[0].outcome).toBe('merged');
    expect(forge.actionCalls).toBe(1);
  });

  it('a shadow pass refuses halted before the main head read', async () => {
    const { forge, useCase } = makeRefresh({ mode: 'shadow', halt: haltFake(haltedState) });

    const result = await useCase.runRefreshChains(refreshCommand);

    expect(result).toEqual({ outcome: 'refused', reasonCode: 'halted', chains: [] });
    expect(forge.headCalls).toBe(0);
  });

  it('a shadow pass reads the halt once and writes nothing', async () => {
    let reads = 0;
    const countingHalt: Pick<ConductorHaltPort, 'read'> = {
      async read() {
        reads += 1;
        return { state: 'clear', record: null };
      },
    };
    const { repo, forge, useCase } = makeRefresh({ mode: 'shadow', halt: countingHalt });

    const result = await useCase.runRefreshChains(refreshCommand);

    expect(result.outcome).toBe('skipped');
    expect(result.reasonCode).toBe('shadow-would-refresh-1');
    expect(reads).toBe(1);
    expect(forge.actionCalls).toBe(0);
    expect(repo.counts.recordChainRefreshIntent).toBe(0);
  });

  it('a throwing read getter on the halt port refuses halted', async () => {
    const { forge, useCase } = makeRefresh({
      halt: Object.defineProperty({}, 'read', { get() { throw new Error('boom'); } }) as never,
    });

    const result = await useCase.runRefreshChains(refreshCommand);

    expect(result).toEqual({ outcome: 'refused', reasonCode: 'halted', chains: [] });
    expect(forge.headCalls).toBe(0);
    expect(forge.actionCalls).toBe(0);
  });

  it('reports an already-sent forge action as completed when halt appears mid-call', async () => {
    const mutable = mutableHaltFake();
    const { repo, forge, useCase } = makeRefresh({ halt: mutable.halt, onAction: () => mutable.haltNow() });

    const result = await useCase.runRefreshChains(refreshCommand);

    expect(result.outcome).toBe('completed');
    expect(result.chains).toHaveLength(1);
    expect(result.chains[0].outcome).toBe('merged');
    expect(forge.actionCalls).toBe(1);
    expect(repo.counts.recordChainRefreshOutcome).toBe(1);
  });
});

describe('StartChainUseCase halt gating', () => {
  function makeStart(options: { halt?: Pick<ConductorHaltPort, 'read'>; onAction?: () => void; read?: ChainRecordRead } = {}) {
    const repo = repoFake({ read: options.read });
    const forge = forgeFake({ onAction: options.onAction });
    const useCase = new StartChainUseCase({ chains: repo, forge, halt: options.halt ?? clearHalt });
    return { repo, forge, useCase };
  }

  it('StartChainUseCase refuses halted with zero forge calls', async () => {
    const fresh = makeStart({ halt: haltFake(haltedState) });
    const freshResult = await fresh.useCase.startChain(makeStartCommand() as never);
    expect(freshResult).toEqual({ outcome: 'refused', reason: 'halted', record: null });
    expect(fresh.repo.counts.recordChainIntent).toBe(0);
    expect(fresh.forge.actionCalls).toBe(0);
    expect(fresh.forge.headCalls).toBe(0);

    const record = makeRecord({ state: 'intent-recorded', revision: 1 });
    const recover = makeStart({ halt: haltFake(haltedState), read: { status: 'ok', record } });
    const recoverResult = await recover.useCase.startChain(makeStartCommand() as never);
    expect(recoverResult).toEqual({ outcome: 'refused', reason: 'halted', record });
    expect(recover.forge.actionCalls).toBe(0);
    expect(recover.forge.headCalls).toBe(0);
  });

  it.each(failClosedAnswers)('StartChainUseCase refuses on an unreadable halt read: %s', async (_name, answer) => {
    const fresh = makeStart({ halt: haltFake(answer) });
    expect(await fresh.useCase.startChain(makeStartCommand() as never)).toEqual({
      outcome: 'refused',
      reason: 'halted',
      record: null,
    });
    expect(fresh.forge.actionCalls).toBe(0);

    const record = makeRecord({ state: 'intent-recorded', revision: 1 });
    const recover = makeStart({ halt: haltFake(answer), read: { status: 'ok', record } });
    expect(await recover.useCase.startChain(makeStartCommand() as never)).toEqual({
      outcome: 'refused',
      reason: 'halted',
      record,
    });
    expect(recover.forge.actionCalls).toBe(0);
    expect(recover.forge.headCalls).toBe(0);
  });

  it('StartChainUseCase refuses when halt port is missing read', async () => {
    const { forge, useCase } = makeStart({ halt: {} as unknown as Pick<ConductorHaltPort, 'read'> });

    expect(await useCase.startChain(makeStartCommand() as never)).toEqual({
      outcome: 'refused',
      reason: 'halted',
      record: null,
    });
    expect(forge.actionCalls).toBe(0);
  });

  it('StartChainUseCase runs normally when halt is clear', async () => {
    const { repo, forge, useCase } = makeStart({ halt: haltFake({ state: 'clear', record: null }) });

    const result = await useCase.startChain(makeStartCommand() as never);

    expect(result.outcome).toBe('started');
    expect(repo.counts.recordChainIntent).toBe(1);
    expect(repo.counts.recordChainOutcome).toBe(1);
    expect(forge.actionCalls).toBe(1);
  });

  it('StartChainUseCase runs normally when halt is absent', async () => {
    const repo = repoFake();
    const forge = forgeFake();
    const useCase = new StartChainUseCase({ chains: repo, forge });

    const result = await useCase.startChain(makeStartCommand() as never);

    expect(result.outcome).toBe('started');
    expect(repo.counts.recordChainIntent).toBe(1);
    expect(forge.actionCalls).toBe(1);
  });

  it('reports an already-sent forge action as completed when halt appears mid-call', async () => {
    const mutable = mutableHaltFake();
    const { repo, forge, useCase } = makeStart({ halt: mutable.halt, onAction: () => mutable.haltNow() });

    const result = await useCase.startChain(makeStartCommand() as never);

    expect(result.outcome).toBe('started');
    expect(forge.actionCalls).toBe(1);
    expect(repo.counts.recordChainOutcome).toBe(1);
  });
});

describe('SweepChainsUseCase halt gating', () => {
  const landedRecord = makeRecord({
    state: 'landed',
    revision: 3,
    linkBranches: ['work/one'],
  });

  function makeSweep(options: { halt?: Pick<ConductorHaltPort, 'read'>; onAction?: () => void; list?: readonly ChainRecord[] } = {}) {
    const repo = repoFake({ list: options.list ?? [landedRecord] });
    const forge = forgeFake({ onAction: options.onAction });
    const useCase = new SweepChainsUseCase({ chains: repo, forge, now: () => NOW, halt: options.halt ?? clearHalt });
    return { repo, forge, useCase };
  }

  it('SweepChainsUseCase refuses halted with zero forge calls', async () => {
    const { repo, forge, useCase } = makeSweep({ halt: haltFake(haltedState) });

    const result = await useCase.runSweepChains(sweepCommand);

    expect(result).toEqual({
      outcome: 'refused',
      reasonCode: 'halted',
      branchClass: null,
      chainName: null,
      memberRole: null,
      memberIndex: null,
      branches: [],
    });
    expect(forge.actionCalls).toBe(0);
    expect(repo.counts.recordChainSwept).toBe(0);
  });

  it.each(failClosedAnswers)('SweepChainsUseCase refuses on an unreadable halt read: %s', async (_name, answer) => {
    const { repo, forge, useCase } = makeSweep({ halt: haltFake(answer) });

    const result = await useCase.runSweepChains(sweepCommand);

    expect(result.outcome).toBe('refused');
    expect(result.reasonCode).toBe('halted');
    expect(forge.actionCalls).toBe(0);
    expect(repo.counts.recordChainSwept).toBe(0);
  });

  it('SweepChainsUseCase refuses when halt port is missing read', async () => {
    const { forge, useCase } = makeSweep({ halt: {} as unknown as Pick<ConductorHaltPort, 'read'> });

    const result = await useCase.runSweepChains(sweepCommand);

    expect(result.outcome).toBe('refused');
    expect(result.reasonCode).toBe('halted');
    expect(forge.actionCalls).toBe(0);
  });

  it('SweepChainsUseCase runs normally when halt is clear', async () => {
    const { repo, forge, useCase } = makeSweep({ halt: haltFake({ state: 'clear', record: null }) });

    const result = await useCase.runSweepChains(sweepCommand);

    expect(result.outcome).toBe('completed');
    expect(result.branches.map((branch) => branch.outcome)).toEqual(['deleted', 'deleted']);
    expect(forge.actionCalls).toBe(2);
    expect(repo.counts.recordChainSwept).toBe(1);
  });

  it('SweepChainsUseCase runs normally when halt is absent', async () => {
    const repo = repoFake({ list: [landedRecord] });
    const forge = forgeFake();
    const useCase = new SweepChainsUseCase({ chains: repo, forge, now: () => NOW });

    const result = await useCase.runSweepChains(sweepCommand);

    expect(result.outcome).toBe('completed');
    expect(forge.actionCalls).toBe(2);
    expect(repo.counts.recordChainSwept).toBe(1);
  });

  it('SweepChainsUseCase reads the halt once per pass', async () => {
    let reads = 0;
    const halt: Pick<ConductorHaltPort, 'read'> = {
      async read() {
        reads += 1;
        return { state: 'clear', record: null };
      },
    };
    const { useCase } = makeSweep({ halt });

    await useCase.runSweepChains(sweepCommand);

    expect(reads).toBe(1);
  });

  it('reports an already-sent forge action as completed when halt appears mid-call', async () => {
    const mutable = mutableHaltFake();
    const { repo, forge, useCase } = makeSweep({ halt: mutable.halt, onAction: () => mutable.haltNow() });

    const result = await useCase.runSweepChains(sweepCommand);

    // The halt is read once at the start of the pass: a halt that appears
    // after the first delete was sent does not abandon the chain half-swept.
    expect(result.outcome).toBe('completed');
    expect(result.branches.map((branch) => [branch.role, branch.outcome])).toEqual([
      ['link', 'deleted'],
      ['chain', 'deleted'],
    ]);
    expect(forge.actionCalls).toBe(2);
    expect(repo.counts.recordChainSwept).toBe(1);
  });
});
