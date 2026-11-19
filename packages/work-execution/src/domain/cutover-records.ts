// Lane CO30a: the CutoverRecord v1 (plan §3.1, D-CO9) and its pure helpers.
// Pure: no filesystem, no subprocess, no clock. Never throws, never echoes an
// input value. Ids, timestamps, digests and codes only.

import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';
import { isZonedIsoDateTime } from './conductor-halt.js';
import { readExactPlainRecord, readPlainRecordWithOptionalKeys } from './plain-record-reads.js';
import {
  INITIAL_RECORD_SCHEMA_VERSION,
  isPlainRecordObject,
  readRecordSchemaVersion,
} from './record-schema-version.js';

export const CUTOVER_RECORD_SCHEMA_VERSION = INITIAL_RECORD_SCHEMA_VERSION;

export const CUTOVER_STATES = ['shadow', 'switched', 'rolled-back', 'retired'] as const;
export type CutoverState = (typeof CUTOVER_STATES)[number];

export const CUTOVER_MOVES = ['status', 'switch', 'rollback', 'retire'] as const;
export type CutoverMove = (typeof CUTOVER_MOVES)[number];

/**
 * The twelve shadow criteria the switch move demands evidence for (plan §3.2).
 * `S13` left this window for the plan §3.1 retirement gate (owner decision
 * 2026-11-18); it survives only in `LEGACY_SHADOW_CRITERIA` so ledgers that
 * recorded it still parse.
 */
export const CUTOVER_SHADOW_CRITERIA = [
  'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12',
] as const;

/** The twelve current criteria plus the retired `S13` (owner decision 2026-11-18). */
export const LEGACY_SHADOW_CRITERIA = [...CUTOVER_SHADOW_CRITERIA, 'S13'] as const;
export type CutoverShadowCriterion = (typeof LEGACY_SHADOW_CRITERIA)[number];

export const CUTOVER_SHADOW_CONSECUTIVE_DAYS = 1;
export const CUTOVER_SHADOW_MIN_MERGES = 20;
export const CUTOVER_ROLLBACK_WINDOW_DAYS = 14;
export const CUTOVER_ROLLBACK_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const MAX_REVISION = 1_000_000_000;
const MAX_STRING_BYTES = 64;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface CutoverRecord {
  readonly schemaVersion: typeof CUTOVER_RECORD_SCHEMA_VERSION;
  readonly revision: number;
  readonly state: CutoverState;
  readonly updatedAtIso: string;
  readonly switchedAtIso: string | null;
  readonly rolledBackAtIso: string | null;
  readonly retiredAtIso: string | null;
  readonly relaunchPlanDigest: string | null;
  readonly trainPauseSetByCutover: boolean;
}

export type CutoverRecordRead =
  | { readonly ok: true; readonly record: CutoverRecord }
  | { readonly ok: false; readonly reason: 'unknown-version' | 'invalid-record' };

const REQUIRED_KEYS = [
  'revision',
  'state',
  'updatedAtIso',
  'switchedAtIso',
  'rolledBackAtIso',
  'retiredAtIso',
  'relaunchPlanDigest',
  'trainPauseSetByCutover',
] as const;

const INVALID = { ok: false, reason: 'invalid-record' } as const;

function isSecretShapedText(text: string): boolean {
  return containsSecretShape(text) || LANE_DIFF_SECRET_PATTERNS.some((pattern) => pattern.regex.test(text));
}

function isSafeStringField(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    new TextEncoder().encode(value).length <= MAX_STRING_BYTES &&
    !isSecretShapedText(value)
  );
}

function isCutoverState(value: unknown): value is CutoverState {
  return typeof value === 'string' && (CUTOVER_STATES as readonly string[]).includes(value);
}

/** `null` is allowed; any string must be a zoned, calendar-valid, bounded, secret-free time. */
function isNullableIso(value: unknown): value is string | null {
  return value === null || (isSafeStringField(value) && isZonedIsoDateTime(value));
}

function isNullableDigest(value: unknown): value is string | null {
  return value === null || (isSafeStringField(value) && DIGEST_PATTERN.test(value));
}

