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

/**
 * C1b: prior-attempt states after which a fix attempt may be prepared or dispatched in the shared
 * worktree. `ended` is excluded: its artifact manifest is not sealed until it is collected.
 */
export const FIX_READY_PRIOR_STATES: readonly AttemptStateValue[] = ['collected', 'cancelled'];

/** C1b: other attempts on the work order in these states do not block a fix attempt. */
export const FIX_NON_BLOCKING_SIBLING_STATES: readonly AttemptStateValue[] = [
  'intent-recorded',
  'collected',
  'cancelled',
];

/** A state as a refusal may print it: a declared state, otherwise `'unknown'` (never the raw value). */
export function attemptStateLabel(value: unknown): AttemptStateValue | 'unknown' {
  if (typeof value === 'string' && ATTEMPT_STATE_VALUES.includes(value)) {
    return value as AttemptStateValue;
  }
  return 'unknown';
}

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
