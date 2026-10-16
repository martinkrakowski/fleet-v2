import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface FileLockOptions {
  /** Maximum wait time in milliseconds before timing out. Defaults to 10000ms. */
  readonly timeoutMs?: number;
  /** Stale lock threshold in milliseconds. Defaults to 60000ms. */
  readonly staleThresholdMs?: number;
}

let tempFileCounter = 0;

function parseLockTime(raw: string): number | null {
  try {
    const data = JSON.parse(raw) as { time?: unknown };
    if (typeof data?.time === "number") {
      return data.time;
    }
  } catch {
    // Not JSON
  }
  const parts = raw.trim().split(/[-:]/);
  if (parts.length >= 3) {
    const num = Number(parts[parts.length - 1]);
    if (Number.isFinite(num) && num > 0) {
      return num;
    }
  }
  return null;
}

/**
 * Acquire an exclusive lock on `lockPath` using `fs.open(path, 'wx')` holding
 * a unique acquisition token (pid + random 16 hex + time). Stale locks (>60s)
 * are safely taken over via atomic rename. The lock is released in `finally`
 * only if the lock file still contains this acquisition's token.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T> | T,
  options?: FileLockOptions,
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const pollIntervalMs = 25;
  const staleThresholdMs = options?.staleThresholdMs ?? 60_000;
  const startTime = Date.now();
  const token = `${process.pid}-${randomBytes(8).toString("hex")}-${Date.now()}`;

  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(lockPath, "wx");
      await handle.writeFile(token, "utf8");
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
        typeof error === "object" &&
        error !== null &&
        (error as { code?: string }).code === "EEXIST";

      if (!isEexist) {
        throw error;
      }

      let isStale = false;
      try {
        const stat = await fs.stat(lockPath);
        let lockTime = stat.mtimeMs;
        try {
          const raw = await fs.readFile(lockPath, "utf8");
          const parsed = parseLockTime(raw);
          if (parsed !== null) {
            lockTime = parsed;
          }
        } catch {
          // fallback to stat.mtimeMs
        }
        if (Date.now() - lockTime > staleThresholdMs) {
          isStale = true;
        }
      } catch {
        // File might have been unlinked concurrently
      }

      if (isStale) {
        const staleFile = `${lockPath}.stale.${token}`;
        let renamed = false;
        try {
          await fs.rename(lockPath, staleFile);
          renamed = true;
        } catch (renameError: unknown) {
          const isEnoent =
            typeof renameError === "object" &&
            renameError !== null &&
            (renameError as { code?: string }).code === "ENOENT";
          if (!isEnoent) {
            throw renameError;
          }
          // Failed rename (ENOENT) means someone else took over: go back to waiting.
        }

        if (renamed) {
          try {
            await fs.unlink(staleFile);
          } catch {
            // ignore
          }
          continue;
        }
      }

      if (Date.now() - startTime >= timeoutMs) {
        throw new Error(`Timeout waiting for file lock: ${lockPath}`);
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
      const current = await fs.readFile(lockPath, "utf8");
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
    await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
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
