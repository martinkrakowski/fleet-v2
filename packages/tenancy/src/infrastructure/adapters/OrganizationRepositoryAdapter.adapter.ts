// @generated adapter scaffold — implemented for FC3D (organization repository).
/**
 * OrganizationRepositoryAdapter implements OrganizationRepositoryPort
 * (local-transactional-store). One record per `organizationId`, and one per
 * `(organizationId, projectId)` pair for projects. Organisation records live
 * in an in-memory map by default; when `stateDir` is configured they persist
 * in `organizations.json` as a JSON array of flat
 * `{ ...record, revision, schemaVersion: 1 }` envelopes, written via an atomic
 * temp-file-then-rename write under an exclusive lock. Projects persist the
 * same way in `projects.json`. `createOrganization`/`createProject` store at
 * revision 0 and `saveOrganization`/`saveProject` are compare-and-swaps that
 * store only at the stored revision plus one. An absent `schemaVersion` on
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
import {
  type ProjectRecord,
  validateProjectRecord,
} from '../../domain/entities/Project.js';
import { ORGANIZATION_ID_PATTERN } from '../../domain/entities/record-guards.js';
import {
  UnsafeOrganizationIdError,
  type OrganizationRepositoryPort,
  OrganizationWriteOutcome,
  type StoredOrganization,
  type StoredProject,
  ProjectWriteOutcome,
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

/** The schema-version policy of `projects.json`. */
export const PROJECT_STORE_VERSION_POLICY = assertValidSchemaVersionPolicy('projects.json', {
  writerVersion: 1,
  acceptedVersions: [1],
});

/** `projects.json` — a separate store file from `organizations.json`. */
const PROJECT_STORE_NAME = 'projects.json';

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
 * Validate an untrusted create/save input. `validateOrganizationRecord`
 * snapshots it once through the shared `record-guards` reader, so no getter
 * and no Proxy trap ever runs, an extra key (including `revision`, which the
 * caller never supplies, and the prototype-polluting keys) is refused, and
 * the accepted record is a frozen copy. Cost bound: O(1) — one bounded
 * snapshot pass over at most the allowed keys.
 */
function snapshotOrganizationInput(
  input: unknown,
): { ok: true; record: OrganizationRecord } | { ok: false } {
  const validated = validateOrganizationRecord(input, isProxy);
  if (!validated.ok) {
    return { ok: false };
  }
  // `schemaVersion` is a storage envelope concern: it is stripped here so a
  // caller-supplied `schemaVersion: 1` is stored and returned identically in
  // memory and on disk (where the envelope writes its own).
  const { schemaVersion: _envelope, ...record } = validated.value;
  void _envelope;
  return { ok: true, record };
}

/**
 * The versioned reader's record parser, shared with the store's inspection:
 * the `schemaVersion` check runs first, then the envelope validation. Pure
 * and never throws. The returned record carries no `schemaVersion` key — it
 * was stripped before validation. An absent `revision` reads as 0.
 *
 * Cost bound: O(k) per record over its own keys (a persisted element is a
 * bounded JSON object), one bounded validation pass and one version check.
 */
