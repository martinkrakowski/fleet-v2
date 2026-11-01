// Conductor telemetry isolation (OT5, plan §3.7): telemetry can never change a
// run. One baseline runtime with telemetry off drives one fixture run with seeded
// state and real journal writes; each telemetry fault is injected at its own
// component in a real `ExportRunTelemetry` use case over a temporary state directory
// (or at the mark/execute level for lifetime faults) with a real
// `DriverTelemetryExporter`. For every fault the decisions, journal entries and
// exit code equal the baseline's, the driver's exit is delayed by at most the
// 2 s stop race, and no unhandled rejection is reported. A final
// real-composition case runs the composed export over a corrupt assessments
// file and asserts the state directory gains nothing outside the disposition
// store and no quarantine copy.
import { createHash, createHmac } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { resolveConductorPolicy, type FleetInstallation } from '@fleet/installation';
import {
  EvidenceAssessmentRepositoryAdapter,
  InspectAcceptanceEvidenceUseCase,
} from '@fleet/evidence-and-acceptance';
import {
  AcceptanceReceiptReadAdapter,
  AttemptRepositoryAdapter,
  ExportRunTelemetryUseCase,
  LANE_RUN_RECORD_VERSION,
  LaneRunJournalAdapter,
  LaneRunRepositoryAdapter,
  NoopRunTelemetryAdapter,
  TelemetryDispositionAdapter,
  WorkOrderRepositoryAdapter,
  type AttemptRecord,
  type ConductorRunReport,
  type ExportRunTelemetryCounts,
  type ExportRunTelemetryDependencies,
  type ExportRunTelemetryPort,
  type ExportRunTelemetryResult,
  type LaneRunRecord,
  type RunConductorPassResult,
  type TelemetryDispositionWriteResult,
  type TelemetryHmac,
  type WorkOrderRecord,
} from '@fleet/work-execution';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli } from '../index.js';
import type { CliIo } from '../index.js';
import type { ConductorCliOptions } from '../conductor.js';
import type { ConductorDriver } from '../conductor-wiring.js';
import { DriverTelemetryExporter } from '../telemetry-exporter.js';

const NOW = '2026-10-27T10:00:00.000Z';
const RUN_ID = 'run-01JB0000000000000000000000';
const ATTEMPT_ID = 'attempt-example-1';
const WORK_ORDER_ID = 'wo-example-1';
const HEAD_COMMIT = 'a'.repeat(40);
const SALT = '0123456789abcdef'.repeat(4);
const ADVANCED_REPORT: ConductorRunReport = {
  runId: RUN_ID,
  outcome: 'advanced',
  steps: [{ outcome: 'entered', state: 'running' }],
};
const FIXTURE_PASS: RunConductorPassResult = {
  outcome: 'completed',
  halted: false,
  progressed: true,
  runs: [ADVANCED_REPORT],
  attention: [],
};

function throwingRunSubprocess(): never {
  throw new Error('the conductor must never dispatch a subprocess');
}

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-v2-conductor-telemetry-isolation-'));
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

/** A scripted fake driver with an enabled conductor policy, like conductor-run.test.ts. */
function makeFakeDriver(passes: readonly RunConductorPassResult[]): { readonly driver: ConductorDriver } {
  const passCalls: unknown[] = [];
  const driver: ConductorDriver = {
    pass: {
      runPass: async (request) => {
        passCalls.push(request);
        const scripted = passes[passCalls.length - 1];
        if (scripted === undefined) {
          throw new Error('no scripted pass left');
        }
        return scripted;
      },
      releaseLeases: async () => ({ released: 0 }),
    },
    start: null,
    policy: resolveConductorPolicy({ conductor: { enabled: true } }),
    runPolicyRevision: 'policy:conductor@0123456789ab',
  };
  return { driver };
}

