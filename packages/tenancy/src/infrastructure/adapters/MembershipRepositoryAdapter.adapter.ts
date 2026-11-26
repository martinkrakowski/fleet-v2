// @generated adapter scaffold — implemented for FC3E (membership repository).
/**
 * MembershipRepositoryAdapter implements MembershipRepositoryPort
 * (local-transactional-store). One record per `organizationId` lives in an
 * in-memory map by default; when `stateDir` is configured it persists in
 * `membership.json` as a JSON array of per-organisation
 * `{ schemaVersion: 1, organizationId, revision, members }` envelopes,
 * written via an atomic temp-file-then-rename write under an exclusive
 * lock. `applyChange` verifies the stored revision, refuses a `change`
 * naming another organisation, re-runs `decideMembershipChange` and stores
 * only an accepted list at the stored revision plus one — the store never
 * accepts a list the decider would refuse. An absent `schemaVersion` on
 * disk reads as 1 forever; any other unsupported version refuses the whole
 * read with `StateFileUnknownVersionError` without quarantining, and an
 * unreadable store keeps a quarantine copy (a read-only store refuses it
 * without writing anything).
 *
 * Hostile-input posture and cost bounds: every port argument is screened
 * with O(1) type, length and descriptor checks before any property of it is
 * read, so a getter is never invoked, a Proxy is detected before
 * reflection, an array hole or array-like never passes, an enormous string
 * is refused by its length alone and a prototype-polluting key is refused
 * by name. The one O(n) work is the decider's own bounded validation pass
 * over at most `MAX_MEMBERS` records.
 */

import { types } from 'node:util';
import * as path from 'node:path';

import {
  type MembershipChange,
  type MembershipRecord,
  decideMembershipChange,
  validateMembershipChange,
  validateMembersList,
} from '../../domain/entities/Membership.js';
import { ORGANIZATION_ID_PATTERN, isZonedIsoDateTime } from '../../domain/entities/record-guards.js';
import {
  type MembershipApplyResult,
  type MembershipRepositoryPort,
} from '../../application/ports/out/MembershipRepositoryPort.out-port.js';
import {
  assertStoreWritable,
  assertValidSchemaVersionPolicy,
  readOrQuarantineVersionedRecordList,
  readStoreRecordSchemaVersion,
  withFileLock,
  writeJsonAtomically,
  type VersionedRecordParseResult,
} from './file-store.js';

/** The schema-version policy of `membership.json` (Q5a/Q5b). */
export const MEMBERSHIP_STORE_VERSION_POLICY = assertValidSchemaVersionPolicy('membership.json', {
  writerVersion: 1,
  acceptedVersions: [1],
});

const DEFAULT_FILE_NAME = 'membership.json';
/** A file name must be a single safe path element, never a traversal. */
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const ORGANIZATION_ID_MAX_LENGTH = 64;

export interface MembershipRepositoryAdapterOptions {
  /** Directory for file-backed JSON persistence; in-memory only when omitted. */
  readonly stateDir?: string;
  /** Store file name inside `stateDir`; defaults to `membership.json`. */
  readonly fileName?: string;
  /** Refuse every write before locking, reading or writing anything. */
  readonly readOnly?: boolean;
  /** Maximum wait for the store lock before `FileLockTimeoutError`. */
  readonly lockTimeoutMs?: number;
}

/** A stored organisation's membership: its envelope id, members and revision. */
export interface StoredMembership {
  readonly organizationId: string;
  readonly revision: number;
  readonly members: readonly MembershipRecord[];
}

/** Thrown at construction for an unsafe or colliding `fileName` option. */
export class UnsafeMembershipFileNameError extends Error {
  constructor(reason: string) {
    super(`MembershipRepositoryAdapter refuses the state file name: ${reason}`);
    this.name = 'UnsafeMembershipFileNameError';
  }
}

function isProxy(value: unknown): boolean {
  return types.isProxy(value as object);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

/**
 * Screen one untrusted organisation id: type, length and pattern. A Proxy
 * is detected before any regex reads it. Cost bound: O(1) — one length
 * check, one proxy test and one bounded regex over at most 64 characters,
 * so an enormous string is refused without a linear scan.
 */
function isOrganizationId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= ORGANIZATION_ID_MAX_LENGTH &&
    !types.isProxy(value as unknown as object) &&
    ORGANIZATION_ID_PATTERN.test(value)
  );
}

/**
 * Screen one untrusted actor id. A Proxy is detected before any read. Cost
 * bound: O(1) — one length check, one proxy test plus a bounded regex.
 */
function isActorId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    !types.isProxy(value as unknown as object)
  );
}

function invalidRecord(reason: string): MembershipApplyResult {
  return { outcome: 'invalid-record', reason };
}

