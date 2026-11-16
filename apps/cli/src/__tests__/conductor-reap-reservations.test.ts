// OG22b: `conductor reap --reservations` — operator-opt-in release of the
// capacity reservations of finished runs (a reservation no run lists is
// reported only and never released; worktrees, branches and runs are never
// deleted). The flags are strict: exactly one of --worktrees/--sessions/
// --reservations is required, --yes is required unless --dry-run is given,
// and a durable state directory is required like the other record-only
// commands. A dry run reads through read-only stores and writes nothing.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  LaneRun,
  laneRunConductEntry,
  type AttemptRecord,
  type LaneRunRecord,
  type ReapOrphanReservationsResult,
} from '@fleet/work-execution';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli } from '../index.js';
import type { CliIo } from '../index.js';

const NOW = '2026-10-31T00:00:00.000Z';
const RUN_ID = 'run-01JB000000000000000000000A';
const WORKTREE = '/srv/fleet/worktrees/wt1';
const PREFIX = 'conductor reap --reservations: ';
const NOTHING_RELEASED = `${PREFIX}the sweep was refused or a store is unreadable; nothing released\n`;
const SWEEP_FAILED = `${PREFIX}the sweep failed before a result could be read; outcome unknown\n`;
const SWEEP_INCOMPLETE = `${PREFIX}sweep incomplete: a run record is unreadable or the run count exceeds 10,000; nothing released\n`;
const unknownNotice = (count: number): string =>
  `${PREFIX}UNKNOWN: ${count} reservation(s) could not be classified and were not released\n`;
const reportOnlyNotice = (count: number): string =>
  `${PREFIX}REPORT ONLY: ${count} held reservation(s) are listed by no run and were not released; see conductor start --abandon\n`;
const notPerformedNotice = (count: number): string =>
  `${PREFIX}${count} release(s) were not performed; see failed in the document\n`;
const journalFailedNotice = (count: number): string =>
  `${PREFIX}${count} release result(s) could not be journalled\n`;
const ambiguousNotice = (count: number): string =>
  `${PREFIX}${count} release(s) have an unknown outcome and may have completed; run conductor reap --reservations --dry-run to check\n`;

const tempStateDirs: string[] = [];

