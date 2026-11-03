import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BriefReadRecord } from '../../../domain/lane-activity-records.js';
import { BriefReadRepositoryAdapter } from '../BriefReadRepositoryAdapter.adapter.js';

const LANE = { kind: 'plan', projectId: 'example-project', planId: 'plan-1', laneId: 'lane-1' } as const;
const OTHER_LANE = { kind: 'plan', projectId: 'example-project', planId: 'plan-1', laneId: 'lane-2' } as const;

function record(readAtIso: string, overrides: Partial<BriefReadRecord> = {}): BriefReadRecord {
  return {
    version: 1,
    lane: LANE,
    path: 'docs/plans/plan-1/lane-1.brief.md',
    outcome: 'read',
    sha256: 'a'.repeat(64),
    bytes: 42,
    readAtIso,
    ...overrides,
  };
}

describe('BriefReadRepositoryAdapter', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-brief-reads-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('round-trips a put through the real file and a fresh adapter', async () => {
    const writer = new BriefReadRepositoryAdapter({ stateDir: tempDir });
    expect(await writer.put(record('2026-10-27T10:00:00.000Z'))).toEqual({ outcome: 'saved', revision: 1 });

    const reader = new BriefReadRepositoryAdapter({ stateDir: tempDir });
    expect(await reader.latest(LANE)).toEqual(record('2026-10-27T10:00:00.000Z'));
    expect(await reader.latest(OTHER_LANE)).toBeNull();
  });

  it('keeps exactly one record per lane after two puts, in the file too', async () => {
    const adapter = new BriefReadRepositoryAdapter({ stateDir: tempDir });
    await adapter.put(record('2026-10-27T10:00:00.000Z'));
    await adapter.put(record('2026-10-27T10:05:00.000Z'));
    await adapter.put(record('2026-10-27T10:06:00.000Z', { lane: OTHER_LANE }));

    const raw = JSON.parse(await fs.readFile(path.join(tempDir, 'brief-reads.json'), 'utf8')) as unknown[];
    expect(raw).toHaveLength(2);
    const laneLatest = await adapter.latest(LANE);
    expect(laneLatest!.readAtIso).toBe('2026-10-27T10:05:00.000Z');
  });

  it('an interleaved write is refused with no file corruption', async () => {
    const target = path.join(tempDir, 'brief-reads.json');
    const first = new BriefReadRepositoryAdapter({ stateDir: tempDir });
    await first.put(record('2026-10-27T10:00:00.000Z'));

    // Simulate a concurrent writer that replaced the file after the read:
    // the second adapter's lock-holding put re-reads under the lock, so it
    // still succeeds; a corrupted store instead refuses.
    await fs.writeFile(target, '}{ broken', 'utf8');
    const broken = new BriefReadRepositoryAdapter({ stateDir: tempDir });
    expect(await broken.latest(LANE)).toBeNull();
    expect((await broken.put(record('2026-10-27T10:05:00.000Z'))).outcome).toBe('refused');
    const afterRefusal = await fs.readFile(target, 'utf8');
    expect(afterRefusal).toEqual('}{ broken');
  });

  it('a genuine interleaved write between read and write is refused by the CAS, leaving the file intact', async () => {
    const target = path.join(tempDir, 'brief-reads.json');
    const rogue = JSON.stringify([record('2026-10-27T09:00:00.000Z', { lane: OTHER_LANE })], null, 2);
    const first = new BriefReadRepositoryAdapter({ stateDir: tempDir });
    await first.put(record('2026-10-27T10:00:00.000Z'));

    // A writer that bypasses the lock replaces the file exactly between the
    // adapter's list read and its compare-and-swap re-read.
    const raced = new BriefReadRepositoryAdapter({
      stateDir: tempDir,
      onLockMidWrite: async () => {
        await fs.writeFile(target, rogue, 'utf8');
      },
    });
    const result = await raced.put(record('2026-10-27T10:05:00.000Z'));
    expect(result).toEqual({ outcome: 'refused', reason: 'the brief-read store changed during the write; no write was made' });
    expect(await fs.readFile(target, 'utf8')).toEqual(rogue);
    const reader = new BriefReadRepositoryAdapter({ stateDir: tempDir });
    expect((await reader.latest(OTHER_LANE))!.readAtIso).toBe('2026-10-27T09:00:00.000Z');
    expect(await reader.latest(LANE)).toBeNull();
  });

  it('an unparsable file quarantines and reads as null', async () => {
    await fs.writeFile(path.join(tempDir, 'brief-reads.json'), 'nope', 'utf8');
    const adapter = new BriefReadRepositoryAdapter({ stateDir: tempDir });
    expect(await adapter.latest(LANE)).toBeNull();
    expect((await adapter.put(record('2026-10-27T10:00:00.000Z'))).outcome).toBe('refused');
    const quarantine = await fs.readdir(path.join(tempDir, 'quarantine'));
    expect(quarantine.some((name) => name.startsWith('brief-reads.json.'))).toBe(true);
  });

  it('the in-memory variant replaces per lane', async () => {
    const adapter = new BriefReadRepositoryAdapter();
    await adapter.put(record('2026-10-27T10:00:00.000Z'));
    await adapter.put(record('2026-10-27T10:05:00.000Z'));
    await adapter.put(record('2026-10-27T10:06:00.000Z', { lane: OTHER_LANE }));
    expect((await adapter.latest(LANE))!.readAtIso).toBe('2026-10-27T10:05:00.000Z');
    expect((await adapter.latest(OTHER_LANE))!.readAtIso).toBe('2026-10-27T10:06:00.000Z');
  });
});
