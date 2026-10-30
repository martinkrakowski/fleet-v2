// RunConductorPassUseCase tests — K7-6.
/**
 * One pass of the driver: takes or renews the driver lease, reads the halt
 * marker, and for each non-terminal run takes or renews its run lease, applies
 * a recorded resume, then advances it until it waits, parks, ends or a step is
 * not built, at most eight steps. Leases are released separately on shutdown.
 */

import { describe, expect, it } from 'vitest';

import { LaneRun } from '../../../domain/entities/LaneRun.js';
import { laneRunConductEntry } from '../../../domain/lane-run-step-facts.js';
import type { LaneRunParkRecord, LaneRunRecord } from '../../../domain/lane-run-records.js';
import { ConductorDriverLeaseAdapter } from '../../../infrastructure/adapters/ConductorDriverLeaseAdapter.adapter.js';
import { ConductorHaltAdapter } from '../../../infrastructure/adapters/ConductorHaltAdapter.adapter.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import type { ConductorDriverLeasePort } from '../../ports/out/ConductorDriverLeasePort.out-port.js';
import type { AdvanceLaneRunPort, AdvanceLaneRunRequest, AdvanceLaneRunResult } from '../../ports/in/AdvanceLaneRunPort.in-port.js';
import type { RunConductorPassResult } from '../../ports/in/RunConductorPassPort.in-port.js';
import { ResumeLaneRunUseCase } from '../ResumeLaneRunUseCase.use-case.js';
import { RunConductorPassUseCase } from '../RunConductorPassUseCase.use-case.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const RUN_ID_2 = 'run-01JB0000000000000000000001';
const NOW = '2026-10-27T10:00:00.000Z';
const SOON = '2026-10-27T10:02:00.000Z';
const LATER = '2026-10-27T10:06:00.000Z';
const HOLDER = 'driver-example-1';
const HOLDER_2 = 'driver-example-2';
const HOLDER_3 = 'driver-example-3';
const ENTRY_1 = '01JB0000000000000000000001';
const ENTRY_2 = '01JB0000000000000000000002';
const LEASE_UNTIL = '2026-10-27T10:10:00.000Z';

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

function freshUlidFactory(): () => string {
  // Starts after the fixture's constant entry ids (ENTRY_1, ENTRY_2).
  let next = 3;
  return () => {
    const id = '01JB00000000000000000000' + String(next).padStart(2, '0');
    next += 1;
    return id;
  };
}

interface Stores {
  repo: LaneRunRepositoryAdapter;
  journal: LaneRunJournalAdapter;
  driverLease: ConductorDriverLeaseAdapter;
  halt: ConductorHaltAdapter;
}

function stores(): Stores {
  return {
    repo: new LaneRunRepositoryAdapter(),
    journal: new LaneRunJournalAdapter(),
    driverLease: new ConductorDriverLeaseAdapter(),
    halt: new ConductorHaltAdapter(),
  };
}

/** A scripted advance fake: a queue of results per run, recording each request and the run's park then. */
class ScriptedAdvance implements AdvanceLaneRunPort {
  readonly calls: { request: AdvanceLaneRunRequest; parked: LaneRunParkRecord | null }[] = [];
  private readonly used = new Map<string, number>();

  constructor(
    private readonly queue: ReadonlyMap<string, readonly AdvanceLaneRunResult[]>,
    private readonly parkedAt: () => Promise<LaneRunParkRecord | null> = async () => null,
  ) {}

  async advanceLaneRun(request: AdvanceLaneRunRequest): Promise<AdvanceLaneRunResult> {
    this.calls.push({ request, parked: await this.parkedAt() });
    const index = this.used.get(request.runId) ?? 0;
    this.used.set(request.runId, index + 1);
    const results = this.queue.get(request.runId);
    return results !== undefined && index < results.length
      ? results[index]
      : { outcome: 'waiting', reason: 'admission' };
  }
}

