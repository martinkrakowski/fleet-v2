/**
 * Conductor driver crash-resume when a state-file write or lock was left
 * stranded by a killed process (reliability, test-only unit).
 *
 * Where `conductor-driver-crash-resume.test.ts` crashes the driver through its
 * own step port, this suite crashes the process *inside a store write*:
 * a stray `run-journal.json.<pid>-<ms>-<n>.tmp` beside the target (the window
 * between the temp write and the rename in `writeJsonAtomically`), or a held
 * `run-journal.json.lock` (the window while `withFileLock` owns the store).
 * In every case a fresh driver, resumed after the crashed holder's leases
 * lapse, must repeat no one-way action and reach the same terminal state as an
 * uninterrupted baseline drive.
 *
 * Cost bounds: every test runs one bounded single-run fixture in an isolated
 * temp directory with O(1) file-store records; each lock check passes
 * `{ timeoutMs: 50 }` so no test waits on the 10 s default. This suite
 * introduces no new input-reading functions — the only parsed values are the
 * suite's own bytes — so the store's hostile-input refusals stay with the
 * unchanged production parsers (`parseVersionedLaneRunJournalStateRecord`,
 * `inspectVersionedRecordListBytes`), which this unit does not modify.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  promises as fsPromises,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AdvanceLaneRunPort,
  AttemptRecord,
  BaseBranchValue,
  LaneRunJournalEntryRecord,
  LaneRunStateValue,
} from '@fleet/work-execution';
import {
  AdvanceLaneRunUseCase,
  CancelPreparedAttemptUseCase,
  CONDUCTOR_LEASE_MS,
  FileLockTimeoutError,
  LANE_RUN_TERMINAL_STATES,
  PrepareFixAttemptUseCase,
  RunConductorPassUseCase,
  laneRunJournalState,
  sha256HexDigest,
  withFileLock,
  writeJsonAtomically,
} from '@fleet/work-execution';
import { resolveConductorPolicy } from '@fleet/installation';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import {
  DRY_RUN_BRIEF_PROSE,
  DRY_RUN_MANIFEST_JSON,
  createDryRunFakes,
  type DryRunFakes,
} from '../conductor-dry-run.js';

const NOW = '2026-10-27T10:00:00.000Z';
const RUN_ID = 'run-01JB0000000000000000000000';
const ATTEMPT_ID = 'attempt-example-1';
const WORKTREE = '/tmp/fleet-example/wt/run-01JB0000000000000000000000';

const SEAT_PLAN = {
  version: 1 as const,
  'first-pass': [
    { id: 'fp-1', model: 'model-example-1', tool: 'opencode' },
    { id: 'fp-2', model: 'model-example-2', tool: 'opencode' },
  ],
  fix: [{ id: 'fx-1', model: 'model-example-1', tool: 'opencode' }],
  review: [{ id: 'review-dry-run', model: 'example/dry-run-reviewer' }],
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

const ATTEMPT: AttemptRecord = {
  id: ATTEMPT_ID,
  workOrderId: 'wo-example-1',
  kind: 'initial',
  fixNumber: 0,
  priorAttemptId: null,
  worktreePath: WORKTREE,
  baseCommit: 'a'.repeat(40),
  state: 'intent-recorded',
  outcome: null,
  revision: 0,
  // The collect fake reads the frozen manifest digest-verified, so the seeded
  // attempt carries the digest of the dry-run fake's frozen prose and manifest.
  briefDigest: createHash('sha256').update(DRY_RUN_BRIEF_PROSE + '\n' + DRY_RUN_MANIFEST_JSON, 'utf8').digest('hex'),
  briefPackagePath: '.lane/brief.md',
  sessionId: null,
  completionReceipt: null,
  artifacts: null,
  seatPlan: SEAT_PLAN,
  seatSelection: SEAT_SELECTION,
  // A conducted attempt always carries its runner host (stamped at start), so
  // the seeded start does too; without one the act guard parks.
  runner: {
    kind: 'opencode',
    remotePort: null,
    host: 'lane-example',
    hostName: 'lane-example',
    agent: null,
    model: null,
    variant: null,
  },
  stopReason: 'none',
  createdAtIso: NOW,
  updatedAtIso: NOW,
};

/** A spy runner: the conductor must never dispatch a subprocess. */
function throwingRunSubprocess(): never {
  throw new Error('the conductor must never dispatch a subprocess');
}

