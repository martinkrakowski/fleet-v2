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
  type SeatPlanProps,
  type SeatPlanRole,
  type SeatPlanSeat,
} from './value-objects/SeatPlan.vo.js';
import {
  MODEL_REFUSAL_CLASSES,
  SEAT_TRIGGER_CLASSES,
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
 * How an attempt's seat turn ended. `ok` succeeded; the failure outcomes map
 * onto the stop-reason classes a fallback seat's `on` may name:
 * `rate-limited` and `timeout` are their own classes, and every other trigger
 * class reads as `provider-error`. `none` and `unknown` map to no outcome at
 * all: an ended-normally turn is not a failure, and an undeclared one never
 * triggers a fallback (fail closed).
 */
export type SeatOutcome = 'ok' | 'rate-limited' | 'timeout' | 'provider-error';

/** The failure outcomes: the ones a failed turn can record. */
export type SeatFailureOutcome = Exclude<SeatOutcome, 'ok'>;

/** The stop-reason trigger classes each failure outcome covers (total over SEAT_TRIGGER_CLASSES). */
export const SEAT_OUTCOME_TRIGGER_CLASSES: Readonly<Record<SeatFailureOutcome, readonly StopReasonValue[]>> = {
  'rate-limited': ['rate-limited'],
  timeout: ['timeout'],
  'provider-error': SEAT_TRIGGER_CLASSES.filter(
    (trigger) => trigger !== 'rate-limited' && trigger !== 'timeout',
  ),
};

/** The failure outcome of a failed turn's stop reason, or null when it maps to none (fail closed). */
export function seatOutcomeOfStopReason(reason: StopReasonValue): SeatFailureOutcome | null {
  if (reason === 'rate-limited') {
    return 'rate-limited';
  }
  if (reason === 'timeout') {
    return 'timeout';
  }
  if (SEAT_TRIGGER_CLASSES.includes(reason)) {
    return 'provider-error';
  }
  return null;
}

export type NextSeatResult =
  | { readonly ok: true; readonly role: SeatPlanRole; readonly seatIndex: number; readonly seat: SeatPlanSeat }
  | { readonly ok: false; readonly reason: 'no-seat-allowed' };

/**
 * The next seat for `role` after the failed turn at `failedIndex`, in
 * rotation order. A seat is eligible only when the supplied block predicate
 * allows it (the caller composes reviewer-family exclusion and any outage)
 * AND its declared triggers allow the outcome: absent `on` is always
 * eligible, otherwise one of its classes must be one the outcome covers.
 * The failed seat itself is never eligible: the rotation may not wrap
 * around onto the seat that just failed (a one-seat plan therefore always
 * reads no-seat-allowed).
 * A `failedIndex` outside the plan, an empty role or no eligible seat reads
 * `no-seat-allowed`: nothing is ever guessed past the plan.
 */
export function pickNextSeat(
  plan: SeatPlan,
  role: SeatPlanRole,
  failedIndex: number,
  outcome: SeatFailureOutcome,
  isBlocked: (seat: SeatPlanSeat) => boolean,
): NextSeatResult {
  const seats = plan.getSeats(role);
  const validIndex =
    Number.isSafeInteger(failedIndex) && failedIndex >= 0 && failedIndex < seats.length && seats.length > 1;
  if (!validIndex) {
    return { ok: false, reason: 'no-seat-allowed' };
  }
  const triggers = SEAT_OUTCOME_TRIGGER_CLASSES[outcome];
  for (let step = 1; step < seats.length; step += 1) {
    const seatIndex = (failedIndex + step) % seats.length;
    if (seatIndex === failedIndex) {
      // The failed seat itself is never eligible: no wrap-around re-pick.
      continue;
    }
    const seat = seats[seatIndex];
    if (isBlocked(seat)) {
      continue;
    }
    if (seat.on !== undefined && !seat.on.some((trigger) => triggers.includes(trigger))) {
      continue;
    }
    return { ok: true, role, seatIndex, seat };
  }
  return { ok: false, reason: 'no-seat-allowed' };
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

/**
 * Every model that implemented the lane (plan §3.5.6): ran, else bound. Fails
 * closed on an attempt with neither.
 */
export function implementerModelsOf(
  attempts: readonly AttemptRecord[],
): { readonly ok: true; readonly models: readonly string[] } | { readonly ok: false; readonly attemptId: string } {
  const models: string[] = [];
  const seen = new Set<string>();
  for (const attempt of attempts) {
    const model = historyEntryOf(attempt).model;
    const trimmed = (model ?? '').trim();
    if (trimmed.length === 0) {
      return { ok: false, attemptId: attempt.id };
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      models.push(trimmed);
    }
  }
  return { ok: true, models };
}

export type PreMergeSeatSelectionResult =
  | { readonly ok: true; readonly seatIndex: number; readonly seat: SeatPlanSeat }
  | { readonly ok: false; readonly reason: string };

/**
 * Pick the pre-merge (Tier 2) review seat from the installation's plain
 * `chains['high-risk-reviewer']` chain (plan §3.5.1, D8), in owner order. A
 * seat that shares a model family with any model that implemented the lane —
 * first pass or fix round, including an agy round whose runner is null — is
 * never selected. The returned `seatIndex` is the seat's index in `seats`.
 *
 * Callers honouring conductor D10 do not call this after a recorded pre-merge
 * `fail`: they pin the recorded seat (its `seatIndex`) directly. `rotationStart`
 * indexes the *eligible* list, so passing a pinned `seatIndex` as
 * `rotationStart` would pick a different seat.
 */
export function selectPreMergeSeat(input: {
  readonly seats: readonly SeatPlanSeat[];
  readonly attempts: readonly AttemptRecord[];
  readonly sameFamily: SameModelFamily;
  readonly unhealthySeatIds?: readonly string[];
  readonly unavailable?: ReadonlyMap<string, SeatUnavailability>;
  readonly rotationStart?: number;
}): PreMergeSeatSelectionResult {
  if (input.seats.length === 0) {
    return { ok: false, reason: 'No pre-merge seats' };
  }
  const models = implementerModelsOf(input.attempts);
  if (!models.ok) {
    return { ok: false, reason: 'Implementer model unknown for attempt ' + models.attemptId };
  }
  const unhealthy = new Set(input.unhealthySeatIds ?? []);
  const unavailable = input.unavailable ?? new Map<string, SeatUnavailability>();
  if (isSafeRotationStart(input.rotationStart)) {
    const eligible = eligibleSeatsForRotation(input.seats, (seat) =>
      isPreMergeSeatBlocked(seat, unhealthy, unavailable, models.models, input.sameFamily),
    );
    if (eligible.length > 0) {
      const chosen = eligible[input.rotationStart % eligible.length];
      return { ok: true, seatIndex: chosen.index, seat: chosen.seat };
    }
  }
  const blocks: string[] = [];
  for (const [seatIndex, seat] of input.seats.entries()) {
    const block = preMergeSeatBlock(seat, unhealthy, unavailable, models.models, input.sameFamily);
    if (block === null) {
      return { ok: true, seatIndex, seat };
    }
    blocks.push(block);
  }
  return { ok: false, reason: 'Pre-merge seats exhausted: ' + blocks.join('; ') };
}

/** Why a pre-merge chain seat cannot be selected now, or null when it can. */
function preMergeSeatBlock(
  seat: SeatPlanSeat,
  unhealthy: ReadonlySet<string>,
  unavailable: ReadonlyMap<string, SeatUnavailability>,
  implementerModels: readonly string[],
  sameFamily: SameModelFamily,
): string | null {
  if (unhealthy.has(seat.id)) {
    return seat.id + ': unhealthy';
  }
  const availability = unavailable.get(seat.id);
  if (availability !== undefined) {
    return seat.id + ': ' + availability.reason;
  }
  if (seat.on !== undefined) {
    return seat.id + ': fallback seats are not used for pre-merge';
  }
  const sharedWith = implementerModels.find((model) => sameFamily(seat.model, model));
  if (sharedWith !== undefined) {
    return seat.id + ': shares a model family with implementer model ' + sharedWith;
  }
  return null;
}

function isPreMergeSeatBlocked(
  seat: SeatPlanSeat,
  unhealthy: ReadonlySet<string>,
  unavailable: ReadonlyMap<string, SeatUnavailability>,
  implementerModels: readonly string[],
  sameFamily: SameModelFamily,
): boolean {
  return preMergeSeatBlock(seat, unhealthy, unavailable, implementerModels, sameFamily) !== null;
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
        // Same instant: the observation id breaks the tie, so the order is total and stable.
        return left.observation.observationId.localeCompare(right.observation.observationId);
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
  // A cooldown of 0 is off: no attempt cools a seat, whatever its timestamp.
  for (const attempt of attemptsMs > 0 ? input.attempts : []) {
    const seatId = typeof attempt.seatSelection?.seatId === 'string' ? attempt.seatSelection.seatId : '';
    if (seatId.length === 0 || !MODEL_REFUSAL_CLASSES.includes(stopReasonOf(attempt))) {
      continue;
    }
    const updatedAt = parseIso(attempt.updatedAtIso);
    if (updatedAt === null) {
      continue;
    }
    // A refusal stamped in the future (another host's skewed clock) cools from now, never from that future instant.
    const untilMs = Math.min(updatedAt.getTime(), now.getTime()) + attemptsMs;
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

// ---------------------------------------------------------------------------
// The seat catalogue: the installation's seats and chains as a structural
// subset (plan §3.5.7). Pure: the caller supplies the catalogue object and
// nothing here reads a clock, a file, a port or another package.
// ---------------------------------------------------------------------------

/** One seat of the installation, as a structural subset (the installation package is never imported). */
export interface SeatCatalogSeat {
  readonly id: string;
  readonly tool: string;
  readonly model: string;
  readonly variant?: string;
  readonly agent?: string;
  readonly health?: string;
}

/** One step of a chain: the seat it names and the installation triggers that open it. */
export interface SeatCatalogChainStep {
  readonly seatId: string;
  readonly triggers?: readonly string[];
}

/** The chains the seat plan is built from. The pre-merge chain is not carried: SeatPlan v1 has three roles. */
export interface SeatCatalogChains {
  readonly implementer?: readonly SeatCatalogChainStep[];
  readonly fix?: readonly SeatCatalogChainStep[];
  readonly reviewer?: readonly SeatCatalogChainStep[];
}

/** The installation's seat catalogue: a structural subset, exactly as AllowedSeatPort does it. */
export interface SeatCatalog {
  readonly seats?: readonly SeatCatalogSeat[];
  readonly chains?: SeatCatalogChains;
}

/** The built plan, or a typed refusal. Never a throw. */
export type SeatPlanFromCatalogResult =
  | { readonly plan: SeatPlanProps }
  | { readonly reason: string };

/** The catalogue may hold at most this many seats; a larger one is refused, never truncated. */
const SEAT_CATALOG_SEAT_BOUND = 256;

/** Each chain may hold at most this many steps; a larger one is refused, never truncated. */
const SEAT_CATALOG_CHAIN_STEP_BOUND = 64;

const CATALOG_TRIGGER_TO_STOP_REASON: Readonly<Record<string, StopReasonValue>> = {
  '429': 'rate-limited',
  '402': 'payment',
  timeout: 'timeout',
  quota: 'rate-limited',
  'no-commit': 'no-commit',
};

const CATALOG_CHAIN_ROLES = ['implementer', 'fix', 'reviewer'] as const;

type CatalogChainRole = (typeof CATALOG_CHAIN_ROLES)[number];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The catalogue's seats as typed records, or the rule-and-position refusal. */
function catalogSeatsOf(
  catalog: Record<string, unknown>,
): { readonly ok: true; readonly seats: readonly SeatCatalogSeat[] } | { readonly ok: false; readonly reason: string } {
  const rawSeats = catalog['seats'];
  if (rawSeats === undefined) {
    return { ok: true, seats: [] };
  }
  if (!Array.isArray(rawSeats)) {
    return { ok: false, reason: 'The seat catalogue carries seats that are not a list' };
  }
  if (rawSeats.length > SEAT_CATALOG_SEAT_BOUND) {
    return { ok: false, reason: 'The seat catalogue carries more than ' + SEAT_CATALOG_SEAT_BOUND + ' seats' };
  }
  const seats: SeatCatalogSeat[] = [];
  for (const [index, rawSeat] of rawSeats.entries()) {
    if (!isPlainObject(rawSeat)) {
      return { ok: false, reason: 'The seat catalogue seat at index ' + index + ' is not an object' };
    }
    const id = rawSeat['id'];
    const tool = rawSeat['tool'];
    const model = rawSeat['model'];
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, reason: 'The seat catalogue seat at index ' + index + ' carries no id' };
    }
    if (typeof tool !== 'string') {
      return { ok: false, reason: 'The seat catalogue seat at index ' + index + ' carries no tool' };
    }
    if (typeof model !== 'string') {
      return { ok: false, reason: 'The seat catalogue seat at index ' + index + ' carries no model' };
    }
    const variant = rawSeat['variant'];
    const agent = rawSeat['agent'];
    const health = rawSeat['health'];
    seats.push({
      id,
      tool,
      model,
      ...(typeof variant === 'string' ? { variant } : {}),
      ...(typeof agent === 'string' ? { agent } : {}),
      ...(typeof health === 'string' ? { health } : {}),
    });
  }
  return { ok: true, seats };
}

/** One chain's steps as typed records, or the rule-and-position refusal. */
function catalogStepsOf(
  role: CatalogChainRole,
  rawSteps: unknown,
): { readonly ok: true; readonly steps: readonly SeatCatalogChainStep[] } | { readonly ok: false; readonly reason: string } {
  if (rawSteps === undefined) {
    return { ok: true, steps: [] };
  }
  if (!Array.isArray(rawSteps)) {
    return { ok: false, reason: 'The seat catalogue ' + role + ' chain is not a list' };
  }
  if (rawSteps.length > SEAT_CATALOG_CHAIN_STEP_BOUND) {
    return {
      ok: false,
      reason: 'The seat catalogue ' + role + ' chain carries more than ' + SEAT_CATALOG_CHAIN_STEP_BOUND + ' steps',
    };
  }
  const steps: SeatCatalogChainStep[] = [];
  for (const [index, rawStep] of rawSteps.entries()) {
    if (!isPlainObject(rawStep)) {
      return { ok: false, reason: 'The seat catalogue ' + role + ' chain step ' + index + ' is not an object' };
    }
    const seatId = rawStep['seatId'];
    if (typeof seatId !== 'string' || seatId.trim() === '') {
      return { ok: false, reason: 'The seat catalogue ' + role + ' chain step ' + index + ' carries no seatId' };
    }
    const rawTriggers = rawStep['triggers'];
    if (rawTriggers === undefined) {
      steps.push({ seatId });
      continue;
    }
    if (!Array.isArray(rawTriggers)) {
      return { ok: false, reason: 'The seat catalogue ' + role + ' chain step ' + index + ' carries triggers that are not a list' };
    }
    const triggers: string[] = [];
    for (const trigger of rawTriggers) {
      if (typeof trigger !== 'string') {
        return { ok: false, reason: 'The seat catalogue ' + role + ' chain step ' + index + ' carries a trigger that is not a string' };
      }
      triggers.push(trigger);
    }
    steps.push({ seatId, triggers });
  }
  return { ok: true, steps };
}

function catalogPlanSeat(step: SeatCatalogChainStep, seat: SeatCatalogSeat): SeatPlanSeat {
  const on = [
    ...new Set(
      (step.triggers ?? []).map((trigger) => CATALOG_TRIGGER_TO_STOP_REASON[trigger]),
    ),
  ];
  return {
    id: seat.id,
    model: seat.model,
    tool: seat.tool,
    ...(seat.variant !== undefined ? { variant: seat.variant } : {}),
    ...(seat.agent !== undefined ? { agent: seat.agent } : {}),
    ...(on.length > 0 ? { on } : {}),
  };
}

/**
 * Build the S1 seat plan from the installation's seat catalogue (the code
 * moved out of the CLI, plan §3.5.7). The parameter is `unknown` on purpose:
 * every runtime input is validated inside, and every failure is the typed
 * refusal `{ reason }` — never a throw. Triggers map onto stop-reason classes;
 * a trigger outside the table is a refusal, never an `on` holding `undefined`.
 * A chain step naming an undeclared seat is skipped. The refusal for a missing
 * implementer chain is frozen: the CLI prints it as its exit-2 usage message.
 */
export function seatPlanFromCatalog(catalog: unknown): SeatPlanFromCatalogResult {
  if (!isPlainObject(catalog)) {
    return { reason: 'The seat catalogue is not an object' };
  }
  let seats: readonly SeatCatalogSeat[];
  try {
    const parsed = catalogSeatsOf(catalog);
    if (!parsed.ok) {
      return parsed;
    }
    seats = parsed.seats;
    const rawChains = catalog['chains'];
    if (rawChains !== undefined && !isPlainObject(rawChains)) {
      return { reason: 'The seat catalogue chains are not an object' };
    }
    const chainsSource: Record<string, unknown> = rawChains ?? {};
    const chains: Partial<Record<CatalogChainRole, readonly SeatCatalogChainStep[]>> = {};
    for (const role of CATALOG_CHAIN_ROLES) {
      const parsedSteps = catalogStepsOf(role, chainsSource[role]);
      if (!parsedSteps.ok) {
        return parsedSteps;
      }
      chains[role] = parsedSteps.steps;
    }
    const seatsById = new Map(seats.map((seat) => [seat.id, seat] as const));
    const planSeatsOf = (role: CatalogChainRole): SeatPlanSeat[] | SeatPlanFromCatalogResult => {
      const out: SeatPlanSeat[] = [];
      const steps = chains[role] ?? [];
      for (const [index, step] of steps.entries()) {
        for (const trigger of step.triggers ?? []) {
          if (CATALOG_TRIGGER_TO_STOP_REASON[trigger] === undefined) {
            return {
              reason: 'The seat catalogue ' + role + ' chain step ' + index + ' names a trigger that is not a declared stop-reason class',
            };
          }
        }
        const seat = seatsById.get(step.seatId);
        if (seat !== undefined) {
          out.push(catalogPlanSeat(step, seat));
        }
      }
      return out;
    };
    const firstPass = planSeatsOf('implementer');
    if (!Array.isArray(firstPass)) {
      return firstPass;
    }
    if (firstPass.length === 0) {
      return { reason: 'The installation has no implementer chain to build a seat plan from' };
    }
    const fixSteps = chains['fix'] ?? [];
    const fixSource: CatalogChainRole = fixSteps.length > 0 ? 'fix' : 'implementer';
    const fix = fixSource === 'fix' ? planSeatsOf('fix') : firstPass;
    if (!Array.isArray(fix)) {
      return fix;
    }
    const review = planSeatsOf('reviewer');
    if (!Array.isArray(review)) {
      return review;
    }
    return {
      plan: {
        version: 1,
        'first-pass': firstPass,
        fix,
        review,
      },
    };
  } catch {
    // A throwing getter on the catalogue object is a refusal, never a crash.
    return { reason: 'The seat catalogue could not be read' };
  }
}

/**
 * Seat ids the catalogue marks unhealthy, in file order (the code moved out of
 * the CLI). An absent or malformed catalogue, or a throwing getter, yields
 * `[]` — never a throw; the plan builder owns the typed refusal for a bad
 * catalogue, so the CLI's exit-2 path is unaffected.
 */
export function unhealthySeatIdsFromCatalog(catalog: unknown): string[] {
  try {
    if (!isPlainObject(catalog)) {
      return [];
    }
    const rawSeats = catalog['seats'];
    if (!Array.isArray(rawSeats)) {
      return [];
    }
    const ids: string[] = [];
    for (const rawSeat of rawSeats) {
      if (!isPlainObject(rawSeat)) {
        continue;
      }
      const id = rawSeat['id'];
      if (typeof id === 'string' && rawSeat['health'] === 'unhealthy') {
        ids.push(id);
      }
    }
    return ids;
  } catch {
    return [];
  }
}
