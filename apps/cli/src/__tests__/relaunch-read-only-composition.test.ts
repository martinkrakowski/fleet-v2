/**
 * CO29a-ro2: the read-only relaunch composition. The halt marker and driver
 * lease `relaunch inventory` reads are opened read-only: a corrupt store file
 * is never quarantined by the command, the typed unreadable error answers
 * instead, and every write is refused. The default (writable) instances keep
 * quarantining, unchanged.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ReadOnlyStateStoreError, StateFileUnreadableReadOnlyError } from '@fleet/work-execution';

import { composeReadOnlyRelaunch } from '../composition/relaunch.js';

describe('composeReadOnlyRelaunch', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-relaunch-composition-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('reads a corrupt halt marker as the typed unreadable state and writes nothing', async () => {
    const file = path.join(tempDir, 'conductor-halt.json');
    const garbage = '{ not json CANARY-bytes';
    await fs.writeFile(file, garbage, 'utf8');

    const { halt } = composeReadOnlyRelaunch({ stateDir: tempDir });
    expect(await halt.read()).toEqual({ state: 'unreadable' });
    expect(await fs.readFile(file, 'utf8')).toBe(garbage);
    await expect(fs.readdir(path.join(tempDir, 'quarantine'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('reads a corrupt driver lease as the typed unreadable error and writes nothing', async () => {
    const file = path.join(tempDir, 'conductor-driver-lease.json');
    const garbage = '{ not json CANARY-bytes';
    await fs.writeFile(file, garbage, 'utf8');

    const { driverLease } = composeReadOnlyRelaunch({ stateDir: tempDir });
    await expect(driverLease.read()).rejects.toBeInstanceOf(StateFileUnreadableReadOnlyError);
    expect(await fs.readFile(file, 'utf8')).toBe(garbage);
    await expect(fs.readdir(path.join(tempDir, 'quarantine'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses every write on both stores', async () => {
    const { halt, driverLease } = composeReadOnlyRelaunch({ stateDir: tempDir });
    await expect(halt.set({ halted: true, nowIso: '2026-11-15T00:00:00.000Z' })).rejects.toBeInstanceOf(
      ReadOnlyStateStoreError,
    );
    await expect(
      driverLease.acquire({
        holderId: 'driver-test',
        observedFence: 0,
        leaseUntilIso: '2026-11-15T00:02:00.000Z',
        nowIso: '2026-11-15T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(ReadOnlyStateStoreError);
    expect(await fs.readdir(tempDir)).toEqual([]);
  });

  it('absent files read as clear and absent', async () => {
    const { halt, driverLease } = composeReadOnlyRelaunch({ stateDir: tempDir });
    expect(await halt.read()).toEqual({ state: 'clear', record: null });
    expect(await driverLease.read()).toBeNull();
  });
});
