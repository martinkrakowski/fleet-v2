import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AttentionItemRecord } from '../../../domain/attention-item-records.js';
import { AttentionItem, attentionItemKey } from '../../../domain/entities/AttentionItem.js';
import type {
  ChangeSignal,
  ChangeSignalPort,
} from '../../../application/ports/out/ChangeSignalPort.out-port.js';
import { RecordAttentionItemUseCase } from '../RecordAttentionItemUseCase.use-case.js';
import { AttentionItemRepositoryAdapter } from '../../../infrastructure/adapters/AttentionItemRepositoryAdapter.adapter.js';

const BASE_ISO = '2026-10-27T10:00:00.000Z';
const RUN_REF = 'run-01JB0000000000000000000000';
const PARK_1_SUMMARY = `The conductor parked ${RUN_REF} with reason owner-merge (park 1).`;
const PARK_2_SUMMARY = `The conductor parked ${RUN_REF} with reason owner-merge (park 2).`;
const KEY = attentionItemKey('example-project', { kind: 'run', ref: RUN_REF }, 'conductor-park');

/** The clock advances 20 s per call: each raise lands strictly after the last. */
function clock(): { readonly nowIso: () => string; readonly current: () => string } {
  let calls = 0;
  return {
    nowIso: () => {
      const value = new Date(Date.parse(BASE_ISO) + 20_000 * calls).toISOString();
      calls += 1;
      return value;
    },
    current: () => new Date(Date.parse(BASE_ISO) + 20_000 * calls).toISOString(),
  };
}

function ids(): { readonly newItemId: () => string } {
  let next = 1;
  return {
    newItemId: () => `att-${next++}`,
  };
}

class RecordingChangeSignalPort implements ChangeSignalPort {
  readonly emitted: ChangeSignal[] = [];

  emit(signal: ChangeSignal): void {
    this.emitted.push(signal);
  }
}

function parkBody(overrides: Partial<{ summary: string; kind: string; subject: { kind: string; ref: string }; raisedBy: string }> = {}): Record<string, unknown> {
  return {
    projectId: 'example-project',
    kind: overrides.kind ?? 'conductor-park',
    subject: overrides.subject ?? { kind: 'run', ref: RUN_REF },
    workOrderId: 'wo-example-1',
    summary: overrides.summary ?? PARK_1_SUMMARY,
  };
}

/** Narrow the result union; a refusal here is a test bug. */
function mustOk(result: Awaited<ReturnType<RecordAttentionItemUseCase['recordAttentionItem']>>): { item: AttentionItemRecord; revision: number } {
  if (result.outcome === 'refused') {
    throw new Error(result.reason);
  }
  return { item: result.item, revision: result.revision };
}

/** Narrow the domain result union; a failure here is a test bug. */
function mustSucceed(result: ReturnType<typeof AttentionItem.create>): AttentionItem {
  if (!result.success) {
    throw new Error(result.error.message);
  }
  return result.value;
}

async function readStateBytes(stateDir: string): Promise<Buffer> {
  return fs.readFile(path.join(stateDir, 'attention-items.json'));
}

async function statState(stateDir: string): Promise<{ mtimeMs: number; size: number }> {
  const stat = await fs.stat(path.join(stateDir, 'attention-items.json'));
  return { mtimeMs: stat.mtimeMs, size: stat.size };
}

