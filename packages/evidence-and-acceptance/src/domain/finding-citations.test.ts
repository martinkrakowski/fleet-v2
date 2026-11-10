import { describe, expect, it } from 'vitest';

import {
  classifyFindingCitation,
  uncitedFindingIds,
  MAX_CITATION_DIFF_FILES,
  MAX_CITATION_DIFF_LINES,
  MAX_CITATION_FINDINGS,
  type DiffCitationFile,
  type DiffCitationIndex,
} from './finding-citations.js';
import type { ReviewFindingRecord } from './evidence-records.js';

function finding(overrides: Partial<ReviewFindingRecord> = {}): ReviewFindingRecord {
  return {
    findingId: 'f-1',
    severity: 'blocker',
    summary: 'a finding',
    filePath: null,
    line: null,
    state: 'unresolved',
    dispositionReason: null,
    dispositionEvidenceRef: null,
    ...overrides,
  };
}

function diffIndex(files: readonly DiffCitationFile[]): DiffCitationIndex {
  return { files };
}

describe('classifyFindingCitation', () => {
  it('classifies a null filePath as no-file whatever the line is', () => {
    expect(classifyFindingCitation(finding({ filePath: null, line: null }), diffIndex([]))).toEqual({
      ok: true,
      value: 'no-file',
    });
    expect(classifyFindingCitation(finding({ filePath: null, line: 7 }), diffIndex([]))).toEqual({
      ok: true,
      value: 'no-file',
    });
  });

  it('classifies an empty or whitespace-only filePath as no-file', () => {
    const diff = diffIndex([{ path: '', lines: [1], lineCount: 20 }]);
    for (const filePath of ['', '   ', '\t', ' \n ']) {
      expect(classifyFindingCitation(finding({ filePath, line: 3 }), diff)).toEqual({
        ok: true,
        value: 'no-file',
      });
    }
  });

  it('classifies a non-blank path absent from the diff as file-not-in-diff', () => {
    const diff = diffIndex([{ path: 'a/b.ts', lines: [1, 2], lineCount: 20 }]);
    expect(classifyFindingCitation(finding({ filePath: 'x/y.ts', line: 1 }), diff)).toEqual({
      ok: true,
      value: 'file-not-in-diff',
    });
  });

  it('classifies a line not among the file’s diff lines as line-not-in-diff', () => {
    const diff = diffIndex([{ path: 'a/b.ts', lines: [1, 2], lineCount: 20 }]);
    expect(classifyFindingCitation(finding({ filePath: 'a/b.ts', line: 9 }), diff)).toEqual({
      ok: true,
      value: 'line-not-in-diff',
    });
  });

  it('classifies a null line as line-not-in-diff even when the file is in the diff', () => {
    const diff = diffIndex([{ path: 'a/b.ts', lines: [1, 2], lineCount: 20 }]);
    expect(classifyFindingCitation(finding({ filePath: 'a/b.ts', line: null }), diff)).toEqual({
      ok: true,
      value: 'line-not-in-diff',
    });
  });

  it('classifies a file and line that are in the diff as cited', () => {
    const diff = diffIndex([{ path: 'a/b.ts', lines: [1, 2], lineCount: 20 }]);
    expect(classifyFindingCitation(finding({ filePath: 'a/b.ts', line: 2 }), diff)).toEqual({
      ok: true,
      value: 'cited',
    });
  });

  it('strips one leading ./ from each side for comparison and nothing else', () => {
    const diff = diffIndex([{ path: './a/b.ts', lines: [1], lineCount: 20 }]);
    expect(classifyFindingCitation(finding({ filePath: 'a/b.ts', line: 1 }), diff)).toEqual({
      ok: true,
      value: 'cited',
    });
    expect(classifyFindingCitation(finding({ filePath: './a/b.ts', line: 1 }), diff)).toEqual({
      ok: true,
      value: 'cited',
    });
    expect(classifyFindingCitation(finding({ filePath: '././a/b.ts', line: 1 }), diff)).toEqual({
      ok: true,
      value: 'file-not-in-diff',
    });
    const diff2 = diffIndex([{ path: '././a/b.ts', lines: [1], lineCount: 20 }]);
    expect(classifyFindingCitation(finding({ filePath: 'a/b.ts', line: 1 }), diff2)).toEqual({
      ok: true,
      value: 'file-not-in-diff',
    });
    const diff3 = diffIndex([{ path: 'a/b.ts', lines: [1], lineCount: 20 }]);
    expect(classifyFindingCitation(finding({ filePath: '../a/b.ts', line: 1 }), diff3)).toEqual({
      ok: true,
      value: 'file-not-in-diff',
    });
    expect(classifyFindingCitation(finding({ filePath: ' ./a/b.ts', line: 1 }), diff3)).toEqual({
      ok: true,
      value: 'file-not-in-diff',
    });
  });

  it('does not treat a leading / as the same path as no leading slash', () => {
    expect(
      classifyFindingCitation(
        finding({ filePath: '/a/b.ts', line: 5 }),
        diffIndex([{ path: 'a/b.ts', lines: [1], lineCount: 20 }]),
      ),
    ).toEqual({ ok: true, value: 'file-not-in-diff' });
    expect(
      classifyFindingCitation(
        finding({ filePath: 'a/b.ts', line: 1 }),
        diffIndex([{ path: '/a/b.ts', lines: [5], lineCount: 20 }]),
      ),
    ).toEqual({ ok: true, value: 'file-not-in-diff' });
    expect(
      classifyFindingCitation(
        finding({ filePath: '/a/b.ts', line: 5 }),
        diffIndex([{ path: '/a/b.ts', lines: [5], lineCount: 20 }]),
      ),
    ).toEqual({ ok: true, value: 'cited' });
  });

  it('does not strip a trailing slash', () => {
    const diff = diffIndex([{ path: 'a/b.ts', lines: [1], lineCount: 20 }]);
    expect(classifyFindingCitation(finding({ filePath: 'a/b.ts/', line: 1 }), diff)).toEqual({
      ok: true,
      value: 'file-not-in-diff',
    });
  });

  it('counts a line as in the diff when either duplicate path entry names it', () => {
    const diff = diffIndex([
      { path: 'a/b.ts', lines: [1], lineCount: 20 },
      { path: './a/b.ts', lines: [9], lineCount: 20 },
    ]);
    expect(classifyFindingCitation(finding({ filePath: 'a/b.ts', line: 9 }), diff)).toEqual({
      ok: true,
      value: 'cited',
    });
    expect(classifyFindingCitation(finding({ filePath: './a/b.ts', line: 1 }), diff)).toEqual({
      ok: true,
      value: 'cited',
    });
    expect(classifyFindingCitation(finding({ filePath: 'a/b.ts', line: 5 }), diff)).toEqual({
      ok: true,
      value: 'line-not-in-diff',
    });
  });

  it('treats a line that is not a positive safe integer as no line without throwing', () => {
    const diff = diffIndex([{ path: 'a/b.ts', lines: [1, 2], lineCount: 20 }]);
    for (const line of [0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '2', { n: 2 }]) {
      expect(() =>
        classifyFindingCitation(finding({ filePath: 'a/b.ts', line: line as unknown as null }), diff),
      ).not.toThrow();
      expect(
        classifyFindingCitation(finding({ filePath: 'a/b.ts', line: line as unknown as null }), diff),
      ).toEqual({ ok: true, value: 'line-not-in-diff' });
    }
  });

  it('returns no-file for a null filePath without reading line', () => {
    let counter = 0;
    const reviewFinding: Record<string, unknown> = {
      findingId: 'f-1',
      severity: 'blocker',
      summary: 'a finding',
      filePath: null,
      state: 'unresolved',
      dispositionReason: null,
      dispositionEvidenceRef: null,
    };
    Object.defineProperty(reviewFinding, 'line', {
      get() {
        counter += 1;
        throw new Error('line getter ran');
      },
      enumerable: true,
    });
    expect(classifyFindingCitation(reviewFinding, null)).toEqual({ ok: true, value: 'no-file' });
    expect(counter).toBe(0);
  });

  it('refuses an accessor filePath without calling it', () => {
    let counter = 0;
    const reviewFinding: Record<string, unknown> = {
      findingId: 'f-1',
      severity: 'blocker',
      summary: 'a finding',
      line: null,
      state: 'unresolved',
      dispositionReason: null,
      dispositionEvidenceRef: null,
    };
    Object.defineProperty(reviewFinding, 'filePath', {
      get() {
        counter += 1;
        return null;
      },
      enumerable: true,
    });
    expect(classifyFindingCitation(reviewFinding, diffIndex([]))).toEqual({
      ok: false,
      reason: 'malformed-finding',
    });
    expect(counter).toBe(0);
  });

  it('refuses a non-string filePath instead of throwing', () => {
    const diff = diffIndex([{ path: 'a/b.ts', lines: [1], lineCount: 20 }]);
    for (const filePath of [12, { n: 1 }, {}]) {
      expect(classifyFindingCitation(filePath as unknown as ReviewFindingRecord, diff)).toEqual({
        ok: false,
        reason: 'malformed-finding',
      });
    }
    expect(classifyFindingCitation(finding({ filePath: 'a'.repeat(501) }), diff)).toEqual({
      ok: false,
      reason: 'malformed-finding',
    });
  });

  it('returns file-not-in-diff without reading line when the path is absent', () => {
    let counter = 0;
    const reviewFinding: Record<string, unknown> = {
      findingId: 'f-1',
      severity: 'blocker',
      summary: 'a finding',
      filePath: 'missing.ts',
      state: 'unresolved',
      dispositionReason: null,
      dispositionEvidenceRef: null,
    };
    Object.defineProperty(reviewFinding, 'line', {
      get() {
        counter += 1;
        throw new Error('line getter ran');
      },
      enumerable: true,
    });
    const diff = diffIndex([{ path: 'a/b.ts', lines: [1], lineCount: 20 }]);
    expect(classifyFindingCitation(reviewFinding, diff)).toEqual({
      ok: true,
      value: 'file-not-in-diff',
    });
    expect(counter).toBe(0);
  });

  it('refuses an unreadable line when the file is in the diff', () => {
    let counter = 0;
    const reviewFinding: Record<string, unknown> = {
      findingId: 'f-1',
      severity: 'blocker',
      summary: 'a finding',
      filePath: 'a/b.ts',
      state: 'unresolved',
      dispositionReason: null,
      dispositionEvidenceRef: null,
    };
    Object.defineProperty(reviewFinding, 'line', {
      get() {
        counter += 1;
        return 1;
      },
      enumerable: true,
    });
    const diff = diffIndex([{ path: 'a/b.ts', lines: [1], lineCount: 20 }]);
    expect(classifyFindingCitation(reviewFinding, diff)).toEqual({
      ok: false,
      reason: 'malformed-finding',
    });
    expect(counter).toBe(0);
  });

  it('classifies a line past lineCount as line-past-end even when the diff lists it', () => {
    const diff = diffIndex([{ path: 'a/b.ts', lines: [569, 10], lineCount: 390 }]);
    expect(classifyFindingCitation(finding({ filePath: 'a/b.ts', line: 569 }), diff)).toEqual({
      ok: true,
      value: 'line-past-end',
    });
    expect(classifyFindingCitation(finding({ filePath: 'a/b.ts', line: 10 }), diff)).toEqual({
      ok: true,
      value: 'cited',
    });
    expect(classifyFindingCitation(finding({ filePath: 'a/b.ts', line: 400 }), diff)).toEqual({
      ok: true,
      value: 'line-past-end',
    });
    expect(classifyFindingCitation(finding({ filePath: 'a/b.ts', line: 11 }), diff)).toEqual({
      ok: true,
      value: 'line-not-in-diff',
    });
  });

  it('refuses a diff file whose lineCount is missing or not a positive safe integer', () => {
    const files: Array<Partial<DiffCitationFile>> = [
      { path: 'a/b.ts', lines: [1] },
      { path: 'a/b.ts', lines: [1], lineCount: 0 },
      { path: 'a/b.ts', lines: [1], lineCount: 390.5 },
      { path: 'a/b.ts', lines: [1], lineCount: Number.NaN },
    ];
    for (const file of files) {
      expect(
        classifyFindingCitation(
          finding({ filePath: 'a/b.ts', line: 1 }),
          diffIndex([file as DiffCitationFile]),
        ),
      ).toEqual({ ok: false, reason: 'malformed-diff' });
    }
  });

  it('refuses two entries for one path when lineCount differs', () => {
    const diff = diffIndex([
      { path: 'a/b.ts', lines: [1], lineCount: 390 },
      { path: './a/b.ts', lines: [9], lineCount: 400 },
    ]);
    expect(classifyFindingCitation(finding({ filePath: 'a/b.ts', line: 1 }), diff)).toEqual({
      ok: false,
      reason: 'malformed-diff',
    });
  });

  it('refuses a diff that is not a dense file list', () => {
    const file = { path: 'a/b.ts', lines: [1], lineCount: 20 };
    const filesHole: Array<unknown> = [file];
    delete filesHole[0];
    const linesHole: number[] = [];
    linesHole.length = 1;
    const diffs: unknown[] = [
      { files: null },
      { files: { 0: file, length: 1 } },
      { files: filesHole },
      { files: [{ path: 1, lines: [1], lineCount: 20 }] },
      { files: [{ path: 'a/b.ts', lines: linesHole, lineCount: 20 }] },
    ];
    for (const diff of diffs) {
      expect(() =>
        classifyFindingCitation(finding({ filePath: 'a/b.ts', line: 1 }), diff as DiffCitationIndex),
      ).not.toThrow();
      expect(
        classifyFindingCitation(finding({ filePath: 'a/b.ts', line: 1 }), diff as DiffCitationIndex),
      ).toEqual({ ok: false, reason: 'malformed-diff' });
    }
  });

  it('traverses diff files and lines via indexed access, not filter/includes/iterator', () => {
    const fileA: DiffCitationFile = { path: 'a/b.ts', lines: [1], lineCount: 20 };
    const fileB: DiffCitationFile = { path: 'x/y.ts', lines: [5], lineCount: 20 };
    const files = [fileA, fileB];
    let filterCalls = 0;
    let includesCalls = 0;
    Object.defineProperty(files, 'filter', {
      value(this: unknown[], cb: (value: unknown) => boolean) {
        filterCalls += 1;
        return Array.prototype.filter.call(this, cb);
      },
    });
    Object.defineProperty(fileA.lines, 'includes', {
      value(this: number[], value: number) {
        includesCalls += 1;
        return Array.prototype.includes.call(this, value);
      },
    });
    Object.defineProperty(fileB.lines, 'includes', {
      value(this: number[], value: number) {
        includesCalls += 1;
        return Array.prototype.includes.call(this, value);
      },
    });
    Object.defineProperty(files, Symbol.iterator, {
      value() {
        throw new Error('symbol iterator called');
      },
    });
    const diff = diffIndex(files);
    expect(classifyFindingCitation(finding({ filePath: 'a/b.ts', line: 1 }), diff)).toEqual({
      ok: true,
      value: 'cited',
    });
    expect(classifyFindingCitation(finding({ filePath: 'a/b.ts', line: 5 }), diff)).toEqual({
      ok: true,
      value: 'line-not-in-diff',
    });
    expect(classifyFindingCitation(finding({ filePath: null, line: null }), diff)).toEqual({
      ok: true,
      value: 'no-file',
    });
    expect(filterCalls).toBeLessThanOrEqual(1);
    expect(includesCalls).toBeLessThanOrEqual(2);
  });
});

