import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MergeTrainStateFileAdapter } from './MergeTrainStateFileAdapter.adapter.js';
import { writeJsonAtomically } from './TrainStoreFiles.helper.js';
import type { TrainStateSaveRequest } from '../../application/ports/out/MergeTrainStatePort.out-port.js';
import type {
  TrainLeaseAcquireRequest,
  TrainLeaseHoldRequest,
  TrainLeaseRenewRequest,
} from '../../application/use-cases/train-lease.js';
import type { TrainSnapshot } from '../../application/ports/out/MergeTrainStatePort.out-port.js';

describe('MergeTrainStateFileAdapter', () => {
  let tempDir: string;
  let adapter: MergeTrainStateFileAdapter;
  const trainId = 'train-1';
  const holderId = 'holder-1';
  const fence = 1;
  let now = '2026-11-02T20:00:00.000Z';
  const clock = { nowIso: () => now };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-train-state-test-'));
    adapter = new MergeTrainStateFileAdapter({ stateDir: tempDir, clock });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeSnapshot(tId: string): TrainSnapshot {
    return {
      train: {
        id: tId,
        schemaVersion: 1,
        repository: 'fleet/repo',
        baseBranch: 'main',
        generation: 1,
        currentBaseSha: '0123456789abcdef0123456789abcdef01234567',
      },
      entries: [],
      batches: [],
      candidates: [],
      gateReceipts: [],
      promotionReceipts: [],
    };
  }

  async function writeLease(tId = trainId, hId = holderId, f = fence, until = '2026-11-02T22:00:00.000Z'): Promise<void> {
    const dir = path.join(tempDir, 'merge-trains', tId);
    await fs.mkdir(dir, { recursive: true });
    await writeJsonAtomically(path.join(dir, 'lease.json'), {
      version: 1,
      holderId: hId,
      fence: f,
      leaseUntilIso: until,
    });
  }

  async function writeState(tId: string, revision: number, snapshot: TrainSnapshot): Promise<void> {
    const dir = path.join(tempDir, 'merge-trains', tId);
    await fs.mkdir(dir, { recursive: true });
    await writeJsonAtomically(path.join(dir, 'state.json'), {
      schemaVersion: 1,
      revision,
      snapshot,
    });
  }

  describe('readState and saveState basic operations', () => {
    it('returns null state when state.json is absent', async () => {
      const result = await adapter.readState(trainId);
      expect(result).toEqual({ outcome: 'ok', state: null });
    });

    it('saves initial state from absent (revision 0 -> 1) and reads it back', async () => {
      await writeLease();
      const snapshot = makeSnapshot(trainId);

      const saveResult = await adapter.saveState({
        trainId,
        expectedRevision: 0,
        holderId,
        fence,
        snapshot,
      });

      expect(saveResult).toEqual({ outcome: 'saved', revision: 1 });

      const readResult = await adapter.readState(trainId);
      expect(readResult).toEqual({
        outcome: 'ok',
        state: {
          revision: 1,
          snapshot,
        },
      });
    });

    it('refuses save on revision conflict', async () => {
      await writeLease();
      const snapshot = makeSnapshot(trainId);
      await writeState(trainId, 1, snapshot);

      const result = await adapter.saveState({
        trainId,
        expectedRevision: 0, // expected 0, but stored is 1
        holderId,
        fence,
        snapshot,
      });

      expect(result).toEqual({ outcome: 'refused', reason: 'revision-conflict' });
    });
  });

  describe('Finding 2: readState verifies snapshot.train.id === trainId', () => {
    it('returns unreadable when state file in train directory has a different train id', async () => {
      // Place train-1 snapshot inside train-2 directory
      const train1Snapshot = makeSnapshot('train-1');
      await writeState('train-2', 1, train1Snapshot);

      // Reading train-2 must return unreadable because snapshot.train.id is train-1
      const result = await adapter.readState('train-2');
      expect(result).toEqual({ outcome: 'unreadable' });
    });

    it('returns ok when snapshot.train.id matches trainId', async () => {
      const train2Snapshot = makeSnapshot('train-2');
      await writeState('train-2', 1, train2Snapshot);

      const result = await adapter.readState('train-2');
      expect(result).toEqual({
        outcome: 'ok',
        state: {
          revision: 1,
          snapshot: train2Snapshot,
        },
      });
    });

    it('refuses saveState with state-unreadable if existing state file on disk has another train id', async () => {
      await writeLease('train-2');
      const train1Snapshot = makeSnapshot('train-1');
      await writeState('train-2', 1, train1Snapshot);

      const train2Snapshot = makeSnapshot('train-2');
      const result = await adapter.saveState({
        trainId: 'train-2',
        expectedRevision: 1,
        holderId,
        fence,
        snapshot: train2Snapshot,
      });

      expect(result).toEqual({ outcome: 'refused', reason: 'state-unreadable' });
    });

    it('refuses saveState with invalid-snapshot if request snapshot train id does not match trainId', async () => {
      await writeLease('train-1');
      const train2Snapshot = makeSnapshot('train-2');

      const result = await adapter.saveState({
        trainId: 'train-1',
        expectedRevision: 0,
        holderId,
        fence,
        snapshot: train2Snapshot,
      });

      expect(result).toEqual({ outcome: 'refused', reason: 'invalid-snapshot' });
    });
  });

  describe('Finding 3: refuse save before writing when next revision is not safe', () => {
    it('passes validation on readState for stored revision of Number.MAX_SAFE_INTEGER', async () => {
      const snapshot = makeSnapshot(trainId);
      await writeState(trainId, Number.MAX_SAFE_INTEGER, snapshot);

      const readResult = await adapter.readState(trainId);
      expect(readResult).toEqual({
        outcome: 'ok',
        state: {
          revision: Number.MAX_SAFE_INTEGER,
          snapshot,
        },
      });
    });

    it('refuses saveState before writing when stored revision is Number.MAX_SAFE_INTEGER', async () => {
      await writeLease();
      const snapshot = makeSnapshot(trainId);
      await writeState(trainId, Number.MAX_SAFE_INTEGER, snapshot);

      const stateFile = path.join(tempDir, 'merge-trains', trainId, 'state.json');
      const contentBefore = await fs.readFile(stateFile, 'utf8');

      const result = await adapter.saveState({
        trainId,
        expectedRevision: Number.MAX_SAFE_INTEGER,
        holderId,
        fence,
        snapshot,
      });

      expect(result).toEqual({ outcome: 'refused', reason: 'revision-conflict' });

      // Verify the file was NOT modified
      const contentAfter = await fs.readFile(stateFile, 'utf8');
      expect(contentAfter).toBe(contentBefore);

      // Verify readState still returns ok with original MAX_SAFE_INTEGER
      const readResult = await adapter.readState(trainId);
      expect(readResult).toEqual({
        outcome: 'ok',
        state: {
          revision: Number.MAX_SAFE_INTEGER,
          snapshot,
        },
      });
    });

    it('successfully saves when stored revision is Number.MAX_SAFE_INTEGER - 1', async () => {
      await writeLease();
      const snapshot = makeSnapshot(trainId);
      const priorRevision = Number.MAX_SAFE_INTEGER - 1;
      await writeState(trainId, priorRevision, snapshot);

      const result = await adapter.saveState({
        trainId,
        expectedRevision: priorRevision,
        holderId,
        fence,
        snapshot,
      });

      expect(result).toEqual({ outcome: 'saved', revision: Number.MAX_SAFE_INTEGER });

      const readResult = await adapter.readState(trainId);
      expect(readResult).toEqual({
        outcome: 'ok',
        state: {
          revision: Number.MAX_SAFE_INTEGER,
          snapshot,
        },
      });
    });
  });

  describe('clock-decided expiry', () => {
    async function leaseBytes(): Promise<Buffer | null> {
      try {
        return await fs.readFile(path.join(tempDir, 'merge-trains', trainId, 'lease.json'));
      } catch {
        return null;
      }
    }

    async function stateExists(): Promise<boolean> {
      try {
        await fs.access(path.join(tempDir, 'merge-trains', trainId, 'state.json'));
        return true;
      } catch {
        return false;
      }
    }

    it('saveState refuses an expired lease whatever time a request claims', async () => {
      await writeLease(trainId, holderId, fence, '2026-11-02T19:00:00.000Z');
      const snapshot = makeSnapshot(trainId);
      const result = await adapter.saveState({
        trainId,
        expectedRevision: 0,
        holderId,
        fence,
        nowIso: '2026-11-01T00:00:00.000Z',
        snapshot,
      } as TrainStateSaveRequest);
      expect(result).toEqual({ outcome: 'refused', reason: 'lease-expired' });
      expect(await stateExists()).toBe(false);
    });

    it('renewLease of an expired lease is refused and lease.json is byte-identical', async () => {
      await writeLease(trainId, holderId, fence, '2026-11-02T19:00:00.000Z');
      const before = await leaseBytes();
      const result = await adapter.renewLease(trainId, { holderId, fence, leaseUntilIso: '2026-11-02T20:05:00.000Z' });
      expect(result).toEqual({ outcome: 'refused', reason: 'lease-expired' });
      expect(await leaseBytes()).toEqual(before);
    });

    it('renewLease with a request nowIso is refused invalid-request and writes nothing', async () => {
      await writeLease();
      const before = await leaseBytes();
      const result = await adapter.renewLease(trainId, {
        holderId,
        fence,
        leaseUntilIso: '2026-11-02T20:05:00.000Z',
        nowIso: '2026-11-02T20:00:00.000Z',
      } as TrainLeaseRenewRequest);
      expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
      expect(await leaseBytes()).toEqual(before);
    });

    it('renewLease by a foreign holder is refused lease-not-held and writes nothing', async () => {
      await writeLease();
      const before = await leaseBytes();
      const result = await adapter.renewLease(trainId, { holderId: 'holder-2', fence, leaseUntilIso: '2026-11-02T20:05:00.000Z' });
      expect(result).toEqual({ outcome: 'refused', reason: 'lease-not-held' });
      expect(await leaseBytes()).toEqual(before);
    });

    it('releaseLease with a future request nowIso is refused and does not extend the lease', async () => {
      await writeLease();
      const before = await leaseBytes();
      const result = await adapter.releaseLease(trainId, {
        holderId,
        fence,
        nowIso: '2026-11-02T23:59:59.000Z',
      } as TrainLeaseHoldRequest);
      expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
      expect(await leaseBytes()).toEqual(before);
    });

    it('releaseLease by the holder ends the lease at the clock time', async () => {
      await writeLease();
      const result = await adapter.releaseLease(trainId, { holderId, fence });
      expect(result).toEqual({
        outcome: 'ok',
        lease: {
          holderId,
          fence,
          leaseUntilIso: '2026-11-02T20:00:00.000Z',
        },
      });
      const stored = JSON.parse((await leaseBytes())!.toString('utf8'));
      expect(stored.leaseUntilIso).toBe('2026-11-02T20:00:00.000Z');
    });

    it('acquireLease with a request nowIso over an unexpired lease is refused and the holder is unchanged', async () => {
      await writeLease();
      const result = await adapter.acquireLease(trainId, {
        holderId: 'holder-2',
        observedFence: fence,
        leaseUntilIso: '2026-11-02T20:05:00.000Z',
        nowIso: '2026-11-02T20:00:00.000Z',
      } as TrainLeaseAcquireRequest);
      expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
      const stored = JSON.parse((await leaseBytes())!.toString('utf8'));
      expect(stored.holderId).toBe(holderId);
    });

    it('acquireLease over an unexpired lease is refused lease-held', async () => {
      await writeLease();
      const result = await adapter.acquireLease(trainId, {
        holderId: 'holder-2',
        observedFence: fence,
        leaseUntilIso: '2026-11-02T20:05:00.000Z',
      });
      expect(result).toEqual({ outcome: 'refused', reason: 'lease-held' });
      const stored = JSON.parse((await leaseBytes())!.toString('utf8'));
      expect(stored.holderId).toBe(holderId);
    });

    it('acquireLease takes a lapsed lease once the clock passes its end', async () => {
      await writeLease(trainId, holderId, fence, '2026-11-02T20:05:00.000Z');
      now = '2026-11-02T20:06:00.000Z';
      const result = await adapter.acquireLease(trainId, {
        holderId: 'holder-2',
        observedFence: fence,
        leaseUntilIso: '2026-11-02T20:16:00.000Z',
      });
      expect(result).toEqual({
        outcome: 'ok',
        lease: {
          holderId: 'holder-2',
          fence: 2,
          leaseUntilIso: '2026-11-02T20:16:00.000Z',
        },
      });
    });

    it('checkLease decides from the clock', async () => {
      await writeLease(trainId, holderId, fence, '2026-11-02T20:30:00.000Z');
      expect(await adapter.checkLease(trainId, { holderId, fence })).toBeNull();
      now = '2026-11-02T20:31:00.000Z';
      expect(await adapter.checkLease(trainId, { holderId, fence })).toBe('lease-expired');
    });

    const BAD_CLOCK_VALUES: readonly unknown[] = ['', 'garbage', '2026-11-02 20:00:00', '2026-13-45T00:00:00Z', 42, undefined];
    const BAD_CLOCKS: Array<[string, { nowIso: () => string }]> = [
      ...BAD_CLOCK_VALUES.map((v): [string, { nowIso: () => string }] => [
        typeof v === 'string' ? v : String(v),
        { nowIso: () => v as string },
      ]),
      ['throwing', { nowIso: () => { throw new Error('clock failure'); } }],
    ];

    it.each(BAD_CLOCKS)(
      'a malformed or throwing clock (%s) fails closed with no state change',
      async (_label: string, badClock: { nowIso: () => string }) => {
        const badAdapter = new MergeTrainStateFileAdapter({ stateDir: tempDir, clock: badClock });
        await writeLease();
        const before = await leaseBytes();

        const acquire = await badAdapter.acquireLease(trainId, { holderId: 'holder-2', observedFence: fence, leaseUntilIso: '2026-11-02T20:05:00.000Z' });
        expect(acquire).toEqual({ outcome: 'refused', reason: 'clock-unreadable' });
        expect(await leaseBytes()).toEqual(before);

        const renew = await badAdapter.renewLease(trainId, { holderId, fence, leaseUntilIso: '2026-11-02T20:05:00.000Z' });
        expect(renew).toEqual({ outcome: 'refused', reason: 'clock-unreadable' });
        expect(await leaseBytes()).toEqual(before);

        const release = await badAdapter.releaseLease(trainId, { holderId, fence });
        expect(release).toEqual({ outcome: 'refused', reason: 'clock-unreadable' });
        expect(await leaseBytes()).toEqual(before);

        const snapshot = makeSnapshot(trainId);
        const save = await badAdapter.saveState({ trainId, expectedRevision: 0, holderId, fence, snapshot });
        expect(save).toEqual({ outcome: 'refused', reason: 'clock-unreadable' });
        expect(await stateExists()).toBe(false);

        expect(await badAdapter.checkLease(trainId, { holderId, fence })).toBe('clock-unreadable');
      },
    );

    it('defaults to the system clock', async () => {
      const systemAdapter = new MergeTrainStateFileAdapter({ stateDir: tempDir });
      const snapshot = makeSnapshot(trainId);
      await writeLease(trainId, holderId, fence, '2999-01-01T00:00:00.000Z');
      expect(await systemAdapter.saveState({ trainId, expectedRevision: 0, holderId, fence, snapshot })).toEqual({ outcome: 'saved', revision: 1 });
      await writeLease(trainId, holderId, fence, '2000-01-01T00:00:00.000Z');
      expect(await systemAdapter.saveState({ trainId, expectedRevision: 0, holderId, fence, snapshot })).toEqual({ outcome: 'refused', reason: 'lease-expired' });
    });
  });
});
