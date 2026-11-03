// Lane DT3 helper: single-record daemon file reading, version refusal and atomic write
// shared by DaemonStatusFileAdapter and DaemonPauseAdapter.
/**
 * Single-record state file reading, unknown-version refusal (never quarantined)
 * and atomic persistence with file locking.
 */

import { promises as fs } from 'node:fs';

import {
  StateFileUnknownVersionError,
  StateFileUnreadableError,
  StateFileUnreadableReadOnlyError,
  rejectUnreadableStateFile,
  withFileLock,
  writeJsonAtomically,
} from './file-store.js';

export type SingleRecordFileState<T> =
  | { readonly status: 'missing' }
  | { readonly status: 'ok'; readonly record: T }
  | { readonly status: 'unreadable' };

export type SingleRecordParseOutcome<T> =
  | { readonly ok: true; readonly record: T }
  | { readonly ok: false; readonly reason: string; readonly error: string };

function isENOENT(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

async function rejectOrSwallow(
  target: string,
  detail: string,
  buffer: Buffer,
  readOnly: boolean,
): Promise<void> {
  try {
    await rejectUnreadableStateFile(target, detail, buffer, readOnly);
  } catch (error: unknown) {
    if (
      error instanceof StateFileUnreadableError ||
      error instanceof StateFileUnreadableReadOnlyError
    ) {
      return;
    }
    throw error;
  }
}

/**
 * Read and validate a single-record state file from disk.
 *
 * If the file is missing (ENOENT), returns `{ status: 'missing' }`.
 * If invalid JSON or the parser fails with malformed, quarantines the bytes (unless readOnly)
 * and returns `{ status: 'unreadable' }`.
 * If the parser fails with 'unknown-version', throws StateFileUnknownVersionError without quarantining.
 */
export async function readSingleRecordFile<T>(
  target: string,
  parseRecord: (raw: unknown) => SingleRecordParseOutcome<T>,
  readOnly: boolean = false,
): Promise<SingleRecordFileState<T>> {
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(target);
  } catch (error: unknown) {
    if (isENOENT(error)) {
      return { status: 'missing' };
    }
    return { status: 'unreadable' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(buffer.toString('utf8'));
  } catch {
    await rejectOrSwallow(target, 'not valid JSON', buffer, readOnly);
    return { status: 'unreadable' };
  }
  const read = parseRecord(raw);
  if (!read.ok) {
    if (read.reason === 'unknown-version') {
      throw new StateFileUnknownVersionError(target, 0);
    }
    await rejectOrSwallow(target, read.error, buffer, readOnly);
    return { status: 'unreadable' };
  }
  return { status: 'ok', record: read.record };
}

/**
 * Read single-record state from either disk or the in-memory fallback.
 */
export async function readSingleRecordFileState<T extends object>(
  target: string | null,
  inMemoryRecord: T | null,
  parseRecord: (raw: unknown) => SingleRecordParseOutcome<T>,
  readOnly: boolean = false,
): Promise<SingleRecordFileState<T>> {
  if (target === null) {
    if (inMemoryRecord === null) {
      return { status: 'missing' };
    }
    return { status: 'ok', record: { ...inMemoryRecord } };
  }
  return readSingleRecordFile(target, parseRecord, readOnly);
}

/**
 * Atomically write a single record to disk under a file lock.
 */
export async function writeSingleRecordFile(
  target: string,
  record: unknown,
): Promise<void> {
  await withFileLock(`${target}.lock`, async () => {
    await writeJsonAtomically(target, record);
  });
}
