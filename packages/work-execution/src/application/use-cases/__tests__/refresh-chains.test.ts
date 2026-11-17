import { describe, expect, it } from 'vitest';

import { LANE_DIFF_SECRET_PATTERNS, SECRET_PATTERNS } from '@fleet/shared';
import { applyChainOutcome, applyChainRefreshIntent, applyChainRefreshOutcome, createChainRecord } from '../../../domain/chain-records.js';
import type { ChainRecord } from '../../../domain/chain-records.js';
import type { ConductorHaltState } from '../../../domain/conductor-halt.js';
import type { ChainRepositoryPort } from '../../ports/out/ChainRepositoryPort.out-port.js';
import type { ConductorHaltPort } from '../../ports/out/ConductorHaltPort.out-port.js';
import type { ChainListResult, ChainRecordDecision, ChainRecordRead } from '../../ports/out/ChainRepositoryPort.out-port.js';
import type {
  ChainAttentionCommand,
  ChainAttentionPort,
  ClearChainAttentionResult,
  RaiseChainAttentionResult,
} from '../../ports/out/ChainAttentionPort.out-port.js';
import type {
  MergeBranchHeadResult,
  MergeForgeActionPort,
  MergeForgeActionResult,
} from '../../ports/out/MergeForgeActionPort.out-port.js';
import { RefreshChainsUseCase } from '../RefreshChainsUseCase.use-case.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const MAIN = 'fedcba9876543210fedcba9876543210fedcba98';
const OLD = '0000000000000000000000000000000000000000';
const REPO = { owner: 'fleet', repo: 'fleet-v2' };
const PROJECT = 'proj-1';
const NOW = '2026-11-05T10:00:00.000Z';
const DEADLINE = '2026-11-05T10:00:45.000Z';
const LATE = '2026-11-05T10:00:44.000Z';
const KEY = `chain-refresh/example@${MAIN.slice(0, 12)}`;

const clearHalt = { read: async () => ({ state: 'clear' as const, record: null }) };

class FakeHalt implements Pick<ConductorHaltPort, 'read'> {
  halted = false;
  failing = false;
  reads = 0;
  onRead?: (reads: number) => void;

  constructor(private readonly trace: string[]) {}

  async read(): Promise<ConductorHaltState> {
    this.trace.push('halt');
    this.reads += 1;
    this.onRead?.(this.reads);
    if (this.failing) throw new Error('halt-read-failed');
    if (this.halted) {
      return { state: 'halted', record: { version: 1, halted: true, changedAtIso: NOW } } as ConductorHaltState;
    }
    return { state: 'clear', record: null };
  }
}

function command(overrides: Record<string, unknown> = {}) {
  return { repository: REPO, projectId: PROJECT, nowIso: NOW, deadlineIso: DEADLINE, ...overrides } as never;
}

function startedRecord(chainName = 'example', overrides: Partial<ChainRecord> = {}): ChainRecord {
  const created = createChainRecord({
    repository: REPO,
    chainName,
    expectedHeadSha: SHA,
    actionKey: 'chain-start-1',
    createdAtIso: NOW,
  });
  if (!created.ok) throw new Error('setup');
  return { ...applyChainOutcome(created.record, { state: 'started', reason: null }), ...overrides };
}

function conflictAtOldKey(): Partial<ChainRecord> {
  return {
    refresh: { key: `chain-refresh/example@${OLD.slice(0, 12)}`, mainSha: OLD, outcome: 'conflict', updatedAtIso: NOW },
    conflictMark: 'chain-refresh-conflict',
  };
}

class FakeChains implements ChainRepositoryPort {
  readonly calls: string[] = [];
  readonly intentWrites: string[] = [];
  onIntent?: (chainName: string) => void;
  records: ChainRecord[];
  listScript: ChainListResult | 'throw' | undefined;
  readScript: ChainRecordRead | 'throw' | undefined;
  intentScript: ChainRecordDecision | 'throw' | undefined;
  outcomeScript: ChainRecordDecision | 'throw' | undefined;