function isNotBefore(laterIso: string, earlierIso: string): boolean {
  return Date.parse(laterIso) >= Date.parse(earlierIso);
}

function statesAreConsistent(record: Omit<CutoverRecord, 'schemaVersion'>): boolean {
  const { state, switchedAtIso, rolledBackAtIso, retiredAtIso, relaunchPlanDigest, trainPauseSetByCutover } = record;
  switch (state) {
    case 'shadow':
      return (
        switchedAtIso === null &&
        rolledBackAtIso === null &&
        retiredAtIso === null &&
        relaunchPlanDigest === null &&
        !trainPauseSetByCutover
      );
    case 'switched':
      return switchedAtIso !== null && rolledBackAtIso === null && retiredAtIso === null && relaunchPlanDigest !== null;
    case 'rolled-back':
      return (
        switchedAtIso !== null &&
        rolledBackAtIso !== null &&
        retiredAtIso === null &&
        relaunchPlanDigest !== null &&
        !trainPauseSetByCutover &&
        isNotBefore(rolledBackAtIso, switchedAtIso)
      );
    case 'retired':
      return (
        switchedAtIso !== null &&
        retiredAtIso !== null &&
        rolledBackAtIso === null &&
        relaunchPlanDigest !== null &&
        !trainPauseSetByCutover &&
        isNotBefore(retiredAtIso, switchedAtIso)
      );
  }
}

function versionFailure(raw: unknown, reason: 'unknown-schema-version' | 'malformed'): CutoverRecordRead {
  if (reason === 'unknown-schema-version') {
    // Only an enumerable data property reaches here; a positive integer is a newer schema, anything else is garbage.
    const value = (Object.getOwnPropertyDescriptor(raw, 'schemaVersion') as PropertyDescriptor | undefined)?.value as unknown;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
      return { ok: false, reason: 'unknown-version' };
    }
  }
  return INVALID;
}

/** Never throws, never runs a getter, never echoes the input. */
export function readCutoverRecord(raw: unknown): CutoverRecordRead {
  try {
    const version = readRecordSchemaVersion(raw, CUTOVER_RECORD_SCHEMA_VERSION);
    if (!version.ok) {
      return versionFailure(raw, version.reason);
    }
    const snapshot = readPlainRecordWithOptionalKeys(raw, REQUIRED_KEYS, ['schemaVersion']);
    if (snapshot === null) {
      return INVALID;
    }
    const { revision, state, updatedAtIso, switchedAtIso, rolledBackAtIso, retiredAtIso, relaunchPlanDigest } = snapshot;
    if (
      typeof revision !== 'number' ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      revision > MAX_REVISION ||
      !isCutoverState(state) ||
      !isSafeStringField(updatedAtIso) ||
      !isZonedIsoDateTime(updatedAtIso) ||
      !isNullableIso(switchedAtIso) ||
      !isNullableIso(rolledBackAtIso) ||
      !isNullableIso(retiredAtIso) ||
      !isNullableDigest(relaunchPlanDigest) ||
      typeof snapshot.trainPauseSetByCutover !== 'boolean'
    ) {
      return INVALID;
    }
    const candidate = {
      revision,
      state,
      updatedAtIso,
      switchedAtIso,
      rolledBackAtIso,
      retiredAtIso,
      relaunchPlanDigest,
      trainPauseSetByCutover: snapshot.trainPauseSetByCutover,
    };
    if (!statesAreConsistent(candidate)) {
      return INVALID;
    }
    return { ok: true, record: { schemaVersion: CUTOVER_RECORD_SCHEMA_VERSION, ...candidate } };
  } catch {
    return INVALID;
  }
}

/** `cutover/<move>@<revision>`, or null for an unknown move or a revision outside `[0, 1_000_000_000]`. */
export function cutoverJournalKey(move: Exclude<CutoverMove, 'status'>, revision: number): string | null {
  if (move !== 'switch' && move !== 'rollback' && move !== 'retire') {
    return null;
  }
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0 || revision > MAX_REVISION) {
    return null;
  }
  return `cutover/${move}@${revision}`;
}

