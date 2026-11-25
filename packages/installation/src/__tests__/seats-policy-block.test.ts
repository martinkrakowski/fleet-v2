import { describe, expect, it } from 'vitest';

import { SEAT_ROTATION_ROLES, readSeatsPolicyBlock } from '../seats-policy.js';

/*
 * Cost bounds under test (see readSeatsPolicyBlock):
 * - Each block read is linear in the number of own keys: three known keys are read via
 *   readOwnDataProperty, and hasUnknownKeys walks Object.keys once.
 * - readRotate is linear in the rotate array length; the distinctness check means it can
 *   stop early, but a hostile enormous array must still be refused in bounded (linear)
 *   time, which the 100,000-entry test proves without a timeout.
 * Every refusal is a typed `{ ok: false, errors }` result; the function never throws.
 */

/** Builds a 100,000-entry rotate array at runtime without any literal long fixtures. */
function hugeRotate(entry: string): string[] {
  return new Array(100_000).fill(entry);
}

/** Builds `['fix', <hole>, 'review']` at runtime so no sparse-array literal appears in this file. */
function holeyRotate(): (string | undefined)[] {
  const holey = ['fix'];
  holey[2] = 'review';
  return holey;
}

describe('readSeatsPolicyBlock (valid inputs)', () => {
  it('accepts an empty object and returns an empty policy', () => {
    expect(readSeatsPolicyBlock({})).toEqual({ ok: true, policy: {} });
  });

  it('accepts a full valid block and freezes policy.rotate', () => {
    const result = readSeatsPolicyBlock({
      rotate: ['first-pass', 'fix'],
      cooldownMinutes: 60,
      observationCooldownMinutes: 0,
    });
    expect(result).toEqual({
      ok: true,
      policy: { rotate: ['first-pass', 'fix'], cooldownMinutes: 60, observationCooldownMinutes: 0 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.isFrozen(result.policy.rotate)).toBe(true);
    }
  });

  it('accepts every declared rotation role alone', () => {
    for (const role of SEAT_ROTATION_ROLES) {
      const result = readSeatsPolicyBlock({ rotate: [role] });
      expect(result).toEqual({ ok: true, policy: { rotate: [role] } });
    }
  });

  it('accepts the minute boundary values 0 and 1440 for both fields', () => {
    for (const key of ['cooldownMinutes', 'observationCooldownMinutes'] as const) {
      expect(readSeatsPolicyBlock({ [key]: 0 })).toEqual({ ok: true, policy: { [key]: 0 } });
      expect(readSeatsPolicyBlock({ [key]: 1440 })).toEqual({ ok: true, policy: { [key]: 1440 } });
    }
  });
});

describe('readSeatsPolicyBlock (refusals)', () => {
  it('refuses non-plain-object inputs with the must-be-an-object error', () => {
    const badInputs: unknown[] = [
      null,
      undefined,
      [],
      'x',
      5,
      new Map(),
      new (class {})(),
      Object.create({ rotate: ['fix'] }),
    ];
    for (const input of badInputs) {
      expect(readSeatsPolicyBlock(input)).toEqual({
        ok: false,
        errors: ['policy.seats: must be an object'],
      });
    }
  });

  it('refuses a Proxy that throws on ownKeys without throwing', () => {
    const throwing = new Proxy({}, {
      ownKeys() {
        throw new Error('hostile ownKeys');
      },
      getOwnPropertyDescriptor() {
        throw new Error('hostile descriptor');
      },
    });
    expect(() => readSeatsPolicyBlock(throwing)).not.toThrow();
    expect(readSeatsPolicyBlock(throwing)).toEqual({
      ok: false,
      errors: ['policy.seats: must be an object'],
    });
  });

  it('refuses an unknown key with the unknown-key error', () => {
    expect(readSeatsPolicyBlock({ nope: 1 })).toEqual({
      ok: false,
      errors: ['policy.seats: unknown key'],
    });
  });

  it('refuses duplicate, unknown, non-array, array-like, and hole-y rotate values', () => {
    const expected = {
      ok: false,
      errors: ['policy.seats.rotate: must be a list of distinct roles from first-pass, fix, review, pre-merge'],
    };
    const badRotates: unknown[] = [
      ['fix', 'fix'],
      ['not-a-role'],
      'fix',
      { 0: 'fix', length: 1 },
      holeyRotate(),
    ];
    for (const rotate of badRotates) {
      expect(readSeatsPolicyBlock({ rotate })).toEqual(expected);
    }
    expect(readSeatsPolicyBlock({ rotate: holeyRotate() })).toEqual(expected);
  });

  it('refuses out-of-range and non-integer cooldownMinutes values', () => {
    const expected = {
      ok: false,
      errors: ['policy.seats.cooldownMinutes: must be an integer from 0 to 1440'],
    };
    for (const value of [-1, 1441, 1.5, '60', Number.NaN, Number.POSITIVE_INFINITY, null]) {
      expect(readSeatsPolicyBlock({ cooldownMinutes: value })).toEqual(expected);
    }
  });

  it('refuses out-of-range and non-integer observationCooldownMinutes values', () => {
    const expected = {
      ok: false,
      errors: ['policy.seats.observationCooldownMinutes: must be an integer from 0 to 1440'],
    };
    for (const value of [-1, 1441, 1.5, '60', Number.NaN, Number.POSITIVE_INFINITY, null]) {
      expect(readSeatsPolicyBlock({ observationCooldownMinutes: value })).toEqual(expected);
    }
  });

  it('reports both cooldownMinutes and observationCooldownMinutes errors together', () => {
    expect(readSeatsPolicyBlock({ cooldownMinutes: -1, observationCooldownMinutes: 1441 })).toEqual({
      ok: false,
      errors: [
        'policy.seats.cooldownMinutes: must be an integer from 0 to 1440',
        'policy.seats.observationCooldownMinutes: must be an integer from 0 to 1440',
      ],
    });
  });

  it('never echoes invalid field values in error output', () => {
    const marker = ['marker-', 'zz'].join('');
    const badRotate = readSeatsPolicyBlock({ rotate: [marker] });
    const badMinutes = readSeatsPolicyBlock({ cooldownMinutes: marker });
    expect(badRotate.ok).toBe(false);
    expect(badMinutes.ok).toBe(false);
    expect(JSON.stringify(badRotate)).not.toContain(marker);
    expect(JSON.stringify(badMinutes)).not.toContain(marker);
  });

  it('never invokes an own accessor getter on rotate and treats it as absent', () => {
    let getterRuns = 0;
    const value = {
      get rotate(): string[] {
        getterRuns += 1;
        return ['fix'];
      },
    };
    const result = readSeatsPolicyBlock(value);
    expect(getterRuns).toBe(0);
    expect(result).toEqual({ ok: true, policy: {} });
  });

  it('refuses prototype-polluting __proto__ input and leaves Object.prototype unpolluted', () => {
    const input: Record<string, unknown> = JSON.parse('{"__proto__":{"rotate":["fix"]}}');
    const result = readSeatsPolicyBlock(input);
    expect(result.ok).toBe(false);
    expect((Object.prototype as Record<string, unknown>).rotate).toBeUndefined();
  });

  it('refuses a 100,000-entry rotate array within linear cost', () => {
    const duplicate = readSeatsPolicyBlock({ rotate: hugeRotate('fix') });
    expect(duplicate).toEqual({
      ok: false,
      errors: ['policy.seats.rotate: must be a list of distinct roles from first-pass, fix, review, pre-merge'],
    });
    const mixed = hugeRotate('fix');
    mixed[0] = 'first-pass';
    const unknownRole = readSeatsPolicyBlock({ rotate: mixed });
    expect(unknownRole.ok).toBe(false);
    if (!unknownRole.ok) {
      expect(unknownRole.errors[0]).toBe('policy.seats.rotate: must be a list of distinct roles from first-pass, fix, review, pre-merge');
    }
  });
});
