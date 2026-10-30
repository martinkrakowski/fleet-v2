// Telemetry CLI command tests — OT4b-2. The export and status subcommands over
// a composed runtime (a temp state dir, a valid example salt in the
// installation policy) and direct `telemetryCommand` calls with a fake runtime
// where the result shape or configuration state must be controlled. Nothing
// here touches the network or spawns a process; a send with a configured state
// that is not fully configured never calls the use case.
import { createHash } from 'node:crypto';
import { mkdtempSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { FleetInstallation } from '@fleet/installation';
import {
  AttemptRepositoryAdapter,
  LaneRunJournalAdapter,
  LaneRunRepositoryAdapter,
  TelemetrySpan,
  WorkOrderRepositoryAdapter,
  emptyTelemetryDispositionRecord,
  type ExportRunTelemetryCounts,
  type ExportRunTelemetryResult,
  type TelemetryDispositionRecord,
} from '@fleet/work-execution';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli } from '../index.js';
import type { CliIo } from '../index.js';
import { telemetryCommand } from '../telemetry.js';

const SALT = '0123456789abcdef'.repeat(4);
const EXAMPLE_ENDPOINT = 'https://collector.example.test/v1/traces';
const EXAMPLE_TOKEN = 'example-token';
const NOW = new Date('2026-10-30T12:00:00.000Z');
const SINCE = '2026-01-01T00:00:00.000Z';

const CANARY_WORKTREE_PATH = '/example/canary-worktree';
const CANARY_TASK_ID = 'example-canary-task';
const SEEDED_ATTEMPT_ID = 'att-canary-1';
const SEEDED_WORK_ORDER_ID = 'wo-canary-1';
const SEEDED_RUN_ID = 'run-01ARZ3NDEKTSV4RRFFQ69G5FAV';
const SEEDED_ENTRY_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const SEEDED_BRIEF_PACKAGE_PATH = '/example/canary-brief';
const SEEDED_SESSION_ID = 'session-canary-1';
const SEEDED_LANE_ID = 'lane-canary-1';
const SEEDED_REPOSITORY = 'https://example.com/canary.git';
const SEEDED_OWNED_PATHS = ['src/', 'tests/'] as const;

/** Every seeded attempt and work-order value that must never reach any output stream. */
const SEEDED_LEAK_VALUES = [
  SEEDED_ATTEMPT_ID,
  SEEDED_WORK_ORDER_ID,
  CANARY_WORKTREE_PATH,
  SEEDED_BRIEF_PACKAGE_PATH,
  SEEDED_SESSION_ID,
  CANARY_TASK_ID,
  SEEDED_LANE_ID,
  SEEDED_REPOSITORY,
  ...SEEDED_OWNED_PATHS,
];

const ZERO_COUNTS: ExportRunTelemetryCounts = {
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

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-v2-telemetry-test-'));
}

/** Run one CLI invocation and return its exit code and captured stdout/stderr.
 *  Every call is checked for leaked secrets: the example salt, endpoint and
 *  token may appear in neither stream. */
async function runTelemetry(
  runtime: FleetCliRuntime,
  args: readonly string[],
): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  const io = captureIo();
  const code = await runCli(['telemetry', ...args], io, runtime);
  const result = { code, stdout: io.outLines, stderr: io.errLines };
  const printed = JSON.stringify([result.stdout, result.stderr]);
  expect(printed, `leak check for ${args.join(' ')}`).not.toContain(SALT);
  expect(printed, `leak check for ${args.join(' ')}`).not.toContain(EXAMPLE_ENDPOINT);
  expect(printed, `leak check for ${args.join(' ')}`).not.toContain(EXAMPLE_TOKEN);
  return result;
}

