import { describe, expect, it } from 'vitest';

import {
  MERGE_QUEUE_ENTRY_VERSION,
  compareMergeQueueEntries,
  createUpdateSuccessorEntry,
  effectiveVerifiedHeadOid,
  findMergeQueueHead,
  orderMergeQueue,
  readMergeQueueEntryRecord,
} from '../merge-queue-records.js';
import type { MergeQueueEntryRecord } from '../merge-queue-records.js';

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const HEAD_2 = '0123456789abcdef0123456789abcdef01234568';
const DIGEST = '0123456789ab';
const DIGEST_2 = '0123456789ac';

/** A secret-shaped fake assembled from inert pieces (never a literal in this file). */
function fakeSecret(): string {
  return `sk-${'a'.repeat(20)}`;
}

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

function rawEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...makeEntry(), ...overrides };
}

function expectMalformed(input: unknown, error: string, secret?: string): void {
  const result = readMergeQueueEntryRecord(input);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe('malformed');
    expect(result.error).toBe(error);
    if (secret !== undefined) {
      expect(result.error).not.toContain(secret);
    }
  }
}

describe('round-trip', () => {
  it('reads a valid v1 record', () => {
    const result = readMergeQueueEntryRecord(makeEntry());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.version).toBe(MERGE_QUEUE_ENTRY_VERSION);
    }
  });

  it('normalises non-Z zoned instants through toISOString', () => {
    const result = readMergeQueueEntryRecord(
      rawEntry({
        state: 'merged',
        enqueuedAtIso: '2026-11-01T10:00:00.123+02:00',
        notBeforeIso: '2026-11-01T09:00:00+02:00',
        mergeCommitOid: HEAD_2,
        mergedAtIso: '2026-11-01T08:00:00.000+02:00',
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.enqueuedAtIso).toBe(new Date('2026-11-01T10:00:00.123+02:00').toISOString());
      expect(result.record.notBeforeIso).toBe(new Date('2026-11-01T09:00:00+02:00').toISOString());
      expect(result.record.mergedAtIso).toBe(new Date('2026-11-01T08:00:00.000+02:00').toISOString());
    }
  });

  it('freezes record, repository and veto', () => {
    const result = readMergeQueueEntryRecord(
      rawEntry({
        veto: { outcome: 'merge-safe', confidence: 0.8, mode: 'shadow', decisionReceiptId: 'receipt-1' },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.isFrozen(result.record)).toBe(true);
      expect(Object.isFrozen(result.record.repository)).toBe(true);
      expect(Object.isFrozen(result.record.veto)).toBe(true);
    }
  });
});

describe('D-R8 version handling', () => {
  it('reads a legacy record without version as version 1', () => {
    const legacy = rawEntry();
    delete legacy.version;
    const result = readMergeQueueEntryRecord(legacy);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.version).toBe(1);
    }
  });

  it.each([2, 0, '1'])('refuses version %p', (version) => {
    const result = readMergeQueueEntryRecord(rawEntry({ version }));
    expect(result).toEqual({ ok: false, reason: 'unknown-version', error: 'MergeQueueEntry version must be 1' });
  });

  it('refuses a non-enumerable version', () => {
    const input = makeEntry();
    Object.defineProperty(input, 'version', { value: 1, enumerable: false });
    const result = readMergeQueueEntryRecord(input);
    expect(result).toEqual({ ok: false, reason: 'malformed', error: 'MergeQueueEntry version must be enumerable' });
  });
});