/** Temp dirs this file created, swept by afterEach when a test leaves one. */
const CREATED_DIRS: string[] = [];

/** Every runSubprocess spy this file built, asserted silent in T5. */
const SUBPROCESS_SPIES: Array<ReturnType<typeof vi.fn>> = [];

function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-v2-conductor-driver-write-crash-resume-test-'));
  CREATED_DIRS.push(dir);
  return dir;
}

/** What a completed `conductor start` leaves: a work order, a held reservation, the intent-recorded attempt, the run. */
async function seedCompletedStart(runtime: FleetCliRuntime, baseBranch?: BaseBranchValue): Promise<void> {
  await runtime.execution.workOrderRepository.saveWorkOrder({
    id: 'wo-example-1',
    projectId: 'project-example-1',
    taskId: 'task-example-1',
    laneId: 'lane-example-1',
    repository: 'repo-example-1',
    baseCommit: 'a'.repeat(40),
    ownedPaths: ['packages/example/src'],
    policyRevision: 'policy-example-1',
    prerequisiteWorkOrderIds: [],
    state: 'approved',
    revision: 1,
    createdAtIso: NOW,
    updatedAtIso: NOW,
  });
  await runtime.execution.executionJournal.saveCapacityReservation({
    id: 'res-01JB0000000000000000000001',
    attemptId: ATTEMPT_ID,
    hostId: 'lane-example',
    slotIndex: 0,
    held: true,
    seatTool: 'opencode',
    hostName: 'lane-example',
    hostKind: 'opencode',
    transport: 'local',
    sshAlias: null,
    port: null,
    worktreePath: WORKTREE,
    reservedAtIso: NOW,
    releasedAtIso: null,
  });
  await runtime.execution.attemptRepository.saveAttempt(ATTEMPT);
  const run = await runtime.conductor.laneRunRepository.create({
    version: 1,
    runId: RUN_ID,
    workOrderId: 'wo-example-1',
    tier: 2,
    seatPlanRef: 'a'.repeat(64),
    cursors: { 'first-pass': null, fix: null, review: null },
    round: 0,
    attemptIds: [ATTEMPT_ID],
    prNumber: null,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 1,
    runPolicyRevision: 'policy-example-1',
    branchName: 'fleet/' + RUN_ID,
    ...(baseBranch !== undefined ? { baseBranch } : {}),
  });
  expect(run.outcome).toBe('saved');
}

/** A fake clock: every time value in the suite comes from here. */
function makeClock() {
  let ms = Date.parse(NOW);
  return {
    now: (): string => new Date(ms).toISOString(),
    advanceMs: (delta: number): void => {
      ms += delta;
    },
  };
}

interface Scenario {
  readonly dir: string;
  readonly runtime: FleetCliRuntime;
  readonly fakes: DryRunFakes;
  readonly clock: ReturnType<typeof makeClock>;
  readonly advance: AdvanceLaneRunPort;
  readonly runSubprocess: ReturnType<typeof vi.fn>;
}

const HOLDER_CONTROL = 'driver-control-1';
const HOLDER_CRASH = 'driver-write-crash-1';
const HOLDER_RESUME = 'driver-write-resume-2';

/** Build the advance port over the given runtime's real file stores with the given fakes. */
function buildAdvance(runtime: FleetCliRuntime, fakes: DryRunFakes): AdvanceLaneRunPort {
  return new AdvanceLaneRunUseCase({
    runRepo: runtime.conductor.laneRunRepository,
    runJournal: runtime.conductor.laneRunJournal,
    attemptRepo: runtime.execution.attemptRepository,
    executionJournal: runtime.execution.executionJournal,
    artifactPort: fakes.artifactPort,
    computeDigest: sha256HexDigest,
    reconcileAttempt: fakes.reconcileAttempt,
    admission: fakes.admission,
    newUlid: runtime.conductor.newUlid,
    stopGraceMinutes: resolveConductorPolicy(undefined).stopGraceMinutes,
    dispatchAttempt: fakes.dispatchAttempt,
    cancelPreparedAttempt: new CancelPreparedAttemptUseCase({
      attemptRepo: runtime.execution.attemptRepository,
      journal: runtime.execution.executionJournal,
    }),
    stopAttempt: fakes.stopAttempt,
    collectAttemptArtifacts: fakes.collectAttemptArtifacts,
    commitEditOnlyAttempt: fakes.commitEditOnlyAttempt,
    evaluateAttemptGate: fakes.evaluateAttemptGate,
    runnerForAttempt: fakes.runnerForAttempt,
    reviewRequest: fakes.reviewRequest,
    reviewAssessment: fakes.reviewAssessment,
    sameModelFamily: () => false,
    workOrderRepo: runtime.execution.workOrderRepository,
    workOrderRelease: runtime.execution.workOrderRepository,
    prepareFixAttempt: new PrepareFixAttemptUseCase({ attemptRepo: runtime.execution.attemptRepository }),
    prepareBrief: fakes.prepareBrief,
    acceptanceAssessment: fakes.acceptanceAssessment,
    ciState: fakes.ciState,
    forgeRead: fakes.forgeRead,
    conductorForgeGrant: fakes.conductorForgeGrant,
    executeForgeAction: fakes.executeForgeAction,
    enqueueMerge: fakes.enqueueMerge,
    mergeQueue: fakes.mergeQueue,
    forgeRepository: fakes.forgeRepository,
    parkNotice: fakes.parkNotice,
    autoMergeEnabled: true,
    // The same opt-in as the dry-run driver: this scenario walks the full
    // merging -> merged cycle on the fakes.
    premergeMode: 'auto-attest',
  });
}

