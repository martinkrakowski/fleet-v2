// RunConductorPassUseCase tests — K7-6.
/**
 * One pass of the driver: takes or renews the driver lease, reads the halt
 * marker, and for each non-terminal run takes or renews its run lease, applies
 * a recorded resume, then advances it until it waits, parks, ends or a step is
 * not built, at most eight steps. Leases are released separately on shutdown.
 */

import { describe, expect, it } from 'vitest';

import { LaneRun } from '../../../domain/entities/LaneRun.js';
import { laneRunConductEntry, laneRunIntentEntry, laneRunResultEntry } from '../../../domain/lane-run-step-facts.js';
import { buildLaneRunStepKey } from '../../../domain/lane-run-keys.js';
import type { LaneRunParkRecord, LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { LeaseRenewRequest } from '../../../domain/lane-run-lease.js';
import { ConductorDriverLeaseAdapter } from '../../../infrastructure/adapters/ConductorDriverLeaseAdapter.adapter.js';
import { ConductorHaltAdapter } from '../../../infrastructure/adapters/ConductorHaltAdapter.adapter.js';
import type { ConductorHaltState } from '../../../domain/conductor-halt.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import type { ConductorDriverLeasePort } from '../../ports/out/ConductorDriverLeasePort.out-port.js';
import type { AdvanceLaneRunPort, AdvanceLaneRunRequest, AdvanceLaneRunResult } from '../../ports/in/AdvanceLaneRunPort.in-port.js';
import type { RunConductorPassResult } from '../../ports/in/RunConductorPassPort.in-port.js';
import { ResumeLaneRunUseCase } from '../ResumeLaneRunUseCase.use-case.js';
import { RequestLaneRunStopUseCase } from '../RequestLaneRunStopUseCase.use-case.js';
import { RunConductorPassUseCase } from '../RunConductorPassUseCase.use-case.js';
import { ConductorDriverLeaseKeeper } from '../conductor-driver-lease-keeper.js';
import type { RunConductorPassDependencies } from '../RunConductorPassUseCase.use-case.js';
import { AdvanceLaneRunUseCase } from '../AdvanceLaneRunUseCase.use-case.js';
import type { AdvanceLaneRunDependencies } from '../AdvanceLaneRunUseCase.use-case.js';
import type { AttemptRecord, AttemptRunnerRecord } from '../../../domain/execution-records.js';
import type { DispatchAttemptRequest } from '../../ports/in/DispatchAttemptPort.in-port.js';
import { AttemptRepositoryAdapter } from '../../../infrastructure/adapters/AttemptRepositoryAdapter.adapter.js';
import { ExecutionJournalAdapter } from '../../../infrastructure/adapters/ExecutionJournalAdapter.adapter.js';

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

describe('RunConductorPassUseCase stops from inside a run (KF-34a2)', () => {
  it('a mid-run invalid clock ends the pass with the same refusal', async () => {
    const fx = stores();
    await createRun(fx.repo);
    const advance = new ScriptedAdvance(
      new Map([
        [RUN_ID, [{ outcome: 'entered', state: 'dispatching' }, { outcome: 'entered', state: 'running' }] as AdvanceLaneRunResult[]],
      ]),
    );
    // Reads: the pass start, step 1, then an invalid clock before step 2.
    const times = [NOW, NOW, 'not-an-iso-time'];
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
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(advance.calls).toHaveLength(1);
  });

  it('a mid-run driver loss still returns the same refusal, with the earlier runs\' reports unchanged', async () => {
    const fx = stores();
    await createRun(fx.repo);
    await createRun(fx.repo, { runId: RUN_ID_2 });
    const runIds: string[] = [];
    let nowValue = NOW;
    const advance: AdvanceLaneRunPort = {
      async advanceLaneRun(request: AdvanceLaneRunRequest): Promise<AdvanceLaneRunResult> {
        runIds.push(request.runId);
        if (request.runId === RUN_ID_2) {
          // After run A's full turn, on B's first step the driver lease lapses
          // and a second driver takes over before B's next step.
          nowValue = LATER;
          await fx.driverLease.acquire({
            holderId: HOLDER_2,
            observedFence: 1,
            leaseUntilIso: '2026-10-27T10:11:00.000Z',
            nowIso: LATER,
          });
          return { outcome: 'entered', state: 'dispatching' };
        }
        return runIds.filter((runId) => runId === RUN_ID).length === 1
          ? { outcome: 'entered', state: 'dispatching' }
          : { outcome: 'waiting', reason: 'admission' };
      },
    };
    const pass = new RunConductorPassUseCase({
      driverLease: fx.driverLease,
      runRepo: fx.repo,
      runJournal: fx.journal,
      halt: fx.halt,
      resume: { applyPendingResume: async () => ({ outcome: 'none' }) },
      advance,
      now: () => nowValue,
    });
    const result = await pass.runPass({ holderId: HOLDER, nowIso: NOW });
    expect(result).toEqual({ outcome: 'refused', reason: 'driver-lease-held' });
    // Run A's full turn (entered, then waiting admission) ran before B started.
    expect(runIds).toEqual([RUN_ID, RUN_ID, RUN_ID_2]);
    expect(await fx.driverLease.read()).toMatchObject({ holderId: HOLDER_2, fence: 2 });
  });
});

describe('RunConductorPassUseCase session-start gate (KF-34a1)', () => {
  const dispatchStarted = (runId: string): AdvanceLaneRunResult => ({
    outcome: 'acted',
    step: 'dispatch',
    key: `${runId}/r0/dispatch/0/a1`,
    result: 'completed',
    reasonCode: 'dispatch-started',
  });

  const reviewStarted = (runId: string): AdvanceLaneRunResult => ({
    outcome: 'acted',
    step: 'brief-check',
    key: `${runId}/r0/brief-check/0@0123456789ab`,
    result: 'completed',
    reasonCode: 'review-passed',
  });

  /**
   * A scripted advance whose session-start results consult the request's
   * start gate: a denied start is answered `waiting session-stagger` without
   * consuming the queue, exactly like the real advance before its one-way
   * intent. Results that are not session starts (a waiting tail, a reconciled
   * dispatch) are never gated.
   */
  class GatedScriptedAdvance implements AdvanceLaneRunPort {
    readonly calls: { request: AdvanceLaneRunRequest; result: AdvanceLaneRunResult }[] = [];
    private readonly used = new Map<string, number>();
    private gateAsks = 0;

    constructor(
      private readonly queue: ReadonlyMap<string, readonly AdvanceLaneRunResult[]>,
      private readonly parkedAt: () => Promise<LaneRunParkRecord | null> = async () => null,
    ) {}

    get gateAskCount(): number {
      return this.gateAsks;
    }

    private static isSessionStart(result: AdvanceLaneRunResult): boolean {
      return (
        result.outcome === 'acted' &&
        result.result === 'completed' &&
        (result.step === 'dispatch' || result.step === 'brief-check' || result.step === 'code-review')
      );
    }

    async advanceLaneRun(request: AdvanceLaneRunRequest): Promise<AdvanceLaneRunResult> {
      const index = this.used.get(request.runId) ?? 0;
      const results = this.queue.get(request.runId);
      const next: AdvanceLaneRunResult =
        results !== undefined && index < results.length
          ? results[index]
          : { outcome: 'waiting', reason: 'admission' };
      if (GatedScriptedAdvance.isSessionStart(next) && request.startGate !== undefined) {
        this.gateAsks += 1;
        if (!request.startGate.tryStart(request.runId, request.nowIso).ok) {
          this.calls.push({ request, result: { outcome: 'waiting', reason: 'session-stagger' } });
          return { outcome: 'waiting', reason: 'session-stagger' };
        }
      }
      this.calls.push({ request, result: next });
      this.used.set(request.runId, index + 1);
      return next;
    }
  }

  /**
   * A deterministic clock: `sleep` advances it by the awaited amount and
   * records the ms, so no real timer ever runs and the waits are exact.
   */
  function steppingClock(startIso: string) {
    const sleeps: number[] = [];
    let current = Date.parse(startIso);
    return {
      sleeps,
      now: () => new Date(current).toISOString(),
      sleep: async (ms: number): Promise<void> => {
        sleeps.push(ms);
        current += ms;
      },
    };
  }

  function gateUseCase(
    fx: Stores,
    advance: AdvanceLaneRunPort,
    clock: { now: () => string; sleep: (ms: number) => Promise<void> },
    dispatchStaggerMs?: number,
  ): RunConductorPassUseCase {
    return new RunConductorPassUseCase({
      driverLease: fx.driverLease,
      runRepo: fx.repo,
      runJournal: fx.journal,
      halt: fx.halt,
      resume: { applyPendingResume: async () => ({ outcome: 'none' }) },
      advance,
      now: clock.now,
      sleep: clock.sleep,
      ...(dispatchStaggerMs === undefined ? {} : { dispatchStaggerMs }),
    });
  }

  it('two runs that both start a session at concurrency 1: A:start, B:waiting, sleep(20000), B:start', async () => {
    const fx = stores();
    await createRun(fx.repo);
    await createRun(fx.repo, { runId: RUN_ID_2 });
    const advance = new GatedScriptedAdvance(
      new Map([
        [RUN_ID, [dispatchStarted(RUN_ID), { outcome: 'waiting', reason: 'admission' }]],
        [RUN_ID_2, [dispatchStarted(RUN_ID_2), { outcome: 'waiting', reason: 'admission' }]],
      ]),
    );
    const clock = steppingClock(NOW);
    const result = await gateUseCase(fx, advance, clock).runPass({ holderId: HOLDER, nowIso: NOW });
    expect(result).toMatchObject({ outcome: 'completed' });
    expect(clock.sleeps).toEqual([20_001]);
    expect(advance.calls.map((call) => call.request.runId)).toEqual([RUN_ID, RUN_ID, RUN_ID_2, RUN_ID_2, RUN_ID_2]);
    expect(advance.calls.slice(2).map((call) => call.result)).toEqual([
      { outcome: 'waiting', reason: 'session-stagger' },
      dispatchStarted(RUN_ID_2),
      { outcome: 'waiting', reason: 'admission' },
    ]);
  });

  it('a run whose next step is a review after another run\'s dispatch also waits', async () => {
    const fx = stores();
    await createRun(fx.repo);
    await createRun(fx.repo, { runId: RUN_ID_2 });
    const advance = new GatedScriptedAdvance(
      new Map([
        [RUN_ID, [dispatchStarted(RUN_ID), { outcome: 'waiting', reason: 'admission' }]],
        [RUN_ID_2, [reviewStarted(RUN_ID_2), { outcome: 'waiting', reason: 'admission' }]],
      ]),
    );
    const clock = steppingClock(NOW);
    const result = await gateUseCase(fx, advance, clock).runPass({ holderId: HOLDER, nowIso: NOW });
    expect(result).toMatchObject({ outcome: 'completed' });
    expect(clock.sleeps).toEqual([20_001]);
    expect(advance.calls.slice(2).map((call) => call.result)).toEqual([
      { outcome: 'waiting', reason: 'session-stagger' },
      reviewStarted(RUN_ID_2),
      { outcome: 'waiting', reason: 'admission' },
    ]);
  });

  it('a single starting run never sleeps', async () => {
    const fx = stores();
    await createRun(fx.repo);
    const advance = new GatedScriptedAdvance(
      new Map([[RUN_ID, [dispatchStarted(RUN_ID), { outcome: 'waiting', reason: 'admission' }]]]),
    );
    const clock = steppingClock(NOW);
    const result = await gateUseCase(fx, advance, clock).runPass({ holderId: HOLDER, nowIso: NOW });
    expect(result).toMatchObject({ outcome: 'completed' });
    expect(clock.sleeps).toEqual([]);
    expect(advance.calls.map((call) => call.request.runId)).toEqual([RUN_ID, RUN_ID]);
  });

  it('a run whose dispatch is the last in the pass causes no trailing sleep (the KF-31 sleep is gone)', async () => {
    const fx = stores();
    await createRun(fx.repo);
    await createRun(fx.repo, { runId: RUN_ID_2 });
    const advance = new GatedScriptedAdvance(
      new Map([
        [RUN_ID, [dispatchStarted(RUN_ID), { outcome: 'waiting', reason: 'admission' }]],
        [RUN_ID_2, [{ outcome: 'waiting', reason: 'admission' }]],
      ]),
    );
    const clock = steppingClock(NOW);
    const result = await gateUseCase(fx, advance, clock).runPass({ holderId: HOLDER, nowIso: NOW });
    expect(result).toMatchObject({ outcome: 'completed' });
    expect(clock.sleeps).toEqual([]);
    expect(advance.calls.map((call) => call.request.runId)).toEqual([RUN_ID, RUN_ID, RUN_ID_2]);
  });

  it('the journal seed makes the first start wait the remainder', async () => {
    const fx = stores();
    await createRun(fx.repo);
    await createRun(fx.repo, { runId: RUN_ID_2 });
    // A dispatch intent recorded 5 s ago by the previous pass or process
    // seeds the gate: the next start is due 20 s after it, so 15 s remain.
    const seededKeyBuilt = buildLaneRunStepKey({
      runId: RUN_ID_2,
      round: 0,
      step: 'dispatch',
      seatIndex: 0,
      attemptOrdinal: 1,
      head12: null,
      retry: null,
    });
    expect(seededKeyBuilt.ok).toBe(true);
    if (!seededKeyBuilt.ok) throw new Error('fixture must build a step key');
    const seeded = laneRunIntentEntry(
      '01JB0000000000000000000009',
      RUN_ID_2,
      seededKeyBuilt.key,
      'seeded-attempt-1',
      new Date(Date.parse(NOW) - 5_000).toISOString(),
    );
    expect(await fx.journal.append(seeded)).toMatchObject({ outcome: 'appended' });
    const advance = new GatedScriptedAdvance(
      new Map([
        [RUN_ID, [dispatchStarted(RUN_ID), { outcome: 'waiting', reason: 'admission' }]],
        [RUN_ID_2, [{ outcome: 'waiting', reason: 'admission' }]],
      ]),
    );
    const clock = steppingClock(NOW);
    const result = await gateUseCase(fx, advance, clock).runPass({ holderId: HOLDER, nowIso: NOW });
    expect(result).toMatchObject({ outcome: 'completed' });
    expect(clock.sleeps).toEqual([15_001]);
    expect(advance.calls.map((call) => call.request.runId)).toEqual([RUN_ID, RUN_ID, RUN_ID, RUN_ID_2]);
    expect(advance.calls[0]!.result).toEqual({ outcome: 'waiting', reason: 'session-stagger' });
    expect(advance.calls[1]!.result).toEqual(dispatchStarted(RUN_ID));
    expect(advance.calls[2]!.result).toEqual({ outcome: 'waiting', reason: 'admission' });
  });

  it('a reconciled dispatch-started result (crash recovery) does not consult the gate', async () => {
    const fx = stores();
    await createRun(fx.repo);
    await createRun(fx.repo, { runId: RUN_ID_2 });
    const advance = new GatedScriptedAdvance(
      new Map([
        [RUN_ID, [{ ...dispatchStarted(RUN_ID), result: 'reconciled' }, { outcome: 'waiting', reason: 'admission' }]],
        [RUN_ID_2, [{ outcome: 'waiting', reason: 'admission' }]],
      ]),
    );
    const clock = steppingClock(NOW);
    const result = await gateUseCase(fx, advance, clock).runPass({ holderId: HOLDER, nowIso: NOW });
    expect(result).toMatchObject({ outcome: 'completed' });
    expect(clock.sleeps).toEqual([]);
    expect(advance.gateAskCount).toBe(0);
    expect(advance.calls.map((call) => call.request.runId)).toEqual([RUN_ID, RUN_ID, RUN_ID_2]);
  });

  it('after the wait the next run decides its lease on fresh time: a lease that expired during the pause is taken', async () => {
    const fx = stores();
    await createRun(fx.repo);
    await createRun(fx.repo, { runId: RUN_ID_2 });
    await fx.repo.acquireLease(RUN_ID_2, {
      holderId: HOLDER_2,
      observedFence: 0,
      leaseUntilIso: new Date(Date.parse(NOW) + 10_000).toISOString(),
      nowIso: NOW,
    });
    // A dispatch intent the previous pass recorded 5 s ago (with its final
    // result, so the run stays live without a pending action) seeds the gate:
    // the pass's first start waits 15 s, so the pause really happens.
    const seededKeyBuilt = buildLaneRunStepKey({
      runId: RUN_ID,
      round: 0,
      step: 'dispatch',
      seatIndex: 0,
      attemptOrdinal: 1,
      head12: null,
      retry: null,
    });
    expect(seededKeyBuilt.ok).toBe(true);
    if (!seededKeyBuilt.ok) throw new Error('fixture must build a step key');
    const seedIso = new Date(Date.parse(NOW) - 5_000).toISOString();
    expect(
      await fx.journal.append(
        laneRunIntentEntry('01JB0000000000000000000009', RUN_ID, seededKeyBuilt.key, 'a1', seedIso),
      ),
    ).toMatchObject({ outcome: 'appended' });
    expect(
      await fx.journal.append(
        laneRunResultEntry('01JB0000000000000000000010', RUN_ID, seededKeyBuilt.key, 'refused', null, seedIso),
      ),
    ).toMatchObject({ outcome: 'appended' });
    const advance = new GatedScriptedAdvance(
      new Map([
        [RUN_ID, [dispatchStarted(RUN_ID), { outcome: 'waiting', reason: 'admission' }]],
        [RUN_ID_2, [{ outcome: 'waiting', reason: 'admission' }]],
      ]),
    );
    const clock = steppingClock(NOW);
    const result = await gateUseCase(fx, advance, clock).runPass({ holderId: HOLDER, nowIso: NOW });
    expect(result).toMatchObject({ outcome: 'completed' });
    if (result.outcome !== 'completed') return;
    expect(result.runs.map((run) => run.outcome)).toEqual(['advanced', 'advanced']);
    expect(clock.sleeps).toEqual([15_001]);
    expect(advance.calls.map((call) => call.request.runId)).toEqual([RUN_ID, RUN_ID, RUN_ID, RUN_ID_2]);
  });

  it('a custom dispatchStaggerMs is honoured', async () => {
    const fx = stores();
    await createRun(fx.repo);
    await createRun(fx.repo, { runId: RUN_ID_2 });
    const advance = new GatedScriptedAdvance(
      new Map([
        [RUN_ID, [dispatchStarted(RUN_ID), { outcome: 'waiting', reason: 'admission' }]],
        [RUN_ID_2, [dispatchStarted(RUN_ID_2), { outcome: 'waiting', reason: 'admission' }]],
      ]),
    );
    const clock = steppingClock(NOW);
    const result = await gateUseCase(fx, advance, clock, 500).runPass({ holderId: HOLDER, nowIso: NOW });
    expect(result).toMatchObject({ outcome: 'completed' });
    expect(clock.sleeps).toEqual([501]);
  });

  const codeReviewStarted = (runId: string): AdvanceLaneRunResult => ({
    outcome: 'acted',
    step: 'code-review',
    key: `${runId}/r0/code-review/0@0123456789ab`,
    result: 'completed',
    reasonCode: 'review-passed',
  });

  it('a run whose next step is a code review after another run\'s dispatch also waits', async () => {
    const fx = stores();
    await createRun(fx.repo);
    await createRun(fx.repo, { runId: RUN_ID_2 });
    const advance = new GatedScriptedAdvance(
      new Map([
        [RUN_ID, [dispatchStarted(RUN_ID), { outcome: 'waiting', reason: 'admission' }]],
        [RUN_ID_2, [codeReviewStarted(RUN_ID_2), { outcome: 'waiting', reason: 'admission' }]],
      ]),
    );
    const clock = steppingClock(NOW);
    const result = await gateUseCase(fx, advance, clock).runPass({ holderId: HOLDER, nowIso: NOW });
    expect(result).toMatchObject({ outcome: 'completed' });
    expect(clock.sleeps).toEqual([20_001]);
    expect(advance.calls.slice(2).map((call) => call.result)).toEqual([
      { outcome: 'waiting', reason: 'session-stagger' },
      codeReviewStarted(RUN_ID_2),
      { outcome: 'waiting', reason: 'admission' },
    ]);
  });

  it('a timer that fires a millisecond early does not spend an extra stagger step', async () => {
    const fx = stores();
    await createRun(fx.repo);
    await createRun(fx.repo, { runId: RUN_ID_2 });
    const advance = new GatedScriptedAdvance(
      new Map([
        [RUN_ID, [dispatchStarted(RUN_ID), { outcome: 'waiting', reason: 'admission' }]],
        [RUN_ID_2, [dispatchStarted(RUN_ID_2), { outcome: 'waiting', reason: 'admission' }]],
      ]),
    );
    // The fake sleep lands one millisecond short of the requested wait, mimicking
    // a real timer that fires a millisecond early; the +1 overshoot still crosses
    // the slot, so B grants on the immediate retry (no extra stagger step).
    let current = Date.parse(NOW);
    const sleeps: number[] = [];
    const earlyClock = {
      now: () => new Date(current).toISOString(),
      sleep: async (ms: number): Promise<void> => {
        sleeps.push(ms);
        current += ms - 1;
      },
    };
    const result = await gateUseCase(fx, advance, earlyClock).runPass({ holderId: HOLDER, nowIso: NOW });
    expect(result).toMatchObject({ outcome: 'completed' });
    expect(sleeps).toEqual([20_001]);
    expect(advance.calls.map((call) => call.request.runId)).toEqual([RUN_ID, RUN_ID, RUN_ID_2, RUN_ID_2, RUN_ID_2]);
  });

  it('a journal seed in the future is clamped to this pass\'s now, so the first wait is at most the stagger', async () => {
    const fx = stores();
    await createRun(fx.repo);
    await createRun(fx.repo, { runId: RUN_ID_2 });
    // A dispatch intent the previous pass recorded 10 minutes in the FUTURE
    // (clock stepped back, skewed process) seeds the gate; clamping to the
    // pass's now makes the first wait the full stagger, not 10 minutes + stagger.
    const seededKeyBuilt = buildLaneRunStepKey({
      runId: RUN_ID_2,
      round: 0,
      step: 'dispatch',
      seatIndex: 0,
      attemptOrdinal: 1,
      head12: null,
      retry: null,
    });
    expect(seededKeyBuilt.ok).toBe(true);
    if (!seededKeyBuilt.ok) throw new Error('fixture must build a step key');
    const futureIso = new Date(Date.parse(NOW) + 600_000).toISOString();
    const seeded = laneRunIntentEntry(
      '01JB0000000000000000000009',
      RUN_ID_2,
      seededKeyBuilt.key,
      'seeded-attempt-1',
      futureIso,
    );
    expect(await fx.journal.append(seeded)).toMatchObject({ outcome: 'appended' });
    const advance = new GatedScriptedAdvance(
      new Map([
        [RUN_ID, [dispatchStarted(RUN_ID), { outcome: 'waiting', reason: 'admission' }]],
        [RUN_ID_2, [{ outcome: 'waiting', reason: 'admission' }]],
      ]),
    );
    const clock = steppingClock(NOW);
    const result = await gateUseCase(fx, advance, clock).runPass({ holderId: HOLDER, nowIso: NOW });
    expect(result).toMatchObject({ outcome: 'completed' });
    expect(clock.sleeps).toEqual([20_001]);
    expect(advance.calls.map((call) => call.request.runId)).toEqual([RUN_ID, RUN_ID, RUN_ID, RUN_ID_2]);
  });

  it('an unparseable journalled lastStartIso seeds the gate with no seed, not the pass time', async () => {
    const fx = stores();
    await createRun(fx.repo);
    await createRun(fx.repo, { runId: RUN_ID_2 });
    const seededKeyBuilt = buildLaneRunStepKey({
      runId: RUN_ID_2,
      round: 0,
      step: 'dispatch',
      seatIndex: 0,
      attemptOrdinal: 1,
      head12: null,
      retry: null,
    });
    expect(seededKeyBuilt.ok).toBe(true);
    if (!seededKeyBuilt.ok) throw new Error('fixture must build a step key');
    const base = laneRunIntentEntry('01JB0000000000000000000009', RUN_ID_2, seededKeyBuilt.key, 'a1', NOW);
    const unparseable = { ...base, recordedAtIso: 'not-an-iso-time' };
    const advance = new GatedScriptedAdvance(
      new Map([
        [RUN_ID, [dispatchStarted(RUN_ID), { outcome: 'waiting', reason: 'admission' }]],
        [RUN_ID_2, [{ outcome: 'waiting', reason: 'admission' }]],
      ]),
    );
    const clock = steppingClock(NOW);
    const pass = new RunConductorPassUseCase({
      driverLease: fx.driverLease,
      runRepo: fx.repo,
      runJournal: {
        listForRun: async (runId: string) =>
          runId === RUN_ID_2 ? [unparseable] : await fx.journal.listForRun(runId),
      },
      halt: fx.halt,
      resume: { applyPendingResume: async () => ({ outcome: 'none' }) },
      advance,
      now: clock.now,
      sleep: clock.sleep,
    });
    const result = await pass.runPass({ holderId: HOLDER, nowIso: NOW });
    expect(result).toMatchObject({ outcome: 'completed' });
    // No seed at all: the first start is granted at once, never seeded with
    // the pass time (which would force a full stagger wait).
    expect(clock.sleeps).toEqual([]);
    expect(advance.calls.map((call) => call.request.runId)).toEqual([RUN_ID, RUN_ID, RUN_ID_2]);
  });
});

describe('RunConductorPassUseCase real advance (KF-34a2)', () => {
  const WORKTREE = '/tmp/opencode/wo-example-1/wt-example-1';
  const COMMIT = 'a'.repeat(40);
  const SHA = 'c'.repeat(64);
  const CONDUCTED_RUNNER: AttemptRunnerRecord = {
    kind: 'opencode',
    remotePort: 4166,
    host: 'lane-alias-example',
    hostName: 'lane-host-example',
    agent: null,
    model: null,
    variant: null,
  };
  const SEAT_PLAN = {
    version: 1 as const,
    'first-pass': [
      { id: 'fp-1', model: 'model-example-1', tool: 'opencode' },
      { id: 'fp-2', model: 'model-example-2', tool: 'opencode' },
    ],
    fix: [{ id: 'fx-1', model: 'model-example-1', tool: 'opencode' }],
    review: [],
  };
  const SEAT_SELECTION = {
    role: 'first-pass' as const,
    seatIndex: 0,
    seatId: 'fp-1',
    model: 'model-example-1',
    tool: 'opencode',
    variant: null,
    agent: null,
  };

  function attemptFixture(id: string): AttemptRecord {
    return {
      id,
      workOrderId: 'wo-example-1',
      kind: 'initial',
      fixNumber: 0,
      priorAttemptId: null,
      worktreePath: WORKTREE,
      baseCommit: COMMIT,
      state: 'intent-recorded',
      outcome: null,
      briefDigest: SHA,
      briefPackagePath: '.lane/brief-package',
      sessionId: null,
      completionReceipt: null,
      artifacts: null,
      runner: CONDUCTED_RUNNER,
      seatPlan: SEAT_PLAN,
      seatSelection: SEAT_SELECTION,
      stopReason: 'none',
      createdAtIso: NOW,
      updatedAtIso: NOW,
    };
  }

  interface RealHarness {
    readonly runRepo: LaneRunRepositoryAdapter;
    readonly runJournal: LaneRunJournalAdapter;
    readonly attemptRepo: AttemptRepositoryAdapter;
    readonly executionJournal: ExecutionJournalAdapter;
    readonly driverLease: ConductorDriverLeaseAdapter;
    readonly halt: ConductorHaltAdapter;
    readonly dispatchRequests: DispatchAttemptRequest[];
    readonly deps: AdvanceLaneRunDependencies;
  }

  async function realHarness(runs: { runId: string; attemptId: string }[]): Promise<RealHarness> {
    const runRepo = new LaneRunRepositoryAdapter();
    const runJournal = new LaneRunJournalAdapter();
    const attemptRepo = new AttemptRepositoryAdapter();
    const executionJournal = new ExecutionJournalAdapter();
    const driverLease = new ConductorDriverLeaseAdapter();
    const halt = new ConductorHaltAdapter();
    const dispatchRequests: DispatchAttemptRequest[] = [];
    const ulid = freshUlidFactory();
    for (const { runId, attemptId } of runs) {
      const record = runRecord({ runId, attemptIds: [attemptId] });
      expect((await runRepo.create(record)).outcome).toBe('saved');
      await attemptRepo.saveAttempt(attemptFixture(attemptId));
      await executionJournal.saveCapacityReservation({
        id: ulid(),
        attemptId,
        hostId: 'host-example-1',
        slotIndex: 0,
        held: true,
        seatTool: 'opencode',
        reservedAtIso: NOW,
        releasedAtIso: null,
      });
    }
    const deps: AdvanceLaneRunDependencies = {
      runRepo,
      runJournal,
      attemptRepo,
      executionJournal,
      artifactPort: {
        readBriefManifest: async () =>
          JSON.stringify({ stepLimit: 100, timeLimitSeconds: 2700, expectedArtifacts: [] }),
        verifyArtifactManifest: async () => ({ outcome: 'missing' }),
      },
      reconcileAttempt: {
        reconcileAttempt: async () => ({ outcome: 'refused', reason: 'not-found' }),
      },
      admission: { admit: async () => ({ outcome: 'admitted' }) },
      newUlid: ulid,
      dispatchAttempt: {
        dispatchAttempt: async (request) => {
          dispatchRequests.push(request);
          return { outcome: 'started', attempt: attemptFixture(request.attemptId), sessionId: 'session-example-1' };
        },
      },
      cancelPreparedAttempt: {
        cancelPreparedAttempt: async () => ({ outcome: 'cancelled', attempt: attemptFixture('attempt-cancelled'), capacity: 'released' }),
      },
    };
    return { runRepo, runJournal, attemptRepo, executionJournal, driverLease, halt, dispatchRequests, deps };
  }

  function steppingClockRealAdvance(startIso: string) {
    const sleeps: number[] = [];
    let current = Date.parse(startIso);
    return {
      sleeps,
      now: () => new Date(current).toISOString(),
      sleep: async (ms: number): Promise<void> => {
        sleeps.push(ms);
        current += ms;
      },
    };
  }

  it('two ready runs dispatch through the real advance: first grants, second is denied, sleeps, then grants and dispatches', async () => {
    const h = await realHarness([
      { runId: RUN_ID, attemptId: 'attempt-A' },
      { runId: RUN_ID_2, attemptId: 'attempt-B' },
    ]);
    const clock = steppingClockRealAdvance(NOW);
    const pass = new RunConductorPassUseCase({
      driverLease: h.driverLease,
      runRepo: h.runRepo,
      runJournal: h.runJournal,
      halt: h.halt,
      resume: { applyPendingResume: async () => ({ outcome: 'none' }) },
      advance: new AdvanceLaneRunUseCase(h.deps),
      now: clock.now,
      sleep: clock.sleep,
    });
    const result = await pass.runPass({ holderId: HOLDER, nowIso: NOW });
    expect(result).toMatchObject({ outcome: 'completed', progressed: true });
    if (result.outcome !== 'completed') {
      throw new Error('expected completed, got ' + JSON.stringify(result));
    }
    expect(result.runs.map((run) => run.outcome)).toEqual(['advanced', 'advanced']);
    expect(h.dispatchRequests.map((request) => request.attemptId)).toEqual(['attempt-A', 'attempt-B']);
    expect(result.runs[0]).toMatchObject({ runId: RUN_ID, outcome: 'advanced' });
    if (result.runs[0].outcome !== 'advanced' || result.runs[1].outcome !== 'advanced') {
      throw new Error('expected advanced runs');
    }
    expect(result.runs[0].steps.map((step) => step.outcome)).toEqual(['acted', 'waiting']);
    expect(result.runs[1].steps.map((step) => step.outcome)).toEqual(['waiting', 'acted', 'waiting']);
    expect(clock.sleeps).toEqual([20_001]);
  });

  it('a stop recorded mid-pass is derived fresh at each admission, also in a pool (KF-34b pin)', async () => {
    const h = await realHarness([
      { runId: RUN_ID, attemptId: 'attempt-A' },
      { runId: RUN_ID_2, attemptId: 'attempt-B' },
    ]);
    const realAdvance = new AdvanceLaneRunUseCase({
      ...h.deps,
      runJournal: h.runJournal,
      stopAttempt: {
        stopAttempt: async (request) => ({
          outcome: 'cancelled' as const,
          attempt: attemptFixture(request.attemptId),
          capacityReleased: true,
        }),
      },
    });
    // Run 2's first admission is held, so the stop is recorded while it waits.
    const hold2 = deferredIn<void>();
    let run2Calls = 0;
    const advance: AdvanceLaneRunPort = {
      advanceLaneRun: async (request) => {
        if (request.runId === RUN_ID_2 && run2Calls === 0) {
          run2Calls += 1;
          await hold2.promise;
        }
        return await realAdvance.advanceLaneRun(request);
      },
    };
    const clock = steppingClockRealAdvance(NOW);
    const pass = new RunConductorPassUseCase({
      driverLease: h.driverLease,
      runRepo: h.runRepo,
      runJournal: h.runJournal,
      halt: h.halt,
      resume: { applyPendingResume: async () => ({ outcome: 'none' }) },
      advance,
      now: clock.now,
      sleep: clock.sleep,
      passConcurrency: 2,
    });
    const passPromise = pass.runPass({ holderId: HOLDER, nowIso: NOW });
    // Run 1 dispatches through the real advance while run 2 waits.
    await untilRuns(() => h.dispatchRequests.some((request) => request.attemptId === 'attempt-A'));
    const stop = new RequestLaneRunStopUseCase({ runRepo: h.runRepo, runJournal: h.runJournal });
    expect(
      await stop.requestLaneRunStop({ runId: RUN_ID_2, mode: 'graceful', via: 'cli', entryId: '01JC0000000000000000000001', nowIso: NOW }),
    ).toMatchObject({ outcome: 'stop-recorded' });
    hold2.resolveIn();
    const result = await passPromise;
    expect(result).toMatchObject({ outcome: 'completed' });
    if (result.outcome !== 'completed') {
      throw new Error('expected completed');
    }
    // Run 2's next admission re-derived the stop facts from the journal: the
    // pass passed no cached stop state, and the stop was obeyed mid-pass.
    const run2Report = result.runs.find((run) => run.runId === RUN_ID_2);    expect(run2Report).toBeDefined();
    if (run2Report === undefined || run2Report.outcome !== 'advanced') {
      throw new Error('expected an advanced run 2 report');
    }
    expect(run2Report.steps.some((step) => step.outcome === 'acted' && step.step === 'stop')).toBe(true);  });
});

/** A deferred for the KF-34b pool tests: resolve-only, no real timer. */
function deferredIn<T>(): {
  readonly promise: Promise<T>;
  readonly resolveIn: (value: T) => void;
} {
  let resolveIn!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolveIn = res;
  });
  return { promise, resolveIn };
}

