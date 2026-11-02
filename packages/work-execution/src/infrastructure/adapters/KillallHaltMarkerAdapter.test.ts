import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KillallHaltMarkerAdapter } from './KillallHaltMarkerAdapter.adapter.js';

const NOW = '2026-10-27T10:00:00.000Z';
const HALTED_RECORD = { version: 1, halted: true, changedAtIso: NOW };
const CLEAR_RECORD = { version: 1, halted: false, changedAtIso: NOW };

async function createTempStateDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function removeTempDir(dir: string | undefined): Promise<void> {
  if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function readMarkerFile(dir: string) {
  const file = path.join(dir, 'killall-halt.json');
  return {
    bytes: await fs.readFile(file, 'utf8'),
    mtimeMs: (await fs.stat(file)).mtimeMs,
  };
}

function makeFileAdapter(dir: string, fileName?: string) {
  return new KillallHaltMarkerAdapter({ stateDir: dir, ...(fileName ? { fileName } : {}) });
}

describe.each(['memory', 'file'] as const)('KillallHaltMarkerAdapter (%s)', (mode) => {
  const isFile = mode === 'file';
  let tempDir: string;
  let adapter: KillallHaltMarkerAdapter;

  beforeEach(async () => {
    if (isFile) {
      tempDir = await createTempStateDir('fleet-killall-halt-test-');
      adapter = makeFileAdapter(tempDir);
    } else {
      adapter = new KillallHaltMarkerAdapter();
    }
  });

  afterEach(async () => {
    if (isFile) {
      await removeTempDir(tempDir);
    }
  });

  it('a fresh state directory reads clear with no record', async () => {
    expect(await adapter.read()).toEqual({ state: 'clear' });
  });

  it('halting is changed once and unchanged the second time; nothing is rewritten when unchanged', async () => {
    expect(await adapter.set({ halted: true, nowIso: NOW })).toEqual({
      outcome: 'changed',
      record: HALTED_RECORD,
    });
    expect(await adapter.read()).toEqual({ state: 'halted' });

    let before: { bytes: string; mtimeMs: number } | null = null;
    if (isFile) {
      before = await readMarkerFile(tempDir);
    }

    expect(await adapter.set({ halted: true, nowIso: NOW })).toEqual({
      outcome: 'unchanged',
      record: HALTED_RECORD,
    });

    if (isFile && before !== null) {
      const file = path.join(tempDir, 'killall-halt.json');
      expect(await fs.readFile(file, 'utf8')).toBe(before.bytes);
      expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs);
    }
  });

  it('lifting a readable marker is changed and reads clear with the record', async () => {
    await adapter.set({ halted: true, nowIso: NOW });
    expect(await adapter.set({ halted: false, nowIso: NOW })).toEqual({
      outcome: 'changed',
      record: CLEAR_RECORD,
    });
    expect(await adapter.read()).toEqual({ state: 'clear' });
  });

  it.each([
    ['a time without a zone', '2026-10-27T10:00:00'],
    ['an impossible calendar date', '2026-02-31T10:00:00Z'],
  ])('refuses %s with invalid-request and writes nothing', async (_label, nowIso) => {
    expect(await adapter.set({ halted: true, nowIso })).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
    expect(await adapter.read()).toEqual({ state: 'clear' });
  });

  it('normalises a +02:00 time to Z in the stored record', async () => {
    const result = await adapter.set({ halted: true, nowIso: '2026-10-27T12:00:00+02:00' });
    expect(result.outcome === 'changed' && result.record.changedAtIso).toBe('2026-10-27T10:00:00.000Z');
  });
});

describe('KillallHaltMarkerAdapter file shape, unreadable marker and file names', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempStateDir('fleet-killall-halt-file-');
  });

  afterEach(async () => {
    await removeTempDir(tempDir);
  });

  it('always writes exactly one record; a fresh adapter reads back what the first wrote', async () => {
    const writer = makeFileAdapter(tempDir);
    await writer.set({ halted: true, nowIso: NOW });

    const raw = JSON.parse(await fs.readFile(path.join(tempDir, 'killall-halt.json'), 'utf8'));
    expect(Array.isArray(raw)).toBe(true);
    expect(raw).toHaveLength(1);
    expect(raw[0]).toEqual(HALTED_RECORD);

    const reader = makeFileAdapter(tempDir);
    expect(await reader.read()).toEqual({ state: 'halted' });
  });

  it('an unreadable marker reads as halted, keeps a quarantine copy and refuses a lift; halting over it writes', async () => {
    const garbage = '{ not json';
    const markerFile = path.join(tempDir, 'killall-halt.json');
    await fs.writeFile(markerFile, garbage, 'utf8');
    const adapter = makeFileAdapter(tempDir);

    const state = await adapter.read();
    expect(state).toEqual({ state: 'unreadable' });

    const quarantineDir = path.join(tempDir, 'quarantine');
    const entries = await fs.readdir(quarantineDir);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    for (const entry of entries) {
      const kept = await fs.readFile(path.join(quarantineDir, entry), 'utf8');
      expect(kept).toBe(garbage);
    }

    expect(await adapter.set({ halted: false, nowIso: NOW })).toEqual({
      outcome: 'refused',
      reason: 'marker-unreadable',
    });
    expect(await adapter.set({ halted: true, nowIso: NOW })).toEqual({
      outcome: 'changed',
      record: HALTED_RECORD,
    });
    expect(await adapter.read()).toEqual({ state: 'halted' });
  });

  it('refuses file names that collide with another store or are unsafe', async () => {
    const colliding = makeFileAdapter(tempDir, 'conductor-halt.json');
    await expect(colliding.read()).rejects.toThrow(/collides with another store/);

    const pauseColliding = makeFileAdapter(tempDir, 'killall-train-pause.json');
    await expect(pauseColliding.read()).rejects.toThrow(/collides with another store/);

    const escaping = makeFileAdapter(tempDir, '../x');
    await expect(escaping.read()).rejects.toThrow(/unsafe state file name/);
  });
});