describe('malformed refusals', () => {
  it('refuses a non-ULID entryId', () => {
    expectMalformed(rawEntry({ entryId: 'not-a-ulid' }), 'MergeQueueEntry entryId must be a ULID');
  });

  it('refuses a non-12-hex repoDigest', () => {
    expectMalformed(rawEntry({ repoDigest: 'xyz' }), 'MergeQueueEntry repoDigest must be 12 lowercase hex characters');
  });

  it('refuses a non-40-hex headOid including uppercase', () => {
    expectMalformed(rawEntry({ headOid: HEAD.toUpperCase() }), 'MergeQueueEntry headOid must be 40 lowercase hex characters');
    expectMalformed(rawEntry({ headOid: 'abc' }), 'MergeQueueEntry headOid must be 40 lowercase hex characters');
  });

  it('refuses a tier outside 0|1|2', () => {
    expectMalformed(rawEntry({ tier: 3 }), 'MergeQueueEntry tier must be 0, 1 or 2');
    expectMalformed(rawEntry({ tier: '2' }), 'MergeQueueEntry tier must be 0, 1 or 2');
  });

  it('refuses secret-shaped ids and owner without echoing the secret', () => {
    const secret = fakeSecret();
    expectMalformed(
      rawEntry({ attemptId: secret }),
      'MergeQueueEntry attemptId and workOrderId must be null or safe ids',
      secret,
    );
    expectMalformed(rawEntry({ policyRevision: secret }), 'MergeQueueEntry policyRevision must be null or a safe id', secret);
    expectMalformed(
      rawEntry({ repository: { owner: secret, repo: 'v2' } }),
      'MergeQueueEntry repository must have valid owner and repo',
      secret,
    );
  });

  it('refuses owner . and ..', () => {
    expectMalformed(rawEntry({ repository: { owner: '.', repo: 'v2' } }), 'MergeQueueEntry repository must have valid owner and repo');
    expectMalformed(rawEntry({ repository: { owner: '..', repo: 'v2' } }), 'MergeQueueEntry repository must have valid owner and repo');
  });

  it('refuses a mismatched verified pair', () => {
    expectMalformed(
      rawEntry({ verifiedHeadOid: HEAD, verifiedBy: null }),
      'MergeQueueEntry verifiedHeadOid and verifiedBy must both be null or both be set',
    );
    expectMalformed(
      rawEntry({ verifiedHeadOid: null, verifiedBy: 'contexts' }),
      'MergeQueueEntry verifiedHeadOid and verifiedBy must both be null or both be set',
    );
  });

  it('refuses update without supersedes and self-supersede', () => {
    expectMalformed(rawEntry({ enqueuedBy: 'update', supersedes: null }), 'MergeQueueEntry update entry must name supersedes');
    const id = '01JB0000000000000000000005';
    expectMalformed(rawEntry({ entryId: id, supersedes: id }), 'MergeQueueEntry cannot supersede itself');
  });

  it('refuses parked without a park reason and dropped without a drop reason', () => {
    expectMalformed(
      rawEntry({ state: 'parked', reason: 'not-a-park-reason' }),
      'MergeQueueEntry parked entry must carry a MergeParkReason',
    );
    expectMalformed(rawEntry({ state: 'dropped', reason: 'threads' }), 'MergeQueueEntry dropped entry must carry a MergeDropReason');
  });

  it('refuses merged with missing or inconsistent merge fields', () => {
    expectMalformed(
      rawEntry({ state: 'merged', mergeCommitOid: HEAD, mergedAtIso: null }),
      'MergeQueueEntry mergeCommitOid and mergedAtIso must be set iff state is merged',
    );
    expectMalformed(
      rawEntry({ state: 'merged', mergeCommitOid: null, mergedAtIso: '2026-11-01T08:00:00.000Z' }),
      'MergeQueueEntry mergeCommitOid and mergedAtIso must be set iff state is merged',
    );
    expectMalformed(
      rawEntry({ state: 'ready', mergeCommitOid: HEAD, mergedAtIso: '2026-11-01T08:00:00.000Z' }),
      'MergeQueueEntry mergeCommitOid and mergedAtIso must be set iff state is merged',
    );
  });

  it('refuses an extra key and a missing key', () => {
    expectMalformed(rawEntry({ extra: 'x' }), 'MergeQueueEntry must have exactly the v1 entry keys');
    const missingState = rawEntry();
    delete missingState.state;
    expectMalformed(missingState, 'MergeQueueEntry must have exactly the v1 entry keys');
  });
});

