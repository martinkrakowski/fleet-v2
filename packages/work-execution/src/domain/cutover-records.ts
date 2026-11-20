// Lane CO30a: the CutoverRecord v1 (plan §3.1, D-CO9) and its pure helpers.
// Pure: no filesystem, no subprocess, no clock. Never throws, never echoes an
// input value. Ids, timestamps, digests and codes only.

import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';
import { isZonedIsoDateTime } from './conductor-halt.js';
import {
  MERGE_PARK_REASONS,
  isMergeHex40,
  isMergeSafeId,
  readMergeQueueEntryRecord,
} from './merge-queue-records.js';
import type { MergeParkReason, MergeQueueRepositoryRef } from './merge-queue-records.js';
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
 * exotic object. Position fixes which side effects the probe can cause:
 *
 * - Called after a descriptor walk has proved every own property a data
 *   property with a primitive value (the pre-existing readers below), the
 *   probe reads no getter and costs a constant walk over at most the
 *   permitted keys.
 * - Called as the FIRST touch of an unknown input (the shadow-park
 *   validators), the probe refuses every Proxy — root or nested — observing
 *   no trap of any kind, before any prototype, own-key or descriptor check
 *   can run. On plain data the serializer materializes a cloneable
 *   accessor's value into the throwaway probe clone (one accessor read per
 *   accessor), but the value it answers can never reach an accepted
 *   result: any accessor is still refused from its own descriptor
 *   afterwards, whatever the accessor answers.
 *
 * A clone failure means a stand-in, never data.
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
 * The length of a real, dense, bounded array whose own keys are exactly its
 * indices and `length`, else null: a hole, an extra property, a symbol key or
 * an enormous `length` is refused without any traversal of the elements.
 *
 * The length is taken from the own `length` data descriptor, never read
 * through the array itself: a Proxy standing in for the array answers a
 * `length` read through its `get` trap — hostile code — while a
 * descriptor read fires no `get`. The returned length is proved, so the
 * caller never indexes the array (`[i]` is a `get`) either; elements are
 * taken from their own descriptors.
 */
