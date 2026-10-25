import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
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
}

/**
 * Error thrown when a JSON state file cannot be parsed or validated. The
 * quarantine path names the byte-exact copy kept for recovery; it is null
 * only when the copy itself failed.
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
    if (quarantinePath !== null) {
      const notesSuffix = notes.length > 0 ? `; ${notes.join('; ')}` : '';
      disposition = `its bytes were kept at ${quarantinePath}${notesSuffix}`;
    } else if (copyError instanceof Error && copyError.message !== '') {
      disposition = `its bytes could not be copied (${copyError.message})`;
    } else {
      disposition = 'its bytes could not be copied';
    }
    super(
      `State file ${filePath} is unreadable (${detail}); ${disposition}; restore it from that copy or repair it by hand; no command reads or writes this store until then`,
    );
    this.name = 'StateFileUnreadableError';
    this.filePath = filePath;
    this.quarantinePath = quarantinePath;
    this.detail = detail;
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

/**
 * Best-effort housekeeping: keep only the 5 newest quarantine copies for a
 * basename by name order, and never delete the copy just written. Every
 * candidate is tried even if an `rm` fails; returns the count of failures.
 */
async function pruneQuarantineCopies(
  quarantineDir: string,
  basename: string,
  justWrittenName: string,
  fsImpl: QuarantineFs,
): Promise<number> {
  const pattern = new RegExp(
    `^${escapeRegExp(basename)}\\.(\\d{8}T\\d{6}\\.\\d{3}Z)-(\\d+)\\.[0-9a-f]{12}(?:-dup(\\d+))?$`,
  );
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
  const others = copies.filter((name) => name !== justWrittenName);
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
export async function quarantineUnreadable(
  filePath: string,
  detail: string,
  bytes: Buffer,
  fsImpl: QuarantineFs = fs,
): Promise<never> {
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  const basename = path.basename(filePath);
  const quarantineDir = path.join(path.dirname(filePath), 'quarantine');
  const existingPattern = new RegExp(
    `^${escapeRegExp(basename)}\\.\\d{8}T\\d{6}\\.\\d{3}Z-\\d+\\.${digest}(?:-dup\\d+)?$`,
  );
  try {
    const entries = await fsImpl.readdir(quarantineDir);
    for (const name of entries) {
      if (!existingPattern.test(name)) {
        continue;
      }
      const existingPath = path.join(quarantineDir, name);
      let read: Uint8Array;
      try {
        read = await fsImpl.readFile(existingPath);
      } catch {
        continue;
      }
      if (Buffer.from(read).equals(bytes)) {
        throw new StateFileUnreadableError(filePath, existingPath, detail);
      }
    }
  } catch (error: unknown) {
    if (error instanceof StateFileUnreadableError) {
      throw error;
    }
    // Directory may not exist yet; proceed to write a new copy.
  }

  const baseName = `${basename}.${quarantineUtcStamp()}-${quarantineCounter++}.${digest}`;

  let quarantinePath: string | null = null;
  let writtenName = baseName;
  try {
    await fsImpl.mkdir(quarantineDir, { recursive: true, mode: 0o700 });
    for (let dupIndex = 0; dupIndex <= 5; dupIndex += 1) {
      const candidateName = dupIndex === 0 ? baseName : `${baseName}-dup${dupIndex}`;
      const candidatePath = path.join(quarantineDir, candidateName);
      try {
        await fsImpl.writeFile(candidatePath, bytes, { mode: 0o600, flag: 'wx' });
        quarantinePath = candidatePath;
        writtenName = candidateName;
        break;
      } catch (error: unknown) {
        const isEexist =
          typeof error === 'object' &&
          error !== null &&
          (error as { code?: string }).code === 'EEXIST';
        if (!isEexist || dupIndex === 5) {
          throw error;
        }
      }
    }
  } catch (error: unknown) {
    throw new StateFileUnreadableError(filePath, null, detail, error);
  }

  let chmodFailed = false;
  try {
    await fsImpl.chmod(quarantineDir, 0o700);
  } catch {
    chmodFailed = true;
  }
  try {
    await fsImpl.chmod(quarantinePath!, 0o600);
  } catch {
    chmodFailed = true;
  }

  const pruneFailures = await pruneQuarantineCopies(
    quarantineDir,
    basename,
    writtenName,
    fsImpl,
  );

  throw new StateFileUnreadableError(filePath, quarantinePath, detail, undefined, {
    chmodFailed,
    pruneFailures,
  });
}
