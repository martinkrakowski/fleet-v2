/**
 * ExportRunTelemetryUseCase tests (lane OT2c-1): the five selection kinds, the
 * window boundaries, the dry-run policy, whole-trace sampling, the cost
 * policy, the stored finals, the salt check and every fail-closed refusal.
 * In-memory class fakes whose methods use `this`; fixture values are
 * `example-*`; the salt hmac comes from a fixed test key. No result may carry
 * a fixture id, path, branch or work-order id.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { ExportRunTelemetryUseCase } from '../ExportRunTelemetryUseCase.use-case.js';
import type { ExportRunTelemetryDependencies } from '../ExportRunTelemetryUseCase.use-case.js';
import type {
  ExportRunTelemetryCounts,
  ExportRunTelemetryResult,
} from '../../ports/in/ExportRunTelemetryPort.in-port.js';
import type { RunTelemetryPort, RunTelemetrySendResult } from '../../ports/out/RunTelemetryPort.out-port.js';
import type {
  ReadReceiptsForHeadResult,
  ReviewReceiptProjection,
  VerificationReceiptProjection,
} from '../../ports/out/AcceptanceReceiptReadPort.out-port.js';
import type { TelemetrySpan } from '../../../domain/run-telemetry.js';
import {
  TELEMETRY_COUNTER_KEYS,
  TELEMETRY_DISPOSITION_RECORD_VERSION,
  type TelemetryCounterKey,
  type TelemetryDispositionRecord,
} from '../../../domain/run-telemetry-dispositions.js';
import {
  telemetryHashInput,
  telemetrySaltFingerprint,
  type TelemetryHashInput,
  type TelemetryHmac,
} from '../../../domain/run-telemetry-ids.js';
import { LANE_RUN_RECORD_VERSION, type LaneRunRecord } from '../../../domain/lane-run-records.js';
import { LANE_RUN_JOURNAL_ENTRY_VERSION, type LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';
import type { AttemptRecord, WorkOrderRecord } from '../../../domain/execution-records.js';

const SALT = 'example-telemetry-salt-0123456789abcdef0123456789abcdef';
const hmac: TelemetryHmac = (message) => createHmac('sha256', SALT).update(message, 'utf8').digest();
const otherHmac: TelemetryHmac = (message) =>
  createHmac('sha256', SALT + 'x').update(message, 'utf8').digest();

const RUN_ID = 'run-01JB0000000000000000000000';
const RUN_ID_2 = 'run-01JC0000000000000000000000';
const WORK_ORDER_ID = 'example-work-order-1';
const OTHER_WORK_ORDER_ID = 'example-work-order-2';
const PROJECT_ID = 'example-project';
const PROJECT_ALIAS = 'example-alias';
const ATTEMPT_ID = 'example-attempt-1';
const HAND_ATTEMPT_ID = 'example-hand-attempt-1';
const OTHER_HAND_ATTEMPT_ID = 'example-hand-attempt-2';
const BRANCH_NAME = 'example-branch';
const WORKTREE_PATH = '/example/worktree/path';
const HEAD_COMMIT = 'a'.repeat(40);
const NOW_ISO = '2026-10-29T10:05:00.000Z';

function time(second: number): string {
  return `2026-10-29T10:00:${String(second).padStart(2, '0')}.000Z`;
}

function asHashInput(text: string): TelemetryHashInput {
  const token = telemetryHashInput(text);
  expect(token).not.toBeNull();
  return token as TelemetryHashInput;
}

function makeRun(overrides: Partial<LaneRunRecord> = {}): LaneRunRecord {
  return {
    version: LANE_RUN_RECORD_VERSION,
    runId: RUN_ID,
    workOrderId: WORK_ORDER_ID,
    tier: 2,
    seatPlanRef: 'a'.repeat(64),
    cursors: { 'first-pass': null, fix: null, review: null },
    round: 0,
    attemptIds: [],
    prNumber: null,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 1,
    runPolicyRevision: 'policy-1',
    branchName: BRANCH_NAME,
    ...overrides,
  };
}

function makeAttempt(id: string, overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id,
    workOrderId: WORK_ORDER_ID,
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: WORKTREE_PATH,
    baseCommit: HEAD_COMMIT,
    state: 'collected',
    revision: 1,
    dispatchRevision: 1,
    outcome: 'done',
    briefDigest: null,
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: {
      attemptId: id,
      sessionId: 'example-session',
      endedAtIso: time(30),
      authoritative: true,
      exitStatus: 0,
      stoppedByRequest: false,
    },
    artifacts: null,
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
    createdAtIso: time(10),
    updatedAtIso: time(30),
    usage: {
      source: 'opencode-db',
      readAtIso: time(20),
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
    ...overrides,
  };
}

let entryCounter = 0;
function conductEntry(runId: string, second: number, state: LaneRunStateValue): LaneRunJournalEntryRecord {
  entryCounter += 1;
  return {
    version: LANE_RUN_JOURNAL_ENTRY_VERSION,
    entryId: `01JB00000000000000000000${String(entryCounter).padStart(2, '0')}`,
    kind: 'conduct',
    key: null,
    runId,
    recordedAtIso: time(second),
    mode: null,
    expectedRevision: null,
    mintedId: null,
    outcome: null,
    reasonCode: null,
    grantId: null,
    state,
  };
}

/** A terminal run journal: running, then merged (the root span is built only when terminal). */
function mergedJournal(runId: string): LaneRunJournalEntryRecord[] {
  return [conductEntry(runId, 1, 'running'), conductEntry(runId, 2, 'merged')];
}

