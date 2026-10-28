/**
 * Lane WB3a-3-1 unit tests for the record-and-list owner item use cases.
 *
 * Every refusal path, find-or-create by natural key, the key-conflict race,
 * the minted-id revision conflict, list narrowing and one-entry-per-item-id.
 * The clock and id source are always injected; names are example-only.
 */

import { describe, expect, it } from 'vitest';

import { OwnerItem } from '../../../domain/entities/OwnerItem.js';
import type { OwnerItemRecord } from '../../../domain/owner-item-records.js';
import type {
  OwnerItemClock,
  OwnerItemIdSource,
  RecordOwnerItemResult,
} from '../../ports/in/RecordOwnerItemPort.in-port.js';
import type { ListOwnerItemsRequest } from '../../ports/in/ListOwnerItemsPort.in-port.js';
import type {
  OwnerItemRepositoryPort,
  StoredOwnerItem,
} from '../../ports/out/OwnerItemRepositoryPort.out-port.js';
import { OwnerItemRepositoryAdapter } from '../../../infrastructure/adapters/OwnerItemRepositoryAdapter.adapter.js';
import { ListOwnerItemsUseCase } from '../ListOwnerItemsUseCase.use-case.js';
import { RecordOwnerItemUseCase } from '../RecordOwnerItemUseCase.use-case.js';

const NOW_ISO = '2026-10-27T10:00:00.000Z';

/** Secret-shaped fakes are assembled at runtime from inert pieces; the scanner still recognises the shape. */
function fakeSecretShape(): string {
  return `gh${'p_'}${'A'.repeat(30)}`;
}

/** A clock the composition root would inject; it counts its reads. */
function clock(at: string = NOW_ISO): OwnerItemClock & { calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    nowIso() {
      state.calls += 1;
      return at;
    },
  };
}

/** An id source returning oi-example-1, oi-example-2, ... in order; it counts its reads. */
function ids(): OwnerItemIdSource & { calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    newItemId() {
      state.calls += 1;
      return `oi-example-${state.calls}`;
    },
  };
}

const MERGE_BODY = {
  projectId: 'example-project',
  kind: 'merge',
  subject: null,
  refs: [{ kind: 'pr', repository: 'example-org/example-repo', number: 251 }],
  blocks: [{ kind: 'lane', ref: '2026-10-27_example/A1' }],
};

const DECISION_BODY = {
  projectId: 'example-project',
  kind: 'decision',
  subject: null,
  refs: [{ kind: 'plan-decision', planId: '2026-10-27_example', decisionId: 'D1' }],
  blocks: [],
};

/** Narrow a result to the refused member; throws when it is not one. */
function refusal(
  result: RecordOwnerItemResult,
): Extract<RecordOwnerItemResult, { outcome: 'refused' }> {
  if (result.outcome !== 'refused') {
    throw new Error('expected a refusal');
  }
  return result;
}

