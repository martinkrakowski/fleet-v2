// SB1: a synthetic ~69 MB state directory and a peak-RSS budget harness for the
// status read path (`InspectLaneRunsUseCase`). The fixture generator, the
// `withFixture` cleanup helper, the child-process RSS runner, `parseChildRssResult`
// and `evaluateMemoryBudget` all live in this file.
//
// Build precondition: the child imports `packages/work-execution/dist/index.js`;
// `turbo.json` makes `test` depend on the dependencies' builds only, never on this
// package's own `dist`, so run `yarn workspace @fleet/work-execution build` before
// any run that executes the smoke or gated tests. Until the turbo env entry for
// `FLEET_STATUS_BUDGET` lands (SB7), enable the gated suite by running vitest
// directly with `FLEET_STATUS_BUDGET=1`.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { containsSecretShape } from '@fleet/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseVersionedConductorPassTraceStateRecord } from '../domain/conductor-pass-trace.js';
import { CRASHED_START_GRACE_MINUTES } from '../application/ports/in/InspectLaneRunsPort.in-port.js';
import { parseConductorDriverLeaseStateRecord } from '../infrastructure/adapters/ConductorDriverLeaseAdapter.adapter.js';
import { parseConductorHaltStateRecord } from '../infrastructure/adapters/ConductorHaltAdapter.adapter.js';
import { parseVersionedAttemptStateRecord } from '../infrastructure/adapters/AttemptRepositoryAdapter.adapter.js';
import {
  parseVersionedJournalEntryStateRecord,
  parseVersionedReservationStateRecord,
} from '../infrastructure/adapters/ExecutionJournalAdapter.adapter.js';
import { parseVersionedLaneRunJournalStateRecord } from '../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { parseVersionedLanePlanStateRecord } from '../infrastructure/adapters/LanePlanRepositoryAdapter.adapter.js';
import { parseVersionedLaneRunStateRecord } from '../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import { parseWorkOrderStateRecord } from '../infrastructure/adapters/WorkOrderRepositoryAdapter.adapter.js';

// ---------------------------------------------------------------------------
// Constants (budgets are constants: FLEET_STATUS_BUDGET only enables the gated suite)
// ---------------------------------------------------------------------------

const NOW_ISO = '2026-01-01T12:00:00.000Z';
const AGED_RESERVED_AT_ISO = '2026-01-01T11:50:00.000Z'; // 10 minutes before NOW_ISO
const RECORDED_AT_ISO = '2026-01-01T00:00:00.000Z';
const PER_RUN_BUDGET_BYTES = 512 * 1024 * 1024;
const ALL_RUNS_BUDGET_BYTES = 1024 * 1024 * 1024;
const CHILD_MAX_OLD_SPACE_MB = 3072;
const CHILD_TIMEOUT_MS = 120_000;
const RUN_COUNT = 64;
const MB = 1024 * 1024;
const FIXTURE_SEED = 0x5b1;
const DIST_MISSING_MESSAGE = 'dist missing, build first: yarn workspace @fleet/work-execution build';

/** Target sizes of the big stores (bytes); the total is about 69 MB. */
const LARGE_TARGETS = {
  'journal.json': Math.round(23.8 * MB),
  'work-orders.json': Math.round(15.3 * MB),
  'assessments.json': Math.round(12.9 * MB),
  'run-journal.json': Math.round(9.5 * MB),
  'attempts.json': Math.round(7.3 * MB),
} as const;
const LARGE_TOTAL_TARGET = Object.values(LARGE_TARGETS).reduce((sum, bytes) => sum + bytes, 0);

/** Run-journal intent/result pairs per run; 64 runs of (1 + 2 * pairs) entries come to about 9.5 MB. */
const LARGE_PAIRS_PER_RUN = 214;

// ---------------------------------------------------------------------------
// Dist guard
// ---------------------------------------------------------------------------

/** The built package entry the child imports; injectable so the guard is testable. */
function distIndexPath(): string {
  return fileURLToPath(new URL('../../dist/index.js', import.meta.url));
}

function assertDistExists(distPath: string): void {
  if (!existsSync(distPath)) {
    throw new Error(DIST_MISSING_MESSAGE);
  }
}

// ---------------------------------------------------------------------------
// Cleanup helper
// ---------------------------------------------------------------------------

async function withFixture<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'status-memory-budget-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Budget and child-result helpers
// ---------------------------------------------------------------------------

type BudgetVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'invalid-budget' | 'invalid-rss' | 'over-budget' };

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function evaluateMemoryBudget(rssBytes: number, budgetBytes: number): BudgetVerdict {
  if (!isPositiveFinite(budgetBytes)) {
    return { ok: false, reason: 'invalid-budget' };
  }
  if (!isPositiveFinite(rssBytes)) {
    return { ok: false, reason: 'invalid-rss' };
  }
  return rssBytes > budgetBytes ? { ok: false, reason: 'over-budget' } : { ok: true };
}

