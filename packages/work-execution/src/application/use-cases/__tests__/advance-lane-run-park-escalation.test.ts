/**
 * CE1w: a parked `fix-no-progress` run with tracked uncommitted worktree edits
 * escalates once into `fixing` (`commit-pending`). Every refusal stays parked
 * or is a typed `refused`. Stores are the real in-memory adapters; the
 * worktree port is a fake. No runner, no subprocess, no network.
 */

import { describe, expect, it } from 'vitest';

import type { AttemptRecord } from '../../../domain/execution-records.js';
import { LaneRun } from '../../../domain/entities/LaneRun.js';
import type { LaneRunParkReason, LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';
import { PARK_ESCALATION_HISTORY_MAX } from '../../../domain/park-escalation.js';
import { buildLaneRunStepKey } from '../../../domain/lane-run-keys.js';
import {
  laneRunConductEntry,
  laneRunIntentEntry,
  laneRunResultEntry,
  type LaneRunResultReasonCode,
} from '../../../domain/lane-run-step-facts.js';
import type { LaneRunJournalOutcome } from '../../../domain/lane-run-journal.js';
import type { WorktreeInspectionRequest } from '../../ports/out/WorkspacePort.out-port.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { AttemptRepositoryAdapter } from '../../../infrastructure/adapters/AttemptRepositoryAdapter.adapter.js';
import { ExecutionJournalAdapter } from '../../../infrastructure/adapters/ExecutionJournalAdapter.adapter.js';
import { AdvanceLaneRunUseCase } from '../AdvanceLaneRunUseCase.use-case.js';
import type { AdvanceLaneRunDependencies } from '../AdvanceLaneRunUseCase.use-case.js';
import type { AdvanceLaneRunRequest } from '../../ports/in/AdvanceLaneRunPort.in-port.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const NOW = '2026-10-27T10:00:00.000Z';
const LATER = '2026-10-27T10:01:00.000Z';
const LEASE_UNTIL = '2026-10-27T10:05:00.000Z';
const HOLDER = 'driver';
const COMMIT = 'a'.repeat(40);
const HEAD12 = 'a'.repeat(12);
const WORKTREE = '/tmp/opencode/wo-example-1/wt-example-1';
const FIRST_ULID = '01JB0000000000000000000000';

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

const SEAT_PLAN = {
  version: 1 as const,
  'first-pass': [{ id: 'fp-1', model: 'model-example-1', tool: 'opencode' }],
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

const COLLECTED_ARTIFACTS = {
  headCommit: COMMIT,
  commitsSinceBase: [COMMIT],
  collectedArtifactPaths: [],
  notes: 'present' as const,
};

const CONDUCTED_RUNNER = {
  kind: 'opencode' as const,
  remotePort: 4166,
  host: 'lane-alias-example',
  hostName: 'lane-host-example',
  agent: null,
  model: null,
  variant: null,
};

const PARKED_FIX = {
  reason: 'fix-no-progress' as const,
  qualifier: null,
  parkedFrom: 'collecting' as const,
  questionId: null,
  class: 'other' as const,
};

interface Harness {
  readonly runRepo: LaneRunRepositoryAdapter;
  readonly runJournal: LaneRunJournalAdapter;
  readonly attemptRepo: AttemptRepositoryAdapter;
  readonly deps: AdvanceLaneRunDependencies;
}

function attemptFixture(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'attempt-example-1',
    workOrderId: 'wo-example-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: WORKTREE,
    baseCommit: COMMIT,
    state: 'collected',
    outcome: null,
    briefDigest: 'b'.repeat(64),
    briefPackagePath: '.lane/brief-package',
    sessionId: null,
    completionReceipt: null,
    artifacts: COLLECTED_ARTIFACTS,
    seatPlan: SEAT_PLAN,
    seatSelection: SEAT_SELECTION,
    stopReason: 'none',
    runner: CONDUCTED_RUNNER,
    createdAtIso: NOW,
    updatedAtIso: NOW,
    ...overrides,
  };
}

function runRecord(overrides: Record<string, unknown> = {}): LaneRunRecord {
  const result = LaneRun.create({ ...BASE_RECORD, ...overrides });
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error('fixture must be a valid LaneRun record');
  }
  return result.value.toRecord();
}

