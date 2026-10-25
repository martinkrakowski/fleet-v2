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
  ) {
    const disposition =
      quarantinePath !== null
        ? `its bytes were kept at ${quarantinePath}`
        : `its bytes could not be copied${
            copyError instanceof Error && copyError.message !== ''
              ? ` (${copyError.message})`
              : ''
          }`;
    super(
      `State file ${filePath} is unreadable (${detail}); ${disposition}; run 'fleet-v2 state check'`,
    );
    this.name = 'StateFileUnreadableError';
    this.filePath = filePath;
    this.quarantinePath = quarantinePath;
    this.detail = detail;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** UTC stamp in the compact yyyymmddThhmmssZ form used in quarantine names. */
function quarantineUtcStamp(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Best-effort housekeeping: keep only the 5 newest quarantine copies for a
 * basename by name order. A failure here never masks the quarantine of the
 * bad file itself.
 */
async function pruneQuarantineCopies(
  quarantineDir: string,
  basename: string,
): Promise<void> {
  try {
    const pattern = new RegExp(
      `^${escapeRegExp(basename)}\\.\\d{8}T\\d{6}Z\\.[0-9a-f]{12}$`,
    );
    const copies = (await fs.readdir(quarantineDir))
      .filter((name) => pattern.test(name))
      .sort();
    while (copies.length > 5) {
      const oldest = copies.shift();
      if (oldest !== undefined) {
        await fs.rm(path.join(quarantineDir, oldest), { force: true });
      }
    }
  } catch {
    // Never mask the original unreadable-file problem.
  }
}

/**
 * Quarantine an unreadable or invalid state file: copy its exact bytes into a
 * `<dirname>/quarantine/<basename>.<UTC stamp>.<first 12 hex of sha256>` file
 * (directory mode 0o700, copy mode 0o600, keeping the 5 newest copies per
 * basename), then throw `StateFileUnreadableError`. If the copy itself fails,
 * the error still throws with `quarantinePath: null`.
 */
export async function quarantineUnreadable(
  filePath: string,
  detail: string,
): Promise<never> {
  let quarantinePath: string | null = null;
  try {
    const bytes = await fs.readFile(filePath);
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
    const basename = path.basename(filePath);
    const quarantineDir = path.join(path.dirname(filePath), 'quarantine');
    await fs.mkdir(quarantineDir, { recursive: true, mode: 0o700 });
    await fs.chmod(quarantineDir, 0o700);
    const dest = path.join(
      quarantineDir,
      `${basename}.${quarantineUtcStamp()}.${digest}`,
    );
    await fs.copyFile(filePath, dest);
    await fs.chmod(dest, 0o600);
    quarantinePath = dest;
    await pruneQuarantineCopies(quarantineDir, basename);
  } catch (error: unknown) {
    throw new StateFileUnreadableError(filePath, null, detail, error);
  }
  throw new StateFileUnreadableError(filePath, quarantinePath, detail);
}
