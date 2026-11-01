/**
 * The conductor schedule (plan §3.6, §3.7, §4): the pure read model the CLI
 * (`conductor schedule`) and API (`GET /v1/runs`) share. It projects every
 * non-terminal run into a row, mirrors LaneRunAdmissionAdapter's active /
 * in-flight admission counts, groups held reservations into host lanes, and
 * reads the driver lease and the caps of the newest pass trace. Pure: no
 * store, no clock, never throws; time enters only through `nowIso`.
 */

import { laneRunJournalPendingIntent, laneRunJournalState } from './lane-run-journal.js';
import type { LaneRunJournalEntryRecord } from './lane-run-journal.js';
import { laneRunPackageKeys, laneRunPackagesOverlap } from './lane-run-packages.js';
import { isLeaseLapsed } from './lane-run-lease.js';
import { parseLaneRunKey } from './lane-run-keys.js';
import type {
  LaneRunKeyStep,
  LaneRunLeaseRecord,
  LaneRunParkReason,
  LaneRunRecord,
  LaneRunTier,
} from './lane-run-records.js';
import { LANE_RUN_TERMINAL_STATES } from './value-objects/LaneRunState.vo.js';
import type { LaneRunStateValue } from './value-objects/LaneRunState.vo.js';
import type { CapacityReservationRecord } from './execution-records.js';
import type { ConductorPassTraceRead } from './conductor-pass-trace.js';

export type ConductorScheduleHalt = 'clear' | 'halted' | 'unreadable';
export type ConductorSchedulePlacement = 'running' | 'waiting' | 'parked' | 'halted';

export interface ConductorScheduleFacts {
  readonly halt: ConductorScheduleHalt;
  /** The driver lease record, or null when none was ever taken. */
  readonly driverLease: LaneRunLeaseRecord | null;
  /** Every run record (terminal ones too); any order. */
  readonly runs: readonly LaneRunRecord[];
  /** Journal entries by run id; a missing id reads as []. */
  readonly journals: ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]>;
  /** Reservations as listed; only `held === true` ones are used. */
  readonly reservations: readonly CapacityReservationRecord[];
  /** attempt id → work order id, for in-flight reservations no run lists. */
  readonly attemptWorkOrderIds: ReadonlyMap<string, string>;
  /** Work orders by id; an absent order is flagged, never guessed. */
  readonly workOrders: ReadonlyMap<string, { readonly repository: string; readonly ownedPaths: readonly string[] }>;
  /** The newest pass trace as read; absent or null: none recorded. */
  readonly latestTrace?: ConductorPassTraceRead | null;
}

export interface ConductorScheduleRow {
  readonly runId: string;
  readonly workOrderId: string;
  readonly tier: LaneRunTier;
  readonly state: LaneRunStateValue;
  readonly round: number;
  readonly placement: ConductorSchedulePlacement;
  readonly pendingStep: { readonly step: LaneRunKeyStep; readonly reconciliation: 'unread' | 'ambiguous' } | null;
  readonly park: { readonly reason: LaneRunParkReason; readonly qualifier: string | null } | null;
  /** null when the run has no lease recorded. */
  readonly leaseLapsed: boolean | null;
  /** null when the run's work order is absent. */
  readonly packageKeys: readonly string[] | null;
  readonly workOrderUnreadable: boolean;
  /** Other rows of the same repository sharing a package key, by run id, sorted. */
  readonly overlapsWith: readonly string[];
  readonly slot: { readonly hostName: string; readonly slotIndex: number } | null;
  /** For a `waiting` row only: what admission would answer now; never a claim about why the run waits. */
  readonly admissionWait: 'cap' | 'package-overlap' | null;
}

export interface ConductorScheduleHostLane {
  readonly hostName: string;
  /** Sorted by slotIndex; runId null = an in-flight start no run lists yet. */
  readonly slots: readonly { readonly slotIndex: number; readonly runId: string | null }[];
}

export interface ConductorScheduleCaps {
  readonly maxActiveRuns: number;
  readonly passConcurrency: number;
  readonly dispatchStaggerMs: number;
  readonly recordedAtIso: string;
}

