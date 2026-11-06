import { describe, expect, it } from 'vitest';

import { createChainRecord } from '../../../domain/chain-records.js';
import type { ChainRecord } from '../../../domain/chain-records.js';
import type {
  ChainOutcomeCommand,
  ChainRecordDecision,
  ChainRecordRead,
  ChainRepositoryPort,
} from '../../ports/out/ChainRepositoryPort.out-port.js';
import type {
  MergeBranchHeadResult,
  MergeForgeActionPort,
  MergeForgeActionRequest,
  MergeForgeActionResult,
} from '../../ports/out/MergeForgeActionPort.out-port.js';
import { StartChainUseCase } from '../StartChainUseCase.use-case.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';
const REPO = { owner: 'fleet', repo: 'fleet-v2' };
const NOW = '2026-11-05T10:00:00.000Z';
const DEADLINE = '2026-11-05T10:05:00.000Z';

function command(overrides: Record<string, unknown> = {}) {
  return {
    repository: REPO, chainName: 'example', expectedHeadSha: SHA, actionKey: 'chain-start-1', nowIso: NOW, deadlineIso: DEADLINE,
    ...overrides,
  } as never;
}

function recordOf(state: ChainRecord['state'], overrides: Partial<ChainRecord> = {}): ChainRecord {
  const created = createChainRecord({
    repository: REPO, chainName: 'example', expectedHeadSha: SHA, actionKey: 'chain-start-1', createdAtIso: NOW,
  });
  if (!created.ok) throw new Error('setup');
  return { ...created.record, state, reason: state === 'refused' ? 'forge-refused' : null, ...overrides };
}

interface Script {
  read?: ChainRecordRead | 'throw';
  intent?: ChainRecordDecision | 'throw';
  outcome?: ChainRecordDecision | 'throw';
  create?: MergeForgeActionResult | 'throw';
  head?: MergeBranchHeadResult | 'throw';
}

function harness(script: Script = {}) {
  const calls: string[] = [];
  const outcomes: ChainOutcomeCommand[] = [];
  const creates: MergeForgeActionRequest[] = [];
  const chains: ChainRepositoryPort = {
    async readChain(read) {
      calls.push('read-chain');
      expect(read.deadlineIso).toBe(DEADLINE);
      if (script.read === 'throw') throw new Error('boom');
      return script.read ?? { status: 'not-found' };
    },
    async recordChainIntent(intent) {
      calls.push('intent');
      expect(intent.record.state).toBe('intent-recorded');
      if (script.intent === 'throw') throw new Error('boom');
      return script.intent ?? { outcome: 'recorded' };
    },
    async recordChainOutcome(outcome) {
      calls.push('outcome');
      outcomes.push(outcome);
      if (script.outcome === 'throw') throw new Error('boom');
      return script.outcome ?? { outcome: 'recorded' };
    },
    async recordChainReviewPin() {
      throw new Error("not used");
    },
    async listChains() {
      throw new Error("not used");
    },
    async recordChainRefreshIntent() {
      throw new Error("not used");
    },
    async recordChainRefreshOutcome() {
      throw new Error("not used");
    },
  };
  const forge: MergeForgeActionPort = {
    isConfigured: () => true,
    async performMergeForgeAction(request) {
      calls.push('create');
      creates.push(request);
      if (script.create === 'throw') throw new Error('boom');
      return script.create ?? { outcome: 'executed', headSha: SHA };
    },
    async readMergeBranchHead() {
      calls.push('read-head');
      if (script.head === 'throw') throw new Error('boom');
      return script.head ?? { outcome: 'not-found' };
    },
  };
  return { useCase: new StartChainUseCase({ chains, forge }), calls, outcomes, creates };
}

describe('StartChainUseCase validation', () => {
  it('refuses each bad field with no read, no record and no forge call', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ repository: { owner: '..', repo: 'x' } }, 'invalid-repository'],
      [{ repository: null }, 'invalid-repository'],
      [{ chainName: 'Chain/x' }, 'invalid-chain-name'],
      [{ chainName: 42 }, 'invalid-chain-name'],
      [{ expectedHeadSha: 'abc' }, 'invalid-expected-head'],
      [{ actionKey: '' }, 'invalid-action-key'],
      [{ actionKey: `ghp_${'a'.repeat(36)}` }, 'invalid-action-key'],
      [{ nowIso: 'x' }, 'invalid-now'],
      [{ deadlineIso: 'tomorrow' }, 'invalid-deadline'],
      [{ deadlineIso: undefined }, 'invalid-deadline'],
    ];
    for (const [overrides, reason] of cases) {
      const h = harness();
      const result = await h.useCase.startChain(command(overrides));
      expect(result).toEqual({ outcome: 'refused', reason, record: null });
      expect(h.calls).toEqual([]);
    }
  });

  it('never throws on a null command, a sparse array or a throwing getter', async () => {
    const getter = Object.defineProperty({}, 'chainName', { get() { throw new Error('boom'); }, enumerable: true });
    const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('boom'); } });
    for (const bad of [null, undefined, 3, 'x', [], new Array(3), getter, proxy]) {
      const h = harness();
      const result = await h.useCase.startChain(bad as never);
      expect(result.outcome).toBe('refused');
      expect(h.calls).toEqual([]);
    }
  });

  it('does not echo input values in the decision', async () => {
    const h = harness();
    const result = await h.useCase.startChain(command({ chainName: 'SECRET-NAME' }));
    expect(JSON.stringify(result)).not.toContain('SECRET-NAME');
  });
});

