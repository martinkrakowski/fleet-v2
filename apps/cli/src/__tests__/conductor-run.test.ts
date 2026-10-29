// Conductor `start` and `run` CLI tests — K7-7.
/**
 * The two driver-side subcommands over fakes only: every test injects a
 * scripted `ConductorDriver` through `buildDriver` (or, for the live-wiring
 * tests, builds the real driver over a runtime whose `runSubprocess` spy
 * throws if called), and a `sleep` that resolves at once and records the
 * delays. No test dispatches a subprocess, touches a runner, an executor or
 * a forge, or reaches the network.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  conductorRevision,
  resolveConductorPolicy,
  type FleetInstallation,
  type ForgeSectionV2,
} from '@fleet/installation';
import type {
  AbandonStartRequest,
  AbandonStartResult,
  RunConductorPassRequest,
  RunConductorPassResult,
  StartLaneRunRequest,
  StartLaneRunResult,
} from '@fleet/work-execution';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli } from '../index.js';
import type { CliIo } from '../index.js';
import type { ConductorCliOptions } from '../conductor.js';
import { nextPollDelayMs } from '../conductor.js';
import { buildLiveConductorDriver, type ConductorDriver } from '../conductor-wiring.js';

const NOW = '2026-10-27T10:00:00.000Z';
const RUN_ID = 'run-01JB0000000000000000000000';
const ATTEMPT_ID = 'attempt-example-1';
const HOLDER = 'driver-example-1';
const BRIEF_FILE = 'brief-request-example-1.json';

const FORGE_NONE: ForgeSectionV2 = { mode: 'none' };

/** Minimal v2 installation (like forge-mode.test.ts) with an optional conductor policy. */
function makeInstallation(policy: { readonly conductorEnabled: boolean }): FleetInstallation {
  return {
    schemaVersion: 2,
    hosts: {
      local: {
        transport: 'local',
        worktreeRoot: '/tmp/fleet-k7-worktrees',
        roles: ['orchestrator', 'lane-runner'],
        runner: {
          kind: 'opencode',
          port: 46000,
          capabilities: {
            networkEgressRestricted: true,
            cpuAndMemoryLimited: true,
            processTreeTermination: true,
            filesystemScope: 'scoped-worktree',
          },
          maxLanes: 2,
        },
      },
    },
    forge: FORGE_NONE,
    ...(policy.conductorEnabled
      ? { policy: { conductor: { enabled: true } } }
      : {}),
  };
}

/** A spy runner: `conductor` must never dispatch a subprocess in tests. */
function throwingRunSubprocess(): never {
  throw new Error('the conductor must never dispatch a subprocess');
}

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-v2-conductor-run-test-'));
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

/** The brief payload `brief prepare --json` takes today, as a file for `--brief-request`. */
function briefFixture(): Record<string, unknown> {
  return {
    workOrderId: 'wo-example-1',
    projectId: 'project-example-1',
    taskId: 'task-example-1',
    laneId: 'lane-example-1',
    repository: 'repo-example-1',
    baseCommit: 'a'.repeat(40),
    policyRevision: 'policy-example-1',
    modelAssignment: {
      model: 'model-example-1',
      variant: 'default',
      fallbackModel: 'model-example-2',
      seatTool: 'opencode',
    },
    seatPlan: {
      version: 1,
      'first-pass': [{ id: 'fp-1', model: 'model-example-1', tool: 'opencode' }],
      fix: [{ id: 'fx-1', model: 'model-example-1', tool: 'opencode' }],
      review: [],
    },
    independentReviewer: 'reviewer-model-example-1',
    ownedPaths: ['packages/example/src'],
    permissions: [],
    acceptanceChecks: [],
    acceptanceSpec: {
      commitRequired: true,
      diffCheck: true,
      commands: [{ argv: ['node', '--eval', 'process.exit(0)'] }],
    },
    stepLimit: 40,
    timeLimitSeconds: 2700,
    resourceBounds: {},
    expectedArtifacts: [],
    ownerDecisionReferences: [],
    contextDecisions: [],
    prNotes: {
      hardToUndo: 'The conductor opens the PR and merges it automatically',
      assumptions: 'The base branch is main and CI passes',
      challengeThis: 'That the merge train is safe without a reviewer on the final diff',
    },
  };
}

