// @generated adapter stub — refined for lane DT4.
/**
 * MergeQueueRepositoryAdapter implements MergeQueueRepositoryPort over the one
 * merge-queue store of a state directory (plan §3.3): an in-process record
 * list that optionally persists to `<stateDir>/merge-queue.json` under the
 * shared exclusive lock with an atomic rename, the exact bytes quarantined
 * when the file is unreadable. It never shares another store's file. The
 * adapter mints no ids and computes only the repo digest. A list keeps every
 * stored entry when `repository` is omitted, and otherwise keeps entries whose
 * stored digest matches that repository. Deadlines are validated from a fresh
 * clock at check time.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import type {
  MergeQueueDropCommand,
  MergeQueueEnqueueCommand,
  MergeQueueListQuery,
  MergeQueueRepositoryPort,
  MergeQueueRetryCommand,
  MergeQueueTransitionCommand,
} from '../../application/ports/out/MergeQueueRepositoryPort.out-port.js';
import type {
  MergeEnqueueDecision,
  MergeEnqueueInput,
  MergeDropDecision,
  MergeRetryDecision,
} from '../../domain/merge-queue-operations.js';
import {
  decideMergeEnqueue,
  decideMergeDrop,
  decideMergeRetry,
} from '../../domain/merge-queue-operations.js';
import { decideMergeTransition } from '../../domain/merge-pass-transitions.js';
import type { MergeTransitionDecision } from '../../domain/merge-pass-transitions.js';
import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import type { MergeQueueEntryRecord } from '../../domain/merge-queue-records.js';
import { isMergeQueueEntryLive, readMergeQueueEntryRecord } from '../../domain/merge-queue-records.js';
import {
  assertStoreWritable,
  inspectRecordListBytes,
  rejectUnreadableStateFile,
  withFileLock,
  writeJsonAtomically,
} from './file-store.js';
import { sha256HexDigest } from './AttemptArtifactAdapter.adapter.js';

export interface MergeQueueRepositoryAdapterOptions {
  /** When set, the store persists here and reloads on first use. */
  readonly stateDir?: string;
  readonly fileName?: string;
  /** Read-only mode: every write refuses before locking, reading or writing. */
  readonly readOnly?: boolean;
}

const DEFAULT_FILE_NAME = 'merge-queue.json';
/** The other work-execution stores own their own files; never those. */
const OTHER_STORE_FILE_NAMES = [
  'work-orders.json',
  'attempts.json',
  'journal.json',
  'reservations.json',
  'lane-runs.json',
  'conductor-driver-lease.json',
  'conductor-halt.json',
  'run-journal.json',
  'telemetry-dispositions.json',
  'conductor-passes.json',
  'lane-plans.json',
  'killall-halt.json',
  'killall-train-pause.json',
];
/** A configured file name may not escape the state directory it belongs to. */
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

