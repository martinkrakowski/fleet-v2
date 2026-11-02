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
  const nowIso = '2026-11-02T20:00:00.000Z';
  const leaseUntilIso = '2026-11-02T21:00:00.000Z';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-journal-test-'));
    adapter = new TrainEventJournalFileAdapter({ stateDir: tempDir });
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
      nowIso,
      entry: {
        key,
        event,
        atIso: nowIso,
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
        atIso: nowIso,
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
          atIso: nowIso,
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
      atIso: nowIso,
      fence: 1,
    });

    const validLine2 = JSON.stringify({
      schemaVersion: 1,
      sequence: 2,
      key: 'key-2',
      event: 'batched',
      atIso: nowIso,
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
});
