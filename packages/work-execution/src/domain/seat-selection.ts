/**
 * Seat selection over a SeatPlan (plan S1, owner's per-lane round-robin of
 * 2026-10-27). Pure: the caller supplies the lane's history, the seats the
 * installation marks unhealthy, and the model-family comparison. Nothing here
 * reads a clock, a file or another context.
 */

import type { AttemptRecord, AttemptSeatSelectionRecord, SeatObservationRecord } from './execution-records.js';
import {
  type ImplementerSeatRole,
  type SeatPlan,
  type SeatPlanRole,
  type SeatPlanSeat,
} from './value-objects/SeatPlan.vo.js';
import {
  MODEL_REFUSAL_CLASSES,
  parseStopReason,
  type StopReasonValue,
} from './value-objects/StopReason.vo.js';

/** One earlier attempt of the lane as selection reads it. */
export interface SeatHistoryEntry {
  readonly role: SeatPlanRole | null;
  readonly seatIndex: number | null;
  /** The model that actually ran (or was bound, when nothing ran). */
  readonly model: string | null;
  readonly stopReason: StopReasonValue;
}

export type SeatSelectionResult =
  | { readonly ok: true; readonly role: SeatPlanRole; readonly seatIndex: number; readonly seat: SeatPlanSeat }
  | { readonly ok: false; readonly reason: string };

export type SeatUnavailableReason = 'unhealthy' | 'cooling' | 'cooling-observed' | 'busy';

export interface SeatUnavailability {
  readonly reason: SeatUnavailableReason;
  /** Cooling: when it ends (ISO). */
  readonly until?: string;
  /** cooling-observed only: the window's first observation. */
  readonly observationId?: string;
}

/** Compares two model ids; true means "same family" (callers fail closed). */
export type SameModelFamily = (leftModel: string, rightModel: string) => boolean;

/** A stored record's stop reason; absent or undeclared reads as `unknown`. */
export function stopReasonOf(record: Pick<AttemptRecord, 'stopReason'>): StopReasonValue {
  return parseStopReason(record.stopReason);
}

/** The selection view of one stored attempt. */
export function historyEntryOf(record: AttemptRecord): SeatHistoryEntry {
  const selection = record.seatSelection ?? null;
  // Stored records are not schema-checked on read: a non-string model is treated as absent.
  const ranModel: unknown = record.runner?.model;
  const boundModel: unknown = selection?.model;
  let model: string | null = null;
  if (typeof ranModel === 'string') {
    model = ranModel;
  } else if (typeof boundModel === 'string') {
    model = boundModel;
  }
  return {
    role: selection?.role ?? null,
    seatIndex: selection?.seatIndex ?? null,
    model,
    stopReason: stopReasonOf(record),
  };
}

/** Variant equality: absent, blank and `default` all mean "no variant". */
export function normaliseSeatVariant(variant: string | null | undefined): string {
  const trimmed = variant?.trim() ?? '';
  return trimmed === 'default' ? '' : trimmed;
}

/** True when a plan seat is the seat an assignment names (model, tool, variant, agent). */
export function seatMatchesAssignment(
  seat: Pick<SeatPlanSeat, 'model' | 'tool' | 'variant' | 'agent'>,
  assignment: {
    readonly model: string;
    readonly tool?: string | null;
    readonly variant?: string | null;
    readonly agent?: string | null;
  },
): boolean {
  return (
    seat.model.trim() === assignment.model.trim() &&
    (seat.tool ?? '').trim() === (assignment.tool ?? '').trim() &&
    normaliseSeatVariant(seat.variant) === normaliseSeatVariant(assignment.variant) &&
    (seat.agent ?? '').trim() === (assignment.agent ?? '').trim()
  );
}

/** The record shape of a selection, as the attempt stores it. */
export function seatSelectionRecord(
  role: SeatPlanRole,
  seatIndex: number,
  seat: SeatPlanSeat,
): AttemptSeatSelectionRecord {
  return {
    role,
    seatIndex,
    seatId: seat.id,
    model: seat.model,
    tool: seat.tool ?? null,
    variant: seat.variant ?? null,
    agent: seat.agent ?? null,
  };
}

/** Why a seat cannot be selected now, or null when it can. */
function implementerSeatBlock(
  seat: SeatPlanSeat,
  unhealthy: ReadonlySet<string>,
  unavailable: ReadonlyMap<string, SeatUnavailability>,
  refusedModels: ReadonlyMap<string, StopReasonValue>,
  seenReasons: ReadonlySet<StopReasonValue>,
): string | null {
  if (unhealthy.has(seat.id)) {
    return seat.id + ': unhealthy';
  }
  const availability = unavailable.get(seat.id);
  if (availability !== undefined) {
    return seat.id + ': ' + availability.reason;
  }
  const refusal = refusedModels.get(seat.model.trim());
  if (refusal !== undefined) {
    return seat.id + ': model refused earlier in this lane (' + refusal + ')';
  }
  if (seat.on !== undefined && !seat.on.some((trigger) => seenReasons.has(trigger))) {
    return seat.id + ': waits for ' + seat.on.join('|');
  }
  return null;
}

