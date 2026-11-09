// PT1a (SN2): the conductor pass raises, refreshes and clears one stall attention item per stalled run.
import { describe, expect, it } from 'vitest';

import { LaneRun } from '../../../domain/entities/LaneRun.js';
import type { LaneRunParkRecord, LaneRunRecord } from '../../../domain/lane-run-records.js';
import { laneRunConductEntry } from '../../../domain/lane-run-step-facts.js';
import type { WorkOrderRecord } from '../../../domain/execution-records.js';
import { ConductorDriverLeaseAdapter } from '../../../infrastructure/adapters/ConductorDriverLeaseAdapter.adapter.js';
import { ConductorHaltAdapter } from '../../../infrastructure/adapters/ConductorHaltAdapter.adapter.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import { StallAttentionAdapter } from '../../../infrastructure/adapters/StallAttentionAdapter.adapter.js';
import type { AdvanceLaneRunPort } from '../../ports/in/AdvanceLaneRunPort.in-port.js';
import type {
  ClearStallAttentionCommand,
  ClearStallAttentionResult,
  ListOpenStallAttentionResult,
  RaiseStallAttentionCommand,
  RaiseStallAttentionResult,
  StallAttentionPort,
} from '../../ports/out/StallAttentionPort.out-port.js';
import { RunConductorPassUseCase } from '../RunConductorPassUseCase.use-case.js';

/** Ids shaped like `.fleet/state/lane-runs.json`: a run ULID, a work order id, a project id. */
const RUN_ID = 'run-01M63WPH4GMF2CA3NQ7JAM4HS1';
const RUN_ID_2 = 'run-01M63WPH4GMF2CA3NQ7JAM4HS2';
const WORK_ORDER_ID = 'wo-fleet-v2-sr1c-dedupe-2026-10-29';
const PROJECT_ID = 'fleet-v2';
const PARKED_AT = '2026-11-06T20:00:00.000Z';
const HOLDER = 'driver-example-1';

const PARK: LaneRunParkRecord = {
  reason: 'step-refused',
  qualifier: 'prepare',
  parkedFrom: 'fixing',
  questionId: null,
  class: 'step-refused',
};

const WORK_ORDER = { id: WORK_ORDER_ID, projectId: PROJECT_ID } as unknown as WorkOrderRecord;

function at(minutesAfterPark: number): string {
  return new Date(Date.parse(PARKED_AT) + minutesAfterPark * 60_000).toISOString();
}

function record(overrides: Partial<LaneRunRecord> = {}): LaneRunRecord {
  const created = LaneRun.create({
    version: 1,
    runId: RUN_ID,
    workOrderId: WORK_ORDER_ID,
    tier: 2,
    seatPlanRef: 'a'.repeat(64),
    cursors: { 'first-pass': 0, fix: null, review: null },
    round: 0,
    attemptIds: ['attempt-01M64PT1PX2MAZVQDYAYMZ7WNB'],
    prNumber: null,
    parked: PARK,
    parkCount: 1,
    lease: null,
    revision: 1,
    runPolicyRevision: 'policy:conductor@7844746b0277',
    schemaVersion: 1,
    ...overrides,
  });
  if (!created.success) {
    throw new Error('fixture must be a valid LaneRun record');
  }
  return created.value.toRecord();
}

/** A recording fake of the stall attention store: one item per run, like the real attention store. */
class FakeStallAttention implements StallAttentionPort {
  readonly raises: RaiseStallAttentionCommand[] = [];
  readonly clears: ClearStallAttentionCommand[] = [];
  readonly open = new Map<string, ClearStallAttentionCommand>();
  refuseRaises = false;
  listUnavailable = false;

  async raiseStallAttention(command: RaiseStallAttentionCommand): Promise<RaiseStallAttentionResult> {
    this.raises.push(command);
    if (this.refuseRaises) {
      return { outcome: 'refused', reasonCode: 'store-unreadable' };
    }
    const had = this.open.has(command.runId);
    this.open.set(command.runId, { projectId: command.projectId, runId: command.runId });
    return { outcome: had ? 'refreshed' : 'raised', reasonCode: null };
  }

