import { describe, expect, it } from 'vitest';

import {
  appendCandidate,
  assessChainAgainstBase,
  invalidateFrom,
  promotionPreservesIdentity,
  receiptProvesCandidate,
  selectPromotable,
  validateCandidateChain,
  type CandidateChain,
} from '../candidate-chain.js';
import type { CandidateRecord } from '../entities/CandidateRecord.js';
import type { GateReceiptRecord } from '../entities/GateReceiptRecord.js';

function sha(n: number): string {
  return n.toString(16).padStart(40, '0');
}

function candidate(id: string, baseSha: string, resultSha: string, parentCandidateId: string | null): CandidateRecord {
  return { id, schemaVersion: 1, baseSha, resultSha, parentCandidateId };
}

function receipt(
  id: string,
  testedSha: string,
  gateProfile: string,
  result: GateReceiptRecord['result'],
): GateReceiptRecord {
  return { id, schemaVersion: 1, testedSha, gateProfile, result };
}

const c1 = candidate('c1', sha(1), sha(2), null);
const c2 = candidate('c2', sha(2), sha(3), 'c1');
const c3 = candidate('c3', sha(3), sha(4), 'c2');
const goodChain = [c1, c2, c3] as const;

describe('validateCandidateChain', () => {
  it('accepts a good chain', () => {
    const result = validateCandidateChain(goodChain, sha(1));
    expect(result).toEqual({ ok: true, value: [c1, c2, c3] });
  });

  it('refuses a non-array', () => {
    expect(validateCandidateChain({} as unknown, sha(1)).ok).toBe(false);
  });

  it('refuses an empty array', () => {
    expect(validateCandidateChain([], sha(1)).ok).toBe(false);
  });

  it('refuses a bad expected base sha', () => {
    expect(validateCandidateChain(goodChain, 'not-a-sha').ok).toBe(false);
    expect(validateCandidateChain(goodChain, '').ok).toBe(false);
  });

  it('refuses a duplicate id', () => {
    const result = validateCandidateChain([c1, c2, c1], sha(1));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('c1');
    }
  });

  it('refuses a head with a non-null parent', () => {
    const badHead = candidate('cBadHead', sha(1), sha(2), 'someone');
    const result = validateCandidateChain([badHead], sha(1));
    expect(result.ok).toBe(false);
  });

  it('refuses a head whose base differs from the expected base', () => {
    const wrongBaseHead = candidate('cWrongBase', sha(5), sha(6), null);
    const result = validateCandidateChain([wrongBaseHead], sha(1));
    expect(result.ok).toBe(false);
  });

  it('refuses a broken parent link', () => {
    const brokenParent = candidate('cBrokenParent', sha(2), sha(3), 'nope');
    const result = validateCandidateChain([c1, brokenParent], sha(1));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('cBrokenParent');
    }
  });

  it('refuses a broken baseSha link', () => {
    const brokenBase = candidate('cBrokenBase', sha(9), sha(3), 'c1');
    const result = validateCandidateChain([c1, brokenBase], sha(1));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('cBrokenBase');
    }
  });

  it('refuses a malformed record', () => {
    const shortSha = candidate('cShort', 'abc', sha(2), null);
    const result = validateCandidateChain([shortSha], sha(1));
    expect(result.ok).toBe(false);
  });

  it('does not throw on null, undefined, a number and a string', () => {
    expect(() => validateCandidateChain(null, sha(1))).not.toThrow();
    expect(() => validateCandidateChain(undefined, sha(1))).not.toThrow();
    expect(() => validateCandidateChain(42, sha(1))).not.toThrow();
    expect(() => validateCandidateChain('nope', sha(1))).not.toThrow();
    expect(validateCandidateChain(null, sha(1)).ok).toBe(false);
    expect(validateCandidateChain(undefined, sha(1)).ok).toBe(false);
    expect(validateCandidateChain(42, sha(1)).ok).toBe(false);
    expect(validateCandidateChain('nope', sha(1)).ok).toBe(false);
  });
});

