/**
 * ExportRunTelemetryUseCase send-lane tests (lane OT2c-2): the pending write
 * before the send, final dispositions recorded only from a result, the killed
 * and failing export resends, the reopen write, the lock-busy and
 * salt-mismatch refusals, the counters and the counts. In-memory class fakes
 * whose methods use `this`; fixture values are `example-*`; the salt hmac
 * comes from a fixed test key. No result may carry a fixture id or value.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { ExportRunTelemetryUseCase } from '../ExportRunTelemetryUseCase.use-case.js';
import type { ExportRunTelemetryDependencies } from '../ExportRunTelemetryUseCase.use-case.js';
import type {
  ExportRunTelemetryCounts,
  ExportRunTelemetryResult,
} from '../../ports/in/ExportRunTelemetryPort.in-port.js';
import type {
  ReadReceiptsForHeadResult,
  ReviewReceiptProjection,
  VerificationReceiptProjection,
} from '../../ports/out/AcceptanceReceiptReadPort.out-port.js';
import type { RunTelemetryPort, RunTelemetrySendResult } from '../../ports/out/RunTelemetryPort.out-port.js';
import type { TelemetrySpan } from '../../../domain/run-telemetry.js';
import {
  TELEMETRY_COUNTER_KEYS,
  TELEMETRY_DISPOSITION_RECORD_VERSION,
  applyDispositionWrite,
  type TelemetryCounterKey,
  type TelemetryDispositionRecord,
  type TelemetryDispositionWriteRequest,
} from '../../../domain/run-telemetry-dispositions.js';
import type { TelemetryDispositionWriteResult } from '../../ports/out/TelemetryDispositionPort.out-port.js';
import { telemetrySaltFingerprint, type TelemetryHmac } from '../../../domain/run-telemetry-ids.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import type { AttemptRecord, WorkOrderRecord } from '../../../domain/execution-records.js';

const SALT = 'example-telemetry-salt-0123456789abcdef0123456789abcdef';
const hmac: TelemetryHmac = (message) => createHmac('sha256', SALT).update(message, 'utf8').digest();

const RUN_ID = 'run-01JB0000000000000000000000';
const WORK_ORDER_ID = 'example-work-order-1';
const PROJECT_ID = 'example-project';
const ATTEMPT_ID = 'example-attempt-1';
const HAND_ATTEMPT_ID = 'example-hand-attempt-1';
const OTHER_HAND_ATTEMPT_ID = 'example-hand-attempt-2';
const BRANCH_NAME = 'example-branch';
const WORKTREE_PATH = '/example/worktree/path';
const HEAD_COMMIT = 'a'.repeat(40);
const NOW_ISO = '2026-10-29T10:05:00.000Z';
const UNKNOWN_SPAN_ID = 'unknown-span-id-not-sent';

function time(second: number): string {
  return `2026-10-29T10:00:${String(second).padStart(2, '0')}.000Z`;
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

  withRun(run: LaneRunRecord): this {
    this.runs.set(run.runId, run);
    return this;
  }

  async get(runId: string): Promise<LaneRunRecord | null> {
    return this.runs.get(runId) ?? null;
  }

  async list(): Promise<readonly LaneRunRecord[]> {
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
  outcome: 'found' | 'none' | 'unavailable' = 'none';
  verification: VerificationReceiptProjection[] = [];
  review: ReviewReceiptProjection[] = [];

  async readReceiptsForHead(attemptId: string, headSha: string): Promise<ReadReceiptsForHeadResult> {
    void attemptId;
    void headSha;
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
  writeRequests: TelemetryDispositionWriteRequest[] = [];
  /** Scripted results for the next write calls; a throw when scripted so. */
  writeScript: Array<TelemetryDispositionWriteResult | 'throw'> = [];

  constructor(private record: TelemetryDispositionRecord) {}

  async read(): Promise<{ outcome: 'read'; record: TelemetryDispositionRecord } | { outcome: 'unreadable' }> {
    return { outcome: 'read', record: this.record };
  }

  async write(request: TelemetryDispositionWriteRequest): Promise<TelemetryDispositionWriteResult> {
    this.writeCalls += 1;
    this.writeRequests.push(request);
    const scripted = this.writeScript.shift();
    if (scripted === 'throw') {
      throw new Error('example-store-failure');
    }
    if (scripted !== undefined && scripted.outcome !== 'written') {
      return scripted;
    }
    const applied = applyDispositionWrite(this.record, request);
    if (applied.outcome === 'refused') {
      return { outcome: 'refused', reason: applied.reason };
    }
    this.record = applied.record;
    return scripted ?? { outcome: 'written', applied: applied.applied, kept: applied.kept };
  }

  /** A deep copy of the current record, for byte-identical comparisons. */
  snapshot(): TelemetryDispositionRecord {
    return JSON.parse(JSON.stringify(this.record)) as TelemetryDispositionRecord;
  }
}