/** Typed, fixed failure for a list whose deadline is malformed or already past. */
export class MergeQueueDeadlineError extends Error {
  constructor() {
    super('merge queue list refused an expired or malformed deadline');
    this.name = 'MergeQueueDeadlineError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Own keys a list query refuses so they cannot pollute `Object.prototype`. */
const POLLUTING_OWN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Own keys a `MergeQueueListQuery` may carry. Shape checks never scan past
 * `LIST_QUERY_ALLOWED_KEYS.length`.
 */
const LIST_QUERY_ALLOWED_KEYS = ['deadlineIso', 'repository'] as const;

/**
 * Own keys a list-query `repository` may carry. Shape checks never scan past
 * `LIST_QUERY_REPOSITORY_ALLOWED_KEYS.length`.
 */
const LIST_QUERY_REPOSITORY_ALLOWED_KEYS = ['owner', 'repo'] as const;

/** The 12-character repo digest `enqueueMergeEntry` stores and `listMergeEntries` matches. */
function computeRepoDigest(repository: { readonly owner: string; readonly repo: string }): string {
  return sha256HexDigest(`${repository.owner}/${repository.repo}`).slice(0, 12);
}

/**
 * A plain object whose prototype is `Object.prototype` or `null`.
 * `getPrototypeOf` is the only prototype read, so a Proxy `get` trap does not run.
 */
function isPlainQueryObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** True for an own data property. An accessor is refused so its getter never runs. */
function isDataDescriptor(descriptor: PropertyDescriptor | undefined): descriptor is PropertyDescriptor {
  return descriptor !== undefined && descriptor.get === undefined && descriptor.set === undefined;
}

/**
 * Refuse a prototype-polluting own key or any accessor. `Reflect.ownKeys` is
 * read once. More own keys than `maxOwnKeys` is the same refusal as a polluted
 * query, and it is thrown before any descriptor is read, so the scan stays
 * within that constant. Values are not read: `Reflect.ownKeys` and
 * `Object.getOwnPropertyDescriptor` do not run getters.
 */
function assertNoPollutingKeyOrAccessor(value: object, maxOwnKeys: number): void {
  const keys = Reflect.ownKeys(value);
  if (keys.length > maxOwnKeys) {
    throw new MergeQueueDeadlineError();
  }
  for (const key of keys) {
    if (typeof key === 'string' && POLLUTING_OWN_KEYS.has(key)) {
      throw new MergeQueueDeadlineError();
    }
    if (!isDataDescriptor(Object.getOwnPropertyDescriptor(value, key))) {
      throw new MergeQueueDeadlineError();
    }
  }
}

/** An own enumerable string data property that is not empty. */
function readNonEmptyEnumerableString(value: object, key: string): string {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    !isDataDescriptor(descriptor) ||
    descriptor.enumerable !== true ||
    typeof descriptor.value !== 'string' ||
    descriptor.value.length === 0
  ) {
    throw new MergeQueueDeadlineError();
  }
  return descriptor.value;
}

/** `owner` and `repo` from a plain repository object, or a deadline refusal. */
function readQueryRepository(value: unknown): { readonly owner: string; readonly repo: string } {
  if (!isPlainQueryObject(value)) {
    throw new MergeQueueDeadlineError();
  }
  assertNoPollutingKeyOrAccessor(value, LIST_QUERY_REPOSITORY_ALLOWED_KEYS.length);
  return {
    owner: readNonEmptyEnumerableString(value, 'owner'),
    repo: readNonEmptyEnumerableString(value, 'repo'),
  };
}

/** The reader's record parser, shared with `fleet-v2 state check`. Never throws. */
export function parseMergeQueueStateRecord(raw: unknown): MergeQueueEntryRecord | undefined {
  try {
    const result = readMergeQueueEntryRecord(raw);
    if (!result.ok) {
      return undefined;
    }
    return result.record;
  } catch {
    return undefined;
  }
}

/** A fixed detail when two live merge-queue records share (repository, pull request, head). */
export function duplicateMergeQueueIdentityListError(records: readonly MergeQueueEntryRecord[]): string | undefined {
  for (let leftIndex = 0; leftIndex < records.length; leftIndex += 1) {
    const left = records[leftIndex];
    if (!isMergeQueueEntryLive(left)) {
      continue;
    }
    for (let rightIndex = leftIndex + 1; rightIndex < records.length; rightIndex += 1) {
      const right = records[rightIndex];
      if (!isMergeQueueEntryLive(right)) {
        continue;
      }
      if (
        left.repository.owner === right.repository.owner &&
        left.repository.repo === right.repository.repo &&
        left.pullRequest === right.pullRequest &&
        left.headOid === right.headOid
      ) {
        return 'duplicate live merge-queue identity';
      }
    }
  }
  return undefined;
}

type MergeMutationDecision =
  | MergeEnqueueDecision
  | MergeDropDecision
  | MergeRetryDecision
  | MergeTransitionDecision;

export class MergeQueueRepositoryAdapter implements MergeQueueRepositoryPort {
  private inMemoryEntries: readonly MergeQueueEntryRecord[] = [];

