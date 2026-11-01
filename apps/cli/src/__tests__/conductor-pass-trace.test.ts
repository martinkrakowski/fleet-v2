// Conductor pass-trace CLI tests — VZ5b.
/**
 * `conductor run --live` appends one trace per completed pass to
 * `<stateDir>/conductor-passes.json` with the three limits the CLI knows; a
 * failed append prints one line and the loop continues; the dry-run and a
 * refused pass write nothing. `conductor schedule --passes` lists the recorded
 * passes newest first without the holder id.
 */

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  resolveConductorPolicy,
  type FleetInstallation,
  type ForgeSectionV2,
} from '@fleet/installation';
import type {
  AbandonStartResult,
  RunConductorPassRequest,
  RunConductorPassResult,
  StartLaneRunResult,
} from '@fleet/work-execution';
import { ConductorPassTraceAdapter } from '@fleet/work-execution';
import type { ConductorPassTracePort } from '@fleet/work-execution';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli } from '../index.js';
import type { CliIo } from '../index.js';
import type { ConductorCliOptions } from '../conductor.js';
import { LIVE_DISPATCH_STAGGER_MS, type ConductorDriver } from '../conductor-wiring.js';

const NOW = '2026-10-27T10:00:00.000Z';
const FORGE_NONE: ForgeSectionV2 = { mode: 'none' };

/** Minimal v2 installation with the conductor enabled. */
function makeInstallation(): FleetInstallation {
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
    policy: { conductor: { enabled: true } },
  };
}

function throwingRunSubprocess(): never {
  throw new Error('the conductor must never dispatch a subprocess');
}

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-v2-conductor-pass-trace-'));
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

/** A scripted completed pass result. */
function completedPass(): RunConductorPassResult {
  return {
    outcome: 'completed',
    halted: false,
    progressed: false,
    runs: [],
    attention: [],
  };
}

interface FakeDriver {
  readonly driver: ConductorDriver;
  readonly passCalls: RunConductorPassRequest[];
}

/** A fake `ConductorDriver` with an optional passTrace seam. */
function makeFakeDriver(options: {
  readonly enabled: boolean;
  readonly passes?: readonly RunConductorPassResult[];
  readonly passTrace?: Pick<ConductorPassTracePort, 'append'>;
}): FakeDriver {
  const passes = options.passes ?? [];
  const passCalls: RunConductorPassRequest[] = [];
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
      releaseLeases: async () => ({ released: 0 }),
    },
    start: {
      startLaneRun: async (request): Promise<StartLaneRunResult> => ({
        outcome: 'started',
        runId: request.runId,
        attemptId: request.attemptId,
        hostName: 'host-example-1',
        worktreePath: '/tmp/fleet-k7-worktrees/example',
      }),
      abandonStart: async (_request): Promise<AbandonStartResult> => ({
        outcome: 'abandoned',
        capacity: 'released',
        attemptCancelled: false,
      }),
    },
    policy: resolveConductorPolicy(
      options.enabled ? { conductor: { enabled: true } } : undefined,
    ),
    runPolicyRevision: 'policy:conductor@0123456789ab',
    ...(options.passTrace === undefined ? {} : { passTrace: options.passTrace }),
  };
  return { driver, passCalls };
}

