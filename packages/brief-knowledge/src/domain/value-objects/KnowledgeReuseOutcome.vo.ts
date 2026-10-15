// @generated value-object stub — refined for migration step 2.
/**
 * KnowledgeReuseOutcome is an immutable value object over the manifest's
 * reuse outcome enum. Context inclusion alone does not prove saved work;
 * only demonstrated benefit counts as `helped`.
 */

export const KNOWLEDGE_REUSE_OUTCOMES = ['included', 'helped', 'wrong-turn', 'unused', 'unknown'] as const;

export type KnowledgeReuseOutcomeValue = (typeof KNOWLEDGE_REUSE_OUTCOMES)[number];

const KNOWLEDGE_REUSE_OUTCOME_VALUES: readonly string[] = KNOWLEDGE_REUSE_OUTCOMES;

export class KnowledgeReuseOutcome {
  private constructor(private readonly value: KnowledgeReuseOutcomeValue) {
    // Value is immutable after construction.
  }

  static create(value: unknown): { success: boolean; value?: KnowledgeReuseOutcome; error?: Error } {
    if (typeof value !== 'string' || !KNOWLEDGE_REUSE_OUTCOME_VALUES.includes(value)) {
      return { success: false, error: new Error(`Invalid knowledge reuse outcome: ${String(value)}`) };
    }
    return { success: true, value: new KnowledgeReuseOutcome(value as KnowledgeReuseOutcomeValue) };
  }

  getValue(): KnowledgeReuseOutcomeValue {
    return this.value;
  }

  /** Demonstrated benefit, attributable with evidence; inclusion is not benefit. */
  demonstratesBenefit(): boolean {
    return this.value === 'helped';
  }

  equals(other: KnowledgeReuseOutcome): boolean {
    return this.value === other.value;
  }
}
