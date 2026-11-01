/**
 * Pure events.jsonl projection records and cursor helpers (daemon-tick plan
 * §3.1, §3.2): header {"version":1} followed by fixed 10-field records
 * { version, eventId, tickId, jobId, kind, key, entryId, outcome, reasonCode, recordedAtIso }.
 * Journal rules for codes and secret shapes; no other field.
 */

import { containsSecretShape } from '@fleet/shared';
import { isZonedIsoDateTime } from './conductor-halt.js';
import {
  DAEMON_ENTRY_ID_PATTERN,
  DAEMON_JOB_OUTCOMES,
  DAEMON_TICK_ID_PATTERN,
  parseDaemonJobId,
} from './daemon-tick.js';
import type { DaemonJobOutcome } from './daemon-tick.js';
import {
  LANE_RUN_JOURNAL_OUTCOMES,
  LANE_RUN_JOURNAL_REASON_CODE_PATTERN,
} from './lane-run-journal.js';
import type { LaneRunJournalEntryRecord } from './lane-run-journal.js';
import { LANE_RUN_KEY_MAX_LENGTH, parseLaneRunKey, REQUEST_ID_PATTERN } from './lane-run-keys.js';

export const DAEMON_EVENT_PROJECTION_VERSION = 1 as const;

/**
 * Pinned projection kinds. `queue` and `status` extend plan §3.1 (`:46`) for the
 * notifier (`:68`): queue outcomes and pause/halt transitions. Do not add a kind.
 */
export const DAEMON_EVENT_KINDS = ['intent', 'result', 'job', 'queue', 'status'] as const;
export type DaemonEventKind = (typeof DAEMON_EVENT_KINDS)[number];

/** Pinned notifier queue outcomes (plan `:68` names merged, dropped, and parked; superseded is the queue's other terminal). */
export const DAEMON_QUEUE_EVENT_OUTCOMES = ['merged', 'dropped', 'parked', 'superseded'] as const;
export type DaemonQueueEventOutcome = (typeof DAEMON_QUEUE_EVENT_OUTCOMES)[number];

/** Pinned pause/halt transitions the notifier reads (plan `:68`). */
export const DAEMON_STATUS_EVENT_OUTCOMES = ['paused', 'resumed', 'halted', 'unhalted'] as const;
export type DaemonStatusEventOutcome = (typeof DAEMON_STATUS_EVENT_OUTCOMES)[number];

/** Job id on a status line that is not about one registered job (plan `:68`). */
export const DAEMON_STATUS_EVENT_JOB_ID = 'daemon';

export const DAEMON_EVENT_KEYS = [
  'version',
  'eventId',
  'tickId',
  'jobId',
  'kind',
  'key',
  'entryId',
  'outcome',
  'reasonCode',
  'recordedAtIso',
] as const;

export interface DaemonEventHeaderRecord {
  readonly version: typeof DAEMON_EVENT_PROJECTION_VERSION;
}

export type DaemonEventHeaderRead =
  | { readonly ok: true; readonly header: DaemonEventHeaderRecord }
  | { readonly ok: false; readonly reason: 'unknown-version' | 'malformed'; readonly error: string };

export interface DaemonEventRecord {
  readonly version: typeof DAEMON_EVENT_PROJECTION_VERSION;
  readonly eventId: string;
  readonly tickId: string;
  readonly jobId: string;
  readonly kind: DaemonEventKind;
  readonly key: string | null;
  readonly entryId: string | null;
  readonly outcome: string | null;
  readonly reasonCode: string | null;
  readonly recordedAtIso: string;
}

export type DaemonEventRead =
  | { readonly ok: true; readonly record: DaemonEventRecord }
  | { readonly ok: false; readonly reason: 'unknown-version' | 'malformed'; readonly error: string };

export type DaemonEventLineRead =
  | { readonly ok: true; readonly lineKind: 'header'; readonly header: DaemonEventHeaderRecord }
  | { readonly ok: true; readonly lineKind: 'event'; readonly record: DaemonEventRecord }
  | { readonly ok: false; readonly reason: 'unknown-version' | 'malformed'; readonly error: string };

const DAEMON_EVENT_HEADER_MALFORMED = 'DaemonEventHeader is malformed';
const DAEMON_EVENT_HEADER_VERSION = 'DaemonEventHeader version is not supported';
const DAEMON_EVENT_MALFORMED = 'DaemonEvent is malformed';
const DAEMON_EVENT_VERSION = 'DaemonEvent version is not supported';
const DAEMON_EVENT_LINE_NOT_JSON = 'DaemonEvent line is not JSON';

