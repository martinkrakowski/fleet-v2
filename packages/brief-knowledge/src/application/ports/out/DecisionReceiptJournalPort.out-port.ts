// Refined for lanes D1 and D4 (decision port plan, 2026-10-16).
/**
 * DecisionReceiptJournalPort: append-only record of decision calls and
 * month-to-date spend. "Recorded or not made" — every decision reserves
 * budget here before the call is made and its receipt is settled before the
 * answer is used, so a paid call is never invisible to the budget.
 */

/**
 * Caller-supplied outcome of one decision call, appended against a
 * reservation. Declared fields only.
 */
export interface DecisionCallReceipt {
  /** Provider identifier, e.g. 'jev' or 'answer-file'. */
  readonly provider: string;
  /** Served model id, recorded not trusted. */
  readonly model: string;
  /** Optional provider request id. */
  readonly requestId?: string;
  /**
   * Reported cost in USD. When absent the journal records the reservation's
   * assumed cost and marks the receipt `estimated`. Callers must pass
   * `undefined` — never `0` — when the provider reported no cost: `0` would
   * be recorded as a real, paid cost of zero.
   */
  readonly costUsd?: number;
  /** Candidate ids in the order the deterministic retrieval produced. */
  readonly lexicalOrder: readonly string[];
  /** Candidate ids in the order finally used (equal to lexicalOrder on unknown). */
  readonly decidedOrder: readonly string[];
  /** Present when the call produced no usable answer. */
  readonly unknownReason?: string;
}

export interface ReserveDecisionQuery {
  /** Cost assumed for the call when no settled cost arrives. */
  readonly assumedCostUsd: number;
  /** Month-to-date budget the journal enforces, in USD. */
  readonly monthlyBudgetUsd: number;
  /** SHA-256 of the declared state that will be sent. */
  readonly stateSha256: string;
}

export type ReserveDecisionResult =
  | { readonly ok: true; readonly reservationId: string }
  | { readonly ok: false; readonly reason: 'budget-exhausted' | 'not-configured' };

export interface DecisionReceiptJournalPort {
  /**
   * Reserve this month's budget for one call: refuses when the month-to-date
   * spend plus the assumed cost would exceed the budget, otherwise appends a
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
}