type SendBehavior = 'export' | 'reject' | 'pending' | 'throw' | 'never' | 'partial' | 'unknown' | 'error-pending';

class FakeTelemetry implements Pick<RunTelemetryPort, 'send'> {
  sendCalls = 0;
  sentSpans: TelemetrySpan[][] = [];
  /** Set by the test: a snapshot of the store taken at send time. */
  probe: (() => TelemetryDispositionRecord | null) | null = null;
  storeAtSend: Array<TelemetryDispositionRecord | null> = [];
  behavior: SendBehavior = 'export';
  /** Set by a test: the raw value send returns, bypassing `behavior` (hostile results). */
  custom: ((spans: readonly TelemetrySpan[]) => unknown) | null = null;

  async send(spans: readonly TelemetrySpan[], _deadline: { readonly atMs: number } | null): Promise<RunTelemetrySendResult> {
    this.sendCalls += 1;
    this.sentSpans.push([...spans]);
    this.storeAtSend.push(this.probe === null ? null : this.probe());
    if (this.custom !== null) {
      return this.custom(spans) as RunTelemetrySendResult;
    }
    switch (this.behavior) {
      case 'export':
        return {
          dispositions: spans.map((span) => ({ spanId: span.spanId, disposition: { state: 'exported', route: 'collector' } })),
          errorKind: null,
        };
      case 'reject':
        return {
          dispositions: spans.map((span) => ({ spanId: span.spanId, disposition: { state: 'rejected', reason: 'http-4xx' } })),
          errorKind: null,
        };
      case 'pending':
        return {
          dispositions: spans.map((span) => ({ spanId: span.spanId, disposition: { state: 'pending' } })),
          errorKind: null,
        };
      case 'throw':
        throw new Error('example-send-failure');
      case 'never':
        return new Promise<RunTelemetrySendResult>(() => {});
      case 'partial': {
        const [first, ...rest] = spans;
        return {
          dispositions: [
            { spanId: first!.spanId, disposition: { state: 'exported', route: 'collector' } as const },
            ...rest.map((span) => ({ spanId: span.spanId, disposition: { state: 'pending' } as const })),
          ],
          errorKind: 'partial',
        };
      }
      case 'unknown': {
        const dispositions = spans.map((span) => ({ spanId: span.spanId, disposition: { state: 'exported', route: 'collector' } as const }));
        dispositions.push({ spanId: UNKNOWN_SPAN_ID, disposition: { state: 'exported', route: 'collector' } });
        return { dispositions, errorKind: null };
      }
      case 'error-pending':
        return {
          dispositions: spans.map((span) => ({ spanId: span.spanId, disposition: { state: 'pending' } })),
          errorKind: 'timeout',
        };
    }
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

function makeDeps(
  dispositionsRecord: TelemetryDispositionRecord = makeDispositionsRecord(),
): { deps: ExportRunTelemetryDependencies; fakes: Fakes } {
  const fakes: Fakes = {
    runRepo: new FakeRunRepository(),
    journal: new FakeJournal(),
    attemptRepo: new FakeAttemptRepository(),
    workOrderRepo: new FakeWorkOrderRepository().withWorkOrder(makeWorkOrder()),
    receipts: new FakeReceipts(),
    dispositions: new FakeDispositions(dispositionsRecord),
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
  };
  fakes.telemetry.probe = () => fakes.dispositions.snapshot();
  return { deps, fakes };
}

function makePolicy(): Record<string, unknown> {
  return {
    route: 'collector',
    sampleRatio: 1,
    sendCost: true,
    includeDryRun: true,
    projectAliases: { [PROJECT_ID]: 'example-alias' },
  };
}

function makeRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    selection: { kind: 'attempt', attemptId: HAND_ATTEMPT_ID },
    policy: makePolicy(),
    mode: 'send',
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

function asExported(result: ExportRunTelemetryResult): Extract<ExportRunTelemetryResult, { outcome: 'exported' }> {
  expect(result.outcome).toBe('exported');
  return result as Extract<ExportRunTelemetryResult, { outcome: 'exported' }>;
}

function asRefused(result: ExportRunTelemetryResult): Extract<ExportRunTelemetryResult, { outcome: 'refused' }> {
  expect(result.outcome).toBe('refused');
  return result as Extract<ExportRunTelemetryResult, { outcome: 'refused' }>;
}

/** The stored disposition text per span id, flattened across traces. */
function spanTexts(record: TelemetryDispositionRecord): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of Object.values(record.spans)) {
    for (const [spanId, text] of Object.entries(entry)) {
      out.set(spanId, text);
    }
  }
  return out;
}

