import { describe, expect, it } from 'vitest';

import { validateQueueEntryEligibility } from '../entities/QueueEntryRecord.js';

/**
 * Direct unit tests for validateQueueEntryEligibility.
 *
 * Cost bound: the validator inspects only `typeof value`, `Array.isArray(value)`,
 * `value.kind` and (when blocked) `value.reason` — no loops, no recursion — so
 * every check is O(1) in the input, with no deadline/budget concern.
 *
 * These tests pin today's production behaviour for every hostile shape,
 * including the array-like case (tests-only unit; the production array-like
 * refusal is out of scope and tracked as a separate finding).
 */
describe('validateQueueEntryEligibility', () => {
  describe('eligible shape and extra-key stripping', () => {
    it('accepts exactly { kind: "eligible" } and strips extra keys from the parsed value', () => {
      const result = validateQueueEntryEligibility({ kind: 'eligible' });
      expect(result).toStrictEqual({ ok: true, value: { kind: 'eligible' } });
    });

    it('accepts an eligible input with extra keys and returns a fresh stripped value', () => {
      const input = { kind: 'eligible', reason: 'x', extra: 1 };
      const result = validateQueueEntryEligibility(input);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected acceptance');
      expect(result.value).toStrictEqual({ kind: 'eligible' });
      expect(result.value).not.toBe(input);
    });
  });

  describe('blocked shape, extra-key stripping, and verbatim reason', () => {
    it('accepts { kind: "blocked", reason } verbatim and strips extra keys', () => {
      const result = validateQueueEntryEligibility({ kind: 'blocked', reason: 'why' });
      expect(result).toStrictEqual({ ok: true, value: { kind: 'blocked', reason: 'why' } });

      const padded = validateQueueEntryEligibility({ kind: 'blocked', reason: '  why  ', extra: 1 });
      expect(padded.ok).toBe(true);
      if (!padded.ok) throw new Error('expected acceptance');
      // isNonEmptyString checks only value.length > 0 without trimming, so the
      // reason is carried through verbatim, whitespace included.
      expect(padded.value).toStrictEqual({ kind: 'blocked', reason: '  why  ' });
    });

    it('keeps a reason with surrounding whitespace verbatim without trimming', () => {
      const result = validateQueueEntryEligibility({ kind: 'blocked', reason: '  why  ' });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected acceptance');
      if (result.value.kind !== 'blocked') throw new Error('expected a blocked eligibility');
      expect(result.value.reason).toBe('  why  ');
    });
  });

  describe('blocked with invalid reason', () => {
    it('refuses blocked entries with missing, empty, or non-string reason', () => {
      const expected = { ok: false as const, reason: 'a blocked queue entry must carry a non-empty reason' };
      expect(validateQueueEntryEligibility({ kind: 'blocked' })).toStrictEqual(expected);
      expect(validateQueueEntryEligibility({ kind: 'blocked', reason: '' })).toStrictEqual(expected);
      expect(validateQueueEntryEligibility({ kind: 'blocked', reason: null })).toStrictEqual(expected);
      expect(validateQueueEntryEligibility({ kind: 'blocked', reason: 0 })).toStrictEqual(expected);
      expect(validateQueueEntryEligibility({ kind: 'blocked', reason: ['x'] })).toStrictEqual(expected);
      expect(validateQueueEntryEligibility({ kind: 'blocked', reason: new String('x') })).toStrictEqual(expected);
    });
  });

  describe('blocked with whitespace-only reason', () => {
    it('accepts a whitespace-only reason today, pinning the untrimmed length check', () => {
      // Pinned behaviour: isNonEmptyString in validation.ts checks
      // `value.length > 0` without trimming, so ' ' is a non-empty string and
      // the entry is accepted with the blank reason carried verbatim.
      const result = validateQueueEntryEligibility({ kind: 'blocked', reason: ' ' });
      expect(result).toStrictEqual({ ok: true, value: { kind: 'blocked', reason: ' ' } });
    });
  });

  describe('non-object inputs', () => {
    it('refuses non-object and array inputs with the plain-object reason', () => {
      const expected = { ok: false as const, reason: 'queue entry eligibility must be a plain object' };
      expect(validateQueueEntryEligibility(null)).toStrictEqual(expected);
      expect(validateQueueEntryEligibility(undefined)).toStrictEqual(expected);
      expect(validateQueueEntryEligibility('eligible')).toStrictEqual(expected);
      expect(validateQueueEntryEligibility(42)).toStrictEqual(expected);
      expect(validateQueueEntryEligibility(true)).toStrictEqual(expected);
      expect(validateQueueEntryEligibility([])).toStrictEqual(expected);
      expect(validateQueueEntryEligibility([{ kind: 'eligible' }])).toStrictEqual(expected);
    });

    it('accepts an array-like object today because only Array.isArray is checked', () => {
      // Pinned behaviour: an array-like plain object ({ length: 3 }) passes the
      // typeof/Array.isArray gate and then fails on its missing kind, with the
      // plain-object reason never seen for this shape.
      const result = validateQueueEntryEligibility({ length: 3 });
      expect(result).toStrictEqual({ ok: false as const, reason: 'queue entry eligibility kind must be "eligible" or "blocked"' });
    });
  });

  describe('unknown or missing kind', () => {
    it('refuses missing or unknown kind with the kind reason', () => {
      const expected = {
        ok: false as const,
        reason: 'queue entry eligibility kind must be "eligible" or "blocked"',
      };
      expect(validateQueueEntryEligibility({ kind: 'Eligible' })).toStrictEqual(expected);
      expect(validateQueueEntryEligibility({ kind: '' })).toStrictEqual(expected);
      expect(validateQueueEntryEligibility({ kind: undefined })).toStrictEqual(expected);
      expect(validateQueueEntryEligibility({})).toStrictEqual(expected);
      expect(validateQueueEntryEligibility({ kind: 1 })).toStrictEqual(expected);
    });
  });

  describe('throwing kind accessor and null-prototype object', () => {
    it('throws when kind is an own accessor that throws without invoking it more than once', () => {
      const boom = new Error('getter exploded');
      let calls = 0;
      const input = {
        get kind(): string {
          calls += 1;
          throw boom;
        },
      };
      expect(() => validateQueueEntryEligibility(input)).toThrow(boom);
      // The validator reads `eligibility.kind` exactly once with no try/catch,
      // so the getter must have run exactly once.
      expect(calls).toBe(1);
    });

    it('accepts a null-prototype object with kind eligible', () => {
      const input: Record<string, unknown> = Object.create(null);
      input.kind = 'eligible';
      const result = validateQueueEntryEligibility(input);
      expect(result).toStrictEqual({ ok: true, value: { kind: 'eligible' } });
    });
  });

  describe('__proto__ own key', () => {
    it('ignores a __proto__ own key and leaves Object.prototype unpolluted', () => {
      const input = JSON.parse('{"kind":"eligible","__proto__":{"kind":"blocked"}}') as Record<string, unknown>;
      const result = validateQueueEntryEligibility(input);
      expect(result).toStrictEqual({ ok: true, value: { kind: 'eligible' } });
      expect(({} as Record<string, unknown>).kind).toBeUndefined();
    });
  });
});
