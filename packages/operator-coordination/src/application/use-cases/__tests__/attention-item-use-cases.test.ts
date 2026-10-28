/**
 * Lane AM3b-3 unit tests for the record-and-clear attention item use cases.
 *
 * Raise, refresh, reopen, every refusal path, the key-conflict race, the
 * minted-id revision conflict, dismiss by id at the revision read, resolve
 * by key, work-order-merged and the Not implemented throws. The clock and
 * id source are always injected; names are example-only.
 */

import { describe, expect, it } from 'vitest';

import { AttentionItem } from '../../../domain/entities/AttentionItem.js';
import type { AttentionItemRecord } from '../../../domain/attention-item-records.js';
import type {
  AttentionClock,
  AttentionItemIdSource,
  RecordAttentionItemResult,
} from '../../ports/in/RecordAttentionItemPort.in-port.js';
import type {
  AttentionItemClearVia,
  ClearAttentionItemResult,
  ClearAttentionItemPort,
} from '../../ports/in/ClearAttentionItemPort.in-port.js';
import type {
  AttentionItemRepositoryPort,
} from '../../ports/out/AttentionItemRepositoryPort.out-port.js';
import { AttentionItemRepositoryAdapter } from '../../../infrastructure/adapters/AttentionItemRepositoryAdapter.adapter.js';
import { ClearAttentionItemUseCase } from '../ClearAttentionItemUseCase.use-case.js';
import { RecordAttentionItemUseCase } from '../RecordAttentionItemUseCase.use-case.js';

const NOW_ISO = '2026-10-27T10:00:00.000Z';
const LATER_ISO = '2026-10-27T11:00:00.000Z';

/** A clock the composition root would inject; it returns the next value in order and counts its reads. */
function clock(at: string | readonly string[] = NOW_ISO): AttentionClock & { calls: number } {
  const queue = Array.isArray(at) ? [...at] : [at];
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    nowIso() {
      state.calls += 1;
      return queue.length > 1 ? (queue.shift() as string) : queue[0];
    },
  };
}

/** An id source returning att-example-1, att-example-2, ... in order; it counts its reads. */
function ids(): AttentionItemIdSource & { calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    newItemId() {
      state.calls += 1;
      return `att-example-${state.calls}`;
    },
  };
}

const RAISE_BODY = {
  projectId: 'example-project',
  kind: 'merge',
  subject: { kind: 'work-order', ref: 'wo-example-1' },
  workOrderId: 'wo-example-1',
  summary: 'Merge blocked on a failed check',
};

/** Narrow a result to the refused member; throws when it is not one. */
function refusal(
  result: RecordAttentionItemResult | ClearAttentionItemResult,
): Extract<RecordAttentionItemResult | ClearAttentionItemResult, { outcome: 'refused' }> {
  if (result.outcome !== 'refused') {
    throw new Error('expected a refusal');
  }
  return result;
}

/** A repository fake whose every method throws; override the ones a test needs to succeed. */
function throwingRepo(overrides: Partial<AttentionItemRepositoryPort> = {}): AttentionItemRepositoryPort {
  const boom = () => {
    throw new Error('boom');
  };
  return {
    save: boom,
    get: boom,
    findByKey: boom,
    list: boom,
    ...overrides,
  };
}

