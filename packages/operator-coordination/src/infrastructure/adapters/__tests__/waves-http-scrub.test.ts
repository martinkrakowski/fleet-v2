import { describe, expect, it } from 'vitest';
import {
  scrubToken,
  truncatePreservingRedacted,
  scrubAndTruncate,
} from '../WavesHttpClient.adapter.js';

const TOKEN = 'waves-test-token_xyz-9876';
const MARKER = '[REDACTED]';

describe('scrubToken', () => {
  it('replaces every occurrence of the token with [REDACTED] (3 occurrences become 3 markers)', () => {
    const text = `pre ${TOKEN} mid ${TOKEN} tail ${TOKEN} end`;
    const result = scrubToken(text, TOKEN);
    expect(result).toBe(`pre ${MARKER} mid ${MARKER} tail ${MARKER} end`);
    expect(result.split(MARKER).length - 1).toBe(3);
    expect(result).not.toContain(TOKEN);
  });

  it('returns text unchanged when token is undefined or empty', () => {
    const text = `secret ${TOKEN} secret`;
    expect(scrubToken(text, undefined)).toBe(text);
    expect(scrubToken(text, '')).toBe(text);
  });

  it('returns text unchanged when the token is absent from the text', () => {
    const text = 'nothing to redact here';
    expect(scrubToken(text, TOKEN)).toBe(text);
  });

  it('treats regex metacharacters in the token literally, without matching alternatives', () => {
    const metaToken = 'a.b*c';
    const matching = `x a.b*c y`;
    const notMatching = 'x axbyc y';
    expect(scrubToken(matching, metaToken)).toBe(`x ${MARKER} y`);
    expect(scrubToken(notMatching, metaToken)).toBe(notMatching);
  });
});

describe('truncatePreservingRedacted', () => {
  it('returns text unchanged when its length is at or below the limit', () => {
    const text = 'a'.repeat(200);
    expect(truncatePreservingRedacted(text, 200)).toBe(text);
    expect(truncatePreservingRedacted('short text', 200)).toBe('short text');
    expect(truncatePreservingRedacted(text)).toBe(text);
  });

  it('slices to the limit when no marker straddles the limit', () => {
    const text = 'x'.repeat(150) + MARKER + 'y'.repeat(100);
    expect(truncatePreservingRedacted(text, 100)).toBe('x'.repeat(100));
  });

  it('keeps a marker whole when it starts within the last 9 characters before the limit, ending exactly at its closing bracket', () => {
    // marker starts at index 195, limit is 200: the marker straddles the cut
    const text = 'z'.repeat(195) + MARKER + 'tail';
    expect(truncatePreservingRedacted(text, 200)).toBe(
      'z'.repeat(195) + MARKER,
    );
    expect(
      truncatePreservingRedacted(text, 200).endsWith(']'),
    ).toBe(true);
  });

  it('cuts off a marker completely when it starts exactly at the limit', () => {
    const text = 'z'.repeat(200) + MARKER;
    expect(truncatePreservingRedacted(text, 200)).toBe('z'.repeat(200));
  });
});

describe('scrubAndTruncate', () => {
  it('returns an empty string for undefined, empty, and whitespace-only input', () => {
    expect(scrubAndTruncate(undefined, TOKEN)).toBe('');
    expect(scrubAndTruncate('', TOKEN)).toBe('');
    expect(scrubAndTruncate('   \t\n  ', TOKEN)).toBe('');
  });

  it('scrubs the token, trims surrounding whitespace, and truncates to 200 characters', () => {
    const text = `  ${TOKEN} ${'x'.repeat(300)}  `;
    const result = scrubAndTruncate(text, TOKEN);
    expect(result).toBe(`${MARKER} ${'x'.repeat(189)}`);
    expect(result).toHaveLength(200);
  });

  it('never leaks the token or a partial [REDACTED fragment without its closing bracket', () => {
    // Scrubbed length is 206; one marker starts at index 192, straddling
    // the default 200 limit.
    const text =
      `start ${TOKEN} ` +
      'a'.repeat(150) +
      ` ${TOKEN} ` +
      'b'.repeat(12) +
      ` ${TOKEN} end`;
    const result = scrubAndTruncate(text, TOKEN);
    expect(result).not.toContain(TOKEN);
    expect(result).not.toMatch(/REDACTED(?!\])/);
    expect(result).toBe(
      `start ${MARKER} ${'a'.repeat(150)} ${MARKER} ${'b'.repeat(12)} ${MARKER}`,
    );
  });
});

describe('cost bound: linear in text length', () => {
  const big = 'q'.repeat(1024 * 1024);

  it('scrubs a 1 MiB string where the token appears once', () => {
    const input = big + TOKEN + big;
    const result = scrubToken(input, TOKEN);
    expect(result).toBe(big + MARKER + big);
  });

  it('truncates a 1 MiB string with no marker near the limit', () => {
    expect(truncatePreservingRedacted(big, 200)).toBe('q'.repeat(200));
  });

  it('scrubs and truncates a 1 MiB string containing the token', () => {
    const input = TOKEN + big;
    const result = scrubAndTruncate(input, TOKEN);
    expect(result).toBe(MARKER + 'q'.repeat(190));
  });
});
