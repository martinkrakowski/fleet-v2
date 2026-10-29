// Conductor `run --dry-run` tests — K7-8.
/**
 * The dry-run copies the state directory's execution and conductor stores into
 * a scratch directory and drives them with recording fakes, printing what the
 * driver would do. Every test uses fakes only: no subprocess runs, no runner,
 * executor or forge adapter is composed, and the real state directory is never
 * opened for writing.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { AttemptRecord } from '@fleet/work-execution';
import {
  buildLaneRunStepKey,
  laneRunConductEntry,
  laneRunIntentEntry,
  laneRunResultEntry,
} from '@fleet/work-execution';
import type { FleetInstallation } from '@fleet/installation';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli } from '../index.js';
import type { CliIo } from '../index.js';
import type { ConductorCliOptions } from '../conductor.js';
import type { DryRunFakes } from '../conductor-dry-run.js';

// Capture the dry-run fakes the CLI composes, so a test can read the recorder
// without the dry-run printing it (the scratch stores are removed on return).
const capturedFakes = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../conductor-dry-run.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../conductor-dry-run.js')>();
  return {
    ...actual,
    createDryRunFakes: (
      ...args: Parameters<typeof actual.createDryRunFakes>
    ): ReturnType<typeof actual.createDryRunFakes> => {
      const fakes = actual.createDryRunFakes(...args);
      capturedFakes.current = fakes;
      return fakes;
    },
  };
});

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
  briefDigest: 'c'.repeat(64),
  briefPackagePath: '.lane/brief-package',
  sessionId: null,
  completionReceipt: null,
  artifacts: null,
  seatPlan: SEAT_PLAN,
  seatSelection: SEAT_SELECTION,
  stopReason: 'none',
  createdAtIso: NOW,
  updatedAtIso: NOW,
};

/** A spy runner: the dry-run must never dispatch a subprocess. */
function throwingRunSubprocess(): never {
  throw new Error('the conductor must never dispatch a subprocess');
}

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-v2-conductor-dry-run-test-'));
}

interface CapturedIo extends CliIo {
  readonly outLines: string[];
  readonly errLines: string[];
}

function captureIo(): CapturedIo {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    stdout: (text: string) => {
      outLines.push(text);
    },
    stderr: (text: string) => {
      errLines.push(text);
    },
  };
}

function runtimeOf(stateDir?: string, installation?: FleetInstallation): FleetCliRuntime {
  return createFleetCliRuntime({
    ...(stateDir !== undefined ? { stateDir } : {}),
    ...(installation !== undefined ? { installation } : {}),
    runSubprocess: throwingRunSubprocess,
  });
}

interface RunResult {
  readonly code: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

async function runConductor(
  runtime: FleetCliRuntime,
  args: readonly string[],
  cliOptions: Omit<ConductorCliOptions, 'now'> = {},
): Promise<RunResult> {
  const io = captureIo();
  const code = await runCli(
    ['conductor', ...args],
    io,
    runtime,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { now: () => NOW, ...cliOptions },
  );
  return { code, stdout: io.outLines, stderr: io.errLines };
}

/** A `sleep` that resolves at once, records each delay and aborts the stop signal. */
function recorderSleep(delays: number[], abortAfter: number, controller: AbortController) {
  return async (ms: number): Promise<void> => {
    delays.push(ms);
    if (delays.length >= abortAfter) {
      controller.abort();
    }
  };
}

/** What a completed `conductor start` leaves: a work order, a held reservation, the intent-recorded attempt, the run. */
async function seedCompletedStart(runtime: FleetCliRuntime): Promise<void> {
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
  });
  expect(run.outcome).toBe('saved');
}

/** The head commit the dry-run collect fake records, in 12-nibble form. */
const FIX_HEAD12 = 'd'.repeat(12);

/**
 * A run already in `fixing` after a gate failure at the collected head: a
 * collected round-0 attempt and the gate intent/result/conduct journal entries,
 * so the dry-run driver's first advance is the fix-round `act prepare`.
 */
