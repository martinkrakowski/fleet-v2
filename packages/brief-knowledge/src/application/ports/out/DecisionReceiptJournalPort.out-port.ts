// Refined for lane D1 (decision port plan, 2026-10-16). Types only; the
// receipt journal adapter arrives in lane D4.
/**
 * DecisionReceiptJournalPort: append-only record of decision calls and
 * month-to-date spend. "Recorded or not made" — every decision, from any
 * adapter, is appended here before its answer is used.
 */

/** One recorded decision call. */
export interface DecisionReceipt {
  /** Provider identifier, e.g. 'jev' or 'answer-file'. */
  readonly provider: string;
  /** Served model id, recorded not trusted. */
  readonly model: string;
  /** Optional provider request id. */
  readonly requestId?: string;
  readonly costUsd: number;
  /** True while the cost is an assumed reservation, false once settled. */
  readonly estimated: boolean;
  /** SHA-256 of the declared state that was sent. */
  readonly stateSha256: string;
  /** Candidate ids in the order the deterministic retrieval produced. */
  readonly lexicalOrder: readonly string[];
  /** Candidate ids in the order finally used (equal to lexicalOrder on unknown). */
  readonly decidedOrder: readonly string[];
  /** Present when the call produced no usable answer. */
  readonly unknownReason?: string;
  /** ISO-8601 timestamp of the call. */
  readonly at: string;
}

export interface DecisionReceiptJournalPort {
  /** Append one receipt before the answer is used. */
  append(receipt: DecisionReceipt): Promise<void>;
  /** Sum of settled and reserved costs for the UTC month containing `monthUtc`. */
  monthSpendUsd(monthUtc: Date): Promise<number>;
}