describe('hostile inputs', () => {
  function throwingProxy(target: object): unknown {
    return new Proxy(target, {
      getOwnPropertyDescriptor() {
        throw new Error('boom');
      },
    });
  }

  it('does not let a throwing proxy escape the reader', () => {
    const result = readMergeQueueEntryRecord(throwingProxy(makeEntry()));
    expect(result.ok).toBe(false);
  });

  it('returns [] from orderMergeQueue on a throwing proxy', () => {
    const entries = [throwingProxy(makeEntry())] as unknown as readonly MergeQueueEntryRecord[];
    expect(orderMergeQueue(entries)).toEqual([]);
  });

  it('returns null from findMergeQueueHead on a throwing proxy', () => {
    const entries = [throwingProxy(makeEntry())] as unknown as readonly MergeQueueEntryRecord[];
    expect(findMergeQueueHead(entries)).toBeNull();
  });

  it('returns ok:false from createUpdateSuccessorEntry on a hostile input', () => {
    const input = throwingProxy(makeEntry()) as unknown as Parameters<typeof createUpdateSuccessorEntry>[1];
    const result = createUpdateSuccessorEntry(makeEntry(), input);
    expect(result.ok).toBe(false);
  });

  it('returns null from effectiveVerifiedHeadOid on a throwing getter', () => {
    type HeadPick = Pick<MergeQueueEntryRecord, 'headOid' | 'verifiedHeadOid' | 'verifiedBy'>;
    const hostile = new Proxy({ headOid: HEAD }, { get() { throw new Error('boom'); } }) as unknown as HeadPick;
    expect(effectiveVerifiedHeadOid(hostile, { requiresProcedure: false })).toBeNull();
  });
});

describe('orderMergeQueue', () => {
  it('drops terminal entries', () => {
    const merged = makeEntry({ state: 'merged', mergeCommitOid: HEAD, mergedAtIso: '2026-11-01T08:00:00.000Z' });
    const dropped = makeEntry({ state: 'dropped', reason: 'closed' });
    const superseded = makeEntry({ state: 'superseded', reason: null });
    const live = makeEntry();
    const ordered = orderMergeQueue([merged, dropped, superseded, live]);
    expect(ordered.map((entry) => entry.entryId)).toEqual([live.entryId]);
  });

  it('orders live entries by instant ascending', () => {
    const late = makeEntry({ enqueuedAtIso: '2026-11-01T12:00:00.000Z' });
    const early = makeEntry({ enqueuedAtIso: '2026-11-01T10:00:00.000Z' });
    const ordered = orderMergeQueue([late, early]);
    expect(ordered.map((entry) => entry.entryId)).toEqual([early.entryId, late.entryId]);
  });

  it('tie-breaks equal instants by entryId code unit', () => {
    const a = makeEntry({ enqueuedAtIso: '2026-11-01T10:00:00.000Z' });
    const b = makeEntry({ enqueuedAtIso: '2026-11-01T10:00:00.000Z' });
    const ordered = orderMergeQueue([b, a]);
    expect(ordered.map((entry) => entry.entryId)).toEqual([a.entryId, b.entryId]);
  });

  it('sorts every permutation of a three-entry list identically', () => {
    const first = makeEntry({ enqueuedAtIso: '2026-11-01T10:00:00.000Z' });
    const second = makeEntry({ enqueuedAtIso: '2026-11-01T11:00:00.000Z' });
    const third = makeEntry({ enqueuedAtIso: '2026-11-01T12:00:00.000Z' });
    const expected = [first.entryId, second.entryId, third.entryId];
    const permutations = [
      [first, second, third],
      [first, third, second],
      [second, first, third],
      [second, third, first],
      [third, first, second],
      [third, second, first],
    ];
    for (const permutation of permutations) {
      const ordered = orderMergeQueue(permutation);
      expect(ordered.map((entry) => entry.entryId)).toEqual(expected);
    }
  });

  it('keeps only the matching digest when a repoDigest filter is given', () => {
    const a = makeEntry();
    const b = makeEntry({ repoDigest: DIGEST_2 });
    const ordered = orderMergeQueue([a, b], DIGEST);
    expect(ordered.map((entry) => entry.entryId)).toEqual([a.entryId]);
  });

  it('returns [] for a bad repoDigest filter or a non-array', () => {
    expect(orderMergeQueue([makeEntry()], 'nope')).toEqual([]);
    const notArray = undefined as unknown as readonly MergeQueueEntryRecord[];
    expect(orderMergeQueue(notArray)).toEqual([]);
  });
});