/** The two spans the hand attempt maps, read from a dry-run (deterministic hmac). */
async function handAttemptSpanIds(deps: ExportRunTelemetryDependencies): Promise<TelemetrySpan[]> {
  const dry = (await new ExportRunTelemetryUseCase(deps).execute(makeRequest({ mode: 'dry-run' }))) as Extract<
    ExportRunTelemetryResult,
    { outcome: 'dry-run' }
  >;
  expect(dry.outcome).toBe('dry-run');
  return [...dry.spans];
}

describe('ExportRunTelemetryUseCase send: pending before send (OT2c-2)', () => {
  it('writes the spans pending with our fingerprint and the request nowIso before send is called', async () => {
    const { deps, fakes } = makeDeps();
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));

    const result = asExported(await new ExportRunTelemetryUseCase(deps).execute(makeRequest()));

    expect(fakes.telemetry.sendCalls).toBe(1);
    expect(fakes.dispositions.writeCalls).toBe(2);
    const [pendingRequest] = fakes.dispositions.writeRequests;
    expect(pendingRequest?.saltFingerprint).toBe(telemetrySaltFingerprint(hmac));
    expect(pendingRequest?.nowIso).toBe(NOW_ISO);
    expect(pendingRequest?.reopen).toBeUndefined();
    expect(pendingRequest?.counters).toBeUndefined();
    expect(pendingRequest?.exportedAt).toBeUndefined();
    // The store already held the spans as pending when send was called.
    const atSend = fakes.telemetry.storeAtSend[0];
    expect(atSend).not.toBeNull();
    const textsAtSend = spanTexts(atSend as TelemetryDispositionRecord);
    for (const span of fakes.telemetry.sentSpans[0] ?? []) {
      expect(textsAtSend.get(span.spanId)).toBe('pending');
    }
    expect(textsAtSend.size).toBe((fakes.telemetry.sentSpans[0] ?? []).length);

    expect(result).toEqual({
      outcome: 'exported',
      counts: { ...zeroCounts(), attemptsSelected: 1, spansMapped: 2, toSend: 2, exported: 2 },
      errorKind: null,
    });
  });

  it('a 2xx-equivalent result records exported@collector and sets lastExportAtIso', async () => {
    const { deps, fakes } = makeDeps();
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));

    await new ExportRunTelemetryUseCase(deps).execute(makeRequest());

    const texts = spanTexts(fakes.dispositions.snapshot());
    expect(texts.size).toBe(2);
    for (const text of texts.values()) {
      expect(text).toBe('exported@collector');
    }
    expect(fakes.dispositions.snapshot().lastExportAtIso).toBe(NOW_ISO);
  });

  it('a rejected result records rejected:http-4xx without touching counters or lastExportAtIso', async () => {
    const { deps, fakes } = makeDeps();
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));
    fakes.telemetry.behavior = 'reject';

    const result = asExported(await new ExportRunTelemetryUseCase(deps).execute(makeRequest()));

    expect(result.counts.rejected).toBe(2);
    expect(result.counts.pending).toBe(0);
    expect(result.errorKind).toBeNull();
    const record = fakes.dispositions.snapshot();
    for (const text of spanTexts(record).values()) {
      expect(text).toBe('rejected:http-4xx');
    }
    for (const key of TELEMETRY_COUNTER_KEYS) {
      expect(record.counters[key]).toBe(0);
    }
    expect(record.lastExportAtIso).toBeNull();
  });

  it('a pending result stays pending and never reaches the store as final', async () => {
    const { deps, fakes } = makeDeps();
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));
    fakes.telemetry.behavior = 'pending';

    const result = asExported(await new ExportRunTelemetryUseCase(deps).execute(makeRequest()));

    expect(result.counts).toEqual({ ...zeroCounts(), attemptsSelected: 1, spansMapped: 2, toSend: 2, pending: 2 });
    expect(result.errorKind).toBeNull();
    const record = fakes.dispositions.snapshot();
    for (const text of spanTexts(record).values()) {
      expect(text).toBe('pending');
    }
    expect(record.lastExportAtIso).toBeNull();
    expect(fakes.dispositions.writeCalls).toBe(1);
  });
});

