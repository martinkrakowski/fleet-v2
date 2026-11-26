// FY03: the remaining `head-advanced` test gaps after FX06.
/**
 * Three gaps the FX06 review left open, closed here without touching any
 * production file or the FX06 test files (fixtures are copied, never
 * imported):
 *
 * 1. `applyPendingResume`'s `head-advanced` detail: on a run parked
 *    `fix-no-progress` whose worktree is clean but whose checked-out HEAD
 *    moved past the attempt's collected head commit, the apply stays parked,
 *    leaves the record untouched for the operator, and journals the resume
 *    result row `refused` / `fix-no-progress` with `detail: 'head-advanced'`.
 * 2. The dirty-worktree rule's precedence over `head-advanced`: non-empty
 *    `uncommittedPaths` AND a moved HEAD escalates (the fact proves the work,
 *    the head fact only names a clean-worktree park).
 * 3. `tryEscalatePark`'s `STAY_PARKED` contract: a stay-parked decision
 *    returns `{ outcome: 'waiting', reason: 'parked' }` with zero store saves
 *    and zero journal appends, while a dirty round-1 worktree still escalates
 *    (so an always-stay-parked implementation fails) and an existing
 *    escalation is never duplicated.
 * 4. The advance path for a malformed or missing `checkedOutCommit`: the
 *    head fact reads as absent (unknown, never clean), so with non-empty
 *    `uncommittedPaths` the dirty rule wins and `tryEscalatePark` escalates
 *    — the unreadable head can never park the run as `head-advanced`.
 * 5. Own `constructor` / `prototype` keys on the INSPECTION RECORD itself:
 *    the shared snapshot copies unknown data keys by design, so they are
 *    inert and never reach the decision record (whose typed refusal for
 *    those keys is pinned separately below).
 *
 * Hostile inputs (O(1) or bounded O(cap), cap = 4096 for path lists): every
 * refusal below is the merged code's typed refusal — `fix-no-progress` on the
 * resume side, `STAY_PARKED` or `undefined` on the advance side — never an
 * escalation and never an unhandled throw. Cost: each check is an O(1) shape
 * gate plus one bounded `readBoundedDenseArray` walk of at most 4096 entries;
 * no unbounded hostile input is ever iterated and no getter ever runs.
 */

import { describe, expect, it } from 'vitest';

import type { AttemptRecord } from '../../../domain/execution-records.js';
import { LaneRun } from '../../../domain/entities/LaneRun.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import type { LaneRunJournalOutcome } from '../../../domain/lane-run-journal.js';
import { buildLaneRunStepKey } from '../../../domain/lane-run-keys.js';
import type { LaneRunParkRecord, LaneRunRecord } from '../../../domain/lane-run-records.js';
import { laneRunConductEntry, laneRunIntentEntry, laneRunResultEntry } from '../../../domain/lane-run-step-facts.js';
import type { LaneRunResultReasonCode } from '../../../domain/lane-run-step-facts.js';
import { checkParkEscalation } from '../../../domain/lane-run-transitions.js';
import { decideParkEscalation } from '../../../domain/park-escalation.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import { AttemptRepositoryAdapter } from '../../../infrastructure/adapters/AttemptRepositoryAdapter.adapter.js';
import { ExecutionJournalAdapter } from '../../../infrastructure/adapters/ExecutionJournalAdapter.adapter.js';
import type { AdvanceLaneRunDependencies } from '../AdvanceLaneRunUseCase.use-case.js';
import type { AdvanceLaneRunRequest } from '../../ports/in/AdvanceLaneRunPort.in-port.js';
import type { WorktreeInspection, WorktreeInspectionRequest, WorkspacePort } from '../../ports/out/WorkspacePort.out-port.js';
import { ResumeLaneRunUseCase } from '../ResumeLaneRunUseCase.use-case.js';
import type { AdvanceStepContext, GatheredLaneRunFacts } from '../advance-lane-run/step-context.js';
import { dirtyWorktreeFactOf, tryEscalatePark } from '../advance-lane-run/step-context.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const NOW = '2026-10-27T10:00:00.000Z';
const LATER = '2026-10-27T10:05:00.000Z';
const LEASE_UNTIL = '2026-10-27T10:10:00.000Z';
const HOLDER = 'driver-example-1';
const RESUME_CLI_KEY = `${RUN_ID}/park/1/resume@cli`;

/** A second 40-hex head, distinct from the attempt's collected one. */
const MOVED_HEAD = 'c'.repeat(40);

const FIX_PARK: LaneRunParkRecord = {
  reason: 'fix-no-progress',
  qualifier: null,
  parkedFrom: 'collecting',
  questionId: null,
};

// ---------------------------------------------------------------------------
// Resume-side fixtures (copied from resume-lane-run-escalation.test.ts).
// ---------------------------------------------------------------------------

const ATTEMPT_ID = 'attempt-example-1';
const HEAD = '0123456789abcdef0123456789abcdef01234567';
const BASE_COMMIT = 'f'.repeat(40);
const WORKTREE_PATH = '/tmp/opencode/lanes/attempt-example-1';

const RESUME_BASE_RECORD = {
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
  schemaVersion: 1,
};

function resumeRunRecord(overrides: Partial<LaneRunRecord> = {}): LaneRunRecord {
  const result = LaneRun.create({ ...RESUME_BASE_RECORD, ...overrides });
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error('fixture must be a valid LaneRun record');
  }
  return result.value.toRecord();
}

function makeAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: ATTEMPT_ID,
    workOrderId: 'wo-example-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: WORKTREE_PATH,
    baseCommit: BASE_COMMIT,
    state: 'collected',
    outcome: 'done',
    briefDigest: 'digest-1',
    briefPackagePath: null,
    sessionId: 'session-1',
    completionReceipt: null,
    artifacts: {
      headCommit: HEAD,
      commitsSinceBase: [HEAD],
      collectedArtifactPaths: [],
      notes: 'present',
    },
    runner: {
      kind: 'opencode',
      remotePort: 4166,
      host: 'lane-host-1',
      agent: null,
      model: 'nvidia/z-ai/glm-5.3',
      variant: null,
    },
    createdAtIso: NOW,
    updatedAtIso: NOW,
    ...overrides,
  };
}