describe('StartChainUseCase existing chains', () => {
  it('refuses a started chain of another key with no forge call', async () => {
    const h = harness({ read: { status: 'ok', record: recordOf('started', { actionKey: 'other-key' }) } });
    const result = await h.useCase.startChain(command());
    expect(result).toMatchObject({ outcome: 'refused', reason: 'chain-already-started' });
    expect(h.calls).toEqual(['read-chain']);
  });

  it('refuses an in-flight chain of another key with no second intent and no forge call', async () => {
    const h = harness({ read: { status: 'ok', record: recordOf('intent-recorded', { actionKey: 'other-key' }) } });
    expect(await h.useCase.startChain(command())).toMatchObject({ outcome: 'refused', reason: 'chain-start-in-flight' });
    expect(h.calls).toEqual(['read-chain']);
  });

  it('refuses a chain whose start was refused by another key', async () => {
    const h = harness({ read: { status: 'ok', record: recordOf('refused', { actionKey: 'other-key' }) } });
    expect(await h.useCase.startChain(command())).toMatchObject({ outcome: 'refused', reason: 'chain-start-refused' });
    expect(h.calls).toEqual(['read-chain']);
  });

  it('returns the recorded outcome for a repeated key without a forge call', async () => {
    const started = harness({ read: { status: 'ok', record: recordOf('started', { revision: 2 }) } });
    expect(await started.useCase.startChain(command())).toMatchObject({ outcome: 'started' });
    expect(started.calls).toEqual(['read-chain']);
    const refused = harness({ read: { status: 'ok', record: recordOf('refused', { revision: 2 }) } });
    expect(await refused.useCase.startChain(command())).toMatchObject({ outcome: 'refused', reason: 'forge-refused' });
    expect(refused.calls).toEqual(['read-chain']);
  });

  it('refuses a reused key with another commit', async () => {
    const h = harness({ read: { status: 'ok', record: recordOf('started', { expectedHeadSha: OTHER }) } });
    expect(await h.useCase.startChain(command())).toMatchObject({ outcome: 'refused', reason: 'action-key-conflict' });
    expect(h.calls).toEqual(['read-chain']);
  });

  it('reports an unreadable record or a record of another chain as unknown, never as absent', async () => {
    for (const read of [
      { status: 'unreadable', reason: 'x' } as const,
      { status: 'ok', record: recordOf('started', { chainName: 'other', branchName: 'chain/other' }) } as const,
      { status: 'weird' } as never,
      'throw' as const,
    ]) {
      const h = harness({ read });
      expect(await h.useCase.startChain(command())).toEqual({ outcome: 'unknown', reason: 'unresolved', record: null });
      expect(h.calls).toEqual(['read-chain']);
    }
  });
});

