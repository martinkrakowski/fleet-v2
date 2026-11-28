import { types } from 'node:util';
// FY04: pin today's `progressed` behaviour of the daemon merge-pass job.
//
// Where `progressed` is read today (file names only, from
// `git grep -nw progressed origin/main -- packages apps`):
//
// - packages/work-execution/src/application/use-cases/RunDaemonTickUseCase.use-case.ts
//   (produces it: `toDaemonJobOutcome` for the merge-pass job, the chain-refresh
//   and forge-poll outcomes, and `normalizeJobOutcome` re-reading a job's own
//   outcome; nothing outside this file consumes the merge-pass job's value)
// - packages/work-execution/src/domain/daemon-tick.ts (the `DaemonJobOutcome` type)
// - packages/work-execution/src/domain/conductor-pass-trace.ts (the conductor
//   pass's own `progressed`, not the daemon job's)
// - packages/work-execution/src/application/use-cases/RunConductorPassUseCase.use-case.ts
//   and ListConductorPassesUseCase.use-case.ts (the conductor pass's own `progressed`)
// - packages/work-execution/src/application/ports/in/RunConductorPassPort.in-port.ts (type only)
// - apps/cli/src/conductor.ts (the conductor pass's own `progressed`)
// - apps/web/src/app/conductor/map-passes.ts and components/pass-list.tsx (conductor passes)
// - apps/api/test/fixtures/v1-runs-passes.json and test/runs-passes.test.ts (conductor passes)
// - existing tests across packages/work-execution and apps
//
// The status record (`DaemonJobStatusRecord`) and the event record
// (`DaemonEventRecord`) omit `progressed` entirely, and no file outside
// RunDaemonTickUseCase.use-case.ts reads the daemon merge-pass job's
// `progressed`: today it is produced and dropped inside the tick. This file
// pins that exact shape.
//
// This file copies its harness from run-daemon-tick.test.ts and never imports
// from or edits that file. Tests only: no production file changes.

import { describe, expect, it } from 'vitest';

import { DaemonJobRegistry, RunDaemonTickUseCase } from '../RunDaemonTickUseCase.use-case.js';
import type { RunDaemonTickDependencies } from '../RunDaemonTickUseCase.use-case.js';
import type { DaemonRepositoryRef, RunDaemonTickRequest, RunDaemonTickResult } from '../../ports/in/RunDaemonTickPort.in-port.js';
import type { RunMergePassPort, RunMergePassRequest, RunMergePassResult } from '../../ports/in/RunMergePassPort.in-port.js';
import type { DaemonLeasePort, DaemonLeaseResult } from '../../ports/out/DaemonLeasePort.out-port.js';
import type { DaemonStatusPort, DaemonStatusFileRead } from '../../ports/out/DaemonStatusPort.out-port.js';
import type { DaemonPausePort } from '../../ports/out/DaemonPausePort.out-port.js';
import type { DaemonEventProjectionPort } from '../../ports/out/DaemonEventProjectionPort.out-port.js';
import type { ConductorHaltPort } from '../../ports/out/ConductorHaltPort.out-port.js';
import type { MergeQueueRepositoryPort } from '../../ports/out/MergeQueueRepositoryPort.out-port.js';
import type { ForgeMergeReadPort } from '../../ports/out/ForgeMergeReadPort.out-port.js';
import type { LaneRunJournalPort } from '../../ports/out/LaneRunJournalPort.out-port.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import {
  DAEMON_RECORD_VERSION,
  buildDaemonStatusRecord,
  type BuildDaemonStatusInput,
  type DaemonLeaseRecord,
  type DaemonPauseState,
} from '../../../domain/daemon-tick.js';
import type { ConductorHaltState } from '../../../domain/conductor-halt.js';
import type { DaemonEventRecord } from '../../../domain/daemon-events.js';
import type { MergeQueueEntryRecord } from '../../../domain/merge-queue-records.js';
import type { MergeRepoPolicy } from '../../../domain/merge-queue-decider.js';
import type { LeaseAcquireRequest, LeaseHoldRequest } from '../../../domain/lane-run-lease.js';

const TICK_A = `tick-0${'1'.repeat(25)}`;
const DIGEST_A = '00000000000a';
const NOW = '2026-11-01T12:00:00.000Z';
const DEADLINE = '2026-11-01T12:00:45.000Z';

function mergePolicy(): MergeRepoPolicy {
  return {
    policyRevision: 'rev-1',
    shadow: true,
    unattended: true,
    updateBranch: false,
    veto: { mode: 'off' },
  };
}

