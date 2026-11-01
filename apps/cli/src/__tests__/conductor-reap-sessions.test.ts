// EX-4: `conductor reap --sessions` — operator-opt-in abort of sessions with
// no live attempt (session records, worktrees, branches and runs are never
// deleted). The flags are strict: exactly one of --worktrees/--sessions is
// required, --yes is required unless --dry-run is given, and a durable state
// directory is required like the other record-only commands.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import type { AttemptRecord, ReapOrphanSessionsResult } from '@fleet/work-execution';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli } from '../index.js';
import type { CliIo } from '../index.js';

const NOW = '2026-10-31T00:00:00.000Z';
const WORKTREE = '/srv/fleet/worktrees/wt1';

const tempStateDirs: string[] = [];

afterAll(() => {
  for (const dir of tempStateDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-v2-conductor-reap-sessions-'));
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

function okResult(overrides: Partial<ReapOrphanSessionsResult> = {}): ReapOrphanSessionsResult {
  return {
    outcome: 'reaped',
    dryRun: false,
    orphans: [{ worktreePath: WORKTREE, attemptId: 'attempt-1', sessionId: 'ses_1' }],
    aborted: [{ worktreePath: WORKTREE }],
    failed: [],
    skipped: [],
    unknown: [],
    legacyAttempts: [],
    ...overrides,
  };
}

/** One finished legacy-runner attempt (no installation host name) for the store. */
function legacyAttempt(id: string, runner: AttemptRecord['runner']): AttemptRecord {
  return {
    id,
    workOrderId: 'wo-a',
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
    runner,
    createdAtIso: NOW,
    updatedAtIso: NOW,
  };
}

describe('conductor reap --sessions (EX-4)', () => {
  it('requires one of --worktrees or --sessions', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    const result = await runConductor(runtime, ['reap']);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
    expect(result.stderr.join('')).toContain('requires --worktrees');
  });

  it('rejects passing both --worktrees and --sessions', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    const reapWorktrees = vi.spyOn(runtime.conductor.reapLaneWorktrees, 'reapLaneWorktrees');
    const reapSessions = vi.spyOn(runtime.conductor.reapOrphanSessions, 'reapOrphanSessions');
    const result = await runConductor(runtime, ['reap', '--worktrees', '--sessions', '--yes']);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
    expect(result.stderr.join('')).toContain('only one of');
    expect(reapWorktrees).not.toHaveBeenCalled();
    expect(reapSessions).not.toHaveBeenCalled();
  });

  it('requires --yes without --dry-run, and calls nothing', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    const reap = vi.spyOn(runtime.conductor.reapOrphanSessions, 'reapOrphanSessions');
    const result = await runConductor(runtime, ['reap', '--sessions']);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
    expect(result.stderr.join('')).toContain('--yes');
    expect(result.stderr.join('')).toContain('does not delete session records, worktrees, branches or runs');
    expect(reap).not.toHaveBeenCalled();
  });

  it('rejects an unknown flag and a positional', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    for (const args of [
      ['reap', '--sessions', '--force'],
      ['reap', '--sessions', '--yes', 'run-01JB000000000000000000000A'],
    ]) {
      const result = await runConductor(runtime, args);
      expect(result.code).toBe(2);
      expect(result.stdout).toEqual([]);
    }
  });

  it('needs a durable state directory like the other record-only commands', async () => {
    const runtime = createFleetCliRuntime();
    const result = await runConductor(runtime, ['reap', '--sessions', '--yes'], null);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
    expect(result.stderr.join('')).toContain('needs a durable state directory');
  });

  it('--dry-run lists the orphan, aborts nothing and exits 0', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    const reap = vi
      .spyOn(runtime.conductor.reapOrphanSessions, 'reapOrphanSessions')
      .mockResolvedValue(okResult({ dryRun: true, aborted: [] }));
    const result = await runConductor(runtime, ['reap', '--sessions', '--dry-run']);
    expect(result.code).toBe(0);
    expect(result.stdout).toHaveLength(1);
    const doc = JSON.parse(result.stdout[0]!) as ReapOrphanSessionsResult;
    expect(doc.outcome).toBe('reaped');
    expect(doc.dryRun).toBe(true);
    expect(doc.orphans).toEqual([
      { worktreePath: WORKTREE, attemptId: 'attempt-1', sessionId: 'ses_1' },
    ]);
    expect(doc.aborted).toEqual([]);
    expect(reap).toHaveBeenCalledWith({ dryRun: true });
  });

  it('--yes aborts and exits 1 when anything failed or is unknown', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    const reap = vi
      .spyOn(runtime.conductor.reapOrphanSessions, 'reapOrphanSessions')
      .mockResolvedValue(okResult({ failed: [{ worktreePath: WORKTREE, outcome: 'refused' }] }));
    const result = await runConductor(runtime, ['reap', '--sessions', '--yes']);
    expect(result.code).toBe(1);
    expect(result.stdout).toHaveLength(1);
    const doc = JSON.parse(result.stdout[0]!) as ReapOrphanSessionsResult;
    expect(doc.outcome).toBe('reaped');
    expect(doc.failed).toEqual([{ worktreePath: WORKTREE, outcome: 'refused' }]);
    expect(reap).toHaveBeenCalledWith({ dryRun: false });
  });

  it('--yes with a clean result exits 0', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    const reap = vi
      .spyOn(runtime.conductor.reapOrphanSessions, 'reapOrphanSessions')
      .mockResolvedValue(okResult());
    const result = await runConductor(runtime, ['reap', '--sessions', '--yes']);
    expect(result.code).toBe(0);
    expect(reap).toHaveBeenCalledWith({ dryRun: false });
  });

  it('--dry-run lists legacy-runner attempts from the store', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    await runtime.execution.attemptRepository.saveAttempt(legacyAttempt('attempt-legacy-1', null));
    await runtime.execution.attemptRepository.saveAttempt(
      legacyAttempt('attempt-legacy-2', {
        kind: 'opencode',
        remotePort: null,
        host: 'legacy-alias',
        hostName: null,
        agent: null,
        model: null,
        variant: null,
      }),
    );

    const result = await runConductor(runtime, ['reap', '--sessions', '--dry-run'], stateDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toHaveLength(1);
    const doc = JSON.parse(result.stdout[0]!) as ReapOrphanSessionsResult;
    expect(doc.legacyAttempts).toEqual([
      {
        attemptId: 'attempt-legacy-1',
        workOrderId: 'wo-a',
        worktreePath: WORKTREE,
        state: 'collected',
        sessionId: null,
        reason: 'no-runner',
      },
      {
        attemptId: 'attempt-legacy-2',
        workOrderId: 'wo-a',
        worktreePath: WORKTREE,
        state: 'collected',
        sessionId: null,
        reason: 'alias-only',
      },
    ]);
  });

  it('help names sessions', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    const result = await runConductor(runtime, ['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout.join('')).toContain('--sessions');
  });
});
