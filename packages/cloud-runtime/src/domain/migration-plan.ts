/**
 * A pure, forward-only migration decision function and a pure deterministic
 * checksum helper. No `node:*` import, no clock read, no I/O, no database
 * driver, no network, no console: every untrusted value is read through
 * `snapshotPlainData` (bounded by this unit's own limits, with a required,
 * caller-supplied `isProxy` detector) and every entry through `readPlainRecord`,
 * so a hostile shape is always a typed refusal, never a pass or a throw.
 *
 * Cost bounds: `checksumOfMigration` is `O(|sql|)` with `|sql| <= MAX_SQL_LENGTH`;
 * `decideMigrationRun` is `O(n log n)` for `n <= MAX_MIGRATIONS` entries
 * (bounded snapshot + one schema check per entry + `O(1)` timestamp check per
 * applied entry + map lookups + one sort).
 */

import {
  readPlainRecord,
  snapshotPlainData,
  type IsProxy,
  type PlainRecordSchema,
} from '@fleet/shared';

/** A migration already recorded as applied in the target's history. */
export type AppliedMigration = {
  readonly id: string;
  readonly checksum: string;
  readonly appliedAtIso: string;
};

/** A migration available to run, with the SQL text that defines it. */
export type AvailableMigration = {
  readonly id: string;
  readonly checksum: string;
  readonly sql: string;
};

export type MigrationPlanResult =
  | { readonly ok: true; readonly toRun: readonly AvailableMigration[] }
  | { readonly ok: false; readonly reason: 'invalid-input'; readonly field: 'applied' | 'available' | 'isProxy' }
  | {
      readonly ok: false;
      readonly reason: 'duplicate-id' | 'unknown-applied' | 'checksum-mismatch' | 'gap';
      readonly id: string;
    };

export type ChecksumResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: 'invalid-input'; readonly field: 'sql' | 'digest' }
  | { readonly ok: false; readonly reason: 'digest-failed'; readonly field: 'digest' };

/** `YYYY_` prefix, then 1–64 lowercase alphanumeric/underscore segments. */
export const MIGRATION_ID_PATTERN = /^\d{4}_[a-z0-9_]{1,64}$/;

/** At most this many entries in `applied` or `available`. */
export const MAX_MIGRATIONS = 10_000;

/** At most this many characters of SQL per migration. */
export const MAX_SQL_LENGTH = 200_000;

/** Bound for one `id` (`^\d{4}` + `_` + up to 64 more characters). */
const MAX_ID_LENGTH = 69;

/**
 * Bound for one `checksum`: the same bound as every other string this unit
 * reads (`MAX_SQL_LENGTH`), so any non-empty digest `checksumOfMigration`
 * accepts is also accepted by `decideMigrationRun`.
 */
const MAX_CHECKSUM_LENGTH = MAX_SQL_LENGTH;

/** Prototype-polluting own keys are refused on every entry. */
const POLLUTING_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const APPLIED_SCHEMA: PlainRecordSchema = Object.freeze({
  id: { kind: 'string', maxLength: MAX_ID_LENGTH },
  checksum: { kind: 'string', maxLength: MAX_CHECKSUM_LENGTH },
  appliedAtIso: { kind: 'string', maxLength: 64 },
});

const AVAILABLE_SCHEMA: PlainRecordSchema = Object.freeze({
  id: { kind: 'string', maxLength: MAX_ID_LENGTH },
  checksum: { kind: 'string', maxLength: MAX_CHECKSUM_LENGTH },
  sql: { kind: 'string', maxLength: MAX_SQL_LENGTH },
});

const ISO_TIMESTAMP_PATTERN
  = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;

/** Whether the calendar date is real; `setUTCFullYear` keeps years 0000-0099. `O(1)`. */
function isRealCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
  );
}

/**
 * Whether `value` is a strict ISO-8601 timestamp with a real calendar date,
 * a real time and a real offset. No clock is read; the check is `O(1)` and
 * deterministic.
 */