  constructor(records: ChainRecord[], private readonly trace: string[]) {
    this.records = records;
  }

  private byName(chainName: string): ChainRecord | undefined {
    return this.records.find((record) => record.chainName === chainName);
  }

  async listChains(): Promise<ChainListResult> {
    this.calls.push('list');
    this.trace.push('list');
    if (this.listScript === 'throw') throw new Error('boom');
    if (this.listScript !== undefined) return this.listScript;
    return { status: 'ok', records: this.records };
  }

  async readChain(command: { chainName: string }): Promise<ChainRecordRead> {
    this.calls.push('read');
    this.trace.push('read');
    if (this.readScript === 'throw') throw new Error('boom');
    if (this.readScript !== undefined) return this.readScript;
    const record = this.byName(command.chainName);
    return record === undefined ? { status: 'not-found' } : { status: 'ok', record };
  }

  async recordChainRefreshIntent(command: { chainName: string; key: string; mainSha: string; atIso: string }): Promise<ChainRecordDecision> {
    this.calls.push('intent');
    this.trace.push('intent');
    if (this.intentScript === 'throw') throw new Error('boom');
    if (this.intentScript !== undefined) return this.intentScript;
    const record = this.byName(command.chainName);
    if (record === undefined) return { outcome: 'refused', reason: 'chain-not-found' };
    if (record.refresh?.key === command.key) {
      this.onIntent?.(command.chainName);
      return { outcome: 'already-recorded' };
    }
    this.records = this.records.map((r) =>
      r.chainName === command.chainName
        ? applyChainRefreshIntent(r, { key: command.key, mainSha: command.mainSha, atIso: command.atIso })
        : r,
    );
    this.intentWrites.push(command.key);
    this.onIntent?.(command.chainName);
    return { outcome: 'recorded' };
  }

  async recordChainRefreshOutcome(command: { chainName: string; outcome: 'merged' | 'up-to-date' | 'conflict' | 'branch-gone'; atIso: string }): Promise<ChainRecordDecision> {
    this.calls.push('outcome');
    this.trace.push('outcome');
    if (this.outcomeScript === 'throw') throw new Error('boom');
    if (this.outcomeScript !== undefined) return this.outcomeScript;
    const record = this.byName(command.chainName);
    if (record === undefined) return { outcome: 'refused', reason: 'chain-not-found' };
    this.records = this.records.map((r) => (r.chainName === command.chainName ? applyChainRefreshOutcome(r, command.outcome, command.atIso) : r));
    return { outcome: 'recorded' };
  }

  async recordChainSwept(): Promise<ChainRecordDecision> {
    return { outcome: 'refused', reason: 'not used' };
  }

  async recordChainIntent(): Promise<ChainRecordDecision> {
    throw new Error('not used');
  }
  async recordChainOutcome(): Promise<ChainRecordDecision> {
    throw new Error('not used');
  }
  async recordChainReviewPin(): Promise<ChainRecordDecision> {
    throw new Error('not used');
  }
}

class FakeForge implements MergeForgeActionPort {
  readonly calls: string[] = [];
  headScript: MergeBranchHeadResult | 'throw' | undefined;
  actionScript: MergeForgeActionResult | 'throw' | undefined;
  onForged?: () => void;

  constructor(private readonly trace: string[]) {}

  isConfigured(): boolean {
    return true;
  }

  async readMergeBranchHead(): Promise<MergeBranchHeadResult> {
    this.calls.push('head');
    this.trace.push('head');
    if (this.headScript === 'throw') throw new Error('boom');
    if (this.headScript !== undefined) return this.headScript;
    return { outcome: 'found', headSha: MAIN };
  }

  async performMergeForgeAction(): Promise<MergeForgeActionResult> {
    this.calls.push('forge');
    this.trace.push('forge');
    this.onForged?.();
    if (this.actionScript === 'throw') throw new Error('boom');
    if (this.actionScript !== undefined) return this.actionScript;
    return { outcome: 'executed', headSha: MAIN };
  }
}

