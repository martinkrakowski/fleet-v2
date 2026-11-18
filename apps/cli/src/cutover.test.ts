// Lane CO30a: `fleet-v2 cutover status` and `cutover rollback` through the production composition.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CUTOVER_SHADOW_CRITERIA,
  ShadowEvidenceAdapter,
  buildMergeKey,
  type CutoverRecord,
  type ShadowLedger,
} from '@fleet/work-execution';

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

const DEFAULT_RELEASE_SHA = 'a'.repeat(40);
const DEFAULT_VERDICT_DIGEST = 'b'.repeat(64);

function makeDayVerdicts(
  recordedAtIso: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const verdicts: Record<string, unknown> = {};
  for (const criterion of CUTOVER_SHADOW_CRITERIA) {
    if (criterion in overrides) {
      if (overrides[criterion] !== undefined) {
        verdicts[criterion] = overrides[criterion];
      }
      continue;
    }
    verdicts[criterion] = {
      verdict: 'pass',
      reason: 'ok',
      digest: DEFAULT_VERDICT_DIGEST,
      recordedAtIso,
    };
  }
  return verdicts;
}

function ledgerWith(
  overrides: {
    readonly schemaVersion?: number;
    readonly revision?: number;
    readonly days?: readonly Record<string, unknown>[];
    readonly releaseSha?: string | null;
    readonly mergesPerDay?: number | null;
  } = {},
): Record<string, unknown> {
  const releaseSha = overrides.releaseSha === undefined ? DEFAULT_RELEASE_SHA : overrides.releaseSha;
  const mergesCompared = overrides.mergesPerDay === undefined ? 20 : overrides.mergesPerDay;
  const defaultDays = ['2026-11-05'].map((day) => ({
    day,
    releaseSha,
    mergesCompared,
    verdicts: makeDayVerdicts(NOW),
  }));
  return {
    schemaVersion: overrides.schemaVersion ?? 1,
    revision: overrides.revision ?? 1,
    days: overrides.days ?? defaultDays,
  };
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

  it('exits 2 on usage errors: bare cutover switch and bare cutover retire lack required flags, beside the status and rollback usage rows', async () => {
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
      ['cutover', 'switch', '--expected-revision', '0'],
      ['cutover', 'switch', '--expected-revision', '0', '--operation-id', 'op-1'],
      ['cutover', 'switch', '--expected-revision', '0', '--operation-id', 'op-1', '--relaunch-plan-digest', 'ZZ'],
      ['cutover', 'switch', 'extra', '--expected-revision', '0', '--operation-id', 'op-1', '--relaunch-plan-digest', PLAN_DIGEST],
      ['cutover', 'retire'],
      ['cutover', 'retire', '--expected-revision', '0', '--operation-id', 'op-1'],
    ];
    for (const argv of usage) {
      const result = await run(runtime, argv);
      expect({ argv, code: result.code }).toEqual({ argv, code: 2 });
    }
    expect(existsSync(join(stateDir, 'cutover.json'))).toBe(false);
    expect(existsSync(join(stateDir, 'cutover-journal.json'))).toBe(false);
  });

  it('cutover switch with its flags refuses shadow-evidence-absent and writes no cutover file', async () => {
    const runtime = runtimeFor();
    const result = await run(runtime, [
      'cutover', 'switch',
      '--expected-revision', '0',
      '--operation-id', 'op-1',
      '--relaunch-plan-digest', PLAN_DIGEST,
      '--now-iso', NOW,
    ]);
    expect(result.code).toBe(1);
    expect(result.json).toEqual({ outcome: 'refused', reason: 'shadow-evidence-absent', failed: [...CUTOVER_SHADOW_CRITERIA] });
    expect(existsSync(join(stateDir, 'cutover.json'))).toBe(false);
    expect(existsSync(join(stateDir, 'cutover-journal.json'))).toBe(false);
    expect(result.out).not.toContain(stateDir);
  });

  it('cutover retire before a switch refuses not-switched', async () => {
    const runtime = runtimeFor();
    const result = await run(runtime, [
      'cutover', 'retire', '--expected-revision', '1', '--operation-id', 'op-1', '--now-iso', NOW,
    ]);
    expect(result.code).toBe(1);
    expect(result.json).toEqual({ outcome: 'refused', reason: 'not-switched' });
    expect(existsSync(join(stateDir, 'cutover-journal.json'))).toBe(false);
  });

  it('cutover retire after the window saves retired and does not print the state directory', async () => {
    const runtime = runtimeFor();
    await seedSwitched(runtime, true);
    const result = await run(runtime, [
      'cutover', 'retire', '--expected-revision', '1', '--operation-id', 'op-1', '--now-iso', '2026-11-20T12:00:00.000Z',
    ]);
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({
      outcome: 'completed',
      move: 'retire',
      key: 'cutover/retire@1',
      replayed: false,
      state: 'retired',
      revision: 2,
    });
    expect(JSON.parse(readFileSync(join(stateDir, 'killall-train-pause.json'), 'utf8'))).toEqual([
      expect.objectContaining({ paused: false }),
    ]);
    expect(JSON.parse(readFileSync(join(stateDir, 'cutover.json'), 'utf8'))).toMatchObject({ state: 'retired', retiredAtIso: '2026-11-20T12:00:00.000Z' });
    expect(result.out).not.toContain(stateDir);
  });

  it('cutover retire names retire, not rollback, in its expected-revision usage error', async () => {
    const runtime = runtimeFor();
    const retire = await run(runtime, ['cutover', 'retire', '--expected-revision', '0', '--operation-id', 'op-1']);
    expect(retire.code).toBe(2);
    expect(retire.err).toContain('cutover retire requires --expected-revision');
    expect(retire.err).not.toContain('cutover rollback');
    const rollback = await run(runtime, ['cutover', 'rollback', '--expected-revision', '0', '--operation-id', 'op-1']);
    expect(rollback.err).toContain('cutover rollback requires --expected-revision');
  });

  it('cutover switch validates the operation id before the digest, as the first release did', async () => {
    const runtime = runtimeFor();
    const result = await run(runtime, ['cutover', 'switch', '--expected-revision', '0']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('cutover switch requires --operation-id');
    expect(result.err).not.toContain('--relaunch-plan-digest');
  });

  it('a completed retire prints its keys in the first release order', async () => {
    const runtime = runtimeFor();
    await seedSwitched(runtime, true);
    const result = await run(runtime, [
      'cutover', 'retire', '--expected-revision', '1', '--operation-id', 'op-1', '--now-iso', '2026-11-20T12:00:00.000Z',
    ]);
    expect(Object.keys(result.json ?? {})).toEqual(['outcome', 'move', 'key', 'replayed', 'state', 'revision', 'record']);
  });
});