const DIRTY_INSPECTION: WorktreeInspection = {
  worktreePath: WORKTREE_PATH,
  checkedOutCommit: HEAD,
  matchesBaseCommit: false,
  uncommittedPaths: ['src/changed.ts'],
  untrackedPaths: [],
  residueFromEarlierAttempts: [],
  missingExpectedArtifacts: [],
};

let entryCounter = 0;
/** A unique 26-char ULID-shaped entry id per call (the tests append many entries). */
function nextEntryId(): string {
  entryCounter += 1;
  return `01JB${'0'.repeat(18)}${String(entryCounter).padStart(4, '0')}`;
}

interface EscalationFixture {
  repo: LaneRunRepositoryAdapter;
  journal: LaneRunJournalAdapter;
  resume: ResumeLaneRunUseCase;
  readonly inspectCalls: { count: number };
  readonly attemptReads: { count: number };
}

interface SeedOptions {
  /** The inspection answer (default dirty). Hostile values are passed as cast. */
  inspect?: unknown;
  /** A factory instead of a fixed answer (e.g. a rejecting promise). */
  inspectFactory?: (() => Promise<unknown>) | (() => unknown);
  /** Wire `worktreeInspect` (default true). */
  wireInspect?: boolean;
  /** Wire `attemptRepo` (default true). */
  wireAttempts?: boolean;
  /** The attempt the fake repo returns (default a collected attempt at HEAD). */
  attempt?: AttemptRecord | null;
  /** `findAttemptById` throws. */
  attemptThrows?: boolean;
  /** The stored `attemptIds` (default `[ATTEMPT_ID]`). */
  attemptIds?: readonly string[];
}

async function seededEscalation(options: SeedOptions = {}): Promise<EscalationFixture> {
  const repo = new LaneRunRepositoryAdapter();
  const journal = new LaneRunJournalAdapter();
  const attemptIds = options.attemptIds ?? [ATTEMPT_ID];
  const record = resumeRunRecord({ attemptIds });
  expect(await repo.create(record)).toEqual({ outcome: 'saved', record });
  expect(
    await repo.acquireLease(RUN_ID, {
      holderId: HOLDER,
      observedFence: 0,
      leaseUntilIso: LEASE_UNTIL,
      nowIso: NOW,
    }),
  ).toMatchObject({ outcome: 'saved' });
  expect(
    await repo.save(
      resumeRunRecord({
        parked: FIX_PARK,
        parkCount: 1,
        revision: 2,
        attemptIds,
        lease: { holderId: HOLDER, fence: 1, leaseUntilIso: LEASE_UNTIL },
      }),
      { holderId: HOLDER, fence: 1, nowIso: NOW },
    ),
  ).toMatchObject({ outcome: 'saved' });
  expect(await journal.append(laneRunConductEntry(nextEntryId(), RUN_ID, 'parked', NOW))).toMatchObject({
    outcome: 'appended',
  });

  const attemptReads = { count: 0 };
  const attempt = options.attempt === undefined ? makeAttempt() : options.attempt;
  const attemptRepo = options.wireAttempts === false
    ? undefined
    : {
        findAttemptById: async (_attemptId: string): Promise<AttemptRecord | null> => {
          attemptReads.count += 1;
          if (options.attemptThrows === true) {
            throw new Error('attempt unreadable');
          }
          return attempt === null ? null : attempt;
        },
      };

  const inspectCalls = { count: 0 };
  const worktreeInspect = options.wireInspect === false
    ? undefined
    : {
        inspectWorktree: async (_request: WorktreeInspectionRequest): Promise<unknown> => {
          inspectCalls.count += 1;
          if (options.inspectFactory !== undefined) {
            return await options.inspectFactory();
          }
          return 'inspect' in options ? options.inspect : DIRTY_INSPECTION;
        },
      } as unknown as Pick<WorkspacePort, 'inspectWorktree'>;

  const resume = new ResumeLaneRunUseCase({
    runRepo: repo,
    runJournal: journal,
    newUlid: nextEntryId,
    attemptRepo,
    worktreeInspect,
  });
  return { repo, journal, resume, inspectCalls, attemptReads };
}

function apply(fx: EscalationFixture, overrides: Record<string, unknown> = {}): ReturnType<ResumeLaneRunUseCase['applyPendingResume']> {
  return fx.resume.applyPendingResume({
    runId: RUN_ID,
    lease: { holderId: HOLDER, fence: 1 },
    nowIso: LATER,
    ...overrides,
  } as never);
}

/** A pending resume intent recorded directly, for apply-side tests. */
async function seedPendingResume(fx: EscalationFixture): Promise<void> {
  const appended = await fx.journal.append({
    ...laneRunIntentEntry(nextEntryId(), RUN_ID, RESUME_CLI_KEY, null, NOW),
    expectedRevision: 2,
  } as LaneRunJournalEntryRecord);
  if (appended.outcome !== 'appended') {
    throw new Error(`seedPendingResume refused: ${JSON.stringify(appended)}`);
  }
}

async function entriesForRun(fx: EscalationFixture): Promise<readonly LaneRunJournalEntryRecord[]> {
  return fx.journal.listForRun(RUN_ID);
}

/** Every escalation marker the journal carries (a conduct into `fixing` with the `commit-pending` mode). */
async function escalationMarkers(fx: EscalationFixture): Promise<readonly LaneRunJournalEntryRecord[]> {
  const entries = await entriesForRun(fx);
  return entries.filter((entry) => entry.kind === 'conduct' && entry.state === 'fixing' && entry.mode === 'commit-pending');
}

// ---------------------------------------------------------------------------
// Advance-side fixtures (copied from advance-lane-run-park-escalation.test.ts).
// ---------------------------------------------------------------------------

const COMMIT = 'a'.repeat(40);
const WORKTREE = '/tmp/opencode/wo-example-1/wt-example-1';

