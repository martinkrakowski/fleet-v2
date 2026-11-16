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

/** How one untrusted array read ended: a bounded length, not an array, or a read that threw. */
type ArrayRead =
  | { readonly kind: 'array'; readonly length: number }
  | { readonly kind: 'not-array' }
  | { readonly kind: 'unreadable' };

/** `Array.isArray` and `.length` behind one guard; a revoked Proxy or a throwing `length` is unreadable. */
function readArrayLength(value: unknown, max: number): ArrayRead {
  try {
    if (!Array.isArray(value)) {
      return { kind: 'not-array' };
    }
    const raw: unknown = value.length;
    if (typeof raw !== 'number') {
      return { kind: 'unreadable' };
    }
    return { kind: 'array', length: Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), max) : 0 };
  } catch {
    return { kind: 'unreadable' };
  }
}

/** `.length` read once and clamped; a lying, hostile or unreadable length is bounded to 0 or `max`. */
function boundedLength(value: unknown, max: number): number {
  const read = readArrayLength(value, max);
  return read.kind === 'array' ? read.length : 0;
}

/** One element read behind a guard; a throwing Proxy get trap reads as a hole. */
function safeElementAt(
  list: readonly unknown[],
  index: number,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: list[index] };
  } catch {
    return { ok: false };
  }
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

/** One input field read behind a guard; a hostile input object reads as absent. */
function readInputField(input: ClassifyOrphanReservationsInput | undefined, key: string): unknown {
  try {
    return (input as Record<string, unknown> | undefined)?.[key];
  } catch {
    return undefined;
  }
}

/** The attempt ids one run lists; `complete` is false when any read of the list threw. */
interface RunListing {
  readonly ids: readonly string[];
  readonly complete: boolean;
}

/** One run's own fields read through descriptors, or null when the run is not a plain data record. */
function snapshotRun(element: unknown): Record<string, unknown> | null {
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
  return snap;
}

/** The attempt ids in one run's `attemptIds`, every read guarded; an unreadable read marks the listing incomplete. */
function readAttemptIdList(raw: unknown): RunListing {
  const read = readArrayLength(raw, MAX_ORPHAN_RESERVATION_SCAN);
  if (read.kind === 'not-array') {
    return { ids: [], complete: true };
  }
  if (read.kind === 'unreadable') {
    return { ids: [], complete: false };
  }
  const ids: string[] = [];
  let complete = true;
  for (let index = 0; index < read.length; index += 1) {
    const value = safeElementAt(raw as readonly unknown[], index);
    if (!value.ok) {
      complete = false;
    } else if (typeof value.value === 'string' && value.value.length > 0) {
      ids.push(value.value);
    }
  }
  return { ids, complete };
}

