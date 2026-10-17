// Parity tests for the pure lane diff check (O14d1): the same fixtures as
// tests/lane-diff-check.test.sh (S2) must reach the same verdicts here. The
// fake credentials are assembled at run time from harmless parts, so this
// file itself matches none of the patterns. Findings carry path, line and
// rule name only — never a matched value.

import { describe, expect, it } from 'vitest';

import {
  checkLaneDiff,
  pathUnderPrefix,
  validateAllowedPathPrefix,
  type LaneDiffChangedPath,
  type LaneDiffSecretPattern,
} from '../lane-diff-check.js';

// The script's pattern table, narrowed to the fixtures below. Patterns live
// in the input; the pure function never invents any.
const SCRIPT_PATTERNS: readonly LaneDiffSecretPattern[] = [
  { name: 'github-token', regex: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'private-key-block', regex: /BEGIN [A-Z ]*PRIVATE KEY/ },
  { name: 'home-credential-path', regex: /\/home\/[a-z]+\/\.(ssh|config\/gh|gemini|aws|docker\/config\.json)/ },
  { name: 'password-assignment', regex: /[Pp]assword[ \t]*[:=][ \t]*["'][^"']{6,}["']/ },
];

const tok = `ghp_${'abcdefghij'}${'0123456789'}`;

function line(path: string, line: number, text: string): LaneDiffChangedPath {
  return { path, status: 'added', addedLines: [{ line, text }] };
}

const PREFIXES = ['packages/x'];

function check(paths: LaneDiffChangedPath[], extra: Record<string, unknown> = {}) {
  return checkLaneDiff({
    changedPaths: paths,
    allowedPathPrefixes: PREFIXES,
    secretPatterns: SCRIPT_PATTERNS,
    ...extra,
  });
}

describe('checkLaneDiff (script parity)', () => {
  it('an ordinary source change is clean', () => {
    const verdict = check([
      { path: 'packages/x/src/a.ts', status: 'modified', addedLines: [{ line: 1, text: 'export const a = 2;' }] },
    ]);
    expect(verdict).toEqual({ ok: true, findings: [] });
  });

  it('a changed workflow under .github is a protected-path finding (and outside the prefixes)', () => {
    const verdict = check([{ path: '.github/workflows/gate.yml', status: 'modified' }]);
    expect(verdict.findings).toEqual([
      { path: '.github/workflows/gate.yml', rule: 'outside-allowed-paths' },
      { path: '.github/workflows/gate.yml', rule: 'protected-path' },
    ]);
  });

  it('a lane plumbing change under .lane is a protected-path finding', () => {
    const verdict = check([{ path: '.lane/brief-manifest.json', status: 'untracked' }]);
    expect(verdict.findings).toEqual([
      { path: '.lane/brief-manifest.json', rule: 'outside-allowed-paths' },
      { path: '.lane/brief-manifest.json', rule: 'protected-path' },
    ]);
  });

  it('a policy addition extends the protected list (.gemini)', () => {
    const verdict = check([{ path: '.gemini/settings.json', status: 'untracked' }], {
      policyProtectedPaths: ['.gemini'],
    });
    expect(verdict.findings).toEqual([
      { path: '.gemini/settings.json', rule: 'outside-allowed-paths' },
      { path: '.gemini/settings.json', rule: 'protected-path' },
    ]);
  });

  it('a token-shaped string in a new file is a finding with its line and rule only', () => {
    const verdict = check([line('packages/x/src/b.ts', 1, `const t = "${tok}";`)]);
    expect(verdict.findings).toEqual([
      { path: 'packages/x/src/b.ts', line: 1, rule: 'secret-pattern:github-token' },
    ]);
  });

  it('a private key block is a finding with its line', () => {
    const pk = `-----BEGIN${' OPENSSH PRIVATE KEY'}-----`;
    const verdict = check([
      { path: 'packages/x/src/key.txt', status: 'untracked', addedLines: [{ line: 1, text: 'line one' }, { line: 2, text: pk }] },
    ]);
    expect(verdict.findings).toEqual([
      { path: 'packages/x/src/key.txt', line: 2, rule: 'secret-pattern:private-key-block' },
    ]);
  });

  it('a home credential path is a finding', () => {
    const verdict = check([
      { path: 'packages/x/src/note.md', status: 'added', addedLines: [{ line: 1, text: 'see /home/martin/.ssh/id_ed25519 for the key' }] },
    ]);
    expect(verdict.findings).toEqual([
      { path: 'packages/x/src/note.md', line: 1, rule: 'secret-pattern:home-credential-path' },
    ]);
  });

  it('a password assignment is a finding but reading one from the environment is not', () => {
    const assigned = check([line('packages/x/src/c.ts', 1, `const password = ${'"hunter2hunter2"'};`)]);
    expect(assigned.findings.map((f) => f.rule)).toEqual(['secret-pattern:password-assignment']);
    const fromEnv = check([line('packages/x/src/d.ts', 1, 'const password = process.env.PASSWORD;')]);
    expect(fromEnv).toEqual({ ok: true, findings: [] });
  });

  it('the matched secret value never appears in any finding', () => {
    const verdict = check([line('packages/x/src/b.ts', 1, `const t = "${tok}";`)]);
    expect(JSON.stringify(verdict)).not.toContain('abcdefghij');
  });

  it('a staged rename away from a protected path is still a protected-path finding', () => {
    const verdict = check([
      { path: '.github/workflows/gate.yml', status: 'deleted' },
      { path: 'packages/x/gate.yml', status: 'added' },
    ]);
    expect(verdict.findings).toEqual([
      { path: '.github/workflows/gate.yml', rule: 'outside-allowed-paths' },
      { path: '.github/workflows/gate.yml', rule: 'protected-path' },
    ]);
  });

  it('an untracked non-ASCII file name is scanned as the real file', () => {
    const verdict = check([
      { path: 'packages/x/src/caf\u00e9 file.ts', status: 'untracked', addedLines: [{ line: 1, text: `const t = "${tok}";` }] },
    ]);
    expect(verdict.findings[0]).toEqual({
      path: 'packages/x/src/caf\u00e9 file.ts',
      line: 1,
      rule: 'secret-pattern:github-token',
    });
  });
});

