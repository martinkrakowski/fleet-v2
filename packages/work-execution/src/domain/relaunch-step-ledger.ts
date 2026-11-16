/**
 * CO29: the pure relaunch step ledger. Given journal entries it says what has
 * already happened for one step key, and given the per-step statuses of one
 * lane it says what may happen next. Pure: this module imports nothing, reads
 * no clock, no file, no network, no environment and never throws.
 */

/**
 * The cost bound of the journal scan: read once before the loop, so an
 * enormous length never starts it.
 */
export const MAX_RELAUNCH_LEDGER_ENTRIES = 10_000;
/** The cost bound of the lane scan: read once before the loop. */
export const MAX_RELAUNCH_LANE_STEPS = 16;

export const RELAUNCH_STEP_STATUSES = [
  'absent',
  'intent-only',
  'ambiguous',
  'completed',
  'refused',
  'inconsistent',
] as const;
export type RelaunchStepStatus = (typeof RELAUNCH_STEP_STATUSES)[number];

/** The three fields of a journal entry this module reads. */
export interface RelaunchLedgerEntry {
  readonly key: string;
  readonly kind: string;
  readonly outcome?: string | null;
}

/** The grammar state of one step key while the matching entries are scanned. */
type LedgerState = 'none' | 'intent' | 'ambiguous' | 'completed' | 'refused';

/**
 * One matching entry read exactly once: a stateful getter cannot answer
 * differently on a second read, and one that throws lands in the catch.
 */
interface ReadEntry {
  readonly key: string;
  readonly kind: unknown;
  readonly outcome: unknown;
}

/** `readLaneStep`'s result: one validated lane step, read exactly once. */
interface ReadLaneStep {
  readonly step: string;
  readonly status: RelaunchStepStatus;
}

const LANE_STEP_NAME = /^[a-z][a-z0-9-]{0,31}$/;

const INVALID_STEPS = { kind: 'stopped', step: null, reason: 'invalid-steps' } as const;

/**
 * The ledger grammar for one matching entry: the next state, or `null` when
 * the entry violates the grammar (a second intent, a result with no intent,
 * a result after the final result, or an outcome outside the three known).
 */
function advance(state: LedgerState, kind: unknown, outcome: unknown): LedgerState | null {
  if (kind === 'intent') return state === 'none' ? 'intent' : null;
  if (kind !== 'result') return null;
  if (state !== 'intent' && state !== 'ambiguous') return null;
  if (outcome === 'ambiguous') return 'ambiguous';
  if (outcome === 'completed' || outcome === 'refused') return outcome;
  return null;
}

/** The typed answer for a settled grammar state. */
function stateToStatus(state: LedgerState): RelaunchStepStatus {
  switch (state) {
    case 'none':
      return 'absent';
    case 'intent':
      return 'intent-only';
    default:
      return state;
  }
}

/**
 * One element of the journal read exactly once into plain values, or `null`
 * when the element is not an object; a non-string key is refused here.
 */
function readLedgerEntry(item: unknown): ReadEntry | null {
  if (item === null || typeof item !== 'object') return null;
  const fields = item as Record<string, unknown>;
  const key: unknown = fields.key;
  if (typeof key !== 'string') return null;
  return { key, kind: fields.kind, outcome: fields.outcome };
}

export function relaunchStepStatus(entries: unknown, key: unknown): RelaunchStepStatus {
  try {
    if (typeof key !== 'string' || key === '') return 'inconsistent';
    if (!Array.isArray(entries)) return 'inconsistent';
    const length: number = entries.length;
    if (length > MAX_RELAUNCH_LEDGER_ENTRIES) return 'inconsistent';
    let state: LedgerState = 'none';
    for (let index = 0; index < length; index += 1) {
      if (!(index in entries)) return 'inconsistent';
      const entry = readLedgerEntry(entries[index]);
      if (entry === null) return 'inconsistent';
      if (entry.key !== key) continue;
      const next = advance(state, entry.kind, entry.outcome);
      if (next === null) return 'inconsistent';
      state = next;
    }
    return stateToStatus(state);
  } catch {
    return 'inconsistent';
  }
}

export interface RelaunchLaneStepStatus {
  readonly step: string;
  readonly status: RelaunchStepStatus;
}

export type RelaunchLaneProgress =
  | { readonly kind: 'done' }
  | { readonly kind: 'run'; readonly step: string }
  | { readonly kind: 'reconcile'; readonly step: string; readonly status: 'intent-only' | 'ambiguous' }
  | {
      readonly kind: 'stopped';
      readonly step: string | null;
      readonly reason: 'refused' | 'inconsistent' | 'out-of-order' | 'invalid-steps';
    };

/**
 * One element of the lane step list read exactly once into plain values, or
 * `null` when the element or its fields do not validate.
 */
function readLaneStep(item: unknown): ReadLaneStep | null {
  if (item === null || typeof item !== 'object') return null;
  const fields = item as Record<string, unknown>;
  const step: unknown = fields.step;
  if (typeof step !== 'string' || !LANE_STEP_NAME.test(step)) return null;
  const status: unknown = fields.status;
  if (typeof status !== 'string') return null;
  if (!(RELAUNCH_STEP_STATUSES as readonly string[]).includes(status)) return null;
  return { step, status: status as RelaunchStepStatus };
}

/** The first non-completed step, or `null` when every step is completed. */
function firstNonCompleted(steps: readonly ReadLaneStep[]): ReadLaneStep | null {
  for (const step of steps) {
    if (step.status !== 'completed') return step;
  }
  return null;
}

/** P4: after the first non-completed step every status must be `'absent'`. */
function laterStepsAbsent(steps: readonly ReadLaneStep[], start: number): boolean {
  for (let index = start + 1; index < steps.length; index += 1) {
    if (steps[index]?.status !== 'absent') return false;
  }
  return true;
}

/** P5: the next lane action for the first non-completed step. */
function stepToProgress(step: ReadLaneStep): RelaunchLaneProgress {
  switch (step.status) {
    case 'absent':
      return { kind: 'run', step: step.step };
    case 'intent-only':
    case 'ambiguous':
      return { kind: 'reconcile', step: step.step, status: step.status };
    case 'refused':
      return { kind: 'stopped', step: step.step, reason: 'refused' };
    default:
      return { kind: 'stopped', step: step.step, reason: 'inconsistent' };
  }
}

export function relaunchLaneProgress(steps: unknown): RelaunchLaneProgress {
  try {
    if (!Array.isArray(steps)) return INVALID_STEPS;
    const length: number = steps.length;
    if (length > MAX_RELAUNCH_LANE_STEPS) return INVALID_STEPS;
    const seen = new Set<string>();
    const read: ReadLaneStep[] = [];
    for (let index = 0; index < length; index += 1) {
      if (!(index in steps)) return INVALID_STEPS;
      const laneStep = readLaneStep(steps[index]);
      if (laneStep === null) return INVALID_STEPS;
      if (seen.has(laneStep.step)) return INVALID_STEPS;
      seen.add(laneStep.step);
      read.push(laneStep);
    }
    const first = firstNonCompleted(read);
    if (first === null) return { kind: 'done' };
    const at = read.indexOf(first);
    if (!laterStepsAbsent(read, at)) {
      return { kind: 'stopped', step: first.step, reason: 'out-of-order' };
    }
    return stepToProgress(first);
  } catch {
    return INVALID_STEPS;
  }
}
