import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  StateFileUnreadableError,
  StateFileUnknownVersionError,
} from '../file-store.js';
import {
  parseVersionedSeatObservationStateRecord,
  SeatObservationRepositoryAdapter,
} from '../SeatObservationRepositoryAdapter.adapter.js';
import type { SeatObservationRecord } from '../../../domain/execution-records.js';

function observation(
  observationId: string,
  overrides: Partial<SeatObservationRecord> = {},
): SeatObservationRecord {
  return {
    version: 1,
    observationId,
    seatId: 'seat-1',
    outcome: 'rate-limited',
    observedAtIso: '2026-11-06T00:00:00.000Z',
    subject: { attemptId: 'attempt-1' },
    via: 'cli',
    ...overrides,
  };
}

describe('SeatObservationRepositoryAdapter (memory mode)', () => {
  let adapter: SeatObservationRepositoryAdapter;

  beforeEach(() => {
    adapter = new SeatObservationRepositoryAdapter();
  });

  it('appends and lists in append order, narrowed by seatId', async () => {
    expect(await adapter.listSeatObservations()).toEqual([]);
    const first = observation('obs-1', { seatId: 'seat-1' });
    const second = observation('obs-2', { seatId: 'seat-2', subject: { reviewRequestId: 'rr-1' } });
    expect(await adapter.appendSeatObservation(first)).toBe('appended');
    expect(await adapter.appendSeatObservation(second)).toBe('appended');
    expect(await adapter.listSeatObservations()).toEqual([first, second]);
    expect(await adapter.listSeatObservations('seat-1')).toEqual([first]);
    expect(await adapter.listSeatObservations('other-seat')).toEqual([]);
  });

  it('is append-only: stored records are never rewritten or removed', async () => {
    const first = observation('obs-1');
    await adapter.appendSeatObservation(first);
    await adapter.appendSeatObservation(observation('obs-2', { outcome: 'timeout' }));
    const list = await adapter.listSeatObservations();
    expect(list[0]).toEqual(first);
    expect(list).toHaveLength(2);
  });

  it('refuses a repeated observationId as duplicate without writing', async () => {
    const first = observation('obs-1', { outcome: 'rate-limited' });
    expect(await adapter.appendSeatObservation(first)).toBe('appended');
    expect(await adapter.appendSeatObservation(observation('obs-1', { outcome: 'timeout' }))).toBe('duplicate');
    const list = await adapter.listSeatObservations();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(first);
  });

  it('refuses an unsafe observation id or seat id', async () => {
    for (const observationId of ['.', '..', '']) {
      await expect(adapter.appendSeatObservation(observation(observationId))).rejects.toThrow(
        'SeatObservationRepositoryAdapter refuses an unsafe observation id or seat id',
      );
    }
    for (const seatId of ['.', '..', '']) {
      await expect(adapter.appendSeatObservation(observation('obs-1', { seatId }))).rejects.toThrow(
        'SeatObservationRepositoryAdapter refuses an unsafe observation id or seat id',
      );
    }
  });

  it('refuses a record the reader would reject (extra subject property, bad date) without storing it', async () => {
    const extra = observation('obs-x', {
      subject: { attemptId: 'a1', extra: true } as unknown as SeatObservationRecord['subject'],
    });
    await expect(adapter.appendSeatObservation(extra)).rejects.toThrow();
    await expect(
      adapter.appendSeatObservation(observation('obs-y', { observedAtIso: 'not-a-date' })),
    ).rejects.toThrow();
    expect(await adapter.listSeatObservations()).toEqual([]);
  });

  it('parses into a record whose subject is a fresh object, not the caller\'s', () => {
    const input = { ...observation('obs-1'), schemaVersion: 1 };
    const parsed = parseVersionedSeatObservationStateRecord(input);
    expect(parsed.status).toBe('ok');
    if (parsed.status === 'ok') {
      expect(parsed.record.subject).toEqual(input.subject);
      expect(parsed.record.subject).not.toBe(input.subject);
    }
  });

  it('validates the same values it stores when a subject getter changes between reads', async () => {
    let reads = 0;
    const subject = {
      get attemptId(): string {
        reads += 1;
        return reads === 1 ? 'a1' : '';
      },
    };
    const outcome = await adapter
      .appendSeatObservation(observation('obs-g', { subject: subject as SeatObservationRecord['subject'] }))
      .catch(() => 'refused');
    const stored = await adapter.listSeatObservations();
    for (const item of stored) {
      expect((item.subject as { attemptId: string }).attemptId).not.toBe('');
    }
    expect(['appended', 'refused']).toContain(outcome);
  });

  it('refuses an unknown outcome or via', async () => {
    await expect(
      adapter.appendSeatObservation({ ...observation('obs-1'), outcome: 'bogus' as SeatObservationRecord['outcome'] }),
    ).rejects.toThrow();
    await expect(
      adapter.appendSeatObservation({ ...observation('obs-1'), via: 'web' as SeatObservationRecord['via'] }),
    ).rejects.toThrow();
  });

  it('isolates stored records from caller-retained aliases', async () => {
    const record = observation('obs-1');
    await adapter.appendSeatObservation(record);
    // Mutating the original object after append must not change the store.
    (record.subject as { attemptId: string }).attemptId = 'mutated';
    let list = await adapter.listSeatObservations();
    expect(list[0]).toEqual(observation('obs-1'));
    // Mutating a listed object must not change the store either.
    (list[0].subject as { attemptId: string }).attemptId = 'mutated-via-list';
    list = await adapter.listSeatObservations();
    expect(list[0]).toEqual(observation('obs-1'));
  });
});

