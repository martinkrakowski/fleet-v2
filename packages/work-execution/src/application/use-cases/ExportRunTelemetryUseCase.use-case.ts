/**
 * ExportRunTelemetryUseCase (lanes OT2c-1 and OT2c-2): the telemetry export's
 * selection, mapping, sampling, cost policy and salt check (plan §3.3, §3.5,
 * §3.8, §3.9), plus the send path: every span is written pending before the
 * send, a disposition becomes final only on a send result, and a killed or
 * failing export leaves the spans pending so the next export resends. Reads
 * only through the ports it is given. Never throws: any port that throws or
 * rejects maps to a fixed refused outcome (fail closed). No raw id, path,
 * value or free text reaches the result: counts and fixed reason codes only.
 */

import type {
  ExportRunTelemetryCounts,
  ExportRunTelemetryPort,
  ExportRunTelemetryResult,
  ExportRunTelemetrySelection,
} from '../ports/in/ExportRunTelemetryPort.in-port.js';
import type { ExportRunTelemetryPolicy } from '../ports/in/ExportRunTelemetryPort.in-port.js';
import type { RunTelemetryPort, RunTelemetrySendDeadline, RunTelemetrySendResult } from '../ports/out/RunTelemetryPort.out-port.js';
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
  TELEMETRY_ERROR_KINDS,
  TELEMETRY_ROUTES,
  isFinalSpanDisposition,
  spanDispositionText,
  telemetrySaltFingerprint,
  type SpanDisposition,
  type TelemetryErrorKind,
  type TelemetryHmac,
} from '../../domain/run-telemetry-ids.js';
import {
  dispositionsOfTrace,
  type TelemetryCounterKey,
  type TelemetryDispositionRecord,
  type TelemetryDispositionUpdate,
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

/**
 * A refused disposition write: the store's reason travels when the export
 * knows it, with the salt-mismatch counter in the result (the store refuses
 * such a write, so the count travels here, plan §3.5); anything else is
 * `store-error`.
 */
function storeRefusal(reason: 'invalid-request' | 'salt-mismatch' | 'store-unreadable', counts: ExportRunTelemetryCounts): ExportRunTelemetryResult {
  if (reason === 'salt-mismatch') {
    return { outcome: 'refused', reason: 'salt-mismatch', counts, counters: { 'salt-mismatch': 1 } };
  }
  if (reason === 'store-unreadable') {
    return refused('store-unreadable', counts);
  }
  return refused('store-error', counts);
}

/** Own data properties only: a selection kind the export knows, with valid field values, else null. */
function parseSelection(value: unknown): ExportRunTelemetrySelection | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const kind = ownDataField(value, 'kind');
  if (!kind.ok) {
    return null;
  }
  if (kind.value === 'run') {
    const runId = ownDataField(value, 'runId');
    return runId.ok && isNonEmptyString(runId.value) ? { kind: 'run', runId: runId.value } : null;
  }
  if (kind.value === 'attempt') {
    const attemptId = ownDataField(value, 'attemptId');
    return attemptId.ok && isNonEmptyString(attemptId.value) ? { kind: 'attempt', attemptId: attemptId.value } : null;
  }
  if (kind.value === 'work-order') {
    const workOrderId = ownDataField(value, 'workOrderId');
    return workOrderId.ok && isNonEmptyString(workOrderId.value)
      ? { kind: 'work-order', workOrderId: workOrderId.value }
      : null;
  }
  if (kind.value === 'window') {
    const sinceIso = ownDataField(value, 'sinceIso');
    if (!sinceIso.ok || !isIsoInstant(sinceIso.value)) {
      return null;
    }
    const untilIso = ownDataField(value, 'untilIso');
    if (!untilIso.ok) {
      return null;
    }
    if (untilIso.value !== null && !isIsoInstant(untilIso.value)) {
      return null;
    }
    return { kind: 'window', sinceIso: sinceIso.value, untilIso: untilIso.value as string | null };
  }
  if (kind.value === 'marks') {
    const targets = ownDataField(value, 'targets');
    if (!targets.ok || !Array.isArray(targets.value)) {
      return null;
    }
    // Indices are read as own data properties, never through the array's
    // iterator or an index getter.
    const length = ownDataField(targets.value as unknown as Record<string, unknown>, 'length');
    if (!length.ok || typeof length.value !== 'number' || !Number.isSafeInteger(length.value) || length.value < 0) {
      return null;
    }
    const parsedTargets: RunTelemetryMarkTarget[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const element = ownDataField(targets.value as unknown as Record<string, unknown>, String(index));
      if (!element.ok) {
        return null;
      }
      const target = element.value;
      if (!isPlainObject(target)) {
        return null;
      }
      const targetKind = ownDataField(target, 'kind');
      if (!targetKind.ok) {
        return null;
      }
      if (targetKind.value === 'run') {
        const runId = ownDataField(target, 'runId');
        if (runId.ok && isNonEmptyString(runId.value)) {
          parsedTargets.push({ kind: 'run', runId: runId.value });
          continue;
        }
        return null;
      }
      if (targetKind.value === 'attempt') {
        const attemptId = ownDataField(target, 'attemptId');
        if (attemptId.ok && isNonEmptyString(attemptId.value)) {
          parsedTargets.push({ kind: 'attempt', attemptId: attemptId.value });
          continue;
        }
        return null;
      }
      return null;
    }
    return { kind: 'marks', targets: parsedTargets };
  }
  return null;
}

