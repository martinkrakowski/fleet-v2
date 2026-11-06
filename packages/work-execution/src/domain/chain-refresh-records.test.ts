import { describe, expect, it } from 'vitest';

import {
  CHAIN_REFRESH_CONFLICT_MARK,
  applyChainOutcome,
  applyChainRefreshIntent,
  applyChainRefreshOutcome,
  chainRefreshKey,
  chainRefreshOf,
  conflictMarkOf,
  createChainRecord,
  isChainRefreshKey,
  readChainRecord,
} from './chain-records.js';
import type { ChainRecord } from './chain-records.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const MAIN = 'fedcba9876543210fedcba9876543210fedcba98';
const REPO = { owner: 'fleet', repo: 'fleet-v2' };
const NOW = '2026-11-05T10:00:00.000Z';
const AT = '2026-11-05T10:01:00.000Z';
const KEY = `chain-refresh/example@${MAIN.slice(0, 12)}`;

function started(overrides: Record<string, unknown> = {}): ChainRecord {
  const created = createChainRecord({
    repository: REPO,
    chainName: 'example',
    expectedHeadSha: SHA,
    actionKey: 'chain-start-1',
    createdAtIso: NOW,
  });
  if (!created.ok) throw new Error('setup');
  const record = applyChainOutcome(created.record, { state: 'started', reason: null });
  return { ...record, ...overrides } as unknown as ChainRecord;
}

function stored(chainName = 'example', mainSha = MAIN): Record<string, unknown> {
  return {
    schemaVersion: 1, repository: REPO, chainName, branchName: `chain/${chainName}`, sourceBranch: 'main',
    expectedHeadSha: SHA, actionKey: 'chain-start-1', state: 'started', reason: null, createdAtIso: NOW,
    revision: 3,
    refresh: { key: `chain-refresh/${chainName}@${mainSha.slice(0, 12)}`, mainSha, outcome: 'merged', updatedAtIso: AT },
    conflictMark: null,
  };
}

describe('chainRefreshKey / isChainRefreshKey', () => {
  it('builds the keyed intent id from the chain name and the main head', () => {
    expect(chainRefreshKey('example', MAIN)).toBe(KEY);
    expect(isChainRefreshKey(KEY)).toBe(true);
  });

  it('refuses invalid inputs', () => {
    expect(chainRefreshKey('Chain/x', MAIN)).toBeNull();
    expect(chainRefreshKey('example', 'abc')).toBeNull();
    for (const value of [undefined, null, 5, '', 'chain-refresh/@aaaaaaa', 'chain-refresh/example@XYZ', 'merge-pass/example@aaaaaaaaaaaa']) {
      expect(isChainRefreshKey(value)).toBe(false);
    }
  });
});

describe('applyChainRefreshIntent', () => {
  it('records the in-flight intent under the key and advances the revision', () => {
    const record = started();
    const next = applyChainRefreshIntent(record, { key: KEY, mainSha: MAIN, atIso: AT });
    expect(next.revision).toBe(record.revision + 1);
    expect(chainRefreshOf(next)).toEqual({ key: KEY, mainSha: MAIN, outcome: 'in-flight', updatedAtIso: AT });
    expect(conflictMarkOf(next)).toBeNull();
    expect(readChainRecord(next).ok).toBe(true);
  });
});

describe('applyChainRefreshOutcome', () => {
  it('sets the conflict mark on a conflict and clears it on merged and up-to-date', () => {
    const record = applyChainRefreshIntent(started(), { key: KEY, mainSha: MAIN, atIso: AT });
    const conflicted = applyChainRefreshOutcome(record, 'conflict', AT);
    expect(conflictMarkOf(conflicted)).toBe(CHAIN_REFRESH_CONFLICT_MARK);
    expect(chainRefreshOf(conflicted)?.outcome).toBe('conflict');
    expect(conflicted.revision).toBe(record.revision + 1);
    const merged = applyChainRefreshOutcome(conflicted, 'merged', AT);
    expect(conflictMarkOf(merged)).toBeNull();
    expect(chainRefreshOf(merged)?.outcome).toBe('merged');
    const upToDate = applyChainRefreshOutcome(merged, 'up-to-date', AT);
    expect(conflictMarkOf(upToDate)).toBeNull();
  });

  it('leaves the conflict mark unchanged on branch-gone', () => {
    const record = applyChainRefreshIntent(started(), { key: KEY, mainSha: MAIN, atIso: AT });
    const conflicted = applyChainRefreshOutcome(record, 'conflict', AT);
    const gone = applyChainRefreshOutcome(conflicted, 'branch-gone', AT);
    expect(conflictMarkOf(gone)).toBe(CHAIN_REFRESH_CONFLICT_MARK);
  });
});

describe('readChainRecord refresh fields', () => {
  it('the record carries the refresh intent and the conflict mark and reads them back', () => {
    const record = applyChainRefreshOutcome(applyChainRefreshIntent(started(), { key: KEY, mainSha: MAIN, atIso: AT }), 'conflict', AT);
    const read = readChainRecord(record);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.record).toEqual(record);
      expect(chainRefreshOf(read.record)).toEqual({ key: KEY, mainSha: MAIN, outcome: 'conflict', updatedAtIso: AT });
      expect(conflictMarkOf(read.record)).toBe(CHAIN_REFRESH_CONFLICT_MARK);
    }
    const plain = readChainRecord(stored());
    expect(plain.ok).toBe(true);
  });

  it('a record written before the refresh fields still reads', () => {
    const legacy = stored();
    delete legacy.refresh;
    delete legacy.conflictMark;
    const read = readChainRecord(legacy);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(chainRefreshOf(read.record)).toBeNull();
      expect(conflictMarkOf(read.record)).toBeNull();
    }
  });

  it('a malformed refresh field is refused', () => {
    const bad: Record<string, unknown>[] = [
      { refresh: { key: 'chain-refresh/example@aaaaaaaaaaaa', mainSha: MAIN, outcome: 'merged', updatedAtIso: AT } },
      { refresh: { key: KEY, mainSha: 'abc', outcome: 'merged', updatedAtIso: AT } },
      { refresh: { key: KEY, mainSha: MAIN, outcome: 'done', updatedAtIso: AT } },
      { refresh: { key: KEY, mainSha: MAIN, outcome: 'merged', updatedAtIso: 'x' } },
      { refresh: { key: KEY, mainSha: MAIN, outcome: 'merged' } },
      { refresh: 'merged' },
      { conflictMark: 'chain-refresh-other' },
      { conflictMark: 1 },
    ];
    for (const overrides of bad) {
      expect(readChainRecord({ ...stored(), ...overrides }).ok).toBe(false);
    }
  });
});
