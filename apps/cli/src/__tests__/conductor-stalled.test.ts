// PT1a (SN2, SN3): stall attention and `conductor status --stalled` through the real CLI composition.
/**
 * Nothing here is wired only for the test: the runtime is the production
 * composition over file stores, the status command is the real `runCli`, and
 * the pass is the one `buildLiveConductorDriver` builds for `conductor run
 * --live`, reading the stall threshold from the installation's
 * `policy.daemon.stallAfterMinutes`. The runtime's subprocess runner throws, so
 * nothing dispatches.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { FleetInstallation } from '@fleet/installation';
import { LaneRun, laneRunConductEntry, type LaneRunRecord } from '@fleet/work-execution';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { buildLiveConductorDriver } from '../conductor-wiring.js';
import { runCli } from '../index.js';
import type { CliIo } from '../index.js';

/** Ids shaped like `.fleet/state` records (lane-runs.json, work-orders.json). */
const RUN_OLD = 'run-01M63WPH4GMF2CA3NQ7JAM4HS1';
const RUN_YOUNG = 'run-01M63WPH4GMF2CA3NQ7JAM4HS2';
const WORK_ORDER_OLD = 'wo-fleet-v2-rv4-2026-11-06';
const WORK_ORDER_YOUNG = 'wo-fleet-v2-co14b-2026-11-06';
const PROJECT_ID = 'fleet-v2';
const HOLDER = 'driver-01M64PT1PX2MAZVQDYAYMZ7WNB';

function installation(stallAfterMinutes?: number): FleetInstallation {
  return {
    schemaVersion: 2,
    hosts: {
      local: {
        transport: 'local',
        worktreeRoot: '/tmp/fleet-pt1a-worktrees',
        roles: ['orchestrator', 'lane-runner'],
        runner: {
          kind: 'opencode',
          port: 46000,
          capabilities: {
            networkEgressRestricted: true,
            cpuAndMemoryLimited: true,
            processTreeTermination: true,
            filesystemScope: 'scoped-worktree',
          },
          maxLanes: 2,
        },
      },
    },
    forge: { mode: 'none' },
    ...(stallAfterMinutes === undefined ? {} : { policy: { daemon: { stallAfterMinutes } } }),
  } as FleetInstallation;
}

function runtimeOf(stateDir: string, stallAfterMinutes?: number): FleetCliRuntime {
  return createFleetCliRuntime({
    stateDir,
    installation: installation(stallAfterMinutes),
    runSubprocess: () => {
      throw new Error('the conductor must never dispatch a subprocess');
    },
    env: {},
  });
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function record(runId: string, workOrderId: string, parked: Record<string, unknown> | null, prNumber: number | null = null): LaneRunRecord {
  const created = LaneRun.create({
    version: 1,
    runId,
    workOrderId,
    tier: 2,
    seatPlanRef: 'a'.repeat(64),
    cursors: { 'first-pass': 0, fix: null, review: null },
    round: 0,
    attemptIds: ['attempt-01M64PT1PX2MAZVQDYAYMZ7WNB'],
    prNumber,
    parked,
    parkCount: parked === null ? 0 : 1,
    lease: null,
    revision: 1,
    runPolicyRevision: 'policy:conductor@7844746b0277',
    schemaVersion: 1,
  });
  if (!created.success) {
    throw new Error('fixture must be a valid LaneRun record');
  }
  return created.value.toRecord();
}

async function seedWorkOrder(runtime: FleetCliRuntime, id: string): Promise<void> {
  await runtime.execution.workOrderRepository.saveWorkOrder({
    id,
    projectId: PROJECT_ID,
    taskId: 'task-' + id,
    laneId: 'lane-' + id,
    repository: 'martinkrakowski/fleet-v2',
    baseCommit: 'a'.repeat(40),
    ownedPaths: ['packages/work-execution/src/domain'],
    policyRevision: 'policy:conductor@7844746b0277',
    prerequisiteWorkOrderIds: [],
    state: 'approved',
    revision: 1,
    createdAtIso: minutesAgo(600),
    updatedAtIso: minutesAgo(600),
  });
}

async function seedParkedRun(
  runtime: FleetCliRuntime,
  runId: string,
  workOrderId: string,
  parkedMinutesAgo: number,
  parkClass: string | undefined,
  entryId: string,
  prNumber: number | null = null,
): Promise<void> {
  await seedWorkOrder(runtime, workOrderId);
  const parked = {
    reason: 'step-refused',
    qualifier: 'prepare',
    parkedFrom: 'fixing',
    questionId: null,
    ...(parkClass === undefined ? {} : { class: parkClass }),
  };
  expect(await runtime.conductor.laneRunRepository.create(record(runId, workOrderId, parked, prNumber))).toMatchObject({ outcome: 'saved' });
  expect(
    await runtime.conductor.laneRunJournal.append(laneRunConductEntry(entryId, runId, 'parked', minutesAgo(parkedMinutesAgo))),
  ).toMatchObject({ outcome: 'appended' });
}

function captureIo(): CliIo & { readonly out: string[]; readonly err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (text: string) => void out.push(text), stderr: (text: string) => void err.push(text) };
}

