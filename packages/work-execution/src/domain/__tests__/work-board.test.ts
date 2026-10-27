import { describe, expect, it } from 'vitest';

import { deriveWorkBoard } from '../work-board.js';
import type { WorkBoard, WorkBoardResult } from '../work-board.js';
import { BOARD_SOURCES, DEFAULT_BOARD_POLICY } from '../work-board-facts.js';
import type {
  BoardAttemptFact,
  BoardFacts,
  BoardForgeObservationFact,
  BoardForgePullRequestFact,
  BoardMergeFact,
  BoardOwnerItemFact,
  BoardPlanFact,
  BoardPolicy,
  BoardProjectFact,
  BoardPullRequestLinkFact,
  BoardQuestionFact,
  BoardWorkOrderFact,
  LaneRef,
  SourceReading,
} from '../work-board-facts.js';

const NOW = '2026-10-27T10:00:00.000Z';
const READ_AT = '2026-10-27T09:50:00.000Z';
const PROJECT_ID = 'example-project';
const PLAN_ID = '2026-10-27_example';
const REPO = 'example-org/example-repo';
const A1_KEY = `${PROJECT_ID}/${PLAN_ID}/A1`;
const A2_KEY = `${PROJECT_ID}/${PLAN_ID}/A2`;
const A3_KEY = `${PROJECT_ID}/${PLAN_ID}/A3`;
const A4_KEY = `${PROJECT_ID}/${PLAN_ID}/A4`;

const A1: LaneRef = { kind: 'plan', projectId: PROJECT_ID, planId: PLAN_ID, laneId: 'A1' };
const A2: LaneRef = { kind: 'plan', projectId: PROJECT_ID, planId: PLAN_ID, laneId: 'A2' };
const A3: LaneRef = { kind: 'plan', projectId: PROJECT_ID, planId: PLAN_ID, laneId: 'A3' };
const A4: LaneRef = { kind: 'plan', projectId: PROJECT_ID, planId: PLAN_ID, laneId: 'A4' };

function plan(): BoardPlanFact {
  return {
    projectId: PROJECT_ID,
    planId: PLAN_ID,
    revision: 1,
    lanes: [
      { laneId: 'A1', aliases: [], status: 'planned', scope: 'scope-a', packages: ['work-execution'], sharedFiles: [], tier: 2, after: [], decisions: [], brief: null },
      { laneId: 'A2', aliases: ['A-two'], status: 'planned', scope: 'scope-b', packages: ['docs'], sharedFiles: [], tier: 1, after: [], decisions: [], brief: null },
      { laneId: 'A3', aliases: [], status: 'dropped', scope: 'scope-c', packages: [], sharedFiles: [], tier: 2, after: [], decisions: [], brief: null },
      { laneId: 'A4', aliases: [], status: 'deferred', scope: 'scope-d', packages: [], sharedFiles: [], tier: 2, after: [], decisions: [], brief: null },
    ],
    decisions: [],
    exclusiveOrder: [],
  };
}

function allReadSources(): SourceReading[] {
  return BOARD_SOURCES.map((source) => ({ source, repository: null, readAtIso: READ_AT, status: 'read' as const }));
}

