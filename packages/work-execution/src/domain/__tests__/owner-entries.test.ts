import { describe, expect, it } from 'vitest';

import { deriveOwnerEntries } from '../owner-entries.js';
import type { OwnerEntryCard } from '../owner-entries.js';
import { deriveWorkBoard } from '../work-board.js';
import { BOARD_SOURCES } from '../work-board-facts.js';
import type {
  BoardFacts,
  BoardOwnerItemFact,
  BoardQuestionFact,
  LaneRef,
} from '../work-board-facts.js';

const NOW = '2026-10-27T10:00:00.000Z';
const PROJECT_ID = 'example-project';
const PLAN_ID = '2026-10-27_example';
const A1_KEY = `${PROJECT_ID}/${PLAN_ID}/A1`;
const A2_KEY = `${PROJECT_ID}/${PLAN_ID}/A2`;

function item(overrides: Partial<BoardOwnerItemFact> = {}): BoardOwnerItemFact {
  return {
    itemId: 'item-example-1',
    projectId: PROJECT_ID,
    kind: 'decision',
    subject: 'decide D1',
    refs: [],
    blocks: [],
    createdAtIso: '2026-10-27T07:00:00.000Z',
    state: 'open',
    ...overrides,
  };
}

function question(overrides: Partial<BoardQuestionFact> = {}): BoardQuestionFact {
  return {
    questionId: 'q-example-1',
    title: 'Question title',
    state: 'open',
    askedAtIso: '2026-10-27T07:00:00.000Z',
    blocks: [],
    answer: null,
    ...overrides,
  };
}

const noLanes = (): string => '';

function resolveLaneKey(ref: LaneRef): string {
  return ref.kind === 'plan' ? `${ref.projectId}/${ref.planId}/${ref.laneId}` : `wo:${ref.workOrderId}`;
}

describe('deriveOwnerEntries', () => {
  it('an open owner item with no card is one own-card entry', () => {
    const entries = deriveOwnerEntries([item()], [], [], noLanes);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      origin: 'owner-item',
      id: 'item-example-1',
      projectId: 'example-project',
      kind: 'decision',
      subject: 'decide D1',
      sinceIso: '2026-10-27T07:00:00.000Z',
      gating: true,
      gatesLanes: [],
      namesLanes: [],
      placement: 'own-card',
      questionIds: [],
    });
  });

  it('a closed and a withdrawn item yield no entry', () => {
    const entries = deriveOwnerEntries(
      [item({ state: 'closed' }), item({ itemId: 'item-example-2', state: 'withdrawn' })],
      [],
      [],
      noLanes,
    );
    expect(entries).toEqual([]);
  });

  it('an open question nobody references is a decision entry', () => {
    const entries = deriveOwnerEntries([], [question()], [], noLanes);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      origin: 'question',
      id: 'q-example-1',
      kind: 'decision',
      projectId: null,
      subject: 'Question title',
      gating: true,
      placement: 'own-card',
    });
  });

  it('a question an item references is folded into that item', () => {
    const entries = deriveOwnerEntries(
      [item({ refs: [{ kind: 'question', id: 'q-example-1' }] })],
      [question()],
      [],
      noLanes,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ origin: 'owner-item', id: 'item-example-1', questionIds: ['q-example-1'] });
    expect(entries.some((e) => e.origin === 'question')).toBe(false);
  });

  it('a question closed by an accepted answer yields no entry while a rejected answer keeps one', () => {
    const accepted = deriveOwnerEntries(
      [],
      [question({ state: 'answered', answer: { shape: 'accept', hasOption: true, hasText: false } })],
      [],
      noLanes,
    );
    expect(accepted).toEqual([]);

    const rejected = deriveOwnerEntries(
      [],
      [question({ state: 'answered', answer: { shape: 'reject', hasOption: false, hasText: false } })],
      [],
      noLanes,
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ origin: 'question', id: 'q-example-1' });
  });

  it('a question title that is not plain text becomes the fixed subject', () => {
    const entries = deriveOwnerEntries([], [question({ title: 'bad\u0007title' })], [], noLanes);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.subject).toBe('Owner question');
  });

  it('an item blocking a card gates that card and a done card is never gated', () => {
    const cards: OwnerEntryCard[] = [
      { key: A1_KEY, done: false },
      { key: A2_KEY, done: true },
    ];
    const blockingA1 = deriveOwnerEntries(
      [item({ blocks: [{ kind: 'lane', ref: `${PLAN_ID}/A1` }] })],
      [],
      cards,
      resolveLaneKey,
    );
    expect(blockingA1).toHaveLength(1);
    expect(blockingA1[0]).toMatchObject({
      gatesLanes: [A1_KEY],
      namesLanes: [A1_KEY],
      placement: 'lane-reason',
    });

    const blockingA2 = deriveOwnerEntries(
      [item({ blocks: [{ kind: 'lane', ref: `${PLAN_ID}/A2` }] })],
      [],
      cards,
      resolveLaneKey,
    );
    expect(blockingA2).toHaveLength(1);
    expect(blockingA2[0]).toMatchObject({ gatesLanes: [], placement: 'own-card', namesLanes: [A2_KEY] });
  });

  it('the board and the derivation give the same entries for the same facts', () => {
    const facts: BoardFacts = {
      sources: BOARD_SOURCES.map((source) => ({ source, repository: null, readAtIso: NOW, status: 'read' as const })),
      projects: [],
      plans: [
        {
          projectId: PROJECT_ID,
          planId: PLAN_ID,
          revision: 1,
          lanes: [
            { laneId: 'A1', aliases: [], status: 'planned', scope: 'scope-a', packages: ['work-execution'], sharedFiles: [], tier: 2, after: [], decisions: [], brief: null },
          ],
          decisions: [],
          exclusiveOrder: [],
        },
      ],
      workOrders: [],
      attempts: [],
      runs: [],
      declarations: [],
      links: [],
      linkConflicts: [],
      merges: [],
      mergeIntegrity: [],
      forgeObservations: [],
      ownerItems: [item({ blocks: [{ kind: 'lane', ref: `${PLAN_ID}/A1` }] })],
      questions: [question()],
      reviewCounts: [],
      reservations: [],
      briefReads: [],
      slotBudget: 4,
    };
    const result = deriveWorkBoard(facts, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a board');

    const cards = result.board.lanes.map((lane) => ({ key: lane.key, done: lane.done !== null }));
    const derived = deriveOwnerEntries(facts.ownerItems, facts.questions, cards, resolveLaneKey);
    const boardEntries = [...result.board.ownerItems].sort((a, b) => a.id.localeCompare(b.id));
    expect(derived).toEqual(boardEntries);
  });
});
