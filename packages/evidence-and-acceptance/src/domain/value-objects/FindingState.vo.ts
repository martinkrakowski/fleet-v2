// @generated value-object stub — refined for step 4.
/**
 * FindingState is an immutable value object over the manifest's finding enum.
 * An unresolved finding blocks acceptance until it is fixed or refuted with
 * evidence, or marked out-of-scope: a finding about files this lane never
 * changed is not this lane's blocker and does not block acceptance.
 */

export const FINDING_STATES = ['unresolved', 'fixed', 'refuted', 'out-of-scope'] as const;

export type FindingStateValue = (typeof FINDING_STATES)[number];

const FINDING_STATE_VALUES: readonly string[] = FINDING_STATES;

export class FindingState {
  private constructor(private readonly value: FindingStateValue) {
    // Value is immutable after construction.
  }

  static create(value: unknown): { success: boolean; value?: FindingState; error?: Error } {
    if (typeof value !== 'string' || !FINDING_STATE_VALUES.includes(value)) {
      return { success: false, error: new Error(`Invalid finding state: ${String(value)}`) };
    }
    return { success: true, value: new FindingState(value as FindingStateValue) };
  }

  getValue(): FindingStateValue {
    return this.value;
  }

  /** Only unresolved findings block acceptance; fixed, refuted and out-of-scope do not. */
  isBlocking(): boolean {
    return this.value === 'unresolved';
  }

  equals(other: FindingState): boolean {
    return this.value === other.value;
  }
}
