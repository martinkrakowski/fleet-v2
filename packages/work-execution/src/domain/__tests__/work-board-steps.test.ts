import { describe, expect, it } from 'vitest';

import { deriveWorkBoard } from '../work-board.js';
import type { WorkBoard, WorkBoardResult } from '../work-board.js';
import {
  boardStepText,
  isDeclarationLapsed,
} from '../work-board-steps.js';
import { BOARD_SOURCES, DEFAULT_BOARD_POLICY } from '../work-board-facts.js';
import type {
  BoardAttemptFact,
  BoardFacts,
  BoardForgeObservationFact,
  BoardForgePullRequestFact,
  BoardLinkConflictFact,
  BoardMergeFact,
  BoardOwnerItemFact,
  BoardPlanFact,
  BoardPolicy,
  BoardProjectFact,
  BoardPullRequestLinkFact,
  BoardRunFact,
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

const A1: LaneRef = { kind: 'plan', projectId: PROJECT_ID, planId: PLAN_ID, laneId: 'A1' };
const A2: LaneRef = { kind: 'plan', projectId: PROJECT_ID, planId: PLAN_ID, laneId: 'A2' };

function openPr(number: number, overrides: Partial<BoardForgePullRequestFact> = {}): BoardForgePullRequestFact {
  return {
    number,
    state: 'open',
    headSha: 'abc123',
    title: 'title',
    mergedAtIso: null,
    closedAtIso: null,
    ciState: 'unknown',
    ...overrides,
  };
}

function plan(): BoardPlanFact {
  return {
    projectId: PROJECT_ID,
    planId: PLAN_ID,
    revision: 1,
    lanes: [
      { laneId: 'A1', aliases: [], status: 'planned', scope: 'scope-a', packages: ['work-execution'], sharedFiles: [], tier: 2, after: [], decisions: [], brief: null },
      { laneId: 'A2', aliases: [], status: 'planned', scope: 'scope-b', packages: ['docs'], sharedFiles: [], tier: 1, after: [], decisions: [], brief: null },
      { laneId: 'A3', aliases: [], status: 'dropped', scope: 'scope-c', packages: [], sharedFiles: [], tier: 2, after: [], decisions: [], brief: null },
    ],
    decisions: [],
    exclusiveOrder: [],
  };
}

function allReadSources(): SourceReading[] {
  return BOARD_SOURCES.map((source) => ({ source, repository: null, readAtIso: READ_AT, status: 'read' as const }));
}

function forgeReadSources(): SourceReading[] {
  const sources = allReadSources().filter((r) => r.source !== 'forge-observation');
  sources.push({ source: 'forge-observation', repository: REPO, readAtIso: READ_AT, status: 'read' });
  return sources;
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

function derive(input?: Partial<BoardFacts>, opts: { now?: string; policy?: BoardPolicy } = {}): WorkBoardResult {
  const frozen = deepFreeze(facts(input));
  return deriveWorkBoard(frozen, opts.now ?? NOW, opts.policy ?? DEFAULT_BOARD_POLICY);
}

function boardOf(input?: Partial<BoardFacts>, opts: { now?: string; policy?: BoardPolicy } = {}): WorkBoard {
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

function run(id: string, overrides: Partial<BoardRunFact> = {}): BoardRunFact {
  return {
    runId: id,
    workOrderId: 'wo-example-1',
    state: 'running',
    round: 0,
    seatRole: 'first-pass',
    model: 'model-e',
    parkReason: null,
    prNumber: null,
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

function project(projectId: string, repository: string): BoardProjectFact {
  return { projectId, repository, maxConcurrentLanes: 1, status: 'active' };
}

function laneBlock(ref: string): { kind: 'lane'; ref: string } {
  return { kind: 'lane', ref };
}

function refLane(laneId: string): { kind: 'lane'; planId: string; laneId: string } {
  return { kind: 'lane', planId: PLAN_ID, laneId };
}

function forgeObs(pullRequests: BoardForgePullRequestFact[], overrides: Partial<BoardForgeObservationFact> = {}): BoardForgeObservationFact {
  return {
    projectId: PROJECT_ID,
    repository: REPO,
    readAtIso: READ_AT,
    outcome: 'read',
    pullRequests,
    ...overrides,
  };
}

function conflict(number: number, overrides: Partial<BoardLinkConflictFact> = {}): BoardLinkConflictFact {
  return {
    repository: REPO,
    number,
    linkedLane: A1,
    refusedLane: A2,
    recordedAtIso: NOW,
    ...overrides,
  };
}

describe('S1 PR status', () => {
  it('a merge fact gives merged/merge-record, no read time, never stale', () => {
    const board = boardOf({ links: [link(7)], merges: [merge(7)] });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.pullRequests).toEqual([
      { repository: REPO, number: 7, state: 'merged', source: 'merge-record', asOfIso: null, ciState: null, title: null, stale: false },
    ]);
  });

  it('an observation 14 minutes old listing the PR open is not stale', () => {
    const board = boardOf({
      sources: forgeReadSources(),
      links: [link(7)],
      forgeObservations: [forgeObs([openPr(7)], { readAtIso: '2026-10-27T09:46:00.000Z' })],
    });
    const card = board.lanes.find((l) => l.key === A1_KEY);
    expect(card?.pullRequests[0]).toMatchObject({ state: 'open', source: 'forge-observation', asOfIso: '2026-10-27T09:46:00.000Z', stale: false });
  });

  it('an observation 16 minutes old is stale', () => {
    const board = boardOf({
      sources: forgeReadSources(),
      links: [link(7)],
      forgeObservations: [forgeObs([openPr(7)], { readAtIso: '2026-10-27T09:44:00.000Z' })],
    });
    const card = board.lanes.find((l) => l.key === A1_KEY);
    expect(card?.pullRequests[0]?.stale).toBe(true);
  });

  it('an unavailable observation is not-read', () => {
    const board = boardOf({
      sources: forgeReadSources(),
      links: [link(7)],
      forgeObservations: [forgeObs([openPr(7)], { outcome: 'unavailable' })],
    });
    const card = board.lanes.find((l) => l.key === A1_KEY);
    expect(card?.pullRequests[0]).toEqual({
      repository: REPO,
      number: 7,
      state: 'not-read',
      source: 'none',
      asOfIso: null,
      ciState: null,
      title: null,
      stale: false,
    });
  });

  it('a not-read repository reading wins over an older read observation', () => {
    const sources = allReadSources().filter((r) => r.source !== 'forge-observation');
    sources.push({ source: 'forge-observation', repository: REPO, readAtIso: '2026-10-27T09:40:00.000Z', status: 'not-read' });
    const board = boardOf({
      sources,
      links: [link(7)],
      forgeObservations: [
        forgeObs([openPr(7)], { readAtIso: '2026-10-27T09:40:00.000Z' }),
        forgeObs([openPr(7)], { readAtIso: '2026-10-27T09:30:00.000Z' }),
      ],
    });
    const card = board.lanes.find((l) => l.key === A1_KEY);
    expect(card?.pullRequests[0]?.state).toBe('not-read');
  });

  it('a read observation that does not list the PR is not-observed with its time', () => {
    const board = boardOf({
      sources: forgeReadSources(),
      links: [link(7)],
      forgeObservations: [forgeObs([])],
    });
    const card = board.lanes.find((l) => l.key === A1_KEY);
    expect(card?.pullRequests[0]).toMatchObject({ state: 'not-observed', source: 'forge-observation', asOfIso: READ_AT, ciState: null });
  });

  it('a pending CI keeps its asOfIso', () => {
    const board = boardOf({
      sources: forgeReadSources(),
      links: [link(7)],
      forgeObservations: [forgeObs([openPr(7, { ciState: 'pending' })])],
    });
    const card = board.lanes.find((l) => l.key === A1_KEY);
    expect(card?.pullRequests[0]).toMatchObject({ state: 'open', ciState: 'pending', asOfIso: READ_AT });
  });
});

describe('S2 declaration lapse', () => {
  it('89 minutes ago is live, 91 minutes is lapsed, and an unparseable time lapses', () => {
    expect(isDeclarationLapsed('2026-10-27T08:31:00.000Z', NOW, DEFAULT_BOARD_POLICY)).toBe(false);
    expect(isDeclarationLapsed('2026-10-27T08:29:00.000Z', NOW, DEFAULT_BOARD_POLICY)).toBe(true);
    expect(isDeclarationLapsed('x', NOW, DEFAULT_BOARD_POLICY)).toBe(true);
  });
});

describe('S3.1 run step', () => {
  it('a parked owner-merge run is the run step with that reason', () => {
    const board = boardOf({
      workOrders: [wo('wo-example-1')],
      runs: [run('run-example-1', { state: 'parked', parkReason: 'owner-merge' })],
    });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.step).toEqual({ kind: 'run', runId: 'run-example-1', state: 'parked', round: 0, parkReason: 'owner-merge' });
    expect(a1?.stepText).toBe('parked: owner-merge');
  });

  it('a stopped run is run-stopped', () => {
    const board = boardOf({
      workOrders: [wo('wo-example-1')],
      runs: [run('run-example-1', { state: 'stopped' })],
    });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.step).toEqual({ kind: 'run-stopped', runId: 'run-example-1', round: 0 });
    expect(a1?.stepText).toBe('run stopped, not merged');
  });

  it('a run beats a live attempt', () => {
    const board = boardOf({
      workOrders: [wo('wo-example-1')],
      runs: [run('run-example-1')],
      attempts: [attempt('attempt-example-1')],
    });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.step?.kind).toBe('run');
  });
});

describe('S3.2 attempt step', () => {
  it('a live fix attempt is attempt-live', () => {
    const board = boardOf({
      workOrders: [wo('wo-example-1')],
      attempts: [attempt('attempt-example-1', { kind: 'fix', fixNumber: 1 })],
    });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.step).toEqual({ kind: 'attempt-live', attemptId: 'attempt-example-1', attemptKind: 'fix', fixNumber: 1, state: 'running' });
    expect(a1?.stepText).toBe('fix round 1 running');
  });

  it('an ended attempt with a closed linked PR is pr-closed-without-merge', () => {
    const board = boardOf({
      sources: forgeReadSources(),
      workOrders: [wo('wo-example-1')],
      attempts: [attempt('attempt-example-1', { state: 'ended' })],
      links: [link(7)],
      forgeObservations: [forgeObs([openPr(7, { state: 'closed' })])],
    });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.step?.kind).toBe('pr-closed-without-merge');
    const pr = a1?.step?.kind === 'pr-closed-without-merge' ? a1.step.pr : null;
    expect(pr?.number).toBe(7);
    expect(a1?.stepText).toBe(`PR #7 closed without merge as of ${READ_AT}`);
  });

  it('an ended attempt with an open and a closed PR is pr-open', () => {
    const board = boardOf({
      sources: forgeReadSources(),
      workOrders: [wo('wo-example-1')],
      attempts: [attempt('attempt-example-1', { state: 'ended' })],
      links: [link(7), link(9)],
      forgeObservations: [forgeObs([openPr(7), openPr(9, { state: 'closed' })])],
    });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.step?.kind).toBe('pr-open');
    const pr = a1?.step?.kind === 'pr-open' ? a1.step.pr : null;
    expect(pr?.number).toBe(7);
  });

  it('an ended attempt with no PR is between-steps with its stop reason', () => {
    const board = boardOf({
      workOrders: [wo('wo-example-1')],
      attempts: [attempt('attempt-example-1', { state: 'ended', stopReason: 'timeout' })],
    });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.step).toEqual({ kind: 'between-steps', attemptId: 'attempt-example-1', stopReason: 'timeout' });
    expect(a1?.stepText).toBe('between steps');
  });

  it('a cancelled attempt counts as ended', () => {
    const board = boardOf({
      workOrders: [wo('wo-example-1')],
      attempts: [attempt('attempt-example-1', { state: 'cancelled' })],
    });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.step?.kind).toBe('between-steps');
  });
});

