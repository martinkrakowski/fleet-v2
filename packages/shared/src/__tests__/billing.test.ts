import { describe, expect, it } from 'vitest';
import { SEAT_BILLINGS, billingOf } from '../index.js';

describe('billingOf (telemetry plan §3.6)', () => {
  it.each([
    ['opencode', 'metered'],
    ['agy', 'plan'],
    ['later-kind', 'unknown'],
    ['', 'unknown'],
    ['OPENCODE', 'unknown'],
    [' opencode', 'unknown'],
    [null, 'unknown'],
    [undefined, 'unknown'],
    [42, 'unknown'],
    [{ kind: 'opencode' }, 'unknown'],
  ])('maps %j to %j', (runnerKind, expected) => {
    expect(billingOf(runnerKind)).toBe(expected);
  });

  it('exposes exactly the three seat billings', () => {
    expect(SEAT_BILLINGS).toEqual(['metered', 'plan', 'unknown']);
  });

  it('always returns a known seat billing', () => {
    const kinds = ['opencode', 'agy', 'later-kind', '', null, undefined, 42] as const;
    for (const kind of kinds) {
      expect(SEAT_BILLINGS).toContain(billingOf(kind));
    }
  });
});