describe('uncitedFindingIds', () => {
  it('returns uncited ids in input order, each at most once', () => {
    const diff = diffIndex([{ path: 'a/b.ts', lines: [1], lineCount: 20 }]);
    const findings = [
      finding({ findingId: 'a', filePath: 'a/b.ts', line: 1 }),
      finding({ findingId: 'b', filePath: null, line: null }),
      finding({ findingId: 'c', filePath: 'a/b.ts', line: 99 }),
      finding({ findingId: 'd', filePath: 'x/y.ts', line: 1 }),
      finding({ findingId: 'd', filePath: 'x/y.ts', line: 2 }),
      finding({ findingId: 'e', filePath: 'a/b.ts', line: 1 }),
    ];
    expect(uncitedFindingIds(findings, diff)).toEqual({ ok: true, value: ['b', 'c', 'd'] });
  });

  it('returns empty for empty input', () => {
    expect(uncitedFindingIds([], diffIndex([]))).toEqual({ ok: true, value: [] });
    expect(uncitedFindingIds([], null)).toEqual({ ok: false, reason: 'malformed-diff' });
    expect(
      uncitedFindingIds(
        [finding({ findingId: 'b', filePath: null, line: null })],
        diffIndex([{ path: 'a/b.ts', lines: [1], lineCount: 20 }]),
      ),
    ).toEqual({ ok: true, value: ['b'] });
  });

  it('refuses a findings value that is not a dense array', () => {
    const f = finding({ filePath: null, line: null });
    const sparse: Array<unknown> = [f];
    delete sparse[0];
    const diff = diffIndex([{ path: 'a/b.ts', lines: [1], lineCount: 20 }]);
    for (const findings of [{ 0: f, length: 1 }, sparse]) {
      expect(() =>
        uncitedFindingIds(findings as unknown as readonly ReviewFindingRecord[], diff),
      ).not.toThrow();
      expect(uncitedFindingIds(findings as unknown as readonly ReviewFindingRecord[], diff)).toEqual({
        ok: false,
        reason: 'malformed-finding',
      });
    }
  });

  it('refuses a non-string findingId and does not return it', () => {
    const diff = diffIndex([{ path: 'a/b.ts', lines: [1], lineCount: 20 }]);
    const findings = [
      finding({ findingId: { a: 1 } as unknown as string, filePath: 'a/b.ts', line: 1 }),
      finding({ findingId: 'b', filePath: null, line: null }),
    ];
    const result = uncitedFindingIds(findings, diff);
    expect(result).toEqual({ ok: false, reason: 'malformed-finding' });
    expect('value' in result).toBe(false);
    for (const id of [1, undefined, '']) {
      const res = uncitedFindingIds(
        [finding({ findingId: id as unknown as string, filePath: 'a/b.ts', line: 1 })],
        diff,
      );
      expect(res).toEqual({ ok: false, reason: 'malformed-finding' });
      expect('value' in res).toBe(false);
    }
  });

  it('refuses when the finding list or the diff exceeds the cap before walking the excess', () => {
    const diff = diffIndex([{ path: 'a/b.ts', lines: [1], lineCount: 20 }]);

    const bigFindings = [finding({ findingId: 'b', filePath: null, line: null })];
    Object.defineProperty(bigFindings, 'length', { value: MAX_CITATION_FINDINGS + 1 });
    expect(uncitedFindingIds(bigFindings, diff)).toEqual({
      ok: false,
      reason: 'budget-exhausted',
    });

    const bigFiles: DiffCitationFile[] = [{ path: 'a/b.ts', lines: [1], lineCount: 20 }];
    Object.defineProperty(bigFiles, 'length', { value: MAX_CITATION_DIFF_FILES + 1 });
    expect(
      classifyFindingCitation(finding({ filePath: 'a/b.ts', line: 1 }), diffIndex(bigFiles)),
    ).toEqual({ ok: false, reason: 'budget-exhausted' });

    const bigLines: number[] = [1];
    Object.defineProperty(bigLines, 'length', { value: MAX_CITATION_DIFF_LINES + 1 });
    expect(
      classifyFindingCitation(
        finding({ filePath: 'a/b.ts', line: 1 }),
        diffIndex([{ path: 'a/b.ts', lines: bigLines, lineCount: 390 }]),
      ),
    ).toEqual({ ok: false, reason: 'budget-exhausted' });
  });
});

