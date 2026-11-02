// Shared helper for single-record state stores (killall halt marker and train pause).
/**
 * Encapsulates the shared persistence pattern for single-record state files:
 * reading record lists from disk with missing-file (ENOENT) handling, quarantining
 * unreadable files, handling read-only mode, and mutating the record atomically
 * under a file lock.
 */

import { promises as fs } from 'node:fs';

import {
  StateFileUnreadableError,
  StateFileUnreadableReadOnlyError,
  inspectRecordListBytes,
  rejectUnreadableStateFile,
  withFileLock,
  writeJsonAtomically,
} from './file-store.js';

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

async function readFileIfExists(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath);
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Reads a single-record state file list from disk. Returns an empty array if
 * the file does not exist. If the file content is unreadable or malformed,
 * quarantines the bytes (unless readOnly is set) and throws StateFileUnreadableError
 * or StateFileUnreadableReadOnlyError.
 */
export async function readSingleRecordList<T>(
  target: string,
  parseRecord: (raw: unknown) => T | undefined,
  readOnly: boolean = false,
): Promise<readonly T[]> {
  const buffer = await readFileIfExists(target);
  if (buffer === null) {
    return [];
  }
  const inspection = inspectRecordListBytes(buffer, parseRecord);
  if (inspection.status === 'unreadable') {
    return rejectUnreadableStateFile(target, inspection.detail, buffer, readOnly);
  }
  return inspection.records;
}

export type SingleRecordReadOutcome<T> =
  | { readonly unreadable: false; readonly record: T | null }
  | { readonly unreadable: true };

/**
 * Reads the latest record from a single-record state file. Handles unreadable
 * errors by returning `{ unreadable: true }`.
 */
export async function readCurrentSingleRecord<T>(
  target: string,
  parseRecord: (raw: unknown) => T | undefined,
  readOnly: boolean = false,
): Promise<SingleRecordReadOutcome<T>> {
  try {
    const records = await readSingleRecordList(target, parseRecord, readOnly);
    return {
      unreadable: false,
      record: records.length > 0 ? records[records.length - 1] : null,
    };
  } catch (error: unknown) {
    if (
      error instanceof StateFileUnreadableError ||
      error instanceof StateFileUnreadableReadOnlyError
    ) {
      return { unreadable: true };
    }
    throw error;
  }
}

export interface MutateSingleRecordOptions<T, Reason extends string> {
  readonly target: string;
  readonly parseRecord: (raw: unknown) => T | undefined;
  readonly isActivating: boolean;
  readonly unreadableReason: Reason;
  readonly isUnchanged: (current: T) => boolean;
  readonly record: T;
  readonly readOnly?: boolean;
}

export type MutateSingleRecordResult<T, Reason extends string> =
  | { readonly outcome: 'changed' | 'unchanged'; readonly record: T }
  | { readonly outcome: 'refused'; readonly reason: Reason };

/**
 * Mutates a single-record state file under the store's lock. An unreadable
 * file is quarantined by the read; activating over it proceeds with writing,
 * while clearing/lifting over it refuses with the given unreadable reason.
 */
export async function mutateSingleRecordOnDisk<T, Reason extends string>(
  options: MutateSingleRecordOptions<T, Reason>,
): Promise<MutateSingleRecordResult<T, Reason>> {
  const {
    target,
    parseRecord,
    isActivating,
    unreadableReason,
    isUnchanged,
    record,
    readOnly = false,
  } = options;
  return withFileLock(`${target}.lock`, async () => {
    let current: T | null;
    try {
      const records = await readSingleRecordList(target, parseRecord, readOnly);
      current = records.length > 0 ? records[records.length - 1] : null;
    } catch (error: unknown) {
      if (!(error instanceof StateFileUnreadableError)) {
        throw error;
      }
      if (!isActivating) {
        return { outcome: 'refused', reason: unreadableReason };
      }
      current = null;
    }
    if (current !== null && isUnchanged(current)) {
      return { outcome: 'unchanged', record: current };
    }
    await writeJsonAtomically(target, [record]);
    return { outcome: 'changed', record };
  });
}