/**
 * True strictly inside the 14-day rollback window; null when either time is not a zoned ISO time or
 * `nowIso` precedes `switchedAtIso` (an unusable clock is never a yes or a no).
 */
export function isWithinCutoverRollbackWindow(switchedAtIso: string, nowIso: string): boolean | null {
  if (!isZonedIsoDateTime(switchedAtIso) || !isZonedIsoDateTime(nowIso)) {
    return null;
  }
  const elapsed = Date.parse(nowIso) - Date.parse(switchedAtIso);
  if (elapsed < 0) {
    return null;
  }
  return elapsed < CUTOVER_ROLLBACK_WINDOW_MS;
}

/** The deterministic text the F129 rollback intent digest covers. */
export function canonicalCutoverRollbackPayload(input: {
  readonly expectedRevision: number;
  readonly operationId: string;
}): string {
  return JSON.stringify({ move: 'rollback', expectedRevision: input.expectedRevision, operationId: input.operationId });
}

/**
 * The deterministic text the F129 switch intent digest covers. `trainPausedBefore` is the last
 * key and is what the pass that appends the intent read from the train-pause store: the journal
 * intent carries no field of its own for it, so the digest is where a replay finds it again.
 * Left out, the text is the four-key payload of an intent recorded before the key existed.
 */
export function canonicalCutoverSwitchPayload(input: {
  readonly expectedRevision: number;
  readonly operationId: string;
  readonly relaunchPlanDigest: string;
  readonly trainPausedBefore?: boolean;
}): string {
  return JSON.stringify({
    move: 'switch',
    expectedRevision: input.expectedRevision,
    operationId: input.operationId,
    relaunchPlanDigest: input.relaunchPlanDigest,
    trainPausedBefore: input.trainPausedBefore,
  });
}

/** The deterministic text the F129 retire intent digest covers. */
export function canonicalCutoverRetirePayload(input: {
  readonly expectedRevision: number;
  readonly operationId: string;
}): string {
  return JSON.stringify({ move: 'retire', expectedRevision: input.expectedRevision, operationId: input.operationId });
}

export type CutoverShadowEvidenceRead =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'invalid-evidence'; readonly failed: readonly string[] };

const ALL_CRITERIA: readonly string[] = CUTOVER_SHADOW_CRITERIA;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_EVIDENCE_STRING_BYTES = 64;

function allCriteriaFailed(): CutoverShadowEvidenceRead {
  return { ok: false, reason: 'invalid-evidence', failed: [...ALL_CRITERIA] };
}

/** The criterion ids in canonical order, or every id when the shape itself was unusable. */
function criteriaFailed(failed: ReadonlySet<string>): CutoverShadowEvidenceRead {
  return { ok: false, reason: 'invalid-evidence', failed: ALL_CRITERIA.filter((id) => failed.has(id)) };
}

/** The own enumerable data-property value of `key`; a getter is never run. */
function ownDataValue(record: unknown, key: string): unknown {
  if (typeof record !== 'object' || record === null) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
    return undefined;
  }
  return descriptor.value;
}

function isBoundedText(value: unknown): value is string {
  // The UTF-16 length is checked first: a string's UTF-8 byte length is never less than it, so
  // this refuses nothing the byte check would accept, and an oversized string is never encoded.
  return (
    typeof value === 'string' &&
    value.length <= MAX_EVIDENCE_STRING_BYTES &&
    new TextEncoder().encode(value).length <= MAX_EVIDENCE_STRING_BYTES
  );
}

/** The UTC day serial of a real calendar `YYYY-MM-DD` date, or null. */
function utcDayNumber(day: string): number | null {
  if (!DAY_PATTERN.test(day)) {
    return null;
  }
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  if (month < 1 || month > 12) {
    return null;
  }
  if (date < 1 || date > new Date(Date.UTC(year, month, 0)).getUTCDate()) {
    return null;
  }
  return Math.floor(Date.UTC(year, month - 1, date) / DAY_MS);
}

