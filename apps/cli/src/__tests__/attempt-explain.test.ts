// E2: `attempt explain` — a read-only explanation of one attempt. It prints
// one JSON document, exits 1 for an unknown attempt, refuses a missing
// --attempt-id with exit 2, and never writes.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { AttemptRecord } from '@fleet/work-execution';

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
    workOrderId: 'wo-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/wt/1',
    baseCommit: 'a'.repeat(40),
    state: 'running',
    outcome: null,
    briefDigest: null,
    briefPackagePath: null,
    sessionId: 'ses_1',
    completionReceipt: null,
    artifacts: null,
    revision: 3,
    createdAtIso: NOW,
    updatedAtIso: NOW,
    ...overrides,
  } as AttemptRecord;
}

async function seedExplainState(runtime: FleetCliRuntime, attemptId: string): Promise<void> {
  await runtime.execution.attemptRepository.saveAttempt(makeAttempt(attemptId));
  await runtime.execution.executionJournal.appendJournalEntry({
    id: 'j-1',
    attemptId,
    workOrderId: 'wo-1',
    action: 'reconcile',
    baseCommit: 'a'.repeat(40),
    recordedAtIso: NOW,
    status: 'completed',
    sessionId: 'ses_1',
    detail: null,
  });
  await runtime.execution.executionJournal.saveCapacityReservation({
    id: 'res-1',
    attemptId,
    hostId: 'host-1',
    slotIndex: 0,
    held: true,
    seatTool: 'opencode',
    reservedAtIso: NOW,
    releasedAtIso: null,
  });
}

describe('attempt explain (E2)', () => {
  it('prints the explanation as one JSON document', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-explain-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await seedExplainState(runtime, 'attempt-explain-known-1');

    const result = await cli(runtime, [
      'attempt',
      'explain',
      '--attempt-id',
      'attempt-explain-known-1',
    ]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out) as {
      outcome: string;
      lines: Array<{ source: string; detail: string }>;
    };
    expect(parsed.outcome).toBe('explained');
    expect(parsed.lines.map((line) => line.source)).toEqual([
      'record',
      'runner',
      'capacity',
      'gate',
      'next',
    ]);
    const capacityLine = parsed.lines.find((line) => line.source === 'capacity')!;
    expect(capacityLine.detail).toContain('host-1');
  });

  it('exits 1 for an unknown attempt', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-explain-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });

    const result = await cli(runtime, [
      'attempt',
      'explain',
      '--attempt-id',
      'attempt-explain-missing-1',
    ]);
    expect(result.code).toBe(1);
    expect((JSON.parse(result.out) as { outcome: string }).outcome).toBe('not-found');
  });

  it('exits 2 without --attempt-id', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-explain-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });

    const result = await cli(runtime, ['attempt', 'explain']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('attempt explain needs --attempt-id');
  });

  it('writes nothing', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-explain-'));
    tempStateDirs.push(stateDir);
    const runtime = createFleetCliRuntime({ stateDir });
    await seedExplainState(runtime, 'attempt-explain-readonly-1');

    await cli(runtime, [
      'attempt',
      'explain',
      '--attempt-id',
      'attempt-explain-readonly-1',
    ]);

    const attempt = await runtime.execution.attemptRepository.findAttemptById(
      'attempt-explain-readonly-1',
    );
    expect(attempt).not.toBeNull();
    expect(attempt!.revision).toBe(3);
    expect(attempt!.state).toBe('running');
  });
});