async function statusStalled(runtime: FleetCliRuntime, stateDir: string, args: readonly string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const io = captureIo();
  const code = await runCli(['conductor', 'status', ...args], io, runtime, undefined, undefined, undefined, undefined, undefined, undefined, {
    now: () => new Date().toISOString(),
    stateDir,
  });
  return { code, out: io.out, err: io.err };
}

describe('conductor status --stalled (PT1a, SN3)', () => {
  it('lists the stalled runs as id, class, age and work order, oldest first, over the real composition', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'fleet-v2-pt1a-status-'));
    const runtime = runtimeOf(stateDir);
    await seedParkedRun(runtime, RUN_YOUNG, WORK_ORDER_YOUNG, 50, undefined, '01M64PT1PX2MAZVQDYAYMZ7WN2');
    await seedParkedRun(runtime, RUN_OLD, WORK_ORDER_OLD, 200, 'blocker', '01M64PT1PX2MAZVQDYAYMZ7WN1');
    const result = await statusStalled(runtime, stateDir, ['--stalled']);
    expect(result.code).toBe(0);
    expect(result.out).toHaveLength(1);
    const document = JSON.parse(result.out[0]!) as {
      outcome: string;
      stallAfterMinutes: number;
      stalled: { runId: string; class: string; ageMinutes: number; workOrderId: string }[];
    };
    expect(document.outcome).toBe('listed');
    expect(document.stallAfterMinutes).toBe(30);
    expect(document.stalled.map((row) => [row.runId, row.class, row.workOrderId])).toEqual([
      [RUN_OLD, 'blocker', WORK_ORDER_OLD],
      // A record written before PT1a has no class and reads as other.
      [RUN_YOUNG, 'other', WORK_ORDER_YOUNG],
    ]);
    expect(document.stalled[0]!.ageMinutes).toBeGreaterThanOrEqual(200);
    expect(document.stalled[1]!.ageMinutes).toBeGreaterThanOrEqual(50);
  });

  it('reads the threshold from policy.daemon.stallAfterMinutes', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'fleet-v2-pt1a-policy-'));
    const runtime = runtimeOf(stateDir, 120);
    await seedParkedRun(runtime, RUN_YOUNG, WORK_ORDER_YOUNG, 50, undefined, '01M64PT1PX2MAZVQDYAYMZ7WN2');
    await seedParkedRun(runtime, RUN_OLD, WORK_ORDER_OLD, 200, 'blocker', '01M64PT1PX2MAZVQDYAYMZ7WN1');
    const document = JSON.parse((await statusStalled(runtime, stateDir, ['--stalled'])).out[0]!) as {
      stallAfterMinutes: number;
      stalled: { runId: string }[];
    };
    expect(document.stallAfterMinutes).toBe(120);
    expect(document.stalled.map((row) => row.runId)).toEqual([RUN_OLD]);
  });

  it('lists a run parked past the threshold with an open PR, with the same class and age fields', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'fleet-v2-pt1a-pr-'));
    const runtime = runtimeOf(stateDir);
    await seedParkedRun(runtime, RUN_OLD, WORK_ORDER_OLD, 90, 'blocker', '01M64PT1PX2MAZVQDYAYMZ7WN1', 819);
    const document = JSON.parse((await statusStalled(runtime, stateDir, ['--stalled'])).out[0]!) as {
      stalled: { runId: string; class: string; workOrderId: string }[];
    };
    expect(document.stalled.map((row) => [row.runId, row.class, row.workOrderId])).toEqual([[RUN_OLD, 'blocker', WORK_ORDER_OLD]]);
  });

  it('is an empty list when nothing is parked, and a usage error with a run id', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'fleet-v2-pt1a-empty-'));
    const runtime = runtimeOf(stateDir);
    const empty = await statusStalled(runtime, stateDir, ['--stalled']);
    expect(empty.code).toBe(0);
    expect(JSON.parse(empty.out[0]!)).toEqual({ outcome: 'listed', stallAfterMinutes: 30, stalled: [] });
    const withRun = await statusStalled(runtime, stateDir, ['--stalled', RUN_OLD]);
    expect(withRun.code).toBe(2);
    expect(withRun.err.join('')).toContain('--stalled takes no run id');
  });

  it('other subcommands refuse --stalled, and plain status is unchanged', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'fleet-v2-pt1a-shape-'));
    const runtime = runtimeOf(stateDir);
    const io = captureIo();
    const code = await runCli(['conductor', 'halt', '--stalled'], io, runtime, undefined, undefined, undefined, undefined, undefined, undefined, { now: () => new Date().toISOString(), stateDir });
    expect(code).toBe(2);
    const plain = await statusStalled(runtime, stateDir, []);
    expect(plain.code).toBe(0);
    expect(JSON.parse(plain.out[0]!)).toMatchObject({ outcome: 'listed', halt: 'clear' });
  });
});

