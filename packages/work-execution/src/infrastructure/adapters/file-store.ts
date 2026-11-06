import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { DaemonEventLineRead } from '../../domain/daemon-events.js';

export interface FileLockOptions {
  /** Maximum wait time in milliseconds before timing out. Defaults to 10000ms. */
  readonly timeoutMs?: number;
  /** Stale lock threshold in milliseconds (unused, retained for compatibility). */
  readonly staleThresholdMs?: number;
}

export class FileLockTimeoutError extends Error {
  readonly lockPath: string;
  readonly holderPid?: number | string;
  readonly ageMs?: number;

  constructor(lockPath: string, holderPid?: number | string, ageMs?: number) {
    const pidStr = holderPid !== undefined ? `${holderPid}` : 'unknown';
    const ageStr = ageMs !== undefined ? `${ageMs}ms` : 'unknown';
    super(
      `File lock timeout on ${lockPath}: held by pid ${pidStr} (age ${ageStr}). Remove the lock only after confirming that pid is gone.`,
    );
    this.name = 'FileLockTimeoutError';
    this.lockPath = lockPath;
    this.holderPid = holderPid;
    this.ageMs = ageMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

let tempFileCounter = 0;
let quarantineCounter = 0;

async function readLockHolderInfo(
  lockPath: string,
): Promise<{ holderPid?: number | string; ageMs?: number }> {
  try {
    const stat = await fs.stat(lockPath);
    let holderPid: number | string | undefined;
    let lockTime: number | null = null;
    try {
      const raw = await fs.readFile(lockPath, 'utf8');
      try {
        const data = JSON.parse(raw) as { pid?: unknown; time?: unknown };
        if (typeof data?.pid === 'number' || typeof data?.pid === 'string') {
          holderPid = data.pid;
        }
        if (typeof data?.time === 'number') {
          lockTime = data.time;
        }
      } catch {
        // Not JSON
      }
      if (holderPid === undefined) {
        const parts = raw.trim().split(/[-:]/);
        if (parts.length >= 1 && parts[0].length > 0) {
          const num = Number(parts[0]);
          holderPid = Number.isFinite(num) ? num : parts[0];
        }
        if (parts.length >= 3) {
          const num = Number(parts[parts.length - 1]);
          if (Number.isFinite(num) && num > 0) {
            lockTime = num;
          }
        }
      }
    } catch {
      // Reading file failed
    }
    const effectiveTime = lockTime ?? stat.mtimeMs;
    const ageMs = Math.max(0, Date.now() - effectiveTime);
    return { holderPid, ageMs };
  } catch {
    return {};
  }
}

/**
 * Acquire an exclusive lock on `lockPath` using `fs.open(path, 'wx')` holding
 * a unique acquisition token (pid + random 16 hex + time). Fails closed on
 * contention: retries until timeoutMs, then throws FileLockTimeoutError.
 * Never takes over or unlinks a lock held by another process.
 * The lock is released in `finally` only if the lock file still contains
 * this acquisition's token.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T> | T,
  options?: FileLockOptions,
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const pollIntervalMs = 25;
  const startTime = Date.now();
  const token = `${process.pid}-${randomBytes(8).toString('hex')}-${Date.now()}`;

  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(token, 'utf8');
      await handle.close();
      handle = null;
      break;
    } catch (error: unknown) {
      if (handle !== null) {
        try {
          await handle.close();
        } catch {
          // ignore
        }
        try {
          await fs.unlink(lockPath);
        } catch {
          // ignore
        }
        handle = null;
      }

      const isEexist =
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: string }).code === 'EEXIST';

      if (!isEexist) {
        throw error;
      }

      if (Date.now() - startTime >= timeoutMs) {
        const { holderPid, ageMs } = await readLockHolderInfo(lockPath);
        throw new FileLockTimeoutError(lockPath, holderPid, ageMs);
      }

      const elapsed = Date.now() - startTime;
      const delay = Math.min(pollIntervalMs, Math.max(1, timeoutMs - elapsed));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      const current = await fs.readFile(lockPath, 'utf8');
      if (current.trim() === token.trim()) {
        await fs.unlink(lockPath);
      }
    } catch {
      // ignore
    }
  }
}

/**
 * Persist JSON data via an atomic write: writes to a process/timestamp-unique
 * temp file first, then renames over the target path.
 */
export async function writeJsonAtomically(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}-${Date.now()}-${tempFileCounter++}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, filePath);
  } catch (error: unknown) {
    try {
      await fs.rm(tempPath, { force: true });
    } catch {
      // ignore
    }
    throw error;
  }
}

/**
 * Persist raw bytes via an atomic write: writes to a process/timestamp-unique
 * temp file first, then renames over the target path.
 */
