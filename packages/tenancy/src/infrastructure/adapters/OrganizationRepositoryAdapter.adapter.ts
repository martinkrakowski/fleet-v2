// @generated adapter scaffold — implemented for FC3D (organization repository).
/**
 * OrganizationRepositoryAdapter implements OrganizationRepositoryPort
 * (local-transactional-store). One record per `organizationId`. Records live
 * in an in-memory map by default; when `stateDir` is configured they persist
 * in `organizations.json` as a JSON array of flat
 * `{ ...record, revision, schemaVersion: 1 }` envelopes, written via an atomic
 * temp-file-then-rename write under an exclusive lock. `createOrganization`
 * stores at revision 0 and `saveOrganization` is a compare-and-swap that
 * stores only at the stored revision plus one. An absent `schemaVersion` on
 * disk reads as 1 forever; any other unsupported version refuses the whole
 * read with `StateFileUnknownVersionError` without quarantining, and an
 * unreadable store keeps a quarantine copy.
 */

import { types } from 'node:util';
import * as path from 'node:path';

import {
  type OrganizationRecord,
  validateOrganizationRecord,
} from '../../domain/entities/Organization.js';
import { ORGANIZATION_ID_PATTERN } from '../../domain/entities/record-guards.js';
import type {
  OrganizationRepositoryPort,
  OrganizationWriteOutcome,
  StoredOrganization,
} from '../../application/ports/out/OrganizationRepositoryPort.out-port.js';
import {
  assertValidSchemaVersionPolicy,
  readOrQuarantineVersionedRecordList,
  readStoreRecordSchemaVersion,
  withFileLock,
  writeJsonAtomically,
  type VersionedRecordParseResult,
} from './file-store.js';

/** The schema-version policy of `organizations.json`. */
export const ORGANIZATION_STORE_VERSION_POLICY = assertValidSchemaVersionPolicy('organizations.json', {
  writerVersion: 1,
  acceptedVersions: [1],
});

export interface OrganizationRepositoryAdapterOptions {
  /** Directory for file-backed JSON persistence; in-memory only when omitted. */
  readonly stateDir?: string;
}

const ORGANIZATION_STORE_NAME = 'organizations.json';

/**
 * The only own keys a persisted organization envelope may carry: the record's
 * own keys plus the storage keys. Cost bound: O(1) — a fixed set.
 */
const ORGANIZATION_STORE_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'schemaVersion',
  'revision',
  'organizationId',
  'displayName',
  'status',
  'createdAtIso',
  'retiredAtIso',
]);

/** The record fields read back from a persisted envelope after stripping. */
const ORGANIZATION_RECORD_FIELDS: readonly string[] = [
  'organizationId',
  'displayName',
  'status',
  'createdAtIso',
  'retiredAtIso',
];

function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

/** A trusted `types.isProxy` adapted to the domain's `IsProxy` signature. */
function isProxy(value: unknown): boolean {
  return types.isProxy(value as object);
}

/**
 * Snapshot an untrusted create/save input into a plain record without ever
 * invoking a getter: every own property is read through its descriptor and
 * accessor properties are refused before any read. Refuses null, undefined,
 * non-objects, arrays (and with them array holes, array-likes and
 * non-iterables, which are all refused by the same plain-object check),
 * Proxies (via `types.isProxy`, which observes no trap), accessor
 * properties, symbol keys, unknown keys (which covers the
 * prototype-polluting keys `__proto__`, `constructor` and `prototype`) and
 * oversized strings (via `validateOrganizationRecord`).
 *
 * Cost bound: O(1) — one own-key pass over at most the 7 allowed keys plus
 * one bounded validation pass (depth 1, strings capped at 4096 characters).
 */
function snapshotOrganizationInput(
  input: unknown,
): { ok: true; record: OrganizationRecord } | { ok: false } {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || isProxy(input)) {
    return { ok: false };
  }
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) {
    return { ok: false };
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const ownKeys = Reflect.ownKeys(input);
  // Refuse before iterating when the shape is already wrong.
  if (ownKeys.length > ORGANIZATION_STORE_ALLOWED_KEYS.size) {
    return { ok: false };
  }
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !ORGANIZATION_STORE_ALLOWED_KEYS.has(key)) {
      // Any key outside the allow-list is refused, including `__proto__`,
      // `constructor` and `prototype`; the offending key text is never echoed.
      return { ok: false };
    }
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      // An accessor (or non-enumerable) property is refused unread.
      return { ok: false };
    }
  }
  const plain: Record<string, unknown> = {};
  for (const field of ORGANIZATION_RECORD_FIELDS) {
    plain[field] = descriptors[field]?.value;
  }
  const schemaVersionDescriptor = descriptors['schemaVersion'];
  if (schemaVersionDescriptor !== undefined) {
    plain['schemaVersion'] = schemaVersionDescriptor.value;
  }
  const validated = validateOrganizationRecord(plain, isProxy);
  return validated.ok ? { ok: true, record: validated.value } : { ok: false };
}

