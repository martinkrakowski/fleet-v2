import { describe, expect, it } from 'vitest';

import {
  applyChainOutcome,
  applyChainReviewPin,
  chainReviewKeyOf,
  createChainRecord,
  readChainRecord,
  reviewPinOf,
} from '../chain-records.js';
import type { ChainRecord, ChainReviewPin } from '../chain-records.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const TIP = 'fedcba9876543210fedcba9876543210fedcba98';
const REPO = { owner: 'fleet', repo: 'fleet-v2' };
const NOW = '2026-11-05T10:00:00.000Z';
const LATER = '2026-11-06T10:00:00.000Z';

function started(): ChainRecord {
  const created = createChainRecord({
    repository: REPO, chainName: 'example', expectedHeadSha: SHA, actionKey: 'chain-start-1', createdAtIso: NOW,
  });
  if (!created.ok) throw new Error('setup');
  return applyChainOutcome(created.record, { state: 'started', reason: null });
}

function pinOf(headSha = TIP): ChainReviewPin {
  return {
    headSha,
    requestId: `chain-review:example:${headSha.slice(0, 12)}`,
    key: chainReviewKeyOf('example', headSha),
    pinnedAtIso: LATER,
  };
}

function stored(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1, repository: REPO, chainName: 'example', branchName: 'chain/example', sourceBranch: 'main',
    expectedHeadSha: SHA, actionKey: 'chain-start-1', state: 'started', reason: null, createdAtIso: NOW, revision: 2,
    ...overrides,
  };
}

describe('the chain record review pin', () => {
  it('reads a stored record without a pin as no pin, exactly as a CO7 record parsed before', () => {
    const read = readChainRecord(stored());
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(reviewPinOf(read.record)).toBeNull();
    expect(Object.hasOwn(read.record, 'reviewPin')).toBe(false);
    expect(read.record).toEqual({
      schemaVersion: 1, repository: REPO, chainName: 'example', branchName: 'chain/example', sourceBranch: 'main',
      expectedHeadSha: SHA, actionKey: 'chain-start-1', state: 'started', reason: null, createdAtIso: NOW, revision: 2,
      refresh: null, conflictMark: null,
    });
  });

  it('reads a stored null pin as no pin', () => {
    const read = readChainRecord(stored({ reviewPin: null }));
    expect(read.ok && reviewPinOf(read.record)).toBeNull();
  });

  it('reads a well-formed pin and freezes it', () => {
    const read = readChainRecord(stored({ revision: 3, reviewPin: pinOf() }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(reviewPinOf(read.record)).toEqual(pinOf());
    expect(Object.isFrozen(reviewPinOf(read.record))).toBe(true);
  });

  it('makes a record with a malformed pin malformed', () => {
    const bad: unknown[] = [
      'pin',
      [],
      {},
      { ...pinOf(), headSha: 'abc' },
      { ...pinOf(), headSha: TIP.toUpperCase() },
      { ...pinOf(), requestId: 'has space' },
      { ...pinOf(), requestId: '' },
      { ...pinOf(), requestId: 'chain-review:example:ffffffffffff' },
      { ...pinOf(), requestId: 'unrelated-request-1' },
      { ...pinOf(), key: 'chain-review/example@000000000000' },
      { ...pinOf(), key: chainReviewKeyOf('other', TIP) },
      { ...pinOf(), pinnedAtIso: 'yesterday' },
      { ...pinOf(), extra: 1 },
      { headSha: TIP, requestId: 'r', key: pinOf().key },
    ];
    for (const reviewPin of bad) {
      expect(readChainRecord(stored({ revision: 3, reviewPin }))).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('never runs a getter on a stored pin', () => {
    const pin = {
      headSha: TIP,
      requestId: 'r-1',
      key: pinOf().key,
      get pinnedAtIso(): string {
        throw new Error('getter ran');
      },
    };
    expect(readChainRecord(stored({ revision: 3, reviewPin: pin }))).toEqual({ ok: false, reason: 'malformed' });
  });

  it('applyChainReviewPin returns a new frozen record with the pin set and the revision advanced by one', () => {
    const record = started();
    const pinned = applyChainReviewPin(record, pinOf(), LATER);
    expect(pinned).not.toBe(record);
    expect(pinned.revision).toBe(record.revision + 1);
    expect(reviewPinOf(pinned)).toEqual(pinOf());
    expect(Object.isFrozen(pinned)).toBe(true);
    expect(reviewPinOf(record)).toBeNull();
    expect(pinned.state).toBe('started');
    expect(readChainRecord(pinned).ok).toBe(true);
  });

  it('keys a pin by chain name and the first twelve hex of the head', () => {
    expect(chainReviewKeyOf('example', TIP)).toBe('chain-review/example@fedcba987654');
    expect(pinOf(SHA).key).not.toBe(pinOf(TIP).key);
  });

  it('keeps a CO7 started record and its outcome path untouched', () => {
    const record = started();
    expect(record).toEqual({
      schemaVersion: 1, repository: REPO, chainName: 'example', branchName: 'chain/example', sourceBranch: 'main',
      expectedHeadSha: SHA, actionKey: 'chain-start-1', state: 'started', reason: null, createdAtIso: NOW, revision: 2,
      refresh: null, conflictMark: null,
    });
  });
});