describe('purity', () => {
  it('never throws for input of the declared types and never mutates its arguments', () => {
    const diff = diffIndex([{ path: 'a/b.ts', lines: [1, 2], lineCount: 20 }]);
    const findings = [
      finding({ findingId: 'a', filePath: null, line: null }),
      finding({ findingId: 'b', filePath: 'a/b.ts', line: 1 }),
      finding({ findingId: 'c', filePath: 'a/b.ts', line: 5 }),
      finding({ findingId: 'd', filePath: 'a/b.ts', line: Number.NaN }),
    ];
    Object.freeze(findings);
    for (const f of findings) {
      Object.freeze(f);
    }
    Object.freeze(diff);
    Object.freeze(diff.files);
    for (const file of diff.files) {
      Object.freeze(file);
      Object.freeze(file.lines);
    }
    const diffBefore = JSON.stringify(diff);
    const findingsBefore = JSON.stringify(findings);

    expect(classifyFindingCitation(findings[0], diff)).toEqual({ ok: true, value: 'no-file' });
    expect(classifyFindingCitation(findings[1], diff)).toEqual({ ok: true, value: 'cited' });
    expect(classifyFindingCitation(findings[2], diff)).toEqual({
      ok: true,
      value: 'line-not-in-diff',
    });
    expect(classifyFindingCitation(findings[3], diff)).toEqual({
      ok: true,
      value: 'line-not-in-diff',
    });
    expect(uncitedFindingIds(findings, diff)).toEqual({ ok: true, value: ['a', 'c', 'd'] });

    expect(Object.is(findings[3].line, Number.NaN)).toBe(true);
    expect(JSON.stringify(diff)).toBe(diffBefore);
    expect(JSON.stringify(findings)).toBe(findingsBefore);
  });
});