/**
 * Pick the next implementer seat for `role`. `history` holds the lane's
 * earlier attempts, oldest first (the caller sorts). The cursor is the seat
 * after the one this role used last; the first eligible seat from there,
 * cyclically, is chosen. None eligible: the plan is exhausted for the role.
 */
export function selectSeat(input: {
  readonly plan: SeatPlan;
  readonly role: ImplementerSeatRole;
  readonly history: readonly SeatHistoryEntry[];
  readonly unhealthySeatIds?: readonly string[];
  readonly unavailable?: ReadonlyMap<string, SeatUnavailability>;
  readonly rotationStart?: number;
}): SeatSelectionResult {
  const seats = input.plan.getSeats(input.role);
  if (seats.length === 0) {
    return { ok: false, reason: 'Seat plan has no ' + input.role + ' seats' };
  }
  const unhealthy = new Set(input.unhealthySeatIds ?? []);
  const unavailable = input.unavailable ?? new Map<string, SeatUnavailability>();
  const refusedModels = new Map<string, StopReasonValue>();
  const seenReasons = new Set<StopReasonValue>();
  let lastIndex = -1;
  for (const entry of input.history) {
    seenReasons.add(entry.stopReason);
    if (entry.model !== null && MODEL_REFUSAL_CLASSES.includes(entry.stopReason)) {
      refusedModels.set(entry.model.trim(), entry.stopReason);
    }
    // A stored index outside the plan (negative, fractional, too large) is ignored, never trusted.
    if (
      entry.role === input.role &&
      entry.seatIndex !== null &&
      Number.isInteger(entry.seatIndex) &&
      entry.seatIndex >= 0 &&
      entry.seatIndex < seats.length
    ) {
      lastIndex = entry.seatIndex;
    }
  }
  if (isSafeRotationStart(input.rotationStart) && lastIndex === -1) {
    const eligible = eligibleSeatsForRotation(seats, (seat) =>
      isImplementerSeatBlocked(seat, unhealthy, refusedModels, unavailable),
    );
    if (eligible.length > 0) {
      const chosen = eligible[input.rotationStart % eligible.length];
      return { ok: true, role: input.role, seatIndex: chosen.index, seat: chosen.seat };
    }
  }
  const start = (lastIndex + 1) % seats.length;
  const blocks: string[] = [];
  for (let step = 0; step < seats.length; step += 1) {
    const seatIndex = (start + step) % seats.length;
    const seat = seats[seatIndex];
    const block = implementerSeatBlock(seat, unhealthy, unavailable, refusedModels, seenReasons);
    if (block === null) {
      return { ok: true, role: input.role, seatIndex, seat };
    }
    blocks.push(block);
  }
  return {
    ok: false,
    reason: 'Seat plan exhausted for role ' + input.role + ': ' + blocks.join('; '),
  };
}

/**
 * Pick the review seat for review round `round` (the attempt's fixNumber):
 * start at `round mod length`, skip unhealthy seats and any seat whose model
 * shares a family with an implementer model of the lane.
 */
export function selectReviewSeat(input: {
  readonly plan: SeatPlan;
  readonly round: number;
  readonly implementerModels: readonly string[];
  readonly sameFamily: SameModelFamily;
  readonly unhealthySeatIds?: readonly string[];
  readonly unavailable?: ReadonlyMap<string, SeatUnavailability>;
  readonly rotationStart?: number;
}): SeatSelectionResult {
  const seats = input.plan.getSeats('review');
  if (seats.length === 0) {
    return { ok: false, reason: 'Seat plan has no review seats' };
  }
  if (!Number.isInteger(input.round) || input.round < 0) {
    return { ok: false, reason: 'Review round must be a non-negative integer' };
  }
  const unhealthy = new Set(input.unhealthySeatIds ?? []);
  const unavailable = input.unavailable ?? new Map<string, SeatUnavailability>();
  if (isSafeRotationStart(input.rotationStart)) {
    const eligible = eligibleSeatsForRotation(seats, (seat) =>
      isReviewSeatBlocked(seat, unhealthy, unavailable, input.implementerModels, input.sameFamily),
    );
    if (eligible.length > 0) {
      const chosen = eligible[(input.rotationStart + input.round) % eligible.length];
      return { ok: true, role: 'review', seatIndex: chosen.index, seat: chosen.seat };
    }
  }
  const start = input.round % seats.length;
  const blocks: string[] = [];
  for (let step = 0; step < seats.length; step += 1) {
    const seatIndex = (start + step) % seats.length;
    const seat = seats[seatIndex];
    const sharedWith = input.implementerModels.find((model) => input.sameFamily(seat.model, model));
    const availability = unavailable.get(seat.id);
    if (unhealthy.has(seat.id)) {
      blocks.push(seat.id + ': unhealthy');
    } else if (availability !== undefined) {
      blocks.push(seat.id + ': ' + availability.reason);
    } else if (sharedWith === undefined) {
      return { ok: true, role: 'review', seatIndex, seat };
    } else {
      blocks.push(seat.id + ': shares a model family with implementer model ' + sharedWith);
    }
  }
  return { ok: false, reason: 'Seat plan exhausted for role review: ' + blocks.join('; ') };
}

