import { describe, expect, it } from 'vitest';

import {
  premergeCarryMatches,
  qualifyBaseMergeCarry,
  readPremergeCarry,
  receiptCarryRefusalIsTransient,
} from '../receipt-carry.js';

const REVIEWED = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);
const MAIN_PARENT = 'c'.repeat(40);
const TREE = 'd'.repeat(40);
const BASE = 'e'.repeat(40);

function clean(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attemptId: 'attempt-1',
    reviewedHeadSha: REVIEWED,
    newHeadSha: NEW_HEAD,
    newHeadParents: [REVIEWED, MAIN_PARENT],
    secondParentOnBase: true,
    mainRangeBaseSha: BASE,
    automaticMergeTreeSha: TREE,
    newHeadTreeSha: TREE,
    prChangedPaths: ['src/a.ts', 'src/b.ts'],
    laneChangedPaths: ['src/b.ts', 'src/a.ts'],
    ci: 'passed',
    decidedAtIso: '2026-11-27T12:00:00.000Z',
    ...overrides,
  };
}

function refusalOf(overrides: Record<string, unknown>): string {
  const result = qualifyBaseMergeCarry(clean(overrides));
  expect(result.carry).toBe(false);
  return result.carry ? 'carried' : result.reason;
}

describe('qualifyBaseMergeCarry', () => {
  it('carries on a clean base merge', () => {
    const result = qualifyBaseMergeCarry(clean());
    expect(result).toEqual({
      carry: true,
      premergeCarry: {
        attemptId: 'attempt-1',
        fromHeadSha: REVIEWED,
        toHeadSha: NEW_HEAD,
        mainParentSha: MAIN_PARENT,
        mainRangeBaseSha: BASE,
        changedPaths: ['src/a.ts', 'src/b.ts'],
        decidedAtIso: '2026-11-27T12:00:00.000Z',
        reason: 'base-merge-clean',
      },
    });
  });

  it('refuses a conflict-resolved merge', () => {
    expect(refusalOf({ newHeadTreeSha: 'f'.repeat(40) })).toBe('conflict-resolved');
  });

  it('refuses a lane-authored change', () => {
    expect(refusalOf({ prChangedPaths: ['src/a.ts', 'src/b.ts', 'src/extra.ts'] })).toBe('lane-authored-change');
    expect(refusalOf({ prChangedPaths: ['src/a.ts'] })).toBe('lane-authored-change');
    expect(refusalOf({ prChangedPaths: [] })).toBe('lane-authored-change');
  });

  it('refuses a non-merge head move', () => {
    expect(refusalOf({ newHeadParents: [REVIEWED] })).toBe('not-a-merge-commit');
    expect(refusalOf({ newHeadParents: [REVIEWED, MAIN_PARENT, BASE] })).toBe('not-a-merge-commit');
  });

  it("refuses when the first parent isn't the reviewed head", () => {
    expect(refusalOf({ newHeadParents: [MAIN_PARENT, REVIEWED] })).toBe('first-parent-not-reviewed-head');
  });

  it('refuses when the second parent is not reachable from the base branch', () => {
    expect(refusalOf({ secondParentOnBase: false })).toBe('second-parent-not-on-base');
  });

  it('refuses with red CI', () => {
    expect(refusalOf({ ci: 'failed' })).toBe('ci-red');
  });

  it('waits, as a transient refusal, while CI is pending or unknown and while evidence is unknown', () => {
    for (const ci of ['pending', 'unknown']) {
      const reason = refusalOf({ ci });
      expect(reason).toBe('ci-not-ready');
      expect(receiptCarryRefusalIsTransient(reason as 'ci-not-ready')).toBe(true);
    }
    for (const field of ['secondParentOnBase', 'automaticMergeTreeSha', 'mainRangeBaseSha', 'prChangedPaths']) {
      expect(refusalOf({ [field]: null })).toBe('unknown-evidence');
    }
    expect(receiptCarryRefusalIsTransient('conflict-resolved')).toBe(false);
    expect(receiptCarryRefusalIsTransient('ci-red')).toBe(false);
  });

  it('refuses a PR or lane too wide to qualify as a definitive no, not as hostile input', () => {
    const wide = Array.from({ length: 5001 }, (_, index) => `src/f${index}.ts`);
    for (const field of ['prChangedPaths', 'laneChangedPaths']) {
      const result = qualifyBaseMergeCarry(clean({ [field]: wide }));
      expect(result).toEqual({ carry: false, reason: 'too-many-paths' });
      expect(receiptCarryRefusalIsTransient('too-many-paths')).toBe(false);
    }
  });

  it('refuses hostile input with invalid-input and never throws', () => {
    const getter = clean();
    Object.defineProperty(getter, 'ci', { enumerable: true, get: () => { throw new Error('boom'); } });
    const polluted = JSON.parse('{"__proto__": {"x": 1}}') as unknown;
    const hole = clean({ prChangedPaths: new Array(2) });
    const bad: unknown[] = [
      null,
      undefined,
      'x',
      [],
      getter,
      polluted,
      new Proxy(clean(), { ownKeys: () => { throw new Error('trap'); } }),
      hole,
      clean({ prChangedPaths: { length: 1, 0: 'a' } }),
      clean({ prChangedPaths: { length: 1_000_000_000 } }),
      clean({ newHeadParents: new Array(1_000_000).fill(REVIEWED) }),
      clean({ reviewedHeadSha: 'A'.repeat(40) }),
      clean({ newHeadSha: 'b'.repeat(39) }),
      clean({ newHeadParents: [REVIEWED, 'zz'] }),
      clean({ prChangedPaths: [''] }),
      clean({ prChangedPaths: [1] }),
      clean({ ci: 'green' }),
      clean({ decidedAtIso: 'yesterday' }),
      { ...clean(), extra: 1 },
    ];
    for (const input of bad) {
      expect(qualifyBaseMergeCarry(input)).toEqual({ carry: false, reason: 'invalid-input' });
    }
  });
});

describe('premerge carry record', () => {
  const carry = (): Record<string, unknown> => {
    const result = qualifyBaseMergeCarry(clean());
    if (!result.carry) {
      throw new Error('fixture must carry');
    }
    return { ...result.premergeCarry, changedPaths: [...result.premergeCarry.changedPaths] };
  };

  it('carry record round-trips from-head and to-head', () => {
    const read = readPremergeCarry(carry());
    expect(read?.fromHeadSha).toBe(REVIEWED);
    expect(read?.toHeadSha).toBe(NEW_HEAD);
    expect(premergeCarryMatches(read, REVIEWED, NEW_HEAD)).toBe(true);
    expect(premergeCarryMatches(read, REVIEWED, 'f'.repeat(40))).toBe(false);
    expect(premergeCarryMatches(read, REVIEWED, null)).toBe(false);
  });

  it('carry record with a non-40-hex sha or an unknown reason is refused', () => {
    expect(readPremergeCarry({ ...carry(), toHeadSha: 'abc' })).toBeNull();
    expect(readPremergeCarry({ ...carry(), reason: 'whatever' })).toBeNull();
    expect(readPremergeCarry({ ...carry(), extra: 1 })).toBeNull();
    expect(readPremergeCarry(null)).toBeNull();
  });
});