  constructor(private readonly options: MergeQueueRepositoryAdapterOptions = {}) {}

  async enqueueMergeEntry(command: MergeQueueEnqueueCommand): Promise<MergeEnqueueDecision> {
    const deadlineRefusal = this.deadlineRefusal(command.deadlineIso);
    if (deadlineRefusal !== null) {
      return deadlineRefusal;
    }
    const repoDigest = computeRepoDigest(command.repository);
    const { repository, pullRequest, headOid, tier, enqueuedBy, runId, entryId, successorEntryId, enqueuedAtIso } = command;
    const input: MergeEnqueueInput = {
      repository,
      pullRequest,
      headOid,
      tier,
      enqueuedBy,
      runId,
      entryId,
      successorEntryId,
      enqueuedAtIso,
      repoDigest,
    };
    return this.mutate((current) => decideMergeEnqueue(current, input));
  }

  async dropMergeEntry(command: MergeQueueDropCommand): Promise<MergeDropDecision> {
    const deadlineRefusal = this.deadlineRefusal(command.deadlineIso);
    if (deadlineRefusal !== null) {
      return deadlineRefusal;
    }
    return this.mutate((current) => decideMergeDrop(current, command.entryId));
  }

  async retryMergeEntry(command: MergeQueueRetryCommand): Promise<MergeRetryDecision> {
    const deadlineRefusal = this.deadlineRefusal(command.deadlineIso);
    if (deadlineRefusal !== null) {
      return deadlineRefusal;
    }
    return this.mutate((current) =>
      decideMergeRetry(current, command.entryId, {
        entryId: command.retryEntryId,
        enqueuedAtIso: command.enqueuedAtIso,
      }),
    );
  }

  async applyMergeTransition(command: MergeQueueTransitionCommand): Promise<MergeTransitionDecision> {
    const deadlineRefusal = this.deadlineRefusal(command.deadlineIso);
    if (deadlineRefusal !== null) {
      return deadlineRefusal;
    }
    return this.mutate((current) =>
      decideMergeTransition(current, {
        entryId: command.entryId,
        expectedRevision: command.expectedRevision,
        next: command.next,
        successor: command.successor,
      }),
    );
  }

  /**
   * Entries for `query.repository`, matched on the same 12-character
   * `repoDigest` `enqueueMergeEntry` stores, or every stored entry when
   * `repository` is omitted or `undefined`. A non-plain query, a getter, a
   * prototype-polluting own key, a malformed `repository`, or a deadline that
   * is not a fresh zoned instant throws `MergeQueueDeadlineError` before the
   * store is read. Callers read an empty list as nothing queued.
   * Cost: O(N) in the number of stored entries. Query shape validation is O(1):
   * `Reflect.ownKeys` is read once per object. A query with more own keys than
   * `LIST_QUERY_ALLOWED_KEYS.length`, or a repository with more own keys than
   * `LIST_QUERY_REPOSITORY_ALLOWED_KEYS.length`, is refused before any property
   * descriptor is read.
   */
  async listMergeEntries(query: MergeQueueListQuery): Promise<readonly MergeQueueEntryRecord[]> {
    const targetDigest = this.readListTargetDigest(query);
    const target = this.statePath;
    const entries = target === null ? this.inMemoryEntries : await this.readRecordsFromDisk(target);
    if (targetDigest === undefined) {
      return target === null ? [...entries] : entries;
    }
    return entries.filter((entry) => entry.repoDigest === targetDigest);
  }

  /**
   * The digest to filter by, or `undefined` when the list is unscoped.
   * Reflective reads sit inside the try so a throwing Proxy trap becomes
   * `MergeQueueDeadlineError` and never reaches the store.
   */
  private readListTargetDigest(query: MergeQueueListQuery): string | undefined {
    try {
      return this.readListTargetDigestUnchecked(query);
    } catch (error: unknown) {
      if (error instanceof MergeQueueDeadlineError) {
        throw error;
      }
      throw new MergeQueueDeadlineError();
    }
  }

