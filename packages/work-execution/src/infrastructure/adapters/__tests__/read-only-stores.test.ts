import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AttemptRecord } from '../../../domain/execution-records.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import { AttemptRepositoryAdapter } from '../AttemptRepositoryAdapter.adapter.js';
import { LaneRunJournalAdapter } from '../LaneRunJournalAdapter.adapter.js';
import { LaneRunRepositoryAdapter } from '../LaneRunRepositoryAdapter.adapter.js';
import {
  ReadOnlyStateStoreError,
  StateFileUnreadableError,
  StateFileUnreadableReadOnlyError,
} from '../file-store.js';

const NOW = '2026-10-27T10:00:00.000Z';
const IN_2_MIN = '2026-10-27T10:02:00.000Z';
const RUN_ID = 'run-01JB0000000000000000000000';

/** K1-1's VALID run record; overrides are spread last so tests can tweak one field. */
function validRun(overrides: Partial<LaneRunRecord> = {}): LaneRunRecord {
  return {
    version: 1,
    runId: RUN_ID,
    workOrderId: 'wo-example-1',
    tier: 2,
    seatPlanRef: 'a'.repeat(64),
    cursors: { 'first-pass': 0, fix: null, review: null },
    round: 0,
    attemptIds: ['attempt-example-1'],
    prNumber: null,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 1,
    runPolicyRevision: 'policy-example-1',
    ...overrides,
  };
}

const ACQUIRE = { holderId: 'driver-example-1', observedFence: 0, leaseUntilIso: IN_2_MIN, nowIso: NOW };
const RENEW = { holderId: 'driver-example-1', fence: 1, leaseUntilIso: IN_2_MIN, nowIso: NOW };
const HOLD = { holderId: 'driver-example-1', fence: 1, nowIso: NOW };

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

async function entryOf(dir: string, name: string): Promise<[string, string]> {
  const full = path.join(dir, name);
  const stat = await fs.lstat(full);
  if (stat.isFile()) {
    const digest = createHash('sha256').update(await fs.readFile(full)).digest('hex');
    return [name, digest];
  }
  return [name + '/', 'dir'];
}

