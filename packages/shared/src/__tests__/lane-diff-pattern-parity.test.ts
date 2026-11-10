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

/**
 * Rules the SHELL table carries that are deliberately NOT in the TypeScript
 * secret registry, by exact name.
 *
 * `scripts/lane-diff-check.sh`'s table grew a second purpose: it now also
 * reports inline lint suppression (`eslint-disable`, `@ts-nocheck`, commit
 * c94b1d0a1d). That is a code-review signal, not a credential shape, and it
 * must not enter `LANE_DIFF_SECRET_PATTERNS` — that registry backs
 * `containsSecretShape`, which refuses host names and frozen brief fields, so
 * admitting `lint-suppression` would make any brief that merely mentions
 * `eslint-disable` refuse as secret-shaped.
 *
 * Every name here must still be present in the script, which the first test
 * asserts: an exemption that stops matching a real row is a dead exemption,
 * and a dead exemption would silently widen to cover a genuinely missing
 * secret rule. Adding a name here is a deliberate act with a reason, never a
 * way to quiet this test.
 */
const SCRIPT_ONLY_NON_SECRET_RULES: readonly string[] = ['lint-suppression'];

/** The script's SECRET rows: the table minus the declared non-secret rules. */
function scriptSecretRows(): Array<{ name: string; ere: string }> {
  return scriptPatternTable().filter(
    (row) => !SCRIPT_ONLY_NON_SECRET_RULES.includes(row.name),
  );
}

describe('LANE_DIFF_SECRET_PATTERNS (script-table parity)', () => {
  it('declares every script-only exemption, and each one really is in the script', () => {
    const names = scriptPatternTable().map((row) => row.name);
    for (const exempt of SCRIPT_ONLY_NON_SECRET_RULES) {
      expect(names, `exemption ${exempt} no longer matches a script row`).toContain(exempt);
    }
  });

  it('carries exactly the script table\'s secret names, in the same order', () => {
    const rows = scriptSecretRows();
    expect(rows).toHaveLength(LANE_DIFF_SECRET_PATTERNS.length);
    expect(LANE_DIFF_SECRET_PATTERNS.map((entry) => entry.name)).toEqual(
      rows.map((row) => row.name),
    );
  });

  it('every rule\'s regex text matches the script table\'s ERE after normalization', () => {
    const table = scriptSecretRows();
    const registry = LANE_DIFF_SECRET_PATTERNS;
    expect(table).toHaveLength(registry.length);
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
