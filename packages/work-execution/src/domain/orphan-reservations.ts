/**
 * Pure classifier for leaked capacity reservations (plan §3.9.2, OG22a).
 *
 * `StartLaneRunUseCase` reserves first and records the run last, so a held
 * reservation alone is no liveness proof: a retried start reuses the old
 * reservation (its `reservedAtIso` is not fresh), and an absent attempt reads
 * revision 0 both times, so the fenced release cannot tell a live start from
 * a crashed one. The rule this classifier encodes:
 *
 * - No run lists the attempt: never release. Past the grace with the attempt
 *   absent or `intent-recorded`, the reservation is `reportOnly`
 *   (`no-run-unstarted`); inside the grace (or with an unparseable time) it
 *   is `skipped` (`within-grace`) and neither reported nor released; a live
 *   attempt is `skipped` (`attempt-live`).
 * - One or more runs list the attempt: released only when every listing run
 *   is terminal and the attempt is in a capacity-release state (`terminal-run`).
 *
 * No I/O, no clock, never throws: every hostile input is classified or
 * skipped into a typed bucket, and a malformed reservation is never released.
 */

import {
  CAPACITY_RELEASE_STATES,
  type AttemptStateValue,
} from './value-objects/AttemptState.vo.js';
import { LANE_RUN_TERMINAL_STATES, type LaneRunStateValue } from './value-objects/LaneRunState.vo.js';
import { snapshotPlainDataRecord } from './plain-record-reads.js';

/** The largest reservations array one classification pass reads; more is ignored. */
export const MAX_ORPHAN_RESERVATION_SCAN = 10_000;

/** The largest runs array one classification pass reads; more is ignored. */
export const MAX_RUN_SCAN = 10_000;

/** Why a reservation landed in its bucket; one token per refusal path. */
export type OrphanReservationReason =
  | 'terminal-run'
  | 'no-run-unstarted'
  | 'live-run'
  | 'within-grace'
  | 'attempt-live'
  | 'run-state-unknown'
  | 'attempt-unreadable'
  | 'malformed-reservation';

/** The four buckets a reservation can land in. */
export type OrphanReservationClassification = 'orphan' | 'reportOnly' | 'skipped' | 'unknown';

/** One classified reservation with the fields every port entry needs. */
export interface ClassifiedOrphanReservation {
  readonly reservationId: string;
  readonly attemptId: string;
  readonly classification: OrphanReservationClassification;
  readonly reason: OrphanReservationReason;
  readonly workOrderId: string | null;
  readonly hostName: string | null;
  readonly slotIndex: number | null;
  readonly reservedAtIso: string | null;
}

/** The classified buckets, each sorted by reservation id in code-unit order. */
export interface OrphanReservationClassificationResult {
  readonly orphans: readonly ClassifiedOrphanReservation[];
  readonly reportOnly: readonly ClassifiedOrphanReservation[];
  readonly skipped: readonly ClassifiedOrphanReservation[];
  readonly unknown: readonly ClassifiedOrphanReservation[];
}

/** The run states the caller read per run id; `'unreadable'` is a journal read that failed. */
export type OrphanReservationRunStates = ReadonlyMap<string, LaneRunStateValue | 'unreadable'>;

/**
 * The attempt records the caller read per attempt id. `null` is known
 * absence, `'unreadable'` a failed or timed-out read, and `undefined` (a gap
 * in the map) is treated as absence. A plain record of the same shape is
 * also accepted and read through its own properties.
 */
export type OrphanReservationAttemptsById =
  | ReadonlyMap<string, AttemptRecordInput | null | 'unreadable'>
  | Record<string, AttemptRecordInput | null | 'unreadable'>;

/** The shape of an attempt the classifier reads; any other value is unreadable. */
export interface AttemptRecordInput {
  readonly state?: AttemptStateValue | string;
}

