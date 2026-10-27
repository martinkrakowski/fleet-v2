// Value object refined for lane S1a (seat plan and attempt record).
/**
 * StopReason is the typed class of why an attempt stopped. `none` means it
 * ended normally; `unknown` is how a record written before the field existed
 * reads, and it never triggers a fallback seat. The model-refusal classes
 * keep a model out of the rest of its lane: the domain holds no reset clock.
 */

export const STOP_REASONS = [
  'none',
  'unknown',
  'rate-limited',
  'payment',
  'timeout',
  'model-missing',
  'no-commit',
  'gate-failed',
  'length',
  'step-cap',
  'runner-refused',
] as const;

export type StopReasonValue = (typeof STOP_REASONS)[number];

/** Classes a seat plan entry may name in `on`: every class except `none` and `unknown`. */
export const SEAT_TRIGGER_CLASSES: readonly StopReasonValue[] = STOP_REASONS.filter(
  (value) => value !== 'none' && value !== 'unknown',
);

/** Classes that keep the model that stopped with them out of the rest of the lane. */
export const MODEL_REFUSAL_CLASSES: readonly StopReasonValue[] = [
  'rate-limited',
  'payment',
  'timeout',
  'model-missing',
];

const STOP_REASON_VALUES: readonly string[] = STOP_REASONS;

/** Read a stored value: anything that is not a declared class is `unknown`. */
export function parseStopReason(value: unknown): StopReasonValue {
  return typeof value === 'string' && STOP_REASON_VALUES.includes(value)
    ? (value as StopReasonValue)
    : 'unknown';
}

export class StopReason {
  private constructor(private readonly value: StopReasonValue) {
    // Value is immutable after construction.
  }

  static create(value: unknown): { success: boolean; value?: StopReason; error?: Error } {
    if (typeof value !== 'string' || !STOP_REASON_VALUES.includes(value)) {
      return { success: false, error: new Error(`Invalid stop reason: ${String(value)}`) };
    }
    return { success: true, value: new StopReason(value as StopReasonValue) };
  }

  getValue(): StopReasonValue {
    return this.value;
  }

  equals(other: StopReason): boolean {
    return this.value === other.value;
  }
}
