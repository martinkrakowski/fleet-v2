// @generated adapter stub — refined for lane O2b-1.
/**
 * OrchestratorRequestRepositoryAdapter implements OrchestratorRequestRepositoryPort
 * over a versioned local JSON store: an in-process map by default; when
 * `stateDir` is configured each mutation persists to
 * `<stateDir>/orchestrator-requests.json` under an exclusive lock via an
 * atomic temp-file-then-rename write.
 *
 * It never shares another store's file and never throws a runtime input fault
 * or store read failure from a port method: every outcome carries only fixed
 * codes and validated ids — never filesystem paths, state directory names or
 * secret-shaped text. Stored records carry `schemaVersion: 1` (D6); reads
 * validate `schemaVersion` first (absent reads as 1) and strip it before
 * `OrchestratorRequest.create`, which refuses extra fields. A save is a
 * compare-and-swap on `revision` with crash-retry idempotency: retrying an
 * identical creation or transition returns `unchanged` with zero writes and
 * zero signals, while a competing write at the same `expectedRevision` is
 * `revision-conflict`. A newly queued request and every state/claim/outcome
 * transition emits a `request` change signal; claim lease renewals emit
 * nothing. With `readOnly` the store never writes and never quarantines.
 */

import { promises as fs } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { containsSecretShape } from '@fleet/shared';

import { OrchestratorRequest } from '../../domain/entities/OrchestratorRequest.js';
import {
  ORCHESTRATOR_REQUEST_STATES,
  ORCHESTRATOR_REQUEST_TERMINAL_STATES,
} from '../../domain/orchestrator-request-records.js';
import type {
  OrchestratorRequestClaimRecord,
  OrchestratorRequestLinkRecord,
  OrchestratorRequestReasonRecord,
  OrchestratorRequestRecord,
  OrchestratorRequestState,
  OrchestratorRequestTargetRecord,
} from '../../domain/orchestrator-request-records.js';
import { ORCHESTRATOR_REQUEST_KINDS } from '../../domain/orchestrator-session-records.js';
import type { OrchestratorRequestKind } from '../../domain/orchestrator-session-records.js';
import type {
  GetOrchestratorRequestResult,
  ListOrchestratorRequestsResult,
  OrchestratorRequestListQuery,
  OrchestratorRequestRepositoryPort,
  SaveOrchestratorRequestOptions,
  SaveOrchestratorRequestResult,
} from '../../application/ports/out/OrchestratorRequestRepositoryPort.out-port.js';
import {
  DEFAULT_ORCHESTRATOR_REQUEST_LOCK_TIMEOUT_MS,
  MAX_ORCHESTRATOR_REQUEST_LIST_LIMIT,
  MAX_ORCHESTRATOR_REQUEST_LOCK_TIMEOUT_MS,
  MAX_ORCHESTRATOR_REQUEST_STORE_BYTES,
  MAX_ORCHESTRATOR_REQUEST_STORE_RECORDS,
  ORCHESTRATOR_REQUEST_RECORD_VERSION,
} from '../../application/ports/out/OrchestratorRequestRepositoryPort.out-port.js';
import type { ChangeSignal, ChangeSignalPort } from '../../application/ports/out/ChangeSignalPort.out-port.js';
import { NoopChangeSignalAdapter } from './NoopChangeSignalAdapter.adapter.js';
import {
  assertValidSchemaVersionPolicy,
  FileLockTimeoutError,
  inspectVersionedRecordListBytes,
  readStoreRecordSchemaVersion,
  rejectUnreadableStateFile,
  withFileLock,
  writeJsonAtomically,
  type VersionedRecordParseResult,
} from './file-store.js';

const DEFAULT_FILE_NAME = 'orchestrator-requests.json';
/** The other operator-coordination stores own their own files; never those. */
const OTHER_STORE_FILE_NAMES = [
  'project-profiles.json',
  'coordination-requests.json',
  'owner-questions.json',
  'orchestrators.json',
  'owner-items.json',
  'attention-items.json',
] as const;
/** A configured file name may not escape the state directory it belongs to. */
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;
/** A request id is a Crockford-base32 ULID: 26 upper-case characters. */
const REQUEST_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** The projectId guard mirrors OrchestratorRequest's own id-field rule. */
const ID_MAX_BYTES = 256;

