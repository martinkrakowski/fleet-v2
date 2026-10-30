// RequestLaneRunStopUseCase and InspectLaneRunsUseCase tests — K7-2.
/**
 * Recording a stop is a keyed journal intent: graceful via cli, repeats and
 * cross-mode refusals, force after graceful, the stale revision, the terminal
 * run, the unknown run and an invalid mode. InspectLaneRuns projects each
 * run's state, stop, park and lease plus the halt marker and the driver
 * lease, and writes nothing.
 */

import { describe, expect, it } from 'vitest';

import { LaneRun } from '../../../domain/entities/LaneRun.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { RunStopMode } from '../../../domain/lane-run-transitions.js';
import { LANE_RUN_JOURNAL_ENTRY_VERSION } from '../../../domain/lane-run-journal.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import type { LaneRunRepositoryPort, LaneRunRepositoryResult } from '../../ports/out/LaneRunRepositoryPort.out-port.js';
import type {
  LeaseAcquireRequest,
  LeaseHoldRequest,
  LeaseRenewRequest,
} from '../../../domain/lane-run-lease.js';
import type { LaneRunJournalPort } from '../../ports/out/LaneRunJournalPort.out-port.js';
import type { ConductorHaltPort } from '../../ports/out/ConductorHaltPort.out-port.js';
import type { ConductorDriverLeasePort } from '../../ports/out/ConductorDriverLeasePort.out-port.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { ConductorDriverLeaseAdapter } from '../../../infrastructure/adapters/ConductorDriverLeaseAdapter.adapter.js';
import { ConductorHaltAdapter } from '../../../infrastructure/adapters/ConductorHaltAdapter.adapter.js';
import { RequestLaneRunStopUseCase } from '../RequestLaneRunStopUseCase.use-case.js';
import { InspectLaneRunsUseCase } from '../InspectLaneRunsUseCase.use-case.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const RUN_ID_2 = 'run-01JB0000000000000000000001';
const NOW = '2026-10-27T10:00:00.000Z';
const LATER = '2026-10-27T10:05:00.000Z';
const ENTRY_1 = '01JB0000000000000000000001';
const ENTRY_2 = '01JB0000000000000000000002';
const ENTRY_3 = '01JB0000000000000000000003';
const ENTRY_4 = '01JB0000000000000000000004';
const HOLDER = 'driver-example-1';

const BASE_RECORD = {
  version: 1,
  runId: RUN_ID,
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
};

function runRecord(overrides: Partial<LaneRunRecord> = {}): LaneRunRecord {
  const result = LaneRun.create({ ...BASE_RECORD, ...overrides });
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error('fixture must be a valid LaneRun record');
  }
  return result.value.toRecord();
}

function conductEntry(entryId: string, runId: string, state: 'stopped'): LaneRunJournalEntryRecord {
  return {
    version: LANE_RUN_JOURNAL_ENTRY_VERSION,
    entryId,
    kind: 'conduct',
    key: null,
    runId,
    recordedAtIso: NOW,
    mode: null,
    expectedRevision: null,
    mintedId: null,
    outcome: null,
    reasonCode: null,
    detail: null,
    grantId: null,
    state,
  };
}

/** Wraps a store and counts every write, so a read-only test can prove none happened. */
class WriteCountingRunRepository implements LaneRunRepositoryPort {
  writes = 0;
  constructor(private readonly inner: LaneRunRepositoryPort) {}
  async create(record: LaneRunRecord): Promise<LaneRunRepositoryResult> {
    this.writes += 1;
    return this.inner.create(record);
  }
  async save(record: LaneRunRecord, guard: Parameters<LaneRunRepositoryPort['save']>[1]): Promise<LaneRunRepositoryResult> {
    this.writes += 1;
    return this.inner.save(record, guard);
  }
  async get(runId: string): Promise<LaneRunRecord | null> {
    return this.inner.get(runId);
  }
  async list(): Promise<readonly LaneRunRecord[]> {
    return this.inner.list();
  }
  async acquireLease(runId: string, request: LeaseAcquireRequest): Promise<LaneRunRepositoryResult> {
    this.writes += 1;
    return this.inner.acquireLease(runId, request);
  }
  async renewLease(runId: string, request: LeaseRenewRequest): Promise<LaneRunRepositoryResult> {
    this.writes += 1;
    return this.inner.renewLease(runId, request);
  }
  async releaseLease(runId: string, request: LeaseHoldRequest): Promise<LaneRunRepositoryResult> {
    this.writes += 1;
    return this.inner.releaseLease(runId, request);
  }
}

