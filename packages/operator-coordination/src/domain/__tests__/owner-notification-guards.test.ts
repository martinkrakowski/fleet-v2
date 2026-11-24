import { describe, expect, it } from 'vitest';
import {
  OWNER_NOTIFICATION_TRIGGERS,
  isOwnerNotificationId,
  isOwnerNotificationTrigger,
  ownerNotificationRateLimitKey,
} from '../owner-notification.js';

/** An object whose every property read and coercion throws, plus a call counter. */
function throwingTrapObject(): { valueOf: () => never; toString: () => never; calls: number } {
  const traps = {
    calls: 0,
    valueOf(): never {
      traps.calls += 1;
      throw new Error('valueOf refused');
    },
    toString(): never {
      traps.calls += 1;
      throw new Error('toString refused');
    },
  };
  return traps;
}

/** A getter-backed property object whose reads throw, plus a call counter. */
function throwingGetProxy(handler: () => never): { calls: number } & Record<PropertyKey, unknown> {
  const traps = {
    calls: 0,
  };
  return new Proxy(traps, {
    get() {
      handler();
      return undefined;
    },
  });
}

describe('OWNER_NOTIFICATION_TRIGGERS', () => {
  it('equals the four fixed triggers in order', () => {
    expect(OWNER_NOTIFICATION_TRIGGERS).toEqual([
      'attempt-ended',
      'attempt-blocked',
      'question-asked',
      'acceptance-blocker',
    ]);
  });
});

describe('isOwnerNotificationTrigger', () => {
  it('accepts each of the four fixed triggers', () => {
    for (const trigger of OWNER_NOTIFICATION_TRIGGERS) {
      expect(isOwnerNotificationTrigger(trigger)).toBe(true);
    }
  });

  it('rejects wrong case, trailing space, empty string, and non-strings', () => {
    expect(isOwnerNotificationTrigger('Attempt-Ended')).toBe(false);
    expect(isOwnerNotificationTrigger('attempt-ended ')).toBe(false);
    expect(isOwnerNotificationTrigger('')).toBe(false);
    expect(isOwnerNotificationTrigger(null)).toBe(false);
    expect(isOwnerNotificationTrigger(undefined)).toBe(false);
    expect(isOwnerNotificationTrigger(7)).toBe(false);
    expect(isOwnerNotificationTrigger(['attempt-ended'])).toBe(false);
    expect(isOwnerNotificationTrigger({})).toBe(false);
  });

  it('refuses hostile inputs without invoking getters or traps', () => {
    // Array hole: the slot is undefined, not a trigger string.
    const withHole: unknown[] = ['attempt-ended'];
    delete withHole[0];
    expect(isOwnerNotificationTrigger(withHole)).toBe(false);
    // Array-like is not an array and its length is not a trigger.
    expect(isOwnerNotificationTrigger({ 0: 'attempt-ended', length: 1 })).toBe(false);
    // Enormous length must not be iterated.
    expect(isOwnerNotificationTrigger({ length: 1e9 })).toBe(false);
    // Prototype-polluting keys are plain strings that are not triggers.
    expect(isOwnerNotificationTrigger('__proto__')).toBe(false);
    expect(isOwnerNotificationTrigger('constructor')).toBe(false);
    expect(isOwnerNotificationTrigger('prototype')).toBe(false);
    // A getter that throws is never reached: typeof short-circuits.
    let getterCalls = 0;
    const getterTraps = throwingGetProxy(() => {
      getterCalls += 1;
      throw new Error('getter refused');
    });
    expect(() => isOwnerNotificationTrigger(getterTraps)).not.toThrow();
    expect(getterCalls).toBe(0);
    // Coercion traps are never invoked.
    const coercionTraps = throwingTrapObject();
    expect(() => isOwnerNotificationTrigger(coercionTraps)).not.toThrow();
    expect(coercionTraps.calls).toBe(0);
    // A Proxy is refused, not unwrapped.
    expect(isOwnerNotificationTrigger(new Proxy({}, {}))).toBe(false);
  });
});