function isValidIsoTimestamp(value: string): boolean {
  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  // An offset such as `+99:99` is not valid; `Z` leaves both groups unset.
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  if (hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    return false;
  }
  return isRealCalendarDate(year, month, day);
}

export function checksumOfMigration(sql: unknown, digest: (text: string) => string): ChecksumResult {
  if (typeof sql !== 'string' || sql.length > MAX_SQL_LENGTH) {
    return { ok: false, reason: 'invalid-input', field: 'sql' };
  }
  if (typeof digest !== 'function') {
    return { ok: false, reason: 'invalid-input', field: 'digest' };
  }
  let value: string;
  try {
    value = digest(sql);
  } catch {
    return { ok: false, reason: 'digest-failed', field: 'digest' };
  }
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, reason: 'digest-failed', field: 'digest' };
  }
  return { ok: true, value };
}

/**
 * Whether the entry's own keys are exactly the schema's keys: any extra own
 * key (including a symbol or a prototype-polluting key such as `'__proto__'`,
 * `'constructor'` or `'prototype'`) is refused. `Reflect.ownKeys` is `O(k)`
 * with `k` bounded by the snapshot's `maxKeys` (3).
 */
function onlySchemaKeys(entry: Readonly<Record<string, unknown>>, schemaKeys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(entry);
  if (ownKeys.length !== schemaKeys.length) {
    return false;
  }
  return ownKeys.every((key) => typeof key === 'string' && !POLLUTING_KEYS.has(key) && schemaKeys.includes(key));
}

type SnapshotLimits = Parameters<typeof snapshotPlainData>[2];

type MigrationField = 'applied' | 'available';

type SnapshotOutcome =
  | { readonly ok: true; readonly entries: readonly unknown[] }
  | { readonly ok: false; readonly field: MigrationField | 'isProxy' };

/** Snapshot one input and require an array; a detector failure names `isProxy`. `O(n)`, `n <= MAX_MIGRATIONS`. */
function snapshotEntries(
  input: unknown,
  field: MigrationField,
  isProxy: IsProxy,
  limits: SnapshotLimits,
): SnapshotOutcome {
  const snapshot = snapshotPlainData(input, isProxy, limits);
  if (!snapshot.ok) {
    const detectorFailed = snapshot.reason === 'detector-threw' || snapshot.reason === 'invalid-limits';
    return { ok: false, field: detectorFailed ? 'isProxy' : field };
  }
  if (!Array.isArray(snapshot.value)) {
    return { ok: false, field };
  }
  return { ok: true, entries: snapshot.value };
}

type EntryRefusal =
  | { readonly reason: 'invalid-input'; readonly field: MigrationField }
  | { readonly reason: 'duplicate-id'; readonly id: string };

/**
 * Validate every entry against `schema` and its extra field check, and map
 * each id to its checksum. `O(n)` over at most MAX_MIGRATIONS entries; every
 * per-entry check is `O(1)` in the entry itself.
 */
function readEntries(
  entries: readonly unknown[],
  field: MigrationField,
  schema: PlainRecordSchema,
  extraKey: 'appliedAtIso' | 'sql',
): { readonly ok: true; readonly byId: Map<string, string> } | { readonly ok: false; readonly refusal: EntryRefusal } {
  const invalid: EntryRefusal = { reason: 'invalid-input', field };
  const byId = new Map<string, string>();
  for (const entry of entries) {
    const read = readPlainRecord(entry, schema);
    if (!read.ok || !onlySchemaKeys(read.value, ['id', 'checksum', extraKey])) {
      return { ok: false, refusal: invalid };
    }
    const { id, checksum } = read.value;
    const extra = read.value[extraKey];
    const extraValid = extraKey === 'appliedAtIso'
      ? typeof extra === 'string' && isValidIsoTimestamp(extra)
      : typeof extra === 'string' && extra.length <= MAX_SQL_LENGTH;
    if (
      typeof id !== 'string' || !MIGRATION_ID_PATTERN.test(id)
      || typeof checksum !== 'string' || checksum.length === 0
      || !extraValid
    ) {
      return { ok: false, refusal: invalid };
    }
    if (byId.has(id)) {
      return { ok: false, refusal: { reason: 'duplicate-id', id } };
    }
    byId.set(id, checksum);
  }
  return { ok: true, byId };
}