/** One JSON document on stdout. */
function parseDocument(lines: readonly string[]): Record<string, unknown> {
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

async function entryOf(dir: string, name: string): Promise<[string, string]> {
  const full = join(dir, name);
  const stat = await fs.lstat(full);
  if (stat.isFile()) {
    const digest = createHash('sha256').update(await fs.readFile(full)).digest('hex');
    return [name, digest];
  }
  return [name + '/', 'dir'];
}

/** Every file under dir (recursive) with its sha256: the whole on-disk state. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const names = await fs.readdir(dir, { recursive: true });
  const entries = await Promise.all(names.map((name) => entryOf(dir, name)));
  return Object.fromEntries(entries.sort((a, b) => a[0].localeCompare(b[0])));
}

const HOSTS = {
  local: {
    transport: 'local' as const,
    worktreeRoot: '/tmp/fleet-ot4b2-worktrees',
    roles: ['orchestrator', 'lane-runner'] as ('orchestrator' | 'lane-runner')[],
    runner: {
      kind: 'opencode' as const,
      port: 46000,
      capabilities: {
        networkEgressRestricted: true,
        cpuAndMemoryLimited: true,
        processTreeTermination: true,
        filesystemScope: 'scoped-worktree' as const,
      },
      maxLanes: 2,
    },
  },
};

/** Minimal valid v2 installation with a telemetry policy carrying the example salt. */
function makeInstallation(): FleetInstallation {
  return {
    schemaVersion: 2,
    hosts: HOSTS,
    forge: { mode: 'none' },
    policy: {
      telemetry: { enabled: true, salt: SALT },
    },
  };
}

function makeRuntime(stateDir: string): FleetCliRuntime {
  return createFleetCliRuntime({ stateDir, installation: makeInstallation() });
}

interface FakeTelemetryOverrides {
  readonly exportTelemetry?: { execute: (request: unknown) => Promise<ExportRunTelemetryResult> } | null;
  readonly configured?: FleetCliRuntime['telemetry']['configured'];
  readonly saltFingerprint?: string | null;
  readonly policy?: FleetCliRuntime['telemetry']['policy'];
  readonly resource?: FleetCliRuntime['telemetry']['resource'];
  readonly canaryValues?: FleetCliRuntime['telemetry']['canaryValues'];
  readonly dispositions?: {
    read: () => Promise<
      | { outcome: 'read'; record: TelemetryDispositionRecord }
      | { outcome: 'unreadable' }
    >;
  };
}

/** One real, encodable span for fake dry-run results. */
function validSpan(): TelemetrySpan {
  const span = TelemetrySpan.build({
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    parentSpanId: null,
    name: 'lane-run',
    kind: 'CHAIN',
    startIso: '2026-10-01T00:00:00.000Z',
    endIso: '2026-10-02T00:00:00.000Z',
    status: { code: 'ok', reasonCode: null },
    attributes: {},
    events: [],
  });
  expect(span).not.toBeNull();
  return span as TelemetrySpan;
}

/**
 * Seed the real stores over a temp state dir: a work order with the
 * distinctive task id, an attempt with the distinctive worktree path, and —
 * when `withRun` — a run and one journal entry whose key strips to a step
 * remainder. The composed runtime rereads these records.
 */
async function seedCanaryState(stateDir: string, withRun: boolean): Promise<void> {
  const workOrderRepo = new WorkOrderRepositoryAdapter({ stateDir });
  await workOrderRepo.saveWorkOrder({
    id: SEEDED_WORK_ORDER_ID,
    projectId: 'project-canary-1',
    taskId: CANARY_TASK_ID,
    laneId: 'lane-canary-1',
    repository: 'https://example.com/canary.git',
    baseCommit: '0123456789abcdef0123456789abcdef01234567',
    ownedPaths: ['src/', 'tests/'],
    policyRevision: 'policy-rev-1',
    prerequisiteWorkOrderIds: [],
    state: 'approved',
    revision: 1,
    createdAtIso: '2026-10-01T00:00:00.000Z',
    updatedAtIso: '2026-10-01T00:00:00.000Z',
  });

  const attemptRepo = new AttemptRepositoryAdapter({ stateDir });
  await attemptRepo.saveAttempt({
    id: SEEDED_ATTEMPT_ID,
    workOrderId: SEEDED_WORK_ORDER_ID,
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: CANARY_WORKTREE_PATH,
    baseCommit: '0123456789abcdef0123456789abcdef01234567',
    state: 'ended',
    revision: 1,
    outcome: null,
    briefDigest: null,
    briefPackagePath: '/example/canary-brief',
    sessionId: 'session-canary-1',
    completionReceipt: null,
    artifacts: null,
    createdAtIso: '2026-10-01T00:00:00.000Z',
    updatedAtIso: '2026-10-01T00:00:00.000Z',
  });

  if (!withRun) {
    return;
  }

  const runRepo = new LaneRunRepositoryAdapter({ stateDir });
  const created = await runRepo.create({
    version: 1,
    runId: SEEDED_RUN_ID,
    workOrderId: SEEDED_WORK_ORDER_ID,
    tier: 1,
    seatPlanRef: 'a'.repeat(64),
    cursors: { 'first-pass': 0, fix: null, review: null },
    round: 0,
    attemptIds: [SEEDED_ATTEMPT_ID],
    prNumber: null,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 1,
    runPolicyRevision: 'policy-rev-1',
  });
  expect(created.outcome).toBe('saved');

  const journal = new LaneRunJournalAdapter({ stateDir });
  const appended = await journal.append({
    version: 1,
    entryId: SEEDED_ENTRY_ID,
    kind: 'intent',
    key: `${SEEDED_RUN_ID}/r0/dispatch/0/a1`,
    runId: SEEDED_RUN_ID,
    recordedAtIso: '2026-10-02T00:00:00.000Z',
    mode: null,
    expectedRevision: null,
    mintedId: SEEDED_ATTEMPT_ID,
    outcome: null,
    reasonCode: null,
    detail: null,
    grantId: null,
    state: null,
  });
  expect(appended.outcome).toBe('appended');
}

/** A fake runtime carrying only the telemetry surface the commands read. */
function fakeRuntime(overrides: FakeTelemetryOverrides = {}): FleetCliRuntime {
  return {
    telemetry: {
      acceptanceReceiptRead: {},
      dispositions:
        overrides.dispositions ??
        ({ read: async () => ({ outcome: 'read', record: emptyTelemetryDispositionRecord() }) }),
      exportTelemetry: overrides.exportTelemetry ?? null,
      configured: overrides.configured ?? 'configured',
      saltFingerprint: overrides.saltFingerprint ?? null,
      policy: overrides.policy ?? {
        enabled: true,
        projectName: 'fleet-lanes',
        route: 'collector',
        sampleRatio: 1,
        sendCost: true,
        includeDryRun: true,
        projectAliases: {},
      },
      resource:
        overrides.resource ??
        ({ serviceVersion: '0.0.0', projectName: 'fleet-lanes' } as FleetCliRuntime['telemetry']['resource']),
      canaryValues: overrides.canaryValues ?? (async () => []),
    },
  } as unknown as FleetCliRuntime;
}

describe('fleet-v2 telemetry (OT4b-2)', () => {
  it('usage errors exit 2 with one stderr line naming the problem', async () => {
    const runtime = fakeRuntime();
    const cases: Array<[readonly string[], string]> = [
      [['export'], 'exactly one'],
      [['export', '--dry-run'], 'exactly one'],
      [['export', '--run'], 'requires a value'],
      [['export', '--run', 'a', '--run', 'b'], 'Repeated flag'],
      [['export', '--work-order'], 'requires a value'],
      [['export', '--since'], 'requires a value'],
      [['export', '--until', SINCE], 'requires --since'],
      [['export', '--run', 'run-example-1', '--since', SINCE], 'exactly one'],
      [['export', '--run', 'run-example-1', '--until', SINCE], 'requires --since'],
      [['export', '--frob'], 'Unknown telemetry export option'],
      [['export', '--dry-run', '--since', '2026-01-01'], 'ISO 8601'],
      [['export', '--dry-run', '--since', 'garbage'], 'ISO 8601'],
      [['export', '--dry-run', '--since', SINCE, '--deadline', '0'], '--deadline'],
      [['export', '--dry-run', '--since', SINCE, '--deadline', '601'], '--deadline'],
      [['export', '--dry-run', '--since', SINCE, '--deadline', 'abc'], '--deadline'],
      [['export', '--dry-run', '--since', SINCE, '--deadline', '1.5'], '--deadline'],
      [['export', '--dry-run', '--since', SINCE, '--retry-rejected'], '--retry-rejected'],
      [['export', '--canary', '--run', 'run-example-1'], '--canary requires --dry-run'],
      [['export', '--dry-run', '--canary', '--canary', '--since', SINCE], 'Repeated flag'],
      [['export', 'stray'], 'Unknown telemetry export option'],
      [['status', '--frob'], 'Unknown telemetry status option'],
      [['frob'], 'Unknown telemetry subcommand'],
    ];
    for (const [args, fragment] of cases) {
      const result = await runTelemetry(runtime, args);
      expect(result.code, args.join(' ')).toBe(2);
      expect(result.stdout, args.join(' ')).toEqual([]);
      expect(result.stderr, args.join(' ')).toHaveLength(1);
      expect(result.stderr.join(''), args.join(' ')).toContain(fragment);
    }
  });

  it('usage errors never echo a caller value', async () => {
    const runtime = fakeRuntime();
    const cases: Array<[readonly string[], string]> = [
      [['export', '--token=example-token'], 'Unknown telemetry export option'],
      [['export', 'stray'], 'Unknown telemetry export option'],
      [['status', 'https://collector.example.test/v1/traces'], 'Unknown telemetry status option'],
      [['example-secret-subcommand'], 'Unknown telemetry subcommand'],
    ];
    for (const [args, fragment] of cases) {
      const result = await runTelemetry(runtime, args);
      expect(result.code, args.join(' ')).toBe(2);
      expect(result.stdout, args.join(' ')).toEqual([]);
      expect(result.stderr.join(''), args.join(' ')).toContain(fragment);
      expect(result.stderr.join(''), args.join(' ')).not.toContain('example-token');
      expect(result.stderr.join(''), args.join(' ')).not.toContain('collector.example.test');
      expect(result.stderr.join(''), args.join(' ')).not.toContain('example-secret-subcommand');
    }
  });

  it('an empty flag value is a usage error and never calls the use case', async () => {
    let called = 0;
    const runtime = fakeRuntime({
      exportTelemetry: {
        execute: async () => {
          called += 1;
          return { outcome: 'nothing-selected', counts: ZERO_COUNTS };
        },
      },
    });
    for (const args of [
      ['export', '--dry-run', '--run='],
      ['export', '--dry-run', '--work-order='],
      ['export', '--dry-run', '--run', ''],
      ['export', '--dry-run', '--since='],
    ]) {
      const result = await runTelemetry(runtime, args);
      expect(result.code, args.join(' ')).toBe(2);
      expect(result.stdout, args.join(' ')).toEqual([]);
      expect(result.stderr.join(''), args.join(' ')).toContain('requires a value');
      expect(result.stderr.join(''), args.join(' ')).not.toContain('example-token');
    }
    expect(called).toBe(0);
  });

  it('--retry-rejected reaches the use case, --json is accepted once and rejected twice', async () => {
    let captured: unknown;
    const runtime = fakeRuntime({
      exportTelemetry: {
        execute: async (request: unknown) => {
          captured = request;
          return { outcome: 'nothing-selected', counts: ZERO_COUNTS };
        },
      },
    });
    const sent = await runTelemetry(runtime, ['export', '--run', 'run-example-1', '--retry-rejected', '--json']);
    expect(sent.code).toBe(0);
    expect((captured as Record<string, unknown>).retryRejected).toBe(true);
    captured = undefined;
    const jsonOnce = await runTelemetry(runtime, ['export', '--dry-run', '--since', SINCE, '--json']);
    expect(jsonOnce.code).toBe(0);
    expect((captured as Record<string, unknown>).retryRejected).toBe(false);
    const jsonTwice = await runTelemetry(runtime, ['export', '--dry-run', '--since', SINCE, '--json', '--json']);
    expect(jsonTwice.code).toBe(2);
    expect(jsonTwice.stderr.join('')).toContain('Repeated flag: --json');
  });

  it('a throwing store read makes status exit 1 with store-unreadable and no path', async () => {
    const runtime = fakeRuntime({
      dispositions: {
        read: async () => {
          throw new Error('cannot read /example/state/telemetry-dispositions.json');
        },
      },
    });
    const result = await runTelemetry(runtime, ['status']);
    expect(result.code).toBe(1);
    expect(parseDocument(result.stdout)).toEqual({ outcome: 'store-unreadable', configured: 'configured' });
    expect(JSON.stringify(result.stdout)).not.toContain('/example/state/telemetry-dispositions.json');
    expect(JSON.stringify(result.stderr)).not.toContain('/example/state/telemetry-dispositions.json');
  });

  it('--help prints the help constant and exits 0', async () => {
    const runtime = fakeRuntime();
    for (const args of [['--help'], ['help'], ['export', '--help'], ['status', '--help']]) {
      const result = await runTelemetry(runtime, args);
      expect(result.code, args.join(' ')).toBe(0);
      const text = result.stdout.join('');
      expect(text).toContain('telemetry export');
      expect(text).toContain('telemetry status');
      expect(text).toContain('--dry-run');
    }
  });

  it('export --dry-run --since over an empty state exits 0 with nothing-selected and writes nothing', async () => {
    const stateDir = tempStateDir();
    try {
      const runtime = makeRuntime(stateDir);
      const result = await runTelemetry(runtime, ['export', '--dry-run', '--since', SINCE]);
      expect(result.code).toBe(0);
      expect(parseDocument(result.stdout)).toMatchObject({ outcome: 'nothing-selected' });
      const printed = JSON.stringify(result.stdout);
      expect(printed).not.toContain(SALT);
      expect(printed).not.toContain(EXAMPLE_ENDPOINT);
      expect(printed).not.toContain(EXAMPLE_TOKEN);
      expect(await snapshot(stateDir)).toEqual({});
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('no salt prints not-configured and exits 1', async () => {
    const runtime = fakeRuntime({ configured: 'no-salt' });
    const result = await runTelemetry(runtime, ['export', '--run', 'run-example-1']);
    expect(result.code).toBe(1);
    expect(parseDocument(result.stdout)).toEqual({ outcome: 'not-configured', configured: 'no-salt' });
  });

  it('a send with configured no-endpoint exits 1 with not-configured and never calls the use case', async () => {
    let called = 0;
    const runtime = fakeRuntime({
      configured: 'no-endpoint',
      exportTelemetry: {
        execute: async () => {
          called += 1;
          return { outcome: 'nothing-selected', counts: ZERO_COUNTS };
        },
      },
    });
    const result = await runTelemetry(runtime, ['export', '--run', 'run-example-1']);
    expect(result.code).toBe(1);
    expect(parseDocument(result.stdout)).toEqual({ outcome: 'not-configured', configured: 'no-endpoint' });
    expect(called).toBe(0);
  });

  it('builds the send request from flags, policy, deadline and nowIso', async () => {
    let captured: unknown;
    const runtime = fakeRuntime({
      exportTelemetry: {
        execute: async (request: unknown) => {
          captured = request;
          return { outcome: 'nothing-selected', counts: ZERO_COUNTS };
        },
      },
    });
    const io = captureIo();
    const code = await telemetryCommand(
      ['export', '--run', 'run-example-1', '--deadline', '60'],
      io,
      runtime,
      { now: () => NOW },
    );
    expect(code).toBe(0);
    const request = captured as Record<string, unknown>;
    expect(request.mode).toBe('send');
    expect(request.retryRejected).toBe(false);
    expect(request.nowIso).toBe(NOW.toISOString());
    expect(request.deadline).toEqual({ atMs: NOW.getTime() + 60_000 });
    expect(request.selection).toEqual({ kind: 'run', runId: 'run-example-1' });
    expect(request.policy).toEqual({
      route: 'collector',
      sampleRatio: 1,
      sendCost: true,
      includeDryRun: true,
      projectAliases: {},
    });
    expect(io.outLines.join('')).not.toContain(SALT);
    expect(io.outLines.join('')).not.toContain(EXAMPLE_ENDPOINT);
    expect(io.outLines.join('')).not.toContain(EXAMPLE_TOKEN);
  });

  it('builds a dry-run window request with no deadline', async () => {
    let captured: unknown;
    const runtime = fakeRuntime({
      exportTelemetry: {
        execute: async (request: unknown) => {
          captured = request;
          return { outcome: 'nothing-selected', counts: ZERO_COUNTS };
        },
      },
    });
    const io = captureIo();
    const code = await telemetryCommand(
      ['export', '--dry-run', '--since', SINCE, '--until', '2026-12-31T23:59:59Z'],
      io,
      runtime,
      { now: () => NOW },
    );
    expect(code).toBe(0);
    const request = captured as Record<string, unknown>;
    expect(request.mode).toBe('dry-run');
    expect(request.deadline).toBeNull();
    expect(request.retryRejected).toBe(false);
    expect(request.selection).toEqual({
      kind: 'window',
      sinceIso: SINCE,
      untilIso: '2026-12-31T23:59:59Z',
    });
  });

  it('a send maps an exported result to the exit code', async () => {
    const base: ExportRunTelemetryCounts = {
      ...ZERO_COUNTS,
      runsSelected: 1,
      attemptsSelected: 1,
      spansMapped: 5,
      toSend: 5,
      exported: 5,
    };
    const cases: Array<[ExportRunTelemetryCounts, number]> = [
      [base, 0],
      [{ ...base, exported: 4, pending: 1 }, 1],
      [{ ...base, exported: 4, rejected: 1 }, 1],
      [{ ...base, exported: 4, refusedByStore: 1 }, 1],
    ];
    for (const [counts, expected] of cases) {
      const runtime = fakeRuntime({
        exportTelemetry: {
          execute: async () => ({ outcome: 'exported', counts, errorKind: null }),
        },
      });
      const result = await runTelemetry(runtime, ['export', '--work-order', 'wo-example-1']);
      expect(result.code, JSON.stringify(counts)).toBe(expected);
      expect(parseDocument(result.stdout)).toMatchObject({ outcome: 'exported', counts });
    }
    const errorKindRuntime = fakeRuntime({
      exportTelemetry: {
        execute: async () => ({ outcome: 'exported', counts: base, errorKind: 'http-5xx' }),
      },
    });
    expect((await runTelemetry(errorKindRuntime, ['export', '--work-order', 'wo-example-1'])).code).toBe(1);
  });

  it('a refused result exits 1', async () => {
    const runtime = fakeRuntime({
      exportTelemetry: {
        execute: async () => ({
          outcome: 'refused',
          reason: 'salt-mismatch',
          counts: ZERO_COUNTS,
          counters: { 'salt-mismatch': 1 },
        }),
      },
    });
    const result = await runTelemetry(runtime, ['export', '--run', 'run-example-1']);
    expect(result.code).toBe(1);
    expect(parseDocument(result.stdout)).toMatchObject({ outcome: 'refused', reason: 'salt-mismatch' });
  });

  it('a dry run maps the result to the exit code', async () => {
    const base: ExportRunTelemetryCounts = {
      ...ZERO_COUNTS,
      runsSelected: 1,
      spansMapped: 2,
      toSend: 2,
    };
    const good = fakeRuntime({
      exportTelemetry: {
        execute: async () => ({ outcome: 'dry-run', counts: base, spans: [] }),
      },
    });
    expect((await runTelemetry(good, ['export', '--dry-run', '--since', SINCE])).code).toBe(0);
    const invalid = fakeRuntime({
      exportTelemetry: {
        execute: async () => ({ outcome: 'dry-run', counts: { ...base, rejectedInvalid: 1 }, spans: [] }),
      },
    });
    expect((await runTelemetry(invalid, ['export', '--dry-run', '--since', SINCE])).code).toBe(1);
  });

  it('status prints every field, the fingerprints and never the salt', async () => {
    const record: TelemetryDispositionRecord = {
      version: 1,
      saltFingerprint: '11aa22bb',
      spans: {},
      counters: {
        timeout: 0,
        network: 0,
        auth: 0,
        'http-4xx': 0,
        'http-5xx': 0,
        partial: 0,
        'salt-mismatch': 0,
        'queue-drops': 0,
      },
      lastExportAtIso: '2026-10-29T08:00:00.000Z',
    };
    const runtime = fakeRuntime({
      saltFingerprint: '11aa22bb',
      dispositions: { read: async () => ({ outcome: 'read', record }) },
    });
    const result = await runTelemetry(runtime, ['status']);
    expect(result.code).toBe(0);
    const document = parseDocument(result.stdout);
    expect(document.configured).toBe('configured');
    expect(document.saltFingerprint).toBe('11aa22bb');
    expect(document.recordedSaltFingerprint).toBe('11aa22bb');
    expect(document.fingerprintMatch).toBe(true);
    expect(document.schemaVersion).toBe(1);
    expect(document.hashPrefix).toBe('fleet-telemetry/v1');
    expect(document.route).toBe('collector');
    expect(document.lastExportAtIso).toBe('2026-10-29T08:00:00.000Z');
    expect(document.spans).toEqual(expect.objectContaining({ pending: 0, 'exported@collector': 0 }));
    expect(document.counters).toEqual(expect.objectContaining({ timeout: 0, 'queue-drops': 0 }));
    const printed = JSON.stringify(result.stdout);
    expect(printed).not.toContain(SALT);
    expect(printed).not.toContain(EXAMPLE_ENDPOINT);
    expect(printed).not.toContain(EXAMPLE_TOKEN);
  });

  it('status shows fingerprintMatch null on an empty store', async () => {
    const stateDir = tempStateDir();
    try {
      const runtime = makeRuntime(stateDir);
      const result = await runTelemetry(runtime, ['status']);
      expect(result.code).toBe(0);
      const document = parseDocument(result.stdout);
      expect(document.recordedSaltFingerprint).toBeNull();
      expect(document.fingerprintMatch).toBeNull();
      expect(typeof document.saltFingerprint).toBe('string');
      expect(document.schemaVersion).toBe(1);
      expect(document.hashPrefix).toBe('fleet-telemetry/v1');
      const printed = JSON.stringify(result.stdout);
      expect(printed).not.toContain(SALT);
      expect(printed).not.toContain(EXAMPLE_ENDPOINT);
      expect(printed).not.toContain(EXAMPLE_TOKEN);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('an unreadable store makes status exit 1 with store-unreadable', async () => {
    const runtime = fakeRuntime({
      dispositions: { read: async () => ({ outcome: 'unreadable' }) },
    });
    const result = await runTelemetry(runtime, ['status']);
    expect(result.code).toBe(1);
    expect(parseDocument(result.stdout)).toEqual({ outcome: 'store-unreadable', configured: 'configured' });
  });

  it('export --dry-run --since over seeded state encodes cleanly and exits 0', async () => {
    const stateDir = tempStateDir();
    try {
      await seedCanaryState(stateDir, false);
      const runtime = makeRuntime(stateDir);
      const result = await runTelemetry(runtime, ['export', '--dry-run', '--since', SINCE]);
      expect(result.code).toBe(0);
      const document = parseDocument(result.stdout);
      expect(document.outcome).toBe('dry-run');
      expect(document.encodeRefused).toBe(0);
      const printed = JSON.stringify([result.stdout, result.stderr]);
      for (const seeded of SEEDED_LEAK_VALUES) {
        expect(printed, `leaked seeded value ${seeded}`).not.toContain(seeded);
      }
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('a dry run with one unbranded span reports encodeRefused 1 and exits 1', async () => {
    const base: ExportRunTelemetryCounts = {
      ...ZERO_COUNTS,
      runsSelected: 0,
      attemptsSelected: 1,
      spansMapped: 1,
      toSend: 1,
    };
    const runtime = fakeRuntime({
      exportTelemetry: {
        execute: async () =>
          ({ outcome: 'dry-run', counts: base, spans: [{ notBranded: true }] }) as unknown as ExportRunTelemetryResult,
      },
    });
    const result = await runTelemetry(runtime, ['export', '--dry-run', '--since', SINCE]);
    expect(result.code).toBe(1);
    expect(parseDocument(result.stdout)).toMatchObject({ outcome: 'dry-run', encodeRefused: 1 });
  });

  it('--dry-run --canary over seeded state prints five passing checks and never a canary value', async () => {
    const stateDir = tempStateDir();
    try {
      await seedCanaryState(stateDir, false);
      const runtime = makeRuntime(stateDir);
      const result = await runTelemetry(runtime, ['export', '--dry-run', '--canary', '--since', SINCE]);
      expect(result.code).toBe(0);
      const document = parseDocument(result.stdout);
      expect(document.outcome).toBe('dry-run');
      expect(document.encodeRefused).toBe(0);
      const canary = document.canary as {
        pass: boolean;
        checks: Array<{ check: string; pass: boolean }>;
        skippedCanaries: number;
      };
      expect(canary.pass).toBe(true);
      expect(canary.checks).toHaveLength(5);
      expect(canary.checks.map((check) => check.check)).toEqual([
        'payload-parses',
        'canaries',
        'key-allow-list',
        'values',
        'secret-shapes',
      ]);
      for (const check of canary.checks) {
        expect(check.pass).toBe(true);
      }
      expect(canary.skippedCanaries).toBe(0);
      const printed = JSON.stringify([result.stdout, result.stderr]);
      for (const seeded of SEEDED_LEAK_VALUES) {
        expect(printed, `leaked seeded value ${seeded}`).not.toContain(seeded);
      }
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('a batch past the encoder bound counts every span as refused and exits 1', async () => {
    const base: ExportRunTelemetryCounts = {
      ...ZERO_COUNTS,
      runsSelected: 1,
      spansMapped: 10_001,
      toSend: 10_001,
    };
    // One branded span object repeated: the encoder refuses a batch past its
    // 10,000-span bound before reading any element, with an empty `refused`
    // list and `payload: null`.
    const spans = Array.from({ length: 10_001 }, () => validSpan());
    const runtime = fakeRuntime({
      exportTelemetry: {
        execute: async () =>
          ({ outcome: 'dry-run', counts: base, spans }) as unknown as ExportRunTelemetryResult,
      },
    });
    const result = await runTelemetry(runtime, ['export', '--dry-run', '--since', SINCE]);
    expect(result.code).toBe(1);
    expect(parseDocument(result.stdout)).toMatchObject({ outcome: 'dry-run', encodeRefused: 10_001 });
  });

  it('an unreadable work-orders.json fails the canary read and leaves the state dir byte-identical', async () => {
    const stateDir = tempStateDir();
    try {
      const attemptRepo = new AttemptRepositoryAdapter({ stateDir });
      await attemptRepo.saveAttempt({
        id: SEEDED_ATTEMPT_ID,
        workOrderId: SEEDED_WORK_ORDER_ID,
        kind: 'initial',
        fixNumber: 0,
        priorAttemptId: null,
        worktreePath: CANARY_WORKTREE_PATH,
        baseCommit: '0123456789abcdef0123456789abcdef01234567',
        state: 'ended',
        revision: 1,
        outcome: null,
        briefDigest: null,
        briefPackagePath: SEEDED_BRIEF_PACKAGE_PATH,
        sessionId: SEEDED_SESSION_ID,
        completionReceipt: null,
        artifacts: null,
        createdAtIso: '2026-10-01T00:00:00.000Z',
        updatedAtIso: '2026-10-01T00:00:00.000Z',
      });
      await fs.writeFile(join(stateDir, 'work-orders.json'), '{ not valid json', 'utf8');
      const before = await snapshot(stateDir);
      const runtime = makeRuntime(stateDir);
      const result = await runTelemetry(runtime, ['export', '--dry-run', '--canary', '--since', SINCE]);
      expect(result.code).toBe(1);
      expect(parseDocument(result.stdout)).toEqual({ outcome: 'canary-unreadable' });
      expect(await snapshot(stateDir)).toEqual(before);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('a planted canary in the encoded payload makes the canaries check fail and exit 1 without printing the value', async () => {
    const planted = 'planted-canary-value';
    const base: ExportRunTelemetryCounts = {
      ...ZERO_COUNTS,
      runsSelected: 0,
      attemptsSelected: 1,
      spansMapped: 1,
      toSend: 1,
    };
    const runtime = fakeRuntime({
      resource: { serviceVersion: '0.0.0', projectName: planted },
      policy: {
        enabled: true,
        projectName: planted,
        route: 'collector',
        sampleRatio: 1,
        sendCost: true,
        includeDryRun: true,
        projectAliases: {},
      },
      canaryValues: async () => [planted],
      exportTelemetry: {
        execute: async () => ({ outcome: 'dry-run', counts: base, spans: [validSpan()] }),
      },
    });
    const result = await runTelemetry(runtime, ['export', '--dry-run', '--canary', '--since', SINCE]);
    expect(result.code).toBe(1);
    const document = parseDocument(result.stdout);
    expect(document.outcome).toBe('dry-run');
    const canary = document.canary as { pass: boolean; checks: Array<{ check: string; pass: boolean }> };
    expect(canary.pass).toBe(false);
    const canariesCheck = canary.checks.find((check) => check.check === 'canaries');
    expect(canariesCheck?.pass).toBe(false);
    expect(JSON.stringify([result.stdout, result.stderr])).not.toContain(planted);
  });

  it('a rejecting canaryValues prints canary-unreadable and exits 1', async () => {
    const base: ExportRunTelemetryCounts = {
      ...ZERO_COUNTS,
      runsSelected: 0,
      attemptsSelected: 1,
      spansMapped: 1,
      toSend: 1,
    };
    const runtime = fakeRuntime({
      exportTelemetry: {
        execute: async () => ({ outcome: 'dry-run', counts: base, spans: [validSpan()] }),
      },
      canaryValues: async () => {
        throw new Error('store unreadable');
      },
    });
    const result = await runTelemetry(runtime, ['export', '--dry-run', '--canary', '--since', SINCE]);
    expect(result.code).toBe(1);
    expect(parseDocument(result.stdout)).toEqual({ outcome: 'canary-unreadable' });
    expect(JSON.stringify(result.stdout)).not.toContain('store unreadable');
  });

  it('composer canaryValues lists the expected values and no run id or entry id', async () => {
    const stateDir = tempStateDir();
    try {
      await seedCanaryState(stateDir, true);
      const runtime = makeRuntime(stateDir);
      const values = await runtime.telemetry.canaryValues();
      expect(values).toEqual([
        '/example/canary-brief',
        '/example/canary-worktree',
        'att-canary-1',
        'example-canary-task',
        'https://example.com/canary.git',
        'lane-canary-1',
        'project-canary-1',
        'r0/dispatch/0/a1',
        'session-canary-1',
        'src/',
        'tests/',
        'wo-canary-1',
      ]);
      expect(values).not.toContain(SEEDED_RUN_ID);
      expect(values).not.toContain(SEEDED_ENTRY_ID);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
