/**
 * A hand-run benchmark of one dry conductor pass over a synthetic state
 * directory: it seeds runs in a temporary state directory, times one dry
 * pass and the store reads for 10, 100 and 1000 runs, and reports the result
 * as a single JSON document with no path. It is in no gate.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  AttemptRepositoryAdapter,
  ConductorDriverLeaseAdapter,
  ConductorHaltAdapter,
  ExecutionJournalAdapter,
  LaneRunJournalAdapter,
  LaneRunRepositoryAdapter,
  WorkOrderRepositoryAdapter,
  type LaneRunLeaseRecord,
  type LaneRunRecord,
} from '@fleet/work-execution';

import { DRY_RUN_BRIEF_PROSE, DRY_RUN_MANIFEST_JSON } from '../conductor-dry-run.js';
import { buildDryRunConductorDriver, type ConductorDriver, type DryRunStores } from '../conductor-wiring.js';
import { newUlid } from '../ulid.js';

/** The sizes the hand-run benchmarks: 10, 100 and 1000 seeded runs. */
export const BENCH_SIZES: readonly number[] = [10, 100, 1000];

/** The fixed usage line; never echoes a rejected argument. */
export const USAGE_LINE = 'usage: conductor-pass-bench';

const NOW = '2026-10-27T10:00:00.000Z';

/** The frozen seat plan the seeded attempts carry (conductor-dry-run.test.ts:56-64). */
const SEAT_PLAN = {
  version: 1 as const,
  'first-pass': [
    { id: 'fp-1', model: 'model-example-1', tool: 'opencode' },
    { id: 'fp-2', model: 'model-example-2', tool: 'opencode' },
  ],
  fix: [{ id: 'fx-1', model: 'model-example-1', tool: 'opencode' }],
  review: [{ id: 'review-dry-run', model: 'example/dry-run-reviewer' }],
};

/** The seat binding the seeded attempts carry (conductor-dry-run.test.ts:66-74). */
const SEAT_SELECTION = {
  role: 'first-pass' as const,
  seatIndex: 0,
  seatId: 'fp-1',
  model: 'model-example-1',
  tool: 'opencode',
  variant: null,
  agent: null,
};

/** Digest of the dry-run fake's frozen prose and manifest, as the seed attempt carries it. */
const SEED_BRIEF_DIGEST = createHash('sha256')
  .update(DRY_RUN_BRIEF_PROSE + '\n' + DRY_RUN_MANIFEST_JSON, 'utf8')
  .digest('hex');

/** The timed store reads of one size sample. */
export interface ReadsReport {
  readonly runListMs: number;
  readonly journalGroupedMs: number;
  readonly journalPerRunMs: number;
}

/** One benchmarked size: the timings and the single pass's outcome. */
export interface SizeReport {
  readonly runs: number;
  readonly seedMs: number;
  readonly passMs: number;
  readonly reads: ReadsReport;
  readonly passOutcome: 'completed' | 'refused';
}

/** The full benchmark document: one size report per BENCH_SIZES entry and a fixed note. */
export interface Report {
  readonly sizes: readonly SizeReport[];
  readonly notes: string;
}

/** The fixed note stating the measured dominant cost. */
const NOTES =
  'Every lane-run lease acquire/renew/save rewrites the whole lane-runs.json under a file lock ' +
  '(LaneRunRepositoryAdapter.adapter.ts:290-321), while the pass\u2019s journal read is one grouped file read.';

/**
 * Seed `n` dry-runnable runs in `stateDir` with the verified `seedCompletedStart`
 * recipe: a work order, an intent-recorded attempt with its seat plan, seat
 * selection and runner host, and the run record. Throws when a save/create is
 * not saved.
 */
export async function seedRuns(stateDir: string, n: number): Promise<void> {
  const workOrderRepo = new WorkOrderRepositoryAdapter({ stateDir });
  const attemptRepo = new AttemptRepositoryAdapter({ stateDir });
  const laneRunRepo = new LaneRunRepositoryAdapter({ stateDir });
  for (let i = 0; i < n; i += 1) {
    const runId = 'run-' + newUlid();
    const workOrderId = `wo-bench-${i}`;
    const attemptId = `attempt-bench-${i}`;
    await workOrderRepo.saveWorkOrder({
      id: workOrderId,
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
      createdAtIso: NOW,
      updatedAtIso: NOW,
    });
    await attemptRepo.saveAttempt({
      id: attemptId,
      workOrderId,
      kind: 'initial',
      fixNumber: 0,
      priorAttemptId: null,
      worktreePath: '/tmp/fleet-bench/wt/' + runId,
      baseCommit: 'a'.repeat(40),
      state: 'intent-recorded',
      outcome: null,
      revision: 0,
      briefDigest: SEED_BRIEF_DIGEST,
      briefPackagePath: '.lane/brief.md',
      sessionId: null,
      completionReceipt: null,
      artifacts: null,
      seatPlan: SEAT_PLAN,
      seatSelection: SEAT_SELECTION,
      runner: {
        kind: 'opencode',
        remotePort: null,
        host: 'lane-example',
        hostName: 'lane-example',
        agent: null,
        model: null,
        variant: null,
      },
      stopReason: 'none',
      createdAtIso: NOW,
      updatedAtIso: NOW,
    });
    const created = await laneRunRepo.create({
      version: 1,
      runId,
      workOrderId,
      tier: 2,
      seatPlanRef: 'a'.repeat(64),
      cursors: { 'first-pass': null, fix: null, review: null },
      round: 0,
      attemptIds: [attemptId],
      prNumber: null,
      parked: null,
      parkCount: 0,
      lease: null,
      revision: 1,
      runPolicyRevision: 'policy-example-1',
      branchName: 'fleet/' + runId,
    });
    if (created.outcome !== 'saved') {
      throw new Error(`seedRuns: run ${runId} was not saved`);
    }
  }
}

