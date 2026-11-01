/**
 * The conductor schedule (plan §3.6, §3.7, §4): the pure read model the CLI
 * (`conductor schedule`) and API (`GET /v1/runs`) share. It projects every
 * non-terminal run into a row, mirrors LaneRunAdmissionAdapter's active /
 * in-flight admission counts, groups held reservations into host lanes, and
 * reads the driver lease and the caps of the newest pass trace. Pure: no
 * store, no clock, never throws; time enters only through `nowIso`.
 */

import { resolveLaneRunBaseBranch } from './base-branch.js';
import type { BaseBranchValue } from './base-branch.js';
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
  readonly workOrders: ReadonlyMap<string, WorkOrderRecord>;
  /** The newest pass trace as read; absent or null: none recorded. */
  readonly latestTrace?: ConductorPassTraceRead | null;
}

export interface ConductorScheduleRow {
  readonly runId: string;
  /** The run's resolved base branch; absent or unparsable on the record reads as `main`. */
  readonly baseBranch: BaseBranchValue;
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
  /** One serial queue per distinct base among live rows, sorted by code unit. */
  readonly queues: readonly { readonly baseBranch: BaseBranchValue; readonly runIds: readonly string[] }[];
  readonly hosts: readonly ConductorScheduleHostLane[];
  readonly admission: { readonly active: number; readonly inFlight: number; readonly maxActiveRuns: number | null };
  readonly caps: ConductorScheduleCaps | null;
  readonly trace: 'none' | 'recorded' | 'unreadable';
}

interface WorkOrderRecord {
  readonly repository: string;
  readonly ownedPaths: readonly string[];
}

interface RowWithOrder {
  readonly row: ScheduleRow;
  readonly workOrder: WorkOrderRecord | undefined;
}