/** A pass driver with an enabled conductor policy that appends a real journal entry on each pass. */
function makePassDriver(
  runtime: FleetCliRuntime,
  passes: readonly RunConductorPassResult[],
): { readonly driver: ConductorDriver } {
  const passCalls: unknown[] = [];
  const driver: ConductorDriver = {
    pass: {
      runPass: async (request) => {
        passCalls.push(request);
        await runtime.conductor.laneRunJournal.append({
          version: 1,
          entryId: 'entry-pass-' + passCalls.length,
          kind: 'conduct',
          key: null,
          runId: RUN_ID,
          recordedAtIso: request.nowIso,
          mode: null,
          expectedRevision: null,
          mintedId: null,
          outcome: null,
          reasonCode: null,
          detail: null,
          grantId: null,
          state: 'running',
        });
        const scripted = passes[passCalls.length - 1];
        if (scripted === undefined) {
          throw new Error('no scripted pass left');
        }
        return scripted;
      },
      releaseLeases: async () => ({ released: 0 }),
    },
    start: null,
    policy: resolveConductorPolicy({ conductor: { enabled: true } }),
    runPolicyRevision: 'policy:conductor@0123456789ab',
  };
  return { driver };
}

/** Seed one work order, one collected attempt and one run owning it, with an initial journal entry. */
async function seedConductorRunState(runtime: FleetCliRuntime): Promise<void> {
  const workOrder: WorkOrderRecord = {
    id: WORK_ORDER_ID,
    projectId: 'project-example-1',
    taskId: 'task-example-1',
    laneId: 'lane-example-1',
    repository: 'repo-example-1',
    baseCommit: HEAD_COMMIT,
    ownedPaths: ['packages/example/src'],
    policyRevision: 'policy-example-1',
    prerequisiteWorkOrderIds: [],
    state: 'approved',
    revision: 1,
    createdAtIso: NOW,
    updatedAtIso: NOW,
  };
  await runtime.execution.workOrderRepository.saveWorkOrder(workOrder);

  const attempt: AttemptRecord = {
    id: ATTEMPT_ID,
    workOrderId: WORK_ORDER_ID,
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/example/worktree/path',
    baseCommit: HEAD_COMMIT,
    state: 'collected',
    revision: 1,
    dispatchRevision: 1,
    outcome: 'done',
    briefDigest: null,
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: {
      attemptId: ATTEMPT_ID,
      sessionId: 'example-session',
      endedAtIso: '2026-10-29T10:00:30.000Z',
      authoritative: true,
      exitStatus: 0,
      stoppedByRequest: false,
    },
    artifacts: { headCommit: HEAD_COMMIT, commitsSinceBase: [], collectedArtifactPaths: [], notes: 'present' },
    runner: { kind: 'opencode', remotePort: null, host: null, agent: null, model: 'example-model', variant: null },
    seatPlan: null,
    seatSelection: {
      role: 'first-pass',
      seatIndex: 0,
      seatId: 'example-seat',
      model: 'example-model',
      tool: 'opencode',
      variant: null,
      agent: null,
    },
    reviewerSeat: null,
    stopReason: 'none',
    createdAtIso: '2026-10-29T10:00:10.000Z',
    updatedAtIso: '2026-10-29T10:00:30.000Z',
    usage: {
      source: 'opencode-db',
      readAtIso: '2026-10-29T10:00:20.000Z',
      sessionId: null,
      steps: 12,
      wallSeconds: 45.5,
      tokensInput: 100,
      tokensOutput: 80,
      tokensReasoning: 20,
      tokensCacheRead: 10,
      tokensCacheWrite: 5,
      costUsd: 0.25,
      model: 'example-model',
      agent: 'first-pass',
      reason: null,
    },
  };
  await runtime.execution.attemptRepository.saveAttempt(attempt);

  const run: LaneRunRecord = {
    version: LANE_RUN_RECORD_VERSION,
    runId: RUN_ID,
    workOrderId: WORK_ORDER_ID,
    tier: 2,
    seatPlanRef: 'a'.repeat(64),
    cursors: { 'first-pass': null, fix: null, review: null },
    round: 0,
    attemptIds: [ATTEMPT_ID],
    prNumber: null,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 1,
    runPolicyRevision: 'policy-example-1',
  };
  await runtime.conductor.laneRunRepository.create(run);

  await runtime.conductor.laneRunJournal.append({
    version: 1,
    entryId: 'entry-seed-1',
    kind: 'conduct',
    key: null,
    runId: RUN_ID,
    recordedAtIso: NOW,
    mode: null,
    expectedRevision: null,
    mintedId: null,
    outcome: null,
    reasonCode: null,
    detail: null,
    grantId: null,
    state: 'running',
  });
}

