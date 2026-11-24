import { describe, expect, it, vi } from 'vitest';

import {
  applyChainLanded,
  chainLinkBranchesOf,
  chainReviewRequestIdOf,
  createChainRecord,
  isChainActionKey,
  isChainCommitSha,
  isChainReasonCode,
  parseChainRepository,
} from './chain-records.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const REPO = { owner: 'fleet', repo: 'fleet-v2' };
const NOW = '2026-11-05T10:00:00.000Z';

function input(overrides: Record<string, unknown> = {}) {
  return { repository: REPO, chainName: 'example', expectedHeadSha: SHA, actionKey: 'chain-start-1', createdAtIso: NOW, ...overrides } as never;
}

/** Hostile shapes shared by every guard: never a thrown error, always a typed refusal. */
const HOSTILE_INPUTS: unknown[] = [
  null,
  undefined,
  42,
  true,
  new Array(2),
  { length: 2, 0: 'a', 1: 'b' },
  { length: 1e9 },
  JSON.parse('{"__proto__":{"owner":"acme","repo":"widgets"}}'),
];

describe('isChainCommitSha', () => {
  it('accepts a 40-character lowercase hex string', () => {
    expect(isChainCommitSha(SHA)).toBe(true);
  });

  it('refuses wrong lengths, uppercase, non-hex, abbreviated and newline-suffixed strings', () => {
    for (const bad of [
      'a'.repeat(39),
      `${SHA}a`,
      SHA.toUpperCase(),
      'g'.repeat(40),
      'abc1234',
      'a'.repeat(12),
      `${SHA}\n`,
    ]) {
      expect(isChainCommitSha(bad)).toBe(false);
    }
  });

  it('refuses non-strings and hostile inputs without throwing', () => {
    for (const bad of [...HOSTILE_INPUTS, [], {}]) {
      expect(isChainCommitSha(bad)).toBe(false);
    }
  });
});

describe('isChainActionKey', () => {
  it('accepts non-empty keys up to 256 bytes', () => {
    expect(isChainActionKey('chain-start-1')).toBe(true);
    expect(isChainActionKey('x'.repeat(256))).toBe(true);
  });

  it('refuses empty, whitespace-only, and over-256-byte keys (ASCII and multi-byte)', () => {
    for (const bad of ['', '   ', 'x'.repeat(257), 'é'.repeat(129)]) {
      expect(isChainActionKey(bad)).toBe(false);
    }
  });

  it('refuses non-strings and hostile inputs without throwing', () => {
    for (const bad of [...HOSTILE_INPUTS, [], {}]) {
      expect(isChainActionKey(bad)).toBe(false);
    }
  });

  it('refuses the secret-shaped key from chain-records.test.ts (token ghp_ + 36 chars)', () => {
    expect(isChainActionKey(`token ghp_${'a'.repeat(36)}`)).toBe(false);
  });
});

describe('parseChainRepository', () => {
  it('returns a frozen owner/repo pair and drops extra own keys', () => {
    const result = parseChainRepository({ owner: 'acme', repo: 'widgets', extra: 'ignored' });
    expect(result).toEqual({ owner: 'acme', repo: 'widgets' });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.keys(result ?? {})).toEqual(['owner', 'repo']);
  });

  it('refuses non-objects, arrays, missing or non-string fields', () => {
    for (const bad of [
      null,
      undefined,
      [],
      'acme/widgets',
      42,
      {},
      { owner: 'acme' },
      { repo: 'widgets' },
      { owner: 42, repo: 'widgets' },
      { owner: 'acme', repo: null },
    ]) {
      expect(parseChainRepository(bad)).toBeUndefined();
    }
  });

  it('refuses segments over 100 characters, invalid characters and dot segments', () => {
    for (const bad of [
      { owner: 'a'.repeat(101), repo: 'widgets' },
      { owner: 'acme', repo: 'a'.repeat(101) },
      { owner: 'a/b', repo: 'widgets' },
      { owner: 'acme', repo: 'a b' },
      { owner: '', repo: 'widgets' },
      { owner: 'acme', repo: '' },
      { owner: '.', repo: 'widgets' },
      { owner: 'acme', repo: '..' },
    ]) {
      expect(parseChainRepository(bad)).toBeUndefined();
    }
  });

  it('refuses inherited owner/repo supplied only through the prototype', () => {
    const inherited = Object.create({ owner: 'acme', repo: 'widgets' }) as object;
    expect(parseChainRepository(inherited)).toBeUndefined();
  });

  it('refuses getter-defined fields without running them and catches throwing Proxy traps', () => {
    const spy = vi.fn(() => 'acme');
    const getter = Object.defineProperty({}, 'owner', { get: spy, enumerable: true });
    expect(parseChainRepository(getter)).toBeUndefined();
    const protoGetter = Object.defineProperty(Object.create({ repo: 'widgets' }), 'owner', { get: spy, enumerable: true });
    expect(parseChainRepository(protoGetter)).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    const lying = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('boom'); } });
    expect(parseChainRepository(lying)).toBeUndefined();
  });

  it('refuses hostile inputs without throwing', () => {
    for (const bad of HOSTILE_INPUTS) {
      expect(parseChainRepository(bad)).toBeUndefined();
    }
  });
});

describe('isChainReasonCode', () => {
  it('accepts lowercase dashed codes up to 64 characters', () => {
    expect(isChainReasonCode('a')).toBe(true);
    expect(isChainReasonCode('head-moved')).toBe(true);
    expect(isChainReasonCode(`a${'b'.repeat(63)}`)).toBe(true);
  });

  it('refuses empty, uppercase, leading digit or dash, over-64, underscore and space', () => {
    for (const bad of ['', 'Head-moved', '1a', '-a', 'a'.repeat(65), 'head_moved', 'head moved']) {
      expect(isChainReasonCode(bad)).toBe(false);
    }
  });

  it('refuses non-strings and hostile inputs without throwing', () => {
    for (const bad of [...HOSTILE_INPUTS, [], {}]) {
      expect(isChainReasonCode(bad)).toBe(false);
    }
  });
});

describe('chainReviewRequestIdOf', () => {
  it('pins the exact chain-review:id:<head12> output with a 12-character sha cut', () => {
    expect(chainReviewRequestIdOf('c', SHA)).toBe('chain-review:c:0123456789ab');
  });
});

describe('chainLinkBranchesOf', () => {
  it('returns null when linkBranches is absent and the array when landed', () => {
    const created = createChainRecord(input());
    if (!created.ok) throw new Error('setup');
    expect(chainLinkBranchesOf(created.record)).toBeNull();
    const landed = applyChainLanded(created.record, ['chain/link-1']);
    expect(chainLinkBranchesOf(landed)).toEqual(['chain/link-1']);
  });
});
