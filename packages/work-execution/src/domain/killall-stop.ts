/**
 * The KILLALL stop contract (plan §6): the domain shape of the stop report the
 * CLI (KA2) prints and the agent (KA3) fills, and the marker rules the conductor
 * reads. Pure: never throws, never echoes a value, never reads a clock.
 */

import { readExactPlainRecord } from './plain-record-reads.js';
import { isZonedIsoDateTime } from './conductor-halt.js';

export const KILLALL_STOP_REPORT_RECORD_VERSION = 1 as const;

/** Why a lane's stop is not confirmed (plan §6 "Reporting"). */
export const KILLALL_STOP_UNCONFIRMED_REASONS = [
  'not-stopped',        // a session was still found on the last sweep
  'sweep-incomplete',   // fewer than two consecutive clean sweeps
  'sweep-unreachable',  // the sweep could not ask the lane server
  'unknown',            // anything the agent could not classify
] as const;
export type KillallStopUnconfirmedReason = (typeof KILLALL_STOP_UNCONFIRMED_REASONS)[number];

/** The KILLALL halt marker state (plan §6): clear, halted or unreadable. */
export const KILLALL_MARKER_STATES = ['clear', 'halted', 'unreadable'] as const;
export type KillallMarkerState = (typeof KILLALL_MARKER_STATES)[number];

/** One interactive session's stop outcome (plan D-KA3); a non-content reference only. */
export interface KillallSessionResultRecord {
  readonly sessionRef: string;
  readonly stopped: boolean;
}

/** One lane's stop line (plan §6: "Per lane, one line"). */
export interface KillallLaneStopRecord {
  readonly projectId: string;
  readonly laneId: string;
  readonly confirmed: boolean;
  /** Refusal reason when not confirmed; null when confirmed. */
  readonly unconfirmedReason: KillallStopUnconfirmedReason | null;
  /** Consecutive clean sweeps observed; 0 when not stopped. */
  readonly cleanSweeps: number;
  /** When confirmation was reached; null when not confirmed. */
  readonly confirmedAtIso: string | null;
  /** Interactive sessions stopped on this lane (plan D-KA3). */
  readonly sessionResults: readonly KillallSessionResultRecord[];
}

/** The train pause, reported separately (plan §6). */
export interface KillallTrainPauseRecord {
  readonly paused: boolean;
  readonly acknowledged: boolean;
  /** Fail-closed rule named when not confirmed; null when confirmed. */
  readonly unconfirmedReason: KillallStopUnconfirmedReason | null;
}

export interface KillallStopReportRecord {
  readonly version: typeof KILLALL_STOP_REPORT_RECORD_VERSION;
  readonly haltedAtIso: string;
  /** Marker state read at stop time (plan §6). */
  readonly marker: KillallMarkerState;
  /** Clean sweeps across the whole sweep; an integer. */
  readonly cleanSweeps: number;
  readonly lanes: readonly KillallLaneStopRecord[];
  readonly train: KillallTrainPauseRecord;
}

export type KillallStopReportRead =
  | { readonly ok: true; readonly record: KillallStopReportRecord }
  | { readonly ok: false; readonly error: string };

const SESSION_RESULT_KEYS: readonly string[] = ['sessionRef', 'stopped'];
const LANE_KEYS: readonly string[] = [
  'projectId', 'laneId', 'confirmed', 'unconfirmedReason', 'cleanSweeps', 'confirmedAtIso', 'sessionResults',
];
const TRAIN_KEYS: readonly string[] = ['paused', 'acknowledged', 'unconfirmedReason'];
const REPORT_KEYS: readonly string[] = ['version', 'haltedAtIso', 'marker', 'cleanSweeps', 'lanes', 'train'];

function isKillallMarkerState(value: unknown): value is KillallMarkerState {
  return typeof value === 'string' && (KILLALL_MARKER_STATES as readonly string[]).includes(value);
}

/** True for `halted` and `unreadable` (fail closed). */
export function isKillallMarkerHalted(state: KillallMarkerState): boolean {
  return state === 'halted' || state === 'unreadable';
}

/** Missing, malformed, timed-out and transport-error reads map to `unreadable`. */
export function readKillallMarkerState(input: unknown): KillallMarkerState {
  if (isKillallMarkerState(input)) {
    return input;
  }
  return 'unreadable';
}

function isKillallStopUnconfirmedReason(value: unknown): value is KillallStopUnconfirmedReason {
  return (
    typeof value === 'string' &&
    (KILLALL_STOP_UNCONFIRMED_REASONS as readonly string[]).includes(value)
  );
}

