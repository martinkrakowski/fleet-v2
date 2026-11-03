// @generated value-object stub — refined for the merge train station.
/**
 * TrainEvent is the closed set of events the train state machine accepts. Any
 * other name is refused by the transition function, never guessed at.
 */

export const TRAIN_EVENTS = [
  'became-eligible',
  'batched',
  'candidate-built',
  'gate-started',
  'gate-passed',
  'gate-failed',
  'split-done',
  'promotion-started',
  'promotion-landed',
  'promotion-conflict',
  'requeued',
] as const;

export type TrainEventValue = (typeof TRAIN_EVENTS)[number];

const TRAIN_EVENT_VALUES: readonly string[] = TRAIN_EVENTS;

export class TrainEvent {
  private constructor(private readonly value: TrainEventValue) {
    // Value is immutable after construction.
  }

  static create(value: unknown): { success: boolean; value?: TrainEvent; error?: Error } {
    if (typeof value !== 'string' || !TRAIN_EVENT_VALUES.includes(value)) {
      return { success: false, error: new Error(`Invalid train event: ${String(value)}`) };
    }
    return { success: true, value: new TrainEvent(value as TrainEventValue) };
  }

  getValue(): TrainEventValue {
    return this.value;
  }

  equals(other: TrainEvent): boolean {
    return this.value === other.value;
  }
}