/**
 * The versioned reader's record parser, shared with the store's inspection:
 * the `schemaVersion` check runs first (an absent `schemaVersion` reads as
 * 1), then the envelope is copied through its own data descriptors and
 * validated. An envelope whose members name another `organizationId`, whose
 * `revision` is not a non-negative safe integer, or that carries an extra
 * key, an accessor, a symbol key or a prototype-polluting key is invalid.
 * Pure and never throws.
 *
 * Cost bound: O(n) over the envelope's own members (a persisted element is
 * a bounded JSON object), each member validated in O(1) by
 * `validateMembersList`, bounded by `MAX_MEMBERS`.
 */
export function parseVersionedMembershipStateRecord(
  raw: unknown,
): VersionedRecordParseResult<StoredMembership> {
  try {
    const versionCheck = readStoreRecordSchemaVersion(raw, MEMBERSHIP_STORE_VERSION_POLICY);
    if (versionCheck.status !== 'ok') {
      return versionCheck;
    }
    const descriptors = Object.getOwnPropertyDescriptors(raw as object);
    let organizationId: unknown;
    let revision: unknown = 0;
    let members: unknown;
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key as string];
      if (typeof key !== 'string' || descriptor === undefined || !('value' in descriptor)) {
        return { status: 'invalid' };
      }
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        return { status: 'invalid' };
      }
      if (key === 'organizationId') {
        organizationId = descriptor.value;
      } else if (key === 'revision') {
        revision = descriptor.value;
      } else if (key === 'members') {
        members = descriptor.value;
      } else if (key !== 'schemaVersion') {
        return { status: 'invalid' };
      }
    }
    if (!isOrganizationId(organizationId) || !isNonNegativeSafeInteger(revision)) {
      return { status: 'invalid' };
    }
    if (members === undefined) {
      return { status: 'invalid' };
    }
    const list = validateMembersList(members);
    if (!list.ok) {
      return { status: 'invalid' };
    }
    for (const member of list.members) {
      if (member.organizationId !== organizationId) {
        return { status: 'invalid' };
      }
    }
    return {
      status: 'ok',
      record: { organizationId, revision, members: list.members },
      schemaVersion: versionCheck.schemaVersion,
    };
  } catch {
    return { status: 'invalid' };
  }
}

/**
 * Two envelope records for one organisation id cannot be merged safely: the
 * file is treated as unreadable. Cost bound: O(n) over the bounded record
 * list (at most `STORE_FILE_MAX_BYTES` of JSON).
 */
function findDuplicateOrganizationId(records: readonly StoredMembership[]): string | undefined {
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.organizationId)) {
      return 'duplicate organization id';
    }
    seen.add(record.organizationId);
  }
  return undefined;
}

/** Fresh deep copies of a members list: the store never leaks its records. */
function freshMembers(members: readonly MembershipRecord[]): MembershipRecord[] {
  return members.map((member) => ({ ...member }));
}

export class MembershipRepositoryAdapter implements MembershipRepositoryPort {
  private readonly stateDir: string | undefined;
  private readonly fileName: string;
  private readonly readOnly: boolean;
  private readonly lockTimeoutMs: number;
  private readonly inMemoryMemberships = new Map<string, StoredMembership>();

  constructor(options: MembershipRepositoryAdapterOptions = {}) {
    const fileName = options.fileName ?? DEFAULT_FILE_NAME;
    if (!SAFE_FILE_NAME.test(fileName) || fileName === '.' || fileName === '..') {
      throw new UnsafeMembershipFileNameError('the name is not a single safe file name');
    }
    if (fileName === 'organizations.json') {
      throw new UnsafeMembershipFileNameError('the name collides with the organization store');
    }
    this.stateDir = options.stateDir;
    this.fileName = fileName;
    this.readOnly = options.readOnly === true;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
  }

  private get filePath(): string {
    return path.join(this.stateDir!, this.fileName);
  }

  async listMembers(organizationId: string): Promise<readonly MembershipRecord[]> {
    if (!isOrganizationId(organizationId)) {
      // Cost bound: O(1) — the screen above; no store is read.
      return [];
    }
    if (this.stateDir === undefined) {
      const stored = this.inMemoryMemberships.get(organizationId);
      return stored === undefined ? [] : freshMembers(stored.members);
    }
    const records = await this.readMembershipsFromDisk(false);
    const stored = records.get(organizationId);
    return stored === undefined ? [] : freshMembers(stored.members);
  }

  async findMember(organizationId: string, actor: string): Promise<MembershipRecord | null> {
    if (!isOrganizationId(organizationId) || !isActorId(actor)) {
      return null;
    }
    const members = await this.listMembers(organizationId);
    const found = members.find((member) => member.actor === actor);
    return found === undefined ? null : { ...found };
  }

