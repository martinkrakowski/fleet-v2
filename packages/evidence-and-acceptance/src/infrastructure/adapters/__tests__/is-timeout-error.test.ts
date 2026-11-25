import { describe, expect, it } from 'vitest';

import { isTimeoutError } from '../OcmReviewTransport.adapter.js';

describe('isTimeoutError', () => {
  it('returns true for an AbortError name, an ETIMEDOUT code, and an Error with an AbortError name', () => {
    expect(isTimeoutError({ name: 'AbortError' })).toBe(true);
    expect(isTimeoutError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isTimeoutError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
  });

  it('returns true for timeout phrases in the message regardless of case', () => {
    expect(isTimeoutError({ message: 'timed out' })).toBe(true);
    expect(isTimeoutError({ message: 'Timed Out' })).toBe(true);
    expect(isTimeoutError({ message: 'timedout' })).toBe(true);
    expect(isTimeoutError({ message: 'timeout' })).toBe(true);
    expect(isTimeoutError({ message: 'TIMEOUT' })).toBe(true);
    expect(isTimeoutError({ message: 'request timeout after 5s' })).toBe(true);
  });

  it('returns false for non-string message and non-matching messages', () => {
    expect(isTimeoutError({ message: 5 })).toBe(false);
    expect(isTimeoutError({ message: 'connection refused' })).toBe(false);
    expect(isTimeoutError({ message: '' })).toBe(false);
    // Pinned: the hyphen form is not matched by the current regex.
    expect(isTimeoutError({ message: 'time-out' })).toBe(false);
  });

  it('returns false for null and undefined', () => {
    expect(isTimeoutError(null)).toBe(false);
    expect(isTimeoutError(undefined)).toBe(false);
  });

  it('returns false for non-object primitives even when they look like timeouts', () => {
    expect(isTimeoutError('timeout')).toBe(false);
    expect(isTimeoutError(42)).toBe(false);
  });

  it('returns false for arrays even with timeout elements or AbortError name', () => {
    expect(isTimeoutError(['timeout'])).toBe(false);
    expect(isTimeoutError(Object.assign(['x'], { name: 'AbortError' }))).toBe(false);
  });

  it('returns false without throwing when name getter throws', () => {
    const hostile = {
      get name(): string {
        throw new Error('no name for you');
      },
    };
    expect(isTimeoutError(hostile)).toBe(false);
  });

  it('returns false without throwing when Proxy get trap throws', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('no get for you');
        },
      },
    );
    expect(isTimeoutError(hostile)).toBe(false);
  });

  it('observed behaviour: returns true for unanchored "notimeouts" message', () => {
    // The regex /timed?\s*out|timeout/i is unanchored, so a message that
    // merely contains the substring "timeout" (as in "notimeouts") matches.
    // This pins today's observed behaviour; tightening the regex must
    // consciously change this test.
    expect(isTimeoutError({ message: 'notimeouts' })).toBe(true);
  });

  it('returns false for a 1,000,000-character non-matching message', () => {
    // Cost bound: two property reads (name, code), one message read, and one
    // regex test over the message — linear in message length, O(n).
    expect(isTimeoutError({ message: 'a'.repeat(1_000_000) })).toBe(false);
  });
});
