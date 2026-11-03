import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';

import { MergeTrainStateFileAdapter } from '../MergeTrainStateFileAdapter.adapter.js';
import { TrainEventJournalFileAdapter } from '../TrainEventJournalFileAdapter.adapter.js';
import type { TrainEventValue } from '../../../domain/value-objects/TrainEvent.vo.js';

const NOW = '2026-11-02T12:00:00.000Z';
const UNTIL = '2026-11-02T12:05:00.000Z';
const TRAIN_ID = 'train-main';

let now = NOW;
const clock = { nowIso: () => now };

let tmpRoots: string[] = [];

beforeEach(() => {
  now = NOW;
});

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

async function makeAdapters() {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'train-journal-'));
  tmpRoots.push(stateDir);
  const leases = new MergeTrainStateFileAdapter({ stateDir, clock });
  const journal = new TrainEventJournalFileAdapter({ stateDir, clock });
  return { stateDir, leases, journal };
}

/** Take a lease for holder-1 at fence 1. */
async function takeLease(leases: MergeTrainStateFileAdapter): Promise<void> {
  const acquired = await leases.acquireLease(TRAIN_ID, { holderId: 'worker-1', observedFence: 0, leaseUntilIso: UNTIL });
  expect(acquired.outcome).toBe('ok');
}

