import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MergeQueueRepositoryAdapter,
  mergeQueueRepositoryDigest,
} from './MergeQueueRepositoryAdapter.adapter.js';

const HEAD = 'a'.repeat(40);

function ulid(n: number): string {
  return '01JB' + String(n).padStart(22, '0');
}

function futureDeadline(): string {
  return new Date(Date.now() + 60_000).toISOString();
}

describe('mergeQueueRepositoryDigest', () => {
  it('mergeQueueRepositoryDigest({ owner: fleet, repo: v2 }) is 7c155c1db6b3', () => {
    expect(mergeQueueRepositoryDigest({ owner: 'fleet', repo: 'v2' })).toBe('7c155c1db6b3');
  });

  it('mergeQueueRepositoryDigest({ owner: Fleet, repo: v2 }) is 6295027050c9', () => {
    expect(mergeQueueRepositoryDigest({ owner: 'Fleet', repo: 'v2' })).toBe('6295027050c9');
  });

  it('enqueueMergeEntry stores repoDigest 7c155c1db6b3 for fleet/v2', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-merge-queue-digest-'));
    try {
      const adapter = new MergeQueueRepositoryAdapter({ stateDir });
      const deadlineIso = futureDeadline();
      const decision = await adapter.enqueueMergeEntry({
        repository: { owner: 'fleet', repo: 'v2' },
        pullRequest: 101,
        headOid: HEAD,
        tier: 2,
        enqueuedBy: 'cli',
        runId: null,
        entryId: ulid(1),
        successorEntryId: ulid(2),
        enqueuedAtIso: '2026-11-16T09:00:00.000Z',
        deadlineIso,
      });
      expect(decision.outcome).toBe('created');
      if (decision.outcome !== 'created') {
        return;
      }
      expect(decision.record.repoDigest).toBe('7c155c1db6b3');

      const listed = await adapter.listMergeEntries({ deadlineIso: futureDeadline() });
      expect(listed).toEqual([
        expect.objectContaining({
          repository: { owner: 'fleet', repo: 'v2' },
          pullRequest: 101,
          headOid: HEAD,
          repoDigest: '7c155c1db6b3',
        }),
      ]);

      const persisted = JSON.parse(await fs.readFile(path.join(stateDir, 'merge-queue.json'), 'utf8')) as Array<{
        repoDigest: string;
      }>;
      expect(persisted).toEqual([expect.objectContaining({ repoDigest: '7c155c1db6b3' })]);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