function facts(overrides: Partial<BoardFacts> = {}): BoardFacts {
  return {
    sources: allReadSources(),
    projects: [],
    plans: [plan()],
    workOrders: [],
    attempts: [],
    runs: [],
    declarations: [],
    links: [],
    linkConflicts: [],
    merges: [],
    mergeIntegrity: [],
    forgeObservations: [],
    ownerItems: [],
    questions: [],
    reviewCounts: [],
    reservations: [],
    briefReads: [],
    slotBudget: 4,
    ...overrides,
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function derive(input?: Partial<BoardFacts>, opts: { now?: string; policy?: BoardPolicy; since?: string } = {}): WorkBoardResult {
  const frozen = deepFreeze(facts(input));
  return deriveWorkBoard(frozen, opts.now ?? NOW, opts.policy ?? DEFAULT_BOARD_POLICY, { sinceIso: opts.since });
}

function boardOf(input?: Partial<BoardFacts>, opts: { now?: string; policy?: BoardPolicy; since?: string } = {}): WorkBoard {
  const result = derive(input, opts);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected a board');
  return result.board;
}

function wo(id: string, overrides: Partial<BoardWorkOrderFact> = {}): BoardWorkOrderFact {
  return {
    id,
    projectId: PROJECT_ID,
    laneId: 'A1',
    state: 'approved',
    ownedPaths: [],
    planRef: { projectId: PROJECT_ID, planId: PLAN_ID, laneId: 'A1' },
    updatedAtIso: NOW,
    ...overrides,
  };
}

function attempt(id: string, overrides: Partial<BoardAttemptFact> = {}): BoardAttemptFact {
  return {
    id,
    workOrderId: 'wo-example-1',
    kind: 'initial',
    fixNumber: 0,
    state: 'running',
    seatRole: 'first-pass',
    model: 'model-e',
    stopReason: null,
    headCommit: null,
    briefDigest: null,
    createdAtIso: NOW,
    updatedAtIso: NOW,
    ...overrides,
  };
}

function link(number: number, overrides: Partial<BoardPullRequestLinkFact> = {}): BoardPullRequestLinkFact {
  return {
    repository: REPO,
    number,
    lane: A1,
    linkedAtIso: NOW,
    ...overrides,
  };
}

function merge(number: number, overrides: Partial<BoardMergeFact> = {}): BoardMergeFact {
  return {
    repository: REPO,
    number,
    headSha: 'abc123',
    mergedAtIso: '2026-10-27T08:00:00.000Z',
    firstSeenAtIso: '2026-10-27T08:00:00.000Z',
    merger: 'fleet',
    ...overrides,
  };
}

function item(id: string, overrides: Partial<BoardOwnerItemFact> = {}): BoardOwnerItemFact {
  return {
    itemId: id,
    projectId: PROJECT_ID,
    kind: 'decision',
    subject: null,
    refs: [],
    blocks: [],
    createdAtIso: '2026-10-27T07:00:00.000Z',
    state: 'open',
    ...overrides,
  };
}

function question(id: string, overrides: Partial<BoardQuestionFact> = {}): BoardQuestionFact {
  return {
    questionId: id,
    title: 'Question title',
    state: 'open',
    askedAtIso: '2026-10-27T07:00:00.000Z',
    blocks: [],
    answer: null,
    ...overrides,
  };
}

function project(projectId: string, repository: string): BoardProjectFact {
  return { projectId, repository, maxConcurrentLanes: 1, status: 'active' };
}

function laneBlock(ref: string): { kind: 'lane'; ref: string } {
  return { kind: 'lane', ref };
}

function refLane(laneId: string): { kind: 'lane'; planId: string; laneId: string } {
  return { kind: 'lane', planId: PLAN_ID, laneId };
}

function refQuestion(id: string): { kind: 'question'; id: string } {
  return { kind: 'question', id };
}

function forgeObs(pullRequests: BoardForgePullRequestFact[], overrides: Partial<BoardForgeObservationFact> = {}): BoardForgeObservationFact {
  return {
    projectId: PROJECT_ID,
    repository: REPO,
    readAtIso: NOW,
    outcome: 'read',
    pullRequests,
    ...overrides,
  };
}

function hasQuestionEntry(board: WorkBoard, id: string): boolean {
  return board.ownerItems.some((e) => e.origin === 'question' && e.id === id);
}

describe('R0 inputs', () => {
  it('rejects an unparseable now', () => {
    expect(deriveWorkBoard(deepFreeze(facts()), 'nope')).toEqual({ ok: false, reason: 'invalid-now' });
  });

  it('rejects a non-integer or out-of-range policy field', () => {
    const policies: Array<Partial<BoardPolicy>> = [
      { forgeStaleMinutes: 0 },
      { forgeStaleMinutes: 1.5 },
      { forgeStaleMinutes: 1441 },
      { declarationTtlMinutes: 0 },
      { declarationTtlMinutes: 10081 },
      { doneWindowDays: 0 },
      { doneWindowDays: 3651 },
    ];
    for (const partial of policies) {
      const policy = { ...DEFAULT_BOARD_POLICY, ...partial };
      expect(deriveWorkBoard(deepFreeze(facts()), NOW, policy)).toEqual({ ok: false, reason: 'invalid-policy' });
    }
  });

  it('rejects an unparseable sinceIso', () => {
    expect(deriveWorkBoard(deepFreeze(facts()), NOW, DEFAULT_BOARD_POLICY, { sinceIso: 'x' })).toEqual({
      ok: false,
      reason: 'invalid-since',
    });
  });

  it('never throws and returns unreadable-facts when reading facts throws', () => {
    const f = facts();
    Object.defineProperty(f, 'plans', {
      get() {
        throw new Error('boom');
      },
    });
    expect(deriveWorkBoard(f, NOW)).toEqual({ ok: false, reason: 'unreadable-facts' });
  });
});

describe('R1/R2 lane resolution and cards', () => {
  it('a work order whose planRef names an alias lands on its current card', () => {
    const board = boardOf({
      workOrders: [wo('wo-example-1', { planRef: { projectId: PROJECT_ID, planId: PLAN_ID, laneId: 'A-two' } })],
    });
    const a2 = board.lanes.find((l) => l.key === A2_KEY);
    expect(a2).toBeDefined();
    expect(a2?.workOrderIds).toEqual(['wo-example-1']);
    expect(a2?.planStatus).toBe('planned');
    expect(board.lanes.filter((l) => l.workOrderIds.includes('wo-example-1'))).toHaveLength(1);
  });

  it('a work order with no planRef is its own wo card labelled with its laneId', () => {
    const board = boardOf({ workOrders: [wo('wo-example-2', { planRef: null, laneId: 'L7' })] });
    const card = board.lanes.find((l) => l.key === 'wo:wo-example-2');
    expect(card?.label).toBe('L7');
    expect(card?.planStatus).toBe('no-plan');
    expect(card?.placement).toBe('queued');
  });

  it('a link to an unknown plan lane makes a not-imported card', () => {
    const board = boardOf({
      links: [link(7, { lane: { kind: 'plan', projectId: PROJECT_ID, planId: '2026-10-28_example', laneId: 'B1' } })],
    });
    const card = board.lanes.find((l) => l.key === `${PROJECT_ID}/2026-10-28_example/B1`);
    expect(card?.planStatus).toBe('not-imported');
    expect(card?.started).toBe(true);
    expect(card?.placement).toBe('in-flight');
  });

  it('an attempt whose work order is unknown creates no card', () => {
    const board = boardOf({ attempts: [attempt('attempt-example-9', { workOrderId: 'wo-missing' })] });
    expect(board.lanes.some((l) => l.key === 'wo:wo-missing')).toBe(false);
    expect(board.lanes).toHaveLength(4);
  });

  it('no card is made from an owner item subject or a question title', () => {
    const board = boardOf({
      ownerItems: [item('item-example-1', { kind: 'other', subject: 'Free text, not a lane' })],
      questions: [question('q-example-1', { title: 'A title, not a lane' })],
    });
    expect(board.lanes).toHaveLength(4);
    expect(board.ownerItems).toHaveLength(2);
  });
});

describe('R3 started', () => {
  it('a registered work order alone is queued', () => {
    const board = boardOf({ workOrders: [wo('wo-example-1')] });
    expect(board.lanes.find((l) => l.key === A1_KEY)?.placement).toBe('queued');
  });

  it('an attempt moves it to in-flight', () => {
    const board = boardOf({
      workOrders: [wo('wo-example-1')],
      attempts: [attempt('attempt-example-1', { workOrderId: 'wo-example-1' })],
    });
    expect(board.lanes.find((l) => l.key === A1_KEY)?.placement).toBe('in-flight');
  });

  it('a lapsed declaration alone is in-flight', () => {
    const board = boardOf({
      declarations: [{ lane: A1, step: 'first-pass', seatRole: 'first-pass', model: 'model-e', declaredAtIso: '2026-10-26T10:00:00.000Z' }],
    });
    expect(board.lanes.find((l) => l.key === A1_KEY)?.placement).toBe('in-flight');
  });

  it('a PR link alone is in-flight', () => {
    const board = boardOf({ links: [link(7)] });
    expect(board.lanes.find((l) => l.key === A1_KEY)?.placement).toBe('in-flight');
  });

  it('an ended attempt never returns the lane to queued', () => {
    const board = boardOf({
      workOrders: [wo('wo-example-1')],
      attempts: [attempt('attempt-example-1', { workOrderId: 'wo-example-1', state: 'ended' })],
    });
    expect(board.lanes.find((l) => l.key === A1_KEY)?.placement).toBe('in-flight');
  });
});

describe('R4 done', () => {
  it('a link plus a merge fact is done via merge-record', () => {
    const board = boardOf({ links: [link(7)], merges: [merge(7)] });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.placement).toBe('done');
    expect(a1?.done).toEqual({
      via: 'merge-record',
      repository: REPO,
      number: 7,
      headSha: 'abc123',
      mergedAtIso: '2026-10-27T08:00:00.000Z',
      firstSeenAtIso: '2026-10-27T08:00:00.000Z',
      merger: 'fleet',
    });
  });

  it('a merged work order with no merge fact is done via work-order', () => {
    const board = boardOf({ workOrders: [wo('wo-example-1', { state: 'merged', updatedAtIso: '2026-10-27T09:00:00.000Z' })] });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.done).toEqual({ via: 'work-order', workOrderId: 'wo-example-1', recordedAtIso: '2026-10-27T09:00:00.000Z' });
  });

  it('with both, the merge record wins', () => {
    const board = boardOf({
      workOrders: [wo('wo-example-1', { state: 'merged' })],
      links: [link(7)],
      merges: [merge(7)],
    });
    expect(board.lanes.find((l) => l.key === A1_KEY)?.done?.via).toBe('merge-record');
  });

  it('a forge observation of the linked PR merged with no merge fact is not done', () => {
    const board = boardOf({
      links: [link(7)],
      forgeObservations: [
        forgeObs([{ number: 7, state: 'merged', headSha: 'abc123', title: 't', mergedAtIso: '2026-10-27T08:00:00.000Z', closedAtIso: null, ciState: 'unknown' }]),
      ],
    });
    expect(board.lanes.find((l) => l.key === A1_KEY)?.placement).toBe('in-flight');
  });

  it('a merge fact nobody links is an unlinked-merge entry with the matching project', () => {
    const board = boardOf({ merges: [merge(7)], projects: [project(PROJECT_ID, REPO)] });
    expect(board.columns.done.entries).toEqual([
      { kind: 'unlinked-merge', repository: REPO, number: 7, projectId: PROJECT_ID, headSha: 'abc123', mergedAtIso: '2026-10-27T08:00:00.000Z', firstSeenAtIso: '2026-10-27T08:00:00.000Z', merger: 'fleet' },
    ]);
  });

  it('an unlinked merge with no matching project has projectId null', () => {
    const board = boardOf({ merges: [merge(7)] });
    expect(board.columns.done.entries[0]).toMatchObject({ kind: 'unlinked-merge', projectId: null });
  });
});