describe('ExportRunTelemetryUseCase send: killed export (OT2c-2)', () => {
  it('a send that never resolves leaves the spans pending and the next export resends exactly them', async () => {
    const { deps, fakes } = makeDeps();
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));
    const useCase = new ExportRunTelemetryUseCase(deps);
    const sentSpans = await handAttemptSpanIds(deps);

    // The first export starts and dies (the send never resolves; the test abandons it).
    fakes.telemetry.behavior = 'never';
    void useCase.execute(makeRequest());
    await new Promise((resolve) => setTimeout(resolve, 5));

    const afterKill = spanTexts(fakes.dispositions.snapshot());
    expect(afterKill.size).toBe(2);
    for (const span of sentSpans) {
      expect(afterKill.get(span.spanId)).toBe('pending');
    }

    // The second export exports exactly those spans and nothing more.
    fakes.telemetry.behavior = 'export';
    const second = asExported(await useCase.execute(makeRequest()));
    expect(second.counts.exported).toBe(2);
    expect(fakes.telemetry.sentSpans[1]?.map((span) => span.spanId).sort()).toEqual(
      sentSpans.map((span) => span.spanId).sort(),
    );
    const after = spanTexts(fakes.dispositions.snapshot());
    expect(after.size).toBe(2);
    for (const text of after.values()) {
      expect(text).toBe('exported@collector');
    }
  });

  it('a throwing send port leaves every span pending and the store otherwise byte-identical', async () => {
    const otherTraceId = 'a'.repeat(32);
    const otherSpanId = 'b'.repeat(16);
    const before: Record<string, Record<string, string>> = {
      [otherTraceId]: { [otherSpanId]: 'exported@phoenix' },
    };
    const { deps, fakes } = makeDeps(makeDispositionsRecord({ spans: before }));
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));
    const sentSpans = await handAttemptSpanIds(deps);
    const beforeSnapshot = fakes.dispositions.snapshot();

    fakes.telemetry.behavior = 'throw';
    const result = asExported(await new ExportRunTelemetryUseCase(deps).execute(makeRequest()));

    expect(result.errorKind).toBe('network');
    expect(result.counts.pending).toBe(2);
    expect(result.counts.exported).toBe(0);
    expect(result.counts.rejected).toBe(0);
    // Only the pending write happened; nothing else was written.
    expect(fakes.dispositions.writeCalls).toBe(1);
    const after = fakes.dispositions.snapshot();
    // The other spans are byte-identical.
    expect(after.spans[otherTraceId]).toEqual(before[otherTraceId]);
    // Counters and lastExportAtIso are byte-identical to before.
    expect(after.counters).toEqual(beforeSnapshot.counters);
    expect(after.lastExportAtIso).toBe(beforeSnapshot.lastExportAtIso);
    // Every span we sent is pending.
    const texts = spanTexts(after);
    for (const span of sentSpans) {
      expect(texts.get(span.spanId)).toBe('pending');
    }
  });
});

