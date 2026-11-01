import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isConductorHalted, readConductorHaltRecord } from '../../domain/conductor-halt.js';
import { ConductorHaltAdapter } from './ConductorHaltAdapter.adapter.js';
import { ReadOnlyStateStoreError } from './file-store.js';

const NOW = '2026-10-27T10:00:00.000Z';
const HALTED_RECORD = { version: 1, halted: true, changedAtIso: NOW };
const CLEAR_RECORD = { version: 1, halted: false, changedAtIso: NOW };

describe.each(['memory', 'file'] as const)('ConductorHaltAdapter (%s)', (mode) => {
  const isFile = mode === 'file';
  let tempDir: string;
  let adapter: ConductorHaltAdapter;

  beforeEach(async () => {
    if (isFile) {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-conductor-halt-test-'));
      adapter = new ConductorHaltAdapter({ stateDir: tempDir });
    } else {
      adapter = new ConductorHaltAdapter();
    }
  });

  afterEach(async () => {
    if (isFile) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('a fresh state directory reads clear with no record', async () => {
    expect(await adapter.read()).toEqual({ state: 'clear', record: null });
    expect(isConductorHalted(await adapter.read())).toBe(false);
  });

  it('halting is changed once and unchanged the second time; nothing is rewritten when unchanged', async () => {
    expect(await adapter.set({ halted: true, nowIso: NOW })).toEqual({
      outcome: 'changed',
      record: HALTED_RECORD,
    });
    expect(await adapter.read()).toEqual({ state: 'halted', record: HALTED_RECORD });
    expect(isConductorHalted(await adapter.read())).toBe(true);

    let before: { bytes: string; mtimeMs: number } | null = null;
    if (isFile) {
      const file = path.join(tempDir, 'conductor-halt.json');
      before = {
        bytes: await fs.readFile(file, 'utf8'),
        mtimeMs: (await fs.stat(file)).mtimeMs,
      };
    }

    expect(await adapter.set({ halted: true, nowIso: NOW })).toEqual({
      outcome: 'unchanged',
      record: HALTED_RECORD,
    });

    if (isFile && before !== null) {
      const file = path.join(tempDir, 'conductor-halt.json');
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
    expect(await adapter.read()).toEqual({ state: 'clear', record: CLEAR_RECORD });
    expect(isConductorHalted(await adapter.read())).toBe(false);
  });

  it.each([
    ['a time without a zone', '2026-10-27T10:00:00'],
    ['an impossible calendar date', '2026-02-31T10:00:00Z'],
  ])('refuses %s with invalid-request and writes nothing', async (_label, nowIso) => {
    expect(await adapter.set({ halted: true, nowIso })).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
    expect(await adapter.read()).toEqual({ state: 'clear', record: null });
  });

  it('normalises a +02:00 time to Z in the stored record', async () => {
    const result = await adapter.set({ halted: true, nowIso: '2026-10-27T12:00:00+02:00' });
    expect(result.outcome === 'changed' && result.record.changedAtIso).toBe('2026-10-27T10:00:00.000Z');
  });
});

describe('ConductorHaltAdapter file shape, unreadable marker and file names', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-conductor-halt-file-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('always writes exactly one record; a fresh adapter reads back what the first wrote', async () => {
    const writer = new ConductorHaltAdapter({ stateDir: tempDir });
    await writer.set({ halted: true, nowIso: NOW });

    const raw = JSON.parse(await fs.readFile(path.join(tempDir, 'conductor-halt.json'), 'utf8'));
    expect(Array.isArray(raw)).toBe(true);
    expect(raw).toHaveLength(1);
    expect(raw[0]).toEqual(HALTED_RECORD);

    const reader = new ConductorHaltAdapter({ stateDir: tempDir });
    expect(await reader.read()).toEqual({ state: 'halted', record: HALTED_RECORD });
  });

  it('an unreadable marker reads as halted, keeps a quarantine copy and refuses a lift; halting over it writes', async () => {
    const garbage = '{ not json';
    const file = path.join(tempDir, 'conductor-halt.json');
    await fs.writeFile(file, garbage, 'utf8');
    const adapter = new ConductorHaltAdapter({ stateDir: tempDir });

    const state = await adapter.read();
    expect(state).toEqual({ state: 'unreadable' });
    expect(isConductorHalted(state)).toBe(true);

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
    expect(await adapter.read()).toEqual({ state: 'halted', record: HALTED_RECORD });
  });

  it('refuses file names that collide with another store or are unsafe', async () => {
    const colliding = new ConductorHaltAdapter({ stateDir: tempDir, fileName: 'lane-runs.json' });
    await expect(colliding.read()).rejects.toThrow(/collides with another store/);

    const escaping = new ConductorHaltAdapter({ stateDir: tempDir, fileName: '../x' });
    await expect(escaping.read()).rejects.toThrow(/unsafe state file name/);
  });
});

describe('readConductorHaltRecord', () => {
  it.each([
    [
      'a non-record',
      'no',
      'ConductorHalt must be a record with exactly version, halted and changedAtIso',
    ],
    ['a wrong version', { version: 2, halted: true, changedAtIso: NOW }, 'ConductorHalt version must be 1'],
    [
      'a non-boolean halted',
      { version: 1, halted: 'yes', changedAtIso: NOW },
      'ConductorHalt halted must be a boolean',
    ],
    [
      'a time without a zone',
      { version: 1, halted: true, changedAtIso: '2026-10-27T10:00:00' },
      'ConductorHalt changedAtIso must be an ISO-8601 time with a zone',
    ],
  ])('refuses %s with the fixed message and no echoed value', (_label, input, message) => {
    const result = readConductorHaltRecord(input);
    expect(result).toEqual({ ok: false, error: message });
    expect(result.ok === false && result.error.includes('XYZZY')).toBe(false);
  });

  it('reads a valid record and never echoes a distinctive input', () => {
    expect(readConductorHaltRecord({ version: 1, halted: false, changedAtIso: NOW })).toEqual({
      ok: true,
      record: CLEAR_RECORD,
    });
    const bad = readConductorHaltRecord({ version: 1, halted: true, changedAtIso: 'XYZZY' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).not.toContain('XYZZY');
    }
  });
});

describe('ConductorHaltAdapter read-only mode', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-conductor-halt-readonly-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('read-only leaves a malformed marker untouched while the default quarantines it', async () => {
    const garbage = '{ not json CANARY-bytes';
    const file = path.join(tempDir, 'conductor-halt.json');
    await fs.writeFile(file, garbage, 'utf8');

    const readonlyAdapter = new ConductorHaltAdapter({ stateDir: tempDir, readOnly: true });
    expect(await readonlyAdapter.read()).toEqual({ state: 'unreadable' });
    expect(await fs.readFile(file, 'utf8')).toBe(garbage);
    await expect(fs.readdir(path.join(tempDir, 'quarantine'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const defaultAdapter = new ConductorHaltAdapter({ stateDir: tempDir });
    expect(await defaultAdapter.read()).toEqual({ state: 'unreadable' });
    const entries = await fs.readdir(path.join(tempDir, 'quarantine'));
    expect(entries).toHaveLength(1);
    expect(await fs.readFile(path.join(tempDir, 'quarantine', entries[0]), 'utf8')).toBe(garbage);

    await expect(
      readonlyAdapter.set({ halted: true, nowIso: NOW }),
    ).rejects.toBeInstanceOf(ReadOnlyStateStoreError);
  });
});