interface SpawnOutcome {
  readonly error?: { readonly code?: string } | undefined;
  readonly status: number | null;
  readonly stdout: string;
}

type ChildRssResult =
  | { readonly ok: true; readonly rssBytes: number }
  | {
      readonly ok: false;
      readonly reason:
        | 'timeout'
        | 'child-killed'
        | 'empty-stdout'
        | 'invalid-json'
        | 'child-failed'
        | 'non-zero-exit'
        | 'invalid-rss';
      readonly detail?: string;
    };

/** Classifies a finished child in a fixed precedence; never throws. */
function parseChildRssResult(outcome: SpawnOutcome): ChildRssResult {
  if (outcome.error?.code === 'ETIMEDOUT') {
    return { ok: false, reason: 'timeout' };
  }
  if (outcome.status === null) {
    return { ok: false, reason: 'child-killed' };
  }
  if (typeof outcome.stdout !== 'string' || outcome.stdout.trim().length === 0) {
    return { ok: false, reason: 'empty-stdout' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.stdout);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid-json' };
  }
  const payload = parsed as Record<string, unknown>;
  if (payload.ok !== true) {
    return {
      ok: false,
      reason: 'child-failed',
      detail: typeof payload.reason === 'string' ? payload.reason : 'unknown',
    };
  }
  if (outcome.status !== 0) {
    return { ok: false, reason: 'non-zero-exit' };
  }
  if (!isPositiveFinite(payload.rssBytes)) {
    return { ok: false, reason: 'invalid-rss' };
  }
  return { ok: true, rssBytes: payload.rssBytes };
}

/**
 * The child's success assertion, defined once as source so the child script and
 * the named tests run the very same function. Plain JavaScript on purpose.
 */
const VALIDATE_SOURCE = `
function validateChildInspectResult(result, expectedRuns, expectedCrashedStarts) {
  if (typeof result !== 'object' || result === null || result.outcome !== 'listed') {
    return { ok: false, reason: 'outcome-not-listed' };
  }
  if (result.halt !== 'clear') {
    return { ok: false, reason: 'halt-not-clear' };
  }
  if (result.crashedStartsIncomplete !== undefined) {
    return { ok: false, reason: 'crashed-starts-incomplete' };
  }
  if (!Array.isArray(result.crashedStarts) || result.crashedStarts.length !== expectedCrashedStarts) {
    return { ok: false, reason: 'crashed-starts-count' };
  }
  // The reservations carry no work order id; it can only come from the parsed attempts.json record.
  for (const view of result.crashedStarts) {
    if (typeof view !== 'object' || view === null || typeof view.workOrderId !== 'string' || !view.workOrderId.startsWith('wo-crashed-')) {
      return { ok: false, reason: 'crashed-start-attempt-not-read' };
    }
  }
  if (!Array.isArray(result.runs) || result.runs.length !== expectedRuns) {
    return { ok: false, reason: 'runs-count' };
  }
  return { ok: true };
}
`;

type ChildVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };
const validateChildInspectResult = new Function(`${VALIDATE_SOURCE}\nreturn validateChildInspectResult;`)() as (
  result: unknown,
  expectedRuns: number,
  expectedCrashedStarts: number,
) => ChildVerdict;

const CHILD_SCRIPT = `${VALIDATE_SOURCE}
(async () => {
  const [stateDir, distUrl, runId, expectedRuns, expectedCrashedStarts, nowIso] = process.argv.slice(1);
  const emit = (payload) => process.stdout.write(JSON.stringify(payload) + '\\n');
  try {
    const dist = await import(distUrl);
    const options = { stateDir, readOnly: true };
    const useCase = new dist.InspectLaneRunsUseCase({
      runRepo: new dist.LaneRunRepositoryAdapter(options),
      runJournal: new dist.LaneRunJournalAdapter(options),
      halt: new dist.ConductorHaltAdapter(options),
      driverLease: new dist.ConductorDriverLeaseAdapter(options),
      attemptRepo: new dist.AttemptRepositoryAdapter(options),
      executionJournal: new dist.ExecutionJournalAdapter(options),
    });
    const result = await useCase.inspectLaneRuns({ nowIso, ...(runId ? { runId } : {}) });
    const verdict = validateChildInspectResult(result, Number(expectedRuns), Number(expectedCrashedStarts));
    if (!verdict.ok) {
      emit({ ok: false, reason: verdict.reason });
      process.exitCode = 1;
      return;
    }
    emit({ ok: true, rssBytes: process.resourceUsage().maxRSS * 1024 });
  } catch (error) {
    // Only the error's class name: enough to diagnose, never a message that could echo state.
    emit({ ok: false, reason: 'child-threw-' + String(error && error.name).slice(0, 64) });
    process.exitCode = 1;
  }
})();
`;

