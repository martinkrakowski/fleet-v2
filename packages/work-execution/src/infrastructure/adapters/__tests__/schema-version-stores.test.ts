/**
 * Q5b schema-version store tests: every versioned writer stamps
 * `schemaVersion: 1` on disk and returns it; absent `schemaVersion` reads as
 * `1` (D6); an unknown `schemaVersion` is refused with
 * `StateFileUnknownVersionError` and never quarantined; the migration rule is
 * enforced; and `fast-check` round-trips each adapter.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { AttemptRecord } from '../../../domain/execution-records.js';
import type { ActionJournalEntryRecord, CapacityReservationRecord } from '../../../domain/execution-records.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import {
  assertValidSchemaVersionPolicy,
  inspectVersionedRecordListBytes,
  readStoreRecordSchemaVersion,
  StateFileUnknownVersionError,
  type VersionedRecordParseResult,
} from '../file-store.js';
import { AttemptRepositoryAdapter } from '../AttemptRepositoryAdapter.adapter.js';
import { LaneRunJournalAdapter } from '../LaneRunJournalAdapter.adapter.js';
import { LaneRunRepositoryAdapter } from '../LaneRunRepositoryAdapter.adapter.js';
import { ExecutionJournalAdapter } from '../ExecutionJournalAdapter.adapter.js';

const NOW = '2026-10-27T10:00:00.000Z';
const IN_2_MIN = '2026-10-27T10:02:00.000Z';
const RUN_0 = 'run-01JB0000000000000000000000';
const RUN_1 = 'run-01JB0000000000000000000001';

const ACQUIRE = { holderId: 'driver-example-1', observedFence: 0, leaseUntilIso: IN_2_MIN, nowIso: NOW };
const HOLD = { holderId: 'driver-example-1', fence: 1, nowIso: NOW };
const LEASE = { holderId: 'driver-example-1', fence: 1, leaseUntilIso: IN_2_MIN };

/** A minimal valid attempt; the adapter normalizes the rest. */
function attemptRecord(id: string): AttemptRecord {
  return {
    id,
    workOrderId: 'wo-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/tmp/wt',
    baseCommit: 'abc123',
    state: 'dispatching',
    outcome: null,
    briefDigest: null,
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    createdAtIso: '2026-10-25T00:00:00.000Z',
    updatedAtIso: '2026-10-25T00:00:00.000Z',
  };
}

/** A valid lane-run record ready for `create`. */
function laneRunRecord(runId: string, round = 0): LaneRunRecord {
  return {
    version: 1,
    runId,
    workOrderId: 'wo-example-1',
    tier: 2,
    seatPlanRef: 'a'.repeat(64),
    cursors: { 'first-pass': 0, fix: null, review: null },
    round,
    attemptIds: round === 0 ? ['attempt-example-1'] : ['attempt-example-1', 'attempt-example-2'],
    prNumber: null,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 1,
    runPolicyRevision: 'policy-example-1',
  };
}

/** A valid conduct entry for the run journal. */
function runJournalEntry(entryId: string): LaneRunJournalEntryRecord {
  return {
    version: 1,
    entryId,
    kind: 'conduct',
    key: null,
    runId: RUN_0,
    recordedAtIso: '2026-10-25T00:00:00.000Z',
    mode: null,
    expectedRevision: null,
    mintedId: null,
    outcome: null,
    reasonCode: null,
    detail: null,
    grantId: null,
    state: 'running',
  };
}

/** A valid action-journal entry. */
function journalEntry(id: string): ActionJournalEntryRecord {
  return {
    id,
    attemptId: 'a',
    workOrderId: 'w1',
    action: 'dispatch',
    baseCommit: 'abc123',
    recordedAtIso: '2026-10-25T00:00:00.000Z',
    status: 'intent-recorded',
    sessionId: null,
    detail: null,
  };
}

/** A valid held capacity reservation. */
function reservationRecord(id: string, attemptId: string): CapacityReservationRecord {
  return {
    id,
    attemptId,
    hostId: 'h',
    slotIndex: 0,
    held: true,
    seatTool: null,
    hostName: null,
    hostKind: null,
    transport: null,
    sshAlias: null,
    port: null,
    worktreePath: null,
    reservedAtIso: '2026-10-25T00:00:00.000Z',
    releasedAtIso: null,
  };
}

