// Implemented for lane D4 (decision port plan, 2026-10-16); extended for lane
// K2 (decision-kernel plan, 2026-10-16, §3) and lane K4 (the same plan, §4:
// the measurement read over every recorded month).
/**
 * FileDecisionReceiptJournalAdapter implements DecisionReceiptJournalPort
 * (local-jsonl-receipt-journal): one append-only JSONL file per UTC month at
 * `<stateDir>/decision-receipts/<YYYY-MM>.jsonl`, never under the signed
 * owner-decision inbox `<stateDir>/decisions/`. Every append and every
 * read-then-append runs under the brief-knowledge `withFileLock`. A malformed
 * line throws (fail closed): spend is never understated or silently skipped.
 * Settling is once only per reservation id, so spend is monotone there.
 *
 * K2: every line carries its `consumer` and every settled line its
 * `contextRef`, `latencyMs` and `questionKinds`; a line written before K2
 * without a `consumer` reads as `knowledge-ranking` and its missing envelope
 * fields read as empty, so an existing month file keeps parsing. Outcomes go
 * to a separate file, `<stateDir>/decision-receipts/outcomes-<YYYY-MM>.jsonl`
 * under its own lock, so this parser never meets a line kind it does not know.
 *
 * K4: `readJournal` reads every recorded month of both files for one
 * consumer, each under its own lock, and fails closed on a malformed line
 * of either kind — a report never silently under-reports.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { budgetAllows, containsSecretShape } from '@fleet/shared';
import type {
  AppendDecisionOutcome,
  DecisionCallReceipt,
  DecisionJournalSnapshot,
  DecisionOutcomeKind,
  DecisionOutcomeRecord,
  DecisionReceiptJournalPort,
  ReadDecisionJournalQuery,
  ReserveDecisionQuery,
  ReserveDecisionResult,
  SettledDecisionReceiptRecord,
} from '../../application/ports/out/DecisionReceiptJournalPort.out-port.js';
import { KNOWLEDGE_RANKING_CONSUMER } from '../../application/ports/out/DecisionReceiptJournalPort.out-port.js';
import { withFileLock } from './file-store.js';

/** Own receipts directory; distinct from the owner-decision inbox `decisions/`. */
const RECEIPTS_DIRNAME = 'decision-receipts';

/** A stateSha256 is always a lowercase hex SHA-256 digest. */
const STATE_SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Longest accepted contextRef; the fixed formats are far shorter. */
const MAX_CONTEXT_REF_CHARS = 256;

/** Longest accepted consumer discriminator. */
const MAX_CONSUMER_CHARS = 64;

/** A line written before K2 carries no consumer: it is a ranking receipt. */
const DEFAULT_CONSUMER = KNOWLEDGE_RANKING_CONSUMER;

/** Appended before a call: `{kind:'reserved', id, consumer, assumedCostUsd, stateSha256, at}`. */
interface ReservedEntry {
  readonly kind: 'reserved';
  readonly id: string;
  readonly consumer: string;
  readonly assumedCostUsd: number;
  readonly stateSha256: string;
  readonly at: string;
}

/** Appended after a call: `{kind:'settled', reservationId, ...receipt}` with the cost resolved. */
interface SettledEntry {
  readonly kind: 'settled';
  readonly reservationId: string;
  readonly consumer: string;
  readonly contextRef: string;
  readonly provider: string;
  readonly model: string;
  readonly requestId?: string;
  readonly costUsd: number;
  readonly estimated: boolean;
  readonly questionKinds: readonly string[];
  readonly minConfidenceObserved?: number;
  /**
   * K4: absent on a line written before K2, which carries no measurement —
   * a report reads no latency there, never a fabricated zero.
   */
  readonly latencyMs?: number;
  readonly lexicalOrder: readonly string[];
  readonly decidedOrder: readonly string[];
  readonly unknownReason?: string;
  readonly at: string;
}

type JournalEntry = ReservedEntry | SettledEntry;

export class MalformedReceiptLineError extends Error {
  readonly filePath: string;
  readonly lineNumber: number;

