import { describe, expect, it } from 'vitest';

import { AUTO_MERGE_DECISION_MACHINERY_PATHS, isAutoMergeDoorPath } from '../auto-merge.js';
import { isFixedProtectedPath } from '../lane-diff-check.js';

describe('AUTO_MERGE_DECISION_MACHINERY_PATHS table', () => {
  it('is a non-empty frozen list', () => {
    expect(AUTO_MERGE_DECISION_MACHINERY_PATHS.length).toBeGreaterThan(0);
    expect(Object.isFrozen(AUTO_MERGE_DECISION_MACHINERY_PATHS)).toBe(true);
  });

  it('every entry and its ASCII-uppercased form is an auto-merge door path', () => {
    for (const p of AUTO_MERGE_DECISION_MACHINERY_PATHS) {
      // The table is declared all-lowercase; matching must fold ASCII A-Z,
      // so the uppercased form must hit the same door.
      expect(isAutoMergeDoorPath(p), p).toBe(true);
      expect(isAutoMergeDoorPath(p.toUpperCase()), p.toUpperCase()).toBe(true);
    }
  });
});

describe('isAutoMergeDoorPath lane-run domain stem', () => {
  it('any file under the domain named lane-run-* is a door, uppercased too', () => {
    const p = 'packages/work-execution/src/domain/lane-run-anything.ts';
    expect(isAutoMergeDoorPath(p)).toBe(true);
    expect(isAutoMergeDoorPath(p.toUpperCase())).toBe(true);
  });

  it('lane-runner.ts is not a door: the stem includes the trailing dash', () => {
    expect(isAutoMergeDoorPath('packages/work-execution/src/domain/lane-runner.ts')).toBe(false);
  });
});

describe('isAutoMergeDoorPath advance-lane-run directories', () => {
  it('the use-case directory, the directory itself, and the sibling application directory are doors', () => {
    expect(isAutoMergeDoorPath('packages/work-execution/src/application/use-cases/advance-lane-run/x.ts')).toBe(true);
    expect(isAutoMergeDoorPath('packages/work-execution/src/application/use-cases/advance-lane-run')).toBe(true);
    expect(isAutoMergeDoorPath('packages/work-execution/src/application/advance-lane-run/y.ts')).toBe(true);
  });

  it('advance-lane-runner siblings are not doors: pathUnderPrefix enforces the segment boundary', () => {
    expect(isAutoMergeDoorPath('packages/work-execution/src/application/use-cases/advance-lane-runner/x.ts')).toBe(false);
    expect(isAutoMergeDoorPath('packages/work-execution/src/application/advance-lane-runner/y.ts')).toBe(false);
  });
});

describe('isAutoMergeDoorPath near misses', () => {
  it('suffix games, the empty string, and unrelated domain paths return false', () => {
    expect(isAutoMergeDoorPath('packages/work-execution/src/domain/auto-merge.ts.bak')).toBe(false);
    expect(isAutoMergeDoorPath('packages/work-execution/src/domain/auto-merge.tsx')).toBe(false);
    expect(isAutoMergeDoorPath('')).toBe(false);
    expect(isAutoMergeDoorPath('packages/work-execution/src/domain/other.ts')).toBe(false);
  });

  it('prototype-polluting keys and near misses return false', () => {
    // These keys are plain string arguments here; as object keys they could
    // pollute prototype state, and as paths they must never open the door.
    expect(isAutoMergeDoorPath('__proto__')).toBe(false);
    expect(isAutoMergeDoorPath('constructor')).toBe(false);
    expect(isAutoMergeDoorPath('toString')).toBe(false);
    expect(isAutoMergeDoorPath('valueOf')).toBe(false);
  });
});

describe('isAutoMergeDoorPath agrees with the fixed protected set', () => {
  it('every protected row is a door, the ordinary row is neither, and no row drifts', () => {
    // Three rows drawn from PROTECTED_PATH_RULES in lane-diff-check.ts, plus
    // one ordinary source path. The parity assertion fails if either gate
    // ever answers differently about the same path.
    const rows: readonly string[] = [
      '.github/workflows/ci.yml',
      'yarn.lock',
      'AGENTS.md',
      'packages/work-execution/src/domain/other.ts',
    ];
    expect(isFixedProtectedPath('.github/workflows/ci.yml')).toBe(true);
    expect(isAutoMergeDoorPath('.github/workflows/ci.yml')).toBe(true);
    expect(isFixedProtectedPath('yarn.lock')).toBe(true);
    expect(isAutoMergeDoorPath('yarn.lock')).toBe(true);
    expect(isFixedProtectedPath('AGENTS.md')).toBe(true);
    expect(isAutoMergeDoorPath('AGENTS.md')).toBe(true);
    expect(isFixedProtectedPath('packages/work-execution/src/domain/other.ts')).toBe(false);
    expect(isAutoMergeDoorPath('packages/work-execution/src/domain/other.ts')).toBe(false);
    for (const p of rows) {
      expect(isAutoMergeDoorPath(p), p).toBe(isFixedProtectedPath(p));
    }
  });
});

describe('isAutoMergeDoorPath cost bound', () => {
  // Cost bound: one call runs isFixedProtectedPath (a fixed table of
  // PROTECTED_PATH_RULES regexes over asciiLower(path)), one asciiLower pass,
  // a 9-element AUTO_MERGE_DECISION_MACHINERY_PATHS includes check, and two
  // ADVANCE_LANE_RUN_DIR_PREFIXES prefix checks — linear O(n) in path length
  // n, with constant memory. No timeout or budget is needed because the work
  // is bounded by the input length and the rule table is fixed.
  it('1,000,000-character non-matching path returns false in O(n)', () => {
    const huge = 'x'.repeat(1_000_000);
    expect(isAutoMergeDoorPath(huge)).toBe(false);
    expect(isAutoMergeDoorPath('a/'.repeat(500_000) + 'other.ts')).toBe(false);
  });
});