describe('ExportRunTelemetryUseCase send: store refusals (OT2c-2)', () => {
  it('a lock-busy pending write sends nothing', async () => {
    const { deps, fakes } = makeDeps();
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));
    fakes.dispositions.writeScript = [{ outcome: 'skipped', reason: 'lock-busy' }];

    const result = asExported(await new ExportRunTelemetryUseCase(deps).execute(makeRequest()));

    expect(fakes.telemetry.sendCalls).toBe(0);
    expect(fakes.dispositions.writeCalls).toBe(1);
    expect(result.counts).toEqual({ ...zeroCounts(), attemptsSelected: 1, spansMapped: 2, toSend: 2, refusedByStore: 2 });
    expect(result.errorKind).toBeNull();
    expect(spanTexts(fakes.dispositions.snapshot()).size).toBe(0);
  });

  it('a lock-busy result write leaves the spans pending and the next export resends them', async () => {
    const { deps, fakes } = makeDeps();
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));
    fakes.dispositions.writeScript = [{ outcome: 'written', applied: 2, kept: 0 }, { outcome: 'skipped', reason: 'lock-busy' }];

    const result = asExported(await new ExportRunTelemetryUseCase(deps).execute(makeRequest()));

    expect(fakes.telemetry.sendCalls).toBe(1);
    expect(fakes.dispositions.writeCalls).toBe(2);
    expect(result.counts.exported).toBe(2);
    expect(result.counts.pending).toBe(2);
    expect(result.counts.refusedByStore).toBe(2);
    expect(result.errorKind).toBeNull();
    const afterFirst = spanTexts(fakes.dispositions.snapshot());
    expect(afterFirst.size).toBe(2);
    for (const text of afterFirst.values()) {
      expect(text).toBe('pending');
    }

    // The next export resends them and records the finals.
    fakes.dispositions.writeScript = [];
    const second = asExported(await new ExportRunTelemetryUseCase(deps).execute(makeRequest()));
    expect(second.counts.exported).toBe(2);
    const after = spanTexts(fakes.dispositions.snapshot());
    expect(after.size).toBe(2);
    for (const text of after.values()) {
      expect(text).toBe('exported@collector');
    }
  });

  it('a salt-mismatch refusal on the pending write is reported with the salt-mismatch counter', async () => {
    const { deps, fakes } = makeDeps();
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));
    fakes.dispositions.writeScript = [{ outcome: 'refused', reason: 'salt-mismatch' }];

    const result = asRefused(await new ExportRunTelemetryUseCase(deps).execute(makeRequest()));

    expect(result.reason).toBe('salt-mismatch');
    expect(result.counters).toEqual({ 'salt-mismatch': 1 });
    expect(fakes.telemetry.sendCalls).toBe(0);
    expect(fakes.dispositions.writeCalls).toBe(1);
  });

  it('a throwing store write on the pending write refuses store-error', async () => {
    const { deps, fakes } = makeDeps();
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));
    fakes.dispositions.writeScript = ['throw'];

    const result = asRefused(await new ExportRunTelemetryUseCase(deps).execute(makeRequest()));

    expect(result.reason).toBe('store-error');
    expect(fakes.telemetry.sendCalls).toBe(0);
    expect(fakes.dispositions.writeCalls).toBe(1);
  });

  it('a salt-mismatch refusal on the result write refuses with the salt-mismatch counter', async () => {
    const { deps, fakes } = makeDeps();
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));
    fakes.dispositions.writeScript = [
      { outcome: 'written', applied: 2, kept: 0 },
      { outcome: 'refused', reason: 'salt-mismatch' },
    ];

    const result = asRefused(await new ExportRunTelemetryUseCase(deps).execute(makeRequest()));

    expect(result.reason).toBe('salt-mismatch');
    expect(result.counters).toEqual({ 'salt-mismatch': 1 });
    expect(result.counts.exported).toBe(2);
    expect(result.counts.pending).toBe(2);
    expect(result.counts.refusedByStore).toBe(2);
    expect(fakes.telemetry.sendCalls).toBe(1);
    expect(fakes.dispositions.writeCalls).toBe(2);
  });

  it('a store-unreadable refusal on the result write refuses store-unreadable', async () => {
    const { deps, fakes } = makeDeps();
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));
    fakes.dispositions.writeScript = [
      { outcome: 'written', applied: 2, kept: 0 },
      { outcome: 'refused', reason: 'store-unreadable' },
    ];

    const result = asRefused(await new ExportRunTelemetryUseCase(deps).execute(makeRequest()));

    expect(result.reason).toBe('store-unreadable');
    expect(result.counters).toEqual({});
    expect(result.counts.exported).toBe(2);
    expect(result.counts.pending).toBe(2);
    expect(result.counts.refusedByStore).toBe(2);
    expect(fakes.telemetry.sendCalls).toBe(1);
    expect(fakes.dispositions.writeCalls).toBe(2);
  });
});