describe('S3.3 linked PR step', () => {
  it('a link with an open PR is pr-open with CI text', () => {
    const board = boardOf({
      sources: forgeReadSources(),
      links: [link(7)],
      forgeObservations: [forgeObs([openPr(7, { ciState: 'passed' })])],
    });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.step?.kind).toBe('pr-open');
    expect(a1?.stepText).toBe(`PR #7 open as of ${READ_AT}, CI passed`);
  });

  it('a forge-merged PR with no merge fact is pr-merged-unrecorded and the lane is not done', () => {
    const board = boardOf({
      sources: forgeReadSources(),
      links: [link(7)],
      forgeObservations: [forgeObs([openPr(7, { state: 'merged' })])],
    });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.placement).toBe('in-flight');
    expect(a1?.step?.kind).toBe('pr-merged-unrecorded');
    expect(a1?.stepText).toBe(`PR #7 merged as of ${READ_AT}; merge not yet recorded`);
  });

  it('a forge not read is pr-merge-not-observed', () => {
    const board = boardOf({ links: [link(7)] });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.step?.kind).toBe('pr-merge-not-observed');
    expect(a1?.stepText).toBe('linked PR #7: merge not yet observed');
  });

  it('among two open PRs the higher number wins', () => {
    const board = boardOf({
      sources: forgeReadSources(),
      links: [link(7), link(12)],
      forgeObservations: [forgeObs([openPr(7), openPr(12)])],
    });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    const pr = a1?.step?.kind === 'pr-open' ? a1.step.pr : null;
    expect(pr?.number).toBe(12);
  });
});

