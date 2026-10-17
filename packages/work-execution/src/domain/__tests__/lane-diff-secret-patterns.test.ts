// Parity tests for the lane diff check's secret registry (O14d1): the
// `LANE_DIFF_SECRET_PATTERNS` registry must carry exactly the 17 named
// patterns of `scripts/lane-diff-check.sh`, in the script's order, with the
// same match semantics. Every fixture value is built at run time from
// harmless parts, so this file itself matches none of the patterns, and no
// matched value is ever asserted or printed — only rule names.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';
import { checkLaneDiff, type LaneDiffChangedPath } from '../lane-diff-check.js';

/** The repo root, found by walking up from this test file. */
function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(dir, 'scripts', 'lane-diff-check.sh'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('could not locate scripts/lane-diff-check.sh');
    dir = parent;
  }
  return dir;
}

/** The script's pattern names, read from its own table, in order. */
function scriptPatternNames(): string[] {
  const source = readFileSync(path.join(repoRoot(), 'scripts', 'lane-diff-check.sh'), 'utf8');
  const names: string[] = [];
  for (const line of source.split('\n')) {
    const match = /^([a-z0-9-]+)\|.+$/.exec(line);
    if (match !== null) names.push(match[1]);
  }
  return names;
}

/**
 * One obviously fake synthetic value per rule, built from harmless parts at
 * run time. `extra` lists rule names that necessarily also match (a pattern
 * that is a strict subset of another, as in the script's own table).
 */
