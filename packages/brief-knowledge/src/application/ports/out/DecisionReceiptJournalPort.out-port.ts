// Refined for lanes D1 and D4 (decision port plan, 2026-10-16); refined again
// for lane K2 (decision-kernel plan, 2026-10-16, §3).
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

/** One triaged candidate: its class and its reusability score, never its text. */
export interface CandidateTriageDisposition {
  readonly candidateId: string;
  readonly chosenClass: string;
  readonly reusability: number;
}

/**
 * A settled triage call (written from lane K5). It orders nothing, so its
 * `lexicalOrder` and `decidedOrder` are empty: that keeps a triage line
 * readable by an older build's parser after a rollback, and keeps the
 * budget's fail-closed parser from ever meeting a line kind it does not know.
 */
export interface ClaimTriageDecisionCallReceipt extends DeclaredReceiptFields {
  readonly consumer: typeof CLAIM_TRIAGE_CONSUMER;
  readonly lexicalOrder: readonly string[];
  readonly decidedOrder: readonly string[];
  /** Per candidate the chosen class and reusability score; empty when unknown. */
  readonly dispositions?: readonly CandidateTriageDisposition[];
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
}