class WriteCountingRunJournal implements LaneRunJournalPort {
  writes = 0;
  constructor(private readonly inner: LaneRunJournalPort) {}
  async append(entry: LaneRunJournalEntryRecord) {
    this.writes += 1;
    return this.inner.append(entry);
  }
  async listForRun(runId: string) {
    return this.inner.listForRun(runId);
  }
  async listForKey(key: string) {
    return this.inner.listForKey(key);
  }
}

class WriteCountingHalt implements ConductorHaltPort {
  writes = 0;
  constructor(private readonly inner: ConductorHaltPort) {}
  async read() {
    return this.inner.read();
  }
  async set(request: { halted: boolean; nowIso: string }) {
    this.writes += 1;
    return this.inner.set(request);
  }
}

class WriteCountingDriverLease implements ConductorDriverLeasePort {
  writes = 0;
  constructor(private readonly inner: ConductorDriverLeasePort) {}
  async read() {
    return this.inner.read();
  }
  async acquire(request: LeaseAcquireRequest) {
    this.writes += 1;
    return this.inner.acquire(request);
  }
  async renew(request: LeaseRenewRequest) {
    this.writes += 1;
    return this.inner.renew(request);
  }
  async release(request: LeaseHoldRequest) {
    this.writes += 1;
    return this.inner.release(request);
  }
  async check(request: LeaseHoldRequest) {
    return this.inner.check(request);
  }
}

interface Fixture {
  repo: WriteCountingRunRepository;
  journal: WriteCountingRunJournal;
  halt: WriteCountingHalt;
  driverLease: WriteCountingDriverLease;
  stop: RequestLaneRunStopUseCase;
  inspect: InspectLaneRunsUseCase;
}

function fixture(): Fixture {
  const repo = new WriteCountingRunRepository(new LaneRunRepositoryAdapter());
  const journal = new WriteCountingRunJournal(new LaneRunJournalAdapter());
  const halt = new WriteCountingHalt(new ConductorHaltAdapter());
  const driverLease = new WriteCountingDriverLease(new ConductorDriverLeaseAdapter());
  return {
    repo,
    journal,
    halt,
    driverLease,
    stop: new RequestLaneRunStopUseCase({ runRepo: repo, runJournal: journal }),
    inspect: new InspectLaneRunsUseCase({
      runRepo: repo,
      runJournal: journal,
      halt,
      driverLease,
    }),
  };
}

async function seeded(runs: readonly LaneRunRecord[]): Promise<Fixture> {
  const fx = fixture();
  for (const run of runs) {
    expect(await fx.repo.create(run)).toEqual({
      outcome: 'saved',
      record: run,
    });
  }
  return fx;
}

