/**
 * Lane VB01 unit tests for ListAttentionItemsUseCase.
 *
 * The unconfigured Not implemented throw before any validation, every invalid
 * filter returning an empty list with zero repository calls, the exact query
 * shape passed to itemRepo.list, result mapping with deduplication by itemId
 * (first wins, order preserved), the read-only guarantee, non-object requests
 * treated as empty filters, hostile getters and proxies, prototype-polluting
 * keys, and repository failure propagation. The repository is always an
 * in-memory fake over small example-only fixtures; no filesystem, subprocess,
 * network or timers, every check O(1) or O(n) over a handful of items.
 */

import { describe, expect, it } from 'vitest';

import type { AttentionItemRecord } from '../../../domain/attention-item-records.js';
import type {
  AttentionItemListQuery,
  AttentionItemRepositoryPort,
  StoredAttentionItem,
} from '../../ports/out/AttentionItemRepositoryPort.out-port.js';
import { ListAttentionItemsUseCase } from '../ListAttentionItemsUseCase.use-case.js';

/** A valid AttentionItemRecord with example-only values; overrides replace fields wholesale. */
function makeItemRecord(itemId: string, overrides: Partial<AttentionItemRecord> = {}): AttentionItemRecord {
  return {
    itemId,
    projectId: 'example-project',
    kind: 'merge',
    subject: { kind: 'work-order', ref: 'wo-example-1' },
    workOrderId: 'wo-example-1',
    summary: 'Merge blocked on a failed check',
    state: 'open',
    raisedBy: 'example-raiser',
    firstRaisedAtIso: '2026-10-27T10:00:00.000Z',
    lastRaisedAtIso: '2026-10-27T10:00:00.000Z',
    raisedCount: 1,
    clearance: null,
    ...overrides,
  };
}

/** A StoredAttentionItem for itemId, at revision 1 unless overridden. */
function makeStoredItem(itemId: string, overrides: { revision?: number } & Partial<AttentionItemRecord> = {}): StoredAttentionItem {
  const { revision = 1, ...itemOverrides } = overrides;
  return { revision, item: makeItemRecord(itemId, itemOverrides) };
}

/** The exact query shape the use case must pass to itemRepo.list for empty filters. */
const EMPTY_QUERY: AttentionItemListQuery = {
  projectId: undefined,
  state: undefined,
  kind: undefined,
  workOrderId: undefined,
};

/**
 * An in-memory fake AttentionItemRepositoryPort. Every list call records its
 * query; save, get and findByKey throw so a write or non-list read fails the
 * test loudly, and writesAttempted counts attempted write/non-list calls.
 * Cost: recording is O(1) per call over a tiny in-memory array.
 */
function makeFakeRepo(entries: readonly StoredAttentionItem[] = []) {
  const recordedQueries: (AttentionItemListQuery | undefined)[] = [];
  const writesAttempted: string[] = [];
  const refuseWrite = (method: string) => {
    writesAttempted.push(method);
    throw new Error('unexpected write or non-list call');
  };
  const repo = {
    get writesAttempted() {
      return [...writesAttempted];
    },
    get recordedQueries() {
      return [...recordedQueries];
    },
    save: (_item: AttentionItemRecord, _expectedRevision: number): Promise<StoredAttentionItem> => refuseWrite('save'),
    get: (_itemId: string): Promise<StoredAttentionItem | null> => refuseWrite('get'),
    findByKey: (_key: string): Promise<StoredAttentionItem | null> => refuseWrite('findByKey'),
    list: (query?: AttentionItemListQuery): Promise<readonly StoredAttentionItem[]> => {
      recordedQueries.push(query);
      return Promise.resolve(entries);
    },
  } satisfies AttentionItemRepositoryPort & {
    readonly writesAttempted: string[];
    readonly recordedQueries: (AttentionItemListQuery | undefined)[];
  };
  return repo;
}

/** A use case configured with the fake repo. */
function makeUseCase(entries: readonly StoredAttentionItem[] = []) {
  const itemRepo = makeFakeRepo(entries);
  const useCase = new ListAttentionItemsUseCase({ itemRepo });
  return { useCase, itemRepo };
}