describe('StartChainUseCase fresh start', () => {
  it('records the intent before the forge call, then the outcome', async () => {
    const h = harness();
    const result = await h.useCase.startChain(command());
    expect(h.calls).toEqual(['read-chain', 'intent', 'create', 'outcome']);
    expect(result).toMatchObject({ outcome: 'started', record: { state: 'started', revision: 2, reason: null } });
    expect(h.creates[0]).toEqual({
      kind: 'create-branch', actionId: 'chain-start-1', repository: REPO, branchName: 'chain/example',
      sourceBranch: 'main', expectedHeadSha: SHA, deadlineIso: DEADLINE,
    });
    expect(h.outcomes[0]).toMatchObject({ state: 'started', reason: null, actionKey: 'chain-start-1', expectedRevision: 1 });
  });

  it('refuses when the intent is already recorded or refused, with no forge call', async () => {
    const dup = harness({ intent: { outcome: 'already-recorded' } });
    expect(await dup.useCase.startChain(command())).toMatchObject({ outcome: 'refused', reason: 'chain-start-in-flight' });
    expect(dup.calls).toEqual(['read-chain', 'intent']);
    const no = harness({ intent: { outcome: 'refused', reason: 'x' } });
    expect(await no.useCase.startChain(command())).toMatchObject({ outcome: 'refused', reason: 'intent-refused' });
    expect(no.calls).toEqual(['read-chain', 'intent']);
  });

  it('reports a throwing intent store as unknown with no forge call', async () => {
    const h = harness({ intent: 'throw' });
    expect(await h.useCase.startChain(command())).toMatchObject({ outcome: 'unknown', reason: 'unresolved' });
    expect(h.calls).toEqual(['read-chain', 'intent']);
  });

  it('records refused when the create answers another commit', async () => {
    const h = harness({ create: { outcome: 'executed', headSha: OTHER } });
    expect(await h.useCase.startChain(command())).toMatchObject({
      outcome: 'refused', reason: 'branch-exists-at-other-commit', record: { state: 'refused' },
    });
    expect(h.outcomes[0]).toMatchObject({ state: 'refused', reason: 'branch-exists-at-other-commit' });
  });

  it('records forge-refused when the forge refuses', async () => {
    const h = harness({ create: { outcome: 'refused', reason: 'secret text', refusalKind: 'permission' } });
    const result = await h.useCase.startChain(command());
    expect(result).toMatchObject({ outcome: 'refused', reason: 'forge-refused' });
    expect(JSON.stringify(result)).not.toContain('secret text');
    expect(h.outcomes[0]).toMatchObject({ state: 'refused', reason: 'forge-refused' });
  });

  it('reconciles an ambiguous create at the expected commit as started', async () => {
    const h = harness({ create: { outcome: 'ambiguous', reason: 'x' }, head: { outcome: 'found', headSha: SHA } });
    expect(await h.useCase.startChain(command())).toMatchObject({ outcome: 'started' });
    expect(h.calls).toEqual(['read-chain', 'intent', 'create', 'read-head', 'outcome']);
    expect(h.creates).toHaveLength(1);
  });

  it('reconciles an ambiguous create at another commit as refused', async () => {
    const h = harness({ create: { outcome: 'ambiguous', reason: 'x' }, head: { outcome: 'found', headSha: OTHER } });
    expect(await h.useCase.startChain(command())).toMatchObject({ outcome: 'refused', reason: 'branch-exists-at-other-commit' });
    expect(h.outcomes[0]).toMatchObject({ state: 'refused' });
  });

  it('leaves the intent open when the branch is absent or unreadable after an ambiguous create', async () => {
    for (const head of [{ outcome: 'not-found' } as const, { outcome: 'unavailable', reason: 'x' } as const, 'throw' as const]) {
      const h = harness({ create: { outcome: 'ambiguous', reason: 'x' }, head });
      const result = await h.useCase.startChain(command());
      expect(result).toMatchObject({ outcome: 'unknown', reason: 'unresolved', record: { state: 'intent-recorded' } });
      expect(h.calls).toEqual(['read-chain', 'intent', 'create', 'read-head']);
      expect(h.creates).toHaveLength(1);
    }
  });

  it('treats a throwing forge call as ambiguous and reconciles by reading', async () => {
    const h = harness({ create: 'throw', head: { outcome: 'found', headSha: SHA } });
    expect(await h.useCase.startChain(command())).toMatchObject({ outcome: 'started' });
    expect(h.creates).toHaveLength(1);
  });

  it('never turns a started chain into a refusal when recording the outcome fails', async () => {
    for (const outcome of ['throw' as const, { outcome: 'refused', reason: 'x' } as const, { outcome: 'already-recorded' } as const]) {
      const h = harness({ outcome });
      const result = await h.useCase.startChain(command());
      expect(result).toMatchObject({ outcome: 'unknown', reason: 'unresolved', record: { state: 'intent-recorded' } });
    }
  });
});

describe('StartChainUseCase crash recovery', () => {
  const open = { status: 'ok', record: recordOf('intent-recorded') } as const;

  it('settles from a branch at the expected commit without a second create', async () => {
    const h = harness({ read: open, head: { outcome: 'found', headSha: SHA } });
    expect(await h.useCase.startChain(command())).toMatchObject({ outcome: 'started' });
    expect(h.calls).toEqual(['read-chain', 'read-head', 'outcome']);
  });

  it('refuses from a branch at another commit', async () => {
    const h = harness({ read: open, head: { outcome: 'found', headSha: OTHER } });
    expect(await h.useCase.startChain(command())).toMatchObject({ outcome: 'refused', reason: 'branch-exists-at-other-commit' });
    expect(h.calls).toEqual(['read-chain', 'read-head', 'outcome']);
  });

  it('creates once, without a second intent, when the branch is absent', async () => {
    const h = harness({ read: open, head: { outcome: 'not-found' } });
    expect(await h.useCase.startChain(command())).toMatchObject({ outcome: 'started' });
    expect(h.calls).toEqual(['read-chain', 'read-head', 'create', 'outcome']);
  });

  it('stays unknown when the head cannot be read', async () => {
    const h = harness({ read: open, head: { outcome: 'unavailable', reason: 'x' } });
    expect(await h.useCase.startChain(command())).toMatchObject({ outcome: 'unknown', reason: 'unresolved' });
    expect(h.calls).toEqual(['read-chain', 'read-head']);
  });
});