export const ORCHESTRATOR_REQUEST_STORE_VERSION_POLICY = assertValidSchemaVersionPolicy(
  'orchestrator-requests.json',
  {
    writerVersion: ORCHESTRATOR_REQUEST_RECORD_VERSION,
    acceptedVersions: [1],
  },
);

export interface OrchestratorRequestRepositoryAdapterOptions {
  /** Directory for file-backed JSON persistence; in-memory only when omitted. */
  readonly stateDir?: string;
  /** Store file name; defaults to `orchestrator-requests.json`. */
  readonly fileName?: string;
  /** Emitter for post-save change signals; defaults to a no-op adapter. */
  readonly changeSignal?: ChangeSignalPort;
  /** Read-only: saves are refused and an unreadable file is never quarantined. */
  readonly readOnly?: boolean;
}

/** The stored record without its `schemaVersion` key (OrchestratorRequest.create refuses extra fields). */
function withoutSchemaVersion(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string') {
      return undefined;
    }
    if (key === 'schemaVersion') {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      return undefined;
    }
    out[key] = descriptor.value;
  }
  return out;
}

/**
 * The versioned reader's record parser, shared with `fleet-v2 state check`:
 * the `schemaVersion` check runs first, then the full `OrchestratorRequest.create`
 * body validation on the stripped record. Never throws.
 */
export function parseVersionedOrchestratorRequestStateRecord(
  raw: unknown,
): VersionedRecordParseResult<OrchestratorRequestRecord> {
  try {
    const versionCheck = readStoreRecordSchemaVersion(raw, ORCHESTRATOR_REQUEST_STORE_VERSION_POLICY);
    if (versionCheck.status !== 'ok') {
      return versionCheck;
    }
    if (typeof raw !== 'object' || raw === null) {
      return { status: 'invalid' };
    }
    const stripped = withoutSchemaVersion(raw as Record<string, unknown>);
    if (stripped === undefined) {
      return { status: 'invalid' };
    }
    const result = OrchestratorRequest.create(stripped);
    if (!result.success) {
      return { status: 'invalid' };
    }
    return { status: 'ok', record: result.value.toRecord(), schemaVersion: versionCheck.schemaVersion };
  } catch {
    return { status: 'invalid' };
  }
}

/** The reader's record parser, shared with `fleet-v2 state check`. */
export function parseOrchestratorRequestStateRecord(raw: unknown): OrchestratorRequestRecord | undefined {
  const parsed = parseVersionedOrchestratorRequestStateRecord(raw);
  return parsed.status === 'ok' ? parsed.record : undefined;
}

/** One request per requestId is a store invariant; a file breaking it is unreadable as a whole. */
export function orchestratorRequestListError(records: readonly OrchestratorRequestRecord[]): string | undefined {
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.requestId)) {
      return 'two orchestrator requests share one requestId';
    }
    seen.add(record.requestId);
  }
  return undefined;
}

/** Fresh copies: nested objects are spread so callers cannot mutate the store. */
function copy(record: OrchestratorRequestRecord): OrchestratorRequestRecord {
  return {
    ...record,
    target: { ...record.target },
    requestedBy: { ...record.requestedBy },
    claim: record.claim === null ? null : { ...record.claim },
    reason: record.reason === null ? null : { ...record.reason },
    linked: record.linked === null ? null : { ...record.linked },
  };
}

function targetsEqual(left: OrchestratorRequestTargetRecord, right: OrchestratorRequestTargetRecord): boolean {
  const leftKeys = Object.keys(left) as Array<keyof OrchestratorRequestTargetRecord>;
  const rightKeys = Object.keys(right) as Array<keyof OrchestratorRequestTargetRecord>;
  return leftKeys[0] === rightKeys[0] && left[leftKeys[0]!] === right[rightKeys[0]!];
}

function claimsEqual(
  left: OrchestratorRequestClaimRecord | null,
  right: OrchestratorRequestClaimRecord | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return (
    left.orchestratorId === right.orchestratorId &&
    left.fence === right.fence &&
    left.leaseUntilIso === right.leaseUntilIso
  );
}

function reasonsEqual(
  left: OrchestratorRequestReasonRecord | null,
  right: OrchestratorRequestReasonRecord | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.reasonKind === right.reasonKind && left.detail === right.detail;
}

