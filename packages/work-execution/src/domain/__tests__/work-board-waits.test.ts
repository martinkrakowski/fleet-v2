import { describe, expect, it } from 'vitest';

import { deriveWorkBoard } from '../work-board.js';
import type { WaitGuard, WorkBoard, WorkBoardResult } from '../work-board.js';
import { BOARD_SOURCES, DEFAULT_BOARD_POLICY } from '../work-board-facts.js';
import type {
  BoardFacts,
  BoardMergeFact,
  BoardOwnerItemFact,
  BoardPlanFact,
  BoardPlannedLaneFact,
  BoardPullRequestLinkFact,
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

const A0: LaneRef = { kind: 'plan', projectId: PROJECT_ID, planId: PLAN_ID, laneId: 'A0' };
const A1: LaneRef = { kind: 'plan', projectId: PROJECT_ID, planId: PLAN_ID, laneId: 'A1' };

function laneFact(laneId: string, overrides: Partial<BoardPlannedLaneFact> = {}): BoardPlannedLaneFact {
  return {
    laneId,
    aliases: [],
    status: 'planned',
    scope: 'scope-' + laneId,
    packages: [],
    sharedFiles: [],
    tier: 2,
    after: [],
    decisions: [],
    brief: null,
    ...overrides,
  };
}

function plan(lanes: BoardPlannedLaneFact[], overrides: Partial<BoardPlanFact> = {}): BoardPlanFact {
  return {
    projectId: PROJECT_ID,
    planId: PLAN_ID,
    revision: 1,
    lanes,
    decisions: [],
    exclusiveOrder: [],
    ...overrides,
  };
}

function after(laneId: string): { projectId: string; planId: string; laneId: string } {
  return { projectId: PROJECT_ID, planId: PLAN_ID, laneId };
}

function allReadSources(): SourceReading[] {
  return BOARD_SOURCES.map((source) => ({ source, repository: null, readAtIso: READ_AT, status: 'read' as const }));
}

function sourcesWith(sources: readonly SourceReading[], overrides: Partial<SourceReading> & { source: SourceReading['source'] }): SourceReading[] {
  const merged = sources.filter(
    (r) => !(r.source === overrides.source && (r.repository ?? null) === (overrides.repository ?? null)),
  );
  merged.push({ repository: null, readAtIso: null, status: 'not-read', ...overrides } as SourceReading);
  return merged;
}

function facts(plans: BoardPlanFact[], overrides: Partial<BoardFacts> = {}): BoardFacts {
  return {
    sources: allReadSources(),
    projects: [],
    plans,
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

function derive(input: BoardPlanFact[], overrides: Partial<BoardFacts> = {}): WorkBoardResult {
  const frozen = deepFreeze(facts(input, overrides));
  return deriveWorkBoard(frozen, NOW, DEFAULT_BOARD_POLICY, { sinceIso: null });
}

function boardOf(input: BoardPlanFact[], overrides: Partial<BoardFacts> = {}): WorkBoard {
  const result = derive(input, overrides);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected a board');
  return result.board;
}

function cardOf(board: WorkBoard, key: string) {
  const lane = board.lanes.find((lane) => lane.key === key);
  expect(lane).toBeDefined();
  if (!lane) throw new Error('expected a card for ' + key);
  return lane;
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

function link(number: number, lane: LaneRef, overrides: Partial<BoardPullRequestLinkFact> = {}): BoardPullRequestLinkFact {
  return {
    repository: REPO,
    number,
    lane,
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

function laneBlock(ref: string): { kind: 'lane'; ref: string } {
  return { kind: 'lane', ref };
}

describe('WB2b wait guards', () => {
  it('a lane with no predecessor has only the seat row and reads "nothing blocks it but unchecked guards"', () => {
    const board = boardOf([plan([laneFact('A1')])]);
    const a1 = cardOf(board, A1_KEY);
    expect(a1.placement).toBe('queued');
    expect(a1.waitsOn).toHaveLength(1);
    const row: WaitGuard = a1.waitsOn[0];
    expect(row.reason).toBe('seat');
    expect(row.state).toBe('unknown');
    expect(row.subject).toEqual({ kind: 'seat', role: null });
    expect(row.clearedBy).toEqual({ kind: 'record', what: 'seat-probe' });
    expect(row.clearedByText).toBe('a seat probe is recorded (none exists yet; A-S or S1)');
    expect(row.sources).toEqual([]);
    expect(row.unreadBeside).toEqual([]);
    expect(a1.waitCounts).toEqual({ blocked: 0, unknown: 1, clear: 0 });
    expect(a1.firstBlocker).toBeNull();
    expect(a1.summary).toBe('Nothing blocks it but unchecked guards: seat not checked.');
  });

  it('an after predecessor that is not done blocks with an after-not-done row', () => {
    const board = boardOf([plan([laneFact('A1'), laneFact('A2', { after: [after('A1')] })])]);
    const a2 = cardOf(board, A2_KEY);
    expect(a2.placement).toBe('queued');
    const row = a2.waitsOn.find((r) => r.reason === 'after-not-done');
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.state).toBe('blocked');
    expect(row.subject).toMatchObject({ kind: 'lane', lane: { ref: A1, label: 'A1', column: 'queued' } });
    expect(row.clearedBy).toEqual({ kind: 'done', subject: A1 });
    expect(row.clearedByText).toBe('A1 is done (merged, or recorded done without a PR)');
    expect(row.unreadBeside).toEqual([]);
    expect(a2.firstBlocker).toBe(row);
    expect(a2.summary).toBe('Blocked by 1: after A1 (queued). Unknown 1: seat not checked.');
  });

  it('an after predecessor that is done is a clear row, never a block', () => {
    const mergeRecordBoard = boardOf(
      [plan([laneFact('A1'), laneFact('A2', { after: [after('A1')] })])],
      { links: [link(7, A1)], merges: [merge(7)] },
    );
    const byMerge = cardOf(mergeRecordBoard, A2_KEY).waitsOn.find((r) => r.reason === 'after-not-done');
    expect(byMerge).toBeDefined();
    expect(byMerge?.state).toBe('clear');
    expect(byMerge?.clearedByText).toBe('A1 is done (merged, or recorded done without a PR)');

    const workOrderBoard = boardOf(
      [plan([laneFact('A1'), laneFact('A2', { after: [after('A1')] })])],
      { workOrders: [wo('wo-a1', { laneId: 'A1', state: 'merged' })] },
    );
    const byWorkOrder = cardOf(workOrderBoard, A2_KEY).waitsOn.find((r) => r.reason === 'after-not-done');
    expect(byWorkOrder).toBeDefined();
    expect(byWorkOrder?.state).toBe('clear');
  });

  it('an after reference whose plan is not imported is an after-unresolved block', () => {
    const board = boardOf([plan([
      laneFact('A2', { after: [{ projectId: PROJECT_ID, planId: 'other-plan', laneId: 'B1' }] }),
    ])]);
    const a2 = cardOf(board, A2_KEY);
    const row = a2.waitsOn.find((r) => r.reason === 'after-unresolved');
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.state).toBe('blocked');
    expect(row.subject).toEqual({ kind: 'plan', projectId: PROJECT_ID, planId: 'other-plan' });
    expect(row.clearedBy).toEqual({ kind: 'record', what: 'plan-import' });
    expect(row.clearedByText).toBe('import plan other-plan for project example-project');
  });

  it('an after predecessor that is dropped is an after-dropped block', () => {
    const board = boardOf([plan([
      laneFact('A1'),
      laneFact('A2', { after: [after('A3')] }),
      laneFact('A3', { status: 'dropped' }),
    ])]);
    const a2 = cardOf(board, A2_KEY);
    const row = a2.waitsOn.find((r) => r.reason === 'after-dropped');
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.state).toBe('blocked');
    expect(row.subject).toMatchObject({
      kind: 'lane',
      lane: { ref: { kind: 'plan', projectId: PROJECT_ID, planId: PLAN_ID, laneId: 'A3' }, label: 'A3', column: 'dropped' },
    });
    expect(row.clearedBy).toEqual({ kind: 'edit', what: 'after' });
    expect(row.clearedByText).toBe("edit this lane's after and re-import the plan");
  });

  it('a dropped predecessor with a merge record is still after-dropped, never clear', () => {
    // The dropped status is checked before the merge record, so the
    // predecessor never counts as done for its dependants.
    const afterBoard = boardOf(
      [plan([
        laneFact('A1', { status: 'dropped' }),
        laneFact('A2', { after: [after('A1')] }),
      ])],
      { links: [link(7, A1)], merges: [merge(7)] },
    );
    const a2 = cardOf(afterBoard, A2_KEY);
    expect(a2.waitsOn.find((r) => r.reason === 'after-not-done')).toBeUndefined();
    const afterRow = a2.waitsOn.find((r) => r.reason === 'after-dropped');
    expect(afterRow).toBeDefined();
    expect(afterRow?.state).toBe('blocked');
    expect(afterRow?.clearedBy).toEqual({ kind: 'edit', what: 'after' });
    expect(afterRow?.subject).toMatchObject({
      kind: 'lane',
      lane: { ref: A1, label: 'A1', column: 'dropped' },
    });

    const exclusiveBoard = boardOf(
      [plan(
        [laneFact('A1', { status: 'dropped' }), laneFact('A2')],
        { exclusiveOrder: [{ file: 'packages/work-execution', lanes: ['A1', 'A2'] }] },
      )],
      { links: [link(7, A1)], merges: [merge(7)] },
    );
    const a2Exclusive = cardOf(exclusiveBoard, A2_KEY);
    expect(a2Exclusive.waitsOn.find((r) => r.reason === 'exclusive-order')).toBeUndefined();
    const droppedRow = a2Exclusive.waitsOn.find((r) => r.reason === 'after-dropped');
    expect(droppedRow).toBeDefined();
    expect(droppedRow?.state).toBe('blocked');
    expect(droppedRow?.clearedBy).toEqual({ kind: 'edit', what: 'after' });
    expect(droppedRow?.subject).toMatchObject({ kind: 'lane', lane: { column: 'dropped' } });
  });

  it('an exclusive-order predecessor that is not done blocks with exclusive-order', () => {
    const board = boardOf([plan(
      [laneFact('A1'), laneFact('A2')],
      { exclusiveOrder: [{ file: 'packages/work-execution', lanes: ['A1', 'A2'] }] },
    )]);
    const a1 = cardOf(board, A1_KEY);
    expect(a1.waitsOn.some((r) => r.reason === 'exclusive-order')).toBe(false);
    const a2 = cardOf(board, A2_KEY);
    const row = a2.waitsOn.find((r) => r.reason === 'exclusive-order');
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.state).toBe('blocked');
    expect(row.subject).toMatchObject({ kind: 'lane', lane: { ref: A1, label: 'A1' } });
    expect(row.clearedBy).toEqual({ kind: 'done', subject: A1 });
    expect(row.clearedByText).toBe('A1 is done (merged, or recorded done without a PR)');
  });

  it('a gating owner item is the first row of a Waiting lane and the summary says waiting on you', () => {
    const board = boardOf([plan([laneFact('A1')])], {
      ownerItems: [item('item-1', { blocks: [laneBlock(PLAN_ID + '/A1')] })],
    });
    const a1 = cardOf(board, A1_KEY);
    expect(a1.placement).toBe('waiting');
    expect(a1.waitsOn.length).toBeGreaterThanOrEqual(1);
    const first = a1.waitsOn[0];
    expect(first.reason).toBe('owner-decision');
    expect(first.state).toBe('blocked');
    expect(first.subject).toMatchObject({ kind: 'owner-item', itemId: 'item-1', itemKind: 'decision', subject: 'item-1' });
    expect(first.clearedBy).toEqual({ kind: 'owner', itemId: 'item-1' });
    expect(first.clearedByText).toBe('owner decides item-1');
    expect(a1.firstBlocker).toBe(first);
    expect(a1.summary).toBe('Waiting on you: decision item-1 (since 2026-10-27T07:00:00.000Z).');
  });

  it('an open plan decision blocks with a plan-decision row', () => {
    const board = boardOf([plan(
      [laneFact('A1', { decisions: ['D14'] })],
      { decisions: [{ id: 'D14', state: 'open' }] },
    )]);
    const a1 = cardOf(board, A1_KEY);
    const row = a1.waitsOn.find((r) => r.reason === 'owner-decision');
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.state).toBe('blocked');
    expect(row.subject).toEqual({ kind: 'plan-decision', projectId: PROJECT_ID, planId: PLAN_ID, decisionId: 'D14' });
    expect(row.clearedBy).toEqual({ kind: 'record', what: 'plan-import' });
    expect(row.clearedByText).toBe('owner decides D14');
  });

  it('an unread merge-record store makes after-not-done unknown, and a read record that blocks stays blocked', () => {
    const unreadBoard = boardOf(
      [plan([laneFact('A1'), laneFact('A2', { after: [after('A1')] })])],
      { sources: sourcesWith(allReadSources(), { source: 'merge-records' }) },
    );
    const unknownRow = cardOf(unreadBoard, A2_KEY).waitsOn.find((r) => r.reason === 'after-not-done');
    expect(unknownRow).toBeDefined();
    expect(unknownRow?.state).toBe('unknown');
    expect(unknownRow?.clearedByText).toBe('reading merge records and work orders would decide it');
    expect(unknownRow?.unreadBeside).toContain('merge-records');

    // The forge is unread, but the merge-records and work-orders reads say the predecessor is not done: blocked beats unknown.
    const forgeUnreadBoard = boardOf(
      [plan([laneFact('A1'), laneFact('A2', { after: [after('A1')] })])],
      { links: [link(7, A1)] },
    );
    const blockedRow = cardOf(forgeUnreadBoard, A2_KEY).waitsOn.find((r) => r.reason === 'after-not-done');
    expect(blockedRow).toBeDefined();
    expect(blockedRow?.state).toBe('blocked');
    expect(blockedRow?.clearedByText).toBe('A1 is done; forge not read');
    expect(blockedRow?.unreadBeside).toContain('forge-observation');
  });

  it('the rows are ordered blocked, then unknown, then clear, and waitCounts and firstBlocker agree with them', () => {
    const board = boardOf(
      [plan(
        [
          laneFact('A0'),
          laneFact('A1'),
          laneFact('A3', { status: 'dropped' }),
          laneFact('A2', {
            after: [after('A1'), after('A3'), after('A0')],
            decisions: ['D14'],
          }),
        ],
        { decisions: [{ id: 'D14', state: 'open' }] },
      )],
      {
        links: [link(7, A0)],
        merges: [merge(7)],
        ownerItems: [item('item-1', { blocks: [laneBlock(PLAN_ID + '/A2')] })],
      },
    );
    const a2 = cardOf(board, A2_KEY);
    expect(a2.placement).toBe('waiting');
    const reasons = a2.waitsOn.map((r) => r.reason);
    expect(reasons).toEqual([
      'owner-decision', // the gating owner item is the first row
      'after-not-done', // A1, blocked
      'after-dropped', // A3, blocked
      'owner-decision', // the open plan decision D14
      'seat', // unknown
      'after-not-done', // A0, clear (merged)
    ]);
    const states = a2.waitsOn.map((r) => r.state);
    expect(states).toEqual(['blocked', 'blocked', 'blocked', 'blocked', 'unknown', 'clear']);
    expect(a2.waitCounts).toEqual({ blocked: 4, unknown: 1, clear: 1 });
    expect(a2.firstBlocker).toBe(a2.waitsOn[0]);
    expect(a2.firstBlocker?.subject.kind).toBe('owner-item');
    expect(a2.summary).toBe(
      'Waiting on you: decision item-1 (since 2026-10-27T07:00:00.000Z).'
      + ' Also blocked by 3: after A1 (queued); after A3: predecessor dropped and 1 more.',
    );
  });

  it('the same frozen facts give deeply equal boards twice and are never mutated', () => {
    const frozen = deepFreeze(facts(
      [plan([laneFact('A1'), laneFact('A2', { after: [after('A1')] })])],
      {
        links: [link(7, A1)],
        merges: [merge(7)],
        ownerItems: [item('item-1', { blocks: [laneBlock(PLAN_ID + '/A2')] })],
      },
    ));
    const first = deriveWorkBoard(frozen, NOW);
    const second = deriveWorkBoard(frozen, NOW);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.board).toEqual(second.board);
  });
});
