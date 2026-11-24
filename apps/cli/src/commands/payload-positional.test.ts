/**
 * Companion tests for the small boundary helpers in `commands/payload.ts`:
 * `firstPositional`, `questionIdPositional`, `readQuestionFile`,
 * `evidenceAssessmentId`, and the two early `--seatPlanFromInstallation`
 * refusals in `briefSeatPlan`. Nothing else in `payload.ts` is under test
 * here.
 *
 * Cost bounds (why none is needed beyond these):
 * - `firstPositional`: O(1) — one property lookup, `Array.isArray`, index 0,
 *   `trim()`; never iterates array length.
 * - `questionIdPositional`: O(1) — delegates to `firstPositional`, one `=== ''`.
 * - `readQuestionFile`: O(file size) — one `readFileSync` + `JSON.parse` on the
 *   given path, no directory walk.
 * - `evidenceAssessmentId`: O(1) — two `optStr` lookups, one `typeof` check,
 *   one `assessmentIdForAttempt` call.
 * - `briefSeatPlan` (early flag checks): O(1) — two property lookups and
 *   strict equality checks, before any JSON parse or catalog lookup.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assessmentIdForAttempt } from '@fleet/evidence-and-acceptance';

import {
  CliUsageError,
  briefSeatPlan,
  evidenceAssessmentId,
  firstPositional,
  questionIdPositional,
  readQuestionFile,
} from './payload.js';

let tmpDir: string;

afterAll(() => {
  if (tmpDir !== undefined) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

/** A payload whose unrelated-key getter throws, to prove it is never read. */
function payloadWithThrowingGetter(key: string, base: Record<string, unknown>): Record<string, unknown> {
  const p: Record<string, unknown> = { ...base };
  Object.defineProperty(p, key, {
    get() {
      throw new Error(`getter '${key}' must never be invoked`);
    },
    enumerable: true,
  });
  return p;
}

describe('firstPositional', () => {
  it('returns the trimmed first positional string', () => {
    expect(firstPositional({ positional: ['  q-1  '] })).toBe('q-1');
  });

  it('returns empty string when positional is missing', () => {
    expect(firstPositional({})).toBe('');
  });

  it('returns empty string when positional is not an array (null, undefined, primitive, array-like, huge length)', () => {
    // Each refusal is O(1): Array.isArray rejects every non-array shape, so
    // neither indexing nor length iteration ever happens.
    expect(firstPositional({ positional: null })).toBe('');
    expect(firstPositional({ positional: undefined })).toBe('');
    expect(firstPositional({ positional: 42 })).toBe('');
    expect(firstPositional({ positional: 'abc' })).toBe('');
    expect(firstPositional({ positional: true })).toBe('');
    expect(firstPositional({ positional: {} })).toBe('');
    expect(firstPositional({ positional: { 0: 'q-1', length: 1 } })).toBe('');
    expect(firstPositional({ positional: { length: 1e9 } })).toBe('');
  });

  it('returns empty string for empty array or leading array hole', () => {
    expect(firstPositional({ positional: [] })).toBe('');
    // Sparse array: positionals[0] is undefined, so no string is produced.
    const sparse: unknown[] = ['q-2'];
    delete sparse[0];
    expect(firstPositional({ positional: sparse })).toBe('');
  });

  it('returns empty string when first positional element is not a string', () => {
    expect(firstPositional({ positional: [123] })).toBe('');
    expect(firstPositional({ positional: [null] })).toBe('');
    expect(firstPositional({ positional: [undefined] })).toBe('');
    expect(firstPositional({ positional: [{}] })).toBe('');
  });

  it('ignores prototype-polluting keys and never invokes unrelated getters on firstPositional', () => {
    // JSON.parse places `__proto__` as an own data property, so it never
    // reaches the real prototype; the lookup for 'positional' finds nothing.
    const polluted = JSON.parse('{"__proto__":{"positional":["evil"]}}') as Record<string, unknown>;
    expect(firstPositional(polluted)).toBe('');
    const withGetter = payloadWithThrowingGetter('unrelated', { positional: ['q-1'] });
    expect(firstPositional(withGetter)).toBe('q-1');
  });

  it('handles Proxy positional consistently with array and string checks', () => {
    // A Proxy of an array-like is not an Array.isArray match, so it is refused.
    expect(firstPositional({ positional: new Proxy({ 0: 'q-1', length: 1 }, {}) })).toBe('');
    // A Proxy of an array whose element 0 is not a string is refused.
    expect(firstPositional({ positional: new Proxy([42], {}) })).toBe('');
    // A Proxy of an array with a string at index 0 is trimmed normally.
    expect(firstPositional({ positional: new Proxy(['  q-1 '], {}) })).toBe('q-1');
  });
});