const VALID_RECORDS: Record<string, () => unknown[]> = {
  'attempts.json': () => [
    {
      id: 'att-1',
      workOrderId: 'wo-1',
      createdAtIso: '2026-10-25T00:00:00.000Z',
      updatedAtIso: '2026-10-25T00:00:00.000Z',
    },
    {
      id: 'att-2',
      workOrderId: 'wo-1',
      createdAtIso: '2026-10-25T00:01:00.000Z',
      updatedAtIso: '2026-10-25T00:01:00.000Z',
    },
  ],
  'lane-runs.json': () => [laneRunRecord(RUN_0), laneRunRecord(RUN_1)],
  'run-journal.json': () => [runJournalEntry('01JB0000000000000000000001'), runJournalEntry('01JB0000000000000000000002')],
  'journal.json': () => [
    { id: 'je-1', attemptId: 'a' },
    { id: 'je-2', attemptId: 'a' },
  ],
  'reservations.json': () => [
    reservationRecord('rs-1', 'a'),
    reservationRecord('rs-2', 'b'),
  ],
};

const READERS: Record<string, (stateDir: string) => Promise<readonly unknown[]>> = {
  'attempts.json': (dir) => new AttemptRepositoryAdapter({ stateDir: dir }).listAllAttempts(),
  'lane-runs.json': (dir) => new LaneRunRepositoryAdapter({ stateDir: dir }).list(),
  'run-journal.json': (dir) => new LaneRunJournalAdapter({ stateDir: dir }).listForRun(RUN_0),
  'journal.json': (dir) => new ExecutionJournalAdapter({ stateDir: dir }).listJournalEntriesForAttempt('a'),
  'reservations.json': (dir) => new ExecutionJournalAdapter({ stateDir: dir }).listActiveReservations(),
};

const WRITERS: Record<string, (stateDir: string) => Promise<unknown>> = {
  'attempts.json': (dir) => new AttemptRepositoryAdapter({ stateDir: dir }).saveAttempt(attemptRecord('att-new')),
  'lane-runs.json': (dir) => new LaneRunRepositoryAdapter({ stateDir: dir }).create(laneRunRecord(RUN_0)),
  'run-journal.json': (dir) => new LaneRunJournalAdapter({ stateDir: dir }).append(runJournalEntry('01JB0000000000000000000003')),
  'journal.json': (dir) => new ExecutionJournalAdapter({ stateDir: dir }).appendJournalEntry(journalEntry('je-new')),
  'reservations.json': (dir) =>
    new ExecutionJournalAdapter({ stateDir: dir }).saveCapacityReservation(reservationRecord('rs-new', 'c')),
};

function memoryAdapter(basename: string): unknown {
  switch (basename) {
    case 'attempts.json':
      return new AttemptRepositoryAdapter();
    case 'lane-runs.json':
      return new LaneRunRepositoryAdapter();
    case 'run-journal.json':
      return new LaneRunJournalAdapter();
    case 'journal.json':
    case 'reservations.json':
      return new ExecutionJournalAdapter();
    default:
      throw new Error(`unknown store ${basename}`);
  }
}

function fileAdapter(basename: string, dir: string): unknown {
  switch (basename) {
    case 'attempts.json':
      return new AttemptRepositoryAdapter({ stateDir: dir });
    case 'lane-runs.json':
      return new LaneRunRepositoryAdapter({ stateDir: dir });
    case 'run-journal.json':
      return new LaneRunJournalAdapter({ stateDir: dir });
    case 'journal.json':
    case 'reservations.json':
      return new ExecutionJournalAdapter({ stateDir: dir });
    default:
      throw new Error(`unknown store ${basename}`);
  }
}