describe('ListAttentionItemsUseCase', () => {
  it('throws Not implemented before validating even a malformed request when built with no dependencies', async () => {
    // Asserts the constructor with no deps produces a use case whose message
    // starts with 'Not implemented:' and that this check precedes request
    // validation, for three malformed requests.
    const useCase = new ListAttentionItemsUseCase();
    await expect(useCase.execute(null)).rejects.toThrow(/^Not implemented:/);
    await expect(useCase.execute('bad')).rejects.toThrow(/^Not implemented:/);
    await expect(useCase.execute({ state: 'closed' })).rejects.toThrow(/^Not implemented:/);
  });

  it('returns an empty list without calling itemRepo.list for empty projectId or workOrderId', async () => {
    // Asserts projectId === '' and workOrderId === '' are both invalid filters:
    // { items: [] } and zero list calls. The empty check is O(1) on a string.
    const { useCase, itemRepo } = makeUseCase([makeStoredItem('att-example-1')]);
    await expect(useCase.execute({ projectId: '' })).resolves.toEqual({ items: [] });
    await expect(useCase.execute({ workOrderId: '' })).resolves.toEqual({ items: [] });
    expect(itemRepo.recordedQueries.length).toBe(0);
  });

  it('returns an empty list without calling itemRepo.list for non-string or pattern-invalid kind', async () => {
    // Asserts kind = 123 (non-string), 'Merge' (uppercase), '1kind' (leading
    // digit) and a 65-char kind all fail ATTENTION_ITEM_KIND_PATTERN or the
    // string check: { items: [] } and zero list calls. Pattern test is O(n) in
    // the kind length, bounded here at 65.
    const { useCase, itemRepo } = makeUseCase([makeStoredItem('att-example-1')]);
    await expect(useCase.execute({ kind: 123 as unknown as string })).resolves.toEqual({ items: [] });
    await expect(useCase.execute({ kind: 'Merge' })).resolves.toEqual({ items: [] });
    await expect(useCase.execute({ kind: '1kind' })).resolves.toEqual({ items: [] });
    await expect(useCase.execute({ kind: 'a'.repeat(65) })).resolves.toEqual({ items: [] });
    expect(itemRepo.recordedQueries.length).toBe(0);
  });

  it('returns an empty list without calling itemRepo.list for a state outside ATTENTION_ITEM_STATES', async () => {
    // Asserts state 'closed' (not in ['open', 'cleared']) returns { items: [] }
    // and never reaches the repository. The membership check is O(1) over a
    // two-element array.
    const { useCase, itemRepo } = makeUseCase([makeStoredItem('att-example-1')]);
    await expect(useCase.execute({ state: 'closed' as never })).resolves.toEqual({ items: [] });
    expect(itemRepo.recordedQueries.length).toBe(0);
  });

  it('passes the exact filter fields to itemRepo.list for a full valid filter', async () => {
    // Asserts a fully specified valid request forwards exactly its four
    // fields, no more and no fewer, to itemRepo.list.
    const { useCase, itemRepo } = makeUseCase([makeStoredItem('att-example-1')]);
    await useCase.execute({
      projectId: 'example-project',
      state: 'open',
      kind: 'merge',
      workOrderId: 'wo-example-1',
    });
    expect(itemRepo.recordedQueries).toEqual([
      { projectId: 'example-project', state: 'open', kind: 'merge', workOrderId: 'wo-example-1' },
    ]);
  });

  it('passes a query of undefined fields to itemRepo.list when the request is empty or absent', async () => {
    // Asserts {} and undefined requests pass the four-field query with every
    // field undefined — not an empty object, and not the request itself.
    const { useCase, itemRepo } = makeUseCase([makeStoredItem('att-example-1')]);
    await useCase.execute({});
    await useCase.execute(undefined);
    expect(itemRepo.recordedQueries).toEqual([EMPTY_QUERY, EMPTY_QUERY]);
  });

  it('maps stored entries to items with their revisions, in repository order', async () => {
    // Asserts each stored entry surfaces as { item, revision } with the same
    // item object and revision value, in the order the repository returned.
    const first = makeStoredItem('att-example-1', { revision: 3 });
    const second = makeStoredItem('att-example-2', {
      revision: 1,
      kind: 'park',
      workOrderId: null,
      subject: { kind: 'project', ref: 'example-project' },
    });
    const { useCase, itemRepo } = makeUseCase([first, second]);
    const result = await useCase.execute();
    expect(result.items).toEqual([
      { item: first.item, revision: 3 },
      { item: second.item, revision: 1 },
    ]);
    expect(itemRepo.writesAttempted).toEqual([]);
  });

  it('preserves item and revision, deduplicates by itemId (first wins), and never calls write methods', async () => {
    // Asserts a duplicate itemId keeps the first entry in first-seen order and
    // drops the later one, and that save, get and findByKey were never
    // invoked — the fake throws on them and writesAttempted stays empty, so a
    // call would both throw and be counted. Dedup is O(n) over tiny fixtures.
    const kept = makeStoredItem('att-example-1', { revision: 2 });
    const duplicate = makeStoredItem('att-example-1', {
      revision: 9,
      summary: 'A later duplicate raise that must be dropped',
    });
    const after = makeStoredItem('att-example-2');
    const { useCase, itemRepo } = makeUseCase([kept, duplicate, after]);
    const result = await useCase.execute();
    expect(result.items).toEqual([
      { item: kept.item, revision: 2 },
      { item: after.item, revision: 1 },
    ]);
    expect(itemRepo.writesAttempted).toEqual([]);
  });

  it('treats non-object requests (null, string) and arrays as empty filter objects', async () => {
    // Asserts null, a string and an array are all read as {} — the array case
    // explicitly: under current behaviour typeof [] === 'object' and [] !==
    // null, so [] is cast to a request whose keys yield all undefined and is
    // treated exactly like {}. Each still reaches itemRepo.list with the
    // four-undefined query shape. (Note: [] treated as {} is current
    // behaviour, not a guarantee that arrays are valid requests generally.)
    const { useCase, itemRepo } = makeUseCase([makeStoredItem('att-example-1')]);
    await useCase.execute(null);
    await useCase.execute('not-an-object');
    await useCase.execute(['ignored']);
    expect(itemRepo.recordedQueries).toEqual([EMPTY_QUERY, EMPTY_QUERY, EMPTY_QUERY]);
    expect(itemRepo.writesAttempted).toEqual([]);
  });

  it('rejects before calling itemRepo.list when a request getter or Proxy trap throws', async () => {
    // Asserts a throwing getter on projectId, and a Proxy whose get trap
    // throws, surface the thrown error before the repository is touched.
    // Reading request.projectId runs the getter; the failure propagates as a
    // rejection with zero list calls, no swallowing. (A Proxy that lies
    // consistently in every trap is an accepted residual, not tested here.)
    const { useCase, itemRepo } = makeUseCase([makeStoredItem('att-example-1')]);
    const getterRequest = {
      get projectId(): string {
        throw new Error('getter refused');
      },
    };
    await expect(useCase.execute(getterRequest)).rejects.toThrow('getter refused');
    const proxyRequest = new Proxy(
      {},
      {
        get(): never {
          throw new Error('proxy trap refused');
        },
      },
    );
    await expect(useCase.execute(proxyRequest)).rejects.toThrow('proxy trap refused');
    expect(itemRepo.recordedQueries.length).toBe(0);
    expect(itemRepo.writesAttempted).toEqual([]);
  });

  it('ignores prototype-polluting keys on the request without polluting Object.prototype', async () => {
    // Asserts a request built from JSON.parse('{"__proto__":{...}}') leaves
    // Object.prototype untouched — the use case reads only its four named
    // fields — and still issues the four-undefined query. Constant-time
    // property reads; no key enumeration at all.
    const polluted = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    const { useCase, itemRepo } = makeUseCase([makeStoredItem('att-example-1')]);
    await useCase.execute(polluted);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(itemRepo.recordedQueries).toEqual([EMPTY_QUERY]);
    // A `constructor` own key must likewise be ignored rather than read as a filter.
    const ctor = JSON.parse('{"constructor":{"prototype":{"polluted":true}}}') as Record<string, unknown>;
    await useCase.execute(ctor);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(itemRepo.recordedQueries).toEqual([EMPTY_QUERY, EMPTY_QUERY]);
  });

  it('propagates errors thrown by itemRepo.list without swallowing them', async () => {
    // Asserts a rejecting repository surfaces its error unchanged — never a
    // fabricated empty list or success.
    const itemRepo = makeFakeRepo([]);
    itemRepo.list = () => Promise.reject(new Error('list failed'));
    const useCase = new ListAttentionItemsUseCase({ itemRepo });
    await expect(useCase.execute({ projectId: 'example-project' })).rejects.toThrow('list failed');
  });
});