/**
 * Read one shadow-evidence document without running a single getter. The root is a plain data
 * record whose only own keys are `merges` (a safe integer of at least
 * `CUTOVER_SHADOW_MIN_MERGES`) and `days`: a 1-element array carrying one UTC calendar date not
 * after the UTC date of `nowIso`, carrying the twelve criteria, every verdict the string
 * `pass`. Key counts are checked before any descriptor walk, so a document padded with
 * extra keys costs a constant number of descriptor reads. The `days` array-length and key-count
 * bounds are settled before any serializer probe, so an oversized array is refused without a
 * traversal, and no probe ever meets a getter: the only serializer probe is the final one on
 * the whole document, which runs after the walk has proved every own property a primitive data
 * value, so it reads no getter, and a Proxy stand-in for `days` (or for a day record inside it,
 * or for the document root) is refused by it without being accepted. A verdict getter is never
 * run at all: the walk reads descriptors only, so a throwing or uncloneable getter stays
 * unread and names only its own criterion. Never throws, never echoes the input. Cost bound:
 * linear in the capped input — `CUTOVER_SHADOW_CONSECUTIVE_DAYS` days with `CUTOVER_SHADOW_CRITERIA.length`
 * criteria per day, every text bounded by `MAX_EVIDENCE_STRING_BYTES`, and a constant number of
 * descriptor reads on the root (key counts are settled before any walk).
 */
export function readCutoverShadowEvidence(raw: unknown, nowIso: string): CutoverShadowEvidenceRead {
  try {
    if (!isPlainRecordObject(raw) || Reflect.ownKeys(raw).length !== 2) {
      return allCriteriaFailed();
    }
    // The recorded merge count is part of the evidence: below the minimum (or
    // absent, mistyped or out of range) the shadow evidence is insufficient,
    // whatever the day verdicts say.
    if (!isSufficientMergeCount(ownDataValue(raw, 'merges'))) {
      return allCriteriaFailed();
    }
    const days = readBoundedDaysArray(ownDataValue(raw, 'days'));
    if (days === null) {
      return allCriteriaFailed();
    }
    const nowMs = Date.parse(nowIso);
    if (Number.isNaN(nowMs)) {
      return allCriteriaFailed();
    }
    const walk = walkEvidenceDays(days);
    if (walk === null || walk.dayNumbers[0] > Math.floor(nowMs / DAY_MS)) {
      return allCriteriaFailed();
    }
    if (walk.failed.size > 0) {
      return criteriaFailed(walk.failed);
    }
    return isCloneableData(raw) ? { ok: true } : allCriteriaFailed();
  } catch {
    return allCriteriaFailed();
  }
}

function isSufficientMergeCount(merges: unknown): boolean {
  return (
    typeof merges === 'number' &&
    Number.isSafeInteger(merges) &&
    merges >= CUTOVER_SHADOW_MIN_MERGES &&
    merges <= MAX_REVISION
  );
}

const ALLOWED_DAY_KEYS: ReadonlySet<string> = new Set(['0', 'length']);

/** The `days` array when it is a real, bounded array of exactly the permitted shape, else null. */
function readBoundedDaysArray(days: unknown): readonly unknown[] | null {
  // The prototype check rejects a non-array stand-in before any length read. `Array.isArray`
  // follows a Proxy without running a trap.
  if (!Array.isArray(days) || Object.getPrototypeOf(days) !== Array.prototype) {
    return null;
  }
  // The array-length and key-count bounds run BEFORE any serializer probe.
  // A probe on an unbounded array would traverse it — a sparse array with an
  // enormous `length` costs a traversal per hole — and would run any getter
  // it meets on the way, whose DataCloneError a clone refusal cannot tell
  // apart from a Proxy stand-in. With the bounds settled first, an oversized
  // array is refused without being cloned, and the descriptor walk never runs
  // a getter: an accessor is refused from its descriptor. A Proxy stand-in is
  // refused by the final serializer probe, which reads only proved primitive
  // data properties; until then it sees a constant number of trap calls (one
  // prototype read, one key list, and one descriptor read per permitted key)
  // and never a `get`. Residual: the time spent inside a trap is not bounded.
  const dayKeys = Reflect.ownKeys(days);
  // Key-count guard first: an over-count is refused before any descriptor read.
  if (dayKeys.length !== ALLOWED_DAY_KEYS.size || dayKeys.some((key) => !ALLOWED_DAY_KEYS.has(key as string))) {
    return null;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(days, 'length');
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.get !== undefined ||
    lengthDescriptor.set !== undefined ||
    typeof lengthDescriptor.value !== 'number' ||
    lengthDescriptor.value !== CUTOVER_SHADOW_CONSECUTIVE_DAYS
  ) {
    return null;
  }
  return days;
}

