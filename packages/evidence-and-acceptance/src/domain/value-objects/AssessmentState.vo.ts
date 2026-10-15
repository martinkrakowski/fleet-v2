// @generated value-object stub — refined for step 4.
/**
 * AssessmentState is an immutable value object over the manifest's assessment
 * enum. Pending, unknown and unresolved evidence never becomes an implicit
 * pass; only accepted, rejected and stale assessments are terminal.
 */

export const ASSESSMENT_STATES = [
  'pending',
  'blocked',
  'accepted',
  'rejected',
  'stale',
] as const;

export type AssessmentStateValue = (typeof ASSESSMENT_STATES)[number];

const ASSESSMENT_STATE_VALUES: readonly string[] = ASSESSMENT_STATES;

const TERMINAL_STATES: readonly AssessmentStateValue[] = ['accepted', 'rejected', 'stale'];

export class AssessmentState {
  private constructor(private readonly value: AssessmentStateValue) {
    // Value is immutable after construction.
  }

  static create(value: unknown): { success: boolean; value?: AssessmentState; error?: Error } {
    if (typeof value !== 'string' || !ASSESSMENT_STATE_VALUES.includes(value)) {
      return { success: false, error: new Error(`Invalid assessment state: ${String(value)}`) };
    }
    return { success: true, value: new AssessmentState(value as AssessmentStateValue) };
  }

  getValue(): AssessmentStateValue {
    return this.value;
  }

  /**
   * Accepted, rejected and stale assessments no longer accept new evidence.
   * Pending and blocked assessments are still open for receipts and
   * dispositions.
   */
  isTerminal(): boolean {
    return TERMINAL_STATES.includes(this.value);
  }

  equals(other: AssessmentState): boolean {
    return this.value === other.value;
  }
}