const MERGE_KEY_ONE_WAY_PATTERN =
  /^merge\/[0-9a-f]{12}\/[1-9]\d{0,9}\/[0-9a-f]{12}\/(?:merge-pr|update-branch|post-status)(?:\/r[1-9])?$/;
const MERGE_KEY_TWO_WAY_PATTERN =
  /^merge\/[0-9a-f]{12}\/[1-9]\d{0,9}\/[0-9a-f]{12}\/(?:macos-verify|veto)\/a(?:[1-9]|[12]\d|3[0-2])$/;

/**
 * A descriptor-safe plain-object snapshot: a non-array object whose prototype is
 * `Object.prototype` or `null`, whose own keys are enumerable data strings, read
 * through their own property descriptors so no getter ever runs.
 */
function readPlainSnapshot(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return null;
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return null;
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function hasExactKeys(snapshot: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(snapshot);
  if (ownKeys.length !== keys.length) {
    return false;
  }
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !keys.includes(key)) {
      return false;
    }
  }
  return true;
}

function headerFailure(reason: 'unknown-version' | 'malformed'): DaemonEventHeaderRead {
  return { ok: false, reason, error: reason === 'malformed' ? DAEMON_EVENT_HEADER_MALFORMED : DAEMON_EVENT_HEADER_VERSION };
}

function eventFailure(reason: 'unknown-version' | 'malformed'): DaemonEventRead {
  return { ok: false, reason, error: reason === 'malformed' ? DAEMON_EVENT_MALFORMED : DAEMON_EVENT_VERSION };
}

/** The shared v1 header reader: only own key `version`; `1` reads, another number is unknown, anything else malformed. */
export function readDaemonEventHeader(input: unknown): DaemonEventHeaderRead {
  try {
    const snapshot = readPlainSnapshot(input);
    if (snapshot === null || !hasExactKeys(snapshot, ['version'])) {
      return headerFailure('malformed');
    }
    const version = snapshot.version;
    if (version === DAEMON_EVENT_PROJECTION_VERSION) {
      return { ok: true, header: Object.freeze({ version: DAEMON_EVENT_PROJECTION_VERSION }) };
    }
    if (typeof version === 'number') {
      return headerFailure('unknown-version');
    }
    return headerFailure('malformed');
  } catch {
    return headerFailure('malformed');
  }
}

export function serializeDaemonEventHeader(): string {
  return '{"version":1}';
}

/**
 * True only for a string at most `LANE_RUN_KEY_MAX_LENGTH` that carries no
 * secret shape and is either a lane-run key or one of the two pinned merge/ key
 * families (one-way with an optional `/r1`..`/r9`, two-way with `/a1`..`/a32`).
 */
export function isValidDaemonEventKey(value: unknown): boolean {
  try {
    if (typeof value !== 'string' || value.length > LANE_RUN_KEY_MAX_LENGTH || containsSecretShape(value)) {
      return false;
    }
    if (parseLaneRunKey(value) !== null) {
      return true;
    }
    return MERGE_KEY_ONE_WAY_PATTERN.test(value) || MERGE_KEY_TWO_WAY_PATTERN.test(value);
  } catch {
    return false;
  }
}

/** `null` for null, the validated string when valid, `undefined` when malformed. */
function parseEntryId(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || !DAEMON_ENTRY_ID_PATTERN.test(value) || containsSecretShape(value)) {
    return undefined;
  }
  return value;
}

/** `null` for null, the validated code when valid, `undefined` when malformed. */
function parseReasonCode(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || !LANE_RUN_JOURNAL_REASON_CODE_PATTERN.test(value) || containsSecretShape(value)) {
    return undefined;
  }
  return value;
}

function validateIntentKind(snapshot: Record<string, unknown>): boolean {
  return (
    parseDaemonJobId(snapshot.jobId) !== null &&
    snapshot.key !== null &&
    isValidDaemonEventKey(snapshot.key) &&
    snapshot.outcome === null &&
    snapshot.reasonCode === null
  );
}

function validateResultKind(snapshot: Record<string, unknown>): boolean {
  return (
    parseDaemonJobId(snapshot.jobId) !== null &&
    snapshot.key !== null &&
    isValidDaemonEventKey(snapshot.key) &&
    typeof snapshot.outcome === 'string' &&
    (LANE_RUN_JOURNAL_OUTCOMES as readonly string[]).includes(snapshot.outcome)
  );
}

function validateJobKind(snapshot: Record<string, unknown>): boolean {
  const outcome = snapshot.outcome;
  if (
    parseDaemonJobId(snapshot.jobId) === null ||
    snapshot.key !== null ||
    snapshot.entryId !== null ||
    typeof outcome !== 'string' ||
    !(DAEMON_JOB_OUTCOMES as readonly string[]).includes(outcome)
  ) {
    return false;
  }
  if (outcome === 'skipped' || outcome === 'refused') {
    return snapshot.reasonCode !== null;
  }
  if (outcome === 'budget-exhausted') {
    return snapshot.reasonCode === null;
  }
  return true;
}