describe('R5 open decision questions', () => {
  it('open, expired and rejected questions are open', () => {
    const board = boardOf({
      questions: [
        question('q-example-1', { state: 'open' }),
        question('q-example-2', { state: 'expired' }),
        question('q-example-3', { state: 'rejected' }),
      ],
    });
    expect(hasQuestionEntry(board, 'q-example-1')).toBe(true);
    expect(hasQuestionEntry(board, 'q-example-2')).toBe(true);
    expect(hasQuestionEntry(board, 'q-example-3')).toBe(true);
  });

  it('answered with a reject is open', () => {
    const board = boardOf({ questions: [question('q-example-1', { state: 'answered', answer: { shape: 'reject', hasOption: false, hasText: false } })] });
    expect(hasQuestionEntry(board, 'q-example-1')).toBe(true);
  });

  it('answered with an answer carrying neither option nor text is open', () => {
    const board = boardOf({ questions: [question('q-example-1', { state: 'answered', answer: { shape: 'answer', hasOption: false, hasText: false } })] });
    expect(hasQuestionEntry(board, 'q-example-1')).toBe(true);
  });

  it('answered with accept is closed', () => {
    const board = boardOf({ questions: [question('q-example-1', { state: 'answered', answer: { shape: 'accept', hasOption: true, hasText: false } })] });
    expect(hasQuestionEntry(board, 'q-example-1')).toBe(false);
  });

  it('acknowledged after an answer with text is closed', () => {
    const board = boardOf({ questions: [question('q-example-1', { state: 'acknowledged', answer: { shape: 'answer', hasOption: false, hasText: true } })] });
    expect(hasQuestionEntry(board, 'q-example-1')).toBe(false);
  });
});

