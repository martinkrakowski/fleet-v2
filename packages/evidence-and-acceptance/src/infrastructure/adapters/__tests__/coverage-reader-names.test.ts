import { describe, expect, it, vi } from 'vitest';

import { COVERAGE_READER_NAMES, isCoverageReaderName, stripAnsi } from '../coverage-readers.js';

const ESC = String.fromCodePoint(0x1b);

describe('isCoverageReaderName accepted values (cost bound: O(1) over a 3-element array)', () => {
  it('returns true for every one of the three declared reader names', () => {
    expect(COVERAGE_READER_NAMES).toHaveLength(3);
    expect(COVERAGE_READER_NAMES).toEqual(['vitest-summary', 'hexagen-lint-json', 'eslint-json']);
    for (const name of COVERAGE_READER_NAMES) {
      expect(isCoverageReaderName(name)).toBe(true);
    }
    expect(isCoverageReaderName('vitest-summary')).toBe(true);
    expect(isCoverageReaderName('hexagen-lint-json')).toBe(true);
    expect(isCoverageReaderName('eslint-json')).toBe(true);
  });
});

describe('isCoverageReaderName refused strings (cost bound: O(1))', () => {
  it('refuses non-matching strings and Object.prototype keys', () => {
    expect(isCoverageReaderName('Vitest-Summary')).toBe(false);
    expect(isCoverageReaderName('vitest-summary ')).toBe(false);
    expect(isCoverageReaderName('')).toBe(false);
    // Prototype-polluting / Object.prototype keys are plain strings here and
    // must not be accepted just because they exist on Object.prototype.
    expect(isCoverageReaderName('toString')).toBe(false);
    expect(isCoverageReaderName('constructor')).toBe(false);
    expect(isCoverageReaderName('__proto__')).toBe(false);
  });
});

describe('isCoverageReaderName refused non-strings (cost bound: O(1))', () => {
  it('refuses null, undefined, non-strings, and boxed String without coercing', () => {
    expect(isCoverageReaderName(null)).toBe(false);
    expect(isCoverageReaderName(undefined)).toBe(false);
    expect(isCoverageReaderName(1)).toBe(false);
    expect(isCoverageReaderName(['eslint-json'])).toBe(false);
    expect(isCoverageReaderName({})).toBe(false);
    expect(isCoverageReaderName(new String('eslint-json'))).toBe(false);
  });
});

describe('isCoverageReaderName coercion traps (cost bound: O(1))', () => {
  it('refuses an object with toString and valueOf spies without calling them', () => {
    const toString = vi.fn(() => 'eslint-json');
    const valueOf = vi.fn(() => 'eslint-json');
    const value = { toString, valueOf };
    expect(isCoverageReaderName(value)).toBe(false);
    expect(toString).not.toHaveBeenCalled();
    expect(valueOf).not.toHaveBeenCalled();
  });
});

describe('stripAnsi SGR removal and passthrough (cost bound: linear in input length)', () => {
  it('removes SGR colour sequences around plain text', () => {
    expect(stripAnsi(ESC + '[31mred ' + ESC + '[0m')).toBe('red ');
  });

  it('removes a multi-parameter SGR and an empty-parameter SGR', () => {
    expect(stripAnsi(ESC + '[1;32mok ' + ESC + '[m')).toBe('ok ');
  });

  it('returns a plain string without escapes unchanged', () => {
    expect(stripAnsi('plain output')).toBe('plain output');
  });

  it('returns the empty string for the empty string', () => {
    expect(stripAnsi('')).toBe('');
  });
});

describe('stripAnsi non-SGR and malformed sequence preservation (cost bound: linear in input length)', () => {
  it('leaves non-m CSI sequences, trailing bare ESC, and non-numeric parameters unchanged', () => {
    // Pinned behaviour as written today: only `m`-terminated SGR sequences are
    // removed; other CSI sequences and malformed input are preserved verbatim.
    expect(stripAnsi(ESC + '[2K')).toBe(ESC + '[2K');
    expect(stripAnsi(ESC + '[1A')).toBe(ESC + '[1A');
    expect(stripAnsi('text' + ESC)).toBe('text' + ESC);
    expect(stripAnsi(ESC + '[x1m')).toBe(ESC + '[x1m');
  });
});

describe('stripAnsi global matching and statelessness (cost bound: linear in input length)', () => {
  it('removes every SGR sequence in one string, not only the first', () => {
    // Fails against a non-global pattern, which would leave the 2nd and 3rd.
    expect(
      stripAnsi(ESC + '[1mA' + ESC + '[mB' + ESC + '[31mC' + ESC + '[0m'),
    ).toBe('ABC');
  });

  it('returns the same result when called twice in a row on the same input', () => {
    // Fails if the regex kept stateful lastIndex between calls.
    const input = ESC + '[31mred ' + ESC + '[0m' + ESC + '[1;32mok ' + ESC + '[m';
    expect(stripAnsi(input)).toBe('red ok ');
    expect(stripAnsi(input)).toBe('red ok ');
  });
});

describe('stripAnsi cost-bound guards (cost bound: linear, well under 1s)', () => {
  it('reduces 50000 SGR sequences to a string of length 0 with no ESC left', () => {
    const input = (ESC + '[1m').repeat(50000);
    const result = stripAnsi(input);
    expect(result.length).toBe(0);
    expect(result.includes(ESC)).toBe(false);
  });

  it('returns 100000 unterminated ESC[ prefixes unchanged', () => {
    // No catastrophic backtracking: every ESC[ without a final `m` must stay.
    const input = (ESC + '[').repeat(100000);
    expect(stripAnsi(input)).toBe(input);
  });
});