interface MeasureOptions {
  readonly stateDir: string;
  readonly runId: string;
  readonly expectedRuns: number;
  readonly expectedCrashedStarts: number;
  readonly distPath?: string;
}

/** Runs one status read in a child with an old-space cap and returns its classified peak RSS. */
function measureStatusReadRss(options: MeasureOptions): ChildRssResult {
  const distPath = options.distPath ?? distIndexPath();
  assertDistExists(distPath);
  const spawned = spawnSync(
    process.execPath,
    [
      `--max-old-space-size=${CHILD_MAX_OLD_SPACE_MB}`,
      '-e',
      CHILD_SCRIPT,
      options.stateDir,
      pathToFileURL(distPath).href,
      options.runId,
      String(options.expectedRuns),
      String(options.expectedCrashedStarts),
      NOW_ISO,
    ],
    { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS },
  );
  return parseChildRssResult({
    error: spawned.error as { code?: string } | undefined,
    status: spawned.status,
    stdout: spawned.stdout ?? '',
  });
}

// ---------------------------------------------------------------------------
// Deterministic fixture generator
// ---------------------------------------------------------------------------

/** Seeded mulberry32: the same seed always yields the same stream. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A 26-character ULID-shaped id for a counter; the leading digit is 0, so it matches the ULID pattern. */
function ulid(counter: number): string {
  let remaining = counter;
  let out = '';
  for (let index = 0; index < 26; index += 1) {
    out = CROCKFORD[remaining % 32] + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

const pad = (value: number, width: number): string => String(value).padStart(width, '0');
const runIdOf = (index: number): string => `run-${ulid(index + 1)}`;
const hex64 = (seed: number): string => createHash('sha256').update(`sb1-${seed}`).digest('hex');

type RecordMaker = (index: number) => unknown;

function attemptRecord(id: string, workOrderId: string, state: string): Record<string, unknown> {
  return {
    id,
    workOrderId,
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/tmp/wt',
    baseCommit: 'abc123',
    state,
    outcome: null,
    briefDigest: null,
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    createdAtIso: RECORDED_AT_ISO,
    updatedAtIso: RECORDED_AT_ISO,
  };
}

function laneRunRecord(index: number): Record<string, unknown> {
  return {
    version: 1,
    runId: runIdOf(index),
    workOrderId: `wo-run-${pad(index, 4)}`,
    tier: 2,
    seatPlanRef: hex64(index),
    cursors: { 'first-pass': 0, fix: null, review: null },
    round: 0,
    attemptIds: [`attempt-run-${pad(index, 4)}`],
    prNumber: null,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 1,
    runPolicyRevision: 'policy-sb1',
  };
}

/** The run-journal entry at a global index: per run, one conduct entry then intent/result pairs. */
function runJournalRecord(pairsPerRun: number): RecordMaker {
  const perRun = 1 + 2 * pairsPerRun;
  return (index) => {
    const run = Math.floor(index / perRun);
    const local = index % perRun;
    const runId = runIdOf(run);
    const base = {
      version: 1,
      entryId: ulid(index + 1),
      recordedAtIso: RECORDED_AT_ISO,
      mode: null,
      expectedRevision: null,
      grantId: null,
    };
    if (local === 0) {
      return {
        ...base,
        kind: 'conduct',
        key: null,
        runId,
        mintedId: null,
        outcome: null,
        reasonCode: null,
        detail: null,
        state: 'running',
      };
    }
    const pair = Math.floor((local - 1) / 2);
    const key = `${runId}/r${Math.floor(pair / 1000)}/reconcile/${pair % 1000}`;
    if (local % 2 === 1) {
      return {
        ...base,
        kind: 'intent',
        key,
        runId,
        mintedId: `minted-${pad(index, 8)}`,
        outcome: null,
        reasonCode: null,
        detail: null,
        state: null,
      };
    }
    return {
      ...base,
      kind: 'result',
      key,
      runId,
      mintedId: null,
      outcome: 'completed',
      reasonCode: null,
      detail: null,
      state: null,
    };
  };
}

const CRASHED_ATTEMPT_COUNT = 2;

function reservationRecord(index: number, crashed: boolean): Record<string, unknown> {
  return {
    id: `rs-${pad(index, 4)}`,
    attemptId: crashed ? `attempt-crashed-${index}` : `attempt-run-${pad(index, 4)}`,
    hostId: 'host-sb1',
    slotIndex: index,
    held: crashed,
    seatTool: null,
    hostName: null,
    hostKind: null,
    transport: null,
    sshAlias: null,
    port: null,
    worktreePath: null,
    reservedAtIso: crashed ? AGED_RESERVED_AT_ISO : RECORDED_AT_ISO,
    releasedAtIso: crashed ? null : RECORDED_AT_ISO,
  };
}

function attemptsMaker(crashed: number): RecordMaker {
  return (index) =>
    index < crashed
      ? attemptRecord(`attempt-crashed-${index}`, `wo-crashed-${index}`, 'intent-recorded')
      : attemptRecord(`attempt-run-${pad(index - crashed, 4)}`, `wo-attempt-${pad(index, 7)}`, 'dispatching');
}

const journalMaker: RecordMaker = (index) => ({
  id: `je-${pad(index, 8)}`,
  attemptId: `attempt-run-${pad(index % 2000, 4)}`,
  workOrderId: `wo-journal-${pad(index, 8)}`,
  action: 'dispatch',
  baseCommit: 'abc123',
  recordedAtIso: RECORDED_AT_ISO,
  status: 'intent-recorded',
  sessionId: null,
  detail: null,
});

const workOrderMaker: RecordMaker = (index) => ({
  id: `wo-store-${pad(index, 7)}`,
  projectId: 'project-sb1',
  taskId: `task-${pad(index, 7)}`,
  laneId: `lane-${pad(index % 512, 4)}`,
  repository: 'example/synthetic',
  baseCommit: 'abc123',
  ownedPaths: ['packages/example/src/a.ts', 'packages/example/src/b.ts', 'docs/example.md'],
  policyRevision: 'policy-sb1',
  prerequisiteWorkOrderIds: [],
  state: 'implementing',
  revision: 1,
  createdAtIso: RECORDED_AT_ISO,
  updatedAtIso: RECORDED_AT_ISO,
});

/** Plain filler: `assessments.json` has no parser in this package. Words come from the seeded stream. */
function assessmentMaker(random: () => number): RecordMaker {
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];
  return (index) => ({
    id: `assessment-${pad(index, 7)}`,
    attemptId: `attempt-run-${pad(index % 2000, 4)}`,
    verdict: 'pass',
    findings: Array.from({ length: 6 }, () => words[Math.floor(random() * words.length)]),
    note: Array.from({ length: 24 }, () => words[Math.floor(random() * words.length)]).join(' '),
  });
}

const driverLeaseRecord = {
  version: 1,
  holderId: 'holder-sb1',
  fence: 1,
  leaseUntilIso: '2026-01-01T13:00:00.000Z',
};
const haltRecord = { version: 1, halted: false, changedAtIso: RECORDED_AT_ISO };

function lanePlanRecord(): Record<string, unknown> {
  return {
    version: 1,
    projectId: 'project-sb1',
    planId: 'plan-sb1',
    revision: 1,
    digest: hex64(7),
    doc: 'docs/plan.md',
    lanes: [
      {
        laneId: 'lane-sb1',
        aliases: [],
        scope: 'Synthetic planned lane',
        packages: ['work-execution'],
        sharedFiles: [],
        tier: 1,
        after: [],
        decisions: [],
        status: 'planned',
        brief: null,
        mergedPr: null,
      },
    ],
    decisions: [],
    exclusiveOrder: [],
    importedAtIso: RECORDED_AT_ISO,
  };
}

function conductorPassRecord(index: number): Record<string, unknown> {
  return {
    schemaVersion: 1,
    passId: `pass-${pad(index, 4)}`,
    nowIso: RECORDED_AT_ISO,
    holderId: 'holder-sb1',
    halted: false,
    progressed: false,
    maxActiveRuns: 14,
    passConcurrency: 4,
    dispatchStaggerMs: 0,
    runs: [],
    attention: [],
  };
}

type StoreParse =
  | { readonly kind: 'plain'; readonly parse: (raw: unknown) => unknown }
  | { readonly kind: 'versioned'; readonly parse: (raw: unknown) => unknown }
  | { readonly kind: 'none' };

interface StoreSpec {
  readonly file: string;
  readonly parser: StoreParse;
  /** Either a fixed record count or a byte target to stream toward. */
  readonly count?: number;
  readonly targetBytes?: number;
  readonly make: RecordMaker;
}

interface FixtureManifest {
  readonly files: ReadonlyMap<string, { readonly bytes: number; readonly records: number; readonly sha256: string }>;
  readonly totalBytes: number;
  readonly digest: string;
}

/** Serializes one record and refuses it when any secret-shaped text is in it. */
function serializeRecordChecked(record: unknown): string {
  const text = JSON.stringify(record);
  if (containsSecretShape(text)) {
    throw new Error('secret-shape-detected');
  }
  return text;
}

function specsFor(profile: 'large' | 'smoke'): StoreSpec[] {
  const random = seededRandom(FIXTURE_SEED);
  if (profile === 'smoke') {
    return [
      { file: 'lane-runs.json', parser: { kind: 'versioned', parse: parseVersionedLaneRunStateRecord }, count: 2, make: laneRunRecord },
      {
        file: 'run-journal.json',
        parser: { kind: 'versioned', parse: parseVersionedLaneRunJournalStateRecord },
        count: 2 * (1 + 2 * 3),
        make: runJournalRecord(3),
      },
      {
        file: 'attempts.json',
        parser: { kind: 'versioned', parse: parseVersionedAttemptStateRecord },
        count: 1 + 2,
        make: attemptsMaker(1),
      },
      {
        file: 'reservations.json',
        parser: { kind: 'versioned', parse: parseVersionedReservationStateRecord },
        count: 2,
        make: (index) => reservationRecord(index, index === 0),
      },
      { file: 'conductor-halt.json', parser: { kind: 'plain', parse: parseConductorHaltStateRecord }, count: 1, make: () => haltRecord },
      {
        file: 'conductor-driver-lease.json',
        parser: { kind: 'plain', parse: parseConductorDriverLeaseStateRecord },
        count: 1,
        make: () => driverLeaseRecord,
      },
    ];
  }
  return [
    { file: 'journal.json', parser: { kind: 'versioned', parse: parseVersionedJournalEntryStateRecord }, targetBytes: LARGE_TARGETS['journal.json'], make: journalMaker },
    { file: 'work-orders.json', parser: { kind: 'plain', parse: parseWorkOrderStateRecord }, targetBytes: LARGE_TARGETS['work-orders.json'], make: workOrderMaker },
    { file: 'assessments.json', parser: { kind: 'none' }, targetBytes: LARGE_TARGETS['assessments.json'], make: assessmentMaker(random) },
    {
      file: 'run-journal.json',
      parser: { kind: 'versioned', parse: parseVersionedLaneRunJournalStateRecord },
      count: RUN_COUNT * (1 + 2 * LARGE_PAIRS_PER_RUN),
      make: runJournalRecord(LARGE_PAIRS_PER_RUN),
    },
    {
      file: 'attempts.json',
      parser: { kind: 'versioned', parse: parseVersionedAttemptStateRecord },
      targetBytes: LARGE_TARGETS['attempts.json'],
      make: attemptsMaker(CRASHED_ATTEMPT_COUNT),
    },
    {
      file: 'reservations.json',
      parser: { kind: 'versioned', parse: parseVersionedReservationStateRecord },
      count: 32,
      make: (index) => reservationRecord(index, index < CRASHED_ATTEMPT_COUNT),
    },
    { file: 'lane-runs.json', parser: { kind: 'versioned', parse: parseVersionedLaneRunStateRecord }, count: RUN_COUNT, make: laneRunRecord },
    { file: 'lane-plans.json', parser: { kind: 'versioned', parse: parseVersionedLanePlanStateRecord }, count: 1, make: lanePlanRecord },
    {
      file: 'conductor-passes.json',
      parser: { kind: 'versioned', parse: parseVersionedConductorPassTraceStateRecord },
      count: 32,
      make: conductorPassRecord,
    },
    { file: 'conductor-driver-lease.json', parser: { kind: 'plain', parse: parseConductorDriverLeaseStateRecord }, count: 1, make: () => driverLeaseRecord },
    { file: 'conductor-halt.json', parser: { kind: 'plain', parse: parseConductorHaltStateRecord }, count: 1, make: () => haltRecord },
  ];
}

/**
 * Writes one store as a JSON array with one record per line, in chunks, hashing
 * what it writes. Every serialized record passes the secret-shape scan first.
 */
function writeStore(dir: string, spec: StoreSpec) {
  const fd = openSync(join(dir, spec.file), 'w');
  const hash = createHash('sha256');
  let bytes = 0;
  let records = 0;
  let pending: string[] = ['[\n'];
  let pendingBytes = 2;
  const flush = (): void => {
    if (pending.length === 0) {
      return;
    }
    const chunk = pending.join('');
    writeSync(fd, chunk);
    hash.update(chunk);
    bytes += Buffer.byteLength(chunk, 'utf8');
    pending = [];
    pendingBytes = 0;
  };
  try {
    for (let index = 0; ; index += 1) {
      const done =
        spec.count !== undefined ? index >= spec.count : bytes + pendingBytes >= (spec.targetBytes ?? 0);
      if (done) {
        break;
      }
      const text = serializeRecordChecked(spec.make(index));
      const line = `${index === 0 ? '' : ',\n'}${text}`;
      pending.push(line);
      pendingBytes += line.length;
      records += 1;
      if (pendingBytes >= 1_000_000) {
        flush();
      }
    }
    pending.push('\n]\n');
    flush();
  } finally {
    closeSync(fd);
  }
  return { bytes, records, sha256: hash.digest('hex') };
}

function buildFixture(dir: string, profile: 'large' | 'smoke'): FixtureManifest {
  mkdirSync(dir, { recursive: true });
  const files = new Map<string, { bytes: number; records: number; sha256: string }>();
  let totalBytes = 0;
  const digest = createHash('sha256');
  for (const spec of specsFor(profile)) {
    const written = writeStore(dir, spec);
    files.set(spec.file, written);
    totalBytes += written.bytes;
    digest.update(`${spec.file}:${written.sha256}\n`);
  }
  return { files, totalBytes, digest: digest.digest('hex') };
}

/** Streams one written store back and returns how many records its real parser accepted and rejected. */
function parseStoreFile(dir: string, spec: StoreSpec): { accepted: number; rejected: number; secret: number } {
  const text = readFileSync(join(dir, spec.file), 'utf8');
  let accepted = 0;
  let rejected = 0;
  let secret = 0;
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.endsWith(',') ? line.slice(0, -1) : line;
    if (trimmed === '[' || trimmed === ']' || trimmed === '') {
      continue;
    }
    if (containsSecretShape(trimmed)) {
      secret += 1;
    }
    if (spec.parser.kind === 'none') {
      JSON.parse(trimmed);
      accepted += 1;
      continue;
    }
    const outcome = spec.parser.parse(JSON.parse(trimmed)) as { status?: string } | undefined | null;
    const ok = spec.parser.kind === 'versioned' ? outcome?.status === 'ok' : outcome !== undefined && outcome !== null;
    if (ok) {
      accepted += 1;
    } else {
      rejected += 1;
    }
  }
  return { accepted, rejected, secret };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('status memory budget helpers', () => {
  it('fails with a build-first message when dist is missing', () => {
    expect(DIST_MISSING_MESSAGE).toBe('dist missing, build first: yarn workspace @fleet/work-execution build');
    expect(() => assertDistExists(join(tmpdir(), 'status-memory-budget-no-such-dist', 'index.js'))).toThrow(
      DIST_MISSING_MESSAGE,
    );
    expect(() => measureStatusReadRss({
      stateDir: tmpdir(),
      runId: '',
      expectedRuns: 0,
      expectedCrashedStarts: 0,
      distPath: join(tmpdir(), 'status-memory-budget-no-such-dist', 'index.js'),
    })).toThrow(DIST_MISSING_MESSAGE);
  });

  it('removes mkdtemp fixture directory even when the test body throws', async () => {
    let seen = '';
    await expect(
      withFixture(async (dir) => {
        seen = dir;
        expect(statSync(dir).isDirectory()).toBe(true);
        throw new Error('body failed');
      }),
    ).rejects.toThrow('body failed');
    expect(seen).not.toBe('');
    expect(existsSync(seen)).toBe(false);
  });

  it('refuses a generated record containing a secret-shaped string built at runtime', () => {
    const secret = ['gh', 'p_', 'x'.repeat(36)].join('');
    expect(() => serializeRecordChecked({ id: 'r1', note: `token ${secret}` })).toThrow('secret-shape-detected');
    expect(serializeRecordChecked({ id: 'r1', note: 'plain' })).toBe('{"id":"r1","note":"plain"}');
  });

  it('refuses a child inspect result with halt unreadable, crashedStartsIncomplete true, or wrong counts', () => {
    const good = { outcome: 'listed', halt: 'clear', runs: [{}, {}], crashedStarts: [{ workOrderId: 'wo-crashed-0' }] };
    expect(validateChildInspectResult(good, 2, 1)).toEqual({ ok: true });
    expect(validateChildInspectResult({ outcome: 'not-found' }, 2, 1)).toEqual({ ok: false, reason: 'outcome-not-listed' });
    expect(validateChildInspectResult(null, 2, 1)).toEqual({ ok: false, reason: 'outcome-not-listed' });
    expect(validateChildInspectResult({ ...good, halt: 'unreadable' }, 2, 1)).toEqual({ ok: false, reason: 'halt-not-clear' });
    expect(validateChildInspectResult({ ...good, halt: 'halted' }, 2, 1)).toEqual({ ok: false, reason: 'halt-not-clear' });
    expect(validateChildInspectResult({ ...good, crashedStartsIncomplete: true }, 2, 1)).toEqual({
      ok: false,
      reason: 'crashed-starts-incomplete',
    });
    expect(validateChildInspectResult({ ...good, crashedStarts: [] }, 2, 1)).toEqual({ ok: false, reason: 'crashed-starts-count' });
    expect(validateChildInspectResult({ ...good, crashedStarts: 'x' }, 2, 1)).toEqual({ ok: false, reason: 'crashed-starts-count' });
    expect(validateChildInspectResult({ ...good, crashedStarts: [{ workOrderId: null }] }, 2, 1)).toEqual({
      ok: false,
      reason: 'crashed-start-attempt-not-read',
    });
    expect(validateChildInspectResult({ ...good, crashedStarts: [null] }, 2, 1)).toEqual({
      ok: false,
      reason: 'crashed-start-attempt-not-read',
    });
    expect(validateChildInspectResult({ ...good, runs: [{}] }, 2, 1)).toEqual({ ok: false, reason: 'runs-count' });
  });

  it('refuses a timed-out child process as timeout', () => {
    expect(parseChildRssResult({ error: { code: 'ETIMEDOUT' }, status: null, stdout: '' })).toEqual({ ok: false, reason: 'timeout' });
    expect(parseChildRssResult({ error: { code: 'ETIMEDOUT' }, status: 0, stdout: '{"ok":true,"rssBytes":5}' })).toEqual({
      ok: false,
      reason: 'timeout',
    });
  });

  it('refuses a signal-killed or OOM-aborted child process as child-killed', () => {
    expect(parseChildRssResult({ status: null, stdout: '' })).toEqual({ ok: false, reason: 'child-killed' });
    expect(parseChildRssResult({ error: {}, status: null, stdout: '{"ok":true,"rssBytes":5}' })).toEqual({
      ok: false,
      reason: 'child-killed',
    });
  });

  it('refuses empty or whitespace-only child stdout as empty-stdout', () => {
    expect(parseChildRssResult({ status: 0, stdout: '' })).toEqual({ ok: false, reason: 'empty-stdout' });
    expect(parseChildRssResult({ status: 1, stdout: ' \n\t ' })).toEqual({ ok: false, reason: 'empty-stdout' });
  });

  it('refuses malformed JSON child stdout as invalid-json', () => {
    expect(parseChildRssResult({ status: 0, stdout: '{not json' })).toEqual({ ok: false, reason: 'invalid-json' });
  });

  it('refuses non-object JSON child stdout as invalid-json', () => {
    for (const stdout of ['null', '[]', '"x"', '123']) {
      expect(parseChildRssResult({ status: 0, stdout })).toEqual({ ok: false, reason: 'invalid-json' });
    }
  });

  it('refuses a child payload with ok !== true as child-failed preserving reason', () => {
    expect(parseChildRssResult({ status: 1, stdout: '{"ok":false,"reason":"halt-not-clear"}' })).toEqual({
      ok: false,
      reason: 'child-failed',
      detail: 'halt-not-clear',
    });
    expect(parseChildRssResult({ status: 0, stdout: '{"ok":false,"reason":7}' })).toEqual({
      ok: false,
      reason: 'child-failed',
      detail: 'unknown',
    });
    expect(parseChildRssResult({ status: 0, stdout: '{"ok":"true","rssBytes":5}' })).toMatchObject({
      ok: false,
      reason: 'child-failed',
    });
  });

  it('refuses a non-zero exit status when ok is true as non-zero-exit', () => {
    expect(parseChildRssResult({ status: 2, stdout: '{"ok":true,"rssBytes":5}' })).toEqual({
      ok: false,
      reason: 'non-zero-exit',
    });
    // non-zero exit takes precedence over an invalid rss
    expect(parseChildRssResult({ status: 1, stdout: '{"ok":true,"rssBytes":-1}' })).toEqual({
      ok: false,
      reason: 'non-zero-exit',
    });
  });

  it('refuses a non-positive, non-number or missing rssBytes in child payload as invalid-rss', () => {
    for (const payload of ['{"ok":true,"rssBytes":"123"}', '{"ok":true,"rssBytes":-1}', '{"ok":true,"rssBytes":0}', '{"ok":true,"rssBytes":null}', '{"ok":true}']) {
      expect(parseChildRssResult({ status: 0, stdout: payload })).toEqual({ ok: false, reason: 'invalid-rss' });
    }
  });

  it('parses a valid child result into rssBytes', () => {
    expect(parseChildRssResult({ status: 0, stdout: '{"ok":true,"rssBytes":123456}\n' })).toEqual({
      ok: true,
      rssBytes: 123456,
    });
  });

  it('refuses a non-positive, non-finite or NaN budget', () => {
    for (const budget of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      expect(evaluateMemoryBudget(10, budget)).toEqual({ ok: false, reason: 'invalid-budget' });
    }
  });

  it('refuses a non-positive, non-finite or NaN rssBytes', () => {
    for (const rss of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      expect(evaluateMemoryBudget(rss, 100)).toEqual({ ok: false, reason: 'invalid-rss' });
    }
  });

  it('refuses rssBytes exceeding budgetBytes as over-budget', () => {
    expect(evaluateMemoryBudget(101, 100)).toEqual({ ok: false, reason: 'over-budget' });
  });

  it('accepts a positive finite rss within budget', () => {
    expect(evaluateMemoryBudget(100, 100)).toEqual({ ok: true });
    expect(evaluateMemoryBudget(1, 100)).toEqual({ ok: true });
  });
});

describe('synthetic ~69 MB state-dir fixture', () => {
  let largeDir = '';
  let large: FixtureManifest;

  beforeAll(() => {
    largeDir = mkdtempSync(join(tmpdir(), 'status-memory-budget-large-'));
    large = buildFixture(largeDir, 'large');
  }, 120_000);

  afterAll(() => {
    if (largeDir !== '') {
      rmSync(largeDir, { recursive: true, force: true });
    }
  });

  it('generates deterministic ~69 MB fixture within 10% of target store sizes and hashes identically across runs', async () => {
    expect(large.totalBytes).toBeGreaterThan(LARGE_TOTAL_TARGET * 0.9);
    expect(large.totalBytes).toBeLessThan(LARGE_TOTAL_TARGET * 1.1);
    for (const [file, target] of Object.entries(LARGE_TARGETS)) {
      const written = large.files.get(file);
      expect(written?.bytes ?? 0).toBeGreaterThan(target * 0.9);
      expect(written?.bytes ?? 0).toBeLessThan(target * 1.1);
    }
    expect([...large.files.keys()].sort()).toEqual(
      [
        'assessments.json',
        'attempts.json',
        'conductor-driver-lease.json',
        'conductor-halt.json',
        'conductor-passes.json',
        'journal.json',
        'lane-plans.json',
        'lane-runs.json',
        'reservations.json',
        'run-journal.json',
        'work-orders.json',
      ],
    );
    const again = await withFixture(async (dir) => buildFixture(dir, 'large'));
    expect(again.digest).toBe(large.digest);
    expect(again.totalBytes).toBe(large.totalBytes);
  }, 180_000);

  it('validates every generated store record with its real adapter parser and passes secret-shape scan', () => {
    for (const spec of specsFor('large')) {
      const parsed = parseStoreFile(largeDir, spec);
      expect({ file: spec.file, rejected: parsed.rejected, secret: parsed.secret }).toEqual({
        file: spec.file,
        rejected: 0,
        secret: 0,
      });
      expect(parsed.accepted).toBe(large.files.get(spec.file)?.records);
    }
  }, 180_000);

  describe.skipIf(process.env.FLEET_STATUS_BUDGET !== '1')('peak RSS budget (FLEET_STATUS_BUDGET=1)', () => {
    it('keeps per-run status read peak RSS within 512 MB', () => {
      const measured = measureStatusReadRss({
        stateDir: largeDir,
        runId: runIdOf(0),
        expectedRuns: 1,
        expectedCrashedStarts: CRASHED_ATTEMPT_COUNT,
      });
      expect(measured.ok).toBe(true);
      if (measured.ok) {
        expect(evaluateMemoryBudget(measured.rssBytes, PER_RUN_BUDGET_BYTES)).toEqual({ ok: true });
      }
    }, 240_000);

    // SB5: skipped until SB5 (indexed status read) lands. Measured 2026-11-27 on this fixture: all-runs
    // peak RSS about 834 MB (per-run about 164 MB), under the 1 GB budget, while the plan measures 4-4.7 GB
    // for the real `conductor status`. InspectLaneRunsUseCase alone reads only 6 of the stores (not
    // assessments.json, work-orders.json or orchestrators.json), so this harness does not reproduce the
    // real peak and the budget cannot fail as intended. SB5 must widen the fixture/harness to the full CLI
    // read path, confirm it fails above 1 GB, then un-skip this test.
    it.skip('keeps all-runs status read peak RSS within 1 GB', () => {
      const measured = measureStatusReadRss({
        stateDir: largeDir,
        runId: '',
        expectedRuns: RUN_COUNT,
        expectedCrashedStarts: CRASHED_ATTEMPT_COUNT,
      });
      expect(measured.ok).toBe(true);
      if (measured.ok) {
        expect(evaluateMemoryBudget(measured.rssBytes, ALL_RUNS_BUDGET_BYTES)).toEqual({ ok: true });
      }
    }, 240_000);
  });
});

describe('status read smoke (always on)', () => {
  it('measures peak RSS in a child process against the tiny smoke fixture', async () => {
    expect(CRASHED_START_GRACE_MINUTES).toBeLessThan(10);
    await withFixture(async (dir) => {
      buildFixture(dir, 'smoke');
      const measured = measureStatusReadRss({
        stateDir: dir,
        runId: '',
        expectedRuns: 2,
        expectedCrashedStarts: 1,
      });
      expect(measured).toEqual({ ok: true, rssBytes: expect.any(Number) });
    });
  }, 240_000);
});