  constructor(filePath: string, lineNumber: number, detail: string) {
    super(`Malformed decision receipt line at ${filePath}:${lineNumber}: ${detail}`);
    this.name = 'MalformedReceiptLineError';
    this.filePath = filePath;
    this.lineNumber = lineNumber;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** `YYYY-MM` for the UTC month containing `date`; never a local month. */
function utcMonthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** `YYYY-MM` for the UTC month before the one containing `date`. */
function previousUtcMonthKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
}

/** Location of a JSONL line, for fail-closed error reporting. */
interface ParseContext {
  readonly filePath: string;
  readonly lineNumber: number;
}

/** A malformed line always throws; spend is never computed from skipped input. */
function malformed(context: ParseContext, detail: string): never {
  throw new MalformedReceiptLineError(context.filePath, context.lineNumber, detail);
}

function requireNonEmptyString(context: ParseContext, value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    malformed(context, `${field} must be a non-empty string`);
  }
  return value;
}

function requireNonNegativeNumber(context: ParseContext, value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    malformed(context, `${field} must be a finite non-negative number`);
  }
  return value;
}

function requireStringArray(context: ParseContext, value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    malformed(context, `${field} must be an array of strings`);
  }
  return [...value];
}

function requireStateSha256(context: ParseContext, value: unknown): string {
  if (typeof value !== 'string' || !STATE_SHA256_PATTERN.test(value)) {
    malformed(context, 'stateSha256 must match /^[0-9a-f]{64}$/');
  }
  return value;
}

/**
 * The consumer of a line written before K2: absent reads as
 * `knowledge-ranking`, so its spend still counts against that sub-budget.
 */
function requireConsumer(context: ParseContext, value: unknown): string {
  if (value === undefined) {
    return DEFAULT_CONSUMER;
  }
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_CONSUMER_CHARS) {
    malformed(context, `consumer must be a non-empty string of at most ${MAX_CONSUMER_CHARS} chars`);
  }
  return value;
}

/** A settled line before K2 carries no contextRef; it joins no outcome. */
function requireContextRef(context: ParseContext, value: unknown): string {
  if (value === undefined) {
    return '';
  }
  return requireNonEmptyString(context, value, 'contextRef');
}

/** A settled line before K2 carries no latency; K4 reads no measurement, not zero. */
function requireLatencyMs(context: ParseContext, value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireNonNegativeNumber(context, value, 'latencyMs');
}

