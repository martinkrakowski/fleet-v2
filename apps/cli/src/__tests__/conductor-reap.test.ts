// EX-2b: `conductor reap --worktrees` — operator-opt-in removal of finished
// lanes' clean worktrees (branches kept). The flags are strict: --worktrees
// is required, --yes is required unless --dry-run is given, and a durable
// state directory is required like the other record-only commands.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  LaneRun,
  laneRunConductEntry,
  type LaneRunRecord,
} from '@fleet/work-execution';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli } from '../index.js';
import type { CliIo } from '../index.js';

const RUN_ID = 'run-01JB000000000000000000000A';
const NOW = '2026-10-31T00:00:00.000Z';
const COMMIT = 'a'.repeat(40);
const RECORDED_HOST = {
  kind: 'opencode' as const,
  remotePort: 4166,
  host: 'lane-host',
  hostName: 'lane-host',
  agent: null,
  model: null,
  variant: null,
};

const tempStateDirs: string[] = [];

afterAll(() => {
  for (const dir of tempStateDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-v2-conductor-reap-'));
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

async function registerProfile(runtime: FleetCliRuntime): Promise<void> {
  const result = await runtime.coordination.registerProjectProfile.execute({
    projectId: 'example-project',
    displayName: 'Example Project',
    repository: 'https://example.com/example.git',
    designatedDispatcherHost: 'orchestrator-host',
    policyRevision: 'pol-1',
    maxConcurrentLanes: 2,
    runnerCapabilities: { networkEgressRestricted: true },
    clones: { 'lane-host': { path: '/srv/fleet/clone', worktreeRoot: '/srv/fleet/worktrees' } },
  });
  expect(result.outcome).toBe('registered');
}

/** One merged run: merged journal, merged work order, one collected attempt on a recorded host. */
async function seedMergedRun(runtime: FleetCliRuntime): Promise<void> {
  await registerProfile(runtime);
  await runtime.execution.workOrderRepository.saveWorkOrder({
    id: 'wo-example-1',
    projectId: 'example-project',
    taskId: 'task-1',
    laneId: 'lane-1',
    repository: 'https://example.com/example.git',
    baseCommit: COMMIT,
    ownedPaths: ['packages/example'],
    policyRevision: 'pol-1',
    prerequisiteWorkOrderIds: [],
    state: 'merged',
    revision: 1,
    createdAtIso: NOW,
    updatedAtIso: NOW,
    risk: 'standard',
  });
  await runtime.execution.attemptRepository.saveAttempt({
    id: 'attempt-example-1',
    workOrderId: 'wo-example-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/srv/fleet/worktrees/wt1',
    baseCommit: COMMIT,
    state: 'collected',
    outcome: null,
    briefDigest: 'b'.repeat(64),
    briefPackagePath: '.lane/brief-package',
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    runner: RECORDED_HOST,
    createdAtIso: NOW,
    updatedAtIso: NOW,
  });
  const created = LaneRun.create({
    version: 1,
    runId: RUN_ID,
    workOrderId: 'wo-example-1',
    tier: 2,
    seatPlanRef: 'c'.repeat(64),
    cursors: { 'first-pass': 0, fix: null, review: null },
    round: 0,
    attemptIds: ['attempt-example-1'],
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

describe('conductor reap --worktrees (EX-2b)', () => {
  it('requires --worktrees', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    const result = await runConductor(runtime, ['reap']);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
    expect(result.stderr.join('')).toContain('requires --worktrees');
  });

  it('requires --yes without --dry-run, and calls nothing', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    const result = await runConductor(runtime, ['reap', '--worktrees']);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
    expect(result.stderr.join('')).toContain('--yes');
  });

  it('rejects an unknown flag and a positional', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    for (const args of [
      ['reap', '--worktrees', '--force'],
      ['reap', '--worktrees', '--yes', 'run-01JB000000000000000000000A'],
    ]) {
      const result = await runConductor(runtime, args);
      expect(result.code).toBe(2);
      expect(result.stdout).toEqual([]);
    }
  });

  it('needs a durable state directory like the other record-only commands', async () => {
    const runtime = createFleetCliRuntime();
    const result = await runConductor(runtime, ['reap', '--worktrees', '--yes'], null);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
    expect(result.stderr.join('')).toContain('needs a durable state directory');
  });

  it('--dry-run lists the candidate, removes nothing and exits 0', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    await seedMergedRun(runtime);
    const result = await runConductor(runtime, ['reap', '--worktrees', '--dry-run']);
    expect(result.code).toBe(0);
    expect(result.stdout).toHaveLength(1);
    const doc = JSON.parse(result.stdout[0]!) as {
      outcome: string;
      dryRun: boolean;
      removed: { runId: string; branchTip: string | null }[];
      alreadyRemoved: unknown[];
      refused: unknown[];
      skipped: unknown[];
    };
    expect(doc.outcome).toBe('reaped');
    expect(doc.dryRun).toBe(true);
    expect(doc.removed).toEqual([{ runId: RUN_ID, branchTip: null }]);
    expect(doc.alreadyRemoved).toEqual([]);
    expect(doc.refused).toEqual([]);
    expect(doc.skipped).toEqual([]);
  });

  it('--dry-run lists a non-terminal run as skipped', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    await seedMergedRun(runtime);
    // Move the run's conduct to a non-terminal state so it is not a candidate.
    expect(
      await runtime.conductor.laneRunJournal.append(
        laneRunConductEntry('01JB0000000000000000000002', RUN_ID, 'running', NOW),
      ),
    ).toMatchObject({ outcome: 'appended' });
    const result = await runConductor(runtime, ['reap', '--worktrees', '--dry-run']);
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.stdout[0]!) as { removed: unknown[]; skipped: { runId: string; reason: string }[] };
    expect(doc.removed).toEqual([]);
    expect(doc.skipped).toEqual([{ runId: RUN_ID, reason: 'run-not-terminal' }]);
  });

  it('--yes attempts the removal and exits 1 when it is refused or unknown', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    await seedMergedRun(runtime);
    // The clone path does not exist and host 'lane-host' resolves to no
    // executor, so the removal is refused/unknown — never a silent pass.
    const result = await runConductor(runtime, ['reap', '--worktrees', '--yes']);
    expect(result.code).toBe(1);
    expect(result.stdout).toHaveLength(1);
    const doc = JSON.parse(result.stdout[0]!) as {
      outcome: string;
      removed: unknown[];
      refused: { runId: string; reason: string }[];
    };
    expect(doc.outcome).toBe('reaped');
    expect(doc.removed).toEqual([]);
    expect(doc.refused.length).toBeGreaterThan(0);
    expect(doc.refused[0]!.runId).toBe(RUN_ID);
  });

  it('help names reap', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempStateDir() });
    const result = await runConductor(runtime, ['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout.join('')).toContain('reap');
  });
});