describe('RequestLaneRunStopUseCase', () => {
  it('records a graceful stop via cli as the keyed intent with the run revision', async () => {
    const fx = await seeded([runRecord()]);
    expect(
      await fx.stop.requestLaneRunStop({ runId: RUN_ID, mode: 'graceful', via: 'cli', entryId: ENTRY_1, nowIso: NOW }),
    ).toEqual({
      outcome: 'stop-recorded',
      runId: RUN_ID,
      mode: 'graceful',
      key: `${RUN_ID}/stop@cli`,
    });
    const entries = await fx.journal.listForRun(RUN_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'intent',
      key: `${RUN_ID}/stop@cli`,
      runId: RUN_ID,
      mode: 'graceful',
      expectedRevision: 1,
      recordedAtIso: NOW,
    });
  });

  it('a repeat of the same mode, and a graceful via web after it, are already-requested', async () => {
    const fx = await seeded([runRecord()]);
    await fx.stop.requestLaneRunStop({ runId: RUN_ID, mode: 'graceful', via: 'cli', entryId: ENTRY_1, nowIso: NOW });
    expect(
      await fx.stop.requestLaneRunStop({ runId: RUN_ID, mode: 'graceful', via: 'cli', entryId: ENTRY_2, nowIso: NOW }),
    ).toEqual({ outcome: 'already-requested', runId: RUN_ID, mode: 'graceful' });
    expect(
      await fx.stop.requestLaneRunStop({ runId: RUN_ID, mode: 'graceful', via: 'web', entryId: ENTRY_3, nowIso: NOW }),
    ).toEqual({ outcome: 'already-requested', runId: RUN_ID, mode: 'graceful' });
  });

  it('force after graceful is recorded on the force key; graceful after force is refused', async () => {
    const fx = await seeded([runRecord()]);
    await fx.stop.requestLaneRunStop({ runId: RUN_ID, mode: 'graceful', via: 'cli', entryId: ENTRY_1, nowIso: NOW });
    expect(
      await fx.stop.requestLaneRunStop({ runId: RUN_ID, mode: 'force', via: 'cli', entryId: ENTRY_2, nowIso: NOW }),
    ).toEqual({
      outcome: 'stop-recorded',
      runId: RUN_ID,
      mode: 'force',
      key: `${RUN_ID}/stop-force@cli`,
    });
    expect(
      await fx.stop.requestLaneRunStop({ runId: RUN_ID, mode: 'graceful', via: 'cli', entryId: ENTRY_3, nowIso: NOW }),
    ).toEqual({ outcome: 'refused', reason: 'stop-already-forced' });
  });

  it('a revision one below the record is stale-revision and appends nothing', async () => {
    const fx = await seeded([runRecord()]);
    // A save under the run lease raises the stored revision to 2, CAS rules permitting.
    expect(
      await fx.repo.acquireLease(RUN_ID, {
        holderId: HOLDER,
        observedFence: 0,
        leaseUntilIso: LATER,
        nowIso: NOW,
      }),
    ).toMatchObject({ outcome: 'saved' });
    expect(
      await fx.repo.save(
        runRecord({ revision: 2, lease: { holderId: HOLDER, fence: 1, leaseUntilIso: LATER } }),
        {
          holderId: HOLDER,
          fence: 1,
          nowIso: NOW,
        },
      ),
    ).toMatchObject({ outcome: 'saved' });
    expect(
      await fx.stop.requestLaneRunStop({
        runId: RUN_ID,
        mode: 'graceful',
        via: 'cli',
        expectedRevision: 1,
        entryId: ENTRY_1,
        nowIso: NOW,
      }),
    ).toEqual({ outcome: 'refused', reason: 'stale-revision' });
    expect(await fx.journal.listForRun(RUN_ID)).toEqual([]);
  });

  it('a stopped run is run-terminal, an unknown run is not-found and a bad mode is invalid-request', async () => {
    const fx = await seeded([runRecord()]);
    expect(await fx.journal.append(conductEntry(ENTRY_1, RUN_ID, 'stopped'))).toMatchObject({ outcome: 'appended' });
    expect(
      await fx.stop.requestLaneRunStop({ runId: RUN_ID, mode: 'graceful', via: 'cli', entryId: ENTRY_2, nowIso: NOW }),
    ).toEqual({ outcome: 'refused', reason: 'run-terminal' });
    expect(
      await fx.stop.requestLaneRunStop({ runId: RUN_ID_2, mode: 'graceful', via: 'cli', entryId: ENTRY_3, nowIso: NOW }),
    ).toEqual({ outcome: 'not-found', runId: RUN_ID_2 });
    expect(
      await fx.stop.requestLaneRunStop({ runId: RUN_ID, mode: 'soft' as RunStopMode, via: 'cli', entryId: ENTRY_4, nowIso: NOW }),
    ).toEqual({ outcome: 'refused', reason: 'invalid-request' });
  });
});

