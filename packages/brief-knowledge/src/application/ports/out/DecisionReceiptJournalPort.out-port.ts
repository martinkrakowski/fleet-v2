// Refined for lanes D1 and D4 (decision port plan, 2026-10-16); refined again
// for lane K2 (decision-kernel plan, 2026-10-16, §3), and for lane K4 (the
// same plan, §4: the measurement read and the trial figures).
/**
 * DecisionReceiptJournalPort: append-only record of decision calls, of
 * month-to-date spend and of the outcomes those calls produced. "Recorded or
 * not made" — every decision reserves budget here before the call is made and
 * its receipt is settled before the answer is used, so a paid call is never
 * invisible to the budget.
 *
 * The common receipt fields are the kernel's envelope
 * (`DecisionCallReceipt` in `@fleet/shared`) minus `at` (the journal stamps
 * it) and `estimated` (the journal derives it from whether a cost was
 * reported). The consumer-specific variants live here, with their consumer:
 * `knowledge-ranking` and `claim-triage`, so a new consumer never edits
 * `@fleet/shared`.
 */

import type { DecisionCallReceipt as DecisionReceiptEnvelope } from '@fleet/shared';

/** The consumer this context records a ranking judgement for. */
export const KNOWLEDGE_RANKING_CONSUMER = 'knowledge-ranking';

/** The consumer this context records a candidate-claim triage for (K5). */
export const CLAIM_TRIAGE_CONSUMER = 'claim-triage';

/** The kernel envelope as the caller declares it; the journal owns the rest. */
type DeclaredReceiptFields = Omit<DecisionReceiptEnvelope, 'at' | 'estimated'>;

/**
 * A settled ranking call: the advisory scores were applied to an order of the
 * candidate ids. `lexicalOrder` is the order the deterministic retrieval
 * produced; `decidedOrder` is the order finally used (equal to `lexicalOrder`
 * when the answer was unknown).
 */
export interface RankingDecisionCallReceipt extends DeclaredReceiptFields {
  readonly consumer: typeof KNOWLEDGE_RANKING_CONSUMER;
  readonly lexicalOrder: readonly string[];
  readonly decidedOrder: readonly string[];
}

/**
 * A settled triage call (written from lane K5). It orders nothing, so its
 * `lexicalOrder` and `decidedOrder` are empty: that keeps a triage line
 * readable by an older build's parser after a rollback, and keeps the
 * budget's fail-closed parser from ever meeting a line kind it does not know.
 *
 * K2 leaves the per-candidate `dispositions` (`candidateId`, `chosenClass`,
 * `reusability`) out of this contract rather than declaring a field nothing
 * settles: until K5a persists them, a triage line carries no dispositions,
 * and a line that carries extra keys is still parsed — the reader ignores
 * what it does not know, so a rollback keeps reading either way.
 */
export interface ClaimTriageDecisionCallReceipt extends DeclaredReceiptFields {
  readonly consumer: typeof CLAIM_TRIAGE_CONSUMER;
  readonly lexicalOrder: readonly string[];
  readonly decidedOrder: readonly string[];
}

/** Caller-supplied outcome of one decision call, appended against a reservation. */
export type DecisionCallReceipt = RankingDecisionCallReceipt | ClaimTriageDecisionCallReceipt;

export interface ReserveDecisionQuery {
  /**
   * Consumer discriminator the pending spend is attributed to; a reservation
   * without one reads as `knowledge-ranking`.
   */
  readonly consumer?: string;
  /** Cost assumed for the call when no settled cost arrives. */
  readonly assumedCostUsd: number;
  /** Month-to-date budget the journal enforces, in USD. */
  readonly monthlyBudgetUsd: number;
  /**
   * This consumer's own month-to-date sub-budget, in USD. Omit when the
   * consumer has none: only the total applies.
   */
  readonly consumerBudgetUsd?: number;
  /** SHA-256 of the declared state that will be sent. */
  readonly stateSha256: string;
}

export type ReserveDecisionResult =
  | { readonly ok: true; readonly reservationId: string }
  | { readonly ok: false; readonly reason: 'budget-exhausted' | 'not-configured' };

/** What one decision call ended up deciding, recorded best effort. */
export type DecisionOutcomeKind = 'ranking-selection' | 'triage-disposition';