function makeUlidMinter(): () => string {
  let next = 0;
  return () => {
    const id = '01JB00000000000000000000' + String(next).padStart(2, '0');
    next += 1;
    return id;
  };
}

function parkKey(round: number, seatIndex: number): string {
  const built = buildLaneRunStepKey({
    runId: RUN_ID,
    round,
    step: 'park',
    seatIndex,
    attemptOrdinal: null,
    head12: null,
    retry: null,
  });
  expect(built.ok).toBe(true);
  if (!built.ok) {
    throw new Error('fixture must build a park key');
  }
  return built.key;
}

function gateKey(round: number): string {
  const built = buildLaneRunStepKey({
    runId: RUN_ID,
    round,
    step: 'gate',
    seatIndex: 0,
    attemptOrdinal: null,
    head12: HEAD12,
    retry: null,
  });
  expect(built.ok).toBe(true);
  if (!built.ok) {
    throw new Error('fixture must build a gate key');
  }
  return built.key;
}

async function makeHarness(record: LaneRunRecord, attempts: readonly AttemptRecord[]): Promise<Harness> {
  const runRepo = new LaneRunRepositoryAdapter();
  const runJournal = new LaneRunJournalAdapter();
  const attemptRepo = new AttemptRepositoryAdapter();
  const executionJournal = new ExecutionJournalAdapter();
  const created = await runRepo.create(record);
  expect(created.outcome).toBe('saved');
  const leased = await runRepo.acquireLease(record.runId, {
    holderId: HOLDER,
    observedFence: 0,
    leaseUntilIso: LEASE_UNTIL,
    nowIso: NOW,
  });
  expect(leased.outcome).toBe('saved');
  for (const attempt of attempts) {
    await attemptRepo.saveAttempt(attempt);
  }
  const deps: AdvanceLaneRunDependencies = {
    runRepo,
    runJournal,
    attemptRepo,
    executionJournal,
    artifactPort: {
      readBriefFile: async () => null,
      readBriefManifest: async () => null,
      verifyArtifactManifest: async () => ({ outcome: 'missing' }),
      readChangedPaths: async () => [],
    },
    reconcileAttempt: {
      reconcileAttempt: async () => ({ outcome: 'refused', reason: 'unused' }),
    },
    admission: {
      admit: async () => ({ outcome: 'admitted' }),
    },
    newUlid: makeUlidMinter(),
  };
  return { runRepo, runJournal, attemptRepo, deps };
}

interface ParkedOptions {
  /** 0, 1 or 2. Round 1 needs two attempts; round 2 needs three. */
  readonly round?: number;
  readonly reason?: LaneRunParkReason;
  /** When false, the latest attempt has no recorded host. */
  readonly withHost?: boolean;
  /** When false, the run is not parked and the journal conducts `journalState`. */
  readonly parked?: boolean;
  readonly journalState?: LaneRunStateValue;
}

/** A leased run whose journal state matches its park, ready for one advance. */
async function parkedHarness(options: ParkedOptions = {}): Promise<Harness> {
  const round = options.round ?? 0;
  const parked = options.parked !== false;
  const count = round + 1;
  const ids = Array.from({ length: count }, (_unused, index) => 'attempt-example-' + String(index + 1));
  const attempts = ids.map((id, index) => attemptFixture({
    id,
    kind: index === 0 ? 'initial' : 'fix',
    fixNumber: index,
    priorAttemptId: index === 0 ? null : ids[index - 1] ?? null,
    runner: index === ids.length - 1 && options.withHost !== false ? CONDUCTED_RUNNER : null,
    seatSelection: { ...SEAT_SELECTION, role: index === 0 ? 'first-pass' : 'fix', seatId: index === 0 ? 'fp-1' : 'fx-1' },
  }));
  const record = runRecord({
    round,
    attemptIds: ids,
    parkCount: parked ? 1 : 0,
    parked: parked ? { ...PARKED_FIX, reason: options.reason ?? 'fix-no-progress' } : null,
  });
  const harness = await makeHarness(record, attempts);
  await conduct(harness, parked ? 'parked' : (options.journalState ?? 'fixing'));
  return harness;
}

