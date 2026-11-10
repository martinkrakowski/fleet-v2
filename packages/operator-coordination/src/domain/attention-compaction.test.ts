import { describe, expect, it } from 'vitest';

import {
  ATTENTION_COMPACTION_MAX_ITEMS,
  ATTENTION_COMPACTION_MAX_REFS,
  ATTENTION_COMPACTION_MAX_STRING,
  planAttentionCompaction,
} from './attention-compaction.js';
import type { AttentionCompactionResult } from './attention-compaction.js';
import type {
  AttentionItemClearanceRecord,
  AttentionItemRecord,
  AttentionItemState,
  AttentionItemSubjectKind,
  AttentionItemSubjectRecord,
} from './attention-item-records.js';

const CLEARANCE: AttentionItemClearanceRecord = {
  reason: 'stale',
  via: 'machine',
  by: 'test',
  atIso: '2026-11-08T00:00:00.000Z',
};

function makeItem(overrides: Partial<AttentionItemRecord> = {}): AttentionItemRecord {
  return {
    itemId: 'att-1',
    projectId: 'example-project',
    kind: 'sample-kind',
    subject: { kind: 'run', ref: 'run-1' },
    workOrderId: null,
    summary: 'a sample attention item',
    state: 'open',
    raisedBy: 'test',
    firstRaisedAtIso: '2026-11-01T00:00:00.000Z',
    lastRaisedAtIso: '2026-11-01T00:00:00.000Z',
    raisedCount: 1,
    clearance: null,
    ...overrides,
  };
}

function expectRefusal(result: AttentionCompactionResult): void {
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.code).toBe('invalid');
    expect(result.error.message).toBe('AttentionCompaction input could not be read');
  }
}