function makeWorkOrder(overrides: Partial<WorkOrderRecord> = {}): WorkOrderRecord {
  return {
    id: WORK_ORDER_ID,
    projectId: PROJECT_ID,
    taskId: 'example-task',
    laneId: 'example-lane',
    repository: 'example/repository',
    baseCommit: HEAD_COMMIT,
    ownedPaths: [],
    policyRevision: 'policy-1',
    prerequisiteWorkOrderIds: [],
    state: 'approved',
    revision: 1,
    createdAtIso: time(1),
    updatedAtIso: time(1),
    ...overrides,
  };
}

function makeDispositionsRecord(overrides: Partial<TelemetryDispositionRecord> = {}): TelemetryDispositionRecord {
  return {
    version: TELEMETRY_DISPOSITION_RECORD_VERSION,
    saltFingerprint: telemetrySaltFingerprint(hmac),
    spans: {},
    counters: Object.fromEntries(TELEMETRY_COUNTER_KEYS.map((key) => [key, 0])) as Record<TelemetryCounterKey, number>,
    lastExportAtIso: null,
    ...overrides,
  };
}

class FakeRunRepository {
  private readonly runs = new Map<string, LaneRunRecord>();
  listThrows = false;

  withRun(run: LaneRunRecord): this {
    this.runs.set(run.runId, run);
    return this;
  }

  async get(runId: string): Promise<LaneRunRecord | null> {
    return this.runs.get(runId) ?? null;
  }

  async list(): Promise<readonly LaneRunRecord[]> {
    if (this.listThrows) {
      throw new Error('example-repository-failure');
    }
    return [...this.runs.values()];
  }
}

class FakeJournal {
  private readonly entriesByRun = new Map<string, LaneRunJournalEntryRecord[]>();

  withEntries(runId: string, entries: LaneRunJournalEntryRecord[]): this {
    this.entriesByRun.set(runId, entries);
    return this;
  }

  async listForRun(runId: string): Promise<readonly LaneRunJournalEntryRecord[]> {
    return this.entriesByRun.get(runId) ?? [];
  }
}

class FakeAttemptRepository {
  private readonly attempts = new Map<string, AttemptRecord>();

  withAttempt(attempt: AttemptRecord): this {
    this.attempts.set(attempt.id, attempt);
    return this;
  }

  async findAttemptById(attemptId: string): Promise<AttemptRecord | null> {
    return this.attempts.get(attemptId) ?? null;
  }

  async listAttemptsByWorkOrder(workOrderId: string): Promise<readonly AttemptRecord[]> {
    return [...this.attempts.values()].filter((attempt) => attempt.workOrderId === workOrderId);
  }

  async listAllAttempts(): Promise<readonly AttemptRecord[]> {
    return [...this.attempts.values()];
  }
}

class FakeWorkOrderRepository {
  private readonly workOrders = new Map<string, WorkOrderRecord>();

  withWorkOrder(workOrder: WorkOrderRecord): this {
    this.workOrders.set(workOrder.id, workOrder);
    return this;
  }

  async findWorkOrderById(workOrderId: string): Promise<WorkOrderRecord | null> {
    return this.workOrders.get(workOrderId) ?? null;
  }
}

class FakeReceipts {
  /** 'throw' makes readReceiptsForHead reject (the OT2a-1 hand-off shape). */
  outcome: 'found' | 'none' | 'unavailable' | 'throw' = 'none';
  verification: VerificationReceiptProjection[] = [];
  review: ReviewReceiptProjection[] = [];
  calls: Array<{ attemptId: string; headSha: string }> = [];

  async readReceiptsForHead(attemptId: string, headSha: string): Promise<ReadReceiptsForHeadResult> {
    this.calls.push({ attemptId, headSha });
    if (this.outcome === 'throw') {
      throw new Error('example-receipt-read-failure');
    }
    if (this.outcome === 'unavailable') {
      return { outcome: 'unavailable', reason: 'evidence-unreadable' };
    }
    if (this.outcome === 'none') {
      return { outcome: 'none' };
    }
    return { outcome: 'found', verification: this.verification, review: this.review };
  }
}

class FakeDispositions {
  writeCalls = 0;

  constructor(private readonly record: TelemetryDispositionRecord) {}

  mode: 'read' | 'unreadable' | 'throw' = 'read';

