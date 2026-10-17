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

  async reserve(query: ReserveDecisionQuery): Promise<ReserveDecisionResult> {
    if (!query || typeof query !== "object") {
      throw new Error(
        "InMemoryDecisionReceiptJournalAdapter requires a reserve query",
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
    receipt: DecisionCallReceipt,
  ): Promise<void> {
    if (
      typeof reservationId !== "string" ||
      reservationId.trim().length === 0
    ) {
      throw new Error(
        "InMemoryDecisionReceiptJournalAdapter requires a non-empty reservationId",
      );
    }
    if (!receipt || typeof receipt !== "object") {
      throw new Error(
        `InMemoryDecisionReceiptJournalAdapter requires a receipt for reservation ${reservationId}`,
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
    query: ReadDecisionJournalQuery,
  ): Promise<DecisionJournalSnapshot> {
    if (
      !query ||
      typeof query !== "object" ||
      !isBoundedText(query.consumer, MAX_CONSUMER_CHARS)
    ) {
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
          lexicalOrder: [...line.record.lexicalOrder],
          decidedOrder: [...line.record.decidedOrder],
        })),
      outcomes: this.outcomes
        .filter((outcome) => outcome.consumer === consumer)
        .map((outcome) => ({ ...outcome, value: [...outcome.value] })),
    };
  }

  /** Declared, bounded fields only; anything unusable is skipped, never thrown. */
  private readOutcomeEntry(
    outcome: AppendDecisionOutcome,
  ): DecisionOutcomeRecord | null {
    if (!outcome || typeof outcome !== "object") {
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