/**
 * The versioned reader's record parser, shared with the store's inspection:
 * the `schemaVersion` check runs first, then the envelope validation. Pure
 * and never throws. The returned record carries no `schemaVersion` key — it
 * was stripped before validation. An absent `revision` reads as 0.
 *
 * Cost bound: O(1) per record — one own-key pass over at most the 7 allowed
 * keys, one bounded validation pass, and one version check.
 */
export function parseVersionedOrganizationStateRecord(
  raw: unknown,
): VersionedRecordParseResult<StoredOrganization> {
  try {
    const versionCheck = readStoreRecordSchemaVersion(raw, ORGANIZATION_STORE_VERSION_POLICY);
    if (versionCheck.status !== 'ok') {
      return versionCheck;
    }
    const descriptors = Object.getOwnPropertyDescriptors(raw as object);
    const ownKeys = Reflect.ownKeys(raw as object);
    if (ownKeys.length > ORGANIZATION_STORE_ALLOWED_KEYS.size) {
      return { status: 'invalid' };
    }
    for (const key of ownKeys) {
      if (typeof key !== 'string' || !ORGANIZATION_STORE_ALLOWED_KEYS.has(key)) {
        return { status: 'invalid' };
      }
      const descriptor = descriptors[key];
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
        return { status: 'invalid' };
      }
    }
    const revisionDescriptor = descriptors['revision'];
    const revision = revisionDescriptor === undefined ? 0 : (revisionDescriptor.value as unknown);
    if (!isNonNegativeSafeInteger(revision)) {
      return { status: 'invalid' };
    }
    const plain: Record<string, unknown> = {};
    for (const field of ORGANIZATION_RECORD_FIELDS) {
      plain[field] = descriptors[field]?.value;
    }
    const validated = validateOrganizationRecord(plain);
    if (!validated.ok) {
      return { status: 'invalid' };
    }
    return {
      status: 'ok',
      record: { record: validated.value, revision },
      schemaVersion: versionCheck.schemaVersion,
    };
  } catch {
    // A hostile getter on `raw` must never throw out of the parser.
    return { status: 'invalid' };
  }
}

/**
 * Two records for one organization id cannot be merged safely: the file is
 * treated as unreadable. Cost bound: O(n) over the bounded record list.
 */
function duplicateOrganizationIdError(records: readonly StoredOrganization[]): string | undefined {
  const seen = new Set<string>();
  for (const item of records) {
    if (seen.has(item.record.organizationId)) {
      return 'duplicate organization id';
    }
    seen.add(item.record.organizationId);
  }
  return undefined;
}

export class OrganizationRepositoryAdapter implements OrganizationRepositoryPort {
  private readonly options: OrganizationRepositoryAdapterOptions | undefined;
  private readonly inMemoryRecords = new Map<string, StoredOrganization>();

  constructor(options?: OrganizationRepositoryAdapterOptions) {
    this.options = options;
  }

