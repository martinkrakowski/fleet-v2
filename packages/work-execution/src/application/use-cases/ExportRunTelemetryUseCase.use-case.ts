/**
 * ExportRunTelemetryUseCase (lane OT2c-1): the telemetry export's selection,
 * mapping, sampling, cost policy and salt check (plan §3.3, §3.5, §3.8, §3.9).
 * Reads only through the ports it is given; never writes any store and, in
 * this lane, never calls `send` — OT2c-2 implements `sendAndRecord`. Never
 * throws: any port that throws or rejects maps to a fixed refused outcome
 * (fail closed). No raw id, path, value or free text reaches the result:
 * counts and fixed reason codes only.
 */

import type {
  ExportRunTelemetryCounts,
  ExportRunTelemetryPort,
  ExportRunTelemetryResult,
  ExportRunTelemetrySelection,
} from '../ports/in/ExportRunTelemetryPort.in-port.js';
import type { ExportRunTelemetryPolicy } from '../ports/in/ExportRunTelemetryPort.in-port.js';
import type { RunTelemetryPort, RunTelemetrySendDeadline } from '../ports/out/RunTelemetryPort.out-port.js';
import type { TelemetryDispositionPort } from '../ports/out/TelemetryDispositionPort.out-port.js';
import type { AcceptanceReceiptReadPort } from '../ports/out/AcceptanceReceiptReadPort.out-port.js';
import type { LaneRunRepositoryPort } from '../ports/out/LaneRunRepositoryPort.out-port.js';
import type { LaneRunJournalPort } from '../ports/out/LaneRunJournalPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../ports/out/WorkOrderRepositoryPort.out-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { RunTelemetryMarkTarget } from '../ports/out/RunTelemetryMarkPort.out-port.js';
import type { LaneRunRecord } from '../../domain/lane-run-records.js';
import type { LaneRunJournalEntryRecord } from '../../domain/lane-run-journal.js';
import type { AttemptRecord } from '../../domain/execution-records.js';
import {
  attemptTraceSpans,
  laneRunSpans,
  type AttemptTraceTelemetryFacts,
  type LaneRunTelemetryFacts,
  type TelemetryGateReceiptFact,
  type TelemetryReceiptFacts,
  type TelemetryReviewReceiptFact,
} from '../../domain/run-telemetry-spans.js';
import { TelemetrySpan } from '../../domain/run-telemetry.js';
import {
  TELEMETRY_ROUTES,
  isFinalSpanDisposition,
  telemetrySaltFingerprint,
  type SpanDisposition,
  type TelemetryHmac,
} from '../../domain/run-telemetry-ids.js';
import {
  dispositionsOfTrace,
  type TelemetryDispositionRecord,
} from '../../domain/run-telemetry-dispositions.js';

/** The read-only ports the export reads through; composition (OT4b) wires them. */
export interface ExportRunTelemetryDependencies {
  readonly runRepo: Pick<LaneRunRepositoryPort, 'get' | 'list'>;
  readonly journal: Pick<LaneRunJournalPort, 'listForRun'>;
  readonly attemptRepo: Pick<AttemptRepositoryPort, 'findAttemptById' | 'listAttemptsByWorkOrder' | 'listAllAttempts'>;
  readonly workOrderRepo: Pick<WorkOrderRepositoryPort, 'findWorkOrderById'>;
  readonly receipts: AcceptanceReceiptReadPort;
  readonly dispositions: TelemetryDispositionPort;
  readonly telemetry: RunTelemetryPort;
  readonly hmac: TelemetryHmac;
  /** Absent means no run is dry-run or shadow (today no record marks one; plan D10). */
  readonly dryRunKindOf?: (run: LaneRunRecord) => 'dry-run' | 'shadow' | null;
}

const ALIAS_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