describe('appendCandidate', () => {
  it('extends a chain', () => {
    const result = appendCandidate([c1, c2], c3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(3);
      expect(result.value[2]).toEqual(c3);
    }
  });

  it('refuses a bad link', () => {
    const result = appendCandidate([c1, c2], candidate('cX', sha(3), sha(4), 'wrong'));
    expect(result.ok).toBe(false);
  });

  it('starts a chain from an empty one', () => {
    const result = appendCandidate([], c1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]).toEqual(c1);
    }
  });

  it('refuses null, undefined and non-array chain without throwing', () => {
    expect(() => appendCandidate(null as unknown as CandidateChain, c1)).not.toThrow();
    expect(() => appendCandidate(undefined as unknown as CandidateChain, c1)).not.toThrow();
    expect(() => appendCandidate(42 as unknown as CandidateChain, c1)).not.toThrow();
    expect(() => appendCandidate('nope' as unknown as CandidateChain, c1)).not.toThrow();
    expect(() => appendCandidate({} as unknown as CandidateChain, c1)).not.toThrow();
    expect(appendCandidate(null as unknown as CandidateChain, c1)).toEqual({
      ok: false,
      reason: 'candidate chain must be an array',
    });
    expect(appendCandidate(undefined as unknown as CandidateChain, c1)).toEqual({
      ok: false,
      reason: 'candidate chain must be an array',
    });
    expect(appendCandidate(42 as unknown as CandidateChain, c1).ok).toBe(false);
    expect(appendCandidate('nope' as unknown as CandidateChain, c1).ok).toBe(false);
    expect(appendCandidate({} as unknown as CandidateChain, c1).ok).toBe(false);
  });
});

describe('invalidateFrom', () => {
  it('voids all three from C1 with kept empty', () => {
    expect(invalidateFrom(goodChain, 'c1')).toEqual({
      ok: true,
      value: { kept: [], voided: [c1, c2, c3] },
    });
  });

  it('keeps C1 and voids C2 and C3 from C2', () => {
    expect(invalidateFrom(goodChain, 'c2')).toEqual({
      ok: true,
      value: { kept: [c1], voided: [c2, c3] },
    });
  });

  it('voids only C3 from C3', () => {
    expect(invalidateFrom(goodChain, 'c3')).toEqual({
      ok: true,
      value: { kept: [c1, c2], voided: [c3] },
    });
  });

  it('refuses an unknown id', () => {
    const result = invalidateFrom(goodChain, 'nope');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('nope');
    }
  });

  it('does not mutate the input array', () => {
    const input = [c1, c2, c3];
    const copy = [...input];
    invalidateFrom(input, 'c2');
    expect(input).toEqual(copy);
  });

  it('refuses null, undefined and non-array chain without throwing', () => {
    expect(() => invalidateFrom(null as unknown as CandidateChain, 'c1')).not.toThrow();
    expect(() => invalidateFrom(undefined as unknown as CandidateChain, 'c1')).not.toThrow();
    expect(() => invalidateFrom(42 as unknown as CandidateChain, 'c1')).not.toThrow();
    expect(() => invalidateFrom('nope' as unknown as CandidateChain, 'c1')).not.toThrow();
    expect(() => invalidateFrom({} as unknown as CandidateChain, 'c1')).not.toThrow();
    expect(invalidateFrom(null as unknown as CandidateChain, 'c1')).toEqual({
      ok: false,
      reason: 'candidate chain must be an array',
    });
    expect(invalidateFrom(undefined as unknown as CandidateChain, 'c1')).toEqual({
      ok: false,
      reason: 'candidate chain must be an array',
    });
    expect(invalidateFrom(42 as unknown as CandidateChain, 'c1').ok).toBe(false);
    expect(invalidateFrom('nope' as unknown as CandidateChain, 'c1').ok).toBe(false);
    expect(invalidateFrom({} as unknown as CandidateChain, 'c1').ok).toBe(false);
  });
});

describe('assessChainAgainstBase', () => {
  it('returns intact for the head base', () => {
    expect(assessChainAgainstBase(goodChain, sha(1))).toEqual({ ok: true, value: { action: 'intact' } });
  });

  it('returns advance for the head result', () => {
    expect(assessChainAgainstBase(goodChain, sha(2))).toEqual({
      ok: true,
      value: { action: 'advance', landed: c1, remaining: [c2, c3] },
    });
  });

  it('returns rebuild for a different base', () => {
    const result = assessChainAgainstBase(goodChain, sha(9));
    expect(result).toEqual({
      ok: true,
      value: { action: 'rebuild', voided: [c1, c2, c3], rebuildFromSha: sha(9) },
    });
    if (result.ok && result.value.action === 'rebuild') {
      expect(result.value.voided).toHaveLength(3);
    }
  });

  it('refuses an empty chain', () => {
    expect(assessChainAgainstBase([], sha(1)).ok).toBe(false);
  });

  it('refuses a bad sha', () => {
    expect(assessChainAgainstBase(goodChain, 'bad').ok).toBe(false);
  });

  it('refuses null, undefined and non-array chain without throwing', () => {
    expect(() => assessChainAgainstBase(null as unknown as CandidateChain, sha(1))).not.toThrow();
    expect(() => assessChainAgainstBase(undefined as unknown as CandidateChain, sha(1))).not.toThrow();
    expect(() => assessChainAgainstBase(42 as unknown as CandidateChain, sha(1))).not.toThrow();
    expect(() => assessChainAgainstBase('nope' as unknown as CandidateChain, sha(1))).not.toThrow();
    expect(() => assessChainAgainstBase({} as unknown as CandidateChain, sha(1))).not.toThrow();
    expect(assessChainAgainstBase(null as unknown as CandidateChain, sha(1))).toEqual({
      ok: false,
      reason: 'candidate chain must be a non-empty array',
    });
    expect(assessChainAgainstBase(undefined as unknown as CandidateChain, sha(1))).toEqual({
      ok: false,
      reason: 'candidate chain must be a non-empty array',
    });
    expect(assessChainAgainstBase(42 as unknown as CandidateChain, sha(1)).ok).toBe(false);
    expect(assessChainAgainstBase('nope' as unknown as CandidateChain, sha(1)).ok).toBe(false);
    expect(assessChainAgainstBase({} as unknown as CandidateChain, sha(1)).ok).toBe(false);
  });
});

