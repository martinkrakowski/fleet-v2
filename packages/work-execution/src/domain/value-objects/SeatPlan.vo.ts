// Value object refined for lane S1a (seat plan, per-lane round-robin).
/**
 * SeatPlan is the immutable, versioned list of seats per pipeline role:
 * `first-pass` (the first implementer), `fix` (every later implementer
 * attempt) and `review` (the independent reviewer). It sits beside
 * `ModelAssignment.fallbackModel` (plan D1): an attempt without a plan keeps
 * today's behaviour. Seat health is not part of the plan; it is supplied at
 * selection time. Host seat names never enter it; seat ids are the
 * installation's seat ids or brief-local names.
 */

import { parseSeatTool } from '../execution-records.js';
import { SEAT_TRIGGER_CLASSES, type StopReasonValue } from './StopReason.vo.js';

export const SEAT_PLAN_VERSION = 1 as const;

export const SEAT_PLAN_ROLES = ['first-pass', 'fix', 'review'] as const;

export type SeatPlanRole = (typeof SEAT_PLAN_ROLES)[number];

/** The implementer roles: their seats must declare a runner tool. */
export type ImplementerSeatRole = Exclude<SeatPlanRole, 'review'>;

export interface SeatPlanSeat {
  readonly id: string;
  readonly model: string;
  /** Required (`opencode` or `agy`) for first-pass and fix seats; free text for review seats. */
  readonly tool?: string;
  readonly variant?: string;
  readonly agent?: string;
  /** Trigger classes after which this fallback seat joins the rotation. Absent: always in rotation. */
  readonly on?: readonly StopReasonValue[];
}

export interface SeatPlanProps {
  readonly version: typeof SEAT_PLAN_VERSION;
  readonly 'first-pass': readonly SeatPlanSeat[];
  readonly fix: readonly SeatPlanSeat[];
  readonly review: readonly SeatPlanSeat[];
}

const PLAN_KEYS: readonly string[] = ['version', ...SEAT_PLAN_ROLES];
const SEAT_KEYS: readonly string[] = ['id', 'model', 'tool', 'variant', 'agent', 'on'];
const TRIGGER_VALUES: readonly string[] = SEAT_TRIGGER_CLASSES;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Validate one seat; returns the cleaned seat or an error message. */
function parseSeat(raw: unknown, role: SeatPlanRole, index: number): SeatPlanSeat | string {
  const where = role + '[' + String(index) + ']';
  if (!isRecord(raw)) {
    return where + ' must be an object';
  }
  const unknownKey = Object.keys(raw).find((key) => !SEAT_KEYS.includes(key));
  if (unknownKey !== undefined) {
    return where + ' has an unknown field';
  }
  if (!isNonEmptyTrimmedString(raw.id)) {
    return where + '.id must be a non-empty string';
  }
  if (!isNonEmptyTrimmedString(raw.model)) {
    return where + '.model must be a non-empty string';
  }
  if (role !== 'review' && parseSeatTool(raw.tool) === undefined) {
    return where + '.tool must be a declared runner kind (opencode or agy)';
  }
  if (raw.tool !== undefined && !isNonEmptyTrimmedString(raw.tool)) {
    return where + '.tool must be a non-empty string when present';
  }
  for (const key of ['variant', 'agent'] as const) {
    if (raw[key] !== undefined && !isNonEmptyTrimmedString(raw[key])) {
      return where + '.' + key + ' must be a non-empty string when present';
    }
  }
  let on: StopReasonValue[] | undefined;
  if (raw.on !== undefined) {
    if (!Array.isArray(raw.on) || raw.on.length === 0) {
      return where + '.on must be a non-empty array when present';
    }
    const seen = new Set<string>();
    for (const trigger of raw.on) {
      if (typeof trigger !== 'string' || !TRIGGER_VALUES.includes(trigger) || seen.has(trigger)) {
        return where + '.on must list distinct trigger classes';
      }
      seen.add(trigger);
    }
    on = [...seen] as StopReasonValue[];
  }
  return {
    id: raw.id.trim(),
    model: raw.model.trim(),
    ...(isNonEmptyTrimmedString(raw.tool) ? { tool: raw.tool.trim() } : {}),
    ...(isNonEmptyTrimmedString(raw.variant) ? { variant: raw.variant.trim() } : {}),
    ...(isNonEmptyTrimmedString(raw.agent) ? { agent: raw.agent.trim() } : {}),
    ...(on !== undefined ? { on } : {}),
  };
}

/** Validate one role's list; first-pass and fix must be non-empty, review may be empty. */
function parseRole(raw: unknown, role: SeatPlanRole): SeatPlanSeat[] | string {
  if (!Array.isArray(raw)) {
    return role + ' must be an array';
  }
  if (role !== 'review' && raw.length === 0) {
    return role + ' must hold at least one seat';
  }
  const seats: SeatPlanSeat[] = [];
  const ids = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const parsed = parseSeat(entry, role, index);
    if (typeof parsed === 'string') {
      return parsed;
    }
    if (ids.has(parsed.id)) {
      return role + ' repeats seat id ' + parsed.id;
    }
    ids.add(parsed.id);
    seats.push(parsed);
  }
  return seats;
}

export class SeatPlan {
  private constructor(private readonly props: SeatPlanProps) {
    // Value is immutable after construction.
  }

  static create(raw: unknown): { success: boolean; value?: SeatPlan; error?: Error } {
    if (!isRecord(raw)) {
      return { success: false, error: new Error('SeatPlan must be an object') };
    }
    if (Object.keys(raw).some((key) => !PLAN_KEYS.includes(key))) {
      return { success: false, error: new Error('SeatPlan has an unknown field') };
    }
    if (raw.version !== SEAT_PLAN_VERSION) {
      return { success: false, error: new Error('SeatPlan version must be 1') };
    }
    const firstPass = parseRole(raw['first-pass'], 'first-pass');
    if (typeof firstPass === 'string') {
      return { success: false, error: new Error('SeatPlan ' + firstPass) };
    }
    const fix = parseRole(raw.fix, 'fix');
    if (typeof fix === 'string') {
      return { success: false, error: new Error('SeatPlan ' + fix) };
    }
    const review = parseRole(raw.review ?? [], 'review');
    if (typeof review === 'string') {
      return { success: false, error: new Error('SeatPlan ' + review) };
    }
    return {
      success: true,
      value: new SeatPlan({ version: SEAT_PLAN_VERSION, 'first-pass': firstPass, fix, review }),
    };
  }

  getSeats(role: SeatPlanRole): readonly SeatPlanSeat[] {
    return this.props[role];
  }

  /** The plain, cleaned shape: what the brief manifest and the attempt record store. */
  toJSON(): SeatPlanProps {
    return this.props;
  }

  equals(other: SeatPlan): boolean {
    return JSON.stringify(this.props) === JSON.stringify(other.props);
  }
}