/** Write through an adapter and collect every record it returns or reads back. */
async function writeAndCollect(basename: string, adapter: unknown): Promise<readonly unknown[]> {
  const collected: unknown[] = [];
  switch (basename) {
    case 'attempts.json': {
      const store = adapter as AttemptRepositoryAdapter;
      await store.saveAttempt(attemptRecord('att-new1'));
      await store.saveAttempt(attemptRecord('att-new2'));
      collected.push(...(await store.listAllAttempts()));
      break;
    }
    case 'lane-runs.json': {
      const store = adapter as LaneRunRepositoryAdapter;
      const created = await store.create(laneRunRecord(RUN_0));
      if (created.outcome === 'saved') {
        collected.push(created.record);
      }
      const acquired = await store.acquireLease(RUN_0, ACQUIRE);
      if (acquired.outcome === 'saved') {
        collected.push(acquired.record);
      }
      const saved = await store.save(
        { ...laneRunRecord(RUN_0), revision: 2, lease: LEASE },
        HOLD,
      );
      if (saved.outcome === 'saved') {
        collected.push(saved.record);
      }
      collected.push(...(await store.list()));
      break;
    }
    case 'run-journal.json': {
      const store = adapter as LaneRunJournalAdapter;
      const first = await store.append(runJournalEntry('01JB0000000000000000000004'));
      if (first.outcome === 'appended') {
        collected.push(first.entry);
      }
      const second = await store.append(runJournalEntry('01JB0000000000000000000005'));
      if (second.outcome === 'appended') {
        collected.push(second.entry);
      }
      collected.push(...(await store.listForRun(RUN_0)));
      break;
    }
    case 'journal.json': {
      const store = adapter as ExecutionJournalAdapter;
      await store.appendJournalEntry(journalEntry('je-new1'));
      await store.appendJournalEntry(journalEntry('je-new2'));
      collected.push(...(await store.listJournalEntriesForAttempt('a')));
      break;
    }
    case 'reservations.json': {
      const store = adapter as ExecutionJournalAdapter;
      await store.saveCapacityReservation(reservationRecord('rs-1', 'a'));
      const reserved = await store.reserveCapacityAtomically({
        attemptId: 'b',
        record: reservationRecord('rs-2', 'b'),
        maxSlots: 2,
      });
      if (reserved.outcome === 'reserved') {
        collected.push(reserved.reservation);
      }
      await store.releaseCapacityReservation('a', '2026-10-25T00:02:00.000Z');
      collected.push(...(await store.listActiveReservations()));
      break;
    }
  }
  return collected;
}

async function expectUnknownVersionRejection(promise: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(StateFileUnknownVersionError);
  const error = caught as StateFileUnknownVersionError;
  expect(error.reason).toBe('unknown-schema-version');
  expect(error.recordIndex).toBe(1);
  expect(error.message).not.toContain('CANARY');
}

const BAD_VERSIONS: readonly unknown[] = [2, 0, -1, '1', null, { v: 1 }, 'CANARY-secret-version'];