export interface AppendDecisionOutcome {
  readonly consumer: string;
  /** Joins the outcome to the settled receipt of the same decision call. */
  readonly contextRef: string;
  readonly kind: DecisionOutcomeKind;
  /**
   * Declared ids only: the entry ids the orchestrator selected for a ranking,
   * or the candidate id and disposition a checker recorded for a triage. Never
   * claim text.
   */
  readonly value: readonly string[];
  /** ISO 8601 instant the outcome was recorded. */
  readonly at: string;
}

export interface DecisionReceiptJournalPort {
  /**
   * Reserve this month's budget for one call: refuses when the consumer's
   * month-to-date spend (its own sub-budget, when it has one) or the month's
   * total plus the assumed cost would reach the budget, otherwise appends a
   * `reserved` entry and returns its reservation id.
   */
  reserve(query: ReserveDecisionQuery): Promise<ReserveDecisionResult>;
  /**
   * Append the settled receipt for a reservation. Throws when the reservation
   * is unknown, when it was already settled (settling is once only), or when
   * the append fails; the caller then treats the answer as unknown and keeps
   * the deterministic behaviour. A settle whose `receipt.costUsd` is absent
   * keeps the reservation's assumed cost and is marked `estimated: true`.
   */
  settle(reservationId: string, receipt: DecisionCallReceipt): Promise<void>;
  /** Sum of settled and reserved costs for the UTC month containing `monthUtc`. */
  monthSpendUsd(monthUtc: Date): Promise<number>;
  /**
   * Record what one decision call ended up deciding, best effort: a
   * `contextRef` with no settled receipt is skipped silently and a failed
   * write is never raised at the caller, so recording an outcome can never
   * fail the operation it describes. Outcomes live in their own file.
   */
  appendOutcome(outcome: AppendDecisionOutcome): Promise<void>;
  /**
   * Read one consumer's settled receipts and recorded outcomes for
   * measurement (lane K4's `decisions report`): append order is preserved,
   * a receipt joins its outcomes by `contextRef`, and nothing is invented —
   * a field a line never carried reads as absent, never as zero. Reading is
   * pure: it appends nothing and decides nothing.
   */
  readJournal(query: ReadDecisionJournalQuery): Promise<DecisionJournalSnapshot>;
}

// ---------------------------------------------------------------------------
// K4 measurement read: the records the journal hands a report, and the pure
// figures computed from them (decision-kernel plan §4).
// ---------------------------------------------------------------------------

/**
 * One settled receipt as the journal recorded it. The line's own consumer is
 * carried, so a report never attributes a call to the consumer it did not
 * settle as. `latencyMs` is absent on a line written before K2, which carries
 * no measurement to read.
 */
export interface SettledDecisionReceiptRecord {
  readonly consumer: string;
  readonly contextRef: string;
  readonly provider: string;
  readonly model: string;
  readonly requestId?: string;
  readonly costUsd: number;
  readonly estimated: boolean;
  readonly questionKinds: readonly string[];
  readonly minConfidenceObserved?: number;
  /** Call latency in ms; absent when the settled line carries none (pre-K2). */
  readonly latencyMs?: number;
  readonly lexicalOrder: readonly string[];
  readonly decidedOrder: readonly string[];
  readonly unknownReason?: string;
  readonly at: string;
}

/** One recorded outcome line, as it was appended. */
export interface DecisionOutcomeRecord {
  readonly consumer: string;
  readonly contextRef: string;
  readonly kind: DecisionOutcomeKind;
  readonly value: readonly string[];
  readonly at: string;
}

export interface ReadDecisionJournalQuery {
  /** Only this consumer's receipts and outcomes are read. */
  readonly consumer: string;
}

/** One consumer's receipts and outcomes, in append order. */
export interface DecisionJournalSnapshot {
  readonly receipts: readonly SettledDecisionReceiptRecord[];
  readonly outcomes: readonly DecisionOutcomeRecord[];
}

/** Sentinel for a figure the persisted receipts cannot carry (K4 report). */
export const FIGURE_NOT_PERSISTED = 'n/a (not persisted)' as const;

/** A trial figure: measured, or explicitly not persisted. */
export type TrialFigure = number | typeof FIGURE_NOT_PERSISTED;