describe('InspectLaneRunsUseCase', () => {
  it('lists runs in run-id order with each projected state and stop', async () => {
    const fx = await seeded([
      runRecord({ runId: RUN_ID_2 }),
      runRecord({ runId: RUN_ID }),
    ]);
    await fx.stop.requestLaneRunStop({ runId: RUN_ID, mode: 'graceful', via: 'cli', entryId: ENTRY_1, nowIso: NOW });
    const result = await fx.inspect.inspectLaneRuns({ nowIso: NOW });
    expect(result.outcome).toBe('listed');
    if (result.outcome !== 'listed') {
      throw new Error('expected listed');
    }
    expect(result.halt).toBe('clear');
    expect(result.driver).toBeNull();
    expect(result.runs.map((run) => run.runId)).toEqual([RUN_ID, RUN_ID_2]);
    const [first] = result.runs;
    expect(first).toMatchObject({
      workOrderId: 'wo-example-1',
      tier: 2,
      state: 'ready',
      round: 0,
      revision: 1,
      parked: null,
      parkCount: 0,
      stopMode: 'graceful',
      stopRequestedAtIso: NOW,
      pendingIntent: null,
      latestAttemptId: 'attempt-example-1',
      attemptCount: 1,
      prNumber: null,
      lease: null,
    });
  });

  it('reads one run by id and reports not-found for an unknown one', async () => {
    const fx = await seeded([runRecord()]);
    const one = await fx.inspect.inspectLaneRuns({ runId: RUN_ID, nowIso: NOW });
    expect(one.outcome).toBe('listed');
    if (one.outcome === 'listed') {
      expect(one.runs).toHaveLength(1);
      expect(one.runs[0].runId).toBe(RUN_ID);
    }
    expect(await fx.inspect.inspectLaneRuns({ runId: RUN_ID_2, nowIso: NOW })).toEqual({
      outcome: 'not-found',
      runId: RUN_ID_2,
    });
  });

  it('reads the halt marker after a halt and a lapsed driver lease', async () => {
    const fx = await seeded([runRecord()]);
    expect(await fx.halt.set({ halted: true, nowIso: NOW })).toMatchObject({ outcome: 'changed' });
    expect(
      await fx.driverLease.acquire({
        holderId: HOLDER,
        observedFence: 0,
        leaseUntilIso: LATER,
        nowIso: NOW,
      }),
    ).toMatchObject({ outcome: 'ok' });
    const result = await fx.inspect.inspectLaneRuns({ nowIso: LATER });
    expect(result.outcome).toBe('listed');
    if (result.outcome !== 'listed') {
      throw new Error('expected listed');
    }
    expect(result.halt).toBe('halted');
    expect(result.driver).toEqual({
      holderId: HOLDER,
      fence: 1,
      leaseUntilIso: LATER,
      lapsed: true,
    });
  });

  it('writes nothing: no create, save, append, set or lease write was called', async () => {
    const fx = await seeded([runRecord()]);
    fx.repo.writes = 0;
    fx.journal.writes = 0;
    fx.halt.writes = 0;
    fx.driverLease.writes = 0;
    await fx.inspect.inspectLaneRuns({ nowIso: NOW });
    await fx.inspect.inspectLaneRuns({ runId: RUN_ID, nowIso: NOW });
    expect(fx.repo.writes).toBe(0);
    expect(fx.journal.writes).toBe(0);
    expect(fx.halt.writes).toBe(0);
    expect(fx.driverLease.writes).toBe(0);
  });
});
