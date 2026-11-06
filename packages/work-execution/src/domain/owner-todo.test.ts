/**
 * Unit tests for the owner to-do derivation (TD1b): the one-rule tests of
 * the narrowing, the commands, the ordering and the counts. Pure; no store,
 * no port, no clock — `nowIso` is an argument.
 */

import { describe, expect, it } from 'vitest';

import { deriveOwnerTodo, type OwnerTodoExtras } from './owner-todo.js';
import type { BoardOwnerEntry } from './owner-entries.js';
import type { BoardQuestionFact } from './work-board-facts.js';

const NOW = '2026-11-05T12:00:00.000Z';

function entry(overrides: Partial<BoardOwnerEntry> = {}): BoardOwnerEntry {
  return {
    origin: 'owner-item',
    id: 'item-1',
    projectId: 'proj-1',
    kind: 'secret',
    subject: 'rotate the example deploy token',
    sinceIso: '2026-11-04T12:00:00.000Z',
    gating: true,
    gatesLanes: [],
    namesLanes: [],
    placement: 'own-card',
    questionIds: [],
    ...overrides,
  };
}

function question(overrides: Partial<BoardQuestionFact> = {}): BoardQuestionFact {
  return {
    questionId: 'q-1',
    title: 'Which branch is the base?',
    state: 'open',
    askedAtIso: '2026-11-04T12:00:00.000Z',
    blocks: [],
    answer: null,
    ...overrides,
  };
}

function extras(
  questions: readonly BoardQuestionFact[] = [],
  overrides: Partial<OwnerTodoExtras> = {},
): OwnerTodoExtras {
  return { sources: [], complete: true, parksWithoutItem: null, questions, ...overrides };
}

function todoFor(
  entries: readonly BoardOwnerEntry[],
  extrasArg?: OwnerTodoExtras,
  nowIso: string = NOW,
) {
  return deriveOwnerTodo(entries, extrasArg ?? extras(), nowIso);
}