describe('R6 identity rule', () => {
  it('an open decision item blocking A1 makes A1 waiting with the reason and one entry', () => {
    const board = boardOf({
      ownerItems: [
        item('item-example-1', {
          kind: 'decision',
          subject: 'decide D1',
          blocks: [laneBlock('2026-10-27_example/A1')],
        }),
      ],
    });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.placement).toBe('waiting');
    expect(a1?.waitingOn).toEqual([
      { origin: 'owner-item', id: 'item-example-1', kind: 'decision', subject: 'decide D1', sinceIso: '2026-10-27T07:00:00.000Z' },
    ]);
    expect(board.ownerItems).toEqual([
      {
        origin: 'owner-item',
        id: 'item-example-1',
        projectId: PROJECT_ID,
        kind: 'decision',
        subject: 'decide D1',
        sinceIso: '2026-10-27T07:00:00.000Z',
        gating: true,
        gatesLanes: [A1_KEY],
        namesLanes: [A1_KEY],
        placement: 'lane-reason',
        questionIds: [],
      },
    ]);
  });

  it('an item blocking A1 and A2 is the reason on both, still one entry', () => {
    const board = boardOf({
      ownerItems: [
        item('item-example-1', {
          kind: 'decision',
          subject: 'decide',
          blocks: [laneBlock('2026-10-27_example/A1'), laneBlock('2026-10-27_example/A2')],
        }),
      ],
    });
    expect(board.lanes.find((l) => l.key === A1_KEY)?.placement).toBe('waiting');
    expect(board.lanes.find((l) => l.key === A2_KEY)?.placement).toBe('waiting');
    expect(board.ownerItems).toHaveLength(1);
    expect(board.ownerItems[0].gatesLanes).toEqual([A1_KEY, A2_KEY]);
  });

  it('A1 gated by two items lists both, ordered by createdAtIso', () => {
    const board = boardOf({
      ownerItems: [
        item('item-example-1', {
          kind: 'decision',
          subject: 'one',
          blocks: [laneBlock('2026-10-27_example/A1')],
          createdAtIso: '2026-10-27T08:00:00.000Z',
        }),
        item('item-example-2', {
          kind: 'decision',
          subject: 'two',
          blocks: [laneBlock('2026-10-27_example/A1')],
          createdAtIso: '2026-10-27T07:00:00.000Z',
        }),
      ],
    });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.waitingOn.map((r) => r.id)).toEqual(['item-example-2', 'item-example-1']);
    expect(a1?.waitingOn[0].sinceIso).toBe('2026-10-27T07:00:00.000Z');
  });

  it('a backup item blocking A1 is own-card and A1 is not waiting', () => {
    const board = boardOf({
      ownerItems: [item('item-example-1', { kind: 'backup', subject: 'backup', blocks: [laneBlock('2026-10-27_example/A1')] })],
    });
    expect(board.lanes.find((l) => l.key === A1_KEY)?.placement).toBe('queued');
    expect(board.ownerItems[0].placement).toBe('own-card');
    expect(board.ownerItems[0].gatesLanes).toEqual([]);
  });

  it('a merge item naming A1 only in refs is own-card and A1 is not waiting', () => {
    const board = boardOf({
      ownerItems: [item('item-example-1', { kind: 'merge', subject: 'merge it', refs: [refLane('A1')] })],
    });
    expect(board.lanes.find((l) => l.key === A1_KEY)?.placement).toBe('queued');
    expect(board.ownerItems[0].placement).toBe('own-card');
    expect(board.ownerItems[0].namesLanes).toEqual([A1_KEY]);
  });

  it('a secret item blocking only a Done lane is own-card and the lane stays done', () => {
    const board = boardOf({
      links: [link(7)],
      merges: [merge(7)],
      ownerItems: [item('item-example-1', { kind: 'secret', subject: 'secret', blocks: [laneBlock('2026-10-27_example/A1')] })],
    });
    expect(board.lanes.find((l) => l.key === A1_KEY)?.placement).toBe('done');
    expect(board.ownerItems[0].placement).toBe('own-card');
    expect(board.ownerItems[0].gatesLanes).toEqual([]);
  });

  it('an item blocking a Done lane and A2 is the reason on A2 only', () => {
    const board = boardOf({
      links: [link(7)],
      merges: [merge(7)],
      ownerItems: [
        item('item-example-1', {
          kind: 'decision',
          subject: 'decide',
          blocks: [laneBlock('2026-10-27_example/A1'), laneBlock('2026-10-27_example/A2')],
        }),
      ],
    });
    expect(board.lanes.find((l) => l.key === A1_KEY)?.placement).toBe('done');
    expect(board.lanes.find((l) => l.key === A2_KEY)?.placement).toBe('waiting');
    expect(board.ownerItems[0].gatesLanes).toEqual([A2_KEY]);
  });

  it('a question referenced by an item is folded, never its own entry or reason', () => {
    const openBoard = boardOf({
      ownerItems: [item('item-example-1', { kind: 'decision', subject: 'decide', refs: [refQuestion('q-example-1')] })],
      questions: [question('q-example-1')],
    });
    expect(openBoard.ownerItems).toHaveLength(1);
    expect(openBoard.ownerItems[0].questionIds).toEqual(['q-example-1']);
    expect(openBoard.ownerItems.some((e) => e.origin === 'question')).toBe(false);
    expect(openBoard.lanes.find((l) => l.key === A1_KEY)?.placement).toBe('queued');

    const closedBoard = boardOf({
      ownerItems: [item('item-example-1', { kind: 'decision', state: 'closed', refs: [refQuestion('q-example-1')] })],
      questions: [question('q-example-1')],
    });
    expect(closedBoard.ownerItems).toEqual([]);
  });

  it('an open question nobody references gates A1 as a decision', () => {
    const board = boardOf({
      questions: [question('q-example-1', { blocks: [laneBlock('example-project/2026-10-27_example/A1')] })],
    });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.placement).toBe('waiting');
    expect(a1?.waitingOn).toEqual([
      { origin: 'question', id: 'q-example-1', kind: 'decision', subject: 'Question title', sinceIso: '2026-10-27T07:00:00.000Z' },
    ]);
    expect(board.ownerItems).toEqual([
      {
        origin: 'question',
        id: 'q-example-1',
        projectId: null,
        kind: 'decision',
        subject: 'Question title',
        sinceIso: '2026-10-27T07:00:00.000Z',
        gating: true,
        gatesLanes: [A1_KEY],
        namesLanes: [A1_KEY],
        placement: 'lane-reason',
        questionIds: [],
      },
    ]);
  });

  it('a question with a two-part block names no lane and is own-card', () => {
    const board = boardOf({
      questions: [question('q-example-1', { blocks: [laneBlock('2026-10-27_example/A1')] })],
    });
    expect(board.lanes.find((l) => l.key === A1_KEY)?.placement).toBe('queued');
    expect(board.ownerItems[0].placement).toBe('own-card');
    expect(board.ownerItems[0].gatesLanes).toEqual([]);
  });

  it('closed and withdrawn items are absent', () => {
    const board = boardOf({
      ownerItems: [
        item('item-example-1', { kind: 'decision', state: 'closed' }),
        item('item-example-2', { kind: 'secret', state: 'withdrawn' }),
      ],
    });
    expect(board.ownerItems).toEqual([]);
  });

  it('a bare lane id or free text in a block names no lane', () => {
    const board = boardOf({
      ownerItems: [
        item('item-example-1', { kind: 'decision', subject: 'd1', blocks: [laneBlock('A1')] }),
        item('item-example-2', { kind: 'decision', subject: 'd2', blocks: [laneBlock('free text')] }),
      ],
    });
    expect(board.lanes.find((l) => l.key === A1_KEY)?.placement).toBe('queued');
    expect(board.ownerItems.every((e) => e.placement === 'own-card')).toBe(true);
  });
});

