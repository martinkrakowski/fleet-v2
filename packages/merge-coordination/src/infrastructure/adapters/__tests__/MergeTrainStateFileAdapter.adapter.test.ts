import { afterEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';

import { MergeTrainStateFileAdapter } from '../MergeTrainStateFileAdapter.adapter.js';
import { trainDirectory } from '../TrainStoreFiles.helper.js';
import type { TrainSnapshot } from '../../../application/ports/out/MergeTrainStatePort.out-port.js';
import type { TrainRecord } from '../../../domain/entities/TrainRecord.js';
import type { QueueEntryRecord } from '../../../domain/entities/QueueEntryRecord.js';
import type { BatchRecord } from '../../../domain/entities/BatchRecord.js';

const NOW = '2026-11-02T12:00:00.000Z';
const UNTIL = '2026-11-02T12:05:00.000Z';
const TRAIN_ID = 'train-main';

let tmpRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

async function makeStateDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'train-state-'));
  tmpRoots.push(root);
  return root;
}

/** A deterministic 40-hex sha. */
function sha(head: string): string {
  return head.repeat(40);
}

function snapshot(trainId = TRAIN_ID): TrainSnapshot {
  const train: TrainRecord = {
    id: trainId,
    schemaVersion: 1,
    repository: 'example/repo',
    baseBranch: 'main',
    generation: 0,
    currentBaseSha: sha('a'),
  };
  const entries: QueueEntryRecord[] = [
    {
      id: 'entry-1',
      schemaVersion: 1,
      prNumber: 7,
      headSha: sha('b'),
      eligibility: { kind: 'eligible' },
    },
  ];
  const batches: BatchRecord[] = [
    { id: 'batch-1', schemaVersion: 1, members: [{ prNumber: 7, headSha: sha('b') }] },
  ];
  return {
    train,
    entries,
    batches,
    candidates: [],
    gateReceipts: [],
    promotionReceipts: [],
  };
}

async function makeAdapter() {
  const stateDir = await makeStateDir();
  const adapter = new MergeTrainStateFileAdapter({ stateDir });
  return { stateDir, adapter };
}