function parsePolicy(value: unknown): ExportRunTelemetryPolicy | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const route = ownDataField(value, 'route');
  if (!route.ok || typeof route.value !== 'string' || !(TELEMETRY_ROUTES as readonly string[]).includes(route.value)) {
    return null;
  }
  const sampleRatio = ownDataField(value, 'sampleRatio');
  if (
    !sampleRatio.ok ||
    typeof sampleRatio.value !== 'number' ||
    !Number.isFinite(sampleRatio.value) ||
    sampleRatio.value < 0 ||
    sampleRatio.value > 1
  ) {
    return null;
  }
  const sendCost = ownDataField(value, 'sendCost');
  if (!sendCost.ok || typeof sendCost.value !== 'boolean') {
    return null;
  }
  const includeDryRun = ownDataField(value, 'includeDryRun');
  if (!includeDryRun.ok || typeof includeDryRun.value !== 'boolean') {
    return null;
  }
  const aliasesField = ownDataField(value, 'projectAliases');
  if (!aliasesField.ok || !isPlainObject(aliasesField.value)) {
    return null;
  }
  const aliasesValue = aliasesField.value;
  const projectAliases: Record<string, string> = {};
  for (const projectId of Object.keys(aliasesValue)) {
    const alias = ownDataField(aliasesValue, projectId);
    if (!alias.ok || !isNonEmptyString(projectId) || !isNonEmptyString(alias.value) || !ALIAS_PATTERN.test(alias.value)) {
      return null;
    }
    projectAliases[projectId] = alias.value;
  }
  return {
    route: route.value as ExportRunTelemetryPolicy['route'],
    sampleRatio: sampleRatio.value,
    sendCost: sendCost.value,
    includeDryRun: includeDryRun.value,
    projectAliases,
  };
}

function parseDeadline(value: unknown): { ok: true; deadline: RunTelemetrySendDeadline } | { ok: false } {
  if (value === null) {
    return { ok: true, deadline: null };
  }
  if (isPlainObject(value)) {
    const atMs = ownDataField(value, 'atMs');
    if (atMs.ok && typeof atMs.value === 'number' && Number.isFinite(atMs.value)) {
      return { ok: true, deadline: { atMs: atMs.value } };
    }
  }
  return { ok: false };
}

/**
 * The send port's result, validated before use: a plain object with a
 * dispositions array and an error kind from the declared list, and every
 * entry a plain object with a string span id and a valid disposition.
 * Anything else reads as null and the caller treats the send as failed:
 * every span stays pending (fail closed, never throws).
 */