describe('R7 column precedence', () => {
  it('Done beats a gating item', () => {
    const board = boardOf({
      links: [link(7)],
      merges: [merge(7)],
      ownerItems: [item('item-example-1', { kind: 'decision', subject: 'd', blocks: [laneBlock('2026-10-27_example/A1')] })],
    });
    expect(board.lanes.find((l) => l.key === A1_KEY)?.placement).toBe('done');
  });

  it('a gating item beats a running attempt', () => {
    const board = boardOf({
      workOrders: [wo('wo-example-1')],
      attempts: [attempt('attempt-example-1', { workOrderId: 'wo-example-1' })],
      ownerItems: [item('item-example-1', { kind: 'decision', subject: 'd', blocks: [laneBlock('2026-10-27_example/A1')] })],
    });
    expect(board.lanes.find((l) => l.key === A1_KEY)?.placement).toBe('waiting');
  });

  it('a never-started dropped lane is dropped and a deferred one deferred, neither in any column', () => {
    const board = boardOf();
    expect(board.lanes.find((l) => l.key === A3_KEY)?.placement).toBe('dropped');
    expect(board.lanes.find((l) => l.key === A4_KEY)?.placement).toBe('deferred');
    const columnKeys = [
      ...board.columns.done.entries.map((e) => (e.kind === 'lane' ? e.key : `unlinked`)),
      ...board.columns.waiting.entries.map((e) => (e.kind === 'lane' ? e.key : `owner`)),
      ...board.columns.inFlight.keys,
      ...board.columns.queued.keys,
    ];
    expect(columnKeys).not.toContain(A3_KEY);
    expect(columnKeys).not.toContain(A4_KEY);
  });

  it('a started dropped lane is in-flight', () => {
    const board = boardOf({ links: [link(7, { lane: A3 })] });
    expect(board.lanes.find((l) => l.key === A3_KEY)?.placement).toBe('in-flight');
  });
});

