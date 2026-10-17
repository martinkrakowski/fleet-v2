// Implemented for lane D4 (decision port plan, 2026-10-16); refined for lane
// K4 (decision-kernel plan, 2026-10-16, §4).
/**
 * NotConfiguredReceiptJournal implements DecisionReceiptJournalPort
 * (not-configured-null) for installations without a state dir: there is no
 * durable receipt store, so "recorded or not made" forbids every decision.
 * Reserve refuses with `not-configured`; the consumer keeps today's
 * deterministic behaviour. No spend can settle here, so a measurement read
 * finds nothing — the in-memory journal is the disposable-process variant
 * of the port, not a stand-in for a durable store.
 */

import type {
  AppendDecisionOutcome,
  DecisionCallReceipt,
  DecisionJournalSnapshot,
  DecisionReceiptJournalPort,
  ReadDecisionJournalQuery,
  ReserveDecisionQuery,
  ReserveDecisionResult,
} from "../../application/ports/out/DecisionReceiptJournalPort.out-port.js";

export class NotConfiguredReceiptJournal implements DecisionReceiptJournalPort {
  async reserve(_query: ReserveDecisionQuery): Promise<ReserveDecisionResult> {
    return { ok: false, reason: "not-configured" };
  }

  async settle(
    _reservationId: string,
    _receipt: DecisionCallReceipt,
  ): Promise<void> {
    throw new Error(
      "Decision receipt journal is not configured: no reservation exists to settle",
    );
  }

  async monthSpendUsd(_monthUtc: Date): Promise<number> {
    return 0;
  }

  /**
   * Outcomes are best effort: without a durable store there is no settled
   * receipt to join one to, so it is skipped rather than raised at the caller.
   */
  async appendOutcome(_outcome: AppendDecisionOutcome): Promise<void> {
    return;
  }

  /**
   * Nothing was ever reserved, settled or joined here, so a measurement read
   * finds an empty history rather than refusing one.
   */
  async readJournal(
    _query: ReadDecisionJournalQuery,
  ): Promise<DecisionJournalSnapshot> {
    return { receipts: [], outcomes: [], skippedLines: 0 };
  }
}
