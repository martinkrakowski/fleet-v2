import { describe, expect, it } from 'vitest';

import { planAttentionCompaction } from './attention-compaction.js';
import type { AttentionItemClearanceRecord, AttentionItemRecord } from './attention-item-records.js';

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

describe('planAttentionCompaction', () => {
  it('marks an open run item stale when its run ref is terminal (rule 1)', () => {
    const plan = planAttentionCompaction({
      items: [makeItem({ itemId: 'att-a', subject: { kind: 'run', ref: 'run-1' } })],
      terminalRunRefs: ['run-1'],
    });
    expect(plan.staleItemIds).toEqual(['att-a']);
  });

  it('never marks a cleared item stale, even when its run is terminal (rule 2)', () => {
    const plan = planAttentionCompaction({
      items: [
        makeItem({
          itemId: 'att-a',
          state: 'cleared',
          clearance: CLEARANCE,
          subject: { kind: 'run', ref: 'run-1' },
        }),
      ],
      terminalRunRefs: ['run-1'],
    });
    expect(plan.staleItemIds).toEqual([]);
  });

  it('never marks a non-run subject stale, even when its ref equals a terminal run ref (rule 3)', () => {
    const plan = planAttentionCompaction({
      items: [
        makeItem({
          itemId: 'att-a',
          subject: { kind: 'work-order', ref: 'run-1' },
        }),
      ],
      terminalRunRefs: ['run-1'],
    });
    expect(plan.staleItemIds).toEqual([]);
  });

  it('compares refs by exact string equality, without normalising (rule 4)', () => {
    const plan = planAttentionCompaction({
      items: [
        makeItem({ itemId: 'att-a', subject: { kind: 'run', ref: 'Run-1' } }),
        makeItem({ itemId: 'att-b', subject: { kind: 'run', ref: 'run-1 ' } }),
      ],
      terminalRunRefs: ['run-1'],
    });
    expect(plan.staleItemIds).toEqual([]);
  });

  it('preserves item order and emits each id at most once, even when duplicated (rule 5)', () => {
    const plan = planAttentionCompaction({
      items: [
        makeItem({ itemId: 'att-b', subject: { kind: 'run', ref: 'run-1' } }),
        makeItem({ itemId: 'att-a', subject: { kind: 'run', ref: 'run-1' } }),
        makeItem({ itemId: 'att-b', subject: { kind: 'run', ref: 'run-1' } }),
        makeItem({ itemId: 'att-c', subject: { kind: 'run', ref: 'run-9' } }),
      ],
      terminalRunRefs: ['run-1', 'run-2'],
    });
    expect(plan.staleItemIds).toEqual(['att-b', 'att-a']);
  });

  it('yields an empty plan for empty items, empty terminal refs, and non-terminal runs (rule 6)', () => {
    expect(planAttentionCompaction({ items: [], terminalRunRefs: ['run-1'] }).staleItemIds).toEqual([]);
    expect(
      planAttentionCompaction({
        items: [makeItem({ itemId: 'att-a', subject: { kind: 'run', ref: 'run-1' } })],
        terminalRunRefs: [],
      }).staleItemIds,
    ).toEqual([]);
    expect(
      planAttentionCompaction({
        items: [makeItem({ itemId: 'att-a', subject: { kind: 'run', ref: 'run-9' } })],
        terminalRunRefs: ['run-1'],
      }).staleItemIds,
    ).toEqual([]);
  });

  it('never throws, returns a frozen plan, and never hands back a caller-owned array (rule 7)', () => {
    const items = [makeItem({ itemId: 'att-a', subject: { kind: 'run', ref: 'run-1' } })];
    const plan = planAttentionCompaction({ items, terminalRunRefs: ['run-1'] });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.staleItemIds)).toBe(true);

    const emptyOne = planAttentionCompaction({ items: [], terminalRunRefs: [] });
    const emptyTwo = planAttentionCompaction({ items: [], terminalRunRefs: [] });
    expect(emptyOne.staleItemIds).toEqual([]);
    expect(emptyOne.staleItemIds).not.toBe(emptyTwo.staleItemIds);
    expect(plan.staleItemIds).not.toBe(items);
  });
});
