// @generated value-object stub — refined for step 5.
/**
 * CoordinationState is an immutable value object over the manifest's
 * coordination enum. Only the approved state authorizes execution: a pending,
 * unknown, expired or cancelled request never grants authority.
 */

export const COORDINATION_STATES = [
  'proposed',
  'awaiting-decision',
  'approved',
  'declined',
  'executing',
  'completed',
  'unknown',
  'expired',
  'cancelled',
] as const;

export type CoordinationStateValue = (typeof COORDINATION_STATES)[number];

const COORDINATION_STATE_VALUES: readonly string[] = COORDINATION_STATES;

export class CoordinationState {
  private constructor(private readonly value: CoordinationStateValue) {
    // Value is immutable after construction.
  }

  static create(value: unknown): { success: boolean; value?: CoordinationState; error?: Error } {
    if (typeof value !== 'string' || !COORDINATION_STATE_VALUES.includes(value)) {
      return { success: false, error: new Error(`Invalid coordination state: ${String(value)}`) };
    }
    return { success: true, value: new CoordinationState(value as CoordinationStateValue) };
  }

  getValue(): CoordinationStateValue {
    return this.value;
  }

  /** An approved request is the only state that may authorize its exact action. */
  canAuthorizeExecution(): boolean {
    return this.value === 'approved';
  }

  /** Terminal states accept no further decision, delivery or acknowledgement. */
  isTerminal(): boolean {
    return (
      this.value === 'completed' ||
      this.value === 'declined' ||
      this.value === 'expired' ||
      this.value === 'cancelled'
    );
  }

  equals(other: CoordinationState): boolean {
    return this.value === other.value;
  }
}