function linksEqual(
  left: OrchestratorRequestLinkRecord | null,
  right: OrchestratorRequestLinkRecord | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  const leftKeys = Object.keys(left) as Array<keyof OrchestratorRequestLinkRecord>;
  const rightKeys = Object.keys(right) as Array<keyof OrchestratorRequestLinkRecord>;
  if (leftKeys.length !== rightKeys.length || leftKeys[0] !== rightKeys[0]) {
    return false;
  }
  return left[leftKeys[0]!] === right[rightKeys[0]!] && left.journalKey === right.journalKey;
}

/** Deep equality of two records; used for crash-retry idempotency. */
function recordsDeepEqual(left: OrchestratorRequestRecord, right: OrchestratorRequestRecord): boolean {
  return (
    left.requestId === right.requestId &&
    left.revision === right.revision &&
    left.kind === right.kind &&
    left.projectId === right.projectId &&
    targetsEqual(left.target, right.target) &&
    left.requestedBy.via === right.requestedBy.via &&
    left.requestedBy.sessionId === right.requestedBy.sessionId &&
    left.createdAtIso === right.createdAtIso &&
    left.expiresAtIso === right.expiresAtIso &&
    left.updatedAtIso === right.updatedAtIso &&
    left.state === right.state &&
    left.fence === right.fence &&
    left.claimCount === right.claimCount &&
    claimsEqual(left.claim, right.claim) &&
    left.deferredUntilIso === right.deferredUntilIso &&
    reasonsEqual(left.reason, right.reason) &&
    linksEqual(left.linked, right.linked)
  );
}

/** A revision-1 record is initial only in the queued, unclaimed shape. */
function isInitialRecord(record: OrchestratorRequestRecord): boolean {
  return (
    record.revision === 1 &&
    record.state === 'queued' &&
    record.claim === null &&
    record.deferredUntilIso === null &&
    record.reason === null &&
    record.linked === null &&
    record.fence === 0 &&
    record.claimCount === 0
  );
}

/**
 * A save is a lease renewal only when the claim is held by the same
 * orchestrator at the same fence with the same counters and state, so only
 * the lease horizon (and timestamps) moved. Nothing else emits nothing.
 */
function isClaimLeaseRenewal(
  before: OrchestratorRequestRecord | undefined,
  after: OrchestratorRequestRecord,
): boolean {
  if (before === undefined) {
    return false;
  }
  if (
    (before.state !== 'claimed' && before.state !== 'cancel-requested') ||
    after.state !== before.state
  ) {
    return false;
  }
  if (before.claim === null || after.claim === null) {
    return false;
  }
  if (before.claim.leaseUntilIso === after.claim.leaseUntilIso) {
    return false;
  }
  // Renewal only when nothing but the lease horizon and updatedAtIso moved (the revision bump is the save itself).
  const normalised: OrchestratorRequestRecord = {
    ...after,
    revision: before.revision,
    updatedAtIso: before.updatedAtIso,
    claim: { ...after.claim, leaseUntilIso: before.claim.leaseUntilIso },
  };
  return recordsDeepEqual(before, normalised);
}

let oversizedQuarantineCounter = 0;

/** Move an oversized store into `<dir>/quarantine/` by rename, without reading it. */
async function quarantineOversizedStore(target: string): Promise<void> {
  const dir = join(dirname(target), 'quarantine');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('.', '.');
  oversizedQuarantineCounter += 1;
  await fs.rename(target, join(dir, `${basename(target)}.${stamp}-oversized-${process.pid}-${oversizedQuarantineCounter}`));
}

/** Extract only a fixed POSIX error code; never a path or free-form message. */
function sanitizeErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code)) {
      return code;
    }
  }
  return 'IO_ERROR';
}

/** The projectId filter rule mirrors OrchestratorRequest's own id-field rule. */
function projectIdError(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    new TextEncoder().encode(value).byteLength > ID_MAX_BYTES
  ) {
    return 'invalid projectId';
  }
  if (containsSecretShape(value)) {
    return 'invalid projectId';
  }
  return null;
}

type LoadResult =
  | { readonly kind: 'loaded'; readonly records: Map<string, OrchestratorRequestRecord> }
  | { readonly kind: 'unknown-version' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'io-error'; readonly errorCode: string };

type ParsedListQuery = {
  readonly projectId?: string;
  readonly state?: OrchestratorRequestState;
  readonly states?: readonly OrchestratorRequestState[];
  readonly kind?: OrchestratorRequestKind;
  readonly limit?: number;
};