function advance(deps: AdvanceLaneRunDependencies, overrides: Partial<AdvanceLaneRunRequest> = {}) {
  return new AdvanceLaneRunUseCase(deps).advanceLaneRun({
    runId: RUN_ID,
    lease: { holderId: HOLDER, fence: 1 },
    halted: false,
    nowIso: LATER,
    ...overrides,
  });
}

async function conduct(harness: Harness, state: LaneRunStateValue): Promise<void> {
  const appended = await harness.runJournal.append(laneRunConductEntry(harness.deps.newUlid(), RUN_ID, state, NOW));
  expect(appended.outcome).toBe('appended');
}

async function appendIntent(harness: Harness, key: string): Promise<void> {
  const appended = await harness.runJournal.append(laneRunIntentEntry(harness.deps.newUlid(), RUN_ID, key, null, NOW));
  expect(appended.outcome).toBe('appended');
}

async function appendResult(
  harness: Harness,
  key: string,
  outcome: LaneRunJournalOutcome,
  reasonCode: LaneRunResultReasonCode,
  detail: string | null = null,
): Promise<void> {
  const appended = await harness.runJournal.append(
    laneRunResultEntry(harness.deps.newUlid(), RUN_ID, key, outcome, reasonCode, NOW, detail),
  );
  expect(appended.outcome).toBe('appended');
}

/** One dirty tracked path: the fact that justifies an escalation. */
function dirtyInspection(): { readonly uncommittedPaths: readonly string[]; readonly untrackedPaths: readonly string[] } {
  return { uncommittedPaths: ['src/a.ts'], untrackedPaths: [] };
}

interface WiredInspect {
  readonly deps: AdvanceLaneRunDependencies;
  readonly calls: WorktreeInspectionRequest[];
}

function withInspect(
  harness: Harness,
  inspect: (request: WorktreeInspectionRequest) => unknown,
): WiredInspect {
  const calls: WorktreeInspectionRequest[] = [];
  return {
    calls,
    deps: {
      ...harness.deps,
      worktreeInspect: {
        inspectWorktree: async (request) => {
          calls.push(request);
          return await inspect(request) as never;
        },
      },
    },
  };
}

/**
 * The advance's first `listForRun` builds facts. Later reads are the
 * escalation history, so a hostile history still leaves a real parked run.
 * The rest of `deps` (including a wired `worktreeInspect`) is kept: only
 * the journal read is replaced.
 */