function parseEntry(line: string, filePath: string, lineNumber: number): JournalEntry {
  const context: ParseContext = { filePath, lineNumber };
  if (line.trim().length === 0) {
    malformed(context, 'blank line');
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error: unknown) {
    malformed(context, `invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    malformed(context, 'entry is not a JSON object');
  }
  const entry = value as Record<string, unknown>;
  if (entry.kind === 'reserved') {
    return {
      kind: 'reserved',
      id: requireNonEmptyString(context, entry.id, 'id'),
      consumer: requireConsumer(context, entry.consumer),
      assumedCostUsd: requireNonNegativeNumber(context, entry.assumedCostUsd, 'assumedCostUsd'),
      stateSha256: requireStateSha256(context, entry.stateSha256),
      at: requireNonEmptyString(context, entry.at, 'at'),
    };
  }
  if (entry.kind === 'settled') {
    return {
      kind: 'settled',
      reservationId: requireNonEmptyString(context, entry.reservationId, 'reservationId'),
      consumer: requireConsumer(context, entry.consumer),
      contextRef: requireContextRef(context, entry.contextRef),
      provider: requireNonEmptyString(context, entry.provider, 'provider'),
      model: requireNonEmptyString(context, entry.model, 'model'),
      requestId:
        entry.requestId === undefined
          ? undefined
          : requireNonEmptyString(context, entry.requestId, 'requestId'),
      costUsd: requireNonNegativeNumber(context, entry.costUsd, 'costUsd'),
      estimated:
        typeof entry.estimated === 'boolean'
          ? entry.estimated
          : malformed(context, 'estimated must be a boolean'),
      questionKinds: entry.questionKinds === undefined ? [] : requireStringArray(context, entry.questionKinds, 'questionKinds'),
      minConfidenceObserved:
        entry.minConfidenceObserved === undefined
          ? undefined
          : requireNonNegativeNumber(context, entry.minConfidenceObserved, 'minConfidenceObserved'),
      latencyMs: requireLatencyMs(context, entry.latencyMs),
      // A triage line declares empty orders, so both stay string arrays: the
      // ranking budget never mistakes a triage call for a reordering.
      lexicalOrder: requireStringArray(context, entry.lexicalOrder, 'lexicalOrder'),
      decidedOrder: requireStringArray(context, entry.decidedOrder, 'decidedOrder'),
      unknownReason:
        entry.unknownReason === undefined
          ? undefined
          : requireNonEmptyString(context, entry.unknownReason, 'unknownReason'),
      at: requireNonEmptyString(context, entry.at, 'at'),
    };
  }
  malformed(context, `unknown kind ${JSON.stringify(entry.kind)}`);
}

/** `<YYYY-MM>.jsonl` — a recorded month; lock files end `.lock` and never match. */
const MONTH_FILE_PATTERN = /^\d{4}-\d{2}\.jsonl$/;

/** `outcomes-<YYYY-MM>.jsonl` — a recorded outcomes month. */
const OUTCOME_FILE_PATTERN = /^outcomes-\d{4}-\d{2}\.jsonl$/;

/**
 * The consumer a report reads: a usable declared string, refused never
 * redacted, exactly as the write paths require one.
 */
function requireReadableConsumer(query: ReadDecisionJournalQuery): string {
  if (!query || typeof query !== 'object' || typeof query.consumer !== 'string') {
    throw new Error('FileDecisionReceiptJournalAdapter requires a readJournal query with a consumer');
  }
  const consumer = query.consumer;
  if (consumer.trim().length === 0 || consumer.length > MAX_CONSUMER_CHARS || containsSecretShape(consumer)) {
    throw new Error(
      `FileDecisionReceiptJournalAdapter requires a usable consumer of at most ${MAX_CONSUMER_CHARS} chars`,
    );
  }
  return consumer;
}

/** The public record of one settled line; absent K4 fields stay absent. */
function settledRecordOf(entry: SettledEntry): SettledDecisionReceiptRecord {
  return {
    consumer: entry.consumer,
    contextRef: entry.contextRef,
    provider: entry.provider,
    model: entry.model,
    requestId: entry.requestId,
    costUsd: entry.costUsd,
    estimated: entry.estimated,
    questionKinds: [...entry.questionKinds],
    minConfidenceObserved: entry.minConfidenceObserved,
    latencyMs: entry.latencyMs,
    lexicalOrder: [...entry.lexicalOrder],
    decidedOrder: [...entry.decidedOrder],
    unknownReason: entry.unknownReason,
    at: entry.at,
  };
}

/**
 * Parse one outcome line, fail closed like the budget parser: a report
 * built from skipped or half-parsed lines would under-report what the
 * journal actually recorded. The shape is exactly what `readOutcomeEntry`
 * appends.
 */
function parseOutcomeEntry(line: string, filePath: string, lineNumber: number): DecisionOutcomeRecord {
  const context: ParseContext = { filePath, lineNumber };
  if (line.trim().length === 0) {
    malformed(context, 'blank line');
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error: unknown) {
    malformed(context, `invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    malformed(context, 'outcome is not a JSON object');
  }
  const entry = value as Record<string, unknown>;
  const consumer = requireNonEmptyString(context, entry.consumer, 'consumer');
  if (consumer.length > MAX_CONSUMER_CHARS) {
    malformed(context, `consumer must be at most ${MAX_CONSUMER_CHARS} chars`);
  }
  const contextRef = requireNonEmptyString(context, entry.contextRef, 'contextRef');
  if (contextRef.length > MAX_CONTEXT_REF_CHARS) {
    malformed(context, `contextRef must be at most ${MAX_CONTEXT_REF_CHARS} chars`);
  }
  const kind = entry.kind;
  if (typeof kind !== 'string' || !OUTCOME_KINDS.includes(kind as DecisionOutcomeKind)) {
    malformed(context, `unknown outcome kind ${JSON.stringify(kind)}`);
  }
  const ids = requireStringArray(context, entry.value, 'value');
  if (ids.length === 0 || ids.some((id) => id.trim().length === 0)) {
    malformed(context, 'value must be a non-empty array of non-empty strings');
  }
  const at = requireNonEmptyString(context, entry.at, 'at');
  if (Number.isNaN(Date.parse(at))) {
    malformed(context, 'at must be an ISO 8601 instant');
  }
  return { consumer, contextRef, kind: kind as DecisionOutcomeKind, value: ids, at };
}

/** The month's spend, in total and per consumer, from one set of entries. */
interface MonthSpend {
  readonly total: number;
  /** Keyed by consumer; entries without one count as `knowledge-ranking`. */
  readonly byConsumer: ReadonlyMap<string, number>;
}

/**
 * Month-to-date spend: the settled cost where a settled entry exists for a
 * reservation id, otherwise the reserved assumed cost. A settled entry whose
 * reservation lives in an earlier month's file still counts here, so a paid
 * call is never invisible to the budget.
 */
function monthSpendFromEntries(entries: readonly JournalEntry[]): MonthSpend {
  const reservedCostById = new Map<string, { cost: number; consumer: string }>();
  const settledCostByReservationId = new Map<
    string,
    { cost: number; consumer: string }
  >();
  for (const entry of entries) {
    if (entry.kind === 'reserved') {
      reservedCostById.set(entry.id, { cost: entry.assumedCostUsd, consumer: entry.consumer });
    } else {
      settledCostByReservationId.set(entry.reservationId, {
        cost: entry.costUsd,
        consumer: entry.consumer,
      });
    }
  }
  const byConsumer = new Map<string, number>();
  const addTo = (consumer: string, cost: number): void => {
    byConsumer.set(consumer, (byConsumer.get(consumer) ?? 0) + cost);
  };
  let total = 0;
  for (const [id, reservation] of reservedCostById) {
    const settled = settledCostByReservationId.get(id);
    const cost = settled?.cost ?? reservation.cost;
    total += cost;
    // A settled line's own consumer wins: it is the one the call settled as.
    addTo(settled?.consumer ?? reservation.consumer, cost);
  }
  for (const [id, settled] of settledCostByReservationId) {
    if (!reservedCostById.has(id)) {
      total += settled.cost;
      addTo(settled.consumer, settled.cost);
    }
  }
  return { total, byConsumer };
}

function requireValidatedQuery(query: ReserveDecisionQuery): {
  consumer: string;
  assumedCostUsd: number;
  monthlyBudgetUsd: number;
  consumerBudgetUsd?: number;
  stateSha256: string;
} {
  if (!query || typeof query !== 'object') {
    throw new Error('FileDecisionReceiptJournalAdapter requires a reserve query');
  }
  const { assumedCostUsd, monthlyBudgetUsd, stateSha256 } = query;
  if (typeof assumedCostUsd !== 'number' || !Number.isFinite(assumedCostUsd) || assumedCostUsd < 0) {
    throw new Error('FileDecisionReceiptJournalAdapter requires a finite non-negative assumedCostUsd');
  }
  if (
    typeof monthlyBudgetUsd !== 'number' ||
    !Number.isFinite(monthlyBudgetUsd) ||
    monthlyBudgetUsd < 0
  ) {
    throw new Error('FileDecisionReceiptJournalAdapter requires a finite non-negative monthlyBudgetUsd');
  }
  if (
    query.consumerBudgetUsd !== undefined &&
    (typeof query.consumerBudgetUsd !== 'number' ||
      !Number.isFinite(query.consumerBudgetUsd) ||
      query.consumerBudgetUsd <= 0)
  ) {
    throw new Error(
      'FileDecisionReceiptJournalAdapter requires a consumerBudgetUsd greater than 0',
    );
  }
  if (typeof stateSha256 !== 'string' || !STATE_SHA256_PATTERN.test(stateSha256)) {
    throw new Error(
      'FileDecisionReceiptJournalAdapter requires stateSha256 to match /^[0-9a-f]{64}$/',
    );
  }
  const consumer = query.consumer ?? DEFAULT_CONSUMER;
  if (typeof consumer !== 'string' || consumer.trim().length === 0 || consumer.length > MAX_CONSUMER_CHARS) {
    throw new Error(
      `FileDecisionReceiptJournalAdapter requires a consumer of at most ${MAX_CONSUMER_CHARS} chars`,
    );
  }
  return {
    consumer,
    assumedCostUsd,
    monthlyBudgetUsd,
    ...(query.consumerBudgetUsd === undefined ? {} : { consumerBudgetUsd: query.consumerBudgetUsd }),
    stateSha256,
  };
}

/** A caller receipt with its declared fields validated; `costUsd` stays optional. */
interface ValidatedReceipt {
  readonly consumer: string;
  readonly contextRef: string;
  readonly provider: string;
  readonly model: string;
  readonly requestId?: string;
  readonly costUsd?: number;
  readonly questionKinds: readonly string[];
  readonly minConfidenceObserved?: number;
  readonly latencyMs: number;
  readonly lexicalOrder: readonly string[];
  readonly decidedOrder: readonly string[];
  readonly unknownReason?: string;
}

function requireDeclaredText(value: unknown, field: string, maxChars: number): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maxChars ||
    containsSecretShape(value)
  ) {
    throw new Error(`FileDecisionReceiptJournalAdapter requires a usable ${field}`);
  }
  return value;
}