describe('S3.4 declaration step', () => {
  it('a live declaration is declared, not observed', () => {
    const board = boardOf({
      declarations: [{ lane: A1, step: 'code-review', seatRole: 'review', model: 'model-r', declaredAtIso: '2026-10-27T09:30:00.000Z' }],
    });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.step).toEqual({
      kind: 'declared',
      step: 'code-review',
      seatRole: 'review',
      model: 'model-r',
      declaredAtIso: '2026-10-27T09:30:00.000Z',
    });
    expect(a1?.stepText).toBe('declared, not observed: code-review as of 2026-10-27T09:30:00.000Z');
  });

  it('a lapsed declaration shows state unknown and stays in-flight', () => {
    const board = boardOf({
      declarations: [{ lane: A1, step: 'code-review', seatRole: 'review', model: 'model-r', declaredAtIso: '2026-10-27T08:29:00.000Z' }],
    });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.placement).toBe('in-flight');
    expect(a1?.step?.kind).toBe('declaration-lapsed');
    expect(a1?.stepText).toBe('state unknown (declaration lapsed)');
  });
});

describe('S3.5 dropped after start', () => {
  it('a dropped lane with a live attempt is dropped-after-start wrapping attempt-live', () => {
    const board = boardOf({
      workOrders: [wo('wo-example-3', { planRef: { projectId: PROJECT_ID, planId: PLAN_ID, laneId: 'A3' } })],
      attempts: [attempt('attempt-example-1', { workOrderId: 'wo-example-3' })],
    });
    const a3 = board.lanes.find((l) => l.key === A3_KEY);
    expect(a3?.placement).toBe('in-flight');
    expect(a3?.step?.kind).toBe('dropped-after-start');
    const underlying = a3?.step?.kind === 'dropped-after-start' ? a3.step.underlying : null;
    expect(underlying).toEqual({ kind: 'attempt-live', attemptId: 'attempt-example-1', attemptKind: 'initial', fixNumber: 0, state: 'running' });
    expect(a3?.stepText).toBe('dropped in plan; started work not merged (first pass running)');
  });
});

