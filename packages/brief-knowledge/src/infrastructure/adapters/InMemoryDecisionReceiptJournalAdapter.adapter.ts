// Implemented for lane K4 (decision-kernel plan, 2026-10-16, §4).
/**
 * InMemoryDecisionReceiptJournalAdapter implements DecisionReceiptJournalPort
 * (in-memory-receipt-journal): the whole journal contract without a
 * filesystem, for disposable processes and tests. It mirrors the file
 * adapter's rules exactly — reserve refuses at the cap, settling is once
 * only, an unknown reservation cannot settle, an outcome joins only a
 * settled receipt of its own consumer and is skipped silently otherwise —
 * but nothing survives the process. It is never a stand-in for a durable
 * store: an installation without a state dir still makes no decision
 * (invariant 5), so `createRankingAdvice` keeps refusing through
 * NotConfiguredReceiptJournal there.
 */

import { randomUUID } from "node:crypto";
import { types } from "node:util";
import { budgetAllows, containsSecretShape } from "@fleet/shared";
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
} from "../../application/ports/out/DecisionReceiptJournalPort.out-port.js";
import { KNOWLEDGE_RANKING_CONSUMER } from "../../application/ports/out/DecisionReceiptJournalPort.out-port.js";

/** Longest accepted contextRef; the fixed formats are far shorter. */
const MAX_CONTEXT_REF_CHARS = 256;

/** Longest accepted consumer discriminator. */
const MAX_CONSUMER_CHARS = 64;

/** A stateSha256 is always a lowercase hex SHA-256 digest. */
const STATE_SHA256_PATTERN = /^[0-9a-f]{64}$/;

const OUTCOME_KINDS: readonly DecisionOutcomeKind[] = [
  "ranking-selection",
  "triage-disposition",
];

interface ReservedLine {
  readonly id: string;
  readonly consumer: string;
  readonly assumedCostUsd: number;
  readonly stateSha256: string;
  readonly at: string;
}

interface SettledLine {
  readonly reservationId: string;
  readonly consumer: string;
  readonly contextRef: string;
  readonly costUsd: number;
  readonly estimated: boolean;
  readonly at: string;
  readonly record: SettledDecisionReceiptRecord;
}

/** `YYYY-MM` for the UTC month containing `date`; never a local month. */
function utcMonthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** A declared string that is non-empty, bounded and not credential-shaped. */
function isBoundedText(value: unknown, maxChars: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxChars &&
    !containsSecretShape(value)
  );
}

/** Own keys that would let a hostile input reach the prototype chain. */
const POLLUTING_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** A canonical array index: no sign, no leading zero, no fraction. */
const CANONICAL_INDEX = /^(?:0|[1-9][0-9]*)$/;

/** The declared fields each adapter method reads from its input. */
const NO_FIELDS: readonly string[] = [];
const RESERVE_SCALARS: readonly string[] = [
  "consumer",
  "assumedCostUsd",
  "monthlyBudgetUsd",
  "consumerBudgetUsd",
  "stateSha256",
];
const READ_SCALARS: readonly string[] = ["consumer"];
const RECEIPT_SCALARS: readonly string[] = [
  "consumer",
  "contextRef",
  "provider",
  "model",
  "requestId",
  "costUsd",
  "minConfidenceObserved",
  "latencyMs",
  "unknownReason",
];
const RECEIPT_ARRAYS: readonly string[] = [
  "questionKinds",
  "lexicalOrder",
  "decidedOrder",
];
const OUTCOME_SCALARS: readonly string[] = [
  "consumer",
  "contextRef",
  "kind",
  "at",
];
const OUTCOME_ARRAYS: readonly string[] = ["value"];

/** True for a Proxy, and for anything whose proxy-ness cannot be told. */
function isProxyOrUnknown(value: unknown): boolean {
  try {
    return types.isProxy(value);
  } catch {
    return true;
  }
}