function requireValidatedReceipt(
  reservationId: string,
  receipt: DecisionCallReceipt,
): ValidatedReceipt {
  if (typeof reservationId !== 'string' || reservationId.trim().length === 0) {
    throw new Error('FileDecisionReceiptJournalAdapter requires a non-empty reservationId');
  }
  if (!receipt || typeof receipt !== 'object') {
    throw new Error(`FileDecisionReceiptJournalAdapter requires a receipt for reservation ${reservationId}`);
  }
  const requireText = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`FileDecisionReceiptJournalAdapter requires a non-empty ${field}`);
    }
    return value;
  };
  const failField = (detail: string): never => {
    throw new Error(`FileDecisionReceiptJournalAdapter ${detail}`);
  };
  const optionalText = (value: unknown, field: string): string | undefined =>
    value === undefined ? undefined : requireText(value, field);
  const optionalCost =
    receipt.costUsd === undefined
      ? undefined
      : typeof receipt.costUsd === 'number' && Number.isFinite(receipt.costUsd) && receipt.costUsd >= 0
        ? receipt.costUsd
        : failField('costUsd must be a finite non-negative number');
  const requireIds = (value: readonly string[], field: string): readonly string[] => {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new Error(`FileDecisionReceiptJournalAdapter requires ${field} to be an array of strings`);
    }
    return value;
  };
  if (typeof receipt.latencyMs !== 'number' || !Number.isFinite(receipt.latencyMs) || receipt.latencyMs < 0) {
    failField('latencyMs must be a finite non-negative number');
  }
  const minConfidenceObserved =
    receipt.minConfidenceObserved === undefined
      ? undefined
      : typeof receipt.minConfidenceObserved === 'number' &&
          Number.isFinite(receipt.minConfidenceObserved) &&
          receipt.minConfidenceObserved >= 0 &&
          receipt.minConfidenceObserved <= 1
        ? receipt.minConfidenceObserved
        : failField('minConfidenceObserved must be a number in [0,1]');
  return {
    consumer: requireDeclaredText(receipt.consumer, 'consumer', MAX_CONSUMER_CHARS),
    contextRef: requireDeclaredText(receipt.contextRef, 'contextRef', MAX_CONTEXT_REF_CHARS),
    provider: requireText(receipt.provider, 'provider'),
    model: requireText(receipt.model, 'model'),
    requestId: optionalText(receipt.requestId, 'requestId'),
    costUsd: optionalCost,
    questionKinds: requireIds(receipt.questionKinds, 'questionKinds'),
    ...(minConfidenceObserved === undefined ? {} : { minConfidenceObserved }),
    latencyMs: receipt.latencyMs,
    lexicalOrder: requireIds(receipt.lexicalOrder, 'lexicalOrder'),
    decidedOrder: requireIds(receipt.decidedOrder, 'decidedOrder'),
    unknownReason: optionalText(receipt.unknownReason, 'unknownReason'),
  };
}