describe('ExportRunTelemetryUseCase send: retryRejected reopen (OT2c-2)', () => {
  it('with retryRejected the rejected spans are reopened, resent and recorded', async () => {
    const { deps, fakes } = makeDeps();
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));
    const sentSpans = await handAttemptSpanIds(deps);
    const [first, second] = sentSpans;
    const { deps: seededDeps, fakes: seededFakes } = makeDeps(
      makeDispositionsRecord({ spans: { [first!.traceId]: { [second!.spanId]: 'rejected:http-4xx' } } }),
    );
    seededFakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));

    const result = asExported(await new ExportRunTelemetryUseCase(seededDeps).execute(makeRequest({ retryRejected: true })));

    // Three writes: the reopen, the pending write and the result write.
    expect(seededFakes.dispositions.writeCalls).toBe(3);
    const [reopenRequest] = seededFakes.dispositions.writeRequests;
    expect(reopenRequest?.reopen).toBe(true);
    expect(reopenRequest?.updates.map((update) => update.spanId)).toEqual([second!.spanId]);
    expect(reopenRequest?.updates.every((update) => update.disposition.state === 'pending')).toBe(true);
    const after = spanTexts(seededFakes.dispositions.snapshot());
    expect(after.size).toBe(2);
    for (const text of after.values()) {
      expect(text).toBe('exported@collector');
    }
    expect(result.counts.exported).toBe(2);
    expect(result.counts.alreadyFinal).toBe(0);
  });

  it('without retryRejected the rejected span stays rejected and unsent', async () => {
    const { deps, fakes } = makeDeps();
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));
    const sentSpans = await handAttemptSpanIds(deps);
    const [first, second] = sentSpans;
    const { deps: seededDeps, fakes: seededFakes } = makeDeps(
      makeDispositionsRecord({ spans: { [first!.traceId]: { [second!.spanId]: 'rejected:http-4xx' } } }),
    );
    seededFakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));

    const result = asExported(await new ExportRunTelemetryUseCase(seededDeps).execute(makeRequest()));

    expect(result.counts.alreadyFinal).toBe(1);
    expect(result.counts.toSend).toBe(1);
    expect(seededFakes.telemetry.sendCalls).toBe(1);
    expect(seededFakes.telemetry.sentSpans[0]?.map((span) => span.spanId)).toEqual([first!.spanId]);
    const after = spanTexts(seededFakes.dispositions.snapshot());
    expect(after.get(second!.spanId)).toBe('rejected:http-4xx');
    expect(after.get(first!.spanId)).toBe('exported@collector');
    // Two writes: the pending write and the result write; no reopen.
    expect(seededFakes.dispositions.writeCalls).toBe(2);
    expect(seededFakes.dispositions.writeRequests[0]?.reopen).toBeUndefined();
  });

  it('a lock-busy reopen write keeps the rejected spans rejected and counts refusedByStore', async () => {
    const { deps, fakes } = makeDeps();
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));
    const sentSpans = await handAttemptSpanIds(deps);
    const [first, second] = sentSpans;
    const { deps: seededDeps, fakes: seededFakes } = makeDeps(
      makeDispositionsRecord({ spans: { [first!.traceId]: { [second!.spanId]: 'rejected:http-4xx' } } }),
    );
    seededFakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));
    seededFakes.dispositions.writeScript = [{ outcome: 'skipped', reason: 'lock-busy' }];

    const result = asExported(await new ExportRunTelemetryUseCase(seededDeps).execute(makeRequest({ retryRejected: true })));

    expect(result.counts.refusedByStore).toBe(1);
    expect(result.errorKind).toBeNull();
    expect(seededFakes.telemetry.sendCalls).toBe(0);
    expect(seededFakes.dispositions.writeCalls).toBe(1);
    const after = spanTexts(seededFakes.dispositions.snapshot());
    expect(after.get(second!.spanId)).toBe('rejected:http-4xx');
  });

  it('a salt-mismatch refusal on the reopen write refuses with the salt-mismatch counter', async () => {
    const { deps, fakes } = makeDeps();
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));
    const sentSpans = await handAttemptSpanIds(deps);
    const [first, second] = sentSpans;
    const { deps: seededDeps, fakes: seededFakes } = makeDeps(
      makeDispositionsRecord({ spans: { [first!.traceId]: { [second!.spanId]: 'rejected:http-4xx' } } }),
    );
    seededFakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));
    seededFakes.dispositions.writeScript = [{ outcome: 'refused', reason: 'salt-mismatch' }];

    const result = asRefused(await new ExportRunTelemetryUseCase(seededDeps).execute(makeRequest({ retryRejected: true })));

    expect(result.reason).toBe('salt-mismatch');
    expect(result.counters).toEqual({ 'salt-mismatch': 1 });
    expect(seededFakes.telemetry.sendCalls).toBe(0);
    expect(seededFakes.dispositions.writeCalls).toBe(1);
  });

  it('a throwing reopen write refuses store-error', async () => {
    const { deps, fakes } = makeDeps();
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));
    const sentSpans = await handAttemptSpanIds(deps);
    const [first, second] = sentSpans;
    const { deps: seededDeps, fakes: seededFakes } = makeDeps(
      makeDispositionsRecord({ spans: { [first!.traceId]: { [second!.spanId]: 'rejected:http-4xx' } } }),
    );
    seededFakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));
    seededFakes.dispositions.writeScript = ['throw'];

    const result = asRefused(await new ExportRunTelemetryUseCase(seededDeps).execute(makeRequest({ retryRejected: true })));

    expect(result.reason).toBe('store-error');
    expect(result.counters).toEqual({});
    expect(seededFakes.telemetry.sendCalls).toBe(0);
    expect(seededFakes.dispositions.writeCalls).toBe(1);
  });
});