  async applyChange(
    organizationId: string,
    change: MembershipChange,
    expectedRevision: number,
    nowIso: string,
  ): Promise<MembershipApplyResult> {
    // A read-only store refuses every write before locking, reading or
    // writing anything.
    assertStoreWritable(this.readOnly, this.fileName);
    if (!isOrganizationId(organizationId)) {
      return invalidRecord('invalid-organization-id');
    }
    if (!isZonedIsoDateTime(nowIso)) {
      return invalidRecord('invalid-timestamp');
    }
    if (!isNonNegativeSafeInteger(expectedRevision)) {
      return invalidRecord('invalid-revision');
    }
    // The change object is screened once through the domain validator: it
    // snapshots the input through its own data descriptors, so no getter
    // and no Proxy trap ever runs, an array hole or array-like never passes
    // and a prototype-polluting key is refused by name. Cost bound: O(1) —
    // one bounded snapshot pass over at most the five allowed own keys.
    const parsed = validateMembershipChange(change, isProxy);
    if (!parsed.ok) {
      return invalidRecord(parsed.reason);
    }
    const decided = parsed.change;
    if (decided.organizationId !== organizationId) {
      return { outcome: 'refused', reason: 'organization-mismatch' };
    }
    if (this.stateDir === undefined) {
      return this.writeInMemory(organizationId, decided, expectedRevision, nowIso);
    }
    return this.writeOnDisk(organizationId, decided, expectedRevision, nowIso);
  }

  /**
   * The in-memory check-and-write is synchronous: there is no `await`
   * between reading the stored revision and writing the accepted list, so
   * concurrent calls on one process are serialized by the event loop and
   * exactly one of them can win.
   */
  private writeInMemory(
    organizationId: string,
    change: MembershipChange,
    expectedRevision: number,
    nowIso: string,
  ): MembershipApplyResult {
    const stored = this.inMemoryMemberships.get(organizationId);
    const current = stored ?? { revision: 0, members: [] as readonly MembershipRecord[] };
    if (current.revision !== expectedRevision) {
      return {
        outcome: 'stale-revision',
        expectedRevision,
        actualRevision: current.revision,
      };
    }
    const decision = decideMembershipChange(current.members, change, nowIso);
    if (!decision.ok) {
      return { outcome: 'refused', reason: decision.reason };
    }
    const revision = expectedRevision + 1;
    // Store copies so a caller retaining a mutable alias cannot change the
    // stored list without going through the store.
    const storedMembers = freshMembers(decision.members);
    this.inMemoryMemberships.set(organizationId, { organizationId, revision, members: storedMembers });
    return {
      outcome: 'saved',
      revision,
      members: freshMembers(storedMembers),
      ...changedMemberKey(decision.members, change),
    };
  }

  private async writeOnDisk(
    organizationId: string,
    change: MembershipChange,
    expectedRevision: number,
    nowIso: string,
  ): Promise<MembershipApplyResult> {
    const target = this.filePath;
    const lockPath = `${target}.lock`;
    let outcome: MembershipApplyResult = invalidRecord('unwritten');
    await withFileLock(
      lockPath,
      async () => {
        const records = await this.readMembershipsFromDisk(true);
        const stored = records.get(organizationId);
        const current = stored ?? { revision: 0, members: [] as readonly MembershipRecord[] };
        if (current.revision !== expectedRevision) {
          outcome = {
            outcome: 'stale-revision',
            expectedRevision,
            actualRevision: current.revision,
          };
          return;
        }
        const decision = decideMembershipChange(current.members, change, nowIso);
        if (!decision.ok) {
          outcome = { outcome: 'refused', reason: decision.reason };
          return;
        }
        const revision = expectedRevision + 1;
        const storedMembers = freshMembers(decision.members);
        const next = new Map(records);
        next.set(organizationId, { organizationId, revision, members: storedMembers });
        const payload = [...next.values()].map((item) => ({
          schemaVersion: MEMBERSHIP_STORE_VERSION_POLICY.writerVersion,
          organizationId: item.organizationId,
          revision: item.revision,
          members: item.members,
        }));
        await writeJsonAtomically(target, payload);
        outcome = {
          outcome: 'saved',
          revision,
          members: freshMembers(storedMembers),
          ...changedMemberKey(decision.members, change),
        };
      },
      { timeoutMs: this.lockTimeoutMs },
    );
    return outcome;
  }

  private async readMembershipsFromDisk(
    lockHeld: boolean,
  ): Promise<Map<string, StoredMembership>> {
    const map = new Map<string, StoredMembership>();
    const records = await readOrQuarantineVersionedRecordList({
      filePath: this.filePath,
      parseRecord: parseVersionedMembershipStateRecord,
      findListError: findDuplicateOrganizationId,
      lockHeld,
      readOnly: this.readOnly,
      lockTimeoutMs: this.lockTimeoutMs,
    });
    for (const item of records) {
      map.set(item.organizationId, item);
    }
    return map;
  }
}

/**
 * The changed member of an accepted add or change-role, if any, spread so
 * the key is absent for a remove.
 */
function changedMemberKey(
  nextMembers: readonly MembershipRecord[],
  change: MembershipChange,
): { readonly changedMember?: MembershipRecord } {
  if (change.kind === 'remove') {
    return {};
  }
  const changed = nextMembers.find((member) => member.actor === change.actor);
  return changed === undefined ? {} : { changedMember: { ...changed } };
}