/** Appended to the outcomes file: `{consumer, contextRef, kind, value, at}`. */
interface OutcomeEntry {
  readonly consumer: string;
  readonly contextRef: string;
  readonly kind: DecisionOutcomeKind;
  readonly value: readonly string[];
  readonly at: string;
}

const OUTCOME_KINDS: readonly DecisionOutcomeKind[] = ['ranking-selection', 'triage-disposition'];

export class FileDecisionReceiptJournalAdapter implements DecisionReceiptJournalPort {
  private readonly stateDir: string;
  private readonly now: () => Date;
  private readonly lockTimeoutMs: number | undefined;

  constructor(
    stateDir: string,
    now: () => Date = () => new Date(),
    options: { readonly lockTimeoutMs?: number } = {},
  ) {
    if (typeof stateDir !== 'string' || stateDir.trim().length === 0) {
      throw new Error('FileDecisionReceiptJournalAdapter requires a non-empty stateDir');
    }
    if (typeof now !== 'function') {
      throw new Error('FileDecisionReceiptJournalAdapter requires a now() clock');
    }
    if (
      options.lockTimeoutMs !== undefined &&
      (typeof options.lockTimeoutMs !== 'number' ||
        !Number.isFinite(options.lockTimeoutMs) ||
        options.lockTimeoutMs <= 0)
    ) {
      throw new Error('FileDecisionReceiptJournalAdapter requires a positive finite lockTimeoutMs');
    }
    this.stateDir = stateDir;
    this.now = now;
    // undefined keeps withFileLock's own default timeout.
    this.lockTimeoutMs = options.lockTimeoutMs;
  }

  private lockOptions(): { readonly timeoutMs: number } | undefined {
    return this.lockTimeoutMs === undefined ? undefined : { timeoutMs: this.lockTimeoutMs };
  }