/**
 * Build one isolated world: a temp state dir (or an existing one, for a fresh
 * runtime resuming over it — nothing is re-seeded there, and the clock is
 * shared so the fresh holder reads a lapsed lease), and the dry-run advance
 * over the real file stores.
 */
async function startScenario(options?: { readonly dir?: string; readonly clock?: ReturnType<typeof makeClock> }): Promise<Scenario> {
  const dir = options?.dir ?? tempStateDir();
  const clock = options?.clock ?? makeClock();
  const runSubprocess = vi.fn(throwingRunSubprocess);
  SUBPROCESS_SPIES.push(runSubprocess);
  const runtime = createFleetCliRuntime({ stateDir: dir, runSubprocess });
  if (options?.dir === undefined) {
    await seedCompletedStart(runtime);
  }
  const fakes = createDryRunFakes(
    { attemptRepo: runtime.execution.attemptRepository, executionJournal: runtime.execution.executionJournal },
    clock.now,
  );
  const advance = buildAdvance(runtime, fakes);
  return { dir, runtime, fakes, clock, advance, runSubprocess };
}

/** Build the driver over the real file stores exactly as the pass expects them. */
function driverFor(scenario: Scenario, advance: AdvanceLaneRunPort): RunConductorPassUseCase {
  return new RunConductorPassUseCase({
    driverLease: scenario.runtime.conductor.driverLease,
    runRepo: scenario.runtime.conductor.laneRunRepository,
    runJournal: scenario.runtime.conductor.laneRunJournal,
    halt: scenario.runtime.conductor.halt,
    resume: scenario.runtime.conductor.resumeLaneRun,
    advance,
    now: scenario.clock.now,
    sleep: async () => undefined,
    dispatchStaggerMs: 0,
  });
}

async function journalStateOf(scenario: Scenario): Promise<LaneRunStateValue> {
  const entries = await scenario.runtime.conductor.laneRunJournal.listForRun(RUN_ID);
  return laneRunJournalState(entries, RUN_ID);
}

async function isTerminal(scenario: Scenario): Promise<boolean> {
  return (LANE_RUN_TERMINAL_STATES as readonly string[]).includes(await journalStateOf(scenario));
}

/** Drive passes until the run is terminal, keeping the leases live with a fresh clock before each pass. */
async function runPasses(scenario: Scenario, pass: RunConductorPassUseCase, holderId: string): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    const result = await pass.runPass({ holderId, nowIso: scenario.clock.now() });
    if (result.outcome !== 'completed') {
      throw new Error('pass refused: ' + result.reason);
    }
    if (await isTerminal(scenario)) return;
    scenario.clock.advanceMs(60_000); // fresh clock before the next pass; renewals keep the leases live
  }
  throw new Error('the run never reached a terminal state');
}

const READ_PORTS = new Set(['runnerForAttempt', 'findLatestReceiptOfKind', 'ciState', 'forgeRead', 'listMergeQueue']);

function oneWayTally(calls: DryRunFakes['recorder']['calls']): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const call of calls) {
    if (!READ_PORTS.has(call.port)) {
      tally[call.port] = (tally[call.port] ?? 0) + 1;
    }
  }
  return tally;
}

