import { describe, expect, it } from 'vitest';

import {
  ADMISSION_CLASS_ORDER,
  DEFAULT_BATCH_POLICY,
  admissionClassCap,
  changesOverlap,
  classifyChange,
  classifyChangedPath,
  normalizeChangedPath,
  validateBatchPolicy,
} from '../admission-policy.js';

describe('normalizeChangedPath', () => {
  it('normalizes separators, leading parts, case and repeated slashes', () => {
    expect(normalizeChangedPath('.GitHub\\Workflows\\ci.yml')).toBe('.github/workflows/ci.yml');
    expect(normalizeChangedPath('./Apps//X/src/a.ts')).toBe('apps/x/src/a.ts');
    expect(normalizeChangedPath('///a//b/')).toBe('a/b/');
  });
});

describe('classifyChangedPath — table', () => {
  const CASES: readonly { path: string; expected: 'alone' | 'migration' | 'dependency' | 'normal' }[] = [
    { path: '.github/workflows/ci.yml', expected: 'alone' },
    { path: '.circleci/config.yml', expected: 'alone' },
    { path: '.gitlab-ci.yml', expected: 'alone' },
    { path: 'infra/branch-protection-rules.json', expected: 'alone' },
    { path: 'SECURITY.md', expected: 'alone' },
    { path: 'docs/security-notes.md', expected: 'alone' },
    { path: 'src/security/auth.ts', expected: 'alone' },
    { path: 'scripts/release-notes.sh', expected: 'alone' },
    { path: 'build/releases/index.ts', expected: 'alone' },
    { path: 'config/.releaserc.json', expected: 'alone' },
    { path: 'db/migrations/001.sql', expected: 'migration' },
    { path: 'src/migrate/data.ts', expected: 'migration' },
    { path: 'yarn.lock', expected: 'dependency' },
    { path: 'apps/x/package.json', expected: 'dependency' },
    { path: 'rust/Cargo.toml', expected: 'dependency' },
    { path: 'packages/a/src/x.ts', expected: 'normal' },
    { path: 'docs/planning/notes.md', expected: 'normal' },
    { path: '.GitHub\\Workflows\\ci.yml', expected: 'alone' },
  ];
  for (const testCase of CASES) {
    it(`classifies ${testCase.path} as ${testCase.expected}`, () => {
      expect(classifyChangedPath(testCase.path)).toBe(testCase.expected);
    });
  }
});

describe('classifyChange', () => {
  it('is alone for an empty list', () => {
    expect(classifyChange([])).toBe('alone');
  });
  it('returns the strictest class for a mixed list', () => {
    expect(classifyChange(['packages/a/src/x.ts', 'yarn.lock', 'db/migrations/001.sql'])).toBe('migration');
    expect(classifyChange(['packages/a/src/x.ts', 'yarn.lock'])).toBe('dependency');
    expect(classifyChange(['.github/workflows/ci.yml', 'db/migrations/001.sql'])).toBe('alone');
  });
  it('ranks alone strictly first', () => {
    expect(ADMISSION_CLASS_ORDER.indexOf('alone')).toBeLessThan(ADMISSION_CLASS_ORDER.indexOf('normal'));
  });
});

describe('admissionClassCap', () => {
  it('caps every class with maxBatchSize 4', () => {
    expect(admissionClassCap('alone', 4)).toBe(1);
    expect(admissionClassCap('migration', 4)).toBe(2);
    expect(admissionClassCap('dependency', 4)).toBe(2);
    expect(admissionClassCap('normal', 4)).toBe(4);
  });
  it('never exceeds maxBatchSize 1', () => {
    expect(admissionClassCap('alone', 1)).toBe(1);
    expect(admissionClassCap('migration', 1)).toBe(1);
    expect(admissionClassCap('dependency', 1)).toBe(1);
    expect(admissionClassCap('normal', 1)).toBe(1);
  });
});

describe('changesOverlap', () => {
  it('is true for shared normalized paths', () => {
    expect(changesOverlap(['src/a.ts', 'src/b.ts'], ['SRC\\a.ts', 'other.ts'])).toBe(true);
  });
  it('is false for different files in the same directory', () => {
    expect(changesOverlap(['src/a.ts'], ['src/b.ts'])).toBe(false);
  });
  it('is false for empty lists', () => {
    expect(changesOverlap([], ['src/a.ts'])).toBe(false);
    expect(changesOverlap([], [])).toBe(false);
  });
});

describe('validateBatchPolicy', () => {
  it('accepts DEFAULT_BATCH_POLICY', () => {
    const result = validateBatchPolicy(DEFAULT_BATCH_POLICY);
    expect(result).toEqual({ ok: true, value: { ...DEFAULT_BATCH_POLICY } });
  });
  it('refuses non-objects and arrays', () => {
    expect(validateBatchPolicy(null).ok).toBe(false);
    expect(validateBatchPolicy('no').ok).toBe(false);
    expect(validateBatchPolicy([{ maxBatchSize: 4 }]).ok).toBe(false);
  });
  it('refuses non-positive or fractional numbers', () => {
    expect(validateBatchPolicy({ maxBatchSize: 0, minBatchSize: 1, collectionWaitMs: 1, speculativeDepth: 1 }).ok).toBe(false);
    expect(validateBatchPolicy({ maxBatchSize: 4, minBatchSize: -1, collectionWaitMs: 1, speculativeDepth: 1 }).ok).toBe(false);
    expect(validateBatchPolicy({ maxBatchSize: 4.5, minBatchSize: 1, collectionWaitMs: 1, speculativeDepth: 1 }).ok).toBe(false);
    expect(validateBatchPolicy({ maxBatchSize: 4, minBatchSize: 1, collectionWaitMs: 1, speculativeDepth: 0 }).ok).toBe(false);
  });
  it('refuses a string collectionWaitMs and accepts 0', () => {
    expect(
      validateBatchPolicy({ maxBatchSize: 4, minBatchSize: 2, collectionWaitMs: 'soon', speculativeDepth: 2 }).ok,
    ).toBe(false);
    expect(validateBatchPolicy({ maxBatchSize: 4, minBatchSize: 2, collectionWaitMs: 0, speculativeDepth: 2 }).ok).toBe(true);
  });
  it('refuses min > max', () => {
    expect(
      validateBatchPolicy({ maxBatchSize: 2, minBatchSize: 3, collectionWaitMs: 1, speculativeDepth: 1 }).ok,
    ).toBe(false);
  });
  it('returns only the four fields on success', () => {
    const result = validateBatchPolicy({ maxBatchSize: 3, minBatchSize: 1, collectionWaitMs: 5, speculativeDepth: 2, extra: true });
    expect(result).toEqual({ ok: true, value: { maxBatchSize: 3, minBatchSize: 1, collectionWaitMs: 5, speculativeDepth: 2 } });
  });
});