function boundedRowArrayLength(rows: unknown): number | null {
  if (!Array.isArray(rows) || Object.getPrototypeOf(rows) !== Array.prototype) {
    return null;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(rows, 'length');
  if (
    lengthDescriptor === undefined ||
    'get' in lengthDescriptor ||
    'set' in lengthDescriptor
  ) {
    return null;
  }
  const length = lengthDescriptor.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length > RETIREMENT_LEDGER_MAX_ROWS) {
    return null;
  }
  const ownKeys = Reflect.ownKeys(rows);
  if (ownKeys.length !== length + 1) {
    return null;
  }
  for (const key of ownKeys) {
    if (key === 'length') {
      continue;
    }
    if (typeof key !== 'string' || !/^\d+$/.test(key) || Number(key) >= length) {
      return null;
    }
  }
  return length;
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
    // The row count is proved by `boundedRowArrayLength`; the array itself is
    // never indexed or probed for `length` again, so a Proxy stand-in that
    // reaches here still fires no `get` before the final cloneability refusal.
    const rowCount = boundedRowArrayLength(snapshot.rows);
    if (rowCount === null) {
      return INVALID_LEDGER;
    }
    if (rowCount === 0) {
      return { ok: false, reason: 'empty-ledger' };
    }
    if (rowCount !== CUTOVER_RETIREMENT_SCRIPTS.length) {
      return INVALID_LEDGER;
    }
    const pinned: ReadonlySet<string> = new Set<string>(CUTOVER_RETIREMENT_SCRIPTS);
    const seen = new Set<string>();
    const rows: RetirementLedgerRow[] = [];
    for (let index = 0; index < rowCount; index += 1) {
      // Own data-property descriptors only: a getter at any index is never read,
      // so it can never run, and the element is taken from the descriptor value.
      const descriptor = Object.getOwnPropertyDescriptor(snapshot.rows, index);
      if (descriptor === undefined || !('value' in descriptor) || 'get' in descriptor || 'set' in descriptor) {
        return INVALID_LEDGER;
      }
      const row = readExactPlainRecord(descriptor.value, RETIREMENT_ROW_KEYS);
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

// SW2a1: the bounded shadow-park record the cutover switch releases (plan §3.2,
// SH24a). During shadow, an ordinary park persists silently without notifying
// (`veto-hold` never persists under shadow); at `cutover switch` each ordinary
// parked entry is recorded in the cutover journal and released back to
// `queued`. Domain only: the port and adapter wiring is a sibling lane.

/** The hard entry cap of the cutover journal. */
export const MAX_CUTOVER_JOURNAL_ENTRIES = 10_000;
/**
 * Journal room every switch reserves on top of the parks it records: the
 * `switched` result plus a later `rollback` intent and its result.
 */
export const CUTOVER_SWITCH_JOURNAL_RESERVE = 4;
/** The most shadow parks one switch may record and release. */
export const MAX_SHADOW_PARKS_PER_SWITCH = 500;

/** One ordinary shadow park, frozen at its parked revision. */
export interface CutoverShadowParkRecord {
  readonly entryId: string;
  readonly repository: MergeQueueRepositoryRef;
  readonly pullRequest: number;
  readonly headOid: string;
  readonly reason: Exclude<MergeParkReason, 'veto-hold'>;
  readonly attempt: number;
  readonly notBeforeIso: string | null;
}

export type CutoverShadowParkKeyRead =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly reason: 'invalid-park-key' };

const PARK_DIGEST_PATTERN = /^[0-9a-f]{32}$/;
const INVALID_PARK_KEY = { ok: false, reason: 'invalid-park-key' } as const;

/**
 * The digest-keyed journal key of one shadow park:
 * `cutover/shadow-park-<32 hex>@<revision>` — 44 characters, so it fits
 * `CUTOVER_KEY`'s 64-char segment even when the `entryId` behind the digest is
 * up to 256 bytes per `isMergeSafeId`. The digest is 32 lowercase hex chars
 * (an `entryId` digest, not the id itself, so the id length never reaches the
 * key) and the revision a safe integer in `[1, MAX_REVISION]`. Inputs are read
 * with `typeof` checks only, so no getter and no Proxy trap ever runs.
 * Cost bound: constant — two bounded pattern/integer checks and one
 * fixed-length string build.
 */
export function cutoverShadowParkKey(entryIdDigest: unknown, revision: unknown): CutoverShadowParkKeyRead {
  if (typeof entryIdDigest !== 'string' || !PARK_DIGEST_PATTERN.test(entryIdDigest)) {
    return INVALID_PARK_KEY;
  }
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1 || revision > MAX_REVISION) {
    return INVALID_PARK_KEY;
  }
  return { ok: true, key: `cutover/shadow-park-${entryIdDigest}@${revision}` };
}

export type CutoverShadowParkPayloadRead =
  | { readonly ok: true; readonly record: CutoverShadowParkRecord; readonly canonicalPayload: string }
  | { readonly ok: false; readonly reason: 'invalid-park-entry' | 'not-shadow-park' };

const INVALID_PARK_ENTRY = { ok: false, reason: 'invalid-park-entry' } as const;
const NOT_SHADOW_PARK = { ok: false, reason: 'not-shadow-park' } as const;

/**
 * Validate one parked merge-queue entry as a shadow park and build the
 * canonical journal payload for it. The structured-clone probe is the FIRST
 * touch of the entry: the serializer refuses any Proxy exotic object — root
 * or nested — observing no trap of any kind, so no prototype, own-key or
 * descriptor check ever exercises a supplied Proxy's traps before the Proxy
 * is refused. After a successful probe (the whole reachable graph is then
 * proved Proxy-free), the plain-object shape and `readMergeQueueEntryRecord`
 * (own data-property descriptors only, so a throwing or tracked getter is
 * never invoked by the walk) check the record shape; the serializer may have
 * materialized a cloneable accessor's value once into the throwaway probe
 * clone, but the value an accessor answers can never reach an accepted
 * result — any accessor is refused from its own descriptor afterwards.
 * Arrays (sparse or dense), array-like objects with an own numeric `length`,
 * and `__proto__`/`constructor`/`prototype` own keys are refused by the same
 * checks. Only an ordinary park qualifies: the entry must be `parked` with a
 * reason other than `veto-hold` (SH24a park semantics). Cost bound: linear
 * in a constant — the entry record is a fixed shape of 25 keys (plus
 * optional `baseBranch`), every text bounded, and the probe walks only
 * proved primitive data properties plus at most one accessor read per
 * accessor.
 */