describe('receiptProvesCandidate', () => {
  it('is true for a passed receipt on the exact result with the same profile', () => {
    expect(receiptProvesCandidate(c1, receipt('r1', sha(2), 'profile-a', 'passed'), 'profile-a')).toBe(true);
  });

  it('is false for a failed receipt', () => {
    expect(receiptProvesCandidate(c1, receipt('r1', sha(2), 'profile-a', 'failed'), 'profile-a')).toBe(false);
  });

  it('is false for an infrastructure-failure receipt', () => {
    expect(
      receiptProvesCandidate(c1, receipt('r1', sha(2), 'profile-a', 'infrastructure-failure'), 'profile-a'),
    ).toBe(false);
  });

  it('is false for a receipt on another sha', () => {
    expect(receiptProvesCandidate(c1, receipt('r1', sha(1), 'profile-a', 'passed'), 'profile-a')).toBe(false);
  });

  it('is false for a different profile', () => {
    expect(receiptProvesCandidate(c1, receipt('r1', sha(2), 'profile-b', 'passed'), 'profile-a')).toBe(false);
  });

  it('returns false on null, undefined and invalid input without throwing', () => {
    expect(() =>
      receiptProvesCandidate(
        null as unknown as CandidateRecord,
        receipt('r1', sha(2), 'profile-a', 'passed'),
        'profile-a',
      ),
    ).not.toThrow();
    expect(() =>
      receiptProvesCandidate(
        undefined as unknown as CandidateRecord,
        receipt('r1', sha(2), 'profile-a', 'passed'),
        'profile-a',
      ),
    ).not.toThrow();
    expect(() =>
      receiptProvesCandidate(c1, null as unknown as GateReceiptRecord, 'profile-a'),
    ).not.toThrow();
    expect(() =>
      receiptProvesCandidate(c1, undefined as unknown as GateReceiptRecord, 'profile-a'),
    ).not.toThrow();
    expect(
      receiptProvesCandidate(
        null as unknown as CandidateRecord,
        receipt('r1', sha(2), 'profile-a', 'passed'),
        'profile-a',
      ),
    ).toBe(false);
    expect(
      receiptProvesCandidate(
        undefined as unknown as CandidateRecord,
        receipt('r1', sha(2), 'profile-a', 'passed'),
        'profile-a',
      ),
    ).toBe(false);
    expect(receiptProvesCandidate(c1, null as unknown as GateReceiptRecord, 'profile-a')).toBe(false);
    expect(receiptProvesCandidate(c1, undefined as unknown as GateReceiptRecord, 'profile-a')).toBe(false);
  });
});

