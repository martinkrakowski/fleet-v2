// @generated value-object stub — refined for lane K1-1.
/**
 * The state of one lane run (plan §3.2): a projection, never stored in the run
 * record. `stopped` and `merged` are terminal; `stopped` and `parked` are
 * reachable from every non-terminal state; a park returns to its parked-from
 * state.
 */

export const LANE_RUN_STATES = [
  'ready', 'dispatching', 'running', 'seat-failed', 'collecting', 'gating', 'brief-check',
  'code-review', 'fixing', 'accepting', 'awaiting-premerge', 'opening-pr', 'pushing',
  'watching-ci', 'merging', 'merged', 'stopped', 'parked',
] as const;
export type LaneRunStateValue = (typeof LANE_RUN_STATES)[number];

/** No transition leaves these. */
export const LANE_RUN_TERMINAL_STATES = ['merged', 'stopped'] as const satisfies readonly LaneRunStateValue[];

/** The states a park may return to: every state except the terminal pair and `parked` itself (15). */
export const LANE_RUN_RESUMABLE_STATES: readonly LaneRunStateValue[] = LANE_RUN_STATES.filter(
  (state) => state !== 'parked' && state !== 'merged' && state !== 'stopped',
);

const LANE_RUN_STATE_VALUES: readonly string[] = LANE_RUN_STATES;

/** A state as a refusal may print it: a declared state, otherwise `'unknown'` (never the raw value). */
export function laneRunStateLabel(value: unknown): LaneRunStateValue | 'unknown' {
  if (typeof value === 'string' && LANE_RUN_STATE_VALUES.includes(value)) {
    return value as LaneRunStateValue;
  }
  return 'unknown';
}

export class LaneRunState {
  private constructor(private readonly value: LaneRunStateValue) {
    // Value is immutable after construction.
  }

  static create(value: unknown): { success: true; value: LaneRunState } | { success: false; error: Error } {
    if (typeof value !== 'string' || !LANE_RUN_STATE_VALUES.includes(value)) {
      return { success: false, error: new Error('Invalid lane run state') };
    }
    return { success: true, value: new LaneRunState(value as LaneRunStateValue) };
  }

  getValue(): LaneRunStateValue {
    return this.value;
  }

  isTerminal(): boolean {
    return (LANE_RUN_TERMINAL_STATES as readonly LaneRunStateValue[]).includes(this.value);
  }

  equals(other: LaneRunState): boolean {
    return this.value === other.value;
  }
}