describe('ExportRunTelemetryUseCase send: counters and unknown ids (OT2c-2)', () => {
  it('an errorKind from send is added to the store counters and exportedAt only when something exported', async () => {
    const { deps, fakes } = makeDeps();
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));
    fakes.telemetry.behavior = 'partial';

    const result = asExported(await new ExportRunTelemetryUseCase(deps).execute(makeRequest()));

    expect(result.counts.exported).toBe(1);
    expect(result.counts.pending).toBe(1);
    expect(result.errorKind).toBe('partial');
    const record = fakes.dispositions.snapshot();
    expect(record.counters['partial']).toBe(1);
    expect(record.lastExportAtIso).toBe(NOW_ISO);
    const texts = spanTexts(record);
    const values = [...texts.values()];
    expect(values).toContain('exported@collector');
    expect(values).toContain('pending');
  });

  it('dispositions for span ids that were not sent are ignored and counted nowhere', async () => {
    const { deps, fakes } = makeDeps();
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));
    fakes.telemetry.behavior = 'unknown';

    const result = asExported(await new ExportRunTelemetryUseCase(deps).execute(makeRequest()));

    expect(result.counts.exported).toBe(2);
    const texts = spanTexts(fakes.dispositions.snapshot());
    expect(texts.size).toBe(2);
    expect(texts.has(UNKNOWN_SPAN_ID)).toBe(false);
  });

  it('a stopping failure with every span pending still records the error-kind counter and no export time', async () => {
    const { deps, fakes } = makeDeps();
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));
    fakes.telemetry.behavior = 'error-pending';

    const result = asExported(await new ExportRunTelemetryUseCase(deps).execute(makeRequest()));

    expect(result.errorKind).toBe('timeout');
    expect(result.counts.pending).toBe(2);
    expect(result.counts.exported).toBe(0);
    expect(result.counts.rejected).toBe(0);
    // Two writes: the pending write and the counter-only write with no updates.
    expect(fakes.dispositions.writeCalls).toBe(2);
    const record = fakes.dispositions.snapshot();
    expect(record.counters['timeout']).toBe(1);
    expect(record.lastExportAtIso).toBeNull();
    const texts = spanTexts(record);
    for (const text of texts.values()) {
      expect(text).toBe('pending');
    }
  });
});