  async clearStallAttention(command: ClearStallAttentionCommand): Promise<ClearStallAttentionResult> {
    this.clears.push(command);
    const had = this.open.delete(command.runId);
    return { outcome: had ? 'cleared' : 'not-found', reasonCode: null };
  }

  async listOpenStallAttention(): Promise<ListOpenStallAttentionResult> {
    return this.listUnavailable ? { outcome: 'unavailable' } : { outcome: 'found', items: [...this.open.values()] };
  }
}

const idleAdvance: AdvanceLaneRunPort = {
  advanceLaneRun: async () => ({ outcome: 'waiting', reason: 'parked' }),
};

interface Fixture {
  readonly repo: LaneRunRepositoryAdapter;
  readonly journal: LaneRunJournalAdapter;
  readonly attention: FakeStallAttention;
  readonly pass: (nowIso: string, options?: { stallAfterMinutes?: number; wired?: boolean }) => Promise<unknown>;
}

async function fixture(overrides: Partial<LaneRunRecord> = {}): Promise<Fixture> {
  const repo = new LaneRunRepositoryAdapter();
  const journal = new LaneRunJournalAdapter();
  const driverLease = new ConductorDriverLeaseAdapter();
  const halt = new ConductorHaltAdapter();
  const attention = new FakeStallAttention();
  await repo.create(record(overrides));
  await journal.append(laneRunConductEntry('01M64PT1PX2MAZVQDYAYMZ7WN1', RUN_ID, 'parked', PARKED_AT));
  return {
    repo,
    journal,
    attention,
    pass: async (nowIso, options = {}) =>
      new RunConductorPassUseCase({
        driverLease,
        runRepo: repo,
        runJournal: journal,
        halt,
        resume: { applyPendingResume: async () => ({ outcome: 'none' }) },
        advance: idleAdvance,
        now: () => nowIso,
        ...(options.wired === false
          ? {}
          : {
              stallAttention: attention,
              workOrderRepo: { findWorkOrderById: async () => WORK_ORDER },
              ...(options.stallAfterMinutes === undefined ? {} : { stallAfterMinutes: options.stallAfterMinutes }),
            }),
      }).runPass({ holderId: HOLDER, nowIso }),
  };
}

