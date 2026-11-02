/**
 * Conductor driver crash-and-resume at every step boundary (reliability).
 *
 * The driver (RunConductorPassUseCase) takes the step port through
 * `RunConductorPassDependencies.advance`. A throw from that port latches the
 * pass stop, rethrows out of `runPass`, and leaves the crashed holder's leases
 * in the file stores. This suite proves a fresh driver can take over after the
 * leases lapse and finish the run without repeating any one-way action, for
 * every boundary the control drive crosses. Every time value comes from the
 * fake clock; the pass sleep is an injected instant fake; the runtime's
 * `runSubprocess` is a throwing spy that must never fire.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AdvanceLaneRunPort,
  AdvanceLaneRunRequest,
  AdvanceLaneRunResult,
  AttemptRecord,
  BaseBranchValue,
  LaneRunStateValue,
} from '@fleet/work-execution';
import {
  AdvanceLaneRunUseCase,
  CancelPreparedAttemptUseCase,
  CONDUCTOR_LEASE_MS,
  LANE_RUN_TERMINAL_STATES,
  PrepareFixAttemptUseCase,
  RunConductorPassUseCase,
  laneRunJournalState,
  sha256HexDigest,
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
  // SEC-5b-1: collect reads the frozen manifest digest-verified, so the seeded
  // attempt carries the digest of the dry-run fake's frozen prose and manifest.
  briefDigest: createHash('sha256').update(DRY_RUN_BRIEF_PROSE + '\n' + DRY_RUN_MANIFEST_JSON, 'utf8').digest('hex'),
  briefPackagePath: '.lane/brief.md',
  sessionId: null,
  completionReceipt: null,
  artifacts: null,
  seatPlan: SEAT_PLAN,
  seatSelection: SEAT_SELECTION,
  // Q2a-2: a conducted attempt always carries its runner host (KF-10 stamps it
  // at start), so the seeded start does too; without one the act guard parks.
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

function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-v2-conductor-driver-crash-resume-test-'));
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
const HOLDER_CRASH = 'driver-crash-1';
const HOLDER_RESUME = 'driver-resume-2';

/** Build one isolated world: a temp state dir, a seeded run, and the dry-run advance over the real file stores. */
async function startScenario(): Promise<Scenario> {
  const dir = tempStateDir();
  const runSubprocess = vi.fn(throwingRunSubprocess);
  const runtime = createFleetCliRuntime({ stateDir: dir, runSubprocess });
  await seedCompletedStart(runtime);
  const clock = makeClock();
  const fakes = createDryRunFakes(
    { attemptRepo: runtime.execution.attemptRepository, executionJournal: runtime.execution.executionJournal },
    clock.now,
  );
  const advance = new AdvanceLaneRunUseCase({
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
    autoMergeAttempt: fakes.autoMergeAttempt,
    parkNotice: fakes.parkNotice,
    autoMergeEnabled: true,
  });
  return { dir, runtime, fakes, clock, advance, runSubprocess };
}

/** A non-crashing counting wrapper: the control's total advance-call count is N. */
class CountingAdvance implements AdvanceLaneRunPort {
  readonly calls: AdvanceLaneRunRequest[] = [];
  constructor(private readonly inner: AdvanceLaneRunPort) {}
  async advanceLaneRun(request: AdvanceLaneRunRequest): Promise<AdvanceLaneRunResult> {
    this.calls.push(request);
    return this.inner.advanceLaneRun(request);
  }
}

