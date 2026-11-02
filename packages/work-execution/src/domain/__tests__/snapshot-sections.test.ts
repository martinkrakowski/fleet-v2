import { describe, expect, it } from 'vitest';

import {
  applySnapshotPush,
  isSnapshotSection,
  parseSnapshotPush,
  readSnapshotSection,
  SNAPSHOT_SECTIONS,
  type SectionSnapshotPush,
  type SnapshotProjection,
} from '../snapshot-sections.js';

const AT = '2026-11-01T12:00:00.000Z';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function push(overrides: Partial<SectionSnapshotPush> = {}): SectionSnapshotPush {
  return {
    section: 'running',
    revision: 1,
    tokens: ['tool:bash', 'exit:0'],
    pushedAtIso: AT,
    ...overrides,
  };
}

describe('snapshot-sections', () => {
  it('unknown-section-refused', () => {
    expect(isSnapshotSection('running')).toBe(true);
    expect(isSnapshotSection('train')).toBe(true);
    expect(isSnapshotSection('parks')).toBe(true);
    expect(isSnapshotSection('halt')).toBe(true);
    expect(isSnapshotSection('bogus')).toBe(false);
    expect(SNAPSHOT_SECTIONS).toEqual(['running', 'train', 'parks', 'halt']);
    expect(parseSnapshotPush(deepFreeze({ ...push(), section: 'bogus' }))).toEqual({
      ok: false,
      reason: 'unknown-section',
    });
  });

  it('tokens-only', () => {
    expect(parseSnapshotPush(deepFreeze({ ...push(), tokens: [7] }))).toEqual({
      ok: false,
      reason: 'tokens-not-tokens',
    });
    expect(parseSnapshotPush(deepFreeze({ ...push(), tokens: [''] }))).toEqual({
      ok: false,
      reason: 'tokens-not-tokens',
    });
    expect(parseSnapshotPush(deepFreeze({ ...push(), path: '/repo/work' }))).toEqual({
      ok: false,
      reason: 'extra-fields',
    });
    expect(parseSnapshotPush(deepFreeze({ ...push(), text: 'step text' }))).toEqual({
      ok: false,
      reason: 'extra-fields',
    });
    const parsed = parseSnapshotPush(deepFreeze(push()));
    expect(parsed).toEqual({ ok: true, push: push() });
  });

  it('token-grammar-refused', () => {
    expect(parseSnapshotPush(deepFreeze({ ...push(), tokens: ['/mnt/pool/file.txt'] }))).toEqual({
      ok: false,
      reason: 'tokens-not-tokens',
    });
    expect(parseSnapshotPush(deepFreeze({ ...push(), tokens: ['step completed successfully'] }))).toEqual({
      ok: false,
      reason: 'tokens-not-tokens',
    });
    expect(parseSnapshotPush(deepFreeze({ ...push(), tokens: ['owner asked for a review'] }))).toEqual({
      ok: false,
      reason: 'tokens-not-tokens',
    });
  });

  it('secret-shaped-refused', () => {
    const secret = 'ghp_' + 'i'.repeat(30);
    const inTokens = parseSnapshotPush(deepFreeze({ ...push(), tokens: [secret] }));
    expect(inTokens).toEqual({ ok: false, reason: 'secret-shaped' });
    const inTime = parseSnapshotPush(deepFreeze({ ...push(), pushedAtIso: secret }));
    expect(inTime).toEqual({ ok: false, reason: 'secret-shaped' });
    expect(JSON.stringify(inTokens)).not.toContain(secret);
    expect(JSON.stringify(inTime)).not.toContain(secret);
  });

  it('non-increasing-revision-refused', () => {
    const base: SnapshotProjection = {
      running: { revision: 3, tokens: ['a'], pushedAtIso: AT },
      train: { revision: 1, tokens: ['b'], pushedAtIso: AT },
    };
    const frozen = deepFreeze(base);
    const same = applySnapshotPush(frozen, push({ revision: 3 }));
    expect(same.result).toEqual({ outcome: 'refused', reason: 'non-increasing-revision' });
    expect(same.next).toBe(frozen);
    const older = applySnapshotPush(frozen, push({ revision: 2 }));
    expect(older.result).toEqual({ outcome: 'refused', reason: 'non-increasing-revision' });
    expect(older.next).toBe(frozen);
    const newer = applySnapshotPush(frozen, push({ revision: 4, tokens: ['c'] }));
    expect(newer.result).toEqual({ outcome: 'applied' });
    expect(newer.next.running).toEqual({ revision: 4, tokens: ['c'], pushedAtIso: AT });
    expect(newer.next.train).toEqual(frozen.train);
  });

  it('input-never-mutated', () => {
    const base: SnapshotProjection = {
      running: { revision: 1, tokens: ['a'], pushedAtIso: AT },
      halt: { revision: 2, tokens: ['z'], pushedAtIso: AT },
    };
    const frozen = deepFreeze(base);
    const { next } = applySnapshotPush(frozen, push({ revision: 2, tokens: ['b'] }));
    expect(next).not.toBe(frozen);
    expect(frozen.running).toEqual({ revision: 1, tokens: ['a'], pushedAtIso: AT });
    expect(frozen.halt).toEqual({ revision: 2, tokens: ['z'], pushedAtIso: AT });
  });

  it('read-reports-time-not-guesses', () => {
    const projection: SnapshotProjection = {
      running: { revision: 1, tokens: ['tool:bash'], pushedAtIso: AT },
    };
    expect(readSnapshotSection(projection, 'running')).toEqual({
      state: 'fresh',
      tokens: ['tool:bash'],
      pushedAtIso: AT,
    });
    expect(readSnapshotSection(projection, 'halt')).toEqual({
      state: 'never-pushed',
      pushedAtIso: null,
    });
  });
});
