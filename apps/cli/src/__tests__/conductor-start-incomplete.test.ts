// `conductor start` incomplete-fallback tests: the closed-code ledger and the
// crashed-start attention items. Every test runs over fakes only — a scripted
// driver whose `start.startLaneRun` returns the scripted result and touches no
// git, no runner, no subprocess, no network.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveConductorPolicy, type FleetInstallation, type ForgeSectionV2 } from '@fleet/installation';
import type { StartLaneRunResult } from '@fleet/work-execution';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli } from '../index.js';
import type { CliIo } from '../index.js';
import type { ConductorDriver } from '../conductor-wiring.js';

const NOW = '2026-10-27T10:00:00.000Z';
const HELD_AT = '2026-10-27T08:59:00.000Z';
const RUN_ID = 'run-01JB0000000000000000000000';
const ATTEMPT_ID = 'attempt-example-1';
const BRIEF_FILE = 'brief-request-example-1.json';

const FORGE_NONE: ForgeSectionV2 = { mode: 'none' };

function makeInstallation(): FleetInstallation {
  return {
    schemaVersion: 2,
    hosts: {
      local: {
        transport: 'local',
        worktreeRoot: '/tmp/fleet-k7-worktrees',
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
    forge: FORGE_NONE,
    policy: { conductor: { enabled: true } },
  };
}

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-v2-conductor-start-incomplete-'));
}

function runtimeOf(stateDir: string): FleetCliRuntime {
  return createFleetCliRuntime({
    stateDir,
    installation: makeInstallation(),
    runSubprocess: () => {
      throw new Error('the conductor must never dispatch a subprocess');
    },
    env: {},
  });
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

async function runStart(
  runtime: FleetCliRuntime,
  stateDir: string,
  args: readonly string[],
  driver: ConductorDriver,
): Promise<{ code: number; stdout: readonly string[]; stderr: readonly string[] }> {
  const io = captureIo();
  const code = await runCli(
    ['conductor', 'start', ...args],
    io,
    runtime,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { now: () => NOW, stateDir, buildDriver: () => driver },
  );
  return { code, stdout: io.outLines, stderr: io.errLines };
}

function fakeDriver(startResult: StartLaneRunResult): ConductorDriver {
  return {
    pass: {
      runPass: async () => {
        throw new Error('no pass is scripted');
      },
      releaseLeases: async () => ({ released: 0 }),
    },
    start: {
      startLaneRun: async () => startResult,
      abandonStart: async () => {
        throw new Error('no abandon is scripted');
      },
    },
    policy: resolveConductorPolicy({ conductor: { enabled: true } }),
    runPolicyRevision: 'policy:conductor@0123456789ab',
  };
}

function briefFixture(): Record<string, unknown> {
  return {
    workOrderId: 'wo-example-1',
    projectId: 'project-example-1',
    taskId: 'task-example-1',
    laneId: 'lane-example-1',
    repository: 'repo-example-1',
    baseCommit: 'a'.repeat(40),
    policyRevision: 'policy-example-1',
    modelAssignment: {
      model: 'model-example-1',
      variant: 'default',
      fallbackModel: 'model-example-2',
      seatTool: 'opencode',
    },
    seatPlan: {
      version: 1,
      'first-pass': [{ id: 'fp-1', model: 'model-example-1', tool: 'opencode' }],
      fix: [{ id: 'fx-1', model: 'model-example-1', tool: 'opencode' }],
      review: [],
    },
    independentReviewer: 'reviewer-model-example-1',
    ownedPaths: ['packages/example/src'],
    permissions: [],
    acceptanceChecks: [],
    acceptanceSpec: {
      commitRequired: true,
      diffCheck: true,
      commands: [{ argv: ['node', '--eval', 'process.exit(0)'] }],
    },
    stepLimit: 40,
    timeLimitSeconds: 2700,
    resourceBounds: {},
    expectedArtifacts: [],
    ownerDecisionReferences: [],
    contextDecisions: [],
    prNotes: {
      hardToUndo: 'The conductor opens the PR and merges it automatically',
      assumptions: 'The base branch is main and CI passes',
      challengeThis: 'That the merge train is safe without a reviewer on the final diff',
    },
  };
}

/** A held reservation 61 minutes before NOW, slot 0, for the seeded attempt. */
async function seedCrashedStart(runtime: FleetCliRuntime, attemptId: string): Promise<void> {
  await runtime.execution.workOrderRepository.saveWorkOrder({
    id: 'wo-example-1',
    projectId: 'project-example-1',
    taskId: 'task-example-1',
    laneId: 'lane-example-1',
    repository: 'repo-example-1',
    baseCommit: 'a'.repeat(40),
    ownedPaths: ['packages/example/src'],
    policyRevision: 'policy-example-1',
    prerequisiteWorkOrderIds: [],
    state: 'approved',
    revision: 1,
    createdAtIso: HELD_AT,
    updatedAtIso: HELD_AT,
  });
  await runtime.execution.executionJournal.saveCapacityReservation({
    id: 'res-example-1',
    attemptId,
    hostId: 'host-example-1',
    slotIndex: 0,
    held: true,
    seatTool: 'opencode',
    hostName: 'host-example-1',
    hostKind: 'opencode',
    transport: 'local',
    sshAlias: null,
    port: 41001,
    worktreePath: '/tmp/fleet-k7-worktrees/example',
    workOrderId: 'wo-example-1',
    reservedAtIso: HELD_AT,
    releasedAtIso: null,
  });
}

const BRIEF_FACT = {
  attemptId: ATTEMPT_ID,
  runId: RUN_ID,
  step: 'brief' as const,
  reasonCode: 'brief-rejected' as const,
  recordedAtIso: HELD_AT,
};

const START_ARGS = (briefPath: string) => [
  '--brief-request',
  briefPath,
  '--tier',
  '2',
  '--run-id',
  'run-01JB0000000000000000000009',
  '--attempt-id',
  'attempt-01JB0000000000000000000009',
];

async function listedCrashedStartSummaries(runtime: FleetCliRuntime): Promise<readonly string[]> {
  const listed = await runtime.coordination.listAttentionItems.listAttentionItems({ kind: 'crashed-start' });
  return listed.items.map((entry) => entry.item.summary);
}

describe('conductor start incomplete ledger (AD-2)', () => {
  it('raises a crashed-start notice from the recorded ledger fact', async () => {
    const dir = tempStateDir();
    const briefPath = join(dir, BRIEF_FILE);
    writeFileSync(briefPath, JSON.stringify(briefFixture()), 'utf8');
    const runtime = runtimeOf(dir);
    await seedCrashedStart(runtime, ATTEMPT_ID);
    await runtime.execution.executionJournal.appendStartIncomplete?.(BRIEF_FACT);

    // A different attempt starts, so the scan does not skip the seeded one.
    const result = await runStart(runtime, dir, START_ARGS(briefPath), fakeDriver({
      outcome: 'started',
      runId: 'run-01JB0000000000000000000009',
      attemptId: 'attempt-01JB0000000000000000000009',
      hostName: 'host-example-1',
      worktreePath: '/tmp/fleet-k7-worktrees/example-9',
    }));

    expect(result.code).toBe(0);
    const summaries = await listedCrashedStartSummaries(runtime);
    expect(summaries).toHaveLength(1);
    const summary = summaries[0]!;
    expect(summary).toContain('step brief');
    expect(summary).toContain('reason brief-rejected');
    expect(summary).toContain('slot 0');
    expect(summary).toContain(
      `conductor start --abandon --run-id ${RUN_ID} --attempt-id ${ATTEMPT_ID}`,
    );
    expect(summary).not.toContain('worktreePath');
  });

  it('keeps the old crashed-start summary when no fact was recorded', async () => {
    const dir = tempStateDir();
    const briefPath = join(dir, BRIEF_FILE);
    writeFileSync(briefPath, JSON.stringify(briefFixture()), 'utf8');
    const runtime = runtimeOf(dir);
    await seedCrashedStart(runtime, ATTEMPT_ID);

    const result = await runStart(runtime, dir, START_ARGS(briefPath), fakeDriver({
      outcome: 'started',
      runId: 'run-01JB0000000000000000000009',
      attemptId: 'attempt-01JB0000000000000000000009',
      hostName: 'host-example-1',
      worktreePath: '/tmp/fleet-k7-worktrees/example-9',
    }));

    expect(result.code).toBe(0);
    const summaries = await listedCrashedStartSummaries(runtime);
    expect(summaries).toEqual([
      `A lane start crashed and left capacity slot 0 held for attempt ${ATTEMPT_ID}.`,
    ]);
  });

  it('raises the attention item immediately from an incomplete start that wrote no fact', async () => {
    const dir = tempStateDir();
    const briefPath = join(dir, BRIEF_FILE);
    writeFileSync(briefPath, JSON.stringify(briefFixture()), 'utf8');
    const runtime = runtimeOf(dir);

    const result = await runStart(runtime, dir, ['--brief-request', briefPath, '--tier', '2'], fakeDriver({
      outcome: 'incomplete',
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      step: 'brief',
      reason: 'brief-rejected: worktreePath is required',
    }));

    expect(result.code).toBe(1);
    const summaries = await listedCrashedStartSummaries(runtime);
    expect(summaries).toHaveLength(1);
    const summary = summaries[0]!;
    expect(summary).toContain('step brief');
    expect(summary).toContain('reason brief-rejected');
    expect(summary).toContain(
      `conductor start --abandon --run-id ${RUN_ID} --attempt-id ${ATTEMPT_ID}`,
    );
    expect(summary).not.toContain('worktreePath');
  });

  it('prints the closed code when the attention write throws after an incomplete start', async () => {
    const dir = tempStateDir();
    const briefPath = join(dir, BRIEF_FILE);
    writeFileSync(briefPath, JSON.stringify(briefFixture()), 'utf8');
    const runtime = runtimeOf(dir);
    const record = runtime.coordination.recordAttentionItem.recordAttentionItem.bind(
      runtime.coordination.recordAttentionItem,
    );
    (runtime.coordination.recordAttentionItem as unknown as { recordAttentionItem: unknown }).recordAttentionItem =
      async () => {
        throw new Error('example attention failure');
      };

    const result = await runStart(runtime, dir, ['--brief-request', briefPath, '--tier', '2'], fakeDriver({
      outcome: 'incomplete',
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      step: 'brief',
      reason: 'brief-rejected: worktreePath is required',
    }));

    expect(result.code).toBe(1);
    expect(result.stderr).toEqual(['start-incomplete-unrecorded step=brief reason=brief-rejected\n']);
    expect(JSON.parse(result.stdout[0]!)).toMatchObject({
      outcome: 'incomplete',
      step: 'brief',
      reason: 'brief-rejected: worktreePath is required',
    });
    // The wrapper is restored so the runtime stays usable after the test.
    (runtime.coordination.recordAttentionItem as unknown as { recordAttentionItem: unknown }).recordAttentionItem =
      record;
  });
});
