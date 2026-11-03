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
    expect(view[0]!.summary).toBe('first line Resume the run -stop  reverse    end');
  });

  it('never surfaces bidi, format or zero-width controls in the summary', () => {
    const hostile = 'a\u200Bb\u200Cc\u200Dd\u2060e\uFEFFf\u00ADg\uFFF9h\u2066i\u2069j\u180Ek';
    const view = boundedFindingsView([finding({ summary: hostile, filePath: null, line: null })]);
    expect(view[0]!.summary).toBe('a b c d e f g h i j k');
    // The control characters are exactly what must never survive sanitization.
    // eslint-disable-next-line no-control-regex
    expect(view[0]!.summary).not.toMatch(/[\u0000-\u001F\u007F-\u009F\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]/);
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

  it('accepts the explicit empty snapshot', () => {
    expect(parkFindingsSnapshotOf([])).toEqual([]);
  });
});
