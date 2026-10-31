import { describe, expect, it } from 'vitest';

import { LaneRun } from '../entities/LaneRun.js';
import type { LaneRunRecord } from '../lane-run-records.js';
import type { LaneRunJournalEntryRecord } from '../lane-run-journal.js';
import { laneRunConductEntry, laneRunIntentEntry } from '../lane-run-step-facts.js';
import { buildLaneRunStepKey } from '../lane-run-keys.js';
import type { LaneRunKeyResult } from '../lane-run-keys.js';
import type { CapacityReservationRecord } from '../execution-records.js';
import {
  deriveConductorSchedule,
  deriveReservationSeries,
  deriveSessionStartMarks,
} from '../conductor-schedule.js';
import type { ConductorScheduleFacts } from '../conductor-schedule.js';
import { readConductorPassTrace } from '../conductor-pass-trace.js';

const RUN_A = 'run-01JB0000000000000000000000';
const RUN_B = 'run-01JB0000000000000000000001';
const RUN_C = 'run-01JB0000000000000000000002';
const RUN_D = 'run-01JB0000000000000000000003';
const NOW = '2026-10-27T10:00:00.000Z';

function runRecord(overrides: Partial<LaneRunRecord> = {}): LaneRunRecord {
  const result = LaneRun.create({
    version: 1,
    runId: RUN_A,
    workOrderId: 'wo-example-1',
    tier: 2,
    seatPlanRef: 'a'.repeat(64),
    cursors: { 'first-pass': 0, fix: null, review: null },
    round: 0,
    attemptIds: ['attempt-example-1'],
    prNumber: null,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 1,
    runPolicyRevision: 'policy-example-1',
    ...overrides,
  });
  if (!result.success) {
    throw new Error('fixture must be a valid LaneRun record');
  }
  return result.value.toRecord();
}

function reservation(overrides: Partial<CapacityReservationRecord> = {}): CapacityReservationRecord {
  return {
    id: 'res-1',
    attemptId: 'attempt-a1',
    hostId: 'h1',
    slotIndex: 0,
    held: true,
    seatTool: 'opencode',
    hostName: null,
    hostKind: 'opencode',
    transport: 'local',
    sshAlias: null,
    port: null,
    worktreePath: null,
    reservedAtIso: NOW,
    releasedAtIso: null,
    ...overrides,
  };
}

function facts(overrides: Partial<ConductorScheduleFacts> = {}): ConductorScheduleFacts {
  return {
    halt: 'clear',
    driverLease: null,
    runs: [],
    journals: new Map(),
    reservations: [],
    attemptWorkOrderIds: new Map(),
    workOrders: new Map(),
    ...overrides,
  };
}

function mustBuild(result: LaneRunKeyResult): string {
  if (!result.ok) {
    throw new Error('unreachable: key builder');
  }
  return result.key;
}

function runIdOf(rows: ReadonlyArray<{ readonly runId: string }>): string[] {
  return rows.map((row) => row.runId);
}