describe('S4 step text', () => {
  it('renders every row of the text table and appends "may have changed" on a stale PR step', () => {
    expect(boardStepText({ kind: 'run', runId: 'run-1', state: 'parked', round: 0, parkReason: 'owner-merge' })).toBe('parked: owner-merge');
    expect(boardStepText({ kind: 'run', runId: 'run-1', state: 'running', round: 2, parkReason: null })).toBe('running, round 2');
    expect(boardStepText({ kind: 'run-stopped', runId: 'run-1', round: 0 })).toBe('run stopped, not merged');
    expect(boardStepText({ kind: 'attempt-live', attemptId: 'a-1', attemptKind: 'initial', fixNumber: 0, state: 'running' })).toBe('first pass running');
    expect(boardStepText({ kind: 'attempt-live', attemptId: 'a-1', attemptKind: 'fix', fixNumber: 1, state: 'running' })).toBe('fix round 1 running');
    expect(boardStepText({
      kind: 'pr-closed-without-merge',
      pr: { repository: REPO, number: 7, state: 'closed', source: 'forge-observation', asOfIso: READ_AT, ciState: null, title: null, stale: false },
    })).toBe(`PR #7 closed without merge as of ${READ_AT}`);
    expect(boardStepText({ kind: 'between-steps', attemptId: 'a-1', stopReason: null })).toBe('between steps');
    expect(boardStepText({
      kind: 'pr-open',
      pr: { repository: REPO, number: 7, state: 'open', source: 'forge-observation', asOfIso: READ_AT, ciState: 'passed', title: null, stale: false },
    })).toBe(`PR #7 open as of ${READ_AT}, CI passed`);
    expect(boardStepText({
      kind: 'pr-merged-unrecorded',
      pr: { repository: REPO, number: 7, state: 'merged', source: 'forge-observation', asOfIso: READ_AT, ciState: null, title: null, stale: false },
    })).toBe(`PR #7 merged as of ${READ_AT}; merge not yet recorded`);
    expect(boardStepText({
      kind: 'pr-merge-not-observed',
      pr: { repository: REPO, number: 7, state: 'not-read', source: 'none', asOfIso: null, ciState: null, title: null, stale: false },
    })).toBe('linked PR #7: merge not yet observed');
    expect(boardStepText({ kind: 'declared', step: 'code-review', seatRole: 'review', model: 'model-r', declaredAtIso: '2026-10-27T09:30:00.000Z' })).toBe('declared, not observed: code-review as of 2026-10-27T09:30:00.000Z');
    expect(boardStepText({ kind: 'declaration-lapsed', declaredAtIso: '2026-10-27T08:29:00.000Z' })).toBe('state unknown (declaration lapsed)');
    expect(boardStepText({
      kind: 'dropped-after-start',
      underlying: { kind: 'attempt-live', attemptId: 'a-1', attemptKind: 'initial', fixNumber: 0, state: 'running' },
    })).toBe('dropped in plan; started work not merged (first pass running)');

    expect(boardStepText({
      kind: 'pr-open',
      pr: { repository: REPO, number: 7, state: 'open', source: 'forge-observation', asOfIso: '2026-10-27T09:40:00.000Z', ciState: 'passed', title: null, stale: true },
    })).toBe('PR #7 open as of 2026-10-27T09:40:00.000Z, CI passed; may have changed');
  });
});

