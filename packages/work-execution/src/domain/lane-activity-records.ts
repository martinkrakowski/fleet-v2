/**
 * The pure, serializable records of lane activity (work-board plan §3.5, §3.6):
 * a lane's step declarations ("declared, not observed"; a declaration never
 * clears any guard) and its brief reads (the guard is clear while the latest
 * read is present). Ids, enums, bounded plain text and canonical times only,
 * never a credential or client content. Lapse is judged by the board
 * (`isDeclarationLapsed`); a record carries the deadline, nothing more.
 */

import type { LaneRef } from './work-board-facts.js';
import { BOARD_DECLARATION_STEPS, type BoardDeclarationStep } from './work-board-facts.js';
import {
  CANONICAL_ISO_PATTERN,
  PLAN_ID_PATTERN,
  PLAN_PROJECT_ID_PATTERN,
  PLANNED_LANE_ID_PATTERN,
  SHA256_HEX_PATTERN,
} from './lane-plan-records.js';

export const LANE_DECLARATION_RECORD_VERSION = 1 as const;
export const LANE_BRIEF_READ_RECORD_VERSION = 1 as const;

/** seatRole and model are single-line plain text, 1–120 code points. */
export const LANE_DECLARATION_TEXT_LIMIT = 120;
/** The brief path cap, the same `pathBytes` bound lane-plan-records uses. */
export const BRIEF_READ_PATH_LIMIT = 256;

/** One `plan declare` record. The store keeps every declaration; the board applies lapse. */
export interface LaneDeclarationRecord {
  readonly version: typeof LANE_DECLARATION_RECORD_VERSION;
  readonly lane: LaneRef;
  readonly step: BoardDeclarationStep;
  readonly seatRole: string;
  readonly model: string;
  readonly declaredAtIso: string;
  readonly lapsesAtIso: string;
}

/** One `plan brief-check` record; mirrors `BoardBriefReadFact`. */
export interface BriefReadRecord {
  readonly version: typeof LANE_BRIEF_READ_RECORD_VERSION;
  readonly lane: LaneRef;
  readonly path: string;
  readonly outcome: 'read' | 'failed';
  readonly sha256: string | null;
  readonly bytes: number | null;
  readonly readAtIso: string;
}

export type LaneDeclarationParseResult =
  | { readonly ok: true; readonly record: LaneDeclarationRecord }
  | { readonly ok: false; readonly error: string };

export type BriefReadParseResult =
  | { readonly ok: true; readonly record: BriefReadRecord }
  | { readonly ok: false; readonly error: string };

const DECLARATION_KEYS = ['lane', 'step', 'seatRole', 'model'] as const;
const BRIEF_READ_KEYS = ['lane', 'path', 'outcome', 'sha256', 'bytes'] as const;

/** No control character, no line break: single-line plain text or refused. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!isRecordObject(value)) {
    return false;
  }
  return hasExactlyKeysOf(value, keys);
}

function hasExactlyKeysOf(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isBoundedPlain(value: unknown, limit: number): value is string {
  if (typeof value !== 'string' || CONTROL_CHARACTER_PATTERN.test(value)) {
    return false;
  }
  const codePoints = [...value].length;
  return codePoints >= 1 && codePoints <= limit;
}

function isCanonicalIso(value: unknown): value is string {
  if (typeof value !== 'string' || !CANONICAL_ISO_PATTERN.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  // Date.parse rolls some impossible calendar dates (for example, an
  // out-of-range day) over into a later instant instead of refusing them,
  // so only a timestamp that round-trips exactly is canonical.
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

const LAN_REF_PLAN_KEYS = ['kind', 'projectId', 'planId', 'laneId'] as const;
const LAN_REF_WORK_ORDER_KEYS = ['kind', 'projectId', 'workOrderId'] as const;

function isLaneRef(value: unknown): value is LaneRef {
  if (!isRecordObject(value)) {
    return false;
  }
  if (hasExactlyKeysOf(value, LAN_REF_PLAN_KEYS)) {
    return (
      value.kind === 'plan' &&
      typeof value.projectId === 'string' && PLAN_PROJECT_ID_PATTERN.test(value.projectId) &&
      typeof value.planId === 'string' && PLAN_ID_PATTERN.test(value.planId) &&
      typeof value.laneId === 'string' && PLANNED_LANE_ID_PATTERN.test(value.laneId)
    );
  }
  if (hasExactlyKeysOf(value, LAN_REF_WORK_ORDER_KEYS)) {
    return (
      value.kind === 'work-order' &&
      typeof value.projectId === 'string' && PLAN_PROJECT_ID_PATTERN.test(value.projectId) &&
      typeof value.workOrderId === 'string' && value.workOrderId.length > 0 &&
      isBoundedPlain(value.workOrderId, BRIEF_READ_PATH_LIMIT)
    );
  }
  return false;
}

/** A fresh lane reference holding exactly the validated fields, never the body's own object. */
function laneRefOf(record: Record<string, unknown>): LaneRef {
  if (record.kind === 'plan') {
    return {
      kind: 'plan',
      projectId: record.projectId as string,
      planId: record.planId as string,
      laneId: record.laneId as string,
    };
  }
  return {
    kind: 'work-order',
    projectId: record.projectId as string,
    workOrderId: record.workOrderId as string,
  };
}

