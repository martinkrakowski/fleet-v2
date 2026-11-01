import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  StateFileUnreadableError,
  StateFileUnknownVersionError,
  inspectRecordListBytes,
  quarantineUnreadable,
  type StateFileDescriptor,
  type StateFileInspection,
} from './file-store.js';
import { parseConductorPassTraceStateRecord } from '../../domain/conductor-pass-trace.js';
import { parseConductorHaltStateRecord } from './ConductorHaltAdapter.adapter.js';
import { ConductorPassTraceAdapter } from './ConductorPassTraceAdapter.adapter.js';
import { WORK_EXECUTION_STATE_FILES } from './state-files.js';
import { WorkOrderRepositoryAdapter, parseWorkOrderStateRecord } from './WorkOrderRepositoryAdapter.adapter.js';
import { AttemptRepositoryAdapter } from './AttemptRepositoryAdapter.adapter.js';
import { ExecutionJournalAdapter } from './ExecutionJournalAdapter.adapter.js';
import { LaneRunRepositoryAdapter, parseLaneRunStateRecord } from './LaneRunRepositoryAdapter.adapter.js';
import { ConductorDriverLeaseAdapter } from './ConductorDriverLeaseAdapter.adapter.js';
import { ConductorHaltAdapter } from './ConductorHaltAdapter.adapter.js';
import { LaneRunJournalAdapter } from './LaneRunJournalAdapter.adapter.js';
import {
  TelemetryDispositionAdapter,
  parseTelemetryDispositionStateRecord,
} from './TelemetryDispositionAdapter.adapter.js';

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
  'telemetry-dispositions.json': [
    {
      version: 1,
      saltFingerprint: 'abc12345',
      spans: {
        [`${'a'.repeat(32)}`]: {
          [`${'b'.repeat(16)}`]: 'pending',
          [`${'c'.repeat(16)}`]: 'exported@collector',
        },
      },
      counters: {
        timeout: 0,
        network: 0,
        auth: 0,
        'http-4xx': 1,
        'http-5xx': 0,
        partial: 0,
        'salt-mismatch': 0,
        'queue-drops': 2,
      },
      lastExportAtIso: '2026-10-27T10:00:00.000Z',
    },
  ],
  'conductor-passes.json': [
    {
      passId: 'pass-1',
      nowIso: '2026-10-27T10:00:00.000Z',
      holderId: 'driver-example-1',
      halted: false,
      progressed: true,
      maxActiveRuns: 2,
      passConcurrency: 1,
      dispatchStaggerMs: 20000,
      runs: [
        {
          runId: 'run-01JB0000000000000000000000',
          report: { outcome: 'advanced', steps: [{ outcome: 'entered', state: 'running' }] },
        },
      ],
      attention: [{ runId: 'run-01JB0000000000000000000000', kind: 'stop-grace-exceeded' }],
    },
    {
      schemaVersion: 1,
      passId: 'pass-2',
      nowIso: '2026-10-27T10:01:00.000Z',
      holderId: 'driver-example-2',
      halted: true,
      progressed: false,
      maxActiveRuns: 1,
      passConcurrency: 1,
      dispatchStaggerMs: 10000,
      runs: [{ runId: 'run-01JB0000000000000000000001', report: { outcome: 'skipped', reason: 'lease-held' } }],
      attention: [],
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
  'telemetry-dispositions.json': async (stateDir) => {
    // The disposition port's `read()` never throws for an unreadable store
    // (it reads `unreadable`), so this observes the same inspection the
    // adapter performs, which quarantines and throws the matching detail.
    const target = path.join(stateDir, 'telemetry-dispositions.json');
    const buffer = await fs.readFile(target);
    const inspection = inspectRecordListBytes(buffer, parseTelemetryDispositionStateRecord);
    if (inspection.status === 'unreadable') {
      return quarantineUnreadable(target, inspection.detail, buffer);
    }
    return new TelemetryDispositionAdapter({ stateDir }).read();
  },
  'conductor-passes.json': async (stateDir) => {
    // The trace adapter's `list()` never throws for an unreadable ring (it
    // reads `unreadable`), so this observes the same inspection the adapter
    // performs, which quarantines and throws the matching detail.
    const target = path.join(stateDir, 'conductor-passes.json');
    const buffer = await fs.readFile(target);
    const inspection = inspectRecordListBytes(buffer, parseConductorPassTraceStateRecord);
    if (inspection.status === 'unreadable') {
      return quarantineUnreadable(target, inspection.detail, buffer);
    }
    return new ConductorPassTraceAdapter({ stateDir }).list();
  },
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

  it('a valid baseBranch stays readable and an unparsable one fails validation (CB1)', () => {
    // The work-order store parser accepts an absent key ({ id, revision })
    // and a present valid value, and refuses a present unparsable one.
    const workOrderInspect = (bytes: Buffer) => inspectRecordListBytes(bytes, parseWorkOrderStateRecord);
    expect(workOrderInspect(Buffer.from(JSON.stringify([{ id: 'wo-1', revision: 1, baseBranch: 'chain/example' }]))).status).toBe('ok');
    expect(workOrderInspect(Buffer.from(JSON.stringify([{ id: 'wo-1', revision: 1 }]))).status).toBe('ok');
    const badWorkOrder = workOrderInspect(
      Buffer.from(JSON.stringify([{ id: 'wo-1', revision: 1, baseBranch: 'release' }])),
    );
    expect(badWorkOrder.status).toBe('unreadable');
    expect(badWorkOrder.status === 'unreadable' ? badWorkOrder.detail : '').toBe('record 0 failed validation');

    // The lane-run store parser (LaneRun.create) refuses an unparsable
    // baseBranch the same way; a valid one and the fixture without the key stay readable.
    const laneRunInspect = (bytes: Buffer) => inspectRecordListBytes(bytes, parseLaneRunStateRecord);
    const withBaseBranch = VALID_FIXTURES['lane-runs.json']!.map((record) => ({
      ...(record as Record<string, unknown>),
      baseBranch: 'main',
    }));
    expect(laneRunInspect(Buffer.from(JSON.stringify(withBaseBranch))).status).toBe('ok');
    const unparsable = VALID_FIXTURES['lane-runs.json']!.map((record) => ({
      ...(record as Record<string, unknown>),
      baseBranch: 'release',
    }));
    expect(laneRunInspect(Buffer.from(JSON.stringify(unparsable))).status).toBe('unreadable');
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
      'telemetry-dispositions.json',
      'conductor-passes.json',
    ]);
  });
});