function repoRef(digest: string, overrides: Partial<DaemonRepositoryRef> = {}): DaemonRepositoryRef {
  return {
    owner: 'fleet',
    repo: `v2-${digest.slice(-1)}`,
    repoDigest: digest,
    projectId: 'proj-1',
    policy: mergePolicy(),
    ...overrides,
  };
}

class FakeStatus implements Pick<DaemonStatusPort, 'read' | 'write'> {
  readValue: DaemonStatusFileRead = { status: 'missing' };
  throwOnRead = false;
  readonly writes: BuildDaemonStatusInput[] = [];
  async read(): Promise<DaemonStatusFileRead> {
    if (this.throwOnRead) {
      throw new Error('status store exploded');
    }
    return this.readValue;
  }
  async write(input: BuildDaemonStatusInput) {
    this.writes.push(input);
    return buildDaemonStatusRecord(input);
  }
}

class FakeLease implements Pick<DaemonLeasePort, 'acquire' | 'release' | 'read'> {
  readonly records = new Map<string, DaemonLeaseRecord>();
  readonly acquires: (LeaseAcquireRequest & { scope: string })[] = [];
  async read(scope: string): Promise<DaemonLeaseRecord | null> {
    return this.records.get(scope) ?? null;
  }
  async acquire(request: LeaseAcquireRequest & { scope: string }): Promise<DaemonLeaseResult> {
    this.acquires.push(request);
    const current = this.records.get(request.scope) ?? null;
    const fence = (current?.fence ?? 0) + 1;
    const lease: DaemonLeaseRecord = {
      version: DAEMON_RECORD_VERSION,
      scope: request.scope,
      holderId: request.holderId,
      fence,
      leaseUntilIso: request.leaseUntilIso,
    };
    this.records.set(request.scope, lease);
    return { outcome: 'ok', lease };
  }
  async release(request: LeaseHoldRequest & { scope: string }): Promise<DaemonLeaseResult> {
    const existing = this.records.get(request.scope);
    return {
      outcome: 'ok',
      lease: existing ?? {
        version: DAEMON_RECORD_VERSION,
        scope: request.scope,
        holderId: request.holderId,
        fence: request.fence,
        leaseUntilIso: request.nowIso,
      },
    };
  }
}

class FakePause implements Pick<DaemonPausePort, 'read'> {
  state: DaemonPauseState = { state: 'clear', record: null };
  async read(): Promise<DaemonPauseState> {
    return this.state;
  }
}

class FakeHalt implements Pick<ConductorHaltPort, 'read'> {
  state: ConductorHaltState = { state: 'clear', record: null };
  async read(): Promise<ConductorHaltState> {
    return this.state;
  }
}

class FakeEvents implements Pick<DaemonEventProjectionPort, 'append'> {
  readonly events: DaemonEventRecord[] = [];
  async append(events: readonly DaemonEventRecord[]): Promise<{ appended: number }> {
    this.events.push(...events);
    return { appended: events.length };
  }
}

class FakeQueue implements Pick<MergeQueueRepositoryPort, 'listMergeEntries'> {
  entries: readonly MergeQueueEntryRecord[] = [];
  async listMergeEntries(): Promise<readonly MergeQueueEntryRecord[]> {
    return this.entries;
  }
}

class FakeForge implements Pick<ForgeMergeReadPort, 'isConfigured'> {
  configured = true;
  isConfigured(): boolean {
    return this.configured;
  }
}

class FakeJournal implements Pick<LaneRunJournalPort, 'listForKey'> {
  readonly byKey = new Map<string, readonly LaneRunJournalEntryRecord[]>();
  async listForKey(key: string): Promise<readonly LaneRunJournalEntryRecord[]> {
    return this.byKey.get(key) ?? [];
  }
}

class FakeMergePass implements RunMergePassPort {
  readonly requests: RunMergePassRequest[] = [];
  result: RunMergePassResult = { outcome: 'completed', reasonCode: null, entries: [] };
  async runMergePass(request: RunMergePassRequest): Promise<RunMergePassResult> {
    this.requests.push(request);
    return this.result;
  }
}

interface Harness {
  readonly status: FakeStatus;
  readonly lease: FakeLease;
  readonly events: FakeEvents;
  readonly mergePass: FakeMergePass;
  readonly run: (overrides?: Partial<RunDaemonTickRequest>) => Promise<RunDaemonTickResult>;
}

