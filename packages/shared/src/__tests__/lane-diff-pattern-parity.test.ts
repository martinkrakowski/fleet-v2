// Tests for lane Q7b: the canonical LANE_DIFF_SECRET_PATTERNS registry must
// not drift from the shell twin's pattern table in scripts/lane-diff-check.sh.
// The table lines are read straight from the script; only rule names are ever
// asserted or printed, never a matched value.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANE_DIFF_SECRET_PATTERNS } from '../secret-patterns.js';

/** The repo root, found by walking up from this test file. */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'scripts', 'lane-diff-check.sh'))) {
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error('could not locate scripts/lane-diff-check.sh');
    }
    dir = parent;
  }
  return dir;
}

/** The script's pattern table, as `{ name, ere }` rows in table order. */
function scriptPatternTable(): Array<{ name: string; ere: string }> {
  const script = readFileSync(
    join(repoRoot(), 'scripts', 'lane-diff-check.sh'),
    'utf8',
  );
  const lines = script.split('\n');
  const start = lines.findIndex((line) => line === `cat > "$T/patterns" <<'PAT'`);
  if (start === -1) {
    throw new Error('lane-diff pattern table start marker not found');
  }
  const rows: Array<{ name: string; ere: string }> = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === 'PAT') {
      break;
    }
    const bar = line.indexOf('|');
    if (bar === -1) {
      throw new Error(`malformed lane-diff pattern table row at line ${index + 1}`);
    }
    rows.push({ name: line.slice(0, bar), ere: line.slice(bar + 1) });
  }
  return rows;
}

/**
 * POSIX space-class forms in the shell EREs, translated to the JS RegExp
 * source text (which keeps escape sequences as literal backslash-plus-letter,
 * so the `\t\v\f\r` forms below are written with escaped backslashes).
 */
const SPACE_CLASS_REWRITES: readonly (readonly [string, string])[] = [
  ['[^[:space:]]', '[^ \\t\\v\\f\\r]'],
  ['[^/:@[:space:]]', '[^/:@ \\t\\v\\f\\r]'],
  ['[^/@[:space:]]', '[^/@ \\t\\v\\f\\r]'],
  ['[[:space:]]', '[ \\t\\v\\f\\r]'],
];

/** Normalize a shell ERE to the JS RegExp source form. */
function normalizeEre(ere: string): string {
  let out = ere;
  for (const [from, to] of SPACE_CLASS_REWRITES) {
    out = out.split(from).join(to);
  }
  return out.split('\\/').join('/');
}

/** Normalize a JS RegExp source for comparison with a shell ERE. */
function normalizeSource(source: string): string {
  return source.split('\\/').join('/');
}

describe('LANE_DIFF_SECRET_PATTERNS (script-table parity)', () => {
  it('carries exactly the script table\'s 17 names, in the same order', () => {
    const table = scriptPatternTable();
    expect(table).toHaveLength(17);
    expect(LANE_DIFF_SECRET_PATTERNS).toHaveLength(17);
    expect(LANE_DIFF_SECRET_PATTERNS.map((entry) => entry.name)).toEqual(
      table.map((row) => row.name),
    );
  });

  it('every rule\'s regex text matches the script table\'s ERE after normalization', () => {
    const table = scriptPatternTable();
    expect(table).toHaveLength(17);
    const registry = LANE_DIFF_SECRET_PATTERNS;
    expect(registry).toHaveLength(17);
    for (let index = 0; index < registry.length; index += 1) {
      const entry = registry[index];
      const row = table[index];
      expect(row.name, entry.name).toBe(entry.name);
      expect(normalizeSource(entry.regex.source), entry.name).toBe(
        normalizeEre(row.ere),
      );
    }
  });

  it('every registry regex carries no flags, so .test() keeps no state', () => {
    for (const entry of LANE_DIFF_SECRET_PATTERNS) {
      expect(entry.regex.flags, entry.name).toBe('');
    }
  });
});