describe('S5/S6 seat, round, PR list and review counts', () => {
  it('seat and round come from a run', () => {
    const board = boardOf({
      workOrders: [wo('wo-example-1')],
      runs: [run('run-example-1', { state: 'running', round: 1 })],
    });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.seat).toEqual({ role: 'first-pass', model: 'model-e', source: 'run' });
    expect(a1?.round).toBe(1);
  });

  it('seat and round come from an attempt when there is no run', () => {
    const board = boardOf({
      workOrders: [wo('wo-example-1')],
      attempts: [attempt('attempt-example-1', { seatRole: 'fix', model: 'model-f', fixNumber: 2 })],
    });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.seat).toEqual({ role: 'fix', model: 'model-f', source: 'attempt' });
    expect(a1?.round).toBe(2);
  });

  it('seat comes from a declaration and round is null', () => {
    const board = boardOf({
      declarations: [{ lane: A1, step: 'first-pass', seatRole: 'review', model: 'model-r', declaredAtIso: '2026-10-27T09:30:00.000Z' }],
    });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.seat).toEqual({ role: 'review', model: 'model-r', source: 'declaration' });
    expect(a1?.round).toBeNull();
  });

  it('pullRequests are number descending on a waiting card', () => {
    const board = boardOf({
      sources: forgeReadSources(),
      workOrders: [wo('wo-example-1')],
      links: [link(7), link(12)],
      forgeObservations: [forgeObs([openPr(7), openPr(12)])],
      ownerItems: [item('item-example-1', { kind: 'decision', subject: 'd', blocks: [laneBlock('2026-10-27_example/A1')] })],
    });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.placement).toBe('waiting');
    expect(a1?.step).toBeNull();
    expect(a1?.pullRequests.map((p) => p.number)).toEqual([12, 7]);
  });

  it('reviewCounts come from the latest attempt with a head', () => {
    const board = boardOf({
      workOrders: [wo('wo-example-1')],
      attempts: [
        attempt('attempt-example-1', { state: 'ended', headCommit: 'sha-one', createdAtIso: '2026-10-27T09:00:00.000Z' }),
        attempt('attempt-example-2', { state: 'ended', headCommit: 'sha-two', createdAtIso: '2026-10-27T09:30:00.000Z' }),
      ],
      reviewCounts: [
        { headSha: 'sha-one', blocker: 1, major: 2, minor: 0, nit: 0, readAtIso: '2026-10-27T09:05:00.000Z' },
        { headSha: 'sha-two', blocker: 0, major: 1, minor: 3, nit: 1, readAtIso: '2026-10-27T09:35:00.000Z' },
      ],
    });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.reviewCounts).toEqual({ headSha: 'sha-two', blocker: 0, major: 1, minor: 3, nit: 1, readAtIso: '2026-10-27T09:35:00.000Z' });
  });

  it('review-evidence not read gives null reviewCounts and names it in notRead', () => {
    const sources = allReadSources();
    sources[BOARD_SOURCES.indexOf('review-evidence')] = { source: 'review-evidence', repository: null, readAtIso: null, status: 'not-read' };
    const board = boardOf({
      sources,
      workOrders: [wo('wo-example-1')],
      attempts: [attempt('attempt-example-1', { state: 'ended', headCommit: 'sha-one' })],
      reviewCounts: [{ headSha: 'sha-one', blocker: 0, major: 0, minor: 0, nit: 0, readAtIso: '2026-10-27T09:35:00.000Z' }],
    });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.reviewCounts).toBeNull();
    expect(a1?.notRead.map((r) => r.source)).toContain('review-evidence');
  });
});

