// Shared by model.ts and write.ts so the per-consumer copy exists once.
import {
  ANSWER_FILE_DECISIONS_KEYS,
  CLAIM_TRIAGE_CONSUMER_KEYS,
  DECISION_CONSUMERS_KEYS,
  JEV_DECISIONS_KEYS,
  KNOWLEDGE_RANKING_CONSUMER_KEYS,
  NO_DECISIONS_KEYS,
} from './keys.js';
import { isPlainRecord, readOwnDataProperty } from './policy-read.js';
import type {
  AnswerFileDecisionsSection,
  DecisionConsumers,
  DecisionsSectionV2,
  JevDecisionsSection,
  NoDecisionsSection,
} from './types.js';

/**
 * Copy one block through its key list, omitting absent keys. Arrays are copied
 * one level deep; nested plain records are copied through their own data
 * properties so a getter never runs.
 */
function copyOwnBlock(
  block: Record<string, unknown>,
  keys: readonly string[],
  overrides?: Readonly<Record<string, (value: unknown) => unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = readOwnDataProperty(block, key);
    if (value === undefined) {
      continue;
    }
    const override = overrides?.[key];
    if (override !== undefined) {
      out[key] = override(value);
    } else if (Array.isArray(value)) {
      out[key] = [...value];
    } else if (typeof value === 'object' && value !== null) {
      out[key] = Object.fromEntries(
        Object.keys(value as Record<string, unknown>).map((entryKey) => [
          entryKey,
          readOwnDataProperty(value as Record<string, unknown>, entryKey),
        ]),
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Copy the optional settings every consumer shares, omitting absent ones. */
export function copyDecisionConsumers(consumers: DecisionConsumers): DecisionConsumers {
  const out: Record<string, unknown> = {};
  for (const name of DECISION_CONSUMERS_KEYS) {
    const settings = readOwnDataProperty(
      consumers as unknown as Record<string, unknown>,
      name,
    );
    if (settings === undefined || !isPlainRecord(settings)) {
      continue;
    }
    const keys =
      name === 'claim-triage'
        ? CLAIM_TRIAGE_CONSUMER_KEYS
        : KNOWLEDGE_RANKING_CONSUMER_KEYS;
    const copied = copyOwnBlock(settings, keys);
    if (Object.keys(copied).length > 0) {
      out[name] = copied;
    }
  }
  return out as DecisionConsumers;
}

/** Copy the decisions block through its key list (D3): no extra key survives. */
export function copyDecisions(decisions: DecisionsSectionV2): DecisionsSectionV2 {
  if (decisions.provider === 'none') {
    return copyOwnBlock(
      decisions as unknown as Record<string, unknown>,
      NO_DECISIONS_KEYS,
    ) as unknown as NoDecisionsSection;
  }
  if (decisions.provider === 'answer-file') {
    return copyOwnBlock(
      decisions as unknown as Record<string, unknown>,
      ANSWER_FILE_DECISIONS_KEYS,
      {
        consumers: (value) => copyDecisionConsumers(value as DecisionConsumers),
      },
    ) as unknown as AnswerFileDecisionsSection;
  }
  return copyOwnBlock(
    decisions as unknown as Record<string, unknown>,
    JEV_DECISIONS_KEYS,
    {
      consumers: (value) => copyDecisionConsumers(value as DecisionConsumers),
    },
  ) as unknown as JevDecisionsSection;
}