describe('selectPromotable', () => {
  it('returns C1 when the base matches and C1 has a passing receipt', () => {
    const result = selectPromotable(
      goodChain,
      [receipt('r1', sha(2), 'profile-a', 'passed')],
      sha(1),
      'profile-a',
    );
    expect(result).toBe(c1);
  });

  it('returns null when only C2 and C3 have passing receipts', () => {
    const result = selectPromotable(
      goodChain,
      [
        receipt('r2', sha(3), 'profile-a', 'passed'),
        receipt('r3', sha(4), 'profile-a', 'passed'),
      ],
      sha(1),
      'profile-a',
    );
    expect(result).toBeNull();
  });

  it('returns null when the observed base no longer matches the head', () => {
    const result = selectPromotable(
      goodChain,
      [receipt('r1', sha(2), 'profile-a', 'passed')],
      sha(2),
      'profile-a',
    );
    expect(result).toBeNull();
  });

  it('returns null for an empty chain', () => {
    const result = selectPromotable([], [receipt('r1', sha(2), 'profile-a', 'passed')], sha(1), 'profile-a');
    expect(result).toBeNull();
  });

  it('returns null on null, undefined and non-array input without throwing', () => {
    expect(() =>
      selectPromotable(
        null as unknown as CandidateChain,
        [receipt('r1', sha(2), 'profile-a', 'passed')],
        sha(1),
        'profile-a',
      ),
    ).not.toThrow();
    expect(() =>
      selectPromotable(
        undefined as unknown as CandidateChain,
        [receipt('r1', sha(2), 'profile-a', 'passed')],
        sha(1),
        'profile-a',
      ),
    ).not.toThrow();
    expect(() =>
      selectPromotable(
        42 as unknown as CandidateChain,
        [receipt('r1', sha(2), 'profile-a', 'passed')],
        sha(1),
        'profile-a',
      ),
    ).not.toThrow();
    expect(() =>
      selectPromotable(
        'nope' as unknown as CandidateChain,
        [receipt('r1', sha(2), 'profile-a', 'passed')],
        sha(1),
        'profile-a',
      ),
    ).not.toThrow();
    expect(() =>
      selectPromotable(
        {} as unknown as CandidateChain,
        [receipt('r1', sha(2), 'profile-a', 'passed')],
        sha(1),
        'profile-a',
      ),
    ).not.toThrow();
    expect(() =>
      selectPromotable(goodChain, null as unknown as readonly GateReceiptRecord[], sha(1), 'profile-a'),
    ).not.toThrow();
    expect(() =>
      selectPromotable(goodChain, undefined as unknown as readonly GateReceiptRecord[], sha(1), 'profile-a'),
    ).not.toThrow();
    expect(() =>
      selectPromotable(goodChain, 42 as unknown as readonly GateReceiptRecord[], sha(1), 'profile-a'),
    ).not.toThrow();
    expect(() =>
      selectPromotable(goodChain, {} as unknown as readonly GateReceiptRecord[], sha(1), 'profile-a'),
    ).not.toThrow();

    expect(
      selectPromotable(
        null as unknown as CandidateChain,
        [receipt('r1', sha(2), 'profile-a', 'passed')],
        sha(1),
        'profile-a',
      ),
    ).toBeNull();
    expect(
      selectPromotable(
        undefined as unknown as CandidateChain,
        [receipt('r1', sha(2), 'profile-a', 'passed')],
        sha(1),
        'profile-a',
      ),
    ).toBeNull();
    expect(
      selectPromotable(
        42 as unknown as CandidateChain,
        [receipt('r1', sha(2), 'profile-a', 'passed')],
        sha(1),
        'profile-a',
      ),
    ).toBeNull();
    expect(
      selectPromotable(
        'nope' as unknown as CandidateChain,
        [receipt('r1', sha(2), 'profile-a', 'passed')],
        sha(1),
        'profile-a',
      ),
    ).toBeNull();
    expect(
      selectPromotable(
        {} as unknown as CandidateChain,
        [receipt('r1', sha(2), 'profile-a', 'passed')],
        sha(1),
        'profile-a',
      ),
    ).toBeNull();
    expect(
      selectPromotable(goodChain, null as unknown as readonly GateReceiptRecord[], sha(1), 'profile-a'),
    ).toBeNull();
    expect(
      selectPromotable(goodChain, undefined as unknown as readonly GateReceiptRecord[], sha(1), 'profile-a'),
    ).toBeNull();
    expect(
      selectPromotable(goodChain, 42 as unknown as readonly GateReceiptRecord[], sha(1), 'profile-a'),
    ).toBeNull();
    expect(
      selectPromotable(goodChain, {} as unknown as readonly GateReceiptRecord[], sha(1), 'profile-a'),
    ).toBeNull();
  });
});

describe('promotionPreservesIdentity', () => {
  it('is true for the same sha', () => {
    expect(promotionPreservesIdentity(c1, sha(2))).toBe(true);
  });

  it('is false for another sha', () => {
    expect(promotionPreservesIdentity(c1, sha(9))).toBe(false);
  });

  it('returns false on null, undefined and invalid input without throwing', () => {
    expect(() => promotionPreservesIdentity(null as unknown as CandidateRecord, sha(2))).not.toThrow();
    expect(() => promotionPreservesIdentity(undefined as unknown as CandidateRecord, sha(2))).not.toThrow();
    expect(() => promotionPreservesIdentity(42 as unknown as CandidateRecord, sha(2))).not.toThrow();
    expect(() => promotionPreservesIdentity('nope' as unknown as CandidateRecord, sha(2))).not.toThrow();
    expect(() => promotionPreservesIdentity([] as unknown as CandidateRecord, sha(2))).not.toThrow();
    expect(promotionPreservesIdentity(null as unknown as CandidateRecord, sha(2))).toBe(false);
    expect(promotionPreservesIdentity(undefined as unknown as CandidateRecord, sha(2))).toBe(false);
    expect(promotionPreservesIdentity(42 as unknown as CandidateRecord, sha(2))).toBe(false);
    expect(promotionPreservesIdentity('nope' as unknown as CandidateRecord, sha(2))).toBe(false);
    expect(promotionPreservesIdentity([] as unknown as CandidateRecord, sha(2))).toBe(false);
  });
});
