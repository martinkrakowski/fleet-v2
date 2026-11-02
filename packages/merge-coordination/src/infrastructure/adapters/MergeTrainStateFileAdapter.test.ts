import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MergeTrainStateFileAdapter } from './MergeTrainStateFileAdapter.adapter.js';
import { writeJsonAtomically } from './TrainStoreFiles.helper.js';
import type { TrainSnapshot } from '../../application/ports/out/MergeTrainStatePort.out-port.js';

describe('MergeTrainStateFileAdapter', () => {
  let tempDir: string;
  let adapter: MergeTrainStateFileAdapter;
  const trainId = 'train-1';
  const holderId = 'holder-1';
  const fence = 1;
  const nowIso = '2026-11-02T20:00:00.000Z';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-train-state-test-'));
    adapter = new MergeTrainStateFileAdapter({ stateDir: tempDir });
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

  async function writeLease(tId = trainId, hId = holderId, f = fence): Promise<void> {
    const dir = path.join(tempDir, 'merge-trains', tId);
    await fs.mkdir(dir, { recursive: true });
    await writeJsonAtomically(path.join(dir, 'lease.json'), {
      version: 1,
      holderId: hId,
      fence: f,
      leaseUntilIso: '2026-11-02T22:00:00.000Z',
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
        nowIso,
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
        nowIso,
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
        nowIso,
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
        nowIso,
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
        nowIso,
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
        nowIso,
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
});
