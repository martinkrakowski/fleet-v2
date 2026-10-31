// EX-1a: `attempt cancel-prepared` — the operator's cancel for a prepared,
// never-dispatched attempt. It refuses a live conducted run that owns the
// attempt, allows a stray one, and never touches a non-prepared attempt.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { laneRunConductEntry, type AttemptRecord, type LaneRunRecord } from '@fleet/work-execution';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli, type CliIo } from '../index.js';

const tempStateDirs: string[] = [];

afterAll(() => {
  for (const dir of tempStateDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const NOW = '2026-10-27T10:00:00.000Z';

async function cli(
  runtime: FleetCliRuntime,
  argv: string[],
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  const code = await runCli(
    argv,
    io,
    runtime,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { now: () => NOW },
  );
  return { code, out: out.join(''), err: err.join('') };
}

function makeAttempt(id: string, overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id,
    workOrderId: 'wo-example-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/wt/example',
    baseCommit: 'a'.repeat(40),
    state: 'intent-recorded',
    outcome: null,
    briefDigest: null,
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    createdAtIso: NOW,
    updatedAtIso: NOW,
    ...overrides,
  } as AttemptRecord;
}

function runRecord(runId: string, attemptIds: string[], overrides: Partial<LaneRunRecord> = {}): LaneRunRecord {
  return {
    version: 1,
    runId,
    workOrderId: 'wo-example-1',
    tier: 2,
    seatPlanRef: 'a'.repeat(64),
    cursors: { 'first-pass': null, fix: null, review: null },
    round: 0,
    attemptIds,
    prNumber: null,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 1,
    runPolicyRevision: 'policy-example-1',
    ...overrides,
  } as LaneRunRecord;
}

async function attemptState(runtime: FleetCliRuntime, attemptId: string): Promise<string> {
  const attempt = await runtime.execution.attemptRepository.findAttemptById(attemptId);
  expect(attempt).not.toBeNull();
  return attempt!.state as string;
}

async function seedPreparedAttempt(
  runtime: FleetCliRuntime,
  attemptId: string,
): Promise<void> {
  await runtime.execution.attemptRepository.saveAttempt(makeAttempt(attemptId));
}

async function seedRun(
  runtime: FleetCliRuntime,
  runId: string,
  attemptIds: string[],
): Promise<void> {
  await runtime.conductor.laneRunRepository.create(runRecord(runId, attemptIds));
}

describe('attempt cancel-prepared (EX-1a)', () => {
  it('refuses without --yes and leaves the attempt intent-recorded', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-cancel-prepared-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await seedPreparedAttempt(runtime, 'attempt-cancel-yes-1');

    const result = await cli(runtime, [
      'attempt',
      'cancel-prepared',
      '--attempt-id',
      'attempt-cancel-yes-1',
    ]);
    expect(result.code).toBe(2);
    expect(result.err).toContain('attempt cancel-prepared needs --yes');

    expect(await attemptState(runtime, 'attempt-cancel-yes-1')).toBe('intent-recorded');
  });

  it('treats a bare --attempt-id as a usage error, not the id "true"', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-cancel-prepared-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });

    const result = await cli(runtime, ['attempt', 'cancel-prepared', '--attempt-id', '--yes']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('attempt cancel-prepared needs --attempt-id');
  });

  it('cancels a stray prepared attempt with --yes', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-cancel-prepared-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await seedPreparedAttempt(runtime, 'attempt-cancel-stray-1');

    const result = await cli(runtime, [
      'attempt',
      'cancel-prepared',
      '--attempt-id',
      'attempt-cancel-stray-1',
      '--yes',
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).outcome).toBe('cancelled');

    expect(await attemptState(runtime, 'attempt-cancel-stray-1')).toBe('cancelled');
  });

  it('refuses while a live conducted run owns the attempt', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-cancel-prepared-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await seedPreparedAttempt(runtime, 'attempt-cancel-live-1');
    await seedRun(runtime, 'run-01JB0000000000000000000001', ['attempt-cancel-live-1']);
    await runtime.conductor.laneRunJournal.append(
      laneRunConductEntry('01JB0000000000000000000002', 'run-01JB0000000000000000000001', 'running', NOW),
    );

    const result = await cli(runtime, [
      'attempt',
      'cancel-prepared',
      '--attempt-id',
      'attempt-cancel-live-1',
      '--yes',
    ]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({ outcome: 'refused', reason: 'run-active' });
    expect(JSON.parse(result.out).runId).toBe('run-01JB0000000000000000000001');
    expect(result.out).toContain('conductor stop');

    expect(await attemptState(runtime, 'attempt-cancel-live-1')).toBe('intent-recorded');
  });

  it('allows a terminal (stopped) run that lists the attempt', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-cancel-prepared-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await seedPreparedAttempt(runtime, 'attempt-cancel-stopped-1');
    await seedRun(runtime, 'run-01JB0000000000000000000003', ['attempt-cancel-stopped-1']);
    await runtime.conductor.laneRunJournal.append(
      laneRunConductEntry('01JB0000000000000000000004', 'run-01JB0000000000000000000003', 'stopped', NOW),
    );

    const result = await cli(runtime, [
      'attempt',
      'cancel-prepared',
      '--attempt-id',
      'attempt-cancel-stopped-1',
      '--yes',
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).outcome).toBe('cancelled');

    expect(await attemptState(runtime, 'attempt-cancel-stopped-1')).toBe('cancelled');
  });

  it('refuses a non-prepared attempt with not-prepared', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-cancel-prepared-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await runtime.execution.attemptRepository.saveAttempt(
      makeAttempt('attempt-cancel-collected-1', { state: 'collected', revision: 1 }),
    );

    const result = await cli(runtime, [
      'attempt',
      'cancel-prepared',
      '--attempt-id',
      'attempt-cancel-collected-1',
      '--yes',
    ]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({ outcome: 'refused', reason: 'not-prepared' });

    expect(await attemptState(runtime, 'attempt-cancel-collected-1')).toBe('collected');
  });
});
