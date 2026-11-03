// @generated value-object stub — refined for the merge train station.
/**
 * TrainState is the closed lifecycle of one merge train. The set is exhaustive
 * and the only way between states is the pure transition function in
 * `train-state.ts`; nothing else may move a train.
 */

export const TRAIN_STATES = [
  'waiting',
  'eligible',
  'batched',
  'candidate-built',
  'validating',
  'splitting',
  'ready-to-promote',
  'promoting',
  'invalidated',
  'landed',
] as const;

export type TrainStateValue = (typeof TRAIN_STATES)[number];

const TRAIN_STATE_VALUES: readonly string[] = TRAIN_STATES;

export class TrainState {
  private constructor(private readonly value: TrainStateValue) {
    // Value is immutable after construction.
  }

  static create(value: unknown): { success: boolean; value?: TrainState; error?: Error } {
    if (typeof value !== 'string' || !TRAIN_STATE_VALUES.includes(value)) {
      return { success: false, error: new Error(`Invalid train state: ${String(value)}`) };
    }
    return { success: true, value: new TrainState(value as TrainStateValue) };
  }

  getValue(): TrainStateValue {
    return this.value;
  }

  /** `landed` is terminal: no event ever leaves it. */
  isTerminal(): boolean {
    return this.value === 'landed';
  }

  equals(other: TrainState): boolean {
    return this.value === other.value;
  }
}