describe('R8 done window', () => {
  const THIRTEEN = '2026-10-14T10:00:00.000Z';
  const FIFTEEN = '2026-10-12T10:00:00.000Z';

  it('with the 14-day default a 13-day merge is listed and a 15-day one hidden', () => {
    const board = boardOf({
      links: [link(7), link(8, { lane: A2 })],
      merges: [merge(7, { mergedAtIso: THIRTEEN }), merge(8, { mergedAtIso: FIFTEEN })],
    });
    expect(board.columns.done.entries).toEqual([{ kind: 'lane', key: A1_KEY }]);
    expect(board.columns.done.hiddenByWindow).toBe(1);
    expect(board.lanes.find((l) => l.key === A1_KEY)?.placement).toBe('done');
    expect(board.lanes.find((l) => l.key === A2_KEY)?.placement).toBe('done');
  });

  it('sinceIso 30 days back lists both', () => {
    const board = boardOf(
      {
        links: [link(7), link(8, { lane: A2 })],
        merges: [merge(7, { mergedAtIso: THIRTEEN }), merge(8, { mergedAtIso: FIFTEEN })],
      },
      { since: '2026-09-27T10:00:00.000Z' },
    );
    expect(board.columns.done.entries).toHaveLength(2);
    expect(board.columns.done.hiddenByWindow).toBe(0);
  });

  it('an unparseable mergedAtIso is listed, never hidden', () => {
    const board = boardOf({ links: [link(7)], merges: [merge(7, { mergedAtIso: 'not-a-time' })] });
    expect(board.columns.done.entries).toEqual([{ kind: 'lane', key: A1_KEY }]);
    expect(board.columns.done.hiddenByWindow).toBe(0);
  });
});