/** Yield to the event loop until `condition` holds; scheduling only, no real timer. */
async function untilRuns(condition: () => boolean): Promise<void> {
  for (let turns = 0; turns < 1000 && !condition(); turns += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(condition()).toBe(true);
}

describe('RunConductorPassUseCase pass pool (KF-34b)', () => {
  const RUN_ID_3 = 'run-01JB0000000000000000000002';

  function deferred<T>(): {
    readonly promise: Promise<T>;
    readonly resolve: (value: T) => void;
  } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  /** Yield to the event loop until `condition` holds; scheduling only, no real timer. */
  async function until(condition: () => boolean): Promise<void> {
    for (let turns = 0; turns < 1000 && !condition(); turns += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(condition()).toBe(true);
  }

  type AdvanceStep = AdvanceLaneRunResult | Promise<AdvanceLaneRunResult>;

  /**
   * A traced advance fake for the pool: every call records `in:<run>` before
   * awaiting its handler and `out:<run>` after, so an ordered trace pins what
   * overlapped and in which order things finished.
   */
  class ConcurrentAdvance implements AdvanceLaneRunPort {
    readonly trace: string[] = [];
    readonly requests: AdvanceLaneRunRequest[] = [];
    private readonly used = new Map<string, number>();

    constructor(private readonly handler: (request: AdvanceLaneRunRequest, call: number) => AdvanceStep) {}

    callsOf(runId: string): number {
      return this.requests.filter((request) => request.runId === runId).length;
    }

    async advanceLaneRun(request: AdvanceLaneRunRequest): Promise<AdvanceLaneRunResult> {
      const call = this.used.get(request.runId) ?? 0;
      this.used.set(request.runId, call + 1);
      this.requests.push(request);
      this.trace.push(`in:${request.runId}`);
      const result = await this.handler(request, call);
      this.trace.push(`out:${request.runId}`);
      return result;
    }
  }

  function poolUseCase(
    fx: Stores,
    advance: AdvanceLaneRunPort,
    extra: Partial<RunConductorPassDependencies> = {},
  ): RunConductorPassUseCase {
    return new RunConductorPassUseCase({
      driverLease: fx.driverLease,
      runRepo: fx.repo,
      runJournal: fx.journal,
      halt: fx.halt,
      resume: { applyPendingResume: async () => ({ outcome: 'none' }) },
      advance,
      now: () => NOW,
      ...extra,
    });
  }

  const admission: AdvanceLaneRunResult = { outcome: 'waiting', reason: 'admission' };

  it('at concurrency 2 the third run enters only after one of the first two finishes', async () => {
    const fx = stores();
    await createRun(fx.repo);
    await createRun(fx.repo, { runId: RUN_ID_2 });
    await createRun(fx.repo, { runId: RUN_ID_3 });
    const hold1 = deferred<AdvanceLaneRunResult>();
    const hold2 = deferred<AdvanceLaneRunResult>();
    const advance = new ConcurrentAdvance((request, call) => {
      if (call === 0 && request.runId === RUN_ID) {
        return hold1.promise;
      }
      if (call === 0 && request.runId === RUN_ID_2) {
        return hold2.promise;
      }
      return admission;
    });
    const passPromise = poolUseCase(fx, advance, { passConcurrency: 2 }).runPass({ holderId: HOLDER, nowIso: NOW });
    await until(() => advance.trace.includes(`in:${RUN_ID}`) && advance.trace.includes(`in:${RUN_ID_2}`));
    // Both workers are busy; the third run waits in the queue.
    expect(advance.trace.some((entry) => entry.includes(RUN_ID_3))).toBe(false);
    hold1.resolve(admission);
    await until(() => advance.trace.includes(`in:${RUN_ID_3}`));
    expect(advance.trace.indexOf(`in:${RUN_ID_3}`)).toBeGreaterThan(advance.trace.indexOf(`out:${RUN_ID}`));
    hold2.resolve(admission);
    const result = await passPromise;
    expect(result).toMatchObject({ outcome: 'completed', progressed: false });
    if (result.outcome !== 'completed') {
      throw new Error('expected completed');
    }
    expect(result.runs.map((run) => run.runId)).toEqual([RUN_ID, RUN_ID_2, RUN_ID_3]);
  });

  it('runs finishing in reverse order still report and draw attention in list order', async () => {
    const fx = stores();
    await createRun(fx.repo);
    await createRun(fx.repo, { runId: RUN_ID_2 });
    const hold1 = deferred<AdvanceLaneRunResult>();
    const grace: AdvanceLaneRunResult = { outcome: 'waiting', reason: 'stop-grace-exceeded' };
    const advance = new ConcurrentAdvance((request, call) => {
      if (request.runId === RUN_ID && call === 0) {
        return hold1.promise;
      }
      // RUN_ID_2 also drains past its grace, and finishes while run 1's first
      // step is still held.
      return request.runId === RUN_ID_2 && call === 0 ? grace : admission;
    });
    const passPromise = poolUseCase(fx, advance, { passConcurrency: 2 }).runPass({ holderId: HOLDER, nowIso: NOW });
    // Run 2 finishes completely while run 1's first step is still held.
    await until(() => advance.trace.includes(`out:${RUN_ID_2}`));
    hold1.resolve(grace);
    const result = await passPromise;
    expect(result).toMatchObject({ outcome: 'completed' });
    if (result.outcome !== 'completed') {
      throw new Error('expected completed');
    }
    expect(result.runs.map((run) => run.runId)).toEqual([RUN_ID, RUN_ID_2]);
    // Both runs drained past their grace; the attention entries follow list
    // order even though RUN_ID_2 finished first.
    expect(result.attention).toEqual([
      { runId: RUN_ID, kind: 'stop-grace-exceeded' },
      { runId: RUN_ID_2, kind: 'stop-grace-exceeded' },
    ]);
  });

  it('a worker whose advance rejects: the sibling finishes, no new step starts, and the pass rejects after the join', async () => {
    const fx = stores();
    await createRun(fx.repo);
    await createRun(fx.repo, { runId: RUN_ID_2 });
    await createRun(fx.repo, { runId: RUN_ID_3 });
    const releases: string[] = [];
    const repo = fx.repo;
    const wrappedRepo = {
      list: () => repo.list(),
      acquireLease: (runId: string, request: Parameters<typeof repo.acquireLease>[1]) => repo.acquireLease(runId, request),
      renewLease: (runId: string, request: Parameters<typeof repo.renewLease>[1]) => repo.renewLease(runId, request),
      releaseLease: (runId: string, request: Parameters<typeof repo.releaseLease>[1]) => {
        releases.push(runId);
        return repo.releaseLease(runId, request);
      },
    };
    const hold1 = deferred<AdvanceLaneRunResult>();
    const error = new Error('advance exploded');
    const advance = new ConcurrentAdvance((request, call) => {
      if (request.runId === RUN_ID && call === 0) {
        return hold1.promise;
      }
      if (request.runId === RUN_ID_2) {
        throw error;
      }
      return admission;
    });
    const pass = new RunConductorPassUseCase({
      driverLease: fx.driverLease,
      runRepo: wrappedRepo,
      runJournal: fx.journal,
      halt: fx.halt,
      resume: { applyPendingResume: async () => ({ outcome: 'none' }) },
      advance,
      now: () => NOW,
      passConcurrency: 2,
    });
    const passPromise = pass.runPass({ holderId: HOLDER, nowIso: NOW });
    let settled = false;
    passPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await until(() => advance.trace.includes(`in:${RUN_ID}`) && advance.trace.includes(`in:${RUN_ID_2}`));
    // The rejection latched the stop while run 1's step is still in flight;
    // the pass is still pending.
    expect(advance.trace).not.toContain(`out:${RUN_ID}`);
    for (let turns = 0; turns < 25; turns += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(settled).toBe(false);
    // The sibling's held step resolves with a non-finishing step: the latched
    // stop must end its turn without a second call, and the queued run 3 is
    // never advanced.
    hold1.resolve({ outcome: 'entered', state: 'dispatching' });
    const caught = await passPromise.then(
      () => 'resolved' as const,
      (thrown: unknown) => thrown,
    );
    expect(caught).toBe(error);
    // The sibling's in-flight step finished and is its only step; nothing new started.
    expect(advance.callsOf(RUN_ID)).toBe(1);
    expect(advance.callsOf(RUN_ID_2)).toBe(1);
    expect(advance.callsOf(RUN_ID_3)).toBe(0);
    expect(advance.trace).toContain(`out:${RUN_ID}`);
    // No lease was released before (or by) the pass: they are still held.
    expect(releases).toEqual([]);
    expect(await pass.releaseLeases({ holderId: HOLDER, nowIso: SOON })).toEqual({ released: 3 });
  });

  it('a driver-lease loss while a worker waits on the start gate: the woken worker never advances', async () => {
    const fx = stores();
    await createRun(fx.repo);
    await createRun(fx.repo, { runId: RUN_ID_2 });
    let sleepCalls = 0;
    const sleep = async (): Promise<void> => {
      sleepCalls += 1;
    };
    const dispatchStarted = (runId: string): AdvanceLaneRunResult => ({
      outcome: 'acted',
      step: 'dispatch',
      key: `${runId}/r0/dispatch/0/a1`,
      result: 'completed',
      reasonCode: 'dispatch-started',
    });
    let driverReads = 0;
    const driverLease = fx.driverLease;
    const wrappedDriver: ConductorDriverLeasePort = {
      read: () => {
        driverReads += 1;
        return driverLease.read();
      },
      acquire: (request) => driverLease.acquire(request),
      renew: (request) => driverLease.renew(request),
      release: (request) => driverLease.release(request),
      check: (request) => driverLease.check(request),
    };
    // Run 1's and run 2's first advances are held so the interleaving is
    // deterministic: run 1 grants the start and takes the lease over, then
    // run 2 is denied at the start gate.
    const holdRun1 = deferred<void>();
    const holdRun2 = deferred<void>();
    const advance = new ConcurrentAdvance(async (request, call) => {
      if (call === 0 && request.runId === RUN_ID) {
        await holdRun1.promise;
      }
      if (call === 0 && request.runId === RUN_ID_2) {
        await holdRun2.promise;
      }
      const next = call === 0 ? dispatchStarted(request.runId) : admission;
      if (next.outcome === 'acted' && request.startGate !== undefined) {
        if (!request.startGate.tryStart(request.runId, request.nowIso).ok) {
          return { outcome: 'waiting', reason: 'session-stagger' };
        }
      }
      if (request.runId === RUN_ID && call === 0) {
        // The driver lease lapses and a second driver takes over while the
        // sibling worker is still held inside its first advance.
        await driverLease.acquire({
          holderId: HOLDER_2,
          observedFence: 1,
          leaseUntilIso: '2026-10-27T10:11:00.000Z',
          nowIso: LATER,
        });
      }
      return next;
    });
    const pass = new RunConductorPassUseCase({
      driverLease: wrappedDriver,
      runRepo: fx.repo,
      runJournal: fx.journal,
      halt: fx.halt,
      resume: { applyPendingResume: async () => ({ outcome: 'none' }) },
      advance,
      now: () => NOW,
      sleep,
      passConcurrency: 2,
    });
    const passPromise = pass.runPass({ holderId: HOLDER, nowIso: NOW });
    // Both workers are inside their first advance, held.
    await until(() => advance.trace.includes(`in:${RUN_ID}`) && advance.trace.includes(`in:${RUN_ID_2}`));
    holdRun1.resolve();
    // Run 1 grants its start and takes the lease over.
    await until(() => advance.trace.includes(`out:${RUN_ID}`));
    // Run 1's post-takeover renewal latched the loss (four keeper reads: the
    // pass's take, run 1 step 1, run 2 step 1, then run 1's post-takeover
    // renewal). Only then is run 2 released.
    await until(() => driverReads >= 4);
    for (let turns = 0; turns < 25; turns += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    holdRun2.resolve();
    // Run 2 is denied the start, but the stop is already latched: it never
    // sleeps on the start gate and never calls advance again.
    for (let turns = 0; turns < 25; turns += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(sleepCalls).toBe(0);
    const result = await passPromise;
    expect(result).toEqual({ outcome: 'refused', reason: 'driver-lease-held' });
    expect(advance.callsOf(RUN_ID_2)).toBe(1);
  });

  it('an invalid clock in one worker latches the stop and a sibling never starts its queued step', async () => {
    const fx = stores();
    await createRun(fx.repo);
    await createRun(fx.repo, { runId: RUN_ID_2 });
    // Reads: the pass start, then run 2's fresh clock read. Run 1, the first
    // live run, reuses the pass-start now; it is held inside its lease
    // acquire, before any further read.
    let clockReads = 0;
    const now = (): string => {
      clockReads += 1;
      return clockReads === 2 ? 'not-an-iso-time' : NOW;
    };
    const repo = fx.repo;
    const acquireHold = deferred<void>();
    let acquireReached = false;
    const runRepo = {
      list: () => repo.list(),
      acquireLease: async (runId: string, request: Parameters<typeof repo.acquireLease>[1]) => {
        if (runId === RUN_ID) {
          acquireReached = true;
          await acquireHold.promise;
        }
        return repo.acquireLease(runId, request);
      },
      renewLease: (runId: string, request: Parameters<typeof repo.renewLease>[1]) => repo.renewLease(runId, request),
      releaseLease: (runId: string, request: Parameters<typeof repo.releaseLease>[1]) => repo.releaseLease(runId, request),
    };
    const advance = new ConcurrentAdvance(() => admission);
    const passPromise = poolUseCase(fx, advance, { passConcurrency: 2, now, runRepo }).runPass({
      holderId: HOLDER,
      nowIso: NOW,
    });
    // Run 1 is parked inside its lease acquire; run 2's fresh clock read is
    // the invalid one and latched the stop.
    await until(() => acquireReached && clockReads >= 2);
    acquireHold.resolve();
    const result = await passPromise;
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    // The latched stop ended run 1's turn before its queued first step.
    expect(advance.callsOf(RUN_ID)).toBe(0);
    expect(advance.callsOf(RUN_ID_2)).toBe(0);
  });

  it('a throw in one worker stops a sibling waiting on a deferred halt read from starting a new step', async () => {
    const fx = stores();
    await createRun(fx.repo);
    await createRun(fx.repo, { runId: RUN_ID_2 });
    const holdStep1 = deferred<AdvanceLaneRunResult>();
    const error = new Error('advance exploded');
    let rejectTrigger!: (error: unknown) => void;
    // The sibling's second per-step halt read resolves only one microtask hop
    // after this rejection, so its post-read stop check runs after the throw
    // has left the worker's turn.
    const trigger = new Promise<never>((_resolve, reject) => {
      rejectTrigger = reject;
    });
    const clearHalt: ConductorHaltState = { state: 'clear', record: null };
    let haltReads = 0;
    const halt = {
      read: async (): Promise<ConductorHaltState> => {
        haltReads += 1;
        if (haltReads === 4) {
          // Resolves one microtask hop after the sibling worker's rejection
          // left its turn: the post-read stop check then runs after the throw
          // has left `advanceRun` but before the worker-loop catch latches.
          return trigger.catch(() => clearHalt);
        }
        return fx.halt.read();
      },
    };
    const advance = new ConcurrentAdvance((request, call) => {
      if (request.runId === RUN_ID && call === 0) {
        return holdStep1.promise;
      }
      if (request.runId === RUN_ID_2 && call === 0) {
        return trigger;
      }
      return admission;
    });
    const passPromise = poolUseCase(fx, advance, { passConcurrency: 2, halt }).runPass({
      holderId: HOLDER,
      nowIso: NOW,
    });
    await until(() => advance.trace.includes(`in:${RUN_ID}`) && advance.trace.includes(`in:${RUN_ID_2}`));
    holdStep1.resolve({ outcome: 'entered', state: 'dispatching' });
    // Run 1 is parked on its second per-step halt read; run 2's step is about
    // to throw.
    await until(() => haltReads >= 4);
    rejectTrigger(error);
    const caught = await passPromise.then(
      () => 'resolved' as const,
      (thrown: unknown) => thrown,
    );
    expect(caught).toBe(error);
    // The sibling's post-halt stop check saw the latch: no second step.
    expect(advance.callsOf(RUN_ID)).toBe(1);
    expect(advance.callsOf(RUN_ID_2)).toBe(1);
  });

  it('a worker whose sibling latched the stop does not sleep on the start gate', async () => {
    const fx = stores();
    await createRun(fx.repo);
    await createRun(fx.repo, { runId: RUN_ID_2 });
    const hold2 = deferred<AdvanceLaneRunResult>();
    const holdThrow = deferred<void>();
    let sleepCalls = 0;
    const sleep = async (): Promise<void> => {
      sleepCalls += 1;
    };
    const error = new Error('advance exploded');
    const advance = new ConcurrentAdvance(async (request, call) => {
      if (request.runId === RUN_ID && call === 0) {
        // Held, then thrown, only after the sibling's step is in flight too.
        await holdThrow.promise;
        throw error;
      }
      if (request.runId === RUN_ID_2 && call === 0) {
        return hold2.promise;
      }
      return admission;
    });
    const passPromise = poolUseCase(fx, advance, { passConcurrency: 2, sleep }).runPass({
      holderId: HOLDER,
      nowIso: NOW,
    });
    await until(() => advance.trace.includes(`in:${RUN_ID}`) && advance.trace.includes(`in:${RUN_ID_2}`));
    holdThrow.resolve();
    // Run 1's rejection latched the stop while run 2's step is still held.
    for (let turns = 0; turns < 5; turns += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    // Run 2's held step now denies the start: the latched stop must be checked
    // before the sleep, so the worker never sleeps.
    hold2.resolve({ outcome: 'waiting', reason: 'session-stagger' });
    const caught = await passPromise.then(
      () => 'resolved' as const,
      (thrown: unknown) => thrown,
    );
    expect(caught).toBe(error);
    expect(sleepCalls).toBe(0);
    expect(advance.callsOf(RUN_ID_2)).toBe(1);
  });

  it('a run-lease loss stops only that run; the sibling keeps advancing', async () => {
    const fx = stores();
    await createRun(fx.repo);
    await createRun(fx.repo, { runId: RUN_ID_2 });
    const repo = fx.repo;
    const renewCounts = new Map<string, number>([
      [RUN_ID, 0],
      [RUN_ID_2, 0],
    ]);
    const wrappedRepo = {
      list: () => repo.list(),
      acquireLease: (runId: string, request: Parameters<typeof repo.acquireLease>[1]) => repo.acquireLease(runId, request),
      renewLease: (runId: string, request: Parameters<typeof repo.renewLease>[1]) => {
        renewCounts.set(runId, (renewCounts.get(runId) ?? 0) + 1);
        if (runId === RUN_ID && (renewCounts.get(runId) ?? 0) >= 2) {
          return Promise.resolve({ outcome: 'refused', reason: 'lease-not-held' } as never);
        }
        return repo.renewLease(runId, request);
      },
      releaseLease: (runId: string, request: Parameters<typeof repo.releaseLease>[1]) => repo.releaseLease(runId, request),
    };
    const entered = (state: 'dispatching' | 'running'): AdvanceLaneRunResult => ({ outcome: 'entered', state });
    const advance = new ConcurrentAdvance((request, call) => {
      if (request.runId === RUN_ID) {
        return entered(call === 0 ? 'dispatching' : 'running');
      }
      return call < 2 ? entered(call === 0 ? 'dispatching' : 'running') : admission;
    });
    const pass = new RunConductorPassUseCase({
      driverLease: fx.driverLease,
      runRepo: wrappedRepo,
      runJournal: fx.journal,
      halt: fx.halt,
      resume: { applyPendingResume: async () => ({ outcome: 'none' }) },
      advance,
      now: () => NOW,
      passConcurrency: 2,
    });
    const result = await pass.runPass({ holderId: HOLDER, nowIso: NOW });
    expect(result).toMatchObject({ outcome: 'completed', progressed: true });
    if (result.outcome !== 'completed') {
      throw new Error('expected completed');
    }
    // Run 1 lost its lease before its second step and keeps the step that ran;
    // run 2 was never touched by that loss.
    expect(result.runs[0]).toMatchObject({ runId: RUN_ID, outcome: 'advanced' });
    if (result.runs[0].outcome !== 'advanced') {
      throw new Error('expected advanced');
    }
    expect(result.runs[0].steps).toEqual([entered('dispatching')]);
    expect(advance.callsOf(RUN_ID)).toBe(1);
    expect(advance.callsOf(RUN_ID_2)).toBe(3);
  });

  it('the pass promise stays pending while an in-flight step is unresolved, even after the sibling stopped', async () => {
    const fx = stores();
    await createRun(fx.repo);
    await createRun(fx.repo, { runId: RUN_ID_2 });
    const hold1 = deferred<AdvanceLaneRunResult>();
    const advance = new ConcurrentAdvance((request, call) => {
      if (request.runId === RUN_ID && call === 0) {
        return hold1.promise;
      }
      return admission;
    });
    const passPromise = poolUseCase(fx, advance, { passConcurrency: 2 }).runPass({ holderId: HOLDER, nowIso: NOW });
    let settled = false;
    passPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    // Run 2's worker is done; run 1's step is still in flight.
    await until(() => advance.trace.includes(`out:${RUN_ID_2}`));
    for (let turns = 0; turns < 25; turns += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(settled).toBe(false);
    hold1.resolve(admission);
    const result = await passPromise;
    expect(result).toMatchObject({ outcome: 'completed' });
    expect(settled).toBe(true);
  });

  it('a halt recorded during run 1\'s long step: run 2\'s next advance receives halted true', async () => {
    const fx = stores();
    await createRun(fx.repo);
    await createRun(fx.repo, { runId: RUN_ID_2 });
    const hold1 = deferred<AdvanceLaneRunResult>();
    const hold2 = deferred<AdvanceLaneRunResult>();
    const advance = new ConcurrentAdvance((request, call) => {
      if (request.runId === RUN_ID && call === 0) {
        return hold1.promise;
      }
      if (request.runId === RUN_ID_2 && call === 0) {
        return hold2.promise;
      }
      return admission;
    });
    const passPromise = poolUseCase(fx, advance, { passConcurrency: 2 }).runPass({ holderId: HOLDER, nowIso: NOW });
    // Both workers are inside their first advance (each already read the halt
    // marker as false for that step).
    await until(() => advance.trace.includes(`in:${RUN_ID}`) && advance.trace.includes(`in:${RUN_ID_2}`));
    await fx.halt.set({ halted: true, nowIso: NOW });
    hold1.resolve(admission);
    hold2.resolve({ outcome: 'entered', state: 'dispatching' });
    const result = await passPromise;
    expect(result).toMatchObject({ outcome: 'completed', halted: true });
    // Run 1's step was admitted before the halt; run 2's next admission read it fresh.
    expect(advance.requests[0]).toMatchObject({ runId: RUN_ID, halted: false });
    expect(advance.requests[1]).toMatchObject({ runId: RUN_ID_2, halted: false });
    expect(advance.requests[2]).toMatchObject({ runId: RUN_ID_2, halted: true });
  });

  it('two dispatching runs at concurrency 2 start at least dispatchStaggerMs apart', async () => {
    const fx = stores();
    await createRun(fx.repo);
    await createRun(fx.repo, { runId: RUN_ID_2 });
    const dispatchStarted = (runId: string): AdvanceLaneRunResult => ({
      outcome: 'acted',
      step: 'dispatch',
      key: `${runId}/r0/dispatch/0/a1`,
      result: 'completed',
      reasonCode: 'dispatch-started',
    });
    const grantedStarts: { readonly runId: string; readonly nowIso: string }[] = [];
    // A per-run index managed here: a denied session start does not consume
    // the queue, exactly like the real advance before its one-way intent.
    const nextIndex = new Map<string, number>();
    const advance = new ConcurrentAdvance((request) => {
      const index = nextIndex.get(request.runId) ?? 0;
      const next = index === 0 ? dispatchStarted(request.runId) : admission;
      if (next.outcome === 'acted' && request.startGate !== undefined) {
        if (!request.startGate.tryStart(request.runId, request.nowIso).ok) {
          return { outcome: 'waiting', reason: 'session-stagger' };
        }
        grantedStarts.push({ runId: request.runId, nowIso: request.nowIso });
      }
      nextIndex.set(request.runId, index + 1);
      return next;
    });
    // The fake sleep advances the clock by the awaited amount, so the wait is
    // exact and no real timer runs.
    let current = Date.parse(NOW);
    const clock = {
      now: () => new Date(current).toISOString(),
      sleep: async (ms: number): Promise<void> => {
        current += ms;
      },
    };
    const staggerMs = 500;
    const result = await new RunConductorPassUseCase({
      driverLease: fx.driverLease,
      runRepo: fx.repo,
      runJournal: fx.journal,
      halt: fx.halt,
      resume: { applyPendingResume: async () => ({ outcome: 'none' }) },
      advance,
      now: clock.now,
      sleep: clock.sleep,
      dispatchStaggerMs: staggerMs,
      passConcurrency: 2,
    }).runPass({ holderId: HOLDER, nowIso: NOW });
    expect(result).toMatchObject({ outcome: 'completed', progressed: true });
    expect(grantedStarts).toHaveLength(2);
    const ordered = [...grantedStarts].sort((left, right) => left.nowIso.localeCompare(right.nowIso));
    const gap = Date.parse(ordered[1]!.nowIso) - Date.parse(ordered[0]!.nowIso);
    expect(gap).toBeGreaterThanOrEqual(staggerMs);
  });
});

describe('ConductorDriverLeaseKeeper loss latch and expiry monotonicity (KF-34b)', () => {
  it('a throwing port latches a driver-lease-refused loss before rethrowing, and a later call never retries it', async () => {
    let portCalls = 0;
    const driverLease: ConductorDriverLeasePort = {
      read: async () => {
        portCalls += 1;
        throw new Error('storage exploded');
      },
      acquire: async () => {
        portCalls += 1;
        throw new Error('storage exploded');
      },
      renew: async () => {
        portCalls += 1;
        throw new Error('storage exploded');
      },
      release: async () => {
        portCalls += 1;
        throw new Error('storage exploded');
      },
      check: async () => {
        portCalls += 1;
        throw new Error('storage exploded');
      },
    };
    const keeper = new ConductorDriverLeaseKeeper({ driverLease, holderId: HOLDER, now: () => NOW });
    await expect(keeper.renew()).rejects.toThrow('storage exploded');
    expect(portCalls).toBe(1);
    // The sibling worker's call answers the latched loss without touching the port.
    await expect(keeper.renew()).resolves.toEqual({ outcome: 'lost', reason: 'driver-lease-refused' });
    expect(portCalls).toBe(1);
  });

  it('a clock set backwards between two renewals never shortens the lease the keeper sends', async () => {
    const fx = stores();
    const renews: LeaseRenewRequest[] = [];
    const driverLease = fx.driverLease;
    const wrappedDriver: ConductorDriverLeasePort = {
      read: () => driverLease.read(),
      acquire: (request) => driverLease.acquire(request),
      renew: (request) => {
        renews.push(request);
        return driverLease.renew(request);
      },
      release: (request) => driverLease.release(request),
      check: (request) => driverLease.check(request),
    };
    let current = Date.parse(NOW);
    const keeper = new ConductorDriverLeaseKeeper({
      driverLease: wrappedDriver,
      holderId: HOLDER,
      now: () => new Date(current).toISOString(),
    });
    const first = await keeper.renew();
    expect(first).toMatchObject({ outcome: 'held' });
    expect((await driverLease.read())?.leaseUntilIso).toBe(new Date(Date.parse(NOW) + 5 * 60 * 1000).toISOString());
    // The clock steps back a minute between the two renewals.
    current -= 60_000;
    const second = await keeper.renew();
    expect(second).toMatchObject({ outcome: 'held' });
    expect(renews).toHaveLength(1);
    // The renewal sends the last sent expiry, never the stepped-back one.
    expect(renews[0]!.leaseUntilIso).toBe(new Date(Date.parse(NOW) + 5 * 60 * 1000).toISOString());
  });
});