async function seedFixRoundStart(runtime: FleetCliRuntime): Promise<void> {
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
  await runtime.execution.attemptRepository.saveAttempt({
    id: ATTEMPT_ID,
    workOrderId: 'wo-example-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: WORKTREE,
    baseCommit: 'a'.repeat(40),
    state: 'collected',
    outcome: null,
    revision: 1,
    briefDigest: 'c'.repeat(64),
    briefPackagePath: '.lane/brief.md',
    sessionId: null,
    completionReceipt: {
      attemptId: ATTEMPT_ID,
      sessionId: 'session-example-1',
      endedAtIso: NOW,
      authoritative: true,
      exitStatus: 0,
      stoppedByRequest: false,
    },
    artifacts: {
      headCommit: 'd'.repeat(40),
      commitsSinceBase: ['d'.repeat(40)],
      collectedArtifactPaths: [],
      notes: 'present',
    },
    seatPlan: SEAT_PLAN,
    seatSelection: SEAT_SELECTION,
    stopReason: 'none',
    createdAtIso: NOW,
    updatedAtIso: NOW,
  });
  const run = await runtime.conductor.laneRunRepository.create({
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
  });
  expect(run.outcome).toBe('saved');
  const gateKey = buildLaneRunStepKey({
    runId: RUN_ID,
    round: 0,
    step: 'gate',
    seatIndex: 0,
    attemptOrdinal: null,
    head12: FIX_HEAD12,
    retry: null,
  });
  expect(gateKey.ok).toBe(true);
  if (gateKey.ok) {
    const journal = runtime.conductor.laneRunJournal;
    await journal.append(laneRunIntentEntry(runtime.conductor.newUlid(), RUN_ID, gateKey.key, null, NOW));
    await journal.append(laneRunResultEntry(runtime.conductor.newUlid(), RUN_ID, gateKey.key, 'completed', 'gate-failed', NOW));
    await journal.append(laneRunConductEntry(runtime.conductor.newUlid(), RUN_ID, 'fixing', NOW));
  }
}

/** sha256 of every file currently in `dir`, keyed by file name. */
function hashStateFiles(dir: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  const names = readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort();
  for (const name of names) {
    hashes[name] = createHash('sha256').update(readFileSync(join(dir, name))).digest('hex');
  }
  return hashes;
}

/** Scratch directories of the dry-run currently present under the OS temp dir. */
function dryRunScratchDirs(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('fleet-v2-conductor-dry-run-'));
}

/** The `would` lines of stdout, in order. */
function wouldLines(stdout: readonly string[]): Array<Record<string, unknown>> {
  return stdout
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((parsed): parsed is Record<string, unknown> => parsed !== null && 'would' in parsed);
}

/** The `entered` lines of stdout, in order. */
function enteredLines(stdout: readonly string[]): Array<Record<string, unknown>> {
  return stdout
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((parsed): parsed is Record<string, unknown> => parsed !== null && 'entered' in parsed);
}

/** A parsed pass line of stdout (the `{ pass, ...result }` document). */
interface PassLine {
  readonly pass: number;
  readonly outcome: string;
  readonly halted: boolean;
  readonly progressed: boolean;
  readonly runs: ReadonlyArray<{
    readonly runId: string;
    readonly outcome: string;
    readonly steps: ReadonlyArray<Record<string, unknown>>;
  }>;
  readonly attention: readonly unknown[];
}

/** The pass lines of stdout, in order. */
function passLines(stdout: readonly string[]): PassLine[] {
  return stdout
    .map((line) => {
      try {
        return JSON.parse(line) as PassLine;
      } catch {
        return null;
      }
    })
    .filter((parsed): parsed is PassLine => parsed !== null && typeof parsed.pass === 'number');
}

