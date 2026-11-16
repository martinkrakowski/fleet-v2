import { describe, expect, it } from 'vitest';

import type { CapacityReservationRecord } from '../../../domain/execution-records.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import type { AttemptRecord } from '../../../domain/execution-records.js';
import type {
  ReapOrphanReservationsRequest,
  ReapOrphanReservationsResult,
} from '../../ports/in/ReapOrphanReservationsPort.in-port.js';
import { ReapOrphanReservationsUseCase, type ReapOrphanReservationsDependencies } from '../ReapOrphanReservationsUseCase.use-case.js';

const NOW = '2026-11-16T12:00:00.000Z';

/** What the fake fenced release answers: an outcome object or a throw. */
type FakeReleaseOutcome = string | Error | { readonly outcome: string; readonly reason?: string };

function reservation(id: string, attemptId: string, overrides: Partial<Record<string, unknown>> = {}): CapacityReservationRecord {
  return {
    id,
    attemptId,
    hostId: 'local',
    slotIndex: 0,
    held: true,
    seatTool: null,
    workOrderId: 'wo-1',
    hostName: 'host-a',
    reservedAtIso: '2026-11-16T10:00:00.000Z',
    releasedAtIso: null,
    ...overrides,
  } as unknown as CapacityReservationRecord;
}

function runRecord(runId: string, attemptIds: readonly string[]): Record<string, unknown> {
  return {
    version: 1,
    runId,
    workOrderId: 'wo-1',
    attemptIds: [...attemptIds],
    round: 0,
    revision: 1,
  };
}

function conductEntry(runId: string, state: string): LaneRunJournalEntryRecord {
  return {
    version: 1,
    entryId: `01JB000000000000000000C0${state.length}`,
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
    state: state as never,
  };
}

function attemptRecord(id: string, overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id,
    workOrderId: 'wo-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/wt',
    baseCommit: 'a'.repeat(40),
    state: 'ended',
    revision: 3,
    createdAtIso: '2026-11-16T09:00:00.000Z',
    updatedAtIso: '2026-11-16T11:00:00.000Z',
    outcome: null,
    briefDigest: null,
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    ...overrides,
  };
}

/** The fenced release request the use case passes. */
interface FencedReleaseRequest {
  readonly attemptId: string;
  readonly reservationId: string;
  readonly attemptRevision: number;
  readonly readAttemptRevision: () => Promise<number | null>;
}

interface HarnessOptions {
  reservations?: readonly CapacityReservationRecord[];
  reservationsImpl?: () => Promise<unknown>;
  runs?: readonly Record<string, unknown>[];
  runsImpl?: () => Promise<unknown>;
  journalsByRun?: Map<string, LaneRunJournalEntryRecord[]>;
  listForRunImpl?: (runId: string) => Promise<unknown>;
  attempts?: Map<string, AttemptRecord | null>;
  findAttemptImpl?: (attemptId: string) => Promise<unknown>;
  releaseOutcome?: FakeReleaseOutcome;
  /** Replaces the canned release answer; it receives the real request, fence callback included. */
  releaseImpl?: (request: FencedReleaseRequest) => Promise<unknown>;
  /** Set to omit the fenced release method entirely (the unfenced-refusal case). */
  omitFencedRelease?: boolean;
  appendImpl?: (entry: LaneRunJournalEntryRecord) => Promise<unknown>;
  storeCallTimeoutMs?: number;
  maxReleasesPerPass?: number;
}

interface Harness {
  deps: ReapOrphanReservationsDependencies;
  releaseCalls: unknown[];
  releaseCallsUnfenced: unknown[];
  journalEntries: LaneRunJournalEntryRecord[];
  listForRunCalls: string[];
  findAttemptCalls: string[];
  listReservationsCalls: number;
  listRunsCalls: number;
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const releaseCalls: unknown[] = [];
  const releaseCallsUnfenced: unknown[] = [];
  const journalEntries: LaneRunJournalEntryRecord[] = [];
  const listForRunCalls: string[] = [];
  const findAttemptCalls: string[] = [];
  const journalsByRun = options.journalsByRun ?? new Map<string, LaneRunJournalEntryRecord[]>();
  const attempts = options.attempts ?? new Map<string, AttemptRecord | null>();
  let ulidCounter = 0;
  let listReservationsCalls = 0;
  let listRunsCalls = 0;