async function createRun(repo: LaneRunRepositoryAdapter, overrides: Partial<LaneRunRecord> = {}): Promise<LaneRunRecord> {
  const record = runRecord(overrides);
  expect(await repo.create(record)).toEqual({ outcome: 'saved', record });
  return record;
}

function useCase(fx: Stores, advance: ScriptedAdvance, resume?: ResumeLaneRunUseCase, now: () => string = () => NOW): RunConductorPassUseCase {
  return new RunConductorPassUseCase({
    driverLease: fx.driverLease,
    runRepo: fx.repo,
    runJournal: fx.journal,
    halt: fx.halt,
    resume: resume ?? { applyPendingResume: async () => ({ outcome: 'none' }) },
    advance,
    now,
  });
}

async function runPass(
  fx: Stores,
  holderId: string,
  nowIso: string,
  advance: ScriptedAdvance,
  resume?: ResumeLaneRunUseCase,
  now: () => string = () => nowIso,
): Promise<RunConductorPassResult> {
  return useCase(fx, advance, resume, now).runPass({ holderId, nowIso });
}

describe('RunConductorPassUseCase driver lease', () => {
  it('a first pass acquires the driver lease at fence 1; a second renews it at the same fence with a later leaseUntilIso', async () => {
    const fx = stores();
    const advance = new ScriptedAdvance(new Map());
    const first = await runPass(fx, HOLDER, NOW, advance);
    expect(first).toMatchObject({ outcome: 'completed', halted: false, progressed: false });
    expect(await fx.driverLease.read()).toMatchObject({ holderId: HOLDER, fence: 1 });
    expect((await fx.driverLease.read())?.leaseUntilIso).toBe('2026-10-27T10:05:00.000Z');

    const second = await runPass(fx, HOLDER, SOON, advance);
    expect(second).toMatchObject({ outcome: 'completed' });
    expect(await fx.driverLease.read()).toMatchObject({ holderId: HOLDER, fence: 1 });
    expect((await fx.driverLease.read())?.leaseUntilIso).toBe('2026-10-27T10:07:00.000Z');
  });

  it('another holder while the lease is live is refused driver-lease-held and the advance fake is never called', async () => {
    const fx = stores();
    const advance = new ScriptedAdvance(new Map());
    await runPass(fx, HOLDER, NOW, advance);
    expect(await runPass(fx, HOLDER_2, SOON, advance)).toEqual({
      outcome: 'refused',
      reason: 'driver-lease-held',
    });
    expect(advance.calls).toEqual([]);
  });

  it('after the lease lapses, another holder acquires at fence 2', async () => {
    const fx = stores();
    const advance = new ScriptedAdvance(new Map());
    await runPass(fx, HOLDER, NOW, advance);
    const result = await runPass(fx, HOLDER_2, LATER, advance);
    expect(result).toMatchObject({ outcome: 'completed' });
    expect(await fx.driverLease.read()).toMatchObject({ holderId: HOLDER_2, fence: 2 });
  });
});

describe('RunConductorPassUseCase run leases', () => {
  it('a run another live holder leases is skipped lease-held and never advanced', async () => {
    const fx = stores();
    await createRun(fx.repo);
    await fx.repo.acquireLease(RUN_ID, {
      holderId: HOLDER_2,
      observedFence: 0,
      leaseUntilIso: LEASE_UNTIL,
      nowIso: NOW,
    });
    const advance = new ScriptedAdvance(new Map());
    const result = await runPass(fx, HOLDER, NOW, advance);
    expect(result).toMatchObject({ outcome: 'completed', progressed: false });
    if (result.outcome !== 'completed') {
      throw new Error('expected completed');
    }
    expect(result.runs).toEqual([{ runId: RUN_ID, outcome: 'skipped', reason: 'lease-held' }]);
    expect(advance.calls).toEqual([]);
    expect((await fx.repo.get(RUN_ID))?.lease).toMatchObject({ holderId: HOLDER_2, fence: 1 });
  });

  it('a lapsed run lease is taken at fence + 1 and advanced with that fence', async () => {
    const fx = stores();
    await createRun(fx.repo);
    await fx.repo.acquireLease(RUN_ID, {
      holderId: HOLDER,
      observedFence: 0,
      leaseUntilIso: SOON,
      nowIso: NOW,
    });
    const advance = new ScriptedAdvance(new Map([[RUN_ID, [{ outcome: 'waiting', reason: 'admission' }]]]));
    const result = await runPass(fx, HOLDER_2, LATER, advance);
    expect(result).toMatchObject({ outcome: 'completed' });
    expect((await fx.repo.get(RUN_ID))?.lease).toMatchObject({ holderId: HOLDER_2, fence: 2 });
    expect(advance.calls).toHaveLength(1);
    expect(advance.calls[0].request.lease).toEqual({ holderId: HOLDER_2, fence: 2 });
  });
});