/** A `sleep` that resolves at once and aborts the stop signal after N sleeps. */
function recorderSleep(delays: number[], abortAfter: number, controller: AbortController) {
  return async (ms: number): Promise<void> => {
    delays.push(ms);
    if (delays.length >= abortAfter) {
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

function runtimeOf(stateDir: string): FleetCliRuntime {
  return createFleetCliRuntime({
    stateDir,
    installation: makeInstallation(),
    runSubprocess: throwingRunSubprocess,
    env: {},
  });
}

/** The recorded traces of a state directory, in stored (oldest-first) order. */
function readTraces(dir: string): Array<Record<string, unknown>> {
  const raw = readFileSync(join(dir, 'conductor-passes.json'), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('trace file must be an array');
  }
  return parsed;
}

describe('conductor run --live pass traces (VZ5b)', () => {
  it('records one completed pass with the limits and the test clock', async () => {
    const dir = tempStateDir();
    const result = await runConductor(runtimeOf(dir), ['run', '--live', '--once', '--max-active-runs', '2'], {
      stateDir: dir,
    });
    expect(result.code).toBe(0);
    expect(result.stderr.join('\n')).not.toContain('pass trace not recorded');
    const traces = readTraces(dir);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      maxActiveRuns: 2,
      passConcurrency: 1,
      dispatchStaggerMs: 20000,
      nowIso: NOW,
    });
    expect(traces[0].holderId).toMatch(/^driver-/);
  });

  it('records the pass-concurrency flag on the trace', async () => {
    const dir = tempStateDir();
    const result = await runConductor(runtimeOf(dir), [
      'run',
      '--live',
      '--once',
      '--max-active-runs',
      '2',
      '--pass-concurrency',
      '2',
    ], { stateDir: dir });
    expect(result.code).toBe(0);
    const traces = readTraces(dir);
    expect(traces[0]).toMatchObject({
      maxActiveRuns: 2,
      passConcurrency: 2,
      dispatchStaggerMs: 20000,
    });
  });

  it('a refused pass writes no trace and exits 1', async () => {
    const dir = tempStateDir();
    const fake = makeFakeDriver({ enabled: true, passes: [{ outcome: 'refused', reason: 'driver-lease-held' }] });
    const result = await runConductor(runtimeOf(dir), ['run', '--live'], {
      stateDir: dir,
      buildDriver: () => fake.driver,
    });
    expect(result.code).toBe(1);
    expect(existsSync(join(dir, 'conductor-passes.json'))).toBe(false);
  });

  it('a dry-run writes no trace file', async () => {
    const dir = tempStateDir();
    const result = await runConductor(runtimeOf(dir), ['run', '--dry-run', '--once'], {
      stateDir: dir,
    });
    expect(result.code).toBe(0);
    expect(existsSync(join(dir, 'conductor-passes.json'))).toBe(false);
  });

  it('a not-recorded append prints exactly one line and the loop continues', async () => {
    const dir = tempStateDir();
    const fake = makeFakeDriver({
      enabled: true,
      passes: [completedPass()],
      passTrace: { append: async () => ({ outcome: 'not-recorded', reason: 'write-failed' }) },
    });
    const result = await runConductor(runtimeOf(dir), ['run', '--live', '--once'], {
      stateDir: dir,
      buildDriver: () => fake.driver,
    });
    expect(result.code).toBe(0);
    expect(fake.passCalls).toHaveLength(1);
    expect(result.stdout.filter((line) => line.startsWith('{"pass"'))).toHaveLength(1);
    expect(
      result.stderr.filter((line) => line === 'conductor run: pass trace not recorded (write-failed)\n'),
    ).toHaveLength(1);
  });

  it('two scripted passes both run when the trace append refuses', async () => {
    const dir = tempStateDir();
    const fake = makeFakeDriver({
      enabled: true,
      passes: [completedPass(), completedPass()],
      passTrace: { append: async () => ({ outcome: 'not-recorded', reason: 'write-failed' }) },
    });
    const controller = new AbortController();
    const result = await runConductor(runtimeOf(dir), ['run', '--live'], {
      stateDir: dir,
      buildDriver: () => fake.driver,
      stopSignal: controller.signal,
      sleep: recorderSleep([], 2, controller),
    });
    expect(result.code).toBe(0);
    expect(fake.passCalls).toHaveLength(2);
    expect(result.stdout.filter((line) => line.startsWith('{"pass"'))).toHaveLength(2);
  });

  it('a throwing append prints the same single line and the loop continues', async () => {
    const dir = tempStateDir();
    const fake = makeFakeDriver({
      enabled: true,
      passes: [completedPass()],
      passTrace: {
        append: async () => {
          throw new Error('boom');
        },
      },
    });
    const result = await runConductor(runtimeOf(dir), ['run', '--live', '--once'], {
      stateDir: dir,
      buildDriver: () => fake.driver,
    });
    expect(result.code).toBe(0);
    expect(result.stdout.filter((line) => line.startsWith('{"pass"'))).toHaveLength(1);
    expect(
      result.stderr.filter((line) => line === 'conductor run: pass trace not recorded (write-failed)\n'),
    ).toHaveLength(1);
  });

  it('keeps at most 32 traces when 33 passes complete', async () => {
    const dir = tempStateDir();
    const passes = Array.from({ length: 33 }, () => completedPass());
    const fake = makeFakeDriver({
      enabled: true,
      passes,
      passTrace: new ConductorPassTraceAdapter({
        stateDir: dir,
        limits: { maxActiveRuns: 2, passConcurrency: 1, dispatchStaggerMs: 20000 },
      }),
    });
    const controller = new AbortController();
    const result = await runConductor(runtimeOf(dir), ['run', '--live'], {
      stateDir: dir,
      buildDriver: () => fake.driver,
      stopSignal: controller.signal,
      sleep: recorderSleep([], 33, controller),
    });
    expect(result.code).toBe(0);
    expect(fake.passCalls).toHaveLength(33);
    expect(readTraces(dir)).toHaveLength(32);
  });

  it('the trace file carries no secrets or paths', async () => {
    const dir = tempStateDir();
    await runConductor(runtimeOf(dir), ['run', '--live', '--once', '--max-active-runs', '2'], {
      stateDir: dir,
    });
    const text = readFileSync(join(dir, 'conductor-passes.json'), 'utf8');
    for (const forbidden of ['sshAlias', 'worktreePath', 'transport', dir]) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe('conductor schedule --passes (VZ5b)', () => {
  it('--json --passes lists the recorded pass with the cap and no holder id', async () => {
    const dir = tempStateDir();
    const first = await runConductor(runtimeOf(dir), ['run', '--live', '--once', '--max-active-runs', '2'], {
      stateDir: dir,
    });
    expect(first.code).toBe(0);
    const result = await runConductor(runtimeOf(dir), ['schedule', '--json', '--passes'], {
      stateDir: dir,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toHaveLength(1);
    const doc = JSON.parse(result.stdout[0]!) as {
      schedule: { caps: { maxActiveRuns: number } };
      passes: { outcome: string; passes: Array<Record<string, unknown>> };
    };
    expect(doc.schedule.caps.maxActiveRuns).toBe(2);
    expect(doc.passes.outcome).toBe('listed');
    expect(doc.passes.passes).toHaveLength(1);
    expect(JSON.stringify(doc)).not.toContain('holderId');
  });

  it('text mode prints the recorded count', async () => {
    const dir = tempStateDir();
    await runConductor(runtimeOf(dir), ['run', '--live', '--once', '--max-active-runs', '2'], {
      stateDir: dir,
    });
    const result = await runConductor(runtimeOf(dir), ['schedule', '--passes'], {
      stateDir: dir,
    });
    expect(result.code).toBe(0);
    expect(result.stdout.join('\n')).toContain('passes 1 recorded');
    expect(result.stdout.join('\n')).toContain('cap 2');
  });

  it('a repeated --passes is a usage error', async () => {
    const dir = tempStateDir();
    const result = await runConductor(runtimeOf(dir), ['schedule', '--passes', '--passes'], {
      stateDir: dir,
    });
    expect(result.code).toBe(2);
  });
});

describe('LIVE_DISPATCH_STAGGER_MS', () => {
  it('equals the use-case default of 20000', () => {
    expect(LIVE_DISPATCH_STAGGER_MS).toBe(20_000);
  });
});