  const deps: ReapOrphanReservationsDependencies = {
    executionJournal: {
      listActiveReservations: async () => {
        listReservationsCalls += 1;
        if (options.reservationsImpl) {
          return (await options.reservationsImpl()) as readonly CapacityReservationRecord[];
        }
        return options.reservations ?? [];
      },
      ...(options.omitFencedRelease === true
        ? {}
        : {
            releaseCapacityReservationIfUnchanged: async (request: unknown) => {
              releaseCalls.push(request);
              if (options.releaseImpl) {
                return (await options.releaseImpl(request as FencedReleaseRequest)) as never;
              }
              if (options.releaseOutcome instanceof Error) {
                throw options.releaseOutcome;
              }
              const outcome = options.releaseOutcome ?? 'released';
              return typeof outcome === 'string' ? { outcome, reservationId: (request as { reservationId: string }).reservationId } : outcome;
            },
          }),
      releaseCapacityReservation: async (...args: unknown[]) => {
        releaseCallsUnfenced.push(args);
        return true;
      },
    } as ReapOrphanReservationsDependencies['executionJournal'],
    runRepo: {
      list: async () => {
        listRunsCalls += 1;
        if (options.runsImpl) {
          return (await options.runsImpl()) as readonly unknown[];
        }
        return options.runs ?? [];
      },
    } as ReapOrphanReservationsDependencies['runRepo'],
    runJournal: {
      append: async (entry: LaneRunJournalEntryRecord) => {
        if (options.appendImpl) {
          return (await options.appendImpl(entry)) as { outcome: 'appended'; entry: LaneRunJournalEntryRecord };
        }
        journalEntries.push(entry);
        return { outcome: 'appended', entry };
      },
      listForRun: async (runId: string) => {
        listForRunCalls.push(runId);
        if (options.listForRunImpl) {
          return (await options.listForRunImpl(runId)) as readonly LaneRunJournalEntryRecord[];
        }
        return journalsByRun.get(runId) ?? [];
      },
    },
    attemptRepo: {
      findAttemptById: async (attemptId: string) => {
        findAttemptCalls.push(attemptId);
        if (options.findAttemptImpl) {
          return (await options.findAttemptImpl(attemptId)) as AttemptRecord | null;
        }
        return attempts.get(attemptId) ?? null;
      },
    },
    newUlid: () => {
      ulidCounter += 1;
      return `01JB${'0'.repeat(18)}${String(ulidCounter).padStart(4, '0')}`;
    },
    ...(options.storeCallTimeoutMs !== undefined ? { storeCallTimeoutMs: options.storeCallTimeoutMs } : {}),
    ...(options.maxReleasesPerPass !== undefined ? { maxReleasesPerPass: options.maxReleasesPerPass } : {}),
  };

  // Live counters: getters, so an assertion reads the value at assertion time.
  return {
    deps,
    releaseCalls,
    releaseCallsUnfenced,
    journalEntries,
    listForRunCalls,
    findAttemptCalls,
    get listReservationsCalls() {
      return listReservationsCalls;
    },
    get listRunsCalls() {
      return listRunsCalls;
    },
  };
}

function run(harness: Harness, request: ReapOrphanReservationsRequest | unknown): Promise<ReapOrphanReservationsResult> {
  return new ReapOrphanReservationsUseCase(harness.deps).reapOrphanReservations(request as ReapOrphanReservationsRequest);
}

/** One terminal-run orphan fixture: reservation, terminal run, ended attempt. */
function orphanHarness(options: HarnessOptions = {}): Harness {
  return makeHarness({
    reservations: [reservation('res-1', 'att-1')],
    runs: [runRecord('run-01JB0000000000000000000001', ['att-1'])],
    journalsByRun: new Map([['run-01JB0000000000000000000001', [conductEntry('run-01JB0000000000000000000001', 'merged')]]]),
    attempts: new Map([['att-1', attemptRecord('att-1')]]),
    releaseOutcome: 'released',
    ...options,
  });
}

