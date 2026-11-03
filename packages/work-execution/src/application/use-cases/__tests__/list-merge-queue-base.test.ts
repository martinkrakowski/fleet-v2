// CO3: ListMergeQueueUseCase groups heads by owner, repo and resolved base, and
// a repository query with no matching entry returns one null-head main row.
import { describe, expect, it } from 'vitest';

import { ListMergeQueueUseCase } from '../ListMergeQueueUseCase.use-case.js';
import type { MergeQueueRepositoryPort } from '../../ports/out/MergeQueueRepositoryPort.out-port.js';
import { MERGE_QUEUE_ENTRY_VERSION } from '../../../domain/merge-queue-records.js';
import type { MergeQueueEntryRecord } from '../../../domain/merge-queue-records.js';

const DIGEST = '0123456789ab';
const HEAD = '0123456789abcdef0123456789abcdef01234567';

function makeEntry(overrides: Partial<MergeQueueEntryRecord> = {}): MergeQueueEntryRecord {
  return {
    version: MERGE_QUEUE_ENTRY_VERSION,
    entryId: '01JB0000000000000000000001',
    repository: { owner: 'fleet', repo: 'v2' },
    repoDigest: DIGEST,
    baseBranch: 'main',
    pullRequest: 1,
    headOid: HEAD,
    state: 'queued',
    reason: null,
    attempt: 0,
    notBeforeIso: null,
    enqueuedAtIso: '2026-11-01T10:00:00.000Z',
    enqueuedBy: 'conductor',
    supersedes: null,
    runId: null,
    attemptId: null,
    workOrderId: null,
    tier: 2,
    verifiedHeadOid: null,
    verifiedBy: null,
    policyRevision: null,
    premergeReceiptHeadOid: null,
    veto: null,
    mergeCommitOid: null,
    mergedAtIso: null,
    revision: 1,
    ...overrides,
  };
}

function queue(entries: readonly MergeQueueEntryRecord[]): MergeQueueRepositoryPort {
  return {
    enqueueMergeEntry: async () => ({ outcome: 'refused', reason: 'invalid-head' }),
    dropMergeEntry: async () => ({ outcome: 'refused', reason: 'unknown-entry' }),
    retryMergeEntry: async () => ({ outcome: 'refused', reason: 'unknown-entry' }),
    listMergeEntries: async () => entries,
  };
}

describe('ListMergeQueueUseCase base grouping', () => {
  it('lists one head per base on the same repository', async () => {
    const main = makeEntry({ entryId: '01JB0000000000000000000001', enqueuedAtIso: '2026-11-01T10:00:00.000Z' });
    const chain = makeEntry({
      entryId: '01JB0000000000000000000002',
      baseBranch: 'chain/dt',
      enqueuedAtIso: '2026-11-01T11:00:00.000Z',
    });
    const useCase = new ListMergeQueueUseCase({ queue: queue([main, chain]) });
    const view = await useCase.list({ deadlineIso: '2026-11-02T11:00:00.000Z' });
    expect(view.heads).toHaveLength(2);
    const mainHead = view.heads.find((head) => head.baseBranch === 'main');
    const chainHead = view.heads.find((head) => head.baseBranch === 'chain/dt');
    expect(mainHead?.headEntryId).toBe(main.entryId);
    expect(chainHead?.headEntryId).toBe(chain.entryId);
    expect(view.entries.map((entry) => entry.entryId)).toEqual([main.entryId, chain.entryId]);
  });

  it('returns one null-head main row when a repository query matches nothing', async () => {
    const useCase = new ListMergeQueueUseCase({ queue: queue([]) });
    const view = await useCase.list({
      repository: { owner: 'nobody', repo: 'nothing' },
      deadlineIso: '2026-11-02T11:00:00.000Z',
    });
    expect(view.heads).toEqual([
      {
        repository: { owner: 'nobody', repo: 'nothing' },
        baseBranch: 'main',
        headEntryId: null,
      },
    ]);
  });
});