const POSITIVE_FIXTURES: readonly { name: string; value: string; extra?: readonly string[] }[] = [
  { name: 'aws-access-key', value: 'AKIA' + 'IOSFODNN7EXAMPLE' },
  { name: 'github-token', value: 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789' },
  { name: 'github-fine-grained-token', value: 'github_pat_' + 'Abcdefghijklmnopqrstuv' },
  { name: 'private-key-block', value: '-----BEGIN ' + 'OPENSSH PRIVATE KEY' + '-----' },
  { name: 'google-oauth-access-token', value: 'ya29.' + 'abcdefghijklmnopqrstuvwxyz' },
  { name: 'google-api-key', value: 'AIza' + 'a'.repeat(32) },
  { name: 'openai-style-key', value: 'sk-' + 'abcdefghijklmnopqrst' },
  // A fake OpenRouter key also carries the openai `sk-` shape, in the TS
  // registry exactly as in the script's table.
  { name: 'openrouter-key', value: 'sk-or-v1-' + '0123456789abcdef0123', extra: ['openai-style-key'] },
  { name: 'slack-token', value: 'xoxb-' + 'abcdefghij' },
  { name: 'jwt', value: 'eyJ' + 'abcdefghijklmnopqrstuvwxyz' + '.' + 'abcdefghij' + '.' + 'abcdefghij' },
  { name: 'ssh-public-key-material', value: 'ssh-' + 'ed25519' + ' AAAA' + 'A'.repeat(20) },
  { name: 'opencode-server-password', value: 'OPENCODE_SERVER_PASSWORD = ' + 'dummy-placeholder' },
  { name: 'agy-oauth-file', value: 'antigravity-' + 'oauth-token' },
  { name: 'home-credential-path', value: 'see /home/' + 'testuser' + '/.' + 'ssh' + '/id_ed25519 here' },
  { name: 'password-assignment', value: 'password: ' + '"hunter2hunter2"' },
  { name: 'token-assignment', value: 'token: ' + '"abcdefghijklmnop"' },
  { name: 'basic-auth-url', value: 'https://' + 'alice' + ':' + 'supersecret1' + '@example.invalid/x' },
];

/** One near-miss line per rule: shaped like the rule but just below or beside it. */
const NEGATIVE_FIXTURES: readonly { name: string; value: string }[] = [
  { name: 'aws-access-key', value: 'AKIAIOSFODNN7EXAMPL' },
  { name: 'github-token', value: 'ghp_' + 'abcdefghijklmnopqrs' },
  { name: 'github-fine-grained-token', value: 'github_pat_' + 'Abcdefghijklmnopqrs' },
  { name: 'private-key-block', value: '-----END PRIVATE KEY-----' },
  { name: 'google-oauth-access-token', value: 'ya29.' + 'abcdefghijklmnopqrs' },
  { name: 'google-api-key', value: 'AIza' + 'a'.repeat(29) },
  { name: 'openai-style-key', value: 'sk-' + 'abcdefghijklmnopqr' },
  // 13 hex digits sit below the openai `sk-` threshold (6+13 < 20) and below
  // the openrouter threshold (20), so neither rule fires.
  { name: 'openrouter-key', value: 'sk-or-v1-' + '0123456789abc' },
  { name: 'slack-token', value: 'xoxb-' + 'abcdefghi' },
  { name: 'jwt', value: 'eyJ' + 'abcdefghijklmnopqrs' + '.' + 'abcdefghij' + '.' + 'abcdefghij' },
  { name: 'ssh-public-key-material', value: 'ssh-ed25519 AAAA' + 'A'.repeat(19) },
  { name: 'opencode-server-password', value: 'OPENCODE_SERVER_PASSWORD =' },
  { name: 'agy-oauth-file', value: 'antigravity oauth token' },
  { name: 'home-credential-path', value: 'see /home/testuser/documents/notes here' },
  { name: 'password-assignment', value: 'password: hunter2hunter2' },
  { name: 'token-assignment', value: 'token: "abc123"' },
  { name: 'basic-auth-url', value: 'https://alice@example.invalid/x' },
];

const PREFIXES = ['packages/x'];

/** The TS verdict's secret rule names for one fixture line. */
function tsRules(text: string): string[] {
  const changed: LaneDiffChangedPath = {
    path: 'packages/x/src/fixture.txt',
    status: 'untracked',
    addedLines: [{ line: 1, text }],
  };
  const verdict = checkLaneDiff({
    changedPaths: [changed],
    allowedPathPrefixes: PREFIXES,
    secretPatterns: LANE_DIFF_SECRET_PATTERNS,
  });
  return verdict.findings.filter((f) => f.rule.startsWith('secret-pattern:')).map((f) => f.rule.slice('secret-pattern:'.length));
}

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Run the shell script over untracked fixture files; return (path, name) hits. */
function runScript(files: Record<string, string>): Set<string> {
  const repo = mkdtempSync(path.join(tmpdir(), 'lane-diff-parity.'));
  dirs.push(repo);
  execFileSync('git', ['init', '-q', '.'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@example.invalid'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  mkdirSync(path.join(repo, 'packages/x/src'), { recursive: true });
  writeFileSync(path.join(repo, 'packages/x/src/a.ts'), 'export const a = 1;\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'], { cwd: repo });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(path.join(repo, 'packages/x/src', `${name}.txt`), `${text}\n`);
  }
  // Exit 1 means findings, which the positive fixtures legitimately produce.
  const run = spawnSync('sh', [path.join(repoRoot(), 'scripts', 'lane-diff-check.sh'), repo, '--base', 'HEAD'], {
    encoding: 'utf8',
  });
  const stdout = run.stdout;
  const hits = new Set<string>();
  for (const line of stdout.split('\n')) {
    const match = /^secret-pattern: packages\/x\/src\/([a-z0-9-]+)\.txt:\d+ \((.+)\)$/.exec(line);
    if (match !== null) hits.add(`${match[1]}:${match[2]}`);
  }
  return hits;
}

describe('LANE_DIFF_SECRET_PATTERNS (script parity)', () => {
  it('carries exactly the script’s 17 names, in the script’s order', () => {
    const script = scriptPatternNames();
    expect(script.length).toBe(17);
    expect(LANE_DIFF_SECRET_PATTERNS.length).toBe(17);
    expect(LANE_DIFF_SECRET_PATTERNS.map((entry) => entry.name)).toEqual(script);
  });

  it('every pattern in the script table appears exactly once', () => {
    const names = LANE_DIFF_SECRET_PATTERNS.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  for (const fixture of POSITIVE_FIXTURES) {
    it(`the synthetic positive line names exactly ${fixture.name} (and its declared supersets)`, () => {
      const expected = [fixture.name, ...(fixture.extra ?? [])].sort();
      expect(tsRules(fixture.value).sort()).toEqual(expected);
    });
  }

  for (const fixture of NEGATIVE_FIXTURES) {
    it(`the near-miss line for ${fixture.name} is clean`, () => {
      expect(tsRules(fixture.value)).toEqual([]);
    });
  }

  it('the shell script reaches the same verdicts on the same fixture lines', { timeout: 60_000 }, () => {
    const positives: Record<string, string> = {};
    const negatives: Record<string, string> = {};
    for (const fixture of POSITIVE_FIXTURES) positives[fixture.name] = fixture.value;
    for (const fixture of NEGATIVE_FIXTURES) negatives[fixture.name] = fixture.value;

    const positiveHits = runScript(positives);
    const negativeHits = runScript(negatives);

    expect(negativeHits.size).toBe(0);
    for (const fixture of POSITIVE_FIXTURES) {
      const expected = [fixture.name, ...(fixture.extra ?? [])].sort();
      const scriptRules = [...positiveHits]
        .filter((hit) => hit.startsWith(`${fixture.name}:`))
        .map((hit) => hit.slice(fixture.name.length + 1))
        .sort();
      expect(scriptRules).toEqual(expected);
    }
  });
});