describe('isOwnerNotificationId', () => {
  it('accepts valid id slugs up to 128 characters', () => {
    expect(isOwnerNotificationId('a')).toBe(true);
    expect(isOwnerNotificationId('A1')).toBe(true);
    expect(isOwnerNotificationId('attempt-1')).toBe(true);
    expect(isOwnerNotificationId('run_1.2-x')).toBe(true);
    expect(isOwnerNotificationId('a'.repeat(128))).toBe(true);
  });

  it('rejects 129-char ids, empty strings, invalid prefixes, forbidden chars, trailing newline, and non-strings', () => {
    expect(isOwnerNotificationId('a'.repeat(129))).toBe(false);
    expect(isOwnerNotificationId('')).toBe(false);
    expect(isOwnerNotificationId('.abc')).toBe(false);
    expect(isOwnerNotificationId('-abc')).toBe(false);
    expect(isOwnerNotificationId('_abc')).toBe(false);
    expect(isOwnerNotificationId('__proto__')).toBe(false);
    expect(isOwnerNotificationId('a/b')).toBe(false);
    expect(isOwnerNotificationId('a b')).toBe(false);
    expect(isOwnerNotificationId('a\nb')).toBe(false);
    expect(isOwnerNotificationId('a:b')).toBe(false);
    expect(isOwnerNotificationId('a\x00b')).toBe(false);
    expect(isOwnerNotificationId('a\tb')).toBe(false);
    expect(isOwnerNotificationId('abc\n')).toBe(false);
    expect(isOwnerNotificationId(null)).toBe(false);
    expect(isOwnerNotificationId(undefined)).toBe(false);
    expect(isOwnerNotificationId(5)).toBe(false);
    expect(isOwnerNotificationId({})).toBe(false);
  });

  it('refuses hostile inputs without invoking getters or traps', () => {
    // Array hole: the slot is undefined, not an id string.
    const withHole: unknown[] = ['a'];
    delete withHole[0];
    expect(isOwnerNotificationId(withHole)).toBe(false);
    // Array-like is not a string.
    expect(isOwnerNotificationId({ 0: 'a', length: 1 })).toBe(false);
    // Enormous length must not be iterated.
    expect(isOwnerNotificationId({ length: 1e9 })).toBe(false);
    // A getter that throws is never reached: typeof short-circuits.
    let getterCalls = 0;
    const getterTraps = throwingGetProxy(() => {
      getterCalls += 1;
      throw new Error('getter refused');
    });
    expect(() => isOwnerNotificationId(getterTraps)).not.toThrow();
    expect(getterCalls).toBe(0);
    // Coercion traps are never invoked.
    const coercionTraps = throwingTrapObject();
    expect(() => isOwnerNotificationId(coercionTraps)).not.toThrow();
    expect(coercionTraps.calls).toBe(0);
    // A Proxy is refused, not unwrapped.
    expect(isOwnerNotificationId(new Proxy({}, {}))).toBe(false);
  });
});

describe('ownerNotificationRateLimitKey', () => {
  it('formats <trigger>:<id> and distinguishes triggers and ids', () => {
    expect(ownerNotificationRateLimitKey('attempt-ended', 'run-1')).toBe('attempt-ended:run-1');
    expect(ownerNotificationRateLimitKey('attempt-blocked', 'run-1')).not.toBe(
      ownerNotificationRateLimitKey('attempt-ended', 'run-1'),
    );
    expect(ownerNotificationRateLimitKey('attempt-ended', 'run-1')).not.toBe(
      ownerNotificationRateLimitKey('attempt-ended', 'run-2'),
    );
  });

  it('joins invalid ids verbatim because callers validate first', () => {
    // Callers must validate the id with isOwnerNotificationId before calling
    // this function; it joins whatever it is given, verbatim.
    expect(ownerNotificationRateLimitKey('attempt-ended', 'bad/id')).toBe('attempt-ended:bad/id');
  });
});