describe('SeatObservationRepositoryAdapter (file mode)', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-sr3-seat-observations-'));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  });

  it('persists to seat-observations.json with schemaVersion 1 and re-reads from a second adapter', async () => {
    const adapter = new SeatObservationRepositoryAdapter({ stateDir });
    const record = observation('obs-1');
    expect(await adapter.appendSeatObservation(record)).toBe('appended');
    const onDisk: unknown[] = JSON.parse(await fs.readFile(path.join(stateDir, 'seat-observations.json'), 'utf8'));
    expect(onDisk).toHaveLength(1);
    expect((onDisk[0] as Record<string, unknown>).schemaVersion).toBe(1);

    const second = new SeatObservationRepositoryAdapter({ stateDir });
    expect(await second.listSeatObservations()).toEqual([record]);
  });

  it('does not write an invalid record to disk, so the store stays readable', async () => {
    const adapter = new SeatObservationRepositoryAdapter({ stateDir });
    await adapter.appendSeatObservation(observation('obs-1'));
    await expect(
      adapter.appendSeatObservation(
        observation('obs-2', {
          subject: { attemptId: 'a1', extra: true } as unknown as SeatObservationRecord['subject'],
        }),
      ),
    ).rejects.toThrow();
    const list = await new SeatObservationRepositoryAdapter({ stateDir }).listSeatObservations();
    expect(list.map((r) => r.observationId)).toEqual(['obs-1']);
  });

  it('refuses a symlinked store file, dangling or not, instead of reading it or calling it absent', async () => {
    const outside = path.join(stateDir, 'outside.json');
    await fs.writeFile(outside, JSON.stringify([]));
    const target = path.join(stateDir, 'seat-observations.json');
    await fs.symlink(outside, target);
    const adapter = new SeatObservationRepositoryAdapter({ stateDir });
    await expect(adapter.listSeatObservations()).rejects.toThrow(/regular file/);
    await fs.unlink(target);
    await fs.symlink(path.join(stateDir, 'nowhere.json'), target);
    await expect(adapter.listSeatObservations()).rejects.toThrow(/regular file/);
  });

  it('refuses an oversized store file', async () => {
    await fs.writeFile(path.join(stateDir, 'seat-observations.json'), Buffer.alloc(8 * 1024 * 1024 + 1, 32));
    const adapter = new SeatObservationRepositoryAdapter({ stateDir });
    await expect(adapter.listSeatObservations()).rejects.toThrow(/bytes/);
  });

  it('throws StateFileUnknownVersionError on schemaVersion 2 with no quarantine copy', async () => {
    await fs.writeFile(
      path.join(stateDir, 'seat-observations.json'),
      JSON.stringify([{ ...observation('obs-1'), schemaVersion: 2 }]),
    );
    const adapter = new SeatObservationRepositoryAdapter({ stateDir });
    await expect(adapter.listSeatObservations()).rejects.toBeInstanceOf(StateFileUnknownVersionError);
    await expect(fs.readdir(path.join(stateDir, 'quarantine'))).rejects.toThrow();
  });

  it('throws StateFileUnreadableError on invalid JSON and keeps a quarantine copy', async () => {
    await fs.writeFile(path.join(stateDir, 'seat-observations.json'), '{ not json');
    const adapter = new SeatObservationRepositoryAdapter({ stateDir });
    await expect(adapter.listSeatObservations()).rejects.toBeInstanceOf(StateFileUnreadableError);
    const quarantine = await fs.readdir(path.join(stateDir, 'quarantine'));
    expect(quarantine.length).toBeGreaterThan(0);
  });
});

describe('parseVersionedSeatObservationStateRecord subject validation', () => {
  const base = {
    version: 1,
    observationId: 'obs-1',
    seatId: 'seat-1',
    outcome: 'rate-limited',
    observedAtIso: '2026-11-06T00:00:00.000Z',
    via: 'cli',
  } as const;

  it('accepts exactly { attemptId } or { reviewRequestId }', () => {
    expect(
      parseVersionedSeatObservationStateRecord({ ...base, subject: { attemptId: 'a1' } }).status,
    ).toBe('ok');
    expect(
      parseVersionedSeatObservationStateRecord({ ...base, subject: { reviewRequestId: 'rr1' } }).status,
    ).toBe('ok');
  });

  it('rejects subjects with extra properties', () => {
    expect(
      parseVersionedSeatObservationStateRecord({ ...base, subject: { attemptId: 'a1', extra: true } })
        .status,
    ).toBe('invalid');
    expect(
      parseVersionedSeatObservationStateRecord({ ...base, subject: { reviewRequestId: 'rr1', extra: true } })
        .status,
    ).toBe('invalid');
    expect(
      parseVersionedSeatObservationStateRecord({ ...base, subject: { attemptId: 'a1', reviewRequestId: undefined } })
        .status,
    ).toBe('invalid');
  });

  it('rejects empty or both-key subjects', () => {
    expect(parseVersionedSeatObservationStateRecord({ ...base, subject: { attemptId: '' } }).status).toBe(
      'invalid',
    );
    expect(
      parseVersionedSeatObservationStateRecord({ ...base, subject: { attemptId: 'a1', reviewRequestId: 'rr1' } })
        .status,
    ).toBe('invalid');
    expect(parseVersionedSeatObservationStateRecord({ ...base, subject: {} }).status).toBe('invalid');
  });
});