describe('versioned store descriptors', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-e1b-versioned-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  const VERSIONED_STORES = [
    'attempts.json',
    'journal.json',
    'reservations.json',
    'lane-runs.json',
    'run-journal.json',
  ];

  it('reports schemaVersions [1] on valid fixtures', () => {
    for (const basename of VERSIONED_STORES) {
      const descriptor = WORK_EXECUTION_STATE_FILES.find((d) => d.basename === basename)!;
      const bytes = Buffer.from(JSON.stringify(VALID_FIXTURES[basename]));
      expect(descriptor.inspect(bytes)).toEqual({
        status: 'ok',
        recordCount: 2,
        schemaVersions: [1],
      });
    }
  });

  it.each(VERSIONED_STORES)('refuses an unknown schemaVersion on %s without quarantine', async (basename) => {
    const fixture = VALID_FIXTURES[basename]!;
    const bad = [...fixture];
    bad[1] = { ...(bad[1] as Record<string, unknown>), schemaVersion: 2 };
    const bytes = Buffer.from(JSON.stringify(bad));
    await fs.writeFile(path.join(tempDir, basename), bytes);

    const descriptor = WORK_EXECUTION_STATE_FILES.find((d) => d.basename === basename)!;
    expect(descriptor.inspect(bytes)).toEqual({
      status: 'unknown-version',
      detail: 'record 1 has an unsupported schemaVersion (unknown-schema-version)',
      recordIndex: 1,
    });

    await expect(READS[basename]!(tempDir)).rejects.toBeInstanceOf(StateFileUnknownVersionError);
    await expect(fs.stat(path.join(tempDir, 'quarantine'))).rejects.toThrow();
  });
});