describe('conductor run --dry-run (K7-8)', () => {
  it('drives a seeded run end to end over a scratch copy, printing would and entered lines, and reaches no host', async () => {
    const dir = tempStateDir();
    const runSubprocess = vi.fn(throwingRunSubprocess);
    const runtime = createFleetCliRuntime({ stateDir: dir, runSubprocess });
    await seedCompletedStart(runtime);
    const beforeHashes = hashStateFiles(dir);
    const beforeScratch = dryRunScratchDirs();

    const controller = new AbortController();
    const delays: number[] = [];
    const result = await runConductor(runtime, ['run', '--dry-run'], {
      stateDir: dir,
      stopSignal: controller.signal,
      sleep: recorderSleep(delays, 4, controller),
    });

    expect(result.code).toBe(0);
    const would = wouldLines(result.stdout);
    expect(would.map((line) => line.would)).toEqual([
      'dispatch', 'collect', 'gate', 'brief-check', 'code-review', 'accept', 'open-pr', 'merge',
    ]);
    expect(would[0]).toMatchObject({ key: `${RUN_ID}/r0/dispatch/0/a1`, result: 'completed', reasonCode: 'dispatch-started' });
    expect(would[1]).toMatchObject({ key: `${RUN_ID}/r0/collect/0`, result: 'completed', reasonCode: 'collected' });
    expect(would[2]).toMatchObject({ key: `${RUN_ID}/r0/gate/0@dddddddddddd`, result: 'completed', reasonCode: 'gate-passed' });
    expect(would[3]).toMatchObject({ key: `${RUN_ID}/r0/brief-check/0@dddddddddddd`, result: 'completed', reasonCode: 'review-passed' });
    expect(would[4]).toMatchObject({ key: `${RUN_ID}/r0/code-review/0@dddddddddddd`, result: 'completed', reasonCode: 'review-passed' });
    // K6-8: the seeded run then accepts the head, opens the PR through the
    // conductor grant and merges it through the auto-merge fake.
    expect(would[5]).toMatchObject({ key: `${RUN_ID}/r0/accept/0@dddddddddddd`, result: 'completed', reasonCode: 'accepted' });
    expect(would[6]).toMatchObject({ key: `${RUN_ID}/r0/open-pr/0@dddddddddddd`, result: 'completed', reasonCode: 'pr-opened' });
    expect(would[7]).toMatchObject({ key: `${RUN_ID}/r0/merge/0@dddddddddddd`, result: 'completed', reasonCode: 'merged' });
    // The entered states the driver would enter, in order: dispatch, run,
    // collect, gate, both reviews, then the K6 acceptance → PR → CI → merge
    // window, all the way to merged.
    const entered = enteredLines(result.stdout);
    expect(entered.map((line) => line.entered)).toEqual([
      'dispatching',
      'running',
      'collecting',
      'gating',
      'brief-check',
      'code-review',
      'accepting',
      'awaiting-premerge',
      'opening-pr',
      'watching-ci',
      'merging',
      'merged',
    ]);
    expect(entered[entered.length - 1]).toMatchObject({ runId: RUN_ID });

    const passes = passLines(result.stdout);
    expect(passes.length >= 1).toBe(true);
    const firstPass = passes[0];
    expect(firstPass.runs).toHaveLength(1);
    expect(firstPass.runs[0].outcome).toBe('advanced');
    // The seeded run is done: the run reached merged, and the decider's final
    // step is the pass's done marker — never a park.
    const allSteps = passes.flatMap((pass) => pass.runs.flatMap((run) => run.steps));
    expect(allSteps.some((step) => step.outcome === 'parked')).toBe(false);
    expect(allSteps[allSteps.length - 1]).toEqual({ outcome: 'done' });
    // The K6 journal results, in order somewhere across the passes: the head
    // accepted, the PR opened, the run merged.
    const acted = allSteps.filter((step) => step.outcome === 'acted');
    expect(acted.map((step) => step.step)).toEqual(
      expect.arrayContaining(['accept', 'open-pr', 'merge']),
    );
    expect(acted.map((step) => step.reasonCode)).toEqual(
      expect.arrayContaining(['accepted', 'pr-opened', 'merged']),
    );

    // Each review opened the evidence assessment and then issued its request,
    // in that order, under a minted request id the act journalled first.
    const fakes = capturedFakes.current as DryRunFakes | null;
    expect(fakes).not.toBeNull();
    const calls = fakes!.recorder.calls;
    const ports = calls.map((call) => call.port);
    const gateIndex = ports.indexOf('gate');
    expect(ports.slice(gateIndex + 1, gateIndex + 5)).toEqual([
      'reviewAssessment',
      'reviewRequest',
      'reviewAssessment',
      'reviewRequest',
    ]);
    const requestIds = calls
      .filter((call) => call.port === 'reviewRequest')
      .map((call) => call.requestId);
    expect(requestIds).toHaveLength(2);
    for (const requestId of requestIds) {
      expect(requestId).toMatch(/^review-/);
    }
    expect(requestIds[0]).not.toBe(requestIds[1]);
    // K6-8: after the reviews the conductor reads the facts, accepts the
    // head, grants its push, opens the PR and merges through the fakes —
    // every call recorded, none reaching a real port.
    expect(ports.slice(ports.lastIndexOf('reviewRequest') + 1)).toEqual([
      'acceptanceAssessment',
      'findLatestReceiptOfKind', 'ciState', 'forgeRead',
      'findLatestReceiptOfKind', 'ciState', 'forgeRead',
      'acceptanceAssessment',
      'conductorForgeGrant', 'executeForgeAction',
      'findLatestReceiptOfKind', 'ciState', 'forgeRead',
      'findLatestReceiptOfKind', 'ciState', 'forgeRead',
      'findLatestReceiptOfKind', 'ciState', 'forgeRead',
      'autoMergeAttempt',
      'findLatestReceiptOfKind', 'ciState', 'forgeRead',
    ]);

    // The real state is untouched, the scratch directory is gone, and no
    // subprocess ever ran.
    expect(hashStateFiles(dir)).toEqual(beforeHashes);
    expect(dryRunScratchDirs()).toEqual(beforeScratch);
    expect(runSubprocess).not.toHaveBeenCalled();
  });

  it('never dispatches for real: the composed execution ports are never called', async () => {
    const dir = tempStateDir();
    const runtime = runtimeOf(dir);
    await seedCompletedStart(runtime);

    const dispatchSpy = vi.spyOn(runtime.execution.dispatchAttempt, 'dispatchAttempt');
    const stopSpy = vi.spyOn(runtime.execution.stopAttempt, 'stopAttempt');
    const reconcileSpy = vi.spyOn(runtime.execution.reconcileAttempt, 'reconcileAttempt');
    const collectSpy = vi.spyOn(runtime.execution.collectAttemptArtifacts, 'collectAttemptArtifacts');

    const controller = new AbortController();
    const result = await runConductor(runtime, ['run', '--dry-run', '--once'], {
      stateDir: dir,
      stopSignal: controller.signal,
      sleep: async () => undefined,
    });

    expect(result.code).toBe(0);
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();
    expect(reconcileSpy).not.toHaveBeenCalled();
    expect(collectSpy).not.toHaveBeenCalled();
  });

  it('without a state directory runs over in-memory stores: exit 0, one pass line with no runs', async () => {
    const result = await runConductor(runtimeOf(), ['run', '--dry-run', '--once'], {
      sleep: async () => undefined,
    });
    expect(result.code).toBe(0);
    expect(wouldLines(result.stdout)).toEqual([]);
    expect(enteredLines(result.stdout)).toEqual([]);
    const passes = passLines(result.stdout);
    expect(passes).toHaveLength(1);
    expect(passes[0]).toMatchObject({ pass: 1, outcome: 'completed', runs: [] });
  });

  it('a halted state directory parks the run halted before any dispatch', async () => {
    const dir = tempStateDir();
    const runtime = runtimeOf(dir);
    await seedCompletedStart(runtime);
    await runtime.conductor.halt.set({ halted: true, nowIso: NOW });

    const controller = new AbortController();
    const result = await runConductor(runtime, ['run', '--dry-run', '--once'], {
      stateDir: dir,
      stopSignal: controller.signal,
      sleep: async () => undefined,
    });

    expect(result.code).toBe(0);
    expect(wouldLines(result.stdout)).toEqual([]);
    expect(enteredLines(result.stdout).map((line) => line.entered)).toEqual(['parked']);
    const passes = passLines(result.stdout);
    expect(passes).toHaveLength(1);
    const steps = passes[0].runs[0].steps;
    expect(steps[steps.length - 1]).toEqual({ outcome: 'parked', reason: 'halted', qualifier: null });
  });

  it('--dry-run with enabled absent is allowed; --dry-run --live stays a usage error', async () => {
    const dir = tempStateDir();
    const runtime = runtimeOf(dir);
    const allowed = await runConductor(runtime, ['run', '--dry-run', '--once'], {
      stateDir: dir,
      sleep: async () => undefined,
    });
    expect(allowed.code).toBe(0);
    const usage = await runConductor(runtime, ['run', '--dry-run', '--live']);
    expect(usage.code).toBe(2);
  });

  it('a failing scratch copy exits 1 with a fixed message naming no path, and leaves the real state untouched', async () => {
    const dir = tempStateDir();
    const runtime = runtimeOf(dir);
    await seedCompletedStart(runtime);
    const beforeHashes = hashStateFiles(dir);
    const beforeScratch = dryRunScratchDirs();

    const result = await runConductor(runtime, ['run', '--dry-run'], {
      stateDir: dir,
      copyFile: async () => {
        throw new Error('example copy failure');
      },
    });

    expect(result.code).toBe(1);
    const stderr = result.stderr.join('');
    expect(stderr).toContain('could not copy the state stores');
    expect(stderr).not.toContain(dir);
    expect(hashStateFiles(dir)).toEqual(beforeHashes);
    expect(dryRunScratchDirs()).toEqual(beforeScratch);
  });

  it('drives a seeded fix round: the prepare brief fake is called and the fix attempt prepares (KF-6)', async () => {
    const dir = tempStateDir();
    const runtime = runtimeOf(dir);
    await seedFixRoundStart(runtime);

    const controller = new AbortController();
    const result = await runConductor(runtime, ['run', '--dry-run', '--once'], {
      stateDir: dir,
      stopSignal: controller.signal,
      sleep: async () => undefined,
    });

    expect(result.code).toBe(0);
    const would = wouldLines(result.stdout);
    const prepareLine = would.find((line) => line.would === 'prepare');
    expect(prepareLine).toMatchObject({ result: 'completed', reasonCode: 'prepared' });
    expect(prepareLine?.key).toMatch(/\/r1\/prepare\//);

    const fakes = capturedFakes.current as DryRunFakes | null;
    expect(fakes).not.toBeNull();
    const calls = fakes!.recorder.calls;
    const briefCalls = calls.filter((call) => call.port === 'prepareBrief');
    expect(briefCalls.length).toBeGreaterThan(0);
    expect(briefCalls[0]?.attemptId).toMatch(/^attempt-/);
  });
});
