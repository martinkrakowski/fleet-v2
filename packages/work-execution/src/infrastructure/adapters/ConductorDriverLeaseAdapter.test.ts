import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StateFileUnreadableError } from './file-store.js';
import { ConductorDriverLeaseAdapter } from './ConductorDriverLeaseAdapter.adapter.js';

const NOW = '2026-10-27T10:00:00.000Z';
const IN_2_MIN = '2026-10-27T10:02:00.000Z';
const LAPSE_NOW = '2026-10-27T10:03:00.000Z';
const LAPSE_UNTIL = '2026-10-27T10:04:00.000Z';

const ACQUIRE = { holderId: 'driver-example-1', observedFence: 0, leaseUntilIso: IN_2_MIN, nowIso: NOW };
const HOLD = { holderId: 'driver-example-1', fence: 1, nowIso: NOW };

describe.each(['memory', 'file'] as const)('ConductorDriverLeaseAdapter (%s)', (mode) => {
  const isFile = mode === 'file';
  let tempDir: string;
  let adapter: ConductorDriverLeaseAdapter;

  beforeEach(async () => {
    if (isFile) {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-conductor-driver-lease-test-'));
      adapter = new ConductorDriverLeaseAdapter({ stateDir: tempDir });
    } else {
      adapter = new ConductorDriverLeaseAdapter();
    }
  });

  afterEach(async () => {
    if (isFile) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('read() on nothing is null; acquire with observedFence 0 is fence 1 and read() returns it', async () => {
    expect(await adapter.read()).toBeNull();
    expect(await adapter.acquire(ACQUIRE)).toEqual({
      outcome: 'ok',
      lease: { version: 1, holderId: 'driver-example-1', fence: 1, leaseUntilIso: IN_2_MIN },
    });
    expect(await adapter.read()).toEqual({
      version: 1,
      holderId: 'driver-example-1',
      fence: 1,
      leaseUntilIso: IN_2_MIN,
    });
  });

  it('a second driver is refused while the lease is live; after lapse it takes fence 2 and the old holder fails', async () => {
    await adapter.acquire(ACQUIRE);

    expect(
      await adapter.acquire({ holderId: 'driver-b', observedFence: 1, leaseUntilIso: IN_2_MIN, nowIso: NOW }),
    ).toEqual({ outcome: 'refused', reason: 'lease-held' });

    expect(
      await adapter.acquire({
        holderId: 'driver-b',
        observedFence: 1,
        leaseUntilIso: LAPSE_UNTIL,
        nowIso: LAPSE_NOW,
      }),
    ).toEqual({
      outcome: 'ok',
      lease: { version: 1, holderId: 'driver-b', fence: 2, leaseUntilIso: LAPSE_UNTIL },
    });

    const staleHold = { holderId: 'driver-example-1', fence: 1, nowIso: LAPSE_NOW };
    expect(await adapter.renew({ ...staleHold, leaseUntilIso: LAPSE_UNTIL })).toEqual({
      outcome: 'refused',
      reason: 'lease-not-held',
    });
    expect(await adapter.release(staleHold)).toEqual({ outcome: 'refused', reason: 'lease-not-held' });
    expect(await adapter.check(staleHold)).toBe('lease-not-held');
  });

  it('release keeps holder and fence and ends the lease at NOW; a later acquire with the released fence raises the fence', async () => {
    await adapter.acquire(ACQUIRE);
    expect(await adapter.release(HOLD)).toEqual({
      outcome: 'ok',
      lease: { version: 1, holderId: 'driver-example-1', fence: 1, leaseUntilIso: NOW },
    });
    expect(await adapter.read()).toEqual({
      version: 1,
      holderId: 'driver-example-1',
      fence: 1,
      leaseUntilIso: NOW,
    });

    expect(
      await adapter.acquire({ holderId: 'driver-b', observedFence: 1, leaseUntilIso: IN_2_MIN, nowIso: NOW }),
    ).toEqual({
      outcome: 'ok',
      lease: { version: 1, holderId: 'driver-b', fence: 2, leaseUntilIso: IN_2_MIN },
    });
  });

  it('concurrency: two acquires of a lapsed lease with the same observed fence yield exactly one ok', async () => {
    await adapter.acquire(ACQUIRE);
    await adapter.release(HOLD); // lapsed at NOW

    const first = isFile ? new ConductorDriverLeaseAdapter({ stateDir: tempDir }) : adapter;
    const second = isFile ? new ConductorDriverLeaseAdapter({ stateDir: tempDir }) : adapter;

    const request = { holderId: 'driver-b', observedFence: 1, leaseUntilIso: IN_2_MIN, nowIso: NOW };
    const results = await Promise.all([first.acquire(request), second.acquire(request)]);
    expect(results.map((result) => result.outcome).sort()).toEqual(['ok', 'refused']);
    const refused = results.find((result) => result.outcome === 'refused');
    expect(refused?.outcome === 'refused' && refused.reason).toBe('lease-held');
  });
});

describe('ConductorDriverLeaseAdapter file shape, read-back and quarantine', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-conductor-driver-lease-file-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('always writes exactly one record; a fresh adapter reads back what the first wrote', async () => {
    const writer = new ConductorDriverLeaseAdapter({ stateDir: tempDir });
    await writer.acquire(ACQUIRE);

    const raw = JSON.parse(await fs.readFile(path.join(tempDir, 'conductor-driver-lease.json'), 'utf8'));
    expect(Array.isArray(raw)).toBe(true);
    expect(raw).toHaveLength(1);
    expect(raw[0]).toEqual({ version: 1, holderId: 'driver-example-1', fence: 1, leaseUntilIso: IN_2_MIN });

    const reader = new ConductorDriverLeaseAdapter({ stateDir: tempDir });
    expect(await reader.read()).toEqual({
      version: 1,
      holderId: 'driver-example-1',
      fence: 1,
      leaseUntilIso: IN_2_MIN,
    });
  });

  it('reads a hand-written list of two valid records as the higher fence, the last of equal fences', async () => {
    const lower = { version: 1, holderId: 'driver-a', fence: 1, leaseUntilIso: IN_2_MIN };
    const higher = { version: 1, holderId: 'driver-b', fence: 2, leaseUntilIso: IN_2_MIN };
    const file = path.join(tempDir, 'conductor-driver-lease.json');
    const adapter = new ConductorDriverLeaseAdapter({ stateDir: tempDir });

    await fs.writeFile(file, JSON.stringify([lower, higher]));
    expect(await adapter.read()).toEqual(higher);

    const again = { version: 1, holderId: 'driver-c', fence: 2, leaseUntilIso: IN_2_MIN };
    await fs.writeFile(file, JSON.stringify([higher, again]));
    expect(await adapter.read()).toEqual(again);
  });

  it.each([
    ['an invalid record', JSON.stringify([{ bogus: true }])],
    ['not JSON', '{ not json'],
  ])('quarantines %s with the exact bytes kept on read and acquire', async (_label, garbage) => {
    await fs.writeFile(path.join(tempDir, 'conductor-driver-lease.json'), garbage, 'utf8');
    const adapter = new ConductorDriverLeaseAdapter({ stateDir: tempDir });
    await expect(adapter.read()).rejects.toBeInstanceOf(StateFileUnreadableError);
    await expect(adapter.acquire(ACQUIRE)).rejects.toBeInstanceOf(StateFileUnreadableError);
    const quarantineDir = path.join(tempDir, 'quarantine');
    const entries = await fs.readdir(quarantineDir);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    for (const entry of entries) {
      const kept = await fs.readFile(path.join(quarantineDir, entry), 'utf8');
      expect(kept).toBe(garbage);
    }
  });

  it('refuses file names that collide with another store or are unsafe', async () => {
    const colliding = new ConductorDriverLeaseAdapter({ stateDir: tempDir, fileName: 'lane-runs.json' });
    await expect(colliding.read()).rejects.toThrow(/collides with another store/);

    const escaping = new ConductorDriverLeaseAdapter({ stateDir: tempDir, fileName: '../x.json' });
    await expect(escaping.read()).rejects.toThrow(/unsafe state file name/);
  });
});