interface DriveMetrics {
  readonly terminalState: LaneRunStateValue;
  readonly resultKeys: readonly string[];
  readonly tally: Record<string, number>;
  readonly parkIsNull: boolean;
}

/**
 * Metrics of the whole drive across every scenario that touched the one state
 * dir: the record and journal reads go through the last (fresh) runtime, the
 * one-way tally merges the recorders of all of them.
 */
async function deriveMetrics(scenarios: readonly Scenario[]): Promise<DriveMetrics> {
  const last = scenarios[scenarios.length - 1];
  const entries = await last.runtime.conductor.laneRunJournal.listForRun(RUN_ID);
  const record = await last.runtime.conductor.laneRunRepository.get(RUN_ID);
  const resultKeys = entries
    .filter((entry) => entry.kind === 'result' && entry.key !== null)
    .map((entry) => entry.key as string)
    .sort()
    .filter((key, index, keys) => index === 0 || key !== keys[index - 1]);
  const calls = scenarios.flatMap((scenario) => scenario.fakes.recorder.calls);
  return {
    terminalState: await journalStateOf(last),
    resultKeys,
    tally: oneWayTally(calls),
    parkIsNull: record !== null && record.parked === null,
  };
}

/** The control drive: one scenario, the unwrapped advance, to terminal. */
async function runBaseline(): Promise<DriveMetrics> {
  const scenario = await startScenario();
  try {
    const pass = driverFor(scenario, scenario.advance);
    await runPasses(scenario, pass, HOLDER_CONTROL);
    return await deriveMetrics([scenario]);
  } finally {
    rmSync(scenario.dir, { recursive: true, force: true });
  }
}

function expectSameDrive(actual: DriveMetrics, baseline: DriveMetrics): void {
  expect(actual.terminalState).toBe(baseline.terminalState);
  expect(actual.resultKeys).toEqual(baseline.resultKeys);
  expect(actual.tally).toEqual(baseline.tally);
  expect(actual.parkIsNull).toBe(true);
}

function expectExplicitCounts(tally: Record<string, number>): void {
  expect(tally.dispatch).toBe(1);
  expect(tally.reviewRequest).toBe(2);
  expect(tally.executeForgeAction).toBe(2);
  expect(tally.enqueueMerge).toBe(1);
}

/** The name writeJsonAtomically gives its first temp file in this process. */
function strayTmpName(journalPath: string): string {
  return `${journalPath}.${String(process.pid)}-${String(Date.now())}-0.tmp`;
}

/** A valid committed entry with a fresh ULID-shaped id (same pattern, last letter swapped). */
function derivedEntryId(entryId: string): string {
  const last = entryId.charAt(entryId.length - 1);
  return entryId.slice(0, entryId.length - 1) + (last === 'A' ? 'B' : 'A');
}

/**
 * Assert that `withFileLock(lockPath, cb, { timeoutMs: 50 })` refuses the held
 * lock: it rejects with `FileLockTimeoutError` naming the holder pid and the
 * lock's age in its message and fields, never runs the callback, and costs no
 * more than the 50 ms budget (bounded: at most a handful of 25 ms polls).
 */