  async reserve(query: ReserveDecisionQuery): Promise<ReserveDecisionResult> {
    const validated = requireValidatedQuery(query);
    const atDate = this.now();
    const monthKey = utcMonthKey(atDate);
    const reservationId = randomUUID();
    return withFileLock(
      this.monthLockPath(monthKey),
      async () => {
        // Both sums are read under the one month lock, so the sub-budget and
        // the total are judged against the same snapshot.
        const spend = monthSpendFromEntries(await this.readMonthEntries(monthKey));
        // Refuse at or above the cap (owner, 2026-10-16): spend never reaches
        // the budget exactly. A consumer without a sub-budget has no clause.
        const allowed = budgetAllows({
          consumerSpend: spend.byConsumer.get(validated.consumer) ?? 0,
          ...(validated.consumerBudgetUsd === undefined
            ? {}
            : { consumerBudget: validated.consumerBudgetUsd }),
          totalSpend: spend.total,
          totalBudget: validated.monthlyBudgetUsd,
          assumedCost: validated.assumedCostUsd,
        });
        if (!allowed.ok) {
          return { ok: false as const, reason: 'budget-exhausted' as const };
        }
        const entry: ReservedEntry = {
          kind: 'reserved',
          id: reservationId,
          consumer: validated.consumer,
          assumedCostUsd: validated.assumedCostUsd,
          stateSha256: validated.stateSha256,
          at: atDate.toISOString(),
        };
        await this.appendEntry(monthKey, entry);
        return { ok: true as const, reservationId };
      },
      this.lockOptions(),
    );
  }

  async settle(reservationId: string, receipt: DecisionCallReceipt): Promise<void> {
    const validated = requireValidatedReceipt(reservationId, receipt);
    const atDate = this.now();
    const monthKey = utcMonthKey(atDate);
    await withFileLock(
      this.monthLockPath(monthKey),
      async () => {
      // The reservation is always resolved, whether or not the receipt
      // reports a cost: the current month's file first, then the previous
      // month's (a call may cross a UTC month boundary between reserve and
      // settle).
      const monthEntries = await this.readMonthEntries(monthKey);
      let previousEntries: JournalEntry[] = [];
      let reservation: ReservedEntry | undefined = findReservedEntry(monthEntries, reservationId);
      if (!reservation) {
        previousEntries = await this.readMonthEntries(previousUtcMonthKey(atDate));
        reservation = findReservedEntry(previousEntries, reservationId);
      }
      if (!reservation) {
        throw new Error(
          `FileDecisionReceiptJournalAdapter cannot settle unknown reservation ${reservationId}`,
        );
      }
      // Settling is once only: spend stays monotone per reservation.
      if (
        findSettledEntry(monthEntries, reservationId) !== undefined ||
        findSettledEntry(previousEntries, reservationId) !== undefined
      ) {
        throw new Error(
          `FileDecisionReceiptJournalAdapter reservation ${reservationId} is already settled`,
        );
      }
      // No reported cost: record the reservation's assumed cost, marked
      // estimated. The check-and-append above runs inside this month's lock.
      const costUsd = validated.costUsd ?? reservation.assumedCostUsd;
      const estimated = validated.costUsd === undefined;
      const entry: SettledEntry = {
        kind: 'settled',
        reservationId,
        consumer: validated.consumer,
        contextRef: validated.contextRef,
        provider: validated.provider,
        model: validated.model,
        requestId: validated.requestId,
        costUsd,
        estimated,
        questionKinds: [...validated.questionKinds],
        minConfidenceObserved: validated.minConfidenceObserved,
        latencyMs: validated.latencyMs,
        lexicalOrder: [...validated.lexicalOrder],
        decidedOrder: [...validated.decidedOrder],
        unknownReason: validated.unknownReason,
        at: atDate.toISOString(),
      };
      await this.appendEntry(monthKey, entry);
      },
      this.lockOptions(),
    );
  }

  async monthSpendUsd(monthUtc: Date): Promise<number> {
    if (!(monthUtc instanceof Date) || Number.isNaN(monthUtc.getTime())) {
      throw new Error('FileDecisionReceiptJournalAdapter requires a valid monthUtc Date');
    }
    const monthKey = utcMonthKey(monthUtc);
    // Lock the pure read too: a concurrent append must never be observed as a
    // torn (malformed) line, and malformed lines fail closed.
    return withFileLock(
      this.monthLockPath(monthKey),
      async () => {
        const entries = await this.readMonthEntries(monthKey);
        return monthSpendFromEntries(entries).total;
      },
      this.lockOptions(),
    );
  }