export interface ConductorSchedule {
  readonly observedAtIso: string;
  readonly halt: ConductorScheduleHalt;
  /** null when no driver lease is recorded. */
  readonly driverLeaseLapsed: boolean | null;
  readonly rows: readonly ConductorScheduleRow[];
  readonly hosts: readonly ConductorScheduleHostLane[];
  readonly admission: { readonly active: number; readonly inFlight: number; readonly maxActiveRuns: number | null };
  readonly caps: ConductorScheduleCaps | null;
  readonly trace: 'none' | 'recorded' | 'unreadable';
}

interface ScheduleRow {
  runId: string;
  workOrderId: string;
  tier: LaneRunTier;
  state: LaneRunStateValue;
  round: number;
  placement: ConductorSchedulePlacement;
  pendingStep: ConductorScheduleRow['pendingStep'];
  park: ConductorScheduleRow['park'];
  leaseLapsed: boolean | null;
  packageKeys: readonly string[] | null;
  workOrderUnreadable: boolean;
  overlapsWith: readonly string[];
  slot: ConductorScheduleRow['slot'];
  admissionWait: ConductorScheduleRow['admissionWait'];
}

/** Bytewise string order; deterministic regardless of locale. */
function byCodeUnit(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function buildHeldByAttempt(
  reservations: readonly CapacityReservationRecord[],
): Map<string, CapacityReservationRecord> {
  const heldByAttempt = new Map<string, CapacityReservationRecord>();
  for (const reservation of reservations) {
    if (reservation.held) {
      heldByAttempt.set(reservation.attemptId, reservation);
    }
  }
  return heldByAttempt;
}

/** In-flight starts: held reservations whose attempt id no run lists (terminal ones included). */
function findInFlightReservations(
  facts: ConductorScheduleFacts,
  heldByAttempt: ReadonlyMap<string, CapacityReservationRecord>,
): CapacityReservationRecord[] {
  const inFlightReservations: CapacityReservationRecord[] = [];
  for (const reservation of heldByAttempt.values()) {
    const referenced = facts.runs.some((run) => run.attemptIds.includes(reservation.attemptId));
    if (!referenced) {
      inFlightReservations.push(reservation);
    }
  }
  return inFlightReservations;
}

function resolveSlot(
  run: LaneRunRecord,
  heldByAttempt: ReadonlyMap<string, CapacityReservationRecord>,
): { hostName: string; slotIndex: number } | null {
  for (const attemptId of run.attemptIds) {
    const reservation = heldByAttempt.get(attemptId);
    if (reservation !== undefined) {
      return { hostName: reservation.hostName ?? reservation.hostId, slotIndex: reservation.slotIndex };
    }
  }
  return null;
}

function computePlacement(
  state: LaneRunStateValue,
  halt: ConductorScheduleHalt,
  slot: { hostName: string; slotIndex: number } | null,
): ConductorSchedulePlacement {
  if (state === 'parked') {
    return 'parked';
  }
  if (halt !== 'clear') {
    return 'halted';
  }
  if (slot !== null) {
    return 'running';
  }
  return 'waiting';
}

function buildRows(
  facts: ConductorScheduleFacts,
  heldByAttempt: ReadonlyMap<string, CapacityReservationRecord>,
  nowIso: string,
): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  for (const run of facts.runs) {
    const entries = facts.journals.get(run.runId) ?? [];
    const state = laneRunJournalState(entries, run.runId);
    if ((LANE_RUN_TERMINAL_STATES as readonly LaneRunStateValue[]).includes(state)) {
      continue;
    }
    const slot = resolveSlot(run, heldByAttempt);
    const pending = laneRunJournalPendingIntent(entries, run.runId);
    const workOrder = facts.workOrders.get(run.workOrderId);
    rows.push({
      runId: run.runId,
      workOrderId: run.workOrderId,
      tier: run.tier,
      state,
      round: run.round,
      placement: computePlacement(state, facts.halt, slot),
      pendingStep:
        pending === null ? null : { step: pending.step, reconciliation: pending.reconciliation },
      park: run.parked === null ? null : { reason: run.parked.reason, qualifier: run.parked.qualifier },
      leaseLapsed: run.lease === null ? null : isLeaseLapsed(run.lease, nowIso),
      packageKeys: workOrder === undefined ? null : laneRunPackageKeys(workOrder.ownedPaths),
      workOrderUnreadable: workOrder === undefined,
      overlapsWith: [],
      slot,
      admissionWait: null,
    });
  }
  rows.sort((left, right) => left.runId.localeCompare(right.runId));
  return rows;
}

