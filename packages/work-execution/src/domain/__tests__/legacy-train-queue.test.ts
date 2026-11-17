// Lane CO4: pure parser for legacy shell merge-train queue lines.
import { describe, expect, it } from 'vitest';

import { parseLegacyTrainParkedQueue, parseLegacyTrainQueue } from '../legacy-train-queue.js';

/** Secret-shaped fakes are assembled from inert pieces (lane-run.test.ts precedent). */
function fakeSecretShape(): string {
  return `gh${'p_'}${'A'.repeat(30)}`;
}

const FIRST_HEAD = '0123456789abcdef0123456789abcdef01234567';
const SECOND_HEAD = '0123456789abcdef0123456789abcdef01234568';
const MAIN_LINE = `42 ${FIRST_HEAD} main`;
const HEAD_LINE = `7 ${SECOND_HEAD} chain/example-1`;

describe('parseLegacyTrainQueue', () => {
  it('parses three frozen entries from a trailing-newline document', () => {
    const input = [
      MAIN_LINE,
      HEAD_LINE,
      `1 ${'a'.repeat(40)} chain/main`,
      '',
    ].join('\n');

    const result = parseLegacyTrainQueue(input);

    expect(result).toEqual({
      ok: true,
      lines: [
        {
          ok: true,
          entry: { line: 1, pullRequest: 42, headOid: FIRST_HEAD, base: 'main' },
        },
        {
          ok: true,
          entry: { line: 2, pullRequest: 7, headOid: SECOND_HEAD, base: 'chain/example-1' },
        },
        {
          ok: true,
          entry: { line: 3, pullRequest: 1, headOid: 'a'.repeat(40), base: 'chain/main' },
        },
      ],
    });

    if (result.ok) {
      expect(Object.isFrozen(result.lines)).toBe(true);
      for (const line of result.lines) {
        if (line.ok) {
          expect(Object.isFrozen(line.entry)).toBe(true);
        }
      }
    }
  });

  it('parses an empty string to no lines', () => {
    expect(parseLegacyTrainQueue('')).toEqual({ ok: true, lines: [] });
  });

  it('reports a single blank line as unknown', () => {
    expect(parseLegacyTrainQueue('\n')).toEqual({
      ok: true,
      lines: [{ ok: false, line: 1, reason: 'unknown-line' }],
    });
  });

  it('parses the last line without a trailing newline', () => {
    const input = `${MAIN_LINE}\n${HEAD_LINE}`;
    expect(parseLegacyTrainQueue(input)).toEqual({
      ok: true,
      lines: [
        { ok: true, entry: { line: 1, pullRequest: 42, headOid: FIRST_HEAD, base: 'main' } },
        { ok: true, entry: { line: 2, pullRequest: 7, headOid: SECOND_HEAD, base: 'chain/example-1' } },
      ],
    });
  });

  it('keeps unknown lines unknown and never guesses bases', () => {
    const input = [
      MAIN_LINE,
      'NOT-A-QUEUE-LINE',
      '7 0123456789ABCDEF0123456789abcdef01234568 main',
      `42 ${FIRST_HEAD} chain/Bad`,
      `42 ${FIRST_HEAD}`,
      `0 ${FIRST_HEAD} main`,
      `42  ${FIRST_HEAD} main`,
      `42 ${FIRST_HEAD} main extra`,
      `1 ${'a'.repeat(40)} chain/main`,
      MAIN_LINE,
      '',
    ].join('\n');

    const result = parseLegacyTrainQueue(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.stringify(result)).not.toContain('NOT-A-QUEUE-LINE');
      expect(JSON.stringify(result)).not.toContain('chain/Bad');

      const acceptedLines = result.lines.filter(
        (line): line is Extract<typeof line, { ok: true }> => line.ok,
      );
      expect(acceptedLines.map((line) => line.entry.line)).toEqual([1, 9, 10]);

      expect(result.lines[4]).toEqual({ ok: false, line: 5, reason: 'unknown-line' });
    }
  });

  it('treats CRLF endings as part of the line', () => {
    const input = `${MAIN_LINE}\r\n${HEAD_LINE}\n`;
    expect(parseLegacyTrainQueue(input)).toEqual({
      ok: true,
      lines: [
        { ok: false, line: 1, reason: 'unknown-line' },
        { ok: true, entry: { line: 2, pullRequest: 7, headOid: SECOND_HEAD, base: 'chain/example-1' } },
      ],
    });
  });

  it('rejects a pull-request field beyond the safe-integer range', () => {
    const input = `${'9'.repeat(20)} ${FIRST_HEAD} main`;
    expect(parseLegacyTrainQueue(input)).toEqual({
      ok: true,
      lines: [{ ok: false, line: 1, reason: 'unknown-line' }],
    });
  });

  it('refuses secret-shaped documents wholesale', () => {
    const secret = fakeSecretShape();
    const input = `${MAIN_LINE}\n${secret}\n`;
    const result = parseLegacyTrainQueue(input);
    expect(result).toEqual({ ok: false, reason: 'secret-shaped' });
    expect(Object.keys(result)).toEqual(['ok', 'reason']);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('refuses non-string input', () => {
    expect(parseLegacyTrainQueue(null)).toEqual({ ok: false, reason: 'not-text' });
    expect(parseLegacyTrainQueue(1)).toEqual({ ok: false, reason: 'not-text' });
  });

  it('exposes only the documented keys', () => {
    const result = parseLegacyTrainQueue(`${MAIN_LINE}\n`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result)).toEqual(['ok', 'lines']);
      const first = result.lines[0];
      expect(first.ok).toBe(true);
      if (first.ok) {
        expect(Object.keys(first)).toEqual(['ok', 'entry']);
        expect(Object.keys(first.entry)).toEqual(['line', 'pullRequest', 'headOid', 'base']);
      }
    }

    const unknown = parseLegacyTrainQueue('garbage\n');
    expect(unknown.ok).toBe(true);
    if (unknown.ok) {
      expect(Object.keys(unknown.lines[0])).toEqual(['ok', 'line', 'reason']);
    }
  });
});