function validateQueueKind(snapshot: Record<string, unknown>): boolean {
  const job = parseDaemonJobId(snapshot.jobId);
  if (job === null || job.kind !== 'merge-pass' || snapshot.entryId === null) {
    return false;
  }
  if (snapshot.key !== null && !isValidDaemonEventKey(snapshot.key)) {
    return false;
  }
  return (
    typeof snapshot.outcome === 'string' &&
    (DAEMON_QUEUE_EVENT_OUTCOMES as readonly string[]).includes(snapshot.outcome)
  );
}

function validateStatusKind(snapshot: Record<string, unknown>): boolean {
  const jobId = snapshot.jobId;
  if (jobId !== DAEMON_STATUS_EVENT_JOB_ID && parseDaemonJobId(jobId) === null) {
    return false;
  }
  if (snapshot.key !== null || snapshot.entryId !== null) {
    return false;
  }
  return (
    typeof snapshot.outcome === 'string' &&
    (DAEMON_STATUS_EVENT_OUTCOMES as readonly string[]).includes(snapshot.outcome)
  );
}

/** One small validator per kind, dispatched by `if` / early return. */
function validateKind(kind: DaemonEventKind, snapshot: Record<string, unknown>): boolean {
  if (kind === 'intent') {
    return validateIntentKind(snapshot);
  }
  if (kind === 'result') {
    return validateResultKind(snapshot);
  }
  if (kind === 'job') {
    return validateJobKind(snapshot);
  }
  if (kind === 'queue') {
    return validateQueueKind(snapshot);
  }
  return validateStatusKind(snapshot);
}

function parseDaemonEventFields(snapshot: Record<string, unknown>): DaemonEventRecord | null {
  const eventId = snapshot.eventId;
  if (typeof eventId !== 'string' || !REQUEST_ID_PATTERN.test(eventId)) {
    return null;
  }
  const tickId = snapshot.tickId;
  if (typeof tickId !== 'string' || !DAEMON_TICK_ID_PATTERN.test(tickId)) {
    return null;
  }
  const recordedAtIso = snapshot.recordedAtIso;
  if (!isZonedIsoDateTime(recordedAtIso)) {
    return null;
  }
  const entryId = parseEntryId(snapshot.entryId);
  const reasonCode = parseReasonCode(snapshot.reasonCode);
  if (entryId === undefined || reasonCode === undefined) {
    return null;
  }
  const kind = snapshot.kind;
  if (typeof kind !== 'string' || !(DAEMON_EVENT_KINDS as readonly string[]).includes(kind)) {
    return null;
  }
  if (!validateKind(kind as DaemonEventKind, snapshot)) {
    return null;
  }
  return Object.freeze({
    version: DAEMON_EVENT_PROJECTION_VERSION,
    eventId,
    tickId,
    jobId: snapshot.jobId as string,
    kind: kind as DaemonEventKind,
    key: snapshot.key as string | null,
    entryId,
    outcome: snapshot.outcome as string | null,
    reasonCode,
    recordedAtIso: new Date(recordedAtIso as string).toISOString(),
  });
}

/** Never throws, never echoes: the exact 10-field v1 projection record. */
export function readDaemonEventRecord(input: unknown): DaemonEventRead {
  try {
    const snapshot = readPlainSnapshot(input);
    if (snapshot === null || !hasExactKeys(snapshot, DAEMON_EVENT_KEYS)) {
      return eventFailure('malformed');
    }
    const version = snapshot.version;
    if (version !== DAEMON_EVENT_PROJECTION_VERSION) {
      if (typeof version === 'number') {
        return eventFailure('unknown-version');
      }
      return eventFailure('malformed');
    }
    const record = parseDaemonEventFields(snapshot);
    if (record === null) {
      return eventFailure('malformed');
    }
    return { ok: true, record };
  } catch {
    return eventFailure('malformed');
  }
}

/** The record when readable, `undefined` otherwise. */
export function parseDaemonEventStateRecord(raw: unknown): DaemonEventRecord | undefined {
  const read = readDaemonEventRecord(raw);
  return read.ok ? read.record : undefined;
}

