// Lane OD7a3: DaemonEventProjectionAdapter tests for the OD7a3 contract
// additions — `eventPositions` (each returned event's 0-based file line
// index, parallel to `events`) and `droppedLines` (the 0-based indexes of
// every unparsable line). Real temp state directories; no external commands.
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  projectJobOutcomeToDaemonEvent,
  serializeDaemonEventHeader,
  serializeDaemonEventLine,
  type DaemonEventRecord,
} from '../../../domain/daemon-events.js';
import { DaemonEventProjectionAdapter } from '../DaemonEventProjectionAdapter.adapter.js';

const TICK_ID = 'tick-0AAAAAAAAAAAAAAAAAAAAAAAAA';

function eventFixture(n: number, recordedAtIso?: string): DaemonEventRecord {
  const read = projectJobOutcomeToDaemonEvent({
    eventId: `01JB00000000000000000000${String(n).padStart(2, '0')}`,
    tickId: TICK_ID,
    jobId: 'notifier',
    jobOutcome: { outcome: 'completed', progressed: true },
    recordedAtIso: recordedAtIso ?? '2026-11-16T09:00:00.000Z',
  });
  if (!read.ok) {
    throw new Error('invalid event fixture');
  }
  return read.record;
}

describe('DaemonEventProjectionAdapter (OD7a3 positions and dropped lines)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-daemon-projection-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns parallel eventPositions and an empty droppedLines for a clean file', async () => {
    const adapter = new DaemonEventProjectionAdapter({ stateDir: tempDir });
    const a = eventFixture(0);
    const b = eventFixture(1);
    await adapter.append([a, b]);
    const read = await adapter.readAfterCursor(null);
    if (!read.ok) {
      throw new Error('expected an ok read');
    }
    expect(read.events).toEqual([a, b]);
    expect(read.eventPositions).toEqual([1, 2]);
    expect(read.droppedLines).toEqual([]);
    expect(read.nextCursor).toBe(b.eventId);
  });

  it('records the 0-based indexes of corrupt lines in droppedLines, skipping blanks and the header', async () => {
    const target = path.join(tempDir, 'daemon', 'events.jsonl');
    await fs.mkdir(path.dirname(target), { recursive: true });
    const a = eventFixture(0);
    const b = eventFixture(1);
    const lines = [
      serializeDaemonEventHeader(),
      serializeDaemonEventLine(a) ?? '',
      '{ not json',
      '',
      serializeDaemonEventLine(b) ?? '',
      '{"version":1,"kind":"nonsense"}',
      '',
    ];
    await fs.writeFile(target, lines.map((line) => `${line}\n`).join(''), 'utf8');
    const adapter = new DaemonEventProjectionAdapter({ stateDir: tempDir });
    const read = await adapter.readAfterCursor(null);
    if (!read.ok) {
      throw new Error('expected an ok read');
    }
    expect(read.events).toEqual([a, b]);
    expect(read.eventPositions).toEqual([1, 4]);
    expect(read.droppedLines).toEqual([2, 5]);
  });

  it('slices eventPositions to the suffix when reading after a cursor', async () => {
    const adapter = new DaemonEventProjectionAdapter({ stateDir: tempDir });
    const a = eventFixture(0);
    const b = eventFixture(1);
    const c = eventFixture(2);
    const target = path.join(tempDir, 'daemon', 'events.jsonl');
    await fs.mkdir(path.dirname(target), { recursive: true });
    const lines = [
      serializeDaemonEventHeader(),
      serializeDaemonEventLine(a) ?? '',
      'corrupt line',
      serializeDaemonEventLine(b) ?? '',
      serializeDaemonEventLine(c) ?? '',
    ];
    await fs.writeFile(target, lines.map((line) => `${line}\n`).join(''), 'utf8');
    const read = await adapter.readAfterCursor(a.eventId);
    if (!read.ok) {
      throw new Error('expected an ok read');
    }
    expect(read.events).toEqual([b, c]);
    expect(read.eventPositions).toEqual([3, 4]);
    expect(read.droppedLines).toEqual([2]);
  });

  it('answers a missing file with empty events, positions and dropped lines', async () => {
    const adapter = new DaemonEventProjectionAdapter({ stateDir: tempDir });
    const read = await adapter.readAfterCursor(null);
    expect(read).toEqual({ ok: true, events: [], nextCursor: null, eventPositions: [], droppedLines: [] });
  });

  it('answers an in-memory projection with index positions and no dropped lines', async () => {
    const adapter = new DaemonEventProjectionAdapter();
    const a = eventFixture(0);
    const b = eventFixture(1);
    await adapter.append([a, b]);
    const read = await adapter.readAfterCursor(null);
    if (!read.ok) {
      throw new Error('expected an ok read');
    }
    expect(read.events).toEqual([a, b]);
    expect(read.eventPositions).toEqual([0, 1]);
    expect(read.droppedLines).toEqual([]);
  });
});
