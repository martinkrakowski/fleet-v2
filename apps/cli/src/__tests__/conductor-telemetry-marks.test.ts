// Conductor telemetry marks (OT5): the live driver marks exactly the advanced
// runs of a completed pass, never skipped or refused reports, never on the
// dry-run path, and with telemetry unconfigured the composed mark is the
// no-op and the run is byte-identical to before.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveConductorPolicy, type FleetInstallation } from '@fleet/installation';
import {
  NoopRunTelemetryMarkAdapter,
  type ConductorRunReport,
  type RunConductorPassResult,
} from '@fleet/work-execution';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli } from '../index.js';
import type { CliIo } from '../index.js';
import type { ConductorCliOptions } from '../conductor.js';
import type { ConductorDriver } from '../conductor-wiring.js';

const NOW = '2026-10-27T10:00:00.000Z';
const RUN_ID_A = 'run-01JB0000000000000000000000';
const RUN_ID_B = 'run-01JC0000000000000000000000';
const SKIPPED_RUN_ID = 'run-01JD0000000000000000000000';

/** A spy runner: `conductor` must never dispatch a subprocess in tests. */
function throwingRunSubprocess(): never {
  throw new Error('the conductor must never dispatch a subprocess');
}

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-v2-conductor-telemetry-marks-'));
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

/** A completed pass whose runs are exactly the given reports. */
function completedPass(runs: readonly ConductorRunReport[]): RunConductorPassResult {
  return { outcome: 'completed', halted: false, progressed: true, runs, attention: [] };
}

/** A scripted fake driver with an enabled conductor policy, like conductor-run.test.ts. */
function makeFakeDriver(passes: readonly RunConductorPassResult[]): { readonly driver: ConductorDriver } {
  const passCalls: unknown[] = [];
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
    start: null,
    policy: resolveConductorPolicy({ conductor: { enabled: true } }),
    runPolicyRevision: 'policy:conductor@0123456789ab',
  };
  return { driver };
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
    env: {},
  });
}

/** The runtime with a recording mark port replacing the composed one (OT5). */
function runtimeWithRecordingMark(runtime: FleetCliRuntime, marks: Array<{ kind: string; runId?: string }>): FleetCliRuntime {
  const telemetry = {
    ...runtime.telemetry,
    mark: {
      mark: (target: { kind: string; runId?: string }) => {
        marks.push(target);
      },
    },
  };
  return { ...runtime, telemetry } as FleetCliRuntime;
}

describe('conductor run telemetry marks (OT5)', () => {
  it('marks exactly the advanced runs of a completed pass, never skipped reports', async () => {
    const dir = tempStateDir();
    const marks: Array<{ kind: string; runId?: string }> = [];
    const runtime = runtimeWithRecordingMark(runtimeOf(dir), marks);
    const advancedA = { runId: RUN_ID_A, outcome: 'advanced' as const, steps: [{ outcome: 'entered' as const, state: 'running' as const }] };
    const advancedB = { runId: RUN_ID_B, outcome: 'advanced' as const, steps: [{ outcome: 'entered' as const, state: 'running' as const }] };
    const skipped = { runId: SKIPPED_RUN_ID, outcome: 'skipped' as const, reason: 'lease-held' as const };
    const fake = makeFakeDriver([completedPass([advancedA, advancedB, skipped])]);

    const result = await runConductor(runtime, ['run', '--live', '--once'], {
      stateDir: dir,
      buildDriver: () => fake.driver,
    });

    expect(result.code).toBe(0);
    expect(marks.map((mark) => mark.runId).sort()).toEqual([RUN_ID_A, RUN_ID_B].sort());
    expect(marks.every((mark) => mark.kind === 'run')).toBe(true);
  });

  it('a dry-run run calls mark zero times', async () => {
    const dir = tempStateDir();
    const marks: Array<{ kind: string; runId?: string }> = [];
    const runtime = runtimeWithRecordingMark(runtimeOf(dir), marks);

    const result = await runConductor(runtime, ['run', '--dry-run', '--once'], { stateDir: dir });

    expect(result.code).toBe(0);
    expect(marks).toEqual([]);
  });

  it('with telemetry unconfigured the composed mark is the no-op and the run is unchanged', async () => {
    const dir = tempStateDir();
    const runtime = runtimeOf(dir);
    expect(runtime.telemetry.mark).toBeInstanceOf(NoopRunTelemetryMarkAdapter);
    expect(runtime.telemetry.startExporter).toBeNull();
    expect(runtime.telemetry.stopExporter).toBeNull();

    const advanced = { runId: RUN_ID_A, outcome: 'advanced' as const, steps: [] };
    const fake = makeFakeDriver([completedPass([advanced])]);
    const result = await runConductor(runtime, ['run', '--live', '--once'], {
      stateDir: dir,
      buildDriver: () => fake.driver,
    });

    expect(result.code).toBe(0);
    // O9: with no installation, the live run reports register-unknown once.
    expect(result.stderr).toEqual([`${JSON.stringify({ orchestrator: 'register-unknown' })}\n`]);
    expect(result.stdout).toHaveLength(1);
    expect(JSON.parse(result.stdout[0]!)).toMatchObject({ pass: 1, outcome: 'completed' });
  });
});