describe('RecordAttentionItemUseCase conductor-park occurrence idempotence', () => {
  let tempDir: string;
  let stateDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-record-attention-park-test-'));
    stateDir = path.join(tempDir, 'state');
    await fs.mkdir(stateDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeUseCase(): {
    useCase: RecordAttentionItemUseCase;
    repo: AttentionItemRepositoryAdapter;
    signal: RecordingChangeSignalPort;
    clock: ReturnType<typeof clock>;
  } {
    const signal = new RecordingChangeSignalPort();
    const repo = new AttentionItemRepositoryAdapter({ stateDir, changeSignal: signal });
    const tick = clock();
    const useCase = new RecordAttentionItemUseCase({ itemRepo: repo, clock: tick, ids: ids() });
    return { useCase, repo, signal, clock: tick };
  }

  it('raises the first park once and writes nothing for the same occurrence', async () => {
    const { useCase, repo, signal } = makeUseCase();

    const first = await useCase.recordAttentionItem(parkBody(), 'conductor');
    expect(first.outcome).toBe('raised');
    const firstOk = mustOk(first);
    expect(first).toMatchObject({ revision: 1, item: { raisedCount: 1, state: 'open' } });

    const bytes = await readStateBytes(stateDir);
    const before = await statState(stateDir);
    const signals = signal.emitted.length;

    for (const _round of [0, 1]) {
      void _round;
      const again = await useCase.recordAttentionItem(parkBody(), 'conductor');
      expect(again.outcome).toBe('refreshed');
      expect(again).toMatchObject({ revision: 1 });
    }

    expect(await readStateBytes(stateDir)).toEqual(bytes);
    expect(await statState(stateDir)).toEqual(before);
    expect(signal.emitted).toHaveLength(signals);

    const stored = await repo.findByKey(KEY);
    expect(stored?.item.raisedCount).toBe(1);
    expect(stored?.item.lastRaisedAtIso).toBe(firstOk.item.lastRaisedAtIso);
  });

  it('refreshes once for a new park occurrence and then stays silent for it', async () => {
    const { useCase, signal } = makeUseCase();
    await useCase.recordAttentionItem(parkBody(), 'conductor');

    const second = await useCase.recordAttentionItem(parkBody({ summary: PARK_2_SUMMARY }), 'conductor');
    expect(second.outcome).toBe('refreshed');
    const secondItem = mustOk(second);
    expect(second).toMatchObject({ revision: 2, item: { raisedCount: 2, summary: PARK_2_SUMMARY } });
    expect(secondItem.item.lastRaisedAtIso > secondItem.item.firstRaisedAtIso).toBe(true);

    const bytes = await readStateBytes(stateDir);
    const repeat = await useCase.recordAttentionItem(parkBody({ summary: PARK_2_SUMMARY }), 'conductor');
    expect(repeat.outcome).toBe('refreshed');
    expect(repeat).toMatchObject({ revision: 2 });
    expect(await readStateBytes(stateDir)).toEqual(bytes);
    expect(signal.emitted).toHaveLength(2);
  });

  it('keeps a cleared item cleared under its old park and reopens it for a new one', async () => {
    const { useCase, repo, clock } = makeUseCase();
    const first = await useCase.recordAttentionItem(parkBody(), 'conductor');
    expect(first.outcome).toBe('raised');
    const firstOk = mustOk(first);

    const cleared = mustSucceed(mustSucceed(AttentionItem.create(firstOk.item)).clear({ reason: 'dismissed', via: 'cli', by: 'example-owner' }, clock.current()));
    await repo.save(cleared.toRecord(), firstOk.revision);

    const bytes = await readStateBytes(stateDir);
    const reRaise = await useCase.recordAttentionItem(parkBody(), 'conductor');
    expect(reRaise.outcome).toBe('refreshed');
    const reRaiseOk = mustOk(reRaise);
    expect(reRaiseOk.item.state).toBe('cleared');
    expect(reRaiseOk.revision).toBe(firstOk.revision + 1);
    expect(await readStateBytes(stateDir)).toEqual(bytes);

    const reopened = await useCase.recordAttentionItem(parkBody({ summary: PARK_2_SUMMARY }), 'conductor');
    expect(reopened.outcome).toBe('reopened');
    const reopenedOk = mustOk(reopened);
    expect(reopenedOk.item.state).toBe('open');
    expect(reopenedOk.item.raisedCount).toBe(firstOk.item.raisedCount + 1);
  });

  it('writes nothing for an out-of-order re-raise of an older park', async () => {
    const { useCase, repo, signal } = makeUseCase();
    await useCase.recordAttentionItem(parkBody(), 'conductor');
    const second = await useCase.recordAttentionItem(parkBody({ summary: PARK_2_SUMMARY }), 'conductor');
    expect(second.outcome).toBe('refreshed');
    expect(second).toMatchObject({ revision: 2, item: { raisedCount: 2 } });
    const signals = signal.emitted.length;

    const bytes = await readStateBytes(stateDir);
    const stale = await useCase.recordAttentionItem(parkBody(), 'conductor');
    expect(stale.outcome).toBe('refreshed');
    expect(mustOk(stale).item.summary).toBe(PARK_2_SUMMARY);
    expect(mustOk(stale).revision).toBe(2);
    expect(await readStateBytes(stateDir)).toEqual(bytes);
    expect(signal.emitted).toHaveLength(signals);

    const stored = await repo.findByKey(KEY);
    expect(stored?.item.raisedCount).toBe(2);
  });

  it('keeps a cleared item cleared when an older park is re-raised out of order', async () => {
    const { useCase, repo, clock } = makeUseCase();
    await useCase.recordAttentionItem(parkBody(), 'conductor');
    const second = await useCase.recordAttentionItem(parkBody({ summary: PARK_2_SUMMARY }), 'conductor');
    expect(second.outcome).toBe('refreshed');
    const secondOk = mustOk(second);

    const cleared = mustSucceed(mustSucceed(AttentionItem.create(secondOk.item)).clear({ reason: 'dismissed', via: 'cli', by: 'example-owner' }, clock.current()));
    const saved = await repo.save(cleared.toRecord(), secondOk.revision);

    const bytes = await readStateBytes(stateDir);
    const stale = await useCase.recordAttentionItem(parkBody(), 'conductor');
    expect(stale.outcome).toBe('refreshed');
    expect(mustOk(stale).item.state).toBe('cleared');
    expect(mustOk(stale).revision).toBe(saved.revision);
    expect(await readStateBytes(stateDir)).toEqual(bytes);

    // A newer park than the stored one still reopens the cleared item.
    const third = await useCase.recordAttentionItem(parkBody({ summary: `The conductor parked ${RUN_REF} with reason owner-merge (park 3).` }), 'conductor');
    expect(third.outcome).toBe('reopened');
    expect(mustOk(third).item.state).toBe('open');
  });

  it('keeps other kinds refreshing on every repeat', async () => {
    const { useCase } = makeUseCase();
    const body = parkBody({ kind: 'needs-owner', subject: { kind: 'work-order', ref: 'wo-example-1' }, summary: 'example notice' });
    const first = await useCase.recordAttentionItem(body, 'conductor');
    expect(first.outcome).toBe('raised');
    const second = await useCase.recordAttentionItem(body, 'conductor');
    expect(second.outcome).toBe('refreshed');
    expect(second).toMatchObject({ revision: 2, item: { raisedCount: 2 } });
  });
});