/**
 * Copy a dense array of strings without invoking a getter or a Proxy trap.
 * Returns null for a Proxy, an array-like, a subclassed array, a sparse array,
 * an accessor or non-enumerable element, an extra own key or a non-string element.
 */
function copyDenseStringArray(value: object): string[] | null {
  if (
    isProxyOrUnknown(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    return null;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.get !== undefined ||
    lengthDescriptor.set !== undefined
  ) {
    return null;
  }
  const length: unknown = lengthDescriptor.value;
  if (typeof length !== "number" || !Number.isInteger(length) || length < 0) {
    return null;
  }
  // Exactly `length` canonical indices plus `length` itself: no hole, no extra key.
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1) {
    return null;
  }
  for (const key of keys) {
    if (key === "length") {
      continue;
    }
    if (
      typeof key !== "string" ||
      !CANONICAL_INDEX.test(key) ||
      Number(key) >= length
    ) {
      return null;
    }
  }
  const copy: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true ||
      typeof descriptor.value !== "string"
    ) {
      return null;
    }
    copy.push(descriptor.value);
  }
  return copy;
}

/**
 * Snapshot the declared own data fields of a plain object. Refuses (null) a
 * Proxy, an array, a non-plain prototype, a symbol or prototype-polluting
 * key, and any accessor or non-enumerable property, all by descriptor and
 * never by reading a value, so no getter or trap runs. Undeclared keys are
 * checked but their values are never read into the snapshot.
 */
function snapshotDeclaredFields<T>(
  value: object,
  scalarFields: readonly string[],
  arrayFields: readonly string[],
): T | null {
  if (isProxyOrUnknown(value) || Array.isArray(value)) {
    return null;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return null;
  }
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || POLLUTING_KEYS.has(key)) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true
    ) {
      return null;
    }
    const field: unknown = descriptor.value;
    if (arrayFields.includes(key)) {
      if (typeof field === "object" && field !== null) {
        const copy = copyDenseStringArray(field);
        if (copy === null) {
          return null;
        }
        snapshot[key] = copy;
      } else {
        snapshot[key] = field;
      }
    } else if (scalarFields.includes(key)) {
      if (
        (typeof field === "object" && field !== null) ||
        typeof field === "function" ||
        typeof field === "symbol"
      ) {
        return null;
      }
      snapshot[key] = field;
    }
  }
  return snapshot as unknown as T;
}