describe('MergeTrainStateFileAdapter', () => {
  it('reads an absent state as null', async () => {
    const { adapter } = await makeAdapter();
    const read = await adapter.readState(TRAIN_ID);
    expect(read).toEqual({ outcome: 'ok', state: null });
  });

  it('saves twice with rising revisions', async () => {
    const { adapter } = await makeAdapter();
    const acquired = await adapter.acquireLease(TRAIN_ID, { holderId: 'worker-1', observedFence: 0, leaseUntilIso: UNTIL, nowIso: NOW });
    expect(acquired.outcome).toBe('ok');

    const first = await adapter.saveState({
      trainId: TRAIN_ID,
      expectedRevision: 0,
      holderId: 'worker-1',
      fence: 1,
      nowIso: NOW,
      snapshot: snapshot(),
    });
    expect(first).toEqual({ outcome: 'saved', revision: 1 });

    const second = await adapter.saveState({
      trainId: TRAIN_ID,
      expectedRevision: 1,
      holderId: 'worker-1',
      fence: 1,
      nowIso: NOW,
      snapshot: snapshot(),
    });
    expect(second).toEqual({ outcome: 'saved', revision: 2 });
  });

  it('refuses a save at a stale expected revision', async () => {
    const { adapter } = await makeAdapter();
    await adapter.acquireLease(TRAIN_ID, { holderId: 'worker-1', observedFence: 0, leaseUntilIso: UNTIL, nowIso: NOW });
    await adapter.saveState({ trainId: TRAIN_ID, expectedRevision: 0, holderId: 'worker-1', fence: 1, nowIso: NOW, snapshot: snapshot() });

    const refused = await adapter.saveState({ trainId: TRAIN_ID, expectedRevision: 0, holderId: 'worker-1', fence: 1, nowIso: NOW, snapshot: snapshot() });
    expect(refused).toEqual({ outcome: 'refused', reason: 'revision-conflict' });
  });

  it('keeps exactly one winner out of two concurrent saves at the same revision', async () => {
    const { adapter } = await makeAdapter();
    await adapter.acquireLease(TRAIN_ID, { holderId: 'worker-1', observedFence: 0, leaseUntilIso: UNTIL, nowIso: NOW });
    const save = () =>
      adapter.saveState({ trainId: TRAIN_ID, expectedRevision: 0, holderId: 'worker-1', fence: 1, nowIso: NOW, snapshot: snapshot() });
    const results = await Promise.all([save(), save()]);
    const saved = results.filter((result) => result.outcome === 'saved');
    const conflicts = results.filter((result) => result.outcome === 'refused' && result.reason === 'revision-conflict');
    expect(saved).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
  });

  it('refuses a save without a lease', async () => {
    const { adapter } = await makeAdapter();
    const refused = await adapter.saveState({ trainId: TRAIN_ID, expectedRevision: 0, holderId: 'worker-1', fence: 1, nowIso: NOW, snapshot: snapshot() });
    expect(refused).toEqual({ outcome: 'refused', reason: 'lease-not-held' });
  });

  it('refuses a stale writer after a takeover', async () => {
    const { adapter } = await makeAdapter();
    await adapter.acquireLease(TRAIN_ID, { holderId: 'worker-a', observedFence: 0, leaseUntilIso: UNTIL, nowIso: NOW });
    await adapter.saveState({ trainId: TRAIN_ID, expectedRevision: 0, holderId: 'worker-a', fence: 1, nowIso: NOW, snapshot: snapshot() });

    const afterExpiry = '2026-11-02T12:06:00.000Z';
    const acquired = await adapter.acquireLease(TRAIN_ID, { holderId: 'worker-b', observedFence: 1, leaseUntilIso: '2026-11-02T12:11:00.000Z', nowIso: afterExpiry });
    expect(acquired.outcome).toBe('ok');

    const stale = await adapter.saveState({ trainId: TRAIN_ID, expectedRevision: 1, holderId: 'worker-a', fence: 1, nowIso: afterExpiry, snapshot: snapshot() });
    expect(stale).toEqual({ outcome: 'refused', reason: 'lease-not-held' });

    const fresh = await adapter.saveState({ trainId: TRAIN_ID, expectedRevision: 1, holderId: 'worker-b', fence: 2, nowIso: afterExpiry, snapshot: snapshot() });
    expect(fresh).toEqual({ outcome: 'saved', revision: 2 });
  });

  it('refuses a snapshot with a bad sha or a mismatching train id', async () => {
    const { adapter } = await makeAdapter();
    await adapter.acquireLease(TRAIN_ID, { holderId: 'worker-1', observedFence: 0, leaseUntilIso: UNTIL, nowIso: NOW });

    const badSha = snapshot();
    const badSnapshot = {
      ...badSha,
      train: { ...badSha.train, currentBaseSha: 'not-a-sha' },
    } as TrainSnapshot;
    const refusedSha = await adapter.saveState({ trainId: TRAIN_ID, expectedRevision: 0, holderId: 'worker-1', fence: 1, nowIso: NOW, snapshot: badSnapshot });
    expect(refusedSha).toEqual({ outcome: 'refused', reason: 'invalid-snapshot' });

    const refusedId = await adapter.saveState({ trainId: TRAIN_ID, expectedRevision: 0, holderId: 'worker-1', fence: 1, nowIso: NOW, snapshot: snapshot('train-other') });
    expect(refusedId).toEqual({ outcome: 'refused', reason: 'invalid-snapshot' });
  });

  it('reports garbage state as unreadable without changing its bytes', async () => {
    const { stateDir, adapter } = await makeAdapter();
    await adapter.acquireLease(TRAIN_ID, { holderId: 'worker-1', observedFence: 0, leaseUntilIso: UNTIL, nowIso: NOW });
    const statePath = path.join(stateDir, 'merge-trains', TRAIN_ID, 'state.json');
    await fs.writeFile(statePath, 'not json at all', 'utf8');
    const before = await fs.readFile(statePath, 'utf8');

    const read = await adapter.readState(TRAIN_ID);
    expect(read).toEqual({ outcome: 'unreadable' });

    const refused = await adapter.saveState({ trainId: TRAIN_ID, expectedRevision: 0, holderId: 'worker-1', fence: 1, nowIso: NOW, snapshot: snapshot() });
    expect(refused).toEqual({ outcome: 'refused', reason: 'state-unreadable' });

    expect(await fs.readFile(statePath, 'utf8')).toBe(before);
  });

  it('lets a fresh adapter instance on the same directory see the lease and state', async () => {
    const { stateDir, adapter } = await makeAdapter();
    await adapter.acquireLease(TRAIN_ID, { holderId: 'worker-1', observedFence: 0, leaseUntilIso: UNTIL, nowIso: NOW });
    await adapter.saveState({ trainId: TRAIN_ID, expectedRevision: 0, holderId: 'worker-1', fence: 1, nowIso: NOW, snapshot: snapshot() });

    const second = new MergeTrainStateFileAdapter({ stateDir });
    const lease = await second.readLease(TRAIN_ID);
    expect(lease).toEqual({ outcome: 'ok', lease: { holderId: 'worker-1', fence: 1, leaseUntilIso: UNTIL } });
    const state = await second.readState(TRAIN_ID);
    expect(state.outcome).toBe('ok');
    if (state.outcome === 'ok') {
      expect(state.state?.revision).toBe(1);
    }
  });

  it('leaves the revision unchanged after a lease renew', async () => {
    const { adapter } = await makeAdapter();
    await adapter.acquireLease(TRAIN_ID, { holderId: 'worker-1', observedFence: 0, leaseUntilIso: UNTIL, nowIso: NOW });
    await adapter.saveState({ trainId: TRAIN_ID, expectedRevision: 0, holderId: 'worker-1', fence: 1, nowIso: NOW, snapshot: snapshot() });

    const renewed = await adapter.renewLease(TRAIN_ID, { holderId: 'worker-1', fence: 1, leaseUntilIso: UNTIL, nowIso: NOW });
    expect(renewed.outcome).toBe('ok');

    const state = await adapter.readState(TRAIN_ID);
    expect(state.outcome).toBe('ok');
    if (state.outcome === 'ok') {
      expect(state.state?.revision).toBe(1);
    }
  });

  it('throws on an unsafe train id', async () => {
    const { adapter } = await makeAdapter();
    expect(() => trainDirectory('.', '../x')).toThrow();
    await expect(adapter.readState('../x')).resolves.toEqual({ outcome: 'unreadable' });
    await expect(adapter.acquireLease('../x', { holderId: 'w', observedFence: 0, leaseUntilIso: UNTIL, nowIso: NOW })).resolves.toEqual({
      outcome: 'refused',
      reason: 'lease-unreadable',
    });
  });
});