const LIST_QUERY_KEYS: readonly string[] = ['projectId', 'state', 'states', 'kind', 'limit'];

/** Plain-object check plus own data descriptors for the closed key set; null when the shape is refused. */
function readListQueryValues(query: unknown): Record<string, unknown> | null {
  if (typeof query !== 'object' || query === null || Array.isArray(query)) {
    return null;
  }
  const proto = Object.getPrototypeOf(query);
  if (proto !== Object.prototype && proto !== null) {
    return null;
  }
  const values: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(query)) {
    if (typeof key !== 'string' || !LIST_QUERY_KEYS.includes(key)) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(query, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      return null;
    }
    values[key] = descriptor.value;
  }
  return values;
}

function isListedMember(list: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && list.includes(value);
}

/** `projectId`, `state` and `kind`: each absent or valid. */
function listQueryScalarsValid(values: Record<string, unknown>): boolean {
  if (values.projectId !== undefined && projectIdError(values.projectId) !== null) {
    return false;
  }
  if (values.state !== undefined && !isListedMember(ORCHESTRATOR_REQUEST_STATES, values.state)) {
    return false;
  }
  return values.kind === undefined || isListedMember(ORCHESTRATOR_REQUEST_KINDS, values.kind);
}

/** `states`: absent, or a plain, dense, bounded array of known states read by data descriptors. */
function listQueryStatesValid(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return false;
  }
  const states = value as unknown[];
  if (states.length > ORCHESTRATOR_REQUEST_STATES.length) {
    return false;
  }
  for (let index = 0; index < states.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(states, index)) {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(states, index);
    if (descriptor === undefined || !('value' in descriptor)) {
      return false;
    }
    if (!ORCHESTRATOR_REQUEST_STATES.includes(states[index] as OrchestratorRequestState)) {
      return false;
    }
  }
  return true;
}

function listQueryLimitValid(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 1 &&
      value <= MAX_ORCHESTRATOR_REQUEST_LIST_LIMIT)
  );
}

export class OrchestratorRequestRepositoryAdapter implements OrchestratorRequestRepositoryPort {
  private readonly inMemoryRecords = new Map<string, OrchestratorRequestRecord>();
  private readonly changeSignal: ChangeSignalPort;
  private signalEmitFailuresCount = 0;

  constructor(private readonly options: OrchestratorRequestRepositoryAdapterOptions = {}) {
    this.changeSignal = OrchestratorRequestRepositoryAdapter.extractChangeSignal(options);
  }

  get signalEmitFailures(): number {
    return this.signalEmitFailuresCount;
  }

  private signal(sig: ChangeSignal): void {
    try {
      this.changeSignal.emit(sig);
    } catch {
      this.signalEmitFailuresCount += 1;
    }
  }

  private static extractChangeSignal(options: OrchestratorRequestRepositoryAdapterOptions): ChangeSignalPort {
    if (options === undefined || options === null) {
      return new NoopChangeSignalAdapter();
    }
    try {
      if (typeof options !== 'object' || Array.isArray(options)) {
        return new NoopChangeSignalAdapter();
      }
      const proto = Object.getPrototypeOf(options);
      if (proto !== Object.prototype && proto !== null) {
        return new NoopChangeSignalAdapter();
      }
      const descriptor = Object.getOwnPropertyDescriptor(options, 'changeSignal');
      if (descriptor === undefined || !('value' in descriptor)) {
        return new NoopChangeSignalAdapter();
      }
      const signal = descriptor.value;
      return signal !== undefined && signal !== null ? (signal as ChangeSignalPort) : new NoopChangeSignalAdapter();
    } catch {
      return new NoopChangeSignalAdapter();
    }
  }