const ADVANCE_BASE_RECORD = {
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

function advanceRunRecord(overrides: Record<string, unknown> = {}): LaneRunRecord {
  const result = LaneRun.create({ ...ADVANCE_BASE_RECORD, ...overrides });
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
  /** When false, the latest attempt has no recorded host. */
  readonly withHost?: boolean;
}

/** A leased parked run whose journal state matches its park, ready for one escalation. */
async function parkedHarness(options: ParkedOptions = {}): Promise<Harness> {
  const round = options.round ?? 0;
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
  const record = advanceRunRecord({
    round,
    attemptIds: ids,
    parkCount: 1,
    parked: PARKED_FIX,
  });
  const harness = await makeHarness(record, attempts);
  const appended = await harness.runJournal.append(
    laneRunConductEntry(harness.deps.newUlid(), RUN_ID, 'parked', NOW),
  );
  expect(appended.outcome).toBe('appended');
  return harness;
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

/** Save/append counters around the real adapters, so zero-write refusals are proven on the ports. */
interface WriteCounters {
  readonly saves: number;
  readonly appends: number;
}

function withWriteCounters(deps: AdvanceLaneRunDependencies): { readonly deps: AdvanceLaneRunDependencies; readonly counters: () => WriteCounters } {
  const state = { saves: 0, appends: 0 };
  const runRepo = new Proxy(deps.runRepo, {
    get(target, property, receiver) {
      if (property === 'save') {
        return async (record: LaneRunRecord, lease: never) => {
          state.saves += 1;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (target as any).save(record, lease);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  const runJournal = new Proxy(deps.runJournal, {
    get(target, property, receiver) {
      if (property === 'append') {
        return async (entry: LaneRunJournalEntryRecord) => {
          state.appends += 1;
          return target.append(entry);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { deps: { ...deps, runRepo, runJournal }, counters: () => ({ saves: state.saves, appends: state.appends }) };
}

async function escalationResults(harness: Harness) {
  const entries = await harness.runJournal.listForRun(RUN_ID);
  return entries.filter((entry) => entry.kind === 'result' && entry.reasonCode === 'park-escalated');
}

/**
 * A direct `tryEscalatePark` call: only the facts `tryEscalatePark` reads are
 * provided (state, stopMode, pendingIntent, latest attempt) and cast to the
 * gathered shape; everything else flows through the real adapters in `deps`.
 */
function tryEscalateDirectly(
  deps: AdvanceLaneRunDependencies,
  record: LaneRunRecord,
  latestAttempt: AttemptRecord | null,
  overrides: Partial<AdvanceLaneRunRequest> = {},
): ReturnType<typeof tryEscalatePark> {
  const ctx = { deps } as AdvanceStepContext;
  const gathered = {
    facts: { state: 'parked', halted: false, stopMode: null, pendingIntent: null },
    deadlineUnknown: false,
    latestAttempt,
    attemptRecords: [],
  } as unknown as GatheredLaneRunFacts;
  return tryEscalatePark(ctx, record, gathered, {
    runId: RUN_ID,
    lease: { holderId: HOLDER, fence: 1 },
    halted: false,
    nowIso: LATER,
    ...overrides,
  });
}

describe('applyPendingResume head-advanced (FY03 gap 1)', () => {
  it('stays parked with detail head-advanced on a clean worktree whose HEAD moved past the collected head commit', async () => {
    // CE2: the apply-side counterpart of the request-side pin. The worktree
    // is clean but the checked-out HEAD differs from the attempt's collected
    // headCommit, so the escalation stays parked as `head-advanced`, the
    // result row carries the precise detail, and the record is left parked
    // for the operator.
    const fx = await seededEscalation({
      inspect: { ...DIRTY_INSPECTION, uncommittedPaths: [], checkedOutCommit: MOVED_HEAD },
    });
    await seedPendingResume(fx);

    expect(await apply(fx)).toStrictEqual({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'head-advanced' });

    // The park stays intact for the operator: no save, no unpark.
    const record = await fx.repo.get(RUN_ID);
    expect(record?.parked).toStrictEqual(FIX_PARK);
    expect(record?.revision).toBe(2);

    // The exact journal row, and the exact row count for the key: one intent
    // plus one refused result with the `head-advanced` detail.
    const rows = await fx.journal.listForKey(RESUME_CLI_KEY);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      kind: 'result',
      key: RESUME_CLI_KEY,
      runId: RUN_ID,
      outcome: 'refused',
      reasonCode: 'fix-no-progress',
      detail: 'head-advanced',
    });
    // No escalation conduct marker was ever written.
    expect(await escalationMarkers(fx)).toEqual([]);
  });

  it('stays parked with head-advanced without running a getter on checkedOutCommit', async () => {
    let getterRuns = 0;
    const getterBacked: Record<string, unknown> = { ...DIRTY_INSPECTION, uncommittedPaths: [] };
    Reflect.deleteProperty(getterBacked, 'checkedOutCommit');
    Object.defineProperty(getterBacked, 'checkedOutCommit', {
      enumerable: true,
      get: () => {
        getterRuns += 1;
        return MOVED_HEAD;
      },
    });
    const fx = await seededEscalation({ inspect: getterBacked });
    await seedPendingResume(fx);
    // The snapshot refuses any accessor, so the getter-backed head reads
    // unreadable (fact null) and the plain `fix-no-progress` refusal fires.
    expect(await apply(fx)).toStrictEqual({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'fix-no-progress' });
    expect(getterRuns).toBe(0);
    expect((await fx.repo.get(RUN_ID))?.parked).toStrictEqual(FIX_PARK);
    expect(await escalationMarkers(fx)).toEqual([]);
  });

  it('escalates under the dirty-worktree rule when paths are non-empty AND the head moved (precedence pinned by this test)', async () => {
    // The winning rule is the dirty-worktree rule: `decideParkEscalation`
    // checks `trackedFilesChanged` before the clean-worktree head facts, so a
    // dirty worktree with a moved HEAD escalates into `fixing` — the head
    // fact only renames a CLEAN-worktree park. This test pins that
    // precedence; an implementation that refuses (or parks) on the moved
    // head, ignoring the uncommitted work, fails it.
    const fx = await seededEscalation({
      inspect: { ...DIRTY_INSPECTION, uncommittedPaths: ['src/changed.ts'], checkedOutCommit: MOVED_HEAD },
    });
    await seedPendingResume(fx);

    expect(await apply(fx)).toStrictEqual({ outcome: 'resumed', to: 'fixing', key: RESUME_CLI_KEY });

    const record = await fx.repo.get(RUN_ID);
    expect(record?.parked).toBeNull();
    expect(record?.revision).toBe(3);
    const entries = await entriesForRun(fx);
    expect(entries).toContainEqual(
      expect.objectContaining({ kind: 'conduct', state: 'fixing', mode: 'commit-pending' }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'result',
        key: RESUME_CLI_KEY,
        outcome: 'completed',
        reasonCode: 'park-escalated',
        detail: 'commit-pending',
      }),
    );
  });

  it('refuses a malformed checkedOutCommit as fix-no-progress while uncommittedPaths is non-empty (a accepted malformed head would escalate)', async () => {
    // Correction 1: every malformed-head case keeps a NON-EMPTY
    // `uncommittedPaths`, so a malformed head that was accepted would change
    // the outcome (escalate). The merged code refuses the whole fact in O(1)
    // (`LANE_HEAD_SHA_PATTERN`) and answers the plain `fix-no-progress`
    // refusal — never a clean-worktree park and never an escalation.
    for (const checkedOutCommit of ['not-a-sha', HEAD.slice(0, 12), MOVED_HEAD.toUpperCase(), null, 7]) {
      const fx = await seededEscalation({
        inspect: { ...DIRTY_INSPECTION, uncommittedPaths: ['src/changed.ts'], checkedOutCommit },
      });
      await seedPendingResume(fx);
      expect(await apply(fx), String(checkedOutCommit)).toStrictEqual({
        outcome: 'refused',
        key: RESUME_CLI_KEY,
        reason: 'fix-no-progress',
      });
      // The refusal is a result row with a null detail, never an escalation.
      const rows = await fx.journal.listForKey(RESUME_CLI_KEY);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({
        kind: 'result',
        outcome: 'refused',
        reasonCode: 'fix-no-progress',
        detail: null,
      });
      expect((await fx.repo.get(RUN_ID))?.parked).toStrictEqual(FIX_PARK);
      expect(await escalationMarkers(fx)).toEqual([]);
    }

    // A missing checkedOutCommit is refused the same way.
    const missing = { ...DIRTY_INSPECTION };
    Reflect.deleteProperty(missing as unknown as Record<string, unknown>, 'checkedOutCommit');
    const fx = await seededEscalation({ inspect: missing });
    await seedPendingResume(fx);
    expect(await apply(fx)).toStrictEqual({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'fix-no-progress' });
    expect(await escalationMarkers(fx)).toEqual([]);
  });

  it('refuses prototype-polluting own keys with the typed refusal', async () => {
    // An own `__proto__` key on the INSPECTION RECORD itself is refused by
    // the shared snapshot (`__proto__` can never be copied), so the fact is
    // unreadable and the apply refuses `fix-no-progress` — with non-empty
    // paths, a lenient snapshot that copied the key would have escalated.
    const protoPoisoned: Record<string, unknown> = { ...DIRTY_INSPECTION };
    Object.defineProperty(protoPoisoned, '__proto__', { enumerable: true, value: { polluted: true } });
    const fx = await seededEscalation({ inspect: protoPoisoned });
    await seedPendingResume(fx);
    expect(await apply(fx)).toStrictEqual({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'fix-no-progress' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(await escalationMarkers(fx)).toEqual([]);

    // Correction 2 on the INSPECTION RECORD itself: own `constructor` and
    // `prototype` keys there are NOT refused the way an own `__proto__` key
    // is — the merged snapshot copies unknown data keys by design, and the
    // fact reader builds the fact from named fields only, so the poison
    // keys are inert and never reach the decision record (whose typed
    // refusal for these keys is pinned below, on the decision fact). The
    // case stays outcome-changing: with non-empty paths and a moved head, a
    // snapshot that refused these keys like `__proto__` would answer the
    // plain `fix-no-progress` refusal here instead of the dirty-rule
    // escalation this test asserts, and no global pollution happens either
    // way.
    for (const poisonKey of ['constructor', 'prototype']) {
      const poisoned: Record<string, unknown> = { ...DIRTY_INSPECTION, checkedOutCommit: MOVED_HEAD };
      Object.defineProperty(poisoned, poisonKey, { enumerable: true, value: 'poison' });
      const poisonFx = await seededEscalation({ inspect: poisoned });
      await seedPendingResume(poisonFx);
      expect(await apply(poisonFx), poisonKey).toStrictEqual({
        outcome: 'resumed',
        to: 'fixing',
        key: RESUME_CLI_KEY,
      });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect((await poisonFx.repo.get(RUN_ID))?.parked).toBeNull();
      expect(await escalationMarkers(poisonFx)).not.toEqual([]);
    }

    // Advance side: the descriptor-based fact read ignores the extra keys
    // too, so the fact keeps its exact shape (the poison is inert there as
    // well) instead of reading the fact as unreadable.
    for (const poisonKey of ['constructor', 'prototype']) {
      const advancePoisoned: Record<string, unknown> = {
        uncommittedPaths: ['src/a.ts'],
        untrackedPaths: [],
        checkedOutCommit: MOVED_HEAD,
      };
      Object.defineProperty(advancePoisoned, poisonKey, { enumerable: true, value: 'poison' });
      expect(
        await dirtyWorktreeFactOf(
          {
            deps: { worktreeInspect: { inspectWorktree: async () => advancePoisoned } },
          } as unknown as AdvanceStepContext,
          attemptFixture(),
        ),
        poisonKey,
      ).toStrictEqual({ trackedFilesChanged: 1, headAdvanced: true });
    }

    // Own `constructor` and `prototype` keys are refused at the escalation
    // DECISION record: the inspection snapshot copies unknown data keys by
    // design (the head read is descriptor-based), so the typed refusal for
    // those two keys is the decision's optional-key reader refusing any own
    // key outside `trackedFilesChanged`/`headAdvanced`
    // (`malformed-dirty-worktree-fact`). `trackedFilesChanged: 1` keeps the
    // case outcome-changing: a lenient reader that copied the extra keys
    // would escalate.
    for (const poisonKey of ['constructor', 'prototype', '__proto__']) {
      const fact: Record<string, unknown> = { trackedFilesChanged: 1 };
      Object.defineProperty(fact, poisonKey, { enumerable: true, value: 'poison' });
      expect(decideParkEscalation(FIX_PARK, [], fact)).toStrictEqual({
        kind: 'stay-parked',
        reason: 'malformed-dirty-worktree-fact',
      });
      const record = resumeRunRecord({ parked: FIX_PARK, parkCount: 1, revision: 2 });
      expect(
        checkParkEscalation({
          record,
          state: 'parked',
          stopMode: null,
          expectedRevision: record.revision,
          history: [],
          dirtyWorktree: fact,
        }),
      ).toStrictEqual({ ok: false, reason: 'malformed-dirty-worktree-fact' });
    }
  });
});

describe('tryEscalatePark STAY_PARKED contract (FY03 gap 2)', () => {
  it('returns STAY_PARKED with zero store or journal writes at round 2 and on a clean, head-advanced worktree', async () => {
    // Exhausted budget: the O(1) round guard runs before any port read, so a
    // dirty worktree at round 2 is never inspected and never written.
    const roundTwo = await parkedHarness({ round: 2 });
    const roundTwoRecord = await roundTwo.runRepo.get(RUN_ID);
    expect(roundTwoRecord).not.toBeNull();
    if (roundTwoRecord === null) {
      throw new Error('fixture: the run record disappeared');
    }
    const roundTwoWired = withWriteCounters(withInspect(roundTwo, () => dirtyInspection()).deps);
    expect(await tryEscalateDirectly(roundTwoWired.deps, roundTwoRecord, attemptFixture({
      id: 'attempt-example-3',
      kind: 'fix',
      fixNumber: 2,
      priorAttemptId: 'attempt-example-2',
      runner: CONDUCTED_RUNNER,
    }))).toStrictEqual({ outcome: 'waiting', reason: 'parked' });
    expect(roundTwoWired.counters()).toStrictEqual({ saves: 0, appends: 0 });
    expect((await roundTwo.runRepo.get(RUN_ID))?.parked).toStrictEqual(PARKED_FIX);
    expect(await escalationResults(roundTwo)).toEqual([]);

    // Stay-parked scenario: the worktree is clean and the head moved
    // (`head-advanced`). The return is the typed STAY_PARKED, nothing is
    // saved, nothing is appended, and no escalation marker exists.
    const headAdvanced = await parkedHarness({ round: 1 });
    const headAdvancedRecord = await headAdvanced.runRepo.get(RUN_ID);
    expect(headAdvancedRecord).not.toBeNull();
    if (headAdvancedRecord === null) {
      throw new Error('fixture: the run record disappeared');
    }
    const headAdvancedWired = withWriteCounters(
      withInspect(headAdvanced, () => ({ uncommittedPaths: [], untrackedPaths: [], checkedOutCommit: MOVED_HEAD })).deps,
    );
    expect(
      await tryEscalateDirectly(headAdvancedWired.deps, headAdvancedRecord, attemptFixture({
        id: 'attempt-example-2',
        kind: 'fix',
        fixNumber: 1,
        priorAttemptId: 'attempt-example-1',
        runner: CONDUCTED_RUNNER,
      })),
    ).toStrictEqual({ outcome: 'waiting', reason: 'parked' });
    expect(headAdvancedWired.counters()).toStrictEqual({ saves: 0, appends: 0 });
    expect((await headAdvanced.runRepo.get(RUN_ID))?.parked).toStrictEqual(PARKED_FIX);
    const headAdvancedEntries = await headAdvanced.runJournal.listForRun(RUN_ID);
    expect(headAdvancedEntries.filter((entry) => entry.kind === 'conduct' && entry.state === 'fixing')).toEqual([]);
    expect(await escalationResults(headAdvanced)).toEqual([]);
  });

  it('escalates a dirty round-1 worktree and never duplicates a seeded escalation', async () => {
    // The counter-scenario an always-stay-parked implementation fails: a
    // dirty worktree at round < 2 escalates once into `fixing` (mode
    // `commit-pending`) — exactly one save and three appends (intent,
    // conduct, result).
    const harness = await parkedHarness({ round: 1 });
    const record = await harness.runRepo.get(RUN_ID);
    expect(record).not.toBeNull();
    if (record === null) {
      throw new Error('fixture: the run record disappeared');
    }
    const wired = withWriteCounters(withInspect(harness, () => dirtyInspection()).deps);
    expect(
      await tryEscalateDirectly(wired.deps, record, attemptFixture({
        id: 'attempt-example-2',
        kind: 'fix',
        fixNumber: 1,
        priorAttemptId: 'attempt-example-1',
        runner: CONDUCTED_RUNNER,
      })),
    ).toStrictEqual({ outcome: 'entered', state: 'fixing' });
    expect(wired.counters()).toStrictEqual({ saves: 1, appends: 3 });
    expect((await harness.runRepo.get(RUN_ID))?.parked).toBeNull();
    const entries = await harness.runJournal.listForRun(RUN_ID);
    // The advance-side escalation marker is the `park-escalated`
    // `commit-pending` result row (the conduct itself carries no mode).
    expect(entries).toContainEqual(
      expect.objectContaining({ kind: 'conduct', state: 'fixing' }),
    );
    expect(await escalationResults(harness)).toEqual([
      expect.objectContaining({ outcome: 'completed', reasonCode: 'park-escalated', detail: 'commit-pending' }),
    ]);

    // A seeded existing escalation is never duplicated: the once-per-run
    // history check reads the marker and stays parked with zero writes.
    const seeded = await parkedHarness({ round: 1 });
    const seededKey = parkKey(1, 1);
    await appendIntent(seeded, seededKey);
    await appendResult(seeded, seededKey, 'completed', 'park-escalated', 'commit-pending');
    const seededRecord = await seeded.runRepo.get(RUN_ID);
    expect(seededRecord).not.toBeNull();
    if (seededRecord === null) {
      throw new Error('fixture: the run record disappeared');
    }
    const seededWired = withWriteCounters(withInspect(seeded, () => dirtyInspection()).deps);
    expect(
      await tryEscalateDirectly(seededWired.deps, seededRecord, attemptFixture({
        id: 'attempt-example-2',
        kind: 'fix',
        fixNumber: 1,
        priorAttemptId: 'attempt-example-1',
        runner: CONDUCTED_RUNNER,
      })),
    ).toStrictEqual({ outcome: 'waiting', reason: 'parked' });
    expect(seededWired.counters()).toStrictEqual({ saves: 0, appends: 0 });
    expect(await escalationResults(seeded)).toHaveLength(1);
    expect((await seeded.runRepo.get(RUN_ID))?.parked).toStrictEqual(PARKED_FIX);
  });

  it('refuses escalation without throwing when worktreeInspect or attemptRepo is unwired', async () => {
    // Resume side: an unwired optional port reads the fact null, so the
    // apply refuses the plain `fix-no-progress` and writes no escalation.
    for (const options of [{ wireInspect: false }, { wireAttempts: false }] as const) {
      const fx = await seededEscalation(options);
      await seedPendingResume(fx);
      expect(await apply(fx)).toStrictEqual({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'fix-no-progress' });
      expect(fx.inspectCalls.count).toBe(0);
      expect((await fx.repo.get(RUN_ID))?.parked).toStrictEqual(FIX_PARK);
      expect(await escalationMarkers(fx)).toEqual([]);
    }

    // Advance side: the direct call also answers STAY_PARKED with zero saves
    // and zero appends (the fact is `undefined`, the history check refuses).
    const unwired = await parkedHarness({ round: 1 });
    const unwiredRecord = await unwired.runRepo.get(RUN_ID);
    expect(unwiredRecord).not.toBeNull();
    if (unwiredRecord === null) {
      throw new Error('fixture: the run record disappeared');
    }
    const unwiredWired = withWriteCounters(unwired.deps);
    expect(
      await tryEscalateDirectly(unwiredWired.deps, unwiredRecord, attemptFixture({
        id: 'attempt-example-2',
        kind: 'fix',
        fixNumber: 1,
        priorAttemptId: 'attempt-example-1',
        runner: CONDUCTED_RUNNER,
      })),
    ).toStrictEqual({ outcome: 'waiting', reason: 'parked' });
    expect(unwiredWired.counters()).toStrictEqual({ saves: 0, appends: 0 });

    // A missing latest attempt is the same unwired shape: the fact is
    // `undefined` before any inspection is paid.
    expect(
      await dirtyWorktreeFactOf(
        { deps: withInspect(unwired, () => dirtyInspection()).deps } as unknown as AdvanceStepContext,
        null,
      ),
    ).toBeUndefined();

    // A missing latest attempt is the same unwired shape: STAY_PARKED, zero
    // writes (the fact is `undefined` before any inspection is paid).
    const noAttempt = await parkedHarness({ round: 1 });
    const noAttemptRecord = await noAttempt.runRepo.get(RUN_ID);
    expect(noAttemptRecord).not.toBeNull();
    if (noAttemptRecord === null) {
      throw new Error('fixture: the run record disappeared');
    }
    const noAttemptWired = withWriteCounters(withInspect(noAttempt, () => dirtyInspection()).deps);
    expect(
      await tryEscalateDirectly(noAttemptWired.deps, noAttemptRecord, null),
    ).toStrictEqual({ outcome: 'waiting', reason: 'parked' });
    expect(noAttemptWired.counters()).toStrictEqual({ saves: 0, appends: 0 });
  });

  it('refuses escalation when attempt lookup throws, returns null, or attemptIds is empty', async () => {
    // A throwing lookup is caught and read as an unreadable attempt: the
    // fact is null, the apply refuses `fix-no-progress`, nothing escalates.
    const throws = await seededEscalation({ attemptThrows: true });
    await seedPendingResume(throws);
    expect(await apply(throws)).toStrictEqual({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'fix-no-progress' });
    expect(throws.attemptReads.count).toBe(1);
    expect((await throws.repo.get(RUN_ID))?.parked).toStrictEqual(FIX_PARK);
    expect(await escalationMarkers(throws)).toEqual([]);

    // A null attempt is the same refusal.
    const missing = await seededEscalation({ attempt: null });
    await seedPendingResume(missing);
    expect(await apply(missing)).toStrictEqual({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'fix-no-progress' });
    expect((await missing.repo.get(RUN_ID))?.parked).toStrictEqual(FIX_PARK);
    expect(await escalationMarkers(missing)).toEqual([]);

    // An empty `attemptIds` has no latest attempt to read: the fact is null
    // in O(1) and the same typed refusal fires (no escalation, no throw).
    const empty = await seededEscalation({ attemptIds: [] });
    await seedPendingResume(empty);
    expect(await apply(empty)).toStrictEqual({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'fix-no-progress' });
    expect(empty.attemptReads.count).toBe(0);
    expect((await empty.repo.get(RUN_ID))?.parked).toStrictEqual(FIX_PARK);
    expect(await escalationMarkers(empty)).toEqual([]);
  });

  it('refuses escalation and stays parked when inspectWorktree throws or times out', async () => {
    // Resume side: a throwing (a timeout included) inspection is caught in
    // the fact read and answers the plain `fix-no-progress` refusal.
    const thrown = await seededEscalation({
      inspectFactory: () => {
        throw new Error('host unreachable');
      },
    });
    await seedPendingResume(thrown);
    expect(await apply(thrown)).toStrictEqual({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'fix-no-progress' });
    expect(thrown.inspectCalls.count).toBe(1);
    expect((await thrown.repo.get(RUN_ID))?.parked).toStrictEqual(FIX_PARK);
    expect(await escalationMarkers(thrown)).toEqual([]);

    const timedOut = await seededEscalation({
      inspectFactory: () => Promise.reject(new Error('timed out')),
    });
    await seedPendingResume(timedOut);
    expect(await apply(timedOut)).toStrictEqual({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'fix-no-progress' });
    expect(await escalationMarkers(timedOut)).toEqual([]);

    // Advance side: the direct call stays parked with zero writes.
    const advanceThrown = await parkedHarness({ round: 1 });
    const advanceThrownRecord = await advanceThrown.runRepo.get(RUN_ID);
    expect(advanceThrownRecord).not.toBeNull();
    if (advanceThrownRecord === null) {
      throw new Error('fixture: the run record disappeared');
    }
    const advanceThrownInspect = withInspect(advanceThrown, () => {
      throw new Error('host unreachable');
    });
    const advanceThrownWired = withWriteCounters(advanceThrownInspect.deps);
    expect(
      await tryEscalateDirectly(advanceThrownWired.deps, advanceThrownRecord, attemptFixture({
        id: 'attempt-example-2',
        kind: 'fix',
        fixNumber: 1,
        priorAttemptId: 'attempt-example-1',
        runner: CONDUCTED_RUNNER,
      })),
    ).toStrictEqual({ outcome: 'waiting', reason: 'parked' });
    expect(advanceThrownWired.counters()).toStrictEqual({ saves: 0, appends: 0 });
    expect(advanceThrownInspect.calls).toHaveLength(1);

    const advanceTimedOut = await parkedHarness({ round: 1 });
    const advanceTimedOutRecord = await advanceTimedOut.runRepo.get(RUN_ID);
    expect(advanceTimedOutRecord).not.toBeNull();
    if (advanceTimedOutRecord === null) {
      throw new Error('fixture: the run record disappeared');
    }
    const advanceTimedOutWired = withWriteCounters(
      withInspect(advanceTimedOut, () => Promise.reject(new Error('timed out'))).deps,
    );
    expect(
      await tryEscalateDirectly(advanceTimedOutWired.deps, advanceTimedOutRecord, attemptFixture({
        id: 'attempt-example-2',
        kind: 'fix',
        fixNumber: 1,
        priorAttemptId: 'attempt-example-1',
        runner: CONDUCTED_RUNNER,
      })),
    ).toStrictEqual({ outcome: 'waiting', reason: 'parked' });
    expect(advanceTimedOutWired.counters()).toStrictEqual({ saves: 0, appends: 0 });
  });

  it('refuses null, undefined, and primitive inspection values without escalating', async () => {
    // Resume side: a non-record inspection is unreadable in O(1), so the
    // fact is null and the apply refuses `fix-no-progress` (with the default
    // DIRTY paths, a lenient reader that treated any of these as an empty
    // inspection would report worktree-clean, and one that escalated on an
    // unreadable fact fails the refusal).
    for (const inspect of [null, undefined, 7, 'dirty', true, []]) {
      const fx = await seededEscalation({ inspect });
      await seedPendingResume(fx);
      expect(await apply(fx), String(inspect)).toStrictEqual({
        outcome: 'refused',
        key: RESUME_CLI_KEY,
        reason: 'fix-no-progress',
      });
      expect((await fx.repo.get(RUN_ID))?.parked).toStrictEqual(FIX_PARK);
      expect(await escalationMarkers(fx)).toEqual([]);
    }

    // Advance side: the same shapes read the fact `undefined`, so the direct
    // call stays parked with zero writes.
    for (const inspection of [null, undefined, 7, 'dirty']) {
      expect(
        await dirtyWorktreeFactOf(
          { deps: { worktreeInspect: { inspectWorktree: async () => inspection } } } as unknown as AdvanceStepContext,
          attemptFixture(),
        ),
      ).toBeUndefined();
    }
  });

  it('never invokes getters on inspection fields or uncommittedPaths and refuses escalation', async () => {
    // Resume side: the head is getter-backed and the paths are getter-backed
    // (both side-effecting); the snapshot reads own data descriptors only, so
    // neither getter ever runs and the apply refuses `fix-no-progress` —
    // with dirty paths, a getter-running reader would have escalated.
    let headGetterRuns = 0;
    let pathsGetterRuns = 0;
    const getterInspection: Record<string, unknown> = { worktreePath: WORKTREE_PATH, matchesBaseCommit: false, untrackedPaths: [] };
    Object.defineProperty(getterInspection, 'checkedOutCommit', {
      enumerable: true,
      get: () => {
        headGetterRuns += 1;
        return MOVED_HEAD;
      },
    });
    Object.defineProperty(getterInspection, 'uncommittedPaths', {
      enumerable: true,
      get: () => {
        pathsGetterRuns += 1;
        return ['src/changed.ts'];
      },
    });
    const fx = await seededEscalation({ inspect: getterInspection });
    await seedPendingResume(fx);
    expect(await apply(fx)).toStrictEqual({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'fix-no-progress' });
    expect(headGetterRuns).toBe(0);
    expect(pathsGetterRuns).toBe(0);
    expect((await fx.repo.get(RUN_ID))?.parked).toStrictEqual(FIX_PARK);
    expect(await escalationMarkers(fx)).toEqual([]);

    // Advance side: the paths getter is never run either (its descriptor
    // value is absent), so the fact is `undefined` and the run stays parked.
    let advancePathsGetterRuns = 0;
    const advanceGetterInspection: Record<string, unknown> = { untrackedPaths: [] };
    Object.defineProperty(advanceGetterInspection, 'uncommittedPaths', {
      enumerable: true,
      get: () => {
        advancePathsGetterRuns += 1;
        throw new Error('paths getter');
      },
    });
    expect(
      await dirtyWorktreeFactOf(
        {
          deps: { worktreeInspect: { inspectWorktree: async () => advanceGetterInspection } },
        } as unknown as AdvanceStepContext,
        attemptFixture(),
      ),
    ).toBeUndefined();
    expect(advancePathsGetterRuns).toBe(0);
  });

  it('catches throwing Proxy traps on inspection and refuses escalation', async () => {
    // A Proxy whose every trap throws is caught around the snapshot and the
    // descriptor reads: the fact is unreadable, never an escalation, never
    // an escaped throw.
    const hostileProxy = (): unknown =>
      new Proxy({ uncommittedPaths: ['src/changed.ts'], checkedOutCommit: MOVED_HEAD }, {
        get() {
          throw new Error('trap');
        },
        getOwnPropertyDescriptor() {
          throw new Error('trap');
        },
        ownKeys() {
          throw new Error('trap');
        },
      });

    const fx = await seededEscalation({ inspectFactory: hostileProxy });
    await seedPendingResume(fx);
    expect(await apply(fx)).toStrictEqual({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'fix-no-progress' });
    expect((await fx.repo.get(RUN_ID))?.parked).toStrictEqual(FIX_PARK);
    expect(await escalationMarkers(fx)).toEqual([]);

    // Advance side: the descriptor read is guarded too, so the fact is
    // `undefined` and the run stays parked.
    expect(
      await dirtyWorktreeFactOf(
        {
          deps: { worktreeInspect: { inspectWorktree: async () => hostileProxy() } },
        } as unknown as AdvanceStepContext,
        attemptFixture(),
      ),
    ).toBeUndefined();
    const harness = await parkedHarness({ round: 1 });
    const record = await harness.runRepo.get(RUN_ID);
    expect(record).not.toBeNull();
    if (record === null) {
      throw new Error('fixture: the run record disappeared');
    }
    const wired = withWriteCounters(withInspect(harness, () => hostileProxy()).deps);
    expect(
      await tryEscalateDirectly(wired.deps, record, attemptFixture({
        id: 'attempt-example-2',
        kind: 'fix',
        fixNumber: 1,
        priorAttemptId: 'attempt-example-1',
        runner: CONDUCTED_RUNNER,
      })),
    ).toStrictEqual({ outcome: 'waiting', reason: 'parked' });
    expect(wired.counters()).toStrictEqual({ saves: 0, appends: 0 });
  });

  it('escalates on the advance path when the head is malformed or missing and uncommittedPaths is non-empty (the dirty rule wins; an unreadable head is unknown, never clean)', async () => {
    // Gap 1: the malformed/missing `checkedOutCommit` refusals above are the
    // RESUME path's pin (the whole fact is refused there). The advance path
    // is pinned here: the merged advance-side read leaves `headAdvanced`
    // ABSENT for a malformed, uppercase, wrong-typed or missing head
    // (unknown, read as `false` — CE2) while the bounded path read still
    // counts the uncommitted edits, so the fact keeps its exact
    // `{ trackedFilesChanged }` shape and the dirty-worktree rule wins:
    // `tryEscalatePark` escalates. An unreadable head can never masquerade
    // as a clean worktree to park on; an implementation that read it as
    // clean (parking `head-advanced`) or refused the whole fact fails this
    // test. Cost: the fact read is the usual O(1) gates plus one bounded
    // O(cap) walk, cap = 4096; the head check is O(1) per case.
    const heads: unknown[] = ['not-a-sha', HEAD.slice(0, 12), MOVED_HEAD.toUpperCase(), null, 7];
    for (const checkedOutCommit of heads) {
      expect(
        await dirtyWorktreeFactOf(
          {
            deps: {
              worktreeInspect: {
                inspectWorktree: async () => ({ ...dirtyInspection(), checkedOutCommit }),
              },
            },
          } as unknown as AdvanceStepContext,
          attemptFixture(),
        ),
        String(checkedOutCommit),
      ).toStrictEqual({ trackedFilesChanged: 1 });
    }

    // A missing key reads the same: no own descriptor, head fact absent.
    expect(
      await dirtyWorktreeFactOf(
        {
          deps: {
            worktreeInspect: {
              inspectWorktree: async () => {
                const missing: Record<string, unknown> = { ...dirtyInspection() };
                Reflect.deleteProperty(missing, 'checkedOutCommit');
                return missing;
              },
            },
          },
        } as unknown as AdvanceStepContext,
        attemptFixture(),
      ),
    ).toStrictEqual({ trackedFilesChanged: 1 });

    // End to end: the unreadable-head dirty fact drives `tryEscalatePark`
    // into `fixing` exactly once, with the usual one save and three
    // appends, and the park is lifted — the head fact never blocks it.
    const harness = await parkedHarness({ round: 1 });
    const record = await harness.runRepo.get(RUN_ID);
    expect(record).not.toBeNull();
    if (record === null) {
      throw new Error('fixture: the run record disappeared');
    }
    const wired = withWriteCounters(
      withInspect(harness, () => ({ ...dirtyInspection(), checkedOutCommit: 'not-a-sha' })).deps,
    );
    expect(
      await tryEscalateDirectly(wired.deps, record, attemptFixture({
        id: 'attempt-example-2',
        kind: 'fix',
        fixNumber: 1,
        priorAttemptId: 'attempt-example-1',
        runner: CONDUCTED_RUNNER,
      })),
    ).toStrictEqual({ outcome: 'entered', state: 'fixing' });
    expect(wired.counters()).toStrictEqual({ saves: 1, appends: 3 });
    expect((await harness.runRepo.get(RUN_ID))?.parked).toBeNull();
    expect(await escalationResults(harness)).toEqual([
      expect.objectContaining({ outcome: 'completed', reasonCode: 'park-escalated', detail: 'commit-pending' }),
    ]);
  });

  it('refuses non-array, array-like, holed, and over-bound uncommittedPaths in bounded time', async () => {
    // Every shape here is refused by `readBoundedDenseArray`'s O(1) gates on
    // prototype and `length` (an over-bound length is refused before any
    // element is walked; the only walk is bounded O(cap), cap = 4096), so no
    // unbounded hostile list is ever iterated. On the resume side the fact
    // is null and the apply refuses `fix-no-progress` — with a lenient
    // reader that counted any of these as dirty, the run would escalate, so
    // the refusal is outcome-changing.
    const holed: unknown[] = ['src/a.ts', 'src/b.ts'];
    delete holed[0];
    const cases: unknown[] = [
      null,
      'src/a.ts',
      { length: 1, 0: 'src/a.ts' },
      holed,
      Array.from({ length: 4097 }, (_unused, index) => `src/${index}.ts`),
      { length: 2 ** 32 },
    ];
    for (const uncommittedPaths of cases) {
      const fx = await seededEscalation({
        inspect: { ...DIRTY_INSPECTION, uncommittedPaths },
      });
      await seedPendingResume(fx);
      expect(await apply(fx)).toStrictEqual({ outcome: 'refused', key: RESUME_CLI_KEY, reason: 'fix-no-progress' });
      expect((await fx.repo.get(RUN_ID))?.parked).toStrictEqual(FIX_PARK);
      expect(await escalationMarkers(fx)).toEqual([]);
    }

    // Advance side: the same shapes read the fact `undefined` and the direct
    // call stays parked with zero writes (a broken bounded reader that
    // accepted any of these would escalate instead).
    for (const uncommittedPaths of cases) {
      expect(
        await dirtyWorktreeFactOf(
          {
            deps: { worktreeInspect: { inspectWorktree: async () => ({ uncommittedPaths, untrackedPaths: [] }) } },
          } as unknown as AdvanceStepContext,
          attemptFixture(),
        ),
        String(Array.isArray(uncommittedPaths)),
      ).toBeUndefined();
    }
    const harness = await parkedHarness({ round: 1 });
    const record = await harness.runRepo.get(RUN_ID);
    expect(record).not.toBeNull();
    if (record === null) {
      throw new Error('fixture: the run record disappeared');
    }
    const wired = withWriteCounters(
      withInspect(harness, () => ({ uncommittedPaths: { length: 2 ** 32 }, untrackedPaths: [] })).deps,
    );
    expect(
      await tryEscalateDirectly(wired.deps, record, attemptFixture({
        id: 'attempt-example-2',
        kind: 'fix',
        fixNumber: 1,
        priorAttemptId: 'attempt-example-1',
        runner: CONDUCTED_RUNNER,
      })),
    ).toStrictEqual({ outcome: 'waiting', reason: 'parked' });
    expect(wired.counters()).toStrictEqual({ saves: 0, appends: 0 });
  });
});
