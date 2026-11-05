// InspectLaneRunsUseCase crashed-start detection tests — AD-2.
/**
 * A crashed start is a capacity reservation a `conductor start` left held
 * because the process died before the start recorded its lane run: the
 * attempt is absent, or exists as `intent-recorded` and no lane run lists
 * it. The read-only status view reports one `CrashedStartView` per such
 * reservation — at least `CRASHED_START_GRACE_MINUTES` old, sorted by attempt
 * id, carrying no worktree path, ssh alias, port or transport. The use case
 * stays read-only: a missing dependency, an unparseable time or a throwing
 * read reports nothing.
 */

import { describe, expect, it, vi } from 'vitest';

import { LaneRun } from '../../../domain/entities/LaneRun.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { AttemptRecord, CapacityReservationRecord } from '../../../domain/execution-records.js';
import { ConductorDriverLeaseAdapter } from '../../../infrastructure/adapters/ConductorDriverLeaseAdapter.adapter.js';
import { ConductorHaltAdapter } from '../../../infrastructure/adapters/ConductorHaltAdapter.adapter.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import { AttemptRepositoryAdapter } from '../../../infrastructure/adapters/AttemptRepositoryAdapter.adapter.js';
import { ExecutionJournalAdapter } from '../../../infrastructure/adapters/ExecutionJournalAdapter.adapter.js';
import { InspectLaneRunsUseCase } from '../InspectLaneRunsUseCase.use-case.js';
import type { CrashedStartView } from '../../ports/in/InspectLaneRunsPort.in-port.js';
import { CRASHED_START_GRACE_MINUTES } from '../../ports/in/InspectLaneRunsPort.in-port.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const NOW = '2026-10-27T10:00:00.000Z';
const ATTEMPT_ID = 'attempt-example-1';
const COMMIT_A = 'a'.repeat(40);

function minutesBefore(nowIso: string, minutes: number): string {
  return new Date(Date.parse(nowIso) - minutes * 60_000).toISOString();
}

const BASE_RECORD = {
  version: 1,
  runId: RUN_ID,
  workOrderId: 'wo-example-1',
  tier: 2,
  seatPlanRef: 'a'.repeat(64),
  cursors: { 'first-pass': 0, fix: null, review: null },
  round: 0,
  attemptIds: [ATTEMPT_ID],
  prNumber: null,
  parked: null,
  parkCount: 0,
  lease: null,
  revision: 1,
  runPolicyRevision: 'policy-example-1',
};

function runRecord(overrides: Partial<LaneRunRecord> = {}): LaneRunRecord {
  const result = LaneRun.create({ ...BASE_RECORD, ...overrides });
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error('fixture must be a valid LaneRun record');
  }
  return result.value.toRecord();
}

/** A minimal attempt record in the given state. */
function attemptRecord(state: AttemptRecord['state']): AttemptRecord {
  return {
    id: ATTEMPT_ID,
    workOrderId: 'wo-example-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/tmp/wt-example-1',
    baseCommit: COMMIT_A,
    state,
    outcome: null,
    revision: 0,
    briefDigest: null,
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    createdAtIso: NOW,
    updatedAtIso: NOW,
  };
}

type Harness = {
  runRepo: LaneRunRepositoryAdapter;
  runJournal: LaneRunJournalAdapter;
  attemptRepo: AttemptRepositoryAdapter;
  executionJournal: ExecutionJournalAdapter;
  halt: ConductorHaltAdapter;
  driverLease: ConductorDriverLeaseAdapter;
  useCase: InspectLaneRunsUseCase;
};

function makeHarness(overrides: {
  withAttemptRepo?: boolean;
  withExecutionJournal?: boolean;
} = {}): Harness {
  const runRepo = new LaneRunRepositoryAdapter();
  const runJournal = new LaneRunJournalAdapter();
  const attemptRepo = new AttemptRepositoryAdapter();
  const executionJournal = new ExecutionJournalAdapter();
  const halt = new ConductorHaltAdapter();
  const driverLease = new ConductorDriverLeaseAdapter();
  const useCase = new InspectLaneRunsUseCase({
    runRepo,
    runJournal,
    halt,
    driverLease,
    ...(overrides.withAttemptRepo === false ? {} : { attemptRepo }),
    ...(overrides.withExecutionJournal === false ? {} : { executionJournal }),
  });
  return { runRepo, runJournal, attemptRepo, executionJournal, halt, driverLease, useCase };
}

/** A held reservation ten minutes old, naming wo-example-1. */
async function seedHeldReservation(
  journal: ExecutionJournalAdapter,
  overrides: Partial<CapacityReservationRecord> = {},
): Promise<CapacityReservationRecord> {
  const reservation: CapacityReservationRecord = {
    id: 'reservation-example-1',
    attemptId: ATTEMPT_ID,
    hostId: 'host-example-1',
    slotIndex: 0,
    held: true,
    seatTool: 'opencode',
    hostName: 'lane-host-example',
    workOrderId: 'wo-example-1',
    reservedAtIso: minutesBefore(NOW, 10),
    releasedAtIso: null,
    ...overrides,
  };
  await journal.saveCapacityReservation(reservation);
  return reservation;
}

async function crashedStarts(harness: Harness): Promise<readonly CrashedStartView[]> {
  const result = await harness.useCase.inspectLaneRuns({ nowIso: NOW });
  expect(result.outcome).toBe('listed');
  if (result.outcome !== 'listed') {
    throw new Error('expected listed');
  }
  return result.crashedStarts;
}