describe('deriveConductorSchedule', () => {
  it('sorts rows by run id regardless of input order', () => {
    const runs = [runRecord({ runId: RUN_C }), runRecord({ runId: RUN_A }), runRecord({ runId: RUN_B })];
    const schedule = deriveConductorSchedule(facts({ runs }), NOW);
    expect(runIdOf(schedule.rows)).toEqual([RUN_A, RUN_B, RUN_C]);
  });

  it('omits terminal runs and keeps parked runs', () => {
    const merged = runRecord({ runId: RUN_A, attemptIds: ['a1'] });
    const stopped = runRecord({ runId: RUN_B, attemptIds: ['a2'] });
    const parked = runRecord({
      runId: RUN_C,
      attemptIds: ['a3'],
      parked: { reason: 'one-way-door', qualifier: null, parkedFrom: 'running', questionId: null },
      parkCount: 1,
    });
    const journals = new Map<string, readonly LaneRunJournalEntryRecord[]>([
      [RUN_A, [laneRunConductEntry('e1', RUN_A, 'merged', NOW)]],
      [RUN_B, [laneRunConductEntry('e2', RUN_B, 'stopped', NOW)]],
      [RUN_C, [laneRunConductEntry('e3', RUN_C, 'parked', NOW)]],
    ]);
    const schedule = deriveConductorSchedule(facts({ runs: [merged, stopped, parked], journals }), NOW);
    expect(runIdOf(schedule.rows)).toEqual([RUN_C]);
    expect(schedule.rows[0]!.placement).toBe('parked');
    expect(schedule.rows[0]!.park).toEqual({ reason: 'one-way-door', qualifier: null });
  });

  it('halts non-parked rows holding a slot', () => {
    const run = runRecord({ runId: RUN_A, attemptIds: ['a1'] });
    const held = reservation({ attemptId: 'a1' });
    for (const halt of ['halted', 'unreadable'] as const) {
      const schedule = deriveConductorSchedule(facts({ halt, runs: [run], reservations: [held] }), NOW);
      expect(schedule.rows[0]!.placement).toBe('halted');
    }
    const clear = deriveConductorSchedule(facts({ runs: [run], reservations: [held] }), NOW);
    expect(clear.rows[0]!.placement).toBe('running');
  });

  it('matches admission active/in-flight counts', () => {
    const r1 = runRecord({ runId: RUN_A, attemptIds: ['a1'], workOrderId: 'wo-1' });
    const r2 = runRecord({ runId: RUN_B, attemptIds: ['a2'], workOrderId: 'wo-2' });
    const r3 = runRecord({ runId: RUN_C, attemptIds: ['a3'], workOrderId: 'wo-3' });
    const journals = new Map<string, readonly LaneRunJournalEntryRecord[]>([
      [RUN_C, [laneRunConductEntry('e', RUN_C, 'stopped', NOW)]],
    ]);
    const reservations = [
      reservation({ id: 'res-a1', attemptId: 'a1' }),
      reservation({ id: 'res-a3', attemptId: 'a3', hostId: 'h2', slotIndex: 0 }),
      reservation({ id: 'res-a9', attemptId: 'a9', hostId: 'h3' }),
      reservation({ id: 'res-a1-old', attemptId: 'a1', held: false }),
    ];
    const schedule = deriveConductorSchedule(facts({ runs: [r1, r2, r3], journals, reservations }), NOW);
    expect(schedule.admission).toEqual({ active: 1, inFlight: 1, maxActiveRuns: null });
    expect(runIdOf(schedule.rows)).toEqual([RUN_A, RUN_B]);
    expect(schedule.rows.map((row) => [row.runId, row.placement])).toEqual(
      expect.arrayContaining([
        [RUN_A, 'running'],
        [RUN_B, 'waiting'],
      ]),
    );
  });

  it('groups held reservations into sorted host lanes', () => {
    const runs = [
      runRecord({ runId: RUN_A, attemptIds: ['a1'] }),
      runRecord({ runId: RUN_B, attemptIds: ['a2'] }),
      runRecord({ runId: RUN_C, attemptIds: ['a3'] }),
      runRecord({ runId: RUN_D, attemptIds: ['a4'] }),
    ];
    const reservations = [
      reservation({ id: 'r-sol-1', attemptId: 'a1', hostName: 'sol', hostId: 'sol-h', slotIndex: 1 }),
      reservation({ id: 'r-sol-0', attemptId: 'a2', hostName: 'sol', hostId: 'sol-h', slotIndex: 0 }),
      reservation({ id: 'r-twilight', attemptId: 'a3', hostName: 'twilight', hostId: 'twilight-h', slotIndex: 0 }),
      reservation({ id: 'r-h1', attemptId: 'a4', hostName: null, hostId: 'h1', slotIndex: 2 }),
      reservation({ id: 'r-inflight', attemptId: 'a9', hostName: null, hostId: 'h2', slotIndex: 0 }),
    ];
    const schedule = deriveConductorSchedule(facts({ runs, reservations }), NOW);
    expect(schedule.hosts).toEqual([
      { hostName: 'h1', slots: [{ slotIndex: 2, runId: RUN_D }] },
      { hostName: 'h2', slots: [{ slotIndex: 0, runId: null }] },
      {
        hostName: 'sol',
        slots: [
          { slotIndex: 0, runId: RUN_B },
          { slotIndex: 1, runId: RUN_A },
        ],
      },
      { hostName: 'twilight', slots: [{ slotIndex: 0, runId: RUN_C }] },
    ]);
  });

  it('lists package overlaps between rows of the same repository', () => {
    const runs = [
      runRecord({ runId: RUN_A, attemptIds: ['a1'], workOrderId: 'wo-1' }),
      runRecord({ runId: RUN_B, attemptIds: ['a2'], workOrderId: 'wo-2' }),
      runRecord({ runId: RUN_C, attemptIds: ['a3'], workOrderId: 'wo-3' }),
    ];
    const workOrders = new Map([
      ['wo-1', { repository: 'acme/repo', ownedPaths: ['packages/a/x.ts'] }],
      ['wo-2', { repository: 'acme/repo', ownedPaths: ['packages/a/y.ts'] }],
      ['wo-3', { repository: 'other/repo', ownedPaths: ['packages/a'] }],
    ]);
    const schedule = deriveConductorSchedule(facts({ runs, workOrders }), NOW);
    const overlapsOf = (runId: string) => schedule.rows.find((row) => row.runId === runId)?.overlapsWith;
    expect(overlapsOf(RUN_A)).toEqual([RUN_B]);
    expect(overlapsOf(RUN_B)).toEqual([RUN_A]);
    expect(overlapsOf(RUN_C)).toEqual([]);
  });

  it('flags an unreadable work order with a package-overlap wait', () => {
    const run = runRecord({ runId: RUN_A, attemptIds: ['a1'], workOrderId: 'wo-missing' });
    const schedule = deriveConductorSchedule(facts({ runs: [run], workOrders: new Map() }), NOW);
    const row = schedule.rows[0]!;
    expect(row.placement).toBe('waiting');
    expect(row.packageKeys).toBeNull();
    expect(row.workOrderUnreadable).toBe(true);
    expect(row.admissionWait).toBe('package-overlap');
  });

  it('omits caps when no trace is recorded', () => {
    const run = runRecord({ runId: RUN_A, attemptIds: ['a1'], workOrderId: 'wo-1' });
    const workOrders = new Map([['wo-1', { repository: 'acme/repo', ownedPaths: ['packages/a'] }]]);
    const schedule = deriveConductorSchedule(facts({ runs: [run], workOrders }), NOW);
    expect(schedule.caps).toBeNull();
    expect(schedule.trace).toBe('none');
    expect(schedule.admission.maxActiveRuns).toBeNull();
    expect(schedule.rows[0]!.admissionWait).toBeNull();
  });

  it('reads caps from a recorded trace and applies the cap wait', () => {
    const active = runRecord({ runId: RUN_A, attemptIds: ['a1'], workOrderId: 'wo-1' });
    const waiting = runRecord({ runId: RUN_B, attemptIds: ['a2'], workOrderId: 'wo-2' });
    const traceRecord = {
      passId: 'pass-1',
      nowIso: '2026-10-27T09:59:00.000Z',
      holderId: 'driver-x',
      halted: false,
      progressed: true,
      maxActiveRuns: 1,
      passConcurrency: 1,
      dispatchStaggerMs: 1000,
      runs: [],
      attention: [],
    };
    const latestTrace = readConductorPassTrace(traceRecord);
    const workOrders = new Map([
      ['wo-1', { repository: 'acme/repo', ownedPaths: ['packages/a'] }],
      ['wo-2', { repository: 'acme/repo', ownedPaths: ['packages/b'] }],
    ]);
    const schedule = deriveConductorSchedule(
      facts({ runs: [active, waiting], reservations: [reservation({ attemptId: 'a1' })], latestTrace, workOrders }),
      NOW,
    );
    expect(schedule.trace).toBe('recorded');
    expect(schedule.caps).toEqual({
      maxActiveRuns: 1,
      passConcurrency: 1,
      dispatchStaggerMs: 1000,
      recordedAtIso: '2026-10-27T09:59:00.000Z',
    });
    expect(schedule.admission).toEqual({ active: 1, inFlight: 0, maxActiveRuns: 1 });
    expect(schedule.rows.find((row) => row.runId === RUN_B)?.admissionWait).toBe('cap');
  });

  it('fails closed on an unknown trace schema version', () => {
    const latestTrace = readConductorPassTrace({ schemaVersion: 2 });
    const schedule = deriveConductorSchedule(facts({ runs: [], latestTrace }), NOW);
    expect(schedule.trace).toBe('unreadable');
    expect(schedule.caps).toBeNull();
    expect(schedule.admission.maxActiveRuns).toBeNull();
  });

  it('reports lease lapsed states', () => {
    const runs = [
      runRecord({ runId: RUN_A, attemptIds: ['a1'], lease: { holderId: 'driver-x', fence: 1, leaseUntilIso: '2026-10-27T09:59:00.000Z' } }),
      runRecord({ runId: RUN_B, attemptIds: ['a2'], lease: { holderId: 'driver-x', fence: 1, leaseUntilIso: '2026-10-27T10:01:00.000Z' } }),
      runRecord({ runId: RUN_C, attemptIds: ['a3'], lease: null }),
    ];
    const schedule = deriveConductorSchedule(facts({ runs, driverLease: null }), NOW);
    const leaseLapsedOf = (runId: string) => schedule.rows.find((row) => row.runId === runId)?.leaseLapsed;
    expect(leaseLapsedOf(RUN_A)).toBe(true);
    expect(leaseLapsedOf(RUN_B)).toBe(false);
    expect(leaseLapsedOf(RUN_C)).toBeNull();
    expect(schedule.driverLeaseLapsed).toBeNull();
    const withDriverLease = deriveConductorSchedule(
      facts({ runs: [], driverLease: { holderId: 'driver-x', fence: 1, leaseUntilIso: '2026-10-27T09:00:00.000Z' } }),
      NOW,
    );
    expect(withDriverLease.driverLeaseLapsed).toBe(true);
  });

  it('redacts secret-shaped reservation and lease fields from the output', () => {
    const run = runRecord({
      runId: RUN_A,
      attemptIds: ['a1'],
      workOrderId: 'wo-1',
      lease: { holderId: 'driver-x', fence: 1, leaseUntilIso: '2026-10-27T11:00:00.000Z' },
    });
    const reservations = [
      reservation({ attemptId: 'a1', sshAlias: 'secret-alias', port: 4166, worktreePath: '/mnt/x/wt' }),
    ];
    const workOrders = new Map([['wo-1', { repository: 'acme/repo', ownedPaths: ['packages/a'] }]]);
    const schedule = deriveConductorSchedule(facts({ runs: [run], reservations, workOrders }), NOW);
    const json = JSON.stringify(schedule);
    for (const forbidden of ['secret-alias', '4166', '/mnt/x/wt', 'driver-x', 'holderId', 'sshAlias', 'worktreePath', 'transport']) {
      expect(json).not.toContain(forbidden);
    }
  });

  it('is pure: equal results and no input mutation', () => {
    const runs = [
      runRecord({ runId: RUN_A, attemptIds: ['a1'], workOrderId: 'wo-1' }),
      runRecord({ runId: RUN_B, attemptIds: ['a2'], workOrderId: 'wo-2' }),
    ];
    const reservations = [reservation({ attemptId: 'a1' })];
    const workOrders = new Map([
      ['wo-1', { repository: 'acme/repo', ownedPaths: ['packages/a/x.ts'] }],
      ['wo-2', { repository: 'acme/repo', ownedPaths: ['packages/a/y.ts'] }],
    ]);
    const baseFacts = facts({ runs, reservations, workOrders });
    const runsClone = structuredClone(baseFacts.runs);
    const first = deriveConductorSchedule(baseFacts, NOW);
    const second = deriveConductorSchedule(baseFacts, NOW);
    expect(first).toEqual(second);
    expect(baseFacts.runs).toEqual(runsClone);
  });
});