describe.each(Object.keys(VALID_RECORDS))('%s schema version store', (basename) => {
  function badBytes(bad: unknown): Buffer {
    const records = VALID_RECORDS[basename]!();
    records[1] = { ...(records[1] as Record<string, unknown>), schemaVersion: bad };
    return Buffer.from(JSON.stringify(records));
  }

  it('writer stamps schemaVersion 1 on disk and in returned and read-back records', async () => {
    // In-memory mode: every returned/read-back record carries schemaVersion 1.
    const memoryCollected = await writeAndCollect(basename, memoryAdapter(basename));
    expect(memoryCollected.length).toBeGreaterThan(0);
    for (const record of memoryCollected) {
      expect((record as { schemaVersion?: unknown }).schemaVersion).toBe(1);
    }

    // File mode: raw JSON on disk carries schemaVersion 1 on every element and reads back with it.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-schema-stamp-'));
    try {
      await writeAndCollect(basename, fileAdapter(basename, dir));
      const onDisk = JSON.parse(await fs.readFile(path.join(dir, basename), 'utf8')) as unknown[];
      expect(onDisk.length).toBeGreaterThan(0);
      for (const raw of onDisk) {
        expect((raw as Record<string, unknown>).schemaVersion).toBe(1);
      }
      const readBack = await READERS[basename]!(dir);
      for (const record of readBack) {
        expect((record as { schemaVersion?: unknown }).schemaVersion).toBe(1);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('legacy records without schemaVersion read back as 1 and a later write stamps 1', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-schema-legacy-'));
    try {
      const target = path.join(dir, basename);
      await fs.writeFile(target, JSON.stringify(VALID_RECORDS[basename]!()));
      const readBack = await READERS[basename]!(dir);
      expect(readBack.length).toBeGreaterThan(0);
      for (const record of readBack) {
        expect((record as { schemaVersion?: unknown }).schemaVersion).toBe(1);
      }
      await writeAndCollect(basename, fileAdapter(basename, dir));
      const onDisk = JSON.parse(await fs.readFile(target, 'utf8')) as unknown[];
      for (const raw of onDisk) {
        expect((raw as Record<string, unknown>).schemaVersion).toBe(1);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it.each(BAD_VERSIONS)('refuses schemaVersion %p on read without quarantine or bytes changed', async (bad: unknown) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-schema-badread-'));
    try {
      const target = path.join(dir, basename);
      const bytes = badBytes(bad);
      await fs.writeFile(target, bytes);
      const shaBefore = createHash('sha256').update(bytes).digest('hex');
      await expectUnknownVersionRejection(READERS[basename]!(dir));
      expect(createHash('sha256').update(await fs.readFile(target)).digest('hex')).toBe(shaBefore);
      await expect(fs.stat(path.join(dir, 'quarantine'))).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it.each(BAD_VERSIONS)('refuses schemaVersion %p on write without quarantine or bytes changed', async (bad: unknown) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-schema-badwrite-'));
    try {
      const target = path.join(dir, basename);
      const bytes = badBytes(bad);
      await fs.writeFile(target, bytes);
      const shaBefore = createHash('sha256').update(bytes).digest('hex');
      await expectUnknownVersionRejection(WRITERS[basename]!(dir));
      expect(createHash('sha256').update(await fs.readFile(target)).digest('hex')).toBe(shaBefore);
      await expect(fs.stat(path.join(dir, 'quarantine'))).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe('read-only reads refuse an unknown schemaVersion without quarantine', () => {
  it.each(['attempts.json', 'lane-runs.json', 'run-journal.json'])('%s', async (basename) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-schema-readonly-'));
    try {
      const records = VALID_RECORDS[basename]!();
      records[1] = { ...(records[1] as Record<string, unknown>), schemaVersion: 2 };
      await fs.writeFile(path.join(dir, basename), JSON.stringify(records));
      const readOnlyReaders: Record<string, (d: string) => Promise<unknown>> = {
        'attempts.json': (d) => new AttemptRepositoryAdapter({ stateDir: d, readOnly: true }).listAllAttempts(),
        'lane-runs.json': (d) => new LaneRunRepositoryAdapter({ stateDir: d, readOnly: true }).list(),
        'run-journal.json': (d) => new LaneRunJournalAdapter({ stateDir: d, readOnly: true }).listForRun(RUN_0),
      };
      await expectUnknownVersionRejection(readOnlyReaders[basename]!(dir));
      await expect(fs.stat(path.join(dir, 'quarantine'))).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe('migration rule', () => {
  it('assertValidSchemaVersionPolicy enforces reader acceptance of writer and previous version', () => {
    expect(() =>
      assertValidSchemaVersionPolicy('s.json', { writerVersion: 2, acceptedVersions: [1] }),
    ).toThrow(/bumps schemaVersion only together with a reader that accepts it/);
    expect(() =>
      assertValidSchemaVersionPolicy('s.json', { writerVersion: 2, acceptedVersions: [2] }),
    ).toThrow(/reader must still accept previous schemaVersion 1/);
    const policy = assertValidSchemaVersionPolicy('s.json', { writerVersion: 2, acceptedVersions: [1, 2] });
    expect(policy.writerVersion).toBe(2);
  });

  it('inspectVersionedRecordListBytes reads absent, 1 and 2 and refuses 3', () => {
    const policy = assertValidSchemaVersionPolicy('s.json', { writerVersion: 2, acceptedVersions: [1, 2] });
    const parseRecord = (raw: unknown): VersionedRecordParseResult<Record<string, unknown>> => {
      const check = readStoreRecordSchemaVersion(raw, policy);
      if (check.status !== 'ok') {
        return check;
      }
      return { status: 'ok', record: raw as Record<string, unknown>, schemaVersion: check.schemaVersion };
    };
    const ok = inspectVersionedRecordListBytes(
      Buffer.from(JSON.stringify([{ id: 'a' }, { id: 'b', schemaVersion: 1 }, { id: 'c', schemaVersion: 2 }])),
      parseRecord,
    );
    expect(ok).toEqual({
      status: 'ok',
      records: [{ id: 'a' }, { id: 'b', schemaVersion: 1 }, { id: 'c', schemaVersion: 2 }],
      schemaVersions: [1, 2],
    });
    const refused = inspectVersionedRecordListBytes(
      Buffer.from(JSON.stringify([{ id: 'a', schemaVersion: 3 }])),
      parseRecord,
    );
    expect(refused).toEqual({
      status: 'unknown-version',
      detail: 'record 0 has an unsupported schemaVersion (unknown-schema-version)',
      recordIndex: 0,
    });
  });
});

describe('fast-check round-trips stamp schemaVersion 1', () => {
  const attemptArb = fc.record({
    id: fc.stringMatching(/^att-[a-z0-9-]+$/),
    workOrderId: fc.constant('wo-1'),
    createdAtIso: fc.constant('2026-10-25T00:00:00.000Z'),
    updatedAtIso: fc.constant('2026-10-25T00:00:00.000Z'),
  });

  it('AttemptRepositoryAdapter', async () => {
    await fc.assert(
      fc.asyncProperty(attemptArb, async (raw) => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-schema-prop-attempt-'));
        try {
          const writer = new AttemptRepositoryAdapter({ stateDir: dir });
          await writer.saveAttempt(raw as unknown as AttemptRecord);
          const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'attempts.json'), 'utf8')) as unknown[];
          expect(onDisk).toHaveLength(1);
          expect((onDisk[0] as Record<string, unknown>).schemaVersion).toBe(1);
          const readBack = await new AttemptRepositoryAdapter({ stateDir: dir }).listAllAttempts();
          expect(readBack).toEqual([{ ...raw, schemaVersion: 1, revision: 0 }]);
        } finally {
          await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      }),
      { numRuns: 25 },
    );
  });

  const laneRunArb = fc.integer({ min: 0, max: 1 }).map((round) => laneRunRecord(RUN_0, round));

  it('LaneRunRepositoryAdapter', async () => {
    await fc.assert(
      fc.asyncProperty(laneRunArb, async (record) => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-schema-prop-lanerun-'));
        try {
          const writer = new LaneRunRepositoryAdapter({ stateDir: dir });
          const created = await writer.create(record);
          expect(created.outcome).toBe('saved');
          const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'lane-runs.json'), 'utf8')) as unknown[];
          expect(onDisk).toHaveLength(1);
          expect((onDisk[0] as Record<string, unknown>).schemaVersion).toBe(1);
          const readBack = await new LaneRunRepositoryAdapter({ stateDir: dir }).list();
          expect(readBack).toEqual([{ ...record, schemaVersion: 1 }]);
        } finally {
          await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      }),
      { numRuns: 25 },
    );
  });

  const journalEntryArb = fc.record({
    id: fc.stringMatching(/^je-[a-z0-9-]+$/),
    attemptId: fc.constant('a'),
  });

  it('LaneRunJournalAdapter', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constant(runJournalEntry('01JB0000000000000000000001')), async (entry) => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-schema-prop-runjournal-'));
        try {
          const writer = new LaneRunJournalAdapter({ stateDir: dir });
          const appended = await writer.append(entry);
          expect(appended.outcome).toBe('appended');
          const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'run-journal.json'), 'utf8')) as unknown[];
          expect(onDisk).toHaveLength(1);
          expect((onDisk[0] as Record<string, unknown>).schemaVersion).toBe(1);
          const readBack = await new LaneRunJournalAdapter({ stateDir: dir }).listForRun(RUN_0);
          expect(readBack).toEqual([{ ...entry, schemaVersion: 1 }]);
        } finally {
          await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      }),
      { numRuns: 25 },
    );
  });

  it('ExecutionJournalAdapter journal.json', async () => {
    await fc.assert(
      fc.asyncProperty(journalEntryArb, async (raw) => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-schema-prop-journal-'));
        try {
          const writer = new ExecutionJournalAdapter({ stateDir: dir });
          await writer.appendJournalEntry(raw as unknown as ActionJournalEntryRecord);
          const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'journal.json'), 'utf8')) as unknown[];
          expect(onDisk).toHaveLength(1);
          expect((onDisk[0] as Record<string, unknown>).schemaVersion).toBe(1);
          const readBack = await new ExecutionJournalAdapter({ stateDir: dir }).listJournalEntriesForAttempt('a');
          expect(readBack).toEqual([{ ...raw, schemaVersion: 1 }]);
        } finally {
          await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      }),
      { numRuns: 25 },
    );
  });

  const reservationArb = fc.record({
    id: fc.stringMatching(/^rs-[a-z0-9-]+$/),
    attemptId: fc.stringMatching(/^att-[a-z0-9-]+$/),
    hostId: fc.constant('h'),
    slotIndex: fc.integer({ min: 0, max: 4 }),
    held: fc.constant(true),
    reservedAtIso: fc.constant('2026-10-25T00:00:00.000Z'),
    releasedAtIso: fc.constant(null),
    seatTool: fc.constant(null),
    hostName: fc.constant(null),
    hostKind: fc.constant(null),
    transport: fc.constant(null),
    sshAlias: fc.constant(null),
    port: fc.constant(null),
    worktreePath: fc.constant(null),
  });

  it('ExecutionJournalAdapter reservations.json', async () => {
    await fc.assert(
      fc.asyncProperty(reservationArb, async (raw) => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-schema-prop-reservation-'));
        try {
          const writer = new ExecutionJournalAdapter({ stateDir: dir });
          await writer.saveCapacityReservation(raw as unknown as CapacityReservationRecord);
          const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'reservations.json'), 'utf8')) as unknown[];
          expect(onDisk).toHaveLength(1);
          expect((onDisk[0] as Record<string, unknown>).schemaVersion).toBe(1);
          const readBack = await new ExecutionJournalAdapter({ stateDir: dir }).listActiveReservations();
          expect(readBack).toEqual([{ ...raw, schemaVersion: 1 }]);
        } finally {
          await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      }),
      { numRuns: 25 },
    );
  });
});
