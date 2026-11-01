// Conductor CLI schedule tests — VZ2.
/**
 * `fleet-v2 conductor schedule` is a read-only view of the live lane runs:
 * text and --json modes share the same use case, the JSON result is redacted
 * of lease and reservation secrets, and the command never writes a state
 * directory.
 */

import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  LaneRun,
  type LaneRunRecord,
  type CapacityReservationRecord,
  type WorkOrderRecord,
} from '@fleet/work-execution';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli } from '../index.js';
import type { CliIo } from '../index.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const ATTEMPT_ID = 'attempt-live-1';
const NOW = '2026-10-27T10:00:00.000Z';
const WO_ID = 'wo-acme-repo';

const BASE_RECORD = {
  version: 1,
  runId: RUN_ID,
  workOrderId: WO_ID,
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
};

function runRecord(): LaneRunRecord {
  const result = LaneRun.create(BASE_RECORD);
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error('fixture must be a valid LaneRun record');
  }
  return result.value.toRecord();
}

const WORK_ORDER: WorkOrderRecord = {
  id: WO_ID,
  projectId: 'project-acme',
  taskId: 'task-1',
  laneId: 'lane-1',
  repository: 'acme/repo',
  baseCommit: 'a'.repeat(40),
  ownedPaths: ['packages/a/x.ts'],
  policyRevision: 'policy-example-1',
  prerequisiteWorkOrderIds: [],
  state: 'approved',
  revision: 1,
  createdAtIso: NOW,
  updatedAtIso: NOW,
};

const RESERVATION: CapacityReservationRecord = {
  id: 'res-live-1',
  attemptId: ATTEMPT_ID,
  hostId: 'host-id-sol',
  slotIndex: 0,
  held: true,
  seatTool: 'opencode',
  hostName: 'sol',
  hostKind: 'opencode',
  transport: 'ssh',
  sshAlias: 'alias-secret',
  port: 4166,
  worktreePath: '/srv/wt/run-1',
  reservedAtIso: NOW,
  releasedAtIso: null,
};

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

/** A spy runner: conductor schedule is read-only and must never dispatch. */
function throwingRunSubprocess(): never {
  throw new Error('the conductor must never dispatch a subprocess');
}

function makeRuntime(stateDir: string): FleetCliRuntime {
  return createFleetCliRuntime({ stateDir, runSubprocess: throwingRunSubprocess });
}

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-v2-conductor-schedule-test-'));
}

/** Run one `conductor schedule` invocation and return its exit code and captured output. */
async function runSchedule(
  runtime: FleetCliRuntime,
  args: readonly string[],
): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  const io = captureIo();
  const code = await runCli(
    ['conductor', 'schedule', ...args],
    io,
    runtime,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { now: () => NOW, stateDir: '/state-dir-example' },
  );
  return { code, stdout: io.outLines, stderr: io.errLines };
}

/** One live run holding the reservation of 5c, over a file-backed state directory. */
async function seedLiveRun(runtime: FleetCliRuntime): Promise<void> {
  expect(
    await runtime.conductor.laneRunRepository.create(runRecord()),
  ).toMatchObject({ outcome: 'saved' });
  await runtime.execution.workOrderRepository.saveWorkOrder(WORK_ORDER);
  await runtime.execution.executionJournal.saveCapacityReservation(RESERVATION);
}

describe('fleet-v2 conductor schedule (VZ2)', () => {
  it('--json prints the listed schedule, redacted', async () => {
    const runtime = makeRuntime(tempStateDir());
    await seedLiveRun(runtime);
    const result = await runSchedule(runtime, ['--json']);
    expect(result.code).toBe(0);
    expect(result.stdout).toHaveLength(1);
    const document = JSON.parse(result.stdout[0]!) as Record<string, unknown>;
    expect(document).toMatchObject({ outcome: 'listed' });
    const schedule = document.schedule as Record<string, unknown>;
    const rows = schedule.rows as readonly Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ runId: RUN_ID });
    expect(schedule.admission).toMatchObject({ active: 1 });
    for (const forbidden of ['alias-secret', '4166', '/srv/wt/run-1', 'holderId', 'sshAlias', 'transport', 'worktreePath']) {
      expect(result.stdout[0]).not.toContain(forbidden);
    }
  });

  it('text mode prints the summary and the live run row', async () => {
    const runtime = makeRuntime(tempStateDir());
    await seedLiveRun(runtime);
    const result = await runSchedule(runtime, []);
    expect(result.code).toBe(0);
    expect(result.stdout[0]).toContain('admission 1 active + 0 in flight / cap not recorded');
    const rowLine = result.stdout.find((line) => line.startsWith(`${RUN_ID} `));
    expect(rowLine).toBeDefined();
    expect(rowLine).toContain(' sol#0 ');
    expect(rowLine).toContain('packages/a');
  });

  it('empty state prints no live runs and exits 0', async () => {
    const runtime = makeRuntime(tempStateDir());
    const result = await runSchedule(runtime, []);
    expect(result.code).toBe(0);
    expect(result.stdout.some((line) => line.includes('no live runs'))).toBe(true);
  });

  it('usage errors for unknown flags, positionals and repeated --json', async () => {
    const runtime = makeRuntime(tempStateDir());
    const bogus = await runSchedule(runtime, ['--bogus']);
    expect(bogus.code).toBe(2);
    expect(bogus.stderr.join('')).toContain('conductor schedule takes only --json');
    const positional = await runSchedule(runtime, [RUN_ID]);
    expect(positional.code).toBe(2);
    expect(positional.stderr.join('')).toContain('conductor schedule takes only --json');
    const repeated = await runSchedule(runtime, ['--json', '--json']);
    expect(repeated.code).toBe(2);
  });

  it('help lists the schedule command', async () => {
    const runtime = makeRuntime(tempStateDir());
    const io = captureIo();
    const code = await runCli(
      ['conductor', 'help'],
      io,
      runtime,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { now: () => NOW, stateDir: '/state-dir-example' },
    );
    expect(code).toBe(0);
    expect(io.outLines.join('')).toContain('fleet-v2 conductor schedule [--json]');
  });

  it('writes nothing to the state directory', async () => {
    const stateDir = tempStateDir();
    const runtime = makeRuntime(stateDir);
    await seedLiveRun(runtime);
    const before = readdirSync(stateDir).sort();
    const result = await runSchedule(runtime, ['--json']);
    expect(result.code).toBe(0);
    const after = readdirSync(stateDir).sort();
    expect(after).toEqual(before);
  });
});