  async findOrganization(id: string): Promise<StoredOrganization | null> {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('OrganizationRepositoryAdapter refuses an unsafe organization id');
    }
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      const stored = this.inMemoryRecords.get(id);
      return stored === undefined
        ? null
        : { record: { ...stored.record }, revision: stored.revision };
    }
    const records = await this.readRecordsFromDisk(path.join(stateDir, ORGANIZATION_STORE_NAME));
    const stored = records.get(id);
    return stored === undefined
      ? null
      : { record: { ...stored.record }, revision: stored.revision };
  }

  async listOrganizations(): Promise<readonly StoredOrganization[]> {
    const stateDir = this.options?.stateDir;
    const records =
      stateDir === undefined
        ? [...this.inMemoryRecords.values()]
        : await this.readRecordsFromDisk(path.join(stateDir, ORGANIZATION_STORE_NAME));
    return [...records.values()].map((stored) => ({
      record: { ...stored.record },
      revision: stored.revision,
    }));
  }

  async createOrganization(record: OrganizationRecord): Promise<OrganizationWriteOutcome> {
    const snapshot = snapshotOrganizationInput(record);
    if (!snapshot.ok) {
      return { status: 'refused', reason: 'invalid-record' };
    }
    const validated = snapshot.record;
    return this.writeRecord(validated, null, 0);
  }

  async saveOrganization(
    record: OrganizationRecord,
    expectedRevision: number,
  ): Promise<OrganizationWriteOutcome> {
    if (!isNonNegativeSafeInteger(expectedRevision)) {
      // Cost bound: O(1) — fixed numeric checks.
      return { status: 'refused', reason: 'invalid-record' };
    }
    const snapshot = snapshotOrganizationInput(record);
    if (!snapshot.ok) {
      return { status: 'refused', reason: 'invalid-record' };
    }
    return this.writeRecord(snapshot.record, snapshot.record.organizationId, expectedRevision);
  }

  private async writeRecord(
    record: OrganizationRecord,
    expectedId: string | null,
    expectedRevision: number,
  ): Promise<OrganizationWriteOutcome> {
    if (!ORGANIZATION_ID_PATTERN.test(record.organizationId)) {
      return { status: 'refused', reason: 'invalid-record' };
    }
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      return this.writeInMemory(record, expectedId, expectedRevision);
    }
    return this.writeOnDisk(record, expectedId, expectedRevision, stateDir);
  }

  private writeInMemory(
    record: OrganizationRecord,
    expectedId: string | null,
    expectedRevision: number,
  ): OrganizationWriteOutcome {
    const stored = this.inMemoryRecords.get(record.organizationId);
    if (expectedId === null) {
      if (stored !== undefined) {
        return { status: 'refused', reason: 'already-exists' };
      }
    } else {
      if (stored === undefined) {
        return { status: 'refused', reason: 'not-found' };
      }
      if (stored.revision !== expectedRevision) {
        return { status: 'refused', reason: 'stale-revision' };
      }
    }
    const revision = expectedId === null ? 0 : expectedRevision + 1;
    // Store copies so a caller retaining a mutable alias cannot change the
    // saved record or revision without going through the compare-and-swap.
    this.inMemoryRecords.set(record.organizationId, {
      record: { ...record },
      revision,
    });
    return { status: 'saved', record: { ...record }, revision };
  }

  private async writeOnDisk(
    record: OrganizationRecord,
    expectedId: string | null,
    expectedRevision: number,
    stateDir: string,
  ): Promise<OrganizationWriteOutcome> {
    const target = path.join(stateDir, ORGANIZATION_STORE_NAME);
    const lockPath = path.join(stateDir, `${ORGANIZATION_STORE_NAME}.lock`);
    let outcome: OrganizationWriteOutcome = { status: 'refused', reason: 'invalid-record' };
    await withFileLock(lockPath, async () => {
      const records = await this.readRecordsFromDisk(target, true);
      const stored = records.get(record.organizationId);
      let revision: number;
      if (expectedId === null) {
        if (stored !== undefined) {
          outcome = { status: 'refused', reason: 'already-exists' };
          return;
        }
        revision = 0;
      } else {
        if (stored === undefined) {
          outcome = { status: 'refused', reason: 'not-found' };
          return;
        }
        if (stored.revision !== expectedRevision) {
          outcome = { status: 'refused', reason: 'stale-revision' };
          return;
        }
        revision = expectedRevision + 1;
      }
      const next: StoredOrganization = { record: { ...record }, revision };
      records.set(record.organizationId, next);
      const payload = [...records.values()].map((item) => ({
        ...item.record,
        revision: item.revision,
        schemaVersion: ORGANIZATION_STORE_VERSION_POLICY.writerVersion,
      }));
      await writeJsonAtomically(target, payload);
      outcome = { status: 'saved', record: { ...record }, revision };
    });
    return outcome;
  }

  private async readRecordsFromDisk(
    target: string,
    lockHeld = false,
  ): Promise<Map<string, StoredOrganization>> {
    const map = new Map<string, StoredOrganization>();
    const records = await readOrQuarantineVersionedRecordList({
      filePath: target,
      parseRecord: parseVersionedOrganizationStateRecord,
      findListError: duplicateOrganizationIdError,
      lockHeld,
    });
    for (const item of records) {
      map.set(item.record.organizationId, item);
    }
    return map;
  }
}
