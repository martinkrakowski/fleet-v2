// Extracted for lane K4 (fix round, review of #121): the pure ranking trial
// figures (decision-kernel plan §4) moved out of the journal port, which now
// declares only what the journal itself must answer. Re-exported from the
// port file, so existing imports keep their module.
/**
 * computeRankingTrialFigures: one record per `knowledge-ranking` contextRef,
 * computed purely from the journal snapshot `readJournal` returns. It invents
 * nothing: a figure the persisted lines cannot carry appears as `null` or the
 * not-persisted sentinel, never as a fabricated number.
 */

import type {
  DecisionJournalSnapshot,
  DecisionOutcomeRecord,
  SettledDecisionReceiptRecord,
} from "../ports/out/DecisionReceiptJournalPort.out-port.js";
import { KNOWLEDGE_RANKING_CONSUMER } from "../ports/out/DecisionReceiptJournalPort.out-port.js";

/** Sentinel for a figure the persisted receipts cannot carry (K4 report). */
export const FIGURE_NOT_PERSISTED = "n/a (not persisted)" as const;

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
  /**
   * The latest selection matched the decided order strictly better than the
   * lexical one; `'tie'` when the two taus are equal, null when not
   * computable.
   */
  readonly selectionAgreesWithDecided: boolean | "tie" | null;
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
    // A line written before K2 carries no contextRef (read as ""): it joins
    // no proposal, so it is not a context of its own.
    if (
      receipt.consumer !== KNOWLEDGE_RANKING_CONSUMER ||
      receipt.contextRef === ""
    ) {
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
      outcome.kind !== "ranking-selection" ||
      outcome.contextRef === ""
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
        unknownCounts.set(
          call.unknownReason,
          (unknownCounts.get(call.unknownReason) ?? 0) + 1,
        );
      }
      if (
        typeof call.minConfidenceObserved === "number" &&
        Number.isFinite(call.minConfidenceObserved) &&
        (lowestConfidence === null ||
          call.minConfidenceObserved < lowestConfidence)
      ) {
        lowestConfidence = call.minConfidenceObserved;
      }
      if (typeof call.costUsd === "number" && Number.isFinite(call.costUsd)) {
        costUsd += call.costUsd;
      }
      if (call.estimated === true) {
        estimatedCalls += 1;
      }
      if (
        typeof call.latencyMs === "number" &&
        Number.isFinite(call.latencyMs)
      ) {
        latencies.push(call.latencyMs);
      }
    }

    const unknownRateByReason: Record<string, number> = {};
    for (const [reason, count] of unknownCounts) {
      unknownRateByReason[reason] =
        calls.length > 0 ? round4(count / calls.length) : 0;
    }

    const kendallTau =
      latest === undefined
        ? null
        : kendallTauBetween(latest.lexicalOrder, latest.decidedOrder);
    const selectionTauDecided =
      latest !== undefined && selection !== undefined
        ? kendallTauBetween(latest.decidedOrder, selection.value)
        : null;
    const selectionTauLexical =
      latest !== undefined && selection !== undefined
        ? kendallTauBetween(latest.lexicalOrder, selection.value)
        : null;
    const agreementComputable =
      selectionTauDecided !== null && selectionTauLexical !== null;

    figures.push({
      contextRef,
      calls: calls.length,
      orderChanged: calls.some(
        (call) => !isSameSequence(call.lexicalOrder, call.decidedOrder),
      ),
      top1Changed: calls.some(
        (call) => (call.lexicalOrder[0] ?? "") !== (call.decidedOrder[0] ?? ""),
      ),
      kendallTau,
      unknownRateByReason,
      lowestConfidence,
      ...(latencies.length > 0
        ? {
            latencyP50Ms: nearestRankPercentile(latencies, 50),
            latencyP95Ms: nearestRankPercentile(latencies, 95),
          }
        : {
            latencyP50Ms: FIGURE_NOT_PERSISTED,
            latencyP95Ms: FIGURE_NOT_PERSISTED,
          }),
      costUsd,
      estimatedCalls,
      selectionRecorded: selection !== undefined,
      selectionKendallTauDecided: selectionTauDecided,
      selectionKendallTauLexical: selectionTauLexical,
      // Agreement is strict: equal taus are a tie, not agreement.
      selectionAgreesWithDecided: !agreementComputable
        ? null
        : selectionTauDecided > selectionTauLexical
          ? true
          : selectionTauDecided === selectionTauLexical
            ? "tie"
            : false,
      selectionAgreesWithLexical: agreementComputable
        ? selectionTauLexical > selectionTauDecided
        : null,
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

function isSameSequence(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

/** Nearest-rank percentile over ascending-sorted values (rank = ceil(p·N/100)). */
function nearestRankPercentile(
  values: readonly number[],
  percentile: number,
): number {
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil((percentile / 100) * sorted.length));
  return sorted[rank - 1];
}

/** A rate rounded to four decimals; rates are descriptive, costs never are. */
function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
