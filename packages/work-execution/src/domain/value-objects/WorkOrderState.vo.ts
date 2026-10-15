// @generated value-object stub — refined for migration step 1.
/**
 * WorkOrderState is an immutable value object over the manifest's work order
 * enum. A state outside WORK_ORDER_STATES never constructs; terminal states
 * accept no further dispatch.
 */

export const WORK_ORDER_STATES = [
  'approved',
  'prepared',
  'implementing',
  'verifying',
  'reviewing',
  'fixing',
  'ready-to-merge',
  'merged',
  'stopped',
] as const;

export type WorkOrderStateValue = (typeof WORK_ORDER_STATES)[number];

const WORK_ORDER_STATE_VALUES: readonly string[] = WORK_ORDER_STATES;

export class WorkOrderState {
  private constructor(private readonly value: WorkOrderStateValue) {
    // Value is immutable after construction.
  }

  static create(value: unknown): { success: boolean; value?: WorkOrderState; error?: Error } {
    if (typeof value !== 'string' || !WORK_ORDER_STATE_VALUES.includes(value)) {
      return { success: false, error: new Error(`Invalid work order state: ${String(value)}`) };
    }
    return { success: true, value: new WorkOrderState(value as WorkOrderStateValue) };
  }

  getValue(): WorkOrderStateValue {
    return this.value;
  }

  /** Terminal states accept no further attempt dispatch on this work order. */
  isTerminal(): boolean {
    return this.value === 'merged' || this.value === 'stopped';
  }

  equals(other: WorkOrderState): boolean {
    return this.value === other.value;
  }
}