interface RunResult {
  readonly code: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

/** One CLI invocation against one runtime with the conductor test options. */
async function runConductor(
  runtime: FleetCliRuntime,
  args: readonly string[],
  cliOptions: Omit<ConductorCliOptions, 'now'> = {},
): Promise<RunResult> {
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
    { now: () => NOW, ...cliOptions },
  );
  return { code, stdout: io.outLines, stderr: io.errLines };
}

function runtimeOf(stateDir?: string, installation?: FleetInstallation): FleetCliRuntime {
  return createFleetCliRuntime({
    ...(stateDir !== undefined ? { stateDir } : {}),
    ...(installation !== undefined ? { installation } : {}),
    runSubprocess: throwingRunSubprocess,
    env: {},
  });
}

/** Every file under dir (recursive) with its sha256: the whole on-disk state. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const names = await fs.readdir(dir, { recursive: true });
  const entries: Array<[string, string]> = [];
  for (const name of names) {
    const full = join(dir, name);
    const stat = await fs.lstat(full);
    if (stat.isFile()) {
      const digest = createHash('sha256').update(await fs.readFile(full)).digest('hex');
      entries.push([name, digest]);
    } else if (stat.isDirectory()) {
      entries.push([name + '/', 'dir']);
    }
  }
  return Object.fromEntries(entries.sort((a, b) => a[0].localeCompare(b[0])));
}

/**
 * Build the real ExportRunTelemetry use case over the given state directory,
 * with optional component-level overrides for fault injection.
 */
function buildRealExportTelemetry(
  dir: string,
  overrides?: Partial<ExportRunTelemetryDependencies>,
): ExportRunTelemetryUseCase {
  const repository = new EvidenceAssessmentRepositoryAdapter({ stateDir: dir, readOnly: true });
  const inspector = new InspectAcceptanceEvidenceUseCase({ repo: repository });
  const receipts = new AcceptanceReceiptReadAdapter({ inspector });

  const attemptRepo = new AttemptRepositoryAdapter({ stateDir: dir, readOnly: true });
  const journal = new LaneRunJournalAdapter({ stateDir: dir, readOnly: true });
  const runRepo = new LaneRunRepositoryAdapter({ stateDir: dir, readOnly: true });
  const workOrderRepo = new WorkOrderRepositoryAdapter({ stateDir: dir, readOnly: true });
  const dispositions = new TelemetryDispositionAdapter({ stateDir: dir });

  const hmac: TelemetryHmac = (message) =>
    new Uint8Array(
      createHmac('sha256', Buffer.from(SALT, 'hex')).update(message, 'utf8').digest(),
    );

  return new ExportRunTelemetryUseCase({
    runRepo: overrides?.runRepo ?? runRepo,
    journal: overrides?.journal ?? journal,
    attemptRepo: overrides?.attemptRepo ?? attemptRepo,
    workOrderRepo: overrides?.workOrderRepo ?? workOrderRepo,
    receipts: overrides?.receipts ?? receipts,
    dispositions: overrides?.dispositions ?? dispositions,
    telemetry: overrides?.telemetry ?? new NoopRunTelemetryAdapter(),
    hmac: overrides?.hmac ?? hmac,
    ...(overrides?.mapper !== undefined ? { mapper: overrides.mapper } : {}),
  });
}

/**
 * The faulted runtime for one isolation fault: the composed telemetry block is
 * replaced with a spread carrying a real `DriverTelemetryExporter` over the
 * export port. `markOverride` swaps the mark port for the mark-throws fault.
 */
function faultedRuntime(
  base: FleetCliRuntime,
  exportTelemetry: ExportRunTelemetryPort,
  markOverride?: { mark(target: unknown): void },
): FleetCliRuntime {
  const exporter = new DriverTelemetryExporter({
    exportTelemetry,
    policy: base.telemetry.policy,
    nowIso: () => NOW,
  });
  const telemetry = {
    ...base.telemetry,
    exportTelemetry,
    mark: markOverride ?? exporter,
    startExporter: () => exporter.start(),
    stopExporter: () => exporter.stop(),
  };
  return { ...base, telemetry } as FleetCliRuntime;
}

const unhandledRejections: unknown[] = [];
function onUnhandledRejection(reason: unknown): void {
  unhandledRejections.push(reason);
}
process.on('unhandledRejection', onUnhandledRejection);

afterAll(() => {
  process.removeListener('unhandledRejection', onUnhandledRejection);
});