/** The UTC day serial and failed criteria of the single day record, or null when any shape is unusable. */
function walkEvidenceDays(
  days: readonly unknown[],
): { readonly dayNumbers: readonly number[]; readonly failed: ReadonlySet<string> } | null {
  const failed = new Set<string>();
  const dayNumbers: number[] = [];
  for (let index = 0; index < CUTOVER_SHADOW_CONSECUTIVE_DAYS; index += 1) {
    const dayNumber = readEvidenceDay(ownDataValue(days, String(index)), failed);
    if (dayNumber === null) {
      return null;
    }
    dayNumbers.push(dayNumber);
  }
  return { dayNumbers, failed };
}

/** One day record's UTC day serial (adding its non-pass criteria to `failed`), or null when unusable. */
function readEvidenceDay(element: unknown, failed: Set<string>): number | null {
  if (!isPlainRecordObject(element) || Reflect.ownKeys(element).length !== 2) {
    return null;
  }
  const day = ownDataValue(element, 'day');
  const verdicts = ownDataValue(element, 'verdicts');
  if (!isBoundedText(day) || !isPlainRecordObject(verdicts)) {
    return null;
  }
  const dayNumber = utcDayNumber(day);
  if (dayNumber === null) {
    return null;
  }
  const verdictKeys = Reflect.ownKeys(verdicts);
  if (verdictKeys.length > ALL_CRITERIA.length || verdictKeys.some((key) => !ALL_CRITERIA.includes(key as string))) {
    return null;
  }
  for (const criterion of ALL_CRITERIA) {
    if (ownDataValue(verdicts, criterion) !== 'pass') {
      failed.add(criterion);
    }
  }
  return dayNumber;
}

/**
 * A transparent Proxy over the document answers every prototype, key and
 * descriptor read exactly as its target would, so the checks above cannot
 * tell it from data. The structured-clone serializer refuses any Proxy
 * exotic object, and at this point every own property on the document is a
 * validated data property with a primitive value, so the probe reads no
 * getter and costs a constant walk over at most the permitted keys. A
 * clone failure here means a stand-in, never data.
 */
function isCloneableData(raw: unknown): boolean {
  try {
    structuredClone(raw);
    return true;
  } catch {
    return false;
  }
}

// BL14a: the §1 retirement ledger (plan §1, `docs/planning/2026-11-03_cutover-plan.md`).
// A ledger records, for every pinned §1 script, that its replacement is verified.

export const RETIREMENT_LEDGER_SCHEMA_VERSION = INITIAL_RECORD_SCHEMA_VERSION;
export const RETIREMENT_LEDGER_MAX_ROWS = 256;
export const RETIREMENT_LEDGER_MAX_TEXT_BYTES = 256;
/** Total serialized-size cap for a persisted ledger document. */
export const RETIREMENT_LEDGER_MAX_BYTES = 65_536;

/**
 * Every §1 script in the cutover plan's Inventory tables (`### Train`, then
 * `### Lane`), in the exact order the table rows appear. `lane/mk-brief-request.py`
 * is listed twice in the plan (the table itself carries that note); the pinned
 * set names it once.
 */