/** Every applied id must be known to `available` with the same checksum. `O(n)` map lookups. */
function checkHistory(
  appliedById: ReadonlyMap<string, string>,
  availableById: ReadonlyMap<string, string>,
): MigrationPlanResult | null {
  for (const [id, checksum] of appliedById) {
    const availableChecksum = availableById.get(id);
    if (availableChecksum === undefined) {
      return { ok: false, reason: 'unknown-applied', id };
    }
    if (availableChecksum !== checksum) {
      return { ok: false, reason: 'checksum-mismatch', id };
    }
  }
  return null;
}

/** ASCII order on the zero-padded ids. */
function compareIds(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * Gap check against ALL applied ids: the largest applied id bounds the past.
 * An unapplied migration sorting before ANY applied id would retro-insert
 * history and is refused. One `O(n)` maximum, then `O(1)` per candidate.
 */
function planUnapplied(
  sorted: readonly AvailableMigration[],
  appliedById: ReadonlyMap<string, string>,
): MigrationPlanResult {
  let maxAppliedId: string | null = null;
  for (const id of appliedById.keys()) {
    if (maxAppliedId === null || id > maxAppliedId) {
      maxAppliedId = id;
    }
  }
  const toRun: AvailableMigration[] = [];
  for (const entry of sorted) {
    if (appliedById.has(entry.id)) {
      continue;
    }
    if (maxAppliedId !== null && entry.id < maxAppliedId) {
      return { ok: false, reason: 'gap', id: entry.id };
    }
    toRun.push(entry);
  }
  return { ok: true, toRun };
}

/**
 * Decide which of `available` still need to run, given `applied`. Forward-only:
 * history is never re-ordered, skipped or edited, and any unapplied migration
 * sorting before ANY applied id is a `gap` refusal.
 */
export function decideMigrationRun(
  applied: unknown,
  available: unknown,
  isProxy: IsProxy,
): MigrationPlanResult {
  // The detector is a required positional parameter with no default: there is
  // no fallback detector, so a missing or non-function detector is refused
  // before any reflection operation runs. `O(1)`.
  if (typeof isProxy !== 'function') {
    return { ok: false, reason: 'invalid-input', field: 'isProxy' };
  }

  const limits = Object.freeze({
    maxArrayLength: MAX_MIGRATIONS,
    maxStringLength: MAX_SQL_LENGTH,
    maxKeys: 3,
    maxDepth: 4,
    maxNodes: MAX_MIGRATIONS * 4 + 1,
  });

  const appliedSnapshot = snapshotEntries(applied, 'applied', isProxy, limits);
  if (!appliedSnapshot.ok) {
    return { ok: false, reason: 'invalid-input', field: appliedSnapshot.field };
  }
  const availableSnapshot = snapshotEntries(available, 'available', isProxy, limits);
  if (!availableSnapshot.ok) {
    return { ok: false, reason: 'invalid-input', field: availableSnapshot.field };
  }

  const appliedRead = readEntries(appliedSnapshot.entries, 'applied', APPLIED_SCHEMA, 'appliedAtIso');
  if (!appliedRead.ok) {
    return { ok: false, ...appliedRead.refusal };
  }
  const availableRead = readEntries(availableSnapshot.entries, 'available', AVAILABLE_SCHEMA, 'sql');
  if (!availableRead.ok) {
    return { ok: false, ...availableRead.refusal };
  }

  const historyRefusal = checkHistory(appliedRead.byId, availableRead.byId);
  if (historyRefusal !== null) {
    return historyRefusal;
  }

  // Entries were validated above, so the cast only restores their type.
  // `O(n log n)`.
  const sorted = (availableSnapshot.entries as readonly AvailableMigration[])
    .map(({ id, checksum, sql }): AvailableMigration => ({ id, checksum, sql }))
    .sort((a, b) => compareIds(a.id, b.id));
  return planUnapplied(sorted, appliedRead.byId);
}