describe('RecordAttentionItemUseCase', () => {
  it('raises a new open item from a closed body at revision 1', async () => {
    const repo = new AttentionItemRepositoryAdapter();
    const i = ids();
    const uc = new RecordAttentionItemUseCase({ itemRepo: repo, clock: clock(), ids: i });

    const result = await uc.recordAttentionItem(RAISE_BODY, 'auto-merge');

    expect(result).toEqual({
      outcome: 'raised',
      item: expect.objectContaining({
        itemId: 'att-example-1',
        projectId: 'example-project',
        kind: 'merge',
        subject: { kind: 'work-order', ref: 'wo-example-1' },
        workOrderId: 'wo-example-1',
        state: 'open',
        raisedBy: 'auto-merge',
        firstRaisedAtIso: NOW_ISO,
        lastRaisedAtIso: NOW_ISO,
        raisedCount: 1,
        clearance: null,
      }),
      revision: 1,
    });
    expect(i.calls).toBe(1);
    const stored = await repo.get('att-example-1');
    expect(stored?.item.raisedBy).toBe('auto-merge');
    expect(stored?.revision).toBe(1);
  });

  it('refreshes an open item in place instead of creating a second one', async () => {
    const repo = new AttentionItemRepositoryAdapter();
    const i = ids();
    const uc = new RecordAttentionItemUseCase({ itemRepo: repo, clock: clock([NOW_ISO, LATER_ISO]), ids: i });

    const first = await uc.recordAttentionItem(RAISE_BODY, 'auto-merge');
    expect(first.outcome).toBe('raised');

    const second = await uc.recordAttentionItem(RAISE_BODY, 'auto-merge');
    expect(second).toEqual({
      outcome: 'refreshed',
      item: expect.objectContaining({
        itemId: 'att-example-1',
        raisedBy: 'auto-merge',
        firstRaisedAtIso: NOW_ISO,
        lastRaisedAtIso: LATER_ISO,
        raisedCount: 2,
        state: 'open',
      }),
      revision: 2,
    });
    expect(i.calls).toBe(2);
    expect(await repo.list()).toHaveLength(1);
  });

  it('reopens a cleared item in place and empties its clearance', async () => {
    const repo = new AttentionItemRepositoryAdapter();
    const clear = new ClearAttentionItemUseCase({ itemRepo: repo, clock: clock([NOW_ISO, LATER_ISO]) });
    const raise = new RecordAttentionItemUseCase({ itemRepo: repo, clock: clock([NOW_ISO, LATER_ISO, LATER_ISO]), ids: ids() });

    const first = await raise.recordAttentionItem(RAISE_BODY, 'auto-merge');
    expect(first.outcome).toBe('raised');

    const dismissed = await clear.clearAttentionItem(
      { action: 'dismiss', itemId: 'att-example-1', expectedRevision: 1 },
      'cli',
      'owner-example-1',
    );
    expect(dismissed.outcome).toBe('cleared');

    const second = await raise.recordAttentionItem(RAISE_BODY, 'auto-merge');
    expect(second).toEqual({
      outcome: 'reopened',
      item: expect.objectContaining({
        itemId: 'att-example-1',
        state: 'open',
        raisedCount: 2,
        clearance: null,
      }),
      revision: 3,
    });
    expect(await repo.list()).toHaveLength(1);
  });

  it('refuses a body that is not exactly the closed record shape and nothing is saved', async () => {
    const repo = new AttentionItemRepositoryAdapter();
    const i = ids();
    const uc = new RecordAttentionItemUseCase({ itemRepo: repo, clock: clock(), ids: i });

    const bodies: unknown[] = [
      { ...RAISE_BODY, itemId: 'att-sneak' },
      { ...RAISE_BODY, raisedBy: 'auto-merge' },
      { ...RAISE_BODY, state: 'open' },
      { ...RAISE_BODY, lastRaisedAtIso: NOW_ISO },
      { projectId: 'example-project', kind: 'merge' },
      ['example-project'],
      null,
      42,
    ];
    const results = await Promise.all(
      bodies.map((body) => uc.recordAttentionItem(body, 'auto-merge')),
    );
    for (const result of results) {
      expect(refusal(result).code).toBe('request');
    }
    expect(i.calls).toBe(0);

    const throwingProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('boom');
        },
      },
    );
    const proxyRefused = refusal(await uc.recordAttentionItem(throwingProxy, 'auto-merge'));
    expect(proxyRefused.code).toBe('request');
    expect(i.calls).toBe(0);

    expect(await repo.list()).toEqual([]);
  });

  it('refuses a bad kind, a worktree ref that is a path, a bad summary and a secret-shaped summary', async () => {
    const repo = new AttentionItemRepositoryAdapter();
    const uc = new RecordAttentionItemUseCase({ itemRepo: repo, clock: clock(), ids: ids() });

    const badKind = refusal(
      await uc.recordAttentionItem({ ...RAISE_BODY, kind: 'Bad Kind' }, 'auto-merge'),
    );
    expect(badKind.code).toBe('invalid');

    const pathSubject = refusal(
      await uc.recordAttentionItem(
        { ...RAISE_BODY, subject: { kind: 'worktree', ref: 'worktrees/example' } },
        'auto-merge',
      ),
    );
    expect(pathSubject.code).toBe('invalid');

    const badSummary = refusal(
      await uc.recordAttentionItem({ ...RAISE_BODY, summary: 'x'.repeat(1025) }, 'auto-merge'),
    );
    expect(badSummary.code).toBe('invalid');

    const fake = `gh${'p_'}${'B'.repeat(30)}`;
    const secretShaped = refusal(
      await uc.recordAttentionItem({ ...RAISE_BODY, summary: fake }, 'auto-merge'),
    );
    expect(secretShaped.code).toBe('invalid');
    expect(secretShaped.reason).not.toContain(fake);

    expect(await repo.list()).toEqual([]);
  });

  it('re-reads the holder when a key is taken between the check and the save', async () => {
    const real = new AttentionItemRepositoryAdapter();
    const direct = AttentionItem.raise(
      {
        itemId: 'att-direct-1',
        projectId: 'example-project',
        kind: 'merge',
        subject: { kind: 'work-order', ref: 'wo-example-1' },
        workOrderId: 'wo-example-1',
        summary: 'Raised directly',
        raisedBy: 'auto-merge',
      },
      NOW_ISO,
    );
    expect(direct.success).toBe(true);
    if (!direct.success) {
      return;
    }
    await real.save(direct.value.toRecord(), 0);

    let lookups = 0;
    const racing: AttentionItemRepositoryPort = {
      async save(item: AttentionItemRecord, expectedRevision: number) {
        return real.save(item, expectedRevision);
      },
      async get(itemId: string) {
        return real.get(itemId);
      },
      async findByKey(key: string) {
        lookups += 1;
        if (lookups === 1) {
          return null;
        }
        return real.findByKey(key);
      },
      async list(query) {
        return real.list(query);
      },
    };

    const uc = new RecordAttentionItemUseCase({
      itemRepo: racing,
      clock: clock([NOW_ISO, LATER_ISO]),
      ids: { newItemId: () => 'att-example-1' },
    });
    const result = await uc.recordAttentionItem(RAISE_BODY, 'auto-merge');
    expect(result).toEqual({
      outcome: 'refreshed',
      item: expect.objectContaining({ itemId: 'att-direct-1' }),
      revision: 2,
    });
    expect(lookups).toBe(2);
    expect(await real.list()).toHaveLength(1);
  });

  it('refuses a minted item id that is already taken', async () => {
    const repo = new AttentionItemRepositoryAdapter();
    const uc = new RecordAttentionItemUseCase({
      itemRepo: repo,
      clock: clock(),
      ids: { newItemId: () => 'att-example-1' },
    });

    const first = await uc.recordAttentionItem(RAISE_BODY, 'auto-merge');
    expect(first.outcome).toBe('raised');

    const second = await uc.recordAttentionItem(
      {
        projectId: 'example-project',
        kind: 'merge',
        subject: { kind: 'work-order', ref: 'wo-example-2' },
        workOrderId: 'wo-example-2',
        summary: 'Another blocked merge',
      },
      'auto-merge',
    );
    expect(refusal(second).code).toBe('id-taken');
    expect(await repo.list()).toHaveLength(1);
  });

  it('refuses store-unreadable when the repository read throws during record', async () => {
    const uc = new RecordAttentionItemUseCase({ itemRepo: throwingRepo(), clock: clock(), ids: ids() });

    const result = refusal(await uc.recordAttentionItem(RAISE_BODY, 'auto-merge'));
    expect(result.code).toBe('store-unreadable');
    expect(result.reason).not.toContain('boom');
  });

  it('refuses store-unreadable when the repository save throws during record', async () => {
    const real = new AttentionItemRepositoryAdapter();
    const repo = throwingRepo({
      save: async () => {
        throw new Error('boom');
      },
      get: (itemId) => real.get(itemId),
      findByKey: (key) => real.findByKey(key),
      list: (query) => real.list(query),
    });
    const uc = new RecordAttentionItemUseCase({ itemRepo: repo, clock: clock(), ids: ids() });

    const result = refusal(await uc.recordAttentionItem(RAISE_BODY, 'auto-merge'));
    expect(result.code).toBe('store-unreadable');
    expect(result.reason).not.toContain('boom');
  });

  it('refreshes an existing open item with a changed summary and stores the new summary', async () => {
    const repo = new AttentionItemRepositoryAdapter();
    const uc = new RecordAttentionItemUseCase({ itemRepo: repo, clock: clock([NOW_ISO, LATER_ISO]), ids: ids() });

    const first = await uc.recordAttentionItem(RAISE_BODY, 'auto-merge');
    expect(first.outcome).toBe('raised');

    const second = await uc.recordAttentionItem(
      { ...RAISE_BODY, summary: 'Merge unblocked after a retry' },
      'auto-merge',
    );
    expect(second).toEqual({
      outcome: 'refreshed',
      item: expect.objectContaining({
        itemId: 'att-example-1',
        summary: 'Merge unblocked after a retry',
        raisedCount: 2,
      }),
      revision: 2,
    });

    const stored = await repo.get('att-example-1');
    expect(stored?.item.summary).toBe('Merge unblocked after a retry');
  });

  it('throws Not implemented when unconfigured', async () => {
    await expect(new RecordAttentionItemUseCase().recordAttentionItem({}, 'x')).rejects.toThrow(
      'Not implemented: RecordAttentionItemUseCase',
    );
  });
});

