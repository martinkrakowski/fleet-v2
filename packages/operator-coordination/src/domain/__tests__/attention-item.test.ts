import { describe, expect, it } from 'vitest';

import { attentionItemKey, AttentionItem } from '../entities/AttentionItem.js';
import type { AttentionItemResult } from '../entities/AttentionItem.js';
import type { AttentionItemRecord } from '../attention-item-records.js';

/**
 * Secret-shaped fakes are assembled at runtime from inert pieces so this file
 * never contains a credential-shaped literal; the scanner still recognises the
 * shape, which is the point under test.
 */
function fakeSecretShape(): string {
  return `gh${'p_'}${'A'.repeat(30)}`;
}

const NOW = '2026-10-28T10:00:00.000Z';
const LATER = '2026-10-28T10:10:00.000Z';

const RAISE_BODY = {
  itemId: 'att-example-1',
  projectId: 'example-project',
  kind: 'owner-merge',
  subject: { kind: 'work-order', ref: 'wo-example-1' },
  workOrderId: 'wo-example-1',
  summary: 'Needs an owner merge: one-way door named in the brief',
  raisedBy: 'auto-merge',
};

function raiseNow(overrides: Record<string, unknown> = {}): AttentionItem {
  const result = AttentionItem.raise({ ...RAISE_BODY, ...overrides }, NOW);
  if (!result.success) {
    throw new Error(`test setup raise was refused: ${result.error.message}`);
  }
  return result.value;
}

function raiseResult(overrides: Record<string, unknown> = {}, atIso: string = NOW) {
  return AttentionItem.raise({ ...RAISE_BODY, ...overrides }, atIso);
}