describe('TrainEventJournalFileAdapter', () => {
  it('refuses an append without a lease', async () => {
    const { journal } = await makeAdapters();
    const refused = await journal.append({
      trainId: TRAIN_ID,
      holderId: 'worker-1',
      fence: 1,
      entry: { key: 'k1', event: 'batched', atIso: NOW },
    });
    expect(refused).toEqual({ outcome: 'refused', reason: 'lease-not-held' });
  });

  it('appends two entries with rising sequences and lists them in order', async () => {
    const { leases, journal } = await makeAdapters();
    await takeLease(leases);
    const first = await journal.append({ trainId: TRAIN_ID, holderId: 'worker-1', fence: 1, entry: { key: 'k1', event: 'batched', atIso: NOW } });
    expect(first.outcome).toBe('appended');
    if (first.outcome === 'appended') {
      expect(first.entry.sequence).toBe(1);
    }
    const second = await journal.append({ trainId: TRAIN_ID, holderId: 'worker-1', fence: 1, entry: { key: 'k2', event: 'candidate-built', atIso: NOW } });
    if (second.outcome === 'appended') {
      expect(second.entry.sequence).toBe(2);
    }
    const list = await journal.list(TRAIN_ID);
    expect(list).toEqual({
      outcome: 'ok',
      entries: [
        { schemaVersion: 1, sequence: 1, key: 'k1', event: 'batched', atIso: NOW, fence: 1 },
        { schemaVersion: 1, sequence: 2, key: 'k2', event: 'candidate-built', atIso: NOW, fence: 1 },
      ],
    });
  });

  it('answers duplicate for a repeated key with the same event and writes nothing', async () => {
    const { leases, journal } = await makeAdapters();
    await takeLease(leases);
    await journal.append({ trainId: TRAIN_ID, holderId: 'worker-1', fence: 1, entry: { key: 'k1', event: 'batched', atIso: NOW } });
    const repeated = await journal.append({ trainId: TRAIN_ID, holderId: 'worker-1', fence: 1, entry: { key: 'k1', event: 'batched', atIso: NOW } });
    expect(repeated).toEqual({
      outcome: 'duplicate',
      entry: { schemaVersion: 1, sequence: 1, key: 'k1', event: 'batched', atIso: NOW, fence: 1 },
    });
    const list = await journal.list(TRAIN_ID);
    expect(list.outcome).toBe('ok');
    if (list.outcome === 'ok') {
      expect(list.entries).toHaveLength(1);
    }
  });

  it('refuses the same key with another event as a key conflict', async () => {
    const { leases, journal } = await makeAdapters();
    await takeLease(leases);
    await journal.append({ trainId: TRAIN_ID, holderId: 'worker-1', fence: 1, entry: { key: 'k1', event: 'batched', atIso: NOW } });
    const refused = await journal.append({ trainId: TRAIN_ID, holderId: 'worker-1', fence: 1, entry: { key: 'k1', event: 'gate-passed', atIso: NOW } });
    expect(refused).toEqual({ outcome: 'refused', reason: 'key-conflict' });
  });

  it('refuses a stale fence after a takeover', async () => {
    const { leases, journal } = await makeAdapters();
    await takeLease(leases);
    const afterExpiry = '2026-11-02T12:06:00.000Z';
    now = afterExpiry;
    const acquired = await leases.acquireLease(TRAIN_ID, { holderId: 'worker-2', observedFence: 1, leaseUntilIso: '2026-11-02T12:11:00.000Z' });
    expect(acquired.outcome).toBe('ok');
    const refused = await journal.append({ trainId: TRAIN_ID, holderId: 'worker-1', fence: 1, entry: { key: 'k1', event: 'batched', atIso: NOW } });
    expect(refused).toEqual({ outcome: 'refused', reason: 'lease-not-held' });
  });

  it('refuses an unknown event and a secret-shaped key as invalid entries', async () => {
    const { leases, journal } = await makeAdapters();
    await takeLease(leases);
    const unknownEvent = await journal.append({
      trainId: TRAIN_ID,
      holderId: 'worker-1',
      fence: 1,
      entry: { key: 'k1', event: 'exploded' as TrainEventValue, atIso: NOW },
    });
    expect(unknownEvent).toEqual({ outcome: 'refused', reason: 'invalid-entry' });

    const secretKey = await journal.append({
      trainId: TRAIN_ID,
      holderId: 'worker-1',
      fence: 1,
      entry: { key: `sk-${'x'.repeat(24)}`, event: 'batched', atIso: NOW },
    });
    expect(secretKey).toEqual({ outcome: 'refused', reason: 'invalid-entry' });
  });

  it('reports a stored secret-shaped key as unreadable', async () => {
    const { stateDir, leases, journal } = await makeAdapters();
    await takeLease(leases);
    const journalPath = path.join(stateDir, 'merge-trains', TRAIN_ID, 'journal.jsonl');
    const line = { schemaVersion: 1, sequence: 1, fence: 1, key: 'sk-' + 'a'.repeat(24), event: 'batched', atIso: '2026-11-02T00:00:00.000Z' };
    await fs.writeFile(journalPath, JSON.stringify(line) + '\n', 'utf8');
    expect(await journal.list(TRAIN_ID)).toEqual({ outcome: 'unreadable' });
  });

  it('reports a corrupt line as unreadable and appends nothing', async () => {
    const { stateDir, leases, journal } = await makeAdapters();
    await takeLease(leases);
    const journalPath = path.join(stateDir, 'merge-trains', TRAIN_ID, 'journal.jsonl');
    await fs.writeFile(journalPath, 'not json at all\n', 'utf8');
    const before = await fs.readFile(journalPath, 'utf8');

    const list = await journal.list(TRAIN_ID);
    expect(list).toEqual({ outcome: 'unreadable' });

    const refused = await journal.append({ trainId: TRAIN_ID, holderId: 'worker-1', fence: 1, entry: { key: 'k1', event: 'batched', atIso: NOW } });
    expect(refused).toEqual({ outcome: 'refused', reason: 'journal-unreadable' });

    expect(await fs.readFile(journalPath, 'utf8')).toBe(before);
  });

  it('lists an absent journal as empty', async () => {
    const { journal } = await makeAdapters();
    expect(await journal.list(TRAIN_ID)).toEqual({ outcome: 'ok', entries: [] });
  });

  it('lets a fresh adapter instance on the same directory see the entries', async () => {
    const { stateDir, leases, journal } = await makeAdapters();
    await takeLease(leases);
    await journal.append({ trainId: TRAIN_ID, holderId: 'worker-1', fence: 1, entry: { key: 'k1', event: 'batched', atIso: NOW } });

    const second = new TrainEventJournalFileAdapter({ stateDir, clock });
    const list = await second.list(TRAIN_ID);
    expect(list.outcome).toBe('ok');
    if (list.outcome === 'ok') {
      expect(list.entries).toHaveLength(1);
      expect(list.entries[0].key).toBe('k1');
    }
  });
});