export const CUTOVER_RETIREMENT_SCRIPTS = [
  'train/batch.sh',
  'train/chain-land.sh',
  'train/chain-refresh.sh',
  'train/chain-review.sh',
  'train/chain-start.sh',
  'train/common.sh',
  'train/conductor-adopt.sh',
  'train/enqueue.sh',
  'train/jev-shadow.sh',
  'train/pass.sh',
  'train/premerge.sh',
  'train/tick.sh',
  'lane/after-lane.sh',
  'lane/agy-brief.sh',
  'lane/auto-record.sh',
  'lane/brief-lint.sh',
  'lane/cf-gate-review.sh',
  'lane/conducted-perf.py',
  'lane/conductor-deploy.sh',
  'lane/conductor-locked.sh',
  'lane/deploy-train.sh',
  'lane/dispatch.sh',
  'lane/drive-runs.sh',
  'lane/fix-round-agy.sh',
  'lane/fleet-v2-gate.sh',
  'lane/gate-review.sh',
  'lane/gate-timeouts.sh',
  'lane/lane-checks.sh',
  'lane/lane-rebase.sh',
  'lane/launch.sh',
  'lane/luna-brief.sh',
  'lane/merge-main.sh',
  'lane/mk-agy-input.py',
  'lane/mk-brief-request.py',
  'lane/mkreview.py',
  'lane/pr-ready.sh',
  'lane/pr-wait.sh',
  'lane/pr.sh',
  'lane/premerge.sh',
  'lane/prep-TEMPLATE.sh',
  'lane/prep-other.sh',
  'lane/record-merged.sh',
  'lane/review-other.sh',
  'lane/review.sh',
  'lane/split-agy-brief.py',
  'lane/verify-brief-prompt.md',
  'lane/finish-lane.sh',
  'lane/fv2-lane.sh',
  'lane/grok-brief.sh',
  'lane/hx-brief.sh',
  'lane/hx-lane.sh',
  'lane/hx-review.sh',
  'lane/hx-sonar.sh',
  'lane/land-mc.sh',
  'lane/lane-pr.sh',
  'lane/luna-fleet.sh',
  'lane/luna-pass.sh',
  'lane/mc-fix.sh',
  'lane/mx-brief.sh',
  'lane/push-fix.sh',
  'lane/quality-track.py',
  'lane/start-lanes.py',
  'lane/tr-brief.sh',
  'lane/tr-chain.sh',
  'lane/tr-cont.sh',
  'lane/tr-gemini.sh',
  'lane/tr-lane.sh',
  'lane/tr-review.sh',
] as const;

export interface RetirementLedgerRow {
  readonly script: string;
  readonly verified: boolean;
  readonly evidenceLink: string;
}

export interface RetirementLedger {
  readonly schemaVersion: typeof RETIREMENT_LEDGER_SCHEMA_VERSION;
  readonly rows: readonly RetirementLedgerRow[];
}

export type RetirementLedgerRead =
  | { readonly ok: true; readonly ledger: RetirementLedger }
  | {
      readonly ok: false;
      readonly reason: 'unknown-version' | 'invalid-ledger' | 'empty-ledger' | 'row-unverified' | 'secret-shaped';
    };

const RETIREMENT_ROW_KEYS = ['script', 'verified', 'evidenceLink'] as const;
const INVALID_LEDGER = { ok: false, reason: 'invalid-ledger' } as const;

/** `isBoundedText` for the ledger's text fields: UTF-16 pre-check, then the UTF-8 byte bound. */
function isBoundedLedgerText(value: unknown): value is string {
  // The UTF-16 length is checked first: a string's UTF-8 byte length is never less than it, so
  // this refuses nothing the byte check would accept, and an oversized string is never encoded.
  return (
    typeof value === 'string' &&
    value.length <= RETIREMENT_LEDGER_MAX_TEXT_BYTES &&
    new TextEncoder().encode(value).length <= RETIREMENT_LEDGER_MAX_TEXT_BYTES
  );
}

/**
 * A real, dense, bounded array whose own keys are exactly its indices and
 * `length`: a hole, an extra property, a symbol key or an enormous `length`
 * is refused without any traversal of the elements.
 */
function isBoundedRowArray(rows: unknown): rows is readonly unknown[] {
  if (!Array.isArray(rows) || Object.getPrototypeOf(rows) !== Array.prototype) {
    return false;
  }
  if (rows.length > RETIREMENT_LEDGER_MAX_ROWS) {
    return false;
  }
  const ownKeys = Reflect.ownKeys(rows);
  if (ownKeys.length !== rows.length + 1) {
    return false;
  }
  for (const key of ownKeys) {
    if (key === 'length') {
      continue;
    }
    if (typeof key !== 'string' || !/^\d+$/.test(key) || Number(key) >= rows.length) {
      return false;
    }
  }
  return true;
}