/** The run id of a snapshot, or null. */
function runIdOf(snap: Record<string, unknown>): string | null {
  const value = snap['runId'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The state the caller read for `runId`; a hostile map or a throwing `get` reads as unreadable. */
function runStateOf(
  runStates: OrphanReservationRunStates | undefined,
  runId: string | null,
): LaneRunStateValue | 'unreadable' | undefined {
  try {
    if (runId !== null && runStates !== undefined && runStates instanceof Map) {
      return runStates.get(runId);
    }
    return undefined;
  } catch {
    return 'unreadable';
  }
}

/** What the runs say: the states of the runs listing each attempt, and whether any run's list was unreadable. */
interface RunListings {
  readonly byAttemptId: ReadonlyMap<string, readonly (LaneRunStateValue | 'unreadable' | undefined)[]>;
  readonly incomplete: boolean;
}

function collectRunListings(
  runs: unknown,
  runStates: OrphanReservationRunStates | undefined,
): RunListings {
  const byAttemptId = new Map<string, (LaneRunStateValue | 'unreadable' | undefined)[]>();
  let incomplete = false;
  const runCount = boundedLength(runs, MAX_RUN_SCAN);
  for (let index = 0; index < runCount; index += 1) {
    const element = safeElementAt(runs as readonly unknown[], index);
    if (!element.ok || element.value === undefined || element.value === null || isHole(runs as readonly unknown[], index)) {
      continue;
    }
    const snap = snapshotRun(element.value);
    if (snap === null) {
      continue;
    }
    const listing = readAttemptIdList(snap['attemptIds']);
    incomplete = incomplete || !listing.complete;
    const state = runStateOf(runStates, runIdOf(snap));
    for (const attemptId of listing.ids) {
      const bucket = byAttemptId.get(attemptId);
      if (bucket === undefined) {
        byAttemptId.set(attemptId, [state]);
      } else {
        bucket.push(state);
      }
    }
  }
  return { byAttemptId, incomplete };
}

/** The result of one keyed attempt lookup. */
type AttemptLookup =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'value'; readonly value: unknown };

/**
 * One keyed read of a plain record through its OWN data property. An
 * inherited entry or an accessor is not a value: it is unreadable, never a
 * state the caller read.
 */
function lookupOwnDataValue(record: unknown, key: string): AttemptLookup {
  try {
    if (typeof record !== 'object' || record === null) {
      return { kind: 'unreadable' };
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined) {
      return key in record ? { kind: 'unreadable' } : { kind: 'absent' };
    }
    if (!('value' in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
      return { kind: 'unreadable' };
    }
    return { kind: 'value', value: descriptor.value };
  } catch {
    return { kind: 'unreadable' };
  }
}

function lookupAttempt(attemptsById: OrphanReservationAttemptsById, attemptId: string): AttemptLookup {
  try {
    if (attemptsById instanceof Map) {
      return { kind: 'value', value: attemptsById.get(attemptId) };
    }
  } catch {
    return { kind: 'unreadable' };
  }
  return lookupOwnDataValue(attemptsById, attemptId);
}

/** The state field of an attempt value read through its own data properties. */
function stateOfAttemptValue(value: unknown): AttemptStateValue | 'unreadable' {
  if (typeof value !== 'object') {
    return 'unreadable';
  }
  let snap: Record<string, unknown> | null;
  try {
    snap = snapshotPlainDataRecord(value);
  } catch {
    return 'unreadable';
  }
  const state = snap === null ? undefined : snap['state'];
  return typeof state === 'string' && state.length > 0 ? (state as AttemptStateValue) : 'unreadable';
}

/** The attempt's state, read defensively; null when the attempt is absent, `'unreadable'` when it cannot be read. */
function attemptStateOf(
  attemptsById: OrphanReservationAttemptsById,
  attemptId: string,
): AttemptStateValue | 'unreadable' | null {
  const lookup = lookupAttempt(attemptsById, attemptId);
  if (lookup.kind === 'unreadable') {
    return 'unreadable';
  }
  if (lookup.kind === 'absent' || lookup.value === undefined || lookup.value === null) {
    return null;
  }
  if (lookup.value === 'unreadable') {
    return 'unreadable';
  }
  return stateOfAttemptValue(lookup.value);
}

function inCapacityReleaseStates(state: string): boolean {
  return (CAPACITY_RELEASE_STATES as readonly string[]).includes(state);
}

function isTerminalRunState(state: LaneRunStateValue): boolean {
  return (LANE_RUN_TERMINAL_STATES as readonly LaneRunStateValue[]).includes(state);
}

/** The pass-wide facts every reservation is classified against. */
interface ClassifyContext {
  readonly listings: RunListings;
  readonly attemptsById: OrphanReservationAttemptsById;
  readonly nowMs: number;
  readonly graceMs: number;
}

/** One entry for a snapshotted reservation in the given bucket. */
function entryOf(
  snapshot: ReservationSnapshot,
  classification: OrphanReservationClassification,
  reason: OrphanReservationReason,
): ClassifiedOrphanReservation {
  return {
    reservationId: snapshot.id,
    attemptId: snapshot.attemptId,
    classification,
    reason,
    workOrderId: snapshot.workOrderId,
    hostName: snapshot.hostName,
    slotIndex: snapshot.slotIndex,
    reservedAtIso: snapshot.reservedAtIso,
  };
}

/** True when no clock reading can prove the reservation older than the grace. */
function withinGrace(snapshot: ReservationSnapshot, context: ClassifyContext): boolean {
  return (
    !Number.isFinite(context.nowMs) ||
    !Number.isFinite(snapshot.reservedMs) ||
    context.nowMs - snapshot.reservedMs < context.graceMs
  );
}

/** A reservation no run lists: never released. */
function classifyUnlisted(snapshot: ReservationSnapshot, context: ClassifyContext): ClassifiedOrphanReservation {
  if (withinGrace(snapshot, context)) {
    return entryOf(snapshot, 'skipped', 'within-grace');
  }
  if (context.listings.incomplete) {
    // A run whose attempt list could not be read may list this attempt.
    return entryOf(snapshot, 'unknown', 'run-state-unknown');
  }
  const state = attemptStateOf(context.attemptsById, snapshot.attemptId);
  if (state === 'unreadable') {
    return entryOf(snapshot, 'unknown', 'attempt-unreadable');
  }
  if (state === null || state === 'intent-recorded') {
    return entryOf(snapshot, 'reportOnly', 'no-run-unstarted');
  }
  return entryOf(snapshot, 'skipped', 'attempt-live');
}

/** A reservation one or more runs list: released only when every one is terminal and the attempt is finished. */
function classifyListed(
  snapshot: ReservationSnapshot,
  context: ClassifyContext,
  listingStates: readonly (LaneRunStateValue | 'unreadable' | undefined)[],
): ClassifiedOrphanReservation {
  if (listingStates.some((state) => state === undefined || state === 'unreadable')) {
    return entryOf(snapshot, 'unknown', 'run-state-unknown');
  }
  if (listingStates.some((state) => !isTerminalRunState(state as LaneRunStateValue))) {
    return entryOf(snapshot, 'skipped', 'live-run');
  }
  if (context.listings.incomplete) {
    return entryOf(snapshot, 'unknown', 'run-state-unknown');
  }
  const state = attemptStateOf(context.attemptsById, snapshot.attemptId);
  if (state === null || state === 'unreadable') {
    return entryOf(snapshot, 'unknown', 'attempt-unreadable');
  }
  return inCapacityReleaseStates(state)
    ? entryOf(snapshot, 'orphan', 'terminal-run')
    : entryOf(snapshot, 'skipped', 'attempt-live');
}

function classifySnapshot(snapshot: ReservationSnapshot, context: ClassifyContext): ClassifiedOrphanReservation {
  const listingStates = context.listings.byAttemptId.get(snapshot.attemptId);
  return listingStates === undefined || listingStates.length === 0
    ? classifyUnlisted(snapshot, context)
    : classifyListed(snapshot, context, listingStates);
}

/** The attempt and id a malformed reservation still readably carries. */
function malformedIdentity(element: unknown, index: number): { readonly id: string; readonly attemptId: string } {
  let snap: Record<string, unknown> | null = null;
  try {
    snap = snapshotPlainDataRecord(element);
  } catch {
    snap = null;
  }
  const idValue = snap?.['id'];
  const attemptValue = snap?.['attemptId'];
  return {
    id: typeof idValue === 'string' && idValue.length > 0 ? idValue : `malformed-${index}`,
    attemptId: typeof attemptValue === 'string' ? attemptValue : '',
  };
}

/** One reservation element to its entry; null when the reservation is not held (ignored). */
function classifyReservationElement(
  reservations: unknown,
  index: number,
  context: ClassifyContext,
): ClassifiedOrphanReservation | null {
  const elementRead = safeElementAt(reservations as readonly unknown[], index);
  const element = elementRead.ok ? elementRead.value : undefined;
  if (!elementRead.ok || element === undefined || element === null || isHole(reservations as readonly unknown[], index)) {
    // A hole, a null element or a throwing element read cannot even name
    // its reservation; the fallback id is deterministic so the report
    // stays stable.
    return malformedEntry(`malformed-${index}`, '');
  }
  const snapshot = snapshotReservation(element);
  if (snapshot === null) {
    // A record whose `held` is readable `false` is ignored; everything else
    // that failed the snapshot is reported malformed and never released.
    if (rawHeldOf(element) === false) {
      return null;
    }
    const identity = malformedIdentity(element, index);
    return malformedEntry(identity.id, identity.attemptId);
  }
  // A held reservation whose `id` cannot be read keeps its deterministic
  // fallback id; it is reported malformed and never released.
  if (snapshot.idFallback) {
    return malformedEntry(`malformed-${index}`, snapshot.attemptId);
  }
  return classifySnapshot(snapshot, context);
}

const byReservation = (a: ClassifiedOrphanReservation, b: ClassifiedOrphanReservation): number =>
  byCodeUnit(a.reservationId, b.reservationId) || byCodeUnit(a.attemptId, b.attemptId);

/** The grace from the input; anything but a finite non-negative number is infinite (everything within grace). */
function graceOf(input: ClassifyOrphanReservationsInput): number {
  const graceRaw = readInputField(input, 'graceMs');
  return typeof graceRaw === 'number' && Number.isFinite(graceRaw) && graceRaw >= 0 ? graceRaw : Number.POSITIVE_INFINITY;
}

/**
 * Classify the held reservations against the runs, the run states the caller
 * read and the attempts the caller read. Never throws; malformed input is
 * classified `unknown` (`malformed-reservation`) and never released, and
 * hostile arrays are bounded by the `MAX_*` scan limits with `.length` read
 * once. A run whose attempt list cannot be read makes every reservation that
 * would otherwise be released or reported `unknown`.
 */
export function classifyOrphanReservations(
  input: ClassifyOrphanReservationsInput,
): OrphanReservationClassificationResult {
  const reservations = readInputField(input, 'reservations');
  const nowRaw = readInputField(input, 'nowIso');
  const context: ClassifyContext = {
    listings: collectRunListings(
      readInputField(input, 'runs'),
      readInputField(input, 'runStates') as OrphanReservationRunStates | undefined,
    ),
    attemptsById: (readInputField(input, 'attemptsById') as OrphanReservationAttemptsById | undefined) ?? new Map(),
    nowMs: Date.parse(typeof nowRaw === 'string' ? nowRaw : ''),
    graceMs: graceOf(input),
  };

  const buckets: Record<OrphanReservationClassification, ClassifiedOrphanReservation[]> = {
    orphan: [],
    reportOnly: [],
    skipped: [],
    unknown: [],
  };
  const reservationCount = boundedLength(reservations, MAX_ORPHAN_RESERVATION_SCAN);
  for (let index = 0; index < reservationCount; index += 1) {
    const entry = classifyReservationElement(reservations, index, context);
    if (entry !== null) {
      buckets[entry.classification].push(entry);
    }
  }
  return {
    orphans: buckets.orphan.sort(byReservation),
    reportOnly: buckets.reportOnly.sort(byReservation),
    skipped: buckets.skipped.sort(byReservation),
    unknown: buckets.unknown.sort(byReservation),
  };
}