class FakeAttention implements ChainAttentionPort {
  readonly raises: ChainAttentionCommand[] = [];
  readonly clears: ChainAttentionCommand[] = [];
  raiseScript: RaiseChainAttentionResult | undefined;
  clearScript: ClearChainAttentionResult | undefined;

  async raiseChainAttention(command: ChainAttentionCommand): Promise<RaiseChainAttentionResult> {
    this.raises.push(command);
    return this.raiseScript ?? { outcome: 'raised', reasonCode: null };
  }

  async clearChainAttention(command: ChainAttentionCommand): Promise<ClearChainAttentionResult> {
    this.clears.push(command);
    return this.clearScript ?? { outcome: 'cleared', reasonCode: null };
  }
}

function harness(script: {
  records?: ChainRecord[];
  list?: ChainListResult | 'throw';
  read?: ChainRecordRead | 'throw';
  intent?: ChainRecordDecision | 'throw';
  outcome?: ChainRecordDecision | 'throw';
  head?: MergeBranchHeadResult | 'throw';
  forge?: MergeForgeActionResult | 'throw';
  raise?: FakeAttention['raiseScript'];
  clear?: FakeAttention['clearScript'];
  nowFn?: () => string;
  mode?: 'shadow' | 'live';
  tracedHalt?: boolean;
} = {}) {
  const trace: string[] = [];
  const halt = script.tracedHalt === true ? new FakeHalt(trace) : null;
  const chains = new FakeChains(script.records ?? [startedRecord()], trace);
  chains.listScript = script.list;
  chains.readScript = script.read;
  chains.intentScript = script.intent;
  chains.outcomeScript = script.outcome;
  const forge = new FakeForge(trace);
  forge.headScript = script.head;
  forge.actionScript = script.forge;
  const attention = new FakeAttention();
  attention.raiseScript = script.raise;
  attention.clearScript = script.clear;
  const useCase = new RefreshChainsUseCase({
    chains,
    forge,
    attention,
    halt: halt ?? clearHalt,
    now: script.nowFn ?? (() => NOW),
    mode: script.mode ?? 'live',
  });
  return { useCase, chains, forge, attention, trace, halt };
}

describe('RefreshChainsUseCase validation', () => {
  it('a malformed request is refused without throwing', async () => {
    const getter = Object.defineProperty({}, 'repository', { get() { throw new Error('boom'); }, enumerable: true });
    const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('boom'); } });
    const cases: [unknown, string][] = [
      [null, 'invalid-request'],
      [undefined, 'invalid-request'],
      [3, 'invalid-request'],
      ['x', 'invalid-request'],
      [[], 'invalid-request'],
      [new Array(3), 'invalid-request'],
      [getter, 'invalid-repository'],
      [proxy, 'invalid-request'],
      [{ repository: { owner: '..', repo: 'x' }, projectId: PROJECT, nowIso: NOW, deadlineIso: DEADLINE }, 'invalid-repository'],
      [{ repository: REPO, projectId: 'bad id', nowIso: NOW, deadlineIso: DEADLINE }, 'invalid-project-id'],
      [{ repository: REPO, projectId: PROJECT, nowIso: 'x', deadlineIso: DEADLINE }, 'invalid-now'],
      [{ repository: REPO, projectId: PROJECT, nowIso: NOW, deadlineIso: 'tomorrow' }, 'invalid-deadline'],
    ];
    for (const [bad, reason] of cases) {
      const h = harness();
      const result = await h.useCase.runRefreshChains(bad as never);
      expect(result).toEqual({ outcome: 'refused', reasonCode: reason, chains: [] });
      expect(h.trace).toEqual([]);
    }
  });
});