describe('RunConductorPassUseCase stall attention (PT1a)', () => {
  it('raises nothing before the threshold, then one item after it, carrying the class and the park age', async () => {
    const fx = await fixture();
    expect(await fx.pass(at(29))).toMatchObject({ outcome: 'completed' });
    expect(fx.attention.raises).toEqual([]);

    await fx.pass(at(31));
    expect(fx.attention.raises).toEqual([
      { projectId: PROJECT_ID, workOrderId: WORK_ORDER_ID, runId: RUN_ID, parkClass: 'step-refused', ageMinutes: 31 },
    ]);
    expect(fx.attention.open.size).toBe(1);
  });

  it('refreshes the same item on later passes and never raises a second one', async () => {
    const fx = await fixture();
    await fx.pass(at(31));
    await fx.pass(at(40));
    await fx.pass(at(55));
    expect(fx.attention.raises.map((raise) => raise.runId)).toEqual([RUN_ID, RUN_ID, RUN_ID]);
    expect(fx.attention.raises.map((raise) => raise.ageMinutes)).toEqual([31, 40, 55]);
    expect(fx.attention.open.size).toBe(1);
  });

  it('clears the item when the run leaves parked, and clears nothing while it stays parked', async () => {
    const fx = await fixture();
    await fx.pass(at(31));
    expect(fx.attention.clears).toEqual([]);

    // The run resumes: the park record is reset and the journal projects the state it returned to.
    const parked = await fx.repo.get(RUN_ID);
    if (parked === null) {
      throw new Error('fixture run must exist');
    }
    await fx.repo.acquireLease(RUN_ID, { holderId: HOLDER, observedFence: 0, leaseUntilIso: at(120), nowIso: at(35) });
    await fx.repo.save(
      { ...parked, parked: null, revision: parked.revision + 1, lease: { holderId: HOLDER, fence: 1, leaseUntilIso: at(120) } },
      { holderId: HOLDER, fence: 1, nowIso: at(35) },
    );
    await fx.journal.append(laneRunConductEntry('01M64PT1PX2MAZVQDYAYMZ7WN2', RUN_ID, 'fixing', at(35)));

    await fx.pass(at(36));
    expect(fx.attention.clears).toEqual([{ projectId: PROJECT_ID, runId: RUN_ID }]);
    expect(fx.attention.open.size).toBe(0);
    // A later pass has nothing left to clear.
    await fx.pass(at(40));
    expect(fx.attention.clears).toHaveLength(1);
  });

  it('reads the threshold from the policy value: a smaller one raises earlier', async () => {
    const fx = await fixture();
    await fx.pass(at(11), { stallAfterMinutes: 10 });
    expect(fx.attention.raises).toHaveLength(1);
    const later = await fixture();
    await later.pass(at(11), { stallAfterMinutes: 45 });
    expect(later.attention.raises).toEqual([]);
  });

  it('raises nothing for a run the journal does not show parked', async () => {
    const noTime = await fixture();
    const second = record({ runId: RUN_ID_2 });
    await noTime.repo.create(second);
    await noTime.pass(at(31));
    expect(noTime.attention.raises.map((raise) => raise.runId)).toEqual([RUN_ID]);
  });

  it('a run parked past the threshold WITH an open PR raises exactly one stall item', async () => {
    const withPr = await fixture({ prNumber: 812 });
    await withPr.pass(at(60));
    expect(withPr.attention.raises).toEqual([
      { projectId: PROJECT_ID, workOrderId: WORK_ORDER_ID, runId: RUN_ID, parkClass: 'step-refused', ageMinutes: 60 },
    ]);
    expect(withPr.attention.open.size).toBe(1);
  });

  it('a refused raise, an unreadable list and an unwired port never break the pass', async () => {
    const refused = await fixture();
    refused.attention.refuseRaises = true;
    expect(await refused.pass(at(31))).toMatchObject({ outcome: 'completed' });

    const unreadable = await fixture();
    unreadable.attention.listUnavailable = true;
    expect(await unreadable.pass(at(31))).toMatchObject({ outcome: 'completed' });
    expect(unreadable.attention.clears).toEqual([]);

    const unwired = await fixture();
    expect(await unwired.pass(at(31), { wired: false })).toMatchObject({ outcome: 'completed' });
    expect(unwired.attention.raises).toEqual([]);
  });

  it('through the real StallAttentionAdapter: one item per run, keyed by kind and subject, refreshed in place', async () => {
    const records: { body: Record<string, unknown>; actor: string }[] = [];
    const store = new Map<string, Record<string, unknown>>();
    const adapter = new StallAttentionAdapter({
      recordAttentionItem: async (body, actor) => {
        const typed = body as { projectId: string; kind: string; subject: { kind: string; ref: string } };
        records.push({ body: typed, actor });
        const key = JSON.stringify([typed.projectId, typed.subject.kind, typed.subject.ref, typed.kind]);
        const had = store.has(key);
        store.set(key, { item: typed });
        return { outcome: had ? 'refreshed' : 'raised' };
      },
      clearAttentionItem: async (request) => {
        const typed = request as { projectId: string; kind: string; subject: { kind: string; ref: string } };
        const key = JSON.stringify([typed.projectId, typed.subject.kind, typed.subject.ref, typed.kind]);
        return { outcome: store.delete(key) ? 'cleared' : 'not-found' };
      },
      listAttentionItems: async () => ({ items: [...store.values()].map((entry) => ({ item: entry.item })) }),
    });
    const repo = new LaneRunRepositoryAdapter();
    const journal = new LaneRunJournalAdapter();
    await repo.create(record());
    await journal.append(laneRunConductEntry('01M64PT1PX2MAZVQDYAYMZ7WN1', RUN_ID, 'parked', PARKED_AT));
    const pass = (nowIso: string) =>
      new RunConductorPassUseCase({
        driverLease: new ConductorDriverLeaseAdapter(),
        runRepo: repo,
        runJournal: journal,
        halt: new ConductorHaltAdapter(),
        resume: { applyPendingResume: async () => ({ outcome: 'none' }) },
        advance: idleAdvance,
        now: () => nowIso,
        stallAttention: adapter,
        workOrderRepo: { findWorkOrderById: async () => WORK_ORDER },
      }).runPass({ holderId: HOLDER, nowIso });
    await pass(at(31));
    await pass(at(47));
    expect(store.size).toBe(1);
    expect(records).toHaveLength(2);
    expect(records[1]?.body).toMatchObject({
      projectId: PROJECT_ID,
      kind: 'conductor-stall',
      subject: { kind: 'run', ref: RUN_ID },
      workOrderId: WORK_ORDER_ID,
    });
    expect(String(records[1]?.body.summary)).toBe(`stall:${RUN_ID} class=step-refused parked>=45m work-order=${WORK_ORDER_ID}`);
    expect(records[1]?.actor).toBe('conductor');
  });

  it('a non-parked gating run past the threshold raises one idle item, and a second pass does not open a second one', async () => {
    const repo = new LaneRunRepositoryAdapter();
    const journal = new LaneRunJournalAdapter();
    const attention = new FakeStallAttention();
    await repo.create(record({ parked: null, parkCount: 0, runId: RUN_ID_2 }));
    await journal.append(laneRunConductEntry('01M64PT1PX2MAZVQDYAYMZ7WN5', RUN_ID_2, 'gating', '2026-11-06T18:45:00.000Z'));
    const pass = (nowIso: string) =>
      new RunConductorPassUseCase({
        driverLease: new ConductorDriverLeaseAdapter(),
        runRepo: repo,
        runJournal: journal,
        halt: new ConductorHaltAdapter(),
        resume: { applyPendingResume: async () => ({ outcome: 'none' }) },
        advance: idleAdvance,
        now: () => nowIso,
        stallAttention: attention,
        workOrderRepo: { findWorkOrderById: async () => WORK_ORDER },
        stallAfterMinutes: 30,
      }).runPass({ holderId: HOLDER, nowIso });
    await pass('2026-11-06T21:00:00.000Z');
    expect(attention.raises).toEqual([
      { projectId: PROJECT_ID, workOrderId: WORK_ORDER_ID, runId: RUN_ID_2, state: 'gating', ageMinutes: 135, lastAdvancedAtIso: '2026-11-06T18:45:00.000Z' },
    ]);
    expect(attention.open.size).toBe(1);
    await pass('2026-11-06T21:05:00.000Z');
    expect(attention.open.size).toBe(1);
  });

  it('a watching-ci run past the threshold adds no raise', async () => {
    const repo = new LaneRunRepositoryAdapter();
    const journal = new LaneRunJournalAdapter();
    const attention = new FakeStallAttention();
    await repo.create(record({ parked: null, parkCount: 0, runId: RUN_ID_2 }));
    await journal.append(laneRunConductEntry('01M64PT1PX2MAZVQDYAYMZ7WN6', RUN_ID_2, 'watching-ci', '2026-11-06T18:45:00.000Z'));
    const pass = (nowIso: string) =>
      new RunConductorPassUseCase({
        driverLease: new ConductorDriverLeaseAdapter(),
        runRepo: repo,
        runJournal: journal,
        halt: new ConductorHaltAdapter(),
        resume: { applyPendingResume: async () => ({ outcome: 'none' }) },
        advance: idleAdvance,
        now: () => nowIso,
        stallAttention: attention,
        workOrderRepo: { findWorkOrderById: async () => WORK_ORDER },
        stallAfterMinutes: 30,
      }).runPass({ holderId: HOLDER, nowIso });
    await pass('2026-11-06T21:00:00.000Z');
    expect(attention.raises).toEqual([]);
  });
});