describe('R9/R10 column order', () => {
  it('done entries order by time descending, then key ascending', () => {
    const board = boardOf({
      links: [link(7), link(8, { lane: A2 }), link(9, { lane: A3 }), link(10, { lane: A4 })],
      merges: [
        merge(7, { mergedAtIso: '2026-10-27T08:00:00.000Z' }),
        merge(8, { mergedAtIso: '2026-10-27T09:00:00.000Z' }),
        merge(9, { mergedAtIso: '2026-10-27T09:00:00.000Z' }),
        merge(10, { mergedAtIso: '2026-10-27T07:00:00.000Z' }),
      ],
    });
    expect(board.columns.done.entries).toEqual([
      { kind: 'lane', key: A2_KEY },
      { kind: 'lane', key: A3_KEY },
      { kind: 'lane', key: A1_KEY },
      { kind: 'lane', key: A4_KEY },
    ]);
  });

  it('waiting entries order by sinceIso, lane before owner, then key or id', () => {
    const board = boardOf({
      ownerItems: [
        item('item-example-1', {
          kind: 'decision',
          subject: 'i1',
          blocks: [laneBlock('2026-10-27_example/A1')],
          createdAtIso: '2026-10-27T08:00:00.000Z',
        }),
        item('item-example-2', {
          kind: 'decision',
          subject: 'i2',
          blocks: [laneBlock('2026-10-27_example/A2')],
          createdAtIso: '2026-10-27T07:00:00.000Z',
        }),
        item('item-example-3', { kind: 'backup', subject: 'i3', createdAtIso: '2026-10-27T07:30:00.000Z' }),
      ],
    });
    expect(board.columns.waiting.entries).toEqual([
      { kind: 'lane', key: A2_KEY },
      { kind: 'owner', origin: 'owner-item', id: 'item-example-3' },
      { kind: 'lane', key: A1_KEY },
    ]);
  });

  it('inFlight keys order ascending', () => {
    const board = boardOf({
      workOrders: [wo('wo-example-1'), wo('wo-example-2', { planRef: null, laneId: 'L7' })],
      attempts: [
        attempt('attempt-example-1', { workOrderId: 'wo-example-1' }),
        attempt('attempt-example-2', { workOrderId: 'wo-example-2' }),
      ],
      links: [link(7, { lane: A2 })],
    });
    expect(board.columns.inFlight.keys).toEqual([A1_KEY, A2_KEY, 'wo:wo-example-2']);
  });

  it('queued keys order plan lanes first, then work-order lanes by key', () => {
    const board = boardOf({ workOrders: [wo('wo-example-2', { planRef: null, laneId: 'L7' })] });
    expect(board.columns.queued.keys).toEqual([A1_KEY, A2_KEY, 'wo:wo-example-2']);
  });

  it('ownerItems order by sinceIso, then id', () => {
    const board = boardOf({
      ownerItems: [
        item('item-example-1', { kind: 'decision', createdAtIso: '2026-10-27T08:00:00.000Z' }),
        item('item-example-2', { kind: 'secret', createdAtIso: '2026-10-27T07:00:00.000Z' }),
        item('item-example-3', { kind: 'backup', createdAtIso: '2026-10-27T07:00:00.000Z' }),
      ],
    });
    expect(board.ownerItems.map((e) => e.id)).toEqual(['item-example-2', 'item-example-3', 'item-example-1']);
  });
});