function writeBriefRequest(dir: string, brief: Record<string, unknown>): string {
  const path = join(dir, BRIEF_FILE);
  writeFileSync(path, JSON.stringify(brief), 'utf8');
  return path;
}

/** A scripted pass result. */
function completedPass(
  overrides: Partial<Extract<RunConductorPassResult, { outcome: 'completed' }>> = {},
): RunConductorPassResult {
  return {
    outcome: 'completed',
    halted: false,
    progressed: false,
    runs: [],
    attention: [],
    ...overrides,
  };
}

interface FakeDriver {
  readonly driver: ConductorDriver;
  readonly passCalls: RunConductorPassRequest[];
  readonly releaseCalls: RunConductorPassRequest[];
  readonly startCalls: StartLaneRunRequest[];
  readonly abandonCalls: AbandonStartRequest[];
}

/** A fake `ConductorDriver`: a scripted `pass`, a recording `start`, a policy flag. */
function makeFakeDriver(options: {
  readonly enabled: boolean;
  readonly passes?: readonly RunConductorPassResult[];
  readonly startResult?: StartLaneRunResult;
  readonly abandonResult?: AbandonStartResult;
}): FakeDriver {
  const passes = options.passes ?? [];
  const passCalls: RunConductorPassRequest[] = [];
  const releaseCalls: RunConductorPassRequest[] = [];
  const startCalls: StartLaneRunRequest[] = [];
  const abandonCalls: AbandonStartRequest[] = [];
  const driver: ConductorDriver = {
    pass: {
      runPass: async (request) => {
        passCalls.push(request);
        const scripted = passes[passCalls.length - 1];
        if (scripted === undefined) {
          throw new Error('no scripted pass left');
        }
        return scripted;
      },
      releaseLeases: async (request) => {
        releaseCalls.push(request);
        return { released: 0 };
      },
    },
    start: {
      startLaneRun: async (request) => {
        startCalls.push(request);
        return (
          options.startResult ?? {
            outcome: 'started',
            runId: request.runId,
            attemptId: request.attemptId,
            hostName: 'host-example-1',
            worktreePath: '/tmp/fleet-k7-worktrees/example',
          }
        );
      },
      abandonStart: async (request) => {
        abandonCalls.push(request);
        return options.abandonResult ?? { outcome: 'abandoned', capacity: 'released', attemptCancelled: false };
      },
    },
    policy: resolveConductorPolicy(
      options.enabled ? { conductor: { enabled: true } } : undefined,
    ),
    runPolicyRevision: 'policy:conductor@0123456789ab',
  };
  return { driver, passCalls, releaseCalls, startCalls, abandonCalls };
}

/** A `sleep` that resolves at once, records each delay and can abort the stop signal. */
function recorderSleep(delays: number[], abortAfter: number | null, controller: AbortController) {
  return async (ms: number): Promise<void> => {
    delays.push(ms);
    if (abortAfter !== null && delays.length >= abortAfter) {
      controller.abort();
    }
  };
}