export class InMemoryDecisionReceiptJournalAdapter implements DecisionReceiptJournalPort {
  private readonly reserved: ReservedLine[] = [];
  private readonly settled: SettledLine[] = [];
  private readonly outcomes: DecisionOutcomeRecord[] = [];
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    if (typeof now !== "function") {
      throw new Error(
        "InMemoryDecisionReceiptJournalAdapter requires a now() clock",
      );
    }
    this.now = now;
  }

  async reserve(
    rawQuery: ReserveDecisionQuery,
  ): Promise<ReserveDecisionResult> {
    if (!rawQuery || typeof rawQuery !== "object") {
      throw new Error(
        "InMemoryDecisionReceiptJournalAdapter requires a reserve query",
      );
    }
    const query = snapshotDeclaredFields<ReserveDecisionQuery>(
      rawQuery,
      RESERVE_SCALARS,
      NO_FIELDS,
    );
    if (query === null) {
      throw new Error(
        "InMemoryDecisionReceiptJournalAdapter refuses a reserve query that is not plain data",
      );
    }
    const consumer = query.consumer ?? KNOWLEDGE_RANKING_CONSUMER;
    if (!isBoundedText(consumer, MAX_CONSUMER_CHARS)) {
      throw new Error(
        `InMemoryDecisionReceiptJournalAdapter requires a consumer of at most ${MAX_CONSUMER_CHARS} chars`,
      );
    }
    if (
      typeof query.assumedCostUsd !== "number" ||
      !Number.isFinite(query.assumedCostUsd) ||
      query.assumedCostUsd < 0
    ) {
      throw new Error(
        "InMemoryDecisionReceiptJournalAdapter requires a finite non-negative assumedCostUsd",
      );
    }
    if (
      typeof query.monthlyBudgetUsd !== "number" ||
      !Number.isFinite(query.monthlyBudgetUsd) ||
      query.monthlyBudgetUsd < 0
    ) {
      throw new Error(
        "InMemoryDecisionReceiptJournalAdapter requires a finite non-negative monthlyBudgetUsd",
      );
    }
    if (
      query.consumerBudgetUsd !== undefined &&
      (typeof query.consumerBudgetUsd !== "number" ||
        !Number.isFinite(query.consumerBudgetUsd) ||
        query.consumerBudgetUsd <= 0)
    ) {
      throw new Error(
        "InMemoryDecisionReceiptJournalAdapter requires a consumerBudgetUsd greater than 0",
      );
    }
    if (
      typeof query.stateSha256 !== "string" ||
      !STATE_SHA256_PATTERN.test(query.stateSha256)
    ) {
      throw new Error(
        "InMemoryDecisionReceiptJournalAdapter requires stateSha256 to match /^[0-9a-f]{64}$/",
      );
    }

    const atDate = this.now();
    const monthKey = utcMonthKey(atDate);
    const spend = this.monthSpend(monthKey);
    // The same at-the-cap comparison the file journal runs under its lock.
    const allowed = budgetAllows({
      consumerSpend: spend.byConsumer.get(consumer) ?? 0,
      ...(query.consumerBudgetUsd === undefined
        ? {}
        : { consumerBudget: query.consumerBudgetUsd }),
      totalSpend: spend.total,
      totalBudget: query.monthlyBudgetUsd,
      assumedCost: query.assumedCostUsd,
    });
    if (!allowed.ok) {
      return { ok: false, reason: "budget-exhausted" };
    }
    const reservationId = randomUUID();
    this.reserved.push({
      id: reservationId,
      consumer,
      assumedCostUsd: query.assumedCostUsd,
      stateSha256: query.stateSha256,
      at: atDate.toISOString(),
    });
    return { ok: true, reservationId };
  }

  async settle(
    reservationId: string,
    rawReceipt: DecisionCallReceipt,
  ): Promise<void> {
    if (
      typeof reservationId !== "string" ||
      reservationId.trim().length === 0
    ) {
      throw new Error(
        "InMemoryDecisionReceiptJournalAdapter requires a non-empty reservationId",
      );
    }
    if (!rawReceipt || typeof rawReceipt !== "object") {
      throw new Error(
        `InMemoryDecisionReceiptJournalAdapter requires a receipt for reservation ${reservationId}`,
      );
    }
    const receipt = snapshotDeclaredFields<DecisionCallReceipt>(
      rawReceipt,
      RECEIPT_SCALARS,
      RECEIPT_ARRAYS,
    );
    if (receipt === null) {
      throw new Error(
        "InMemoryDecisionReceiptJournalAdapter refuses a receipt that is not plain data",
      );
    }
    const consumer = receipt.consumer;
    if (!isBoundedText(consumer, MAX_CONSUMER_CHARS)) {
      throw new Error(
        "InMemoryDecisionReceiptJournalAdapter requires a usable consumer",
      );
    }
    const contextRef = receipt.contextRef;
    if (!isBoundedText(contextRef, MAX_CONTEXT_REF_CHARS)) {
      throw new Error(
        "InMemoryDecisionReceiptJournalAdapter requires a usable contextRef",
      );
    }
    if (
      typeof receipt.latencyMs !== "number" ||
      !Number.isFinite(receipt.latencyMs) ||
      receipt.latencyMs < 0
    ) {
      throw new Error(
        "InMemoryDecisionReceiptJournalAdapter requires a finite non-negative latencyMs",
      );
    }
    const requireIds = (
      value: readonly string[],
      field: string,
    ): readonly string[] => {
      if (
        !Array.isArray(value) ||
        value.some((item) => typeof item !== "string")
      ) {
        throw new Error(
          `InMemoryDecisionReceiptJournalAdapter requires ${field} to be an array of strings`,
        );
      }
      return value;
    };
    requireIds(receipt.lexicalOrder, "lexicalOrder");
    requireIds(receipt.decidedOrder, "decidedOrder");
    requireIds(receipt.questionKinds, "questionKinds");
    if (receipt.minConfidenceObserved !== undefined) {
      const confidence = receipt.minConfidenceObserved;
      if (
        typeof confidence !== "number" ||
        !Number.isFinite(confidence) ||
        confidence < 0 ||
        confidence > 1
      ) {
        throw new Error(
          "InMemoryDecisionReceiptJournalAdapter requires minConfidenceObserved in [0,1]",
        );
      }
    }
    if (
      receipt.unknownReason !== undefined &&
      !isBoundedText(receipt.unknownReason, 256)
    ) {
      throw new Error(
        "InMemoryDecisionReceiptJournalAdapter requires a usable unknownReason",
      );
    }
    if (
      receipt.costUsd !== undefined &&
      (typeof receipt.costUsd !== "number" ||
        !Number.isFinite(receipt.costUsd) ||
        receipt.costUsd < 0)
    ) {
      throw new Error(
        "InMemoryDecisionReceiptJournalAdapter requires a finite non-negative costUsd",
      );
    }
    const reservation = this.reserved.find((line) => line.id === reservationId);
    if (reservation === undefined) {
      throw new Error(
        `InMemoryDecisionReceiptJournalAdapter cannot settle unknown reservation ${reservationId}`,
      );
    }
    if (this.settled.some((line) => line.reservationId === reservationId)) {
      throw new Error(
        `InMemoryDecisionReceiptJournalAdapter reservation ${reservationId} is already settled`,
      );
    }
    const costUsd = receipt.costUsd ?? reservation.assumedCostUsd;
    const estimated = receipt.costUsd === undefined;
    const record: SettledDecisionReceiptRecord = {
      consumer,
      contextRef,
      provider: receipt.provider,
      model: receipt.model,
      requestId: receipt.requestId,
      costUsd,
      estimated,
      questionKinds: [...receipt.questionKinds],
      minConfidenceObserved: receipt.minConfidenceObserved,
      latencyMs: receipt.latencyMs,
      lexicalOrder: [...receipt.lexicalOrder],
      decidedOrder: [...receipt.decidedOrder],
      unknownReason: receipt.unknownReason,
      at: this.now().toISOString(),
    };
    this.settled.push({
      reservationId,
      consumer,
      contextRef,
      costUsd,
      estimated,
      at: record.at,
      record,
    });
  }

  async monthSpendUsd(monthUtc: Date): Promise<number> {
    if (!(monthUtc instanceof Date) || Number.isNaN(monthUtc.getTime())) {
      throw new Error(
        "InMemoryDecisionReceiptJournalAdapter requires a valid monthUtc Date",
      );
    }
    return this.monthSpend(utcMonthKey(monthUtc)).total;
  }

  /**
   * Best effort like the file journal: an outcome joins only a settled
   * receipt of its own consumer, is skipped silently without one, and an
   * unusable outcome is skipped rather than thrown.
   */
  async appendOutcome(outcome: AppendDecisionOutcome): Promise<void> {
    const entry = this.readOutcomeEntry(outcome);
    if (entry === null) {
      return;
    }
    const joined = this.settled.some(
      (line) =>
        line.consumer === entry.consumer &&
        line.contextRef === entry.contextRef,
    );
    if (!joined) {
      // No settled receipt for this reference: nothing was decided by a
      // call, so there is no outcome to join.
      return;
    }
    this.outcomes.push(entry);
  }

  async readJournal(
    rawQuery: ReadDecisionJournalQuery,
  ): Promise<DecisionJournalSnapshot> {
    if (!rawQuery || typeof rawQuery !== "object") {
      throw new Error(
        "InMemoryDecisionReceiptJournalAdapter requires a readJournal query with a consumer",
      );
    }
    const query = snapshotDeclaredFields<ReadDecisionJournalQuery>(
      rawQuery,
      READ_SCALARS,
      NO_FIELDS,
    );
    if (query === null) {
      throw new Error(
        "InMemoryDecisionReceiptJournalAdapter refuses a readJournal query that is not plain data",
      );
    }
    if (!isBoundedText(query.consumer, MAX_CONSUMER_CHARS)) {
      throw new Error(
        "InMemoryDecisionReceiptJournalAdapter requires a readJournal query with a consumer",
      );
    }
    const consumer = query.consumer;
    return {
      receipts: this.settled
        .filter((line) => line.consumer === consumer)
        .map((line) => ({
          ...line.record,
          questionKinds: [...line.record.questionKinds],
          lexicalOrder: [...line.record.lexicalOrder],
          decidedOrder: [...line.record.decidedOrder],
        })),
      outcomes: this.outcomes
        .filter((outcome) => outcome.consumer === consumer)
        .map((outcome) => ({ ...outcome, value: [...outcome.value] })),
      // Nothing is ever on disk here, so nothing is ever skipped as malformed.
      skippedLines: 0,
    };
  }

  /** Declared, bounded fields only; anything unusable is skipped, never thrown. */
  private readOutcomeEntry(
    rawOutcome: AppendDecisionOutcome,
  ): DecisionOutcomeRecord | null {
    if (!rawOutcome || typeof rawOutcome !== "object") {
      return null;
    }
    const outcome = snapshotDeclaredFields<AppendDecisionOutcome>(
      rawOutcome,
      OUTCOME_SCALARS,
      OUTCOME_ARRAYS,
    );
    if (outcome === null) {
      return null;
    }
    const { consumer, contextRef, kind, value, at } = outcome;
    if (
      !isBoundedText(consumer, MAX_CONSUMER_CHARS) ||
      !isBoundedText(contextRef, MAX_CONTEXT_REF_CHARS)
    ) {
      return null;
    }
    if (
      typeof kind !== "string" ||
      !OUTCOME_KINDS.includes(kind as DecisionOutcomeKind)
    ) {
      return null;
    }
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.some(
        (item) => typeof item !== "string" || item.trim().length === 0,
      ) ||
      containsSecretShape(JSON.stringify(value))
    ) {
      return null;
    }
    if (
      typeof at !== "string" ||
      at.trim().length === 0 ||
      Number.isNaN(Date.parse(at))
    ) {
      return null;
    }
    return {
      consumer,
      contextRef,
      kind: kind as DecisionOutcomeKind,
      value: [...value],
      at,
    };
  }

  /** Month-to-date spend over the in-memory lines, per the file journal's rules. */
  private monthSpend(monthKey: string): {
    readonly total: number;
    readonly byConsumer: ReadonlyMap<string, number>;
  } {
    const settledByReservation = new Map<string, SettledLine>();
    for (const line of this.settled) {
      if (utcMonthKey(new Date(line.at)) === monthKey) {
        settledByReservation.set(line.reservationId, line);
      }
    }
    const byConsumer = new Map<string, number>();
    const addTo = (consumer: string, cost: number): void => {
      byConsumer.set(consumer, (byConsumer.get(consumer) ?? 0) + cost);
    };
    let total = 0;
    for (const reservation of this.reserved) {
      if (utcMonthKey(new Date(reservation.at)) !== monthKey) {
        continue;
      }
      // A settled line's own consumer wins: it is the one the call settled as.
      const settled = settledByReservation.get(reservation.id);
      const cost = settled?.costUsd ?? reservation.assumedCostUsd;
      total += cost;
      addTo(settled?.consumer ?? reservation.consumer, cost);
    }
    for (const [reservationId, settled] of settledByReservation) {
      if (
        !this.reserved.some((reservation) => reservation.id === reservationId)
      ) {
        total += settled.costUsd;
        addTo(settled.consumer, settled.costUsd);
      }
    }
    return { total, byConsumer };
  }
}