  async read(): Promise<{ outcome: 'read'; record: TelemetryDispositionRecord } | { outcome: 'unreadable' }> {
    if (this.mode === 'throw') {
      throw new Error('example-store-failure');
    }
    if (this.mode === 'unreadable') {
      return { outcome: 'unreadable' };
    }
    return { outcome: 'read', record: this.record };
  }

  async write(): Promise<never> {
    this.writeCalls += 1;
    throw new Error('this lane never writes the disposition store');
  }
}

class FakeTelemetry implements Pick<RunTelemetryPort, 'send'> {
  sendCalls = 0;

  async send(spans: readonly TelemetrySpan[], _deadline: { readonly atMs: number } | null): Promise<RunTelemetrySendResult> {
    this.sendCalls += 1;
    return {
      dispositions: spans.map((span) => ({ spanId: span.spanId, disposition: { state: 'pending' } })),
      errorKind: null,
    };
  }
}

interface Fakes {
  runRepo: FakeRunRepository;
  journal: FakeJournal;
  attemptRepo: FakeAttemptRepository;
  workOrderRepo: FakeWorkOrderRepository;
  receipts: FakeReceipts;
  dispositions: FakeDispositions;
  telemetry: FakeTelemetry;
}

function makeDeps(overrides: Partial<ExportRunTelemetryDependencies> = {}): { deps: ExportRunTelemetryDependencies; fakes: Fakes } {
  const fakes: Fakes = {
    runRepo: new FakeRunRepository(),
    journal: new FakeJournal(),
    attemptRepo: new FakeAttemptRepository(),
    workOrderRepo: new FakeWorkOrderRepository().withWorkOrder(makeWorkOrder()),
    receipts: new FakeReceipts(),
    dispositions: new FakeDispositions(makeDispositionsRecord()),
    telemetry: new FakeTelemetry(),
  };
  const deps: ExportRunTelemetryDependencies = {
    runRepo: fakes.runRepo,
    journal: fakes.journal,
    attemptRepo: fakes.attemptRepo,
    workOrderRepo: fakes.workOrderRepo,
    receipts: fakes.receipts,
    dispositions: fakes.dispositions,
    telemetry: fakes.telemetry,
    hmac,
    ...overrides,
  };
  return { deps, fakes };
}

function makePolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    route: 'collector',
    sampleRatio: 1,
    sendCost: true,
    includeDryRun: true,
    projectAliases: { [PROJECT_ID]: PROJECT_ALIAS },
    ...overrides,
  };
}

function makeRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    selection: { kind: 'run', runId: RUN_ID },
    policy: makePolicy(),
    mode: 'dry-run',
    deadline: null,
    retryRejected: false,
    nowIso: NOW_ISO,
    ...overrides,
  };
}

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

/** Asserts the refusal and returns the narrowed refused result. */
function asRefused(result: ExportRunTelemetryResult): Extract<ExportRunTelemetryResult, { outcome: 'refused' }> {
  expect(result.outcome).toBe('refused');
  return result as Extract<ExportRunTelemetryResult, { outcome: 'refused' }>;
}

const BOTH_HAND_ATTEMPTS = [
  { kind: 'attempt', attemptId: HAND_ATTEMPT_ID },
  { kind: 'attempt', attemptId: OTHER_HAND_ATTEMPT_ID },
] as const;