type ExportRefusalReason = Extract<ExportRunTelemetryResult, { outcome: 'refused' }>['reason'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** An ISO instant the request validation accepts: a finite `Date.parse`. */
function isIsoInstant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/** A receipt timestamp: a finite parse and a `T` separator (plan §3.3). */
function isReceiptCompletedAt(value: unknown): value is string {
  return typeof value === 'string' && value.includes('T') && Number.isFinite(Date.parse(value));
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

function refused(reason: ExportRefusalReason, counts: ExportRunTelemetryCounts): ExportRunTelemetryResult {
  return { outcome: 'refused', reason, counts, counters: {} };
}

/** Own data properties only: a selection kind the export knows, with valid field values, else null. */
function parseSelection(value: unknown): ExportRunTelemetrySelection | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const kind = value.kind;
  if (kind === 'run') {
    return Object.hasOwn(value, 'runId') && isNonEmptyString(value.runId)
      ? { kind: 'run', runId: value.runId }
      : null;
  }
  if (kind === 'attempt') {
    return Object.hasOwn(value, 'attemptId') && isNonEmptyString(value.attemptId)
      ? { kind: 'attempt', attemptId: value.attemptId }
      : null;
  }
  if (kind === 'work-order') {
    return Object.hasOwn(value, 'workOrderId') && isNonEmptyString(value.workOrderId)
      ? { kind: 'work-order', workOrderId: value.workOrderId }
      : null;
  }
  if (kind === 'window') {
    if (!Object.hasOwn(value, 'sinceIso') || !Object.hasOwn(value, 'untilIso')) {
      return null;
    }
    if (!isIsoInstant(value.sinceIso)) {
      return null;
    }
    if (value.untilIso !== null && !isIsoInstant(value.untilIso)) {
      return null;
    }
    return { kind: 'window', sinceIso: value.sinceIso, untilIso: value.untilIso as string | null };
  }
  if (kind === 'marks') {
    if (!Object.hasOwn(value, 'targets') || !Array.isArray(value.targets)) {
      return null;
    }
    const targets: RunTelemetryMarkTarget[] = [];
    for (const target of value.targets) {
      if (!isPlainObject(target)) {
        return null;
      }
      if (target.kind === 'run' && Object.hasOwn(target, 'runId') && isNonEmptyString(target.runId)) {
        targets.push({ kind: 'run', runId: target.runId });
        continue;
      }
      if (target.kind === 'attempt' && Object.hasOwn(target, 'attemptId') && isNonEmptyString(target.attemptId)) {
        targets.push({ kind: 'attempt', attemptId: target.attemptId });
        continue;
      }
      return null;
    }
    return { kind: 'marks', targets };
  }
  return null;
}

function parsePolicy(value: unknown): ExportRunTelemetryPolicy | null {
  if (!isPlainObject(value)) {
    return null;
  }
  if (
    !Object.hasOwn(value, 'route') ||
    typeof value.route !== 'string' ||
    !(TELEMETRY_ROUTES as readonly string[]).includes(value.route)
  ) {
    return null;
  }
  if (
    !Object.hasOwn(value, 'sampleRatio') ||
    typeof value.sampleRatio !== 'number' ||
    !Number.isFinite(value.sampleRatio) ||
    value.sampleRatio < 0 ||
    value.sampleRatio > 1
  ) {
    return null;
  }
  if (!Object.hasOwn(value, 'sendCost') || typeof value.sendCost !== 'boolean') {
    return null;
  }
  if (!Object.hasOwn(value, 'includeDryRun') || typeof value.includeDryRun !== 'boolean') {
    return null;
  }
  if (!Object.hasOwn(value, 'projectAliases') || !isPlainObject(value.projectAliases)) {
    return null;
  }
  const projectAliases: Record<string, string> = {};
  for (const projectId of Object.keys(value.projectAliases)) {
    const alias = value.projectAliases[projectId];
    if (!isNonEmptyString(projectId) || !isNonEmptyString(alias) || !ALIAS_PATTERN.test(alias)) {
      return null;
    }
    projectAliases[projectId] = alias;
  }
  return {
    route: value.route as ExportRunTelemetryPolicy['route'],
    sampleRatio: value.sampleRatio,
    sendCost: value.sendCost,
    includeDryRun: value.includeDryRun,
    projectAliases,
  };
}

function parseDeadline(value: unknown): { ok: true; deadline: RunTelemetrySendDeadline } | { ok: false } {
  if (value === null) {
    return { ok: true, deadline: null };
  }
  if (
    isPlainObject(value) &&
    Object.hasOwn(value, 'atMs') &&
    typeof value.atMs === 'number' &&
    Number.isFinite(value.atMs)
  ) {
    return { ok: true, deadline: { atMs: value.atMs } };
  }
  return { ok: false };
}

interface ParsedRequest {
  readonly selection: ExportRunTelemetrySelection;
  readonly policy: ExportRunTelemetryPolicy;
  readonly mode: 'send' | 'dry-run';
  readonly deadline: RunTelemetrySendDeadline;
  readonly retryRejected: boolean;
  readonly nowIso: string;
}

/** The request is unknown input: every field is read as an own data property and validated; anything else is null. */
function parseRequest(value: unknown): ParsedRequest | null {
  if (!isPlainObject(value)) {
    return null;
  }
  for (const field of ['selection', 'policy', 'mode', 'deadline', 'retryRejected', 'nowIso']) {
    if (!Object.hasOwn(value, field)) {
      return null;
    }
  }
  const selection = parseSelection(value.selection);
  if (selection === null) {
    return null;
  }
  const policy = parsePolicy(value.policy);
  if (policy === null) {
    return null;
  }
  if (value.mode !== 'send' && value.mode !== 'dry-run') {
    return null;
  }
  const deadline = parseDeadline(value.deadline);
  if (!deadline.ok) {
    return null;
  }
  if (typeof value.retryRejected !== 'boolean') {
    return null;
  }
  if (!isIsoInstant(value.nowIso)) {
    return null;
  }
  return {
    selection,
    policy,
    mode: value.mode,
    deadline: deadline.deadline,
    retryRejected: value.retryRejected,
    nowIso: value.nowIso,
  };
}

/** One port call, never a throw: a rejection or a throw reads as `ok: false` (fail closed). */
async function tryPort<T>(operation: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await operation() };
  } catch {
    return { ok: false };
  }
}