  private readListTargetDigestUnchecked(query: unknown): string | undefined {
    if (!isPlainQueryObject(query)) {
      throw new MergeQueueDeadlineError();
    }
    assertNoPollutingKeyOrAccessor(query, LIST_QUERY_ALLOWED_KEYS.length);
    const deadlineDescriptor = Object.getOwnPropertyDescriptor(query, 'deadlineIso');
    if (
      !isDataDescriptor(deadlineDescriptor) ||
      typeof deadlineDescriptor.value !== 'string' ||
      !this.isFreshDeadline(deadlineDescriptor.value)
    ) {
      throw new MergeQueueDeadlineError();
    }
    const repositoryDescriptor = Object.getOwnPropertyDescriptor(query, 'repository');
    if (repositoryDescriptor === undefined) {
      return undefined;
    }
    if (!isDataDescriptor(repositoryDescriptor)) {
      throw new MergeQueueDeadlineError();
    }
    if (repositoryDescriptor.value === undefined) {
      return undefined;
    }
    const repository = readQueryRepository(repositoryDescriptor.value);
    const targetDigest = computeRepoDigest(repository);
    return targetDigest;
  }

  /**
   * Run one mutation under the store's guard. `decide` reads the current
   * records and returns either saved records (written) or a refusal or
   * duplicate (nothing written).
   */
  private async mutate<T extends MergeMutationDecision>(
    decide: (current: readonly MergeQueueEntryRecord[]) => T,
  ): Promise<T> {
    assertStoreWritable(this.options?.readOnly === true, 'MergeQueueRepositoryAdapter');
    const target = this.statePath;
    const apply = async (result: T): Promise<T> => {
      switch (result.outcome) {
        case 'created':
        case 'supersedes':
        case 'dropped':
        case 'retried':
        case 'applied': {
          if (target === null) {
            this.inMemoryEntries = result.entries;
          } else {
            await writeJsonAtomically(target, result.entries);
          }
          break;
        }
        default:
          break;
      }
      return result;
    };
    if (target === null) {
      return apply(decide(this.inMemoryEntries));
    }
    return withFileLock(`${target}.lock`, async () => {
      const current = await this.readRecordsFromDisk(target);
      return apply(decide(current));
    });
  }

  private deadlineRefusal(deadlineIso: string): { outcome: 'refused'; reason: 'invalid-deadline' } | null {
    if (!this.isFreshDeadline(deadlineIso)) {
      return { outcome: 'refused', reason: 'invalid-deadline' };
    }
    return null;
  }

  private isFreshDeadline(deadlineIso: string): boolean {
    return isZonedIsoDateTime(deadlineIso) && Date.parse(deadlineIso) > Date.now();
  }

  private get statePath(): string | null {
    const { stateDir, fileName } = this.options;
    if (stateDir === undefined || stateDir.trim().length === 0) {
      return null;
    }
    const name = fileName ?? DEFAULT_FILE_NAME;
    if (OTHER_STORE_FILE_NAMES.includes(name)) {
      throw new Error('MergeQueueRepositoryAdapter refuses a fileName that collides with another store');
    }
    if (!SAFE_FILE_NAME.test(name) || name === '.' || name === '..') {
      throw new Error('MergeQueueRepositoryAdapter refuses unsafe state file name');
    }
    return join(stateDir, name);
  }

  private async readRecordsFromDisk(target: string): Promise<readonly MergeQueueEntryRecord[]> {
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(target);
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: string }).code === 'ENOENT'
      ) {
        return [];
      }
      throw error;
    }
    const inspection = inspectRecordListBytes(buffer, parseMergeQueueStateRecord);
    if (inspection.status === 'unreadable') {
      return rejectUnreadableStateFile(target, inspection.detail, buffer, this.options?.readOnly === true);
    }
    const listError = duplicateMergeQueueIdentityListError(inspection.records);
    if (listError !== undefined) {
      return rejectUnreadableStateFile(target, listError, buffer, this.options?.readOnly === true);
    }
    return inspection.records;
  }
}
