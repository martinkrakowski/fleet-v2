// Implemented for lane D4 (decision port plan, 2026-10-16).
/**
 * NotConfiguredReceiptJournal implements DecisionReceiptJournalPort
 * (not-configured-null) for installations without a state dir: there is no
 * durable receipt store, so "recorded or not made" forbids every decision.
 * Reserve refuses with `not-configured`; the consumer keeps today's
 * deterministic behaviour. No in-memory variant exists — spend without a
 * state dir is always 0 and nothing can be settled.
 */

import type {
  DecisionCallReceipt,
  DecisionReceiptJournalPort,
  ReserveDecisionQuery,
  ReserveDecisionResult,
} from '../../application/ports/out/DecisionReceiptJournalPort.out-port.js';

export class NotConfiguredReceiptJournal implements DecisionReceiptJournalPort {
  async reserve(_query: ReserveDecisionQuery): Promise<ReserveDecisionResult> {
    return { ok: false, reason: 'not-configured' };
  }

  async settle(_reservationId: string, _receipt: DecisionCallReceipt): Promise<void> {
    throw new Error(
      'Decision receipt journal is not configured: no reservation exists to settle',
    );
  }

  async monthSpendUsd(_monthUtc: Date): Promise<number> {
    return 0;
  }
}