describe('deriveSessionStartMarks', () => {
  const T0 = '2026-10-27T10:00:00.000Z';
  const T5 = '2026-10-27T10:00:05.000Z';
  const T30 = '2026-10-27T10:00:30.000Z';

  function entries(): LaneRunJournalEntryRecord[] {
    const dispatchKey = mustBuild(
      buildLaneRunStepKey({ runId: RUN_A, round: 0, step: 'dispatch', seatIndex: 0, attemptOrdinal: 1, head12: null, retry: null }),
    );
    const briefKey = mustBuild(
      buildLaneRunStepKey({ runId: RUN_A, round: 0, step: 'brief-check', seatIndex: 0, attemptOrdinal: null, head12: '0123456789ab', retry: null }),
    );
    const reviewKey = mustBuild(
      buildLaneRunStepKey({ runId: RUN_A, round: 0, step: 'code-review', seatIndex: 0, attemptOrdinal: null, head12: 'fedcba987654', retry: null }),
    );
    const collectKey = mustBuild(
      buildLaneRunStepKey({ runId: RUN_A, round: 0, step: 'collect', seatIndex: 0, attemptOrdinal: null, head12: null, retry: null }),
    );
    return [
      laneRunIntentEntry('e1', RUN_A, dispatchKey, null, T0),
      laneRunIntentEntry('e2', RUN_A, briefKey, null, T5),
      laneRunIntentEntry('e3', RUN_A, reviewKey, null, T30),
      laneRunIntentEntry('e4', RUN_A, collectKey, null, '2026-10-27T10:00:10.000Z'),
      laneRunConductEntry('e5', RUN_A, 'running', T0),
    ];
  }

  it('derives marks from session-start intents only', () => {
    const { marks, truncated } = deriveSessionStartMarks(entries(), { dispatchStaggerMs: 20000, limit: 10 });
    expect(truncated).toBe(false);
    expect(marks).toEqual([
      { runId: RUN_A, step: 'dispatch', recordedAtIso: T0, gapMs: null, underStagger: null },
      { runId: RUN_A, step: 'brief-check', recordedAtIso: T5, gapMs: 5000, underStagger: true },
      { runId: RUN_A, step: 'code-review', recordedAtIso: T30, gapMs: 25000, underStagger: false },
    ]);
  });

  it('sets underStagger to null when the stagger is unknown', () => {
    const { marks } = deriveSessionStartMarks(entries(), { dispatchStaggerMs: null, limit: 10 });
    expect(marks.map((mark) => mark.underStagger)).toEqual([null, null, null]);
  });

  it('truncates to the newest limit keeping computed gaps', () => {
    const { marks, truncated } = deriveSessionStartMarks(entries(), { dispatchStaggerMs: 20000, limit: 2 });
    expect(truncated).toBe(true);
    expect(marks).toEqual([
      { runId: RUN_A, step: 'brief-check', recordedAtIso: T5, gapMs: 5000, underStagger: true },
      { runId: RUN_A, step: 'code-review', recordedAtIso: T30, gapMs: 25000, underStagger: false },
    ]);
  });

  it('returns empty marks for a non-positive limit', () => {
    expect(deriveSessionStartMarks(entries(), { dispatchStaggerMs: null, limit: 0 })).toEqual({ marks: [], truncated: false });
    expect(deriveSessionStartMarks(entries(), { dispatchStaggerMs: null, limit: -1 })).toEqual({ marks: [], truncated: false });
  });
});

