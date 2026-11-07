// Lane CO30a: `fleet-v2 cutover status` and `cutover rollback` through the production composition.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CutoverRecord } from '@fleet/work-execution';

import { createFleetCliRuntime, type FleetCliRuntime } from './composition.js';
import { runCli, type CliIo } from './index.js';

const SWITCHED_AT = '2026-11-03T12:00:00.000Z';
const NOW = '2026-11-05T12:00:00.000Z';
const PLAN_DIGEST = 'c'.repeat(64);
const HALT_BYTES = `${JSON.stringify([{ version: 1, halted: true, changedAtIso: '2026-11-01T10:00:00.000Z' }])}\n`;

function switchedRecord(trainPauseSetByCutover: boolean): CutoverRecord {
  return {
    schemaVersion: 1,
    revision: 1,
    state: 'switched',
    updatedAtIso: SWITCHED_AT,
    switchedAtIso: SWITCHED_AT,
    rolledBackAtIso: null,
    retiredAtIso: null,
    relaunchPlanDigest: PLAN_DIGEST,
    trainPauseSetByCutover,
  };
}

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'fleet-cutover-cli-'));
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function runtimeFor(dir: string | undefined = stateDir): FleetCliRuntime {
  return createFleetCliRuntime({ stateDir: dir, daemonNow: () => NOW });
}

async function run(
  runtime: FleetCliRuntime,
  argv: readonly string[],
): Promise<{ readonly code: number; readonly out: string; readonly err: string; readonly json: Record<string, unknown> | null }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { stdout: (text) => out.push(text), stderr: (text) => err.push(text) };
  const code = await runCli(argv, io, runtime);
  const text = out.join('');
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text.trim().split('\n').at(-1) ?? '') as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { code, out: text, err: err.join(''), json };
}

async function seedSwitched(runtime: FleetCliRuntime, trainPauseSetByCutover: boolean): Promise<void> {
  const saved = await runtime.execution.cutoverRecordRepository.compareAndSet({
    expectedRevision: 0,
    next: switchedRecord(trainPauseSetByCutover),
  });
  expect(saved.outcome).toBe('saved');
  await runtime.execution.killallTrainPause.set({ paused: true, nowIso: SWITCHED_AT });
}

const ROLLBACK = ['cutover', 'rollback', '--expected-revision', '1', '--operation-id', 'op-1', '--now-iso', NOW] as const;