describe('RunConductorPassUseCase step loop', () => {
  it('entered, acted and waiting admission are three calls and report progressed', async () => {
    const fx = stores();
    await createRun(fx.repo);
    const progressResults: AdvanceLaneRunResult[] = [
      { outcome: 'entered', state: 'dispatching' },
      {
        outcome: 'acted',
        step: 'dispatch',
        key: `${RUN_ID}/r0/dispatch/0/a1`,
        result: 'completed',
        reasonCode: 'dispatch-started',
      },
      { outcome: 'waiting', reason: 'admission' },
    ];
    const advance = new ScriptedAdvance(new Map([[RUN_ID, progressResults]]));
    const result = await runPass(fx, HOLDER, NOW, advance);
    expect(result).toMatchObject({ outcome: 'completed', progressed: true });
    if (result.outcome !== 'completed') {
      throw new Error('expected completed');
    }
    expect(result.runs).toEqual([{ runId: RUN_ID, outcome: 'advanced', steps: progressResults }]);
    expect(advance.calls).toHaveLength(3);
  });

  it('entered steps stop at the eight-step ceiling', async () => {
    const fx = stores();
    await createRun(fx.repo);
    const enteredResults: AdvanceLaneRunResult[] = Array.from({ length: 9 }, () => ({
      outcome: 'entered',
      state: 'dispatching',
    }));
    const advance = new ScriptedAdvance(new Map([[RUN_ID, enteredResults]]));
    const result = await runPass(fx, HOLDER, NOW, advance);
    expect(result).toMatchObject({ outcome: 'completed', progressed: true });
    if (result.outcome !== 'completed') {
      throw new Error('expected completed');
    }
    const report = result.runs[0];
    expect(report).toMatchObject({ runId: RUN_ID, outcome: 'advanced' });
    if (report.outcome !== 'advanced') {
      throw new Error('expected advanced');
    }
    expect(report.steps).toHaveLength(8);
    expect(report.steps.every((step) => step.outcome === 'entered')).toBe(true);
    expect(advance.calls).toHaveLength(8);
  });

  it('a not-built step ends the run turn and is reported without progress', async () => {
    const fx = stores();
    await createRun(fx.repo);
    const notBuilt: AdvanceLaneRunResult[] = [{ outcome: 'not-built', decision: 'act', step: 'prepare' }];
    const advance = new ScriptedAdvance(new Map([[RUN_ID, notBuilt]]));
    const result = await runPass(fx, HOLDER, NOW, advance);
    expect(result).toMatchObject({ outcome: 'completed', progressed: false });
    if (result.outcome !== 'completed') {
      throw new Error('expected completed');
    }
    expect(result.runs).toEqual([{ runId: RUN_ID, outcome: 'advanced', steps: notBuilt }]);
    expect(advance.calls).toHaveLength(1);
  });
});