describe('RefreshChainsUseCase', () => {
  it('refreshes an active chain by merging main into the chain branch', async () => {
    const h = harness();
    const result = await h.useCase.runRefreshChains(command());
    expect(result).toEqual({ outcome: 'completed', reasonCode: null, chains: [{ chainName: 'example', key: KEY, outcome: 'merged' }] });
    expect(h.trace).toEqual(['list', 'head', 'intent', 'read', 'forge', 'outcome']);
    expect(h.attention.raises).toHaveLength(0);
    expect(h.attention.clears).toHaveLength(1);
    expect(h.attention.clears[0]).toEqual({ projectId: PROJECT, repository: REPO, chainName: 'example', kind: 'chain-refresh-conflict' });
  });

  it('a repeated chain-refresh key returns the recorded result without a second forge call', async () => {
    const record = startedRecord('example', {
      refresh: { key: KEY, mainSha: MAIN, outcome: 'merged', updatedAtIso: NOW },
    });
    const h = harness({ records: [record] });
    const result = await h.useCase.runRefreshChains(command());
    expect(result).toEqual({ outcome: 'completed', reasonCode: null, chains: [{ chainName: 'example', key: KEY, outcome: 'merged' }] });
    expect(h.trace).toEqual(['list', 'head']);
  });

  it('a conflict sets the conflict mark and raises a chain-refresh-conflict attention item', async () => {
    const h = harness({ forge: { outcome: 'refused', reason: 'x', refusalKind: 'conflict' } });
    const result = await h.useCase.runRefreshChains(command());
    expect(result.chains).toEqual([{ chainName: 'example', key: KEY, outcome: 'conflict' }]);
    expect(h.attention.raises).toHaveLength(1);
    expect(h.attention.raises[0]).toEqual({ projectId: PROJECT, repository: REPO, chainName: 'example', kind: 'chain-refresh-conflict' });
    expect(h.attention.clears).toHaveLength(0);
    expect(h.chains.records[0]!.conflictMark).toBe('chain-refresh-conflict');
  });

  it('a refused attention raise is named in the result and the chain still reads conflict', async () => {
    const h = harness({
      forge: { outcome: 'refused', reason: 'x', refusalKind: 'conflict' },
      raise: { outcome: 'refused', reasonCode: 'store-unreadable' },
    });
    const result = await h.useCase.runRefreshChains(command());
    expect(result.chains).toEqual([
      { chainName: 'example', key: KEY, outcome: 'conflict', attentionRefused: 'store-unreadable' },
    ]);
    expect(h.attention.raises).toHaveLength(1);
  });

  it('shadow mode observes what it would refresh and writes nothing', async () => {
    const h = harness({ mode: 'shadow', records: [startedRecord('example'), startedRecord('second')] });
    const result = await h.useCase.runRefreshChains(command());
    expect(result.outcome).toBe('skipped');
    expect(result.reasonCode).toBe('shadow-would-refresh-2');
    expect(result.chains.map((chain) => [chain.chainName, chain.outcome])).toEqual([
      ['example', 'skipped'],
      ['second', 'skipped'],
    ]);
    expect(result.chains[0]!.key).toBe(KEY);
    expect(h.trace).toEqual(['list', 'head']);
    expect(h.forge.calls).toEqual(['head']);
    expect(h.attention.raises).toHaveLength(0);
    expect(h.attention.clears).toHaveLength(0);
  });

  it('a construction with no mode, or an unknown mode, makes zero forge writes', async () => {
    for (const extra of [{}, { mode: 'bogus' as never }]) {
      const trace: string[] = [];
      const chains = new FakeChains([startedRecord()], trace);
      const forge = new FakeForge(trace);
      const attention = new FakeAttention();
      const useCase = new RefreshChainsUseCase({ chains, forge, attention, halt: clearHalt, now: () => NOW, ...extra });
      const result = await useCase.runRefreshChains(command());
      expect(result.reasonCode).toBe('shadow-would-refresh-1');
      expect(trace).toEqual(['list', 'head']);
      expect(forge.calls).toEqual(['head']);
      expect(attention.raises).toHaveLength(0);
      expect(attention.clears).toHaveLength(0);
    }
  });

  it('shadow mode reports a chain already refreshed at this main head as nothing to do', async () => {
    const record = startedRecord('example', {
      refresh: { key: KEY, mainSha: MAIN, outcome: 'merged', updatedAtIso: NOW },
    });
    const h = harness({ mode: 'shadow', records: [record] });
    const result = await h.useCase.runRefreshChains(command());
    expect(result.reasonCode).toBe('shadow-nothing-to-refresh');
    expect(h.trace).toEqual(['list', 'head']);
  });

  it('a merged chain clears the conflict mark and clears the attention item', async () => {
    const record = startedRecord('example', conflictAtOldKey());
    const h = harness({ records: [record], forge: { outcome: 'executed', headSha: MAIN } });
    const result = await h.useCase.runRefreshChains(command());
    expect(result.chains).toEqual([{ chainName: 'example', key: KEY, outcome: 'merged' }]);
    expect(h.attention.clears).toHaveLength(1);
    expect(h.attention.clears[0]).toEqual({ projectId: PROJECT, repository: REPO, chainName: 'example', kind: 'chain-refresh-conflict' });
    expect(h.attention.raises).toHaveLength(0);
    expect(h.chains.records[0]!.conflictMark).toBeNull();
  });

  it('an already up to date branch clears the conflict mark and clears the attention item', async () => {
    const record = startedRecord('example', conflictAtOldKey());
    const h = harness({ records: [record], forge: { outcome: 'already-applied' } });
    const result = await h.useCase.runRefreshChains(command());
    expect(result.chains).toEqual([{ chainName: 'example', key: KEY, outcome: 'up-to-date' }]);
    expect(h.attention.clears).toHaveLength(1);
    expect(h.chains.records[0]!.conflictMark).toBeNull();
  });

  it('a branch the forge no longer has is recorded and left to the sweep', async () => {
    const h = harness({ forge: { outcome: 'branch-gone' } });
    const result = await h.useCase.runRefreshChains(command());
    expect(result.chains).toEqual([{ chainName: 'example', key: KEY, outcome: 'branch-gone' }]);
    expect(h.attention.raises).toHaveLength(0);
    expect(h.attention.clears).toHaveLength(0);
  });

  it('an unreadable chain record is skipped with a reason code and never merged', async () => {
    const h = harness({ list: { status: 'unreadable', reason: 'record-limit' } });
    const result = await h.useCase.runRefreshChains(command());
    expect(result).toEqual({ outcome: 'skipped', reasonCode: 'chains-unreadable', chains: [] });
    expect(h.trace).toEqual(['list']);
    expect(h.forge.calls).toEqual([]);
  });

  it('an unreadable main head is skipped with a reason code and never merged', async () => {
    const h = harness({ head: { outcome: 'unavailable', reason: 'x' } });
    const result = await h.useCase.runRefreshChains(command());
    expect(result).toEqual({ outcome: 'skipped', reasonCode: 'main-unreadable', chains: [] });
    expect(h.trace).toEqual(['list', 'head']);
    expect(h.forge.calls).not.toContain('forge');
  });

  it('an unknown forge answer is skipped and never retried as a merge in the same pass', async () => {
    const h = harness({ forge: { outcome: 'ambiguous', reason: 'x' } });
    const result = await h.useCase.runRefreshChains(command());
    expect(result.chains).toEqual([{ chainName: 'example', key: KEY, outcome: 'skipped' }]);
    expect(h.forge.calls.filter((call) => call === 'forge')).toHaveLength(1);
    expect(h.chains.calls).not.toContain('outcome');
  });

  it('the pass stops at the deadline and leaves the remaining chains for the next pass', async () => {
    let clock = NOW;
    const h = harness({
      records: [startedRecord('one'), startedRecord('two')],
      nowFn: () => clock,
    });
    h.forge.onForged = () => {
      clock = LATE;
    };
    const result = await h.useCase.runRefreshChains(command());
    expect(result.outcome).toBe('budget-exhausted');
    expect(result.chains).toEqual([{ chainName: 'one', key: `chain-refresh/one@${MAIN.slice(0, 12)}`, outcome: 'merged' }]);
    expect(h.chains.calls.filter((call) => call === 'intent')).toHaveLength(1);
    expect(h.chains.records.some((r) => r.chainName === 'two' && r.refresh !== null)).toBe(false);
  });
});