function makeHarness(
  overrides: {
    readonly nowFn?: () => string;
    readonly mergePassResult?: RunMergePassResult;
    readonly now?: string;
  } = {},
): Harness {
  const status = new FakeStatus();
  const lease = new FakeLease();
  const pause = new FakePause();
  const halt = new FakeHalt();
  const events = new FakeEvents();
  const queue = new FakeQueue();
  const forge = new FakeForge();
  const journal = new FakeJournal();
  const mergePass = new FakeMergePass();
  // Assign even when the override is `undefined`: a test may pin the undefined result.
  if (Object.hasOwn(overrides, 'mergePassResult')) {
    mergePass.result = overrides.mergePassResult as RunMergePassResult;
  }
  const now = overrides.nowFn ?? (() => overrides.now ?? NOW);
  const deps: RunDaemonTickDependencies = {
    isProxy: types.isProxy,
    pause,
    halt,
    status,
    lease,
    events,
    queue,
    forge,
    journal,
    mergePass,
    now,
    sleep: async () => undefined,
    newUlid: (() => {
      let sequence = 0;
      return () => {
        sequence += 1;
        return '0' + String(sequence).padStart(25, '0');
      };
    })(),
  };
  const useCase = new RunDaemonTickUseCase(deps);
  const run = (requestOverrides: Partial<RunDaemonTickRequest> = {}) =>
    useCase.runTick({
      tickId: TICK_A,
      repositories: [repoRef(DIGEST_A)],
      forgeReachable: true,
      deadlineIso: DEADLINE,
      ...requestOverrides,
    });
  return { status, lease, events, mergePass, run };
}

/** One `no-action` entry report: acted on nothing, yet the pass is progress. */
function noActionEntry(): RunMergePassResult['entries'][number] {
  return { entryId: 'entry-1', head12: 'a'.repeat(12), decision: 'no-action', reasonCode: null, journalKey: null };
}

/** A result whose named property throws when read; never a literal secret shape. */
function resultWithThrowingGetter(property: 'outcome' | 'entries'): RunMergePassResult {
  const record: Record<string, unknown> = { reasonCode: null };
  Object.defineProperty(record, property, {
    get() {
      throw new Error('getter exploded');
    },
    enumerable: true,
  });
  return record as unknown as RunMergePassResult;
}

async function expectTickCompleted(run: Harness['run'], mergePass: FakeMergePass): Promise<RunDaemonTickResult> {
  const result = await run();
  expect(result.outcome).toBe('completed');
  expect(result.exitCode).toBe(0);
  expect(mergePass.requests).toHaveLength(1);
  return result;
}