export function buildShadowParkJournalPayload(entry: unknown): CutoverShadowParkPayloadRead {
  try {
    // Probe first: a supplied Proxy is refused by the serializer observing
    // no trap, before any prototype/own-key/descriptor check can run one.
    if (!isCloneableData(entry)) {
      return INVALID_PARK_ENTRY;
    }
    if (!isPlainRecordObject(entry)) {
      return INVALID_PARK_ENTRY;
    }
    const read = readMergeQueueEntryRecord(entry);
    if (!read.ok) {
      return INVALID_PARK_ENTRY;
    }
    const current = read.record;
    if (current.state !== 'parked' || !isShadowParkReason(current.reason)) {
      // Not parked at all, parked with no reason, or a `veto-hold` (which never
      // persists under shadow, SH24a) — none of it is a shadow park.
      return NOT_SHADOW_PARK;
    }
    const reason: Exclude<MergeParkReason, 'veto-hold'> = current.reason;
    const record: CutoverShadowParkRecord = {
      entryId: current.entryId,
      repository: { owner: current.repository.owner, repo: current.repository.repo },
      pullRequest: current.pullRequest,
      headOid: current.headOid,
      reason,
      attempt: current.attempt,
      notBeforeIso: current.notBeforeIso,
    };
    return {
      ok: true,
      record,
      canonicalPayload: JSON.stringify({ ...record, revision: current.revision }),
    };
  } catch {
    return INVALID_PARK_ENTRY;
  }
}

export type CutoverShadowParkRecordRead =
  | { readonly ok: true; readonly record: CutoverShadowParkRecord }
  | { readonly ok: false; readonly reason: 'invalid-park-record' };

const SHADOW_PARK_KEYS = ['entryId', 'repository', 'pullRequest', 'headOid', 'reason', 'attempt', 'notBeforeIso'];
const SHADOW_PARK_REPOSITORY_KEYS = ['owner', 'repo'];
const SHADOW_PARK_SEGMENT_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const INVALID_PARK_RECORD = { ok: false, reason: 'invalid-park-record' } as const;

/** An owner/repo segment: bounded, no `.` or `..`, never secret-shaped. */
function isShadowParkSegment(value: unknown): value is string {
  if (typeof value !== 'string' || !SHADOW_PARK_SEGMENT_PATTERN.test(value)) {
    return false;
  }
  if (value === '.' || value === '..') {
    return false;
  }
  return !isSecretShapedText(value);
}

/**
 * The schema v3 (initial) validator for a stored or received `shadowPark`
 * record, for reuse by the journal adapter lane. The structured-clone probe
 * is the FIRST touch of `raw`: the serializer refuses any Proxy exotic
 * object — root or nested — observing no trap of any kind, before any
 * prototype, own-key or descriptor check can exercise one. After a
 * successful probe the record is read through its own data-property
 * descriptors (`readExactPlainRecord` on `['entryId', 'repository',
 * 'pullRequest', 'headOid', 'reason', 'attempt', 'notBeforeIso']` and
 * `['owner', 'repo']`), so a throwing or tracked getter is never invoked by
 * the walk (the serializer may have materialized a cloneable accessor's
 * value once into the throwaway probe clone, but the value an accessor
 * answers can never reach an accepted result — any accessor is refused from
 * its own descriptor afterwards). An array, a sparse array, an array-like
 * object with an own numeric `length`, and any
 * `__proto__`/`constructor`/`prototype` own key are refused by the exact-key
 * shape check. `entryId` must satisfy `isMergeSafeId` (up to 256 bytes,
 * secret-free), `owner` and `repo` a bounded repository segment,
 * `pullRequest` a safe positive integer, `headOid` 40 lowercase hex chars,
 * `reason` a park reason other than `veto-hold`, `attempt` a safe integer of
 * at least 0, and `notBeforeIso` `null` or a bounded zoned ISO time. No
 * field may be secret-shaped. Cost bound: linear in a constant — a fixed
 * shape of 7 keys, every text bounded by a named cap, and the probe over
 * proved primitive data properties plus at most one accessor read per
 * accessor.
 */
