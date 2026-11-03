import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MergeQueueDeadlineError,
  MergeQueueRepositoryAdapter,
} from '../MergeQueueRepositoryAdapter.adapter.js';
import { StateFileUnreadableError } from '../file-store.js';

const HEAD_A = '0123456789abcdef0123456789abcdef01234567';
const HEAD_B = '0123456789abcdef0123456789abcdef01234568';

let entryIdCounter = 0;
function nextEntryId(): string {
  const ordinal = String(entryIdCounter).padStart(22, '0').slice(-22);
  entryIdCounter += 1;
  return '01JB' + ordinal;
}

function futureDeadline(): string {
  return new Date(Date.now() + 60_000).toISOString();
}

function command(headOid: string) {
  return {
    repository: { owner: 'fleet', repo: 'v2' },
    pullRequest: 7,
    headOid,
    tier: 2,
    enqueuedBy: 'cli' as const,
    runId: null,
    entryId: nextEntryId(),
    successorEntryId: nextEntryId(),
    enqueuedAtIso: new Date().toISOString(),
    deadlineIso: futureDeadline(),
  };
}

describe('MergeQueueRepositoryAdapter', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-merge-queue-'));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  });

  it('refuses a non-40-hex head without creating the file or echoing the value', async () => {
    const adapter = new MergeQueueRepositoryAdapter({ stateDir });
    const decision = await adapter.enqueueMergeEntry({
      ...command('not-a-real-head'),
    });
    expect(decision).toEqual({ outcome: 'refused', reason: 'invalid-head' });
    await expect(fs.stat(path.join(stateDir, 'merge-queue.json'))).rejects.toThrow();
    expect(JSON.stringify(decision)).not.toContain('not-a-real-head');
  });

  it('returns the first live entry on a duplicate and writes nothing', async () => {
    const adapter = new MergeQueueRepositoryAdapter({ stateDir });
    const first = await adapter.enqueueMergeEntry(command(HEAD_A));
    expect(first.outcome).toBe('created');
    if (first.outcome !== 'created') {
      return;
    }
    const filePath = path.join(stateDir, 'merge-queue.json');
    const bytesBefore = await fs.readFile(filePath);
    const second = await adapter.enqueueMergeEntry(command(HEAD_A));
    expect(second.outcome).toBe('duplicate');
    if (second.outcome === 'duplicate') {
      expect(second.record.entryId).toBe(first.record.entryId);
    }
    const bytesAfter = await fs.readFile(filePath);
    expect(bytesAfter).toEqual(bytesBefore);
    const parsed = JSON.parse(bytesAfter.toString('utf8')) as unknown[];
    expect(parsed).toHaveLength(1);
  });

  it('supersedes an earlier head with a successor that inherits its position', async () => {
    const adapter = new MergeQueueRepositoryAdapter({ stateDir });
    const first = await adapter.enqueueMergeEntry(command(HEAD_A));
    expect(first.outcome).toBe('created');
    if (first.outcome !== 'created') {
      return;
    }
    const second = await adapter.enqueueMergeEntry(command(HEAD_B));
    expect(second.outcome).toBe('supersedes');
    if (second.outcome !== 'supersedes') {
      return;
    }
    const filePath = path.join(stateDir, 'merge-queue.json');
    const parsed = JSON.parse((await fs.readFile(filePath)).toString('utf8')) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(2);
    const storedFirst = parsed.find((record) => record.entryId === first.record.entryId)!;
    const storedSecond = parsed.find((record) => record.entryId === second.record.entryId)!;
    expect(storedFirst.state).toBe('superseded');
    expect(storedSecond.state).toBe('queued');
    expect(storedSecond.supersedes).toBe(first.record.entryId);
    expect(storedSecond.enqueuedAtIso).toBe(first.record.enqueuedAtIso);
    expect(storedSecond.enqueuedBy).toBe('cli');
  });

  it('throws on an unreadable list instead of returning an empty list', async () => {
    const filePath = path.join(stateDir, 'merge-queue.json');
    await fs.writeFile(filePath, '{ truncated');
    const adapter = new MergeQueueRepositoryAdapter({ stateDir });
    await expect(adapter.listMergeEntries({ deadlineIso: futureDeadline() })).rejects.toBeInstanceOf(
      StateFileUnreadableError,
    );
  });

  it('refuses an invalid or past deadline on every mutation', async () => {
    const adapter = new MergeQueueRepositoryAdapter({ stateDir });
    const past = new Date(Date.now() - 1000).toISOString();
    const enqueue = await adapter.enqueueMergeEntry({ ...command(HEAD_A), deadlineIso: past });
    expect(enqueue).toEqual({ outcome: 'refused', reason: 'invalid-deadline' });
    const drop = await adapter.dropMergeEntry({ entryId: nextEntryId(), deadlineIso: 'nonsense' });
    expect(drop).toEqual({ outcome: 'refused', reason: 'invalid-deadline' });
    const retry = await adapter.retryMergeEntry({
      entryId: nextEntryId(),
      retryEntryId: nextEntryId(),
      enqueuedAtIso: new Date().toISOString(),
      deadlineIso: past,
    });
    expect(retry).toEqual({ outcome: 'refused', reason: 'invalid-deadline' });
  });

  it('throws a typed error on an invalid list deadline', async () => {
    const adapter = new MergeQueueRepositoryAdapter({ stateDir });
    await expect(adapter.listMergeEntries({ deadlineIso: 'nonsense' })).rejects.toBeInstanceOf(
      MergeQueueDeadlineError,
    );
  });

  it('reads an empty list when the store file is absent', async () => {
    const adapter = new MergeQueueRepositoryAdapter({ stateDir });
    await expect(adapter.listMergeEntries({ deadlineIso: futureDeadline() })).resolves.toEqual([]);
  });
});
