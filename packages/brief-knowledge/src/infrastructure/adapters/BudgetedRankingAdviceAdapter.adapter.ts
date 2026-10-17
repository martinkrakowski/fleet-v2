// Implemented for lane D5a (decision port plan, 2026-10-16, "Budget"); extended
// for lane K2 (decision-kernel plan, 2026-10-16, §3).
/**
 * BudgetedRankingAdviceAdapter implements KnowledgeRankingAdvicePort as a
 * budgeted, receipted decorator (budgeted-receipted-decision-decorator):
 * "recorded or not made" — every call reserves this month's budget in the
 * receipt journal before the inner port is contacted, and the inner answer is
 * settled into the journal before it is used. Never throws.
 *
 * Flow of `adviseRanking`:
 *  1. build the declared state (same inputs the Jev adapter uses); a refused
 *     state returns `unknown/redaction-refused` with no reserve and no inner
 *     call — nothing leaves the host;
 *  2. `reserve({consumer, assumedCostUsd, monthlyBudgetUsd, consumerBudgetUsd,
 *     stateSha256})`; refusal returns `unknown/budget` or
 *     `unknown/not-configured` exactly as the journal says, a throwing journal
 *     returns `unknown/not-configured`, and the inner port is never contacted
 *     in any of these cases;
 *  3. call the inner port (a throw becomes `unknown/transport`) and time it;
 *  4. `settle(reservationId, …)` with the call's kernel envelope — the
 *     `knowledge-ranking` consumer, the `ranking:<laneId>:<sha256>` contextRef,
 *     the observed `latencyMs`, the `['score']` question kinds and, when an
 *     answer was applied, its lowest confidence — plus the inner receipt's
 *     cost (`undefined` when absent, never `0` by default), the lexical
 *     candidate order and the decided order (score desc, ties by id, when
 *     advised; otherwise the lexical order; `unknownReason` when unknown). A
 *     throwing settle returns `unknown/not-configured` and the answer is not
 *     used.
 *
 * A settled call keeps the reservation in the ledger even when the answer is
 * not used, so a paid call is never invisible to the budget. The reference the
 * settled receipt carries travels back on that answer's `contextRef`, so the
 * consumer reports exactly the reference its own call settled; an answer from
 * a call that settled nothing carries none.
 */

import type { QuestionKind } from '@fleet/shared';
import type {
  AdviseRankingQuery,
  KnowledgeRankingAdvicePort,
  RankingAdvice,
} from '../../application/ports/out/KnowledgeRankingAdvicePort.out-port.js';
import type {
  DecisionReceiptJournalPort,
} from '../../application/ports/out/DecisionReceiptJournalPort.out-port.js';
import { KNOWLEDGE_RANKING_CONSUMER } from '../../application/ports/out/DecisionReceiptJournalPort.out-port.js';
import { buildRankingAdviceState, rankingContextRef } from './jev-advice-state.js';

/** Every ranking call asks one `score` question per candidate. */
const RANKING_QUESTION_KINDS: readonly QuestionKind[] = ['score'];

/** Receipt the inner port may expose for the journal (Jev adapter contract). */
export interface BudgetedInnerReceipt {
  readonly requestId?: string;
  readonly costUsd?: number;
  readonly servedModel?: string;
}

export interface BudgetedRankingAdviceAdapterDependencies {
  /** Wrapped advice port; optional per-call receipt used for the settlement. */
  readonly inner: KnowledgeRankingAdvicePort & {
    readonly lastReceipt?: BudgetedInnerReceipt | null;
  };
  /** Durable receipt journal; reserve/settle run against it. */
  readonly journal: DecisionReceiptJournalPort;
  /** Provider identifier recorded on every settled receipt. */
  readonly provider: string;
  /** Cost assumed per call when no settled cost arrives. */
  readonly assumedCostUsd: number;
  /** Month-to-date budget the journal enforces, in USD. */
  readonly monthlyBudgetUsd: number;
  /**
   * This consumer's own sub-budget, in USD; omit when the consumer has none
   * and only the monthly total applies.
   */
  readonly consumerBudgetUsd?: number;
}

export class BudgetedRankingAdviceAdapter implements KnowledgeRankingAdvicePort {
  private readonly inner: BudgetedRankingAdviceAdapterDependencies['inner'];
  private readonly journal: DecisionReceiptJournalPort;
  private readonly provider: string;
  private readonly assumedCostUsd: number;
  private readonly monthlyBudgetUsd: number;
  private readonly consumerBudgetUsd: number | undefined;