describe('RecordOwnerItemUseCase', () => {
  it('records an open merge item from a closed body', async () => {
    const repo = new OwnerItemRepositoryAdapter();
    const uc = new RecordOwnerItemUseCase({ itemRepo: repo, clock: clock(), ids: ids() });

    const result = await uc.recordOwnerItem(MERGE_BODY, 'orch-example-1');

    expect(result).toEqual({
      outcome: 'recorded',
      item: expect.objectContaining({
        itemId: 'oi-example-1',
        projectId: 'example-project',
        kind: 'merge',
        subject: null,
        createdBy: 'orch-example-1',
        createdAtIso: NOW_ISO,
        state: 'open',
      }),
      revision: 1,
    });
    const stored = await repo.get('oi-example-1');
    expect(stored?.item.createdBy).toBe('orch-example-1');
    expect(stored?.revision).toBe(1);
  });

  it('refuses a body that is not exactly the closed record shape', async () => {
    const repo = new OwnerItemRepositoryAdapter();
    const i = ids();
    const uc = new RecordOwnerItemUseCase({ itemRepo: repo, clock: clock(), ids: i });

    const bodies: unknown[] = [
      { ...MERGE_BODY, itemId: 'oi-sneak' },
      { ...MERGE_BODY, createdBy: 'orch-example-1' },
      { ...MERGE_BODY, state: 'open' },
      { ...MERGE_BODY, createdAtIso: NOW_ISO },
      { projectId: 'example-project', kind: 'merge' },
      ['example-project'],
      null,
      42,
    ];
    const results = await Promise.all(
      bodies.map((body) => uc.recordOwnerItem(body, 'orch-example-1')),
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
    const proxyRefused = refusal(await uc.recordOwnerItem(throwingProxy, 'orch-example-1'));
    expect(proxyRefused.code).toBe('request');
    expect(i.calls).toBe(0);

    expect(await repo.list()).toEqual([]);
  });

  it('refuses an unidentified actor; the reason never echoes the input', async () => {
    const repo = new OwnerItemRepositoryAdapter();
    const uc = new RecordOwnerItemUseCase({ itemRepo: repo, clock: clock(), ids: ids() });

    const numberRefused = refusal(await uc.recordOwnerItem(MERGE_BODY, 42 as unknown as string));
    expect(numberRefused.code).toBe('request');
    expect(numberRefused.reason).toBe('RecordOwnerItem the actor could not be identified');
    expect(numberRefused.reason).not.toContain('42');

    const emptyRefused = refusal(await uc.recordOwnerItem(MERGE_BODY, ''));
    expect(emptyRefused.code).toBe('invalid');

    expect(await repo.list()).toEqual([]);
  });

  it('refuses when the clock cannot be read', async () => {
    const repo = new OwnerItemRepositoryAdapter();
    const uc = new RecordOwnerItemUseCase({ itemRepo: repo, clock: clock('not-a-time'), ids: ids() });

    const refused = refusal(await uc.recordOwnerItem(MERGE_BODY, 'orch-example-1'));
    expect(refused.code).toBe('clock');

    expect(await repo.list()).toEqual([]);
  });

  it('passes domain refusals through with the domain code and message', async () => {
    const repo = new OwnerItemRepositoryAdapter();
    const uc = new RecordOwnerItemUseCase({ itemRepo: repo, clock: clock(), ids: ids() });

    const noSubject = refusal(
      await uc.recordOwnerItem({ ...MERGE_BODY, kind: 'other', subject: null }, 'orch-example-1'),
    );
    expect(noSubject.code).toBe('invalid');

    const fake = fakeSecretShape();
    const secretShaped = refusal(
      await uc.recordOwnerItem({ ...MERGE_BODY, subject: fake }, 'orch-example-1'),
    );
    expect(secretShaped.code).toBe('invalid');
    expect(secretShaped.reason).not.toContain(fake);

    expect(await repo.list()).toEqual([]);
  });

  it('is find-or-create: the same merge recorded twice yields the one item', async () => {
    const repo = new OwnerItemRepositoryAdapter();
    const uc = new RecordOwnerItemUseCase({ itemRepo: repo, clock: clock(), ids: ids() });

    const first = await uc.recordOwnerItem(MERGE_BODY, 'orch-example-1');
    expect(first.outcome).toBe('recorded');

    const second = await uc.recordOwnerItem(MERGE_BODY, 'orch-example-2');
    expect(second).toEqual({
      outcome: 'exists',
      item: expect.objectContaining({ itemId: 'oi-example-1', createdBy: 'orch-example-1' }),
      revision: 1,
    });

    expect(await repo.list()).toHaveLength(1);
  });

  it('is find-or-create for decision items by plan-decision and question refs', async () => {
    const repo = new OwnerItemRepositoryAdapter();
    const uc = new RecordOwnerItemUseCase({ itemRepo: repo, clock: clock(), ids: ids() });

    const planFirst = await uc.recordOwnerItem(DECISION_BODY, 'orch-example-1');
    expect(planFirst.outcome).toBe('recorded');
    const planSecond = await uc.recordOwnerItem(DECISION_BODY, 'orch-example-2');
    expect(planSecond.outcome).toBe('exists');
    expect(await repo.list()).toHaveLength(1);

    const questionBody = {
      projectId: 'example-project',
      kind: 'decision',
      subject: null,
      refs: [{ kind: 'question', id: 'q-example-1' }],
      blocks: [],
    };
    const questionFirst = await uc.recordOwnerItem(questionBody, 'orch-example-1');
    expect(questionFirst.outcome).toBe('recorded');
    const questionSecond = await uc.recordOwnerItem(questionBody, 'orch-example-2');
    expect(questionSecond.outcome).toBe('exists');
    expect(await repo.list()).toHaveLength(2);
  });

  it('refuses a key held by an item of another kind, naming the holder', async () => {
    const repo = new OwnerItemRepositoryAdapter();
    const uc = new RecordOwnerItemUseCase({ itemRepo: repo, clock: clock(), ids: ids() });

    const other = await uc.recordOwnerItem(
      {
        projectId: 'example-project',
        kind: 'other',
        subject: 'example follow-up',
        refs: [{ kind: 'question', id: 'q-example-1' }],
        blocks: [],
      },
      'orch-example-1',
    );
    expect(other.outcome).toBe('recorded');

    const decision = await uc.recordOwnerItem(
      {
        projectId: 'example-project',
        kind: 'decision',
        subject: null,
        refs: [{ kind: 'question', id: 'q-example-1' }],
        blocks: [],
      },
      'orch-example-1',
    );
    expect(decision).toEqual({
      outcome: 'key-held',
      heldByItemId: 'oi-example-1',
      reason: 'RecordOwnerItem another owner item holds this natural key',
    });

    expect(await repo.list()).toHaveLength(1);
  });

  it('re-reads the holder when a key is taken between the check and the save', async () => {
    const real = new OwnerItemRepositoryAdapter();
    const direct = OwnerItem.open(
      {
        itemId: 'oi-direct-1',
        projectId: 'example-project',
        kind: 'merge',
        subject: null,
        refs: [{ kind: 'pr', repository: 'example-org/example-repo', number: 251 }],
        blocks: [],
        createdBy: 'orch-example-1',
      },
      NOW_ISO,
    );
    expect(direct.success).toBe(true);
    if (!direct.success) {
      return;
    }
    await real.save(direct.value.toRecord(), 0);

    let lookups = 0;
    const racing: OwnerItemRepositoryPort = {
      async save(item: OwnerItemRecord, expectedRevision: number) {
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
      async list() {
        return real.list();
      },
    };

    const uc = new RecordOwnerItemUseCase({
      itemRepo: racing,
      clock: clock(),
      ids: { newItemId: () => 'oi-example-1' },
    });
    const result = await uc.recordOwnerItem(MERGE_BODY, 'orch-example-1');
    expect(result).toEqual({
      outcome: 'exists',
      item: expect.objectContaining({ itemId: 'oi-direct-1' }),
      revision: 1,
    });
    expect(lookups).toBe(2);
  });

  it('refuses a minted item id that is already taken', async () => {
    const repo = new OwnerItemRepositoryAdapter();
    const uc = new RecordOwnerItemUseCase({
      itemRepo: repo,
      clock: clock(),
      ids: { newItemId: () => 'oi-example-1' },
    });

    const first = await uc.recordOwnerItem(MERGE_BODY, 'orch-example-1');
    expect(first.outcome).toBe('recorded');

    const second = await uc.recordOwnerItem(
      {
        projectId: 'example-project',
        kind: 'merge',
        subject: null,
        refs: [{ kind: 'pr', repository: 'example-org/example-repo', number: 999 }],
        blocks: [],
      },
      'orch-example-1',
    );
    expect(refusal(second).code).toBe('id-taken');
  });

  it('throws Not implemented when unconfigured', async () => {
    await expect(new RecordOwnerItemUseCase().recordOwnerItem({}, 'x')).rejects.toThrow(
      'Not implemented: RecordOwnerItemUseCase',
    );
  });
});

describe('ListOwnerItemsUseCase', () => {
  async function seededStore(): Promise<OwnerItemRepositoryAdapter> {
    const repo = new OwnerItemRepositoryAdapter();

    const mergeOpen = OwnerItem.open(
      {
        itemId: 'oi-example-1',
        projectId: 'example-project',
        kind: 'merge',
        subject: null,
        refs: [{ kind: 'pr', repository: 'example-org/example-repo', number: 251 }],
        blocks: [{ kind: 'lane', ref: '2026-10-27_example/A1' }],
        createdBy: 'orch-example-1',
      },
      NOW_ISO,
    );
    expect(mergeOpen.success).toBe(true);
    if (!mergeOpen.success) {
      return repo;
    }
    await repo.save(mergeOpen.value.toRecord(), 0);

    const decisionOpen = OwnerItem.open(
      {
        itemId: 'oi-example-2',
        projectId: 'example-project',
        kind: 'decision',
        subject: null,
        refs: [{ kind: 'plan-decision', planId: '2026-10-27_example', decisionId: 'D1' }],
        blocks: [{ kind: 'pr', ref: 'example-org/example-repo#251' }],
        createdBy: 'orch-example-1',
      },
      NOW_ISO,
    );
    expect(decisionOpen.success).toBe(true);
    if (!decisionOpen.success) {
      return repo;
    }
    await repo.save(decisionOpen.value.toRecord(), 0);

    const secretOpen = OwnerItem.open(
      {
        itemId: 'oi-example-3',
        projectId: 'example-project',
        kind: 'secret',
        subject: 'example rotation',
        refs: [],
        blocks: [],
        createdBy: 'orch-example-1',
      },
      NOW_ISO,
    );
    expect(secretOpen.success).toBe(true);
    if (!secretOpen.success) {
      return repo;
    }
    const done = secretOpen.value.markDone({ via: 'web', by: 'orch-example-1', atIso: NOW_ISO });
    expect(done.success).toBe(true);
    if (!done.success) {
      return repo;
    }
    await repo.save(done.value.toRecord(), 0);

    return repo;
  }

  it('lists items in store order with gating derived from the record', async () => {
    const repo = await seededStore();
    const uc = new ListOwnerItemsUseCase({ itemRepo: repo });

    const all = await uc.listOwnerItems();
    expect(all.items.map((entry) => entry.item.itemId)).toEqual([
      'oi-example-1',
      'oi-example-2',
      'oi-example-3',
    ]);

    const byId = new Map(all.items.map((entry) => [entry.item.itemId, entry] as const));
    expect(byId.get('oi-example-1')?.gating).toBe(true);
    expect(byId.get('oi-example-1')?.gatedBlocks).toEqual([
      { kind: 'lane', ref: '2026-10-27_example/A1' },
    ]);
    expect(byId.get('oi-example-2')?.gating).toBe(false);
    expect(byId.get('oi-example-2')?.gatedBlocks).toEqual([]);
    expect(byId.get('oi-example-3')?.gating).toBe(false);
    expect(byId.get('oi-example-3')?.gatedBlocks).toEqual([]);
  });

  it('narrows by project, state and kind, combined, and refuses invalid filters', async () => {
    const repo = await seededStore();
    const uc = new ListOwnerItemsUseCase({ itemRepo: repo });

    const byProject = await uc.listOwnerItems({ projectId: 'example-project' });
    expect(byProject.items).toHaveLength(3);

    const byState = await uc.listOwnerItems({ state: 'closed' });
    expect(byState.items.map((entry) => entry.item.itemId)).toEqual(['oi-example-3']);

    const byKind = await uc.listOwnerItems({ kind: 'secret' });
    expect(byKind.items.map((entry) => entry.item.itemId)).toEqual(['oi-example-3']);

    const combined = await uc.listOwnerItems({
      projectId: 'example-project',
      state: 'closed',
      kind: 'secret',
    });
    expect(combined.items.map((entry) => entry.item.itemId)).toEqual(['oi-example-3']);

    expect((await uc.listOwnerItems({ state: 'XYZZY' } as unknown as ListOwnerItemsRequest)).items).toEqual([]);
    expect((await uc.listOwnerItems({ kind: 'XYZZY' } as unknown as ListOwnerItemsRequest)).items).toEqual([]);
    expect((await uc.listOwnerItems({ projectId: 42 } as unknown as ListOwnerItemsRequest)).items).toEqual([]);
  });

  it('lists everything when no argument or a non-object argument is given', async () => {
    const repo = await seededStore();
    const uc = new ListOwnerItemsUseCase({ itemRepo: repo });

    expect((await uc.listOwnerItems()).items).toHaveLength(3);
    expect((await uc.listOwnerItems('x' as unknown as ListOwnerItemsRequest)).items).toHaveLength(3);
  });

  it('lists one entry per item id even when the store repeats an entry', async () => {
    const real = new OwnerItemRepositoryAdapter();
    const opened = OwnerItem.open(
      {
        itemId: 'oi-example-1',
        projectId: 'example-project',
        kind: 'merge',
        subject: null,
        refs: [{ kind: 'pr', repository: 'example-org/example-repo', number: 251 }],
        blocks: [{ kind: 'lane', ref: '2026-10-27_example/A1' }],
        createdBy: 'orch-example-1',
      },
      NOW_ISO,
    );
    expect(opened.success).toBe(true);
    if (!opened.success) {
      return;
    }
    const stored: StoredOwnerItem = await real.save(opened.value.toRecord(), 0);

    const duplicate: OwnerItemRepositoryPort = {
      async save(item: OwnerItemRecord, expectedRevision: number) {
        return real.save(item, expectedRevision);
      },
      async get(itemId: string) {
        return real.get(itemId);
      },
      async findByKey(key: string) {
        return real.findByKey(key);
      },
      async list() {
        return [stored, stored];
      },
    };

    const uc = new ListOwnerItemsUseCase({ itemRepo: duplicate });
    const result = await uc.listOwnerItems();
    expect(result.items.map((entry) => entry.item.itemId)).toEqual(['oi-example-1']);
  });

  it('throws Not implemented when unconfigured', async () => {
    await expect(new ListOwnerItemsUseCase().listOwnerItems()).rejects.toThrow(
      'Not implemented: ListOwnerItemsUseCase',
    );
  });
});

describe('WB3a-3-2 required regression: record after a domain close', () => {
  it('returns exists with revision 2 when the same merge body is recorded after the stored item is closed', async () => {
    const repo = new OwnerItemRepositoryAdapter();
    const useCase = new RecordOwnerItemUseCase({ itemRepo: repo, clock: clock(), ids: ids() });

    const first = await useCase.recordOwnerItem(MERGE_BODY, 'orch-example-1');
    expect(first.outcome).toBe('recorded');

    const stored = await repo.get('oi-example-1');
    expect(stored).not.toBeNull();
    if (stored === null) {
      return;
    }
    const loaded = OwnerItem.create(stored.item);
    expect(loaded.success).toBe(true);
    if (!loaded.success) {
      return;
    }
    const merged = loaded.value.observePullRequest({
      repository: 'example-org/example-repo',
      number: 251,
      state: 'merged',
      source: 'merge-record',
      observedAtIso: NOW_ISO,
    });
    expect(merged.success).toBe(true);
    if (!merged.success) {
      return;
    }
    await repo.save(merged.value.toRecord(), stored.revision);

    const second = await useCase.recordOwnerItem(MERGE_BODY, 'orch-example-2');
    expect(second).toEqual({
      outcome: 'exists',
      item: expect.objectContaining({ itemId: 'oi-example-1', state: 'closed' }),
      revision: 2,
    });

    expect(await repo.list()).toHaveLength(1);
  });
});