describe('RunConductorPassUseCase halt', () => {
  it('when halted, every advance request carries halted true', async () => {
    const fx = stores();
    await fx.halt.set({ halted: true, nowIso: NOW });
    await createRun(fx.repo);
    const advance = new ScriptedAdvance(new Map([[RUN_ID, [{ outcome: 'waiting', reason: 'admission' }]]]));
    const result = await runPass(fx, HOLDER, NOW, advance);
    expect(result).toMatchObject({ outcome: 'completed', halted: true });
    expect(advance.calls.length).toBeGreaterThan(0);
    expect(advance.calls.every((call) => call.request.halted === true)).toBe(true);
  });

  it('an unreadable halt marker reads as halted', async () => {
    const fx = stores();
    await createRun(fx.repo);
    const advance = new ScriptedAdvance(new Map([[RUN_ID, [{ outcome: 'waiting', reason: 'admission' }]]]));
    const useCase = new RunConductorPassUseCase({
      driverLease: fx.driverLease,
      runRepo: fx.repo,
      runJournal: fx.journal,
      halt: { read: async () => ({ state: 'unreadable' }) },
      resume: { applyPendingResume: async () => ({ outcome: 'none' }) },
      advance,
      now: () => NOW,
    });
    const result = await useCase.runPass({ holderId: HOLDER, nowIso: NOW });
    expect(result).toMatchObject({ outcome: 'completed', halted: true });
    expect(advance.calls.every((call) => call.request.halted === true)).toBe(true);
  });
});

describe('RunConductorPassUseCase state and resume', () => {
  it('a merged run is never leased or advanced', async () => {
    const fx = stores();
    await createRun(fx.repo);
    await fx.journal.append(laneRunConductEntry(ENTRY_1, RUN_ID, 'merged', NOW));
    const advance = new ScriptedAdvance(new Map());
    const result = await runPass(fx, HOLDER, NOW, advance);
    expect(result).toMatchObject({ outcome: 'completed', halted: false, progressed: false });
    if (result.outcome !== 'completed') {
      throw new Error('expected completed');
    }
    expect(result.runs).toEqual([]);
    expect(advance.calls).toEqual([]);
    expect((await fx.repo.get(RUN_ID))?.lease).toBeNull();
  });

  it('applies a recorded resume before the first advance', async () => {
    const fx = stores();
    await createRun(fx.repo);
    await fx.repo.acquireLease(RUN_ID, {
      holderId: HOLDER,
      observedFence: 0,
      leaseUntilIso: LEASE_UNTIL,
      nowIso: NOW,
    });
    const parked: LaneRunParkRecord = { reason: 'halted', qualifier: null, parkedFrom: 'gating', questionId: null };
    await fx.repo.save(
      runRecord({ parked, parkCount: 1, revision: 2, lease: { holderId: HOLDER, fence: 1, leaseUntilIso: LEASE_UNTIL } }),
      { holderId: HOLDER, fence: 1, nowIso: NOW },
    );
    await fx.journal.append(laneRunConductEntry(ENTRY_1, RUN_ID, 'parked', NOW));
    const resume = new ResumeLaneRunUseCase({
      runRepo: fx.repo,
      runJournal: fx.journal,
      newUlid: freshUlidFactory(),
    });
    expect(
      await resume.requestResume({ runId: RUN_ID, via: 'cli', entryId: ENTRY_2, nowIso: NOW }),
    ).toMatchObject({ outcome: 'resume-recorded' });

    const advance = new ScriptedAdvance(
      new Map([[RUN_ID, [{ outcome: 'waiting', reason: 'admission' }]]]),
      async () => (await fx.repo.get(RUN_ID))?.parked ?? null,
    );
    const result = await runPass(fx, HOLDER, NOW, advance, resume);
    expect(result).toMatchObject({ outcome: 'completed' });
    expect(advance.calls).toHaveLength(1);
    expect(advance.calls[0].parked).toBeNull();
    expect((await fx.repo.get(RUN_ID))?.parked).toBeNull();
  });
});