async function expectLockTimeoutRefusal(lockPath: string, holderPid: number): Promise<void> {
  const started = Date.now();
  let callbackRan = false;
  let rejection: unknown = null;
  try {
    await withFileLock(
      lockPath,
      async () => {
        callbackRan = true;
        return null;
      },
      { timeoutMs: 50 },
    );
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeInstanceOf(FileLockTimeoutError);
  const lockError = rejection as FileLockTimeoutError;
  expect(lockError.lockPath).toBe(lockPath);
  expect(lockError.holderPid).toBe(holderPid);
  expect(lockError.ageMs).toBeGreaterThanOrEqual(4_000);
  expect(lockError.ageMs).toBeLessThan(20_000);
  expect(String(lockError.message)).toContain(String(holderPid));
  expect(String(lockError.message)).toContain('ms');
  expect(callbackRan).toBe(false);
  expect(Date.now() - started).toBeLessThan(2_000);
}

/**
 * The exact per-test cleanup `afterEach` runs: restore every spy, then sweep
 * temp dirs. T5 exercises this function directly so the restoration it proves
 * is the restoration `afterEach` performs.
 */
function sweepAfterTest(): void {
  vi.restoreAllMocks();
  for (const dir of CREATED_DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('conductor driver resumed after a crash inside a state-file write or lock', () => {
  afterEach(sweepAfterTest);

  it('T1 (major): a stray run-journal temp file left between the temp write and the rename is ignored on resume and the drive reaches the baseline terminal state', async () => {
    const baseline = await runBaseline();
    const scenario = await startScenario();
    // One pass before terminal, so the journal exists with prior entries.
    const firstPass = driverFor(scenario, scenario.advance);
    const first = await firstPass.runPass({ holderId: HOLDER_CRASH, nowIso: scenario.clock.now() });
    expect(first.outcome).toBe('completed');
    expect(await isTerminal(scenario)).toBe(false);
    const journalPath = join(scenario.dir, 'run-journal.json');
    const prior = JSON.parse(readFileSync(journalPath, 'utf8')) as unknown;
    expect(Array.isArray(prior)).toBe(true);
    const priorEntries = prior as LaneRunJournalEntryRecord[];
    expect(priorEntries.length).toBeGreaterThan(0);
    // A killed writer's residue: prior entries plus one extra valid entry,
    // never renamed over the target.
    const lastEntry = priorEntries[priorEntries.length - 1];
    const extraEntry: LaneRunJournalEntryRecord = { ...lastEntry, entryId: derivedEntryId(lastEntry.entryId) };
    const strayPath = strayTmpName(journalPath);
    writeFileSync(strayPath, JSON.stringify([...priorEntries, extraEntry], null, 2) + '\n', 'utf8');
    // Lapse the holder's leases, then resume with a fresh runtime.
    scenario.clock.advanceMs(CONDUCTOR_LEASE_MS + 60_000);
    const resume = await startScenario({ dir: scenario.dir, clock: scenario.clock });
    await runPasses(resume, driverFor(resume, resume.advance), HOLDER_RESUME);
    expect(await isTerminal(resume)).toBe(true);
    const metrics = await deriveMetrics([scenario, resume]);
    expectSameDrive(metrics, baseline);
    expectExplicitCounts(metrics.tally);
    expect(existsSync(strayPath)).toBe(true); // the residue stays; it was never read as state
    expect(resume.runSubprocess).not.toHaveBeenCalled();
    expect(scenario.runSubprocess).not.toHaveBeenCalled();
  }, 60_000);

  it('T2 (major): a held run-journal.lock names its holder, refuses withFileLock without running the callback, and the resume reaches the baseline drive', async () => {
    const baseline = await runBaseline();
    const scenario = await startScenario();
    // Drive partway so the journal exists, and record its exact bytes.
    const firstPass = driverFor(scenario, scenario.advance);
    const first = await firstPass.runPass({ holderId: HOLDER_CRASH, nowIso: scenario.clock.now() });
    expect(first.outcome).toBe('completed');
    expect(await isTerminal(scenario)).toBe(false);
    const journalPath = join(scenario.dir, 'run-journal.json');
    const bytesBefore = readFileSync(journalPath);
    // The lock a killed writer holds: pid-hex-time, from a non-existent pid.
    const lockPath = journalPath + '.lock';
    const holderPid = 999999;
    const token = [String(holderPid), 'a'.repeat(16), String(Date.now() - 5000)].join('-');
    writeFileSync(lockPath, token, 'utf8');
    await expectLockTimeoutRefusal(lockPath, holderPid);
    expect(readFileSync(journalPath).equals(bytesBefore)).toBe(true);
    // The operator step: remove only the lock file.
    rmSync(lockPath);
    // Lapse the holder's leases, then resume with a fresh runtime.
    scenario.clock.advanceMs(CONDUCTOR_LEASE_MS + 60_000);
    const resume = await startScenario({ dir: scenario.dir, clock: scenario.clock });
    await runPasses(resume, driverFor(resume, resume.advance), HOLDER_RESUME);
    expect(await isTerminal(resume)).toBe(true);
    const metrics = await deriveMetrics([scenario, resume]);
    expectSameDrive(metrics, baseline);
    expectExplicitCounts(metrics.tally);
    expect(resume.runSubprocess).not.toHaveBeenCalled();
    expect(scenario.runSubprocess).not.toHaveBeenCalled();
  }, 60_000);

  it('T3 (major): a stray temp file or a held lock at the FIRST journal write is ignored or refused, and the run still drives to the baseline exactly once', async () => {
    const baseline = await runBaseline();
    // A valid committed entry, harvested from a disposable drive, seeds the stray temp file in (a).
    const donor = await startScenario();
    const donorPass = driverFor(donor, donor.advance);
    const donorRun = await donorPass.runPass({ holderId: HOLDER_CONTROL, nowIso: donor.clock.now() });
    expect(donorRun.outcome).toBe('completed');
    const donorEntries = JSON.parse(readFileSync(join(donor.dir, 'run-journal.json'), 'utf8')) as unknown;
    expect(Array.isArray(donorEntries)).toBe(true);
    const strayEntry = (donorEntries as LaneRunJournalEntryRecord[])[0];
    expect(strayEntry).toBeDefined();

    // (a) A stray temp file with no committed target at all.
    const scenarioA = await startScenario();
    const journalPathA = join(scenarioA.dir, 'run-journal.json');
    expect(existsSync(journalPathA)).toBe(false);
    writeFileSync(
      strayTmpName(journalPathA),
      JSON.stringify([{ ...strayEntry, entryId: derivedEntryId(strayEntry.entryId) }], null, 2) + '\n',
      'utf8',
    );
    expect(await scenarioA.runtime.conductor.laneRunJournal.listForRun(RUN_ID)).toEqual([]);
    await runPasses(scenarioA, driverFor(scenarioA, scenarioA.advance), HOLDER_CONTROL);
    expect(await isTerminal(scenarioA)).toBe(true);
    const metricsA = await deriveMetrics([scenarioA]);
    expectSameDrive(metricsA, baseline);
    expectExplicitCounts(metricsA.tally); // started once, never twice
    expect(scenarioA.runSubprocess).not.toHaveBeenCalled();

    // (b) A held lock before the first write.
    const scenarioB = await startScenario();
    const journalPathB = join(scenarioB.dir, 'run-journal.json');
    const holderPid = 999998;
    const lockPathB = journalPathB + '.lock';
    writeFileSync(lockPathB, [String(holderPid), 'b'.repeat(16), String(Date.now() - 5000)].join('-'), 'utf8');
    await expectLockTimeoutRefusal(lockPathB, holderPid);
    expect(existsSync(journalPathB)).toBe(false); // still no committed record
    rmSync(lockPathB); // remove only the lock file
    const resume = await startScenario({ dir: scenarioB.dir, clock: scenarioB.clock }); // a fresh runtime over the same dir
    await runPasses(resume, driverFor(resume, resume.advance), HOLDER_RESUME);
    expect(await isTerminal(resume)).toBe(true);
    const metricsB = await deriveMetrics([resume]);
    expectSameDrive(metricsB, baseline);
    expectExplicitCounts(metricsB.tally);
    expect(resume.runSubprocess).not.toHaveBeenCalled();
    expect(scenarioB.runSubprocess).not.toHaveBeenCalled();
  }, 60_000);

  it('T4 (minor): writeJsonAtomically removes its own temp file and rethrows the rename error unchanged when rename rejects', async () => {
    const dir = tempStateDir();
    const injectedError = new Error('injected rename failure');
    const renameSpy = vi.spyOn(fsPromises, 'rename').mockRejectedValueOnce(injectedError);
    try {
      let rejection: unknown = null;
      try {
        await writeJsonAtomically(join(dir, 'probe.json'), { ok: true });
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBe(injectedError);
      const names = readdirSync(dir);
      expect(names.filter((name) => name.includes('.tmp'))).toEqual([]);
    } finally {
      renameSpy.mockRestore();
    }
  });

  it('T5 (minor): every runSubprocess spy in the suite stays silent and the afterEach cleanup restores injected spies', () => {
    for (const spy of SUBPROCESS_SPIES) {
      expect(spy).not.toHaveBeenCalled();
    }
    // A real spy (vi.spyOn, like T4's rename spy) with an injected fault.
    // vi.fn mocks are untouched by vi.restoreAllMocks(), so only a spyOn spy
    // can prove the afterEach restoration actually happens: with the
    // `afterEach(sweepAfterTest)` line removed, this test fails, because the
    // fault stays installed.
    const probe = { signal: () => 'original' };
    const probeSpy = vi.spyOn(probe, 'signal').mockImplementation(() => 'faulted');
    expect(probeSpy.getMockName()).toBeTruthy();
    expect(probe.signal()).toBe('faulted');
    expect(probeSpy).toHaveBeenCalledTimes(1);
    sweepAfterTest(); // the exact cleanup afterEach runs
    expect(probe.signal()).toBe('original'); // the fault is gone
  });
});