const PARKED_HEAD = FIRST_HEAD;
const PARKED_BASE = 'main';

function parkedLine(overrides: Partial<Record<'pr' | 'head' | 'base', string>> = {}): string {
  const fields = {
    pr: '7',
    head: PARKED_HEAD,
    base: PARKED_BASE,
    ...overrides,
  };
  return [fields.pr, fields.head, fields.base].join(' ');
}

function unknownParkedLine(line: number): { ok: false; line: number; reason: 'unknown-line' } {
  return { ok: false, line, reason: 'unknown-line' };
}

function parkedEntry(line: number, base: string): {
  ok: true;
  entry: { line: number; pullRequest: number; headOid: string; base: string };
} {
  return { ok: true, entry: { line, pullRequest: 7, headOid: PARKED_HEAD, base } };
}

describe('parseLegacyTrainParkedQueue', () => {
  it('parses a well-formed three-field parked line into its validated fields', () => {
    const result = parseLegacyTrainParkedQueue(`${parkedLine()}\n`);
    expect(result).toEqual({ ok: true, lines: [parkedEntry(1, 'main')] });
    if (result.ok) {
      expect(Object.isFrozen(result.lines)).toBe(true);
      const first = result.lines[0];
      if (first.ok) {
        expect(Object.isFrozen(first.entry)).toBe(true);
      }
    }
  });

  it('reports a bad pull-request field as an unknown line', () => {
    const result = parseLegacyTrainParkedQueue(parkedLine({ pr: '0x2a' }));
    expect(result).toEqual({ ok: true, lines: [unknownParkedLine(1)] });
  });

  it('reports a bad head oid as an unknown line', () => {
    const result = parseLegacyTrainParkedQueue(parkedLine({ head: '0123456789ABCDEF0123456789abcdef01234567' }));
    expect(result).toEqual({ ok: true, lines: [unknownParkedLine(1)] });
  });

  it('reports a bad base as an unknown line', () => {
    const result = parseLegacyTrainParkedQueue(parkedLine({ base: 'chain/Bad' }));
    expect(result).toEqual({ ok: true, lines: [unknownParkedLine(1)] });
  });

  it('reports a six-field parked line as unknown', () => {
    const result = parseLegacyTrainParkedQueue(`${parkedLine()} reason 2 1735689600\n`);
    expect(result).toEqual({ ok: true, lines: [unknownParkedLine(1)] });
  });

  it('reports a two-field parked line as unknown', () => {
    const result = parseLegacyTrainParkedQueue(`7 ${PARKED_HEAD}\n`);
    expect(result).toEqual({ ok: true, lines: [unknownParkedLine(1)] });
  });

  it('refuses a document with a secret-shaped line wholesale without echoing it', () => {
    const secret = fakeSecretShape();
    const result = parseLegacyTrainParkedQueue(parkedLine({ head: secret }));
    expect(result).toEqual({ ok: false, reason: 'secret-shaped' });
    expect(Object.keys(result)).toEqual(['ok', 'reason']);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('refuses a mixed document containing a secret-shaped neighbour instead of returning parsed entries', () => {
    const secret = fakeSecretShape();
    const result = parseLegacyTrainParkedQueue([parkedLine(), `8 ${secret} main`].join('\n'));
    expect(result).toEqual({ ok: false, reason: 'secret-shaped' });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('refuses null, undefined, a number and an object as not-text', () => {
    expect(parseLegacyTrainParkedQueue(null)).toEqual({ ok: false, reason: 'not-text' });
    expect(parseLegacyTrainParkedQueue(undefined)).toEqual({ ok: false, reason: 'not-text' });
    expect(parseLegacyTrainParkedQueue(42)).toEqual({ ok: false, reason: 'not-text' });
    expect(parseLegacyTrainParkedQueue({ lines: [parkedLine()] })).toEqual({ ok: false, reason: 'not-text' });
  });

  it('refuses a Proxy over a boxed string without running any get trap', () => {
    let getTraps = 0;
    const proxy = new Proxy(
      Object(parkedLine()),
      { get: (target, key) => { getTraps += 1; return Reflect.get(target, key); } },
    );
    expect(parseLegacyTrainParkedQueue(proxy)).toEqual({ ok: false, reason: 'not-text' });
    expect(getTraps).toBe(0);
  });

  it('distinguishes different documents and never echoes the raw input', () => {
    const result = parseLegacyTrainParkedQueue(parkedLine());
    expect(result).not.toEqual(parkedLine());
    const other = parseLegacyTrainParkedQueue(parkedLine({ base: 'chain/example-1' }));
    expect(other).not.toEqual(result);
    if (result.ok && result.lines[0].ok) {
      expect(result.lines[0].entry.base).toBe('main');
    }
  });

  it('refuses a document beyond the parked document cap', () => {
    const oversized = `${'a'.repeat(1024)}\n`.repeat(1025);
    expect(oversized.length).toBeGreaterThan(1_048_576);
    const result = parseLegacyTrainParkedQueue(oversized);
    expect(result).toEqual({ ok: false, reason: 'too-large' });
    expect(Object.keys(result)).toEqual(['ok', 'reason']);
  });

  it('reports every malformed line unknown while keeping good neighbours', () => {
    const input = [
      parkedLine(),
      parkedLine({ pr: '007' }),
      'garbage',
      parkedLine({ base: 'chain/example-1' }),
      '',
    ].join('\n');
    const result = parseLegacyTrainParkedQueue(input);
    expect(result).toEqual({
      ok: true,
      lines: [
        parkedEntry(1, 'main'),
        unknownParkedLine(2),
        unknownParkedLine(3),
        parkedEntry(4, 'chain/example-1'),
      ],
    });
  });
});
