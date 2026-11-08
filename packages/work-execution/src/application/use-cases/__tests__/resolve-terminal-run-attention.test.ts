// U7: the conductor pass resolves open run-subject attention items whose run is terminal.
/**
 * One pass of the driver ends by resolving every open run-subject attention
 * item (any kind) whose subject run's journal state is `merged` or `stopped`.
 * Items are kept with a `cleared` marker (`reason: 'resolved'`), never
 * deleted, so the audit record of what paged survives. Live runs (`ready`,
 * `parked`, and every other non-terminal state) and runs missing from the run
 * repository are never resolved.
 */

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
import type { RunConductorPassResult } from '../../ports/in/RunConductorPassPort.in-port.js';
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';
import { RunConductorPassUseCase } from '../RunConductorPassUseCase.use-case.js';

/** Ids shaped like `.fleet/state/lane-runs.json`: run ULIDs, a work order id, a project id. */
const RUN_MERGED = 'run-01M63WPH4GMF2CA3NQ7JAM4HS1';
const RUN_STOPPED = 'run-01M63WPH4GMF2CA3NQ7JAM4HS2';
const RUN_LIVE_RUNNING = 'run-01M63WPH4GMF2CA3NQ7JAM4HS3';
const RUN_LIVE_WATCHING = 'run-01M63WPH4GMF2CA3NQ7JAM4HS4';
const RUN_LIVE_READY = 'run-01M63WPH4GMF2CA3NQ7JAM4HS5';
const RUN_LIVE_PARKED = 'run-01M63WPH4GMF2CA3NQ7JAM4HS6';
const RUN_UNKNOWN = 'run-01M63WPH4GMF2CA3NQ7JAM4HS9';
const WORK_ORDER_ID = 'wo-fleet-v2-sr1c-dedupe-2026-10-29';
const PROJECT_ID = 'fleet-v2';
const HOLDER = 'driver-example-1';
const PARKED_AT = '2026-11-07T10:00:00.000Z';

const PARK: LaneRunParkRecord = {
  reason: 'step-refused',
  qualifier: 'prepare',
  parkedFrom: 'fixing',
  questionId: null,
  class: 'step-refused',
};

const WORK_ORDER = { id: WORK_ORDER_ID, projectId: PROJECT_ID } as unknown as WorkOrderRecord;

let entrySeq = 0;
function nextEntryId(): string {
  entrySeq += 1;
  return `01M64PT1PX2MAZVQDYAYMZ7W${String(entrySeq).padStart(2, '0')}`;
}

function at(minutesAfterPark: number): string {
  return new Date(Date.parse(PARKED_AT) + minutesAfterPark * 60_000).toISOString();
}