describe('S7 badges', () => {
  it('a waiting lane with a running attempt shows attempt-running', () => {
    const board = boardOf({
      workOrders: [wo('wo-example-1')],
      attempts: [attempt('attempt-example-1')],
      ownerItems: [item('item-example-1', { kind: 'decision', subject: 'd', blocks: [laneBlock('2026-10-27_example/A1')] })],
    });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.placement).toBe('waiting');
    expect(a1?.badges.some((b) => b.kind === 'attempt-running')).toBe(true);
  });

  it('an in-flight card whose step is that attempt does not repeat it', () => {
    const board = boardOf({
      workOrders: [wo('wo-example-1')],
      attempts: [attempt('attempt-example-1')],
    });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.step?.kind).toBe('attempt-live');
    expect(a1?.badges.some((b) => b.kind === 'attempt-running')).toBe(false);
  });

  it('an in-flight card with an open backup item naming it shows the owner-item badge', () => {
    const board = boardOf({
      workOrders: [wo('wo-example-1')],
      attempts: [attempt('attempt-example-1')],
      ownerItems: [item('item-example-1', { kind: 'backup', subject: 'backup', refs: [refLane('A1')] })],
    });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    const badge = a1?.badges.find((b) => b.kind === 'owner-item');
    expect(badge).toMatchObject({ origin: 'owner-item', id: 'item-example-1', itemKind: 'backup', gating: false });
  });

  it('a done lane named by an open secret item shows the badge gating false while the item keeps its own waiting card', () => {
    const board = boardOf({
      links: [link(7)],
      merges: [merge(7)],
      ownerItems: [item('item-example-1', { kind: 'secret', subject: 'secret', blocks: [laneBlock('2026-10-27_example/A1')] })],
    });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.placement).toBe('done');
    const badge = a1?.badges.find((b) => b.kind === 'owner-item');
    expect(badge).toMatchObject({ id: 'item-example-1', itemKind: 'secret', gating: false });
    expect(board.columns.waiting.entries).toContainEqual({ kind: 'owner', origin: 'owner-item', id: 'item-example-1' });
  });

  it('a parked owner-merge run with no merge item shows owner-item-not-recorded, and with an open merge item naming the lane it does not', () => {
    const withoutItem = boardOf({
      workOrders: [wo('wo-example-1')],
      runs: [run('run-example-1', { state: 'parked', parkReason: 'owner-merge' })],
    });
    const a1 = withoutItem.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.badges.some((b) => b.kind === 'owner-item-not-recorded')).toBe(true);

    const withItem = boardOf({
      workOrders: [wo('wo-example-1')],
      runs: [run('run-example-1', { state: 'parked', parkReason: 'owner-merge' })],
      ownerItems: [item('item-example-1', { kind: 'merge', subject: 'merge it', refs: [refLane('A1')] })],
    });
    const b1 = withItem.lanes.find((l) => l.key === A1_KEY);
    expect(b1?.badges.some((b) => b.kind === 'owner-item-not-recorded')).toBe(false);
  });

  it('a link conflict appears on both lanes cards', () => {
    const board = boardOf({ linkConflicts: [conflict(7)] });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    const a2 = board.lanes.find((l) => l.key === A2_KEY);
    expect(a1?.badges.some((b) => b.kind === 'link-conflict')).toBe(true);
    expect(a2?.badges.some((b) => b.kind === 'link-conflict')).toBe(true);
  });

  it('a merge-integrity fact appears on the done card and on an unlinked-merge entry', () => {
    const board = boardOf({
      links: [link(7)],
      merges: [merge(7), merge(8)],
      projects: [project(PROJECT_ID, REPO)],
      mergeIntegrity: [
        { repository: REPO, number: 7, readAtIso: '2026-10-27T09:55:00.000Z' },
        { repository: REPO, number: 8, readAtIso: '2026-10-27T09:55:00.000Z' },
      ],
    });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.placement).toBe('done');
    const badge = a1?.badges.find((b) => b.kind === 'merge-integrity');
    expect(badge).toMatchObject({ repository: REPO, number: 7, readAtIso: '2026-10-27T09:55:00.000Z' });
    expect(a1?.badges.some((b) => b.kind === 'pr')).toBe(false);
    const unlinked = board.columns.done.entries.find((e) => e.kind === 'unlinked-merge' && e.number === 8);
    expect(unlinked?.kind === 'unlinked-merge' ? unlinked.badges : []).toEqual([
      { kind: 'merge-integrity', repository: REPO, number: 8, readAtIso: '2026-10-27T09:55:00.000Z' },
    ]);
  });

  it('a not-imported lane gets its badge', () => {
    const board = boardOf({
      links: [link(7, { lane: { kind: 'plan', projectId: PROJECT_ID, planId: '2026-10-28_example', laneId: 'B1' } })],
    });
    const card = board.lanes.find((l) => l.planStatus === 'not-imported');
    expect(card).toBeDefined();
    expect(card?.badges.some((b) => b.kind === 'plan-lane-not-imported')).toBe(true);
  });

  it('badge kinds follow BOARD_BADGE_KINDS', () => {
    const board = boardOf({
      sources: forgeReadSources(),
      workOrders: [wo('wo-example-1')],
      attempts: [attempt('attempt-example-1', { createdAtIso: '2026-10-27T08:00:00.000Z' })],
      links: [link(7)],
      declarations: [{ lane: A1, step: 'first-pass', seatRole: 'review', model: 'model-r', declaredAtIso: '2026-10-27T09:30:00.000Z' }],
      forgeObservations: [forgeObs([openPr(7)])],
      ownerItems: [item('item-example-1', { kind: 'backup', subject: 'backup', refs: [refLane('A1')] })],
      linkConflicts: [conflict(7)],
      mergeIntegrity: [{ repository: REPO, number: 7, readAtIso: '2026-10-27T09:55:00.000Z' }],
    });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    const kinds = a1?.badges.map((b) => b.kind) ?? [];
    expect(kinds).toEqual(['pr', 'owner-item', 'link-conflict', 'merge-integrity', 'declaration']);
  });
});