export function readCutoverShadowParkRecord(raw: unknown): CutoverShadowParkRecordRead {
  try {
    // Probe first: a supplied Proxy is refused by the serializer observing
    // no trap, before any prototype/own-key/descriptor check can run one.
    if (!isCloneableData(raw)) {
      return INVALID_PARK_RECORD;
    }
    const snapshot = readExactPlainRecord(raw, SHADOW_PARK_KEYS);
    if (snapshot === null) {
      return INVALID_PARK_RECORD;
    }
    const repository = readExactPlainRecord(snapshot.repository, SHADOW_PARK_REPOSITORY_KEYS);
    if (repository === null) {
      return INVALID_PARK_RECORD;
    }
    const { entryId, pullRequest, headOid, reason, attempt, notBeforeIso } = snapshot;
    const owner = repository.owner;
    const repo = repository.repo;
    if (
      !isMergeSafeId(entryId) ||
      !isShadowParkSegment(owner) ||
      !isShadowParkSegment(repo) ||
      typeof pullRequest !== 'number' ||
      !Number.isSafeInteger(pullRequest) ||
      pullRequest < 1 ||
      !isMergeHex40(headOid) ||
      !isShadowParkReason(reason) ||
      typeof attempt !== 'number' ||
      !Number.isSafeInteger(attempt) ||
      attempt < 0 ||
      !isNullableIso(notBeforeIso)
    ) {
      return INVALID_PARK_RECORD;
    }
    return {
      ok: true,
      record: {
        entryId,
        repository: { owner, repo },
        pullRequest,
        headOid,
        reason,
        attempt,
        notBeforeIso,
      },
    };
  } catch {
    return INVALID_PARK_RECORD;
  }
}

const SHADOW_PARK_REASONS = MERGE_PARK_REASONS.filter((candidate) => candidate !== 'veto-hold');

/** An ordinary park reason: any park reason but `veto-hold` (SH24a). */
function isShadowParkReason(value: unknown): value is Exclude<MergeParkReason, 'veto-hold'> {
  return typeof value === 'string' && (SHADOW_PARK_REASONS as readonly string[]).includes(value);
}

export type CutoverJournalCapacityRead =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'invalid-capacity-input' | 'too-many-shadow-parks' | 'journal-capacity-exceeded';
    };

const INVALID_CAPACITY_INPUT = { ok: false, reason: 'invalid-capacity-input' } as const;

/** A non-negative safe integer; `typeof` reads no property, so no trap runs. */
function isCapacityCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Whether one `cutover switch` may record `parkCount` shadow parks into a
 * journal that already holds `existingCount` entries. Both inputs must be
 * non-negative safe integers (`NaN`/`Infinity`, floats, non-numbers, objects
 * and Proxies are refused); the parks are capped at
 * `MAX_SHADOW_PARKS_PER_SWITCH`, and the total after the switch — existing
 * entries plus the new parks plus `CUTOVER_SWITCH_JOURNAL_RESERVE` — must stay
 * within `MAX_CUTOVER_JOURNAL_ENTRIES`. Cost bound: constant — three named
 * constant comparisons and two `typeof` checks.
 */
export function checkCutoverJournalCapacity(existingCount: unknown, parkCount: unknown): CutoverJournalCapacityRead {
  if (!isCapacityCount(existingCount) || !isCapacityCount(parkCount)) {
    return INVALID_CAPACITY_INPUT;
  }
  if (parkCount > MAX_SHADOW_PARKS_PER_SWITCH) {
    return { ok: false, reason: 'too-many-shadow-parks' };
  }
  if (existingCount + parkCount + CUTOVER_SWITCH_JOURNAL_RESERVE > MAX_CUTOVER_JOURNAL_ENTRIES) {
    return { ok: false, reason: 'journal-capacity-exceeded' };
  }
  return { ok: true };
}