describe('ExportRunTelemetryUseCase selection (OT2c-1)', () => {
  it('a run selection selects that run and its conducted attempts', async () => {
    const { deps, fakes } = makeDeps();
    fakes.runRepo.withRun(makeRun({ attemptIds: [ATTEMPT_ID] }));
    fakes.attemptRepo.withAttempt(makeAttempt(ATTEMPT_ID));
    fakes.journal.withEntries(RUN_ID, mergedJournal(RUN_ID));

    const result = await new ExportRunTelemetryUseCase(deps).execute(makeRequest());

    expect(result.outcome).toBe('dry-run');
    expect(result.counts.runsSelected).toBe(1);
    expect(result.counts.attemptsSelected).toBe(1);
    expect(result.counts.spansMapped).toBeGreaterThan(0);
    expect(result.counts.toSend).toBe(result.counts.spansMapped);
  });

  it('an attempt that belongs to a run exports that run instead', async () => {
    const { deps, fakes } = makeDeps();
    fakes.runRepo.withRun(makeRun({ attemptIds: [ATTEMPT_ID] }));
    fakes.attemptRepo.withAttempt(makeAttempt(ATTEMPT_ID));
    fakes.journal.withEntries(RUN_ID, mergedJournal(RUN_ID));

    const result = await new ExportRunTelemetryUseCase(deps).execute(
      makeRequest({ selection: { kind: 'attempt', attemptId: ATTEMPT_ID } }),
    );

    expect(result.outcome).toBe('dry-run');
    expect(result.counts.runsSelected).toBe(1);
    expect(result.counts.attemptsSelected).toBe(1);
  });

  it('a hand-run attempt maps its own trace', async () => {
    const { deps, fakes } = makeDeps();
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));

    const result = (await new ExportRunTelemetryUseCase(deps).execute(
      makeRequest({ selection: { kind: 'attempt', attemptId: HAND_ATTEMPT_ID } }),
    )) as Extract<ExportRunTelemetryResult, { outcome: 'dry-run' }>;

    expect(result.outcome).toBe('dry-run');
    expect(result.counts.runsSelected).toBe(0);
    expect(result.counts.attemptsSelected).toBe(1);
    expect(result.counts.spansMapped).toBe(2);
    expect(result.spans.map((span) => span.name).sort()).toEqual(['attempt', 'usage']);
  });

  it('a work-order selection selects its runs and its hand-run attempts', async () => {
    const { deps, fakes } = makeDeps();
    fakes.runRepo.withRun(makeRun({ attemptIds: [ATTEMPT_ID] }));
    fakes.runRepo.withRun(makeRun({ runId: RUN_ID_2, workOrderId: OTHER_WORK_ORDER_ID }));
    fakes.attemptRepo.withAttempt(makeAttempt(ATTEMPT_ID));
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));
    fakes.attemptRepo.withAttempt(makeAttempt(OTHER_HAND_ATTEMPT_ID, { workOrderId: OTHER_WORK_ORDER_ID }));
    fakes.journal.withEntries(RUN_ID, mergedJournal(RUN_ID));

    const result = await new ExportRunTelemetryUseCase(deps).execute(
      makeRequest({ selection: { kind: 'work-order', workOrderId: WORK_ORDER_ID } }),
    );

    expect(result.outcome).toBe('dry-run');
    expect(result.counts.runsSelected).toBe(1);
    expect(result.counts.attemptsSelected).toBe(2);
  });

  it('a marks selection resolves every target, an owned attempt as its run', async () => {
    const { deps, fakes } = makeDeps();
    fakes.runRepo.withRun(makeRun({ attemptIds: [ATTEMPT_ID] }));
    fakes.attemptRepo.withAttempt(makeAttempt(ATTEMPT_ID));
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));
    fakes.journal.withEntries(RUN_ID, mergedJournal(RUN_ID));

    const result = await new ExportRunTelemetryUseCase(deps).execute(
      makeRequest({
        selection: {
          kind: 'marks',
          targets: [
            { kind: 'run', runId: RUN_ID },
            { kind: 'attempt', attemptId: HAND_ATTEMPT_ID },
          ],
        },
      }),
    );

    expect(result.outcome).toBe('dry-run');
    expect(result.counts.runsSelected).toBe(1);
    expect(result.counts.attemptsSelected).toBe(2);
  });

  it('an absent selection selects nothing', async () => {
    const { deps, fakes } = makeDeps();
    fakes.runRepo.withRun(makeRun());
    fakes.attemptRepo.withAttempt(makeAttempt(ATTEMPT_ID));

    const absentRun = await new ExportRunTelemetryUseCase(deps).execute(
      makeRequest({ selection: { kind: 'run', runId: 'run-01JZ0000000000000000000000' } }),
    );
    expect(absentRun).toEqual({ outcome: 'nothing-selected', counts: zeroCounts() });

    const absentAttempt = await new ExportRunTelemetryUseCase(deps).execute(
      makeRequest({ selection: { kind: 'attempt', attemptId: 'example-attempt-absent' } }),
    );
    expect(absentAttempt).toEqual({ outcome: 'nothing-selected', counts: zeroCounts() });
  });
});

describe('ExportRunTelemetryUseCase window boundaries (OT2c-1)', () => {
  it('selects runs with any journal entry and attempts inside [sinceIso, untilIso] inclusively', async () => {
    const { deps, fakes } = makeDeps();
    fakes.runRepo.withRun(makeRun({ attemptIds: [ATTEMPT_ID] }));
    fakes.runRepo.withRun(makeRun({ runId: RUN_ID_2 }));
    fakes.attemptRepo.withAttempt(makeAttempt(ATTEMPT_ID, { createdAtIso: time(10) }));
    fakes.journal.withEntries(RUN_ID, mergedJournal(RUN_ID));

    const result = await new ExportRunTelemetryUseCase(deps).execute(
      makeRequest({
        selection: { kind: 'window', sinceIso: time(10), untilIso: time(20) },
        nowIso: time(50),
      }),
    );

    expect(result.outcome).toBe('dry-run');
    expect(result.counts.runsSelected).toBe(1);
    expect(result.counts.attemptsSelected).toBe(1);
  });

  it('a null untilIso reads as nowIso; attempts after it stay out', async () => {
    const { deps, fakes } = makeDeps();
    fakes.runRepo.withRun(makeRun());
    fakes.journal.withEntries(RUN_ID, mergedJournal(RUN_ID));
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID, { updatedAtIso: time(30) }));
    fakes.attemptRepo.withAttempt(
      makeAttempt(OTHER_HAND_ATTEMPT_ID, { createdAtIso: time(40), updatedAtIso: time(40) }),
    );

    const result = await new ExportRunTelemetryUseCase(deps).execute(
      makeRequest({
        selection: { kind: 'window', sinceIso: time(1), untilIso: null },
        nowIso: time(30),
      }),
    );

    expect(result.outcome).toBe('dry-run');
    expect(result.counts.runsSelected).toBe(1);
    expect(result.counts.attemptsSelected).toBe(1);
  });

  it('an attempt before the window or after it is not selected', async () => {
    const { deps, fakes } = makeDeps();
    fakes.runRepo.withRun(makeRun());
    fakes.journal.withEntries(RUN_ID, mergedJournal(RUN_ID));
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID, { createdAtIso: time(5), updatedAtIso: time(5) }));
    fakes.attemptRepo.withAttempt(
      makeAttempt(OTHER_HAND_ATTEMPT_ID, { createdAtIso: time(45), updatedAtIso: time(45) }),
    );

    const result = await new ExportRunTelemetryUseCase(deps).execute(
      makeRequest({
        selection: { kind: 'window', sinceIso: time(10), untilIso: time(20) },
        nowIso: time(50),
      }),
    );

    expect(result.outcome).toBe('dry-run');
    expect(result.counts.runsSelected).toBe(1);
    expect(result.counts.attemptsSelected).toBe(0);
  });
});