describe('R11 not read', () => {
  it('attempts not read names the queued cards and the inFlight column, and a done card names nothing', () => {
    const sources = allReadSources();
    sources[BOARD_SOURCES.indexOf('attempts')] = {
      source: 'attempts',
      repository: null,
      readAtIso: null,
      status: 'not-read',
      reason: 'quarantined',
    };
    const board = boardOf({ sources, links: [link(7)], merges: [merge(7)] });
    expect(board.complete).toBe(false);
    for (const lane of board.lanes) {
      if (lane.placement === 'queued') {
        expect(lane.notRead.map((r) => r.source)).toContain('attempts');
      }
    }
    expect(board.columns.inFlight.notRead.map((r) => r.source)).toContain('attempts');
    const doneCard = board.lanes.find((l) => l.placement === 'done');
    expect(doneCard).toBeDefined();
    expect(doneCard?.notRead).toEqual([]);
  });

  it('a source missing from sources counts as not read', () => {
    const board = boardOf({ sources: [] });
    expect(board.complete).toBe(false);
    expect(board.sources).toHaveLength(BOARD_SOURCES.length);
    expect(board.sources.every((r) => r.status === 'not-read')).toBe(true);
  });

  it('owner-items not read names the waiting column even when it is empty', () => {
    const sources = allReadSources();
    sources[BOARD_SOURCES.indexOf('owner-items')] = { source: 'owner-items', repository: null, readAtIso: null, status: 'not-read' };
    const board = boardOf({ sources });
    expect(board.columns.waiting.notRead.map((r) => r.source)).toContain('owner-items');
  });

  it('two forge readings both appear in board.sources ordered by repository', () => {
    const sources = allReadSources().filter((r) => r.source !== 'forge-observation');
    sources.push({ source: 'forge-observation', repository: REPO, readAtIso: READ_AT, status: 'read' });
    sources.push({ source: 'forge-observation', repository: 'example-org/other-repo', readAtIso: null, status: 'not-read' });
    const board = boardOf({ sources });
    const forge = board.sources.filter((r) => r.source === 'forge-observation');
    expect(forge.map((r) => r.repository)).toEqual([REPO, 'example-org/other-repo']);
    expect(board.complete).toBe(false);
  });
});

describe('purity', () => {
  it('the same frozen facts give deeply equal boards twice and are never mutated', () => {
    const frozen = deepFreeze(
      facts({
        links: [link(7)],
        merges: [merge(7)],
        ownerItems: [item('item-example-1', { kind: 'decision', subject: 'd', blocks: [laneBlock('2026-10-27_example/A1')] })],
      }),
    );
    const first = deriveWorkBoard(frozen, NOW);
    const second = deriveWorkBoard(frozen, NOW);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.board).toEqual(second.board);
  });
});
