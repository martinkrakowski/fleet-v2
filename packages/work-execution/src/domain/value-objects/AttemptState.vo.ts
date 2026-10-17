// @generated value-object stub — refined for migration step 1.
/**
 * AttemptState is an immutable value object over the manifest's attempt enum.
 * Unknown runner state is never ended: only ended, collected or cancelled
 * attempts may release capacity.
 */

export const ATTEMPT_STATES = [
  'intent-recorded',
  'dispatching',
  'running',
  'reconciling',
  'ended',
  'collected',
  'blocked',
  'cancelled',
] as const;

export type AttemptStateValue = (typeof ATTEMPT_STATES)[number];

const ATTEMPT_STATE_VALUES: readonly string[] = ATTEMPT_STATES;

/**
 * The one and only list of states whose attempt releases its capacity slot.
 * Exported from the domain so every caller (capacity accounting, and
 * `fleet-v2 hosts remove`, which refuses a host that still holds work) reads
 * the same set instead of a hand-written copy that can drift.
 */
export const CAPACITY_RELEASE_STATES: readonly AttemptStateValue[] = [
  'ended',
  'collected',
  'cancelled',
];

export class AttemptState {
  private constructor(private readonly value: AttemptStateValue) {
    // Value is immutable after construction.
  }

  static create(value: unknown): { success: boolean; value?: AttemptState; error?: Error } {
    if (typeof value !== 'string' || !ATTEMPT_STATE_VALUES.includes(value)) {
      return { success: false, error: new Error(`Invalid attempt state: ${String(value)}`) };
    }
    return { success: true, value: new AttemptState(value as AttemptStateValue) };
  }

  getValue(): AttemptStateValue {
    return this.value;
  }

  /**
   * Capacity is released only for attempts that ended authoritatively, were
   * collected, or were cancelled. Running, reconciling, dispatching,
   * intent-recorded and blocked attempts keep their reservation.
   */
  canReleaseCapacity(): boolean {
    return CAPACITY_RELEASE_STATES.includes(this.value);
  }

  equals(other: AttemptState): boolean {
    return this.value === other.value;
  }
}