describe('ExportRunTelemetryUseCase dry-run policy (OT2c-1, D10)', () => {
  function depsWithDryRun(): ExportRunTelemetryDependencies {
    const { deps, fakes } = makeDeps({
      dryRunKindOf: (run) => (run.runId === RUN_ID ? 'dry-run' : null),
    });
    fakes.runRepo.withRun(makeRun({ attemptIds: [ATTEMPT_ID] }));
    fakes.attemptRepo.withAttempt(makeAttempt(ATTEMPT_ID));
    fakes.journal.withEntries(RUN_ID, mergedJournal(RUN_ID));
    return deps;
  }

  it('includeDryRun false removes a dry-run run and its attempts from selection entirely', async () => {
    const deps = depsWithDryRun();

    const result = await new ExportRunTelemetryUseCase(deps).execute(
      makeRequest({ policy: makePolicy({ includeDryRun: false }) }),
    );

    expect(result).toEqual({ outcome: 'nothing-selected', counts: zeroCounts() });
  });

  it('includeDryRun true sends the run tagged dry-run', async () => {
    const deps = depsWithDryRun();

    const result = (await new ExportRunTelemetryUseCase(deps).execute(makeRequest())) as Extract<
      ExportRunTelemetryResult,
      { outcome: 'dry-run' }
    >;

    expect(result.outcome).toBe('dry-run');
    const root = result.spans.find((span) => span.name === 'lane-run');
    expect(root).toBeDefined();
    expect((root as TelemetrySpan).attributes['tag.tags']).toEqual(['conducted', 'dry-run']);
  });
});

describe('ExportRunTelemetryUseCase sampling (OT2c-1)', () => {
  it('sampleRatio 1 keeps every span, 0 keeps none', async () => {
    const { deps, fakes } = makeDeps();
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));

    const all = await new ExportRunTelemetryUseCase(deps).execute(
      makeRequest({ selection: { kind: 'attempt', attemptId: HAND_ATTEMPT_ID }, policy: makePolicy({ sampleRatio: 1 }) }),
    );
    expect(all.counts.spansMapped).toBe(2);
    expect(all.counts.sampledOut).toBe(0);
    expect(all.counts.toSend).toBe(2);

    const none = await new ExportRunTelemetryUseCase(deps).execute(
      makeRequest({ selection: { kind: 'attempt', attemptId: HAND_ATTEMPT_ID }, policy: makePolicy({ sampleRatio: 0 }) }),
    );
    expect(none.counts.toSend).toBe(0);
    expect(none.counts.sampledOut).toBe(2);
  });

  it('sampleRatio 0.5 is deterministic per trace and keeps or drops whole traces', async () => {
    const { deps, fakes } = makeDeps();
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));
    fakes.attemptRepo.withAttempt(makeAttempt(OTHER_HAND_ATTEMPT_ID));

    const request = makeRequest({ selection: { kind: 'marks', targets: BOTH_HAND_ATTEMPTS }, policy: makePolicy({ sampleRatio: 0.5 }) });
    const first = (await new ExportRunTelemetryUseCase(deps).execute(request)) as Extract<
      ExportRunTelemetryResult,
      { outcome: 'dry-run' }
    >;
    const second = (await new ExportRunTelemetryUseCase(deps).execute(request)) as Extract<
      ExportRunTelemetryResult,
      { outcome: 'dry-run' }
    >;

    expect(first.counts.spansMapped).toBe(4);
    expect(first.spans.map((span) => span.spanId).sort()).toEqual(second.spans.map((span) => span.spanId).sort());
    const spansPerTrace = new Map<string, number>();
    for (const span of first.spans) {
      spansPerTrace.set(span.traceId, (spansPerTrace.get(span.traceId) ?? 0) + 1);
    }
    for (const count of spansPerTrace.values()) {
      expect(count).toBe(2);
    }
    expect(first.counts.toSend).toBe(4 - first.counts.sampledOut);
  });
});