describe('ExportRunTelemetryUseCase send: dry-run and redaction (OT2c-2)', () => {
  it('a dry-run still writes nothing and sends nothing', async () => {
    const { deps, fakes } = makeDeps();
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));

    const result = await new ExportRunTelemetryUseCase(deps).execute(makeRequest({ mode: 'dry-run' }));

    expect(result.outcome).toBe('dry-run');
    expect(result.counts.toSend).toBe(2);
    expect(fakes.telemetry.sendCalls).toBe(0);
    expect(fakes.dispositions.writeCalls).toBe(0);
  });

  it('a request field behind a getter is refused without ever calling the getter (OT2c-1 Luna)', async () => {
    const { deps, fakes } = makeDeps();
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));
    const request = makeRequest() as Record<string, unknown>;
    let getterCalled = false;
    Object.defineProperty(request, 'mode', {
      enumerable: true,
      get() {
        getterCalled = true;
        return 'send';
      },
    });

    const result = await new ExportRunTelemetryUseCase(deps).execute(request);

    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request', counts: zeroCounts(), counters: {} });
    expect(getterCalled).toBe(false);
    expect(fakes.telemetry.sendCalls).toBe(0);
    expect(fakes.dispositions.writeCalls).toBe(0);
  });

  it('a throwing getter reads as invalid-request and execute never rejects (OT2c-1 Luna)', async () => {
    const { deps, fakes } = makeDeps();
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));
    const request = makeRequest() as Record<string, unknown>;
    Object.defineProperty(request, 'nowIso', {
      enumerable: true,
      get() {
        throw new Error('example-getter-failure');
      },
    });

    const result = await new ExportRunTelemetryUseCase(deps).execute(request);

    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request', counts: zeroCounts(), counters: {} });
    expect(fakes.telemetry.sendCalls).toBe(0);
    expect(fakes.dispositions.writeCalls).toBe(0);
  });

  it('the serialised send result never carries a fixture id or value', async () => {
    const { deps, fakes } = makeDeps();
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));

    const exported = await new ExportRunTelemetryUseCase(deps).execute(makeRequest());

    fakes.dispositions.writeScript = [{ outcome: 'refused', reason: 'salt-mismatch' }];
    const saltRefused = await new ExportRunTelemetryUseCase(deps).execute(makeRequest());

    const serialised = JSON.stringify([exported, saltRefused]);
    for (const secret of [
      WORK_ORDER_ID,
      ATTEMPT_ID,
      HAND_ATTEMPT_ID,
      OTHER_HAND_ATTEMPT_ID,
      WORKTREE_PATH,
      BRANCH_NAME,
      PROJECT_ID,
      RUN_ID,
      'example-seat',
      'example-session',
      'example-task',
      'example-lane',
      UNKNOWN_SPAN_ID,
    ]) {
      expect(serialised).not.toContain(secret);
    }
  });
});

describe('ExportRunTelemetryUseCase never rejects on hostile inputs (OT2c-2 Argon round 2)', () => {
  async function runWith(custom: (spans: readonly TelemetrySpan[]) => unknown) {
    const { deps, fakes } = makeDeps();
    fakes.attemptRepo.withAttempt(makeAttempt(HAND_ATTEMPT_ID));
    const sentSpans = await handAttemptSpanIds(deps);
    fakes.telemetry.custom = custom;
    const result = await new ExportRunTelemetryUseCase(deps).execute(makeRequest());
    return { result, fakes, sentSpans };
  }

  it('a send result whose fields are getters never runs them and leaves every span pending', async () => {
    let getterRan = false;
    const { result, fakes, sentSpans } = await runWith(() => ({
      get dispositions() {
        getterRan = true;
        return [];
      },
      errorKind: null,
    }));
    expect(getterRan).toBe(false);
    const exported = asExported(result);
    expect(exported.errorKind).toBe('network');
    expect(exported.counts.pending).toBe(sentSpans.length);
    const texts = spanTexts(fakes.dispositions.snapshot());
    for (const span of sentSpans) {
      expect(texts.get(span.spanId)).toBe('pending');
    }
  });

  it('a revoked proxy as the send result, an entry getter, or an unknown error kind each leave every span pending', async () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const results: unknown[] = [];
    for (const custom of [
      () => revoked.proxy,
      (spans: readonly TelemetrySpan[]) => ({
        dispositions: spans.map((span) => ({
          spanId: span.spanId,
          get disposition() {
            throw new Error('hostile entry');
          },
        })),
        errorKind: null,
      }),
      (spans: readonly TelemetrySpan[]) => ({
        dispositions: spans.map((span) => ({ spanId: span.spanId, disposition: { state: 'exported', route: 'collector' } })),
        errorKind: 'not-a-declared-kind',
      }),
    ]) {
      const { result, sentSpans } = await runWith(custom);
      const exported = asExported(result);
      expect(exported.errorKind).toBe('network');
      expect(exported.counts.pending).toBe(sentSpans.length);
      expect(exported.counts.exported).toBe(0);
      results.push(result);
    }
    expect(results).toHaveLength(3);
  });

  it('a revoked proxy as the request resolves to an invalid-request refusal, never a rejection', async () => {
    const { deps } = makeDeps();
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const result = await new ExportRunTelemetryUseCase(deps).execute(revoked.proxy);
    expect(asRefused(result).reason).toBe('invalid-request');
  });
});