/** The selected facts: the runs to map as conducted traces and the hand-run attempts to map as attempt traces. */
interface Selection {
  readonly runs: readonly LaneRunRecord[];
  readonly handAttempts: readonly AttemptRecord[];
  /** A hand-run attempt is one not in this set (plan §3.8). */
  readonly conductedIds: ReadonlySet<string>;
  readonly attemptsOfRun: ReadonlyMap<string, readonly AttemptRecord[]>;
  readonly journalByRun: ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]>;
}

type SelectionOutcome =
  | { readonly outcome: 'selected'; readonly selection: Selection }
  | { readonly outcome: 'empty' }
  | { readonly outcome: 'read-error' };

/** The union of the attempt ids of the given runs (plan §3.8). */
function conductedIdsOf(runs: readonly LaneRunRecord[]): Set<string> {
  const ids = new Set<string>();
  for (const run of runs) {
    for (const attemptId of run.attemptIds) {
      ids.add(attemptId);
    }
  }
  return ids;
}

export class ExportRunTelemetryUseCase implements ExportRunTelemetryPort {
  private readonly deps?: ExportRunTelemetryDependencies;

  constructor(deps?: ExportRunTelemetryDependencies) {
    this.deps = deps;
  }

  async execute(request: unknown): Promise<ExportRunTelemetryResult> {
    if (!this.deps) {
      throw new Error('Not implemented: ExportRunTelemetryUseCase');
    }
    const deps = this.deps;
    const counts = zeroCounts();

    // Step 3: validate the request; anything unknown is refused before any read.
    const parsed = parseRequest(request);
    if (parsed === null) {
      return refused('invalid-request', counts);
    }

    // Step 4: the salt check first (plan §3.5); nothing is mapped or sent on a refusal.
    const fingerprint = telemetrySaltFingerprint(deps.hmac);
    if (fingerprint === null) {
      return refused('invalid-request', counts);
    }
    const storeRead = await tryPort(() => deps.dispositions.read());
    if (!storeRead.ok) {
      return refused('store-error', counts);
    }
    if (storeRead.value.outcome === 'unreadable') {
      return refused('store-unreadable', counts);
    }
    const record: TelemetryDispositionRecord = storeRead.value.record;
    if (record.saltFingerprint !== null && record.saltFingerprint !== fingerprint) {
      // The store refuses such a write, so the count travels in the result, not the store (plan §3.5).
      return {
        outcome: 'refused',
        reason: 'salt-mismatch',
        counts,
        counters: { 'salt-mismatch': 1 },
      };
    }

    // Step 5: select and read the facts.
    const selected = await this.select(deps, parsed);
    if (selected.outcome === 'empty') {
      return { outcome: 'nothing-selected', counts };
    }
    if (selected.outcome === 'read-error') {
      return refused('read-error', counts);
    }
    const selection = selected.selection;

    // The dry-run policy applies before mapping (plan §3.9, D10).
    const dryRunKindOf = deps.dryRunKindOf ?? (() => null);
    const keptRuns = parsed.policy.includeDryRun
      ? selection.runs
      : selection.runs.filter((run) => dryRunKindOf(run) === null);
    if (keptRuns.length === 0 && selection.handAttempts.length === 0) {
      return { outcome: 'nothing-selected', counts };
    }

    // The receipts of every selected attempt with a collected head (plan §3.3).
    let attemptsSelected = selection.handAttempts.length;
    for (const run of keptRuns) {
      attemptsSelected += (selection.attemptsOfRun.get(run.runId) ?? []).length;
    }
    const receiptFacts = new Map<string, TelemetryReceiptFacts>();
    let receiptsDropped = 0;
    const allSelectedAttempts: AttemptRecord[] = [
      ...keptRuns.flatMap((run) => selection.attemptsOfRun.get(run.runId) ?? []),
      ...selection.handAttempts,
    ];
    for (const attempt of allSelectedAttempts) {
      const headCommit = attempt.artifacts?.headCommit;
      if (headCommit === undefined) {
        continue;
      }
      const readReceipts = await tryPort(() => deps.receipts.readReceiptsForHead(attempt.id, headCommit));
      if (!readReceipts.ok) {
        return refused('read-error', counts);
      }
      if (readReceipts.value.outcome === 'unavailable') {
        return refused('read-error', counts);
      }
      if (readReceipts.value.outcome === 'none') {
        receiptFacts.set(attempt.id, { verification: [], review: [] });
        continue;
      }
      const verification: TelemetryGateReceiptFact[] = [];
      for (const receipt of readReceipts.value.verification) {
        if (!isReceiptCompletedAt(receipt.completedAtIso)) {
          receiptsDropped += 1;
          continue;
        }
        verification.push({
          receiptId: receipt.receiptId,
          result: receipt.result,
          exitCode: receipt.exitCode,
          completedAtIso: receipt.completedAtIso,
        });
      }
      const review: TelemetryReviewReceiptFact[] = [];
      for (const receipt of readReceipts.value.review) {
        if (!isReceiptCompletedAt(receipt.completedAtIso)) {
          receiptsDropped += 1;
          continue;
        }
        review.push({
          receiptId: receipt.receiptId,
          kind: receipt.kind,
          result: receipt.result,
          findings: receipt.findings,
          completedAtIso: receipt.completedAtIso,
        });
      }
      receiptFacts.set(attempt.id, { verification, review });
    }

    // Step 6: map. The raw project id never reaches a span: only the alias or nothing.
    const mapped: TelemetrySpan[] = [];
    let rejectedInvalid = 0;
    for (const run of keptRuns) {
      const workOrderRead = await tryPort(() => deps.workOrderRepo.findWorkOrderById(run.workOrderId));
      if (!workOrderRead.ok) {
        return refused('read-error', counts);
      }
      const workOrder = workOrderRead.value;
      const project =
        workOrder !== null && Object.hasOwn(parsed.policy.projectAliases, workOrder.projectId)
          ? parsed.policy.projectAliases[workOrder.projectId]
          : null;
      const dryRunTag = parsed.policy.includeDryRun ? dryRunKindOf(run) : null;
      const tags: readonly string[] = dryRunTag === null ? ['conducted'] : ['conducted', dryRunTag];
      const cachedJournal = selection.journalByRun.get(run.runId);
      const journalRead =
        cachedJournal !== undefined
          ? { ok: true as const, value: cachedJournal }
          : await tryPort(() => deps.journal.listForRun(run.runId));
      if (!journalRead.ok) {
        return refused('read-error', counts);
      }
      const facts: LaneRunTelemetryFacts = {
        run,
        journal: journalRead.value,
        project,
        tags,
        attempts: selection.attemptsOfRun.get(run.runId) ?? [],
      };
      const result = laneRunSpans(deps.hmac, facts);
      mapped.push(...result.spans);
      rejectedInvalid += result.rejectedInvalid;
    }
    for (const attempt of selection.handAttempts) {
      const facts: AttemptTraceTelemetryFacts = {
        attempt,
        receipts: receiptFacts.get(attempt.id) ?? { verification: [], review: [] },
        conductedAttemptIds: selection.conductedIds,
      };
      const result = attemptTraceSpans(deps.hmac, facts);
      mapped.push(...result.spans);
      rejectedInvalid += result.rejectedInvalid;
    }

    // Step 7: sampling keeps or drops whole traces, deterministically (plan §3.9).
    const traceKept = new Map<string, boolean>();
    for (const span of mapped) {
      if (!traceKept.has(span.traceId)) {
        const head = parseInt(span.traceId.slice(0, 8), 16) / 0x1_0000_0000;
        traceKept.set(span.traceId, head < parsed.policy.sampleRatio);
      }
    }
    const sampled: TelemetrySpan[] = [];
    let sampledOut = 0;
    for (const span of mapped) {
      if (traceKept.get(span.traceId) === true) {
        sampled.push(span);
      } else {
        sampledOut += 1;
      }
    }

    // Step 8: the cost policy (plan §3.6, §3.9): token counts stay, costs go.
    let costApplied = sampled;
    if (!parsed.policy.sendCost) {
      const rebuilt: TelemetrySpan[] = [];
      for (const span of sampled) {
        const keys = Object.keys(span.attributes);
        if (!keys.some((key) => key.startsWith('llm.cost.') || key.startsWith('fleet.cost.'))) {
          rebuilt.push(span);
          continue;
        }
        const attributes: Record<string, unknown> = {};
        for (const key of keys) {
          if (!key.startsWith('llm.cost.') && !key.startsWith('fleet.cost.')) {
            attributes[key] = span.attributes[key];
          }
        }
        const rebuiltSpan = TelemetrySpan.build({
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId,
          name: span.name,
          kind: span.kind,
          startIso: span.startIso,
          endIso: span.endIso,
          status: span.status,
          attributes,
          events: span.events,
        });
        if (rebuiltSpan === null) {
          rejectedInvalid += 1;
          continue;
        }
        rebuilt.push(rebuiltSpan);
      }
      costApplied = rebuilt;
    }

    // Step 9: the stored finals drop out; `retryRejected` keeps rejected spans for OT2c-2 to reopen.
    const toSend: TelemetrySpan[] = [];
    let alreadyFinal = 0;
    for (const span of costApplied) {
      const disposition: SpanDisposition | undefined = dispositionsOfTrace(record, span.traceId).get(span.spanId);
      if (disposition !== undefined && isFinalSpanDisposition(disposition)) {
        if (parsed.retryRejected && disposition.state === 'rejected') {
          toSend.push(span);
          continue;
        }
        alreadyFinal += 1;
        continue;
      }
      toSend.push(span);
    }

    // Step 10: the outcomes of this lane.
    const resultCounts: ExportRunTelemetryCounts = {
      ...counts,
      runsSelected: keptRuns.length,
      attemptsSelected,
      spansMapped: mapped.length,
      rejectedInvalid,
      sampledOut,
      alreadyFinal,
      toSend: toSend.length,
      receiptsDropped,
    };
    if (parsed.mode === 'dry-run') {
      return { outcome: 'dry-run', counts: resultCounts, spans: toSend };
    }
    return await this.sendAndRecord(toSend, resultCounts, parsed.deadline, parsed.retryRejected);
  }