export async function writeBytesAtomically(filePath: string, bytes: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}-${Date.now()}-${tempFileCounter++}.tmp`;
  try {
    await fs.writeFile(tempPath, bytes);
    await fs.rename(tempPath, filePath);
  } catch (error: unknown) {
    try {
      await fs.rm(tempPath, { force: true });
    } catch {
      // ignore
    }
    throw error;
  }
}

export interface QuarantinePostWriteNotes {
  readonly chmodFailed?: boolean;
  readonly pruneFailures?: number;
}

export interface QuarantineFs {
  mkdir(
    dirPath: string,
    options?: { recursive?: boolean; mode?: number },
  ): Promise<unknown>;
  chmod(targetPath: string, mode: number): Promise<void>;
  readFile(targetPath: string): Promise<Uint8Array>;
  writeFile(
    targetPath: string,
    data: Uint8Array,
    options?: { mode?: number; flag?: string },
  ): Promise<void>;
  readdir(dirPath: string): Promise<string[]>;
  rm(targetPath: string, options?: { force?: boolean }): Promise<void>;
  lstat?(targetPath: string): Promise<{ isFile(): boolean }>;
}

/**
 * Error thrown when a JSON state file cannot be parsed or validated. The
 * quarantine path names the byte-exact copy kept for recovery; it is null
 * only when the copy itself failed or quarantine was never attempted.
 */
export class StateFileUnreadableError extends Error {
  readonly filePath: string;
  readonly quarantinePath: string | null;
  readonly detail: string;

  constructor(
    filePath: string,
    quarantinePath: string | null,
    detail: string,
    copyError?: unknown,
    postWriteNotes?: QuarantinePostWriteNotes,
    quarantineAttempted?: boolean,
  ) {
    const notes: string[] = [];
    if (postWriteNotes?.chmodFailed === true) {
      notes.push('tightening its permissions failed');
    }
    if (
      typeof postWriteNotes?.pruneFailures === 'number' &&
      postWriteNotes.pruneFailures > 0
    ) {
      notes.push(`pruning old copies failed (${postWriteNotes.pruneFailures})`);
    }
    let disposition: string;
    let advice: string;
    if (quarantinePath !== null) {
      const notesSuffix = notes.length > 0 ? `; ${notes.join('; ')}` : '';
      disposition = `its bytes were kept at ${quarantinePath}${notesSuffix}`;
      advice = 'restore it from that copy or repair it by hand; no command reads or writes this store until then';
    } else if (quarantineAttempted === false) {
      // Quarantine was never reached (for example a lock-side refusal), so
      // claiming the bytes could not be copied and advising a manual repair
      // would mislead the operator: nothing was read to quarantine and the
      // store bytes were not modified.
      disposition =
        copyError instanceof Error && copyError.message !== ''
          ? `no quarantine was attempted (${copyError.message})`
          : 'no quarantine was attempted';
      advice = 'the store bytes were not modified; resolve the reported condition and retry';
    } else if (copyError instanceof Error && copyError.message !== '') {
      disposition = `its bytes could not be copied (${copyError.message})`;
      advice = 'restore it from that copy or repair it by hand; no command reads or writes this store until then';
    } else {
      disposition = 'its bytes could not be copied';
      advice = 'restore it from that copy or repair it by hand; no command reads or writes this store until then';
    }
    super(
      `State file ${filePath} is unreadable (${detail}); ${disposition}; ${advice}`,
    );
    this.name = 'StateFileUnreadableError';
    this.filePath = filePath;
    this.quarantinePath = quarantinePath;
    this.detail = detail;
    if (copyError !== undefined) {
      this.cause = copyError;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** UTC stamp in the compact yyyymmddThhmmss.SSSZ form used in quarantine names. */
function quarantineUtcStamp(): string {
  const now = new Date();
  const pad2 = (n: number): string => String(n).padStart(2, '0');
  const pad3 = (n: number): string => String(n).padStart(3, '0');
  return (
    `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}` +
    `T${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}` +
    `.${pad3(now.getUTCMilliseconds())}Z`
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The quarantine copy name pattern for one store basename (see `quarantineUnreadable`). */
function quarantineCopyPattern(basename: string): RegExp {
  return new RegExp(
    `^${escapeRegExp(basename)}\\.(\\d{8}T\\d{6}\\.\\d{3}Z)-(\\d+)\\.[0-9a-f]{12}(?:-dup(\\d+))?$`,
  );
}

/**
 * Best-effort housekeeping: keep only the 5 newest quarantine copies for a
 * basename by name order, and never delete the copy just written. Protected
 * names are never deleted and are kept in addition to the five. Every
 * candidate is tried even if an `rm` fails; returns the count of failures.
 */
async function pruneQuarantineCopies(
  quarantineDir: string,
  basename: string,
  justWrittenName: string,
  fsImpl: QuarantineFs,
  protectNames: readonly string[],
): Promise<number> {
  const pattern = quarantineCopyPattern(basename);
  let entries: string[];
  try {
    entries = await fsImpl.readdir(quarantineDir);
  } catch {
    return 1;
  }
  const copies = entries
    .filter((name) => pattern.test(name))
    .sort((a, b) => {
      const matchA = pattern.exec(a);
      const matchB = pattern.exec(b);
      if (matchA !== null && matchB !== null) {
        if (matchA[1] !== matchB[1]) {
          return matchA[1].localeCompare(matchB[1]);
        }
        const counterDiff = Number(matchA[2]) - Number(matchB[2]);
        if (counterDiff !== 0) {
          return counterDiff;
        }
        const dupA = matchA[3] !== undefined ? Number(matchA[3]) : 0;
        const dupB = matchB[3] !== undefined ? Number(matchB[3]) : 0;
        if (dupA !== dupB) {
          return dupA - dupB;
        }
      }
      return a.localeCompare(b);
    });
  // The copy just written is always kept, even when a clock step makes it
  // sort as the oldest; the other four kept are the newest of the rest.
  const others = copies.filter((name) => name !== justWrittenName && !protectNames.includes(name));
  const candidates = others.slice(0, Math.max(0, others.length - 4));
  let failures = 0;
  for (const oldest of candidates) {
    try {
      await fsImpl.rm(path.join(quarantineDir, oldest), { force: true });
    } catch {
      failures += 1;
    }
  }
  return failures;
}

/**
 * Quarantine an unreadable or invalid state file: write the exact `bytes` the
 * reader held into a
 * `<dirname>/quarantine/<basename>.<UTC stamp>-<n>.<first 12 hex of sha256>`
 * file (directory mode 0o700, copy mode 0o600, never overwriting an existing
 * copy, reusing a pre-existing copy only when its contents equal `bytes`, and
 * keeping the 5 newest copies per basename), then throw
 * `StateFileUnreadableError`. Only a failed write of the copy yields
 * `quarantinePath: null`; a later `chmod` or prune failure still reports the
 * written `quarantinePath`.
 */
/** Write `bytes` under the first free name: `baseName`, then `-dup1` … `-dup5` on EEXIST. */
async function writeFirstFreeCopy(
  quarantineDir: string,
  baseName: string,
  bytes: Buffer,
  fsImpl: QuarantineFs,
  dupIndex = 0,
): Promise<string> {
  const candidateName = dupIndex === 0 ? baseName : `${baseName}-dup${dupIndex}`;
  try {
    await fsImpl.writeFile(path.join(quarantineDir, candidateName), bytes, { mode: 0o600, flag: 'wx' });
    return candidateName;
  } catch (error: unknown) {
    if (errorCodeOf(error) !== 'EEXIST' || dupIndex === 5) {
      throw error;
    }
    return writeFirstFreeCopy(quarantineDir, baseName, bytes, fsImpl, dupIndex + 1);
  }
}

export interface QuarantineCopy {
  readonly quarantinePath: string;
  /** True when an existing copy with equal bytes was reused and nothing was written. */
  readonly reused: boolean;
  readonly chmodFailed: boolean;
  readonly pruneFailures: number;
}

export interface KeepQuarantineCopyOptions {
  /** Quarantine copy names that pruning must never delete. */
  readonly protectNames?: readonly string[];
}

/**
 * Keep `bytes` as a quarantine copy of `filePath` (same naming, modes,
 * reuse-on-equal-bytes and pruning as `quarantineUnreadable`). Throws the
 * underlying error only when no copy could be written.
 */
/** Whether `dirPath` does not exist, or is a directory itself and not a symlink to one. */
async function isAbsentOrRealDirectory(dirPath: string): Promise<boolean> {
  try {
    return (await fs.lstat(dirPath)).isDirectory();
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

export async function keepQuarantineCopy(
  filePath: string,
  bytes: Buffer,
  options: KeepQuarantineCopyOptions = {},
  fsImpl: QuarantineFs = fs,
): Promise<QuarantineCopy> {
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  const basename = path.basename(filePath);
  const quarantineDir = path.join(path.dirname(filePath), 'quarantine');
  const existingPattern = new RegExp(
    `^${escapeRegExp(basename)}\\.\\d{8}T\\d{6}\\.\\d{3}Z-\\d+\\.${digest}(?:-dup\\d+)?$`,
  );
  let entries: string[] = [];
  try {
    entries = await fsImpl.readdir(quarantineDir);
  } catch {
    // The directory may not exist yet; write a new copy.
  }
  const matches = await Promise.all(
    entries
      .filter((name) => existingPattern.test(name))
      .map(async (name) => {
        const existingPath = path.join(quarantineDir, name);
        try {
          if (fsImpl.lstat !== undefined && !(await fsImpl.lstat(existingPath)).isFile()) {
            return null;
          }
          return Buffer.from(await fsImpl.readFile(existingPath)).equals(bytes) ? existingPath : null;
        } catch {
          return null;
        }
      }),
  );
  const reusedPath = matches.find((match) => match !== null);
  if (typeof reusedPath === 'string') {
    return { quarantinePath: reusedPath, reused: true, chmodFailed: false, pruneFailures: 0 };
  }
  const baseName = `${basename}.${quarantineUtcStamp()}-${quarantineCounter++}.${digest}`;
  await fsImpl.mkdir(quarantineDir, { recursive: true, mode: 0o700 });
  const writtenName = await writeFirstFreeCopy(quarantineDir, baseName, bytes, fsImpl);
  const quarantinePath = path.join(quarantineDir, writtenName);
  let chmodFailed = false;
  try {
    await fsImpl.chmod(quarantineDir, 0o700);
  } catch {
    chmodFailed = true;
  }
  try {
    await fsImpl.chmod(quarantinePath, 0o600);
  } catch {
    chmodFailed = true;
  }
  const pruneFailures = await pruneQuarantineCopies(
    quarantineDir,
    basename,
    writtenName,
    fsImpl,
    options.protectNames ?? [],
  );
  return { quarantinePath, reused: false, chmodFailed, pruneFailures };
}

export async function quarantineUnreadable(
  filePath: string,
  detail: string,
  bytes: Buffer,
  fsImpl: QuarantineFs = fs,
): Promise<never> {
  let copy: QuarantineCopy;
  try {
    copy = await keepQuarantineCopy(filePath, bytes, {}, fsImpl);
  } catch (error: unknown) {
    throw new StateFileUnreadableError(filePath, null, detail, error);
  }
  if (copy.reused) {
    throw new StateFileUnreadableError(filePath, copy.quarantinePath, detail);
  }
  throw new StateFileUnreadableError(filePath, copy.quarantinePath, detail, undefined, {
    chmodFailed: copy.chmodFailed,
    pruneFailures: copy.pruneFailures,
  });
}

/**
 * Error thrown by a store opened read-only (telemetry plan §3.3) when its JSON state file cannot be
 * parsed or validated. Unlike `StateFileUnreadableError`, nothing was copied: a read-only reader never
 * writes, locks, creates or quarantines anything.
 */
export class StateFileUnreadableReadOnlyError extends Error {
  readonly filePath: string;
  readonly detail: string;

  constructor(filePath: string, detail: string) {
    super(
      `State file ${filePath} is unreadable (${detail}); this read-only read kept no copy and wrote nothing`,
    );
    this.name = 'StateFileUnreadableReadOnlyError';
    this.filePath = filePath;
    this.detail = detail;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Error thrown when a write reaches a store opened read-only. Nothing was locked, read or written. */
export class ReadOnlyStateStoreError extends Error {
  readonly storeName: string;

  constructor(storeName: string) {
    super(`${storeName} was opened read-only and refuses every write`);
    this.name = 'ReadOnlyStateStoreError';
    this.storeName = storeName;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The unreadable-file path of every store reader: a writable store quarantines the bytes exactly as
 * `quarantineUnreadable` does; a read-only store throws `StateFileUnreadableReadOnlyError` and touches
 * nothing on disk.
 */
export async function rejectUnreadableStateFile(
  filePath: string,
  detail: string,
  bytes: Buffer,
  readOnly: boolean,
  fsImpl: QuarantineFs = fs,
): Promise<never> {
  if (readOnly) {
    throw new StateFileUnreadableReadOnlyError(filePath, detail);
  }
  return quarantineUnreadable(filePath, detail, bytes, fsImpl);
}

/** Throws `ReadOnlyStateStoreError` when `readOnly`; every write method of a store calls it first. */
export function assertStoreWritable(readOnly: boolean, storeName: string): void {
  if (readOnly) {
    throw new ReadOnlyStateStoreError(storeName);
  }
}

export const UNKNOWN_SCHEMA_VERSION_REASON = 'unknown-schema-version' as const;

/**
 * Thrown when a state store holds a record whose `schemaVersion` is not
 * accepted by this reader (plan §4.5, D6). Never echoes the stored value and
 * never quarantines the file.
 */
export class StateFileUnknownVersionError extends Error {
  readonly filePath: string;
  readonly recordIndex: number;
  readonly reason = UNKNOWN_SCHEMA_VERSION_REASON;
  readonly detail: string;

  constructor(filePath: string, recordIndex: number) {
    const detail = `record ${recordIndex} has an unsupported schemaVersion (${UNKNOWN_SCHEMA_VERSION_REASON})`;
    super(
      `State file ${filePath} refused (${detail}); nothing was quarantined — upgrade fleet-v2 to a reader that accepts this schemaVersion`,
    );
    this.name = 'StateFileUnknownVersionError';
    this.filePath = filePath;
    this.recordIndex = recordIndex;
    this.detail = detail;
  }
}

/**
 * Migration rule (plan §4.5, D6):
 * - absent `schemaVersion` on disk reads as `1` forever (D6);
 * - `acceptedVersions` must include `writerVersion` (bump only together with a
 *   reader that accepts it);
 * - whenever `writerVersion > 1`, `acceptedVersions` must also include
 *   `writerVersion - 1` (a reader always accepts the previous version).
 */
export interface StoreSchemaVersionPolicy<V extends number = number> {
  readonly writerVersion: V;
  readonly acceptedVersions: readonly number[];
}

export function assertValidSchemaVersionPolicy<V extends number>(
  storeName: string,
  policy: StoreSchemaVersionPolicy<V>,
): StoreSchemaVersionPolicy<V> {
  if (!Number.isInteger(policy.writerVersion) || policy.writerVersion < 1) {
    throw new Error(`${storeName}: writerVersion must be a positive integer`);
  }
  if (!policy.acceptedVersions.includes(policy.writerVersion)) {
    throw new Error(
      `${storeName}: writer bumps schemaVersion only together with a reader that accepts it`,
    );
  }
  if (policy.writerVersion > 1 && !policy.acceptedVersions.includes(policy.writerVersion - 1)) {
    throw new Error(
      `${storeName}: reader must still accept previous schemaVersion ${policy.writerVersion - 1}`,
    );
  }
  return policy;
}

export type StoreRecordVersionCheck =
  | { readonly status: 'ok'; readonly schemaVersion: number }
  | { readonly status: 'unknown-version' }
  | { readonly status: 'invalid' };

function isPlainRecordObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function checkAcceptedVersion(
  policy: StoreSchemaVersionPolicy,
  version: unknown,
): StoreRecordVersionCheck {
  if (typeof version === 'number' && Number.isInteger(version) && policy.acceptedVersions.includes(version)) {
    return { status: 'ok', schemaVersion: version };
  }
  return { status: 'unknown-version' };
}

/**
 * Pure: inspect `raw`'s own `schemaVersion` descriptor without invoking getters.
 * Absent `schemaVersion` reads as `1` (D6). Non-objects and accessor properties
 * are `'invalid'` (corrupt); any unaccepted present `schemaVersion` is `'unknown-version'`.
 */
export function readStoreRecordSchemaVersion(
  raw: unknown,
  policy: StoreSchemaVersionPolicy,
): StoreRecordVersionCheck {
  if (!isPlainRecordObject(raw)) {
    return { status: 'invalid' };
  }
  const descriptor = Object.getOwnPropertyDescriptor(raw, 'schemaVersion');
  if (descriptor === undefined) {
    return checkAcceptedVersion(policy, 1);
  }
  if (!('value' in descriptor) || !descriptor.enumerable) {
    return { status: 'invalid' };
  }
  return checkAcceptedVersion(policy, descriptor.value);
}

export type VersionedRecordParseResult<T> =
  | { readonly status: 'ok'; readonly record: T; readonly schemaVersion: number }
  | { readonly status: 'unknown-version' }
  | { readonly status: 'invalid' };

export type VersionedRecordListInspection<T> =
  | {
      readonly status: 'ok';
      readonly records: readonly T[];
      readonly schemaVersions: readonly number[];
    }
  | {
      readonly status: 'unknown-version';
      readonly detail: string;
      readonly recordIndex: number;
    }
  | {
      readonly status: 'unreadable';
      readonly detail: string;
      readonly recordIndex: number | null;
    };

function parseVersionedElement<T>(
  raw: unknown,
  parseRecord: (raw: unknown) => VersionedRecordParseResult<T>,
): VersionedRecordParseResult<T> {
  try {
    return parseRecord(raw);
  } catch {
    return { status: 'invalid' };
  }
}

/**
 * Pure: parse `bytes` as a JSON array and inspect each element's
 * `schemaVersion` (D6). The first `'unknown-version'` element refuses the
 * whole file immediately; the first invalid element is remembered and the
 * scan continues, so an unknown version later in the list still wins.
 */
export function inspectVersionedRecordListBytes<T>(
  bytes: Buffer,
  parseRecord: (raw: unknown) => VersionedRecordParseResult<T>,
): VersionedRecordListInspection<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { status: 'unreadable', detail: 'not valid JSON', recordIndex: null };
  }
  if (!Array.isArray(parsed)) {
    return { status: 'unreadable', detail: 'expects a record list', recordIndex: null };
  }
  const records: T[] = [];
  const versionSet = new Set<number>();
  let firstInvalidIndex: number | null = null;
  for (const [index, raw] of parsed.entries()) {
    const check = parseVersionedElement(raw, parseRecord);
    if (check.status === 'unknown-version') {
      return {
        status: 'unknown-version',
        detail: `record ${index} has an unsupported schemaVersion (${UNKNOWN_SCHEMA_VERSION_REASON})`,
        recordIndex: index,
      };
    }
    if (check.status === 'invalid') {
      if (firstInvalidIndex === null) {
        firstInvalidIndex = index;
      }
      continue;
    }
    records.push(check.record);
    versionSet.add(check.schemaVersion);
  }
  if (firstInvalidIndex !== null) {
    return {
      status: 'unreadable',
      detail: `record ${firstInvalidIndex} failed validation`,
      recordIndex: firstInvalidIndex,
    };
  }
  return {
    status: 'ok',
    records,
    schemaVersions: [...versionSet].sort((left, right) => left - right),
  };
}

export interface ReadOrQuarantineVersionedStoreOptions<T> {
  readonly filePath: string;
  readonly parseRecord: (raw: unknown) => VersionedRecordParseResult<T>;
  readonly findListError?: (records: readonly T[]) => string | undefined;
  readonly readOnly?: boolean;
  /** True when the caller already holds `${filePath}.lock` (prevents re-entrant deadlock). */
  readonly lockHeld?: boolean;
  readonly lockTimeoutMs?: number;
  readonly maxBytes?: number;
  readonly fsImpl?: QuarantineFs;
}

type BoundedStoreClassified<T> =
  | { readonly kind: 'ok'; readonly records: readonly T[] }
  | { readonly kind: 'unknown-version'; readonly recordIndex: number }
  | { readonly kind: 'unquarantinable'; readonly detail: string }
  | { readonly kind: 'invalid-bytes'; readonly detail: string; readonly bytes: Buffer };

/** Pure: classify one bounded store read into the shared reader's outcomes. */
function classifyBoundedStoreRead<T>(
  read: BoundedStoreReadResult,
  parseRecord: (raw: unknown) => VersionedRecordParseResult<T>,
  findListError: ((records: readonly T[]) => string | undefined) | undefined,
  maxBytes: number,
): BoundedStoreClassified<T> {
  switch (read.status) {
    case 'missing':
      return { kind: 'ok', records: [] };
    case 'not-regular-file':
      return { kind: 'unquarantinable', detail: 'not a regular file' };
    case 'too-large':
      return { kind: 'unquarantinable', detail: `exceeds ${maxBytes} bytes` };
    case 'ok': {
      const inspection = inspectVersionedRecordListBytes(read.bytes, parseRecord);
      if (inspection.status === 'unknown-version') {
        return { kind: 'unknown-version', recordIndex: inspection.recordIndex };
      }
      if (inspection.status === 'unreadable') {
        return { kind: 'invalid-bytes', detail: inspection.detail, bytes: read.bytes };
      }
      if (findListError !== undefined) {
        const listError = findListError(inspection.records);
        if (listError !== undefined) {
          return { kind: 'invalid-bytes', detail: listError, bytes: read.bytes };
        }
      }
      return { kind: 'ok', records: inspection.records };
    }
  }
}

/**
 * The shared locked read-or-quarantine path for the versioned record-list
 * stores: read the store bounded to `maxBytes`, refuse symlinks and oversized
 * files without reading or copying them, throw `StateFileUnknownVersionError`
 * for an unsupported `schemaVersion` (never quarantined), and under the store
 * lock re-stat and re-read before quarantining the exact bytes observed under
 * the lock, leaving `filePath` in place so later reads/writes still fail
 * closed. A healthy read takes the unlocked fast path and creates no lock file.
 * A read-only store never locks, creates directories or writes quarantine
 * copies; it throws `StateFileUnreadableReadOnlyError`. Lock-side failures on
 * a corrupt read are typed refusals: a lock timeout or an unwritable state
 * directory throws `StateFileUnreadableError` (with `quarantinePath: null` and
 * the original error as cause), never a raw errno or `FileLockTimeoutError`.
 */
export async function readOrQuarantineVersionedRecordList<T>(
  options: ReadOrQuarantineVersionedStoreOptions<T>,
): Promise<readonly T[]> {
  const maxBytes = options.maxBytes ?? STORE_FILE_MAX_BYTES;
  const readOnly = options.readOnly === true;
  const lockHeld = options.lockHeld === true;
  const lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
  const fsImpl = options.fsImpl ?? fs;

  const classify = (read: BoundedStoreReadResult): BoundedStoreClassified<T> =>
    classifyBoundedStoreRead(read, options.parseRecord, options.findListError, maxBytes);

  const runUnderLock = async (): Promise<readonly T[]> => {
    const locked = classify(await readBoundedStoreBytes(options.filePath, maxBytes));
    if (locked.kind === 'ok') {
      return locked.records;
    }
    if (locked.kind === 'unknown-version') {
      throw new StateFileUnknownVersionError(options.filePath, locked.recordIndex);
    }
    if (readOnly) {
      throw new StateFileUnreadableReadOnlyError(options.filePath, locked.detail);
    }
    if (locked.kind === 'unquarantinable') {
      throw new StateFileUnreadableError(options.filePath, null, locked.detail);
    }
    if (!(await isAbsentOrRealDirectory(path.join(path.dirname(options.filePath), 'quarantine')))) {
      throw new StateFileUnreadableError(
        options.filePath,
        null,
        locked.detail,
        new Error('quarantine directory is not a real directory'),
      );
    }
    return quarantineUnreadable(options.filePath, locked.detail, locked.bytes, fsImpl);
  };

  if (lockHeld) {
    return runUnderLock();
  }

  const fast = classify(await readBoundedStoreBytes(options.filePath, maxBytes));
  if (fast.kind === 'ok') {
    return fast.records;
  }
  if (fast.kind === 'unknown-version') {
    throw new StateFileUnknownVersionError(options.filePath, fast.recordIndex);
  }
  if (readOnly) {
    throw new StateFileUnreadableReadOnlyError(options.filePath, fast.detail);
  }
  if (fast.kind === 'unquarantinable') {
    // A symlink, oversized or non-regular store is refused without reading or
    // copying it, so taking the store lock would write nothing. Refuse
    // directly instead of entering `withFileLock`.
    throw new StateFileUnreadableError(options.filePath, null, fast.detail);
  }

  const lockPath = `${options.filePath}.lock`;
  try {
    return await withFileLock(lockPath, runUnderLock, { timeoutMs: lockTimeoutMs });
  } catch (error: unknown) {
    // Lock-side failures are typed refusals, never raw errnos: a writer's
    // lock that outlives `lockTimeoutMs` and an unwritable state directory
    // (EACCES/EROFS/EPERM from `withFileLock`'s mkdir or open('wx')) both
    // surface as `StateFileUnreadableError` with the original error as cause.
    // Real I/O failures from reading the store itself (EACCES, EIO, EMFILE
    // from lstat/open/read) are NOT mapped here and propagate unchanged.
    if (error instanceof FileLockTimeoutError) {
      throw new StateFileUnreadableError(
        options.filePath,
        null,
        `timed out waiting for the store lock after ${lockTimeoutMs}ms`,
        error,
        undefined,
        false,
      );
    }
    const code = errorCodeOf(error);
    if (code === 'EACCES' || code === 'EROFS' || code === 'EPERM') {
      const failedPath =
        typeof error === 'object' && error !== null ? (error as { path?: unknown }).path : undefined;
      if (failedPath === lockPath || failedPath === path.dirname(lockPath)) {
        throw new StateFileUnreadableError(
          options.filePath,
          null,
          `the state directory is not writable (${code})`,
          error,
          undefined,
          false,
        );
      }
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// State-file inspection (E1b): the one parser every store reader and
// `fleet-v2 state check` share, so a check and a read can never disagree.
// ---------------------------------------------------------------------------

/** Outcome of parsing one JSON record-list state file's bytes. */
export type RecordListInspection<T> =
  | { readonly status: 'ok'; readonly records: readonly T[] }
  | { readonly status: 'unreadable'; readonly detail: string; readonly recordIndex: number | null };

/**
 * Pure: parse `bytes` as a JSON array and turn each element into a record
 * with `parseRecord`; `undefined` or a throw marks the element invalid. The
 * detail strings are exactly the ones the readers pass to
 * `quarantineUnreadable`.
 */
export function inspectRecordListBytes<T>(
  bytes: Buffer,
  parseRecord: (raw: unknown) => T | undefined,
): RecordListInspection<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { status: 'unreadable', detail: 'not valid JSON', recordIndex: null };
  }
  if (!Array.isArray(parsed)) {
    return { status: 'unreadable', detail: 'expects a record list', recordIndex: null };
  }
  const records: T[] = [];
  for (const [index, raw] of parsed.entries()) {
    let record: T | undefined;
    try {
      record = parseRecord(raw);
    } catch {
      record = undefined;
    }
    if (record === undefined) {
      return {
        status: 'unreadable',
        detail: `record ${index} failed validation`,
        recordIndex: index,
      };
    }
    records.push(record);
  }
  return { status: 'ok', records };
}

/** A store file's inspection without its records. */
export type StateFileInspection =
  | {
      readonly status: 'ok';
      readonly recordCount: number;
      readonly schemaVersions?: readonly number[];
      /** A fixed note for a readable store that is not fully well-formed (a projection header). */
      readonly detail?: string;
    }
  | {
      readonly status: 'unknown-version';
      readonly detail: string;
      readonly recordIndex: number;
    }
  | {
      readonly status: 'unreadable';
      readonly detail: string;
      readonly recordIndex: number | null;
    };

/** A read-only look at one file on disk. */
export type StateFileReadResult =
  | StateFileInspection
  | { readonly status: 'missing' }
  | { readonly status: 'read-error'; readonly code: string };

export interface QuarantineCopyCheck {
  readonly name: string;
  readonly path: string;
  readonly sizeBytes: number | null;
  readonly result: StateFileReadResult;
}

export interface StateFileCheck {
  readonly basename: string;
  readonly filePath: string;
  readonly result: StateFileReadResult;
  readonly quarantineCopies: readonly QuarantineCopyCheck[];
}

export type QuarantineCopyRead =
  | { readonly status: 'read'; readonly name: string; readonly path: string; readonly bytes: Buffer }
  | { readonly status: 'refused'; readonly reason: string };

export interface RestoreStateFileRequest {
  readonly stateDir: string;
  readonly candidate: Buffer;
  /** sha256 hex of the current bytes the operator was shown; null when the file was missing. */
  readonly expectedCurrentSha256: string | null;
  /** The candidate's own quarantine name, so pruning keeps it. */
  readonly protectNames?: readonly string[];
  readonly lockTimeoutMs?: number;
}

export type RestoreStateFileOutcome =
  | { readonly status: 'restored'; readonly recordCount: number; readonly previousCopyPath: string | null }
  | { readonly status: 'refused'; readonly reason: string };

export interface StateFileCompactionRequest {
  readonly stateDir: string;
  /** The ids of the records to keep; every other record in the file is removed. */
  readonly keepIds: readonly string[];
  /** sha256 hex of the file bytes the keep list was computed from; a changed file is refused. */
  readonly expectedCurrentSha256: string;
  /** The store lock's wait budget; defaults to 10 000 ms like the store's own writes. */
  readonly lockTimeoutMs?: number;
}

export type StateFileCompactionOutcome =
  | { readonly status: 'compacted'; readonly beforeCount: number; readonly afterCount: number; readonly quarantinePath: string | null }
  | { readonly status: 'unchanged'; readonly recordCount: number }
  | { readonly status: 'refused'; readonly reason: string };

/** One JSON state store a context owns, as `fleet-v2 state` sees it. */
export interface StateFileDescriptor {
  readonly basename: string;
  /** Pure: the same parse and validation the store's reader applies. */
  inspect(bytes: Buffer): StateFileInspection;
  /** True only for a quarantine copy name of this store. */
  isQuarantineCopyName(name: string): boolean;
  /** Read-only: never writes, locks, creates or quarantines anything. */
  check(stateDir: string): Promise<StateFileCheck>;
  /** Read a quarantine copy of this store: a bare name inside <stateDir>/quarantine or a path directly in it (relative paths resolve against the current directory, like any shell path); never a symlink. */
  readQuarantineCopy(stateDir: string, from: string): Promise<QuarantineCopyRead>;
  /** Under the store's lock: re-validate, compare-and-swap on the current bytes, keep them as a quarantine copy, write the candidate's exact bytes atomically. */
  restore(request: RestoreStateFileRequest): Promise<RestoreStateFileOutcome>;
  /** Compact the store: keep only the records whose id is in the request. Record-list stores only. */
  readonly compact?: (request: StateFileCompactionRequest) => Promise<StateFileCompactionOutcome>;
}

function errorCodeOf(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code;
  }
  return 'unknown';
}

async function readAndInspect(
  filePath: string,
  inspect: (bytes: Buffer) => StateFileInspection,
): Promise<StateFileReadResult> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(filePath);
  } catch (error: unknown) {
    const code = errorCodeOf(error);
    return code === 'ENOENT' ? { status: 'missing' } : { status: 'read-error', code };
  }
  return inspect(bytes);
}

async function checkQuarantineCopy(
  quarantineDir: string,
  name: string,
  inspect: (bytes: Buffer) => StateFileInspection,
): Promise<QuarantineCopyCheck> {
  const copyPath = path.join(quarantineDir, name);
  try {
    const stat = await fs.lstat(copyPath);
    if (!stat.isFile()) {
      return {
        name,
        path: copyPath,
        sizeBytes: null,
        result: { status: 'read-error', code: 'not a regular file' },
      };
    }
    return { name, path: copyPath, sizeBytes: stat.size, result: await readAndInspect(copyPath, inspect) };
  } catch (error: unknown) {
    return { name, path: copyPath, sizeBytes: null, result: { status: 'read-error', code: errorCodeOf(error) } };
  }
}

async function readQuarantineCopyFor(
  basename: string,
  pattern: RegExp,
  quarantineDir: string,
  from: string,
): Promise<QuarantineCopyRead> {
  const candidatePath = path.basename(from) === from ? path.join(quarantineDir, from) : path.resolve(from);
  const name = path.basename(candidatePath);
  if (!pattern.test(name)) {
    return { status: 'refused', reason: `${name} is not a quarantine copy of ${basename}` };
  }
  let quarantineReal: string;
  try {
    quarantineReal = await fs.realpath(quarantineDir);
  } catch {
    return { status: 'refused', reason: `${quarantineDir} does not exist` };
  }
  let parentReal: string;
  try {
    parentReal = await fs.realpath(path.dirname(candidatePath));
  } catch {
    return { status: 'refused', reason: `${path.dirname(candidatePath)} does not exist` };
  }
  if (parentReal !== quarantineReal) {
    return { status: 'refused', reason: `--from must name a file directly inside ${quarantineDir}` };
  }
  const realPath = path.join(quarantineReal, name);
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(realPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error: unknown) {
    const code = errorCodeOf(error);
    if (code === 'ELOOP') {
      return { status: 'refused', reason: `${name} is a symbolic link` };
    }
    return { status: 'refused', reason: `${name} could not be opened (${code})` };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return { status: 'refused', reason: `${name} is not a regular file` };
    }
    return { status: 'read', name, path: realPath, bytes: await handle.readFile() };
  } finally {
    await handle.close();
  }
}

async function scanQuarantineCopies(
  quarantineDir: string,
  pattern: RegExp,
  inspect: (bytes: Buffer) => StateFileInspection,
): Promise<readonly QuarantineCopyCheck[]> {
  let names: string[];
  try {
    names = await fs.readdir(quarantineDir);
  } catch {
    return [];
  }
  return Promise.all(
    names
      .filter((entry) => pattern.test(entry))
      .sort((a, b) => a.localeCompare(b))
      .map((name) => checkQuarantineCopy(quarantineDir, name, inspect)),
  );
}

function checkCurrentStoreRefusal(
  basename: string,
  current: Buffer | null,
  inspect: (bytes: Buffer) => StateFileInspection,
): { readonly refused: true; readonly reason: string } | { readonly refused: false } {
  if (current === null) {
    return { refused: false };
  }
  const currentInspection = inspect(current);
  if (currentInspection.status === 'ok') {
    return {
      refused: true,
      reason: `${basename} is readable; state restore replaces only a missing or unreadable store`,
    };
  }
  if (currentInspection.status === 'unknown-version') {
    return {
      refused: true,
      reason: `${basename} has an unsupported schemaVersion; state restore replaces only a missing or unreadable store`,
    };
  }
  return { refused: false };
}

async function restoreRecordListStore(
  basename: string,
  inspect: (bytes: Buffer) => StateFileInspection,
  request: RestoreStateFileRequest,
  relativePath: string = basename,
): Promise<RestoreStateFileOutcome> {
  const filePath = path.join(request.stateDir, relativePath);
  return withFileLock<RestoreStateFileOutcome>(
    `${filePath}.lock`,
    async () => {
      const candidateInspection = inspect(request.candidate);
      if (candidateInspection.status !== 'ok') {
        return { status: 'refused', reason: `the candidate is unreadable (${candidateInspection.detail})` };
      }
      const recordCount = candidateInspection.recordCount;
      let current: Buffer | null;
      try {
        current = await fs.readFile(filePath);
      } catch (error: unknown) {
        const code = errorCodeOf(error);
        if (code === 'ENOENT') {
          current = null;
        } else {
          return { status: 'refused', reason: `the current file could not be read (${code})` };
        }
      }
      const currentSha = current === null ? null : createHash('sha256').update(current).digest('hex');
      if (currentSha !== request.expectedCurrentSha256) {
        return { status: 'refused', reason: 'the store changed since it was inspected; run state restore again' };
      }
      const refusal = checkCurrentStoreRefusal(basename, current, inspect);
      if (refusal.refused) {
        return { status: 'refused', reason: refusal.reason };
      }
      let previousCopyPath: string | null = null;
      if (current !== null) {
        try {
          const copy = await keepQuarantineCopy(filePath, current, { protectNames: request.protectNames ?? [] });
          previousCopyPath = copy.quarantinePath;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { status: 'refused', reason: `the current bytes could not be kept (${message}); nothing was written` };
        }
      }
      await writeBytesAtomically(filePath, request.candidate);
      return { status: 'restored', recordCount, previousCopyPath };
    },
    { timeoutMs: request.lockTimeoutMs ?? 10_000 },
  );
}

/**
 * Compact a record-list store under its lock: keep exactly the records whose
 * id is in `request.keepIds`, write the compacted file beside the original,
 * verify it with the store's own `inspect`, keep the pre-compaction bytes as
 * a quarantine copy, then swap the compacted file in. A compaction that cannot
 * verify itself writes nothing and leaves the store as it found it.
 */
async function compactRecordListStore(
  inspect: (bytes: Buffer) => StateFileInspection,
  request: StateFileCompactionRequest,
  relativePath: string,
): Promise<StateFileCompactionOutcome> {
  const filePath = path.join(request.stateDir, relativePath);
  const tempPath = `${filePath}.compacted`;
  return withFileLock<StateFileCompactionOutcome>(
    `${filePath}.lock`,
    async () => {
      const removeTemp = async (): Promise<void> => {
        try {
          await fs.rm(tempPath, { force: true });
        } catch {
          // ignore
        }
      };
      try {
        let current: Buffer;
        try {
          current = await fs.readFile(filePath);
        } catch (error: unknown) {
          const code = errorCodeOf(error);
          if (code === 'ENOENT') {
            return { status: 'refused', reason: 'the store file does not exist' };
          }
          return { status: 'refused', reason: `the store file could not be read (${code})` };
        }

        const currentSha = createHash('sha256').update(current).digest('hex');
        if (currentSha !== request.expectedCurrentSha256) {
          return { status: 'refused', reason: 'the store changed since the compaction plan was computed' };
        }

        // The current store must verify with the descriptor's own `inspect`
        // before any record is dropped: a record with an unknown schema version
        // or invalid fields but a string `id` would otherwise be silently
        // deleted by excluding it from `keepIds`.
        const currentInspection = inspect(current);
        if (currentInspection.status !== 'ok') {
          return {
            status: 'refused',
            reason: `the store does not verify (${currentInspection.detail}); nothing was written`,
          };
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(current.toString('utf8'));
        } catch {
          return { status: 'refused', reason: 'the store file is not a record list' };
        }
        if (!Array.isArray(parsed)) {
          return { status: 'refused', reason: 'the store file is not a record list' };
        }

        for (const element of parsed) {
          if (
            typeof element !== 'object' ||
            element === null ||
            typeof (element as { id?: unknown }).id !== 'string' ||
            (element as { id: string }).id.length === 0
          ) {
            return { status: 'refused', reason: 'a record without an id cannot be compacted safely' };
          }
        }

        const keepIds = new Set(request.keepIds);
        const kept = parsed.filter((element) => keepIds.has((element as { id: string }).id));
        if (kept.length === parsed.length) {
          return { status: 'unchanged', recordCount: kept.length };
        }

        const compactedBytes = Buffer.from(`${JSON.stringify(kept, null, 2)}\n`, 'utf8');

        const beforeInspection = inspect(compactedBytes);
        if (beforeInspection.status !== 'ok' || beforeInspection.recordCount !== kept.length) {
          return { status: 'refused', reason: 'the compacted file did not verify; nothing was written' };
        }

        // The quarantine directory must be a real directory: a symlink planted there would receive the store's bytes.
        if (!(await isAbsentOrRealDirectory(path.join(path.dirname(filePath), 'quarantine')))) {
          return { status: 'refused', reason: 'the quarantine directory is not a real directory; nothing was written' };
        }

        let quarantinePath: string | null = null;
        try {
          const copy = await keepQuarantineCopy(filePath, current);
          quarantinePath = copy.quarantinePath;
        } catch {
          return { status: 'refused', reason: 'the pre-compaction bytes could not be kept; nothing was written' };
        }

        // A pre-existing <store>.compacted entry is removed first (rm deletes a symlink without following it), and the
        // temp file is created exclusively, so compaction never writes through a link planted in the state directory.
        await fs.rm(tempPath, { force: true });
        await fs.writeFile(tempPath, compactedBytes, { flag: 'wx' });
        await fs.rename(tempPath, filePath);

        let swapped: Buffer;
        try {
          swapped = await fs.readFile(filePath);
        } catch (error: unknown) {
          // The swap already renamed the compacted file over the store; a failed
          // verification must put the original bytes back, never leave the
          // compacted store installed.
          try {
            await writeBytesAtomically(filePath, current);
          } catch (restoreError: unknown) {
            const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
            return {
              status: 'refused',
              reason: `the compacted file could not be verified after the swap and the previous bytes could not be restored (${restoreMessage})`,
            };
          }
          await removeTemp();
          const code = errorCodeOf(error);
          return {
            status: 'refused',
            reason: `the compacted file could not be verified after the swap; the previous bytes were restored (${code})`,
          };
        }
        if (!swapped.equals(compactedBytes)) {
          await writeBytesAtomically(filePath, current);
          await removeTemp();
          return {
            status: 'refused',
            reason: 'the compacted file did not verify after the swap; the previous bytes were restored',
          };
        }

        return { status: 'compacted', beforeCount: parsed.length, afterCount: kept.length, quarantinePath };
      } catch (error: unknown) {
        await removeTemp();
        const message = error instanceof Error ? error.message : String(error);
        return { status: 'refused', reason: `the compaction failed (${message})` };
      }
    },
    { timeoutMs: request.lockTimeoutMs ?? 10_000 },
  );
}

/**
 * The descriptor plumbing shared by the single-file stores: quarantine-name
 * recognition, the read-only `check`, quarantine-copy reads and `restore`.
 * `inspect` is the pure parser the store's reader applies. `relativePath` is
 * the path under the state directory (defaults to `basename`); the quarantine
 * copy name and its directory come from the leaf file name and the file's own
 * directory, so a nested store like `daemon/status.json` quarantines beside
 * itself.
 */
function buildStateFileDescriptor(
  basename: string,
  inspect: (bytes: Buffer) => StateFileInspection,
  relativePath: string = basename,
): StateFileDescriptor {
  const pattern = quarantineCopyPattern(path.basename(relativePath));
  return {
    basename,
    inspect,
    isQuarantineCopyName: (name: string): boolean => pattern.test(name),
    check: async (stateDir: string): Promise<StateFileCheck> => {
      const filePath = path.join(stateDir, relativePath);
      const result = await readAndInspect(filePath, inspect);
      const quarantineDir = path.join(path.dirname(filePath), 'quarantine');
      const quarantineCopies = await scanQuarantineCopies(quarantineDir, pattern, inspect);
      return { basename, filePath, result, quarantineCopies };
    },
    readQuarantineCopy: (stateDir, from) =>
      readQuarantineCopyFor(
        basename,
        pattern,
        path.join(stateDir, path.dirname(relativePath), 'quarantine'),
        from,
      ),
    restore: (request) => restoreRecordListStore(basename, inspect, request, relativePath),
  };
}

/** Build the descriptor of one record-list store from the parser its reader uses.
 * `validateList`, when given, runs once over the parsed records after every
 * record parsed; a returned string marks the whole file unreadable with that
 * detail, exactly as the store's own reader would refuse it. */
export function describeRecordListStore<T>(
  basename: string,
  parseRecord: (raw: unknown) => T | undefined,
  validateList?: (records: readonly T[]) => string | undefined,
): StateFileDescriptor {
  const inspect = (bytes: Buffer): StateFileInspection => {
    const result = inspectRecordListBytes(bytes, parseRecord);
    if (result.status !== 'ok') {
      return result;
    }
    const listError = validateList === undefined ? undefined : validateList(result.records);
    return listError === undefined
      ? { status: 'ok', recordCount: result.records.length }
      : { status: 'unreadable', detail: listError, recordIndex: null };
  };
  const descriptor = buildStateFileDescriptor(basename, inspect);
  return {
    ...descriptor,
    compact: (request) => compactRecordListStore(inspect, request, basename),
  };
}

/**
 * Build the descriptor of one versioned record-list store: the `inspect`
 * runs the schema-version check first, so an unsupported `schemaVersion`
 * reports `'unknown-version'` (never quarantined) and a valid file reports
 * the observed `schemaVersions`.
 */
export function describeVersionedRecordListStore<T>(
  basename: string,
  parseRecord: (raw: unknown) => VersionedRecordParseResult<T>,
  validateList?: (records: readonly T[]) => string | undefined,
): StateFileDescriptor {
  const inspect = (bytes: Buffer): StateFileInspection => {
    const result = inspectVersionedRecordListBytes(bytes, parseRecord);
    if (result.status !== 'ok') {
      return result;
    }
    const listError = validateList === undefined ? undefined : validateList(result.records);
    return listError === undefined
      ? { status: 'ok', recordCount: result.records.length, schemaVersions: result.schemaVersions }
      : { status: 'unreadable', detail: listError, recordIndex: null };
  };
  const descriptor = buildStateFileDescriptor(basename, inspect);
  return {
    ...descriptor,
    compact: (request) => compactRecordListStore(inspect, request, basename),
  };
}

/** A record-list store's current bytes, or null when the file does not exist yet. */
export async function readStoreBytes(target: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(target);
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/** The hard cap on any single store file this package will read (8 MiB). */
export const STORE_FILE_MAX_BYTES = 8 * 1024 * 1024;

/** The outcome of one bounded store-file read: never follows a symlink, never reads past `maxBytes`. */
export type BoundedStoreReadResult =
  | { readonly status: 'missing' }
  | { readonly status: 'not-regular-file' }
  | { readonly status: 'too-large' }
  | { readonly status: 'ok'; readonly bytes: Buffer };

/**
 * Read a store file without following a symlink out of the state directory,
 * without opening or reading a non-regular file or a file already larger than
 * `maxBytes`, and without reading more than `maxBytes` bytes even when the file
 * grows while being read. A missing file is `'missing'`; a symlink (dangling
 * or not), a non-regular file or an oversized file is a distinct refused status,
 * never mistaken for "absent". Unknown read failures are rethrown, never
 * reported as `'missing'`.
 */
export async function readBoundedStoreBytes(
  target: string,
  maxBytes: number = STORE_FILE_MAX_BYTES,
): Promise<BoundedStoreReadResult> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    return { status: 'too-large' };
  }

  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error: unknown) {
    const code = errorCodeOf(error);
    if (code === 'ENOENT') {
      return { status: 'missing' };
    }
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      return { status: 'not-regular-file' };
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { status: 'not-regular-file' };
  }
  if (stat.size > maxBytes) {
    return { status: 'too-large' };
  }

  let handle: fs.FileHandle;
  try {
    handle = await fs.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error: unknown) {
    const code = errorCodeOf(error);
    if (code === 'ENOENT') {
      return { status: 'missing' };
    }
    if (code === 'ELOOP' || code === 'EMLINK' || code === 'EISDIR' || code === 'ENXIO') {
      return { status: 'not-regular-file' };
    }
    throw error;
  }

  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      return { status: 'not-regular-file' };
    }
    if (opened.size > maxBytes) {
      return { status: 'too-large' };
    }

    // Bound the bytes actually read, not just the size seen at stat time: a
    // file that grows in between is refused rather than read whole. Chunks are
    // at most 64 KiB, so a small file never pre-allocates an 8 MiB buffer.
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const remaining = Math.min(65_536, maxBytes + 1 - total);
      if (remaining <= 0) {
        break;
      }
      const chunk = Buffer.allocUnsafe(remaining);
      const { bytesRead } = await handle.read(chunk, 0, remaining, total);
      if (bytesRead === 0) {
        break;
      }
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) {
      return { status: 'too-large' };
    }
    return { status: 'ok', bytes: Buffer.concat(chunks, total) };
  } finally {
    await handle.close();
  }
}

/**
 * The records in a record-list store's bytes; a missing file (null) is an empty list. An unparsable file is
 * quarantined and `StateFileUnreadableError` is thrown, through `rejectUnreadableStateFile`.
 */
export async function parseRecordListOrQuarantine<T>(
  target: string,
  bytes: Buffer | null,
  parse: (raw: unknown) => T | undefined,
): Promise<readonly T[]> {
  if (bytes === null) {
    return [];
  }
  const inspection = inspectRecordListBytes(bytes, parse);
  if (inspection.status !== 'ok') {
    return rejectUnreadableStateFile(target, inspection.detail, bytes, false);
  }
  return [...inspection.records];
}

/** Byte equality of two store reads, where null (no file) equals only null: the compare-and-swap check. */
export function sameStoreBytes(left: Buffer | null, right: Buffer | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.equals(right);
}

// ---------------------------------------------------------------------------
// Daemon state-file kinds (lane DT3): one versioned record per file, a
// directory glob of single-record lease files, and the events.jsonl projection.
// ---------------------------------------------------------------------------

/** One record parsed from raw JSON: ok, an unsupported version, or unreadable. */
export type SingleRecordInspection<T> =
  | { readonly status: 'ok'; readonly record: T }
  | { readonly status: 'unknown-version'; readonly detail: string }
  | { readonly status: 'unreadable'; readonly detail: string };

/** A quarantine copy name of any single-file store: `<name>.<stamp>-<n>.<hash>`. */
const ANY_QUARANTINE_COPY_PATTERN =
  /^[^/]+\.\d{8}T\d{6}\.\d{3}Z-\d+\.[0-9a-f]{12}(?:-dup\d+)?$/;

const SINGLE_RECORD_NOT_JSON = 'not valid JSON';
const SINGLE_RECORD_ARRAY = 'expects a single record';
const JSONL_PROJECTION_HEADER_DETAIL = 'projection header missing or malformed';

/** The single-record inspect shared by the single-file and glob descriptors. */
function inspectSingleRecordBytes<T>(
  bytes: Buffer,
  inspectRecord: (raw: unknown) => SingleRecordInspection<T>,
): StateFileInspection {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { status: 'unreadable', detail: SINGLE_RECORD_NOT_JSON, recordIndex: null };
  }
  if (Array.isArray(raw)) {
    return { status: 'unreadable', detail: SINGLE_RECORD_ARRAY, recordIndex: null };
  }
  const inspected = inspectRecord(raw);
  if (inspected.status === 'ok') {
    return { status: 'ok', recordCount: 1 };
  }
  if (inspected.status === 'unknown-version') {
    return { status: 'unknown-version', detail: inspected.detail, recordIndex: 0 };
  }
  return { status: 'unreadable', detail: inspected.detail, recordIndex: 0 };
}

/**
 * Build the descriptor of one single-record store: the file holds exactly one
 * versioned record, and the store's own reader decides whether it is ok, an
 * unsupported version (reported as `'unknown-version'`, never quarantined) or
 * unreadable. A JSON array, or any other shape the parser refuses, is
 * unreadable.
 */
export function describeSingleRecordStore<T>(
  basename: string,
  inspectRecord: (raw: unknown) => SingleRecordInspection<T>,
): StateFileDescriptor {
  const inspect = (bytes: Buffer): StateFileInspection => inspectSingleRecordBytes(bytes, inspectRecord);
  return buildStateFileDescriptor(basename, inspect);
}

/** The `*.json` lease files under the glob directory, one nesting level deep. */
async function collectLeaseFiles(dirPath: string, entries: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  for (const entry of [...entries].sort((a, b) => a.localeCompare(b))) {
    if (entry === 'quarantine') {
      continue;
    }
    if (entry.endsWith('.json')) {
      files.push(entry);
      continue;
    }
    let inner: string[];
    try {
      inner = await fs.readdir(path.join(dirPath, entry));
    } catch {
      continue;
    }
    for (const name of inner.sort((a, b) => a.localeCompare(b))) {
      if (name.endsWith('.json')) {
        files.push(path.join(entry, name));
      }
    }
  }
  return files;
}

/** Quarantine directories for lease files: the top-level and each file's / subdirectory's quarantine dir. */
async function collectGlobQuarantineDirs(
  dirPath: string,
  files: readonly string[],
  entries: readonly string[],
): Promise<readonly string[]> {
  const dirs = new Set<string>();
  dirs.add(path.join(dirPath, 'quarantine'));
  for (const relative of files) {
    dirs.add(path.join(path.dirname(path.join(dirPath, relative)), 'quarantine'));
  }
  for (const entry of entries) {
    if (entry !== 'quarantine' && !entry.endsWith('.json')) {
      dirs.add(path.join(dirPath, entry, 'quarantine'));
    }
  }
  return [...dirs].sort((a, b) => a.localeCompare(b));
}

/** Scan quarantine copies across multiple quarantine directories. */
async function scanAllQuarantineCopies(
  quarantineDirs: readonly string[],
  pattern: RegExp,
  inspect: (bytes: Buffer) => StateFileInspection,
): Promise<readonly QuarantineCopyCheck[]> {
  const results: QuarantineCopyCheck[] = [];
  for (const dir of quarantineDirs) {
    const copies = await scanQuarantineCopies(dir, pattern, inspect);
    results.push(...copies);
  }
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve the quarantine directory containing `from` for a directory glob store. */
async function resolveGlobQuarantineDir(
  dirPath: string,
  from: string,
): Promise<string> {
  const defaultDir = path.join(dirPath, 'quarantine');
  if (path.basename(from) !== from) {
    return defaultDir;
  }
  try {
    await fs.lstat(path.join(defaultDir, from));
    return defaultDir;
  } catch {
    // not in defaultDir
  }
  let entries: string[];
  try {
    entries = await fs.readdir(dirPath);
  } catch {
    return defaultDir;
  }
  for (const entry of entries) {
    if (entry === 'quarantine' || entry.endsWith('.json')) {
      continue;
    }
    const candidateDir = path.join(dirPath, entry, 'quarantine');
    try {
      await fs.lstat(path.join(candidateDir, from));
      return candidateDir;
    } catch {
      // not in candidateDir
    }
  }
  return defaultDir;
}

/**
 * Build the descriptor of the lease glob store (`daemon/leases`): `check`
 * enumerates every `*.json` lease file (one nesting level; scopes carry at
 * most one `/`), inspects each as a single record and aggregates: missing when
 * the directory is absent, unreadable naming the first failing file, else ok
 * with the total record count. A directory glob has no single current file to
 * compare-and-swap, so `restore` refuses with a fixed reason.
 */
export function describeRecordGlob<T>(
  dirRelative: string,
  inspectRecord: (raw: unknown) => SingleRecordInspection<T>,
): StateFileDescriptor {
  const singleInspect = (bytes: Buffer): StateFileInspection =>
    inspectSingleRecordBytes(bytes, inspectRecord);
  const pattern = ANY_QUARANTINE_COPY_PATTERN;
  return {
    basename: dirRelative,
    inspect: singleInspect,
    isQuarantineCopyName: (name: string): boolean => pattern.test(name),
    check: async (stateDir: string): Promise<StateFileCheck> => {
      const dirPath = path.join(stateDir, dirRelative);
      let entries: string[];
      try {
        entries = await fs.readdir(dirPath);
      } catch (error: unknown) {
        const code = errorCodeOf(error);
        if (code === 'ENOENT') {
          return { basename: dirRelative, filePath: dirPath, result: { status: 'missing' }, quarantineCopies: [] };
        }
        return { basename: dirRelative, filePath: dirPath, result: { status: 'read-error', code }, quarantineCopies: [] };
      }
      const files = await collectLeaseFiles(dirPath, entries);
      let total = 0;
      let checkResult: StateFileCheck['result'] | null = null;
      for (const relative of files) {
        const filePath = path.join(dirPath, relative);
        const result = await readAndInspect(filePath, singleInspect);
        if (result.status === 'ok') {
          total += result.recordCount;
        } else if (result.status === 'unknown-version' || result.status === 'unreadable') {
          checkResult = { ...result, detail: `${relative}: ${result.detail}` };
          break;
        } else if (result.status === 'read-error') {
          checkResult = { status: 'unreadable', detail: `${relative}: cannot read (${result.code})`, recordIndex: null };
          break;
        }
      }
      const finalResult: StateFileCheck['result'] = checkResult ?? { status: 'ok', recordCount: total };
      const qDirs = await collectGlobQuarantineDirs(dirPath, files, entries);
      const quarantineCopies = await scanAllQuarantineCopies(qDirs, pattern, singleInspect);
      return { basename: dirRelative, filePath: dirPath, result: finalResult, quarantineCopies };
    },
    readQuarantineCopy: async (stateDir, from) => {
      const dirPath = path.join(stateDir, dirRelative);
      const qDir = await resolveGlobQuarantineDir(dirPath, from);
      return readQuarantineCopyFor(dirRelative, pattern, qDir, from);
    },
    restore: async (_request) => ({
      status: 'refused',
      reason: `${dirRelative} is a directory store; restore a single lease file, not the directory`,
    }),
  };
}

/**
 * Build the descriptor of the events.jsonl projection: `inspect` reads the
 * header line and every following line with the store's reader. It never
 * reports `'unreadable'`: it reports `ok` with the count of valid event records,
 * and when even the header is missing or malformed it reports `ok` with count
 * 0 and a fixed detail string (no supplied value echoed).
 */
export function describeJsonlProjection(
  basename: string,
  readLine: (line: string) => DaemonEventLineRead,
): StateFileDescriptor {
  const inspect = (bytes: Buffer): StateFileInspection => {
    const lines = bytes
      .toString('utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
      return { status: 'ok', recordCount: 0, detail: JSONL_PROJECTION_HEADER_DETAIL };
    }
    const header = readLine(lines[0]!);
    if (!header.ok || header.lineKind !== 'header') {
      return { status: 'ok', recordCount: 0, detail: JSONL_PROJECTION_HEADER_DETAIL };
    }
    let count = 0;
    for (let index = 1; index < lines.length; index += 1) {
      const read = readLine(lines[index]!);
      if (read.ok && read.lineKind === 'event') {
        count += 1;
      }
    }
    return { status: 'ok', recordCount: count };
  };
  return buildStateFileDescriptor(basename, inspect);
}