  /**
   * Best effort by contract: a contextRef with no settled receipt is skipped,
   * and no read, lock, parse or append failure ever reaches the caller — the
   * operation the outcome describes must not fail because it was not recorded.
   *
   * The budget file is read under the month lock it is appended to, and under
   * the previous month's: a concurrent reserve or settle must never be observed
   * mid-append as a torn line. The outcomes lock is always taken first and the
   * month locks in a fixed order, so no two paths can wait on each other.
   */
  async appendOutcome(outcome: AppendDecisionOutcome): Promise<void> {
    const entry = this.readOutcomeEntry(outcome);
    if (entry === null) {
      return;
    }
    const atDate = this.now();
    const monthKey = utcMonthKey(atDate);
    try {
      await withFileLock(
        this.outcomesLockPath(monthKey),
        async () => {
          await withFileLock(
            this.monthLockPath(monthKey),
            async () => {
              await withFileLock(
                this.monthLockPath(previousUtcMonthKey(atDate)),
                async () => {
                  if (!(await this.hasSettledReceipt(entry.contextRef, atDate))) {
                    // No settled receipt for this reference: nothing was decided
                    // by a call, so there is no outcome to join.
                    return;
                  }
                  await fs.appendFile(
                    this.outcomesFilePath(monthKey),
                    `${JSON.stringify(entry)}\n`,
                    'utf8',
                  );
                },
                this.lockOptions(),
              );
            },
            this.lockOptions(),
          );
        },
        this.lockOptions(),
      );
    } catch {
      // Recording an outcome is never worth failing the caller's own work.
    }
  }

