/**
 * Unit tests for the RV5 review-answer schema (F153): the plain-record
 * reader, the safe-path check, the secret screen, the strict answer
 * validator, and the single-trailing-```json fence extractor. Pure domain —
 * no I/O, no subprocesses.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_FINDING_FILE_LENGTH,
  MAX_FINDING_SUMMARY_LENGTH,
  MAX_STRUCTURED_FINDINGS,
  containsReviewSecretShape,
  extractSingleTrailingJsonFence,
  isSafeRelativeFilePath,
  readPlainRecord,
  validateReviewAnswerObject,
} from '../review-answer-schema.js';

const pass = (findings: readonly unknown[] = []): unknown => ({ verdict: 'PASS', findings });
const fail = (findings: readonly unknown[]): unknown => ({ verdict: 'FAIL', findings });
const finding = (
  severity: 'blocker' | 'major' | 'minor' | 'nit',
  file: string,
  line: number | null,
  summary: string,
): unknown => ({ severity, file, line, summary });

describe('readPlainRecord', () => {
  it('snapshots own enumerable string data properties onto a null-prototype record', () => {
    const record = readPlainRecord({ a: 1, b: 'x' });
    expect(record).not.toBeNull();
    expect(record!.a).toBe(1);
    expect(record!.b).toBe('x');
    expect(Object.getPrototypeOf(record)).toBeNull();
    expect(Object.isFrozen(record)).toBe(false);
  });

  it('keeps "__proto__" as an own key and never mutates a prototype', () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":true},"verdict":"PASS"}') as Record<string, unknown>;
    const record = readPlainRecord(hostile);
    expect(record).not.toBeNull();
    expect(Object.prototype.hasOwnProperty.call(record, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects null, primitives, arrays, and non-plain objects', () => {
    for (const bad of [null, undefined, 42, 'x', true, [], new Date(), new Map()]) {
      expect(readPlainRecord(bad)).toBeNull();
    }
  });

  it('reads a null-prototype object', () => {
    const raw = Object.create(null) as Record<string, unknown>;
    raw.verdict = 'PASS';
    expect(readPlainRecord(raw)).not.toBeNull();
  });

  it('reads as null when a getter throws (robustness 1)', () => {
    const hostile = Object.defineProperty({}, 'verdict', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
    });
    expect(readPlainRecord(hostile)).toBeNull();
  });
});

describe('containsReviewSecretShape', () => {
  it('is false for plain text with no secret shape', () => {
    expect(containsReviewSecretShape('a wording nit in README.md')).toBe(false);
    expect(containsReviewSecretShape('')).toBe(false);
  });

  it('detects secret-shaped text built at runtime, raw or whitespace-collapsed (robustness 5)', () => {
    const shapes = [
      'sk-' + 'a'.repeat(24),
      'ghp_' + 'b'.repeat(24),
      'AKIA' + '0'.repeat(16),
      'github_pat_' + 'c'.repeat(24),
      'xoxb-' + 'd'.repeat(12),
      'ya29.' + 'e'.repeat(24),
      'AIza' + 'f'.repeat(32),
      'sk-or-v1-' + '0123456789abcdef0123',
      '-----BEGIN RSA PRIVATE KEY-----',
      'ssh-ed25519 AAAA' + 'g'.repeat(24),
      'OPENCODE_SERVER_PASSWORD=hunter2',
      'antigravity-oauth-token',
      '/home/alice/.ssh/id_ed25519',
      'password: "supersecretvalue"',
      'token: "ABCdef0123456789abcdef"',
      'https://user:secretpass@host.example/x',
      'eyJ' + 'a'.repeat(20) + '.' + 'b'.repeat(12) + '.' + 'c'.repeat(12),
    ];
    for (const shape of shapes) {
      expect(containsReviewSecretShape(shape), shape).toBe(true);
      // Whitespace-collapsed text cannot sneak past for single-token shapes
      // (patterns needing literal spaces — the private-key block and the ssh
      // key header — are asserted raw only).
      if (!shape.startsWith('-----BEGIN') && !shape.startsWith('ssh-')) {
        expect(containsReviewSecretShape(shape.split('').join(' ')), shape).toBe(true);
      }
    }
  });

  it('is true for a non-string', () => {
    expect(containsReviewSecretShape(42)).toBe(true);
  });
});

describe('isSafeRelativeFilePath', () => {
  it('accepts repo-relative paths including nested ones', () => {
    for (const path of ['a.ts', 'src/a.ts', '.lane/brief.md', 'packages/x/src/deep/y.spec.ts']) {
      expect(isSafeRelativeFilePath(path), path).toBe(true);
    }
  });

  it('rejects unsafe shapes', () => {
    for (const path of [
      '', ' ', ' a.ts', 'a.ts ', '-', '/etc/passwd', '../a.ts', './a.ts', 'a/../b.ts',
      'a//b.ts', 'a\\b.ts', '~/a.ts', 'C:/a.ts', 'https://x/a.ts', 'a/', '.',
      '..', '/'.repeat(1),
    ]) {
      expect(isSafeRelativeFilePath(path), JSON.stringify(path)).toBe(false);
    }
  });

  it('rejects control characters and backslashes', () => {
    expect(isSafeRelativeFilePath('a\u0000b')).toBe(false);
    expect(isSafeRelativeFilePath('a\u0007b')).toBe(false);
  });

  it('rejects an overlong path', () => {
    expect(isSafeRelativeFilePath('a'.repeat(MAX_FINDING_FILE_LENGTH + 1))).toBe(false);
    expect(isSafeRelativeFilePath('a'.repeat(MAX_FINDING_FILE_LENGTH))).toBe(true);
  });

  it('rejects secret-shaped paths (robustness 5)', () => {
    expect(isSafeRelativeFilePath('sk-' + 'a'.repeat(24))).toBe(false);
    expect(isSafeRelativeFilePath('secrets/ghp_' + 'b'.repeat(24) + '.txt')).toBe(false);
  });
});

describe('validateReviewAnswerObject', () => {
  it('accepts valid PASS and FAIL objects', () => {
    const clean = validateReviewAnswerObject(pass());
    expect(clean).toEqual({ ok: true, value: { verdict: 'PASS', findings: [] } });
    const failing = validateReviewAnswerObject(fail([finding('blocker', 'src/a.ts', 3, 'broken')]));
    expect(failing).toEqual({
      ok: true,
      value: { verdict: 'FAIL', findings: [finding('blocker', 'src/a.ts', 3, 'broken')] },
    });
  });

  it('accepts exact boundary values', () => {
    const manyFindings = Array.from(
      { length: MAX_STRUCTURED_FINDINGS },
      (_, index) => finding('nit', `src/f${index}.ts`, index + 1, `note ${index}`),
    );
    expect(validateReviewAnswerObject(fail(manyFindings)).ok).toBe(true);
    expect(validateReviewAnswerObject(fail([finding('nit', 'src/a.ts', 1, 'z'.repeat(MAX_FINDING_SUMMARY_LENGTH))])).ok).toBe(true);
    expect(validateReviewAnswerObject(fail([finding('nit', 'a'.repeat(MAX_FINDING_FILE_LENGTH), null, 'note')])).ok).toBe(true);
  });

  it('rejects unknown or missing keys (top level and per finding)', () => {
    for (const bad of [
      { verdict: 'PASS', findings: [], extra: 1 },
      { verdict: 'PASS' },
      { findings: [] },
      fail([{ severity: 'minor', file: 'a.ts', line: 1 }]),
    ]) {
      expect(validateReviewAnswerObject(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    const extraFindingKey = { severity: 'minor', file: 'a.ts', line: 1, summary: 'note', why: 'x' };
    expect(validateReviewAnswerObject(fail([extraFindingKey])).ok).toBe(false);
    const missingFindingKey = { severity: 'minor', file: 'a.ts', line: 1 };
    expect(validateReviewAnswerObject(fail([missingFindingKey])).ok).toBe(false);
  });

  it('rejects a "__proto__" own key', () => {
    const hostile = JSON.parse('{"__proto__":{},"verdict":"PASS","findings":[]}') as unknown;
    expect(validateReviewAnswerObject(hostile).ok).toBe(false);
  });

  it('rejects null, primitive, and array inputs', () => {
    for (const bad of [null, undefined, 42, 'x', true, [], new Date()]) {
      expect(validateReviewAnswerObject(bad)).toEqual({ ok: false, reason: 'unparseable-verdict' });
    }
  });

  it('rejects invalid verdicts', () => {
    for (const verdict of ['pass', 'FAIL ', 'FIX FIRST', '', null, 1]) {
      expect(validateReviewAnswerObject({ verdict, findings: [] }).ok, String(verdict)).toBe(false);
    }
  });

  it('rejects invalid severities', () => {
    for (const severity of ['BLOCKER', 'warning', 'critical', '']) {
      expect(validateReviewAnswerObject(fail([finding(severity as never, 'a.ts', 1, 'note')])).ok).toBe(false);
    }
  });

  it('rejects unsafe file paths', () => {
    for (const file of ['', '-', '/etc/passwd', '../a.ts', './a.ts', 'a/../b.ts', 'a//b.ts', 'a\\b.ts', '~/a.ts', 'C:/a.ts']) {
      expect(validateReviewAnswerObject(fail([finding('minor', file, 1, 'note')])).ok, file).toBe(false);
    }
  });

  it('rejects invalid line numbers', () => {
    for (const line of [0, -1, 1.5, '1', NaN, Infinity]) {
      expect(validateReviewAnswerObject(fail([finding('minor', 'a.ts', line as never, 'note')])).ok, String(line)).toBe(false);
    }
  });

  it('rejects placeholder and empty summaries', () => {
    for (const summary of ['TBD', 'none', ' ', 'TODO', 'n/a']) {
      expect(validateReviewAnswerObject(fail([finding('minor', 'a.ts', 1, summary)])).ok, summary).toBe(false);
    }
  });

  it('rejects an oversized summary', () => {
    expect(validateReviewAnswerObject(fail([finding('minor', 'a.ts', 1, 'z'.repeat(301))])).ok).toBe(false);
  });

  it('rejects a summary with a NUL', () => {
    expect(validateReviewAnswerObject(fail([finding('minor', 'a.ts', 1, 'bad\u0000summary')])).ok).toBe(false);
  });

  it('rejects secret-shaped summaries or file paths built at runtime (robustness 5)', () => {
    for (const shape of ['sk-' + 'a'.repeat(24), 'ghp_' + 'b'.repeat(24), 'AKIA' + '0'.repeat(16), 'github_pat_' + 'c'.repeat(24)]) {
      expect(validateReviewAnswerObject(fail([finding('minor', 'a.ts', 1, `leak ${shape}`)])).ok, 'summary').toBe(false);
      expect(validateReviewAnswerObject(fail([finding('minor', `keys/${shape}.txt`, 1, 'note')])).ok, 'file').toBe(false);
    }
  });

  it('rejects sparse findings arrays and findings beyond the cap', () => {
    const sparse: unknown[] = new Array(3);
    sparse[0] = finding('minor', 'a.ts', 1, 'one');
    sparse[2] = finding('minor', 'b.ts', 2, 'two');
    expect(validateReviewAnswerObject(fail(sparse)).ok).toBe(false);
    const tooMany = Array.from({ length: MAX_STRUCTURED_FINDINGS + 1 }, (_, index) =>
      finding('nit', `src/f${index}.ts`, index + 1, `note ${index}`),
    );
    expect(validateReviewAnswerObject(fail(tooMany)).ok).toBe(false);
  });

  it('never throws on hostile inputs (robustness 1)', () => {
    const throwing = Object.defineProperty({}, 'verdict', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
    });
    const throwingFindings = Object.defineProperty({}, 'findings', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
    });
    for (const bad of [throwing, throwingFindings, { verdict: 'PASS', findings: [throwing] }]) {
      expect(validateReviewAnswerObject(bad)).toEqual({ ok: false, reason: 'unparseable-verdict' });
    }
  });
});

describe('extractSingleTrailingJsonFence', () => {
  it('returns none for a reply with zero json fences', () => {
    expect(extractSingleTrailingJsonFence('Just prose.\nAnd more prose.')).toEqual({ kind: 'none' });
    expect(extractSingleTrailingJsonFence('```ts\nconst x = 1;\n```\n')).toEqual({ kind: 'none' });
  });

  it('returns the body of exactly one trailing json fence', () => {
    const stripped = 'Preamble.\n```json\n{"verdict":"PASS","findings":[]}\n```\n';
    expect(extractSingleTrailingJsonFence(stripped)).toEqual({
      kind: 'single',
      jsonText: '{"verdict":"PASS","findings":[]}',
    });
  });

  it('returns invalid for two json fences', () => {
    const stripped = '```json\n{"verdict":"PASS","findings":[]}\n```\n```json\n{"verdict":"FAIL","findings":[]}\n```';
    expect(extractSingleTrailingJsonFence(stripped)).toEqual({ kind: 'invalid' });
  });

  it('returns invalid when prose follows the closing fence', () => {
    const stripped = '```json\n{"verdict":"PASS","findings":[]}\n```\nReview inconclusive.';
    expect(extractSingleTrailingJsonFence(stripped)).toEqual({ kind: 'invalid' });
  });

  it('returns invalid for an unclosed fence', () => {
    expect(extractSingleTrailingJsonFence('```json\n{"verdict":"PASS","findings":[]}\n')).toEqual({ kind: 'invalid' });
    expect(extractSingleTrailingJsonFence('```ts\nconst x = 1;\n')).toEqual({ kind: 'invalid' });
  });

  it('treats ```jsonc as no json fence and ```JSON as not the exact json info string', () => {
    expect(extractSingleTrailingJsonFence('```jsonc\n{"verdict":"PASS"}\n```')).toEqual({ kind: 'none' });
    expect(extractSingleTrailingJsonFence('```JSON\n{"verdict":"PASS"}\n```')).toEqual({ kind: 'invalid' });
  });

  it('accepts up to three leading spaces on the fences and trailing blank lines', () => {
    const stripped = '  ```json\n{"verdict":"PASS","findings":[]}\n  ```\n\n';
    expect(extractSingleTrailingJsonFence(stripped)).toEqual({
      kind: 'single',
      jsonText: '{"verdict":"PASS","findings":[]}',
    });
  });
});