function parseSendResult(sent: unknown): RunTelemetrySendResult | null {
  // Every field is read through its own data descriptor (an accessor never
  // runs), the dispositions are copied by index into fresh objects, and any
  // throw (a revoked proxy, a hostile descriptor) reads as null: never throws.
  try {
    if (!isPlainObject(sent)) {
      return null;
    }
    const dispositionsField = ownDataField(sent, 'dispositions');
    const errorKindField = ownDataField(sent, 'errorKind');
    if (!dispositionsField.ok || !errorKindField.ok || !Array.isArray(dispositionsField.value)) {
      return null;
    }
    const errorKind = errorKindField.value;
    if (
      errorKind !== null &&
      !(typeof errorKind === 'string' && (TELEMETRY_ERROR_KINDS as readonly string[]).includes(errorKind))
    ) {
      return null;
    }
    const list = dispositionsField.value as unknown[];
    const lengthField = ownDataField(list as unknown as Record<string, unknown>, 'length');
    if (!lengthField.ok || typeof lengthField.value !== 'number' || !Number.isSafeInteger(lengthField.value)) {
      return null;
    }
    const dispositions: { spanId: string; disposition: SpanDisposition }[] = [];
    for (let index = 0; index < lengthField.value; index += 1) {
      const entryField = ownDataField(list as unknown as Record<string, unknown>, String(index));
      if (!entryField.ok || !isPlainObject(entryField.value)) {
        return null;
      }
      const spanIdField = ownDataField(entryField.value, 'spanId');
      const dispositionField = ownDataField(entryField.value, 'disposition');
      if (!spanIdField.ok || !dispositionField.ok || typeof spanIdField.value !== 'string') {
        return null;
      }
      // A plain-data copy of the disposition, validated after copying.
      const copied: unknown = JSON.parse(JSON.stringify(dispositionField.value));
      if (spanDispositionText(copied as SpanDisposition) === null) {
        return null;
      }
      dispositions.push({ spanId: spanIdField.value, disposition: copied as SpanDisposition });
    }
    return { dispositions, errorKind: errorKind as TelemetryErrorKind | null };
  } catch {
    return null;
  }
}

interface ParsedRequest {
  readonly selection: ExportRunTelemetrySelection;
  readonly policy: ExportRunTelemetryPolicy;
  readonly mode: 'send' | 'dry-run';
  readonly deadline: RunTelemetrySendDeadline;
  readonly retryRejected: boolean;
  readonly nowIso: string;
}

/**
 * One request field as an own data property: `Object.getOwnPropertyDescriptor`
 * so no accessor ever runs and a missing descriptor where one is required is
 * itself invalid. A descriptor read that throws reads as absent (fail closed).
 */
function ownDataField(value: Record<string, unknown>, field: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      return { ok: false };
    }
    return { ok: true, value: descriptor.value };
  } catch {
    return { ok: false };
  }
}

/**
 * The request is unknown input: every field is read as an own data property
 * and validated; anything else is null. The whole parse is wrapped so no
 * getter or descriptor read can make `execute()` reject: any throw reads as
 * `invalid-request` (fail closed, never throws).
 */