describe('fleet-v2 cutover status and rollback', () => {
  it('runs cutover status, cutover rollback, replay, digest-mismatch refusal, and state check through createFleetCliRuntime and runCli', async () => {
    const runtime = runtimeFor();
    writeFileSync(join(stateDir, 'killall-halt.json'), HALT_BYTES);

    const shadow = await run(runtime, ['cutover', 'status']);
    expect(shadow.code).toBe(0);
    expect(shadow.json).toMatchObject({ outcome: 'completed', move: 'status', state: 'shadow', revision: 0, record: null });

    await seedSwitched(runtime, true);
    const switched = await run(runtime, ['cutover', 'status', '--now-iso', NOW]);
    expect(switched.code).toBe(0);
    expect(switched.json).toMatchObject({
      state: 'switched',
      revision: 1,
      trainPause: 'paused',
      daemonPause: 'clear',
      withinRollbackWindow: true,
    });

    const first = await run(runtime, ROLLBACK);
    expect(first.code).toBe(0);
    expect(first.json).toMatchObject({
      outcome: 'completed',
      move: 'rollback',
      key: 'cutover/rollback@1',
      replayed: false,
      state: 'rolled-back',
      revision: 2,
    });
    expect(JSON.parse(readFileSync(join(stateDir, 'daemon', 'paused.json'), 'utf8'))).toMatchObject({ paused: true });
    expect(JSON.parse(readFileSync(join(stateDir, 'killall-train-pause.json'), 'utf8'))).toEqual([
      expect.objectContaining({ paused: false }),
    ]);
    expect(readFileSync(join(stateDir, 'killall-halt.json'), 'utf8')).toBe(HALT_BYTES);

    const after = await run(runtime, ['cutover', 'status']);
    expect(after.json).toMatchObject({ state: 'rolled-back', revision: 2, daemonPause: 'paused', trainPause: 'clear' });

    const replay = await run(runtime, ROLLBACK);
    expect(replay.code).toBe(0);
    expect(replay.json).toMatchObject({ outcome: 'completed', replayed: true, revision: 2 });

    const mismatch = await run(runtime, [
      'cutover', 'rollback', '--expected-revision', '1', '--operation-id', 'op-2', '--now-iso', NOW,
    ]);
    expect(mismatch.code).toBe(1);
    expect(mismatch.json).toEqual({ outcome: 'refused', reason: 'intent-digest-mismatch' });

    const out: string[] = [];
    const code = await runCli(['--state-dir', stateDir, 'state', 'check'], { stdout: (t) => out.push(t), stderr: () => undefined });
    expect(code).toBe(0);
    expect(out.join('')).toContain('cutover.json: ok (1 record)\n');

    const everything = [shadow, switched, first, after, replay, mismatch].map((r) => r.out).join('');
    expect(everything).not.toContain(stateDir);
  });

  it('lifts the train pause only when the cutover set it', async () => {
    const runtime = runtimeFor();
    await seedSwitched(runtime, false);
    const result = await run(runtime, ROLLBACK);
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ outcome: 'completed', revision: 2 });
    expect(await runtime.execution.killallTrainPause.read()).toEqual({ status: 'paused' });
    expect(JSON.parse(readFileSync(join(stateDir, 'daemon', 'paused.json'), 'utf8'))).toMatchObject({ paused: true });
  });

  it('refuses with exit 1 when nothing was switched', async () => {
    const result = await run(runtimeFor(), ROLLBACK);
    expect(result.code).toBe(1);
    expect(result.json).toEqual({ outcome: 'refused', reason: 'not-switched' });
  });

  it('answers unknown, exits 1 and never quarantines a corrupt pause file on status', async () => {
    const runtime = runtimeFor();
    mkdirSync(join(stateDir, 'daemon'), { recursive: true });
    const pausePath = join(stateDir, 'daemon', 'paused.json');
    writeFileSync(pausePath, '{ not json');
    const daemon = await run(runtime, ['cutover', 'status']);
    expect(daemon.code).toBe(1);
    expect(daemon.json).toEqual({ outcome: 'unknown', reason: 'daemon-pause-unreadable' });
    expect(readFileSync(pausePath, 'utf8')).toBe('{ not json');
    rmSync(pausePath);

    const trainPath = join(stateDir, 'killall-train-pause.json');
    writeFileSync(trainPath, '{ not json');
    const train = await run(runtime, ['cutover', 'status']);
    expect(train.code).toBe(1);
    expect(train.json).toEqual({ outcome: 'unknown', reason: 'train-pause-unreadable' });
    expect(readFileSync(trainPath, 'utf8')).toBe('{ not json');

    expect(existsSync(join(stateDir, 'quarantine'))).toBe(false);
    expect(readdirSync(stateDir).filter((name) => name.includes('.json.') && !name.endsWith('.lock'))).toEqual([]);
  });

  it('works without a state directory, in memory', async () => {
    const runtime = runtimeFor(undefined);
    const status = await run(runtime, ['cutover', 'status']);
    expect(status.json).toMatchObject({ outcome: 'completed', state: 'shadow', revision: 0 });
    await seedSwitched(runtime, true);
    expect((await run(runtime, ROLLBACK)).json).toMatchObject({ outcome: 'completed', revision: 2 });
    expect((await run(runtime, ['cutover', 'status'])).json).toMatchObject({
      state: 'rolled-back',
      daemonPause: 'paused',
      trainPause: 'clear',
    });
  });

  it('exits 2 on usage errors and for the unbuilt switch and retire moves', async () => {
    const runtime = runtimeFor();
    const usage: readonly (readonly string[])[] = [
      ['cutover', 'status', '--bogus', 'x'],
      ['cutover', 'status', 'extra'],
      ['cutover', 'status', '--now-iso'],
      ['cutover', 'status', '--json', '{"positional":["x"]}'],
      ['cutover', 'status', '--json', '{"expectedRevision":1}'],
      ['cutover', 'rollback', '--operation-id', 'op-1'],
      ['cutover', 'rollback', '--expected-revision', '1'],
      ['cutover', 'rollback', '--expected-revision', '0', '--operation-id', 'op-1'],
      ['cutover', 'rollback', '--expected-revision', '1.5', '--operation-id', 'op-1'],
      ['cutover', 'rollback', '--expected-revision', 'abc', '--operation-id', 'op-1'],
      ['cutover', 'rollback', '--expected-revision', '1', '--operation-id', 'op-1', '--bogus', 'x'],
      ['cutover', 'rollback', '--expected-revision', '1', '--operation-id', 'op-1', 'extra'],
      ['cutover', 'switch'],
      ['cutover', 'retire'],
    ];
    for (const argv of usage) {
      const result = await run(runtime, argv);
      expect({ argv, code: result.code }).toEqual({ argv, code: 2 });
    }
    expect(existsSync(join(stateDir, 'cutover.json'))).toBe(false);
    expect(existsSync(join(stateDir, 'cutover-journal.json'))).toBe(false);
  });
});