afterAll(() => {
  for (const dir of tempStateDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-v2-conductor-reap-reservations-'));
  tempStateDirs.push(dir);
  return dir;
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

/** Run one conductor invocation; `stateDir` null runs with no durable state directory. */
async function runConductor(
  runtime: FleetCliRuntime,
  args: readonly string[],
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

/** The clean `outcome: 'reaped'` result: every list empty, nothing dry. */
function okResult(overrides: Partial<Extract<ReapOrphanReservationsResult, { outcome: 'reaped' }>> = {}): ReapOrphanReservationsResult {
  return {
    outcome: 'reaped',
    dryRun: false,
    orphans: [],
    reportOnly: [],
    released: [],
    skipped: [],
    failed: [],
    journalFailed: [],
    unknown: [],
    ...overrides,
  };
}

/** One finished attempt (no runner) for the store. */
function orphanAttempt(id: string): AttemptRecord {
  return {
    id,
    workOrderId: 'wo-example-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: WORKTREE,
    baseCommit: 'a'.repeat(40),
    state: 'collected',
    outcome: null,
    briefDigest: 'b'.repeat(64),
    briefPackagePath: '.lane/brief-package',
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    runner: null,
    createdAtIso: NOW,
    updatedAtIso: NOW,
  };
}

/** A lane run that lists the attempt, with a `merged` journal entry, as in conductor-reap.test.ts. */
async function seedMergedRun(runtime: FleetCliRuntime, attemptId: string): Promise<void> {
  const created = LaneRun.create({
    version: 1,
    runId: RUN_ID,
    workOrderId: 'wo-example-1',
    tier: 2,
    seatPlanRef: 'c'.repeat(64),
    cursors: { 'first-pass': 0, fix: null, review: null },
    round: 0,
    attemptIds: [attemptId],
    prNumber: null,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 1,
    runPolicyRevision: 'pol-1',
    branchName: `fleet/${RUN_ID}`,
  });
  expect(created.success).toBe(true);
  if (!created.success) {
    throw new Error('fixture must be a valid LaneRun record');
  }
  const record: LaneRunRecord = created.value.toRecord();
  expect(await runtime.conductor.laneRunRepository.create(record)).toMatchObject({ outcome: 'saved' });
  expect(
    await runtime.conductor.laneRunJournal.append(
      laneRunConductEntry('01JB0000000000000000000001', RUN_ID, 'merged', NOW),
    ),
  ).toMatchObject({ outcome: 'appended' });
}

describe('conductor reap --reservations (OG22b)', () => {
  it('requires one of --worktrees, --sessions or --reservations', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    const reservations = vi.spyOn(runtime.conductor.reapOrphanReservations, 'reapOrphanReservations');
    const dryRun = vi.spyOn(runtime.conductor.reapOrphanReservationsDryRun, 'reapOrphanReservations');
    const result = await runConductor(runtime, ['reap']);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
    expect(result.stderr.join('')).toContain('requires --worktrees, --sessions or --reservations');
    expect(reservations).not.toHaveBeenCalled();
    expect(dryRun).not.toHaveBeenCalled();
  });

  it('rejects --reservations combined with --worktrees or --sessions, and calls nothing', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    const reservations = vi.spyOn(runtime.conductor.reapOrphanReservations, 'reapOrphanReservations');
    const dryRun = vi.spyOn(runtime.conductor.reapOrphanReservationsDryRun, 'reapOrphanReservations');
    for (const args of [
      ['reap', '--worktrees', '--reservations', '--yes'],
      ['reap', '--sessions', '--reservations', '--yes'],
      ['reap', '--worktrees', '--sessions', '--reservations', '--yes'],
    ]) {
      const result = await runConductor(runtime, args);
      expect(result.code).toBe(2);
      expect(result.stdout).toEqual([]);
      expect(result.stderr.join('')).toContain('only one of --worktrees, --sessions or --reservations');
    }
    expect(reservations).not.toHaveBeenCalled();
    expect(dryRun).not.toHaveBeenCalled();
  });

  it('rejects --force-unsealed with --reservations', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    const reservations = vi.spyOn(runtime.conductor.reapOrphanReservations, 'reapOrphanReservations');
    const dryRun = vi.spyOn(runtime.conductor.reapOrphanReservationsDryRun, 'reapOrphanReservations');
    const result = await runConductor(runtime, ['reap', '--reservations', '--yes', '--force-unsealed']);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
    expect(result.stderr.join('')).toContain('applies only to --worktrees');
    expect(reservations).not.toHaveBeenCalled();
    expect(dryRun).not.toHaveBeenCalled();
  });

  it('rejects a repeated --reservations', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    const reservations = vi.spyOn(runtime.conductor.reapOrphanReservations, 'reapOrphanReservations');
    const dryRun = vi.spyOn(runtime.conductor.reapOrphanReservationsDryRun, 'reapOrphanReservations');
    const result = await runConductor(runtime, ['reap', '--reservations', '--reservations', '--yes']);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
    expect(result.stderr.join('')).toContain('Repeated flag: --reservations');
    expect(reservations).not.toHaveBeenCalled();
    expect(dryRun).not.toHaveBeenCalled();
  });

  it('rejects an unknown flag and a positional without echoing the token', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    const reservations = vi.spyOn(runtime.conductor.reapOrphanReservations, 'reapOrphanReservations');
    const dryRun = vi.spyOn(runtime.conductor.reapOrphanReservationsDryRun, 'reapOrphanReservations');
    const secretToken = `--gh${'p_'}${'x'.repeat(30)}`;
    const unknown = await runConductor(runtime, ['reap', '--reservations', '--yes', secretToken]);
    expect(unknown.code).toBe(2);
    expect(unknown.stdout).toEqual([]);
    expect(unknown.stderr.join('')).not.toContain('ghp_');
    expect(unknown.stderr.join('')).not.toContain(secretToken);
    const positional = await runConductor(runtime, ['reap', '--reservations', '--yes', 'res-1']);
    expect(positional.code).toBe(2);
    expect(positional.stdout).toEqual([]);
    expect(positional.stderr.join('')).toContain('takes no positional arguments');
    expect(reservations).not.toHaveBeenCalled();
    expect(dryRun).not.toHaveBeenCalled();
  });

  it('requires --yes without --dry-run, and calls nothing', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    const reservations = vi.spyOn(runtime.conductor.reapOrphanReservations, 'reapOrphanReservations');
    const dryRun = vi.spyOn(runtime.conductor.reapOrphanReservationsDryRun, 'reapOrphanReservations');
    const result = await runConductor(runtime, ['reap', '--reservations']);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
    expect(result.stderr.join('')).toContain('conductor reap --reservations requires --yes unless --dry-run is given');
    expect(result.stderr.join('')).toContain('never a reservation no run lists');
    expect(reservations).not.toHaveBeenCalled();
    expect(dryRun).not.toHaveBeenCalled();
  });

  it('needs a durable state directory', async () => {
    const runtime = createFleetCliRuntime();
    const reservations = vi.spyOn(runtime.conductor.reapOrphanReservations, 'reapOrphanReservations');
    const dryRun = vi.spyOn(runtime.conductor.reapOrphanReservationsDryRun, 'reapOrphanReservations');
    const result = await runConductor(runtime, ['reap', '--reservations', '--yes'], null);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
    expect(result.stderr.join('')).toContain('needs a durable state directory');
    expect(reservations).not.toHaveBeenCalled();
    expect(dryRun).not.toHaveBeenCalled();
  });

  it('exits 1 and says nothing was released when the outcome is refused or unknown', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    const useCase = runtime.conductor.reapOrphanReservations;
    for (const result of [
      { outcome: 'refused', reason: 'invalid-request' },
      { outcome: 'unknown', reason: 'reservations-unreadable' },
      { outcome: 'unknown', reason: 'runs-unreadable' },
    ] as ReapOrphanReservationsResult[]) {
      const reap = vi.spyOn(useCase, 'reapOrphanReservations').mockResolvedValue(result);
      const run = await runConductor(runtime, ['reap', '--reservations', '--yes']);
      expect(run.code).toBe(1);
      expect(run.stdout).toHaveLength(1);
      expect(JSON.parse(run.stdout[0]!)).toEqual(result);
      expect(run.stderr).toEqual([NOTHING_RELEASED]);
      reap.mockRestore();
    }
  });

  it('exits 1 with the sweep-failed notice and prints no document when the result cannot be read', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    const useCase = runtime.conductor.reapOrphanReservations;
    const cases: unknown[] = [
      null,
      okResult({ failed: 'x' as unknown as [] }),
    ];
    for (const value of cases) {
      const reap = vi
        .spyOn(useCase, 'reapOrphanReservations')
        .mockResolvedValue(value as unknown as ReapOrphanReservationsResult);
      const run = await runConductor(runtime, ['reap', '--reservations', '--yes']);
      expect(run.code).toBe(1);
      expect(run.stdout).toEqual([]);
      expect(run.stderr).toEqual([SWEEP_FAILED]);
      reap.mockRestore();
    }
    const rejecting = vi
      .spyOn(useCase, 'reapOrphanReservations')
      .mockRejectedValue(new Error('boom /private/path'));
    const rejected = await runConductor(runtime, ['reap', '--reservations', '--yes']);
    expect(rejected.code).toBe(1);
    expect(rejected.stdout).toEqual([]);
    expect(rejected.stderr).toEqual([SWEEP_FAILED]);
    expect(rejected.stderr.join('')).not.toContain('boom');
    rejecting.mockRestore();
    const throwing = okResult();
    Object.defineProperty(throwing, 'failed', {
      get() {
        throw new Error('boom');
      },
    });
    const getter = vi
      .spyOn(useCase, 'reapOrphanReservations')
      .mockResolvedValue(throwing);
    const viaGetter = await runConductor(runtime, ['reap', '--reservations', '--yes']);
    expect(viaGetter.code).toBe(1);
    expect(viaGetter.stdout).toEqual([]);
    expect(viaGetter.stderr).toEqual([SWEEP_FAILED]);
    getter.mockRestore();
  });

  it('prints the sweep-incomplete notice and exits 1 when a run state is unknown and nothing was released', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    const reap = vi
      .spyOn(runtime.conductor.reapOrphanReservations, 'reapOrphanReservations')
      .mockResolvedValue(
        okResult({ unknown: [{ reservationId: 'res-1', attemptId: 'att-1', reason: 'run-state-unknown' }] }),
      );
    const result = await runConductor(runtime, ['reap', '--reservations', '--yes']);
    expect(result.code).toBe(1);
    expect(result.stderr).toEqual([SWEEP_INCOMPLETE]);
    expect(reap).toHaveBeenCalledWith({ dryRun: false, nowIso: NOW });
  });

  it('prints the UNKNOWN count notice and exits 1 for unclassified reservations', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    const attemptUnreadable = vi
      .spyOn(runtime.conductor.reapOrphanReservations, 'reapOrphanReservations')
      .mockResolvedValue(
        okResult({ unknown: [{ reservationId: 'res-1', attemptId: 'att-1', reason: 'attempt-unreadable' }] }),
      );
    const first = await runConductor(runtime, ['reap', '--reservations', '--yes']);
    expect(first.code).toBe(1);
    expect(first.stderr).toEqual([unknownNotice(1)]);
    attemptUnreadable.mockRestore();
    vi
      .spyOn(runtime.conductor.reapOrphanReservations, 'reapOrphanReservations')
      .mockResolvedValue(
        okResult({
          released: [
            {
              reservationId: 'res-0',
              attemptId: 'att-0',
              reason: 'terminal-run',
              workOrderId: null,
              hostName: null,
              slotIndex: null,
              reservedAtIso: NOW,
            },
          ],
          unknown: [{ reservationId: 'res-1', attemptId: 'att-1', reason: 'run-state-unknown' }],
        }),
      );
    const second = await runConductor(runtime, ['reap', '--reservations', '--yes']);
    expect(second.code).toBe(1);
    expect(second.stderr).toEqual([unknownNotice(1)]);
  });

  it('reports an ambiguous release as possibly completed and exits 1', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    vi
      .spyOn(runtime.conductor.reapOrphanReservations, 'reapOrphanReservations')
      .mockResolvedValue(
        okResult({ failed: [{ reservationId: 'res-1', attemptId: 'att-1', reason: 'ambiguous' }] }),
      );
    const result = await runConductor(runtime, ['reap', '--reservations', '--yes']);
    expect(result.code).toBe(1);
    expect(result.stderr).toEqual([ambiguousNotice(1)]);
    expect(result.stderr.join('')).not.toContain('not performed');
  });

  it('exits 1 for each failed reason other than not-held and ambiguous', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    for (const reason of [
      'unfenced',
      'invalid-key',
      'intent-failed',
      'changed',
      'refused',
      'budget-exhausted',
    ] as const) {
      const reap = vi
        .spyOn(runtime.conductor.reapOrphanReservations, 'reapOrphanReservations')
        .mockResolvedValue(
          okResult({ failed: [{ reservationId: 'res-1', attemptId: 'att-1', reason }] }),
        );
      const result = await runConductor(runtime, ['reap', '--reservations', '--yes']);
      expect(result.code).toBe(1);
      expect(result.stderr).toEqual([notPerformedNotice(1)]);
      reap.mockRestore();
    }
  });

  it('exits 1 when a release result could not be journalled', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    vi
      .spyOn(runtime.conductor.reapOrphanReservations, 'reapOrphanReservations')
      .mockResolvedValue(
        okResult({ journalFailed: [{ reservationId: 'res-1', attemptId: 'att-1', reason: 'result-append-failed' }] }),
      );
    const result = await runConductor(runtime, ['reap', '--reservations', '--yes']);
    expect(result.code).toBe(1);
    expect(result.stderr).toEqual([journalFailedNotice(1)]);
  });

  it('--dry-run calls only the read-only use case with dryRun true and the clock, prints one JSON line and exits 0', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    const dryRun = vi
      .spyOn(runtime.conductor.reapOrphanReservationsDryRun, 'reapOrphanReservations')
      .mockResolvedValue(okResult({ dryRun: true }));
    const writable = vi.spyOn(runtime.conductor.reapOrphanReservations, 'reapOrphanReservations');
    const result = await runConductor(runtime, ['reap', '--reservations', '--dry-run']);
    expect(result.code).toBe(0);
    expect(result.stdout).toHaveLength(1);
    expect(JSON.parse(result.stdout[0]!)).toEqual(okResult({ dryRun: true }));
    expect(result.stderr).toEqual([]);
    expect(dryRun).toHaveBeenCalledTimes(1);
    expect(dryRun).toHaveBeenCalledWith({ dryRun: true, nowIso: NOW });
    expect(writable).not.toHaveBeenCalled();
  });

  it('--yes calls only the writable use case with dryRun false and the clock, and exits 0 on a clean reap', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    const writable = vi
      .spyOn(runtime.conductor.reapOrphanReservations, 'reapOrphanReservations')
      .mockResolvedValue(okResult());
    const dryRun = vi.spyOn(runtime.conductor.reapOrphanReservationsDryRun, 'reapOrphanReservations');
    const result = await runConductor(runtime, ['reap', '--reservations', '--yes']);
    expect(result.code).toBe(0);
    expect(result.stdout).toHaveLength(1);
    expect(JSON.parse(result.stdout[0]!)).toEqual(okResult());
    expect(result.stderr).toEqual([]);
    expect(writable).toHaveBeenCalledTimes(1);
    expect(writable).toHaveBeenCalledWith({ dryRun: false, nowIso: NOW });
    expect(dryRun).not.toHaveBeenCalled();
  });

  it('--dry-run with --yes is a dry run', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    const dryRun = vi
      .spyOn(runtime.conductor.reapOrphanReservationsDryRun, 'reapOrphanReservations')
      .mockResolvedValue(okResult({ dryRun: true }));
    const writable = vi.spyOn(runtime.conductor.reapOrphanReservations, 'reapOrphanReservations');
    const result = await runConductor(runtime, ['reap', '--reservations', '--dry-run', '--yes']);
    expect(result.code).toBe(0);
    expect(dryRun).toHaveBeenCalledTimes(1);
    expect(dryRun).toHaveBeenCalledWith({ dryRun: true, nowIso: NOW });
    expect(writable).not.toHaveBeenCalled();
  });

  it('prints the REPORT ONLY notice for reportOnly entries and still exits 0', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    vi
      .spyOn(runtime.conductor.reapOrphanReservations, 'reapOrphanReservations')
      .mockResolvedValue(
        okResult({
          reportOnly: [
            { reservationId: 'res-1', attemptId: 'att-1', reason: 'no-run-unstarted', reservedAtIso: NOW },
            { reservationId: 'res-2', attemptId: 'att-2', reason: 'no-run-unstarted', reservedAtIso: NOW },
          ],
        }),
      );
    const result = await runConductor(runtime, ['reap', '--reservations', '--yes']);
    expect(result.code).toBe(0);
    expect(result.stderr).toEqual([reportOnlyNotice(2)]);
  });

  it('treats a not-held failure as benign: exit 0 and no notice', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    vi
      .spyOn(runtime.conductor.reapOrphanReservations, 'reapOrphanReservations')
      .mockResolvedValue(
        okResult({ failed: [{ reservationId: 'res-1', attemptId: 'att-1', reason: 'not-held' }] }),
      );
    const result = await runConductor(runtime, ['reap', '--reservations', '--yes']);
    expect(result.code).toBe(0);
    expect(result.stderr).toEqual([]);
  });

  it('help names --reservations', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    const result = await runConductor(runtime, ['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout.join('')).toContain('--reservations');
  });

  it('a dry run over an unreadable reservations file reports unknown and writes nothing', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const reservationsFile = join(stateDir, 'reservations.json');
    writeFileSync(reservationsFile, 'not json');
    const before = new Set(readdirSync(stateDir));
    const result = await runConductor(runtime, ['reap', '--reservations', '--dry-run'], stateDir);
    expect(result.code).toBe(1);
    expect(result.stdout).toHaveLength(1);
    expect(JSON.parse(result.stdout[0]!)).toEqual({ outcome: 'unknown', reason: 'reservations-unreadable' });
    expect(new Set(readdirSync(stateDir))).toEqual(before);
    expect(readFileSync(reservationsFile, 'utf8')).toBe('not json');
  });

  it('lists then releases a terminal-run orphan through the real stores', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    await runtime.execution.attemptRepository.saveAttempt(orphanAttempt('attempt-orphan-1'));
    await seedMergedRun(runtime, 'attempt-orphan-1');
    await runtime.execution.executionJournal.saveCapacityReservation({
      id: 'reservation-orphan-1',
      attemptId: 'attempt-orphan-1',
      hostId: 'host-example-1',
      slotIndex: 0,
      held: true,
      seatTool: 'opencode',
      hostName: 'lane-host-example',
      workOrderId: 'wo-example-1',
      reservedAtIso: '2026-10-30T22:00:00.000Z',
      releasedAtIso: null,
    });
    expect(await runtime.execution.executionJournal.listActiveReservations()).toHaveLength(1);

    const dry = await runConductor(runtime, ['reap', '--reservations', '--dry-run'], stateDir);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toHaveLength(1);
    const dryDoc = JSON.parse(dry.stdout[0]!) as Extract<ReapOrphanReservationsResult, { outcome: 'reaped' }>;
    expect(dryDoc.orphans.map((entry) => entry.reservationId)).toEqual(['reservation-orphan-1']);
    expect(dryDoc.released).toEqual([]);
    expect(await runtime.execution.executionJournal.listActiveReservations()).toHaveLength(1);

    const live = await runConductor(runtime, ['reap', '--reservations', '--yes'], stateDir);
    expect(live.code).toBe(0);
    expect(live.stdout).toHaveLength(1);
    const doc = JSON.parse(live.stdout[0]!) as Extract<ReapOrphanReservationsResult, { outcome: 'reaped' }>;
    expect(doc.released).toEqual([
      {
        reservationId: 'reservation-orphan-1',
        attemptId: 'attempt-orphan-1',
        reason: 'terminal-run',
        workOrderId: 'wo-example-1',
        hostName: 'lane-host-example',
        slotIndex: 0,
        reservedAtIso: '2026-10-30T22:00:00.000Z',
      },
    ]);
    expect(doc.failed).toEqual([]);
    expect(doc.journalFailed).toEqual([]);
    expect(doc.unknown).toEqual([]);
    expect(await runtime.execution.executionJournal.listActiveReservations()).toEqual([]);
  });
});