describe('questionIdPositional', () => {
  it('returns the trimmed question id positional', () => {
    expect(questionIdPositional({ positional: ['  q-1 '] }, 'show')).toBe('q-1');
  });

  it('throws CliUsageError naming subcommand when question id positional is missing or blank', () => {
    for (const payload of [
      {},
      { positional: [''] },
      { positional: ['   '] },
      { positional: null },
      { positional: 42 },
      { positional: [123] },
    ]) {
      expect(() => questionIdPositional(payload, 'show')).toThrow(CliUsageError);
      expect(() => questionIdPositional(payload, 'show')).toThrow(
        /questions show requires a question id/,
      );
    }
  });
});

describe('readQuestionFile', () => {
  it('returns the parsed JSON object from the file', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fleet-payload-test-'));
    const file = join(tmpDir, 'question.json');
    writeFileSync(file, '{"question":"what","context":"why"}', 'utf8');
    expect(readQuestionFile(file)).toEqual({ question: 'what', context: 'why' });
  });

  it('throws CliUsageError with path and cannot read for missing question file', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fleet-payload-test-'));
    const missing = join(tmpDir, 'no-such-file.json');
    try {
      readQuestionFile(missing);
      expect.unreachable('readQuestionFile must throw for a missing file');
    } catch (error) {
      expect(error).toBeInstanceOf(CliUsageError);
      expect((error as Error).message).toContain(missing);
      expect((error as Error).message).toContain('cannot read');
    }
  });

  it('throws CliUsageError with path and cannot read when path is a directory', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fleet-payload-test-'));
    const dir = join(tmpDir, 'a-directory');
    mkdirSync(dir);
    try {
      readQuestionFile(dir);
      expect.unreachable('readQuestionFile must throw for a directory path');
    } catch (error) {
      expect(error).toBeInstanceOf(CliUsageError);
      expect((error as Error).message).toContain(dir);
      expect((error as Error).message).toContain('cannot read');
    }
  });

  it('throws CliUsageError with path and not valid JSON for invalid JSON file', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fleet-payload-test-'));
    const file = join(tmpDir, 'bad.json');
    writeFileSync(file, '{bad', 'utf8');
    try {
      readQuestionFile(file);
      expect.unreachable('readQuestionFile must throw for malformed JSON');
    } catch (error) {
      expect(error).toBeInstanceOf(CliUsageError);
      expect((error as Error).message).toContain(file);
      expect((error as Error).message).toContain('not valid JSON');
    }
  });

  it('throws CliUsageError with path and must hold one JSON object for array, null, number, string, or boolean', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fleet-payload-test-'));
    for (const [name, content] of [
      ['array.json', '[]'],
      ['null.json', 'null'],
      ['number.json', '42'],
      ['string.json', '"x"'],
      ['boolean.json', 'true'],
    ] as const) {
      const file = join(tmpDir, name);
      writeFileSync(file, content, 'utf8');
      try {
        readQuestionFile(file);
        expect.unreachable(`readQuestionFile must throw for ${content}`);
      } catch (error) {
        expect(error).toBeInstanceOf(CliUsageError);
        expect((error as Error).message).toContain(file);
        expect((error as Error).message).toContain('must hold one JSON object');
      }
    }
  });
});

