/**
 * One shared reader for every operator-coordination JSON record-list store.
 *
 * A store file must be a JSON array; each entry is re-validated by the
 * calling adapter's domain constructor before it is returned, in file
 * order. Unreadable bytes never become readable state: the exact bytes are
 * quarantined and a StateFileUnreadableError names the reason. A missing
 * file is known absence (an empty list); any other read failure is thrown
 * as the calling adapter's "could not read" error, so a caller can always
 * tell the two apart.
 */

import { promises as fs } from 'node:fs';

import { quarantineUnreadable } from './file-store.js';

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

export async function readRecordList<T>(
  path: string,
  adapterName: string,
  toRecord: (entry: unknown) => T,
): Promise<T[]> {
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(path);
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return [];
    }
    throw new Error(`${adapterName} could not read ${path}: ${describe(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    await quarantineUnreadable(path, 'not valid JSON', buffer);
  }
  if (!Array.isArray(parsed)) {
    await quarantineUnreadable(path, 'expects a record list', buffer);
  }
  const entries = parsed as unknown[];
  const records: T[] = [];
  let failureIndex: number | null = null;
  for (const [index, entry] of entries.entries()) {
    try {
      records.push(toRecord(entry));
    } catch {
      failureIndex = index;
      break;
    }
  }
  if (failureIndex !== null) {
    await quarantineUnreadable(
      path,
      `record ${failureIndex} failed validation`,
      buffer,
    );
  }
  return records;
}
