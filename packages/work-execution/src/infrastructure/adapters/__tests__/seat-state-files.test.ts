import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  StateFileUnreadableError,
  type StateFileDescriptor,
  type StateFileInspection,
} from '../file-store.js';
import { WORK_EXECUTION_STATE_FILES } from '../state-files.js';
import { SeatTicketRepositoryAdapter } from '../SeatTicketRepositoryAdapter.adapter.js';
import { SeatObservationRepositoryAdapter } from '../SeatObservationRepositoryAdapter.adapter.js';

const VALID_FIXTURES: Readonly<Record<string, readonly unknown[]>> = {
  'seat-tickets.json': [
    {
      version: 1,
      projectId: 'p1',
      role: 'first-pass',
      ticket: 1,
      revision: 1,
      updatedAtIso: '2026-11-06T00:00:00.000Z',
    },
  ],
  'seat-observations.json': [
    {
      version: 1,
      observationId: 'obs-1',
      seatId: 'seat-1',
      outcome: 'rate-limited',
      observedAtIso: '2026-11-06T00:00:00.000Z',
      subject: { attemptId: 'a1' },
      via: 'cli',
    },
  ],
};

const READS: Readonly<Record<string, (stateDir: string) => Promise<unknown>>> = {
  'seat-tickets.json': (stateDir) =>
    new SeatTicketRepositoryAdapter({ stateDir }).listSeatTickets(),
  'seat-observations.json': (stateDir) =>
    new SeatObservationRepositoryAdapter({ stateDir }).listSeatObservations(),
};

type FixtureKind = 'valid' | 'not-json' | 'unknown-version';

function bytesFor(basename: string, kind: FixtureKind): Buffer {
  if (kind === 'not-json') return Buffer.from('{ not json');
  const first = VALID_FIXTURES[basename]![0] as Record<string, unknown>;
  if (kind === 'unknown-version') {
    return Buffer.from(JSON.stringify([{ ...first, schemaVersion: 2 }]));
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
  if (READS[descriptor.basename] === undefined) {
    continue;
  }
  for (const kind of ['valid', 'not-json', 'unknown-version'] as const) {
    CASES.push({
      basename: descriptor.basename,
      kind,
      inspect: (b: Buffer) => descriptor.inspect(b),
      read: READS[descriptor.basename]!,
      bytes: bytesFor(descriptor.basename, kind),
      expectedOk: kind === 'valid',
    });
  }
}

describe('work-execution seat state file descriptors match the store readers', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-sr3-seat-state-files-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('lists the seat stores after killall-train-pause.json', () => {
    const basenames = WORK_EXECUTION_STATE_FILES.map(
      (descriptor: StateFileDescriptor) => descriptor.basename,
    );
    expect(basenames).toContain('seat-tickets.json');
    expect(basenames).toContain('seat-observations.json');
    const pauseIndex = basenames.indexOf('killall-train-pause.json');
    expect(basenames.indexOf('seat-tickets.json')).toBe(pauseIndex + 1);
    expect(basenames.indexOf('seat-observations.json')).toBe(pauseIndex + 2);
  });

  it('reports duplicate seat ticket keys as unreadable in both state check and the reader', async () => {
    const first = VALID_FIXTURES['seat-tickets.json']![0] as Record<string, unknown>;
    const bytes = Buffer.from(
      JSON.stringify([
        { ...first, ticket: 10, revision: 1 },
        { ...first, ticket: 5, revision: 2 },
      ]),
    );
    await fs.writeFile(path.join(tempDir, 'seat-tickets.json'), bytes);
    const descriptor = WORK_EXECUTION_STATE_FILES.find((d) => d.basename === 'seat-tickets.json')!;
    const inspection = descriptor.inspect(bytes);
    expect(inspection.status).toBe('unreadable');
    const error = await new SeatTicketRepositoryAdapter({ stateDir: tempDir })
      .listSeatTickets()
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(StateFileUnreadableError);
    expect((error as StateFileUnreadableError).detail).toBe(
      (inspection as { detail: string }).detail,
    );
  });

  it.each(CASES)('$basename / $kind', async ({ basename, bytes, inspect, read, expectedOk }) => {
    await fs.writeFile(path.join(tempDir, basename), bytes);
    const inspection = inspect(bytes);
    const outcome = await read(tempDir).then(
      () => 'resolved',
      (error: unknown) => error,
    );
    if (inspection.status === 'ok') {
      expect(inspection.recordCount).toBe(1);
      expect(outcome).toBe('resolved');
    } else if (inspection.status === 'unknown-version') {
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).name).toBe('StateFileUnknownVersionError');
    } else {
      expect(outcome).toBeInstanceOf(StateFileUnreadableError);
      expect((outcome as StateFileUnreadableError).detail).toBe(inspection.detail);
    }
    expect(expectedOk).toBe(inspection.status === 'ok');
  });
});
