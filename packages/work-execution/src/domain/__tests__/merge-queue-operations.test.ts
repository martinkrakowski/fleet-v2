import { describe, expect, it } from 'vitest';

import {
  decideMergeEnqueue,
  decideMergeDrop,
  decideMergeRetry,
} from '../merge-queue-operations.js';
import type { MergeEnqueueInput } from '../merge-queue-operations.js';
import {
  MERGE_QUEUE_ENTRY_VERSION,
  readMergeQueueEntryRecord,
} from '../merge-queue-records.js';
import type { MergeQueueEntryRecord } from '../merge-queue-records.js';

const HEAD_A = '0123456789abcdef0123456789abcdef01234567';
const HEAD_B = '0123456789abcdef0123456789abcdef01234568';
const DIGEST = '0123456789ab';

let entryIdCounter = 0;
function nextEntryId(): string {
  const ordinal = String(entryIdCounter).padStart(22, '0').slice(-22);
  entryIdCounter += 1;
  return '01JB' + ordinal;
}

function makeEntry(overrides: Partial<MergeQueueEntryRecord> = {}): MergeQueueEntryRecord {
  return {
    version: MERGE_QUEUE_ENTRY_VERSION,
    entryId: nextEntryId(),
    repository: { owner: 'fleet', repo: 'v2' },
    repoDigest: DIGEST,
    pullRequest: 7,
    headOid: HEAD_A,
    state: 'queued',
    reason: null,
    attempt: 0,
    notBeforeIso: null,
    enqueuedAtIso: '2026-11-01T10:00:00.000Z',
    enqueuedBy: 'cli',
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

function input(overrides: Partial<MergeEnqueueInput> = {}): MergeEnqueueInput {
  return {
    repository: { owner: 'fleet', repo: 'v2' },
    pullRequest: 7,
    headOid: HEAD_A,
    tier: 2,
    enqueuedBy: 'cli',
    runId: null,
    entryId: nextEntryId(),
    successorEntryId: nextEntryId(),
    enqueuedAtIso: '2026-11-01T11:00:00.000Z',
    repoDigest: DIGEST,
    ...overrides,
  };
}

function expectAllValid(entries: readonly MergeQueueEntryRecord[]): void {
  for (const entry of entries) {
    const read = readMergeQueueEntryRecord(entry);
    expect(read.ok).toBe(true);
  }
}

describe('decideMergeEnqueue', () => {
  it('refuses a non-40-hex head', () => {
    const decision = decideMergeEnqueue([], input({ headOid: 'not-a-real-head' }));
    expect(decision).toEqual({ outcome: 'refused', reason: 'invalid-head' });
  });

  it('refuses non-ULID entry ids', () => {
    expect(decideMergeEnqueue([], input({ entryId: 'not-a-ulid' }))).toEqual({
      outcome: 'refused',
      reason: 'invalid-entry-id',
    });
    expect(decideMergeEnqueue([], input({ successorEntryId: 'not-a-ulid' }))).toEqual({
      outcome: 'refused',
      reason: 'invalid-entry-id',
    });
  });

  it('refuses a tier outside 0|1|2', () => {
    expect(decideMergeEnqueue([], input({ tier: 3 }))).toEqual({
      outcome: 'refused',
      reason: 'invalid-tier',
    });
    expect(decideMergeEnqueue([], input({ tier: '2' }))).toEqual({
      outcome: 'refused',
      reason: 'invalid-tier',
    });
  });

  it('refuses an invalid enqueuedAtIso', () => {
    expect(decideMergeEnqueue([], input({ enqueuedAtIso: 'not-an-instant' }))).toEqual({
      outcome: 'refused',
      reason: 'invalid-enqueued-at',
    });
  });

  it('creates a queued record with supersedes null', () => {
    const decision = decideMergeEnqueue([], input());
    expect(decision.outcome).toBe('created');
    if (decision.outcome === 'created') {
      expect(decision.record.state).toBe('queued');
      expect(decision.record.supersedes).toBeNull();
      expect(decision.record.enqueuedBy).toBe('cli');
      expect(decision.record.revision).toBe(1);
      expect(decision.entries).toEqual([decision.record]);
      expectAllValid(decision.entries);
    }
  });

  it('returns the first live entry on a duplicate and keeps the list unchanged', () => {
    const first = decideMergeEnqueue([], input());
    expect(first.outcome).toBe('created');
    if (first.outcome !== 'created') {
      return;
    }
    const second = decideMergeEnqueue(first.entries, input());
    expect(second.outcome).toBe('duplicate');
    if (second.outcome === 'duplicate') {
      expect(second.record.entryId).toBe(first.record.entryId);
      expect(second.entries).toEqual(first.entries);
    }
  });

  it('ignores terminal entries with the same identity', () => {
    const dropped = makeEntry({ state: 'dropped', reason: 'operator-dropped' });
    const decision = decideMergeEnqueue([dropped], input());
    expect(decision.outcome).toBe('created');
    if (decision.outcome === 'created') {
      expect(decision.entries).toHaveLength(2);
      expectAllValid(decision.entries);
    }
  });

  it('supersedes an earlier head and inherits its position', () => {
    const first = decideMergeEnqueue([], input());
    expect(first.outcome).toBe('created');
    if (first.outcome !== 'created') {
      return;
    }
    const second = decideMergeEnqueue(first.entries, input({ headOid: HEAD_B, successorEntryId: nextEntryId() }));
    expect(second.outcome).toBe('supersedes');
    if (second.outcome === 'supersedes') {
      expect(second.supersededEntryId).toBe(first.record.entryId);
      expect(second.entries).toHaveLength(2);
      const superseded = second.entries.find((entry) => entry.entryId === first.record.entryId)!;
      const successor = second.entries.find((entry) => entry.entryId === second.record.entryId)!;
      expect(superseded.state).toBe('superseded');
      expect(superseded.revision).toBe(first.record.revision + 1);
      expect(successor.state).toBe('queued');
      expect(successor.supersedes).toBe(first.record.entryId);
      expect(successor.enqueuedAtIso).toBe(first.record.enqueuedAtIso);
      expect(successor.enqueuedBy).toBe('cli');
      expect(successor.headOid).toBe(HEAD_B);
      expect(successor.revision).toBe(1);
      expect(successor.attempt).toBe(0);
      expect(successor.runId).toBeNull();
      expect(successor.attemptId).toBeNull();
      expect(successor.workOrderId).toBeNull();
      expect(successor.verifiedHeadOid).toBeNull();
      expect(successor.verifiedBy).toBeNull();
      expect(successor.veto).toBeNull();
      expectAllValid(second.entries);
    }
  });
});

describe('decideMergeDrop', () => {
  it('refuses an unknown entry id', () => {
    const decision = decideMergeDrop([makeEntry()], '01JB0000000000000000000000');
    expect(decision).toEqual({ outcome: 'refused', reason: 'unknown-entry' });
  });

  it('drops the matching live entry', () => {
    const entry = makeEntry();
    const decision = decideMergeDrop([entry], entry.entryId);
    expect(decision.outcome).toBe('dropped');
    if (decision.outcome === 'dropped') {
      expect(decision.record.state).toBe('dropped');
      expect(decision.record.reason).toBe('operator-dropped');
      expect(decision.record.revision).toBe(entry.revision + 1);
      expect(decision.entries).toHaveLength(1);
      expect(decision.entries[0]).toBe(decision.record);
      expectAllValid(decision.entries);
    }
  });

  it('never drops a terminal entry', () => {
    const dropped = makeEntry({ state: 'dropped', reason: 'operator-dropped' });
    const decision = decideMergeDrop([dropped], dropped.entryId);
    expect(decision).toEqual({ outcome: 'refused', reason: 'unknown-entry' });
  });
});

describe('decideMergeRetry', () => {
  it('refuses an unknown entry id', () => {
    const decision = decideMergeRetry([makeEntry()], '01JB0000000000000000000000', {
      entryId: nextEntryId(),
      enqueuedAtIso: '2026-11-01T12:00:00.000Z',
    });
    expect(decision).toEqual({ outcome: 'refused', reason: 'unknown-entry' });
  });

  it('refuses an entry that is not dropped', () => {
    const entry = makeEntry();
    const decision = decideMergeRetry([entry], entry.entryId, {
      entryId: nextEntryId(),
      enqueuedAtIso: '2026-11-01T12:00:00.000Z',
    });
    expect(decision).toEqual({ outcome: 'refused', reason: 'not-dropped' });
  });

  it('retries a dropped entry with a fresh queued record', () => {
    const dropped = makeEntry({ state: 'dropped', reason: 'operator-dropped', attempt: 1 });
    const retryEntryId = nextEntryId();
    const decision = decideMergeRetry([dropped], dropped.entryId, {
      entryId: retryEntryId,
      enqueuedAtIso: '2026-11-01T12:00:00.000Z',
    });
    expect(decision.outcome).toBe('retried');
    if (decision.outcome === 'retried') {
      expect(decision.record.entryId).toBe(retryEntryId);
      expect(decision.record.state).toBe('queued');
      expect(decision.record.attempt).toBe(dropped.attempt + 1);
      expect(decision.record.enqueuedBy).toBe('cli');
      expect(decision.record.supersedes).toBeNull();
      expect(decision.record.revision).toBe(1);
      expect(decision.record.headOid).toBe(dropped.headOid);
      expect(decision.record.tier).toBe(dropped.tier);
      expect(decision.record.runId).toBeNull();
      expect(decision.record.attemptId).toBeNull();
      expect(decision.record.workOrderId).toBeNull();
      expect(decision.record.verifiedHeadOid).toBeNull();
      expect(decision.record.verifiedBy).toBeNull();
      expect(decision.record.veto).toBeNull();
      expect(decision.entries).toHaveLength(2);
      expectAllValid(decision.entries);
    }
  });
});
