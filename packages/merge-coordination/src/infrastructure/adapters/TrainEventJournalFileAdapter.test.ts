import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TrainEventJournalFileAdapter } from './TrainEventJournalFileAdapter.adapter.js';
import { writeJsonAtomically } from './TrainStoreFiles.helper.js';
import type { TrainJournalAppendRequest } from '../../application/ports/out/TrainEventPort.out-port.js';

describe('TrainEventJournalFileAdapter', () => {
  let tempDir: string;
  let adapter: TrainEventJournalFileAdapter;
  const trainId = 'train-1';
  const holderId = 'holder-1';
  const fence = 1;
  const now = '2026-11-02T20:00:00.000Z';
  const clock = { nowIso: () => now };
  const leaseUntilIso = '2026-11-02T21:00:00.000Z';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-journal-test-'));
    adapter = new TrainEventJournalFileAdapter({ stateDir: tempDir, clock });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  async function writeLease(hId = holderId, f = fence, until = leaseUntilIso): Promise<void> {
    const dir = path.join(tempDir, 'merge-trains', trainId);
    await fs.mkdir(dir, { recursive: true });
    await writeJsonAtomically(path.join(dir, 'lease.json'), {
      version: 1,
      holderId: hId,
      fence: f,
      leaseUntilIso: until,
    });
  }

  function appendRequest(key: string, event: 'became-eligible' | 'batched' = 'became-eligible'): TrainJournalAppendRequest {
    return {
      trainId,
      holderId,
      fence,
      entry: {
        key,
        event,
        atIso: now,
      },
    };
  }

  it('lists an empty list when journal does not exist', async () => {
    const result = await adapter.list(trainId);
    expect(result).toEqual({ outcome: 'ok', entries: [] });
  });

  it('lists an empty list when journal file is zero bytes', async () => {
    const dir = path.join(tempDir, 'merge-trains', trainId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'journal.jsonl'), '', 'utf8');

    const result = await adapter.list(trainId);
    expect(result).toEqual({ outcome: 'ok', entries: [] });
  });

  it('appends an entry and lists it back', async () => {
    await writeLease();

    const appendResult = await adapter.append(appendRequest('key-1', 'became-eligible'));
    expect(appendResult).toEqual({
      outcome: 'appended',
      entry: {
        schemaVersion: 1,
        sequence: 1,
        key: 'key-1',
        event: 'became-eligible',
        atIso: now,
        fence: 1,
      },
    });

    const listResult = await adapter.list(trainId);
    expect(listResult).toEqual({
      outcome: 'ok',
      entries: [
        {
          schemaVersion: 1,
          sequence: 1,
          key: 'key-1',
          event: 'became-eligible',
          atIso: now,
          fence: 1,
        },
      ],
    });
  });

  it('handles idempotency: returns duplicate for repeated key with same event', async () => {
    await writeLease();

    const first = await adapter.append(appendRequest('key-1', 'became-eligible'));
    expect(first.outcome).toBe('appended');

    const second = await adapter.append(appendRequest('key-1', 'became-eligible'));
    expect(second).toEqual({
      outcome: 'duplicate',
      entry: (first as { outcome: 'appended'; entry: unknown }).entry,
    });

    const listResult = await adapter.list(trainId);
    if (listResult.outcome !== 'ok') throw new Error('expected ok');
    expect(listResult.entries).toHaveLength(1);
  });

  it('refuses append with key-conflict when key is repeated with different event', async () => {
    await writeLease();

    await adapter.append(appendRequest('key-1', 'became-eligible'));
    const conflict = await adapter.append(appendRequest('key-1', 'batched'));
    expect(conflict).toEqual({
      outcome: 'refused',
      reason: 'key-conflict',
    });
  });

  it('refuses append when lease is not held', async () => {
    // No lease file exists
    const result = await adapter.append(appendRequest('key-1', 'became-eligible'));
    expect(result.outcome).toBe('refused');
  });

  describe('Finding 2: internal blank lines and invalid lines make journal unreadable', () => {
    const validLine1 = JSON.stringify({
      schemaVersion: 1,
      sequence: 1,
      key: 'key-1',
      event: 'became-eligible',
      atIso: now,
      fence: 1,
    });

    const validLine2 = JSON.stringify({
      schemaVersion: 1,
      sequence: 2,
      key: 'key-2',
      event: 'batched',
      atIso: now,
      fence: 1,
    });

    it('treats a journal with an internal blank line as unreadable and refuses append', async () => {
      await writeLease();
      const dir = path.join(tempDir, 'merge-trains', trainId);
      await fs.mkdir(dir, { recursive: true });
      const journalFile = path.join(dir, 'journal.jsonl');

      // Valid entry, internal blank line, then another valid entry
      const content = `${validLine1}\n\n${validLine2}\n`;
      await fs.writeFile(journalFile, content, 'utf8');

      // list must return unreadable
      const listResult = await adapter.list(trainId);
      expect(listResult).toEqual({ outcome: 'unreadable' });

      // append must refuse with journal-unreadable and not write anything
      const appendResult = await adapter.append(appendRequest('key-3', 'became-eligible'));
      expect(appendResult).toEqual({
        outcome: 'refused',
        reason: 'journal-unreadable',
      });

      // Verify the file was not modified
      const after = await fs.readFile(journalFile, 'utf8');
      expect(after).toBe(content);
    });

    it('treats a journal with an internal whitespace line as unreadable', async () => {
      await writeLease();
      const dir = path.join(tempDir, 'merge-trains', trainId);
      await fs.mkdir(dir, { recursive: true });
      const journalFile = path.join(dir, 'journal.jsonl');

      const content = `${validLine1}\n   \n${validLine2}\n`;
      await fs.writeFile(journalFile, content, 'utf8');

      expect(await adapter.list(trainId)).toEqual({ outcome: 'unreadable' });
      expect(await adapter.append(appendRequest('key-3', 'became-eligible'))).toEqual({
        outcome: 'refused',
        reason: 'journal-unreadable',
      });
      expect(await fs.readFile(journalFile, 'utf8')).toBe(content);
    });

    it('treats a journal with a leading blank line as unreadable', async () => {
      const dir = path.join(tempDir, 'merge-trains', trainId);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'journal.jsonl'), `\n${validLine1}\n`, 'utf8');

      expect(await adapter.list(trainId)).toEqual({ outcome: 'unreadable' });
    });

    it('treats a journal with multiple trailing newlines as unreadable', async () => {
      const dir = path.join(tempDir, 'merge-trains', trainId);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'journal.jsonl'), `${validLine1}\n\n`, 'utf8');

      expect(await adapter.list(trainId)).toEqual({ outcome: 'unreadable' });
    });

    it('treats a journal with only a newline as unreadable', async () => {
      const dir = path.join(tempDir, 'merge-trains', trainId);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'journal.jsonl'), '\n', 'utf8');

      expect(await adapter.list(trainId)).toEqual({ outcome: 'unreadable' });
    });
  });

  describe('Finding 1: journal sequences must be contiguous and increasing', () => {
    function makeLine(sequence: number, key: string, event: 'became-eligible' | 'batched' = 'became-eligible'): string {
      return JSON.stringify({
        schemaVersion: 1,
        sequence,
        key,
        event,
        atIso: now,
        fence: 1,
      });
    }

    it('refuses a journal with decreasing sequences (e.g. 2, 1)', async () => {
      await writeLease();
      const dir = path.join(tempDir, 'merge-trains', trainId);
      await fs.mkdir(dir, { recursive: true });
      const journalFile = path.join(dir, 'journal.jsonl');

      const content = `${makeLine(2, 'key-1')}\n${makeLine(1, 'key-2')}\n`;
      await fs.writeFile(journalFile, content, 'utf8');

      expect(await adapter.list(trainId)).toEqual({ outcome: 'unreadable' });
      expect(await adapter.append(appendRequest('key-3', 'became-eligible'))).toEqual({
        outcome: 'refused',
        reason: 'journal-unreadable',
      });
      expect(await fs.readFile(journalFile, 'utf8')).toBe(content);
    });

    it('refuses a journal with duplicate sequences (e.g. 1, 1)', async () => {
      await writeLease();
      const dir = path.join(tempDir, 'merge-trains', trainId);
      await fs.mkdir(dir, { recursive: true });
      const journalFile = path.join(dir, 'journal.jsonl');

      const content = `${makeLine(1, 'key-1')}\n${makeLine(1, 'key-2')}\n`;
      await fs.writeFile(journalFile, content, 'utf8');

      expect(await adapter.list(trainId)).toEqual({ outcome: 'unreadable' });
      expect(await adapter.append(appendRequest('key-3', 'became-eligible'))).toEqual({
        outcome: 'refused',
        reason: 'journal-unreadable',
      });
      expect(await fs.readFile(journalFile, 'utf8')).toBe(content);
    });

    it('refuses a journal with a sequence gap (e.g. 1, 3)', async () => {
      await writeLease();
      const dir = path.join(tempDir, 'merge-trains', trainId);
      await fs.mkdir(dir, { recursive: true });
      const journalFile = path.join(dir, 'journal.jsonl');

      const content = `${makeLine(1, 'key-1')}\n${makeLine(3, 'key-2')}\n`;
      await fs.writeFile(journalFile, content, 'utf8');

      expect(await adapter.list(trainId)).toEqual({ outcome: 'unreadable' });
      expect(await adapter.append(appendRequest('key-3', 'became-eligible'))).toEqual({
        outcome: 'refused',
        reason: 'journal-unreadable',
      });
      expect(await fs.readFile(journalFile, 'utf8')).toBe(content);
    });

    it('refuses a journal starting with a sequence greater than 1 (e.g. 2, 3)', async () => {
      await writeLease();
      const dir = path.join(tempDir, 'merge-trains', trainId);
      await fs.mkdir(dir, { recursive: true });
      const journalFile = path.join(dir, 'journal.jsonl');

      const content = `${makeLine(2, 'key-1')}\n${makeLine(3, 'key-2')}\n`;
      await fs.writeFile(journalFile, content, 'utf8');

      expect(await adapter.list(trainId)).toEqual({ outcome: 'unreadable' });
      expect(await adapter.append(appendRequest('key-3', 'became-eligible'))).toEqual({
        outcome: 'refused',
        reason: 'journal-unreadable',
      });
      expect(await fs.readFile(journalFile, 'utf8')).toBe(content);
    });

    it('accepts a contiguous increasing sequence and appends with correct sequence', async () => {
      await writeLease();
      const dir = path.join(tempDir, 'merge-trains', trainId);
      await fs.mkdir(dir, { recursive: true });
      const journalFile = path.join(dir, 'journal.jsonl');

      const content = `${makeLine(1, 'key-1')}\n${makeLine(2, 'key-2')}\n`;
      await fs.writeFile(journalFile, content, 'utf8');

      const listResult = await adapter.list(trainId);
      expect(listResult.outcome).toBe('ok');
      if (listResult.outcome === 'ok') {
        expect(listResult.entries).toHaveLength(2);
        expect(listResult.entries[0].sequence).toBe(1);
        expect(listResult.entries[1].sequence).toBe(2);
      }

      const appendResult = await adapter.append(appendRequest('key-3', 'became-eligible'));
      expect(appendResult).toEqual({
        outcome: 'appended',
        entry: {
          schemaVersion: 1,
          sequence: 3,
          key: 'key-3',
          event: 'became-eligible',
          atIso: now,
          fence: 1,
        },
      });
    });
  });

  describe('clock-decided expiry', () => {
    async function journalBytes(): Promise<Buffer | null> {
      try {
        return await fs.readFile(path.join(tempDir, 'merge-trains', trainId, 'journal.jsonl'));
      } catch {
        return null;
      }
    }

    it('append refuses an expired lease and creates no journal', async () => {
      await writeLease(holderId, fence, '2026-11-02T19:00:00.000Z');
      const result = await adapter.append(appendRequest('key-1'));
      expect(result).toEqual({ outcome: 'refused', reason: 'lease-expired' });
      expect(await journalBytes()).toBeNull();
    });

    it('append ignores a request nowIso: an expired lease with a stale request time is still refused', async () => {
      await writeLease(holderId, fence, '2026-11-02T19:00:00.000Z');
      const request = {
        ...appendRequest('key-1'),
        nowIso: '2026-11-01T00:00:00.000Z',
      } as TrainJournalAppendRequest;
      const result = await adapter.append(request);
      expect(result).toEqual({ outcome: 'refused', reason: 'lease-expired' });
      expect(await journalBytes()).toBeNull();
    });

    it('append by a foreign holder is refused lease-not-held and writes nothing', async () => {
      await writeLease();
      const result = await adapter.append({ ...appendRequest('key-1'), holderId: 'holder-2' });
      expect(result).toEqual({ outcome: 'refused', reason: 'lease-not-held' });
      expect(await journalBytes()).toBeNull();
    });

    it('append with the wrong fence is refused lease-not-held and writes nothing', async () => {
      await writeLease();
      const result = await adapter.append({ ...appendRequest('key-1'), fence: 2 });
      expect(result).toEqual({ outcome: 'refused', reason: 'lease-not-held' });
      expect(await journalBytes()).toBeNull();
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
      'append with a malformed or throwing clock (%s) is refused clock-unreadable and the journal is unchanged',
      async (_label: string, badClock: { nowIso: () => string }) => {
        const badAdapter = new TrainEventJournalFileAdapter({ stateDir: tempDir, clock: badClock });
        await writeLease();
        const before = await journalBytes();
        const result = await badAdapter.append(appendRequest('key-1'));
        expect(result).toEqual({ outcome: 'refused', reason: 'clock-unreadable' });
        expect(await journalBytes()).toEqual(before);
      },
    );

    it('append defaults to the system clock', async () => {
      const systemAdapter = new TrainEventJournalFileAdapter({ stateDir: tempDir });
      await writeLease(holderId, fence, '2999-01-01T00:00:00.000Z');
      expect((await systemAdapter.append(appendRequest('key-1'))).outcome).toBe('appended');
      await writeLease(holderId, fence, '2000-01-01T00:00:00.000Z');
      expect(await systemAdapter.append(appendRequest('key-2'))).toEqual({ outcome: 'refused', reason: 'lease-expired' });
    });
  });
});