describe('cutover shadow record-day merge-queue digest (RD1)', () => {
  it('records S1 pass when the live fleet/v2 entry shares the journal digest 7c155c1db6b3', async () => {
    // enqueue and listMergeEntries judge deadlines against Date.now(), while
    // record-day's list deadline is daemonNow plus 60s. Pin both clocks to the
    // same instant so the brief's deadline stays in the future.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T12:00:00.000Z'));
    try {
      const legacyDir = join(stateDir, 'legacy');
      mkdirSync(legacyDir, { recursive: true });
      const headOid = 'a'.repeat(40);
      // Shell events reject a fractional second (`AT_PATTERN` is seconds and
      // `Z` only). This is the same instant as 2026-11-16T10:00:00.000Z.
      writeFileSync(
        join(legacyDir, 'events.jsonl'),
        `${JSON.stringify({
          at: '2026-11-16T10:00:00Z',
          kind: 'result',
          outcome: 'merged',
          pr: 101,
          headOid,
          detail: '',
        })}\n`,
      );

      const runtime = createFleetCliRuntime({
        stateDir,
        daemonNow: () => '2026-11-17T12:00:00.000Z',
        daemonSleep: async () => {},
      });
      const enqueued = await runtime.execution.mergeQueueRepository.enqueueMergeEntry({
        repository: { owner: 'fleet', repo: 'v2' },
        pullRequest: 101,
        headOid,
        tier: 2,
        enqueuedBy: 'cli',
        runId: null,
        entryId: '01JB0000000000000000000001',
        successorEntryId: '01JB0000000000000000000002',
        enqueuedAtIso: '2026-11-16T09:00:00.000Z',
        deadlineIso: '2026-11-17T12:05:00.000Z',
      });
      expect(enqueued.outcome).toBe('created');

      const built = buildMergeKey({
        repoDigest: '7c155c1db6b3',
        pullRequest: 101,
        head12: headOid.slice(0, 12),
        action: 'merge-pr',
        attemptOrdinal: null,
        retry: null,
        retryProof: null,
      });
      if (!built.ok) {
        throw new Error(`fixture merge key refused: ${built.error}`);
      }
      // S1 counts only a dry-run result whose reason is would-merge. Any other
      // outcome on this merge key is live-action-in-shadow and cannot pass.
      const intent = await runtime.conductor.laneRunJournal.append({
        version: 1,
        entryId: '01JB0000000000000000000003',
        kind: 'intent',
        key: built.key,
        runId: null,
        recordedAtIso: '2026-11-16T09:59:00.000Z',
        mode: null,
        expectedRevision: null,
        mintedId: null,
        outcome: null,
        reasonCode: null,
        detail: null,
        grantId: null,
        state: null,
      });
      expect(intent.outcome).toBe('appended');
      const resultEntry = await runtime.conductor.laneRunJournal.append({
        version: 1,
        entryId: '01JB0000000000000000000004',
        kind: 'result',
        key: built.key,
        runId: null,
        recordedAtIso: '2026-11-16T10:00:00.000Z',
        mode: null,
        expectedRevision: null,
        mintedId: null,
        outcome: 'dry-run',
        reasonCode: 'would-merge',
        detail: null,
        grantId: null,
        state: null,
      });
      expect(resultEntry.outcome).toBe('appended');

      const result = await run(runtime, [
        'cutover',
        'shadow',
        'record-day',
        '--repository',
        'fleet/v2',
        '--legacy-state-dir',
        legacyDir,
        '--day',
        '2026-11-16',
      ]);
      expect(result.code).toBe(0);
      expect(result.json).toMatchObject({
        outcome: 'recorded',
        recorded: { S1: 'pass' },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('cutover switch reads the recorded shadow ledger (SH8b)', () => {
  const OTHER_RELEASE_SHA = 'c'.repeat(40);
  const ALL_CRITERIA = [...CUTOVER_SHADOW_CRITERIA];

  function shadowDays(
    dates: readonly string[],
    options: {
      readonly releaseSha?: string | null;
      readonly releaseShas?: readonly (string | null)[];
      readonly mergesCompared?: number | null;
      readonly verdictsFor?: (day: string, index: number) => Record<string, unknown>;
    } = {},
  ): Record<string, unknown>[] {
    const releaseSha = options.releaseSha === undefined ? DEFAULT_RELEASE_SHA : options.releaseSha;
    const mergesCompared = options.mergesCompared === undefined ? 20 : options.mergesCompared;
    return dates.map((day, index) => ({
      day,
      releaseSha: options.releaseShas === undefined ? releaseSha : options.releaseShas[index],
      mergesCompared,
      verdicts: options.verdictsFor === undefined ? makeDayVerdicts(NOW) : options.verdictsFor(day, index),
    }));
  }

  function switchArgv(nowIso: string = NOW, extra: readonly string[] = []): string[] {
    return [
      'cutover', 'switch',
      '--expected-revision', '0',
      '--operation-id', 'op-1',
      '--relaunch-plan-digest', PLAN_DIGEST,
      '--now-iso', nowIso,
      ...extra,
    ];
  }

  function writeLedger(ledger: Record<string, unknown>): string {
    const bytes = `${JSON.stringify(ledger)}\n`;
    writeFileSync(join(stateDir, 'cutover-shadow.json'), bytes);
    return bytes;
  }

  async function runSwitch(nowIso: string = NOW, extra: readonly string[] = []) {
    return run(runtimeFor(), switchArgv(nowIso, extra));
  }

  function expectNoCutoverWrites(out: string): void {
    expect(existsSync(join(stateDir, 'cutover.json'))).toBe(false);
    expect(existsSync(join(stateDir, 'cutover-journal.json'))).toBe(false);
    expect(out).not.toContain(stateDir);
  }

  /** Every relative name under the state directory, including a `.lock` or `quarantine` entry. */
  function stateNames(): string[] {
    return readdirSync(stateDir, { encoding: 'utf8', recursive: true }).sort();
  }

  function lockOrQuarantineNames(names: readonly string[]): string[] {
    return names.filter((name) => name.endsWith('.lock') || name.split(/[/\\]/).includes('quarantine'));
  }

  it('cutover switch in memory (no state directory) refuses shadow-evidence-absent', async () => {
    const result = await run(runtimeFor(undefined), switchArgv());
    expect(result.code).toBe(1);
    expect(result.json).toEqual({
      outcome: 'refused',
      reason: 'shadow-evidence-absent',
      failed: ALL_CRITERIA,
    });
  });

  it('cutover switch with fewer than 1 recorded day refuses shadow-evidence-absent', async () => {
    writeLedger(ledgerWith({ days: [] }));
    const result = await runSwitch();
    expect(result.code).toBe(1);
    expect(result.json).toEqual({ outcome: 'refused', reason: 'shadow-evidence-absent', failed: ALL_CRITERIA });
    expectNoCutoverWrites(result.out);
  });

  it('cutover switch with releaseSha null on 1 all-pass day refuses shadow-evidence-absent', async () => {
    writeLedger(ledgerWith({ releaseSha: null }));
    const result = await runSwitch();
    expect(result.code).toBe(1);
    expect(result.json).toEqual({ outcome: 'refused', reason: 'shadow-evidence-absent', failed: ALL_CRITERIA });
    expectNoCutoverWrites(result.out);
  });

  it('cutover switch with a stale newest day refuses shadow-evidence-absent', async () => {
    writeLedger(ledgerWith({ days: shadowDays(['2026-11-01', '2026-11-02', '2026-11-03']) }));
    const result = await runSwitch();
    expect(result.code).toBe(1);
    expect(result.json).toEqual({ outcome: 'refused', reason: 'shadow-evidence-absent', failed: ALL_CRITERIA });
    expectNoCutoverWrites(result.out);
  });

  it('cutover switch with a stale ledger and a matching back-dated --now-iso still refuses shadow-evidence-absent', async () => {
    writeLedger(ledgerWith({ days: shadowDays(['2026-11-01', '2026-11-02', '2026-11-03']) }));
    const result = await runSwitch('2026-11-03T12:00:00.000Z');
    expect(result.code).toBe(1);
    expect(result.json).toEqual({ outcome: 'refused', reason: 'shadow-evidence-absent', failed: ALL_CRITERIA });
    expectNoCutoverWrites(result.out);
  });

  it('cutover switch whose newest day is after --now-iso refuses shadow-criteria-failed naming all 12 criteria', async () => {
    writeLedger(ledgerWith());
    const result = await runSwitch('2026-11-04T12:00:00.000Z');
    expect(result.code).toBe(1);
    expect(result.json).toEqual({ outcome: 'refused', reason: 'shadow-criteria-failed', failed: ALL_CRITERIA });
    expectNoCutoverWrites(result.out);
  });

  it('cutover switch with 1 all-pass day under 20 merges refuses shadow-criteria-failed naming all 12 criteria', async () => {
    writeLedger(ledgerWith({ mergesPerDay: 19 }));
    const result = await runSwitch();
    expect(result.code).toBe(1);
    expect(result.json).toEqual({ outcome: 'refused', reason: 'shadow-criteria-failed', failed: ALL_CRITERIA });
    expectNoCutoverWrites(result.out);
  });

  it('cutover switch with S4 recorded fail on the required shadow day refuses shadow-criteria-failed with failed S4', async () => {
    writeLedger(ledgerWith({
      days: shadowDays(['2026-11-05'], {
        verdictsFor: (_day, index) =>
          index === 0
            ? makeDayVerdicts(NOW, {
                S4: {
                  verdict: 'fail',
                  reason: 'drift',
                  digest: DEFAULT_VERDICT_DIGEST,
                  recordedAtIso: NOW,
                },
              })
            : makeDayVerdicts(NOW),
      }),
    }));
    const result = await runSwitch();
    expect(result.code).toBe(1);
    expect(result.json).toEqual({ outcome: 'refused', reason: 'shadow-criteria-failed', failed: ['S4'] });
    expectNoCutoverWrites(result.out);
  });

  it('cutover switch with S1–S12 recorded and no S13 gets past the evidence gate, and omitting S12 refuses shadow-criteria-failed with failed S12', async () => {
    // SH23: S13 left the shadow window for the retirement gate, so S1–S12
    // alone (no S13 key on the day) pass the evidence gate — the run then
    // stops at the later lanes gate, never at S13. Omitting one of the
    // twelve, S12 here, still refuses with that criterion named.
    writeLedger(ledgerWith({
      days: shadowDays(['2026-11-05'], {
        verdictsFor: (_day, index) =>
          index === 0 ? makeDayVerdicts(NOW, { S12: undefined }) : makeDayVerdicts(NOW),
      }),
    }));
    const missingS12 = await runSwitch();
    expect(missingS12.code).toBe(1);
    expect(missingS12.json).toEqual({ outcome: 'refused', reason: 'shadow-criteria-failed', failed: ['S12'] });
    expectNoCutoverWrites(missingS12.out);

    writeLedger(ledgerWith());
    const allTwelve = await runSwitch();
    expect(allTwelve.code).toBe(1);
    // The evidence gate passed: the refusal is the lanes gate, not S13 or any criterion.
    expect(allTwelve.json).toEqual({ outcome: 'unknown', reason: 'unrecorded-lanes-unknown' });
    expectNoCutoverWrites(allTwelve.out);
  });

  it('cutover switch with an older all-pass day but no latest closed day refuses shadow-evidence-absent', async () => {
    // NOW is 2026-11-05, so the latest closed UTC day is 2026-11-04; a lone
    // 2026-11-03 day is two days stale and never passes.
    writeLedger(ledgerWith({ days: shadowDays(['2026-11-03'], { mergesCompared: 25, releaseShas: [OTHER_RELEASE_SHA] }) }));
    const result = await runSwitch();
    expect(result.code).toBe(1);
    expect(result.json).toEqual({ outcome: 'refused', reason: 'shadow-evidence-absent', failed: ALL_CRITERIA });
    expectNoCutoverWrites(result.out);
  });

  it('cutover switch with an older all-pass day and a latest closed day that fails S4 refuses shadow-criteria-failed with failed S4', async () => {
    writeLedger(ledgerWith({
      days: shadowDays(['2026-11-03', '2026-11-04'], {
        mergesCompared: 25,
        releaseShas: [OTHER_RELEASE_SHA, DEFAULT_RELEASE_SHA],
        verdictsFor: (_day, index) =>
          index === 1
            ? makeDayVerdicts(NOW, {
                S4: {
                  verdict: 'fail',
                  reason: 'drift',
                  digest: DEFAULT_VERDICT_DIGEST,
                  recordedAtIso: NOW,
                },
              })
            : makeDayVerdicts(NOW),
      }),
    }));
    const result = await runSwitch();
    expect(result.code).toBe(1);
    expect(result.json).toEqual({ outcome: 'refused', reason: 'shadow-criteria-failed', failed: ['S4'] });
    expectNoCutoverWrites(result.out);
  });

  it('cutover switch with unparseable bytes in cutover-shadow.json returns unknown shadow-evidence-unreadable', async () => {
    const bytes = '{ not json';
    writeFileSync(join(stateDir, 'cutover-shadow.json'), bytes);
    const result = await runSwitch();
    expect(result.code).toBe(1);
    expect(result.json).toEqual({ outcome: 'unknown', reason: 'shadow-evidence-unreadable' });
    expect(readFileSync(join(stateDir, 'cutover-shadow.json'), 'utf8')).toBe(bytes);
    expectNoCutoverWrites(result.out);
  });

  it('cutover switch with a null ledger in cutover-shadow.json returns unknown shadow-evidence-unreadable', async () => {
    writeFileSync(join(stateDir, 'cutover-shadow.json'), 'null\n');
    const result = await runSwitch();
    expect(result.code).toBe(1);
    expect(result.json).toEqual({ outcome: 'unknown', reason: 'shadow-evidence-unreadable' });
    expect(readFileSync(join(stateDir, 'cutover-shadow.json'), 'utf8')).toBe('null\n');
    expectNoCutoverWrites(result.out);
  });

  it('cutover switch with a criterion verdict unknown returns unknown shadow-evidence-unreadable', async () => {
    writeLedger(ledgerWith({
      days: shadowDays(['2026-11-03', '2026-11-04', '2026-11-05'], {
        verdictsFor: () =>
          makeDayVerdicts(NOW, {
            S4: {
              verdict: 'unknown',
              reason: 'drift',
              digest: DEFAULT_VERDICT_DIGEST,
              recordedAtIso: NOW,
            },
          }),
      }),
    }));
    const result = await runSwitch();
    expect(result.code).toBe(1);
    expect(result.json).toEqual({ outcome: 'unknown', reason: 'shadow-evidence-unreadable' });
    expectNoCutoverWrites(result.out);
  });

  it('cutover switch with duplicate day entries returns unknown shadow-evidence-unreadable', async () => {
    writeLedger(ledgerWith({ days: shadowDays(['2026-11-03', '2026-11-03']) }));
    const result = await runSwitch();
    expect(result.code).toBe(1);
    expect(result.json).toEqual({ outcome: 'unknown', reason: 'shadow-evidence-unreadable' });
    expectNoCutoverWrites(result.out);
  });

  it('cutover switch with non-array days returns unknown shadow-evidence-unreadable', async () => {
    writeFileSync(
      join(stateDir, 'cutover-shadow.json'),
      `${JSON.stringify({ schemaVersion: 1, revision: 1, days: { bad: true } })}\n`,
    );
    const result = await runSwitch();
    expect(result.code).toBe(1);
    expect(result.json).toEqual({ outcome: 'unknown', reason: 'shadow-evidence-unreadable' });
    expectNoCutoverWrites(result.out);
  });

  it('cutover switch with schemaVersion 99 returns unknown shadow-evidence-unknown-version', async () => {
    const bytes = writeLedger(ledgerWith({ schemaVersion: 99 }));
    const result = await runSwitch();
    expect(result.code).toBe(1);
    expect(result.json).toEqual({ outcome: 'unknown', reason: 'shadow-evidence-unknown-version' });
    expect(readFileSync(join(stateDir, 'cutover-shadow.json'), 'utf8')).toBe(bytes);
    expectNoCutoverWrites(result.out);
  });

  it('cutover switch with a deadline already past returns unknown deadline-exceeded', async () => {
    writeLedger(ledgerWith());
    const result = await runSwitch(NOW, ['--deadline-iso', '2026-11-05T11:00:00.000Z']);
    expect(result.code).toBe(1);
    expect(result.json).toEqual({ outcome: 'unknown', reason: 'deadline-exceeded' });
    expectNoCutoverWrites(result.out);
  });

  it('cutover switch with a valid 1-day 20-merge pinned-release all-pass ledger stops at unrecorded-lanes-unknown and writes no journal', async () => {
    const bytes = writeLedger(ledgerWith());
    const result = await runSwitch();
    expect(result.code).toBe(1);
    expect(result.json).toEqual({ outcome: 'unknown', reason: 'unrecorded-lanes-unknown' });
    expect(existsSync(join(stateDir, 'cutover-journal.json'))).toBe(false);
    expect(existsSync(join(stateDir, 'cutover.json'))).toBe(false);
    expect(readFileSync(join(stateDir, 'cutover-shadow.json'), 'utf8')).toBe(bytes);
    expect(result.out).not.toContain(stateDir);
  });

  it('cutover switch preflight over a corrupt ledger leaves the state directory listing and ledger bytes unchanged and the reader refuses every write', async () => {
    const bytes = '{ not json';
    writeFileSync(join(stateDir, 'cutover-shadow.json'), bytes);
    // read() never locks or quarantines. readOnly is what refuses compareAndSet
    // on the instance switch actually read, before any lock file is created.
    const readers: ShadowEvidenceAdapter[] = [];
    const originalRead = ShadowEvidenceAdapter.prototype.read;
    const spy = vi.spyOn(ShadowEvidenceAdapter.prototype, 'read').mockImplementation(function (
      this: ShadowEvidenceAdapter,
      options?: { readonly deadlineIso?: string },
    ) {
      readers.push(this);
      return originalRead.call(this, options);
    });
    try {
      const runtime = runtimeFor();
      const before = stateNames();
      const result = await run(runtime, switchArgv());
      expect(result.code).toBe(1);
      expect(result.json).toEqual({ outcome: 'unknown', reason: 'shadow-evidence-unreadable' });
      expect(stateNames()).toEqual(before);
      expect(lockOrQuarantineNames(stateNames())).toEqual([]);
      expect(readFileSync(join(stateDir, 'cutover-shadow.json'), 'utf8')).toBe(bytes);
      expectNoCutoverWrites(result.out);

      expect(readers.length).toBeGreaterThan(0);
      for (const reader of readers) {
        expect(
          await reader.compareAndSet({
            expectedRevision: 0,
            next: ledgerWith() as unknown as ShadowLedger,
          }),
        ).toEqual({ outcome: 'refused', reason: 'read-only' });
      }
      expect(stateNames()).toEqual(before);
      expect(lockOrQuarantineNames(stateNames())).toEqual([]);
      expect(readFileSync(join(stateDir, 'cutover-shadow.json'), 'utf8')).toBe(bytes);
    } finally {
      spy.mockRestore();
    }
  });

  it('cutover switch preflight over a valid ledger leaves no lock file', async () => {
    const bytes = writeLedger(ledgerWith());
    const runtime = runtimeFor();
    const before = stateNames();
    const result = await run(runtime, switchArgv());
    expect(result.code).toBe(1);
    expect(result.json).toEqual({ outcome: 'unknown', reason: 'unrecorded-lanes-unknown' });
    expect(stateNames()).toEqual(before);
    expect(lockOrQuarantineNames(stateNames())).toEqual([]);
    expect(existsSync(join(stateDir, 'cutover-journal.json'))).toBe(false);
    expect(readFileSync(join(stateDir, 'cutover-shadow.json'), 'utf8')).toBe(bytes);
    expect(result.out).not.toContain(stateDir);
  });

  it('cutover switch when the daemon clock throws during the ledger read returns unknown shadow-evidence-unreadable and writes no journal', async () => {
    const bytes = writeLedger(ledgerWith());
    const runtime = createFleetCliRuntime({
      stateDir,
      daemonNow: () => {
        throw new Error('daemon clock failed');
      },
    });
    const before = stateNames();
    const result = await run(runtime, switchArgv());
    expect(result.code).toBe(1);
    expect(result.json).toEqual({ outcome: 'unknown', reason: 'shadow-evidence-unreadable' });
    expect(stateNames()).toEqual(before);
    expect(existsSync(join(stateDir, 'cutover-journal.json'))).toBe(false);
    expect(existsSync(join(stateDir, 'cutover.json'))).toBe(false);
    expect(readFileSync(join(stateDir, 'cutover-shadow.json'), 'utf8')).toBe(bytes);
    expect(result.out).not.toContain(stateDir);
  });
});