function parseRequest(value: unknown): ParsedRequest | null {
  try {
    if (!isPlainObject(value)) {
      return null;
    }
    const fields = new Map<string, unknown>();
    for (const field of ['selection', 'policy', 'mode', 'deadline', 'retryRejected', 'nowIso']) {
      const own = ownDataField(value, field);
      if (!own.ok) {
        return null;
      }
      fields.set(field, own.value);
    }
    const selection = parseSelection(fields.get('selection'));
    if (selection === null) {
      return null;
    }
    const policy = parsePolicy(fields.get('policy'));
    if (policy === null) {
      return null;
    }
    const mode = fields.get('mode');
    if (mode !== 'send' && mode !== 'dry-run') {
      return null;
    }
    const deadline = parseDeadline(fields.get('deadline'));
    if (!deadline.ok) {
      return null;
    }
    const retryRejected = fields.get('retryRejected');
    if (typeof retryRejected !== 'boolean') {
      return null;
    }
    const nowIso = fields.get('nowIso');
    if (!isIsoInstant(nowIso)) {
      return null;
    }
    return {
      selection,
      policy,
      mode: mode as 'send' | 'dry-run',
      deadline: deadline.deadline,
      retryRejected,
      nowIso,
    };
  } catch {
    return null;
  }
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
    // Never rejects once wired (Argon, OT2c-2): anything that escapes the
    // steps below (a revoked proxy as the request, a hostile port result) is
    // an invalid-request refusal, and nothing more is written.
    try {
      return await this.executeWired(this.deps, request);
    } catch {
      return { outcome: 'refused', reason: 'invalid-request', counts: zeroCounts(), counters: {} };
    }
  }

  private async executeWired(deps: ExportRunTelemetryDependencies, request: unknown): Promise<ExportRunTelemetryResult> {
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
    const rejectedSpanIds = new Set<string>();
    let alreadyFinal = 0;
    for (const span of costApplied) {
      const disposition: SpanDisposition | undefined = dispositionsOfTrace(record, span.traceId).get(span.spanId);
      if (disposition !== undefined && isFinalSpanDisposition(disposition)) {
        if (parsed.retryRejected && disposition.state === 'rejected') {
          rejectedSpanIds.add(span.spanId);
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
    return await this.sendAndRecord(
      toSend,
      resultCounts,
      parsed.deadline,
      parsed.retryRejected,
      parsed.nowIso,
      fingerprint,
      rejectedSpanIds,
    );
  }

  /**
   * OT2c-2: the send path (plan §3.5). With `retryRejected`, the selection's
   * stored `rejected:*` spans are written back to `pending` with one `reopen`
   * write before anything else. Then every span is written `pending` in one
   * write, and only a written store lets the spans go to `send` — a refused
   * or busy store sends nothing. A disposition becomes final only on the
   * send's HTTP result: the returned final dispositions of spans we sent are
   * recorded in one write with the send's error kind as a counter and
   * `exportedAt` when at least one span exported. A throwing or never-
   * resolving send leaves every span `pending` and writes nothing more, so a
   * killed export resends. This method never throws: every store refusal and
   * throw maps to a refused result (fail closed).
   */
  private async sendAndRecord(
    spans: readonly TelemetrySpan[],
    counts: ExportRunTelemetryCounts,
    deadline: RunTelemetrySendDeadline,
    retryRejected: boolean,
    nowIso: string,
    saltFingerprint: string,
    rejectedSpanIds: ReadonlySet<string>,
  ): Promise<ExportRunTelemetryResult> {
    const deps = this.deps!;
    if (spans.length === 0) {
      return { outcome: 'exported', counts, errorKind: null };
    }

    // Step 1: reopen the selection's rejected spans back to pending (one write).
    if (retryRejected && rejectedSpanIds.size > 0) {
      const reopenUpdates: TelemetryDispositionUpdate[] = spans
        .filter((span) => rejectedSpanIds.has(span.spanId))
        .map((span) => ({ traceId: span.traceId, spanId: span.spanId, disposition: { state: 'pending' } as const }));
      const reopened = await tryPort(() =>
        deps.dispositions.write({ saltFingerprint, updates: reopenUpdates, reopen: true, nowIso }),
      );
      if (!reopened.ok) {
        return refused('store-error', counts);
      }
      if (reopened.value.outcome === 'refused') {
        return storeRefusal(reopened.value.reason, counts);
      }
      if (reopened.value.outcome === 'skipped') {
        // The rejected spans stay rejected and nothing is sent: sending nothing
        // is safer than a final they would be sent into again (the next export reopens).
        return { outcome: 'exported', counts: { ...counts, refusedByStore: spans.length }, errorKind: null };
      }
    }

    // Step 2: every span is pending before it is sent (one write).
    const pendingWrite = await tryPort(() =>
      deps.dispositions.write({
        saltFingerprint,
        updates: spans.map((span) => ({ traceId: span.traceId, spanId: span.spanId, disposition: { state: 'pending' } as const })),
        nowIso,
      }),
    );
    if (!pendingWrite.ok) {
      return refused('store-error', counts);
    }
    if (pendingWrite.value.outcome === 'refused') {
      if (pendingWrite.value.reason === 'salt-mismatch') {
        // Another host recorded a different salt between our read and this write.
        return { outcome: 'refused', reason: 'salt-mismatch', counts, counters: { 'salt-mismatch': 1 } };
      }
      return refused('store-error', counts);
    }
    if (pendingWrite.value.outcome === 'skipped') {
      // Nothing is sent: the spans are exported next time.
      return { outcome: 'exported', counts: { ...counts, refusedByStore: spans.length }, errorKind: null };
    }
    if (pendingWrite.value.kept !== 0) {
      // Another exporter finalised a selected span after our read: the store
      // kept that final, so not every span landed pending. Nothing is sent;
      // the next export re-reads the store and skips the finals. The applied
      // spans stay pending; the kept ones keep their stored final.
      const appliedPending = Math.min(pendingWrite.value.applied, spans.length);
      return { outcome: 'exported', counts: { ...counts, pending: appliedPending, refusedByStore: spans.length - appliedPending }, errorKind: null };
    }

    // Step 3: the send. A throw or rejection leaves every span pending and writes nothing more.
    let sent: RunTelemetrySendResult;
    try {
      sent = await deps.telemetry.send(spans, deadline);
    } catch {
      return { outcome: 'exported', counts: { ...counts, pending: spans.length }, errorKind: 'network' };
    }
    const parsedSent = parseSendResult(sent);
    if (parsedSent === null) {
      // A malformed send result counts as a send failure: every span stays pending.
      return { outcome: 'exported', counts: { ...counts, pending: spans.length }, errorKind: 'network' };
    }
    sent = parsedSent;

    // Step 4: only final dispositions of spans we sent are recorded; unknown
    // span ids are ignored and counted nowhere, and the first disposition per
    // sent span id wins (duplicates are never double-counted).
    const spanById = new Map(spans.map((span) => [span.spanId, span]));
    const sentIds = new Set(spanById.keys());
    const seenSpanIds = new Set<string>();
    const finals: TelemetryDispositionUpdate[] = [];
    let exported = 0;
    let rejected = 0;
    let anyExported = false;
    for (const entry of sent.dispositions) {
      if (!sentIds.has(entry.spanId) || seenSpanIds.has(entry.spanId)) {
        continue;
      }
      seenSpanIds.add(entry.spanId);
      if (!isFinalSpanDisposition(entry.disposition)) {
        continue;
      }
      finals.push({ traceId: spanById.get(entry.spanId)!.traceId, spanId: entry.spanId, disposition: entry.disposition });
      if (entry.disposition.state === 'exported') {
        exported += 1;
        anyExported = true;
      } else {
        rejected += 1;
      }
    }
    const recordedCounts: ExportRunTelemetryCounts = {
      ...counts,
      exported,
      rejected,
      pending: spans.length - finals.length,
    };
    const counters: Partial<Record<TelemetryCounterKey, number>> = {};
    if (sent.errorKind !== null) {
      counters[sent.errorKind] = 1;
    }
    if (finals.length === 0 && sent.errorKind === null) {
      // Nothing final to record and no error counter: the store already holds every span pending.
      return { outcome: 'exported', counts: recordedCounts, errorKind: null };
    }
    const recorded = await tryPort(() =>
      deps.dispositions.write({
        saltFingerprint,
        updates: finals,
        counters,
        exportedAt: anyExported,
        nowIso,
      }),
    );
    // Unrecorded results: no final was stored, so the finals count as refused
    // by the store (they stay pending there) and the counts still add up to toSend.
    const unrecordedCounts: ExportRunTelemetryCounts = { ...recordedCounts, exported: 0, rejected: 0, refusedByStore: finals.length };
    if (!recorded.ok || recorded.value.outcome === 'skipped') {
      // The final dispositions stay pending in the store: the next export
      // resends them (safe under first-write-wins).
      return { outcome: 'exported', counts: unrecordedCounts, errorKind: sent.errorKind };
    }
    if (recorded.value.outcome === 'refused') {
      // The store refused the result write: fail closed like Steps 1 and 2.
      return storeRefusal(recorded.value.reason, unrecordedCounts);
    }
    return { outcome: 'exported', counts: recordedCounts, errorKind: sent.errorKind };
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
        // A run is in the window when any journal entry was recorded inside it (plan §3.8).
        const recordedIn = entriesRead.value.some((entry) => {
          const recorded = Date.parse(entry.recordedAtIso);
          return Number.isFinite(recorded) && recorded >= since && recorded <= until;
        });
        if (recordedIn) {
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
