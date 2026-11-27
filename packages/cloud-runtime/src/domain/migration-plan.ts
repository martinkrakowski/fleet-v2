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
export const MIGRATION_ID_PATTERN = /^[0-9]{4}_[a-z0-9_]{1,64}$/;

/** At most this many entries in `applied` or `available`. */
export const MAX_MIGRATIONS = 10_000;

/** At most this many characters of SQL per migration. */
export const MAX_SQL_LENGTH = 200_000;

/** Bound for one `id` (`^[0-9]{4}` + `_` + up to 64 more characters). */
const MAX_ID_LENGTH = 69;

/** Bound for one `checksum` (covers hex digests such as SHA-256). */
const MAX_CHECKSUM_LENGTH = 128;

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
  = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Whether `value` is a strict ISO-8601 timestamp with a real calendar date
 * and time. `Date.UTC` is a pure arithmetic helper here: no clock is read,
 * the check is `O(1)` and deterministic.
 */
function isValidIsoTimestamp(value: string): boolean {
  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  if (hour > 23 || minute > 59 || second > 59 || month < 1 || month > 12 || day < 1) {
    return false;
  }
  const utc = Date.UTC(year, month - 1, day);
  const date = new Date(utc);
  return (
    date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
  );
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

  const appliedSnapshot = snapshotPlainData(applied, isProxy, limits);
  if (!appliedSnapshot.ok) {
    if (appliedSnapshot.reason === 'detector-threw' || appliedSnapshot.reason === 'invalid-limits') {
      return { ok: false, reason: 'invalid-input', field: 'isProxy' };
    }
    return { ok: false, reason: 'invalid-input', field: 'applied' };
  }
  const availableSnapshot = snapshotPlainData(available, isProxy, limits);
  if (!availableSnapshot.ok) {
    if (availableSnapshot.reason === 'detector-threw' || availableSnapshot.reason === 'invalid-limits') {
      return { ok: false, reason: 'invalid-input', field: 'isProxy' };
    }
    return { ok: false, reason: 'invalid-input', field: 'available' };
  }

  const appliedValue = appliedSnapshot.value;
  const availableValue = availableSnapshot.value;
  if (!Array.isArray(appliedValue)) {
    return { ok: false, reason: 'invalid-input', field: 'applied' };
  }
  if (!Array.isArray(availableValue)) {
    return { ok: false, reason: 'invalid-input', field: 'available' };
  }

  // Reading and validating each entry is `O(n)` over at most MAX_MIGRATIONS
  // entries; every per-entry check below is `O(1)` in the entry itself.
  const appliedById = new Map<string, string>();
  for (const entry of appliedValue) {
    const field = 'applied' as const;
    const read = readPlainRecord(entry, APPLIED_SCHEMA);
    if (!read.ok) {
      return { ok: false, reason: 'invalid-input', field };
    }
    if (!onlySchemaKeys(read.value, ['id', 'checksum', 'appliedAtIso'])) {
      return { ok: false, reason: 'invalid-input', field };
    }
    const id = read.value['id'];
    const checksum = read.value['checksum'];
    if (typeof id !== 'string' || !MIGRATION_ID_PATTERN.test(id)) {
      return { ok: false, reason: 'invalid-input', field };
    }
    if (typeof checksum !== 'string' || checksum.length === 0) {
      return { ok: false, reason: 'invalid-input', field };
    }
    const appliedAtIso = read.value['appliedAtIso'];
    if (typeof appliedAtIso !== 'string' || !isValidIsoTimestamp(appliedAtIso)) {
      return { ok: false, reason: 'invalid-input', field };
    }
    if (appliedById.has(id)) {
      return { ok: false, reason: 'duplicate-id', id };
    }
    appliedById.set(id, checksum);
  }

  const availableById = new Map<string, string>();
  for (const entry of availableValue) {
    const field = 'available' as const;
    const read = readPlainRecord(entry, AVAILABLE_SCHEMA);
    if (!read.ok) {
      return { ok: false, reason: 'invalid-input', field };
    }
    if (!onlySchemaKeys(read.value, ['id', 'checksum', 'sql'])) {
      return { ok: false, reason: 'invalid-input', field };
    }
    const id = read.value['id'];
    const checksum = read.value['checksum'];
    if (typeof id !== 'string' || !MIGRATION_ID_PATTERN.test(id)) {
      return { ok: false, reason: 'invalid-input', field };
    }
    if (typeof checksum !== 'string' || checksum.length === 0) {
      return { ok: false, reason: 'invalid-input', field };
    }
    const sql = read.value['sql'];
    if (typeof sql !== 'string' || sql.length > MAX_SQL_LENGTH) {
      return { ok: false, reason: 'invalid-input', field };
    }
    if (availableById.has(id)) {
      return { ok: false, reason: 'duplicate-id', id };
    }
    availableById.set(id, checksum);
  }

  // Consistency of history: every applied id must be known to `available`
  // with the same checksum. `O(n)` map lookups, `O(1)` per lookup.
  for (const [id, checksum] of appliedById) {
    const availableChecksum = availableById.get(id);
    if (availableChecksum === undefined) {
      return { ok: false, reason: 'unknown-applied', id };
    }
    if (availableChecksum !== checksum) {
      return { ok: false, reason: 'checksum-mismatch', id };
    }
  }

  // Sort `available` by id. The pattern fixes the shape (`^[0-9]{4}_…`), so
  // plain lexicographic order on the zero-padded prefix is the intended
  // ASCII order. `O(n log n)`.
  const sortedAvailable = availableValue
    .map((entry) => entry as Readonly<Record<string, unknown>>)
    .sort((a, b) => {
      const aId = a['id'];
      const bId = b['id'];
      return typeof aId === 'string' && typeof bId === 'string' ? (aId < bId ? -1 : aId > bId ? 1 : 0) : 0;
    });

  // Gap check against ALL applied ids: the largest applied id bounds the
  // past. Any unapplied migration sorting before ANY applied id would
  // retro-insert history and must be refused. The `.some` scan is `O(n)` per
  // candidate, bounded by `O(n^2)` worst case; short-circuit first.
  let maxAppliedId: string | null = null;
  for (const id of appliedById.keys()) {
    if (maxAppliedId === null || id > maxAppliedId) {
      maxAppliedId = id;
    }
  }
  const appliedIds: readonly string[] = [...appliedById.keys()];
  const toRun: AvailableMigration[] = [];
  for (const entry of sortedAvailable) {
    const id = entry['id'] as string;
    if (!appliedById.has(id)) {
      if (appliedIds.some((appliedId) => appliedId > id)) {
        return { ok: false, reason: 'gap', id };
      }
      toRun.push({
        id,
        checksum: entry['checksum'] as string,
        sql: entry['sql'] as string,
      });
    }
  }

  return { ok: true, toRun };
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
  for (const key of ownKeys) {
    if (typeof key !== 'string' || POLLUTING_KEYS.has(key) || !schemaKeys.includes(key)) {
      return false;
    }
  }
  return true;
}