/** The scratch stores of a dry-run on `stateDir`, exactly as `storesForScratch`. */
function storesForScratch(stateDir: string): DryRunStores {
  return {
    runRepo: new LaneRunRepositoryAdapter({ stateDir }),
    runJournal: new LaneRunJournalAdapter({ stateDir }),
    attemptRepo: new AttemptRepositoryAdapter({ stateDir }),
    executionJournal: new ExecutionJournalAdapter({ stateDir }),
    workOrderRepo: new WorkOrderRepositoryAdapter({ stateDir }),
    driverLease: new ConductorDriverLeaseAdapter({ stateDir }),
    halt: new ConductorHaltAdapter({ stateDir }),
  };
}

/**
 * Release the holder's leases, settling sequentially if the concurrent release
 * outlasts the store's default lock wait on a slow host. Runs in a finally, so
 * it never masks the measured pass.
 */
async function settleLeases(
  driver: ConductorDriver,
  stores: DryRunStores,
  holderId: string,
): Promise<void> {
  try {
    await driver.pass.releaseLeases({ holderId, nowIso: new Date().toISOString() });
  } catch (error) {
    if (!(error instanceof Error && error.name === 'FileLockTimeoutError')) {
      throw error;
    }
    const held = (await stores.runRepo.list()).filter(
      (run): run is LaneRunRecord & { lease: LaneRunLeaseRecord } =>
        run.lease !== null && run.lease.holderId === holderId,
    );
    for (const run of held) {
      await stores.runRepo.releaseLease(run.runId, {
        holderId,
        fence: run.lease.fence,
        nowIso: new Date().toISOString(),
      });
    }
  }
}

/** Benchmark one size: seed, time the store reads, then run one dry pass. */
export async function benchSize(n: number): Promise<SizeReport> {
  const stateDir = await mkdtemp(join(tmpdir(), 'fleet-v2-conductor-pass-bench-'));
  let seedMs = 0;
  let passMs = 0;
  let passOutcome: SizeReport['passOutcome'] = 'completed';
  const reads = { runListMs: 0, journalGroupedMs: 0, journalPerRunMs: 0 };
  try {
    const seedStart = performance.now();
    await seedRuns(stateDir, n);
    seedMs = performance.now() - seedStart;

    const stores = storesForScratch(stateDir);

    const listStart = performance.now();
    const runs = await stores.runRepo.list();
    reads.runListMs = performance.now() - listStart;

    const allRunIds = runs.map((run) => run.runId);

    const groupedStart = performance.now();
    await stores.runJournal.listForRuns(allRunIds);
    reads.journalGroupedMs = performance.now() - groupedStart;

    const perRunStart = performance.now();
    await stores.runJournal.listForRun(allRunIds[0]);
    reads.journalPerRunMs = performance.now() - perRunStart;

    const driver = buildDryRunConductorDriver(stores, {
      maxActiveRuns: n,
      nowIso: () => new Date().toISOString(),
    });
    const holderId = 'driver-' + newUlid();
    try {
      const nowIso = new Date().toISOString();
      const passStart = performance.now();
      const result = await driver.pass.runPass({ holderId, nowIso });
      passMs = performance.now() - passStart;
      passOutcome = result.outcome;
    } finally {
      await settleLeases(driver, stores, holderId);
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
  return { runs: n, seedMs, passMs, reads, passOutcome };
}

/** Build the full report over every BENCH_SIZES entry. */
export async function buildReport(): Promise<Report> {
  const sizes: SizeReport[] = [];
  for (const n of BENCH_SIZES) {
    sizes.push(await benchSize(n));
  }
  return { sizes, notes: NOTES };
}

/** The argv decision of the script: run, or refuse with a fixed usage line. */
export type ArgvDecision = { readonly kind: 'run' } | { readonly kind: 'usage-refused' };

/** Pure argv check: the script takes no arguments. */
export function decideArgv(argv: readonly string[]): ArgvDecision {
  return argv.length > 2 ? { kind: 'usage-refused' } : { kind: 'run' };
}

/** The CLI entry: prints one JSON document on stdout, or a usage line to stderr. */
export async function main(): Promise<void> {
  const decision = decideArgv(process.argv);
  if (decision.kind === 'usage-refused') {
    process.stderr.write(USAGE_LINE + '\n');
    process.exitCode = 2;
    return;
  }
  process.stdout.write(JSON.stringify(await buildReport(), null, 2) + '\n');
}

// Run only when executed directly as the dist entry, never when imported by tests.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
