// Conductor CLI control tests — K7-4.
/**
 * The four record-only subcommands over a file-backed runtime: status lists
 * lane runs with the halt marker and the driver lease, halt sets or lifts
 * the kill switch, stop records a graceful (or forced) stop the driver obeys,
 * resume records a resume of a parked run. Nothing here dispatches: the
 * runtime is built with a `runSubprocess` spy that throws if called.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  LaneRun,
  laneRunConductEntry,
  type LaneRunParkRecord,
  type LaneRunRecord,
  type LaneRunJournalEntryRecord,
} from '@fleet/work-execution';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli } from '../index.js';
import type { CliIo } from '../index.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const RUN_ID_UNKNOWN = 'run-01JB0000000000000000000009';
const NOW = '2026-10-27T10:00:00.000Z';
const LEASE_UNTIL = '2026-10-27T10:05:00.000Z';
const ENTRY_1 = '01JB0000000000000000000001';
const HOLDER = 'driver-example-1';

const PARKED: LaneRunParkRecord = {
  reason: 'halted',
  qualifier: null,
  parkedFrom: 'gating',
  questionId: null,
};

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

function runRecord(overrides: Partial<LaneRunRecord> = {}): LaneRunRecord {
  const result = LaneRun.create({ ...BASE_RECORD, ...overrides });
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error('fixture must be a valid LaneRun record');
  }
  return result.value.toRecord();
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

/** A spy runner: the conductor's record-only controls must never dispatch. */
function throwingRunSubprocess(): never {
  throw new Error('the conductor must never dispatch a subprocess');
}

function makeRuntime(stateDir: string): FleetCliRuntime {
  return createFleetCliRuntime({ stateDir, runSubprocess: throwingRunSubprocess });
}

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-v2-conductor-test-'));
}

/** Run one CLI invocation and return its exit code and parsed stdout JSON. */
async function runConductor(
  runtime: FleetCliRuntime,
  args: readonly string[],
  /** null runs with no durable state directory. */
  stateDir: string | null = '/state-dir-example',
): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
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
    stateDir === null ? { now: () => NOW } : { now: () => NOW, stateDir },
  );
  return { code, stdout: io.outLines, stderr: io.errLines };
}