describe('deriveReservationSeries', () => {
  const FROM = '2026-10-27T09:55:00.000Z';
  const TO = '2026-10-27T10:20:00.000Z';
  const A_START = '2026-10-27T10:00:00.000Z';
  const A_END = '2026-10-27T10:10:00.000Z';
  const B_START = '2026-10-27T10:05:00.000Z';

  it('builds held counts at window start, interior events and end', () => {
    const resA = reservation({ id: 'r-a', attemptId: 'a1', reservedAtIso: A_START, releasedAtIso: A_END });
    const resB = reservation({ id: 'r-b', attemptId: 'a2', reservedAtIso: B_START, releasedAtIso: null });
    const series = deriveReservationSeries([resA, resB], { fromIso: FROM, toIso: TO });
    expect(series).toEqual({
      points: [
        { atIso: FROM, held: 0 },
        { atIso: A_START, held: 1 },
        { atIso: B_START, held: 2 },
        { atIso: A_END, held: 1 },
        { atIso: TO, held: 1 },
      ],
      maxHeld: 2,
      skipped: 0,
    });
  });

  it('skips records with unparseable times', () => {
    const resA = reservation({ id: 'r-a', attemptId: 'a1', reservedAtIso: A_START, releasedAtIso: A_END });
    const resB = reservation({ id: 'r-b', attemptId: 'a2', reservedAtIso: B_START, releasedAtIso: null });
    const bad = reservation({ id: 'r-bad', attemptId: 'a3', reservedAtIso: 'bad', releasedAtIso: null });
    const series = deriveReservationSeries([resA, resB, bad], { fromIso: FROM, toIso: TO });
    expect(series.skipped).toBe(1);
    expect(series.maxHeld).toBe(2);
  });

  it('returns empty points for a reversed window', () => {
    const resA = reservation({ id: 'r-a', attemptId: 'a1', reservedAtIso: A_START, releasedAtIso: A_END });
    const resB = reservation({ id: 'r-b', attemptId: 'a2', reservedAtIso: B_START, releasedAtIso: null });
    expect(deriveReservationSeries([resA, resB], { fromIso: TO, toIso: FROM })).toEqual({
      points: [],
      maxHeld: 0,
      skipped: 2,
    });
  });
});