describe('ExportRunTelemetryUseCase cost policy (OT2c-1, §3.6)', () => {
  it('sendCost false strips every llm.cost.* and fleet.cost.* key and keeps llm.token_count.*', async () => {
    const { deps, fakes } = makeDeps();
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));
    fakes.attemptRepo.withAttempt(
      makeAttempt(OTHER_HAND_ATTEMPT_ID, {
        runner: { kind: 'agy', remotePort: null, host: null, agent: null, model: 'example-model', variant: null },
        seatSelection: {
          role: 'first-pass',
          seatIndex: 0,
          seatId: 'example-seat-2',
          model: 'example-model',
          tool: 'agy',
          variant: null,
          agent: null,
        },
      }),
    );

    const withCost = (await new ExportRunTelemetryUseCase(deps).execute(
      makeRequest({ selection: { kind: 'marks', targets: BOTH_HAND_ATTEMPTS } }),
    )) as Extract<ExportRunTelemetryResult, { outcome: 'dry-run' }>;
    const costKeys = withCost.spans
      .flatMap((span) => Object.keys(span.attributes))
      .filter((key) => key.startsWith('llm.cost.') || key.startsWith('fleet.cost.'));
    expect(costKeys.length).toBeGreaterThan(0);

    const withoutCost = (await new ExportRunTelemetryUseCase(deps).execute(
      makeRequest({ selection: { kind: 'marks', targets: BOTH_HAND_ATTEMPTS }, policy: makePolicy({ sendCost: false }) }),
    )) as Extract<ExportRunTelemetryResult, { outcome: 'dry-run' }>;

    const keys = withoutCost.spans.flatMap((span) => Object.keys(span.attributes));
    expect(keys.some((key) => key.startsWith('llm.cost.') || key.startsWith('fleet.cost.'))).toBe(false);
    expect(withoutCost.spans.some((span) => span.attributes['llm.token_count.prompt'] === 100)).toBe(true);
    expect(withoutCost.counts.toSend).toBe(withCost.counts.toSend);
    expect(withoutCost.counts.rejectedInvalid).toBe(0);
  });
});

describe('ExportRunTelemetryUseCase stored finals (OT2c-1, §3.8)', () => {
  it('finals are skipped and counted; retryRejected keeps rejected spans selected', async () => {
    const storedSpans: Record<string, Record<string, string>> = {};
    const { deps, fakes } = makeDeps({
      dispositions: new FakeDispositions(makeDispositionsRecord({ spans: storedSpans })),
    });
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));
    fakes.attemptRepo.withAttempt(makeAttempt(OTHER_HAND_ATTEMPT_ID));
    const useCase = new ExportRunTelemetryUseCase(deps);

    const mapped = (await useCase.execute(
      makeRequest({ selection: { kind: 'marks', targets: BOTH_HAND_ATTEMPTS } }),
    )) as Extract<ExportRunTelemetryResult, { outcome: 'dry-run' }>;
    const traceIds = [...new Set(mapped.spans.map((span) => span.traceId))];
    expect(traceIds).toHaveLength(2);
    const firstSpan = mapped.spans.find((span) => span.traceId === traceIds[0]) as TelemetrySpan;
    const secondSpan = mapped.spans.find((span) => span.traceId === traceIds[1]) as TelemetrySpan;
    storedSpans[traceIds[0]] = { [firstSpan.spanId]: 'exported@collector' };
    storedSpans[traceIds[1]] = { [secondSpan.spanId]: 'rejected:invalid' };

    const skipped = (await useCase.execute(
      makeRequest({ selection: { kind: 'marks', targets: BOTH_HAND_ATTEMPTS } }),
    )) as Extract<ExportRunTelemetryResult, { outcome: 'dry-run' }>;
    expect(skipped.counts.alreadyFinal).toBe(2);
    expect(skipped.counts.toSend).toBe(2);

    const retried = (await useCase.execute(
      makeRequest({ selection: { kind: 'marks', targets: BOTH_HAND_ATTEMPTS }, retryRejected: true }),
    )) as Extract<ExportRunTelemetryResult, { outcome: 'dry-run' }>;
    expect(retried.counts.alreadyFinal).toBe(1);
    expect(retried.spans.some((span) => span.spanId === secondSpan.spanId)).toBe(true);
  });
});