function computeOverlaps(facts: ConductorScheduleFacts, rows: ScheduleRow[]): void {
  for (const row of rows) {
    const thisOrder = facts.workOrders.get(row.workOrderId);
    if (thisOrder === undefined) {
      continue;
    }
    const overlaps: string[] = [];
    for (const other of rows) {
      if (other.runId === row.runId) {
        continue;
      }
      const otherOrder = facts.workOrders.get(other.workOrderId);
      if (otherOrder === undefined) {
        continue;
      }
      if (laneRunPackagesOverlap(thisOrder, otherOrder)) {
        overlaps.push(other.runId);
      }
    }
    overlaps.sort(byCodeUnit);
    row.overlapsWith = overlaps;
  }
}

function readCaps(
  facts: ConductorScheduleFacts,
): { caps: ConductorScheduleCaps | null; trace: 'none' | 'recorded' | 'unreadable' } {
  let caps: ConductorScheduleCaps | null = null;
  let trace: 'none' | 'recorded' | 'unreadable' = 'none';
  if (facts.latestTrace !== undefined && facts.latestTrace !== null) {
    if (facts.latestTrace.ok) {
      caps = {
        maxActiveRuns: facts.latestTrace.record.maxActiveRuns,
        passConcurrency: facts.latestTrace.record.passConcurrency,
        dispatchStaggerMs: facts.latestTrace.record.dispatchStaggerMs,
        recordedAtIso: facts.latestTrace.record.nowIso,
      };
      trace = 'recorded';
    } else {
      trace = 'unreadable';
    }
  }
  return { caps, trace };
}

/** Does a waiting row's work order overlap an active run's? Fail closed like admission. */
function overlapsActiveRun(facts: ConductorScheduleFacts, rows: ScheduleRow[], row: ScheduleRow): boolean {
  const thisOrder = facts.workOrders.get(row.workOrderId);
  if (thisOrder === undefined) {
    return false;
  }
  for (const other of rows) {
    if (other.runId === row.runId || other.slot === null) {
      continue;
    }
    const otherOrder = facts.workOrders.get(other.workOrderId);
    // Fail closed like admission: an active run whose work order is unreadable blocks.
    if (otherOrder === undefined || laneRunPackagesOverlap(thisOrder, otherOrder)) {
      return true;
    }
  }
  return false;
}

/** Does a waiting row's work order overlap an in-flight reservation's? */
function overlapsInFlight(
  facts: ConductorScheduleFacts,
  inFlightReservations: readonly CapacityReservationRecord[],
  row: ScheduleRow,
): boolean {
  const thisOrder = facts.workOrders.get(row.workOrderId);
  for (const reservation of inFlightReservations) {
    const workOrderId = facts.attemptWorkOrderIds.get(reservation.attemptId);
    if (workOrderId === undefined) {
      return true;
    }
    const order = facts.workOrders.get(workOrderId);
    if (order === undefined) {
      return true;
    }
    if (thisOrder !== undefined && laneRunPackagesOverlap(order, thisOrder)) {
      return true;
    }
  }
  return false;
}

function computeAdmissionWait(
  facts: ConductorScheduleFacts,
  inFlightReservations: readonly CapacityReservationRecord[],
  rows: ScheduleRow[],
  caps: ConductorScheduleCaps | null,
  admission: { active: number; inFlight: number },
  row: ScheduleRow,
): 'cap' | 'package-overlap' | null {
  if (row.placement !== 'waiting') {
    return null;
  }
  if (caps !== null && admission.active + admission.inFlight >= caps.maxActiveRuns) {
    return 'cap';
  }
  if (row.workOrderUnreadable) {
    return 'package-overlap';
  }
  if (overlapsActiveRun(facts, rows, row)) {
    return 'package-overlap';
  }
  if (overlapsInFlight(facts, inFlightReservations, row)) {
    return 'package-overlap';
  }
  return null;
}

