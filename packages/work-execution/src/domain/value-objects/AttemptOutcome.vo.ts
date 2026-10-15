// @generated value-object stub — refined for migration step 1.
/**
 * AttemptOutcome is an immutable value object over the manifest's outcome
 * enum. No-commit is not success; the outcome records what the attempt
 * produced, not that it ran.
 */

export const ATTEMPT_OUTCOMES = ['done', 'partial', 'stopped', 'no-commit'] as const;

export type AttemptOutcomeValue = (typeof ATTEMPT_OUTCOMES)[number];

const ATTEMPT_OUTCOME_VALUES: readonly string[] = ATTEMPT_OUTCOMES;

export class AttemptOutcome {
  private constructor(private readonly value: AttemptOutcomeValue) {
    // Value is immutable after construction.
  }

  static create(value: unknown): { success: boolean; value?: AttemptOutcome; error?: Error } {
    if (typeof value !== 'string' || !ATTEMPT_OUTCOME_VALUES.includes(value)) {
      return { success: false, error: new Error(`Invalid attempt outcome: ${String(value)}`) };
    }
    return { success: true, value: new AttemptOutcome(value as AttemptOutcomeValue) };
  }

  getValue(): AttemptOutcomeValue {
    return this.value;
  }

  equals(other: AttemptOutcome): boolean {
    return this.value === other.value;
  }
}