describe('deriveOwnerTodo', () => {
  it('shows a secret item as its purpose only', () => {
    const list = todoFor([entry({ kind: 'secret', subject: 'rotate the example deploy token' })]);
    const row = list.entries[0];
    expect(row.subject).toBe('rotate the example deploy token');
    // No other free text: only the subject and already-public id/kind/lane keys.
    expect(row.commands).toEqual([
      'fleet-v2 owner-items resolve item-1 --done',
      'fleet-v2 owner-items withdraw item-1',
    ]);
    for (const command of row.commands) {
      expect(command).toContain('item-1');
      expect(command).not.toContain('rotate');
    }
  });

  it('single-quotes an id with shell syntax in the displayed commands (TD1b review minor)', () => {
    const list = todoFor([entry({ id: 'x$(touch /tmp/p);y', kind: 'other' })]);
    expect(list.entries[0].commands).toEqual([
      "fleet-v2 owner-items resolve 'x$(touch /tmp/p);y' --done",
      "fleet-v2 owner-items withdraw 'x$(touch /tmp/p);y'",
    ]);
  });

  it("escapes a single quote inside a quoted id", () => {
    const list = todoFor([entry({ id: "it's", kind: 'other' })]);
    expect(list.entries[0].commands[0]).toBe("fleet-v2 owner-items resolve 'it'\\''s' --done");
  });

  it('gives an owner-closable item the resolve and withdraw commands', () => {
    const list = todoFor([entry({ id: 'item-1', kind: 'other' })]);
    expect(list.entries[0].commands).toEqual([
      'fleet-v2 owner-items resolve item-1 --done',
      'fleet-v2 owner-items withdraw item-1',
    ]);
  });

  it('refuses a command for an id that starts with a dash', () => {
    const list = todoFor([entry({ id: '-x', kind: 'secret' })]);
    const row = list.entries[0];
    expect(row).toBeDefined();
    expect(row.commands).toEqual([]);
  });

  it('gives a derived row no done command', () => {
    const list = todoFor([entry({ origin: 'question', id: 'q-1', projectId: null })], extras([question()]));
    expect(list.entries[0].commands).toEqual([]);
  });

  it('gives a merge or decision item no done command', () => {
    const list = todoFor([
      entry({ id: 'm-1', kind: 'merge' }),
      entry({ id: 'd-1', kind: 'decision' }),
    ]);
    expect(list.entries.map((row) => row.commands)).toEqual([[], []]);
  });

  it('counts a folded question once', () => {
    const list = todoFor(
      [entry({ id: 'item-1', questionIds: ['q-1'] })],
      extras([question({ questionId: 'q-1' })]),
    );
    expect(list.counts.total).toBe(1);
    expect(list.entries[0].questionIds).toEqual(['q-1']);
  });

  it('leaves a rejected question off the list', () => {
    const list = todoFor(
      [entry({ origin: 'question', id: 'q-1' })],
      extras([question({ state: 'rejected' })]),
    );
    expect(list.entries).toEqual([]);
  });

  it('leaves an expired question off the list', () => {
    const list = todoFor(
      [entry({ origin: 'question', id: 'q-1' })],
      extras([question({ state: 'expired' })]),
    );
    expect(list.entries).toEqual([]);
  });

  it('leaves an answered question without a recorded choice off the list', () => {
    const list = todoFor(
      [entry({ origin: 'question', id: 'q-1' })],
      extras([question({ state: 'answered', answer: { shape: 'answer', hasOption: false, hasText: false } })]),
    );
    expect(list.entries).toEqual([]);
  });

  it('leaves an acknowledged question without a recorded choice off the list', () => {
    const list = todoFor(
      [entry({ origin: 'question', id: 'q-1' })],
      extras([question({ state: 'acknowledged', answer: { shape: 'answer', hasOption: false, hasText: false } })]),
    );
    expect(list.entries).toEqual([]);
  });

  it('leaves the board entries for those questions unchanged', () => {
    const boardEntries = [
      entry({ origin: 'question', id: 'q-1' }),
      entry({ origin: 'question', id: 'q-2' }),
      entry({ origin: 'question', id: 'q-3' }),
      entry({ origin: 'question', id: 'q-4' }),
    ];
    const before = boardEntries.map((row) => ({ ...row }));
    todoFor(
      boardEntries,
      extras([
        question({ questionId: 'q-1', state: 'rejected' }),
        question({ questionId: 'q-2', state: 'expired' }),
        question({ questionId: 'q-3', state: 'answered', answer: { shape: 'reject', hasOption: false, hasText: false } }),
        question({ questionId: 'q-4', state: 'acknowledged', answer: { shape: 'reject', hasOption: false, hasText: false } }),
      ]),
    );
    expect(boardEntries).toEqual(before);
  });

  it('orders gating rows first, then oldest first, then id', () => {
    const list = todoFor([
      entry({ id: 'b-2', kind: 'other', gating: false, sinceIso: '2026-11-01T00:00:00.000Z' }),
      entry({ id: 'b-1', kind: 'other', gating: false, sinceIso: '2026-11-01T00:00:00.000Z' }),
      entry({ id: 'g-2', kind: 'secret', gating: true, sinceIso: '2026-11-03T00:00:00.000Z' }),
      entry({ id: 'g-1', kind: 'secret', gating: true, sinceIso: '2026-11-02T00:00:00.000Z' }),
    ]);
    expect(list.entries.map((row) => row.id)).toEqual(['g-1', 'g-2', 'b-1', 'b-2']);
  });

  it('counts total, gating, yours and clears itself', () => {
    const list = todoFor([
      entry({ id: 's-1', kind: 'secret' }),       // gating + yours
      entry({ id: 'm-1', kind: 'merge' }),        // gating + clears itself
      entry({ id: 'o-1', kind: 'other', gating: false }), // yours only
      entry({ origin: 'question', id: 'q-1' }),   // clears itself
    ], extras([question()]));
    expect(list.counts).toEqual({ total: 4, gating: 3, yours: 2, clearsItself: 2 });
  });

  it('computes ageDays in whole days', () => {
    const list = todoFor(
      [
        entry({ id: 'a-1', sinceIso: '2026-11-03T12:00:00.000Z' }),
        entry({ id: 'a-2', sinceIso: '2026-11-05T11:00:00.000Z' }),
        entry({ id: 'a-3', sinceIso: 'not-an-instant' }),
      ],
      undefined,
      NOW,
    );
    expect(list.entries.find((row) => row.id === 'a-1')?.ageDays).toBe(2);
    expect(list.entries.find((row) => row.id === 'a-2')?.ageDays).toBe(0);
    expect(list.entries.find((row) => row.id === 'a-3')?.ageDays).toBe(0);
  });

  it('drops a subject that is not plain text', () => {
    const list = todoFor([entry({ subject: 'bad\0text' })]);
    expect(list.entries[0].subject).toBeNull();
  });

  it('writes nothing: the entries it is given are unchanged', () => {
    const boardEntries = [
      entry({ id: 'item-1', subject: 'a subject', gatesLanes: ['p/x/y'], namesLanes: ['p/x/y'] }),
      entry({ origin: 'question', id: 'q-1', projectId: null, kind: 'decision' }),
    ];
    const before = JSON.parse(JSON.stringify(boardEntries));
    const list = todoFor(boardEntries, extras([question()]));
    expect(boardEntries).toEqual(before);
    // The rows are new objects, not the caller's entries.
    for (const row of list.entries) {
      expect(boardEntries.includes(row as unknown as BoardOwnerEntry)).toBe(false);
    }
  });
});
