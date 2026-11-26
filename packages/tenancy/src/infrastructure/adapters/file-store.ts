import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import * as path from 'node:path';

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
    redactPaths?: boolean,
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
        redactPaths !== true && copyError instanceof Error && copyError.message !== ''
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
    // A lock-side refusal (`redactPaths`) names no path: the original error,
    // whose message may carry the lock path, stays in `cause` only.
    super(
      `State file${redactPaths === true ? '' : ` ${filePath}`} is unreadable (${detail}); ${disposition}; ${advice}`,
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
      throw new StateFileUnreadableError(options.filePath, null, locked.detail, undefined, undefined, false);
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
    throw new StateFileUnreadableError(options.filePath, null, fast.detail, undefined, undefined, false);
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
        true,
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
          true,
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

/** Byte equality of two store reads, where null (no file) equals only null: the compare-and-swap check. */
export function sameStoreBytes(left: Buffer | null, right: Buffer | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.equals(right);
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

