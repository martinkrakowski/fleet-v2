import { describe, expect, it } from 'vitest';

import {
  applyChainOutcome,
  createChainRecord,
  decideChainStart,
  parseChainName,
  readChainRecord,
} from './chain-records.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';
const REPO = { owner: 'fleet', repo: 'fleet-v2' };
const NOW = '2026-11-05T10:00:00.000Z';

function input(overrides: Record<string, unknown> = {}) {
  return { repository: REPO, chainName: 'example', expectedHeadSha: SHA, actionKey: 'chain-start-1', createdAtIso: NOW, ...overrides } as never;
}

function stored(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1, repository: REPO, chainName: 'example', branchName: 'chain/example', sourceBranch: 'main',
    expectedHeadSha: SHA, actionKey: 'chain-start-1', state: 'intent-recorded', reason: null, createdAtIso: NOW,
    revision: 1, ...overrides,
  };
}

describe('parseChainName', () => {
  it('accepts bare lowercase dashed names', () => {
    expect(parseChainName('example')).toBe('example');
    expect(parseChainName('a-b-1')).toBe('a-b-1');
  });

  it('refuses everything else', () => {
    for (const value of ['Chain/x', 'chain/x', 'a/b', 'a--b', '-a', 'a-', '', 'A', 'a b', 'a'.repeat(200), 42, null, undefined, {}, ['a']]) {
      expect(parseChainName(value)).toBeUndefined();
    }
  });
});

describe('createChainRecord', () => {
  it('stamps schemaVersion 1, state intent-recorded and revision 1', () => {
    const result = createChainRecord(input());
    expect(result).toEqual({
      ok: true,
      record: {
        schemaVersion: 1, repository: REPO, chainName: 'example', branchName: 'chain/example', sourceBranch: 'main',
        expectedHeadSha: SHA, actionKey: 'chain-start-1', state: 'intent-recorded', reason: null, createdAtIso: NOW, revision: 1,
        refresh: null, conflictMark: null,
      },
    });
  });

  it('refuses each bad field with its fixed reason', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ repository: { owner: '..', repo: 'x' } }, 'invalid-repository'],
      [{ chainName: 'Bad' }, 'invalid-chain-name'],
      [{ expectedHeadSha: 'abc' }, 'invalid-expected-head'],
      [{ expectedHeadSha: SHA.toUpperCase() }, 'invalid-expected-head'],
      [{ actionKey: '' }, 'invalid-action-key'],
      [{ actionKey: '   ' }, 'invalid-action-key'],
      [{ actionKey: 'x'.repeat(257) }, 'invalid-action-key'],
      [{ actionKey: 'é'.repeat(129) }, 'invalid-action-key'],
      [{ actionKey: `token ghp_${'a'.repeat(36)}` }, 'invalid-action-key'],
      [{ createdAtIso: 'not a date' }, 'invalid-created-at'],
      [{ createdAtIso: 5 }, 'invalid-created-at'],
    ];
    for (const [overrides, reason] of cases) {
      expect(createChainRecord(input(overrides))).toEqual({ ok: false, reason });
    }
  });

  it('never throws on a null input, a getter or a wrong-typed field', () => {
    const getter = Object.defineProperty({}, 'chainName', { get() { throw new Error('boom'); }, enumerable: true });
    for (const bad of [null, undefined, 5, 'x', [], getter]) {
      expect(createChainRecord(bad as never).ok).toBe(false);
    }
  });
});

describe('readChainRecord', () => {
  it('reads a v1 record and an absent schemaVersion as 1', () => {
    const legacy = stored();
    delete legacy.schemaVersion;
    for (const body of [stored(), legacy]) {
      const read = readChainRecord(body);
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(read.record.schemaVersion).toBe(1);
        expect(read.record.branchName).toBe('chain/example');
      }
    }
  });

  it('round-trips a refused record', () => {
    const read = readChainRecord(stored({ state: 'refused', reason: 'forge-refused', revision: 2 }));
    expect(read.ok && read.record.reason).toBe('forge-refused');
  });

  it('refuses an unknown schemaVersion', () => {
    for (const version of [2, 0, '1', null, 1.5]) {
      expect(readChainRecord(stored({ schemaVersion: version }))).toEqual({ ok: false, reason: 'unknown-schema-version' });
    }
  });

  it('refuses malformed bodies and never throws', () => {
    const getter = Object.defineProperty(stored(), 'state', { get() { throw new Error('boom'); }, enumerable: true });
    const proxy = new Proxy({}, { ownKeys() { throw new Error('boom'); }, getPrototypeOf() { throw new Error('boom'); } });
    const bodies: unknown[] = [
      null, undefined, 3, 'x', [], getter, proxy,
      stored({ state: 'done' }),
      stored({ branchName: 'chain/other' }),
      stored({ sourceBranch: 'develop' }),
      stored({ chainName: 'Bad', branchName: 'chain/Bad' }),
      stored({ expectedHeadSha: 'abc' }),
      stored({ actionKey: '' }),
      stored({ createdAtIso: 'x' }),
      stored({ revision: 0 }),
      stored({ revision: '1' }),
      stored({ state: 'started', reason: 'stale' }),
      stored({ state: 'refused', reason: null }),
      stored({ state: 'refused', reason: 'Has Spaces' }),
      stored({ repository: { owner: 'a', repo: '..' } }),
      { ...stored(), extra: 1 },
      (() => { const b = stored(); delete b.actionKey; return b; })(),
    ];
    for (const body of bodies) {
      const read = readChainRecord(body);
      expect(read.ok).toBe(false);
    }
  });
});

describe('applyChainOutcome', () => {
  it('advances the revision and clears the reason when started', () => {
    const created = createChainRecord(input());
    if (!created.ok) throw new Error('setup');
    const started = applyChainOutcome(created.record, { state: 'started', reason: 'ignored' });
    expect(started).toMatchObject({ state: 'started', reason: null, revision: 2 });
    const refused = applyChainOutcome(created.record, { state: 'refused', reason: 'forge-refused' });
    expect(refused).toMatchObject({ state: 'refused', reason: 'forge-refused', revision: 2 });
  });
});

describe('decideChainStart', () => {
  it('is started at the expected commit', () => {
    expect(decideChainStart({ kind: 'branch-found', headSha: SHA }, SHA)).toEqual({ state: 'started', reason: null });
  });

  it('refuses a branch at another commit', () => {
    expect(decideChainStart({ kind: 'branch-found', headSha: OTHER }, SHA)).toEqual({
      state: 'refused',
      reason: 'branch-exists-at-other-commit',
    });
  });

  it('keeps an absent or unreadable branch unknown', () => {
    const unknown = { state: 'unknown', reason: 'unresolved' };
    expect(decideChainStart({ kind: 'branch-absent' }, SHA)).toEqual(unknown);
    expect(decideChainStart({ kind: 'unavailable' }, SHA)).toEqual(unknown);
    expect(decideChainStart({ kind: 'branch-found', headSha: 'abc' }, SHA)).toEqual(unknown);
    expect(decideChainStart({ kind: 'branch-found', headSha: SHA }, 'abc')).toEqual(unknown);
    expect(decideChainStart(null as never, SHA)).toEqual(unknown);
  });
});