  constructor(deps: BudgetedRankingAdviceAdapterDependencies) {
    if (!deps || typeof deps !== 'object') {
      throw new Error('BudgetedRankingAdviceAdapter requires dependencies');
    }
    if (!deps.inner || typeof deps.inner.adviseRanking !== 'function') {
      throw new Error('BudgetedRankingAdviceAdapter requires an inner advice port');
    }
    if (!deps.journal || typeof deps.journal.reserve !== 'function') {
      throw new Error('BudgetedRankingAdviceAdapter requires a receipt journal');
    }
    if (typeof deps.provider !== 'string' || deps.provider.trim().length === 0) {
      throw new Error('BudgetedRankingAdviceAdapter requires a provider');
    }
    if (typeof deps.assumedCostUsd !== 'number' || !Number.isFinite(deps.assumedCostUsd) || deps.assumedCostUsd < 0) {
      throw new Error('BudgetedRankingAdviceAdapter requires a finite non-negative assumedCostUsd');
    }
    if (
      typeof deps.monthlyBudgetUsd !== 'number' ||
      !Number.isFinite(deps.monthlyBudgetUsd) ||
      deps.monthlyBudgetUsd < 0
    ) {
      throw new Error('BudgetedRankingAdviceAdapter requires a finite non-negative monthlyBudgetUsd');
    }
    if (
      deps.consumerBudgetUsd !== undefined &&
      (typeof deps.consumerBudgetUsd !== 'number' ||
        !Number.isFinite(deps.consumerBudgetUsd) ||
        deps.consumerBudgetUsd <= 0)
    ) {
      throw new Error(
        'BudgetedRankingAdviceAdapter requires a consumerBudgetUsd greater than 0',
      );
    }
    this.inner = deps.inner;
    this.journal = deps.journal;
    this.provider = deps.provider;
    this.assumedCostUsd = deps.assumedCostUsd;
    this.monthlyBudgetUsd = deps.monthlyBudgetUsd;
    this.consumerBudgetUsd = deps.consumerBudgetUsd;
  }

  async adviseRanking(req: AdviseRankingQuery): Promise<RankingAdvice> {
    try {
      return await this.adviseRankingInner(req);
    } catch {
      // The port never throws: any unexpected error is an opaque transport
      // failure. Errors never carry state content or provider payloads.
      return { status: 'unknown', reason: 'transport' };
    }
  }

  private async adviseRankingInner(req: AdviseRankingQuery): Promise<RankingAdvice> {
    // Same declared state the Jev adapter sends; a refusal means no reserve
    // and no inner call — nothing leaves the host.
    const state = buildRankingAdviceState(req);
    if (!state.ok) {
      return { status: 'unknown', reason: 'redaction-refused' };
    }

    // The reference the receipt, its outcome and a recorded selection join on.
    const contextRef = rankingContextRef({
      ...(req.laneId === undefined ? {} : { laneId: req.laneId }),
      taskSummary: req.taskSummary,
      candidates: req.candidates,
    });

    let reservationId: string;
    try {
      const reserved = await this.journal.reserve({
        consumer: KNOWLEDGE_RANKING_CONSUMER,
        assumedCostUsd: this.assumedCostUsd,
        monthlyBudgetUsd: this.monthlyBudgetUsd,
        ...(this.consumerBudgetUsd === undefined
          ? {}
          : { consumerBudgetUsd: this.consumerBudgetUsd }),
        stateSha256: state.stateSha256,
      });
      if (!reserved.ok) {
        // Exactly the reason the journal gave; the inner port is never called.
        return {
          status: 'unknown',
          reason: reserved.reason === 'budget-exhausted' ? 'budget' : 'not-configured',
        };
      }
      reservationId = reserved.reservationId;
    } catch {
      // A throwing journal is not a usable durable store: nothing is made.
      return { status: 'unknown', reason: 'not-configured' };
    }

    const startedAt = Date.now();
    let answer: RankingAdvice;
    try {
      answer = await this.inner.adviseRanking(req);
    } catch {
      answer = { status: 'unknown', reason: 'transport' };
    }
    // One deadline covers the whole call: a clock that moved backwards never
    // records a negative latency.
    const latencyMs = Math.max(0, Date.now() - startedAt);

    const lexicalOrder: string[] = req.candidates.map((candidate) => candidate.id);
    let decidedOrder: readonly string[] = lexicalOrder;
    let advisedModel: string | undefined;
    if (answer.status === 'advised') {
      advisedModel = answer.model;
      decidedOrder = [...lexicalOrder].sort((a, b) => {
        const scoreA = answer.scores[a] ?? 0;
        const scoreB = answer.scores[b] ?? 0;
        if (scoreA !== scoreB) return scoreB - scoreA;
        return a < b ? -1 : a > b ? 1 : 0;
      });
    }

    // Absent receipt cost stays undefined — never 0 — so the journal keeps
    // the reservation's assumed cost and marks the settled line `estimated`.
    const receipt = this.inner.lastReceipt ?? null;
    const costUsd = receipt?.costUsd;
    const model = receipt?.servedModel || advisedModel || this.provider;
    const requestId = receipt?.requestId;
    try {
      await this.journal.settle(reservationId, {
        consumer: KNOWLEDGE_RANKING_CONSUMER,
        contextRef,
        provider: this.provider,
        model,
        // An empty requestId is the Jev adapter's missing-id marker (''):
        // treat it as absent — the journal refuses an empty requestId and
        // settle would throw, losing the receipt of a paid call.
        ...(requestId ? { requestId } : {}),
        costUsd,
        questionKinds: RANKING_QUESTION_KINDS,
        // The lowest per-answer confidence the advice actually applied.
        ...(answer.status === 'advised'
          ? { minConfidenceObserved: answer.confidence }
          : {}),
        latencyMs,
        lexicalOrder,
        decidedOrder,
        ...(answer.status === 'unknown' ? { unknownReason: answer.reason } : {}),
      });
    } catch {
      // The answer is not used when the settlement cannot be recorded; the
      // reservation still counts, so a paid call stays visible to the budget.
      return { status: 'unknown', reason: 'not-configured' };
    }

    // The settled reference belongs to this answer alone: a concurrent call
    // settles its own reference and neither can read the other's.
    if (answer.status === 'advised') {
      return {
        status: 'advised',
        scores: answer.scores,
        model: answer.model,
        confidence: answer.confidence,
        contextRef,
      };
    }
    return { status: 'unknown', reason: answer.reason, contextRef };
  }
}