describe('RunConductorPassUseCase grace', () => {
  it('a drain past its grace reports one attention item per pass, naming the run', async () => {
    const fx = stores();
    await createRun(fx.repo);
    const grace: AdvanceLaneRunResult = { outcome: 'waiting', reason: 'stop-grace-exceeded' };
    const advance = new ScriptedAdvance(new Map([[RUN_ID, [grace, grace]]]));
    const first = await runPass(fx, HOLDER, NOW, advance);
    expect(first).toMatchObject({ outcome: 'completed' });
    if (first.outcome !== 'completed') {
      throw new Error('expected completed');
    }
    expect(first.attention).toEqual([{ runId: RUN_ID, kind: 'stop-grace-exceeded' }]);
    const second = await runPass(fx, HOLDER, SOON, advance);
    expect(second).toMatchObject({ outcome: 'completed' });
    if (second.outcome !== 'completed') {
      throw new Error('expected completed');
    }
    expect(second.attention).toEqual([{ runId: RUN_ID, kind: 'stop-grace-exceeded' }]);
  });
});

describe('RunConductorPassUseCase releaseLeases', () => {
  it('releases the driver lease and the run leases the holder holds; another holder then acquires both', async () => {
    const fx = stores();
    await createRun(fx.repo, { runId: RUN_ID });
    await createRun(fx.repo, { runId: RUN_ID_2 });
    await fx.repo.acquireLease(RUN_ID_2, {
      holderId: HOLDER_2,
      observedFence: 0,
      leaseUntilIso: LEASE_UNTIL,
      nowIso: NOW,
    });
    const advance = new ScriptedAdvance(new Map([[RUN_ID, [{ outcome: 'waiting', reason: 'admission' }]]]));
    await runPass(fx, HOLDER, NOW, advance);

    const released = await useCase(fx, advance).releaseLeases({ holderId: HOLDER, nowIso: SOON });
    expect(released).toEqual({ released: 2 });
    expect(await fx.driverLease.read()).toMatchObject({ holderId: HOLDER, fence: 1 });
    expect((await fx.driverLease.read())?.leaseUntilIso).toBe(SOON);
    expect((await fx.repo.get(RUN_ID))?.lease).toMatchObject({ holderId: HOLDER, fence: 1 });
    expect((await fx.repo.get(RUN_ID))?.lease?.leaseUntilIso).toBe(SOON);
    expect((await fx.repo.get(RUN_ID_2))?.lease).toMatchObject({ holderId: HOLDER_2, fence: 1 });
    expect((await fx.repo.get(RUN_ID_2))?.lease?.leaseUntilIso).toBe(LEASE_UNTIL);

    const again = await runPass(fx, HOLDER_3, SOON, advance);
    expect(again).toMatchObject({ outcome: 'completed' });
    expect(await fx.driverLease.read()).toMatchObject({ holderId: HOLDER_3, fence: 2 });
    expect((await fx.repo.get(RUN_ID))?.lease).toMatchObject({ holderId: HOLDER_3, fence: 2 });
  });
});