describe('evidenceAssessmentId', () => {
  it('derives the assessment id from the attempt via assessmentIdForAttempt', () => {
    expect(evidenceAssessmentId({ attemptId: 'attempt-1' })).toBe(
      assessmentIdForAttempt('attempt-1'),
    );
    // An explicit id that agrees with the derived one is accepted.
    expect(
      evidenceAssessmentId({ attemptId: 'attempt-1', assessmentId: assessmentIdForAttempt('attempt-1') }),
    ).toBe(assessmentIdForAttempt('attempt-1'));
  });

  it('throws CliUsageError naming both ids when explicit assessmentId disagrees with derived id', () => {
    const attemptId = 'attempt-1';
    const derived = assessmentIdForAttempt(attemptId);
    try {
      evidenceAssessmentId({ attemptId, assessmentId: 'someone-elses-id' });
      expect.unreachable('evidenceAssessmentId must refuse a mismatching explicit id');
    } catch (error) {
      expect(error).toBeInstanceOf(CliUsageError);
      expect((error as Error).message).toContain('someone-elses-id');
      expect((error as Error).message).toContain(attemptId);
      expect((error as Error).message).toContain(derived);
    }
  });

  it('returns empty string when neither attemptId, nestedAttemptId, nor assessmentId is usable', () => {
    // Missing/blank attemptId and non-string/blank nestedAttemptId, no
    // assessmentId: every branch is O(1) and yields ''.
    expect(evidenceAssessmentId({})).toBe('');
    expect(evidenceAssessmentId({ attemptId: '' })).toBe('');
    expect(evidenceAssessmentId({ attemptId: '   ' })).toBe('');
    expect(evidenceAssessmentId({ attemptId: null })).toBe('');
    expect(evidenceAssessmentId({}, null)).toBe('');
    expect(evidenceAssessmentId({}, 123)).toBe('');
    expect(evidenceAssessmentId({}, '   ')).toBe('');
  });

  it('uses the nested attempt id when the top-level attemptId is absent', () => {
    expect(evidenceAssessmentId({}, 'attempt-2')).toBe(assessmentIdForAttempt('attempt-2'));
  });

  it('ignores prototype-polluting keys and unrelated getters in evidenceAssessmentId', () => {
    // JSON.parse's `__proto__` is an own data property, never a string value
    // for attemptId or assessmentId, so nothing is derived from it.
    const polluted = JSON.parse('{"__proto__":{"attemptId":"evil"}}') as Record<string, unknown>;
    expect(evidenceAssessmentId(polluted)).toBe('');
    const withGetter = payloadWithThrowingGetter('unrelated', { attemptId: 'attempt-3' });
    expect(evidenceAssessmentId(withGetter)).toBe(assessmentIdForAttempt('attempt-3'));
  });
});

describe('briefSeatPlan early flag refusals', () => {
  // Only the two early refusals are under test; the runtime argument is built
  // as a minimal object — the early checks must run before any runtime use.
  const rt = {} as Parameters<typeof briefSeatPlan>[1];

  it('throws exact usage error when seatPlanFromInstallation is set to maybe', () => {
    // O(1): two property lookups and strict equality checks before any parse.
    for (const raw of ['maybe', 1, null]) {
      expect(() => briefSeatPlan({ seatPlanFromInstallation: raw }, rt)).toThrow(CliUsageError);
      expect(() => briefSeatPlan({ seatPlanFromInstallation: raw }, rt)).toThrow(
        "'--seatPlanFromInstallation' takes no value, or true or false",
      );
    }
  });

  it('throws not both usage error when seatPlan and seatPlanFromInstallation true are both set', () => {
    for (const raw of [true, 'true']) {
      expect(() => briefSeatPlan({ seatPlan: '{}', seatPlanFromInstallation: raw }, rt)).toThrow(
        CliUsageError,
      );
      expect(() => briefSeatPlan({ seatPlan: '{}', seatPlanFromInstallation: raw }, rt)).toThrow(
        /not both/,
      );
    }
  });
});