type EligibleSeat = { readonly seat: SeatPlanSeat; readonly index: number };

/** A rotation start is trusted only when it is a non-negative safe integer (same rule as stored indexes). */
function isSafeRotationStart(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

/** The seats in plan order, without `on`, that the block predicate does not block. */
function eligibleSeatsForRotation(
  seats: readonly SeatPlanSeat[],
  isBlocked: (seat: SeatPlanSeat) => boolean,
): EligibleSeat[] {
  const eligible: EligibleSeat[] = [];
  for (let index = 0; index < seats.length; index += 1) {
    const seat = seats[index];
    if (seat.on === undefined && !isBlocked(seat)) {
      eligible.push({ seat, index });
    }
  }
  return eligible;
}

function isImplementerSeatBlocked(
  seat: SeatPlanSeat,
  unhealthy: ReadonlySet<string>,
  refusedModels: ReadonlyMap<string, StopReasonValue>,
  unavailable: ReadonlyMap<string, SeatUnavailability>,
): boolean {
  return unhealthy.has(seat.id) || refusedModels.has(seat.model.trim()) || unavailable.has(seat.id);
}

function isReviewSeatBlocked(
  seat: SeatPlanSeat,
  unhealthy: ReadonlySet<string>,
  unavailable: ReadonlyMap<string, SeatUnavailability>,
  implementerModels: readonly string[],
  sameFamily: SameModelFamily,
): boolean {
  if (unhealthy.has(seat.id) || unavailable.has(seat.id)) {
    return true;
  }
  return implementerModels.some((model) => sameFamily(seat.model, model));
}

const MINUTE_MS = 60_000;

/** Policy minutes: a non-integer or out-of-range value reads as 0 (off). */
function cooldownMs(minutes: number): number {
  return Number.isInteger(minutes) && minutes >= 0 && minutes <= 1440 ? minutes * MINUTE_MS : 0;
}

function parseIso(value: string): Date | null {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : new Date(time);
}

type ObservationWindow = {
  readonly from: Date;
  readonly until: Date;
  readonly firstObservationId: string;
};

/**
 * The cooling windows observations open per seat: the first observation opens
 * one, a later observation inside it is a duplicate and extends nothing, and
 * one at or after its end opens the next. Unparseable times are skipped.
 */
function observationWindows(
  observations: readonly SeatObservationRecord[],
  windowMs: number,
): Map<string, readonly ObservationWindow[]> {
  const grouped = new Map<string, SeatObservationRecord[]>();
  for (const observation of observations) {
    const list = grouped.get(observation.seatId);
    if (list === undefined) {
      grouped.set(observation.seatId, [observation]);
    } else {
      list.push(observation);
    }
  }
  const windows = new Map<string, readonly ObservationWindow[]>();
  for (const [seatId, list] of grouped) {
    const timed = list
      .map((observation) => ({ observation, at: parseIso(observation.observedAtIso) }))
      .filter(
        (entry): entry is { observation: SeatObservationRecord; at: Date } => entry.at !== null,
      )
      .sort((left, right) => {
        const byTime = left.at.getTime() - right.at.getTime();
        if (byTime !== 0) {
          return byTime;
        }
        return left.observation.observedAtIso < right.observation.observedAtIso ? -1 : 1;
      });
    if (timed.length === 0) {
      continue;
    }
    const seatWindows: ObservationWindow[] = [];
    let first = timed[0];
    let untilMs = first.at.getTime() + windowMs;
    for (const entry of timed.slice(1)) {
      if (entry.at.getTime() >= untilMs) {
        seatWindows.push({
          from: first.at,
          until: new Date(untilMs),
          firstObservationId: first.observation.observationId,
        });
        first = entry;
        untilMs = entry.at.getTime() + windowMs;
      }
    }
    seatWindows.push({
      from: first.at,
      until: new Date(untilMs),
      firstObservationId: first.observation.observationId,
    });
    windows.set(seatId, seatWindows);
  }
  return windows;
}

/** The window containing `nowMs`, or null when none does. */
function windowAt(windows: readonly ObservationWindow[], nowMs: number): ObservationWindow | null {
  let containing: ObservationWindow | null = null;
  for (const window of windows) {
    if (window.from.getTime() > nowMs) {
      break;
    }
    containing = window;
  }
  return containing !== null && nowMs < containing.until.getTime() ? containing : null;
}

/**
 * Which seats are cooling now (plan §3.5.3, pure). An attempt refusal cools a
 * seat for `cooldownMinutes` from the attempt's `updatedAtIso`; an observation
 * cools it for `observationCooldownMinutes` from its window's first
 * observation. An attempt's cooling wins over an observation's for the same
 * seat. Unparseable times and off policies are skipped; the result never
 * throws.
 */
export function coolingSeatIds(input: {
  readonly attempts: readonly AttemptRecord[];
  readonly observations: readonly SeatObservationRecord[];
  readonly nowIso: string;
  readonly cooldownMinutes: number;
  readonly observationCooldownMinutes: number;
}): ReadonlyMap<string, SeatUnavailability> {
  const now = parseIso(input.nowIso);
  if (now === null) {
    return new Map();
  }
  const cooling = new Map<string, SeatUnavailability>();
  const attemptsMs = cooldownMs(input.cooldownMinutes);
  for (const attempt of input.attempts) {
    const seatId = typeof attempt.seatSelection?.seatId === 'string' ? attempt.seatSelection.seatId : '';
    if (seatId.length === 0 || !MODEL_REFUSAL_CLASSES.includes(stopReasonOf(attempt))) {
      continue;
    }
    const updatedAt = parseIso(attempt.updatedAtIso);
    if (updatedAt === null) {
      continue;
    }
    const untilMs = updatedAt.getTime() + attemptsMs;
    if (now.getTime() >= untilMs) {
      continue;
    }
    const until = new Date(untilMs).toISOString();
    const existing = cooling.get(seatId);
    if (existing === undefined || until > (existing.until ?? '')) {
      cooling.set(seatId, { reason: 'cooling', until });
    }
  }
  const observationMs = cooldownMs(input.observationCooldownMinutes);
  if (observationMs > 0) {
    const nowMs = now.getTime();
    for (const [seatId, seatWindows] of observationWindows(input.observations, observationMs)) {
      if (cooling.has(seatId)) {
        continue;
      }
      const window = windowAt(seatWindows, nowMs);
      if (window !== null) {
        cooling.set(seatId, {
          reason: 'cooling-observed',
          until: window.until.toISOString(),
          observationId: window.firstObservationId,
        });
      }
    }
  }
  return cooling;
}

/**
 * Every review seat that shares a model family with a first-pass or fix
 * seat, as one message each. A plan with any such pair is refused where it
 * is frozen (S1b), so the reviewer can never be an implementer's family.
 */
export function seatPlanFamilyConflicts(plan: SeatPlan, sameFamily: SameModelFamily): string[] {
  const conflicts: string[] = [];
  const implementers: readonly { role: ImplementerSeatRole; seat: SeatPlanSeat }[] = [
    ...plan.getSeats('first-pass').map((seat) => ({ role: 'first-pass' as const, seat })),
    ...plan.getSeats('fix').map((seat) => ({ role: 'fix' as const, seat })),
  ];
  for (const reviewSeat of plan.getSeats('review')) {
    for (const implementer of implementers) {
      if (sameFamily(reviewSeat.model, implementer.seat.model)) {
        conflicts.push(
          'review seat ' + reviewSeat.id + ' shares a model family with ' + implementer.role +
            ' seat ' + implementer.seat.id,
        );
      }
    }
  }
  return conflicts;
}

/**
 * Classify a runner's refusal text into a stop reason. Order matters: a
 * missing model, then payment, then rate limits and quota, then timeouts,
 * then a provider with no route or endpoint for the model (`no-route`; a
 * host-level 'no route to host' is not one); anything else is
 * `runner-refused`. The text is matched, never stored.
 */
export function classifyRunnerRefusal(reason: string): StopReasonValue {
  const text = reason.toLowerCase();
  if (/model[^.]{0,40}not found|unknown model|model[- ]missing|providermodelnotfound/.test(text)) {
    return 'model-missing';
  }
  if (/\b402\b|payment required|insufficient credits|billing/.test(text)) {
    return 'payment';
  }
  if (/\b429\b|rate[- ]?limit|too many requests|usage exceeded|quota/.test(text)) {
    return 'rate-limited';
  }
  if (/timed? ?out|deadline exceeded|etimedout/.test(text)) {
    return 'timeout';
  }
  if (/no endpoints? (?:found|available)|no route(?! to host)|no allowed providers|no providers? (?:are )?available/.test(text)) {
    return 'no-route';
  }
  return 'runner-refused';
}