/** The crash seam at the step boundary: throw on the k-th advance call, before the inner advance runs. */
class CrashyAdvance implements AdvanceLaneRunPort {
  readonly calls: AdvanceLaneRunRequest[] = [];
  constructor(
    private readonly inner: AdvanceLaneRunPort,
    private readonly crashOnCall: number,
  ) {}
  async advanceLaneRun(request: AdvanceLaneRunRequest): Promise<AdvanceLaneRunResult> {
    this.calls.push(request);
    if (this.calls.length === this.crashOnCall) {
      throw new Error('injected crash at advance call ' + String(this.crashOnCall));
    }
    return this.inner.advanceLaneRun(request);
  }
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

/** Drive passes until the injected crash rejects one, asserting the fixed message, then stop (no releaseLeases). */
async function runUntilCrash(scenario: Scenario, pass: RunConductorPassUseCase, boundary: number): Promise<void> {
  const injected = 'injected crash at advance call ' + String(boundary);
  for (let index = 0; index < 12; index += 1) {
    let rejected = false;
    try {
      const result = await pass.runPass({ holderId: HOLDER_CRASH, nowIso: scenario.clock.now() });
      if (result.outcome !== 'completed') {
        throw new Error('pass refused: ' + result.reason);
      }
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(injected);
      rejected = true;
    }
    if (rejected) {
      return;
    }
    if (await isTerminal(scenario)) {
      throw new Error('the run reached a terminal state before the crash');
    }
    scenario.clock.advanceMs(60_000);
  }
  throw new Error('the injected crash never fired within the pass budget');
}

const READ_PORTS = new Set(['runnerForAttempt', 'findLatestReceiptOfKind', 'ciState', 'forgeRead']);

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

async function deriveMetrics(scenario: Scenario): Promise<DriveMetrics> {
  const entries = await scenario.runtime.conductor.laneRunJournal.listForRun(RUN_ID);
  const record = await scenario.runtime.conductor.laneRunRepository.get(RUN_ID);
  const resultKeys = entries
    .filter((entry) => entry.kind === 'result' && entry.key !== null)
    .map((entry) => entry.key as string)
    .sort()
    .filter((key, index, keys) => index === 0 || key !== keys[index - 1]);
  return {
    terminalState: await journalStateOf(scenario),
    resultKeys,
    tally: oneWayTally(scenario.fakes.recorder.calls),
    parkIsNull: record !== null && record.parked === null,
  };
}

interface BaselineMetrics extends DriveMetrics {
  readonly advanceCalls: number;
}

/** The control drive: one scenario, the unwrapped advance counted, to terminal. */
async function runBaseline(): Promise<BaselineMetrics> {
  const scenario = await startScenario();
  try {
    const counting = new CountingAdvance(scenario.advance);
    const pass = driverFor(scenario, counting);
    await runPasses(scenario, pass, HOLDER_CONTROL);
    const metrics = await deriveMetrics(scenario);
    return { ...metrics, advanceCalls: counting.calls.length };
  } finally {
    rmSync(scenario.dir, { recursive: true, force: true });
  }
}

/** Crash at boundary k, lapse the crashed holder's leases, then resume with a fresh driver to terminal. */
async function crashAndResume(boundary: number): Promise<DriveMetrics> {
  const scenario = await startScenario();
  try {
    const crashPass = driverFor(scenario, new CrashyAdvance(scenario.advance, boundary));
    await runUntilCrash(scenario, crashPass, boundary);
    scenario.clock.advanceMs(CONDUCTOR_LEASE_MS + 60_000);
    const resumePass = driverFor(scenario, scenario.advance);
    await runPasses(scenario, resumePass, HOLDER_RESUME);
    const metrics = await deriveMetrics(scenario);
    return metrics;
  } finally {
    rmSync(scenario.dir, { recursive: true, force: true });
  }
}

function expectSameDrive(actual: DriveMetrics, baseline: BaselineMetrics): void {
  expect(actual.terminalState).toBe(baseline.terminalState);
  expect(actual.resultKeys).toEqual(baseline.resultKeys);
  expect(actual.tally).toEqual(baseline.tally);
  expect(actual.parkIsNull).toBe(true);
}

function expectExplicitCounts(tally: Record<string, number>): void {
  expect(tally.dispatch).toBe(1);
  expect(tally.reviewRequest).toBe(2);
  expect(tally.executeForgeAction).toBe(2);
  expect(tally.autoMergeAttempt).toBe(1);
}

describe('conductor driver crash and resume at every step boundary', () => {
  afterEach(() => {
    for (const dir of CREATED_DIRS.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('T1: the baseline completes over the real file stores and dispatches no subprocess', async () => {
    const scenario = await startScenario();
    try {
      const pass = driverFor(scenario, scenario.advance);
      await runPasses(scenario, pass, HOLDER_CONTROL);
      expect(await journalStateOf(scenario)).toBe('merged');
      expect(scenario.runSubprocess).not.toHaveBeenCalled();
    } finally {
      rmSync(scenario.dir, { recursive: true, force: true });
    }
  });

  it('T2: every boundary crash then lapsed-lease resume reaches the baseline drive with the one-way tally intact', async () => {
    const baseline = await runBaseline();
    const N = baseline.advanceCalls;
    expect(N).toBeGreaterThan(0);
    for (let boundary = 1; boundary <= N; boundary += 1) {
      const metrics = await crashAndResume(boundary);
      expectSameDrive(metrics, baseline);
      expectExplicitCounts(metrics.tally);
    }
  }, 120_000);

  it('T3: the resume lease comes from a fresh clock read and a fence above the crashed holder', async () => {
    const scenario = await startScenario();
    try {
      const crashPass = driverFor(scenario, new CrashyAdvance(scenario.advance, 1));
      await runUntilCrash(scenario, crashPass, 1);
      scenario.clock.advanceMs(CONDUCTOR_LEASE_MS + 60_000);
      const resumeAt = scenario.clock.now();
      const resumePass = driverFor(scenario, scenario.advance);
      const resume = await resumePass.runPass({ holderId: HOLDER_RESUME, nowIso: resumeAt });
      expect(resume.outcome).toBe('completed');
      const lease = await scenario.runtime.conductor.driverLease.read();
      expect(lease?.holderId).toBe(HOLDER_RESUME);
      expect(lease!.fence).toBeGreaterThan(1);
      expect(lease!.leaseUntilIso).toBe(new Date(Date.parse(resumeAt) + CONDUCTOR_LEASE_MS).toISOString());
    } finally {
      rmSync(scenario.dir, { recursive: true, force: true });
    }
  });

  it('T4: a crashing pass rejects with the fixed message and records no request data', async () => {
    const boundary = 5;
    const scenario = await startScenario();
    try {
      const crashPass = driverFor(scenario, new CrashyAdvance(scenario.advance, boundary));
      let rejection: unknown = null;
      try {
        await crashPass.runPass({ holderId: HOLDER_CRASH, nowIso: scenario.clock.now() });
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toBe('injected crash at advance call 5');
      for (const call of scenario.fakes.recorder.calls) {
        for (const key of Object.keys(call)) {
          expect(['port', 'attemptId', 'recordedHostName', 'requestId']).toContain(key);
        }
      }
    } finally {
      rmSync(scenario.dir, { recursive: true, force: true });
    }
  });

  it('T5: after a crash at the final boundary the terminal-state filter skips the run', async () => {
    const baseline = await runBaseline();
    const N = baseline.advanceCalls;
    const scenario = await startScenario();
    try {
      const crashPass = driverFor(scenario, new CrashyAdvance(scenario.advance, N));
      await runUntilCrash(scenario, crashPass, N);
      scenario.clock.advanceMs(CONDUCTOR_LEASE_MS + 60_000);
      const resumeCounting = new CountingAdvance(scenario.advance);
      const resumePass = driverFor(scenario, resumeCounting);
      await runPasses(scenario, resumePass, HOLDER_RESUME);
      expect(await isTerminal(scenario)).toBe(true);
      expect(resumeCounting.calls).toHaveLength(0);
    } finally {
      rmSync(scenario.dir, { recursive: true, force: true });
    }
  });
});