describe('RefreshChainsUseCase halt re-read before the merge (OG7b6)', () => {
  it('a clear live pass reads the halt at the pass start, before the chain and directly before the merge', async () => {
    const h = harness({ tracedHalt: true });
    const result = await h.useCase.runRefreshChains(command());
    expect(result.outcome).toBe('completed');
    expect(h.trace).toEqual(['list', 'halt', 'head', 'halt', 'intent', 'read', 'halt', 'forge', 'outcome']);
  });

  it('a halt set during the intent write sends no merge and leaves the intent in flight', async () => {
    const h = harness({ tracedHalt: true });
    h.chains.onIntent = () => {
      h.halt!.halted = true;
    };
    const result = await h.useCase.runRefreshChains(command());
    expect(result).toEqual({ outcome: 'refused', reasonCode: 'halted', chains: [] });
    expect(h.trace).toEqual(['list', 'halt', 'head', 'halt', 'intent', 'read', 'halt']);
    expect(h.chains.records[0]!.refresh).toEqual({ key: KEY, mainSha: MAIN, outcome: 'in-flight', updatedAtIso: NOW });
    expect(h.chains.intentWrites).toEqual([KEY]);
    expect(h.attention.raises).toHaveLength(0);
    expect(h.attention.clears).toHaveLength(0);
  });

  it('after the halt is lifted the next pass sends the merge once under the same key and writes no second intent', async () => {
    const h = harness({ tracedHalt: true });
    h.chains.onIntent = () => {
      h.halt!.halted = true;
    };
    const firstResult = await h.useCase.runRefreshChains(command());
    expect(firstResult.reasonCode).toBe('halted');
    const firstLen = h.trace.length;
    h.halt!.halted = false;
    h.chains.onIntent = () => {};
    const result = await h.useCase.runRefreshChains(command());
    expect(result).toEqual({
      outcome: 'completed',
      reasonCode: null,
      chains: [{ chainName: 'example', key: KEY, outcome: 'merged' }],
    });
    expect(h.forge.calls.filter((call) => call === 'forge')).toHaveLength(1);
    expect(h.chains.intentWrites).toEqual([KEY]);
    expect(h.chains.records[0]!.refresh?.outcome).toBe('merged');
    expect(h.trace.slice(firstLen)).toEqual(['list', 'halt', 'head', 'halt', 'intent', 'read', 'halt', 'forge', 'outcome']);
  });

  it('a halt read that throws directly before the merge sends no merge', async () => {
    const h = harness({ tracedHalt: true });
    h.chains.onIntent = () => {
      h.halt!.failing = true;
    };
    const result = await h.useCase.runRefreshChains(command());
    expect(result).toEqual({ outcome: 'refused', reasonCode: 'halted', chains: [] });
    expect(h.trace).toEqual(['list', 'halt', 'head', 'halt', 'intent', 'read', 'halt']);
    expect(h.chains.records[0]!.refresh?.outcome).toBe('in-flight');
  });

  it('a halt set during the intent write of the second chain keeps the report of the first and sends one merge', async () => {
    const SECOND_KEY = 'chain-refresh/second@' + MAIN.slice(0, 12);
    const h = harness({ tracedHalt: true, records: [startedRecord('example'), startedRecord('second')] });
    h.chains.onIntent = (name) => {
      if (name === 'second') h.halt!.halted = true;
    };
    const result = await h.useCase.runRefreshChains(command());
    expect(result).toEqual({
      outcome: 'refused',
      reasonCode: 'halted',
      chains: [{ chainName: 'example', key: KEY, outcome: 'merged' }],
    });
    expect(h.forge.calls.filter((call) => call === 'forge')).toHaveLength(1);
    expect(h.chains.intentWrites).toEqual([KEY, SECOND_KEY]);
  });

  it('a halt set while the merge is in flight still records the outcome and is not read again', async () => {
    const h = harness({ tracedHalt: true });
    h.forge.onForged = () => {
      h.halt!.halted = true;
    };
    const result = await h.useCase.runRefreshChains(command());
    expect(result).toEqual({
      outcome: 'completed',
      reasonCode: null,
      chains: [{ chainName: 'example', key: KEY, outcome: 'merged' }],
    });
    expect(h.trace).toEqual(['list', 'halt', 'head', 'halt', 'intent', 'read', 'halt', 'forge', 'outcome']);
  });

  it('a chain replayed from a stored outcome costs no merge-time halt read', async () => {
    const h = harness({
      tracedHalt: true,
      records: [startedRecord('example', { refresh: { key: KEY, mainSha: MAIN, outcome: 'merged', updatedAtIso: NOW } })],
    });
    const result = await h.useCase.runRefreshChains(command());
    expect(result.outcome).toBe('completed');
    expect(h.trace).toEqual(['list', 'halt', 'head', 'halt']);
    expect(h.halt!.reads).toBe(2);
  });

  it('a budget spent during the halt read sends no merge', async () => {
    let late = false;
    const h = harness({ tracedHalt: true, nowFn: () => (late ? LATE : NOW) });
    h.halt!.onRead = (reads) => {
      if (reads === 3) late = true;
    };
    const result = await h.useCase.runRefreshChains(command());
    expect(result).toEqual({ outcome: 'budget-exhausted', reasonCode: null, chains: [] });
    expect(h.trace).toEqual(['list', 'halt', 'head', 'halt', 'intent', 'read', 'halt']);
  });

  const rows: [string, Parameters<typeof harness>[0], string[]][] = [
    ['a refused intent write', { intent: { outcome: 'refused', reason: 'stale-revision' } }, ['list', 'halt', 'head', 'halt', 'intent']],
    ['a record re-read that is not found', { read: { status: 'not-found' } }, ['list', 'halt', 'head', 'halt', 'intent', 'read']],
    ['a merge call that throws', { forge: 'throw' }, ['list', 'halt', 'head', 'halt', 'intent', 'read', 'halt', 'forge']],
    [
      'a refused outcome write',
      { outcome: { outcome: 'refused', reason: 'stale-revision' } },
      ['list', 'halt', 'head', 'halt', 'intent', 'read', 'halt', 'forge', 'outcome'],
    ],
  ];
  it.each(rows)('an existing skip path is unchanged and reads the halt only when the merge is reached: %s', async (_label, script, expectedTrace) => {
    const h = harness({ tracedHalt: true, ...script });
    const result = await h.useCase.runRefreshChains(command());
    expect(result).toEqual({ outcome: 'completed', reasonCode: null, chains: [{ chainName: 'example', key: KEY, outcome: 'skipped' }] });
    expect(h.trace).toEqual(expectedTrace);
  });
});

describe('RefreshChainsUseCase output hygiene', () => {
  it('no output echoes a path or secret-shaped text', async () => {
    const results: unknown[] = [];
    const refused = harness({ list: { status: 'unreadable', reason: 'store-unavailable' } });
    results.push(await refused.useCase.runRefreshChains(command()));
    const completed = harness();
    results.push(await completed.useCase.runRefreshChains(command()));
    const conflicted = harness({ forge: { outcome: 'refused', reason: 'x', refusalKind: 'conflict' } });
    results.push(await conflicted.useCase.runRefreshChains(command()));
    for (const result of results) {
      const text = JSON.stringify(result);
      for (const pattern of [...SECRET_PATTERNS, ...LANE_DIFF_SECRET_PATTERNS.map((p) => p.regex)]) {
        expect(pattern.test(text)).toBe(false);
      }
      expect(text).not.toContain('stateDir');
      expect(text).not.toContain('.json');
    }
  });
});