describe('checkLaneDiff (allowed prefixes)', () => {
  it('a path outside every allowed prefix is refused as outside-allowed-paths', () => {
    const verdict = check([{ path: 'apps/cli/other.ts', status: 'untracked' }]);
    expect(verdict.findings).toEqual([{ path: 'apps/cli/other.ts', rule: 'outside-allowed-paths' }]);
  });

  it('a deleted file under an allowed prefix passes', () => {
    const verdict = check([{ path: 'packages/x/src/old.ts', status: 'deleted' }]);
    expect(verdict).toEqual({ ok: true, findings: [] });
  });

  it('a protected lockfile is refused even under an allowed prefix, unless a prefix explicitly allows it', () => {
    const refused = check([{ path: 'packages/x/yarn.lock', status: 'modified' }]);
    expect(refused.findings).toEqual([{ path: 'packages/x/yarn.lock', rule: 'protected-path' }]);
    const rootLock = checkLaneDiff({
      changedPaths: [{ path: 'yarn.lock', status: 'modified' }],
      allowedPathPrefixes: ['packages/x', 'yarn.lock'],
      secretPatterns: SCRIPT_PATTERNS,
    });
    expect(rootLock).toEqual({ ok: true, findings: [] });
  });

  it('a .github path a prefix explicitly allows is not protected', () => {
    const verdict = checkLaneDiff({
      changedPaths: [{ path: '.github/workflows/gate.yml', status: 'modified' }],
      allowedPathPrefixes: ['.github'],
      secretPatterns: SCRIPT_PATTERNS,
    });
    expect(verdict).toEqual({ ok: true, findings: [] });
  });

  it('an absent or empty prefixes list refuses every path (fail closed)', () => {
    for (const allowedPathPrefixes of [[], undefined]) {
      const verdict = checkLaneDiff({
        changedPaths: [{ path: 'packages/x/src/a.ts', status: 'modified' }],
        ...(allowedPathPrefixes !== undefined ? { allowedPathPrefixes } : {}),
      } as Parameters<typeof checkLaneDiff>[0]);
      expect(verdict.findings).toEqual([{ path: 'packages/x/src/a.ts', rule: 'outside-allowed-paths' }]);
    }
  });
});

describe('validateAllowedPathPrefix (brief prepare)', () => {
  it('accepts ordinary relative prefixes', () => {
    for (const prefix of ['packages/x/src', 'docs', 'README.md', 'packages/x/']) {
      expect(validateAllowedPathPrefix(prefix)).toBeNull();
    }
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['absolute path', '/etc/passwd'],
    ['parent traversal', 'packages/../..'],
    ['leading dot-dot', '../escape'],
    ['git plumbing', '.git'],
    ['git plumbing subdir', '.git/hooks/pre-commit'],
    ['lane plumbing', '.lane'],
    ['lane plumbing subdir', '.lane/brief.md'],
  ])('refuses %s (%j)', (_label, prefix) => {
    expect(validateAllowedPathPrefix(prefix)).not.toBeNull();
  });
});

describe('pathUnderPrefix', () => {
  it('matches the prefix itself and anything under it, never a sibling', () => {
    expect(pathUnderPrefix('packages/x', 'packages/x')).toBe(true);
    expect(pathUnderPrefix('packages/x/src/a.ts', 'packages/x')).toBe(true);
    expect(pathUnderPrefix('packages/x/src/a.ts', 'packages/x/')).toBe(true);
    expect(pathUnderPrefix('packages/xtra/a.ts', 'packages/x')).toBe(false);
  });
});
