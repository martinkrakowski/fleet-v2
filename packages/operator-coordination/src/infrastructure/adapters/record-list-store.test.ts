import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StateFileUnreadableError } from './file-store.js';
import { readRecordList } from './record-list-store.js';

interface TestRecord {
  readonly id: string;
}

/** Validate the way a domain entity would: an id must be a non-empty string. */
function toTestRecord(entry: unknown): TestRecord {
  if (typeof entry !== 'object' || entry === null) {
    throw new Error('record is not an object');
  }
  const id = (entry as { id?: unknown }).id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('record id must be a non-empty string');
  }
  return { id };
}

describe('readRecordList', () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-record-list-store-test-'));
    storePath = path.join(tempDir, 'records.json');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns an empty list when the file does not exist', async () => {
    const records = await readRecordList(storePath, 'TestAdapter', toTestRecord);
    expect(records).toEqual([]);
  });

  it('throws the could-not-read error for a directory and writes no quarantine copy', async () => {
    // Reading a directory as a file fails with EISDIR before any quarantine.
    await fs.mkdir(storePath);
    let caught: unknown;
    try {
      await readRecordList(storePath, 'TestAdapter', toTestRecord);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(StateFileUnreadableError);
    expect((caught as Error).message).toContain('TestAdapter could not read ');
    expect((caught as Error).message).toContain('EISDIR');
    const entries = await fs.readdir(tempDir);
    expect(entries).toEqual(['records.json']);
  });

  it('returns the converted records in file order', async () => {
    const bytes = Buffer.from(
      JSON.stringify([{ id: 'first' }, { id: 'second' }, { id: 'third' }]),
      'utf8',
    );
    await fs.writeFile(storePath, bytes);
    const records = await readRecordList(storePath, 'TestAdapter', toTestRecord);
    expect(records).toEqual([{ id: 'first' }, { id: 'second' }, { id: 'third' }]);
  });

  it('quarantines on the first invalid record without converting a later entry', async () => {
    const bytes = Buffer.from(
      JSON.stringify([{ id: 'first' }, { id: '' }, { id: 'third' }]),
      'utf8',
    );
    await fs.writeFile(storePath, bytes);
    const seen: unknown[] = [];
    let caught: unknown;
    try {
      await readRecordList(storePath, 'TestAdapter', (entry: unknown): TestRecord => {
        seen.push(entry);
        return toTestRecord(entry);
      });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StateFileUnreadableError);
    expect((caught as StateFileUnreadableError).detail).toBe('record 1 failed validation');
    expect(seen).toEqual([{ id: 'first' }, { id: '' }]);
    const copies = await fs.readdir(path.join(tempDir, 'quarantine'));
    expect(copies).toHaveLength(1);
  });
});