/** One JSON document on stdout. */
function parseDocument(lines: readonly string[]): Record<string, unknown> {
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

/** A plain run, revision 1, no lease, no journal entries. */
async function seedPlainRun(
  runtime: FleetCliRuntime,
  overrides: Partial<LaneRunRecord> = {},
): Promise<void> {
  const record = runRecord(overrides);
  expect(await runtime.conductor.laneRunRepository.create(record)).toMatchObject({ outcome: 'saved' });
}

/** A run parked `halted` (parkCount 1) at revision 2, leased by the driver, with its parked conduct. */
async function seedParkedRun(runtime: FleetCliRuntime): Promise<void> {
  await seedPlainRun(runtime);
  expect(
    await runtime.conductor.laneRunRepository.acquireLease(RUN_ID, {
      holderId: HOLDER,
      observedFence: 0,
      leaseUntilIso: LEASE_UNTIL,
      nowIso: NOW,
    }),
  ).toMatchObject({ outcome: 'saved' });
  expect(
    await runtime.conductor.laneRunRepository.save(
      runRecord({
        parked: PARKED,
        parkCount: 1,
        revision: 2,
        lease: { holderId: HOLDER, fence: 1, leaseUntilIso: LEASE_UNTIL },
      }),
      { holderId: HOLDER, fence: 1, nowIso: NOW },
    ),
  ).toMatchObject({ outcome: 'saved' });
  const entry: LaneRunJournalEntryRecord = laneRunConductEntry(ENTRY_1, RUN_ID, 'parked', NOW);
  expect(await runtime.conductor.laneRunJournal.append(entry)).toMatchObject({ outcome: 'appended' });
}

describe('fleet-v2 conductor (K7-4)', () => {
  it('status lists the seeded run with the halt marker clear', async () => {
    const runtime = makeRuntime(tempStateDir());
    await seedPlainRun(runtime);
    const result = await runConductor(runtime, ['status']);
    expect(result.code).toBe(0);
    const document = parseDocument(result.stdout);
    expect(document).toMatchObject({ outcome: 'listed', halt: 'clear' });
    const runs = document.runs as readonly Record<string, unknown>[];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ runId: RUN_ID, workOrderId: 'wo-example-1' });
  });

  it('status shows the run base branch, with main for a seeded record without the key (CB1)', async () => {
    const runtime = makeRuntime(tempStateDir());
    await seedPlainRun(runtime, { baseBranch: 'chain/example' });
    const result = await runConductor(runtime, ['status']);
    expect(result.code).toBe(0);
    const runs = (parseDocument(result.stdout).runs as readonly Record<string, unknown>[])[0];
    expect(runs).toMatchObject({ runId: RUN_ID, baseBranch: 'chain/example' });

    const withoutKey = makeRuntime(tempStateDir());
    await seedPlainRun(withoutKey);
    const plain = await runConductor(withoutKey, ['status']);
    expect(plain.code).toBe(0);
    const plainRuns = (parseDocument(plain.stdout).runs as readonly Record<string, unknown>[])[0];
    expect(plainRuns).toMatchObject({ runId: RUN_ID, baseBranch: 'main' });
  });

  it('halt sets and lifts the kill switch; status shows it', async () => {
    const runtime = makeRuntime(tempStateDir());
    await seedPlainRun(runtime);
    const set = await runConductor(runtime, ['halt']);
    expect(set.code).toBe(0);
    expect(parseDocument(set.stdout)).toEqual({ outcome: 'recorded', halted: true, changed: true });
    const status = await runConductor(runtime, ['status']);
    expect(status.code).toBe(0);
    expect(parseDocument(status.stdout)).toMatchObject({ halt: 'halted' });
    const lift = await runConductor(runtime, ['halt', '--lift']);
    expect(lift.code).toBe(0);
    expect(parseDocument(lift.stdout)).toEqual({ outcome: 'recorded', halted: false, changed: true });
  });

  it('stop records graceful, then force; a graceful stop after a force is refused', async () => {
    const runtime = makeRuntime(tempStateDir());
    await seedPlainRun(runtime);
    const first = await runConductor(runtime, ['stop', RUN_ID]);
    expect(first.code).toBe(0);
    expect(parseDocument(first.stdout)).toMatchObject({ outcome: 'stop-recorded', mode: 'graceful' });
    const again = await runConductor(runtime, ['stop', RUN_ID]);
    expect(again.code).toBe(0);
    expect(parseDocument(again.stdout)).toMatchObject({ outcome: 'already-requested', mode: 'graceful' });
    const forced = await runConductor(runtime, ['stop', RUN_ID, '--force']);
    expect(forced.code).toBe(0);
    expect(parseDocument(forced.stdout)).toMatchObject({ outcome: 'stop-recorded', mode: 'force' });
    const afterForce = await runConductor(runtime, ['stop', RUN_ID]);
    expect(afterForce.code).toBe(1);
    expect(parseDocument(afterForce.stdout)).toMatchObject({ outcome: 'refused', reason: 'stop-already-forced' });
  });

  it('stop refuses a stale revision, a missing run id, a bad revision and an unknown run', async () => {
    const runtime = makeRuntime(tempStateDir());
    await seedPlainRun(runtime);
    const stale = await runConductor(runtime, ['stop', RUN_ID, '--revision', '99']);
    expect(stale.code).toBe(1);
    expect(parseDocument(stale.stdout)).toMatchObject({ outcome: 'refused', reason: 'stale-revision' });
    const noId = await runConductor(runtime, ['stop']);
    expect(noId.code).toBe(2);
    expect(noId.stderr[0]).toContain('requires a run id');
    const badRevision = await runConductor(runtime, ['stop', RUN_ID, '--revision', 'abc']);
    expect(badRevision.code).toBe(2);
    expect(badRevision.stderr[0]).toContain('--revision');
    const unknown = await runConductor(runtime, ['stop', RUN_ID_UNKNOWN]);
    expect(unknown.code).toBe(1);
    expect(parseDocument(unknown.stdout)).toMatchObject({ outcome: 'not-found', runId: RUN_ID_UNKNOWN });
  });

  it('resume refuses a non-parked run and records a parked run', async () => {
    const plain = makeRuntime(tempStateDir());
    await seedPlainRun(plain);
    const notParked = await runConductor(plain, ['resume', RUN_ID]);
    expect(notParked.code).toBe(1);
    expect(parseDocument(notParked.stdout)).toMatchObject({ outcome: 'refused', reason: 'not-parked' });

    const parked = makeRuntime(tempStateDir());
    await seedParkedRun(parked);
    const resumed = await runConductor(parked, ['resume', RUN_ID]);
    expect(resumed.code).toBe(0);
    expect(parseDocument(resumed.stdout)).toMatchObject({
      outcome: 'resume-recorded',
      runId: RUN_ID,
      to: 'gating',
    });
  });

  it('halt, stop and resume without a durable state directory are usage errors; status still reads', async () => {
    const runtime = makeRuntime(tempStateDir());
    await seedParkedRun(runtime);
    for (const args of [['halt'], ['halt', '--lift'], ['stop', RUN_ID], ['resume', RUN_ID]]) {
      const result = await runConductor(runtime, args, null);
      expect(result.code).toBe(2);
      expect(result.stdout).toEqual([]);
      expect(result.stderr.join('')).toContain('needs a durable state directory');
    }
    expect((await runConductor(runtime, ['status'], null)).code).toBe(0);
  });

  it('a flag or run id the subcommand does not take is a usage error, never silently ignored', async () => {
    const runtime = makeRuntime(tempStateDir());
    await seedParkedRun(runtime);
    for (const args of [
      ['stop', RUN_ID, '--lift'],
      ['halt', '--force'],
      ['halt', '--revision', '2'],
      ['halt', RUN_ID],
      ['resume', RUN_ID, '--force'],
      ['status', '--lift'],
    ]) {
      const result = await runConductor(runtime, args);
      expect(result.code).toBe(2);
      expect(result.stdout).toEqual([]);
    }
  });

  it('prints help naming every subcommand and refuses an unknown one', async () => {
    const runtime = makeRuntime(tempStateDir());
    const help = await runConductor(runtime, ['--help']);
    expect(help.code).toBe(0);
    const helpText = help.stdout.join('').replace(/\s+/g, ' ');
    for (const subcommand of ['status', 'halt', 'stop', 'resume']) {
      expect(helpText).toContain(subcommand);
    }
    expect(helpText).toContain('graceful by default');
    expect(helpText).toContain('never stops a running lane');
    const unknown = await runConductor(runtime, ['frob']);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr[0]).toContain('Unknown conductor subcommand');
  });

  it('persists the records: a second runtime on the same directory reads the stop and the halt', async () => {
    const stateDir = tempStateDir();
    const first = makeRuntime(stateDir);
    await seedPlainRun(first);
    expect((await runConductor(first, ['halt'])).code).toBe(0);
    expect((await runConductor(first, ['stop', RUN_ID])).code).toBe(0);
    const second = makeRuntime(stateDir);
    const status = await runConductor(second, ['status']);
    expect(status.code).toBe(0);
    const document = parseDocument(status.stdout);
    expect(document).toMatchObject({ halt: 'halted' });
    const runs = document.runs as readonly Record<string, unknown>[];
    expect(runs[0]).toMatchObject({ runId: RUN_ID, stopMode: 'graceful' });
  });

  it('dispatches nothing: the runSubprocess spy never throws across the controls', async () => {
    const runtime = makeRuntime(tempStateDir());
    await seedPlainRun(runtime);
    expect((await runConductor(runtime, ['status'])).code).toBe(0);
    expect((await runConductor(runtime, ['halt'])).code).toBe(0);
    expect((await runConductor(runtime, ['halt', '--lift'])).code).toBe(0);
    expect((await runConductor(runtime, ['stop', RUN_ID, '--force'])).code).toBe(0);
    expect((await runConductor(runtime, ['resume', RUN_ID])).code).toBe(1);
    expect((await runConductor(runtime, ['resume', RUN_ID, '--revision', '2'])).code).toBe(1);
  });
});