/**
 * One ranking context's trial figures (plan §4), computed from the journal
 * snapshot `readJournal` returns. A context with several settled calls
 * reports the aggregate figures over all of them (`calls` shows the count)
 * and the order-derived figures of its latest call; a context whose
 * selection was never recorded reports `selectionRecorded: false` and null
 * agreement figures rather than an invented selection.
 */
export interface RankingTrialContextFigures {
  readonly contextRef: string;
  /** Settled `knowledge-ranking` calls recorded under this reference. */
  readonly calls: number;
  /** Any call's decided order differed from its lexical order. */
  readonly orderChanged: boolean;
  /** Any call moved the first entry. */
  readonly top1Changed: boolean;
  /**
   * Kendall tau between the latest call's lexical and decided order; null
   * when fewer than two shared entries leave no pair to correlate.
   */
  readonly kendallTau: number | null;
  /** Share of this reference's calls that were unknown, per recorded reason. */
  readonly unknownRateByReason: Readonly<Record<string, number>>;
  /** Lowest accepted-answer confidence across the calls; null when none was advised. */
  readonly lowestConfidence: number | null;
  /**
   * Nearest-rank p50/p95 over the calls' measured latencies; the
   * not-persisted sentinel when no settled line carries one (pre-K2 lines).
   */
  readonly latencyP50Ms: TrialFigure;
  readonly latencyP95Ms: TrialFigure;
  /** Sum of the reference's settled costs, in USD. */
  readonly costUsd: number;
  /** Calls whose cost was the reservation's assumption, not a reported one. */
  readonly estimatedCalls: number;
  /** A ranking-selection outcome joined this reference. */
  readonly selectionRecorded: boolean;
  /** Kendall tau between the latest selection and the latest call's orders. */
  readonly selectionKendallTauDecided: number | null;
  readonly selectionKendallTauLexical: number | null;
  /** The latest selection matched the decided order at least as well as the lexical one; null when not computable. */
  readonly selectionAgreesWithDecided: boolean | null;
  /** The latest selection matched the lexical order strictly better; null when not computable. */
  readonly selectionAgreesWithLexical: boolean | null;
}

/**
 * Compute the ten-proposal trial figures for the `knowledge-ranking`
 * consumer (plan §4, lane K4): one record per `contextRef`, in first
 * appearance order. Pure — it reads only the snapshot it is handed and
 * invents nothing: what the journal never persisted appears as `null` or
 * the not-persisted sentinel, never as a fabricated number.
 */