function isDeclarationStep(value: unknown): value is BoardDeclarationStep {
  return (BOARD_DECLARATION_STEPS as readonly string[]).includes(value as string);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isTtlMinutes(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

/** The maximum date value `toISOString` accepts (±100 million days in ms). */
const MAX_DATE_MS = 8.64e15;

function isoAfter(iso: string, milliseconds: number): string | null {
  const base = Date.parse(iso);
  const target = base + milliseconds;
  if (!Number.isFinite(base) || !Number.isFinite(target) || Math.abs(target) > MAX_DATE_MS) {
    return null;
  }
  return new Date(target).toISOString();
}

/**
 * Validate one declaration body against the fresh clock read. The declared
 * and lapse times are always clock values, never body fields; every refusal
 * is a fixed string that names the field only.
 */
export function parseLaneDeclarationBody(
  body: unknown,
  nowIso: string,
  ttlMinutes: number,
): LaneDeclarationParseResult {
  if (!isCanonicalIso(nowIso)) {
    return { ok: false, error: 'invalid nowIso' };
  }
  if (!isTtlMinutes(ttlMinutes)) {
    return { ok: false, error: 'invalid ttlMinutes' };
  }
  if (!hasExactlyKeys(body, DECLARATION_KEYS)) {
    return { ok: false, error: 'body must have exactly the keys lane, step, seatRole and model' };
  }
  const record = body as Record<string, unknown>;
  if (!isLaneRef(record.lane)) {
    return { ok: false, error: 'invalid lane' };
  }
  if (!isDeclarationStep(record.step)) {
    return { ok: false, error: 'invalid step' };
  }
  if (!isBoundedPlain(record.seatRole, LANE_DECLARATION_TEXT_LIMIT)) {
    return { ok: false, error: 'invalid seatRole' };
  }
  if (!isBoundedPlain(record.model, LANE_DECLARATION_TEXT_LIMIT)) {
    return { ok: false, error: 'invalid model' };
  }
  const lapsesAtIso = isoAfter(nowIso, ttlMinutes * 60_000);
  if (lapsesAtIso === null) {
    return { ok: false, error: 'invalid ttlMinutes' };
  }
  return {
    ok: true,
    record: {
      version: LANE_DECLARATION_RECORD_VERSION,
      lane: laneRefOf(record.lane as Record<string, unknown>),
      step: record.step,
      seatRole: record.seatRole,
      model: record.model,
      declaredAtIso: nowIso,
      lapsesAtIso,
    },
  };
}

/**
 * Validate one brief-read body against the fresh clock read. A `read` needs a
 * sha256 hex digest and a byte count; a `failed` read stores null for both
 * whatever the body carried, and echoes nothing.
 */
export function parseBriefReadBody(body: unknown, nowIso: string): BriefReadParseResult {
  if (!isCanonicalIso(nowIso)) {
    return { ok: false, error: 'invalid nowIso' };
  }
  if (!hasExactlyKeys(body, BRIEF_READ_KEYS)) {
    return { ok: false, error: 'body must have exactly the keys lane, path, outcome, sha256 and bytes' };
  }
  const record = body as Record<string, unknown>;
  if (!isLaneRef(record.lane)) {
    return { ok: false, error: 'invalid lane' };
  }
  if (!isBoundedPlain(record.path, BRIEF_READ_PATH_LIMIT)) {
    return { ok: false, error: 'invalid path' };
  }
  if (record.outcome !== 'read' && record.outcome !== 'failed') {
    return { ok: false, error: 'invalid outcome' };
  }
  if (record.outcome === 'read') {
    if (typeof record.sha256 !== 'string' || !SHA256_HEX_PATTERN.test(record.sha256)) {
      return { ok: false, error: 'invalid sha256' };
    }
    if (!isNonNegativeInteger(record.bytes)) {
      return { ok: false, error: 'invalid bytes' };
    }
    return {
      ok: true,
      record: {
        version: LANE_BRIEF_READ_RECORD_VERSION,
        lane: laneRefOf(record.lane as Record<string, unknown>),
        path: record.path,
        outcome: 'read',
        sha256: record.sha256,
        bytes: record.bytes,
        readAtIso: nowIso,
      },
    };
  }
  return {
    ok: true,
    record: {
      version: LANE_BRIEF_READ_RECORD_VERSION,
      lane: laneRefOf(record.lane as Record<string, unknown>),
      path: record.path,
      outcome: 'failed',
      sha256: null,
      bytes: null,
      readAtIso: nowIso,
    },
  };
}

/** The structural check the declaration store's reader applies to each record. */
export function isLaneDeclarationRecord(value: unknown): value is LaneDeclarationRecord {
  if (!isRecordObject(value) || value.version !== LANE_DECLARATION_RECORD_VERSION) {
    return false;
  }
  return (
    isLaneRef(value.lane) &&
    isDeclarationStep(value.step) &&
    isBoundedPlain(value.seatRole, LANE_DECLARATION_TEXT_LIMIT) &&
    isBoundedPlain(value.model, LANE_DECLARATION_TEXT_LIMIT) &&
    isCanonicalIso(value.declaredAtIso) &&
    isCanonicalIso(value.lapsesAtIso)
  );
}

/** The structural check the brief-read store's reader applies to each record. */
export function isBriefReadRecord(value: unknown): value is BriefReadRecord {
  if (!isRecordObject(value) || value.version !== LANE_BRIEF_READ_RECORD_VERSION) {
    return false;
  }
  if (!isLaneRef(value.lane) || !isBoundedPlain(value.path, BRIEF_READ_PATH_LIMIT)) {
    return false;
  }
  if (value.outcome !== 'read' && value.outcome !== 'failed') {
    return false;
  }
  if (value.outcome === 'read') {
    // A `read` carries both the digest and the byte count, always.
    if (typeof value.sha256 !== 'string' || !SHA256_HEX_PATTERN.test(value.sha256)) {
      return false;
    }
    return isNonNegativeInteger(value.bytes) && isCanonicalIso(value.readAtIso);
  }
  // A `failed` read carries neither, forced null at parse time.
  return value.sha256 === null && value.bytes === null && isCanonicalIso(value.readAtIso);
}