describe('RunConductorPassUseCase per-step lease renewal', () => {
  it('a second holder taking the driver lease between steps ends the pass before its next step', async () => {
    const fx = stores();
    await createRun(fx.repo);
    let advanceCalls = 0;
    const advance: AdvanceLaneRunPort = {
      async advanceLaneRun(_request: AdvanceLaneRunRequest): Promise<AdvanceLaneRunResult> {
        advanceCalls += 1;
        if (advanceCalls === 1) {
          // After the first step the driver lease lapses; a second driver takes over.
          await fx.driverLease.acquire({
            holderId: HOLDER_2,
            observedFence: 1,
            leaseUntilIso: '2026-10-27T10:11:00.000Z',
            nowIso: LATER,
          });
        }
        return { outcome: 'entered', state: 'dispatching' };
      },
    };
    // The clock reads NOW at the pass start and the first step, then LATER
    // (after the takeover) before the second step.
    const times = [NOW, NOW, LATER];
    let index = 0;
    const clock = () => times[Math.min(index++, times.length - 1)];
    const pass = new RunConductorPassUseCase({
      driverLease: fx.driverLease,
      runRepo: fx.repo,
      runJournal: fx.journal,
      halt: fx.halt,
      resume: { applyPendingResume: async () => ({ outcome: 'none' }) },
      advance,
      now: clock,
    });
    const result = await pass.runPass({ holderId: HOLDER, nowIso: NOW });
    expect(result).toEqual({ outcome: 'refused', reason: 'driver-lease-held' });
    expect(advanceCalls).toBe(1);
    expect(await fx.driverLease.read()).toMatchObject({ holderId: HOLDER_2, fence: 2 });
  });

  it('a normal multi-step run renews the driver and run leases before each step', async () => {
    const fx = stores();
    await createRun(fx.repo);
    const results: AdvanceLaneRunResult[] = [
      { outcome: 'entered', state: 'dispatching' },
      { outcome: 'entered', state: 'dispatching' },
      { outcome: 'waiting', reason: 'admission' },
    ];
    const advance = new ScriptedAdvance(new Map([[RUN_ID, results]]));

    let driverRenews = 0;
    let runRenews = 0;
    const driverLease = fx.driverLease;
    const wrappedDriver: ConductorDriverLeasePort = {
      read: () => driverLease.read(),
      acquire: (request) => driverLease.acquire(request),
      renew: (request) => {
        driverRenews += 1;
        return driverLease.renew(request);
      },
      release: (request) => driverLease.release(request),
      check: (request) => driverLease.check(request),
    };
    const repo = fx.repo;
    const wrappedRepo = {
      list: () => repo.list(),
      acquireLease: (runId: string, request: Parameters<typeof repo.acquireLease>[1]) => repo.acquireLease(runId, request),
      renewLease: (runId: string, request: Parameters<typeof repo.renewLease>[1]) => {
        runRenews += 1;
        return repo.renewLease(runId, request);
      },
      releaseLease: (runId: string, request: Parameters<typeof repo.releaseLease>[1]) => repo.releaseLease(runId, request),
    };

    const pass = new RunConductorPassUseCase({
      driverLease: wrappedDriver,
      runRepo: wrappedRepo,
      runJournal: fx.journal,
      halt: fx.halt,
      resume: { applyPendingResume: async () => ({ outcome: 'none' }) },
      advance,
      now: () => NOW,
    });
    const result = await pass.runPass({ holderId: HOLDER, nowIso: NOW });
    expect(result).toMatchObject({ outcome: 'completed', progressed: true });
    expect(advance.calls).toHaveLength(3);
    expect(driverRenews).toBe(3);
    expect(runRenews).toBe(3);
  });
});

