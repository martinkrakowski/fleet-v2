// Shared by model.ts and write.ts so the per-consumer copy exists once.
import type { DecisionConsumers } from './types.js';

/** Field-by-field copy of the per-consumer settings map (K3). */
export function copyDecisionConsumers(consumers: DecisionConsumers): DecisionConsumers {
  const out: {
    -readonly [K in keyof DecisionConsumers]: DecisionConsumers[K];
  } = {};
  const ranking = consumers['knowledge-ranking'];
  if (ranking !== undefined) {
    out['knowledge-ranking'] = {
      ...(ranking.minConfidence !== undefined ? { minConfidence: ranking.minConfidence } : {}),
      ...(ranking.monthlyBudgetUsd !== undefined
        ? { monthlyBudgetUsd: ranking.monthlyBudgetUsd }
        : {}),
    };
  }
  const triage = consumers['claim-triage'];
  if (triage !== undefined) {
    out['claim-triage'] = {
      ...(triage.minConfidence !== undefined ? { minConfidence: triage.minConfidence } : {}),
      ...(triage.monthlyBudgetUsd !== undefined
        ? { monthlyBudgetUsd: triage.monthlyBudgetUsd }
        : {}),
      acknowledgeCandidateClaimsLeaveHost: triage.acknowledgeCandidateClaimsLeaveHost,
    };
  }
  return out;
}