/** Every file under dir (recursive) with its sha256: the whole on-disk state. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const names = await fs.readdir(dir, { recursive: true });
  const entries = await Promise.all(names.map((name) => entryOf(dir, name)));
  return Object.fromEntries(entries.sort((a, b) => a[0].localeCompare(b[0])));
}

interface ReadOnlyStoreCase {
  readonly name: string;
  readonly file: string;
  readonly open: (stateDir: string | undefined, readOnly: boolean) => unknown;
  readonly read: (store: unknown) => Promise<unknown>;
  readonly write: (store: unknown) => Promise<unknown>;
}

const STORES: ReadOnlyStoreCase[] = [
  {
    name: 'AttemptRepositoryAdapter',
    file: 'attempts.json',
    open: (stateDir, readOnly) => new AttemptRepositoryAdapter({ stateDir, readOnly }),
    read: (store) => (store as AttemptRepositoryAdapter).listAllAttempts(),
    write: (store) =>
      (store as AttemptRepositoryAdapter).saveAttempt({
        id: 'attempt-example-1',
        workOrderId: 'wo-example-1',
      } as unknown as AttemptRecord),
  },
  {
    name: 'LaneRunJournalAdapter',
    file: 'run-journal.json',
    open: (stateDir, readOnly) => new LaneRunJournalAdapter({ stateDir, readOnly }),
    read: (store) => (store as LaneRunJournalAdapter).listForRun(RUN_ID),
    write: (store) => (store as LaneRunJournalAdapter).append({} as unknown as LaneRunJournalEntryRecord),
  },
  {
    name: 'LaneRunRepositoryAdapter',
    file: 'lane-runs.json',
    open: (stateDir, readOnly) => new LaneRunRepositoryAdapter({ stateDir, readOnly }),
    read: (store) => (store as LaneRunRepositoryAdapter).list(),
    write: (store) => (store as LaneRunRepositoryAdapter).create(validRun()),
  },
];

describe.each(STORES)('read-only store: $name', ({ name, file, open, read, write }) => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-readonly-stores-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  const stateFilePath = () => path.join(tempDir, file);

  it('rejects an unreadable file with StateFileUnreadableReadOnlyError and writes nothing', async () => {
    await fs.writeFile(stateFilePath(), '{not json CANARY-bytes', 'utf8');
    const before = await snapshot(tempDir);
    const adapter = open(tempDir, true);

    const error = await captureRejection(read(adapter));
    expect(error).toBeInstanceOf(StateFileUnreadableReadOnlyError);
    expect(error).not.toBeInstanceOf(StateFileUnreadableError);
    expect(error).toMatchObject({ filePath: stateFilePath(), detail: 'not valid JSON' });
    expect((error as Error).message).not.toContain('CANARY');

    const after = await snapshot(tempDir);
    expect(after).toEqual(before);
  });

  it('rejects an invalid record with StateFileUnreadableReadOnlyError and writes nothing', async () => {
    await fs.writeFile(stateFilePath(), '[{"x": 1}]', 'utf8');
    const before = await snapshot(tempDir);
    const adapter = open(tempDir, true);

    const error = await captureRejection(read(adapter));
    expect(error).toBeInstanceOf(StateFileUnreadableReadOnlyError);
    expect(error).toMatchObject({ filePath: stateFilePath(), detail: 'record 0 failed validation' });

    const after = await snapshot(tempDir);
    expect(after).toEqual(before);
  });

  it('reads a readable file as empty and writes nothing', async () => {
    await fs.writeFile(stateFilePath(), '[]', 'utf8');
    const before = await snapshot(tempDir);
    const adapter = open(tempDir, true);

    await expect(read(adapter)).resolves.toEqual([]);

    const after = await snapshot(tempDir);
    expect(after).toEqual(before);
  });

  it('reads a missing file as empty and writes nothing', async () => {
    const before = await snapshot(tempDir);
    const adapter = open(tempDir, true);

    await expect(read(adapter)).resolves.toEqual([]);

    const after = await snapshot(tempDir);
    expect(after).toEqual(before);
  });

  it('refuses every write on a read-only store and leaves the directory empty', async () => {
    const fileAdapter = open(tempDir, true);
    const error = await captureRejection(write(fileAdapter));
    expect(error).toBeInstanceOf(ReadOnlyStateStoreError);
    expect((error as Error).message).toBe(`${name} was opened read-only and refuses every write`);
    expect(await snapshot(tempDir)).toEqual({});

    const inMemoryAdapter = open(undefined, true);
    const inMemoryError = await captureRejection(write(inMemoryAdapter));
    expect(inMemoryError).toBeInstanceOf(ReadOnlyStateStoreError);
    expect((inMemoryError as Error).message).toBe(`${name} was opened read-only and refuses every write`);
  });

  it('without the read-only option still quarantines an unreadable file', async () => {
    await fs.writeFile(stateFilePath(), '{not json CANARY-bytes', 'utf8');
    const adapter = open(tempDir, false);

    const error = await captureRejection(read(adapter));
    expect(error).toBeInstanceOf(StateFileUnreadableError);
    expect((error as StateFileUnreadableError).quarantinePath).not.toBeNull();

    const quarantineDir = path.join(tempDir, 'quarantine');
    expect(await fs.readdir(quarantineDir)).toHaveLength(1);
  });
});

describe('LaneRunRepositoryAdapter read-only lease operations', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-readonly-lease-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('refuses save and every lease write and leaves the directory unchanged', async () => {
    const file = path.join(tempDir, 'lane-runs.json');
    const bytes = Buffer.from(JSON.stringify([validRun()]));
    await fs.writeFile(file, bytes);
    const before = await snapshot(tempDir);
    const adapter = new LaneRunRepositoryAdapter({ stateDir: tempDir, readOnly: true });

    await expect(adapter.save(validRun(), HOLD)).rejects.toBeInstanceOf(ReadOnlyStateStoreError);

    await expect(adapter.acquireLease(RUN_ID, ACQUIRE)).rejects.toBeInstanceOf(ReadOnlyStateStoreError);
    await expect(adapter.renewLease(RUN_ID, RENEW)).rejects.toBeInstanceOf(ReadOnlyStateStoreError);
    await expect(adapter.releaseLease(RUN_ID, HOLD)).rejects.toBeInstanceOf(ReadOnlyStateStoreError);

    expect(await snapshot(tempDir)).toEqual(before);
  });
});