interface ScheduleRow {
  runId: string;
  baseBranch: BaseBranchValue;
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

/** One attempt id → the first run id that lists it; walks the runs once. */
function buildAttemptRunIds(runs: readonly LaneRunRecord[]): ReadonlyMap<string, string> {
  const attemptRunIds = new Map<string, string>();
  for (const run of runs) {
    const { runId, attemptIds } = run;
    for (const attemptId of attemptIds) {
      if (!attemptRunIds.has(attemptId)) {
        attemptRunIds.set(attemptId, runId);
      }
    }
  }
  return attemptRunIds;
}

/** Caches each work-order read so a work order id hits the map at most once. */
function createWorkOrderLookup(workOrders: ReadonlyMap<string, WorkOrderRecord>): (workOrderId: string) => WorkOrderRecord | undefined {
  const cache = new Map<string, WorkOrderRecord | undefined>();
  return (workOrderId: string): WorkOrderRecord | undefined => {
    if (cache.has(workOrderId)) {
      return cache.get(workOrderId);
    }
    const order = workOrders.get(workOrderId);
    cache.set(workOrderId, order);
    return order;
  };
}

/** In-flight starts: held reservations whose attempt id no run lists (terminal ones included). */
function findInFlightReservations(
  heldByAttempt: ReadonlyMap<string, CapacityReservationRecord>,
  attemptRunIds: ReadonlyMap<string, string>,
): CapacityReservationRecord[] {
  const inFlightReservations: CapacityReservationRecord[] = [];
  for (const reservation of heldByAttempt.values()) {
    if (!attemptRunIds.has(reservation.attemptId)) {
      inFlightReservations.push(reservation);
    }
  }
  return inFlightReservations;
}

function resolveSlot(
  attemptIds: readonly string[],
  heldByAttempt: ReadonlyMap<string, CapacityReservationRecord>,
): { hostName: string; slotIndex: number } | null {
  for (const attemptId of attemptIds) {
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

interface BuildRowContext {
  readonly journals: ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]>;
  readonly halt: ConductorScheduleHalt;
  readonly heldByAttempt: ReadonlyMap<string, CapacityReservationRecord>;
  readonly readWorkOrder: (workOrderId: string) => WorkOrderRecord | undefined;
  readonly nowIso: string;
}

function buildRowEntry(run: LaneRunRecord, context: BuildRowContext): RowWithOrder | null {
  const { runId, workOrderId, tier, round, attemptIds, parked, lease } = run;
  const entries = context.journals.get(runId) ?? [];
  const state = laneRunJournalState(entries, runId);
  if ((LANE_RUN_TERMINAL_STATES as readonly LaneRunStateValue[]).includes(state)) {
    return null;
  }
  const slot = resolveSlot(attemptIds, context.heldByAttempt);
  const pending = laneRunJournalPendingIntent(entries, runId);
  const workOrder = context.readWorkOrder(workOrderId);
  const row: ScheduleRow = {
    runId,
    baseBranch: resolveLaneRunBaseBranch(run),
    workOrderId,
    tier,
    state,
    round,
    placement: computePlacement(state, context.halt, slot),
    pendingStep:
      pending === null ? null : { step: pending.step, reconciliation: pending.reconciliation },
    park: parked === null ? null : { reason: parked.reason, qualifier: parked.qualifier },
    leaseLapsed: lease === null ? null : isLeaseLapsed(lease, context.nowIso),
    packageKeys: workOrder === undefined ? null : laneRunPackageKeys(workOrder.ownedPaths),
    workOrderUnreadable: workOrder === undefined,
    overlapsWith: [],
    slot,
    admissionWait: null,
  };
  return { row, workOrder };
}

function buildRows(
  runs: readonly LaneRunRecord[],
  context: BuildRowContext,
): RowWithOrder[] {
  const entries: RowWithOrder[] = [];
  for (const run of runs) {
    const entry = buildRowEntry(run, context);
    if (entry !== null) {
      entries.push(entry);
    }
  }
  entries.sort((left, right) => left.row.runId.localeCompare(right.row.runId));
  return entries;
}

function collectOverlappingRunIds(
  entries: readonly RowWithOrder[],
  runId: string,
  workOrder: WorkOrderRecord,
): string[] {
  const overlaps: string[] = [];
  for (const other of entries) {
    const otherRunId = other.row.runId;
    if (otherRunId === runId) {
      continue;
    }
    const otherOrder = other.workOrder;
    if (otherOrder === undefined) {
      continue;
    }
    if (laneRunPackagesOverlap(workOrder, otherOrder)) {
      overlaps.push(otherRunId);
    }
  }
  return overlaps;
}

function computeOverlaps(entries: readonly RowWithOrder[]): void {
  for (const entry of entries) {
    const { row, workOrder } = entry;
    if (workOrder === undefined) {
      continue;
    }
    const overlaps = collectOverlappingRunIds(entries, row.runId, workOrder);
    overlaps.sort(byCodeUnit);
    row.overlapsWith = overlaps;
  }
}

function readCaps(
  latestTrace: ConductorScheduleFacts['latestTrace'],
): { caps: ConductorScheduleCaps | null; trace: 'none' | 'recorded' | 'unreadable' } {
  let caps: ConductorScheduleCaps | null = null;
  let trace: 'none' | 'recorded' | 'unreadable' = 'none';
  if (latestTrace !== undefined && latestTrace !== null) {
    if (latestTrace.ok) {
      const { record } = latestTrace;
      caps = {
        maxActiveRuns: record.maxActiveRuns,
        passConcurrency: record.passConcurrency,
        dispatchStaggerMs: record.dispatchStaggerMs,
        recordedAtIso: record.nowIso,
      };
      trace = 'recorded';
    } else {
      trace = 'unreadable';
    }
  }
  return { caps, trace };
}

/** Does a waiting row's work order overlap an active run's? Fail closed like admission. */
function overlapsActiveRun(
  row: ScheduleRow,
  rowOrder: WorkOrderRecord | undefined,
  activeEntries: readonly RowWithOrder[],
): boolean {
  if (rowOrder === undefined) {
    return false;
  }
  for (const other of activeEntries) {
    const otherRunId = other.row.runId;
    if (otherRunId === row.runId) {
      continue;
    }
    const otherOrder = other.workOrder;
    // Fail closed like admission: an active run whose work order is unreadable blocks.
    if (otherOrder === undefined || laneRunPackagesOverlap(rowOrder, otherOrder)) {
      return true;
    }
  }
  return false;
}

/** Does a waiting row's work order overlap an in-flight reservation's? */
function overlapsInFlight(
  rowOrder: WorkOrderRecord | undefined,
  inFlightOrders: { hasUnreadable: boolean; orders: readonly WorkOrderRecord[] },
): boolean {
  if (inFlightOrders.hasUnreadable) {
    return true;
  }
  for (const order of inFlightOrders.orders) {
    if (rowOrder !== undefined && laneRunPackagesOverlap(order, rowOrder)) {
      return true;
    }
  }
  return false;
}

/** Every in-flight reservation's work order, or an unreadable flag that blocks admission. */
function resolveInFlightOrders(
  inFlightReservations: readonly CapacityReservationRecord[],
  attemptWorkOrderIds: ReadonlyMap<string, string>,
  readWorkOrder: (workOrderId: string) => WorkOrderRecord | undefined,
): { hasUnreadable: boolean; orders: WorkOrderRecord[] } {
  const orders: WorkOrderRecord[] = [];
  for (const reservation of inFlightReservations) {
    const workOrderId = attemptWorkOrderIds.get(reservation.attemptId);
    const order = workOrderId === undefined ? undefined : readWorkOrder(workOrderId);
    if (workOrderId === undefined || order === undefined) {
      return { hasUnreadable: true, orders: [] };
    }
    orders.push(order);
  }
  return { hasUnreadable: false, orders };
}

function computeAdmissionWait(
  row: ScheduleRow,
  rowOrder: WorkOrderRecord | undefined,
  activeEntries: readonly RowWithOrder[],
  inFlightOrders: { hasUnreadable: boolean; orders: readonly WorkOrderRecord[] },
  capReached: boolean,
): 'cap' | 'package-overlap' | null {
  if (row.placement !== 'waiting') {
    return null;
  }
  if (capReached) {
    return 'cap';
  }
  if (row.workOrderUnreadable) {
    return 'package-overlap';
  }
  if (overlapsActiveRun(row, rowOrder, activeEntries)) {
    return 'package-overlap';
  }
  if (overlapsInFlight(rowOrder, inFlightOrders)) {
    return 'package-overlap';
  }
  return null;
}

function byHostName(
  left: { hostName: string },
  right: { hostName: string },
): number {
  return byCodeUnit(left.hostName, right.hostName);
}

function groupHostLanes(
  heldByAttempt: ReadonlyMap<string, CapacityReservationRecord>,
  attemptRunIds: ReadonlyMap<string, string>,
): ConductorScheduleHostLane[] {
  const hostMap = new Map<string, { hostName: string; slots: { slotIndex: number; runId: string | null }[] }>();
  for (const reservation of heldByAttempt.values()) {
    const { attemptId, slotIndex, hostName, hostId } = reservation;
    const hostKey = hostName ?? hostId;
    let lane = hostMap.get(hostKey);
    if (lane === undefined) {
      lane = { hostName: hostKey, slots: [] };
      hostMap.set(hostKey, lane);
    }
    lane.slots.push({ slotIndex, runId: attemptRunIds.get(attemptId) ?? null });
  }
  return [...hostMap.values()]
    .sort(byHostName)
    .map((lane) => ({
      hostName: lane.hostName,
      slots: [...lane.slots].sort((left, right) => left.slotIndex - right.slotIndex),
    }));
}

/**
 * Group live rows into one serial queue per distinct base branch. Rows are
 * already ordered by run id (`buildRows`), so each queue's run ids keep that
 * order; queues themselves sort by code unit.
 */
function groupQueues(
  rows: readonly ScheduleRow[],
): { readonly baseBranch: BaseBranchValue; readonly runIds: readonly string[] }[] {
  const idsByBase = new Map<BaseBranchValue, string[]>();
  for (const row of rows) {
    let ids = idsByBase.get(row.baseBranch);
    if (ids === undefined) {
      ids = [];
      idsByBase.set(row.baseBranch, ids);
    }
    ids.push(row.runId);
  }
  return [...idsByBase.entries()]
    .sort((left, right) => byCodeUnit(left[0], right[0]))
    .map(([baseBranch, runIds]) => ({ baseBranch, runIds }));
}

export function deriveConductorSchedule(facts: ConductorScheduleFacts, nowIso: string): ConductorSchedule {
  const { halt, driverLease, runs, journals, reservations, attemptWorkOrderIds, workOrders, latestTrace } = facts;
  const heldByAttempt = buildHeldByAttempt(reservations);
  const attemptRunIds = buildAttemptRunIds(runs);
  const inFlightReservations = findInFlightReservations(heldByAttempt, attemptRunIds);
  const readWorkOrder = createWorkOrderLookup(workOrders);
  const entries = buildRows(runs, {
    journals,
    halt,
    heldByAttempt,
    readWorkOrder,
    nowIso,
  });
  computeOverlaps(entries);
  const { caps, trace } = readCaps(latestTrace);
  const activeEntries = entries.filter(({ row }) => row.slot !== null);
  const active = activeEntries.length;
  const inFlight = inFlightReservations.length;
  const maxActiveRuns = caps?.maxActiveRuns ?? null;
  const capReached = maxActiveRuns !== null && active + inFlight >= maxActiveRuns;
  const inFlightOrders = resolveInFlightOrders(inFlightReservations, attemptWorkOrderIds, readWorkOrder);
  const rows: ScheduleRow[] = entries.map(({ row }) => row);
  for (const entry of entries) {
    const { row, workOrder } = entry;
    row.admissionWait = computeAdmissionWait(row, workOrder, activeEntries, inFlightOrders, capReached);
  }
  const queues = groupQueues(rows);
  const hosts = groupHostLanes(heldByAttempt, attemptRunIds);
  return {
    observedAtIso: nowIso,
    halt,
    driverLeaseLapsed: driverLease === null ? null : isLeaseLapsed(driverLease, nowIso),
    rows,
    queues,
    hosts,
    admission: { active, inFlight, maxActiveRuns },
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