function record(overrides: Partial<LaneRunRecord> = {}): LaneRunRecord {
  const created = LaneRun.create({
    version: 1,
    runId: RUN_MERGED,
    workOrderId: WORK_ORDER_ID,
    tier: 2,
    seatPlanRef: 'a'.repeat(64),
    cursors: { 'first-pass': 0, fix: null, review: null },
    round: 0,
    attemptIds: ['attempt-01M64PT1PX2MAZVQDYAYMZ7WNB'],
    prNumber: null,
    parked: null,
    parkCount: 0,
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

/** One stored attention item, kept (never deleted) like the real attention store. */
interface StoreItem {
  readonly projectId: string;
  readonly kind: string;
  readonly subject: { readonly kind: string; readonly ref: string };
  state: 'open' | 'cleared';
  clearReason: string | null;
}

/**
 * An in-memory attention-store fake behind the real `StallAttentionAdapter`:
 * items are keyed by project, kind and subject ref; clearing keeps the item
 * with a `cleared` marker and records every clear call.
 */
class AttentionStore {
  readonly items = new Map<string, StoreItem>();
  readonly clears: { readonly request: Record<string, unknown>; readonly via: string; readonly actor: string }[] = [];

  key(projectId: string, kind: string, ref: string): string {
    return JSON.stringify([projectId, kind, ref]);
  }

  seed(kind: string, runId: string, projectId = PROJECT_ID): void {
    this.items.set(this.key(projectId, kind, runId), {
      projectId,
      kind,
      subject: { kind: 'run', ref: runId },
      state: 'open',
      clearReason: null,
    });
  }

  item(kind: string, runId: string, projectId = PROJECT_ID): StoreItem | undefined {
    return this.items.get(this.key(projectId, kind, runId));
  }

  openItems(): StoreItem[] {
    return [...this.items.values()].filter((item) => item.state === 'open');
  }

  clearsFor(kind: string, runId: string, projectId = PROJECT_ID): number {
    return this.clears.filter(
      (call) =>
        call.request.projectId === projectId &&
        call.request.kind === kind &&
        (call.request.subject as { ref?: string }).ref === runId,
    ).length;
  }
}

function storeDelegate(store: AttentionStore): {
  recordAttentionItem: (body: unknown, actor: string) => Promise<unknown>;
  clearAttentionItem: (request: unknown, via: string, actor: string) => Promise<unknown>;
  listAttentionItems: (request: { readonly kind?: string; readonly state: 'open' }) => Promise<unknown>;
} {
  return {
    recordAttentionItem: async (body) => {
      const typed = body as { projectId: string; kind: string; subject: { kind: string; ref: string } };
      const key = store.key(typed.projectId, typed.kind, typed.subject.ref);
      const had = store.items.has(key);
      store.items.set(key, {
        projectId: typed.projectId,
        kind: typed.kind,
        subject: typed.subject,
        state: 'open',
        clearReason: null,
      });
      return { outcome: had ? 'refreshed' : 'raised' };
    },
    clearAttentionItem: async (request, via, actor) => {
      const typed = request as {
        projectId: string;
        kind: string;
        subject: { kind: string; ref: string };
        reason: string;
      };
      store.clears.push({ request: typed, via, actor });
      const item = store.item(typed.kind, typed.subject.ref, typed.projectId);
      if (item === undefined) {
        return { outcome: 'not-found' };
      }
      if (item.state === 'cleared') {
        return { outcome: 'unchanged' };
      }
      item.state = 'cleared';
      item.clearReason = typed.reason;
      return { outcome: 'cleared' };
    },
    listAttentionItems: async (request) => {
      const matches = [...store.items.values()].filter(
        (item) => item.state === request.state && (request.kind === undefined || item.kind === request.kind),
      );
      return { items: matches.map((item) => ({ item })) };
    },
  };
}

const idleAdvance: AdvanceLaneRunPort = {
  advanceLaneRun: async () => ({ outcome: 'waiting', reason: 'admission' }),
};

interface Fixture {
  readonly repo: LaneRunRepositoryAdapter;
  readonly journal: LaneRunJournalAdapter;
  readonly store: AttentionStore;
  readonly adapter: StallAttentionAdapter;
  readonly pass: (nowIso: string) => Promise<RunConductorPassResult>;
}

interface SeedRun {
  readonly runId: string;
  /** The journal state to project; null leaves the run with no journal entry (`ready`). */
  readonly state: LaneRunStateValue | null;
  /** Whether the run record carries a park (`parked` runs need one to stall). */
  readonly parked?: boolean;
}

async function fixture(runs: readonly SeedRun[], options: { workOrderRepo?: boolean } = {}): Promise<Fixture> {
  const repo = new LaneRunRepositoryAdapter();
  const journal = new LaneRunJournalAdapter();
  const store = new AttentionStore();
  const adapter = new StallAttentionAdapter(storeDelegate(store));
  for (const seed of runs) {
    const overrides: Partial<LaneRunRecord> =
      seed.parked === true ? { runId: seed.runId, parked: PARK, parkCount: 1 } : { runId: seed.runId };
    await repo.create(record(overrides));
    if (seed.state !== null) {
      await journal.append(laneRunConductEntry(nextEntryId(), seed.runId, seed.state, PARKED_AT));
    }
  }
  return {
    repo,
    journal,
    store,
    adapter,
    pass: (nowIso) =>
      new RunConductorPassUseCase({
        driverLease: new ConductorDriverLeaseAdapter(),
        runRepo: repo,
        runJournal: journal,
        halt: new ConductorHaltAdapter(),
        resume: { applyPendingResume: async () => ({ outcome: 'none' }) },
        advance: idleAdvance,
        now: () => nowIso,
        stallAttention: adapter,
        ...(options.workOrderRepo === false ? {} : { workOrderRepo: { findWorkOrderById: async () => WORK_ORDER } }),
      }).runPass({ holderId: HOLDER, nowIso }),
  };
}

describe('RunConductorPassUseCase terminal-run attention resolution (U7)', () => {
  it('resolves open run-subject items of a merged and a stopped run on the next pass, keeping them for audit', async () => {
    const fx = await fixture([
      { runId: RUN_MERGED, state: 'merged' },
      { runId: RUN_STOPPED, state: 'stopped' },
    ]);
    fx.store.seed('conductor-park', RUN_MERGED);
    fx.store.seed('conductor-stall', RUN_MERGED);
    fx.store.seed('conductor-park', RUN_STOPPED);

    const result = await fx.pass(at(1));
    expect(result).toMatchObject({ outcome: 'completed' });
    for (const [kind, runId] of [
      ['conductor-park', RUN_MERGED],
      ['conductor-stall', RUN_MERGED],
      ['conductor-park', RUN_STOPPED],
    ] as const) {
      const item = fx.store.item(kind, runId);
      expect(item?.state).toBe('cleared');
      expect(item?.clearReason).toBe('resolved');
    }
    expect(fx.store.clears.length).toBe(3);
    for (const call of fx.store.clears) {
      expect(call.via).toBe('machine');
      expect(call.actor).toBe('conductor');
      expect(call.request).toMatchObject({ action: 'resolve', reason: 'resolved', subject: { kind: 'run' } });
    }
    expect(fx.store.openItems()).toEqual([]);
  });

  it('leaves open run-subject items of live runs untouched', async () => {
    const fx = await fixture([
      { runId: RUN_LIVE_RUNNING, state: 'running' },
      { runId: RUN_LIVE_WATCHING, state: 'watching-ci' },
      { runId: RUN_LIVE_READY, state: null },
      { runId: RUN_LIVE_PARKED, state: 'parked', parked: true },
    ]);
    fx.store.seed('conductor-park', RUN_LIVE_RUNNING);
    fx.store.seed('conductor-park', RUN_LIVE_WATCHING);
    fx.store.seed('conductor-park', RUN_LIVE_READY);
    fx.store.seed('conductor-park', RUN_LIVE_PARKED);

    const result = await fx.pass(at(5));
    expect(result).toMatchObject({ outcome: 'completed' });
    expect(fx.store.clears).toEqual([]);
    for (const runId of [RUN_LIVE_RUNNING, RUN_LIVE_WATCHING, RUN_LIVE_READY, RUN_LIVE_PARKED]) {
      expect(fx.store.item('conductor-park', runId)?.state).toBe('open');
    }
    expect(fx.store.openItems()).toHaveLength(4);
  });

  it('an item whose subject run no longer exists is left untouched and the pass still completes', async () => {
    const fx = await fixture([{ runId: RUN_MERGED, state: 'merged' }]);
    fx.store.seed('conductor-park', RUN_UNKNOWN);

    const result = await fx.pass(at(1));
    expect(result).toMatchObject({ outcome: 'completed' });
    expect(fx.store.clears).toEqual([]);
    expect(fx.store.item('conductor-park', RUN_UNKNOWN)?.state).toBe('open');
  });

  it('resolving is idempotent across repeated passes and handles `unchanged` cleanly', async () => {
    const fx = await fixture([{ runId: RUN_MERGED, state: 'merged' }]);
    fx.store.seed('conductor-park', RUN_MERGED);

    const first = await fx.pass(at(1));
    expect(first).toMatchObject({ outcome: 'completed' });
    expect(fx.store.clears).toHaveLength(1);
    expect(fx.store.item('conductor-park', RUN_MERGED)?.state).toBe('cleared');

    const second = await fx.pass(at(2));
    expect(second).toMatchObject({ outcome: 'completed' });
    expect(fx.store.clears).toHaveLength(1);

    // The adapter resolves an already-cleared item to `unchanged`, never a throw.
    expect(await fx.adapter.resolveRunAttention({ projectId: PROJECT_ID, kind: 'conductor-park', runId: RUN_MERGED })).toEqual({
      outcome: 'unchanged',
      reasonCode: null,
    });
  });

  it('a live stall item on a run parked past the threshold is refreshed, never resolved by this path', async () => {
    const fx = await fixture([{ runId: RUN_LIVE_PARKED, state: 'parked', parked: true }]);
    fx.store.seed('conductor-stall', RUN_LIVE_PARKED);

    const result = await fx.pass(at(31));
    expect(result).toMatchObject({ outcome: 'completed' });
    expect(fx.store.clearsFor('conductor-stall', RUN_LIVE_PARKED)).toBe(0);
    const item = fx.store.item('conductor-stall', RUN_LIVE_PARKED);
    expect(item?.state).toBe('open');
    expect(item?.clearReason).toBeNull();
  });
});

describe('StallAttentionAdapter run attention (U7)', () => {
  it('lists open run-subject items across kinds with no kind filter, dropping non-run subjects and invalid entries', async () => {
    const listCalls: { kind?: string; state: 'open' }[] = [];
    const adapter = new StallAttentionAdapter({
      listAttentionItems: async (request) => {
        listCalls.push(request);
        return {
          items: [
            { item: { projectId: PROJECT_ID, kind: 'conductor-park', subject: { kind: 'run', ref: RUN_MERGED } } },
            { item: { projectId: PROJECT_ID, kind: 'conductor-stall', subject: { kind: 'run', ref: RUN_STOPPED } } },
            { item: { projectId: PROJECT_ID, kind: 'conductor-park', subject: { kind: 'pr', ref: '42' } } },
            { item: { projectId: PROJECT_ID, kind: 'Bad_Kind', subject: { kind: 'run', ref: RUN_MERGED } } },
            { item: { projectId: PROJECT_ID, kind: 'conductor-park', subject: { kind: 'run', ref: 'not-a-run-id' } } },
            { item: { projectId: 'bad/project', kind: 'conductor-park', subject: { kind: 'run', ref: RUN_MERGED } } },
            { item: 'not-an-object' },
          ],
        };
      },
    });
    const result = await adapter.listOpenRunAttention();
    expect(listCalls).toEqual([{ state: 'open' }]);
    expect(result).toEqual({
      outcome: 'found',
      items: [
        { projectId: PROJECT_ID, kind: 'conductor-park', runId: RUN_MERGED },
        { projectId: PROJECT_ID, kind: 'conductor-stall', runId: RUN_STOPPED },
      ],
    });
  });

  it('listOpenRunAttention answers unavailable without a delegate, on an unreadable store or on a malformed answer', async () => {
    expect(await new StallAttentionAdapter().listOpenRunAttention()).toEqual({ outcome: 'unavailable' });
    expect(
      await new StallAttentionAdapter({ listAttentionItems: async () => Promise.reject(new Error('down')) }).listOpenRunAttention(),
    ).toEqual({ outcome: 'unavailable' });
    expect(
      await new StallAttentionAdapter({ listAttentionItems: async () => ({ items: 'nope' }) }).listOpenRunAttention(),
    ).toEqual({ outcome: 'unavailable' });
  });

  it('resolveRunAttention refuses invalid inputs without throwing and reports not-configured without a delegate', async () => {
    const adapter = new StallAttentionAdapter();
    expect(
      await adapter.resolveRunAttention({ projectId: 'bad/project', kind: 'conductor-park', runId: RUN_MERGED }),
    ).toEqual({ outcome: 'refused', reasonCode: 'invalid-request' });
    expect(await adapter.resolveRunAttention({ projectId: PROJECT_ID, kind: 'Bad_Kind', runId: RUN_MERGED })).toEqual({
      outcome: 'refused',
      reasonCode: 'invalid-request',
    });
    expect(await adapter.resolveRunAttention({ projectId: PROJECT_ID, kind: 'conductor-park', runId: 'nope' })).toEqual({
      outcome: 'refused',
      reasonCode: 'invalid-request',
    });
    expect(await adapter.resolveRunAttention({ projectId: PROJECT_ID, kind: 'conductor-park', runId: RUN_MERGED })).toEqual({
      outcome: 'refused',
      reasonCode: 'not-configured',
    });
  });

  it('resolveRunAttention resolves by kind and subject as `resolved` via `machine`, and maps refusals', async () => {
    const store = new AttentionStore();
    store.seed('conductor-park', RUN_MERGED);
    const calls: unknown[] = [];
    function delegateClear(request: unknown): unknown {
      const typed = request as { projectId: string; kind: string; subject: { ref: string }; reason: string };
      const item = store.item(typed.kind, typed.subject.ref, typed.projectId);
      if (item === undefined) {
        return { outcome: 'not-found' };
      }
      if (item.state === 'cleared') {
        return { outcome: 'unchanged' };
      }
      item.state = 'cleared';
      item.clearReason = typed.reason;
      return { outcome: 'cleared' };
    }
    const adapter2 = new StallAttentionAdapter({
      clearAttentionItem: async (request, via, actor) => {
        calls.push({ request, via, actor });
        return delegateClear(request);
      },
    });
    expect(await adapter2.resolveRunAttention({ projectId: PROJECT_ID, kind: 'conductor-park', runId: RUN_MERGED })).toEqual({
      outcome: 'cleared',
      reasonCode: null,
    });
    expect(calls).toEqual([
      {
        request: {
          action: 'resolve',
          projectId: PROJECT_ID,
          kind: 'conductor-park',
          subject: { kind: 'run', ref: RUN_MERGED },
          reason: 'resolved',
        },
        via: 'machine',
        actor: 'conductor',
      },
    ]);
    expect(
      await adapter2.resolveRunAttention({ projectId: PROJECT_ID, kind: 'conductor-park', runId: RUN_STOPPED }),
    ).toEqual({ outcome: 'not-found', reasonCode: null });
    const refused = new StallAttentionAdapter({ clearAttentionItem: async () => ({ outcome: 'refused', code: 'store-unreadable' }) });
    expect(await refused.resolveRunAttention({ projectId: PROJECT_ID, kind: 'conductor-park', runId: RUN_MERGED })).toEqual({
      outcome: 'refused',
      reasonCode: 'store-unreadable',
    });
    const unreadable = new StallAttentionAdapter({ clearAttentionItem: async () => ({ nonsense: true }) });
    expect(await unreadable.resolveRunAttention({ projectId: PROJECT_ID, kind: 'conductor-park', runId: RUN_MERGED })).toEqual({
      outcome: 'refused',
      reasonCode: 'unreadable',
    });
    const throwingDelegate = new StallAttentionAdapter({
      clearAttentionItem: async () => Promise.reject(new Error('down')),
    });
    expect(await throwingDelegate.resolveRunAttention({ projectId: PROJECT_ID, kind: 'conductor-park', runId: RUN_MERGED })).toEqual({
      outcome: 'refused',
      reasonCode: 'unreadable',
    });
  });
});