  /**
   * Validate the adapter options descriptor-safely without throwing. A
   * non-plain or throwing options object, a non-string stateDir, or an
   * unsafe/colliding fileName is `invalid-config`; a blank or
   * whitespace stateDir is refused, and only an omitted stateDir is the in-memory store.
   */
  private resolveStoreConfig():
    | { readonly kind: 'memory'; readonly readOnly: boolean }
    | { readonly kind: 'file'; readonly target: string; readonly readOnly: boolean }
    | { readonly kind: 'invalid-config' } {
    try {
      const options = this.options;
      if (options === undefined || options === null) {
        return { kind: 'memory', readOnly: false };
      }
      if (typeof options !== 'object' || Array.isArray(options)) {
        return { kind: 'invalid-config' };
      }
      const proto = Object.getPrototypeOf(options);
      if (proto !== Object.prototype && proto !== null) {
        return { kind: 'invalid-config' };
      }
      const allowed = ['stateDir', 'fileName', 'changeSignal', 'readOnly'];
      const values: Record<string, unknown> = {};
      for (const key of Reflect.ownKeys(options)) {
        if (typeof key !== 'string' || !allowed.includes(key)) {
          return { kind: 'invalid-config' };
        }
        const descriptor = Object.getOwnPropertyDescriptor(options, key);
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          return { kind: 'invalid-config' };
        }
        values[key] = descriptor.value;
      }
      const stateDir = values.stateDir;
      if (stateDir === undefined) {
        return { kind: 'memory', readOnly: values.readOnly === true };
      }
      if (typeof stateDir !== 'string' || stateDir.trim().length === 0) {
        return { kind: 'invalid-config' };
      }
      const name = values.fileName === undefined ? DEFAULT_FILE_NAME : values.fileName;
      if (typeof name !== 'string') {
        return { kind: 'invalid-config' };
      }
      if ((OTHER_STORE_FILE_NAMES as readonly string[]).includes(name)) {
        return { kind: 'invalid-config' };
      }
      if (!SAFE_FILE_NAME.test(name) || name === '.' || name === '..') {
        return { kind: 'invalid-config' };
      }
      return { kind: 'file', target: join(stateDir, name), readOnly: values.readOnly === true };
    } catch {
      return { kind: 'invalid-config' };
    }
  }

  /** The per-call save options: a plain object with a closed, bounded `lockTimeoutMs`. */
  private parseSaveOptions(options?: SaveOrchestratorRequestOptions): number | null {
    try {
      if (options === undefined) {
        return DEFAULT_ORCHESTRATOR_REQUEST_LOCK_TIMEOUT_MS;
      }
      if (options === null || typeof options !== 'object' || Array.isArray(options)) {
        return null;
      }
      const proto = Object.getPrototypeOf(options);
      if (proto !== Object.prototype && proto !== null) {
        return null;
      }
      let timeout: number | null = null;
      for (const key of Reflect.ownKeys(options)) {
        if (key !== 'lockTimeoutMs') {
          return null;
        }
        const descriptor = Object.getOwnPropertyDescriptor(options, key);
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          return null;
        }
        const value = descriptor.value;
        if (
          typeof value !== 'number' ||
          !Number.isInteger(value) ||
          value < 1 ||
          value > MAX_ORCHESTRATOR_REQUEST_LOCK_TIMEOUT_MS
        ) {
          return null;
        }
        timeout = value;
      }
      return timeout ?? DEFAULT_ORCHESTRATOR_REQUEST_LOCK_TIMEOUT_MS;
    } catch {
      return null;
    }
  }

  private async safeStat(target: string): Promise<ChangeSignal['before']> {
    try {
      const stat = await fs.stat(target);
      return { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
    } catch {
      return null;
    }
  }

  /**
   * Read one store file's records without throwing: a missing file is an empty
   * store, an unreadable (or oversized or duplicate-id) file quarantines its
   * exact bytes when writable (or refuses when read-only) and reports unknown,
   * an unsupported `schemaVersion` touches nothing and reports unknown, and a
   * non-`ENOENT` read failure reports `io-error` with a sanitized code.
   */
  private async loadRecords(target: string): Promise<LoadResult> {
    let buffer: Buffer;
    try {
      const stat = await fs.stat(target);
      if (stat.size > MAX_ORCHESTRATOR_REQUEST_STORE_BYTES) {
        // Never read an oversized file into memory. Read-only: refuse. Writable: quarantine by rename, then treat as absent.
        if (this.options?.readOnly === true) {
          return { kind: 'unreadable' };
        }
        try {
          await quarantineOversizedStore(target);
        } catch {
          return { kind: 'unreadable' };
        }
        return { kind: 'loaded', records: new Map<string, OrchestratorRequestRecord>() };
      }
      buffer = await fs.readFile(target);
    } catch (error: unknown) {
      const code = sanitizeErrorCode(error);
      if (code === 'ENOENT') {
        return { kind: 'loaded', records: new Map<string, OrchestratorRequestRecord>() };
      }
      return { kind: 'io-error', errorCode: code };
    }
    const inspection = inspectVersionedRecordListBytes(
      buffer,
      parseVersionedOrchestratorRequestStateRecord,
      {
        maxBytes: MAX_ORCHESTRATOR_REQUEST_STORE_BYTES,
        maxRecords: MAX_ORCHESTRATOR_REQUEST_STORE_RECORDS,
      },
    );
    if (inspection.status === 'unknown-version') {
      return { kind: 'unknown-version' };
    }
    if (inspection.status === 'unreadable') {
      try {
        await rejectUnreadableStateFile(target, inspection.detail, buffer, this.options?.readOnly === true);
      } catch {
        // Quarantine happened or read-only refusal; report unknown.
      }
      return { kind: 'unreadable' };
    }
    const listError = orchestratorRequestListError(inspection.records);
    if (listError !== undefined) {
      try {
        await rejectUnreadableStateFile(target, listError, buffer, this.options?.readOnly === true);
      } catch {
        // Quarantine happened or read-only refusal; report unknown.
      }
      return { kind: 'unreadable' };
    }
    const map = new Map<string, OrchestratorRequestRecord>();
    for (const item of inspection.records) {
      map.set(item.requestId, item);
    }
    return { kind: 'loaded', records: map };
  }

  /**
   * The CAS, idempotency and immutability guards, shared by the memory and
   * disk paths. Idempotent crash-retry of an identical record is `unchanged`
   * (writes nothing, emits no signal); every other race or invalid write is a
   * typed refusal.
   */
  private evaluateSave(
    validated: OrchestratorRequestRecord,
    expectedRevision: number,
    records: ReadonlyMap<string, OrchestratorRequestRecord>,
  ):
    | { readonly action: 'unchanged'; readonly record: OrchestratorRequestRecord }
    | { readonly action: 'write' }
    | {
        readonly action: 'refused';
        readonly code: 'invalid-input' | 'revision-conflict' | 'immutable-field-changed' | 'terminal-state' | 'store-limit-exceeded';
        readonly currentRevision?: number;
        readonly attemptedRevision?: number;
      } {
    const existing = records.get(validated.requestId);
    if (existing !== undefined && existing.revision === validated.revision && recordsDeepEqual(existing, validated)) {
      return { action: 'unchanged', record: existing };
    }
    const storedRevision = existing === undefined ? 0 : existing.revision;
    if (storedRevision !== expectedRevision) {
      return {
        action: 'refused',
        code: 'revision-conflict',
        currentRevision: storedRevision,
        attemptedRevision: validated.revision,
      };
    }
    if (existing === undefined) {
      if (!isInitialRecord(validated)) {
        return { action: 'refused', code: 'invalid-input' };
      }
      if (records.size >= MAX_ORCHESTRATOR_REQUEST_STORE_RECORDS) {
        return { action: 'refused', code: 'store-limit-exceeded' };
      }
      return { action: 'write' };
    }
    if ((ORCHESTRATOR_REQUEST_TERMINAL_STATES as readonly string[]).includes(existing.state)) {
      return { action: 'refused', code: 'terminal-state' };
    }
    if (
      existing.kind !== validated.kind ||
      existing.projectId !== validated.projectId ||
      !targetsEqual(existing.target, validated.target) ||
      existing.requestedBy.via !== validated.requestedBy.via ||
      existing.requestedBy.sessionId !== validated.requestedBy.sessionId ||
      existing.createdAtIso !== validated.createdAtIso ||
      existing.expiresAtIso !== validated.expiresAtIso ||
      validated.claimCount < existing.claimCount ||
      validated.fence < existing.fence
    ) {
      return { action: 'refused', code: 'immutable-field-changed' };
    }
    return { action: 'write' };
  }

  private async saveInMemory(
    validated: OrchestratorRequestRecord,
    expectedRevision: number,
  ): Promise<SaveOrchestratorRequestResult> {
    const decision = this.evaluateSave(validated, expectedRevision, this.inMemoryRecords);
    if (decision.action === 'unchanged') {
      return { outcome: 'unchanged', request: copy(decision.record) };
    }
    if (decision.action === 'refused') {
      return {
        outcome: 'refused',
        code: decision.code,
        requestId: validated.requestId,
        currentRevision: decision.currentRevision,
        attemptedRevision: decision.attemptedRevision,
      };
    }
    const existing = this.inMemoryRecords.get(validated.requestId);
    this.inMemoryRecords.set(validated.requestId, copy(validated));
    if (!isClaimLeaseRenewal(existing, validated)) {
      this.signal({ kind: 'request', id: validated.requestId, stateFile: null, before: null, written: null });
    }
    return { outcome: 'saved', request: copy(validated) };
  }

  private async saveToFile(
    target: string,
    validated: OrchestratorRequestRecord,
    expectedRevision: number,
    lockTimeoutMs: number,
  ): Promise<SaveOrchestratorRequestResult> {
    const probe = await this.loadRecords(target);
    if (probe.kind !== 'loaded') {
      if (probe.kind === 'unknown-version') {
        return { outcome: 'unknown', code: 'unknown-schema-version' };
      }
      if (probe.kind === 'unreadable') {
        return { outcome: 'unknown', code: 'unreadable-store' };
      }
      return { outcome: 'unknown', code: 'io-error', errorCode: probe.errorCode };
    }

    let before: ChangeSignal['before'] = null;
    let written: ChangeSignal['written'] = null;
    let wasRenewal = false;
    let result: SaveOrchestratorRequestResult;
    try {
      result = await withFileLock<SaveOrchestratorRequestResult>(
        `${target}.lock`,
        async (): Promise<SaveOrchestratorRequestResult> => {
          before = await this.safeStat(target);
          const reload = await this.loadRecords(target);
          if (reload.kind !== 'loaded') {
            if (reload.kind === 'unknown-version') {
              return { outcome: 'unknown', code: 'unknown-schema-version' };
            }
            if (reload.kind === 'unreadable') {
              return { outcome: 'unknown', code: 'unreadable-store' };
            }
            return { outcome: 'unknown', code: 'io-error', errorCode: reload.errorCode };
          }
          const decision = this.evaluateSave(validated, expectedRevision, reload.records);
          if (decision.action === 'unchanged') {
            return { outcome: 'unchanged', request: decision.record };
          }
          if (decision.action === 'refused') {
            return {
              outcome: 'refused',
              code: decision.code,
              requestId: validated.requestId,
              currentRevision: decision.currentRevision,
              attemptedRevision: decision.attemptedRevision,
            };
          }
          const existing = reload.records.get(validated.requestId);
          wasRenewal = isClaimLeaseRenewal(existing, validated);
          reload.records.set(validated.requestId, validated);
          const payload = [...reload.records.values()]
            .sort((left, right) => left.requestId.localeCompare(right.requestId))
            .map((item) => ({
              schemaVersion: ORCHESTRATOR_REQUEST_STORE_VERSION_POLICY.writerVersion,
              ...copy(item),
            }));
          try {
            await writeJsonAtomically(target, payload);
          } catch (writeError: unknown) {
            return { outcome: 'unknown', code: 'io-error', errorCode: sanitizeErrorCode(writeError) };
          }
          written = await this.safeStat(target);
          return { outcome: 'saved', request: validated };
        },
        { timeoutMs: lockTimeoutMs },
      );
    } catch (error: unknown) {
      if (error instanceof FileLockTimeoutError) {
        return { outcome: 'refused', code: 'lock-timeout', requestId: validated.requestId };
      }
      // Any other lock-acquisition I/O failure is a sanitized unknown outcome: never thrown, never the fs error.
      return { outcome: 'unknown', code: 'io-error', errorCode: sanitizeErrorCode(error) };
    }

    if (result.outcome === 'saved' && !wasRenewal) {
      this.signal({ kind: 'request', id: validated.requestId, stateFile: resolve(target), before, written });
    }
    return result;
  }

  async save(
    record: OrchestratorRequestRecord,
    expectedRevision: number,
    options?: SaveOrchestratorRequestOptions,
  ): Promise<SaveOrchestratorRequestResult> {
    const cfg = this.resolveStoreConfig();
    if (cfg.kind === 'invalid-config') {
      return { outcome: 'refused', code: 'invalid-store-config', requestId: null };
    }
    if (cfg.readOnly) {
      return { outcome: 'refused', code: 'read-only', requestId: null };
    }
    const lockTimeoutMs = this.parseSaveOptions(options);
    if (lockTimeoutMs === null) {
      return { outcome: 'refused', code: 'invalid-input', requestId: null };
    }
    if (
      typeof expectedRevision !== 'number' ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      expectedRevision >= Number.MAX_SAFE_INTEGER
    ) {
      return { outcome: 'refused', code: 'invalid-input', requestId: null };
    }
    let validated: OrchestratorRequestRecord;
    try {
      const result = OrchestratorRequest.create(record);
      if (!result.success) {
        return { outcome: 'refused', code: 'invalid-input', requestId: null };
      }
      validated = result.value.toRecord();
    } catch {
      return { outcome: 'refused', code: 'invalid-input', requestId: null };
    }
    if (validated.revision !== expectedRevision + 1) {
      return { outcome: 'refused', code: 'invalid-input', requestId: validated.requestId };
    }
    if (cfg.kind === 'memory') {
      return this.saveInMemory(validated, expectedRevision);
    }
    return this.saveToFile(cfg.target, validated, expectedRevision, lockTimeoutMs);
  }

  async get(requestId: string): Promise<GetOrchestratorRequestResult> {
    if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
      return { outcome: 'refused', code: 'invalid-input' };
    }
    const cfg = this.resolveStoreConfig();
    if (cfg.kind === 'invalid-config') {
      return { outcome: 'refused', code: 'invalid-store-config' };
    }
    if (cfg.kind === 'memory') {
      const found = this.inMemoryRecords.get(requestId);
      return found === undefined ? { outcome: 'missing' } : { outcome: 'found', request: copy(found) };
    }
    const load = await this.loadRecords(cfg.target);
    if (load.kind !== 'loaded') {
      if (load.kind === 'unknown-version') {
        return { outcome: 'unknown', code: 'unknown-schema-version' };
      }
      if (load.kind === 'unreadable') {
        return { outcome: 'unknown', code: 'unreadable-store' };
      }
      return { outcome: 'unknown', code: 'io-error', errorCode: load.errorCode };
    }
    const found = load.records.get(requestId);
    return found === undefined ? { outcome: 'missing' } : { outcome: 'found', request: copy(found) };
  }

  /** The list query, read by own property descriptors: closed keys, no symbols, getters or sparse arrays. */
  private parseListQuery(query: OrchestratorRequestListQuery): ParsedListQuery | null {
    try {
      const values = readListQueryValues(query);
      if (values === null || !listQueryScalarsValid(values) || !listQueryStatesValid(values.states)) {
        return null;
      }
      if (!listQueryLimitValid(values.limit)) {
        return null;
      }
      return values as ParsedListQuery;
    } catch {
      return null;
    }
  }

  async list(query?: OrchestratorRequestListQuery): Promise<ListOrchestratorRequestsResult> {
    const parsed = query === undefined ? {} : this.parseListQuery(query);
    if (parsed === null) {
      return { outcome: 'refused', code: 'invalid-input' };
    }
    const cfg = this.resolveStoreConfig();
    if (cfg.kind === 'invalid-config') {
      return { outcome: 'refused', code: 'invalid-store-config' };
    }
    let records: Map<string, OrchestratorRequestRecord>;
    if (cfg.kind === 'memory') {
      records = this.inMemoryRecords;
    } else {
      const load = await this.loadRecords(cfg.target);
      if (load.kind !== 'loaded') {
        if (load.kind === 'unknown-version') {
          return { outcome: 'unknown', code: 'unknown-schema-version' };
        }
        if (load.kind === 'unreadable') {
          return { outcome: 'unknown', code: 'unreadable-store' };
        }
        return { outcome: 'unknown', code: 'io-error', errorCode: load.errorCode };
      }
      records = load.records;
    }

    let matched = [...records.values()];
    if (parsed.projectId !== undefined) {
      matched = matched.filter((record) => record.projectId === parsed.projectId);
    }
    if (parsed.state !== undefined) {
      matched = matched.filter((record) => record.state === parsed.state);
    }
    if (parsed.states !== undefined) {
      matched = matched.filter((record) => parsed.states!.includes(record.state));
    }
    if (parsed.kind !== undefined) {
      matched = matched.filter((record) => record.kind === parsed.kind);
    }
    matched.sort(
      (left, right) =>
        left.createdAtIso.localeCompare(right.createdAtIso) ||
        left.requestId.localeCompare(right.requestId),
    );
    const limit = parsed.limit ?? MAX_ORCHESTRATOR_REQUEST_LIST_LIMIT;
    const truncated = matched.length > limit;
    return { outcome: 'ok', requests: matched.slice(0, limit).map(copy), truncated };
  }
}