/**
 * Read the §1 retirement ledger without running a single getter and never
 * echoing the input. The root is a plain data record with exactly `rows` (plus
 * the optional `schemaVersion`); each row is a plain data record with exactly
 * `script`, `verified` and `evidenceLink`. The pinned script set must match
 * exactly: `CUTOVER_RETIREMENT_SCRIPTS.length` unique rows, every `script` a
 * pinned script, none missing, none extra. Cost bound: linear in the capped
 * input — at most `RETIREMENT_LEDGER_MAX_ROWS` rows of 3 fixed keys each,
 * every text bounded by `RETIREMENT_LEDGER_MAX_TEXT_BYTES`, and the shape
 * bounds (array length, key counts) settled before any row is walked, so an
 * oversized or sparse array is refused without a traversal. Never throws,
 * never runs a getter, and always returns a freshly built `RetirementLedger`
 * object, never the input itself.
 */
export function readRetirementLedger(raw: unknown): RetirementLedgerRead {
  try {
    const version = readRecordSchemaVersion(raw, RETIREMENT_LEDGER_SCHEMA_VERSION);
    if (!version.ok) {
      // Only an enumerable data property reaches here; a positive integer is a newer schema, anything else is garbage.
      const value = (Object.getOwnPropertyDescriptor(raw, 'schemaVersion') as PropertyDescriptor | undefined)?.value as unknown;
      if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
        return { ok: false, reason: 'unknown-version' };
      }
      return INVALID_LEDGER;
    }
    const snapshot = readPlainRecordWithOptionalKeys(raw, ['rows'], ['schemaVersion']);
    if (snapshot === null) {
      return INVALID_LEDGER;
    }
    if (!isBoundedRowArray(snapshot.rows)) {
      return INVALID_LEDGER;
    }
    if (snapshot.rows.length === 0) {
      return { ok: false, reason: 'empty-ledger' };
    }
    if (snapshot.rows.length !== CUTOVER_RETIREMENT_SCRIPTS.length) {
      return INVALID_LEDGER;
    }
    const pinned: ReadonlySet<string> = new Set<string>(CUTOVER_RETIREMENT_SCRIPTS);
    const seen = new Set<string>();
    const rows: RetirementLedgerRow[] = [];
    for (const rowValue of snapshot.rows) {
      const row = readExactPlainRecord(rowValue, RETIREMENT_ROW_KEYS);
      if (row === null) {
        return INVALID_LEDGER;
      }
      const { script, verified, evidenceLink } = row;
      if (!isBoundedLedgerText(script) || !isBoundedLedgerText(evidenceLink) || typeof verified !== 'boolean') {
        return INVALID_LEDGER;
      }
      if (isSecretShapedText(script) || isSecretShapedText(evidenceLink)) {
        return { ok: false, reason: 'secret-shaped' };
      }
      if (!pinned.has(script) || seen.has(script)) {
        return INVALID_LEDGER;
      }
      seen.add(script);
      if (verified !== true || evidenceLink.trim() === '') {
        return { ok: false, reason: 'row-unverified' };
      }
      rows.push({ script, verified, evidenceLink });
    }
    if (seen.size !== CUTOVER_RETIREMENT_SCRIPTS.length) {
      // A duplicate was impossible (checked above), so this is a missing pinned script.
      return INVALID_LEDGER;
    }
    if (!isCloneableData(raw)) {
      // A transparent Proxy over valid data passes every descriptor check above; the
      // structured-clone serializer refuses any Proxy exotic object. Every own property
      // is by now a proved primitive data value, so the probe reads no getter.
      return INVALID_LEDGER;
    }
    return { ok: true, ledger: { schemaVersion: RETIREMENT_LEDGER_SCHEMA_VERSION, rows } };
  } catch {
    return INVALID_LEDGER;
  }
}
