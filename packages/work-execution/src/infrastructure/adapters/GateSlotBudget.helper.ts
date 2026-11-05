// Infrastructure helper (KS3): an in-process slot budget for gate predicates.
/**
 * GateSlotBudget bounds how many gate predicates run at once on one host. It is
 * the in-process half of the host's slot budget: the host-wide `gate-slot`
 * wrapper still serialises against other processes, this keeps every lane that
 * shares one adapter inside the same cap. Waiters are served first come, first
 * served. A task's own failure never frees or blocks anyone else's slot: the
 * slot is always released, and `run` never throws for a task's failure.
 */

/** The most slots a budget accepts; larger or invalid capacities fall back to the default. */
export const GATE_SLOT_BUDGET_MAX_CAPACITY = 64;

/** The capacity of a budget built from a value that is not a whole number in range. */
export const GATE_SLOT_BUDGET_DEFAULT_CAPACITY = 1;

/** The outcome of one budgeted task: its value, or the fact that it threw (no value, no message). */
export type GateSlotRun<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false };

/** A capacity as a whole number in 1..GATE_SLOT_BUDGET_MAX_CAPACITY; anything else is the default (1). Never throws. */
export function readGateSlotCapacity(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > GATE_SLOT_BUDGET_MAX_CAPACITY
  ) {
    return GATE_SLOT_BUDGET_DEFAULT_CAPACITY;
  }
  return value;
}

export class GateSlotBudget {
  readonly capacity: number;
  private active = 0;
  private peakActive = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(capacity: unknown) {
    this.capacity = readGateSlotCapacity(capacity);
  }

  /** The most tasks that ever held a slot at once. */
  get peak(): number {
    return this.peakActive;
  }

  /** Tasks holding a slot right now. */
  get inUse(): number {
    return this.active;
  }

  /** Tasks waiting for a slot right now. */
  get waiting(): number {
    return this.waiters.length;
  }

  /** Run `task` once a slot is free. A throw or rejection becomes `{ ok: false }`; the slot is always released. */
  async run<T>(task: () => Promise<T>): Promise<GateSlotRun<T>> {
    await this.acquire();
    try {
      return { ok: true, value: await task() };
    } catch {
      return { ok: false };
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.capacity) {
      this.take();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      // The slot is handed over by release(), which counts it before waking the waiter.
      this.waiters.push(resolve);
    });
  }

  private take(): void {
    this.active += 1;
    if (this.active > this.peakActive) {
      this.peakActive = this.active;
    }
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      // Hand the slot straight over: active stays the same, so a newcomer cannot jump the queue.
      next();
      return;
    }
    this.active -= 1;
  }
}