describe('stall attention through the live conductor driver (PT1a, SN2)', () => {
  async function items(runtime: FleetCliRuntime) {
    return runtime.coordination.attentionItemRepository.list({ projectId: PROJECT_ID });
  }

  it('raises one stall:<runId> item per stalled run, refreshes it in place and clears it when the run leaves parked', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'fleet-v2-pt1a-pass-'));
    const runtime = runtimeOf(stateDir);
    await seedParkedRun(runtime, RUN_OLD, WORK_ORDER_OLD, 61, 'blocker', '01M64PT1PX2MAZVQDYAYMZ7WN1');
    const driver = buildLiveConductorDriver(runtime, { maxActiveRuns: 1, stateDir });

    const first = await driver.pass.runPass({ holderId: HOLDER, nowIso: new Date().toISOString() });
    expect(first).toMatchObject({ outcome: 'completed' });
    const raised = (await items(runtime)).filter((entry) => entry.item.kind === 'conductor-stall');
    expect(raised).toHaveLength(1);
    expect(raised[0]!.item).toMatchObject({
      state: 'open',
      subject: { kind: 'run', ref: RUN_OLD },
      workOrderId: WORK_ORDER_OLD,
    });
    expect(raised[0]!.item.summary).toBe(`stall:${RUN_OLD} class=blocker parked>=60m work-order=${WORK_ORDER_OLD}`);

    // A later pass refreshes the same item; the store never holds a second one.
    await driver.pass.runPass({ holderId: HOLDER, nowIso: new Date().toISOString() });
    expect((await items(runtime)).filter((entry) => entry.item.kind === 'conductor-stall')).toHaveLength(1);

    // The run resumes: its park record is reset and the journal projects the state it returned to.
    const parked = await runtime.conductor.laneRunRepository.get(RUN_OLD);
    expect(parked).not.toBeNull();
    const lease = { holderId: HOLDER, fence: 1, leaseUntilIso: new Date(Date.now() + 3_600_000).toISOString() };
    await runtime.conductor.laneRunRepository.acquireLease(RUN_OLD, {
      holderId: HOLDER,
      observedFence: (await runtime.conductor.laneRunRepository.get(RUN_OLD))?.lease?.fence ?? 0,
      leaseUntilIso: lease.leaseUntilIso,
      nowIso: new Date().toISOString(),
    });
    const leased = await runtime.conductor.laneRunRepository.get(RUN_OLD);
    await runtime.conductor.laneRunRepository.save(
      { ...leased!, parked: null, revision: leased!.revision + 1 },
      { holderId: HOLDER, fence: leased!.lease!.fence, nowIso: new Date().toISOString() },
    );
    await runtime.conductor.laneRunJournal.append(laneRunConductEntry('01M64PT1PX2MAZVQDYAYMZ7WN9', RUN_OLD, 'merged', new Date().toISOString()));

    await driver.pass.runPass({ holderId: HOLDER, nowIso: new Date().toISOString() });
    const after = (await items(runtime)).filter((entry) => entry.item.kind === 'conductor-stall');
    expect(after).toHaveLength(1);
    expect(after[0]!.item.state).toBe('cleared');
  });

  it('a run parked past the threshold with an open PR raises exactly one stall item through the live driver', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'fleet-v2-pt1a-prpass-'));
    const runtime = runtimeOf(stateDir);
    await seedParkedRun(runtime, RUN_OLD, WORK_ORDER_OLD, 61, 'blocker', '01M64PT1PX2MAZVQDYAYMZ7WN1', 819);
    const driver = buildLiveConductorDriver(runtime, { maxActiveRuns: 1, stateDir });
    await driver.pass.runPass({ holderId: HOLDER, nowIso: new Date().toISOString() });
    await driver.pass.runPass({ holderId: HOLDER, nowIso: new Date().toISOString() });
    const stall = (await items(runtime)).filter((entry) => entry.item.kind === 'conductor-stall');
    expect(stall).toHaveLength(1);
    expect(stall[0]!.item).toMatchObject({ state: 'open', subject: { kind: 'run', ref: RUN_OLD } });
  });

  it('a run under the policy threshold raises nothing', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'fleet-v2-pt1a-under-'));
    const runtime = runtimeOf(stateDir, 240);
    await seedParkedRun(runtime, RUN_OLD, WORK_ORDER_OLD, 61, 'blocker', '01M64PT1PX2MAZVQDYAYMZ7WN1');
    const driver = buildLiveConductorDriver(runtime, { maxActiveRuns: 1, stateDir });
    await driver.pass.runPass({ holderId: HOLDER, nowIso: new Date().toISOString() });
    expect((await items(runtime)).filter((entry) => entry.item.kind === 'conductor-stall')).toEqual([]);
  });
});