describe('merge-pass job progressed (DaemonJobRegistry / toDaemonJobOutcome)', () => {
  it('completed with no entries records progressed false exactly', async () => {
    const h = makeHarness({ mergePassResult: { outcome: 'completed', reasonCode: null, entries: [] } });
    const job = new DaemonJobRegistry({ mergePass: h.mergePass }).instances([repoRef(DIGEST_A)])[0];
    const outcome = await job.pass({ nowIso: NOW, deadlineIso: DEADLINE });
    expect(outcome).toStrictEqual({ outcome: 'completed', progressed: false });
    expect(Object.hasOwn(outcome, 'progressed')).toBe(true);
  });

  it('completed with one no-action entry records progressed true exactly', async () => {
    const h = makeHarness({ mergePassResult: { outcome: 'completed', reasonCode: null, entries: [noActionEntry()] } });
    const job = new DaemonJobRegistry({ mergePass: h.mergePass }).instances([repoRef(DIGEST_A)])[0];
    const outcome = await job.pass({ nowIso: NOW, deadlineIso: DEADLINE });
    expect(outcome).toStrictEqual({ outcome: 'completed', progressed: true });
    expect(Object.hasOwn(outcome, 'progressed')).toBe(true);
  });

  it('budget-exhausted ignores entries and records progressed false exactly', async () => {
    const h = makeHarness({
      mergePassResult: { outcome: 'budget-exhausted', reasonCode: null, entries: [noActionEntry()] },
    });
    const job = new DaemonJobRegistry({ mergePass: h.mergePass }).instances([repoRef(DIGEST_A)])[0];
    const outcome = await job.pass({ nowIso: NOW, deadlineIso: DEADLINE });
    expect(outcome).toStrictEqual({ outcome: 'budget-exhausted', progressed: false });
    expect(Object.hasOwn(outcome, 'progressed')).toBe(true);
  });

  it('a refused merge-pass result has no progressed property at all', async () => {
    const h = makeHarness({ mergePassResult: { outcome: 'refused', reasonCode: null, entries: [] } });
    const job = new DaemonJobRegistry({ mergePass: h.mergePass }).instances([repoRef(DIGEST_A)])[0];
    const outcome = await job.pass({ nowIso: NOW, deadlineIso: DEADLINE });
    expect(outcome).toStrictEqual({ outcome: 'refused', reasonCode: 'merge-pass-refused' });
    expect(Object.hasOwn(outcome, 'progressed')).toBe(false);
  });

  it('a skipped (unknown for a merge pass) outcome is refused as malformed with no progressed property', async () => {
    const h = makeHarness({
      mergePassResult: { outcome: 'skipped', reasonCode: null, entries: [] } as unknown as RunMergePassResult,
    });
    const job = new DaemonJobRegistry({ mergePass: h.mergePass }).instances([repoRef(DIGEST_A)])[0];
    const outcome = await job.pass({ nowIso: NOW, deadlineIso: DEADLINE });
    expect(outcome).toStrictEqual({ outcome: 'refused', reasonCode: 'merge-pass-malformed' });
    expect(Object.hasOwn(outcome, 'progressed')).toBe(false);
  });

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['an array-like', { length: 3 }],
  ])('non-array entries (%s) on completed are treated as empty: progressed false, never throws', async (_name, entries) => {
    const h = makeHarness({
      mergePassResult: { outcome: 'completed', reasonCode: null, entries } as unknown as RunMergePassResult,
    });
    const job = new DaemonJobRegistry({ mergePass: h.mergePass }).instances([repoRef(DIGEST_A)])[0];
    const outcome = await job.pass({ nowIso: NOW, deadlineIso: DEADLINE });
    expect(outcome).toStrictEqual({ outcome: 'completed', progressed: false });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'completed'],
    ['an array', []],
  ])('a non-record result (%s) is refused as merge-pass-malformed with no progressed property', async (_name, result) => {
    const h = makeHarness({ mergePassResult: result as unknown as RunMergePassResult });
    const job = new DaemonJobRegistry({ mergePass: h.mergePass }).instances([repoRef(DIGEST_A)])[0];
    const outcome = await job.pass({ nowIso: NOW, deadlineIso: DEADLINE });
    expect(outcome).toStrictEqual({ outcome: 'refused', reasonCode: 'merge-pass-malformed' });
    expect(Object.hasOwn(outcome, 'progressed')).toBe(false);
  });

  it('a throwing getter on outcome makes pass reject', async () => {
    const h = makeHarness({ mergePassResult: resultWithThrowingGetter('outcome') });
    const job = new DaemonJobRegistry({ mergePass: h.mergePass }).instances([repoRef(DIGEST_A)])[0];
    await expect(job.pass({ nowIso: NOW, deadlineIso: DEADLINE })).rejects.toThrow('getter exploded');
  });

  it('a throwing getter on entries makes pass reject', async () => {
    const h = makeHarness({ mergePassResult: resultWithThrowingGetter('entries') });
    const job = new DaemonJobRegistry({ mergePass: h.mergePass }).instances([repoRef(DIGEST_A)])[0];
    await expect(job.pass({ nowIso: NOW, deadlineIso: DEADLINE })).rejects.toThrow('getter exploded');
  });

  it('an array-like entries object is not iterated: treated as empty, progressed false', async () => {
    // Cost bound: `Array.isArray` plus one `.length` read, O(1); the fake length
    // is never dereferenced into elements.
    const h = makeHarness({
      mergePassResult: {
        outcome: 'completed',
        reasonCode: null,
        entries: { length: Number.MAX_SAFE_INTEGER },
      } as unknown as RunMergePassResult,
    });
    const job = new DaemonJobRegistry({ mergePass: h.mergePass }).instances([repoRef(DIGEST_A)])[0];
    const outcome = await job.pass({ nowIso: NOW, deadlineIso: DEADLINE });
    expect(outcome).toStrictEqual({ outcome: 'completed', progressed: false });
  });

  it('a sparse array hole counts through length with no iteration: progressed true (pinned exact behaviour)', async () => {
    // `[,].length === 1` and `toDaemonJobOutcome` never iterates entries, so a
    // lone hole makes `progressed` true today. Cost bound: O(1) length read.
    const h = makeHarness({
      mergePassResult: { outcome: 'completed', reasonCode: null, entries: new Array(1) } as unknown as RunMergePassResult,
    });
    const job = new DaemonJobRegistry({ mergePass: h.mergePass }).instances([repoRef(DIGEST_A)])[0];
    const outcome = await job.pass({ nowIso: NOW, deadlineIso: DEADLINE });
    expect(outcome).toStrictEqual({ outcome: 'completed', progressed: true });
  });

  it('a prototype-polluting entries key is never written through: no pollution, progressed false', async () => {
    // JSON.parse gives `entries` an own `__proto__` property (a non-array
    // object), so it is treated as empty. `toDaemonJobOutcome` only reads
    // `.length`/`Array.isArray` and never assigns keys, so nothing is written
    // through the polluting key. Cost bound: O(1), no key enumeration.
    const parsed = JSON.parse('{"outcome":"completed","reasonCode":null,"entries":{"__proto__":{"polluted":true}}}') as unknown;
    const h = makeHarness({ mergePassResult: parsed as RunMergePassResult });
    const job = new DaemonJobRegistry({ mergePass: h.mergePass }).instances([repoRef(DIGEST_A)])[0];
    const outcome = await job.pass({ nowIso: NOW, deadlineIso: DEADLINE });
    expect(outcome).toStrictEqual({ outcome: 'completed', progressed: false });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('a Proxy that lies about entries hides the entries: progressed false (accepted residual: a consistent liar)', async () => {
    const truthful = { outcome: 'completed', reasonCode: null, entries: [noActionEntry()] };
    const liar = new Proxy(truthful, {
      get(target, property, receiver) {
        if (property === 'entries') {
          return [];
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const h = makeHarness({ mergePassResult: liar as unknown as RunMergePassResult });
    const job = new DaemonJobRegistry({ mergePass: h.mergePass }).instances([repoRef(DIGEST_A)])[0];
    const outcome = await job.pass({ nowIso: NOW, deadlineIso: DEADLINE });
    expect(outcome).toStrictEqual({ outcome: 'completed', progressed: false });
  });

  it('an enormous real array length costs O(1): progressed true without iterating', async () => {
    // A holey array of length 1,000,000: `Array.isArray` + one `.length` read,
    // no element access, so the check is O(1) regardless of the length value.
    const h = makeHarness({
      mergePassResult: {
        outcome: 'completed',
        reasonCode: null,
        entries: new Array(1_000_000),
      } as unknown as RunMergePassResult,
    });
    const job = new DaemonJobRegistry({ mergePass: h.mergePass }).instances([repoRef(DIGEST_A)])[0];
    const outcome = await job.pass({ nowIso: NOW, deadlineIso: DEADLINE });
    expect(outcome).toStrictEqual({ outcome: 'completed', progressed: true });
  });
});

describe('merge-pass job progressed through RunDaemonTickUseCase.runTick', () => {
  it('completed with no entries exits 0, calls merge pass once, records completed in status and an event', async () => {
    const h = makeHarness({ mergePassResult: { outcome: 'completed', reasonCode: null, entries: [] } });
    const result = await expectTickCompleted(h.run, h.mergePass);
    const jobRecord = result.status?.jobs[0] ?? h.status.writes[0].jobs[0];
    expect(jobRecord.outcome).toBe('completed');
    expect(jobRecord.reasonCode).toBeNull();
    expect(Object.hasOwn(jobRecord, 'progressed')).toBe(false);
    expect(h.events.events.length).toBeGreaterThanOrEqual(1);
    expect(Object.hasOwn(h.events.events[0], 'progressed')).toBe(false);
  });

  it('completed with one no-action entry exits 0, calls merge pass once, and the tick records completed', async () => {
    const h = makeHarness({ mergePassResult: { outcome: 'completed', reasonCode: null, entries: [noActionEntry()] } });
    const result = await expectTickCompleted(h.run, h.mergePass);
    expect((result.status ?? h.status.writes[0]).jobs[0].outcome).toBe('completed');
  });

  it('budget-exhausted with entries exits 0, calls merge pass once, and records budget-exhausted', async () => {
    const h = makeHarness({
      mergePassResult: { outcome: 'budget-exhausted', reasonCode: null, entries: [noActionEntry()] },
    });
    const result = await expectTickCompleted(h.run, h.mergePass);
    expect((result.status ?? h.status.writes[0]).jobs[0].outcome).toBe('budget-exhausted');
  });

  it('malformed merge-pass result is refused with merge-pass-malformed and no progressed field', async () => {
    for (const result of [null, undefined, 'completed', []] as unknown[]) {
      const h = makeHarness({ mergePassResult: result as RunMergePassResult });
      const runResult = await h.run();
      expect(runResult.exitCode).toBe(1);
      const jobRecord = h.status.writes[0].jobs[0];
      expect(jobRecord.outcome).toBe('refused');
      expect(jobRecord.reasonCode).toBe('merge-pass-malformed');
      expect(Object.hasOwn(jobRecord, 'progressed')).toBe(false);
      expect(h.mergePass.requests).toHaveLength(1);
    }
  });

  it('non-array entries on completed merge-pass result records progressed false without throwing', async () => {
    for (const entries of [null, 'x', { length: 3 }] as unknown[]) {
      const h = makeHarness({
        mergePassResult: { outcome: 'completed', reasonCode: null, entries } as unknown as RunMergePassResult,
      });
      const result = await expectTickCompleted(h.run, h.mergePass);
      expect((result.status ?? h.status.writes[0]).jobs[0].outcome).toBe('completed');
    }
  });

  it('throwing getter on merge-pass outcome is caught by the tick and refused as job-failed', async () => {
    const h = makeHarness({ mergePassResult: resultWithThrowingGetter('outcome') });
    const result = await h.run();
    expect(result.exitCode).toBe(1);
    const jobRecord = h.status.writes[0].jobs[0];
    expect(jobRecord.outcome).toBe('refused');
    expect(jobRecord.reasonCode).toBe('job-failed');
    expect(Object.hasOwn(jobRecord, 'progressed')).toBe(false);
  });

  it('throwing getter on merge-pass entries is caught by the tick and refused as job-failed', async () => {
    const h = makeHarness({ mergePassResult: resultWithThrowingGetter('entries') });
    const result = await h.run();
    expect(result.exitCode).toBe(1);
    const jobRecord = h.status.writes[0].jobs[0];
    expect(jobRecord.outcome).toBe('refused');
    expect(jobRecord.reasonCode).toBe('job-failed');
    expect(Object.hasOwn(jobRecord, 'progressed')).toBe(false);
  });

  it('refused status store exits 1 without calling merge pass', async () => {
    const h = makeHarness();
    h.status.throwOnRead = true;
    const result = await h.run();
    expect(result.outcome).toBe('refused');
    expect(result.reasonCode).toBe('status-unreadable');
    expect(result.exitCode).toBe(1);
    expect(result.status).toBeNull();
    expect(result.jobs).toStrictEqual([]);
    expect(h.mergePass.requests).toHaveLength(0);
  });

  it('insufficient remaining budget records budget-exhausted with progressed false without calling merge pass', async () => {
    // The clock reads a moment 1 second before the deadline; the budget keeps a
    // 2-second floor (DAEMON_CALL_MIN_REMAINING_MS), an O(1) date comparison.
    const h = makeHarness({ nowFn: () => '2026-11-01T12:00:44.000Z' });
    const result = await h.run();
    expect(result.exitCode).toBe(0);
    expect(h.mergePass.requests).toHaveLength(0);
    const jobRecord = h.status.writes[0].jobs[0];
    expect(jobRecord.outcome).toBe('budget-exhausted');
    expect(Object.hasOwn(jobRecord, 'progressed')).toBe(false);
  });

  it('omitting optional tick dependencies still runs merge-pass job and exits 0', async () => {
    // No `now`, `sleep`, `chainRefresh`, `chainRefreshMode`, `chainAttention`
    // or `chainSweep`: the system clock and `defaultSleep` back the tick, and
    // the registry registers only the merge-pass job.
    const mergePass = new FakeMergePass();
    mergePass.result = { outcome: 'completed', reasonCode: null, entries: [noActionEntry()] };
    const status = new FakeStatus();
    const useCase = new RunDaemonTickUseCase({ isProxy: types.isProxy,
      pause: new FakePause(),
      halt: new FakeHalt(),
      status,
      lease: new FakeLease(),
      events: new FakeEvents(),
      queue: new FakeQueue(),
      forge: new FakeForge(),
      journal: new FakeJournal(),
      mergePass,
      newUlid: () => '0' + '2'.repeat(25),
    });
    const result = await useCase.runTick({
      tickId: TICK_A,
      repositories: [repoRef(DIGEST_A)],
      forgeReachable: true,
    });
    expect(result.outcome).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(mergePass.requests).toHaveLength(1);
    expect(status.writes[0].jobs[0].outcome).toBe('completed');
    expect(new DaemonJobRegistry({ mergePass }).instances([repoRef(DIGEST_A)])).toHaveLength(1);
  });
});
