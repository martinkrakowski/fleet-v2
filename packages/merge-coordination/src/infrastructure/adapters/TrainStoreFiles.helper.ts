/**
 * Shared file helpers for the merge train's per-train store: the directory
 * layout under `<stateDir>/merge-trains/<trainId>/` is `lease.json`,
 * `state.json`, `journal.jsonl` and the guard `train.lock`. These helpers
 * never echo a file's bytes, never repair or delete unreadable state, and
 * the lock never takes over or removes a lock another holder owns.
 */

import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import type { TrainLeaseRecord } from '../../application/use-cases/train-lease.js';
import { readTrainLeaseRecord } from '../../application/use-cases/train-lease.js';

const TRAIN_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_INTERVAL_MS = 25;

/** The directory of one train's store, refusing any unsafe train id. */
export function trainDirectory(stateDir: string, trainId: string): string {
  if (typeof stateDir !== 'string' || stateDir.trim().length === 0) {
    throw new Error('train store refuses an empty state directory');
  }
  if (typeof trainId !== 'string' || !TRAIN_ID_PATTERN.test(trainId) || trainId === '.' || trainId === '..') {
    throw new Error('train store refuses an unsafe train id');
  }
  return path.join(stateDir, 'merge-trains', trainId);
}

/**
 * Acquire an exclusive lock on `<dir>/train.lock` using `fs.open(path,'wx')`
 * holding a unique acquisition token. Fails closed on contention: retries
 * until the 10 s timeout, then throws `Error('train lock timeout')`. Never
 * takes over or unlinks a lock held by another process; released in
 * `finally` only if the lock file still contains this acquisition's token.
 */
export async function withTrainLock<T>(dir: string, fn: () => Promise<T> | T): Promise<T> {
  const lockPath = path.join(dir, 'train.lock');
  const startTime = Date.now();
  const token = `${process.pid}-${randomBytes(8).toString('hex')}-${Date.now()}`;

  await fs.mkdir(dir, { recursive: true });

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

      if (Date.now() - startTime >= LOCK_TIMEOUT_MS) {
        throw new Error('train lock timeout');
      }

      const elapsed = Date.now() - startTime;
      const delay = Math.min(LOCK_POLL_INTERVAL_MS, Math.max(1, LOCK_TIMEOUT_MS - elapsed));
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
 * Persist JSON data via an atomic write: a process/timestamp-unique temp
 * file first, then a rename over the target path.
 */
export async function writeJsonAtomically(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}.tmp`;
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

function isENOENT(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

/**
 * Read one JSON file, telling absence, a good read and an unreadable file
 * apart. ENOENT is absent, bad JSON is unreadable; nothing is quarantined,
 * moved or deleted and no bytes are echoed.
 */
export async function readJsonFile(path: string): Promise<
  { kind: 'absent' } | { kind: 'ok'; value: unknown } | { kind: 'unreadable' }
> {
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(path);
  } catch (error: unknown) {
    if (isENOENT(error)) {
      return { kind: 'absent' };
    }
    return { kind: 'unreadable' };
  }
  try {
    return { kind: 'ok', value: JSON.parse(buffer.toString('utf8')) };
  } catch {
    return { kind: 'unreadable' };
  }
}

/**
 * Read one train's `lease.json`: `{ version: 1, holderId, fence,
 * leaseUntilIso }`. A wrong version or a failed lease read is unreadable.
 */
export async function readLeaseFile(dir: string): Promise<
  { kind: 'ok'; lease: TrainLeaseRecord | null } | { kind: 'unreadable' }
> {
  const read = await readJsonFile(path.join(dir, 'lease.json'));
  if (read.kind === 'absent') {
    return { kind: 'ok', lease: null };
  }
  if (read.kind === 'unreadable') {
    return { kind: 'unreadable' };
  }
  const raw = read.value;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { kind: 'unreadable' };
  }
  if ((raw as { version?: unknown }).version !== 1) {
    return { kind: 'unreadable' };
  }
  const record = raw as Record<string, unknown>;
  const lease = readTrainLeaseRecord({
    holderId: record.holderId,
    fence: record.fence,
    leaseUntilIso: record.leaseUntilIso,
  });
  if (lease === null) {
    return { kind: 'unreadable' };
  }
  return { kind: 'ok', lease };
}