  /**
   * OT2c-2: send `spans` through the telemetry port with `deadline`, record
   * each returned disposition, add the counters and, with `retryRejected`,
   * reopen rejected spans before the send. This lane sends and writes
   * nothing: it returns the exported result with a null error kind.
   */
  private async sendAndRecord(
    _spans: readonly TelemetrySpan[],
    counts: ExportRunTelemetryCounts,
    _deadline: RunTelemetrySendDeadline,
    _retryRejected: boolean,
  ): Promise<ExportRunTelemetryResult> {
    // OT2c-2 implements the send and the disposition writes here.
    return { outcome: 'exported', counts, errorKind: null };
  }

  /**
   * Step 5: read the selected runs, their attempts and the hand-run attempts
   * through the read-only repositories. Any repository throw or rejection is
   * a read error (fail closed); known absence is an empty selection.
   */
  private async select(deps: ExportRunTelemetryDependencies, parsed: ParsedRequest): Promise<SelectionOutcome> {
    const selection = parsed.selection;

    if (selection.kind === 'run') {
      const runRead = await tryPort(() => deps.runRepo.get(selection.runId));
      if (!runRead.ok) {
        return { outcome: 'read-error' };
      }
      if (runRead.value === null) {
        return { outcome: 'empty' };
      }
      return await this.selectRuns(deps, [runRead.value], []);
    }

    if (selection.kind === 'attempt') {
      const attemptRead = await tryPort(() => deps.attemptRepo.findAttemptById(selection.attemptId));
      if (!attemptRead.ok) {
        return { outcome: 'read-error' };
      }
      if (attemptRead.value === null) {
        return { outcome: 'empty' };
      }
      const attempt = attemptRead.value;
      const runsRead = await tryPort(() => deps.runRepo.list());
      if (!runsRead.ok) {
        return { outcome: 'read-error' };
      }
      // An attempt that belongs to a run exports that run instead (plan §3.8).
      const owner = runsRead.value.find((run) => run.attemptIds.includes(attempt.id));
      if (owner !== undefined) {
        return await this.selectRuns(deps, [owner], []);
      }
      return {
        outcome: 'selected',
        selection: {
          runs: [],
          handAttempts: [attempt],
          conductedIds: conductedIdsOf(runsRead.value),
          attemptsOfRun: new Map(),
          journalByRun: new Map(),
        },
      };
    }

    if (selection.kind === 'work-order') {
      const runsRead = await tryPort(() => deps.runRepo.list());
      if (!runsRead.ok) {
        return { outcome: 'read-error' };
      }
      const runs = runsRead.value.filter((run) => run.workOrderId === selection.workOrderId);
      const attemptsRead = await tryPort(() => deps.attemptRepo.listAttemptsByWorkOrder(selection.workOrderId));
      if (!attemptsRead.ok) {
        return { outcome: 'read-error' };
      }
      const conductedIds = conductedIdsOf(runs);
      return await this.selectRuns(
        deps,
        runs,
        attemptsRead.value.filter((attempt) => !conductedIds.has(attempt.id)),
        conductedIds,
      );
    }

    if (selection.kind === 'window') {
      const runsRead = await tryPort(() => deps.runRepo.list());
      if (!runsRead.ok) {
        return { outcome: 'read-error' };
      }
      const since = Date.parse(selection.sinceIso);
      const until = selection.untilIso === null ? Date.parse(parsed.nowIso) : Date.parse(selection.untilIso);
      const runs: LaneRunRecord[] = [];
      const journalByRun = new Map<string, readonly LaneRunJournalEntryRecord[]>();
      for (const run of runsRead.value) {
        const entriesRead = await tryPort(() => deps.journal.listForRun(run.runId));
        if (!entriesRead.ok) {
          return { outcome: 'read-error' };
        }
        if (entriesRead.value.length > 0) {
          runs.push(run);
          journalByRun.set(run.runId, entriesRead.value);
        }
      }
      const attemptsRead = await tryPort(() => deps.attemptRepo.listAllAttempts());
      if (!attemptsRead.ok) {
        return { outcome: 'read-error' };
      }
      const inWindow = attemptsRead.value.filter((attempt) => {
        const created = Date.parse(attempt.createdAtIso);
        const updated = Date.parse(attempt.updatedAtIso);
        const createdIn = Number.isFinite(created) && created >= since && created <= until;
        const updatedIn = Number.isFinite(updated) && updated >= since && updated <= until;
        return createdIn || updatedIn;
      });
      const conductedIds = conductedIdsOf(runsRead.value);
      return await this.selectRuns(
        deps,
        runs,
        inWindow.filter((attempt) => !conductedIds.has(attempt.id)),
        conductedIds,
        journalByRun,
      );
    }

    // 'marks': each target as a run or an attempt (plan §3.8).
    const runs: LaneRunRecord[] = [];
    const runIds = new Set<string>();
    const handAttempts: AttemptRecord[] = [];
    const attemptIds = new Set<string>();
    let allRuns: readonly LaneRunRecord[] | null = null;
    for (const target of selection.targets) {
      if (target.kind === 'run') {
        const runRead = await tryPort(() => deps.runRepo.get(target.runId));
        if (!runRead.ok) {
          return { outcome: 'read-error' };
        }
        if (runRead.value !== null && !runIds.has(runRead.value.runId)) {
          runIds.add(runRead.value.runId);
          runs.push(runRead.value);
        }
        continue;
      }
      const attemptRead = await tryPort(() => deps.attemptRepo.findAttemptById(target.attemptId));
      if (!attemptRead.ok) {
        return { outcome: 'read-error' };
      }
      if (attemptRead.value === null || attemptIds.has(attemptRead.value.id)) {
        continue;
      }
      const attempt = attemptRead.value;
      attemptIds.add(attempt.id);
      if (allRuns === null) {
        const runsRead = await tryPort(() => deps.runRepo.list());
        if (!runsRead.ok) {
          return { outcome: 'read-error' };
        }
        allRuns = runsRead.value;
      }
      const owner = allRuns.find((run) => run.attemptIds.includes(attempt.id));
      if (owner !== undefined) {
        if (!runIds.has(owner.runId)) {
          runIds.add(owner.runId);
          runs.push(owner);
        }
        continue;
      }
      handAttempts.push(attempt);
    }
    return await this.selectRuns(deps, runs, handAttempts, conductedIdsOf(runs));
  }