describe('InspectLaneRunsUseCase crashed starts (AD-2)', () => {
  it('reports a held reservation whose attempt is absent as a crashed start', async () => {
    const harness = makeHarness();
    await seedHeldReservation(harness.executionJournal);
    const views = await crashedStarts(harness);
    expect(views).toEqual([
      {
        attemptId: ATTEMPT_ID,
        workOrderId: 'wo-example-1',
        hostName: 'lane-host-example',
        slotIndex: 0,
        reservedAtIso: minutesBefore(NOW, 10),
        heldMinutes: 10,
      },
    ]);
  });

  it('reports a held reservation whose attempt is intent-recorded and no run names it', async () => {
    const harness = makeHarness();
    await seedHeldReservation(harness.executionJournal);
    await harness.attemptRepo.saveAttempt(attemptRecord('intent-recorded'));
    const views = await crashedStarts(harness);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ attemptId: ATTEMPT_ID, workOrderId: 'wo-example-1', heldMinutes: 10 });
  });

  it('reports nothing for a reservation younger than the five-minute grace', async () => {
    const harness = makeHarness();
    await seedHeldReservation(harness.executionJournal, {
      reservedAtIso: minutesBefore(NOW, CRASHED_START_GRACE_MINUTES - 2),
    });
    expect(await crashedStarts(harness)).toEqual([]);
  });

  it('reports nothing for a held reservation whose attempt is running', async () => {
    const harness = makeHarness();
    await seedHeldReservation(harness.executionJournal);
    await harness.attemptRepo.saveAttempt(attemptRecord('running'));
    expect(await crashedStarts(harness)).toEqual([]);
  });

  it('reports nothing for a held reservation whose run lists the attempt', async () => {
    const harness = makeHarness();
    const record = runRecord();
    expect(await harness.runRepo.create(record)).toMatchObject({ outcome: 'saved' });
    await seedHeldReservation(harness.executionJournal);
    expect(await crashedStarts(harness)).toEqual([]);
  });

  it('reports nothing when the execution journal or the attempt repository is unwired', async () => {
    const withoutJournal = makeHarness({ withExecutionJournal: false });
    await seedHeldReservation(withoutJournal.executionJournal);
    expect(await crashedStarts(withoutJournal)).toEqual([]);

    const withoutAttemptRepo = makeHarness({ withAttemptRepo: false });
    await seedHeldReservation(withoutAttemptRepo.executionJournal);
    expect(await crashedStarts(withoutAttemptRepo)).toEqual([]);

    // An unwired caller is a composition gap, not a failed read: no flag.
    for (const harness of [withoutJournal, withoutAttemptRepo]) {
      const result = await harness.useCase.inspectLaneRuns({ nowIso: NOW });
      expect(result.outcome).toBe('listed');
      if (result.outcome !== 'listed') {
        throw new Error('expected listed');
      }
      expect(result.crashedStartsIncomplete).toBeUndefined();
    }
  });

  it('the crashed start view carries no worktree path, ssh alias, port or transport', async () => {
    const harness = makeHarness();
    await seedHeldReservation(harness.executionJournal, {
      worktreePath: '/tmp/wt-example-1',
      sshAlias: 'lane-alias-example',
      port: 4166,
      transport: 'ssh',
    });
    const views = await crashedStarts(harness);
    expect(views).toHaveLength(1);
    const serialized = JSON.parse(JSON.stringify(views[0]!)) as Record<string, unknown>;
    expect(serialized).not.toHaveProperty('worktreePath');
    expect(serialized).not.toHaveProperty('sshAlias');
    expect(serialized).not.toHaveProperty('port');
    expect(serialized).not.toHaveProperty('transport');
  });

  it('the crashed starts are sorted by attempt id', async () => {
    const harness = makeHarness();
    await seedHeldReservation(harness.executionJournal, { id: 'reservation-a', attemptId: 'attempt-zeta' });
    await seedHeldReservation(harness.executionJournal, { id: 'reservation-b', attemptId: 'attempt-alpha' });
    await seedHeldReservation(harness.executionJournal, { id: 'reservation-c', attemptId: 'attempt-mid' });
    const views = await crashedStarts(harness);
    expect(views.map((view) => view.attemptId)).toEqual(['attempt-alpha', 'attempt-mid', 'attempt-zeta']);
  });

  it('a clean read carries no incomplete flag', async () => {
    const harness = makeHarness();
    await seedHeldReservation(harness.executionJournal);
    const result = await harness.useCase.inspectLaneRuns({ nowIso: NOW });
    expect(result.outcome).toBe('listed');
    if (result.outcome !== 'listed') {
      throw new Error('expected listed');
    }
    expect(result.crashedStarts).toHaveLength(1);
    expect(result.crashedStartsIncomplete).toBeUndefined();
  });

  it('a throwing reservations store reports the crashed starts as incomplete', async () => {
    const harness = makeHarness();
    await seedHeldReservation(harness.executionJournal);
    vi.spyOn(harness.executionJournal, 'listActiveReservations').mockRejectedValue(new Error('store unavailable'));
    const result = await harness.useCase.inspectLaneRuns({ nowIso: NOW });
    expect(result.outcome).toBe('listed');
    if (result.outcome !== 'listed') {
      throw new Error('expected listed');
    }
    expect(result.crashedStarts).toEqual([]);
    expect(result.crashedStartsIncomplete).toBe(true);
  });

  it('a throwing attempt read reports the crashed starts as incomplete', async () => {
    const harness = makeHarness();
    await seedHeldReservation(harness.executionJournal);
    vi.spyOn(harness.attemptRepo, 'findAttemptById').mockRejectedValue(new Error('attempt read failed'));
    const result = await harness.useCase.inspectLaneRuns({ nowIso: NOW });
    expect(result.outcome).toBe('listed');
    if (result.outcome !== 'listed') {
      throw new Error('expected listed');
    }
    expect(result.crashedStarts).toEqual([]);
    expect(result.crashedStartsIncomplete).toBe(true);
  });
});
