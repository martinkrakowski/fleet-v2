// Shared by model.ts and write.ts so the per-consumer copy exists once.
import type { DecisionConsumers } from './types.js';

interface ConsumerSettings {
  readonly minConfidence?: number;
  readonly monthlyBudgetUsd?: number;
}

/** Copy the optional settings every consumer shares, omitting absent ones. */
function copySettings(settings: ConsumerSettings): ConsumerSettings {
  return {
    ...(settings.minConfidence !== undefined ? { minConfidence: settings.minConfidence } : {}),
    ...(settings.monthlyBudgetUsd !== undefined ? { monthlyBudgetUsd: settings.monthlyBudgetUsd } : {}),
  };
}

/** Field-by-field copy of the per-consumer settings map (K3), in a stable order. */
export function copyDecisionConsumers(consumers: DecisionConsumers): DecisionConsumers {
  const ranking = consumers['knowledge-ranking'];
  const triage = consumers['claim-triage'];
  return {
    ...(ranking !== undefined ? { 'knowledge-ranking': copySettings(ranking) } : {}),
    ...(triage !== undefined
      ? {
          'claim-triage': {
            ...copySettings(triage),
            acknowledgeCandidateClaimsLeaveHost: triage.acknowledgeCandidateClaimsLeaveHost,
          },
        }
      : {}),
  };
}