describe('RunConductorPassUseCase run lease lost mid-pass', () => {
  function refusingRepo(fx: Stores, refuseFromCall: number) {
    const repo = fx.repo;
    let renews = 0;
    return {
      list: () => repo.list(),
      acquireLease: (runId: string, request: Parameters<typeof repo.acquireLease>[1]) => repo.acquireLease(runId, request),
      renewLease: async (runId: string, request: Parameters<typeof repo.renewLease>[1]) => {
        renews += 1;
        if (renews >= refuseFromCall) {
          return { outcome: 'refused', reason: 'lease-not-held' } as never;
        }
        return repo.renewLease(runId, request);
      },
      releaseLease: (runId: string, request: Parameters<typeof repo.releaseLease>[1]) => repo.releaseLease(runId, request),
    };
  }

  it('a run lease refused before the second step stops that run; the pass completes and reports the step that ran', async () => {
    const fx = stores();
    await createRun(fx.repo);
    const advance = new ScriptedAdvance(
      new Map([[RUN_ID, [{ outcome: 'entered', state: 'dispatching' }, { outcome: 'entered', state: 'running' }] as AdvanceLaneRunResult[]]]),
    );
    const pass = new RunConductorPassUseCase({
      driverLease: fx.driverLease,
      runRepo: refusingRepo(fx, 2),
      runJournal: fx.journal,
      halt: fx.halt,
      resume: { applyPendingResume: async () => ({ outcome: 'none' }) },
      advance,
      now: () => NOW,
    });
    const result = await pass.runPass({ holderId: HOLDER, nowIso: NOW });
    expect(result).toMatchObject({ outcome: 'completed' });
    expect(advance.calls).toHaveLength(1);
    if (result.outcome !== 'completed') return;
    expect(result.runs).toEqual([{ runId: RUN_ID, outcome: 'advanced', steps: [{ outcome: 'entered', state: 'dispatching' }] }]);
  });

  it('a run lease refused before the first step skips the run lease-refused and never advances it', async () => {
    const fx = stores();
    await createRun(fx.repo);
    const advance = new ScriptedAdvance(new Map());
    const pass = new RunConductorPassUseCase({
      driverLease: fx.driverLease,
      runRepo: refusingRepo(fx, 1),
      runJournal: fx.journal,
      halt: fx.halt,
      resume: { applyPendingResume: async () => ({ outcome: 'none' }) },
      advance,
      now: () => NOW,
    });
    const result = await pass.runPass({ holderId: HOLDER, nowIso: NOW });
    expect(result).toMatchObject({ outcome: 'completed' });
    expect(advance.calls).toHaveLength(0);
    if (result.outcome !== 'completed') return;
    expect(result.runs).toEqual([{ runId: RUN_ID, outcome: 'skipped', reason: 'lease-refused' }]);
  });
});