  /** Declared, bounded fields only; anything unusable is skipped, never thrown. */
  private readOutcomeEntry(outcome: AppendDecisionOutcome): OutcomeEntry | null {
    if (!outcome || typeof outcome !== 'object') {
      return null;
    }
    const { consumer, contextRef, kind, value, at } = outcome;
    if (!isBoundedText(consumer, MAX_CONSUMER_CHARS) || !isBoundedText(contextRef, MAX_CONTEXT_REF_CHARS)) {
      return null;
    }
    if (!OUTCOME_KINDS.includes(kind)) {
      return null;
    }
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.some((item) => typeof item !== 'string' || item.trim().length === 0) ||
      containsSecretShape(JSON.stringify(value))
    ) {
      return null;
    }
    if (typeof at !== 'string' || at.trim().length === 0 || Number.isNaN(Date.parse(at))) {
      return null;
    }
    return { consumer, contextRef, kind, value: [...value], at };
  }

  /**
   * K4: one consumer's whole recorded history, every month of both files,
   * each read under its own lock (never nested, so nothing can wait on this
   * read). A malformed line of either kind throws, exactly as the budget
   * parser does: a report built from skipped lines would under-report.
   */
  async readJournal(query: ReadDecisionJournalQuery): Promise<DecisionJournalSnapshot> {
    const consumer = requireReadableConsumer(query);
    const receipts: SettledDecisionReceiptRecord[] = [];
    const outcomes: DecisionOutcomeRecord[] = [];
    for (const monthKey of await this.listMonthKeys()) {
      // Each month is read under its own month lock, like monthSpendUsd:
      // a concurrent append must never be observed as a torn line.
      const entries = await withFileLock(
        this.monthLockPath(monthKey),
        async () => this.readMonthEntries(monthKey),
        this.lockOptions(),
      );
      for (const entry of entries) {
        if (entry.kind === 'settled' && entry.consumer === consumer) {
          receipts.push(settledRecordOf(entry));
        }
      }
    }
    for (const monthKey of await this.listOutcomeMonthKeys()) {
      const monthOutcomes = await withFileLock(
        this.outcomesLockPath(monthKey),
        async () => this.readOutcomeEntries(monthKey),
        this.lockOptions(),
      );
      for (const outcome of monthOutcomes) {
        if (outcome.consumer === consumer) {
          outcomes.push(outcome);
        }
      }
    }
    return { receipts, outcomes };
  }

  /** Every recorded `<YYYY-MM>.jsonl` month, oldest first; none when the directory is absent. */
  private async listMonthKeys(): Promise<string[]> {
    const names = await this.listReceiptsDir();
    return names
      .filter((name) => MONTH_FILE_PATTERN.test(name))
      .sort()
      .map((name) => name.slice(0, name.length - '.jsonl'.length));
  }

  /** Every recorded `outcomes-<YYYY-MM>.jsonl` month, oldest first. */
  private async listOutcomeMonthKeys(): Promise<string[]> {
    const names = await this.listReceiptsDir();
    return names
      .filter((name) => OUTCOME_FILE_PATTERN.test(name))
      .sort()
      .map((name) => name.slice('outcomes-'.length, name.length - '.jsonl'.length));
  }

  /** The receipts directory listing; empty when nothing was ever recorded. */
  private async listReceiptsDir(): Promise<string[]> {
    try {
      return await fs.readdir(path.join(this.stateDir, RECEIPTS_DIRNAME), 'utf8');
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: string }).code === 'ENOENT'
      ) {
        return [];
      }
      throw error;
    }
  }

  /** Parse one outcomes file; a malformed line throws with its location. */
  private async readOutcomeEntries(monthKey: string): Promise<DecisionOutcomeRecord[]> {
    const filePath = this.outcomesFilePath(monthKey);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: string }).code === 'ENOENT'
      ) {
        return [];
      }
      throw error;
    }
    const lines = raw.split('\n');
    // A single trailing '' is the file's final newline, not a blank line.
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines.map((line, index) => parseOutcomeEntry(line, filePath, index + 1));
  }

  /** A settled line for this reference in this month or the one before it. */
  private async hasSettledReceipt(contextRef: string, atDate: Date): Promise<boolean> {
    const settled = (entries: readonly JournalEntry[]): boolean =>
      findSettledByContextRef(entries, contextRef) !== undefined;
    if (settled(await this.readMonthEntries(utcMonthKey(atDate)))) {
      return true;
    }
    return settled(await this.readMonthEntries(previousUtcMonthKey(atDate)));
  }

  /** `<stateDir>/decision-receipts/<YYYY-MM>.jsonl` — never the owner-decision inbox. */
  private monthFilePath(monthKey: string): string {
    return path.join(this.stateDir, RECEIPTS_DIRNAME, `${monthKey}.jsonl`);
  }

  private monthLockPath(monthKey: string): string {
    return `${this.monthFilePath(monthKey)}.lock`;
  }

  /** Outcomes live in their own file under their own lock (plan §3). */
  private outcomesFilePath(monthKey: string): string {
    return path.join(this.stateDir, RECEIPTS_DIRNAME, `outcomes-${monthKey}.jsonl`);
  }

  private outcomesLockPath(monthKey: string): string {
    return `${this.outcomesFilePath(monthKey)}.lock`;
  }

  private async readMonthEntries(monthKey: string): Promise<JournalEntry[]> {
    const filePath = this.monthFilePath(monthKey);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: string }).code === 'ENOENT'
      ) {
        return [];
      }
      throw error;
    }
    const lines = raw.split('\n');
    // A single trailing '' is the file's final newline, not a blank line.
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines.map((line, index) => parseEntry(line, filePath, index + 1));
  }

  private async appendEntry(monthKey: string, entry: JournalEntry): Promise<void> {
    // The receipts directory exists by the time this runs: acquiring the lock
    // creates it (withFileLock mkdirs the lock file's directory).
    await fs.appendFile(this.monthFilePath(monthKey), `${JSON.stringify(entry)}\n`, 'utf8');
  }
}

/** A declared string that is non-empty, bounded and not credential-shaped. */
function isBoundedText(value: unknown, maxChars: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxChars &&
    !containsSecretShape(value)
  );
}

function findReservedEntry(
  entries: readonly JournalEntry[],
  reservationId: string,
): ReservedEntry | undefined {
  let found: ReservedEntry | undefined;
  for (const entry of entries) {
    if (entry.kind === 'reserved' && entry.id === reservationId) {
      found = entry;
    }
  }
  return found;
}

function findSettledEntry(
  entries: readonly JournalEntry[],
  reservationId: string,
): SettledEntry | undefined {
  let found: SettledEntry | undefined;
  for (const entry of entries) {
    if (entry.kind === 'settled' && entry.reservationId === reservationId) {
      found = entry;
    }
  }
  return found;
}

/** The settled receipt an outcome line joins on. */
function findSettledByContextRef(
  entries: readonly JournalEntry[],
  contextRef: string,
): SettledEntry | undefined {
  let found: SettledEntry | undefined;
  for (const entry of entries) {
    if (entry.kind === 'settled' && entry.contextRef === contextRef) {
      found = entry;
    }
  }
  return found;
}