/** An opaque session reference: no path, no spaces, no free text. */
const SESSION_REF_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** One session-result entry: a non-content reference and a stop status only. */
function readKillallSessionResult(input: unknown): KillallSessionResultRecord | null {
  const snapshot = readExactPlainRecord(input, SESSION_RESULT_KEYS);
  if (snapshot === null) {
    return null;
  }
  if (typeof snapshot.sessionRef !== 'string' || !SESSION_REF_PATTERN.test(snapshot.sessionRef)) {
    return null;
  }
  if (typeof snapshot.stopped !== 'boolean') {
    return null;
  }
  return { sessionRef: snapshot.sessionRef, stopped: snapshot.stopped };
}

/**
 * The train pause (plan §6): paused and acknowledged with a null reason, or not
 * fully confirmed with a bounded fail-closed reason. `paused: false` with
 * `acknowledged: true` is inconsistent and refused.
 */
export function readKillallTrainPause(input: unknown): KillallTrainPauseRecord | null {
  try {
    const snapshot = readExactPlainRecord(input, TRAIN_KEYS);
    if (snapshot === null) {
      return null;
    }
    if (typeof snapshot.paused !== 'boolean' || typeof snapshot.acknowledged !== 'boolean') {
      return null;
    }
    if (snapshot.paused && snapshot.acknowledged) {
      if (snapshot.unconfirmedReason !== null) {
        return null;
      }
      return { paused: true, acknowledged: true, unconfirmedReason: null };
    }
    if (!snapshot.paused && snapshot.acknowledged) {
      return null;
    }
    if (!isKillallStopUnconfirmedReason(snapshot.unconfirmedReason)) {
      return null;
    }
    return {
      paused: snapshot.paused,
      acknowledged: snapshot.acknowledged,
      unconfirmedReason: snapshot.unconfirmedReason,
    };
  } catch {
    return null;
  }
}

function readKillallSessionResults(input: unknown): readonly KillallSessionResultRecord[] | null {
  if (!Array.isArray(input)) {
    return null;
  }
  const sessionResults: KillallSessionResultRecord[] = [];
  for (const entry of input) {
    const sessionResult = readKillallSessionResult(entry);
    if (sessionResult === null) {
      return null;
    }
    sessionResults.push(sessionResult);
  }
  return sessionResults;
}

function readConfirmedLaneStop(
  projectId: string,
  laneId: string,
  snapshot: Record<string, unknown>,
  sessionResults: readonly KillallSessionResultRecord[],
): KillallLaneStopRecord | null {
  if (snapshot.unconfirmedReason !== null) {
    return null;
  }
  const cleanSweeps = snapshot.cleanSweeps;
  if (typeof cleanSweeps !== 'number' || !Number.isInteger(cleanSweeps) || cleanSweeps < 2) {
    return null;
  }
  const confirmedAtIso = snapshot.confirmedAtIso;
  if (!isZonedIsoDateTime(confirmedAtIso)) {
    return null;
  }
  if (sessionResults.some((session) => !session.stopped)) {
    return null;
  }
  return {
    projectId,
    laneId,
    confirmed: true,
    unconfirmedReason: null,
    cleanSweeps,
    confirmedAtIso,
    sessionResults,
  };
}

function readUnconfirmedLaneStop(
  projectId: string,
  laneId: string,
  snapshot: Record<string, unknown>,
  sessionResults: readonly KillallSessionResultRecord[],
): KillallLaneStopRecord | null {
  const unconfirmedReason = snapshot.unconfirmedReason;
  if (!isKillallStopUnconfirmedReason(unconfirmedReason)) {
    return null;
  }
  if (snapshot.confirmedAtIso !== null) {
    return null;
  }
  const cleanSweeps = snapshot.cleanSweeps;
  if (typeof cleanSweeps !== 'number' || !Number.isInteger(cleanSweeps) || cleanSweeps < 0) {
    return null;
  }
  return {
    projectId,
    laneId,
    confirmed: false,
    unconfirmedReason,
    cleanSweeps,
    confirmedAtIso: null,
    sessionResults,
  };
}

/** One lane's stop line (plan §6 "Reporting"). */
export function readKillallLaneStop(input: unknown): KillallLaneStopRecord | null {
  try {
    const snapshot = readExactPlainRecord(input, LANE_KEYS);
    if (snapshot === null) {
      return null;
    }
    const projectId = snapshot.projectId;
    if (typeof projectId !== 'string' || projectId.length === 0) {
      return null;
    }
    const laneId = snapshot.laneId;
    if (typeof laneId !== 'string' || laneId.length === 0) {
      return null;
    }
    if (typeof snapshot.confirmed !== 'boolean') {
      return null;
    }
    const sessionResults = readKillallSessionResults(snapshot.sessionResults);
    if (sessionResults === null) {
      return null;
    }
    if (snapshot.confirmed) {
      return readConfirmedLaneStop(projectId, laneId, snapshot, sessionResults);
    }
    return readUnconfirmedLaneStop(projectId, laneId, snapshot, sessionResults);
  } catch {
    return null;
  }
}