describe('AttentionItem', () => {
  it('raises an open item with count 1, both times NOW and no clearance', () => {
    const item = raiseNow();
    expect(item.getState()).toBe('open');
    expect(item.getId()).toBe('att-example-1');
    expect(item.getProjectId()).toBe('example-project');
    expect(item.getWorkOrderId()).toBe('wo-example-1');
    const record = item.toRecord();
    expect(record.raisedCount).toBe(1);
    expect(record.firstRaisedAtIso).toBe(NOW);
    expect(record.lastRaisedAtIso).toBe(NOW);
    expect(record.clearance).toBeNull();
    expect(record.raisedBy).toBe('auto-merge');
  });

  it('round-trips toRecord() through create and is immune to mutation of the returned record', () => {
    const item = raiseNow();
    const record = item.toRecord();
    const roundTrip = AttentionItem.create(record);
    expect(roundTrip.success).toBe(true);
    if (!roundTrip.success) {
      return;
    }
    expect(roundTrip.value.toRecord()).toEqual(record);
    expect(() => {
      (record as { summary: string }).summary = 'changed';
    }).toThrow();
    const mutatedSpread: AttentionItemRecord = { ...record, summary: 'changed elsewhere' };
    expect(item.toRecord()).toEqual(record);
    expect(item.toRecord().summary).not.toBe(mutatedSpread.summary);
  });

  it('builds its key from project, subject and kind and distinguishes subjects', () => {
    const item = raiseNow();
    const expected = JSON.stringify(['attention', 'example-project', 'work-order', 'wo-example-1', 'owner-merge']);
    expect(attentionItemKey('example-project', { kind: 'work-order', ref: 'wo-example-1' }, 'owner-merge')).toBe(expected);
    expect(item.key()).toBe(expected);
    const otherSubject = attentionItemKey('example-project', { kind: 'pr', ref: 'example-org/example-repo#1' }, 'owner-merge');
    expect(otherSubject).not.toBe(expected);
  });

  it('refuses one bad field at a time without echoing the input', () => {
    const extraKey = { ...RAISE_BODY, extra: 1 };
    expect(raiseResult(extraKey).success).toBe(false);
    const missingKey = { ...RAISE_BODY };
    delete (missingKey as Record<string, unknown>).summary;
    expect(AttentionItem.raise(missingKey, NOW).success).toBe(false);
    const arrayRefusal = AttentionItem.raise([1, 2, 3], NOW);
    expect(arrayRefusal.success).toBe(false);
    if (!arrayRefusal.success) {
      expect(arrayRefusal.error.message).not.toContain('1');
      expect(arrayRefusal.error.message).not.toContain('2');
      expect(arrayRefusal.error.message).not.toContain('3');
    }
    expect(AttentionItem.raise(null, NOW).success).toBe(false);
    const ownKeysThrowing = new Proxy(
      {},
      {
        ownKeys(): never {
          throw new Error('ownKeys refused');
        },
      },
    );
    expect(AttentionItem.raise(ownKeysThrowing, NOW).success).toBe(false);
    expect(raiseResult({ projectId: 'not a project id' }).success).toBe(false);
    expect(raiseResult({ kind: 'Owner_Merge' }).success).toBe(false);
    expect(raiseResult({ subject: { kind: 'host', ref: 'wo-example-1' } }).success).toBe(false);
    expect(raiseResult({ subject: { kind: 'worktree', ref: '/srv/example/wt' } }).success).toBe(false);
    expect(raiseResult({ subject: { kind: 'worktree', ref: 'wt-XYZ' } }).success).toBe(false);
    expect(raiseResult({ subject: { kind: 'pr', ref: 'example-org/example-repo#0' } }).success).toBe(false);
    expect(raiseResult({ summary: '' }).success).toBe(false);
    expect(raiseResult({ summary: 'a'.repeat(1025) }).success).toBe(false);
    expect(raiseResult({ summary: 'two\nlines' }).success).toBe(false);
    expect(raiseResult({ summary: 'reversed‮text' }).success).toBe(false);
    expect(raiseResult({ summary: fakeSecretShape() }).success).toBe(false);
    expect(raiseResult({ raisedBy: 'auto merge' }).success).toBe(false);
    expect(raiseResult({ raisedBy: fakeSecretShape() }).success).toBe(false);
  });

  it('raises again on an open item: count 2, new last time, same first time and id', () => {
    const item = raiseNow();
    const again = item.raiseAgain(
      {
        kind: 'owner-merge',
        subject: { kind: 'work-order', ref: 'wo-example-1' },
        workOrderId: 'wo-example-1',
        summary: 'Needs an owner merge: still parked',
        raisedBy: 'auto-merge',
      },
      LATER,
    );
    expect(again.success).toBe(true);
    if (!again.success) {
      return;
    }
    const record = again.value.toRecord();
    expect(record.raisedCount).toBe(2);
    expect(record.lastRaisedAtIso).toBe(LATER);
    expect(record.firstRaisedAtIso).toBe(NOW);
    expect(record.itemId).toBe('att-example-1');
    expect(record.state).toBe('open');
    expect(record.summary).toBe('Needs an owner merge: still parked');
  });

  it('refuses a later raise that names another key, work order or an earlier time', () => {
    const item = raiseNow();
    const body = {
      kind: 'owner-merge',
      subject: { kind: 'work-order', ref: 'wo-example-1' },
      workOrderId: 'wo-example-1',
      summary: 'Needs an owner merge: still parked',
      raisedBy: 'auto-merge',
    };
    const otherKind = item.raiseAgain({ ...body, kind: 'merge-integrity' }, LATER);
    expect(otherKind.success).toBe(false);
    if (!otherKind.success) {
      expect(otherKind.code).toBe('key');
    }
    const otherSubject = item.raiseAgain({ ...body, subject: { kind: 'pr', ref: 'example-org/example-repo#1' } }, LATER);
    expect(otherSubject.success).toBe(false);
    if (!otherSubject.success) {
      expect(otherSubject.code).toBe('key');
    }
    const otherWorkOrder = item.raiseAgain({ ...body, workOrderId: 'wo-example-2' }, LATER);
    expect(otherWorkOrder.success).toBe(false);
    if (!otherWorkOrder.success) {
      expect(otherWorkOrder.code).toBe('key');
    }
    const earlier = item.raiseAgain(body, '2026-10-28T09:59:59.000Z');
    expect(earlier.success).toBe(false);
    if (!earlier.success) {
      expect(earlier.code).toBe('clock');
    }
  });

  it('clears an open item, refuses a second clear and reopens on a later raise', () => {
    const item = raiseNow();
    const cleared = item.clear({ reason: 'dismissed', via: 'cli', by: 'cli' }, LATER);
    expect(cleared.success).toBe(true);
    if (!cleared.success) {
      return;
    }
    const record = cleared.value.toRecord();
    expect(record.state).toBe('cleared');
    expect(record.clearance).toEqual({ reason: 'dismissed', via: 'cli', by: 'cli', atIso: LATER });
    expect(record.raisedCount).toBe(1);
    expect(record.firstRaisedAtIso).toBe(NOW);
    const secondClear = cleared.value.clear({ reason: 'merged', via: 'web', by: 'web' }, '2026-10-28T11:00:00.000Z');
    expect(secondClear.success).toBe(false);
    if (!secondClear.success) {
      expect(secondClear.code).toBe('state');
    }
    const reopened = cleared.value.raiseAgain(
      {
        kind: 'owner-merge',
        subject: { kind: 'work-order', ref: 'wo-example-1' },
        workOrderId: 'wo-example-1',
        summary: 'Needs an owner merge: parked again',
        raisedBy: 'auto-merge',
      },
      '2026-10-28T11:00:00.000Z',
    );
    expect(reopened.success).toBe(true);
    if (!reopened.success) {
      return;
    }
    const reopenedRecord = reopened.value.toRecord();
    expect(reopenedRecord.state).toBe('open');
    expect(reopenedRecord.clearance).toBeNull();
    expect(reopenedRecord.raisedCount).toBe(2);
    expect(reopenedRecord.lastRaisedAtIso).toBe('2026-10-28T11:00:00.000Z');
  });

  it('refuses stored records that break their invariants', () => {
    const openRecord = raiseNow().toRecord();
    const withClearance: AttentionItemRecord = {
      ...openRecord,
      clearance: { reason: 'dismissed', via: 'cli', by: 'cli', atIso: LATER },
    };
    expect(AttentionItem.create(withClearance).success).toBe(false);

    const cleared = raiseNow().clear({ reason: 'merged', via: 'machine', by: 'auto-merge' }, LATER);
    expect(cleared.success).toBe(true);
    if (!cleared.success) {
      return;
    }
    const clearedRecord = cleared.value.toRecord();
    expect(AttentionItem.create({ ...clearedRecord, clearance: null }).success).toBe(false);
    expect(
      AttentionItem.create({
        ...clearedRecord,
        clearance: { reason: 'merged', via: 'machine', by: 'auto-merge', atIso: '2026-10-28T09:59:59.000Z' },
      }).success,
    ).toBe(false);
    expect(AttentionItem.create({ ...clearedRecord, raisedCount: 0 }).success).toBe(false);
    expect(AttentionItem.create({ ...clearedRecord, firstRaisedAtIso: '2026-10-28T10:00:00Z' }).success).toBe(false);
    expect(AttentionItem.create({ ...clearedRecord, lastRaisedAtIso: '2026-10-28T10:10:00Z' }).success).toBe(false);
  });

  it('never throws on undefined, getter-bearing or proxy input and returns a refusal', () => {
    const getters = {
      get itemId(): string {
        return 'att-example-1';
      },
      get projectId(): string {
        return 'example-project';
      },
    };
    const proxy = new Proxy(
      {},
      {
        ownKeys(): never {
          throw new Error('ownKeys refused');
        },
      },
    );
    expect(AttentionItem.create(undefined).success).toBe(false);
    expect(AttentionItem.create(getters).success).toBe(false);
    expect(AttentionItem.create(proxy).success).toBe(false);
    expect(AttentionItem.raise(undefined, NOW).success).toBe(false);
    expect(AttentionItem.raise(getters, NOW).success).toBe(false);
    expect(AttentionItem.raise(proxy, NOW).success).toBe(false);
    const item = raiseNow();
    expect(item.raiseAgain(undefined, LATER).success).toBe(false);
    expect(item.raiseAgain(getters, LATER).success).toBe(false);
    expect(item.raiseAgain(proxy, LATER).success).toBe(false);
    expect(item.clear(undefined, LATER).success).toBe(false);
    expect(item.clear(getters, LATER).success).toBe(false);
    expect(item.clear(proxy, LATER).success).toBe(false);
  });

  it('builds the record subject only from the validated snapshot, never live getter values', () => {
    const subject = new Proxy(
      { kind: 'work-order', ref: 'wo-example-1' },
      {
        get(target, prop) {
          if (prop === 'ref') {
            return 'wo-getter-value';
          }
          return Reflect.get(target, prop);
        },
      },
    );
    const created = AttentionItem.create({ ...raiseNow().toRecord(), subject });
    expect(created.success).toBe(true);
    if (created.success) {
      expect(created.value.toRecord().subject.ref).toBe('wo-example-1');
    }
  });

  it('builds the clearance only from the validated snapshot, never live getter values', () => {
    const cleared = raiseNow().clear({ reason: 'dismissed', via: 'cli', by: 'cli' }, LATER);
    expect(cleared.success).toBe(true);
    if (!cleared.success) {
      return;
    }
    const clearance = new Proxy(
      { reason: 'dismissed', via: 'cli', by: 'cli', atIso: LATER },
      {
        get(target, prop) {
          if (prop === 'by') {
            return 'getter-actor';
          }
          return Reflect.get(target, prop);
        },
      },
    );
    const created = AttentionItem.create({ ...cleared.value.toRecord(), clearance });
    expect(created.success).toBe(true);
    if (created.success) {
      expect(created.value.toRecord().clearance?.by).toBe('cli');
    }
  });

  it('raiseAgain compares the key on the subject snapshot, never live getter values', () => {
    const item = raiseNow();
    const subject = new Proxy(
      { kind: 'work-order', ref: 'wo-example-1' },
      {
        get(target, prop) {
          if (prop === 'ref') {
            return 'wo-getter-value';
          }
          return Reflect.get(target, prop);
        },
      },
    );
    const again = item.raiseAgain(
      {
        kind: 'owner-merge',
        subject,
        workOrderId: 'wo-example-1',
        summary: 'Needs an owner merge: still parked',
        raisedBy: 'auto-merge',
      },
      LATER,
    );
    expect(again.success).toBe(true);
    if (again.success) {
      expect(again.value.toRecord().subject.ref).toBe('wo-example-1');
    }
  });

  it('raiseAgain turns a throwing subject getter into a refusal and never throws', () => {
    const item = raiseNow();
    const throwingSubject = new Proxy(
      { kind: 'work-order', ref: 'wo-example-1' },
      {
        get() {
          throw new Error('subject getter threw');
        },
        getOwnPropertyDescriptor() {
          throw new Error('subject descriptor read threw');
        },
      },
    );
    let outcome: AttentionItemResult | undefined;
    expect(() => {
      outcome = item.raiseAgain(
        {
          kind: 'owner-merge',
          subject: throwingSubject,
          workOrderId: 'wo-example-1',
          summary: 'Needs an owner merge: still parked',
          raisedBy: 'auto-merge',
        },
        LATER,
      );
    }).not.toThrow();
    expect(outcome?.success).toBe(false);
  });

  it('accepts a single space as a valid summary (1–1024 code points, no controls)', () => {
    expect(raiseResult({ summary: ' ' }).success).toBe(true);
    expect(raiseResult({ summary: ' '.repeat(1024) }).success).toBe(true);
    expect(raiseResult({ summary: ' '.repeat(1025) }).success).toBe(false);
  });

  it('refuses a reopen dated before the clearance it would erase (Fable)', () => {
    const item = raiseNow();
    const cleared = item.clear({ reason: 'dismissed', via: 'cli', by: 'cli' }, LATER);
    if (!cleared.success) {
      throw new Error('setup');
    }
    const body = {
      kind: 'owner-merge',
      subject: { kind: 'work-order', ref: 'wo-example-1' },
      workOrderId: 'wo-example-1',
      summary: 'reopen',
      raisedBy: 'auto-merge',
    };
    const early = cleared.value.raiseAgain(body, '2026-10-28T10:05:00.000Z');
    expect(early.success).toBe(false);
    if (!early.success) {
      expect(early.code).toBe('clock');
    }
    expect(cleared.value.raiseAgain(body, LATER).success).toBe(true);
  });

  it('refuses format characters (LRM, RLM, ALM, zero-width, BOM) in a summary', () => {
    for (const mark of ['\u200e', '\u200f', '\u061c', '\u200b', '\u200d', '\ufeff']) {
      expect(raiseResult({ summary: `before${mark}after` }).success).toBe(false);
    }
    expect(raiseResult({ summary: 'plain text' }).success).toBe(true);
  });

  it('lowercases a pull request owner and repository, so one PR has one key', () => {
    const upper = raiseNow({ subject: { kind: 'pr', ref: 'Example-Org/Example-Repo#7' } });
    const lower = raiseNow({ subject: { kind: 'pr', ref: 'example-org/example-repo#7' } });
    expect(upper.toRecord().subject.ref).toBe('example-org/example-repo#7');
    expect(upper.key()).toBe(lower.key());
  });

  it('refuses path-shaped refs for run, attempt, work-order, reservation and project subjects', () => {
    for (const kind of ['run', 'attempt', 'work-order', 'reservation', 'project']) {
      for (const ref of ['/srv/host/worktrees/wt-abc', '../../etc', 'a:b']) {
        expect(raiseResult({ subject: { kind, ref } }).success).toBe(false);
      }
    }
    expect(raiseResult({ subject: { kind: 'run', ref: 'run-01JB0000000000000000000000' } }).success).toBe(true);
  });

  it('clear refuses a time before the last raise', () => {
    const result = raiseNow().clear({ reason: 'dismissed', via: 'cli', by: 'cli' }, '2026-10-28T09:00:00.000Z');
    expect(result.success).toBe(false);
  });
});