describe('createUpdateSuccessorEntry', () => {
  it('inherits enqueue time and resets lifecycle fields', () => {
    const predecessor = makeEntry({ premergeReceiptHeadOid: HEAD_2 });
    const result = createUpdateSuccessorEntry(predecessor, { entryId: nextEntryId(), headOid: HEAD_2 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const successor = result.record;
      expect(successor.enqueuedAtIso).toBe(predecessor.enqueuedAtIso);
      expect(successor.enqueuedBy).toBe('update');
      expect(successor.supersedes).toBe(predecessor.entryId);
      expect(successor.state).toBe('awaiting-checks');
      expect(successor.attempt).toBe(0);
      expect(successor.verifiedHeadOid).toBeNull();
      expect(successor.verifiedBy).toBeNull();
      expect(successor.veto).toBeNull();
      expect(successor.revision).toBe(1);
      expect(successor.premergeReceiptHeadOid).toBe(HEAD_2);
      expect(successor.repository).toEqual(predecessor.repository);
      expect(successor.repoDigest).toBe(predecessor.repoDigest);
      expect(successor.pullRequest).toBe(predecessor.pullRequest);
      expect(successor.tier).toBe(predecessor.tier);
    }
  });

  it('uses the given receipt including null when provided', () => {
    const predecessor = makeEntry({ premergeReceiptHeadOid: HEAD_2 });
    let result = createUpdateSuccessorEntry(predecessor, {
      entryId: nextEntryId(),
      headOid: HEAD_2,
      premergeReceiptHeadOid: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.premergeReceiptHeadOid).toBeNull();
    }
    result = createUpdateSuccessorEntry(predecessor, {
      entryId: nextEntryId(),
      headOid: HEAD_2,
      premergeReceiptHeadOid: HEAD,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.premergeReceiptHeadOid).toBe(HEAD);
    }
  });

  it('refuses the same headOid', () => {
    const predecessor = makeEntry();
    const result = createUpdateSuccessorEntry(predecessor, { entryId: nextEntryId(), headOid: predecessor.headOid });
    expect(result).toEqual({ ok: false, reason: 'malformed', error: 'MergeQueueEntry successor requires a new 40-hex headOid' });
  });

  it('places the successor between earlier and later entries after the predecessor is superseded', () => {
    const earlier = makeEntry({ state: 'queued', enqueuedAtIso: '2026-11-01T10:00:00.000Z' });
    const predecessor = makeEntry({ state: 'queued', enqueuedAtIso: '2026-11-01T10:00:00.000Z' });
    const successorResult = createUpdateSuccessorEntry(predecessor, { entryId: nextEntryId(), headOid: HEAD_2 });
    expect(successorResult.ok).toBe(true);
    const later = makeEntry({ state: 'queued', enqueuedAtIso: '2026-11-01T11:00:00.000Z' });
    const supersededPredecessor = { ...predecessor, state: 'superseded' as const };
    const successor = successorResult.ok ? successorResult.record : later;
    const ordered = orderMergeQueue([supersededPredecessor, earlier, successor, later]);
    expect(ordered.map((entry) => entry.entryId)).toEqual([earlier.entryId, successor.entryId, later.entryId]);
  });
});

describe('findMergeQueueHead', () => {
  it('skips parked entries and returns the earliest unparked live entry for every permutation', () => {
    const parkedEarly = makeEntry({ state: 'parked', reason: 'checks', enqueuedAtIso: '2026-11-01T10:00:00.000Z' });
    const live = makeEntry({ state: 'queued', enqueuedAtIso: '2026-11-01T11:00:00.000Z' });
    const parkedLate = makeEntry({ state: 'parked', reason: 'checks', enqueuedAtIso: '2026-11-01T12:00:00.000Z' });
    const liveLater = makeEntry({ state: 'queued', enqueuedAtIso: '2026-11-01T12:30:00.000Z' });
    const rows = [parkedEarly, live, parkedLate, liveLater];
    const permutations: (typeof rows)[] = [];
    const permute = (prefix: typeof rows, rest: typeof rows): void => {
      if (rest.length === 0) {
        permutations.push(prefix);
        return;
      }
      rest.forEach((row, index) => permute([...prefix, row], [...rest.slice(0, index), ...rest.slice(index + 1)]));
    };
    permute([], rows);
    expect(permutations).toHaveLength(24);
    for (const permutation of permutations) {
      expect(findMergeQueueHead(permutation)?.entryId).toBe(live.entryId);
    }
  });

  it('compares equal timestamps by entryId and answers 0 for the same entry', () => {
    const a = makeEntry({ enqueuedAtIso: '2026-11-01T10:00:00.000Z' });
    const b = { ...a, entryId: a.entryId < 'zzzz' ? 'zzzz' : 'aaaa' };
    expect(compareMergeQueueEntries(a, a)).toBe(0);
    expect(Math.sign(compareMergeQueueEntries(a, b))).toBe(-Math.sign(compareMergeQueueEntries(b, a)));
  });

  it('returns null when every live entry is parked', () => {
    const parkedA = makeEntry({ state: 'parked', reason: 'checks' });
    const parkedB = makeEntry({ state: 'parked', reason: 'macos' });
    expect(findMergeQueueHead([parkedA, parkedB])).toBeNull();
  });

  it('returns null when live entries span two digests and no filter is given', () => {
    const a = makeEntry();
    const b = makeEntry({ repoDigest: DIGEST_2 });
    expect(findMergeQueueHead([a, b])).toBeNull();
  });

  it('returns the head of the filtered digest', () => {
    const a = makeEntry();
    const b = makeEntry({ repoDigest: DIGEST_2 });
    expect(findMergeQueueHead([a, b], DIGEST)?.entryId).toBe(a.entryId);
  });
});

describe('effectiveVerifiedHeadOid', () => {
  it('returns headOid for contexts without a procedure', () => {
    const entry = { headOid: HEAD, verifiedHeadOid: HEAD, verifiedBy: 'contexts' as const };
    expect(effectiveVerifiedHeadOid(entry, { requiresProcedure: false })).toBe(HEAD);
  });

  it('returns null for contexts when a procedure is required', () => {
    const entry = { headOid: HEAD, verifiedHeadOid: HEAD, verifiedBy: 'contexts' as const };
    expect(effectiveVerifiedHeadOid(entry, { requiresProcedure: true })).toBeNull();
  });

  it('returns headOid for procedure with either requiresProcedure value', () => {
    const entry = { headOid: HEAD, verifiedHeadOid: HEAD, verifiedBy: 'procedure' as const };
    expect(effectiveVerifiedHeadOid(entry, { requiresProcedure: false })).toBe(HEAD);
    expect(effectiveVerifiedHeadOid(entry, { requiresProcedure: true })).toBe(HEAD);
  });

  it('returns null when verifiedHeadOid is null or differs', () => {
    expect(effectiveVerifiedHeadOid({ headOid: HEAD, verifiedHeadOid: null, verifiedBy: null }, { requiresProcedure: false })).toBeNull();
    expect(effectiveVerifiedHeadOid({ headOid: HEAD, verifiedHeadOid: HEAD_2, verifiedBy: 'contexts' }, { requiresProcedure: false })).toBeNull();
  });
});