function zeroCounts(): ExportRunTelemetryCounts {
  return {
    runsSelected: 0,
    attemptsSelected: 0,
    spansMapped: 0,
    rejectedInvalid: 0,
    sampledOut: 0,
    alreadyFinal: 0,
    toSend: 0,
    receiptsDropped: 0,
    exported: 0,
    rejected: 0,
    pending: 0,
    refusedByStore: 0,
  };
}

/** One telemetry fault: its name, optional setup/cleanup, and the faulted runtime factory. */
interface IsolationFault {
  readonly name: string;
  readonly setup?: (dir: string) => Promise<(() => Promise<void>) | void>;
  readonly runtime: (base: FleetCliRuntime, dir: string) => FleetCliRuntime;
}

const ISOLATION_FAULTS: readonly IsolationFault[] = [
  {
    name: 'a repository read that throws',
    runtime: (base, dir) => {
      const realRunRepo = new LaneRunRepositoryAdapter({ stateDir: dir, readOnly: true });
      const faultedRunRepo = {
        ...realRunRepo,
        list: () => realRunRepo.list(),
        get: () => Promise.reject(new Error('repository read fault')),
      };
      const useCase = buildRealExportTelemetry(dir, { runRepo: faultedRunRepo });
      return faultedRuntime(base, useCase);
    },
  },
  {
    name: 'a repository read pending for 10 seconds',
    runtime: (base, dir) => {
      const realRunRepo = new LaneRunRepositoryAdapter({ stateDir: dir, readOnly: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const pendingPromise = new Promise<LaneRunRecord | null>((resolve) => {
        timer = setTimeout(() => resolve(null), 10_000);
        timer.unref();
      });
      const faultedRunRepo = {
        ...realRunRepo,
        list: () => realRunRepo.list(),
        get: () => pendingPromise,
      };
      const useCase = buildRealExportTelemetry(dir, { runRepo: faultedRunRepo });
      return faultedRuntime(base, useCase);
    },
  },
  {
    name: 'a mark adapter that throws',
    runtime: (base) =>
      faultedRuntime(
        base,
        {
          execute: async () => ({ outcome: 'nothing-selected', counts: zeroCounts() }),
        },
        {
          mark: () => {
            throw new Error('mark fault');
          },
        },
      ),
  },
  {
    name: 'a mapper that throws',
    runtime: (base, dir) => {
      const useCase = buildRealExportTelemetry(dir, {
        mapper: () => {
          throw new Error('mapper fault');
        },
      });
      return faultedRuntime(base, useCase);
    },
  },
  {
    name: 'an execute that rejects asynchronously',
    runtime: (base) =>
      faultedRuntime(
        base,
        {
          execute: () =>
            new Promise<ExportRunTelemetryResult>((_resolve, reject) => {
              setTimeout(() => reject(new Error('async reject fault')), 0);
            }),
        },
      ),
  },
  {
    name: 'a disposition-store write that rejects asynchronously',
    runtime: (base, dir) => {
      const realDispositions = new TelemetryDispositionAdapter({ stateDir: dir });
      const faultedDispositions = {
        ...realDispositions,
        read: () => realDispositions.read(),
        write: () =>
          new Promise<TelemetryDispositionWriteResult>((_resolve, reject) => {
            setTimeout(() => reject(new Error('store write fault')), 0);
          }),
      };
      const useCase = buildRealExportTelemetry(dir, { dispositions: faultedDispositions });
      return faultedRuntime(base, useCase);
    },
  },
  {
    name: 'a disposition lock held by another writer',
    setup: async (dir) => {
      const lockPath = join(dir, 'telemetry-dispositions.json.lock');
      await fs.writeFile(lockPath, `${process.pid}-other-writer-${Date.now()}`, 'utf8');
      return async () => {
        try {
          await fs.unlink(lockPath);
        } catch {
          // ignore
        }
      };
    },
    runtime: (base, dir) => {
      const realDispositions = new TelemetryDispositionAdapter({ stateDir: dir, lockTimeoutMs: 50 });
      const useCase = buildRealExportTelemetry(dir, { dispositions: realDispositions });
      return faultedRuntime(base, useCase);
    },
  },
];

describe('conductor telemetry isolation (OT5, plan §3.7)', () => {
  it('the baseline run with telemetry off drives one fixture run', async () => {
    const dir = tempStateDir();
    const runtime = runtimeOf(dir);
    await seedConductorRunState(runtime);
    const fake = makePassDriver(runtime, [FIXTURE_PASS]);
    const result = await runConductor(runtime, ['run', '--live', '--once'], {
      stateDir: dir,
      buildDriver: () => fake.driver,
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toEqual([]);
    expect(result.stdout).toHaveLength(1);
    expect(JSON.parse(result.stdout[0]!)).toMatchObject({ pass: 1, outcome: 'completed' });
    const journalEntries = await runtime.conductor.laneRunJournal.listForRun(RUN_ID);
    expect(journalEntries).toHaveLength(2);
    expect(journalEntries.map((e) => e.entryId)).toEqual(['entry-seed-1', 'entry-pass-1']);
  });

  for (const fault of ISOLATION_FAULTS) {
    it(`telemetry cannot change a run when ${fault.name}`, async () => {
      const beforeUnhandled = unhandledRejections.length;

      // Baseline: telemetry off, one fixture run over seeded state and real journal writes.
      const baselineDir = tempStateDir();
      const baselineRuntime = runtimeOf(baselineDir);
      await seedConductorRunState(baselineRuntime);
      const baselineFake = makePassDriver(baselineRuntime, [FIXTURE_PASS]);
      const baseline = await runConductor(baselineRuntime, ['run', '--live', '--once'], {
        stateDir: baselineDir,
        buildDriver: () => baselineFake.driver,
      });
      const baselineState = await snapshot(baselineDir);
      const baselineJournal = await baselineRuntime.conductor.laneRunJournal.listForRun(RUN_ID);

      // Faulted run: the same fixture run over seeded state and the faulted telemetry block.
      const dir = tempStateDir();
      const baseRuntime = runtimeOf(dir);
      await seedConductorRunState(baseRuntime);
      const cleanup = await fault.setup?.(dir);
      const runtime = fault.runtime(baseRuntime, dir);
      const fake = makePassDriver(runtime, [FIXTURE_PASS]);

      const startedAt = Date.now();
      const result = await runConductor(runtime, ['run', '--live', '--once'], {
        stateDir: dir,
        buildDriver: () => fake.driver,
      });
      const elapsedMs = Date.now() - startedAt;

      await cleanup?.();

      const faultJournal = await runtime.conductor.laneRunJournal.listForRun(RUN_ID);

      expect(result.code).toBe(baseline.code);
      expect(result.stdout).toEqual(baseline.stdout);
      expect(result.stderr).toEqual(baseline.stderr);
      expect(faultJournal).toEqual(baselineJournal);
      expect(await snapshot(dir)).toEqual(baselineState);
      expect(elapsedMs).toBeLessThan(2500);

      // Let any late rejection surface before asserting none is unhandled.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandledRejections.slice(beforeUnhandled)).toEqual([]);
    });
  }

  it('real composition: a corrupt assessments file yields a read-error export and no state change outside the disposition store', async () => {
    const dir = tempStateDir();

    // A minimal v2 installation whose telemetry policy has a valid salt; the
    // sender is the no-op because no endpoint is configured.
    const installation: FleetInstallation = {
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
      forge: { mode: 'none' },
      policy: { telemetry: { enabled: true, salt: SALT } },
    };
    const runtime = runtimeOf(dir, installation);
    expect(runtime.telemetry.mark).toBeInstanceOf(DriverTelemetryExporter);
    expect(runtime.telemetry.stopExporter).not.toBeNull();
    expect(runtime.telemetry.configured).toBe('no-endpoint');

    // Seed one work order, one collected attempt with a head commit and one run
    // owning it, so the real export attempts the receipt read.
    const workOrder: WorkOrderRecord = {
      id: WORK_ORDER_ID,
      projectId: 'project-example-1',
      taskId: 'task-example-1',
      laneId: 'lane-example-1',
      repository: 'repo-example-1',
      baseCommit: HEAD_COMMIT,
      ownedPaths: ['packages/example/src'],
      policyRevision: 'policy-example-1',
      prerequisiteWorkOrderIds: [],
      state: 'approved',
      revision: 1,
      createdAtIso: NOW,
      updatedAtIso: NOW,
    };
    await runtime.execution.workOrderRepository.saveWorkOrder(workOrder);

    const attempt: AttemptRecord = {
      id: ATTEMPT_ID,
      workOrderId: WORK_ORDER_ID,
      kind: 'initial',
      fixNumber: 0,
      priorAttemptId: null,
      worktreePath: '/example/worktree/path',
      baseCommit: HEAD_COMMIT,
      state: 'collected',
      revision: 1,
      dispatchRevision: 1,
      outcome: 'done',
      briefDigest: null,
      briefPackagePath: null,
      sessionId: null,
      completionReceipt: {
        attemptId: ATTEMPT_ID,
        sessionId: 'example-session',
        endedAtIso: '2026-10-29T10:00:30.000Z',
        authoritative: true,
        exitStatus: 0,
        stoppedByRequest: false,
      },
      artifacts: { headCommit: HEAD_COMMIT, commitsSinceBase: [], collectedArtifactPaths: [], notes: 'present' },
      runner: { kind: 'opencode', remotePort: null, host: null, agent: null, model: 'example-model', variant: null },
      seatPlan: null,
      seatSelection: {
        role: 'first-pass',
        seatIndex: 0,
        seatId: 'example-seat',
        model: 'example-model',
        tool: 'opencode',
        variant: null,
        agent: null,
      },
      reviewerSeat: null,
      stopReason: 'none',
      createdAtIso: '2026-10-29T10:00:10.000Z',
      updatedAtIso: '2026-10-29T10:00:30.000Z',
      usage: {
        source: 'opencode-db',
        readAtIso: '2026-10-29T10:00:20.000Z',
        sessionId: null,
        steps: 12,
        wallSeconds: 45.5,
        tokensInput: 100,
        tokensOutput: 80,
        tokensReasoning: 20,
        tokensCacheRead: 10,
        tokensCacheWrite: 5,
        costUsd: 0.25,
        model: 'example-model',
        agent: 'first-pass',
        reason: null,
      },
    };
    await runtime.execution.attemptRepository.saveAttempt(attempt);

    const run: LaneRunRecord = {
      version: LANE_RUN_RECORD_VERSION,
      runId: RUN_ID,
      workOrderId: WORK_ORDER_ID,
      tier: 2,
      seatPlanRef: 'a'.repeat(64),
      cursors: { 'first-pass': null, fix: null, review: null },
      round: 0,
      attemptIds: [ATTEMPT_ID],
      prNumber: null,
      parked: null,
      parkCount: 0,
      lease: null,
      revision: 1,
      runPolicyRevision: 'policy-example-1',
    };
    expect((await runtime.conductor.laneRunRepository.create(run)).outcome).toBe('saved');

    // The corrupt evidence file: a read error, never a quarantine copy.
    await fs.writeFile(join(dir, 'assessments.json'), '{broken CANARY-bytes', 'utf8');

    // Direct export: the real composed use case records a read error.
    const exportResult = await runtime.telemetry.exportTelemetry!.execute({
      selection: { kind: 'marks', targets: [{ kind: 'run', runId: RUN_ID }] },
      policy: {
        route: runtime.telemetry.policy.route,
        sampleRatio: runtime.telemetry.policy.sampleRatio,
        sendCost: runtime.telemetry.policy.sendCost,
        includeDryRun: runtime.telemetry.policy.includeDryRun,
        projectAliases: runtime.telemetry.policy.projectAliases,
      },
      mode: 'send',
      deadline: null,
      retryRejected: false,
      nowIso: NOW,
    });
    expect(exportResult.outcome).toBe('refused');
    expect((exportResult as { reason: string }).reason).toBe('read-error');

    // Drive the same fixture run over the real composition; the state
    // directory may change only in the disposition store and never gains a
    // quarantine copy.
    const before = await snapshot(dir);
    const fake = makeFakeDriver([FIXTURE_PASS]);
    const startedAt = Date.now();
    const result = await runConductor(runtime, ['run', '--live', '--once'], {
      stateDir: dir,
      buildDriver: () => fake.driver,
    });
    expect(result.code).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(2500);

    const after = await snapshot(dir);
    const changedKeys = Object.keys(after).filter((key) => after[key] !== before[key]);
    for (const key of changedKeys) {
      expect(key).toBe('telemetry-dispositions.json');
    }
    expect(after['quarantine/']).toBeUndefined();
    expect(Object.keys(after).some((key) => key.startsWith('quarantine'))).toBe(false);
  });
});