function findRunIdForAttempt(facts: ConductorScheduleFacts, attemptId: string): string | null {
  for (const run of facts.runs) {
    if (run.attemptIds.includes(attemptId)) {
      return run.runId;
    }
  }
  return null;
}

function byHostName(
  left: { hostName: string },
  right: { hostName: string },
): number {
  if (left.hostName < right.hostName) {
    return -1;
  }
  if (left.hostName > right.hostName) {
    return 1;
  }
  return 0;
}

function groupHostLanes(
  facts: ConductorScheduleFacts,
  heldByAttempt: ReadonlyMap<string, CapacityReservationRecord>,
): ConductorScheduleHostLane[] {
  const hostMap = new Map<string, { hostName: string; slots: { slotIndex: number; runId: string | null }[] }>();
  for (const reservation of heldByAttempt.values()) {
    const hostKey = reservation.hostName ?? reservation.hostId;
    let lane = hostMap.get(hostKey);
    if (lane === undefined) {
      lane = { hostName: hostKey, slots: [] };
      hostMap.set(hostKey, lane);
    }
    lane.slots.push({ slotIndex: reservation.slotIndex, runId: findRunIdForAttempt(facts, reservation.attemptId) });
  }
  return [...hostMap.values()]
    .sort(byHostName)
    .map((lane) => ({
      hostName: lane.hostName,
      slots: [...lane.slots].sort((left, right) => left.slotIndex - right.slotIndex),
    }));
}

export function deriveConductorSchedule(facts: ConductorScheduleFacts, nowIso: string): ConductorSchedule {
  const heldByAttempt = buildHeldByAttempt(facts.reservations);
  const inFlightReservations = findInFlightReservations(facts, heldByAttempt);
  const rows = buildRows(facts, heldByAttempt, nowIso);
  computeOverlaps(facts, rows);
  const { caps, trace } = readCaps(facts);
  const active = rows.filter((row) => row.slot !== null).length;
  const admission = { active, inFlight: inFlightReservations.length };
  for (const row of rows) {
    row.admissionWait = computeAdmissionWait(facts, inFlightReservations, rows, caps, admission, row);
  }
  const hosts = groupHostLanes(facts, heldByAttempt);
  return {
    observedAtIso: nowIso,
    halt: facts.halt,
    driverLeaseLapsed: facts.driverLease === null ? null : isLeaseLapsed(facts.driverLease, nowIso),
    rows,
    hosts,
    admission: { active: admission.active, inFlight: admission.inFlight, maxActiveRuns: caps?.maxActiveRuns ?? null },
    caps,
    trace,
  };
}

export const SESSION_START_STEPS = ['dispatch', 'brief-check', 'code-review'] as const;
export type SessionStartStep = (typeof SESSION_START_STEPS)[number];

export interface ConductorSessionStartMark {
  readonly runId: string;
  readonly step: SessionStartStep;
  readonly recordedAtIso: string;
  /** ms since the previous mark; null for the first. */
  readonly gapMs: number | null;
  /** gapMs < dispatchStaggerMs; null when the stagger is unknown or gapMs is null. */
  readonly underStagger: boolean | null;
}

function isSessionStartStep(step: LaneRunKeyStep): step is SessionStartStep {
  return (SESSION_START_STEPS as readonly string[]).includes(step);
}

function compareCandidates(
  left: { ts: number; runId: string; key: string },
  right: { ts: number; runId: string; key: string },
): number {
  if (left.ts !== right.ts) {
    return left.ts - right.ts;
  }
  if (left.runId !== right.runId) {
    return left.runId < right.runId ? -1 : 1;
  }
  return byCodeUnit(left.key, right.key);
}