interface RunResult {
  readonly code: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

/** One CLI invocation against one runtime with the conductor test options. */
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

function runtimeOf(stateDir?: string, installation?: FleetInstallation): FleetCliRuntime {
  return createFleetCliRuntime({
    ...(stateDir !== undefined ? { stateDir } : {}),
    ...(installation !== undefined ? { installation } : {}),
    runSubprocess: throwingRunSubprocess,
  });
}

function parseDocument(lines: readonly string[]): Record<string, unknown> {
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

describe('conductor run usage (K7-7)', () => {
  it('no mode is a usage error', async () => {
    const result = await runConductor(runtimeOf(tempStateDir()), ['run']);
    expect(result.code).toBe(2);
  });

  it('both --live and --dry-run is a usage error', async () => {
    const result = await runConductor(runtimeOf(tempStateDir()), ['run', '--live', '--dry-run']);
    expect(result.code).toBe(2);
  });

  it('--live without a state directory is a usage error', async () => {
    const result = await runConductor(runtimeOf(), ['run', '--live']);
    expect(result.code).toBe(2);
    expect(result.stderr[0]).toContain('durable state directory');
  });

  it('--max-active-runs 0 is a usage error', async () => {
    const result = await runConductor(runtimeOf(tempStateDir()), [
      'run',
      '--live',
      '--max-active-runs',
      '0',
    ]);
    expect(result.code).toBe(2);
  });
});

describe('conductor run live loop (K7-7)', () => {
  it('refuses conductor-disabled before any pass', async () => {
    const dir = tempStateDir();
    const fake = makeFakeDriver({ enabled: false });
    const result = await runConductor(runtimeOf(dir), ['run', '--live', '--once'], {
      stateDir: dir,
      buildDriver: () => fake.driver,
    });
    expect(result.code).toBe(1);
    expect(parseDocument(result.stdout)).toEqual({ outcome: 'refused', reason: 'conductor-disabled' });
    expect(fake.passCalls).toHaveLength(0);
    expect(fake.releaseCalls).toHaveLength(0);
  });

  it('--once runs one pass and releases the leases', async () => {
    const dir = tempStateDir();
    const fake = makeFakeDriver({ enabled: true, passes: [completedPass()] });
    const delays: number[] = [];
    const result = await runConductor(runtimeOf(dir), ['run', '--live', '--once'], {
      stateDir: dir,
      buildDriver: () => fake.driver,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(result.code).toBe(0);
    expect(fake.passCalls).toHaveLength(1);
    expect(fake.passCalls[0]!.holderId).toMatch(/^driver-/);
    expect(fake.releaseCalls).toHaveLength(1);
    expect(delays).toHaveLength(0);
    expect(parseDocument(result.stdout)).toMatchObject({ pass: 1, outcome: 'completed' });
  });

  it('polls with back-off to the 2-minute cap and releases on the stop signal', async () => {
    const dir = tempStateDir();
    const fake = makeFakeDriver({
      enabled: true,
      passes: [completedPass(), completedPass(), completedPass(), completedPass()],
    });
    const controller = new AbortController();
    const delays: number[] = [];
    const result = await runConductor(runtimeOf(dir), ['run', '--live'], {
      stateDir: dir,
      buildDriver: () => fake.driver,
      stopSignal: controller.signal,
      sleep: recorderSleep(delays, 4, controller),
    });
    expect(result.code).toBe(0);
    expect(delays).toEqual([30000, 60000, 120000, 120000]);
    expect(fake.passCalls).toHaveLength(4);
    expect(fake.releaseCalls).toHaveLength(1);
  });

  it('a progressed pass resets the back-off to 30 seconds', async () => {
    const dir = tempStateDir();
    const fake = makeFakeDriver({
      enabled: true,
      passes: [completedPass(), completedPass({ progressed: true }), completedPass()],
    });
    const controller = new AbortController();
    const delays: number[] = [];
    const result = await runConductor(runtimeOf(dir), ['run', '--live'], {
      stateDir: dir,
      buildDriver: () => fake.driver,
      stopSignal: controller.signal,
      sleep: recorderSleep(delays, 3, controller),
    });
    expect(result.code).toBe(0);
    expect(delays).toEqual([30000, 30000, 60000]);
  });

  it('a refused pass exits 1 after releasing the leases', async () => {
    const dir = tempStateDir();
    const fake = makeFakeDriver({
      enabled: true,
      passes: [{ outcome: 'refused', reason: 'driver-lease-held' }],
    });
    const result = await runConductor(runtimeOf(dir), ['run', '--live'], {
      stateDir: dir,
      buildDriver: () => fake.driver,
      sleep: async () => undefined,
    });
    expect(result.code).toBe(1);
    expect(parseDocument(result.stdout)).toMatchObject({ pass: 1, outcome: 'refused' });
    expect(fake.releaseCalls).toHaveLength(1);
  });

  it('prints the same run grace attention item once per process', async () => {
    const dir = tempStateDir();
    const item = { runId: RUN_ID, kind: 'stop-grace-exceeded' as const };
    const fake = makeFakeDriver({
      enabled: true,
      passes: [
        completedPass({ progressed: true, attention: [item] }),
        completedPass({ progressed: true, attention: [item] }),
      ],
    });
    const controller = new AbortController();
    const result = await runConductor(runtimeOf(dir), ['run', '--live'], {
      stateDir: dir,
      buildDriver: () => fake.driver,
      stopSignal: controller.signal,
      sleep: recorderSleep([], 2, controller),
    });
    expect(result.code).toBe(0);
    const attentionLines = result.stdout.filter((line) => line.startsWith('{"attention"'));
    expect(attentionLines).toHaveLength(1);
    expect(JSON.parse(attentionLines[0]!)).toEqual({ attention: 'stop-grace-exceeded', runId: RUN_ID });
  });
});

describe('nextPollDelayMs (K7-7)', () => {
  it('follows the §3.1 back-off table', () => {
    expect(nextPollDelayMs(null, false)).toBe(30000);
    expect(nextPollDelayMs(30000, false)).toBe(60000);
    expect(nextPollDelayMs(120000, false)).toBe(120000);
    expect(nextPollDelayMs(120000, true)).toBe(30000);
  });
});

describe('conductor start (K7-7)', () => {
  it('starts with a fresh run and attempt id, carrying the parsed brief and the policy revision', async () => {
    const dir = tempStateDir();
    const briefPath = writeBriefRequest(dir, briefFixture());
    const fake = makeFakeDriver({ enabled: true });
    const revisionOfRuntime = (runtime: FleetCliRuntime): string =>
      'policy:conductor@' + conductorRevision(resolveConductorPolicy(runtime.installation?.policy));
    const result = await runConductor(
      runtimeOf(dir, makeInstallation({ conductorEnabled: true })),
      ['start', '--brief-request', briefPath, '--tier', '2'],
      {
        stateDir: dir,
        buildDriver: (runtime) => ({ ...fake.driver, runPolicyRevision: revisionOfRuntime(runtime) }),
      },
    );
    expect(result.code).toBe(0);
    expect(fake.startCalls).toHaveLength(1);
    const request = fake.startCalls[0]!;
    expect(request.runId).toMatch(/^run-[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(request.attemptId).toMatch(/^attempt-[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(request.tier).toBe(2);
    expect(request.brief).toEqual(briefFixture());
    expect(request.runPolicyRevision).toMatch(/^policy:conductor@[0-9a-f]{12}$/);
    expect(parseDocument(result.stdout)).toMatchObject({ outcome: 'started' });
  });

  it('reports an incomplete start with both ids and the retry line, exit 1', async () => {
    const dir = tempStateDir();
    const briefPath = writeBriefRequest(dir, briefFixture());
    const fake = makeFakeDriver({
      enabled: true,
      startResult: {
        outcome: 'incomplete',
        runId: RUN_ID,
        attemptId: ATTEMPT_ID,
        step: 'worktree',
        reason: 'worktree-git-refused',
      },
    });
    const result = await runConductor(runtimeOf(dir), ['start', '--brief-request', briefPath, '--tier', '2'], {
      stateDir: dir,
      buildDriver: () => fake.driver,
    });
    expect(result.code).toBe(1);
    const document = parseDocument(result.stdout);
    expect(document).toMatchObject({ outcome: 'incomplete', step: 'worktree', runId: RUN_ID, attemptId: ATTEMPT_ID });
    expect(document.retry).toBe(
      `conductor start --brief-request ${briefPath} --tier 2 --run-id ${RUN_ID} --attempt-id ${ATTEMPT_ID}`,
    );
  });

  it('a retry passes the given run and attempt ids unchanged', async () => {
    const dir = tempStateDir();
    const briefPath = writeBriefRequest(dir, briefFixture());
    const fake = makeFakeDriver({ enabled: true });
    const retryAttemptId = 'attempt-01JB0000000000000000000001';
    const result = await runConductor(
      runtimeOf(dir),
      ['start', '--brief-request', briefPath, '--tier', '2', '--run-id', RUN_ID, '--attempt-id', retryAttemptId],
      { stateDir: dir, buildDriver: () => fake.driver },
    );
    expect(result.code).toBe(0);
    expect(fake.startCalls[0]).toMatchObject({ runId: RUN_ID, attemptId: retryAttemptId });
  });

  it('--abandon reaches abandonStart with both ids and exits 0', async () => {
    const dir = tempStateDir();
    const fake = makeFakeDriver({ enabled: false });
    const result = await runConductor(runtimeOf(dir), [
      'start',
      '--abandon',
      '--run-id',
      RUN_ID,
      '--attempt-id',
      ATTEMPT_ID,
    ], { stateDir: dir, buildDriver: () => fake.driver });
    expect(result.code).toBe(0);
    expect(fake.abandonCalls).toHaveLength(1);
    expect(fake.abandonCalls[0]).toMatchObject({ runId: RUN_ID, attemptId: ATTEMPT_ID });
    expect(parseDocument(result.stdout)).toMatchObject({ outcome: 'abandoned' });
  });

  it('no-capacity exits 1', async () => {
    const dir = tempStateDir();
    const briefPath = writeBriefRequest(dir, briefFixture());
    const fake = makeFakeDriver({ enabled: true, startResult: { outcome: 'no-capacity' } });
    const result = await runConductor(runtimeOf(dir), ['start', '--brief-request', briefPath, '--tier', '2'], {
      stateDir: dir,
      buildDriver: () => fake.driver,
    });
    expect(result.code).toBe(1);
    expect(parseDocument(result.stdout)).toEqual({ outcome: 'no-capacity' });
  });

  it('a missing --tier, --run-id alone or a brief file with worktreePath are usage errors', async () => {
    const dir = tempStateDir();
    const briefPath = writeBriefRequest(dir, briefFixture());
    const fake = makeFakeDriver({ enabled: true });
    const options = { buildDriver: () => fake.driver };
    expect(
      (await runConductor(runtimeOf(dir), ['start', '--brief-request', briefPath], options)).code,
    ).toBe(2);
    expect(
      (
        await runConductor(
          runtimeOf(dir),
          ['start', '--brief-request', briefPath, '--tier', '2', '--run-id', RUN_ID],
          options,
        )
      ).code,
    ).toBe(2);
    const withWorktree = writeBriefRequest(dir, { ...briefFixture(), worktreePath: '/tmp/example' });
    expect(
      (await runConductor(runtimeOf(dir), ['start', '--brief-request', withWorktree, '--tier', '2'], options))
        .code,
    ).toBe(2);
    expect(fake.startCalls).toHaveLength(0);
  });
});

describe('conductor start guards (K7-7)', () => {
  it('a disabled conductor refuses before the brief file is read and the start port is called', async () => {
    const dir = tempStateDir();
    const fake = makeFakeDriver({ enabled: false });
    const result = await runConductor(runtimeOf(dir), [
      'start',
      '--brief-request',
      '/nonexistent-example/brief.json',
      '--tier',
      '2',
    ], { stateDir: dir, buildDriver: () => fake.driver });
    expect(result.code).toBe(1);
    expect(parseDocument(result.stdout)).toEqual({ outcome: 'refused', reason: 'conductor-disabled' });
    expect(fake.startCalls).toHaveLength(0);
  });

  it('start without a state directory is a usage error', async () => {
    const result = await runConductor(runtimeOf(), ['start', '--brief-request', '/x.json', '--tier', '2']);
    expect(result.code).toBe(2);
    expect(result.stderr[0]).toContain('durable state directory');
  });

  it('start --dry-run and start --live are usage errors', async () => {
    const dir = tempStateDir();
    expect((await runConductor(runtimeOf(dir), ['start', '--dry-run'])).code).toBe(2);
    expect((await runConductor(runtimeOf(dir), ['start', '--live'])).code).toBe(2);
  });

  it('start --abandon works while the conductor is disabled and without the enabled check', async () => {
    const dir = tempStateDir();
    const fake = makeFakeDriver({ enabled: false });
    const result = await runConductor(runtimeOf(dir), [
      'start',
      '--abandon',
      '--run-id',
      RUN_ID,
      '--attempt-id',
      ATTEMPT_ID,
    ], { stateDir: dir, buildDriver: () => fake.driver });
    expect(result.code).toBe(0);
    expect(fake.abandonCalls).toHaveLength(1);
  });

  it('a present halt marker does not block start', async () => {
    const dir = tempStateDir();
    const runtime = runtimeOf(dir, makeInstallation({ conductorEnabled: true }));
    expect(await runtime.conductor.halt.set({ halted: true, nowIso: NOW })).toMatchObject({
      outcome: 'changed',
    });
    const briefPath = writeBriefRequest(dir, briefFixture());
    const fake = makeFakeDriver({ enabled: true });
    const result = await runConductor(runtime, ['start', '--brief-request', briefPath, '--tier', '1'], {
      stateDir: dir,
      buildDriver: () => fake.driver,
    });
    expect(result.code).toBe(0);
    expect(parseDocument(result.stdout)).toMatchObject({ outcome: 'started' });
  });
});

describe('the live wiring reaches no host in tests (K7-7)', () => {
  it('start over a runtime with no installation refuses no-host and never dispatches', async () => {
    const dir = tempStateDir();
    const runtime = runtimeOf(dir);
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
    expect(
      await runtime.coordination.registerProjectProfile.registerProjectProfile({
        projectId: 'project-example-1',
        displayName: 'Example Project',
        repository: 'repo-example-1',
        designatedDispatcherHost: 'orchestrator-example',
        policyRevision: 'policy-example-1',
        maxConcurrentLanes: 2,
        runnerCapabilities: {},
        nowIso: NOW,
      }),
    ).toMatchObject({ outcome: 'registered' });
    const driver = buildLiveDriver(runtime);
    const result = await driver.start!.startLaneRun({
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      tier: 2,
      runPolicyRevision: 'policy:conductor@0123456789ab',
      brief: briefFixture() as never,
      nowIso: NOW,
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'no-host' });
  });

  it('the live wiring builds and dispatches nothing on an empty state directory', async () => {
    const runtime = runtimeOf(tempStateDir());
    const driver = buildLiveDriver(runtime, 1);
    const pass = await driver.pass.runPass({ holderId: HOLDER, nowIso: NOW });
    expect(pass).toMatchObject({ outcome: 'completed', halted: false, progressed: false, runs: [] });
    // The pass took the driver lease, so releasing releases exactly it.
    expect(await driver.pass.releaseLeases({ holderId: HOLDER, nowIso: NOW })).toEqual({ released: 1 });
    expect(driver.policy.enabled).toBe(false);
  });
});

/** Build the real live driver (the same call the CLI makes without the test seam). */
function buildLiveDriver(runtime: FleetCliRuntime, maxActiveRuns = 1): ConductorDriver {
  return buildLiveConductorDriver(runtime, { maxActiveRuns });
}