export interface ClassifyOrphanReservationsInput {
  readonly reservations: unknown;
  readonly runs: unknown;
  readonly runStates: OrphanReservationRunStates;
  readonly attemptsById: OrphanReservationAttemptsById;
  readonly nowIso: string;
  /** The grace in milliseconds; a finite non-negative number, else no-run reservations are `within-grace`. */
  readonly graceMs: number;
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const FORBIDDEN_OWN_KEYS = ['__proto__', 'constructor', 'prototype'] as const;

/** The reservation's own fields, read safely, or null when malformed. */
interface ReservationSnapshot {
  readonly id: string;
  readonly idFallback: boolean;
  readonly attemptId: string;
  readonly workOrderId: string | null;
  readonly hostName: string | null;
  readonly slotIndex: number | null;
  readonly reservedAtIso: string;
  readonly reservedMs: number;
}

/** `.length` read once and clamped; a lying or hostile length is bounded. */
function boundedLength(value: unknown, max: number): number {
  if (!Array.isArray(value)) {
    return 0;
  }
  let raw: unknown;
  try {
    raw = value.length;
  } catch {
    return 0;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  return Math.min(Math.floor(raw), max);
}

/** True when the element is absent (an array hole), checked without touching getters. */
function isHole(array: readonly unknown[], index: number): boolean {
  try {
    return !Object.prototype.hasOwnProperty.call(array, index);
  } catch {
    return true;
  }
}

function ownString(snapshot: Record<string, unknown>, key: string): string | null {
  const value = snapshot[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Snapshot one reservation record defensively; null when malformed or not held. */
function snapshotReservation(element: unknown): ReservationSnapshot | null {
  let snap: Record<string, unknown> | null;
  try {
    snap = snapshotPlainDataRecord(element);
  } catch {
    return null;
  }
  if (snap === null) {
    return null;
  }
  for (const forbidden of FORBIDDEN_OWN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(snap, forbidden)) {
      return null;
    }
  }
  if (snap['held'] !== true) {
    return null;
  }
  const id = ownString(snap, 'id');
  const attemptId = ownString(snap, 'attemptId');
  const reservedAtIso = ownString(snap, 'reservedAtIso');
  if (attemptId === null || reservedAtIso === null) {
    return null;
  }
  // An unparseable time is not malformed here: with no run listing the
  // attempt it reads as within-grace (fail closed), and it is never used
  // for a release decision on its own.
  const reservedMs = Date.parse(reservedAtIso);
  const workOrderIdValue = snap['workOrderId'];
  const hostNameValue = snap['hostName'];
  const slotIndexValue = snap['slotIndex'];
  return {
    id: id ?? '',
    idFallback: id === null,
    attemptId,
    workOrderId: typeof workOrderIdValue === 'string' ? workOrderIdValue : null,
    hostName: typeof hostNameValue === 'string' ? hostNameValue : null,
    slotIndex: typeof slotIndexValue === 'number' && Number.isFinite(slotIndexValue) ? slotIndexValue : null,
    reservedAtIso,
    reservedMs,
  };
}

/** The raw `held` value read through its own descriptor (never a getter); undefined when it cannot be read. */
function rawHeldOf(element: unknown): unknown {
  try {
    if (typeof element !== 'object' || element === null) {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(element, 'held');
    if (!descriptor || !descriptor.enumerable || descriptor.get !== undefined) {
      return undefined;
    }
    return descriptor.value;
  } catch {
    return undefined;
  }
}

/** A `malformed-reservation` unknown entry with a deterministic id. */
function malformedEntry(reservationId: string, attemptId: string): ClassifiedOrphanReservation {
  return {
    reservationId,
    attemptId,
    classification: 'unknown',
    reason: 'malformed-reservation',
    workOrderId: null,
    hostName: null,
    slotIndex: null,
    reservedAtIso: null,
  };
}

/** The attempt ids one run lists, read defensively; [] when the run is malformed. */
function runAttemptIds(element: unknown): readonly string[] {
  let snap: Record<string, unknown> | null;
  try {
    snap = snapshotPlainDataRecord(element);
  } catch {
    return [];
  }
  if (snap === null) {
    return [];
  }
  for (const forbidden of FORBIDDEN_OWN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(snap, forbidden)) {
      return [];
    }
  }
  const raw = snap['attemptIds'];
  if (!Array.isArray(raw)) {
    return [];
  }
  const ids: string[] = [];
  const count = boundedLength(raw, MAX_ORPHAN_RESERVATION_SCAN);
  for (let index = 0; index < count; index += 1) {
    const value = raw[index];
    if (typeof value === 'string' && value.length > 0) {
      ids.push(value);
    }
  }
  return ids;
}

/** The attempt's state, read defensively; null when the attempt is absent, `'unreadable'` when it cannot be read. */
function attemptStateOf(
  attemptsById: OrphanReservationAttemptsById,
  attemptId: string,
): AttemptStateValue | 'unreadable' | null {
  let lookedUp: unknown;
  try {
    lookedUp = attemptsById instanceof Map ? attemptsById.get(attemptId) : (attemptsById as Record<string, unknown>)[attemptId];
  } catch {
    return 'unreadable';
  }
  if (lookedUp === undefined || lookedUp === null) {
    return null;
  }
  if (lookedUp === 'unreadable') {
    return 'unreadable';
  }
  if (typeof lookedUp !== 'object') {
    return 'unreadable';
  }
  let snap: Record<string, unknown> | null;
  try {
    snap = snapshotPlainDataRecord(lookedUp);
  } catch {
    return 'unreadable';
  }
  if (snap === null) {
    return 'unreadable';
  }
  const state = snap['state'];
  return typeof state === 'string' && state.length > 0 ? (state as AttemptStateValue) : 'unreadable';
}

function inCapacityReleaseStates(state: string): boolean {
  return (CAPACITY_RELEASE_STATES as readonly string[]).includes(state);
}

function isTerminalRunState(state: LaneRunStateValue): boolean {
  return (LANE_RUN_TERMINAL_STATES as readonly LaneRunStateValue[]).includes(state);
}

/**
 * Classify the held reservations against the runs, the run states the caller
 * read and the attempts the caller read. Never throws; malformed input is
 * classified `unknown` (`malformed-reservation`) and never released, and
 * hostile arrays are bounded by the `MAX_*` scan limits with `.length` read
 * once.
 */
export function classifyOrphanReservations(
  input: ClassifyOrphanReservationsInput,
): OrphanReservationClassificationResult {
  const orphans: ClassifiedOrphanReservation[] = [];
  const reportOnly: ClassifiedOrphanReservation[] = [];
  const skipped: ClassifiedOrphanReservation[] = [];
  const unknown: ClassifiedOrphanReservation[] = [];

  const reservations = input?.reservations;
  const runs = input?.runs;
  const runStates = input?.runStates;
  const attemptsById = input?.attemptsById;
  const nowMs = Date.parse(typeof input?.nowIso === 'string' ? input.nowIso : '');
  const graceMs = typeof input?.graceMs === 'number' && Number.isFinite(input.graceMs) && input.graceMs >= 0
    ? input.graceMs
    : Number.POSITIVE_INFINITY;

  const reservationCount = boundedLength(reservations, MAX_ORPHAN_RESERVATION_SCAN);
  const runCount = boundedLength(runs, MAX_RUN_SCAN);

  // attemptId -> the listing runs' states, read defensively.
  const runsByAttemptId = new Map<string, (LaneRunStateValue | 'unreadable' | undefined)[]>();
  for (let index = 0; index < runCount; index += 1) {
    const element = (runs as readonly unknown[])[index];
    if (element === undefined || element === null || isHole(runs as readonly unknown[], index)) {
      continue;
    }
    const attemptIds = runAttemptIds(element);
    if (attemptIds.length === 0) {
      continue;
    }
    // The run's state comes from the caller's map; an absent id is unknown.
    let runId: string | null = null;
    try {
      const snap = snapshotPlainDataRecord(element);
      if (snap !== null && typeof snap['runId'] === 'string' && (snap['runId'] as string).length > 0) {
        runId = snap['runId'] as string;
      }
    } catch {
      runId = null;
    }
    const state = runId !== null && runStates !== undefined && runStates instanceof Map
      ? runStates.get(runId)
      : undefined;
    for (const attemptId of attemptIds) {
      const bucket = runsByAttemptId.get(attemptId);
      if (bucket === undefined) {
        runsByAttemptId.set(attemptId, [state]);
      } else {
        bucket.push(state);
      }
    }
  }

  for (let index = 0; index < reservationCount; index += 1) {
    const element = (reservations as readonly unknown[])[index];
    if (element === undefined || element === null || isHole(reservations as readonly unknown[], index)) {
      // A hole or a null element cannot even name its reservation; the
      // fallback id is deterministic so the report stays stable.
      unknown.push(malformedEntry(`malformed-${index}`, ''));
      continue;
    }
    const snapshot = snapshotReservation(element);
    if (snapshot === null) {
      // Distinguish "not held" (a released reservation: ignored) from
      // "malformed": a record whose `held` is readable `false` is ignored,
      // everything else that failed the snapshot — a primitive, a Proxy
      // with throwing traps, a throwing getter, a forbidden own key, an
      // invalid `held`, a missing id/attemptId/reservedAtIso — is reported
      // malformed and never released.
      if (rawHeldOf(element) === false) {
        continue;
      }
      let attemptId = '';
      let id: string | null = null;
      try {
        const snap = snapshotPlainDataRecord(element);
        if (snap !== null) {
          if (typeof snap['attemptId'] === 'string') {
            attemptId = snap['attemptId'];
          }
          if (typeof snap['id'] === 'string' && snap['id'].length > 0) {
            id = snap['id'];
          }
        }
      } catch {
        attemptId = '';
      }
      unknown.push(malformedEntry(id ?? `malformed-${index}`, attemptId));
      continue;
    }
    // A held reservation whose `id` cannot be read keeps its deterministic
    // fallback id; it is reported malformed and never released.
    if (snapshot.idFallback) {
      unknown.push(malformedEntry(`malformed-${index}`, snapshot.attemptId));
      continue;
    }

    const listingStates = runsByAttemptId.get(snapshot.attemptId);
    if (listingStates === undefined || listingStates.length === 0) {
      // No run lists the attempt: never release.
      const reservedMs = snapshot.reservedMs;
      if (!Number.isFinite(nowMs) || !Number.isFinite(reservedMs) || nowMs - reservedMs < graceMs) {
        skipped.push({
          reservationId: snapshot.id,
          attemptId: snapshot.attemptId,
          classification: 'skipped',
          reason: 'within-grace',
          workOrderId: snapshot.workOrderId,
          hostName: snapshot.hostName,
          slotIndex: snapshot.slotIndex,
          reservedAtIso: snapshot.reservedAtIso,
        });
        continue;
      }
      const state = attemptStateOf(attemptsById ?? new Map(), snapshot.attemptId);
      if (state === 'unreadable') {
        unknown.push({
          reservationId: snapshot.id,
          attemptId: snapshot.attemptId,
          classification: 'unknown',
          reason: 'attempt-unreadable',
          workOrderId: snapshot.workOrderId,
          hostName: snapshot.hostName,
          slotIndex: snapshot.slotIndex,
          reservedAtIso: snapshot.reservedAtIso,
        });
        continue;
      }
      if (state === null || state === 'intent-recorded') {
        reportOnly.push({
          reservationId: snapshot.id,
          attemptId: snapshot.attemptId,
          classification: 'reportOnly',
          reason: 'no-run-unstarted',
          workOrderId: snapshot.workOrderId,
          hostName: snapshot.hostName,
          slotIndex: snapshot.slotIndex,
          reservedAtIso: snapshot.reservedAtIso,
        });
        continue;
      }
      skipped.push({
        reservationId: snapshot.id,
        attemptId: snapshot.attemptId,
        classification: 'skipped',
        reason: 'attempt-live',
        workOrderId: snapshot.workOrderId,
        hostName: snapshot.hostName,
        slotIndex: snapshot.slotIndex,
        reservedAtIso: snapshot.reservedAtIso,
      });
      continue;
    }

    // One or more runs list the attempt.
    if (listingStates.some((state) => state === undefined || state === 'unreadable')) {
      unknown.push({
        reservationId: snapshot.id,
        attemptId: snapshot.attemptId,
        classification: 'unknown',
        reason: 'run-state-unknown',
        workOrderId: snapshot.workOrderId,
        hostName: snapshot.hostName,
        slotIndex: snapshot.slotIndex,
        reservedAtIso: snapshot.reservedAtIso,
      });
      continue;
    }
    if (listingStates.some((state) => !isTerminalRunState(state as LaneRunStateValue))) {
      skipped.push({
        reservationId: snapshot.id,
        attemptId: snapshot.attemptId,
        classification: 'skipped',
        reason: 'live-run',
        workOrderId: snapshot.workOrderId,
        hostName: snapshot.hostName,
        slotIndex: snapshot.slotIndex,
        reservedAtIso: snapshot.reservedAtIso,
      });
      continue;
    }
    const state = attemptStateOf(attemptsById ?? new Map(), snapshot.attemptId);
    if (state === null || state === 'unreadable') {
      unknown.push({
        reservationId: snapshot.id,
        attemptId: snapshot.attemptId,
        classification: 'unknown',
        reason: 'attempt-unreadable',
        workOrderId: snapshot.workOrderId,
        hostName: snapshot.hostName,
        slotIndex: snapshot.slotIndex,
        reservedAtIso: snapshot.reservedAtIso,
      });
      continue;
    }
    if (inCapacityReleaseStates(state)) {
      orphans.push({
        reservationId: snapshot.id,
        attemptId: snapshot.attemptId,
        classification: 'orphan',
        reason: 'terminal-run',
        workOrderId: snapshot.workOrderId,
        hostName: snapshot.hostName,
        slotIndex: snapshot.slotIndex,
        reservedAtIso: snapshot.reservedAtIso,
      });
      continue;
    }
    skipped.push({
      reservationId: snapshot.id,
      attemptId: snapshot.attemptId,
      classification: 'skipped',
      reason: 'attempt-live',
      workOrderId: snapshot.workOrderId,
      hostName: snapshot.hostName,
      slotIndex: snapshot.slotIndex,
      reservedAtIso: snapshot.reservedAtIso,
    });
  }

  const byId = (a: ClassifiedOrphanReservation, b: ClassifiedOrphanReservation): number =>
    byCodeUnit(a.reservationId, b.reservationId) || byCodeUnit(a.attemptId, b.attemptId);
  orphans.sort(byId);
  reportOnly.sort(byId);
  skipped.sort(byId);
  unknown.sort(byId);
  return { orphans, reportOnly, skipped, unknown };
}