function withHistory(deps: AdvanceLaneRunDependencies, historyOf: () => unknown): AdvanceLaneRunDependencies {
  let reads = 0;
  const runJournal = new Proxy(deps.runJournal, {
    get(target, property, receiver) {
      if (property === 'listForRun') {
        return async (runId: string) => {
          reads += 1;
          if (reads > 1) {
            return historyOf() as readonly unknown[];
          }
          return target.listForRun(runId);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...deps, runJournal };
}

function withParkClass(harness: Harness, parkClass: unknown): AdvanceLaneRunDependencies {
  const runRepo = new Proxy(harness.runRepo, {
    get(target, property, receiver) {
      if (property === 'get') {
        return async (runId: string) => {
          const record = await target.get(runId);
          if (record === null || record.parked === null) {
            return record;
          }
          return { ...record, parked: { ...record.parked, class: parkClass } };
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...harness.deps, runRepo };
}

async function escalationResults(harness: Harness) {
  const entries = await harness.runJournal.listForRun(RUN_ID);
  return entries.filter((entry) => entry.kind === 'result' && entry.reasonCode === 'park-escalated');
}

async function parkIntents(harness: Harness) {
  const entries = await harness.runJournal.listForRun(RUN_ID);
  return entries.filter((entry) => entry.kind === 'intent' && entry.key !== null && entry.key.includes('/park/'));
}

describe('park escalation from a fix-no-progress park', () => {
  it('is idempotent: a replayed tick or second fix-no-progress park never escalates twice', async () => {
    // Round 1 still escalates (the bound is round >= 2, not every fix round).
    const harness = await parkedHarness({ round: 1 });
    const wired = withInspect(harness, () => dirtyInspection());
    const first = await advance(wired.deps);
    expect(first).toEqual({ outcome: 'entered', state: 'fixing' });
    expect(wired.calls).toEqual([{
      worktreePath: WORKTREE,
      baseCommit: COMMIT,
      expectedArtifactPaths: [],
      recordedHost: CONDUCTED_RUNNER,
    }]);
    const escalated = await harness.runRepo.get(RUN_ID);
    expect(escalated?.parked).toBeNull();
    expect(await escalationResults(harness)).toEqual([
      expect.objectContaining({ outcome: 'completed', reasonCode: 'park-escalated', detail: 'commit-pending' }),
    ]);
    expect(await parkIntents(harness)).toHaveLength(1);

    // A second park of the same run uses a new park ordinal, so the one-way
    // key would not collide. The journal marker is what keeps it parked.
    expect(escalated).not.toBeNull();
    if (escalated === null) {
      throw new Error('escalated run missing');
    }
    const reparked = await harness.runRepo.save({
      ...escalated,
      parked: PARKED_FIX,
      parkCount: escalated.parkCount + 1,
      revision: escalated.revision + 1,
    }, { holderId: HOLDER, fence: 1, nowIso: LATER });
    expect(reparked.outcome).toBe('saved');
    await conduct(harness, 'parked');
    const second = await advance(withInspect(harness, () => dirtyInspection()).deps);
    expect(second).toEqual({ outcome: 'waiting', reason: 'parked' });
    expect(await escalationResults(harness)).toHaveLength(1);
    expect(await parkIntents(harness)).toHaveLength(1);
    expect((await harness.runRepo.get(RUN_ID))?.parked?.reason).toBe('fix-no-progress');

    // A replayed tick of a park whose journal already records the escalation
    // stays parked and does not append another intent (the same key would
    // otherwise be refused as a duplicate).
    const replay = await parkedHarness({ round: 1 });
    const key = parkKey(1, 1);
    await appendIntent(replay, key);
    await appendResult(replay, key, 'completed', 'park-escalated', 'commit-pending');
    const replayed = await advance(withInspect(replay, () => dirtyInspection()).deps);
    expect(replayed).toEqual({ outcome: 'waiting', reason: 'parked' });
    const again = await advance(withInspect(replay, () => dirtyInspection()).deps);
    expect(again).toEqual({ outcome: 'waiting', reason: 'parked' });
    expect(await escalationResults(replay)).toHaveLength(1);
    expect(await parkIntents(replay)).toHaveLength(1);
    expect((await replay.runRepo.get(RUN_ID))?.parked?.reason).toBe('fix-no-progress');
  });

  it('stays parked when the run round is already 2 or higher', async () => {
    // The bound is O(1) and runs before the worktree read, so a dirty tree
    // at round 2 is never inspected and never escalated.
    const harness = await parkedHarness({ round: 2 });
    const wired = withInspect(harness, () => dirtyInspection());
    expect(await advance(wired.deps)).toEqual({ outcome: 'waiting', reason: 'parked' });
    expect(wired.calls).toEqual([]);
    expect((await harness.runRepo.get(RUN_ID))?.parked?.reason).toBe('fix-no-progress');
    expect(await escalationResults(harness)).toEqual([]);
    expect(await parkIntents(harness)).toEqual([]);
  });

  it('stays parked when the advance is halted', async () => {
    const harness = await parkedHarness({ round: 1 });
    const wired = withInspect(harness, () => dirtyInspection());
    expect(await advance(wired.deps, { halted: true })).toEqual({ outcome: 'waiting', reason: 'parked' });
    expect(wired.calls).toEqual([]);
    expect((await harness.runRepo.get(RUN_ID))?.parked).not.toBeNull();
    expect(await parkIntents(harness)).toEqual([]);
  });

  it('stays parked when an ambiguous intent is still pending', async () => {
    const harness = await parkedHarness({ round: 0 });
    await appendIntent(harness, gateKey(0));
    await appendResult(harness, gateKey(0), 'ambiguous', 'gate-unknown');
    const wired = withInspect(harness, () => dirtyInspection());
    expect(await advance(wired.deps)).toEqual({ outcome: 'waiting', reason: 'parked' });
    expect(wired.calls).toEqual([]);
    expect(await parkIntents(harness)).toEqual([]);
    expect((await harness.runRepo.get(RUN_ID))?.parked?.reason).toBe('fix-no-progress');
  });

  it('stays parked when run journal history is malformed', async () => {
    const harness = await parkedHarness({ round: 1 });
    class HostileHistory extends Array {}
    const subclassed = new HostileHistory(1);
    subclassed[0] = { reasonCode: 'gate-failed', detail: null };
    const deps = withHistory(withInspect(harness, () => dirtyInspection()).deps, () => subclassed);
    expect(await advance(deps)).toEqual({ outcome: 'waiting', reason: 'parked' });
    expect((await harness.runRepo.get(RUN_ID))?.parked?.reason).toBe('fix-no-progress');
    expect(await escalationResults(harness)).toEqual([]);
  });

  it('stays parked when run journal history exceeds PARK_ESCALATION_HISTORY_MAX', async () => {
    const harness = await parkedHarness({ round: 1 });
    const oversized = Array.from({ length: PARK_ESCALATION_HISTORY_MAX + 1 }, () => ({
      reasonCode: 'gate-failed',
      detail: null,
    }));
    const deps = withHistory(withInspect(harness, () => dirtyInspection()).deps, () => oversized);
    expect(await advance(deps)).toEqual({ outcome: 'waiting', reason: 'parked' });
    expect((await harness.runRepo.get(RUN_ID))?.parked).not.toBeNull();
    expect(await escalationResults(harness)).toEqual([]);
  });

  it('stays parked on a throwing history Proxy', async () => {
    const harness = await parkedHarness({ round: 1 });
    const throwingProxy = new Proxy([{ reasonCode: 'gate-failed', detail: null }], {
      get() {
        throw new Error('boom');
      },
    });
    const deps = withHistory(withInspect(harness, () => dirtyInspection()).deps, () => throwingProxy);
    expect(await advance(deps)).toEqual({ outcome: 'waiting', reason: 'parked' });
    expect((await harness.runRepo.get(RUN_ID))?.parked?.reason).toBe('fix-no-progress');
    expect(await parkIntents(harness)).toEqual([]);
  });

  it('stays parked when parked.class is an unknown park class', async () => {
    const harness = await parkedHarness({ round: 1 });
    const deps = withInspect(harness, () => dirtyInspection()).deps;
    const poisoned = withParkClass({ ...harness, deps }, 'XYZZY');
    expect(await advance(poisoned)).toEqual({ outcome: 'waiting', reason: 'parked' });
    expect((await harness.runRepo.get(RUN_ID))?.parked?.reason).toBe('fix-no-progress');
    expect(await escalationResults(harness)).toEqual([]);
  });

  it('stays parked for non-escalatable park reasons', async () => {
    for (const reason of ['blocker-after-round-2', 'one-way-door'] as const) {
      const harness = await parkedHarness({ round: 0, reason });
      const wired = withInspect(harness, () => dirtyInspection());
      expect(await advance(wired.deps)).toEqual({ outcome: 'waiting', reason: 'parked' });
      expect((await harness.runRepo.get(RUN_ID))?.parked?.reason).toBe(reason);
      expect(await escalationResults(harness)).toEqual([]);
    }
  });

  it('stays parked when worktreeInspect is unwired or attempt has no recorded host', async () => {
    const unwired = await parkedHarness({ round: 1 });
    expect(await advance(unwired.deps)).toEqual({ outcome: 'waiting', reason: 'parked' });
    expect((await unwired.runRepo.get(RUN_ID))?.parked?.reason).toBe('fix-no-progress');

    const noHost = await parkedHarness({ round: 1, withHost: false });
    const wired = withInspect(noHost, () => dirtyInspection());
    expect(await advance(wired.deps)).toEqual({ outcome: 'waiting', reason: 'parked' });
    expect(wired.calls).toEqual([]);
    expect((await noHost.runRepo.get(RUN_ID))?.parked?.reason).toBe('fix-no-progress');
    expect(await escalationResults(noHost)).toEqual([]);
  });

  it('stays parked when inspectWorktree throws, times out, or returns non-array uncommittedPaths', async () => {
    const throwing = await parkedHarness({ round: 1 });
    const thrown = withInspect(throwing, () => {
      throw new Error('host unreachable');
    });
    expect(await advance(thrown.deps)).toEqual({ outcome: 'waiting', reason: 'parked' });
    expect(thrown.calls).toHaveLength(1);

    const timedOut = await parkedHarness({ round: 1 });
    const timeout = withInspect(timedOut, () => Promise.reject(new Error('timed out')));
    expect(await advance(timeout.deps)).toEqual({ outcome: 'waiting', reason: 'parked' });
    expect(timeout.calls).toHaveLength(1);

    for (const uncommittedPaths of [null, 'src/a.ts', { length: 1, 0: 'src/a.ts' }]) {
      const harness = await parkedHarness({ round: 1 });
      const wired = withInspect(harness, () => ({ uncommittedPaths, untrackedPaths: [] }));
      expect(await advance(wired.deps)).toEqual({ outcome: 'waiting', reason: 'parked' });
      expect((await harness.runRepo.get(RUN_ID))?.parked?.reason).toBe('fix-no-progress');
    }

    // A throwing getter is never run: the descriptor value is absent, so the
    // fact stays missing and the run stays parked.
    let reads = 0;
    const getterHost = await parkedHarness({ round: 1 });
    const inspection: Record<string, unknown> = { untrackedPaths: [] };
    Object.defineProperty(inspection, 'uncommittedPaths', {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        throw new Error('uncommittedPaths getter');
      },
    });
    const getter = withInspect(getterHost, () => inspection);
    expect(await advance(getter.deps)).toEqual({ outcome: 'waiting', reason: 'parked' });
    expect(reads).toBe(0);
    expect(await escalationResults(getterHost)).toEqual([]);
  });

  it('stays parked when worktree has zero tracked uncommitted files', async () => {
    const harness = await parkedHarness({ round: 1 });
    const wired = withInspect(harness, () => ({ uncommittedPaths: [], untrackedPaths: ['notes.txt'] }));
    expect(await advance(wired.deps)).toEqual({ outcome: 'waiting', reason: 'parked' });
    expect(wired.calls).toHaveLength(1);
    expect((await harness.runRepo.get(RUN_ID))?.parked?.reason).toBe('fix-no-progress');
    expect(await escalationResults(harness)).toEqual([]);
  });

  it('reconciles an interrupted park-escalation intent without escalating twice', async () => {
    // Crash after the park intent, before conduct and the save.
    const open = await parkedHarness({ round: 1 });
    const openKey = parkKey(1, 1);
    await appendIntent(open, openKey);
    expect(await advance(open.deps)).toEqual({ outcome: 'entered', state: 'fixing' });
    const openEntries = await open.runJournal.listForRun(RUN_ID);
    expect(openEntries.filter((entry) => entry.kind === 'intent' && entry.key === openKey)).toHaveLength(1);
    expect(openEntries.filter((entry) => entry.kind === 'result' && entry.key === openKey)).toEqual([
      expect.objectContaining({ outcome: 'reconciled', reasonCode: 'park-escalated', detail: 'commit-pending' }),
    ]);
    expect(openEntries.filter((entry) => entry.kind === 'conduct' && entry.state === 'fixing')).toHaveLength(1);
    expect((await open.runRepo.get(RUN_ID))?.parked).toBeNull();
    await advance(open.deps);
    const afterSecond = await open.runJournal.listForRun(RUN_ID);
    expect(afterSecond.filter((entry) => entry.kind === 'intent' && entry.key === openKey)).toHaveLength(1);
    expect(afterSecond.filter((entry) => entry.reasonCode === 'park-escalated')).toHaveLength(1);

    // Park repair already cleared the park and wrote `fixing`. The next tick
    // appends the result only: no second intent, no second conduct, no save.
    const cleared = await parkedHarness({ parked: false, journalState: 'fixing' });
    const before = await cleared.runRepo.get(RUN_ID);
    const clearedKey = parkKey(0, 0);
    await appendIntent(cleared, clearedKey);
    expect(await advance(cleared.deps)).toEqual({ outcome: 'entered', state: 'fixing' });
    const clearedEntries = await cleared.runJournal.listForRun(RUN_ID);
    expect(clearedEntries.filter((entry) => entry.kind === 'intent' && entry.key === clearedKey)).toHaveLength(1);
    expect(clearedEntries.filter((entry) => entry.kind === 'conduct' && entry.state === 'fixing')).toHaveLength(1);
    expect(clearedEntries.filter((entry) => entry.kind === 'result' && entry.key === clearedKey)).toEqual([
      expect.objectContaining({ outcome: 'reconciled', reasonCode: 'park-escalated', detail: 'commit-pending' }),
    ]);
    expect((await cleared.runRepo.get(RUN_ID))?.revision).toBe(before?.revision);
  });

  it('returns journal-refused or save-refused when persistence refuses', async () => {
    const journal = await parkedHarness({ round: 1 });
    (journal.deps as { newUlid: () => string }).newUlid = () => FIRST_ULID;
    const journalResult = await advance(withInspect(journal, () => dirtyInspection()).deps);
    expect(journalResult).toMatchObject({
      outcome: 'refused',
      reason: 'journal-refused',
      journalRefusal: 'duplicate-entry-id',
    });
    expect((await journal.runRepo.get(RUN_ID))?.parked?.reason).toBe('fix-no-progress');
    expect(await escalationResults(journal)).toEqual([]);

    const saving = await parkedHarness({ round: 1 });
    const wired = withInspect(saving, async () => {
      const current = await saving.runRepo.get(RUN_ID);
      expect(current).not.toBeNull();
      if (current === null) {
        throw new Error('run missing');
      }
      const bumped = await saving.runRepo.save({
        ...current,
        revision: current.revision + 1,
      }, { holderId: HOLDER, fence: 1, nowIso: LATER });
      expect(bumped.outcome).toBe('saved');
      return dirtyInspection();
    });
    expect(await advance(wired.deps)).toEqual({ outcome: 'refused', reason: 'save-refused' });
    expect((await saving.runRepo.get(RUN_ID))?.parked?.reason).toBe('fix-no-progress');
    expect(await escalationResults(saving)).toEqual([]);
  });
});