function computeUnderStagger(gapMs: number | null, dispatchStaggerMs: number | null): boolean | null {
  if (gapMs === null || dispatchStaggerMs === null) {
    return null;
  }
  return gapMs < dispatchStaggerMs;
}

export function deriveSessionStartMarks(
  entries: readonly LaneRunJournalEntryRecord[],
  options: { readonly dispatchStaggerMs: number | null; readonly limit: number },
): { readonly marks: readonly ConductorSessionStartMark[]; readonly truncated: boolean } {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
    return { marks: [], truncated: false };
  }
  const candidates: {
    runId: string;
    step: SessionStartStep;
    key: string;
    ts: number;
    recordedAtIso: string;
  }[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'intent' || entry.key === null) {
      continue;
    }
    const parsed = parseLaneRunKey(entry.key);
    if (parsed?.kind !== 'step' || !isSessionStartStep(parsed.step)) {
      continue;
    }
    const ts = Date.parse(entry.recordedAtIso);
    if (Number.isNaN(ts)) {
      continue;
    }
    candidates.push({
      runId: parsed.runId,
      step: parsed.step,
      key: entry.key,
      ts,
      recordedAtIso: entry.recordedAtIso,
    });
  }
  candidates.sort(compareCandidates);
  const marks: ConductorSessionStartMark[] = candidates.map((candidate, index) => {
    const previous = candidates[index - 1];
    const gapMs = previous === undefined ? null : candidate.ts - previous.ts;
    return {
      runId: candidate.runId,
      step: candidate.step,
      recordedAtIso: candidate.recordedAtIso,
      gapMs,
      underStagger: computeUnderStagger(gapMs, options.dispatchStaggerMs),
    };
  });
  if (marks.length > options.limit) {
    return { marks: marks.slice(marks.length - options.limit), truncated: true };
  }
  return { marks, truncated: false };
}

export interface ReservationSeriesPoint {
  readonly atIso: string;
  readonly held: number;
}

export interface ReservationSeries {
  readonly points: readonly ReservationSeriesPoint[];
  readonly maxHeld: number;
  /** Records with unparseable times or a release before the reservation. */
  readonly skipped: number;
}

interface ReservationInterval {
  start: number;
  end: number | null;
}

export function deriveReservationSeries(
  reservations: readonly CapacityReservationRecord[],
  window: { readonly fromIso: string; readonly toIso: string },
): ReservationSeries {
  const fromMs = Date.parse(window.fromIso);
  const toMs = Date.parse(window.toIso);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs > toMs) {
    return { points: [], maxHeld: 0, skipped: reservations.length };
  }
  const intervals: ReservationInterval[] = [];
  let skipped = 0;
  for (const reservation of reservations) {
    const start = Date.parse(reservation.reservedAtIso);
    if (Number.isNaN(start)) {
      skipped += 1;
      continue;
    }
    if (reservation.releasedAtIso === null) {
      intervals.push({ start, end: null });
      continue;
    }
    const end = Date.parse(reservation.releasedAtIso);
    if (Number.isNaN(end) || end < start) {
      skipped += 1;
      continue;
    }
    intervals.push({ start, end });
  }
  const events = new Set<number>();
  for (const interval of intervals) {
    if (interval.start > fromMs && interval.start <= toMs) {
      events.add(interval.start);
    }
    if (interval.end !== null && interval.end > fromMs && interval.end <= toMs) {
      events.add(interval.end);
    }
  }
  const instantSet = new Set<number>(events);
  instantSet.add(fromMs);
  instantSet.add(toMs);
  const instants = [...instantSet].sort((left, right) => left - right);
  let maxHeld = 0;
  const points: ReservationSeriesPoint[] = instants.map((instant) => {
    let held = 0;
    for (const interval of intervals) {
      if (interval.start <= instant && (interval.end === null || interval.end > instant)) {
        held += 1;
      }
    }
    if (held > maxHeld) {
      maxHeld = held;
    }
    return { atIso: new Date(instant).toISOString(), held };
  });
  return { points, maxHeld, skipped };
}