describe('ClearAttentionItemUseCase', () => {
  async function seededOpen(
    overrides: Partial<{ itemId: string; kind: string; subject: { kind: string; ref: string }; workOrderId: string | null; summary: string }> = {},
  ): Promise<AttentionItemRecord> {
    const raised = AttentionItem.raise(
      {
        itemId: overrides.itemId ?? 'att-example-1',
        projectId: 'example-project',
        kind: overrides.kind ?? 'merge',
        subject: overrides.subject ?? { kind: 'work-order', ref: 'wo-example-1' },
        workOrderId: overrides.workOrderId === undefined ? 'wo-example-1' : overrides.workOrderId,
        summary: overrides.summary ?? 'Merge blocked on a failed check',
        raisedBy: 'auto-merge',
      },
      NOW_ISO,
    );
    if (!raised.success) {
      throw new Error(raised.error.message);
    }
    return raised.value.toRecord();
  }

  it('dismisses one item by id at the revision read', async () => {
    const repo = new AttentionItemRepositoryAdapter();
    const uc = new ClearAttentionItemUseCase({ itemRepo: repo, clock: clock([NOW_ISO, LATER_ISO]) });
    await repo.save(await seededOpen(), 0);

    const wrongRevision = await uc.clearAttentionItem(
      { action: 'dismiss', itemId: 'att-example-1', expectedRevision: 7 },
      'cli',
      'owner-example-1',
    );
    expect(refusal(wrongRevision).code).toBe('stale-revision');

    const missing = await uc.clearAttentionItem(
      { action: 'dismiss', itemId: 'att-missing-1', expectedRevision: 1 },
      'cli',
      'owner-example-1',
    );
    expect(missing).toEqual({ outcome: 'not-found' });

    const cleared = await uc.clearAttentionItem(
      { action: 'dismiss', itemId: 'att-example-1', expectedRevision: 1 },
      'cli',
      'owner-example-1',
    );
    expect(cleared).toEqual({
      outcome: 'cleared',
      items: [expect.objectContaining({
        item: expect.objectContaining({
          itemId: 'att-example-1',
          state: 'cleared',
          clearance: { reason: 'dismissed', via: 'cli', by: 'owner-example-1', atIso: LATER_ISO },
        }),
        revision: 2,
      })],
    });

    const again = await uc.clearAttentionItem(
      { action: 'dismiss', itemId: 'att-example-1', expectedRevision: 2 },
      'cli',
      'owner-example-1',
    );
    expect(again).toEqual({
      outcome: 'unchanged',
      items: [expect.objectContaining({ item: expect.objectContaining({ itemId: 'att-example-1' }), revision: 2 })],
    });
    expect(await repo.list()).toHaveLength(1);
  });

  it('resolves by key with reason stale, and an unknown key is not-found', async () => {
    const repo = new AttentionItemRepositoryAdapter();
    const uc = new ClearAttentionItemUseCase({ itemRepo: repo, clock: clock([LATER_ISO]) });
    await repo.save(await seededOpen(), 0);

    const cleared = await uc.clearAttentionItem(
      {
        action: 'resolve',
        projectId: 'example-project',
        kind: 'merge',
        subject: { kind: 'work-order', ref: 'wo-example-1' },
        reason: 'stale',
      },
      'machine',
      'reaper-example-1',
    );
    expect(cleared).toEqual({
      outcome: 'cleared',
      items: [expect.objectContaining({
        item: expect.objectContaining({
          itemId: 'att-example-1',
          state: 'cleared',
          clearance: { reason: 'stale', via: 'machine', by: 'reaper-example-1', atIso: LATER_ISO },
        }),
        revision: 2,
      })],
    });

    const again = await uc.clearAttentionItem(
      {
        action: 'resolve',
        projectId: 'example-project',
        kind: 'merge',
        subject: { kind: 'work-order', ref: 'wo-example-1' },
        reason: 'stale',
      },
      'machine',
      'reaper-example-1',
    );
    expect(again).toEqual({
      outcome: 'unchanged',
      items: [expect.objectContaining({ item: expect.objectContaining({ itemId: 'att-example-1' }), revision: 2 })],
    });

    const unknown = await uc.clearAttentionItem(
      {
        action: 'resolve',
        projectId: 'example-project',
        kind: 'merge',
        subject: { kind: 'work-order', ref: 'wo-example-9' },
        reason: 'stale',
      },
      'machine',
      'reaper-example-1',
    );
    expect(unknown).toEqual({ outcome: 'not-found' });
    expect(await repo.list()).toHaveLength(1);
  });

  it('clears every open item of a merged work order, and again is unchanged with an empty list', async () => {
    const repo = new AttentionItemRepositoryAdapter();
    const uc = new ClearAttentionItemUseCase({ itemRepo: repo, clock: clock(NOW_ISO) });
    await repo.save(await seededOpen({ itemId: 'att-example-1', kind: 'merge' }), 0);
    await repo.save(
      await seededOpen({ itemId: 'att-example-2', kind: 'conflict', summary: 'Conflicts with main' }),
      0,
    );
    await repo.save(
      await seededOpen({
        itemId: 'att-example-3',
        kind: 'merge',
        subject: { kind: 'work-order', ref: 'wo-example-3' },
        workOrderId: 'wo-example-2',
      }),
      0,
    );

    const cleared = await uc.clearAttentionItem(
      { action: 'work-order-merged', projectId: 'example-project', workOrderId: 'wo-example-1' },
      'machine',
      'auto-merge',
    );
    expect(cleared.outcome).toBe('cleared');
    if (cleared.outcome !== 'cleared') {
      return;
    }
    expect(cleared.items.map((entry) => entry.item.itemId)).toEqual(['att-example-1', 'att-example-2']);
    for (const entry of cleared.items) {
      expect(entry.item.state).toBe('cleared');
      expect(entry.item.clearance).toEqual({ reason: 'merged', via: 'machine', by: 'auto-merge', atIso: NOW_ISO });
    }

    const again = await uc.clearAttentionItem(
      { action: 'work-order-merged', projectId: 'example-project', workOrderId: 'wo-example-1' },
      'machine',
      'auto-merge',
    );
    expect(again).toEqual({ outcome: 'unchanged', items: [] });

    const listed = await repo.list();
    expect(listed).toHaveLength(3);
    expect(listed.find((entry) => entry.item.itemId === 'att-example-3')?.item.state).toBe('open');
  });

  it('refuses unknown actions, wrong shapes, a non-integer expectedRevision, a bad via and an unidentified actor', async () => {
    const repo = new AttentionItemRepositoryAdapter();
    const uc = new ClearAttentionItemUseCase({ itemRepo: repo, clock: clock() });
    await repo.save(await seededOpen(), 0);

    const badVia = await uc.clearAttentionItem(
      { action: 'dismiss', itemId: 'att-example-1', expectedRevision: 1 },
      'carrier-pigeon' as unknown as AttentionItemClearVia,
      'owner-example-1',
    );
    expect(refusal(badVia).code).toBe('request');

    const badActor = await uc.clearAttentionItem(
      { action: 'dismiss', itemId: 'att-example-1', expectedRevision: 1 },
      'cli',
      42 as unknown as string,
    );
    const badActorRefusal = refusal(badActor);
    expect(badActorRefusal.code).toBe('request');
    expect(badActorRefusal.reason).not.toContain('42');

    const badRequest = await uc.clearAttentionItem(
      { action: 'dismiss', itemId: 'att-example-1', expectedRevision: 1.5 },
      'cli',
      'owner-example-1',
    );
    expect(refusal(badRequest).code).toBe('request');

    const badReason = await uc.clearAttentionItem(
      {
        action: 'resolve',
        projectId: 'example-project',
        kind: 'merge',
        subject: { kind: 'work-order', ref: 'wo-example-1' },
        reason: 'because',
      },
      'machine',
      'reaper-example-1',
    );
    expect(refusal(badReason).code).toBe('request');

    const bodies: unknown[] = [
      { action: 'dismiss', itemId: 'att-example-1' },
      { action: 'dismiss', itemId: 'att-example-1', expectedRevision: 1, via: 'cli' },
      { action: 'deploy', itemId: 'att-example-1', expectedRevision: 1 },
      { action: 'dismiss', itemId: 42, expectedRevision: 1 },
      null,
      42,
    ];
    for (const body of bodies) {
      expect(refusal(await uc.clearAttentionItem(body, 'cli', 'owner-example-1')).code).toBe('request');
    }
    expect((await repo.list())[0]?.item.state).toBe('open');
  });

  it('refuses store-unreadable when the repository read throws during dismiss', async () => {
    const uc = new ClearAttentionItemUseCase({ itemRepo: throwingRepo(), clock: clock() });

    const result = refusal(
      await uc.clearAttentionItem(
        { action: 'dismiss', itemId: 'att-example-1', expectedRevision: 1 },
        'cli',
        'owner-example-1',
      ),
    );
    expect(result.code).toBe('store-unreadable');
    expect(result.reason).not.toContain('boom');
  });

  it('refuses store-unreadable when the repository save throws during dismiss', async () => {
    const real = new AttentionItemRepositoryAdapter();
    await real.save(await seededOpen(), 0);
    const repo = throwingRepo({
      save: async () => {
        throw new Error('boom');
      },
      get: (itemId) => real.get(itemId),
      findByKey: (key) => real.findByKey(key),
      list: (query) => real.list(query),
    });
    const uc = new ClearAttentionItemUseCase({ itemRepo: repo, clock: clock([NOW_ISO, LATER_ISO]) });

    const result = refusal(
      await uc.clearAttentionItem(
        { action: 'dismiss', itemId: 'att-example-1', expectedRevision: 1 },
        'cli',
        'owner-example-1',
      ),
    );
    expect(result.code).toBe('store-unreadable');
    expect(result.reason).not.toContain('boom');
  });

  it('refuses store-unreadable when the repository read throws during resolve', async () => {
    const uc = new ClearAttentionItemUseCase({ itemRepo: throwingRepo(), clock: clock() });

    const result = refusal(
      await uc.clearAttentionItem(
        {
          action: 'resolve',
          projectId: 'example-project',
          kind: 'merge',
          subject: { kind: 'work-order', ref: 'wo-example-1' },
          reason: 'stale',
        },
        'machine',
        'reaper-example-1',
      ),
    );
    expect(result.code).toBe('store-unreadable');
    expect(result.reason).not.toContain('boom');
  });

  it('refuses store-unreadable when the repository read throws during work-order-merged', async () => {
    const uc = new ClearAttentionItemUseCase({ itemRepo: throwingRepo(), clock: clock() });

    const result = refusal(
      await uc.clearAttentionItem(
        { action: 'work-order-merged', projectId: 'example-project', workOrderId: 'wo-example-1' },
        'machine',
        'auto-merge',
      ),
    );
    expect(result.code).toBe('store-unreadable');
    expect(result.reason).not.toContain('boom');
  });

  it('refuses resolve with a reason other than resolved or stale and saves nothing', async () => {
    const repo = new AttentionItemRepositoryAdapter();
    const uc = new ClearAttentionItemUseCase({ itemRepo: repo, clock: clock() });
    await repo.save(await seededOpen(), 0);

    for (const reason of ['dismissed', 'merged']) {
      const result = refusal(
        await uc.clearAttentionItem(
          {
            action: 'resolve',
            projectId: 'example-project',
            kind: 'merge',
            subject: { kind: 'work-order', ref: 'wo-example-1' },
            reason,
          },
          'machine',
          'reaper-example-1',
        ),
      );
      expect(result.code).toBe('request');
    }

    const stored = (await repo.list())[0];
    expect(stored?.item.state).toBe('open');
    expect(stored?.revision).toBe(1);
  });

  it('throws Not implemented when unconfigured', async () => {
    await expect(
      (new ClearAttentionItemUseCase() as ClearAttentionItemPort).clearAttentionItem({}, 'cli', 'x'),
    ).rejects.toThrow('Not implemented: ClearAttentionItemUseCase');
  });
});