describe('RunConductorPassUseCase dispatch stagger', () => {
  const dispatchStarted = (runId: string): AdvanceLaneRunResult => ({
    outcome: 'acted',
    step: 'dispatch',
    key: `${runId}/r0/dispatch/0/a1`,
    result: 'completed',
    reasonCode: 'dispatch-started',
  });

  function fakeSleep() {
    const calls: number[] = [];
    return {
      calls,
      sleep: async (ms: number): Promise<void> => {
        calls.push(ms);
      },
    };
  }

  function staggerUseCase(
    fx: Stores,
    advance: ScriptedAdvance,
    sleep: (ms: number) => Promise<void>,
    dispatchStaggerMs?: number,
  ): RunConductorPassUseCase {
    return new RunConductorPassUseCase({
      driverLease: fx.driverLease,
      runRepo: fx.repo,
      runJournal: fx.journal,
      halt: fx.halt,
      resume: { applyPendingResume: async () => ({ outcome: 'none' }) },
      advance,
      now: () => NOW,
      sleep,
      ...(dispatchStaggerMs === undefined ? {} : { dispatchStaggerMs }),
    });
  }

  it('two runs that both start sessions pause exactly once for 20 000 ms between them, none after the second', async () => {
    const fx = stores();
    await createRun(fx.repo);
    await createRun(fx.repo, { runId: RUN_ID_2 });
    const advance = new ScriptedAdvance(
      new Map([
        [RUN_ID, [dispatchStarted(RUN_ID), { outcome: 'waiting', reason: 'admission' }]],
        [RUN_ID_2, [dispatchStarted(RUN_ID_2), { outcome: 'waiting', reason: 'admission' }]],
      ]),
    );
    const fake = fakeSleep();
    const result = await staggerUseCase(fx, advance, fake.sleep).runPass({ holderId: HOLDER, nowIso: NOW });
    expect(result).toMatchObject({ outcome: 'completed' });
    expect(fake.calls).toEqual([20_000]);
    expect(advance.calls.map((call) => call.request.runId)).toEqual([RUN_ID, RUN_ID, RUN_ID_2, RUN_ID_2]);
  });

  it('a run that starts a session followed by a run that only waits pauses once', async () => {
    const fx = stores();
    await createRun(fx.repo);
    await createRun(fx.repo, { runId: RUN_ID_2 });
    const advance = new ScriptedAdvance(
      new Map([
        [RUN_ID, [dispatchStarted(RUN_ID), { outcome: 'waiting', reason: 'admission' }]],
        [RUN_ID_2, [{ outcome: 'waiting', reason: 'admission' }]],
      ]),
    );
    const fake = fakeSleep();
    const result = await staggerUseCase(fx, advance, fake.sleep).runPass({ holderId: HOLDER, nowIso: NOW });
    expect(result).toMatchObject({ outcome: 'completed' });
    expect(fake.calls).toEqual([20_000]);
  });

  it('a single run that starts a session never pauses', async () => {
    const fx = stores();
    await createRun(fx.repo);
    const advance = new ScriptedAdvance(
      new Map([[RUN_ID, [dispatchStarted(RUN_ID), { outcome: 'waiting', reason: 'admission' }]]]),
    );
    const fake = fakeSleep();
    const result = await staggerUseCase(fx, advance, fake.sleep).runPass({ holderId: HOLDER, nowIso: NOW });
    expect(result).toMatchObject({ outcome: 'completed' });
    expect(fake.calls).toEqual([]);
  });

  it('runs that collect or gate never pause, even when more runs remain', async () => {
    const fx = stores();
    await createRun(fx.repo);
    await createRun(fx.repo, { runId: RUN_ID_2 });
    const advance = new ScriptedAdvance(
      new Map([
        [
          RUN_ID,
          [
            { outcome: 'acted', step: 'collect', key: `${RUN_ID}/r0/collect`, result: 'completed', reasonCode: null },
            { outcome: 'waiting', reason: 'admission' },
          ],
        ],
        [
          RUN_ID_2,
          [
            { outcome: 'acted', step: 'gate', key: `${RUN_ID_2}/r0/gate@0123456789ab`, result: 'completed', reasonCode: null },
            { outcome: 'waiting', reason: 'admission' },
          ],
        ],
      ]),
    );
    const fake = fakeSleep();
    const result = await staggerUseCase(fx, advance, fake.sleep).runPass({ holderId: HOLDER, nowIso: NOW });
    expect(result).toMatchObject({ outcome: 'completed' });
    expect(fake.calls).toEqual([]);
  });

  it('a reconciled dispatch-started step (crash recovery) starts no session and never pauses', async () => {
    const fx = stores();
    await createRun(fx.repo);
    await createRun(fx.repo, { runId: RUN_ID_2 });
    const advance = new ScriptedAdvance(
      new Map([
        [RUN_ID, [{ ...dispatchStarted(RUN_ID), result: 'reconciled' }, { outcome: 'waiting', reason: 'admission' }]],
        [RUN_ID_2, [{ outcome: 'waiting', reason: 'admission' }]],
      ]),
    );
    const fake = fakeSleep();
    const result = await staggerUseCase(fx, advance, fake.sleep).runPass({ holderId: HOLDER, nowIso: NOW });
    expect(result).toMatchObject({ outcome: 'completed' });
    expect(fake.calls).toEqual([]);
  });

  it('a custom dispatchStaggerMs is honoured', async () => {
    const fx = stores();
    await createRun(fx.repo);
    await createRun(fx.repo, { runId: RUN_ID_2 });
    const advance = new ScriptedAdvance(
      new Map([
        [RUN_ID, [dispatchStarted(RUN_ID), { outcome: 'waiting', reason: 'admission' }]],
        [RUN_ID_2, [dispatchStarted(RUN_ID_2), { outcome: 'waiting', reason: 'admission' }]],
      ]),
    );
    const fake = fakeSleep();
    const result = await staggerUseCase(fx, advance, fake.sleep, 500).runPass({ holderId: HOLDER, nowIso: NOW });
    expect(result).toMatchObject({ outcome: 'completed' });
    expect(fake.calls).toEqual([500]);
  });
});
