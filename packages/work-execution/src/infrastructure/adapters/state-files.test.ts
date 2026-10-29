import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  StateFileUnreadableError,
  inspectRecordListBytes,
  quarantineUnreadable,
  type StateFileDescriptor,
  type StateFileInspection,
} from './file-store.js';
import { parseConductorHaltStateRecord } from './ConductorHaltAdapter.adapter.js';
import { WORK_EXECUTION_STATE_FILES } from './state-files.js';
import { WorkOrderRepositoryAdapter } from './WorkOrderRepositoryAdapter.adapter.js';
import { AttemptRepositoryAdapter } from './AttemptRepositoryAdapter.adapter.js';
import { ExecutionJournalAdapter } from './ExecutionJournalAdapter.adapter.js';
import { LaneRunRepositoryAdapter } from './LaneRunRepositoryAdapter.adapter.js';
import { ConductorDriverLeaseAdapter } from './ConductorDriverLeaseAdapter.adapter.js';
import { ConductorHaltAdapter } from './ConductorHaltAdapter.adapter.js';
import { LaneRunJournalAdapter } from './LaneRunJournalAdapter.adapter.js';

const VALID_FIXTURES: Readonly<Record<string, readonly unknown[]>> = {
  'work-orders.json': [
    { id: 'wo-1', revision: 1 },
    { id: 'wo-2', revision: 1 },
  ],
  'attempts.json': [
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
  'journal.json': [
    { id: 'je-1', attemptId: 'a' },
    { id: 'je-2', attemptId: 'a' },
  ],
  'reservations.json': [
    { id: 'rs-1', attemptId: 'a' },
    { id: 'rs-2', attemptId: 'a' },
  ],
  'lane-runs.json': [
    {
      version: 1,
      runId: 'run-01JB0000000000000000000000',
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
    },
    {
      version: 1,
      runId: 'run-01JB0000000000000000000001',
      workOrderId: 'wo-example-2',
      tier: 2,
      seatPlanRef: 'b'.repeat(64),
      cursors: { 'first-pass': null, fix: null, review: null },
      round: 0,
      attemptIds: [],
      prNumber: null,
      parked: null,
      parkCount: 0,
      lease: null,
      revision: 1,
      runPolicyRevision: 'policy-example-2',
    },
  ],
  'conductor-driver-lease.json': [
    {
      version: 1,
      holderId: 'driver-example-1',
      fence: 1,
      leaseUntilIso: '2026-10-27T10:02:00.000Z',
    },
    {
      version: 1,
      holderId: 'driver-example-2',
      fence: 2,
      leaseUntilIso: '2026-10-27T10:02:00.000Z',
    },
  ],
  'conductor-halt.json': [
    { version: 1, halted: true, changedAtIso: '2026-10-27T10:00:00.000Z' },
    { version: 1, halted: false, changedAtIso: '2026-10-27T10:01:00.000Z' },
  ],
  'run-journal.json': [
    {
      version: 1,
      entryId: '01JB0000000000000000000000',
      kind: 'intent',
      key: 'run-01JB0000000000000000000000/r0/dispatch/0/a1',
      runId: 'run-01JB0000000000000000000000',
      recordedAtIso: '2026-10-25T00:00:00.000Z',
      mode: null,
      expectedRevision: null,
      mintedId: '01JB0000000000000000000001',
      outcome: null,
      reasonCode: null,
      grantId: null,
      state: null,
    },
    {
      version: 1,
      entryId: '01JB0000000000000000000002',
      kind: 'result',
      key: 'run-01JB0000000000000000000000/r0/dispatch/0/a1',
      runId: 'run-01JB0000000000000000000000',
      recordedAtIso: '2026-10-25T00:01:00.000Z',
      mode: null,
      expectedRevision: null,
      mintedId: null,
      outcome: 'completed',
      reasonCode: null,
      grantId: null,
      state: null,
    },
  ],
};

const READS: Readonly<Record<string, (stateDir: string) => Promise<unknown>>> = {
  'work-orders.json': (stateDir) =>
    new WorkOrderRepositoryAdapter({ stateDir }).listWorkOrdersByProject(),
  'attempts.json': (stateDir) => new AttemptRepositoryAdapter({ stateDir }).listAllAttempts(),
  'journal.json': (stateDir) =>
    new ExecutionJournalAdapter({ stateDir }).listJournalEntriesForAttempt('a'),
  'reservations.json': (stateDir) =>
    new ExecutionJournalAdapter({ stateDir }).listActiveReservations(),
  'lane-runs.json': (stateDir) => new LaneRunRepositoryAdapter({ stateDir }).list(),
  'conductor-driver-lease.json': (stateDir) => new ConductorDriverLeaseAdapter({ stateDir }).read(),
  'conductor-halt.json': async (stateDir) => {
    // The halt port's `read()` never throws for an unreadable marker (it
    // reads `unreadable`), so this observes the same inspection the adapter
    // performs, which quarantines and throws the matching detail.
    const target = path.join(stateDir, 'conductor-halt.json');
    const buffer = await fs.readFile(target);
    const inspection = inspectRecordListBytes(buffer, parseConductorHaltStateRecord);
    if (inspection.status === 'unreadable') {
      return quarantineUnreadable(target, inspection.detail, buffer);
    }
    return new ConductorHaltAdapter({ stateDir }).read();
  },
  'run-journal.json': (stateDir) =>
    new LaneRunJournalAdapter({ stateDir }).listForRun('run-01JB0000000000000000000000'),
};

type FixtureKind = 'valid' | 'not-json' | 'not-list' | 'bad-record';

function bytesFor(basename: string, kind: FixtureKind): Buffer {
  if (kind === 'not-json') return Buffer.from('{ not json');
  if (kind === 'not-list') return Buffer.from('{}');
  const first = VALID_FIXTURES[basename]![0];
  if (kind === 'bad-record') {
    return Buffer.from(JSON.stringify([first, { bogus: true }]));
  }
  return Buffer.from(JSON.stringify(VALID_FIXTURES[basename]));
}

const CASES: Array<{
  basename: string;
  kind: FixtureKind;
  inspect: (bytes: Buffer) => StateFileInspection;
  read: (stateDir: string) => Promise<unknown>;
  bytes: Buffer;
  expectedOk: boolean;
}> = [];

for (const descriptor of WORK_EXECUTION_STATE_FILES) {
  const kinds: readonly FixtureKind[] = ['valid', 'not-json', 'not-list', 'bad-record'];
  for (const kind of kinds) {
    const bytes = bytesFor(descriptor.basename, kind);
    CASES.push({
      basename: descriptor.basename,
      kind,
      inspect: (b: Buffer) => descriptor.inspect(b),
      read: READS[descriptor.basename]!,
      bytes,
      expectedOk: kind === 'valid',
    });
  }
}

describe('work-execution state file descriptors match the store readers', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-e1b-state-files-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it.each(CASES)('$basename / $kind', async ({ basename, bytes, inspect, read, expectedOk }) => {
    await fs.writeFile(path.join(tempDir, basename), bytes);
    const inspection = inspect(bytes);
    const outcome = await read(tempDir).then(
      () => 'resolved',
      (error: unknown) => error,
    );
    if (inspection.status === 'ok') {
      expect(outcome).toBe('resolved');
    } else {
      expect(outcome).toBeInstanceOf(StateFileUnreadableError);
      expect((outcome as StateFileUnreadableError).detail).toBe(inspection.detail);
    }
    expect(expectedOk).toBe(inspection.status === 'ok');
  });

  it('lists exactly the owned state files', () => {
    expect(WORK_EXECUTION_STATE_FILES.map((descriptor: StateFileDescriptor) => descriptor.basename)).toEqual([
      'work-orders.json',
      'attempts.json',
      'journal.json',
      'reservations.json',
      'lane-runs.json',
      'conductor-driver-lease.json',
      'conductor-halt.json',
      'run-journal.json',
    ]);
  });
});
