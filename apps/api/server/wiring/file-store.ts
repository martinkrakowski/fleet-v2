import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface FileLockOptions {
  /** Maximum wait time in milliseconds before timing out. Defaults to 10000ms. */
  readonly timeoutMs?: number;
}

let tempFileCounter = 0;

/**
 * Acquire an exclusive lock on `lockPath` using `fs.open(path, 'wx')` holding
 * pid and time. Stale locks (>60s) are removed and retried once. The lock is
 * released in `finally`.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T> | T,
  options?: FileLockOptions,
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const pollIntervalMs = 25;
  const staleThresholdMs = 60_000;
  const startTime = Date.now();

  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  let staleRetried = false;

  while (true) {
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(lockPath, "wx");
      const payload = JSON.stringify({ pid: process.pid, time: Date.now() });
      await handle.writeFile(payload, "utf8");
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

      if (!staleRetried) {
        let isStale = false;
        try {
          const stat = await fs.stat(lockPath);
          let lockTime = stat.mtimeMs;
          try {
            const raw = await fs.readFile(lockPath, "utf8");
            const data = JSON.parse(raw) as { time?: unknown };
            if (typeof data?.time === "number") {
              lockTime = data.time;
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
          staleRetried = true;
          try {
            await fs.unlink(lockPath);
          } catch {
            // ignore if already deleted
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
      await fs.unlink(lockPath);
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