/** Never throws, never echoes: exact keys; version 1; zoned halt time; marker state; integer sweep count; valid lanes and train. */
export function readKillallStopReportRecord(input: unknown): KillallStopReportRead {
  try {
    const snapshot = readExactPlainRecord(input, REPORT_KEYS);
    if (snapshot === null) {
      return {
        ok: false,
        error: 'KillallStopReport must be a record with exactly version, haltedAtIso, marker, cleanSweeps, lanes and train',
      };
    }
    if (snapshot.version !== KILLALL_STOP_REPORT_RECORD_VERSION) {
      return { ok: false, error: 'KillallStopReport version must be 1' };
    }
    if (!isZonedIsoDateTime(snapshot.haltedAtIso)) {
      return { ok: false, error: 'KillallStopReport haltedAtIso must be an ISO-8601 time with a zone' };
    }
    if (!isKillallMarkerState(snapshot.marker)) {
      return { ok: false, error: 'KillallStopReport marker must be clear, halted or unreadable' };
    }
    if (typeof snapshot.cleanSweeps !== 'number' || !Number.isInteger(snapshot.cleanSweeps) || snapshot.cleanSweeps < 0) {
      return { ok: false, error: 'KillallStopReport cleanSweeps must be an integer of at least 0' };
    }
    if (!Array.isArray(snapshot.lanes)) {
      return { ok: false, error: 'KillallStopReport lanes must be an array of lane stop records' };
    }
    const lanes: KillallLaneStopRecord[] = [];
    for (const entry of snapshot.lanes) {
      const laneStop = readKillallLaneStop(entry);
      if (laneStop === null) {
        return { ok: false, error: 'KillallStopReport lanes must be an array of lane stop records' };
      }
      lanes.push(laneStop);
    }
    const train = readKillallTrainPause(snapshot.train);
    if (train === null) {
      return { ok: false, error: 'KillallStopReport train must be a train pause record' };
    }
    return {
      ok: true,
      record: {
        version: KILLALL_STOP_REPORT_RECORD_VERSION,
        haltedAtIso: snapshot.haltedAtIso,
        marker: snapshot.marker,
        cleanSweeps: snapshot.cleanSweeps,
        lanes,
        train,
      },
    };
  } catch {
    return { ok: false, error: 'KillallStopReport input could not be read' };
  }
}

/** True only when stopped and cleanSweeps is an integer of at least 2 (plan §6). */
export function isKillallSweepConfirmed(cleanSweeps: number, stopped: boolean): boolean {
  if (!stopped) {
    return false;
  }
  return Number.isInteger(cleanSweeps) && cleanSweeps >= 2;
}

/**
 * The domain side of exit code 0 (plan §6): true only when the marker is halted,
 * the train pause is confirmed, the whole sweep has at least two clean sweeps,
 * every listed lane is confirmed, and every listed session is stopped.
 */
export function killallStopReportConfirmed(report: KillallStopReportRecord): boolean {
  if (report.marker !== 'halted') {
    return false;
  }
  if (!report.train.paused || !report.train.acknowledged || report.train.unconfirmedReason !== null) {
    return false;
  }
  if (!Number.isInteger(report.cleanSweeps) || report.cleanSweeps < 2) {
    return false;
  }
  return report.lanes.every(
    (lane) => lane.confirmed && lane.sessionResults.every((session) => session.stopped),
  );
}

/** A late start reopens the report (plan §6): the matching confirmed lane is reopened, nothing else changes. */
export function reopenOnLateStart(
  report: KillallStopReportRecord,
  projectId: string,
  laneId: string,
  atIso: string,
): KillallStopReportRecord {
  if (!isZonedIsoDateTime(atIso)) {
    return report;
  }
  let matchedIndex = -1;
  for (let i = 0; i < report.lanes.length; i += 1) {
    const laneStop = report.lanes[i];
    if (laneStop.projectId === projectId && laneStop.laneId === laneId) {
      matchedIndex = i;
      break;
    }
  }
  if (matchedIndex === -1) {
    return report;
  }
  const laneStop = report.lanes[matchedIndex];
  if (!laneStop.confirmed) {
    return report;
  }
  const lanes = report.lanes.slice();
  lanes[matchedIndex] = {
    ...laneStop,
    confirmed: false,
    unconfirmedReason: 'not-stopped',
    cleanSweeps: 0,
    confirmedAtIso: null,
  };
  return { ...report, lanes };
}
