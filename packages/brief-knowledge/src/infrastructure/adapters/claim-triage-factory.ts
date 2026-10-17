// Implemented for lane K5b (decision-kernel plan, 2026-10-16, §5).
/**
 * createClaimTriage assembles the ClaimTriagePort an installation gets from
 * its v2 `decisions` block, as the post-capture hook's optional dependency:
 *  - no block, `provider: 'none'`, no `stateDir`, or a block without a
 *    declared `consumers['claim-triage']` entry carrying the
 *    `acknowledgeCandidateClaimsLeaveHost: true` acknowledgement →
 *    `undefined` (triage disabled; the hook stays off and capture is
 *    unchanged);
 *  - `provider: 'jev'` with the acknowledgement → JevClaimTriageAdapter over
 *    FileDecisionReceiptJournalAdapter(stateDir), with the consumer's own
 *    `minConfidence` (the block's as fallback) and its own
 *    `monthlyBudgetUsd` sub-budget when declared;
 *  - `provider: 'answer-file'` → `undefined`: the owner-recorded answers are
 *    ranking scores, and no owner-recorded choice answers exist to triage
 *    against.
 *
 * Candidate claim text leaves the host only under the claim-triage
 * consumer's own acknowledgement (plan §5, "Hard to undo"); without it the
 * triage consumer is disabled on its own while ranking keeps running.
 *
 * The `decisions` parameter is structurally identical to the v2 decisions
 * block in @fleet/installation. brief-knowledge may not depend on that
 * package (no workspace dependency; layer-rules.yaml allows only
 * @fleet/shared here), so the shape is declared locally; the structural
 * typing keeps them assignment-compatible in both directions.
 */

import type { ClaimTriagePort } from "../../application/ports/out/ClaimTriagePort.out-port.js";
import { JevClaimTriageAdapter } from "./JevClaimTriageAdapter.adapter.js";
import { FileDecisionReceiptJournalAdapter } from "./FileDecisionReceiptJournalAdapter.adapter.js";
import type {
  RankingAdviceDecisions,
  RankingAdviceConsumers,
} from "./ranking-advice-factory.js";

/** The claim-triage consumer's settings, mirrored structurally (K3). */
export interface ClaimTriageConsumerSettings {
  readonly minConfidence?: number;
  readonly monthlyBudgetUsd?: number;
  readonly acknowledgeCandidateClaimsLeaveHost: true;
}

/** Local structural mirror of `DecisionConsumers` in @fleet/installation. */
export interface ClaimTriageConsumers extends RankingAdviceConsumers {
  readonly "claim-triage"?: ClaimTriageConsumerSettings;
}

/**
 * The triage consumer's own threshold, the block's as fallback; undefined
 * only when the block declares neither (triage stays disabled).
 */
function triageMinConfidence(
  decisions: RankingAdviceDecisions,
): number | undefined {
  if (decisions.provider === "none") {
    return undefined;
  }
  const declared = (decisions.consumers as ClaimTriageConsumers | undefined)?.[
    "claim-triage"
  ];
  if (declared?.minConfidence !== undefined) {
    return declared.minConfidence;
  }
  return decisions.provider === "jev" ? decisions.minConfidence : undefined;
}

export interface CreateClaimTriageOptions {
  /** The installation's v2 `decisions` block; undefined means 'none'. */
  readonly decisions?: RankingAdviceDecisions;
  /** Durable state dir; without it no decision may be made (invariant 5). */
  readonly stateDir?: string;
  /** Injected transport for the jev provider; required when triage is made. */
  readonly fetch?: typeof fetch;
  /** Injected key reader; defaults to the Jev ranking adapter's `readKeyFile`. */
  readonly readKey?: (path: string) => Promise<string>;
}

/**
 * The post-capture hook's triage port, or `undefined` when triage is
 * disabled: never a port that answers unknown per call.
 */
export function createClaimTriage(
  options: CreateClaimTriageOptions,
): ClaimTriagePort | undefined {
  const { decisions, stateDir } = options;

  // Invariant 6: off by default — and off unless the consumer is declared
  // with its own acknowledgement that candidate claims may leave the host.
  if (
    !decisions ||
    decisions.provider === "none" ||
    decisions.provider === "answer-file"
  ) {
    return undefined;
  }
  const declared = (decisions.consumers as ClaimTriageConsumers | undefined)?.[
    "claim-triage"
  ];
  if (!declared || declared.acknowledgeCandidateClaimsLeaveHost !== true) {
    return undefined;
  }
  if (stateDir === undefined || stateDir.trim().length === 0) {
    // No durable receipt store → nothing is made (invariant 5).
    return undefined;
  }
  const minConfidence = triageMinConfidence(decisions);
  if (minConfidence === undefined) {
    return undefined;
  }

  const consumerBudgetUsd =
    typeof declared.monthlyBudgetUsd === "number" &&
    Number.isFinite(declared.monthlyBudgetUsd) &&
    declared.monthlyBudgetUsd > 0
      ? declared.monthlyBudgetUsd
      : undefined;

  return new JevClaimTriageAdapter({
    model: decisions.model,
    keyFile: decisions.keyFile,
    minConfidence,
    journal: new FileDecisionReceiptJournalAdapter(stateDir),
    provider: "jev",
    assumedCostUsd: decisions.assumedCostPerCallUsd,
    monthlyBudgetUsd: decisions.monthlyBudgetUsd,
    ...(consumerBudgetUsd === undefined ? {} : { consumerBudgetUsd }),
    fetch: options.fetch as unknown as typeof fetch,
    ...(options.readKey === undefined ? {} : { readKey: options.readKey }),
  });
}
