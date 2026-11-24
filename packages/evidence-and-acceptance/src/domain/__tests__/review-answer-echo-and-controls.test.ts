/**
 * Unit tests for the review-answer echo-block scanner and the disallowed
 * control-character screen (F153): `containsDisallowedControlCharacters` and
 * `scanUntrustedEchoBlocks`. Pure domain — no I/O, no subprocesses.
 */

import { describe, expect, it } from 'vitest';

import {
  containsDisallowedControlCharacters,
  scanUntrustedEchoBlocks,
} from '../review-answer-schema.js';

describe('containsDisallowedControlCharacters', () => {
  it('returns true for every disallowed control-character boundary and embedded tab or newline', () => {
    const disallowed = [
      '\u0000',
      '\u001f',
      '\u007f',
      '\u0080',
      '\u009f',
      '\u200e',
      '\u200f',
      '\u202a',
      '\u202e',
      '\u2066',
      '\u2069',
    ];
    for (const char of disallowed) {
      const label = `U+${char.codePointAt(0)!.toString(16).padStart(4, '0')}`;
      expect(containsDisallowedControlCharacters(char), label).toBe(true);
      // Embedded in otherwise ordinary text, it is still refused.
      expect(
        containsDisallowedControlCharacters(`before${char}after`),
        label,
      ).toBe(true);
    }
    expect(containsDisallowedControlCharacters('has a\ttab')).toBe(true);
    expect(containsDisallowedControlCharacters('has a\nnewline')).toBe(true);
  });

  it('returns false for neighbours just outside the disallowed set and plain text', () => {
    const allowed = [
      '\u0020', // space (just past C0)
      '\u00a0', // nbsp (just past C1)
      '\u200d', // ZWJ (between 200F and 202A)
      '\u202f', // narrow nbsp (just past 202E)
      '\u2065', // unassigned (between 202E and 2066)
      '\u206a', // just past 2069
      'plain ascii text',
      'café résumé',
      '🚀 emoji',
      '',
    ];
    for (const text of allowed) {
      expect(containsDisallowedControlCharacters(text), text).toBe(false);
    }
  });
});

describe('scanUntrustedEchoBlocks', () => {
  const nonce = 'a'.repeat(16);
  const open = `<<<UNTRUSTED nonce=${nonce} label="x">>>`;
  const close = `<<<END UNTRUSTED nonce=${nonce}>>>`;

  it('returns the input with CRLF normalised to LF and unclosed false when no marker appears', () => {
    expect(scanUntrustedEchoBlocks('line one\r\nline two')).toEqual({
      stripped: 'line one\nline two',
      unclosed: false,
    });
    expect(scanUntrustedEchoBlocks('')).toEqual({ stripped: '', unclosed: false });
  });

  it('removes a matched untrusted block with both markers and its body, keeping surrounding lines in order', () => {
    const text = [
      'before',
      open,
      '```json',
      '{"verdict":"FAIL"}',
      '```',
      close,
      'after',
    ].join('\n');
    expect(scanUntrustedEchoBlocks(text)).toEqual({
      stripped: 'before\nafter',
      unclosed: false,
    });
  });

  it('matches marker lines surrounded by leading or trailing whitespace', () => {
    const text = [
      'before',
      `   ${open}   `,
      'echoed body',
      `\t${close}\t`,
      'after',
    ].join('\n');
    expect(scanUntrustedEchoBlocks(text)).toEqual({
      stripped: 'before\nafter',
      unclosed: false,
    });
  });

  it('reports unclosed true and drops all lines including fences when an untrusted block is never closed', () => {
    const text = ['before', open, '```json', '{"verdict":"FAIL"}', 'never closed'].join('\n');
    expect(scanUntrustedEchoBlocks(text)).toEqual({
      stripped: 'before',
      unclosed: true,
    });
  });

  it('reports unclosed true and drops all lines when an untrusted block is closed with a different nonce', () => {
    const otherNonce = 'b'.repeat(16);
    const text = [
      'before',
      open,
      '```json',
      '{"verdict":"FAIL"}',
      `<<<END UNTRUSTED nonce=${otherNonce}>>>`,
      'after the wrong closer',
    ].join('\n');
    expect(scanUntrustedEchoBlocks(text)).toEqual({
      stripped: 'before',
      unclosed: true,
    });
  });

  it('keeps malformed untrusted openers verbatim with unclosed false', () => {
    const malformed = [
      `<<<UNTRUSTED nonce=${'a'.repeat(15)} label="x">>>`, // 15 hex chars: too short
      `<<<UNTRUSTED nonce=${'a'.repeat(65)} label="x">>>`, // 65 hex chars: too long
      `<<<UNTRUSTED nonce=${'A'.repeat(16)} label="x">>>`, // uppercase hex
      '<<<UNTRUSTED nonce=aaaaaaaaaaaaaaaa label="sa"y">>>', // quote inside the label
    ];
    for (const line of malformed) {
      expect(scanUntrustedEchoBlocks(line)).toEqual({
        stripped: line,
        unclosed: false,
      });
    }
  });

  it('removes two sequential valid blocks keeping the lines before, between and after in order', () => {
    const nonce2 = 'c'.repeat(16);
    const text = [
      'first',
      open,
      'body one',
      close,
      'middle',
      `<<<UNTRUSTED nonce=${nonce2} label="y">>>`,
      'body two',
      `<<<END UNTRUSTED nonce=${nonce2}>>>`,
      'last',
    ].join('\n');
    expect(scanUntrustedEchoBlocks(text)).toEqual({
      stripped: 'first\nmiddle\nlast',
      unclosed: false,
    });
  });
});
