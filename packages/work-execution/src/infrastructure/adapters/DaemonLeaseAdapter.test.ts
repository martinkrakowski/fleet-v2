import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DaemonLeaseAdapter } from './DaemonLeaseAdapter.adapter.js';

const NOW = '2026-10-27T10:00:00.000Z';
const IN_2_MIN = '2026-10-27T10:02:00.000Z';
// Daemon holder ids must match the daemon tick id pattern; assembled so no
// credential-shaped literal appears.
const TOKEN = { holderId: `tick-${'0'}${'A'.repeat(25)}`, fence: 1 };

describe.each(['memory', 'file'] as const)('DaemonLeaseAdapter verifyFence (%s)', (mode) => {
  const isFile = mode === 'file';
  let tempDir: string;
  let adapter: DaemonLeaseAdapter;

  beforeEach(async () => {
    if (isFile) {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-daemon-lease-test-'));
      adapter = new DaemonLeaseAdapter({ stateDir: tempDir });
    } else {
      adapter = new DaemonLeaseAdapter();
    }
  });

  afterEach(async () => {
    if (isFile) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('the daemon lease verifies per scope and one scope\'s token is no-lease on another', async () => {
    const acquire = {
      holderId: TOKEN.holderId, observedFence: 0, leaseUntilIso: IN_2_MIN, nowIso: NOW, scope: 'notifier',
    };
    expect(await adapter.acquire(acquire)).toEqual({
      outcome: 'ok',
      lease: { version: 1, scope: 'notifier', holderId: TOKEN.holderId, fence: 1, leaseUntilIso: IN_2_MIN },
    });

    // The holder's own token verifies for its scope.
    expect(await adapter.verifyFence('notifier', TOKEN, NOW)).toBeNull();
    // A mismatched holder or fence is refused per the fence distinctions.
    expect(await adapter.verifyFence('notifier', { ...TOKEN, fence: 2 }, NOW)).toBe('fence-ahead');
    expect(await adapter.verifyFence('notifier', { holderId: 'driver-b', fence: 1 }, NOW)).toBe(
      'holder-mismatch',
    );
    // The same token on another scope is no-lease: leases are per scope.
    expect(await adapter.verifyFence('other', TOKEN, NOW)).toBe('no-lease');
    // An invalid token is invalid-token before any lease lookup.
    expect(await adapter.verifyFence('notifier', { holderId: TOKEN.holderId }, NOW)).toBe(
      'invalid-token',
    );
  });

  it('an unreadable daemon lease file or unsafe scope refuses no-lease-readable', async () => {
    const acquire = {
      holderId: TOKEN.holderId, observedFence: 0, leaseUntilIso: IN_2_MIN, nowIso: NOW, scope: 'notifier',
    };
    await adapter.acquire(acquire);

    if (isFile) {
      await fs.writeFile(
        path.join(tempDir, 'daemon', 'leases', 'notifier.json'),
        '{ not json',
        'utf8',
      );
      expect(await adapter.verifyFence('notifier', TOKEN, NOW)).toBe('no-lease-readable');
      const readonlyAdapter = new DaemonLeaseAdapter({ stateDir: tempDir, readOnly: true });
      expect(await readonlyAdapter.verifyFence('notifier', TOKEN, NOW)).toBe('no-lease-readable');
    } else {
      // In memory the lease is readable: the holder's token verifies.
      expect(await adapter.verifyFence('notifier', TOKEN, NOW)).toBeNull();
      expect(await adapter.verifyFence('absent', TOKEN, NOW)).toBe('no-lease');
    }

    // An unsafe or empty scope is no-lease-readable, never an uncaught throw.
    expect(await adapter.verifyFence('', TOKEN, NOW)).toBe('no-lease-readable');
    expect(await adapter.verifyFence('a/b/c', TOKEN, NOW)).toBe('no-lease-readable');
    expect(await adapter.verifyFence('..', TOKEN, NOW)).toBe('no-lease-readable');
  });
});
