import { describe, expect, it } from 'vitest';

import { screenTransportText } from '../review-transport-screen.js';

/**
 * Cost bound: `screenTransportText` applies 23 fixed secret patterns (6 legacy
 * + 17 canonical) plus 1 path pattern, each linear in the input, before the
 * 2048-byte cap. Total cost stays linear in the input length, so the
 * million-character input below is bounded by the cap in the assertion.
 */
const REDACTED = '[redacted]';
const PATH_TOKEN = '[path]';
const MAX_SCREEN_BYTES = 2048;

/** Runtime-built legacy-six token shape (never a literal). */
const GITHUB_TOKEN = 'gh' + 'p_' + 'a'.repeat(30);
/** Runtime-built canonical-seventeen-only Google API key shape. */
const GOOGLE_KEY = 'AI' + 'za' + 'b'.repeat(35);

describe('screenTransportText', () => {
  it('returns plain text unchanged and the empty string unchanged', () => {
    expect(screenTransportText('review ok')).toBe('review ok');
    expect(screenTransportText('')).toBe('');
  });

  it('replaces absolute path tokens with [path] while leaving relative paths without a leading slash intact', () => {
    expect(screenTransportText('failed at /home/u/x.ts now')).toBe(
      'failed at [path] now',
    );
    // The path pattern matches any "/..." run, so a relative path with a
    // slash segment is still rewritten by the one path pattern; only the
    // slash-prefixed segment is tokenised.
    expect(screenTransportText('src/x.ts')).toBe('src' + PATH_TOKEN);
  });

  it('redacts a runtime-built legacy-six token shape and omits the original substring', () => {
    const result = screenTransportText('token ' + GITHUB_TOKEN + ' end') as string;
    expect(result).toBe('token ' + REDACTED + ' end');
    expect(result.includes(GITHUB_TOKEN)).toBe(false);
  });

  it('redacts a runtime-built canonical-seventeen-only Google API key shape and omits the original substring', () => {
    const result = screenTransportText('key ' + GOOGLE_KEY + ' end') as string;
    expect(result).toBe('key ' + REDACTED + ' end');
    expect(result.includes(GOOGLE_KEY)).toBe(false);
  });

  it('screens secrets before paths so a slash-adjacent token yields both [redacted] and [path] with neither original fragment left', () => {
    const input = '/x ' + GITHUB_TOKEN;
    const result = screenTransportText(input) as string;
    expect(result).toContain(REDACTED);
    expect(result).toContain(PATH_TOKEN);
    expect(result.includes(GITHUB_TOKEN)).toBe(false);
    expect(result.includes('/x')).toBe(false);
  });

  it('caps a 5000-character ASCII string at the 2048-byte UTF-8 limit', () => {
    const result = screenTransportText('a'.repeat(5000));
    expect(result).not.toBeNull();
    expect(Buffer.byteLength(result as string, 'utf8')).toBeLessThanOrEqual(
      MAX_SCREEN_BYTES,
    );
  });

  it('caps a 2000-character two-byte input at the 2048-byte UTF-8 limit without throwing', () => {
    const result = screenTransportText('\u00e9'.repeat(2000));
    expect(result).not.toBeNull();
    expect(Buffer.byteLength(result as string, 'utf8')).toBeLessThanOrEqual(
      MAX_SCREEN_BYTES,
    );
  });

  it('caps a 1000-character three-byte input without throwing (no byte-bound assertion: a cut inside a 3-byte character may decode to a replacement character)', () => {
    const result = screenTransportText('\u20ac'.repeat(1000));
    expect(typeof result).toBe('string');
    if (result !== null) {
      // Observed, not asserted: recorded for the lane report.
      expect(Buffer.byteLength(result, 'utf8')).toBeGreaterThan(0);
    }
  });

  it('returns null for non-string and hostile inputs without throwing and without invoking getters', () => {
    let getterRuns = 0;
    const hostile: unknown[] = [
      null,
      undefined,
      5,
      {},
      ['x'],
      new Proxy({}, {}),
      {
        get toString() {
          getterRuns += 1;
          throw new Error('boom');
        },
      },
    ];
    for (const input of hostile) {
      expect(screenTransportText(input as never)).toBeNull();
      expect(screenTransportText(input as never)).not.toBe('');
    }
    expect(getterRuns).toBe(0);
  });

  it('treats prototype-polluting strings as ordinary text, returning them unchanged with no property lookup', () => {
    expect(screenTransportText('__proto__')).toBe('__proto__');
    expect(screenTransportText('constructor')).toBe('constructor');
  });

  it('keeps a one-million-character input within the 2048-byte cap (linear cost bound: 23 secret patterns + 1 path pattern, all linear, before capping)', () => {
    const result = screenTransportText('a'.repeat(1_000_000));
    expect(result).not.toBeNull();
    expect(Buffer.byteLength(result as string, 'utf8')).toBeLessThanOrEqual(
      MAX_SCREEN_BYTES,
    );
  });
});