describe('ExportRunTelemetryUseCase salt check (OT2c-1, §3.5)', () => {
  it('a store fingerprint that differs from ours refuses before any read or mapping', async () => {
    const { deps, fakes } = makeDeps({
      dispositions: new FakeDispositions(
        makeDispositionsRecord({ saltFingerprint: telemetrySaltFingerprint(otherHmac) }),
      ),
    });
    fakes.runRepo.withRun(makeRun({ attemptIds: [ATTEMPT_ID] }));
    fakes.attemptRepo.withAttempt(
      makeAttempt(ATTEMPT_ID, {
        artifacts: { headCommit: HEAD_COMMIT, commitsSinceBase: [], collectedArtifactPaths: [], notes: 'present' },
      }),
    );
    fakes.journal.withEntries(RUN_ID, mergedJournal(RUN_ID));

    const result = asRefused(await new ExportRunTelemetryUseCase(deps).execute(makeRequest()));

    expect(result.reason).toBe('salt-mismatch');
    expect(result.counters).toEqual({ 'salt-mismatch': 1 });
    expect(result.counts).toEqual(zeroCounts());
    expect(fakes.receipts.calls).toHaveLength(0);
    expect(fakes.telemetry.sendCalls).toBe(0);
    expect(fakes.dispositions.writeCalls).toBe(0);
  });
});

describe('ExportRunTelemetryUseCase fail-closed refusals (OT2c-1)', () => {
  it('an unreadable store refuses store-unreadable', async () => {
    const { deps, fakes } = makeDeps();
    fakes.runRepo.withRun(makeRun());
    fakes.journal.withEntries(RUN_ID, mergedJournal(RUN_ID));
    fakes.dispositions.mode = 'unreadable';

    const result = asRefused(await new ExportRunTelemetryUseCase(deps).execute(makeRequest()));

    expect(result.reason).toBe('store-unreadable');
    expect(fakes.telemetry.sendCalls).toBe(0);
  });

  it('a throwing store read refuses store-error', async () => {
    const { deps, fakes } = makeDeps();
    fakes.runRepo.withRun(makeRun());
    fakes.journal.withEntries(RUN_ID, mergedJournal(RUN_ID));
    fakes.dispositions.mode = 'throw';

    const result = asRefused(await new ExportRunTelemetryUseCase(deps).execute(makeRequest()));

    expect(result.reason).toBe('store-error');
    expect(fakes.telemetry.sendCalls).toBe(0);
  });

  it('a throwing repository read refuses read-error', async () => {
    const { deps, fakes } = makeDeps();
    fakes.runRepo.listThrows = true;

    const result = asRefused(
      await new ExportRunTelemetryUseCase(deps).execute(
        makeRequest({ selection: { kind: 'work-order', workOrderId: WORK_ORDER_ID } }),
      ),
    );

    expect(result.reason).toBe('read-error');
    expect(fakes.telemetry.sendCalls).toBe(0);
    expect(fakes.dispositions.writeCalls).toBe(0);
  });

  it('an unavailable receipt read refuses read-error', async () => {
    const { deps, fakes } = makeDeps();
    fakes.runRepo.withRun(makeRun({ attemptIds: [ATTEMPT_ID] }));
    fakes.attemptRepo.withAttempt(
      makeAttempt(ATTEMPT_ID, {
        artifacts: { headCommit: HEAD_COMMIT, commitsSinceBase: [], collectedArtifactPaths: [], notes: 'present' },
      }),
    );
    fakes.journal.withEntries(RUN_ID, mergedJournal(RUN_ID));
    fakes.receipts.outcome = 'unavailable';

    const result = asRefused(await new ExportRunTelemetryUseCase(deps).execute(makeRequest()));

    expect(result.reason).toBe('read-error');
    expect(fakes.telemetry.sendCalls).toBe(0);
    expect(fakes.dispositions.writeCalls).toBe(0);
  });

  it('a receipt with an invalid completedAtIso is dropped and counted', async () => {
    const { deps, fakes } = makeDeps();
    fakes.attemptRepo.withAttempt(
      makeAttempt(HAND_ATTEMPT_ID, {
        artifacts: { headCommit: HEAD_COMMIT, commitsSinceBase: [], collectedArtifactPaths: [], notes: 'present' },
      }),
    );
    fakes.receipts.outcome = 'found';
    fakes.receipts.verification = [
      {
        receiptId: asHashInput('example-receipt-id'),
        result: 'pass',
        exitCode: 0,
        completedAtIso: '2026-10-29 10:00:00',
      },
    ];

    const result = (await new ExportRunTelemetryUseCase(deps).execute(
      makeRequest({ selection: { kind: 'attempt', attemptId: HAND_ATTEMPT_ID } }),
    )) as Extract<ExportRunTelemetryResult, { outcome: 'dry-run' }>;

    expect(result.counts.receiptsDropped).toBe(1);
    expect(result.spans.some((span) => span.name === 'gate')).toBe(false);
  });
});

