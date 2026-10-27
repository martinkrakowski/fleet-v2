/**
 * One shared reader for every operator-coordination JSON record-list store.
 *
 * A store file must be a JSON array; the shared state-check parser validates
 * it exactly as `fleet-v2 state check` would. Unreadable bytes never become
 * readable state: the exact bytes are quarantined and a
 * StateFileUnreadableError names the reason. A missing file is known absence
 * (an empty list); any other read failure is thrown as the calling adapter's
 * "could not read" error, so a caller can always tell the two apart.
 */

import { promises as fs } from 'node:fs';

import { inspectRecordListBytes, quarantineUnreadable } from './file-store.js';

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
  parseRecord: (raw: unknown) => T | undefined,
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
  const inspection = inspectRecordListBytes(buffer, parseRecord);
  if (inspection.status === 'unreadable') {
    return quarantineUnreadable(path, inspection.detail, buffer);
  }
  return [...inspection.records];
}

/**
 * Read one `{ "revision": <n>, "<recordKey>": <record> }` store entry: a plain object with exactly those
 * two own enumerable data properties, `revision` a safe integer ≥ 1. Returns the revision and the raw
 * record value for the caller's own validator, or undefined. Never throws, never runs a getter.
 */
export function readRevisionedEntry(
  raw: unknown,
  recordKey: string,
): { readonly revision: number; readonly record: unknown } | undefined {
  try {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return undefined;
    }
    const inputPrototype = Object.getPrototypeOf(raw);
    if (inputPrototype !== Object.prototype && inputPrototype !== null) {
      return undefined;
    }
    const ownKeys = Reflect.ownKeys(raw);
    if (ownKeys.length !== 2) {
      return undefined;
    }
    const keySet = new Set(ownKeys.map((key) => String(key)));
    if (!keySet.has('revision') || !keySet.has(recordKey)) {
      return undefined;
    }
    const revisionDescriptor = Object.getOwnPropertyDescriptor(raw, 'revision');
    const recordDescriptor = Object.getOwnPropertyDescriptor(raw, recordKey);
    if (
      revisionDescriptor === undefined ||
      recordDescriptor === undefined ||
      !revisionDescriptor.enumerable ||
      !recordDescriptor.enumerable ||
      !('value' in revisionDescriptor) ||
      !('value' in recordDescriptor)
    ) {
      return undefined;
    }
    const revision = revisionDescriptor.value;
    if (
      typeof revision !== 'number' ||
      !Number.isSafeInteger(revision) ||
      revision < 1
    ) {
      return undefined;
    }
    return { revision, record: recordDescriptor.value };
  } catch {
    return undefined;
  }
}