export function parseVersionedOrganizationStateRecord(
  raw: unknown,
): VersionedRecordParseResult<StoredOrganization> {
  try {
    const versionCheck = readStoreRecordSchemaVersion(raw, ORGANIZATION_STORE_VERSION_POLICY);
    if (versionCheck.status !== 'ok') {
      return versionCheck;
    }
    // `raw` is a JSON-parsed element. Copy every own data property except
    // the two storage keys; validateOrganizationRecord then refuses any
    // extra key, accessor or hostile shape in its own single snapshot.
    const descriptors = Object.getOwnPropertyDescriptors(raw as object);
    const plain: Record<string, unknown> = {};
    let revision: unknown = 0;
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key as string];
      if (typeof key !== 'string' || descriptor === undefined || !('value' in descriptor)) {
        return { status: 'invalid' };
      }
      if (key === 'revision') {
        revision = descriptor.value;
      } else if (key !== 'schemaVersion') {
        Object.defineProperty(plain, key, {
          value: descriptor.value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    if (!isNonNegativeSafeInteger(revision)) {
      return { status: 'invalid' };
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

/**
 * Validate an untrusted project create/save input. `validateProjectRecord`
 * snapshots it once through the shared `record-guards` reader, so no getter
 * and no Proxy trap ever runs, an extra key (including `revision`, which the
 * caller never supplies, and the prototype-polluting keys) is refused, and
 * the accepted record is a frozen copy. Cost bound: O(1) — one bounded
 * snapshot pass over at most the 7 allowed keys, depth 1, strings capped at
 * 4096 characters.
 */
function snapshotProjectInput(
  input: unknown,
): { ok: true; record: ProjectRecord } | { ok: false } {
  const validated = validateProjectRecord(input, isProxy);
  if (!validated.ok) {
    return { ok: false };
  }
  // `schemaVersion` is a storage envelope concern: it is stripped here so a
  // caller-supplied `schemaVersion: 1` is stored and returned identically in
  // memory and on disk (where the envelope writes its own).
  const { schemaVersion: _envelope, ...record } = validated.value;
  void _envelope;
  return { ok: true, record };
}

/**
 * The versioned reader's project record parser, shared with the store's
 * inspection: the `schemaVersion` check runs first, then the envelope
 * validation. Pure and never throws. The returned record carries no
 * `schemaVersion` key — it was stripped before validation. An absent
 * `revision` reads as 0.
 *
 * Cost bound: O(k) per record over its own keys (a persisted element is a
 * bounded JSON object), one bounded validation pass and one version check.
 */
export function parseVersionedProjectStateRecord(
  raw: unknown,
): VersionedRecordParseResult<StoredProject> {
  try {
    const versionCheck = readStoreRecordSchemaVersion(raw, PROJECT_STORE_VERSION_POLICY);
    if (versionCheck.status !== 'ok') {
      return versionCheck;
    }
    // `raw` is a JSON-parsed element. Copy every own data property except
    // the two storage keys; validateProjectRecord then refuses any extra
    // key, accessor or hostile shape in its own single snapshot. Cost
    // bound: O(k) over the element's own keys, never invoking a getter
    // (accessor descriptors are refused outright).
    const descriptors = Object.getOwnPropertyDescriptors(raw as object);
    const plain: Record<string, unknown> = {};
    let revision: unknown = 0;
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key as string];
      if (typeof key !== 'string' || descriptor === undefined || !('value' in descriptor)) {
        return { status: 'invalid' };
      }
      if (key === 'revision') {
        revision = descriptor.value;
      } else if (key !== 'schemaVersion') {
        Object.defineProperty(plain, key, {
          value: descriptor.value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    if (!isNonNegativeSafeInteger(revision)) {
      return { status: 'invalid' };
    }
    const validated = validateProjectRecord(plain);
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
 * Two records for one `(organizationId, projectId)` pair cannot be merged
 * safely: the file is treated as unreadable. Nested per-organisation sets
 * keep ids containing the separator from aliasing each other. Cost bound:
 * O(n) over the bounded record list.
 */
function duplicateProjectKeyError(records: readonly StoredProject[]): string | undefined {
  const seen = new Map<string, Set<string>>();
  for (const item of records) {
    let ids = seen.get(item.record.organizationId);
    if (ids === undefined) {
      ids = new Set();
      seen.set(item.record.organizationId, ids);
    } else if (ids.has(item.record.projectId)) {
      return 'duplicate (organizationId, projectId) key';
    }
    ids.add(item.record.projectId);
  }
  return undefined;
}

/**
 * A lookup id that is not a non-empty string matching the id pattern is
 * malformed caller input and fails closed: `findProject` answers null and
 * `listProjects` answers an empty list rather than reading or listing
 * across organisations. No stored record can carry such an id (the record
 * validator refuses one), so pattern-failing lookups can never hide a
 * stored project. Cost bound: O(1) — fixed type/length checks and a
 * bounded-length pattern test.
 */
function isUsableLookupId(value: unknown): value is string {
  return typeof value === 'string' && ORGANIZATION_ID_PATTERN.test(value);
}

export class OrganizationRepositoryAdapter implements OrganizationRepositoryPort {
  private readonly options: OrganizationRepositoryAdapterOptions | undefined;
  private readonly inMemoryRecords = new Map<string, StoredOrganization>();
  /** In-memory projects keyed by organizationId, then projectId. */
  private readonly inMemoryProjects = new Map<string, Map<string, StoredProject>>();

  constructor(options?: OrganizationRepositoryAdapterOptions) {
    this.options = options;
  }

  async findOrganization(id: string): Promise<StoredOrganization | null> {
    if (typeof id !== 'string' || id.length === 0) {
      throw new UnsafeOrganizationIdError();
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

  async findProject(organizationId: string, projectId: string): Promise<StoredProject | null> {
    if (!isUsableLookupId(organizationId) || !isUsableLookupId(projectId)) {
      // Fail closed: a malformed lookup key is never an answer that could
      // cross organisations. Cost bound: O(1) — fixed type/length checks.
      return null;
    }
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      const stored = this.inMemoryProjects.get(organizationId)?.get(projectId);
      return stored === undefined
        ? null
        : { record: { ...stored.record }, revision: stored.revision };
    }
    const projects = await this.readProjectsFromDisk(
      path.join(stateDir, PROJECT_STORE_NAME),
    );
    const stored = projects.get(organizationId)?.get(projectId);
    return stored === undefined
      ? null
      : { record: { ...stored.record }, revision: stored.revision };
  }

  async listProjects(organizationId: string): Promise<readonly StoredProject[]> {
    if (!isUsableLookupId(organizationId)) {
      // Fail closed on a malformed owner id; never list across organisations.
      return [];
    }
    const stateDir = this.options?.stateDir;
    const projects =
      stateDir === undefined
        ? this.inMemoryProjects
        : await this.readProjectsFromDisk(path.join(stateDir, PROJECT_STORE_NAME));
    const owned = projects.get(organizationId);
    return (owned === undefined ? [] : [...owned.values()]).map((stored) => ({
      record: { ...stored.record },
      revision: stored.revision,
    }));
  }

  async createProject(record: ProjectRecord): Promise<ProjectWriteOutcome> {
    const snapshot = snapshotProjectInput(record);
    if (!snapshot.ok) {
      return { status: 'refused', reason: 'invalid-record' };
    }
    // Deliberately no organizations.json existence check: the project store
    // enforces composite-key uniqueness and record validity only.
    return this.writeProject(snapshot.record, null, 0);
  }

  async saveProject(
    record: ProjectRecord,
    expectedRevision: number,
  ): Promise<ProjectWriteOutcome> {
    if (!isNonNegativeSafeInteger(expectedRevision)) {
      // Cost bound: O(1) — fixed numeric checks.
      return { status: 'refused', reason: 'invalid-record' };
    }
    const snapshot = snapshotProjectInput(record);
    if (!snapshot.ok) {
      return { status: 'refused', reason: 'invalid-record' };
    }
    return this.writeProject(
      snapshot.record,
      { organizationId: snapshot.record.organizationId, projectId: snapshot.record.projectId },
      expectedRevision,
    );
  }

  private async writeProject(
    record: ProjectRecord,
    expected: { organizationId: string; projectId: string } | null,
    expectedRevision: number,
  ): Promise<ProjectWriteOutcome> {
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      return this.writeProjectInMemory(record, expected, expectedRevision);
    }
    return this.writeProjectOnDisk(record, expected, expectedRevision, stateDir);
  }

  private writeProjectInMemory(
    record: ProjectRecord,
    expected: { organizationId: string; projectId: string } | null,
    expectedRevision: number,
  ): ProjectWriteOutcome {
    let owned = this.inMemoryProjects.get(record.organizationId);
    if (owned === undefined) {
      owned = new Map();
      this.inMemoryProjects.set(record.organizationId, owned);
    }
    const stored = owned.get(record.projectId);
    let revision: number;
    if (expected === null) {
      if (stored !== undefined) {
        return { status: 'refused', reason: 'already-exists' };
      }
      revision = 0;
    } else {
      if (stored === undefined) {
        return { status: 'refused', reason: 'not-found' };
      }
      if (stored.revision !== expectedRevision) {
        return { status: 'refused', reason: 'stale-revision' };
      }
      if (expectedRevision === Number.MAX_SAFE_INTEGER) {
        // Overflow guard: the compare-and-swap would store `expectedRevision + 1`,
        // which leaves the safe-integer range — a revision that is persisted but
        // rejected on read. Refuse only when the revision actually matches, so a
        // mismatched revision still reports stale-revision. Cost bound: O(1) —
        // one comparison.
        return { status: 'refused', reason: 'invalid-record' };
      }
      revision = expectedRevision + 1;
    }
    // Store copies so a caller retaining a mutable alias cannot change the
    // saved record or revision without going through the compare-and-swap.
    const next: StoredProject = { record: { ...record }, revision };
    owned.set(record.projectId, next);
    return { status: 'saved', record: { ...record }, revision };
  }

  private async writeProjectOnDisk(
    record: ProjectRecord,
    expected: { organizationId: string; projectId: string } | null,
    expectedRevision: number,
    stateDir: string,
  ): Promise<ProjectWriteOutcome> {
    const target = path.join(stateDir, PROJECT_STORE_NAME);
    const lockPath = path.join(stateDir, `${PROJECT_STORE_NAME}.lock`);
    let outcome: ProjectWriteOutcome = { status: 'refused', reason: 'invalid-record' };
    await withFileLock(lockPath, async () => {
      const projects = await this.readProjectsFromDisk(target, true);
      let owned = projects.get(record.organizationId);
      if (owned === undefined) {
        owned = new Map();
        projects.set(record.organizationId, owned);
      }
      const stored = owned.get(record.projectId);
      let revision: number;
      if (expected === null) {
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
        if (expectedRevision === Number.MAX_SAFE_INTEGER) {
          // Overflow guard: see writeProjectInMemory — refuse only on a
          // matching revision, before touching disk. Cost bound: O(1).
          outcome = { status: 'refused', reason: 'invalid-record' };
          return;
        }
        revision = expectedRevision + 1;
      }
      const next: StoredProject = { record: { ...record }, revision };
      owned.set(record.projectId, next);
      // The flat envelope: `schemaVersion` and `revision` beside the project
      // fields. `record` carries neither key (both were stripped before
      // validation), so the spread cannot overwrite them.
      const payload = [...projects.values()].flatMap((items) =>
        [...items.values()].map((item) => ({
          schemaVersion: PROJECT_STORE_VERSION_POLICY.writerVersion,
          revision: item.revision,
          ...item.record,
        })),
      );
      await writeJsonAtomically(target, payload);
      outcome = { status: 'saved', record: { ...record }, revision };
    });
    return outcome;
  }

  private async readProjectsFromDisk(
    target: string,
    lockHeld = false,
  ): Promise<Map<string, Map<string, StoredProject>>> {
    const map = new Map<string, Map<string, StoredProject>>();
    const records = await readOrQuarantineVersionedRecordList({
      filePath: target,
      parseRecord: parseVersionedProjectStateRecord,
      findListError: duplicateProjectKeyError,
      lockHeld,
    });
    for (const item of records) {
      let owned = map.get(item.record.organizationId);
      if (owned === undefined) {
        owned = new Map();
        map.set(item.record.organizationId, owned);
      }
      owned.set(item.record.projectId, item);
    }
    return map;
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