describe('ReapOrphanReservationsUseCase', () => {
  it('refuses hostile and invalid requests without reading stores', async () => {
    const cases: unknown[] = [
      null,
      undefined,
      ['array'],
      'string',
      42,
      { dryRun: 'yes', nowIso: NOW },
      { dryRun: true, nowIso: '2026-11-16 12:00:00' },
      { dryRun: true, nowIso: '2026-02-30T12:00:00.000Z' },
      { dryRun: true },
      { nowIso: NOW },
    ];
    // A request with a forbidden own key.
    const forbidden: Record<string, unknown> = { dryRun: true, nowIso: NOW };
    Object.defineProperty(forbidden, 'constructor', { value: {}, enumerable: true, configurable: true });
    cases.push(forbidden);
    // A request with a throwing getter.
    const throwing = Object.defineProperties(
      {},
      {
        dryRun: { get() { throw new Error('boom'); }, enumerable: true },
        nowIso: { value: NOW, enumerable: true },
      },
    );
    cases.push(throwing);
    // A Proxy with throwing traps: any own-key enumeration or value copy throws.
    cases.push(new Proxy({ dryRun: true, nowIso: NOW }, {
      get() { throw new Error('trap'); },
      ownKeys() { throw new Error('trap'); },
    }));

    for (const request of cases) {
      const harness = makeHarness({
        reservations: [reservation('res-1', 'att-1')],
        runs: [runRecord('run-01JB0000000000000000000001', ['att-1'])],
      });
      const result = await run(harness, request);
      expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
      expect(harness.listReservationsCalls).toBe(0);
      expect(harness.listRunsCalls).toBe(0);
    }
  });

  it('refuses a revoked-Proxy request and reads hostile store arrays as unknown, without throwing', async () => {
    // The request: `Array.isArray` on a revoked Proxy throws; the use case
    // must refuse it instead of escaping.
    const revokedRequest = Proxy.revocable({ dryRun: true, nowIso: NOW }, {});
    revokedRequest.revoke();
    const requestHarness = makeHarness({
      reservations: [reservation('res-1', 'att-1')],
      runs: [runRecord('run-01JB0000000000000000000001', ['att-1'])],
    });
    await expect(run(requestHarness, revokedRequest.proxy as unknown as { dryRun: boolean; nowIso: string })).resolves.toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(requestHarness.listReservationsCalls).toBe(0);

    // A store that answers with a Proxy whose traps throw on any read
    // except `then` (so the promise machinery itself can resolve it) —
    // `.length`, elements and own-key enumeration all throw.
    const hostile = new Proxy([reservation('res-1', 'att-1')], {
      get(_target, prop) {
        if (prop === 'then') {
          return undefined;
        }
        throw new Error('trap');
      },
      ownKeys() { throw new Error('trap'); },
    });
    const hostileReservations = makeHarness({ reservationsImpl: () => Promise.resolve(hostile as unknown as readonly CapacityReservationRecord[]), runs: [] });
    await expect(run(hostileReservations, { dryRun: false, nowIso: NOW })).resolves.toEqual({ outcome: 'unknown', reason: 'reservations-unreadable' });

    const hostileRuns = makeHarness({ reservations: [], runsImpl: () => Promise.resolve(hostile as unknown as readonly Record<string, unknown>[]) });
    await expect(run(hostileRuns, { dryRun: false, nowIso: NOW })).resolves.toEqual({ outcome: 'unknown', reason: 'runs-unreadable' });

    // A store that answers with a revoked Proxy: the promise machinery
    // itself refuses to resolve it, and the use case still returns a typed
    // unknown instead of throwing.
    const revokedStore = Proxy.revocable([reservation('res-1', 'att-1')], {});
    revokedStore.revoke();
    const reservationsHarness = makeHarness({ reservationsImpl: () => Promise.resolve(revokedStore.proxy as unknown as readonly CapacityReservationRecord[]), runs: [] });
    await expect(run(reservationsHarness, { dryRun: false, nowIso: NOW })).resolves.toEqual({ outcome: 'unknown', reason: 'reservations-unreadable' });
  });

  it('returns unknown reservations-unreadable on throw, timeout, or non-array', async () => {
    const throwing = makeHarness({ reservationsImpl: () => Promise.reject(new Error('down')), runs: [] });
    await expect(run(throwing, { dryRun: false, nowIso: NOW })).resolves.toEqual({ outcome: 'unknown', reason: 'reservations-unreadable' });

    const hanging = makeHarness({
      reservationsImpl: () => new Promise(() => {}),
      runs: [],
      storeCallTimeoutMs: 25,
    });
    await expect(run(hanging, { dryRun: false, nowIso: NOW })).resolves.toEqual({ outcome: 'unknown', reason: 'reservations-unreadable' });

    const nonArray = makeHarness({ reservationsImpl: () => Promise.resolve({ length: 1 }), runs: [] });
    await expect(run(nonArray, { dryRun: false, nowIso: NOW })).resolves.toEqual({ outcome: 'unknown', reason: 'reservations-unreadable' });

    expect(throwing.journalEntries).toHaveLength(0);
    expect(hanging.journalEntries).toHaveLength(0);
    expect(nonArray.journalEntries).toHaveLength(0);
  });

  it('fails closed as unknown reservations-unreadable when more reservations are held than the scan cap', async () => {
    // 10,001 held reservations: the 10,001st (index 10,000) is a terminal-run
    // orphan that a truncated scan would silently drop while still reporting
    // a clean reap. The pass must refuse to classify at all instead.
    const beyondCap = Array.from({ length: 10_000 }, (_, index) => reservation(`res-held-${index}`, `att-held-${index}`));
    beyondCap.push(reservation('res-orphan-10000', 'att-orphan-10000', { held: true }));
    const harness = makeHarness({
      reservations: beyondCap,
      runs: [runRecord('run-01JB0000000000000000000001', ['att-orphan-10000'])],
      journalsByRun: new Map([['run-01JB0000000000000000000001', [conductEntry('run-01JB0000000000000000000001', 'merged')]]]),
      attempts: new Map([['att-orphan-10000', attemptRecord('att-orphan-10000')]]),
    });
    await expect(run(harness, { dryRun: false, nowIso: NOW })).resolves.toEqual({ outcome: 'unknown', reason: 'reservations-unreadable' });
    expect(harness.listRunsCalls).toBe(0);
    expect(harness.releaseCalls).toHaveLength(0);
    expect(harness.releaseCallsUnfenced).toHaveLength(0);
    expect(harness.journalEntries).toHaveLength(0);
  });

  it('returns unknown runs-unreadable on throw, timeout, or non-array', async () => {
    const throwing = makeHarness({ reservations: [], runsImpl: () => Promise.reject(new Error('down')) });
    await expect(run(throwing, { dryRun: false, nowIso: NOW })).resolves.toEqual({ outcome: 'unknown', reason: 'runs-unreadable' });

    const hanging = makeHarness({ reservations: [], runsImpl: () => new Promise(() => {}), storeCallTimeoutMs: 25 });
    await expect(run(hanging, { dryRun: false, nowIso: NOW })).resolves.toEqual({ outcome: 'unknown', reason: 'runs-unreadable' });

    const nonArray = makeHarness({ reservations: [], runsImpl: () => Promise.resolve('nope') });
    await expect(run(nonArray, { dryRun: false, nowIso: NOW })).resolves.toEqual({ outcome: 'unknown', reason: 'runs-unreadable' });
  });

  it('releases a terminal-run orphan with intent before action through the fenced method', async () => {
    const harness = orphanHarness();
    const result = await run(harness, { dryRun: false, nowIso: NOW });
    expect(result.outcome).toBe('reaped');
    if (result.outcome !== 'reaped') return;
    expect(result.orphans).toHaveLength(1);
    expect(result.orphans[0]).toMatchObject({ reservationId: 'res-1', attemptId: 'att-1', reason: 'terminal-run', workOrderId: 'wo-1', hostName: 'host-a' });
    expect(result.released).toHaveLength(1);
    expect(result.released[0]?.reservationId).toBe('res-1');
    expect(result.failed).toHaveLength(0);
    expect(result.journalFailed).toHaveLength(0);
    // Intent before action, then the result.
    expect(harness.journalEntries.map((entry) => entry.kind)).toEqual(['intent', 'result']);
    expect(harness.journalEntries[0]?.kind === 'intent' && harness.journalEntries[0]?.mintedId).toBeTruthy();
    expect(harness.journalEntries[1]?.outcome).toBe('completed');
    expect(harness.journalEntries[1]?.key).toBe(harness.journalEntries[0]?.key);
    // Only the fenced method is called, with the attempt revision the pass read.
    expect(harness.releaseCalls).toHaveLength(1);
    expect(harness.releaseCalls[0]).toMatchObject({ attemptId: 'att-1', reservationId: 'res-1', attemptRevision: 3, releasedAtIso: NOW });
    expect(typeof (harness.releaseCalls[0] as { readAttemptRevision: unknown }).readAttemptRevision).toBe('function');
    expect(harness.releaseCallsUnfenced).toHaveLength(0);
  });

  it('classifies unreadable run journal as unknown run-state-unknown and never releases', async () => {
    const harness = orphanHarness({ listForRunImpl: () => Promise.reject(new Error('down')) });
    const result = await run(harness, { dryRun: false, nowIso: NOW });
    expect(result.outcome).toBe('reaped');
    if (result.outcome !== 'reaped') return;
    expect(result.unknown).toEqual([{ reservationId: 'res-1', attemptId: 'att-1', reason: 'run-state-unknown' }]);
    expect(result.orphans).toHaveLength(0);
    expect(result.released).toHaveLength(0);
    expect(harness.journalEntries).toHaveLength(0);
    expect(harness.releaseCalls).toHaveLength(0);
  });

  it('classifies unreadable attempt as unknown attempt-unreadable and never releases', async () => {
    const throwing = orphanHarness({ findAttemptImpl: () => Promise.reject(new Error('down')) });
    const throwingResult = await run(throwing, { dryRun: false, nowIso: NOW });
    expect(throwingResult.outcome === 'reaped' && throwingResult.unknown).toContainEqual({ reservationId: 'res-1', attemptId: 'att-1', reason: 'attempt-unreadable' });
    expect(throwingResult.outcome === 'reaped' && throwingResult.orphans).toHaveLength(0);
    expect(throwing.releaseCalls).toHaveLength(0);

    const hanging = orphanHarness({ findAttemptImpl: () => new Promise(() => {}), storeCallTimeoutMs: 25 });
    const hangingResult = await run(hanging, { dryRun: false, nowIso: NOW });
    expect(hangingResult.outcome === 'reaped' && hangingResult.unknown[0]?.reason).toBe('attempt-unreadable');
    expect(hanging.releaseCalls).toHaveLength(0);
  });

  it('reports a no-run reservation past the grace and release is never called for it', async () => {
    const harness = makeHarness({
      reservations: [reservation('res-lonely', 'att-9')],
      runs: [],
      attempts: new Map(),
      releaseOutcome: 'released',
    });
    const result = await run(harness, { dryRun: false, nowIso: NOW });
    expect(result.outcome).toBe('reaped');
    if (result.outcome !== 'reaped') return;
    expect(result.reportOnly).toEqual([{ reservationId: 'res-lonely', attemptId: 'att-9', reason: 'no-run-unstarted', reservedAtIso: '2026-11-16T10:00:00.000Z' }]);
    expect(result.orphans).toHaveLength(0);
    expect(result.released).toHaveLength(0);
    expect(harness.journalEntries).toHaveLength(0);
    expect(harness.releaseCalls).toHaveLength(0);
  });

  it('skips a no-run reservation inside the grace as within-grace, neither reported nor released', async () => {
    const harness = makeHarness({
      reservations: [reservation('res-young', 'att-9', { reservedAtIso: '2026-11-16T11:59:00.000Z' })],
      runs: [],
      attempts: new Map(),
      releaseOutcome: 'released',
    });
    const result = await run(harness, { dryRun: false, nowIso: NOW });
    expect(result.outcome === 'reaped' && result.skipped).toContainEqual({ reservationId: 'res-young', attemptId: 'att-9', reason: 'within-grace' });
    expect(result.outcome === 'reaped' && result.reportOnly).toHaveLength(0);
    expect(harness.releaseCalls).toHaveLength(0);
  });

  it('dry run classifies orphans and writes or releases nothing', async () => {
    const harness = orphanHarness();
    const result = await run(harness, { dryRun: true, nowIso: NOW });
    expect(result.outcome).toBe('reaped');
    if (result.outcome !== 'reaped') return;
    expect(result.dryRun).toBe(true);
    expect(result.orphans).toHaveLength(1);
    expect(result.reportOnly).toHaveLength(0);
    expect(result.released).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(result.journalFailed).toHaveLength(0);
    expect(harness.journalEntries).toHaveLength(0);
    expect(harness.releaseCalls).toHaveLength(0);
    expect(harness.releaseCallsUnfenced).toHaveLength(0);
  });

  it('refuses as unfenced before any intent append when releaseCapacityReservationIfUnchanged is absent', async () => {
    const harness = orphanHarness({ omitFencedRelease: true });
    const result = await run(harness, { dryRun: false, nowIso: NOW });
    expect(result.outcome).toBe('reaped');
    if (result.outcome !== 'reaped') return;
    expect(result.failed).toEqual([{ reservationId: 'res-1', attemptId: 'att-1', reason: 'unfenced' }]);
    expect(result.released).toHaveLength(0);
    expect(harness.journalEntries).toHaveLength(0);
    expect(harness.releaseCalls).toHaveLength(0);
    expect(harness.releaseCallsUnfenced).toHaveLength(0);
  });

  it('records invalid-key in failed when reaperRepairKey fails', async () => {
    const harness = orphanHarness({
      reservations: [reservation('res/with-slash', 'att-1')],
      releaseOutcome: 'released',
    });
    const result = await run(harness, { dryRun: false, nowIso: NOW });
    expect(result.outcome === 'reaped' && result.failed).toEqual([{ reservationId: 'res/with-slash', attemptId: 'att-1', reason: 'invalid-key' }]);
    expect(harness.journalEntries).toHaveLength(0);
    expect(harness.releaseCalls).toHaveLength(0);
  });

  it('records intent-failed and skips release when intent append fails', async () => {
    const throwing = orphanHarness({ appendImpl: () => Promise.reject(new Error('down')) });
    const throwingResult = await run(throwing, { dryRun: false, nowIso: NOW });
    expect(throwingResult.outcome === 'reaped' && throwingResult.failed).toEqual([{ reservationId: 'res-1', attemptId: 'att-1', reason: 'intent-failed' }]);
    expect(throwing.releaseCalls).toHaveLength(0);

    const hanging = orphanHarness({
      appendImpl: () => new Promise(() => {}),
      storeCallTimeoutMs: 25,
    });
    const hangingResult = await run(hanging, { dryRun: false, nowIso: NOW });
    expect(hangingResult.outcome === 'reaped' && hangingResult.failed[0]?.reason).toBe('intent-failed');
    expect(hanging.releaseCalls).toHaveLength(0);

    const refused = orphanHarness({
      appendImpl: () => Promise.resolve({ outcome: 'refused', reason: 'duplicate-intent', detail: null }),
    });
    const refusedResult = await run(refused, { dryRun: false, nowIso: NOW });
    expect(refusedResult.outcome === 'reaped' && refusedResult.failed[0]?.reason).toBe('intent-failed');
    expect(refused.releaseCalls).toHaveLength(0);
  });

  it('maps fenced release outcomes to journal and never retries changed unfenced', async () => {
    const cases: readonly { readonly outcome: FakeReleaseOutcome; readonly journal: string; readonly failed: string }[] = [
      { outcome: { outcome: 'changed' }, journal: 'refused', failed: 'changed' },
      { outcome: { outcome: 'not-held' }, journal: 'not-started', failed: 'not-held' },
      { outcome: { outcome: 'refused', reason: 'invalid-request' }, journal: 'refused', failed: 'refused' },
      { outcome: { outcome: 'unknown', reason: 'unreadable' }, journal: 'ambiguous', failed: 'ambiguous' },
      { outcome: new Error('down'), journal: 'ambiguous', failed: 'ambiguous' },
    ];
    for (const testCase of cases) {
      const harness = orphanHarness({ releaseOutcome: testCase.outcome });
      const result = await run(harness, { dryRun: false, nowIso: NOW });
      expect(result.outcome).toBe('reaped');
      if (result.outcome !== 'reaped') return;
      expect(result.released).toHaveLength(0);
      expect(result.failed[0]).toMatchObject({ reservationId: 'res-1', attemptId: 'att-1', reason: testCase.failed });
      expect(harness.journalEntries.map((entry) => entry.kind)).toEqual(['intent', 'result']);
      expect(harness.journalEntries[1]?.outcome).toBe(testCase.journal);
      // The fenced method is the only release ever called.
      expect(harness.releaseCalls).toHaveLength(1);
      expect(harness.releaseCallsUnfenced).toHaveLength(0);
    }
  });

  it('records result-append-failed in journalFailed when result append fails', async () => {
    let appendCount = 0;
    const harness = orphanHarness({
      appendImpl: (entry) => {
        appendCount += 1;
        if (appendCount === 1) {
          // The intent append succeeds.
          return Promise.resolve({ outcome: 'appended', entry });
        }
        return Promise.reject(new Error('down'));
      },
    });
    const result = await run(harness, { dryRun: false, nowIso: NOW });
    expect(result.outcome).toBe('reaped');
    if (result.outcome !== 'reaped') return;
    expect(result.released).toHaveLength(1);
    expect(result.journalFailed).toEqual([{ reservationId: 'res-1', attemptId: 'att-1', reason: 'result-append-failed' }]);
  });

  it('stops after maxReleasesPerPass and marks remaining orphans budget-exhausted', async () => {
    const reservations = [
      reservation('res-1', 'att-1'),
      reservation('res-2', 'att-2'),
      reservation('res-3', 'att-3'),
    ];
    const runs = [
      runRecord('run-01JB0000000000000000000001', ['att-1']),
      runRecord('run-01JB0000000000000000000002', ['att-2']),
      runRecord('run-01JB0000000000000000000003', ['att-3']),
    ];
    const harness = makeHarness({
      reservations,
      runs,
      journalsByRun: new Map([
        ['run-01JB0000000000000000000001', [conductEntry('run-01JB0000000000000000000001', 'merged')]],
        ['run-01JB0000000000000000000002', [conductEntry('run-01JB0000000000000000000002', 'merged')]],
        ['run-01JB0000000000000000000003', [conductEntry('run-01JB0000000000000000000003', 'merged')]],
      ]),
      attempts: new Map([
        ['att-1', attemptRecord('att-1')],
        ['att-2', attemptRecord('att-2')],
        ['att-3', attemptRecord('att-3')],
      ]),
      releaseOutcome: 'released',
      maxReleasesPerPass: 2,
    });
    const result = await run(harness, { dryRun: false, nowIso: NOW });
    expect(result.outcome).toBe('reaped');
    if (result.outcome !== 'reaped') return;
    expect(result.released.map((entry) => entry.reservationId)).toEqual(['res-1', 'res-2']);
    expect(result.failed).toEqual([{ reservationId: 'res-3', attemptId: 'att-3', reason: 'budget-exhausted' }]);
    expect(harness.releaseCalls).toHaveLength(2);
  });

  it('releases an orphan whose attempt has no revision field, reading absent as 0 on both sides of the fence', async () => {
    const attempt = attemptRecord('att-1');
    delete (attempt as { revision?: number }).revision;
    const harness = orphanHarness({
      attempts: new Map([['att-1', attempt]]),
      releaseImpl: async (request) => {
        const fresh = await request.readAttemptRevision();
        return fresh === request.attemptRevision ? { outcome: 'released' } : { outcome: 'unknown' };
      },
    });
    const result = await run(harness, { dryRun: false, nowIso: NOW });
    expect(result.outcome).toBe('reaped');
    if (result.outcome !== 'reaped') return;
    expect(harness.releaseCalls[0]).toMatchObject({ attemptRevision: 0 });
    expect(result.released.map((entry) => entry.reservationId)).toEqual(['res-1']);
    expect(result.failed).toHaveLength(0);
  });

  it('keeps a wrong-typed or negative re-read revision unreadable: the fence does not confirm', async () => {
    for (const revision of ['3', -1, 1.5, null]) {
      let reads = 0;
      const harness = orphanHarness({
        findAttemptImpl: async () => {
          reads += 1;
          // The classification read sees a valid attempt; the fence re-read sees the hostile revision.
          return reads === 1 ? attemptRecord('att-1') : attemptRecord('att-1', { revision: revision as never });
        },
        releaseImpl: async (request) => {
          const fresh = await request.readAttemptRevision();
          return fresh === request.attemptRevision ? { outcome: 'released' } : { outcome: 'unknown' };
        },
      });
      const result = await run(harness, { dryRun: false, nowIso: NOW });
      expect(result.outcome).toBe('reaped');
      if (result.outcome !== 'reaped') return;
      expect(result.released).toHaveLength(0);
      expect(result.failed.map((entry) => entry.reason)).toEqual(['ambiguous']);
    }
  });

  it('does not starve a 65th orphan: 64 attempts without a revision release, the next sweep takes the rest', async () => {
    const total = 65;
    const held = new Map<string, CapacityReservationRecord>();
    const runs: Record<string, unknown>[] = [];
    const journalsByRun = new Map<string, LaneRunJournalEntryRecord[]>();
    const attempts = new Map<string, AttemptRecord | null>();
    for (let index = 1; index <= total; index += 1) {
      const id = String(index).padStart(3, '0');
      held.set(`res-${id}`, reservation(`res-${id}`, `att-${id}`));
      const runId = `run-01JB${'0'.repeat(19)}${id}`;
      runs.push(runRecord(runId, [`att-${id}`]));
      journalsByRun.set(runId, [conductEntry(runId, 'merged')]);
      const attempt = attemptRecord(`att-${id}`);
      delete (attempt as { revision?: number }).revision;
      attempts.set(`att-${id}`, attempt);
    }
    const harness = makeHarness({
      reservationsImpl: async () => [...held.values()],
      runs,
      journalsByRun,
      attempts,
      releaseImpl: async (request) => {
        const fresh = await request.readAttemptRevision();
        if (fresh !== request.attemptRevision) {
          return { outcome: 'unknown' };
        }
        held.delete(request.reservationId);
        return { outcome: 'released' };
      },
    });
    const first = await run(harness, { dryRun: false, nowIso: NOW });
    expect(first.outcome).toBe('reaped');
    if (first.outcome !== 'reaped') return;
    expect(first.released).toHaveLength(64);
    expect(first.failed).toEqual([{ reservationId: 'res-065', attemptId: 'att-065', reason: 'budget-exhausted' }]);
    const second = await run(harness, { dryRun: false, nowIso: NOW });
    expect(second.outcome).toBe('reaped');
    if (second.outcome !== 'reaped') return;
    expect(second.released.map((entry) => entry.reservationId)).toEqual(['res-065']);
    expect(held.size).toBe(0);
  });

  it('does not release when the fence callback finds the attempt revision changed since classification', async () => {
    let reads = 0;
    const harness = orphanHarness({
      findAttemptImpl: async () => {
        reads += 1;
        return attemptRecord('att-1', { revision: reads === 1 ? 3 : 4 });
      },
      releaseImpl: async (request) => {
        const fresh = await request.readAttemptRevision();
        return fresh === request.attemptRevision ? { outcome: 'released' } : { outcome: 'changed' };
      },
    });
    const result = await run(harness, { dryRun: false, nowIso: NOW });
    expect(result.outcome).toBe('reaped');
    if (result.outcome !== 'reaped') return;
    expect(harness.releaseCalls).toHaveLength(1);
    expect(reads).toBe(2);
    expect(result.released).toHaveLength(0);
    expect(result.failed).toEqual([{ reservationId: 'res-1', attemptId: 'att-1', reason: 'changed' }]);
    expect(harness.journalEntries[1]?.outcome).toBe('refused');
  });

  it('does not release when the fence finds the reservation no longer the one classified', async () => {
    const harness = orphanHarness({
      releaseImpl: async (request) => {
        const stillHeld: readonly string[] = ['res-replacement'];
        return stillHeld.includes(request.reservationId) ? { outcome: 'released' } : { outcome: 'changed' };
      },
    });
    const result = await run(harness, { dryRun: false, nowIso: NOW });
    expect(result.outcome).toBe('reaped');
    if (result.outcome !== 'reaped') return;
    expect(result.released).toHaveLength(0);
    expect(result.failed).toEqual([{ reservationId: 'res-1', attemptId: 'att-1', reason: 'changed' }]);
  });

  it('releases nothing and reports every reservation unknown when a run attempt list is hostile', async () => {
    const revoked = Proxy.revocable(['att-1'], {});
    revoked.revoke();
    const harness = makeHarness({
      reservations: [reservation('res-1', 'att-1'), reservation('res-2', 'att-2')],
      runs: [
        { ...runRecord('run-01JB0000000000000000000001', []), attemptIds: revoked.proxy },
        runRecord('run-01JB0000000000000000000002', ['att-2']),
      ],
      journalsByRun: new Map([['run-01JB0000000000000000000002', [conductEntry('run-01JB0000000000000000000002', 'merged')]]]),
      attempts: new Map([
        ['att-1', attemptRecord('att-1')],
        ['att-2', attemptRecord('att-2')],
      ]),
      releaseOutcome: 'released',
    });
    const result = await run(harness, { dryRun: false, nowIso: NOW });
    expect(result.outcome).toBe('reaped');
    if (result.outcome !== 'reaped') return;
    expect(harness.releaseCalls).toHaveLength(0);
    expect(harness.journalEntries).toHaveLength(0);
    expect(result.released).toHaveLength(0);
    expect(result.unknown).toEqual([
      { reservationId: 'res-1', attemptId: 'att-1', reason: 'run-state-unknown' },
      { reservationId: 'res-2', attemptId: 'att-2', reason: 'run-state-unknown' },
    ]);
  });
});