describe('planAttentionCompaction', () => {
  it('marks an open run item stale when its run ref is terminal (rule 1)', () => {
    const result = planAttentionCompaction({
      items: [makeItem({ itemId: 'att-a', subject: { kind: 'run', ref: 'run-1' } })],
      terminalRunRefs: ['run-1'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.staleItemIds).toEqual(['att-a']);
    }
  });

  it('never marks a cleared item stale, even when its run is terminal (rule 2)', () => {
    const result = planAttentionCompaction({
      items: [
        makeItem({
          itemId: 'att-a',
          state: 'cleared',
          clearance: CLEARANCE,
          subject: { kind: 'run', ref: 'run-1' },
        }),
        makeItem({ itemId: 'att-open', subject: { kind: 'run', ref: 'run-1' } }),
      ],
      terminalRunRefs: ['run-1'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.staleItemIds).toEqual(['att-open']);
    }
  });

  it('never marks a non-run subject stale, even when its ref equals a terminal run ref (rule 3)', () => {
    const result = planAttentionCompaction({
      items: [
        makeItem({
          itemId: 'att-a',
          subject: { kind: 'work-order', ref: 'run-1' },
        }),
        makeItem({ itemId: 'att-run', subject: { kind: 'run', ref: 'run-1' } }),
      ],
      terminalRunRefs: ['run-1'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.staleItemIds).toEqual(['att-run']);
    }
  });

  it('compares refs by exact string equality, without normalising (rule 4)', () => {
    const result = planAttentionCompaction({
      items: [
        makeItem({ itemId: 'att-a', subject: { kind: 'run', ref: 'Run-1' } }),
        makeItem({ itemId: 'att-b', subject: { kind: 'run', ref: 'run_1' } }),
        makeItem({ itemId: 'att-exact', subject: { kind: 'run', ref: 'run-1' } }),
      ],
      terminalRunRefs: ['run-1'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.staleItemIds).toEqual(['att-exact']);
    }
  });

  it('preserves item order and emits each id at most once, even when duplicated (rule 5)', () => {
    const result = planAttentionCompaction({
      items: [
        makeItem({ itemId: 'att-b', subject: { kind: 'run', ref: 'run-1' } }),
        makeItem({ itemId: 'att-a', subject: { kind: 'run', ref: 'run-1' } }),
        makeItem({ itemId: 'att-b', subject: { kind: 'run', ref: 'run-1' } }),
        makeItem({ itemId: 'att-c', subject: { kind: 'run', ref: 'run-9' } }),
      ],
      terminalRunRefs: ['run-1', 'run-2'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.staleItemIds).toEqual(['att-b', 'att-a']);
    }
  });

  it('yields an empty plan for empty items, empty terminal refs, and non-terminal runs, and plans a matching run (rule 6)', () => {
    const emptyOne = planAttentionCompaction({ items: [], terminalRunRefs: ['run-1'] });
    const emptyTwo = planAttentionCompaction({
      items: [makeItem({ itemId: 'att-a', subject: { kind: 'run', ref: 'run-1' } })],
      terminalRunRefs: [],
    });
    const emptyThree = planAttentionCompaction({
      items: [makeItem({ itemId: 'att-a', subject: { kind: 'run', ref: 'run-9' } })],
      terminalRunRefs: ['run-1'],
    });
    const matched = planAttentionCompaction({
      items: [makeItem({ itemId: 'att-a', subject: { kind: 'run', ref: 'run-1' } })],
      terminalRunRefs: ['run-1'],
    });

    expect(emptyOne.success).toBe(true);
    if (emptyOne.success) {
      expect(emptyOne.value.staleItemIds).toEqual([]);
    }
    expect(emptyTwo.success).toBe(true);
    if (emptyTwo.success) {
      expect(emptyTwo.value.staleItemIds).toEqual([]);
    }
    expect(emptyThree.success).toBe(true);
    if (emptyThree.success) {
      expect(emptyThree.value.staleItemIds).toEqual([]);
    }
    expect(matched.success).toBe(true);
    if (matched.success) {
      expect(matched.value.staleItemIds).toEqual(['att-a']);
    }
  });

  it('returns a frozen plan, never hands back a caller-owned array, and returns a fresh array each call (rule 7)', () => {
    const item = makeItem({ itemId: 'att-a', subject: { kind: 'run', ref: 'run-1' } });
    Object.freeze(item.subject);
    Object.freeze(item);
    const items = Object.freeze([item]);
    const terminalRunRefs = Object.freeze(['run-1']);

    const result = planAttentionCompaction({ items, terminalRunRefs });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.staleItemIds)).toBe(true);
      expect(result.value.staleItemIds).toEqual(['att-a']);
      expect(result.value.staleItemIds).not.toBe(items);
      expect(result.value.staleItemIds).not.toBe(terminalRunRefs);
    }

    const emptyOne = planAttentionCompaction({ items: [], terminalRunRefs: [] });
    const emptyTwo = planAttentionCompaction({ items: [], terminalRunRefs: [] });
    expect(emptyOne.success).toBe(true);
    expect(emptyTwo.success).toBe(true);
    if (emptyOne.success && emptyTwo.success) {
      expect(emptyOne.value.staleItemIds).toEqual([]);
      expect(emptyOne.value.staleItemIds).not.toBe(emptyTwo.value.staleItemIds);
      expect(Object.isFrozen(emptyOne.value)).toBe(true);
      expect(Object.isFrozen(emptyOne.value.staleItemIds)).toBe(true);
      expect(Object.isFrozen(emptyTwo.value)).toBe(true);
      expect(Object.isFrozen(emptyTwo.value.staleItemIds)).toBe(true);
    }
  });

  it('refuses null, undefined, and a non-record argument', () => {
    expectRefusal(planAttentionCompaction(null));
    expectRefusal(planAttentionCompaction(undefined));
    expectRefusal(planAttentionCompaction(42));
    expectRefusal(planAttentionCompaction(true));
    expectRefusal(planAttentionCompaction(['x']));
  });

  it('refuses an envelope missing items or terminalRunRefs', () => {
    expectRefusal(planAttentionCompaction({ items: [] }));
    expectRefusal(planAttentionCompaction({ terminalRunRefs: [] }));
  });

  it('refuses a non-array items value', () => {
    expectRefusal(planAttentionCompaction({ items: 'x', terminalRunRefs: [] }));
    const arrayLike = { length: 1, 0: makeItem() };
    expectRefusal(planAttentionCompaction({ items: arrayLike, terminalRunRefs: [] }));
  });

  it('refuses a string terminalRunRefs instead of iterating its characters', () => {
    const result = planAttentionCompaction({
      items: [makeItem({ itemId: 'att-a', subject: { kind: 'run', ref: 'S' } })],
      terminalRunRefs: 'SENTINEL-VALUE',
    });
    expectRefusal(result);
  });

  it('refuses a non-string terminal run ref', () => {
    const result = planAttentionCompaction({
      items: [makeItem({ itemId: 'att-a', subject: { kind: 'run', ref: 'run-1' } })],
      terminalRunRefs: ['run-1', 42],
    });
    expectRefusal(result);
  });

  it('refuses an over-long items or terminalRunRefs array', () => {
    const tooManyItems = Array.from({ length: ATTENTION_COMPACTION_MAX_ITEMS + 1 }, (_, i) =>
      makeItem({ itemId: `att-${i}`, subject: { kind: 'run', ref: 'run-1' } }),
    );
    expectRefusal(planAttentionCompaction({ items: tooManyItems, terminalRunRefs: [] }));

    const tooManyRefs = Array.from({ length: ATTENTION_COMPACTION_MAX_REFS + 1 }, (_, i) => `ref-${i}`);
    expectRefusal(planAttentionCompaction({ items: [], terminalRunRefs: tooManyRefs }));
  });

  it('refuses an over-long string', () => {
    const overLong = 'x'.repeat(ATTENTION_COMPACTION_MAX_STRING + 1);
    expectRefusal(
      planAttentionCompaction({
        items: [makeItem({ itemId: overLong, subject: { kind: 'run', ref: 'run-1' } })],
        terminalRunRefs: ['run-1'],
      }),
    );
    expectRefusal(
      planAttentionCompaction({
        items: [makeItem({ itemId: 'att-a', subject: { kind: 'run', ref: overLong } })],
        terminalRunRefs: ['run-1'],
      }),
    );
    expectRefusal(
      planAttentionCompaction({
        items: [makeItem({ itemId: 'att-a', subject: { kind: 'run', ref: 'run-1' } })],
        terminalRunRefs: [overLong],
      }),
    );
  });

  it('refuses a sparse items array', () => {
    const sparse = new Array(2);
    sparse[0] = makeItem({ itemId: 'att-a', subject: { kind: 'run', ref: 'run-1' } });
    expectRefusal(planAttentionCompaction({ items: sparse, terminalRunRefs: ['run-1'] }));
  });

  it('refuses a null item', () => {
    const result = planAttentionCompaction({
      items: [makeItem({ itemId: 'att-a', subject: { kind: 'run', ref: 'run-1' } }), null],
      terminalRunRefs: ['run-1'],
    });
    expectRefusal(result);
  });

  it('refuses a non-record item', () => {
    class Foo {}
    const stringItem = planAttentionCompaction({
      items: [makeItem({ itemId: 'att-a', subject: { kind: 'run', ref: 'run-1' } }), 'junk'],
      terminalRunRefs: ['run-1'],
    });
    expectRefusal(stringItem);

    const classItem = planAttentionCompaction({
      items: [makeItem({ itemId: 'att-a', subject: { kind: 'run', ref: 'run-1' } }), new Foo()],
      terminalRunRefs: ['run-1'],
    });
    expectRefusal(classItem);
  });

  it('refuses a missing or non-string itemId', () => {
    const missingId = makeItem({ itemId: 'att-a', subject: { kind: 'run', ref: 'run-1' } }) as {
      itemId?: string;
    };
    delete missingId.itemId;
    expectRefusal(planAttentionCompaction({ items: [missingId], terminalRunRefs: ['run-1'] }));

    const nonStringId = makeItem({ itemId: 'att-a', subject: { kind: 'run', ref: 'run-1' } });
    (nonStringId as { itemId: unknown }).itemId = 1;
    expectRefusal(planAttentionCompaction({ items: [nonStringId], terminalRunRefs: ['run-1'] }));
  });

  it('refuses an itemId that is not a printable id', () => {
    expectRefusal(
      planAttentionCompaction({
        items: [makeItem({ itemId: '', subject: { kind: 'run', ref: 'run-1' } })],
        terminalRunRefs: ['run-1'],
      }),
    );
    expectRefusal(
      planAttentionCompaction({
        items: [makeItem({ itemId: 'has space', subject: { kind: 'run', ref: 'run-1' } })],
        terminalRunRefs: ['run-1'],
      }),
    );
  });

  it('refuses a secret-shaped itemId', () => {
    expectRefusal(
      planAttentionCompaction({
        items: [makeItem({ itemId: 'ghp_abcdefghijklmnopqrstuvwxyz123456', subject: { kind: 'run', ref: 'run-1' } })],
        terminalRunRefs: ['run-1'],
      }),
    );
  });

  it('refuses a run subject ref that is not a valid slug (space)', () => {
    expectRefusal(
      planAttentionCompaction({
        items: [makeItem({ itemId: 'att-a', subject: { kind: 'run', ref: 'run 1' } })],
        terminalRunRefs: ['run 1'],
      }),
    );
  });

  it('refuses a terminalRunRef that is not a valid run slug (space)', () => {
    expectRefusal(
      planAttentionCompaction({
        items: [makeItem({ itemId: 'att-a', subject: { kind: 'run', ref: 'run-1' } })],
        terminalRunRefs: ['run 1'],
      }),
    );
  });

  it('refuses a worktree subject ref that is not a wt- digest', () => {
    expectRefusal(
      planAttentionCompaction({
        items: [makeItem({ itemId: 'att-a', subject: { kind: 'worktree', ref: 'not-a-digest' } })],
        terminalRunRefs: ['run-1'],
      }),
    );
  });

  it('refuses a pr subject ref that is not owner/repo#number', () => {
    expectRefusal(
      planAttentionCompaction({
        items: [makeItem({ itemId: 'att-a', subject: { kind: 'pr', ref: 'invalid-ref' } })],
        terminalRunRefs: ['run-1'],
      }),
    );
  });

  it('refuses a project subject ref that is not a project id', () => {
    expectRefusal(
      planAttentionCompaction({
        items: [makeItem({ itemId: 'att-a', subject: { kind: 'project', ref: 'has space' } })],
        terminalRunRefs: ['run-1'],
      }),
    );
  });

  it('refuses an attempt subject ref that is not a slug', () => {
    expectRefusal(
      planAttentionCompaction({
        items: [makeItem({ itemId: 'att-a', subject: { kind: 'attempt', ref: 'has space' } })],
        terminalRunRefs: ['run-1'],
      }),
    );
  });

  it('refuses a reservation subject ref that is not a slug', () => {
    expectRefusal(
      planAttentionCompaction({
        items: [makeItem({ itemId: 'att-a', subject: { kind: 'reservation', ref: 'has space' } })],
        terminalRunRefs: ['run-1'],
      }),
    );
  });

  it('refuses a work-order subject ref that is not a slug', () => {
    expectRefusal(
      planAttentionCompaction({
        items: [makeItem({ itemId: 'att-a', subject: { kind: 'work-order', ref: 'has space' } })],
        terminalRunRefs: ['run-1'],
      }),
    );
  });

  it('refuses an item whose subject cannot be read', () => {
    const missingSubject = makeItem({ itemId: 'att-a', subject: { kind: 'run', ref: 'run-1' } }) as {
      subject?: AttentionItemSubjectRecord;
    };
    delete missingSubject.subject;
    expectRefusal(planAttentionCompaction({ items: [missingSubject], terminalRunRefs: ['run-1'] }));

    expectRefusal(
      planAttentionCompaction({
        items: [makeItem({ itemId: 'att-a', subject: null as unknown as AttentionItemSubjectRecord })],
        terminalRunRefs: ['run-1'],
      }),
    );

    expectRefusal(
      planAttentionCompaction({
        items: [makeItem({ itemId: 'att-a', subject: { ref: 'run-1' } as unknown as AttentionItemSubjectRecord })],
        terminalRunRefs: ['run-1'],
      }),
    );

    expectRefusal(
      planAttentionCompaction({
        items: [makeItem({ itemId: 'att-a', subject: { kind: 'run' } as unknown as AttentionItemSubjectRecord })],
        terminalRunRefs: ['run-1'],
      }),
    );

    const clearedBesideStale = planAttentionCompaction({
      items: [
        makeItem({ itemId: 'att-a', subject: { kind: 'run', ref: 'run-1' } }),
        makeItem({
          itemId: 'att-cleared',
          state: 'cleared',
          clearance: CLEARANCE,
          subject: null as unknown as AttentionItemSubjectRecord,
        }),
      ],
      terminalRunRefs: ['run-1'],
    });
    expectRefusal(clearedBesideStale);
  });

  it('refuses an unknown state', () => {
    const result = planAttentionCompaction({
      items: [
        makeItem({ itemId: 'att-a', subject: { kind: 'run', ref: 'run-1' } }),
        makeItem({
          itemId: 'att-pending',
          state: 'pending' as AttentionItemState,
          subject: { kind: 'run', ref: 'run-1' },
        }),
      ],
      terminalRunRefs: ['run-1'],
    });
    expectRefusal(result);
  });

  it('refuses an unknown subject kind', () => {
    const result = planAttentionCompaction({
      items: [
        makeItem({ itemId: 'att-a', subject: { kind: 'run', ref: 'run-1' } }),
        makeItem({
          itemId: 'att-host',
          subject: { kind: 'host' as AttentionItemSubjectKind, ref: 'run-1' },
        }),
      ],
      terminalRunRefs: ['run-1'],
    });
    expectRefusal(result);
  });

  it('refuses a throwing getter on a decision field without running it', () => {
    for (const field of ['itemId', 'state', 'subject'] as const) {
      let ran = false;
      const item = makeItem({ itemId: 'att-a', subject: { kind: 'run', ref: 'run-1' } });
      Object.defineProperty(item, field, {
        enumerable: true,
        configurable: true,
        get() {
          ran = true;
          throw new Error('boom');
        },
      });
      const result = planAttentionCompaction({ items: [item], terminalRunRefs: ['run-1'] });
      expectRefusal(result);
      expect(ran).toBe(false);
    }
  });

  it('refuses a proxy whose descriptor trap throws', () => {
    const proxy = new Proxy(
      { itemId: 'att-a', state: 'open', subject: { kind: 'run', ref: 'run-1' } },
      {
        getOwnPropertyDescriptor() {
          throw new Error('trap');
        },
      },
    );
    const result = planAttentionCompaction({ items: [proxy], terminalRunRefs: ['run-1'] });
    expectRefusal(result);
  });

  it('plans a matching item when the array iterator throws', () => {
    const item = makeItem({ itemId: 'att-a', subject: { kind: 'run', ref: 'run-1' } });
    const items = new Proxy([item], {
      [Symbol.iterator]() {
        throw new Error('iterator');
      },
    } as unknown as ProxyHandler<AttentionItemRecord[]>);
    const result = planAttentionCompaction({ items, terminalRunRefs: ['run-1'] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.staleItemIds).toEqual(['att-a']);
    }
  });

  it('plans a matching item when an unread field is a throwing getter', () => {
    const item = makeItem({ itemId: 'att-a', subject: { kind: 'run', ref: 'run-1' } });
    Object.defineProperty(item, 'summary', {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error('boom');
      },
    });
    const result = planAttentionCompaction({ items: [item], terminalRunRefs: ['run-1'] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.staleItemIds).toEqual(['att-a']);
    }
  });
});
