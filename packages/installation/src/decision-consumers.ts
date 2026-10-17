// Shared by model.ts and write.ts so the per-consumer copy exists once.
import type { DecisionConsumers, DecisionsSectionV2 } from './types.js';

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

/** Field-by-field copy of the decisions block (D3): no extra key survives. */
export function copyDecisions(decisions: DecisionsSectionV2): DecisionsSectionV2 {
  if (decisions.provider === 'none') {
    return { provider: 'none' };
  }
  if (decisions.provider === 'answer-file') {
    return {
      provider: 'answer-file',
      answerFile: decisions.answerFile,
      ...(decisions.consumers !== undefined
        ? { consumers: copyDecisionConsumers(decisions.consumers) }
        : {}),
    };
  }
  return {
    provider: 'jev',
    model: decisions.model,
    keyFile: decisions.keyFile,
    minConfidence: decisions.minConfidence,
    monthlyBudgetUsd: decisions.monthlyBudgetUsd,
    assumedCostPerCallUsd: decisions.assumedCostPerCallUsd,
    acknowledgeProseLeavesHost: decisions.acknowledgeProseLeavesHost,
    ...(decisions.disabledProjects !== undefined
      ? { disabledProjects: [...decisions.disabledProjects] }
      : {}),
    ...(decisions.consumers !== undefined
      ? { consumers: copyDecisionConsumers(decisions.consumers) }
      : {}),
  };
}