/** Never throws, never echoes: one events.jsonl line, header or record. */
export function readDaemonEventLine(line: string): DaemonEventLineRead {
  if (typeof line !== 'string') {
    return { ok: false, reason: 'malformed', error: DAEMON_EVENT_LINE_NOT_JSON };
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'malformed', error: DAEMON_EVENT_LINE_NOT_JSON };
  }
  const snapshot = readPlainSnapshot(value);
  if (snapshot !== null && hasExactKeys(snapshot, ['version'])) {
    const header = readDaemonEventHeader(value);
    if (!header.ok) {
      return { ok: false, reason: header.reason, error: header.error };
    }
    return { ok: true, lineKind: 'header', header: header.header };
  }
  const record = readDaemonEventRecord(value);
  if (!record.ok) {
    return { ok: false, reason: record.reason, error: record.error };
  }
  return { ok: true, lineKind: 'event', record: record.record };
}

/** Serialize a validated line with the keys in `DAEMON_EVENT_KEYS` order, or `null` when the record is refused. */
export function serializeDaemonEventLine(record: DaemonEventRecord): string | null {
  const read = readDaemonEventRecord(record);
  if (!read.ok) {
    return null;
  }
  const normalized = read.record;
  return JSON.stringify({
    version: normalized.version,
    eventId: normalized.eventId,
    tickId: normalized.tickId,
    jobId: normalized.jobId,
    kind: normalized.kind,
    key: normalized.key,
    entryId: normalized.entryId,
    outcome: normalized.outcome,
    reasonCode: normalized.reasonCode,
    recordedAtIso: normalized.recordedAtIso,
  });
}

/** Project a journal intent or result entry; conduct and unknown kinds are refused. */
export function projectJournalEntryToDaemonEvent(params: {
  eventId: string;
  tickId: string;
  jobId: string;
  journalEntry: Pick<LaneRunJournalEntryRecord, 'kind' | 'key' | 'outcome' | 'reasonCode' | 'recordedAtIso'>;
  queueEntryId?: string | null;
}): DaemonEventRead {
  try {
    const kind = params.journalEntry.kind;
    if (kind !== 'intent' && kind !== 'result') {
      return eventFailure('malformed');
    }
    const projected = {
      version: DAEMON_EVENT_PROJECTION_VERSION,
      eventId: params.eventId,
      tickId: params.tickId,
      jobId: params.jobId,
      kind,
      key: params.journalEntry.key,
      entryId: kind === 'intent' ? (params.queueEntryId ?? null) : null,
      outcome: kind === 'result' ? params.journalEntry.outcome : null,
      reasonCode: kind === 'result' ? params.journalEntry.reasonCode : null,
      recordedAtIso: params.journalEntry.recordedAtIso,
    };
    return readDaemonEventRecord(projected);
  } catch {
    return eventFailure('malformed');
  }
}

/** Project a daemon job outcome into a `job` event line. */
export function projectJobOutcomeToDaemonEvent(params: {
  eventId: string;
  tickId: string;
  jobId: string;
  jobOutcome: DaemonJobOutcome;
  recordedAtIso: string;
}): DaemonEventRead {
  try {
    const rawReason = 'reasonCode' in params.jobOutcome ? params.jobOutcome.reasonCode : null;
    const reasonCode = typeof rawReason === 'string' ? rawReason : null;
    const projected = {
      version: DAEMON_EVENT_PROJECTION_VERSION,
      eventId: params.eventId,
      tickId: params.tickId,
      jobId: params.jobId,
      kind: 'job',
      key: null,
      entryId: null,
      outcome: params.jobOutcome.outcome,
      reasonCode,
      recordedAtIso: params.recordedAtIso,
    };
    return readDaemonEventRecord(projected);
  } catch {
    return eventFailure('malformed');
  }
}

/** A cursor slice: events after the cursor row, the next cursor id, never mutating the input. */
export function eventsAfterCursor(
  events: readonly DaemonEventRecord[],
  cursorEventId: string | null,
):
  | { readonly ok: true; readonly events: readonly DaemonEventRecord[]; readonly nextCursor: string | null }
  | { readonly ok: false; readonly reason: 'invalid-cursor' | 'cursor-not-found' } {
  if (!Array.isArray(events)) {
    return { ok: false, reason: 'cursor-not-found' };
  }
  const lastEventId = events.length > 0 ? events[events.length - 1].eventId : null;
  if (cursorEventId === null) {
    return { ok: true, events: Object.freeze([...events]), nextCursor: lastEventId };
  }
  if (typeof cursorEventId !== 'string' || !REQUEST_ID_PATTERN.test(cursorEventId)) {
    return { ok: false, reason: 'invalid-cursor' };
  }
  const index = events.findIndex((event) => event.eventId === cursorEventId);
  if (index === -1) {
    return { ok: false, reason: 'cursor-not-found' };
  }
  return {
    ok: true,
    events: Object.freeze(events.slice(index + 1)),
    nextCursor: lastEventId ?? cursorEventId,
  };
}