export function computeRankingTrialFigures(
  snapshot: DecisionJournalSnapshot,
): readonly RankingTrialContextFigures[] {
  const callsByRef = new Map<string, SettledDecisionReceiptRecord[]>();
  for (const receipt of snapshot.receipts) {
    if (receipt.consumer !== KNOWLEDGE_RANKING_CONSUMER) {
      continue;
    }
    const calls = callsByRef.get(receipt.contextRef);
    if (calls === undefined) {
      callsByRef.set(receipt.contextRef, [receipt]);
    } else {
      calls.push(receipt);
    }
  }

  // The latest recorded selection per reference; an outcome cannot exist
  // without its settled receipt, but a defensive reference with no call
  // still reports its outcome rather than dropping it.
  const latestSelectionByRef = new Map<string, DecisionOutcomeRecord>();
  for (const outcome of snapshot.outcomes) {
    if (
      outcome.consumer !== KNOWLEDGE_RANKING_CONSUMER ||
      outcome.kind !== 'ranking-selection'
    ) {
      continue;
    }
    if (!callsByRef.has(outcome.contextRef)) {
      callsByRef.set(outcome.contextRef, []);
    }
    latestSelectionByRef.set(outcome.contextRef, outcome);
  }

  const figures: RankingTrialContextFigures[] = [];
  for (const [contextRef, calls] of callsByRef) {
    const latest = calls.length > 0 ? calls[calls.length - 1] : undefined;
    const selection = latestSelectionByRef.get(contextRef);

    const unknownCounts = new Map<string, number>();
    let lowestConfidence: number | null = null;
    let costUsd = 0;
    let estimatedCalls = 0;
    const latencies: number[] = [];
    for (const call of calls) {
      if (call.unknownReason !== undefined) {
        unknownCounts.set(call.unknownReason, (unknownCounts.get(call.unknownReason) ?? 0) + 1);
      }
      if (
        typeof call.minConfidenceObserved === 'number' &&
        Number.isFinite(call.minConfidenceObserved) &&
        (lowestConfidence === null || call.minConfidenceObserved < lowestConfidence)
      ) {
        lowestConfidence = call.minConfidenceObserved;
      }
      if (typeof call.costUsd === 'number' && Number.isFinite(call.costUsd)) {
        costUsd += call.costUsd;
      }
      if (call.estimated === true) {
        estimatedCalls += 1;
      }
      if (typeof call.latencyMs === 'number' && Number.isFinite(call.latencyMs)) {
        latencies.push(call.latencyMs);
      }
    }

    const unknownRateByReason: Record<string, number> = {};
    for (const [reason, count] of unknownCounts) {
      unknownRateByReason[reason] = calls.length > 0 ? round4(count / calls.length) : 0;
    }

    const kendallTau = latest === undefined ? null : kendallTauBetween(latest.lexicalOrder, latest.decidedOrder);
    const selectionTauDecided =
      latest !== undefined && selection !== undefined
        ? kendallTauBetween(latest.decidedOrder, selection.value)
        : null;
    const selectionTauLexical =
      latest !== undefined && selection !== undefined
        ? kendallTauBetween(latest.lexicalOrder, selection.value)
        : null;
    const agreementComputable = selectionTauDecided !== null && selectionTauLexical !== null;

    figures.push({
      contextRef,
      calls: calls.length,
      orderChanged: calls.some(
        (call) => !isSameSequence(call.lexicalOrder, call.decidedOrder),
      ),
      top1Changed: calls.some(
        (call) => (call.lexicalOrder[0] ?? '') !== (call.decidedOrder[0] ?? ''),
      ),
      kendallTau,
      unknownRateByReason,
      lowestConfidence,
      ...(latencies.length > 0
        ? { latencyP50Ms: nearestRankPercentile(latencies, 50), latencyP95Ms: nearestRankPercentile(latencies, 95) }
        : { latencyP50Ms: FIGURE_NOT_PERSISTED, latencyP95Ms: FIGURE_NOT_PERSISTED }),
      costUsd,
      estimatedCalls,
      selectionRecorded: selection !== undefined,
      selectionKendallTauDecided: selectionTauDecided,
      selectionKendallTauLexical: selectionTauLexical,
      selectionAgreesWithDecided: agreementComputable ? selectionTauDecided >= selectionTauLexical : null,
      selectionAgreesWithLexical: agreementComputable ? selectionTauLexical > selectionTauDecided : null,
    });
  }
  return figures;
}

/** Kendall tau of `order` against the ranks of `reference`, over shared ids. */
function kendallTauBetween(
  reference: readonly string[],
  order: readonly string[],
): number | null {
  const rankOf = new Map<string, number>();
  reference.forEach((id, index) => {
    rankOf.set(id, index);
  });
  const ranks: number[] = [];
  for (const id of order) {
    const rank = rankOf.get(id);
    if (rank !== undefined) {
      ranks.push(rank);
    }
  }
  if (ranks.length < 2) {
    // No pair to correlate: identical below-two-entry orders agree on
    // nothing that tau can express.
    return null;
  }
  let concordant = 0;
  let discordant = 0;
  for (let left = 0; left < ranks.length; left += 1) {
    for (let right = left + 1; right < ranks.length; right += 1) {
      const difference = ranks[right] - ranks[left];
      if (difference > 0) {
        concordant += 1;
      } else if (difference < 0) {
        discordant += 1;
      }
    }
  }
  const pairs = concordant + discordant;
  return pairs === 0 ? null : (concordant - discordant) / pairs;
}

function isSameSequence(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((id, index) => id === right[index])
  );
}

/** Nearest-rank percentile over ascending-sorted values (rank = ceil(p·N/100)). */
function nearestRankPercentile(values: readonly number[], percentile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil((percentile / 100) * sorted.length));
  return sorted[rank - 1];
}

/** A rate rounded to four decimals; rates are descriptive, costs never are. */
function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