  /**
   * One or more whole runs plus their hand-run attempts: every run's
   * conducted attempts are loaded by id and every run's journal is read (the
   * window cache is reused when present). Any read that throws is a read
   * error; a run whose attempts are absent maps without them.
   */
  private async selectRuns(
    deps: ExportRunTelemetryDependencies,
    runs: readonly LaneRunRecord[],
    handAttempts: readonly AttemptRecord[],
    conductedIds?: ReadonlySet<string>,
    journalByRun?: ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]>,
  ): Promise<SelectionOutcome> {
    const attemptsOfRun = new Map<string, AttemptRecord[]>();
    const journals = journalByRun === undefined ? new Map<string, readonly LaneRunJournalEntryRecord[]>() : undefined;
    for (const run of runs) {
      const attempts: AttemptRecord[] = [];
      for (const attemptId of run.attemptIds) {
        const attemptRead = await tryPort(() => deps.attemptRepo.findAttemptById(attemptId));
        if (!attemptRead.ok) {
          return { outcome: 'read-error' };
        }
        if (attemptRead.value !== null) {
          attempts.push(attemptRead.value);
        }
      }
      attemptsOfRun.set(run.runId, attempts);
      if (journals !== undefined) {
        const entriesRead = await tryPort(() => deps.journal.listForRun(run.runId));
        if (!entriesRead.ok) {
          return { outcome: 'read-error' };
        }
        journals.set(run.runId, entriesRead.value);
      }
    }
    return {
      outcome: 'selected',
      selection: {
        runs,
        handAttempts,
        conductedIds: conductedIds ?? conductedIdsOf(runs),
        attemptsOfRun,
        journalByRun: journals ?? journalByRun ?? new Map(),
      },
    };
  }
}