describe('S8 not read extended', () => {
  it('a queued lane has no forge readings in notRead', () => {
    const board = boardOf();
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.placement).toBe('queued');
    expect(a1?.notRead.every((r) => r.source !== 'forge-observation')).toBe(true);
  });

  it('an in-flight lane whose PR repository has no reading names a synthesised forge reading and complete is false', () => {
    const sources = allReadSources().filter((r) => r.source !== 'forge-observation');
    const board = boardOf({ sources, links: [link(7)] });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.placement).toBe('in-flight');
    expect(a1?.notRead).toContainEqual({ source: 'forge-observation', repository: REPO, readAtIso: null, status: 'not-read' });
    expect(board.sources).toContainEqual({ source: 'forge-observation', repository: REPO, readAtIso: null, status: 'not-read' });
    expect(board.complete).toBe(false);
  });
});

describe('no guess', () => {
  it('a PR title attaching to a lane attaches to no lane', () => {
    const board = boardOf({
      sources: forgeReadSources(),
      forgeObservations: [forgeObs([openPr(99, { title: 'feat: done (A1)' })])],
    });
    const a1 = board.lanes.find((l) => l.key === A1_KEY);
    expect(a1?.placement).toBe('queued');
    expect(a1?.step).toBeNull();
    expect(a1?.pullRequests).toEqual([]);
  });

  it('a branch-like work-order laneId gives no step without an attempt, run, declaration or link', () => {
    const board = boardOf({ workOrders: [wo('wo-example-1', { planRef: null, laneId: 'feature/foo' })] });
    const card = board.lanes.find((l) => l.key === 'wo:wo-example-1');
    expect(card?.placement).toBe('queued');
    expect(card?.step).toBeNull();
    expect(card?.stepText).toBeNull();
    expect(card?.pullRequests).toEqual([]);
  });
});