describe('ExportRunTelemetryUseCase outcomes (OT2c-1)', () => {
  it('a dry-run returns the spans and calls neither send nor write', async () => {
    const { deps, fakes } = makeDeps();
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));

    const result = (await new ExportRunTelemetryUseCase(deps).execute(
      makeRequest({ selection: { kind: 'attempt', attemptId: HAND_ATTEMPT_ID } }),
    )) as Extract<ExportRunTelemetryResult, { outcome: 'dry-run' }>;

    expect(result.outcome).toBe('dry-run');
    expect(result.spans).toHaveLength(2);
    expect(fakes.telemetry.sendCalls).toBe(0);
    expect(fakes.dispositions.writeCalls).toBe(0);
  });

  it('a send in this lane returns exported without sending or writing (OT2c-2 hook)', async () => {
    const { deps, fakes } = makeDeps();
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));

    const result = await new ExportRunTelemetryUseCase(deps).execute(
      makeRequest({ selection: { kind: 'attempt', attemptId: HAND_ATTEMPT_ID }, mode: 'send' }),
    );

    expect(result).toEqual({
      outcome: 'exported',
      counts: { ...zeroCounts(), attemptsSelected: 1, spansMapped: 2, toSend: 2 },
      errorKind: null,
    });
    expect(fakes.telemetry.sendCalls).toBe(0);
    expect(fakes.dispositions.writeCalls).toBe(0);
  });
});

describe('ExportRunTelemetryUseCase request validation (OT2c-1)', () => {
  const cases: Array<[string, unknown]> = [
    ['not an object', 'example-request'],
    ['an array', []],
    [
      'missing fields',
      { policy: makePolicy(), mode: 'dry-run', deadline: null, retryRejected: false, nowIso: NOW_ISO },
    ],
    ['an unknown selection kind', { ...makeRequest(), selection: { kind: 'everything' } }],
    ['an empty run id', makeRequest({ selection: { kind: 'run', runId: '' } })],
    [
      'a non-ISO sinceIso',
      makeRequest({ selection: { kind: 'window', sinceIso: 'yesterday', untilIso: null } }),
    ],
    [
      'a non-ISO untilIso',
      makeRequest({ selection: { kind: 'window', sinceIso: time(1), untilIso: 'tomorrow' } }),
    ],
    ['a sampleRatio above 1', makeRequest({ policy: makePolicy({ sampleRatio: 1.5 }) })],
    ['a sampleRatio that is not a number', makeRequest({ policy: makePolicy({ sampleRatio: 'half' }) })],
    ['an unknown route', makeRequest({ policy: makePolicy({ route: 'carrier-pigeon' }) })],
    ['a sendCost that is not a boolean', makeRequest({ policy: makePolicy({ sendCost: 'yes' }) })],
    [
      'an invalid alias',
      makeRequest({ policy: makePolicy({ projectAliases: { [PROJECT_ID]: 'Example_Alias' } }) }),
    ],
    ['an unknown mode', makeRequest({ mode: 'maybe' })],
    ['a deadline that is not null or { atMs }', makeRequest({ deadline: { at: 5 } })],
    ['a non-finite deadline', makeRequest({ deadline: { atMs: Number.POSITIVE_INFINITY } })],
    ['a retryRejected that is not a boolean', makeRequest({ retryRejected: 'yes' })],
    ['a non-ISO nowIso', makeRequest({ nowIso: 'now' })],
    [
      'a marks target that is not a target',
      makeRequest({ selection: { kind: 'marks', targets: [{ kind: 'work-order' }] } }),
    ],
  ];

  for (const [name, request] of cases) {
    it(`refuses ${name} as invalid-request`, async () => {
      const { deps, fakes } = makeDeps();
      fakes.runRepo.withRun(makeRun());
      fakes.journal.withEntries(RUN_ID, mergedJournal(RUN_ID));

      const result = await new ExportRunTelemetryUseCase(deps).execute(request);

      expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request', counts: zeroCounts(), counters: {} });
      expect(fakes.telemetry.sendCalls).toBe(0);
    });
  }
});

describe('ExportRunTelemetryUseCase redaction (OT2c-1, §3.2)', () => {
  it('the serialised result never carries a fixture id, path, branch or work-order id', async () => {
    const { deps, fakes } = makeDeps();
    fakes.runRepo.withRun(makeRun({ attemptIds: [ATTEMPT_ID] }));
    fakes.attemptRepo.withAttempt(makeAttempt(ATTEMPT_ID, { worktreePath: WORKTREE_PATH }));
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID, { worktreePath: WORKTREE_PATH }));
    fakes.journal.withEntries(RUN_ID, mergedJournal(RUN_ID));

    const result = await new ExportRunTelemetryUseCase(deps).execute(
      makeRequest({
        selection: {
          kind: 'marks',
          targets: [
            { kind: 'run', runId: RUN_ID },
            { kind: 'attempt', attemptId: HAND_ATTEMPT_ID },
          ],
        },
      }),
    );

    const serialised = JSON.stringify(result);
    for (const secret of [
      WORK_ORDER_ID,
      OTHER_WORK_ORDER_ID,
      ATTEMPT_ID,
      HAND_ATTEMPT_ID,
      OTHER_HAND_ATTEMPT_ID,
      WORKTREE_PATH,
      BRANCH_NAME,
      PROJECT_ID,
      'example-seat',
      'example-session',
      'example-task',
      'example-lane',
    ]) {
      expect(serialised).not.toContain(secret);
    }
  });
});
