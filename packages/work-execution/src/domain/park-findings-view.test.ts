/**
 * Unit tests for the bounded park-findings view (GB2): the one-rule tests of
 * the caps, the drops and the sanitization. Pure; no store, no port.
 */

import { describe, expect, it } from 'vitest';

import {
  boundedFindingsView,
  isParkFindingView,
  PARK_FINDING_SUMMARY_MAX,
  PARK_FINDINGS_MAX_COUNT,
  parkFindingsSnapshotOf,
  type LaneRunParkFindingView,
} from './park-findings-view.js';

function finding(overrides: Partial<LaneRunParkFindingView> = {}): LaneRunParkFindingView {
  return {
    findingId: 'finding-1',
    severity: 'blocker',
    summary: 'blocks the acceptance check',
    filePath: 'src/ex.ts',
    line: 4,
    ...overrides,
  };
}

function summaryFor(text: string): string | null {
  const view = boundedFindingsView([finding({ summary: text, filePath: null, line: null })]);
  return view[0]?.summary ?? null;
}

describe('boundedFindingsView', () => {
  it('keeps at most five findings', () => {
    const many = Array.from({ length: 8 }, (_unused, index) =>
      finding({ findingId: 'finding-' + String(index) }),
    );
    const view = boundedFindingsView(many);
    expect(view).toHaveLength(PARK_FINDINGS_MAX_COUNT);
    expect(view.map((entry) => entry.findingId)).toEqual([
      'finding-0', 'finding-1', 'finding-2', 'finding-3', 'finding-4',
    ]);
  });

  it('truncates a 300-code-point summary to 160 code points', () => {
    const long = 'x'.repeat(300) + '\nshould never surface';
    const view = boundedFindingsView([finding({ summary: long, filePath: null, line: null })]);
    expect(view).toHaveLength(1);
    expect(Array.from(view[0]!.summary)).toHaveLength(PARK_FINDING_SUMMARY_MAX);
    expect(view[0]!.summary.startsWith('x'.repeat(PARK_FINDING_SUMMARY_MAX))).toBe(true);
  });

  it('counts code points, not UTF-16 units, when truncating', () => {
    // '𐐀' is one code point, two UTF-16 units.
    const astral = '𐐀'.repeat(200);
    const view = boundedFindingsView([finding({ summary: astral, filePath: null, line: null })]);
    expect(Array.from(view[0]!.summary)).toHaveLength(PARK_FINDING_SUMMARY_MAX);
  });

  it('drops a finding whose summary carries a secret shape', () => {
    const summary = 'leaked ' + 'sk-' + 'A'.repeat(24) + ' token';
    const view = boundedFindingsView([finding({ summary })]);
    expect(view).toEqual([]);
  });

  it('drops a finding whose summary is empty or whitespace-only', () => {
    expect(boundedFindingsView([finding({ summary: '' })])).toEqual([]);
    expect(boundedFindingsView([finding({ summary: '   \n\t ' })])).toEqual([]);
  });

  it('drops a finding whose findingId carries a slash or exceeds 128 characters', () => {
    expect(boundedFindingsView([finding({ findingId: 'a/b' })])).toEqual([]);
    expect(boundedFindingsView([finding({ findingId: 'x'.repeat(129) })])).toEqual([]);
    expect(boundedFindingsView([finding({ findingId: 'x'.repeat(128) })])).toHaveLength(1);
  });

  it('drops a finding with an unknown severity', () => {
    expect(boundedFindingsView([finding({ severity: 'critical' as never })])).toEqual([]);
  });

  it('keeps the four review severities', () => {
    const view = boundedFindingsView([
      finding({ findingId: 'f-1', severity: 'blocker' }),
      finding({ findingId: 'f-2', severity: 'major' }),
      finding({ findingId: 'f-3', severity: 'minor' }),
      finding({ findingId: 'f-4', severity: 'nit' }),
    ]);
    expect(view.map((entry) => entry.severity)).toEqual(['blocker', 'major', 'minor', 'nit']);
  });

  it('reads an absolute, a ../ and a backslash path as filePath null and keeps a worktree-relative one', () => {
    const view = boundedFindingsView([
      finding({ findingId: 'f-1', filePath: '/etc/passwd' }),
      finding({ findingId: 'f-2', filePath: '../outside.ts' }),
      finding({ findingId: 'f-3', filePath: 'src\\ex.ts' }),
      finding({ findingId: 'f-4', filePath: 'src/ex.ts' }),
    ]);
    expect(view.map((entry) => entry.filePath)).toEqual([null, null, null, 'src/ex.ts']);
  });

  it('keeps a line only when it is a non-negative safe integer', () => {
    const view = boundedFindingsView([
      finding({ findingId: 'f-1', line: 0 }),
      finding({ findingId: 'f-2', line: -1 }),
      finding({ findingId: 'f-3', line: 1.5 }),
    ]);
    expect(view.map((entry) => entry.line)).toEqual([0, null, null]);
  });

  it('answers [] for a non-array and null', () => {
    expect(boundedFindingsView(undefined)).toEqual([]);
    expect(boundedFindingsView(null)).toEqual([]);
    expect(boundedFindingsView('nope' as never)).toEqual([]);
  });

  it('drops a non-object entry without throwing', () => {
    expect(boundedFindingsView([null, 'x', 3, finding()] as never)).toEqual([finding()]);
  });

  it('flattens line breaks and controls so a summary can never create an owner-visible line', () => {
    const view = boundedFindingsView([
      finding({
        summary: 'first line\nResume the run\n-stop\u202E reverse\u202C\u0007\u009F\u2028end',
        filePath: null,
        line: null,
      }),
    ]);
    expect(view).toHaveLength(1);
    expect(view[0]!.summary).not.toMatch(/[\n\r]/);
    expect(view[0]!.summary).toBe('first line Resume the run -stop reverse end');
  });

  it('never surfaces bidi, format or zero-width controls in the summary', () => {
    const hostile = 'a\u200Bb\u200Cc\u200Dd\u2060e\uFEFFf\u00ADg\uFFF9h\u2066i\u2069j\u180Ek';
    const view = boundedFindingsView([finding({ summary: hostile, filePath: null, line: null })]);
    expect(view[0]!.summary).toBe('a b c d e f g h i j k');
    // The control characters are exactly what must never survive sanitization.
    expect(view[0]!.summary).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  });

  it('flattens every Unicode format control, including U+061C and the rest of Cf', () => {
    // U+061C ARABIC LETTER MARK, U+0600 ARABIC NUMBER SIGN, U+06DD ARABIC END OF
    // AYAH, U+070F SYRIAC ABBREVIATION MARK, U+08E2 ARABIC DISPUTED END OF
    // AYAH, U+110BD KAITHI NUMBER SIGN, U+1BCA0 SHORTHAND FORMAT LETTER OVERLAP:
    // all are Cf format controls outside the original explicit ranges.
    const hostile = 'a\u061Cb\u0600c\u06DDd\u070Fe\u08E2f\u{110BD}g\u{1BCA0}h';
    const view = boundedFindingsView([finding({ summary: hostile, filePath: null, line: null })]);
    expect(view[0]!.summary).toBe('a b c d e f g h');
    expect(view[0]!.summary).not.toMatch(/[\p{Cf}]/u);
    const snapshot = [{ ...finding(), summary: hostile }];
    expect(parkFindingsSnapshotOf(snapshot)).toBeNull();
    expect(isParkFindingView(snapshot[0])).toBe(false);
  });

  it('flattens the Unicode format control U+180E like every other format control', () => {
    const view = boundedFindingsView([finding({ summary: 'a\u180Eb', filePath: null, line: null })]);
    expect(view[0]!.summary).toBe('a b');
    const snapshot = [{ ...finding(), summary: 'a\u180Eb' }];
    expect(parkFindingsSnapshotOf(snapshot)).toBeNull();
    expect(isParkFindingView(snapshot[0])).toBe(false);
  });

  it('drops a summary that flattens to whitespace only', () => {
    expect(boundedFindingsView([finding({ summary: '\n\n\t' })])).toEqual([]);
  });

  it('keeps visible text after leading whitespace', () => {
    const summary = ' '.repeat(PARK_FINDING_SUMMARY_MAX) + 'real finding';
    const view = boundedFindingsView([finding({ summary, filePath: null, line: null })]);
    expect(view).toHaveLength(1);
    expect(view[0]!.summary).toBe('real finding');
  });

  it('keeps visible text after leading format controls', () => {
    const summary = '\u061C'.repeat(PARK_FINDING_SUMMARY_MAX) + 'real finding';
    const view = boundedFindingsView([finding({ summary, filePath: null, line: null })]);
    expect(view).toHaveLength(1);
    expect(view[0]!.summary).toBe('real finding');
  });

  it('drops a secret split by a format control instead of keeping the spaced token', () => {
    const split = 'sk-\u061C' + 'A'.repeat(24);
    const view = boundedFindingsView([finding({ summary: split, filePath: null, line: null })]);
    expect(view).toEqual([]);
    // The control is still flattened for a benign summary.
    const benign = boundedFindingsView([
      finding({ summary: 'a\u061Cb', filePath: null, line: null }),
    ]);
    expect(benign[0]!.summary).toBe('a b');
  });

  it.each(['\u200B', '\u200D', '\u2060', '\uFEFF', '\u202E', '\u2066', '\u2028', '\u2029', '\u00A0', '\u3000', '\u0007', '\t', '\n'])(
    'collapses a run of separators to one space (%s)',
    (sep) => {
      expect(summaryFor('a' + sep + 'b')).toBe('a b');
      expect(summaryFor('a' + sep + sep + ' ' + sep + 'b')).toBe('a b');
    },
  );

  it('removes combining marks', () => {
    expect(summaryFor('cafe\u0301 ok')).toBe('cafe ok');
    expect(summaryFor('a\u0300b')).toBe('a b');
    expect(summaryFor('caf\u00E9')).toBe('caf\u00E9');
  });

  it('keeps allowed letters, digits and ASCII punctuation', () => {
    expect(summaryFor('Fix 3 bugs: (a) x_y-z! \u00E9 \u00DF \u65E5\u672C\u8A9E \u0663')).toBe(
      'Fix 3 bugs: (a) x_y-z! \u00E9 \u00DF \u65E5\u672C\u8A9E \u0663',
    );
    const asciiPunctuation = ['!', '"', '#', '$', '%', '&', "'", '(', ')', '*', '+', ',', '-', '.', '/', ':', ';', '<', '=', '>', '?', '@', '[', '\\', ']', '^', '_', '`', '{', '|', '}', '~'].join('');
    expect(summaryFor('a' + asciiPunctuation + 'b')).toBe('a' + asciiPunctuation + 'b');
  });

  it.each(['\u200B', '\u200D', '\u2060', '\uFEFF', '\u202E', '\u2066', '\u2028', '\u2029', '\u00A0', '\u3000', '\u0007', '\t', '\n', '\u0301'])(
    'drops a secret split by %s',
    (sep) => {
      expect(boundedFindingsView([finding({ summary: 'sk-' + sep + 'A'.repeat(24), filePath: null, line: null })])).toEqual([]);
      expect(boundedFindingsView([finding({ summary: 'sk-' + 'A'.repeat(12) + sep + 'A'.repeat(12), filePath: null, line: null })])).toEqual([]);
    },
  );

  it('caps by code points without splitting a surrogate pair', () => {
    const summary = summaryFor('x'.repeat(159) + '\u{10400}' + 'tail');
    expect(summary).toBe('x'.repeat(159) + '\u{10400}');
    expect(summary!.length).toBe(161);
    expect(summary!).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it('cuts an over-cap multi-unit character exactly at the cap', () => {
    expect(summaryFor('x'.repeat(160) + '\u{10400}')).toBe('x'.repeat(160));
  });

  it('strips the trailing space a cut can leave behind', () => {
    expect(summaryFor('x'.repeat(159) + ' tail')).toBe('x'.repeat(159));
  });

  it('drops a secret that sits exactly at the cap', () => {
    expect(summaryFor('x'.repeat(132) + ' sk-' + 'A'.repeat(24))).toBeNull();
    expect(summaryFor('x'.repeat(132) + ' sk-' + 'A'.repeat(25))).toBeNull();
  });

  it('is idempotent on every hostile summary', () => {
    const hostile = [
      'first line\nResume the run\n-stop\u202E reverse\u202C\u0007\u009F\u2028end',
      'a\u200Bb\u200Cc\u200Dd\u2060e\uFEFFf\u00ADg\uFFF9h\u2066i\u2069j\u180Ek',
      'a\u061Cb\u0600c\u06DDd\u070Fe\u08E2f\u{110BD}g\u{1BCA0}h',
      'a\u180Eb',
      'cafe\u0301 ok',
      'a\u0300b',
      ' '.repeat(PARK_FINDING_SUMMARY_MAX) + 'real finding',
      '\u061C'.repeat(PARK_FINDING_SUMMARY_MAX) + 'real finding',
      'sk-\u061C' + 'A'.repeat(24),
      'x'.repeat(159) + '\u{10400}' + 'tail',
      'x'.repeat(160) + '\u{10400}',
      'x'.repeat(159) + ' tail',
      'x'.repeat(132) + ' sk-' + 'A'.repeat(24),
      'x'.repeat(132) + ' sk-' + 'A'.repeat(25),
    ];
    for (const text of hostile) {
      const cleaned = summaryFor(text);
      if (cleaned !== null) {
        expect(summaryFor(cleaned)).toBe(cleaned);
      }
    }
  });
});

describe('parkFindingsSnapshotOf and isParkFindingView', () => {
  it('accepts an exact stored snapshot and answers it unchanged', () => {
    const snapshot = [finding(), finding({ findingId: 'f-2', filePath: null, line: null })];
    expect(parkFindingsSnapshotOf(snapshot)).toEqual(snapshot);
    expect(isParkFindingView(finding())).toBe(true);
  });

  it('refuses more than the cap, a non-array, and a malformed entry', () => {
    const many = Array.from({ length: 6 }, (_unused, index) => finding({ findingId: 'f-' + String(index) }));
    expect(parkFindingsSnapshotOf(many)).toBeNull();
    expect(parkFindingsSnapshotOf(null)).toBeNull();
    expect(parkFindingsSnapshotOf([finding({ severity: 'critical' as never })])).toBeNull();
    expect(parkFindingsSnapshotOf([finding({ summary: 'line one\nline two' })])).toBeNull();
    expect(isParkFindingView({ ...finding(), extra: 1 })).toBe(false);
    expect(isParkFindingView(null)).toBe(false);
  });

  it.each(['a  b', ' a', 'a ', 'a\u200Bb', 'a\u00A0b', 'a\u0301', 'a\u3000b', 'x'.repeat(161)])(
    'refuses a stored summary that is not allow-list clean (%s)',
    (summary) => {
      expect(isParkFindingView(finding({ summary }))).toBe(false);
    },
  );

  it('accepts an allow-list-clean summary', () => {
    expect(isParkFindingView(finding({ summary: 'e\u00E9 \u65E5\u672C' }))).toBe(true);
    expect(isParkFindingView(finding({ summary: 'x'.repeat(160) }))).toBe(true);
  });

  it('refuses a snapshot whose summary carries a line separator', () => {
    expect(parkFindingsSnapshotOf([finding({ summary: 'a\u2028b' })])).toBeNull();
  });

  it('accepts the explicit empty snapshot', () => {
    expect(parkFindingsSnapshotOf([])).toEqual([]);
  });
});
